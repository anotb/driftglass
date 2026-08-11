import { randomUUID } from "node:crypto";

import { getBudgetProfile } from "../../budget";
import { dueSources } from "../../db";
import { scheduledSourceLimit } from "../../scheduled-envelope";
import { drainTrackedSourceOutbox } from "../../source-ingest-outbox";
import { runSource, sourceRuntimeAccess } from "../../sources/registry";
import type { Env } from "../../types";
import type { NodeSQLiteDatabase } from "./database";

const SCHEDULER_TABLE = "__driftglass_local_scheduler";
const SOURCE_SCHEDULE_ID = "source-collection";
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_LEASE_MS = 5 * 60_000;
const INTERRUPTED_COLLECTION_ERROR = "Local process stopped before source output became durable";

export interface LocalSourceSchedulerOptions {
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly logger?: (event: Readonly<Record<string, unknown>>) => void;
}

export interface LocalSourceSchedulerCloseResult {
  readonly status: "clean";
  readonly inFlight: false;
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

function orphanedCollectionPredicate(alias: string): string {
  return `${alias}.status = 'running'
    AND ${alias}.finished_at IS NULL
    AND ${alias}.collection_finished_at IS NULL
    AND ${alias}.terminal_accounted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM source_ingest_outbox_runs outbox WHERE outbox.run_id = ${alias}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM source_run_ingest_receipts receipt WHERE receipt.run_id = ${alias}.id
    )`;
}

function restartRecoveredPredicate(alias: string): string {
  return `json_valid(${alias}.details_json)
    AND json_extract(${alias}.details_json, '$.localRestartRecovery') = 1`;
}

/**
 * Retire only collection attempts that a killed local process could not have
 * made durable. The process lock guarantees there is no live local producer
 * while this startup transaction runs. A ready/staging outbox or any ingest
 * receipt remains canonical and is deliberately excluded.
 *
 * beginSourceRun advances sources.last_run_at before outbound collection. For
 * an orphan with no durable body, restore that scheduling cursor to the most
 * recent non-orphan attempt so the interrupted due source is eligible again.
 */
async function recoverInterruptedCollections(database: NodeSQLiteDatabase): Promise<number> {
  const now = new Date().toISOString();
  const orphan = orphanedCollectionPredicate("run");
  const priorOrphan = orphanedCollectionPredicate("prior");
  const priorInterrupted = restartRecoveredPredicate("prior");
  const results = await database.batch([
    database
      .prepare(
        `UPDATE sources AS source
         SET last_run_at = (
               SELECT MAX(prior.started_at)
               FROM source_runs prior
               WHERE prior.source_id = source.id
                 AND NOT (${priorOrphan})
                 AND NOT (${priorInterrupted})
             ),
             updated_at = ?
         WHERE source.kind NOT IN ('collector', 'manual', 'email')
           AND EXISTS (
             SELECT 1 FROM source_runs run
             WHERE run.source_id = source.id AND ${orphan}
           )`,
      )
      .bind(now),
    database
      .prepare(
        `UPDATE source_runs AS run
         SET finished_at = ?,
             collection_finished_at = ?,
             collection_partial = 1,
             collection_health_delta = 0,
             status = 'failed',
             item_count = 0,
             enqueued_count = 0,
             details_json = json_object(
               'localRestartRecovery', json('true'),
               'retryScheduled', json('true'),
               'interruptedAt', ?
             ),
             ingest_updated_at = ?,
             last_ingest_error = ?,
             terminal_accounted_at = ?
         WHERE ${orphan}
           AND EXISTS (
             SELECT 1 FROM sources source
             WHERE source.id = run.source_id
               AND source.kind NOT IN ('collector', 'manual', 'email')
           )
         RETURNING id`,
      )
      .bind(now, now, now, now, INTERRUPTED_COLLECTION_ERROR, now),
  ]);
  return results[1]?.results?.length ?? 0;
}

/**
 * Bounded source-only scheduler for the experimental local profile.
 *
 * Existing source cadence rows remain authoritative. This adapter adds one
 * renewable SQLite lease around the due-source scan, so ticks never overlap
 * and a killed process becomes eligible to continue after lease expiry. It
 * intentionally does not claim local Workflow parity.
 */
export class LocalSourceScheduler {
  readonly #database: NodeSQLiteDatabase;
  readonly #env: () => Env;
  readonly #pollMs: number;
  readonly #leaseMs: number;
  readonly #logger?: LocalSourceSchedulerOptions["logger"];
  #started = false;
  #stopping = false;
  #runningTick = false;
  #wake: (() => void) | null = null;
  #loop: Promise<void> | null = null;

  constructor(database: NodeSQLiteDatabase, env: () => Env, options: LocalSourceSchedulerOptions = {}) {
    this.#database = database;
    this.#env = env;
    this.#pollMs = boundedInteger(options.pollMs, DEFAULT_POLL_MS, 100, 5 * 60_000, "scheduler pollMs");
    this.#leaseMs = boundedInteger(options.leaseMs, DEFAULT_LEASE_MS, 5_000, 30 * 60_000, "scheduler leaseMs");
    this.#logger = options.logger;
  }

  async initialize(): Promise<void> {
    await this.#database.exec(`
      CREATE TABLE IF NOT EXISTS ${SCHEDULER_TABLE} (
        schedule_id TEXT PRIMARY KEY,
        lease_token TEXT,
        lease_expires_at TEXT,
        last_started_at TEXT,
        last_finished_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    await this.#database
      .prepare(
        `INSERT INTO ${SCHEDULER_TABLE}(schedule_id, updated_at) VALUES (?, ?)
         ON CONFLICT(schedule_id) DO NOTHING`,
      )
      .bind(SOURCE_SCHEDULE_ID, now)
      .run();
    // The outer self-host process lock proves a predecessor cannot still own
    // this SQLite lease. Clear a hard-killed tick immediately instead of
    // waiting one lease plus a full scheduler poll before retrying its source.
    const recoveredLease = await this.#database
      .prepare(
        `UPDATE ${SCHEDULER_TABLE}
         SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE schedule_id = ? AND lease_token IS NOT NULL`,
      )
      .bind(now, SOURCE_SCHEDULE_ID)
      .run();
    const recoveredRuns = await recoverInterruptedCollections(this.#database);
    if (changes(recoveredLease) > 0) {
      this.#logger?.({
        level: "warn",
        event: "local_source_scheduler_lease_recovery",
        action: "interrupted scheduler lease cleared for immediate retry",
      });
    }
    if (recoveredRuns > 0) {
      this.#logger?.({
        level: "warn",
        event: "local_source_restart_recovery",
        recoveredRuns,
        action: "interrupted collections retired and sources returned to due cadence",
      });
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    this.#loop = this.runLoop();
  }

  async close(): Promise<LocalSourceSchedulerCloseResult> {
    if (!this.#started) return { status: "clean", inFlight: false };
    this.#stopping = true;
    this.#wake?.();
    await this.#loop;
    this.#loop = null;
    this.#started = false;
    return { status: "clean", inFlight: false };
  }

  /** One claim-and-run cycle, exposed for deterministic acceptance tests. */
  async tick(): Promise<{ claimed: boolean; attempted: number; completed: number }> {
    if (this.#runningTick) return { claimed: false, attempted: 0, completed: 0 };
    this.#runningTick = true;
    const token = randomUUID();
    try {
      if (!(await this.claim(token))) return { claimed: false, attempted: 0, completed: 0 };
      let attempted = 0;
      let completed = 0;
      let tickError: unknown;
      const renewEveryMs = Math.max(1_000, Math.floor(this.#leaseMs / 3));
      const renewal = setInterval(() => {
        void this.renew(token).catch((error) => { tickError = error; });
      }, renewEveryMs);
      renewal.unref?.();
      try {
        const env = this.#env();
        const { executionCapacity } = await getBudgetProfile(env.DB);
        const limit = scheduledSourceLimit(executionCapacity);
        const sources = (await dueSources(env.DB, new Date().toISOString(), {
          limit,
          deferOpenAlex: !env.OPENALEX_API_KEY?.trim(),
        })).filter((source) => sourceRuntimeAccess(source, env).runnable).slice(0, limit);
        if (sources.length === 0) {
          await drainTrackedSourceOutbox(env, { maxBatches: 1 });
        } else {
          await drainTrackedSourceOutbox(env, { maxBatches: 1 });
          // Keep one local source run in flight. The Queue itself drains
          // independently and the next tick catches any cadence that remains due.
          for (const source of sources) {
            if (tickError) throw tickError;
            attempted += 1;
            await runSource(source, env, { resumeOutbox: false });
            completed += 1;
          }
        }
      } catch (error) {
        tickError ??= error;
      } finally {
        clearInterval(renewal);
      }
      await this.release(token, tickError);
      if (tickError) {
        this.#logger?.({ level: "error", event: "local_source_scheduler_error", message: errorText(tickError) });
      }
      return { claimed: true, attempted, completed };
    } finally {
      this.#runningTick = false;
    }
  }

  private async runLoop(): Promise<void> {
    // Start with a bounded recovery tick so restart catches work immediately.
    while (!this.#stopping) {
      await this.tick().catch((error) => {
        this.#logger?.({ level: "error", event: "local_source_scheduler_tick_failed", message: errorText(error) });
      });
      if (!this.#stopping) await this.wait();
    }
  }

  private async claim(token: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.#database
      .prepare(
        `UPDATE ${SCHEDULER_TABLE}
         SET lease_token = ?, lease_expires_at = ?, last_started_at = ?, last_error = NULL, updated_at = ?
         WHERE schedule_id = ? AND (
           lease_token IS NULL OR lease_expires_at IS NULL OR datetime(lease_expires_at) <= datetime(?)
         )`,
      )
      .bind(
        token,
        new Date(now + this.#leaseMs).toISOString(),
        new Date(now).toISOString(),
        new Date(now).toISOString(),
        SOURCE_SCHEDULE_ID,
        new Date(now).toISOString(),
      )
      .run();
    return changes(result) === 1;
  }

  private async renew(token: string): Promise<void> {
    const now = Date.now();
    const result = await this.#database
      .prepare(
        `UPDATE ${SCHEDULER_TABLE} SET lease_expires_at = ?, updated_at = ?
         WHERE schedule_id = ? AND lease_token = ?`,
      )
      .bind(new Date(now + this.#leaseMs).toISOString(), new Date(now).toISOString(), SOURCE_SCHEDULE_ID, token)
      .run();
    if (changes(result) !== 1) throw new Error("Local source scheduler lost its lease");
  }

  private async release(token: string, error: unknown): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.#database
      .prepare(
        `UPDATE ${SCHEDULER_TABLE}
         SET lease_token = NULL, lease_expires_at = NULL, last_finished_at = ?,
             last_error = ?, updated_at = ?
         WHERE schedule_id = ? AND lease_token = ?`,
      )
      .bind(now, error ? errorText(error) : null, now, SOURCE_SCHEDULE_ID, token)
      .run();
    if (changes(result) !== 1) throw new Error("Local source scheduler could not release its lease");
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
