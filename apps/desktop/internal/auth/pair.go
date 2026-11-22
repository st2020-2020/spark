package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	// DesktopPairDomainPrefix domain-separates desktop pairing challenges from browser extension pairing.
	DesktopPairDomainPrefix = "spark-desktop-pair-v1:"
	PairLifetime            = 5 * time.Minute
)

var secretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// PairRequest holds the ephemeral local verifier and derived challenge for a 5-minute desktop pairing.
// Verifier must NEVER be sent in a browser URL or exposed to WebView.
type PairRequest struct {
	Verifier  string
	Challenge string
	ShortCode string
	CreatedAt time.Time
	ExpiresAt time.Time
}

// StoredSession represents the persisted desktop device session kept in macOS Keychain.
// Token must remain strictly inside the Go host process and never be serialized to WebView.
type StoredSession struct {
	Token        string    `json:"token"`
	AccountID    string    `json:"account_id"`
	AccountLabel string    `json:"account_label"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// PublicSession is the non-secret view safe to expose to the desktop UI.
type PublicSession struct {
	Connected    bool      `json:"connected"`
	AccountID    string    `json:"account_id,omitempty"`
	AccountLabel string    `json:"account_label,omitempty"`
	ExpiresAt    time.Time `json:"expires_at,omitempty"`
	Expired      bool      `json:"expired,omitempty"`
}

func (s StoredSession) Public(now time.Time) PublicSession {
	if s.Token == "" || s.AccountID == "" {
		return PublicSession{Connected: false}
	}
	expired := !s.ExpiresAt.IsZero() && !s.ExpiresAt.After(now)
	return PublicSession{
		Connected:    !expired,
		AccountID:    s.AccountID,
		AccountLabel: s.AccountLabel,
		ExpiresAt:    s.ExpiresAt,
		Expired:      expired,
	}
}

// NewPairRequest creates a fresh CSPRNG 32-byte verifier and its domain-separated SHA-256 challenge.
func NewPairRequest(now time.Time) (PairRequest, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return PairRequest{}, fmt.Errorf("generate pairing verifier: %w", err)
	}
	verifier := base64.RawURLEncoding.EncodeToString(raw)
	challenge, err := DeriveChallenge(verifier)
	if err != nil {
		return PairRequest{}, err
	}
	return PairRequest{
		Verifier:  verifier,
		Challenge: challenge,
		ShortCode: FormatShortCode(challenge),
		CreatedAt: now,
		ExpiresAt: now.Add(PairLifetime),
	}, nil
}

// DeriveChallenge computes base64url_nopad(SHA-256(UTF-8("spark-desktop-pair-v1:" + verifier))).
func DeriveChallenge(verifier string) (string, error) {
	if !IsValidSecret(verifier) {
		return "", errors.New("invalid pairing verifier format")
	}
	sum := sha256.Sum256([]byte(DesktopPairDomainPrefix + verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// IsValidSecret checks whether s is a 43-character unpadded base64url string (32 decoded bytes).
func IsValidSecret(s string) bool {
	if !secretPattern.MatchString(s) {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	return err == nil && len(raw) == 32
}

// FormatShortCode returns the case-sensitive 4+4 comparison code from the first 8 chars of challenge.
func FormatShortCode(challenge string) string {
	if len(challenge) < 8 {
		return challenge
	}
	return challenge[:4] + " " + challenge[4:8]
}

// BuildPairURL builds <origin>/desktop/pair#challenge=<challenge> with no other parameters.
func BuildPairURL(apiBaseURL string, challenge string) (string, error) {
	if !IsValidSecret(challenge) {
		return "", errors.New("invalid challenge")
	}
	base := strings.TrimRight(strings.TrimSpace(apiBaseURL), "/")
	if base == "" {
		return "", errors.New("empty API base URL")
	}
	return base + "/desktop/pair#challenge=" + challenge, nil
}
