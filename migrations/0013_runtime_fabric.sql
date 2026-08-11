PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS intelligence_routines (
  id TEXT PRIMARY KEY,
  pack_id TEXT REFERENCES intelligence_packs(id) ON DELETE SET NULL,
  mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_minutes INTEGER,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_intelligence_routines_due
  ON intelligence_routines(enabled, next_run_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_intelligence_routines_pack
  ON intelligence_routines(pack_id, enabled, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_intelligence_routines_mission
  ON intelligence_routines(mission_id, enabled, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS intelligence_routine_runs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES intelligence_routines(id) ON DELETE CASCADE,
  workflow_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  plan_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_intelligence_routine_runs_routine
  ON intelligence_routine_runs(routine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intelligence_routine_runs_status
  ON intelligence_routine_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_checkpoints (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_id TEXT,
  title TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  snapshot_r2_key TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  diff_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_memory_checkpoints_scope
  ON memory_checkpoints(scope_kind, scope_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reasoning_receipts (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_id TEXT,
  task TEXT NOT NULL,
  target TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  bundle_version INTEGER NOT NULL DEFAULT 3,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  independent_family_count INTEGER NOT NULL DEFAULT 0,
  bundle_hash TEXT NOT NULL,
  bundle_r2_key TEXT NOT NULL,
  quality_json TEXT NOT NULL DEFAULT '{}',
  provider_label TEXT,
  model_label TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  result_r2_key TEXT,
  confidence REAL,
  citations_json TEXT NOT NULL DEFAULT '[]',
  decision_note TEXT,
  status TEXT NOT NULL DEFAULT 'prepared',
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reasoning_receipts_scope
  ON reasoning_receipts(scope_kind, scope_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reasoning_receipts_hash
  ON reasoning_receipts(bundle_hash, created_at DESC);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('runtime_policy', '{"mode":"auto","preferCloud":true,"allowCompanion":true,"allowComputer":true,"allowChromiumFallback":true}'),
  ('routine_autopilot', '1'),
  ('memory_checkpoint_auto', '1'),
  ('reasoning_receipt_retention_days', '90');

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '13', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
