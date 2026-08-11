PRAGMA foreign_keys = ON;

-- An item is not a terminal ingest result until its Story link, evidence
-- lineage, Mission matching, and memory-dirty signal have all completed.
-- Rows are created atomically with new items. Existing pre-v0.9 items are
-- enrolled lazily so a duplicate delivery can reconcile any legacy partial
-- ingest before it is acknowledged.
CREATE TABLE IF NOT EXISTS item_ingest_completions (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  origin_key_hash TEXT,
  story_id TEXT REFERENCES stories(id) ON DELETE SET NULL,
  stage INTEGER NOT NULL DEFAULT 0 CHECK (stage BETWEEN 0 AND 4),
  lease_token TEXT,
  lease_expires_at TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_item_ingest_completions_pending
  ON item_ingest_completions(stage, lease_expires_at)
  WHERE completed_at IS NULL;

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '20', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
