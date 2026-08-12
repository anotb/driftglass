import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
let handleApi;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "cloudflare:workers") {
      return {
        DurableObject: class DurableObject {},
        WorkflowEntrypoint: class WorkflowEntrypoint {},
        WorkerEntrypoint: class WorkerEntrypoint {},
        tracing: { trace: (_name, operation) => operation },
      };
    }
    if (request === "@cloudflare/computer") {
      return {
        getWorkspace() {},
        withWorkspace(Base) { return class WorkspaceTestDouble extends Base {}; },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ handleApi } = require("../.test-dist/api.js"));
} finally {
  Module._load = originalLoad;
}
const { handleIngestQueueBatch } = require("../.test-dist/ingest-consumer.js");
const {
  listQuarantineRecoveries,
  materializeQuarantineRecovery,
} = require("../.test-dist/quarantine-recovery.js");

class SqliteD1Statement {
  constructor(database, query) {
    this.database = database;
    this.query = query;
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async run() {
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }
  async first() { return this.database.prepare(this.query).get(...this.values) ?? null; }
  async all() {
    return { success: true, results: this.database.prepare(this.query).all(...this.values), meta: {} };
  }
}

class SqliteD1 {
  constructor(database) { this.database = database; }
  prepare(query) { return new SqliteD1Statement(this.database, query); }
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

async function databaseFixture() {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const database = new DatabaseSync(":memory:");
  for (const name of names) database.exec(await readFile(new URL(name, directory), "utf8"));
  return { database, d1: new SqliteD1(database) };
}

function quarantineMessage(body, overrides = {}) {
  const state = { acked: 0, retries: [] };
  return {
    state,
    message: {
      id: overrides.id ?? "quarantine-message-1",
      timestamp: new Date("2026-08-07T00:00:00.000Z"),
      attempts: overrides.attempts ?? 4,
      body,
      ack() { state.acked += 1; },
      retry(options) { state.retries.push(options); },
    },
  };
}

function batch(message) {
  return {
    queue: "driftglass-staging-ingest-quarantine",
    messages: [message],
    ackAll() {},
    retryAll() {},
  };
}

function queueEnv(overrides) {
  return {
    INGEST_QUEUE_NAME: "driftglass-staging-ingest",
    INGEST_DLQ_NAME: "driftglass-staging-ingest-dlq",
    INGEST_QUARANTINE_NAME: "driftglass-staging-ingest-quarantine",
    ...overrides,
  };
}

function recoveryFixture(bodyValue, digestCharacter = "a", attempts = 21) {
  const body = JSON.stringify(bodyValue);
  const digest = digestCharacter.repeat(64);
  const id = `r2:${digest}`;
  const key = `recovery/ingest-quarantine/${digest}.json`;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return {
    body,
    bodyHash,
    digest,
    id,
    key,
    object: {
      key,
      size: Buffer.byteLength(body),
      uploaded: new Date("2026-08-07T02:03:04.000Z"),
      customMetadata: {
        kind: "driftglass-ingest-quarantine-v1",
        bodySha256: bodyHash,
        attempts: String(attempts),
      },
      async text() { return body; },
    },
  };
}

function insertTrackedEmailState(database, input) {
  database.prepare(
    `INSERT INTO sources(id, name, kind, config_json, created_at, updated_at)
     VALUES (?, 'Email fixture', 'email', '{}', ?, ?)`,
  ).run(input.sourceId, input.at, input.at);
  database.prepare(
    `INSERT INTO source_runs(
       id, source_id, started_at, status, item_count, provider,
       collection_finished_at, enqueued_count, ingest_updated_at
     ) VALUES (?, ?, ?, 'queued', 1, 'email', ?, 1, ?)`,
  ).run(input.runId, input.sourceId, input.at, input.at, input.at);
  database.prepare(
    `INSERT INTO inbox_receipts(
       id, source_id, message_id, dedupe_key, received_at, last_received_at,
       item_count, outcome, queue_state, queue_claim_token, queue_claimed_at,
       metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, 1, 'queued', 'queued', ?, ?, '{}')`,
  ).run(
    input.claimToken,
    input.sourceId,
    input.messageId,
    `${input.sourceId}:${input.messageId.toLowerCase()}`,
    input.at,
    input.at,
    input.claimToken,
    input.at,
  );
}

function ownerActionEnv(d1, recovery, state = {}) {
  const sent = state.sent ?? [];
  const deleted = state.deleted ?? [];
  const gets = state.gets ?? [];
  const healthyQueue = { async metrics() { return { backlogCount: 0, backlogBytes: 0 }; } };
  return {
    DB: d1,
    EVIDENCE: {
      async list() {
        if (state.onList) await state.onList();
        return { objects: state.recoveryObjects ?? [recovery.object], truncated: false };
      },
      async get(requested) {
        gets.push(requested);
        assert.equal(requested, recovery.key);
        return recovery.object;
      },
      async delete(requested) {
        if (state.onDelete) await state.onDelete(requested);
        deleted.push(requested);
      },
    },
    INGEST_QUEUE: {
      async metrics() {
        if (state.primaryError) throw state.primaryError;
        return state.primaryMetrics ?? { backlogCount: 0, backlogBytes: 0 };
      },
      async sendBatch(messages) { sent.push(...messages); },
    },
    INGEST_DLQ: healthyQueue,
    INGEST_QUARANTINE: healthyQueue,
    INGEST_QUEUE_NAME: "driftglass-staging-ingest",
    INGEST_DLQ_NAME: "driftglass-staging-ingest-dlq",
    INGEST_QUARANTINE_NAME: "driftglass-staging-ingest-quarantine",
    DRIFTGLASS_SECRET: "owner-secret-longer-than-twenty-four-characters",
  };
}

function insertDeadLetter(database, {
  id,
  queueMessageId = `queue-${id}`,
  status = "unresolved",
  createdAt = "2026-08-07T00:00:00.000Z",
  title = id,
}) {
  const body = JSON.stringify({ sourceId: "manual-inbox", provider: "manual", item: { title } });
  const bodyHash = createHash("sha256").update(body).digest("hex");
  database.prepare(
    `INSERT INTO ingest_dead_letters(
       id, queue_message_id, queue_name, source_id, provider, attempts, reason,
       body_json, body_hash, body_bytes, status, created_at, resolved_at
     ) VALUES (?, ?, 'fixture-dlq', 'manual-inbox', 'manual', 4, 'fixture',
               ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    queueMessageId,
    body,
    bodyHash,
    Buffer.byteLength(body),
    status,
    createdAt,
    status === "unresolved" ? null : createdAt,
  );
  return body;
}

async function ownerAction(env, id, action) {
  return handleApi(new Request(
    `https://driftglass.invalid/api/ingest/dead-letters/${encodeURIComponent(id)}/${action}`,
    { method: "POST", headers: { authorization: `Bearer ${env.DRIFTGLASS_SECRET}` } },
  ), env, { waitUntil() {} });
}

async function ownerList(env, limit = 100) {
  return handleApi(new Request(
    `https://driftglass.invalid/api/ingest/dead-letters?limit=${limit}`,
    { headers: { authorization: `Bearer ${env.DRIFTGLASS_SECRET}` } },
  ), env, { waitUntil() {} });
}

test("quarantine retries the normal private D1 dead-letter store before R2", async () => {
  const { database, d1 } = await databaseFixture();
  const fixture = quarantineMessage({
    sourceId: "missing-source",
    provider: "fixture",
    item: { title: "D1 recovery", text: "owner-private body", accessClass: "authenticated-local" },
  });
  let emergencyWrites = 0;
  await handleIngestQueueBatch(batch(fixture.message), queueEnv({
    DB: d1,
    EVIDENCE: { async put() { emergencyWrites += 1; throw new Error("must not write R2"); } },
  }));

  assert.equal(fixture.state.acked, 1);
  assert.deepEqual(fixture.state.retries, []);
  assert.equal(emergencyWrites, 0);
  const row = database.prepare("SELECT status, body_json, body_bytes FROM ingest_dead_letters").get();
  assert.equal(row.status, "unresolved");
  assert.match(row.body_json, /owner-private body/);
  assert.ok(row.body_bytes > 0);
});

test("D1 outage writes one deterministic private R2 incident and acknowledges", async () => {
  const writes = [];
  const fixture = quarantineMessage({
    sourceId: "missing-source",
    provider: "fixture",
    item: { title: "R2 recovery", text: "never expose this fallback body", accessClass: "authenticated-local" },
  });
  const unavailable = { prepare() { throw new Error("D1 unavailable"); } };
  await handleIngestQueueBatch(batch(fixture.message), queueEnv({
    DB: unavailable,
    EVIDENCE: {
      async put(key, value, options) {
        writes.push({ key, value, options });
        return { key };
      },
    },
  }));

  assert.equal(fixture.state.acked, 1);
  assert.deepEqual(fixture.state.retries, []);
  assert.equal(writes.length, 1);
  assert.match(writes[0].key, /^recovery\/ingest-quarantine\/[a-f0-9]{64}\.json$/);
  assert.equal(Buffer.byteLength(writes[0].value), Buffer.byteLength(JSON.stringify(fixture.message.body)));
  assert.ok(Buffer.byteLength(writes[0].value) <= 60_000);
  assert.deepEqual(writes[0].options.onlyIf, { etagDoesNotMatch: "*" });
  assert.equal(writes[0].options.customMetadata.kind, "driftglass-ingest-quarantine-v1");

  const replay = quarantineMessage(fixture.message.body, { id: fixture.message.id, attempts: 5 });
  await handleIngestQueueBatch(batch(replay.message), queueEnv({
    DB: unavailable,
    EVIDENCE: { async put(key) { assert.equal(key, writes[0].key); return null; } },
  }));
  assert.equal(replay.state.acked, 1, "conditional already-stored result is durable success");
});

test("quarantine retries hourly when both D1 and R2 are unavailable", async () => {
  const fixture = quarantineMessage({ sourceId: "missing", item: { title: "both unavailable" } });
  await handleIngestQueueBatch(batch(fixture.message), queueEnv({
    DB: { prepare() { throw new Error("D1 unavailable"); } },
    EVIDENCE: { async put() { throw new Error("R2 unavailable"); } },
  }));
  assert.equal(fixture.state.acked, 0);
  assert.deepEqual(fixture.state.retries, [{ delaySeconds: 3_600 }]);
});

test("R2 lists are content-free and report the raw private-body size", async () => {
  const { d1 } = await databaseFixture();
  const recovery = recoveryFixture({
    sourceId: "missing-source",
    provider: "fixture",
    item: { title: "Private fallback", text: "secret fallback content", accessClass: "authenticated-local" },
  }, "a", 19);
  const env = {
    DB: d1,
    EVIDENCE: { async list() { return { objects: [recovery.object], truncated: false }; } },
  };

  const summaries = await listQuarantineRecoveries(env, "driftglass-staging-ingest-quarantine", 10);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, recovery.id);
  assert.equal(summaries[0].queue_message_id, recovery.id);
  assert.equal(summaries[0].attempts, 19);
  assert.equal(summaries[0].body_bytes, Buffer.byteLength(recovery.body));
  assert.equal(summaries[0].storage, "r2");
  assert.doesNotMatch(JSON.stringify(summaries), /Private fallback|secret fallback content|missing-source/);
});

test("merged owner list prioritizes unresolved history and suppresses a materialized R2 duplicate", async () => {
  const { database, d1 } = await databaseFixture();
  const recovery = recoveryFixture({
    sourceId: "materialized-list-source",
    provider: "fixture",
    item: { title: "Materialized duplicate", text: "private duplicate body", accessClass: "authenticated-local" },
  }, "7", 20);
  const env = ownerActionEnv(d1, recovery, { recoveryObjects: [recovery.object] });
  const materialized = await materializeQuarantineRecovery(env, recovery.id, env.INGEST_QUARANTINE_NAME);
  assert.equal(materialized.deadLetter.status, "unresolved");

  insertDeadLetter(database, {
    id: "old-actionable",
    createdAt: "2026-07-01T00:00:00.000Z",
    title: "old actionable private body",
  });
  const resolvedBase = Date.parse("2026-08-07T10:00:00.000Z");
  for (let index = 0; index < 105; index += 1) {
    insertDeadLetter(database, {
      id: `new-resolved-${index}`,
      status: "resolved",
      createdAt: new Date(resolvedBase + index * 1_000).toISOString(),
      title: `resolved private body ${index}`,
    });
  }

  const response = await ownerList(env, 100);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.deadLetters.length, 100);
  assert.ok(payload.deadLetters.some((record) => record.id === "old-actionable"));
  const firstResolved = payload.deadLetters.findIndex((record) => record.status !== "unresolved");
  assert.ok(firstResolved >= 2);
  assert.equal(payload.deadLetters.slice(0, firstResolved).every((record) => record.status === "unresolved"), true);
  const logicalRecoveryRecords = payload.deadLetters.filter((record) => record.queue_message_id === recovery.id);
  assert.equal(logicalRecoveryRecords.length, 1, "D1 and R2 represent one logical incident");
  assert.equal(logicalRecoveryRecords[0].id, recovery.id, "the R2 identity remains actionable for eventual cleanup");
  assert.equal(logicalRecoveryRecords[0].storage, "r2");
  assert.doesNotMatch(JSON.stringify(payload), /private duplicate body|old actionable private body|resolved private body/);
});

test("D1 retry bypasses only the selected record while other durable incidents remain", async () => {
  const { database, d1 } = await databaseFixture();
  insertDeadLetter(database, { id: "selected-d1", title: "selected private recovery" });
  insertDeadLetter(database, { id: "other-d1", title: "other private recovery" });
  const placeholder = recoveryFixture({ sourceId: "unused", item: { title: "unused" } }, "6");
  const state = { sent: [], deleted: [], gets: [], recoveryObjects: [] };
  const env = ownerActionEnv(d1, placeholder, state);

  const retried = await ownerAction(env, "selected-d1", "retry");
  assert.equal(retried.status, 202);
  assert.equal(state.sent.length, 1);
  const completed = database.prepare(
    "SELECT status, body_json, body_bytes, retry_claim_token FROM ingest_dead_letters WHERE id = 'selected-d1'",
  ).get();
  assert.equal(completed.status, "resolved");
  assert.equal(completed.body_json, "{}");
  assert.equal(completed.body_bytes, 0);
  assert.equal(completed.retry_claim_token, null);
  assert.equal(
    database.prepare("SELECT status FROM ingest_dead_letters WHERE id = 'other-d1'").get().status,
    "unresolved",
    "retrying the selected incident does not mutate an independent durable incident",
  );
});

test("R2 retry first terminalizes tracked and Email state, then atomically archives before delete", async () => {
  const { database, d1 } = await databaseFixture();
  const tracked = {
    sourceId: "email-r2-retry",
    runId: "r2-retry-run",
    messageId: "<r2-retry@example.test>",
    claimToken: "r2-retry-claim",
    at: "2026-08-07T02:00:00.000Z",
  };
  insertTrackedEmailState(database, tracked);
  const recovery = recoveryFixture({
    sourceId: tracked.sourceId,
    sourceRunId: tracked.runId,
    sourceRunItemIndex: 0,
    provider: "cloudflare-email",
    emailReceiptClaim: { messageId: tracked.messageId, claimToken: tracked.claimToken },
    item: { title: "Owner retry", text: "private retry body", accessClass: "authenticated-local" },
  }, "e", 21);
  const state = {
    sent: [],
    deleted: [],
    onDelete() {
      const durable = database.prepare(
        "SELECT status, body_json, body_bytes FROM ingest_dead_letters WHERE queue_message_id = ?",
      ).get(recovery.id);
      assert.equal(durable.status, "resolved");
      assert.equal(durable.body_json, "{}");
      assert.equal(durable.body_bytes, 0);
    },
  };
  const env = ownerActionEnv(d1, recovery, state);

  const response = await ownerAction(env, recovery.id, "retry");
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.deadLetter.status, "resolved");
  assert.equal(payload.deadLetter.body_bytes, 0);
  assert.doesNotMatch(JSON.stringify(payload), /Owner retry|private retry body/);
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].body.sourceRunId, undefined);
  assert.equal(state.sent[0].body.sourceRunItemIndex, undefined);
  assert.deepEqual(state.sent[0].body.emailReceiptClaim, {
    messageId: tracked.messageId,
    claimToken: tracked.claimToken,
  });
  assert.deepEqual(state.deleted, [recovery.key]);

  const run = database.prepare(
    "SELECT status, failed_count, ingested_count, duplicate_count, last_ingest_error FROM source_runs WHERE id = ?",
  ).get(tracked.runId);
  assert.equal(run.status, "failed");
  assert.equal(run.failed_count, 1);
  assert.equal(run.ingested_count, 0);
  assert.equal(run.duplicate_count, 0);
  assert.match(run.last_ingest_error, /private R2 quarantine/);
  const receipt = database.prepare(
    "SELECT outcome FROM source_run_ingest_receipts WHERE run_id = ? AND item_index = 0",
  ).get(tracked.runId);
  assert.equal(receipt.outcome, "failed");
  const inbox = database.prepare(
    "SELECT queue_state, outcome FROM inbox_receipts WHERE id = ?",
  ).get(tracked.claimToken);
  assert.equal(inbox.queue_state, "failed");
  assert.equal(inbox.outcome, "queue-failed");
  const audit = database.prepare(
    `SELECT status, body_json, body_bytes, body_hash, attempts, reason
     FROM ingest_dead_letters WHERE queue_message_id = ?`,
  ).get(recovery.id);
  assert.equal(audit.status, "resolved");
  assert.equal(audit.body_json, "{}");
  assert.equal(audit.body_bytes, 0);
  assert.equal(audit.body_hash, recovery.bodyHash);
  assert.equal(audit.attempts, 21);
  assert.match(audit.reason, /tracking=terminalized/);
  assert.match(audit.reason, /email-claim-failed/);
  assert.match(audit.reason, new RegExp(`original_body_bytes=${Buffer.byteLength(recovery.body)}`));
  assert.match(audit.reason, /storage=r2/);
  assert.doesNotMatch(JSON.stringify(audit), /Owner retry|private retry body/);
});

test("R2 dismiss first terminalizes tracked and Email state, then archives ignored before delete", async () => {
  const { database, d1 } = await databaseFixture();
  const tracked = {
    sourceId: "email-r2-dismiss",
    runId: "r2-dismiss-run",
    messageId: "<r2-dismiss@example.test>",
    claimToken: "r2-dismiss-claim",
    at: "2026-08-07T03:00:00.000Z",
  };
  insertTrackedEmailState(database, tracked);
  const recovery = recoveryFixture({
    sourceId: tracked.sourceId,
    sourceRunId: tracked.runId,
    sourceRunItemIndex: 0,
    provider: "cloudflare-email",
    emailReceiptClaim: { messageId: tracked.messageId, claimToken: tracked.claimToken },
    item: { title: "Owner dismiss", text: "private dismissed body", accessClass: "authenticated-local" },
  }, "f", 20);
  const state = {
    sent: [],
    deleted: [],
    onDelete() {
      const durable = database.prepare(
        "SELECT status, body_json, body_bytes FROM ingest_dead_letters WHERE queue_message_id = ?",
      ).get(recovery.id);
      assert.equal(durable.status, "ignored");
      assert.equal(durable.body_json, "{}");
      assert.equal(durable.body_bytes, 0);
    },
  };
  const env = ownerActionEnv(d1, recovery, state);

  const response = await ownerAction(env, recovery.id, "dismiss");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.deadLetter.status, "ignored");
  assert.equal(payload.deadLetter.body_bytes, 0);
  assert.doesNotMatch(JSON.stringify(payload), /Owner dismiss|private dismissed body/);
  assert.deepEqual(state.sent, []);
  assert.deepEqual(state.deleted, [recovery.key]);
  const run = database.prepare("SELECT status, failed_count FROM source_runs WHERE id = ?").get(tracked.runId);
  assert.equal(run.status, "failed");
  assert.equal(run.failed_count, 1);
  const receipt = database.prepare(
    "SELECT outcome FROM source_run_ingest_receipts WHERE run_id = ? AND item_index = 0",
  ).get(tracked.runId);
  assert.equal(receipt.outcome, "failed");
  const inbox = database.prepare(
    "SELECT queue_state, outcome FROM inbox_receipts WHERE id = ?",
  ).get(tracked.claimToken);
  assert.equal(inbox.queue_state, "failed");
  assert.equal(inbox.outcome, "queue-failed");
  const audit = database.prepare(
    "SELECT status, body_json, body_bytes, reason FROM ingest_dead_letters WHERE queue_message_id = ?",
  ).get(recovery.id);
  assert.equal(audit.status, "ignored");
  assert.equal(audit.body_json, "{}");
  assert.equal(audit.body_bytes, 0);
  assert.match(audit.reason, /tracking=terminalized/);
  assert.match(audit.reason, /email-claim-failed/);
  assert.match(audit.reason, /storage=r2/);
});

test("missing or malformed run tracking still materializes a private recoverable body without false success", async () => {
  for (const fixture of [
    {
      label: "missing",
      digest: "b",
      body: {
        sourceId: "missing-r2-source",
        sourceRunId: "missing-r2-run",
        sourceRunItemIndex: 0,
        provider: "fixture",
        item: { title: "Missing run", text: "missing run private body", accessClass: "authenticated-local" },
      },
      reason: /tracking=run-missing/,
    },
    {
      label: "malformed",
      digest: "c",
      body: {
        sourceId: "malformed-r2-source",
        sourceRunId: "malformed-r2-run",
        provider: "fixture",
        item: { title: "Malformed run", text: "malformed run private body", accessClass: "authenticated-local" },
      },
      reason: /tracking=malformed/,
    },
  ]) {
    const { database, d1 } = await databaseFixture();
    if (fixture.label === "malformed") {
      database.prepare(
        "INSERT INTO sources(id, name, kind, config_json) VALUES (?, 'Malformed', 'manual', '{}')",
      ).run(fixture.body.sourceId);
      database.prepare(
        `INSERT INTO source_runs(
           id, source_id, started_at, status, item_count, collection_finished_at, enqueued_count
         ) VALUES (?, ?, '2026-08-07T04:00:00.000Z', 'queued', 1, '2026-08-07T04:00:01.000Z', 1)`,
      ).run(fixture.body.sourceRunId, fixture.body.sourceId);
    }
    const recovery = recoveryFixture(fixture.body, fixture.digest, 20);
    const env = ownerActionEnv(d1, recovery, { sent: [], deleted: [] });
    const materialized = await materializeQuarantineRecovery(
      env,
      recovery.id,
      env.INGEST_QUARANTINE_NAME,
    );

    assert.equal(materialized.deadLetter.status, "unresolved", fixture.label);
    assert.match(materialized.deadLetter.reason, fixture.reason, fixture.label);
    assert.equal(materialized.deadLetter.body_bytes, Buffer.byteLength(recovery.body), fixture.label);
    assert.doesNotMatch(JSON.stringify(materialized), /private body|Missing run|Malformed run/, fixture.label);
    const privateRecord = database.prepare(
      "SELECT status, body_json, body_bytes FROM ingest_dead_letters WHERE queue_message_id = ?",
    ).get(recovery.id);
    assert.equal(privateRecord.status, "unresolved", fixture.label);
    assert.equal(privateRecord.body_json, recovery.body, fixture.label);
    assert.equal(privateRecord.body_bytes, Buffer.byteLength(recovery.body), fixture.label);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM source_run_ingest_receipts").get().count,
      0,
      fixture.label,
    );
    if (fixture.label === "malformed") {
      assert.equal(
        database.prepare("SELECT status FROM source_runs WHERE id = ?").get(fixture.body.sourceRunId).status,
        "queued",
      );
    }
  }
});

test("R2 recovery body is never deleted when D1 materialization fails", async () => {
  const { d1 } = await databaseFixture();
  const recovery = recoveryFixture({
    sourceId: "untracked-r2",
    provider: "fixture",
    item: { title: "Keep private", text: "must survive D1 failure", accessClass: "authenticated-local" },
  }, "d", 20);
  const failingD1 = {
    prepare(query) {
      if (query.includes("INSERT INTO ingest_dead_letters")) throw new Error("D1 materialization unavailable");
      return d1.prepare(query);
    },
    async batch(statements) { return d1.batch(statements); },
  };
  const state = { sent: [], deleted: [] };
  const env = ownerActionEnv(failingD1, recovery, state);
  await assert.rejects(ownerAction(env, recovery.id, "dismiss"), /D1 materialization unavailable/);
  assert.deepEqual(state.deleted, []);
});

test("D1 and R2 retries leave private bodies untouched when primary Queue health is unavailable or stale", async () => {
  const unhealthyPrimaryCases = [
    {
      label: "unavailable",
      state: { primaryError: new Error("primary metrics unavailable") },
      code: "INGEST_DLQ_UNAVAILABLE",
    },
    {
      label: "stale",
      state: {
        primaryMetrics: {
          backlogCount: 1,
          backlogBytes: 100,
          oldestMessageTimestamp: Date.now() - 11 * 60_000,
        },
      },
      code: "INGEST_PRIMARY_STALE",
    },
  ];

  for (const primary of unhealthyPrimaryCases) {
    const { database, d1 } = await databaseFixture();
    const id = `d1-primary-${primary.label}`;
    const originalBody = insertDeadLetter(database, { id, title: `D1 ${primary.label} private body` });
    const placeholder = recoveryFixture({
      sourceId: "unused",
      item: { title: "unused" },
    }, primary.label === "unavailable" ? "4" : "5");
    const state = {
      sent: [],
      deleted: [],
      gets: [],
      recoveryObjects: [],
      ...primary.state,
    };
    const env = ownerActionEnv(d1, placeholder, state);

    await assert.rejects(
      ownerAction(env, id, "retry"),
      (error) => error?.details?.code === primary.code,
      `D1 ${primary.label}`,
    );
    const stored = database.prepare(
      "SELECT status, body_json, body_bytes, retry_claim_token FROM ingest_dead_letters WHERE id = ?",
    ).get(id);
    assert.equal(stored.status, "unresolved", primary.label);
    assert.equal(stored.body_json, originalBody, primary.label);
    assert.equal(stored.body_bytes, Buffer.byteLength(originalBody), primary.label);
    assert.equal(stored.retry_claim_token, null, primary.label);
    assert.deepEqual(state.sent, [], primary.label);
    assert.deepEqual(state.deleted, [], primary.label);
    assert.deepEqual(state.gets, [], primary.label);
  }

  for (const primary of unhealthyPrimaryCases) {
    const { database, d1 } = await databaseFixture();
    const recovery = recoveryFixture({
      sourceId: `r2-primary-${primary.label}`,
      provider: "fixture",
      item: {
        title: `R2 ${primary.label}`,
        text: `R2 ${primary.label} private body`,
        accessClass: "authenticated-local",
      },
    }, primary.label === "unavailable" ? "2" : "3");
    const state = {
      sent: [],
      deleted: [],
      gets: [],
      recoveryObjects: [recovery.object],
      ...primary.state,
    };
    const env = ownerActionEnv(d1, recovery, state);

    await assert.rejects(
      ownerAction(env, recovery.id, "retry"),
      (error) => error?.details?.code === primary.code,
      `R2 ${primary.label}`,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ingest_dead_letters").get().count, 0);
    assert.deepEqual(state.sent, [], primary.label);
    assert.deepEqual(state.deleted, [], primary.label);
    assert.deepEqual(state.gets, [], "health rejection happens before the private R2 body is read");
  }
});

test("terminal R2 cleanup neither resends nor regresses a reconciled Email receipt", async () => {
  const { database, d1 } = await databaseFixture();
  const tracked = {
    sourceId: "email-r2-cleanup",
    runId: "r2-cleanup-run",
    messageId: "<r2-cleanup@example.test>",
    claimToken: "r2-cleanup-claim",
    at: "2026-08-07T05:00:00.000Z",
  };
  insertTrackedEmailState(database, tracked);
  const recovery = recoveryFixture({
    sourceId: tracked.sourceId,
    sourceRunId: tracked.runId,
    sourceRunItemIndex: 0,
    provider: "cloudflare-email",
    emailReceiptClaim: { messageId: tracked.messageId, claimToken: tracked.claimToken },
    item: { title: "Cleanup retry", text: "private cleanup body", accessClass: "authenticated-local" },
  }, "9", 20);
  let deleteAttempts = 0;
  const state = {
    sent: [],
    deleted: [],
    onDelete() {
      deleteAttempts += 1;
      if (deleteAttempts === 1) throw new Error("R2 delete response unavailable");
    },
  };
  const env = ownerActionEnv(d1, recovery, state);

  await assert.rejects(ownerAction(env, recovery.id, "retry"), /R2 delete response unavailable/);
  assert.equal(state.sent.length, 1);
  assert.equal(
    database.prepare("SELECT status FROM ingest_dead_letters WHERE queue_message_id = ?").get(recovery.id).status,
    "resolved",
  );
  database.prepare(
    "UPDATE inbox_receipts SET queue_state = 'queued', outcome = 'queued' WHERE id = ?",
  ).run(tracked.claimToken);

  const cleanup = await ownerAction(env, recovery.id, "retry");
  assert.equal(cleanup.status, 200);
  const payload = await cleanup.json();
  assert.equal(payload.cleanupOnly, true);
  assert.equal(payload.queued, 0);
  assert.equal(payload.deadLetter.status, "resolved");
  assert.equal(state.sent.length, 1, "cleanup must not dispatch a second recovery");
  assert.deepEqual(state.deleted, [recovery.key]);
  const inbox = database.prepare(
    "SELECT queue_state, outcome FROM inbox_receipts WHERE id = ?",
  ).get(tracked.claimToken);
  assert.equal(inbox.queue_state, "queued");
  assert.equal(inbox.outcome, "queued");
});

test("R2 actions reject an integrity mismatch without D1 materialization or deletion", async () => {
  const { database, d1 } = await databaseFixture();
  const recovery = recoveryFixture({
    sourceId: "integrity-r2",
    provider: "fixture",
    item: { title: "Integrity", text: "private integrity body", accessClass: "authenticated-local" },
  }, "8", 20);
  recovery.object.customMetadata.bodySha256 = "0".repeat(64);
  const state = { sent: [], deleted: [] };
  const env = ownerActionEnv(d1, recovery, state);

  await assert.rejects(ownerAction(env, recovery.id, "dismiss"), /failed its integrity check/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ingest_dead_letters").get().count, 0);
  assert.deepEqual(state.deleted, []);
});
