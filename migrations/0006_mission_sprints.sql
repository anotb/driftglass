PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mission_runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  workflow_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mission_runs_mission_created
  ON mission_runs(mission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mission_runs_status_updated
  ON mission_runs(status, updated_at DESC);

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '6', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
