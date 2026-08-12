import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ingestQueueDurabilityHealth,
  isIngestDurabilityBackpressure,
  requireIngestRecoveryQueueDurability,
  requireIngestQueueDurability,
  requireIngestQueueTransportDurability,
} = require("../.test-dist/queue-health.js");

function queue({ count = 0, bytes = 0, timestamp = Date.now(), error } = {}) {
  return {
    async metrics() {
      if (error) throw error;
      return { backlogCount: count, backlogBytes: bytes, oldestMessageTimestamp: timestamp };
    },
  };
}

function database({ count = 0, error } = {}) {
  const state = { r2ClassA: 0 };
  return {
    state,
    prepare(query) {
      const statement = {
        values: [],
        bind(...values) { this.values = values; return this; },
        async all() {
          if (error) throw error;
          if (query.includes("SELECT key, value FROM settings")) {
            return { success: true, results: [], meta: {} };
          }
          throw new Error(`Unexpected query: ${query}`);
        },
        async first() {
          if (error) throw error;
          if (query.includes("ingest_dead_letters")) return { count };
          if (query.includes("SELECT value FROM settings")) return null;
          if (query.includes("SELECT units FROM usage_daily")) return { units: state.r2ClassA };
          throw new Error(`Unexpected query: ${query}`);
        },
        async run() {
          if (error) throw error;
          if (query.includes("INSERT INTO usage_daily")) state.r2ClassA += Number(this.values[2] ?? 0);
          return { success: true, meta: { changes: 1 }, results: [] };
        },
      };
      return statement;
    },
  };
}

function evidence({ objects = [], error } = {}) {
  return {
    async list() {
      if (error) throw error;
      return { objects, truncated: false };
    },
  };
}

function producerEnv(overrides = {}) {
  return {
    DB: database(),
    EVIDENCE: evidence(),
    INGEST_QUEUE: queue(),
    INGEST_DLQ: queue(),
    INGEST_QUARANTINE: queue(),
    ...overrides,
  };
}

test("DLQ and quarantine metrics are both release-blocking durability signals", async () => {
  const timestamp = Date.parse("2026-08-07T12:00:00.000Z");
  const health = await ingestQueueDurabilityHealth({
    INGEST_QUEUE: queue({ count: 2 }),
    INGEST_DLQ: queue({ count: 1, bytes: 700, timestamp }),
    INGEST_QUARANTINE: queue({ error: new Error("binding unavailable") }),
  });
  assert.equal(health.releaseBlocked, true);
  assert.equal(health.deadLetter.oldestMessageAt, "2026-08-07T12:00:00.000Z");
  assert.equal(health.quarantine.available, false);
  assert.ok(health.blockingReasons.some((reason) => reason.includes("exhausted")));
  assert.ok(health.blockingReasons.some((reason) => reason.includes("quarantine")));
});

test("producer preflight fails closed for quarantine backlog with a classifiable system error", async () => {
  const env = producerEnv({ INGEST_QUARANTINE: queue({ count: 1, bytes: 100 }) });
  await assert.rejects(
    requireIngestQueueDurability(env),
    (error) => isIngestDurabilityBackpressure(error) && error.details.code === "INGEST_DLQ_BLOCKED",
  );
});

test("producer preflight passes only when primary and both failure queues are observable and healthy", async () => {
  const env = producerEnv();
  await requireIngestQueueDurability(env);
  assert.equal(env.DB.state.r2ClassA, 1, "one R2 Class A list is reserved per normal preflight");
});

test("normal producers stop for unresolved D1 dead letters while the transport-only preflight remains usable", async () => {
  const env = producerEnv({ DB: database({ count: 1 }) });
  await assert.rejects(
    requireIngestQueueDurability(env),
    (error) => isIngestDurabilityBackpressure(error)
      && error.details.code === "INGEST_DLQ_BLOCKED"
      && error.details.unresolvedDeadLetters === 1,
  );
  await requireIngestQueueTransportDurability(env);
});

test("release readiness blocks when primary Queue health cannot be observed", async () => {
  const health = await ingestQueueDurabilityHealth({
    INGEST_QUEUE: queue({ error: new Error("primary unavailable") }),
    INGEST_DLQ: queue(),
    INGEST_QUARANTINE: queue(),
  });
  assert.equal(health.releaseBlocked, true);
  assert.ok(health.blockingReasons.some((reason) => reason.includes("Primary")));
});

test("release readiness is non-green while the primary Queue is draining", async () => {
  const health = await ingestQueueDurabilityHealth({
    INGEST_QUEUE: queue({ count: 2, bytes: 800, timestamp: Date.now() - 5_000 }),
    INGEST_DLQ: queue(),
    INGEST_QUARANTINE: queue(),
  });
  assert.equal(health.releaseBlocked, true);
  assert.ok(health.blockingReasons.some((reason) => reason.includes("draining 2 messages")));
});

test("normal producers tolerate a recent drain but stop on an aged or unobservable primary backlog", async () => {
  const base = { DB: database(), EVIDENCE: evidence(), INGEST_DLQ: queue(), INGEST_QUARANTINE: queue() };
  await requireIngestQueueDurability({
    ...base,
    INGEST_QUEUE: queue({ count: 1, timestamp: Date.now() - 5_000 }),
  });
  await assert.rejects(
    requireIngestQueueDurability({
      ...base,
      INGEST_QUEUE: queue({ count: 1, timestamp: Date.now() - 11 * 60_000 }),
    }),
    (error) => isIngestDurabilityBackpressure(error) && error.details.code === "INGEST_PRIMARY_STALE",
  );
  await assert.rejects(
    requireIngestQueueDurability({ ...base, INGEST_QUEUE: queue({ error: new Error("metrics unavailable") }) }),
    (error) => isIngestDurabilityBackpressure(error) && error.details.code === "INGEST_DLQ_UNAVAILABLE",
  );
});

test("owner recovery requires observable, non-stale primary Queue health", async () => {
  for (const [label, primary, code] of [
    ["unavailable", queue({ error: new Error("metrics unavailable") }), "INGEST_DLQ_UNAVAILABLE"],
    ["stale", queue({ count: 1, timestamp: Date.now() - 11 * 60_000 }), "INGEST_PRIMARY_STALE"],
  ]) {
    await assert.rejects(
      requireIngestRecoveryQueueDurability(
        producerEnv({ INGEST_QUEUE: primary }),
        { storage: "d1", id: "selected-dead-letter" },
      ),
      (error) => isIngestDurabilityBackpressure(error) && error.details.code === code,
      label,
    );
  }
  await requireIngestRecoveryQueueDurability(
    producerEnv({ INGEST_QUEUE: queue({ count: 1, timestamp: Date.now() - 5_000 }) }),
    { storage: "d1", id: "selected-dead-letter" },
  );
});

test("owner recovery can drain one incident while other durable D1 and R2 incidents remain", async () => {
  const selectedId = `r2:${"a".repeat(64)}`;
  const selectedObject = {
    key: `recovery/ingest-quarantine/${"a".repeat(64)}.json`,
    size: 100,
    uploaded: new Date(),
  };
  const anotherObject = {
    key: `recovery/ingest-quarantine/${"b".repeat(64)}.json`,
    size: 100,
    uploaded: new Date(),
  };
  const env = producerEnv({
    DB: database({ count: 2 }),
    EVIDENCE: evidence({ objects: [selectedObject, anotherObject] }),
  });
  await requireIngestRecoveryQueueDurability(
    env,
    { storage: "d1", id: "selected-dead-letter" },
  );
  await requireIngestRecoveryQueueDurability(
    env,
    { storage: "r2", id: selectedId },
  );
  assert.equal(env.DB.state.r2ClassA, 0, "recovery transport preflight does not list either durable incident store");
});

test("owner recovery still requires empty and observable DLQ/quarantine transports", async () => {
  for (const [label, overrides] of [
    ["DLQ backlog", { INGEST_DLQ: queue({ count: 1 }) }],
    ["quarantine backlog", { INGEST_QUARANTINE: queue({ count: 1 }) }],
    ["DLQ unavailable", { INGEST_DLQ: queue({ error: new Error("metrics unavailable") }) }],
  ]) {
    await assert.rejects(
      requireIngestRecoveryQueueDurability(
        producerEnv(overrides),
        { storage: "d1", id: "selected-dead-letter" },
      ),
      (error) => isIngestDurabilityBackpressure(error)
        && ["INGEST_DLQ_BLOCKED", "INGEST_DLQ_UNAVAILABLE"].includes(error.details.code),
      label,
    );
  }
});

test("normal producers fail closed for private R2 recovery objects or an unavailable fallback listing", async () => {
  const objects = ["a", "b"].map((digest) => ({
    key: `recovery/ingest-quarantine/${digest.repeat(64)}.json`,
    size: 100,
    uploaded: new Date(),
  }));
  await assert.rejects(
    requireIngestQueueDurability(producerEnv({ EVIDENCE: evidence({ objects }) })),
    (error) => isIngestDurabilityBackpressure(error)
      && error.details.code === "INGEST_DLQ_BLOCKED"
      && error.details.r2QuarantineRecoveries === 1,
  );
  await assert.rejects(
    requireIngestQueueDurability(producerEnv({ EVIDENCE: evidence({ error: new Error("R2 list unavailable") }) })),
    (error) => isIngestDurabilityBackpressure(error)
      && error.details.code === "INGEST_DLQ_UNAVAILABLE",
  );
});

test("normal producers remain blocked by two unresolved D1 incidents", async () => {
  await assert.rejects(
    requireIngestQueueDurability(producerEnv({ DB: database({ count: 2 }) })),
    (error) => isIngestDurabilityBackpressure(error)
      && error.details.code === "INGEST_DLQ_BLOCKED"
      && error.details.unresolvedDeadLetters === 2,
  );
});
