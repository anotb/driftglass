import {
  deleteIntelligencePackOverlay,
  getIntelligencePack,
  getIntelligencePackOverlay,
  getIntelligenceRoutine,
  getReasoningReceipt,
  listIntelligencePackOverlays,
  listIntelligenceRoutineRuns,
  listIntelligenceRoutines,
  listEvidenceLineage,
  listMemoryCheckpoints,
  listReasoningReceipts,
  listReasoningRuns,
  listSourceCadence,
  upsertIntelligencePackOverlay,
  upsertIntelligenceRoutine,
} from "./db";
import { backfillEvidenceLineage } from "./evidence-lineage";
import { buildLivingDossier, livingDossierMarkdown } from "./dossiers";
import { judgmentOverview } from "./judgment";
import { sourceScorecards } from "./source-scorecards";
import {
  createDecision,
  decisionCalibrationSummary,
  getDecision,
  listDecisionReviews,
  listDecisions,
  reviewDecision,
  updateDecision,
} from "./decision-ledger";
import { normalizeIntelligenceRoutine, startIntelligenceRoutine } from "./intelligence-routines";
import { createMemoryCheckpoint, diffMemorySnapshots, readMemoryCheckpointSnapshot } from "./memory-checkpoints";
import {
  createPackOverlay,
  deriveInstalledPackOverlay,
  effectiveIntelligencePack,
  listPackSnapshots,
} from "./pack-overlays";
import {
  beginReasoningRun,
  compareReasoningRuns,
  completeReasoningRun,
  prepareReasoningReceipt,
  recordReasoningResult,
  reasoningReceiptDetail,
  reviewReasoningRun,
} from "./reasoning-ledger";
import {
  enqueueReasoningTask,
  getReasoningTask,
  listReasoningTasks,
  materializeReasoningTask,
  nextReasoningTask,
  reasoningTaskPrompt,
  refreshReasoningTaskQueue,
  setReasoningTaskStatus,
} from "./reasoning-tasks";
import { planRuntimeForEnv, runtimeCapabilityCatalog, runtimeContext } from "./runtime-router";
import type {
  DecisionStatus,
  DecisionType,
  Env,
  IntelligencePackManifest,
  IntelligencePackOverlayPatch,
  IntelligenceRoutineDefinition,
  IntelligenceRoutineStep,
  MemoryCheckpointRecord,
  ReasoningSourceScope,
  ReasoningTarget,
  ReasoningTask,
  ReasoningTaskStatus,
  RuntimeTaskSpec,
} from "./types";
import { HttpError, isoNow, json, markdown, normalizeStringArray, numberFrom, parseJson, readJson } from "./utils";

const REASONING_TASKS = new Set<ReasoningTask>(["daily-brief", "investigate", "decision", "challenge", "deep-research", "memory-update"]);
const REASONING_TARGETS = new Set<ReasoningTarget>(["chatgpt", "claude", "grok", "generic"]);
const REASONING_SOURCE_SCOPES = new Set<ReasoningSourceScope>(["open", "personal", "share"]);
const ROUTINE_ACTIONS = new Set([
  "refresh-sources", "wait-for-ingest", "rebuild-mission", "sync-computer",
  "audit-memory", "compile-context", "prepare-research", "checkpoint-memory",
]);

const EVIDENCE_LINEAGE_LIMIT_DEFAULT = 100;
const EVIDENCE_LINEAGE_LIMIT_MAX = 500;

function evidenceLineageQuery(url: URL): {
  storyId?: string;
  familyKey?: string;
  limit: number;
} | null {
  const names = ["storyId", "familyKey", "limit"] as const;
  if (!names.some((name) => url.searchParams.has(name))) return null;

  const one = (name: typeof names[number], maxLength: number): string | undefined => {
    const values = url.searchParams.getAll(name);
    if (!values.length) return undefined;
    if (values.length > 1) throw new HttpError(400, `${name} may be provided only once`);
    const value = values[0]!.trim();
    if (!value) throw new HttpError(400, `${name} must not be empty`);
    if (value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new HttpError(400, `${name} is invalid`);
    }
    return value;
  };

  const storyId = one("storyId", 200);
  const familyKey = one("familyKey", 240);
  const rawLimit = one("limit", 10);
  if (rawLimit && !/^[1-9]\d*$/.test(rawLimit)) {
    throw new HttpError(400, `limit must be an integer between 1 and ${EVIDENCE_LINEAGE_LIMIT_MAX}`);
  }
  const limit = rawLimit ? Number(rawLimit) : EVIDENCE_LINEAGE_LIMIT_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVIDENCE_LINEAGE_LIMIT_MAX) {
    throw new HttpError(400, `limit must be an integer between 1 and ${EVIDENCE_LINEAGE_LIMIT_MAX}`);
  }
  return { storyId, familyKey, limit };
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || crypto.randomUUID();
}

function parseRoutineBody(body: Record<string, unknown>): IntelligenceRoutineDefinition {
  const name = String(body.name ?? "").trim().slice(0, 180);
  if (!name) throw new HttpError(400, "Routine name is required");
  const id = slug(String(body.id ?? name));
  const steps = (Array.isArray(body.steps) ? body.steps : []).slice(0, 16).map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new HttpError(400, `Routine step ${index + 1} is invalid`);
    const step = entry as Record<string, unknown>;
    const action = String(step.action ?? "") as IntelligenceRoutineStep["action"];
    if (!ROUTINE_ACTIONS.has(action)) throw new HttpError(400, `Routine step ${index + 1} has unsupported action ${action}`);
    const runtime = ["auto", "worker", "kitesurf", "chromium", "computer", "companion"].includes(String(step.runtime))
      ? String(step.runtime) as IntelligenceRoutineStep["runtime"]
      : "auto";
    return {
      id: slug(String(step.id ?? `${id}-step-${index + 1}`)),
      name: typeof step.name === "string" ? step.name.trim().slice(0, 180) : undefined,
      action,
      runtime,
      optional: step.optional === true,
      sourceIds: normalizeStringArray(step.sourceIds).slice(0, 30),
      waitSeconds: step.waitSeconds == null ? undefined : Math.max(1, Math.min(300, numberFrom(step.waitSeconds, 30))),
      reasoningTask: REASONING_TASKS.has(String(step.reasoningTask) as ReasoningTask) ? String(step.reasoningTask) as ReasoningTask : undefined,
      target: REASONING_TARGETS.has(String(step.target) as ReasoningTarget) ? String(step.target) as ReasoningTarget : undefined,
      args: step.args && typeof step.args === "object" && !Array.isArray(step.args) ? step.args as Record<string, unknown> : {},
    };
  });
  if (!steps.length) throw new HttpError(400, "Routine needs at least one bounded step");
  try {
    return normalizeIntelligenceRoutine({
      id,
      name,
      description: String(body.description ?? "").trim().slice(0, 1_500),
      missionId: typeof body.missionId === "string" && body.missionId.trim() ? body.missionId.trim().slice(0, 120) : undefined,
      enabled: body.enabled !== false,
      scheduleMinutes: body.scheduleMinutes == null ? null : Math.max(30, Math.min(43_200, numberFrom(body.scheduleMinutes, 360))),
      budgetClass: ["light", "standard", "deep"].includes(String(body.budgetClass)) ? String(body.budgetClass) as IntelligenceRoutineDefinition["budgetClass"] : "light",
      trigger: ["manual", "scheduled", "evidence-change", "expected-event"].includes(String(body.trigger)) ? String(body.trigger) as IntelligenceRoutineDefinition["trigger"] : body.scheduleMinutes ? "scheduled" : "manual",
      steps,
    });
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Routine definition is invalid");
  }
}

export async function handleV09Api(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/runtime" && request.method === "GET") {
    return json({ ok: true, context: await runtimeContext(env), capabilities: runtimeCapabilityCatalog() });
  }
  if (path === "/api/runtime/plan" && request.method === "POST") {
    const body = await readJson<RuntimeTaskSpec>(request);
    return json({ ok: true, plan: await planRuntimeForEnv(env, body) });
  }

  if (path === "/api/judgment" && request.method === "GET") {
    return json({ ok: true, ...(await judgmentOverview(env)) });
  }
  if (path === "/api/dossiers" && request.method === "GET") {
    const scopeKind = ["global", "mission", "story", "query"].includes(String(url.searchParams.get("scopeKind")))
      ? String(url.searchParams.get("scopeKind")) as "global" | "mission" | "story" | "query"
      : "global";
    const scopeId = url.searchParams.get("scopeId") || undefined;
    const query = url.searchParams.get("q") || undefined;
    const dossier = await buildLivingDossier(env, { scopeKind, scopeId, query });
    return url.searchParams.get("format") === "markdown"
      ? markdown(livingDossierMarkdown(dossier), { headers: { "cache-control": "no-store" } })
      : json({ ok: true, dossier });
  }
  if (path === "/api/source-scorecards" && request.method === "GET") {
    return json({ ok: true, ...(await sourceScorecards(env.DB, numberFrom(url.searchParams.get("days"), 30))) });
  }

  if (path === "/api/routines" && request.method === "GET") {
    return json({ ok: true, routines: await listIntelligenceRoutines(env.DB, { limit: 200 }), runs: await listIntelligenceRoutineRuns(env.DB, { limit: 50 }) });
  }
  if (path === "/api/routines" && request.method === "POST") {
    const definition = parseRoutineBody(await readJson<Record<string, unknown>>(request));
    const nextRunAt = definition.enabled !== false && definition.trigger === "scheduled" && definition.scheduleMinutes
      ? new Date(Date.now() + definition.scheduleMinutes * 60_000).toISOString()
      : null;
    await upsertIntelligenceRoutine(env.DB, {
      id: definition.id,
      missionId: definition.missionId ?? null,
      name: definition.name,
      description: definition.description,
      definition: definition as unknown as Record<string, unknown>,
      enabled: definition.enabled !== false,
      scheduleMinutes: definition.scheduleMinutes,
      nextRunAt,
    });
    return json({ ok: true, routine: await getIntelligenceRoutine(env.DB, definition.id) }, { status: 201 });
  }
  const routineRunMatch = path.match(/^\/api\/routines\/([^/]+)\/run$/);
  if (routineRunMatch && request.method === "POST") {
    const run = await startIntelligenceRoutine(env, decodeURIComponent(routineRunMatch[1] ?? ""), { trigger: "manual" });
    return json({ ok: true, run }, { status: run.status === "deferred" ? 200 : 202 });
  }
  if (path === "/api/routine-runs" && request.method === "GET") {
    return json({ ok: true, runs: await listIntelligenceRoutineRuns(env.DB, { routineId: url.searchParams.get("routineId") || undefined, status: url.searchParams.get("status") || undefined, limit: numberFrom(url.searchParams.get("limit"), 50) }) });
  }

  if (path === "/api/memory/checkpoints" && request.method === "GET") {
    return json({ ok: true, checkpoints: await listMemoryCheckpoints(env.DB, { scopeKind: url.searchParams.get("scopeKind") || undefined, scopeId: url.searchParams.get("scopeId") || undefined, limit: numberFrom(url.searchParams.get("limit"), 50) }) });
  }
  if (path === "/api/memory/checkpoints" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const scopeKind = ["global", "mission", "story", "pack"].includes(String(body.scopeKind)) ? String(body.scopeKind) as MemoryCheckpointRecord["scope_kind"] : "global";
    const result = await createMemoryCheckpoint(env, {
      scopeKind,
      scopeId: typeof body.scopeId === "string" ? body.scopeId : null,
      title: typeof body.title === "string" ? body.title : undefined,
      reason: typeof body.reason === "string" ? body.reason : "Manual checkpoint",
      force: body.force === true,
    });
    return json({ ok: true, ...result }, { status: result.created ? 201 : 200 });
  }
  if (path === "/api/memory/checkpoints/compare" && request.method === "GET") {
    const scopeKind = url.searchParams.get("scopeKind") || "global";
    const scopeId = url.searchParams.get("scopeId") || undefined;
    let from: MemoryCheckpointRecord | null = null;
    let to: MemoryCheckpointRecord | null = null;
    const fromId = url.searchParams.get("from");
    const toId = url.searchParams.get("to");
    if (fromId) from = await env.DB.prepare("SELECT * FROM memory_checkpoints WHERE id = ?").bind(fromId).first<MemoryCheckpointRecord>();
    if (toId) to = await env.DB.prepare("SELECT * FROM memory_checkpoints WHERE id = ?").bind(toId).first<MemoryCheckpointRecord>();
    if (!from || !to) {
      const checkpoints = await listMemoryCheckpoints(env.DB, { scopeKind, scopeId, limit: 2 });
      to ??= checkpoints[0] ?? null;
      from ??= checkpoints.find((checkpoint) => checkpoint.id !== to?.id) ?? null;
    }
    if (!to) throw new HttpError(404, "No Memory checkpoint exists for this scope");
    const toSnapshot = await readMemoryCheckpointSnapshot(env, to);
    if (!toSnapshot) throw new HttpError(404, "Latest Memory checkpoint snapshot is unavailable");
    if (!from) return json({ ok: true, from: null, to, diff: null, message: "A second checkpoint is needed before Driftglass can compare memory states." });
    const fromSnapshot = await readMemoryCheckpointSnapshot(env, from);
    if (!fromSnapshot) throw new HttpError(404, "Prior Memory checkpoint snapshot is unavailable");
    return json({ ok: true, from, to, diff: diffMemorySnapshots(fromSnapshot, toSnapshot, from.id) });
  }
  const checkpointMatch = path.match(/^\/api\/memory\/checkpoints\/([^/]+)$/);
  if (checkpointMatch && request.method === "GET") {
    const checkpoint = await env.DB.prepare("SELECT * FROM memory_checkpoints WHERE id = ?").bind(decodeURIComponent(checkpointMatch[1] ?? "")).first<MemoryCheckpointRecord>();
    if (!checkpoint) throw new HttpError(404, "Memory checkpoint not found");
    return json({ ok: true, checkpoint, snapshot: await readMemoryCheckpointSnapshot(env, checkpoint) });
  }

  if (path === "/api/reasoning/receipts" && request.method === "GET") {
    return json({ ok: true, receipts: await listReasoningReceipts(env.DB, { scopeKind: url.searchParams.get("scopeKind") || undefined, scopeId: url.searchParams.get("scopeId") || undefined, task: url.searchParams.get("task") || undefined, limit: numberFrom(url.searchParams.get("limit"), 50) }) });
  }
  if (path === "/api/reasoning/receipts" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const prepared = await prepareReasoningReceipt(env, {
      target: REASONING_TARGETS.has(String(body.target) as ReasoningTarget) ? String(body.target) as ReasoningTarget : "chatgpt",
      task: REASONING_TASKS.has(String(body.task) as ReasoningTask) ? String(body.task) as ReasoningTask : "investigate",
      scopeKind: ["global", "mission", "story"].includes(String(body.scopeKind)) ? String(body.scopeKind) as "global" | "mission" | "story" : "global",
      scopeId: typeof body.scopeId === "string" ? body.scopeId : undefined,
      objective: typeof body.objective === "string" ? body.objective : undefined,
      tokenBudget: numberFrom(body.tokenBudget, 18_000),
      sourceScope: REASONING_SOURCE_SCOPES.has(String(body.sourceScope) as ReasoningSourceScope)
        ? String(body.sourceScope) as ReasoningSourceScope
        : "personal",
    });
    return json({ ok: true, receipt: prepared.receipt, bundle: prepared.bundle, markdown: prepared.markdown }, { status: 201 });
  }
  const receiptMatch = path.match(/^\/api\/reasoning\/receipts\/([^/]+)$/);
  if (receiptMatch && request.method === "GET") return json({ ok: true, ...(await reasoningReceiptDetail(env, decodeURIComponent(receiptMatch[1] ?? ""))) });
  const receiptRunMatch = path.match(/^\/api\/reasoning\/receipts\/([^/]+)\/runs$/);
  if (receiptRunMatch && request.method === "POST") {
    const body = await readJson<{ provider?: string; model?: string; client?: string }>(request);
    const run = await beginReasoningRun(env, { receiptId: decodeURIComponent(receiptRunMatch[1] ?? ""), provider: body.provider ?? "subscription-client", model: body.model, client: body.client });
    return json({ ok: true, run }, { status: 201 });
  }
  const receiptResultMatch = path.match(/^\/api\/reasoning\/receipts\/([^/]+)\/results$/);
  if (receiptResultMatch && request.method === "POST") {
    const receiptId = decodeURIComponent(receiptResultMatch[1] ?? "");
    const body = await readJson<Record<string, unknown>>(request, 2_000_000);
    const provider = String(body.provider ?? "subscription-client").trim().slice(0, 100);
    const completed = await recordReasoningResult(env, {
      receiptId,
      provider,
      model: typeof body.model === "string" ? body.model : undefined,
      client: typeof body.client === "string" ? body.client : undefined,
      response: typeof body.response === "string" ? body.response : "",
      summary: typeof body.summary === "string" ? body.summary : undefined,
      structuredResult: body.structuredResult && typeof body.structuredResult === "object" && !Array.isArray(body.structuredResult) ? body.structuredResult as Record<string, unknown> : undefined,
      outcome: body.outcome && typeof body.outcome === "object" && !Array.isArray(body.outcome) ? body.outcome as Record<string, unknown> : undefined,
      audit: body.audit && typeof body.audit === "object" && !Array.isArray(body.audit) ? body.audit as Record<string, unknown> : undefined,
      citations: Array.isArray(body.citations) ? body.citations : undefined,
      confidence: body.confidence == null ? undefined : numberFrom(body.confidence, 0.5),
      decisionNote: typeof body.decisionNote === "string" ? body.decisionNote : undefined,
      memoryPatch: body.memoryPatch,
    });
    return json({ ok: true, ...completed, comparison: await compareReasoningRuns(env, receiptId) }, { status: 201 });
  }
  const receiptCompareMatch = path.match(/^\/api\/reasoning\/receipts\/([^/]+)\/compare$/);
  if (receiptCompareMatch && request.method === "GET") {
    return json({ ok: true, comparison: await compareReasoningRuns(env, decodeURIComponent(receiptCompareMatch[1] ?? "")) });
  }
  if (path === "/api/reasoning/runs" && request.method === "GET") {
    return json({ ok: true, runs: await listReasoningRuns(env.DB, { receiptId: url.searchParams.get("receiptId") || undefined, status: url.searchParams.get("status") || undefined, limit: numberFrom(url.searchParams.get("limit"), 50) }) });
  }
  const runCompleteMatch = path.match(/^\/api\/reasoning\/runs\/([^/]+)\/complete$/);
  if (runCompleteMatch && request.method === "POST") {
    return json({ ok: true, ...(await completeReasoningRun(env, decodeURIComponent(runCompleteMatch[1] ?? ""), await readJson(request, 2_000_000))) });
  }
  const runReviewMatch = path.match(/^\/api\/reasoning\/runs\/([^/]+)\/review$/);
  if (runReviewMatch && request.method === "POST") {
    const body = await readJson<{ decision?: "approve" | "reject"; rating?: number; note?: string }>(request);
    if (!body.decision) throw new HttpError(400, "Review decision is required");
    return json({ ok: true, run: await reviewReasoningRun(env, decodeURIComponent(runReviewMatch[1] ?? ""), body as { decision: "approve" | "reject"; rating?: number; note?: string }) });
  }

  if (path === "/api/reasoning/tasks" && request.method === "GET") {
    const status = url.searchParams.get("status") as ReasoningTaskStatus | null;
    return json({ ok: true, tasks: await listReasoningTasks(env.DB, { status: status ?? undefined, scopeKind: url.searchParams.get("scopeKind") || undefined, scopeId: url.searchParams.get("scopeId") || undefined, limit: numberFrom(url.searchParams.get("limit"), 50) }) });
  }
  if (path === "/api/reasoning/tasks" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const task = await enqueueReasoningTask(env, {
      scopeKind: ["global", "mission", "story", "dossier"].includes(String(body.scopeKind)) ? String(body.scopeKind) as any : "global",
      scopeId: typeof body.scopeId === "string" ? body.scopeId : null,
      task: REASONING_TASKS.has(String(body.task) as ReasoningTask) ? String(body.task) as ReasoningTask : "investigate",
      target: REASONING_TARGETS.has(String(body.target) as ReasoningTarget) ? String(body.target) as ReasoningTarget : "chatgpt",
      objective: String(body.objective ?? "").trim(),
      priority: numberFrom(body.priority, 0.5),
      reason: typeof body.reason === "string" ? body.reason : undefined,
      dueAt: typeof body.dueAt === "string" ? body.dueAt : null,
    });
    return json({ ok: true, task }, { status: 201 });
  }
  if (path === "/api/reasoning/tasks/refresh" && request.method === "POST") {
    return json({ ok: true, ...(await refreshReasoningTaskQueue(env, Math.max(1, Math.min(8, numberFrom(url.searchParams.get("limit"), 4))))) });
  }
  if (path === "/api/reasoning/tasks/next" && request.method === "GET") {
    const task = await nextReasoningTask(env);
    if (!task) return json({ ok: true, task: null, receipt: null, receiptState: "none", prompt: null });
    const receiptReady = task.status === "ready" && Boolean(task.receipt_id);
    return json({
      ok: true,
      task,
      receipt: receiptReady ? { id: task.receipt_id, status: "ready" } : null,
      receiptState: receiptReady ? "ready" : "not-materialized",
      prompt: reasoningTaskPrompt(task),
    });
  }
  const taskMaterializeMatch = path.match(/^\/api\/reasoning\/tasks\/([^/]+)\/materialize$/);
  if (taskMaterializeMatch && request.method === "POST") return json({ ok: true, task: await materializeReasoningTask(env, decodeURIComponent(taskMaterializeMatch[1] ?? "")) });
  const taskStatusMatch = path.match(/^\/api\/reasoning\/tasks\/([^/]+)\/status$/);
  if (taskStatusMatch && request.method === "POST") {
    const body = await readJson<{ status?: ReasoningTaskStatus; claimedBy?: string }>(request);
    if (!body.status) throw new HttpError(400, "Task status is required");
    await setReasoningTaskStatus(env.DB, decodeURIComponent(taskStatusMatch[1] ?? ""), { status: body.status, claimedBy: body.claimedBy });
    return json({ ok: true, task: await getReasoningTask(env.DB, decodeURIComponent(taskStatusMatch[1] ?? "")) });
  }

  if (path === "/api/decisions" && request.method === "GET") {
    return json({ ok: true, decisions: await listDecisions(env.DB, { status: url.searchParams.get("status") as DecisionStatus || undefined, missionId: url.searchParams.get("missionId") || undefined, storyId: url.searchParams.get("storyId") || undefined, limit: numberFrom(url.searchParams.get("limit"), 50) }), calibration: await decisionCalibrationSummary(env.DB) });
  }
  if (path === "/api/decisions" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const decision = await createDecision(env, {
      missionId: typeof body.missionId === "string" ? body.missionId : null,
      storyId: typeof body.storyId === "string" ? body.storyId : null,
      reasoningTaskId: typeof body.reasoningTaskId === "string" ? body.reasoningTaskId : null,
      reasoningReceiptId: typeof body.reasoningReceiptId === "string" ? body.reasoningReceiptId : null,
      decisionType: ["decision", "forecast", "commitment", "thesis"].includes(String(body.decisionType)) ? String(body.decisionType) as DecisionType : "decision",
      title: String(body.title ?? ""),
      statement: String(body.statement ?? ""),
      rationale: typeof body.rationale === "string" ? body.rationale : undefined,
      options: Array.isArray(body.options) ? body.options : [],
      evidence: Array.isArray(body.evidence) ? body.evidence : [],
      tags: normalizeStringArray(body.tags),
      confidence: numberFrom(body.confidence, 0.5),
      expectedOutcome: typeof body.expectedOutcome === "string" ? body.expectedOutcome : undefined,
      reviewAt: typeof body.reviewAt === "string" ? body.reviewAt : null,
    });
    return json({ ok: true, decision }, { status: 201 });
  }
  const decisionMatch = path.match(/^\/api\/decisions\/([^/]+)$/);
  if (decisionMatch && request.method === "GET") {
    const id = decodeURIComponent(decisionMatch[1] ?? "");
    const decision = await getDecision(env.DB, id);
    if (!decision) throw new HttpError(404, "Decision not found");
    return json({ ok: true, decision, reviews: await listDecisionReviews(env.DB, id) });
  }
  if (decisionMatch && request.method === "PUT") {
    const body = await readJson<Record<string, unknown>>(request);
    return json({ ok: true, decision: await updateDecision(env, decodeURIComponent(decisionMatch[1] ?? ""), {
      status: typeof body.status === "string" ? body.status as DecisionStatus : undefined,
      statement: typeof body.statement === "string" ? body.statement : undefined,
      rationale: typeof body.rationale === "string" ? body.rationale : undefined,
      confidence: body.confidence == null ? undefined : numberFrom(body.confidence, 0.5),
      expectedOutcome: typeof body.expectedOutcome === "string" ? body.expectedOutcome : undefined,
      reviewAt: body.reviewAt === null || typeof body.reviewAt === "string" ? body.reviewAt as string | null : undefined,
    }) });
  }
  const decisionReviewMatch = path.match(/^\/api\/decisions\/([^/]+)\/review$/);
  if (decisionReviewMatch && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    return json({ ok: true, ...(await reviewDecision(env, decodeURIComponent(decisionReviewMatch[1] ?? ""), {
      observedOutcome: String(body.observedOutcome ?? ""),
      actualValue: body.actualValue == null ? null : numberFrom(body.actualValue, 0),
      qualityScore: body.qualityScore == null ? null : numberFrom(body.qualityScore, 0.5),
      lesson: typeof body.lesson === "string" ? body.lesson : undefined,
      evidence: Array.isArray(body.evidence) ? body.evidence : [],
      provider: typeof body.provider === "string" ? body.provider : "owner",
      status: ["resolved", "reversed", "expired"].includes(String(body.status)) ? String(body.status) as Exclude<DecisionStatus, "open"> : "resolved",
    })) });
  }

  if (path === "/api/evidence/lineage/backfill" && request.method === "POST") return json({ ok: true, ...(await backfillEvidenceLineage(env, numberFrom(url.searchParams.get("limit"), 100))) });
  if (path === "/api/evidence/lineage" && request.method === "GET") {
    const filters = evidenceLineageQuery(url);
    if (filters) {
      return json({
        ok: true,
        filters,
        lineage: await listEvidenceLineage(env.DB, filters),
      });
    }
    const rows = await env.DB.prepare(
      `SELECT relation, independent, COUNT(*) AS count FROM evidence_lineage GROUP BY relation, independent ORDER BY count DESC`,
    ).all<Record<string, unknown>>();
    return json({ ok: true, summary: rows.results ?? [] });
  }
  if (path === "/api/sources/cadence" && request.method === "GET") return json({ ok: true, cadence: await listSourceCadence(env.DB) });

  const overlaysMatch = path.match(/^\/api\/intelligence-packs\/([^/]+)\/overlays$/);
  if (overlaysMatch && request.method === "GET") {
    const packId = decodeURIComponent(overlaysMatch[1] ?? "");
    const { listIntelligencePackOverlays } = await import("./db");
    return json({ ok: true, overlays: await listIntelligencePackOverlays(env.DB, packId), snapshots: await listPackSnapshots(env.DB, packId) });
  }
  if (overlaysMatch && request.method === "POST") {
    const packId = decodeURIComponent(overlaysMatch[1] ?? "");
    const packRow = await getIntelligencePack(env.DB, packId);
    if (!packRow) throw new HttpError(404, "Intelligence Pack not found");
    const body = await readJson<{ name?: string; description?: string; patch?: IntelligencePackOverlayPatch }>(request);
    if (!body.name || !body.patch) throw new HttpError(400, "Overlay name and patch are required");
    const pack = parseJson<IntelligencePackManifest>(packRow.manifest_json, {} as IntelligencePackManifest);
    return json({ ok: true, overlay: await createPackOverlay(env.DB, { packId, packVersion: pack.version, name: body.name, description: body.description, patch: body.patch }) }, { status: 201 });
  }
  const packForkMatch = path.match(/^\/api\/intelligence-packs\/([^/]+)\/fork$/);
  if (packForkMatch && (request.method === "POST" || request.method === "GET")) {
    const packId = decodeURIComponent(packForkMatch[1] ?? "");
    const packRow = await getIntelligencePack(env.DB, packId);
    if (!packRow) throw new HttpError(404, "Intelligence Pack not found");
    const body: { id?: string; name?: string; description?: string } = request.method === "POST"
      ? await readJson<{ id?: string; name?: string; description?: string }>(request).catch(() => ({}))
      : {};
    const base = parseJson<IntelligencePackManifest>(packRow.manifest_json, {} as IntelligencePackManifest);
    const effective = await effectiveIntelligencePack(env, base);
    const forkId = slug(body.id?.trim() || `${base.id}-fork`);
    const fork: IntelligencePackManifest = {
      ...effective.pack,
      driftglassPack: "3",
      id: forkId,
      version: "1.0.0",
      name: body.name?.trim().slice(0, 180) || `${base.name} · personal fork`,
      description: body.description?.trim().slice(0, 1_500) || `A portable personal fork of ${base.name}, preserving local source, Mission, evidence-policy, reasoning, and budget customizations.`,
      updateUrl: undefined,
      featured: false,
      lineage: {
        ...(effective.pack.lineage ?? {}),
        forkedFrom: base.updateUrl ?? packRow.source_url ?? undefined,
        upstreamPackId: base.id,
        upstreamVersion: base.version,
      },
    };
    return json({ ok: true, pack: fork, appliedOverlays: effective.overlays.map((overlay) => overlay.id), conflicts: effective.conflicts });
  }

  const overlayCaptureMatch = path.match(/^\/api\/intelligence-packs\/([^/]+)\/overlays\/capture$/);
  if (overlayCaptureMatch && request.method === "POST") {
    const packId = decodeURIComponent(overlayCaptureMatch[1] ?? "");
    const packRow = await getIntelligencePack(env.DB, packId);
    if (!packRow) throw new HttpError(404, "Intelligence Pack not found");
    const body = await readJson<{ name?: string; description?: string }>(request).catch(() => ({} as { name?: string; description?: string }));
    const pack = parseJson<IntelligencePackManifest>(packRow.manifest_json, {} as IntelligencePackManifest);
    const derived = await deriveInstalledPackOverlay(env, pack);
    const hasChanges = Object.values(derived.summary).some((value) => value > 0);
    if (!hasChanges) return json({ ok: true, created: false, summary: derived.summary, message: "No local differences were found." });
    const overlay = await createPackOverlay(env.DB, {
      packId,
      packVersion: pack.version,
      name: body.name?.trim() || `My ${pack.name} fork`,
      description: body.description ?? "Local source and Mission customizations preserved across upstream Pack updates.",
      patch: derived.patch,
    });
    return json({ ok: true, created: true, overlay, summary: derived.summary }, { status: 201 });
  }
  const overlayMatch = path.match(/^\/api\/intelligence-pack-overlays\/([^/]+)$/);
  if (overlayMatch && request.method === "GET") {
    const overlay = await getIntelligencePackOverlay(env.DB, decodeURIComponent(overlayMatch[1] ?? ""));
    if (!overlay) throw new HttpError(404, "Pack overlay not found");
    return json({ ok: true, overlay: { ...overlay, patch: parseJson(overlay.overlay_json, {}), conflicts: parseJson(overlay.conflicts_json, []) } });
  }
  if (overlayMatch && request.method === "DELETE") {
    await deleteIntelligencePackOverlay(env.DB, decodeURIComponent(overlayMatch[1] ?? ""));
    return json({ ok: true });
  }
  const overlayStatusMatch = path.match(/^\/api\/intelligence-pack-overlays\/([^/]+)\/status$/);
  if (overlayStatusMatch && request.method === "POST") {
    const id = decodeURIComponent(overlayStatusMatch[1] ?? "");
    const overlay = await getIntelligencePackOverlay(env.DB, id);
    if (!overlay) throw new HttpError(404, "Pack overlay not found");
    const body = await readJson<{ status?: "active" | "disabled" }>(request);
    const status = body.status === "disabled" ? "disabled" : "active";
    await upsertIntelligencePackOverlay(env.DB, {
      id: overlay.id, basePackId: overlay.base_pack_id, name: overlay.name, description: overlay.description,
      baseVersion: overlay.base_version, overlay: parseJson(overlay.overlay_json, {}), status, conflicts: [],
    });
    return json({ ok: true, overlay: await getIntelligencePackOverlay(env.DB, id) });
  }

  return null;
}
