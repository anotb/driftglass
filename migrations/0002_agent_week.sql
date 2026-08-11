PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS render_profiles (
  hostname TEXT PRIMARY KEY,
  preferred_engine TEXT NOT NULL DEFAULT 'kitesurf',
  kitesurf_successes INTEGER NOT NULL DEFAULT 0,
  kitesurf_failures INTEGER NOT NULL DEFAULT 0,
  kitesurf_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  kitesurf_avg_ms REAL,
  chromium_successes INTEGER NOT NULL DEFAULT 0,
  chromium_failures INTEGER NOT NULL DEFAULT 0,
  chromium_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  chromium_avg_ms REAL,
  last_engine TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS render_attempts (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  hostname TEXT NOT NULL,
  engine TEXT NOT NULL,
  status TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  browser_ms INTEGER,
  content_length INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_render_attempts_recent ON render_attempts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_render_attempts_host ON render_attempts(hostname, created_at DESC);

CREATE TABLE IF NOT EXISTS pack_installs (
  pack_id TEXT PRIMARY KEY,
  installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '2', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
