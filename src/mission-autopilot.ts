import {
  createMissionRun,
  deferMissionSprintAttempt,
  getMission,
  getMissionOperator,
  hasActiveMissionRun,
  listDueMissionReminderCandidates,
  listDueMissionSprints,
  listMissionRuns,
  listMissions,
  listSources,
  markMissionSprintLaunched,
  recordMissionEvent,
  updateMissionRun,
} from "./db";
import type { Env, MissionOperatorRecord, MissionRecord } from "./types";
import { requireBudget } from "./budget";
import {
  REQUIRED_SOURCE_MAX_ATTEMPTS,
  sourceBoundaryAttemptCount,
} from "./source-execution-envelope";
import { isoNow, normalizeStringArray, parseJson } from "./utils";

const SCHEDULED_LAUNCH_FAILURE_DEFERRAL_MS = 60 * 60_000;
const MISSION_SOURCE_LIMIT = 30;
const WORKFLOW_DEFAULT_MAX_ATTEMPTS = 6;
// The rebuild callback launches a separately budgeted child Workflow with a
// fresh instance ID. Retrying an ambiguous success could launch it twice.
const WORKFLOW_REBUILD_MAX_ATTEMPTS = 1;
const WORKFLOW_SYNC_MAX_ATTEMPTS = 3;

export function estimateMissionSprintWorkflowSteps(sourceCount: number): number {
  const boundedSources = Math.max(0, Math.min(MISSION_SOURCE_LIMIT, Math.floor(sourceCount)));
  const plan = WORKFLOW_DEFAULT_MAX_ATTEMPTS;
  const sources = sourceBoundaryAttemptCount(Array.from({ length: boundedSources }, () => ({ optional: false })));
  const wait = 1;
  const settlement = REQUIRED_SOURCE_MAX_ATTEMPTS;
  const rebuild = WORKFLOW_REBUILD_MAX_ATTEMPTS;
  const finalThenFailure = WORKFLOW_DEFAULT_MAX_ATTEMPTS * 2;
  const finalThenSync = WORKFLOW_DEFAULT_MAX_ATTEMPTS + WORKFLOW_SYNC_MAX_ATTEMPTS;
  return plan + sources + wait + settlement + rebuild + Math.max(finalThenFailure, finalThenSync);
}

export interface MissionSprintStart {
  runId: string;
  workflowId: string;
  missionId: string;
  trigger: "manual" | "scheduled";
}


export async function resolveMissionSourceIds(
  env: Env,
  mission: MissionRecord,
  requested?: string[],
): Promise<string[]> {
  const requestedSet = new Set(normalizeStringArray(requested));
  const scope = new Set(normalizeStringArray(parseJson<unknown>(mission.source_scope_json, [])));
  const sources = await listSources(env.DB);
  return sources
    .filter((source) => source.enabled === 1)
    .filter((source) => requestedSet.size === 0 || requestedSet.has(source.id))
    .filter((source) => scope.size === 0 || scope.has(source.id) || scope.has(source.kind))
    .map((source) => source.id)
    .slice(0, MISSION_SOURCE_LIMIT);
}

function nextSprintAt(cadenceMinutes: number, from = Date.now()): string {
  return new Date(from + Math.max(15, Math.min(43_200, cadenceMinutes)) * 60_000).toISOString();
}

export async function startMissionSprint(
  env: Env,
  input: { missionId: string; sourceIds?: string[]; trigger?: "manual" | "scheduled" },
): Promise<MissionSprintStart> {
  if (!env.MISSION_WORKFLOW) throw new Error("Mission Workflow binding is not configured");
  const mission = await getMission(env.DB, input.missionId);
  if (!mission) throw new Error(`Mission not found: ${input.missionId}`);
  if (await hasActiveMissionRun(env.DB, mission.id)) throw new Error("A Mission Sprint is already queued or running");
  const trigger = input.trigger ?? "manual";
  const sourceIds = await resolveMissionSourceIds(env, mission, input.sourceIds);
  await requireBudget(env.DB, "workflow_steps", estimateMissionSprintWorkflowSteps(sourceIds.length), {
    missionId: mission.id,
    trigger,
    plannedSources: sourceIds.length,
  });
  const runId = `mr-${crypto.randomUUID()}`;
  const workflowId = `mission-${mission.id.slice(0, 36)}-${Date.now().toString(36)}`.slice(0, 100);
  await createMissionRun(env.DB, { id: runId, missionId: mission.id, workflowId, sourceIds });
  let instance: { id: string };
  try {
    instance = await env.MISSION_WORKFLOW.create({
      id: workflowId,
      params: { runId, missionId: mission.id, sourceIds },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = isoNow();
    await updateMissionRun(env.DB, runId, {
      status: "failed",
      completedAt: failedAt,
      error: `Workflow start failed: ${message}`,
      result: { missionName: mission.name, sourceIds, failedBeforeStart: true, trigger },
    });
    throw error;
  }
  const launchedAt = isoNow();
  await markMissionSprintLaunched(env.DB, mission.id, mission.cadence_minutes, launchedAt);
  await recordMissionEvent(env.DB, {
    missionId: mission.id,
    eventType: "sprint",
    title: trigger === "scheduled" ? "Scheduled Mission Sprint started" : "Mission Sprint started",
    detail: `${sourceIds.length ? `${sourceIds.length} explicitly scoped sources` : "Mission source scope"} · run ${runId}`,
    metadata: { runId, workflowId: instance.id, trigger, sourceIds },
    dedupeKey: `sprint:${runId}`,
    occurredAt: launchedAt,
  });
  return { runId, workflowId: instance.id, missionId: mission.id, trigger };
}

export async function startDueMissionSprints(env: Env, limit = 1): Promise<MissionSprintStart[]> {
  if (!env.MISSION_WORKFLOW) return [];
  const boundedLimit = Math.max(1, Math.min(1, Math.floor(Number.isFinite(limit) ? limit : 1)));
  const due = await listDueMissionSprints(env.DB, isoNow(), boundedLimit);
  const started: MissionSprintStart[] = [];
  for (const { mission } of due) {
    try {
      started.push(await startMissionSprint(env, { missionId: mission.id, trigger: "scheduled" }));
    } catch (error) {
      const failedAt = isoNow();
      await deferMissionSprintAttempt(
        env.DB,
        mission.id,
        new Date(Date.parse(failedAt) + SCHEDULED_LAUNCH_FAILURE_DEFERRAL_MS).toISOString(),
        failedAt,
      );
      console.error(`Scheduled Mission Sprint failed for ${mission.id}`, error);
    }
  }
  return started;
}

export async function refreshMissionReminders(env: Env, now = new Date()): Promise<number> {
  const candidates = await listDueMissionReminderCandidates(env.DB, now.toISOString(), 12);
  let recorded = 0;
  for (const candidate of candidates) {
    if (candidate.reminder_kind === "overdue") {
      await recordMissionEvent(env.DB, {
        missionId: candidate.mission_id,
        eventType: "reminder",
        title: "Expected event is overdue",
        detail: `${candidate.expected_next_event} was expected by ${candidate.due_key}. Mark it occurred, missed, or rescheduled.`,
        metadata: { expectedBy: candidate.expected_by, expectedEventStatus: candidate.expected_event_status, daysOverdue: Math.ceil(Math.abs(candidate.days_until)) },
        dedupeKey: `expected-overdue:${candidate.due_key}`,
      });
      recorded += 1;
    } else {
      await recordMissionEvent(env.DB, {
        missionId: candidate.mission_id,
        eventType: "reminder",
        title: "Expected event is approaching",
        detail: `${candidate.expected_next_event} is expected by ${candidate.due_key}.`,
        metadata: { expectedBy: candidate.expected_by, expectedEventStatus: candidate.expected_event_status, daysUntil: Math.ceil(candidate.days_until) },
        dedupeKey: `expected-soon:${candidate.due_key}`,
      });
      recorded += 1;
    }
  }
  return recorded;
}

export async function missionAutopilotSummary(env: Env): Promise<Array<Record<string, unknown>>> {
  const missions = await listMissions(env.DB);
  const output: Array<Record<string, unknown>> = [];
  for (const mission of missions) {
    const [operator, runs] = await Promise.all([
      getMissionOperator(env.DB, mission.id),
      listMissionRuns(env.DB, { missionId: mission.id, limit: 1 }),
    ]);
    if (!operator) continue;
    const latestRun = runs[0];
    output.push({
      missionId: mission.id,
      missionName: mission.name,
      sprintPolicy: operator.sprint_policy,
      cadenceMinutes: mission.cadence_minutes,
      nextSprintAt: operator.next_sprint_at ?? (operator.sprint_policy === "scheduled" ? nextSprintAt(mission.cadence_minutes) : null),
      lastSprintAt: operator.last_sprint_at,
      activeRun: latestRun && ["queued", "running"].includes(latestRun.status) ? latestRun.id : null,
      expectedEventStatus: operator.expected_event_status,
      expectedBy: operator.expected_by,
      expectedNextEvent: operator.expected_next_event,
    });
  }
  return output;
}

export function operatorWithAutopilotDefaults(
  operator: MissionOperatorRecord | null,
  cadenceMinutes: number,
): Pick<MissionOperatorRecord, "sprint_policy" | "next_sprint_at" | "last_sprint_at" | "reminder_lead_days" | "expected_event_status"> {
  return {
    sprint_policy: operator?.sprint_policy ?? "manual",
    next_sprint_at: operator?.next_sprint_at ?? null,
    last_sprint_at: operator?.last_sprint_at ?? null,
    reminder_lead_days: operator?.reminder_lead_days ?? 3,
    expected_event_status: operator?.expected_event_status ?? "none",
  };
}
