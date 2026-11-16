package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// ResolveDataDir determines where Spark stores spark.sqlite.
// Order: SPARK_DATA_DIR env -> ./data if present or writable in dev -> UserConfigDir/Spark.
func ResolveDataDir() (string, error) {
	if custom := os.Getenv("SPARK_DATA_DIR"); custom != "" {
		abs, err := filepath.Abs(custom)
		if err != nil {
			return "", err
		}
		return abs, nil
	}

	// Preserve compatibility with existing ./data/spark.sqlite when running from repo.
	if info, err := os.Stat("data"); err == nil && info.IsDir() {
		return filepath.Abs("data")
	}
	if _, err := os.Stat("go.mod"); err == nil {
		return filepath.Abs("data")
	}

	base, err := os.UserConfigDir()
	if err != nil {
		return filepath.Abs("data")
	}
	return filepath.Join(base, "Spark"), nil
}

func Open(dataDir string) (*sql.DB, error) {
	if dataDir == "" {
		var err error
		dataDir, err = ResolveDataDir()
		if err != nil {
			return nil, fmt.Errorf("resolve data dir: %w", err)
		}
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	dbPath := filepath.Join(dataDir, "spark.sqlite")
	conn, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	conn.SetMaxOpenConns(1)

	if _, err := conn.Exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS entries (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			source TEXT NOT NULL CHECK(source IN ('text', 'url', 'image')),
			url TEXT,
			title TEXT,
			image BLOB,
			image_type TEXT,
			image_name TEXT,
			summary TEXT NOT NULL DEFAULT '',
			tags TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'pending',
			provider TEXT NOT NULL DEFAULT 'rules',
			version INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS entries_created ON entries(created_at DESC);
		PRAGMA user_version = 1;
	`); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}

	return conn, nil
}
