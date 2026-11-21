package backend

import (
	"crypto/sha256"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"spark/server/internal/store"
)

func TestPurgeHidesCollectionAndBlocksCreateReplay(t *testing.T) {
	app, base := testBackend(t)
	ctx := t.Context()
	const email = "purge@example.test"
	if err := app.BootstrapAdmin(ctx, email, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	client := newClient(t, app, base)
	client.signIn(email)
	var owner pgtype.UUID
	if err := app.Pool.QueryRow(ctx, "SELECT id FROM users WHERE email_normalized=$1", email).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	id, key := uuid.NewString(), uuid.NewString()
	input := collectionInput(id, "synthetic-purge-marker")
	client.do("POST", "/collections", input, key).want(t, 201)
	path := "/collections/" + id
	q := store.New(app.Pool)
	uploadID := idPG(uuid.NewString())
	_, err := q.CreateUpload(ctx, store.CreateUploadParams{
		ID: uploadID, UserID: owner, StagingKey: "test/staging", Filename: "example.png",
		MimeType: "image/png", DeclaredSize: 10, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = q.BeginUploadVerification(ctx, store.BeginUploadVerificationParams{UserID: owner, ID: uploadID, FinalKey: "test/final"})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("test image"))
	_, err = q.FinishUploadVerification(ctx, store.FinishUploadVerificationParams{
		UserID: owner, ID: uploadID, ActualSize: 10, FinalKey: "test/final", Sha256: digest[:],
	})
	if err != nil {
		t.Fatal(err)
	}
	attachment := uuid.NewString()
	err = pgx.BeginFunc(ctx, app.Pool, func(tx pgx.Tx) error {
		scoped := store.New(tx)
		if _, err := scoped.LockUserChanges(ctx, owner); err != nil {
			return err
		}
		_, err = scoped.AttachUpload(ctx, store.AttachUploadParams{UserID: owner, CollectionID: idPG(id), ID: idPG(attachment), UploadID: uploadID})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	client.do("PATCH", path, map[string]any{"base_content_version": 1, "intent": "revised synthetic content"}, "").want(t, 200)
	err = pgx.BeginFunc(ctx, app.Pool, func(tx pgx.Tx) error {
		scoped := store.New(tx)
		if _, err := scoped.LockUserChanges(ctx, owner); err != nil {
			return err
		}
		_, err := scoped.SetCollectionAttachmentOrder(ctx, store.SetCollectionAttachmentOrderParams{
			UserID: owner, CollectionID: idPG(id), AttachmentIds: []pgtype.UUID{},
		})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	var revisions []byte
	if err := app.Pool.QueryRow(ctx, `SELECT attachment_ids FROM collection_revisions
		WHERE user_id=$1 AND collection_id=$2 AND content_version=2`, owner, id).Scan(&revisions); err != nil {
		t.Fatal(err)
	}
	var ids []string
	if err := json.Unmarshal(revisions, &ids); err != nil || len(ids) != 1 || ids[0] != attachment {
		t.Fatalf("editing and removing attachment lost the historical revision reference: %v", err)
	}

	trashed := client.do("DELETE", path, map[string]any{"base_resource_version": 2}, "").want(t, 200)
	if trashed["resource_version"] != float64(3) {
		t.Fatalf("unexpected version after soft deletion: %v", trashed["resource_version"])
	}
	err = pgx.BeginFunc(ctx, app.Pool, func(tx pgx.Tx) error {
		scoped := store.New(tx)
		if _, err := scoped.LockUserChanges(ctx, owner); err != nil {
			return err
		}
		_, err := scoped.RequestCollectionPurge(ctx, store.RequestCollectionPurgeParams{
			ID: idPG(uuid.NewString()), UserID: owner, CollectionID: idPG(id), BaseResourceVersion: 3,
		})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	client.do("GET", path, nil, "").want(t, 404)
	client.do("POST", path+"/restore", map[string]any{"base_resource_version": 4}, "").want(t, 404)
	if len(client.do("GET", "/collections?scope=trash", nil, "").want(t, 200)["items"].([]any)) != 0 {
		t.Fatal("purge-pending collection remained visible in the trash")
	}
	if len(client.do("GET", "/search?q=synthetic-purge-marker&scope=trash", nil, "").want(t, 200)["items"].([]any)) != 0 {
		t.Fatal("purge-pending collection remained visible in trash search")
	}
	client.do("POST", "/collections", input, key).want(t, 409)
	client.do("POST", "/collections", input, uuid.NewString()).want(t, 409)
}

func TestSessionReportsPurgeCapabilityAndKeepsReceipts(t *testing.T) {
	app, base := testBackend(t)
	const email = "purge-capability@example.test"
	if err := app.BootstrapAdmin(t.Context(), email, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	owner := newClient(t, app, base)
	owner.signIn(email)
	assertCapability := func(enabled bool) {
		t.Helper()
		session := owner.do("GET", "/auth/session", nil, "").want(t, 200)
		if session["purge_enabled"] != enabled {
			t.Fatalf("session purge_enabled = %v, want %v", session["purge_enabled"], enabled)
		}
	}
	trash := func() string {
		t.Helper()
		id := uuid.NewString()
		owner.do("POST", "/collections", collectionInput(id, "合成回收站数据"), uuid.NewString()).want(t, 201)
		path := "/collections/" + id
		owner.do("DELETE", path, map[string]any{"base_resource_version": 1}, "").want(t, 200)
		return path
	}

	assertCapability(false)
	path := trash()
	version := map[string]any{"base_resource_version": 2}
	key := uuid.NewString()
	owner.do("POST", path+"/purge", version, key).want(t, 503)
	app.Config.PurgeEnabled = true
	assertCapability(true)
	receipt := owner.do("POST", path+"/purge", version, key).want(t, 202)
	app.Config.PurgeEnabled = false
	assertCapability(false)
	replay := owner.do("POST", path+"/purge", version, key)
	if replay.want(t, 202)["operation_id"] != receipt["operation_id"] || replay.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("turning off new purge registrations lost the original receipt")
	}
	if owner.do("GET", path+"/purge", nil, "").want(t, 200)["operation_id"] != receipt["operation_id"] {
		t.Fatal("turning off new purge registrations blocked reading a receipt")
	}
	owner.do("POST", path+"/restore", version, "").want(t, 404)
	unregistered := trash()
	owner.do("POST", unregistered+"/purge", version, uuid.NewString()).want(t, 503)
	owner.do("POST", unregistered+"/restore", version, "").want(t, 200)
}
