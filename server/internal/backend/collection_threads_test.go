package backend

import (
	"context"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"spark/server/internal/purgearchive"
)

func TestCollectionFollowUpUsesActiveOwnedSource(t *testing.T) {
	app, base := testBackend(t)
	owner := signedExportAccount(t, app, base, "thread-owner")
	other := signedExportAccount(t, app, base, "thread-other")
	rootID, childID := uuid.NewString(), uuid.NewString()
	root := collectionInput(rootID, "原始合成笔记")
	project := owner.do("POST", "/projects", map[string]any{"name": "合成项目", "description": "", "focus_points": []string{}}, uuid.NewString()).want(t, 201)
	root["project_ids"] = []string{project["id"].(string)}
	owner.do("POST", "/collections", root, uuid.NewString()).want(t, 201)
	child := collectionInput(childID, "独立合成续写")
	child["source_collection_id"] = rootID
	other.do("POST", "/collections", child, uuid.NewString()).want(t, 404)

	key := uuid.NewString()
	created := owner.do("POST", "/collections", child, key).want(t, 201)
	if created["id"] != childID || created["source_collection_id"] != rootID || created["follow_up_count"] != float64(1) ||
		len(created["projects"].([]any)) != 0 {
		t.Fatal("created collection lost its source, thread count or independent project decision")
	}
	original := owner.do("GET", "/collections/"+rootID, nil, "").want(t, 200)
	if original["thread_id"] != created["thread_id"] || original["follow_up_count"] != float64(1) ||
		original["display_title"] != "原始合成笔记" || len(original["projects"].([]any)) != 1 {
		t.Fatal("following up did not join the existing thread or changed the source content")
	}

	owner.do("DELETE", "/collections/"+rootID, map[string]any{"base_resource_version": 1}, "").want(t, 200)
	replay := owner.do("POST", "/collections", child, key)
	if replay.want(t, 201)["id"] != childID || replay.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("replay failed after the source went to the trash")
	}
	rejected := collectionInput(uuid.NewString(), "不应写入")
	rejected["source_collection_id"] = rootID
	owner.do("POST", "/collections", rejected, uuid.NewString()).want(t, 404)
	child["source_collection_id"] = childID
	if e := owner.do("POST", "/collections", child, key).want(t, 409)["error"].(map[string]any); e["code"] != "idempotency_mismatch" {
		t.Fatal("same key accepted a different source")
	}
	owner.do("PATCH", "/collections/"+childID, map[string]any{
		"base_content_version": 1, "source_collection_id": childID,
	}, "").want(t, 422)
}

func TestCollectionThreadPaginatesConcurrentBranches(t *testing.T) {
	app, base := testBackend(t)
	owner := signedExportAccount(t, app, base, "thread-page-owner")
	other := signedExportAccount(t, app, base, "thread-page-other")
	rootID, unrelatedID := uuid.NewString(), uuid.NewString()
	root := owner.do("POST", "/collections", collectionInput(rootID, "起点"), uuid.NewString()).want(t, 201)
	owner.do("POST", "/collections", collectionInput(unrelatedID, "不在同一线索"), uuid.NewString()).want(t, 201)

	branches := []string{uuid.NewString(), uuid.NewString()}
	var results [2]apiResponse
	start := make(chan struct{})
	var both sync.WaitGroup
	for i, id := range branches {
		both.Go(func() {
			input := collectionInput(id, "并发分叉")
			input["source_collection_id"] = rootID
			<-start
			results[i] = owner.do("POST", "/collections", input, uuid.NewString())
		})
	}
	close(start)
	both.Wait()
	for _, result := range results {
		if result.want(t, 201)["thread_id"] != root["thread_id"] {
			t.Fatal("concurrent follow-up missed the source thread")
		}
	}
	if _, err := app.Pool.Exec(t.Context(), `UPDATE collections SET created_at='2026-11-20 12:00:00+00'
		WHERE user_id=$1 AND id=ANY($2::uuid[])`, owner.uid, []uuid.UUID{
		uuid.MustParse(rootID), uuid.MustParse(branches[0]), uuid.MustParse(branches[1]),
	}); err != nil {
		t.Fatal(err)
	}

	path := "/collections/" + branches[0] + "/thread"
	first := owner.do("GET", path+"?limit=1", nil, "").want(t, 200)
	cursor := first["next_cursor"].(string)
	query := "?limit=1&cursor=" + cursor
	other.do("GET", path+query, nil, "").want(t, 400)
	other.do("GET", path, nil, "").want(t, 404)
	owner.do("GET", "/collections/"+unrelatedID+"/thread"+query, nil, "").want(t, 400)
	owner.do("GET", "/collections/"+branches[1]+"/thread"+query, nil, "").want(t, 400)

	var ids []string
	for page := first; ; {
		rows := page["items"].([]any)
		if page["thread_id"] != root["thread_id"] || len(rows) != 1 {
			t.Fatal("unexpected thread page")
		}
		ids = append(ids, rows[0].(map[string]any)["id"].(string))
		next, more := page["next_cursor"].(string)
		if !more {
			break
		}
		if len(ids) >= 3 {
			t.Fatal("thread did not end after all members were returned")
		}
		page = owner.do("GET", path+"?limit=1&cursor="+next, nil, "").want(t, 200)
	}
	expected := append([]string{rootID}, branches...)
	slices.Sort(expected)
	if !slices.Equal(ids, expected) {
		t.Fatalf("equal timestamps lost, repeated, or reordered entries: %v, want %v", ids, expected)
	}

	for _, list := range []string{"/collections", "/search?q=并发分叉"} {
		seen := 0
		for _, item := range owner.do("GET", list, nil, "").want(t, 200)["items"].([]any) {
			row := item.(map[string]any)
			if hit, ok := row["collection"].(map[string]any); ok {
				row = hit
			}
			if row["thread_id"] == root["thread_id"] {
				seen++
				if row["follow_up_count"] != float64(2) {
					t.Fatal("list did not count both concurrent branches")
				}
			}
		}
		if seen < 2 {
			t.Fatal("branches missing from collection list or search")
		}
	}
}

func TestCollectionThreadSurvivesTrashAndPurge(t *testing.T) {
	app, base := testBackend(t)
	app.Config.PurgeEnabled = true
	owner := signedExportAccount(t, app, base, "thread-trash-owner")
	rootID, middleID, tailID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	root := owner.do("POST", "/collections", collectionInput(rootID, "起点"), uuid.NewString()).want(t, 201)
	middle := collectionInput(middleID, "仅活跃时显示的合成标题")
	middle["source_collection_id"] = rootID
	middleKey := uuid.NewString()
	owner.do("POST", "/collections", middle, middleKey).want(t, 201)
	tail := collectionInput(tailID, "余下的合成笔记")
	tail["source_collection_id"] = middleID
	tailKey := uuid.NewString()
	owner.do("POST", "/collections", tail, tailKey).want(t, 201)

	rootPath, middlePath, tailPath := "/collections/"+rootID, "/collections/"+middleID, "/collections/"+tailID
	condition := func(version int) any { return map[string]int{"base_resource_version": version} }
	timeline := func() []any {
		t.Helper()
		page := owner.do("GET", tailPath+"/thread", nil, "").want(t, 200)
		if page["thread_id"] != root["thread_id"] {
			t.Fatal("thread identifier changed with membership")
		}
		return page["items"].([]any)
	}

	owner.do("DELETE", middlePath, condition(1), "").want(t, 200)
	owner.do("GET", middlePath+"/thread", nil, "").want(t, 404)
	rows := timeline()
	if len(rows) != 3 {
		t.Fatal("soft deletion should leave a placeholder")
	}
	middleRow := rows[1].(map[string]any)
	if len(middleRow) != 3 || middleRow["id"] != middleID || middleRow["status"] != "deleted" ||
		owner.do("GET", rootPath, nil, "").want(t, 200)["follow_up_count"] != float64(1) {
		t.Fatal("trashed member leaked content or was counted as active")
	}
	owner.do("POST", middlePath+"/restore", condition(2), "").want(t, 200)
	middleRow = timeline()[1].(map[string]any)
	if middleRow["status"] != "active" || middleRow["display_title"] != "仅活跃时显示的合成标题" ||
		owner.do("GET", rootPath, nil, "").want(t, 200)["follow_up_count"] != float64(2) {
		t.Fatal("restore did not make the member and its title visible again")
	}

	owner.do("DELETE", middlePath, condition(3), "").want(t, 200)
	owner.do("POST", middlePath+"/purge", condition(4), uuid.NewString()).want(t, 202)
	rows = timeline()
	if len(rows) != 2 || rows[0].(map[string]any)["id"] != rootID || rows[1].(map[string]any)["id"] != tailID {
		t.Fatal("the immediate purge fence did not remove only the deleted member")
	}
	denied := collectionInput(uuid.NewString(), "不能续写已清理来源")
	denied["source_collection_id"] = middleID
	owner.do("POST", "/collections", denied, uuid.NewString()).want(t, 404)

	owner.do("DELETE", rootPath, condition(1), "").want(t, 200)
	owner.do("POST", rootPath+"/purge", condition(2), uuid.NewString()).want(t, 202)
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	archive, err := purgearchive.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	worker, err := StartPurgeWorker(context.Background(), app.Pool, archive, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := worker.StopAndCancel(ctx); err != nil {
			t.Error(err)
		}
	}()
	checkPurgeEventually(t, "thread members purged", func() bool {
		return owner.do("GET", middlePath+"/purge", nil, "").want(t, 200)["status"] == "completed" &&
			owner.do("GET", rootPath+"/purge", nil, "").want(t, 200)["status"] == "completed"
	})
	rows = timeline()
	if len(rows) != 1 || rows[0].(map[string]any)["id"] != tailID {
		t.Fatal("surviving descendant lost its thread after middle and root were purged")
	}
	for _, response := range []map[string]any{
		owner.do("GET", tailPath, nil, "").want(t, 200),
		owner.do("POST", "/collections", tail, tailKey).want(t, 201),
	} {
		if _, linked := response["source_collection_id"]; linked || response["thread_id"] != root["thread_id"] {
			t.Fatal("purged source remained in the child or its idempotent response")
		}
	}
	owner.do("POST", "/collections", middle, middleKey).want(t, 409)
	owner.do("GET", middlePath, nil, "").want(t, 404)
}

func TestCollectionFollowUpRacesWithSourceTrash(t *testing.T) {
	app, base := testBackend(t)
	owner := signedExportAccount(t, app, base, "thread-race-owner")
	rootID, branchID, racingID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	owner.do("POST", "/collections", collectionInput(rootID, "并发删除的来源"), uuid.NewString()).want(t, 201)
	branch := collectionInput(branchID, "已保存并作为读回入口")
	branch["source_collection_id"] = rootID
	owner.do("POST", "/collections", branch, uuid.NewString()).want(t, 201)
	racing := collectionInput(racingID, "与删除同时提交")
	racing["source_collection_id"] = rootID
	key := uuid.NewString()

	start := make(chan struct{})
	var appendResult, trashResult apiResponse
	var requests sync.WaitGroup
	requests.Go(func() {
		<-start
		appendResult = owner.do("POST", "/collections", racing, key)
	})
	requests.Go(func() {
		<-start
		trashResult = owner.do("DELETE", "/collections/"+rootID, map[string]int{"base_resource_version": 1}, "")
	})
	close(start)
	requests.Wait()
	trashResult.want(t, 200)
	response := owner.do("GET", "/collections/"+branchID+"/thread", nil, "").want(t, 200)
	items := response["items"].([]any)
	switch appendResult.status {
	case 201:
		owner.do("POST", "/collections", racing, key).want(t, 201)
		if len(items) != 3 {
			t.Fatal("append accepted before the trash was not committed exactly once")
		}
	case 404:
		owner.do("POST", "/collections", racing, key).want(t, 404)
		if len(items) != 2 {
			t.Fatal("append rejected after the trash left a partial write")
		}
	default:
		t.Fatalf("unexpected append outcome: %d", appendResult.status)
	}
}
