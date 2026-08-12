PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_minutes INTEGER NOT NULL DEFAULT 60,
  weight REAL NOT NULL DEFAULT 1.0,
  last_run_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  health_score REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sources_due ON sources(enabled, last_run_at);

CREATE TABLE IF NOT EXISTS source_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  provider TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_source_runs_source_time ON source_runs(source_id, started_at DESC);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id TEXT,
  url TEXT,
  canonical_url TEXT,
  title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  author TEXT,
  published_at TEXT,
  observed_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  raw_r2_key TEXT,
  access_class TEXT NOT NULL DEFAULT 'public',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_id, external_id, content_hash),
  UNIQUE(source_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_items_observed ON items(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_url ON items(canonical_url);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'developing',
  first_seen_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  relevance REAL NOT NULL DEFAULT 0.5,
  novelty REAL NOT NULL DEFAULT 1.0,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  source_count INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_stories_recent ON stories(last_changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_score ON stories(score DESC, last_changed_at DESC);

CREATE TABLE IF NOT EXISTS story_items (
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL DEFAULT 'coverage',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(story_id, item_id)
);

CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete',
  packet_json TEXT NOT NULL,
  markdown TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_briefings_created ON briefings(created_at DESC);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  story_id TEXT REFERENCES stories(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pairing_codes_expiry ON pairing_codes(expires_at, used_at);

CREATE TABLE IF NOT EXISTS collectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen_at TEXT,
  version TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collector_jobs (
  id TEXT PRIMARY KEY,
  collector_id TEXT REFERENCES collectors(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_collector_jobs_claim ON collector_jobs(status, collector_id, created_at);


CREATE TABLE IF NOT EXISTS upstream_health (
  provider TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}',
  last_checked_at TEXT NOT NULL,
  PRIMARY KEY(provider, capability)
);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('schema_version', '1'),
  ('interest_terms', '["ai agents","coding agents","cloudflare","data centers","power","openai","anthropic"]');

INSERT OR IGNORE INTO sources(
  id, name, kind, config_json, enabled, schedule_minutes, weight
) VALUES
  (
    'starter-hn-best',
    'Hacker News — Best',
    'hackernews',
    '{"feed":"best","limit":35,"minScore":20,"watchTerms":["agent","cloudflare","openai","anthropic","data center","power"]}',
    1, 60, 1.1
  ),
  (
    'starter-cloudflare-workers-sdk',
    'Cloudflare Workers SDK releases',
    'github_releases',
    '{"repos":["cloudflare/workers-sdk","cloudflare/agents"],"perRepo":8,"includePrereleases":false,"watchTerms":["agents","browser","mcp","workers"]}',
    1, 120, 1.3
  ),
  (
    'starter-cloudflare-ai-changelog',
    'Cloudflare AI changelog',
    'web',
    '{"url":"https://developers.cloudflare.com/changelog/product-group/ai/","title":"Cloudflare AI changelog","renderStrategy":"adaptive","mode":"monitor"}',
    1, 360, 1.4
  );
