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

node24("self-host scheduled intelligence coalesces restart recovery into one Mission-aware briefing", async () => {
  const { NodeSQLiteDatabase } = require("../.test-dist/runtime/node/database.js");
  const { runLocalMigrations } = require("../.test-dist/runtime/node/migrations.js");
  const { upsertMission, upsertMissionOperator } = require("../.test-dist/db.js");
  const { LocalScheduledIntelligence } = require("../.test-dist/runtime/node/scheduled-intelligence.js");

  const root = mkdtempSync(join(realpathSync(tmpdir()), "driftglass-scheduled-intelligence-"));
  cleanupRoots.push(root);
  const database = new NodeSQLiteDatabase(join(root, "driftglass.sqlite3"));
  await runLocalMigrations(database, migrationsDirectory);

  const now = new Date();
  const expectedBy = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  await upsertMission(database, {
    id: "mission-restart-check",
    name: "Restart-safe research",
    question: "Will an overdue expected event survive a local restart?",
    terms: ["restart", "expected event"],
    priority: 2,
  });
  await upsertMissionOperator(database, {
    missionId: "mission-restart-check",
    expectedNextEvent: "A restart recovery result",
    expectedBy,
    expectedEventStatus: "pending",
    reminderLeadDays: 3,
  });

  const storedObjects = new Map();
  const env = {
    DB: database,
    EVIDENCE: {
      async put(key, value) {
        storedObjects.set(key, typeof value === "string" ? value : Buffer.from(value));
        return { key };
      },
      async delete(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) storedObjects.delete(key);
      },
    },
    APP_NAME: "Driftglass Self-host (experimental)",
    DEFAULT_TIMEZONE: "UTC",
    BRIEFING_LOCAL_HOUR: "0",
    MAX_DAILY_STORIES: "12",
    RAW_PUBLIC_RETENTION_DAYS: "30",
  };

  const first = new LocalScheduledIntelligence(database, () => env, {
    now: () => new Date(now),
    pollMs: 1_000,
    leaseMs: 5_000,
    checkIntervalMs: 60_000,
  });
  await first.initialize();
  const delivered = await first.tick();
  assert.equal(delivered.claimed, true);
  assert.equal(delivered.reminders, 1);
  assert.equal(delivered.briefing, "generated");
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM briefings").first("count"), 1);
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM mission_events").first("count"), 1);
  const packet = JSON.parse(await database.prepare("SELECT packet_json FROM briefings").first("packet_json"));
  assert.equal(packet.missions[0].id, "mission-restart-check");
  assert.ok(packet.actions.some((action) => action.kind === "expected-overdue"));
  assert.equal(storedObjects.size, 2);

  // Model a hard stop after the durable packet commit but before the scheduler
  // could acknowledge its lease. The recovered run must not duplicate either
  // the packet or the Mission reminder.
  const restartedAt = new Date(now.getTime() + 2 * 60_000);
  await database.prepare(
    `UPDATE __driftglass_local_scheduled_intelligence
     SET next_run_at = ?, lease_token = 'killed-after-commit', lease_expires_at = ?`,
  ).bind(
    new Date(now.getTime() - 60_000).toISOString(),
    new Date(now.getTime() - 1).toISOString(),
  ).run();
  const restarted = new LocalScheduledIntelligence(database, () => env, {
    now: () => new Date(restartedAt),
    pollMs: 1_000,
    leaseMs: 5_000,
    checkIntervalMs: 60_000,
  });
  await restarted.initialize();
  const recovered = await restarted.tick();
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.reminders, 0);
  assert.equal(recovered.briefing, "current");
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM briefings").first("count"), 1);
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM mission_events").first("count"), 1);
  assert.equal(storedObjects.size, 2);
  database.close();
});
