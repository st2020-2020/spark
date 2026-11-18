package backend

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestOrganizationConsentAndTransactionalQueue(t *testing.T) {
	app, base := testBackend(t)
	app.Config.AIEnabled = true
	app.Organizer.Enabled = true
	if err := app.BootstrapAdmin(context.Background(), "ai@example.test", "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	user := newClient(t, app, base)
	user.signIn("ai@example.test")
	user.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true}, "").want(t, 422)
	prefs := user.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
	if prefs["ai_enabled"] != true {
		t.Fatal("consent not enabled")
	}
	id := uuid.NewString()
	saved := user.do("POST", "/collections", collectionInput(id, "离线同步的冲突解决研究"), uuid.NewString()).want(t, 201)
	org := saved["organization"].(map[string]any)
	if org["status"] != "queued" {
		t.Fatal("save must atomically queue organization")
	}
	// Repeated manual restart reuses the same live input run.
	retried := user.do("POST", "/collections/"+id+"/organization", nil, uuid.NewString()).want(t, 202)
	if retried["run_id"] != org["run_id"] {
		t.Fatal("duplicate active run")
	}
	user.do("PUT", "/collections/"+id+"/ai-exclusion", map[string]any{"excluded": true}, "").want(t, 200)
	user.do("POST", "/collections/"+id+"/organization", nil, uuid.NewString()).want(t, 403)
	user.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": false}, "").want(t, 200)
	user.do("GET", "/me/usage", nil, "").want(t, 200)
}

func TestTextWorkerUsesEvidenceAndPreservesManualDecisions(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := app.BootstrapAdmin(ctx, "worker@example.test", "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	user := newClient(t, app, base)
	user.signIn("worker@example.test")
	user.do("PUT", "/admin/budgets", map[string]any{"base_version": 1, "platform_daily_units": 1000000, "user_daily_units": 1000000, "worker_concurrency": 2}, "").want(t, 200)
	user.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
	p := user.do("POST", "/projects", map[string]any{"name": "同步研究", "description": "研究离线同步", "focus_points": []string{"并发"}}, uuid.NewString()).want(t, 201)
	entered, release := make(chan struct{}, 1), make(chan struct{})
	releaseModel := sync.OnceFunc(func() { close(release) })
	defer releaseModel()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		<-release
		result := map[string]any{"title": "离线同步研究", "summary": "研究收藏中的同步问题", "tag_candidates": []any{}, "project_candidates": []any{map[string]any{"project_id": p["id"], "reason": "原文讨论离线同步", "confidence": 0.8, "evidence": []any{map[string]any{"source_id": "original_text", "quote": "离线同步"}}}}}
		_ = json.NewEncoder(w).Encode(map[string]any{"model": "synthetic-model", "choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": string(jsonBytes(result))}}}, "usage": map[string]any{"prompt_tokens": 100, "completion_tokens": 40}})
	}))
	defer provider.Close()
	cfg := AIConfig{Version: "synthetic-price-v1", MaxAttempts: 1, TimeoutSeconds: 2, MaxInputChars: 1000, Routes: []AIRoute{{Name: "primary", Endpoint: provider.URL + "/v1/chat/completions", Model: "synthetic-model", OutputMode: "json_object", MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 1000000, OutputPrice: 2000000}}}
	client := NewTextClient()
	defer client.Close()
	worker, err := StartTextWorker(ctx, app.Pool, cfg, app.Organizer.Trial, client)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := worker.Stop(shutdown); err != nil {
			t.Error(err)
		}
	}()
	id := uuid.NewString()
	user.do("POST", "/collections", collectionInput(id, "离线同步与冲突处理"), uuid.NewString()).want(t, 201)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("durable worker did not receive job")
	}
	// A manual rejection races the model response; applying must re-read it.
	user.do("PATCH", "/collections/"+id+"/projects", map[string]any{"base_decision_version": 1, "operations": []any{map[string]any{"id": p["id"], "action": "exclude"}}}, "").want(t, 200)
	releaseModel()
	var row map[string]any
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		row = user.do("GET", "/collections/"+id, nil, "").want(t, 200)
		if row["organization"].(map[string]any)["status"] == "succeeded" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if row["organization"].(map[string]any)["status"] != "succeeded" {
		t.Fatal("worker did not complete")
	}
	if row["display_title"] != "离线同步研究" {
		t.Fatal("generated title was not applied")
	}
	if row["projects"].([]any)[0].(map[string]any)["decision"] != "rejected" {
		t.Fatal("model overwrote manual rejection")
	}
	usage := user.do("GET", "/me/usage", nil, "").want(t, 200)
	if usage["settled_units"] != float64(180) || usage["reserved_units"] != float64(0) {
		t.Fatal("actual token usage was not estimated and settled once")
	}
}

func waitOrganization(t *testing.T, user *apiClient, id string, statuses ...string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		row := user.do("GET", "/collections/"+id, nil, "").want(t, 200)
		status := row["organization"].(map[string]any)["status"].(string)
		for _, want := range statuses {
			if status == want {
				return row
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("organization did not reach expected terminal state")
	return nil
}
func TestWorkerRejectsUntrustedCandidates(t *testing.T) {
	for _, kind := range []string{"foreign_project", "false_quote", "unknown_source"} {
		t.Run(kind, func(t *testing.T) {
			app, base := testBackend(t)
			app.Organizer.Enabled = true
			ctx := context.Background()
			if err := app.BootstrapAdmin(ctx, "invalid@example.test", "test-password-12345"); err != nil {
				t.Fatal(err)
			}
			user := newClient(t, app, base)
			user.signIn("invalid@example.test")
			user.do("PUT", "/admin/budgets", map[string]any{"base_version": 1, "platform_daily_units": 1000000, "user_daily_units": 1000000, "worker_concurrency": 1}, "").want(t, 200)
			user.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
			p := user.do("POST", "/projects", map[string]any{"name": "同步", "description": "参考", "focus_points": []string{}}, uuid.NewString()).want(t, 201)
			projectID, quote, source := p["id"].(string), "离线同步", "original_text"
			if kind == "foreign_project" {
				if err := app.BootstrapAdmin(ctx, "foreign@example.test", "test-password-12345"); err != nil {
					t.Fatal(err)
				}
				foreign := newClient(t, app, base)
				foreign.signIn("foreign@example.test")
				projectID = foreign.do("POST", "/projects", map[string]any{"name": "他人项目", "description": "", "focus_points": []string{}}, uuid.NewString()).want(t, 201)["id"].(string)
			}
			if kind == "false_quote" {
				quote = "这段话没有出现在材料中"
			}
			if kind == "unknown_source" {
				source = "project_description"
			}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				result := map[string]any{"title": "不应应用的标题", "tag_candidates": []any{}, "project_candidates": []any{map[string]any{"project_id": projectID, "reason": "依据", "confidence": 0.9, "evidence": []any{map[string]any{"source_id": source, "quote": quote}}}}}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": string(jsonBytes(result))}}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 10}})
			}))
			defer provider.Close()
			cfg := AIConfig{Version: "test-price-v1", MaxAttempts: 1, TimeoutSeconds: 1, MaxInputChars: 1000, Routes: []AIRoute{{Name: "primary", Endpoint: provider.URL + "/v1/chat/completions", Model: "synthetic", OutputMode: "json_object", MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 1, OutputPrice: 1}}}
			client := NewTextClient()
			defer client.Close()
			worker, err := StartTextWorker(ctx, app.Pool, cfg, app.Organizer.Trial, client)
			if err != nil {
				t.Fatal(err)
			}
			defer worker.Stop(ctx)
			id := uuid.NewString()
			user.do("POST", "/collections", collectionInput(id, "离线同步文章"), uuid.NewString()).want(t, 201)
			row := waitOrganization(t, user, id, "failed")
			if row["organization"].(map[string]any)["error_code"] != "invalid_model_output" || len(row["projects"].([]any)) != 0 || row["display_title"] == "不应应用的标题" {
				t.Fatal("untrusted model output reached collection")
			}
		})
	}
}

func TestBudgetRefusalAndUncertainUsageSurviveLimitChanges(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	ctx := context.Background()
	if err := app.BootstrapAdmin(ctx, "budget@example.test", "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	user := newClient(t, app, base)
	user.signIn("budget@example.test")
	user.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
	entered, release := make(chan struct{}, 2), make(chan struct{})
	releaseModel := sync.OnceFunc(func() { close(release) })
	defer releaseModel()
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		entered <- struct{}{}
		<-release
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": `{"title":"有效标题","tag_candidates":[],"project_candidates":[]}`}}}})
	}))
	defer provider.Close()
	cfg := AIConfig{Version: "estimate-v1", MaxAttempts: 1, TimeoutSeconds: 2, MaxInputChars: 1000, Routes: []AIRoute{{Name: "primary", Endpoint: provider.URL + "/v1/chat/completions", Model: "synthetic", OutputMode: "json_object", MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 1000000, OutputPrice: 2000000}}}
	client := NewTextClient()
	defer client.Close()
	worker, err := StartTextWorker(ctx, app.Pool, cfg, app.Organizer.Trial, client)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Stop(ctx)
	id := uuid.NewString()
	user.do("POST", "/collections", collectionInput(id, "预算为零仍可靠保存"), uuid.NewString()).want(t, 201)
	waitOrganization(t, user, id, "blocked")
	if calls.Load() != 0 {
		t.Fatal("zero budget allowed a model request")
	}
	user.do("POST", "/collections/"+id+"/organization", nil, uuid.NewString()).want(t, 429)
	user.do("PUT", "/admin/budgets", map[string]any{"base_version": 1, "platform_daily_units": 1000000, "user_daily_units": 1000000, "worker_concurrency": 2}, "").want(t, 200)
	user.do("POST", "/collections/"+id+"/organization", nil, uuid.NewString()).want(t, 202)
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("updated daily limit did not permit a new reservation")
	}
	before := user.do("GET", "/me/usage", nil, "").want(t, 200)["reserved_units"].(float64)
	if before <= 0 {
		t.Fatal("model call was not reserved")
	}
	user.do("PUT", "/admin/budgets", map[string]any{"base_version": 2, "platform_daily_units": 0, "user_daily_units": 0, "worker_concurrency": 2}, "").want(t, 200)
	during := user.do("GET", "/me/usage", nil, "").want(t, 200)
	if during["reserved_units"] != before {
		t.Fatal("lowering budget erased in-flight reservation")
	}
	second := uuid.NewString()
	user.do("POST", "/collections", collectionInput(second, "并发第二条"), uuid.NewString()).want(t, 201)
	waitOrganization(t, user, second, "blocked")
	if calls.Load() != 1 {
		t.Fatal("budget reduction allowed another charged request")
	}
	releaseModel()
	waitOrganization(t, user, id, "partial")
	after := user.do("GET", "/me/usage", nil, "").want(t, 200)
	if after["reserved_units"] != before || after["settled_units"] != float64(0) {
		t.Fatal("missing usage was treated as a free request")
	}
	// A versioned increase applies to new same-day reservations; prior uncertain money remains held.
	user.do("PUT", "/admin/budgets", map[string]any{"base_version": 3, "platform_daily_units": 1000000, "user_daily_units": 1000000, "worker_concurrency": 2}, "").want(t, 200)
	user.do("POST", "/collections/"+second+"/organization", nil, uuid.NewString()).want(t, 202)
	waitOrganization(t, user, second, "partial")
	if calls.Load() != 2 {
		t.Fatal("increased same-day budget did not become effective")
	}
	after = user.do("GET", "/me/usage", nil, "").want(t, 200)
	if after["reserved_units"].(float64) <= before {
		t.Fatal("new reservation replaced prior uncertain amount")
	}
}

func TestWorkerFailoverOnlyForKnownSafeFailures(t *testing.T) {
	for _, kind := range []string{"auth_rejected", "sent_timeout"} {
		t.Run(kind, func(t *testing.T) {
			app, base := testBackend(t)
			app.Organizer.Enabled = true
			ctx := context.Background()
			if err := app.BootstrapAdmin(ctx, "fallback@example.test", "test-password-12345"); err != nil {
				t.Fatal(err)
			}
			user := newClient(t, app, base)
			user.signIn("fallback@example.test")
			user.do("PUT", "/admin/budgets", map[string]any{"base_version": 1, "platform_daily_units": 1000000, "user_daily_units": 1000000, "worker_concurrency": 1}, "").want(t, 200)
			user.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
			var firstCalls, backupCalls atomic.Int32
			primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				firstCalls.Add(1)
				_, _ = io.Copy(io.Discard, r.Body)
				if kind == "auth_rejected" {
					w.WriteHeader(401)
					return
				}
				<-r.Context().Done()
			}))
			defer primary.Close()
			backup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				backupCalls.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": `{"title":"备用结果","tag_candidates":[],"project_candidates":[]}`}}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 10}})
			}))
			defer backup.Close()
			cfg := AIConfig{Version: "fallback-price-v1", MaxAttempts: 2, TimeoutSeconds: 1, MaxInputChars: 1000, Routes: []AIRoute{{Name: "primary", Endpoint: primary.URL + "/v1/chat/completions", Model: "synthetic-primary", OutputMode: "json_object", MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 1000000, OutputPrice: 2000000}, {Name: "backup", Endpoint: backup.URL + "/v1/chat/completions", Model: "synthetic-backup", OutputMode: "json_object", MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 2000000, OutputPrice: 3000000}}}
			client := NewTextClient()
			defer client.Close()
			worker, err := StartTextWorker(ctx, app.Pool, cfg, app.Organizer.Trial, client)
			if err != nil {
				t.Fatal(err)
			}
			defer worker.Stop(ctx)
			id := uuid.NewString()
			user.do("POST", "/collections", collectionInput(id, "安全故障切换测试"), uuid.NewString()).want(t, 201)
			if kind == "auth_rejected" {
				waitOrganization(t, user, id, "succeeded")
				usage := user.do("GET", "/me/usage", nil, "").want(t, 200)
				if firstCalls.Load() != 1 || backupCalls.Load() != 1 || usage["settled_units"] != float64(50) || usage["reserved_units"] != float64(0) {
					t.Fatal("safe failover did not settle exactly the backup attempt")
				}
				next := uuid.NewString()
				user.do("POST", "/collections", collectionInput(next, "停用路由后的下一条"), uuid.NewString()).want(t, 201)
				waitOrganization(t, user, next, "succeeded")
				if firstCalls.Load() != 1 || backupCalls.Load() != 2 {
					t.Fatal("authentication failure did not disable route")
				}
			} else {
				row := waitOrganization(t, user, id, "failed")
				usage := user.do("GET", "/me/usage", nil, "").want(t, 200)
				if row["organization"].(map[string]any)["error_code"] != "provider_timeout" || backupCalls.Load() != 0 || usage["reserved_units"].(float64) <= 0 {
					t.Fatal("ambiguous timeout was retried as if free")
				}
			}
		})
	}
}

func TestWorkerDoesNotApplyObsoleteInputsOrRevokedConsent(t *testing.T) {
	for _, action := range []string{"edit", "toggle_consent", "exclude", "trash"} {
		t.Run(action, func(t *testing.T) {
			app, base := testBackend(t)
			app.Organizer.Enabled = true
			ctx := context.Background()
			if err := app.BootstrapAdmin(ctx, "race@example.test", "test-password-12345"); err != nil {
				t.Fatal(err)
			}
			user := newClient(t, app, base)
			user.signIn("race@example.test")
			user.do("PUT", "/admin/budgets", map[string]any{"base_version": 1, "platform_daily_units": 1000000, "user_daily_units": 1000000, "worker_concurrency": 1}, "").want(t, 200)
			user.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
			entered, release := make(chan struct{}, 2), make(chan struct{})
			releaseModel := sync.OnceFunc(func() { close(release) })
			defer releaseModel()
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					Messages []struct {
						Content string `json:"content"`
					} `json:"messages"`
				}
				_ = json.NewDecoder(r.Body).Decode(&request)
				entered <- struct{}{}
				<-release
				title := "旧版本标题"
				if len(request.Messages) > 1 && strings.Contains(request.Messages[1].Content, "新材料") {
					title = "新材料标题"
				}
				result := map[string]any{"title": title, "tag_candidates": []any{}, "project_candidates": []any{}}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": string(jsonBytes(result))}}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 10}})
			}))
			defer provider.Close()
			cfg := AIConfig{Version: "race-estimate-v1", MaxAttempts: 1, TimeoutSeconds: 2, MaxInputChars: 1000, Routes: []AIRoute{{Name: "primary", Endpoint: provider.URL + "/v1/chat/completions", Model: "synthetic", OutputMode: "json_object", MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 1000000, OutputPrice: 1000000}}}
			client := NewTextClient()
			defer client.Close()
			worker, err := StartTextWorker(ctx, app.Pool, cfg, app.Organizer.Trial, client)
			if err != nil {
				t.Fatal(err)
			}
			defer worker.Stop(ctx)
			id := uuid.NewString()
			saved := user.do("POST", "/collections", collectionInput(id, "旧材料"), uuid.NewString()).want(t, 201)
			oldRun := saved["organization"].(map[string]any)["run_id"].(string)
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("model did not start")
			}
			switch action {
			case "edit":
				user.do("PATCH", "/collections/"+id, map[string]any{"base_content_version": 1, "document": textDocument("新材料")}, "").want(t, 200)
			case "toggle_consent":
				user.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": false}, "").want(t, 200)
				user.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
			case "exclude":
				user.do("PUT", "/collections/"+id+"/ai-exclusion", map[string]any{"excluded": true}, "").want(t, 200)
			case "trash":
				user.do("DELETE", "/collections/"+id, map[string]any{"base_resource_version": 1}, "").want(t, 200)
			}
			releaseModel()
			var row map[string]any
			if action == "edit" {
				row = waitOrganization(t, user, id, "succeeded")
				if row["display_title"] != "新材料标题" {
					t.Fatal("obsolete content result replaced new content")
				}
			} else {
				row = waitOrganization(t, user, id, "superseded", "skipped")
				if row["display_title"] == "旧版本标题" {
					t.Fatal("revoked authorization still applied model result")
				}
			}
			var applied *time.Time
			if err := app.Pool.QueryRow(ctx, `SELECT applied_at FROM organization_runs WHERE id=$1`, oldRun).Scan(&applied); err != nil {
				t.Fatal(err)
			}
			if applied != nil {
				t.Fatal("obsolete run was marked applied")
			}
			if user.do("GET", "/me/usage", nil, "").want(t, 200)["settled_units"].(float64) < 20 {
				t.Fatal("obsolete charged attempt lost its usage")
			}
		})
	}
}

func TestConcurrentUsersCannotOverReservePlatformBudget(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	ctx := context.Background()
	users := []*apiClient{}
	for _, email := range []string{"budget-a@example.test", "budget-b@example.test"} {
		if err := app.BootstrapAdmin(ctx, email, "test-password-12345"); err != nil {
			t.Fatal(err)
		}
		u := newClient(t, app, base)
		u.signIn(email)
		u.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
		users = append(users, u)
	}
	users[0].do("PUT", "/admin/budgets", map[string]any{"base_version": 1, "platform_daily_units": 500, "user_daily_units": 500, "worker_concurrency": 2}, "").want(t, 200)
	release := make(chan struct{})
	releaseModel := sync.OnceFunc(func() { close(release) })
	defer releaseModel()
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		calls.Add(1)
		<-release
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": `{"title":"预算并发结果","tag_candidates":[],"project_candidates":[]}`}}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 10}})
	}))
	defer provider.Close()
	cfg := AIConfig{Version: "platform-estimate-v1", MaxAttempts: 1, TimeoutSeconds: 2, MaxInputChars: 1000, Routes: []AIRoute{{Name: "primary", Endpoint: provider.URL + "/v1/chat/completions", Model: "synthetic", OutputMode: "json_object", MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 0, OutputPrice: 1000000}}}
	client := NewTextClient()
	defer client.Close()
	worker, err := StartTextWorker(ctx, app.Pool, cfg, app.Organizer.Trial, client)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Stop(ctx)
	ids := []string{uuid.NewString(), uuid.NewString()}
	var wg sync.WaitGroup
	for i := range users {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			users[i].do("POST", "/collections", collectionInput(ids[i], "同时争取平台额度"), uuid.NewString()).want(t, 201)
		}(i)
	}
	wg.Wait()
	blocked := false
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for i, u := range users {
			row := u.do("GET", "/collections/"+ids[i], nil, "").want(t, 200)
			if row["organization"].(map[string]any)["status"] == "blocked" {
				blocked = true
			}
		}
		if blocked {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !blocked || calls.Load() != 1 {
		t.Fatal("shared platform budget allowed concurrent overspend")
	}
	total := float64(0)
	for _, u := range users {
		total += u.do("GET", "/me/usage", nil, "").want(t, 200)["reserved_units"].(float64)
	}
	if total != 500 {
		t.Fatal("platform reservation exceeded one attempt")
	}
	releaseModel()
}

func TestRecoveredUnknownAttemptDoesNotCallModelAgain(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	ctx := context.Background()
	if err := app.BootstrapAdmin(ctx, "recover@example.test", "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	user := newClient(t, app, base)
	user.signIn("recover@example.test")
	uid := user.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	user.do("PUT", "/admin/budgets", map[string]any{"base_version": 1, "platform_daily_units": 1000000, "user_daily_units": 1000000, "worker_concurrency": 1}, "").want(t, 200)
	user.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
	id := uuid.NewString()
	saved := user.do("POST", "/collections", collectionInput(id, "恢复合成任务"), uuid.NewString()).want(t, 201)
	run := saved["organization"].(map[string]any)["run_id"].(string)
	// Fault injection at the external-call boundary: a former process reserved
	// money, then disappeared before recording whether the request was charged.
	tx, err := app.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE organization_runs SET status='running',attempts=1 WHERE id=$1`, run); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO usage_reservations(id,user_id,run_id,attempt_no,budget_day,route,config_version,model,reserved_units,state) VALUES($1,$2,$3,1,$4::date,'primary','recovery-v1','synthetic',100,'reserved')`, uuid.NewString(), uid, run, budgetDay()); err != nil {
		t.Fatal(err)
	}
	for _, scope := range []string{"platform", "user"} {
		owner := "platform"
		if scope == "user" {
			owner = uid
		}
		if _, err = tx.Exec(ctx, `INSERT INTO daily_budgets(scope,owner_key,budget_day,reserved_units) VALUES($1,$2,$3::date,100)`, scope, owner, budgetDay()); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	defer provider.Close()
	cfg := AIConfig{Version: "recovery-v1", MaxAttempts: 1, TimeoutSeconds: 1, MaxInputChars: 1000, Routes: []AIRoute{{Name: "primary", Endpoint: provider.URL + "/v1/chat/completions", Model: "synthetic", OutputMode: "json_object", MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 1, OutputPrice: 1}}}
	client := NewTextClient()
	defer client.Close()
	worker, err := StartTextWorker(ctx, app.Pool, cfg, app.Organizer.Trial, client)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Stop(ctx)
	row := waitOrganization(t, user, id, "failed")
	if row["organization"].(map[string]any)["error_code"] != "usage_uncertain" || calls.Load() != 0 {
		t.Fatal("recovered uncertain attempt was sent again")
	}
	usage := user.do("GET", "/me/usage", nil, "").want(t, 200)
	if usage["reserved_units"] != float64(100) {
		t.Fatal("crash recovery released uncertain money")
	}
	var state string
	if err = app.Pool.QueryRow(ctx, `SELECT state FROM usage_reservations WHERE run_id=$1`, run).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "uncertain" {
		t.Fatal("unresolved reservation was not marked uncertain")
	}
}
