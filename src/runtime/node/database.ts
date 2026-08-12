import {
  chmodSync,
  closeSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { platform } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { backup, DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  DatabasePort,
  DatabaseScalar,
  PreparedStatementPort,
  QueryResult,
} from "../ports";
import {
  assertNoSymlinkAncestors,
  assertPortableNodeRuntime,
  ensurePrivateFile,
  fsyncDirectory,
  fsyncFile,
  isMissingPathError,
} from "./layout";

type NodeDatabaseScalar = DatabaseScalar;
type NativeInput = null | number | bigint | string | Uint8Array;
type NativeOutput = null | number | bigint | string | Uint8Array;
type QueryRow = Record<string, unknown>;

export interface NodeSQLiteDatabaseOptions {
  readonly busyTimeoutMs?: number;
  readonly readOnly?: boolean;
  readonly createParentDirectory?: boolean;
}

export interface SQLiteCheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

export interface SQLiteIntegrityReport {
  readonly ok: boolean;
  readonly messages: readonly string[];
  readonly foreignKeyViolations: readonly QueryRow[];
}

export interface SQLiteBackupOptions {
  readonly overwrite?: boolean;
}

/**
 * File-backed Node 24.4+ SQLite adapter with D1-shaped, throwing statement APIs.
 * It is deliberately not exported from the runtime-neutral barrel.
 */
export class NodeSQLiteDatabase implements DatabasePort, Disposable {
  readonly path: string;
  readonly #native: DatabaseSync;
  readonly #readOnly: boolean;
  #closed = false;
  #batchSequence = 0;

  constructor(path: string, options: NodeSQLiteDatabaseOptions = {}) {
    assertPortableNodeRuntime();
    if (!path || path === ":memory:" || path.startsWith("file:")) {
      throw new TypeError("NodeSQLiteDatabase requires a file-system database path");
    }

    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 2_147_483_647) {
      throw new RangeError("busyTimeoutMs must be a non-negative 32-bit integer");
    }

    this.path = resolve(path);
    this.#readOnly = options.readOnly ?? false;
    if (this.#readOnly && options.createParentDirectory === true) {
      throw new TypeError("A read-only SQLite connection cannot create its parent directory");
    }
    const parent = dirname(this.path);
    prepareCallerSelectedParent(parent, options.createParentDirectory ?? !this.#readOnly, "database");
    try {
      const existing = lstatSync(this.path);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`Refusing symbolic-link or non-file database path: ${this.path}`);
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      if (this.#readOnly) throw new Error(`Read-only SQLite database does not exist: ${this.path}`, { cause: error });
      try {
        const descriptor = openSync(
          this.path,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600,
        );
        closeSync(descriptor);
      } catch (createError) {
        if (!(createError instanceof Error && "code" in createError && (createError as NodeJS.ErrnoException).code === "EEXIST")) {
          throw createError;
        }
        const raced = lstatSync(this.path);
        if (raced.isSymbolicLink() || !raced.isFile()) {
          throw new Error(`Refusing symbolic-link or non-file database path: ${this.path}`);
        }
      }
    }

    this.#native = new DatabaseSync(this.path, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readOnly: options.readOnly ?? false,
      timeout: busyTimeoutMs,
    });

    try {
      this.#native.enableLoadExtension(false);
      // enableDefensive() arrived after the Node 24 baseline. Use it when the
      // host provides it while retaining extension-disabled safety on Node 24.
      const defensive = (this.#native as DatabaseSync & { enableDefensive?: (active: boolean) => void })
        .enableDefensive;
      defensive?.call(this.#native, true);

      this.#native.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = ${busyTimeoutMs};
        PRAGMA synchronous = FULL;
      `);
      if (!(options.readOnly ?? false)) {
        const journal = this.#native.prepare("PRAGMA journal_mode = WAL").get() as
          | Record<string, NativeOutput>
          | undefined;
        if (String(journal?.journal_mode ?? "").toLowerCase() !== "wal") {
          throw new Error("SQLite refused WAL journal mode");
        }
      }
      const foreignKeys = this.#native.prepare("PRAGMA foreign_keys").get() as
        | Record<string, NativeOutput>
        | undefined;
      if (Number(foreignKeys?.foreign_keys) !== 1) {
        throw new Error("SQLite foreign-key enforcement is unavailable");
      }
      if (!this.#readOnly) ensurePrivateFile(this.path);
    } catch (error) {
      this.#native.close();
      throw error;
    }
  }

  prepare(sql: string): NodeSQLitePreparedStatement {
    this.assertOpen();
    if (typeof sql !== "string" || !sql.trim()) throw new TypeError("SQL must be a non-empty string");
    // Compile now so syntax and multi-statement errors match D1's eager prepare
    // behavior; each execution gets its own native statement configuration.
    this.#native.prepare(sql);
    return new NodeSQLitePreparedStatement(this, sql, []);
  }

  async batch<T = Record<string, unknown>>(
    statements: PreparedStatementPort[],
  ): Promise<QueryResult<T>[]> {
    this.assertOpen();
    if (!Array.isArray(statements)) throw new TypeError("batch statements must be an array");
    for (const statement of statements) {
      if (!(statement instanceof NodeSQLitePreparedStatement) || !statement.belongsTo(this)) {
        throw new TypeError("Every batch statement must belong to this NodeSQLiteDatabase");
      }
    }

    const savepoint = `driftglass_batch_${++this.#batchSequence}`;
    this.#native.exec(`SAVEPOINT ${savepoint}`);
    try {
      const results = statements.map((statement) =>
        (statement as NodeSQLitePreparedStatement).executeForBatch<T>(),
      );
      this.#native.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return results;
    } catch (error) {
      try {
        this.#native.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      } finally {
        this.#native.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    }
  }

  async exec(sql: string): Promise<QueryResult> {
    this.assertOpen();
    if (typeof sql !== "string" || !sql.trim()) throw new TypeError("SQL must be a non-empty string");
    const started = performance.now();
    const before = this.totalChanges();
    this.#native.exec(sql);
    const changes = this.totalChanges() - before;
    return {
      success: true,
      results: [],
      meta: {
        duration: performance.now() - started,
        changes: normalizeInteger(changes),
        rows_read: 0,
        rows_written: normalizeInteger(changes),
      },
    };
  }

  async checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "TRUNCATE"): Promise<SQLiteCheckpointResult> {
    this.assertOpen();
    if (this.#readOnly) throw new Error("A read-only SQLite connection cannot checkpoint the WAL");
    const accepted = new Set(["PASSIVE", "FULL", "RESTART", "TRUNCATE"]);
    if (!accepted.has(mode)) throw new TypeError(`Unsupported checkpoint mode: ${mode}`);
    const row = this.#native.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as
      | Record<string, NativeOutput>
      | undefined;
    if (!row) throw new Error("SQLite did not return a checkpoint result");
    return {
      busy: Number(row.busy ?? 0),
      log: Number(row.log ?? 0),
      checkpointed: Number(row.checkpointed ?? 0),
    };
  }

  async integrityCheck(): Promise<SQLiteIntegrityReport> {
    this.assertOpen();
    const statement = this.#native.prepare("PRAGMA integrity_check");
    statement.setReadBigInts(true);
    const rows = statement.all() as Record<string, NativeOutput>[];
    const messages = rows.map((row) => String(Object.values(row)[0] ?? ""));
    const foreignKeyStatement = this.#native.prepare("PRAGMA foreign_key_check");
    foreignKeyStatement.setReadBigInts(true);
    const violations = foreignKeyStatement.all().map(normalizeRecord);
    return {
      ok: messages.length === 1 && messages[0] === "ok" && violations.length === 0,
      messages,
      foreignKeyViolations: violations,
    };
  }

  async backupTo(destination: string, options: SQLiteBackupOptions = {}): Promise<string> {
    this.assertOpen();
    const target = resolve(destination);
    if (target === this.path) throw new Error("Backup destination must differ from the live database");
    const parent = dirname(target);
    prepareCallerSelectedParent(parent, true, "backup");
    try {
      const targetStat = lstatSync(target);
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw new Error(`Refusing symbolic-link or non-file backup target: ${target}`);
      }
      if (!options.overwrite) throw new Error(`Backup target already exists: ${target}`);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    if (options.overwrite && platform() === "win32") {
      throw new Error("Atomic backup overwrite is unavailable on Windows; choose a new destination path");
    }
    if (!this.#readOnly) await this.checkpoint("FULL");
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      );
      closeSync(descriptor);
      await backup(this.#native, temporary, { rate: 100 });
      ensurePrivateFile(temporary);
      fsyncFile(temporary);
      if (options.overwrite) {
        renameSync(temporary, target);
      } else {
        linkSync(temporary, target);
        unlinkSync(temporary);
      }
      ensurePrivateFile(target);
      fsyncDirectory(parent);
      return target;
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    try {
      if (!this.#readOnly && !this.#native.isTransaction) this.#native.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      this.#native.close();
      this.#closed = true;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  assertOpen(): void {
    if (this.#closed) throw new Error("NodeSQLiteDatabase is closed");
  }

  compile(sql: string): StatementSync {
    this.assertOpen();
    const statement = this.#native.prepare(sql);
    statement.setReadBigInts(true);
    statement.setAllowBareNamedParameters(false);
    statement.setAllowUnknownNamedParameters(false);
    return statement;
  }

  totalChanges(): bigint {
    const statement = this.#native.prepare("SELECT total_changes() AS value");
    statement.setReadBigInts(true);
    const row = statement.get() as Record<string, NativeOutput> | undefined;
    return nativeInteger(row?.value, "total_changes");
  }

  lastInsertRowId(): number {
    const statement = this.#native.prepare("SELECT last_insert_rowid() AS value");
    statement.setReadBigInts(true);
    const row = statement.get() as Record<string, NativeOutput> | undefined;
    return normalizeInteger(nativeInteger(row?.value, "last_insert_rowid"));
  }
}

export class NodeSQLitePreparedStatement implements PreparedStatementPort {
  readonly #database: NodeSQLiteDatabase;
  readonly #sql: string;
  readonly #values: readonly NativeInput[];

  constructor(database: NodeSQLiteDatabase, sql: string, values: readonly NativeInput[]) {
    this.#database = database;
    this.#sql = sql;
    this.#values = Object.freeze(values.map(cloneNativeInput));
  }

  bind(...values: NodeDatabaseScalar[]): NodeSQLitePreparedStatement {
    return new NodeSQLitePreparedStatement(this.#database, this.#sql, values.map(normalizeInput));
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const statement = this.#database.compile(this.#sql);
    const hasColumns = statement.columns().length > 0;
    if (!hasColumns) {
      statement.run(...this.#values);
      return null;
    }
    const row = statement.get(...this.#values);
    if (!row) return null;
    const normalized = normalizeRecord(row);
    if (column === undefined) return normalized as T;
    if (!Object.hasOwn(normalized, column)) throw new Error(`Query result has no column named ${column}`);
    return normalized[column] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<QueryResult<T>> {
    return this.execute<T>("all");
  }

  async run<T = Record<string, unknown>>(): Promise<QueryResult<T>> {
    return this.execute<T>("run");
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const statement = this.#database.compile(this.#sql);
    statement.setReturnArrays(true);
    const rows = statement.all(...this.#values) as unknown as NativeOutput[][];
    return rows.map((row) => row.map(normalizeOutput) as T);
  }

  belongsTo(database: NodeSQLiteDatabase): boolean {
    return this.#database === database;
  }

  executeForBatch<T>(): QueryResult<T> {
    return this.execute<T>("run");
  }

  private execute<T>(mode: "all" | "run"): QueryResult<T> {
    const started = performance.now();
    const statement = this.#database.compile(this.#sql);
    const hasColumns = statement.columns().length > 0;
    const before = this.#database.totalChanges();
    let results: QueryRow[] = [];
    let lastRowId: number | undefined;

    if (hasColumns) {
      results = statement.all(...this.#values).map(normalizeRecord);
      lastRowId = this.#database.lastInsertRowId();
    } else if (mode === "all" || mode === "run") {
      const mutation = statement.run(...this.#values);
      lastRowId = normalizeInteger(BigInt(mutation.lastInsertRowid));
    }

    const changes = this.#database.totalChanges() - before;
    return {
      success: true,
      results: results as T[],
      meta: {
        duration: performance.now() - started,
        changes: normalizeInteger(changes),
        last_row_id: lastRowId,
        rows_read: results.length,
        rows_written: normalizeInteger(changes),
      },
    };
  }
}

function normalizeInput(value: NodeDatabaseScalar): NativeInput {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") {
    throw new TypeError("BigInt is not a portable D1/SQLite bound value; use a safe integer or string codec");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("SQLite numbers must be finite");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new RangeError("Unsafe integer input is outside the portable D1/SQLite value range");
    }
    return value;
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new TypeError("Unsupported SQLite bound value");
}

function cloneNativeInput(value: NativeInput): NativeInput {
  return value instanceof Uint8Array ? new Uint8Array(value) : value;
}

function normalizeRecord(record: Record<string, NativeOutput>): QueryRow {
  const normalized: QueryRow = {};
  for (const [key, value] of Object.entries(record)) normalized[key] = normalizeOutput(value);
  return normalized;
}

function normalizeOutput(value: NativeOutput): unknown {
  if (typeof value === "bigint") return normalizeInteger(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  return value;
}

function normalizeInteger(value: bigint): number {
  if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  throw new RangeError("SQLite returned an integer outside the portable D1/SQLite safe range");
}

function nativeInteger(value: NativeOutput | undefined, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`SQLite returned a non-integer ${label} value`);
}

function prepareCallerSelectedParent(parent: string, create: boolean, label: string): void {
  assertNoSymlinkAncestors(parent, create);
  try {
    const existing = lstatSync(parent);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Refusing symbolic-link or non-directory ${label} parent: ${parent}`);
    }
    // Existing caller-selected directories may be shared; never chmod them.
    return;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    if (!create) throw error;
  }

  const firstCreated = mkdirSync(parent, { recursive: true, mode: 0o700 });
  const created = lstatSync(parent);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Refusing symbolic-link or non-directory ${label} parent: ${parent}`);
  }
  // chmod only when this call actually created part of the requested path.
  if (firstCreated !== undefined) chmodSync(parent, 0o700);
}
