import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { NodeSQLiteDatabase, type SQLiteIntegrityReport } from "./database";
import { assertNoSymlinkAncestors } from "./layout";

const LEDGER_TABLE = "__driftglass_local_migrations";
const MIGRATION_NAME = /^(\d{4})_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/;

export interface LocalMigrationExpectation {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
}

export interface LocalMigration extends LocalMigrationExpectation {
  readonly sql: string;
}

export interface LocalMigrationResult {
  readonly schemaVersion: number;
  readonly head: LocalMigrationExpectation;
  readonly applied: readonly number[];
  readonly integrity: SQLiteIntegrityReport;
  readonly preMigrationBackupPath?: string;
}

export type LocalMigrationFaultPoint = "after-transaction-start" | "after-migration-sql";

export interface LocalMigrationRunOptions {
  /** Test/validation seam: throwing here must leave no durable partial migration. */
  readonly faultInjector?: (
    point: LocalMigrationFaultPoint,
    migration: LocalMigrationExpectation,
  ) => void | Promise<void>;
}

export interface LocalMigrationFileOptions extends LocalMigrationRunOptions {
  readonly backupDirectory?: string;
}

export class LocalMigrationFailure extends Error {
  readonly preMigrationBackupPath?: string;

  constructor(message: string, options: { cause: unknown; preMigrationBackupPath?: string }) {
    super(message, { cause: options.cause });
    this.name = "LocalMigrationFailure";
    this.preMigrationBackupPath = options.preMigrationBackupPath;
  }
}

/**
 * Release-pinned checksums for every authoritative migrations/*.sql byte.
 * A changed historical file fails before the local database is touched.
 */
export const DRIFTGLASS_LOCAL_MIGRATION_MANIFEST: readonly LocalMigrationExpectation[] = Object.freeze([
  { version: 1, name: "0001_initial.sql", sha256: "88fcf765451d8e51b41af97587c21d2e8462911dc8b2b561c3cd1bcf9a1951cd" },
  { version: 2, name: "0002_agent_week.sql", sha256: "bdea405eddbd68872e35b088aeb909d3b369417f7cc0d43d43da5a8fbc603275" },
  { version: 3, name: "0003_intelligence_missions.sql", sha256: "eb9d99d4dd0e29396bbddd17bcce9a6b5099c38981adf3534be349c1a92df17e" },
  { version: 4, name: "0004_public_intelligence.sql", sha256: "a99676be5ea193d36579202e77a8adf4c39f8c99bb4faca2b351c98173e14332" },
  { version: 5, name: "0005_personalization.sql", sha256: "249f81e7c07bd1a7edc28d170ce36cf8c2f25c06cf7d3fe2cd27d3b5bcf145b8" },
  { version: 6, name: "0006_mission_sprints.sql", sha256: "4634a8517a3ff567180314b07d9d29dc6a0936a8d23b8385d2876b89a54e5154" },
  { version: 7, name: "0007_mission_operators.sql", sha256: "9b9894c773ab4f0136a0ed0a0a42c11f5a37bebc56013d7b0b2edded5a022c06" },
  { version: 8, name: "0008_feature_complete.sql", sha256: "a0e1b402c5ff9147f3efdb30f847425c6475668917bd9af14b29dbcff5c112c1" },
  { version: 9, name: "0009_memory_graph_and_packs.sql", sha256: "9a508351bc93813785070181e5da5b847c22f3f899f2c5d8bb2a6f4a107add13" },
  { version: 10, name: "0010_reasoning_memory.sql", sha256: "aa66b79f9c6e86e77e7a37357c3b3fe97824369e0ed103786efe7ba769822038" },
  { version: 11, name: "0011_context_compiler_and_playbooks.sql", sha256: "e7c89c9dd5deb6a75b19446838d19de4e103f313b8786750949151127ce04233" },
  { version: 12, name: "0012_memory_graph_workflow.sql", sha256: "c19449fe496c5f6882d0a4223b9d5202360dd15b1a334076821d0146c74e27d2" },
  { version: 13, name: "0013_runtime_fabric.sql", sha256: "17dfa2ca192c7dd84a92b21f103b43e247b127f3b2a0d6448b564ce4d89fc100" },
  { version: 14, name: "0014_judgment_loop.sql", sha256: "ab575acd474d5159f45d5b895359166648a485e1b6fdefc2b8090dce2eb33e06" },
  { version: 15, name: "0015_reasoning_ledger.sql", sha256: "0841978ce11b3157c92891197da9e2d4a6dc148cf5f0251940f14b55734df2d9" },
  { version: 16, name: "0016_evidence_lineage.sql", sha256: "ebfca93540ee25def936805321066716fb0b2233651ce3332dacf73e9ba4b29f" },
  { version: 17, name: "0017_pack_overlays_and_adaptive_cadence.sql", sha256: "4f078aab360e568e48b494eb2c53131e7bd907acfd6c32f645573b8a408af0f4" },
  { version: 18, name: "0018_email_receipt_idempotency.sql", sha256: "8f9d45b9eecef6161e236f129126fd0b4bd20242338d2ceca6d934ab79c204ef" },
  { version: 19, name: "0019_queue_ingest_durability.sql", sha256: "bd960ae99ae3fa037a310a884e60a2ee326b49a57a8977da958fbac551ffac55" },
  { version: 20, name: "0020_ingest_completion_state.sql", sha256: "cbb9758beab5907c4baa5dc7884ee28e9d31064e45448f04eed63bfa45c82770" },
  { version: 21, name: "0021_ingest_deadletter_retry_claims.sql", sha256: "3925521fa02616112fafb0cfbe99534caf40dd24f9d6b7acfb1696e8f2de2617" },
  { version: 22, name: "0022_source_ingest_producer_outbox.sql", sha256: "86da63ea8b94e5fa8d55fb5aaa40693b696278822b4324b73561c098b0446ec8" },
  { version: 23, name: "0023_mission_match_evidence_index.sql", sha256: "7eb43cc5709f0e63f0428a07e4ca99d181bc5f9841e32153ce3e861d0382921c" },
].map((entry) => Object.freeze(entry)));

export const DRIFTGLASS_LOCAL_MIGRATION_HEAD =
  DRIFTGLASS_LOCAL_MIGRATION_MANIFEST[DRIFTGLASS_LOCAL_MIGRATION_MANIFEST.length - 1]!;

export function loadLocalMigrations(directory: string): readonly LocalMigration[] {
  const root = resolve(directory);
  assertNoSymlinkAncestors(root);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Refusing non-directory or symbolic-link migration path: ${root}`);
  }

  const migrations: LocalMigration[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    const info = lstatSync(file);
    if (info.isSymbolicLink()) throw new Error(`Refusing symbolic-link migration file: ${file}`);
    if (!entry.name.endsWith(".sql")) continue;
    if (!info.isFile()) throw new Error(`Refusing non-file migration: ${file}`);
    const match = MIGRATION_NAME.exec(entry.name);
    if (!match) throw new Error(`Invalid migration filename: ${entry.name}`);
    const version = Number(match[1]);
    const bytes = readFileSync(file);
    migrations.push(Object.freeze({
      version,
      name: entry.name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sql: bytes.toString("utf8"),
    }));
  }
  migrations.sort((left, right) => left.version - right.version || left.name.localeCompare(right.name));
  if (migrations.length === 0) throw new Error("No local migrations were found");
  for (let index = 0; index < migrations.length; index += 1) {
    const expectedVersion = index + 1;
    if (migrations[index]!.version !== expectedVersion) {
      throw new Error(`Local migrations must be contiguous and ordered from 1; expected ${expectedVersion}`);
    }
  }
  return Object.freeze(migrations);
}

export async function migrateLocalDatabase(
  databasePath: string,
  migrationsDirectory: string,
  expected: readonly LocalMigrationExpectation[] = DRIFTGLASS_LOCAL_MIGRATION_MANIFEST,
  options: LocalMigrationFileOptions = {},
): Promise<LocalMigrationResult> {
  // Validate release bytes before opening or creating the target database.
  verifySourceManifest(loadLocalMigrations(migrationsDirectory), expected);
  const targetExisted = existsSync(resolve(databasePath));
  const database = new NodeSQLiteDatabase(databasePath);
  let preMigrationBackupPath: string | undefined;
  try {
    if (targetExisted && (await databaseNeedsMigration(database, expected.length))) {
      const preMigrationIdentity = await readMigrationIdentity(database);
      const databaseDirectory = dirname(resolve(databasePath));
      const dataRoot = basename(databaseDirectory) === "state" ? dirname(databaseDirectory) : databaseDirectory;
      const backupDirectory = resolve(options.backupDirectory ?? join(dataRoot, "backups"));
      preMigrationBackupPath = join(
        backupDirectory,
        `pre-migration-${Date.now()}-${randomUUID()}.sqlite3`,
      );
      await database.backupTo(preMigrationBackupPath);
      await verifyPreMigrationBackup(preMigrationBackupPath, preMigrationIdentity);
    }
    const result = await runLocalMigrations(database, migrationsDirectory, expected, options);
    return {
      ...result,
      ...(preMigrationBackupPath ? { preMigrationBackupPath } : {}),
    };
  } catch (error) {
    throw new LocalMigrationFailure(
      preMigrationBackupPath
        ? `Local migration failed; the pre-migration backup is retained at ${preMigrationBackupPath}`
        : "Local migration failed before a pre-migration backup was required",
      { cause: error, preMigrationBackupPath },
    );
  } finally {
    database.close();
  }
}

/**
 * Low-level no-backup primitive for tests and controlled recovery only.
 * Normal startup upgrades must use migrateLocalDatabase(), which retains and
 * verifies a pre-migration backup before it calls this exclusive runner.
 */
export async function runLocalMigrations(
  database: NodeSQLiteDatabase,
  migrationsDirectory: string,
  expected: readonly LocalMigrationExpectation[] = DRIFTGLASS_LOCAL_MIGRATION_MANIFEST,
  options: LocalMigrationRunOptions = {},
): Promise<LocalMigrationResult> {
  const migrations = loadLocalMigrations(migrationsDirectory);
  verifySourceManifest(migrations, expected);
  await ensureLedger(database);
  const ledger = await readLedger(database);
  await verifyLedgerPrefix(database, ledger, migrations);

  const applied: number[] = [];
  for (const migration of migrations.slice(ledger.length)) {
    const startedAt = new Date().toISOString();
    await database.exec("BEGIN IMMEDIATE");
    try {
      await database
        .prepare(`INSERT INTO ${LEDGER_TABLE}(version, name, sha256, status, started_at) VALUES (?, ?, ?, 'applying', ?)`)
        .bind(migration.version, migration.name, migration.sha256, startedAt)
        .run();
      await options.faultInjector?.("after-transaction-start", migration);
      await database.exec(migration.sql);
      await options.faultInjector?.("after-migration-sql", migration);
      const schemaVersion = await readDomainSchemaVersion(database);
      if (schemaVersion !== migration.version) {
        throw new Error(
          `${migration.name} declared domain schema ${schemaVersion ?? "missing"}; expected ${migration.version}`,
        );
      }
      await database.exec(`PRAGMA user_version = ${migration.version}`);
      const completedAt = new Date().toISOString();
      await database
        .prepare(
          `UPDATE ${LEDGER_TABLE}
           SET status = 'applied', applied_at = ?
           WHERE version = ? AND status = 'applying'`,
        )
        .bind(completedAt, migration.version)
        .run();
      await database.exec("COMMIT");
      applied.push(migration.version);
    } catch (error) {
      try {
        await database.exec("ROLLBACK");
      } catch {
        // Preserve the migration error. Closing the connection still rolls
        // back the transaction, including its non-durable applying row.
      }
      throw new Error(`Local migration ${migration.name} failed`, { cause: error });
    }
  }

  const finalLedger = await readLedger(database);
  await verifyLedgerPrefix(database, finalLedger, migrations, true);
  const head = expected[expected.length - 1]!;
  const schemaVersion = await readDomainSchemaVersion(database);
  if (schemaVersion !== head.version) throw new Error("Local database did not reach the pinned schema head");
  const integrity = await database.integrityCheck();
  if (!integrity.ok) throw new Error(`Local database integrity check failed: ${integrity.messages.join("; ")}`);
  await database.checkpoint("FULL");
  return { schemaVersion, head, applied, integrity };
}

async function databaseNeedsMigration(database: NodeSQLiteDatabase, expectedCount: number): Promise<boolean> {
  const table = await database
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .bind(LEDGER_TABLE)
    .first<{ present: number }>();
  if (!table) return true;
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS count,
              SUM(CASE WHEN status = 'applied' AND applied_at IS NOT NULL THEN 1 ELSE 0 END) AS applied
       FROM ${LEDGER_TABLE}`,
    )
    .first<{ count: number; applied: number }>();
  return !row || row.count !== expectedCount || row.applied !== expectedCount;
}

interface MigrationIdentity {
  readonly userVersion: number;
  readonly schemaVersion: number | null;
  readonly ledgerPresent: boolean;
  readonly ledgerRows: readonly Record<string, unknown>[];
}

async function readMigrationIdentity(database: NodeSQLiteDatabase): Promise<MigrationIdentity> {
  const ledger = await database
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .bind(LEDGER_TABLE)
    .first<{ present: number }>();
  const ledgerRows = ledger
    ? (
        await database
          .prepare(
            `SELECT version, name, sha256, status, started_at, applied_at
             FROM ${LEDGER_TABLE}
             ORDER BY version`,
          )
          .all<Record<string, unknown>>()
      ).results
    : [];
  return {
    userVersion: await readUserVersion(database),
    schemaVersion: await readDomainSchemaVersion(database),
    ledgerPresent: Boolean(ledger),
    ledgerRows,
  };
}

async function verifyPreMigrationBackup(path: string, expected: MigrationIdentity): Promise<void> {
  const backup = new NodeSQLiteDatabase(path, { readOnly: true, createParentDirectory: false });
  try {
    const integrity = await backup.integrityCheck();
    if (!integrity.ok) throw new Error(`Pre-migration backup integrity failed: ${integrity.messages.join("; ")}`);
    const actual = await readMigrationIdentity(backup);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("Pre-migration backup ledger/schema identity does not match the live database");
    }
  } finally {
    backup.close();
  }
}

function verifySourceManifest(
  migrations: readonly LocalMigration[],
  expected: readonly LocalMigrationExpectation[],
): void {
  if (expected.length === 0) throw new Error("The expected local migration manifest is empty");
  if (migrations.length !== expected.length) {
    throw new Error(`Local migration head mismatch: found ${migrations.length}, expected ${expected.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = migrations[index]!;
    const pinned = expected[index]!;
    if (actual.version !== pinned.version || actual.name !== pinned.name || actual.sha256 !== pinned.sha256) {
      throw new Error(`Local migration source drift at version ${pinned.version}: ${actual.name}`);
    }
  }
}

async function ensureLedger(database: NodeSQLiteDatabase): Promise<void> {
  const existing = await database
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .bind(LEDGER_TABLE)
    .first<{ present: number }>();
  if (!existing) {
    const schemaVersion = await readDomainSchemaVersion(database);
    const userVersion = await readUserVersion(database);
    if (schemaVersion !== null || userVersion !== 0 || (await hasUntrackedDomainTables(database))) {
      throw new Error("Refusing to create a migration ledger over an untracked or partially migrated database");
    }
  }
  await database.exec(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      status TEXT NOT NULL CHECK(status IN ('applying', 'applied')),
      started_at TEXT NOT NULL,
      applied_at TEXT
    );
  `);
}

interface LedgerRow {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
  readonly status: "applying" | "applied";
  readonly started_at: string;
  readonly applied_at: string | null;
}

async function readLedger(database: NodeSQLiteDatabase): Promise<readonly LedgerRow[]> {
  const result = await database
    .prepare(`SELECT version, name, sha256, status, started_at, applied_at FROM ${LEDGER_TABLE} ORDER BY version`)
    .all<LedgerRow>();
  return result.results;
}

async function verifyLedgerPrefix(
  database: NodeSQLiteDatabase,
  ledger: readonly LedgerRow[],
  migrations: readonly LocalMigration[],
  requireHead = false,
): Promise<void> {
  if (ledger.length > migrations.length || (requireHead && ledger.length !== migrations.length)) {
    throw new Error("Local migration ledger does not match the pinned head");
  }
  for (let index = 0; index < ledger.length; index += 1) {
    const row = ledger[index]!;
    const migration = migrations[index]!;
    if (row.status !== "applied" || row.applied_at === null) {
      throw new Error(`Incomplete local migration detected at version ${row.version}`);
    }
    if (row.version !== index + 1 || row.name !== migration.name || row.sha256 !== migration.sha256) {
      throw new Error(`Local migration ledger drift or out-of-order entry at version ${row.version}`);
    }
  }

  const schemaVersion = await readDomainSchemaVersion(database);
  const userVersion = await readUserVersion(database);
  if (ledger.length === 0) {
    if (schemaVersion !== null || userVersion !== 0 || (await hasUntrackedDomainTables(database))) {
      throw new Error("Refusing an untracked or partially migrated local database");
    }
    return;
  }
  const expectedVersion = ledger[ledger.length - 1]!.version;
  if (schemaVersion !== expectedVersion || userVersion !== expectedVersion) {
    throw new Error(
      `Local schema/ledger mismatch: settings=${schemaVersion ?? "missing"}, user_version=${userVersion}, ledger=${expectedVersion}`,
    );
  }
}

async function readDomainSchemaVersion(database: NodeSQLiteDatabase): Promise<number | null> {
  const table = await database
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'settings'")
    .first<{ present: number }>();
  if (!table) return null;
  const row = await database.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first<{ value: string }>();
  if (!row || !/^\d+$/.test(row.value)) return null;
  const version = Number(row.value);
  return Number.isSafeInteger(version) ? version : null;
}

async function readUserVersion(database: NodeSQLiteDatabase): Promise<number> {
  const row = await database.prepare("PRAGMA user_version").first<{ user_version: number }>();
  if (!row || !Number.isSafeInteger(row.user_version) || row.user_version < 0) {
    throw new Error("Invalid SQLite user_version");
  }
  return row.user_version;
}

async function hasUntrackedDomainTables(database: NodeSQLiteDatabase): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_schema
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name <> ?`,
    )
    .bind(LEDGER_TABLE)
    .first<{ count: number }>();
  return (row?.count ?? 0) > 0;
}
