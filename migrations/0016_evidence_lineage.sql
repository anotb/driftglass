PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS evidence_lineage (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  family_key TEXT NOT NULL,
  origin_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  origin_family_key TEXT,
  relation TEXT NOT NULL DEFAULT 'origin',
  title_similarity REAL NOT NULL DEFAULT 0,
  body_similarity REAL NOT NULL DEFAULT 0,
  independent INTEGER NOT NULL DEFAULT 1,
  rationale TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_evidence_lineage_story
  ON evidence_lineage(story_id, independent DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_evidence_lineage_family
  ON evidence_lineage(family_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_lineage_origin
  ON evidence_lineage(origin_item_id, created_at ASC);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('evidence_lineage_enabled', '1'),
  ('evidence_echo_title_threshold', '0.88'),
  ('evidence_echo_body_threshold', '0.72');

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '16', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
