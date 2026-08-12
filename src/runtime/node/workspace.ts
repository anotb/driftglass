import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type {
  CanonicalStateLocation,
  PortableBody,
  RuntimeProfile,
  Workspace,
  WorkspaceArchive,
  WorkspaceEntry,
  WorkspaceGrepHit,
  WorkspacePort,
} from "../ports";
import {
  assertNoSymlinkComponents,
  assertPathWithin,
  ensurePrivateDirectory,
  fsyncDirectory,
} from "./layout";
import { DRIFTGLASS_LOCAL_MIGRATION_HEAD } from "./migrations";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_LOGICAL_PATH_BYTES = 2_048;
const MAX_PATH_SEGMENT_BYTES = 255;
const MAX_WORKSPACE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 2_000;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_SEARCH_FILES = 1_200;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const MAX_SEARCH_HITS = 600;
const ATOMIC_TEMP_PREFIX = ".driftglass-write-";
const WINDOWS_UNSAFE_SEGMENT = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const TEXT_ENCODER = new TextEncoder();

export interface LocalMissionWorkspaceOptions {
  readonly profile?: RuntimeProfile;
  readonly canonicalState?: CanonicalStateLocation;
  readonly schemaVersion?: number;
  readonly migrationHead?: string;
}

interface ResolvedWorkspacePath {
  readonly logical: string;
  readonly relative: string;
  readonly absolute: string;
}

class MissionWorkspaceSafetyError extends Error {
  readonly code = "ERR_DRIFTGLASS_WORKSPACE_PATH";

  constructor(message = "Mission workspace path is unsafe") {
    super(message);
    this.name = "MissionWorkspaceSafetyError";
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function migrationHeadIdentity(): string {
  return `${DRIFTGLASS_LOCAL_MIGRATION_HEAD.name}:${DRIFTGLASS_LOCAL_MIGRATION_HEAD.sha256}`;
}

function safeMissionId(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new TypeError("A Mission workspace requires a nonempty Mission ID");
  }
  const bytes = TEXT_ENCODER.encode(value).byteLength;
  if (bytes > 512) throw new Error("Mission ID exceeds the local workspace limit");
  return value;
}

function missionDirectoryName(missionId: string): string {
  // A digest is stable across operating systems and avoids reserved Windows
  // device names while keeping untrusted identifiers out of filesystem paths.
  return `mission-${sha256(safeMissionId(missionId))}`;
}

function safeRelativePath(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid Mission workspace path");
  if (TEXT_ENCODER.encode(value).byteLength > MAX_LOGICAL_PATH_BYTES) {
    throw new Error("Mission workspace path is too long");
  }
  const portable = value.replaceAll("\\", "/");
  if (/^[a-zA-Z]:/.test(portable) || portable.startsWith("//")) {
    throw new Error("Mission workspace path must be workspace-relative");
  }
  const withoutRoot = portable.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!withoutRoot) return "";
  const segments = withoutRoot.split("/");
  for (const segment of segments) {
    if (
      !segment
      || segment === "."
      || segment === ".."
      || segment.startsWith(ATOMIC_TEMP_PREFIX)
      || /[\u0000-\u001f\u007f]/.test(segment)
      || WINDOWS_UNSAFE_SEGMENT.test(segment)
      || WINDOWS_RESERVED_NAME.test(segment)
      || segment.endsWith(".")
      || segment.endsWith(" ")
      || TEXT_ENCODER.encode(segment).byteLength > MAX_PATH_SEGMENT_BYTES
    ) {
      throw new Error("Invalid Mission workspace path segment");
    }
  }
  return segments.join("/");
}

function logicalPath(relativePath: string): string {
  return relativePath ? `/${relativePath.split(sep).join("/")}` : "/";
}

async function bodyBytes(body: PortableBody): Promise<Uint8Array> {
  if (typeof body === "string") {
    const encoded = TEXT_ENCODER.encode(body);
    if (encoded.byteLength > MAX_WORKSPACE_FILE_BYTES) throw new Error("Mission workspace file is too large");
    return encoded;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > MAX_WORKSPACE_FILE_BYTES) throw new Error("Mission workspace file is too large");
    return new Uint8Array(body);
  }
  if (body instanceof ArrayBuffer) {
    if (body.byteLength > MAX_WORKSPACE_FILE_BYTES) throw new Error("Mission workspace file is too large");
    return new Uint8Array(body.slice(0));
  }
  if (ArrayBuffer.isView(body)) {
    if (body.byteLength > MAX_WORKSPACE_FILE_BYTES) throw new Error("Mission workspace file is too large");
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }
  if (!(body instanceof ReadableStream)) throw new TypeError("Unsupported Mission workspace file body");

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw new TypeError("Mission workspace streams must contain bytes");
      bytes += result.value.byteLength;
      if (bytes > MAX_WORKSPACE_FILE_BYTES) throw new Error("Mission workspace file is too large");
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function existingKind(path: string): Promise<"missing" | "file" | "directory"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new MissionWorkspaceSafetyError();
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    throw new Error("Special filesystem entries are not allowed in Mission workspaces");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

class LocalMissionWorkspace implements Workspace {
  readonly #root: string;
  readonly #missionId: string;
  readonly #profile: RuntimeProfile;
  readonly #canonicalState: CanonicalStateLocation;
  readonly #schemaVersion: number;
  readonly #migrationHead: string;

  constructor(root: string, missionId: string, options: Required<LocalMissionWorkspaceOptions>) {
    this.#root = resolve(root);
    this.#missionId = missionId;
    this.#profile = options.profile;
    this.#canonicalState = options.canonicalState;
    this.#schemaVersion = options.schemaVersion;
    this.#migrationHead = options.migrationHead;
  }

  async initialize(): Promise<void> {
    ensurePrivateDirectory(this.#root);
    assertNoSymlinkComponents(this.#root, this.#root);
  }

  #resolve(input: string): ResolvedWorkspacePath {
    try {
      const relativePath = safeRelativePath(input);
      const absolute = relativePath ? resolve(this.#root, ...relativePath.split("/")) : this.#root;
      assertPathWithin(this.#root, absolute);
      assertNoSymlinkComponents(this.#root, absolute, true);
      return Object.freeze({ logical: logicalPath(relativePath), relative: relativePath, absolute });
    } catch (error) {
      if (error instanceof MissionWorkspaceSafetyError) throw error;
      throw new MissionWorkspaceSafetyError();
    }
  }

  async #ensureDirectory(path: ResolvedWorkspacePath): Promise<void> {
    if (!path.relative) return;
    let current = this.#root;
    for (const segment of path.relative.split("/")) {
      current = join(current, segment);
      assertPathWithin(this.#root, current);
      assertNoSymlinkComponents(this.#root, current, true);
      const kind = await existingKind(current);
      if (kind === "file") throw new Error("Mission workspace directory path is occupied by a file");
      if (kind === "missing") {
        await mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
        fsyncDirectory(dirname(current));
      }
      await chmod(current, PRIVATE_DIRECTORY_MODE);
      assertNoSymlinkComponents(this.#root, current);
    }
  }

  async #atomicWrite(path: ResolvedWorkspacePath, bytes: Uint8Array): Promise<void> {
    if (!path.relative) throw new Error("Cannot write the Mission workspace root as a file");
    const separator = path.relative.lastIndexOf("/");
    const parent = this.#resolve(separator < 0 ? "/" : `/${path.relative.slice(0, separator)}`);
    await this.#ensureDirectory(parent);
    const current = await existingKind(path.absolute);
    if (current === "directory") throw new Error("Mission workspace file path is occupied by a directory");

    const temporary = join(parent.absolute, `${ATOMIC_TEMP_PREFIX}${process.pid}-${randomUUID()}`);
    assertPathWithin(this.#root, temporary);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, PRIVATE_FILE_MODE);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      assertNoSymlinkComponents(this.#root, parent.absolute);
      await rename(temporary, path.absolute);
      await chmod(path.absolute, PRIVATE_FILE_MODE);
      fsyncDirectory(parent.absolute);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #readBytes(path: ResolvedWorkspacePath): Promise<{ bytes: Uint8Array; updatedAt: string }> {
    if (!path.relative) throw new Error("Mission workspace path is a directory");
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(path.absolute, constants.O_RDONLY | noFollow);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Mission workspace path is not a regular file");
      if (info.size > MAX_WORKSPACE_FILE_BYTES) throw new Error("Mission workspace file is too large");
      const buffer = await handle.readFile();
      return { bytes: new Uint8Array(buffer), updatedAt: info.mtime.toISOString() };
    } finally {
      await handle.close();
    }
  }

  async #entries(path: ResolvedWorkspacePath): Promise<WorkspaceEntry[]> {
    const kind = await existingKind(path.absolute);
    if (kind !== "directory") throw new Error("Mission workspace path is not a directory");
    const entries = await readdir(path.absolute, { withFileTypes: true });
    const output: WorkspaceEntry[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(ATOMIC_TEMP_PREFIX)) continue;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new MissionWorkspaceSafetyError("Mission workspace contains an unsafe filesystem entry");
      }
      output.push({ name: entry.name, isDirectory: entry.isDirectory() });
    }
    return output;
  }

  async #walkFiles(start: ResolvedWorkspacePath): Promise<ResolvedWorkspacePath[]> {
    const output: ResolvedWorkspacePath[] = [];
    const visit = async (current: ResolvedWorkspacePath): Promise<void> => {
      if (output.length >= MAX_ARCHIVE_FILES) throw new Error("Mission workspace contains too many files");
      const kind = await existingKind(current.absolute);
      if (kind === "file") {
        output.push(current);
        return;
      }
      if (kind !== "directory") throw new Error("Mission workspace path does not exist");
      for (const entry of await this.#entries(current)) {
        const child = this.#resolve(current.logical === "/" ? `/${entry.name}` : `${current.logical}/${entry.name}`);
        if (entry.isDirectory) await visit(child);
        else output.push(child);
        if (output.length > MAX_ARCHIVE_FILES) throw new Error("Mission workspace contains too many files");
      }
    };
    await visit(start);
    return output.sort((left, right) => left.logical.localeCompare(right.logical));
  }

  readonly fs = {
    readFile: async (path: string, encoding?: "utf8"): Promise<string | Uint8Array> => {
      const result = await this.#readBytes(this.#resolve(path));
      return encoding === "utf8" ? new TextDecoder("utf-8", { fatal: true }).decode(result.bytes) : result.bytes;
    },
    writeFile: async (path: string, data: PortableBody): Promise<void> => {
      await this.#atomicWrite(this.#resolve(path), await bodyBytes(data));
    },
    mkdir: async (path: string, _options?: { recursive?: boolean }): Promise<void> => {
      await this.#ensureDirectory(this.#resolve(path));
    },
    readdir: async (path: string): Promise<WorkspaceEntry[]> => this.#entries(this.#resolve(path)),
    rm: async (path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> => {
      const target = this.#resolve(path);
      if (!target.relative) throw new Error("Cannot remove the Mission workspace root");
      const kind = await existingKind(target.absolute);
      if (kind === "missing") {
        if (options?.force) return;
        throw Object.assign(new Error("Mission workspace path does not exist"), { code: "ENOENT" });
      }
      if (kind === "directory" && !options?.recursive && (await this.#entries(target)).length > 0) {
        throw new Error("Mission workspace directory is not empty");
      }
      if (kind === "directory") await this.#walkFiles(target);
      await rm(target.absolute, { recursive: Boolean(options?.recursive), force: Boolean(options?.force) });
      fsyncDirectory(dirname(target.absolute));
    },
    grep: async (query: string, path = "/"): Promise<WorkspaceGrepHit[]> => {
      const clean = query.trim();
      if (!clean) throw new Error("Mission workspace search query is required");
      if (TEXT_ENCODER.encode(clean).byteLength > 1_024) throw new Error("Mission workspace search query is too long");
      const files = await this.#walkFiles(this.#resolve(path));
      const needle = clean.toLocaleLowerCase("en-US");
      const hits: WorkspaceGrepHit[] = [];
      let scannedBytes = 0;
      let scannedFiles = 0;
      for (const file of files) {
        if (++scannedFiles > MAX_SEARCH_FILES) break;
        const result = await this.#readBytes(file).catch(() => null);
        if (!result) continue;
        scannedBytes += result.bytes.byteLength;
        if (scannedBytes > MAX_SEARCH_BYTES) break;
        if (result.bytes.includes(0)) continue;
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!;
          if (!line.toLocaleLowerCase("en-US").includes(needle)) continue;
          hits.push({ path: file.logical, line: index + 1, text: line.slice(0, 4_000) });
          if (hits.length >= MAX_SEARCH_HITS) return hits;
        }
      }
      return hits;
    },
  };

  async export(): Promise<WorkspaceArchive> {
    const files: WorkspaceArchive["files"][number][] = [];
    let totalBytes = 0;
    for (const path of await this.#walkFiles(this.#resolve("/"))) {
      const result = await this.#readBytes(path);
      totalBytes += result.bytes.byteLength;
      if (totalBytes > MAX_ARCHIVE_BYTES) throw new Error("Mission workspace export exceeds the archive limit");
      files.push(Object.freeze({
        path: path.logical,
        body: result.bytes,
        size: result.bytes.byteLength,
        sha256: sha256(result.bytes),
        updatedAt: result.updatedAt,
      }));
    }
    const manifest = {
      version: 1,
      missionId: this.#missionId,
      sourceProfile: this.#profile,
      sourceCanonicalState: this.#canonicalState,
      schemaVersion: this.#schemaVersion,
      migrationHead: this.#migrationHead,
      files: files.map(({ path, size, sha256: digest, updatedAt }) => ({ path, size, sha256: digest, updatedAt })),
    } as const;
    return Object.freeze({ ...manifest, files: Object.freeze(files), manifestSha256: sha256(JSON.stringify(manifest)) });
  }

  async import(archive: WorkspaceArchive): Promise<void> {
    if (archive.version !== 1 || archive.missionId !== this.#missionId || !Array.isArray(archive.files)) {
      throw new Error("Mission workspace archive does not match this Mission");
    }
    if (archive.files.length > MAX_ARCHIVE_FILES) throw new Error("Mission workspace archive contains too many files");
    const paths = new Set<string>();
    const prepared: Array<{ path: ResolvedWorkspacePath; body: Uint8Array }> = [];
    let totalBytes = 0;
    for (const file of archive.files) {
      const path = this.#resolve(file.path);
      if (!path.relative || paths.has(path.logical)) throw new Error("Mission workspace archive contains an invalid or duplicate path");
      paths.add(path.logical);
      const body = await bodyBytes(file.body);
      totalBytes += body.byteLength;
      if (
        totalBytes > MAX_ARCHIVE_BYTES
        || file.size !== body.byteLength
        || file.sha256 !== sha256(body)
      ) throw new Error("Mission workspace archive failed size or hash verification");
      prepared.push({ path, body });
    }
    for (const file of prepared) await this.#atomicWrite(file.path, file.body);
  }
}

/** Filesystem-only, one-directory-per-Mission WorkspacePort for the experimental local profile. */
export class LocalMissionWorkspacePort implements WorkspacePort {
  readonly #root: string;
  readonly #options: Required<LocalMissionWorkspaceOptions>;

  constructor(root: string, options: LocalMissionWorkspaceOptions = {}) {
    this.#root = resolve(root);
    ensurePrivateDirectory(this.#root);
    assertNoSymlinkComponents(this.#root, this.#root);
    this.#options = Object.freeze({
      profile: options.profile ?? "selfhost",
      canonicalState: options.canonicalState ?? "local",
      schemaVersion: options.schemaVersion ?? DRIFTGLASS_LOCAL_MIGRATION_HEAD.version,
      migrationHead: options.migrationHead ?? migrationHeadIdentity(),
    });
  }

  async forMission(missionId: string): Promise<Workspace> {
    const safeId = safeMissionId(missionId);
    const root = resolve(this.#root, missionDirectoryName(safeId));
    assertPathWithin(this.#root, root);
    assertNoSymlinkComponents(this.#root, root, true);
    const workspace = new LocalMissionWorkspace(root, safeId, this.#options);
    await workspace.initialize();
    return workspace;
  }
}

export const LOCAL_MISSION_WORKSPACE_LIMITS = Object.freeze({
  fileBytes: MAX_WORKSPACE_FILE_BYTES,
  archiveFiles: MAX_ARCHIVE_FILES,
  archiveBytes: MAX_ARCHIVE_BYTES,
  searchFiles: MAX_SEARCH_FILES,
  searchBytes: MAX_SEARCH_BYTES,
  searchHits: MAX_SEARCH_HITS,
});
