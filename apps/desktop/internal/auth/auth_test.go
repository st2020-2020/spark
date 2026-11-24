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

func TestOriginBindingAndExpiryTransitions(t *testing.T) {
	const origin = "https://notes.example.test"
	backing := NewMemoryStore()
	for _, unbound := range []string{"", "https://elsewhere.example.test"} {
		_ = backing.Save(StoredSession{Origin: unbound, Token: "old", AccountID: "owner"})
		s, err := OpenSessions(backing, origin)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = s.Load(); err != ErrNoSession {
			t.Fatal("restored unbound credential")
		}
	}
	sessions, err := OpenSessions(backing, origin)
	if err != nil {
		t.Fatal(err)
	}
	issued := StoredSession{Origin: origin, Token: "new", AccountID: "owner", ExpiresAt: time.Now().Add(time.Hour)}
	if err = sessions.Save(issued); err != nil {
		t.Fatal(err)
	}
	results := make(chan bool, 8)
	for i := 0; i < 8; i++ {
		go func() {
			changed, err := sessions.Expire(issued.Token)
			if err != nil {
				t.Error(err)
			}
			results <- changed
		}()
	}
	n := 0
	for i := 0; i < 8; i++ {
		if <-results {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("expected one expiry transition, got %d", n)
	}
	restored, err := OpenSessions(backing, origin)
	if err != nil {
		t.Fatal(err)
	}
	s, err := restored.Load()
	if err != nil || !s.Public(time.Now()).Expired || s.AccountID != "owner" {
		t.Fatal("lost offline account ownership")
	}
	if changed, err := restored.Expire("previous"); err != nil || changed {
		t.Fatal("stale request changed the current session")
	}
}
