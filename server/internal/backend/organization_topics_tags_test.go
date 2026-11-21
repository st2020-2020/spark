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
	"github.com/santhosh-tekuri/jsonschema/v5"
)

func useOrganizationConsent(t *testing.T, owner *apiClient, version string) {
	t.Helper()
	result := owner.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": version}, "").want(t, 200)
	if result["ai_consent_version"] != version {
		t.Fatal("requested consent version was not recorded")
	}
}

func startTopicTagWorker(t *testing.T, app *Server, mode string, handler http.HandlerFunc) {
	t.Helper()
	provider := httptest.NewServer(handler)
	t.Cleanup(provider.Close)
	client := NewTextClient()
	t.Cleanup(client.Close)
	cfg := AIConfig{
		Version: "synthetic-topics-tags", MaxAttempts: 1, TimeoutSeconds: 7, MaxInputChars: 1000, Images: app.Organizer.Images,
		Routes: []AIRoute{{Name: "text", Endpoint: provider.URL + "/chat/completions", Model: "synthetic-text",
			OutputMode: mode, MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 1000000, OutputPrice: 2000000}},
	}
	worker, err := StartTextWorker(t.Context(), app.Pool, cfg, app.Organizer.Trial, client)
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, worker)
}

func TestOrganizationCreatesMaterialTagsWithAnEmptyCatalog(t *testing.T) {
	for _, mode := range []string{"json_object", "json_schema"} {
		t.Run(mode, func(t *testing.T) {
			app, addr := testBackend(t)
			app.Organizer.Enabled = true
			owner := imageTestAccount(t, app, addr, "empty-catalog")
			setImageTestBudget(owner, 1, 1_000_000, 1_000_000)
			useOrganizationConsent(t, owner, textImageTagsConsentVersion)
			var calls atomic.Int32
			startTopicTagWorker(t, app, mode, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var request struct {
					Messages       []struct{ Content string }
					ResponseFormat struct {
						Type   string
						Schema struct {
							Strict bool
							Value  json.RawMessage `json:"schema"`
						} `json:"json_schema"`
					} `json:"response_format"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.ResponseFormat.Type != mode || len(request.Messages) != 2 {
					t.Error("unexpected request for fixture output mode")
				}
				reply := map[string]any{"title": "交付方案", "summary": "保留交付要点", "project_candidates": []any{},
					"tag_candidates": []any{
						map[string]any{"name": "发布流程"},
						map[string]any{"name": "回滚演练", "evidence": []modelEvidence{{SourceID: "original_text", Quote: "定期做回滚演练"}}},
						map[string]any{"name": "轮值维护", "evidence": []modelEvidence{{SourceID: "original_text", Quote: "上线以后持续维护"}}},
					}}
				if mode == "json_schema" {
					for _, raw := range reply["tag_candidates"].([]any) {
						tag := raw.(map[string]any)
						tag["tag_id"] = nil
						if _, ok := tag["evidence"]; !ok {
							tag["evidence"] = nil
						}
					}
					schema, err := jsonschema.CompileString("https://example.test/model-result.json", string(request.ResponseFormat.Schema.Value))
					var candidate any
					if err != nil || !request.ResponseFormat.Schema.Strict || json.Unmarshal(jsonBytes(reply), &candidate) != nil || schema.Validate(candidate) != nil {
						t.Error("provider schema rejected a complete response with nullable generated-tag fields")
					}
				}
				modelReply(w, "stop", string(jsonBytes(reply)), map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
			})
			id := uuid.NewString()
			owner.do("POST", "/collections", collectionInput(id, "团队按发布流程上线，定期做回滚演练，上线以后持续维护"), uuid.NewString()).want(t, 201)
			row := waitOrganization(t, owner, id, "succeeded", "failed")
			tags := row["tags"].([]any)
			if len(tags) != 3 || row["organization"].(map[string]any)["summary"] != "保留交付要点" || calls.Load() != 1 {
				t.Fatalf("zero-catalog result did not apply three tags and a summary: %v %v", row["organization"], tags)
			}
			for _, raw := range tags {
				if raw.(map[string]any)["decision"] != "auto" {
					t.Fatal("a generated label did not have automatic provenance")
				}
			}
		})
	}
}

func TestImageOrganizationRejectsLongNewTopicButRetainsSummaryAndTags(t *testing.T) {
	app, addr := testBackend(t)
	owner, uid, objects, storage := setupImageOrganization(t, app, addr)
	useOrganizationConsent(t, owner, textImageTagsConsentVersion)
	var calls, imageCalls atomic.Int32
	startNoteImageWorker(t, app, storage, &imageCalls, `{"text":"值班发布流程与回滚演练记录","description":"架构笔记的合成画面"}`)
	long := "值班发布流程与回滚演练记录"
	names := []string{long, "应用交付", long, strings.Repeat("㍿", 4), strings.Repeat("长", 105)}
	startTopicTagWorker(t, app, "json_object", func(w http.ResponseWriter, r *http.Request) {
		n := int(calls.Add(1)) - 1
		if n >= len(names) {
			t.Error("unexpected additional model call")
			http.Error(w, "unexpected call", http.StatusBadRequest)
			return
		}
		input := readImageTextRequest(t, r)
		var imageID string
		for _, source := range input.Sources {
			if strings.HasPrefix(source.ID, "image_text:") {
				imageID = source.ID
			}
		}
		evidence := []modelEvidence{{SourceID: imageID, Quote: "回滚演练"}}
		reply := map[string]any{"title": "值班发布备忘", "summary": "先核对回滚演练", "project_candidates": []any{},
			"tag_candidates":  []any{map[string]any{"name": "发布流程"}, map[string]any{"name": "回滚演练", "evidence": evidence}},
			"topic_candidate": modelTopic{Name: names[n], Reason: "图面记录了回滚演练", Evidence: evidence}}
		modelReply(w, "stop", string(jsonBytes(reply)), map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	for i := range names {
		var longProject string
		if i == 2 {
			longProject = projectForNote(t, owner, long)
		}
		saved := saveOrganizationImage(t, app, owner, uid, objects, "")
		id := saved["id"].(string)
		row := waitOrganization(t, owner, id, "succeeded", "partial", "failed")
		org := row["organization"].(map[string]any)
		if org["summary"] != "先核对回滚演练" || len(row["tags"].([]any)) != 2 {
			t.Fatalf("summary or tags were lost with candidate %d: %v", i, org)
		}
		projectIDs := row["projects"].([]any)
		switch i {
		case 1:
			if org["image_archive_status"] != "created" || len(projectIDs) != 1 || projectIDs[0].(map[string]any)["name"] != "应用交付" {
				t.Fatalf("concise project was not created: %v", projectIDs)
			}
			key := uuid.NewString()
			for _, replay := range []string{key, key, uuid.NewString()} {
				if repeated := owner.do("POST", "/collections/"+id+"/organization", nil, replay).want(t, 202); repeated["run_id"] != org["run_id"] {
					t.Fatal("same image material opened another organization")
				}
			}
		case 2:
			if org["image_archive_status"] != "linked" || len(projectIDs) != 1 || projectIDs[0].(map[string]any)["project_id"] != longProject {
				t.Fatalf("existing long-name project was not reused: %v", projectIDs)
			}
		default:
			if org["error_code"] != "invalid_topic_candidate" || len(projectIDs) != 0 {
				t.Fatalf("invalid topic produced an association or lost its selective status: %v %v", org, projectIDs)
			}
		}
	}
	if projects := owner.do("GET", "/projects", nil, "").want(t, 200)["items"].([]any); len(projects) != 2 {
		t.Fatalf("a rejected or repeated topic was created: %v", projects)
	}
	if tags := owner.do("GET", "/tags", nil, "").want(t, 200)["items"].([]any); len(tags) != 2 || calls.Load() != 5 || imageCalls.Load() != 5 {
		t.Fatalf("same tags were duplicated or an extra model call was made: %v, %d/%d calls", tags, calls.Load(), imageCalls.Load())
	}
}

func TestOrganizationTagAuthorizationAndInvalidUsage(t *testing.T) {
	app, addr := testBackend(t)
	app.Organizer.Enabled = true
	owner := imageTestAccount(t, app, addr, "tag-owner")
	other := imageTestAccount(t, app, addr, "tag-foreign")
	setImageTestBudget(owner, 1, 1_000_000, 1_000_000)
	oldTag := owner.do("POST", "/tags", map[string]any{"name": "运行巡检"}, uuid.NewString()).want(t, 201)["id"].(string)
	foreignTag := other.do("POST", "/tags", map[string]any{"name": "邻里资料"}, uuid.NewString()).want(t, 201)["id"].(string)
	useOrganizationConsent(t, owner, textImageNotesConsentVersion)
	var calls atomic.Int32
	startTopicTagWorker(t, app, "json_object", func(w http.ResponseWriter, r *http.Request) {
		input := readImageTextRequest(t, r)
		var tags []any
		var usage = map[string]int{"prompt_tokens": 100, "completion_tokens": 40}
		switch calls.Add(1) {
		case 1:
			if len(input.Tags) != 1 || input.Tags[0].ID != oldTag {
				t.Error("legacy consent did not offer only its own tag")
			}
			tags = []any{map[string]any{"name": "运行巡检", "tag_id": oldTag}, map[string]any{"name": "周期登记"}}
		case 2:
			tags = []any{map[string]any{"name": "邻里资料", "tag_id": foreignTag}}
		case 3:
			tags = []any{map[string]any{"name": "周期登记", "evidence": []modelEvidence{{SourceID: "original_text", Quote: "不存在的引文"}}}}
		case 4:
			tags = []any{map[string]any{"name": "周期登记", "parent_id": oldTag}}
		case 5:
			tags = []any{map[string]any{"name": "周期登记"}}
			usage = nil
		}
		reply := map[string]any{"title": "运行记录", "project_candidates": []any{}, "tag_candidates": tags}
		modelReply(w, "stop", string(jsonBytes(reply)), usage)
	})
	for i, want := range []string{"succeeded", "failed", "failed", "failed", "partial"} {
		if i == 1 {
			useOrganizationConsent(t, owner, textImageTagsConsentVersion)
		}
		id := uuid.NewString()
		owner.do("POST", "/collections", collectionInput(id, "本次运行巡检与周期登记"), uuid.NewString()).want(t, 201)
		row := waitOrganization(t, owner, id, want)
		tags := row["tags"].([]any)
		if i == 0 {
			if len(tags) != 1 || tags[0].(map[string]any)["tag_id"] != oldTag {
				t.Fatal("legacy authorization did not keep only the catalog match")
			}
		} else if len(tags) != 0 {
			t.Fatal("invalid or unmetered output wrote a tag")
		}
	}
	if tags := owner.do("GET", "/tags", nil, "").want(t, 200)["items"].([]any); len(tags) != 1 {
		t.Fatalf("authorization escaped the catalog: %v", tags)
	}
	balance := owner.do("GET", "/me/usage", nil, "").want(t, 200)
	if balance["settled_units"] != float64(720) || balance["reserved_units"].(float64) <= 0 || calls.Load() != 5 {
		t.Fatalf("validation failures did not retain billing or retried: %v %d", balance, calls.Load())
	}
}

func TestOrganizationReusesConcurrentTagNamesAndPreservesHumanDecisions(t *testing.T) {
	app, addr := testBackend(t)
	app.Organizer.Enabled = true
	owner := imageTestAccount(t, app, addr, "concurrent-owner")
	setImageTestBudget(owner, 1, 1_000_000, 1_000_000)
	useOrganizationConsent(t, owner, textImageTagsConsentVersion)
	var calls atomic.Int32
	entered := make(chan struct{}, 3)
	pair, later := make(chan struct{}), make(chan struct{})
	releasePair := sync.OnceFunc(func() { close(pair) })
	releaseLater := sync.OnceFunc(func() { close(later) })
	defer releasePair()
	defer releaseLater()
	startTopicTagWorker(t, app, "json_object", func(w http.ResponseWriter, r *http.Request) {
		block := pair
		name := "CAFÉ"
		switch calls.Add(1) {
		case 2:
			name = "Cafe\u0301"
		case 3:
			block = later
		}
		entered <- struct{}{}
		select {
		case <-block:
		case <-r.Context().Done():
			return
		}
		reply := map[string]any{"title": "值班记录", "project_candidates": []any{}, "tag_candidates": []any{map[string]any{"name": name}}}
		modelReply(w, "stop", string(jsonBytes(reply)), map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	first, second := uuid.NewString(), uuid.NewString()
	for _, id := range []string{first, second} {
		owner.do("POST", "/collections", collectionInput(id, "CAFÉ 值班记录"), uuid.NewString()).want(t, 201)
	}
	await := func() {
		t.Helper()
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("text worker did not start the controlled request")
		}
	}
	await()
	await()
	releasePair()
	firstRow := waitOrganization(t, owner, first, "succeeded")
	waitOrganization(t, owner, second, "succeeded")
	items := owner.do("GET", "/tags", nil, "").want(t, 200)["items"].([]any)
	if len(items) != 1 || tagKey(items[0].(map[string]any)["path"].(string)) != tagKey("café") {
		t.Fatalf("concurrent normalized names created duplicate tags: %v", items)
	}
	autoID := items[0].(map[string]any)["id"].(string)
	manualID := owner.do("POST", "/tags", map[string]any{"name": "人工说明"}, uuid.NewString()).want(t, 201)["id"].(string)
	key := uuid.NewString()
	path := "/collections/" + first
	active := owner.do("POST", path+"/organization", nil, key).want(t, 202)
	await()
	if replay := owner.do("POST", path+"/organization", nil, key).want(t, 202); replay["run_id"] != active["run_id"] {
		t.Fatal("same-key organization replay opened new work")
	}
	owner.do("PATCH", path+"/tags", map[string]any{"base_decision_version": firstRow["decision_version"],
		"operations": []any{map[string]any{"id": autoID, "action": "exclude"}, map[string]any{"id": manualID, "action": "include"}}}, "").want(t, 200)
	releaseLater()
	result := waitOrganization(t, owner, first, "succeeded")
	decisions := map[string]string{}
	for _, raw := range result["tags"].([]any) {
		tag := raw.(map[string]any)
		decisions[tag["tag_id"].(string)] = tag["decision"].(string)
	}
	if len(decisions) != 2 || decisions[autoID] != "rejected" || decisions[manualID] != "manual" || calls.Load() != 3 {
		t.Fatalf("reorganization overrode human choices or repeated work: %v %d calls", decisions, calls.Load())
	}
	if tags := owner.do("GET", "/tags", nil, "").want(t, 200)["items"].([]any); len(tags) != 2 {
		t.Fatalf("reorganization created a duplicate or historical tag: %v", tags)
	}
}
