import { getSetting, getSourceCadence, upsertSourceCadence } from "./db";
import type { SourceCadenceRecord, SourceRecord } from "./types";

export interface CadenceObservation {
  status: "success" | "partial" | "failed" | "queued" | "pending";
  itemCount: number;
  latencyMs: number;
  meaningfulCount?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function ema(previous: number, current: number, alpha = 0.25): number {
  return previous * (1 - alpha) + current * alpha;
}

function deterministicJitter(sourceId: string, minutes: number, percent: number): number {
  let hash = 2166136261;
  const seed = `${sourceId}:${new Date().toISOString().slice(0, 10)}`;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const unit = ((hash >>> 0) % 10_001) / 10_000;
  return Math.round(minutes * (1 + (unit * 2 - 1) * percent));
}

function baseline(source: SourceRecord): SourceCadenceRecord {
  const base = clamp(Math.round(source.schedule_minutes || 60), 15, 10_080);
  return {
    source_id: source.id,
    mode: "adaptive",
    base_minutes: base,
    min_minutes: Math.max(15, Math.round(base / 4)),
    max_minutes: Math.min(10_080, Math.max(base, Math.round(base * 8))),
    effective_minutes: base,
    next_run_at: null,
    yield_ema: 0,
    latency_ema_ms: 0,
    success_ema: 1,
    empty_streak: 0,
    failure_streak: 0,
    high_signal_streak: 0,
    last_reason: "baseline",
    updated_at: new Date().toISOString(),
  };
}

export async function observeSourceCadence(
  db: D1Database,
  source: SourceRecord,
  observation: CadenceObservation,
): Promise<SourceCadenceRecord | null> {
  if ((await getSetting(db, "adaptive_cadence_enabled")) === "0") return null;
  const current = await getSourceCadence(db, source.id) ?? baseline(source);
  if (current.mode === "fixed") return current;

  const success = ["success", "partial", "queued"].includes(observation.status) ? 1 : observation.status === "pending" ? 0.55 : 0;
  const yieldEma = ema(Number(current.yield_ema || 0), Math.max(0, observation.itemCount));
  const latencyEmaMs = ema(Number(current.latency_ema_ms || 0), Math.max(0, observation.latencyMs));
  const successEma = ema(Number(current.success_ema || 0.8), success);
  const emptyStreak = observation.itemCount === 0 && success > 0 ? current.empty_streak + 1 : 0;
  const failureStreak = observation.status === "failed" ? current.failure_streak + 1 : 0;
  const highSignal = (observation.meaningfulCount ?? observation.itemCount) >= Math.max(3, yieldEma * 1.5);
  const highSignalStreak = highSignal ? current.high_signal_streak + 1 : 0;

  let effective = Number(current.effective_minutes || current.base_minutes);
  let reason = "stable-yield";
  if (failureStreak > 0) {
    effective *= Math.min(4, 1.75 + failureStreak * 0.35);
    reason = "failure-backoff";
  } else if (emptyStreak >= 3) {
    effective *= emptyStreak >= 6 ? 2 : 1.45;
    reason = "low-yield-backoff";
  } else if (highSignalStreak > 0) {
    effective *= highSignalStreak >= 2 ? 0.58 : 0.74;
    reason = "high-signal-acceleration";
  } else {
    effective = effective * 0.72 + current.base_minutes * 0.28;
  }
  if (successEma < 0.45) {
    effective = Math.max(effective, current.base_minutes * 2);
    reason = "health-backoff";
  }
  effective = clamp(Math.round(effective), current.min_minutes, current.max_minutes);
  const jitterPercent = clamp(Number(await getSetting(db, "adaptive_cadence_jitter_percent") ?? 0.08), 0, 0.25);
  const jittered = clamp(deterministicJitter(source.id, effective, jitterPercent), current.min_minutes, current.max_minutes);
  const nextRunAt = new Date(Date.now() + jittered * 60_000).toISOString();

  const updated: SourceCadenceRecord = {
    ...current,
    base_minutes: clamp(Math.round(source.schedule_minutes || current.base_minutes), 15, 10_080),
    effective_minutes: effective,
    next_run_at: nextRunAt,
    yield_ema: yieldEma,
    latency_ema_ms: latencyEmaMs,
    success_ema: successEma,
    empty_streak: emptyStreak,
    failure_streak: failureStreak,
    high_signal_streak: highSignalStreak,
    last_reason: reason,
    updated_at: new Date().toISOString(),
  };
  await upsertSourceCadence(db, {
    sourceId: source.id,
    mode: updated.mode,
    baseMinutes: updated.base_minutes,
    minMinutes: updated.min_minutes,
    maxMinutes: updated.max_minutes,
    effectiveMinutes: updated.effective_minutes,
    nextRunAt: updated.next_run_at,
    yieldEma: updated.yield_ema,
    latencyEmaMs: updated.latency_ema_ms,
    successEma: updated.success_ema,
    emptyStreak: updated.empty_streak,
    failureStreak: updated.failure_streak,
    highSignalStreak: updated.high_signal_streak,
    lastReason: updated.last_reason,
  });
  return updated;
}
