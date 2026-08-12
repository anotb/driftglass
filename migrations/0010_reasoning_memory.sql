PRAGMA foreign_keys = ON;

ALTER TABLE memory_nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE memory_nodes ADD COLUMN superseded_by TEXT;
ALTER TABLE memory_nodes ADD COLUMN source_ref TEXT;
ALTER TABLE memory_nodes ADD COLUMN valid_from TEXT;
ALTER TABLE memory_nodes ADD COLUMN valid_to TEXT;

ALTER TABLE memory_edges ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE memory_edges ADD COLUMN rationale TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS memory_proposals (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_id TEXT,
  provider TEXT NOT NULL,
  title TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_status_created
  ON memory_proposals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_scope
  ON memory_proposals(scope_kind, scope_id, created_at DESC);

CREATE TABLE IF NOT EXISTS intelligence_pack_events (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES intelligence_packs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_intelligence_pack_events_pack
  ON intelligence_pack_events(pack_id, created_at DESC);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('memory_graph_limits', '{"maxNodes":500,"maxEdges":2000,"maxPendingProposals":50,"maxNeighborhoodNodes":80}'),
  ('reasoning_default_provider', 'chatgpt');

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '10', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
