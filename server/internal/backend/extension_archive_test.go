package backend

import (
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestExtensionCaptureArchivesTitleAndSelection(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	admin := imageTestAccount(t, app, base, "extension-archive-budget")
	setImageTestBudget(admin, 1, 5_000_000, 5_000_000)
	owner := signedExportAccount(t, app, base, "extension-archive")
	ext := newClient(t, app, base)
	headers := extensionHeaders(t, exchangeTestExtension(ext, approveTestExtension(t, owner)))
	owner.do("PATCH", "/me/preferences", map[string]any{
		"ai_enabled": true, "consent_version": "spark-ai-extension-archive-v1",
	}, "").want(t, 200)
	project := projectForNote(t, owner.apiClient, "花园滴灌")
	var calls atomic.Int32
	startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		input := readImageTextRequest(t, r)
		sourceID := "page_title"
		for _, source := range input.Sources {
			if strings.Contains(source.Text, "SYNTHETIC_SESSION_URL") {
				t.Error("session URL reached the model")
			}
			if source.ID == "original_text" && strings.Contains(source.Text, "花园滴灌") {
				sourceID = "original_text"
			}
		}
		result := map[string]any{
			"title": "合成笔记", "tag_candidates": []any{},
			"project_candidates": []modelProject{{ID: project, Reason: "材料记录花园滴灌", Confidence: .95,
				Evidence: []modelEvidence{{SourceID: sourceID, Quote: "花园滴灌"}}}},
		}
		modelReply(w, "stop", string(jsonBytes(result)), map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	for _, scenario := range []struct{ name, title, selection string }{
		{"title only", "花园滴灌记录", ""},
		{"selected text", "合成网页", "花园滴灌的维护记录 https://example.test/session/SYNTHETIC_SESSION_URL"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			id := uuid.NewString()
			ext.withHeaders("POST", "/extension/collections", map[string]any{
				"id": id, "manual_title": scenario.title, "selected_text": scenario.selection,
				"original_url": "https://example.test/private?session=SYNTHETIC_SESSION_URL", "project_ids": []string{},
			}, uuid.NewString(), headers).want(t, 201)
			row := waitOrganization(t, owner.apiClient, id, "succeeded", "skipped", "failed", "partial", "blocked")
			org := row["organization"].(map[string]any)
			projects := row["projects"].([]any)
			if org["status"] != "succeeded" || len(projects) != 1 || projects[0].(map[string]any)["decision"] != "auto" ||
				projects[0].(map[string]any)["project_id"] != project {
				t.Fatalf("extension capture did not archive: status=%v code=%v projects=%v", org["status"], org["error_code"], projects)
			}
			filtered := owner.do("GET", "/collections?project_id="+project, nil, "").want(t, 200)["items"].([]any)
			found := false
			for _, item := range filtered {
				found = found || item.(map[string]any)["id"] == id
			}
			if !found {
				t.Fatal("auto-archived collection missing from the project")
			}
		})
	}
	if calls.Load() != 2 {
		t.Errorf("two inputs should make two calls, got %d", calls.Load())
	}
}

func TestWebArchiveUsesExplicitConsentAndRecoversOneLegacyCollection(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	admin := imageTestAccount(t, app, base, "web-archive-budget")
	setImageTestBudget(admin, 1, 5_000_000, 5_000_000)
	owner := signedExportAccount(t, app, base, "web-archive-owner")
	other := signedExportAccount(t, app, base, "web-archive-other")
	ext := newClient(t, app, base)
	headers := extensionHeaders(t, exchangeTestExtension(ext, approveTestExtension(t, owner)))
	consent := func(version string) {
		t.Helper()
		owner.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": version}, "").want(t, 200)
	}
	consent(textImageNotesConsentVersion)
	existing := projectForNote(t, owner.apiClient, "温室供水")
	var calls atomic.Int32
	startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		input := readImageTextRequest(t, r)
		result := map[string]any{"title": "合成笔记", "tag_candidates": []any{}, "project_candidates": []any{}}
		for _, source := range input.Sources {
			if strings.Contains(source.Text, "SYNTHETIC_SESSION_URL") || strings.HasPrefix(source.ID, "image_") {
				t.Error("unapproved material reached controlled model")
			}
			switch {
			case source.ID == "original_text" && source.Text == "温室供水记录":
				result["project_candidates"] = []modelProject{{ID: existing, Reason: "供水记录", Confidence: .99,
					Evidence: []modelEvidence{{SourceID: source.ID, Quote: "温室供水"}}}}
			case source.ID == "page_title" && strings.Contains(source.Text, "园艺养护"):
				result["topic_candidate"] = modelTopic{Name: "园艺养护", Reason: "标题", Evidence: []modelEvidence{{SourceID: source.ID, Quote: "园艺养护"}}}
			default:
			}
		}
		modelReply(w, "stop", string(jsonBytes(result)), map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	saveExtension := func(title, selected string, projectIDs ...string) string {
		t.Helper()
		if projectIDs == nil {
			projectIDs = []string{}
		}
		id := uuid.NewString()
		ext.withHeaders("POST", "/extension/collections", map[string]any{
			"id": id, "manual_title": title, "selected_text": selected, "project_ids": projectIDs,
			"original_url": "https://example.test/private?session=SYNTHETIC_SESSION_URL",
		}, uuid.NewString(), headers).want(t, 201)
		return id
	}
	archivePath := func(id string) string { return "/collections/" + id + "/organization/web-archive" }
	oldTitle := saveExtension("园艺养护旧记录", "")
	org := owner.do("GET", "/collections/"+oldTitle+"/organization", nil, "").want(t, 200)
	if org["web_archive_status"] != "consent_required" || org["run_id"] != nil {
		t.Fatal("existing consent allowed the extension title to be sent")
	}
	extensionError(t, owner.do("POST", archivePath(oldTitle), nil, uuid.NewString()), 403, "web_archive_consent_required")
	oldText := saveExtension("未授权标题", "温室供水记录")
	ordinary := waitOrganization(t, owner.apiClient, oldText, "succeeded")
	if projects := ordinary["projects"].([]any); len(projects) != 1 || projects[0].(map[string]any)["decision"] != "suggested" {
		t.Fatal("legacy consent changed ordinary suggestions")
	}
	legacy := uuid.NewString()
	input := collectionInput(legacy, " ")
	input["intent"] = ""
	input["original_url"] = "https://example.test/legacy?session=SYNTHETIC_SESSION_URL"
	input["manual_title"] = "园艺养护旧资料"
	owner.do("POST", "/collections", input, uuid.NewString()).want(t, 201)
	consent(extensionArchiveConsentVersion)
	for _, id := range []string{oldTitle, legacy} {
		row := owner.do("GET", "/collections/"+id, nil, "").want(t, 200)
		if row["organization"].(map[string]any)["run_id"] != nil || row["web_archive_available"] != true {
			t.Fatal("consent update replayed historical material in the background")
		}
	}
	other.do("POST", archivePath(legacy), nil, uuid.NewString()).want(t, 404)

	var accepted [2]apiResponse
	var group sync.WaitGroup
	for i, key := range []string{uuid.NewString(), uuid.NewString()} {
		group.Go(func() {
			accepted[i] = owner.do("POST", archivePath(legacy), nil, key)
		})
	}
	group.Wait()
	run := accepted[0].want(t, 202)["run_id"]
	if accepted[1].want(t, 202)["run_id"] != run {
		t.Fatal("concurrent archive requests did not share a run")
	}
	row := waitOrganization(t, owner.apiClient, legacy, "succeeded")
	first := row["projects"].([]any)[0].(map[string]any)["project_id"]
	if row["capture_source"] != nil || row["organization"].(map[string]any)["web_archive_status"] != "created" {
		t.Fatal("explicit recovery changed provenance or failed to create the grounded topic")
	}
	if retry := owner.do("POST", archivePath(legacy), nil, uuid.NewString()).want(t, 202); retry["run_id"] != run {
		t.Fatal("same material opened a duplicate model run")
	}
	owner.do("POST", archivePath(oldTitle), nil, uuid.NewString()).want(t, 202)
	row = waitOrganization(t, owner.apiClient, oldTitle, "succeeded")
	if row["projects"].([]any)[0].(map[string]any)["project_id"] != first ||
		row["organization"].(map[string]any)["web_archive_status"] != "linked" {
		t.Fatal("verified old capture did not reuse the topic")
	}

	pureURL := saveExtension("", "")
	row = owner.do("GET", "/collections/"+pureURL, nil, "").want(t, 200)
	org = row["organization"].(map[string]any)
	if org["run_id"] != nil || org["error_code"] != "insufficient_material" || row["web_archive_available"] == true {
		t.Fatal("pure URL should expose a no-material result with no queued run")
	}
	extensionError(t, owner.do("POST", archivePath(pureURL), nil, uuid.NewString()), 422, "insufficient_material")
	unmatched := saveExtension("普通页面", "")
	row = waitOrganization(t, owner.apiClient, unmatched, "succeeded")
	if len(row["projects"].([]any)) != 0 || row["organization"].(map[string]any)["web_archive_status"] != "no_match" {
		t.Fatal("unsubstantiated material was archived")
	}
	manual := saveExtension("园艺养护预览", "", existing)
	row = waitOrganization(t, owner.apiClient, manual, "succeeded")
	if p := row["projects"].([]any); len(p) != 1 || p[0].(map[string]any)["decision"] != "manual" ||
		p[0].(map[string]any)["project_id"] != existing || row["organization"].(map[string]any)["web_archive_status"] != nil {
		t.Fatal("automatic topic overrode or misreported a manual project")
	}
	if calls.Load() != 5 {
		t.Fatalf("want 5 eligible one-shot requests, got %d", calls.Load())
	}
}

func TestWebArchiveRetryRequiresANewKeyAndNoPriorDispatch(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	admin := imageTestAccount(t, app, base, "web-archive-retry-budget")
	setImageTestBudget(admin, 1, 5_000_000, 5_000_000)
	owner := signedExportAccount(t, app, base, "web-archive-retry")
	owner.do("PATCH", "/me/preferences", map[string]any{
		"ai_enabled": true, "consent_version": extensionArchiveConsentVersion,
	}, "").want(t, 200)

	id := uuid.NewString()
	note := collectionInput(id, " ")
	note["intent"] = ""
	note["original_url"] = "https://example.test/queue"
	note["manual_title"] = "石桥维修日志"
	owner.do("POST", "/collections", note, uuid.NewString()).want(t, 201)
	path, key := "/collections/"+id+"/organization/web-archive", uuid.NewString()
	restart := func(key string) apiResponse { return owner.do("POST", path, nil, key) }

	run := restart(key).want(t, 202)["run_id"].(string)
	ageImageOrganizationRun(t, app, owner.uid, run, "11 minutes")
	var calls atomic.Int32
	startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		readImageTextRequest(t, r)
		modelReply(w, "stop", `{"title":"石桥维修日志","tag_candidates":[],"project_candidates":[]}`,
			map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	expired := waitOrganization(t, owner.apiClient, id, "failed")["organization"].(map[string]any)
	if expired["error_code"] != "queue_expired" || calls.Load() != 0 {
		t.Fatal("the expired fixture did not stop before dispatch")
	}
	sameKey := restart(key)
	if sameKey.want(t, 202)["run_id"] != run || sameKey.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("same key did not replay the original receipt")
	}
	setImageTestBudget(admin, 2, 0, 0)
	extensionError(t, restart(uuid.NewString()), 429, "quota_exceeded")
	setImageTestBudget(admin, 3, 5_000_000, 5_000_000)
	if fresh := restart(uuid.NewString()).want(t, 202)["run_id"]; fresh == run {
		t.Fatal("fresh key could not recover an expired, never-dispatched archive")
	}
	if expired["web_archive_retry_available"] != true {
		t.Fatal("expired no-charge run did not expose its retry affordance")
	}
	after := waitOrganization(t, owner.apiClient, id, "succeeded")["organization"].(map[string]any)
	if reply := restart(uuid.NewString()).want(t, 202); reply["run_id"] != after["run_id"] || calls.Load() != 1 {
		t.Fatal("completed archive was dispatched again")
	}
}

func TestWebArchiveDiscardsInFlightResultAfterConsentWithdrawal(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	admin := imageTestAccount(t, app, base, "web-archive-withdraw-budget")
	setImageTestBudget(admin, 1, 5_000_000, 5_000_000)
	owner := signedExportAccount(t, app, base, "web-archive-withdraw")
	ext := newClient(t, app, base)
	headers := extensionHeaders(t, exchangeTestExtension(ext, approveTestExtension(t, owner)))
	owner.do("PATCH", "/me/preferences", map[string]any{
		"ai_enabled": true, "consent_version": extensionArchiveConsentVersion,
	}, "").want(t, 200)

	entered, release := make(chan struct{}, 1), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()
	var calls atomic.Int32
	startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		readImageTextRequest(t, r)
		entered <- struct{}{}
		<-release
		modelReply(w, "stop", `{"title":"设备维护","tag_candidates":[],"project_candidates":[],"topic_candidate":{"name":"设备维护","reason":"维护记录","evidence":[{"source_id":"page_title","quote":"设备维护"}]}}`,
			map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	id := uuid.NewString()
	ext.withHeaders("POST", "/extension/collections", map[string]any{
		"id": id, "manual_title": "设备维护记录", "original_url": "https://example.test/pending", "project_ids": []string{},
	}, uuid.NewString(), headers).want(t, 201)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("no controlled request reached the provider")
	}
	owner.do("PATCH", "/me/preferences", map[string]any{
		"ai_enabled": true, "consent_version": textImageTagsConsentVersion,
	}, "").want(t, 200)
	unblock()
	row := waitOrganization(t, owner.apiClient, id, "superseded")
	if len(row["projects"].([]any)) != 0 || len(owner.do("GET", "/projects", nil, "").want(t, 200)["items"].([]any)) != 0 || calls.Load() != 1 {
		t.Fatal("a withdrawn policy wrote the in-flight archive or triggered another call")
	}
	owner.do("PATCH", "/me/preferences", map[string]any{
		"ai_enabled": true, "consent_version": extensionArchiveConsentVersion,
	}, "").want(t, 200)
	if reply := owner.do("POST", "/collections/"+id+"/organization/web-archive", nil, uuid.NewString()).want(t, 202); reply["run_id"] != row["organization"].(map[string]any)["run_id"] || calls.Load() != 1 {
		t.Fatal("reauthorizing the same material repeated an already charged dispatch")
	}
}
