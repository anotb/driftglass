PRAGMA foreign_keys = ON;

ALTER TABLE mission_operators ADD COLUMN sprint_policy TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE mission_operators ADD COLUMN next_sprint_at TEXT;
ALTER TABLE mission_operators ADD COLUMN last_sprint_at TEXT;
ALTER TABLE mission_operators ADD COLUMN reminder_lead_days INTEGER NOT NULL DEFAULT 3;
ALTER TABLE mission_operators ADD COLUMN expected_event_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE mission_events ADD COLUMN dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_events_dedupe
  ON mission_events(mission_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mission_operators_autopilot
  ON mission_operators(sprint_policy, next_sprint_at, outcome_status, expected_by);

CREATE TABLE IF NOT EXISTS mission_research_state (
  mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  current_thesis TEXT NOT NULL DEFAULT '',
  report_summary TEXT NOT NULL DEFAULT '',
  open_questions_json TEXT NOT NULL DEFAULT '[]',
  report_title TEXT NOT NULL DEFAULT '',
  report_url TEXT,
  confidence REAL,
  last_research_at TEXT,
  last_handoff_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS research_result_imports (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL,
  diff_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'chatgpt-deep-research',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_result_imports_status
  ON research_result_imports(status, expires_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_result_imports_mission
  ON research_result_imports(mission_id, created_at DESC);

INSERT OR IGNORE INTO mission_research_state(mission_id)
SELECT id FROM missions;

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '8', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
