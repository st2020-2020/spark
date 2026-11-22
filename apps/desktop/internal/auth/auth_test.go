package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestDesktopPairDomainSeparatedChallenge(t *testing.T) {
	now := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	pair, err := NewPairRequest(now)
	if err != nil {
		t.Fatal(err)
	}
	if !IsValidSecret(pair.Verifier) {
		t.Fatalf("expected 43-char base64url verifier, got %q", pair.Verifier)
	}
	if !IsValidSecret(pair.Challenge) {
		t.Fatalf("expected 43-char base64url challenge, got %q", pair.Challenge)
	}

	// Verify exact domain-separated derivation matches backend contract.
	expectedSum := sha256.Sum256([]byte("spark-desktop-pair-v1:" + pair.Verifier))
	expectedChallenge := base64.RawURLEncoding.EncodeToString(expectedSum[:])
	if pair.Challenge != expectedChallenge {
		t.Fatalf("challenge mismatch: got %q want %q", pair.Challenge, expectedChallenge)
	}

	// Verify it differs from unprefixed browser-extension challenge.
	extSum := sha256.Sum256([]byte(pair.Verifier))
	extChallenge := base64.RawURLEncoding.EncodeToString(extSum[:])
	if pair.Challenge == extChallenge {
		t.Fatalf("desktop challenge must not equal extension challenge")
	}

	// Short code is 4+4 case-sensitive from first 8 chars of challenge.
	wantShort := pair.Challenge[:4] + " " + pair.Challenge[4:8]
	if pair.ShortCode != wantShort {
		t.Fatalf("short code mismatch: got %q want %q", pair.ShortCode, wantShort)
	}
	if pair.ExpiresAt.Sub(pair.CreatedAt) != 5*time.Minute {
		t.Fatalf("expected 5m expiry, got %v", pair.ExpiresAt.Sub(pair.CreatedAt))
	}

	pairURL, err := BuildPairURL("https://spark.example.com/", pair.Challenge)
	if err != nil {
		t.Fatal(err)
	}
	if pairURL != "https://spark.example.com/desktop/pair#challenge="+pair.Challenge {
		t.Fatalf("unexpected pair URL: %q", pairURL)
	}
	if strings.Contains(pairURL, pair.Verifier) {
		t.Fatalf("pair URL must never contain verifier")
	}
}
