import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  getMission,
  listBuiltInSourceRunSettlements,
  updateMissionRun,
} from "./db";
import {
  MISSION_MATCH_REBUILD_STORY_PAGE_SIZE,
  MISSION_MATCH_MAINTENANCE_RETRY_PAGE_LIMIT,
  startMissionMatchMaintenance,
  type MissionMatchMaintenanceStart,
  type MissionMatchPageResult,
  type MissionMatchRebuildResult,
} from "./missions";
import {
  commitMissionComputerAcrossBoundary,
  commitMissionMatchesAcrossBoundary,
  evaluateMissionMatchesAcrossBoundary,
  loadMissionComputerAcrossBoundary,
  planMissionMatchesAcrossBoundary,
  renderMissionComputerAcrossBoundary,
} from "./mission-maintenance-boundary";
import { resolveMissionSourceIds } from "./mission-autopilot";
import {
  allocateSourceBoundaryAttempts,
  SOURCE_BOUNDARY_CALL_LIMIT,
} from "./source-execution-envelope";
import { runWorkflowSourceAcrossBoundary } from "./source-run-boundary";
import type { Env, MissionSprintWorkflowParams, MissionWorkflowParams } from "./types";
import { isoNow } from "./utils";

const MISSION_SOURCE_LIMIT = 30;

type SprintSourceResult = {
  sourceId: string;
  name: string;
  runId?: string;
  status: "collected" | "queued" | "partial" | "deferred" | "skipped" | "failed";
  count: number;
  provider?: string;
  collectionPartial?: boolean;
  settlementPending?: boolean;
  companion?: boolean;
  reason?: "credential" | "disabled" | "capacity";
  assignedAttempts?: number;
  code?: string;
  binding?: string;
  error?: string;
};

type MissionSprintFinalResult = {
  missionName: string;
  sourceResults: SprintSourceResult[];
  plannedSourceCount: number;
  failedSourceCount: number;
  partialSourceCount: number;
  deferredSourceCount: number;
  skippedSourceCount: number;
  queuedCompanionSourceCount: number;
  collectedItems: number;
  matchedStories: null;
  matchesPending: true;
  matchMaintenance: MissionMatchMaintenanceStart;
  topMatches: [];
  completedAt: string;
};

type MissionComputerSyncResult =
  | { ok: true; syncedAt: string | null; files: number }
  | { ok: true; queued: true; workflowId: string };

export class MissionSprintWorkflow extends WorkflowEntrypoint<Env, MissionWorkflowParams> {
  override async run(event: WorkflowEvent<MissionWorkflowParams>, step: WorkflowStep) {
    if (event.payload.mode === "computer-sync") {
      const { missionId, reason } = event.payload;
      const boundary = this.ctx.exports.MissionMaintenanceBoundary;
      if (!boundary) throw new Error("Mission maintenance boundary is unavailable");
      const snapshot = await step.do(
        "load Mission Computer snapshot",
        { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "5 minutes" },
        async () => loadMissionComputerAcrossBoundary(boundary, missionId, reason),
      );
      const plan = await step.do(
        "render Mission Computer plan",
        { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "5 minutes" },
        async () => renderMissionComputerAcrossBoundary(boundary, snapshot),
      );
      const computer = await step.do(
        "commit Mission Computer",
        { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "5 minutes" },
        async () => commitMissionComputerAcrossBoundary(boundary, plan),
      );
      return { mode: "computer-sync", missionId, reason, computer };
    }
    if (event.payload.mode === "match-maintenance") {
      const { missionId, reason } = event.payload;
      const boundary = this.ctx.exports.MissionMaintenanceBoundary;
      if (!boundary) throw new Error("Mission maintenance boundary is unavailable");
      const plan = await step.do(
        "plan Mission match maintenance",
        { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "1 minute" },
        async () => planMissionMatchesAcrossBoundary(boundary, missionId),
      );
      const pages: MissionMatchPageResult[] = [];
      const retryPageCount = MISSION_MATCH_MAINTENANCE_RETRY_PAGE_LIMIT;
      for (let offset = 0; offset < plan.storyIds.length; offset += MISSION_MATCH_REBUILD_STORY_PAGE_SIZE) {
        const pageIndex = Math.floor(offset / MISSION_MATCH_REBUILD_STORY_PAGE_SIZE);
        pages.push(await step.do(
          `evaluate Mission match page ${pageIndex + 1}`,
          {
            retries: {
              limit: pageIndex < retryPageCount ? 1 : 0,
              delay: "5 seconds",
              backoff: "constant",
            },
            timeout: "1 minute",
          },
          async () => evaluateMissionMatchesAcrossBoundary(boundary, {
            missionId: plan.missionId,
            missionUpdatedAt: plan.missionUpdatedAt,
            storyIds: plan.storyIds.slice(offset, offset + MISSION_MATCH_REBUILD_STORY_PAGE_SIZE),
          }),
        ));
      }
      const rebuilt: MissionMatchRebuildResult = await step.do(
        "commit Mission match maintenance",
        { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "1 minute" },
        async () => commitMissionMatchesAcrossBoundary(boundary, plan, pages),
      );
      const computerSnapshot = await step.do(
        "load Mission Computer snapshot after match maintenance",
        { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "5 minutes" },
        async () => loadMissionComputerAcrossBoundary(boundary, missionId, reason),
      );
      const computerPlan = await step.do(
        "render Mission Computer plan after match maintenance",
        { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "5 minutes" },
        async () => renderMissionComputerAcrossBoundary(boundary, computerSnapshot),
      );
      const synced = await step.do(
        "commit Mission Computer after match maintenance",
        { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "5 minutes" },
        async () => commitMissionComputerAcrossBoundary(boundary, computerPlan),
      );
      const computerSync: MissionComputerSyncResult = {
        ok: true,
        syncedAt: synced.syncedAt,
        files: synced.fileCount,
      };
      return { mode: "match-maintenance", missionId, reason, ...rebuilt, computerSync };
    }

    const sprintPayload = event.payload as Readonly<MissionSprintWorkflowParams>;
    const { runId, missionId } = sprintPayload;

    try {
      const plan = await step.do("resolve mission and source plan", async () => {
        const mission = await getMission(this.env.DB, missionId);
        if (!mission) throw new Error(`Mission not found: ${missionId}`);
        const resolvedSourceIds = Array.isArray(sprintPayload.sourceIds)
          ? sprintPayload.sourceIds
          : await resolveMissionSourceIds(this.env, mission);
        const sourceIds = [...new Set(resolvedSourceIds)].slice(0, MISSION_SOURCE_LIMIT);
        const sourceAttempts = allocateSourceBoundaryAttempts(sourceIds.map(() => ({ optional: false })));
        await updateMissionRun(this.env.DB, runId, {
          workflowId: event.instanceId,
          status: "running",
          sourceIds,
          startedAt: isoNow(),
          result: {
            missionName: mission.name,
            plannedSourceCount: sourceIds.length,
            assignedBoundaryCalls: sourceAttempts.reduce((total, attempts) => total + attempts, 0),
            boundaryCallLimit: SOURCE_BOUNDARY_CALL_LIMIT,
          },
        });
        return { missionName: mission.name, sourceIds, sourceAttempts };
      });

      const sourceResults: SprintSourceResult[] = [];
      for (const [sourceIndex, sourceId] of plan.sourceIds.entries()) {
        const assignedAttempts = plan.sourceAttempts[sourceIndex] ?? 0;
        if (assignedAttempts === 0) {
          sourceResults.push({
            sourceId,
            name: sourceId,
            status: "deferred",
            count: 0,
            provider: "workers-source-boundary",
            reason: "capacity",
            assignedAttempts,
            collectionPartial: true,
            error: `Deferred because this Mission exceeds the ${SOURCE_BOUNDARY_CALL_LIMIT}-call source boundary envelope`,
          });
          continue;
        }
        const boundary = this.ctx.exports.SourceRunBoundary;
        if (!boundary) {
          sourceResults.push({
            sourceId,
            name: sourceId,
            status: "deferred",
            count: 0,
            provider: "workers-source-boundary",
            reason: "capacity",
            assignedAttempts,
            collectionPartial: true,
            error: "Source execution boundary is unavailable",
          });
          continue;
        }
        try {
          const result = await step.do(
            `collect source ${sourceIndex + 1}`,
            {
              retries: { limit: assignedAttempts - 1, delay: "15 seconds", backoff: "exponential" },
              timeout: "5 minutes",
            },
            async (): Promise<SprintSourceResult> => {
              const boundaryOutcome = await runWorkflowSourceAcrossBoundary(boundary, sourceId);
              if (boundaryOutcome.kind === "unavailable") {
                if (boundaryOutcome.reason === "missing") {
                  return {
                    sourceId,
                    name: sourceId,
                    status: "failed",
                    count: 0,
                    assignedAttempts,
                    error: boundaryOutcome.error.message,
                  };
                }
                if (boundaryOutcome.reason === "disabled") {
                  return {
                    sourceId,
                    name: boundaryOutcome.source?.name ?? sourceId,
                    status: "skipped",
                    count: 0,
                    reason: "disabled",
                    assignedAttempts,
                  };
                }
                if (boundaryOutcome.reason === "credential") {
                  return {
                    sourceId,
                    name: boundaryOutcome.source?.name ?? sourceId,
                    status: "deferred",
                    count: 0,
                    provider: "source-prerequisite",
                    reason: "credential",
                    assignedAttempts,
                    code: boundaryOutcome.code,
                    binding: boundaryOutcome.binding,
                  };
                }
                return {
                  sourceId,
                  name: boundaryOutcome.source?.name ?? sourceId,
                  status: "failed",
                  count: 0,
                  assignedAttempts,
                  error: boundaryOutcome.error.message,
                };
              }
              if (boundaryOutcome.kind === "capacity") {
                return {
                  sourceId,
                  name: sourceId,
                  status: "deferred",
                  count: 0,
                  provider: "workers-source-boundary",
                  reason: "capacity",
                  assignedAttempts,
                  collectionPartial: true,
                  error: boundaryOutcome.error.message,
                };
              }
              const collected = boundaryOutcome.result;
              if (collected.status === "pending") {
                throw new Error(`Source ${sourceId} did not reach a clean collection or Queue handoff`);
              }
              if (collected.status === "failed") throw new Error(`Source ${sourceId} returned a failed run`);
              return {
                sourceId,
                name: boundaryOutcome.source.name,
                runId: collected.runId,
                status: collected.status === "queued" ? "queued" : collected.status === "partial" ? "partial" : "collected",
                count: collected.count,
                provider: collected.provider,
                collectionPartial: collected.collectionPartial || undefined,
                companion: boundaryOutcome.source.kind === "collector" || undefined,
                assignedAttempts,
              };
            },
          );
          sourceResults.push(result);
        } catch (error) {
          sourceResults.push({
            sourceId,
            name: sourceId,
            status: "failed",
            count: 0,
            assignedAttempts,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Queue consumers and a paired Companion get a durable window to return evidence.
      await step.sleep("wait for ingestion and Companion results", "45 seconds");
      const settlements = await step.do(
        "settle built-in source runs",
        { retries: { limit: 3, delay: "15 seconds", backoff: "exponential" }, timeout: "5 minutes" },
        async () => listBuiltInSourceRunSettlements(
          this.env.DB,
          sourceResults
            .filter((source) => source.status === "queued" && !source.companion && source.runId)
            .map((source) => source.runId!),
        ),
      );
      const settlementByRunId = new Map(settlements.map((settlement) => [settlement.runId, settlement]));
      for (const source of sourceResults) {
        if (source.status !== "queued" || source.companion || !source.runId) continue;
        const settlement = settlementByRunId.get(source.runId);
        if (!settlement || ["queued", "running", "pending"].includes(settlement.status)) {
          source.settlementPending = true;
          continue;
        }
        source.settlementPending = undefined;
        if (settlement.status === "failed") {
          source.status = "failed";
          source.error = settlement.lastIngestError ?? "Source ingestion failed";
        } else if (settlement.status === "partial" || settlement.collectionPartial) {
          source.status = "partial";
          source.collectionPartial = true;
        } else if (settlement.status === "success") {
          source.status = "collected";
          source.collectionPartial = undefined;
        } else {
          source.settlementPending = true;
        }
      }

      const matchMaintenance = await step.do(
        "queue Mission match maintenance",
        { retries: { limit: 0, delay: "15 seconds", backoff: "linear" }, timeout: "1 minute" },
        async () => startMissionMatchMaintenance(this.env, {
          missionId,
          reason: "mission-sprint-complete",
        }),
      );

      const final = await step.do<MissionSprintFinalResult>("finalize mission sprint", async () => {
        const failed = sourceResults.filter((source) => source.status === "failed").length;
        const partial = sourceResults.filter(
          (source) => source.status === "partial" || source.collectionPartial || source.settlementPending,
        ).length;
        const deferred = sourceResults.filter((source) => source.status === "deferred").length;
        const skipped = sourceResults.filter((source) => source.status === "skipped").length;
        const queued = sourceResults.filter((source) => source.status === "queued" && source.companion).length;
        const completed = sourceResults.filter((source) => source.status === "queued" || source.status === "collected").length;
        const collectedItems = sourceResults.reduce((total, source) => total + source.count, 0);
        const result: MissionSprintFinalResult = {
          missionName: plan.missionName,
          sourceResults,
          plannedSourceCount: plan.sourceIds.length,
          failedSourceCount: failed,
          partialSourceCount: partial,
          deferredSourceCount: deferred,
          skippedSourceCount: skipped,
          queuedCompanionSourceCount: queued,
          collectedItems,
          matchedStories: null,
          matchesPending: true,
          matchMaintenance,
          topMatches: [],
          completedAt: isoNow(),
        };
        const status = failed > 0
          ? (completed > 0 || partial > 0 ? "partial" : "failed")
          : partial > 0 || completed === 0 ? "partial" : "complete";
        await updateMissionRun(this.env.DB, runId, {
          status,
          completedAt: isoNow(),
          result,
          error: failed > 0 ? `${failed} source${failed === 1 ? "" : "s"} failed` : null,
        });
        return result;
      });

      return {
        runId,
        missionId,
        ...final,
        computerSync: { ok: true, queued: true, workflowId: matchMaintenance.workflowId },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do("fail mission sprint", async () => {
        await updateMissionRun(this.env.DB, runId, {
          status: "failed",
          completedAt: isoNow(),
          error: message,
          result: { missionId, workflowId: event.instanceId, failedAt: isoNow() },
        });
      });
      throw error;
    }
  }
}
