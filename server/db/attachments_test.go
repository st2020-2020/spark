package db

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"spark/server/internal/store"
)

func newTestID() pgtype.UUID { return pgtype.UUID{Bytes: uuid.New(), Valid: true} }

func seedAttachmentCollection(t *testing.T, pool *pgxpool.Pool, name string) (pgtype.UUID, pgtype.UUID) {
	t.Helper()
	owner, collection := newTestID(), newTestID()
	execTestSQL(t, pool, "INSERT INTO users(id,email_normalized,password_hash) VALUES($1,$2,'synthetic-test-hash')", owner, name+"@example.test")
	execTestSQL(t, pool, "INSERT INTO user_change_counters(user_id) VALUES($1)", owner)
	execTestSQL(t, pool, `INSERT INTO collections(id,user_id,document,plain_text,intent,original_url)
		VALUES($1,$2,'{}','synthetic source','','https://example.test/')`, collection, owner)
	return owner, collection
}

func requireSQLState(t *testing.T, err error, state string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != state {
		t.Fatalf("expected SQLSTATE %s, got %v", state, err)
	}
}

func TestAttachmentStorageLifecycle(t *testing.T) {
	ctx, pool := t.Context(), migrationTestPool(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	q := store.New(pool)
	alice, collection := seedAttachmentCollection(t, pool, "alice")
	bob, otherCollection := seedAttachmentCollection(t, pool, "bob")

	createUpload := func(owner pgtype.UUID) store.Upload {
		t.Helper()
		id := newTestID()
		u, err := q.CreateUpload(ctx, store.CreateUploadParams{
			ID: id, UserID: owner, StagingKey: "staging/" + uuid.UUID(id.Bytes).String(),
			Filename: "sample.png", DeclaredSize: 24, MimeType: "image/png",
			ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
		})
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	attach := store.AttachUploadParams{UserID: alice, CollectionID: collection, ID: newTestID()}
	first := createUpload(alice)
	attach.UploadID = first.ID
	if _, err := q.AttachUpload(ctx, attach); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("attach pending upload: %v", err)
	}
	if _, err := q.GetUpload(ctx, store.GetUploadParams{UserID: bob, ID: first.ID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-account upload lookup: %v", err)
	}

	verify := func(u store.Upload) store.Upload {
		t.Helper()
		begin := store.BeginUploadVerificationParams{UserID: u.UserID, ID: u.ID, FinalKey: "final/" + uuid.UUID(u.ID.Bytes).String()}
		initial, err := q.BeginUploadVerification(ctx, begin)
		if err != nil {
			t.Fatal(err)
		}
		begin.FinalKey += "-retry"
		replayed, err := q.BeginUploadVerification(ctx, begin)
		if err != nil || replayed.FinalKey != initial.FinalKey {
			t.Fatalf("verification retry changed final key: %v", err)
		}
		finish := store.FinishUploadVerificationParams{
			UserID: u.UserID, ID: u.ID, ActualSize: 24, FinalKey: initial.FinalKey.String,
			Sha256: bytes.Repeat([]byte{1}, 32),
		}
		ready, err := q.FinishUploadVerification(ctx, finish)
		if err != nil || ready.Status != "ready" {
			t.Fatalf("finish verification: %v", err)
		}
		if _, err := q.FinishUploadVerification(ctx, finish); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("duplicate verification overwrote result: %v", err)
		}
		return ready
	}
	first = verify(first)
	bobUpload := verify(createUpload(bob))
	foreign := attach
	foreign.UploadID = bobUpload.ID
	if _, err := q.AttachUpload(ctx, foreign); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("attach another account's upload: %v", err)
	}
	foreign.CollectionID = otherCollection
	foreign.UploadID = first.ID
	if _, err := q.AttachUpload(ctx, foreign); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("attach to another account's collection: %v", err)
	}
	// Check both composite FKs independently of the application access path.
	const insertAttachment = `INSERT INTO attachments(id,user_id,collection_id,upload_id,object_key,filename,mime_type,size_bytes,sha256,position)
		VALUES($1,$2,$3,$4,'foreign-key-test','sample.png','image/png',24,$5,0)`
	for _, bad := range []struct{ collection, upload pgtype.UUID }{{collection, bobUpload.ID}, {otherCollection, first.ID}} {
		_, err := pool.Exec(ctx, insertAttachment, newTestID(), alice, bad.collection, bad.upload, first.Sha256)
		requireSQLState(t, err, "23503")
	}

	// Competing consumers use the same upload with distinct attachment IDs.
	type result struct {
		attachment store.Attachment
		err        error
	}
	start := make(chan struct{})
	outcomes := make(chan result, 2)
	for range 2 {
		go func() {
			params := attach
			params.ID = newTestID()
			<-start
			a, err := q.AttachUpload(ctx, params)
			outcomes <- result{a, err}
		}()
	}
	close(start)
	winners := 0
	var firstAttachment store.Attachment
	for range 2 {
		r := <-outcomes
		if r.err == nil {
			firstAttachment = r.attachment
			winners++
		} else if !errors.Is(r.err, pgx.ErrNoRows) {
			t.Fatal(r.err)
		}
	}
	if winners != 1 || firstAttachment.ObjectKey != first.FinalKey.String {
		t.Fatalf("expected a single attachment with the verified final key, got %d", winners)
	}
	if _, err := q.GetAttachmentForDownload(ctx, store.GetAttachmentForDownloadParams{UserID: bob, ID: firstAttachment.ID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-account download lookup: %v", err)
	}

	second := verify(createUpload(alice))
	attach.ID, attach.UploadID = newTestID(), second.ID
	_, err := q.AttachUpload(ctx, attach)
	requireSQLState(t, err, "23505")
	attach.Position = 1
	secondAttachment, err := q.AttachUpload(ctx, attach)
	if err != nil {
		t.Fatalf("failed insert consumed its upload: %v", err)
	}

	order := store.SetCollectionAttachmentOrderParams{UserID: alice, CollectionID: collection,
		AttachmentIds: []pgtype.UUID{secondAttachment.ID, firstAttachment.ID}}
	if changed, err := q.SetCollectionAttachmentOrder(ctx, order); err != nil || changed != 2 {
		t.Fatalf("swap attachment positions: changed=%d err=%v", changed, err)
	}
	order.AttachmentIds = []pgtype.UUID{secondAttachment.ID}
	if changed, err := q.SetCollectionAttachmentOrder(ctx, order); err != nil || changed != 1 {
		t.Fatalf("remove an active attachment: changed=%d err=%v", changed, err)
	}
	list := store.ListCurrentAttachmentsParams{UserID: alice, CollectionID: collection}
	current, err := q.ListCurrentAttachments(ctx, list)
	if err != nil || len(current) != 1 || current[0].ID != secondAttachment.ID || current[0].Position != 0 {
		t.Fatalf("list active attachments after reorder and removal: %v", err)
	}
	order.AttachmentIds = []pgtype.UUID{firstAttachment.ID}
	if _, err := q.SetCollectionAttachmentOrder(ctx, order); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("restore removed attachment through reorder: %v", err)
	}
	if _, err := q.GetAttachmentForDownload(ctx, store.GetAttachmentForDownloadParams{UserID: alice, ID: firstAttachment.ID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("download removed attachment from current view: %v", err)
	}

	testExtractionStorage(t, pool, q, alice, collection, bob, otherCollection, secondAttachment)
	testDeletionStorage(t, pool, q, alice, collection, bob, first, second, secondAttachment)

	// Attached uploads are preserved even past the expiry time. Expired rows
	// keep their original keys until cleanup succeeds.
	execTestSQL(t, pool, "UPDATE uploads SET expires_at=now()-interval '1 second' WHERE user_id=$1 OR id=$2", alice, bobUpload.ID)
	expired, err := q.ListExpiredUploads(ctx, 10)
	if err != nil || len(expired) != 1 || expired[0].ID != bobUpload.ID {
		t.Fatalf("find expired unconsumed uploads: %v", err)
	}
	for range 2 {
		got, err := q.ExpireUpload(ctx, store.ExpireUploadParams{UserID: bob, ID: bobUpload.ID})
		if err != nil || got.Status != "expired" || got.FinalKey != bobUpload.FinalKey || got.StagingKey != bobUpload.StagingKey {
			t.Fatalf("expiry must retain cleanup keys for a retry: %v", err)
		}
	}
	if _, err := q.DeleteExpiredUpload(ctx, store.DeleteExpiredUploadParams{UserID: bob, ID: bobUpload.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.GetUpload(ctx, store.GetUploadParams{UserID: bob, ID: bobUpload.ID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("expired record survived cleanup: %v", err)
	}
}

func testExtractionStorage(t *testing.T, pool *pgxpool.Pool, q *store.Queries, owner, collection, otherOwner, otherCollection pgtype.UUID, a store.Attachment) {
	t.Helper()
	ctx := t.Context()
	job := store.EnsureCurrentExtractionParams{ID: newTestID(), UserID: owner, CollectionID: collection,
		ContentVersion: 1, SourceKind: "image", SourceID: uuid.UUID(a.ID.Bytes).String(), AttachmentID: a.ID, ExtractorVersion: "test-v1"}
	if n, err := q.EnsureCurrentExtraction(ctx, job); err != nil || n != 1 {
		t.Fatalf("queue OCR result: rows=%d err=%v", n, err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO extractions(id,user_id,collection_id,content_version,source_kind,source_id,attachment_id,extractor_version)
		VALUES($1,$2,$3,1,'image',$4,$5,'test-v1')`, newTestID(), otherOwner, otherCollection, job.SourceID, a.ID)
	requireSQLState(t, err, "23503")
	list := store.ListCurrentExtractionsParams{UserID: owner, CollectionID: collection}
	rows, err := q.ListCurrentExtractions(ctx, list)
	if err != nil || len(rows) != 1 {
		t.Fatalf("list queued extraction: %v", err)
	}
	update := store.UpdateCurrentExtractionParams{ID: job.ID, UserID: owner, CollectionID: collection, ContentVersion: 1,
		ExpectedUpdatedAt: rows[0].Extraction.UpdatedAt, Status: "running", EvidenceMeta: []byte("{}")}
	running, err := q.UpdateCurrentExtraction(ctx, update)
	if err != nil {
		t.Fatal(err)
	}
	update.Status, update.ExpectedUpdatedAt = "succeeded", running.UpdatedAt
	update.Text = pgtype.Text{String: "合成图片文字", Valid: true}
	if _, err := q.UpdateCurrentExtraction(ctx, update); err != nil {
		t.Fatal(err)
	}
	update.Status = "failed"
	if _, err := q.UpdateCurrentExtraction(ctx, update); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("stale extraction attempt overwrote result: %v", err)
	}
	job.ID = newTestID()
	if n, err := q.EnsureCurrentExtraction(ctx, job); err != nil || n != 0 {
		t.Fatalf("duplicate delivery requeued extraction: rows=%d err=%v", n, err)
	}
	execTestSQL(t, pool, "UPDATE collections SET content_version=2 WHERE user_id=$1 AND id=$2", owner, collection)
	if n, err := q.EnsureCurrentExtraction(ctx, job); err != nil || n != 0 {
		t.Fatalf("stale content version inserted an extraction: rows=%d err=%v", n, err)
	}
	rows, err = q.ListCurrentExtractions(ctx, list)
	if err != nil || len(rows) != 0 {
		t.Fatalf("previous content version visible as current: %v", err)
	}
}

func testDeletionStorage(t *testing.T, pool *pgxpool.Pool, q *store.Queries, owner, collection, otherOwner pgtype.UUID, first, second store.Upload, a store.Attachment) {
	t.Helper()
	ctx := t.Context()
	req := store.RequestCollectionPurgeParams{ID: newTestID(), UserID: owner, CollectionID: collection, BaseResourceVersion: 1}
	if _, err := q.RequestCollectionPurge(ctx, req); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("active collection accepted permanent deletion: %v", err)
	}
	execTestSQL(t, pool, "UPDATE collections SET deleted_at=now(), purge_after=now(), resource_version=2 WHERE user_id=$1 AND id=$2", owner, collection)
	due, err := q.ListDueCollectionsForPurge(ctx, 10)
	if err != nil || len(due) != 1 || due[0].UserID != owner || due[0].ID != collection || due[0].ResourceVersion != 2 {
		t.Fatalf("select only due trash with its current version: %v", err)
	}
	if _, err := q.RequestCollectionPurge(ctx, req); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("stale resource version accepted permanent deletion: %v", err)
	}
	req.BaseResourceVersion, req.UserID = 2, otherOwner
	if _, err := q.RequestCollectionPurge(ctx, req); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-account purge request: %v", err)
	}
	req.UserID = owner
	request := func(afterLedger error) error {
		return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			scoped := store.New(tx)
			if _, err := scoped.LockUserChanges(ctx, owner); err != nil {
				return err
			}
			if _, err := scoped.RequestCollectionPurge(ctx, req); err != nil {
				return err
			}
			return afterLedger
		})
	}
	enqueueFailed := errors.New("simulated cleanup enqueue failure")
	if err := request(enqueueFailed); !errors.Is(err, enqueueFailed) {
		t.Fatalf("purge transaction did not reach the enqueue boundary: %v", err)
	}
	retry := store.GetCollectionDeletionParams{UserID: owner, CollectionID: collection}
	if _, err := q.GetCollectionDeletion(ctx, retry); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("ledger persisted after enqueue failure: %v", err)
	}
	if err := request(nil); err != nil {
		t.Fatalf("purge retry after rollback: %v", err)
	}
	if _, err := q.RequestCollectionPurge(ctx, req); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("repeat purge changed resource again: %v", err)
	}
	if due, err := q.ListDueCollectionsForPurge(ctx, 10); err != nil || len(due) != 0 {
		t.Fatalf("purge-pending collection selected again: %v", err)
	}
	ledger, err := q.GetCollectionDeletion(ctx, retry)
	if err != nil || ledger.ID != req.ID {
		t.Fatalf("purge retry lost operation ID: %v", err)
	}
	var keys []string
	want := []string{first.FinalKey.String, first.StagingKey, second.FinalKey.String, second.StagingKey}
	slices.Sort(want)
	if err := json.Unmarshal(ledger.ObjectKeys, &keys); err != nil || !slices.Equal(keys, want) {
		t.Fatalf("ledger must record staging and final keys, including removed attachments: %v", err)
	}
	var version int64
	if err := pool.QueryRow(ctx, `SELECT resource_version FROM change_events
		WHERE user_id=$1 AND resource_id=$2 AND action='delete'`, owner, collection).Scan(&version); err != nil || version != 3 {
		t.Fatalf("purge did not record the incremented resource version: %d, %v", version, err)
	}
	retry.UserID = otherOwner
	if _, err := q.GetCollectionDeletion(ctx, retry); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-account tombstone lookup: %v", err)
	}
	if _, err := q.GetAttachmentForDownload(ctx, store.GetAttachmentForDownloadParams{UserID: owner, ID: a.ID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("purge did not stop attachment access: %v", err)
	}
	replicate := store.MarkDeletionReplicatedParams{UserID: owner, ID: ledger.ID}
	complete := store.MarkDeletionCompletedParams{UserID: owner, ID: ledger.ID}
	if n, err := q.MarkDeletionCompleted(ctx, complete); n != 0 || err != nil {
		t.Fatalf("marked cleanup complete before replication: rows=%d err=%v", n, err)
	}
	if _, err := q.MarkDeletionReplicated(ctx, replicate); err != nil {
		t.Fatal(err)
	}
	if n, err := q.MarkDeletionCompleted(ctx, complete); n != 0 || err != nil {
		t.Fatalf("marked cleanup complete before database deletion: rows=%d err=%v", n, err)
	}

	// A failed external cleanup leaves the same keys available for retry.
	retry.UserID = owner
	pending, err := q.GetCollectionDeletion(ctx, retry)
	if err != nil || pending.CompletedAt.Valid || !bytes.Equal(pending.ObjectKeys, ledger.ObjectKeys) {
		t.Fatalf("cleanup retry lost unfinished operation or keys: %v", err)
	}

	// Simulate the database cleanup that T08 will perform.
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		for _, stmt := range []string{
			"DELETE FROM extractions WHERE user_id=$1 AND collection_id=$2",
			"DELETE FROM attachments WHERE user_id=$1 AND collection_id=$2",
			"DELETE FROM collections WHERE user_id=$1 AND id=$2",
		} {
			if _, err := tx.Exec(ctx, stmt, owner, collection); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// The storage fixture has erased every object from the ledger.
	execTestSQL(t, pool, "UPDATE deletion_ledger SET object_cursor=jsonb_array_length(object_keys) WHERE user_id=$1 AND id=$2", owner, ledger.ID)
	var completedAt pgtype.Timestamptz
	for attempt := range 2 {
		if _, err := q.MarkDeletionReplicated(ctx, replicate); err != nil {
			t.Fatal(err)
		}
		if n, err := q.MarkDeletionCompleted(ctx, complete); err != nil || n != 1 {
			t.Fatalf("complete deletion retry: rows=%d err=%v", n, err)
		}
		row, err := q.GetCollectionDeletion(ctx, retry)
		if err != nil || !row.CompletedAt.Valid || !bytes.Equal(row.ObjectKeys, ledger.ObjectKeys) {
			t.Fatalf("tombstone and keys must survive database cleanup: %v", err)
		}
		if attempt > 0 && !row.CompletedAt.Time.Equal(completedAt.Time) {
			t.Fatal("retry changed completion timestamp")
		}
		completedAt = row.CompletedAt
	}
}
