import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { ingestMessage } = require("../.test-dist/ingest.js");
const { handleIngestQueueBatch } = require("../.test-dist/ingest-consumer.js");

class InjectedCrash extends Error {
  constructor(stage) {
    super(`Injected crash ${stage}`);
    this.name = "InjectedCrash";
  }
}

class SqliteD1Statement {
  constructor(owner, query) {
    this.owner = owner;
    this.database = owner.database;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    this.owner.queryCount += 1;
    this.owner.beforeStatement(this);
    const result = this.database.prepare(this.query).run(...this.values);
    this.owner.afterStatement(this);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }

  async first() {
    this.owner.queryCount += 1;
    this.owner.beforeStatement(this);
    const result = this.database.prepare(this.query).get(...this.values) ?? null;
    this.owner.afterStatement(this);
    return result;
  }

  async all() {
    this.owner.queryCount += 1;
    this.owner.beforeStatement(this);
    const results = this.database.prepare(this.query).all(...this.values);
    this.owner.afterStatement(this);
    return { success: true, results, meta: {} };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
    this.crashStage = null;
    this.inBatch = false;
    this.queryCount = 0;
  }

  prepare(query) {
    return new SqliteD1Statement(this, query);
  }

  injectCrash(stage) {
    this.crashStage = stage;
  }

  crash(stage) {
    if (this.crashStage !== stage) return;
    this.crashStage = null;
    throw new InjectedCrash(stage);
  }

  beforeStatement(statement) {
    if (this.inBatch) return;
    if (
      statement.query.includes("UPDATE item_ingest_completions") &&
      statement.query.includes("SET lease_token = ?")
    ) this.crash("after-item");
  }

  afterStatement(statement) {
    if (this.inBatch) return;
    if (statement.query.includes("INSERT INTO evidence_lineage(")) this.crash("after-lineage");
    if (statement.query.includes("INSERT INTO settings(") && statement.values[0] === "memory_graph_dirty") {
      this.crash("after-memory-dirty");
    }
    if (statement.query.includes("UPDATE item_ingest_completions") && statement.query.includes("SET stage = 4")) {
      this.crash("after-complete");
    }
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    this.inBatch = true;
    const results = [];
    try {
      for (const statement of statements) {
        this.queryCount += 1;
        const result = this.database.prepare(statement.query).run(...statement.values);
        results.push({ success: true, results: [], meta: { changes: Number(result.changes || 0) } });
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.inBatch = false;
    }
    if (statements.some((statement) => statement.query.includes("SET stage = MAX(stage, 1)"))) {
      this.crash("after-story");
    }
    if (statements.some((statement) => statement.query.includes("INSERT INTO mission_story_matches("))) {
      this.crash("after-missions");
    }
    return results;
  }
}

async function fixture() {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const database = new DatabaseSync(":memory:");
  for (const name of names) database.exec(await readFile(new URL(name, directory), "utf8"));
  database.prepare(
    `INSERT INTO sources(
       id, name, kind, config_json, enabled, schedule_minutes, weight,
       health_score, created_at, updated_at
     ) VALUES ('atomic-source', 'Atomic source', 'manual', '{}', 1, 60, 1, 0.9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run();
  database.prepare(
    `INSERT INTO missions(
       id, name, question, terms_json, source_scope_json, status, priority,
       cadence_minutes, created_at, updated_at
     ) VALUES (
       'atomic-mission', 'Cloudflare durability', 'Will Cloudflare ingestion recover?',
       '["cloudflare"]', '[]', 'active', 1, 360, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )`,
  ).run();
  database.prepare(
    `INSERT INTO settings(key, value, updated_at) VALUES ('memory_graph_dirty', '0', CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run();
  const deletedRawKeys = [];
  const env = {
    DB: new SqliteD1(database),
    INGEST_QUEUE_NAME: "atomic-ingest",
    INGEST_DLQ_NAME: "atomic-ingest-dlq",
    EVIDENCE: {
      async delete(key) { deletedRawKeys.push(key); },
      async put() {},
    },
  };
  return { database, env, deletedRawKeys };
}

function message(runId = "atomic-run-1", rawR2Key) {
  return {
    sourceId: "atomic-source",
    sourceRunId: runId,
    sourceRunItemIndex: 0,
    provider: "atomic-fixture",
    rawR2Key,
    item: {
      externalId: "atomic-item-1",
      url: "https://example.test/cloudflare-atomic-ingest",
      title: "Cloudflare atomic ingest recovery",
      text: "Cloudflare Queue delivery must complete Story lineage Mission and memory state.",
      observedAt: "2026-08-07T12:00:00.000Z",
      accessClass: "public",
      metadata: { watchTerms: ["cloudflare"], importance: 0.8 },
    },
  };
}

function stageTrackedOutboxRun(database, runId, body) {
  const bodyJson = JSON.stringify(body);
  const bodyBytes = Buffer.byteLength(bodyJson);
  database.prepare(
    `INSERT INTO source_runs(
       id, source_id, started_at, collection_finished_at, status, item_count,
       enqueued_count, collection_health_delta, provider, details_json
     ) VALUES (?, 'atomic-source', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
               'queued', 1, 1, 0.08, 'atomic-fixture', '{}')`,
  ).run(runId);
  database.prepare(
    `INSERT INTO source_ingest_outbox_runs(
       run_id, source_id, state, message_count, total_bytes, payload_sha256,
       next_index, collection_health_delta, provider, activated_at
     ) VALUES (?, 'atomic-source', 'ready', 1, ?, ?, 1, 0.08,
               'atomic-fixture', CURRENT_TIMESTAMP)`,
  ).run(runId, bodyBytes, "0".repeat(64));
  database.prepare(
    `INSERT INTO source_ingest_outbox_messages(
       run_id, item_index, message_json, message_bytes, body_sha256
     ) VALUES (?, 0, ?, ?, ?)`,
  ).run(runId, bodyJson, bodyBytes, "0".repeat(64));
}

function queueMessage(body, counters) {
  return {
    id: `queue-${body.sourceRunId}`,
    timestamp: new Date(),
    attempts: 1,
    body,
    ack() { counters.acked += 1; },
    retry() { counters.retried += 1; },
  };
}

function state(database) {
  const scalar = (query) => Number(database.prepare(query).get().count);
  return {
    items: scalar("SELECT COUNT(*) AS count FROM items"),
    stories: scalar("SELECT COUNT(*) AS count FROM stories"),
    storyItems: scalar("SELECT COUNT(*) AS count FROM story_items"),
    lineage: scalar("SELECT COUNT(*) AS count FROM evidence_lineage"),
    missionMatches: scalar("SELECT COUNT(*) AS count FROM mission_story_matches"),
    completion: database.prepare("SELECT * FROM item_ingest_completions").get(),
    sourceCount: database.prepare("SELECT source_count FROM stories LIMIT 1").get()?.source_count,
    memoryDirty: database.prepare("SELECT value FROM settings WHERE key = 'memory_graph_dirty'").get()?.value,
  };
}

const crashCases = [
  ["after-item", 0],
  ["after-story", 1],
  ["after-lineage", 1],
  ["after-missions", 2],
  ["after-memory-dirty", 3],
  ["after-complete", 4],
];

for (const [crashStage, expectedStage] of crashCases) {
  test(`retry reaches complete ingest state after ${crashStage}`, async () => {
    const { database, env } = await fixture();
    env.DB.injectCrash(crashStage);
    await assert.rejects(ingestMessage(env, message()), InjectedCrash);

    const interrupted = state(database);
    assert.equal(interrupted.items, 1, "the canonical item remains singular");
    assert.equal(interrupted.completion.stage, expectedStage);
    assert.equal(interrupted.completion.completed_at !== null, expectedStage === 4);

    const resumed = await ingestMessage(env, message());
    assert.equal(resumed.inserted, true, "the original tracked delivery retains its inserted outcome");
    assert.ok(resumed.storyId);

    const complete = state(database);
    assert.deepEqual(
      {
        items: complete.items,
        stories: complete.stories,
        storyItems: complete.storyItems,
        lineage: complete.lineage,
        missionMatches: complete.missionMatches,
        sourceCount: complete.sourceCount,
        memoryDirty: complete.memoryDirty,
        stage: complete.completion.stage,
      },
      {
        items: 1,
        stories: 1,
        storyItems: 1,
        lineage: 1,
        missionMatches: 1,
        sourceCount: 1,
        memoryDirty: "1",
        stage: 4,
      },
    );
    assert.ok(complete.completion.completed_at);

    const replay = await ingestMessage(env, message());
    assert.equal(replay.inserted, true, "an ack/receipt retry from the origin remains idempotently inserted");
    const distinctDuplicate = await ingestMessage(env, message("atomic-run-2"));
    assert.equal(distinctDuplicate.inserted, false, "a distinct delivery preserves canonical duplicate semantics");
    const afterDuplicates = state(database);
    assert.equal(afterDuplicates.items, 1);
    assert.equal(afterDuplicates.stories, 1);
    assert.equal(afterDuplicates.storyItems, 1);
    assert.equal(afterDuplicates.lineage, 1);
    assert.equal(afterDuplicates.missionMatches, 1);
    assert.equal(afterDuplicates.sourceCount, 1);
  });
}

test("ingest stores strict timezone-bearing timestamps as ISO and rejects ambiguous publication dates", async () => {
  const { database, env } = await fixture();
  const body = message("timestamp-normalization");
  body.item.observedAt = "  2026-08-09T16:00:00-04:00  ";
  body.item.publishedAt = "  Wed, 29 Jul 2026 01:53:39 GMT  ";

  await ingestMessage(env, body);

  const stored = database.prepare("SELECT observed_at, published_at FROM items").get();
  assert.deepEqual(
    { ...stored },
    {
      observed_at: "2026-08-09T20:00:00.000Z",
      published_at: "2026-07-29T01:53:39.000Z",
    },
  );

  const rejectedPublishedDates = [
    "2026-08-07",
    "2026-08-07T01:41:49",
    "2026-02-30T01:41:49Z",
    "2461000",
    "2026-08-07T01:41:49.0009Z",
    "2026-08-07T03:41:49.1236+02:00",
    "9999-12-31T23:59:59-14:00",
    "\t2026-08-07T01:41:49Z\n",
  ];
  for (const [index, publishedAt] of rejectedPublishedDates.entries()) {
    const rejected = message(`timestamp-rejected-${index}`);
    rejected.item.externalId = `timestamp-rejected-${index}`;
    rejected.item.url = `https://example.test/timestamp-rejected-${index}`;
    rejected.item.title = `Rejected timestamp ${index}`;
    rejected.item.text = `Distinct rejected timestamp evidence ${index}.`;
    rejected.item.publishedAt = publishedAt;
    await ingestMessage(env, rejected);
  }
  assert.deepEqual(
    database.prepare(
      "SELECT published_at FROM items WHERE external_id LIKE 'timestamp-rejected-%' ORDER BY external_id",
    ).all().map((row) => row.published_at),
    [null, null, null, null, null, null, null, null],
  );

  const invalidObserved = message("timestamp-invalid-observed");
  invalidObserved.item.externalId = "timestamp-invalid-observed";
  invalidObserved.item.url = "https://example.test/timestamp-invalid-observed";
  invalidObserved.item.title = "Invalid observed timestamp";
  invalidObserved.item.text = "Distinct evidence with an invalid claimed observation time.";
  invalidObserved.item.observedAt = "2026-08-07T01:41:49";
  const beforeFallback = Date.now();
  await ingestMessage(env, invalidObserved);
  const afterFallback = Date.now();
  const storedFallback = database.prepare(
    "SELECT observed_at FROM items WHERE external_id = 'timestamp-invalid-observed'",
  ).get().observed_at;
  assert.match(storedFallback, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(storedFallback) >= beforeFallback && Date.parse(storedFallback) <= afterFallback);
});

test("terminal inserted and duplicate Queue receipts retire their exact producer body sets", async () => {
  const { database, env } = await fixture();
  const cases = [
    { runId: "terminal-inserted-run", expectedOutcome: "inserted" },
    { runId: "terminal-duplicate-run", expectedOutcome: "duplicate" },
  ];
  const statementCounts = [];
  for (const entry of cases) {
    const body = message(entry.runId);
    stageTrackedOutboxRun(database, entry.runId, body);
    const counters = { acked: 0, retried: 0 };
    env.DB.queryCount = 0;
    await handleIngestQueueBatch({
      queue: env.INGEST_QUEUE_NAME,
      messages: [queueMessage(body, counters)],
      ackAll() {},
      retryAll() {},
    }, env);
    statementCounts.push(env.DB.queryCount);

    assert.deepEqual(counters, { acked: 1, retried: 0 });
    const run = database.prepare(
      "SELECT status, terminal_accounted_at FROM source_runs WHERE id = ?",
    ).get(entry.runId);
    assert.equal(run.status, "success");
    assert.ok(run.terminal_accounted_at);
    assert.equal(
      database.prepare("SELECT outcome FROM source_run_ingest_receipts WHERE run_id = ?").get(entry.runId).outcome,
      entry.expectedOutcome,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_runs WHERE run_id = ?").get(entry.runId).count,
      0,
      "the terminal receipt removes only its own retained body set before ack",
    );
  }
  assert.deepEqual(
    statementCounts,
    [35, 10],
    "inserted and duplicate terminal deliveries remain inside the 50-statement Queue envelope",
  );
});

test("the Queue records a terminal receipt only after resumed ingest is complete", async () => {
  const { database, env } = await fixture();
  database.prepare(
    `INSERT INTO source_runs(
       id, source_id, started_at, collection_finished_at, status, item_count,
       enqueued_count, collection_health_delta, provider, details_json
     ) VALUES (
       'queue-atomic-run', 'atomic-source', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
       'queued', 1, 1, 0.08, 'atomic-fixture', '{}'
     )`,
  ).run();
  let acked = 0;
  let retried = 0;
  const queueMessage = (attempts) => ({
    id: "atomic-queue-message",
    timestamp: new Date(),
    attempts,
    body: message("queue-atomic-run"),
    ack() { acked += 1; },
    retry() { retried += 1; },
  });

  env.DB.injectCrash("after-story");
  await handleIngestQueueBatch({
    queue: env.INGEST_QUEUE_NAME,
    messages: [queueMessage(1)],
    ackAll() {},
    retryAll() {},
  }, env);
  assert.equal(acked, 0);
  assert.equal(retried, 1);
  let run = database.prepare(
    "SELECT status, ingest_failed_attempts FROM source_runs WHERE id = 'queue-atomic-run'",
  ).get();
  assert.equal(run.status, "queued");
  assert.equal(run.ingest_failed_attempts, 0, "Cloudflare attempts=1 is the first delivery, with zero retries");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM source_run_ingest_receipts").get().count, 0);
  assert.equal(database.prepare("SELECT stage FROM item_ingest_completions").get().stage, 1);

  await handleIngestQueueBatch({
    queue: env.INGEST_QUEUE_NAME,
    messages: [queueMessage(2)],
    ackAll() {},
    retryAll() {},
  }, env);
  assert.equal(acked, 1);
  assert.equal(retried, 1);
  run = database.prepare(
    "SELECT status, ingest_failed_attempts FROM source_runs WHERE id = 'queue-atomic-run'",
  ).get();
  assert.equal(run.status, "success");
  assert.equal(run.ingest_failed_attempts, 1, "Cloudflare attempts=2 represents one retry");
  assert.equal(database.prepare("SELECT outcome FROM source_run_ingest_receipts").get().outcome, "inserted");
  assert.equal(database.prepare("SELECT stage FROM item_ingest_completions").get().stage, 4);
  assert.ok(database.prepare("SELECT completed_at FROM item_ingest_completions").get().completed_at);
});

test("a duplicate delivery cleans only its redundant managed raw object", async () => {
  const { env, deletedRawKeys } = await fixture();
  const firstRaw = "raw/2026-08-07/atomic-source/11111111-1111-4111-8111-111111111111.txt";
  const duplicateRaw = "raw/2026-08-07/atomic-source/22222222-2222-4222-8222-222222222222.txt";
  const inserted = await ingestMessage(env, message("raw-run-1", firstRaw));
  assert.equal(inserted.inserted, true);
  assert.deepEqual(deletedRawKeys, []);

  const duplicate = await ingestMessage(env, message("raw-run-2", duplicateRaw));
  assert.equal(duplicate.inserted, false);
  assert.deepEqual(deletedRawKeys, [duplicateRaw]);
});

test("a legacy linked item is enrolled after the Story stage without rescoring it", async () => {
  const { database, env } = await fixture();
  await ingestMessage(env, message("legacy-origin"));
  const before = database.prepare("SELECT id, score, novelty, updated_at FROM stories LIMIT 1").get();
  database.prepare("DELETE FROM item_ingest_completions").run();
  database.prepare("UPDATE settings SET value = '0' WHERE key = 'memory_graph_dirty'").run();

  const duplicate = await ingestMessage(env, message("legacy-later-duplicate"));
  assert.equal(duplicate.inserted, false);
  const after = database.prepare("SELECT id, score, novelty, updated_at FROM stories LIMIT 1").get();
  assert.deepEqual(after, before, "legacy reconciliation must not count the linked item as new Story coverage");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM story_items").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM evidence_lineage").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM mission_story_matches").get().count, 1);
  assert.equal(database.prepare("SELECT stage FROM item_ingest_completions").get().stage, 4);
  assert.equal(database.prepare("SELECT value FROM settings WHERE key = 'memory_graph_dirty'").get().value, "1");
});
