PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS intelligence_packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Community',
  icon TEXT NOT NULL DEFAULT '✦',
  manifest_json TEXT NOT NULL,
  source_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  budget_profile TEXT NOT NULL DEFAULT 'free',
  installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_intelligence_packs_enabled
  ON intelligence_packs(enabled, category, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS memory_nodes (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  label TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  occurred_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(node_type, canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_type_importance
  ON memory_nodes(node_type, importance DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_recent
  ON memory_nodes(last_seen_at DESC, importance DESC);

CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  to_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(from_node_id, to_node_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_memory_edges_from
  ON memory_edges(from_node_id, weight DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_edges_to
  ON memory_edges(to_node_id, weight DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_edges_relation
  ON memory_edges(relation, weight DESC, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  dimension TEXT NOT NULL,
  units REAL NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(day, dimension)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day DESC, dimension);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('budget_profile', 'free'),
  ('memory_graph_dirty', '1'),
  ('memory_graph_last_refresh_at', '');

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '9', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
