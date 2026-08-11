PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reasoning_tasks (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT,
  task TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT 'chatgpt',
  objective TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0.5,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  dedupe_key TEXT NOT NULL,
  receipt_id TEXT REFERENCES reasoning_receipts(id) ON DELETE SET NULL,
  due_at TEXT,
  expires_at TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reasoning_tasks_status_priority
  ON reasoning_tasks(status, priority DESC, due_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reasoning_tasks_scope
  ON reasoning_tasks(scope_kind, scope_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reasoning_tasks_active_dedupe
  ON reasoning_tasks(dedupe_key)
  WHERE status IN ('queued', 'ready', 'claimed');

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  story_id TEXT REFERENCES stories(id) ON DELETE SET NULL,
  reasoning_task_id TEXT REFERENCES reasoning_tasks(id) ON DELETE SET NULL,
  reasoning_receipt_id TEXT REFERENCES reasoning_receipts(id) ON DELETE SET NULL,
  decision_type TEXT NOT NULL DEFAULT 'decision',
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  confidence REAL NOT NULL DEFAULT 0.5,
  expected_outcome TEXT NOT NULL DEFAULT '',
  review_at TEXT,
  outcome_summary TEXT NOT NULL DEFAULT '',
  outcome_value REAL,
  calibration_score REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_status_review
  ON decisions(status, review_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_mission
  ON decisions(mission_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_story
  ON decisions(story_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS decision_reviews (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  observed_outcome TEXT NOT NULL,
  actual_value REAL,
  quality_score REAL,
  calibration_score REAL,
  lesson TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  provider TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_decision_reviews_decision
  ON decision_reviews(decision_id, created_at DESC);

CREATE TABLE IF NOT EXISTS intelligence_pack_snapshots (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES intelligence_packs(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  source_url TEXT,
  event_type TEXT NOT NULL DEFAULT 'install',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_intelligence_pack_snapshots_pack
  ON intelligence_pack_snapshots(pack_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_pack_snapshots_checksum
  ON intelligence_pack_snapshots(pack_id, checksum);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('reasoning_tasks_retention_days', '30'),
  ('reasoning_tasks_auto_create', '1'),
  ('decision_review_lead_days', '3'),
  ('mcp_contract_version', '1');

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '14', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
