//go:build darwin

package auth

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestIsolatedKeychainRoundTrip(t *testing.T) {
	k := NewKeychainStore(fmt.Sprintf("com.spark.desktop.test.%d", time.Now().UnixNano()))
	t.Cleanup(func() {
		if err := k.Clear(); err != nil {
			t.Error(err)
		}
	})
	proof, err := NewPairRequest(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	issued := StoredSession{Token: proof.Verifier, AccountID: "synthetic-account", ExpiresAt: time.Now().UTC().Add(time.Hour)}
	if err := k.Save(issued); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenSessions(k)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := reopened.Load()
	if err != nil || loaded != issued {
		t.Fatal("session did not round-trip")
	}
	if err := reopened.Expire(issued.Token); err != nil {
		t.Fatal(err)
	}
	loaded, err = k.Load()
	if err != nil || !loaded.Public(time.Now()).Expired {
		t.Fatal("revocation was not persisted")
	}
	if err := reopened.Clear(); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Load(); !errors.Is(err, ErrNoSession) {
		t.Fatal("keychain entry was not removed")
	}
}
