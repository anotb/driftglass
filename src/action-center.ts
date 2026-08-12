import {
  listIntelligencePackOverlays,
  listIntelligenceRoutineRuns,
  listMissionActionContexts,
  listResearchResultImports,
  listSourceHealth,
} from "./db";
import { dueDecisionReviews } from "./decision-ledger";
import { OpenAlexPrerequisiteError } from "./sources/openalex";
import type { Env, MissionAction, ReasoningTaskRecord } from "./types";
import { isoNow } from "./utils";

function daysFromNow(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? (timestamp - Date.now()) / 86_400_000 : 999;
}

export async function buildActionCenter(env: Env): Promise<{ generatedAt: string; actions: MissionAction[] }> {
  const [missionContexts, pendingResearch, sourceHealth, reasoningTasks, dueDecisions, routineRuns, packOverlays] = await Promise.all([
    listMissionActionContexts(env.DB),
    listResearchResultImports(env.DB, { status: "pending", limit: 50 }),
    listSourceHealth(env.DB),
    env.DB.prepare(
      `SELECT * FROM reasoning_tasks
       WHERE status IN ('ready','queued','claimed') AND datetime(expires_at) > datetime('now')
       ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END,
                priority DESC, COALESCE(due_at, created_at) ASC LIMIT 12`,
    ).all<ReasoningTaskRecord>().then((result) => result.results ?? []),
    dueDecisionReviews(env.DB, 12),
    listIntelligenceRoutineRuns(env.DB, { limit: 30 }),
    listIntelligencePackOverlays(env.DB),
  ]);
  const missions = missionContexts.map((context) => context.mission);
  const actions: MissionAction[] = [];

  // All current OpenAlex modes require the same runtime key, so this provider
  // prerequisite can be surfaced from the existing set-based health read. The
  // full config validator remains in Readiness and source execution.
  const openAlexPrerequisite = new OpenAlexPrerequisiteError();
  const deferredSources = sourceHealth.filter((source) => (
    Number(source.enabled ?? 1) === 1
    && source.kind === "openalex"
    && !env.OPENALEX_API_KEY?.trim()
  ));
  if (deferredSources.length) {
    actions.push({
      id: `source-prerequisite:${deferredSources.map((source) => String(source.id ?? "")).sort().join(",")}`,
      kind: "source-prerequisite",
      severity: "attention",
      title: `${deferredSources.length} source${deferredSources.length === 1 ? " is" : "s are"} waiting for setup`,
      detail: openAlexPrerequisite.message,
      action: "open-sources",
      metadata: {
        sourceIds: deferredSources.map((source) => source.id),
        codes: [openAlexPrerequisite.code],
      },
    });
  }

  for (const task of reasoningTasks.filter((row) => ["ready", "queued", "claimed"].includes(row.status)).slice(0, 6)) {
    actions.push({
      id: `reasoning-task:${task.id}`,
      kind: "reasoning-ready",
      severity: task.priority >= 0.85 ? "attention" : "info",
      missionId: task.scope_kind === "mission" ? task.scope_id ?? undefined : undefined,
      title: task.status === "ready" ? `Evidence is ready for your model: ${task.objective}` : `Preparing evidence for your model: ${task.objective}`,
      detail: task.reason || "Use ChatGPT, Claude, Grok, or another connected model when you are ready to think this through.",
      dueAt: task.due_at,
      action: "open-reasoning",
      metadata: { taskId: task.id, receiptId: task.receipt_id, target: task.target, status: task.status },
    });
  }

  for (const decision of dueDecisions.slice(0, 6)) {
    actions.push({
      id: `decision-review:${decision.id}`,
      kind: "decision-review",
      severity: decision.review_at && Date.parse(decision.review_at) < Date.now() - 7 * 86_400_000 ? "urgent" : "attention",
      missionId: decision.mission_id ?? undefined,
      title: `Review prior ${decision.decision_type}: ${decision.title}`,
      detail: decision.expected_outcome || "Compare the recorded decision with what actually happened and save the lesson.",
      dueAt: decision.review_at,
      action: "review-decision",
      metadata: { decisionId: decision.id, confidence: decision.confidence },
    });
  }

  const failedRoutineRuns = routineRuns.filter((run) => run.status === "failed").slice(0, 4);
  for (const run of failedRoutineRuns) {
    actions.push({
      id: `routine-failed:${run.id}`,
      kind: "routine-failed",
      severity: "attention",
      title: "An Intelligence Routine needs attention",
      detail: run.error || `Routine ${run.routine_id} failed before completing its bounded playbook.`,
      action: "open-reasoning",
      metadata: { routineId: run.routine_id, runId: run.id },
    });
  }

  const conflictedOverlays = packOverlays.filter((overlay) => overlay.status === "conflicted");
  if (conflictedOverlays.length) {
    actions.push({
      id: `pack-overlay-conflicts:${conflictedOverlays.map((overlay) => overlay.id).sort().join(",")}`,
      kind: "pack-conflict",
      severity: "attention",
      title: `${conflictedOverlays.length} Intelligence Pack customization${conflictedOverlays.length === 1 ? " needs" : "s need"} review`,
      detail: "An upstream Pack changed a source or Mission that a local overlay customizes. The upstream update remains installed; review the reported conflict before changing the overlay.",
      action: "open-sources",
      metadata: { overlayIds: conflictedOverlays.map((overlay) => overlay.id) },
    });
  }

  for (const pending of pendingResearch) {
    const mission = missions.find((candidate) => candidate.id === pending.mission_id);
    actions.push({
      id: `research-result:${pending.id}`,
      kind: "research-result",
      severity: "attention",
      missionId: pending.mission_id,
      missionName: mission?.name ?? pending.mission_id,
      title: `Review Deep Research result for ${mission?.name ?? pending.mission_id}`,
      detail: "A structured research result is staged and waiting for confirmation before it updates the Mission baseline.",
      dueAt: pending.expires_at,
      action: "review-research-result",
      metadata: { importId: pending.id, source: pending.source },
    });
  }

  for (const { mission, operator, hasActiveRun } of missionContexts) {
    if (mission.status === "active" && operator.outcome_status === "open" && operator.sprint_policy === "scheduled" && !hasActiveRun) {
      const due = operator.next_sprint_at ? Date.parse(operator.next_sprint_at) <= Date.now() : true;
      if (due) {
        actions.push({
          id: `sprint-due:${mission.id}`,
          kind: "sprint-due",
          severity: "info",
          missionId: mission.id,
          missionName: mission.name,
          title: `Evidence refresh due for ${mission.name}`,
          detail: `Scheduled cadence is every ${mission.cadence_minutes} minutes. The next Workflow will run automatically on the next Cron cycle.`,
          dueAt: operator.next_sprint_at,
          action: "run-mission-sprint",
        });
      }
    }
    if (operator.outcome_status !== "open") {
      if (operator.resolved_at && daysFromNow(operator.resolved_at) >= -7) {
        actions.push({
          id: `mission-resolved:${mission.id}:${operator.resolved_at}`,
          kind: "mission-resolved",
          severity: "info",
          missionId: mission.id,
          missionName: mission.name,
          title: `${mission.name} is ${operator.outcome_status}`,
          detail: operator.outcome_summary || "The Mission was closed without a written outcome summary.",
          dueAt: operator.resolved_at,
          action: "open-mission",
        });
      }
      continue;
    }
    if (!operator.expected_next_event || !operator.expected_by || !["pending", "rescheduled"].includes(operator.expected_event_status)) continue;
    const days = daysFromNow(operator.expected_by);
    if (days < 0) {
      actions.push({
        id: `expected-overdue:${mission.id}:${operator.expected_by}`,
        kind: "expected-overdue",
        severity: "urgent",
        missionId: mission.id,
        missionName: mission.name,
        title: `Expected event overdue: ${operator.expected_next_event}`,
        detail: `Expected ${Math.max(1, Math.ceil(Math.abs(days)))} day${Math.ceil(Math.abs(days)) === 1 ? "" : "s"} ago. Mark it occurred, missed, or rescheduled.`,
        dueAt: operator.expected_by,
        action: "configure-mission",
      });
    } else if (days <= operator.reminder_lead_days) {
      actions.push({
        id: `expected-soon:${mission.id}:${operator.expected_by}`,
        kind: "expected-soon",
        severity: "attention",
        missionId: mission.id,
        missionName: mission.name,
        title: `Expected event approaching: ${operator.expected_next_event}`,
        detail: `Expected in ${Math.max(0, Math.ceil(days))} day${Math.ceil(days) === 1 ? "" : "s"}.`,
        dueAt: operator.expected_by,
        action: "open-mission",
      });
    }
  }

  const degraded = sourceHealth.filter((source) => Number(source.enabled ?? 1) === 1 && Number(source.health_score ?? 1) < 0.45);
  if (degraded.length) {
    actions.push({
      id: `source-degraded:${degraded.map((source) => source.id).sort().join(",")}`,
      kind: "source-degraded",
      severity: degraded.some((source) => Number(source.health_score ?? 1) < 0.2) ? "urgent" : "attention",
      title: `${degraded.length} source${degraded.length === 1 ? " is" : "s are"} materially degraded`,
      detail: degraded.slice(0, 6).map((source) => `${source.name} (${Math.round(Number(source.health_score ?? 0) * 100)}%)`).join(" · "),
      action: "open-sources",
      metadata: { sourceIds: degraded.map((source) => source.id) },
    });
  }

  const severityRank = { urgent: 0, attention: 1, info: 2 } as const;
  actions.sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || String(left.dueAt ?? "").localeCompare(String(right.dueAt ?? "")));
  return { generatedAt: isoNow(), actions: actions.slice(0, 100) };
}
