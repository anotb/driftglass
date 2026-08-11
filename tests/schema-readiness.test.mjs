import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { ensureQueueSchema, ensureSchema } = require("../.test-dist/schema.js");
const { handleIngestQueueBatch } = require("../.test-dist/ingest-consumer.js");

class SchemaStatement {
  constructor(version, query) {
    this.version = version;
    this.query = query;
  }

  bind() { return this; }

  async first() {
    if (this.query.includes("sqlite_master")) {
      return this.version > 0 ? { name: "settings" } : null;
    }
    if (this.query.includes("schema_version")) {
      return { value: String(this.version) };
    }
    throw new Error(`Unexpected schema query: ${this.query}`);
  }
}

class SchemaDatabase {
  constructor(version) {
    this.version = version;
    this.execCalls = 0;
    this.prepareQueries = [];
  }

  prepare(query) {
    this.prepareQueries.push(query);
    return new SchemaStatement(this.version, query);
  }

  async exec() {
    this.execCalls += 1;
    throw new Error("request-time schema mutation is forbidden");
  }
}

test("request startup verifies Wrangler-applied schema without executing migrations", async () => {
  const empty = new SchemaDatabase(0);
  await assert.rejects(
    ensureSchema(empty),
    (error) => error?.status === 503 && error?.details?.current === 0 && error?.details?.expected === 23,
  );
  assert.equal(empty.execCalls, 0);

  const ready = new SchemaDatabase(23);
  assert.equal(await ensureSchema(ready), 23);
  assert.equal(ready.execCalls, 0);
});

test("concurrent cold schema checks keep D1 I/O request-local and cache only the resolved version", async () => {
  const releases = [];
  const database = new SchemaDatabase(23);
  database.prepare = (query) => {
    database.prepareQueries.push(query);
    const statement = new SchemaStatement(database.version, query);
    if (!query.includes("sqlite_master")) return statement;
    return {
      async first() {
        return new Promise((resolve) => {
          releases.push(() => resolve({ name: "settings" }));
        });
      },
    };
  };

  const first = ensureSchema(database);
  const second = ensureSchema(database);

  assert.equal(releases.length, 2, "each cold request starts its own D1 lookup");
  for (const release of releases) release();
  assert.deepEqual(await Promise.all([first, second]), [23, 23]);
  assert.equal(database.prepareQueries.filter((query) => query.includes("schema_version")).length, 2);

  const queryCount = database.prepareQueries.length;
  assert.equal(await ensureSchema(database), 23);
  assert.equal(database.prepareQueries.length, queryCount, "a resolved primitive serves later checks");
});

test("Queue delivery delays the whole batch while deploy-time migrations are pending", async () => {
  const pending = new SchemaDatabase(18);
  const retries = [];
  const ready = await ensureQueueSchema(pending, {
    retryAll(options) {
      retries.push(options);
    },
  });
  assert.equal(ready, false);
  assert.deepEqual(retries, [{ delaySeconds: 60 }]);
  assert.equal(pending.execCalls, 0);
});

test("failure Queues preserve their emergency path on D1 outage while only quarantine may bypass an exact mismatch", async () => {
  const unavailable = {
    prepare() {
      throw new Error("D1 unavailable");
    },
  };
  const unavailableRetries = [];
  assert.equal(await ensureQueueSchema(unavailable, {
    retryAll(options) { unavailableRetries.push(options); },
  }, { allowUnavailable: true }), true);
  assert.deepEqual(unavailableRetries, []);

  const mismatch = new SchemaDatabase(18);
  const mismatchRetries = [];
  assert.equal(await ensureQueueSchema(mismatch, {
    retryAll(options) { mismatchRetries.push(options); },
  }, { allowUnavailable: true }), false);
  assert.deepEqual(mismatchRetries, [{ delaySeconds: 60 }]);

  const quarantineRetries = [];
  assert.equal(await ensureQueueSchema(new SchemaDatabase(18), {
    retryAll(options) { quarantineRetries.push(options); },
  }, { allowUnavailable: true, allowSchemaMismatch: true }), true);
  assert.deepEqual(quarantineRetries, []);
});

test("primary to DLQ to quarantine preserves a private body in R2 during an exact schema mismatch", async () => {
  const database = new SchemaDatabase(18);
  const body = {
    sourceId: "schema-race-source",
    provider: "fixture",
    item: {
      title: "Schema-race recovery",
      text: "owner-private schema-race body",
      accessClass: "authenticated-local",
    },
  };
  const state = { acked: 0, messageRetries: [], r2Writes: [] };
  const message = {
    id: "schema-race-message",
    timestamp: new Date("2026-08-07T00:00:00.000Z"),
    attempts: 1,
    body,
    ack() { state.acked += 1; },
    retry(options) { state.messageRetries.push(options); },
  };
  function delivery(queue) {
    const retries = [];
    return {
      retries,
      batch: {
        queue,
        messages: [message],
        ackAll() {},
        retryAll(options) { retries.push(options); },
      },
    };
  }

  const primary = delivery("driftglass-staging-ingest");
  assert.equal(await ensureQueueSchema(database, primary.batch), false);
  assert.deepEqual(primary.retries, [{ delaySeconds: 60 }]);

  const deadLetter = delivery("driftglass-staging-ingest-dlq");
  assert.equal(await ensureQueueSchema(database, deadLetter.batch, { allowUnavailable: true }), false);
  assert.deepEqual(deadLetter.retries, [{ delaySeconds: 60 }]);

  const quarantine = delivery("driftglass-staging-ingest-quarantine");
  assert.equal(await ensureQueueSchema(database, quarantine.batch, {
    allowUnavailable: true,
    allowSchemaMismatch: true,
  }), true);
  await handleIngestQueueBatch(quarantine.batch, {
    DB: database,
    EVIDENCE: {
      async put(key, value, options) {
        state.r2Writes.push({ key, value, options });
        return { key };
      },
    },
    INGEST_QUEUE_NAME: "driftglass-staging-ingest",
    INGEST_DLQ_NAME: "driftglass-staging-ingest-dlq",
    INGEST_QUARANTINE_NAME: "driftglass-staging-ingest-quarantine",
  });

  assert.equal(message.attempts < 20, true, "recovery happens before quarantine retry exhaustion");
  assert.equal(state.acked, 1);
  assert.deepEqual(state.messageRetries, []);
  assert.equal(state.r2Writes.length, 1);
  assert.ok(
    database.prepareQueries.some((query) => query.includes("INSERT INTO ingest_dead_letters")),
    "quarantine attempts the private D1 dead-letter record before R2",
  );
  assert.match(state.r2Writes[0].key, /^recovery\/ingest-quarantine\/[a-f0-9]{64}\.json$/);
  assert.match(state.r2Writes[0].value, /owner-private schema-race body/);
  assert.deepEqual(state.r2Writes[0].options.onlyIf, { etagDoesNotMatch: "*" });
});

test("Worker dispatch grants outage bypass to failure Queues and exact-mismatch bypass only to quarantine", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /quarantineQueue = batch\.queue === env\.INGEST_QUARANTINE_NAME/);
  assert.match(
    source,
    /failureQueue = batch\.queue === env\.INGEST_DLQ_NAME \|\| quarantineQueue/,
  );
  assert.match(source, /ensureQueueSchema\(env\.DB, batch, \{[\s\S]*allowUnavailable: failureQueue,[\s\S]*allowSchemaMismatch: quarantineQueue,[\s\S]*\}\)/);
  assert.match(source, /if \(!\(await ensureQueueSchema[\s\S]+\)\) return;[\s\S]+handleIngestQueueBatch/);
});
