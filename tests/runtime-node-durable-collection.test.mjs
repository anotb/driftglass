import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nodeMajor = Number(process.versions.node.split(".", 1)[0]);
const nodeMinor = Number(process.versions.node.split(".")[1] ?? 0);
const node24 = nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 4) ? test : test.skip;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationsDirectory = join(repositoryRoot, "migrations");
const cleanupRoots = [];

after(() => {
  for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
});

node24("local collection reclaims an expired lease without duplicating Story effects", async () => {
  const { NodeSQLiteDatabase } = require("../.test-dist/runtime/node/database.js");
  const { runLocalMigrations } = require("../.test-dist/runtime/node/migrations.js");
  const { DurableIngestQueueRuntime } = require("../.test-dist/runtime/node/durable-ingest-queue.js");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "driftglass-durable-collection-"));
  cleanupRoots.push(root);
  const database = new NodeSQLiteDatabase(join(root, "driftglass.sqlite3"));
  await runLocalMigrations(database, migrationsDirectory);

  const now = new Date().toISOString();
  await database.prepare(
    `INSERT INTO sources(
       id, name, kind, config_json, enabled, schedule_minutes, weight,
       last_run_at, last_success_at, last_error, health_score, created_at, updated_at
     ) VALUES (?, ?, 'manual', '{}', 1, 10080, 1, NULL, NULL, NULL, 1, ?, ?)`,
  ).bind("manual-inbox", "Manual inbox", now, now).run();

  let env;
  const firstRuntime = new DurableIngestQueueRuntime(database, () => env, { pollMs: 1_000, leaseMs: 1_000 });
  env = {
    DB: database,
    EVIDENCE: {
      async put() { return null; },
      async delete() {},
      async list() { return { objects: [], truncated: false }; },
    },
    INGEST_QUEUE: firstRuntime.binding("primary"),
    INGEST_DLQ: firstRuntime.binding("dead-letter"),
    INGEST_QUARANTINE: firstRuntime.binding("quarantine"),
    INGEST_QUEUE_NAME: "driftglass-local-ingest",
    INGEST_DLQ_NAME: "driftglass-local-ingest-dlq",
    INGEST_QUARANTINE_NAME: "driftglass-local-ingest-quarantine",
    DEFAULT_TIMEZONE: "UTC",
    BRIEFING_LOCAL_HOUR: "7",
    MAX_DAILY_STORIES: "12",
    RAW_PUBLIC_RETENTION_DAYS: "30",
  };
  await firstRuntime.initialize();

  const message = {
    sourceId: "manual-inbox",
    provider: "manual",
    item: {
      title: "Lease recovery marker",
      text: "One durable message must produce one Story across restart.",
      url: "https://example.com/lease-recovery-marker",
      metadata: { acceptance: true },
    },
  };
  await env.INGEST_QUEUE.send(message, { contentType: "json" });
  const stored = await database.prepare(
    "SELECT id, body_json, body_bytes, status FROM __driftglass_local_ingest_queue",
  ).first();
  assert.equal(stored.status, "pending");
  assert.equal(stored.body_json, JSON.stringify(message));
  assert.equal(stored.body_bytes, Buffer.byteLength(JSON.stringify(message)));

  const expired = new Date(Date.now() - 1_000).toISOString();
  await database.prepare(
    `UPDATE __driftglass_local_ingest_queue
     SET status = 'leased', attempts = 1, lease_token = 'killed-before-delivery', lease_expires_at = ?`,
  ).bind(expired).run();

  const restarted = new DurableIngestQueueRuntime(database, () => env, { pollMs: 1_000, leaseMs: 1_000 });
  env.INGEST_QUEUE = restarted.binding("primary");
  env.INGEST_DLQ = restarted.binding("dead-letter");
  env.INGEST_QUARANTINE = restarted.binding("quarantine");
  await restarted.initialize();
  assert.equal(await restarted.drainOnce(), true);
  assert.equal(await database.prepare("SELECT status FROM __driftglass_local_ingest_queue").first("status"), "complete");
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM items WHERE title = ?").bind(message.item.title).first("count"), 1);
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM stories WHERE title = ?").bind(message.item.title).first("count"), 1);

  // Simulate a hard stop after the canonical Story commit but before the
  // transport acknowledgement becomes durable.
  await database.prepare(
    `UPDATE __driftglass_local_ingest_queue
     SET status = 'leased', attempts = attempts + 1, lease_token = 'killed-after-story', lease_expires_at = ?`,
  ).bind(expired).run();
  const secondRestart = new DurableIngestQueueRuntime(database, () => env, { pollMs: 1_000, leaseMs: 1_000 });
  env.INGEST_QUEUE = secondRestart.binding("primary");
  env.INGEST_DLQ = secondRestart.binding("dead-letter");
  env.INGEST_QUARANTINE = secondRestart.binding("quarantine");
  await secondRestart.initialize();
  assert.equal(await secondRestart.drainOnce(), true);
  assert.equal(await database.prepare("SELECT status FROM __driftglass_local_ingest_queue").first("status"), "complete");
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM items WHERE title = ?").bind(message.item.title).first("count"), 1);
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM stories WHERE title = ?").bind(message.item.title).first("count"), 1);

  await assert.rejects(
    () => env.INGEST_QUEUE.send({ ...message, item: { ...message.item, text: "x".repeat(61_000) } }),
    /at most 60000 bytes/,
  );

  const malformedTracked = {
    ...message,
    sourceRunId: "missing-required-item-index",
    item: { ...message.item, title: "Failure handoff marker" },
  };
  await env.INGEST_QUEUE.send(malformedTracked, { contentType: "json" });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal(await secondRestart.drainOnce(), true);
      await database.prepare(
        "UPDATE __driftglass_local_ingest_queue SET available_at = ? WHERE lane = 'primary' AND status = 'pending'",
      ).bind(expired).run();
    }
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(
    await database.prepare(
      "SELECT status FROM __driftglass_local_ingest_queue WHERE lane = 'primary' AND body_json = ?",
    ).bind(JSON.stringify(malformedTracked)).first("status"),
    "failed",
  );
  assert.equal(await secondRestart.drainOnce(), true);
  assert.equal(
    await database.prepare(
      "SELECT status FROM __driftglass_local_ingest_queue WHERE lane = 'dead-letter'",
    ).first("status"),
    "complete",
  );
  assert.equal(
    await database.prepare("SELECT COUNT(*) AS count FROM ingest_dead_letters WHERE status = 'unresolved'").first("count"),
    1,
  );
  database.close();
});
