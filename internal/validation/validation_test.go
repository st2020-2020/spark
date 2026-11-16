package validation

import (
	"strings"
	"testing"
)

func TestValidateContentAndURL(t *testing.T) {
	if _, err := ValidateContent("   ", false); err == nil || !strings.Contains(err.Error(), "写点什么") {
		t.Fatalf("expected empty content error, got %v", err)
	}
	got, err := ValidateContent("   ", true)
	if err != nil || got != "" {
		t.Fatalf("expected empty content allowed with image, got %q, %v", got, err)
	}
	if _, err := ValidateContent(strings.Repeat("a", 50001), false); err == nil || !strings.Contains(err.Error(), "50,000") {
		t.Fatalf("expected max length error, got %v", err)
	}

	if u := ExtractURL("稍后阅读 https://example.com/article?x=1。"); u != "https://example.com/article?x=1" {
		t.Fatalf("unexpected extracted URL: %q", u)
	}
	if u := ExtractURL("javascript:alert(1)"); u != "" {
		t.Fatalf("expected empty URL for javascript scheme, got %q", u)
	}
}

func TestValidateImage(t *testing.T) {
	if _, _, err := ValidateImage([]byte("<svg></svg>"), "icon.svg"); err == nil || !strings.Contains(err.Error(), "JPG、PNG") {
		t.Fatalf("expected SVG rejection, got %v", err)
	}
	if _, _, err := ValidateImage(make([]byte, MaxImage+1), "big.png"); err == nil || !strings.Contains(err.Error(), "5 MB") {
		t.Fatalf("expected size limit error, got %v", err)
	}
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0}
	mimeType, name, err := ValidateImage(png, "/tmp/demo.png")
	if err != nil || mimeType != "image/png" || name != "demo.png" {
		t.Fatalf("expected valid png, got %q %q %v", mimeType, name, err)
	}
}
