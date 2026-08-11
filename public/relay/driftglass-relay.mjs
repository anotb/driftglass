#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PLATFORM = process.env.DRIFTGLASS_TEST_PLATFORM || process.platform;
const HOME = homedir();
const CONFIG_ROOT = PLATFORM === "win32"
  ? (process.env.APPDATA || join(HOME, "AppData", "Roaming"))
  : (process.env.XDG_CONFIG_HOME || join(HOME, ".config"));
const STATE_ROOT = PLATFORM === "win32"
  ? (process.env.LOCALAPPDATA || join(HOME, "AppData", "Local"))
  : (process.env.XDG_STATE_HOME || join(HOME, ".local", "state"));
const DATA_ROOT = PLATFORM === "win32"
  ? (process.env.LOCALAPPDATA || join(HOME, "AppData", "Local"))
  : (process.env.XDG_DATA_HOME || join(HOME, ".local", "share"));
const CONFIG_PATH = join(CONFIG_ROOT, "driftglass", "relay.json");
const STATE_DIR = join(STATE_ROOT, "driftglass");
const TOKEN_DIR = join(STATE_DIR, "tokens");
const PAIRING_JOURNAL_PATH = join(STATE_DIR, "pairing-journal.json");
const SERVICE_OPERATION_LOCK_PATH = join(STATE_DIR, "service-operation.lock");
const RESULT_OUTBOX_PATH = join(STATE_DIR, "result-outbox.json");
const WORKSPACE_ROOT = join(DATA_ROOT, "driftglass", "workspaces");
const KEYCHAIN_SERVICE = "driftglass-relay";
const LAUNCH_AGENT = join(HOME, "Library", "LaunchAgents", "dev.driftglass.relay.plist");
const SYSTEMD_UNIT = join(CONFIG_ROOT, "systemd", "user", "driftglass-relay.service");
const WINDOWS_TASK = "Driftglass Relay";
const WINDOWS_RUNNER = join(STATE_DIR, "driftglass-relay.cmd");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VERSION = "0.9.0";
const POLL_MIN_MS = 15_000;
const POLL_MAX_MS = 120_000;
const HEARTBEAT_MS = 4 * 60_000;
const DETAILED_HEARTBEAT_MS = 6 * 60 * 60_000;
const WORKSPACE_SYNC_MS = 15 * 60_000;
const TEST_LOOP_LIMIT = Math.max(0, Number(process.env.DRIFTGLASS_TEST_LOOP_LIMIT || 0) || 0);
const TEST_DELAY_CAP_MS = Math.max(0, Number(process.env.DRIFTGLASS_TEST_DELAY_CAP_MS || 0) || 0);
const TEST_NETWORK_TIMEOUT_MS = Math.max(0, Number(process.env.DRIFTGLASS_TEST_NETWORK_TIMEOUT_MS || 0) || 0);
const TEST_EXIT_AFTER_OUTBOX_WRITE = process.env.DRIFTGLASS_TEST_EXIT_AFTER_OUTBOX_WRITE === "1";
const TEST_OUTBOX_CRASH_POINT = String(process.env.DRIFTGLASS_TEST_OUTBOX_CRASH_POINT || "");
const TEST_TOKEN_CRASH_POINT = String(process.env.DRIFTGLASS_TEST_TOKEN_CRASH_POINT || "");
const TEST_TOKEN_FAILURE_POINT = String(process.env.DRIFTGLASS_TEST_TOKEN_FAILURE_POINT || "");
const TEST_SERVICE_LOCK_CRASH_POINT = String(process.env.DRIFTGLASS_TEST_SERVICE_LOCK_CRASH_POINT || "");
const MAX_ITEMS = 250;
// Keep the exact request below the Worker's 2 MB JSON reader limit. The local
// envelope is larger because it stores those bytes as base64 plus metadata.
const MAX_RESULT_PAYLOAD_BYTES = 1_800_000;
const MAX_RESULT_OUTBOX_BYTES = Math.ceil(MAX_RESULT_PAYLOAD_BYTES * 4 / 3) + 4_096;
// Leave headroom for heartbeat diagnostics beneath the Worker's 1 MB JSON request limit.
const MAX_CATALOG_PAYLOAD_BYTES = 850_000;
const DEFAULT_REQUEST_TIMEOUT_MS = TEST_NETWORK_TIMEOUT_MS || 30_000;
const WORKSPACE_REQUEST_TIMEOUT_MS = TEST_NETWORK_TIMEOUT_MS || 90_000;
const MAX_JSON_RESPONSE_BYTES = 1_000_000;
const MAX_WORKSPACE_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 2_000;
const MAX_WORKSPACE_DIRECTORIES = 2_000;
const MAX_WORKSPACE_DEPTH = 64;
const MAX_WORKSPACE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_WORKSPACE_SEARCH_BYTES = 32 * 1024 * 1024;
const MAX_WORKSPACE_PUSH_FILES = 120;
const MAX_WORKSPACE_PUSH_FILE_BYTES = 1_000_000;
const MAX_WORKSPACE_PUSH_TOTAL_BYTES = 4_000_000;
const MAX_WORKSPACE_PUSH_REQUEST_BYTES = 4_400_000;
const WORKSPACE_ARCHIVE_SCHEMA_VERSION = "1";
const WORKSPACE_METADATA_FILE = ".driftglass-workspace.json";
const MAX_UPDATE_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURED_COMMAND_BYTES = 2 * 1024 * 1024;
const OPENCLI_PREFLIGHT_TIMEOUT_MS = 20_000;
const OPENCLI_PREFLIGHT_TTL_MS = 30_000;
const RESULT_JOB_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const RESULT_OUTBOX_TEMP_PATTERN = /^\.result-outbox\.(\d+)\.([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.tmp$/i;
const PRIVATE_TOKEN_TEMP_PATTERN = /^\.([A-Za-z0-9._-]{1,200})\.(\d+)\.([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.tmp$/i;
const PAIRING_JOURNAL_TEMP_PATTERN = /^\.pairing-journal\.(\d+)\.([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.tmp$/i;
const SERVICE_OPERATION_LOCK_TEMP_PATTERN = /^\.service-operation\.(\d+)\.([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.tmp$/i;
const MAX_PRIVATE_TOKEN_DIRECTORY_ENTRIES = 256;
const MAX_PAIRING_JOURNAL_BYTES = 4_096;
const MAX_SERVICE_OPERATION_LOCK_BYTES = 1_024;

const CAPABILITIES = Object.freeze([
  "x.trending", "x.search", "x.timeline", "x.bookmarks", "x.list", "x.thread",
  "x.notifications", "x.likes", "x.user", "x.user-posts", "x.article",
  "reddit.frontpage", "reddit.home", "reddit.popular", "reddit.subreddit", "reddit.search",
  "reddit.saved", "reddit.upvoted", "reddit.subscribed", "reddit.thread", "reddit.user",
  "reddit.user-posts", "reddit.user-comments", "reddit.subreddit-info",
  "youtube.search", "youtube.video", "youtube.transcript", "youtube.comments", "youtube.channel",
  "youtube.playlist", "youtube.feed", "youtube.history", "youtube.watch-later", "youtube.subscriptions",
  "linkedin.timeline", "linkedin.jobs", "linkedin.people", "linkedin.profile", "linkedin.posts", "linkedin.job",
  "instagram.explore", "instagram.search", "instagram.user", "instagram.profile",
  "facebook.feed", "facebook.search", "facebook.groups", "facebook.profile",
  "tiktok.explore", "tiktok.search", "tiktok.user", "tiktok.profile",
  "opencli.read",
  "workspace.mirror",
]);

const OPENCLI_READ_COMMANDS = new Set([
  "twitter trending", "twitter search", "twitter timeline", "twitter bookmarks", "twitter list-tweets",
  "twitter thread", "twitter notifications", "twitter likes", "twitter profile", "twitter tweets", "twitter article",
  "reddit frontpage", "reddit home", "reddit popular", "reddit subreddit", "reddit search", "reddit saved",
  "reddit upvoted", "reddit subscribed", "reddit read", "reddit user", "reddit user-posts",
  "reddit user-comments", "reddit subreddit-info",
  "youtube search", "youtube video", "youtube transcript", "youtube comments", "youtube channel",
  "youtube playlist", "youtube feed", "youtube history", "youtube watch-later", "youtube subscriptions",
  "linkedin timeline", "linkedin search", "linkedin people-search", "linkedin profile-read", "linkedin posts", "linkedin job-detail",
  "instagram explore", "instagram search", "instagram user", "instagram profile",
  "facebook feed", "facebook search", "facebook groups", "facebook profile",
  "tiktok explore", "tiktok search", "tiktok user", "tiktok profile",
]);
const TWITTER_CLI_READ_COMMANDS = new Set(["search", "feed", "bookmarks", "list", "tweet", "likes", "user", "user-posts", "article"]);
const RDT_CLI_READ_COMMANDS = new Set(["feed", "all", "popular", "sub", "search", "saved", "upvoted", "read", "user", "user-posts", "user-comments"]);

function testOutboxCrash(point) {
  if (TEST_OUTBOX_CRASH_POINT === point) process.exit(86);
}

function testTokenCrash(point) {
  if (TEST_TOKEN_CRASH_POINT === point) process.exit(86);
  if (TEST_TOKEN_FAILURE_POINT === point) throw new Error("Injected private credential commit failure");
}

function testServiceLockCrash(point) {
  if (TEST_SERVICE_LOCK_CRASH_POINT === point) process.exit(87);
}

function parseArgs(argv) {
  const command = argv[0] || "help";
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] || "";
    if (token === "-h") {
      values.help = true;
      continue;
    }
    if (token === "-v") {
      values.version = true;
      continue;
    }
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      index += 1;
    } else {
      values[key] = true;
    }
  }
  return { command, values };
}

function boundedNumber(value, fallback, minimum = 1, maximum = MAX_ITEMS) {
  const parsed = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
}

function optionalFlag(args, flag, value) {
  if (value !== undefined && value !== null && String(value).trim() !== "") args.push(flag, String(value));
  return args;
}

function booleanFlag(args, flag, value) {
  if (value === undefined || value === null || value === false || value === "") return args;
  if (value === true) {
    args.push(flag);
    return args;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    args.push(flag);
    return args;
  }
  if (["false", "0", "no", "off"].includes(normalized)) return args;
  throw new Error(`${flag} must be true or false`);
}

function required(value, operation, label) {
  const output = String(value ?? "").trim();
  if (!output) throw new Error(`${operation} requires ${label}`);
  return output;
}

function parseObject(value, label = "JSON object") {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  if (value === undefined || value === null || value === "") return {};
  throw new Error(`${label} must be an object`);
}

async function commandExists(command) {
  try {
    await execFileAsync(PLATFORM === "win32" ? "where.exe" : "which", [command], {
      timeout: 10_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, timeout = 90_000, extraEnv = {}) {
  return execFileAsync(command, args, {
    timeout,
    maxBuffer: 24 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", OUTPUT: "json", ...extraEnv },
  });
}

async function spawnWithInput(command, args, input, options = {}) {
  const timeout = Math.max(1_000, Math.min(120_000, Number(options.timeout || 30_000)));
  const maxOutputBytes = Math.max(1_024, Math.min(8 * 1024 * 1024, Number(options.maxOutputBytes || MAX_CAPTURED_COMMAND_BYTES)));
  const extraEnv = options.extraEnv && typeof options.extraEnv === "object" ? options.extraEnv : {};
  const sensitiveInput = options.sensitiveInput === true;
  const classifyFailure = typeof options.classifyFailure === "function" ? options.classifyFailure : null;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let oversized = false;
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const capture = (stream, chunk) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > maxOutputBytes) {
        oversized = true;
        child.kill("SIGKILL");
        return stream;
      }
      return stream + chunk;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = capture(stderr, chunk); });
    child.on("error", (error) => settle(error));
    child.on("close", (code) => {
      if (timedOut) settle(new Error(`${command} timed out`));
      else if (oversized) settle(new Error(`${command} produced too much output`));
      else if (code === 0) settle(null, { stdout, stderr });
      else {
        const error = new Error(`${command} exited ${code}${sensitiveInput ? "" : `: ${stderr.trim()}`}`);
        error.command = command;
        error.exitCode = code;
        error.failureKind = classifyFailure ? classifyFailure({ command, exitCode: code, stdout, stderr }) : null;
        settle(error);
      }
    });
    child.stdin.on("error", (error) => {
      if (error && typeof error === "object" && error.code === "EPIPE") return;
      settle(error);
    });
    child.stdin.end(input);
  });
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    throw new Error("Relay is not paired. Generate a pairing code in Driftglass and run `driftglass-relay pair ...`.");
  }
}

async function syncDirectory(path) {
  if (PLATFORM === "win32") return;
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(String(error?.code || ""))) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writePrivateFile(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (PLATFORM !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeConfig(config) {
  await writePrivateFile(CONFIG_PATH, serializeConfig(config));
}

function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function assertResultOutboxPath() {
  const root = resolve(STATE_DIR);
  const target = resolve(RESULT_OUTBOX_PATH);
  const bounded = relative(root, target);
  if (bounded !== "result-outbox.json" || isAbsolute(bounded) || bounded.startsWith(`..${sep}`)) {
    throw new Error("Pending result outbox path escaped the private state directory");
  }
}

function assertCollectorJobId(value) {
  const jobId = String(value || "").trim();
  if (!RESULT_JOB_ID_PATTERN.test(jobId)) {
    throw new Error("Cloud returned an invalid Collector job ID");
  }
  return jobId;
}

function resultOutboxDestinationSha256(config) {
  const baseUrl = String(config?.baseUrl || "").replace(/\/+$/, "");
  const collectorId = String(config?.collectorId || "").trim();
  if (!baseUrl || !collectorId || collectorId.length > 200) {
    throw new Error("Paired destination is incomplete for pending result replay");
  }
  collectorEndpoint(baseUrl, "/collector/jobs");
  return createHash("sha256").update(`${baseUrl}\n${collectorId}`, "utf8").digest("hex");
}

function assertSuccessfulResultPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pending result payload must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "ok" || keys[1] !== "result" || value.ok !== true) {
    throw new Error("Pending result payload must contain exactly one successful result");
  }
  const result = value.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Pending result payload is missing its result object");
  }
  if (typeof result.provider !== "string" || !result.provider.trim() || result.provider.length > 200) {
    throw new Error("Pending result payload has an invalid provider");
  }
  if (!Array.isArray(result.items) || result.items.length > MAX_ITEMS) {
    throw new Error(`Pending result payload exceeds the ${MAX_ITEMS}-item limit`);
  }
  if (result.items.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("Pending result payload contains an invalid item");
  }
  if (
    result.diagnostics !== undefined
    && (!result.diagnostics || typeof result.diagnostics !== "object" || Array.isArray(result.diagnostics))
  ) {
    throw new Error("Pending result payload has invalid diagnostics");
  }
}

function validCanonicalBase64(value) {
  return typeof value === "string"
    && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function decodeResultOutboxRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pending result outbox must contain one JSON object");
  }
  const expectedKeys = [
    "createdAt", "destinationSha256", "jobId", "payloadBase64", "payloadBytes", "payloadEncoding", "payloadSha256", "schemaVersion",
  ];
  const keys = Object.keys(value).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Pending result outbox schema is invalid");
  }
  if (value.schemaVersion !== 1 || value.payloadEncoding !== "base64") {
    throw new Error("Pending result outbox version or encoding is unsupported");
  }
  const jobId = assertCollectorJobId(value.jobId);
  if (typeof value.destinationSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.destinationSha256)) {
    throw new Error("Pending result outbox destination binding is invalid");
  }
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("Pending result outbox has an invalid creation time");
  }
  if (!Number.isSafeInteger(value.payloadBytes) || value.payloadBytes <= 0 || value.payloadBytes > MAX_RESULT_PAYLOAD_BYTES) {
    throw new Error("Pending result outbox payload size is invalid");
  }
  if (typeof value.payloadSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.payloadSha256)) {
    throw new Error("Pending result outbox payload hash is invalid");
  }
  if (!validCanonicalBase64(value.payloadBase64)) {
    throw new Error("Pending result outbox payload encoding is invalid");
  }
  const payloadBuffer = Buffer.from(value.payloadBase64, "base64");
  if (payloadBuffer.length !== value.payloadBytes || payloadBuffer.toString("base64") !== value.payloadBase64) {
    throw new Error("Pending result outbox payload length is invalid");
  }
  if (createHash("sha256").update(payloadBuffer).digest("hex") !== value.payloadSha256) {
    throw new Error("Pending result outbox payload integrity check failed");
  }
  const payloadJson = payloadBuffer.toString("utf8");
  if (!Buffer.from(payloadJson, "utf8").equals(payloadBuffer)) {
    throw new Error("Pending result outbox payload is not valid UTF-8");
  }
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new Error("Pending result outbox payload is not valid JSON");
  }
  assertSuccessfulResultPayload(payload);
  return {
    record: value,
    jobId,
    destinationSha256: value.destinationSha256,
    payloadJson,
    payloadBytes: value.payloadBytes,
    payloadSha256: value.payloadSha256,
    createdAt: value.createdAt,
  };
}

async function resultOutboxFileInfo() {
  assertResultOutboxPath();
  let directory;
  try {
    directory = await lstat(STATE_DIR);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error("Pending result state directory must be a real directory, not a symbolic link");
  }
  let info;
  try {
    info = await lstat(RESULT_OUTBOX_PATH);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
  assertPrivateOutboxFileInfo(info, "Pending result outbox");
  return info;
}

function assertPrivateOutboxFileInfo(info, label) {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${label} must be a regular file, not a symbolic link`);
  }
  if (info.size <= 0 || info.size > MAX_RESULT_OUTBOX_BYTES) {
    throw new Error(`${label} file is empty or oversized`);
  }
  if (PLATFORM !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must be mode 0600`);
  }
}

async function readResultOutboxFile(path, info) {
  const bytes = await readFile(path);
  if (bytes.length !== info.size || bytes.length > MAX_RESULT_OUTBOX_BYTES) {
    throw new Error("Pending result outbox changed while it was being read");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Pending result outbox is not valid JSON");
  }
  return decodeResultOutboxRecord(parsed);
}

async function syncResultStateDirectory() {
  if (PLATFORM === "win32") return;
  let handle;
  try {
    handle = await open(STATE_DIR, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(String(error?.code || ""))) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

async function resultOutboxTempFiles() {
  let names;
  try {
    names = await readdir(STATE_DIR);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const name of names) {
    const match = name.match(RESULT_OUTBOX_TEMP_PATTERN);
    if (!match) continue;
    const path = join(STATE_DIR, name);
    const bounded = relative(resolve(STATE_DIR), resolve(path));
    if (bounded !== name || isAbsolute(bounded) || bounded.startsWith(`..${sep}`)) {
      throw new Error("Pending result temporary path escaped the private state directory");
    }
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Pending result temporary file must be a regular file, not a symbolic link");
    }
    if (PLATFORM !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error("Pending result temporary file permissions must be mode 0600");
    }
    files.push({ path, info, active: processIsRunning(Number(match[1])) });
  }
  return files;
}

function samePendingResult(left, right) {
  return left.jobId === right.jobId
    && left.destinationSha256 === right.destinationSha256
    && left.payloadBytes === right.payloadBytes
    && left.payloadSha256 === right.payloadSha256;
}

async function removeResultOutboxTemps(files) {
  if (!files.length) return;
  for (const file of files) {
    await unlink(file.path).catch((error) => {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    });
  }
  await syncResultStateDirectory();
}

async function recoverResultOutbox() {
  const fixedInfo = await resultOutboxFileInfo();
  const temporaryFiles = await resultOutboxTempFiles();
  if (fixedInfo) {
    const fixed = await readResultOutboxFile(RESULT_OUTBOX_PATH, fixedInfo);
    for (const temporary of temporaryFiles) {
      let candidate = null;
      try {
        assertPrivateOutboxFileInfo(temporary.info, "Pending result temporary");
        candidate = await readResultOutboxFile(temporary.path, temporary.info);
      } catch (error) {
        if (temporary.active) throw error;
      }
      if (temporary.active && candidate && !samePendingResult(fixed, candidate)) {
        throw new Error("A concurrent pending result write conflicts with the durable outbox");
      }
    }
    await removeResultOutboxTemps(temporaryFiles);
    return fixed;
  }
  if (!temporaryFiles.length) return null;
  if (temporaryFiles.some((file) => file.active)) {
    throw new Error("A pending result outbox write is still in progress");
  }

  const valid = [];
  const invalid = [];
  for (const temporary of temporaryFiles) {
    try {
      assertPrivateOutboxFileInfo(temporary.info, "Pending result temporary");
      valid.push({ ...temporary, pending: await readResultOutboxFile(temporary.path, temporary.info) });
    } catch {
      invalid.push(temporary);
    }
  }
  await removeResultOutboxTemps(invalid);
  if (!valid.length) return null;
  if (valid.some((candidate) => !samePendingResult(candidate.pending, valid[0].pending))) {
    throw new Error("Multiple conflicting pending result records require owner recovery");
  }

  try {
    await link(valid[0].path, RESULT_OUTBOX_PATH);
    if (PLATFORM !== "win32") await chmod(RESULT_OUTBOX_PATH, 0o600);
    await syncResultStateDirectory();
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
  }
  await removeResultOutboxTemps(valid);
  const recoveredInfo = await resultOutboxFileInfo();
  if (!recoveredInfo) throw new Error("Pending result recovery did not create the durable outbox slot");
  return readResultOutboxFile(RESULT_OUTBOX_PATH, recoveredInfo);
}

async function readResultOutbox() {
  return recoverResultOutbox();
}

async function inspectResultOutbox(config) {
  try {
    const pending = await readResultOutbox();
    if (!pending) return { status: "empty", pending: false, valid: true, bytes: 0 };
    if (config && pending.destinationSha256 !== resultOutboxDestinationSha256(config)) {
      throw new Error("Pending result outbox belongs to a different paired destination");
    }
    return {
      status: "pending",
      pending: true,
      valid: true,
      bytes: pending.payloadBytes,
      createdAt: pending.createdAt,
    };
  } catch (error) {
    return {
      status: "invalid",
      pending: true,
      valid: false,
      error: redactDiagnostic(error instanceof Error ? error.message : error),
    };
  }
}

async function persistResultOutbox(config, jobIdValue, payloadJson) {
  const jobId = assertCollectorJobId(jobIdValue);
  const destinationSha256 = resultOutboxDestinationSha256(config);
  const payloadBuffer = Buffer.from(payloadJson, "utf8");
  if (payloadBuffer.length <= 0 || payloadBuffer.length > MAX_RESULT_PAYLOAD_BYTES) {
    throw new Error(`Successful Collector result exceeds the ${MAX_RESULT_PAYLOAD_BYTES}-byte private outbox limit`);
  }
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new Error("Successful Collector result could not be encoded for the private outbox");
  }
  assertSuccessfulResultPayload(payload);
  if (await readResultOutbox()) {
    throw new Error("A pending Collector result already exists and must be replayed before polling another job");
  }

  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const directory = await lstat(STATE_DIR);
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error("Pending result state directory must be a real directory, not a symbolic link");
  }
  if (PLATFORM !== "win32") await chmod(STATE_DIR, 0o700);

  const payloadSha256 = createHash("sha256").update(payloadBuffer).digest("hex");
  const record = {
    schemaVersion: 1,
    jobId,
    destinationSha256,
    createdAt: new Date().toISOString(),
    payloadEncoding: "base64",
    payloadBytes: payloadBuffer.length,
    payloadSha256,
    payloadBase64: payloadBuffer.toString("base64"),
  };
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESULT_OUTBOX_BYTES) {
    throw new Error("Successful Collector result exceeds the bounded private outbox envelope");
  }

  const temporary = join(STATE_DIR, `.result-outbox.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let linked = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    if (PLATFORM !== "win32") await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  testOutboxCrash("after-temp-fsync");
  try {
    // Linking a fully flushed file into the fixed slot makes the record appear
    // atomically and refuses to overwrite a concurrent pending result.
    await link(temporary, RESULT_OUTBOX_PATH);
    linked = true;
    testOutboxCrash("after-link");
    if (PLATFORM !== "win32") await chmod(RESULT_OUTBOX_PATH, 0o600);
    await syncResultStateDirectory();
    testOutboxCrash("after-directory-fsync");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error("A pending Collector result already exists and must be replayed before polling another job");
    }
    throw error;
  } finally {
    try {
      await unlink(temporary);
      testOutboxCrash("after-temp-unlink");
      await syncResultStateDirectory();
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
  }
  if (!linked) throw new Error("Pending result outbox was not linked into its durable slot");
  return decodeResultOutboxRecord(record);
}

async function clearAcknowledgedResultOutbox(pending) {
  const current = await readResultOutbox();
  if (!current) return;
  if (
    current.jobId !== pending.jobId
    || current.destinationSha256 !== pending.destinationSha256
    || current.payloadBytes !== pending.payloadBytes
    || current.payloadSha256 !== pending.payloadSha256
  ) {
    throw new Error("Pending result outbox changed before acknowledged cleanup");
  }
  await unlink(RESULT_OUTBOX_PATH);
  await syncResultStateDirectory();
}

async function submitPendingResult(config, token, pending) {
  if (pending.destinationSha256 !== resultOutboxDestinationSha256(config)) {
    throw new Error("Pending result outbox belongs to a different paired destination");
  }
  let response;
  let body;
  try {
    ({ response, body } = await fetchBoundedJson(collectorEndpoint(config.baseUrl, `/collector/jobs/${encodeURIComponent(pending.jobId)}/result`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": `Driftglass-Companion/${VERSION}`,
      },
      body: pending.payloadJson,
    }, { maxBytes: MAX_JSON_RESPONSE_BYTES }));
  } catch (error) {
    throw new Error(`Pending result submission had no unambiguous acknowledgement: ${redactDiagnostic(error)}`);
  }
  if (
    !response.ok
    || body?.ok !== true
    || !Number.isSafeInteger(body.accepted)
    || body.accepted < 0
  ) {
    throw new Error(`Pending result submission was not acknowledged (HTTP ${response.status})`);
  }
  await clearAcknowledgedResultOutbox(pending);
  return body;
}

async function replayPendingResult(config, token) {
  const pending = await readResultOutbox();
  if (!pending) return false;
  await submitPendingResult(config, token, pending);
  console.log(`${new Date().toISOString()} replayed and acknowledged one pending Collector result`);
  return true;
}

function tokenFile(account) {
  return join(TOKEN_DIR, `${String(account).replace(/[^a-zA-Z0-9._-]/g, "_")}.secret`);
}

function privateTokenPath(store) {
  const account = String(store?.account || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(account)) throw new Error("Private credential account is invalid");
  const expected = resolve(tokenFile(account));
  const supplied = store?.file ? resolve(String(store.file)) : expected;
  const bounded = relative(resolve(TOKEN_DIR), supplied);
  if (supplied !== expected || isAbsolute(bounded) || bounded.startsWith(`..${sep}`) || bounded.includes(sep)) {
    throw new Error("Private credential path escaped the Companion token directory");
  }
  return supplied;
}

async function privateDirectory(path, label, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (!create && error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`${label} is missing`);
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
  if (PLATFORM !== "win32" && (info.mode & 0o077) !== 0) throw new Error(`${label} permissions must be mode 0700`);
  return info;
}

function assertServiceOperationLockFile(info, allowEmpty = false, expectedLinks = 1) {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== expectedLinks) throw new Error("Companion service-operation lock must be one regular file");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Companion service-operation lock must be owned by the current user");
  if (PLATFORM !== "win32" && (info.mode & 0o777) !== 0o600) throw new Error("Companion service-operation lock permissions must be mode 0600");
  if ((!allowEmpty && info.size <= 0) || info.size > MAX_SERVICE_OPERATION_LOCK_BYTES) throw new Error("Companion service-operation lock size is invalid");
}

async function recoverServiceOperationLockTemps() {
  const files = [];
  for (const name of await readdir(STATE_DIR)) {
    if (!name.startsWith(".service-operation.")) continue;
    const match = name.match(SERVICE_OPERATION_LOCK_TEMP_PATTERN);
    if (!match) throw new Error("Companion state contains an unsafe service-operation temporary path");
    const path = join(STATE_DIR, name);
    const info = await lstat(path);
    if (![1, 2].includes(info.nlink)) throw new Error("Companion service-operation temporary file has an invalid link count");
    assertServiceOperationLockFile(info, true, info.nlink);
    const pid = Number(match[1]);
    let linked = false;
    if (info.nlink === 2) {
      const fixed = await lstat(SERVICE_OPERATION_LOCK_PATH);
      assertServiceOperationLockFile(fixed, true, 2);
      if (!sameFileIdentity(info, fixed)) throw new Error("Companion service-operation temporary link does not match the lock");
      linked = true;
    }
    files.push({ path, info, pid, linked });
  }
  if (files.some((file) => processIsRunning(file.pid))) throw new Error("Another Companion service operation is in progress");
  for (const file of files) {
    const current = await lstat(file.path);
    assertServiceOperationLockFile(current, true, file.linked ? 2 : 1);
    if (!sameFileIdentity(current, file.info) || processIsRunning(file.pid)) throw new Error("Companion service-operation temporary file changed during recovery");
    if (file.linked) {
      const fixed = await lstat(SERVICE_OPERATION_LOCK_PATH);
      if (!sameFileIdentity(fixed, current)) throw new Error("Companion service-operation lock changed during recovery");
    }
    await unlink(file.path);
  }
  if (files.length) await syncDirectory(STATE_DIR);
}

async function readServiceOperationLock() {
  const info = await lstat(SERVICE_OPERATION_LOCK_PATH);
  assertServiceOperationLockFile(info);
  let handle;
  try {
    handle = await open(SERVICE_OPERATION_LOCK_PATH, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    assertServiceOperationLockFile(opened);
    if (!sameFileIdentity(info, opened)) throw new Error("Companion service-operation lock changed while it was opened");
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size || bytes.length > MAX_SERVICE_OPERATION_LOCK_BYTES) throw new Error("Companion service-operation lock changed while it was read");
    let record;
    try {
      record = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Companion service-operation lock is invalid");
    }
    if (
      !record
      || typeof record !== "object"
      || Array.isArray(record)
      || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["nonce", "pid"])
      || !Number.isSafeInteger(record.pid)
      || record.pid <= 0
      || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(record.nonce || ""))
    ) {
      throw new Error("Companion service-operation lock is invalid");
    }
    return { pid: record.pid, nonce: String(record.nonce), info: opened };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function acquireServiceOperationLock() {
  await privateDirectory(STATE_DIR, "Companion state directory", true);
  await recoverServiceOperationLockTemps();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nonce = randomUUID();
    const temporary = join(STATE_DIR, `.service-operation.${process.pid}.${nonce}.tmp`);
    let handle;
    let createdInfo;
    let linked = false;
    try {
      handle = await open(temporary, "wx", 0o600);
      createdInfo = await handle.stat();
      testServiceLockCrash("after-temp-open");
      const serialized = JSON.stringify({ pid: process.pid, nonce }) + String.fromCharCode(10);
      await handle.writeFile(serialized, "utf8");
      if (PLATFORM !== "win32") await handle.chmod(0o600);
      await handle.sync();
      const completed = await handle.stat();
      assertServiceOperationLockFile(completed);
      if (!sameFileIdentity(completed, createdInfo)) throw new Error("Companion service-operation lock changed while it was written");
      await handle.close();
      handle = undefined;
      testServiceLockCrash("after-temp-fsync");
      await link(temporary, SERVICE_OPERATION_LOCK_PATH);
      linked = true;
      testServiceLockCrash("after-link");
      await syncDirectory(STATE_DIR);
      await unlink(temporary);
      await syncDirectory(STATE_DIR);
      const fixed = await lstat(SERVICE_OPERATION_LOCK_PATH);
      assertServiceOperationLockFile(fixed);
      if (!sameFileIdentity(fixed, completed)) throw new Error("Companion service-operation lock changed before acquisition");
      return { pid: process.pid, nonce, info: fixed };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (linked && createdInfo) {
        const fixed = await lstat(SERVICE_OPERATION_LOCK_PATH).catch(() => null);
        if (fixed && sameFileIdentity(fixed, createdInfo)) await unlink(SERVICE_OPERATION_LOCK_PATH);
      }
      if (!(error && typeof error === "object" && error.code === "EEXIST")) {
        throw error;
      }
      const existing = await readServiceOperationLock();
      if (processIsRunning(existing.pid)) throw new Error("Another Companion service operation is in progress");
      const current = await lstat(SERVICE_OPERATION_LOCK_PATH);
      if (!sameFileIdentity(current, existing.info)) throw new Error("Companion service-operation lock changed during stale recovery");
      await unlink(SERVICE_OPERATION_LOCK_PATH);
      await syncDirectory(STATE_DIR);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  throw new Error("Companion service-operation lock could not be acquired");
}

async function releaseServiceOperationLock(lock) {
  const current = await readServiceOperationLock();
  if (
    current.pid !== lock.pid
    || current.nonce !== lock.nonce
    || !sameFileIdentity(current.info, lock.info)
  ) throw new Error("Companion service-operation lock changed before release");
  await unlink(SERVICE_OPERATION_LOCK_PATH);
  await syncDirectory(STATE_DIR);
}

async function withServiceOperationLock(operation) {
  const lock = await acquireServiceOperationLock();
  try {
    return await operation();
  } finally {
    await releaseServiceOperationLock(lock);
  }
}

function assertPrivateTokenFile(info) {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error("Private credential must be one regular file, not a link");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("Private credential must be owned by the current user");
  }
  if (PLATFORM !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error("Private credential permissions must be mode 0600");
  }
  if (info.size <= 0 || info.size > 1_024) throw new Error("Private credential size is invalid");
}

function assertPrivateTokenTempFile(info, expectedLinks = 1) {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== expectedLinks) {
    throw new Error("Private credential temporary path must be one regular file, not a link");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("Private credential temporary file must be owned by the current user");
  }
  if (PLATFORM !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error("Private credential temporary permissions must be mode 0600");
  }
  if (info.size < 0 || info.size > 1_024) throw new Error("Private credential temporary size is invalid");
}

async function syncPrivateTokenDirectory() {
  if (PLATFORM === "win32") return;
  let handle;
  try {
    handle = await open(TOKEN_DIR, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(String(error?.code || ""))) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function privateTokenDirectoriesAvailable(create = false) {
  if (create) {
    await privateDirectory(STATE_DIR, "Companion state directory", true);
    await privateDirectory(TOKEN_DIR, "Companion token directory", true);
    return true;
  }
  try {
    await lstat(STATE_DIR);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
  await privateDirectory(STATE_DIR, "Companion state directory");
  try {
    await lstat(TOKEN_DIR);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
  await privateDirectory(TOKEN_DIR, "Companion token directory");
  return true;
}

async function privateTokenTempFiles(create = false) {
  if (!await privateTokenDirectoriesAvailable(create)) return [];
  const names = await readdir(TOKEN_DIR);
  if (names.length > MAX_PRIVATE_TOKEN_DIRECTORY_ENTRIES) {
    throw new Error(`Companion token directory contains more than ${MAX_PRIVATE_TOKEN_DIRECTORY_ENTRIES} entries`);
  }
  const files = [];
  for (const name of names) {
    if (!name.startsWith(".") && !name.endsWith(".tmp")) continue;
    const match = name.match(PRIVATE_TOKEN_TEMP_PATTERN);
    if (!match) throw new Error("Companion token directory contains an unsafe temporary path");
    const path = join(TOKEN_DIR, name);
    const bounded = relative(resolve(TOKEN_DIR), resolve(path));
    if (bounded !== name || isAbsolute(bounded) || bounded.startsWith(`..${sep}`) || bounded.includes(sep)) {
      throw new Error("Private credential temporary path escaped the Companion token directory");
    }
    const info = await lstat(path);
    if (![1, 2].includes(info.nlink)) throw new Error("Private credential temporary file has an invalid link count");
    assertPrivateTokenTempFile(info, info.nlink);
    const pid = Number(match[2]);
    let linkedFinal = null;
    if (info.nlink === 2) {
      linkedFinal = join(TOKEN_DIR, `${match[1]}.secret`);
      const finalInfo = await lstat(linkedFinal);
      assertPrivateTokenTempFile(finalInfo, 2);
      if (!sameFileIdentity(info, finalInfo)) throw new Error("Private credential temporary link does not match its final file");
    }
    files.push({ path, pid, active: processIsRunning(pid), info, linkedFinal });
  }
  return files;
}

async function recoverPrivateTokenTemps(create = false, expectedLinkedFile = null) {
  const files = await privateTokenTempFiles(create);
  if (files.some((file) => file.active)) throw new Error("A private credential write is still in progress");
  if (files.some((file) => file.linkedFinal && resolve(file.linkedFinal) !== resolve(String(expectedLinkedFile || "")))) {
    throw new Error("A linked private credential commit requires exact pairing-journal recovery");
  }
  for (const file of files) {
    let current;
    try {
      current = await lstat(file.path);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    assertPrivateTokenTempFile(current, file.linkedFinal ? 2 : 1);
    if (!sameFileIdentity(current, file.info) || processIsRunning(file.pid)) {
      throw new Error("Private credential temporary file changed during recovery");
    }
    if (file.linkedFinal) {
      const finalInfo = await lstat(file.linkedFinal);
      assertPrivateTokenTempFile(finalInfo, 2);
      if (!sameFileIdentity(finalInfo, current)) throw new Error("Private credential final link changed during recovery");
    }
    await unlink(file.path);
  }
  if (files.length) await syncPrivateTokenDirectory();
  return files.length;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function recordedFileIdentity(info) {
  return { dev: String(info.dev), ino: String(info.ino) };
}

function validateRecordedFileIdentity(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pairing journal credential identity is invalid");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["dev", "ino"])) throw new Error("Pairing journal credential identity fields are invalid");
  const dev = String(value.dev || "");
  const ino = String(value.ino || "");
  if (!/^\d{1,30}$/.test(dev) || !/^\d{1,30}$/.test(ino)) throw new Error("Pairing journal credential identity is invalid");
  return { dev, ino };
}

function matchesRecordedFileIdentity(info, recorded) {
  return recorded !== null && String(info.dev) === recorded.dev && String(info.ino) === recorded.ino;
}

async function removeCommittedPrivateToken(file, committedInfo, allowIncomplete = false, expectedLinks = 1) {
  const info = await lstat(file);
  if (allowIncomplete) {
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== expectedLinks) throw new Error("Private credential cleanup refused a linked file");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Private credential cleanup refused a foreign-owned file");
    if (PLATFORM !== "win32" && (info.mode & 0o077) !== 0) throw new Error("Private credential cleanup refused an exposed file");
    if (info.size < 0 || info.size > 1_024) throw new Error("Private credential cleanup refused an invalid file");
  } else {
    assertPrivateTokenFile(info);
  }
  if (!sameFileIdentity(info, committedInfo)) {
    throw new Error("Private credential cleanup refused a replaced file");
  }
  await unlink(file);
  await syncPrivateTokenDirectory();
  try {
    await lstat(file);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Private credential cleanup could not be verified");
}

async function savePrivateToken(account, token, onPrepared = async () => undefined) {
  const file = privateTokenPath({ account });
  await recoverPrivateTokenTemps(true);
  const existing = await lstat(file).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    assertPrivateTokenFile(existing);
    throw new Error("Private credential already exists; unpair before pairing this Companion again");
  }
  const temporary = join(TOKEN_DIR, `.${account.replace(/[^a-zA-Z0-9._-]/g, "_")}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let committedInfo;
  let linked = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${token}\n`, "utf8");
    if (PLATFORM !== "win32") await handle.chmod(0o600);
    await handle.sync();
    committedInfo = await handle.stat();
    assertPrivateTokenFile(committedInfo);
    await handle.close();
    handle = undefined;
    await onPrepared(recordedFileIdentity(committedInfo));
    testTokenCrash("after-temp-fsync");
    try {
      await link(temporary, file);
      linked = true;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        throw new Error("Private credential already exists; unpair before pairing this Companion again");
      }
      throw error;
    }
    testTokenCrash("after-rename");
    const linkedInfo = await lstat(file);
    assertPrivateTokenTempFile(linkedInfo, 2);
    if (!sameFileIdentity(linkedInfo, committedInfo)) throw new Error("Private credential changed before commit");
    await syncPrivateTokenDirectory();
    await unlink(temporary);
    const finalInfo = await lstat(file);
    assertPrivateTokenFile(finalInfo);
    if (!sameFileIdentity(finalInfo, committedInfo)) throw new Error("Private credential changed before commit");
    await syncPrivateTokenDirectory();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (linked && committedInfo) {
      try {
        await removeCommittedPrivateToken(file, committedInfo, true, 2);
      } catch {
        throw new Error("Private credential commit failed and exact cleanup could not be verified");
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return { kind: "private-file", account, file };
}

async function readPrivateToken(store) {
  const file = privateTokenPath(store);
  await recoverPrivateTokenTemps();
  assertPrivateTokenFile(await lstat(file));
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    assertPrivateTokenFile(info);
    const bytes = await handle.readFile();
    if (bytes.length !== info.size || bytes.length > 1_024) throw new Error("Private credential changed while it was read");
    return bytes.toString("utf8").trim();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function deletePrivateToken(store, options = {}) {
  const file = privateTokenPath(store);
  await recoverPrivateTokenTemps(false, options.pairingJournal === true ? file : null);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  assertPrivateTokenFile(info);
  await unlink(file);
  await syncPrivateTokenDirectory();
}

function canonicalTokenStore(store, expectedAccount) {
  if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error("Pairing credential store is invalid");
  const account = String(store.account || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(account) || (expectedAccount && account !== expectedAccount)) {
    throw new Error("Pairing credential account is invalid");
  }
  if (store.kind === "macos-keychain" || store.kind === "secret-service") return { kind: store.kind, account };
  if (store.kind === "private-file") return { kind: store.kind, account, file: privateTokenPath(store) };
  if (store.kind === "windows-dpapi") {
    const expected = resolve(tokenFile(account));
    const supplied = resolve(String(store.file || expected));
    if (supplied !== expected) throw new Error("Windows credential path escaped the Companion token directory");
    return { kind: store.kind, account, file: supplied };
  }
  throw new Error("Pairing credential store is unsupported");
}

function assertPairingJournalFile(info, allowEmpty = false) {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error("Pairing journal must be one regular file, not a link");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("Pairing journal must be owned by the current user");
  }
  if (PLATFORM !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error("Pairing journal permissions must be mode 0600");
  }
  if ((!allowEmpty && info.size <= 0) || info.size > MAX_PAIRING_JOURNAL_BYTES) {
    throw new Error("Pairing journal size is invalid");
  }
}

async function pairingJournalTempFiles() {
  let stateInfo;
  try {
    stateInfo = await lstat(STATE_DIR);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) throw new Error("Companion state directory must be a real directory");
  await privateDirectory(STATE_DIR, "Companion state directory");
  const files = [];
  for (const name of await readdir(STATE_DIR)) {
    if (!name.startsWith(".pairing-journal.") && !name.endsWith(".tmp")) continue;
    if (!name.startsWith(".pairing-journal.")) continue;
    const match = name.match(PAIRING_JOURNAL_TEMP_PATTERN);
    if (!match) throw new Error("Companion state contains an unsafe pairing-journal temporary path");
    const path = join(STATE_DIR, name);
    const bounded = relative(resolve(STATE_DIR), resolve(path));
    if (bounded !== name || isAbsolute(bounded) || bounded.startsWith(`..${sep}`) || bounded.includes(sep)) {
      throw new Error("Pairing-journal temporary path escaped the Companion state directory");
    }
    const info = await lstat(path);
    assertPairingJournalFile(info, true);
    const pid = Number(match[1]);
    files.push({ path, info, pid, active: processIsRunning(pid) });
  }
  return files;
}

async function recoverPairingJournalTemps() {
  const files = await pairingJournalTempFiles();
  if (files.some((file) => file.active)) throw new Error("A pairing-journal write is still in progress");
  for (const file of files) {
    let current;
    try {
      current = await lstat(file.path);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    assertPairingJournalFile(current, true);
    if (!sameFileIdentity(current, file.info) || processIsRunning(file.pid)) {
      throw new Error("Pairing-journal temporary file changed during recovery");
    }
    await unlink(file.path);
  }
  if (files.length) await syncDirectory(STATE_DIR);
}

function validatePairingJournal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pairing journal is invalid");
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["account", "configSha256", "credentialIdentity", "pid", "schemaVersion", "tokenStore", "transactionId"])) {
    throw new Error("Pairing journal fields are invalid");
  }
  if (value.schemaVersion !== "1" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(value.transactionId || ""))) {
    throw new Error("Pairing journal identity is invalid");
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error("Pairing journal process is invalid");
  const account = String(value.account || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(account)) throw new Error("Pairing journal account is invalid");
  if (!/^[0-9a-f]{64}$/.test(String(value.configSha256 || ""))) throw new Error("Pairing journal config digest is invalid");
  const tokenStore = canonicalTokenStore(value.tokenStore, account);
  const credentialIdentity = validateRecordedFileIdentity(value.credentialIdentity);
  if (tokenStore.kind !== "private-file" && credentialIdentity !== null) {
    throw new Error("Pairing journal credential identity is unsupported for this store");
  }
  return {
    schemaVersion: "1",
    transactionId: String(value.transactionId),
    pid: value.pid,
    account,
    tokenStore,
    credentialIdentity,
    configSha256: String(value.configSha256),
  };
}

async function readPairingJournal() {
  await recoverPairingJournalTemps();
  let info;
  try {
    info = await lstat(PAIRING_JOURNAL_PATH);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
  assertPairingJournalFile(info);
  let handle;
  try {
    handle = await open(PAIRING_JOURNAL_PATH, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    assertPairingJournalFile(opened);
    if (!sameFileIdentity(info, opened)) throw new Error("Pairing journal changed while it was opened");
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size || bytes.length > MAX_PAIRING_JOURNAL_BYTES) throw new Error("Pairing journal changed while it was read");
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Pairing journal is not valid JSON");
    }
    return { ...validatePairingJournal(parsed), info: opened };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writePairingJournal(journal) {
  const validated = validatePairingJournal(journal);
  await privateDirectory(STATE_DIR, "Companion state directory", true);
  await recoverPairingJournalTemps();
  const existing = await readPairingJournal();
  if (existing && existing.transactionId !== validated.transactionId) {
    throw new Error("Another pairing transaction must be recovered before pairing again");
  }
  const temporary = join(STATE_DIR, `.pairing-journal.${process.pid}.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAIRING_JOURNAL_BYTES) throw new Error("Pairing journal is too large");
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (PLATFORM !== "win32") await chmod(temporary, 0o600);
    assertPairingJournalFile(await lstat(temporary));
    await rename(temporary, PAIRING_JOURNAL_PATH);
    assertPairingJournalFile(await lstat(PAIRING_JOURNAL_PATH));
    await syncDirectory(STATE_DIR);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function clearPairingJournal(expected) {
  const current = await readPairingJournal();
  if (!current) return;
  if (current.transactionId !== expected.transactionId || !sameFileIdentity(current.info, (await lstat(PAIRING_JOURNAL_PATH)))) {
    throw new Error("Pairing journal changed before cleanup");
  }
  await unlink(PAIRING_JOURNAL_PATH);
  await syncDirectory(STATE_DIR);
}

async function recoverJournalPrivateCredential(journal) {
  const file = privateTokenPath(journal.tokenStore);
  const temporaryFiles = await privateTokenTempFiles();
  if (temporaryFiles.some((temporary) => temporary.active)) {
    throw new Error("A private credential write is still in progress");
  }
  for (const temporary of temporaryFiles.filter((candidate) => candidate.linkedFinal)) {
    if (
      resolve(temporary.linkedFinal) !== resolve(file)
      || !matchesRecordedFileIdentity(temporary.info, journal.credentialIdentity)
    ) {
      throw new Error("Linked private credential state does not match the pairing journal");
    }
  }
  await recoverPrivateTokenTemps(false, file);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  assertPrivateTokenFile(info);
  if (!matchesRecordedFileIdentity(info, journal.credentialIdentity)) return;
  await unlink(file);
  await syncPrivateTokenDirectory();
}

async function recoverPairingJournal(options = {}) {
  const journal = await readPairingJournal();
  if (!journal) return { recovered: false, committed: false };
  if (journal.pid !== process.pid && processIsRunning(journal.pid)) {
    throw new Error("A pairing transaction is still in progress");
  }
  let configBytes;
  try {
    configBytes = await readFile(CONFIG_PATH);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw new Error("Pairing recovery could not read the Relay configuration");
    }
  }
  if (configBytes) {
    const digest = createHash("sha256").update(configBytes).digest("hex");
    if (digest !== journal.configSha256) {
      throw new Error("Pairing recovery found a different Relay configuration and preserved all credential state");
    }
    let config;
    try {
      config = JSON.parse(configBytes.toString("utf8"));
    } catch {
      throw new Error("Pairing recovery found an invalid committed Relay configuration");
    }
    const configuredStore = canonicalTokenStore(config?.tokenStore, journal.account);
    if (config?.collectorId !== journal.account || JSON.stringify(configuredStore) !== JSON.stringify(journal.tokenStore)) {
      throw new Error("Pairing recovery found mismatched committed state and preserved all credential state");
    }
    await clearPairingJournal(journal);
    return { recovered: true, committed: true };
  }
  if (journal.tokenStore.kind === "private-file") await recoverJournalPrivateCredential(journal);
  else await deleteToken(journal.tokenStore, { pairingJournal: true });
  await clearPairingJournal(journal);
  return { recovered: true, committed: false };
}

function macKeychainUnavailableOutput(exitCode, stderr) {
  if (exitCode !== 36) return false;
  const normalized = String(stderr || "")
    .replace(/password data for new item:\s*/gi, "")
    .replace(/retype password for new item:\s*/gi, "")
    .trim();
  return normalized === "security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.";
}

function macKeychainUnavailable(error) {
  return error instanceof Error
    && error.command === "security"
    && error.exitCode === 36
    && error.failureKind === "macos-keychain-unavailable";
}

function commandExitCode(error) {
  const value = Number(error?.exitCode ?? error?.code);
  return Number.isSafeInteger(value) ? value : null;
}

function macKeychainItemNotFound(error) {
  const output = String(error?.stderr || "").replace(/\r\n?/g, "\n").trim();
  return commandExitCode(error) === 44
    && output === "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";
}

async function saveToken(account, token, beforeStore = async () => undefined, afterPrepared = async () => undefined) {
  if (PLATFORM === "darwin") {
    // `security` warns that a password following -w is visible in the process
    // list. A final value-less -w reads it from the child's private stdin.
    const keychainStore = { kind: "macos-keychain", account };
    await beforeStore(keychainStore);
    try {
      await spawnWithInput(
        "security",
        ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        `${token}\n${token}\n`,
        {
          sensitiveInput: true,
          classifyFailure: ({ exitCode, stderr }) => macKeychainUnavailableOutput(exitCode, stderr)
            ? "macos-keychain-unavailable"
            : null,
        },
      );
      return keychainStore;
    } catch (error) {
      if (!macKeychainUnavailable(error)) throw error;
      const privateStore = { kind: "private-file", account, file: tokenFile(account) };
      await beforeStore(privateStore);
      return savePrivateToken(account, token, (identity) => afterPrepared(privateStore, identity));
    }
  }
  if (PLATFORM === "win32") {
    await mkdir(TOKEN_DIR, { recursive: true });
    const file = tokenFile(account);
    const tokenStore = { kind: "windows-dpapi", account, file };
    await beforeStore(tokenStore);
    const script = [
      "$ErrorActionPreference='Stop'",
      "$plain=[Console]::In.ReadToEnd()",
      "$plain=$plain.Trim()",
      "if ([String]::IsNullOrEmpty($plain)) { throw 'Companion credential input was empty' }",
      "$secure=ConvertTo-SecureString $plain -AsPlainText -Force",
      "$plain=$null",
      "$encrypted=ConvertFrom-SecureString $secure",
      "[IO.File]::WriteAllText($env:DRIFTGLASS_TOKEN_FILE,$encrypted)",
    ].join(";");
    await spawnWithInput("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], `${token}\n`, {
      timeout: 30_000,
      extraEnv: { DRIFTGLASS_TOKEN_FILE: file },
      sensitiveInput: true,
    });
    return tokenStore;
  }
  if (await commandExists("secret-tool")) {
    const tokenStore = { kind: "secret-service", account };
    await beforeStore(tokenStore);
    await spawnWithInput("secret-tool", ["store", "--label=Driftglass Relay", "service", KEYCHAIN_SERVICE, "account", account], `${token}\n`, { sensitiveInput: true });
    return tokenStore;
  }
  const privateStore = { kind: "private-file", account, file: tokenFile(account) };
  await beforeStore(privateStore);
  return savePrivateToken(account, token, (identity) => afterPrepared(privateStore, identity));
}

async function loadToken(store) {
  const account = store.account;
  if (store.kind === "macos-keychain") {
    return (await run("security", ["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE, "-a", account])).stdout.trim();
  }
  if (store.kind === "windows-dpapi") {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$encrypted=[IO.File]::ReadAllText($env:DRIFTGLASS_TOKEN_FILE)",
      "$secure=ConvertTo-SecureString $encrypted",
      "$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
      "try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}",
    ].join(";");
    return (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 30_000, {
      DRIFTGLASS_TOKEN_FILE: store.file || tokenFile(account),
    })).stdout.trim();
  }
  if (store.kind === "secret-service") {
    return (await run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", account], 30_000)).stdout.trim();
  }
  if (store.kind === "private-file") return readPrivateToken(store);
  throw new Error("Paired service credential store is unsupported");
}

async function deleteToken(store, options = {}) {
  if (!store) return;
  if (store.kind === "macos-keychain") {
    try {
      await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", store.account]);
    } catch (error) {
      if (!macKeychainItemNotFound(error)) {
        const exitCode = commandExitCode(error);
        throw new Error(`Keychain credential deletion failed${exitCode === null ? "" : ` (security exit ${exitCode})`}`);
      }
    }
  } else if (store.kind === "secret-service") {
    try {
      await run("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", store.account]);
    } catch (error) {
      const exitCode = commandExitCode(error);
      throw new Error(`Secret Service credential deletion failed${exitCode === null ? "" : ` (secret-tool exit ${exitCode})`}`);
    }
  } else if (store.kind === "private-file") {
    await deletePrivateToken(store, options);
  } else if (store.kind === "windows-dpapi") {
    const canonical = canonicalTokenStore(store, store.account);
    try {
      await unlink(canonical.file);
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw new Error("Windows credential deletion failed");
    }
  } else {
    throw new Error("Paired service credential store is unsupported");
  }
}

function isLoopbackHostname(hostnameValue) {
  const hostnameValueLower = String(hostnameValue || "").toLowerCase();
  return hostnameValueLower === "localhost"
    || hostnameValueLower === "127.0.0.1"
    || hostnameValueLower === "[::1]"
    || hostnameValueLower === "::1";
}

function collectorEndpoint(baseUrl, path) {
  if (typeof path !== "string" || !/^\/collector(?:\/|$)/.test(path) || path.startsWith("//") || /[\r\n\0]/.test(path)) {
    throw new Error("Companion refused an invalid Collector endpoint");
  }
  const rawBase = String(baseUrl || "").replace(/\/+$/, "");
  if (/[?#]/.test(rawBase)) {
    throw new Error("Paired Driftglass URL must not contain credentials, a query, or a fragment");
  }
  const base = new URL(rawBase);
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("Paired Driftglass URL must not contain credentials, a query, or a fragment");
  }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && isLoopbackHostname(base.hostname))) {
    throw new Error("Paired Driftglass URL must use HTTPS, except on this machine's loopback address");
  }
  const endpoint = new URL(`${rawBase}${path}`);
  if (
    endpoint.origin !== base.origin
    || endpoint.username
    || endpoint.password
    || !/^\/collector(?:\/|$)/.test(endpoint.pathname)
    || endpoint.pathname !== path
  ) {
    throw new Error("Companion refused a Collector endpoint outside the paired Driftglass origin or Collector path");
  }
  return endpoint;
}

async function readBoundedResponseBytes(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel("response too large").catch(() => undefined);
    throw new Error(`Cloud response exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response too large").catch(() => undefined);
        throw new Error(`Cloud response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchBoundedJson(url, init = {}, options = {}) {
  const timeoutMs = Math.max(50, Math.min(120_000, Number(options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS)));
  const maxBytes = Math.max(1_024, Math.min(MAX_WORKSPACE_RESPONSE_BYTES, Number(options.maxBytes || MAX_JSON_RESPONSE_BYTES)));
  const controller = new AbortController();
  const callerSignal = init.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason || new Error("Cloud request was cancelled"));
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Cloud request timed out")), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      // Collector credentials never follow redirects. Re-pair with the final
      // HTTPS origin instead of allowing a server response to retarget them.
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 204) {
      await response.body?.cancel().catch(() => undefined);
      return { response, body: null };
    }
    const bytes = await readBoundedResponseBytes(response, maxBytes);
    if (bytes.byteLength === 0) return { response, body: {} };
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error(`Cloud returned invalid JSON (HTTP ${response.status})`);
    }
    return { response, body };
  } catch (error) {
    if (controller.signal.aborted && !callerSignal?.aborted) {
      throw new Error(`Cloud request timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

async function request(baseUrl, token, path, init = {}, options = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("user-agent", `Driftglass-Companion/${VERSION}`);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const { response, body } = await fetchBoundedJson(collectorEndpoint(baseUrl, path), { ...init, headers }, options);
  if (body === null) return null;
  if (!response.ok) throw new Error(typeof body?.error === "string" ? redactDiagnostic(body.error) : `HTTP ${response.status}`);
  return body;
}

function deepArray(value, depth = 0) {
  if (depth > 8) return [];
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
  if (!value || typeof value !== "object") return [];
  for (const key of [
    "items", "results", "rows", "tweets", "posts", "data", "children", "bookmarks", "entries", "comments",
    "releases", "notifications", "videos", "transcripts", "jobs", "channels", "threads", "feeds",
  ]) {
    const found = deepArray(value[key], depth + 1);
    if (found.length) return found;
  }
  return [];
}

function getString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "bigint") return String(value);
  }
  return undefined;
}

function nestedString(record, path) {
  let value = record;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = value[key];
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toIso(value) {
  if (!value) return undefined;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 1_000_000_000
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeRecord(record, operation, provider) {
  const text = getString(record, [
    "full_text", "text", "body", "selftext", "content", "description", "markdown", "transcript", "caption",
    "about", "headline", "raw_text", "preview_text",
  ]) || "";
  const author = getString(record, ["author", "username", "handle", "screen_name", "by", "channel", "name"])
    || nestedString(record, ["user", "screen_name"])
    || nestedString(record, ["user", "username"])
    || nestedString(record, ["author", "name"]);
  const externalId = getString(record, [
    "id", "id_str", "tweet_id", "post_id", "postId", "fullname", "objectID", "video_id", "job_id", "thread_id",
  ]);
  let url = getString(record, ["url", "permalink", "link", "web_url", "tweet_url", "video_url", "profile_url", "job_url"]);
  if (url?.startsWith("/r/")) url = `https://www.reddit.com${url}`;
  if (!url && operation.startsWith("x.") && externalId && author) {
    url = `https://x.com/${author.replace(/^@/, "")}/status/${externalId}`;
  }
  const title = getString(record, ["title", "subject", "display_name", "full_name"])
    || (text ? `${author ? `@${author.replace(/^@/, "")}: ` : ""}${text.slice(0, 180)}` : `${operation} item`);
  const publishedAt = toIso(getString(record, [
    "published_at", "created_at", "createdAt", "created_utc", "date", "time", "timestamp", "posted_at", "listed",
  ]));
  const metadata = { operation, provider, rawKeys: Object.keys(record).slice(0, 60) };
  for (const key of [
    "score", "comments", "num_comments", "like_count", "likes", "favorite_count", "retweet_count", "retweets",
    "reposts", "views", "reply_count", "replies", "subreddit", "bookmarks", "impressions", "company", "location",
  ]) {
    if (record[key] !== undefined) metadata[key] = record[key];
  }
  return {
    externalId,
    url,
    title,
    text,
    author,
    publishedAt,
    accessClass: "authenticated-local",
    metadata,
  };
}

function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Collector returned no content");
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // Continue to the preceding line.
      }
    }
    const starts = [trimmed.indexOf("["), trimmed.indexOf("{")].filter((value) => value >= 0);
    if (starts.length) return JSON.parse(trimmed.slice(Math.min(...starts)));
    throw new Error("Collector output was not JSON");
  }
}

function openCliCommand(parts, profile, manifestEntry) {
  return {
    provider: "opencli",
    command: "opencli",
    args: [...(profile ? ["--profile", profile] : []), ...parts, "-f", "json"],
    env: profile ? { OPENCLI_PROFILE: profile } : {},
    profile: profile || null,
    browserRequired: manifestEntry?.browser !== false,
    manifestEntry,
  };
}

function twitterCliCommand(parts) {
  return { provider: "twitter-cli", command: "twitter", args: [...parts, "--json"], env: {} };
}

function redditCliCommand(parts) {
  return { provider: "rdt-cli", command: "rdt", args: [...parts, "--json"], env: {} };
}

let catalogCache;

async function executablePaths(command) {
  try {
    const { stdout } = await run(PLATFORM === "win32" ? "where.exe" : "which", [command], 10_000);
    return stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function findOpenCliManifest() {
  const candidates = [];
  if (process.env.OPENCLI_MANIFEST) candidates.push(process.env.OPENCLI_MANIFEST);
  if (await commandExists("npm")) {
    try {
      const root = (await run("npm", ["root", "-g"], 20_000)).stdout.trim();
      if (root) candidates.push(join(root, "@jackwener", "opencli", "cli-manifest.json"));
    } catch {
      // Continue with executable-relative paths.
    }
  }
  for (const binary of await executablePaths("opencli")) {
    const resolved = await realpath(binary).catch(() => binary);
    const binDir = dirname(resolved);
    candidates.push(
      join(binDir, "..", "lib", "node_modules", "@jackwener", "opencli", "cli-manifest.json"),
      join(binDir, "..", "node_modules", "@jackwener", "opencli", "cli-manifest.json"),
      join(binDir, "cli-manifest.json"),
      join(dirname(binDir), "Resources", "app", "cli-manifest.json"),
    );
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(resolve(candidate), "utf8"));
      if (Array.isArray(parsed) && parsed.length) return { path: resolve(candidate), entries: parsed };
    } catch {
      // Try the next candidate.
    }
  }
  return { path: null, entries: [] };
}

async function loadOpenCliCatalog(force = false) {
  if (catalogCache && !force) return catalogCache;
  const found = await findOpenCliManifest();
  const entries = found.entries
    .filter((entry) => entry && entry.access === "read" && typeof entry.site === "string" && typeof entry.name === "string");
  catalogCache = { path: found.path, entries };
  return catalogCache;
}

function manifestCommand(entry, params, profile) {
  const input = parseObject(params, "opencli.read args.params");
  const known = new Set((entry.args || []).map((arg) => arg.name));
  const unknown = Object.keys(input).filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`Unknown argument(s) for ${entry.site}.${entry.name}: ${unknown.join(", ")}`);
  const parts = [entry.site, entry.name];
  for (const arg of entry.args || []) {
    const value = input[arg.name];
    if (value === undefined || value === null || value === false || value === "") continue;
    if (arg.positional) {
      if (Array.isArray(value)) parts.push(...value.map(String));
      else parts.push(String(value));
    } else if (value === true) {
      parts.push(`--${arg.name}`);
    } else if (Array.isArray(value)) {
      for (const item of value) parts.push(`--${arg.name}`, String(item));
    } else {
      parts.push(`--${arg.name}`, String(value));
    }
  }
  return openCliCommand(parts, profile, entry);
}

async function assertReadOnlyCandidate(candidate) {
  if (candidate.command === "opencli") {
    if (candidate.manifestEntry) {
      if (candidate.manifestEntry.access !== "read") throw new Error(`Blocked non-read OpenCLI command: ${candidate.manifestEntry.site}.${candidate.manifestEntry.name}`);
      return;
    }
    const args = [...candidate.args];
    if (args[0] === "--profile") args.splice(0, 2);
    const key = `${args[0] || ""} ${args[1] || ""}`;
    if (!OPENCLI_READ_COMMANDS.has(key)) throw new Error(`Blocked non-read OpenCLI command: ${key}`);
    return;
  }
  if (candidate.command === "twitter") {
    if (!TWITTER_CLI_READ_COMMANDS.has(candidate.args[0])) throw new Error(`Blocked non-read twitter-cli command: ${candidate.args[0] || ""}`);
    return;
  }
  if (candidate.command === "rdt") {
    if (!RDT_CLI_READ_COMMANDS.has(candidate.args[0])) throw new Error(`Blocked non-read rdt-cli command: ${candidate.args[0] || ""}`);
    return;
  }
  throw new Error(`Collector executable is not allowlisted: ${candidate.command}`);
}

async function candidateCommands(operation, args, profile) {
  const query = String(args.query ?? "").trim();
  const id = String(args.id ?? args.url ?? "").trim();
  const name = String(args.name ?? args.subreddit ?? args.user ?? "").trim();
  const limit = String(boundedNumber(args.limit ?? args.max, 50, 1, 200));
  const opencli = (parts) => openCliCommand(parts, profile);
  const twitter = (parts) => twitterCliCommand(parts);
  const rdt = (parts) => redditCliCommand(parts);

  switch (operation) {
    case "x.trending": return [opencli(["twitter", "trending", "--limit", limit])];
    case "x.search": {
      const parts = ["twitter", "search", required(query, operation, "args.query"), "--limit", limit];
      optionalFlag(parts, "--filter", args.filter);
      return [opencli(parts), twitter(["search", query, "--max", limit])];
    }
    case "x.timeline": {
      const type = args.type === "following" ? "following" : "for-you";
      return [opencli(["twitter", "timeline", "--type", type, "--limit", limit]), twitter(["feed", ...(type === "following" ? ["-t", "following"] : []), "--max", limit])];
    }
    case "x.bookmarks": return [opencli(["twitter", "bookmarks", "--limit", limit]), twitter(["bookmarks", "--max", limit])];
    case "x.list": return [opencli(["twitter", "list-tweets", required(id || name, operation, "args.id"), "--limit", limit]), twitter(["list", id || name, "--max", limit])];
    case "x.thread": return [opencli(["twitter", "thread", required(id, operation, "args.id or args.url")]), twitter(["tweet", id])];
    case "x.notifications": return [opencli(["twitter", "notifications", "--limit", limit])];
    case "x.likes": return [opencli(["twitter", "likes", "--limit", limit]), ...(name ? [twitter(["likes", name, "--max", limit])] : [])];
    case "x.user": return [opencli(["twitter", "profile", required(name || id, operation, "args.name")]), twitter(["user", name || id])];
    case "x.user-posts": return [opencli(["twitter", "tweets", required(name || id, operation, "args.name"), "--limit", limit]), twitter(["user-posts", name || id, "--max", limit])];
    case "x.article": return [opencli(["twitter", "article", required(id, operation, "args.id or args.url")]), twitter(["article", id])];

    case "reddit.frontpage": return [opencli(["reddit", "frontpage", "--limit", limit]), rdt(["all", "--limit", limit])];
    case "reddit.home": return [opencli(["reddit", "home", "--limit", limit]), rdt(["feed", "--limit", limit])];
    case "reddit.popular": return [opencli(["reddit", "popular", "--limit", limit]), rdt(["popular", "--limit", limit])];
    case "reddit.subreddit": {
      const parts = ["reddit", "subreddit", required(name, operation, "args.subreddit"), "--limit", limit];
      optionalFlag(parts, "--sort", args.sort); optionalFlag(parts, "--time", args.time);
      return [opencli(parts), rdt(["sub", name, "--limit", limit])];
    }
    case "reddit.search": return [opencli(["reddit", "search", required(query, operation, "args.query"), "--limit", limit]), rdt(["search", query, "--limit", limit])];
    case "reddit.saved": return [opencli(["reddit", "saved", "--limit", limit]), rdt(["saved", "--limit", limit])];
    case "reddit.upvoted": return [opencli(["reddit", "upvoted", "--limit", limit]), rdt(["upvoted", "--limit", limit])];
    case "reddit.subscribed": return [opencli(["reddit", "subscribed", "--limit", limit])];
    case "reddit.thread": {
      const parts = ["reddit", "read", required(id, operation, "args.id"), "--depth", String(boundedNumber(args.depth, 2, 1, 5))];
      if (args.expandMore === true) parts.push("--expand-more");
      if (args.expandRounds !== undefined) parts.push("--expand-rounds", String(boundedNumber(args.expandRounds, 2, 1, 5)));
      return [opencli(parts), rdt(["read", id])];
    }
    case "reddit.user": return [opencli(["reddit", "user", required(name || id, operation, "args.name")]), rdt(["user", name || id])];
    case "reddit.user-posts": return [opencli(["reddit", "user-posts", required(name, operation, "args.name"), "--limit", limit]), rdt(["user-posts", name, "--limit", limit])];
    case "reddit.user-comments": return [opencli(["reddit", "user-comments", required(name, operation, "args.name"), "--limit", limit]), rdt(["user-comments", name, "--limit", limit])];
    case "reddit.subreddit-info": return [opencli(["reddit", "subreddit-info", required(name, operation, "args.subreddit")])];

    case "youtube.search": return [opencli(["youtube", "search", required(query, operation, "args.query"), "--limit", limit])];
    case "youtube.video": return [opencli(["youtube", "video", required(id, operation, "args.id or args.url")])];
    case "youtube.transcript": return [opencli(["youtube", "transcript", required(id, operation, "args.id or args.url")])];
    case "youtube.comments": return [opencli(["youtube", "comments", required(id, operation, "args.id or args.url"), "--limit", limit])];
    case "youtube.channel": return [opencli(["youtube", "channel", required(name || id, operation, "args.name"), "--limit", limit])];
    case "youtube.playlist": return [opencli(["youtube", "playlist", required(id, operation, "args.id or args.url"), "--limit", limit])];
    case "youtube.feed": return [opencli(["youtube", "feed", "--limit", limit])];
    case "youtube.history": return [opencli(["youtube", "history", "--limit", limit])];
    case "youtube.watch-later": return [opencli(["youtube", "watch-later", "--limit", limit])];
    case "youtube.subscriptions": return [opencli(["youtube", "subscriptions", "--limit", limit])];

    case "linkedin.timeline": return [opencli(["linkedin", "timeline", "--limit", limit])];
    case "linkedin.jobs": {
      const parts = ["linkedin", "search", required(query, operation, "args.query")];
      optionalFlag(parts, "--location", args.location); booleanFlag(parts, "--remote", args.remote);
      parts.push("--limit", limit); if (args.details === true) parts.push("--details");
      return [opencli(parts)];
    }
    case "linkedin.people": return [opencli(["linkedin", "people-search", required(query, operation, "args.query"), "--limit", limit])];
    case "linkedin.profile": return [opencli(["linkedin", "profile-read", ...(id ? ["--profile-url", id] : [])])];
    case "linkedin.posts": return [opencli(["linkedin", "posts", ...(id ? ["--profile-url", id] : []), "--limit", limit])];
    case "linkedin.job": return [opencli(["linkedin", "job-detail", required(id, operation, "args.id or args.url")])];

    case "instagram.explore": return [opencli(["instagram", "explore", "--limit", limit])];
    case "instagram.search": return [opencli(["instagram", "search", required(query, operation, "args.query"), "--limit", limit])];
    case "instagram.user": return [opencli(["instagram", "user", required(name, operation, "args.name"), "--limit", limit])];
    case "instagram.profile": return [opencli(["instagram", "profile", required(name, operation, "args.name")])];
    case "facebook.feed": return [opencli(["facebook", "feed", "--limit", limit])];
    case "facebook.search": return [opencli(["facebook", "search", required(query, operation, "args.query"), "--limit", limit])];
    case "facebook.groups": return [opencli(["facebook", "groups", "--limit", limit])];
    case "facebook.profile": return [opencli(["facebook", "profile", required(name || id, operation, "args.name")])];
    case "tiktok.explore": return [opencli(["tiktok", "explore", "--limit", limit])];
    case "tiktok.search": return [opencli(["tiktok", "search", required(query, operation, "args.query"), "--limit", limit])];
    case "tiktok.user": return [opencli(["tiktok", "user", required(name, operation, "args.name"), "--limit", limit])];
    case "tiktok.profile": return [opencli(["tiktok", "profile", required(name, operation, "args.name")])];

    case "opencli.read": {
      const site = required(args.site, operation, "args.site");
      const command = required(args.command, operation, "args.command");
      const catalog = await loadOpenCliCatalog();
      const entry = catalog.entries.find((candidate) => candidate.site === site && candidate.name === command);
      if (!entry) throw new Error(`Read-only OpenCLI adapter not found in local manifest: ${site}.${command}`);
      return [manifestCommand(entry, args.params, profile)];
    }
    default: throw new Error(`Capability is not allowlisted: ${operation}`);
  }
}

function redactDiagnostic(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/((?:auth[_-]?token|ct0|cookie|authorization|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/([?&](?:token|key|secret|auth)=[^&\s]+)/gi, (match) => match.replace(/=.*/, "=[redacted]"))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .slice(0, 1600);
}

const openCliReadinessCache = new Map();

function openCliProfilePattern(profile) {
  const escaped = String(profile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`, "i");
}

function openCliBridgeDisconnected(output) {
  return /(?:\[(?:missing|fail)\].*(?:extension|connectivity)|browser bridge[^\n]*(?:not connected|unavailable|failed)|(?:extension|chrome|chromium)[^\n]*not connected|no connected (?:browser|chrome|profile))/i.test(output);
}

function openCliProfileSelectionRequired(output) {
  return /(?:profile[_ -]required|multiple (?:chrome|browser bridge) profiles are connected(?: to the daemon)?, but no default profile was selected|multiple browser bridge profiles are connected[^\n]*select one with --profile)/i.test(output);
}

function openCliConnectedProfilesListed(output) {
  return /^\s*Connected Browser Bridge profiles\s*$/im.test(output);
}

function commandFailureDiagnostic(error) {
  if (!error || typeof error !== "object") return redactDiagnostic(error);
  return redactDiagnostic([error.stderr, error.stdout, error.message].filter(Boolean).join("\n"));
}

function openCliSetupMessage(readiness, profile) {
  const target = profile || "driftglass";
  if (readiness.status === "profile-missing") {
    return `OpenCLI Browser Bridge is connected, but the ${target} profile is not available. Run opencli profile list, rename the dedicated context to ${target}, then run opencli profile use ${target}.`;
  }
  if (readiness.status === "profile-unready") {
    return `OpenCLI Browser Bridge is connected, but the ${target} profile is not ready. Open that browser profile, connect its Browser Bridge extension, then retry.`;
  }
  if (readiness.status === "profile-required") {
    return `OpenCLI Browser Bridge has multiple connected profiles, but none is selected. Run opencli profile list, name the dedicated context ${target}, then run opencli profile use ${target}.`;
  }
  if (readiness.status === "bridge-disconnected") {
    return `OpenCLI Browser Bridge is not connected. Connect the extension to a dedicated browser profile, then name it ${target} with opencli profile rename and opencli profile use.`;
  }
  return `OpenCLI Browser Bridge could not be verified. Run opencli doctor, connect the extension, and retry with the dedicated ${target} profile.`;
}

async function runOpenCliPreflight(args, options = {}) {
  const env = { ...process.env, NO_COLOR: "1", OUTPUT: "json" };
  if (typeof options.profile === "string" && options.profile) env.OPENCLI_PROFILE = options.profile;
  else if (options.clearProfile === true) delete env.OPENCLI_PROFILE;
  return execFileAsync("opencli", args, {
    timeout: OPENCLI_PREFLIGHT_TIMEOUT_MS,
    maxBuffer: 24 * 1024 * 1024,
    windowsHide: true,
    env,
  });
}

async function readOpenCliProfileInventory(profile) {
  try {
    const listed = await runOpenCliPreflight(["profile", "list"], { clearProfile: true });
    const output = `${listed.stdout || ""}\n${listed.stderr || ""}`.trim();
    if (openCliProfilePattern(profile).test(output)) return { state: "present", diagnostic: "" };
    if (openCliConnectedProfilesListed(output)) {
      return {
        state: "missing",
        diagnostic: "OpenCLI reported connected Browser Bridge profiles, but the requested profile alias was absent.",
      };
    }
    return {
      state: "empty",
      diagnostic: "OpenCLI profile inventory did not report a connected Browser Bridge profile.",
    };
  } catch (error) {
    return { state: "unavailable", diagnostic: commandFailureDiagnostic(error) };
  }
}

async function inspectOpenCliScopedProfile(profile) {
  try {
    const scoped = await runOpenCliPreflight(["--profile", profile, "doctor"], { profile });
    const output = `${scoped.stdout || ""}\n${scoped.stderr || ""}`.trim();
    if (openCliProfileSelectionRequired(output) || openCliBridgeDisconnected(output)) {
      return {
        checked: true,
        ready: false,
        browserBridgeReady: true,
        profileReady: false,
        status: "profile-unready",
        diagnostic: redactDiagnostic(output),
      };
    }
    return {
      checked: true,
      ready: true,
      browserBridgeReady: true,
      profileReady: true,
      status: "ready",
      diagnostic: redactDiagnostic(output),
    };
  } catch (error) {
    return {
      checked: true,
      ready: false,
      browserBridgeReady: true,
      profileReady: false,
      status: "profile-unready",
      diagnostic: commandFailureDiagnostic(error),
    };
  }
}

async function inspectOpenCliReadiness(profile, force = false) {
  const normalizedProfile = typeof profile === "string" && profile.trim() ? profile.trim() : null;
  const cacheKey = normalizedProfile || "<default>";
  const cached = openCliReadinessCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.checkedAtMs < OPENCLI_PREFLIGHT_TTL_MS) return cached.value;

  const remember = (value) => {
    openCliReadinessCache.set(cacheKey, { checkedAtMs: Date.now(), value });
    return value;
  };
  const evaluateInventory = async () => {
    const inventory = await readOpenCliProfileInventory(normalizedProfile);
    if (inventory.state === "present") return { value: await inspectOpenCliScopedProfile(normalizedProfile), diagnostic: "" };
    if (inventory.state === "missing") {
      return {
        value: {
          checked: true,
          ready: false,
          browserBridgeReady: true,
          profileReady: false,
          status: "profile-missing",
          diagnostic: inventory.diagnostic,
        },
        diagnostic: inventory.diagnostic,
      };
    }
    return { value: null, diagnostic: inventory.diagnostic };
  };

  let inventoryDiagnostic = "";
  if (normalizedProfile) {
    const inventory = await evaluateInventory();
    if (inventory.value) return remember(inventory.value);
    inventoryDiagnostic = inventory.diagnostic;
  }

  let doctorOutput = "";
  try {
    const result = await runOpenCliPreflight(["doctor"], normalizedProfile ? { clearProfile: true } : {});
    doctorOutput = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  } catch (error) {
    return remember({
      checked: true,
      ready: false,
      browserBridgeReady: false,
      profileReady: normalizedProfile ? false : null,
      status: "doctor-failed",
      diagnostic: commandFailureDiagnostic(error),
    });
  }

  const profileSelectionRequired = openCliProfileSelectionRequired(doctorOutput);
  if (!profileSelectionRequired && openCliBridgeDisconnected(doctorOutput)) {
    return remember({
      checked: true,
      ready: false,
      browserBridgeReady: false,
      profileReady: normalizedProfile ? false : null,
      status: "bridge-disconnected",
      diagnostic: redactDiagnostic(doctorOutput),
    });
  }

  if (normalizedProfile) {
    const refreshed = await evaluateInventory();
    if (refreshed.value) return remember(refreshed.value);
    inventoryDiagnostic = refreshed.diagnostic || inventoryDiagnostic;
    if (profileSelectionRequired) {
      return remember({
        checked: true,
        ready: false,
        browserBridgeReady: true,
        profileReady: false,
        status: "profile-required",
        diagnostic: "OpenCLI reported multiple connected Browser Bridge profiles without a selected default.",
      });
    }
    return remember({
      checked: true,
      ready: false,
      browserBridgeReady: true,
      profileReady: false,
      status: "profile-missing",
      diagnostic: inventoryDiagnostic || "OpenCLI Browser Bridge is connected, but the requested profile was not present in its inventory.",
    });
  }

  if (profileSelectionRequired) {
    return remember({
      checked: true,
      ready: false,
      browserBridgeReady: true,
      profileReady: null,
      status: "profile-required",
      diagnostic: "OpenCLI reported multiple connected Browser Bridge profiles without a selected default.",
    });
  }

  return remember({
    checked: true,
    ready: true,
    browserBridgeReady: true,
    profileReady: null,
    status: "ready",
    diagnostic: redactDiagnostic(doctorOutput),
  });
}

async function executeCandidate(candidate, operation, maximum) {
  await assertReadOnlyCandidate(candidate);
  if (!(await commandExists(candidate.command))) throw new Error(`${candidate.command} is not installed`);
  if (candidate.command === "opencli" && candidate.browserRequired !== false) {
    const readiness = await inspectOpenCliReadiness(candidate.profile);
    if (!readiness.ready) throw new Error(openCliSetupMessage(readiness, candidate.profile));
  }
  const started = Date.now();
  const { stdout, stderr } = await run(candidate.command, candidate.args, 150_000, candidate.env);
  const parsed = parseJsonOutput(stdout);
  let records = deepArray(parsed);
  if (!records.length && parsed && typeof parsed === "object" && !Array.isArray(parsed)) records = [parsed];
  const selectedRecords = records.slice(0, maximum);
  const items = selectedRecords
    .map((record) => normalizeRecord(record, operation, candidate.provider))
    .filter((item) => item.text || item.url || item.externalId);
  if (!items.length) throw new Error(`${candidate.provider} completed but returned no usable content`);
  const cappedRecords = Math.max(0, records.length - selectedRecords.length);
  const unusableRecords = Math.max(0, selectedRecords.length - items.length);
  return {
    items,
    provider: candidate.provider,
    diagnostics: {
      durationMs: Date.now() - started,
      stderr: redactDiagnostic(stderr),
      returned: items.length,
      observedRecords: records.length,
      cappedRecords,
      unusableRecords,
      collectionPartial: cappedRecords > 0 || unusableRecords > 0,
    },
  };
}

async function executeJob(job, config) {
  if (!CAPABILITIES.includes(job.operation)) throw new Error(`Capability is not allowlisted: ${job.operation}`);
  const dynamicParams = job.operation === "opencli.read"
    && job.args?.params
    && typeof job.args.params === "object"
    && !Array.isArray(job.args.params)
    ? job.args.params
    : {};
  const requestedMaximum = job.operation === "opencli.read"
    ? dynamicParams.limit ?? dynamicParams.max ?? job.args?.limit ?? job.args?.max
    : job.args?.limit ?? job.args?.max;
  const maximum = boundedNumber(requestedMaximum, 75);
  const failures = [];
  for (const candidate of await candidateCommands(job.operation, job.args || {}, config.profile)) {
    try {
      const result = await executeCandidate(candidate, job.operation, maximum);
      result.diagnostics.fallbackFailures = failures;
      return result;
    } catch (error) {
      failures.push({ provider: candidate.provider, error: redactDiagnostic(error instanceof Error ? error.message : String(error)) });
    }
  }
  throw new Error(`Every read-only backend failed: ${failures.map((failure) => `${failure.provider}: ${failure.error}`).join("; ")}`);
}

function catalogEntryForCloud(entry) {
  return {
    site: entry.site,
    command: entry.name,
    description: entry.description || "",
    strategy: entry.strategy || "",
    browser: entry.browser !== false,
    args: (entry.args || []).map((arg) => ({
      name: arg.name,
      type: arg.type || "str",
      required: Boolean(arg.required),
      valueRequired: Boolean(arg.valueRequired),
      positional: Boolean(arg.positional),
      choices: Array.isArray(arg.choices) ? arg.choices.slice(0, 50) : undefined,
      help: arg.help || "",
      default: arg.default,
    })),
  };
}

function catalogForCloud(catalog, maximumBytes = MAX_CATALOG_PAYLOAD_BYTES) {
  const entries = [];
  let payloadBytes = 2;
  for (const entry of catalog.entries) {
    const normalized = catalogEntryForCloud(entry);
    const serializedBytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
    const nextBytes = payloadBytes + serializedBytes + (entries.length ? 1 : 0);
    if (nextBytes > maximumBytes) break;
    entries.push(normalized);
    payloadBytes = nextBytes;
  }
  return {
    entries,
    total: catalog.entries.length,
    advertised: entries.length,
    truncated: entries.length !== catalog.entries.length,
    payloadBytes,
    payloadLimitBytes: maximumBytes,
  };
}

async function diagnostics(profile, detailed = true) {
  const catalog = await loadOpenCliCatalog();
  const opencliPublicReadAdapters = catalog.entries.filter((entry) => entry.browser === false).length;
  const result = {
    platform: PLATFORM,
    architecture: process.arch,
    node: process.version,
    host: hostname(),
    profile: profile || null,
    capabilities: CAPABILITIES,
    checkedAt: new Date().toISOString(),
    executionBoundary: "typed-read-capabilities",
    opencliManifest: catalog.path,
    opencliReadAdapters: catalog.entries.length,
    opencliPublicReadAdapters,
  };
  for (const command of ["opencli", "agent-reach", "twitter", "rdt", "yt-dlp", "npm"]) result[command] = await commandExists(command);
  if (detailed && result.opencli) {
    const readiness = await inspectOpenCliReadiness(profile, true);
    result.opencliDoctor = readiness.diagnostic;
    result.opencliDoctorOk = readiness.ready;
    result.opencliReady = readiness.ready;
    result.opencliBrowserBridgeReady = readiness.browserBridgeReady;
    result.opencliProfileReady = readiness.profileReady;
    result.opencliSetupStatus = readiness.status;
    result.opencliUsable = readiness.ready || opencliPublicReadAdapters > 0;
  }
  if (detailed && result["agent-reach"]) {
    try { result.agentReachDoctor = JSON.parse((await run("agent-reach", ["doctor", "--json"], 60_000)).stdout); }
    catch (error) { result.agentReachDoctor = redactDiagnostic(error); }
  }
  return result;
}

function usableCollectorNames(result) {
  const usable = [];
  if (result.opencli && (result.opencliUsable === true || result.opencliDoctorOk !== false)) usable.push("opencli");
  if (result.twitter) usable.push("twitter");
  if (result.rdt) usable.push("rdt");
  return usable;
}

async function localPairingReadiness() {
  try {
    await recoverPairingJournal();
  } catch (error) {
    const configPresent = await lstat(CONFIG_PATH).then(() => true).catch((pathError) => {
      if (pathError && typeof pathError === "object" && pathError.code === "ENOENT") return false;
      return true;
    });
    return {
      report: {
        configPresent,
        paired: configPresent,
        credentialReadable: false,
        pairingRecoveryBlocked: true,
        error: `Pairing recovery is blocked: ${redactDiagnostic(error)}`,
      },
    };
  }
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      try {
        const removedCredentialTemps = await recoverPrivateTokenTemps();
        return { report: { configPresent: false, paired: false, credentialReadable: false, removedCredentialTemps } };
      } catch (credentialError) {
        return {
          report: {
            configPresent: false,
            paired: false,
            credentialReadable: false,
            credentialRecoveryBlocked: true,
            error: `Private credential recovery is blocked: ${redactDiagnostic(credentialError)}`,
          },
        };
      }
    }
    return {
      report: {
        configPresent: true,
        paired: false,
        credentialReadable: false,
        error: `Relay configuration is unreadable: ${redactDiagnostic(error)}`,
      },
    };
  }
  try {
    if (!config || typeof config !== "object") throw new Error("Relay configuration must be an object");
    const baseUrl = collectorEndpoint(String(config.baseUrl || ""), "/collector/workspaces").origin;
    if (!String(config.collectorId || "").trim()) throw new Error("Relay configuration is missing collectorId");
    const tokenStore = config.tokenStore || {
      kind: PLATFORM === "darwin" ? "macos-keychain" : "private-file",
      account: config.keychainAccount || config.collectorId,
    };
    const token = await loadToken(tokenStore);
    if (!token) throw new Error("Collector credential is empty");
    return {
      report: { configPresent: true, paired: true, credentialReadable: true, baseUrl },
      config,
      token,
    };
  } catch (error) {
    return {
      report: {
        configPresent: true,
        paired: true,
        credentialReadable: false,
        error: `Paired service credential is unavailable: ${redactDiagnostic(error)}`,
      },
    };
  }
}

async function contentProbeReport(values, profile) {
  const operation = typeof values["probe-operation"] === "string" ? values["probe-operation"].trim() : "";
  if (!operation) {
    return { checked: false, ready: false, status: "not-requested", operation: null };
  }
  const args = operationArgs(values);
  if (args.limit === undefined && args.max === undefined) args.limit = 3;
  const started = Date.now();
  try {
    const result = await executeJob({ operation, args }, { profile });
    return {
      checked: true,
      ready: true,
      status: "passed",
      operation,
      provider: result.provider,
      returned: result.items.length,
      durationMs: Date.now() - started,
      fallbackFailures: result.diagnostics.fallbackFailures,
    };
  } catch (error) {
    return {
      checked: true,
      ready: false,
      status: "failed",
      operation,
      durationMs: Date.now() - started,
      error: redactDiagnostic(error instanceof Error ? error.message : error),
    };
  }
}

async function authenticatedCloudReport(pairing, skipCloud) {
  if (!pairing.report.configPresent) {
    return { checked: false, ready: false, authenticated: false, status: "not-paired" };
  }
  if (!pairing.report.credentialReadable || !pairing.config || !pairing.token) {
    return { checked: false, ready: false, authenticated: false, status: "credential-unavailable" };
  }
  if (skipCloud) {
    return { checked: false, ready: false, authenticated: false, status: "skipped" };
  }
  const started = Date.now();
  try {
    const result = await request(pairing.config.baseUrl, pairing.token, "/collector/workspaces");
    if (!result || result.ok !== true || !Array.isArray(result.workspaces)) {
      throw new Error("Cloud collector check returned an invalid response");
    }
    return {
      checked: true,
      ready: true,
      authenticated: true,
      status: "passed",
      workspaceCount: result.workspaces.length,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      checked: true,
      ready: false,
      authenticated: false,
      status: "failed",
      durationMs: Date.now() - started,
      error: redactDiagnostic(error instanceof Error ? error.message : error),
    };
  }
}

async function doctorReport(values) {
  const profile = typeof values.profile === "string" ? values.profile : undefined;
  const diagnosticsResult = await diagnostics(profile, true);
  const pairing = await localPairingReadiness();
  const resultOutbox = await inspectResultOutbox(pairing.config);
  const usableCollectors = usableCollectorNames(diagnosticsResult);
  const localExecutableReady = usableCollectors.length > 0;
  const contentProbe = localExecutableReady
    ? await contentProbeReport(values, profile)
    : { checked: false, ready: false, status: "blocked", operation: null };
  const skipCloud = values["skip-cloud"] === true || String(values["skip-cloud"] || "").toLowerCase() === "true";
  const cloud = await authenticatedCloudReport(pairing, skipCloud);
  const probeReady = contentProbe.ready === true;
  const cloudReady = cloud.ready === true;
  const outboxReady = resultOutbox.valid === true;
  const browserProfileReady = !profile || diagnosticsResult.opencliReady !== false;
  const serviceReady = localExecutableReady && browserProfileReady && probeReady && pairing.report.paired && pairing.report.credentialReadable && cloudReady && outboxReady;
  const mode = pairing.report.configPresent
    ? (skipCloud ? "paired-local" : contentProbe.checked ? "paired-service" : "paired-connectivity")
    : (contentProbe.checked ? "probe-only" : "local-only");
  const blockers = [];
  const notices = [];
  const opencliSetupGap = diagnosticsResult.opencli && diagnosticsResult.opencliReady === false
    ? openCliSetupMessage({ status: diagnosticsResult.opencliSetupStatus }, profile)
    : null;
  if (!localExecutableReady) {
    if (opencliSetupGap) {
      blockers.push(opencliSetupGap);
    } else {
      blockers.push("No executable read collector is usable. Install OpenCLI, twitter-cli, or rdt-cli.");
    }
  } else if (opencliSetupGap) {
    if (profile) blockers.push(opencliSetupGap);
    else notices.push(opencliSetupGap);
  }
  if (contentProbe.checked && !probeReady) blockers.push(`Content-bearing probe failed: ${contentProbe.error || contentProbe.status}.`);
  if (!contentProbe.checked && localExecutableReady) notices.push("Content-bearing collection was not checked. Pass --probe-operation and its required arguments to validate a specific signed-in or public lane.");
  if (pairing.report.configPresent && !pairing.report.credentialReadable) blockers.push(pairing.report.error || "The paired collector credential is unavailable.");
  if (pairing.report.credentialRecoveryBlocked) blockers.push(pairing.report.error || "Private credential recovery is blocked.");
  if (pairing.report.pairingRecoveryBlocked) blockers.push(pairing.report.error || "Pairing recovery is blocked.");
  if (pairing.report.configPresent && pairing.report.credentialReadable && !skipCloud && !cloudReady) blockers.push(`Authenticated cloud check failed: ${cloud.error || cloud.status}.`);
  if (skipCloud && pairing.report.configPresent) notices.push("Authenticated cloud connectivity was explicitly skipped; background-service readiness is not established.");
  if (!pairing.report.configPresent) notices.push("Relay is unpaired. Local plan/probe commands are available, but the outbound background service is not ready.");
  if (!outboxReady) blockers.push(`The pending result outbox is unsafe or unreadable: ${resultOutbox.error || resultOutbox.status}.`);
  if (resultOutbox.pending && outboxReady) notices.push("One successful Collector result is awaiting cloud acknowledgement and will replay before another job is polled.");
  let ok;
  if (mode === "paired-service") ok = serviceReady;
  else if (mode === "paired-connectivity") ok = localExecutableReady && pairing.report.credentialReadable && cloudReady;
  else if (mode === "paired-local") ok = localExecutableReady && pairing.report.credentialReadable && (!contentProbe.checked || probeReady);
  else if (mode === "probe-only") ok = localExecutableReady && probeReady;
  else ok = localExecutableReady;
  ok = ok && outboxReady && blockers.length === 0;
  return {
    ok,
    mode,
    paired: pairing.report.paired,
    localExecutableReady,
    probeChecked: contentProbe.checked,
    probeReady,
    cloudChecked: cloud.checked,
    cloudReady,
    serviceReady,
    usableCollectors,
    contentProbe,
    cloud,
    resultOutbox,
    blockers,
    notices,
    polling: {
      minimumMs: POLL_MIN_MS,
      maximumMs: POLL_MAX_MS,
      heartbeatMs: HEARTBEAT_MS,
      detailedHeartbeatMs: DETAILED_HEARTBEAT_MS,
      workspaceSyncMs: WORKSPACE_SYNC_MS,
    },
    ...diagnosticsResult,
  };
}

function operationArgs(values) {
  const args = {};
  for (const key of [
    "query", "id", "url", "name", "user", "subreddit", "limit", "max", "type", "filter", "sort", "time",
    "depth", "expandMore", "expandRounds", "location", "remote", "details", "site", "command", "params",
  ]) {
    if (values[key] !== undefined) args[key] = values[key];
  }
  if (typeof args.params === "string") args.params = parseObject(args.params, "--params");
  return args;
}

async function plan(values) {
  const operation = String(values.operation || "").trim();
  if (!operation) throw new Error("plan requires --operation");
  const profile = typeof values.profile === "string" ? values.profile : undefined;
  const args = operationArgs(values);
  if (args.limit === undefined && args.max === undefined) args.limit = 3;
  const candidates = await candidateCommands(operation, args, profile);
  for (const candidate of candidates) await assertReadOnlyCandidate(candidate);
  console.log(JSON.stringify({ operation, candidates: candidates.map(({ provider, command, args: commandArgs }) => ({ provider, command, args: commandArgs })) }, null, 2));
}

async function probe(values) {
  const operation = String(values.operation || "").trim();
  if (!operation) throw new Error("probe requires --operation");
  const profile = typeof values.profile === "string" ? values.profile : undefined;
  const args = operationArgs(values);
  if (args.limit === undefined && args.max === undefined) args.limit = 3;
  const result = await executeJob({ operation, args }, { profile });
  console.log(JSON.stringify({
    ok: true,
    operation,
    provider: result.provider,
    returned: result.items.length,
    durationMs: result.diagnostics.durationMs,
    collectionPartial: result.diagnostics.collectionPartial === true,
    cappedRecords: Number(result.diagnostics.cappedRecords || 0),
    unusableRecords: Number(result.diagnostics.unusableRecords || 0),
    fallbackFailures: result.diagnostics.fallbackFailures,
  }, null, 2));
}

async function pair(values) {
  return withServiceOperationLock(() => pairLocked(values));
}

async function pairLocked(values) {
  const baseUrl = String(values.url || "").replace(/\/+$/, "");
  const code = String(values.code || "").trim().toUpperCase();
  const profile = typeof values.profile === "string" ? values.profile : undefined;
  if (!baseUrl || !code) throw new Error("pair requires --url and --code");
  await recoverPairingJournal();
  try {
    await lstat(CONFIG_PATH);
    throw new Error("Relay is already paired; unpair it before using another pairing code");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  await recoverPrivateTokenTemps();
  const resultOutbox = await inspectResultOutbox();
  if (resultOutbox.pending) {
    throw new Error("Pairing is blocked by a pending or invalid result outbox; restore the original pairing and obtain cloud acknowledgement first");
  }
  collectorEndpoint(baseUrl, "/collector/pair");
  if (profile) {
    const detected = await diagnostics(profile, true);
    if (!detected.opencli) {
      throw new Error(`OpenCLI is not installed. Install it, connect Browser Bridge, and create the dedicated ${profile} profile before pairing.`);
    }
    if (detected.opencliReady === false) {
      throw new Error(openCliSetupMessage({ status: detected.opencliSetupStatus }, profile));
    }
  }
  if (typeof values["probe-operation"] === "string" && values["probe-operation"].trim()) {
    const contentProbe = await contentProbeReport(values, profile);
    if (!contentProbe.ready) throw new Error(`Pairing content probe failed: ${contentProbe.error || contentProbe.status}`);
  }
  const response = await request(baseUrl, undefined, "/collector/pair", {
    method: "POST",
    body: JSON.stringify({ code, name: String(values.name || `${hostname()} relay`).slice(0, 120), version: VERSION, capabilities: CAPABILITIES }),
  });
  const collectorId = typeof response?.collectorId === "string" ? response.collectorId.trim() : "";
  const collectorToken = typeof response?.token === "string" ? response.token.trim() : "";
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(collectorId) || collectorToken.length < 8 || collectorToken.length > 512 || /\s|[\0-\x1f\x7f]/.test(collectorToken)) {
    throw new Error("Paired Driftglass returned an invalid Collector identity or credential");
  }
  const transactionId = randomUUID();
  const pairedAt = new Date().toISOString();
  let tokenStore;
  let config;
  const recordSelectedStore = async (selectedStore, credentialIdentity = null) => {
    const canonicalStore = canonicalTokenStore(selectedStore, collectorId);
    config = {
      baseUrl,
      collectorId,
      tokenStore: canonicalStore,
      profile,
      pairedAt,
      platform: PLATFORM,
      workspaceMirror: values.workspaceMirror !== "false",
    };
    await writePairingJournal({
      schemaVersion: "1",
      transactionId,
      pid: process.pid,
      account: collectorId,
      tokenStore: canonicalStore,
      credentialIdentity,
      configSha256: createHash("sha256").update(serializeConfig(config)).digest("hex"),
    });
  };
  try {
    tokenStore = await saveToken(
      collectorId,
      collectorToken,
      (selectedStore) => recordSelectedStore(selectedStore),
      (selectedStore, credentialIdentity) => recordSelectedStore(selectedStore, credentialIdentity),
    );
    config = { ...config, tokenStore: canonicalTokenStore(tokenStore, collectorId) };
    await writeConfig(config);
    testTokenCrash("after-config-rename");
    await clearPairingJournal({ transactionId });
  } catch (error) {
    let recovery;
    try {
      recovery = await recoverPairingJournal();
    } catch (recoveryError) {
      throw new Error(`${error instanceof Error ? error.message : "Pairing failed"}; credential recovery is blocked: ${recoveryError instanceof Error ? recoveryError.message : "unknown recovery failure"}`);
    }
    if (!recovery.committed) throw error;
  }
  console.log(`Paired collector ${collectorId}. Token stored with ${tokenStore.kind}.`);
  if (values.start === true) {
    await installService({ lockHeld: true });
    console.log("Installed and started the per-user background service.");
  } else {
    console.log("Run `driftglass-relay service-install` for hands-off operation.");
  }
}

async function heartbeat(config, token, includeDetails = false) {
  const body = {
    version: VERSION,
    capabilities: CAPABILITIES,
  };
  if (includeDetails) {
    const catalog = await loadOpenCliCatalog();
    const advertisedCatalog = catalogForCloud(catalog);
    body.details = {
      ...(await diagnostics(config.profile, false)),
      catalog: advertisedCatalog.entries,
      catalogTotal: advertisedCatalog.total,
      catalogAdvertised: advertisedCatalog.advertised,
      catalogTruncated: advertisedCatalog.truncated,
      catalogPayloadBytes: advertisedCatalog.payloadBytes,
      catalogPayloadLimitBytes: advertisedCatalog.payloadLimitBytes,
    };
  }
  await request(config.baseUrl, token, "/collector/heartbeat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function pollOnce(config, token) {
  await replayPendingResult(config, token);
  const body = await request(config.baseUrl, token, "/collector/jobs");
  if (body === null) return false;
  if (!body || typeof body !== "object" || !body.job) throw new Error("Job poll returned no Collector job");
  const job = body.job;
  const jobId = assertCollectorJobId(job.id);
  const operationLabel = redactDiagnostic(job.operation || "Collector job");
  let result;
  try {
    result = await executeJob(job, config);
  } catch (error) {
    await request(config.baseUrl, token, `/collector/jobs/${jobId}/result`, { method: "POST", body: JSON.stringify({ ok: false, error: redactDiagnostic(error instanceof Error ? error.message : error) }) });
    console.error(`${new Date().toISOString()} failed ${operationLabel}:`, redactDiagnostic(error instanceof Error ? error.message : error));
    return true;
  }

  const payloadJson = JSON.stringify({ ok: true, result });
  const pending = await persistResultOutbox(config, jobId, payloadJson);
  if (TEST_EXIT_AFTER_OUTBOX_WRITE) process.exit(86);
  try {
    await submitPendingResult(config, token, pending);
  } catch (error) {
    console.error(`${new Date().toISOString()} successful ${operationLabel} result retained for exact replay:`, redactDiagnostic(error instanceof Error ? error.message : error));
    throw error;
  }
  console.log(`${new Date().toISOString()} completed ${operationLabel}: ${result.items.length} items via ${redactDiagnostic(result.provider)}`);
  return true;
}

async function runLoop(once = false) {
  const config = await readConfig();
  const token = await loadToken(config.tokenStore || { kind: PLATFORM === "darwin" ? "macos-keychain" : "private-file", account: config.keychainAccount || config.collectorId });
  let lastHeartbeatAttempt = 0;
  let lastDetailedHeartbeatAttempt = 0;
  let lastWorkspaceSync = 0;
  let idlePollMs = POLL_MIN_MS;
  let failureBackoffMs = POLL_MIN_MS;
  let loopCount = 0;
  const pause = (milliseconds) => new Promise((resolvePromise) => {
    setTimeout(resolvePromise, TEST_DELAY_CAP_MS > 0 ? Math.min(milliseconds, TEST_DELAY_CAP_MS) : milliseconds);
  });
  do {
    loopCount += 1;
    const now = Date.now();
    if (now - lastHeartbeatAttempt >= HEARTBEAT_MS) {
      const includeDetails = lastDetailedHeartbeatAttempt === 0 || now - lastDetailedHeartbeatAttempt >= DETAILED_HEARTBEAT_MS;
      // Record attempts before the request. A transient failure must not turn a
      // large catalog heartbeat into a rapid retry loop.
      lastHeartbeatAttempt = now;
      if (includeDetails) lastDetailedHeartbeatAttempt = now;
      try {
        await heartbeat(config, token, includeDetails);
        failureBackoffMs = POLL_MIN_MS;
      } catch (error) {
        if (once) throw error;
        console.error(`${new Date().toISOString()} heartbeat failed; retrying service loop in ${failureBackoffMs}ms:`, redactDiagnostic(error instanceof Error ? error.message : error));
        if (TEST_LOOP_LIMIT > 0 && loopCount >= TEST_LOOP_LIMIT) break;
        await pause(failureBackoffMs);
        failureBackoffMs = Math.min(POLL_MAX_MS, Math.ceil(failureBackoffMs * 1.5));
        continue;
      }
    }
    if (config.workspaceMirror !== false && now - lastWorkspaceSync >= WORKSPACE_SYNC_MS) {
      await workspaceSync({ quiet: true }, { config, token }).catch((error) => {
        console.error(`${new Date().toISOString()} workspace mirror:`, redactDiagnostic(error instanceof Error ? error.message : error));
      });
      lastWorkspaceSync = Date.now();
    }
    let hadJob;
    try {
      hadJob = await pollOnce(config, token);
      failureBackoffMs = POLL_MIN_MS;
    } catch (error) {
      if (once) throw error;
      console.error(`${new Date().toISOString()} job poll failed; retrying service loop in ${failureBackoffMs}ms:`, redactDiagnostic(error instanceof Error ? error.message : error));
      if (TEST_LOOP_LIMIT > 0 && loopCount >= TEST_LOOP_LIMIT) break;
      await pause(failureBackoffMs);
      failureBackoffMs = Math.min(POLL_MAX_MS, Math.ceil(failureBackoffMs * 1.5));
      continue;
    }
    if (once) break;
    if (TEST_LOOP_LIMIT > 0 && loopCount >= TEST_LOOP_LIMIT) break;
    if (hadJob) {
      idlePollMs = POLL_MIN_MS;
    } else {
      await pause(idlePollMs);
      idlePollMs = Math.min(POLL_MAX_MS, Math.ceil(idlePollMs * 1.5));
    }
  } while (true);
}


function safeWorkspaceId(value) {
  const output = String(value || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  if (!output || output === "." || output === "..") throw new Error("A workspace ID is required");
  return output;
}

function safeWorkspaceRelativePath(value) {
  const normalized = String(value || "").normalize("NFC").replace(/^\/+/, "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const parts = normalized.split("/");
  const invalidSegment = (part) => !part
    || part === "."
    || part === ".."
    || /[<>:"|?*\0-\x1f\x7f]/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
    || part.endsWith(".")
    || part.endsWith(" ")
    || Buffer.byteLength(part, "utf8") > 255;
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 2_048 || parts.some(invalidSegment)) {
    throw new Error(`Invalid workspace path: ${value}`);
  }
  return normalized;
}

function prepareWorkspaceFiles(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("Mission workspace files must be a JSON object");
  const sourceEntries = Object.entries(files);
  if (sourceEntries.length > MAX_WORKSPACE_FILES) throw new Error(`Mission workspace contains more than ${MAX_WORKSPACE_FILES} files`);
  const prepared = [];
  const portablePaths = new Set();
  let totalBytes = 0;
  for (const [name, content] of sourceEntries) {
    const relative = safeWorkspaceRelativePath(name);
    if (relative.toLowerCase() === WORKSPACE_METADATA_FILE) throw new Error("Mission workspace payload cannot replace Companion metadata");
    const portable = relative.toLowerCase();
    if (portablePaths.has(portable)) throw new Error(`Mission workspace contains a duplicate portable path: ${relative}`);
    portablePaths.add(portable);
    if (typeof content !== "string") throw new Error(`Mission workspace file must contain text: ${relative}`);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_WORKSPACE_FILE_BYTES) throw new Error(`Mission workspace file exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes: ${relative}`);
    totalBytes += bytes;
    if (totalBytes > MAX_WORKSPACE_TOTAL_BYTES) throw new Error(`Mission workspace exceeds ${MAX_WORKSPACE_TOTAL_BYTES} bytes`);
    prepared.push({ relative, content, bytes });
  }
  for (const { relative } of prepared) {
    const parts = relative.toLowerCase().split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (portablePaths.has(parts.slice(0, index).join("/"))) {
        throw new Error(`Mission workspace path is both a file and a directory: ${relative}`);
      }
    }
  }
  return { entries: prepared, totalBytes };
}

function pathIsContained(root, target) {
  const candidate = relative(root, target);
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

async function workspaceContainer() {
  await mkdir(WORKSPACE_ROOT, { recursive: true, mode: 0o700 });
  const info = await lstat(WORKSPACE_ROOT);
  if (info.isSymbolicLink()) throw new Error(`Workspace root must not be a symbolic link: ${WORKSPACE_ROOT}`);
  if (!info.isDirectory()) throw new Error(`Workspace root is not a directory: ${WORKSPACE_ROOT}`);
  if (PLATFORM !== "win32") await chmod(WORKSPACE_ROOT, 0o700);
  return { path: resolve(WORKSPACE_ROOT), canonical: await realpath(WORKSPACE_ROOT) };
}

async function workspaceRoot(id, create = false) {
  const workspaceId = safeWorkspaceId(id);
  const container = await workspaceContainer();
  const path = join(container.path, workspaceId);
  let info = await lstat(path).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  });
  if (!info && create) {
    await mkdir(path, { mode: 0o700 });
    info = await lstat(path);
  }
  if (!info) throw new Error(`Local Mission workspace does not exist: ${workspaceId}`);
  if (info.isSymbolicLink()) throw new Error(`Workspace directory must not be a symbolic link: ${path}`);
  if (!info.isDirectory()) throw new Error(`Workspace path is not a directory: ${path}`);
  if (PLATFORM !== "win32") await chmod(path, 0o700);
  const canonical = await realpath(path);
  if (!pathIsContained(container.canonical, canonical) || canonical === container.canonical) throw new Error(`Workspace path escaped root: ${workspaceId}`);
  return { id: workspaceId, path, canonical, container };
}

async function workspaceFilePath(workspace, value, { createParents = false } = {}) {
  const normalized = safeWorkspaceRelativePath(value);
  const parts = normalized.split("/");
  let current = workspace.path;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const leaf = index === parts.length - 1;
    if (!pathIsContained(workspace.path, resolve(current))) throw new Error(`Workspace path escaped root: ${normalized}`);
    let info = await lstat(current).catch((error) => {
      if (error && typeof error === "object" && error.code === "ENOENT") return null;
      throw error;
    });
    if (!info && !leaf && createParents) {
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (!info) {
      if (!leaf) throw new Error(`Workspace parent does not exist: ${normalized}`);
      const parentCanonical = await realpath(dirname(current));
      if (!pathIsContained(workspace.canonical, parentCanonical)) throw new Error(`Workspace path escaped root: ${normalized}`);
      return current;
    }
    if (info.isSymbolicLink()) throw new Error(`Workspace paths must not contain symbolic links: ${normalized}`);
    const canonical = await realpath(current);
    if (!pathIsContained(workspace.canonical, canonical)) throw new Error(`Workspace path escaped root: ${normalized}`);
    if (!leaf && !info.isDirectory()) throw new Error(`Workspace parent is not a directory: ${normalized}`);
  }
  return current;
}

async function workspaceConfigAndToken() {
  const config = await readConfig();
  const token = await loadToken(config.tokenStore || { kind: PLATFORM === "darwin" ? "macos-keychain" : "private-file", account: config.keychainAccount || config.collectorId });
  return { config, token };
}

async function readBoundedLocalFile(path, maxBytes, label = "Local file") {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must be a regular file, not a symbolic link`);
  if (before.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${label} must be a regular file`);
    if (opened.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    const chunks = [];
    let total = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        throw new Error(`${label} exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBoundedLocalText(path, maxBytes, label) {
  return (await readBoundedLocalFile(path, maxBytes, label)).toString("utf8");
}

async function writeWorkspaceFiles(id, files) {
  const prepared = prepareWorkspaceFiles(files);
  const workspace = await workspaceRoot(id, true);
  const targets = [];
  for (const entry of prepared.entries) {
    const { relative } = entry;
    const target = await workspaceFilePath(workspace, relative, { createParents: true });
    const localOwned = /^(?:notes|results|exports)\//.test(relative);
    let targetInfo = null;
    try {
      targetInfo = await lstat(target);
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
    if (targetInfo && !targetInfo.isFile()) throw new Error(`Workspace target is not a regular file: ${relative}`);
    targets.push({ ...entry, target, preserve: localOwned && Boolean(targetInfo) });
  }
  const metadataPath = await workspaceFilePath(workspace, WORKSPACE_METADATA_FILE);
  const metadataInfo = await lstat(metadataPath).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  });
  if (metadataInfo && !metadataInfo.isFile()) throw new Error("Companion workspace metadata path is not a regular file");
  for (const { content, target, preserve } of targets) {
    if (preserve) continue;
    await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    if (PLATFORM !== "win32") await chmod(target, 0o600);
  }
  await writeFile(metadataPath, `${JSON.stringify({
    id: workspace.id,
    syncedAt: new Date().toISOString(),
    source: "mission-computer",
    localOwnedFolders: ["notes", "results", "exports"],
    fileCount: prepared.entries.length,
    totalBytes: prepared.totalBytes,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (PLATFORM !== "win32") await chmod(metadataPath, 0o600);
  return workspace.path;
}

async function walkWorkspaceFiles(workspace, current = workspace.path, output = [], state = { directories: 0, metadataFiles: 0, userFiles: 0 }, depth = 0) {
  if (depth > MAX_WORKSPACE_DEPTH) throw new Error(`Mission workspace exceeds ${MAX_WORKSPACE_DEPTH} directory levels`);
  const currentCanonical = await realpath(current);
  if (!pathIsContained(workspace.canonical, currentCanonical)) throw new Error(`Workspace path escaped root: ${current}`);
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const target = join(current, entry.name);
    const relativePath = relative(workspace.path, target).replaceAll("\\", "/");
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Workspace paths must not contain symbolic links: ${relativePath}`);
    const canonical = await realpath(target);
    if (!pathIsContained(workspace.canonical, canonical)) throw new Error(`Workspace path escaped root: ${relativePath}`);
    if (info.isDirectory()) {
      state.directories += 1;
      if (state.directories > MAX_WORKSPACE_DIRECTORIES) throw new Error(`Mission workspace contains more than ${MAX_WORKSPACE_DIRECTORIES} directories`);
      await walkWorkspaceFiles(workspace, target, output, state, depth + 1);
    } else if (info.isFile()) {
      output.push(relativePath);
      if (relativePath === WORKSPACE_METADATA_FILE) {
        state.metadataFiles += 1;
        if (state.metadataFiles > 1) throw new Error("Mission workspace contains duplicate Companion metadata");
      } else {
        state.userFiles += 1;
        if (state.userFiles > MAX_WORKSPACE_FILES) throw new Error(`Mission workspace contains more than ${MAX_WORKSPACE_FILES} files`);
      }
    }
    else throw new Error(`Workspace contains an unsupported file type: ${relativePath}`);
  }
  return output.sort();
}

async function listWorkspaceFiles(id) {
  const workspace = await workspaceRoot(id);
  return { workspace, files: await walkWorkspaceFiles(workspace) };
}

async function workspaceSync(values = {}, session) {
  const { config, token } = session || await workspaceConfigAndToken();
  const requestedId = typeof values.id === "string" ? safeWorkspaceId(values.id) : "";
  const listing = requestedId ? { workspaces: [{ id: requestedId }] } : await request(config.baseUrl, token, "/collector/workspaces");
  const workspaces = Array.isArray(listing?.workspaces) ? listing.workspaces : [];
  if (!workspaces.length) throw new Error("No Mission workspaces are available");
  if (workspaces.length > MAX_WORKSPACE_FILES) throw new Error(`Cloud returned more than ${MAX_WORKSPACE_FILES} Mission workspaces`);
  const synced = [];
  const seen = new Set();
  for (const workspace of workspaces) {
    const rawId = String(workspace?.id || "");
    const id = safeWorkspaceId(rawId);
    if (id !== rawId || seen.has(id)) throw new Error(`Cloud returned an invalid or duplicate Mission workspace ID: ${rawId}`);
    seen.add(id);
    const payload = await request(
      config.baseUrl,
      token,
      `/collector/workspaces/${encodeURIComponent(id)}`,
      {},
      { maxBytes: MAX_WORKSPACE_RESPONSE_BYTES, timeoutMs: WORKSPACE_REQUEST_TIMEOUT_MS },
    );
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`Cloud returned an invalid Mission workspace: ${id}`);
    const root = await writeWorkspaceFiles(id, payload.files || {});
    synced.push({ id, root, files: Object.keys(payload.files || {}).length, syncedAt: payload.computer?.syncedAt || new Date().toISOString() });
  }
  const result = { ok: true, root: WORKSPACE_ROOT, synced };
  if (values.quiet !== true) console.log(JSON.stringify(result, null, 2));
  return result;
}

async function workspacePush(values) {
  const id = safeWorkspaceId(values.id);
  const files = {};
  const listed = await listWorkspaceFiles(id);
  const pushable = listed.files.filter((relative) => /^(?:notes|results|exports)\//.test(relative));
  if (pushable.length > MAX_WORKSPACE_PUSH_FILES) {
    throw new Error(`Mission workspace has more than ${MAX_WORKSPACE_PUSH_FILES} local files to push`);
  }
  let totalBytes = 0;
  for (const relative of pushable) {
    const target = await workspaceFilePath(listed.workspace, relative);
    const content = await readBoundedLocalText(target, MAX_WORKSPACE_PUSH_FILE_BYTES, `Mission workspace file ${relative}`);
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > MAX_WORKSPACE_PUSH_TOTAL_BYTES) {
      throw new Error(`Mission workspace push exceeds ${MAX_WORKSPACE_PUSH_TOTAL_BYTES} bytes`);
    }
    files[`/${relative}`] = content;
  }
  if (!Object.keys(files).length) throw new Error("No local notes/, results/, or exports/ files are available to push");
  const body = JSON.stringify({ files });
  if (Buffer.byteLength(body, "utf8") > MAX_WORKSPACE_PUSH_REQUEST_BYTES) {
    throw new Error("Mission workspace push is too large after safe JSON encoding");
  }
  const { config, token } = await workspaceConfigAndToken();
  const result = await request(config.baseUrl, token, `/collector/workspaces/${encodeURIComponent(id)}`, {
    method: "PUT",
    body,
  });
  console.log(JSON.stringify({ ok: true, id, pushed: Object.keys(files), result }, null, 2));
}

async function workspaceList(values) {
  const id = typeof values.id === "string" ? safeWorkspaceId(values.id) : "";
  if (id) {
    const listed = await listWorkspaceFiles(id);
    console.log(JSON.stringify({ id, root: listed.workspace.path, files: listed.files }, null, 2));
    return;
  }
  const container = await workspaceContainer();
  const entries = await readdir(container.path, { withFileTypes: true });
  if (entries.length > MAX_WORKSPACE_FILES) throw new Error(`Companion has more than ${MAX_WORKSPACE_FILES} local Mission workspaces`);
  const workspaces = [];
  for (const entry of entries) {
    const target = join(container.path, entry.name);
    const entryInfo = await lstat(target);
    if (entryInfo.isSymbolicLink()) throw new Error(`Workspace directories must not be symbolic links: ${entry.name}`);
    if (!entryInfo.isDirectory()) continue;
    if (safeWorkspaceId(entry.name) !== entry.name) throw new Error(`Invalid local workspace directory name: ${entry.name}`);
    const listed = await listWorkspaceFiles(entry.name);
    const info = await stat(listed.workspace.path);
    workspaces.push({ id: entry.name, root: listed.workspace.path, updatedAt: info.mtime.toISOString(), files: listed.files.length });
  }
  console.log(JSON.stringify({ root: WORKSPACE_ROOT, workspaces }, null, 2));
}

async function workspaceSearch(values) {
  const id = safeWorkspaceId(values.id);
  const queryInput = required(values.query, "workspace-search", "--query");
  if (Buffer.byteLength(queryInput, "utf8") > 1_024) throw new Error("Workspace search query is too long");
  const query = queryInput.toLowerCase();
  const listed = await listWorkspaceFiles(id);
  const matches = [];
  let scannedBytes = 0;
  for (const relative of listed.files) {
    if (matches.length >= 250) break;
    const target = await workspaceFilePath(listed.workspace, relative);
    const info = await lstat(target);
    if (info.size > MAX_WORKSPACE_FILE_BYTES) continue;
    if (scannedBytes + info.size > MAX_WORKSPACE_SEARCH_BYTES) break;
    const content = await readBoundedLocalText(target, MAX_WORKSPACE_FILE_BYTES, `Mission workspace file ${relative}`);
    scannedBytes += Buffer.byteLength(content, "utf8");
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (line.toLowerCase().includes(query)) matches.push({ path: relative, line: index + 1, text: line.slice(0, 800) });
      if (matches.length >= 250) break;
    }
  }
  console.log(JSON.stringify({ id, query, matches }, null, 2));
}

async function workspaceNote(values) {
  const id = safeWorkspaceId(values.id);
  const content = required(values.content || values.note, "workspace-note", "--content");
  if (Buffer.byteLength(content, "utf8") > 200_000) throw new Error("Workspace note is too large");
  const workspace = await workspaceRoot(id, true);
  const path = await workspaceFilePath(workspace, "notes/local-notes.md", { createParents: true });
  let current;
  try {
    current = await readBoundedLocalText(path, MAX_WORKSPACE_PUSH_FILE_BYTES, "Mission local notes file");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    current = "# Local working notes\n";
  }
  const updated = `${current.trimEnd()}\n\n## ${new Date().toISOString()}\n\n${content.trim()}\n`;
  if (Buffer.byteLength(updated, "utf8") > MAX_WORKSPACE_PUSH_FILE_BYTES) throw new Error("Mission local notes file would exceed the cloud push limit");
  await writeFile(path, updated, { encoding: "utf8", mode: 0o600 });
  if (PLATFORM !== "win32") await chmod(path, 0o600);
  if (values.push !== "false") await workspacePush({ id });
  else console.log(JSON.stringify({ ok: true, id, path, pushed: false }, null, 2));
}

async function workspaceExport(values) {
  const id = safeWorkspaceId(values.id);
  const files = {};
  const listed = await listWorkspaceFiles(id);
  let encodedContentBytes = 0;
  for (const relative of listed.files.filter((path) => path.toLowerCase() !== WORKSPACE_METADATA_FILE)) {
    const target = await workspaceFilePath(listed.workspace, relative);
    const content = await readBoundedLocalText(target, MAX_WORKSPACE_FILE_BYTES, `Mission workspace file ${relative}`);
    encodedContentBytes += Buffer.byteLength(JSON.stringify(content), "utf8");
    if (encodedContentBytes > MAX_WORKSPACE_TOTAL_BYTES) throw new Error(`Mission workspace export exceeds ${MAX_WORKSPACE_TOTAL_BYTES} encoded bytes`);
    files[`/${relative}`] = content;
  }
  const output = resolve(String(values.out || join(process.cwd(), `driftglass-${id}-workspace.json`)));
  const outputInfo = await lstat(output).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  });
  if (outputInfo?.isSymbolicLink()) throw new Error(`Workspace export target must not be a symbolic link: ${output}`);
  if (outputInfo && !outputInfo.isFile()) throw new Error(`Workspace export target is not a regular file: ${output}`);
  await realpath(dirname(output));
  const serialized = `${JSON.stringify({ schemaVersion: WORKSPACE_ARCHIVE_SCHEMA_VERSION, id, exportedAt: new Date().toISOString(), files }, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKSPACE_RESPONSE_BYTES) throw new Error("Mission workspace export archive is too large");
  await writeFile(output, serialized, { encoding: "utf8", mode: 0o600 });
  if (PLATFORM !== "win32") await chmod(output, 0o600);
  console.log(JSON.stringify({ ok: true, id, output, files: Object.keys(files).length }, null, 2));
}

async function workspaceImport(values) {
  const input = resolve(required(values.file, "workspace-import", "--file"));
  const inputText = await readBoundedLocalText(input, MAX_WORKSPACE_RESPONSE_BYTES, "Mission workspace import");
  let payload;
  try {
    payload = JSON.parse(inputText);
  } catch {
    throw new Error("Mission workspace import is not valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Mission workspace import must be a JSON object");
  if (payload.schemaVersion !== WORKSPACE_ARCHIVE_SCHEMA_VERSION) {
    throw new Error(`Mission workspace archive schemaVersion must be ${WORKSPACE_ARCHIVE_SCHEMA_VERSION}`);
  }
  const fields = Object.keys(payload).sort();
  if (JSON.stringify(fields) !== JSON.stringify(["exportedAt", "files", "id", "schemaVersion"])) {
    throw new Error("Mission workspace archive fields are invalid");
  }
  const archiveId = safeWorkspaceId(payload.id);
  if (payload.id !== archiveId) throw new Error("Mission workspace archive ID is not canonical");
  if (typeof payload.exportedAt !== "string"
    || !Number.isFinite(Date.parse(payload.exportedAt))
    || new Date(payload.exportedAt).toISOString() !== payload.exportedAt) {
    throw new Error("Mission workspace archive exportedAt is not a canonical ISO timestamp");
  }
  if (!payload.files || typeof payload.files !== "object" || Array.isArray(payload.files)) {
    throw new Error("Mission workspace archive files must be a JSON object");
  }
  const id = typeof values.id === "string" ? safeWorkspaceId(values.id) : archiveId;
  const root = await writeWorkspaceFiles(id, payload.files);
  console.log(JSON.stringify({ ok: true, id, root, files: Object.keys(payload.files).length }, null, 2));
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function systemdEscape(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("%", "%%").replaceAll('"', '\\"');
}

async function servicePathValue() {
  const executableNames = ["driftglass-companion", "driftglass-relay", "opencli", "twitter", "rdt", "agent-reach", "yt-dlp", "npm"];
  const discovered = (await Promise.all(executableNames.map((command) => executablePaths(command)))).flat();
  const candidates = [process.execPath, SCRIPT_PATH, ...discovered];
  const directories = [];
  const addDirectory = (value) => {
    const directory = resolve(String(value));
    if (!isAbsolute(directory) || directory.includes(delimiter) || /[\r\n\0]/.test(directory) || directories.includes(directory)) return;
    directories.push(directory);
  };
  for (const candidate of candidates) {
    addDirectory(dirname(resolve(candidate)));
    const resolvedPath = await realpath(candidate).catch(() => resolve(candidate));
    addDirectory(dirname(resolvedPath));
  }
  const standardDirectories = PLATFORM === "darwin"
    ? [join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    : [join(HOME, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"];
  for (const directory of standardDirectories) addDirectory(directory);
  return directories.join(delimiter);
}

async function installMacService() {
  await mkdir(dirname(LAUNCH_AGENT), { recursive: true });
  await mkdir(STATE_DIR, { recursive: true });
  const servicePath = await servicePathValue();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>dev.driftglass.relay</string>\n<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(resolve(SCRIPT_PATH))}</string><string>run</string></array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(servicePath)}</string><key>NO_COLOR</key><string>1</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>15</integer>\n<key>StandardOutPath</key><string>${xml(join(STATE_DIR, "relay.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(join(STATE_DIR, "relay.error.log"))}</string>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
  await writePrivateFile(LAUNCH_AGENT, plist);
  await run("launchctl", ["bootout", `gui/${process.getuid()}`, LAUNCH_AGENT]).catch(() => undefined);
  await run("launchctl", ["bootstrap", `gui/${process.getuid()}`, LAUNCH_AGENT]);
}

async function installLinuxService() {
  if (!(await commandExists("systemctl"))) throw new Error("systemd user services are unavailable; run `driftglass-relay run` with your preferred process manager");
  await mkdir(dirname(SYSTEMD_UNIT), { recursive: true });
  await mkdir(STATE_DIR, { recursive: true });
  const servicePath = await servicePathValue();
  const unit = `[Unit]\nDescription=Driftglass Relay\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart="${systemdEscape(process.execPath)}" "${systemdEscape(resolve(SCRIPT_PATH))}" run\nRestart=always\nRestartSec=15\nWorkingDirectory=${systemdEscape(HOME)}\nEnvironment="PATH=${systemdEscape(servicePath)}"\nEnvironment="NO_COLOR=1"\nStandardOutput=append:${systemdEscape(join(STATE_DIR, "relay.log"))}\nStandardError=append:${systemdEscape(join(STATE_DIR, "relay.error.log"))}\n\n[Install]\nWantedBy=default.target\n`;
  await writeFile(SYSTEMD_UNIT, unit, { mode: 0o644 });
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "--now", "driftglass-relay.service"]);
}

async function installWindowsService() {
  await mkdir(STATE_DIR, { recursive: true });
  const command = `@echo off\r\n"${process.execPath}" "${resolve(SCRIPT_PATH)}" run >> "${join(STATE_DIR, "relay.log")}" 2>> "${join(STATE_DIR, "relay.error.log")}"\r\n`;
  await writeFile(WINDOWS_RUNNER, command, "utf8");
  await run("schtasks.exe", ["/Create", "/TN", WINDOWS_TASK, "/TR", WINDOWS_RUNNER, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"], 30_000);
  await run("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK], 30_000).catch(() => undefined);
}

async function installService(options = {}) {
  if (options.lockHeld !== true) return withServiceOperationLock(() => installService({ lockHeld: true }));
  await readConfig();
  if (PLATFORM === "darwin") return installMacService();
  if (PLATFORM === "win32") return installWindowsService();
  return installLinuxService();
}

async function removeServiceFile(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw new Error(`${label} removal could not be prepared`);
  }
  if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`${label} is not removable`);
  try {
    await unlink(path);
  } catch {
    throw new Error(`${label} removal failed`);
  }
  try {
    await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw new Error(`${label} removal could not be verified`);
  }
  throw new Error(`${label} removal could not be verified`);
}

async function macServiceLoaded() {
  let result;
  try {
    result = await run("launchctl", ["print", `gui/${process.getuid()}`]);
  } catch (error) {
    const exitCode = commandExitCode(error);
    throw new Error(`Companion service state could not be inspected${exitCode === null ? "" : ` (launchctl exit ${exitCode})`}`);
  }
  return /(^|[\s"'=])dev\.driftglass\.relay(?=$|[\s"';={])/m.test(String(result.stdout || ""));
}

async function uninstallMacServiceStrict() {
  if (await macServiceLoaded()) {
    try {
      await run("launchctl", ["bootout", `gui/${process.getuid()}/dev.driftglass.relay`]);
    } catch (error) {
      const exitCode = commandExitCode(error);
      throw new Error(`Companion service stop failed${exitCode === null ? "" : ` (launchctl exit ${exitCode})`}`);
    }
  }
  if (await macServiceLoaded()) throw new Error("Companion service is still loaded; pairing state was preserved");
  await removeServiceFile(LAUNCH_AGENT, "Companion service file");
  if (await macServiceLoaded()) throw new Error("Companion service restarted during removal; pairing state was preserved");
}

function linuxServiceStopped(error, stdout) {
  const output = String(stdout ?? error?.stdout ?? "").replace(/\r\n?/g, "\n").trim();
  const exitCode = error ? commandExitCode(error) : 0;
  return (exitCode === 3 && ["inactive", "failed"].includes(output))
    || (exitCode === 4 && output === "unknown");
}

async function assertLinuxServiceStopped() {
  try {
    const result = await run("systemctl", ["--user", "is-active", "driftglass-relay.service"]);
    if (linuxServiceStopped(null, result.stdout)) return;
    throw new Error("Companion service is still active");
  } catch (error) {
    if (linuxServiceStopped(error)) return;
    if (error instanceof Error && error.message === "Companion service is still active") throw error;
    const exitCode = commandExitCode(error);
    throw new Error(`Companion service stop could not be verified${exitCode === null ? "" : ` (systemctl exit ${exitCode})`}`);
  }
}

async function uninstallLinuxServiceStrict() {
  await run("systemctl", ["--user", "disable", "--now", "driftglass-relay.service"]).catch(() => undefined);
  await assertLinuxServiceStopped();
  await removeServiceFile(SYSTEMD_UNIT, "Companion systemd unit");
  try {
    await run("systemctl", ["--user", "daemon-reload"]);
  } catch (error) {
    const exitCode = commandExitCode(error);
      throw new Error(`Companion service removal could not be committed${exitCode === null ? "" : ` (systemctl exit ${exitCode})`}`);
  }
  await assertLinuxServiceStopped();
}

async function uninstallWindowsServiceStrict() {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$task=Get-ScheduledTask -TaskName '${WINDOWS_TASK}' -ErrorAction SilentlyContinue`,
    "if ($null -ne $task) {",
    "Disable-ScheduledTask -InputObject $task -ErrorAction Stop | Out-Null",
    "Stop-ScheduledTask -InputObject $task -ErrorAction Stop",
    `$task=Get-ScheduledTask -TaskName '${WINDOWS_TASK}' -ErrorAction SilentlyContinue`,
    "if ($null -ne $task -and $task.State -ne 'Disabled') { exit 41 }",
    `if ($null -ne $task) { Unregister-ScheduledTask -TaskName '${WINDOWS_TASK}' -Confirm:$false -ErrorAction Stop }`,
    `$task=Get-ScheduledTask -TaskName '${WINDOWS_TASK}' -ErrorAction SilentlyContinue`,
    "if ($null -ne $task) { exit 42 }",
    "}",
    "",
  ].join(";");
  try {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 30_000);
  } catch (error) {
    const exitCode = commandExitCode(error);
    throw new Error(`Companion scheduled task stop could not be verified${exitCode === null ? "" : ` (PowerShell exit ${exitCode})`}`);
  }
  await removeServiceFile(WINDOWS_RUNNER, "Companion scheduled-task runner");
}

async function uninstallService(options = {}) {
  if (options.lockHeld !== true) return withServiceOperationLock(() => uninstallService({ lockHeld: true }));
  if (PLATFORM === "darwin") return uninstallMacServiceStrict();
  if (PLATFORM === "win32") return uninstallWindowsServiceStrict();
  return uninstallLinuxServiceStrict();
}

async function startService(options = {}) {
  if (options.lockHeld !== true) return withServiceOperationLock(() => startService({ lockHeld: true }));
  await readConfig();
  if (PLATFORM === "darwin") {
    const exists = await readFile(LAUNCH_AGENT, "utf8").then(() => true).catch(() => false);
    if (!exists) return installMacService();
    await run("launchctl", ["bootstrap", `gui/${process.getuid()}`, LAUNCH_AGENT]).catch(() => undefined);
    await run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/dev.driftglass.relay`]);
  } else if (PLATFORM === "win32") {
    await run("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK], 30_000);
  } else {
    await run("systemctl", ["--user", "start", "driftglass-relay.service"], 30_000);
  }
  console.log("Driftglass Companion started.");
}

async function stopService(options = {}) {
  if (options.lockHeld !== true) return withServiceOperationLock(() => stopService({ lockHeld: true }));
  if (PLATFORM === "darwin") {
    await run("launchctl", ["bootout", `gui/${process.getuid()}`, LAUNCH_AGENT]).catch(() => undefined);
  } else if (PLATFORM === "win32") {
    await run("schtasks.exe", ["/End", "/TN", WINDOWS_TASK], 30_000).catch(() => undefined);
  } else {
    await run("systemctl", ["--user", "stop", "driftglass-relay.service"], 30_000).catch(() => undefined);
  }
  console.log("Driftglass Companion stopped.");
}

async function restartService(options = {}) {
  if (options.lockHeld !== true) return withServiceOperationLock(() => restartService({ lockHeld: true }));
  await restartInstalledService();
  console.log("Driftglass Companion restarted.");
}

async function serviceStatus() {
  if (PLATFORM === "darwin") {
    try { console.log((await run("launchctl", ["print", `gui/${process.getuid()}/dev.driftglass.relay`])).stdout.trim()); }
    catch { console.log("Driftglass relay service is not loaded."); }
  } else if (PLATFORM === "win32") {
    try { console.log((await run("schtasks.exe", ["/Query", "/TN", WINDOWS_TASK, "/V", "/FO", "LIST"])).stdout.trim()); }
    catch { console.log("Driftglass relay task is not installed."); }
  } else {
    try { console.log((await run("systemctl", ["--user", "status", "driftglass-relay.service", "--no-pager"])).stdout.trim()); }
    catch { console.log("Driftglass relay systemd user service is not loaded."); }
  }
}

async function readUnpairConfig() {
  let text;
  try {
    text = await readFile(CONFIG_PATH, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw new Error("Relay configuration could not be read; pairing state was preserved");
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error("Relay configuration is invalid; pairing state was preserved");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Relay configuration is invalid; pairing state was preserved");
  }
  const collectorId = String(config.collectorId || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(collectorId)) {
    throw new Error("Relay configuration has no valid Collector identity; pairing state was preserved");
  }
  let tokenStore;
  if (config.tokenStore) {
    tokenStore = canonicalTokenStore(config.tokenStore, collectorId);
  } else {
    const legacyAccount = String(config.keychainAccount || collectorId).trim();
    tokenStore = canonicalTokenStore({
      kind: PLATFORM === "darwin" ? "macos-keychain" : "private-file",
      account: legacyAccount,
      ...(PLATFORM === "darwin" ? {} : { file: tokenFile(legacyAccount) }),
    }, collectorId);
  }
  return { config, tokenStore, configSha256: createHash("sha256").update(text).digest("hex") };
}

async function unpair() {
  return withServiceOperationLock(() => unpairLocked());
}

async function unpairLocked() {
  const state = await readUnpairConfig();
  const config = state?.config || null;
  const pending = await readResultOutbox();
  if (pending) {
    if (!config) throw new Error("Cannot unpair safely while a pending result lacks its original pairing configuration");
    const token = await loadToken(state.tokenStore);
    await submitPendingResult(config, token, pending);
    console.log("Pending Collector result acknowledged before unpairing.");
  }
  await uninstallService({ lockHeld: true });
  await recoverPairingJournal();
  await recoverPrivateTokenTemps();
  if (state) {
    const currentConfig = await readFile(CONFIG_PATH);
    if (createHash("sha256").update(currentConfig).digest("hex") !== state.configSha256) {
      throw new Error("Relay configuration changed during unpair; pairing state was preserved");
    }
    await deleteToken(state.tokenStore);
    await rm(CONFIG_PATH, { force: true });
  }
  console.log("Relay configuration, service, and local token removed. No unacknowledged result was discarded.");
}

async function catalog(values) {
  const loaded = await loadOpenCliCatalog(values.refresh === true);
  const site = typeof values.site === "string" ? values.site : undefined;
  const selected = site ? { ...loaded, entries: loaded.entries.filter((entry) => entry.site === site) } : loaded;
  const advertised = catalogForCloud(selected);
  console.log(JSON.stringify({
    manifest: loaded.path,
    count: advertised.advertised,
    total: advertised.total,
    truncated: advertised.truncated,
    payloadBytes: advertised.payloadBytes,
    payloadLimitBytes: advertised.payloadLimitBytes,
    adapters: advertised.entries,
  }, null, 2));
}

async function restartInstalledService() {
  if (PLATFORM === "darwin") {
    await run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/dev.driftglass.relay`], 30_000).catch(() => undefined);
  } else if (PLATFORM === "win32") {
    await run("schtasks.exe", ["/End", "/TN", WINDOWS_TASK], 30_000).catch(() => undefined);
    await run("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK], 30_000).catch(() => undefined);
  } else if (await commandExists("systemctl")) {
    await run("systemctl", ["--user", "restart", "driftglass-relay.service"], 30_000).catch(() => undefined);
  }
}

async function updateCompanion(values = {}) {
  if (values.url) {
    throw new Error("Remote self-update is disabled: the paired server cannot authenticate executable code. Download a trusted release separately, then use update --file and --sha256.");
  }
  const sourcePath = resolve(required(values.file, "update", "--file"));
  const expected = required(values.sha256, "update", "--sha256").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error("update --sha256 must be a 64-character SHA-256 digest from a trusted release channel");
  const bytes = await readBoundedLocalFile(sourcePath, MAX_UPDATE_BYTES, "Companion update file");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (expected !== actual) throw new Error("Companion update checksum does not match the trusted digest");
  const sourceText = bytes.toString("utf8");
  if (!sourceText.includes("Driftglass Companion") || !/\bconst VERSION\s*=\s*[\"'][^\"']+[\"']/.test(sourceText)) {
    throw new Error("Companion update file does not look like a Driftglass Companion release");
  }
  const currentInfo = await lstat(SCRIPT_PATH);
  if (currentInfo.isSymbolicLink() || !currentInfo.isFile()) {
    throw new Error("Companion executable must be a regular file; replace symbolic-link installations manually");
  }
  const currentBytes = await readBoundedLocalFile(SCRIPT_PATH, MAX_UPDATE_BYTES, "Current Companion executable");
  const currentHash = createHash("sha256").update(currentBytes).digest("hex");
  if (currentHash === actual) {
    console.log("Driftglass Companion already matches the verified update file.");
    return;
  }
  const temporary = `${SCRIPT_PATH}.${process.pid}.${randomUUID()}.update.mjs`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o755);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (PLATFORM !== "win32") await chmod(temporary, 0o755);
    await run(process.execPath, ["--check", temporary], 30_000);
    await rename(temporary, SCRIPT_PATH);
    if (PLATFORM !== "win32") {
      let directoryHandle;
      try {
        directoryHandle = await open(dirname(SCRIPT_PATH), "r");
        await directoryHandle.sync();
      } catch (error) {
        if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(String(error?.code || ""))) throw error;
      } finally {
        await directoryHandle?.close().catch(() => undefined);
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  if (values.restart !== "false") await withServiceOperationLock(() => restartInstalledService());
  console.log(`Installed verified Companion update ${actual.slice(0, 12)}… from ${sourcePath}.`);
}

function help(toError = false) {
  const output = `Driftglass Companion ${VERSION} (${PLATFORM}/${process.arch})\n\nUsage:\n  driftglass-companion <command> [options]\n  driftglass-companion --help\n  driftglass-companion --version\n\nCommands:\n  pair --url https://your-worker.example --code ABCD1234 [--profile driftglass] [--probe-operation x.timeline] [--start]\n  run\n  once\n  doctor [--profile driftglass] [--probe-operation reddit.home] [--skip-cloud]\n  capabilities\n  catalog [--site twitter] [--refresh]\n  plan --operation x.timeline [--profile driftglass] [--type for-you] [--limit 3]\n  plan --operation opencli.read --site bluesky --command feed --params '{"limit":20}'\n  probe --operation x.timeline [--profile driftglass] [--type for-you] [--limit 3]\n  workspace-sync [--id mission-id]\n  workspace-list [--id mission-id]\n  workspace-search --id mission-id --query "term"\n  workspace-note --id mission-id --content "note" [--push false]\n  workspace-push --id mission-id\n  workspace-export --id mission-id [--out file.json]\n  workspace-import --file file.json [--id mission-id]\n  service-install\n  service-start\n  service-stop\n  service-restart\n  service-status\n  service-uninstall\n  update [--restart false]\n  unpair\n\nThe Companion runs on macOS, Windows, and Linux. It polls outbound, discovers OpenCLI read adapters, sends normalized evidence to Driftglass, and mirrors Mission Computer workspaces for a free local/self-hosted path.`;
  const rendered = output.replace(
    "  update [--restart false]",
    "  update --file driftglass-relay.mjs --sha256 TRUSTED_SHA256 [--restart false]",
  );
  if (toError) console.error(rendered);
  else console.log(rendered);
}

const { command, values } = parseArgs(process.argv.slice(2));
try {
  if (["help", "--help", "-h"].includes(command) || values.help === true) help();
  else if (["version", "--version", "-v"].includes(command) || values.version === true) console.log(VERSION);
  else if (command === "pair") await pair(values);
  else if (command === "run") await runLoop(false);
  else if (command === "once") await runLoop(true);
  else if (command === "doctor") {
    const report = await doctorReport(values);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
  else if (command === "capabilities") console.log(JSON.stringify({ version: VERSION, platform: PLATFORM, capabilities: CAPABILITIES }, null, 2));
  else if (command === "catalog") await catalog(values);
  else if (command === "plan") await plan(values);
  else if (command === "probe") await probe(values);
  else if (command === "service-install") await installService();
  else if (command === "service-start") await startService();
  else if (command === "service-stop") await stopService();
  else if (command === "service-restart") await restartService();
  else if (command === "service-uninstall") await uninstallService();
  else if (command === "service-status") await serviceStatus();
  else if (command === "update" || command === "self-update") await updateCompanion(values);
  else if (command === "workspace-sync") await workspaceSync(values);
  else if (command === "workspace-list") await workspaceList(values);
  else if (command === "workspace-push") await workspacePush(values);
  else if (command === "workspace-search") await workspaceSearch(values);
  else if (command === "workspace-note") await workspaceNote(values);
  else if (command === "workspace-export") await workspaceExport(values);
  else if (command === "workspace-import") await workspaceImport(values);
  else if (command === "unpair") await unpair();
  else {
    console.error(`Unknown command: ${redactDiagnostic(command)}`);
    help(true);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(redactDiagnostic(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
