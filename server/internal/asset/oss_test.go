package asset

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestOSSRejectsKeysOutsideOperationScope(t *testing.T) {
	// No OSS client: a rejected key must not reach the signer or network.
	s := &OSS{OSSConfig: OSSConfig{Prefix: "spark/test/"}}
	const owner = "fd330b14-90f5-4af9-970d-674c041c23dc"
	const upload = "0867e74e-84e9-47ab-8de3-db48e285ffb6"
	staging, final := s.Keys(owner, upload)
	for _, key := range []string{
		strings.Replace(final, "spark/test/", "spark/prod/", 1),
		strings.Replace(staging, owner, "..", 1),
		final + "/extra", final + "?partNumber=1", final + "%2f..",
	} {
		if err := s.Delete(t.Context(), key, ""); !errors.Is(err, errObjectScope) {
			t.Fatalf("invalid delete key accepted: %v", err)
		}
	}
	if _, err := s.SignPut(t.Context(), final, "image/png", 1, time.Now().Add(time.Minute)); !errors.Is(err, errObjectScope) {
		t.Fatal("PUT outside staging scope")
	}
	if _, err := s.SignGet(t.Context(), staging, ""); !errors.Is(err, errObjectScope) {
		t.Fatal("GET outside final scope")
	}
	if _, err := s.ReadFinal(t.Context(), staging, "", 1); !errors.Is(err, errObjectScope) {
		t.Fatal("read outside final scope")
	}
	otherStaging, _ := s.Keys(upload, upload)
	if _, _, err := s.OpenFinal(t.Context(), otherStaging, final, "image/png", 1); !errors.Is(err, errObjectScope) {
		t.Fatal("mismatched copy keys accepted")
	}
}

func TestDirectPresignedGrantBoundaries(t *testing.T) {
	s := newOSS(OSSConfig{OSSRegion: "cn-shanghai", OSSEndpoint: "https://oss.example.test", Bucket: "bucket-fixture", Prefix: "spark/test/", PutTTL: 600, GetTTL: 300}, accessKey{ID: "fixture-key", Secret: "fixture-secret"})
	stage, final := s.Keys("fd330b14-90f5-4af9-970d-674c041c23dc", "0867e74e-84e9-47ab-8de3-db48e285ffb6")
	deadline := time.Now().Add(25 * time.Second)
	put, err := s.SignPut(t.Context(), stage, "image/png", 167, deadline)
	if err != nil || put.ExpiresAt.After(deadline) {
		t.Fatalf("PUT deadline or signing error: %v", err)
	}
	get, err := s.SignGet(t.Context(), final, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, grant := range []struct {
		g          Grant
		key        string
		maxSeconds int
	}{{put, stage, 25}, {get, final, 300}} {
		u, err := url.Parse(grant.g.URL)
		if err != nil {
			t.Fatal("invalid signed URL")
		}
		q := u.Query()
		seconds, err := strconv.Atoi(q.Get("x-oss-expires"))
		if err != nil || seconds < 1 || seconds > grant.maxSeconds || u.Scheme != "https" || u.Path != "/"+grant.key || q.Get("x-oss-signature") == "" || q.Has("x-oss-security-token") || strings.Contains(grant.g.URL, "fixture-secret") {
			t.Fatal("unexpected signed grant scope")
		}
		for name, v := range grant.g.Headers {
			if strings.EqualFold(name, "authorization") || strings.Contains(v, "fixture-secret") {
				t.Fatal("unexpected grant header")
			}
		}
	}
	if _, err = s.SignPut(t.Context(), stage, "image/png", 167, time.Now().Add(-time.Second)); err == nil {
		t.Fatal("expired upload accepted")
	}
}
