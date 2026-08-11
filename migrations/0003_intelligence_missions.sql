PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  terms_json TEXT NOT NULL DEFAULT '[]',
  source_scope_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  priority REAL NOT NULL DEFAULT 1.0,
  cadence_minutes INTEGER NOT NULL DEFAULT 360,
  last_evaluated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status, priority DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS mission_story_matches (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  match_score REAL NOT NULL DEFAULT 0,
  matched_terms_json TEXT NOT NULL DEFAULT '[]',
  first_matched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_matched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(mission_id, story_id)
);
CREATE INDEX IF NOT EXISTS idx_mission_story_recent ON mission_story_matches(mission_id, last_matched_at DESC);
CREATE INDEX IF NOT EXISTS idx_story_mission_matches ON mission_story_matches(story_id, match_score DESC);

CREATE TABLE IF NOT EXISTS inbox_receipts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  message_id TEXT,
  sender TEXT,
  recipient TEXT,
  subject TEXT,
  received_at TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_inbox_receipts_received ON inbox_receipts(received_at DESC);

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '3', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
