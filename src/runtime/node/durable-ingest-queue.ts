import { createHash, randomUUID } from "node:crypto";

import { handleIngestQueueBatch } from "../../ingest-consumer";
import {
  INGEST_QUEUE_BATCH_MAX_BYTES,
  INGEST_QUEUE_BATCH_MAX_MESSAGES,
  INGEST_QUEUE_MESSAGE_MAX_BYTES,
  serializedIngestBatchBytes,
  serializedIngestMessageBytes,
} from "../../ingest-queue";
import type { Env, IngestMessage } from "../../types";
import type { NodeSQLiteDatabase } from "./database";

export type DurableIngestQueueLane = "primary" | "dead-letter" | "quarantine";

const QUEUE_TABLE = "__driftglass_local_ingest_queue";
const ACTIVE_CAPACITY_MESSAGES = 10_000;
const ACTIVE_CAPACITY_BYTES = 32_000_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_LEASE_MS = 30_000;

const LANE_MAX_ATTEMPTS: Readonly<Record<DurableIngestQueueLane, number>> = Object.freeze({
  // Cloudflare max_retries is retries after the first delivery.
  primary: 4,
  "dead-letter": 4,
  quarantine: 21,
});

const LANE_NAMES: Readonly<Record<DurableIngestQueueLane, string>> = Object.freeze({
  primary: "driftglass-local-ingest",
  "dead-letter": "driftglass-local-ingest-dlq",
  quarantine: "driftglass-local-ingest-quarantine",
});

interface DurableQueueRow {
  id: string;
  lane: DurableIngestQueueLane;
  body_json: string;
  body_bytes: number;
  body_sha256: string;
  attempts: number;
  max_attempts: number;
  lease_token: string;
}

interface DeliveryState {
  acknowledged: boolean;
  retryDelaySeconds: number | null;
}

export interface DurableIngestQueueRuntimeOptions {
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly logger?: (event: Readonly<Record<string, unknown>>) => void;
}

export interface DurableQueueCloseResult {
  readonly status: "clean";
  readonly inFlight: 0;
}

function isoAt(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function changes(result: { readonly meta?: { readonly changes?: number } } | undefined): number {
  return Math.max(0, Number(result?.meta?.changes ?? 0));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function validateDelaySeconds(value: number | undefined): number {
  const delay = value ?? 0;
  if (!Number.isFinite(delay) || delay < 0 || delay > 43_200) {
    throw new RangeError("Queue delaySeconds must be between 0 and 43200");
  }
  return Math.ceil(delay);
}

function validatedBody(body: IngestMessage): { bodyJson: string; bodyBytes: number; bodySha256: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("Durable ingest requires a message object");
  }
  const bodyJson = JSON.stringify(body);
  if (typeof bodyJson !== "string") throw new TypeError("Durable ingest requires a JSON-serializable message");
  const bodyBytes = serializedIngestMessageBytes(body);
  if (bodyBytes <= 0 || bodyBytes > INGEST_QUEUE_MESSAGE_MAX_BYTES) {
    throw new RangeError(`Durable ingest messages must be at most ${INGEST_QUEUE_MESSAGE_MAX_BYTES} bytes`);
  }
  return { bodyJson, bodyBytes, bodySha256: sha256(bodyJson) };
}

/** Producer-shaped binding backed by the runtime's single SQLite queue table. */
export class DurableIngestQueueBinding {
  readonly lane: DurableIngestQueueLane;
  readonly #runtime: DurableIngestQueueRuntime;

  constructor(runtime: DurableIngestQueueRuntime, lane: DurableIngestQueueLane) {
    this.#runtime = runtime;
    this.lane = lane;
  }

  async send(body: IngestMessage, options: { contentType?: string; delaySeconds?: number } = {}): Promise<Record<string, unknown>> {
    const result = await this.#runtime.enqueue(this.lane, [{ body, ...options }]);
    return { id: result.ids[0], created: true, metrics: await this.metrics() };
  }

  async sendBatch(
    messages: Array<{ body: IngestMessage; contentType?: string; delaySeconds?: number }>,
    options: { delaySeconds?: number } = {},
  ): Promise<Record<string, unknown>> {
    const normalized = messages.map((message) => ({
      ...message,
      delaySeconds: message.delaySeconds ?? options.delaySeconds,
    }));
    const result = await this.#runtime.enqueue(this.lane, normalized);
    return { id: result.ids[0], created: true, metrics: await this.metrics() };
  }

  metrics(): Promise<{ backlogCount: number; backlogBytes: number; oldestMessageTimestamp?: Date }> {
    return this.#runtime.metrics(this.lane);
  }
}

/**
 * One restart-safe, leased ingest worker for the local profile.
 *
 * Producer acknowledgement happens only after an atomic SQLite commit. A
 * killed worker leaves a leased row that becomes claimable after expiry. The
 * existing ingest consumer remains the only code that writes Story effects;
 * its deterministic ingest identity makes post-commit redelivery harmless.
 */
export class DurableIngestQueueRuntime {
  readonly #database: NodeSQLiteDatabase;
  readonly #env: () => Env;
  readonly #pollMs: number;
  readonly #leaseMs: number;
  readonly #logger?: DurableIngestQueueRuntimeOptions["logger"];
  readonly #bindings = new Map<DurableIngestQueueLane, DurableIngestQueueBinding>();
  #started = false;
  #stopping = false;
  #wake: (() => void) | null = null;
  #loop: Promise<void> | null = null;
  #inFlight = 0;

  constructor(database: NodeSQLiteDatabase, env: () => Env, options: DurableIngestQueueRuntimeOptions = {}) {
    this.#database = database;
    this.#env = env;
    this.#pollMs = boundedInteger(options.pollMs, DEFAULT_POLL_MS, 25, 60_000, "pollMs");
    this.#leaseMs = boundedInteger(options.leaseMs, DEFAULT_LEASE_MS, 1_000, 10 * 60_000, "leaseMs");
    this.#logger = options.logger;
  }

  binding(lane: DurableIngestQueueLane): DurableIngestQueueBinding {
    const existing = this.#bindings.get(lane);
    if (existing) return existing;
    const created = new DurableIngestQueueBinding(this, lane);
    this.#bindings.set(lane, created);
    return created;
  }

  async initialize(): Promise<void> {
    await this.#database.exec(`
      CREATE TABLE IF NOT EXISTS ${QUEUE_TABLE} (
        id TEXT PRIMARY KEY,
        lane TEXT NOT NULL CHECK(lane IN ('primary', 'dead-letter', 'quarantine')),
        body_json TEXT NOT NULL,
        body_bytes INTEGER NOT NULL CHECK(body_bytes > 0 AND body_bytes <= ${INGEST_QUEUE_MESSAGE_MAX_BYTES}),
        body_sha256 TEXT NOT NULL CHECK(length(body_sha256) = 64),
        status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'complete', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
        available_at TEXT NOT NULL,
        lease_token TEXT,
        lease_expires_at TEXT,
        handoff_key TEXT UNIQUE,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS __driftglass_local_ingest_queue_due
        ON ${QUEUE_TABLE}(lane, status, available_at, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS __driftglass_local_ingest_queue_terminal
        ON ${QUEUE_TABLE}(status, completed_at);
    `);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    this.#loop = this.runLoop();
  }

  async close(): Promise<DurableQueueCloseResult> {
    if (!this.#started) return { status: "clean", inFlight: 0 };
    this.#stopping = true;
    this.wake();
    await this.#loop;
    this.#started = false;
    this.#loop = null;
    return { status: "clean", inFlight: 0 };
  }

  async enqueue(
    lane: DurableIngestQueueLane,
    messages: readonly { body: IngestMessage; contentType?: string; delaySeconds?: number }[],
  ): Promise<{ ids: readonly string[] }> {
    if (messages.length === 0) return { ids: [] };
    if (messages.length > INGEST_QUEUE_BATCH_MAX_MESSAGES) {
      throw new RangeError(`Durable ingest batches may contain at most ${INGEST_QUEUE_BATCH_MAX_MESSAGES} messages`);
    }
    for (const message of messages) {
      if (message.contentType && message.contentType !== "json") {
        throw new TypeError("Durable ingest accepts only JSON messages");
      }
    }
    if (serializedIngestBatchBytes(messages.map((message) => message.body)) > INGEST_QUEUE_BATCH_MAX_BYTES) {
      throw new RangeError(`Durable ingest batches must be at most ${INGEST_QUEUE_BATCH_MAX_BYTES} bytes`);
    }
    const prepared = messages.map((message) => ({
      id: randomUUID(),
      ...validatedBody(message.body),
      delaySeconds: validateDelaySeconds(message.delaySeconds),
    }));
    const active = await this.#database
      .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(body_bytes), 0) AS bytes FROM ${QUEUE_TABLE} WHERE status IN ('pending', 'leased')`)
      .first<{ count: number; bytes: number }>();
    const additionalBytes = prepared.reduce((total, message) => total + message.bodyBytes, 0);
    if (
      Number(active?.count ?? 0) + prepared.length > ACTIVE_CAPACITY_MESSAGES
      || Number(active?.bytes ?? 0) + additionalBytes > ACTIVE_CAPACITY_BYTES
    ) throw new Error("Local ingest queue is at its bounded capacity");

    const now = Date.now();
    await this.#database.batch(prepared.map((message) => this.#database
      .prepare(
        `INSERT INTO ${QUEUE_TABLE}(
           id, lane, body_json, body_bytes, body_sha256, status, attempts, max_attempts,
           available_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      )
      .bind(
        message.id,
        lane,
        message.bodyJson,
        message.bodyBytes,
        message.bodySha256,
        LANE_MAX_ATTEMPTS[lane],
        isoAt(now + message.delaySeconds * 1_000),
        isoAt(now),
        isoAt(now),
      )));
    this.wake();
    return { ids: Object.freeze(prepared.map((message) => message.id)) };
  }

  async metrics(lane: DurableIngestQueueLane): Promise<{
    backlogCount: number;
    backlogBytes: number;
    oldestMessageTimestamp?: Date;
  }> {
    const row = await this.#database
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(body_bytes), 0) AS bytes, MIN(created_at) AS oldest
         FROM ${QUEUE_TABLE} WHERE lane = ? AND status IN ('pending', 'leased')`,
      )
      .bind(lane)
      .first<{ count: number; bytes: number; oldest: string | null }>();
    const timestamp = row?.oldest ? Date.parse(row.oldest) : Number.NaN;
    return {
      backlogCount: Math.max(0, Number(row?.count ?? 0)),
      backlogBytes: Math.max(0, Number(row?.bytes ?? 0)),
      ...(Number.isFinite(timestamp) ? { oldestMessageTimestamp: new Date(timestamp) } : {}),
    };
  }

  /** One deterministic delivery, exported as a functional validation seam. */
  async drainOnce(): Promise<boolean> {
    const leased = await this.leaseNext();
    if (!leased) return false;
    this.#inFlight += 1;
    try {
      await this.deliver(leased);
    } finally {
      this.#inFlight -= 1;
    }
    return true;
  }

  private async runLoop(): Promise<void> {
    while (!this.#stopping) {
      const delivered = await this.drainOnce().catch((error) => {
        this.#logger?.({ level: "error", event: "local_ingest_worker_error", message: errorText(error) });
        return false;
      });
      if (!delivered && !this.#stopping) await this.waitForWork();
    }
    while (this.#inFlight > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private async leaseNext(): Promise<DurableQueueRow | null> {
    const now = new Date();
    const row = await this.#database
      .prepare(
        `SELECT id, lane, body_json, body_bytes, body_sha256, attempts, max_attempts
         FROM ${QUEUE_TABLE}
         WHERE (
           (status = 'pending' AND datetime(available_at) <= datetime(?))
           OR (status = 'leased' AND datetime(lease_expires_at) <= datetime(?))
         )
         ORDER BY CASE lane WHEN 'quarantine' THEN 0 WHEN 'dead-letter' THEN 1 ELSE 2 END,
                  datetime(available_at), created_at
         LIMIT 1`,
      )
      .bind(now.toISOString(), now.toISOString())
      .first<Omit<DurableQueueRow, "lease_token">>();
    if (!row) return null;
    const leaseToken = randomUUID();
    const claimed = await this.#database
      .prepare(
        `UPDATE ${QUEUE_TABLE}
         SET status = 'leased', attempts = attempts + 1, lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND (
           (status = 'pending' AND datetime(available_at) <= datetime(?))
           OR (status = 'leased' AND datetime(lease_expires_at) <= datetime(?))
         )`,
      )
      .bind(
        leaseToken,
        isoAt(now.getTime() + this.#leaseMs),
        now.toISOString(),
        row.id,
        now.toISOString(),
        now.toISOString(),
      )
      .run();
    if (changes(claimed) !== 1) return null;
    return { ...row, attempts: Number(row.attempts) + 1, lease_token: leaseToken };
  }

  private async deliver(row: DurableQueueRow): Promise<void> {
    if (row.body_bytes !== Buffer.byteLength(row.body_json) || sha256(row.body_json) !== row.body_sha256) {
      await this.failWithoutHandoff(row, "Durable queue body failed its stored size or SHA-256 check");
      return;
    }
    let body: IngestMessage;
    try {
      body = JSON.parse(row.body_json) as IngestMessage;
    } catch (error) {
      await this.failWithoutHandoff(row, `Durable queue body is not valid JSON: ${errorText(error)}`);
      return;
    }

    const state: DeliveryState = { acknowledged: false, retryDelaySeconds: null };
    const message = {
      id: row.id,
      timestamp: new Date(),
      body,
      attempts: row.attempts,
      ack(): void {
        state.acknowledged = true;
        state.retryDelaySeconds = null;
      },
      retry(options?: { delaySeconds?: number }): void {
        if (!state.acknowledged) state.retryDelaySeconds = validateDelaySeconds(options?.delaySeconds);
      },
    };
    const batch = {
      queue: LANE_NAMES[row.lane],
      messages: [message],
      ackAll(): void { message.ack(); },
      retryAll(options?: { delaySeconds?: number }): void { message.retry(options); },
    };

    let renewalError: unknown;
    const renewEveryMs = Math.max(250, Math.floor(this.#leaseMs / 3));
    const renewTimer = setInterval(() => {
      void this.renew(row).catch((error) => { renewalError = error; });
    }, renewEveryMs);
    renewTimer.unref?.();
    let handlerError: unknown;
    try {
      await handleIngestQueueBatch(batch as unknown as MessageBatch<IngestMessage>, this.#env());
    } catch (error) {
      handlerError = error;
    } finally {
      clearInterval(renewTimer);
    }
    if (renewalError) {
      this.#logger?.({ level: "error", event: "local_ingest_lease_renewal_failed", queueMessageId: row.id, message: errorText(renewalError) });
      return;
    }
    if (state.acknowledged && !handlerError) {
      await this.ack(row);
      return;
    }
    await this.retryOrHandoff(row, handlerError ?? "Queue consumer requested retry", state.retryDelaySeconds ?? 0);
  }

  private async renew(row: DurableQueueRow): Promise<void> {
    const now = Date.now();
    const result = await this.#database
      .prepare(
        `UPDATE ${QUEUE_TABLE} SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      )
      .bind(isoAt(now + this.#leaseMs), isoAt(now), row.id, row.lease_token)
      .run();
    if (changes(result) !== 1) throw new Error("Local ingest lease was lost during renewal");
  }

  private async ack(row: DurableQueueRow): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.#database
      .prepare(
        `UPDATE ${QUEUE_TABLE}
         SET status = 'complete', lease_token = NULL, lease_expires_at = NULL,
             updated_at = ?, completed_at = ?
         WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      )
      .bind(now, now, row.id, row.lease_token)
      .run();
    if (changes(result) !== 1) throw new Error("Local ingest acknowledgement lost its lease");
    await this.gcCompleted(now);
  }

  private async retryOrHandoff(row: DurableQueueRow, error: unknown, requestedDelaySeconds: number): Promise<void> {
    if (row.attempts >= row.max_attempts) {
      const nextLane = row.lane === "primary" ? "dead-letter" : row.lane === "dead-letter" ? "quarantine" : null;
      if (nextLane) {
        const now = new Date().toISOString();
        const handoffKey = `${row.id}:${nextLane}`;
        const nextId = randomUUID();
        const results = await this.#database.batch([
          this.#database
            .prepare(
              `INSERT INTO ${QUEUE_TABLE}(
                 id, lane, body_json, body_bytes, body_sha256, status, attempts, max_attempts,
                 available_at, handoff_key, created_at, updated_at
               )
               SELECT ?, ?, body_json, body_bytes, body_sha256, 'pending', 0, ?, ?, ?, ?, ?
               FROM ${QUEUE_TABLE}
               WHERE id = ? AND status = 'leased' AND lease_token = ?
               ON CONFLICT(handoff_key) DO NOTHING`,
            )
            .bind(nextId, nextLane, LANE_MAX_ATTEMPTS[nextLane], now, handoffKey, now, now, row.id, row.lease_token),
          this.#database
            .prepare(
              `UPDATE ${QUEUE_TABLE}
               SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
                   last_error = ?, updated_at = ?, completed_at = ?
               WHERE id = ? AND status = 'leased' AND lease_token = ?`,
            )
            .bind(errorText(error), now, now, row.id, row.lease_token),
        ]);
        if (changes(results[1]) !== 1) throw new Error("Local ingest failure handoff lost its lease");
        this.wake();
        return;
      }
      await this.failWithoutHandoff(row, errorText(error));
      return;
    }

    const baseSeconds = Math.max(row.lane === "quarantine" ? 3_600 : 1, requestedDelaySeconds);
    const delaySeconds = Math.min(row.lane === "quarantine" ? 21_600 : 3_600, baseSeconds * (2 ** Math.min(8, row.attempts - 1)));
    const now = Date.now();
    const result = await this.#database
      .prepare(
        `UPDATE ${QUEUE_TABLE}
         SET status = 'pending', available_at = ?, lease_token = NULL, lease_expires_at = NULL,
             last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      )
      .bind(isoAt(now + delaySeconds * 1_000), errorText(error), isoAt(now), row.id, row.lease_token)
      .run();
    if (changes(result) !== 1) throw new Error("Local ingest retry lost its lease");
  }

  private async failWithoutHandoff(row: DurableQueueRow, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.#database
      .prepare(
        `UPDATE ${QUEUE_TABLE}
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             last_error = ?, updated_at = ?, completed_at = ?
         WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      )
      .bind(reason, now, now, row.id, row.lease_token)
      .run();
    if (changes(result) !== 1) throw new Error("Local ingest terminal failure lost its lease");
  }

  private async gcCompleted(nowIso: string): Promise<void> {
    const cutoff = isoAt(Date.parse(nowIso) - 24 * 60 * 60_000);
    await this.#database
      .prepare(
        `DELETE FROM ${QUEUE_TABLE} WHERE id IN (
           SELECT id FROM ${QUEUE_TABLE}
           WHERE status = 'complete' AND datetime(completed_at) < datetime(?)
           ORDER BY datetime(completed_at) LIMIT 100
         )`,
      )
      .bind(cutoff)
      .run();
  }

  private waitForWork(): Promise<void> {
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

  private wake(): void {
    this.#wake?.();
  }
}
