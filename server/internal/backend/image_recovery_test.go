package backend

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestImageRecoveryReusesOneAuthorizedAttempt(t *testing.T) {
	app, addr := testBackend(t)
	owner := imageTestAccount(t, app, addr, "image-recovery")
	foreign := imageTestAccount(t, app, addr, "foreign-image-recovery")
	uid := owner.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	app.Config.ImageAnalysisEnabled, app.Config.ImageAdminID = true, uid
	objects, _, storage := newUploadStorageFixture(t)
	app.Assets = storage
	enableImageTestAccount(owner)
	setImageTestBudget(owner, 1, 1_000_000, 1_000_000)

	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verifyImageModelRequest(t, r)
		if calls.Add(1) == 1 {
			modelReply(w, "length", `{"text":"密集合成蓝图里的未闭合值`, map[string]int{"prompt_tokens": 200, "completion_tokens": 512})
			return
		}
		modelReply(w, "stop", `{"description":"供水管线设计图","text":"二号供水阀A17"}`, map[string]int{"prompt_tokens": 200, "completion_tokens": 30})
	}))
	t.Cleanup(provider.Close)
	startImageTestWorker(t, app, storage, provider.URL)
	collection := saveImageCollection(t, app, owner, objects)
	old := waitForImageStatus(t, owner, collection.id, "failed")
	if old["error_code"] != "image_output_truncated_empty" || old["truncated"] != true || old["image_retry_available"] != true {
		t.Fatalf("new empty truncation is not recoverable: %v", old)
	}
	baseID := old["id"].(string)
	// Reuse the same metered job to represent the v0.6.1 state on upgrade.
	if _, err := app.Pool.Exec(t.Context(), `UPDATE extractions SET status='partial',error_code='image_output_truncated'
		WHERE user_id=$1 AND id=$2`, uid, baseID); err != nil {
		t.Fatal(err)
	}
	imageList := imageExtractions(t, owner, collection.id)
	if len(imageList) != 1 || imageList[0].(map[string]any)["image_retry_available"] != true {
		t.Fatal("legacy empty truncation was not offered recovery")
	}
	body := map[string]any{"base_extraction_id": baseID, "consent_version": "deepseek-image-retry-v1"}
	path := "/attachments/" + collection.attachmentID + "/image-analysis/retry"
	foreign.do("POST", path, body, uuid.NewString()).want(t, 404)
	owner.do("POST", path, map[string]any{"base_extraction_id": uuid.NewString(), "consent_version": body["consent_version"]}, uuid.NewString()).want(t, 409)
	owner.do("POST", path, map[string]any{"base_extraction_id": baseID}, uuid.NewString()).want(t, 422)
	owner.do("PUT", "/me/image-analysis", map[string]any{"enabled": false}, "").want(t, 200)
	owner.do("POST", path, body, uuid.NewString()).want(t, 403)
	enableImageTestAccount(owner)
	exclusion := "/collections/" + collection.id + "/ai-exclusion"
	owner.do("PUT", exclusion, map[string]any{"excluded": true}, "").want(t, 200)
	if got := owner.do("POST", path, body, uuid.NewString()).want(t, 403); got["error"].(map[string]any)["code"] != "ai_excluded" {
		t.Fatal("excluded collection was eligible for reprocessing")
	}
	owner.do("PUT", exclusion, map[string]any{"excluded": false}, "").want(t, 200)

	setImageTestBudget(owner, 2, 7_167, 7_167)
	owner.do("POST", path, body, uuid.NewString()).want(t, 429)
	if calls.Load() != 1 || len(imageExtractions(t, owner, collection.id)) != 1 {
		t.Fatal("rejecting the recovery had side effects")
	}
	setImageTestBudget(owner, 3, 1_000_000, 1_000_000)

	key := uuid.NewString()
	results := make(chan apiResponse, 2)
	for _, requestKey := range []string{key, uuid.NewString()} {
		go func() { results <- owner.do("POST", path, body, requestKey) }()
	}
	first := (<-results).want(t, 202)["id"].(string)
	if second := (<-results).want(t, 202)["id"]; first == baseID || second != first {
		t.Fatal("concurrent intents did not share a new recovery job")
	}
	current := waitForImageStatus(t, owner, collection.id, "succeeded")
	if current["id"] != first || current["text"] != "二号供水阀A17" ||
		current["image_description"] != "供水管线设计图" || current["image_retry_available"] == true {
		t.Fatalf("recovery did not expose the expected result: %v", current)
	}
	if items := imageExtractions(t, owner, collection.id); len(items) != 1 {
		t.Fatalf("current read included obsolete image results: %v", items)
	}
	replay := owner.do("POST", path, body, key)
	if replay.want(t, 202)["id"] != first || replay.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("same-key replay lost the current recovery result")
	}
	owner.do("POST", path, map[string]any{"base_extraction_id": first, "consent_version": body["consent_version"]}, key).want(t, 409)
	if duplicate := owner.do("POST", path, body, uuid.NewString()).want(t, 202); duplicate["id"] != first {
		t.Fatal("a new key created another recovery job")
	}
	hits := owner.do("GET", "/search?q=A17", nil, "").want(t, 200)["items"].([]any)
	if len(hits) != 1 {
		t.Fatalf("recovered image was not searchable: %v", hits)
	}
	var oldStatus string
	var oldUnits, recoveryUnits int
	err := app.Pool.QueryRow(t.Context(), `SELECT e.status,
		(SELECT actual_units FROM usage_reservations WHERE user_id=$1 AND image_extraction_id=$2 AND state='settled'),
		(SELECT actual_units FROM usage_reservations WHERE user_id=$1 AND image_extraction_id=$3 AND state='settled')
		FROM extractions e WHERE e.user_id=$1 AND e.id=$2`, uid, baseID, first).Scan(&oldStatus, &oldUnits, &recoveryUnits)
	if err != nil || oldStatus != "partial" || oldUnits != 4496 || recoveryUnits != 640 || calls.Load() != 2 {
		t.Fatalf("original and recovery did not settle separately: %s %d/%d, %d calls, %v", oldStatus, oldUnits, recoveryUnits, calls.Load(), err)
	}
	row := owner.do("GET", "/collections/"+collection.id, nil, "").want(t, 200)
	owner.do("DELETE", "/collections/"+collection.id, map[string]any{"base_resource_version": row["resource_version"]}, "").want(t, 200)
	if got := owner.do("POST", path, body, key).want(t, 409); got["error"].(map[string]any)["code"] != "collection_in_trash" {
		t.Fatal("recovering a trashed attachment must fail")
	}
}

func TestImageRecoveryCanBeRequeuedWhenAnotherJobTakesBudget(t *testing.T) {
	app, addr := testBackend(t)
	owner := imageTestAccount(t, app, addr, "image-recovery-quota")
	uid := owner.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	app.Config.ImageAnalysisEnabled = true
	objects, _, storage := newUploadStorageFixture(t)
	app.Assets = storage
	enableImageTestAccount(owner)
	setImageTestBudget(owner, 1, 7_168, 7_168)

	old := saveImageCollection(t, app, owner, objects)
	baseID := waitForImageStatus(t, owner, old.id, "queued")["id"].(string)
	if _, err := app.Pool.Exec(t.Context(), `UPDATE extractions SET status='partial',
		evidence_meta='{"truncated":true}',error_code='image_output_truncated'
		WHERE user_id=$1 AND id=$2`, uid, baseID); err != nil {
		t.Fatal(err)
	}
	var objectKey string
	if err := app.Pool.QueryRow(t.Context(), `SELECT object_key FROM attachments WHERE user_id=$1 AND id=$2`, uid, old.attachmentID).Scan(&objectKey); err != nil {
		t.Fatal(err)
	}
	path := "/attachments/" + old.attachmentID + "/image-analysis/retry"
	body := map[string]any{"base_extraction_id": baseID, "consent_version": "deepseek-image-retry-v1"}
	key := uuid.NewString()
	recovery := owner.do("POST", path, body, key).want(t, 202)
	other := saveImageCollection(t, app, owner, objects)

	competingEntered, releaseCompeting := make(chan struct{}), make(chan struct{})
	readStarted, releaseRead := make(chan struct{}), make(chan struct{})
	allowCompeting := sync.OnceFunc(func() { close(releaseCompeting) })
	allowRead := sync.OnceFunc(func() { close(releaseRead) })
	defer allowCompeting()
	defer allowRead()
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verifyImageModelRequest(t, r)
		if calls.Add(1) == 1 {
			close(competingEntered)
			select {
			case <-releaseCompeting:
			case <-r.Context().Done():
				return
			}
		}
		modelReply(w, "stop", `{"description":"合成水路图","text":"B17"}`, map[string]int{"prompt_tokens": 200, "completion_tokens": 30})
	}))
	t.Cleanup(provider.Close)
	startImageTestWorker(t, app, gatedImageRecoveryRead{storage, objectKey, sync.OnceFunc(func() { close(readStarted) }), releaseRead}, provider.URL)
	for _, entered := range []<-chan struct{}{readStarted, competingEntered} {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("two real River jobs did not reach the controlled race")
		}
	}
	allowRead()
	blocked := waitForImageStatus(t, owner, old.id, "blocked")
	if blocked["id"] != recovery["id"] || blocked["error_code"] != "quota_exceeded" || blocked["image_retry_available"] != true || calls.Load() != 1 {
		t.Fatalf("quota race did not leave one unsent recovery: %v", blocked)
	}
	var entries int
	if err := app.Pool.QueryRow(t.Context(), `SELECT count(*) FROM usage_reservations WHERE user_id=$1 AND image_extraction_id=$2`, uid, recovery["id"]).Scan(&entries); err != nil || entries != 0 {
		t.Fatalf("unsent recovery had ledger entries: %d, %v", entries, err)
	}
	if replay := owner.do("POST", path, body, key).want(t, 202); replay["status"] != "blocked" || replay["id"] != recovery["id"] {
		t.Fatal("original replay requeued or changed the recovery")
	}
	nextBody := map[string]any{"base_extraction_id": recovery["id"], "consent_version": body["consent_version"]}
	owner.do("POST", path, nextBody, uuid.NewString()).want(t, 429)
	allowCompeting()
	waitForImageStatus(t, owner, other.id, "succeeded")
	setImageTestBudget(owner, 2, 20_000, 20_000)

	resumeKey := uuid.NewString()
	resumed := owner.do("POST", path, nextBody, resumeKey).want(t, 202)
	if resumed["id"] != recovery["id"] || resumed["status"] != "queued" {
		t.Fatalf("explicit resubmission did not queue the same recovery: %v", resumed)
	}
	active := waitForImageStatus(t, owner, old.id, "succeeded")
	if active["id"] != recovery["id"] || calls.Load() != 2 {
		t.Fatalf("resubmission did not dispatch exactly once: %v", active)
	}
	if replay := owner.do("POST", path, nextBody, resumeKey).want(t, 202); replay["id"] != active["id"] || replay["status"] != "succeeded" {
		t.Fatal("resubmission replay did not return the finished recovery")
	}
	if err := app.Pool.QueryRow(t.Context(), `SELECT count(*) FROM usage_reservations WHERE user_id=$1 AND image_extraction_id=$2 AND state='settled'`, uid, active["id"]).Scan(&entries); err != nil || entries != 1 {
		t.Fatalf("recovery did not settle once: %d, %v", entries, err)
	}
}

type gatedImageRecoveryRead struct {
	ImageObjectReader
	key     string
	onRead  func()
	release <-chan struct{}
}

func (g gatedImageRecoveryRead) ReadFinal(ctx context.Context, key, version string, size int64) (io.ReadCloser, error) {
	if key == g.key {
		g.onRead()
		select {
		case <-g.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return g.ImageObjectReader.ReadFinal(ctx, key, version, size)
}

func TestImageRecoveryDoesNotResendAfterUncertainDispatch(t *testing.T) {
	app, addr := testBackend(t)
	owner := imageTestAccount(t, app, addr, "image-recovery-uncertain")
	app.Config.ImageAnalysisEnabled = true
	objects, _, storage := newUploadStorageFixture(t)
	app.Assets = storage
	enableImageTestAccount(owner)
	setImageTestBudget(owner, 1, 100_000, 100_000)

	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verifyImageModelRequest(t, r)
		if calls.Add(1) == 1 {
			modelReply(w, "length", `{"text":"未闭合`, map[string]int{"prompt_tokens": 200, "completion_tokens": 512})
			return
		}
		w.Header().Set("Content-Length", "2048")
		_, _ = io.WriteString(w, `{"choices":`)
	}))
	t.Cleanup(provider.Close)
	startImageTestWorker(t, app, storage, provider.URL)
	old := saveImageCollection(t, app, owner, objects)
	base := waitForImageStatus(t, owner, old.id, "failed")
	path := "/attachments/" + old.attachmentID + "/image-analysis/retry"
	body := map[string]any{"base_extraction_id": base["id"], "consent_version": "deepseek-image-retry-v1"}
	key := uuid.NewString()
	recovery := owner.do("POST", path, body, key).want(t, 202)
	failed := waitForImageStatus(t, owner, old.id, "failed")
	if failed["id"] != recovery["id"] || failed["error_code"] != "image_response_read_failed" || failed["image_retry_available"] == true {
		t.Fatalf("interrupted dispatched response was presented as retryable: %v", failed)
	}
	for _, id := range []string{key, uuid.NewString()} {
		if replay := owner.do("POST", path, body, id).want(t, 202); replay["id"] != recovery["id"] || replay["status"] != "failed" {
			t.Fatal("recovering a dispatched failure changed the terminal result")
		}
	}
	body["base_extraction_id"] = recovery["id"]
	owner.do("POST", path, body, uuid.NewString()).want(t, 202)
	usage := owner.do("GET", "/me/usage", nil, "").want(t, 200)
	if usage["reserved_units"] != float64(7168) || usage["settled_units"] != float64(4496) || calls.Load() != 2 {
		t.Fatalf("uncertain attempt was resent or its held budget changed: %v, %d calls", usage, calls.Load())
	}
}
