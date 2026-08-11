import {
  listIntelligenceRoutineRuns,
  listIntelligenceRoutines,
  listReasoningReceipts,
  listReasoningRuns,
  listSourceCadence,
  listIntelligencePackOverlays,
} from "./db";
import { decisionCalibrationSummary, dueDecisionReviews, listDecisions } from "./decision-ledger";
import { listReasoningTasks } from "./reasoning-tasks";
import { sourceScorecards } from "./source-scorecards";
import type { Env } from "./types";
import { isoNow, parseJson } from "./utils";

function countBy<T extends { status: string }>(rows: T[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const row of rows) output[row.status] = (output[row.status] ?? 0) + 1;
  return output;
}

export async function judgmentOverview(env: Env): Promise<Record<string, unknown>> {
  const [tasks, decisions, dueReviews, calibration, routines, routineRuns, receipts, reasoningRuns, scorecardResult, cadence, overlays, lineageResult] = await Promise.all([
    listReasoningTasks(env.DB, { limit: 100 }),
    listDecisions(env.DB, { limit: 100 }),
    dueDecisionReviews(env.DB, 25),
    decisionCalibrationSummary(env.DB),
    listIntelligenceRoutines(env.DB, { limit: 100 }),
    listIntelligenceRoutineRuns(env.DB, { limit: 100 }),
    listReasoningReceipts(env.DB, { limit: 30 }),
    listReasoningRuns(env.DB, { limit: 50 }),
    sourceScorecards(env.DB, 30),
    listSourceCadence(env.DB),
    listIntelligencePackOverlays(env.DB),
    env.DB.prepare(
      `SELECT relation, independent, COUNT(*) AS count
       FROM evidence_lineage
       GROUP BY relation, independent
       ORDER BY count DESC`,
    ).all<Record<string, unknown>>(),
  ]);
  const now = Date.now();
  const readyTasks = tasks.filter((task) => ["ready", "queued", "claimed"].includes(task.status) && Date.parse(task.expires_at) > now);
  const activeRuns = reasoningRuns.filter((run) => ["started", "completed"].includes(run.status));
  const activeRoutines = routines.filter((routine) => routine.enabled === 1);
  const routineById = new Map(routines.map((routine) => [routine.id, routine]));
  const latestRoutineRuns = routineRuns.slice(0, 20).map((run) => ({
    ...run,
    routineName: routineById.get(run.routine_id)?.name ?? run.routine_id,
    result: parseJson(run.result_json, {}),
    plan: parseJson(run.plan_json, {}),
  }));
  const scorecards = scorecardResult.scorecards;
  return {
    generatedAt: isoNow(),
    summary: {
      readyReasoningTasks: readyTasks.length,
      openDecisions: decisions.filter((decision) => decision.status === "open").length,
      dueDecisionReviews: dueReviews.length,
      activeRoutines: activeRoutines.length,
      activeReasoningRuns: activeRuns.length,
      sourcesToRepair: scorecards.filter((source) => ["repair", "pause"].includes(source.recommendation)).length,
      adaptiveSources: cadence.filter((source) => source.mode === "adaptive").length,
      packForks: overlays.filter((overlay) => overlay.status !== "disabled").length,
      packConflicts: overlays.filter((overlay) => overlay.status === "conflicted").length,
    },
    reasoningInbox: readyTasks.slice(0, 20),
    decisions: decisions.slice(0, 30),
    dueDecisionReviews: dueReviews,
    calibration,
    routines: activeRoutines.map((routine) => ({
      ...routine,
      definition: parseJson(routine.definition_json, {}),
      lastRun: routineRuns.find((run) => run.routine_id === routine.id) ?? null,
    })),
    routineRuns: latestRoutineRuns,
    receipts,
    reasoningRuns: reasoningRuns.slice(0, 20),
    sourceScorecards: scorecards.slice(0, 20),
    cadence,
    overlays,
    lineage: lineageResult.results ?? [],
  };
}
