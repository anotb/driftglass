import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  lstatSync,
  readdirSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";

import type {
  ObjectBody,
  ObjectHead,
  ObjectHttpMetadata,
  ObjectListOptions,
  ObjectListResult,
  ObjectMetadata,
  ObjectPutResult,
  ObjectStorePort,
  PortableBody,
} from "../ports";
import {
  assertNoSymlinkComponents,
  assertPathWithin,
  assertPortableNodeRuntime,
  ensureManagedPrivateDirectory,
  ensurePrivateDirectory,
  ensurePrivateFile,
  fsyncDirectory,
  isMissingPathError,
} from "./layout";

const METADATA_VERSION = 1;
const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_INDEX_ENTRIES = 100_000;
const DEFAULT_TEMP_MAX_AGE_MS = 60 * 60 * 1_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const MAX_KEY_BYTES = 1_024;
const MAX_SEGMENT_BYTES = 255;
const MAX_METADATA_BYTES = 32 * 1_024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HEX_SHARD_PATTERN = /^[0-9a-f]{2}$/;
const TEMP_PATTERN = /^(upload|metadata)-(\d+)-[0-9a-f-]+\.tmp$/;

interface StoredMetadata {
  readonly version: 1;
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  readonly etag: string;
  readonly uploaded: string;
  readonly httpMetadata?: StoredHttpMetadata;
  readonly customMetadata?: Record<string, string>;
}

interface StoredHttpMetadata {
  readonly contentType?: string;
  readonly contentLanguage?: string;
  readonly contentDisposition?: string;
  readonly contentEncoding?: string;
  readonly cacheControl?: string;
  readonly cacheExpiry?: string;
}

interface StagedBody {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface LockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

interface RecoverableLock {
  readonly info: Stats;
  readonly owner: LockOwner;
}

export interface LocalObjectStoreOptions {
  readonly maxObjectBytes?: number;
  readonly maxIndexEntries?: number;
  readonly tempMaxAgeMs?: number;
  readonly lockTimeoutMs?: number;
  readonly lockStaleMs?: number;
}

export interface ObjectStoreVerificationReport {
  readonly ok: boolean;
  readonly objects: number;
  readonly blobs: number;
  readonly errors: readonly string[];
}

export interface ObjectStoreGarbageCollectionResult {
  readonly dryRun: boolean;
  readonly referencedBlobs: number;
  readonly scannedBlobs: number;
  readonly deletedBlobs: number;
  readonly reclaimedBytes: number;
  readonly candidates: readonly string[];
}

/**
 * Permission-restricted, content-addressed ObjectStorePort for one local host.
 * Logical keys are POSIX names only; filesystem paths contain hashes, never key
 * text, which makes validation identical on macOS, Linux, and Windows/WSL2.
 */
export class LocalObjectStore implements ObjectStorePort {
  readonly root: string;
  readonly #blobs: string;
  readonly #keys: string;
  readonly #temporary: string;
  readonly #locks: string;
  readonly #maxObjectBytes: number;
  readonly #maxIndexEntries: number;
  readonly #tempMaxAgeMs: number;
  readonly #lockTimeoutMs: number;
  readonly #lockStaleMs: number;

  constructor(root: string, options: LocalObjectStoreOptions = {}) {
    assertPortableNodeRuntime();
    if (!root) throw new TypeError("LocalObjectStore requires a data directory");
    this.root = ensureManagedPrivateDirectory(root, "object-store");
    this.#maxObjectBytes = positiveInteger(options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES, "maxObjectBytes");
    this.#maxIndexEntries = positiveInteger(options.maxIndexEntries ?? DEFAULT_MAX_INDEX_ENTRIES, "maxIndexEntries");
    this.#tempMaxAgeMs = nonNegativeInteger(options.tempMaxAgeMs ?? DEFAULT_TEMP_MAX_AGE_MS, "tempMaxAgeMs");
    this.#lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs");
    this.#lockStaleMs = positiveInteger(options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS, "lockStaleMs");

    this.#blobs = join(this.root, "blobs", "sha256");
    this.#keys = join(this.root, "keys");
    this.#temporary = join(this.root, "tmp");
    this.#locks = join(this.root, "locks");
    for (const directory of [this.#blobs, this.#keys, this.#temporary, this.#locks]) {
      assertNoSymlinkComponents(this.root, directory, true);
      ensurePrivateDirectory(directory);
      assertNoSymlinkComponents(this.root, directory);
    }
    this.cleanupCrashTemps();
  }

  async put(key: string, value: PortableBody, options: ObjectMetadata = {}): Promise<ObjectPutResult> {
    const segments = validateLogicalKey(key);
    const normalizedHttp = normalizeHttpMetadata(options.httpMetadata);
    const normalizedCustom = normalizeCustomMetadata(options.customMetadata);
    const conditions = normalizeConditions(options.onlyIf);
    const staged = await this.stageBody(value);

    try {
      return await this.withStoreLock(async () => {
        const current = await this.readMetadata(key, segments);
        if (current) await this.verifyBlob(current);
        if (!conditionsPass(current, conditions)) {
          return { stored: false, etag: current?.etag };
        }

        await this.commitBlob(staged);
        const uploaded = new Date().toISOString();
        const metadata: StoredMetadata = {
          version: METADATA_VERSION,
          key,
          size: staged.size,
          sha256: staged.sha256,
          etag: staged.sha256,
          uploaded,
          ...(normalizedHttp ? { httpMetadata: normalizedHttp } : {}),
          ...(normalizedCustom ? { customMetadata: normalizedCustom } : {}),
        };
        await this.writeMetadata(metadata, segments);
        return { stored: true, etag: metadata.etag };
      });
    } finally {
      await removeIfPresent(staged.path);
    }
  }

  async get(key: string): Promise<ObjectBody | null> {
    const segments = validateLogicalKey(key);
    const metadata = await this.readMetadata(key, segments);
    if (!metadata) return null;
    const stream = await this.openVerifiedBlobStream(metadata);
    return new LocalObjectBody(metadata, stream);
  }

  async head(key: string): Promise<ObjectHead | null> {
    const segments = validateLogicalKey(key);
    const metadata = await this.readMetadata(key, segments);
    if (!metadata) return null;
    await this.verifyBlob(metadata);
    return metadataToHead(metadata);
  }

  async delete(key: string): Promise<void> {
    const segments = validateLogicalKey(key);
    await this.withStoreLock(async () => {
      const metadataPath = this.metadataPath(segments);
      const current = await this.readMetadata(key, segments);
      if (!current) return;
      await unlink(metadataPath);
      fsyncDirectory(dirname(metadataPath));
    });
  }

  async list(options: ObjectListOptions = {}): Promise<ObjectListResult> {
    const prefix = validateLogicalPrefix(options.prefix ?? "");
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Object list limit must be between 1 and 1000");
    }
    const after = options.cursor ? decodeCursor(options.cursor) : undefined;
    if (after && !after.startsWith(prefix)) throw new Error("Object list cursor does not match the prefix");

    const metadataFiles = await this.walkMetadataFiles();
    const objects: ObjectHead[] = [];
    for (const file of metadataFiles) {
      const metadata = await this.readMetadataFile(file);
      if (!metadata.key.startsWith(prefix) || (after !== undefined && metadata.key <= after)) continue;
      await this.verifyBlob(metadata);
      objects.push(metadataToHead(metadata));
    }
    objects.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    const truncated = objects.length > limit;
    const page = objects.slice(0, limit);
    return {
      objects: page,
      truncated,
      ...(truncated ? { cursor: encodeCursor(page[page.length - 1]!.key) } : {}),
    };
  }

  async verify(): Promise<ObjectStoreVerificationReport> {
    const errors: string[] = [];
    let objects = 0;
    let blobs = 0;
    try {
      const files = await this.walkMetadataFiles();
      for (const file of files) {
        try {
          const metadata = await this.readMetadataFile(file);
          await this.verifyBlob(metadata);
          objects += 1;
        } catch (error) {
          errors.push(describeError(error));
        }
      }
      const blobFiles = await this.walkBlobFiles();
      blobs = blobFiles.length;
      for (const file of blobFiles) {
        try {
          const digest = basename(file);
          await this.verifyBlobPath(file, digest);
        } catch (error) {
          errors.push(describeError(error));
        }
      }
    } catch (error) {
      errors.push(describeError(error));
    }
    return { ok: errors.length === 0, objects, blobs, errors };
  }

  async garbageCollect(options: { dryRun?: boolean; graceMs?: number } = {}): Promise<ObjectStoreGarbageCollectionResult> {
    const dryRun = options.dryRun ?? true;
    const graceMs = nonNegativeInteger(options.graceMs ?? 24 * 60 * 60 * 1_000, "graceMs");
    return this.withStoreLock(async () => {
      const referenced = new Set<string>();
      for (const file of await this.walkMetadataFiles()) {
        referenced.add((await this.readMetadataFile(file)).sha256);
      }

      const candidates: string[] = [];
      let scannedBlobs = 0;
      let deletedBlobs = 0;
      let reclaimedBytes = 0;
      const cutoff = Date.now() - graceMs;
      for (const file of await this.walkBlobFiles()) {
        scannedBlobs += 1;
        const digest = basename(file);
        if (referenced.has(digest)) continue;
        const info = await lstat(file);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing non-regular blob: ${file}`);
        if (info.mtimeMs > cutoff) continue;
        candidates.push(digest);
        if (!dryRun) {
          await unlink(file);
          fsyncDirectory(dirname(file));
          deletedBlobs += 1;
          reclaimedBytes += info.size;
        }
      }
      candidates.sort();
      return {
        dryRun,
        referencedBlobs: referenced.size,
        scannedBlobs,
        deletedBlobs,
        reclaimedBytes,
        candidates,
      };
    });
  }

  cleanupCrashTemps(now = Date.now()): number {
    assertNoSymlinkComponents(this.root, this.#temporary);
    let removed = 0;
    for (const entry of readdirSync(this.#temporary, { withFileTypes: true })) {
      const file = join(this.#temporary, entry.name);
      assertPathWithin(this.#temporary, file);
      const info = lstatSync(file);
      const match = TEMP_PATTERN.exec(entry.name);
      if (info.isSymbolicLink() || !info.isFile() || !match) {
        throw new Error(`Refusing unexpected temporary-store entry: ${file}`);
      }
      if (now - info.mtimeMs < this.#tempMaxAgeMs) continue;
      if (pidIsAlive(Number(match[2]))) continue;
      unlinkSync(file);
      removed += 1;
    }
    if (removed > 0) fsyncDirectory(this.#temporary);
    return removed;
  }

  private async stageBody(value: PortableBody): Promise<StagedBody> {
    const temporary = join(this.#temporary, `upload-${process.pid}-${randomUUID()}.tmp`);
    assertNoSymlinkComponents(this.root, temporary, true);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of bodyChunks(value)) {
        if (!(chunk instanceof Uint8Array)) throw new TypeError("Object streams must yield Uint8Array chunks");
        size += chunk.byteLength;
        if (size > this.#maxObjectBytes) {
          throw new RangeError(`Object exceeds the ${this.#maxObjectBytes}-byte local limit`);
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const write = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (write.bytesWritten < 1) throw new Error("Object staging made no write progress");
          offset += write.bytesWritten;
        }
      }
      await handle.sync();
    } catch (error) {
      await handle.close();
      await removeIfPresent(temporary);
      throw error;
    }
    await handle.close();
    ensurePrivateFile(temporary);
    fsyncDirectory(this.#temporary);
    return { path: temporary, size, sha256: hash.digest("hex") };
  }

  private async commitBlob(staged: StagedBody): Promise<void> {
    const blob = this.blobPath(staged.sha256);
    const parent = dirname(blob);
    assertNoSymlinkComponents(this.root, parent, true);
    ensurePrivateDirectory(parent);
    assertNoSymlinkComponents(this.root, parent);
    try {
      await link(staged.path, blob);
      ensurePrivateFile(blob);
      fsyncDirectory(parent);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) {
        throw error;
      }
      await this.verifyBlobPath(blob, staged.sha256, staged.size);
    }
    await removeIfPresent(staged.path);
    fsyncDirectory(this.#temporary);
  }

  private async writeMetadata(metadata: StoredMetadata, segments: readonly string[]): Promise<void> {
    const destination = this.metadataPath(segments);
    const parent = dirname(destination);
    assertNoSymlinkComponents(this.root, parent, true);
    ensurePrivateDirectory(parent);
    assertNoSymlinkComponents(this.root, parent);
    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`Refusing non-regular object metadata: ${destination}`);
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    const encoded = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
    if (encoded.byteLength > MAX_METADATA_BYTES) throw new RangeError("Object metadata is too large");
    const temporary = join(this.#temporary, `metadata-${process.pid}-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      ensurePrivateFile(temporary);
      await rename(temporary, destination);
      ensurePrivateFile(destination);
      fsyncDirectory(parent);
    } finally {
      await removeIfPresent(temporary);
    }
  }

  private async readMetadata(key: string, segments: readonly string[]): Promise<StoredMetadata | null> {
    const path = this.metadataPath(segments);
    try {
      return await this.readMetadataFile(path, key);
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
  }

  private async readMetadataFile(path: string, expectedKey?: string): Promise<StoredMetadata> {
    assertNoSymlinkComponents(this.root, path);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_METADATA_BYTES) {
      throw new Error(`Refusing invalid object metadata file: ${path}`);
    }
    const handle = await open(path, constants.O_RDONLY | noFollowFlag());
    let text: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_METADATA_BYTES) throw new Error(`Invalid object metadata: ${path}`);
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Corrupt object metadata JSON: ${path}`);
    }
    const metadata = validateStoredMetadata(parsed);
    const segments = validateLogicalKey(metadata.key);
    if (this.metadataPath(segments) !== path || (expectedKey !== undefined && metadata.key !== expectedKey)) {
      throw new Error(`Object metadata key/path mismatch: ${path}`);
    }
    return metadata;
  }

  private async verifyBlob(metadata: StoredMetadata): Promise<void> {
    await this.verifyBlobPath(this.blobPath(metadata.sha256), metadata.sha256, metadata.size);
  }

  private async verifyBlobPath(path: string, digest: string, expectedSize?: number): Promise<void> {
    const handle = await this.openVerifiedBlobHandle(path, digest, expectedSize);
    await handle.close();
  }

  private async openVerifiedBlobHandle(path: string, digest: string, expectedSize?: number): Promise<FileHandle> {
    assertNoSymlinkComponents(this.root, path);
    const handle = await open(path, constants.O_RDONLY | noFollowFlag());
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing non-regular object blob: ${path}`);
      if (info.size > this.#maxObjectBytes || (expectedSize !== undefined && info.size !== expectedSize)) {
        throw new Error(`Object blob size mismatch: ${path}`);
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1_024);
      let position = 0;
      while (position < info.size) {
        const result = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position);
        if (result.bytesRead < 1) throw new Error(`Unexpected end of object blob: ${path}`);
        hash.update(buffer.subarray(0, result.bytesRead));
        position += result.bytesRead;
      }
      if (hash.digest("hex") !== digest) throw new Error(`Object blob SHA-256 mismatch: ${path}`);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async openVerifiedBlobStream(metadata: StoredMetadata): Promise<ReadableStream<Uint8Array>> {
    const path = this.blobPath(metadata.sha256);
    const handle = await this.openVerifiedBlobHandle(path, metadata.sha256, metadata.size);
    const readable = handle.createReadStream({ autoClose: true, start: 0 });
    return Readable.toWeb(readable) as unknown as ReadableStream<Uint8Array>;
  }

  private metadataPath(segments: readonly string[]): string {
    const digest = hashLogicalKey(segments.join("/"));
    const path = join(this.#keys, digest.slice(0, 2), digest.slice(2, 4), `${digest}.json`);
    assertPathWithin(this.#keys, path);
    return path;
  }

  private blobPath(digest: string): string {
    if (!SHA256_PATTERN.test(digest)) throw new Error("Invalid content digest");
    const path = join(this.#blobs, digest.slice(0, 2), digest.slice(2, 4), digest);
    assertPathWithin(this.#blobs, path);
    return path;
  }

  private async walkMetadataFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const one of await readdir(this.#keys, { withFileTypes: true })) {
      const onePath = join(this.#keys, one.name);
      const oneInfo = await lstat(onePath);
      if (oneInfo.isSymbolicLink() || !oneInfo.isDirectory() || !HEX_SHARD_PATTERN.test(one.name)) {
        throw new Error(`Unexpected object-index shard: ${onePath}`);
      }
      for (const two of await readdir(onePath, { withFileTypes: true })) {
        const twoPath = join(onePath, two.name);
        const twoInfo = await lstat(twoPath);
        if (twoInfo.isSymbolicLink() || !twoInfo.isDirectory() || !HEX_SHARD_PATTERN.test(two.name)) {
          throw new Error(`Unexpected object-index shard: ${twoPath}`);
        }
        for (const entry of await readdir(twoPath, { withFileTypes: true })) {
          const file = join(twoPath, entry.name);
          const info = await lstat(file);
          const digest = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
          if (info.isSymbolicLink() || !info.isFile() || !SHA256_PATTERN.test(digest)) {
            throw new Error(`Unexpected object-index entry: ${file}`);
          }
          if (digest.slice(0, 2) !== one.name || digest.slice(2, 4) !== two.name) {
            throw new Error(`Object metadata is in the wrong shard: ${file}`);
          }
          files.push(file);
          if (files.length > this.#maxIndexEntries) throw new Error("Local object index exceeds its scan bound");
        }
      }
    }
    return files;
  }

  private async walkBlobFiles(): Promise<string[]> {
    const files: string[] = [];
    const first = await readdir(this.#blobs, { withFileTypes: true });
    for (const one of first) {
      const onePath = join(this.#blobs, one.name);
      const oneInfo = await lstat(onePath);
      if (oneInfo.isSymbolicLink() || !oneInfo.isDirectory() || !HEX_SHARD_PATTERN.test(one.name)) {
        throw new Error(`Unexpected object-blob shard: ${onePath}`);
      }
      for (const two of await readdir(onePath, { withFileTypes: true })) {
        const twoPath = join(onePath, two.name);
        const twoInfo = await lstat(twoPath);
        if (twoInfo.isSymbolicLink() || !twoInfo.isDirectory() || !HEX_SHARD_PATTERN.test(two.name)) {
          throw new Error(`Unexpected object-blob shard: ${twoPath}`);
        }
        for (const entry of await readdir(twoPath, { withFileTypes: true })) {
          const file = join(twoPath, entry.name);
          const info = await lstat(file);
          if (info.isSymbolicLink() || !info.isFile() || !SHA256_PATTERN.test(entry.name)) {
            throw new Error(`Unexpected object blob: ${file}`);
          }
          if (entry.name.slice(0, 2) !== one.name || entry.name.slice(2, 4) !== two.name) {
            throw new Error(`Object blob is in the wrong shard: ${file}`);
          }
          files.push(file);
          if (files.length > this.#maxIndexEntries) throw new Error("Local object blob set exceeds its scan bound");
        }
      }
    }
    return files;
  }

  private async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = join(this.#locks, "store.lock");
    const ownerPath = join(lock, "owner.json");
    const recoveryLock = join(this.#locks, "store.recovery.lock");
    const started = Date.now();
    const owner: LockOwner = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        try {
          await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
          ensurePrivateFile(ownerPath);
          fsyncDirectory(lock);
        } catch (error) {
          await removeIfPresent(ownerPath);
          await rmdir(lock).catch(() => undefined);
          throw error;
        }
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) {
          throw error;
        }
        let info;
        try {
          info = await lstat(lock);
        } catch (inspectError) {
          if (isMissingPathError(inspectError)) continue;
          throw inspectError;
        }
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing invalid object-store lock: ${lock}`);
        if (
          Date.now() - info.mtimeMs > this.#lockStaleMs &&
          await this.tryRecoverStoreLock(lock, recoveryLock)
        ) {
          continue;
        }
        if (Date.now() - started >= this.#lockTimeoutMs) throw new Error("Timed out waiting for the local object-store lock");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
    }
    fsyncDirectory(this.#locks);
    const heartbeatMs = Math.max(10, Math.min(1_000, Math.floor(this.#lockStaleMs / 3)));
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lock, now, now).catch(() => undefined);
    }, heartbeatMs);
    heartbeat.unref();
    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      try {
        const current = await readLockOwner(ownerPath);
        if (!current || current.token !== owner.token || current.pid !== owner.pid) {
          throw new Error("Local object-store lock ownership changed during an operation");
        }
        await unlink(ownerPath);
        await rmdir(lock);
        fsyncDirectory(this.#locks);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }
  }

  /**
   * Recover a lock whose recorded process is definitely gone. Recovery is
   * serialized by a sibling mutex which is never auto-stolen: an abandoned
   * recovery mutex intentionally requires operator intervention. The stale
   * lock is atomically renamed before cleanup, so cleanup can never unlink a
   * replacement store.lock acquired by another waiter.
   */
  private async tryRecoverStoreLock(lock: string, recoveryLock: string): Promise<boolean> {
    const recoveryOwnerPath = join(recoveryLock, "owner.json");
    const recoveryOwner: LockOwner = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    try {
      await mkdir(recoveryLock, { mode: 0o700 });
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }

    let recoveryOwnerWritten = false;
    try {
      await writeFile(recoveryOwnerPath, `${JSON.stringify(recoveryOwner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      recoveryOwnerWritten = true;
      ensurePrivateFile(recoveryOwnerPath);
      fsyncDirectory(recoveryLock);
      fsyncDirectory(this.#locks);

      const first = await inspectRecoverableLock(lock, this.#lockStaleMs);
      if (!first || pidIsAlive(first.owner.pid)) return false;

      const contents = await readdir(lock);
      if (contents.length !== 1 || contents[0] !== "owner.json") {
        throw new Error(`Refusing unexpected stale object-store lock contents: ${lock}`);
      }

      // Revalidate both the directory identity and owner immediately before
      // moving it out of the acquisition namespace.
      const current = await inspectRecoverableLock(lock, this.#lockStaleMs);
      if (
        !current ||
        current.info.dev !== first.info.dev ||
        current.info.ino !== first.info.ino ||
        current.owner.pid !== first.owner.pid ||
        current.owner.token !== first.owner.token ||
        pidIsAlive(current.owner.pid)
      ) {
        return false;
      }

      const quarantine = join(this.#locks, `store.recovered-${recoveryOwner.token}.lock`);
      await rename(lock, quarantine);
      fsyncDirectory(this.#locks);

      const quarantinedOwner = join(quarantine, "owner.json");
      const quarantined = await readLockOwner(quarantinedOwner);
      if (
        !quarantined ||
        quarantined.pid !== current.owner.pid ||
        quarantined.token !== current.owner.token
      ) {
        throw new Error("Local object-store stale lock changed during quarantine");
      }
      await unlink(quarantinedOwner);
      await rmdir(quarantine);
      fsyncDirectory(this.#locks);
      return true;
    } finally {
      if (!recoveryOwnerWritten) {
        // mkdir succeeded in this process, but publication did not. Removing
        // an empty directory cannot disturb another recovery owner.
        await rmdir(recoveryLock).catch(() => undefined);
      } else {
        const current = await readLockOwner(recoveryOwnerPath);
        if (
          !current ||
          current.pid !== recoveryOwner.pid ||
          current.token !== recoveryOwner.token
        ) {
          throw new Error("Local object-store recovery lock ownership changed");
        }
        const contents = await readdir(recoveryLock);
        if (contents.length !== 1 || contents[0] !== "owner.json") {
          throw new Error(`Refusing unexpected object-store recovery lock contents: ${recoveryLock}`);
        }
        await unlink(recoveryOwnerPath);
        await rmdir(recoveryLock);
        fsyncDirectory(this.#locks);
      }
    }
  }
}

class LocalObjectBody implements ObjectBody {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly body: ReadableStream<Uint8Array>;
  readonly httpMetadata?: ObjectHttpMetadata;
  readonly customMetadata?: Record<string, string>;

  constructor(metadata: StoredMetadata, body: ReadableStream<Uint8Array>) {
    this.key = metadata.key;
    this.size = metadata.size;
    this.etag = metadata.etag;
    this.uploaded = new Date(metadata.uploaded);
    this.body = body;
    this.httpMetadata = storedHttpToPort(metadata.httpMetadata);
    this.customMetadata = metadata.customMetadata ? { ...metadata.customMetadata } : undefined;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await consumeStream(this.body, this.size));
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await consumeStream(this.body, this.size);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}

export function validateLogicalKey(key: string): readonly string[] {
  if (typeof key !== "string" || key.length === 0) throw new TypeError("Object key must be a non-empty string");
  if (key.startsWith("/") || /^[A-Za-z]:/.test(key)) throw new Error("Absolute object keys are forbidden");
  if (key.includes("\\")) throw new Error("Backslashes are forbidden in object keys");
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new Error("Control characters are forbidden in object keys");
  assertValidUnicode(key);
  const encoded = new TextEncoder().encode(key);
  if (encoded.byteLength > MAX_KEY_BYTES) throw new RangeError("Object key is too long");
  const segments = key.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Object keys may not contain empty, dot, or parent segments");
  }
  for (const segment of segments) {
    if (new TextEncoder().encode(segment).byteLength > MAX_SEGMENT_BYTES) {
      throw new RangeError("Object key segment is too long");
    }
  }
  return segments;
}

function validateLogicalPrefix(prefix: string): string {
  if (typeof prefix !== "string") throw new TypeError("Object prefix must be a string");
  if (prefix === "") return prefix;
  const withoutTrailingSlash = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  validateLogicalKey(withoutTrailingSlash);
  return prefix;
}

function hashLogicalKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function normalizeHttpMetadata(metadata: ObjectHttpMetadata | undefined): StoredHttpMetadata | undefined {
  if (!metadata) return undefined;
  const result: Record<string, string> = {};
  for (const key of [
    "contentType",
    "contentLanguage",
    "contentDisposition",
    "contentEncoding",
    "cacheControl",
  ] as const) {
    const value = metadata[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 1_024 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new TypeError(`Invalid object HTTP metadata field: ${key}`);
    }
    result[key] = value;
  }
  if (metadata.cacheExpiry !== undefined) result.cacheExpiry = validDate(metadata.cacheExpiry, "cacheExpiry").toISOString();
  return Object.keys(result).length > 0 ? (result as StoredHttpMetadata) : undefined;
}

function normalizeCustomMetadata(metadata: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata);
  if (entries.length > 64) throw new RangeError("Object custom metadata has too many fields");
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  let bytes = 0;
  for (const [key, value] of entries) {
    if (!key || typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new TypeError("Invalid object custom metadata");
    }
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (bytes > 8_192) throw new RangeError("Object custom metadata is too large");
    result[key] = value;
  }
  return entries.length > 0 ? result : undefined;
}

function normalizeConditions(conditions: ObjectMetadata["onlyIf"]): ObjectMetadata["onlyIf"] {
  if (!conditions) return undefined;
  if (conditions.etagMatches !== undefined && typeof conditions.etagMatches !== "string") {
    throw new TypeError("etagMatches must be a string");
  }
  if (conditions.etagDoesNotMatch !== undefined && typeof conditions.etagDoesNotMatch !== "string") {
    throw new TypeError("etagDoesNotMatch must be a string");
  }
  return {
    ...conditions,
    ...(conditions.uploadedBefore ? { uploadedBefore: validDate(conditions.uploadedBefore, "uploadedBefore") } : {}),
    ...(conditions.uploadedAfter ? { uploadedAfter: validDate(conditions.uploadedAfter, "uploadedAfter") } : {}),
  };
}

function conditionsPass(current: StoredMetadata | null, conditions: ObjectMetadata["onlyIf"]): boolean {
  if (!conditions) return true;
  if (conditions.etagMatches !== undefined) {
    if (!current || (conditions.etagMatches !== "*" && current.etag !== conditions.etagMatches)) return false;
  }
  if (conditions.etagDoesNotMatch !== undefined) {
    if (conditions.etagDoesNotMatch === "*" ? current !== null : current?.etag === conditions.etagDoesNotMatch) return false;
  }
  if (conditions.uploadedBefore !== undefined) {
    if (!current || Date.parse(current.uploaded) >= conditions.uploadedBefore.getTime()) return false;
  }
  if (conditions.uploadedAfter !== undefined) {
    if (!current || Date.parse(current.uploaded) <= conditions.uploadedAfter.getTime()) return false;
  }
  return true;
}

function validateStoredMetadata(value: unknown): StoredMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object metadata record");
  const record = value as Record<string, unknown>;
  if (record.version !== METADATA_VERSION || typeof record.key !== "string") throw new Error("Unsupported object metadata record");
  validateLogicalKey(record.key);
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 0) throw new Error("Invalid object metadata size");
  if (typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)) throw new Error("Invalid object metadata digest");
  if (record.etag !== record.sha256) throw new Error("Invalid object metadata etag");
  if (typeof record.uploaded !== "string" || !Number.isFinite(Date.parse(record.uploaded))) throw new Error("Invalid object metadata timestamp");
  const httpMetadata = validateStoredHttp(record.httpMetadata);
  const customMetadata = validateStoredCustom(record.customMetadata);
  return {
    version: 1,
    key: record.key,
    size: record.size as number,
    sha256: record.sha256,
    etag: record.sha256,
    uploaded: new Date(record.uploaded).toISOString(),
    ...(httpMetadata ? { httpMetadata } : {}),
    ...(customMetadata ? { customMetadata } : {}),
  };
}

function validateStoredHttp(value: unknown): StoredHttpMetadata | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored HTTP metadata");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["contentType", "contentLanguage", "contentDisposition", "contentEncoding", "cacheControl", "cacheExpiry"]);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (!allowed.has(key) || typeof item !== "string") throw new Error("Invalid stored HTTP metadata");
    if (key === "cacheExpiry") {
      if (!Number.isFinite(Date.parse(item))) throw new Error("Invalid stored cache expiry");
      result[key] = new Date(item).toISOString();
    } else {
      if (item.length > 1_024 || /[\u0000-\u001f\u007f]/.test(item)) throw new Error("Invalid stored HTTP metadata");
      result[key] = item;
    }
  }
  return Object.keys(result).length ? (result as StoredHttpMetadata) : undefined;
}

function validateStoredCustom(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored custom metadata");
  return normalizeCustomMetadata(value as Record<string, string>);
}

function metadataToHead(metadata: StoredMetadata): ObjectHead {
  return {
    key: metadata.key,
    size: metadata.size,
    etag: metadata.etag,
    uploaded: new Date(metadata.uploaded),
    ...(metadata.httpMetadata ? { httpMetadata: storedHttpToPort(metadata.httpMetadata) } : {}),
    ...(metadata.customMetadata ? { customMetadata: { ...metadata.customMetadata } } : {}),
  };
}

function storedHttpToPort(metadata: StoredHttpMetadata | undefined): ObjectHttpMetadata | undefined {
  if (!metadata) return undefined;
  const { cacheExpiry, ...rest } = metadata;
  return {
    ...rest,
    ...(cacheExpiry ? { cacheExpiry: new Date(cacheExpiry) } : {}),
  };
}

async function* bodyChunks(value: PortableBody): AsyncGenerator<Uint8Array> {
  if (typeof value === "string") {
    yield new TextEncoder().encode(value);
    return;
  }
  if (value instanceof ArrayBuffer) {
    yield new Uint8Array(value.slice(0));
    return;
  }
  if (ArrayBuffer.isView(value)) {
    yield new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return;
  }
  if (!(value instanceof ReadableStream)) throw new TypeError("Unsupported local object body");
  const reader = value.getReader();
  let complete = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        return;
      }
      if (!(next.value instanceof Uint8Array)) throw new TypeError("Object streams must yield Uint8Array chunks");
      yield new Uint8Array(next.value);
    }
  } finally {
    if (!complete) await reader.cancel("Local object write aborted").catch(() => undefined);
    reader.releaseLock();
  }
}

async function consumeStream(stream: ReadableStream<Uint8Array>, expectedSize: number): Promise<Uint8Array> {
  const result = new Uint8Array(expectedSize);
  const reader = stream.getReader();
  let offset = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.byteLength > expectedSize) throw new Error("Object stream exceeded verified size");
      result.set(next.value, offset);
      offset += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedSize) throw new Error("Object stream ended before verified size");
  return result;
}

function encodeCursor(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  if (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 2_000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error("Invalid object list cursor");
  }
  const key = Buffer.from(cursor, "base64url").toString("utf8");
  validateLogicalKey(key);
  if (encodeCursor(key) !== cursor.replace(/=+$/, "")) throw new Error("Invalid object list cursor encoding");
  return key;
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error("Object keys must contain valid Unicode");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("Object keys must contain valid Unicode");
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`${name} must be a valid Date`);
  return new Date(value.getTime());
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readLockOwner(path: string): Promise<LockOwner | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing symbolic-link object-store lock owner: ${path}`);
    if (!info.isFile() || info.size > 4_096) return null;
    const handle = await open(path, constants.O_RDONLY | noFollowFlag());
    let raw: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > 4_096) return null;
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) < 1 ||
      typeof parsed.token !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return parsed as LockOwner;
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function inspectRecoverableLock(path: string, staleMs: number): Promise<RecoverableLock | null> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Refusing invalid object-store lock: ${path}`);
  }
  if (Date.now() - info.mtimeMs <= staleMs) return null;

  // A missing or malformed owner may be an interrupted lock publication.
  // Recovering it automatically would trade availability for possible overlap,
  // so fail closed and require operator intervention instead.
  const owner = await readLockOwner(join(path, "owner.json"));
  return owner ? { info, owner } : null;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ESRCH" || code === "EINVAL") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}
