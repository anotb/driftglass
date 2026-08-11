import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migrationUrls = [
  new URL("../migrations/0001_initial.sql", import.meta.url),
  new URL("../migrations/0002_agent_week.sql", import.meta.url),
  new URL("../migrations/0003_intelligence_missions.sql", import.meta.url),
  new URL("../migrations/0004_public_intelligence.sql", import.meta.url),
  new URL("../migrations/0005_personalization.sql", import.meta.url),
  new URL("../migrations/0006_mission_sprints.sql", import.meta.url),
  new URL("../migrations/0007_mission_operators.sql", import.meta.url),
  new URL("../migrations/0008_feature_complete.sql", import.meta.url),
  new URL("../migrations/0009_memory_graph_and_packs.sql", import.meta.url),
  new URL("../migrations/0010_reasoning_memory.sql", import.meta.url),
  new URL("../migrations/0011_context_compiler_and_playbooks.sql", import.meta.url),
  new URL("../migrations/0012_memory_graph_workflow.sql", import.meta.url),
  new URL("../migrations/0013_runtime_fabric.sql", import.meta.url),
  new URL("../migrations/0014_judgment_loop.sql", import.meta.url),
  new URL("../migrations/0015_reasoning_ledger.sql", import.meta.url),
  new URL("../migrations/0016_evidence_lineage.sql", import.meta.url),
  new URL("../migrations/0017_pack_overlays_and_adaptive_cadence.sql", import.meta.url),
  new URL("../migrations/0018_email_receipt_idempotency.sql", import.meta.url),
  new URL("../migrations/0019_queue_ingest_durability.sql", import.meta.url),
  new URL("../migrations/0020_ingest_completion_state.sql", import.meta.url),
  new URL("../migrations/0021_ingest_deadletter_retry_claims.sql", import.meta.url),
  new URL("../migrations/0022_source_ingest_producer_outbox.sql", import.meta.url),
  new URL("../migrations/0023_mission_match_evidence_index.sql", import.meta.url),
];
const migrations = await Promise.all(migrationUrls.map((url) => readFile(url, "utf8")));

test("all migrations apply to a clean SQLite database and seed a useful cloud mode", () => {
  const db = new DatabaseSync(":memory:");
  for (const sql of migrations) db.exec(sql);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  for (const required of [
    "briefings", "collector_jobs", "collectors", "feedback", "items", "pairing_codes", "settings",
    "source_runs", "sources", "stories", "story_items", "render_profiles", "render_attempts",
    "pack_installs", "saved_views", "missions", "mission_story_matches", "inbox_receipts",
    "public_shares", "taste_terms", "taste_sources", "mission_runs", "mission_operators", "mission_events",
    "mission_research_state", "research_result_imports", "intelligence_packs", "memory_nodes", "memory_edges",
    "usage_daily", "memory_proposals", "intelligence_pack_events", "reasoning_playbooks", "memory_graph_runs",
    "source_run_ingest_receipts", "ingest_dead_letters", "item_ingest_completions",
    "source_ingest_outbox_runs", "source_ingest_outbox_messages",
  ]) assert.ok(tables.includes(required), `missing table ${required}`);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, "23");
  assert.ok(db.prepare("PRAGMA table_info(collector_jobs)").all().some((column) => column.name === "source_run_id"));
  assert.ok(db.prepare("PRAGMA index_list(collector_jobs)").all().some((index) => index.name === "idx_collector_jobs_active_source_operation" && index.unique === 1));
  assert.ok(db.prepare("PRAGMA table_info(ingest_dead_letters)").all().some((column) => column.name === "retry_claim_token"));
  assert.ok(db.prepare("PRAGMA table_info(source_ingest_outbox_runs)").all().some((column) => column.name === "payload_sha256"));
  assert.ok(db.prepare("PRAGMA table_info(source_ingest_outbox_messages)").all().some((column) => column.name === "body_sha256"));
  assert.ok(db.prepare("PRAGMA index_list(story_items)").all().some((index) => index.name === "idx_story_items_match_recent"));
  const sources = db.prepare("SELECT id, kind, config_json FROM sources ORDER BY id").all();
  assert.ok(sources.some((row) => row.kind === "hackernews"));
  assert.ok(sources.some((row) => row.kind === "github_releases"));
  assert.ok(sources.some((row) => row.kind === "web" && row.config_json.includes('"renderStrategy":"adaptive"')));
  db.exec(`INSERT INTO missions(id, name, question, terms_json, source_scope_json, status, priority, cadence_minutes, created_at, updated_at)
    VALUES ('test-mission', 'Test mission', 'What changes?', '["change"]', '[]', 'active', 1, 360, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  db.exec(`INSERT INTO mission_operators(mission_id, mode, research_policy, alert_threshold, expected_next_event, outcome_status, updated_at)
    VALUES ('test-mission', 'decision', 'suggest', 0.7, 'A decision is announced', 'open', CURRENT_TIMESTAMP)`);
  db.exec(`INSERT INTO mission_events(id, mission_id, event_type, title, detail, occurred_at, created_at)
    VALUES ('event-1', 'test-mission', 'signal', 'New evidence', 'A material signal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  assert.equal(db.prepare("SELECT mode FROM mission_operators WHERE mission_id='test-mission'").get().mode, "decision");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mission_events WHERE mission_id='test-mission'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sources").get().count, sources.length);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, "23");
});
