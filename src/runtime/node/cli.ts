#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { createLocalBackup, restoreLocalBackup, verifyLocalBackup } from "./backup";
import { initializeFreshLocalAuthority, loadVerifiedLocalAuthority } from "./authority";
import { createLocalDataLayout, defaultLocalDataDirectory } from "./layout";
import { acquireLocalRuntimeLease } from "./process-lock";
import { startExperimentalSelfhost } from "./selfhost";
import { buildChatGptTunnelSetup } from "./chatgpt-tunnel";
import {
  normalizeLocalMcpOrigin,
  runLocalStdioMcpBridge,
  type LocalMcpAccess,
} from "./stdio-mcp-bridge";

const DISTRIBUTION_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ASSETS_DIRECTORY = join(DISTRIBUTION_DIRECTORY, "public");
const DEFAULT_MIGRATIONS_DIRECTORY = join(DISTRIBUTION_DIRECTORY, "migrations");
const SELFHOST_EXECUTABLE = fileURLToPath(import.meta.url);

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, readonly string[]>;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid option: ${token}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Option ${token} requires a value`);
    index += 1;
    const entries = values.get(name) ?? [];
    entries.push(value);
    values.set(name, entries);
  }
  return Object.freeze({ positionals: Object.freeze(positionals), values });
}

function allowedOptions(parsed: ParsedArguments, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const [name] of parsed.values) {
    if (!accepted.has(name)) throw new Error(`Unsupported option for this command: --${name}`);
  }
}

function option(parsed: ParsedArguments, name: string): string | undefined {
  const values = parsed.values.get(name);
  if (!values) return undefined;
  if (values.length !== 1) throw new Error(`Option --${name} may be provided only once`);
  return values[0];
}

function absoluteOption(parsed: ParsedArguments, name: string, fallback?: string): string {
  const value = option(parsed, name) ?? fallback;
  if (!value) throw new Error(`Missing required option --${name}`);
  if (!isAbsolute(value)) throw new Error(`Option --${name} must be an absolute path`);
  return resolve(value);
}

function profile(parsed: ParsedArguments): void {
  const value = option(parsed, "profile") ?? "selfhost";
  if (value !== "selfhost") {
    throw new Error("This executable implements only the experimental selfhost profile; Cloudflare uses the existing Worker deployment");
  }
}

function localOrigin(parsed: ParsedArguments): string {
  return normalizeLocalMcpOrigin(option(parsed, "origin") ?? "http://127.0.0.1:8787");
}

function localMcpAccess(parsed: ParsedArguments): LocalMcpAccess {
  const value = option(parsed, "access") ?? "read";
  if (value !== "read" && value !== "approval") {
    throw new Error("Option --access must be read or approval");
  }
  return value;
}

function integerOption(parsed: ParsedArguments, name: string, fallback: number, maximum = 65_535): number {
  const value = option(parsed, name);
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) throw new Error(`Option --${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw new Error(`Option --${name} must be between 0 and ${maximum}`);
  }
  return number;
}

function output(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return `Driftglass experimental portable runtime

Usage:
  driftglass-selfhost init [--data-dir ABS] [--migrations-dir ABS]
  driftglass-selfhost serve [--data-dir ABS] [--assets-dir ABS] [--host 127.0.0.1] [--port 8787]
  driftglass-selfhost backup create [--data-dir ABS] [--destination ABS]
  driftglass-selfhost backup verify --source ABS
  driftglass-selfhost restore --source ABS [--data-dir ABS]
  driftglass-selfhost doctor [--data-dir ABS] [--origin http://127.0.0.1:8787]
  driftglass-selfhost connect [--data-dir ABS] [--origin http://127.0.0.1:8787] [--access read|approval]

All commands accept --profile selfhost. The service binds to numeric loopback
only in this preview; use an authenticated local client or a separately
configured secure tunnel rather than exposing this HTTP process directly.
`;
}

async function initialize(parsed: ParsedArguments): Promise<void> {
  allowedOptions(parsed, ["profile", "data-dir", "migrations-dir"]);
  profile(parsed);
  const dataDirectory = absoluteOption(parsed, "data-dir", defaultLocalDataDirectory());
  const migrationsDirectory = absoluteOption(parsed, "migrations-dir", DEFAULT_MIGRATIONS_DIRECTORY);
  const layout = createLocalDataLayout(dataDirectory);
  const lease = acquireLocalRuntimeLease(layout, "init");
  try {
    const initialized = await initializeFreshLocalAuthority(layout, migrationsDirectory);
    output({
      ok: true,
      command: "init",
      profile: "selfhost",
      experimental: true,
      parityReady: false,
      dataDirectory: layout.root,
      databasePath: initialized.databasePath,
      receiptPath: initialized.receiptPath,
      ownerSecretPath: initialized.ownerSecretPath,
      receiptSha256: initialized.authority.receipt.receiptSha256,
      next: { command: "serve", arguments: ["--data-dir", layout.root] },
    });
  } finally {
    lease.release();
  }
}

async function serve(parsed: ParsedArguments): Promise<void> {
  allowedOptions(parsed, [
    "profile", "data-dir", "assets-dir", "host", "port",
    "queue-poll-ms", "queue-lease-ms", "scheduler-poll-ms", "scheduler-lease-ms", "memory-poll-ms",
  ]);
  profile(parsed);
  if (process.env.npm_lifecycle_event) {
    throw new Error(
      "Run the long-lived service directly with `node dist/selfhost/driftglass-selfhost.mjs serve ...` so Ctrl-C reaches its graceful shutdown handler",
    );
  }
  const dataDirectory = absoluteOption(parsed, "data-dir", defaultLocalDataDirectory());
  const assetsDirectory = absoluteOption(parsed, "assets-dir", DEFAULT_ASSETS_DIRECTORY);
  const host = option(parsed, "host") ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("The experimental CLI intentionally permits only 127.0.0.1 or ::1 loopback binds");
  }
  const started = await startExperimentalSelfhost({
    dataDirectory,
    assetsDirectory,
    host,
    port: integerOption(parsed, "port", 8787),
    queuePollMs: integerOption(parsed, "queue-poll-ms", 250),
    queueLeaseMs: integerOption(parsed, "queue-lease-ms", 30_000),
    schedulerPollMs: integerOption(parsed, "scheduler-poll-ms", 30_000),
    schedulerLeaseMs: integerOption(parsed, "scheduler-lease-ms", 300_000, 1_800_000),
    memoryPollMs: integerOption(parsed, "memory-poll-ms", 30_000, 300_000),
    logger(event) {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    },
  });
  output({
    ok: true,
    command: "serve",
    profile: "selfhost",
    experimental: true,
    parityReady: false,
    origin: started.server.origin,
    ownerSecretPath: join(started.layout.runtimeDirectory, "owner-secret"),
    receiptSha256: started.authority.receipt.receiptSha256,
    blockers: [
      "Restart testing across macOS, Linux, Windows, and NAS/VPS installs",
      "Resuming Missions and routines after an interrupted step",
      "Opening pages that need a full browser",
      "Moving a library between Cloudflare and your machine",
      "Public sharing and secure access from another device",
      "Broader compatibility checks for ChatGPT, Claude, and local model clients",
    ],
  });

  let shutdown: Promise<void> | null = null;
  const stop = (signal: NodeJS.Signals): void => {
    if (shutdown) return;
    shutdown = (async () => {
      const result = await started.close();
      output({ ok: result.status === "clean", command: "shutdown", signal, ...result });
      if (result.status !== "clean") process.exitCode = 1;
    })().catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({ level: "error", event: "shutdown_failed", message: errorMessage(error) })}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGHUP", () => stop("SIGHUP"));
}

function defaultBackupDestination(layout: ReturnType<typeof createLocalDataLayout>): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(layout.backupDirectory, `driftglass-${timestamp}`);
}

async function backup(parsed: ParsedArguments): Promise<void> {
  const action = parsed.positionals[1];
  if (action === "create") {
    allowedOptions(parsed, ["profile", "data-dir", "destination"]);
    profile(parsed);
    const layout = createLocalDataLayout(absoluteOption(parsed, "data-dir", defaultLocalDataDirectory()));
    const destination = absoluteOption(parsed, "destination", defaultBackupDestination(layout));
    const result = await createLocalBackup(layout, destination);
    output({
      ok: true,
      command: "backup create",
      directory: result.directory,
      manifestSha256: result.manifestSha256,
      files: result.manifest.files.length,
      bytes: result.bytes,
      sourceReceiptSha256: result.manifest.sourceAuthority.receiptSha256,
    });
    return;
  }
  if (action === "verify") {
    allowedOptions(parsed, ["profile", "source"]);
    profile(parsed);
    const result = await verifyLocalBackup(absoluteOption(parsed, "source"));
    output({
      ok: true,
      command: "backup verify",
      directory: result.directory,
      manifestSha256: result.manifestSha256,
      files: result.manifest.files.length,
      bytes: result.bytes,
    });
    return;
  }
  throw new Error("backup requires the create or verify subcommand");
}

async function restore(parsed: ParsedArguments): Promise<void> {
  allowedOptions(parsed, ["profile", "source", "data-dir"]);
  profile(parsed);
  const source = absoluteOption(parsed, "source");
  const dataDirectory = absoluteOption(parsed, "data-dir", defaultLocalDataDirectory());
  const result = await restoreLocalBackup(source, dataDirectory);
  output({
    ok: true,
    command: "restore",
    profile: "selfhost",
    experimental: true,
    parityReady: false,
    dataDirectory: result.layout.root,
    sourceManifestSha256: result.manifestSha256,
    sourceReceiptSha256: result.manifest.sourceAuthority.receiptSha256,
    receiptSha256: result.authority.authority.receipt.receiptSha256,
    targetInstanceId: result.authority.authority.receipt.targetInstanceId,
    ownerSecretPath: result.authority.ownerSecretPath,
  });
}

async function doctor(parsed: ParsedArguments): Promise<void> {
  allowedOptions(parsed, ["profile", "data-dir", "origin"]);
  profile(parsed);
  const layout = createLocalDataLayout(absoluteOption(parsed, "data-dir", defaultLocalDataDirectory()));
  const verified = await loadVerifiedLocalAuthority(layout);
  const origin = localOrigin(parsed);
  let service: Record<string, unknown>;
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3_000) });
    const health = response.ok ? await response.json().catch(() => null) as Record<string, unknown> | null : null;
    service = health?.ok === true && health.profile === "selfhost"
      ? { ready: true, origin, schemaVersion: health.schemaVersion }
      : { ready: false, origin, next: "Start Driftglass serve, then run doctor again." };
  } catch {
    service = { ready: false, origin, next: "Start Driftglass serve, then run doctor again." };
  }
  const command = process.execPath;
  const baseArguments = [SELFHOST_EXECUTABLE, "connect", "--data-dir", layout.root, "--origin", origin];
  const chatgptWeb = buildChatGptTunnelSetup({
    targetInstanceId: verified.authority.receipt.targetInstanceId,
    bridge: { command, args: baseArguments },
    shell: process.platform === "win32" ? "powershell" : "posix",
  });
  output({
    ok: true,
    command: "doctor",
    profile: "selfhost",
    experimental: true,
    parityReady: false,
    dataDirectory: layout.root,
    databasePath: layout.databasePath,
    ownerSecretPath: verified.ownerSecretPath,
    receiptSha256: verified.authority.receipt.receiptSha256,
    targetInstanceId: verified.authority.receipt.targetInstanceId,
    schemaVersion: verified.authority.receipt.schemaVersion,
    migrationHead: verified.authority.receipt.migrationHead,
    service,
    reasoningConnections: {
      read: {
        purpose: "Read current Missions, Stories, and evidence",
        command,
        args: [...baseArguments, "--access", "read"],
      },
      approval: {
        purpose: "Save and review answers against fixed evidence snapshots",
        command,
        args: [...baseArguments, "--access", "approval"],
      },
    },
    chatgptWeb,
  });
}

async function connect(parsed: ParsedArguments): Promise<void> {
  allowedOptions(parsed, ["profile", "data-dir", "origin", "access"]);
  profile(parsed);
  const layout = createLocalDataLayout(absoluteOption(parsed, "data-dir", defaultLocalDataDirectory()));
  const authority = await loadVerifiedLocalAuthority(layout);
  await runLocalStdioMcpBridge({
    origin: localOrigin(parsed),
    access: localMcpAccess(parsed),
    authority,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const command = parsed.positionals[0];
  if (!command || command === "help") {
    process.stdout.write(usage());
    return;
  }
  if (command === "init" && parsed.positionals.length === 1) return initialize(parsed);
  if (command === "serve" && parsed.positionals.length === 1) return serve(parsed);
  if (command === "backup" && parsed.positionals.length === 2) return backup(parsed);
  if (command === "restore" && parsed.positionals.length === 1) return restore(parsed);
  if (command === "doctor" && parsed.positionals.length === 1) return doctor(parsed);
  if (command === "connect" && parsed.positionals.length === 1) return connect(parsed);
  throw new Error(`Unknown command shape: ${parsed.positionals.join(" ")}`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: errorMessage(error) })}\n`);
  process.exitCode = 1;
});
