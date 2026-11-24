package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"spark/apps/desktop/internal/auth"
	"sync/atomic"
	"testing"
	"time"
)

func TestClientNoRedirectAndOSSStrictPut(t *testing.T) {
	var apiRedirectHit bool
	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/desktop/session":
			if r.Header.Get("Cookie") != "" {
				t.Errorf("desktop client must never send cookies")
			}
			if r.Header.Get("Authorization") != "Bearer test-secret-token" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Location", "https://evil.example/steal")
			w.WriteHeader(http.StatusFound)
			apiRedirectHit = true
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer apiSrv.Close()

	var ossGotContentLength int64
	var ossGotTransferEncoding []string
	var ossGotMIME string
	var ossGotCookie, ossGotAuth, ossGotOrigin string
	ossSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			w.Header().Set("Location", "/other")
			w.WriteHeader(http.StatusTemporaryRedirect)
			return
		}
		ossGotContentLength = r.ContentLength
		ossGotTransferEncoding = r.TransferEncoding
		ossGotMIME = r.Header.Get("Content-Type")
		ossGotCookie = r.Header.Get("Cookie")
		ossGotAuth = r.Header.Get("Authorization")
		ossGotOrigin = r.Header.Get("Origin")
		w.WriteHeader(http.StatusOK)
	}))
	defer ossSrv.Close()

	client, err := NewClient(apiSrv.URL, true)
	if err != nil {
		t.Fatal(err)
	}

	// API client must reject redirect instead of forwarding Bearer token.
	_, err = client.GetDesktopSession(context.Background(), auth.StoredSession{Origin: apiSrv.URL, Token: "test-secret-token"})
	if !apiRedirectHit {
		t.Fatalf("expected API server to be reached")
	}
	ae, ok := AsAPIError(err)
	if !ok || ae.Code != "unexpected_redirect" {
		t.Fatalf("expected unexpected_redirect error, got %v", err)
	}

	// OSS PUT must set explicit Content-Length, no chunked, exact signed headers, no Spark Cookie/Bearer/Origin.
	payload := []byte{137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4}
	err = client.UploadObjectToOSS(context.Background(), UploadGrant{
		ID:     "up-1",
		URL:    ossSrv.URL + "/bucket/staging",
		Method: "PUT",
		Headers: map[string]string{
			"Content-Type": "image/png",
		},
		ExpiresAt: time.Now().Add(10 * time.Minute),
	}, payload)
	if err != nil {
		t.Fatalf("OSS PUT failed: %v", err)
	}
	if ossGotContentLength != int64(len(payload)) {
		t.Fatalf("expected Content-Length=%d, got %d", len(payload), ossGotContentLength)
	}
	if len(ossGotTransferEncoding) != 0 {
		t.Fatalf("expected no Transfer-Encoding (no chunked), got %v", ossGotTransferEncoding)
	}
	if ossGotMIME != "image/png" {
		t.Fatalf("expected Content-Type image/png, got %q", ossGotMIME)
	}
	if ossGotCookie != "" || ossGotAuth != "" || ossGotOrigin != "" {
		t.Fatalf("OSS PUT leaked headers: cookie=%q auth=%q origin=%q", ossGotCookie, ossGotAuth, ossGotOrigin)
	}

	// OSS redirect must be rejected.
	err = client.UploadObjectToOSS(context.Background(), UploadGrant{
		ID:        "up-2",
		URL:       ossSrv.URL + "/redirect",
		Method:    "PUT",
		ExpiresAt: time.Now().Add(10 * time.Minute),
	}, payload)
	if ae, ok := AsAPIError(err); !ok || ae.Code != "oss_redirect_rejected" {
		t.Fatalf("expected oss_redirect_rejected, got %v", err)
	}
}

func TestBuildDocumentSchemaShape(t *testing.T) {
	doc := BuildDocument("第一行\n第二行")
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["schema_version"] != float64(1) {
		t.Fatalf("expected schema_version=1, got %v", parsed["schema_version"])
	}
	emptyDoc := BuildDocument("   ")
	if len(emptyDoc.Content.Content) != 1 || emptyDoc.Content.Content[0].Type != "paragraph" || len(emptyDoc.Content.Content[0].Content) != 0 {
		t.Fatalf("unexpected empty document: %+v", emptyDoc)
	}
}

func TestOriginMismatchStopsBothBearerTransports(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("sample"))
	}))
	defer upstream.Close()
	c, err := NewClient(upstream.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{"", "https://other.example.test"} {
		s := auth.StoredSession{Origin: origin, Token: "synthetic"}
		if _, err := c.GetDesktopSession(context.Background(), s); err == nil {
			t.Fatal("unbound JSON request")
		}
		if _, _, err := c.GetAttachmentThumbnail(context.Background(), s, "image"); err == nil {
			t.Fatal("unbound thumbnail request")
		}
	}
	if hits.Load() != 0 {
		t.Fatal("rejected credentials reached a transport")
	}
	if _, _, err := c.GetAttachmentThumbnail(context.Background(), auth.StoredSession{Origin: c.BaseURL(), Token: "synthetic"}, "image"); err != nil || hits.Load() != 1 {
		t.Fatal("same-origin thumbnail failed", err)
	}
}
