package urltitle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const (
	fetchTimeout = 8 * time.Second
	maxHTMLBytes = 512 * 1024
	maxRedirects = 3
)

var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("100::/64"),
}

func IsPublicAddress(raw string) bool {
	addr, err := netip.ParseAddr(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	if !addr.IsValid() || !addr.IsGlobalUnicast() || addr.IsPrivate() ||
		addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() ||
		addr.IsMulticast() || addr.IsUnspecified() {
		return false
	}
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func isBenchmarkAddr(addr netip.Addr) bool {
	addr = addr.Unmap()
	return netip.MustParsePrefix("198.18.0.0/15").Contains(addr)
}

func resolvePublicAddresses(ctx context.Context, hostname string) ([]netip.Addr, error) {
	if addr, err := netip.ParseAddr(hostname); err == nil {
		if !IsPublicAddress(addr.String()) {
			return nil, nil
		}
		return []netip.Addr{addr.Unmap()}, nil
	}

	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", hostname)
	if err != nil {
		return nil, err
	}
	if len(ips) > 0 {
		allBenchmark := true
		for _, ip := range ips {
			if !isBenchmarkAddr(ip) {
				allBenchmark = false
				break
			}
		}
		if allBenchmark {
			dohIPs, err := lookupCloudflareDoH(ctx, hostname)
			if err != nil {
				return nil, err
			}
			ips = dohIPs
		}
	}

	var out []netip.Addr
	for _, ip := range ips {
		if !IsPublicAddress(ip.String()) {
			return nil, nil
		}
		out = append(out, ip.Unmap())
	}
	return out, nil
}

func lookupCloudflareDoH(ctx context.Context, hostname string) ([]netip.Addr, error) {
	endpoint, _ := url.Parse("https://cloudflare-dns.com/dns-query")
	q := endpoint.Query()
	q.Set("name", hostname)
	q.Set("type", "A")
	endpoint.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/dns-json")
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("doh non-200")
	}
	var payload struct {
		Status int `json:"Status"`
		Answer []struct {
			Type int    `json:"type"`
			Data string `json:"data"`
		} `json:"Answer"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&payload); err != nil {
		return nil, err
	}
	if payload.Status != 0 {
		return nil, nil
	}
	var addrs []netip.Addr
	for _, ans := range payload.Answer {
		if ans.Type == 1 {
			if addr, err := netip.ParseAddr(ans.Data); err == nil {
				addrs = append(addrs, addr)
			}
		}
	}
	return addrs, nil
}

func ParseURLTitle(rawHTML string) string {
	doc, err := html.Parse(strings.NewReader(rawHTML))
	if err != nil {
		return ""
	}
	var titleText string
	var ogTitle string

	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch strings.ToLower(n.Data) {
			case "title":
				if titleText == "" {
					titleText = collectText(n)
				}
			case "meta":
				if ogTitle == "" {
					var prop, content string
					for _, a := range n.Attr {
						switch strings.ToLower(a.Key) {
						case "property":
							prop = strings.ToLower(strings.TrimSpace(a.Val))
						case "content":
							content = a.Val
						}
					}
					if prop == "og:title" {
						ogTitle = content
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)

	chosen := normalizeSpace(titleText)
	if chosen == "" {
		chosen = normalizeSpace(ogTitle)
	}
	runes := []rune(chosen)
	if len(runes) > 240 {
		chosen = string(runes[:240])
	}
	return chosen
}

func collectText(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(cur *html.Node) {
		if cur.Type == html.TextNode {
			b.WriteString(cur.Data)
		}
		for c := cur.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

func normalizeSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func FetchURLTitle(ctx context.Context, rawURL string) string {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	cur, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}

	for redirects := 0; redirects <= maxRedirects; redirects++ {
		scheme := strings.ToLower(cur.Scheme)
		if (scheme != "http" && scheme != "https") || cur.User != nil {
			return ""
		}
		port := cur.Port()
		if port != "" && port != "80" && port != "443" {
			return ""
		}
		hostname := strings.Trim(cur.Hostname(), "[]")
		if hostname == "" {
			return ""
		}

		addrs, err := resolvePublicAddresses(ctx, hostname)
		if err != nil || len(addrs) == 0 || ctx.Err() != nil {
			return ""
		}
		pinnedAddr := addrs[0]
		targetPort := port
		if targetPort == "" {
			if scheme == "https" {
				targetPort = "443"
			} else {
				targetPort = "80"
			}
		}

		transport := &http.Transport{
			DialContext: func(dctx context.Context, network, _ string) (net.Conn, error) {
				dialer := &net.Dialer{}
				return dialer.DialContext(dctx, network, net.JoinHostPort(pinnedAddr.String(), targetPort))
			},
			DisableCompression: false,
		}
		client := &http.Client{
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, cur.String(), nil)
		if err != nil {
			transport.CloseIdleConnections()
			return ""
		}
		req.Header.Set("User-Agent", "Spark/0.2 (personal desktop bookmark title fetcher)")
		req.Header.Set("Accept", "text/html")

		resp, err := client.Do(req)
		if err != nil {
			transport.CloseIdleConnections()
			return ""
		}

		if resp.StatusCode == http.StatusMovedPermanently ||
			resp.StatusCode == http.StatusFound ||
			resp.StatusCode == http.StatusSeeOther ||
			resp.StatusCode == http.StatusTemporaryRedirect ||
			resp.StatusCode == http.StatusPermanentRedirect {
			loc := resp.Header.Get("Location")
			_ = resp.Body.Close()
			transport.CloseIdleConnections()
			if loc == "" {
				return ""
			}
			nextURL, err := cur.Parse(loc)
			if err != nil {
				return ""
			}
			cur = nextURL
			continue
		}

		ct := strings.ToLower(resp.Header.Get("Content-Type"))
		if resp.StatusCode != http.StatusOK || !strings.Contains(ct, "text/html") {
			_ = resp.Body.Close()
			transport.CloseIdleConnections()
			return ""
		}

		body, err := io.ReadAll(io.LimitReader(resp.Body, maxHTMLBytes+1))
		_ = resp.Body.Close()
		transport.CloseIdleConnections()
		if err != nil || len(body) > maxHTMLBytes {
			return ""
		}
		return ParseURLTitle(string(body))
	}
	return ""
}
