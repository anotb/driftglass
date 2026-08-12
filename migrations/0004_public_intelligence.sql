PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS public_shares (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_public_shares_expiry ON public_shares(expires_at);
CREATE INDEX IF NOT EXISTS idx_public_shares_created ON public_shares(created_at DESC);

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '4', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
