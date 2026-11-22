package backend

import (
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

func TestWebProjectFilingUsesGroundedTagWithoutTopicCandidate(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	admin := imageTestAccount(t, app, base, "filing-test-budget")
	setImageTestBudget(admin, 1, 5_000_000, 5_000_000)
	owner := signedExportAccount(t, app, base, "filing-test-owner")
	ext := newClient(t, app, base)
	headers := extensionHeaders(t, exchangeTestExtension(ext, approveTestExtension(t, owner)))
	owner.do("PATCH", "/me/preferences", map[string]any{
		"ai_enabled": true, "consent_version": extensionArchiveConsentVersion,
	}, "").want(t, 200)
	existing := projectForNote(t, owner.apiClient, "传感校准")
	var calls atomic.Int32
	startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		input := readImageTextRequest(t, r)
		output := `{"title":"传感校准周记","tag_candidates":[{"name":"温室监测","evidence":[{"source_id":"page_title","quote":"温室监测"}]},{"name":"传感校准","evidence":[{"source_id":"page_title","quote":"传感校准"}]}],"project_candidates":[]}`
		for _, source := range input.Sources {
			if strings.Contains(source.Text, "苗床滴灌") {
				output = `{"title":"苗床滴灌","tag_candidates":[{"name":"苗床滴灌"}],"project_candidates":[]}`
			}
			if strings.Contains(source.Text, "收藏资料") {
				output = `{"title":"收藏资料","tag_candidates":[{"name":"资料","evidence":[{"source_id":"page_title","quote":"收藏资料"}]}],"project_candidates":[]}`
			}
		}
		modelReply(w, "stop", output, map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	id := uuid.NewString()
	ext.withHeaders("POST", "/extension/collections", map[string]any{
		"id": id, "manual_title": "温室监测与传感校准周记", "original_url": "https://example.test/filing", "project_ids": []string{},
	}, uuid.NewString(), headers).want(t, 201)
	row := waitOrganization(t, owner.apiClient, id, "succeeded", "partial", "failed")
	if len(row["tags"].([]any)) != 2 {
		t.Fatal("fixture did not persist the validated model tags")
	}
	projects := row["projects"].([]any)
	if len(projects) != 1 || projects[0].(map[string]any)["project_id"] != existing ||
		projects[0].(map[string]any)["decision"] != "auto" {
		t.Fatalf("tagged capture did not enter its existing project: %v", row["organization"])
	}
	items := owner.do("GET", "/collections?project_id="+existing, nil, "").want(t, 200)["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["id"] != id {
		t.Fatal("project material list did not contain the collection")
	}
	var newProject any
	for _, want := range []string{"created", "linked", "no_match"} {
		title := "苗床滴灌准备"
		if want == "no_match" {
			title = "收藏资料"
		}
		id := uuid.NewString()
		ext.withHeaders("POST", "/extension/collections", map[string]any{
			"id": id, "manual_title": title, "original_url": "https://example.test/filing", "project_ids": []string{},
		}, uuid.NewString(), headers).want(t, 201)
		row := waitOrganization(t, owner.apiClient, id, "succeeded")
		if row["organization"].(map[string]any)["web_archive_status"] != want {
			t.Fatalf("unexpected status for grounded-tag archive: want %s", want)
		}
		projects := row["projects"].([]any)
		if want == "no_match" {
			if len(projects) != 0 || len(row["tags"].([]any)) != 1 || row["organization"].(map[string]any)["project_backfill_available"] == true {
				t.Fatal("generic tag was lost or used to file a collection")
			}
			continue
		}
		project := projects[0].(map[string]any)
		if project["decision"] != "auto" || project["name"] != "苗床滴灌" {
			t.Fatal("tag fallback did not apply a supported short topic")
		}
		if want == "created" {
			newProject = project["project_id"]
		} else if project["project_id"] != newProject {
			t.Fatal("tag fallback duplicated the topic project")
		}
	}
	if calls.Load() != 4 {
		t.Fatalf("fallback should use the original response only, got %d calls", calls.Load())
	}
}

func TestWebProjectBackfillIsReadOnlyUntilExplicitApply(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	admin := imageTestAccount(t, app, base, "backfill-test-budget")
	setImageTestBudget(admin, 1, 5_000_000, 5_000_000)
	owner := signedExportAccount(t, app, base, "backfill-test-owner")
	other := signedExportAccount(t, app, base, "backfill-test-other")
	ext := newClient(t, app, base)
	headers := extensionHeaders(t, exchangeTestExtension(ext, approveTestExtension(t, owner)))
	owner.do("PATCH", "/me/preferences", map[string]any{
		"ai_enabled": true, "consent_version": extensionArchiveConsentVersion,
	}, "").want(t, 200)
	var calls atomic.Int32
	startImageTextOrganization(t, app, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		readImageTextRequest(t, r)
		modelReply(w, "stop", `{"title":"旧归类结果","tag_candidates":[{"name":"温室监测","evidence":[{"source_id":"page_title","quote":"温室监测"}]},{"name":"传感校准","evidence":[{"source_id":"page_title","quote":"传感校准"}]}],"project_candidates":[]}`,
			map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
	})
	// Without an existing project, two equally strong topics leave a real
	// settled no_match with both tags. Add the project after those runs.
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	for _, id := range ids {
		ext.withHeaders("POST", "/extension/collections", map[string]any{
			"id": id, "manual_title": "温室监测与传感校准周记", "original_url": "https://example.test/legacy", "project_ids": []string{},
		}, uuid.NewString(), headers).want(t, 201)
		row := waitOrganization(t, owner.apiClient, id, "succeeded")
		if len(row["projects"].([]any)) != 0 || row["decision_version"] != float64(2) ||
			row["organization"].(map[string]any)["web_archive_status"] != "no_match" {
			t.Fatal("fixture did not produce a settled, initially unfiled archive")
		}
	}
	project := projectForNote(t, owner.apiClient, "传感校准")
	firstPath := "/collections/" + ids[0]
	for range 2 {
		row := owner.do("GET", firstPath, nil, "").want(t, 200)
		if row["organization"].(map[string]any)["project_backfill_available"] != true || len(row["projects"].([]any)) != 0 {
			t.Fatal("detail read wrote a project link or omitted its eligibility")
		}
	}
	usage := owner.do("GET", "/me/usage", nil, "").want(t, 200)["settled_units"]
	apply := func(a exportAccount, id, key string, version int) apiResponse {
		return a.do("POST", "/collections/"+id+"/organization/web-archive/apply", map[string]int{"base_decision_version": version}, key)
	}
	apply(other, ids[0], uuid.NewString(), 2).want(t, 404)
	keys := []string{uuid.NewString(), uuid.NewString()}
	var results [2]apiResponse
	var jobs sync.WaitGroup
	for i, key := range keys {
		jobs.Go(func() { results[i] = apply(owner, ids[0], key, 2) })
	}
	jobs.Wait()
	wins := 0
	for i, result := range results {
		if result.status != 200 {
			extensionError(t, result, 409, "decision_conflict")
			continue
		}
		wins++
		row := result.want(t, 200)
		org := row["organization"].(map[string]any)
		linked := row["projects"].([]any)[0].(map[string]any)
		if linked["project_id"] != project || linked["decision"] != "auto" || org["web_archive_status"] != "linked" ||
			org["project_backfill_available"] == true || row["decision_version"] != float64(3) {
			t.Fatal("reuse did not return the new project and decision version")
		}
		replay := apply(owner, ids[0], keys[i], 2)
		if replay.want(t, 200)["decision_version"] != float64(3) || replay.header.Get("Idempotent-Replayed") != "true" {
			t.Fatal("same key was not replayed")
		}
	}
	if wins != 1 {
		t.Fatalf("want one write across two tabs, got %d", wins)
	}

	changeProject := func(id, action string, version int) {
		t.Helper()
		owner.do("PATCH", "/collections/"+id+"/projects", map[string]any{
			"base_decision_version": version, "operations": []any{map[string]string{"id": project, "action": action}},
		}, "").want(t, 200)
	}
	changeProject(ids[1], "include", 2)
	changeProject(ids[1], "reset", 3)
	changeProject(ids[2], "exclude", 2)
	for i, version := range []int{4, 3} {
		id := ids[i+1]
		row := owner.do("GET", "/collections/"+id, nil, "").want(t, 200)
		if row["organization"].(map[string]any)["project_backfill_available"] == true {
			t.Fatal("manual removal or exclusion remained eligible")
		}
		extensionError(t, apply(owner, id, uuid.NewString(), version), 409, "project_backfill_unavailable")
	}
	items := owner.do("GET", "/collections?project_id="+project, nil, "").want(t, 200)["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["id"] != ids[0] || calls.Load() != 3 ||
		owner.do("GET", "/me/usage", nil, "").want(t, 200)["settled_units"] != usage {
		t.Fatal("backfill repeated billing or wrote an unexpected project association")
	}
}
