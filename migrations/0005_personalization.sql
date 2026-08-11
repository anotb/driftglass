PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS taste_terms (
  term TEXT PRIMARY KEY,
  weight REAL NOT NULL DEFAULT 0,
  positive_count INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  last_story_id TEXT REFERENCES stories(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_taste_terms_weight ON taste_terms(ABS(weight) DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS taste_sources (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 0,
  positive_count INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_taste_sources_weight ON taste_sources(ABS(weight) DESC, updated_at DESC);

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '5', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
