PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mission_operators (
  mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'watch',
  research_policy TEXT NOT NULL DEFAULT 'suggest',
  alert_threshold REAL NOT NULL DEFAULT 0.65,
  expected_next_event TEXT NOT NULL DEFAULT '',
  expected_by TEXT,
  outcome_status TEXT NOT NULL DEFAULT 'open',
  outcome_summary TEXT NOT NULL DEFAULT '',
  resolved_at TEXT,
  last_escalated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mission_operators_outcome
  ON mission_operators(outcome_status, expected_by, alert_threshold DESC);

CREATE TABLE IF NOT EXISTS mission_events (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  story_id TEXT REFERENCES stories(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mission_events_mission_time
  ON mission_events(mission_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_mission_events_story
  ON mission_events(story_id, occurred_at DESC);

INSERT OR IGNORE INTO mission_operators(mission_id)
SELECT id FROM missions;

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '7', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
