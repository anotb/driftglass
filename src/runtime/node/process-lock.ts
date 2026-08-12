import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  ensurePrivateFile,
  fsyncDirectory,
  isMissingPathError,
  type LocalDataLayout,
} from "./layout";

const LOCK_FILE = "selfhost.lock";
const MAX_LOCK_BYTES = 4 * 1024;

interface LockRecord {
  readonly format: "driftglass-local-process-lock";
  readonly version: 1;
  readonly pid: number;
  readonly purpose: "serve" | "backup" | "init" | "restore";
  readonly token: string;
  readonly startedAt: string;
}

export interface LocalRuntimeLease {
  readonly path: string;
  readonly purpose: LockRecord["purpose"];
  release(): void;
}

function lockPath(layout: LocalDataLayout): string {
  const path = resolve(layout.runtimeDirectory, LOCK_FILE);
  if (dirname(path) !== resolve(layout.runtimeDirectory)) throw new Error("Runtime lock path escaped its managed directory");
  return path;
}

function parseRecord(path: string): { record: LockRecord; dev: number | bigint; ino: number | bigint; body: string } {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0n || info.size > BigInt(MAX_LOCK_BYTES)) {
    throw new Error(`Refusing invalid self-host process lock: ${path}`);
  }
  const body = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error(`Self-host process lock is not valid JSON: ${path}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Self-host process lock must be an object");
  const record = value as Record<string, unknown>;
  if (
    record.format !== "driftglass-local-process-lock"
    || record.version !== 1
    || typeof record.pid !== "number"
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || !["serve", "backup", "init", "restore"].includes(String(record.purpose))
    || typeof record.token !== "string"
    || !/^[0-9a-f-]{36}$/i.test(record.token)
    || typeof record.startedAt !== "string"
    || !Number.isFinite(Date.parse(record.startedAt))
  ) throw new Error("Self-host process lock failed verification");
  return {
    record: record as unknown as LockRecord,
    dev: info.dev,
    ino: info.ino,
    body,
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function clearStaleLock(path: string, observed: ReturnType<typeof parseRecord>): void {
  const current = parseRecord(path);
  if (current.dev !== observed.dev || current.ino !== observed.ino || current.body !== observed.body) {
    throw new Error("Self-host process lock changed while checking its owner");
  }
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

/**
 * Serialize the single-process local writer and maintenance operations.
 * A killed process leaves a recoverable, PID-checked stale record.
 */
export function acquireLocalRuntimeLease(
  layout: LocalDataLayout,
  purpose: LockRecord["purpose"],
): LocalRuntimeLease {
  const path = lockPath(layout);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "EEXIST" || attempt > 0) throw error;
      const existing = parseRecord(path);
      if (processAlive(existing.record.pid)) {
        throw new Error(
          `Local data is already locked for ${existing.record.purpose} by PID ${existing.record.pid}`,
        );
      }
      clearStaleLock(path, existing);
      continue;
    }

    const record: LockRecord = Object.freeze({
      format: "driftglass-local-process-lock",
      version: 1,
      pid: process.pid,
      purpose,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    });
    const body = `${JSON.stringify(record)}\n`;
    try {
      writeFileSync(descriptor, body, "utf8");
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.size !== Buffer.byteLength(body)) throw new Error("Local process lock write was incomplete");
      fsyncSync(descriptor);
    } catch (error) {
      closeSync(descriptor);
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (!isMissingPathError(unlinkError)) throw unlinkError;
      }
      throw error;
    }
    closeSync(descriptor);
    ensurePrivateFile(path);
    fsyncDirectory(dirname(path));

    let released = false;
    return Object.freeze({
      path,
      purpose,
      release(): void {
        if (released) return;
        const current = parseRecord(path);
        if (current.record.pid !== process.pid || current.record.token !== record.token) {
          throw new Error("Refusing to release a process lock now owned by another process");
        }
        unlinkSync(path);
        fsyncDirectory(dirname(path));
        released = true;
      },
    });
  }
  throw new Error("Could not acquire local runtime lease");
}
