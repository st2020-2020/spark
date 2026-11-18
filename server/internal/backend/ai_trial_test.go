package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestAITrialScopeConfiguration(t *testing.T) {
	allowed := uuid.NewString()
	scope, err := ParseAITrialScope("production", " "+strings.ToUpper(allowed)+", "+uuid.NewString())
	if err != nil || !scope.allows(allowed) || scope.allows(uuid.NewString()) {
		t.Fatal("production scope must match only configured UUIDs")
	}
	empty, err := ParseAITrialScope("production", "")
	if err != nil || empty.allows(allowed) {
		t.Fatal("empty production scope must deny all accounts")
	}
	for _, invalid := range []string{"trial@example.test", "*", uuid.Nil.String(), allowed + ","} {
		if _, err := ParseAITrialScope("production", invalid); err == nil {
			t.Fatal("invalid production scope accepted")
		}
	}
	development, err := ParseAITrialScope("development", "")
	if err != nil || !development.allows(allowed) {
		t.Fatal("existing development setup should work without a trial scope")
	}
}

func TestAITrialBlocksNewJobsAndPreviouslyQueuedOutboundCalls(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	ctx := context.Background()
	accounts := make([]*apiClient, 0, 2)
	for _, email := range []string{"trial-allowed@example.test", "trial-outside@example.test"} {
		if err := app.BootstrapAdmin(ctx, email, "test-password-12345"); err != nil {
			t.Fatal(err)
		}
		account := newClient(t, app, base)
		account.signIn(email)
		account.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
		accounts = append(accounts, account)
	}
	allowed, outside := accounts[0], accounts[1]
	allowed.do("PUT", "/admin/budgets", map[string]any{"base_version": 1, "platform_daily_units": 1000000, "user_daily_units": 1000000, "worker_concurrency": 1}, "").want(t, 200)

	// An old API instance admitted this job before the scope was narrowed.
	oldID := uuid.NewString()
	old := outside.do("POST", "/collections", collectionInput(oldID, "旧队列的合成材料"), uuid.NewString()).want(t, 201)
	if old["organization"].(map[string]any)["status"] != "queued" {
		t.Fatal("fixture did not create a durable queued job")
	}
	allowedID := allowed.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	trial, err := ParseAITrialScope("production", allowedID)
	if err != nil {
		t.Fatal(err)
	}
	app.Organizer.Trial = trial
	newID := uuid.NewString()
	newCollection := outside.do("POST", "/collections", collectionInput(newID, "新收藏仍应保存"), uuid.NewString()).want(t, 201)
	organization := newCollection["organization"].(map[string]any)
	if organization["status"] != "skipped" || organization["error_code"] != aiTrialUnavailable || organization["run_id"] != nil {
		t.Fatal("out-of-scope account saved a new organization run")
	}
	outside.do("PATCH", "/collections/"+newID, map[string]any{"base_content_version": 1, "intent": "编辑后的用途"}, "").want(t, 200)
	restart := outside.do("POST", "/collections/"+oldID+"/organization", nil, uuid.NewString()).want(t, 403)
	if restart["error"].(map[string]any)["code"] != aiTrialUnavailable {
		t.Fatal("manual restart did not enforce the trial scope")
	}

	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": `{"title":"合成试用标题","tag_candidates":[],"project_candidates":[]}`}}},
			"usage":   map[string]any{"prompt_tokens": 10, "completion_tokens": 10},
		})
	}))
	defer provider.Close()
	cfg := AIConfig{Version: "trial-test", MaxAttempts: 1, TimeoutSeconds: 2, MaxInputChars: 1000, Routes: []AIRoute{{Name: "primary", Endpoint: provider.URL + "/v1/chat/completions", Model: "synthetic", OutputMode: "json_object", MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 1000000, OutputPrice: 1000000}}}
	client := NewTextClient()
	defer client.Close()
	worker, err := StartTextWorker(ctx, app.Pool, cfg, trial, client)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		shutdown, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if err := worker.Stop(shutdown); err != nil {
			t.Error(err)
		}
	}()

	old = waitOrganization(t, outside, oldID, "skipped")
	if old["organization"].(map[string]any)["error_code"] != aiTrialUnavailable || calls.Load() != 0 {
		t.Fatal("worker sent previously queued material outside the trial scope")
	}
	usage := outside.do("GET", "/me/usage", nil, "").want(t, 200)
	if usage["reserved_units"] != float64(0) || usage["settled_units"] != float64(0) {
		t.Fatal("out-of-scope job affected the budget")
	}
	inID := uuid.NewString()
	allowed.do("POST", "/collections", collectionInput(inID, "入选账号的合成材料"), uuid.NewString()).want(t, 201)
	waitOrganization(t, allowed, inID, "succeeded")
	if calls.Load() != 1 {
		t.Fatal("expected exactly one call to the local test endpoint")
	}
}
