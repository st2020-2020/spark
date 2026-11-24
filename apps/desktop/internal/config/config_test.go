package config

import (
	"path/filepath"
	"testing"
)

func TestOriginScopesCredentialsAndLocalData(t *testing.T) {
	root := t.TempDir()
	t.Setenv(DataDirEnv, root)
	t.Setenv(APIBaseURLEnv, "")
	t.Setenv("SPARK_DESKTOP_ALLOW_LOOPBACK_HTTP", "")
	original := DefaultAPIBaseURL
	t.Cleanup(func() { DefaultAPIBaseURL = original })
	load := func(origin string) Config {
		t.Helper()
		DefaultAPIBaseURL = origin
		c, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	prod := load("https://SPARK.STWQY.CLOUD.:443/")
	if prod.APIBaseURL != ProductionOrigin || prod.CredentialService() != KeychainService {
		t.Fatal("default production scope changed")
	}
	if load("https://[0:0:0:0:0:0:0:1]:443/") != load("https://[::1]") {
		t.Fatal("IPv6 aliases differ")
	}
	first := load("https://Notes.Example.test:0443/")
	alias := load("HTTPS://notes.example.test")
	port := load("https://notes.example.test:8443")
	if first != alias || first.CredentialService() != alias.CredentialService() {
		t.Fatal("canonical aliases differ")
	}
	for _, other := range []Config{port, prod} {
		if first.DataDir == other.DataDir || first.CredentialService() == other.CredentialService() {
			t.Fatal("origins share storage")
		}
	}
	if first.DataDir == root || filepath.Dir(filepath.Dir(first.DataDir)) != root {
		t.Fatal("unscoped local store")
	}
}
