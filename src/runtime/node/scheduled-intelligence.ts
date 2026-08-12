import { randomUUID } from "node:crypto";

import { generateBriefing } from "../../briefing";
import { latestBriefing } from "../../db";
import { refreshMissionReminders } from "../../mission-autopilot";
import type { Env } from "../../types";
import type { NodeSQLiteDatabase } from "./database";

const SCHEDULE_TABLE = "__driftglass_local_scheduled_intelligence";
const DAILY_CHECK_ID = "mission-aware-daily-check";
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_CHECK_INTERVAL_MS = 15 * 60_000;
const MAX_RESULT_BYTES = 16_000;

export interface LocalScheduledIntelligenceOptions {
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly checkIntervalMs?: number;
  readonly now?: () => Date;
  readonly logger?: (event: Readonly<Record<string, unknown>>) => void;
}

export interface ScheduledIntelligenceTickResult {
  readonly claimed: boolean;
  readonly reminders: number;
  readonly briefing: "generated" | "current" | "not-due" | "not-run";
  readonly briefingId?: string;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return candidate;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

function changes(result: { readonly meta?: { readonly changes?: number } } | undefined): number {
  return Math.max(0, Number(result?.meta?.changes ?? 0));
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function localClock(value: Date, timeZone: string): { dateKey: string; hour: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    dateKey: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour") || 0),
  };
}

function safeLocalClock(value: Date, timeZone: string): { dateKey: string; hour: number } {
  try {
    return localClock(value, timeZone || "UTC");
  } catch {
    return localClock(value, "UTC");
  }
}

/**
 * A complete first packet is useful immediately. Later packets follow the
 * owner's local briefing hour and coalesce any amount of downtime into one
 * current-day packet.
 */
export function scheduledBriefingIsDue(
  latestCreatedAt: string | null | undefined,
  now: Date,
  timeZone: string,
  localHour: number,
): boolean {
  if (!validDate(now)) throw new Error("Scheduled intelligence time is invalid");
  if (!latestCreatedAt) return true;
  const latestDate = new Date(latestCreatedAt);
  if (!validDate(latestDate)) return true;
  const current = safeLocalClock(now, timeZone);
  const latest = safeLocalClock(latestDate, timeZone);
  if (latest.dateKey >= current.dateKey) return false;
  const targetHour = Math.max(0, Math.min(23, Number.isFinite(localHour) ? Math.floor(localHour) : 7));
  return current.hour >= targetHour;
}

/**
 * Durable, bounded local delivery of Mission reminders and a complete daily
 * evidence packet. The authoritative Mission and briefing tables remain the
 * product surface; this table only owns a renewable execution lease.
 */
export class LocalScheduledIntelligence {
  readonly #database: NodeSQLiteDatabase;
  readonly #env: () => Env;
  readonly #pollMs: number;
  readonly #leaseMs: number;
  readonly #checkIntervalMs: number;
  readonly #now: () => Date;
  readonly #logger?: LocalScheduledIntelligenceOptions["logger"];
  #started = false;
  #stopping = false;
  #runningTick = false;
  #wake: (() => void) | null = null;
  #loop: Promise<void> | null = null;

  constructor(database: NodeSQLiteDatabase, env: () => Env, options: LocalScheduledIntelligenceOptions = {}) {
    this.#database = database;
    this.#env = env;
    this.#pollMs = boundedInteger(options.pollMs, DEFAULT_POLL_MS, 100, 5 * 60_000, "scheduled intelligence pollMs");
    this.#leaseMs = boundedInteger(options.leaseMs, DEFAULT_LEASE_MS, 5_000, 30 * 60_000, "scheduled intelligence leaseMs");
    this.#checkIntervalMs = boundedInteger(
      options.checkIntervalMs,
      DEFAULT_CHECK_INTERVAL_MS,
      60_000,
      24 * 60 * 60_000,
      "scheduled intelligence checkIntervalMs",
    );
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger;
  }

  async initialize(): Promise<void> {
    await this.#database.exec(`
      CREATE TABLE IF NOT EXISTS ${SCHEDULE_TABLE} (
        schedule_id TEXT PRIMARY KEY,
        next_run_at TEXT NOT NULL,
        lease_token TEXT,
        lease_expires_at TEXT,
        last_started_at TEXT,
        last_finished_at TEXT,
        last_result_json TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS __driftglass_local_scheduled_intelligence_due
        ON ${SCHEDULE_TABLE}(next_run_at, lease_expires_at);
    `);
    const now = this.currentTime().toISOString();
    await this.#database
      .prepare(
        `INSERT INTO ${SCHEDULE_TABLE}(schedule_id, next_run_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(schedule_id) DO NOTHING`,
      )
      .bind(DAILY_CHECK_ID, now, now)
      .run();
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    this.#loop = this.runLoop();
  }

  async close(): Promise<{ status: "clean"; inFlight: false }> {
    if (!this.#started) return { status: "clean", inFlight: false };
    this.#stopping = true;
    this.#wake?.();
    await this.#loop;
    this.#loop = null;
    this.#started = false;
    return { status: "clean", inFlight: false };
  }

  /** One lease-and-deliver cycle, exposed for restart acceptance checks. */
  async tick(): Promise<ScheduledIntelligenceTickResult> {
    if (this.#runningTick) return { claimed: false, reminders: 0, briefing: "not-run" };
    this.#runningTick = true;
    const token = randomUUID();
    try {
      const startedAt = this.currentTime();
      if (!(await this.claim(token, startedAt))) {
        return { claimed: false, reminders: 0, briefing: "not-run" };
      }

      let result: ScheduledIntelligenceTickResult = { claimed: true, reminders: 0, briefing: "not-run" };
      let tickError: unknown;
      const renewEveryMs = Math.max(1_000, Math.floor(this.#leaseMs / 3));
      const renewal = setInterval(() => {
        void this.renew(token).catch((error) => { tickError ??= error; });
      }, renewEveryMs);
      renewal.unref?.();
      try {
        result = await this.deliver(startedAt);
        if (tickError) throw tickError;
      } catch (error) {
        tickError ??= error;
      } finally {
        clearInterval(renewal);
      }

      await this.release(token, result, tickError);
      if (tickError) {
        this.#logger?.({ level: "error", event: "local_scheduled_intelligence_error", message: errorText(tickError) });
      } else {
        this.#logger?.({
          level: "info",
          event: "local_scheduled_intelligence",
          reminders: result.reminders,
          briefing: result.briefing,
          ...(result.briefingId ? { briefingId: result.briefingId } : {}),
        });
      }
      return result;
    } finally {
      this.#runningTick = false;
    }
  }

  private currentTime(): Date {
    const value = this.#now();
    if (!validDate(value)) throw new Error("Scheduled intelligence clock returned an invalid time");
    return value;
  }

  private async deliver(now: Date): Promise<ScheduledIntelligenceTickResult> {
    const env = this.#env();
    const reminders = await refreshMissionReminders(env, now);
    const latest = await latestBriefing(env.DB);
    if (!latest && !(await this.hasBriefingContext())) {
      // Do not freeze an empty onboarding packet as today's briefing. The
      // next bounded check will pick up the first Mission, source, or Story.
      return { claimed: true, reminders, briefing: "not-due" };
    }
    const localHour = Number(env.BRIEFING_LOCAL_HOUR ?? 7);
    const dailyPacketDue = scheduledBriefingIsDue(latest?.created_at, now, env.DEFAULT_TIMEZONE || "UTC", localHour);
    const missionContextChanged = latest ? await this.missionContextChanged(latest.created_at, latest.packet.missions.map((mission) => mission.id)) : false;
    if (!dailyPacketDue && !missionContextChanged) {
      return {
        claimed: true,
        reminders,
        briefing: latest && safeLocalClock(new Date(latest.created_at), env.DEFAULT_TIMEZONE || "UTC").dateKey
          === safeLocalClock(now, env.DEFAULT_TIMEZONE || "UTC").dateKey
          ? "current"
          : "not-due",
        ...(latest ? { briefingId: latest.id } : {}),
      };
    }
    const briefing = await generateBriefing(env, 24);
    return { claimed: true, reminders, briefing: "generated", briefingId: briefing.id };
  }

  private async hasBriefingContext(): Promise<boolean> {
    const row = await this.#database
      .prepare(
        `SELECT CASE WHEN
           EXISTS(SELECT 1 FROM missions WHERE status = 'active')
           OR EXISTS(SELECT 1 FROM sources WHERE enabled = 1)
           OR EXISTS(SELECT 1 FROM stories)
         THEN 1 ELSE 0 END AS ready`,
      )
      .first<{ ready: number }>();
    return Number(row?.ready ?? 0) === 1;
  }

  private async missionContextChanged(latestCreatedAt: string, packetMissionIds: readonly string[]): Promise<boolean> {
    const current = (await this.#database
      .prepare(
        `SELECT m.id,
                CASE WHEN julianday(m.updated_at) > julianday(?)
                       OR julianday(o.updated_at) > julianday(?)
                     THEN 1 ELSE 0 END AS changed
         FROM missions m
         LEFT JOIN mission_operators o ON o.mission_id = m.id
         WHERE m.status = 'active'
         ORDER BY m.priority DESC, m.updated_at DESC
         LIMIT 20`,
      )
      .bind(latestCreatedAt, latestCreatedAt)
      .all<{ id: string; changed: number }>()).results ?? [];
    if (current.length !== packetMissionIds.length) return true;
    const packetIds = new Set(packetMissionIds);
    return current.some((mission) => Number(mission.changed) === 1 || !packetIds.has(String(mission.id)));
  }

  private async runLoop(): Promise<void> {
    // A newly installed or overdue schedule runs before the first wait. Missed
    // intervals are intentionally coalesced into this one bounded check.
    while (!this.#stopping) {
      await this.tick().catch((error) => {
        this.#logger?.({ level: "error", event: "local_scheduled_intelligence_tick_failed", message: errorText(error) });
      });
      if (!this.#stopping) await this.wait();
    }
  }

  private async claim(token: string, now: Date): Promise<boolean> {
    const nowIso = now.toISOString();
    const result = await this.#database
      .prepare(
        `UPDATE ${SCHEDULE_TABLE}
         SET lease_token = ?, lease_expires_at = ?, last_started_at = ?, last_error = NULL, updated_at = ?
         WHERE schedule_id = ?
           AND datetime(next_run_at) <= datetime(?)
           AND (lease_token IS NULL OR lease_expires_at IS NULL OR datetime(lease_expires_at) <= datetime(?))`,
      )
      .bind(
        token,
        new Date(now.getTime() + this.#leaseMs).toISOString(),
        nowIso,
        nowIso,
        DAILY_CHECK_ID,
        nowIso,
        nowIso,
      )
      .run();
    return changes(result) === 1;
  }

  private async renew(token: string): Promise<void> {
    const now = this.currentTime();
    const result = await this.#database
      .prepare(
        `UPDATE ${SCHEDULE_TABLE} SET lease_expires_at = ?, updated_at = ?
         WHERE schedule_id = ? AND lease_token = ?`,
      )
      .bind(new Date(now.getTime() + this.#leaseMs).toISOString(), now.toISOString(), DAILY_CHECK_ID, token)
      .run();
    if (changes(result) !== 1) throw new Error("Local scheduled intelligence lost its lease");
  }

  private async release(token: string, result: ScheduledIntelligenceTickResult, error: unknown): Promise<void> {
    const now = this.currentTime();
    const retryMs = Math.max(5_000, Math.min(this.#checkIntervalMs, 5 * 60_000));
    const nextRunAt = new Date(now.getTime() + (error ? retryMs : this.#checkIntervalMs)).toISOString();
    const resultJson = JSON.stringify(result);
    const resultValue = Buffer.byteLength(resultJson) <= MAX_RESULT_BYTES ? resultJson : null;
    const nowIso = now.toISOString();
    const released = await this.#database
      .prepare(
        `UPDATE ${SCHEDULE_TABLE}
         SET lease_token = NULL, lease_expires_at = NULL, next_run_at = ?, last_finished_at = ?,
             last_result_json = ?, last_error = ?, updated_at = ?
         WHERE schedule_id = ? AND lease_token = ?`,
      )
      .bind(nextRunAt, nowIso, resultValue, error ? errorText(error) : null, nowIso, DAILY_CHECK_ID, token)
      .run();
    if (changes(released) !== 1) throw new Error("Local scheduled intelligence could not release its lease");
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#wake === finish) this.#wake = null;
        resolve();
      };
      const timer = setTimeout(finish, this.#pollMs);
      timer.unref?.();
      this.#wake = finish;
    });
  }
}
