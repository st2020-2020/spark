package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// Store manages the desktop app's local SQLite cache, account-isolated outbox,
// and atomic on-disk attachment staging directory.
type Store struct {
	db         *sql.DB
	dataDir    string
	stagingDir string
}

// Open initializes spark-desktop.sqlite inside dataDir and prepares the staging directory.
func Open(dataDir string) (*Store, error) {
	if dataDir == "" {
		return nil, fmt.Errorf("desktop data dir is empty")
	}
	absDir, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, fmt.Errorf("resolve data dir: %w", err)
	}
	stagingDir := filepath.Join(absDir, "staging")
	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		return nil, fmt.Errorf("create staging dir: %w", err)
	}

	dbPath := filepath.Join(absDir, "spark-desktop.sqlite")
	conn, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open desktop sqlite: %w", err)
	}
	conn.SetMaxOpenConns(1)

	if _, err := conn.Exec(schemaSQL); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("init desktop sqlite schema: %w", err)
	}

	return &Store{
		db:         conn,
		dataDir:    absDir,
		stagingDir: stagingDir,
	}, nil
}

func (s *Store) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) DataDir() string    { return s.dataDir }
func (s *Store) StagingDir() string { return s.stagingDir }

// writeFileAtomic persists data using temp-file -> Sync -> Close -> Rename -> dir Sync
// so a crash or power loss never leaves a half-written staged image file.
func writeFileAtomic(destPath string, data []byte) error {
	dir := filepath.Dir(destPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()

	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, destPath); err != nil {
		return err
	}
	cleanup = false

	dirHandle, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer dirHandle.Close()
	return dirHandle.Sync()
}

const schemaSQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS outbox_items (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	raw_text TEXT NOT NULL,
	intent TEXT NOT NULL DEFAULT '',
	original_url TEXT NOT NULL DEFAULT '',
	manual_title TEXT NOT NULL DEFAULT '',
	project_ids_json TEXT NOT NULL DEFAULT '[]',
	tag_ids_json TEXT NOT NULL DEFAULT '[]',
	idempotency_key TEXT NOT NULL,
	frozen_request_json TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL CHECK(state IN ('local_saved', 'syncing', 'synced', 'needs_review', 'auth_paused')),
	ever_sent INTEGER NOT NULL DEFAULT 0,
	first_sent_at TEXT NOT NULL DEFAULT '',
	last_attempt_at TEXT NOT NULL DEFAULT '',
	next_retry_at TEXT NOT NULL DEFAULT '',
	attempt_count INTEGER NOT NULL DEFAULT 0,
	last_error_code TEXT NOT NULL DEFAULT '',
	last_error_message TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_account_state ON outbox_items(account_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS outbox_attachments (
	id TEXT PRIMARY KEY,
	outbox_id TEXT NOT NULL REFERENCES outbox_items(id) ON DELETE CASCADE,
	account_id TEXT NOT NULL,
	ord INTEGER NOT NULL,
	filename TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	local_path TEXT NOT NULL,
	upload_idempotency_key TEXT NOT NULL,
	upload_id TEXT NOT NULL DEFAULT '',
	stage TEXT NOT NULL DEFAULT 'pending_local' CHECK(stage IN ('pending_local', 'grant_issued', 'uploaded_oss', 'verifying', 'ready', 'failed')),
	upload_registered_at TEXT NOT NULL DEFAULT '',
	upload_expires_at TEXT NOT NULL DEFAULT '',
	grant_url TEXT NOT NULL DEFAULT '',
	grant_method TEXT NOT NULL DEFAULT '',
	grant_headers_json TEXT NOT NULL DEFAULT '{}',
	grant_expires_at TEXT NOT NULL DEFAULT '',
	last_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_outbox_att_item ON outbox_attachments(outbox_id, ord ASC);

CREATE TABLE IF NOT EXISTS cached_collections (
	account_id TEXT NOT NULL,
	id TEXT NOT NULL,
	display_title TEXT NOT NULL DEFAULT '',
	plain_text TEXT NOT NULL DEFAULT '',
	intent TEXT NOT NULL DEFAULT '',
	original_url TEXT NOT NULL DEFAULT '',
	primary_type TEXT NOT NULL DEFAULT 'text',
	read_at TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	searchable_text TEXT NOT NULL DEFAULT '',
	summary_json TEXT NOT NULL,
	detail_json TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (account_id, id)
);

CREATE INDEX IF NOT EXISTS idx_cached_col_account_created ON cached_collections(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cached_projects (
	account_id TEXT NOT NULL,
	id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL DEFAULT 'active',
	collection_count INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL DEFAULT '',
	raw_json TEXT NOT NULL,
	PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS cached_tags (
	account_id TEXT NOT NULL,
	id TEXT NOT NULL,
	name TEXT NOT NULL,
	collection_count INTEGER NOT NULL DEFAULT 0,
	raw_json TEXT NOT NULL,
	PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS local_prefs (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

PRAGMA user_version = 1;
`
