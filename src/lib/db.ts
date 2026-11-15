import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const globalDb = globalThis as unknown as { sparkDb?: Database.Database };

export function getDb() {
  if (globalDb.sparkDb) return globalDb.sparkDb;
  // Runtime user data must not be bundled into the application artifact.
  const directory = path.resolve(
    /* turbopackIgnore: true */ process.env.SPARK_DATA_DIR || "./data",
  );
  mkdirSync(directory, { recursive: true });
  const db = new Database(path.join(directory, "spark.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
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
  `);
  globalDb.sparkDb = db;
  return db;
}
