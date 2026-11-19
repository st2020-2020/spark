package webextract

import (
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func fixtureClient(t *testing.T, handler http.HandlerFunc) Client {
	t.Helper()
	fixture := httptest.NewServer(handler)
	t.Cleanup(fixture.Close)
	local := fixture.Listener.Addr().String()
	return Client{
		LookupIP: func(_ context.Context, network, host string) ([]netip.Addr, error) {
			if network != "ip" || host != "preview.example.test." {
				t.Errorf("unexpected DNS lookup %s %s", network, host)
			}
			return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
		},
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != "93.184.216.34:80" {
				t.Errorf("unexpected socket address %s %s", network, address)
				return nil, errors.New("fixture rejected unexpected address")
			}
			return (&net.Dialer{}).DialContext(ctx, network, local)
		},
	}
}

func requireFailure(t *testing.T, err error, code string) {
	t.Helper()
	var failure *Failure
	if !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("fetch failure %v, want %s", err, code)
	}
}

func TestFetchHTMLAndCharset(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	client := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "preview.example.test" || r.Header.Get("Cookie") != "" ||
			r.Header.Get("Authorization") != "" || r.Header.Get("Referer") != "" {
			t.Errorf("unexpected request host or headers")
		}
		if r.URL.Path == "/start" {
			w.Header().Set("Set-Cookie", "fixture=discarded")
			http.Redirect(w, r, "/article", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=gb18030")
		body := `<head><title>后备标题</title><meta property="og:title" content=" 合成标题 ">
		<meta property="og:site_name" content="测试站点"></head><body><nav><p>导航信息</p></nav>
		<main><p>有用的中文内容 &amp; 引文</p><p hidden>隐藏内容</p></main><script>不要索引脚本</script></body>`
		encoded, err := simplifiedchinese.GB18030.NewEncoder().String(body)
		if err != nil {
			t.Errorf("encode fixture: %v", err)
			return
		}
		_, _ = io.WriteString(w, encoded)
	})
	page, err := client.Fetch(t.Context(), "http://preview.example.test/start#fragment")
	if err != nil {
		t.Fatal(err)
	}
	if page.Title != "合成标题" || page.SiteName != "测试站点" ||
		page.Text != "有用的中文内容 & 引文" || page.Summary != page.Text {
		t.Fatalf("unexpected extracted page %+v", page)
	}
}

func TestFetchScreensEveryHopAndMixedDNS(t *testing.T) {
	var requests atomic.Int32
	client := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Redirect(w, r, "/next", http.StatusTemporaryRedirect)
	})
	var resolutions atomic.Int32
	client.LookupIP = func(context.Context, string, string) ([]netip.Addr, error) {
		public := netip.MustParseAddr("93.184.216.34")
		if resolutions.Add(1) == 1 {
			return []netip.Addr{public}, nil
		}
		return []netip.Addr{public, netip.MustParseAddr("fd00::1")}, nil
	}
	_, err := client.Fetch(t.Context(), "http://preview.example.test/start")
	requireFailure(t, err, "unsafe_url")
	if requests.Load() != 1 || resolutions.Load() != 2 {
		t.Fatal("redirect was not screened before the second connection")
	}

	for _, address := range []string{"127.0.0.1", "169.254.1.1", "100.64.1.1", "192.0.2.1", "198.18.0.1", "::1", "fe80::1", "::ffff:192.168.1.1", "2001:db8::1", "3fff::1"} {
		if publicIP(netip.MustParseAddr(address)) {
			t.Errorf("special-purpose address accepted: %s", address)
		}
	}
	if !publicIP(netip.MustParseAddr("2606:4700::1")) {
		t.Error("global IPv6 unexpectedly blocked")
	}
}

func TestFetchRejectsOversizeAndUnsupportedResponses(t *testing.T) {
	client := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/compressed":
			if r.Header.Get("Accept-Encoding") != "gzip" {
				t.Error("fixture expected gzip negotiation")
			}
			w.Header().Set("Content-Type", "text/html")
			w.Header().Set("Content-Encoding", "gzip")
			gz := gzip.NewWriter(w)
			_, _ = io.WriteString(gz, strings.Repeat("a", maxPageBytes+1))
			_ = gz.Close()
		case "/redirect":
			http.Redirect(w, r, "/redirect", http.StatusFound)
		case "/login":
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, `<title>登录</title><form><input type="password"></form>`)
		default:
			w.Header().Set("Content-Type", "image/png")
		}
	})
	for path, code := range map[string]string{
		"/compressed": "page_too_large", "/redirect": "too_many_redirects",
		"/image": "unsupported_page", "/login": "fetch_restricted",
	} {
		t.Run(path, func(t *testing.T) {
			_, err := client.Fetch(t.Context(), "http://preview.example.test"+path)
			requireFailure(t, err, code)
		})
	}
}

func TestFetchTimeoutCoversDNS(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	client := Client{LookupIP: func(ctx context.Context, _, _ string) ([]netip.Addr, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	_, err := client.Fetch(ctx, "http://preview.example.test/")
	requireFailure(t, err, "fetch_timeout")
}
