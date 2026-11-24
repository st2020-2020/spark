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
	origin  string
	current StoredSession
}

func OpenSessions(backing CredentialStore, origin string) (*Sessions, error) {
	s, err := backing.Load()
	if err != nil && !errors.Is(err, ErrNoSession) {
		return nil, err
	}
	if origin == "" {
		return nil, errors.New("missing session origin")
	}
	if s.Origin != origin {
		s = StoredSession{}
	}
	return &Sessions{backing: backing, current: s, origin: origin}, nil
}
func (s *Sessions) Load() (StoredSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.current.AccountID == "" {
		return StoredSession{}, ErrNoSession
	}
	return s.current, nil
}

// WithCurrent keeps a local queue update ordered with session replacement.
// The callback must not call back into Sessions or perform network I/O.
func (s *Sessions) WithCurrent(update func(StoredSession) error) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return update(s.current)
}

func (s *Sessions) Save(next StoredSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if next.Origin != s.origin {
		return errors.New("session origin mismatch")
	}
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
func (s *Sessions) Expire(token string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if token == "" || s.current.Token != token || (!s.current.ExpiresAt.IsZero() && !s.current.ExpiresAt.After(time.Now())) {
		return false, nil
	}
	next := s.current
	next.ExpiresAt = time.Now().UTC()
	if err := s.backing.Save(next); err != nil {
		return false, err
	}
	s.current = next
	return true, nil
}
