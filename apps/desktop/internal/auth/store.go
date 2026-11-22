package auth

import (
	"encoding/json"
	"errors"
	"sync"
)

// ErrNoSession indicates no desktop session is currently stored.
var ErrNoSession = errors.New("no stored desktop session")

// CredentialStore persists the desktop Bearer session exclusively for the Go host process.
type CredentialStore interface {
	Load() (StoredSession, error)
	Save(session StoredSession) error
	Clear() error
}

// MemoryStore is an in-memory CredentialStore used in tests and synthetic preview mode.
type MemoryStore struct {
	mu      sync.RWMutex
	present bool
	session StoredSession
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{}
}

func (m *MemoryStore) Load() (StoredSession, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if !m.present {
		return StoredSession{}, ErrNoSession
	}
	return m.session, nil
}

func (m *MemoryStore) Save(session StoredSession) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.session = session
	m.present = true
	return nil
}

func (m *MemoryStore) Clear() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.session = StoredSession{}
	m.present = false
	return nil
}

func marshalSession(session StoredSession) ([]byte, error) {
	return json.Marshal(session)
}

func unmarshalSession(raw []byte) (StoredSession, error) {
	var s StoredSession
	if err := json.Unmarshal(raw, &s); err != nil {
		return StoredSession{}, err
	}
	if s.Token == "" || s.AccountID == "" {
		return StoredSession{}, ErrNoSession
	}
	return s, nil
}
