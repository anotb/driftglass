PRAGMA foreign_keys = ON;

ALTER TABLE source_runs ADD COLUMN collection_finished_at TEXT;
ALTER TABLE source_runs ADD COLUMN collection_partial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN collection_health_delta REAL NOT NULL DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN enqueued_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN ingested_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN duplicate_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN ingest_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN ingest_updated_at TEXT;
ALTER TABLE source_runs ADD COLUMN last_ingest_error TEXT;
ALTER TABLE source_runs ADD COLUMN terminal_accounted_at TEXT;
ALTER TABLE collector_jobs ADD COLUMN source_run_id TEXT REFERENCES source_runs(id) ON DELETE SET NULL;

-- Preserve the oldest active job if an upgrade happens while duplicate legacy
-- work is queued, then make future concurrent source runs converge atomically.
UPDATE collector_jobs
SET status = 'failed',
    error = COALESCE(error, 'Superseded duplicate active collector job during durability migration'),
    updated_at = CURRENT_TIMESTAMP
WHERE status IN ('queued', 'leased')
  AND EXISTS (
    SELECT 1 FROM collector_jobs AS keeper
    WHERE keeper.source_id = collector_jobs.source_id
      AND keeper.operation = collector_jobs.operation
      AND keeper.status IN ('queued', 'leased')
      AND (
        datetime(keeper.created_at) < datetime(collector_jobs.created_at) OR
        (keeper.created_at = collector_jobs.created_at AND keeper.rowid < collector_jobs.rowid)
      )
  );

UPDATE source_runs
SET collection_finished_at = finished_at,
    terminal_accounted_at = CASE
      WHEN status IN ('success', 'partial', 'failed') THEN finished_at
      ELSE NULL
    END
WHERE collection_finished_at IS NULL AND finished_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS source_run_ingest_receipts (
  run_id TEXT NOT NULL REFERENCES source_runs(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('inserted', 'duplicate', 'failed')),
  item_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, item_index)
);
CREATE INDEX IF NOT EXISTS idx_source_run_ingest_receipts_created
  ON source_run_ingest_receipts(created_at);
CREATE INDEX IF NOT EXISTS idx_source_runs_ingest_pending
  ON source_runs(status, collection_finished_at)
  WHERE status = 'queued' AND enqueued_count > 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_collector_jobs_source_run
  ON collector_jobs(source_run_id)
  WHERE source_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_collector_jobs_active_source_operation
  ON collector_jobs(source_id, operation)
  WHERE status IN ('queued', 'leased');

-- A content-free operator index plus a bounded, owner-private recovery body for
-- exhausted messages whose tracked source run was absent (legacy Email/manual/
-- Companion messages or a source deleted in flight). API lists never select the
-- body, and retry/dismiss clears it.
CREATE TABLE IF NOT EXISTS ingest_dead_letters (
  id TEXT PRIMARY KEY,
  queue_message_id TEXT NOT NULL UNIQUE,
  queue_name TEXT NOT NULL,
  source_id TEXT,
  provider TEXT,
  source_run_id TEXT,
  source_run_item_index INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  body_json TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  body_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved', 'resolved', 'ignored')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingest_dead_letters_status_created
  ON ingest_dead_letters(status, created_at DESC);

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '19', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
