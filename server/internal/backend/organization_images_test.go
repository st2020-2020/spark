package backend

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/db"
)

func setupImageOrganization(t *testing.T, app *Server, base string) (*apiClient, string, *uploadStorageFixture, ImageObjectReader) {
	t.Helper()
	owner := imageTestAccount(t, app, base, "image-organization")
	uid := owner.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	app.Config.ImageAnalysisEnabled = true
	app.Config.ImageAdminID = uid
	app.Organizer.Enabled = true
	app.Organizer.Images = ImageOrganizationScope{Enabled: true, AdminID: uid}
	objects, _, storage := newUploadStorageFixture(t)
	app.Assets = storage
	setImageTestBudget(owner, 1, 5_000_000, 5_000_000)
	enableImageTestAccount(owner)
	return owner, uid, objects, storage
}

func saveOrganizationImage(t *testing.T, app *Server, user *apiClient, uid string, objects *uploadStorageFixture, text string) map[string]any {
	t.Helper()
	body := collectionInput(uuid.NewString(), text)
	if text == "" {
		body["document"] = map[string]any{"schema_version": 1, "content": map[string]any{
			"type": "doc", "content": []any{map[string]any{"type": "paragraph"}},
		}}
	}
	body["intent"] = ""
	body["upload_ids"] = []string{confirmedImageTestUpload(t, app, uid, objects)}
	return user.do("POST", "/collections", body, uuid.NewString()).want(t, 201)
}

func startImageTextOrganization(t *testing.T, app *Server, handler http.HandlerFunc) {
	t.Helper()
	provider := httptest.NewServer(handler)
	t.Cleanup(provider.Close)
	client := NewTextClient()
	t.Cleanup(client.Close)
	cfg := AIConfig{Version: "image-text-test", MaxAttempts: 1, TimeoutSeconds: 8, MaxInputChars: 1000, Images: app.Organizer.Images,
		Routes: []AIRoute{{Name: "text", Endpoint: provider.URL + "/chat/completions", Model: "synthetic-text",
			OutputMode: "json_object", MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 1_000_000, OutputPrice: 2_000_000}}}
	worker, err := StartTextWorker(t.Context(), app.Pool, cfg, app.Organizer.Trial, client)
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, worker)
}

func readImageTextRequest(t *testing.T, r *http.Request) textInput {
	t.Helper()
	var body struct{ Messages []struct{ Content string } }
	var input textInput
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Messages) != 2 {
		t.Error("invalid text provider request")
		return input
	}
	content := body.Messages[1].Content
	if err := json.Unmarshal([]byte(content), &input); err != nil ||
		strings.Contains(content, "data:image/") || strings.Contains(content, "private-name") {
		t.Error("invalid or over-broad input sent to text provider")
	}
	return input
}

func ageImageOrganizationRun(t *testing.T, app *Server, uid, run, age string) {
	t.Helper()
	if _, err := app.Pool.Exec(t.Context(), `UPDATE organization_runs SET created_at=now()-$3::interval WHERE user_id=$1 AND id=$2`, uid, run, age); err != nil {
		t.Fatal(err)
	}
}

func imageOrganizationUsage(t *testing.T, app *Server, uid, run, attachment string) (text, image int) {
	t.Helper()
	err := app.Pool.QueryRow(t.Context(), `SELECT
		count(*) FILTER (WHERE r.run_id=$2 AND r.state='settled'),
		count(*) FILTER (WHERE e.attachment_id=$3 AND r.state='settled')
		FROM usage_reservations r LEFT JOIN extractions e ON (e.user_id,e.id)=(r.user_id,r.image_extraction_id)
		WHERE r.user_id=$1`, uid, run, attachment).Scan(&text, &image)
	if err != nil {
		t.Fatal(err)
	}
	return text, image
}

func TestOrganizationWithDelayedImageMaterialUsesOneRun(t *testing.T) {
	t.Run("image only", func(t *testing.T) {
		testDelayedImageOrganizationRun(t, "")
	})
	t.Run("short title and image", func(t *testing.T) {
		testDelayedImageOrganizationRun(t, "一行短标题")
	})
}

func testDelayedImageOrganizationRun(t *testing.T, original string) {
	t.Helper()
	app, base := testBackend(t)
	owner, uid, objects, storage := setupImageOrganization(t, app, base)
	other := imageTestAccount(t, app, base, "foreign-image-organization")
	prefs := owner.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": textImageConsentVersion}, "").want(t, 200)
	if prefs["ai_consent_version"] != textImageConsentVersion ||
		owner.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["ai_consent_version"] != textImageConsentVersion {
		t.Fatal("new consent version missing from account readback")
	}
	project := owner.do("POST", "/projects", map[string]any{"name": "航标清单", "description": "合成航标资料", "focus_points": []string{"航海图"}}, uuid.NewString()).want(t, 201)
	saved := saveOrganizationImage(t, app, owner, uid, objects, original)
	path, id := "/collections/"+saved["id"].(string), saved["id"].(string)
	attachment := saved["attachments"].([]any)[0].(map[string]any)["id"].(string)
	run := saved["organization"].(map[string]any)["run_id"].(string)
	if saved["organization"].(map[string]any)["image_material_status"] != "waiting" {
		t.Fatalf("save did not expose waiting: %v", saved["organization"])
	}
	ageImageOrganizationRun(t, app, uid, run, "5 minutes")
	other.do("GET", path, nil, "").want(t, 404)
	other.do("POST", path+"/organization", nil, uuid.NewString()).want(t, 404)

	var textCalls, imageCalls atomic.Int32
	startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
		textCalls.Add(1)
		input := readImageTextRequest(t, r)
		sources := map[string]string{}
		for _, source := range input.Sources {
			sources[source.ID] = source.Text
		}
		textSource, descriptionSource := "image_text:"+attachment, "image_description:"+attachment
		if sources["original_text"] != original || sources[textSource] != "合成航标编号十二" ||
			sources[descriptionSource] != "蓝色航海图" || len(input.Projects) != 1 || input.Projects[0].ID != project["id"] {
			t.Errorf("text model did not receive exactly the expected materials: %v", sources)
		}
		result := map[string]any{"title": "航标清单", "tag_candidates": []any{}, "project_candidates": []any{map[string]any{
			"project_id": project["id"], "reason": "与航标项目相符", "confidence": 0.85, "evidence": []any{
				map[string]any{"source_id": textSource, "quote": "航标编号十二"},
				map[string]any{"source_id": descriptionSource, "quote": "航海图"},
			},
		}}}
		modelReply(w, "stop", string(jsonBytes(result)), map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	waitImageTest(t, "text job snoozed while image is queued", func() bool {
		var scheduled bool
		table := pgx.Identifier{db.RiverSchema(app.Pool), "river_job"}.Sanitize()
		err := app.Pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM `+table+`
			WHERE kind='spark_text_organization' AND args->>'run_id'=$1 AND scheduled_at>now())`, run).Scan(&scheduled)
		if err != nil {
			t.Fatal(err)
		}
		return scheduled
	})
	key := uuid.NewString()
	for _, requestKey := range []string{key, key, uuid.NewString()} {
		if reply := owner.do("POST", path+"/organization", nil, requestKey).want(t, 202); reply["run_id"] != run {
			t.Fatal("manual organization duplicated the active run")
		}
	}
	var reservations int
	if err := app.Pool.QueryRow(t.Context(), "SELECT count(*) FROM usage_reservations WHERE run_id=$1", run).Scan(&reservations); err != nil || reservations != 0 || textCalls.Load() != 0 {
		t.Fatalf("waiting dispatched or reserved text usage: %d reservations, %d calls, %v", reservations, textCalls.Load(), err)
	}
	image := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		imageCalls.Add(1)
		verifyImageModelRequest(t, r)
		modelReply(w, "stop", `{"text":"合成航标编号十二","description":"蓝色航海图"}`, map[string]int{"prompt_tokens": 300, "completion_tokens": 60})
	}))
	t.Cleanup(image.Close)
	startImageTestWorker(t, app, storage, image.URL)
	row := waitOrganization(t, owner, id, "succeeded")
	org := row["organization"].(map[string]any)
	if org["run_id"] != run || org["image_material_status"] != "included" ||
		string(jsonBytes(row["document"])) != string(jsonBytes(saved["document"])) {
		t.Fatalf("same run did not include the image or changed original content: %v", org)
	}
	projects := row["projects"].([]any)
	if len(projects) != 1 {
		t.Fatalf("expected one suggestion: %v", projects)
	}
	suggestion := projects[0].(map[string]any)
	expected := []any{
		map[string]any{"source_id": "image_text:" + attachment, "quote": "航标编号十二"},
		map[string]any{"source_id": "image_description:" + attachment, "quote": "航海图"},
	}
	if suggestion["decision"] != "suggested" || string(jsonBytes(suggestion["evidence"])) != string(jsonBytes(expected)) {
		t.Fatalf("unexpected suggestion evidence: %v", suggestion)
	}
	owner.do("POST", path+"/organization", nil, key).want(t, 202)
	if text, image := imageOrganizationUsage(t, app, uid, run, attachment); text != 1 || image != 1 || textCalls.Load() != 1 || imageCalls.Load() != 1 {
		t.Fatalf("unexpected text/image billing: %d/%d settlements, %d/%d model calls", text, image, textCalls.Load(), imageCalls.Load())
	}
	owner.do("PUT", "/me/image-analysis", map[string]any{"enabled": false}, "").want(t, 200)
	after := owner.do("GET", path, nil, "").want(t, 200)
	if after["organization"].(map[string]any)["image_material_status"] == "included" || after["has_suggestion"] != false {
		t.Fatalf("withdrawn image material still drives a pending suggestion: %v", after["organization"])
	}
}

func TestOrganizationWithHistoricalImageAndTerminalPaths(t *testing.T) {
	app, base := testBackend(t)
	owner, uid, objects, storage := setupImageOrganization(t, app, base)
	owner.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": textTagConsentVersion}, "").want(t, 200)
	history := saveOrganizationImage(t, app, owner, uid, objects, "")
	id := history["id"].(string)
	path := "/collections/" + id
	attachment := history["attachments"].([]any)[0].(map[string]any)["id"].(string)
	if history["organization"].(map[string]any)["image_material_status"] != "consent_required" {
		t.Fatal("legacy text consent did not report the new material requirement")
	}
	owner.do("POST", path+"/organization", nil, uuid.NewString()).want(t, 403)
	var imageCalls, textCalls atomic.Int32
	var failImage atomic.Bool
	allowLateImage := make(chan struct{})
	releaseImage := sync.OnceFunc(func() { close(allowLateImage) })
	defer releaseImage()
	image := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if imageCalls.Add(1) == 2 {
			<-allowLateImage
		}
		response := `{"text":"识别出的旧图片文字","description":"合成储物柜照片"}`
		if failImage.Load() {
			response = "invalid provider result"
		}
		modelReply(w, "stop", response, map[string]int{"prompt_tokens": 300, "completion_tokens": 60})
	}))
	t.Cleanup(image.Close)
	// Make a current collection version with the same immutable attachment.
	owner.do("PATCH", path, map[string]any{"base_content_version": 1, "manual_title": "保留人工标题"}, "").want(t, 200)
	startOrganizationListener(t, app)
	frames := openOrganizationStream(t, owner, base)
	expectReady(t, frames)
	startImageTestWorker(t, app, storage, image.URL)
	for {
		frame := nextOrganizationFrame(t, frames, 4*time.Second)
		if frame.name != "organization" || !strings.Contains(frame.data, id) {
			t.Fatalf("unexpected image change frame: %+v", frame)
		}
		var done bool
		for _, item := range imageExtractions(t, owner, id) {
			done = done || item.(map[string]any)["status"] == "succeeded"
		}
		if done {
			break
		}
	}
	owner.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": textImageConsentVersion}, "").want(t, 200)

	timeout := saveOrganizationImage(t, app, owner, uid, objects, "")
	timeoutID := timeout["id"].(string)
	timeoutRun := timeout["organization"].(map[string]any)["run_id"].(string)
	timeoutAttachment := timeout["attachments"].([]any)[0].(map[string]any)["id"].(string)
	ageImageOrganizationRun(t, app, uid, timeoutRun, "11 minutes")

	entered, resume := make(chan struct{}, 1), make(chan struct{})
	release := sync.OnceFunc(func() { close(resume) })
	defer release()
	var holdText atomic.Bool
	startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
		textCalls.Add(1)
		input := readImageTextRequest(t, r)
		if holdText.Load() {
			entered <- struct{}{}
			<-resume
		} else {
			found := false
			for _, source := range input.Sources {
				found = found || (source.ID == "image_text:"+attachment || source.ID == "image_text:"+timeoutAttachment) && source.Text == "识别出的旧图片文字"
			}
			if !found {
				t.Error("historical image material was absent")
			}
		}
		modelReply(w, "stop", `{"title":"模型标题","tag_candidates":[],"project_candidates":[]}`, map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	expired := waitOrganization(t, owner, timeoutID, "failed")["organization"].(map[string]any)
	if expired["error_code"] != "image_material_timeout" || expired["image_material_status"] == "included" || textCalls.Load() != 0 {
		t.Fatalf("expiry hid the missed image material or dispatched early: %v", expired)
	}
	releaseImage()
	waitForImageStatus(t, owner, timeoutID, "succeeded")
	reply := owner.do("POST", "/collections/"+timeoutID+"/organization", nil, uuid.NewString()).want(t, 202)
	if timeoutRun == reply["run_id"] ||
		waitOrganization(t, owner, timeoutID, "succeeded")["organization"].(map[string]any)["image_material_status"] != "included" {
		t.Fatal("the timed-out image material was not available to an intentional new run")
	}

	accept := owner.do("POST", path+"/organization", nil, uuid.NewString()).want(t, 202)
	row := waitOrganization(t, owner, id, "succeeded")
	if row["display_title"] != "保留人工标题" || row["has_suggestion"] != false ||
		row["organization"].(map[string]any)["image_material_status"] != "included" || imageCalls.Load() != 2 || textCalls.Load() != 2 {
		t.Fatalf("explicit historical organization did not preserve the manual title/no-match behavior: %v", row["organization"])
	}
	if text, image := imageOrganizationUsage(t, app, uid, accept["run_id"].(string), attachment); text != 1 || image != 1 {
		t.Fatalf("historical use reran recognition or missed settlement: %d/%d", text, image)
	}

	failImage.Store(true)
	failed := saveOrganizationImage(t, app, owner, uid, objects, "")
	failedID := failed["id"].(string)
	waitForImageStatus(t, owner, failedID, "failed")
	org := waitOrganization(t, owner, failedID, "skipped")["organization"].(map[string]any)
	if org["error_code"] != "insufficient_material" || org["image_material_status"] != nil || textCalls.Load() != 2 {
		t.Fatalf("image failure did not end waiting without a text call: %v", org)
	}

	holdText.Store(true)
	restarted := owner.do("POST", path+"/organization", nil, uuid.NewString()).want(t, 202)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not dispatch the already-authorized request")
	}
	owner.do("PUT", "/me/image-analysis", map[string]any{"enabled": false}, "").want(t, 200)
	release()
	revoked := waitOrganization(t, owner, id, "superseded")
	if revoked["organization"].(map[string]any)["image_material_status"] != nil || revoked["display_title"] != "保留人工标题" || textCalls.Load() != 3 {
		t.Fatalf("revoked material applied stale result: %v", revoked["organization"])
	}
	if text, image := imageOrganizationUsage(t, app, uid, restarted["run_id"].(string), attachment); text != 1 || image != 1 {
		t.Fatalf("an in-flight request was not settled exactly once: %d/%d", text, image)
	}
	owner.do("POST", path+"/organization", nil, uuid.NewString()).want(t, 422)
}
