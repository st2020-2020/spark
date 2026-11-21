package backend

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"net/url"
	"testing"

	"github.com/google/uuid"
)

func TestAccountTagsAreNormalizedAndVersioned(t *testing.T) {
	app, base := testBackend(t)
	alice := imageTestAccount(t, app, base, "tags-alice")
	bob := imageTestAccount(t, app, base, "tags-bob")
	create := func(client *apiClient, name string) string {
		return client.do("POST", "/tags", map[string]any{"name": name}, uuid.NewString()).want(t, 201)["id"].(string)
	}
	id := create(alice, "  Cafe\u0301  ")
	foreign := create(bob, "CAFÉ")
	alice.do("POST", "/tags", map[string]any{"name": "CAFÉ"}, uuid.NewString()).want(t, 409)
	alice.do("POST", "/tags", map[string]any{"name": "1234567890123456789012345"}, uuid.NewString()).want(t, 422)
	items := alice.do("GET", "/tags?q="+url.QueryEscape("CAFÉ"), nil, "").want(t, 200)["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["name"] != "Café" {
		t.Fatalf("unexpected tags: %v", items)
	}

	collection := uuid.NewString()
	input := collectionInput(collection, "保留原文")
	input["tag_ids"] = []string{id, foreign}
	alice.do("POST", "/collections", input, uuid.NewString()).want(t, 404)
	alice.do("GET", "/collections/"+collection, nil, "").want(t, 404)
	input["tag_ids"] = []string{id}
	created := alice.do("POST", "/collections", input, uuid.NewString()).want(t, 201)
	if len(created["tags"].([]any)) != 1 {
		t.Fatal("creation tags were lost")
	}
	if got := alice.do("GET", "/collections?tag_id="+id, nil, "").want(t, 200)["items"].([]any); len(got) != 1 {
		t.Fatal("manual tag did not match the collection filter")
	}
	owned := alice.do("GET", "/tags", nil, "").want(t, 200)["items"].([]any)
	if len(owned) != 1 || owned[0].(map[string]any)["collection_count"] != float64(1) {
		t.Fatal("tag count did not match active collections")
	}
	search := alice.do("GET", "/search?q="+url.QueryEscape("CAFÉ"), nil, "").want(t, 200)["items"].([]any)
	if len(search) != 1 || search[0].(map[string]any)["snippets"].([]any)[0].(map[string]any)["field"] != "tag" {
		t.Fatal("tag name is not searchable")
	}
	if got := bob.do("GET", "/collections?tag_id="+id, nil, "").want(t, 200)["items"].([]any); len(got) != 0 {
		t.Fatal("tag filtering leaked collections across accounts")
	}
	path := "/collections/" + collection + "/tags"
	edit := map[string]any{"base_decision_version": 1, "operations": []any{map[string]any{"id": id, "action": "exclude"}}}
	bob.do("PATCH", path, edit, "").want(t, 404)
	excluded := alice.do("PATCH", path, edit, "").want(t, 200)
	if excluded["content_version"] != float64(1) || excluded["decision_version"] != float64(2) ||
		excluded["tags"].([]any)[0].(map[string]any)["decision"] != "rejected" {
		t.Fatal("tag decision did not preserve content or its rejection")
	}
	alice.do("PATCH", path, edit, "").want(t, 409)
	if got := alice.do("GET", "/collections?tag_id="+id, nil, "").want(t, 200)["items"].([]any); len(got) != 0 {
		t.Fatal("rejected tag still matched the filter")
	}
	alice.do("PATCH", "/tags/"+id, map[string]any{"name": "阅读", "expected_name": "Café"}, "").want(t, 200)
	alice.do("DELETE", "/tags/"+id+"?expected_name="+url.QueryEscape("Café"), nil, "").want(t, 409)
	bob.do("DELETE", "/tags/"+id+"?expected_name="+url.QueryEscape("阅读"), nil, "").want(t, 404)
	alice.do("DELETE", "/tags/"+id+"?expected_name="+url.QueryEscape("阅读"), nil, "").want(t, 204)
	after := alice.do("GET", "/collections/"+collection, nil, "").want(t, 200)
	if len(after["tags"].([]any)) != 0 || after["content_version"] != float64(1) ||
		after["decision_version"] != float64(3) || !equalJSON(after["document"], created["document"]) {
		t.Fatal("deletion did not remove the decision while retaining original content")
	}
}

func TestAppearancePartialWritesPreserveLegacyAIConsent(t *testing.T) {
	app, base := testBackend(t)
	a := imageTestAccount(t, app, base, "appearance-a")
	b := imageTestAccount(t, app, base, "appearance-b")
	session := func(client *apiClient) map[string]any {
		return client.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)
	}
	before := session(a)
	if before["palette"] != "mint" || before["theme"] != "system" {
		t.Fatal("wrong account appearance defaults")
	}
	a.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
	consented := session(a)
	a.do("PATCH", "/me/preferences", map[string]any{"palette": "sakura"}, "").want(t, 200)
	after := a.do("PATCH", "/me/preferences", map[string]any{"theme": "dark"}, "").want(t, 200)
	if after["ai_enabled"] != true || after["ai_policy_version"] != consented["ai_policy_version"] ||
		after["palette"] != "sakura" || after["theme"] != "dark" {
		t.Fatal("appearance changes modified consent or overwrote another preference")
	}
	a.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": false}, "").want(t, 200)
	a.do("PATCH", "/me/preferences", map[string]any{"theme": "unknown"}, "").want(t, 422)
	if u := session(a); u["ai_enabled"] != false || u["palette"] != "sakura" || u["theme"] != "dark" {
		t.Fatal("legacy AI write lost appearance")
	}
	if u := session(b); u["palette"] != "mint" || u["theme"] != "system" {
		t.Fatal("appearance changes leaked to another account")
	}
}

func TestTagAndProjectShareDecisionVersion(t *testing.T) {
	app, base := testBackend(t)
	a := imageTestAccount(t, app, base, "tag-project-race")
	tag := a.do("POST", "/tags", map[string]any{"name": "标签"}, uuid.NewString()).want(t, 201)["id"]
	project := a.do("POST", "/projects", map[string]any{"name": "资料 % 整理", "description": "", "focus_points": []string{}}, uuid.NewString()).want(t, 201)["id"]
	results := a.do("GET", "/projects?state=active&q="+url.QueryEscape("资料 %"), nil, "").want(t, 200)["items"].([]any)
	if len(results) != 1 || results[0].(map[string]any)["id"] != project {
		t.Fatal("project autocomplete did not match the literal search")
	}
	id := uuid.NewString()
	a.do("POST", "/collections", collectionInput(id, "共有决定版本"), uuid.NewString()).want(t, 201)
	var group sync.WaitGroup
	statuses := make(chan int, 2)
	for path, target := range map[string]any{"tags": tag, "projects": project} {
		group.Go(func() {
			resp := a.do("PATCH", "/collections/"+id+"/"+path, map[string]any{
				"base_decision_version": 1,
				"operations":            []any{map[string]any{"id": target, "action": "include"}},
			}, "")
			statuses <- resp.status
		})
	}
	group.Wait()
	close(statuses)
	var actual []int
	for status := range statuses {
		actual = append(actual, status)
	}
	slices.Sort(actual)
	if !slices.Equal(actual, []int{200, 409}) {
		t.Fatalf("expected one write and one conflict, got %v", actual)
	}
	collection := a.do("GET", "/collections/"+id, nil, "").want(t, 200)
	if collection["decision_version"] != float64(2) || collection["content_version"] != float64(1) {
		t.Fatal("lost shared decision consistency")
	}
}

func TestTagsInOwnerExports(t *testing.T) {
	app, base := testBackend(t)
	a := signedExportAccount(t, app, base, "tag-export-a")
	b := signedExportAccount(t, app, base, "tag-export-b")
	active := a.do("POST", "/tags", map[string]any{"name": "公开资料"}, uuid.NewString()).want(t, 201)["id"]
	rejected := a.do("POST", "/tags", map[string]any{"name": "排除标签"}, uuid.NewString()).want(t, 201)["id"]
	b.do("POST", "/tags", map[string]any{"name": "另一账号的标签"}, uuid.NewString()).want(t, 201)
	id := uuid.NewString()
	input := collectionInput(id, "导出保留的正文")
	input["tag_ids"] = []any{active}
	a.do("POST", "/collections", input, uuid.NewString()).want(t, 201)
	a.do("PATCH", "/collections/"+id+"/tags", map[string]any{
		"base_decision_version": 1, "operations": []any{map[string]any{"id": rejected, "action": "exclude"}},
	}, "").want(t, 200)
	resp, err := a.download(t, "json")
	if err != nil {
		t.Fatal(err)
	}
	files := archiveFiles(t, resp)
	var archive struct {
		Tags        []struct{ Name string }
		Collections []struct {
			ID   string
			Tags []struct{ Path, Decision string }
		}
	}
	if err := json.Unmarshal([]byte(files["spark-export.json"]), &archive); err != nil {
		t.Fatal(err)
	}
	if len(archive.Tags) != 2 || len(archive.Collections) != 1 || archive.Collections[0].ID != id ||
		len(archive.Collections[0].Tags) != 2 || strings.Contains(files["spark-export.json"], "另一账号的标签") {
		t.Fatal("JSON export did not preserve owner-only tag catalog and decisions")
	}
	expireExport(t, a)
	resp, err = a.download(t, "markdown")
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range archiveFiles(t, resp) {
		if strings.HasPrefix(name, "unclassified/") {
			if !strings.Contains(body, "公开资料（manual）") || !strings.Contains(body, "排除标签（rejected）") ||
				!strings.Contains(body, "导出保留的正文") {
				t.Fatal("Markdown export lost tag name, decision, or body")
			}
			return
		}
	}
	t.Fatal("expected collection Markdown file")
}

func TestTextWorkerUsesOnlyOwnedTagsAndExistingBudget(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	a := imageTestAccount(t, app, base, "ai-tags-owner")
	b := imageTestAccount(t, app, base, "ai-tags-other")
	add := func(client *apiClient, name string) string {
		return client.do("POST", "/tags", map[string]any{"name": name}, uuid.NewString()).want(t, 201)["id"].(string)
	}
	keep, exclude := add(a, "写作"), add(a, "研究")
	add(a, "无关主题")
	foreign := add(b, "别人的资料")
	a.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)

	var hits atomic.Int32
	entered := make(chan []modelTag, 1)
	release := make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		hits.Add(1)
		var body struct {
			Messages []struct{ Role, Content string }
		}
		var input textInput
		if json.NewDecoder(req.Body).Decode(&body) != nil || len(body.Messages) != 2 ||
			json.Unmarshal([]byte(body.Messages[1].Content), &input) != nil {
			t.Error("unexpected provider request")
			http.Error(w, "invalid fixture request", http.StatusBadRequest)
			return
		}
		if len(input.Tags) == 0 {
			modelReply(w, "stop", `{"title":"写作","tag_candidates":[],"project_candidates":[]}`, map[string]int{"prompt_tokens": 100, "completion_tokens": 40})
			return
		}
		entered <- input.Tags
		<-release
		result := map[string]any{"title": "写作研究", "tag_candidates": []modelTag{
			{ID: keep, Name: "写作"}, {ID: exclude, Name: "研究"},
		}, "project_candidates": []any{}}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{
			map[string]any{"finish_reason": "stop", "message": map[string]any{"content": string(jsonBytes(result))}},
		}, "usage": map[string]any{"prompt_tokens": 100, "completion_tokens": 40}})
	}))
	defer provider.Close()
	defer unblock()
	cfg := AIConfig{Version: "synthetic-tag-test", MaxAttempts: 1, TimeoutSeconds: 5, MaxInputChars: 1000,
		Routes: []AIRoute{{Name: "primary", Endpoint: provider.URL + "/v1/chat/completions", Model: "synthetic",
			OutputMode: "json_object", MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 1000000, OutputPrice: 2000000}}}
	client := NewTextClient()
	defer client.Close()
	worker, err := StartTextWorker(t.Context(), app.Pool, cfg, app.Organizer.Trial, client)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unblock)
	stopImageTestWorker(t, worker)

	const material = "写作与研究，也提到别人的资料"
	disabled := uuid.NewString()
	b.do("POST", "/collections", collectionInput(disabled, material), uuid.NewString()).want(t, 201)
	waitOrganization(t, b, disabled, "skipped")
	blocked := uuid.NewString()
	a.do("POST", "/collections", collectionInput(blocked, material), uuid.NewString()).want(t, 201)
	waitOrganization(t, a, blocked, "blocked")
	if hits.Load() != 0 {
		t.Fatal("job called the provider without consent or budget")
	}
	a.do("PUT", "/admin/budgets", map[string]any{"base_version": 1,
		"platform_daily_units": 1000000, "user_daily_units": 1000000, "worker_concurrency": 1}, "").want(t, 200)
	legacy := uuid.NewString()
	a.do("POST", "/collections", collectionInput(legacy, material), uuid.NewString()).want(t, 201)
	if len(waitOrganization(t, a, legacy, "succeeded")["tags"].([]any)) != 0 {
		t.Fatal("legacy consent applied tags")
	}
	a.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": textTagConsentVersion}, "").want(t, 200)
	id := uuid.NewString()
	a.do("POST", "/collections", collectionInput(id, material), uuid.NewString()).want(t, 201)
	select {
	case tags := <-entered:
		if len(tags) != 2 || slices.ContainsFunc(tags, func(t modelTag) bool { return t.ID == foreign }) {
			t.Fatal("provider received foreign or unrelated labels")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("queue did not reach controlled provider")
	}
	a.do("PATCH", "/collections/"+id+"/tags", map[string]any{
		"base_decision_version": 1, "operations": []any{map[string]any{"id": exclude, "action": "exclude"}},
	}, "").want(t, 200)
	unblock()
	saved := waitOrganization(t, a, id, "succeeded")
	decisions := map[string]string{}
	for _, raw := range saved["tags"].([]any) {
		tag := raw.(map[string]any)
		decisions[tag["tag_id"].(string)] = tag["decision"].(string)
	}
	usage := a.do("GET", "/me/usage", nil, "").want(t, 200)
	if len(decisions) != 2 || decisions[keep] != "auto" || decisions[exclude] != "rejected" ||
		hits.Load() != 2 || usage["settled_units"] != float64(360) || usage["reserved_units"] != float64(0) {
		t.Fatal("label application changed the human decision or billed an extra call")
	}
}
