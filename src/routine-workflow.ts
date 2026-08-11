import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  getIntelligenceRoutine,
  getMission,
  listBuiltInSourceRunSettlements,
  updateIntelligenceRoutineRun,
} from "./db";
import { createMemoryCheckpoint } from "./memory-checkpoints";
import type { MemoryCheckpointDiff } from "./memory-checkpoint-diff";
import { memoryGraphAudit, type MemoryGraphAudit } from "./memory-graph";
import { buildDeepResearchHandoff } from "./deep-research";
import { startMissionMatchMaintenance, type MissionMatchMaintenanceStart } from "./missions";
import { resolveMissionSourceIds } from "./mission-autopilot";
import {
  commitMissionComputerAcrossBoundary,
  loadMissionComputerAcrossBoundary,
  renderMissionComputerAcrossBoundary,
} from "./mission-maintenance-boundary";
import type { MissionComputerSummary } from "./mission-computer";
import { enqueueReasoningTask, materializeReasoningTask } from "./reasoning-tasks";
import {
  allocateSourceBoundaryAttempts,
  SOURCE_BOUNDARY_CALL_LIMIT,
} from "./source-execution-envelope";
import { runWorkflowSourceAcrossBoundary } from "./source-run-boundary";
import { advanceRoutineSchedule, normalizeIntelligenceRoutine, routineDefinition } from "./intelligence-routines";
import type {
  Env,
  IntelligenceRoutineDefinition,
  IntelligenceRoutineStep,
  IntelligenceRoutineWorkflowParams,
  ReasoningTaskRecord,
} from "./types";
import { isoNow } from "./utils";

type RefreshSourceResult = {
  sourceId: string;
  name?: string;
  runId?: string;
  status: "missing" | "failed" | "skipped" | "deferred" | "partial" | "queued" | "collected";
  count?: number;
  provider?: string;
  collectionPartial?: boolean;
  companion?: boolean;
  settlementPending?: boolean;
  reason?: "credential" | "disabled" | "capacity";
  assignedAttempts?: number;
  code?: string;
  binding?: string;
  detail?: string;
  error?: string;
};

type RefreshSourcesStepResult = {
  sources: RefreshSourceResult[];
  count: number;
  completedCount: number;
  skippedCount: number;
  deferredCount: number;
  partialCount: number;
  failedCount: number;
  status: "complete" | "partial" | "failed";
  error?: string;
};

type RoutineRefreshExecutionPlan = {
  routineStepIndex: number;
  sourceIds: string[];
  assignedAttempts: number[];
};

type RoutineSourceExecutionPlan = {
  refreshes: RoutineRefreshExecutionPlan[];
  plannedSourceExecutions: number;
  assignedBoundaryCalls: number;
  boundaryCallLimit: number;
};
type RebuildMissionStepResult = MissionMatchMaintenanceStart;
type IncludedMaintenanceSyncStepResult = {
  includedInMatchMaintenance: true;
  workflowId: string;
  status: "queued";
};
type WaitForIngestStepResult = { waited: true };
type WaitForIngestSleepResult = { waitedSeconds: number };

type MemoryAuditStepResult = {
  score: number;
  checkedAt: string;
  totals: { nodes: number; edges: number; activeNodes: number; activeEdges: number };
  issues: {
    unresolvedContradictions: Array<{
      id: string;
      relation: string;
      from: string;
      to: string;
      strength: number;
      confidence: number;
      rationale: string;
    }>;
    staleExpectations: Array<{ id: string; label: string; expectedAt: string | null; sourceRef: string | null }>;
    unsupportedDurableNodes: Array<{ id: string; type: string; label: string; importance: number; confidence: number }>;
    orphanNodes: Array<{ id: string; type: string; label: string; importance: number }>;
    incompleteSupersession: Array<{ id: string; type: string; label: string }>;
  };
  recommendations: string[];
};

type PrepareResearchStepResult = {
  task: ReasoningTaskRecord;
  handoff: {
    recommendation: { shouldEscalate: boolean; score: number; reasons: string[]; whyNow: string };
    title: string;
  };
};

const CHECKPOINT_METADATA_TEXT_LIMIT = 500;
const CHECKPOINT_REFERENCE_TEXT_LIMIT = 2_048;
const CHECKPOINT_SUMMARY_BUCKET_LIMIT = 64;
const CHECKPOINT_DIFF_SAMPLE_LIMIT = 100;
const CHECKPOINT_DIFF_ID_LIMIT = 256;
const ROUTINE_ID_LIMIT = 80;
const ROUTINE_DEFINITION_PAYLOAD_LIMIT_BYTES = 384 * 1_024;
const ROUTINE_REFRESH_SOURCE_LIMIT = 30;
const ROUTINE_ERROR_TEXT_LIMIT = 500;

type CheckpointMemoryStepResult = {
  metadata: {
    created: boolean;
    checkpointId: string;
    title: string;
    createdAt: string;
  };
  reference: {
    snapshotR2Key: string;
    snapshotHash: string;
  };
  scope: {
    kind: "global" | "mission" | "story" | "pack";
    id: string | null;
    ref: string | null;
    title: string;
  };
  capturedAt: string;
  summary: {
    nodes: number;
    edges: number;
    activeNodes: number;
    activeEdges: number;
    byType: { [key: string]: number };
    byRelation: { [key: string]: number };
    truncated: boolean;
    bucketLimit: number;
  };
  diff: MemoryCheckpointDiff & {
    truncated: boolean;
    sampleLimit: number;
  };
};

type RoutineStepResult =
  | RefreshSourcesStepResult
  | RebuildMissionStepResult
  | IncludedMaintenanceSyncStepResult
  | MissionComputerSummary
  | MemoryAuditStepResult
  | ReasoningTaskRecord
  | PrepareResearchStepResult
  | CheckpointMemoryStepResult
  | WaitForIngestStepResult
  | WaitForIngestSleepResult;

interface StepResult {
  id: string;
  action: string;
  ok: boolean;
  optional: boolean;
  partial?: boolean;
  result?: RoutineStepResult;
  error?: string;
}

function isRefreshSourcesStepResult(result: RoutineStepResult | undefined): result is RefreshSourcesStepResult {
  return Boolean(result && typeof result === "object" && "sources" in result && Array.isArray(result.sources));
}

function refreshSourcesStepResult(outcomes: RefreshSourceResult[]): RefreshSourcesStepResult {
  const failedCount = outcomes.filter((outcome) => outcome.status === "failed" || outcome.status === "missing").length;
  const partialCount = outcomes.filter(
    (outcome) => outcome.status === "partial" || outcome.collectionPartial || outcome.settlementPending,
  ).length;
  const skippedCount = outcomes.filter((outcome) => outcome.status === "skipped").length;
  const deferredCount = outcomes.filter((outcome) => outcome.status === "deferred").length;
  const completedCount = outcomes.filter((outcome) => outcome.status === "queued" || outcome.status === "collected").length;
  return {
    sources: outcomes,
    count: outcomes.length,
    completedCount,
    skippedCount,
    deferredCount,
    partialCount,
    failedCount,
    status: failedCount > 0
      ? "failed"
      : partialCount > 0 || completedCount === 0
        ? "partial"
        : "complete",
    error: failedCount > 0
      ? `${failedCount} of ${outcomes.length} source refresh${outcomes.length === 1 ? "" : "es"} failed`
      : undefined,
  };
}

function recordString(record: Record<string, unknown>, key: string): string {
  return String(record[key] ?? "");
}

function recordNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return value === null || value === undefined ? null : String(value);
}

function recordNumber(record: Record<string, unknown>, key: string): number {
  return Number(record[key] ?? 0);
}

function memoryAuditStepResult(audit: MemoryGraphAudit): MemoryAuditStepResult {
  return {
    score: audit.score,
    checkedAt: audit.checkedAt,
    totals: audit.totals,
    issues: {
      unresolvedContradictions: audit.issues.unresolvedContradictions.map((issue) => ({
        id: recordString(issue, "id"),
        relation: recordString(issue, "relation"),
        from: recordString(issue, "from"),
        to: recordString(issue, "to"),
        strength: recordNumber(issue, "strength"),
        confidence: recordNumber(issue, "confidence"),
        rationale: recordString(issue, "rationale"),
      })),
      staleExpectations: audit.issues.staleExpectations.map((issue) => ({
        id: recordString(issue, "id"),
        label: recordString(issue, "label"),
        expectedAt: recordNullableString(issue, "expectedAt"),
        sourceRef: recordNullableString(issue, "sourceRef"),
      })),
      unsupportedDurableNodes: audit.issues.unsupportedDurableNodes.map((issue) => ({
        id: recordString(issue, "id"),
        type: recordString(issue, "type"),
        label: recordString(issue, "label"),
        importance: recordNumber(issue, "importance"),
        confidence: recordNumber(issue, "confidence"),
      })),
      orphanNodes: audit.issues.orphanNodes.map((issue) => ({
        id: recordString(issue, "id"),
        type: recordString(issue, "type"),
        label: recordString(issue, "label"),
        importance: recordNumber(issue, "importance"),
      })),
      incompleteSupersession: audit.issues.incompleteSupersession.map((issue) => ({
        id: recordString(issue, "id"),
        type: recordString(issue, "type"),
        label: recordString(issue, "label"),
      })),
    },
    recommendations: audit.recommendations,
  };
}

function boundedText(value: string, limit: number): string {
  return value.slice(0, limit);
}

function boundedCountMap(
  counts: Record<string, number>,
): { values: Record<string, number>; truncated: boolean } {
  const entries = Object.entries(counts).slice(0, CHECKPOINT_SUMMARY_BUCKET_LIMIT);
  return {
    values: Object.fromEntries(entries.map(([key, value]) => [boundedText(key, CHECKPOINT_DIFF_ID_LIMIT), value])),
    truncated: Object.keys(counts).length > entries.length,
  };
}

function boundedDiffIds(values: string[]): string[] {
  return values
    .slice(0, CHECKPOINT_DIFF_SAMPLE_LIMIT)
    .map((value) => boundedText(value, CHECKPOINT_DIFF_ID_LIMIT));
}

function boundedCheckpointDiff(diff: MemoryCheckpointDiff): CheckpointMemoryStepResult["diff"] {
  const lists = [
    diff.addedNodes,
    diff.removedNodes,
    diff.changedNodes,
    diff.addedEdges,
    diff.removedEdges,
    diff.changedEdges,
  ];
  return {
    unchanged: diff.unchanged,
    previousCheckpointId: diff.previousCheckpointId
      ? boundedText(diff.previousCheckpointId, CHECKPOINT_DIFF_ID_LIMIT)
      : null,
    addedNodes: boundedDiffIds(diff.addedNodes),
    removedNodes: boundedDiffIds(diff.removedNodes),
    changedNodes: boundedDiffIds(diff.changedNodes),
    addedEdges: boundedDiffIds(diff.addedEdges),
    removedEdges: boundedDiffIds(diff.removedEdges),
    changedEdges: boundedDiffIds(diff.changedEdges),
    counts: diff.counts,
    truncated: lists.some((values) => values.length > CHECKPOINT_DIFF_SAMPLE_LIMIT),
    sampleLimit: CHECKPOINT_DIFF_SAMPLE_LIMIT,
  };
}

export function checkpointMemoryStepResult(
  result: Awaited<ReturnType<typeof createMemoryCheckpoint>>,
): CheckpointMemoryStepResult {
  const byType = boundedCountMap(result.snapshot.summary.byType);
  const byRelation = boundedCountMap(result.snapshot.summary.byRelation);
  return {
    metadata: {
      created: result.created,
      checkpointId: boundedText(result.checkpoint.id, CHECKPOINT_DIFF_ID_LIMIT),
      title: boundedText(result.checkpoint.title, CHECKPOINT_METADATA_TEXT_LIMIT),
      createdAt: boundedText(result.checkpoint.created_at, CHECKPOINT_METADATA_TEXT_LIMIT),
    },
    reference: {
      snapshotR2Key: boundedText(result.checkpoint.snapshot_r2_key, CHECKPOINT_REFERENCE_TEXT_LIMIT),
      snapshotHash: boundedText(result.checkpoint.snapshot_hash, CHECKPOINT_METADATA_TEXT_LIMIT),
    },
    scope: {
      kind: result.snapshot.scope.kind,
      id: result.snapshot.scope.id
        ? boundedText(result.snapshot.scope.id, CHECKPOINT_METADATA_TEXT_LIMIT)
        : null,
      ref: result.snapshot.scope.ref
        ? boundedText(result.snapshot.scope.ref, CHECKPOINT_REFERENCE_TEXT_LIMIT)
        : null,
      title: boundedText(result.snapshot.scope.title, CHECKPOINT_METADATA_TEXT_LIMIT),
    },
    capturedAt: boundedText(result.snapshot.capturedAt, CHECKPOINT_METADATA_TEXT_LIMIT),
    summary: {
      nodes: result.snapshot.summary.nodes,
      edges: result.snapshot.summary.edges,
      activeNodes: result.snapshot.summary.activeNodes,
      activeEdges: result.snapshot.summary.activeEdges,
      byType: byType.values,
      byRelation: byRelation.values,
      truncated: byType.truncated || byRelation.truncated,
      bucketLimit: CHECKPOINT_SUMMARY_BUCKET_LIMIT,
    },
    diff: boundedCheckpointDiff(result.diff),
  };
}

export class IntelligenceRoutineWorkflow extends WorkflowEntrypoint<Env, IntelligenceRoutineWorkflowParams> {
  override async run(event: WorkflowEvent<IntelligenceRoutineWorkflowParams>, step: WorkflowStep) {
    const { runId, routineId } = event.payload;
    const results: StepResult[] = [];
    let schedule: { id: string; schedule_minutes: number | null } | null = null;
    let requiredRefreshFailure: Error | null = null;
    try {
      const initialization = await step.do("initialize routine", async () => {
        const record = await getIntelligenceRoutine(this.env.DB, routineId);
        if (!record) throw new Error(`Routine not found: ${routineId}`);
        const definition = routineDefinition(record);
        const definitionJson = JSON.stringify(definition);
        if (new TextEncoder().encode(definitionJson).byteLength > ROUTINE_DEFINITION_PAYLOAD_LIMIT_BYTES) {
          throw new Error("Normalized routine definition exceeds the Workflow step-state limit");
        }
        if (!record.id || record.id.length > ROUTINE_ID_LIMIT) {
          throw new Error("Routine id exceeds the Workflow step-state limit");
        }
        const scheduleMinutes = record.schedule_minutes === null || !Number.isFinite(record.schedule_minutes)
          ? null
          : Math.max(30, Math.min(43_200, Math.round(record.schedule_minutes)));
        await updateIntelligenceRoutineRun(this.env.DB, runId, {
          workflowId: event.instanceId,
          status: "running",
          startedAt: isoNow(),
          result: { trigger: event.payload.trigger ?? "manual" },
        });
        const sourceExecutionPlan = definition.steps.some((routineStep) => routineStep.action === "refresh-sources")
          ? await this.planSourceExecution(definition)
          : null;
        return {
          schedule: { id: record.id, schedule_minutes: scheduleMinutes },
          definitionJson,
          ...(sourceExecutionPlan ? { sourceExecutionPlan } : {}),
        };
      });
      schedule = initialization.schedule;
      const definitionValue: unknown = JSON.parse(initialization.definitionJson);
      const definition = normalizeIntelligenceRoutine(definitionValue);
      const sourceExecutionPlan = initialization.sourceExecutionPlan ?? null;
      let queuedMatchMaintenance: MissionMatchMaintenanceStart | null = null;
      for (const [routineStepIndex, routineStep] of definition.steps.entries()) {
        if (routineStep.action === "sync-computer" && queuedMatchMaintenance) {
          results.push({
            id: routineStep.id,
            action: routineStep.action,
            ok: true,
            optional: Boolean(routineStep.optional),
            result: {
              includedInMatchMaintenance: true,
              workflowId: queuedMatchMaintenance.workflowId,
              status: "queued",
            },
          });
          continue;
        }
        if (routineStep.action === "wait-for-ingest") {
          const seconds = Math.max(1, Math.min(900, routineStep.waitSeconds ?? 30));
          await step.sleep(`step ${routineStepIndex + 1} · wait`, `${seconds} seconds`);
          results.push({ id: routineStep.id, action: routineStep.action, ok: true, optional: Boolean(routineStep.optional), result: { waitedSeconds: seconds } });
          const settlementFailure = await this.settleBuiltInSourceRuns(results, routineStepIndex, step);
          if (settlementFailure) throw new Error(settlementFailure);
          if (requiredRefreshFailure) throw requiredRefreshFailure;
          continue;
        }
        let result: RoutineStepResult;
        let refreshResult: RefreshSourcesStepResult | null = null;
        try {
          if (routineStep.action === "refresh-sources") {
            const refreshPlan = sourceExecutionPlan?.refreshes.find(
              (candidate) => candidate.routineStepIndex === routineStepIndex,
            );
            if (!refreshPlan) throw new Error(`Routine source execution plan is missing step ${routineStepIndex + 1}`);
            refreshResult = await this.refreshSources(routineStep, routineStepIndex, refreshPlan, step);
            result = refreshResult;
          } else if (routineStep.action === "sync-computer") {
            if (!definition.missionId) throw new Error("sync-computer requires a missionId");
            const boundary = this.ctx.exports.MissionMaintenanceBoundary;
            if (!boundary) throw new Error("Mission maintenance boundary is unavailable");
            const computerSnapshot = await step.do(
              `step ${routineStepIndex + 1} · load sync-computer`,
              {
                retries: { limit: 1, delay: "15 seconds", backoff: "constant" },
                timeout: "5 minutes",
              },
              async () => loadMissionComputerAcrossBoundary(
                boundary,
                definition.missionId!,
                "intelligence-routine",
              ),
            );
            const computerPlan = await step.do(
              `step ${routineStepIndex + 1} · render sync-computer`,
              {
                retries: { limit: 0, delay: "15 seconds", backoff: "constant" },
                timeout: "5 minutes",
              },
              async () => renderMissionComputerAcrossBoundary(boundary, computerSnapshot),
            );
            result = await step.do(
              `step ${routineStepIndex + 1} · commit sync-computer`,
              {
                retries: { limit: 1, delay: "15 seconds", backoff: "constant" },
                timeout: "5 minutes",
              },
              async () => commitMissionComputerAcrossBoundary(boundary, computerPlan),
            );
          } else {
            result = await step.do(
              `step ${routineStepIndex + 1} · ${routineStep.action}`,
              {
                retries: {
                  // The rebuild action starts a separately budgeted child
                  // Workflow. Do not replay that non-idempotent handoff after
                  // an ambiguous success.
                  limit: routineStep.action === "rebuild-mission" ? 0 : routineStep.optional ? 1 : 3,
                  delay: "15 seconds",
                  backoff: "exponential",
                },
                timeout: "5 minutes",
              },
              async () => this.executeStep(definition.missionId, routineStep),
            );
          }
        } catch (error) {
          const failure: StepResult = {
            id: routineStep.id,
            action: routineStep.action,
            ok: false,
            optional: Boolean(routineStep.optional),
            error: error instanceof Error ? error.message : String(error),
          };
          results.push(failure);
          if (!routineStep.optional) throw error;
          continue;
        }
        if (refreshResult?.status === "failed") {
          const message = refreshResult.error
            ?? `${refreshResult.failedCount} of ${refreshResult.count} source refresh${refreshResult.count === 1 ? "" : "es"} failed`;
          results.push({
            id: routineStep.id,
            action: routineStep.action,
            ok: false,
            optional: Boolean(routineStep.optional),
            result,
            error: message,
          });
          if (!routineStep.optional) {
            const failure = new Error(message);
            const remainingUntilWait = definition.steps.slice(routineStepIndex + 1);
            const nextBarrierIndex = remainingUntilWait.findIndex(
              (candidate) => candidate.action !== "refresh-sources",
            );
            if (nextBarrierIndex >= 0 && remainingUntilWait[nextBarrierIndex]?.action === "wait-for-ingest") {
              requiredRefreshFailure ??= failure;
              continue;
            }
            throw failure;
          }
          continue;
        }
        results.push({
          id: routineStep.id,
          action: routineStep.action,
          ok: true,
          optional: Boolean(routineStep.optional),
          partial: refreshResult?.status === "partial" ? true : undefined,
          result,
        });
        if (routineStep.action === "rebuild-mission") {
          queuedMatchMaintenance = result as MissionMatchMaintenanceStart;
        }
      }
      const failed = results.filter((result) => !result.ok).length;
      const partial = results.filter((result) => result.partial).length;
      const status = failed || partial ? "partial" : "complete";
      await step.do("finalize routine", async () => {
        await updateIntelligenceRoutineRun(this.env.DB, runId, {
          status,
          result: { trigger: event.payload.trigger ?? "manual", steps: results },
          completedAt: isoNow(),
          error: failed
            ? `${failed} optional step${failed === 1 ? "" : "s"} failed`
            : partial
              ? `${partial} step${partial === 1 ? "" : "s"} completed with partial source coverage`
              : null,
        });
        await advanceRoutineSchedule(this.env.DB, initialization.schedule);
      });
      return { runId, routineId, status, steps: results };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do("fail routine", async () => {
        await updateIntelligenceRoutineRun(this.env.DB, runId, {
          status: "failed",
          result: { trigger: event.payload.trigger ?? "manual", steps: results },
          error: message,
          completedAt: isoNow(),
        });
        if (schedule) await advanceRoutineSchedule(this.env.DB, schedule);
      });
      throw error;
    }
  }

  private async planSourceExecution(
    definition: IntelligenceRoutineDefinition,
  ): Promise<RoutineSourceExecutionPlan> {
    const needsMissionSources = Boolean(
      definition.missionId
      && definition.steps.some((routineStep) => routineStep.action === "refresh-sources" && !routineStep.sourceIds?.length),
    );
    let missionSourceIds: string[] = [];
    if (needsMissionSources) {
      const mission = await getMission(this.env.DB, definition.missionId!);
      missionSourceIds = mission ? await resolveMissionSourceIds(this.env, mission) : [];
    }
    const refreshes: RoutineRefreshExecutionPlan[] = [];
    const requests: Array<{ optional: boolean }> = [];
    for (const [routineStepIndex, routineStep] of definition.steps.entries()) {
      if (routineStep.action !== "refresh-sources") continue;
      const ids = routineStep.sourceIds?.length ? routineStep.sourceIds : missionSourceIds;
      const sourceIds = [...new Set(ids)].slice(0, ROUTINE_REFRESH_SOURCE_LIMIT);
      refreshes.push({ routineStepIndex, sourceIds, assignedAttempts: [] });
      requests.push(...sourceIds.map(() => ({ optional: Boolean(routineStep.optional) })));
    }
    const assigned = allocateSourceBoundaryAttempts(requests);
    let offset = 0;
    for (const refresh of refreshes) {
      refresh.assignedAttempts = assigned.slice(offset, offset + refresh.sourceIds.length);
      offset += refresh.sourceIds.length;
    }
    return {
      refreshes,
      plannedSourceExecutions: requests.length,
      assignedBoundaryCalls: assigned.reduce((total, attempts) => total + attempts, 0),
      boundaryCallLimit: SOURCE_BOUNDARY_CALL_LIMIT,
    };
  }

  private async refreshSources(
    routineStep: IntelligenceRoutineStep,
    routineStepIndex: number,
    refreshPlan: RoutineRefreshExecutionPlan,
    step: WorkflowStep,
  ): Promise<RefreshSourcesStepResult> {
    const sourceIds = refreshPlan.sourceIds;
    if (!sourceIds.length) {
      return {
        sources: [],
        count: 0,
        completedCount: 0,
        skippedCount: 0,
        deferredCount: 0,
        partialCount: 0,
        failedCount: 0,
        status: "failed",
        error: "Source refresh resolved no sources",
      };
    }

    const outcomes: RefreshSourceResult[] = [];
    for (const [sourceIndex, sourceId] of sourceIds.entries()) {
      const assignedAttempts = refreshPlan.assignedAttempts[sourceIndex] ?? 0;
      if (assignedAttempts === 0) {
        outcomes.push({
          sourceId,
          status: "deferred",
          provider: "workers-source-boundary",
          reason: "capacity",
          assignedAttempts,
          collectionPartial: true,
          detail: `Deferred because this Routine exceeds the ${SOURCE_BOUNDARY_CALL_LIMIT}-call source boundary envelope`,
        });
        continue;
      }
      const boundary = this.ctx.exports.SourceRunBoundary;
      if (!boundary) {
        outcomes.push({
          sourceId,
          status: "deferred",
          provider: "workers-source-boundary",
          reason: "capacity",
          assignedAttempts,
          collectionPartial: true,
          detail: "Source execution boundary is unavailable",
        });
        continue;
      }
      try {
        const outcome = await step.do(
          `step ${routineStepIndex + 1} · source ${sourceIndex + 1}`,
          {
            retries: { limit: assignedAttempts - 1, delay: "15 seconds", backoff: "exponential" },
            timeout: "10 minutes",
          },
          async (): Promise<RefreshSourceResult> => {
            const boundaryOutcome = await runWorkflowSourceAcrossBoundary(boundary, sourceId);
            if (boundaryOutcome.kind === "unavailable") {
              if (boundaryOutcome.reason === "missing") {
                return { sourceId, status: "missing", assignedAttempts, error: boundaryOutcome.error.message };
              }
              if (boundaryOutcome.reason === "disabled") {
                return {
                  sourceId,
                  name: boundaryOutcome.source?.name,
                  status: "skipped",
                  reason: "disabled",
                  assignedAttempts,
                  detail: boundaryOutcome.error.message,
                };
              }
              if (boundaryOutcome.reason === "credential") {
                return {
                  sourceId,
                  name: boundaryOutcome.source?.name,
                  status: "deferred",
                  provider: "source-prerequisite",
                  reason: "credential",
                  assignedAttempts,
                  code: boundaryOutcome.code,
                  binding: boundaryOutcome.binding,
                  detail: boundedText(boundaryOutcome.error.message, ROUTINE_ERROR_TEXT_LIMIT),
                };
              }
              return {
                sourceId,
                name: boundaryOutcome.source?.name,
                status: "failed",
                provider: "source-prerequisite",
                assignedAttempts,
                error: boundedText(boundaryOutcome.error.message, ROUTINE_ERROR_TEXT_LIMIT),
              };
            }
            if (boundaryOutcome.kind === "capacity") {
              return {
                sourceId,
                status: "deferred",
                provider: "workers-source-boundary",
                reason: "capacity",
                assignedAttempts,
                collectionPartial: true,
                detail: boundedText(boundaryOutcome.error.message, ROUTINE_ERROR_TEXT_LIMIT),
              };
            }
            const result = boundaryOutcome.result;
            if (result.status === "pending") {
              throw new Error(`Source ${sourceId} did not reach a clean collection or Queue handoff`);
            }
            if (result.status === "failed") throw new Error(`Source ${sourceId} returned a failed run`);
            return {
              sourceId,
              name: boundaryOutcome.source.name,
              runId: result.runId,
              status: result.status === "queued" ? "queued" : result.status === "partial" ? "partial" : "collected",
              count: result.count,
              provider: result.provider,
              collectionPartial: result.collectionPartial || undefined,
              companion: boundaryOutcome.source.kind === "collector" || undefined,
              assignedAttempts,
            };
          },
        );
        outcomes.push(outcome);
      } catch (error) {
        outcomes.push({
          sourceId,
          status: "failed",
          assignedAttempts,
          error: boundedText(error instanceof Error ? error.message : String(error), ROUTINE_ERROR_TEXT_LIMIT),
        });
      }
    }
    return refreshSourcesStepResult(outcomes);
  }

  private async settleBuiltInSourceRuns(
    results: StepResult[],
    routineStepIndex: number,
    step: WorkflowStep,
  ): Promise<string | null> {
    const runIds = results.flatMap((entry) => {
      if (!isRefreshSourcesStepResult(entry.result)) return [];
      return entry.result.sources
        .filter((source) => source.status === "queued" && !source.companion && source.runId)
        .map((source) => source.runId!);
    });
    const settlements = await step.do(
      `step ${routineStepIndex + 1} · settle sources`,
      { retries: { limit: 3, delay: "15 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => listBuiltInSourceRunSettlements(this.env.DB, runIds),
    );
    const byRunId = new Map(settlements.map((settlement) => [settlement.runId, settlement]));
    let requiredFailure: string | null = null;
    for (const entry of results) {
      if (!isRefreshSourcesStepResult(entry.result)) continue;
      const sources = entry.result.sources.map((source): RefreshSourceResult => {
        if (source.status !== "queued" || source.companion || !source.runId) return source;
        const settlement = byRunId.get(source.runId);
        if (!settlement || ["queued", "running", "pending"].includes(settlement.status)) {
          return {
            ...source,
            settlementPending: true,
            detail: "Durable Queue handoff has not reached terminal ingestion",
          };
        }
        if (settlement.status === "failed") {
          return {
            ...source,
            status: "failed",
            settlementPending: undefined,
            error: boundedText(settlement.lastIngestError ?? "Source ingestion failed", ROUTINE_ERROR_TEXT_LIMIT),
          };
        }
        if (settlement.status === "partial" || settlement.collectionPartial) {
          return { ...source, status: "partial", collectionPartial: true, settlementPending: undefined };
        }
        if (settlement.status === "success") {
          return { ...source, status: "collected", collectionPartial: undefined, settlementPending: undefined };
        }
        return { ...source, settlementPending: true };
      });
      const refreshed = refreshSourcesStepResult(sources);
      entry.result = refreshed;
      entry.partial = refreshed.status === "partial" ? true : undefined;
      if (refreshed.status === "failed") {
        entry.ok = false;
        entry.error = refreshed.error;
        if (!entry.optional && !requiredFailure) requiredFailure = refreshed.error ?? "Source ingestion failed";
      }
    }
    return requiredFailure;
  }

  private async executeStep(missionId: string | undefined, routineStep: IntelligenceRoutineStep): Promise<RoutineStepResult> {
    switch (routineStep.action) {
      case "refresh-sources": throw new Error("refresh-sources requires source-granular Workflow execution");
      case "rebuild-mission": {
        if (!missionId) throw new Error("rebuild-mission requires a missionId");
        return startMissionMatchMaintenance(this.env, {
          missionId,
          reason: "intelligence-routine",
        });
      }
      case "sync-computer": {
        throw new Error("sync-computer requires the bounded prepare and commit Workflow steps");
      }
      case "audit-memory": return memoryAuditStepResult(await memoryGraphAudit(this.env));
      case "compile-context": {
        const task = await enqueueReasoningTask(this.env, {
          scopeKind: missionId ? "mission" : "global",
          scopeId: missionId ?? null,
          task: routineStep.reasoningTask ?? "investigate",
          target: routineStep.target ?? "generic",
          objective: String(routineStep.args?.objective ?? routineStep.name ?? "Interpret the latest material change and update the standing answer."),
          priority: Number(routineStep.args?.priority ?? 0.72),
          reason: `Prepared by Intelligence Routine ${routineStep.id}`,
          expiresInHours: Number(routineStep.args?.expiresInHours ?? 72),
        });
        return materializeReasoningTask(this.env, task.id);
      }
      case "prepare-research": {
        if (!missionId) throw new Error("prepare-research requires a missionId");
        const handoff = await buildDeepResearchHandoff(this.env, missionId);
        const task = await enqueueReasoningTask(this.env, {
          scopeKind: "mission",
          scopeId: missionId,
          task: "deep-research",
          target: routineStep.target ?? "chatgpt",
          objective: handoff.mission.question || handoff.mission.name,
          priority: Math.min(1, 0.55 + handoff.recommendation.score * 0.45),
          reason: handoff.recommendation.reasons.join(" ") || handoff.recommendation.whyNow,
          expiresInHours: 24 * 7,
          dedupeKey: `routine-research:${missionId}:${routineStep.id}:${handoff.currentState[0]?.changedAt?.slice(0, 10) ?? "baseline"}`,
        });
        return {
          task: await materializeReasoningTask(this.env, task.id),
          handoff: { recommendation: handoff.recommendation, title: handoff.mission.name },
        };
      }
      case "checkpoint-memory": return checkpointMemoryStepResult(await createMemoryCheckpoint(this.env, {
        scopeKind: missionId ? "mission" : "global",
        scopeId: missionId,
        reason: String(routineStep.args?.reason ?? "Intelligence Routine checkpoint"),
      }));
      case "wait-for-ingest": return { waited: true };
    }
  }
}
