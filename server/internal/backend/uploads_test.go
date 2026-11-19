package backend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"spark/server/internal/asset"
)

// The fixture checks V4 request shape and the staging/final handoff.
// Signature verification and vendor lifecycle behavior belong to OSS.
type uploadStorageFixture struct {
	mu             sync.Mutex
	objects        map[string][]byte
	failDeleteOnce string
	blockedDeletes map[string]bool
	deleteAttempts map[string]int
	deleteFailures int
}

func (s *uploadStorageFixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/"), "spark-fixtures/")
	query := r.URL.Query()
	if !strings.HasPrefix(key, "spark/fixture/users/") || r.Header.Get("x-oss-security-token") != "" || query.Has("x-oss-security-token") {
		w.WriteHeader(403)
		return
	}
	if query.Has("x-oss-signature") {
		if !strings.HasPrefix(query.Get("x-oss-credential"), "fixture-key/") || (r.Method == http.MethodPut && !strings.Contains(key, "/uploads/")) {
			w.WriteHeader(403)
			return
		}
	} else if !strings.HasPrefix(r.Header.Get("Authorization"), "OSS4-HMAC-SHA256 Credential=fixture-key/") {
		w.WriteHeader(403)
		return
	}
	switch r.Method {
	case http.MethodPut:
		if copyFrom := r.Header.Get("x-oss-copy-source"); copyFrom != "" {
			source := strings.TrimPrefix(copyFrom, "/spark-fixtures/")
			data := s.objects[source]
			if data == nil {
				w.WriteHeader(403)
				return
			}
			if r.Header.Get("x-oss-copy-source-if-match") != fixtureETag(data) ||
				r.Header.Get("x-oss-forbid-overwrite") != "true" || r.Header.Get("x-oss-metadata-directive") != "REPLACE" {
				w.WriteHeader(412)
				return
			}
			if s.objects[key] != nil {
				w.WriteHeader(409)
				return
			}
			s.objects[key] = bytes.Clone(data)
			fmt.Fprint(w, `<CopyObjectResult><LastModified>2026-11-19T00:00:00Z</LastModified><ETag>"fixture"</ETag></CopyObjectResult>`)
			return
		}
		if !strings.Contains(r.URL.Query().Get("x-oss-additional-headers"), "content-length") {
			http.Error(w, "PUT must sign the length", 400)
			return
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, maxImageBytes+1))
		if err != nil || len(data) > maxImageBytes {
			http.Error(w, "invalid fixture upload", 400)
			return
		}
		s.objects[key] = data
	case http.MethodGet, http.MethodHead:
		data := s.objects[key]
		if data == nil {
			w.WriteHeader(404)
			if r.Method == http.MethodGet {
				fmt.Fprint(w, `<Error><Code>NoSuchKey</Code></Error>`)
			}
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Header().Set("ETag", fixtureETag(data))
		if r.Method == http.MethodGet {
			_, _ = w.Write(data)
		}
	case http.MethodDelete:
		if s.deleteAttempts != nil {
			s.deleteAttempts[key]++
		}
		if s.blockedDeletes[key] || key == s.failDeleteOnce {
			s.failDeleteOnce = ""
			s.deleteFailures++
			w.WriteHeader(500)
			return
		}
		delete(s.objects, key)
		w.WriteHeader(204)
	}
}

func fixtureETag(data []byte) string { return fmt.Sprintf(`"%x"`, sha256.Sum256(data)) }

func newUploadStorageFixture(t *testing.T) (*uploadStorageFixture, *httptest.Server, *asset.OSS) {
	t.Helper()
	storeFixture := &uploadStorageFixture{
		objects: map[string][]byte{},
	}
	httpFixture := httptest.NewServer(storeFixture)
	t.Cleanup(httpFixture.Close)
	dir := t.TempDir()
	credentials := filepath.Join(dir, "credentials.json")
	cfgPath := filepath.Join(dir, "oss.json")
	if err := os.WriteFile(credentials, []byte(`{"access_key_id":"fixture-key","access_key_secret":"fixture-secret"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath, jsonBytes(map[string]any{
		"version": "oss-v2", "oss_region": "cn-shanghai",
		"oss_endpoint": httpFixture.URL, "oss_use_cname": true, "bucket": "spark-fixtures",
		"prefix":           "spark/fixture/",
		"credentials_file": credentials, "put_ttl_seconds": 600, "get_ttl_seconds": 300,
	}), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SPARK_OSS_ENABLED", "true")
	t.Setenv("SPARK_OSS_CONFIG_FILE", cfgPath)
	storage, err := asset.Load("development")
	if err != nil {
		t.Fatal(err)
	}
	return storeFixture, httpFixture, storage
}

func TestUploadsWithIndependentAssetWorker(t *testing.T) {
	app, base := testBackend(t)
	ctx := t.Context()
	storeFixture, httpFixture, storage := newUploadStorageFixture(t)
	app.Assets = storage
	worker, err := StartAssetWorker(context.Background(), app.Pool, storage)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := worker.StopAndCancel(stop); err != nil {
			t.Error(err)
		}
	})
	const aliceEmail = "image-owner@example.test"
	if err := app.BootstrapAdmin(ctx, aliceEmail, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	alice := newClient(t, app, base)
	alice.signIn(aliceEmail)
	alice.invite("INVITE-IMAGE-0002")
	bob := newClient(t, app, base)
	registered := bob.do("POST", "/auth/register", bob.registration("other-image@example.test", "INVITE-IMAGE-0002"), "").want(t, 201)
	bob.csrf = registered["csrf_token"].(string)

	put := func(grant map[string]any, data []byte, target string, want int) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, target, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		for k, v := range grant["headers"].(map[string]any) {
			if strings.EqualFold(k, "Content-Length") {
				t.Fatal("browser-managed header in grant")
			}
			req.Header.Set(k, v.(string))
		}
		resp, err := httpFixture.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != want {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("PUT status %d want %d: %s", resp.StatusCode, want, body)
		}
	}
	waitFor := func(id, status string) map[string]any {
		t.Helper()
		deadline := time.Now().Add(12 * time.Second)
		for {
			data := alice.do("GET", "/uploads/"+id, nil, "").want(t, 200)
			if data["status"] == status {
				return data
			}
			if time.Now().After(deadline) || data["status"] == "rejected" {
				t.Fatalf("waiting for %s saw %v with error_code %v", status, data["status"], data["error_code"])
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	imageBytes := func(c color.RGBA) []byte {
		t.Helper()
		img := image.NewRGBA(image.Rect(0, 0, 3, 3))
		img.SetRGBA(1, 1, c)
		var b bytes.Buffer
		if err := png.Encode(&b, img); err != nil {
			t.Fatal(err)
		}
		return b.Bytes()
	}
	imageA, imageB := imageBytes(color.RGBA{R: 255, A: 255}), imageBytes(color.RGBA{B: 255, A: 255})
	if bytes.Equal(imageA, imageB) || len(imageA) != len(imageB) {
		t.Fatal("expected distinct PNG payloads of equal size")
	}
	req := map[string]any{"filename": "image.png", "mime_type": "image/png", "size_bytes": len(imageA)}
	key := uuid.NewString()
	grant := alice.do("POST", "/uploads", req, key).want(t, 201)
	id := grant["id"].(string)
	replayed := alice.do("POST", "/uploads", req, key)
	if replayed.want(t, 201)["id"] != id || replayed.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("upload replay did not bind the original row")
	}
	var saved []byte
	if err := app.Pool.QueryRow(ctx, "SELECT response_json FROM idempotency_keys WHERE key=$1", key).Scan(&saved); err != nil ||
		string(saved) != strconv.Quote(id) {
		t.Fatal("persisted upload response contained more than its ID")
	}
	bob.do("GET", "/uploads/"+id, nil, "").want(t, 404)
	bob.do("POST", "/uploads/"+id+"/complete", nil, "").want(t, 404)
	originalPUT := grant["url"].(string)
	put(grant, imageA, originalPUT, 200)
	if status := alice.do("POST", "/uploads/"+id+"/complete", nil, "").want(t, 202)["status"]; status != "verifying" {
		t.Fatalf("completion did not queue verification: %v", status)
	}
	waitFor(id, "ready")
	alice.do("POST", "/uploads/"+id+"/complete", nil, "").want(t, 202)

	ownerID := alice.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	_, final := storage.Keys(ownerID, id)
	probeFinal := strings.Replace(originalPUT, "/uploads/"+id, "/attachments/"+id, 1)
	put(grant, imageB, probeFinal, 403)
	put(grant, imageB, originalPUT, 200)
	entryID := uuid.NewString()
	input := collectionInput(entryID, "")
	input["document"] = map[string]any{"schema_version": 1, "content": map[string]any{"type": "doc", "content": []any{
		map[string]any{"type": "paragraph"},
	}}}
	input["upload_ids"] = []string{id}
	bob.do("POST", "/collections", input, uuid.NewString()).want(t, 422)
	var jobs int
	if err := app.Pool.QueryRow(ctx, "SELECT count(*) FROM river_job WHERE kind='spark_verify_upload'").Scan(&jobs); err != nil || jobs != 1 {
		t.Fatalf("completion did not deduplicate River enqueue: count=%d err=%v", jobs, err)
	}
	created := alice.do("POST", "/collections", input, uuid.NewString()).want(t, 201)
	if created["organization"].(map[string]any)["error_code"] != "integration_not_configured" {
		t.Fatal("image upload unexpectedly used text AI")
	}
	a := created["attachments"].([]any)[0].(map[string]any)["id"].(string)
	alice.do("POST", "/collections", collectionInputForUpload(uuid.NewString(), id), uuid.NewString()).want(t, 422)

	reload := newClient(t, app, base)
	reload.signIn(aliceEmail)
	if len(reload.do("GET", "/collections?type=image", nil, "").want(t, 200)["items"].([]any)) != 1 ||
		reload.do("GET", "/collections/"+entryID, nil, "").want(t, 200)["attachments"].([]any)[0].(map[string]any)["id"] != a {
		t.Fatal("image collection or attachment missing on a fresh session")
	}
	download := "/attachments/" + a + "/download"
	bob.do("GET", "/collections/"+entryID, nil, "").want(t, 404)
	bob.do("GET", download, nil, "").want(t, 404)
	getURL := reload.do("GET", download, nil, "").want(t, 200)["url"].(string)
	result, err := httpFixture.Client().Get(getURL)
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(result.Body)
	result.Body.Close()
	if result.StatusCode != 200 || readErr != nil || !bytes.Equal(data, imageA) {
		t.Fatal("staging replay changed the verified final image")
	}
	if !strings.Contains(getURL, final+"?") {
		t.Fatal("GET grant did not target final object")
	}

	path := "/collections/" + entryID
	alice.do("PATCH", path, map[string]any{"base_content_version": 1, "attachment_ids": []string{}}, "").want(t, 422)
	extraGrant := alice.do("POST", "/uploads", req, uuid.NewString()).want(t, 201)
	extraID := extraGrant["id"].(string)
	put(extraGrant, imageB, extraGrant["url"].(string), 200)
	alice.do("POST", "/uploads/"+extraID+"/complete", nil, "").want(t, 202)
	waitFor(extraID, "ready")
	edited := alice.do("PATCH", path, map[string]any{"base_content_version": 1, "upload_ids": []string{extraID}}, "").want(t, 200)
	ordered := edited["attachments"].([]any)
	b := ordered[1].(map[string]any)["id"].(string)
	if edited["content_version"] != float64(2) || ordered[0].(map[string]any)["id"] != a {
		t.Fatal("append failed to preserve the existing attachment and advance the version")
	}
	swapped := alice.do("PATCH", path, map[string]any{"base_content_version": 2, "attachment_ids": []string{b, a}}, "").want(t, 200)
	if swapped["attachments"].([]any)[0].(map[string]any)["id"] != b {
		t.Fatal("requested attachment order was lost")
	}
	alice.do("PATCH", path, map[string]any{"base_content_version": 3, "attachment_ids": []string{b}}, "").want(t, 200)
	alice.do("GET", download, nil, "").want(t, 404)
	var revisions []byte
	if err := app.Pool.QueryRow(ctx, `SELECT attachment_ids FROM collection_revisions
		WHERE user_id=$1 AND collection_id=$2 AND content_version=3`, ownerID, entryID).Scan(&revisions); err != nil {
		t.Fatal(err)
	}
	var previous []string
	if err := json.Unmarshal(revisions, &previous); err != nil || len(previous) != 2 || previous[0] != b || previous[1] != a {
		t.Fatal("removing an attachment lost the ordered revision snapshot")
	}
	if err := app.Pool.QueryRow(ctx, "SELECT count(*) FROM river_job WHERE kind='spark_text_organization'").Scan(&jobs); err != nil || jobs != 0 {
		t.Fatalf("OSS-only processing reached the text AI queue: count=%d err=%v", jobs, err)
	}

	// A complete PNG header with truncated image data must never become ready.
	bad := imageA[:len(imageA)-15]
	req["size_bytes"] = len(bad)
	badGrant := alice.do("POST", "/uploads", req, uuid.NewString()).want(t, 201)
	badID := badGrant["id"].(string)
	put(badGrant, bad, badGrant["url"].(string), 200)
	alice.do("POST", "/uploads/"+badID+"/complete", nil, "").want(t, 202)
	if row := waitFor(badID, "rejected"); row["error_code"] != "invalid_image" {
		t.Fatal("truncated image rejection had wrong cause")
	}

	staging, unusedFinal := storage.Keys(ownerID, badID)
	storeFixture.mu.Lock()
	storeFixture.failDeleteOnce = unusedFinal
	storeFixture.mu.Unlock()
	if _, err := app.Pool.Exec(ctx, "UPDATE uploads SET expires_at=now()-interval '1 second' WHERE id=$1", badID); err != nil {
		t.Fatal(err)
	}
	if _, err := app.Pool.Exec(ctx, `UPDATE river_job SET state='available', scheduled_at=now()
		WHERE kind='spark_cleanup_upload' AND args->>'upload_id'=$1`, badID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		var exists bool
		if err := app.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT FROM uploads WHERE id=$1)", badID).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("unused upload did not recover from transient cleanup failure")
		}
		time.Sleep(100 * time.Millisecond)
	}
	storeFixture.mu.Lock()
	defer storeFixture.mu.Unlock()
	if storeFixture.deleteFailures != 1 || storeFixture.objects[staging] != nil || storeFixture.objects[unusedFinal] != nil ||
		!bytes.Equal(storeFixture.objects[final], imageA) {
		t.Fatal("cleanup retry did not remove only the unused upload")
	}
}

func TestCreateCollectionWithUploadReplaysWhenStorageDisabled(t *testing.T) {
	app, base := testBackend(t)
	user := imageTestAccount(t, app, base, "upload-replay")
	objects, _, storage := newUploadStorageFixture(t)
	app.Assets = storage
	owner := user.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	uploadID := confirmedImageTestUpload(t, app, owner, objects)
	unusedUploadID := confirmedImageTestUpload(t, app, owner, objects)
	id, key := uuid.NewString(), uuid.NewString()
	input := collectionInputForUpload(id, uploadID)
	path := "/collections/" + id
	saved := user.do("POST", "/collections", input, key).want(t, 201)
	attachment := saved["attachments"].([]any)[0].(map[string]any)["id"]

	cfg := app.Config
	cfg.PurgeEnabled = true
	disabled, err := New(t.Context(), cfg, app.Pool)
	if err != nil {
		t.Fatal(err)
	}
	disabledServer := httptest.NewServer(disabled.Router())
	t.Cleanup(disabledServer.Close)
	user.app, user.base = disabled, disabledServer.URL

	replay := user.do("POST", "/collections", input, key)
	replayed := replay.want(t, 201)
	if replay.header.Get("Idempotent-Replayed") != "true" || replayed["id"] != id ||
		!equalJSON(replayed["attachments"], saved["attachments"]) {
		t.Fatalf("replay did not return the original collection and attachment: %v", replayed)
	}
	current := user.do("GET", path, nil, "").want(t, 200)
	if attached := current["attachments"].([]any); len(attached) != 1 || attached[0].(map[string]any)["id"] != attachment {
		t.Fatalf("persisted attachment changed after replay: %v", attached)
	}

	assertCode := func(response apiResponse, status int, code string) {
		t.Helper()
		if got := response.want(t, status)["error"].(map[string]any)["code"]; got != code {
			t.Fatalf("error code = %v, want %s", got, code)
		}
	}
	differentInput := collectionInputForUpload(id, uploadID)
	differentInput["intent"] = "different request"
	assertCode(user.do("POST", "/collections", differentInput, key), 409, "idempotency_mismatch")

	newID := uuid.NewString()
	assertCode(user.do("POST", "/collections", collectionInputForUpload(newID, unusedUploadID), uuid.NewString()),
		503, "integration_not_configured")
	user.do("GET", "/collections/"+newID, nil, "").want(t, 404)

	user.do("DELETE", path, map[string]any{"base_resource_version": 1}, "").want(t, 200)
	user.do("POST", path+"/purge", map[string]any{"base_resource_version": 2}, uuid.NewString()).want(t, 202)
	for _, createKey := range []string{key, uuid.NewString()} {
		assertCode(user.do("POST", "/collections", input, createKey), 409, "duplicate_resource")
	}
	user.do("GET", path, nil, "").want(t, 404)
}

func TestUploadCleanupRequeuesDiscardedJobsWithoutRemovingAttachedFinal(t *testing.T) {
	app, base := testBackend(t)
	ctx := t.Context()
	user := imageTestAccount(t, app, base, "upload-cleanup")
	objects, _, storage := newUploadStorageFixture(t)
	app.Assets = storage
	owner := user.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	attached := confirmedImageTestUpload(t, app, owner, objects)
	unused := confirmedImageTestUpload(t, app, owner, objects)
	attachedStage, attachedFinal := storage.Keys(owner, attached)
	unusedStage, unusedFinal := storage.Keys(owner, unused)
	objects.objects[attachedStage] = bytes.Clone(objects.objects[attachedFinal])
	objects.objects[unusedStage] = bytes.Clone(objects.objects[unusedFinal])
	objects.blockedDeletes = map[string]bool{attachedStage: true, unusedFinal: true}
	objects.deleteAttempts = map[string]int{}

	collection := uuid.NewString()
	user.do("POST", "/collections", collectionInputForUpload(collection, attached), uuid.NewString()).want(t, 201)
	if _, err := app.Pool.Exec(ctx, `UPDATE uploads SET expires_at=now()-interval '1 second'
		WHERE user_id=$1 AND (id=$2 OR id=$3)`, owner, attached, unused); err != nil {
		t.Fatal(err)
	}
	jobs := []int64{}
	for _, id := range []string{attached, unused} {
		job, err := app.Organizer.Queue.Insert(ctx, cleanupUploadArgs{UserID: owner, UploadID: id},
			&river.InsertOpts{Queue: assetQueue, MaxAttempts: 1})
		if err != nil {
			t.Fatal(err)
		}
		jobs = append(jobs, job.Job.ID)
	}
	worker, err := StartAssetWorker(context.Background(), app.Pool, storage)
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, worker)
	waitImageTest(t, "both jobs to exhaust their River attempts", func() bool {
		for _, id := range jobs {
			job, err := app.Organizer.Queue.JobGet(ctx, id)
			if err != nil || job.State != rivertype.JobStateDiscarded {
				return false
			}
		}
		return true
	})
	objects.mu.Lock()
	objects.blockedDeletes = nil
	objects.mu.Unlock()

	if recovered, err := RequeueUploadCleanup(ctx, app.Pool); err != nil || recovered != 2 {
		t.Fatalf("expected attached staging and unused final cleanup to be requeued: %d, %v", recovered, err)
	}
	if repeated, err := RequeueUploadCleanup(ctx, app.Pool); err != nil || repeated != 0 {
		t.Fatalf("recovery queued overlapping cleanup: %d, %v", repeated, err)
	}
	waitImageTest(t, "unused upload removal", func() bool {
		return user.do("GET", "/uploads/"+unused, nil, "").status == http.StatusNotFound
	})
	waitImageTest(t, "attached staging deletion", func() bool {
		objects.mu.Lock()
		defer objects.mu.Unlock()
		return objects.objects[attachedStage] == nil
	})
	waitImageTest(t, "both recovered jobs to finish", func() bool {
		var complete int
		err := app.Pool.QueryRow(ctx, `SELECT count(*) FROM river_job
			WHERE kind='spark_cleanup_upload' AND state='completed'`).Scan(&complete)
		return err == nil && complete == 2
	})
	if pending, err := RequeueUploadCleanup(ctx, app.Pool); err != nil || pending != 0 {
		t.Fatalf("completed cleanups remained eligible: %d, %v", pending, err)
	}
	user.do("GET", "/collections/"+collection, nil, "").want(t, 200)
	if row := user.do("GET", "/uploads/"+attached, nil, "").want(t, 200); row["status"] != "attached" {
		t.Fatalf("attached upload changed: %v", row)
	}
	objects.mu.Lock()
	defer objects.mu.Unlock()
	if objects.objects[attachedFinal] == nil || objects.deleteAttempts[attachedFinal] != 0 ||
		objects.objects[unusedStage] != nil || objects.objects[unusedFinal] != nil || objects.deleteAttempts[unusedStage] != 1 {
		t.Fatal("recovery deleted an attached final or repeated completed staging cleanup")
	}
}

func collectionInputForUpload(id, uploadID string) map[string]any {
	body := collectionInput(id, "synthetic text")
	body["upload_ids"] = []string{uploadID}
	return body
}
