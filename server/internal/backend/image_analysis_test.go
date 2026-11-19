package backend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"spark/server/internal/purgearchive"
)

func TestImageConsentIsSeparateFromTextAI(t *testing.T) {
	app, base := testBackend(t)
	const email = "image-consent@example.test"
	if err := app.BootstrapAdmin(t.Context(), email, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	client := newClient(t, app, base)
	client.signIn(email)
	path := "/me/image-analysis"
	if prefs := client.do("GET", path, nil, "").want(t, 200); prefs["enabled"] != false || prefs["available"] != false {
		t.Fatalf("image consent should default off: %v", prefs)
	}
	client.do("PUT", path, map[string]any{"enabled": true, "consent_version": "text-v1"}, "").want(t, 422)
	if prefs := client.do("PUT", path, map[string]any{"enabled": true, "consent_version": "deepseek-images-v1"}, "").want(t, 200); prefs["enabled"] != true {
		t.Fatalf("image consent should be explicit: %v", prefs)
	}
	if user := client.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any); user["ai_enabled"] != false {
		t.Fatal("image opt-in also enabled text AI")
	}
	client.do("PUT", path, map[string]any{"enabled": false}, "").want(t, 200)
	if prefs := client.do("GET", path, nil, "").want(t, 200); prefs["enabled"] != false {
		t.Fatalf("revocation should take effect immediately: %v", prefs)
	}
}

func TestImageAnalysisSharesBudgetAndProvidesSeparateEvidence(t *testing.T) {
	app, base := testBackend(t)
	app.Config.ImageAnalysisEnabled = true
	owner, other := imageTestAccount(t, app, base, "owner"), imageTestAccount(t, app, base, "other")
	objects, _, storage := newUploadStorageFixture(t)
	app.Assets = storage
	save := func(account *apiClient) imageCollection {
		return saveImageCollection(t, app, account, objects)
	}
	var calls atomic.Int32
	entered, release := make(chan struct{}, 1), make(chan struct{})
	releaseCall := sync.OnceFunc(func() { close(release) })
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verifyImageModelRequest(t, r)
		calls.Add(1)
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
		modelReply(w, "stop", `{"text":"原字灯塔","description":"绿色航海图"}`, map[string]int{"prompt_tokens": 1024, "completion_tokens": 30})
	}))
	t.Cleanup(model.Close)
	t.Cleanup(releaseCall)
	startImageTestWorker(t, app, storage, model.URL)

	// A text opt-in and a confirmed file alone give no permission to send images.
	owner.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
	old := save(owner)
	enableImageTestAccount(owner)
	enableImageTestAccount(other)
	if items := imageExtractions(t, owner, old.id); len(items) != 0 {
		t.Fatalf("opt-in unexpectedly backfilled old attachments: %v", items)
	}
	zero := save(owner)
	if result := waitForImageStatus(t, owner, zero.id, "blocked"); result["error_code"] != "quota_exceeded" {
		t.Fatalf("zero budget was not the blocking reason: %v", result)
	}
	setImageTestBudget(owner, 1, 7168, 7167)
	insufficientUser := save(owner)
	if result := waitForImageStatus(t, owner, insufficientUser.id, "blocked"); result["error_code"] != "quota_exceeded" {
		t.Fatalf("insufficient user budget was not the blocking reason: %v", result)
	}
	setImageTestBudget(owner, 2, 7167, 7168)
	insufficientPlatform := save(owner)
	if result := waitForImageStatus(t, owner, insufficientPlatform.id, "blocked"); result["error_code"] != "quota_exceeded" {
		t.Fatalf("insufficient platform budget was not the blocking reason: %v", result)
	}
	if calls.Load() != 0 {
		t.Fatal("model received a request without adequate daily budget")
	}
	setImageTestBudget(owner, 3, 7168, 7168)
	first := save(owner)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatalf("provider did not receive the approved image: %v", imageExtractions(t, owner, first.id))
	}
	loser := save(other)
	blocked := waitForImageStatus(t, other, loser.id, "blocked")
	if blocked["error_code"] != "quota_exceeded" || calls.Load() != 1 {
		t.Fatalf("concurrent users exceeded the shared daily budget: %v, %d calls", blocked, calls.Load())
	}
	if usage := owner.do("GET", "/me/usage", nil, "").want(t, 200); usage["reserved_units"] != float64(7168) {
		t.Fatalf("wrong reservation: %v", usage)
	}

	// A text job competes against the very same platform and user rows.
	var textCalls atomic.Int32
	text := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		textCalls.Add(1)
		w.WriteHeader(500)
	}))
	t.Cleanup(text.Close)
	cfg := AIConfig{Version: "text-fixture", MaxAttempts: 1, TimeoutSeconds: 2, MaxInputChars: 1000, Routes: []AIRoute{{
		Name: "text-fixture", Endpoint: text.URL, Model: "synthetic", OutputMode: "json_object",
		MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 1000000, OutputPrice: 1000000,
	}}}
	tc := NewTextClient()
	t.Cleanup(tc.Close)
	textWorker, err := StartTextWorker(context.Background(), app.Pool, cfg, app.Organizer.Trial, tc)
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, textWorker)
	app.Organizer.Enabled = true
	textID := uuid.NewString()
	owner.do("POST", "/collections", collectionInput(textID, "合成文字预算竞争"), uuid.NewString()).want(t, 201)
	waitImageTest(t, "text budget denial", func() bool {
		org := owner.do("GET", "/collections/"+textID+"/organization", nil, "").want(t, 200)
		return org["status"] == "blocked"
	})
	if textCalls.Load() != 0 {
		t.Fatal("text worker bypassed the image reservation")
	}
	app.Organizer.Enabled = false
	releaseCall()
	item := waitForImageStatus(t, owner, first.id, "succeeded")
	if item["text"] != "原字灯塔" || item["image_description"] != "绿色航海图" {
		t.Fatalf("image evidence was not separated: %v", item)
	}
	if usage := owner.do("GET", "/me/usage", nil, "").want(t, 200); usage["reserved_units"] != float64(0) || usage["settled_units"] != float64(2288) {
		t.Fatalf("unexpected settlement: %v", usage)
	}
	other.do("GET", "/collections/"+first.id+"/extractions", nil, "").want(t, 404)
	owner.do("PUT", "/me/image-analysis", map[string]any{"enabled": false}, "").want(t, 200)
	extraUpload := confirmedImageTestUpload(t, app, first.userID, objects)
	added := owner.do("PATCH", "/collections/"+first.id, map[string]any{
		"base_content_version": 1, "manual_title": "人工标题", "upload_ids": []string{extraUpload},
	}, "").want(t, 200)
	secondID := added["attachments"].([]any)[1].(map[string]any)["id"].(string)
	enableImageTestAccount(owner)
	owner.do("PATCH", "/collections/"+first.id, map[string]any{"base_content_version": 2, "attachment_ids": []string{secondID, first.attachmentID}}, "").want(t, 200)
	if after := waitForImageStatus(t, owner, first.id, "succeeded"); after["id"] != item["id"] {
		t.Fatalf("editing a collection regenerated the image result: %v", after)
	}
	for field, query := range map[string]string{"image_text": "灯塔", "image_description": "航海图"} {
		results := owner.do("GET", "/search?q="+url.QueryEscape(query), nil, "").want(t, 200)["items"].([]any)
		if len(results) != 1 || results[0].(map[string]any)["snippets"].([]any)[0].(map[string]any)["field"] != field {
			t.Fatalf("%s did not match as separate evidence: %v", field, results)
		}
		if theirs := other.do("GET", "/search?q="+url.QueryEscape(query), nil, "").want(t, 200)["items"].([]any); len(theirs) != 0 {
			t.Fatalf("cross-account image match: %v", theirs)
		}
	}
	owner.do("PATCH", "/collections/"+first.id, map[string]any{"base_content_version": 3, "attachment_ids": []string{secondID}}, "").want(t, 200)
	if removed := imageExtractions(t, owner, first.id); len(removed) != 0 {
		t.Fatalf("removed attachment still visible: %v", removed)
	}
	if results := owner.do("GET", "/search?q="+url.QueryEscape("灯塔"), nil, "").want(t, 200)["items"].([]any); len(results) != 0 || calls.Load() != 1 {
		t.Fatalf("removed evidence still searchable or another charge occurred: %v, %d calls", results, calls.Load())
	}
}

func TestImageAnalysisDoesNotResendAfterDispatch(t *testing.T) {
	app, base := testBackend(t)
	app.Config.ImageAnalysisEnabled = true
	owner := imageTestAccount(t, app, base, "accounting")
	objects, _, storage := newUploadStorageFixture(t)
	app.Assets = storage
	enableImageTestAccount(owner)
	setImageTestBudget(owner, 1, 30000, 30000)

	excluded := saveImageCollection(t, app, owner, objects)
	owner.do("PUT", "/collections/"+excluded.id+"/ai-exclusion", map[string]any{"excluded": true}, "").want(t, 200)
	owner.do("PUT", "/collections/"+excluded.id+"/ai-exclusion", map[string]any{"excluded": false}, "").want(t, 200)
	revoked := saveImageCollection(t, app, owner, objects)
	owner.do("PUT", "/me/image-analysis", map[string]any{"enabled": false}, "").want(t, 200)
	enableImageTestAccount(owner)
	removed := saveImageCollection(t, app, owner, objects)
	owner.do("PATCH", "/collections/"+removed.id, map[string]any{"base_content_version": 1, "attachment_ids": []string{}}, "").want(t, 200)
	trashed := saveImageCollection(t, app, owner, objects)
	owner.do("DELETE", "/collections/"+trashed.id, map[string]any{"base_resource_version": 1}, "").want(t, 200)
	owner.do("POST", "/collections/"+trashed.id+"/restore", map[string]any{"base_resource_version": 2}, "").want(t, 200)

	var calls atomic.Int32
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verifyImageModelRequest(t, r)
		switch calls.Add(1) {
		case 1:
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
		case 2:
			modelReply(w, "stop", `{"text":"计量缺失","description":"合成图片"}`, nil)
		case 3:
			modelReply(w, "length", `{"text":"已取得的行","description":"未闭合`, map[string]int{"prompt_tokens": 1024, "completion_tokens": 512})
		default:
			modelReply(w, "stop", `{"text":"供应商超界","description":"合成图片"}`, map[string]int{"prompt_tokens": 1537, "completion_tokens": 30})
		}
	}))
	t.Cleanup(model.Close)
	startImageTestWorker(t, app, storage, model.URL)
	for _, entry := range []imageCollection{excluded, revoked, trashed} {
		waitForImageStatus(t, owner, entry.id, "skipped")
	}

	disconnected := saveImageCollection(t, app, owner, objects)
	lost := waitForImageStatus(t, owner, disconnected.id, "failed")
	dupe, err := app.Organizer.Queue.Insert(t.Context(), imageAnalysisArgs{
		UserID: disconnected.userID, CollectionID: disconnected.id, ExtractionID: lost["id"].(string),
	}, &river.InsertOpts{Queue: imageAnalysisQueue, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	waitImageTest(t, "duplicate River delivery", func() bool {
		job, err := app.Organizer.Queue.JobGet(t.Context(), dupe.Job.ID)
		return err == nil && job.State == rivertype.JobStateCompleted
	})
	missing := saveImageCollection(t, app, owner, objects)
	if result := waitForImageStatus(t, owner, missing.id, "partial"); result["error_code"] != "usage_uncertain" {
		t.Fatalf("missing usage was treated as settled: %v", result)
	}
	capped := saveImageCollection(t, app, owner, objects)
	result := waitForImageStatus(t, owner, capped.id, "partial")
	if result["truncated"] != true || result["text"] != "已取得的行" || result["image_description"] != nil {
		t.Fatalf("incorrect handling of truncated output: %v", result)
	}
	if usage := owner.do("GET", "/me/usage", nil, "").want(t, 200); usage["reserved_units"] != float64(14336) || usage["settled_units"] != float64(6144) || calls.Load() != 3 {
		t.Fatalf("unexpected usage or repeated calls: %v, %d calls", usage, calls.Load())
	}

	// The reservations reference image work, never a fabricated text run.
	var count int
	if err := app.Pool.QueryRow(t.Context(), `SELECT count(*) FROM usage_reservations u
		JOIN extractions e ON (e.user_id,e.id)=(u.user_id,u.image_extraction_id)
		WHERE u.user_id=$1 AND e.source_kind='image' AND u.run_id IS NULL AND u.state='uncertain'`, disconnected.userID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("incorrect image billing ownership: %d, %v", count, err)
	}
	app.Config.PurgeEnabled = true
	archiveDir := t.TempDir()
	if err := os.Chmod(archiveDir, 0700); err != nil {
		t.Fatal(err)
	}
	archive, err := purgearchive.Open(archiveDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = archive.Close() })
	purge, err := StartPurgeWorker(context.Background(), app.Pool, archive, storage)
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, purge)
	path := "/collections/" + disconnected.id
	owner.do("DELETE", path, map[string]any{"base_resource_version": 1}, "").want(t, 200)
	owner.do("POST", path+"/purge", map[string]any{"base_resource_version": 2}, uuid.NewString()).want(t, 202)
	waitImageTest(t, "physical purge of image evidence", func() bool {
		var detached int
		err := app.Pool.QueryRow(t.Context(), `SELECT count(*) FROM usage_reservations
			WHERE user_id=$1 AND image_extraction_id IS NULL AND run_id IS NULL AND state='uncertain'`,
			disconnected.userID).Scan(&detached)
		return err == nil && detached == 1
	})
	if usage := owner.do("GET", "/me/usage", nil, "").want(t, 200); usage["reserved_units"] != float64(14336) {
		t.Fatalf("deletion lost an uncertain external charge: %v", usage)
	}
	setImageTestBudget(owner, 2, 40000, 40000)
	overLimit := saveImageCollection(t, app, owner, objects)
	if row := waitForImageStatus(t, owner, overLimit.id, "failed"); row["error_code"] != "image_token_limit" {
		t.Fatalf("provider usage exceeded the approved limit without a hold: %v", row)
	}
	next := saveImageCollection(t, app, owner, objects)
	if row := waitForImageStatus(t, owner, next.id, "blocked"); row["error_code"] != "image_token_limit" || calls.Load() != 4 {
		t.Fatalf("provider limit mismatch did not suspend new calls: %v, %d calls", row, calls.Load())
	}
}

type imageCollection struct {
	id, userID, attachmentID string
}

func imageTestAccount(t *testing.T, app *Server, base, name string) *apiClient {
	t.Helper()
	email := name + "@images.example.test"
	if err := app.BootstrapAdmin(t.Context(), email, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	user := newClient(t, app, base)
	user.signIn(email)
	return user
}

func enableImageTestAccount(user *apiClient) {
	user.do("PUT", "/me/image-analysis", map[string]any{"enabled": true, "consent_version": "deepseek-images-v1"}, "").want(user.t, 200)
}

func setImageTestBudget(user *apiClient, version, platform, account int) {
	user.do("PUT", "/admin/budgets", map[string]any{
		"base_version": version, "platform_daily_units": platform, "user_daily_units": account, "worker_concurrency": 2,
	}, "").want(user.t, 200)
}

func saveImageCollection(t *testing.T, app *Server, user *apiClient, objects *uploadStorageFixture) imageCollection {
	t.Helper()
	account := user.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	upload, id := confirmedImageTestUpload(t, app, account, objects), uuid.NewString()
	req := collectionInput(id, "合成收藏正文不可外发")
	req["upload_ids"] = []string{upload}
	key := uuid.NewString()
	res := user.do("POST", "/collections", req, key).want(t, 201)
	user.do("POST", "/collections", req, key).want(t, 201)
	return imageCollection{id: id, userID: account, attachmentID: res["attachments"].([]any)[0].(map[string]any)["id"].(string)}
}

func confirmedImageTestUpload(t *testing.T, app *Server, account string, objects *uploadStorageFixture) string {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 3, 3))); err != nil {
		t.Fatal(err)
	}
	return confirmedImageFixtureUpload(t, app, account, objects, buf.Bytes(), "image/png")
}

func confirmedImageFixtureUpload(t *testing.T, app *Server, account string, objects *uploadStorageFixture, data []byte, mime string) string {
	t.Helper()
	upload := uuid.NewString()
	staging, final := app.Assets.Keys(account, upload)
	sum := sha256.Sum256(data)
	objects.mu.Lock()
	objects.objects[final] = data
	objects.mu.Unlock()
	if _, err := app.Pool.Exec(t.Context(), `INSERT INTO uploads(id,user_id,staging_key,final_key,filename,declared_size,actual_size,mime_type,sha256,status,expires_at)
		VALUES($1,$2,$3,$4,'private-name',$5,$5,$6,$7,'ready',now()+interval '20 minutes')`, upload, account, staging, final, len(data), mime, sum[:]); err != nil {
		t.Fatal(err)
	}
	return upload
}

func startImageTestWorker(t *testing.T, app *Server, storage ImageObjectReader, endpoint string) {
	t.Helper()
	t.Setenv("SPARK_IMAGE_ANALYSIS_ENDPOINT", endpoint+"/chat/completions")
	t.Setenv("SPARK_IMAGE_ANALYSIS_KEY_FILE", "")
	model, err := LoadImageModel("development")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(model.Close)
	worker, err := StartImageWorker(context.Background(), app.Pool, storage, model)
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, worker)
}

func stopImageTestWorker(t *testing.T, worker *river.Client[pgx.Tx]) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := worker.StopAndCancel(ctx); err != nil {
			t.Error(err)
		}
	})
}

func waitImageTest(t *testing.T, target string, check func() bool) {
	t.Helper()
	until := time.Now().Add(6 * time.Second)
	for !check() {
		if time.Now().After(until) {
			t.Fatalf("timeout waiting for %s", target)
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func imageExtractions(t *testing.T, user *apiClient, id string) []any {
	t.Helper()
	return user.do("GET", "/collections/"+id+"/extractions", nil, "").want(t, 200)["items"].([]any)
}

func waitForImageStatus(t *testing.T, user *apiClient, id, status string) map[string]any {
	t.Helper()
	var result map[string]any
	waitImageTest(t, "image "+status+" in "+id, func() bool {
		for _, item := range imageExtractions(t, user, id) {
			entry := item.(map[string]any)
			if entry["source_kind"] == "image" && entry["status"] == status {
				result = entry
				return true
			}
		}
		return false
	})
	return result
}

func verifyImageModelRequest(t *testing.T, r *http.Request) {
	t.Helper()
	raw, err := io.ReadAll(r.Body)
	var req struct {
		Model     string            `json:"model"`
		MaxTokens int               `json:"max_tokens"`
		Thinking  map[string]string `json:"thinking"`
		Messages  []struct {
			Content []imagePart `json:"content"`
		} `json:"messages"`
	}
	if err != nil || json.Unmarshal(raw, &req) != nil || req.Model != "deepseek-flash" ||
		req.MaxTokens != 512 || req.Thinking["type"] != "disabled" || r.URL.Path != "/chat/completions" ||
		len(req.Messages) != 1 || len(req.Messages[0].Content) != 2 ||
		strings.Contains(string(raw), "private-name") || strings.Contains(string(raw), "合成收藏正文") {
		t.Errorf("invalid image-only request to controlled endpoint")
		return
	}
	parts := req.Messages[0].Content
	if parts[0].Type != "text" || parts[1].Type != "image_url" || parts[1].ImageURL == nil {
		t.Error("expected one prompt and one inline image")
		return
	}
	prefix, imageData, ok := strings.Cut(parts[1].ImageURL.URL, ",")
	b, err := base64.StdEncoding.DecodeString(imageData)
	if !ok || prefix != "data:image/png;base64" || err != nil {
		t.Error("image was not sent inline")
		return
	}
	if _, err := png.Decode(bytes.NewReader(b)); err != nil {
		t.Error("model received invalid PNG")
	}
}

func modelReply(w http.ResponseWriter, finish, content string, usage map[string]int) {
	out := map[string]any{"choices": []any{map[string]any{"finish_reason": finish, "message": map[string]any{"content": content}}}}
	if usage != nil {
		out["usage"] = usage
	}
	_ = json.NewEncoder(w).Encode(out)
}
