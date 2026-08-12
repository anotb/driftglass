import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const {
  drainTrackedSourceOutbox,
  enqueueTrackedSourceRun,
  fitTrackedSourceOutboxPrefix,
  maintainTrackedSourceOutbox,
  trackedSourceOutboxHealth,
  SOURCE_OUTBOX_LEASE_MS,
  SOURCE_OUTBOX_MAX_ACTIVE_BYTES,
  SOURCE_OUTBOX_MAX_RAW_MESSAGES,
  SOURCE_OUTBOX_MAX_RUN_BYTES,
  SOURCE_OUTBOX_MAX_STAGE_CHUNKS,
  SourceOutboxActivationUnknownError,
} = require("../.test-dist/source-ingest-outbox.js");
const { serializedIngestBatchBytes } = require("../.test-dist/ingest-queue.js");
const { beginSourceRun, finishSourceRun, recordSourceRunIngestOutcome } = require("../.test-dist/db.js");
const { sha256 } = require("../.test-dist/security.js");
const { canSpend, requireBudget } = require("../.test-dist/budget.js");
const { requireIngestQueueDurability } = require("../.test-dist/queue-health.js");
const { observeSourceCadence } = require("../.test-dist/adaptive-cadence.js");

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
    this.owner.queryCount += 1;
    this.owner.beforeStatement?.(this);
    if (this.owner.failCheckpointOnce && this.query.includes("SET next_index = MAX")) {
      this.owner.failCheckpointOnce = false;
      throw new Error("simulated checkpoint response loss");
    }
    const result = this.owner.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }

  async first() {
    this.owner.queryCount += 1;
    this.owner.beforeStatement?.(this);
    return this.owner.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    this.owner.queryCount += 1;
    this.owner.beforeStatement?.(this);
    return { success: true, results: this.owner.database.prepare(this.query).all(...this.values), meta: {} };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
    this.queryCount = 0;
    this.failActivationOnce = false;
    this.failCheckpointOnce = false;
    this.beforeStatement = null;
  }

  prepare(query) {
    return new SqliteD1Statement(this, query);
  }

  async batch(statements) {
    if (this.failActivationOnce && statements.some((statement) => statement.query.includes("SET state = 'ready'"))) {
      this.failActivationOnce = false;
      throw new Error("simulated activation response loss");
    }
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function fixture() {
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const database = new DatabaseSync(":memory:");
  for (const name of names) database.exec(await readFile(new URL(name, migrationDirectory), "utf8"));
  database.prepare(
    `INSERT INTO sources(id, name, kind, config_json, enabled, schedule_minutes, weight)
     VALUES ('outbox-source', 'Outbox source', 'npm_releases', '{}', 1, 60, 1)`,
  ).run();
  const d1 = new SqliteD1(database);
  const sentBatches = [];
  const puts = [];
  const deletes = [];
  const queue = {
    throwAfterAccept: false,
    checkpointCrashAfterAccept: false,
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 };
    },
    async sendBatch(requests) {
      const batch = [...requests];
      sentBatches.push(batch);
      if (this.checkpointCrashAfterAccept) {
        this.checkpointCrashAfterAccept = false;
        d1.failCheckpointOnce = true;
      }
      if (this.throwAfterAccept) throw new Error("simulated ambiguous Queue write");
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  };
  const quietQueue = {
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 };
    },
  };
  const evidence = {
    failPutAt: 0,
    async list() {
      return { objects: [], truncated: false };
    },
    async put(key, value) {
      puts.push({ key, value });
      if (this.failPutAt > 0 && puts.length === this.failPutAt) throw new Error("partial raw R2 failure");
      return { key };
    },
    async delete(keys) {
      deletes.push(...(Array.isArray(keys) ? keys : [keys]));
    },
  };
  return {
    database,
    d1,
    queue,
    sentBatches,
    puts,
    deletes,
    evidence,
    env: {
      DB: d1,
      EVIDENCE: evidence,
      INGEST_QUEUE: queue,
      INGEST_DLQ: quietQueue,
      INGEST_QUARANTINE: quietQueue,
    },
  };
}

function loadSourceRegistry() {
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function driftglassTestLoad(request, parent, isMain) {
    if (request === "cloudflare:workers") {
      return {
        tracing: {
          enterSpan(_name, callback) {
            return callback({ setAttribute() {} });
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../.test-dist/sources/registry.js");
  } finally {
    Module._load = originalLoad;
  }
}

function loadRunSource() {
  return loadSourceRegistry().runSource;
}

async function trackedInputs(d1, count, {
  textBytes = 20,
  rawIndex = -1,
  runId: existingRunId,
  sourceId = "outbox-source",
} = {}) {
  const runId = existingRunId ?? await beginSourceRun(d1, sourceId, "npm-registry");
  return {
    runId,
    activation: {
      runId,
      sourceId,
      collectionPartial: false,
      collectionHealthDelta: 0.08,
      latencyMs: 12,
      provider: "npm-registry",
      details: { fixture: true, count },
    },
    inputs: Array.from({ length: count }, (_, index) => ({
      sourceId,
      provider: "npm-registry",
      sourceRunId: runId,
      sourceRunItemIndex: index,
      item: {
        externalId: `package-${index}`,
        title: `Package ${index}`,
        text: "x".repeat(textBytes),
        raw: index === rawIndex ? `raw-${index}` : undefined,
        observedAt: "2026-08-07T12:00:00.000Z",
        metadata: { index },
      },
    })),
  };
}

function futureDate(offset = SOURCE_OUTBOX_LEASE_MS + 1_000) {
  return new Date(Date.now() + offset);
}

test("multi-batch tracked runs retain their immutable body set across bounded drains", async () => {
  const state = await fixture();
  const tracked = await trackedInputs(state.d1, 110, { textBytes: 5_000 });
  const staged = await enqueueTrackedSourceRun(state.env, tracked.inputs, tracked.activation);

  assert.equal(staged.messageCount, 110);
  assert.equal(staged.drain.batchCount, 1);
  assert.equal(staged.drain.completed, false);
  assert.ok(state.sentBatches[0].length < 100, "the aggregate byte ceiling, not only count, split the first batch");
  assert.ok(serializedIngestBatchBytes(state.sentBatches[0].map((request) => request.body)) <= 230_000);
  const afterFirst = state.database.prepare(
    "SELECT message_count, next_index, payload_sha256 FROM source_ingest_outbox_runs WHERE run_id = ?",
  ).get(tracked.runId);
  assert.ok(afterFirst.next_index > 0 && afterFirst.next_index < 110);
  assert.match(afterFirst.payload_sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_messages WHERE run_id = ?").get(tracked.runId).count,
    110,
    "checkpointing retains every immutable row until the terminal cascade",
  );

  const finished = await drainTrackedSourceOutbox(state.env, { maxBatches: 6, now: futureDate() });
  assert.equal(finished.completed, true);
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_runs WHERE run_id = ?").get(tracked.runId).count, 1);
  assert.equal(
    state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_messages WHERE run_id = ?").get(tracked.runId).count,
    110,
    "confirmed Queue handoff retains exact bodies until terminal receipt accounting",
  );
  assert.equal(state.sentBatches.flat().length, 110);
  assert.ok(state.sentBatches.every((batch) => batch.length <= 100));
  assert.ok(state.sentBatches.every((batch) => serializedIngestBatchBytes(batch.map((request) => request.body)) <= 230_000));
  const run = state.database.prepare("SELECT status, enqueued_count, finished_at FROM source_runs WHERE id = ?").get(tracked.runId);
  assert.equal(run.status, "queued");
  assert.equal(run.enqueued_count, 110);
  assert.equal(run.finished_at, null);
});

test("an ambiguous Queue response retains exact bodies and replays the same run indices", async () => {
  const state = await fixture();
  state.queue.throwAfterAccept = true;
  const tracked = await trackedInputs(state.d1, 3);
  const staged = await enqueueTrackedSourceRun(state.env, tracked.inputs, tracked.activation);
  assert.equal(staged.drain.ambiguous, true);
  assert.equal(state.database.prepare("SELECT next_index FROM source_ingest_outbox_runs WHERE run_id = ?").get(tracked.runId).next_index, 0);
  const acceptedBodies = state.sentBatches[0].map((request) => request.body);

  state.queue.throwAfterAccept = false;
  const replayed = await drainTrackedSourceOutbox(state.env, { maxBatches: 1, now: futureDate() });
  assert.equal(replayed.completed, true);
  assert.deepEqual(state.sentBatches[1].map((request) => request.body), acceptedBodies);
  assert.deepEqual(acceptedBodies.map((body) => body.sourceRunItemIndex), [0, 1, 2]);
});

test("producer-entry recovery cannot substitute an older run from a different source", async () => {
  const state = await fixture();
  state.database.prepare(
    `INSERT INTO sources(id, name, kind, config_json, enabled, schedule_minutes, weight)
     VALUES ('other-source', 'Other source', 'npm_releases', '{}', 1, 60, 1)`,
  ).run();
  state.queue.throwAfterAccept = true;
  const older = await trackedInputs(state.d1, 1);
  const newer = await trackedInputs(state.d1, 1, { sourceId: "other-source" });
  await enqueueTrackedSourceRun(state.env, older.inputs, older.activation);
  await enqueueTrackedSourceRun(state.env, newer.inputs, newer.activation);

  state.queue.throwAfterAccept = false;
  const selected = await drainTrackedSourceOutbox(state.env, {
    maxBatches: 1,
    sourceId: "other-source",
    now: futureDate(),
  });
  assert.equal(selected.runId, newer.runId);
  assert.notEqual(selected.runId, older.runId);
  assert.equal(state.sentBatches.at(-1)[0].body.sourceId, "other-source");

  const registry = await readFile(new URL("../src/sources/registry.ts", import.meta.url), "utf8");
  assert.match(registry, /drainTrackedSourceOutbox\(env,[\s\S]{0,220}sourceId: source\.id/);
});

test("source-scoped producer recovery does not activate an older complete staging run from another source", async () => {
  const state = await fixture();
  state.database.prepare(
    `INSERT INTO sources(id, name, kind, config_json, enabled, schedule_minutes, weight)
     VALUES ('other-source', 'Other source', 'npm_releases', '{}', 1, 60, 1)`,
  ).run();

  const older = await trackedInputs(state.d1, 1);
  state.d1.failActivationOnce = true;
  await assert.rejects(
    enqueueTrackedSourceRun(state.env, older.inputs, older.activation),
    (error) => error instanceof SourceOutboxActivationUnknownError,
  );
  state.database.prepare(
    "UPDATE source_ingest_outbox_runs SET created_at = '2026-08-07T00:00:00.000Z', updated_at = '2026-08-07T00:00:00.000Z' WHERE run_id = ?",
  ).run(older.runId);

  const requested = await trackedInputs(state.d1, 1, { sourceId: "other-source" });
  state.d1.failActivationOnce = true;
  await assert.rejects(
    enqueueTrackedSourceRun(state.env, requested.inputs, requested.activation),
    (error) => error instanceof SourceOutboxActivationUnknownError,
  );

  const resumed = await drainTrackedSourceOutbox(state.env, {
    maxBatches: 1,
    sourceId: "other-source",
    skipMaintenance: true,
    resumeStaging: true,
    now: futureDate(),
  });
  assert.equal(resumed.runId, requested.runId);
  assert.equal(state.sentBatches.at(-1)[0].body.sourceId, "other-source");
  assert.equal(state.database.prepare("SELECT state FROM source_ingest_outbox_runs WHERE run_id = ?").get(older.runId).state, "staging");
  assert.equal(state.database.prepare("SELECT state FROM source_ingest_outbox_runs WHERE run_id = ?").get(requested.runId).state, "ready");
});

test("a crash after Queue acceptance but before checkpoint safely replays", async () => {
  const state = await fixture();
  state.queue.checkpointCrashAfterAccept = true;
  const tracked = await trackedInputs(state.d1, 4);
  const staged = await enqueueTrackedSourceRun(state.env, tracked.inputs, tracked.activation);
  assert.equal(staged.drain.ambiguous, true);
  assert.equal(state.database.prepare("SELECT next_index FROM source_ingest_outbox_runs WHERE run_id = ?").get(tracked.runId).next_index, 0);
  const first = state.sentBatches[0].map((request) => request.body);

  const replayed = await drainTrackedSourceOutbox(state.env, { maxBatches: 1, now: futureDate() });
  assert.equal(replayed.completed, true);
  assert.deepEqual(state.sentBatches[1].map((request) => request.body), first);
});

test("terminal receipts prove an uncheckpointed accepted prefix without another Queue send", async () => {
  const state = await fixture();
  state.queue.throwAfterAccept = true;
  const tracked = await trackedInputs(state.d1, 2);
  await enqueueTrackedSourceRun(state.env, tracked.inputs, tracked.activation);
  for (let index = 0; index < 2; index += 1) {
    state.database.prepare(
      `INSERT INTO source_run_ingest_receipts(run_id, item_index, outcome, item_id)
       VALUES (?, ?, 'inserted', ?)`,
    ).run(tracked.runId, index, `item-${index}`);
  }
  state.queue.throwAfterAccept = false;
  const sentBefore = state.sentBatches.length;
  const reconciled = await drainTrackedSourceOutbox(state.env, { maxBatches: 1, now: futureDate() });
  assert.equal(reconciled.completed, true);
  assert.equal(reconciled.receiptCount, 2);
  assert.equal(reconciled.sentCount, 0);
  assert.equal(state.sentBatches.length, sentBefore);
});

test("confirmed Queue bodies are retained through terminal accounting and removed only by bounded maintenance", async () => {
  const state = await fixture();
  const tracked = await trackedInputs(state.d1, 3);
  const queued = await enqueueTrackedSourceRun(state.env, tracked.inputs, tracked.activation);
  assert.equal(queued.drain.completed, true);

  const retained = state.database.prepare(
    "SELECT item_index, message_json FROM source_ingest_outbox_messages WHERE run_id = ? ORDER BY item_index",
  ).all(tracked.runId);
  assert.deepEqual(
    retained.map((row) => JSON.parse(row.message_json)),
    state.sentBatches[0].map((request) => request.body),
  );
  assert.deepEqual(await trackedSourceOutboxHealth(state.d1), {
    activeRuns: 0,
    stagingRuns: 0,
    readyRuns: 0,
    awaitingReceiptRuns: 1,
    awaitingReceiptMessages: 3,
    retainedRuns: 1,
    retainedMessages: 3,
    retainedBytes: queued.totalBytes,
    terminalGcRuns: 0,
    abandonedRuns: 0,
    messageCount: 0,
    activeBytes: queued.totalBytes,
    oldestActiveAt: null,
  });

  for (let index = 0; index < tracked.inputs.length; index += 1) {
    const receipt = await recordSourceRunIngestOutcome(state.d1, {
      runId: tracked.runId,
      sourceId: "outbox-source",
      itemIndex: index,
      outcome: "inserted",
      itemId: `terminal-item-${index}`,
    });
    assert.equal(receipt.receiptRecorded, true);
    if (index === 0) {
      const partiallyReceipted = await trackedSourceOutboxHealth(state.d1);
      assert.equal(partiallyReceipted.awaitingReceiptRuns, 1);
      assert.equal(partiallyReceipted.awaitingReceiptMessages, 2);
      assert.equal(partiallyReceipted.activeRuns, 0);
    }
  }
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_messages WHERE run_id = ?").get(tracked.runId).count, 3);
  const second = await trackedInputs(state.d1, 1);
  await enqueueTrackedSourceRun(state.env, second.inputs, second.activation);
  await recordSourceRunIngestOutcome(state.d1, {
    runId: second.runId,
    sourceId: "outbox-source",
    itemIndex: 0,
    outcome: "inserted",
    itemId: "second-terminal-item",
  });
  const beforeGc = await trackedSourceOutboxHealth(state.d1);
  assert.equal(beforeGc.awaitingReceiptRuns, 0);
  assert.equal(beforeGc.terminalGcRuns, 2);
  assert.equal(beforeGc.retainedRuns, 2);

  await maintainTrackedSourceOutbox(state.env, futureDate());
  assert.equal(
    state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_runs WHERE run_id IN (?, ?)").get(tracked.runId, second.runId).count,
    1,
    "one maintenance pass deletes at most one terminal run",
  );
  await maintainTrackedSourceOutbox(state.env, futureDate());
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_runs WHERE run_id IN (?, ?)").get(tracked.runId, second.runId).count, 0);
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_messages WHERE run_id IN (?, ?)").get(tracked.runId, second.runId).count, 0);
});

test("activation is atomic and an unknown response never sends or falsely terminalizes the source run", async () => {
  const state = await fixture();
  state.d1.failActivationOnce = true;
  const tracked = await trackedInputs(state.d1, 2);
  await assert.rejects(
    enqueueTrackedSourceRun(state.env, tracked.inputs, tracked.activation),
    (error) => error instanceof SourceOutboxActivationUnknownError,
  );
  assert.equal(state.sentBatches.length, 0);
  assert.equal(state.database.prepare("SELECT state FROM source_ingest_outbox_runs WHERE run_id = ?").get(tracked.runId).state, "staging");
  assert.equal(state.database.prepare("SELECT status FROM source_runs WHERE id = ?").get(tracked.runId).status, "running");

  const resumed = await drainTrackedSourceOutbox(state.env, {
    maxBatches: 1,
    now: futureDate(),
    skipMaintenance: true,
    resumeStaging: true,
  });
  assert.equal(resumed.completed, true);
  assert.equal(state.sentBatches.flat().length, 2);
  assert.equal(state.database.prepare("SELECT status FROM source_runs WHERE id = ?").get(tracked.runId).status, "queued");
});

async function insertStaleComplete(state, { validDigest, activatable, rawKey }) {
  const tracked = await trackedInputs(state.d1, 1);
  const body = {
    sourceId: "outbox-source",
    provider: "fixture",
    sourceRunId: tracked.runId,
    sourceRunItemIndex: 0,
    rawR2Key: rawKey,
    item: { title: "stale body", text: "body", accessClass: "public" },
  };
  const messageJson = JSON.stringify(body);
  const messageBytes = Buffer.byteLength(messageJson);
  const bodyHash = await sha256(messageJson);
  const payloadHash = validDigest ? await sha256(`0:${messageBytes}:${bodyHash}`) : "0".repeat(64);
  const old = "2026-08-07T00:00:00.000Z";
  state.database.prepare(
    `INSERT INTO source_ingest_outbox_runs(
       run_id, source_id, state, message_count, total_bytes, payload_sha256,
       collection_partial, collection_health_delta, latency_ms, provider,
       details_json, created_at, updated_at
     ) VALUES (?, 'outbox-source', 'staging', 1, ?, ?, 0, 0.08, 1, 'fixture', '{}', ?, ?)`,
  ).run(tracked.runId, messageBytes, payloadHash, old, old);
  state.database.prepare(
    `INSERT INTO source_ingest_outbox_messages(
       run_id, item_index, message_json, message_bytes, body_sha256, raw_r2_key, created_at
     ) VALUES (?, 0, ?, ?, ?, ?, ?)`,
  ).run(tracked.runId, messageJson, messageBytes, bodyHash, rawKey, old);
  if (!activatable) {
    state.database.prepare(
      "UPDATE source_runs SET status = 'failed', finished_at = ?, terminal_accounted_at = ? WHERE id = ?",
    ).run(old, old, tracked.runId);
  }
  return tracked.runId;
}

test("stale complete-but-corrupt and non-activatable staging is abandoned with raw cleanup", async () => {
  const state = await fixture();
  const corruptKey = "raw/2026-08-07/outbox-source/123e4567-e89b-12d3-a456-426614174000.txt";
  const terminalKey = "raw/2026-08-07/outbox-source/223e4567-e89b-12d3-a456-426614174000.txt";
  const corruptRun = await insertStaleComplete(state, { validDigest: false, activatable: true, rawKey: corruptKey });
  const terminalRun = await insertStaleComplete(state, { validDigest: true, activatable: false, rawKey: terminalKey });

  await maintainTrackedSourceOutbox(state.env, new Date("2026-08-07T01:00:00.000Z"));
  await maintainTrackedSourceOutbox(state.env, new Date("2026-08-07T01:01:00.000Z"));
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_runs WHERE run_id IN (?, ?)").get(corruptRun, terminalRun).count, 0);
  assert.deepEqual(state.deletes.sort(), [corruptKey, terminalKey].sort());
  assert.equal(state.database.prepare("SELECT status FROM source_runs WHERE id = ?").get(corruptRun).status, "failed");
  assert.equal(state.database.prepare("SELECT status FROM source_runs WHERE id = ?").get(terminalRun).status, "failed");
});

test("accepted raw keys are never removed by staging cleanup", async () => {
  const state = await fixture();
  const tracked = await trackedInputs(state.d1, 1, { rawIndex: 0 });
  const result = await enqueueTrackedSourceRun(state.env, tracked.inputs, tracked.activation);
  assert.equal(result.drain.completed, true);
  assert.equal(state.puts.length, 1);
  assert.equal(state.deletes.length, 0);
});

test("Page Feed-shaped raw captures use aggregate reservations and remain under the D1 query ceiling", async () => {
  const state = await fixture();
  state.d1.queryCount = 0;
  assert.equal((await drainTrackedSourceOutbox(state.env, { maxBatches: 1, skipMaintenance: true })).claimed, false);
  const runId = await beginSourceRun(state.d1, "outbox-source", "direct-page-feed");
  await requireBudget(state.d1, "source_runs", 1, { sourceId: "outbox-source", kind: "web_feed" });
  await requireIngestQueueDurability(state.env);
  assert.equal((await canSpend(state.d1, "queue_messages", 20)).allowed, true);
  const tracked = await trackedInputs(state.d1, 20, { runId });
  tracked.activation.provider = "direct-page-feed";
  for (let index = 0; index < tracked.inputs.length; index += 1) {
    tracked.inputs[index].item.raw = `article-${index}-`.repeat(200);
  }
  const result = await enqueueTrackedSourceRun(state.env, tracked.inputs, tracked.activation);
  await observeSourceCadence(state.d1, {
    id: "outbox-source", name: "Outbox source", kind: "web_feed", config_json: "{}",
    enabled: true, schedule_minutes: 60, weight: 1, last_run_at: null, last_success_at: null,
    last_error: null, health_score: 1, created_at: "2026-08-07T00:00:00.000Z", updated_at: "2026-08-07T00:00:00.000Z",
  }, { status: "queued", itemCount: 20, latencyMs: 12, meaningfulCount: 20 });
  assert.equal(result.messageCount, 20);
  assert.equal(state.puts.length, 20);
  assert.equal(state.deletes.length, 0);
  const usage = Object.fromEntries(
    state.database.prepare("SELECT dimension, units FROM usage_daily WHERE dimension LIKE 'r2_%' ORDER BY dimension").all()
      .map((row) => [row.dimension, Number(row.units)]),
  );
  assert.equal(usage.r2_class_a_ops, 23, "20 raw puts plus three lifecycle durability-list preflights are visible");
  assert.equal(
    usage.r2_write_bytes,
    tracked.inputs.reduce((sum, input) => sum + Buffer.byteLength(input.item.raw), 0),
  );
  assert.ok(state.d1.queryCount < 50, `full Page Feed-shaped lifecycle used ${state.d1.queryCount} D1 statements`);
});

test("a partial Page Feed R2 failure removes all candidate raw keys before outbox activation", async () => {
  const state = await fixture();
  state.evidence.failPutAt = 2;
  const tracked = await trackedInputs(state.d1, 20);
  for (let index = 0; index < tracked.inputs.length; index += 1) tracked.inputs[index].item.raw = `raw-${index}`;
  await assert.rejects(
    enqueueTrackedSourceRun(state.env, tracked.inputs, tracked.activation),
    /partial raw R2 failure/,
  );
  assert.equal(state.puts.length, 2);
  assert.equal(state.deletes.length, 20);
  assert.equal(new Set(state.deletes).size, 20);
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_runs WHERE run_id = ?").get(tracked.runId).count, 0);
  const usage = Object.fromEntries(
    state.database.prepare("SELECT dimension, units FROM usage_daily WHERE dimension LIKE 'r2_%' ORDER BY dimension").all()
      .map((row) => [row.dimension, Number(row.units)]),
  );
  assert.equal(usage.r2_class_a_ops, 21, "20 attempted raw puts plus the preflight list remain conservatively reserved");
  assert.equal(usage.r2_write_bytes, tracked.inputs.reduce((sum, input) => sum + Buffer.byteLength(input.item.raw), 0));
});

test("bounds are explicit and the 800-item adapter maximum stays below 50 D1 statements", async () => {
  assert.equal(SOURCE_OUTBOX_MAX_RUN_BYTES, 4_000_000);
  assert.equal(SOURCE_OUTBOX_MAX_ACTIVE_BYTES, 32_000_000);
  assert.equal(SOURCE_OUTBOX_MAX_RAW_MESSAGES, 20);
  assert.equal(SOURCE_OUTBOX_MAX_STAGE_CHUNKS, 6);
  const state = await fixture();
  state.d1.queryCount = 0;
  const prior = await drainTrackedSourceOutbox(state.env, { maxBatches: 1, skipMaintenance: true });
  assert.equal(prior.claimed, false);
  const runId = await beginSourceRun(state.d1, "outbox-source", "npm-registry");
  await requireBudget(state.d1, "source_runs", 1, { sourceId: "outbox-source", kind: "npm_releases" });
  await requireIngestQueueDurability(state.env);
  const allowance = await canSpend(state.d1, "queue_messages", 800);
  assert.equal(allowance.allowed, true);
  const tracked = await trackedInputs(state.d1, 800, { textBytes: 1, runId });
  const result = await enqueueTrackedSourceRun(state.env, tracked.inputs, tracked.activation);
  await observeSourceCadence(state.d1, {
    id: "outbox-source",
    name: "Outbox source",
    kind: "npm_releases",
    config_json: "{}",
    enabled: true,
    schedule_minutes: 60,
    weight: 1,
    last_run_at: null,
    last_success_at: null,
    last_error: null,
    health_score: 1,
    created_at: "2026-08-07T00:00:00.000Z",
    updated_at: "2026-08-07T00:00:00.000Z",
  }, { status: "queued", itemCount: 800, latencyMs: 12, meaningfulCount: 800 });
  assert.equal(result.messageCount, 800);
  assert.ok(state.d1.queryCount < 50, `full body-light source lifecycle used ${state.d1.queryCount} D1 statements`);
  assert.equal(
    state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_messages WHERE run_id = ?").get(tracked.runId).count,
    800,
  );
});

test("rich 800-item adapter output is pre-fit to an explicit contiguous partial prefix", () => {
  const inputs = Array.from({ length: 800 }, (_, index) => ({
    sourceId: "outbox-source",
    provider: "npm-registry",
    sourceRunId: "00000000-0000-4000-8000-000000000001",
    sourceRunItemIndex: index,
    item: {
      externalId: `package-${index}`,
      title: `Package ${index}`,
      text: "x".repeat(48_000),
      observedAt: "2026-08-07T12:00:00.000Z",
      metadata: { index },
    },
  }));
  const fit = fitTrackedSourceOutboxPrefix(inputs);
  assert.ok(fit.acceptedCount > 0 && fit.acceptedCount < inputs.length);
  assert.equal(fit.deferredCount, inputs.length - fit.acceptedCount);
  assert.ok(fit.messageBytes <= SOURCE_OUTBOX_MAX_RUN_BYTES);
  assert.ok(fit.stagingChunks > 0 && fit.stagingChunks <= SOURCE_OUTBOX_MAX_STAGE_CHUNKS);
  assert.deepEqual(
    fitTrackedSourceOutboxPrefix(inputs.slice(0, fit.acceptedCount + 1)),
    { ...fit, deferredCount: 1 },
    "the first deferred item cannot enter the same bounded run",
  );
});

test("the source registry records exact outbox deferral as partial coverage", async () => {
  const registry = await readFile(new URL("../src/sources/registry.ts", import.meta.url), "utf8");
  assert.match(registry, /outboxDeferredItems = fit\.deferredCount/);
  assert.match(registry, /const outboxAcceptedItems = queuedItems\.length;[\s\S]*budgetDeferredItems = outboxAcceptedItems - queuedItems\.length/);
  assert.match(registry, /collectionPartial = adapterPartial \|\| budgetDeferredItems > 0 \|\| outboxDeferredItems > 0/);
  assert.match(registry, /outboxDeferredItems,[\s\S]*outboxMessageBytes,[\s\S]*outboxStagingChunks/);
  assert.match(registry, /Source adapters cannot return pending without a durable handoff owner/);
  assert.match(registry, /Built-in source adapters cannot return queued without a tracked Queue handoff/);
  assert.doesNotMatch(registry, /pending \? "pending"/);
});

test("producer backpressure before collection creates no invisible pending source run", async () => {
  const state = await fixture();
  state.queue.metrics = async () => ({ backlogCount: 1, backlogBytes: 128 });
  const source = state.database.prepare("SELECT * FROM sources WHERE id = 'outbox-source'").get();
  const runSource = loadRunSource();

  await assert.rejects(
    runSource(source, state.env, { resumeOutbox: false }),
    (error) => error?.details?.code === "INGEST_PRIMARY_STALE",
  );

  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM source_runs").get().count, 0);
  assert.equal(state.database.prepare("SELECT last_run_at FROM sources WHERE id = 'outbox-source'").get().last_run_at, null);
  assert.equal(
    state.database.prepare("SELECT COUNT(*) AS count FROM usage_daily WHERE dimension = 'source_runs'").get().count,
    0,
    "a retryable preflight failure consumes no source-run budget",
  );
});

test("source-run budget denial happens before the run row and adapter fetch", async () => {
  const state = await fixture();
  await requireBudget(state.d1, "source_runs", 240, { fixture: "exhaust-source-budget" });
  const source = state.database.prepare("SELECT * FROM sources WHERE id = 'outbox-source'").get();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("adapter fetch must not run");
  };
  try {
    await assert.rejects(
      loadRunSource()(source, state.env, { resumeOutbox: false }),
      (error) => error?.name === "BudgetDeferredError" && error?.dimension === "source_runs",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM source_runs").get().count, 0);
  assert.equal(state.database.prepare("SELECT last_run_at FROM sources WHERE id = 'outbox-source'").get().last_run_at, null);
});

test("bounded pending-run reconciliation retires only proven no-handoff phantoms", async () => {
  const state = await fixture();
  state.database.prepare(
    `INSERT INTO source_cadence(
       source_id, mode, base_minutes, min_minutes, max_minutes, effective_minutes,
       next_run_at, last_reason
     ) VALUES ('outbox-source', 'adaptive', 60, 15, 480, 60, ?, 'stable-yield')`,
  ).run(new Date(Date.now() + 60 * 60_000).toISOString());
  const sourceHealthBefore = state.database.prepare(
    "SELECT health_score, last_success_at, last_error FROM sources WHERE id = 'outbox-source'",
  ).get();
  const outboxOwned = await beginSourceRun(state.d1, "outbox-source", "npm_releases");
  const unflagged = await beginSourceRun(state.d1, "outbox-source", "npm_releases");
  const phantom = await beginSourceRun(state.d1, "outbox-source", "npm_releases");
  for (const [runId, details] of [
    [phantom, { ingestBackpressure: true, error: "stale primary Queue" }],
    [outboxOwned, { ingestBackpressure: true, error: "activation state unknown" }],
    [unflagged, { superseded: true, canonicalSourceRunId: "canonical-run" }],
  ]) {
    state.database.prepare(
      `UPDATE source_runs
       SET status = 'pending', finished_at = '2026-08-07T00:00:00.000Z', details_json = ?
       WHERE id = ?`,
    ).run(JSON.stringify(details), runId);
  }
  state.database.prepare(
    `INSERT INTO source_ingest_outbox_runs(
       run_id, source_id, state, message_count, total_bytes, payload_sha256,
       next_index, created_at, updated_at
     ) VALUES (?, 'outbox-source', 'staging', 1, 1, ?, 0,
       '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z')`,
  ).run(outboxOwned, "b".repeat(64));
  const { reconcileOrphanedPendingSourceRun } = loadSourceRegistry();

  state.d1.beforeStatement = (statement) => {
    if (statement.query.includes("UPDATE source_cadence")) throw new Error("injected atomic cadence failure");
  };
  await assert.rejects(
    reconcileOrphanedPendingSourceRun(state.d1, "outbox-source"),
    /injected atomic cadence failure/,
  );
  state.d1.beforeStatement = null;
  assert.equal(
    state.database.prepare("SELECT status FROM source_runs WHERE id = ?").get(phantom).status,
    "pending",
    "terminalization rolls back when retry-due repair cannot commit",
  );
  assert.equal(
    state.database.prepare("SELECT last_reason FROM source_cadence WHERE source_id = 'outbox-source'").get().last_reason,
    "stable-yield",
  );

  assert.equal(await reconcileOrphanedPendingSourceRun(state.d1, "outbox-source"), true);
  const reconciled = state.database.prepare(
    "SELECT status, terminal_accounted_at, last_ingest_error, details_json FROM source_runs WHERE id = ?",
  ).get(phantom);
  assert.equal(reconciled.status, "failed");
  assert.ok(reconciled.terminal_accounted_at);
  assert.match(reconciled.last_ingest_error, /no durable handoff/);
  assert.deepEqual(JSON.parse(reconciled.details_json).reconciliation.reason, "no-durable-handoff");
  assert.equal(state.database.prepare("SELECT status FROM source_runs WHERE id = ?").get(outboxOwned).status, "pending");
  assert.equal(state.database.prepare("SELECT status FROM source_runs WHERE id = ?").get(unflagged).status, "pending");
  assert.deepEqual(
    state.database.prepare("SELECT health_score, last_success_at, last_error FROM sources WHERE id = 'outbox-source'").get(),
    sourceHealthBefore,
    "reconciliation does not rewrite source health",
  );
  assert.equal(state.database.prepare("SELECT last_run_at FROM sources WHERE id = 'outbox-source'").get().last_run_at, null);
  const cadence = state.database.prepare(
    "SELECT next_run_at, last_reason FROM source_cadence WHERE source_id = 'outbox-source'",
  ).get();
  assert.ok(Date.parse(cadence.next_run_at) <= Date.now());
  assert.equal(cadence.last_reason, "transport-retry-due");
  assert.equal(await reconcileOrphanedPendingSourceRun(state.d1, "outbox-source"), false);
});

test("orphan reconciliation never clears cadence from a later successful run", async () => {
  const state = await fixture();
  const orphan = await beginSourceRun(state.d1, "outbox-source", "npm_releases");
  state.database.prepare(
    `UPDATE source_runs
     SET status = 'pending', finished_at = '2026-08-07T00:00:00.000Z', details_json = ?
     WHERE id = ?`,
  ).run(JSON.stringify({ ingestBackpressure: true }), orphan);
  const success = await beginSourceRun(state.d1, "outbox-source", "npm_releases");
  await finishSourceRun(state.d1, {
    runId: success,
    sourceId: "outbox-source",
    status: "success",
    itemCount: 0,
    enqueuedCount: 0,
    latencyMs: 1,
    provider: "npm_releases",
  });
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  state.database.prepare(
    `INSERT INTO source_cadence(
       source_id, mode, base_minutes, min_minutes, max_minutes, effective_minutes,
       next_run_at, last_reason
     ) VALUES ('outbox-source', 'adaptive', 60, 15, 480, 60, ?, 'later-success')`,
  ).run(future);
  const sourceBefore = state.database.prepare(
    "SELECT last_run_at, last_success_at, health_score FROM sources WHERE id = 'outbox-source'",
  ).get();
  const { reconcileOrphanedPendingSourceRun } = loadSourceRegistry();

  assert.equal(await reconcileOrphanedPendingSourceRun(state.d1, "outbox-source"), true);
  assert.equal(state.database.prepare("SELECT status FROM source_runs WHERE id = ?").get(orphan).status, "failed");
  assert.deepEqual(
    state.database.prepare("SELECT last_run_at, last_success_at, health_score FROM sources WHERE id = 'outbox-source'").get(),
    sourceBefore,
  );
  const cadenceAfter = state.database.prepare(
    "SELECT next_run_at, last_reason FROM source_cadence WHERE source_id = 'outbox-source'",
  ).get();
  assert.equal(cadenceAfter.next_run_at, future);
  assert.equal(cadenceAfter.last_reason, "later-success");
});

test("post-collection backpressure terminalizes the run and remains automatically retryable", async () => {
  const state = await fixture();
  state.database.prepare("UPDATE sources SET config_json = ? WHERE id = 'outbox-source'").run(
    JSON.stringify({ packages: ["backpressure-proof"], perPackage: 1 }),
  );
  state.database.prepare(
    `INSERT INTO source_cadence(
       source_id, mode, base_minutes, min_minutes, max_minutes, effective_minutes,
       next_run_at, last_reason
     ) VALUES ('outbox-source', 'adaptive', 60, 15, 480, 60, ?, 'stable-yield')`,
  ).run(new Date(Date.now() + 60 * 60_000).toISOString());
  const sourceBefore = state.database.prepare(
    "SELECT health_score, last_error FROM sources WHERE id = 'outbox-source'",
  ).get();
  const source = state.database.prepare("SELECT * FROM sources WHERE id = 'outbox-source'").get();
  let primaryChecks = 0;
  state.queue.metrics = async () => {
    primaryChecks += 1;
    return primaryChecks === 1
      ? { backlogCount: 0, backlogBytes: 0 }
      : { backlogCount: 1, backlogBytes: 256 };
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    name: "backpressure-proof",
    description: "A collected item whose Queue handoff races with backpressure.",
    "dist-tags": { latest: "1.0.0" },
    versions: { "1.0.0": {} },
    time: { "1.0.0": "2026-08-07T12:00:00.000Z" },
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const runSource = loadRunSource();
    await assert.rejects(
      runSource(source, state.env, { resumeOutbox: false }),
      (error) => error?.details?.code === "INGEST_PRIMARY_STALE",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const run = state.database.prepare(
    `SELECT status, finished_at, terminal_accounted_at, enqueued_count,
            last_ingest_error, details_json
     FROM source_runs ORDER BY started_at DESC LIMIT 1`,
  ).get();
  const sourceAfter = state.database.prepare(
    "SELECT health_score, last_error FROM sources WHERE id = 'outbox-source'",
  ).get();
  const details = JSON.parse(run.details_json);
  assert.equal(primaryChecks, 2, "the sender repeats the pre-collection durability check");
  assert.equal(run.status, "failed");
  assert.ok(run.finished_at);
  assert.ok(run.terminal_accounted_at);
  assert.equal(run.enqueued_count, 0);
  assert.match(run.last_ingest_error, /stale primary Queue backlog/);
  assert.equal(details.ingestBackpressure, true);
  assert.equal(details.collectedItems, 1);
  assert.deepEqual(sourceAfter, sourceBefore, "transport backpressure does not lower source health");
  const cadence = state.database.prepare(
    "SELECT next_run_at, last_reason FROM source_cadence WHERE source_id = 'outbox-source'",
  ).get();
  assert.ok(Date.parse(cadence.next_run_at) <= Date.now());
  assert.equal(cadence.last_reason, "transport-retry-due");
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM source_runs WHERE status = 'pending'").get().count, 0);
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_runs").get().count, 0);
  assert.equal(state.sentBatches.length, 0);
});

test("Workers subrequest exhaustion is retry-due without health or cadence penalties", async () => {
  const state = await fixture();
  state.database.prepare("UPDATE sources SET config_json = ? WHERE id = 'outbox-source'").run(
    JSON.stringify({ packages: ["subrequest-capacity"], perPackage: 1 }),
  );
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  state.database.prepare(
    `INSERT INTO source_cadence(
       source_id, mode, base_minutes, min_minutes, max_minutes, effective_minutes,
       next_run_at, last_reason
     ) VALUES ('outbox-source', 'adaptive', 60, 15, 480, 60, ?, 'stable-yield')`,
  ).run(future);
  const sourceBefore = state.database.prepare(
    "SELECT health_score, last_success_at, last_error FROM sources WHERE id = 'outbox-source'",
  ).get();
  const source = state.database.prepare("SELECT * FROM sources WHERE id = 'outbox-source'").get();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("Too many subrequests.");
  };

  try {
    await assert.rejects(
      loadRunSource()(source, state.env, { resumeOutbox: false }),
      /Too many subrequests/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetches, 1);
  const run = state.database.prepare(
    `SELECT status, terminal_accounted_at, collection_partial, details_json, last_ingest_error
     FROM source_runs ORDER BY rowid DESC LIMIT 1`,
  ).get();
  assert.equal(run.status, "failed");
  assert.ok(run.terminal_accounted_at);
  assert.equal(run.collection_partial, 0);
  assert.match(run.last_ingest_error, /Too many subrequests\./);
  assert.equal(JSON.parse(run.details_json).subrequestEnvelopeExhausted, true);
  assert.deepEqual(
    state.database.prepare(
      "SELECT health_score, last_success_at, last_error FROM sources WHERE id = 'outbox-source'",
    ).get(),
    sourceBefore,
  );
  assert.equal(state.database.prepare("SELECT last_run_at FROM sources WHERE id = 'outbox-source'").get().last_run_at, null);
  const cadence = state.database.prepare(
    "SELECT next_run_at, last_reason FROM source_cadence WHERE source_id = 'outbox-source'",
  ).get();
  assert.ok(Date.parse(cadence.next_run_at) <= Date.now());
  assert.equal(cadence.last_reason, "transport-retry-due");
});

test("zero Queue-message allowance terminalizes collected work instead of leaving pending", async () => {
  const state = await fixture();
  await requireBudget(state.d1, "queue_messages", 2_500, { fixture: "exhaust-queue-budget" });
  state.database.prepare("UPDATE sources SET config_json = ? WHERE id = 'outbox-source'").run(
    JSON.stringify({ packages: ["zero-allowance-proof"], perPackage: 1 }),
  );
  const source = state.database.prepare("SELECT * FROM sources WHERE id = 'outbox-source'").get();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    name: "zero-allowance-proof",
    description: "A collected item with no remaining Queue allowance.",
    "dist-tags": { latest: "1.0.0" },
    versions: { "1.0.0": {} },
    time: { "1.0.0": "2026-08-07T12:00:00.000Z" },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      loadRunSource()(source, state.env, { resumeOutbox: false }),
      (error) => error?.details?.code === "INGEST_OUTBOX_CAPACITY",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const run = state.database.prepare(
    "SELECT status, terminal_accounted_at, details_json FROM source_runs ORDER BY started_at DESC LIMIT 1",
  ).get();
  const details = JSON.parse(run.details_json);
  assert.equal(run.status, "failed");
  assert.ok(run.terminal_accounted_at);
  assert.equal(details.collectedItems, 1);
  assert.equal(details.budgetDeferredItems, 1);
  assert.equal(details.ingestBackpressure, true);
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM source_runs WHERE status = 'pending'").get().count, 0);
  assert.equal(state.database.prepare("SELECT last_run_at FROM sources WHERE id = 'outbox-source'").get().last_run_at, null);
});

test("a normal built-in source run retires the prior terminal body set before producing another", async () => {
  const state = await fixture();
  const prior = await trackedInputs(state.d1, 1);
  const queued = await enqueueTrackedSourceRun(state.env, prior.inputs, prior.activation);
  assert.equal(queued.drain.completed, true);
  await recordSourceRunIngestOutcome(state.d1, {
    runId: prior.runId,
    sourceId: "outbox-source",
    itemIndex: 0,
    outcome: "inserted",
    itemId: "prior-terminal-item",
  });
  assert.equal((await trackedSourceOutboxHealth(state.d1)).terminalGcRuns, 1);

  state.database.prepare(
    "UPDATE sources SET config_json = ? WHERE id = 'outbox-source'",
  ).run(JSON.stringify({ packages: ["cleanup-proof"], perPackage: 1 }));
  const source = state.database.prepare("SELECT * FROM sources WHERE id = 'outbox-source'").get();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    name: "cleanup-proof",
    description: "A bounded package release.",
    "dist-tags": { latest: "1.0.0" },
    versions: { "1.0.0": {} },
    time: { "1.0.0": "2026-08-07T12:00:00.000Z" },
  }), { status: 200, headers: { "content-type": "application/json" } });

  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function driftglassTestLoad(request, parent, isMain) {
    if (request === "cloudflare:workers") {
      return {
        tracing: {
          enterSpan(_name, callback) {
            return callback({ setAttribute() {} });
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { runSource } = require("../.test-dist/sources/registry.js");
    state.d1.queryCount = 0;
    const result = await runSource(source, state.env, { resumeOutbox: false });
    const lifecycleStatements = state.d1.queryCount;
    assert.equal(result.status, "queued");
    assert.equal(result.count, 1);
    assert.equal(
      state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_runs WHERE run_id = ?").get(prior.runId).count,
      0,
      "the normal producer path removes the prior terminal run",
    );
    const retained = await trackedSourceOutboxHealth(state.d1);
    assert.equal(retained.retainedRuns, 1, "one replacement run does not grow the retained body-set count");
    assert.equal(retained.terminalGcRuns, 0);
    assert.equal(
      lifecycleStatements,
      39,
      "bounded phantom reconciliation keeps the lifecycle below the Free statement ceiling",
    );
  } finally {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
});

test("the npm runtime records a rich deferred tail without rejecting the durable prefix", async () => {
  const state = await fixture();
  const packages = Array.from({ length: 40 }, (_, index) => `rich-package-${index}`);
  const configJson = JSON.stringify({ packages, perPackage: 20 });
  state.database.prepare("UPDATE sources SET config_json = ? WHERE id = 'outbox-source'").run(configJson);
  const source = state.database.prepare("SELECT * FROM sources WHERE id = 'outbox-source'").get();
  const versions = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`1.0.${index}`, {}]));
  const times = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `1.0.${index}`,
    new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  ]));
  const originalFetch = globalThis.fetch;
  let activeFetches = 0;
  let maxActiveFetches = 0;
  globalThis.fetch = async (url) => {
    activeFetches += 1;
    maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
    await new Promise((resolve) => setImmediate(resolve));
    const packageName = decodeURIComponent(String(url).split("/").at(-1));
    const response = new Response(JSON.stringify({
      name: packageName,
      description: "x".repeat(48_000),
      homepage: `https://example.com/${"a".repeat(3_970)}`,
      "dist-tags": { latest: "1.0.19" },
      versions,
      time: times,
    }), { status: 200, headers: { "content-type": "application/json" } });
    activeFetches -= 1;
    return response;
  };

  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function driftglassTestLoad(request, parent, isMain) {
    if (request === "cloudflare:workers") {
      return {
        tracing: {
          enterSpan(_name, callback) {
            return callback({ setAttribute() {} });
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { runSource } = require("../.test-dist/sources/registry.js");
    const result = await runSource(source, state.env);
    const run = state.database.prepare(
      "SELECT status, item_count, enqueued_count, collection_partial, details_json FROM source_runs WHERE id = ?",
    ).get(result.runId);
    const details = JSON.parse(run.details_json);
    assert.equal(result.status, "queued");
    assert.equal(result.collectionPartial, true, "durable prefix handoff preserves deferred-tail coverage");
    assert.equal(details.collectedItems, 800);
    assert.equal(details.queuedItems, result.count);
    assert.equal(details.outboxDeferredItems, 800 - result.count);
    assert.equal(details.budgetDeferredItems, 0);
    assert.equal(details.collectionPartial, true);
    assert.equal(details.descriptionMaxBytes, 4_000);
    assert.equal(details.descriptionTruncatedItems, 800);
    assert.equal(run.collection_partial, 1);
    assert.equal(run.item_count, result.count);
    assert.equal(run.enqueued_count, result.count);
    assert.ok(result.count > 0 && result.count < 800);
    assert.equal(
      state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_messages WHERE run_id = ?").get(result.runId).count,
      result.count,
    );
    assert.equal(maxActiveFetches, 4);
    assert.equal(activeFetches, 0);
    assert.equal(
      state.d1.queryCount,
      44,
      "the complete rich 800-item runSource lifecycle, including terminal cleanup, must stay below the Free statement ceiling",
    );

    const customState = await fixture();
    customState.database.prepare("UPDATE sources SET config_json = ? WHERE id = 'outbox-source'").run(configJson);
    customState.database.prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES ('budget_profile', 'custom', CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run();
    customState.database.prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES ('budget_custom_limits', '{}', CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run();
    const customSource = customState.database.prepare("SELECT * FROM sources WHERE id = 'outbox-source'").get();
    customState.d1.queryCount = 0;
    const customResult = await runSource(customSource, customState.env);
    assert.equal(customResult.status, "queued");
    assert.equal(customResult.collectionPartial, true);
    assert.equal(
      customState.d1.queryCount,
      44,
      "custom profile must load its limits in the same one-statement boundary as Free",
    );
  } finally {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
});

test("a near-4 MB body set stages within the declared ceiling and six-query chunk bound", async () => {
  const state = await fixture();
  const tracked = await trackedInputs(state.d1, 80, { textBytes: 47_000 });
  state.d1.queryCount = 0;
  const result = await enqueueTrackedSourceRun(state.env, tracked.inputs, tracked.activation);
  assert.ok(result.totalBytes > 3_500_000 && result.totalBytes <= SOURCE_OUTBOX_MAX_RUN_BYTES);
  assert.ok(state.d1.queryCount < 50, `near-ceiling outbox invocation used ${state.d1.queryCount} D1 statements`);
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_messages WHERE run_id = ?").get(tracked.runId).count, 80);
});
