import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const {
  beginCollectorJobDispatch,
  beginSourceRun,
  completeCollectorJob,
  finishSourceRun,
  getIngestDeadLetterForRetry,
  ingestDurabilityDatabaseHealth,
  listBuiltInSourceRunSettlements,
  listIngestDeadLetters,
  queueCollectorJob,
  recordSourceRunIngestOutcome,
  reviseSourceRunAfterPartialEnqueue,
  resolveIngestDeadLetter,
  updateCollectorJobDispatch,
} = require("../.test-dist/db.js");
const {
  COMPANION_DISPATCH_TAKEOVER_MS,
  parseCollectorResultSummary,
} = require("../.test-dist/collector-results.js");
const { handleIngestQueueBatch } = require("../.test-dist/ingest-consumer.js");
const { orphanedPendingRunReadinessReasons } = require("../.test-dist/readiness.js");

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
    this.owner.beforeStatement?.(this);
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }

  async first() {
    this.owner.queryCount += 1;
    this.owner.beforeStatement?.(this);
    return this.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    this.owner.queryCount += 1;
    this.owner.beforeStatement?.(this);
    return { success: true, results: this.database.prepare(this.query).all(...this.values), meta: {} };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
    this.queryCount = 0;
    this.beforeStatement = null;
  }

  prepare(query) {
    return new SqliteD1Statement(this, query);
  }

  async batch(statements) {
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
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const database = new DatabaseSync(":memory:");
  for (const name of names) database.exec(await readFile(new URL(name, directory), "utf8"));
  const d1 = new SqliteD1(database);
  const insertSource = database.prepare(
    `INSERT INTO sources(
       id, name, kind, config_json, enabled, schedule_minutes, weight,
       health_score, created_at, updated_at
     ) VALUES (?, ?, ?, '{}', 0, 60, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  insertSource.run("cloud-source", "Cloud source", "lobsters", 0.73);
  insertSource.run("collector-source", "Collector source", "collector", 0.64);
  insertSource.run("manual-inbox", "Manual inbox", "manual", 1);
  database.prepare(
    `INSERT INTO collectors(id, name, token_hash, capabilities_json, status, created_at)
     VALUES ('collector-1', 'Collector one', 'token-hash', '["linkedin_jobs"]', 'online', CURRENT_TIMESTAMP)`,
  ).run();
  return { database, d1 };
}

async function queuedRun(d1, sourceId, count, { partial = false, provider = "fixture" } = {}) {
  const runId = await beginSourceRun(d1, sourceId, sourceId === "collector-source" ? "collector" : "lobsters");
  await finishSourceRun(d1, {
    runId,
    sourceId,
    status: "queued",
    itemCount: count,
    enqueuedCount: count,
    collectionPartial: partial,
    collectionHealthDelta: partial ? -0.02 : 0.08,
    latencyMs: 12,
    provider,
    details: { provider, collectionPartial: partial },
  });
  return runId;
}

function stageTrackedOutboxBody(database, runId, sourceId, body) {
  const bodyJson = JSON.stringify(body);
  const bodyBytes = Buffer.byteLength(bodyJson);
  database.prepare(
    `INSERT INTO source_ingest_outbox_runs(
       run_id, source_id, state, message_count, total_bytes, payload_sha256,
       next_index, provider, activated_at
     ) VALUES (?, ?, 'ready', 1, ?, ?, 1, 'fixture', CURRENT_TIMESTAMP)`,
  ).run(runId, sourceId, bodyBytes, "0".repeat(64));
  database.prepare(
    `INSERT INTO source_ingest_outbox_messages(
       run_id, item_index, message_json, message_bytes, body_sha256
     ) VALUES (?, 0, ?, ?, ?)`,
  ).run(runId, bodyJson, bodyBytes, "0".repeat(64));
}

function assertClose(actual, expected, message) {
  assert.ok(
    Math.abs(Number(actual) - expected) < 1e-9,
    message ?? `expected ${actual} to be within 1e-9 of ${expected}`,
  );
}

test("queued collection is nonterminal and idempotent receipts apply collection scoring once", async () => {
  const { database, d1 } = await fixture();
  const runId = await queuedRun(d1, "cloud-source", 2, { provider: "lobsters-json" });
  let run = database.prepare("SELECT * FROM source_runs WHERE id = ?").get(runId);
  let source = database.prepare("SELECT * FROM sources WHERE id = 'cloud-source'").get();
  assert.equal(run.status, "queued");
  assert.equal(run.finished_at, null);
  assert.equal(run.provider, "lobsters-json");
  assert.equal(source.last_success_at, null);
  assert.equal(source.health_score, 0.73);

  await recordSourceRunIngestOutcome(d1, {
    runId, sourceId: "cloud-source", itemIndex: 0, outcome: "inserted", itemId: "item-0",
  });
  await recordSourceRunIngestOutcome(d1, {
    runId, sourceId: "cloud-source", itemIndex: 0, outcome: "inserted", itemId: "item-0",
  });
  run = database.prepare("SELECT * FROM source_runs WHERE id = ?").get(runId);
  assert.equal(run.status, "queued");
  assert.equal(run.ingested_count, 1);

  await recordSourceRunIngestOutcome(d1, {
    runId,
    sourceId: "cloud-source",
    itemIndex: 1,
    outcome: "failed",
    error: "Primary ingest Queue retries were exhausted",
    retryCount: 4,
  });
  run = database.prepare("SELECT * FROM source_runs WHERE id = ?").get(runId);
  source = database.prepare("SELECT * FROM sources WHERE id = 'cloud-source'").get();
  assert.equal(run.status, "partial");
  assert.ok(run.finished_at);
  assert.equal(run.ingested_count, 1);
  assert.equal(run.failed_count, 1);
  assert.equal(run.ingest_failed_attempts, 4);
  assert.ok(source.last_success_at);
  assert.match(source.last_error, /retries were exhausted/);
  assertClose(source.health_score, 0.81, "the successful collection is scored once without a Queue penalty");
});

test("collection partial intent survives the Queue and yields terminal partial", async () => {
  const { database, d1 } = await fixture();
  const runId = await queuedRun(d1, "cloud-source", 1, { partial: true });
  await recordSourceRunIngestOutcome(d1, {
    runId, sourceId: "cloud-source", itemIndex: 0, outcome: "duplicate", itemId: "existing-item",
  });
  const run = database.prepare("SELECT * FROM source_runs WHERE id = ?").get(runId);
  assert.equal(run.status, "partial");
  assert.equal(run.collection_partial, 1);
  assert.equal(run.duplicate_count, 1);
  assertClose(database.prepare("SELECT health_score FROM sources WHERE id = 'cloud-source'").get().health_score, 0.71);
});

test("durable success applies collection health once across idempotent receipt replay", async () => {
  const { database, d1 } = await fixture();
  const runId = await queuedRun(d1, "cloud-source", 2);
  for (let index = 0; index < 2; index += 1) {
    await recordSourceRunIngestOutcome(d1, {
      runId, sourceId: "cloud-source", itemIndex: index, outcome: "inserted", itemId: `item-${index}`,
    });
  }
  assert.equal(database.prepare("SELECT status FROM source_runs WHERE id = ?").get(runId).status, "success");
  assertClose(database.prepare("SELECT health_score FROM sources WHERE id = 'cloud-source'").get().health_score, 0.81);
  await recordSourceRunIngestOutcome(d1, {
    runId, sourceId: "cloud-source", itemIndex: 1, outcome: "inserted", itemId: "item-1",
  });
  assertClose(database.prepare("SELECT health_score FROM sources WHERE id = 'cloud-source'").get().health_score, 0.81);
});

test("tracked authenticated-local exhaustion terminalizes the run and preserves a private recovery body", async () => {
  const { database, d1 } = await fixture();
  const runId = await queuedRun(d1, "cloud-source", 1);
  let acked = 0;
  let retried = 0;
  const message = {
    id: "queue-message-tracked",
    timestamp: new Date(),
    attempts: 1,
    body: {
      sourceId: "cloud-source",
      sourceRunId: runId,
      sourceRunItemIndex: 0,
      provider: "lobsters-json",
      item: {
        title: "Tracked exhausted fixture",
        text: "authenticated local recovery evidence",
        accessClass: "authenticated-local",
        metadata: {},
      },
    },
    ack() { acked += 1; },
    retry() { retried += 1; },
  };
  await handleIngestQueueBatch({
    queue: "driftglass-staging-ingest-dlq",
    messages: [message],
    ackAll() {},
    retryAll() {},
  }, {
    DB: d1,
    INGEST_QUEUE_NAME: "driftglass-staging-ingest",
    INGEST_DLQ_NAME: "driftglass-staging-ingest-dlq",
  });

  const run = database.prepare("SELECT * FROM source_runs WHERE id = ?").get(runId);
  assert.equal(acked, 1);
  assert.equal(retried, 0);
  assert.equal(run.status, "failed");
  assert.ok(run.finished_at);
  assert.equal(run.failed_count, 1);
  assert.equal(run.ingest_failed_attempts, 0, "the DLQ's own delivery ordinal does not overwrite primary retry accounting");
  assertClose(database.prepare("SELECT health_score FROM sources WHERE id = 'cloud-source'").get().health_score, 0.81);
  const summaries = await listIngestDeadLetters(d1);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].attempts, 1, "the exhausted DLQ delivery ordinal remains available on the incident");
  assert.equal(Object.hasOwn(summaries[0], "body_json"), false);
  assert.doesNotMatch(JSON.stringify(summaries[0]), /authenticated local recovery evidence/);
  const privateRecord = await getIngestDeadLetterForRetry(d1, summaries[0].id);
  assert.match(privateRecord.body_json, /authenticated local recovery evidence/);
});

test("DLQ terminal cleanup waits until the exact recovery body is durable", async () => {
  const { database, d1 } = await fixture();
  const runId = await queuedRun(d1, "cloud-source", 1);
  const body = {
    sourceId: "cloud-source",
    sourceRunId: runId,
    sourceRunItemIndex: 0,
    provider: "lobsters-json",
    item: {
      title: "Tracked exhausted public fixture",
      text: "bounded recovery ordering evidence",
      accessClass: "public",
      metadata: {},
    },
  };
  stageTrackedOutboxBody(database, runId, "cloud-source", body);
  const queueMessageId = "queue-message-terminal-order";
  let recoveryPresentAtCleanup = false;
  let cleanupStatements = 0;
  d1.beforeStatement = (statement) => {
    if (
      statement.query.includes("DELETE FROM source_ingest_outbox_runs")
      && statement.query.includes("run_id = ? AND source_id = ?")
    ) {
      cleanupStatements += 1;
      const recovery = database.prepare(
        "SELECT body_json FROM ingest_dead_letters WHERE queue_message_id = ?",
      ).get(queueMessageId);
      recoveryPresentAtCleanup = Boolean(recovery?.body_json.includes("bounded recovery ordering evidence"));
    }
  };
  let acked = 0;
  let retried = 0;
  d1.queryCount = 0;
  await handleIngestQueueBatch({
    queue: "driftglass-staging-ingest-dlq",
    messages: [{
      id: queueMessageId,
      timestamp: new Date(),
      attempts: 1,
      body,
      ack() { acked += 1; },
      retry() { retried += 1; },
    }],
    ackAll() {},
    retryAll() {},
  }, {
    DB: d1,
    INGEST_QUEUE_NAME: "driftglass-staging-ingest",
    INGEST_DLQ_NAME: "driftglass-staging-ingest-dlq",
  });

  assert.equal(cleanupStatements, 1);
  assert.equal(recoveryPresentAtCleanup, true, "private D1 recovery must precede terminal outbox deletion");
  assert.deepEqual({ acked, retried }, { acked: 1, retried: 0 });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM source_ingest_outbox_runs WHERE run_id = ?").get(runId).count, 0);
  assert.match(database.prepare("SELECT body_json FROM ingest_dead_letters WHERE queue_message_id = ?").get(queueMessageId).body_json, /bounded recovery ordering evidence/);
  assert.equal(d1.queryCount, 9, "terminal DLQ persistence and cleanup stay within a nine-statement envelope");
});

test("untracked DLQ bodies remain private and recoverable until retry or dismiss", async () => {
  const { database, d1 } = await fixture();
  let acked = 0;
  const body = {
    sourceId: "manual-inbox",
    provider: "manual",
    item: { title: "Private recovery fixture", text: "owner-private evidence", accessClass: "private" },
  };
  await handleIngestQueueBatch({
    queue: "driftglass-staging-ingest-dlq",
    messages: [{
      id: "queue-message-untracked",
      timestamp: new Date(),
      attempts: 1,
      body,
      ack() { acked += 1; },
      retry() { throw new Error("should not retry"); },
    }],
    ackAll() {},
    retryAll() {},
  }, {
    DB: d1,
    INGEST_QUEUE_NAME: "driftglass-staging-ingest",
    INGEST_DLQ_NAME: "driftglass-staging-ingest-dlq",
  });
  assert.equal(acked, 1);
  const summaries = await listIngestDeadLetters(d1);
  assert.equal(summaries.length, 1);
  assert.equal(Object.hasOwn(summaries[0], "body_json"), false);
  assert.equal(summaries[0].body_bytes, Buffer.byteLength(JSON.stringify(body)));
  const privateRecord = await getIngestDeadLetterForRetry(d1, summaries[0].id);
  assert.match(privateRecord.body_json, /owner-private evidence/);
  const resolved = await resolveIngestDeadLetter(d1, summaries[0].id, "ignored");
  assert.equal(resolved.status, "ignored");
  const cleared = database.prepare("SELECT body_json, body_bytes FROM ingest_dead_letters WHERE id = ?").get(summaries[0].id);
  assert.equal(cleared.body_json, "{}");
  assert.equal(cleared.body_bytes, 0);
});

test("stale tracked-run health includes interrupted cloud collection and excludes local ingress", async () => {
  const { database, d1 } = await fixture();
  const queuedCloudRun = await queuedRun(d1, "cloud-source", 1);
  const runningCloudRun = await beginSourceRun(d1, "cloud-source", "lobsters");
  const runningCollectorRun = await beginSourceRun(d1, "collector-source", "collector");
  const runningManualRun = await beginSourceRun(d1, "manual-inbox", "manual");
  database.prepare(
    `UPDATE source_runs
     SET started_at = '2026-08-07T00:00:00.000Z',
         collection_finished_at = CASE WHEN status = 'queued' THEN '2026-08-07T00:00:00.000Z' ELSE collection_finished_at END,
         ingest_updated_at = CASE WHEN status = 'queued' THEN '2026-08-07T00:00:00.000Z' ELSE ingest_updated_at END
     WHERE id IN (?, ?, ?, ?)`,
  ).run(queuedCloudRun, runningCloudRun, runningCollectorRun, runningManualRun);
  const health = await ingestDurabilityDatabaseHealth(d1, 1);
  assert.equal(health.staleTrackedRuns, 2);
  assert.equal(health.oldestStaleRunAt, "2026-08-07T00:00:00.000Z");
  assert.equal(health.orphanedPendingRuns, 0);
  assert.equal(health.unresolvedDeadLetters, 0);
});

test("durability health exposes only flagged pending runs with no durable owner", async () => {
  const { database, d1 } = await fixture();
  const orphaned = await beginSourceRun(d1, "cloud-source", "lobsters");
  const outboxOwned = await beginSourceRun(d1, "cloud-source", "lobsters");
  const collectorSuperseded = await beginSourceRun(d1, "collector-source", "collector");
  for (const [runId, details] of [
    [orphaned, { ingestBackpressure: true }],
    [outboxOwned, { ingestBackpressure: true }],
    [collectorSuperseded, { superseded: true }],
  ]) {
    database.prepare(
      `UPDATE source_runs
       SET status = 'pending', finished_at = '2026-08-07T00:00:00.000Z', details_json = ?
       WHERE id = ?`,
    ).run(JSON.stringify(details), runId);
  }
  database.prepare(
    `INSERT INTO source_ingest_outbox_runs(
       run_id, source_id, state, message_count, total_bytes, payload_sha256,
       next_index, created_at, updated_at
     ) VALUES (?, 'cloud-source', 'staging', 1, 1, ?, 0,
       '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z')`,
  ).run(outboxOwned, "a".repeat(64));

  const health = await ingestDurabilityDatabaseHealth(d1, 1);
  assert.equal(health.orphanedPendingRuns, 1);
  assert.equal(health.oldestOrphanedPendingRunAt, "2026-08-07T00:00:00.000Z");
});

test("readiness blocks on orphaned built-in runs surfaced by durability health", () => {
  assert.deepEqual(orphanedPendingRunReadinessReasons(0), []);
  assert.deepEqual(
    orphanedPendingRunReadinessReasons(1),
    ["1 built-in source run has pending status but no durable handoff"],
  );
  assert.deepEqual(
    orphanedPendingRunReadinessReasons(2),
    ["2 built-in source runs have pending status but no durable handoff"],
  );
});

test("retry-due failure terminalization is atomic and preserves a recoverable running row on rollback", async () => {
  const { database, d1 } = await fixture();
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  database.prepare(
    `INSERT INTO source_cadence(
       source_id, mode, base_minutes, min_minutes, max_minutes, effective_minutes,
       next_run_at, last_reason
     ) VALUES ('cloud-source', 'adaptive', 60, 15, 480, 60, ?, 'stable-yield')`,
  ).run(future);
  const runId = await beginSourceRun(d1, "cloud-source", "lobsters");
  d1.beforeStatement = (statement) => {
    if (statement.query.includes("UPDATE source_cadence")) throw new Error("injected retry-due failure");
  };
  await assert.rejects(
    finishSourceRun(d1, {
      runId,
      sourceId: "cloud-source",
      status: "failed",
      itemCount: 0,
      enqueuedCount: 0,
      latencyMs: 1,
      error: "transport pressure",
      affectSourceHealth: false,
      retryDue: true,
    }),
    /injected retry-due failure/,
  );
  d1.beforeStatement = null;
  const rolledBack = database.prepare(
    "SELECT status, terminal_accounted_at FROM source_runs WHERE id = ?",
  ).get(runId);
  assert.equal(rolledBack.status, "running");
  assert.equal(rolledBack.terminal_accounted_at, null);
  assert.equal(database.prepare(
    "SELECT last_reason FROM source_cadence WHERE source_id = 'cloud-source'",
  ).get().last_reason, "stable-yield");

  await finishSourceRun(d1, {
    runId,
    sourceId: "cloud-source",
    status: "failed",
    itemCount: 0,
    enqueuedCount: 0,
    latencyMs: 1,
    error: "transport pressure",
    affectSourceHealth: false,
    retryDue: true,
  });
  const terminal = database.prepare(
    "SELECT status, terminal_accounted_at FROM source_runs WHERE id = ?",
  ).get(runId);
  assert.equal(terminal.status, "failed");
  assert.ok(terminal.terminal_accounted_at);
  assert.equal(database.prepare("SELECT last_run_at FROM sources WHERE id = 'cloud-source'").get().last_run_at, null);
  const cadence = database.prepare(
    "SELECT next_run_at, last_reason FROM source_cadence WHERE source_id = 'cloud-source'",
  ).get();
  assert.ok(Date.parse(cadence.next_run_at) <= Date.now());
  assert.equal(cadence.last_reason, "transport-retry-due");
});

test("built-in settlement reads are one bounded query and exclude Companion ownership", async () => {
  const { database, d1 } = await fixture();
  const builtIn = await beginSourceRun(d1, "cloud-source", "lobsters");
  await finishSourceRun(d1, {
    runId: builtIn,
    sourceId: "cloud-source",
    status: "partial",
    itemCount: 1,
    enqueuedCount: 0,
    latencyMs: 1,
    collectionPartial: true,
    error: "bounded tail deferred",
  });
  const companion = await beginSourceRun(d1, "collector-source", "collector");
  await finishSourceRun(d1, {
    runId: companion,
    sourceId: "collector-source",
    status: "queued",
    itemCount: 0,
    enqueuedCount: 0,
    latencyMs: 1,
  });
  const before = d1.queryCount;
  const settlements = await listBuiltInSourceRunSettlements(d1, [builtIn, companion, builtIn]);
  assert.equal(d1.queryCount - before, 1);
  assert.deepEqual(settlements, [{
    runId: builtIn,
    status: "partial",
    collectionPartial: true,
    lastIngestError: "bounded tail deferred",
  }]);

  database.prepare(
    "UPDATE source_runs SET terminal_accounted_at = NULL WHERE id = ?",
  ).run(builtIn);
  assert.deepEqual(await listBuiltInSourceRunSettlements(d1, [builtIn]), [{
    runId: builtIn,
    status: "pending",
    collectionPartial: true,
    lastIngestError: "bounded tail deferred",
  }], "a terminal-looking run remains unsettled until terminal accounting commits");
});

test("concurrent collector source runs converge on one job without orphaning the losing run", async () => {
  const { database, d1 } = await fixture();
  const firstRun = await beginSourceRun(d1, "collector-source", "collector");
  const secondRun = await beginSourceRun(d1, "collector-source", "collector");
  const [first, second] = await Promise.all([
    queueCollectorJob(d1, {
      sourceId: "collector-source", sourceRunId: firstRun, operation: "linkedin_jobs", args: { query: "agents" }, collectorId: "collector-1",
    }),
    queueCollectorJob(d1, {
      sourceId: "collector-source", sourceRunId: secondRun, operation: "linkedin_jobs", args: { query: "agents" }, collectorId: "collector-1",
    }),
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM collector_jobs WHERE status = 'queued'").get().count, 1);
  assert.equal(Number(first.created) + Number(second.created), 1);
  assert.equal(first.id, second.id);
  const winningRun = first.sourceRunId;
  const losingRun = winningRun === firstRun ? secondRun : firstRun;
  const persistedLoser = database.prepare("SELECT status, finished_at, details_json FROM source_runs WHERE id = ?").get(losingRun);
  assert.equal(persistedLoser.status, "pending");
  assert.ok(persistedLoser.finished_at);
  assert.deepEqual(JSON.parse(persistedLoser.details_json), {
    superseded: true,
    canonicalSourceRunId: winningRun,
    existingJobId: first.id,
    operation: "linkedin_jobs",
  });
  await finishSourceRun(d1, {
    runId: winningRun, sourceId: "collector-source", status: "queued", itemCount: 0, enqueuedCount: 0,
    latencyMs: 1, provider: "driftglass-relay", details: { jobId: first.id },
  });
  const winner = database.prepare("SELECT status, finished_at FROM source_runs WHERE id = ?").get(winningRun);
  const loser = database.prepare("SELECT status, finished_at FROM source_runs WHERE id = ?").get(losingRun);
  assert.equal(winner.status, "queued");
  assert.equal(winner.finished_at, null);
  assert.equal(loser.status, "pending");
  assert.ok(loser.finished_at);
});

test("a crash after dispatch intent but before Queue send replays once instead of falsely completing", async (t) => {
  const { database, d1 } = await fixture();
  const runId = await beginSourceRun(d1, "collector-source", "collector");
  const job = await queueCollectorJob(d1, {
    sourceId: "collector-source", sourceRunId: runId, operation: "linkedin_jobs", args: {}, collectorId: "collector-1",
  });
  database.prepare("UPDATE collector_jobs SET status = 'leased', collector_id = 'collector-1' WHERE id = ?").run(job.id);
  const realDateNow = Date.now;
  t.after(() => { Date.now = realDateNow; });
  let testNow = realDateNow();
  Date.now = () => testNow;
  const base = {
    provider: "driftglass-relay",
    collectedCount: 1,
    acceptedCount: 0,
    diagnostics: {},
    dispatch: {
      version: 1,
      fingerprint: "c".repeat(64),
      attemptId: "crashed-attempt-0001",
      attemptStartedAt: new Date(testNow).toISOString(),
      phase: "dispatching",
      plannedCount: 1,
      acceptedCount: 0,
      collectionPartial: false,
    },
  };
  const crashedAttempt = await beginCollectorJobDispatch(d1, {
    jobId: job.id, collectorId: "collector-1", sourceId: "collector-source", sourceRunId: runId,
    expectedResultJson: null, resultSummary: base, details: { queuedItems: 1 },
  });
  assert.equal(crashedAttempt.started, true);
  assert.equal(database.prepare("SELECT status FROM collector_jobs WHERE id = ?").get(job.id).status, "leased");
  const pendingRun = database.prepare("SELECT status, finished_at, terminal_accounted_at FROM source_runs WHERE id = ?").get(runId);
  assert.equal(pendingRun.status, "queued");
  assert.equal(pendingRun.finished_at, null);
  assert.equal(pendingRun.terminal_accounted_at, null);
  await assert.rejects(
    completeCollectorJob(d1, {
      jobId: job.id, collectorId: "collector-1", ok: false,
      error: "ambiguous successful result POST failed at the Companion",
      itemCount: 0, provider: "driftglass-relay",
    }),
    /failure cannot replace an in-progress or accepted result dispatch/,
  );
  assert.equal(database.prepare("SELECT status FROM collector_jobs WHERE id = ?").get(job.id).status, "leased");

  const prematureRetry = { ...base, dispatch: {
    ...base.dispatch,
    attemptId: "premature-attempt-0002",
    attemptStartedAt: new Date(testNow).toISOString(),
  } };
  await assert.rejects(
    beginCollectorJobDispatch(d1, {
      jobId: job.id, collectorId: "collector-1", sourceId: "collector-source", sourceRunId: runId,
      expectedResultJson: crashedAttempt.resultJson, resultSummary: prematureRetry, details: { queuedItems: 1 },
    }),
    /expired or retryable attempt/,
  );
  testNow += COMPANION_DISPATCH_TAKEOVER_MS + 1;

  const retryA = { ...base, dispatch: {
    ...base.dispatch,
    attemptId: "replayed-attempt-0003",
    attemptStartedAt: new Date(testNow).toISOString(),
  } };
  const retryB = { ...base, dispatch: {
    ...base.dispatch,
    attemptId: "replayed-attempt-0004",
    attemptStartedAt: new Date(testNow).toISOString(),
  } };
  const firstRetry = await beginCollectorJobDispatch(d1, {
    jobId: job.id, collectorId: "collector-1", sourceId: "collector-source", sourceRunId: runId,
    expectedResultJson: crashedAttempt.resultJson, resultSummary: retryA, details: { queuedItems: 1 },
  });
  const racedRetry = await beginCollectorJobDispatch(d1, {
    jobId: job.id, collectorId: "collector-1", sourceId: "collector-source", sourceRunId: runId,
    expectedResultJson: crashedAttempt.resultJson, resultSummary: retryB, details: { queuedItems: 1 },
  });
  let queueSendCalls = 0;
  if (firstRetry.started) queueSendCalls += 1;
  if (racedRetry.started) queueSendCalls += 1;
  assert.equal(firstRetry.started, true);
  assert.equal(racedRetry.started, false);
  assert.equal(queueSendCalls, 1, "only the request that wins the attempt CAS may call the Queue");
  assert.equal(database.prepare("SELECT status FROM collector_jobs WHERE id = ?").get(job.id).status, "leased");

  const accepted = {
    ...retryA,
    acceptedCount: 1,
    dispatch: { ...retryA.dispatch, phase: "accepted", acceptedCount: 1 },
  };
  await updateCollectorJobDispatch(d1, {
    jobId: job.id, collectorId: "collector-1", expectedResultJson: firstRetry.resultJson, resultSummary: accepted,
  });
  await completeCollectorJob(d1, {
    jobId: job.id, collectorId: "collector-1", ok: true, resultSummary: accepted,
    itemCount: 1, provider: "driftglass-relay",
  });
  assert.equal(database.prepare("SELECT status FROM collector_jobs WHERE id = ?").get(job.id).status, "complete");
});

test("a confirmed zero-send retry may safely replace a dynamically changed result fingerprint", async () => {
  const { database, d1 } = await fixture();
  const runId = await beginSourceRun(d1, "collector-source", "collector");
  const job = await queueCollectorJob(d1, {
    sourceId: "collector-source", sourceRunId: runId, operation: "linkedin_jobs", args: {}, collectorId: "collector-1",
  });
  database.prepare("UPDATE collector_jobs SET status = 'leased', collector_id = 'collector-1' WHERE id = ?").run(job.id);
  const first = {
    provider: "driftglass-relay",
    collectedCount: 1,
    acceptedCount: 0,
    diagnostics: {},
    dispatch: {
      version: 1,
      fingerprint: "d".repeat(64),
      attemptId: "zero-send-attempt-0001",
      attemptStartedAt: new Date().toISOString(),
      phase: "dispatching",
      plannedCount: 1,
      acceptedCount: 0,
      collectionPartial: false,
    },
  };
  const begun = await beginCollectorJobDispatch(d1, {
    jobId: job.id, collectorId: "collector-1", sourceId: "collector-source", sourceRunId: runId,
    expectedResultJson: null, resultSummary: first, details: { queuedItems: 1 },
  });
  const retryable = { ...first, dispatch: { ...first.dispatch, phase: "retryable" } };
  const marked = await updateCollectorJobDispatch(d1, {
    jobId: job.id, collectorId: "collector-1", expectedResultJson: begun.resultJson, resultSummary: retryable,
  });
  const changed = {
    ...first,
    dispatch: {
      ...first.dispatch,
      fingerprint: "e".repeat(64),
      attemptId: "changed-result-attempt-0002",
      attemptStartedAt: new Date().toISOString(),
    },
  };
  const retried = await beginCollectorJobDispatch(d1, {
    jobId: job.id, collectorId: "collector-1", sourceId: "collector-source", sourceRunId: runId,
    expectedResultJson: marked.resultJson, resultSummary: changed, details: { queuedItems: 1 },
  });
  assert.equal(retried.started, true);
  assert.equal(parseCollectorResultSummary(retried.resultJson).dispatch.fingerprint, "e".repeat(64));
});

test("accepted Companion dispatch survives completion failure without reopening or double-scoring", async () => {
  const { database, d1 } = await fixture();
  const runId = await beginSourceRun(d1, "collector-source", "collector");
  const job = await queueCollectorJob(d1, {
    sourceId: "collector-source", sourceRunId: runId, operation: "linkedin_jobs", args: { query: "agents" }, collectorId: "collector-1",
  });
  database.prepare("UPDATE collector_jobs SET status = 'leased', collector_id = 'collector-1' WHERE id = ?").run(job.id);
  const fingerprint = "a".repeat(64);
  const dispatching = {
    provider: "driftglass-relay",
    collectedCount: 2,
    acceptedCount: 0,
    diagnostics: { returned: 2 },
    dispatch: {
      version: 1,
      fingerprint,
      attemptId: "accepted-attempt-0001",
      attemptStartedAt: new Date().toISOString(),
      phase: "dispatching",
      plannedCount: 2,
      acceptedCount: 0,
      collectionPartial: false,
    },
  };
  const begun = await beginCollectorJobDispatch(d1, {
    jobId: job.id,
    collectorId: "collector-1",
    sourceId: "collector-source",
    sourceRunId: runId,
    expectedResultJson: null,
    resultSummary: dispatching,
    details: { jobId: job.id, provider: "driftglass-relay", collectedItems: 2, queuedItems: 2 },
  });
  assert.equal(begun.started, true);
  const accepted = {
    ...dispatching,
    acceptedCount: 2,
    dispatch: { ...dispatching.dispatch, phase: "accepted", acceptedCount: 2 },
  };
  const marked = await updateCollectorJobDispatch(d1, {
    jobId: job.id,
    collectorId: "collector-1",
    expectedResultJson: begun.resultJson,
    resultSummary: accepted,
  });
  assert.equal(marked.started, true);

  let failCompletion = true;
  const failingD1 = {
    prepare(query) { return d1.prepare(query); },
    async batch(statements) {
      if (failCompletion) {
        failCompletion = false;
        throw new Error("injected completion write failure");
      }
      return d1.batch(statements);
    },
  };
  await assert.rejects(
    completeCollectorJob(failingD1, {
      jobId: job.id,
      collectorId: "collector-1",
      ok: true,
      resultSummary: accepted,
      itemCount: 2,
      provider: "driftglass-relay",
    }),
    /injected completion write failure/,
  );
  const persistedAfterFailure = database.prepare("SELECT status, result_json FROM collector_jobs WHERE id = ?").get(job.id);
  assert.equal(persistedAfterFailure.status, "leased");
  assert.equal(parseCollectorResultSummary(persistedAfterFailure.result_json).dispatch.phase, "accepted");

  const completed = await completeCollectorJob(d1, {
    jobId: job.id,
    collectorId: "collector-1",
    ok: true,
    resultSummary: parseCollectorResultSummary(persistedAfterFailure.result_json),
    itemCount: 2,
    provider: "driftglass-relay",
  });
  assert.equal(completed.transitioned, true);
  for (let index = 0; index < 2; index += 1) {
    await recordSourceRunIngestOutcome(d1, {
      runId, sourceId: "collector-source", itemIndex: index, outcome: "inserted", itemId: `accepted-${index}`,
    });
  }
  const terminal = database.prepare("SELECT status, finished_at, terminal_accounted_at FROM source_runs WHERE id = ?").get(runId);
  assert.equal(terminal.status, "success");
  assert.ok(terminal.finished_at);
  assert.ok(terminal.terminal_accounted_at);
  assertClose(database.prepare("SELECT health_score FROM sources WHERE id = 'collector-source'").get().health_score, 0.72);

  const replayedCompletion = await completeCollectorJob(d1, {
    jobId: job.id,
    collectorId: "collector-1",
    ok: true,
    resultSummary: accepted,
    itemCount: 2,
    provider: "driftglass-relay",
  });
  assert.equal(replayedCompletion.transitioned, false);
  await finishSourceRun(d1, {
    runId,
    sourceId: "collector-source",
    status: "queued",
    itemCount: 2,
    enqueuedCount: 2,
    collectionHealthDelta: 0.08,
    latencyMs: 0,
    provider: "driftglass-relay",
  });
  const afterReplay = database.prepare("SELECT status, finished_at, terminal_accounted_at FROM source_runs WHERE id = ?").get(runId);
  assert.deepEqual(afterReplay, terminal, "a terminal source run must never be reopened by a result retry");
  assertClose(database.prepare("SELECT health_score FROM sources WHERE id = 'collector-source'").get().health_score, 0.72);
});

test("partially accepted Companion dispatch preserves explicit partial state and scores collection once", async () => {
  const { database, d1 } = await fixture();
  const runId = await beginSourceRun(d1, "collector-source", "collector");
  const job = await queueCollectorJob(d1, {
    sourceId: "collector-source", sourceRunId: runId, operation: "linkedin_jobs", args: {}, collectorId: "collector-1",
  });
  database.prepare("UPDATE collector_jobs SET status = 'leased', collector_id = 'collector-1' WHERE id = ?").run(job.id);
  const dispatching = {
    provider: "driftglass-relay",
    collectedCount: 2,
    acceptedCount: 0,
    diagnostics: {},
    dispatch: {
      version: 1,
      fingerprint: "b".repeat(64),
      attemptId: "partial-attempt-0001",
      attemptStartedAt: new Date().toISOString(),
      phase: "dispatching",
      plannedCount: 2,
      acceptedCount: 0,
      collectionPartial: false,
    },
  };
  const begun = await beginCollectorJobDispatch(d1, {
    jobId: job.id, collectorId: "collector-1", sourceId: "collector-source", sourceRunId: runId,
    expectedResultJson: null, resultSummary: dispatching, details: { queuedItems: 2 },
  });
  await reviseSourceRunAfterPartialEnqueue(d1, {
    runId, sourceId: "collector-source", sentCount: 1,
    error: "Queue accepted 1 of 2 Companion items",
    details: { queuedItems: 1, unsentQueueItems: 1, collectionPartial: true },
  });
  const accepted = {
    ...dispatching,
    acceptedCount: 1,
    dispatch: { ...dispatching.dispatch, phase: "accepted", acceptedCount: 1, collectionPartial: true },
  };
  await updateCollectorJobDispatch(d1, {
    jobId: job.id, collectorId: "collector-1", expectedResultJson: begun.resultJson, resultSummary: accepted,
  });
  await completeCollectorJob(d1, {
    jobId: job.id, collectorId: "collector-1", ok: true, resultSummary: accepted,
    itemCount: 1, provider: "driftglass-relay",
  });
  await recordSourceRunIngestOutcome(d1, {
    runId, sourceId: "collector-source", itemIndex: 0, outcome: "inserted", itemId: "partial-0",
  });
  const run = database.prepare("SELECT status, collection_partial, enqueued_count FROM source_runs WHERE id = ?").get(runId);
  assert.equal(run.status, "partial");
  assert.equal(run.collection_partial, 1);
  assert.equal(run.enqueued_count, 1);
  assertClose(database.prepare("SELECT health_score FROM sources WHERE id = 'collector-source'").get().health_score, 0.72);
});

test("adapter-reported partial Companion collection stays partial after every queued item ingests", async () => {
  const { database, d1 } = await fixture();
  const runId = await beginSourceRun(d1, "collector-source", "collector");
  const job = await queueCollectorJob(d1, {
    sourceId: "collector-source", sourceRunId: runId, operation: "linkedin_jobs", args: {}, collectorId: "collector-1",
  });
  database.prepare("UPDATE collector_jobs SET status = 'leased', collector_id = 'collector-1' WHERE id = ?").run(job.id);
  const dispatching = {
    provider: "opencli",
    collectedCount: 1,
    acceptedCount: 0,
    diagnostics: { collectionPartial: true, observedRecords: 3, cappedRecords: 2, unusableRecords: 0 },
    dispatch: {
      version: 1,
      fingerprint: "c".repeat(64),
      attemptId: "adapter-partial-attempt-0001",
      attemptStartedAt: new Date().toISOString(),
      phase: "dispatching",
      plannedCount: 1,
      acceptedCount: 0,
      collectionPartial: true,
    },
  };
  const begun = await beginCollectorJobDispatch(d1, {
    jobId: job.id, collectorId: "collector-1", sourceId: "collector-source", sourceRunId: runId,
    expectedResultJson: null, resultSummary: dispatching,
    details: { provider: "opencli", queuedItems: 1, collectionPartial: true },
  });
  const queued = database.prepare(
    "SELECT status, collection_partial, collection_health_delta FROM source_runs WHERE id = ?",
  ).get(runId);
  assert.equal(queued.status, "queued");
  assert.equal(queued.collection_partial, 1);
  assertClose(queued.collection_health_delta, -0.02);

  const accepted = {
    ...dispatching,
    acceptedCount: 1,
    dispatch: { ...dispatching.dispatch, phase: "accepted", acceptedCount: 1 },
  };
  await updateCollectorJobDispatch(d1, {
    jobId: job.id, collectorId: "collector-1", expectedResultJson: begun.resultJson, resultSummary: accepted,
  });
  await completeCollectorJob(d1, {
    jobId: job.id, collectorId: "collector-1", ok: true, resultSummary: accepted,
    itemCount: 1, provider: "opencli",
  });
  await recordSourceRunIngestOutcome(d1, {
    runId, sourceId: "collector-source", itemIndex: 0, outcome: "inserted", itemId: "adapter-partial-0",
  });

  const terminal = database.prepare(
    "SELECT status, collection_partial, enqueued_count, last_ingest_error FROM source_runs WHERE id = ?",
  ).get(runId);
  assert.equal(terminal.status, "partial");
  assert.equal(terminal.collection_partial, 1);
  assert.equal(terminal.enqueued_count, 1);
  assert.equal(terminal.last_ingest_error, null);
  const source = database.prepare("SELECT health_score, last_error FROM sources WHERE id = 'collector-source'").get();
  assertClose(source.health_score, 0.62);
  assert.match(source.last_error, /partial coverage/i);
});

test("Companion job completion waits for receipts and DLQ exhaustion terminalizes its bound run", async () => {
  const { database, d1 } = await fixture();
  const runId = await beginSourceRun(d1, "collector-source", "collector");
  const job = await queueCollectorJob(d1, {
    sourceId: "collector-source", sourceRunId: runId, operation: "linkedin_jobs", args: { query: "agents" }, collectorId: "collector-1",
  });
  database.prepare(
    "UPDATE collector_jobs SET status = 'leased', collector_id = 'collector-1' WHERE id = ?",
  ).run(job.id);
  await finishSourceRun(d1, {
    runId,
    sourceId: "collector-source",
    status: "queued",
    itemCount: 2,
    enqueuedCount: 2,
    collectionHealthDelta: 0.08,
    latencyMs: 0,
    provider: "driftglass-relay",
    details: { jobId: job.id, collectedItems: 2, queuedItems: 2 },
  });
  await completeCollectorJob(d1, {
    jobId: job.id,
    collectorId: "collector-1",
    ok: true,
    resultSummary: { provider: "driftglass-relay", collectedCount: 2, acceptedCount: 2 },
    result: { items: [{ title: "must-not-persist", text: "private companion body", metadata: { secret: true } }] },
    itemCount: 2,
    provider: "driftglass-relay",
  });
  let run = database.prepare("SELECT * FROM source_runs WHERE id = ?").get(runId);
  let source = database.prepare("SELECT * FROM sources WHERE id = 'collector-source'").get();
  assert.equal(database.prepare("SELECT status FROM collector_jobs WHERE id = ?").get(job.id).status, "complete");
  const persistedJobResult = database.prepare("SELECT result_json FROM collector_jobs WHERE id = ?").get(job.id).result_json;
  assert.doesNotMatch(persistedJobResult, /must-not-persist|private companion body|metadata|secret|items/);
  assert.equal(run.status, "queued");
  assert.equal(run.finished_at, null);
  assert.equal(source.last_success_at, null);
  assert.equal(source.health_score, 0.64, "Companion collection remains unscored before durable receipts terminalize the run");

  let acked = 0;
  for (let index = 0; index < 2; index += 1) {
    await handleIngestQueueBatch({
      queue: "driftglass-staging-ingest-dlq",
      messages: [{
        id: `companion-exhausted-${index}`,
        timestamp: new Date(),
        attempts: 1,
        body: {
          sourceId: "collector-source",
          sourceRunId: runId,
          sourceRunItemIndex: index,
          provider: "driftglass-relay",
          item: { title: `Companion item ${index}`, accessClass: "authenticated-local", metadata: {} },
        },
        ack() { acked += 1; },
        retry() { throw new Error("should not retry"); },
      }],
      ackAll() {},
      retryAll() {},
    }, {
      DB: d1,
      INGEST_QUEUE_NAME: "driftglass-staging-ingest",
      INGEST_DLQ_NAME: "driftglass-staging-ingest-dlq",
    });
  }
  run = database.prepare("SELECT * FROM source_runs WHERE id = ?").get(runId);
  source = database.prepare("SELECT * FROM sources WHERE id = 'collector-source'").get();
  assert.equal(acked, 2);
  assert.equal(run.status, "failed");
  assert.equal(run.failed_count, 2);
  assert.ok(run.finished_at);
  assert.equal(source.last_success_at, null);
  assert.match(source.last_error, /retries were exhausted/);
  assertClose(source.health_score, 0.72, "successful Companion collection is scored once without a Queue penalty");
});

test("zero-item and failed Companion responses terminalize their specific bound runs", async () => {
  const { database, d1 } = await fixture();
  for (const [operation, ok] of [["linkedin_jobs", true], ["browser_history_search", false]]) {
    const runId = await beginSourceRun(d1, "collector-source", "collector");
    const job = await queueCollectorJob(d1, {
      sourceId: "collector-source", sourceRunId: runId, operation, args: {}, collectorId: "collector-1",
    });
    database.prepare("UPDATE collector_jobs SET status = 'leased', collector_id = 'collector-1' WHERE id = ?").run(job.id);
    await finishSourceRun(d1, {
      runId, sourceId: "collector-source", status: "queued", itemCount: 0, enqueuedCount: 0,
      latencyMs: 1, provider: "driftglass-relay", details: { jobId: job.id },
    });
    await completeCollectorJob(d1, {
      jobId: job.id,
      collectorId: "collector-1",
      ok,
      itemCount: 0,
      provider: "driftglass-relay",
      error: ok ? undefined : "Companion collection failed",
    });
    const run = database.prepare("SELECT status, finished_at FROM source_runs WHERE id = ?").get(runId);
    assert.equal(run.status, ok ? "success" : "failed");
    assert.ok(run.finished_at);
  }
});

test("adapter partial scoring takes precedence over budget truncation", async () => {
  const registry = await readFile(new URL("../src/sources/registry.ts", import.meta.url), "utf8");
  assert.match(
    registry,
    /source\.kind === "collector"[\s\S]*\? 0[\s\S]*: adapterPartial[\s\S]*\? -0\.02[\s\S]*: budgetDeferredItems > 0[\s\S]*\? 0[\s\S]*: 0\.08/,
  );
});
