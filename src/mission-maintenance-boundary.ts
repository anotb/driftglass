import { WorkerEntrypoint } from "cloudflare:workers";
import {
  commitMissionComputerSync,
  loadMissionComputerSyncSnapshot,
  renderMissionComputerSyncPlan,
  type MissionComputerSummary,
  type MissionComputerSyncPlan,
  type MissionComputerSyncSnapshot,
} from "./mission-computer";
import {
  commitMissionMatchRebuild,
  evaluateMissionMatchPage,
  planMissionMatchRebuild,
  type MissionMatchPageResult,
  type MissionMatchRebuildPlan,
  type MissionMatchRebuildResult,
} from "./missions";
import type { Env } from "./types";

const MISSION_ID_RPC_LIMIT = 256;
const MISSION_SYNC_REASON_RPC_LIMIT = 100;

function validMissionId(missionId: string): boolean {
  return typeof missionId === "string" && missionId.length > 0 && missionId.length <= MISSION_ID_RPC_LIMIT;
}

export interface MissionMaintenanceBoundaryClient {
  planMatches(missionId: string): Promise<MissionMatchRebuildPlan>;
  evaluateMatches(
    input: Pick<MissionMatchRebuildPlan, "missionId" | "missionUpdatedAt"> & { storyIds: string[] },
  ): Promise<MissionMatchPageResult>;
  commitMatches(
    plan: MissionMatchRebuildPlan,
    pages: MissionMatchPageResult[],
  ): Promise<MissionMatchRebuildResult>;
  loadComputer(missionId: string, reason: string): Promise<MissionComputerSyncSnapshot>;
  renderComputer(snapshot: MissionComputerSyncSnapshot): Promise<MissionComputerSyncPlan>;
  commitComputer(plan: MissionComputerSyncPlan): Promise<MissionComputerSummary>;
}

export async function planMissionMatchesAcrossBoundary(
  boundary: MissionMaintenanceBoundaryClient,
  missionId: string,
): Promise<MissionMatchRebuildPlan> {
  return boundary.planMatches(missionId);
}

export async function evaluateMissionMatchesAcrossBoundary(
  boundary: MissionMaintenanceBoundaryClient,
  input: Pick<MissionMatchRebuildPlan, "missionId" | "missionUpdatedAt"> & { storyIds: string[] },
): Promise<MissionMatchPageResult> {
  return boundary.evaluateMatches(input);
}

export async function commitMissionMatchesAcrossBoundary(
  boundary: MissionMaintenanceBoundaryClient,
  plan: MissionMatchRebuildPlan,
  pages: MissionMatchPageResult[],
): Promise<MissionMatchRebuildResult> {
  return boundary.commitMatches(plan, pages);
}

export async function loadMissionComputerAcrossBoundary(
  boundary: MissionMaintenanceBoundaryClient,
  missionId: string,
  reason: string,
): Promise<MissionComputerSyncSnapshot> {
  return boundary.loadComputer(missionId, reason);
}

export async function renderMissionComputerAcrossBoundary(
  boundary: MissionMaintenanceBoundaryClient,
  snapshot: MissionComputerSyncSnapshot,
): Promise<MissionComputerSyncPlan> {
  return boundary.renderComputer(snapshot);
}

export async function commitMissionComputerAcrossBoundary(
  boundary: MissionMaintenanceBoundaryClient,
  plan: MissionComputerSyncPlan,
): Promise<MissionComputerSummary> {
  return boundary.commitComputer(plan);
}

/**
 * Each RPC receives a new Worker invocation. The maintenance Workflow uses the
 * methods page by page so evidence matching and Computer refresh never share a
 * D1 or CPU envelope with the API request or with each other.
 */
export class MissionMaintenanceBoundary extends WorkerEntrypoint<Env> {
  async planMatches(missionId: string): Promise<MissionMatchRebuildPlan> {
    if (!validMissionId(missionId)) throw new Error("Mission id is invalid");
    return planMissionMatchRebuild(this.env, missionId);
  }

  async evaluateMatches(
    input: Pick<MissionMatchRebuildPlan, "missionId" | "missionUpdatedAt"> & { storyIds: string[] },
  ): Promise<MissionMatchPageResult> {
    if (!validMissionId(input.missionId)) throw new Error("Mission id is invalid");
    return evaluateMissionMatchPage(this.env, input);
  }

  async commitMatches(
    plan: MissionMatchRebuildPlan,
    pages: MissionMatchPageResult[],
  ): Promise<MissionMatchRebuildResult> {
    if (!validMissionId(plan.missionId)) throw new Error("Mission id is invalid");
    return commitMissionMatchRebuild(this.env, plan, pages);
  }

  async loadComputer(missionId: string, reason: string): Promise<MissionComputerSyncSnapshot> {
    if (!validMissionId(missionId)) throw new Error("Mission id is invalid");
    if (typeof reason !== "string" || reason.length > MISSION_SYNC_REASON_RPC_LIMIT) {
      throw new Error("Mission sync reason is invalid");
    }
    return loadMissionComputerSyncSnapshot(this.env, missionId, reason);
  }

  async renderComputer(snapshot: MissionComputerSyncSnapshot): Promise<MissionComputerSyncPlan> {
    if (!validMissionId(snapshot?.missionId)) throw new Error("Mission id is invalid");
    return renderMissionComputerSyncPlan(snapshot);
  }

  async commitComputer(plan: MissionComputerSyncPlan): Promise<MissionComputerSummary> {
    if (!validMissionId(plan?.missionId)) throw new Error("Mission id is invalid");
    return commitMissionComputerSync(this.env, plan);
  }
}
