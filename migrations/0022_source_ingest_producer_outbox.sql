PRAGMA foreign_keys = ON;

-- Built-in public source runs stage their exact Queue bodies here before the
-- source run becomes active. The run header is the bounded reservation and
-- activation record. Ready message rows remain immutable through intermediate
-- checkpoints and are removed only by the terminal run-header cascade.
CREATE TABLE IF NOT EXISTS source_ingest_outbox_runs (
  run_id TEXT PRIMARY KEY REFERENCES source_runs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'staging' CHECK (state IN ('staging', 'ready', 'abandoned')),
  message_count INTEGER NOT NULL CHECK (message_count > 0 AND message_count <= 800),
  total_bytes INTEGER NOT NULL CHECK (total_bytes > 0 AND total_bytes <= 4000000),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  next_index INTEGER NOT NULL DEFAULT 0 CHECK (next_index >= 0 AND next_index <= message_count),
  collection_partial INTEGER NOT NULL DEFAULT 0 CHECK (collection_partial IN (0, 1)),
  collection_health_delta REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_ingest_outbox_messages (
  run_id TEXT NOT NULL REFERENCES source_ingest_outbox_runs(run_id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  message_json TEXT NOT NULL,
  message_bytes INTEGER NOT NULL CHECK (message_bytes > 0 AND message_bytes <= 60000),
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  raw_r2_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, item_index)
);

CREATE INDEX IF NOT EXISTS idx_source_ingest_outbox_ready
  ON source_ingest_outbox_runs(state, lease_expires_at, activated_at, created_at)
  WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS idx_source_ingest_outbox_staging
  ON source_ingest_outbox_runs(state, created_at)
  WHERE state IN ('staging', 'abandoned');

-- Exact staged bodies and the run-level body-set digest are immutable. Staging
-- rows may be cleaned before activation; ready rows survive until completion.
CREATE TRIGGER IF NOT EXISTS source_ingest_outbox_message_immutable
BEFORE UPDATE ON source_ingest_outbox_messages
BEGIN
  SELECT RAISE(ABORT, 'source ingest outbox messages are immutable');
END;

CREATE TRIGGER IF NOT EXISTS source_ingest_outbox_digest_immutable
BEFORE UPDATE OF source_id, message_count, total_bytes, payload_sha256
ON source_ingest_outbox_runs
BEGIN
  SELECT RAISE(ABORT, 'source ingest outbox body-set digest is immutable');
END;

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '22', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
