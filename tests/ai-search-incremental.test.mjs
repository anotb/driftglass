import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const {
  AI_SEARCH_INSTANCE_ID,
  AI_SEARCH_MAX_ATTEMPTS_PER_GENERATION,
  AI_SEARCH_QUERY_OPERATION_RESERVATION,
  AI_SEARCH_SYNC_DELETE_OPERATION_RESERVATION,
  AI_SEARCH_SYNC_PAGE_SIZE,
  AI_SEARCH_SYNC_REPLACE_OPERATION_RESERVATION,
  semanticSearch,
  syncAISearchIfEnabled,
} = require("../.test-dist/ai-search.js");
const { budgetStatus, reserveMonthly } = require("../.test-dist/budget.js");

const migrationDirectory = new URL("../migrations/", import.meta.url);
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
const migrations = await Promise.all(migrationNames.map(async (name) => ({
  name,
  sql: await readFile(new URL(name, migrationDirectory), "utf8"),
})));

class SqliteD1Statement {
  constructor(owner, query) {
    this.owner = owner;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    this.owner.record("run", this);
    const result = this.owner.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }

  async first() {
    this.owner.record("first", this);
    return this.owner.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    this.owner.record("all", this);
    return { success: true, results: this.owner.database.prepare(this.query).all(...this.values), meta: {} };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
    this.queryCount = 0;
    this.calls = [];
  }

  prepare(query) {
    return new SqliteD1Statement(this, query);
  }

  record(method, statement) {
    this.queryCount += 1;
    this.calls.push({ method, query: statement.query, values: [...statement.values] });
  }

  resetCount() {
    this.queryCount = 0;
    this.calls = [];
  }
}

class RecordingAISearch {
  constructor() {
    this.itemsById = new Map();
    this.uploads = 0;
    this.polledUploads = 0;
    this.deletes = 0;
    this.bindingOperations = 0;
    this.namespaceLists = 0;
    this.itemLists = 0;
    this.searches = 0;
    this.failUploadKeys = new Set();
    this.failDeleteKeys = new Set();
    this.failSearch = false;
    this.uploadAttemptsByKey = new Map();
    this.deleteAttemptsByKey = new Map();
    this.put("stories/retired.md", "retired");
    this.instance = {
      items: {
        list: async ({ search }) => {
          this.bindingOperations += 1;
          this.itemLists += 1;
          return { result: [...this.itemsById.values()].filter((item) => item.key.includes(search)) };
        },
        delete: async (id) => {
          this.bindingOperations += 1;
          const item = this.itemsById.get(id);
          if (!item) return;
          this.deleteAttemptsByKey.set(item.key, Number(this.deleteAttemptsByKey.get(item.key) ?? 0) + 1);
          if (this.failDeleteKeys.has(item.key)) throw new Error(`Injected delete failure for ${item.key}`);
          if (this.itemsById.delete(id)) this.deletes += 1;
        },
        upload: async (key, content, options) => {
          this.bindingOperations += 1;
          this.recordUpload(key, content, options?.metadata, false);
        },
        uploadAndPoll: async (key, content, options) => {
          this.bindingOperations += 1;
          this.recordUpload(key, content, options?.metadata, true);
        },
      },
      search: async ({ query }) => {
        this.bindingOperations += 1;
        this.searches += 1;
        if (this.failSearch) throw new Error("Injected AI Search query failure");
        return { search_query: query, chunks: [] };
      },
    };
  }

  put(key, content, metadata = {}) {
    const id = `item:${key}`;
    this.itemsById.set(id, { id, key, content, metadata });
  }

  recordUpload(key, content, metadata, polled) {
    this.uploadAttemptsByKey.set(key, Number(this.uploadAttemptsByKey.get(key) ?? 0) + 1);
    if (this.failUploadKeys.has(key)) throw new Error(`Injected upload failure for ${key}`);
    this.uploads += 1;
    if (polled) this.polledUploads += 1;
    this.put(key, content, metadata);
  }

  async list() {
    this.bindingOperations += 1;
    this.namespaceLists += 1;
    return { result: [{ id: AI_SEARCH_INSTANCE_ID }] };
  }

  get() {
    return this.instance;
  }
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration.sql);
  const source = database.prepare(
    "INSERT INTO sources(id, name, kind) VALUES ('source-a', 'Source A', 'rss')",
  );
  source.run();
  const insertStory = database.prepare(
    `INSERT INTO stories(
       id, canonical_key, title, summary, first_seen_at, last_changed_at,
       score, confidence, source_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0.8, 1)`,
  );
  const insertItem = database.prepare(
    `INSERT INTO items(
       id, source_id, external_id, url, canonical_url, title, text,
       published_at, observed_at, content_hash
     ) VALUES (?, 'source-a', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertStoryItem = database.prepare(
    "INSERT INTO story_items(story_id, item_id) VALUES (?, ?)",
  );
  for (let index = 0; index < 180; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const changedAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    insertStory.run(
      `story-${suffix}`,
      `canonical-${suffix}`,
      `Story ${suffix}`,
      `Summary ${suffix}`,
      changedAt,
      changedAt,
      1_000 - index,
    );
    insertItem.run(
      `item-${suffix}`,
      `external-${suffix}`,
      `https://example.test/${suffix}`,
      `https://example.test/${suffix}`,
      `Evidence ${suffix}`,
      `Evidence body ${suffix}`,
      changedAt,
      changedAt,
      suffix.padEnd(64, "0"),
    );
    insertStoryItem.run(`story-${suffix}`, `item-${suffix}`);
  }

  const insertMission = database.prepare(
    `INSERT INTO missions(
       id, name, question, terms_json, source_scope_json, status, priority,
       cadence_minutes, created_at, updated_at
     ) VALUES (?, ?, ?, ?, '[]', 'active', ?, 360, ?, ?)`,
  );
  const insertOperator = database.prepare("INSERT INTO mission_operators(mission_id) VALUES (?)");
  const insertResearch = database.prepare(
    `INSERT INTO mission_research_state(
       mission_id, current_thesis, report_summary, open_questions_json
     ) VALUES (?, ?, ?, ?)`,
  );
  for (let index = 0; index < 80; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const updatedAt = new Date(Date.UTC(2026, 1, 1, 0, index)).toISOString();
    insertMission.run(
      `mission-${suffix}`,
      `Mission ${suffix}`,
      `Question ${suffix}?`,
      JSON.stringify([`term-${suffix}`]),
      80 - index,
      updatedAt,
      updatedAt,
    );
    insertOperator.run(`mission-${suffix}`);
    insertResearch.run(
      `mission-${suffix}`,
      `Thesis ${suffix}`,
      `Research summary ${suffix}`,
      JSON.stringify([`Open question ${suffix}?`]),
    );
  }

  database.prepare(
    `INSERT INTO briefings(id, period_start, period_end, packet_json, markdown, created_at)
     VALUES ('briefing-a', '2026-01-01', '2026-02-01', '{}', '# Briefing', '2026-02-01T00:00:00.000Z')`,
  ).run();
  database.prepare(
    `INSERT INTO settings(key, value) VALUES
       ('ai_search_enabled', 'enabled'),
       ('ai_search_indexed_keys', '["stories/retired.md"]')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();

  return { database, d1: new SqliteD1(database) };
}

function insertMonthlyAISearchUsage(database, units) {
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO usage_daily(day, dimension, units, metadata_json, updated_at)
     VALUES (?, 'ai_search_queries', ?, '{"operation":"fixture"}', ?)`,
  ).run(`${now.slice(0, 7)}-01`, units, now);
}

test("semantic search atomically reserves its monthly query before any remote work", async () => {
  const { database, d1 } = fixture();
  const aiSearch = new RecordingAISearch();
  insertMonthlyAISearchUsage(database, 15_000);
  d1.resetCount();

  await assert.rejects(
    semanticSearch({ DB: d1, AI_SEARCH: aiSearch }, "governed query"),
    (error) => error?.name === "BudgetDeferredError"
      && error?.dimension === "ai_search_queries"
      && error?.requested === AI_SEARCH_QUERY_OPERATION_RESERVATION
      && error?.remaining === 0,
  );
  assert.equal(AI_SEARCH_QUERY_OPERATION_RESERVATION, 2);
  assert.equal(aiSearch.bindingOperations, 0);
  assert.equal(aiSearch.namespaceLists, 0);
  assert.equal(aiSearch.searches, 0);
  assert.equal(d1.queryCount, 4, "enabled check plus one atomic monthly reservation envelope");
  assert.equal(
    database.prepare("SELECT SUM(units) AS units FROM usage_daily WHERE dimension = 'ai_search_queries'").get().units,
    15_000,
  );
});

test("failed semantic search retains its successful pre-call reservation", async () => {
  const { database, d1 } = fixture();
  const aiSearch = new RecordingAISearch();
  aiSearch.failSearch = true;

  await assert.rejects(
    semanticSearch({ DB: d1, AI_SEARCH: aiSearch }, "ambiguous remote failure"),
    /Injected AI Search query failure/,
  );
  assert.equal(aiSearch.namespaceLists, 1);
  assert.equal(aiSearch.searches, 1);
  assert.equal(
    database.prepare("SELECT units FROM usage_daily WHERE dimension = 'ai_search_queries'").get().units,
    AI_SEARCH_QUERY_OPERATION_RESERVATION,
  );
});

test("concurrent final-capacity monthly reservations admit only one caller", async () => {
  const { database, d1 } = fixture();
  insertMonthlyAISearchUsage(database, 15_000 - AI_SEARCH_QUERY_OPERATION_RESERVATION);

  const results = await Promise.all([
    reserveMonthly(d1, "ai_search_queries", AI_SEARCH_QUERY_OPERATION_RESERVATION, { attempt: "first" }),
    reserveMonthly(d1, "ai_search_queries", AI_SEARCH_QUERY_OPERATION_RESERVATION, { attempt: "second" }),
  ]);
  assert.equal(results.filter((result) => result.allowed).length, 1);
  assert.equal(results.filter((result) => !result.allowed).length, 1);
  assert.ok(results.every((result) => result.remaining === 0));
  assert.equal(
    database.prepare("SELECT SUM(units) AS units FROM usage_daily WHERE dimension = 'ai_search_queries'").get().units,
    15_000,
  );
});

test("monthly AI Search ledger reads use the indexed day range", async () => {
  const { database, d1 } = fixture();
  const aiSearch = new RecordingAISearch();
  await semanticSearch({ DB: d1, AI_SEARCH: aiSearch }, "indexed month range");
  const status = await budgetStatus(d1);
  assert.equal(status.monthly.ai_search_queries, AI_SEARCH_QUERY_OPERATION_RESERVATION);

  const reservationWrite = d1.calls.find((call) => (
    call.query.includes("INSERT INTO usage_daily") && call.query.includes("FROM usage_daily monthly")
  ));
  assert.ok(reservationWrite);
  assert.doesNotMatch(reservationWrite.query, /substr\s*\(/i);
  assert.equal((reservationWrite.query.match(/monthly\.day >= \?/g) || []).length, 2);
  assert.equal((reservationWrite.query.match(/monthly\.day < \?/g) || []).length, 2);

  const indexedReads = d1.calls.filter((call) => (
    call.query.includes("FROM usage_daily WHERE day >= ? AND day < ?")
    || (call.query.includes("FROM usage_daily") && call.query.includes("GROUP BY dimension"))
  ));
  assert.equal(indexedReads.length, 2, "reservation total and getUsageMonth both use day ranges");
  for (const call of indexedReads) {
    assert.doesNotMatch(call.query, /substr\s*\(/i);
    assert.match(call.query, /day >= \?[\s\S]*day < \?/);
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${call.query}`).all(...call.values);
    assert.ok(
      plan.some((row) => /SEARCH usage_daily USING INDEX .+ \(day>\? AND day<\?\)/.test(row.detail)),
      `expected indexed day range, got ${JSON.stringify(plan)}`,
    );
  }
});

test("AI Search sync reserves its bounded page policy before namespace or item calls", async () => {
  const { database, d1 } = fixture();
  const aiSearch = new RecordingAISearch();
  const requested = 1 + AI_SEARCH_SYNC_PAGE_SIZE * AI_SEARCH_SYNC_REPLACE_OPERATION_RESERVATION;
  insertMonthlyAISearchUsage(database, 15_000 - requested + 1);
  d1.resetCount();

  await assert.rejects(
    syncAISearchIfEnabled({ DB: d1, AI_SEARCH: aiSearch }),
    (error) => error?.name === "BudgetDeferredError"
      && error?.dimension === "ai_search_queries"
      && error?.requested === requested
      && error?.remaining === requested - 1,
  );
  assert.equal(aiSearch.bindingOperations, 0);
  assert.equal(aiSearch.namespaceLists, 0);
  assert.equal(aiSearch.itemLists, 0);
  assert.equal(d1.queryCount, 10, "a denied first page does not spend the final sync-state write");
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'ai_search_sync_state_v2'").get().count,
    0,
  );
  assert.equal(
    database.prepare("SELECT SUM(units) AS units FROM usage_daily WHERE dimension = 'ai_search_queries'").get().units,
    15_000 - requested + 1,
  );
});

test("incremental AI Search sync bounds the worst-case corpus and restarts its durable cursor", async () => {
  const { database, d1 } = fixture();
  const aiSearch = new RecordingAISearch();
  const env = { DB: d1, AI_SEARCH: aiSearch };
  const perPageCounts = [];
  const recordedCalls = [];

  d1.resetCount();
  const first = await syncAISearchIfEnabled(env);
  perPageCounts.push(d1.queryCount);
  recordedCalls.push(...d1.calls);
  assert.equal(AI_SEARCH_SYNC_PAGE_SIZE, 12);
  assert.deepEqual(
    {
      status: first.status,
      phase: first.phase,
      cursor: first.cursor,
      total: first.total,
      documents: first.documents,
      staleDocuments: first.staleDocuments,
    },
    {
      status: "partial",
      phase: "documents",
      cursor: 12,
      total: 262,
      documents: 261,
      staleDocuments: 1,
    },
  );
  assert.equal(AI_SEARCH_SYNC_REPLACE_OPERATION_RESERVATION, 52);
  assert.equal(AI_SEARCH_SYNC_DELETE_OPERATION_RESERVATION, 51);
  assert.equal(d1.queryCount, 11, "enabled + state + manifest + hydration + atomic monthly reservation + state write");
  assert.equal(
    database.prepare("SELECT units FROM usage_daily WHERE dimension = 'ai_search_queries'").get().units,
    1 + AI_SEARCH_SYNC_PAGE_SIZE * AI_SEARCH_SYNC_REPLACE_OPERATION_RESERVATION,
  );
  assert.ok(
    aiSearch.bindingOperations <= 1 + AI_SEARCH_SYNC_PAGE_SIZE * AI_SEARCH_SYNC_REPLACE_OPERATION_RESERVATION,
    "the first page performs no more AI Search binding operations than it reserved",
  );

  d1.resetCount();
  const second = await syncAISearchIfEnabled(env);
  perPageCounts.push(d1.queryCount);
  recordedCalls.push(...d1.calls);
  assert.equal(second.generation, first.generation);
  assert.equal(second.cursor, 24);
  assert.equal(d1.queryCount, 8, "later Story pages include one bounded monthly reservation");

  let result = second;
  for (let invocation = 0; invocation < 30 && !result.complete; invocation += 1) {
    d1.resetCount();
    result = await syncAISearchIfEnabled(env);
    perPageCounts.push(d1.queryCount);
    recordedCalls.push(...d1.calls);
    assert.ok(d1.queryCount < 47, `page used ${d1.queryCount} D1 statements`);
  }
  assert.equal(result.complete, true);
  assert.deepEqual(
    {
      status: result.status,
      phase: result.phase,
      cursor: result.cursor,
      total: result.total,
      uploaded: result.uploaded,
      unchanged: result.unchanged,
      deleted: result.deleted,
      failed: result.failed,
    },
    {
      status: "complete",
      phase: "complete",
      cursor: 262,
      total: 262,
      uploaded: 261,
      unchanged: 0,
      deleted: 1,
      failed: [],
    },
  );
  assert.deepEqual(
    perPageCounts,
    [11, ...Array(14).fill(8), ...Array(6).fill(7), 8, 6],
    "start, Story, Mission, mixed Mission/briefing, and stale pages have fixed D1 envelopes",
  );
  assert.equal(Math.max(...perPageCounts), 11);
  assert.equal(aiSearch.uploads, 261);
  assert.equal(aiSearch.deletes, 1);
  assert.equal(aiSearch.itemsById.size, 261);
  assert.ok(recordedCalls.every((call) => (
    !call.values.some((value) => String(value).startsWith("ai_search_hash:"))
  )), "no page performs a per-document D1 hash read or write");

  const persisted = JSON.parse(
    database.prepare("SELECT value FROM settings WHERE key = 'ai_search_sync_state_v2'").get().value,
  );
  assert.equal(persisted.cycle, undefined);
  assert.equal(Object.keys(persisted.indexed).length, 261);
  assert.equal(
    database.prepare("SELECT units FROM usage_daily WHERE dimension = 'ai_search_queries'").get().units,
    23 + 261 * AI_SEARCH_SYNC_REPLACE_OPERATION_RESERVATION + AI_SEARCH_SYNC_DELETE_OPERATION_RESERVATION,
    "the complete generation retains its conservative namespace, replace, and stale-delete reservations",
  );

  d1.resetCount();
  const restarted = await syncAISearchIfEnabled(env);
  assert.equal(d1.queryCount, 11);
  assert.equal(restarted.status, "partial");
  assert.equal(restarted.cursor, 12);
  assert.notEqual(restarted.generation, first.generation);
  assert.equal(restarted.uploaded, 0);
  assert.equal(restarted.unchanged, 12);
  assert.equal(aiSearch.uploads, 261, "a restarted unchanged page performs no remote uploads");
  assert.equal(
    database.prepare("SELECT units FROM usage_daily WHERE dimension = 'ai_search_queries'").get().units,
    24 + 261 * AI_SEARCH_SYNC_REPLACE_OPERATION_RESERVATION + AI_SEARCH_SYNC_DELETE_OPERATION_RESERVATION,
    "an unchanged page reserves only its namespace lookup",
  );
});

test("poison upload and delete failures advance later pages, terminate partially, and release the next generation", async () => {
  const { database, d1 } = fixture();
  const aiSearch = new RecordingAISearch();
  const poisonUpload = "stories/story-000.md";
  const poisonDelete = "stories/retired.md";
  aiSearch.failUploadKeys.add(poisonUpload);
  aiSearch.failDeleteKeys.add(poisonDelete);
  const env = { DB: d1, AI_SEARCH: aiSearch };
  const perPageCounts = [];

  d1.resetCount();
  const first = await syncAISearchIfEnabled(env);
  perPageCounts.push(d1.queryCount);
  assert.equal(first.cursor, 12, "one failed item must not pin its initial page");
  assert.equal(first.remaining, 250);
  assert.deepEqual(first.failed, [{
    key: poisonUpload,
    error: `Injected upload failure for ${poisonUpload}`,
    attempts: 1,
    terminal: false,
  }]);
  assert.equal(d1.queryCount, 11, "a failing first page keeps the same bounded D1 envelope");

  const legacyState = JSON.parse(
    database.prepare("SELECT value FROM settings WHERE key = 'ai_search_sync_state_v2'").get().value,
  );
  delete legacyState.cycle.stats.failureAttempts;
  database.prepare(
    "UPDATE settings SET value = ? WHERE key = 'ai_search_sync_state_v2'",
  ).run(JSON.stringify(legacyState));

  d1.resetCount();
  const second = await syncAISearchIfEnabled(env);
  perPageCounts.push(d1.queryCount);
  assert.equal(second.generation, first.generation);
  assert.equal(second.cursor, 24, "legacy version-2 failure state remains readable and later pages advance");
  assert.equal(d1.queryCount, 8);
  assert.ok(aiSearch.itemsById.has("item:stories/story-012.md"));

  let result = second;
  for (let invocation = 0; invocation < 40 && !result.complete; invocation += 1) {
    d1.resetCount();
    result = await syncAISearchIfEnabled(env);
    perPageCounts.push(d1.queryCount);
    assert.ok(d1.queryCount < 47, `poison-safe page used ${d1.queryCount} D1 statements`);
  }

  assert.equal(AI_SEARCH_MAX_ATTEMPTS_PER_GENERATION, 2);
  assert.equal(result.complete, true, "terminal poison telemetry closes the generation");
  assert.equal(result.status, "partial");
  assert.equal(result.phase, "complete");
  assert.equal(result.cursor, result.total);
  assert.equal(result.remaining, 0);
  assert.equal(result.uploaded, 260, "every later healthy document is uploaded");
  assert.equal(result.deleted, 0);
  assert.equal(result.processed, 260);
  assert.deepEqual(result.failed, [
    {
      key: poisonDelete,
      error: `delete: Injected delete failure for ${poisonDelete}`,
      attempts: 2,
      terminal: true,
    },
    {
      key: poisonUpload,
      error: `Injected upload failure for ${poisonUpload}`,
      attempts: 2,
      terminal: true,
    },
  ]);
  assert.deepEqual(
    perPageCounts,
    [11, ...Array(14).fill(8), ...Array(6).fill(7), 8, 6, 8, 8],
    "poison pages add only two bounded retry pages; ordinary page counters remain unchanged",
  );
  assert.equal(Math.max(...perPageCounts), 11, "retry pages stay inside the fixed D1 maximum");
  assert.ok(perPageCounts.every((count) => count < 47));
  assert.equal(aiSearch.uploadAttemptsByKey.get(poisonUpload), 3, "legacy state receives a bounded compatibility retry plus the normal retry");
  assert.equal(aiSearch.deleteAttemptsByKey.get(poisonDelete), 2);
  assert.ok(aiSearch.itemsById.has("item:stories/story-179.md"), "a first-page poison item cannot starve the final Story page");
  assert.ok(aiSearch.itemsById.has("item:missions/mission-79.md"), "a Story poison item cannot starve Mission documents");

  const persisted = JSON.parse(
    database.prepare("SELECT value FROM settings WHERE key = 'ai_search_sync_state_v2'").get().value,
  );
  assert.equal(persisted.cycle, undefined);
  const summary = JSON.parse(
    database.prepare("SELECT value FROM settings WHERE key = 'ai_search_last_sync_summary'").get().value,
  );
  assert.deepEqual(summary.failed, result.failed, "terminal failure telemetry survives cycle cleanup");

  d1.resetCount();
  const restarted = await syncAISearchIfEnabled(env);
  assert.notEqual(restarted.generation, first.generation, "terminal poison failures do not pin the next generation");
  assert.equal(restarted.cursor, 12);
  assert.equal(restarted.failed[0].key, poisonUpload);
  assert.equal(restarted.failed[0].attempts, 1);
  assert.equal(restarted.failed[0].terminal, false);
  assert.equal(d1.queryCount, 11);
});
