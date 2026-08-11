import type { ExecutionCapacity } from "./types";

export const SCHEDULED_INTERVAL_MS = 5 * 60_000;

export const SCHEDULED_LANES = [
  "source",
  "hygiene",
  "mission",
  "routine",
  "lineage",
  "reasoning-discovery",
  "source",
  "reasoning-materialization",
  "memory",
  "briefing",
  "ai-search",
  "hygiene",
] as const;

export type ScheduledLane = typeof SCHEDULED_LANES[number];

export type ScheduledLaneHandlers = Readonly<Record<ScheduledLane, () => Promise<void>>>;

/**
 * One deterministic lane executes per Cron invocation. The two source slots
 * remain 30 minutes apart while every maintenance lane receives service at
 * least hourly, independent of whether sources are continuously due.
 */
export function scheduledLaneAt(value: Date | number): ScheduledLane {
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(timestamp)) throw new Error("Scheduled time is invalid");
  const slot = Math.floor(timestamp / SCHEDULED_INTERVAL_MS);
  const index = ((slot % SCHEDULED_LANES.length) + SCHEDULED_LANES.length) % SCHEDULED_LANES.length;
  return SCHEDULED_LANES[index]!;
}

export async function runScheduledLane(
  value: Date | number,
  handlers: ScheduledLaneHandlers,
): Promise<ScheduledLane> {
  const lane = scheduledLaneAt(value);
  await handlers[lane]();
  return lane;
}

export function scheduledSourceLimit(executionCapacity: ExecutionCapacity): number {
  return executionCapacity === "expanded-confirmed" ? 12 : 1;
}

export function scheduledSourceConcurrency(executionCapacity: ExecutionCapacity): number {
  return executionCapacity === "expanded-confirmed" ? 3 : 1;
}

export function starterPackSourcePlan(
  executionCapacity: ExecutionCapacity,
  runNow: boolean,
  sourceCount: number,
): { scheduled: number; immediate: number; deferred: number } {
  const count = Number.isFinite(sourceCount) ? Math.max(0, Math.floor(sourceCount)) : 0;
  if (!runNow) return { scheduled: 0, immediate: 0, deferred: 0 };
  // Pack installation itself is a D1 write path. Free-safe execution leaves
  // every installed source due for a later source lane; confirmed expanded
  // capacity may start a small, independently bounded prefix.
  const immediate = executionCapacity === "expanded-confirmed" ? Math.min(8, count) : 0;
  return { scheduled: count, immediate, deferred: count - immediate };
}
