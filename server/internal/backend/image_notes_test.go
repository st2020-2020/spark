package backend

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func enableImageArchiving(t *testing.T, owner *apiClient) {
	t.Helper()
	reply := owner.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": textImageNotesConsentVersion}, "").want(t, 200)
	if reply["ai_consent_version"] != textImageNotesConsentVersion {
		t.Fatal("auto-archive consent was not accepted")
	}
}

func projectForNote(t *testing.T, user *apiClient, name string) string {
	t.Helper()
	return user.do("POST", "/projects", map[string]any{"name": name, "description": "", "focus_points": []string{}}, uuid.NewString()).want(t, 201)["id"].(string)
}

func topicFromImage(t *testing.T, r *http.Request, name string) map[string]any {
	t.Helper()
	return topicForMaterial(t, readImageTextRequest(t, r), name)
}

func topicForMaterial(t *testing.T, input textInput, name string) map[string]any {
	t.Helper()
	evidence := make([]modelEvidence, 0, 1)
	for _, source := range input.Sources {
		if source.ID == "original_text" && strings.Contains(source.Text, "模型画面说明") {
			t.Error("image description was presented as original text")
		}
		if strings.HasPrefix(source.ID, "image_text:") && source.Text == "合成编号731" {
			evidence = append(evidence, modelEvidence{SourceID: source.ID, Quote: "编号731"})
		}
	}
	if len(evidence) != 1 {
		t.Error("request lacked the recognized exact image material")
	}
	return map[string]any{"title": "合成图片笔记", "tag_candidates": []any{}, "project_candidates": []any{},
		"topic_candidate": map[string]any{"name": name, "reason": "来自图面的编号731", "evidence": evidence},
	}
}

func startNoteImageWorker(t *testing.T, app *Server, storage ImageObjectReader, calls *atomic.Int32, output string) {
	t.Helper()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verifyImageModelRequest(t, r)
		calls.Add(1)
		modelReply(w, "stop", output, map[string]int{"prompt_tokens": 200, "completion_tokens": 30})
	}))
	t.Cleanup(provider.Close)
	startImageTestWorker(t, app, storage, provider.URL)
}

func TestLateImageNoteLinksExistingTopicBeyondModelCandidates(t *testing.T) {
	app, addr := testBackend(t)
	owner, uid, objects, storage := setupImageOrganization(t, app, addr)
	other := imageTestAccount(t, app, addr, "image-note-other")
	enableImageArchiving(t, owner)
	project := projectForNote(t, owner, "潮汐钟 维修")
	for i := range 22 {
		projectForNote(t, owner, "无关项目 "+string(rune('A'+i)))
	}
	saved := saveOrganizationImage(t, app, owner, uid, objects, "手写正文")
	id := saved["id"].(string)
	attachment := saved["attachments"].([]any)[0].(map[string]any)["id"].(string)
	run := saved["organization"].(map[string]any)["run_id"].(string)
	ageImageOrganizationRun(t, app, uid, run, "11 minutes")

	var textCalls, imageCalls atomic.Int32
	startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
		// Capture the real bounded candidate window before constructing the reply.
		var body []byte
		body, _ = io.ReadAll(r.Body)
		if strings.Contains(string(body), project) {
			t.Error("fixture project unexpectedly fit inside the candidate window")
		}
		r.Body = io.NopCloser(strings.NewReader(string(body)))
		textCalls.Add(1)
		result := topicFromImage(t, r, "潮汐钟　维修")
		modelReply(w, "stop", string(jsonBytes(result)), map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	expired := waitOrganization(t, owner, id, "failed")["organization"].(map[string]any)
	if expired["error_code"] != "image_material_timeout" || textCalls.Load() != 0 {
		t.Fatal("fixture did not reach the no-call image deadline")
	}

	startNoteImageWorker(t, app, storage, &imageCalls, `{"text":"合成编号731","description":"模型画面说明"}`)
	row := waitOrganization(t, owner, id, "succeeded")
	org := row["organization"].(map[string]any)
	if org["image_archive_status"] != "linked" || org["run_id"] == run || string(jsonBytes(row["document"])) != string(jsonBytes(saved["document"])) {
		t.Fatalf("late image did not safely archive the collection: %v", org)
	}
	association := row["projects"].([]any)[0].(map[string]any)
	if association["project_id"] != project || association["decision"] != "auto" || association["reason"] != "来自图面的编号731" {
		t.Fatalf("wrong project association: %v", association)
	}
	items := owner.do("GET", "/collections?project_id="+project, nil, "").want(t, 200)["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["id"] != id {
		t.Fatal("automatic association did not appear in the project's materials")
	}
	if notes := row["image_notes"].([]any); len(notes) != 1 || notes[0].(map[string]any)["text"] != "模型画面说明" {
		t.Fatalf("generated description was not in the body: %v", notes)
	}
	orgPath := "/collections/" + id + "/organization"
	for range 2 {
		if reply := owner.do("POST", orgPath, nil, uuid.NewString()).want(t, 202); reply["run_id"] != org["run_id"] {
			t.Fatal("the same image material opened a fresh model run")
		}
	}
	path := "/attachments/" + attachment + "/image-note"
	edit := map[string]any{"base_version": 1, "text": "手工修订图片说明"}
	other.do("PATCH", path, edit, "").want(t, 404)
	updated := owner.do("PATCH", path, edit, "").want(t, 200)
	note := updated["image_notes"].([]any)[0].(map[string]any)
	if note["state"] != "edited" || note["text"] != "手工修订图片说明" || updated["content_version"] != row["content_version"] {
		t.Fatalf("edit changed the original input or provenance: %v", note)
	}
	owner.do("PATCH", path, edit, "").want(t, 409)
	account := exportAccount{apiClient: owner, uid: uid}
	res, err := account.download(t, "markdown")
	if err != nil {
		t.Fatal(err)
	}
	files := archiveFiles(t, res)
	var archived bool
	for _, content := range files {
		archived = archived || strings.Contains(content, "手写正文") && strings.Contains(content, "手工修订图片说明")
	}
	if !archived {
		t.Fatal("Markdown export did not include both body sources")
	}
	expireExport(t, account)
	res, err = account.download(t, "json")
	if err != nil {
		t.Fatal(err)
	}
	if data := archiveFiles(t, res)["spark-export.json"]; !strings.Contains(data, "image_notes") || !strings.Contains(data, "手工修订图片说明") {
		t.Fatal("JSON export omitted the image body")
	}
	if deleted := owner.do("PATCH", path, map[string]any{"base_version": 2, "text": ""}, "").want(t, 200); len(deleted["image_notes"].([]any)) != 0 {
		t.Fatal("deleted description remained visible")
	}

	if textCalls.Load() != 1 || imageCalls.Load() != 1 {
		t.Fatalf("same material was resubmitted: %d text calls, %d image calls", textCalls.Load(), imageCalls.Load())
	}
}

func TestImageArchiveNormalizesConcurrentTopicsAndPreservesManualDecision(t *testing.T) {
	app, addr := testBackend(t)
	owner, uid, objects, storage := setupImageOrganization(t, app, addr)
	enableImageArchiving(t, owner)
	var imageCalls, textCalls atomic.Int32
	startNoteImageWorker(t, app, storage, &imageCalls, `{"text":"合成编号731","description":"模型画面说明"}`)
	entered := make(chan int32, 3)
	releasePair, releaseManual := make(chan struct{}), make(chan struct{})
	unblockPair := sync.OnceFunc(func() { close(releasePair) })
	unblockManual := sync.OnceFunc(func() { close(releaseManual) })
	defer unblockPair()
	defer unblockManual()
	startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
		number := textCalls.Add(1)
		name := "WEATHER－４０２"
		block := releasePair
		if number == 2 {
			name = "weather-402"
		}
		if number == 3 {
			name, block = "不应创建的主题", releaseManual
		}
		result := topicFromImage(t, r, name)
		entered <- number
		select {
		case <-block:
		case <-r.Context().Done():
			return
		}
		modelReply(w, "stop", string(jsonBytes(result)), map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	first := saveOrganizationImage(t, app, owner, uid, objects, "")
	second := saveOrganizationImage(t, app, owner, uid, objects, "")
	waitEntered := func() {
		t.Helper()
		select {
		case <-entered:
		case <-time.After(6 * time.Second):
			t.Fatal("text worker did not reach the controlled boundary")
		}
	}
	waitEntered()
	waitEntered()
	unblockPair()
	for _, saved := range []map[string]any{first, second} {
		final := waitOrganization(t, owner, saved["id"].(string), "succeeded")
		assoc := final["projects"].([]any)
		if len(assoc) != 1 || assoc[0].(map[string]any)["decision"] != "auto" || len(assoc[0].(map[string]any)["evidence"].([]any)) != 1 {
			t.Fatalf("wrong archival evidence: %v", assoc)
		}
	}
	projects := owner.do("GET", "/projects", nil, "").want(t, 200)["items"].([]any)
	if len(projects) != 1 {
		t.Fatalf("concurrent normalized themes created %d projects", len(projects))
	}
	p := projects[0].(map[string]any)
	if p["description"] != "" || p["collection_count"] != float64(2) || !strings.EqualFold(p["name"].(string), "weather-402") {
		t.Fatalf("wrong shared project or leaked image evidence: %v", p)
	}

	manual := projectForNote(t, owner, "人工选定项目")
	third := saveOrganizationImage(t, app, owner, uid, objects, "")
	id := third["id"].(string)
	waitEntered()
	owner.do("PATCH", "/collections/"+id+"/projects", map[string]any{"base_decision_version": 1,
		"operations": []any{map[string]any{"id": manual, "action": "include"}}}, "").want(t, 200)
	unblockManual()
	final := waitOrganization(t, owner, id, "succeeded")
	associations := final["projects"].([]any)
	if len(associations) != 1 || associations[0].(map[string]any)["project_id"] != manual || associations[0].(map[string]any)["decision"] != "manual" {
		t.Fatalf("in-flight auto-archive changed a human decision: %v", associations)
	}
	if count := len(owner.do("GET", "/projects", nil, "").want(t, 200)["items"].([]any)); count != 2 || textCalls.Load() != 3 || imageCalls.Load() != 3 {
		t.Fatalf("manual write led to another project or model call: %d projects, %d text, %d image", count, textCalls.Load(), imageCalls.Load())
	}
}

func TestImageArchiveUsesOCRButNotReplacedOrRemovedDescriptions(t *testing.T) {
	app, addr := testBackend(t)
	owner, uid, objects, storage := setupImageOrganization(t, app, addr)
	var textCalls, imageCalls atomic.Int32
	startNoteImageWorker(t, app, storage, &imageCalls, `{"text":"合成编号731","description":"模型画面说明"}`)

	history := saveOrganizationImage(t, app, owner, uid, objects, "")
	oldID := history["id"].(string)
	waitForImageStatus(t, owner, oldID, "succeeded")
	oldAttachment := history["attachments"].([]any)[0].(map[string]any)["id"].(string)
	owner.do("PATCH", "/attachments/"+oldAttachment+"/image-note",
		map[string]any{"base_version": 1, "text": "人工更正的说明"}, "").want(t, 200)
	enableImageArchiving(t, owner)

	entered, resume := make(chan struct{}), make(chan struct{})
	release := sync.OnceFunc(func() { close(resume) })
	defer release()
	startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
		input := readImageTextRequest(t, r)
		number := textCalls.Add(1)
		sawDescription := false
		for _, source := range input.Sources {
			if strings.HasPrefix(source.ID, "image_description:") {
				sawDescription = true
			}
			if strings.Contains(source.Text, "人工更正的说明") {
				t.Error("edited body was repurposed as model evidence")
			}
		}
		if sawDescription != (number == 2) {
			t.Error("model input used a replaced description or lacked the untouched source")
		}
		result := topicForMaterial(t, input, "订正后仍可归档的主题")
		if number == 2 {
			close(entered)
			select {
			case <-resume:
			case <-r.Context().Done():
				return
			}
			result = topicForMaterial(t, input, "已删除说明对应的过期主题")
		}
		modelReply(w, "stop", string(jsonBytes(result)), map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	owner.do("POST", "/collections/"+oldID+"/organization", nil, uuid.NewString()).want(t, 202)
	old := waitOrganization(t, owner, oldID, "succeeded")
	if old["organization"].(map[string]any)["image_archive_status"] != "created" || imageCalls.Load() != 1 {
		t.Fatal("historical note did not use existing OCR with the new consent")
	}

	saved := saveOrganizationImage(t, app, owner, uid, objects, "")
	id := saved["id"].(string)
	attachment := saved["attachments"].([]any)[0].(map[string]any)["id"].(string)
	select {
	case <-entered:
	case <-time.After(6 * time.Second):
		t.Fatal("worker did not start the in-flight description request")
	}
	owner.do("PATCH", "/attachments/"+attachment+"/image-note", map[string]any{"base_version": 1, "text": ""}, "").want(t, 200)
	release()
	stale := waitOrganization(t, owner, id, "superseded")
	if len(stale["projects"].([]any)) != 0 || textCalls.Load() != 2 {
		t.Fatal("body removal applied or redispatched the in-flight result")
	}
	owner.do("POST", "/collections/"+id+"/organization", nil, uuid.NewString()).want(t, 202)
	current := waitOrganization(t, owner, id, "succeeded")
	if current["organization"].(map[string]any)["image_archive_status"] != "linked" || textCalls.Load() != 3 || imageCalls.Load() != 2 {
		t.Fatal("manual organization did not use the remaining OCR exactly once")
	}
}

func TestImageRecoveryArchivesOnceWhenUsableMaterialArrives(t *testing.T) {
	app, addr := testBackend(t)
	owner, uid, objects, storage := setupImageOrganization(t, app, addr)
	enableImageArchiving(t, owner)
	var imageCalls, textCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verifyImageModelRequest(t, r)
		if imageCalls.Add(1) == 1 {
			modelReply(w, "length", `{"description":"未闭合`, map[string]int{"prompt_tokens": 200, "completion_tokens": 512})
			return
		}
		modelReply(w, "stop", `{"text":"合成编号731","description":"模型画面说明"}`, map[string]int{"prompt_tokens": 200, "completion_tokens": 30})
	}))
	t.Cleanup(provider.Close)
	startImageTestWorker(t, app, storage, provider.URL)
	startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
		textCalls.Add(1)
		result := topicFromImage(t, r, "手动恢复的图片主题")
		modelReply(w, "stop", string(jsonBytes(result)), map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})

	saved := saveOrganizationImage(t, app, owner, uid, objects, "")
	id := saved["id"].(string)
	attachment := saved["attachments"].([]any)[0].(map[string]any)["id"].(string)
	unusable := waitForImageStatus(t, owner, id, "failed")
	waitOrganization(t, owner, id, "skipped")
	if textCalls.Load() != 0 {
		t.Fatal("an empty truncation consumed a text call")
	}
	path := "/attachments/" + attachment + "/image-analysis/retry"
	body := map[string]any{"base_extraction_id": unusable["id"], "consent_version": "deepseek-image-retry-v1"}
	key := uuid.NewString()
	recovery := owner.do("POST", path, body, key).want(t, 202)
	row := waitOrganization(t, owner, id, "succeeded")
	if row["organization"].(map[string]any)["image_archive_status"] != "created" || len(row["image_notes"].([]any)) != 1 {
		t.Fatal("recovery did not produce the body and automatic project")
	}
	for _, replayKey := range []string{key, uuid.NewString()} {
		if replay := owner.do("POST", path, body, replayKey).want(t, 202); replay["id"] != recovery["id"] {
			t.Fatal("duplicate recovery introduced a new extraction")
		}
	}
	if imageCalls.Load() != 2 || textCalls.Load() != 1 {
		t.Fatalf("recovery dispatched more work than intended: %d image calls, %d text calls", imageCalls.Load(), textCalls.Load())
	}
}

func TestImageArchiveDropsUnsubstantiatedTopicAndExpiredAuthorization(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		name := "unsubstantiated topic"
		if revoke {
			name = "revoked image authorization"
		}
		t.Run(name, func(t *testing.T) {
			app, addr := testBackend(t)
			owner, uid, objects, storage := setupImageOrganization(t, app, addr)
			enableImageArchiving(t, owner)
			var imageCalls, textCalls atomic.Int32
			startNoteImageWorker(t, app, storage, &imageCalls, `{"text":"合成编号731","description":"模型画面说明"}`)
			entered, resume := make(chan struct{}), make(chan struct{})
			release := sync.OnceFunc(func() { close(resume) })
			defer release()
			startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
				textCalls.Add(1)
				result := topicFromImage(t, r, "不应创建的主题")
				if revoke {
					close(entered)
					select {
					case <-resume:
					case <-r.Context().Done():
						return
					}
				} else {
					topic := result["topic_candidate"].(map[string]any)
					evidence := topic["evidence"].([]modelEvidence)
					if len(evidence) > 0 {
						evidence[0].Quote = "图面上不存在的内容"
					}
				}
				modelReply(w, "stop", string(jsonBytes(result)), map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
			})
			saved := saveOrganizationImage(t, app, owner, uid, objects, "保留原文")
			id := saved["id"].(string)
			state := "partial"
			if revoke {
				select {
				case <-entered:
				case <-time.After(6 * time.Second):
					t.Fatal("controlled model call did not begin")
				}
				owner.do("PUT", "/me/image-analysis", map[string]any{"enabled": false}, "").want(t, 200)
				release()
				state = "superseded"
			}
			row := waitOrganization(t, owner, id, state)
			if !revoke && row["organization"].(map[string]any)["error_code"] != "invalid_topic_candidate" {
				t.Fatal("invalid topic did not preserve the otherwise usable organization")
			}
			if len(row["projects"].([]any)) != 0 || len(owner.do("GET", "/projects", nil, "").want(t, 200)["items"].([]any)) != 0 ||
				string(jsonBytes(row["document"])) != string(jsonBytes(saved["document"])) || textCalls.Load() != 1 {
				t.Fatal("missing evidence or stale authorization changed the project or source content")
			}
		})
	}
}
