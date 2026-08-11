import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, relative } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nodeMajor = Number(process.versions.node.split(".", 1)[0]);
const nodeMinor = Number(process.versions.node.split(".")[1] ?? 0);
const node24 = nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 4) ? test : test.skip;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationsDirectory = join(repositoryRoot, "migrations");
const realTemporaryDirectory = realpathSync(tmpdir());

const layoutModule = require("../.test-dist/runtime/node/layout.js");
const neutralRuntime = require("../.test-dist/runtime/index.js");
let databaseModule;
let objectStoreModule;
let migrationsModule;
if (nodeMajor >= 24) {
  databaseModule = require("../.test-dist/runtime/node/database.js");
  objectStoreModule = require("../.test-dist/runtime/node/object-store.js");
  migrationsModule = require("../.test-dist/runtime/node/migrations.js");
}

const deferredCleanupRoots = [];
let backupLane = Promise.resolve();
after(() => {
  for (const root of deferredCleanupRoots) rmSync(root, { recursive: true, force: true });
});

function inBackupLane(operation) {
  const run = backupLane.then(operation, operation);
  backupLane = run.then(() => undefined, () => undefined);
  return run;
}

function temporaryRoot(t, prefix, deferCleanup = false) {
  const root = mkdtempSync(join(realTemporaryDirectory, prefix));
  // TestContext after hooks run in declaration order. Windows will not remove
  // an open SQLite file, so defer cleanup until every per-test close hook ran.
  if (deferCleanup || process.platform === "win32") deferredCleanupRoots.push(root);
  else t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function mode(path) {
  return lstatSync(path).mode & 0o777;
}

function filesBelow(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else result.push(path);
    }
  };
  visit(root);
  return result;
}

function writeLedgerSchema(database) {
  return database.exec(`
    CREATE TABLE __driftglass_local_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      status TEXT NOT NULL CHECK(status IN ('applying', 'applied')),
      started_at TEXT NOT NULL,
      applied_at TEXT
    )
  `);
}

test("portable persistence declares Node 24.4 and stays outside the neutral runtime barrel", () => {
  assert.equal(layoutModule.PORTABLE_NODE_MINIMUM_VERSION, "24.4.0");
  assert.throws(() => layoutModule.assertPortableNodeRuntime("24.3.9"), /requires Node\.js 24\.4\.0/);
  assert.doesNotThrow(() => layoutModule.assertPortableNodeRuntime("24.4.0"));
  assert.equal("NodeSQLiteDatabase" in neutralRuntime, false);
  assert.equal("LocalObjectStore" in neutralRuntime, false);
  const ci = readFileSync(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8")
    .replace(/\r\n?/g, "\n");
  for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.match(ci, new RegExp(`os: ${os}\\n\\s+node: 24\\.4\\.0`));
  }
});

node24("local data layout is private and refuses any symlink ancestor before creating data", (t) => {
  const root = temporaryRoot(t, "driftglass-layout-");
  const layout = layoutModule.createLocalDataLayout(join(root, "data"));
  assert.equal(layout.databasePath, join(layout.root, "state", "driftglass.sqlite3"));
  if (process.platform !== "win32") {
    for (const directory of [
      layout.root,
      layout.stateDirectory,
      layout.objectStoreDirectory,
      layout.missionWorkspaceDirectory,
      layout.backupDirectory,
      layout.runtimeDirectory,
    ]) assert.equal(mode(directory), 0o700);
  }

  const outside = join(root, "outside");
  const link = join(root, "link");
  mkdirSync(outside);
  try {
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") return t.skip("symlinks require additional Windows privileges");
    throw error;
  }
  assert.throws(() => layoutModule.createLocalDataLayout(join(link, "escaped")), /symbolic-link/);
  assert.equal(existsSync(join(outside, "escaped")), false);
});

node24("managed persistence roots reject relative, filesystem-root, and unrelated directories without mutation", (t) => {
  const { LocalObjectStore } = objectStoreModule;
  const root = temporaryRoot(t, "driftglass-managed-root-");

  const relativeTarget = join(root, "relative-target");
  mkdirSync(relativeTarget, { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(relativeTarget, 0o755);
  const relativeMode = mode(relativeTarget);
  const relativeRun = spawnSync(
    process.execPath,
    [
      "-e",
      "const layout=require(process.argv[1]);try{layout.createLocalDataLayout('.');process.exitCode=2}catch{process.exitCode=0}",
      join(repositoryRoot, ".test-dist", "runtime", "node", "layout.js"),
    ],
    { cwd: relativeTarget, encoding: "utf8" },
  );
  assert.equal(relativeRun.status, 0, relativeRun.stderr);
  assert.equal(mode(relativeTarget), relativeMode);
  assert.deepEqual(readdirSync(relativeTarget), [], "a rejected relative root must stay empty");

  const filesystemRoot = parse(repositoryRoot).root;
  const filesystemRootBefore = lstatSync(filesystemRoot);
  const filesystemRootEntries = readdirSync(filesystemRoot).sort();
  assert.throws(() => layoutModule.validateManagedDirectoryPath(filesystemRoot), /filesystem root/);
  const filesystemRootAfter = lstatSync(filesystemRoot);
  assert.equal(filesystemRootAfter.mode, filesystemRootBefore.mode);
  assert.equal(filesystemRootAfter.mtimeMs, filesystemRootBefore.mtimeMs);
  assert.deepEqual(readdirSync(filesystemRoot).sort(), filesystemRootEntries);

  const unrelated = join(root, "unrelated");
  mkdirSync(unrelated, { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(unrelated, 0o755);
  const sentinel = join(unrelated, "owner-data.txt");
  writeFileSync(sentinel, "must survive exactly\n", { mode: 0o644 });
  const unrelatedMode = mode(unrelated);
  const sentinelMode = mode(sentinel);
  const sentinelBody = readFileSync(sentinel);
  const entries = readdirSync(unrelated);
  assert.throws(() => layoutModule.createLocalDataLayout(unrelated), /nonempty unmarked/);
  assert.throws(() => new LocalObjectStore(unrelated), /nonempty unmarked/);
  assert.equal(mode(unrelated), unrelatedMode);
  assert.equal(mode(sentinel), sentinelMode);
  assert.deepEqual(readFileSync(sentinel), sentinelBody);
  assert.deepEqual(readdirSync(unrelated), entries);
});

node24("managed persistence markers are exact, kind-bound, private, and reusable", async (t) => {
  const { LocalObjectStore } = objectStoreModule;
  const root = temporaryRoot(t, "driftglass-managed-marker-");
  const dataRoot = join(root, "data");
  const layout = layoutModule.createLocalDataLayout(dataRoot);
  const dataMarker = join(dataRoot, layoutModule.DRIFTGLASS_MANAGED_DIRECTORY_MARKER);
  assert.deepEqual(JSON.parse(readFileSync(dataMarker, "utf8")), {
    format: "driftglass-managed-directory",
    version: 1,
    kind: "local-data-root",
  });
  if (process.platform !== "win32") assert.equal(mode(dataMarker), 0o600);
  assert.equal(layoutModule.createLocalDataLayout(dataRoot).root, dataRoot);
  assert.throws(() => new LocalObjectStore(dataRoot), /kind or version/);

  const store = new LocalObjectStore(layout.objectStoreDirectory);
  const storeMarker = join(layout.objectStoreDirectory, layoutModule.DRIFTGLASS_MANAGED_DIRECTORY_MARKER);
  assert.equal(JSON.parse(readFileSync(storeMarker, "utf8")).kind, "object-store");
  if (process.platform !== "win32") assert.equal(mode(storeMarker), 0o600);
  assert.equal((await store.put("marker/reuse", "ok")).stored, true);
  assert.equal(await (await new LocalObjectStore(layout.objectStoreDirectory).get("marker/reuse")).text(), "ok");
});

node24("SQLite keeps caller directory modes, uses WAL/FKs, and normalizes immutable binds safely", async (t) => {
  const { NodeSQLiteDatabase } = databaseModule;
  const root = temporaryRoot(t, "driftglass-sqlite-");
  if (process.platform !== "win32") chmodSync(root, 0o755);
  const databasePath = join(root, "driftglass.db");
  const database = new NodeSQLiteDatabase(databasePath, { busyTimeoutMs: 37 });
  t.after(() => database.close());
  if (process.platform !== "win32") {
    assert.equal(mode(root), 0o755, "an existing caller-selected parent must not be chmodded");
    assert.equal(mode(databasePath), 0o600);
  }

  assert.equal(await database.prepare("PRAGMA journal_mode").first("journal_mode"), "wal");
  assert.equal(await database.prepare("PRAGMA foreign_keys").first("foreign_keys"), 1);
  assert.equal(await database.prepare("PRAGMA busy_timeout").first("timeout"), 37);
  await database.exec("CREATE TABLE values_test(id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL, body BLOB NOT NULL, huge INTEGER UNIQUE)");

  const backing = new Uint8Array([99, 1, 2, 98]);
  const base = database.prepare("INSERT INTO values_test(enabled, body, huge) VALUES (?, ?, ?) RETURNING id, enabled");
  const bound = base.bind(true, backing.subarray(1, 3), Number.MAX_SAFE_INTEGER);
  backing[1] = 88;
  const inserted = await bound.run();
  assert.deepEqual(inserted.results, [{ id: 1, enabled: 1 }]);
  assert.equal(inserted.meta.changes, 1);
  assert.equal(inserted.meta.rows_written, 1);
  assert.throws(() => base.bind(false, new Uint8Array(), Number.MAX_SAFE_INTEGER + 1), /Unsafe integer/);
  assert.throws(() => base.bind(false, new Uint8Array(), 1n), /BigInt is not a portable/);

  const selected = await database.prepare("SELECT enabled, body, huge FROM values_test").first();
  assert.equal(selected.enabled, 1);
  assert.deepEqual([...selected.body], [1, 2]);
  assert.equal(selected.huge, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(await database.prepare("SELECT enabled, huge FROM values_test").raw(), [[1, Number.MAX_SAFE_INTEGER]]);
  assert.equal(await database.prepare("SELECT enabled FROM values_test").first("enabled"), 1);
  await assert.rejects(
    () => database.prepare("SELECT 9223372036854775807 AS value").first("value"),
    /outside the portable D1\/SQLite safe range/,
  );
  await assert.rejects(() => base.run(), /NOT NULL|bind|parameter/i, "bind() must not mutate the original statement");
  await assert.rejects(
    () => database.prepare("INSERT INTO values_test(enabled, body, huge) VALUES (1, X'00', ?)").bind(Number.MAX_SAFE_INTEGER).run(),
    /UNIQUE/,
  );
  assert.equal((await database.integrityCheck()).ok, true);
});

node24("SQLite batch handles SELECT/RETURNING atomically and rolls back every prior statement", async (t) => {
  const { NodeSQLiteDatabase } = databaseModule;
  const root = temporaryRoot(t, "driftglass-batch-");
  const database = new NodeSQLiteDatabase(join(root, "batch.db"));
  t.after(() => database.close());
  await database.exec("CREATE TABLE batch_test(id INTEGER PRIMARY KEY, value TEXT UNIQUE)");

  await assert.rejects(
    () => database.batch([
      database.prepare("INSERT INTO batch_test(value) VALUES (?) RETURNING id").bind("one"),
      database.prepare("SELECT COUNT(*) AS count FROM batch_test"),
      database.prepare("INSERT INTO batch_test(value) VALUES (?)").bind("one"),
    ]),
    /UNIQUE/,
  );
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM batch_test").first("count"), 0);

  const results = await database.batch([
    database.prepare("INSERT INTO batch_test(value) VALUES (?) RETURNING id, value").bind("one"),
    database.prepare("SELECT value FROM batch_test ORDER BY id"),
  ]);
  assert.deepEqual(results[0].results, [{ id: 1, value: "one" }]);
  assert.deepEqual(results[1].results, [{ value: "one" }]);

  const other = new NodeSQLiteDatabase(join(root, "other.db"));
  t.after(() => other.close());
  await assert.rejects(() => database.batch([other.prepare("SELECT 1")]), /belong to this/);
});

node24("SQLite checkpoints, backs up atomically, reopens read-only, and preserves backup parent mode", (t) => inBackupLane(async () => {
  const { NodeSQLiteDatabase } = databaseModule;
  const root = temporaryRoot(t, "driftglass-backup-", true);
  const databasePath = join(root, "source.db");
  const database = new NodeSQLiteDatabase(databasePath);
  await database.exec("CREATE TABLE durable(id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO durable VALUES ('a', 'survives')");
  assert.equal((await database.checkpoint("FULL")).busy, 0);
  const backupDirectory = join(root, "shared-backups");
  mkdirSync(backupDirectory, { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(backupDirectory, 0o755);
  const backupPath = join(backupDirectory, "snapshot.db");
  await database.backupTo(backupPath);
  if (process.platform !== "win32") {
    assert.equal(mode(backupDirectory), 0o755);
    assert.equal(mode(backupPath), 0o600);
  }
  await assert.rejects(() => database.backupTo(backupPath), /already exists/);
  await database.prepare("UPDATE durable SET value = 'new-snapshot' WHERE id = 'a'").run();
  if (process.platform === "win32") {
    await assert.rejects(
      () => database.backupTo(backupPath, { overwrite: true }),
      /Atomic backup overwrite is unavailable on Windows/,
    );
  } else {
    await database.backupTo(backupPath, { overwrite: true });
    const overwritten = new NodeSQLiteDatabase(backupPath, { readOnly: true });
    assert.equal(await overwritten.prepare("SELECT value FROM durable").first("value"), "new-snapshot");
    overwritten.close();
  }
  database.close();

  if (process.platform !== "win32") chmodSync(databasePath, 0o644);
  const beforeReadOnly = lstatSync(databasePath);
  const beforeBytes = readFileSync(databasePath);
  const readOnly = new NodeSQLiteDatabase(databasePath, { readOnly: true, createParentDirectory: false });
  assert.equal(await readOnly.prepare("SELECT value FROM durable WHERE id = 'a'").first("value"), "new-snapshot");
  await assert.rejects(() => readOnly.checkpoint(), /read-only/);
  assert.doesNotThrow(() => readOnly.close());
  const afterReadOnly = lstatSync(databasePath);
  assert.equal(afterReadOnly.mode, beforeReadOnly.mode);
  assert.equal(afterReadOnly.mtimeMs, beforeReadOnly.mtimeMs);
  assert.deepEqual(readFileSync(databasePath), beforeBytes);

  const missingParent = join(root, "must-not-be-created");
  assert.throws(() => new NodeSQLiteDatabase(join(missingParent, "missing.db"), { readOnly: true }));
  assert.equal(existsSync(missingParent), false);
  assert.throws(
    () => new NodeSQLiteDatabase(join(missingParent, "missing.db"), { readOnly: true, createParentDirectory: true }),
    /read-only.*cannot create/i,
  );
  assert.equal(existsSync(missingParent), false);

  const backup = new NodeSQLiteDatabase(backupPath, { readOnly: true });
  assert.equal(
    await backup.prepare("SELECT value FROM durable").first("value"),
    process.platform === "win32" ? "survives" : "new-snapshot",
  );
  backup.close();
}));

node24("all 23 authoritative migrations survive close/reopen with an exact checksummed ledger", async (t) => {
  const { NodeSQLiteDatabase } = databaseModule;
  const { migrateLocalDatabase, runLocalMigrations, DRIFTGLASS_LOCAL_MIGRATION_HEAD } = migrationsModule;
  const root = temporaryRoot(t, "driftglass-migrations-");
  const databasePath = join(root, "state", "driftglass.db");
  const result = await migrateLocalDatabase(databasePath, migrationsDirectory);
  assert.equal(result.schemaVersion, 23);
  assert.deepEqual(result.applied, Array.from({ length: 23 }, (_, index) => index + 1));
  assert.deepEqual(result.head, DRIFTGLASS_LOCAL_MIGRATION_HEAD);
  assert.equal(result.integrity.ok, true);

  let database = new NodeSQLiteDatabase(databasePath);
  assert.equal(await database.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first("value"), "23");
  assert.equal(await database.prepare("PRAGMA user_version").first("user_version"), 23);
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM __driftglass_local_migrations").first("count"), 23);
  const receiptHash = "ab".repeat(32);
  await database.batch([
    database
      .prepare(
        `INSERT INTO stories(id, canonical_key, title, summary, first_seen_at, last_changed_at, score)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("local-story", "portable-runtime", "Portable runtime", "A durable Story", "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z", 9.75),
    database
      .prepare("INSERT INTO missions(id, name, question, terms_json) VALUES (?, ?, ?, ?)")
      .bind("local-mission", "Local mission", "Will it persist?", '["portable","runtime"]'),
    database
      .prepare(
        `INSERT INTO memory_nodes(id, node_type, canonical_key, label, summary, metadata_json, importance)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("local-memory", "concept", "portable-runtime", "Portable Runtime", "Durable canonical memory", '{"origin":"restart-test"}', 0.875),
    database
      .prepare(
        `INSERT INTO intelligence_packs(id, name, version, manifest_json, enabled, budget_profile)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind("local-pack", "Local Pack", "1.2.3", '{"id":"local-pack","sources":["local"]}', true, "free"),
    database
      .prepare(
        `INSERT INTO reasoning_receipts(
           id, scope_kind, scope_id, task, target, title, objective,
           estimated_tokens, evidence_count, bundle_hash, bundle_r2_key, quality_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "local-receipt",
        "story",
        "local-story",
        "evaluate",
        "decision",
        "Evaluate portable runtime",
        "Preserve exact evidence state",
        Number.MAX_SAFE_INTEGER,
        3,
        receiptHash,
        "receipts/local-receipt.json",
        '{"coverage":"complete"}',
      ),
    database
      .prepare(
        `INSERT INTO decisions(
           id, mission_id, story_id, reasoning_receipt_id, title, statement,
           rationale, evidence_json, confidence, review_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "local-decision",
        "local-mission",
        "local-story",
        "local-receipt",
        "Keep local state",
        "Portable state survives restart",
        "Verified through a pinned receipt",
        '["local-receipt"]',
        0.8125,
        "2026-09-01T00:00:00.000Z",
      ),
  ]);
  database.close();

  database = new NodeSQLiteDatabase(databasePath);
  const persistedDomains = await database
    .prepare(
      `SELECT s.title AS story_title,
              m.name AS mission_name,
              n.summary AS memory_summary,
              n.importance AS memory_importance,
              p.manifest_json AS pack_manifest,
              p.enabled AS pack_enabled,
              r.bundle_hash AS receipt_hash,
              r.bundle_r2_key AS receipt_object_key,
              r.estimated_tokens AS receipt_tokens,
              d.statement AS decision_statement,
              d.confidence AS decision_confidence
       FROM decisions d
       JOIN stories s ON s.id = d.story_id
       JOIN missions m ON m.id = d.mission_id
       JOIN reasoning_receipts r ON r.id = d.reasoning_receipt_id
       JOIN memory_nodes n ON n.id = 'local-memory'
       JOIN intelligence_packs p ON p.id = 'local-pack'
       WHERE d.id = 'local-decision'`,
    )
    .first();
  assert.deepEqual(persistedDomains, {
    story_title: "Portable runtime",
    mission_name: "Local mission",
    memory_summary: "Durable canonical memory",
    memory_importance: 0.875,
    pack_manifest: '{"id":"local-pack","sources":["local"]}',
    pack_enabled: 1,
    receipt_hash: receiptHash,
    receipt_object_key: "receipts/local-receipt.json",
    receipt_tokens: Number.MAX_SAFE_INTEGER,
    decision_statement: "Portable state survives restart",
    decision_confidence: 0.8125,
  });
  const repeat = await runLocalMigrations(database, migrationsDirectory);
  assert.deepEqual(repeat.applied, []);
  assert.equal(repeat.schemaVersion, 23);
  database.close();
});

node24("migration transactions restart cleanly after preflight and mid-migration faults", async (t) => {
  const { NodeSQLiteDatabase } = databaseModule;
  const { runLocalMigrations, DRIFTGLASS_LOCAL_MIGRATION_MANIFEST } = migrationsModule;
  const root = temporaryRoot(t, "driftglass-migration-restart-");

  let database = new NodeSQLiteDatabase(join(root, "after-preflight.db"));
  await assert.rejects(
    () => runLocalMigrations(database, migrationsDirectory, DRIFTGLASS_LOCAL_MIGRATION_MANIFEST, {
      faultInjector(point, migration) {
        if (point === "after-transaction-start" && migration.version === 1) throw new Error("injected preflight crash");
      },
    }),
    /0001_initial\.sql failed/,
  );
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM __driftglass_local_migrations").first("count"), 0);
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'settings'").first("count"), 0);
  const preflightRestart = await runLocalMigrations(database, migrationsDirectory);
  assert.deepEqual(preflightRestart.applied, Array.from({ length: 23 }, (_, index) => index + 1));
  database.close();

  database = new NodeSQLiteDatabase(join(root, "mid-migration.db"));
  await assert.rejects(
    () => runLocalMigrations(database, migrationsDirectory, DRIFTGLASS_LOCAL_MIGRATION_MANIFEST, {
      faultInjector(point, migration) {
        if (point === "after-migration-sql" && migration.version === 23) throw new Error("injected mid-migration crash");
      },
    }),
    /0023_mission_match_evidence_index\.sql failed/,
  );
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM __driftglass_local_migrations").first("count"), 22);
  assert.equal(await database.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first("value"), "22");
  assert.equal(await database.prepare("PRAGMA user_version").first("user_version"), 22);
  assert.equal(
    await database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'idx_story_items_match_recent'").first("count"),
    0,
  );
  const midMigrationRestart = await runLocalMigrations(database, migrationsDirectory);
  assert.deepEqual(midMigrationRestart.applied, [23]);
  assert.equal(midMigrationRestart.schemaVersion, 23);
  database.close();
});

node24("an upgrade retains a verified pre-migration backup through post-migration validation", (t) => inBackupLane(async () => {
  const { NodeSQLiteDatabase } = databaseModule;
  const { migrateLocalDatabase, DRIFTGLASS_LOCAL_MIGRATION_MANIFEST } = migrationsModule;
  const root = temporaryRoot(t, "driftglass-migration-backup-", true);
  const version21Migrations = join(root, "migrations-21");
  cpSync(migrationsDirectory, version21Migrations, { recursive: true });
  unlinkSync(join(version21Migrations, "0022_source_ingest_producer_outbox.sql"));
  unlinkSync(join(version21Migrations, "0023_mission_match_evidence_index.sql"));
  const databasePath = join(root, "data", "state", "driftglass.db");
  const version21 = await migrateLocalDatabase(
    databasePath,
    version21Migrations,
    DRIFTGLASS_LOCAL_MIGRATION_MANIFEST.slice(0, 21),
  );
  assert.equal(version21.schemaVersion, 21);
  assert.equal(version21.preMigrationBackupPath, undefined);

  const upgraded = await migrateLocalDatabase(databasePath, migrationsDirectory);
  assert.equal(upgraded.schemaVersion, 23);
  assert.ok(upgraded.preMigrationBackupPath);
  assert.equal(existsSync(upgraded.preMigrationBackupPath), true, "validated upgrades retain their rollback backup");
  if (process.platform !== "win32") assert.equal(mode(upgraded.preMigrationBackupPath), 0o600);

  const backup = new NodeSQLiteDatabase(upgraded.preMigrationBackupPath, { readOnly: true });
  assert.equal(await backup.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first("value"), "21");
  assert.equal(await backup.prepare("PRAGMA user_version").first("user_version"), 21);
  assert.equal(await backup.prepare("SELECT COUNT(*) AS count FROM __driftglass_local_migrations").first("count"), 21);
  backup.close();

  const live = new NodeSQLiteDatabase(databasePath, { readOnly: true });
  assert.equal(await live.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first("value"), "23");
  live.close();
}));

node24("migration source drift, incomplete work, ledger disorder, and schema mismatch fail closed", async (t) => {
  const { NodeSQLiteDatabase } = databaseModule;
  const { migrateLocalDatabase, runLocalMigrations, DRIFTGLASS_LOCAL_MIGRATION_MANIFEST } = migrationsModule;
  const root = temporaryRoot(t, "driftglass-migration-failures-");
  const copiedMigrations = join(root, "migrations");
  cpSync(migrationsDirectory, copiedMigrations, { recursive: true });
  const first = join(copiedMigrations, "0001_initial.sql");
  writeFileSync(first, `${readFileSync(first, "utf8")}\n-- unauthorized drift\n`);
  const untouchedDatabase = join(root, "drift.db");
  await assert.rejects(() => migrateLocalDatabase(untouchedDatabase, copiedMigrations), /source drift/);
  assert.equal(existsSync(untouchedDatabase), false, "source drift must fail before opening the target database");

  const incompletePath = join(root, "incomplete.db");
  let database = new NodeSQLiteDatabase(incompletePath);
  await writeLedgerSchema(database);
  const expected = DRIFTGLASS_LOCAL_MIGRATION_MANIFEST[0];
  await database
    .prepare("INSERT INTO __driftglass_local_migrations(version, name, sha256, status, started_at) VALUES (?, ?, ?, 'applying', ?)")
    .bind(expected.version, expected.name, expected.sha256, new Date().toISOString())
    .run();
  await assert.rejects(() => runLocalMigrations(database, migrationsDirectory), /Incomplete local migration/);
  database.close();

  const multipleIncompletePath = join(root, "multiple-incomplete.db");
  database = new NodeSQLiteDatabase(multipleIncompletePath);
  await writeLedgerSchema(database);
  const firstExpected = DRIFTGLASS_LOCAL_MIGRATION_MANIFEST[0];
  const secondExpected = DRIFTGLASS_LOCAL_MIGRATION_MANIFEST[1];
  await database
    .prepare("INSERT INTO __driftglass_local_migrations(version, name, sha256, status, started_at) VALUES (?, ?, ?, 'applying', ?)")
    .bind(firstExpected.version, firstExpected.name, firstExpected.sha256, new Date().toISOString())
    .run();
  await database
    .prepare("INSERT INTO __driftglass_local_migrations(version, name, sha256, status, started_at) VALUES (?, ?, ?, 'applying', ?)")
    .bind(secondExpected.version, secondExpected.name, secondExpected.sha256, new Date().toISOString())
    .run();
  await assert.rejects(() => runLocalMigrations(database, migrationsDirectory), /Incomplete local migration/);
  database.close();

  const disorderPath = join(root, "disorder.db");
  database = new NodeSQLiteDatabase(disorderPath);
  await writeLedgerSchema(database);
  const second = DRIFTGLASS_LOCAL_MIGRATION_MANIFEST[1];
  await database
    .prepare("INSERT INTO __driftglass_local_migrations(version, name, sha256, status, started_at, applied_at) VALUES (?, ?, ?, 'applied', ?, ?)")
    .bind(2, second.name, second.sha256, new Date().toISOString(), new Date().toISOString())
    .run();
  await assert.rejects(() => runLocalMigrations(database, migrationsDirectory), /drift or out-of-order/);
  database.close();

  const mismatchPath = join(root, "mismatch.db");
  await migrateLocalDatabase(mismatchPath, migrationsDirectory);
  database = new NodeSQLiteDatabase(mismatchPath);
  await database.prepare("UPDATE settings SET value = '21' WHERE key = 'schema_version'").run();
  await assert.rejects(() => runLocalMigrations(database, migrationsDirectory), /schema\/ledger mismatch/);
  database.close();

  const untrackedPath = join(root, "untracked.db");
  database = new NodeSQLiteDatabase(untrackedPath);
  await database.exec("CREATE TABLE untracked_domain_state(id TEXT PRIMARY KEY)");
  await assert.rejects(() => runLocalMigrations(database, migrationsDirectory), /Refusing to create a migration ledger/);
  assert.equal(
    await database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = '__driftglass_local_migrations'").first("count"),
    0,
  );
  database.close();
});

node24("local object store survives restart with CAS blobs, metadata, conditions, and pagination", async (t) => {
  const { LocalObjectStore } = objectStoreModule;
  const root = temporaryRoot(t, "driftglass-objects-");
  const storePath = join(root, "store");
  let store = new LocalObjectStore(storePath);
  const first = await store.put("missions/a/evidence.json", '{"ok":true}', {
    httpMetadata: { contentType: "application/json", cacheExpiry: new Date("2030-01-01T00:00:00.000Z") },
    customMetadata: { provenance: "test" },
  });
  assert.equal(first.stored, true);
  await store.put("missions/b/evidence.json", '{"ok":true}');
  await store.put("missions/c/evidence.json", "different");
  assert.equal(filesBelow(join(storePath, "blobs", "sha256")).length, 2, "same content shares one CAS blob");

  const refused = await store.put("missions/a/evidence.json", "wrong", { onlyIf: { etagMatches: "not-the-etag" } });
  assert.deepEqual(refused, { stored: false, etag: first.etag });
  assert.equal((await store.put("missions/new", "x", { onlyIf: { etagDoesNotMatch: "*" } })).stored, true);
  assert.equal((await store.put("missions/new", "y", { onlyIf: { etagDoesNotMatch: "*" } })).stored, false);

  store = new LocalObjectStore(storePath);
  const object = await store.get("missions/a/evidence.json");
  assert.deepEqual(await object.json(), { ok: true });
  assert.equal(object.httpMetadata.contentType, "application/json");
  assert.equal(object.httpMetadata.cacheExpiry.toISOString(), "2030-01-01T00:00:00.000Z");
  assert.deepEqual(object.customMetadata, { provenance: "test" });
  const firstPage = await store.list({ prefix: "missions/", limit: 2 });
  assert.equal(firstPage.objects.length, 2);
  assert.equal(firstPage.truncated, true);
  const secondPage = await store.list({ prefix: "missions/", limit: 10, cursor: firstPage.cursor });
  assert.ok(secondPage.objects.length >= 2);
  assert.ok(secondPage.objects.every((entry) => entry.key > firstPage.objects[1].key));
  assert.equal((await store.verify()).ok, true);
  if (process.platform !== "win32") {
    assert.equal(mode(storePath), 0o700);
    for (const file of filesBelow(join(storePath, "keys"))) assert.equal(mode(file), 0o600);
  }
});

node24("object keys are OS-independent, fixed-path, streamed within bounds, and never traverse", async (t) => {
  const { LocalObjectStore, validateLogicalKey } = objectStoreModule;
  const root = temporaryRoot(t, "driftglass-object-security-");
  const storePath = join(root, "store");
  const store = new LocalObjectStore(storePath, { maxObjectBytes: 3 });
  for (const invalid of ["", "/absolute", "C:/absolute", "a\\b", "../x", "a/../b", "a//b", "a/", ".", `nul\0key`, "\ud800"]) {
    assert.throws(() => validateLogicalKey(invalid));
    await assert.rejects(() => store.put(invalid, "x"));
  }

  let cancelled = false;
  const oversized = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(() => store.put("bounded", oversized), /exceeds/);
  assert.equal(cancelled, true);
  assert.deepEqual(readdirSync(join(storePath, "tmp")), []);

  const manySegments = Array.from({ length: 300 }, () => "a").join("/");
  await store.put(manySegments, "ok");
  const metadataFile = filesBelow(join(storePath, "keys"))[0];
  assert.ok(relative(storePath, metadataFile).length < 100, "logical segment count must not expand the filesystem path");
  assert.equal(await (await store.get(manySegments)).text(), "ok");
});

node24("object store rejects symlink components and detects same-size blob corruption", async (t) => {
  const { LocalObjectStore } = objectStoreModule;
  const root = temporaryRoot(t, "driftglass-object-corruption-");
  const storePath = join(root, "store");
  const store = new LocalObjectStore(storePath);
  await store.put("safe/key", "hello");
  const blob = filesBelow(join(storePath, "blobs", "sha256"))[0];
  writeFileSync(blob, "jello", { mode: 0o600 });
  await assert.rejects(() => store.get("safe/key"), /SHA-256 mismatch/);
  assert.equal((await store.verify()).ok, false);

  const cleanPath = join(root, "symlink-store");
  const clean = new LocalObjectStore(cleanPath);
  await clean.put("safe/key", "hello");
  const metadata = filesBelow(join(cleanPath, "keys"))[0];
  const outside = join(root, "outside.json");
  writeFileSync(outside, readFileSync(metadata));
  unlinkSync(metadata);
  try {
    symlinkSync(outside, metadata, "file");
  } catch (error) {
    if (error?.code === "EPERM") return t.skip("symlinks require additional Windows privileges");
    throw error;
  }
  await assert.rejects(() => clean.list(), /symbolic|Unexpected object-index/);

  const actual = join(root, "actual-store");
  const linked = join(root, "linked-store");
  mkdirSync(actual);
  symlinkSync(actual, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => new LocalObjectStore(join(linked, "escaped")), /symbolic-link/);
  assert.equal(existsSync(join(actual, "escaped")), false);
});

node24("object lock and crash-temp recovery distinguish live owners from dead owners", async (t) => {
  const { LocalObjectStore } = objectStoreModule;
  const root = temporaryRoot(t, "driftglass-object-recovery-");
  const storePath = join(root, "store");
  let store = new LocalObjectStore(storePath, { tempMaxAgeMs: 1, lockStaleMs: 10, lockTimeoutMs: 60 });
  const temporary = join(storePath, "tmp");
  const liveTemp = join(temporary, `upload-${process.pid}-deadbeef.tmp`);
  const deadTemp = join(temporary, "upload-2147483647-deadbeef.tmp");
  writeFileSync(liveTemp, "live");
  writeFileSync(deadTemp, "dead");
  const old = new Date(Date.now() - 60_000);
  utimesSync(liveTemp, old, old);
  utimesSync(deadTemp, old, old);
  store = new LocalObjectStore(storePath, { tempMaxAgeMs: 1, lockStaleMs: 10, lockTimeoutMs: 60 });
  assert.equal(existsSync(liveTemp), true);
  assert.equal(existsSync(deadTemp), false);

  const lock = join(storePath, "locks", "store.lock");
  const owner = join(lock, "owner.json");
  mkdirSync(lock);
  writeFileSync(owner, JSON.stringify({ version: 1, pid: process.pid, token: "live", createdAt: old.toISOString() }));
  utimesSync(lock, old, old);
  await assert.rejects(() => store.put("blocked", "x"), /Timed out/);
  assert.equal(existsSync(lock), true, "a stale-looking live lock must not be stolen");
  unlinkSync(owner);
  rmdirSync(lock);

  mkdirSync(lock);
  writeFileSync(owner, JSON.stringify({ version: 1, pid: 2147483647, token: "dead", createdAt: old.toISOString() }));
  utimesSync(lock, old, old);
  assert.equal((await store.put("recovered", "x")).stored, true);
  assert.equal(existsSync(lock), false);
});

node24("concurrent stale-lock waiters serialize recovery and conditional writes", async (t) => {
  const { LocalObjectStore } = objectStoreModule;
  const root = temporaryRoot(t, "driftglass-object-recovery-race-");
  const storePath = join(root, "store");
  const options = { lockStaleMs: 5, lockTimeoutMs: 5_000 };
  new LocalObjectStore(storePath, options);

  const locks = join(storePath, "locks");
  const lock = join(locks, "store.lock");
  const owner = join(lock, "owner.json");
  const recoveryLock = join(locks, "store.recovery.lock");
  const recoveryOwner = join(recoveryLock, "owner.json");
  const old = new Date(Date.now() - 60_000);
  mkdirSync(lock);
  writeFileSync(owner, JSON.stringify({ version: 1, pid: 2147483647, token: "dead", createdAt: old.toISOString() }));
  utimesSync(lock, old, old);

  // Hold the recovery mutex long enough for every writer to reach the same
  // stale lock, then release them into the recovery/acquisition race together.
  mkdirSync(recoveryLock);
  writeFileSync(recoveryOwner, JSON.stringify({ version: 1, pid: process.pid, token: "barrier", createdAt: new Date().toISOString() }));
  const writers = Array.from({ length: 24 }, (_, index) => {
    const store = new LocalObjectStore(storePath, options);
    return store.put("exclusive/key", `writer-${index}`, { onlyIf: { etagDoesNotMatch: "*" } });
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  unlinkSync(recoveryOwner);
  rmdirSync(recoveryLock);

  const results = await Promise.all(writers);
  assert.equal(results.filter((result) => result.stored).length, 1, "exactly one absent-only write may commit");
  const winner = results.findIndex((result) => result.stored);
  const reopened = new LocalObjectStore(storePath, options);
  assert.equal(await (await reopened.get("exclusive/key")).text(), `writer-${winner}`);
  assert.equal(filesBelow(join(storePath, "blobs", "sha256")).length, 1);
  assert.deepEqual(readdirSync(locks), [], "neither recovery nor normal lock state may leak after success");
});

node24("an abandoned recovery mutex fails stale-lock recovery closed", async (t) => {
  const { LocalObjectStore } = objectStoreModule;
  const root = temporaryRoot(t, "driftglass-object-recovery-fail-closed-");
  const storePath = join(root, "store");
  const store = new LocalObjectStore(storePath, { lockStaleMs: 5, lockTimeoutMs: 80 });
  const locks = join(storePath, "locks");
  const lock = join(locks, "store.lock");
  const owner = join(lock, "owner.json");
  const recoveryLock = join(locks, "store.recovery.lock");
  const recoveryOwner = join(recoveryLock, "owner.json");
  const old = new Date(Date.now() - 60_000);
  mkdirSync(lock);
  writeFileSync(owner, JSON.stringify({ version: 1, pid: 2147483647, token: "dead", createdAt: old.toISOString() }));
  utimesSync(lock, old, old);
  mkdirSync(recoveryLock);
  writeFileSync(recoveryOwner, JSON.stringify({ version: 1, pid: 2147483647, token: "abandoned", createdAt: old.toISOString() }));
  utimesSync(recoveryLock, old, old);

  await assert.rejects(() => store.put("must-not-overlap", "x"), /Timed out/);
  assert.equal(existsSync(lock), true, "the stale lock must remain when recovery ownership is ambiguous");
  assert.equal(existsSync(recoveryLock), true, "recovery mutexes are never auto-stolen");
  assert.deepEqual(readdirSync(join(storePath, "tmp")), [], "a timed-out write must remove its staged body");
});

node24("object delete leaves CAS safely collectable and GC never follows symlinks", async (t) => {
  const { LocalObjectStore } = objectStoreModule;
  const root = temporaryRoot(t, "driftglass-object-gc-");
  const storePath = join(root, "store");
  const store = new LocalObjectStore(storePath);
  await store.put("one", "shared");
  await store.put("two", "shared");
  await store.delete("one");
  assert.equal((await store.garbageCollect({ dryRun: false, graceMs: 0 })).deletedBlobs, 0);
  await store.delete("two");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  const preview = await store.garbageCollect({ dryRun: true, graceMs: 0 });
  assert.equal(preview.candidates.length, 1);
  const collected = await store.garbageCollect({ dryRun: false, graceMs: 0 });
  assert.equal(collected.deletedBlobs, 1);
  assert.equal(collected.reclaimedBytes, 6);
  assert.equal((await store.verify()).ok, true);

  await store.put("symlink-gc", "target");
  const blob = filesBelow(join(storePath, "blobs", "sha256"))[0];
  const outside = join(root, "outside-blob");
  writeFileSync(outside, "target");
  unlinkSync(blob);
  try {
    symlinkSync(outside, blob, "file");
  } catch (error) {
    if (error?.code === "EPERM") return t.skip("symlinks require additional Windows privileges");
    throw error;
  }
  await assert.rejects(() => store.garbageCollect(), /Unexpected object blob/);
});
