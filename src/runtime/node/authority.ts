import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type {
  CanonicalAuthorityReceipt,
  RuntimeAuthority,
} from "../ports";
import { NodeSQLiteDatabase } from "./database";
import {
  ensurePrivateFile,
  fsyncDirectory,
  type LocalDataLayout,
} from "./layout";
import {
  DRIFTGLASS_LOCAL_MIGRATION_HEAD,
  migrateLocalDatabase,
} from "./migrations";
import { LocalObjectStore } from "./object-store";

const RECEIPT_FILE = "canonical-authority-receipt.json";
const INSTANCE_FILE = "local-instance.json";
const OWNER_SECRET_FILE = "owner-secret";
const MAX_AUTHORITY_FILE_BYTES = 64 * 1024;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const LOCAL_AUTHORITY_VERIFIER = Object.freeze({
  name: "driftglass-local-authority",
  version: 1,
});

interface LocalInstanceRecord {
  readonly format: "driftglass-local-instance";
  readonly version: 1;
  readonly targetInstanceId: string;
  readonly createdAt: string;
}

interface AuthorityEnvelope {
  readonly format: "driftglass-canonical-authority";
  readonly version: 1;
  readonly verifier: typeof LOCAL_AUTHORITY_VERIFIER;
  readonly receipt: CanonicalAuthorityReceipt;
}

export interface RestoredAuthoritySource {
  /** SHA-256 of the verified operational-backup manifest. */
  readonly sourceManifestSha256: string;
  /** SHA-256 of the verifier's exact imported-state result. */
  readonly importedManifestSha256: string;
}

export interface InitializedLocalAuthority {
  readonly authority: Extract<RuntimeAuthority, { mode: "verified-receipt" }>;
  readonly ownerSecret: string;
  readonly ownerSecretPath: string;
  readonly receiptPath: string;
  readonly databasePath: string;
  readonly objectStoreDirectory: string;
}

export interface VerifiedLocalAuthority {
  readonly authority: Extract<RuntimeAuthority, { mode: "verified-receipt" }>;
  readonly ownerSecret: string;
  readonly ownerSecretPath: string;
  readonly receiptPath: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function receiptPayload(receipt: CanonicalAuthorityReceipt): Omit<CanonicalAuthorityReceipt, "receiptSha256"> {
  const { receiptSha256: _receiptSha256, ...payload } = receipt;
  return payload;
}

function receiptSha256(receipt: CanonicalAuthorityReceipt): string {
  return sha256Bytes(stableJson(receiptPayload(receipt)));
}

function pathFor(layout: LocalDataLayout, name: string): string {
  const candidate = resolve(layout.runtimeDirectory, name);
  if (dirname(candidate) !== resolve(layout.runtimeDirectory)) {
    throw new Error("Local authority path escaped the runtime directory");
  }
  return candidate;
}

function assertRegularPrivateFile(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Refusing symbolic-link or non-file authority record: ${path}`);
  }
  ensurePrivateFile(path);
}

function writeExclusivePrivate(path: string, body: string): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(descriptor, body, { encoding: "utf8" });
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size !== Buffer.byteLength(body)) {
      throw new Error(`Authority record write was incomplete: ${path}`);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  ensurePrivateFile(path);
  fsyncDirectory(dirname(path));
}

function readBoundedFile(path: string): string {
  assertRegularPrivateFile(path);
  const info = lstatSync(path);
  if (info.size <= 0 || info.size > MAX_AUTHORITY_FILE_BYTES) {
    throw new Error(`Local authority record has an invalid size: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function readJsonRecord(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readBoundedFile(path));
  } catch (error) {
    throw new Error(`Local authority record is not valid JSON: ${path}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Local authority record must be a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function migrationHeadIdentity(): string {
  return `${DRIFTGLASS_LOCAL_MIGRATION_HEAD.name}:${DRIFTGLASS_LOCAL_MIGRATION_HEAD.sha256}`;
}

function assertReceiptShape(value: unknown): CanonicalAuthorityReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Canonical authority receipt is missing");
  }
  const receipt = value as Record<string, unknown>;
  const allowed = new Set([
    "version", "migrationId", "fromProfile", "toProfile", "fromCanonicalState",
    "toCanonicalState", "schemaVersion", "migrationHead", "sourceManifestSha256",
    "importedManifestSha256", "targetInstanceId", "verifiedAt", "receiptSha256",
  ]);
  if (Object.keys(receipt).some((key) => !allowed.has(key)) || Object.keys(receipt).length !== allowed.size) {
    throw new Error("Canonical authority receipt has an unexpected field set");
  }
  if (
    receipt.version !== 1
    || !(
      (receipt.fromProfile === "empty" && receipt.fromCanonicalState === "empty")
      || (receipt.fromProfile === "selfhost" && receipt.fromCanonicalState === "local")
    )
    || receipt.toCanonicalState !== "local"
    || receipt.toProfile !== "selfhost"
    || receipt.schemaVersion !== DRIFTGLASS_LOCAL_MIGRATION_HEAD.version
    || receipt.migrationHead !== migrationHeadIdentity()
    || typeof receipt.verifiedAt !== "string"
    || !Number.isFinite(Date.parse(receipt.verifiedAt))
    || typeof receipt.migrationId !== "string"
    || !UUID.test(receipt.migrationId)
    || typeof receipt.targetInstanceId !== "string"
    || !UUID.test(receipt.targetInstanceId)
    || typeof receipt.sourceManifestSha256 !== "string"
    || !HEX_SHA256.test(receipt.sourceManifestSha256)
    || typeof receipt.importedManifestSha256 !== "string"
    || !HEX_SHA256.test(receipt.importedManifestSha256)
    || typeof receipt.receiptSha256 !== "string"
    || !HEX_SHA256.test(receipt.receiptSha256)
  ) {
    throw new Error("Canonical authority receipt failed structural verification");
  }
  const typed = receipt as unknown as CanonicalAuthorityReceipt;
  if (receiptSha256(typed) !== typed.receiptSha256) {
    throw new Error("Canonical authority receipt digest does not match its fields");
  }
  return Object.freeze({ ...typed });
}

/** Strict verifier shared with backup/import adapters. */
export function verifyCanonicalAuthorityReceipt(value: unknown): CanonicalAuthorityReceipt {
  return assertReceiptShape(value);
}

function authorityPaths(layout: LocalDataLayout): {
  receiptPath: string;
  instancePath: string;
  ownerSecretPath: string;
} {
  return {
    receiptPath: pathFor(layout, RECEIPT_FILE),
    instancePath: pathFor(layout, INSTANCE_FILE),
    ownerSecretPath: pathFor(layout, OWNER_SECRET_FILE),
  };
}

function assertAuthorityRecordsAbsent(layout: LocalDataLayout): ReturnType<typeof authorityPaths> {
  const paths = authorityPaths(layout);
  if (existsSync(paths.receiptPath) || existsSync(paths.instancePath) || existsSync(paths.ownerSecretPath)) {
    throw new Error("A local authority record already exists; refusing to replace canonical authority");
  }
  return paths;
}

async function persistNewAuthority(
  layout: LocalDataLayout,
  input: {
    fromProfile: "empty" | "selfhost";
    fromCanonicalState: "empty" | "local";
    sourceManifestSha256: string;
    importedManifestSha256: string;
  },
): Promise<InitializedLocalAuthority> {
  const paths = assertAuthorityRecordsAbsent(layout);
  if (!HEX_SHA256.test(input.sourceManifestSha256) || !HEX_SHA256.test(input.importedManifestSha256)) {
    throw new Error("Authority manifests must be exact lowercase SHA-256 digests");
  }
  if (
    (input.fromProfile === "empty") !== (input.fromCanonicalState === "empty")
  ) {
    throw new Error("Authority source profile and canonical-state location disagree");
  }

  const targetInstanceId = randomUUID();
  const verifiedAt = new Date().toISOString();
  const payload: Omit<CanonicalAuthorityReceipt, "receiptSha256"> = {
    version: 1,
    migrationId: randomUUID(),
    fromProfile: input.fromProfile,
    toProfile: "selfhost",
    fromCanonicalState: input.fromCanonicalState,
    toCanonicalState: "local",
    schemaVersion: DRIFTGLASS_LOCAL_MIGRATION_HEAD.version,
    migrationHead: migrationHeadIdentity(),
    sourceManifestSha256: input.sourceManifestSha256,
    importedManifestSha256: input.importedManifestSha256,
    targetInstanceId,
    verifiedAt,
  };
  const receipt: CanonicalAuthorityReceipt = Object.freeze({
    ...payload,
    receiptSha256: sha256Bytes(stableJson(payload)),
  });
  const instance: LocalInstanceRecord = Object.freeze({
    format: "driftglass-local-instance",
    version: 1,
    targetInstanceId,
    createdAt: verifiedAt,
  });
  const envelope: AuthorityEnvelope = Object.freeze({
    format: "driftglass-canonical-authority",
    version: 1,
    verifier: LOCAL_AUTHORITY_VERIFIER,
    receipt,
  });
  const ownerSecret = randomBytes(32).toString("hex");

  // Each write is create-only. A crash can leave a partial initialization,
  // which intentionally fails closed and requires explicit operator repair.
  writeExclusivePrivate(paths.instancePath, `${stableJson(instance)}\n`);
  writeExclusivePrivate(paths.receiptPath, `${stableJson(envelope)}\n`);
  writeExclusivePrivate(paths.ownerSecretPath, `${ownerSecret}\n`);

  const verified = await loadVerifiedLocalAuthority(layout);
  return Object.freeze({
    authority: verified.authority,
    ownerSecret,
    ownerSecretPath: paths.ownerSecretPath,
    receiptPath: paths.receiptPath,
    databasePath: layout.databasePath,
    objectStoreDirectory: layout.objectStoreDirectory,
  });
}

function readInstance(layout: LocalDataLayout): LocalInstanceRecord {
  const path = pathFor(layout, INSTANCE_FILE);
  const record = readJsonRecord(path);
  if (
    record.format !== "driftglass-local-instance"
    || record.version !== 1
    || typeof record.targetInstanceId !== "string"
    || !UUID.test(record.targetInstanceId)
    || typeof record.createdAt !== "string"
    || !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new Error("Local instance identity failed verification");
  }
  return record as unknown as LocalInstanceRecord;
}

function readEnvelope(layout: LocalDataLayout): AuthorityEnvelope {
  const path = pathFor(layout, RECEIPT_FILE);
  const record = readJsonRecord(path);
  const verifier = record.verifier as Record<string, unknown> | undefined;
  if (
    record.format !== "driftglass-canonical-authority"
    || record.version !== 1
    || !verifier
    || verifier.name !== LOCAL_AUTHORITY_VERIFIER.name
    || verifier.version !== LOCAL_AUTHORITY_VERIFIER.version
  ) {
    throw new Error("Canonical authority envelope uses an unsupported verifier");
  }
  return Object.freeze({
    format: "driftglass-canonical-authority",
    version: 1,
    verifier: LOCAL_AUTHORITY_VERIFIER,
    receipt: assertReceiptShape(record.receipt),
  });
}

async function verifyDatabaseAuthority(layout: LocalDataLayout, receipt: CanonicalAuthorityReceipt): Promise<void> {
  const database = new NodeSQLiteDatabase(layout.databasePath, { readOnly: true });
  try {
    const [schemaVersion, userVersion, ledgerHead, integrity] = await Promise.all([
      database.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first<{ value: string }>(),
      database.prepare("PRAGMA user_version").first<{ user_version: number }>(),
      database
        .prepare(
          `SELECT version, name, sha256, status, applied_at
           FROM __driftglass_local_migrations ORDER BY version DESC LIMIT 1`,
        )
        .first<{ version: number; name: string; sha256: string; status: string; applied_at: string | null }>(),
      database.integrityCheck(),
    ]);
    if (
      Number(schemaVersion?.value) !== receipt.schemaVersion
      || userVersion?.user_version !== receipt.schemaVersion
      || ledgerHead?.version !== receipt.schemaVersion
      || ledgerHead.name !== DRIFTGLASS_LOCAL_MIGRATION_HEAD.name
      || ledgerHead.sha256 !== DRIFTGLASS_LOCAL_MIGRATION_HEAD.sha256
      || ledgerHead.status !== "applied"
      || !ledgerHead.applied_at
    ) {
      throw new Error("Local database schema, migration ledger, and authority receipt disagree");
    }
    if (!integrity.ok) throw new Error("Local database failed integrity or foreign-key verification");
  } finally {
    database.close();
  }
}

/**
 * Establish a new local canonical authority only for a truly fresh target.
 * Existing SQLite state is never adopted or blessed by this path.
 */
export async function initializeFreshLocalAuthority(
  layout: LocalDataLayout,
  migrationsDirectory: string,
): Promise<InitializedLocalAuthority> {
  const paths = authorityPaths(layout);
  if (existsSync(paths.receiptPath) || existsSync(paths.instancePath) || existsSync(paths.ownerSecretPath)) {
    throw new Error("A local authority record already exists; use selfhost:serve instead of initializing again");
  }
  if (existsSync(layout.databasePath)) {
    throw new Error("Refusing fresh authority initialization because the local database already exists");
  }

  const objectStore = new LocalObjectStore(layout.objectStoreDirectory);
  const initialObjects = await objectStore.verify();
  if (!initialObjects.ok || initialObjects.objects !== 0 || initialObjects.blobs !== 0) {
    throw new Error("Refusing fresh authority initialization because the local object store is not empty");
  }

  await migrateLocalDatabase(layout.databasePath, migrationsDirectory, undefined, {
    backupDirectory: layout.backupDirectory,
  });
  const databaseSha256 = sha256Bytes(readFileSync(layout.databasePath));
  const sourceManifestSha256 = sha256Bytes(stableJson({ format: "driftglass-empty-authority", version: 1 }));
  const importedManifestSha256 = sha256Bytes(stableJson({
    format: "driftglass-fresh-local-import",
    version: 1,
    databaseSha256,
    migrationHead: migrationHeadIdentity(),
    objects: { objects: initialObjects.objects, blobs: initialObjects.blobs },
  }));
  return persistNewAuthority(layout, {
    fromProfile: "empty",
    fromCanonicalState: "empty",
    sourceManifestSha256,
    importedManifestSha256,
  });
}

/**
 * Complete a verified operational-backup restore by establishing a new,
 * target-bound local authority. The backup never clones the source secret or
 * source target identity, so two data roots cannot silently share authority.
 */
export async function establishRestoredLocalAuthority(
  layout: LocalDataLayout,
  source: RestoredAuthoritySource,
): Promise<InitializedLocalAuthority> {
  assertAuthorityRecordsAbsent(layout);
  if (!existsSync(layout.databasePath)) {
    throw new Error("Cannot establish restored authority without an imported SQLite database");
  }

  const provisional = {
    version: 1,
    migrationId: randomUUID(),
    fromProfile: "selfhost",
    toProfile: "selfhost",
    fromCanonicalState: "local",
    toCanonicalState: "local",
    schemaVersion: DRIFTGLASS_LOCAL_MIGRATION_HEAD.version,
    migrationHead: migrationHeadIdentity(),
    sourceManifestSha256: source.sourceManifestSha256,
    importedManifestSha256: source.importedManifestSha256,
    targetInstanceId: randomUUID(),
    verifiedAt: new Date().toISOString(),
    receiptSha256: "0".repeat(64),
  } satisfies CanonicalAuthorityReceipt;
  await verifyDatabaseAuthority(layout, provisional);
  const objectIntegrity = await new LocalObjectStore(layout.objectStoreDirectory).verify();
  if (!objectIntegrity.ok) {
    throw new Error(`Restored object store failed verification: ${objectIntegrity.errors.join("; ")}`);
  }
  return persistNewAuthority(layout, {
    fromProfile: "selfhost",
    fromCanonicalState: "local",
    sourceManifestSha256: source.sourceManifestSha256,
    importedManifestSha256: source.importedManifestSha256,
  });
}

/** Re-verify the target-bound authority before a writable local service exists. */
export async function loadVerifiedLocalAuthority(layout: LocalDataLayout): Promise<VerifiedLocalAuthority> {
  const receiptPath = pathFor(layout, RECEIPT_FILE);
  const ownerSecretPath = pathFor(layout, OWNER_SECRET_FILE);
  const instance = readInstance(layout);
  const envelope = readEnvelope(layout);
  const receipt = envelope.receipt;
  if (receipt.targetInstanceId !== instance.targetInstanceId) {
    throw new Error("Canonical authority receipt belongs to a different local target instance");
  }
  await verifyDatabaseAuthority(layout, receipt);
  const objectIntegrity = await new LocalObjectStore(layout.objectStoreDirectory).verify();
  if (!objectIntegrity.ok) {
    throw new Error(`Local object store failed authority verification: ${objectIntegrity.errors.join("; ")}`);
  }
  const ownerSecret = readBoundedFile(ownerSecretPath).trim();
  if (!/^[0-9a-f]{64}$/.test(ownerSecret)) throw new Error("Local owner secret failed verification");
  return Object.freeze({
    authority: Object.freeze({
      mode: "verified-receipt",
      profile: "selfhost",
      canonicalState: "local",
      writable: true,
      receipt,
    }),
    ownerSecret,
    ownerSecretPath,
    receiptPath,
  });
}
