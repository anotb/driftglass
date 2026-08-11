export { MissionComputer } from "./mission-computer";
export { MissionSprintWorkflow } from "./mission-workflow";
export { MemoryGraphWorkflow } from "./epistemic-memory";
export { IntelligenceRoutineWorkflow } from "./routine-workflow";
export { SourceRunBoundary } from "./source-run-boundary";
export { MissionMaintenanceBoundary } from "./mission-maintenance-boundary";
import { handleApi } from "./api";
import { syncAISearchIfEnabled } from "./ai-search";
import { generateBriefing } from "./briefing";
import { handleEmail } from "./email";
import { handleDiscoveryRoute } from "./discovery-routes";
import { handleCollectorRequest } from "./collectors";
import { handleCorpus } from "./corpus";
import {
  dueSources,
  expireResearchResultImports,
  latestBriefing,
  purgeExpiredPairingCodes,
  purgeExpiredPublicShares,
} from "./db";
import { handleIngestQueueBatch } from "./ingest-consumer";
import { refreshMissionReminders, startDueMissionSprints } from "./mission-autopilot";
import { refreshEpistemicMemoryIfDue } from "./epistemic-memory";
import { startDueIntelligenceRoutines } from "./intelligence-routines";
import { discoverReasoningTaskCandidate, materializeNextReasoningTask } from "./reasoning-tasks";
import { backfillEvidenceLineage } from "./evidence-lineage";
import { handleMcp } from "./mcp";
import { handleMcpOAuth } from "./mcp-oauth";
import { handleFeedbackLink, handlePacket } from "./public-routes";
import { handlePublicShare } from "./shares";
import { getBudgetProfile } from "./budget";
import {
  runScheduledLane,
  scheduledSourceConcurrency,
  scheduledSourceLimit,
} from "./scheduled-envelope";
import { ensureQueueSchema, ensureSchema } from "./schema";
import { drainTrackedSourceOutbox } from "./source-ingest-outbox";
import { runSource, sourceRuntimeAccess } from "./sources/registry";
import { runSourceWithBoundaryFallback, type SourceRunBoundaryClient } from "./source-run-boundary";
import type { Env, ExecutionCapacity, IngestMessage } from "./types";
import { isoNow, json, toErrorResponse, withSecurityHeaders } from "./utils";

interface ZonedClock {
  dateKey: string;
  hour: number;
}

function secureResponse(env: Env, response: Response, options: { assets?: boolean } = {}): Response {
  return withSecurityHeaders(response, {
    ...options,
    noIndex: env.PUBLIC_INDEXING !== "enabled",
  });
}

function zonedClock(date: Date, timeZone: string): ZonedClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    dateKey: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour") || 0),
  };
}

async function shouldGenerateDailyBriefing(env: Env, now: Date): Promise<boolean> {
  const timeZone = env.DEFAULT_TIMEZONE || "UTC";
  const targetHour = Math.max(0, Math.min(23, Number(env.BRIEFING_LOCAL_HOUR || 7)));
  const current = zonedClock(now, timeZone);
  if (current.hour !== targetHour) return false;
  const latest = await latestBriefing(env.DB);
  if (!latest) return true;
  return zonedClock(new Date(latest.created_at), timeZone).dateKey !== current.dateKey;
}

async function runScheduledSourceLane(
  env: Env,
  executionCapacity: ExecutionCapacity,
  sourceBoundary?: SourceRunBoundaryClient,
): Promise<void> {
  const invocationLimit = scheduledSourceLimit(executionCapacity);
  const concurrency = scheduledSourceConcurrency(executionCapacity);
  const sources = (await dueSources(env.DB, isoNow(), { deferOpenAlex: !env.OPENALEX_API_KEY?.trim() }))
    .filter((source) => sourceRuntimeAccess(source, env).runnable)
    .slice(0, invocationLimit);
  if (sources.length === 0) {
    await drainTrackedSourceOutbox(env, { maxBatches: 1 }).catch((error) => {
      console.error("Scheduled tracked source outbox drain failed", error);
    });
    return;
  }
  if (invocationLimit === 1) {
    await runSource(sources[0]!, env).catch((error) => {
      console.error(`Scheduled source ${sources[0]!.id} failed`, error);
    });
    return;
  }
  await drainTrackedSourceOutbox(env, { maxBatches: 1 }).catch((error) => {
    console.error("Scheduled tracked source outbox drain failed", error);
  });
  for (let index = 0; index < sources.length; index += concurrency) {
    const batch = sources.slice(index, index + concurrency);
    await Promise.allSettled(batch.map((source) => runSourceWithBoundaryFallback(
      sourceBoundary,
      source,
      env,
      { resumeOutbox: false },
    )));
  }
}

async function runScheduledHygieneLane(env: Env): Promise<void> {
  await purgeExpiredPairingCodes(env.DB);
  await purgeExpiredPublicShares(env.DB);
  await expireResearchResultImports(env.DB);
  await drainTrackedSourceOutbox(env, { maxBatches: 1 }).catch((error) => {
    console.error("Scheduled tracked source outbox drain failed", error);
  });
}

export async function scheduledRun(
  env: Env,
  scheduledAt = new Date(),
  sourceBoundary?: SourceRunBoundaryClient,
): Promise<void> {
  await ensureSchema(env.DB);
  const { executionCapacity } = await getBudgetProfile(env.DB);
  await runScheduledLane(scheduledAt, {
    source: () => runScheduledSourceLane(env, executionCapacity, sourceBoundary),
    hygiene: () => runScheduledHygieneLane(env),
    mission: async () => {
      await refreshMissionReminders(env, scheduledAt);
      await startDueMissionSprints(env, 1);
    },
    routine: async () => {
      await startDueIntelligenceRoutines(env, 1).catch((error) => console.error("Intelligence Routine scheduling failed", error));
    },
    lineage: async () => {
      await backfillEvidenceLineage(env, 12).catch((error) => console.error("Evidence lineage backfill failed", error));
    },
    "reasoning-discovery": async () => {
      await discoverReasoningTaskCandidate(env).catch((error) => console.error("Reasoning task discovery failed", error));
    },
    "reasoning-materialization": async () => {
      await materializeNextReasoningTask(env).catch((error) => console.error("Reasoning task materialization failed", error));
    },
    memory: async () => {
      await refreshEpistemicMemoryIfDue(env).catch((error) => console.error("Memory Graph refresh failed", error));
    },
    briefing: async () => {
      if (await shouldGenerateDailyBriefing(env, scheduledAt)) await generateBriefing(env, 24);
    },
    "ai-search": async () => {
      await syncAISearchIfEnabled(env).catch((error) => console.error("AI Search sync failed", error));
    },
  });
}

async function coreFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      const schemaVersion = await ensureSchema(env.DB);
      return secureResponse(
        env,
        json({ ok: true, app: env.APP_NAME || "Driftglass", version: "0.9.0", schemaVersion, now: isoNow() }),
      );
    }
    if (
      path.startsWith("/api/") ||
      path.startsWith("/collector/") ||
      path.startsWith("/packet/") ||
      path.startsWith("/corpus/") ||
      path.startsWith("/mcp/") ||
      path.startsWith("/feedback/") ||
      path.startsWith("/share/")
    ) {
      await ensureSchema(env.DB);
    }
    const discovery = handleDiscoveryRoute(request, env.PUBLIC_INDEXING === "enabled");
    if (discovery) return secureResponse(env, discovery);
    if (path.startsWith("/api/")) return secureResponse(env, await handleApi(request, env, ctx));
    if (path.startsWith("/collector/")) return secureResponse(env, await handleCollectorRequest(request, env));
    if (path.startsWith("/packet/")) return secureResponse(env, await handlePacket(request, env));
    if (path.startsWith("/corpus/")) return secureResponse(env, await handleCorpus(request, env));
    if (path.startsWith("/mcp/")) return secureResponse(env, await handleMcp(request, env, ctx));
    if (path.startsWith("/feedback/")) return secureResponse(env, await handleFeedbackLink(request, env));
    if (path.startsWith("/share/")) return secureResponse(env, await handlePublicShare(request, env));
    return secureResponse(env, await env.ASSETS.fetch(request), { assets: true });
  } catch (error) {
    return secureResponse(env, toErrorResponse(error));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return secureResponse(env, await handleMcpOAuth(request, env, ctx, coreFetch));
    } catch (error) {
      return secureResponse(env, toErrorResponse(error));
    }
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await ensureSchema(env.DB);
    await handleEmail(message, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledRun(env, new Date(controller.scheduledTime), ctx.exports.SourceRunBoundary));
  },

  async queue(batch: MessageBatch<IngestMessage>, env: Env): Promise<void> {
    const quarantineQueue = batch.queue === env.INGEST_QUARANTINE_NAME;
    const failureQueue = batch.queue === env.INGEST_DLQ_NAME || quarantineQueue;
    if (!(await ensureQueueSchema(env.DB, batch, {
      allowUnavailable: failureQueue,
      allowSchemaMismatch: quarantineQueue,
    }))) return;
    await handleIngestQueueBatch(batch, env);
  },
};
