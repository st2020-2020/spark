package auth

import (
	"errors"
	"sync"
	"time"
)

// Sessions keeps reads off the keychain hot path. All credential changes are
// written through before another goroutine can observe them.
type Sessions struct {
	mu      sync.RWMutex
	backing CredentialStore
	current StoredSession
}

func OpenSessions(backing CredentialStore) (*Sessions, error) {
	s, err := backing.Load()
	if err != nil && !errors.Is(err, ErrNoSession) {
		return nil, err
	}
	return &Sessions{backing: backing, current: s}, nil
}
func (s *Sessions) Load() (StoredSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.current.AccountID == "" {
		return StoredSession{}, ErrNoSession
	}
	return s.current, nil
}
func (s *Sessions) Save(next StoredSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.backing.Save(next); err != nil {
		return err
	}
	s.current = next
	return nil
}
func (s *Sessions) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.backing.Clear(); err != nil {
		return err
	}
	s.current = StoredSession{}
	return nil
}

// An old request may return after the user has already paired a new device session.
func (s *Sessions) Expire(token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if token == "" || s.current.Token != token || !s.current.ExpiresAt.After(time.Now()) {
		return nil
	}
	s.current.ExpiresAt = time.Now().UTC()
	return s.backing.Save(s.current)
}
