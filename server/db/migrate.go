package db

import (
	"context"
	"embed"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
)

//go:embed migrations/*.sql
var migrations embed.FS

const Version = 15

var migrationNames = [...]string{
	"001_initial.sql",
	"002_text_organization.sql",
	"003_organization_events.sql",
	"004_attachments_extractions.sql",
	"005_purge_progress.sql",
	"006_image_analysis.sql",
	"007_extraction_keys_upload_cleanup.sql",
	"008_mail_delivery.sql",
	"009_revisit.sql",
	"010_tags_appearance.sql",
	"011_image_organization.sql",
	"012_image_recovery.sql",
	"013_image_provider_recovery.sql",
	"014_image_notes.sql",
	"015_image_notes_tag_consent.sql",
}

func RiverSchema(pool *pgxpool.Pool) string {
	if s := pool.Config().ConnConfig.RuntimeParams["search_path"]; s != "" {
		return s
	}
	return "public"
}
func riverMigrator(pool *pgxpool.Pool) (*rivermigrate.Migrator[pgx.Tx], error) {
	return rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{Schema: RiverSchema(pool)})
}

// Migrate is explicit. Application SQL is atomic; River owns its versioned
// transactions because PostgreSQL enum additions require an intervening commit.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(51709001)`); err != nil {
		return err
	}
	defer func() {
		release, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, e := conn.Exec(release, `SELECT pg_advisory_unlock(51709001)`); e != nil {
			_ = conn.Conn().Close(release)
		}
	}()
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations(version int PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	var version int
	if err = tx.QueryRow(ctx, `SELECT coalesce(max(version),0) FROM schema_migrations`).Scan(&version); err != nil {
		return err
	}
	if version > Version {
		return fmt.Errorf("database schema %d is newer than supported %d", version, Version)
	}
	for v := version + 1; v <= Version; v++ {
		sql, err := migrations.ReadFile("migrations/" + migrationNames[v-1])
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("migration %d: %w", v, err)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO schema_migrations(version) VALUES($1)`, v); err != nil {
			return err
		}
	}
	m, err := riverMigrator(pool)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if _, err = m.Migrate(ctx, rivermigrate.DirectionUp, nil); err != nil {
		return fmt.Errorf("River migrations: %w", err)
	}
	return nil
}
func Ready(ctx context.Context, pool *pgxpool.Pool) error {
	var v int
	if err := pool.QueryRow(ctx, `SELECT coalesce(max(version),0) FROM schema_migrations`).Scan(&v); err != nil {
		return err
	}
	if v != Version {
		return fmt.Errorf("schema version %d, expected %d", v, Version)
	}
	m, err := riverMigrator(pool)
	if err != nil {
		return err
	}
	existing, err := m.ExistingVersions(ctx)
	if err != nil {
		return err
	}
	if len(existing) != len(m.AllVersions()) {
		return fmt.Errorf("River schema migration mismatch")
	}
	return nil
}
