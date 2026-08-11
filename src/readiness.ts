import {
  getSetting,
  ingestDurabilityDatabaseHealth,
  latestBriefing,
  listCollectorHealth,
  listInboxReceipts,
  listIntelligencePacks,
  listMissions,
  listResearchResultImports,
  listSources,
} from "./db";
import { aiSearchStatus } from "./ai-search";
import { budgetStatus } from "./budget";
import { memoryGraphHealth } from "./memory-graph";
import { ingestQueueDurabilityHealth } from "./queue-health";
import { quarantineRecoveryHealth } from "./quarantine-recovery";
import { trackedSourceOutboxHealth } from "./source-ingest-outbox";
import { baseUrlFor, deriveMcpCapabilityKeys } from "./security";
import { openAlexAccessStatus } from "./sources/openalex";
import type { Env } from "./types";
import { parseJson } from "./utils";

export function orphanedPendingRunReadinessReasons(count: number): string[] {
  if (count <= 0) return [];
  return [`${count} built-in source run${count === 1 ? " has" : "s have"} pending status but no durable handoff`];
}

export async function buildReadiness(env: Env, request: Request): Promise<Record<string, unknown>> {
  const [
    schemaVersion,
    sources,
    missions,
    briefing,
    collectors,
    receipts,
    pendingResearch,
    semanticMemory,
    graph,
    budget,
    packs,
    ingestQueues,
    ingestDatabase,
    producerOutbox,
    quarantineRecovery,
  ] = await Promise.all([
    getSetting(env.DB, "schema_version"),
    listSources(env.DB),
    listMissions(env.DB),
    latestBriefing(env.DB),
    listCollectorHealth(env.DB),
    listInboxReceipts(env.DB, 1),
    listResearchResultImports(env.DB, { status: "pending", limit: 10 }),
    aiSearchStatus(env),
    memoryGraphHealth(env),
    budgetStatus(env.DB),
    listIntelligencePacks(env.DB),
    ingestQueueDurabilityHealth(env),
    ingestDurabilityDatabaseHealth(env.DB),
    trackedSourceOutboxHealth(env.DB),
    quarantineRecoveryHealth(env),
  ]);
  const { readKey, operationsKey } = await deriveMcpCapabilityKeys(env.DRIFTGLASS_SECRET);
  const base = baseUrlFor(request, env.PUBLIC_BASE_URL);
  const enabledSources = sources.filter((source) => source.enabled);
  const configuredCloudSources = enabledSources.filter((source) => source.kind !== "collector");
  const companionSources = enabledSources.filter((source) => source.kind === "collector");
  const openAlexSources = enabledSources.filter((source) => source.kind === "openalex");
  let openAlexDeferred = 0;
  let openAlexInvalid = 0;
  for (const source of openAlexSources) {
    try {
      if (!openAlexAccessStatus(parseJson<Record<string, unknown>>(source.config_json, {}), env.OPENALEX_API_KEY).runnable) {
        openAlexDeferred += 1;
      }
    } catch {
      openAlexInvalid += 1;
    }
  }
  const runnableCloudSources = configuredCloudSources.filter((source) => {
    if (source.kind !== "openalex") return true;
    try {
      return openAlexAccessStatus(parseJson<Record<string, unknown>>(source.config_json, {}), env.OPENALEX_API_KEY).runnable;
    } catch {
      return false;
    }
  });
  const runnableSourceCount = runnableCloudSources.length + companionSources.length;
  const onlineCollectors = collectors.filter((collector) => collector.status === "online");
  const graphStats = graph.stats as Record<string, number>;
  const graphNodes = Number(graphStats?.nodes ?? 0);
  const maxBudgetUtilization = Math.max(0, ...Object.values(budget.utilization).map(Number));
  const ingestBlockingReasons = [
    ...ingestQueues.blockingReasons,
    ...(ingestDatabase.staleTrackedRuns > 0
      ? [`${ingestDatabase.staleTrackedRuns} tracked source run${ingestDatabase.staleTrackedRuns === 1 ? " is" : "s are"} stale before terminal ingestion`]
      : []),
    ...orphanedPendingRunReadinessReasons(ingestDatabase.orphanedPendingRuns),
    ...(ingestDatabase.unresolvedDeadLetters > 0
      ? [`${ingestDatabase.unresolvedDeadLetters} recoverable untracked dead letter${ingestDatabase.unresolvedDeadLetters === 1 ? " needs" : "s need"} owner action`]
      : []),
    ...(producerOutbox.activeRuns > 0
      ? [`${producerOutbox.activeRuns} built-in source producer outbox run${producerOutbox.activeRuns === 1 ? " is" : "s are"} awaiting a complete Queue handoff (${producerOutbox.messageCount} messages)`]
      : []),
    ...(producerOutbox.abandonedRuns > 0
      ? [`${producerOutbox.abandonedRuns} abandoned producer outbox run${producerOutbox.abandonedRuns === 1 ? " needs" : "s need"} bounded raw-object cleanup`]
      : []),
    ...(!quarantineRecovery.available
      ? ["Private R2 quarantine recovery status is unavailable"]
      : Number(quarantineRecovery.incidentCount ?? 0) > 0
        ? ["Private R2 quarantine recovery incident needs owner action"]
        : []),
  ];
  const checks = [
    { id: "schema", label: "Database schema", status: Number(schemaVersion ?? 0) >= 12 ? "ready" : "attention", detail: `schema ${schemaVersion ?? "unknown"}` },
    {
      id: "sources",
      label: "Intelligence sources",
      status: runnableSourceCount ? "ready" : "attention",
      detail: `${runnableSourceCount} runnable · ${enabledSources.length} enabled`,
    },
    {
      id: "cloud-coverage",
      label: "Cloud-only coverage",
      status: runnableCloudSources.length ? "ready" : "attention",
      detail: `${runnableCloudSources.length} runnable cloud sources · ${configuredCloudSources.length} configured · ${companionSources.length} optional Companion sources`,
    },
    {
      id: "openalex-access",
      label: "OpenAlex research access",
      status: openAlexInvalid > 0 || openAlexDeferred > 0 ? "attention" : openAlexSources.length > 0 ? "ready" : "optional",
      detail: openAlexInvalid > 0
        ? `${openAlexInvalid} OpenAlex source configuration${openAlexInvalid === 1 ? " is" : "s are"} invalid; credentials belong only in the OPENALEX_API_KEY Worker secret`
        : openAlexDeferred > 0
          ? `${openAlexDeferred} OpenAlex source${openAlexDeferred === 1 ? " is" : "s are"} deferred; OpenAlex requires a key for every request, available through the optional free OPENALEX_API_KEY Worker secret`
          : openAlexSources.length > 0
            ? `${openAlexSources.length} source${openAlexSources.length === 1 ? "" : "s"} ready · authenticated OpenAlex access`
            : "optional · every OpenAlex API request requires OPENALEX_API_KEY; direct Work-ID lookups are zero-cost but authenticated",
    },
    { id: "mission", label: "Research Mission", status: missions.some((mission) => mission.status === "active") ? "ready" : "optional", detail: `${missions.filter((mission) => mission.status === "active").length} active` },
    { id: "briefing", label: "First briefing", status: briefing ? "ready" : "attention", detail: briefing ? briefing.created_at : "not generated" },
    { id: "memory", label: "Connected memory", status: graphNodes > 0 ? "ready" : "attention", detail: `${graphNodes} nodes · ${Number(graphStats?.edges ?? 0)} edges${graph.dirty ? " · refresh pending" : ""}` },
    { id: "packs", label: "Intelligence Packs", status: packs.length ? "ready" : "optional", detail: `${packs.length} installed · Pack v3 and Lens v1 supported` },
    {
      id: "budget",
      label: "Budget Governor",
      status: budget.degraded.length ? "attention" : "ready",
      detail: `${budget.profile} envelope · ${budget.executionCapacity === "expanded-confirmed" ? "higher Worker limits confirmed" : "Workers Free limits"} · ${Math.round(maxBudgetUtilization * 100)}% highest lane${budget.degraded.length ? ` · constrained: ${budget.degraded.join(", ")}` : ""}`,
    },
    {
      id: "ingest-durability",
      label: "Source collection",
      status: ingestBlockingReasons.length ? "attention" : "ready",
      detail: ingestBlockingReasons.length
        ? ingestBlockingReasons.join(" · ")
        : `primary ${ingestQueues.primary.backlogCount ?? 0} · DLQ 0 · quarantine 0 · R2 fallback 0 · producer bodies ${producerOutbox.retainedMessages} retained (${producerOutbox.awaitingReceiptMessages} held while runs await terminal accounting, ${producerOutbox.terminalGcRuns} pending GC) · no stale or orphaned tracked runs`,
    },
    { id: "browser", label: "Web reading", status: env.BROWSER ? "ready" : "attention", detail: env.BROWSER ? "direct → Kitesurf → Chromium" : "BROWSER binding missing" },
    { id: "workflow", label: "Mission Workflows", status: env.MISSION_WORKFLOW ? "ready" : "optional", detail: env.MISSION_WORKFLOW ? "binding configured" : "manual Sprints only" },
    { id: "computer", label: "Mission Computers", status: env.MISSION_COMPUTER ? "ready" : "attention", detail: env.MISSION_COMPUTER ? "durable workspace binding configured" : "MISSION_COMPUTER binding missing" },
    {
      id: "reasoning",
      label: "Model connections",
      status: "ready",
      detail: "read-only Research MCP · separate Updates MCP",
    },
    {
      id: "ai-search",
      label: "Optional semantic retrieval",
      status: semanticMemory.enabled && semanticMemory.configured ? "ready" : semanticMemory.enabled ? "attention" : "optional",
      detail: semanticMemory.enabled && semanticMemory.configured
        ? `AI Search · ${semanticMemory.lastSyncAt ? `synced ${semanticMemory.lastSyncAt}` : "ready to sync"}`
        : semanticMemory.enabled
          ? semanticMemory.error || "enabled but not configured"
          : semanticMemory.available ? "disabled · enable explicitly when needed" : semanticMemory.error || "binding unavailable",
    },
    { id: "companion", label: "Signed-in Companion", status: onlineCollectors.length ? "ready" : "optional", detail: onlineCollectors.length ? `${onlineCollectors.length} online` : `optional · cloud core has ${runnableCloudSources.length} runnable sources` },
    { id: "email", label: "Email intake", status: receipts.length ? "ready" : "optional", detail: receipts.length ? "message received" : "not yet exercised" },
    { id: "research", label: "Research result inbox", status: pendingResearch.length ? "attention" : "ready", detail: `${pendingResearch.length} pending approval` },
  ];
  const requiredIds = new Set(["schema", "sources", "cloud-coverage", "briefing", "memory", "budget", "ingest-durability", "browser", "computer", "reasoning"]);
  const required = checks.filter((check) => requiredIds.has(check.id));
  const score = Math.round(required.filter((check) => check.status === "ready").length / required.length * 100);
  return {
    ok: true,
    score,
    checks,
    releaseBlocked: ingestBlockingReasons.length > 0,
    blockingChecks: ingestBlockingReasons.length ? ["ingest-durability"] : [],
    operatingMode: {
      cloudOnlyReady: runnableCloudSources.length > 0,
      companionRequired: false,
      companionEnhancementAvailable: companionSources.length > 0 || onlineCollectors.length > 0,
      budgetProfile: budget.profile,
      executionCapacity: budget.executionCapacity,
      memoryGraph: { nodes: graphNodes, edges: Number(graphStats?.edges ?? 0), dirty: Boolean(graph.dirty) },
    },
    ingestDurability: {
      queues: ingestQueues,
      database: ingestDatabase,
      producerOutbox,
      quarantineRecovery,
    },
    urls: {
      packet: `${base}/packet/${readKey}/latest.md`,
      pulse: `${base}/packet/${readKey}/pulse.md`,
      memory: `${base}/packet/${readKey}/memory.md`,
      chatgpt: `${base}/packet/${readKey}/reasoning/chatgpt.md`,
      claude: `${base}/packet/${readKey}/reasoning/claude.md`,
      grok: `${base}/packet/${readKey}/reasoning/grok.md`,
      mcp: `${base}/mcp/${readKey}`,
      operationsMcp: `${base}/mcp/${operationsKey}/ops`,
      corpus: `${base}/corpus/${readKey}/index.html`,
      semanticMemory: `${base}/api/ai-search/status`,
    },
  };
}
