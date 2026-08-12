import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import type { CanonicalAuthorityReceipt } from "../ports";
import {
  establishRestoredLocalAuthority,
  loadVerifiedLocalAuthority,
  verifyCanonicalAuthorityReceipt,
  type InitializedLocalAuthority,
} from "./authority";
import { NodeSQLiteDatabase } from "./database";
import {
  assertNoSymlinkAncestors,
  assertPathWithin,
  createLocalDataLayout,
  ensurePrivateDirectory,
  ensurePrivateFile,
  fsyncDirectory,
  fsyncFile,
  type LocalDataLayout,
} from "./layout";
import { DRIFTGLASS_LOCAL_MIGRATION_HEAD } from "./migrations";
import { LocalObjectStore } from "./object-store";
import { acquireLocalRuntimeLease } from "./process-lock";

const BACKUP_FORMAT = "driftglass-local-operational-backup";
const BACKUP_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
const DATABASE_ARCHIVE_PATH = "state/driftglass.sqlite3";
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

interface BackupFileRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LocalBackupManifest {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: typeof BACKUP_VERSION;
  readonly createdAt: string;
  readonly appVersion: string;
  readonly profile: "selfhost";
  readonly schemaVersion: number;
  readonly migrationHead: string;
  readonly sourceAuthority: CanonicalAuthorityReceipt;
  readonly files: readonly BackupFileRecord[];
}

export interface VerifiedLocalBackup {
  readonly directory: string;
  readonly manifest: LocalBackupManifest;
  readonly manifestSha256: string;
  readonly bytes: number;
}

export interface RestoredLocalBackup extends VerifiedLocalBackup {
  readonly layout: LocalDataLayout;
  readonly authority: InitializedLocalAuthority;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function migrationHeadIdentity(): string {
  return `${DRIFTGLASS_LOCAL_MIGRATION_HEAD.name}:${DRIFTGLASS_LOCAL_MIGRATION_HEAD.sha256}`;
}

function assertArchivePath(value: string): string {
  if (
    !value
    || value.includes("\\")
    || value.includes("\0")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Backup manifest contains an unsafe archive path: ${JSON.stringify(value)}`);
  }
  return value;
}

function archivePath(root: string, archive: string): string {
  const safe = assertArchivePath(archive);
  const path = resolve(root, ...safe.split("/"));
  assertPathWithin(root, path);
  return path;
}

function assertRegularFile(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Backup contains a symbolic link or non-file entry: ${path}`);
  }
}

function assertDirectory(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Backup contains a symbolic link or non-directory entry: ${path}`);
  }
}

function createPrivateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  ensurePrivateDirectory(path);
  fsyncDirectory(dirname(path));
}

function ensureArchiveParent(root: string, archive: string): string {
  const parts = assertArchivePath(archive).split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    assertPathWithin(root, current);
    if (existsSync(current)) {
      assertDirectory(current);
    } else {
      createPrivateDirectory(current);
    }
  }
  return current;
}

function copyExclusive(source: string, targetRoot: string, archive: string): string {
  assertRegularFile(source);
  ensureArchiveParent(targetRoot, archive);
  const target = archivePath(targetRoot, archive);
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  chmodSync(target, 0o600);
  fsyncFile(target);
  fsyncDirectory(dirname(target));
  return target;
}

function walkFiles(root: string, prefix: string): string[] {
  const start = prefix ? archivePath(root, prefix) : root;
  if (!existsSync(start)) return [];
  assertDirectory(start);
  const output: string[] = [];
  const visit = (directory: string, archiveDirectory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const archive = archiveDirectory ? `${archiveDirectory}/${name}` : name;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link in backup input: ${path}`);
      if (info.isDirectory()) {
        visit(path, archive);
      } else if (info.isFile()) {
        output.push(assertArchivePath(archive));
      } else {
        throw new Error(`Refusing special filesystem entry in backup input: ${path}`);
      }
    }
  };
  visit(start, prefix);
  return output;
}

function fileRecord(root: string, archive: string): BackupFileRecord {
  const path = archivePath(root, archive);
  assertRegularFile(path);
  const info = lstatSync(path);
  return Object.freeze({ path: archive, bytes: info.size, sha256: sha256File(path) });
}

function validateDestination(destination: string): { target: string; parent: string; staging: string } {
  if (!isAbsolute(destination)) throw new TypeError("Backup destination must be an absolute directory path");
  const target = resolve(destination);
  if (target === parse(target).root) throw new Error("Refusing to use a filesystem root as a backup directory");
  if (existsSync(target)) throw new Error(`Backup destination already exists: ${target}`);
  const parent = dirname(target);
  assertNoSymlinkAncestors(parent);
  assertDirectory(parent);
  const staging = join(parent, `.${basename(target)}.tmp-${process.pid}-${randomUUID()}`);
  if (dirname(staging) !== parent || existsSync(staging)) throw new Error("Could not allocate a safe backup staging path");
  return { target, parent, staging };
}

function pathAtOrBelow(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}

function assertBackupDestinationOutsideCanonicalInputs(
  layout: LocalDataLayout,
  ...candidates: readonly string[]
): void {
  for (const candidate of candidates) {
    for (const protectedRoot of [
      layout.stateDirectory,
      layout.objectStoreDirectory,
      layout.missionWorkspaceDirectory,
      layout.runtimeDirectory,
    ]) {
      if (pathAtOrBelow(protectedRoot, candidate)) {
        throw new Error(`Backup destination may not be inside canonical input state: ${candidate}`);
      }
    }
  }
}

function copyTreeIntoArchive(sourceRoot: string, targetRoot: string, archivePrefix: string): void {
  if (!existsSync(sourceRoot)) return;
  assertDirectory(sourceRoot);
  for (const sourceArchive of walkFiles(sourceRoot, "")) {
    copyExclusive(archivePath(sourceRoot, sourceArchive), targetRoot, `${archivePrefix}/${sourceArchive}`);
  }
}

function parseManifest(path: string): LocalBackupManifest {
  assertRegularFile(path);
  const info = lstatSync(path);
  if (info.size <= 0 || info.size > MAX_MANIFEST_BYTES) {
    throw new Error("Backup manifest is empty or exceeds the bounded manifest size");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error("Backup manifest is not valid JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Backup manifest must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "format", "version", "createdAt", "appVersion", "profile", "schemaVersion",
    "migrationHead", "sourceAuthority", "files",
  ]);
  if (Object.keys(record).length !== allowed.size || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Backup manifest has an unexpected field set");
  }
  if (
    record.format !== BACKUP_FORMAT
    || record.version !== BACKUP_VERSION
    || record.profile !== "selfhost"
    || typeof record.createdAt !== "string"
    || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.appVersion !== "string"
    || !record.appVersion
    || record.schemaVersion !== DRIFTGLASS_LOCAL_MIGRATION_HEAD.version
    || record.migrationHead !== migrationHeadIdentity()
    || !Array.isArray(record.files)
  ) {
    throw new Error("Backup manifest failed structural verification");
  }
  const authority = verifyCanonicalAuthorityReceipt(record.sourceAuthority);
  const files = record.files.map((item): BackupFileRecord => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Backup file record must be an object");
    const file = item as Record<string, unknown>;
    if (
      Object.keys(file).length !== 3
      || !Object.hasOwn(file, "path")
      || !Object.hasOwn(file, "bytes")
      || !Object.hasOwn(file, "sha256")
      || typeof file.path !== "string"
      || typeof file.bytes !== "number"
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || typeof file.sha256 !== "string"
      || !SHA256.test(file.sha256)
    ) throw new Error("Backup file record failed structural verification");
    return Object.freeze({ path: assertArchivePath(file.path), bytes: file.bytes, sha256: file.sha256 });
  });
  const paths = files.map((file) => file.path);
  if (!paths.includes(DATABASE_ARCHIVE_PATH)) {
    throw new Error("Backup manifest does not contain the required SQLite snapshot");
  }
  if (new Set(paths).size !== paths.length || paths.some((entry, index) => index > 0 && entry <= paths[index - 1]!)) {
    throw new Error("Backup file records must be unique and sorted by archive path");
  }
  return Object.freeze({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: record.createdAt,
    appVersion: record.appVersion,
    profile: "selfhost",
    schemaVersion: record.schemaVersion,
    migrationHead: record.migrationHead,
    sourceAuthority: authority,
    files: Object.freeze(files),
  });
}

async function verifyBackupDatabase(path: string, manifest: LocalBackupManifest): Promise<void> {
  // A WAL-mode SQLite file may create -shm/-wal sidecars even when opened
  // read-only. Verify an isolated copy so an immutable backup archive never
  // gains undeclared files merely by being inspected.
  const temporaryDirectory = mkdtempSync(join(realpathSync(tmpdir()), "driftglass-backup-verify-"));
  const temporaryDatabase = join(temporaryDirectory, "snapshot.sqlite3");
  let database: NodeSQLiteDatabase | undefined;
  try {
    ensurePrivateDirectory(temporaryDirectory);
    copyFileSync(path, temporaryDatabase, constants.COPYFILE_EXCL);
    chmodSync(temporaryDatabase, 0o600);
    database = new NodeSQLiteDatabase(temporaryDatabase, { readOnly: true });
    const [setting, userVersion, ledger, integrity] = await Promise.all([
      database.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first<{ value: string }>(),
      database.prepare("PRAGMA user_version").first<{ user_version: number }>(),
      database.prepare(
        "SELECT version, name, sha256, status FROM __driftglass_local_migrations ORDER BY version DESC LIMIT 1",
      ).first<{ version: number; name: string; sha256: string; status: string }>(),
      database.integrityCheck(),
    ]);
    if (
      Number(setting?.value) !== manifest.schemaVersion
      || userVersion?.user_version !== manifest.schemaVersion
      || ledger?.version !== manifest.schemaVersion
      || ledger.name !== DRIFTGLASS_LOCAL_MIGRATION_HEAD.name
      || ledger.sha256 !== DRIFTGLASS_LOCAL_MIGRATION_HEAD.sha256
      || ledger.status !== "applied"
      || !integrity.ok
    ) throw new Error("Backup SQLite snapshot failed schema, migration-ledger, or integrity verification");
  } finally {
    database?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Create a checksummed, secret-free local operational backup directory. */
async function createLocalBackupWhileLocked(
  layout: LocalDataLayout,
  destination: string,
): Promise<VerifiedLocalBackup> {
  const authority = await loadVerifiedLocalAuthority(layout);
  const objectIntegrity = await new LocalObjectStore(layout.objectStoreDirectory).verify();
  if (!objectIntegrity.ok) throw new Error(`Cannot back up a corrupt object store: ${objectIntegrity.errors.join("; ")}`);
  const { target, parent, staging } = validateDestination(destination);
  assertBackupDestinationOutsideCanonicalInputs(layout, target, staging);
  createPrivateDirectory(staging);
  try {
    ensureArchiveParent(staging, DATABASE_ARCHIVE_PATH);
    const database = new NodeSQLiteDatabase(layout.databasePath);
    try {
      await database.backupTo(archivePath(staging, DATABASE_ARCHIVE_PATH));
    } finally {
      database.close();
    }
    copyTreeIntoArchive(layout.objectStoreDirectory, staging, "objects");
    copyTreeIntoArchive(layout.missionWorkspaceDirectory, staging, "missions");

    const archives = walkFiles(staging, "")
      .filter((archive) => archive !== MANIFEST_FILE)
      .sort();
    const files = Object.freeze(archives.map((archive) => fileRecord(staging, archive)));
    const manifest: LocalBackupManifest = Object.freeze({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      appVersion: "0.9.0",
      profile: "selfhost",
      schemaVersion: authority.authority.receipt.schemaVersion,
      migrationHead: authority.authority.receipt.migrationHead,
      sourceAuthority: authority.authority.receipt,
      files,
    });
    const manifestPath = join(staging, MANIFEST_FILE);
    const descriptor = openSync(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    ensurePrivateFile(manifestPath);
    fsyncDirectory(staging);
    await verifyLocalBackup(staging);
    renameSync(staging, target);
    fsyncDirectory(parent);
    return verifyLocalBackup(target);
  } catch (error) {
    if (existsSync(staging) && dirname(staging) === parent) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function createLocalBackup(
  layout: LocalDataLayout,
  destination: string,
): Promise<VerifiedLocalBackup> {
  const lease = acquireLocalRuntimeLease(layout, "backup");
  try {
    return await createLocalBackupWhileLocked(layout, destination);
  } finally {
    lease.release();
  }
}

/** Verify every declared file, reject undeclared files, and audit SQLite/R2. */
export async function verifyLocalBackup(directory: string): Promise<VerifiedLocalBackup> {
  if (!isAbsolute(directory)) throw new TypeError("Backup directory must be absolute");
  const root = resolve(directory);
  assertNoSymlinkAncestors(root);
  assertDirectory(root);
  const manifestPath = join(root, MANIFEST_FILE);
  const manifest = parseManifest(manifestPath);
  const actual = walkFiles(root, "").filter((path) => path !== MANIFEST_FILE).sort();
  const expected = manifest.files.map((file) => file.path);
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new Error("Backup directory contains missing or undeclared files");
  }
  let bytes = 0;
  for (const file of manifest.files) {
    const path = archivePath(root, file.path);
    assertRegularFile(path);
    const info = lstatSync(path);
    if (info.size !== file.bytes || sha256File(path) !== file.sha256) {
      throw new Error(`Backup checksum verification failed: ${file.path}`);
    }
    bytes += info.size;
  }
  await verifyBackupDatabase(archivePath(root, DATABASE_ARCHIVE_PATH), manifest);
  const objectDirectory = join(root, "objects");
  if (existsSync(objectDirectory)) {
    const integrity = await new LocalObjectStore(objectDirectory).verify();
    if (!integrity.ok) throw new Error(`Backup object-store verification failed: ${integrity.errors.join("; ")}`);
  }
  return Object.freeze({
    directory: root,
    manifest,
    manifestSha256: sha256File(manifestPath),
    bytes,
  });
}

function assertEmptyRestoreTarget(layout: LocalDataLayout): void {
  if (existsSync(layout.databasePath)) throw new Error("Restore target already contains a SQLite database");
  for (const directory of [layout.stateDirectory, layout.objectStoreDirectory, layout.missionWorkspaceDirectory, layout.runtimeDirectory]) {
    assertDirectory(directory);
    const entries = readdirSync(directory);
    if (entries.length) throw new Error(`Restore target is not empty: ${directory}`);
  }
}

function copyArchivePrefix(backupRoot: string, layoutRoot: string, prefix: string): void {
  for (const archive of walkFiles(backupRoot, prefix)) {
    const relativeArchive = archive.slice(prefix.length + 1);
    copyExclusive(archivePath(backupRoot, archive), layoutRoot, relativeArchive);
  }
}

/**
 * Restore onto a clean managed data root. This is a verified move/import: it
 * creates a new target receipt and owner secret instead of cloning authority.
 */
export async function restoreLocalBackup(
  backupDirectory: string,
  targetDataDirectory: string,
): Promise<RestoredLocalBackup> {
  const backup = await verifyLocalBackup(backupDirectory);
  const layout = createLocalDataLayout(resolve(targetDataDirectory));
  assertEmptyRestoreTarget(layout);
  const lease = acquireLocalRuntimeLease(layout, "restore");

  try {
    // All imported writes are create-only. A partial crash remains fail-closed:
    // neither init nor serve can bless the unreceipted target.
    copyExclusive(
      archivePath(backup.directory, DATABASE_ARCHIVE_PATH),
      layout.stateDirectory,
      basename(layout.databasePath),
    );
    if (existsSync(join(backup.directory, "objects"))) {
      copyArchivePrefix(backup.directory, layout.objectStoreDirectory, "objects");
    }
    if (existsSync(join(backup.directory, "missions"))) {
      copyArchivePrefix(backup.directory, layout.missionWorkspaceDirectory, "missions");
    }

    const restoredRecords: BackupFileRecord[] = [{
      ...fileRecord(layout.stateDirectory, basename(layout.databasePath)),
      path: DATABASE_ARCHIVE_PATH,
    }];
    for (const [prefix, root] of [
      ["objects", layout.objectStoreDirectory],
      ["missions", layout.missionWorkspaceDirectory],
    ] as const) {
      for (const archive of walkFiles(root, "").sort()) {
        restoredRecords.push({ ...fileRecord(root, archive), path: `${prefix}/${archive}` });
      }
    }
    restoredRecords.sort((left, right) => left.path.localeCompare(right.path));
    const importedManifestSha256 = sha256Text(JSON.stringify({
      format: "driftglass-local-restore-verification",
      version: 1,
      backupManifestSha256: backup.manifestSha256,
      files: restoredRecords,
    }));
    const authority = await establishRestoredLocalAuthority(layout, {
      sourceManifestSha256: backup.manifestSha256,
      importedManifestSha256,
    });
    return Object.freeze({ ...backup, layout, authority });
  } finally {
    lease.release();
  }
}
