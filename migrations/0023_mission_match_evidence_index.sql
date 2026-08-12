CREATE INDEX IF NOT EXISTS idx_story_items_match_recent
  ON story_items(story_id, created_at DESC, item_id ASC);

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '23', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
