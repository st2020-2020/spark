package backend

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

func TestWebArchiveRequestDisablesThinkingOnlyOnOfficialFlash(t *testing.T) {
	for _, tc := range []struct {
		name, endpoint, model string
		web, disable          bool
	}{
		{"official web archive", "https://api.deepseek.com/chat/completions", "deepseek-flash", true, true},
		{"ordinary text", "https://api.deepseek.com/chat/completions", "deepseek-flash", false, false},
		{"other model", "https://api.deepseek.com/chat/completions", "deepseek-v4-pro", true, false},
		{"compatible gateway", "https://api.deepseek.com.example.test/chat/completions", "deepseek-flash", true, false},
		{"non-HTTPS", "http://api.deepseek.com/chat/completions", "deepseek-flash", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			route := AIRoute{Endpoint: tc.endpoint, Model: tc.model, OutputMode: "json_object", MaxOutputTokens: 2048, MaxContextTokens: 32768}
			payload, upper, _, err := modelPayload(route, AIConfig{}, textInput{webArchive: tc.web, createTags: tc.web,
				Sources: []textSource{{ID: "original_text"}, {ID: "intent"}, {ID: "page_title", Text: "温室滴灌手册"}}})
			if err != nil {
				t.Fatal(err)
			}
			var body struct {
				Thinking  *struct{ Type string }
				MaxTokens int `json:"max_tokens"`
				Messages  []struct{ Content string }
			}
			if err := json.Unmarshal(payload, &body); err != nil {
				t.Fatal(err)
			}
			if body.MaxTokens != 2048 || upper != int64(len(payload)+1024) || (body.Thinking != nil) != tc.disable ||
				tc.disable && body.Thinking.Type != "disabled" {
				t.Fatal("request changed the cap/accounting or used the wrong thinking policy")
			}
			if tc.web && !strings.Contains(body.Messages[0].Content, "one compact JSON object") {
				t.Fatal("web archive did not request compact JSON")
			}
		})
	}
}

func TestWebArchiveSettledRecovery(t *testing.T) {
	for _, legacy := range []bool{true, false} {
		name := "diagnosed truncation"
		if legacy {
			name = "legacy settled format failure"
		}
		t.Run(name, func(t *testing.T) {
			app, base := testBackend(t)
			app.Organizer.Enabled = true
			admin := imageTestAccount(t, app, base, "web-recovery-budget")
			setImageTestBudget(admin, 1, 50_000, 25_000)
			owner := signedExportAccount(t, app, base, "web-recovery-owner")
			other := signedExportAccount(t, app, base, "web-recovery-other")
			owner.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": extensionArchiveConsentVersion}, "").want(t, 200)
			ext := newClient(t, app, base)
			headers := extensionHeaders(t, exchangeTestExtension(ext, approveTestExtension(t, owner)))

			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				input := readImageTextRequest(t, r)
				if len(input.Sources) != 3 || input.Sources[2].Text != "温室滴灌手册" {
					t.Error("model saw unexpected source material")
				}
				if calls.Add(1) == 1 {
					if legacy {
						// Old run format failures with known usage carried this code on both rows.
						modelReply(w, "content_filter", "", map[string]int{"prompt_tokens": 2048, "completion_tokens": 2048})
					} else {
						modelReply(w, "length", `{"title":"not complete`, map[string]int{"prompt_tokens": 2048, "completion_tokens": 2048})
					}
					return
				}
				modelReply(w, "stop", `{"title":"温室滴灌手册","tag_candidates":[],"project_candidates":[],"topic_candidate":{"name":"温室滴灌","reason":"同一主题","evidence":[{"source_id":"page_title","quote":"温室滴灌"}]}}`,
					map[string]int{"prompt_tokens": 101, "completion_tokens": 60})
			}))
			t.Cleanup(provider.Close)
			client := NewTextClient()
			t.Cleanup(client.Close)
			cfg := AIConfig{Version: "web-recovery-test", MaxAttempts: 3, TimeoutSeconds: 2, MaxInputChars: 1000,
				Routes: []AIRoute{{Name: "text", Endpoint: provider.URL + "/chat/completions", Model: "synthetic-text",
					OutputMode: "json_object", MaxOutputTokens: 2048, MaxContextTokens: 32768, InputPrice: 1_000_000, OutputPrice: 2_000_000}}}
			worker, err := StartTextWorker(t.Context(), app.Pool, cfg, app.Organizer.Trial, client)
			if err != nil {
				t.Fatal(err)
			}
			stopImageTestWorker(t, worker)

			id := uuid.NewString()
			path := "/collections/" + id
			ext.withHeaders("POST", "/extension/collections", map[string]any{
				"id": id, "original_url": "https://example.test/private-session-url", "manual_title": "温室滴灌手册", "project_ids": []string{},
			}, uuid.NewString(), headers).want(t, 201)
			row := waitOrganization(t, owner.apiClient, id, "failed")
			original := row["organization"].(map[string]any)["run_id"]
			wantCode := modelOutputTruncated
			if legacy {
				wantCode = "invalid_model_output"
				if _, err := app.Pool.Exec(t.Context(), `UPDATE organization_runs SET web_archive_decision_version=NULL WHERE user_id=$1 AND id=$2`, owner.uid, original); err != nil {
					t.Fatal(err)
				}
			}
			if row["organization"].(map[string]any)["error_code"] != wantCode {
				t.Fatal("unexpected original failure status")
			}
			org := owner.do("GET", path+"/organization", nil, "").want(t, 200)
			if org["web_archive_recovery_available"] != true || org["web_archive_retry_available"] != false || calls.Load() != 1 {
				t.Fatal("read did not report the settled failure as eligible")
			}
			for _, endpoint := range []string{"/organization", "/organization/web-archive"} {
				if run := owner.do("POST", path+endpoint, nil, uuid.NewString()).want(t, 202)["run_id"]; run != original {
					t.Fatal("an old client implicitly started a paid recovery")
				}
			}

			recoverPath := path + "/organization/web-archive/recover"
			req := map[string]any{"run_id": original, "base_decision_version": 1}
			other.do("POST", recoverPath, req, uuid.NewString()).want(t, 404)
			extensionError(t, owner.do("POST", recoverPath, map[string]any{"run_id": original, "base_decision_version": 2},
				uuid.NewString()), 409, "decision_conflict")
			setImageTestBudget(admin, 2, 0, 0)
			extensionError(t, owner.do("POST", recoverPath, req, uuid.NewString()), 429, "quota_exceeded")

			// Leave some quota, below the actual per-route dispatch reservation.
			// The API can register this intent, and the worker must block before sending.
			setImageTestBudget(admin, 3, 50_000, 6145)
			keys := []string{uuid.NewString(), uuid.NewString()}
			var submitted [2]apiResponse
			var group sync.WaitGroup
			for i, key := range keys {
				group.Go(func() { submitted[i] = owner.do("POST", recoverPath, req, key) })
			}
			group.Wait()
			var recovery, winningKey string
			for i, res := range submitted {
				if res.status == 202 {
					if recovery != "" {
						t.Fatal("two keys accepted the same recovery")
					}
					recovery, winningKey = res.want(t, 202)["run_id"].(string), keys[i]
					continue
				}
				extensionError(t, res, 409, "web_archive_recovery_unavailable")
			}
			if recovery == "" || recovery == original {
				t.Fatal("recovery did not get a separate run")
			}
			replay := owner.do("POST", recoverPath, req, winningKey)
			if replay.want(t, 202)["run_id"] != recovery || replay.header.Get("Idempotent-Replayed") != "true" {
				t.Fatal("network replay did not recover the original receipt")
			}
			blocked := waitOrganization(t, owner.apiClient, id, "blocked")["organization"].(map[string]any)
			if blocked["error_code"] != "quota_exceeded" || blocked["web_archive_recovery_available"] != true ||
				blocked["web_archive_retry_available"] != false || calls.Load() != 1 {
				t.Fatal("zero-dispatch recovery did not stay explicitly recoverable")
			}
			setImageTestBudget(admin, 4, 50_000, 25_000)
			requeue := map[string]any{"run_id": recovery, "base_decision_version": 1}
			key := uuid.NewString()
			if row := owner.do("POST", recoverPath, requeue, key).want(t, 202); row["run_id"] != recovery {
				t.Fatal("budget retry created a different run")
			}
			owner.do("POST", recoverPath, requeue, key).want(t, 202)
			filed := waitOrganization(t, owner.apiClient, id, "succeeded")
			project := filed["projects"].([]any)[0].(map[string]any)
			if project["decision"] != "auto" || project["name"] != "温室滴灌" ||
				filed["organization"].(map[string]any)["web_archive_recovery_available"] == true {
				t.Fatal("confirmed recovery did not file the note or offer only one recovery")
			}
			items := owner.do("GET", "/collections?project_id="+project["project_id"].(string), nil, "").want(t, 200)["items"].([]any)
			if len(items) != 1 || items[0].(map[string]any)["id"] != id {
				t.Fatal("the project did not contain the recovered collection")
			}
			owner.do("POST", recoverPath, requeue, uuid.NewString()).want(t, 409)
			var originalCount, recoveryCount int
			err = app.Pool.QueryRow(t.Context(), `SELECT
				count(*) FILTER (WHERE run_id=$2 AND state='settled' AND error_code=$4 AND actual_units=6144),
				count(*) FILTER (WHERE run_id=$3 AND state='settled' AND error_code IS NULL AND actual_units=221)
				FROM usage_reservations WHERE user_id=$1`, owner.uid, original, recovery, wantCode).Scan(&originalCount, &recoveryCount)
			if err != nil || originalCount != 1 || recoveryCount != 1 || calls.Load() != 2 {
				t.Fatalf("expected exactly two independent settlements: %d,%d calls=%d err=%v", originalCount, recoveryCount, calls.Load(), err)
			}
		})
	}
}

func TestWebArchiveRecoveryDistinguishesUnsentUnknownAndManualDecisions(t *testing.T) {
	app, base := testBackend(t)
	owner := signedExportAccount(t, app, base, "web-recovery-protected")
	admin := imageTestAccount(t, app, base, "web-recovery-guard-budget")
	setImageTestBudget(admin, 1, 50_000, 25_000)
	owner.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": extensionArchiveConsentVersion}, "").want(t, 200)
	// Save as ordinary Web notes, then explicitly request the webpage variant.
	id, ordinaryID := uuid.NewString(), uuid.NewString()
	for _, id := range []string{id, ordinaryID} {
		body := collectionInput(id, "温室滴灌周记")
		body["original_url"] = "https://example.test/synthetic"
		owner.do("POST", "/collections", body, uuid.NewString()).want(t, 201)
	}
	app.Organizer.Enabled = true
	path := "/collections/" + id + "/organization"
	ordinaryPath := "/collections/" + ordinaryID + "/organization"
	run := owner.do("POST", path+"/web-archive", nil, uuid.NewString()).want(t, 202)["run_id"].(string)
	ordinary := owner.do("POST", ordinaryPath, nil, uuid.NewString()).want(t, 202)["run_id"]
	ctx := t.Context()
	if _, err := app.Pool.Exec(ctx, `UPDATE organization_runs SET status='failed',error_code='queue_expired'
		WHERE user_id=$1 AND id IN ($2,$3)`, owner.uid, run, ordinary); err != nil {
		t.Fatal(err)
	}
	if got := owner.do("GET", path, nil, "").want(t, 200); got["web_archive_retry_available"] != true ||
		got["web_archive_recovery_available"] == true {
		t.Fatal("unsent archive should offer only the ordinary retry")
	}
	if got := owner.do("GET", ordinaryPath, nil, "").want(t, 200); got["web_archive_retry_available"] != nil {
		t.Fatal("ordinary organization response exposed a web archive discriminator")
	}
	if _, err := app.Pool.Exec(ctx, `UPDATE organization_runs SET error_code=$3,attempts=1 WHERE user_id=$1 AND id=$2`,
		owner.uid, run, modelOutputTruncated); err != nil {
		t.Fatal(err)
	}
	if _, err := app.Pool.Exec(ctx, `INSERT INTO usage_reservations
		(id,user_id,run_id,attempt_no,budget_day,route,config_version,model,reserved_units,state,error_code)
		VALUES($1,$2,$3,1,current_date,'synthetic','synthetic','synthetic',10,'uncertain',$4)`, uuid.New(), owner.uid, run, modelOutputTruncated); err != nil {
		t.Fatal(err)
	}
	if got := owner.do("GET", path, nil, "").want(t, 200); got["web_archive_recovery_available"] == true ||
		got["web_archive_retry_available"] != false {
		t.Fatal("unknown usage exposed a retry")
	}
	req := map[string]any{"run_id": run, "base_decision_version": 1}
	recoverPath := path + "/web-archive/recover"
	extensionError(t, owner.do("POST", recoverPath, req, uuid.NewString()), 409, "web_archive_recovery_unavailable")
	if returned := owner.do("POST", path, nil, uuid.NewString()).want(t, 202)["run_id"]; returned != run {
		t.Fatal("ordinary restart bypassed archive confirmation for a Web-created note")
	}
	if _, err := app.Pool.Exec(ctx, `UPDATE usage_reservations SET state='settled',input_tokens=100,output_tokens=20,actual_units=10
		WHERE user_id=$1 AND run_id=$2`, owner.uid, run); err != nil {
		t.Fatal(err)
	}
	if got := owner.do("GET", path, nil, "").want(t, 200); got["web_archive_recovery_available"] != true {
		t.Fatal("settled control was not eligible")
	}
	project := projectForNote(t, owner.apiClient, "试验水培")
	for i, action := range []string{"include", "reset"} {
		owner.do("PATCH", "/collections/"+id+"/projects", map[string]any{
			"base_decision_version": i + 1, "operations": []any{map[string]string{"id": project, "action": action}},
		}, "").want(t, 200)
	}
	req["base_decision_version"] = 3
	extensionError(t, owner.do("POST", recoverPath, req, uuid.NewString()), 409, "web_archive_recovery_unavailable")
	owner.do("PUT", "/collections/"+id+"/ai-exclusion", map[string]bool{"excluded": true}, "").want(t, 200)
	extensionError(t, owner.do("POST", recoverPath, req, uuid.NewString()), 403, "ai_excluded")
	owner.do("PUT", "/collections/"+id+"/ai-exclusion", map[string]bool{"excluded": false}, "").want(t, 200)
	owner.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": textTagConsentVersion}, "").want(t, 200)
	extensionError(t, owner.do("POST", recoverPath, req, uuid.NewString()), 403, "web_archive_consent_required")
}
