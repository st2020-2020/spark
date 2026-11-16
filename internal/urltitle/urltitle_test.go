package urltitle

import (
	"context"
	"testing"
)

func TestParseAndPublicAddressGuard(t *testing.T) {
	if got := ParseURLTitle("<title> Hello &amp;\n Spark </title>"); got != "Hello & Spark" {
		t.Fatalf("unexpected parsed title: %q", got)
	}
	if got := ParseURLTitle(`<meta property="og:title" content="阅读笔记">`); got != "阅读笔记" {
		t.Fatalf("unexpected parsed og:title: %q", got)
	}

	privateIPs := []string{
		"127.0.0.1",
		"10.0.0.1",
		"169.254.169.254",
		"::1",
		"::ffff:192.168.1.1",
		"0.0.0.0",
		"fc00::1",
		"198.18.3.82",
	}
	for _, ip := range privateIPs {
		if IsPublicAddress(ip) {
			t.Fatalf("expected non-public address %q to be rejected", ip)
		}
	}
	if !IsPublicAddress("93.184.216.34") {
		t.Fatalf("expected 93.184.216.34 to be public")
	}

	ctx := context.Background()
	for _, badURL := range []string{
		"http://127.0.0.1/secret",
		"file:///etc/passwd",
		"http://198.18.3.82/secret",
	} {
		if got := FetchURLTitle(ctx, badURL); got != "" {
			t.Fatalf("expected empty title for %q, got %q", badURL, got)
		}
	}
}
