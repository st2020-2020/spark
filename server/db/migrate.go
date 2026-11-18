package db

import (
	"context"
	"embed"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

const Version = 1

// Migrate is only called by the explicit operator command, never API startup.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(51709001)`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations(version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	var version int
	if err = tx.QueryRow(ctx, `SELECT coalesce(max(version),0) FROM schema_migrations`).Scan(&version); err != nil {
		return err
	}
	if version > Version {
		return fmt.Errorf("database schema %d is newer than supported %d", version, Version)
	}
	if version == 0 {
		sql, err := migrations.ReadFile("migrations/001_initial.sql")
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("migration 1: %w", err)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO schema_migrations(version) VALUES(1)`); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func Ready(ctx context.Context, pool *pgxpool.Pool) error {
	var v int
	if err := pool.QueryRow(ctx, `SELECT coalesce(max(version),0) FROM schema_migrations`).Scan(&v); err != nil {
		return err
	}
	if v != Version {
		return fmt.Errorf("schema version %d, expected %d", v, Version)
	}
	return nil
}
