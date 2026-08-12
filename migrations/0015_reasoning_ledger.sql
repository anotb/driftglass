PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reasoning_runs (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES reasoning_receipts(id) ON DELETE CASCADE,
  provider_label TEXT NOT NULL,
  model_label TEXT,
  client_label TEXT,
  status TEXT NOT NULL DEFAULT 'started',
  response_hash TEXT,
  response_r2_key TEXT,
  response_summary TEXT NOT NULL DEFAULT '',
  structured_result_json TEXT NOT NULL DEFAULT '{}',
  audit_json TEXT NOT NULL DEFAULT '{}',
  outcome_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL,
  rating INTEGER,
  memory_proposal_id TEXT REFERENCES memory_proposals(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reasoning_runs_receipt
  ON reasoning_runs(receipt_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reasoning_runs_provider
  ON reasoning_runs(provider_label, model_label, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reasoning_runs_status
  ON reasoning_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS reasoning_run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES reasoning_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reasoning_run_events_run
  ON reasoning_run_events(run_id, created_at ASC);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('reasoning_ledger_auto_store', '1'),
  ('reasoning_ledger_retention_days', '180');

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '15', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
