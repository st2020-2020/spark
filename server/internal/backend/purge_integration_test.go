package backend

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/db"
	"spark/server/internal/purgearchive"
)

type controlledPurgeObjects struct {
	mu       sync.Mutex
	contents map[string]string
	calls    map[string]int
	failKey  string
}

func (o *controlledPurgeObjects) Delete(_ context.Context, key, version string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.calls[key]++
	if key == o.failKey {
		return errors.New("controlled storage interruption")
	}
	if expected, found := o.contents[key]; found && expected != version {
		return errors.New("wrong object version")
	}
	delete(o.contents, key)
	return nil
}

func (o *controlledPurgeObjects) callsOn(key string) int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.calls[key]
}

func checkPurgeEventually(t *testing.T, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(12 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(35 * time.Millisecond)
	}
}

func TestDeletionReplayRejectsMissingAccountWithObjects(t *testing.T) {
	app, _ := testBackend(t)
	dir := filepath.Join(t.TempDir(), "ledger")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	archive, err := purgearchive.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	owner := uuid.New()
	receipt := purgearchive.Receipt{
		SchemaVersion: 1, OperationID: uuid.New(), UserID: owner, CollectionID: uuid.New(), RequestedAt: time.Now().UTC(),
	}
	if err := archive.Put(receipt); err != nil {
		t.Fatal(err)
	}
	if count, err := ReplayDeletions(t.Context(), app.Pool, archive); count != 0 || err != nil {
		t.Fatalf("a receipt with no account or objects should have nothing to replay: %d, %v", count, err)
	}

	receipt.OperationID = uuid.New()
	receipt.Objects = []purgearchive.Object{{Key: "fixture/users/" + owner.String() + "/attachments/" + uuid.NewString()}}
	if err := archive.Put(receipt); err != nil {
		t.Fatal(err)
	}
	count, err := ReplayDeletions(t.Context(), app.Pool, archive)
	if count != 0 || err == nil || !strings.Contains(err.Error(), receipt.OperationID.String()) ||
		!strings.Contains(err.Error(), "keep recovery offline") {
		t.Fatalf("expected recovery to stop with the receipt and operator action: %d, %v", count, err)
	}
}

func TestPermanentPurgeAndBackupReplay(t *testing.T) {
	app, base := testBackend(t)
	restoreApp, restoreBase := testBackend(t)
	ctx := t.Context()
	app.Config.PurgeEnabled = true
	restoreApp.Config.PurgeEnabled = true
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := app.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	const email = "deletion-owner@example.test"
	if err := app.BootstrapAdmin(ctx, email, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	owner := newClient(t, app, base)
	owner.signIn(email)
	uid := owner.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)

	owner.invite("INVITE-PURGE-0002")
	other := newClient(t, app, base)
	other.csrf = other.do("POST", "/auth/register", other.registration("deletion-other@example.test", "INVITE-PURGE-0002"), "").want(t, 201)["csrf_token"].(string)
	otherID := uuid.NewString()
	other.do("POST", "/collections", collectionInput(otherID, "另一账号的合成原文"), uuid.NewString()).want(t, 201)

	cid := uuid.NewString()
	input := collectionInput(cid, "synthetic-purge-original")
	originalCreateKey := uuid.NewString()
	owner.do("POST", "/collections", input, originalCreateKey).want(t, 201)
	path := "/collections/" + cid
	purgePath := path + "/purge"
	owner.do("POST", purgePath, map[string]any{"base_resource_version": 1}, uuid.NewString()).want(t, 409)
	other.do("POST", purgePath, map[string]any{"base_resource_version": 1}, uuid.NewString()).want(t, 404)

	uploadID, attachmentID := uuid.NewString(), uuid.NewString()
	staging := "fixture/users/" + uid + "/uploads/" + uploadID
	final := "fixture/users/" + uid + "/attachments/" + uploadID
	expires := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	exec(`INSERT INTO uploads(id,user_id,staging_key,final_key,provider_version,filename,declared_size,actual_size,mime_type,sha256,status,expires_at)
		VALUES($1,$2,$3,$4,'final-ver-1','sample.png',3,3,'image/png',decode(repeat('00',32),'hex'),'attached',$5)`,
		uploadID, uid, staging, final, expires)
	exec(`INSERT INTO attachments(id,user_id,collection_id,upload_id,object_key,provider_version,filename,mime_type,size_bytes,sha256,position)
		VALUES($1,$2,$3,$4,$5,'final-ver-1','sample.png','image/png',3,decode(repeat('00',32),'hex'),0)`, attachmentID, uid, cid, uploadID, final)
	exec(`INSERT INTO extractions(id,user_id,collection_id,content_version,source_kind,source_id,attachment_id,extractor_version,status,text)
		VALUES($1,$2,$3,1,'image',$4::uuid::text,$4,'fixture','succeeded','synthetic derivative')`, uuid.NewString(), uid, cid, attachmentID)

	runID, reservationID := uuid.NewString(), uuid.NewString()
	exec(`INSERT INTO organization_runs(id,user_id,collection_id,content_version,user_policy_version,collection_policy_version,status,result)
		VALUES($1,$2,$3,1,1,1,'running','{"summary":"synthetic model derivative"}')`, runID, uid, cid)
	exec(`INSERT INTO usage_reservations(id,user_id,run_id,attempt_no,budget_day,route,config_version,model,reserved_units,state)
		VALUES($1,$2,$3,1,CURRENT_DATE,'fixture','fixture','fixture',25,'reserved')`, reservationID, uid, runID)
	exec("INSERT INTO daily_budgets(scope,owner_key,budget_day,reserved_units) VALUES('user',$1,CURRENT_DATE,25)", uid)
	exec(`INSERT INTO idempotency_keys(user_id,operation,key,request_digest,response_status,response_json)
		VALUES($1,$2,$3,decode('aa','hex'),202,'{"summary":"synthetic cached model derivative"}')`, uid,
		"POST /api/v1"+path+"/organization", uuid.NewString())
	// Capture the source tables before trashing the collection, simulating
	// a restored checkpoint in its own migrated PostgreSQL schema.
	for _, table := range []string{
		"users", "user_change_counters", "change_events", "collections", "collection_revisions",
		"uploads", "attachments", "extractions", "organization_runs", "usage_reservations",
		"daily_budgets", "idempotency_keys",
	} {
		target, columns := pgx.Identifier{table}.Sanitize(), "*"
		if table == "attachments" {
			columns = "id,user_id,collection_id,upload_id,object_key,provider_version,filename,mime_type,size_bytes,sha256,position,removed_at,created_at"
			target += "(" + columns + ")"
		}
		if _, err := restoreApp.Pool.Exec(ctx, "INSERT INTO "+target+" SELECT "+columns+" FROM "+
			pgx.Identifier{db.RiverSchema(app.Pool), table}.Sanitize()); err != nil {
			t.Fatalf("restore checkpoint table %s: %v", table, err)
		}
	}

	trash := owner.do("DELETE", path, map[string]any{"base_resource_version": 1}, "").want(t, 200)
	deleted, err := time.Parse(time.RFC3339Nano, trash["deleted_at"].(string))
	if err != nil {
		t.Fatal(err)
	}
	due, err := time.Parse(time.RFC3339Nano, trash["purge_after"].(string))
	if err != nil || due.Sub(deleted) != 30*24*time.Hour {
		t.Fatalf("trash retention did not set a 30-day deadline: %v", err)
	}
	owner.do("POST", purgePath, map[string]any{"base_resource_version": 1}, uuid.NewString()).want(t, 409)
	request := map[string]any{"base_resource_version": trash["resource_version"]}

	exec(`CREATE FUNCTION reject_purge_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'synthetic queue failure'; END $$;
		CREATE TRIGGER reject_purge_enqueue BEFORE INSERT ON river_job FOR EACH ROW
		WHEN (NEW.kind='spark_purge_collection') EXECUTE FUNCTION reject_purge_enqueue()`)
	owner.do("POST", purgePath, request, uuid.NewString()).want(t, 503)
	owner.do("GET", purgePath, nil, "").want(t, 404)
	owner.do("GET", path, nil, "").want(t, 200)
	exec("DROP TRIGGER reject_purge_enqueue ON river_job")
	purgeKey := uuid.NewString()
	operation := owner.do("POST", purgePath, request, purgeKey).want(t, 202)
	operationID := uuid.MustParse(operation["operation_id"].(string))
	if operation["status"] != "queued" || owner.do("GET", purgePath, nil, "").want(t, 200)["operation_id"] != operationID.String() {
		t.Fatal("missing durable operation")
	}
	owner.do("GET", path, nil, "").want(t, 404)
	owner.do("POST", path+"/restore", map[string]any{"base_resource_version": 3}, "").want(t, 404)
	other.do("GET", purgePath, nil, "").want(t, 404)
	if len(owner.do("GET", "/collections?scope=trash", nil, "").want(t, 200)["items"].([]any)) != 0 {
		t.Fatal("registered purge stayed visible in trash")
	}

	archiveDir := t.TempDir()
	if err := os.Chmod(archiveDir, 0700); err != nil {
		t.Fatal(err)
	}
	archive, err := purgearchive.Open(archiveDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = archive.Close() })
	invalidReceipt := filepath.Join(archiveDir, operationID.String()+".json")
	if err := os.WriteFile(invalidReceipt, []byte("synthetic invalid receipt"), 0600); err != nil {
		t.Fatal(err)
	}
	objects := &controlledPurgeObjects{contents: map[string]string{final: "final-ver-1", staging: ""}, calls: map[string]int{}, failKey: staging}
	worker, err := StartPurgeWorker(context.Background(), app.Pool, archive, objects)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := worker.StopAndCancel(stop); err != nil {
			t.Error(err)
		}
	})
	recordedFailure := func(message string) bool {
		t.Helper()
		var found bool
		err := app.Pool.QueryRow(ctx, `SELECT EXISTS(
			SELECT FROM river_job j CROSS JOIN LATERAL unnest(j.errors) e
			WHERE j.kind='spark_purge_collection' AND j.args->>'collection_id'=$1 AND strpos(e->>'error',$2)>0
		)`, cid, message).Scan(&found)
		if err != nil {
			t.Fatal(err)
		}
		return found
	}
	repick := func() {
		exec(`UPDATE river_job SET state='available',scheduled_at=now() WHERE kind='spark_purge_collection'
			AND args->>'collection_id'=$1 AND state IN ('retryable','scheduled','available')`, cid)
	}
	checkPurgeEventually(t, "archive failure", func() bool { return recordedFailure("invalid independent deletion receipt") })
	if got := owner.do("GET", purgePath, nil, "").want(t, 200)["status"]; got != "queued" || objects.callsOn(final) != 0 {
		t.Fatal("cleanup began before independent replication")
	}

	exec(`CREATE FUNCTION reject_physical_purge() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'synthetic physical transaction failure'; END $$;
		CREATE TRIGGER reject_physical_purge BEFORE DELETE ON collections FOR EACH ROW EXECUTE FUNCTION reject_physical_purge()`)
	if err := os.Remove(invalidReceipt); err != nil {
		t.Fatal(err)
	}
	repick()
	checkPurgeEventually(t, "physical transaction rollback", func() bool { return recordedFailure("synthetic physical transaction failure") })
	receipt, err := archive.Read(operationID)
	if err != nil || len(receipt.Objects) != 2 || receipt.Objects[0].Key != final || receipt.Objects[0].Version != "final-ver-1" ||
		receipt.Objects[1].NotBefore == nil || !receipt.Objects[1].NotBefore.Equal(expires) {
		t.Fatalf("independent copy lost object cleanup metadata: %v", err)
	}
	var rolledBack bool
	if err := app.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM extractions WHERE collection_id=$1)
		AND EXISTS(SELECT FROM usage_reservations WHERE id=$2 AND state='reserved' AND run_id=$3)
		AND EXISTS(SELECT FROM attachments WHERE collection_id=$1)`, cid, reservationID, runID).Scan(&rolledBack); err != nil || !rolledBack {
		t.Fatalf("failed DB cleanup was not atomic: %v", err)
	}
	if objects.callsOn(final) != 0 {
		t.Fatal("objects removed during a rolled-back database cleanup")
	}
	exec("DROP TRIGGER reject_physical_purge ON collections")
	repick()
	checkPurgeEventually(t, "storage retry", func() bool { return recordedFailure("collection object removal failed") })
	if got := owner.do("GET", purgePath, nil, "").want(t, 200)["status"]; got != "running" {
		t.Fatalf("storage failure advertised a terminal status: %v", got)
	}
	objects.mu.Lock()
	objects.failKey = ""
	objects.mu.Unlock()
	repick()
	checkPurgeEventually(t, "permanent deletion", func() bool {
		return owner.do("GET", purgePath, nil, "").want(t, 200)["status"] == "completed"
	})
	stagingCalls := objects.callsOn(staging)
	if objects.callsOn(final) != 1 || stagingCalls < 2 {
		t.Fatal("cleanup did not resume at the failed object")
	}
	var clean bool
	if err := app.Pool.QueryRow(ctx, `SELECT
		NOT EXISTS(SELECT FROM collections WHERE id=$1)
		AND NOT EXISTS(SELECT FROM uploads WHERE id=$2)
		AND NOT EXISTS(SELECT FROM idempotency_keys WHERE key=$3 OR operation=$4)
		AND EXISTS(SELECT FROM usage_reservations WHERE id=$5 AND run_id IS NULL AND state='uncertain' AND reserved_units=25)
		AND EXISTS(SELECT FROM daily_budgets WHERE owner_key=$6 AND reserved_units=25)`,
		cid, uploadID, originalCreateKey, "POST /api/v1"+path+"/organization", reservationID, uid).Scan(&clean); err != nil || !clean {
		t.Fatalf("purge retained content or lost accounting: %v", err)
	}
	if replayed := owner.do("POST", purgePath, request, purgeKey).want(t, 202); replayed["operation_id"] != operationID.String() || replayed["status"] != "completed" {
		t.Fatal("repeat request lost original operation")
	}
	owner.do("POST", "/collections", input, originalCreateKey).want(t, 409)

	restored := newClient(t, restoreApp, restoreBase)
	restored.signIn(email)
	restored.do("GET", path, nil, "").want(t, 200)
	for range 2 {
		if count, err := ReplayDeletions(ctx, restoreApp.Pool, archive); err != nil || count != 1 {
			t.Fatalf("replay deleted collection into checkpoint: count=%d err=%v", count, err)
		}
	}
	restored.do("GET", path, nil, "").want(t, 404)
	restored.do("POST", "/collections", input, originalCreateKey).want(t, 409)
	if restored.do("GET", purgePath, nil, "").want(t, 200)["operation_id"] != operationID.String() {
		t.Fatal("restored database lost the original tombstone ID")
	}
	var untouched bool
	if err := restoreApp.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT FROM collections WHERE id=$1)", otherID).Scan(&untouched); err != nil || !untouched {
		t.Fatalf("replay changed unrelated data: %v", err)
	}

	objects.mu.Lock()
	objects.contents[final], objects.contents[staging] = "final-ver-1", ""
	objects.mu.Unlock()
	restoredWorker, err := StartPurgeWorker(context.Background(), restoreApp.Pool, archive, objects)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = restoredWorker.StopAndCancel(stop)
	})
	checkPurgeEventually(t, "restored object cleanup", func() bool {
		return restored.do("GET", purgePath, nil, "").want(t, 200)["status"] == "completed"
	})
	if objects.callsOn(final) != 2 || objects.callsOn(staging) != stagingCalls+1 {
		t.Fatal("restore replay left reintroduced objects behind")
	}
}

func TestPurgeSweepHonorsTrashDeadlineWithAnotherWorker(t *testing.T) {
	app, base := testBackend(t)
	ctx := t.Context()
	const email = "expiry-example@example.test"
	if err := app.BootstrapAdmin(ctx, email, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	client := newClient(t, app, base)
	client.signIn(email)
	makeTrash := func() string {
		t.Helper()
		id := uuid.NewString()
		client.do("POST", "/collections", collectionInput(id, "synthetic expiration"), uuid.NewString()).want(t, 201)
		client.do("DELETE", "/collections/"+id, map[string]any{"base_resource_version": 1}, "").want(t, 200)
		return id
	}
	due, young, restored := makeTrash(), makeTrash(), makeTrash()
	if _, err := app.Pool.Exec(ctx, "UPDATE collections SET purge_after=now()-interval '1 second' WHERE id=ANY($1::uuid[])",
		[]string{due, restored}); err != nil {
		t.Fatal(err)
	}
	client.do("POST", "/collections/"+restored+"/restore", map[string]any{"base_resource_version": 2}, "").want(t, 200)

	urlWorker, err := StartURLWorker(context.Background(), app.Pool)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = urlWorker.StopAndCancel(stop)
	})
	checkPurgeEventually(t, "other River leader", func() bool {
		var exists bool
		if err := app.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT FROM river_leader)").Scan(&exists); err != nil {
			t.Fatal(err)
		}
		return exists
	})
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	archive, err := purgearchive.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = archive.Close() })
	worker, err := StartPurgeWorker(context.Background(), app.Pool, archive, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = worker.StopAndCancel(stop)
	})
	checkPurgeEventually(t, "daily deletion of expired trash", func() bool {
		var complete bool
		if err := app.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT FROM deletion_ledger WHERE collection_id=$1 AND completed_at IS NOT NULL)", due).Scan(&complete); err != nil {
			t.Fatal(err)
		}
		return complete
	})
	client.do("GET", "/collections/"+young, nil, "").want(t, 200)
	client.do("GET", "/collections/"+restored, nil, "").want(t, 200)
	client.do("GET", "/collections/"+due, nil, "").want(t, 404)
	var next bool
	if err := app.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM river_job
		WHERE kind='spark_sweep_expired_collections' AND scheduled_at>now() AND state='scheduled')`).Scan(&next); err != nil || !next {
		t.Fatalf("daily sweep did not persist its successor: %v", err)
	}
}
