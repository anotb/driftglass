PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS intelligence_pack_overlays (
  id TEXT PRIMARY KEY,
  base_pack_id TEXT NOT NULL REFERENCES intelligence_packs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  base_version TEXT NOT NULL,
  overlay_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pack_overlays_base_name
  ON intelligence_pack_overlays(base_pack_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_pack_overlays_status
  ON intelligence_pack_overlays(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS source_cadence (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'adaptive',
  base_minutes INTEGER NOT NULL,
  min_minutes INTEGER NOT NULL,
  max_minutes INTEGER NOT NULL,
  effective_minutes INTEGER NOT NULL,
  next_run_at TEXT,
  yield_ema REAL NOT NULL DEFAULT 0,
  latency_ema_ms REAL NOT NULL DEFAULT 0,
  success_ema REAL NOT NULL DEFAULT 1,
  empty_streak INTEGER NOT NULL DEFAULT 0,
  failure_streak INTEGER NOT NULL DEFAULT 0,
  high_signal_streak INTEGER NOT NULL DEFAULT 0,
  last_reason TEXT NOT NULL DEFAULT 'baseline',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_source_cadence_due
  ON source_cadence(mode, next_run_at);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('adaptive_cadence_enabled', '1'),
  ('adaptive_cadence_jitter_percent', '0.08'),
  ('pack_overlay_mode', 'preserve');

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '17', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
