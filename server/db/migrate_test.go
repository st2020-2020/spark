package db

import (
	"context"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"strings"
	"testing"
)

func TestUpgradePreservesSavedContent(t *testing.T) {
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
	ctx := context.Background()
	root, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	schema := "spark_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = root.Exec(ctx, `CREATE SCHEMA `+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer root.Exec(ctx, `DROP SCHEMA `+pgx.Identifier{schema}.Sanitize()+` CASCADE`)
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	initial, err := migrations.ReadFile("migrations/001_initial.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, string(initial)); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `CREATE TABLE schema_migrations(version int PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());INSERT INTO schema_migrations(version) VALUES(1)`); err != nil {
		t.Fatal(err)
	}
	uid, id := uuid.NewString(), uuid.NewString()
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,email_normalized,password_hash) VALUES($1,'migration@example.test','synthetic-not-a-login-hash')`, uid); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO collections(id,user_id,document,plain_text,intent) VALUES($1,$2,'{"schema_version":1,"content":{"type":"doc","content":[{"type":"paragraph"}]}}','保留的合成原文','迁移前用途')`, id, uid); err != nil {
		t.Fatal(err)
	}
	if err = Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err = Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err = Ready(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var text, intent string
	var contentVersion int
	if err = pool.QueryRow(ctx, `SELECT plain_text,intent,content_version FROM collections WHERE user_id=$1 AND id=$2`, uid, id).Scan(&text, &intent, &contentVersion); err != nil {
		t.Fatal(err)
	}
	if text != "保留的合成原文" || intent != "迁移前用途" || contentVersion != 1 {
		t.Fatal("upgrade changed saved content")
	}
}
