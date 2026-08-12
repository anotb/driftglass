import {
  createIntelligenceRoutineRun,
  deferIntelligenceRoutineAttempt,
  dueIntelligenceRoutines,
  getIntelligenceRoutine,
  getIntelligenceRoutineRun,
  listIntelligenceRoutineRuns,
  listIntelligenceRoutines,
  markIntelligenceRoutineScheduled,
  upsertIntelligenceRoutine,
  updateIntelligenceRoutineRun,
} from "./db";
import { requireBudget } from "./budget";
import {
  allocateSourceBoundaryAttempts,
  OPTIONAL_SOURCE_MAX_ATTEMPTS,
  REQUIRED_SOURCE_MAX_ATTEMPTS,
} from "./source-execution-envelope";
import { planRuntimeTask, runtimeContext, type RuntimeContext } from "./runtime-router";
import type {
  Env,
  IntelligenceRoutineDefinition,
  IntelligenceRoutineRecord,
  IntelligenceRoutineRunRecord,
  IntelligenceRoutineStep,
  IntelligenceRoutineWorkflowParams,
  ReasoningTarget,
  ReasoningTask,
  RuntimePlan,
  RuntimeTaskSpec,
} from "./types";
import { isoNow, parseJson } from "./utils";

const ACTIONS = new Set<IntelligenceRoutineStep["action"]>([
  "refresh-sources", "wait-for-ingest", "rebuild-mission", "sync-computer",
  "audit-memory", "compile-context", "prepare-research", "checkpoint-memory",
]);
const RUNTIMES = new Set<NonNullable<IntelligenceRoutineStep["runtime"]>>([
  "auto", "worker", "kitesurf", "chromium", "computer", "companion",
]);
const REASONING_TASKS = new Set<ReasoningTask>([
  "daily-brief", "investigate", "decision", "challenge", "deep-research", "memory-update",
]);
const REASONING_TARGETS = new Set<ReasoningTarget>(["chatgpt", "claude", "grok", "generic"]);
const SCHEDULED_LAUNCH_FAILURE_DEFERRAL_MS = 60 * 60_000;
const ROUTINE_INPUT_SCAN_LIMIT = 512;
const ROUTINE_MISSION_ID_LIMIT = 160;
const ROUTINE_SOURCE_ID_LIMIT = 80;
const ROUTINE_OBJECTIVE_LIMIT = 1_500;
const ROUTINE_REASON_LIMIT = 500;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const ROUTINE_REFRESH_SOURCE_LIMIT = 30;
// Workflows retries.limit counts retries after the first callback attempt.
const WORKFLOW_DEFAULT_MAX_ATTEMPTS = 6;

function boundedText(value: unknown, limit: number): string {
  return String(value ?? "").replace(CONTROL_CHARACTERS, "").trim().slice(0, limit);
}

function slug(value: string): string {
  return value.slice(0, ROUTINE_INPUT_SCAN_LIMIT).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || crypto.randomUUID();
}

function boundedSchedule(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Math.max(30, Math.min(43_200, Math.round(value)));
}

function normalizeRoutineArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  if (typeof raw.objective === "string") {
    const objective = boundedText(raw.objective, ROUTINE_OBJECTIVE_LIMIT);
    if (objective) args.objective = objective;
  }
  if (typeof raw.reason === "string") {
    const reason = boundedText(raw.reason, ROUTINE_REASON_LIMIT);
    if (reason) args.reason = reason;
  }
  if (typeof raw.priority === "number" && Number.isFinite(raw.priority)) {
    args.priority = Math.max(0, Math.min(1, raw.priority));
  }
  if (typeof raw.expiresInHours === "number" && Number.isFinite(raw.expiresInHours)) {
    args.expiresInHours = Math.max(1, Math.min(8_760, Math.round(raw.expiresInHours)));
  }
  return args;
}

function refreshSourceExecutionCount(step: IntelligenceRoutineStep, missionId?: string): number {
  const explicitSources = [...new Set(step.sourceIds ?? [])].slice(0, ROUTINE_REFRESH_SOURCE_LIMIT).length;
  return explicitSources > 0 ? explicitSources : missionId ? ROUTINE_REFRESH_SOURCE_LIMIT : 0;
}

function routineSourceAttemptPlan(definition: IntelligenceRoutineDefinition): {
  attemptsByStep: number[];
} {
  const requests: Array<{ optional: boolean; stepIndex: number }> = [];
  for (const [stepIndex, step] of definition.steps.entries()) {
    if (step.action !== "refresh-sources") continue;
    const count = refreshSourceExecutionCount(step, definition.missionId);
    requests.push(...Array.from({ length: count }, () => ({ optional: Boolean(step.optional), stepIndex })));
  }
  const assigned = allocateSourceBoundaryAttempts(requests);
  const attemptsByStep = definition.steps.map(() => 0);
  assigned.forEach((attempts, index) => {
    const stepIndex = requests[index]!.stepIndex;
    attemptsByStep[stepIndex] = (attemptsByStep[stepIndex] ?? 0) + attempts;
  });
  return {
    attemptsByStep,
  };
}

function routineStepWorkflowAttempts(step: IntelligenceRoutineStep, sourceAttempts = 0): number {
  if (step.action === "wait-for-ingest") return 1 + REQUIRED_SOURCE_MAX_ATTEMPTS;
  if (step.action === "refresh-sources") return sourceAttempts;
  // Match maintenance launches a separately budgeted Workflow with a fresh
  // random instance ID. Retrying the parent callback after an ambiguous
  // success could reserve and launch the child twice, so this step is a
  // single-attempt handoff.
  if (step.action === "rebuild-mission") return 1;
  if (step.action === "sync-computer") return 5;
  return step.optional ? OPTIONAL_SOURCE_MAX_ATTEMPTS : REQUIRED_SOURCE_MAX_ATTEMPTS;
}

function routineWorkflowStepAttemptPlan(
  definition: IntelligenceRoutineDefinition,
  sourceAttemptsByStep: number[],
): number[] {
  let matchMaintenanceQueued = false;
  return definition.steps.map((step, stepIndex) => {
    if (step.action === "sync-computer" && matchMaintenanceQueued) return 0;
    const attempts = routineStepWorkflowAttempts(step, sourceAttemptsByStep[stepIndex]);
    if (step.action === "rebuild-mission") matchMaintenanceQueued = true;
    return attempts;
  });
}

function stepTask(
  step: IntelligenceRoutineStep,
  definition: IntelligenceRoutineDefinition,
  estimatedWorkflowSteps: number,
): RuntimeTaskSpec {
  switch (step.action) {
    case "refresh-sources": return { id: step.id, kind: "collect", description: step.name, missionId: definition.missionId, multiStep: Boolean(step.sourceIds?.length && step.sourceIds.length > 1), preferredRuntime: step.runtime ?? "auto", estimatedWorkflowSteps };
    case "wait-for-ingest": return { id: step.id, kind: "inspect", description: step.name, missionId: definition.missionId, persistence: "session", preferredRuntime: "worker", estimatedWorkflowSteps };
    case "rebuild-mission": return { id: step.id, kind: "compare", description: step.name, missionId: definition.missionId, persistence: "mission", preferredRuntime: step.runtime ?? "worker", estimatedWorkflowSteps };
    case "sync-computer": return { id: step.id, kind: "transform", description: step.name, missionId: definition.missionId, persistence: "mission", requiresFiles: true, preferredRuntime: step.runtime ?? "computer", estimatedWorkflowSteps };
    case "audit-memory": return { id: step.id, kind: "inspect", description: step.name, missionId: definition.missionId, persistence: "mission", preferredRuntime: step.runtime ?? "worker", estimatedWorkflowSteps };
    case "compile-context": return { id: step.id, kind: "compile-context", description: step.name, missionId: definition.missionId, persistence: "mission", preferredRuntime: step.runtime ?? "worker", estimatedWorkflowSteps };
    case "prepare-research": return { id: step.id, kind: "compile-context", description: step.name, missionId: definition.missionId, persistence: "mission", multiStep: true, preferredRuntime: step.runtime ?? "computer", estimatedWorkflowSteps };
    case "checkpoint-memory": return { id: step.id, kind: "transform", description: step.name, missionId: definition.missionId, persistence: "mission", requiresFiles: true, preferredRuntime: step.runtime ?? "computer", estimatedWorkflowSteps };
  }
}

export function normalizeIntelligenceRoutine(value: unknown): IntelligenceRoutineDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Routine must be an object");
  const raw = value as Record<string, unknown>;
  const name = boundedText(raw.name, 180);
  if (!name) throw new Error("Routine name is required");
  const id = slug(String(raw.id ?? name));
  const stepsRaw = Array.isArray(raw.steps) ? raw.steps.slice(0, 24) : [];
  if (!stepsRaw.length) throw new Error("Routine needs at least one step");
  const steps: IntelligenceRoutineStep[] = stepsRaw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Routine step ${index + 1} must be an object`);
    const step = entry as Record<string, unknown>;
    const action = boundedText(step.action, 64) as IntelligenceRoutineStep["action"];
    if (!ACTIONS.has(action)) throw new Error(`Unsupported routine action: ${action}`);
    const runtime = boundedText(step.runtime ?? "auto", 32) as NonNullable<IntelligenceRoutineStep["runtime"]>;
    if (!RUNTIMES.has(runtime)) throw new Error(`Unsupported routine runtime: ${runtime}`);
    const sourceIds = Array.isArray(step.sourceIds)
      ? step.sourceIds
        .filter((sourceId): sourceId is string => typeof sourceId === "string")
        .map((sourceId) => boundedText(sourceId, ROUTINE_SOURCE_ID_LIMIT))
        .filter(Boolean)
        .slice(0, 50)
      : undefined;
    const waitSeconds = typeof step.waitSeconds === "number" && Number.isFinite(step.waitSeconds)
      ? Math.max(1, Math.min(900, step.waitSeconds))
      : undefined;
    const reasoningTaskValue = boundedText(step.reasoningTask, 32) as ReasoningTask;
    const targetValue = boundedText(step.target, 32) as ReasoningTarget;
    return {
      id: slug(String(step.id ?? `${index + 1}-${action}`)),
      name: typeof step.name === "string" ? boundedText(step.name, 180) || undefined : undefined,
      action,
      runtime,
      optional: step.optional === true,
      sourceIds,
      waitSeconds,
      reasoningTask: REASONING_TASKS.has(reasoningTaskValue) ? reasoningTaskValue : undefined,
      target: REASONING_TARGETS.has(targetValue) ? targetValue : undefined,
      args: normalizeRoutineArgs(step.args),
    };
  });
  let hasUnsettledRefresh = false;
  for (const [index, step] of steps.entries()) {
    if (step.action === "refresh-sources") {
      hasUnsettledRefresh = true;
      continue;
    }
    if (step.action === "wait-for-ingest") {
      hasUnsettledRefresh = false;
      continue;
    }
    if (hasUnsettledRefresh) {
      throw new Error(
        `Routine step ${index + 1} (${step.action}) requires wait-for-ingest after refresh-sources`,
      );
    }
  }
  return {
    id,
    name,
    description: boundedText(raw.description, 1_500),
    missionId: typeof raw.missionId === "string" ? boundedText(raw.missionId, ROUTINE_MISSION_ID_LIMIT) || undefined : undefined,
    enabled: raw.enabled !== false,
    scheduleMinutes: boundedSchedule(raw.scheduleMinutes === null ? null : Number(raw.scheduleMinutes ?? 0) || null),
    budgetClass: ["light", "standard", "deep"].includes(boundedText(raw.budgetClass, 16)) ? boundedText(raw.budgetClass, 16) as IntelligenceRoutineDefinition["budgetClass"] : "standard",
    trigger: ["manual", "scheduled", "evidence-change", "expected-event"].includes(boundedText(raw.trigger, 32)) ? boundedText(raw.trigger, 32) as IntelligenceRoutineDefinition["trigger"] : "manual",
    steps,
  };
}

export async function saveIntelligenceRoutine(
  env: Env,
  input: unknown,
  options: { packId?: string | null; nextRunAt?: string | null } = {},
): Promise<IntelligenceRoutineRecord> {
  const definition = normalizeIntelligenceRoutine(input);
  const schedule = boundedSchedule(definition.scheduleMinutes);
  const nextRunAt = options.nextRunAt !== undefined
    ? options.nextRunAt
    : schedule ? new Date(Date.now() + schedule * 60_000).toISOString() : null;
  await upsertIntelligenceRoutine(env.DB, {
    id: definition.id,
    packId: options.packId ?? null,
    missionId: definition.missionId ?? null,
    name: definition.name,
    description: definition.description,
    definition: definition as unknown as Record<string, unknown>,
    enabled: definition.enabled !== false,
    scheduleMinutes: schedule,
    nextRunAt,
  });
  const saved = await getIntelligenceRoutine(env.DB, definition.id);
  if (!saved) throw new Error("Routine was saved but could not be read");
  return saved;
}

export function routineDefinition(record: IntelligenceRoutineRecord): IntelligenceRoutineDefinition {
  return normalizeIntelligenceRoutine(parseJson(record.definition_json, {}));
}

/** Pure per-step planning against one immutable runtime snapshot. */
export function planIntelligenceRoutineRuntime(
  definition: IntelligenceRoutineDefinition,
  context: RuntimeContext,
): RuntimePlan[] {
  const sourcePlan = routineSourceAttemptPlan(definition);
  const stepAttempts = routineWorkflowStepAttemptPlan(definition, sourcePlan.attemptsByStep);
  return definition.steps.map((step, stepIndex) => {
    const estimatedWorkflowSteps = stepAttempts[stepIndex] ?? 0;
    return planRuntimeTask(stepTask(step, definition, estimatedWorkflowSteps), context);
  });
}

export async function inspectIntelligenceRoutine(env: Env, id: string): Promise<Record<string, unknown>> {
  const record = await getIntelligenceRoutine(env.DB, id);
  if (!record) throw new Error(`Routine not found: ${id}`);
  const definition = routineDefinition(record);
  const plans = planIntelligenceRoutineRuntime(definition, await runtimeContext(env));
  const runs = await listIntelligenceRoutineRuns(env.DB, { routineId: id, limit: 20 });
  return { routine: record, definition, runtimePlans: plans, runs: runs.map((run) => ({ ...run, plan: parseJson(run.plan_json, {}), result: parseJson(run.result_json, {}) })) };
}

export function estimateIntelligenceRoutineWorkflowSteps(definition: IntelligenceRoutineDefinition): number {
  const sourcePlan = routineSourceAttemptPlan(definition);
  const stepAttempts = routineWorkflowStepAttemptPlan(definition, sourcePlan.attemptsByStep)
    .reduce((total, attempts) => total + attempts, 0);
  // Initialization and success finalization use the platform default retry
  // policy. A finalization failure can then enter the separately cached
  // failure step, so both terminal callbacks are reserved conservatively.
  return WORKFLOW_DEFAULT_MAX_ATTEMPTS * 3 + stepAttempts;
}

export async function startIntelligenceRoutine(
  env: Env,
  id: string,
  options: { trigger?: IntelligenceRoutineWorkflowParams["trigger"]; force?: boolean } = {},
): Promise<IntelligenceRoutineRunRecord> {
  const record = await getIntelligenceRoutine(env.DB, id);
  if (!record) throw new Error(`Routine not found: ${id}`);
  return startIntelligenceRoutineRecord(env, record, options);
}

async function startIntelligenceRoutineRecord(
  env: Env,
  record: IntelligenceRoutineRecord,
  options: { trigger?: IntelligenceRoutineWorkflowParams["trigger"]; force?: boolean } = {},
  context?: RuntimeContext,
): Promise<IntelligenceRoutineRunRecord> {
  if (record.enabled !== 1 && !options.force) throw new Error("Routine is disabled");
  if (!env.ROUTINE_WORKFLOW) throw new Error("ROUTINE_WORKFLOW binding is unavailable");
  const active = (await listIntelligenceRoutineRuns(env.DB, { routineId: record.id, limit: 10 })).find((run) => ["queued", "running"].includes(run.status));
  if (active && !options.force) return active;
  const definition = routineDefinition(record);
  const plans = planIntelligenceRoutineRuntime(definition, context ?? await runtimeContext(env));
  const steps = estimateIntelligenceRoutineWorkflowSteps(definition);
  await requireBudget(env.DB, "workflow_steps", steps, { operation: "intelligence-routine", routineId: record.id, budgetClass: definition.budgetClass ?? "standard" });
  const runId = `routine-run-${crypto.randomUUID()}`;
  // Pack and overlay records can contain `:` and other characters
  // that are valid D1 identifiers but invalid Cloudflare Workflow instance IDs.
  // The run ID is already unique, bounded, and platform-safe; keep the original
  // Routine ID in the payload and D1 mapping instead of embedding it here.
  const workflowId = runId;
  await createIntelligenceRoutineRun(env.DB, { id: runId, routineId: record.id, workflowId, plan: { definition, runtimePlans: plans, estimatedWorkflowSteps: steps } });
  let instance: { id: string };
  try {
    instance = await env.ROUTINE_WORKFLOW.create({ id: workflowId, params: { runId, routineId: record.id, trigger: options.trigger ?? "manual", requestedAt: isoNow() } });
  } catch (error) {
    const failedAt = isoNow();
    await updateIntelligenceRoutineRun(env.DB, runId, { status: "failed", completedAt: failedAt, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  await updateIntelligenceRoutineRun(env.DB, runId, { workflowId: instance.id });
  const run = await getIntelligenceRoutineRun(env.DB, runId);
  if (!run) throw new Error("Routine run was created but could not be read");
  return run;
}



export async function startDueIntelligenceRoutines(env: Env, limit = 1): Promise<string[]> {
  if (!env.ROUTINE_WORKFLOW) return [];
  const boundedLimit = Math.max(1, Math.min(1, Math.floor(Number.isFinite(limit) ? limit : 1)));
  const rows = await dueIntelligenceRoutines(env.DB, isoNow(), boundedLimit);
  if (rows.length === 0) return [];
  const context = await runtimeContext(env);
  const started: string[] = [];
  for (const row of rows) {
    try {
      const run = await startIntelligenceRoutineRecord(env, row, { trigger: "scheduled" }, context);
      started.push(run.id);
    } catch (error) {
      const failedAt = isoNow();
      await deferIntelligenceRoutineAttempt(
        env.DB,
        row.id,
        new Date(Date.parse(failedAt) + SCHEDULED_LAUNCH_FAILURE_DEFERRAL_MS).toISOString(),
        failedAt,
      );
      console.error(`Routine ${row.id} could not start`, error);
    }
  }
  return started;
}

export async function advanceRoutineSchedule(
  db: D1Database,
  routine: Pick<IntelligenceRoutineRecord, "id" | "schedule_minutes">,
): Promise<void> {
  const minutes = routine.schedule_minutes;
  await markIntelligenceRoutineScheduled(db, routine.id, minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null);
}

export async function routineCatalog(env: Env): Promise<Array<Record<string, unknown>>> {
  const routines = await listIntelligenceRoutines(env.DB, { limit: 200 });
  const recent = await listIntelligenceRoutineRuns(env.DB, { limit: 200 });
  return routines.map((record) => {
    const definition = routineDefinition(record);
    const run = recent.find((candidate) => candidate.routine_id === record.id);
    return {
      ...record,
      definition,
      latestRun: run ? { ...run, plan: parseJson(run.plan_json, {}), result: parseJson(run.result_json, {}) } : null,
    };
  });
}
