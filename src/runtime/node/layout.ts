import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
export const PORTABLE_NODE_MINIMUM_VERSION = "24.4.0";
export const DRIFTGLASS_MANAGED_DIRECTORY_MARKER = ".driftglass-managed-directory.json";

export type ManagedDirectoryKind = "local-data-root" | "object-store";

export interface LocalDataLayout {
  readonly root: string;
  readonly stateDirectory: string;
  readonly databasePath: string;
  readonly objectStoreDirectory: string;
  readonly missionWorkspaceDirectory: string;
  readonly backupDirectory: string;
  readonly runtimeDirectory: string;
}

export function assertPortableNodeRuntime(version = process.versions.node): void {
  const parsed = version.split("-", 1)[0]!.split(".").map(Number);
  const minimum = PORTABLE_NODE_MINIMUM_VERSION.split(".").map(Number);
  const supported = minimum.every((part, index) => {
    const actual = parsed[index] ?? 0;
    const earlier = minimum.slice(0, index).every((prior, priorIndex) => (parsed[priorIndex] ?? 0) === prior);
    return !earlier || actual >= part;
  });
  if (parsed.some((part) => !Number.isSafeInteger(part) || part < 0) || !supported) {
    throw new Error(
      `Driftglass local persistence requires Node.js ${PORTABLE_NODE_MINIMUM_VERSION} or newer (found ${version})`,
    );
  }
}

/**
 * Returns the conventional per-user Driftglass data directory for this OS.
 * Callers may always pass an explicit directory to createLocalDataLayout().
 */
export function defaultLocalDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Driftglass");
  }
  if (platform() === "win32") {
    const base = environment.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, "Driftglass");
  }
  const base = environment.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "driftglass");
}

export function createLocalDataLayout(root = defaultLocalDataDirectory()): LocalDataLayout {
  const resolvedRoot = ensureManagedPrivateDirectory(root, "local-data-root");

  const stateDirectory = join(resolvedRoot, "state");
  const objectStoreDirectory = join(resolvedRoot, "objects");
  const missionWorkspaceDirectory = join(resolvedRoot, "missions");
  const backupDirectory = join(resolvedRoot, "backups");
  const runtimeDirectory = join(resolvedRoot, "runtime");

  for (const directory of [
    stateDirectory,
    objectStoreDirectory,
    missionWorkspaceDirectory,
    backupDirectory,
    runtimeDirectory,
  ]) {
    assertPathWithin(resolvedRoot, directory);
    assertNoSymlinkComponents(resolvedRoot, directory, true);
    ensurePrivateDirectory(directory);
    assertNoSymlinkComponents(resolvedRoot, directory);
  }

  return Object.freeze({
    root: resolvedRoot,
    stateDirectory,
    databasePath: join(stateDirectory, "driftglass.sqlite3"),
    objectStoreDirectory,
    missionWorkspaceDirectory,
    backupDirectory,
    runtimeDirectory,
  });
}

/**
 * Adopt a caller-selected persistence root only when it is new, empty, or
 * already carries Driftglass's exact kind-bound marker. Validation precedes
 * chmod and child creation, so an unrelated directory is never modified.
 */
export function ensureManagedPrivateDirectory(directory: string, kind: ManagedDirectoryKind): string {
  const resolved = validateManagedDirectoryPath(directory);
  assertNoSymlinkAncestors(resolved, true);
  try {
    const existing = lstatSync(resolved);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Refusing non-directory or symbolic-link data path: ${resolved}`);
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    mkdirSync(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }

  const marker = join(resolved, DRIFTGLASS_MANAGED_DIRECTORY_MARKER);
  const entries = readdirSync(resolved);
  if (entries.length === 0) {
    const body = managedDirectoryMarkerBody(kind);
    try {
      writeFileSync(marker, body, { encoding: "utf8", flag: "wx", mode: PRIVATE_FILE_MODE });
      ensurePrivateFile(marker);
      fsyncFile(marker);
      fsyncDirectory(resolved);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) {
        throw error;
      }
      assertManagedDirectoryMarker(marker, kind);
    }
  } else {
    if (!entries.includes(DRIFTGLASS_MANAGED_DIRECTORY_MARKER)) {
      throw new Error(`Refusing to adopt a nonempty unmarked data directory: ${resolved}`);
    }
    assertManagedDirectoryMarker(marker, kind);
  }

  ensurePrivateDirectory(resolved);
  return resolved;
}

/** Pure path gate used before any managed-root filesystem operation. */
export function validateManagedDirectoryPath(directory: string): string {
  if (!directory || !isAbsolute(directory)) {
    throw new TypeError("A managed data directory must be an absolute path");
  }
  const resolved = resolve(directory);
  if (resolved === parse(resolved).root) {
    throw new Error(`Refusing to use a filesystem root as managed data: ${resolved}`);
  }
  return resolved;
}

export function ensurePrivateDirectory(directory: string): void {
  assertNoSymlinkAncestors(directory, true);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing non-directory or symbolic-link data path: ${directory}`);
  }
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
}

/**
 * Checks every existing component from the filesystem root before any mkdir.
 * This intentionally rejects POSIX symlinks and Windows junction/reparse links
 * in a configured data path instead of creating data through them.
 */
export function assertNoSymlinkAncestors(candidate: string, allowMissingTail = false): void {
  const normalized = resolve(candidate);
  const parsed = parse(normalized);
  const components = normalized.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  let missing = false;

  for (const component of components) {
    current = join(current, component);
    if (missing) continue;
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link data path: ${current}`);
      if (current !== normalized && !stat.isDirectory()) {
        throw new Error(`Refusing non-directory path component: ${current}`);
      }
    } catch (error) {
      if (allowMissingTail && isMissingPathError(error)) {
        missing = true;
        continue;
      }
      throw error;
    }
  }
}

export function ensurePrivateFile(file: string): void {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing non-file or symbolic-link data path: ${file}`);
  }
  chmodSync(file, PRIVATE_FILE_MODE);
}

export function assertPathWithin(root: string, candidate: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const suffix = relative(normalizedRoot, normalizedCandidate);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`Path escapes the managed data directory: ${candidate}`);
  }
}

/** Rejects every symlink at or below root without resolving through it. */
export function assertNoSymlinkComponents(root: string, candidate: string, allowMissing = false): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  assertPathWithin(normalizedRoot, normalizedCandidate);

  const suffix = relative(normalizedRoot, normalizedCandidate);
  const components = suffix ? suffix.split(sep) : [];
  let current = normalizedRoot;

  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = join(current, components[index]!);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic-link data path: ${current}`);
      }
      if (index < components.length - 1 && !stat.isDirectory()) {
        throw new Error(`Refusing non-directory path component: ${current}`);
      }
    } catch (error) {
      if (allowMissing && isMissingPathError(error)) return;
      throw error;
    }
  }
}

export function fsyncDirectory(directory: string): void {
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Refusing non-directory or symbolic-link fsync target: ${directory}`);
  }
  if (platform() === "win32") {
    // Node cannot open a Windows directory with a handle that FlushFileBuffers
    // accepts. File contents are still flushed separately; Node exposes no
    // directory-flush primitive on this platform.
    return;
  }

  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function fsyncFile(file: string): void {
  // FlushFileBuffers rejects the read-only handles produced by O_RDONLY on
  // Windows. A writable handle is required there; fsync failures still surface.
  const descriptor = openSync(file, platform() === "win32" ? constants.O_RDWR : constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function ensureParentDirectory(root: string, file: string): string {
  assertPathWithin(root, file);
  const parent = dirname(file);
  assertNoSymlinkComponents(root, parent, true);
  ensurePrivateDirectory(parent);
  assertNoSymlinkComponents(root, parent);
  return parent;
}

export function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function managedDirectoryMarkerBody(kind: ManagedDirectoryKind): string {
  return `${JSON.stringify({ format: "driftglass-managed-directory", version: 1, kind })}\n`;
}

function assertManagedDirectoryMarker(marker: string, kind: ManagedDirectoryKind): void {
  const expected = managedDirectoryMarkerBody(kind);
  const info = lstatSync(marker);
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > 512) {
    throw new Error(`Refusing invalid managed-directory marker: ${marker}`);
  }
  const descriptor = openSync(
    marker,
    constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0),
  );
  let actual: string;
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== info.size) {
      throw new Error(`Refusing changed managed-directory marker: ${marker}`);
    }
    actual = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  if (actual !== expected) {
    throw new Error(`Managed-directory marker kind or version does not match: ${marker}`);
  }
}
