PRAGMA foreign_keys = ON;

ALTER TABLE ingest_dead_letters ADD COLUMN retry_claim_token TEXT;
ALTER TABLE ingest_dead_letters ADD COLUMN retry_claimed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_ingest_dead_letters_retry_claim
  ON ingest_dead_letters(status, retry_claimed_at)
  WHERE status = 'unresolved';

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '21', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
