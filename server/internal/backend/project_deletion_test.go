package backend

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestDeleteProjectPreservesCollectionsAndRejectsStaleDecisions(t *testing.T) {
	app, base := testBackend(t)
	ctx := t.Context()
	owner := imageTestAccount(t, app, base, "project-delete-owner")
	owner.invite("INVITE-DELETE-0001")
	other := newClient(t, app, base)
	other.csrf = other.do(http.MethodPost, "/auth/register",
		other.registration("project-delete-other@example.test", "INVITE-DELETE-0001"), "").want(t, 201)["csrf_token"].(string)
	uid := owner.do(http.MethodGet, "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	objects, _, storage := newUploadStorageFixture(t)
	app.Assets = storage

	createKey := uuid.NewString()
	project := map[string]any{"name": "旧巡检分类", "description": "", "focus_points": []string{}}
	pid := owner.do(http.MethodPost, "/projects", project, createKey).want(t, 201)["id"].(string)
	kept := owner.do(http.MethodPost, "/projects", map[string]any{
		"name": "保留的分类", "description": "", "focus_points": []string{},
	}, uuid.NewString()).want(t, 201)["id"].(string)
	path := "/projects/" + pid
	owner.do(http.MethodPatch, path, map[string]any{"base_version": 1, "description": "更新过的项目"}, "").want(t, 200)

	upload := confirmedImageTestUpload(t, app, uid, objects)
	cid, trashID, unrelatedID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	note := "/collections/" + cid
	const content = "synthetic note to keep"
	input := collectionInputForUpload(cid, upload)
	input["document"] = textDocument(content)
	input["project_ids"] = []string{pid}
	collectionKey := uuid.NewString()
	saved := owner.do(http.MethodPost, "/collections", input, collectionKey).want(t, 201)
	attachment := saved["attachments"].([]any)[0].(map[string]any)["id"].(string)
	decisionPath := note + "/projects"
	decision := map[string]any{"base_decision_version": 1, "operations": []map[string]any{{"id": kept, "action": "include"}}}
	decisionKey := uuid.NewString()
	associated := owner.do(http.MethodPatch, decisionPath, decision, decisionKey).want(t, 200)
	if associated["undo_receipt"] == nil {
		t.Fatal("project decision did not return an undo receipt")
	}
	trashPath := "/collections/" + trashID
	trash := collectionInput(trashID, "synthetic trash")
	trash["project_ids"] = []string{pid}
	owner.do(http.MethodPost, "/collections", trash, uuid.NewString()).want(t, 201)
	owner.do(http.MethodDelete, trashPath, map[string]any{"base_resource_version": 1}, "").want(t, 200)
	owner.do(http.MethodPost, "/collections", collectionInput(unrelatedID, "synthetic unrelated"), uuid.NewString()).want(t, 201)

	search := "/search?q=synthetic&project_id="
	items := func(path string, n int) {
		t.Helper()
		if got := len(owner.do(http.MethodGet, path, nil, "").want(t, 200)["items"].([]any)); got != n {
			t.Fatalf("%s returned %d items, want %d", path, got, n)
		}
	}
	items(search+pid, 1)
	other.do(http.MethodDelete, path+"?base_version=2", nil, uuid.NewString()).want(t, 404)
	owner.do(http.MethodDelete, path+"?base_version=2", nil, "").want(t, 400)
	owner.do(http.MethodDelete, path+"?base_version=2&base_version=2", nil, uuid.NewString()).want(t, 400)
	owner.withHeaders(http.MethodDelete, path+"?base_version=2", nil, uuid.NewString(),
		map[string]string{"X-CSRF-Token": ""}).want(t, 403)
	key := uuid.NewString()
	stale := owner.do(http.MethodDelete, path+"?base_version=1", nil, key).want(t, 409)["error"].(map[string]any)
	if stale["code"] != "resource_conflict" || stale["details"].(map[string]any)["current_version"] != float64(2) {
		t.Fatalf("unexpected project conflict: %v", stale)
	}
	owner.do(http.MethodGet, path, nil, "").want(t, 200)

	otherKey := uuid.NewString()
	start := make(chan struct{})
	responses := make(chan apiResponse, 2)
	for _, deleteKey := range []string{key, otherKey} {
		go func() {
			<-start
			responses <- owner.do(http.MethodDelete, path+"?base_version=2", nil, deleteKey)
		}()
	}
	close(start)
	first, second := <-responses, <-responses
	if first.status+second.status != 204+404 || first.status != 204 && second.status != 204 {
		t.Fatalf("concurrent deletes: %d, %d", first.status, second.status)
	}
	if result := owner.do(http.MethodDelete, path+"?base_version=2", nil, key); result.status == 404 {
		key = otherKey
	}
	replayed := owner.do(http.MethodDelete, path+"?base_version=2", nil, key)
	replayed.want(t, 204)
	if replayed.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("same-key project deletion did not replay")
	}
	if code := owner.do(http.MethodDelete, path+"?base_version=1", nil, key).want(t, 409)["error"].(map[string]any)["code"]; code != "idempotency_mismatch" {
		t.Fatalf("same key accepted a different version: %v", code)
	}
	owner.do(http.MethodGet, path, nil, "").want(t, 404)
	owner.do(http.MethodPost, "/projects", project, createKey).want(t, 404)

	assertKept := func(row map[string]any) {
		t.Helper()
		projects := row["projects"].([]any)
		if len(projects) != 1 || projects[0].(map[string]any)["project_id"] != kept ||
			projects[0].(map[string]any)["decision"] != "manual" || len(row["attachments"].([]any)) != 1 ||
			row["attachments"].([]any)[0].(map[string]any)["id"] != attachment ||
			!equalJSON(row["document"], saved["document"]) || row["content_version"] != float64(1) ||
			row["decision_version"] != float64(3) || row["resource_version"] != float64(3) {
			t.Fatalf("deletion changed the note or retained a deleted project: %v", row)
		}
	}
	assertKept(owner.do(http.MethodGet, note, nil, "").want(t, 200))
	assertKept(owner.do(http.MethodPost, "/collections", input, collectionKey).want(t, 201))
	assertKept(owner.do(http.MethodPatch, decisionPath, decision, decisionKey).want(t, 200))
	owner.do(http.MethodGet, "/attachments/"+attachment+"/download", nil, "").want(t, 200)
	owner.do(http.MethodPost, decisionPath+"/undo", map[string]any{
		"operation_key": decisionKey, "base_decision_version": 2,
	}, "").want(t, 409)
	owner.do(http.MethodPatch, decisionPath, map[string]any{
		"base_decision_version": 3, "operations": []map[string]any{{"id": pid, "action": "include"}},
	}, "").want(t, 404)
	items(search+pid, 0)
	items(search+kept, 1)
	items("/collections?project_id="+pid, 0)
	items("/collections?project_id="+kept, 1)
	items("/search?q=synthetic", 2)
	trashRow := owner.do(http.MethodGet, trashPath, nil, "").want(t, 200)
	if len(trashRow["projects"].([]any)) != 0 || trashRow["resource_version"] != float64(3) || trashRow["decision_version"] != float64(2) {
		t.Fatalf("trashed note still references the deleted project: %v", trashRow)
	}
	owner.do(http.MethodPost, trashPath+"/restore", map[string]any{"base_resource_version": 3}, "").want(t, 200)
	if row := owner.do(http.MethodGet, "/collections/"+unrelatedID, nil, "").want(t, 200); row["decision_version"] != float64(1) {
		t.Fatal("deletion changed an unrelated note")
	}

	var events, revisions int
	if err := app.Pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM change_events WHERE user_id=$1 AND resource_type='project' AND resource_id=$2
		 AND resource_version=3 AND action='delete'),
		(SELECT count(*) FROM collection_revisions WHERE user_id=$1 AND collection_id=$3)`,
		uid, pid, cid).Scan(&events, &revisions); err != nil || events != 1 || revisions != 1 {
		t.Fatalf("unexpected deletion events or preserved history: %d, %d, %v", events, revisions, err)
	}

	// An unrelated, already-dispatched automatic run could have received
	// the deleted project as a candidate and echoed its name as a new topic.
	if err := pgx.BeginFunc(ctx, app.Pool, func(tx pgx.Tx) error {
		run := runSnapshot{UID: uid, ID: uuid.NewString(), CollectionID: unrelatedID}
		if _, err := tx.Exec(ctx, `INSERT INTO organization_runs (id,user_id,collection_id,content_version,
			user_policy_version,collection_policy_version,status) VALUES($1,$2,$3,1,1,1,'running')`,
			run.ID, uid, unrelatedID); err != nil {
			return err
		}
		input := textInput{decisionVersion: 1, Projects: []projectInput{{ID: pid, Name: "旧巡检分类", Version: 2}}}
		result := organizationResult{Topic: &modelTopic{Name: "旧巡检分类", Reason: "既有合成主题"}}
		status, stale, err := applyAutomaticProject(ctx, tx, run, input, &result)
		if err == nil && (status != "" || !stale) {
			t.Errorf("stale candidate result could recreate the deleted topic: %q, %t", status, stale)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}
