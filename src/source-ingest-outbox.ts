import { requireBudget } from "./budget";
import {
  cleanupPreparedIngestEntries,
  INGEST_QUEUE_BATCH_MAX_BYTES,
  INGEST_QUEUE_BATCH_MAX_MESSAGES,
  INGEST_QUEUE_MESSAGE_MAX_BYTES,
  prepareQueueSafeIngestMessage,
  prepareIngestEntries,
  serializedIngestBatchBytes,
  serializedIngestMessageBytes,
  utf8ByteLength,
  type PreparedIngestEntry,
} from "./ingest-queue";
import { requireIngestQueueDurability } from "./queue-health";
import { sha256 } from "./security";
import type { Env, IngestMessage, IngestMessageInput } from "./types";
import { HttpError, isoNow, safeFilename } from "./utils";

// D1 Free databases are 500 MB. This bounded working set leaves most of that
// space for Driftglass's canonical index even if every staged body is near its
// Queue-safe ceiling.
export const SOURCE_OUTBOX_MAX_ACTIVE_BYTES = 32_000_000;
export const SOURCE_OUTBOX_MAX_RUN_BYTES = 4_000_000;
export const SOURCE_OUTBOX_MAX_ACTIVE_MESSAGES = 10_000;
export const SOURCE_OUTBOX_MAX_RUN_MESSAGES = 800;
export const SOURCE_OUTBOX_STAGE_BIND_MAX_BYTES = 1_500_000;
export const SOURCE_OUTBOX_MAX_STAGE_CHUNKS = 6;
export const SOURCE_OUTBOX_MAX_RAW_MESSAGES = 20;
export const SOURCE_OUTBOX_STAGING_TTL_MS = 15 * 60_000;
export const SOURCE_OUTBOX_LEASE_MS = 60_000;
export const SOURCE_OUTBOX_DEFAULT_MAX_BATCHES = 6;

interface SourceOutboxRun {
  run_id: string;
  source_id: string;
  message_count: number;
  total_bytes: number;
  payload_sha256: string;
  next_index: number;
  lease_token: string | null;
  lease_expires_at: string | null;
}

interface SourceOutboxMessageRow {
  item_index: number;
  message_json: string;
  message_bytes: number;
  body_sha256: string;
  raw_r2_key: string | null;
  receipt_outcome: string | null;
}

interface StagedPayloadRow {
  itemIndex: number;
  messageJson: string;
  messageBytes: number;
  bodySha256: string;
  rawR2Key: string | null;
}

export interface TrackedSourceOutboxActivation {
  runId: string;
  sourceId: string;
  collectionPartial: boolean;
  collectionHealthDelta: number;
  latencyMs: number;
  provider: string;
  details?: Record<string, unknown>;
}

export interface SourceOutboxDrainOptions {
  preferredRunId?: string;
  /** Restrict producer-entry recovery to the source the caller asked to run. */
  sourceId?: string;
  maxBatches?: number;
  now?: Date;
  /** Internal fast path immediately after this invocation activated a run. */
  skipMaintenance?: boolean;
  /** Producer entry reconciles one complete activation-loss staging run. */
  resumeStaging?: boolean;
  /** Internal fast path; immutable rows were just verified during activation. */
  preverifiedRunId?: string;
}

export interface SourceOutboxDrainResult {
  claimed: boolean;
  runId?: string;
  sentCount: number;
  receiptCount: number;
  batchCount: number;
  completed: boolean;
  ambiguous: boolean;
  error?: string;
}

export interface EnqueueTrackedSourceRunResult {
  messageCount: number;
  totalBytes: number;
  drain: SourceOutboxDrainResult;
}

export interface SourceOutboxHealth {
  /** Staging or ready runs that still need an actionable Queue handoff. */
  activeRuns: number;
  stagingRuns: number;
  readyRuns: number;
  /** Fully handed-off runs whose exact bodies await terminal receipt accounting. */
  awaitingReceiptRuns: number;
  awaitingReceiptMessages: number;
  /** Every staging/ready row still consuming the bounded D1 outbox envelope. */
  retainedRuns: number;
  retainedMessages: number;
  retainedBytes: number;
  /** Terminal-accounted rows eligible for the next bounded maintenance delete. */
  terminalGcRuns: number;
  abandonedRuns: number;
  /** Messages not yet included in a confirmed Queue handoff checkpoint. */
  messageCount: number;
  /** Compatibility alias for retainedBytes, the capacity-governing byte total. */
  activeBytes: number;
  oldestActiveAt: string | null;
}

export interface SourceOutboxPrefixFit {
  acceptedCount: number;
  deferredCount: number;
  messageBytes: number;
  stagingChunks: number;
  rawMessages: number;
}

export class SourceOutboxActivationUnknownError extends Error {
  constructor(public readonly runId: string, cause?: unknown) {
    super("The tracked source outbox activation result is unknown; its durable state will be reconciled", cause === undefined ? undefined : { cause });
    this.name = "SourceOutboxActivationUnknownError";
  }
}

export function isSourceOutboxBackpressure(error: unknown): boolean {
  if (!(error instanceof HttpError) || !error.details || typeof error.details !== "object") return false;
  return String((error.details as Record<string, unknown>).code ?? "") === "INGEST_OUTBOX_CAPACITY";
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function resultChanges(result: D1Result<unknown> | undefined): number {
  return Math.max(0, Number(result?.meta?.changes ?? 0));
}

function safeDetailsJson(details: Record<string, unknown> | undefined): string {
  const serialized = JSON.stringify(details ?? {});
  if (utf8ByteLength(serialized) > 250_000) {
    throw new Error("Tracked source run details exceed the durable outbox bound");
  }
  return serialized;
}

function validateTrackedPublicInputs(
  activation: TrackedSourceOutboxActivation,
  inputs: readonly IngestMessageInput[],
): void {
  if (inputs.length === 0) throw new Error("Tracked source outbox requires at least one message");
  if (inputs.length > SOURCE_OUTBOX_MAX_RUN_MESSAGES) {
    throw new HttpError(503, "Tracked source output exceeds the bounded producer outbox", {
      code: "INGEST_OUTBOX_CAPACITY",
      requestedMessages: inputs.length,
      maximumMessagesPerRun: SOURCE_OUTBOX_MAX_RUN_MESSAGES,
    });
  }
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index]!;
    if (
      input.sourceId !== activation.sourceId
      || input.sourceRunId !== activation.runId
      || input.sourceRunItemIndex !== index
    ) {
      throw new Error("Tracked source outbox inputs must use one run with exact contiguous indices");
    }
    if ((input.item.accessClass ?? "public") !== "public" || input.emailReceiptClaim) {
      throw new Error("The tracked source outbox accepts built-in public source messages only");
    }
  }
  const rawMessages = inputs.filter((input) => typeof input.item.raw === "string" && input.item.raw.length > 0).length;
  if (rawMessages > SOURCE_OUTBOX_MAX_RAW_MESSAGES) {
    throw new HttpError(503, "Tracked source output exceeds the bounded raw-capture lane", {
      code: "INGEST_OUTBOX_CAPACITY",
      requestedRawMessages: rawMessages,
      maximumRawMessagesPerRun: SOURCE_OUTBOX_MAX_RAW_MESSAGES,
      action: "Split the source run; Page Feed enrichment is bounded to 20 raw-bearing articles.",
    });
  }
}

/**
 * Pure pre-fit used before R2 writes or Queue-budget reservation. Placeholder
 * raw keys have the exact managed-key length, so body and set-based staging
 * byte estimates match the later random keys without exposing or writing raw.
 */
export function fitTrackedSourceOutboxPrefix(inputs: readonly IngestMessageInput[]): SourceOutboxPrefixFit {
  let acceptedCount = 0;
  let messageBytes = 0;
  let stagingChunks = 0;
  let currentChunkBytes = 2;
  let rawMessages = 0;
  for (let index = 0; index < Math.min(inputs.length, SOURCE_OUTBOX_MAX_RUN_MESSAGES); index += 1) {
    const input = inputs[index]!;
    const hasPublicRaw = (input.item.accessClass ?? "public") === "public"
      && typeof input.item.raw === "string"
      && input.item.raw.length > 0;
    if (hasPublicRaw && rawMessages >= SOURCE_OUTBOX_MAX_RAW_MESSAGES) break;
    const rawKey = hasPublicRaw
      ? `raw/2000-01-01/${safeFilename(input.sourceId) || "source"}/00000000-0000-4000-8000-000000000000.txt`
      : undefined;
    const message = prepareQueueSafeIngestMessage(input, rawKey);
    const nextMessageBytes = serializedIngestMessageBytes(message);
    if (messageBytes + nextMessageBytes > SOURCE_OUTBOX_MAX_RUN_BYTES) break;
    const stagingRowBytes = utf8ByteLength(JSON.stringify({
      itemIndex: index,
      messageJson: JSON.stringify(message),
      messageBytes: nextMessageBytes,
      bodySha256: "0".repeat(64),
      rawR2Key: rawKey ?? null,
    }));
    let nextChunkBytes = currentChunkBytes + (currentChunkBytes > 2 ? 1 : 0) + stagingRowBytes;
    let nextChunks = stagingChunks === 0 ? 1 : stagingChunks;
    if (currentChunkBytes > 2 && nextChunkBytes > SOURCE_OUTBOX_STAGE_BIND_MAX_BYTES) {
      nextChunks = stagingChunks + 1;
      nextChunkBytes = 2 + stagingRowBytes;
    }
    if (nextChunkBytes > SOURCE_OUTBOX_STAGE_BIND_MAX_BYTES || nextChunks > SOURCE_OUTBOX_MAX_STAGE_CHUNKS) break;
    stagingChunks = nextChunks;
    currentChunkBytes = nextChunkBytes;
    messageBytes += nextMessageBytes;
    rawMessages += hasPublicRaw ? 1 : 0;
    acceptedCount += 1;
  }
  return {
    acceptedCount,
    deferredCount: Math.max(0, inputs.length - acceptedCount),
    messageBytes,
    stagingChunks,
    rawMessages,
  };
}

async function stagedPayload(entries: readonly PreparedIngestEntry[]): Promise<StagedPayloadRow[]> {
  const rows: StagedPayloadRow[] = [];
  // Bound digest fan-out so the adapter maximum does not become either 800
  // serial awaits or one unbounded Promise.all burst.
  for (let offset = 0; offset < entries.length; offset += 32) {
    rows.push(...await Promise.all(entries.slice(offset, offset + 32).map(async (entry, relativeIndex) => {
      const itemIndex = offset + relativeIndex;
      const messageJson = JSON.stringify(entry.message);
      return {
        itemIndex,
        messageJson,
        messageBytes: serializedIngestMessageBytes(entry.message),
        bodySha256: await sha256(messageJson),
        rawR2Key: entry.rawR2Key ?? null,
      };
    })));
  }
  return rows;
}

async function bodySetSha256(rows: readonly Pick<StagedPayloadRow, "itemIndex" | "messageBytes" | "bodySha256">[]): Promise<string> {
  return sha256(rows.map((row) => `${row.itemIndex}:${row.messageBytes}:${row.bodySha256}`).join("\n"));
}

function payloadChunks(rows: readonly StagedPayloadRow[]): StagedPayloadRow[][] {
  const chunks: StagedPayloadRow[][] = [];
  let chunk: StagedPayloadRow[] = [];
  let chunkBytes = 2; // JSON array brackets
  for (const row of rows) {
    const rowBytes = utf8ByteLength(JSON.stringify(row));
    const candidateBytes = chunkBytes + (chunk.length > 0 ? 1 : 0) + rowBytes;
    if (chunk.length > 0 && candidateBytes > SOURCE_OUTBOX_STAGE_BIND_MAX_BYTES) {
      chunks.push(chunk);
      chunk = [row];
      chunkBytes = 2 + rowBytes;
    } else {
      chunk.push(row);
      chunkBytes = candidateBytes;
    }
    if (chunkBytes > SOURCE_OUTBOX_STAGE_BIND_MAX_BYTES) {
      throw new Error("One tracked source outbox staging bind exceeds its bound");
    }
  }
  if (chunk.length > 0) chunks.push(chunk);
  if (chunks.length > SOURCE_OUTBOX_MAX_STAGE_CHUNKS) {
    throw new HttpError(503, "Tracked source output exceeds the bounded D1 staging-query envelope", {
      code: "INGEST_OUTBOX_CAPACITY",
      stagingChunks: chunks.length,
      maximumStagingChunks: SOURCE_OUTBOX_MAX_STAGE_CHUNKS,
    });
  }
  return chunks;
}

async function insertOutboxHeader(
  db: D1Database,
  activation: TrackedSourceOutboxActivation,
  messageCount: number,
  totalBytes: number,
  payloadSha256: string,
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO source_ingest_outbox_runs(
         run_id, source_id, state, message_count, total_bytes, payload_sha256, next_index,
         collection_partial, collection_health_delta, latency_ms, provider,
         details_json, created_at, updated_at
       )
       SELECT ?, ?, 'staging', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?
       WHERE ? <= ? AND ? <= ?
         AND COALESCE((
           SELECT SUM(total_bytes) FROM source_ingest_outbox_runs
           WHERE state IN ('staging', 'ready')
         ), 0) + ? <= ?
         AND COALESCE((
           SELECT SUM(message_count) FROM source_ingest_outbox_runs
           WHERE state IN ('staging', 'ready')
         ), 0) + ? <= ?`,
    )
    .bind(
      activation.runId,
      activation.sourceId,
      messageCount,
      totalBytes,
      payloadSha256,
      activation.collectionPartial ? 1 : 0,
      Math.max(-0.2, Math.min(0.08, Number(activation.collectionHealthDelta) || 0)),
      Math.max(0, Math.floor(activation.latencyMs)),
      activation.provider.slice(0, 500),
      safeDetailsJson(activation.details),
      now,
      now,
      totalBytes,
      SOURCE_OUTBOX_MAX_RUN_BYTES,
      messageCount,
      SOURCE_OUTBOX_MAX_RUN_MESSAGES,
      totalBytes,
      SOURCE_OUTBOX_MAX_ACTIVE_BYTES,
      messageCount,
      SOURCE_OUTBOX_MAX_ACTIVE_MESSAGES,
    )
    .run();
  return resultChanges(result) === 1;
}

async function insertMessageChunk(
  db: D1Database,
  runId: string,
  chunk: readonly StagedPayloadRow[],
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_ingest_outbox_messages(
         run_id, item_index, message_json, message_bytes, body_sha256, raw_r2_key, created_at
       )
       SELECT ?,
              CAST(json_extract(value, '$.itemIndex') AS INTEGER),
              json_extract(value, '$.messageJson'),
              CAST(json_extract(value, '$.messageBytes') AS INTEGER),
              json_extract(value, '$.bodySha256'),
              json_extract(value, '$.rawR2Key'),
              ?
       FROM json_each(?)`,
    )
    .bind(runId, now, JSON.stringify(chunk))
    .run();
}

async function verifyOutboxBodySet(db: D1Database, runId: string): Promise<boolean> {
  const [header, messages] = await Promise.all([
    db
      .prepare(
        `SELECT message_count, total_bytes, payload_sha256
         FROM source_ingest_outbox_runs WHERE run_id = ?`,
      )
      .bind(runId)
      .first<{ message_count: number; total_bytes: number; payload_sha256: string }>(),
    db
      .prepare(
        `SELECT item_index, message_bytes, body_sha256
         FROM source_ingest_outbox_messages
         WHERE run_id = ? ORDER BY item_index`,
      )
      .bind(runId)
      .all<{ item_index: number; message_bytes: number; body_sha256: string }>(),
  ]);
  if (!header) return false;
  const rows = messages.results ?? [];
  if (
    rows.length !== Number(header.message_count)
    || rows.length === 0
    || rows.some((row, index) => (
      Number(row.item_index) !== index
      || !Number.isSafeInteger(Number(row.message_bytes))
      || Number(row.message_bytes) <= 0
      || Number(row.message_bytes) > INGEST_QUEUE_MESSAGE_MAX_BYTES
      || !/^[0-9a-f]{64}$/.test(row.body_sha256)
    ))
    || rows.reduce((sum, row) => sum + Number(row.message_bytes), 0) !== Number(header.total_bytes)
  ) return false;
  const digest = await bodySetSha256(rows.map((row) => ({
    itemIndex: Number(row.item_index),
    messageBytes: Number(row.message_bytes),
    bodySha256: row.body_sha256,
  })));
  return digest === header.payload_sha256;
}

async function activateOutboxRun(db: D1Database, runId: string, now: string): Promise<boolean> {
  if (!(await verifyOutboxBodySet(db, runId))) return false;
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE source_ingest_outbox_runs
           SET state = 'ready', activated_at = COALESCE(activated_at, ?), updated_at = ?
           WHERE run_id = ? AND state = 'staging'
             AND EXISTS (
               SELECT 1 FROM source_runs
               WHERE id = source_ingest_outbox_runs.run_id
                 AND source_id = source_ingest_outbox_runs.source_id
                 AND status IN ('running', 'queued')
                 AND terminal_accounted_at IS NULL
             )
             AND (SELECT COUNT(*) FROM source_ingest_outbox_messages WHERE run_id = ?) = message_count
             AND (SELECT MIN(item_index) FROM source_ingest_outbox_messages WHERE run_id = ?) = 0
             AND (SELECT MAX(item_index) FROM source_ingest_outbox_messages WHERE run_id = ?) = message_count - 1
             AND (SELECT SUM(message_bytes) FROM source_ingest_outbox_messages WHERE run_id = ?) = total_bytes
             AND (SELECT SUM(total_bytes) FROM source_ingest_outbox_runs WHERE state IN ('staging', 'ready')) <= ?`,
        )
        .bind(now, now, runId, runId, runId, runId, runId, SOURCE_OUTBOX_MAX_ACTIVE_BYTES),
      db
        .prepare(
          `UPDATE source_runs
           SET finished_at = NULL,
               collection_finished_at = ?,
               collection_partial = (SELECT collection_partial FROM source_ingest_outbox_runs WHERE run_id = ?),
               collection_health_delta = (SELECT collection_health_delta FROM source_ingest_outbox_runs WHERE run_id = ?),
               status = 'queued',
               item_count = (SELECT message_count FROM source_ingest_outbox_runs WHERE run_id = ?),
               enqueued_count = (SELECT message_count FROM source_ingest_outbox_runs WHERE run_id = ?),
               latency_ms = (SELECT latency_ms FROM source_ingest_outbox_runs WHERE run_id = ?),
               provider = COALESCE((SELECT provider FROM source_ingest_outbox_runs WHERE run_id = ?), provider),
               details_json = (SELECT details_json FROM source_ingest_outbox_runs WHERE run_id = ?),
               ingest_updated_at = ?,
               last_ingest_error = NULL
           WHERE id = ? AND status IN ('running', 'queued')
             AND terminal_accounted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM source_ingest_outbox_runs
               WHERE run_id = ? AND state = 'ready'
             )`,
        )
        .bind(now, runId, runId, runId, runId, runId, runId, runId, now, runId, runId),
    ]);
  } catch (error) {
    throw new SourceOutboxActivationUnknownError(runId, error);
  }
  const ready = await db
    .prepare(
      `SELECT 1 AS ready FROM source_ingest_outbox_runs o
       JOIN source_runs r ON r.id = o.run_id
       WHERE o.run_id = ? AND o.state = 'ready' AND r.status = 'queued'
         AND r.enqueued_count = o.message_count`,
    )
    .bind(runId)
    .first<{ ready: number }>();
  return ready?.ready === 1;
}

async function discardUnactivatedStaging(
  env: Env,
  runId: string,
  entries: readonly PreparedIngestEntry[],
  reason: string,
): Promise<boolean> {
  const result = await env.DB
    .prepare("DELETE FROM source_ingest_outbox_runs WHERE run_id = ? AND state = 'staging'")
    .bind(runId)
    .run();
  if (resultChanges(result) === 0) return false;
  await cleanupPreparedIngestEntries(env, entries, reason);
  return true;
}

async function resumeCompleteStaging(
  db: D1Database,
  now: string,
  limit = 2,
  sourceId?: string,
): Promise<void> {
  const result = await db
    .prepare(
      `SELECT run_id FROM source_ingest_outbox_runs o
       WHERE state = 'staging'
         AND (? IS NULL OR source_id = ?)
         AND (SELECT COUNT(*) FROM source_ingest_outbox_messages WHERE run_id = o.run_id) = message_count
         AND (SELECT MIN(item_index) FROM source_ingest_outbox_messages WHERE run_id = o.run_id) = 0
         AND (SELECT MAX(item_index) FROM source_ingest_outbox_messages WHERE run_id = o.run_id) = message_count - 1
         AND (SELECT SUM(message_bytes) FROM source_ingest_outbox_messages WHERE run_id = o.run_id) = total_bytes
       ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(sourceId ?? null, sourceId ?? null, Math.max(1, Math.min(4, limit)))
    .all<{ run_id: string }>();
  for (const row of result.results ?? []) await activateOutboxRun(db, row.run_id, now);
}

/**
 * Exact accepted bodies remain available until the source-run receipt ledger
 * has reached and accounted its terminal state. Each normal producer entry or
 * maintenance pass may retire one run with a single statement, bounding the
 * cascade to at most 800 immutable message rows / 4 MB.
 */
export async function deleteOneTerminalTrackedSourceOutboxRun(db: D1Database): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM source_ingest_outbox_runs
       WHERE run_id = (
         SELECT o.run_id
         FROM source_ingest_outbox_runs o
         JOIN source_runs r ON r.id = o.run_id
         WHERE o.state = 'ready' AND r.terminal_accounted_at IS NOT NULL
         ORDER BY r.terminal_accounted_at ASC, o.created_at ASC
         LIMIT 1
       )`,
    )
    .run();
  return resultChanges(result) > 0;
}

/**
 * Receipt-bound cleanup for one known producer run. The source binding and
 * terminal-accounting guard make a stale or forged Queue body a no-op.
 */
export async function deleteTerminalTrackedSourceOutboxRun(
  db: D1Database,
  runId: string,
  sourceId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM source_ingest_outbox_runs
       WHERE run_id = ? AND source_id = ? AND state = 'ready'
         AND EXISTS (
           SELECT 1 FROM source_runs r
           WHERE r.id = source_ingest_outbox_runs.run_id
             AND r.source_id = ?
             AND r.terminal_accounted_at IS NOT NULL
         )`,
    )
    .bind(runId, sourceId, sourceId)
    .run();
  return resultChanges(result) > 0;
}

async function abandonStaleIncompleteStaging(env: Env, nowDate: Date, limit = 2): Promise<void> {
  const now = nowDate.toISOString();
  const cutoff = new Date(nowDate.getTime() - SOURCE_OUTBOX_STAGING_TTL_MS).toISOString();
  const candidates = await env.DB
    .prepare(
      `SELECT run_id FROM source_ingest_outbox_runs o
       WHERE state = 'staging' AND created_at <= ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(cutoff, Math.max(1, Math.min(4, limit)))
    .all<{ run_id: string }>();
  for (const candidate of candidates.results ?? []) {
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE source_ingest_outbox_runs
           SET state = 'abandoned', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE run_id = ? AND state = 'staging' AND created_at <= ?`,
        )
        .bind(now, candidate.run_id, cutoff),
      env.DB
        .prepare(
          `UPDATE source_runs
           SET status = 'failed', finished_at = ?,
               collection_finished_at = COALESCE(collection_finished_at, ?),
               collection_partial = 1,
               last_ingest_error = 'Producer outbox staging expired before activation',
               ingest_updated_at = ?,
               terminal_accounted_at = COALESCE(terminal_accounted_at, ?)
           WHERE id = ? AND status = 'running' AND terminal_accounted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM source_ingest_outbox_runs
               WHERE run_id = ? AND state = 'abandoned'
             )`,
        )
        .bind(now, now, now, now, candidate.run_id, candidate.run_id),
    ]);
  }

  const abandoned = await env.DB
    .prepare(
      `SELECT run_id FROM source_ingest_outbox_runs
       WHERE state = 'abandoned' ORDER BY updated_at ASC LIMIT 1`,
    )
    .first<{ run_id: string }>();
  if (!abandoned) return;
  const messages = await env.DB
    .prepare(
      `SELECT item_index, raw_r2_key FROM source_ingest_outbox_messages
       WHERE run_id = ? ORDER BY item_index LIMIT 100`,
    )
    .bind(abandoned.run_id)
    .all<{ item_index: number; raw_r2_key: string | null }>();
  const rows = messages.results ?? [];
  const rawKeys = rows.flatMap((row) => row.raw_r2_key ? [row.raw_r2_key] : []);
  if (rawKeys.length > 0) {
    try {
      await env.EVIDENCE.delete(rawKeys);
    } catch (error) {
      console.error(JSON.stringify({ message: "Unable to clean abandoned source outbox raw objects", error: errorText(error) }));
      return;
    }
  }
  if (rows.length > 0) {
    await env.DB
      .prepare(
        `DELETE FROM source_ingest_outbox_messages
         WHERE run_id = ? AND item_index IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`,
      )
      .bind(abandoned.run_id, JSON.stringify(rows.map((row) => row.item_index)))
      .run();
  }
  await env.DB
    .prepare(
      `DELETE FROM source_ingest_outbox_runs
       WHERE run_id = ? AND state = 'abandoned'
         AND NOT EXISTS (SELECT 1 FROM source_ingest_outbox_messages WHERE run_id = ?)` ,
    )
    .bind(abandoned.run_id, abandoned.run_id)
    .run();
}

async function claimReadyRun(
  db: D1Database,
  preferredRunId: string | undefined,
  sourceId: string | undefined,
  nowDate: Date,
): Promise<SourceOutboxRun | null> {
  const now = nowDate.toISOString();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(nowDate.getTime() + SOURCE_OUTBOX_LEASE_MS).toISOString();
  return db
    .prepare(
      `UPDATE source_ingest_outbox_runs
       SET lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE run_id = (
         SELECT candidate.run_id FROM source_ingest_outbox_runs candidate
         JOIN source_runs source_run ON source_run.id = candidate.run_id
         WHERE candidate.state = 'ready' AND candidate.next_index < candidate.message_count
           AND source_run.terminal_accounted_at IS NULL
           AND (candidate.lease_expires_at IS NULL OR candidate.lease_expires_at <= ?)
           AND (? IS NULL OR candidate.source_id = ?)
         ORDER BY CASE WHEN candidate.run_id = ? THEN 0 ELSE 1 END,
                  COALESCE(candidate.activated_at, candidate.created_at) ASC
         LIMIT 1
       )
       RETURNING run_id, source_id, message_count, total_bytes, payload_sha256, next_index,
                 lease_token, lease_expires_at`,
    )
    .bind(leaseToken, leaseExpiresAt, now, now, sourceId ?? null, sourceId ?? null, preferredRunId ?? "")
    .first<SourceOutboxRun>();
}

async function releaseClaim(db: D1Database, runId: string, leaseToken: string | null, now: string): Promise<void> {
  if (!leaseToken) return;
  await db
    .prepare(
      `UPDATE source_ingest_outbox_runs
       SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE run_id = ? AND lease_token = ?`,
    )
    .bind(now, runId, leaseToken)
    .run();
}

async function parseOutboxMessage(run: SourceOutboxRun, row: SourceOutboxMessageRow): Promise<IngestMessage> {
  if (await sha256(row.message_json) !== row.body_sha256) {
    throw new Error(`Tracked source outbox message ${row.item_index} failed its body digest`);
  }
  const parsed = JSON.parse(row.message_json) as IngestMessage;
  if (
    !parsed || typeof parsed !== "object"
    || parsed.sourceId !== run.source_id
    || parsed.sourceRunId !== run.run_id
    || parsed.sourceRunItemIndex !== row.item_index
    || serializedIngestMessageBytes(parsed) !== row.message_bytes
    || row.message_bytes > INGEST_QUEUE_MESSAGE_MAX_BYTES
    || (parsed.rawR2Key ?? null) !== row.raw_r2_key
  ) {
    throw new Error(`Tracked source outbox message ${row.item_index} failed integrity validation`);
  }
  return parsed;
}

async function checkpointRange(db: D1Database, runId: string, throughIndex: number, now: string): Promise<void> {
  // Queue acceptance advances only the handoff cursor. The immutable body set
  // survives confirmed acceptance so an operator can recover it until the
  // source-run receipt ledger has durably accounted a terminal outcome.
  await db
    .prepare(
      `UPDATE source_ingest_outbox_runs
       SET next_index = MAX(next_index, ?), updated_at = ?
       WHERE run_id = ? AND state = 'ready'`,
    )
    .bind(throughIndex + 1, now, runId)
    .run();
}

export async function maintainTrackedSourceOutbox(env: Env, nowDate = new Date()): Promise<void> {
  const now = nowDate.toISOString();
  await deleteOneTerminalTrackedSourceOutboxRun(env.DB);
  await resumeCompleteStaging(env.DB, now);
  await abandonStaleIncompleteStaging(env, nowDate);
}

export async function trackedSourceOutboxHealth(db: D1Database): Promise<SourceOutboxHealth> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN o.state = 'staging' OR (o.state = 'ready' AND o.next_index < o.message_count AND r.terminal_accounted_at IS NULL) THEN 1 ELSE 0 END) AS active_runs,
         SUM(CASE WHEN o.state = 'staging' THEN 1 ELSE 0 END) AS staging_runs,
         SUM(CASE WHEN o.state = 'ready' AND o.next_index < o.message_count AND r.terminal_accounted_at IS NULL THEN 1 ELSE 0 END) AS ready_runs,
         SUM(CASE WHEN o.state = 'ready' AND o.next_index >= o.message_count AND r.terminal_accounted_at IS NULL THEN 1 ELSE 0 END) AS awaiting_receipt_runs,
         COALESCE(SUM(CASE
           WHEN o.state = 'ready' AND o.next_index >= o.message_count AND r.terminal_accounted_at IS NULL
             THEN MAX(0, o.message_count - (
               SELECT COUNT(*) FROM source_run_ingest_receipts receipt WHERE receipt.run_id = o.run_id
             ))
           ELSE 0
         END), 0) AS awaiting_receipt_messages,
         SUM(CASE WHEN o.state IN ('staging', 'ready') THEN 1 ELSE 0 END) AS retained_runs,
         COALESCE(SUM(CASE WHEN o.state IN ('staging', 'ready') THEN o.message_count ELSE 0 END), 0) AS retained_messages,
         COALESCE(SUM(CASE WHEN o.state IN ('staging', 'ready') THEN o.total_bytes ELSE 0 END), 0) AS retained_bytes,
         SUM(CASE WHEN o.state = 'ready' AND r.terminal_accounted_at IS NOT NULL THEN 1 ELSE 0 END) AS terminal_gc_runs,
         SUM(CASE WHEN o.state = 'abandoned' THEN 1 ELSE 0 END) AS abandoned_runs,
         COALESCE(SUM(CASE WHEN o.state = 'staging' THEN o.message_count WHEN o.state = 'ready' AND r.terminal_accounted_at IS NULL THEN o.message_count - o.next_index ELSE 0 END), 0) AS message_count,
         MIN(CASE WHEN o.state = 'staging' OR (o.state = 'ready' AND o.next_index < o.message_count AND r.terminal_accounted_at IS NULL) THEN o.created_at END) AS oldest_active_at
       FROM source_ingest_outbox_runs o
       LEFT JOIN source_runs r ON r.id = o.run_id`,
    )
    .first<{
      active_runs: number | null;
      staging_runs: number | null;
      ready_runs: number | null;
      awaiting_receipt_runs: number | null;
      awaiting_receipt_messages: number | null;
      retained_runs: number | null;
      retained_messages: number | null;
      retained_bytes: number | null;
      terminal_gc_runs: number | null;
      abandoned_runs: number | null;
      message_count: number | null;
      oldest_active_at: string | null;
    }>();
  const retainedBytes = Number(row?.retained_bytes ?? 0);
  return {
    activeRuns: Number(row?.active_runs ?? 0),
    stagingRuns: Number(row?.staging_runs ?? 0),
    readyRuns: Number(row?.ready_runs ?? 0),
    awaitingReceiptRuns: Number(row?.awaiting_receipt_runs ?? 0),
    awaitingReceiptMessages: Number(row?.awaiting_receipt_messages ?? 0),
    retainedRuns: Number(row?.retained_runs ?? 0),
    retainedMessages: Number(row?.retained_messages ?? 0),
    retainedBytes,
    terminalGcRuns: Number(row?.terminal_gc_runs ?? 0),
    abandonedRuns: Number(row?.abandoned_runs ?? 0),
    messageCount: Number(row?.message_count ?? 0),
    activeBytes: retainedBytes,
    oldestActiveAt: row?.oldest_active_at ?? null,
  };
}

/**
 * Drains one leased run with bounded D1 queries and Queue writes. A Queue or
 * checkpoint ambiguity retains the lease and exact bodies; after expiry the
 * same run/index payload is replayed and ingest receipts make that safe.
 */
export async function drainTrackedSourceOutbox(
  env: Env,
  options: SourceOutboxDrainOptions = {},
): Promise<SourceOutboxDrainResult> {
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  if (!options.skipMaintenance) await maintainTrackedSourceOutbox(env, nowDate);
  else if (options.resumeStaging) await resumeCompleteStaging(env.DB, now, 1, options.sourceId);
  const run = await claimReadyRun(env.DB, options.preferredRunId, options.sourceId, nowDate);
  if (!run) return { claimed: false, sentCount: 0, receiptCount: 0, batchCount: 0, completed: true, ambiguous: false };

  if (options.preverifiedRunId !== run.run_id && !(await verifyOutboxBodySet(env.DB, run.run_id))) {
    return {
      claimed: true,
      runId: run.run_id,
      sentCount: 0,
      receiptCount: 0,
      batchCount: 0,
      completed: false,
      ambiguous: true,
      error: "Tracked source outbox body-set digest validation failed",
    };
  }

  try {
    await requireIngestQueueDurability(env);
  } catch (error) {
    await releaseClaim(env.DB, run.run_id, run.lease_token, now);
    throw error;
  }

  const maxBatches = Math.max(1, Math.min(10, Math.floor(options.maxBatches ?? SOURCE_OUTBOX_DEFAULT_MAX_BATCHES)));
  let sentCount = 0;
  let receiptCount = 0;
  let batchCount = 0;
  for (; batchCount < maxBatches; batchCount += 1) {
    const selected = await env.DB
      .prepare(
        `SELECT o.item_index, o.message_json, o.message_bytes, o.body_sha256, o.raw_r2_key,
                r.outcome AS receipt_outcome
         FROM source_ingest_outbox_messages o
         LEFT JOIN source_run_ingest_receipts r
           ON r.run_id = o.run_id AND r.item_index = o.item_index
         WHERE o.run_id = ? AND o.item_index >= ?
         ORDER BY o.item_index LIMIT 100`,
      )
      .bind(run.run_id, run.next_index)
      .all<SourceOutboxMessageRow>();
    const rows = selected.results ?? [];
    if (rows.length === 0) {
      return {
        claimed: true,
        runId: run.run_id,
        sentCount,
        receiptCount,
        batchCount,
        completed: false,
        ambiguous: true,
        error: "Tracked source outbox is missing an expected immutable message range",
      };
    }

    const sendBodies: IngestMessage[] = [];
    let throughIndex = run.next_index - 1;
    let consideredReceipts = 0;
    try {
      for (const row of rows) {
        const body = await parseOutboxMessage(run, row);
        if (row.receipt_outcome) {
          consideredReceipts += 1;
          throughIndex = row.item_index;
          continue;
        }
        const candidate = [...sendBodies, body];
        if (sendBodies.length > 0 && (
          candidate.length > INGEST_QUEUE_BATCH_MAX_MESSAGES
          || serializedIngestBatchBytes(candidate) > INGEST_QUEUE_BATCH_MAX_BYTES
        )) break;
        if (serializedIngestBatchBytes(candidate) > INGEST_QUEUE_BATCH_MAX_BYTES) {
          throw new Error(`Tracked source outbox message ${row.item_index} cannot fit a Queue batch`);
        }
        sendBodies.push(body);
        throughIndex = row.item_index;
      }
    } catch (error) {
      return {
        claimed: true,
        runId: run.run_id,
        sentCount,
        receiptCount,
        batchCount,
        completed: false,
        ambiguous: true,
        error: errorText(error),
      };
    }

    if (throughIndex < run.next_index) {
      return {
        claimed: true, runId: run.run_id, sentCount, receiptCount, batchCount,
        completed: false, ambiguous: true, error: "Tracked source outbox made no bounded progress",
      };
    }
    if (sendBodies.length > 0) {
      try {
        await env.INGEST_QUEUE.sendBatch(sendBodies.map((body) => ({ body, contentType: "json" as const })));
      } catch (error) {
        return {
          claimed: true,
          runId: run.run_id,
          sentCount,
          receiptCount,
          batchCount,
          completed: false,
          ambiguous: true,
          error: errorText(error),
        };
      }
    }
    try {
      await checkpointRange(env.DB, run.run_id, throughIndex, now);
    } catch (error) {
      return {
        claimed: true,
        runId: run.run_id,
        sentCount,
        receiptCount,
        batchCount: batchCount + 1,
        completed: false,
        ambiguous: true,
        error: errorText(error),
      };
    }
    sentCount += sendBodies.length;
    receiptCount += consideredReceipts;
    run.next_index = throughIndex + 1;
    if (run.next_index >= run.message_count) {
      return { claimed: true, runId: run.run_id, sentCount, receiptCount, batchCount: batchCount + 1, completed: true, ambiguous: false };
    }
  }
  await releaseClaim(env.DB, run.run_id, run.lease_token, now);
  return { claimed: true, runId: run.run_id, sentCount, receiptCount, batchCount, completed: false, ambiguous: false };
}

/**
 * Durable producer path for built-in public tracked source runs only. Exact
 * bodies and a header are staged before one atomic source-run activation; the
 * post-activation drain is opportunistic because the outbox is now canonical.
 */
export async function enqueueTrackedSourceRun(
  env: Env,
  inputs: readonly IngestMessageInput[],
  activation: TrackedSourceOutboxActivation,
): Promise<EnqueueTrackedSourceRunResult> {
  validateTrackedPublicInputs(activation, inputs);
  await requireIngestQueueDurability(env);
  const entries = await prepareIngestEntries(env, inputs);
  const rows = await stagedPayload(entries);
  const totalBytes = rows.reduce((sum, row) => sum + row.messageBytes, 0);
  const payloadSha256 = await bodySetSha256(rows);
  const now = isoNow();
  let headerInserted = false;
  try {
    if (totalBytes <= 0 || totalBytes > SOURCE_OUTBOX_MAX_RUN_BYTES) {
      throw new HttpError(503, "Tracked source output exceeds the bounded producer outbox", {
        code: "INGEST_OUTBOX_CAPACITY",
        requestedBytes: totalBytes,
        maximumBytesPerRun: SOURCE_OUTBOX_MAX_RUN_BYTES,
      });
    }
    const chunks = payloadChunks(rows);
    headerInserted = await insertOutboxHeader(env.DB, activation, entries.length, totalBytes, payloadSha256, now);
    if (!headerInserted) {
      throw new HttpError(503, "Tracked source producer outbox is at capacity", {
        code: "INGEST_OUTBOX_CAPACITY",
        requestedMessages: entries.length,
        requestedBytes: totalBytes,
        maximumActiveMessages: SOURCE_OUTBOX_MAX_ACTIVE_MESSAGES,
        maximumActiveBytes: SOURCE_OUTBOX_MAX_ACTIVE_BYTES,
      });
    }
    await requireBudget(env.DB, "queue_messages", entries.length, {
      producers: [activation.provider],
      sourceCount: 1,
      durableProducerOutbox: true,
    });
    for (const chunk of chunks) await insertMessageChunk(env.DB, activation.runId, chunk, now);
  } catch (error) {
    if (headerInserted) {
      const discarded = await discardUnactivatedStaging(env, activation.runId, entries, "tracked-source-outbox-staging-failed");
      if (!discarded) throw new SourceOutboxActivationUnknownError(activation.runId, error);
    } else {
      await cleanupPreparedIngestEntries(env, entries, "tracked-source-outbox-reservation-failed");
    }
    throw error;
  }

  const activated = await activateOutboxRun(env.DB, activation.runId, now);
  if (!activated) throw new SourceOutboxActivationUnknownError(activation.runId);
  let drain: SourceOutboxDrainResult;
  try {
    // The oldest ready run for this source wins. Producer entry never spends
    // another source's invocation or substitutes its canonical run.
    drain = await drainTrackedSourceOutbox(env, {
      maxBatches: 1,
      skipMaintenance: true,
      preverifiedRunId: activation.runId,
      sourceId: activation.sourceId,
    });
  } catch (error) {
    drain = {
      claimed: false,
      sentCount: 0,
      receiptCount: 0,
      batchCount: 0,
      completed: false,
      ambiguous: false,
      error: errorText(error),
    };
  }
  return { messageCount: entries.length, totalBytes, drain };
}
