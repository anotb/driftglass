import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { handleEmail, parseMimeMessage } = require("../.test-dist/email.js");
const { listInboxReceipts, reconcileInboxReceiptQueueClaim } = require("../.test-dist/db.js");

const migrationDirectory = new URL("../migrations/", import.meta.url);
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
const migrations = await Promise.all(migrationNames.map(async (name) => ({
  name,
  sql: await readFile(new URL(name, migrationDirectory), "utf8"),
})));

class SqliteD1Statement {
  constructor(database, query, beforeRun) {
    this.database = database;
    this.query = query;
    this.beforeRun = beforeRun;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    await this.beforeRun?.(this.query, this.values);
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }

  async first() {
    return this.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    return { success: true, results: this.database.prepare(this.query).all(...this.values), meta: {} };
  }
}

class SqliteD1 {
  constructor(database, beforeRun) {
    this.database = database;
    this.beforeRun = beforeRun;
  }

  prepare(query) {
    return new SqliteD1Statement(this.database, query, this.beforeRun);
  }
}

function migratedDatabase(upTo = migrations.length) {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations.slice(0, upTo)) database.exec(migration.sql);
  return database;
}

function mimeFixture(messageId = "<receipt-123@example.com>") {
  const pdfBytes = "SECRET ATTACHMENT BYTES";
  const pixelBytes = "INLINE PIXEL";
  const raw = [
    "From: sender@example.com",
    "To: save@example.com",
    "Subject: =?UTF-8?Q?Quarterly_signal?=",
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="driftglass-mix"',
    "",
    "--driftglass-mix",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Read https://example.com/report?utm_source=email",
    "--driftglass-mix",
    "Content-Type: application/pdf; name*=UTF-8''..%2Fquarterly%20report.pdf",
    "Content-Disposition: attachment; filename*=UTF-8''..%2Fquarterly%20report.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(pdfBytes).toString("base64"),
    "--driftglass-mix",
    'Content-Type: image/png; name="pixel.png"',
    'Content-Disposition: inline; filename="pixel.png"',
    "Content-ID: <pixel@example.com>",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(pixelBytes).toString("base64"),
    "--driftglass-mix--",
    "",
  ].join("\r\n");
  return { raw, pdfBytes, pixelBytes };
}

function emailMessage(raw, fallbackMessageId = "<receipt-123@example.com>") {
  const encoded = new TextEncoder().encode(raw);
  const headers = new Headers({ subject: "Quarterly signal" });
  if (fallbackMessageId) headers.set("message-id", fallbackMessageId);
  return {
    from: "sender@example.com",
    to: "save@example.com",
    headers,
    raw: new ReadableStream({ start(controller) { controller.enqueue(encoded); controller.close(); } }),
    rawSize: encoded.byteLength,
  };
}

function emailEnv(database, options = {}) {
  const batches = [];
  const evidenceWrites = [];
  return {
    batches,
    evidenceWrites,
    env: {
      DB: new SqliteD1(database, options.beforeRun),
      EVIDENCE: {
        async list() { return { objects: [], truncated: false }; },
        async put(...args) { evidenceWrites.push(args); },
        async delete() {},
      },
      INGEST_QUEUE: {
        async metrics() { return { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 }; },
        async sendBatch(requests) {
          batches.push([...requests]);
          if (options.sendBatch) return options.sendBatch(requests, batches.length);
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      },
      INGEST_DLQ: {
        async metrics() { return { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 }; },
      },
      INGEST_QUARANTINE: {
        async metrics() { return { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 }; },
      },
    },
  };
}

test("MIME parsing captures bounded attachment descriptors without decoding attachment content into evidence", () => {
  const fixture = mimeFixture();
  const parsed = parseMimeMessage(fixture.raw);

  assert.match(parsed.text, /https:\/\/example\.com\/report/);
  assert.deepEqual(parsed.attachments, [
    { filename: "quarterly report.pdf", contentType: "application/pdf", byteSize: Buffer.byteLength(fixture.pdfBytes) },
    { filename: "pixel.png", contentType: "image/png", byteSize: Buffer.byteLength(fixture.pixelBytes) },
  ]);
  assert.equal(parsed.attachmentCount, 2);
  assert.equal(parsed.attachmentsTruncated, false);
  assert.equal(parsed.parsingTruncated, false);
  assert.doesNotMatch(parsed.text, /SECRET ATTACHMENT BYTES|INLINE PIXEL/);
});

test("attachment metadata count is bounded even for many MIME parts", () => {
  const parts = Array.from({ length: 25 }, (_, index) => [
    "--many",
    `Content-Type: application/octet-stream; name="file-${index}.bin"`,
    `Content-Disposition: attachment; filename="file-${index}.bin"`,
    "Content-Transfer-Encoding: base64",
    "",
    "eA==",
  ].join("\r\n"));
  const raw = [
    "Content-Type: multipart/mixed; boundary=many",
    "",
    ...parts,
    "--many--",
    "",
  ].join("\r\n");
  const parsed = parseMimeMessage(raw);

  assert.equal(parsed.attachmentCount, 25);
  assert.equal(parsed.attachments.length, 20);
  assert.equal(parsed.attachmentsTruncated, true);
  assert.equal(parsed.parsingTruncated, true);
});

test("Message-ID delivery reuses one owner receipt, skips the second Queue write, and keeps email private", async () => {
  const database = migratedDatabase();
  const fixture = mimeFixture();
  const runtime = emailEnv(database);

  const first = await handleEmail(emailMessage(fixture.raw), runtime.env);
  const second = await handleEmail(emailMessage(fixture.raw), runtime.env);

  assert.equal(first.duplicate, false);
  assert.equal(first.queued, true);
  assert.equal(first.queueState, "queued");
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(second.duplicate, true);
  assert.equal(second.queued, false);
  assert.equal(second.deliveryCount, 2);
  assert.equal(second.outcome, "duplicate-reused");
  assert.equal(second.queueState, "queued");
  assert.equal(runtime.batches.length, 1);
  assert.equal(runtime.evidenceWrites.length, 0, "private email raw and attachment bytes never enter R2");

  const queued = runtime.batches[0][0].body;
  assert.equal(queued.item.accessClass, "private");
  assert.equal(queued.rawR2Key, undefined);
  assert.equal(queued.emailReceiptClaim.messageId, "<receipt-123@example.com>");
  assert.match(queued.emailReceiptClaim.claimToken, /^[0-9a-f-]{36}$/);
  assert.equal(queued.item.metadata.sender, "sender@example.com");
  assert.equal(queued.item.metadata.recipient, "save@example.com");
  assert.deepEqual(queued.item.metadata.attachments, [
    { filename: "quarterly report.pdf", contentType: "application/pdf", byteSize: Buffer.byteLength(fixture.pdfBytes) },
    { filename: "pixel.png", contentType: "image/png", byteSize: Buffer.byteLength(fixture.pixelBytes) },
  ]);
  const serializedQueueBody = JSON.stringify(queued);
  assert.doesNotMatch(serializedQueueBody, /SECRET ATTACHMENT BYTES|INLINE PIXEL/);
  assert.doesNotMatch(serializedQueueBody, new RegExp(Buffer.from(fixture.pdfBytes).toString("base64")));
  assert.equal(Object.hasOwn(queued.item.metadata, "emailReceiptClaim"), false);

  const receipts = await listInboxReceipts(runtime.env.DB);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].delivery_count, 2);
  assert.equal(receipts[0].outcome, "duplicate-reused");
  assert.equal(receipts[0].queue_state, "queued");
  assert.equal(JSON.parse(receipts[0].metadata_json).attachmentCount, 2);
});

test("concurrent Message-ID deliveries share one pending claim and never double-enqueue", async () => {
  const database = migratedDatabase();
  const fixture = mimeFixture("<concurrent@example.com>");
  let releaseQueue;
  let queueStarted;
  const queueGate = new Promise((resolve) => { releaseQueue = resolve; });
  const started = new Promise((resolve) => { queueStarted = resolve; });
  const runtime = emailEnv(database, {
    async sendBatch() {
      queueStarted();
      await queueGate;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  });

  const firstDelivery = handleEmail(emailMessage(fixture.raw), runtime.env);
  await started;
  await assert.rejects(
    handleEmail(emailMessage(fixture.raw), runtime.env),
    /pending Queue claim/,
  );
  assert.equal(runtime.batches.length, 1);

  releaseQueue();
  const first = await firstDelivery;
  assert.equal(first.queueState, "queued");
  const reused = await handleEmail(emailMessage(fixture.raw), runtime.env);
  assert.equal(reused.duplicate, true);
  assert.equal(reused.queued, false);
  assert.equal(reused.queueState, "queued");
  assert.equal(runtime.batches.length, 1);

  const receipts = await listInboxReceipts(runtime.env.DB);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].delivery_count, 3);
});

test("a failed Queue claim is owner-visible and exactly one retry may reclaim it", async () => {
  const database = migratedDatabase();
  const fixture = mimeFixture("<queue-retry@example.com>");
  let shouldFail = true;
  const runtime = emailEnv(database, {
    async sendBatch() {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("simulated Queue failure");
      }
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  });

  await assert.rejects(handleEmail(emailMessage(fixture.raw), runtime.env), /simulated Queue failure/);
  let receipts = await listInboxReceipts(runtime.env.DB);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].queue_state, "failed");
  assert.equal(receipts[0].outcome, "queue-failed");

  const retry = await handleEmail(emailMessage(fixture.raw), runtime.env);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.queued, true);
  assert.equal(retry.queueState, "queued");
  assert.equal(runtime.batches.length, 2);
  receipts = await listInboxReceipts(runtime.env.DB);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].delivery_count, 2);
  assert.equal(receipts[0].outcome, "duplicate-reused");
});

test("Queue success plus receipt-finalization failure self-heals from the accepted message without enqueueing twice", async () => {
  const database = migratedDatabase();
  const fixture = mimeFixture("<finalize-failure@example.com>");
  let completionFailures = 3;
  const runtime = emailEnv(database, {
    async beforeRun(query) {
      if (query.includes("SET queue_state = 'queued'") && completionFailures > 0) {
        completionFailures -= 1;
        throw new Error("simulated receipt finalization failure");
      }
    },
  });

  await assert.rejects(
    handleEmail(emailMessage(fixture.raw), runtime.env),
    /simulated receipt finalization failure/,
  );
  let receipts = await listInboxReceipts(runtime.env.DB);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].queue_state, "pending");
  assert.equal(runtime.batches.length, 1, "the Queue accepted exactly one message");

  const queued = runtime.batches[0][0].body;
  assert.equal(
    await reconcileInboxReceiptQueueClaim(
      runtime.env.DB,
      queued.sourceId,
      queued.emailReceiptClaim.messageId,
      queued.emailReceiptClaim.claimToken,
    ),
    true,
  );
  const retry = await handleEmail(emailMessage(fixture.raw), runtime.env);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.queued, false);
  assert.equal(retry.queueState, "queued");
  assert.equal(runtime.batches.length, 1, "a delivery retry must not duplicate the accepted Queue message");
  receipts = await listInboxReceipts(runtime.env.DB);
  assert.equal(receipts[0].queue_state, "queued");
  assert.equal(receipts[0].delivery_count, 2);
});

test("unkeyed mail keeps enqueue-then-receipt ordering and explicit outcomes", async () => {
  const database = migratedDatabase();
  const raw = [
    "From: sender@example.com",
    "To: save@example.com",
    "Subject: Unkeyed signal",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "No Message-ID here.",
  ].join("\r\n");
  const failedRuntime = emailEnv(database, {
    async sendBatch() { throw new Error("unkeyed Queue failure"); },
  });

  await assert.rejects(
    handleEmail(emailMessage(raw, null), failedRuntime.env),
    /unkeyed Queue failure/,
  );
  assert.equal((await listInboxReceipts(failedRuntime.env.DB)).length, 0, "a failed Queue send must not create a false receipt");

  const runtime = emailEnv(database);
  const first = await handleEmail(emailMessage(raw, null), runtime.env);
  const second = await handleEmail(emailMessage(raw, null), runtime.env);
  assert.equal(first.outcome, "queued-unkeyed");
  assert.equal(second.outcome, "queued-unkeyed");
  assert.equal(first.queueState, "unkeyed");
  assert.equal(second.queueState, "unkeyed");
  assert.equal(runtime.batches.length, 2);
  assert.equal((await listInboxReceipts(runtime.env.DB)).length, 2);
});

test("migration 18 preserves legacy duplicate receipts and marks one canonical Message-ID row", () => {
  const database = migratedDatabase(17);
  database.prepare("INSERT INTO sources(id, name, kind) VALUES (?, ?, ?)").run("email-inbox", "Email inbox", "email");
  const insert = database.prepare(`INSERT INTO inbox_receipts(
    id, source_id, message_id, sender, received_at, item_count, metadata_json
  ) VALUES (?, 'email-inbox', ?, 'sender@example.com', ?, 1, '{}')`);
  insert.run("legacy-1", "<Legacy@Example.com>", "2026-08-07T10:00:00.000Z");
  insert.run("legacy-2", "<legacy@example.com>", "2026-08-07T10:01:00.000Z");

  database.exec(migrations[17].sql);
  const rows = database.prepare("SELECT * FROM inbox_receipts ORDER BY received_at").all();
  assert.equal(rows.length, 2, "migration retains historical receipt rows");
  assert.equal(rows[0].delivery_count, 2);
  assert.equal(rows[0].outcome, "duplicate-reused");
  assert.equal(rows[0].queue_state, "queued");
  assert.equal(rows[0].queue_claim_token, null);
  assert.match(rows[0].dedupe_key, /email-inbox:<legacy@example\.com>/);
  assert.equal(rows[1].dedupe_key, null);
  assert.equal(rows[1].outcome, "legacy-duplicate");
  assert.equal(rows[1].queue_state, "queued");
  assert.equal(database.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, "18");
});
