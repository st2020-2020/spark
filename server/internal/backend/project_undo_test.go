package backend

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestProjectDecisionNoChangeReplayReadsCurrentCollection(t *testing.T) {
	app, base := testBackend(t)
	ctx := t.Context()
	if err := app.BootstrapAdmin(ctx, "no-change@example.test", "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	user := newClient(t, app, base)
	user.signIn("no-change@example.test")
	uid := user.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"]
	project := user.do("POST", "/projects", map[string]any{"name": "项目", "description": "", "focus_points": []string{}}, uuid.NewString()).want(t, 201)["id"]
	id := uuid.NewString()
	collection := "/collections/" + id
	path := collection + "/projects"
	user.do("POST", "/collections", collectionInput(id, strings.Repeat("原文", 4000)), uuid.NewString()).want(t, 201)
	decide := func(version int, action string) map[string]any {
		return map[string]any{"base_decision_version": version, "operations": []any{map[string]any{"id": project, "action": action}}}
	}
	user.do("PATCH", path, decide(1, "include"), "").want(t, 200)
	key, legacyKey := uuid.NewString(), uuid.NewString()
	body := decide(2, "include")
	initial := user.do("PATCH", path, body, key).want(t, 200)
	if initial["undo_receipt"] != nil || initial["decision_version"] != float64(2) {
		t.Fatal("unchanged decision produced a receipt or changed the version")
	}
	var size int
	operation := "PATCH /api/v1" + path
	if err := app.Pool.QueryRow(ctx, `SELECT octet_length(response_json::text)
		FROM idempotency_keys WHERE user_id=$1 AND operation=$2 AND key=$3`, uid, operation, key).Scan(&size); err != nil {
		t.Fatal(err)
	}
	if size > 128 {
		t.Fatalf("unchanged decision stored %d bytes of response data", size)
	}
	// A row written by the earlier snapshot format must still replay as-is.
	if _, err := app.Pool.Exec(ctx, `INSERT INTO idempotency_keys(user_id,operation,key,request_digest,response_status,response_json)
		SELECT user_id,operation,$4,request_digest,response_status,$5 FROM idempotency_keys
		WHERE user_id=$1 AND operation=$2 AND key=$3`, uid, operation, key, legacyKey, jsonBytes(initial)); err != nil {
		t.Fatal(err)
	}
	user.do("PATCH", collection, map[string]any{"base_content_version": 1, "document": textDocument("更新后的正文")}, "").want(t, 200)
	updated := user.do("PATCH", path, decide(2, "exclude"), "").want(t, 200)
	res := user.do("PATCH", path, body, key)
	if got := res.want(t, 200); res.header.Get("Idempotent-Replayed") != "true" || !equalJSON(got, updated) {
		t.Fatal("unchanged decision did not replay with the current collection")
	}
	if got := user.do("PATCH", path, body, legacyKey).want(t, 200); !equalJSON(got, initial) {
		t.Fatal("historical response did not replay its original snapshot")
	}
	if got := user.do("PATCH", path, decide(2, "exclude"), key).want(t, 409); got["error"].(map[string]any)["code"] != "idempotency_mismatch" {
		t.Fatal("same key with a different request was not rejected")
	}
	user.do("DELETE", collection, map[string]any{"base_resource_version": updated["resource_version"]}, "").want(t, 200)
	if got := user.do("PATCH", path, body, key).want(t, 409); got["error"].(map[string]any)["code"] != "collection_in_trash" {
		t.Fatal("unchanged decision replay did not respect the trash boundary")
	}
	if got := user.do("PATCH", path, body, legacyKey).want(t, 409); got["error"].(map[string]any)["code"] != "collection_in_trash" {
		t.Fatal("historical decision replay did not respect the trash boundary")
	}
}

func TestProjectUndoRestoresSuggestionAndManualLinkAtomically(t *testing.T) {
	app, base := testBackend(t)
	ctx := context.Background()
	if err := app.BootstrapAdmin(ctx, "triage@example.test", "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	user := newClient(t, app, base)
	user.signIn("triage@example.test")
	session := user.do("GET", "/auth/session", nil, "").want(t, 200)
	uid := session["user"].(map[string]any)["id"]
	project := func(name string) string {
		t.Helper()
		return user.do("POST", "/projects", map[string]any{"name": name, "description": "", "focus_points": []string{}}, uuid.NewString()).want(t, 201)["id"].(string)
	}
	suggested, manual := project("带引文的建议"), project("手选项目")
	id, run := uuid.NewString(), uuid.NewString()
	user.do("POST", "/collections", collectionInput(id, "测试原文"), uuid.NewString()).want(t, 201)
	if _, err := app.Pool.Exec(ctx, `INSERT INTO organization_runs
		(id,user_id,collection_id,content_version,user_policy_version,collection_policy_version,status,applied_at)
		VALUES ($1,$2,$3,1,1,1,'succeeded',now())`, run, uid, id); err != nil {
		t.Fatal(err)
	}
	if _, err := app.Pool.Exec(ctx, `INSERT INTO collection_projects
		(user_id,collection_id,project_id,decision,reason,evidence,project_version,run_id)
		VALUES ($1,$2,$3,'suggested','保留原因','[{"source_id":"original_text","quote":"原文"}]',1,$4)`, uid, id, suggested, run); err != nil {
		t.Fatal(err)
	}

	path := "/collections/" + id + "/projects"
	stale := map[string]any{"base_decision_version": 1, "operations": []any{
		map[string]any{"id": manual, "action": "include"},
		map[string]any{"id": suggested, "action": "include", "expected_suggestion": map[string]any{"run_id": uuid.NewString(), "project_version": 1}},
	}}
	errResult := user.do("PATCH", path, stale, uuid.NewString()).want(t, 409)
	if errResult["error"].(map[string]any)["code"] != "suggestion_conflict" {
		t.Fatal("PATCH accepted a different suggestion run")
	}
	current := user.do("GET", "/collections/"+id, nil, "").want(t, 200)
	if len(current["projects"].([]any)) != 1 || current["decision_version"] != float64(1) {
		t.Fatal("a stale suggestion committed another operation in the same batch")
	}

	key := uuid.NewString()
	body := map[string]any{"base_decision_version": 1, "operations": []any{
		map[string]any{"id": suggested, "action": "include", "expected_suggestion": map[string]any{"run_id": run, "project_version": 1}},
		map[string]any{"id": manual, "action": "include"},
	}}
	got := user.do("PATCH", path, body, key).want(t, 200)
	receipt, ok := got["undo_receipt"].(map[string]any)
	if !ok || receipt["operation_key"] != key || receipt["decision_version"] != float64(2) {
		t.Fatal("missing undo receipt for committed decisions")
	}
	replay := user.do("PATCH", path, body, key)
	replay.want(t, 200)
	if replay.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("PATCH did not replay the original receipt")
	}
	undo := map[string]any{"operation_key": key, "base_decision_version": 2}
	restored := user.do("POST", path+"/undo", undo, "").want(t, 200)
	result := restored["projects"].([]any)
	if len(result) != 1 || restored["decision_version"] != float64(3) || restored["has_suggestion"] != true {
		t.Fatal("undo did not restore exactly the original suggestion")
	}
	association := result[0].(map[string]any)
	if association["decision"] != "suggested" || association["reason"] != "保留原因" || association["suggestion_run_id"] != run ||
		association["evidence"].([]any)[0].(map[string]any)["quote"] != "原文" {
		t.Fatal("undo lost suggestion provenance")
	}
	response := user.do("POST", path+"/undo", undo, "")
	response.want(t, 200)
	if response.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("undo did not replay the committed response")
	}
	if user.do("GET", "/collections/"+id, nil, "").want(t, 200)["decision_version"] != float64(3) {
		t.Fatal("repeated undo changed the decision version")
	}

	body["base_decision_version"] = 3
	key = uuid.NewString()
	user.do("PATCH", path, body, key).want(t, 200)
	user.do("PATCH", "/projects/"+suggested, map[string]any{"base_version": 1, "name": "更新后的项目"}, "").want(t, 200)
	undo = map[string]any{"operation_key": key, "base_decision_version": 4}
	errResult = user.do("POST", path+"/undo", undo, "").want(t, 409)
	if errResult["error"].(map[string]any)["code"] != "suggestion_conflict" {
		t.Fatal("undo accepted a stale project version")
	}
	current = user.do("GET", "/collections/"+id, nil, "").want(t, 200)
	if len(current["projects"].([]any)) != 2 || current["decision_version"] != float64(4) {
		t.Fatal("a failed undo reverted part of the batch")
	}
}

func TestProjectUndoRejectsStaleAndForeignReceipts(t *testing.T) {
	app, base := testBackend(t)
	ctx := context.Background()
	for _, email := range []string{"triage-owner@example.test", "triage-other@example.test"} {
		if err := app.BootstrapAdmin(ctx, email, "test-password-12345"); err != nil {
			t.Fatal(err)
		}
	}
	owner, other := newClient(t, app, base), newClient(t, app, base)
	owner.signIn("triage-owner@example.test")
	other.signIn("triage-other@example.test")
	project := owner.do("POST", "/projects", map[string]any{"name": "手选项目", "description": "", "focus_points": []string{}}, uuid.NewString()).want(t, 201)["id"]
	makeCollection := func(user *apiClient) string {
		id := uuid.NewString()
		user.do("POST", "/collections", collectionInput(id, "测试原文"), uuid.NewString()).want(t, 201)
		return "/collections/" + id
	}
	assertCode := func(res apiResponse, status int, code string) {
		t.Helper()
		if res.want(t, status)["error"].(map[string]any)["code"] != code {
			t.Fatalf("wanted error code %s", code)
		}
	}

	for _, scenario := range []string{"later decision", "edited content", "expired receipt", "wrong owner or collection"} {
		t.Run(scenario, func(t *testing.T) {
			collection := makeCollection(owner)
			path := collection + "/projects"
			key := uuid.NewString()
			ops := func(action string, version int) map[string]any {
				return map[string]any{"base_decision_version": version, "operations": []any{map[string]any{"id": project, "action": action}}}
			}
			owner.do("PATCH", path, ops("include", 1), key).want(t, 200)
			data := map[string]any{"operation_key": key, "base_decision_version": 2}
			var wantDecision = "manual"
			switch scenario {
			case "later decision":
				assertCode(owner.do("PATCH", path, ops("exclude", 2), key), 409, "idempotency_mismatch")
				owner.do("PATCH", path, ops("exclude", 2), "").want(t, 200)
				assertCode(owner.do("POST", path+"/undo", data, ""), 409, "decision_conflict")
				wantDecision = "rejected"
			case "edited content":
				owner.do("PATCH", collection, map[string]any{"base_content_version": 1, "document": textDocument("修改后的正文")}, "").want(t, 200)
				assertCode(owner.do("POST", path+"/undo", data, ""), 409, "suggestion_conflict")
			case "expired receipt":
				if _, err := app.Pool.Exec(ctx, "UPDATE idempotency_keys SET expires_at=now()-interval '1 second' WHERE key=$1", key); err != nil {
					t.Fatal(err)
				}
				assertCode(owner.do("POST", path+"/undo", data, ""), 409, "undo_unavailable")
			case "wrong owner or collection":
				other.do("POST", path+"/undo", data, "").want(t, 404)
				assertCode(owner.do("POST", makeCollection(owner)+"/projects/undo", data, ""), 409, "undo_unavailable")
				assertCode(other.do("POST", makeCollection(other)+"/projects/undo", data, ""), 409, "undo_unavailable")
				assertCode(owner.withHeaders("POST", path+"/undo", data, "", map[string]string{"X-CSRF-Token": ""}), 403, "csrf_failed")
			}
			current := owner.do("GET", collection, nil, "").want(t, 200)
			if current["projects"].([]any)[0].(map[string]any)["decision"] != wantDecision {
				t.Fatal("failed undo modified the current decision")
			}
		})
	}
}
