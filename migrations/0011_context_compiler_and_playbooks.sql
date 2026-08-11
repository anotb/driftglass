PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reasoning_playbooks (
  id TEXT PRIMARY KEY,
  pack_id TEXT REFERENCES intelligence_packs(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT 'investigate',
  instructions TEXT NOT NULL,
  trigger_json TEXT NOT NULL DEFAULT '{}',
  provider_hints_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reasoning_playbooks_pack
  ON reasoning_playbooks(pack_id, enabled, task, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_reasoning_playbooks_task
  ON reasoning_playbooks(task, enabled, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS memory_graph_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running',
  node_writes INTEGER NOT NULL DEFAULT 0,
  edge_writes INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_graph_runs_started
  ON memory_graph_runs(started_at DESC);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('memory_graph_auto_refresh', '1'),
  ('memory_graph_refresh_minutes', '360'),
  ('context_token_budget', '12000'),
  ('budget_enforcement', 'conservative');

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '11', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
