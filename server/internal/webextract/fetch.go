package webextract

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
	"unicode"

	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
	"golang.org/x/net/idna"
)

const (
	timeout       = 8 * time.Second
	maxPageBytes  = 2 << 20
	maxRedirects  = 3
	maxHTMLTokens = 16384
)

type Page struct {
	Title    string
	SiteName string
	Summary  string
	Text     string
}

type Failure struct {
	Code      string
	Blocked   bool
	Retryable bool
}

func (e *Failure) Error() string { return e.Code }

// A zero Client uses the system resolver and a direct, bounded TCP dialer.
type Client struct {
	LookupIP    func(context.Context, string, string) ([]netip.Addr, error)
	DialContext func(context.Context, string, string) (net.Conn, error)
}

var (
	publicIPv6 = netip.MustParsePrefix("2000::/3")
	special    = []netip.Prefix{
		netip.MustParsePrefix("0.0.0.0/8"),
		netip.MustParsePrefix("100.64.0.0/10"),
		netip.MustParsePrefix("192.0.0.0/24"),
		netip.MustParsePrefix("192.0.2.0/24"),
		netip.MustParsePrefix("192.31.196.0/24"),
		netip.MustParsePrefix("192.52.193.0/24"),
		netip.MustParsePrefix("192.88.99.0/24"),
		netip.MustParsePrefix("192.175.48.0/24"),
		netip.MustParsePrefix("198.18.0.0/15"),
		netip.MustParsePrefix("198.51.100.0/24"),
		netip.MustParsePrefix("203.0.113.0/24"),
		netip.MustParsePrefix("240.0.0.0/4"),
		netip.MustParsePrefix("2001::/23"),
		netip.MustParsePrefix("2001:db8::/32"),
		netip.MustParsePrefix("2002::/16"),
		netip.MustParsePrefix("2620:4f:8000::/48"),
		netip.MustParsePrefix("3fff::/20"),
	}
)

func publicIP(addr netip.Addr) bool {
	addr = addr.Unmap()
	if addr.Zone() != "" || !addr.IsGlobalUnicast() || addr.IsPrivate() ||
		(addr.Is6() && !publicIPv6.Contains(addr)) {
		return false
	}
	for _, prefix := range special {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func target(u *url.URL) (string, string, error) {
	host, port := u.Hostname(), u.Port()
	if len(u.String()) > 16384 || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Opaque != "" || host == "" ||
		(port != "" && port != "80" && port != "443") {
		return "", "", &Failure{Code: "unsafe_url", Blocked: true}
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		if !publicIP(addr) {
			return "", "", &Failure{Code: "unsafe_url", Blocked: true}
		}
		host = addr.Unmap().String()
	} else {
		ascii, err := idna.Lookup.ToASCII(strings.TrimSuffix(host, "."))
		host = strings.ToLower(ascii)
		if err != nil || len(host) > 253 || !strings.Contains(host, ".") ||
			strings.ContainsAny(host, "%/\\") || strings.Contains(host, "..") {
			return "", "", &Failure{Code: "unsafe_url", Blocked: true}
		}
		for _, suffix := range []string{".localhost", ".local", ".internal", ".home.arpa", ".onion"} {
			if strings.HasSuffix(host, suffix) {
				return "", "", &Failure{Code: "unsafe_url", Blocked: true}
			}
		}
	}
	u.Host = host
	if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	}
	if port != "" {
		u.Host = net.JoinHostPort(host, port)
	} else if u.Scheme == "https" {
		port = "443"
	} else {
		port = "80"
	}
	u.Fragment, u.RawFragment = "", ""
	return host, port, nil
}

func (c Client) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if addr, err := netip.ParseAddr(host); err == nil {
		return []netip.Addr{addr}, nil // target already validated the literal.
	}
	lookup := c.LookupIP
	if lookup == nil {
		lookup = net.DefaultResolver.LookupNetIP
	}
	// An absolute DNS name bypasses the deployment's local search suffixes.
	addrs, err := lookup(ctx, "ip", host+".")
	if err != nil {
		var dns *net.DNSError
		if errors.As(err, &dns) && dns.IsNotFound {
			return nil, &Failure{Code: "dns_not_found"}
		}
		return nil, networkFailure(ctx, "dns_failed", err)
	}
	if len(addrs) == 0 {
		return nil, &Failure{Code: "dns_not_found"}
	}
	// Reject mixed answers before opening any connection.
	for _, addr := range addrs {
		if !publicIP(addr) {
			return nil, &Failure{Code: "unsafe_url", Blocked: true}
		}
	}
	return addrs, nil
}

func networkFailure(ctx context.Context, code string, err error) error {
	var networkErr net.Error
	if ctx.Err() == context.DeadlineExceeded || errors.As(err, &networkErr) && networkErr.Timeout() {
		code = "fetch_timeout"
	}
	return &Failure{Code: code, Retryable: true}
}

// Fetch makes an unauthenticated GET per hop. Host and TLS identity stay
// associated with the URL while the socket uses only the screened DNS answers.
func (c Client) Fetch(ctx context.Context, rawURL string) (Page, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if len(rawURL) > 16384 || strings.ContainsFunc(rawURL, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r) || r == '\\'
	}) {
		return Page{}, &Failure{Code: "unsafe_url", Blocked: true}
	}
	current, err := url.Parse(rawURL)
	if err != nil {
		return Page{}, &Failure{Code: "invalid_url"}
	}
	for hop := 0; ; hop++ {
		host, port, err := target(current)
		if err != nil {
			return Page{}, err
		}
		addrs, err := c.resolve(ctx, host)
		if err != nil {
			return Page{}, err
		}
		htmlBody, redirect, err := c.get(ctx, current, host, port, addrs)
		if err != nil {
			return Page{}, err
		}
		if redirect == nil {
			return parsePage(ctx, htmlBody, host)
		}
		if hop == maxRedirects {
			return Page{}, &Failure{Code: "too_many_redirects"}
		}
		current = redirect
	}
}

func (c Client) get(ctx context.Context, u *url.URL, host, port string, addrs []netip.Addr) ([]byte, *url.URL, error) {
	dial := c.DialContext
	if dial == nil {
		dial = (&net.Dialer{Timeout: 2 * time.Second}).DialContext
	}
	transport := &http.Transport{
		DisableKeepAlives:      true,
		TLSHandshakeTimeout:    3 * time.Second,
		MaxResponseHeaderBytes: 64 << 10,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if address != net.JoinHostPort(host, port) {
				return nil, errors.New("unexpected web fetch destination")
			}
			var err error
			for _, addr := range addrs[:min(4, len(addrs))] {
				var conn net.Conn
				conn, err = dial(ctx, network, net.JoinHostPort(addr.Unmap().String(), port))
				if err == nil {
					return conn, nil
				}
				if ctx.Err() != nil {
					break
				}
			}
			return nil, err
		},
	}
	defer transport.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, nil, &Failure{Code: "invalid_url"}
	}
	req.Header.Set("Accept", "text/html, application/xhtml+xml")
	req.Header.Set("User-Agent", "Spark/0.3 (personal link preview)")
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return nil, nil, networkFailure(ctx, "fetch_unavailable", err)
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case 301, 302, 303, 307, 308:
		next, err := res.Location()
		if err != nil {
			return nil, nil, &Failure{Code: "invalid_redirect"}
		}
		return nil, next, nil
	case 200:
	case 401, 403:
		return nil, nil, &Failure{Code: "fetch_restricted"}
	default:
		return nil, nil, &Failure{Code: "fetch_http_error", Retryable: res.StatusCode == 429 || res.StatusCode >= 500}
	}
	contentType := res.Header.Get("Content-Type")
	media, _, err := mime.ParseMediaType(contentType)
	if err != nil || (media != "text/html" && media != "application/xhtml+xml") ||
		(res.Header.Get("Content-Encoding") != "" && !strings.EqualFold(res.Header.Get("Content-Encoding"), "identity")) {
		return nil, nil, &Failure{Code: "unsupported_page"}
	}
	body, err := readPage(ctx, res.Body)
	if err != nil {
		return nil, nil, err
	}
	decoded, err := charset.NewReader(bytes.NewReader(body), contentType)
	if err != nil {
		return nil, nil, &Failure{Code: "invalid_page"}
	}
	body, err = readPage(ctx, decoded)
	return body, nil, err
}

func readPage(ctx context.Context, r io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxPageBytes+1))
	if len(data) > maxPageBytes {
		return nil, &Failure{Code: "page_too_large"}
	}
	if err != nil {
		return nil, networkFailure(ctx, "fetch_unavailable", err)
	}
	return data, nil
}

func parsePage(ctx context.Context, body []byte, host string) (Page, error) {
	// Bound DOM parser work as well as the byte size. Dense markup can
	// allocate many nodes or make the HTML tree construction expensive.
	tokens := html.NewTokenizer(bytes.NewReader(body))
	for count := 0; ; count++ {
		if ctx.Err() != nil {
			return Page{}, networkFailure(ctx, "fetch_unavailable", ctx.Err())
		}
		if count > maxHTMLTokens {
			return Page{}, &Failure{Code: "page_too_complex"}
		}
		if tokens.Next() == html.ErrorToken {
			if tokens.Err() != io.EOF {
				return Page{}, &Failure{Code: "invalid_page"}
			}
			break
		}
	}
	doc, err := html.Parse(bytes.NewReader(body))
	if err != nil {
		return Page{}, &Failure{Code: "invalid_page"}
	}
	if ctx.Err() != nil {
		return Page{}, networkFailure(ctx, "fetch_unavailable", ctx.Err())
	}
	return extractPage(doc, host)
}
