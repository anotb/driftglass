import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  INGEST_QUEUE_BATCH_MAX_BYTES,
  INGEST_QUEUE_BATCH_MAX_MESSAGES,
  INGEST_QUEUE_MESSAGE_MAX_BYTES,
  enqueueIngestMessages,
  enqueueRecoveryIngestMessage,
  IngestQueueSendError,
  linkedPublicRawR2Key,
  prepareQueueSafeIngestMessage,
  serializedIngestBatchBytes,
  serializedIngestMessageBytes,
  truncateUtf8,
  utf8ByteLength,
} = require("../.test-dist/ingest-queue.js");

function unlimitedBudgetDatabase({ initialQueueUsage = 0, unresolvedDeadLetters = 0 } = {}) {
  const usage = new Map();
  if (initialQueueUsage > 0) usage.set(`${new Date().toISOString().slice(0, 10)}:queue_messages`, initialQueueUsage);
  return {
    used(dimension) {
      return [...usage.entries()].filter(([key]) => key.endsWith(`:${dimension}`)).reduce((sum, [, units]) => sum + Number(units), 0);
    },
    prepare(query) {
      let values = [];
      return {
        bind(...input) {
          values = input;
          return this;
        },
        async all() {
          if (query.includes("SELECT key, value FROM settings")) {
            return { success: true, results: [], meta: {} };
          }
          throw new Error(`Unexpected budget all query: ${query}`);
        },
        async first() {
          if (query.includes("FROM ingest_dead_letters")) return { count: unresolvedDeadLetters };
          if (query.includes("SELECT value FROM settings")) return null;
          if (query.includes("SELECT units FROM usage_daily")) {
            const units = usage.get(`${values[0]}:${values[1]}`);
            return units === undefined ? null : { units };
          }
          throw new Error(`Unexpected budget first query: ${query}`);
        },
        async run() {
          if (!query.includes("INSERT INTO usage_daily")) throw new Error(`Unexpected budget run query: ${query}`);
          const [day, dimension, units, _metadata, _updatedAt, limit] = values;
          const key = `${day}:${dimension}`;
          const next = Number(usage.get(key) ?? 0) + Number(units);
          if (next > Number(limit)) return { meta: { changes: 0 } };
          usage.set(key, next);
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

function recordingEnv({
  sendError,
  sendErrorAt,
  putErrorAt,
  deadLetterBacklog = 0,
  quarantineBacklog = 0,
  initialQueueUsage = 0,
  unresolvedDeadLetters = 0,
} = {}) {
  const puts = [];
  const deletes = [];
  const batches = [];
  const database = unlimitedBudgetDatabase({ initialQueueUsage, unresolvedDeadLetters });
  return {
    puts,
    deletes,
    batches,
    database,
    env: {
      DB: database,
      EVIDENCE: {
        async list() {
          return { objects: [], truncated: false };
        },
        async put(key, value, options) {
          puts.push({ key, value, options });
          if (puts.length === putErrorAt) throw new Error("R2 unavailable");
          return { key };
        },
        async delete(keys) {
          deletes.push(Array.isArray(keys) ? keys : [keys]);
        },
      },
      INGEST_QUEUE: {
        async metrics() {
          return { backlogCount: 0, backlogBytes: 0 };
        },
        async sendBatch(requests) {
          const batch = [...requests];
          batches.push(batch);
          if (sendError || batches.length === sendErrorAt) throw sendError ?? new Error("queue unavailable");
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      },
      INGEST_DLQ: {
        async metrics() {
          return { backlogCount: deadLetterBacklog, backlogBytes: deadLetterBacklog * 100, oldestMessageTimestamp: Date.now() };
        },
      },
      INGEST_QUARANTINE: {
        async metrics() {
          return { backlogCount: quarantineBacklog, backlogBytes: quarantineBacklog * 100, oldestMessageTimestamp: Date.now() };
        },
      },
    },
  };
}

test("the 445,179-byte starter web payload stores full public raw in R2 and queues a bounded linked message", async () => {
  const fixture = recordingEnv();
  const raw = "r".repeat(445_179);
  await enqueueIngestMessages(fixture.env, [{
    sourceId: "starter-cloudflare-ai-changelog",
    provider: "direct-fetch",
    item: {
      url: "https://developers.cloudflare.com/changelog/product-group/ai/",
      title: "Cloudflare AI changelog",
      text: raw,
      raw,
      observedAt: "2026-08-07T12:00:00.000Z",
      metadata: { platform: "web", contentLength: raw.length },
    },
  }]);

  assert.equal(fixture.puts.length, 1);
  assert.equal(fixture.puts[0].value, raw, "R2 receives the complete public capture");
  assert.equal(utf8ByteLength(fixture.puts[0].value), 445_179);
  assert.equal(fixture.batches.length, 1);
  const request = fixture.batches[0][0];
  assert.equal(request.contentType, "json");
  assert.equal(request.body.rawR2Key, fixture.puts[0].key);
  assert.equal(linkedPublicRawR2Key(request.body), fixture.puts[0].key);
  assert.equal(Object.hasOwn(request.body.item, "raw"), false);
  assert.ok(serializedIngestMessageBytes(request.body) <= INGEST_QUEUE_MESSAGE_MAX_BYTES);
  assert.equal(request.body.preparation.originalTextBytes, 445_179);
  assert.equal(request.body.preparation.textTruncated, true);
  assert.equal(request.body.preparation.originalRawBytes, 445_179);
  assert.equal(request.body.preparation.rawDisposition, "stored-public-r2");
});

test("queue preparation truncates on UTF-8 boundaries, bounds metadata, and is deterministic", () => {
  const input = {
    sourceId: "unicode-source",
    provider: "fixture",
    item: {
      title: "Unicode fixture",
      text: `${"😀".repeat(40_000)}END`,
      metadata: {
        watchTerms: ["agents", "cloudflare"],
        oversized: "界".repeat(40_000),
      },
    },
  };
  const key = "raw/2026-08-07/unicode-source/123e4567-e89b-12d3-a456-426614174000.txt";
  const first = prepareQueueSafeIngestMessage(input, key);
  const second = prepareQueueSafeIngestMessage(input, key);

  assert.deepEqual(first, second);
  assert.ok(serializedIngestMessageBytes(first) <= INGEST_QUEUE_MESSAGE_MAX_BYTES);
  assert.equal(first.item.text.includes("�"), false);
  assert.equal(first.preparation.textTruncated, true);
  assert.equal(first.preparation.metadataTruncated, true);
  assert.ok(first.preparation.queuedMetadataBytes < first.preparation.originalMetadataBytes);
  assert.deepEqual(first.item.metadata.watchTerms, ["agents", "cloudflare"]);
  assert.equal(truncateUtf8("a😀b", 5), "a😀");
  assert.equal(utf8ByteLength(truncateUtf8("😀😀", 7)), 4);
});

test("restricted raw bodies are never written or linked", async () => {
  for (const accessClass of ["authenticated-local", "subscriber-local", "private"]) {
    const fixture = recordingEnv();
    await enqueueIngestMessages(fixture.env, [{
      sourceId: `restricted-${accessClass}`,
      item: {
        title: "Restricted fixture",
        text: "bounded evidence",
        raw: "subscriber-only body".repeat(10_000),
        accessClass,
      },
    }]);
    assert.equal(fixture.puts.length, 0);
    const message = fixture.batches[0][0].body;
    assert.equal(message.rawR2Key, undefined);
    assert.equal(linkedPublicRawR2Key(message), undefined);
    assert.equal(Object.hasOwn(message.item, "raw"), false);
    assert.equal(message.preparation.rawDisposition, "discarded-restricted");
  }
});

test("the shared sender packs every sendBatch below count and aggregate byte limits", async () => {
  const fixture = recordingEnv();
  const inputs = Array.from({ length: 12 }, (_, index) => ({
    sourceId: "batch-source",
    provider: "fixture",
    item: {
      externalId: String(index),
      title: `Large item ${index}`,
      text: "x".repeat(200_000),
      metadata: { index },
    },
  }));
  await enqueueIngestMessages(fixture.env, inputs);

  assert.ok(fixture.batches.length > 1);
  assert.equal(fixture.batches.flat().length, inputs.length);
  for (const requests of fixture.batches) {
    const messages = requests.map((request) => request.body);
    assert.ok(requests.length <= INGEST_QUEUE_BATCH_MAX_MESSAGES);
    assert.ok(serializedIngestBatchBytes(messages) <= INGEST_QUEUE_BATCH_MAX_BYTES);
    assert.ok(messages.every((message) => serializedIngestMessageBytes(message) <= INGEST_QUEUE_MESSAGE_MAX_BYTES));
    assert.ok(requests.every((request) => request.contentType === "json"));
  }
});

test("a failed Queue write removes uniquely staged raw objects", async () => {
  const queueError = new Error("queue unavailable");
  const fixture = recordingEnv({ sendError: queueError });
  await assert.rejects(
    enqueueIngestMessages(fixture.env, [
      { sourceId: "public-a", item: { title: "A", raw: "full raw A" } },
      { sourceId: "public-b", item: { title: "B", raw: "full raw B" } },
    ]),
    (error) => error instanceof IngestQueueSendError && error.sentCount === 0 && error.cause === queueError,
  );

  assert.equal(fixture.puts.length, 2);
  assert.deepEqual(fixture.deletes.flat().sort(), fixture.puts.map((put) => put.key).sort());
});

test("durability preflight blocks before Queue budget reservation or R2 staging", async () => {
  const fixture = recordingEnv({ deadLetterBacklog: 1 });
  await assert.rejects(
    enqueueIngestMessages(fixture.env, [{ sourceId: "manual-inbox", item: { title: "blocked", raw: "raw" }, provider: "manual" }]),
    (error) => error?.details?.code === "INGEST_DLQ_BLOCKED",
  );
  assert.equal(fixture.database.used("queue_messages"), 0);
  assert.equal(fixture.puts.length, 0);
  assert.equal(fixture.batches.length, 0);
});

test("an unresolved D1 dead letter blocks normal producers before Queue budget or R2", async () => {
  const fixture = recordingEnv({ unresolvedDeadLetters: 1 });
  await assert.rejects(
    enqueueIngestMessages(fixture.env, [{ sourceId: "manual-inbox", item: { title: "blocked", raw: "raw" }, provider: "manual" }]),
    (error) => error?.details?.code === "INGEST_DLQ_BLOCKED" && error?.details?.unresolvedDeadLetters === 1,
  );
  assert.equal(fixture.database.used("queue_messages"), 0);
  assert.equal(fixture.puts.length, 0);
  assert.equal(fixture.batches.length, 0);
});

test("the central sender reserves Queue budget for source, Manual, Email, and Companion producers", async () => {
  const fixture = recordingEnv();
  for (const [sourceId, provider] of [
    ["cloud-source", "lobsters-json"],
    ["manual-inbox", "manual"],
    ["email-inbox", "cloudflare-email"],
    ["companion-source", "driftglass-relay"],
  ]) {
    await enqueueIngestMessages(fixture.env, [{ sourceId, provider, item: { title: `${provider} fixture` } }]);
  }
  assert.equal(fixture.database.used("queue_messages"), 4);
  assert.equal(fixture.batches.flat().length, 4);
});

test("dead-letter recovery preserves only managed raw lineage and strips stale run tracking", async () => {
  const fixture = recordingEnv({ unresolvedDeadLetters: 1 });
  const rawR2Key = "raw/2026-08-07/manual-inbox/123e4567-e89b-12d3-a456-426614174000.txt";
  const preparation = {
    version: 1,
    queueMessageLimitBytes: INGEST_QUEUE_MESSAGE_MAX_BYTES,
    originalTextBytes: 200_000,
    queuedTextBytes: 40_000,
    textTruncated: true,
    originalMetadataBytes: 20,
    queuedMetadataBytes: 20,
    metadataTruncated: false,
    originalRawBytes: 200_000,
    rawDisposition: "stored-public-r2",
  };
  await enqueueRecoveryIngestMessage(fixture.env, {
    sourceId: "manual-inbox",
    provider: "manual",
    sourceRunId: "deleted-run",
    sourceRunItemIndex: 0,
    rawR2Key,
    preparation,
    item: { title: "Recovered public item", text: "bounded recovery text", metadata: {} },
  });
  const recovered = fixture.batches[0][0].body;
  assert.equal(recovered.rawR2Key, rawR2Key);
  assert.deepEqual(recovered.preparation, preparation);
  assert.equal(recovered.sourceRunId, undefined);
  assert.equal(recovered.sourceRunItemIndex, undefined);
  assert.equal(fixture.puts.length, 0, "the existing managed raw object is linked, not restaged");
  assert.equal(fixture.database.used("queue_messages"), 1);

  const invalid = recordingEnv();
  await enqueueRecoveryIngestMessage(invalid.env, {
    sourceId: "manual-inbox",
    provider: "manual",
    rawR2Key: "raw/2026-08-07/other-source/123e4567-e89b-12d3-a456-426614174000.txt",
    preparation,
    item: { title: "Invalid key fixture", text: "bounded" },
  });
  assert.equal(invalid.batches[0][0].body.rawR2Key, undefined);
  assert.notDeepEqual(invalid.batches[0][0].body.preparation, preparation);
});

test("budget or preparation failure cannot publish queued intent", async () => {
  let budgetCallback = 0;
  const exhausted = recordingEnv({ initialQueueUsage: 2_500 });
  await assert.rejects(
    enqueueIngestMessages(exhausted.env, [{ sourceId: "source", item: { title: "budget" } }], {
      beforeSend: async () => { budgetCallback += 1; },
    }),
    (error) => error?.name === "BudgetDeferredError" && error?.dimension === "queue_messages",
  );
  assert.equal(budgetCallback, 0);
  assert.equal(exhausted.batches.length, 0);

  let preparationCallback = 0;
  const preparation = recordingEnv({ putErrorAt: 1 });
  await assert.rejects(
    enqueueIngestMessages(preparation.env, [{ sourceId: "source", item: { title: "prepare", raw: "raw" } }], {
      beforeSend: async () => { preparationCallback += 1; },
    }),
    /Unable to stage public raw evidence/,
  );
  assert.equal(preparationCallback, 0);
  assert.equal(preparation.batches.length, 0);
});

test("queued intent is recorded after all preparation and partial multi-batch sends report the durable count", async () => {
  const fixture = recordingEnv({ sendErrorAt: 2 });
  let callbackState;
  const inputs = Array.from({ length: 12 }, (_, index) => ({
    sourceId: "batch-source",
    provider: "fixture",
    item: { title: `item ${index}`, text: "x".repeat(200_000), raw: `raw ${index}` },
  }));
  await assert.rejects(
    enqueueIngestMessages(fixture.env, inputs, {
      beforeSend: async (messageCount) => {
        callbackState = { messageCount, puts: fixture.puts.length, batches: fixture.batches.length };
      },
    }),
    (error) => error instanceof IngestQueueSendError && error.sentCount > 0 && error.sentCount < error.totalCount,
  );
  assert.deepEqual(callbackState, { messageCount: 12, puts: 12, batches: 0 });
  assert.equal(fixture.database.used("queue_messages"), 12);
});

test("a later R2 staging failure cleans both the uncertain write and earlier unsent raw", async () => {
  const fixture = recordingEnv({ putErrorAt: 2 });
  await assert.rejects(
    enqueueIngestMessages(fixture.env, [
      { sourceId: "public-a", item: { title: "A", raw: "full raw A" } },
      { sourceId: "public-b", item: { title: "B", raw: "full raw B" } },
    ]),
    /Unable to stage public raw evidence/,
  );

  assert.equal(fixture.batches.length, 0);
  assert.deepEqual(fixture.deletes.flat().sort(), fixture.puts.map((put) => put.key).sort());
});
