import {
  claimIngestDeadLetterForRetry,
  clearTasteProfile,
  completeIngestDeadLetterRetryClaim,
  createPairingCode,
  deleteMission,
  deleteSource,
  dueSources,
  getMission,
  getMissionOperator,
  getMissionResearchState,
  getMissionRun,
  getSetting,
  getSource,
  getStory,
  latestBriefing,
  latestStories,
  listCollectorHealth,
  listInboxReceipts,
  listIngestDeadLetters,
  listMissionEvents,
  listMissionMatches,
  listMissionRuns,
  listMissions,
  listPackInstalls,
  listPublicShares,
  listRecentFeedback,
  listRenderStats,
  listResearchResultImports,
  listSourceHealth,
  listSources,
  recordFeedback,
  recordMissionEvent,
  releaseIngestDeadLetterRetryClaim,
  resolveIngestDeadLetter,
  searchStories,
  setSetting,
  sourceRunHistory,
  upsertMission,
  upsertMissionOperator,
  upsertSource,
} from "./db";
import { buildActionCenter } from "./action-center";
import {
  aiSearchStatus,
  assertAISearchEnabled,
  semanticSearch,
  setupAISearch,
  syncAISearch,
  syncAISearchIfEnabled,
} from "./ai-search";
import { curatedStoriesForToday, generateBriefing } from "./briefing";
import { getBudgetProfile, sourceRunConcurrency, sourceRunsPerInvocation } from "./budget";
import { pulseTaskPrompt, scheduledBriefingTaskPrompt } from "./scheduled-task-prompts";
import { handleIntelligenceApi } from "./intelligence-api";
import { handleMcpConnectionApi } from "./mcp-connections";
import { buildDeepResearchHandoff, deepResearchMarkdown } from "./deep-research";
import { explainStoryRanking } from "./explain";
import { discoverSources } from "./discovery";
import { buildCatalogSourceDefinition, catalogEntriesFromCollectors } from "./catalog";
import { rebuildMissionMatchesWithStatus, startMissionMatchMaintenance } from "./missions";
import { missionAutopilotSummary, startMissionSprint } from "./mission-autopilot";
import {
  appendMissionComputerNote,
  ensureMissionComputer,
  exportMissionComputer,
  readMissionComputerFile,
  requestMissionComputerSync,
  searchMissionComputer,
  syncMissionComputer,
} from "./mission-computer";
import { fetchPortableLens, installPortableLens, parsePortableLens, starterPackAsLens } from "./lenses";
import { RELAY_CAPABILITIES, isRelayCapability, relayCapabilityArgsError } from "./relay-capabilities";
import { applyStarterPack, getStarterPack, STARTER_PACKS } from "./packs";
import { exportProfile, importProfile, previewProfileImport } from "./profile";
import { buildReadiness } from "./readiness";
import { requireIngestQueueDurability, requireIngestRecoveryQueueDurability } from "./queue-health";
import {
  deleteQuarantineRecoveryObject,
  isQuarantineRecoveryId,
  listQuarantineRecoveries,
  materializeQuarantineRecovery,
} from "./quarantine-recovery";
import { confirmResearchResult, pendingResearchResults, rejectResearchResult, stageResearchResult } from "./research-results";
import { renderAdaptive } from "./rendering";
import {
  assertPublicHttpUrl,
  baseUrlFor,
  clearOwnerSessionCookie,
  deriveMcpCapabilityKeys,
  ownerSessionCookie,
  randomToken,
  requireAdmin,
  sha256,
} from "./security";
import { runSource, sourceRuntimeAccess } from "./sources/registry";
import {
  assertOpenAlexConfigHasNoEmbeddedSecret,
  OpenAlexCredentialError,
  OpenAlexPrerequisiteError,
  OpenAlexRateLimitError,
  OpenAlexUpstreamError,
} from "./sources/openalex";
import { normalizeGithubRepositories } from "./sources/github-config";
import { drainTrackedSourceOutbox } from "./source-ingest-outbox";
import { starterPackSourcePlan } from "./scheduled-envelope";
import { runSourceWithBoundaryFallback } from "./source-run-boundary";
import { createPublicShare } from "./shares";
import { buildStoryGraph } from "./story-graph";
import { getTasteProfile, learnFromFeedback } from "./taste";
import { collectWeb } from "./sources/web";
import type { Env, IngestMessage, MissionOperatorRecord, NormalizedItemInput, SourceKind, SourceRecord } from "./types";
import { enqueueIngestMessages, enqueueRecoveryIngestMessage } from "./ingest-queue";
import {
  HttpError,
  excerpt,
  isoNow,
  json,
  normalizeStringArray,
  numberFrom,
  parseJson,
  readBoundedResponseJson,
  readBoundedResponseText,
  readJson,
} from "./utils";

const SOURCE_KINDS: SourceKind[] = [
  "hackernews", "lobsters", "bluesky", "arxiv", "openalex", "github_releases", "github_activity", "npm_releases", "pypi_releases", "web", "web_feed", "collector", "manual", "email",
];
const FEEDBACK_ACTIONS = ["more", "less", "track", "mute", "already-knew", "bad-source", "wrong"];
const MISSION_STATUSES = ["active", "paused", "complete"] as const;
const MISSION_MODES = ["watch", "decision", "hypothesis", "event"] as const;
const MISSION_RESEARCH_POLICIES = ["manual", "suggest", "always"] as const;
const MISSION_SPRINT_POLICIES = ["manual", "scheduled"] as const;
const MISSION_EXPECTED_EVENT_STATUSES = ["pending", "occurred", "missed", "rescheduled", "none"] as const;
const MISSION_OUTCOMES = ["open", "resolved", "invalidated", "superseded"] as const;
const MISSION_EVENT_TYPES = ["note", "signal", "expected-event", "outcome", "escalation", "reminder", "sprint", "research-result"] as const;

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || crypto.randomUUID();
}

function sourceFromBody(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 160) : "";
  const kind = typeof body.kind === "string" ? body.kind as SourceKind : undefined;
  if (!name) throw new HttpError(400, "Source name is required");
  if (!kind || !SOURCE_KINDS.includes(kind)) throw new HttpError(400, "Unsupported source kind");
  const config = body.config && typeof body.config === "object" ? body.config as Record<string, unknown> : {};

  if ((kind === "web" || kind === "web_feed") && typeof config.url !== "string") throw new HttpError(400, "Web sources require config.url");
  if (kind === "github_releases" || kind === "github_activity") {
    let repositories: string[];
    try {
      repositories = normalizeGithubRepositories(config.repos, kind === "github_activity" ? 20 : 25);
      config.repos = repositories;
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "GitHub repository configuration is invalid");
    }
    if (!repositories.length) {
      throw new HttpError(400, `${kind === "github_releases" ? "GitHub release" : "GitHub activity"} sources require config.repos`);
    }
  }
  if ((kind === "npm_releases" || kind === "pypi_releases") && normalizeStringArray(config.packages).length === 0) {
    throw new HttpError(400, `${kind === "npm_releases" ? "npm" : "PyPI"} release sources require config.packages`);
  }
  if (kind === "bluesky" && ![config.query, config.actor, config.feedUri].some((value) => typeof value === "string" && value.trim())) {
    throw new HttpError(400, "Bluesky sources require config.query, config.actor, or config.feedUri");
  }
  if (kind === "arxiv" && normalizeStringArray(config.categories).length === 0 && typeof config.query !== "string") {
    throw new HttpError(400, "arXiv sources require config.query or config.categories");
  }
  if (kind === "openalex") {
    try {
      assertOpenAlexConfigHasNoEmbeddedSecret(config);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "OpenAlex source configuration is invalid");
    }
    if (
      normalizeStringArray(config.concepts).length === 0
      && normalizeStringArray(config.workIds).length === 0
      && typeof config.query !== "string"
    ) {
      throw new HttpError(400, "OpenAlex sources require config.query, config.concepts, or config.workIds");
    }
  }
  if (kind === "collector") {
    const operation = typeof config.operation === "string" ? config.operation.trim() : "";
    if (!operation || !isRelayCapability(operation)) {
      throw new HttpError(400, "Relay operation is not in Driftglass's read-only capability catalog");
    }
    const argsError = relayCapabilityArgsError(operation, config.args, "config.args");
    if (argsError) throw new HttpError(400, argsError);
  }

  return {
    id: typeof body.id === "string" && body.id.trim() ? slug(body.id) : slug(name),
    name,
    kind,
    config,
    enabled: body.enabled !== false,
    scheduleMinutes: Math.max(15, Math.min(10_080, numberFrom(body.scheduleMinutes, 60))),
    weight: Math.max(0.1, Math.min(3, numberFrom(body.weight, 1))),
  };
}

function missionFromBody(body: Record<string, unknown>, existingId?: string) {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 180) : "";
  if (!name) throw new HttpError(400, "Mission name is required");
  const terms = normalizeStringArray(body.terms).slice(0, 100);
  const sourceScope = normalizeStringArray(body.sourceScope).slice(0, 100);
  if (terms.some((value) => [...value].length > 200)) {
    throw new HttpError(400, "Mission terms must be at most 200 characters");
  }
  if (sourceScope.some((value) => [...value].length > 200)) {
    throw new HttpError(400, "Mission source scope entries must be at most 200 characters");
  }
  const status = typeof body.status === "string" && MISSION_STATUSES.includes(body.status as typeof MISSION_STATUSES[number])
    ? body.status as typeof MISSION_STATUSES[number]
    : "active";
  return {
    id: existingId || (typeof body.id === "string" && body.id.trim() ? slug(body.id) : slug(name)),
    name,
    question: typeof body.question === "string" ? body.question.trim().slice(0, 1_000) : "",
    terms,
    sourceScope,
    status,
    priority: Math.max(0.1, Math.min(5, numberFrom(body.priority, 1))),
    cadenceMinutes: Math.max(15, Math.min(43_200, numberFrom(body.cadenceMinutes, 360))),
  };
}

function missionOperatorFromBody(
  body: Record<string, unknown>,
  missionId: string,
  existing?: MissionOperatorRecord | null,
  cadenceMinutes = 360,
) {
  const mode = typeof body.mode === "string" && MISSION_MODES.includes(body.mode as typeof MISSION_MODES[number])
    ? body.mode as typeof MISSION_MODES[number]
    : existing?.mode ?? "watch";
  const researchPolicy = typeof body.researchPolicy === "string" && MISSION_RESEARCH_POLICIES.includes(body.researchPolicy as typeof MISSION_RESEARCH_POLICIES[number])
    ? body.researchPolicy as typeof MISSION_RESEARCH_POLICIES[number]
    : existing?.research_policy ?? "suggest";
  const sprintPolicy = typeof body.sprintPolicy === "string" && MISSION_SPRINT_POLICIES.includes(body.sprintPolicy as typeof MISSION_SPRINT_POLICIES[number])
    ? body.sprintPolicy as typeof MISSION_SPRINT_POLICIES[number]
    : existing?.sprint_policy ?? "manual";
  const outcomeStatus = typeof body.outcomeStatus === "string" && MISSION_OUTCOMES.includes(body.outcomeStatus as typeof MISSION_OUTCOMES[number])
    ? body.outcomeStatus as typeof MISSION_OUTCOMES[number]
    : existing?.outcome_status ?? "open";

  let expectedBy = existing?.expected_by ?? null;
  if (body.expectedBy === null || body.expectedBy === "") expectedBy = null;
  else if (typeof body.expectedBy === "string") {
    const timestamp = Date.parse(body.expectedBy);
    if (!Number.isFinite(timestamp)) throw new HttpError(400, "Expected date is invalid");
    expectedBy = new Date(timestamp).toISOString();
  }
  const expectedNextEvent = typeof body.expectedNextEvent === "string"
    ? body.expectedNextEvent.trim().slice(0, 1_000)
    : existing?.expected_next_event ?? "";
  const expectedEventStatus = typeof body.expectedEventStatus === "string" && MISSION_EXPECTED_EVENT_STATUSES.includes(body.expectedEventStatus as typeof MISSION_EXPECTED_EVENT_STATUSES[number])
    ? body.expectedEventStatus as typeof MISSION_EXPECTED_EVENT_STATUSES[number]
    : expectedNextEvent ? existing?.expected_event_status ?? "pending" : "none";
  const transitionedClosed = outcomeStatus !== "open" && existing?.outcome_status === "open";
  let nextSprintAt = existing?.next_sprint_at ?? null;
  if (sprintPolicy === "manual") nextSprintAt = null;
  else if (body.sprintPolicy === "scheduled" && existing?.sprint_policy !== "scheduled") {
    nextSprintAt = new Date(Date.now() + Math.max(15, cadenceMinutes) * 60_000).toISOString();
  }

  return {
    missionId,
    mode,
    researchPolicy,
    alertThreshold: Math.max(0.1, Math.min(1, numberFrom(body.alertThreshold, existing?.alert_threshold ?? 0.65))),
    expectedNextEvent,
    expectedBy,
    outcomeStatus,
    outcomeSummary: typeof body.outcomeSummary === "string"
      ? body.outcomeSummary.trim().slice(0, 4_000)
      : existing?.outcome_summary ?? "",
    resolvedAt: outcomeStatus === "open" ? null : transitionedClosed ? isoNow() : existing?.resolved_at ?? isoNow(),
    sprintPolicy,
    nextSprintAt,
    lastSprintAt: existing?.last_sprint_at ?? null,
    reminderLeadDays: Math.max(0, Math.min(30, numberFrom(body.reminderLeadDays, existing?.reminder_lead_days ?? 3))),
    expectedEventStatus,
  };
}

async function loadCommunityLensCatalog(request: Request, env: Env): Promise<Array<Record<string, unknown>>> {
  try {
    const response = await env.ASSETS.fetch(new Request(new URL("/lenses/catalog.json", request.url)));
    if (!response.ok) return [];
    const payload = await readBoundedResponseJson<{ lenses?: Array<Record<string, unknown>> }>(
      response,
      1_000_000,
      "Lens catalog exceeds 1 MB",
    );
    return Array.isArray(payload.lenses) ? payload.lenses : [];
  } catch {
    return [];
  }
}

async function ensureManualSource(env: Env): Promise<void> {
  await upsertSource(env.DB, {
    id: "manual-inbox",
    name: "Manual inbox",
    kind: "manual",
    config: {},
    scheduleMinutes: 10_080,
    weight: 1.4,
  });
}

type ResearchBundle = {
  schemaVersion: string;
  generatedAt: string;
  story?: { id: string; title: string; summary?: string };
  mission?: { id: string; name: string; question: string };
  operator?: Record<string, unknown> | null;
  events?: Array<Record<string, unknown>>;
  deepResearch?: Record<string, unknown>;
  stories?: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
};

async function buildStoryBundle(env: Env, storyId: string): Promise<ResearchBundle> {
  const detail = await getStory(env.DB, storyId);
  if (!detail) throw new HttpError(404, "Story not found");
  return {
    schemaVersion: "1",
    generatedAt: isoNow(),
    story: { id: detail.story.id, title: detail.story.title, summary: detail.story.summary },
    evidence: detail.evidence.slice(0, 200).map((item) => {
      const metadata = parseJson<Record<string, unknown>>(item.metadata_json, {});
      return {
        itemId: item.id,
        storyId: detail.story.id,
        title: item.title,
        url: item.url,
        author: item.author,
        publishedAt: item.published_at ?? item.observed_at,
        excerpt: excerpt(item.text, 8_000),
        source: item.source_name,
        provider: typeof metadata.provider === "string" ? metadata.provider : undefined,
        accessClass: item.access_class,
        metadata,
      };
    }),
  };
}

async function buildMissionBundle(env: Env, missionId: string): Promise<ResearchBundle> {
  const mission = await getMission(env.DB, missionId);
  if (!mission) throw new HttpError(404, "Mission not found");
  const matches = await listMissionMatches(env.DB, missionId, 60);
  const evidence: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const stories: Array<Record<string, unknown>> = [];
  for (const match of matches) {
    const storyId = String(match.story_id ?? "");
    if (!storyId) continue;
    const detail = await getStory(env.DB, storyId);
    if (!detail) continue;
    stories.push({
      id: detail.story.id,
      title: detail.story.title,
      summary: detail.story.summary,
      matchScore: Number(match.match_score ?? 0),
      matchedTerms: parseJson(String(match.matched_terms_json ?? "[]"), []),
      lastChangedAt: detail.story.last_changed_at,
    });
    for (const item of detail.evidence.slice(0, 12)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const metadata = parseJson<Record<string, unknown>>(item.metadata_json, {});
      evidence.push({
        itemId: item.id,
        storyId: detail.story.id,
        title: item.title,
        url: item.url,
        author: item.author,
        publishedAt: item.published_at ?? item.observed_at,
        excerpt: excerpt(item.text, 8_000),
        source: item.source_name,
        provider: typeof metadata.provider === "string" ? metadata.provider : undefined,
        accessClass: item.access_class,
        metadata,
      });
      if (evidence.length >= 300) break;
    }
    if (evidence.length >= 300) break;
  }
  const [operator, events, deepResearch] = await Promise.all([
    getMissionOperator(env.DB, missionId),
    listMissionEvents(env.DB, missionId, 100),
    buildDeepResearchHandoff(env, missionId),
  ]);
  return {
    schemaVersion: "2",
    generatedAt: isoNow(),
    mission: { id: mission.id, name: mission.name, question: mission.question },
    operator: operator as unknown as Record<string, unknown> | null,
    events: events as unknown as Array<Record<string, unknown>>,
    deepResearch: deepResearch as unknown as Record<string, unknown>,
    stories,
    evidence,
  };
}

function deepDiveConfigured(env: Env): boolean {
  return Boolean(env.DEEP_DIVE_LAB_URL?.trim() && env.DEEP_DIVE_LAB_TOKEN?.trim());
}

function deepDiveUrl(env: Env, path: string): URL {
  if (!deepDiveConfigured(env)) throw new HttpError(409, "Computer Power Mode is not connected");
  const lab = assertPublicHttpUrl(env.DEEP_DIVE_LAB_URL!);
  if (!path.startsWith("/")) throw new HttpError(500, "Deep Dive path must be absolute");
  const target = new URL(path, lab.origin);
  target.username = "";
  target.password = "";
  target.hash = "";
  return target;
}

async function deepDiveFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.DEEP_DIVE_LAB_TOKEN}`);
  headers.set("user-agent", "driftglass/0.9.0");
  return fetch(deepDiveUrl(env, path), { ...init, headers });
}

async function readOptionalDeepDiveJson(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<Record<string, unknown>> {
  const text = await readBoundedResponseText(response, maxBytes, tooLargeMessage);
  return parseJson<Record<string, unknown>>(text, {});
}

async function openDeepDive(env: Env, inputCaseId: string, bundle: ResearchBundle): Promise<Record<string, unknown>> {
  const caseId = slug(inputCaseId);
  const response = await deepDiveFetch(env, `/cases/${encodeURIComponent(caseId)}/bundle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bundle),
  });
  const payload = await readOptionalDeepDiveJson(response, 2_000_000, "Computer Power Mode response exceeds 2 MB");
  if (!response.ok) throw new HttpError(502, typeof payload.error === "string" ? payload.error : `Computer Power Mode returned HTTP ${response.status}`);
  return {
    ...payload,
    caseId,
    dossierApiUrl: `/api/deep-dives/${encodeURIComponent(caseId)}/file?path=${encodeURIComponent("/dossier.md")}`,
    exportApiUrl: `/api/deep-dives/${encodeURIComponent(caseId)}/export`,
  };
}

async function launchMissionMatchMaintenance(env: Env, missionId: string, reason: string) {
  if (env.MISSION_WORKFLOW) return startMissionMatchMaintenance(env, { missionId, reason });
  const rebuild = await rebuildMissionMatchesWithStatus(env, missionId);
  const computer = await syncMissionComputer(env, missionId, reason);
  return { status: "complete" as const, missionId, rebuild, computer };
}

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await requireAdmin(request, env.DRIFTGLASS_SECRET);
  const url = new URL(request.url);
  const path = url.pathname;

  const connection = await handleMcpConnectionApi(request, env);
  if (connection) return connection;

  const intelligence = await handleIntelligenceApi(request, env, ctx);
  if (intelligence) return intelligence;

  if (path === "/api/session" && request.method === "GET") {
    return json(
      { ok: true, app: env.APP_NAME || "Driftglass", version: "0.9.0", now: isoNow() },
      { headers: { "set-cookie": await ownerSessionCookie(env.DRIFTGLASS_SECRET) } },
    );
  }

  if (path === "/api/session/lock" && request.method === "POST") {
    return json({ ok: true }, { headers: { "set-cookie": clearOwnerSessionCookie() } });
  }

  if (path === "/api/overview" && request.method === "GET") {
    const [sources, stories, sourceHealth, collectors, briefing, missions, renderStats, packInstalls] = await Promise.all([
      listSources(env.DB),
      curatedStoriesForToday(env, 24, 12),
      listSourceHealth(env.DB),
      listCollectorHealth(env.DB),
      latestBriefing(env.DB),
      listMissions(env.DB),
      listRenderStats(env.DB),
      listPackInstalls(env.DB),
    ]);
    return json({
      ok: true,
      sources: sources.map((source) => ({ ...source, runtimeAccess: sourceRuntimeAccess(source, env) })),
      stories,
      sourceHealth,
      collectors,
      briefing,
      missions,
      renderStats,
      packInstalls,
    });
  }

  if (path === "/api/capabilities" && request.method === "GET") {
    const collectors = await listCollectorHealth(env.DB);
    return json({ ok: true, fixed: RELAY_CAPABILITIES, catalog: catalogEntriesFromCollectors(collectors) });
  }

  if (path === "/api/sources/discover" && request.method === "POST") {
    const body = await readJson<{ input?: string }>(request);
    return json({ ok: true, suggestions: discoverSources(String(body.input ?? "")) });
  }

  if (path === "/api/catalog/source" && request.method === "POST") {
    const collectors = await listCollectorHealth(env.DB);
    const definition = buildCatalogSourceDefinition(collectors, await readJson<Record<string, unknown>>(request));
    await upsertSource(env.DB, definition.source);
    const created = await getSource(env.DB, definition.source.id);
    if (!created) throw new HttpError(500, "Source was created but could not be reloaded");
    if (definition.runNow) ctx.waitUntil(runSource(created, env).catch((error) => console.error("Initial catalog source run failed", error)));
    return json({
      ok: true,
      source: created,
      adapter: { site: definition.entry.site, command: definition.entry.command, collectorId: definition.entry.collectorId },
      scheduled: definition.runNow,
    }, { status: 201 });
  }

  if (path === "/api/sources" && request.method === "GET") {
    const sources = await listSources(env.DB);
    return json({ ok: true, sources: sources.map((source) => ({ ...source, runtimeAccess: sourceRuntimeAccess(source, env) })) });
  }
  if (path === "/api/sources" && request.method === "POST") {
    const source = sourceFromBody(await readJson<Record<string, unknown>>(request));
    await upsertSource(env.DB, source);
    return json({ ok: true, source }, { status: 201 });
  }
  if (path === "/api/sources/run-due" && request.method === "POST") {
    const { profile, executionCapacity } = await getBudgetProfile(env.DB);
    const invocationLimit = sourceRunsPerInvocation(executionCapacity, 12);
    const concurrency = sourceRunConcurrency(executionCapacity, 3);
    const due = await dueSources(env.DB, isoNow(), { deferOpenAlex: !env.OPENALEX_API_KEY?.trim() });
    const access = due.map((source) => ({ source, access: sourceRuntimeAccess(source, env) }));
    const deferred = access.filter((entry) => !entry.access.runnable);
    const selected = access.filter((entry) => entry.access.runnable).map((entry) => entry.source).slice(0, invocationLimit);
    if (selected.length === 0) {
      await drainTrackedSourceOutbox(env, { maxBatches: 1 }).catch((error) => {
        console.error("Run-due tracked source outbox drain failed", error);
      });
    } else if (invocationLimit === 1) {
      ctx.waitUntil(runSource(selected[0]!, env).catch((error) => {
        console.error(`Run-due source ${selected[0]!.id} failed`, error);
      }));
    } else {
      await drainTrackedSourceOutbox(env, { maxBatches: 1 }).catch((error) => {
        console.error("Run-due tracked source outbox drain failed", error);
      });
      ctx.waitUntil((async () => {
        for (let index = 0; index < selected.length; index += concurrency) {
          await Promise.allSettled(selected.slice(index, index + concurrency).map((source) =>
            runSourceWithBoundaryFallback(
              ctx.exports.SourceRunBoundary,
              source,
              env,
              { resumeOutbox: false },
            )));
        }
      })());
    }
    return json({
      ok: true,
      profile,
      executionCapacity,
      invocationLimit,
      concurrency,
      scheduled: selected.length,
      sourceIds: selected.map((source) => source.id),
      prerequisiteDeferred: deferred.length,
      prerequisiteCodes: [...new Set(deferred.map((entry) => entry.access.code).filter(Boolean))],
    }, { status: 202 });
  }
  const sourceMatch = path.match(/^\/api\/sources\/([^/]+)$/);
  if (sourceMatch && request.method === "DELETE") {
    await deleteSource(env.DB, decodeURIComponent(sourceMatch[1] ?? ""));
    return json({ ok: true });
  }
  const sourceRunMatch = path.match(/^\/api\/sources\/([^/]+)\/run$/);
  if (sourceRunMatch && request.method === "POST") {
    const sourceId = decodeURIComponent(sourceRunMatch[1] ?? "");
    const source = await getSource(env.DB, sourceId);
    if (!source) throw new HttpError(404, "Source not found");
    try {
      const result = await runSource(source, env);
      return json({ ok: true, ...result }, { status: result.status === "queued" || result.status === "pending" ? 202 : 200 });
    } catch (error) {
      if (
        error instanceof OpenAlexPrerequisiteError
        || error instanceof OpenAlexRateLimitError
        || error instanceof OpenAlexCredentialError
        || error instanceof OpenAlexUpstreamError
      ) {
        throw new HttpError(error.status, error.message, error.details);
      }
      throw error;
    }
  }
  const sourceHistoryMatch = path.match(/^\/api\/sources\/([^/]+)\/runs$/);
  if (sourceHistoryMatch && request.method === "GET") {
    return json({ ok: true, runs: await sourceRunHistory(env.DB, decodeURIComponent(sourceHistoryMatch[1] ?? "")) });
  }

  if (path === "/api/ingest/outbox/drain" && request.method === "POST") {
    const body = await readJson<{ maxBatches?: number }>(request);
    const maxBatches = Math.max(1, Math.min(6, Math.floor(numberFrom(body.maxBatches, 6))));
    const drained = await drainTrackedSourceOutbox(env, { maxBatches });
    return json({ ok: true, ...drained });
  }

  if (path === "/api/ingest/dead-letters" && request.method === "GET") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 50;
    const [databaseRecords, quarantineRecords] = await Promise.all([
      listIngestDeadLetters(env.DB, limit),
      listQuarantineRecoveries(env, env.INGEST_QUARANTINE_NAME, limit),
    ]);
    // While a materialized fallback object still exists, keep its R2 identity
    // as the one actionable row. A retry through that path can both reconcile
    // D1 and eventually delete R2; exposing the internal D1 row instead would
    // strand cleanup after an ambiguous delete response.
    const quarantineQueueMessageIds = new Set(quarantineRecords.map((record) => record.queue_message_id));
    const deadLetters = [
      ...quarantineRecords,
      ...databaseRecords.filter((record) => !quarantineQueueMessageIds.has(record.queue_message_id)),
    ]
      .sort((left, right) => {
        const statusOrder = Number(left.status !== "unresolved") - Number(right.status !== "unresolved");
        return statusOrder || right.created_at.localeCompare(left.created_at);
      })
      .slice(0, limit);
    return json({ ok: true, deadLetters });
  }
  const deadLetterActionMatch = path.match(/^\/api\/ingest\/dead-letters\/([^/]+)\/(retry|dismiss)$/);
  if (deadLetterActionMatch && request.method === "POST") {
    const id = decodeURIComponent(deadLetterActionMatch[1] ?? "");
    const action = deadLetterActionMatch[2];
    if (isQuarantineRecoveryId(id)) {
      if (action === "retry") {
        await requireIngestRecoveryQueueDurability(env, { storage: "r2", id });
      }
      const materialized = await materializeQuarantineRecovery(env, id, env.INGEST_QUARANTINE_NAME);
      // A prior action may have committed its content-free D1 disposition and
      // then lost the R2 delete response. Finish that cleanup without sending
      // the body again or rewriting its permanent audit record.
      if (materialized.deadLetter.status !== "unresolved") {
        await deleteQuarantineRecoveryObject(env, id);
        return json({ ok: true, queued: 0, cleanupOnly: true, deadLetter: materialized.deadLetter });
      }
      if (action === "dismiss") {
        const deadLetter = await resolveIngestDeadLetter(env.DB, materialized.deadLetter.id, "ignored");
        await deleteQuarantineRecoveryObject(env, id);
        return json({ ok: true, deadLetter });
      }
      const claimToken = crypto.randomUUID();
      const record = await claimIngestDeadLetterForRetry(env.DB, materialized.deadLetter.id, claimToken);
      let dispatched = false;
      try {
        if (await sha256(record.body_json) !== record.body_hash) {
          throw new HttpError(409, "Ingest dead-letter recovery body failed its integrity check");
        }
        const queued = parseJson<IngestMessage | null>(record.body_json, null);
        if (!queued || typeof queued.sourceId !== "string" || !queued.item || typeof queued.item.title !== "string") {
          throw new HttpError(409, "Ingest dead-letter recovery body is invalid");
        }
        await enqueueRecoveryIngestMessage(env, queued);
        dispatched = true;
        const deadLetter = await completeIngestDeadLetterRetryClaim(
          env.DB,
          materialized.deadLetter.id,
          claimToken,
        );
        await deleteQuarantineRecoveryObject(env, id);
        return json({ ok: true, queued: 1, deadLetter }, { status: 202 });
      } catch (error) {
        if (!dispatched) {
          await releaseIngestDeadLetterRetryClaim(env.DB, materialized.deadLetter.id, claimToken).catch((releaseError) => {
            console.error("Unable to release ingest dead-letter retry claim", releaseError);
          });
        }
        throw error;
      }
    }
    if (action === "dismiss") {
      return json({ ok: true, deadLetter: await resolveIngestDeadLetter(env.DB, id, "ignored") });
    }
    await requireIngestRecoveryQueueDurability(env, { storage: "d1", id });
    const claimToken = crypto.randomUUID();
    const record = await claimIngestDeadLetterForRetry(env.DB, id, claimToken);
    let dispatched = false;
    try {
      if (await sha256(record.body_json) !== record.body_hash) {
        throw new HttpError(409, "Ingest dead-letter recovery body failed its integrity check");
      }
      const queued = parseJson<IngestMessage | null>(record.body_json, null);
      if (!queued || typeof queued.sourceId !== "string" || !queued.item || typeof queued.item.title !== "string") {
        throw new HttpError(409, "Ingest dead-letter recovery body is invalid");
      }
      // Recovery deliberately starts a fresh ingest attempt: the original
      // tracked run remains an honest failed delivery record, while stale run
      // tracking is stripped and bounded raw provenance remains validated.
      await enqueueRecoveryIngestMessage(env, queued);
      dispatched = true;
      return json({
        ok: true,
        queued: 1,
        deadLetter: await completeIngestDeadLetterRetryClaim(env.DB, id, claimToken),
      }, { status: 202 });
    } catch (error) {
      // Before Queue acceptance it is safe to make the lease immediately
      // reclaimable. After acceptance an uncertain finalization keeps the
      // lease until expiry; a later replay is evidence-idempotent.
      if (!dispatched) {
        await releaseIngestDeadLetterRetryClaim(env.DB, id, claimToken).catch((releaseError) => {
          console.error("Unable to release ingest dead-letter retry claim", releaseError);
        });
      }
      throw error;
    }
  }

  if (path === "/api/config/export" && request.method === "GET") {
    return json(await exportProfile(env));
  }
  if (path === "/api/config/import" && request.method === "POST") {
    const body = await readJson<unknown>(request, 4_000_000);
    const dryRun = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dryRun") === "true";
    if (dryRun) return json({ ok: true, preview: await previewProfileImport(env, body) });
    const preview = await previewProfileImport(env, body);
    const imported = await importProfile(env, body);
    return json({ ok: true, preview, ...imported });
  }

  if (path === "/api/action-center" && request.method === "GET") {
    return json({ ok: true, ...(await buildActionCenter(env)) });
  }
  if (path === "/api/readiness" && request.method === "GET") {
    return json(await buildReadiness(env, request));
  }
  if (path === "/api/autopilot" && request.method === "GET") {
    return json({ ok: true, missions: await missionAutopilotSummary(env) });
  }

  if (path === "/api/stories" && request.method === "GET") {
    const query = (url.searchParams.get("q") ?? "").trim();
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 30)));
    return json({ ok: true, stories: query ? await searchStories(env.DB, query, limit) : await latestStories(env.DB, limit) });
  }
  const storyBundleMatch = path.match(/^\/api\/stories\/([^/]+)\/bundle$/);
  if (storyBundleMatch && request.method === "GET") {
    return json(await buildStoryBundle(env, decodeURIComponent(storyBundleMatch[1] ?? "")));
  }
  const storyDeepDiveMatch = path.match(/^\/api\/stories\/([^/]+)\/deep-dive$/);
  if (storyDeepDiveMatch && request.method === "POST") {
    const storyId = decodeURIComponent(storyDeepDiveMatch[1] ?? "");
    return json({ ok: true, ...(await openDeepDive(env, `story-${storyId}`, await buildStoryBundle(env, storyId))) }, { status: 201 });
  }
  const storyGraphMatch = path.match(/^\/api\/stories\/([^/]+)\/graph$/);
  if (storyGraphMatch && request.method === "GET") {
    const storyId = decodeURIComponent(storyGraphMatch[1] ?? "");
    const limit = Math.max(1, Math.min(20, numberFrom(url.searchParams.get("limit"), 10)));
    return json({ ok: true, graph: await buildStoryGraph(env, storyId, limit) });
  }
  const storyExplainMatch = path.match(/^\/api\/stories\/([^/]+)\/explain$/);
  if (storyExplainMatch && request.method === "GET") {
    const explanation = await explainStoryRanking(env, decodeURIComponent(storyExplainMatch[1] ?? ""));
    if (!explanation) throw new HttpError(404, "Story not found");
    return json({ ok: true, explanation });
  }
  const storyMatch = path.match(/^\/api\/stories\/([^/]+)$/);
  if (storyMatch && request.method === "GET") {
    const detail = await getStory(env.DB, decodeURIComponent(storyMatch[1] ?? ""));
    if (!detail) throw new HttpError(404, "Story not found");
    return json({ ok: true, ...detail });
  }

  if (path === "/api/missions" && request.method === "GET") {
    const missions = await listMissions(env.DB);
    const enriched = await Promise.all(missions.map(async (mission) => {
      const [operator, researchState, events, matches, pendingImports] = await Promise.all([
        getMissionOperator(env.DB, mission.id),
        getMissionResearchState(env.DB, mission.id),
        listMissionEvents(env.DB, mission.id, 12),
        listMissionMatches(env.DB, mission.id, 8),
        listResearchResultImports(env.DB, { missionId: mission.id, status: "pending", limit: 5 }),
      ]);
      return {
        ...mission,
        terms: parseJson(mission.terms_json, []),
        sourceScope: parseJson(mission.source_scope_json, []),
        operator,
        researchState: researchState ? { ...researchState, openQuestions: parseJson(researchState.open_questions_json, []) } : null,
        pendingResearchResults: pendingImports.map((row) => ({ ...row, payload: parseJson(row.payload_json, {}), diff: parseJson(row.diff_json, {}) })),
        events,
        matches,
      };
    }));
    return json({ ok: true, missions: enriched });
  }
  if (path === "/api/missions" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const mission = missionFromBody(body);
    await upsertMission(env.DB, mission);
    await upsertMissionOperator(env.DB, missionOperatorFromBody(body, mission.id, null, mission.cadenceMinutes));
    await recordMissionEvent(env.DB, {
      missionId: mission.id,
      eventType: "note",
      title: "Mission created",
      detail: mission.question,
      metadata: { mode: body.mode ?? "watch", researchPolicy: body.researchPolicy ?? "suggest" },
    });
    const maintenance = await launchMissionMatchMaintenance(env, mission.id, "mission-created");
    return json({
      ok: true,
      mission,
      operator: await getMissionOperator(env.DB, mission.id),
      computer: { mode: "filesystem", freeTierCapable: true },
      matchMaintenance: maintenance,
    }, { status: maintenance.status === "queued" ? 202 : 201 });
  }
  if (path === "/api/mission-runs" && request.method === "GET") {
    const missionId = url.searchParams.get("missionId")?.trim() || undefined;
    const runs = await listMissionRuns(env.DB, { missionId, limit: numberFrom(url.searchParams.get("limit"), 30) });
    return json({
      ok: true,
      workflowConfigured: Boolean(env.MISSION_WORKFLOW),
      runs: runs.map((run) => ({
        ...run,
        sourceIds: parseJson(run.source_ids_json, []),
        result: parseJson(run.result_json, {}),
      })),
    });
  }
  const missionRunMatch = path.match(/^\/api\/mission-runs\/([^/]+)$/);
  if (missionRunMatch && request.method === "GET") {
    const run = await getMissionRun(env.DB, decodeURIComponent(missionRunMatch[1] ?? ""));
    if (!run) throw new HttpError(404, "Mission run not found");
    let workflowStatus: unknown = null;
    if (env.MISSION_WORKFLOW && run.workflow_id) {
      try {
        const instance = await env.MISSION_WORKFLOW.get(run.workflow_id);
        workflowStatus = await instance.status();
      } catch (error) {
        workflowStatus = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    return json({
      ok: true,
      run: { ...run, sourceIds: parseJson(run.source_ids_json, []), result: parseJson(run.result_json, {}) },
      workflowStatus,
    });
  }
  const missionSprintMatch = path.match(/^\/api\/missions\/([^/]+)\/sprint$/);
  if (missionSprintMatch && request.method === "POST") {
    const missionId = decodeURIComponent(missionSprintMatch[1] ?? "");
    const body = await readJson<{ sourceIds?: string[] }>(request);
    try {
      const sprint = await startMissionSprint(env, { missionId, sourceIds: body.sourceIds, trigger: "manual" });
      return json({
        ok: true,
        ...sprint,
        statusUrl: `/api/mission-runs/${encodeURIComponent(sprint.runId)}`,
      }, { status: 202 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not configured") || message.includes("already queued") || message.includes("already running")) {
        throw new HttpError(409, message);
      }
      if (message.includes("not found")) throw new HttpError(404, message);
      throw error;
    }
  }

  const missionEventsMatch = path.match(/^\/api\/missions\/([^/]+)\/events$/);
  if (missionEventsMatch && request.method === "GET") {
    const missionId = decodeURIComponent(missionEventsMatch[1] ?? "");
    if (!await getMission(env.DB, missionId)) throw new HttpError(404, "Mission not found");
    return json({ ok: true, events: await listMissionEvents(env.DB, missionId, 100) });
  }
  if (missionEventsMatch && request.method === "POST") {
    const missionId = decodeURIComponent(missionEventsMatch[1] ?? "");
    if (!await getMission(env.DB, missionId)) throw new HttpError(404, "Mission not found");
    const body = await readJson<Record<string, unknown>>(request);
    const eventType = typeof body.eventType === "string" && MISSION_EVENT_TYPES.includes(body.eventType as typeof MISSION_EVENT_TYPES[number])
      ? body.eventType as typeof MISSION_EVENT_TYPES[number]
      : "note";
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 300) : "";
    if (!title) throw new HttpError(400, "Mission event title is required");
    const id = await recordMissionEvent(env.DB, {
      missionId,
      eventType,
      title,
      detail: typeof body.detail === "string" ? body.detail : "",
      storyId: typeof body.storyId === "string" ? body.storyId : null,
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata as Record<string, unknown> : {},
      occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : undefined,
    });
    ctx.waitUntil(requestMissionComputerSync(env, missionId, "mission-event").catch((error) => console.error("Mission Computer sync failed", error)));
    return json({ ok: true, id }, { status: 201 });
  }

  const missionDeepResearchMatch = path.match(/^\/api\/missions\/([^/]+)\/deep-research$/);
  if (missionDeepResearchMatch && (request.method === "GET" || request.method === "POST")) {
    const missionId = decodeURIComponent(missionDeepResearchMatch[1] ?? "");
    const handoff = await buildDeepResearchHandoff(env, missionId);
    if (request.method === "POST") {
      const operator = await getMissionOperator(env.DB, missionId);
      if (operator) {
        await upsertMissionOperator(env.DB, {
          missionId,
          mode: operator.mode,
          researchPolicy: operator.research_policy,
          alertThreshold: operator.alert_threshold,
          expectedNextEvent: operator.expected_next_event,
          expectedBy: operator.expected_by,
          outcomeStatus: operator.outcome_status,
          outcomeSummary: operator.outcome_summary,
          resolvedAt: operator.resolved_at,
          lastEscalatedAt: isoNow(),
        });
      }
      await recordMissionEvent(env.DB, {
        missionId,
        eventType: "escalation",
        title: "Deep Research handoff prepared",
        detail: handoff.recommendation.whyNow,
        metadata: { score: handoff.recommendation.score, shouldEscalate: handoff.recommendation.shouldEscalate },
      });
      ctx.waitUntil(requestMissionComputerSync(env, missionId, "deep-research-handoff").catch((error) => console.error("Mission Computer sync failed", error)));
    }
    return json({ ok: true, handoff, markdown: deepResearchMarkdown(handoff) });
  }

  if (path === "/api/research-results" && request.method === "GET") {
    return json({ ok: true, imports: await pendingResearchResults(env, numberFrom(url.searchParams.get("limit"), 50)) });
  }
  const missionResearchPreviewMatch = path.match(/^\/api\/missions\/([^/]+)\/research-results\/preview$/);
  if (missionResearchPreviewMatch && request.method === "POST") {
    const missionId = decodeURIComponent(missionResearchPreviewMatch[1] ?? "");
    const body = await readJson<{ result?: unknown; source?: string }>(request, 1_000_000);
    const staged = await stageResearchResult(env, missionId, body.result ?? body, body.source);
    return json({
      ok: true,
      import: {
        ...staged.importRecord,
        payload: staged.payload,
        diff: staged.diff,
      },
    }, { status: 201 });
  }
  const researchResultDecisionMatch = path.match(/^\/api\/research-results\/([^/]+)\/(confirm|reject)$/);
  if (researchResultDecisionMatch && request.method === "POST") {
    const importId = decodeURIComponent(researchResultDecisionMatch[1] ?? "");
    const action = researchResultDecisionMatch[2];
    if (action === "confirm") {
      const confirmed = await confirmResearchResult(env, importId);
      ctx.waitUntil(Promise.allSettled([
        requestMissionComputerSync(env, confirmed.missionId, "research-result-confirmed"),
        syncAISearchIfEnabled(env, { waitForLast: true }),
      ]).then(() => undefined));
      return json({ ok: true, ...confirmed });
    }
    await rejectResearchResult(env, importId);
    return json({ ok: true, importId, status: "rejected" });
  }

  const missionComputerMatch = path.match(/^\/api\/missions\/([^/]+)\/computer$/);
  if (missionComputerMatch && request.method === "GET") {
    const missionId = decodeURIComponent(missionComputerMatch[1] ?? "");
    if (!await getMission(env.DB, missionId)) throw new HttpError(404, "Mission not found");
    return json({ ok: true, computer: await ensureMissionComputer(env, missionId) });
  }
  const missionComputerSyncMatch = path.match(/^\/api\/missions\/([^/]+)\/computer\/sync$/);
  if (missionComputerSyncMatch && request.method === "POST") {
    const missionId = decodeURIComponent(missionComputerSyncMatch[1] ?? "");
    const sync = await requestMissionComputerSync(env, missionId, "owner-sync");
    const computer = sync.status === "complete"
      ? sync.computer
      : await ensureMissionComputer(env, missionId);
    return json({ ok: true, computer, sync });
  }
  const missionComputerFileMatch = path.match(/^\/api\/missions\/([^/]+)\/computer\/file$/);
  if (missionComputerFileMatch && request.method === "GET") {
    const missionId = decodeURIComponent(missionComputerFileMatch[1] ?? "");
    const filePath = url.searchParams.get("path") ?? "/mission.md";
    return json({ ok: true, ...(await readMissionComputerFile(env, missionId, filePath)) });
  }
  const missionComputerSearchMatch = path.match(/^\/api\/missions\/([^/]+)\/computer\/search$/);
  if (missionComputerSearchMatch && request.method === "GET") {
    const missionId = decodeURIComponent(missionComputerSearchMatch[1] ?? "");
    return json({ ok: true, ...(await searchMissionComputer(env, missionId, url.searchParams.get("q") ?? "")) });
  }
  const missionComputerNotesMatch = path.match(/^\/api\/missions\/([^/]+)\/computer\/notes$/);
  if (missionComputerNotesMatch && request.method === "POST") {
    const missionId = decodeURIComponent(missionComputerNotesMatch[1] ?? "");
    const body = await readJson<{ title?: string; content?: string; file?: string }>(request, 250_000);
    return json({ ok: true, note: await appendMissionComputerNote(env, missionId, { title: body.title, content: body.content ?? "", file: body.file }) }, { status: 201 });
  }
  const missionComputerExportMatch = path.match(/^\/api\/missions\/([^/]+)\/computer\/export$/);
  if (missionComputerExportMatch && request.method === "GET") {
    const missionId = decodeURIComponent(missionComputerExportMatch[1] ?? "");
    return json({ ok: true, missionId, files: await exportMissionComputer(env, missionId) });
  }

  const missionBundleMatch = path.match(/^\/api\/missions\/([^/]+)\/bundle$/);
  if (missionBundleMatch && request.method === "GET") {
    return json(await buildMissionBundle(env, decodeURIComponent(missionBundleMatch[1] ?? "")));
  }
  const missionDeepDiveMatch = path.match(/^\/api\/missions\/([^/]+)\/deep-dive$/);
  if (missionDeepDiveMatch && request.method === "POST") {
    const missionId = decodeURIComponent(missionDeepDiveMatch[1] ?? "");
    return json({ ok: true, ...(await openDeepDive(env, `mission-${missionId}`, await buildMissionBundle(env, missionId))) }, { status: 201 });
  }
  const missionMatch = path.match(/^\/api\/missions\/([^/]+)$/);
  if (missionMatch && request.method === "GET") {
    const id = decodeURIComponent(missionMatch[1] ?? "");
    const mission = await getMission(env.DB, id);
    if (!mission) throw new HttpError(404, "Mission not found");
    return json({
      ok: true,
      mission,
      operator: await getMissionOperator(env.DB, id),
      researchState: await getMissionResearchState(env.DB, id),
      pendingResearchResults: (await listResearchResultImports(env.DB, { missionId: id, status: "pending", limit: 20 })).map((row) => ({ ...row, payload: parseJson(row.payload_json, {}), diff: parseJson(row.diff_json, {}) })),
      events: await listMissionEvents(env.DB, id, 100),
      matches: await listMissionMatches(env.DB, id, 100),
    });
  }
  if (missionMatch && request.method === "PUT") {
    const id = decodeURIComponent(missionMatch[1] ?? "");
    const [existingMission, existingOperator] = await Promise.all([
      getMission(env.DB, id),
      getMissionOperator(env.DB, id),
    ]);
    if (!existingMission) throw new HttpError(404, "Mission not found");
    const body = await readJson<Record<string, unknown>>(request);
    const mergedBody: Record<string, unknown> = {
      name: body.name ?? existingMission.name,
      question: body.question ?? existingMission.question,
      terms: body.terms ?? parseJson(existingMission.terms_json, []),
      sourceScope: body.sourceScope ?? parseJson(existingMission.source_scope_json, []),
      status: body.status ?? existingMission.status,
      priority: body.priority ?? existingMission.priority,
      cadenceMinutes: body.cadenceMinutes ?? existingMission.cadence_minutes,
      ...body,
    };
    const mission = missionFromBody(mergedBody, id);
    const operator = missionOperatorFromBody(body, id, existingOperator, mission.cadenceMinutes);
    await upsertMission(env.DB, mission);
    await upsertMissionOperator(env.DB, operator);
    if (body.outcomeStatus && body.outcomeStatus !== existingOperator?.outcome_status) {
      await recordMissionEvent(env.DB, {
        missionId: id,
        eventType: "outcome",
        title: `Mission outcome changed to ${String(body.outcomeStatus)}`,
        detail: operator.outcomeSummary,
        metadata: { previous: existingOperator?.outcome_status ?? "open", current: operator.outcomeStatus },
      });
    }
    const maintenance = await launchMissionMatchMaintenance(env, id, "mission-updated");
    return json({
      ok: true,
      mission,
      operator: await getMissionOperator(env.DB, id),
      matchMaintenance: maintenance,
    }, { status: maintenance.status === "queued" ? 202 : 200 });
  }
  if (missionMatch && request.method === "DELETE") {
    await deleteMission(env.DB, decodeURIComponent(missionMatch[1] ?? ""));
    return json({ ok: true });
  }
  const rebuildMatch = path.match(/^\/api\/missions\/([^/]+)\/rebuild$/);
  if (rebuildMatch && request.method === "GET") {
    if (!env.MISSION_WORKFLOW) throw new HttpError(409, "Mission Workflow binding is not configured");
    const workflowId = url.searchParams.get("workflowId")?.trim() ?? "";
    if (!workflowId.startsWith("mission-match-") || workflowId.length > 100) {
      throw new HttpError(400, "A valid Mission match maintenance workflowId is required");
    }
    const workflow = await env.MISSION_WORKFLOW.get(workflowId);
    return json({ ok: true, workflowId, workflow: await workflow.status() });
  }
  if (rebuildMatch && request.method === "POST") {
    const id = decodeURIComponent(rebuildMatch[1] ?? "");
    const maintenance = await launchMissionMatchMaintenance(env, id, "mission-rebuilt");
    return json({ ok: true, matchMaintenance: maintenance }, { status: maintenance.status === "queued" ? 202 : 200 });
  }

  if (path === "/api/briefings/latest" && request.method === "GET") return json({ ok: true, briefing: await latestBriefing(env.DB) });
  if (path === "/api/briefings/generate" && request.method === "POST") {
    const body = await readJson<{ hours?: number }>(request);
    const briefing = await generateBriefing(env, body.hours ?? 24);
    ctx.waitUntil(syncAISearchIfEnabled(env, { waitForLast: true }).catch((error) => console.error("AI Search sync failed", error)));
    return json({ ok: true, ...briefing });
  }

  if (path === "/api/manual" && request.method === "POST") {
    const body = await readJson<NormalizedItemInput>(request);
    await ensureManualSource(env);
    if (body.url && !body.text) {
      await requireIngestQueueDurability(env);
      const source: SourceRecord = {
        id: "manual-inbox", name: "Manual inbox", kind: "web",
        config_json: JSON.stringify({ url: body.url, title: body.title, renderStrategy: "adaptive", mode: "article" }),
        enabled: 1, schedule_minutes: 10_080, weight: 1.4, last_run_at: null, last_success_at: null,
        last_error: null, health_score: 1, created_at: isoNow(), updated_at: isoNow(),
      };
      const collected = await collectWeb(source, env);
      await enqueueIngestMessages(
        env,
        collected.items.map((item) => ({ sourceId: "manual-inbox", item, provider: collected.provider })),
      );
      return json({ ok: true, queued: collected.items.length, provider: collected.provider });
    }
    if (!body.title) throw new HttpError(400, "title or URL is required");
    await enqueueIngestMessages(env, [{ sourceId: "manual-inbox", item: body, provider: "manual" }]);
    return json({ ok: true, queued: 1 });
  }

  if (path === "/api/render/inspect" && request.method === "POST") {
    const body = await readJson<{ url?: string; strategy?: "adaptive" | "direct" | "kitesurf" | "chromium"; selector?: string }>(request);
    if (!body.url) throw new HttpError(400, "url is required");
    const target = assertPublicHttpUrl(body.url);
    const rendered = await renderAdaptive({ url: target, env, selector: body.selector, strategy: body.strategy ?? "adaptive" });
    return json({
      ok: true,
      engine: rendered.engine,
      title: rendered.title,
      finalUrl: rendered.finalUrl,
      text: rendered.text.slice(0, 120_000),
      preview: excerpt(rendered.text, 800),
      elapsedMs: rendered.elapsedMs,
      browserMs: rendered.browserMs,
      attempts: rendered.attempts,
    });
  }
  if (path === "/api/render/stats" && request.method === "GET") return json({ ok: true, ...(await listRenderStats(env.DB)) });
  if (path === "/api/email/receipts" && request.method === "GET") return json({ ok: true, receipts: await listInboxReceipts(env.DB) });

  if (path === "/api/packs" && request.method === "GET") {
    const community = await loadCommunityLensCatalog(request, env);
    return json({
      ok: true,
      packs: [
        ...STARTER_PACKS.map((pack) => ({ ...pack, lensType: "builtin" })),
        ...community.map((entry) => ({ ...((entry.lens && typeof entry.lens === "object") ? entry.lens as Record<string, unknown> : {}), lensType: "community", installUrl: entry.installUrl })),
      ],
    });
  }
  if (path === "/api/lenses/catalog" && request.method === "GET") {
    const community = await loadCommunityLensCatalog(request, env);
    return json({
      ok: true,
      lenses: [
        ...STARTER_PACKS.map((pack) => ({
          id: pack.id, name: pack.name, description: pack.description, category: pack.category, icon: pack.icon,
          featured: Boolean(pack.featured), requiresCompanion: Boolean(pack.requiresCompanion), sourceCount: pack.sources.length, lensType: "builtin",
        })),
        ...community.map(({ lens, ...entry }) => ({ ...entry, lensType: "community" })),
      ],
    });
  }
  if (path === "/api/lenses/schema" && request.method === "GET") {
    return json({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Driftglass Lens",
      type: "object",
      required: ["driftglassLens", "id", "name", "description", "sources"],
      properties: {
        driftglassLens: { const: "1" }, id: { type: "string" }, name: { type: "string" }, description: { type: "string" },
        sources: { type: "array", minItems: 1 }, missions: { type: "array" }, interestTerms: { type: "array", items: { type: "string" } },
      },
    });
  }
  if (path === "/api/lenses/import" && request.method === "POST") {
    const body = await readJson<unknown>(request, 2_000_000);
    const lens = parsePortableLens(body && typeof body === "object" && "lens" in body ? (body as { lens?: unknown }).lens : body);
    const installed = await installPortableLens(env, lens);
    return json({ ok: true, lens, ...installed }, { status: 201 });
  }
  if (path === "/api/lenses/install-url" && request.method === "POST") {
    const body = await readJson<{ url?: string }>(request);
    if (!body.url) throw new HttpError(400, "Lens URL is required");
    const lens = await fetchPortableLens(body.url);
    const installed = await installPortableLens(env, lens);
    return json({ ok: true, lens, ...installed }, { status: 201 });
  }
  const packExportMatch = path.match(/^\/api\/packs\/([^/]+)\/export$/);
  if (packExportMatch && request.method === "GET") {
    const pack = getStarterPack(decodeURIComponent(packExportMatch[1] ?? ""));
    if (!pack) throw new HttpError(404, "Starter Lens not found");
    return json(starterPackAsLens(pack));
  }
  const packMatch = path.match(/^\/api\/packs\/([^/]+)\/apply$/);
  if (packMatch && request.method === "POST") {
    const pack = getStarterPack(decodeURIComponent(packMatch[1] ?? ""));
    if (!pack) throw new HttpError(404, "Starter pack not found");
    const body = await readJson<{ runNow?: boolean }>(request);
    await applyStarterPack(env, pack);
    const { profile, executionCapacity } = await getBudgetProfile(env.DB);
    const plan = starterPackSourcePlan(executionCapacity, body.runNow !== false, pack.sources.length);
    const immediateLimit = plan.immediate;
    if (immediateLimit > 0) {
      ctx.waitUntil((async () => {
        let resumedOutbox = false;
        for (const definition of pack.sources.slice(0, immediateLimit)) {
          const source = await getSource(env.DB, definition.id);
          if (source) {
            await runSourceWithBoundaryFallback(
              ctx.exports.SourceRunBoundary,
              source,
              env,
              { resumeOutbox: !resumedOutbox },
            )
              .catch((error) => console.error(`Starter source ${source.id} failed`, error));
            resumedOutbox = true;
          }
        }
      })());
    }
    return json({
      ok: true,
      pack: pack.id,
      profile,
      ...plan,
    }, { status: 202 });
  }

  if (path === "/api/settings/interests" && request.method === "GET") {
    return json({ ok: true, terms: parseJson<unknown>(await getSetting(env.DB, "interest_terms"), []) });
  }
  if (path === "/api/settings/interests" && request.method === "PUT") {
    const body = await readJson<{ terms?: string[] }>(request);
    const terms = normalizeStringArray(body.terms).slice(0, 300);
    await setSetting(env.DB, "interest_terms", JSON.stringify(terms));
    return json({ ok: true, terms });
  }

  if (path === "/api/taste" && request.method === "GET") {
    return json({ ok: true, profile: await getTasteProfile(env) });
  }
  if (path === "/api/taste" && request.method === "DELETE") {
    await clearTasteProfile(env.DB);
    return json({ ok: true });
  }

  if (path === "/api/shares" && request.method === "GET") {
    const shares = await listPublicShares(env.DB, 50);
    return json({ ok: true, shares: shares.map(({ token_hash: _tokenHash, payload_json: _payload, ...share }) => share) });
  }
  if (path === "/api/shares" && request.method === "POST") {
    const body = await readJson<{ kind?: "story" | "mission" | "briefing"; id?: string; expiresDays?: number; reviewedRunId?: string }>(request);
    if (!body.kind || !["story", "mission", "briefing"].includes(body.kind)) throw new HttpError(400, "Share kind must be story, mission, or briefing");
    const share = await createPublicShare(request, env, {
      kind: body.kind,
      id: body.id,
      expiresDays: body.expiresDays,
      reviewedRunId: body.reviewedRunId?.trim() || undefined,
    });
    return json({ ok: true, share }, { status: 201 });
  }

  if (path === "/api/feedback" && request.method === "GET") return json({ ok: true, feedback: await listRecentFeedback(env.DB) });
  if (path === "/api/feedback" && request.method === "POST") {
    const body = await readJson<{ storyId?: string; action?: string; note?: string }>(request);
    if (!body.action || !FEEDBACK_ACTIONS.includes(body.action)) throw new HttpError(400, "Unsupported feedback action");
    const id = await recordFeedback(env.DB, { storyId: body.storyId, action: body.action, note: body.note });
    const learned = body.storyId ? await learnFromFeedback(env, { storyId: body.storyId, action: body.action }) : { termsLearned: 0, sourcesLearned: 0 };
    return json({ ok: true, id, learned });
  }

  const deepDiveFileMatch = path.match(/^\/api\/deep-dives\/([^/]+)\/file$/);
  if (deepDiveFileMatch && request.method === "GET") {
    const caseId = slug(decodeURIComponent(deepDiveFileMatch[1] ?? ""));
    const filePath = (url.searchParams.get("path") || "/dossier.md").slice(0, 300);
    const upstream = await deepDiveFetch(env, `/cases/${encodeURIComponent(caseId)}/file?path=${encodeURIComponent(filePath)}`);
    if (!upstream.ok) {
      const payload = await readOptionalDeepDiveJson(upstream, 64_000, "Computer Power Mode error exceeds 64 KB");
      throw new HttpError(502, typeof payload.error === "string" ? payload.error : `Computer Power Mode returned HTTP ${upstream.status}`);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  const deepDiveExportMatch = path.match(/^\/api\/deep-dives\/([^/]+)\/export$/);
  if (deepDiveExportMatch && request.method === "GET") {
    const caseId = slug(decodeURIComponent(deepDiveExportMatch[1] ?? ""));
    const upstream = await deepDiveFetch(env, `/cases/${encodeURIComponent(caseId)}/export`);
    if (!upstream.ok) {
      const payload = await readOptionalDeepDiveJson(upstream, 64_000, "Computer Power Mode error exceeds 64 KB");
      throw new HttpError(502, typeof payload.error === "string" ? payload.error : `Computer Power Mode returned HTTP ${upstream.status}`);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "text/markdown; charset=utf-8",
        "content-disposition": upstream.headers.get("content-disposition") || `attachment; filename="${caseId}-dossier.md"`,
        "cache-control": "no-store",
      },
    });
  }

  if (path === "/api/ai-search/status" && request.method === "GET") {
    return json({ ok: true, semanticMemory: await aiSearchStatus(env) });
  }
  if (path === "/api/ai-search/setup" && request.method === "POST") {
    await setupAISearch(env);
    return json({ ok: true, semanticMemory: await aiSearchStatus(env) }, { status: 201 });
  }
  if (path === "/api/ai-search/sync" && request.method === "POST") {
    const body = await readJson<{ force?: boolean; wait?: boolean; waitForLast?: boolean }>(request)
      .catch((): { force?: boolean; wait?: boolean; waitForLast?: boolean } => ({}));
    const wait = body.wait ?? body.waitForLast ?? false;
    await assertAISearchEnabled(env);
    if (wait) {
      return json({ ok: true, sync: await syncAISearch(env, { force: Boolean(body.force), waitForLast: true }) });
    }
    ctx.waitUntil(syncAISearch(env, { force: Boolean(body.force), waitForLast: true }).catch((error) => console.error("AI Search sync failed", error)));
    return json({ ok: true, scheduled: true }, { status: 202 });
  }
  if (path === "/api/ai-search/search" && request.method === "POST") {
    const body = await readJson<{ query?: string; limit?: number; threshold?: number; kind?: string }>(request);
    const query = String(body.query ?? "").trim();
    if (!query) throw new HttpError(400, "Search query is required");
    return json({ ok: true, ...(await semanticSearch(env, query, { limit: body.limit, threshold: body.threshold, kind: body.kind })) });
  }

  if (path === "/api/collectors" && request.method === "GET") {
    const collectors = await listCollectorHealth(env.DB);
    return json({ ok: true, collectors, catalog: catalogEntriesFromCollectors(collectors) });
  }
  if (path === "/api/collectors/pairing" && request.method === "POST") {
    const body = await readJson<{ name?: string }>(request);
    const code = randomToken(6).toUpperCase();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await createPairingCode(env.DB, { codeHash: await sha256(code), name: (body.name ?? "Local relay").slice(0, 120), expiresAt });
    return json({ ok: true, code, expiresAt });
  }

  if (path === "/api/integrations" && request.method === "GET") {
    const base = baseUrlFor(request, env.PUBLIC_BASE_URL);
    const { readKey, operationsKey } = await deriveMcpCapabilityKeys(env.DRIFTGLASS_SECRET);
    const packetUrl = `${base}/packet/${readKey}/latest.md`;
    const pulsePacketUrl = `${base}/packet/${readKey}/pulse.md`;
    const [missions, semanticMemory] = await Promise.all([
      listMissions(env.DB, "active"),
      aiSearchStatus(env),
    ]);
    return json({
      ok: true,
      packetUrl,
      pulsePacketUrl,
      mcpUrl: `${base}/mcp/${readKey}`,
      operationsMcpUrl: `${base}/mcp/${operationsKey}/ops`,
      aiSearchCorpusUrl: `${base}/corpus/${readKey}/index.html`,
      aiSearchSitemapUrl: `${base}/corpus/${readKey}/sitemap.xml`,
      semanticMemory,
      scheduledTaskPrompt: scheduledBriefingTaskPrompt(packetUrl),
      pulseTaskPrompt: pulseTaskPrompt(pulsePacketUrl),
      missions: missions.map((mission) => {
        const missionPacketUrl = `${base}/packet/${readKey}/mission/${encodeURIComponent(mission.id)}.md`;
        const deepResearchPacketUrl = `${base}/packet/${readKey}/mission/${encodeURIComponent(mission.id)}/deep-research.md`;
        return {
          id: mission.id,
          name: mission.name,
          question: mission.question,
          packetUrl: missionPacketUrl,
          deepResearchPacketUrl,
          scheduledTaskPrompt: scheduledBriefingTaskPrompt(missionPacketUrl),
        };
      }),
      deepDiveLab: {
        configured: deepDiveConfigured(env),
        url: env.DEEP_DIVE_LAB_URL ? assertPublicHttpUrl(env.DEEP_DIVE_LAB_URL).origin : null,
      },
      emailIntake: `Route an address on a Cloudflare Email Routing domain to this Worker to create an always-on newsletter/save inbox.`,
      notes: [
        "Driftglass owns continuous evidence, Story memory, Mission state, and meaningful-change detection; ChatGPT owns final synthesis.",
        "Deep Research handoffs are prepared for broad one-off investigations rather than routine monitoring.",
        "Kitesurf is the first browser fallback; Chromium is selected automatically for pages that need it.",
        "Cloudflare AI Search is the semantic-memory plane; D1 remains canonical and the private MCP resolves exact Story and Mission records.",
      ],
    });
  }

  ctx.waitUntil(Promise.resolve());
  throw new HttpError(404, "API endpoint not found");
}
