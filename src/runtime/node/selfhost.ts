import { resolve } from "node:path";

import { handleApi } from "../../api";
import { handleCollectorRequest } from "../../collectors";
import { handleCorpus } from "../../corpus";
import { handleDiscoveryRoute } from "../../discovery-routes";
import { handleFeedbackLink, handlePacket } from "../../public-routes";
import { authorizeMcpPath, requireAdmin } from "../../security";
import { ensureSchema } from "../../schema";
import { handleMcp } from "../../mcp";
import { handlePublicShare } from "../../shares";
import type { Env, IngestMessage } from "../../types";
import { isoNow, json, readJson, setOutboundFetchImplementation, toErrorResponse, withSecurityHeaders } from "../../utils";
import type { RequestLifecycle } from "../../http/contracts";
import { NodeSQLiteDatabase } from "./database";
import { FileAssetAdapter } from "./http/assets";
import {
  startNodeHttpServer,
  type NodeHttpCloseResult,
  type NodeHttpLogger,
  type StartedNodeHttpServer,
} from "./http/server";
import { DurableIngestQueueRuntime } from "./durable-ingest-queue";
import { createLocalDataLayout, type LocalDataLayout } from "./layout";
import { LocalObjectStore } from "./object-store";
import { nodePublicFetch } from "./public-fetch";
import { acquireLocalRuntimeLease } from "./process-lock";
import { LocalMemoryRefresher } from "./local-memory";
import { LocalMissionWorkspacePort } from "./workspace";
import { LocalSourceScheduler } from "./source-scheduler";
import { LocalScheduledIntelligence } from "./scheduled-intelligence";
import { buildChatGptTunnelSetup } from "./chatgpt-tunnel";
import {
  loadVerifiedLocalAuthority,
  type VerifiedLocalAuthority,
} from "./authority";

export interface ExperimentalSelfhostOptions {
  readonly dataDirectory: string;
  readonly assetsDirectory: string;
  readonly host?: string;
  readonly port?: number;
  readonly origin?: string;
  readonly allowedHosts?: readonly string[];
  readonly unsafeAllowNonLoopback?: boolean;
  readonly logger?: NodeHttpLogger;
  readonly queuePollMs?: number;
  readonly queueLeaseMs?: number;
  readonly schedulerPollMs?: number;
  readonly schedulerLeaseMs?: number;
  readonly memoryPollMs?: number;
}

export interface StartedExperimentalSelfhost {
  readonly profile: "selfhost";
  readonly experimental: true;
  readonly parityReady: false;
  readonly layout: LocalDataLayout;
  readonly authority: VerifiedLocalAuthority["authority"];
  readonly server: StartedNodeHttpServer;
  readonly ownerSecret: string;
  close(): Promise<NodeHttpCloseResult>;
}

const UNAVAILABLE_LOCAL_OPERATIONS_MCP_TOOLS: ReadonlyMap<string, string> = new Map([
  ["semantic_search", "Cloudflare AI Search is unavailable; use exact Story search"],
  ["sync_semantic_memory", "Cloudflare AI Search is unavailable"],
  ["inspect_public_page", "the local browser fallback ladder is unavailable; direct URL capture remains available in the dashboard/API"],
  ["run_mission_sprint", "replay-safe local Mission Workflows are unavailable"],
  ["run_intelligence_routine", "replay-safe local Intelligence Routine Workflows are unavailable"],
]);

interface McpJsonRpcRequest {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: { readonly name?: string };
}

async function inspectMcpRequest(request: Request): Promise<McpJsonRpcRequest | null> {
  if (request.method !== "POST" || !request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return null;
  }
  try {
    const value = await request.clone().json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as McpJsonRpcRequest;
  } catch {
    return null;
  }
}

function unavailableMcpToolResponse(id: McpJsonRpcRequest["id"], name: string, reason: string): Response {
  const payload = {
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      isError: true,
      content: [{ type: "text", text: `${name} is unavailable in the experimental self-host profile: ${reason}.` }],
    },
  };
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "access-control-allow-origin": "*",
    },
  });
}

async function filterUnavailableMcpTools(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const body = await response.text();
  const filtered = body.split("\n").map((line) => {
    if (!line.startsWith("data: ")) return line;
    try {
      const payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
      const result = payload.result as Record<string, unknown> | undefined;
      if (!result || !Array.isArray(result.tools)) return line;
      const tools = result.tools.filter((tool) => {
        if (!tool || typeof tool !== "object") return true;
        return !UNAVAILABLE_LOCAL_OPERATIONS_MCP_TOOLS.has(String((tool as Record<string, unknown>).name ?? ""));
      });
      return `data: ${JSON.stringify({ ...payload, result: { ...result, tools } })}`;
    } catch {
      return line;
    }
  }).join("\n");
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(filtered, { status: response.status, statusText: response.statusText, headers });
}

class LocalR2CompatibilityBucket {
  readonly #store: LocalObjectStore;

  constructor(store: LocalObjectStore) {
    this.#store = store;
  }

  async put(key: string, input: unknown, options: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
    let body = input;
    if (input instanceof Blob) body = new Uint8Array(await input.arrayBuffer());
    const result = await this.#store.put(
      key,
      body as Parameters<LocalObjectStore["put"]>[1],
      options as Parameters<LocalObjectStore["put"]>[2],
    );
    if (!result.stored) return null;
    return await this.#store.head(key) as unknown as Record<string, unknown>;
  }

  get(key: string): ReturnType<LocalObjectStore["get"]> {
    return this.#store.get(key);
  }

  head(key: string): ReturnType<LocalObjectStore["head"]> {
    return this.#store.head(key);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) await this.#store.delete(key);
  }

  list(options?: Parameters<LocalObjectStore["list"]>[0]): ReturnType<LocalObjectStore["list"]> {
    return this.#store.list(options);
  }
}

function executionContext(lifecycle: RequestLifecycle): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>): void {
      lifecycle.waitUntil(promise);
    },
    passThroughOnException(): void {
      // Node owns the response; there is no upstream Worker to pass through to.
    },
    props: {},
    exports: {},
  } as unknown as ExecutionContext;
}

function localCapabilities(): Array<Record<string, unknown>> {
  return [
    { runtime: "worker", mode: "node-loopback", bestFor: ["dashboard", "API", "direct HTTP", "normalization"], localRequired: true, available: true },
    { runtime: "queue", mode: "sqlite-leased", bestFor: ["reliable capture", "source collection", "safe restart"], localRequired: true, available: true, parityReady: false },
    { runtime: "mcp", mode: "streamable-http", bestFor: ["local reasoning clients", "exact evidence reads", "explicit operations"], localRequired: true, available: true },
    { runtime: "mcp-stdio", mode: "loopback-bridge", bestFor: ["Claude Desktop", "Codex", "local reasoning clients"], localRequired: true, available: true, parityReady: false },
    { runtime: "backup", mode: "checksummed-operational", bestFor: ["same-runtime disaster recovery", "clean-target restore"], localRequired: true, available: true },
    { runtime: "memory", mode: "sqlite-deterministic", bestFor: ["connected Story memory", "Mission recall", "safe restart"], localRequired: true, available: true, parityReady: false },
    { runtime: "public-sharing", mode: "loopback-not-publishable", bestFor: ["remote briefing links", "live intelligence cards"], localRequired: false, available: false },
    { runtime: "email", mode: "unconfigured", bestFor: ["newsletter intake", "mailbox delivery"], localRequired: false, available: false },
    { runtime: "companion", mode: "unconfigured", bestFor: ["signed-in collection"], localRequired: false, available: false },
    { runtime: "semantic-search", mode: "unconfigured", bestFor: ["rebuildable concept retrieval"], localRequired: false, available: false },
    { runtime: "kitesurf", mode: "unconfigured", bestFor: ["JavaScript pages"], localRequired: false, available: false },
    { runtime: "chromium", mode: "unconfigured", bestFor: ["browser compatibility"], localRequired: false, available: false },
    { runtime: "computer", mode: "local-filesystem-only", bestFor: ["Mission files", "durable notes", "portable exports"], localRequired: true, available: true, parityReady: false },
    { runtime: "workflow", mode: "unconfigured-local-replay", bestFor: ["Mission Sprints", "Routines"], localRequired: true, available: false },
    { runtime: "scheduler", mode: "sqlite-leased", bestFor: ["automatic source checks", "Mission reminders", "daily evidence packets"], localRequired: true, available: true, parityReady: false },
  ];
}

function runtimeStatus(authority: VerifiedLocalAuthority["authority"]): Record<string, unknown> {
  return {
    ok: true,
    context: {
      profile: "selfhost",
      canonicalState: "local",
      experimental: true,
      parityReady: false,
      authority: {
        mode: authority.mode,
        schemaVersion: authority.receipt.schemaVersion,
        migrationHead: authority.receipt.migrationHead,
        verifiedAt: authority.receipt.verifiedAt,
        receiptSha256: authority.receipt.receiptSha256,
      },
      browserAvailable: false,
      companionOnline: false,
      computerAvailable: true,
      computerPowerAvailable: false,
      ingress: "loopback",
      ingest: "sqlite-leased",
    },
    capabilities: localCapabilities(),
    blockers: [
      "Restart testing across macOS, Linux, Windows, and NAS/VPS installs",
      "Resuming Missions and routines after an interrupted step",
      "Opening pages that need a full browser",
      "Moving a library between Cloudflare and your machine",
      "Public sharing and secure access from another device",
      "Broader compatibility checks for ChatGPT, Claude, and local model clients",
    ],
  };
}

function createLocalEnv(input: {
  database: NodeSQLiteDatabase;
  objects: LocalObjectStore;
  assets: FileAssetAdapter;
  ownerSecret: string;
  queues: DurableIngestQueueRuntime;
  workspace: LocalMissionWorkspacePort;
}): Env {
  const candidate = {
    DB: input.database,
    EVIDENCE: new LocalR2CompatibilityBucket(input.objects),
    ASSETS: input.assets,
    INGEST_QUEUE: input.queues.binding("primary"),
    INGEST_DLQ: input.queues.binding("dead-letter"),
    INGEST_QUARANTINE: input.queues.binding("quarantine"),
    INGEST_QUEUE_NAME: "driftglass-local-ingest",
    INGEST_DLQ_NAME: "driftglass-local-ingest-dlq",
    INGEST_QUARANTINE_NAME: "driftglass-local-ingest-quarantine",
    APP_NAME: "Driftglass Self-host (experimental)",
    DEFAULT_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    BRIEFING_LOCAL_HOUR: "7",
    MAX_DAILY_STORIES: "12",
    PUBLIC_BASE_URL: "",
    PUBLIC_INDEXING: "disabled",
    RAW_PUBLIC_RETENTION_DAYS: "30",
    DRIFTGLASS_SECRET: input.ownerSecret,
    RUNTIME_WORKSPACE: input.workspace,
    // Browser, Workflows, and AI Search remain absent. The
    // bundle boundary throws if a Cloudflare execution primitive is invoked.
  };
  return candidate as unknown as Env;
}

function secureResponse(response: Response, assets = false): Response {
  return withSecurityHeaders(response, { assets, noIndex: true });
}

function createProductHandler(
  env: Env,
  authority: VerifiedLocalAuthority["authority"],
  localConnection: { readonly dataDirectory: string; readonly executable: string },
  memory: LocalMemoryRefresher,
): (request: Request, lifecycle: RequestLifecycle) => Promise<Response> {
  return async (request, lifecycle) => {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health") {
        const schemaVersion = await ensureSchema(env.DB);
        return secureResponse(json({
          ok: true,
          app: env.APP_NAME,
          version: "0.9.0",
          profile: "selfhost",
          experimental: true,
          schemaVersion,
          now: isoNow(),
        }));
      }
      if (path === "/ready") {
        await ensureSchema(env.DB);
        return secureResponse(json({
          ok: true,
          status: "experimental-ready",
          profile: "selfhost",
          canonicalState: "local",
          writableAuthorityVerified: true,
          parityReady: false,
          schemaVersion: authority.receipt.schemaVersion,
          blockers: runtimeStatus(authority).blockers,
        }));
      }

      if (path === "/api/runtime" && request.method === "GET") {
        await ensureSchema(env.DB);
        await requireAdmin(request, env.DRIFTGLASS_SECRET);
        return secureResponse(json(runtimeStatus(authority)));
      }

      if (path === "/api/reasoning/providers" && request.method === "GET") {
        await ensureSchema(env.DB);
        await requireAdmin(request, env.DRIFTGLASS_SECRET);
        const origin = new URL(request.url).origin;
        const bridge = {
          command: process.execPath,
          args: [
            localConnection.executable,
            "connect",
            "--data-dir",
            localConnection.dataDirectory,
            "--origin",
            origin,
          ],
        };
        const clientEntry = (name: string, access: "read" | "approval"): string => JSON.stringify({
          mcpServers: {
            [name]: {
              command: bridge.command,
              args: [...bridge.args, "--access", access],
            },
          },
        }, null, 2);
        return secureResponse(json({
          ok: true,
          profile: "selfhost",
          localConnections: {
            read: clientEntry("driftglass", "read"),
            approval: clientEntry("driftglass-approval", "approval"),
          },
          chatgptWeb: buildChatGptTunnelSetup({
            targetInstanceId: authority.receipt.targetInstanceId,
            bridge,
            shell: process.platform === "win32" ? "powershell" : "posix",
          }),
          providers: {},
        }));
      }

      if (path === "/api/readiness" && request.method === "GET") {
        await ensureSchema(env.DB);
        const response = await handleApi(request, env, executionContext(lifecycle));
        if (!response.ok) return secureResponse(response);
        const payload = await response.json() as Record<string, unknown>;
        const checks = Array.isArray(payload.checks)
          ? payload.checks.map((check) => {
            if (!check || typeof check !== "object" || (check as Record<string, unknown>).id !== "computer") return check;
            return {
              ...(check as Record<string, unknown>),
              status: "ready",
              detail: "private local Mission directories are available; command execution remains disabled",
            };
          })
          : [];
        const blockingChecks = new Set(Array.isArray(payload.blockingChecks) ? payload.blockingChecks : []);
        blockingChecks.delete("computer");
        const ingestDurability = payload.ingestDurability && typeof payload.ingestDurability === "object"
          ? payload.ingestDurability as Record<string, unknown>
          : {};
        const queueStatus = ingestDurability.queues && typeof ingestDurability.queues === "object"
          ? ingestDurability.queues as Record<string, unknown>
          : {};
        return secureResponse(json({
          ...payload,
          checks,
          releaseBlocked: true,
          blockingChecks: [...blockingChecks],
          runtimeProfile: {
            profile: "selfhost",
            experimental: true,
            parityReady: false,
          },
          ingestDurability: {
            ...ingestDurability,
            queues: {
              ...queueStatus,
              mode: "sqlite-leased-ingress",
              restartSafe: true,
              parityReady: false,
              releaseBlocked: Boolean(queueStatus.releaseBlocked),
              blockingReasons: Array.isArray(queueStatus.blockingReasons) ? queueStatus.blockingReasons : [],
            },
          },
        }));
      }

      if (path === "/api/memory/refresh" && request.method === "POST") {
        await ensureSchema(env.DB);
        await requireAdmin(request, env.DRIFTGLASS_SECRET);
        const body: { force?: boolean; maxStories?: number } = await readJson<{ force?: boolean; maxStories?: number }>(request).catch(() => ({}));
        const result = await memory.refresh({ force: Boolean(body.force), maxStories: body.maxStories });
        return secureResponse(json({ ok: true, result }, {
          status: result.status === "queued" || result.status === "running" ? 202 : 200,
        }));
      }

      if (
        path.startsWith("/api/")
        || path.startsWith("/collector/")
        || path.startsWith("/packet/")
        || path.startsWith("/corpus/")
        || path.startsWith("/mcp/")
        || path.startsWith("/feedback/")
        || path.startsWith("/share/")
      ) {
        await ensureSchema(env.DB);
      }

      const discovery = handleDiscoveryRoute(request, false);
      if (discovery) return secureResponse(discovery);
      const ctx = executionContext(lifecycle);
      if (path.startsWith("/api/")) return secureResponse(await handleApi(request, env, ctx));
      if (path.startsWith("/collector/")) return secureResponse(await handleCollectorRequest(request, env));
      if (path.startsWith("/packet/")) return secureResponse(await handlePacket(request, env));
      if (path.startsWith("/corpus/")) return secureResponse(await handleCorpus(request, env));
      if (path.startsWith("/mcp/")) {
        const profile = await authorizeMcpPath(path, env.DRIFTGLASS_SECRET);
        const rpc = await inspectMcpRequest(request);
        if (profile === "operations" && rpc?.method === "tools/call") {
          const name = String(rpc.params?.name ?? "");
          const reason = UNAVAILABLE_LOCAL_OPERATIONS_MCP_TOOLS.get(name);
          if (reason) return secureResponse(unavailableMcpToolResponse(rpc.id, name, reason));
        }
        const response = await handleMcp(request, env, ctx);
        if (profile === "operations" && rpc?.method === "tools/list") {
          return secureResponse(await filterUnavailableMcpTools(response));
        }
        return secureResponse(response);
      }
      if (path.startsWith("/feedback/")) return secureResponse(await handleFeedbackLink(request, env));
      if (path.startsWith("/share/")) return secureResponse(await handlePublicShare(request, env));
      return secureResponse(await env.ASSETS.fetch(request), true);
    } catch (error) {
      return secureResponse(toErrorResponse(error));
    }
  };
}

/** Start the explicit experimental local profile after authority re-verification. */
export async function startExperimentalSelfhost(
  options: ExperimentalSelfhostOptions,
): Promise<StartedExperimentalSelfhost> {
  const layout = createLocalDataLayout(resolve(options.dataDirectory));
  const authority = await loadVerifiedLocalAuthority(layout);
  // No writable adapter exists before the verifier above has succeeded.
  const lease = acquireLocalRuntimeLease(layout, "serve");
  let database: NodeSQLiteDatabase | undefined;
  let server: StartedNodeHttpServer;
  let queues: DurableIngestQueueRuntime | undefined;
  let scheduler: LocalSourceScheduler | undefined;
  let scheduledIntelligence: LocalScheduledIntelligence | undefined;
  let memory: LocalMemoryRefresher | undefined;
  let restoreOutboundFetch: (() => void) | undefined;
  try {
    restoreOutboundFetch = setOutboundFetchImplementation(nodePublicFetch);
    database = new NodeSQLiteDatabase(layout.databasePath);
    const objects = new LocalObjectStore(layout.objectStoreDirectory);
    const workspace = new LocalMissionWorkspacePort(layout.missionWorkspaceDirectory, {
      profile: "selfhost",
      canonicalState: "local",
      schemaVersion: authority.authority.receipt.schemaVersion,
      migrationHead: authority.authority.receipt.migrationHead,
    });
    const assets = new FileAssetAdapter({
      root: resolve(options.assetsDirectory),
      trustedAssetRoot: true,
    });
    let env: Env;
    const runtimeLogger = options.logger
      ? (event: Readonly<Record<string, unknown>>): void => {
        (options.logger as unknown as (value: Readonly<Record<string, unknown>>) => void)(event);
      }
      : undefined;
    queues = new DurableIngestQueueRuntime(database, () => env, {
      pollMs: options.queuePollMs,
      leaseMs: options.queueLeaseMs,
      logger: runtimeLogger,
    });
    env = createLocalEnv({ database, objects, assets, ownerSecret: authority.ownerSecret, queues, workspace });
    memory = new LocalMemoryRefresher(() => env, {
      pollMs: options.memoryPollMs,
      logger: runtimeLogger,
    });
    scheduler = new LocalSourceScheduler(database, () => env, {
      pollMs: options.schedulerPollMs,
      leaseMs: options.schedulerLeaseMs,
      logger: runtimeLogger,
    });
    scheduledIntelligence = new LocalScheduledIntelligence(database, () => env, {
      pollMs: options.schedulerPollMs,
      leaseMs: options.schedulerLeaseMs,
      logger: runtimeLogger,
    });
    await queues.initialize();
    await memory.initialize();
    await scheduler.initialize();
    await scheduledIntelligence.initialize();
    server = await startNodeHttpServer(createProductHandler(env, authority.authority, {
      dataDirectory: layout.root,
      executable: resolve(process.argv[1] || "dist/selfhost/driftglass-selfhost.mjs"),
    }, memory), {
      host: options.host,
      port: options.port,
      origin: options.origin,
      allowedHosts: options.allowedHosts,
      unsafeAllowNonLoopback: options.unsafeAllowNonLoopback,
      logger: options.logger,
    });
    queues.start();
    memory.start();
    scheduler.start();
    scheduledIntelligence.start();
  } catch (error) {
    await scheduledIntelligence?.close().catch(() => undefined);
    await scheduler?.close().catch(() => undefined);
    await memory?.close().catch(() => undefined);
    await queues?.close().catch(() => undefined);
    restoreOutboundFetch?.();
    database?.close();
    lease.release();
    throw error;
  }
  const openedDatabase = database;
  if (!openedDatabase) {
    lease.release();
    throw new Error("Self-host database did not initialize");
  }

  let closing: Promise<NodeHttpCloseResult> | null = null;
  return Object.freeze({
    profile: "selfhost",
    experimental: true,
    parityReady: false,
    layout,
    authority: authority.authority,
    server,
    ownerSecret: authority.ownerSecret,
    close(): Promise<NodeHttpCloseResult> {
      if (closing) return closing;
      closing = (async () => {
        await scheduledIntelligence?.close();
        await scheduler?.close();
        await memory?.close();
        try {
          return await server.close();
        } finally {
          try {
            await queues?.close();
          } finally {
            try {
              restoreOutboundFetch?.();
              openedDatabase.close();
            } finally {
              lease.release();
            }
          }
        }
      })();
      return closing;
    },
  });
}
