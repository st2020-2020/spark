//go:build !darwin

package auth

import "errors"

// KeychainStore stub for non-macOS compilation.
type KeychainStore struct{}

func NewKeychainStore(_ string) *KeychainStore { return &KeychainStore{} }

func (k *KeychainStore) Load() (StoredSession, error) {
	return StoredSession{}, ErrNoSession
}

func (k *KeychainStore) Save(_ StoredSession) error {
	return errors.New("macOS Keychain is only available on darwin")
}

func (k *KeychainStore) Clear() error { return nil }
