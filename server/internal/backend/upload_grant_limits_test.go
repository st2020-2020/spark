package backend

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"spark/server/internal/asset"
)

type grantCountingStorage struct {
	asset.Storage
	putCalls, getCalls atomic.Int32
	failPut            atomic.Bool
}

func (s *grantCountingStorage) SignPut(ctx context.Context, key, mime string, size int64, deadline time.Time) (asset.Grant, error) {
	s.putCalls.Add(1)
	if s.failPut.Swap(false) {
		return asset.Grant{}, errors.New("controlled signing failure")
	}
	return s.Storage.SignPut(ctx, key, mime, size, deadline)
}

func (s *grantCountingStorage) SignGet(ctx context.Context, key, version string) (asset.Grant, error) {
	s.getCalls.Add(1)
	return s.Storage.SignGet(ctx, key, version)
}

func grantUploadInput(size int) map[string]any {
	return map[string]any{"filename": "synthetic.png", "mime_type": "image/png", "size_bytes": size}
}

func requireGrantLimit(t *testing.T, response apiResponse, maxRetry time.Duration) {
	t.Helper()
	if payload := response.want(t, http.StatusTooManyRequests); payload["error"].(map[string]any)["code"] != "rate_limited" {
		t.Fatal("expected rate_limited")
	}
	retry, err := strconv.Atoi(response.header.Get("Retry-After"))
	if err != nil || retry < 1 || retry > int(maxRetry/time.Second) {
		t.Fatalf("invalid Retry-After: %q", response.header.Get("Retry-After"))
	}
}

func TestUploadGrantLimitsAccountCountAndDeclaredBytes(t *testing.T) {
	app, base := testBackend(t)
	_, _, adapter := newUploadStorageFixture(t)
	storage := &grantCountingStorage{Storage: adapter}
	app.Assets = storage
	a := imageTestAccount(t, app, base, "grant-count")
	b := imageTestAccount(t, app, base, "grant-bytes")
	replica, err := New(t.Context(), app.Config, app.Pool)
	if err != nil {
		t.Fatal(err)
	}
	replica.Assets = storage
	api := httptest.NewServer(replica.Router())
	t.Cleanup(api.Close)
	aReplica := *a
	aReplica.app, aReplica.base = replica, api.URL

	const mib = 1 << 20
	small := grantUploadInput(1)
	responses := make([]apiResponse, 48)
	var requests sync.WaitGroup
	for i := range responses {
		requests.Go(func() {
			client := a
			if i%2 == 0 {
				client = &aReplica
			}
			responses[i] = client.do("POST", "/uploads", small, uuid.NewString())
		})
	}
	requests.Wait()
	valid := 0
	for _, response := range responses {
		if response.status == 201 {
			valid++
		} else {
			requireGrantLimit(t, response, 24*time.Hour)
		}
	}
	if valid != 40 || storage.putCalls.Load() != 40 {
		t.Fatalf("concurrent distinct keys created %d grants and invoked %d signatures; want 40 each", valid, storage.putCalls.Load())
	}

	for range 19 {
		b.do("POST", "/uploads", grantUploadInput(5*mib), uuid.NewString()).want(t, 201)
	}
	b.do("POST", "/uploads", grantUploadInput(4*mib), uuid.NewString()).want(t, 201)
	requireGrantLimit(t, b.do("POST", "/uploads", grantUploadInput(2*mib), uuid.NewString()), 24*time.Hour)
	b.do("POST", "/uploads", grantUploadInput(mib), uuid.NewString()).want(t, 201)
	requireGrantLimit(t, b.do("POST", "/uploads", small, uuid.NewString()), 24*time.Hour)
	if storage.putCalls.Load() != 61 {
		t.Fatalf("byte limit allowed denied requests to reach the signer: %d attempts", storage.putCalls.Load())
	}
}

func TestUploadGrantLimitCountsReplaysAndFailedSignatures(t *testing.T) {
	app, base := testBackend(t)
	_, _, adapter := newUploadStorageFixture(t)
	storage := &grantCountingStorage{Storage: adapter}
	app.Assets = storage
	client := imageTestAccount(t, app, base, "put-replay")
	key := uuid.NewString()
	input := grantUploadInput(1024)
	storage.failPut.Store(true)
	client.do("POST", "/uploads", input, key).want(t, 503)
	first := client.do("POST", "/uploads", input, key)
	id := first.want(t, 201)["id"]
	if first.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("a failed signature lost the pending upload")
	}
	for range 58 {
		response := client.do("POST", "/uploads", input, key)
		if response.want(t, 201)["id"] != id || response.header.Get("Idempotent-Replayed") != "true" {
			t.Fatal("signature replay changed the pending upload")
		}
	}
	requireGrantLimit(t, client.do("POST", "/uploads", input, key), 10*time.Minute)
	requireGrantLimit(t, client.do("POST", "/uploads", input, uuid.NewString()), 10*time.Minute)
	changed := client.do("POST", "/uploads", grantUploadInput(2048), key).want(t, 409)
	if changed["error"].(map[string]any)["code"] != "idempotency_mismatch" {
		t.Fatal("signing limit hid idempotency mismatch")
	}
	var count, bytes int
	if err := app.Pool.QueryRow(t.Context(), "SELECT count(*),COALESCE(sum(declared_size),0) FROM uploads").Scan(&count, &bytes); err != nil {
		t.Fatal(err)
	}
	if count != 1 || bytes != 1024 || storage.putCalls.Load() != 60 {
		t.Fatalf("expected 1 upload and 60 signing attempts; saw %d uploads, %d bytes and %d attempts", count, bytes, storage.putCalls.Load())
	}

	uid := client.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	if _, err := app.Pool.Exec(t.Context(), `UPDATE auth_rate_limits SET window_start=now()-interval '11 minutes' WHERE key=$1`,
		app.mac("rate", "oss:put:"+uid)); err != nil {
		t.Fatal(err)
	}
	retry := client.do("POST", "/uploads", input, key)
	if retry.want(t, 201)["id"] != id || retry.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("a later signing window could not recover the same upload")
	}
}

func TestDownloadGrantLimitKeepsOwnershipAndShortExpiry(t *testing.T) {
	app, base := testBackend(t)
	objects, _, adapter := newUploadStorageFixture(t)
	storage := &grantCountingStorage{Storage: adapter}
	app.Assets = storage
	a := imageTestAccount(t, app, base, "download-a")
	b := imageTestAccount(t, app, base, "download-b")
	aPath := "/attachments/" + saveImageCollection(t, app, a, objects).attachmentID + "/download"
	bPath := "/attachments/" + saveImageCollection(t, app, b, objects).attachmentID + "/download"
	b.do("GET", aPath, nil, "").want(t, 404)
	if storage.getCalls.Load() != 0 {
		t.Fatal("cross-account download reached the signer")
	}

	start := time.Now()
	first := a.do("GET", aPath, nil, "").want(t, 200)
	expiry, err := time.Parse(time.RFC3339, first["expires_at"].(string))
	if err != nil || !expiry.After(start) || expiry.After(time.Now().Add(5*time.Minute)) {
		t.Fatalf("download grant expiry is not short-lived: %s, %v", expiry, err)
	}
	for range 115 {
		a.do("GET", aPath, nil, "").want(t, 200)
	}
	responses := make([]apiResponse, 8)
	var requests sync.WaitGroup
	for i := range responses {
		requests.Go(func() { responses[i] = a.do("GET", aPath, nil, "") })
	}
	requests.Wait()
	grants := 0
	for _, response := range responses {
		if response.status == 200 {
			grants++
		} else {
			requireGrantLimit(t, response, 10*time.Minute)
		}
	}
	if grants != 4 {
		t.Fatalf("concurrent download requests consumed %d of 4 remaining grants", grants)
	}
	requireGrantLimit(t, a.do("GET", aPath, nil, ""), 10*time.Minute)
	a.do("GET", bPath, nil, "").want(t, 404)
	b.do("GET", bPath, nil, "").want(t, 200)
	if storage.getCalls.Load() != 121 {
		t.Fatalf("signing limit or account isolation failed: %d attempts", storage.getCalls.Load())
	}
}
