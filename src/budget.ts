import { getUsageDaily, getUsageMonth, recordUsage, reserveMonthlyUsage, reserveUsage, setSetting } from "./db";
import type { BudgetProfileName, ExecutionCapacity, UsageDimension } from "./types";
import { isoNow, parseJson } from "./utils";

export interface BudgetLimits {
  browser_ms_day: number;
  workflow_steps_day: number;
  ai_search_queries_month: number;
  memory_writes_day: number;
  source_runs_day: number;
  queue_messages_day: number;
  computer_sync_bytes_day: number;
  r2_class_a_ops_day: number;
  r2_class_b_ops_day: number;
  r2_write_bytes_day: number;
}

export interface BudgetStatus {
  profile: BudgetProfileName;
  executionCapacity: ExecutionCapacity;
  /** Effective enforcement limits. Retained as `limits` for API compatibility. */
  limits: BudgetLimits;
  effectiveLimits: BudgetLimits;
  plannedLimits: BudgetLimits;
  daily: Record<string, number>;
  monthly: Record<string, number>;
  remaining: Record<string, number>;
  utilization: Record<string, number>;
  degraded: string[];
  checkedAt: string;
}

export interface BudgetReservation {
  day: string;
  dimension: Exclude<UsageDimension, "ai_search_queries">;
  units: number;
}

const settlingReservations = new WeakSet<object>();
const settledReservations = new WeakSet<object>();

export class BudgetDeferredError extends Error {
  readonly dimension: UsageDimension;
  readonly requested: number;
  readonly remaining: number;

  constructor(dimension: UsageDimension, requested: number, remaining: number) {
    super(`Budget deferred ${dimension}: requested ${requested}, remaining ${remaining}`);
    this.name = "BudgetDeferredError";
    this.dimension = dimension;
    this.requested = requested;
    this.remaining = remaining;
  }
}

const PROFILES: Record<Exclude<BudgetProfileName, "custom">, BudgetLimits> = {
  free: {
    // Eight of the ten Browser Run minutes/day leaves recovery and manual-inspection headroom.
    browser_ms_day: 480_000,
    // Workflows Free currently includes 3,000 steps/day. Keep 20% in reserve.
    workflow_steps_day: 2_400,
    // Use 75% of the current AI Search query allowance as a conservative
    // envelope shared by semantic queries and bounded sync binding operations.
    ai_search_queries_month: 15_000,
    // Conservative application-level write envelope beneath D1's daily write allowance.
    memory_writes_day: 5_000,
    source_runs_day: 240,
    queue_messages_day: 2_500,
    computer_sync_bytes_day: 20 * 1024 * 1024,
    // A 31-day month reaches at most 310k puts, retaining 69% of R2's
    // one-million monthly Class A allowance for lifecycle and operator work.
    r2_class_a_ops_day: 10_000,
    // The Free envelope also limits attacker-driven object reads and the D1
    // reservation writes used to make this boundary atomic.
    r2_class_b_ops_day: 50_000,
    // With the managed raw/ lifecycle, 31 full days are at most 3.03 GiB of
    // submitted write bodies. Durable artifacts share this lane rather than bypassing it.
    r2_write_bytes_day: 100 * 1024 * 1024,
  },
  cheap: {
    // Fifteen minutes/day is at most 7.75 hours in a 31-day month, retaining at
    // least 22.5% headroom beneath Browser Run's 10-hour Paid inclusion.
    browser_ms_day: 900_000,
    workflow_steps_day: 12_000,
    ai_search_queries_month: 100_000,
    memory_writes_day: 25_000,
    source_runs_day: 1_500,
    // About 9k messages/day leaves headroom below the Paid plan's one-million monthly Queue operations
    // because a delivered message normally incurs roughly three Queue operations: write, read, and delete.
    queue_messages_day: 9_000,
    computer_sync_bytes_day: 200 * 1024 * 1024,
    // Worst-case 31-day totals are 620k Class A and 6.2m Class B operations,
    // retaining 38% of each current R2 monthly free allowance.
    r2_class_a_ops_day: 20_000,
    r2_class_b_ops_day: 200_000,
    // 31 full days are at most 6.05 GiB. This bounds the raw/ input rate;
    // durable artifact inventory remains a separately monitored concern.
    r2_write_bytes_day: 200 * 1024 * 1024,
  },
};

const WORKERS_DEPENDENT_LIMIT_KEYS = [
  "browser_ms_day",
  "workflow_steps_day",
  "ai_search_queries_month",
  "memory_writes_day",
  "source_runs_day",
  "queue_messages_day",
  "computer_sync_bytes_day",
] as const satisfies readonly (keyof BudgetLimits)[];

function dimensionLimitKey(dimension: UsageDimension): keyof BudgetLimits {
  switch (dimension) {
    case "browser_ms": return "browser_ms_day";
    case "workflow_steps": return "workflow_steps_day";
    case "ai_search_queries": return "ai_search_queries_month";
    case "memory_writes": return "memory_writes_day";
    case "source_runs": return "source_runs_day";
    case "queue_messages": return "queue_messages_day";
    case "computer_sync_bytes": return "computer_sync_bytes_day";
    case "r2_class_a_ops": return "r2_class_a_ops_day";
    case "r2_class_b_ops": return "r2_class_b_ops_day";
    case "r2_write_bytes": return "r2_write_bytes_day";
  }
}

export function limitsForProfile(profile: BudgetProfileName, custom?: Partial<BudgetLimits>): BudgetLimits {
  if (profile !== "custom") return { ...PROFILES[profile] };
  const fallback = PROFILES.free;
  return Object.fromEntries(
    Object.entries(fallback).map(([key, value]) => {
      const configured = Number(custom?.[key as keyof BudgetLimits] ?? value);
      return [key, Number.isFinite(configured) ? Math.max(0, configured) : value];
    }),
  ) as unknown as BudgetLimits;
}

/**
 * A selected profile is a plan, not proof that the account can execute it.
 * Until Workers Paid is explicitly confirmed, Worker-backed lanes retain the
 * lower of the planned limit and the Free envelope. R2 has an independent
 * allowance, so its explicit planned limits remain effective in either mode.
 */
export function effectiveLimitsForExecution(
  plannedLimits: BudgetLimits,
  executionCapacity: ExecutionCapacity,
): BudgetLimits {
  const effective = { ...plannedLimits };
  if (executionCapacity !== "expanded-confirmed") {
    for (const key of WORKERS_DEPENDENT_LIMIT_KEYS) {
      effective[key] = Math.min(effective[key], PROFILES.free[key]);
    }
  }
  return effective;
}

/** Daily planning and per-invocation platform capacity are deliberately separate. */
export function sourceRunsPerInvocation(executionCapacity: ExecutionCapacity, expandedMaximum: number): number {
  const requestedMaximum = Number.isFinite(expandedMaximum) ? Math.floor(expandedMaximum) : 1;
  const boundedMaximum = Math.max(1, Math.min(12, requestedMaximum));
  return executionCapacity === "expanded-confirmed" ? boundedMaximum : 1;
}

export function sourceRunConcurrency(executionCapacity: ExecutionCapacity, expandedMaximum = 3): number {
  const requestedMaximum = Number.isFinite(expandedMaximum) ? Math.floor(expandedMaximum) : 1;
  const boundedMaximum = Math.max(1, Math.min(3, requestedMaximum));
  return executionCapacity === "expanded-confirmed" ? boundedMaximum : 1;
}

export function d1QueryEnvelope(executionCapacity: ExecutionCapacity): number {
  return executionCapacity === "expanded-confirmed" ? 900 : 46;
}

export async function getBudgetProfile(db: D1Database): Promise<{
  profile: BudgetProfileName;
  /** Planned profile limits. Retained as `limits` for internal compatibility. */
  limits: BudgetLimits;
  plannedLimits: BudgetLimits;
  effectiveLimits: BudgetLimits;
  executionCapacity: ExecutionCapacity;
}> {
  const result = await db
    .prepare("SELECT key, value FROM settings WHERE key IN ('budget_profile', 'budget_custom_limits', 'execution_capacity')")
    .all<{ key: string; value: string }>();
  const settings = Object.fromEntries((result.results ?? []).map((row) => [row.key, row.value]));
  const configured = settings.budget_profile as BudgetProfileName | undefined;
  const profile: BudgetProfileName = configured === "cheap" || configured === "custom" ? configured : "free";
  const executionCapacity: ExecutionCapacity = settings.execution_capacity === "expanded-confirmed"
    ? "expanded-confirmed"
    : "free-safe";
  const custom = profile === "custom"
    ? parseJson<Partial<BudgetLimits>>(settings.budget_custom_limits, {})
    : undefined;
  const limits = limitsForProfile(profile, custom);
  return {
    profile,
    limits,
    plannedLimits: limits,
    effectiveLimits: effectiveLimitsForExecution(limits, executionCapacity),
    executionCapacity,
  };
}

export async function setBudgetProfile(
  db: D1Database,
  profile: BudgetProfileName,
  custom?: Partial<BudgetLimits>,
): Promise<void> {
  await setSetting(db, "budget_profile", profile);
  if (profile === "custom" && custom) await setSetting(db, "budget_custom_limits", JSON.stringify(custom));
}

export async function setExecutionCapacity(db: D1Database, executionCapacity: ExecutionCapacity): Promise<void> {
  await setSetting(db, "execution_capacity", executionCapacity);
}

export async function budgetStatus(db: D1Database): Promise<BudgetStatus> {
  const [{ profile, plannedLimits, effectiveLimits, executionCapacity }, dailyRows, monthRows] = await Promise.all([
    getBudgetProfile(db),
    getUsageDaily(db),
    getUsageMonth(db),
  ]);
  const daily = Object.fromEntries(dailyRows.map((row) => [row.dimension, Number(row.units)]));
  const monthly = Object.fromEntries(monthRows.map((row) => [row.dimension, Number(row.units)]));
  const remaining: Record<string, number> = {};
  const utilization: Record<string, number> = {};
  const degraded: string[] = [];
  for (const dimension of [
    "browser_ms", "workflow_steps", "ai_search_queries", "memory_writes", "source_runs", "queue_messages", "computer_sync_bytes",
    "r2_class_a_ops", "r2_class_b_ops", "r2_write_bytes",
  ] as UsageDimension[]) {
    const key = dimensionLimitKey(dimension);
    const used = dimension === "ai_search_queries" ? Number(monthly[dimension] ?? 0) : Number(daily[dimension] ?? 0);
    const limit = effectiveLimits[key];
    const left = Math.max(0, limit - used);
    remaining[dimension] = left;
    utilization[dimension] = limit > 0 ? Math.min(1, used / limit) : 1;
    if (limit === 0 || left / limit < 0.1) degraded.push(dimension);
  }
  return {
    profile,
    executionCapacity,
    limits: effectiveLimits,
    effectiveLimits,
    plannedLimits,
    daily,
    monthly,
    remaining,
    utilization,
    degraded,
    checkedAt: isoNow(),
  };
}

export async function canSpend(
  db: D1Database,
  dimension: UsageDimension,
  units: number,
): Promise<{ allowed: boolean; remaining: number; profile: BudgetProfileName }> {
  const status = await budgetStatus(db);
  const remaining = Number(status.remaining[dimension] ?? 0);
  return { allowed: remaining >= units, remaining, profile: status.profile };
}

export async function reserve(
  db: D1Database,
  dimension: Exclude<UsageDimension, "ai_search_queries">,
  units: number,
  metadata: Record<string, unknown> = {},
): Promise<{
  allowed: boolean;
  remaining: number;
  profile: BudgetProfileName;
  executionCapacity: ExecutionCapacity;
  reservation?: BudgetReservation;
}> {
  const { profile, effectiveLimits, executionCapacity } = await getBudgetProfile(db);
  const limit = effectiveLimits[dimensionLimitKey(dimension)];
  const day = isoNow().slice(0, 10);
  const result = await reserveUsage(db, dimension, units, limit, metadata, day);
  return {
    allowed: result.reserved,
    remaining: Math.max(0, limit - result.used),
    profile,
    executionCapacity,
    ...(result.reserved ? { reservation: { day, dimension, units } } : {}),
  };
}

export async function reserveMonthly(
  db: D1Database,
  dimension: Extract<UsageDimension, "ai_search_queries">,
  units: number,
  metadata: Record<string, unknown> = {},
): Promise<{
  allowed: boolean;
  remaining: number;
  profile: BudgetProfileName;
  executionCapacity: ExecutionCapacity;
}> {
  const { profile, effectiveLimits, executionCapacity } = await getBudgetProfile(db);
  const limit = effectiveLimits[dimensionLimitKey(dimension)];
  const result = await reserveMonthlyUsage(db, dimension, units, limit, metadata);
  return {
    allowed: result.reserved,
    remaining: Math.max(0, limit - result.used),
    profile,
    executionCapacity,
  };
}

/**
 * Reconciles an invocation-local maximum reservation to measured usage.
 *
 * The aggregate daily ledger has no durable per-operation token, so callers
 * must invoke this exactly once with the reservation returned by `reserve`.
 * An invalid or unavailable measurement retains the full reservation. A
 * failed reconciliation also fails conservatively: the maximum remains used.
 */
export async function settleReservation(
  db: D1Database,
  reservation: BudgetReservation,
  measuredUnits: number | undefined,
  metadata: Record<string, unknown> = {},
): Promise<{ charged: number; released: number }> {
  if (settlingReservations.has(reservation) || settledReservations.has(reservation)) {
    throw new Error(`Budget reservation was already settled for ${reservation.dimension}`);
  }
  settlingReservations.add(reservation);
  const measured = Number(measuredUnits);
  const charged = Number.isFinite(measured) && measured >= 0
    ? Math.min(reservation.units, Math.ceil(measured))
    : reservation.units;
  const released = Math.max(0, reservation.units - charged);

  try {
    const result = await db
      .prepare(
        `UPDATE usage_daily
         SET units = units - ?, metadata_json = ?, updated_at = ?
         WHERE day = ? AND dimension = ? AND units >= ?`,
      )
      .bind(
        released,
        JSON.stringify({ ...metadata, reservedUnits: reservation.units, chargedUnits: charged, releasedUnits: released }),
        isoNow(),
        reservation.day,
        reservation.dimension,
        released,
      )
      .run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new Error(`Budget reservation could not be settled for ${reservation.dimension}`);
    }
    settledReservations.add(reservation);
    return { charged, released };
  } finally {
    settlingReservations.delete(reservation);
  }
}

export async function requireBudget(
  db: D1Database,
  dimension: Exclude<UsageDimension, "ai_search_queries">,
  units: number,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const result = await reserve(db, dimension, units, metadata);
  if (!result.allowed) throw new BudgetDeferredError(dimension, units, result.remaining);
}

export async function requireMonthlyBudget(
  db: D1Database,
  dimension: Extract<UsageDimension, "ai_search_queries">,
  units: number,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const result = await reserveMonthly(db, dimension, units, metadata);
  if (!result.allowed) throw new BudgetDeferredError(dimension, units, result.remaining);
}

export async function spend(
  db: D1Database,
  dimension: UsageDimension,
  units: number,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await recordUsage(db, dimension, units, metadata);
}
