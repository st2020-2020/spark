package db

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river/rivermigrate"
	"spark/server/internal/store"
)

func migrationTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("SPARK_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("SPARK_TEST_DATABASE_URL is not set")
	}
	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(cfg.ConnConfig.Database, "_test") {
		t.Fatal("test database must end with _test")
	}
	root, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(root.Close)
	schema := pgx.Identifier{"spark_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")}
	execTestSQL(t, root, "CREATE SCHEMA "+schema.Sanitize())
	t.Cleanup(func() {
		if _, err := root.Exec(context.Background(), "DROP SCHEMA "+schema.Sanitize()+" CASCADE"); err != nil {
			t.Errorf("remove isolated test schema: %v", err)
		}
	})
	cfg.ConnConfig.RuntimeParams["search_path"] = schema[0]
	pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func execTestSQL(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func TestUpgradePreservesSavedContent(t *testing.T) {
	ctx, pool := t.Context(), migrationTestPool(t)
	for _, name := range migrationNames[:3] {
		sql, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		execTestSQL(t, pool, string(sql))
	}
	execTestSQL(t, pool, `CREATE TABLE schema_migrations(version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
		INSERT INTO schema_migrations(version) VALUES (1), (2), (3)`)
	river, err := riverMigrator(pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := river.Migrate(ctx, rivermigrate.DirectionUp, nil); err != nil {
		t.Fatal(err)
	}

	uid, id := uuid.New(), uuid.New()
	execTestSQL(t, pool, `INSERT INTO users(id,email_normalized,password_hash)
		VALUES($1,'migration@example.test','synthetic-not-a-login-hash')`, uid)
	execTestSQL(t, pool, `INSERT INTO collections(id,user_id,document,plain_text,intent,original_url,content_version,resource_version,deleted_at,purge_after)
		VALUES($1,$2,'{"schema_version":1,"content":{"type":"doc","content":[{"type":"paragraph"}]}}',
		'保留的合成原文','迁移前用途','https://example.test/',2,5,'2026-10-15 UTC','2026-11-14 UTC')`, id, uid)
	execTestSQL(t, pool, `INSERT INTO collection_revisions(user_id,collection_id,content_version,document,intent,original_url,manual_title)
		SELECT user_id,id,1,document,'第一版用途',original_url,manual_title FROM collections WHERE id=$1`, id)
	execTestSQL(t, pool, `INSERT INTO organization_runs(id,user_id,collection_id,content_version,user_policy_version,collection_policy_version,status,result)
		VALUES($1,$2,$3,2,1,1,'succeeded','{"title":"迁移前整理"}')`, uuid.New(), uid, id)

	for range 2 {
		if err := Migrate(ctx, pool); err != nil {
			t.Fatal(err)
		}
	}
	if err := Ready(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var preserved bool
	if err := pool.QueryRow(ctx, `
		SELECT c.plain_text = '保留的合成原文' AND c.intent = '迁移前用途'
		   AND c.original_url = 'https://example.test/' AND c.content_version = 2 AND c.resource_version = 5
		   AND c.deleted_at = '2026-10-15 UTC' AND c.purge_after = '2026-11-14 UTC' AND c.purge_requested_at IS NULL
		   AND c.document->>'schema_version' = '1' AND r.document = c.document
		   AND r.intent = '第一版用途' AND r.attachment_ids = '[]' AND o.result->>'title' = '迁移前整理'
		FROM collections c JOIN collection_revisions r ON (r.user_id, r.collection_id) = (c.user_id, c.id)
		JOIN organization_runs o ON (o.user_id, o.collection_id) = (c.user_id, c.id)
		WHERE c.user_id = $1 AND c.id = $2 AND r.content_version = 1 AND o.content_version = 2`, uid, id).Scan(&preserved); err != nil {
		t.Fatal(err)
	}
	if !preserved {
		t.Fatal("upgrade changed v3 collection, revision, or organization data")
	}
}

func TestUpgradePreservesExtractionSourceIdentity(t *testing.T) {
	ctx, pool := t.Context(), migrationTestPool(t)
	for _, name := range migrationNames[:6] {
		sql, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		execTestSQL(t, pool, string(sql))
	}
	execTestSQL(t, pool, `CREATE TABLE schema_migrations(version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
		INSERT INTO schema_migrations(version) SELECT generate_series(1,6)`)
	user, collection, current, earlier := newTestID(), newTestID(), newTestID(), newTestID()
	const primary = "https://example.test/?v=原样%2F"
	const stale = "https://example.test/?v=其他%2F"
	execTestSQL(t, pool, `INSERT INTO users(id,email_normalized,password_hash)
		VALUES($1,'url-upgrade@example.test','synthetic-not-a-login-hash')`, user)
	execTestSQL(t, pool, `INSERT INTO collections(id,user_id,document,plain_text,intent,original_url)
		VALUES($1,$2,'{}','合成原文','',$3)`, collection, user, primary)
	execTestSQL(t, pool, `INSERT INTO extractions(id,user_id,collection_id,content_version,source_kind,source_id,extractor_version,status,text)
		VALUES($1,$3,$4,1,'url',$5,'web-v1','succeeded','当前结果'),
		      ($2,$3,$4,1,'url',$6,'web-v1','succeeded','旧结果')`, current, earlier, user, collection, primary, stale)
	for range 2 {
		if err := Migrate(ctx, pool); err != nil {
			t.Fatal(err)
		}
	}
	var kept int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM extractions
		WHERE (id=$1 AND source_id=$3 AND text='当前结果') OR (id=$2 AND source_id=$4 AND text='旧结果')`,
		current, earlier, primary, stale).Scan(&kept); err != nil || kept != 2 {
		t.Fatalf("v6 raw sources or results were lost: %d, %v", kept, err)
	}
	q := store.New(pool)
	params := store.GetCurrentURLExtractionParams{
		UserID: user, CollectionID: collection, ExtractorVersion: "web-v1",
	}
	row, err := q.GetCurrentURLExtraction(ctx, params)
	if err != nil || row.ID != current || row.SourceID != primary {
		t.Fatalf("current extraction did not compare the raw URL: %v", err)
	}
	args := store.EnsureCurrentExtractionParams{
		ID: newTestID(), UserID: params.UserID, CollectionID: params.CollectionID,
		ContentVersion: 1, SourceKind: "url", SourceID: primary, ExtractorVersion: "web-v1",
	}
	if inserted, err := q.EnsureCurrentExtraction(ctx, args); err != nil || inserted != 0 {
		t.Fatalf("existing raw URL was not deduplicated after upgrade: %d, %v", inserted, err)
	}
}

func TestUpgradeAddsRevisitWithoutChangingOldCollections(t *testing.T) {
	ctx, pool := t.Context(), migrationTestPool(t)
	for _, name := range migrationNames[:8] {
		sql, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		execTestSQL(t, pool, string(sql))
	}
	execTestSQL(t, pool, `CREATE TABLE schema_migrations(version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
		INSERT INTO schema_migrations(version) SELECT generate_series(1,8)`)
	owner, other, id := uuid.New(), uuid.New(), uuid.New()
	execTestSQL(t, pool, `INSERT INTO users(id,email_normalized,password_hash)
		VALUES($1,'revisit-owner@example.test','synthetic'),($2,'revisit-other@example.test','synthetic')`, owner, other)
	execTestSQL(t, pool, `INSERT INTO collections(id,user_id,document,plain_text,intent,read_at,created_at)
		VALUES($1,$2,'{}','原内容','原用途','2026-06-02 UTC','2026-06-01 UTC')`, id, owner)

	for range 2 {
		if err := Migrate(ctx, pool); err != nil {
			t.Fatal(err)
		}
	}
	if err := Ready(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var preserved bool
	if err := pool.QueryRow(ctx, `SELECT c.last_opened_at IS NULL AND c.read_at='2026-06-02 UTC'
			AND c.created_at='2026-06-01 UTC' AND c.plain_text='原内容' AND c.intent='原用途' AND u.resurface_enabled
		FROM collections c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, id).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("v8 upgrade did not preserve the collection or the new defaults: %v", err)
	}

	execTestSQL(t, pool, `INSERT INTO resurface_days(user_id,local_date) VALUES($1,'2026-11-20'),($2,'2026-11-20')`, owner, other)
	_, err := pool.Exec(ctx, `INSERT INTO resurface_items(user_id,local_date,collection_id,position,reason)
		VALUES($1,'2026-11-20',$2,1,'anniversary')`, other, id)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("cross-account collection reference was not rejected: %v", err)
	}
	execTestSQL(t, pool, `INSERT INTO resurface_items(user_id,local_date,collection_id,position,reason)
		VALUES($1,'2026-11-20',$2,1,'anniversary')`, owner, id)
	execTestSQL(t, pool, `DELETE FROM collections WHERE id=$1`, id)
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM resurface_days WHERE user_id=$1)
		AND NOT EXISTS(SELECT FROM resurface_items WHERE user_id=$1)`, owner).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("permanent deletion should remove the card and retain the daily selection marker: %v", err)
	}
}

func TestUpgradeAddsAccountTagsAndAppearance(t *testing.T) {
	ctx, pool := t.Context(), migrationTestPool(t)
	for _, name := range migrationNames[:9] {
		sql, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		execTestSQL(t, pool, string(sql))
	}
	execTestSQL(t, pool, `CREATE TABLE schema_migrations(version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
		INSERT INTO schema_migrations(version) SELECT generate_series(1,9)`)
	owner, other, collection, tag := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	execTestSQL(t, pool, `INSERT INTO users(id,email_normalized,password_hash,ai_enabled,resurface_enabled)
		VALUES($1,'v9-owner@example.test','synthetic',true,false),($2,'v9-other@example.test','synthetic',false,true)`, owner, other)
	execTestSQL(t, pool, `INSERT INTO collections(id,user_id,document,plain_text,intent,last_opened_at)
		VALUES($1,$2,'{}','旧正文','旧用途','2026-11-01 UTC')`, collection, owner)
	for range 2 {
		if err := Migrate(ctx, pool); err != nil {
			t.Fatal(err)
		}
	}
	if err := Ready(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var preserved bool
	if err := pool.QueryRow(ctx, `SELECT u.palette='mint' AND u.theme='system' AND u.ai_enabled AND NOT u.resurface_enabled
		AND c.plain_text='旧正文' AND c.intent='旧用途' AND c.last_opened_at='2026-11-01 UTC'
		FROM collections c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, collection).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("v9 upgrade changed existing data or appearance defaults: %v", err)
	}
	execTestSQL(t, pool, `INSERT INTO tags(id,user_id,name,normalized_name) VALUES($1,$2,'标签','标签')`, tag, other)
	_, err := pool.Exec(ctx, `INSERT INTO collection_tags(user_id,collection_id,tag_id,decision)
		VALUES($1,$2,$3,'manual')`, owner, collection, tag)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("cross-account tag association was not rejected: %v", err)
	}
}

func TestUpgradePreservesImageMaterialAndPreviousOrganization(t *testing.T) {
	ctx, pool := t.Context(), migrationTestPool(t)
	for _, name := range migrationNames[:10] {
		sql, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		execTestSQL(t, pool, string(sql))
	}
	execTestSQL(t, pool, `CREATE TABLE schema_migrations(version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
		INSERT INTO schema_migrations(version) SELECT generate_series(1,10)`)
	user, collection, upload, attachment, extraction, run := newTestID(), newTestID(), newTestID(), newTestID(), newTestID(), newTestID()
	execTestSQL(t, pool, `INSERT INTO users(id,email_normalized,password_hash,ai_enabled,ai_consent_version,image_consent_version,image_consented_at)
		VALUES ($1,'image-upgrade@example.test','synthetic-not-a-login-hash',true,'spark-ai-tags-v1','deepseek-images-v1',now())`, user)
	execTestSQL(t, pool, `INSERT INTO collections(id,user_id,document,plain_text,intent,content_version)
		VALUES ($1,$2,'{}','合成正文','',2)`, collection, user)
	execTestSQL(t, pool, `INSERT INTO uploads(id,user_id,staging_key,final_key,filename,declared_size,actual_size,mime_type,sha256,status,expires_at)
		VALUES ($1,$2,'synthetic/staging','synthetic/final','test.png',3,3,'image/png',decode(repeat('00',32),'hex'),'attached',now())`, upload, user)
	execTestSQL(t, pool, `INSERT INTO attachments(id,user_id,collection_id,upload_id,object_key,filename,mime_type,size_bytes,sha256,position)
		VALUES ($1,$2,$3,$4,'synthetic/final','test.png','image/png',3,decode(repeat('00',32),'hex'),0)`, attachment, user, collection, upload)
	execTestSQL(t, pool, `INSERT INTO extractions(id,user_id,collection_id,content_version,source_kind,source_id,attachment_id,status,text,evidence_meta,extractor_version,image_user_policy_version,image_collection_policy_version)
		VALUES ($1,$2,$3,1,'image',$4::uuid::text,$4,'partial','合成文字','{"description":"合成画面","truncated":true}','deepseek-flash-image-v1',1,1)`, extraction, user, collection, attachment)
	execTestSQL(t, pool, `INSERT INTO organization_runs(id,user_id,collection_id,content_version,user_policy_version,collection_policy_version,status,result)
		VALUES ($1,$2,$3,2,1,1,'succeeded','{"title":"旧标题"}')`, run, user, collection)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := Ready(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var text, description string
	if err := pool.QueryRow(ctx, `SELECT recognized_text,description FROM organization_image_materials
		WHERE user_id=$1 AND collection_id=$2 AND extraction_id=$3 AND attachment_id=$4 AND content_version=1 AND status='partial'`,
		user, collection, extraction, attachment).Scan(&text, &description); err != nil || text != "合成文字" || description != "合成画面" {
		t.Fatalf("upgrade lost the historical attached image material: %q %q, %v", text, description, err)
	}
	var oldTitle string
	if err := pool.QueryRow(ctx, `SELECT result->>'title' FROM organization_runs
		WHERE user_id=$1 AND id=$2 AND NOT image_waiting AND image_user_policy_version IS NULL`, user, run).Scan(&oldTitle); err != nil || oldTitle != "旧标题" {
		t.Fatalf("upgrade misidentified old organization as using image material: %q, %v", oldTitle, err)
	}
}
