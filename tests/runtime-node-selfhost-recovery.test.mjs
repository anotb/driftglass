import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const nodeParts = process.versions.node.split(".").map(Number);
const node24 = nodeParts[0] > 24 || (nodeParts[0] === 24 && nodeParts[1] >= 4) ? test : test.skip;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const artifact = join(repositoryRoot, "dist", "selfhost", "driftglass-selfhost.mjs");
const migrationsDirectory = join(repositoryRoot, "migrations");
const assetsDirectory = join(repositoryRoot, "dist", "selfhost", "public");
const SOURCE_ID = "artifact-kill-window-source";
const PROTECTED_SOURCE_ID = "artifact-protected-outbox-source";
const PROTECTED_RUN_ID = "artifact-protected-outbox-run";
const INTERRUPTED_ERROR = "Local process stopped before source output became durable";

function cleanEnvironment() {
  const env = { ...process.env };
  delete env.npm_lifecycle_event;
  delete env.npm_lifecycle_script;
  return env;
}

function runArtifact(args, options = {}) {
  return spawnSync(process.execPath, [artifact, ...args], {
    cwd: repositoryRoot,
    env: cleanEnvironment(),
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
  });
}

function parseCommand(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function serveArguments(dataDirectory) {
  return [
    "serve",
    "--data-dir", dataDirectory,
    "--assets-dir", assetsDirectory,
    "--port", "0",
    "--queue-poll-ms", "1000",
    "--queue-lease-ms", "1000",
    "--scheduler-poll-ms", "60000",
    "--scheduler-lease-ms", "5000",
    "--memory-poll-ms", "60000",
  ];
}

function startService(dataDirectory) {
  const child = spawn(process.execPath, [artifact, ...serveArguments(dataDirectory)], {
    cwd: repositoryRoot,
    env: cleanEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function eventually(probe, accept, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = probe();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${label} timed out; latest state: ${JSON.stringify(latest)}`);
}

async function waitForService(service) {
  await eventually(
    () => ({ stdout: service.stdout(), stderr: service.stderr(), exitCode: service.child.exitCode }),
    (state) => state.stdout.includes('"command": "serve"') || state.exitCode !== null,
    "self-host service startup",
  );
  assert.equal(service.child.exitCode, null, service.stderr() || service.stdout());
}

async function stopService(service, signal) {
  if (service.child.exitCode !== null || service.child.signalCode !== null) return;
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`self-host ${signal} shutdown timed out`)), 20_000);
    service.child.once("exit", (code, exitSignal) => {
      clearTimeout(timer);
      resolve({ code, signal: exitSignal });
    });
  });
  assert.equal(service.child.kill(signal), true);
  await exited;
}

function readState(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      source: database.prepare(
        "SELECT id, enabled, last_run_at, last_success_at, last_error, health_score FROM sources WHERE id = ?",
      ).get(SOURCE_ID),
      protectedSource: database.prepare(
        "SELECT id, last_run_at, health_score FROM sources WHERE id = ?",
      ).get(PROTECTED_SOURCE_ID),
      runs: database.prepare(
        `SELECT id, status, started_at, finished_at, collection_finished_at,
                terminal_accounted_at, details_json, last_ingest_error
         FROM source_runs WHERE source_id = ? ORDER BY rowid`,
      ).all(SOURCE_ID),
      protectedRun: database.prepare(
        "SELECT id, status, terminal_accounted_at FROM source_runs WHERE id = ?",
      ).get(PROTECTED_RUN_ID),
      protectedOutbox: database.prepare(
        "SELECT run_id, state FROM source_ingest_outbox_runs WHERE run_id = ?",
      ).get(PROTECTED_RUN_ID),
      sourceOutboxCount: database.prepare(
        `SELECT COUNT(*) AS count FROM source_ingest_outbox_runs
         WHERE source_id = ?`,
      ).get(SOURCE_ID).count,
      sourceReceiptCount: database.prepare(
        `SELECT COUNT(*) AS count FROM source_run_ingest_receipts receipt
         JOIN source_runs run ON run.id = receipt.run_id
         WHERE run.source_id = ?`,
      ).get(SOURCE_ID).count,
    };
  } finally {
    database.close();
  }
}

function installKillWindowFixture(databasePath, missionWorkspaceDirectory) {
  const database = new DatabaseSync(databasePath);
  const now = new Date().toISOString();
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.prepare("UPDATE sources SET enabled = 0").run();
    const insertSource = database.prepare(
      `INSERT INTO sources(
         id, name, kind, config_json, enabled, schedule_minutes, weight,
         last_run_at, last_success_at, last_error, health_score, created_at, updated_at
       ) VALUES (?, ?, 'web_feed', ?, ?, 10080, 1, ?, NULL, NULL, 1, ?, ?)`,
    );
    insertSource.run(
      SOURCE_ID,
      "Artifact kill-window source",
      JSON.stringify({ url: "https://example.com/", renderStrategy: "direct", fetchArticles: false }),
      1,
      null,
      now,
      now,
    );
    insertSource.run(
      PROTECTED_SOURCE_ID,
      "Artifact protected outbox source",
      JSON.stringify({ url: "https://example.com/", renderStrategy: "direct", fetchArticles: false }),
      0,
      "2026-01-02T03:04:05.000Z",
      now,
      now,
    );
    database.prepare(
      `INSERT INTO source_runs(id, source_id, started_at, status, provider)
       VALUES (?, ?, ?, 'running', 'direct-page-feed')`,
    ).run(PROTECTED_RUN_ID, PROTECTED_SOURCE_ID, "2026-01-02T03:04:05.000Z");
    database.prepare(
      `INSERT INTO source_ingest_outbox_runs(
         run_id, source_id, state, message_count, total_bytes, payload_sha256, next_index,
         collection_partial, collection_health_delta, latency_ms, provider, details_json,
         created_at, updated_at
       ) VALUES (?, ?, 'staging', 1, 1, ?, 0, 0, 0, 0, 'direct-page-feed', '{}', ?, ?)`,
    ).run(PROTECTED_RUN_ID, PROTECTED_SOURCE_ID, "0".repeat(64), now, now);
    database.exec(`
      CREATE TRIGGER __driftglass_test_pause_source_budget
      BEFORE INSERT ON usage_daily
      WHEN NEW.dimension = 'source_runs'
      BEGIN
        SELECT sum(value) FROM (
          WITH RECURSIVE counter(value) AS (
            VALUES(0)
            UNION ALL
            SELECT value + 1 FROM counter WHERE value < 30000000
          )
          SELECT value FROM counter
        );
      END;
    `);
  } finally {
    database.close();
  }

  const note = join(missionWorkspaceDirectory, "artifact-recovery-mission", "notes", "owner-note.md");
  mkdirSync(dirname(note), { recursive: true, mode: 0o700 });
  writeFileSync(note, "Owner-authored notes survive kill, backup, and restore.\n", { mode: 0o600 });
  return note;
}

function prepareNextHardKill(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare("DELETE FROM usage_daily WHERE dimension = 'source_runs'").run();
  } finally {
    database.close();
  }
}

function finishKillFixture(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.prepare("UPDATE sources SET enabled = 0 WHERE id = ?").run(SOURCE_ID);
    database.exec("DROP TRIGGER __driftglass_test_pause_source_budget");
    database.prepare("DELETE FROM source_ingest_outbox_runs WHERE run_id = ?").run(PROTECTED_RUN_ID);
    database.prepare("DELETE FROM source_runs WHERE id = ?").run(PROTECTED_RUN_ID);
    database.prepare("DELETE FROM sources WHERE id = ?").run(PROTECTED_SOURCE_ID);
  } finally {
    database.close();
  }
}

node24("packaged self-host recovers real SIGKILL windows and preserves backup/restore lock semantics", { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "driftglass-selfhost-kill-artifact-"));
  const services = new Set();
  const launch = (dataDirectory) => {
    const service = startService(dataDirectory);
    services.add(service);
    service.child.once("exit", () => services.delete(service));
    return service;
  };
  t.after(async () => {
    for (const service of services) await stopService(service, "SIGKILL").catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const build = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "build-selfhost.mjs")], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  assert.equal(existsSync(artifact), true);

  const dataDirectory = join(root, "source-data");
  const initialized = parseCommand(runArtifact([
    "init",
    "--data-dir", dataDirectory,
    "--migrations-dir", migrationsDirectory,
  ]), "self-host init");
  const databasePath = initialized.databasePath;
  const missionWorkspaceDirectory = join(dataDirectory, "missions");
  const ownerNote = installKillWindowFixture(databasePath, missionWorkspaceDirectory);

  const first = launch(dataDirectory);
  await waitForService(first);
  const firstWindow = await eventually(
    () => readState(databasePath),
    (state) => state.runs.length === 1 && state.runs[0].status === "running" && state.sourceOutboxCount === 0,
    "first pre-outbox source-run window",
  );
  const firstRunId = firstWindow.runs[0].id;
  assert.equal(firstWindow.source.last_run_at, firstWindow.runs[0].started_at, "beginSourceRun advanced the cadence cursor");
  assert.equal(firstWindow.sourceReceiptCount, 0);
  await stopService(first, "SIGKILL");

  prepareNextHardKill(databasePath);
  const second = launch(dataDirectory);
  await waitForService(second);
  const secondWindow = await eventually(
    () => readState(databasePath),
    (state) => state.runs.length === 2 && state.runs[0].status === "failed" && state.runs[1].status === "running",
    "first restart recovery and immediate retry",
  );
  const secondRunId = secondWindow.runs[1].id;
  assert.notEqual(secondRunId, firstRunId);
  assert.deepEqual(JSON.parse(secondWindow.runs[0].details_json), {
    localRestartRecovery: true,
    retryScheduled: true,
    interruptedAt: secondWindow.runs[0].finished_at,
  });
  assert.equal(secondWindow.runs[0].last_ingest_error, INTERRUPTED_ERROR);
  assert.ok(secondWindow.runs[0].terminal_accounted_at);
  assert.equal(secondWindow.source.last_error, null, "a process stop does not blame source health");
  assert.equal(secondWindow.source.health_score, 1);
  assert.equal(secondWindow.protectedRun.status, "running", "a staging outbox remains canonical");
  assert.equal(secondWindow.protectedOutbox.state, "staging");
  assert.equal(secondWindow.protectedSource.last_run_at, "2026-01-02T03:04:05.000Z");
  assert.match(second.stderr(), /local_source_restart_recovery/);
  await stopService(second, "SIGKILL");

  prepareNextHardKill(databasePath);
  const third = launch(dataDirectory);
  await waitForService(third);
  const thirdWindow = await eventually(
    () => readState(databasePath),
    (state) => state.runs.length === 3
      && state.runs[0].status === "failed"
      && state.runs[1].status === "failed"
      && state.runs[2].status === "running",
    "second restart recovery without cadence suppression",
  );
  assert.notEqual(thirdWindow.runs[2].id, secondRunId);
  assert.equal(thirdWindow.sourceOutboxCount, 0);
  assert.equal(thirdWindow.sourceReceiptCount, 0);
  await stopService(third, "SIGKILL");

  finishKillFixture(databasePath);
  const settled = launch(dataDirectory);
  await waitForService(settled);
  const settledState = readState(databasePath);
  assert.equal(settledState.runs.length, 3);
  assert.equal(settledState.runs.every((run) => run.status === "failed" && run.terminal_accounted_at), true);
  assert.equal(settledState.source.last_run_at, null, "only durable prior attempts may retain the cadence cursor");
  assert.equal(settledState.source.last_error, null);
  await stopService(settled, "SIGTERM");
  assert.match(settled.stdout(), /"command": "shutdown"/);
  assert.match(settled.stdout(), /"status": "clean"/);

  const backupDirectory = join(root, "operational-backup");
  const backup = parseCommand(runArtifact([
    "backup", "create",
    "--data-dir", dataDirectory,
    "--destination", backupDirectory,
  ]), "backup create");
  const verified = parseCommand(runArtifact([
    "backup", "verify",
    "--source", backupDirectory,
  ]), "backup verify");
  assert.equal(verified.manifestSha256, backup.manifestSha256);
  const manifest = JSON.parse(readFileSync(join(backupDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.files.some((file) => file.path === "missions/artifact-recovery-mission/notes/owner-note.md"), true);
  assert.equal(manifest.files.some((file) => file.path.startsWith("runtime/") || file.path.includes("owner-secret")), false);

  const restoredDirectory = join(root, "restored-data");
  const restored = parseCommand(runArtifact([
    "restore",
    "--source", backupDirectory,
    "--data-dir", restoredDirectory,
  ]), "restore");
  assert.equal(restored.sourceManifestSha256, backup.manifestSha256);
  assert.notEqual(restored.receiptSha256, initialized.receiptSha256, "restore establishes new writable authority");
  assert.equal(
    readFileSync(join(restoredDirectory, "missions", "artifact-recovery-mission", "notes", "owner-note.md"), "utf8"),
    readFileSync(ownerNote, "utf8"),
  );
  const restoredDatabase = new DatabaseSync(join(restoredDirectory, "state", "driftglass.sqlite3"), { readOnly: true });
  try {
    assert.equal(restoredDatabase.prepare("SELECT COUNT(*) AS count FROM source_runs WHERE source_id = ? AND status = 'failed'").get(SOURCE_ID).count, 3);
    assert.equal(restoredDatabase.prepare("SELECT COUNT(*) AS count FROM source_runs WHERE status = 'running'").get().count, 0);
    assert.equal(restoredDatabase.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    restoredDatabase.close();
  }

  const liveRestored = launch(restoredDirectory);
  await waitForService(liveRestored);
  const excludedDestination = join(root, "must-not-overlap-live-service");
  const excluded = runArtifact([
    "backup", "create",
    "--data-dir", restoredDirectory,
    "--destination", excludedDestination,
  ]);
  assert.notEqual(excluded.status, 0);
  assert.match(excluded.stderr, /already locked for serve by PID/);
  assert.equal(existsSync(excludedDestination), false);
  await stopService(liveRestored, "SIGTERM");

  const postStopBackup = join(root, "post-stop-backup");
  parseCommand(runArtifact([
    "backup", "create",
    "--data-dir", restoredDirectory,
    "--destination", postStopBackup,
  ]), "post-stop backup create");
  parseCommand(runArtifact([
    "backup", "verify",
    "--source", postStopBackup,
  ]), "post-stop backup verify");
});
