PRAGMA foreign_keys = ON;

ALTER TABLE memory_graph_runs ADD COLUMN workflow_id TEXT;
ALTER TABLE memory_graph_runs ADD COLUMN profile TEXT NOT NULL DEFAULT 'free';
ALTER TABLE memory_graph_runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE memory_graph_runs ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_memory_graph_runs_status_updated
  ON memory_graph_runs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_graph_runs_workflow
  ON memory_graph_runs(workflow_id);

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '12', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
