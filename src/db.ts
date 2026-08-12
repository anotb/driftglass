import type {
  BriefingPacket,
  CollectorResultSummary,
  CollectorJob,
  EvidenceLineageRecord,
  InboxReceiptRecord,
  ItemIngestCompletionRecord,
  ItemIngestStage,
  ItemRecord,
  IntelligencePackOverlayRecord,
  IntelligencePackRecord,
  IntelligenceRoutineRecord,
  IntelligenceRoutineRunRecord,
  MemoryCheckpointRecord,
  MemoryEdgeRecord,
  MemoryGraphRunRecord,
  MemoryNodeRecord,
  MemoryNodeStatus,
  MemoryNodeType,
  MemoryProposalRecord,
  MemoryRelation,
  MissionEventRecord,
  MissionExpectedEventStatus,
  MissionOperatorRecord,
  MissionOutcomeStatus,
  MissionRecord,
  MissionResearchPolicy,
  MissionResearchStateRecord,
  MissionSprintPolicy,
  ResearchResultImportRecord,
  ReasoningPlaybookRecord,
  ReasoningReceiptRecord,
  ReasoningRunEventRecord,
  ReasoningRunRecord,
  MissionRunRecord,
  MissionMode,
  PublicShareRecord,
  SourceCadenceRecord,
  SourceRecord,
  StoryRecord,
  TasteSourceRecord,
  TasteTermRecord,
  UsageDailyRecord,
  UsageDimension,
} from "./types";
import { COMPANION_DISPATCH_TAKEOVER_MS } from "./collector-results";
import { normalizeOpenAlexConfig } from "./sources/openalex";
import { HttpError, isoNow, parseJson } from "./utils";

function rows<T>(result: D1Result<T>): T[] {
  return result.results ?? [];
}

/**
 * Keep finite evidence windows useful when one Story accumulates many recent
 * package snapshots. These adapters carry package description plus release
 * identity rather than version-specific notes, so other public evidence gets
 * the bounded slots first. Package evidence remains eligible when it is all a
 * Story has.
 *
 * Both bounded callers use the same `s`, `i`, and `el` aliases.
 */
export const PUBLIC_EVIDENCE_LOW_SIGNAL_SQL = `CASE
  WHEN s.kind IN ('npm_releases', 'pypi_releases')
  THEN 1
  ELSE 0
END`;

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings(key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, isoNow())
    .run();
}

export async function listSources(db: D1Database): Promise<SourceRecord[]> {
  return rows(await db.prepare("SELECT * FROM sources ORDER BY name COLLATE NOCASE").all<SourceRecord>());
}

export async function getSource(db: D1Database, sourceId: string): Promise<SourceRecord | null> {
  return db.prepare("SELECT * FROM sources WHERE id = ?").bind(sourceId).first<SourceRecord>();
}

export async function upsertSource(
  db: D1Database,
  source: {
    id: string;
    name: string;
    kind: string;
    config: Record<string, unknown>;
    enabled?: boolean;
    scheduleMinutes?: number;
    weight?: number;
  },
): Promise<void> {
  const config = source.kind === "openalex"
    ? normalizeOpenAlexConfig(source.config ?? {})
    : source.config ?? {};
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO sources(
        id, name, kind, config_json, enabled, schedule_minutes, weight, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        config_json = excluded.config_json,
        enabled = excluded.enabled,
        schedule_minutes = excluded.schedule_minutes,
        weight = excluded.weight,
        updated_at = excluded.updated_at`,
    )
    .bind(
      source.id,
      source.name,
      source.kind,
      JSON.stringify(config),
      source.enabled === false ? 0 : 1,
      Math.max(15, source.scheduleMinutes ?? 60),
      source.weight ?? 1,
      now,
      now,
    )
    .run();
}

export async function deleteSource(db: D1Database, sourceId: string): Promise<void> {
  await db.prepare("DELETE FROM sources WHERE id = ?").bind(sourceId).run();
  await db.prepare(
    `UPDATE stories SET source_count = (
       SELECT COUNT(DISTINCT i.source_id)
       FROM story_items si
       JOIN items i ON i.id = si.item_id
       WHERE si.story_id = stories.id
     )`,
  ).run();
  await db.prepare("DELETE FROM stories WHERE NOT EXISTS (SELECT 1 FROM story_items WHERE story_id = stories.id)").run();
}

export async function dueSources(
  db: D1Database,
  now: string,
  options: { limit?: number; deferOpenAlex?: boolean } = {},
): Promise<SourceRecord[]> {
  const limit = Math.max(1, Math.min(250, Math.floor(options.limit ?? 250)));
  return rows(
    await db
      .prepare(
        `SELECT s.* FROM sources s
         LEFT JOIN source_cadence c ON c.source_id = s.id
         WHERE s.enabled = 1
           AND (
             (c.next_run_at IS NOT NULL AND datetime(c.next_run_at) <= datetime(?)) OR
             (c.next_run_at IS NULL AND (
               s.last_run_at IS NULL OR
               datetime(s.last_run_at, '+' || COALESCE(c.effective_minutes, s.schedule_minutes) || ' minutes') <= datetime(?)
             ))
           )
         ORDER BY CASE WHEN ? = 1 AND s.kind = 'openalex' THEN 1 ELSE 0 END ASC,
                  COALESCE(c.next_run_at, s.last_run_at, '1970-01-01T00:00:00.000Z') ASC
         LIMIT ?`,
      )
      .bind(now, now, options.deferOpenAlex ? 1 : 0, limit)
      .all<SourceRecord>(),
  );
}

export async function beginSourceRun(db: D1Database, sourceId: string, provider: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = isoNow();
  await db.batch([
    db
      .prepare(
        `INSERT INTO source_runs(id, source_id, started_at, status, provider)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .bind(id, sourceId, now, provider),
    db.prepare("UPDATE sources SET last_run_at = ?, updated_at = ? WHERE id = ?").bind(now, now, sourceId),
  ]);
  return id;
}

export async function finishSourceRun(
  db: D1Database,
  input: {
    runId: string;
    sourceId: string;
    status: "success" | "partial" | "failed" | "queued" | "pending";
    itemCount: number;
    latencyMs: number;
    details?: Record<string, unknown>;
    error?: string;
    provider?: string;
    enqueuedCount?: number;
    collectionPartial?: boolean;
    collectionHealthDelta?: number;
    affectSourceHealth?: boolean;
    retryDue?: boolean;
  },
): Promise<void> {
  const now = isoNow();
  const enqueuedCount = Math.max(0, Math.floor(input.enqueuedCount ?? 0));
  const hasEnqueuedCount = input.enqueuedCount !== undefined;
  const collectionPartial = input.collectionPartial ? 1 : 0;
  const collectionHealthDelta = Number.isFinite(input.collectionHealthDelta)
    ? Math.max(-0.2, Math.min(0.08, Number(input.collectionHealthDelta)))
    : 0;
  if (input.status === "queued") {
    await db
      .prepare(
        `UPDATE source_runs
         SET finished_at = NULL,
             collection_finished_at = ?,
             collection_partial = ?,
             collection_health_delta = ?,
             status = 'queued',
             item_count = ?,
             enqueued_count = ?,
             latency_ms = ?,
             provider = COALESCE(?, provider),
             details_json = ?,
             ingest_updated_at = ?,
             last_ingest_error = NULL,
             terminal_accounted_at = terminal_accounted_at
         WHERE id = ? AND source_id = ?
           AND status IN ('running', 'queued')
           AND finished_at IS NULL
           AND terminal_accounted_at IS NULL`,
      )
      .bind(
        now,
        collectionPartial,
        collectionHealthDelta,
        input.itemCount,
        enqueuedCount,
        input.latencyMs,
        input.provider ?? null,
        JSON.stringify(input.details ?? {}),
        now,
        input.runId,
        input.sourceId,
      )
      .run();
    return;
  }

  const terminal = input.status === "success" || input.status === "partial" || input.status === "failed";
  const healthDelta = input.status === "success" ? 0.08 : input.status === "partial" ? -0.02 : input.status === "failed" ? -0.2 : 0;
  const statements = [
    db
      .prepare(
        `UPDATE source_runs
         SET finished_at = ?,
             collection_finished_at = COALESCE(collection_finished_at, ?),
             collection_partial = ?,
             status = ?,
             item_count = ?,
             enqueued_count = CASE WHEN ? THEN ? ELSE enqueued_count END,
             latency_ms = ?,
             provider = COALESCE(?, provider),
             details_json = ?,
             last_ingest_error = ?,
             ingest_updated_at = CASE WHEN ? THEN ? ELSE ingest_updated_at END,
             terminal_accounted_at = CASE WHEN ? THEN ? ELSE terminal_accounted_at END
         WHERE id = ? AND source_id = ?`,
      )
      .bind(
        now,
        now,
        collectionPartial,
        input.status,
        input.itemCount,
        hasEnqueuedCount ? 1 : 0,
        enqueuedCount,
        input.latencyMs,
        input.provider ?? null,
        JSON.stringify(input.details ?? {}),
        input.error ?? null,
        terminal ? 1 : 0,
        now,
        terminal ? 1 : 0,
        now,
        input.runId,
        input.sourceId,
      ),
  ];
  if (terminal && input.affectSourceHealth !== false) {
    statements.push(db
      .prepare(
        `UPDATE sources SET
          last_success_at = CASE WHEN ? IN ('success', 'partial') THEN ? ELSE last_success_at END,
          last_error = ?,
          health_score = MIN(1.0, MAX(0.0, health_score + ?)),
          updated_at = ?
         WHERE id = ?`,
      )
      .bind(input.status, now, input.error ?? null, healthDelta, now, input.sourceId));
  }
  if (terminal && input.retryDue) {
    const latestRunGuard = `EXISTS (
      SELECT 1
      FROM source_runs retry_run
      JOIN sources retry_source ON retry_source.id = retry_run.source_id
      WHERE retry_run.id = ?
        AND retry_run.source_id = ?
        AND retry_run.status = 'failed'
        AND retry_run.terminal_accounted_at = ?
        AND retry_source.last_run_at = retry_run.started_at
        AND NOT EXISTS (
          SELECT 1 FROM source_runs newer
          WHERE newer.source_id = retry_run.source_id
            AND newer.rowid > retry_run.rowid
        )
    )`;
    statements.push(
      db
        .prepare(
          `UPDATE source_cadence
           SET next_run_at = ?, last_reason = 'transport-retry-due', updated_at = ?
           WHERE source_id = ? AND ${latestRunGuard}`,
        )
        .bind(now, now, input.sourceId, input.runId, input.sourceId, now),
      db
        .prepare(
          `UPDATE sources
           SET last_run_at = NULL, updated_at = ?
           WHERE id = ? AND ${latestRunGuard}`,
        )
        .bind(now, input.sourceId, input.runId, input.sourceId, now),
    );
  }
  await db.batch(statements);
}

export async function sourceRunHistory(db: D1Database, sourceId: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  return rows(
    await db
      .prepare(
        `SELECT id, started_at, collection_finished_at, finished_at, status, item_count,
                enqueued_count, ingested_count, duplicate_count, failed_count,
                collection_partial, collection_health_delta,
                ingest_failed_attempts, ingest_updated_at, last_ingest_error,
                latency_ms, provider, details_json
         FROM source_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .bind(sourceId, Math.max(1, Math.min(100, limit)))
      .all<Record<string, unknown>>(),
  );
}

export interface BuiltInSourceRunSettlement {
  runId: string;
  status: string;
  collectionPartial: boolean;
  lastIngestError: string | null;
}

export async function listBuiltInSourceRunSettlements(
  db: D1Database,
  runIds: readonly string[],
): Promise<BuiltInSourceRunSettlement[]> {
  const ids = [...new Set(runIds.filter(Boolean))].slice(0, 30);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT run.id AS run_id, run.status, run.collection_partial,
              run.last_ingest_error, run.terminal_accounted_at
       FROM source_runs run
       JOIN sources source ON source.id = run.source_id
       WHERE run.id IN (${placeholders})
         AND source.kind NOT IN ('collector', 'manual', 'email')`,
    )
    .bind(...ids)
    .all<{
      run_id: string;
      status: string;
      collection_partial: number;
      last_ingest_error: string | null;
      terminal_accounted_at: string | null;
    }>();
  return rows(result).map((row) => ({
    runId: row.run_id,
    status: ["success", "partial", "failed"].includes(row.status) && !row.terminal_accounted_at
      ? "pending"
      : row.status,
    collectionPartial: row.collection_partial === 1,
    lastIngestError: row.last_ingest_error,
  }));
}

export type SourceRunIngestOutcome = "inserted" | "duplicate" | "failed";

export interface SourceRunIngestReceiptResult {
  runFound: boolean;
  receiptRecorded: boolean;
  status?: string;
  enqueuedCount?: number;
  processedCount?: number;
}

/**
 * Records one terminal Queue item outcome. The receipt insert is idempotent;
 * aggregate counters are recomputed from receipts so a retry cannot inflate a
 * source run. Last-success/error is applied once at terminal state; Queue or
 * platform delivery failure intentionally does not alter adapter health.
 */
export async function recordSourceRunIngestOutcome(
  db: D1Database,
  input: {
    runId: string;
    sourceId: string;
    itemIndex: number;
    outcome: SourceRunIngestOutcome;
    itemId?: string;
    error?: string;
    /** Already-normalized Queue retry count (delivery ordinal minus one). */
    retryCount?: number;
  },
): Promise<SourceRunIngestReceiptResult> {
  const now = isoNow();
  const itemIndex = Math.max(0, Math.floor(input.itemIndex));
  const retryCount = Math.max(0, Math.floor(input.retryCount ?? 0));
  const error = input.error?.slice(0, 500) ?? null;
  await db
    .prepare(
      `INSERT OR IGNORE INTO source_run_ingest_receipts(
         run_id, item_index, outcome, item_id, error, created_at
       )
       SELECT id, ?, ?, ?, ?, ?
       FROM source_runs
       WHERE id = ? AND source_id = ? AND status = 'queued'
         AND enqueued_count > 0 AND ? >= 0 AND ? < enqueued_count`,
    )
    .bind(
      itemIndex,
      input.outcome,
      input.itemId ?? null,
      error,
      now,
      input.runId,
      input.sourceId,
      itemIndex,
      itemIndex,
    )
    .run();

  const terminalCount = `(SELECT COUNT(*) FROM source_run_ingest_receipts WHERE run_id = source_runs.id)`;
  const insertedCount = `(SELECT COUNT(*) FROM source_run_ingest_receipts WHERE run_id = source_runs.id AND outcome = 'inserted')`;
  const duplicateCount = `(SELECT COUNT(*) FROM source_run_ingest_receipts WHERE run_id = source_runs.id AND outcome = 'duplicate')`;
  const failedCount = `(SELECT COUNT(*) FROM source_run_ingest_receipts WHERE run_id = source_runs.id AND outcome = 'failed')`;
  const terminalStatus = `CASE
    WHEN ${failedCount} >= enqueued_count THEN 'failed'
    WHEN ${failedCount} > 0 OR collection_partial = 1 THEN 'partial'
    ELSE 'success'
  END`;
  await db.batch([
    db
      .prepare(
        `UPDATE source_runs
         SET ingested_count = ${insertedCount},
             duplicate_count = ${duplicateCount},
             failed_count = ${failedCount},
             ingest_failed_attempts = MAX(ingest_failed_attempts, ?),
             ingest_updated_at = ?,
             last_ingest_error = CASE
               WHEN ${failedCount} > 0 THEN COALESCE(
                 (SELECT error FROM source_run_ingest_receipts
                  WHERE run_id = source_runs.id AND outcome = 'failed'
                  ORDER BY item_index LIMIT 1),
                 last_ingest_error
               )
               ELSE last_ingest_error
             END,
             status = CASE
               WHEN enqueued_count > 0 AND ${terminalCount} >= enqueued_count THEN ${terminalStatus}
               ELSE status
             END,
             finished_at = CASE
               WHEN enqueued_count > 0 AND ${terminalCount} >= enqueued_count THEN COALESCE(finished_at, ?)
               ELSE NULL
             END
         WHERE id = ? AND source_id = ? AND status = 'queued'`,
      )
      .bind(retryCount, now, now, input.runId, input.sourceId),
    db
      .prepare(
        `UPDATE sources
         SET last_success_at = CASE
               WHEN (SELECT status FROM source_runs WHERE id = ?) IN ('success', 'partial') THEN ?
               ELSE last_success_at
             END,
             last_error = CASE
               WHEN (SELECT status FROM source_runs WHERE id = ?) = 'success' THEN NULL
               WHEN (SELECT status FROM source_runs WHERE id = ?) = 'partial' THEN COALESCE(
                 (SELECT last_ingest_error FROM source_runs WHERE id = ?),
                 'Source collection completed with partial coverage'
               )
               ELSE COALESCE(
                 (SELECT last_ingest_error FROM source_runs WHERE id = ?),
                 'Queued source evidence failed durable ingestion'
               )
             END,
             health_score = MIN(1.0, MAX(0.0, health_score + COALESCE(
               (SELECT collection_health_delta FROM source_runs WHERE id = ?),
               0
             ))),
             updated_at = ?
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM source_runs
           WHERE id = ? AND source_id = sources.id
             AND status IN ('success', 'partial', 'failed')
             AND terminal_accounted_at IS NULL
         )`,
      )
      .bind(
        input.runId,
        now,
        input.runId,
        input.runId,
        input.runId,
        input.runId,
        input.runId,
        now,
        input.sourceId,
        input.runId,
      ),
    db
      .prepare(
        `UPDATE source_runs SET terminal_accounted_at = ?
         WHERE id = ? AND source_id = ?
           AND status IN ('success', 'partial', 'failed')
           AND terminal_accounted_at IS NULL`,
      )
      .bind(now, input.runId, input.sourceId),
  ]);

  const run = await db
    .prepare(
      `SELECT status, enqueued_count,
              (ingested_count + duplicate_count + failed_count) AS processed_count
       FROM source_runs WHERE id = ? AND source_id = ?`,
    )
    .bind(input.runId, input.sourceId)
    .first<{ status: string; enqueued_count: number; processed_count: number }>();
  const receipt = run
    ? await db
      .prepare("SELECT outcome FROM source_run_ingest_receipts WHERE run_id = ? AND item_index = ?")
      .bind(input.runId, itemIndex)
      .first<{ outcome: string }>()
    : null;
  return {
    runFound: Boolean(run),
    receiptRecorded: Boolean(receipt),
    status: run?.status,
    enqueuedCount: run?.enqueued_count,
    processedCount: run?.processed_count,
  };
}

export async function recordSourceRunIngestAttemptFailure(
  db: D1Database,
  input: { runId: string; sourceId: string; error: string; retryCount?: number },
): Promise<void> {
  const now = isoNow();
  await db
    .prepare(
      `UPDATE source_runs
       SET ingest_failed_attempts = MAX(ingest_failed_attempts, ?),
           ingest_updated_at = ?,
           last_ingest_error = ?
       WHERE id = ? AND source_id = ? AND status = 'queued'`,
    )
    .bind(
      Math.max(0, Math.floor(input.retryCount ?? 0)),
      now,
      input.error.slice(0, 500),
      input.runId,
      input.sourceId,
    )
    .run();
}

export async function reviseSourceRunAfterPartialEnqueue(
  db: D1Database,
  input: {
    runId: string;
    sourceId: string;
    sentCount: number;
    details: Record<string, unknown>;
    error: string;
  },
): Promise<void> {
  const sentCount = Math.max(1, Math.floor(input.sentCount));
  const now = isoNow();
  await db
    .prepare(
      `UPDATE source_runs
       SET enqueued_count = ?, item_count = ?, collection_partial = 1,
           details_json = ?, ingest_updated_at = ?, last_ingest_error = ?
       WHERE id = ? AND source_id = ? AND status = 'queued'`,
    )
    .bind(
      sentCount,
      sentCount,
      JSON.stringify(input.details),
      now,
      input.error.slice(0, 500),
      input.runId,
      input.sourceId,
    )
    .run();

  // A fast consumer may already have written receipts against the original
  // intent. Replaying one existing receipt through the idempotent aggregator
  // immediately terminalizes the revised run when all sent items are done.
  const receipt = await db
    .prepare(
      `SELECT item_index, outcome, item_id, error
       FROM source_run_ingest_receipts WHERE run_id = ?
       ORDER BY item_index LIMIT 1`,
    )
    .bind(input.runId)
    .first<{ item_index: number; outcome: SourceRunIngestOutcome; item_id: string | null; error: string | null }>();
  if (receipt) {
    await recordSourceRunIngestOutcome(db, {
      runId: input.runId,
      sourceId: input.sourceId,
      itemIndex: receipt.item_index,
      outcome: receipt.outcome,
      itemId: receipt.item_id ?? undefined,
      error: receipt.error ?? undefined,
    });
  }
}

export async function recordUnresolvedIngestDeadLetter(
  db: D1Database,
  input: {
    queueMessageId: string;
    queueName: string;
    sourceId?: string;
    provider?: string;
    sourceRunId?: string;
    sourceRunItemIndex?: number;
    attempts?: number;
    reason: string;
    bodyJson: string;
    bodyHash: string;
    bodyBytes: number;
    emailReceiptClaim?: { messageId: string; claimToken: string };
  },
): Promise<void> {
  const now = isoNow();
  const statements = [
    db
      .prepare(
        `INSERT INTO ingest_dead_letters(
           id, queue_message_id, queue_name, source_id, provider,
           source_run_id, source_run_item_index, attempts, reason,
           body_json, body_hash, body_bytes, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?)
         ON CONFLICT(queue_message_id) DO UPDATE SET
           attempts = MAX(ingest_dead_letters.attempts, excluded.attempts),
           reason = excluded.reason`,
      )
      .bind(
        crypto.randomUUID(),
        input.queueMessageId.slice(0, 256),
        input.queueName.slice(0, 256),
        input.sourceId?.slice(0, 512) ?? null,
        input.provider?.slice(0, 512) ?? null,
        input.sourceRunId?.slice(0, 128) ?? null,
        input.sourceRunItemIndex === undefined ? null : Math.max(0, Math.floor(input.sourceRunItemIndex)),
        Math.max(0, Math.floor(input.attempts ?? 0)),
        input.reason.slice(0, 500),
        input.bodyJson,
        input.bodyHash.slice(0, 128),
        Math.max(0, Math.floor(input.bodyBytes)),
        now,
      ),
  ];
  if (input.emailReceiptClaim && input.sourceId) {
    statements.push(db
      .prepare(
        `UPDATE inbox_receipts
         SET queue_state = 'failed', outcome = 'queue-failed'
         WHERE dedupe_key = ? AND queue_claim_token = ? AND queue_state IN ('pending', 'queued', 'failed')`,
      )
      .bind(
        inboxReceiptDedupeKey(input.sourceId, input.emailReceiptClaim.messageId),
        input.emailReceiptClaim.claimToken,
      ));
  }
  await db.batch(statements);
  const persisted = await db
    .prepare("SELECT id FROM ingest_dead_letters WHERE queue_message_id = ?")
    .bind(input.queueMessageId.slice(0, 256))
    .first<{ id: string }>();
  if (!persisted) throw new Error("Exhausted ingest message could not be persisted");
}

export interface IngestDeadLetterSummary {
  id: string;
  queue_message_id: string;
  queue_name: string;
  source_id: string | null;
  provider: string | null;
  source_run_id: string | null;
  source_run_item_index: number | null;
  attempts: number;
  reason: string;
  body_hash: string;
  body_bytes: number;
  status: "unresolved" | "resolved" | "ignored";
  created_at: string;
  resolved_at: string | null;
}

interface IngestDeadLetterPrivateRecord extends IngestDeadLetterSummary {
  body_json: string;
  retry_claim_token: string | null;
  retry_claimed_at: string | null;
}

const INGEST_DEAD_LETTER_SUMMARY_COLUMNS = `id, queue_message_id, queue_name,
  source_id, provider, source_run_id, source_run_item_index, attempts, reason,
  body_hash, body_bytes, status, created_at, resolved_at`;

/** Content-free operator view; body_json is deliberately excluded. */
export async function listIngestDeadLetters(
  db: D1Database,
  limit = 50,
): Promise<IngestDeadLetterSummary[]> {
  return rows(await db
    .prepare(
      `SELECT ${INGEST_DEAD_LETTER_SUMMARY_COLUMNS}
       FROM ingest_dead_letters
       ORDER BY CASE WHEN status = 'unresolved' THEN 0 ELSE 1 END, created_at DESC
       LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(100, limit)))
    .all<IngestDeadLetterSummary>());
}

/** Private server-side recovery read. API responses must never return body_json. */
export async function getIngestDeadLetterForRetry(
  db: D1Database,
  id: string,
): Promise<IngestDeadLetterPrivateRecord | null> {
  return db
    .prepare(
      `SELECT ${INGEST_DEAD_LETTER_SUMMARY_COLUMNS}, body_json,
              retry_claim_token, retry_claimed_at
       FROM ingest_dead_letters WHERE id = ?`,
    )
    .bind(id)
    .first<IngestDeadLetterPrivateRecord>();
}

/** Atomically leases one private recovery body so concurrent owner retries send once. */
export async function claimIngestDeadLetterForRetry(
  db: D1Database,
  id: string,
  claimToken: string,
  leaseMinutes = 10,
): Promise<IngestDeadLetterPrivateRecord> {
  const now = isoNow();
  const staleBefore = new Date(Date.now() - Math.max(1, leaseMinutes) * 60_000).toISOString();
  const claimed = await db
    .prepare(
      `UPDATE ingest_dead_letters
       SET retry_claim_token = ?, retry_claimed_at = ?
       WHERE id = ? AND status = 'unresolved' AND body_json <> '{}'
         AND (
           retry_claim_token IS NULL OR retry_claimed_at IS NULL OR
           datetime(retry_claimed_at) <= datetime(?)
         )
       RETURNING ${INGEST_DEAD_LETTER_SUMMARY_COLUMNS}, body_json,
                 retry_claim_token, retry_claimed_at`,
    )
    .bind(claimToken, now, id, staleBefore)
    .first<IngestDeadLetterPrivateRecord>();
  if (claimed) return claimed;

  const current = await db
    .prepare(
      `SELECT ${INGEST_DEAD_LETTER_SUMMARY_COLUMNS}, body_json,
              retry_claim_token, retry_claimed_at
       FROM ingest_dead_letters WHERE id = ?`,
    )
    .bind(id)
    .first<IngestDeadLetterPrivateRecord>();
  if (!current) throw new HttpError(404, "Ingest dead letter not found");
  if (current.status !== "unresolved") throw new HttpError(409, `Ingest dead letter is already ${current.status}`);
  throw new HttpError(409, "Ingest dead letter retry is already in progress");
}

export async function releaseIngestDeadLetterRetryClaim(
  db: D1Database,
  id: string,
  claimToken: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE ingest_dead_letters
       SET retry_claim_token = NULL, retry_claimed_at = NULL
       WHERE id = ? AND status = 'unresolved' AND retry_claim_token = ?`,
    )
    .bind(id, claimToken)
    .run();
}

export async function completeIngestDeadLetterRetryClaim(
  db: D1Database,
  id: string,
  claimToken: string,
): Promise<IngestDeadLetterSummary> {
  const now = isoNow();
  const completed = await db
    .prepare(
      `UPDATE ingest_dead_letters
       SET status = 'resolved', resolved_at = ?, body_json = '{}', body_bytes = 0,
           retry_claim_token = NULL, retry_claimed_at = NULL
       WHERE id = ? AND status = 'unresolved' AND retry_claim_token = ?
       RETURNING ${INGEST_DEAD_LETTER_SUMMARY_COLUMNS}`,
    )
    .bind(now, id, claimToken)
    .first<IngestDeadLetterSummary>();
  if (!completed) throw new HttpError(409, "Ingest dead letter retry claim is no longer current");
  return completed;
}

export async function resolveIngestDeadLetter(
  db: D1Database,
  id: string,
  disposition: "resolved" | "ignored",
): Promise<IngestDeadLetterSummary> {
  const now = isoNow();
  await db
    .prepare(
      `UPDATE ingest_dead_letters
       SET status = ?, resolved_at = ?, body_json = '{}', body_bytes = 0,
           retry_claim_token = NULL, retry_claimed_at = NULL
       WHERE id = ? AND status = 'unresolved' AND retry_claim_token IS NULL`,
    )
    .bind(disposition, now, id)
    .run();
  const record = await db
    .prepare(`SELECT ${INGEST_DEAD_LETTER_SUMMARY_COLUMNS} FROM ingest_dead_letters WHERE id = ?`)
    .bind(id)
    .first<IngestDeadLetterSummary>();
  if (!record) throw new HttpError(404, "Ingest dead letter not found");
  if (record.status === "unresolved") throw new HttpError(409, "Ingest dead letter retry is already in progress");
  if (record.status !== disposition) throw new HttpError(409, `Ingest dead letter is already ${record.status}`);
  return record;
}

export interface IngestDurabilityDatabaseHealth {
  staleTrackedRuns: number;
  oldestStaleRunAt: string | null;
  orphanedPendingRuns: number;
  oldestOrphanedPendingRunAt: string | null;
  unresolvedDeadLetters: number;
  oldestDeadLetterAt: string | null;
}

export async function ingestDurabilityDatabaseHealth(
  db: D1Database,
  staleAfterMinutes = 15,
): Promise<IngestDurabilityDatabaseHealth> {
  const cutoff = new Date(Date.now() - Math.max(1, staleAfterMinutes) * 60_000).toISOString();
  const [stale, orphanedPending, deadLetters] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS count,
                MIN(COALESCE(r.ingest_updated_at, r.collection_finished_at, r.started_at)) AS oldest
         FROM source_runs r
         JOIN sources s ON s.id = r.source_id
         WHERE (
             (
               r.status = 'queued' AND r.enqueued_count > 0
               AND (r.ingested_count + r.duplicate_count + r.failed_count) < r.enqueued_count
             ) OR (
               r.status = 'running' AND s.kind NOT IN ('collector', 'manual', 'email')
             )
           )
           AND COALESCE(r.ingest_updated_at, r.collection_finished_at, r.started_at) <= ?`,
      )
      .bind(cutoff)
      .first<{ count: number; oldest: string | null }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(run.finished_at) AS oldest
         FROM source_runs run
         JOIN sources source ON source.id = run.source_id
         WHERE source.kind NOT IN ('collector', 'manual', 'email')
           AND run.status = 'pending'
           AND run.finished_at IS NOT NULL
           AND run.item_count = 0
           AND run.enqueued_count = 0
           AND run.terminal_accounted_at IS NULL
           AND CASE WHEN json_valid(run.details_json) THEN (
             COALESCE(json_extract(run.details_json, '$.ingestBackpressure'), 0) = 1
             OR COALESCE(json_extract(run.details_json, '$.budgetDeferred'), 0) = 1
             OR COALESCE(json_extract(run.details_json, '$.sourcePrerequisite'), 0) = 1
             OR COALESCE(json_extract(run.details_json, '$.budgetDeferredItems'), 0) > 0
             OR COALESCE(json_extract(run.details_json, '$.outboxDeferredItems'), 0) > 0
           ) ELSE 0 END
           AND NOT EXISTS (SELECT 1 FROM source_ingest_outbox_runs outbox WHERE outbox.run_id = run.id)
           AND NOT EXISTS (SELECT 1 FROM source_run_ingest_receipts receipt WHERE receipt.run_id = run.id)
           AND NOT EXISTS (SELECT 1 FROM collector_jobs job WHERE job.source_run_id = run.id)`,
      )
      .first<{ count: number; oldest: string | null }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(created_at) AS oldest
         FROM ingest_dead_letters WHERE status = 'unresolved'`,
      )
      .first<{ count: number; oldest: string | null }>(),
  ]);
  return {
    staleTrackedRuns: Number(stale?.count ?? 0),
    oldestStaleRunAt: stale?.oldest ?? null,
    orphanedPendingRuns: Number(orphanedPending?.count ?? 0),
    oldestOrphanedPendingRunAt: orphanedPending?.oldest ?? null,
    unresolvedDeadLetters: Number(deadLetters?.count ?? 0),
    oldestDeadLetterAt: deadLetters?.oldest ?? null,
  };
}

export async function findExistingItem(
  db: D1Database,
  sourceId: string,
  externalId: string | undefined,
  contentHash: string,
): Promise<ItemRecord | null> {
  if (externalId) {
    const exact = await db
      .prepare("SELECT * FROM items WHERE source_id = ? AND external_id = ? AND content_hash = ?")
      .bind(sourceId, externalId, contentHash)
      .first<ItemRecord>();
    if (exact) return exact;
  }
  return db
    .prepare("SELECT * FROM items WHERE source_id = ? AND content_hash = ?")
    .bind(sourceId, contentHash)
    .first<ItemRecord>();
}

function insertItemStatement(db: D1Database, item: ItemRecord): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO items(
        id, source_id, external_id, url, canonical_url, title, text, author,
        published_at, observed_at, content_hash, raw_r2_key, access_class,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      item.id,
      item.source_id,
      item.external_id,
      item.url,
      item.canonical_url,
      item.title,
      item.text,
      item.author,
      item.published_at,
      item.observed_at,
      item.content_hash,
      item.raw_r2_key,
      item.access_class,
      item.metadata_json,
      item.created_at,
    );
}

export async function insertItem(db: D1Database, item: ItemRecord): Promise<void> {
  await insertItemStatement(db, item).run();
}

/**
 * The item and its resumable ingest state must become visible together. D1
 * batches are transactions, so a failed second statement cannot expose an
 * item that the consumer would incorrectly treat as a terminal duplicate.
 */
export async function insertItemWithIngestCompletion(
  db: D1Database,
  item: ItemRecord,
  originKeyHash: string | null,
): Promise<void> {
  const now = isoNow();
  await db.batch([
    insertItemStatement(db, item),
    db
      .prepare(
        `INSERT INTO item_ingest_completions(
           item_id, origin_key_hash, stage, started_at, updated_at
         ) VALUES (?, ?, 0, ?, ?)`,
      )
      .bind(item.id, originKeyHash, now, now),
  ]);
}

export async function getItemIngestCompletion(
  db: D1Database,
  itemId: string,
): Promise<ItemIngestCompletionRecord | null> {
  return db
    .prepare("SELECT * FROM item_ingest_completions WHERE item_id = ?")
    .bind(itemId)
    .first<ItemIngestCompletionRecord>();
}

/** Lazily enrolls legacy items without claiming that the current delivery inserted them. */
export async function ensureItemIngestCompletion(
  db: D1Database,
  itemId: string,
): Promise<ItemIngestCompletionRecord> {
  const now = isoNow();
  await db
    .prepare(
      `INSERT OR IGNORE INTO item_ingest_completions(
         item_id, origin_key_hash, story_id, stage, started_at, updated_at
       )
       SELECT i.id, NULL,
              (SELECT si.story_id FROM story_items si
               WHERE si.item_id = i.id ORDER BY si.created_at ASC LIMIT 1),
              CASE
                WHEN EXISTS (SELECT 1 FROM story_items si WHERE si.item_id = i.id) THEN
                  CASE
                    WHEN EXISTS (SELECT 1 FROM evidence_lineage el WHERE el.item_id = i.id)
                      OR COALESCE((SELECT value FROM settings WHERE key = 'evidence_lineage_enabled'), '1') = '0'
                    THEN 2 ELSE 1
                  END
                ELSE 0
              END,
              ?, ?
       FROM items i WHERE i.id = ?`,
    )
    .bind(now, now, itemId)
    .run();
  const completion = await getItemIngestCompletion(db, itemId);
  if (!completion) throw new Error(`Unable to initialize ingest completion state for ${itemId}`);
  return completion;
}

export async function claimItemIngestCompletion(
  db: D1Database,
  itemId: string,
  leaseToken: string,
  leaseMilliseconds = 45_000,
): Promise<boolean> {
  const now = isoNow();
  const leaseExpiresAt = new Date(Date.now() + Math.max(5_000, leaseMilliseconds)).toISOString();
  const result = await db
    .prepare(
      `UPDATE item_ingest_completions
       SET lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE item_id = ? AND completed_at IS NULL
         AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    )
    .bind(leaseToken, leaseExpiresAt, now, itemId, now)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function renewItemIngestCompletionLease(
  db: D1Database,
  itemId: string,
  leaseToken: string,
  leaseMilliseconds = 45_000,
): Promise<void> {
  const now = isoNow();
  const leaseExpiresAt = new Date(Date.now() + Math.max(5_000, leaseMilliseconds)).toISOString();
  const result = await db
    .prepare(
      `UPDATE item_ingest_completions
       SET lease_expires_at = ?, updated_at = ?
       WHERE item_id = ? AND lease_token = ? AND completed_at IS NULL`,
    )
    .bind(leaseExpiresAt, now, itemId, leaseToken)
    .run();
  if (Number(result.meta.changes ?? 0) === 0) {
    throw new Error(`Lost ingest completion lease for ${itemId}`);
  }
}

export async function advanceItemIngestCompletion(
  db: D1Database,
  input: {
    itemId: string;
    leaseToken: string;
    stage: Exclude<ItemIngestStage, 0 | 4>;
    storyId?: string;
  },
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE item_ingest_completions
       SET stage = MAX(stage, ?), story_id = COALESCE(?, story_id), updated_at = ?
       WHERE item_id = ? AND lease_token = ? AND completed_at IS NULL`,
    )
    .bind(input.stage, input.storyId ?? null, isoNow(), input.itemId, input.leaseToken)
    .run();
  if (Number(result.meta.changes ?? 0) === 0) {
    throw new Error(`Lost ingest completion lease for ${input.itemId}`);
  }
}

export async function completeItemIngest(
  db: D1Database,
  itemId: string,
  leaseToken: string,
): Promise<void> {
  const now = isoNow();
  const result = await db
    .prepare(
      `UPDATE item_ingest_completions
       SET stage = 4, completed_at = COALESCE(completed_at, ?), updated_at = ?,
           lease_token = NULL, lease_expires_at = NULL
       WHERE item_id = ? AND lease_token = ? AND completed_at IS NULL`,
    )
    .bind(now, now, itemId, leaseToken)
    .run();
  if (Number(result.meta.changes ?? 0) === 0) {
    throw new Error(`Lost ingest completion lease for ${itemId}`);
  }
}

export async function releaseItemIngestCompletionLease(
  db: D1Database,
  itemId: string,
  leaseToken: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE item_ingest_completions
       SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE item_id = ? AND lease_token = ? AND completed_at IS NULL`,
    )
    .bind(isoNow(), itemId, leaseToken)
    .run();
}

export async function findStoryForItem(db: D1Database, itemId: string): Promise<StoryRecord | null> {
  return db
    .prepare(
      `SELECT s.* FROM story_items si
       JOIN stories s ON s.id = si.story_id
       WHERE si.item_id = ?
       ORDER BY si.created_at ASC LIMIT 1`,
    )
    .bind(itemId)
    .first<StoryRecord>();
}

export async function getStoryRecord(db: D1Database, storyId: string): Promise<StoryRecord | null> {
  return db.prepare("SELECT * FROM stories WHERE id = ?").bind(storyId).first<StoryRecord>();
}

export async function recentStories(db: D1Database, since: string, limit = 250): Promise<StoryRecord[]> {
  return rows(
    await db
      .prepare("SELECT * FROM stories WHERE last_changed_at >= ? ORDER BY last_changed_at DESC LIMIT ?")
      .bind(since, Math.max(1, Math.min(500, limit)))
      .all<StoryRecord>(),
  );
}

function insertStoryStatement(db: D1Database, story: StoryRecord): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO stories(
        id, canonical_key, title, summary, status, first_seen_at, last_changed_at,
        score, relevance, novelty, importance, confidence, source_count,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      story.id,
      story.canonical_key,
      story.title,
      story.summary,
      story.status,
      story.first_seen_at,
      story.last_changed_at,
      story.score,
      story.relevance,
      story.novelty,
      story.importance,
      story.confidence,
      story.source_count,
      story.metadata_json,
      story.created_at,
      story.updated_at,
    );
}

export async function insertStory(db: D1Database, story: StoryRecord): Promise<void> {
  await insertStoryStatement(db, story).run();
}

function linkStoryItemStatement(db: D1Database, storyId: string, itemId: string): D1PreparedStatement {
  return db
    .prepare("INSERT OR IGNORE INTO story_items(story_id, item_id, relationship) VALUES (?, ?, 'coverage')")
    .bind(storyId, itemId);
}

export async function linkStoryItem(db: D1Database, storyId: string, itemId: string): Promise<void> {
  await linkStoryItemStatement(db, storyId, itemId).run();
}

export async function countStorySources(db: D1Database, storyId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT i.source_id) AS count
       FROM story_items si
       JOIN items i ON i.id = si.item_id
       WHERE si.story_id = ?`,
    )
    .bind(storyId)
    .first<{ count: number }>();
  return Math.max(1, Number(row?.count ?? 1));
}

export async function countStorySourcesIncluding(
  db: D1Database,
  storyId: string,
  sourceId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM (
         SELECT DISTINCT i.source_id
         FROM story_items si
         JOIN items i ON i.id = si.item_id
         WHERE si.story_id = ?
         UNION SELECT ?
       )`,
    )
    .bind(storyId, sourceId)
    .first<{ count: number }>();
  return Math.max(1, Number(row?.count ?? 1));
}

interface StoryIngestUpdate {
  storyId: string;
  title: string;
  summary: string;
  changedAt: string;
  relevance: number;
  novelty: number;
  importance: number;
  confidence: number;
  score: number;
}

function updateStoryAfterItemStatement(db: D1Database, input: StoryIngestUpdate): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE stories SET
        title = CASE WHEN length(?) > length(title) THEN ? ELSE title END,
        summary = CASE
          WHEN ? >= last_changed_at AND trim(?) <> '' THEN ?
          ELSE summary
        END,
        last_changed_at = MAX(last_changed_at, ?),
        relevance = MAX(relevance, ?),
        novelty = ?,
        importance = MAX(importance, ?),
        confidence = MAX(confidence, ?),
        score = ?,
        source_count = (
          SELECT COUNT(DISTINCT i.source_id)
          FROM story_items si JOIN items i ON i.id = si.item_id
          WHERE si.story_id = stories.id
        ),
        updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.title,
      input.title,
      input.changedAt,
      input.summary,
      input.summary,
      input.changedAt,
      input.relevance,
      input.novelty,
      input.importance,
      input.confidence,
      input.score,
      isoNow(),
      input.storyId,
    );
}

export async function updateStoryAfterItem(
  db: D1Database,
  input: StoryIngestUpdate,
): Promise<void> {
  await updateStoryAfterItemStatement(db, input).run();
}

/** Commits the only non-repeatable ingest stage (new Story creation) atomically. */
export async function commitItemStoryIngestStage(
  db: D1Database,
  input: {
    itemId: string;
    leaseToken: string;
    story: StoryRecord;
    createStory: boolean;
    update?: StoryIngestUpdate;
  },
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (input.createStory) statements.push(insertStoryStatement(db, input.story));
  statements.push(linkStoryItemStatement(db, input.story.id, input.itemId));
  if (input.update) statements.push(updateStoryAfterItemStatement(db, input.update));
  statements.push(
    db
      .prepare(
        `UPDATE item_ingest_completions
         SET stage = MAX(stage, 1), story_id = ?, updated_at = ?
         WHERE item_id = ? AND lease_token = ? AND completed_at IS NULL`,
      )
      .bind(input.story.id, isoNow(), input.itemId, input.leaseToken),
  );
  const results = await db.batch(statements);
  if (Number(results.at(-1)?.meta.changes ?? 0) === 0) {
    throw new Error(`Lost ingest completion lease for ${input.itemId}`);
  }
}

export async function findStoryByCanonicalUrl(db: D1Database, canonicalUrl: string): Promise<StoryRecord | null> {
  return db
    .prepare(
      `SELECT s.* FROM stories s
       JOIN story_items si ON si.story_id = s.id
       JOIN items i ON i.id = si.item_id
       WHERE i.canonical_url = ?
       ORDER BY s.last_changed_at DESC LIMIT 1`,
    )
    .bind(canonicalUrl)
    .first<StoryRecord>();
}

export async function findStoryByCanonicalKey(db: D1Database, key: string): Promise<StoryRecord | null> {
  return db
    .prepare("SELECT * FROM stories WHERE canonical_key = ? ORDER BY last_changed_at DESC LIMIT 1")
    .bind(key)
    .first<StoryRecord>();
}

export async function searchStories(
  db: D1Database,
  query: string,
  limit = 20,
): Promise<Array<StoryRecord & { evidence_count: number; url: string | null }>> {
  const escaped = query.replace(/[\\%_]/g, "\\$&");
  const pattern = `%${escaped}%`;
  return rows(
    await db
      .prepare(
        `SELECT s.*, COUNT(si.item_id) AS evidence_count,
                (SELECT COALESCE(i2.canonical_url, i2.url)
                 FROM story_items si2
                 JOIN items i2 ON i2.id = si2.item_id
                 WHERE si2.story_id = s.id
                   AND COALESCE(i2.canonical_url, i2.url) IS NOT NULL
                 ORDER BY CASE WHEN i2.access_class = 'public' THEN 0 ELSE 1 END,
                          i2.observed_at DESC
                 LIMIT 1) AS url
         FROM stories s
         LEFT JOIN story_items si ON si.story_id = s.id
         WHERE s.title LIKE ? ESCAPE '\\' OR s.summary LIKE ? ESCAPE '\\'
         GROUP BY s.id
         ORDER BY s.score DESC, s.last_changed_at DESC
         LIMIT ?`,
      )
      .bind(pattern, pattern, Math.max(1, Math.min(100, limit)))
      .all<StoryRecord & { evidence_count: number; url: string | null }>(),
  );
}

/**
 * Search the public evidence edge instead of the aggregate Story row. Aggregate
 * Story text and ranking fields may have been updated by authenticated or local
 * evidence and therefore are not safe inputs to the compact/open MCP search.
 */
export interface PublicStorySearchCandidate {
  story_id: string;
  title: string;
  canonical_url: string | null;
  url: string | null;
  public_changed_at: string;
  evidence_rank: number;
}

export async function searchPublicStoryCandidates(
  db: D1Database,
  query: string,
  limit = 20,
): Promise<PublicStorySearchCandidate[]> {
  const escaped = query.replace(/[\\%_]/g, "\\$&");
  const pattern = `%${escaped}%`;
  const storyLimit = Math.max(1, Math.min(100, limit));
  const evidencePerStory = 4;
  return rows(await db
    .prepare(
      `WITH matching_stories AS (
         SELECT si.story_id,
                MAX(COALESCE(i.published_at, i.observed_at)) AS public_changed_at
         FROM story_items si
         JOIN items i ON i.id = si.item_id
         JOIN sources source ON source.id = i.source_id
         WHERE i.access_class = 'public'
           AND source.kind NOT IN ('email', 'collector')
           AND (NULLIF(TRIM(i.canonical_url), '') IS NOT NULL
                OR NULLIF(TRIM(i.url), '') IS NOT NULL)
           AND (i.title LIKE ? ESCAPE '\\' OR i.text LIKE ? ESCAPE '\\')
         GROUP BY si.story_id
         ORDER BY public_changed_at DESC, si.story_id ASC
         LIMIT ?
       ), ranked AS (
         SELECT matching.story_id, i.title, i.canonical_url, i.url,
                matching.public_changed_at,
                ROW_NUMBER() OVER (
                  PARTITION BY matching.story_id
                  ORDER BY COALESCE(i.published_at, i.observed_at) DESC,
                           i.observed_at DESC, i.id ASC
                ) AS evidence_rank
         FROM matching_stories matching
         JOIN story_items si ON si.story_id = matching.story_id
         JOIN items i ON i.id = si.item_id
         JOIN sources source ON source.id = i.source_id
         WHERE i.access_class = 'public'
           AND source.kind NOT IN ('email', 'collector')
           AND (NULLIF(TRIM(i.canonical_url), '') IS NOT NULL
                OR NULLIF(TRIM(i.url), '') IS NOT NULL)
       )
       SELECT story_id, title, canonical_url, url, public_changed_at, evidence_rank
       FROM ranked
       WHERE evidence_rank <= ?
       ORDER BY public_changed_at DESC, story_id ASC, evidence_rank ASC`,
    )
    .bind(pattern, pattern, storyLimit, evidencePerStory)
    .all<PublicStorySearchCandidate>());
}

export async function latestStories(db: D1Database, limit = 20): Promise<StoryRecord[]> {
  return rows(
    await db
      .prepare("SELECT * FROM stories ORDER BY score DESC, last_changed_at DESC LIMIT ?")
      .bind(Math.max(1, Math.min(100, limit)))
      .all<StoryRecord>(),
  );
}

/**
 * Mission rebuilds intentionally use a wider window than interactive Story
 * lists. Keep the order fully deterministic so a score/time tie cannot move a
 * Story across the rebuild boundary between identical runs.
 */
export async function listMissionMatchCandidateStories(
  db: D1Database,
  limit = 501,
): Promise<Array<Pick<StoryRecord, "id">>> {
  return rows(
    await db
      .prepare(
        `SELECT id FROM stories
         ORDER BY score DESC, last_changed_at DESC, id ASC
         LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(501, limit)))
      .all<Pick<StoryRecord, "id">>(),
  );
}

export async function listMissionMatchStoryProjections(
  db: D1Database,
  storyIds: string[],
): Promise<Array<Pick<StoryRecord, "id" | "title" | "summary">>> {
  const ids = [...new Set(storyIds)];
  if (!ids.length) return [];
  if (ids.length > MISSION_MATCH_EXCERPT_STORY_PAGE_LIMIT) {
    throw new Error(`Mission Story projection page exceeds ${MISSION_MATCH_EXCERPT_STORY_PAGE_LIMIT} Stories`);
  }
  return rows(
    await db
      .prepare(
        `WITH requested(story_id, story_order) AS (
           SELECT CAST(value AS TEXT), CAST(key AS INTEGER) FROM json_each(?)
         )
         SELECT stories.id, substr(stories.title, 1, 300) AS title,
                substr(stories.summary, 1, 700) AS summary
         FROM requested
         JOIN stories ON stories.id = requested.story_id
         ORDER BY requested.story_order ASC`,
      )
      .bind(JSON.stringify(ids))
      .all<Pick<StoryRecord, "id" | "title" | "summary">>(),
  );
}

export interface MissionMatchEvidenceExcerptRow {
  story_id: string;
  item_id: string;
  source_id: string;
  source_kind: string | null;
  title: string;
  text: string;
  body_truncated: number;
  has_additional: number;
}

export interface MissionMatchEvidenceExcerptResult {
  evidence: MissionMatchEvidenceExcerptRow[];
  hasAdditionalEvidence: boolean;
}

export const MISSION_MATCH_EXCERPT_STORY_PAGE_LIMIT = 6;
export const MISSION_MATCH_EXCERPT_EVIDENCE_PER_STORY_LIMIT = 8;
export const MISSION_MATCH_EXCERPT_TITLE_CHARACTERS = 300;
export const MISSION_MATCH_EXCERPT_BODY_CHARACTERS = 192;

/**
 * Return a finite, deterministic evidence projection for Mission matching.
 * Ranking is materialized before body excerpts are read, so D1 only touches
 * large text for the selected rows. Character limits imply a four-times-larger
 * worst-case UTF-8 byte bound and preserve valid Unicode for the JS tokenizer.
 */
export async function listMissionMatchEvidenceExcerpts(
  db: D1Database,
  input: {
    storyId: string;
    evidencePerStory: number;
    titleCharacters: number;
    bodyCharacters: number;
  },
): Promise<MissionMatchEvidenceExcerptResult> {
  const evidencePerStory = Math.max(1, Math.min(
    MISSION_MATCH_EXCERPT_EVIDENCE_PER_STORY_LIMIT,
    Math.floor(input.evidencePerStory),
  ));
  const titleCharacters = Math.max(1, Math.min(
    MISSION_MATCH_EXCERPT_TITLE_CHARACTERS,
    Math.floor(input.titleCharacters),
  ));
  const bodyCharacters = Math.max(1, Math.min(
    MISSION_MATCH_EXCERPT_BODY_CHARACTERS,
    Math.floor(input.bodyCharacters),
  ));
  const selected = rows(
    await db
      .prepare(
        `WITH selected AS MATERIALIZED (
           SELECT si.item_id, si.created_at
           FROM story_items si INDEXED BY idx_story_items_match_recent
           WHERE si.story_id = ?
           ORDER BY si.created_at DESC, si.item_id ASC
           LIMIT ?
         ), ranked AS MATERIALIZED (
           SELECT selected.item_id,
                  ROW_NUMBER() OVER (ORDER BY selected.created_at DESC, selected.item_id ASC) AS evidence_rank
           FROM selected
         )
         SELECT ? AS story_id, substr(ranked.item_id, 1, 256) AS item_id,
                substr(item.source_id, 1, 200) AS source_id,
                substr(source.kind, 1, 200) AS source_kind,
                substr(item.title, 1, ?) AS title,
                substr(item.text, 1, ?) AS text,
                CASE WHEN length(substr(item.text, 1, ?)) > ? THEN 1 ELSE 0 END AS body_truncated,
                EXISTS(
                  SELECT 1
                  FROM story_items sentinel INDEXED BY idx_story_items_match_recent
                  WHERE sentinel.story_id = ?
                  ORDER BY sentinel.created_at DESC, sentinel.item_id ASC
                  LIMIT 1 OFFSET ?
                ) AS has_additional
         FROM ranked
         JOIN items item ON item.id = ranked.item_id
         JOIN sources source ON source.id = item.source_id
         WHERE ranked.evidence_rank <= ?
         ORDER BY ranked.evidence_rank ASC`,
      )
      .bind(
        input.storyId,
        evidencePerStory,
        input.storyId,
        titleCharacters,
        bodyCharacters,
        bodyCharacters + 1,
        bodyCharacters,
        input.storyId,
        evidencePerStory,
        evidencePerStory,
      )
      .all<MissionMatchEvidenceExcerptRow>(),
  );
  return {
    evidence: selected,
    hasAdditionalEvidence: Boolean(selected[0]?.has_additional),
  };
}

export async function getStory(
  db: D1Database,
  storyId: string,
): Promise<{
  story: StoryRecord;
  evidence: Array<ItemRecord & {
    source_name: string;
    source_kind: string;
    source_health_score: number;
    family_key: string | null;
    lineage_relation: string | null;
    lineage_independent: number | null;
  }>;
} | null> {
  const story = await db.prepare("SELECT * FROM stories WHERE id = ?").bind(storyId).first<StoryRecord>();
  if (!story) return null;
  const evidence = rows(
    await db
      .prepare(
        `SELECT i.*, s.name AS source_name, s.kind AS source_kind, s.health_score AS source_health_score,
                el.family_key, el.relation AS lineage_relation, el.independent AS lineage_independent
         FROM story_items si
         JOIN items i ON i.id = si.item_id
         JOIN sources s ON s.id = i.source_id
         LEFT JOIN evidence_lineage el ON el.item_id = i.id
         WHERE si.story_id = ?
         ORDER BY COALESCE(i.published_at, i.observed_at) DESC`,
      )
      .bind(storyId)
      .all<ItemRecord & {
        source_name: string;
        source_kind: string;
        source_health_score: number;
        family_key: string | null;
        lineage_relation: string | null;
        lineage_independent: number | null;
      }>(),
  );
  return { story, evidence };
}

export async function listBriefingStoryEvidence(
  db: D1Database,
  storyIds: string[],
  previousBriefingAt?: string,
  limitPerStory = 8,
): Promise<Array<{
  story_id: string;
  id: string;
  source_name: string;
  source_kind: string;
  title: string;
  url: string | null;
  author: string | null;
  published_at: string | null;
  observed_at: string;
  text: string;
  access_class: string;
  metadata_json: string;
  family_key: string | null;
  source_relationship: string | null;
  lineage_independent: number | null;
  new_evidence_count: number;
}>> {
  const ids = [...new Set(storyIds)].slice(0, 30);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return rows(
    await db
      .prepare(
        `WITH ranked AS (
           SELECT si.story_id, i.id, s.name AS source_name, s.kind AS source_kind, i.title,
                  COALESCE(i.canonical_url, i.url) AS url, i.author,
                  i.published_at, i.observed_at, i.text, i.access_class, i.metadata_json,
                  el.family_key, el.relation AS source_relationship,
                  el.independent AS lineage_independent,
                  SUM(CASE WHEN ? IS NULL OR datetime(i.observed_at) > datetime(?) THEN 1 ELSE 0 END)
                    OVER (PARTITION BY si.story_id) AS new_evidence_count,
                  ROW_NUMBER() OVER (
                    PARTITION BY si.story_id
                    ORDER BY ${PUBLIC_EVIDENCE_LOW_SIGNAL_SQL} ASC,
                             COALESCE(NULLIF(TRIM(i.published_at), ''), i.observed_at) DESC,
                             i.observed_at DESC, i.id
                  ) AS evidence_rank
           FROM story_items si
           JOIN items i ON i.id = si.item_id
           JOIN sources s ON s.id = i.source_id
           LEFT JOIN evidence_lineage el ON el.item_id = i.id
           WHERE si.story_id IN (${placeholders})
         )
         SELECT story_id, id, source_name, source_kind, title, url, author, published_at,
                observed_at, text, access_class, metadata_json, family_key,
                source_relationship, lineage_independent, new_evidence_count
         FROM ranked
         WHERE evidence_rank <= ?
         ORDER BY story_id, evidence_rank`,
      )
      .bind(previousBriefingAt ?? null, previousBriefingAt ?? null, ...ids, Math.max(1, Math.min(20, limitPerStory)))
      .all(),
  ) as Array<any>;
}

export async function storiesForBriefing(db: D1Database, since: string, limit: number): Promise<StoryRecord[]> {
  return rows(
    await db
      .prepare(
        `SELECT s.* FROM stories s
         WHERE s.last_changed_at >= ?
           AND NOT EXISTS (
             SELECT 1 FROM feedback f
             WHERE f.story_id = s.id AND f.action = 'mute'
           )
         ORDER BY (
           s.score
           + CASE WHEN EXISTS (SELECT 1 FROM feedback f WHERE f.story_id = s.id AND f.action = 'track') THEN 12 ELSE 0 END
           + CASE WHEN EXISTS (SELECT 1 FROM feedback f WHERE f.story_id = s.id AND f.action = 'more') THEN 8 ELSE 0 END
           - CASE WHEN EXISTS (SELECT 1 FROM feedback f WHERE f.story_id = s.id AND f.action = 'less') THEN 12 ELSE 0 END
           - CASE WHEN EXISTS (SELECT 1 FROM feedback f WHERE f.story_id = s.id AND f.action = 'already-knew') THEN 10 ELSE 0 END
           - CASE WHEN EXISTS (SELECT 1 FROM feedback f WHERE f.story_id = s.id AND f.action = 'bad-source') THEN 8 ELSE 0 END
           - CASE WHEN EXISTS (SELECT 1 FROM feedback f WHERE f.story_id = s.id AND f.action = 'wrong') THEN 18 ELSE 0 END
         ) DESC, s.last_changed_at DESC
         LIMIT ?`,
      )
      .bind(since, Math.max(1, Math.min(30, limit)))
      .all<StoryRecord>(),
  );
}

export async function insertBriefing(
  db: D1Database,
  input: { id: string; periodStart: string; periodEnd: string; packet: BriefingPacket; markdown: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO briefings(id, period_start, period_end, status, packet_json, markdown, created_at)
       VALUES (?, ?, ?, 'complete', ?, ?, ?)`,
    )
    .bind(input.id, input.periodStart, input.periodEnd, JSON.stringify(input.packet), input.markdown, isoNow())
    .run();
}

export async function latestBriefing(
  db: D1Database,
): Promise<{
  id: string;
  period_start: string;
  period_end: string;
  packet: BriefingPacket;
  markdown: string;
  created_at: string;
} | null> {
  const row = await db
    .prepare(
      `SELECT id, period_start, period_end, packet_json, markdown, created_at
       FROM briefings WHERE status = 'complete'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .first<{
      id: string;
      period_start: string;
      period_end: string;
      packet_json: string;
      markdown: string;
      created_at: string;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    period_start: row.period_start,
    period_end: row.period_end,
    packet: parseJson<BriefingPacket>(row.packet_json, {
      schemaVersion: "1",
      generatedAt: row.created_at,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      coverage: { healthySources: 0, degradedSources: 0, offlineCollectors: 0, notes: [] },
      calibration: [],
      missions: [],
      actions: [],
      resolvedMissions: [],
      stories: [],
    }),
    markdown: row.markdown,
    created_at: row.created_at,
  };
}

export async function recordFeedback(
  db: D1Database,
  input: { storyId?: string; action: string; note?: string },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO feedback(id, story_id, action, note, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, input.storyId ?? null, input.action, input.note ?? null, isoNow())
    .run();
  return id;
}

export async function listRecentFeedback(db: D1Database, limit = 100): Promise<Array<Record<string, unknown>>> {
  return rows(
    await db
      .prepare(
        `SELECT f.id, f.story_id, f.action, f.note, f.created_at, s.title AS story_title
         FROM feedback f LEFT JOIN stories s ON s.id = f.story_id
         ORDER BY f.created_at DESC LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(500, limit)))
      .all<Record<string, unknown>>(),
  );
}


export async function listStoryFeedback(db: D1Database, storyId: string): Promise<Array<Record<string, unknown>>> {
  return rows(
    await db
      .prepare(
        `SELECT id, story_id, action, note, created_at
         FROM feedback WHERE story_id = ? ORDER BY created_at DESC LIMIT 100`,
      )
      .bind(storyId)
      .all<Record<string, unknown>>(),
  );
}

export async function listStoryMissionMatches(db: D1Database, storyId: string): Promise<Array<Record<string, unknown>>> {
  return rows(
    await db
      .prepare(
        `SELECT m.id, m.name, m.question, msm.match_score, msm.matched_terms_json,
          msm.first_matched_at, msm.last_matched_at
         FROM mission_story_matches msm
         JOIN missions m ON m.id = msm.mission_id
         WHERE msm.story_id = ?
         ORDER BY msm.match_score DESC, msm.last_matched_at DESC`,
      )
      .bind(storyId)
      .all<Record<string, unknown>>(),
  );
}

export async function recordTasteTermSignals(
  db: D1Database,
  input: { storyId: string; signals: Array<{ term: string; delta: number }> },
): Promise<void> {
  const now = isoNow();
  const statements = input.signals
    .filter((signal) => signal.term.trim() && Number.isFinite(signal.delta) && signal.delta !== 0)
    .slice(0, 40)
    .map((signal) => db
      .prepare(
        `INSERT INTO taste_terms(term, weight, positive_count, negative_count, last_story_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(term) DO UPDATE SET
           weight = MAX(-3.0, MIN(3.0, taste_terms.weight * 0.995 + excluded.weight)),
           positive_count = taste_terms.positive_count + excluded.positive_count,
           negative_count = taste_terms.negative_count + excluded.negative_count,
           last_story_id = excluded.last_story_id,
           updated_at = excluded.updated_at`,
      )
      .bind(
        signal.term.trim().toLowerCase().slice(0, 120),
        Math.max(-1, Math.min(1, signal.delta)),
        signal.delta > 0 ? 1 : 0,
        signal.delta < 0 ? 1 : 0,
        input.storyId,
        now,
      ));
  if (statements.length) await db.batch(statements);
}

export async function recordTasteSourceSignals(
  db: D1Database,
  signals: Array<{ sourceId: string; delta: number }>,
): Promise<void> {
  const now = isoNow();
  const statements = signals
    .filter((signal) => signal.sourceId && Number.isFinite(signal.delta) && signal.delta !== 0)
    .slice(0, 20)
    .map((signal) => db
      .prepare(
        `INSERT INTO taste_sources(source_id, weight, positive_count, negative_count, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           weight = MAX(-2.0, MIN(2.0, taste_sources.weight * 0.995 + excluded.weight)),
           positive_count = taste_sources.positive_count + excluded.positive_count,
           negative_count = taste_sources.negative_count + excluded.negative_count,
           updated_at = excluded.updated_at`,
      )
      .bind(
        signal.sourceId,
        Math.max(-1, Math.min(1, signal.delta)),
        signal.delta > 0 ? 1 : 0,
        signal.delta < 0 ? 1 : 0,
        now,
      ));
  if (statements.length) await db.batch(statements);
}

export async function listTasteTerms(db: D1Database, limit = 120): Promise<TasteTermRecord[]> {
  return rows(
    await db
      .prepare(
        `SELECT term, weight, positive_count, negative_count, last_story_id, updated_at
         FROM taste_terms WHERE ABS(weight) >= 0.04
         ORDER BY ABS(weight) DESC, updated_at DESC LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(500, limit)))
      .all<TasteTermRecord>(),
  );
}

export async function listTasteSources(db: D1Database, limit = 80): Promise<TasteSourceRecord[]> {
  return rows(
    await db
      .prepare(
        `SELECT ts.source_id, s.name AS source_name, s.kind AS source_kind,
          ts.weight, ts.positive_count, ts.negative_count, ts.updated_at
         FROM taste_sources ts JOIN sources s ON s.id = ts.source_id
         WHERE ABS(ts.weight) >= 0.04
         ORDER BY ABS(ts.weight) DESC, ts.updated_at DESC LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(500, limit)))
      .all<TasteSourceRecord>(),
  );
}

export async function clearTasteProfile(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM taste_terms"),
    db.prepare("DELETE FROM taste_sources"),
  ]);
}

export async function createPairingCode(
  db: D1Database,
  input: { codeHash: string; name: string; expiresAt: string },
): Promise<void> {
  await purgeExpiredPairingCodes(db);
  await db
    .prepare(
      `INSERT INTO pairing_codes(code_hash, name, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(input.codeHash, input.name, input.expiresAt, isoNow())
    .run();
}

export async function consumePairingCode(db: D1Database, codeHash: string): Promise<{ name: string } | null> {
  const row = await db
    .prepare(
      `SELECT name FROM pairing_codes
       WHERE code_hash = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')`,
    )
    .bind(codeHash)
    .first<{ name: string }>();
  if (!row) return null;
  const result = await db
    .prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL")
    .bind(isoNow(), codeHash)
    .run();
  return (result.meta?.changes ?? 0) > 0 ? row : null;
}

export async function purgeExpiredPairingCodes(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM pairing_codes WHERE used_at IS NOT NULL OR datetime(expires_at) < datetime('now')")
    .run();
}

export async function createCollector(
  db: D1Database,
  input: { name: string; tokenHash: string; capabilities: string[] },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO collectors(id, name, token_hash, capabilities_json, status, created_at)
       VALUES (?, ?, ?, ?, 'offline', ?)`,
    )
    .bind(id, input.name, input.tokenHash, JSON.stringify(input.capabilities), isoNow())
    .run();
  return id;
}

export async function getCollectorByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<{ id: string; name: string; capabilities_json: string; status: string } | null> {
  return db
    .prepare("SELECT id, name, capabilities_json, status FROM collectors WHERE token_hash = ?")
    .bind(tokenHash)
    .first();
}

export async function heartbeatCollector(
  db: D1Database,
  input: { collectorId: string; version?: string; capabilities?: string[]; details?: Record<string, unknown> },
): Promise<void> {
  await db
    .prepare(
      `UPDATE collectors SET
        status = 'online', last_seen_at = ?, version = COALESCE(?, version),
        capabilities_json = COALESCE(?, capabilities_json), details_json = COALESCE(?, details_json)
       WHERE id = ?`,
    )
    .bind(
      isoNow(),
      input.version ?? null,
      input.capabilities ? JSON.stringify(input.capabilities) : null,
      input.details === undefined ? null : JSON.stringify(input.details),
      input.collectorId,
    )
    .run();
}

async function supersedeCollectorSourceRun(
  db: D1Database,
  input: {
    sourceId: string;
    sourceRunId: string;
    canonicalSourceRunId: string;
    jobId: string;
    operation: string;
  },
): Promise<boolean> {
  if (input.sourceRunId === input.canonicalSourceRunId) return false;
  const now = isoNow();
  const result = await db
    .prepare(
      `UPDATE source_runs SET
         finished_at = ?, collection_finished_at = COALESCE(collection_finished_at, ?),
         status = 'pending', item_count = 0, enqueued_count = 0,
         provider = COALESCE(provider, 'driftglass-relay'),
         details_json = ?, ingest_updated_at = ?
       WHERE id = ? AND source_id = ?
         AND status IN ('running', 'queued')
         AND finished_at IS NULL
         AND terminal_accounted_at IS NULL`,
    )
    .bind(
      now,
      now,
      JSON.stringify({
        superseded: true,
        canonicalSourceRunId: input.canonicalSourceRunId,
        existingJobId: input.jobId,
        operation: input.operation,
      }),
      now,
      input.sourceRunId,
      input.sourceId,
    )
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function queueCollectorJob(
  db: D1Database,
  input: { sourceId: string; sourceRunId: string; operation: string; args: Record<string, unknown>; collectorId?: string },
): Promise<{ id: string; created: boolean; attached: boolean; sourceRunId: string; superseded: boolean }> {
  const existing = await db
    .prepare(
      `SELECT id, source_run_id FROM collector_jobs
       WHERE source_id = ? AND operation = ? AND status IN ('queued', 'leased')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(input.sourceId, input.operation)
    .first<{ id: string; source_run_id: string | null }>();
  if (existing?.source_run_id) {
    const superseded = await supersedeCollectorSourceRun(db, {
      sourceId: input.sourceId,
      sourceRunId: input.sourceRunId,
      canonicalSourceRunId: existing.source_run_id,
      jobId: existing.id,
      operation: input.operation,
    });
    return { id: existing.id, created: false, attached: false, sourceRunId: existing.source_run_id, superseded };
  }
  if (existing) {
    const attached = await db
      .prepare(
        `UPDATE collector_jobs SET source_run_id = ?, updated_at = ?
         WHERE id = ? AND source_run_id IS NULL`,
      )
      .bind(input.sourceRunId, isoNow(), existing.id)
      .run();
    if (Number(attached.meta?.changes ?? 0) === 1) {
      return { id: existing.id, created: false, attached: true, sourceRunId: input.sourceRunId, superseded: false };
    }
    const raced = await db
      .prepare("SELECT source_run_id FROM collector_jobs WHERE id = ?")
      .bind(existing.id)
      .first<{ source_run_id: string | null }>();
    if (raced?.source_run_id) {
      const superseded = await supersedeCollectorSourceRun(db, {
        sourceId: input.sourceId,
        sourceRunId: input.sourceRunId,
        canonicalSourceRunId: raced.source_run_id,
        jobId: existing.id,
        operation: input.operation,
      });
      return { id: existing.id, created: false, attached: false, sourceRunId: raced.source_run_id, superseded };
    }
    throw new Error("Collector job could not be attached to a source run");
  }

  const id = crypto.randomUUID();
  const now = isoNow();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO collector_jobs(
        id, collector_id, source_id, source_run_id, operation, args_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .bind(id, input.collectorId ?? null, input.sourceId, input.sourceRunId, input.operation, JSON.stringify(input.args), now, now)
    .run();
  if (Number(inserted.meta?.changes ?? 0) === 1) {
    return { id, created: true, attached: false, sourceRunId: input.sourceRunId, superseded: false };
  }
  const raced = await db
    .prepare(
      `SELECT id, source_run_id FROM collector_jobs
       WHERE source_id = ? AND operation = ? AND status IN ('queued', 'leased')
       ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(input.sourceId, input.operation)
    .first<{ id: string; source_run_id: string | null }>();
  if (raced?.source_run_id) {
    const superseded = await supersedeCollectorSourceRun(db, {
      sourceId: input.sourceId,
      sourceRunId: input.sourceRunId,
      canonicalSourceRunId: raced.source_run_id,
      jobId: raced.id,
      operation: input.operation,
    });
    return { id: raced.id, created: false, attached: false, sourceRunId: raced.source_run_id, superseded };
  }
  throw new Error("Concurrent collector job could not be resolved");
}

export interface CollectorJobDispatchTransition {
  started: boolean;
  status: string;
  resultJson: string | null;
}

function collectorDispatchIdentity(resultJson: string | null): {
  fingerprint: string;
  attemptId: string;
  attemptStartedAt: string;
  phase: string;
} | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as { dispatch?: Record<string, unknown> };
    const dispatch = parsed?.dispatch;
    if (
      !dispatch
      || typeof dispatch.fingerprint !== "string"
      || typeof dispatch.attemptId !== "string"
      || typeof dispatch.attemptStartedAt !== "string"
      || typeof dispatch.phase !== "string"
    ) return null;
    return {
      fingerprint: dispatch.fingerprint,
      attemptId: dispatch.attemptId,
      attemptStartedAt: dispatch.attemptStartedAt,
      phase: dispatch.phase,
    };
  } catch {
    return null;
  }
}

/**
 * Compare-and-swaps a leased job into a content-free dispatch phase and records
 * the corresponding source-run intent in the same D1 batch. The source-run
 * guard makes terminal evidence state strictly monotonic.
 */
export async function beginCollectorJobDispatch(
  db: D1Database,
  input: {
    jobId: string;
    collectorId: string;
    sourceId: string;
    sourceRunId: string;
    expectedResultJson: string | null;
    resultSummary: CollectorResultSummary;
    details: Record<string, unknown>;
  },
): Promise<CollectorJobDispatchTransition> {
  if (input.resultSummary.dispatch?.phase !== "dispatching") {
    throw new Error("Collector dispatch must begin in the dispatching phase");
  }
  const nextDispatch = input.resultSummary.dispatch;
  if (!Number.isFinite(Date.parse(nextDispatch.attemptStartedAt))) {
    throw new Error("Collector dispatch attempt requires a valid start time");
  }
  const previousDispatch = collectorDispatchIdentity(input.expectedResultJson);
  const previousStartedAt = previousDispatch ? Date.parse(previousDispatch.attemptStartedAt) : Number.NaN;
  const previousMayRetry = previousDispatch?.phase === "retryable"
    || (
      previousDispatch?.phase === "dispatching"
      && Number.isFinite(previousStartedAt)
      && previousStartedAt + COMPANION_DISPATCH_TAKEOVER_MS <= Date.now()
    );
  if (input.expectedResultJson !== null && (
    !previousDispatch
    || !previousMayRetry
    || (previousDispatch.phase !== "retryable" && previousDispatch.fingerprint !== nextDispatch.fingerprint)
    || previousDispatch.attemptId === nextDispatch.attemptId
  )) {
    throw new Error("Collector dispatch retry must own an expired or retryable attempt");
  }
  const count = Math.max(0, Math.floor(input.resultSummary.dispatch.plannedCount));
  const collectionPartial = nextDispatch.collectionPartial;
  const collectionHealthDelta = collectionPartial ? -0.02 : 0.08;
  const now = isoNow();
  const resultJson = JSON.stringify(input.resultSummary);
  const detailsJson = JSON.stringify(input.details);
  const [jobResult] = await db.batch([
    db
      .prepare(
        `UPDATE collector_jobs SET result_json = ?, error = NULL, updated_at = ?
         WHERE id = ? AND collector_id = ? AND source_id = ? AND source_run_id = ?
           AND status = 'leased' AND result_json IS ?
           AND EXISTS (
             SELECT 1 FROM source_runs
             WHERE id = ? AND source_id = ?
               AND status IN ('running', 'queued')
               AND finished_at IS NULL
               AND terminal_accounted_at IS NULL
           )`,
      )
      .bind(
        resultJson,
        now,
        input.jobId,
        input.collectorId,
        input.sourceId,
        input.sourceRunId,
        input.expectedResultJson,
        input.sourceRunId,
        input.sourceId,
      ),
    db
      .prepare(
        `UPDATE source_runs SET
           finished_at = NULL, collection_finished_at = ?, collection_partial = ?,
           collection_health_delta = ?, status = 'queued', item_count = ?,
           enqueued_count = ?, latency_ms = 0, provider = ?, details_json = ?,
           ingest_updated_at = ?, last_ingest_error = NULL
         WHERE id = ? AND source_id = ?
           AND status IN ('running', 'queued')
           AND finished_at IS NULL
           AND terminal_accounted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM collector_jobs
             WHERE id = ? AND collector_id = ? AND status = 'leased' AND result_json = ?
           )`,
      )
      .bind(
        now,
        collectionPartial ? 1 : 0,
        collectionHealthDelta,
        count,
        count,
        input.resultSummary.provider,
        detailsJson,
        now,
        input.sourceRunId,
        input.sourceId,
        input.jobId,
        input.collectorId,
        resultJson,
      ),
  ]);
  if (Number(jobResult?.meta?.changes ?? 0) === 1) {
    return { started: true, status: "leased", resultJson };
  }
  const current = await db
    .prepare("SELECT status, result_json FROM collector_jobs WHERE id = ? AND collector_id = ?")
    .bind(input.jobId, input.collectorId)
    .first<{ status: string; result_json: string | null }>();
  if (!current) throw new HttpError(404, "Job not found");
  return { started: false, status: current.status, resultJson: current.result_json };
}

export async function updateCollectorJobDispatch(
  db: D1Database,
  input: {
    jobId: string;
    collectorId: string;
    expectedResultJson: string;
    resultSummary: CollectorResultSummary;
  },
): Promise<CollectorJobDispatchTransition> {
  if (!input.resultSummary.dispatch || input.resultSummary.dispatch.phase === "dispatching") {
    throw new Error("Collector dispatch update requires an accepted or retryable phase");
  }
  const previousDispatch = collectorDispatchIdentity(input.expectedResultJson);
  if (
    !previousDispatch
    || previousDispatch.phase !== "dispatching"
    || previousDispatch.fingerprint !== input.resultSummary.dispatch.fingerprint
    || previousDispatch.attemptId !== input.resultSummary.dispatch.attemptId
    || previousDispatch.attemptStartedAt !== input.resultSummary.dispatch.attemptStartedAt
  ) {
    throw new Error("Collector dispatch update must finish its current attempt without changing identity");
  }
  const resultJson = JSON.stringify(input.resultSummary);
  const updated = await db
    .prepare(
      `UPDATE collector_jobs SET result_json = ?, updated_at = ?
       WHERE id = ? AND collector_id = ? AND status = 'leased' AND result_json = ?`,
    )
    .bind(resultJson, isoNow(), input.jobId, input.collectorId, input.expectedResultJson)
    .run();
  if (Number(updated.meta?.changes ?? 0) === 1) {
    return { started: true, status: "leased", resultJson };
  }
  const current = await db
    .prepare("SELECT status, result_json FROM collector_jobs WHERE id = ? AND collector_id = ?")
    .bind(input.jobId, input.collectorId)
    .first<{ status: string; result_json: string | null }>();
  if (!current) throw new HttpError(404, "Job not found");
  return { started: false, status: current.status, resultJson: current.result_json };
}

export async function claimCollectorJob(
  db: D1Database,
  collectorId: string,
  capabilities: string[],
): Promise<CollectorJob | null> {
  if (capabilities.length === 0) return null;
  const now = isoNow();
  const lease = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const placeholders = capabilities.map(() => "?").join(", ");
  return db
    .prepare(
      `UPDATE collector_jobs SET
        collector_id = ?, status = 'leased', lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = (
         SELECT id FROM collector_jobs
         WHERE (
           status = 'queued' OR
           (status = 'leased' AND lease_expires_at IS NOT NULL AND datetime(lease_expires_at) < datetime(?))
         )
           AND (collector_id IS NULL OR collector_id = ?)
           AND operation IN (${placeholders})
         ORDER BY created_at ASC
         LIMIT 1
       )
       RETURNING *`,
    )
    .bind(collectorId, lease, now, now, collectorId, ...capabilities)
    .first<CollectorJob>();
}

export async function completeCollectorJob(
  db: D1Database,
  input: { jobId: string; collectorId: string; ok: boolean; resultSummary?: CollectorResultSummary; error?: string; itemCount?: number; provider?: string },
): Promise<{ sourceId: string; operation: string; sourceRunId: string | null; transitioned: boolean }> {
  const job = await db
    .prepare("SELECT collector_id, source_id, source_run_id, operation, status, result_json FROM collector_jobs WHERE id = ?")
    .bind(input.jobId)
    .first<{
      collector_id: string | null;
      source_id: string;
      source_run_id: string | null;
      operation: string;
      status: string;
      result_json: string | null;
    }>();
  if (!job || job.collector_id !== input.collectorId) throw new HttpError(404, "Job not found");
  if (job.status === "complete" || job.status === "failed") {
    return {
      sourceId: job.source_id,
      operation: job.operation,
      sourceRunId: job.source_run_id,
      transitioned: false,
    };
  }
  if (job.status !== "leased") throw new HttpError(409, `Collector job is ${job.status}`);
  if (!input.ok && collectorDispatchIdentity(job.result_json)) {
    throw new HttpError(409, "Collector failure cannot replace an in-progress or accepted result dispatch");
  }
  const now = isoNow();
  const itemCount = Math.max(0, input.itemCount ?? 0);
  const completionId = crypto.randomUUID();
  const resultSummary: CollectorResultSummary = input.resultSummary
    ? { ...input.resultSummary, diagnostics: input.resultSummary.diagnostics ?? {}, completionId }
    : {
      provider: (input.provider ?? "driftglass-relay").slice(0, 200),
      collectedCount: itemCount,
      acceptedCount: itemCount,
      diagnostics: {},
      completionId,
    };
  const collectionPartial = input.ok && (
    resultSummary.dispatch?.collectionPartial === true
    || resultSummary.diagnostics.collectionPartial === true
  );
  const status = input.ok ? (collectionPartial ? "partial" : "success") : "failed";
  const sourceDelta = input.ok ? (collectionPartial ? -0.02 : 0.08) : -0.2;
  const completionError = input.ok
    ? (collectionPartial ? "Source collection completed with partial coverage" : null)
    : input.error ?? "Relay collection failed";
  const durableIngestPending = input.ok && itemCount > 0;
  const resultJson = JSON.stringify(resultSummary);
  const completedJobStatus = input.ok ? "complete" : "failed";
  const statements = [
    db
      .prepare(
        `UPDATE collector_jobs SET
          status = ?, result_json = ?, error = ?, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND collector_id = ? AND status = 'leased' AND result_json IS ?`,
      )
      .bind(
        completedJobStatus,
        resultJson,
        input.error ?? null,
        now,
        input.jobId,
        input.collectorId,
        job.result_json,
      ),
  ];
  if (!durableIngestPending) {
    statements.push(db
      .prepare(
        `UPDATE sources SET
          last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
          last_error = ?,
          health_score = MIN(1.0, MAX(0.0, health_score + ?)),
          updated_at = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM collector_jobs
             WHERE id = ? AND collector_id = ? AND status = ? AND result_json = ?
           )
           AND (
             ? IS NULL OR EXISTS (
               SELECT 1 FROM source_runs
               WHERE id = ? AND source_id = ?
                 AND status IN ('running', 'queued')
                 AND terminal_accounted_at IS NULL
             )
           )`,
      )
      .bind(
        input.ok ? 1 : 0,
        now,
        completionError,
        sourceDelta,
        now,
        job.source_id,
        input.jobId,
        input.collectorId,
        completedJobStatus,
        resultJson,
        job.source_run_id,
        job.source_run_id,
        job.source_id,
      ));
    if (job.source_run_id) statements.push(db
      .prepare(
        `UPDATE source_runs SET finished_at = ?,
          collection_finished_at = COALESCE(collection_finished_at, ?),
          terminal_accounted_at = ?, status = ?, collection_partial = ?,
          collection_health_delta = ?, item_count = ?, enqueued_count = 0,
          provider = COALESCE(?, provider), details_json = ?, last_ingest_error = ?
         WHERE id = ? AND source_id = ? AND status IN ('running', 'queued')
           AND terminal_accounted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM collector_jobs
             WHERE id = ? AND collector_id = ? AND status = ? AND result_json = ?
           )`,
      )
      .bind(
        now,
        now,
        now,
        status,
        collectionPartial ? 1 : 0,
        sourceDelta,
        itemCount,
        input.provider ?? null,
        JSON.stringify({ jobId: input.jobId, operation: job.operation, collectionPartial, error: completionError }),
        completionError,
        job.source_run_id,
        job.source_id,
        input.jobId,
        input.collectorId,
        completedJobStatus,
        resultJson,
      ));
  }
  const [jobResult] = await db.batch(statements);
  return {
    sourceId: job.source_id,
    operation: job.operation,
    sourceRunId: job.source_run_id,
    transitioned: Number(jobResult?.meta?.changes ?? 0) === 1,
  };
}

export async function listCollectorHealth(db: D1Database): Promise<Array<Record<string, unknown>>> {
  return rows(
    await db
      .prepare(
        `SELECT id, name,
          CASE
            WHEN last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime('now', '-5 minutes') THEN 'online'
            ELSE 'offline'
          END AS status,
          last_seen_at, version, capabilities_json, details_json
         FROM collectors ORDER BY name COLLATE NOCASE`,
      )
      .all<Record<string, unknown>>(),
  );
}

export async function listSourceHealth(db: D1Database): Promise<Array<Record<string, unknown>>> {
  return rows(
    await db
      .prepare(
        `SELECT id, name, kind, enabled, health_score, last_run_at, last_success_at, last_error
         FROM sources ORDER BY health_score ASC, name COLLATE NOCASE`,
      )
      .all<Record<string, unknown>>(),
  );
}

export const REASONING_DEGRADED_SOURCE_LIMIT = 11;

export async function listReasoningDegradedSourceHealth(
  db: D1Database,
  limit = REASONING_DEGRADED_SOURCE_LIMIT,
): Promise<Array<Record<string, unknown>>> {
  return rows(
    await db
      .prepare(
        `SELECT substr(id, 1, 128) AS id,
                substr(name, 1, 160) AS name,
                substr(kind, 1, 100) AS kind,
                enabled, health_score,
                CASE WHEN last_run_at IS NULL THEN NULL ELSE substr(last_run_at, 1, 64) END AS last_run_at,
                CASE WHEN last_success_at IS NULL THEN NULL ELSE substr(last_success_at, 1, 64) END AS last_success_at,
                CASE WHEN last_error IS NULL THEN NULL ELSE substr(last_error, 1, 600) END AS last_error
         FROM sources
         WHERE health_score < 0.6 OR last_error IS NOT NULL
         ORDER BY health_score ASC, name COLLATE NOCASE, id ASC
         LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(REASONING_DEGRADED_SOURCE_LIMIT, Math.floor(limit))))
      .all<Record<string, unknown>>(),
  );
}

export async function coverageStats(db: D1Database): Promise<{
  healthySources: number;
  degradedSources: number;
  offlineCollectors: number;
  failedSources: Array<{ name: string; error: string | null }>;
}> {
  const sourceRows = rows(
    await db
      .prepare("SELECT name, health_score, last_error FROM sources WHERE enabled = 1")
      .all<{ name: string; health_score: number; last_error: string | null }>(),
  );
  const collectorRow = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM collectors
       WHERE last_seen_at IS NULL OR datetime(last_seen_at) < datetime('now', '-15 minutes')`,
    )
    .first<{ count: number }>();
  return {
    healthySources: sourceRows.filter((row) => row.health_score >= 0.7).length,
    degradedSources: sourceRows.filter((row) => row.health_score < 0.7).length,
    offlineCollectors: Number(collectorRow?.count ?? 0),
    failedSources: sourceRows
      .filter((row) => row.last_error)
      .slice(0, 10)
      .map((row) => ({ name: row.name, error: row.last_error })),
  };
}

export async function getRenderProfile(db: D1Database, hostname: string): Promise<import("./types").RenderProfile | null> {
  return db
    .prepare("SELECT * FROM render_profiles WHERE hostname = ?")
    .bind(hostname.toLowerCase())
    .first<import("./types").RenderProfile>();
}

export async function recordRenderAttempt(
  db: D1Database,
  input: {
    sourceId?: string;
    hostname: string;
    engine: "kitesurf" | "chromium";
    ok: boolean;
    elapsedMs: number;
    browserMs?: number;
    contentLength?: number;
    error?: string;
  },
): Promise<void> {
  const hostname = input.hostname.toLowerCase();
  const now = isoNow();
  const engine = input.engine;
  const successColumn = `${engine}_successes`;
  const failureColumn = `${engine}_failures`;
  const consecutiveColumn = `${engine}_consecutive_failures`;
  const averageColumn = `${engine}_avg_ms`;
  // Column names are selected from a closed union above; all values remain bound parameters.
  const update = input.ok
    ? `INSERT INTO render_profiles(hostname, preferred_engine, ${successColumn}, ${consecutiveColumn}, ${averageColumn}, last_engine, last_success_at, updated_at)
       VALUES (?, ?, 1, 0, ?, ?, ?, ?)
       ON CONFLICT(hostname) DO UPDATE SET
         preferred_engine = excluded.preferred_engine,
         ${successColumn} = ${successColumn} + 1,
         ${consecutiveColumn} = 0,
         ${averageColumn} = CASE WHEN ${averageColumn} IS NULL THEN excluded.${averageColumn} ELSE (${averageColumn} * 0.75) + (excluded.${averageColumn} * 0.25) END,
         last_engine = excluded.last_engine,
         last_success_at = excluded.last_success_at,
         updated_at = excluded.updated_at`
    : `INSERT INTO render_profiles(hostname, preferred_engine, ${failureColumn}, ${consecutiveColumn}, last_engine, last_failure_at, updated_at)
       VALUES (?, 'kitesurf', 1, 1, ?, ?, ?)
       ON CONFLICT(hostname) DO UPDATE SET
         ${failureColumn} = ${failureColumn} + 1,
         ${consecutiveColumn} = ${consecutiveColumn} + 1,
         last_engine = excluded.last_engine,
         last_failure_at = excluded.last_failure_at,
         updated_at = excluded.updated_at`;

  const profileStatement = input.ok
    ? db.prepare(update).bind(hostname, engine, input.elapsedMs, engine, now, now)
    : db.prepare(update).bind(hostname, engine, now, now);
  await db.batch([
    db
      .prepare(
        `INSERT INTO render_attempts(
          id, source_id, hostname, engine, status, elapsed_ms, browser_ms,
          content_length, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.sourceId ?? null,
        hostname,
        engine,
        input.ok ? "success" : "failed",
        Math.max(0, Math.round(input.elapsedMs)),
        input.browserMs ?? null,
        Math.max(0, input.contentLength ?? 0),
        input.error?.slice(0, 1000) ?? null,
        now,
      ),
    profileStatement,
  ]);
}

export async function listRenderStats(db: D1Database): Promise<{
  totals: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
  recent: Array<Record<string, unknown>>;
}> {
  const [totals, profiles, recent] = await Promise.all([
    db
      .prepare(
        `SELECT engine, status, COUNT(*) AS attempts,
          ROUND(AVG(elapsed_ms), 1) AS average_ms,
          SUM(COALESCE(browser_ms, 0)) AS browser_ms,
          SUM(content_length) AS content_bytes
         FROM render_attempts
         WHERE datetime(created_at) >= datetime('now', '-30 days')
         GROUP BY engine, status ORDER BY engine, status`,
      )
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT hostname, preferred_engine, kitesurf_successes, kitesurf_failures,
          kitesurf_consecutive_failures, kitesurf_avg_ms,
          chromium_successes, chromium_failures, chromium_consecutive_failures, chromium_avg_ms,
          last_engine, last_success_at, last_failure_at
         FROM render_profiles ORDER BY updated_at DESC LIMIT 50`,
      )
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT hostname, engine, status, elapsed_ms, browser_ms, content_length, error, created_at
         FROM render_attempts ORDER BY created_at DESC LIMIT 30`,
      )
      .all<Record<string, unknown>>(),
  ]);
  return { totals: rows(totals), profiles: rows(profiles), recent: rows(recent) };
}

export async function recordPackInstall(
  db: D1Database,
  packId: string,
  sourceCount: number,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pack_installs(pack_id, installed_at, source_count, metadata_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(pack_id) DO UPDATE SET
         installed_at = excluded.installed_at,
         source_count = excluded.source_count,
         metadata_json = excluded.metadata_json`,
    )
    .bind(packId, isoNow(), sourceCount, JSON.stringify(metadata))
    .run();
}

export async function listPackInstalls(db: D1Database): Promise<Array<Record<string, unknown>>> {
  return rows(await db.prepare("SELECT * FROM pack_installs ORDER BY installed_at DESC").all<Record<string, unknown>>());
}


export async function listMissions(db: D1Database, status?: string): Promise<MissionRecord[]> {
  if (status) {
    return rows(
      await db
        .prepare("SELECT * FROM missions WHERE status = ? ORDER BY priority DESC, updated_at DESC")
        .bind(status)
        .all<MissionRecord>(),
    );
  }
  return rows(await db.prepare("SELECT * FROM missions ORDER BY status, priority DESC, updated_at DESC").all<MissionRecord>());
}

export async function getMission(db: D1Database, missionId: string): Promise<MissionRecord | null> {
  return db.prepare("SELECT * FROM missions WHERE id = ?").bind(missionId).first<MissionRecord>();
}

export async function upsertMission(
  db: D1Database,
  input: {
    id: string;
    name: string;
    question?: string;
    terms?: string[];
    sourceScope?: string[];
    status?: "active" | "paused" | "complete";
    priority?: number;
    cadenceMinutes?: number;
  },
): Promise<void> {
  const now = isoNow();
  await db.batch([
    db
      .prepare(
        `INSERT INTO missions(
          id, name, question, terms_json, source_scope_json, status, priority,
          cadence_minutes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          question = excluded.question,
          terms_json = excluded.terms_json,
          source_scope_json = excluded.source_scope_json,
          status = excluded.status,
          priority = excluded.priority,
          cadence_minutes = excluded.cadence_minutes,
          updated_at = excluded.updated_at`,
      )
      .bind(
        input.id,
        input.name,
        input.question ?? "",
        JSON.stringify(input.terms ?? []),
        JSON.stringify(input.sourceScope ?? []),
        input.status ?? "active",
        Math.max(0.1, Math.min(5, input.priority ?? 1)),
        Math.max(15, Math.min(43_200, input.cadenceMinutes ?? 360)),
        now,
        now,
      ),
    db
      .prepare("INSERT INTO mission_operators(mission_id, updated_at) VALUES (?, ?) ON CONFLICT(mission_id) DO NOTHING")
      .bind(input.id, now),
  ]);
  await setSetting(db, "memory_graph_dirty", "1");
}

export async function getMissionOperator(db: D1Database, missionId: string): Promise<MissionOperatorRecord | null> {
  return db.prepare("SELECT * FROM mission_operators WHERE mission_id = ?").bind(missionId).first<MissionOperatorRecord>();
}

export async function listMissionOperatorsByIds(
  db: D1Database,
  missionIds: string[],
): Promise<MissionOperatorRecord[]> {
  const ids = [...new Set(missionIds)].slice(0, 80);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return rows(
    await db
      .prepare(`SELECT * FROM mission_operators WHERE mission_id IN (${placeholders})`)
      .bind(...ids)
      .all<MissionOperatorRecord>(),
  );
}

export async function listMissionActionContexts(
  db: D1Database,
  limit = 200,
): Promise<Array<{ mission: MissionRecord; operator: MissionOperatorRecord; hasActiveRun: boolean }>> {
  const records = rows(
    await db
      .prepare(
        `SELECT
           m.id, m.name, m.question, m.terms_json, m.source_scope_json, m.status, m.priority,
           m.cadence_minutes, m.last_evaluated_at, m.created_at, m.updated_at,
           o.mode, o.research_policy, o.alert_threshold, o.expected_next_event, o.expected_by,
           o.outcome_status, o.outcome_summary, o.resolved_at, o.last_escalated_at,
           o.sprint_policy, o.next_sprint_at, o.last_sprint_at, o.reminder_lead_days,
           o.expected_event_status, o.updated_at AS operator_updated_at,
           EXISTS (
             SELECT 1 FROM mission_runs r
             WHERE r.mission_id = m.id AND r.status IN ('queued','running')
           ) AS has_active_run
         FROM missions m
         JOIN mission_operators o ON o.mission_id = m.id
         ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END, m.priority DESC, m.updated_at DESC
         LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(200, limit)))
      .all<Record<string, unknown>>(),
  );
  return records.map((row) => ({
    mission: {
      id: String(row.id),
      name: String(row.name),
      question: String(row.question ?? ""),
      terms_json: String(row.terms_json ?? "[]"),
      source_scope_json: String(row.source_scope_json ?? "[]"),
      status: row.status as MissionRecord["status"],
      priority: Number(row.priority ?? 1),
      cadence_minutes: Number(row.cadence_minutes ?? 360),
      last_evaluated_at: row.last_evaluated_at ? String(row.last_evaluated_at) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    },
    operator: {
      mission_id: String(row.id),
      mode: row.mode as MissionMode,
      research_policy: row.research_policy as MissionResearchPolicy,
      alert_threshold: Number(row.alert_threshold ?? 0.65),
      expected_next_event: String(row.expected_next_event ?? ""),
      expected_by: row.expected_by ? String(row.expected_by) : null,
      outcome_status: row.outcome_status as MissionOutcomeStatus,
      outcome_summary: String(row.outcome_summary ?? ""),
      resolved_at: row.resolved_at ? String(row.resolved_at) : null,
      last_escalated_at: row.last_escalated_at ? String(row.last_escalated_at) : null,
      sprint_policy: row.sprint_policy as MissionSprintPolicy,
      next_sprint_at: row.next_sprint_at ? String(row.next_sprint_at) : null,
      last_sprint_at: row.last_sprint_at ? String(row.last_sprint_at) : null,
      reminder_lead_days: Number(row.reminder_lead_days ?? 3),
      expected_event_status: row.expected_event_status as MissionExpectedEventStatus,
      updated_at: String(row.operator_updated_at),
    },
    hasActiveRun: Number(row.has_active_run ?? 0) === 1,
  }));
}

export async function upsertMissionOperator(
  db: D1Database,
  input: {
    missionId: string;
    mode?: MissionMode;
    researchPolicy?: MissionResearchPolicy;
    alertThreshold?: number;
    expectedNextEvent?: string;
    expectedBy?: string | null;
    outcomeStatus?: MissionOutcomeStatus;
    outcomeSummary?: string;
    resolvedAt?: string | null;
    lastEscalatedAt?: string | null;
    sprintPolicy?: MissionSprintPolicy;
    nextSprintAt?: string | null;
    lastSprintAt?: string | null;
    reminderLeadDays?: number;
    expectedEventStatus?: MissionExpectedEventStatus;
  },
): Promise<void> {
  const now = isoNow();
  const existing = await getMissionOperator(db, input.missionId);
  await db
    .prepare(
      `INSERT INTO mission_operators(
        mission_id, mode, research_policy, alert_threshold, expected_next_event, expected_by,
        outcome_status, outcome_summary, resolved_at, last_escalated_at,
        sprint_policy, next_sprint_at, last_sprint_at, reminder_lead_days, expected_event_status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mission_id) DO UPDATE SET
        mode = excluded.mode,
        research_policy = excluded.research_policy,
        alert_threshold = excluded.alert_threshold,
        expected_next_event = excluded.expected_next_event,
        expected_by = excluded.expected_by,
        outcome_status = excluded.outcome_status,
        outcome_summary = excluded.outcome_summary,
        resolved_at = excluded.resolved_at,
        last_escalated_at = excluded.last_escalated_at,
        sprint_policy = excluded.sprint_policy,
        next_sprint_at = excluded.next_sprint_at,
        last_sprint_at = excluded.last_sprint_at,
        reminder_lead_days = excluded.reminder_lead_days,
        expected_event_status = excluded.expected_event_status,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.missionId,
      input.mode ?? existing?.mode ?? "watch",
      input.researchPolicy ?? existing?.research_policy ?? "suggest",
      Math.max(0.1, Math.min(1, input.alertThreshold ?? existing?.alert_threshold ?? 0.65)),
      (input.expectedNextEvent ?? existing?.expected_next_event ?? "").slice(0, 1_000),
      input.expectedBy === undefined ? existing?.expected_by ?? null : input.expectedBy,
      input.outcomeStatus ?? existing?.outcome_status ?? "open",
      (input.outcomeSummary ?? existing?.outcome_summary ?? "").slice(0, 4_000),
      input.resolvedAt === undefined ? existing?.resolved_at ?? null : input.resolvedAt,
      input.lastEscalatedAt === undefined ? existing?.last_escalated_at ?? null : input.lastEscalatedAt,
      input.sprintPolicy ?? existing?.sprint_policy ?? "manual",
      input.nextSprintAt === undefined ? existing?.next_sprint_at ?? null : input.nextSprintAt,
      input.lastSprintAt === undefined ? existing?.last_sprint_at ?? null : input.lastSprintAt,
      Math.max(0, Math.min(30, input.reminderLeadDays ?? existing?.reminder_lead_days ?? 3)),
      input.expectedEventStatus ?? existing?.expected_event_status ?? ((input.expectedNextEvent ?? existing?.expected_next_event) ? "pending" : "none"),
      now,
    )
    .run();
  await setSetting(db, "memory_graph_dirty", "1");
}

export async function recordMissionEvent(
  db: D1Database,
  input: {
    missionId: string;
    eventType: MissionEventRecord["event_type"];
    title: string;
    detail?: string;
    storyId?: string | null;
    metadata?: Record<string, unknown>;
    occurredAt?: string;
    dedupeKey?: string | null;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO mission_events(
        id, mission_id, event_type, title, detail, story_id, metadata_json, occurred_at, created_at, dedupe_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, input.missionId, input.eventType, input.title.slice(0, 300), (input.detail ?? "").slice(0, 8_000),
      input.storyId ?? null, JSON.stringify(input.metadata ?? {}), input.occurredAt ?? isoNow(), isoNow(),
      input.dedupeKey?.slice(0, 240) ?? null,
    )
    .run();
  if (Number(result.meta?.changes ?? 0) > 0 || !input.dedupeKey) return id;
  const existing = await db
    .prepare("SELECT id FROM mission_events WHERE mission_id = ? AND dedupe_key = ?")
    .bind(input.missionId, input.dedupeKey)
    .first<{ id: string }>();
  return existing?.id ?? id;
}

export async function listMissionEvents(db: D1Database, missionId: string, limit = 50): Promise<MissionEventRecord[]> {
  return rows(
    await db
      .prepare("SELECT * FROM mission_events WHERE mission_id = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?")
      .bind(missionId, Math.max(1, Math.min(200, limit)))
      .all<MissionEventRecord>(),
  );
}

export async function deleteMission(db: D1Database, missionId: string): Promise<void> {
  await db.prepare("DELETE FROM missions WHERE id = ?").bind(missionId).run();
}

export async function recordMissionMatch(
  db: D1Database,
  input: { missionId: string; storyId: string; matchScore: number; matchedTerms: string[] },
): Promise<void> {
  const now = isoNow();
  const matchedTerms = projectPersistedMissionMatchTerms(input.matchedTerms);
  await db.batch([
    db
      .prepare(
        `INSERT INTO mission_story_matches(
          mission_id, story_id, match_score, matched_terms_json, first_matched_at, last_matched_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(mission_id, story_id) DO UPDATE SET
          match_score = MAX(mission_story_matches.match_score, excluded.match_score),
          matched_terms_json = excluded.matched_terms_json,
          last_matched_at = excluded.last_matched_at`,
      )
      .bind(input.missionId, input.storyId, input.matchScore, JSON.stringify(matchedTerms), now, now),
    db.prepare("UPDATE missions SET last_evaluated_at = ? WHERE id = ?").bind(now, input.missionId),
  ]);
}

export interface MissionMatchReplacement {
  storyId: string;
  matchScore: number;
  matchedTerms: string[];
}

export const MISSION_MATCH_PERSISTED_TERM_LIMIT = 6;
export const MISSION_MATCH_PERSISTED_TERM_CHARACTERS = 32;

function withinMissionMatchPersistenceLimit(value: string): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > MISSION_MATCH_PERSISTED_TERM_CHARACTERS) return false;
  }
  return count > 0;
}

/**
 * Match scoring may use the full bounded Mission term set. Stored labels use a
 * smaller exact projection so a rebuild cannot create a multi-megabyte row
 * payload. Oversized labels are omitted instead of being reinterpreted as a
 * matching prefix.
 */
export function projectPersistedMissionMatchTerms(terms: string[]): string[] {
  const projected: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    if (
      typeof term !== "string"
      || seen.has(term)
      || !withinMissionMatchPersistenceLimit(term)
    ) continue;
    seen.add(term);
    projected.push(term);
    if (projected.length >= MISSION_MATCH_PERSISTED_TERM_LIMIT) break;
  }
  return projected;
}

const MISSION_MATCH_BULK_SAFE_BYTES = 1_000_000;
const MISSION_MATCH_BULK_ENCODER = new TextEncoder();

function missionMatchJsonBatches<T>(values: T[], label: string): string[] {
  const batches: string[] = [];
  let current: string[] = [];
  let currentBytes = 2;
  for (const value of values) {
    const encoded = JSON.stringify(value);
    const encodedBytes = MISSION_MATCH_BULK_ENCODER.encode(encoded).byteLength;
    if (encodedBytes + 2 > MISSION_MATCH_BULK_SAFE_BYTES) {
      throw new Error(`${label} exceeds the safe D1 bulk-write size`);
    }
    const separatorBytes = current.length ? 1 : 0;
    if (current.length && currentBytes + separatorBytes + encodedBytes > MISSION_MATCH_BULK_SAFE_BYTES) {
      batches.push(`[${current.join(",")}]`);
      current = [];
      currentBytes = 2;
    }
    current.push(encoded);
    currentBytes += (current.length > 1 ? 1 : 0) + encodedBytes;
  }
  if (current.length) batches.push(`[${current.join(",")}]`);
  return batches;
}

/**
 * Replace a Mission's current match set. All statements execute in one D1
 * batch, so an interrupted rebuild leaves the prior set intact.
 */
export async function replaceMissionStoryMatches(
  db: D1Database,
  input: {
    missionId: string;
    missionUpdatedAt?: string;
    rebuildWatermark?: string;
    evaluatedStoryIds: string[];
    matches: MissionMatchReplacement[];
  },
): Promise<boolean> {
  const evaluatedStoryIds = [...new Set(input.evaluatedStoryIds)].slice(0, 500);
  const evaluated = new Set(evaluatedStoryIds);
  const matches = [...new Map(
    input.matches
      .filter((match) => evaluated.has(match.storyId))
      .map((match) => [match.storyId, {
        ...match,
        matchedTerms: projectPersistedMissionMatchTerms(match.matchedTerms),
      }] as const),
  ).values()];
  const now = isoNow();
  const expectedMissionUpdatedAt = input.missionUpdatedAt ?? null;
  const rebuildWatermark = input.rebuildWatermark ?? now;
  const statements: D1PreparedStatement[] = [];

  const matchRows = matches.map((match) => ({
    storyId: match.storyId,
    matchScore: match.matchScore,
    matchedTerms: match.matchedTerms,
  }));
  for (const payload of missionMatchJsonBatches(matchRows, "Mission match replacement row")) {
    statements.push(
      db
        .prepare(
          `INSERT INTO mission_story_matches(
             mission_id, story_id, match_score, matched_terms_json, first_matched_at, last_matched_at
           )
           SELECT ?,
                  CAST(json_extract(entry.value, '$.storyId') AS TEXT),
                  CAST(json_extract(entry.value, '$.matchScore') AS REAL),
                  COALESCE(json_extract(entry.value, '$.matchedTerms'), '[]'),
                  ?, ?
           FROM json_each(?) AS entry
           WHERE EXISTS (
             SELECT 1 FROM missions
             WHERE id = ? AND (? IS NULL OR updated_at = ?)
           )
           ON CONFLICT(mission_id, story_id) DO UPDATE SET
             match_score = excluded.match_score,
             matched_terms_json = excluded.matched_terms_json,
             last_matched_at = excluded.last_matched_at
           WHERE mission_story_matches.last_matched_at < ?`,
        )
        .bind(
          input.missionId,
          now,
          now,
          payload,
          input.missionId,
          expectedMissionUpdatedAt,
          expectedMissionUpdatedAt,
          rebuildWatermark,
        ),
    );
  }

  statements.push(
    db
      .prepare(
        `DELETE FROM mission_story_matches
         WHERE mission_id = ?
           AND last_matched_at < ?
           AND story_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
           AND EXISTS (
             SELECT 1 FROM missions
             WHERE id = ? AND (? IS NULL OR updated_at = ?)
           )`,
      )
      .bind(
        input.missionId,
        rebuildWatermark,
        JSON.stringify(matches.map((match) => match.storyId)),
        input.missionId,
        expectedMissionUpdatedAt,
        expectedMissionUpdatedAt,
      ),
  );

  statements.push(
    db
      .prepare("UPDATE missions SET last_evaluated_at = ? WHERE id = ? AND (? IS NULL OR updated_at = ?)")
      .bind(now, input.missionId, expectedMissionUpdatedAt, expectedMissionUpdatedAt),
  );
  const results = await db.batch(statements);
  return Number(results.at(-1)?.meta?.changes ?? 0) > 0;
}

export async function clearMissionStoryMatches(db: D1Database, missionId: string): Promise<void> {
  await db.prepare("DELETE FROM mission_story_matches WHERE mission_id = ?").bind(missionId).run();
}

export async function listMissionMatches(
  db: D1Database,
  missionId: string,
  limit = 50,
): Promise<Array<Record<string, unknown>>> {
  return rows(
    await db
      .prepare(
        `SELECT m.mission_id, m.story_id, m.match_score, m.matched_terms_json,
          m.first_matched_at, m.last_matched_at,
          s.title, s.summary, s.score, s.last_changed_at, s.source_count, s.confidence
         FROM mission_story_matches m
         JOIN stories s ON s.id = m.story_id
         WHERE m.mission_id = ?
         ORDER BY m.last_matched_at DESC, m.match_score DESC, s.score DESC, s.id ASC
         LIMIT ?`,
      )
      .bind(missionId, Math.max(1, Math.min(200, limit)))
      .all<Record<string, unknown>>(),
  );
}

export async function missionsForBriefing(
  db: D1Database,
  since: string,
  limitPerMission = 6,
): Promise<Array<{ mission: MissionRecord; matches: Array<Record<string, unknown>> }>> {
  const missions = rows(
    await db
      .prepare(
        `SELECT * FROM missions
         WHERE status = 'active'
         ORDER BY priority DESC, updated_at DESC
         LIMIT 20`,
      )
      .all<MissionRecord>(),
  );
  if (!missions.length) return [];
  const ids = missions.map((mission) => mission.id);
  const placeholders = ids.map(() => "?").join(",");
  const matches = rows(
    await db
      .prepare(
        `WITH ranked AS (
           SELECT m.mission_id, m.story_id, m.match_score, m.matched_terms_json, m.last_matched_at,
                  s.title, s.score, s.last_changed_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY m.mission_id
                    ORDER BY m.match_score DESC, s.score DESC, m.last_matched_at DESC, m.story_id
                  ) AS match_rank
           FROM mission_story_matches m
           JOIN stories s ON s.id = m.story_id
           WHERE m.mission_id IN (${placeholders})
             AND datetime(m.last_matched_at) >= datetime(?)
         )
         SELECT mission_id, story_id, match_score, matched_terms_json, last_matched_at,
                title, score, last_changed_at
         FROM ranked
         WHERE match_rank <= ?
         ORDER BY mission_id, match_rank`,
      )
      .bind(...ids, since, Math.max(1, Math.min(20, limitPerMission)))
      .all<Record<string, unknown>>(),
  );
  const byMission = new Map<string, Array<Record<string, unknown>>>();
  for (const match of matches) {
    const missionId = String(match.mission_id ?? "");
    const bucket = byMission.get(missionId) ?? [];
    bucket.push(match);
    byMission.set(missionId, bucket);
  }
  return missions.map((mission) => ({ mission, matches: byMission.get(mission.id) ?? [] }));
}

export function inboxReceiptDedupeKey(sourceId: string, messageId?: string): string | null {
  const normalized = messageId?.trim().toLowerCase();
  return normalized ? `${sourceId}:${normalized}` : null;
}

export async function getInboxReceiptByMessageId(
  db: D1Database,
  sourceId: string,
  messageId?: string,
): Promise<InboxReceiptRecord | null> {
  const dedupeKey = inboxReceiptDedupeKey(sourceId, messageId);
  if (!dedupeKey) return null;
  return db.prepare("SELECT * FROM inbox_receipts WHERE dedupe_key = ?").bind(dedupeKey).first<InboxReceiptRecord>();
}

interface InboxReceiptWriteInput {
  id: string;
  sourceId: string;
  messageId?: string;
  sender?: string;
  recipient?: string;
  subject?: string;
  receivedAt: string;
  itemCount: number;
  metadata?: Record<string, unknown>;
}

export async function claimInboxReceiptDelivery(
  db: D1Database,
  input: InboxReceiptWriteInput,
): Promise<{ receipt: InboxReceiptRecord; created: boolean; duplicate: boolean; ownsQueueClaim: boolean }> {
  const dedupeKey = inboxReceiptDedupeKey(input.sourceId, input.messageId);
  if (!dedupeKey) throw new Error("A Message-ID is required to claim an inbox receipt");
  await db
    .prepare(
      `INSERT INTO inbox_receipts(
        id, source_id, message_id, dedupe_key, sender, recipient, subject,
        received_at, last_received_at, delivery_count, item_count, outcome,
        queue_state, queue_claim_token, queue_claimed_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'queue-pending', 'pending', ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        last_received_at = excluded.last_received_at,
        delivery_count = inbox_receipts.delivery_count + 1,
        outcome = CASE
          WHEN inbox_receipts.queue_state = 'failed' THEN 'queue-pending'
          ELSE 'duplicate-reused'
        END,
        queue_state = CASE
          WHEN inbox_receipts.queue_state = 'failed' THEN 'pending'
          ELSE inbox_receipts.queue_state
        END,
        queue_claim_token = CASE
          WHEN inbox_receipts.queue_state = 'failed' THEN excluded.queue_claim_token
          ELSE inbox_receipts.queue_claim_token
        END,
        queue_claimed_at = CASE
          WHEN inbox_receipts.queue_state = 'failed' THEN excluded.queue_claimed_at
          ELSE inbox_receipts.queue_claimed_at
        END`,
    )
    .bind(
      input.id,
      input.sourceId,
      input.messageId ?? null,
      dedupeKey,
      input.sender ?? null,
      input.recipient ?? null,
      input.subject ?? null,
      input.receivedAt,
      input.receivedAt,
      input.itemCount,
      input.id,
      input.receivedAt,
      JSON.stringify(input.metadata ?? {}),
    )
    .run();

  const receipt = await db.prepare("SELECT * FROM inbox_receipts WHERE dedupe_key = ?").bind(dedupeKey).first<InboxReceiptRecord>();
  if (!receipt) throw new Error("Inbox receipt claim did not return a row");
  const created = receipt.id === input.id;
  return {
    receipt,
    created,
    duplicate: !created,
    ownsQueueClaim: receipt.queue_state === "pending" && receipt.queue_claim_token === input.id,
  };
}

export async function completeInboxReceiptQueueClaim(
  db: D1Database,
  sourceId: string,
  messageId: string,
  claimToken: string,
): Promise<InboxReceiptRecord> {
  const dedupeKey = inboxReceiptDedupeKey(sourceId, messageId);
  if (!dedupeKey) throw new Error("A Message-ID is required to complete an inbox receipt claim");
  await db
    .prepare(
      `UPDATE inbox_receipts
       SET queue_state = 'queued',
           outcome = CASE WHEN delivery_count > 1 THEN 'duplicate-reused' ELSE 'queued' END
       WHERE dedupe_key = ? AND queue_claim_token = ? AND queue_state = 'pending'`,
    )
    .bind(dedupeKey, claimToken)
    .run();
  const receipt = await getInboxReceiptByMessageId(db, sourceId, messageId);
  if (!receipt || receipt.queue_state !== "queued" || receipt.queue_claim_token !== claimToken) {
    throw new Error("Inbox receipt Queue claim could not be completed");
  }
  return receipt;
}

export async function failInboxReceiptQueueClaim(
  db: D1Database,
  sourceId: string,
  messageId: string,
  claimToken: string,
): Promise<InboxReceiptRecord> {
  const dedupeKey = inboxReceiptDedupeKey(sourceId, messageId);
  if (!dedupeKey) throw new Error("A Message-ID is required to fail an inbox receipt claim");
  await db
    .prepare(
      `UPDATE inbox_receipts
       SET queue_state = 'failed', outcome = 'queue-failed'
       WHERE dedupe_key = ? AND queue_claim_token = ? AND queue_state = 'pending'`,
    )
    .bind(dedupeKey, claimToken)
    .run();
  const receipt = await getInboxReceiptByMessageId(db, sourceId, messageId);
  if (!receipt || receipt.queue_state !== "failed" || receipt.queue_claim_token !== claimToken) {
    throw new Error("Inbox receipt Queue claim could not be marked failed");
  }
  return receipt;
}

export async function reconcileInboxReceiptQueueClaim(
  db: D1Database,
  sourceId: string,
  messageId: string,
  claimToken: string,
): Promise<boolean> {
  const dedupeKey = inboxReceiptDedupeKey(sourceId, messageId);
  if (!dedupeKey) return false;
  await db
    .prepare(
      `UPDATE inbox_receipts
       SET queue_state = 'queued',
           outcome = CASE WHEN delivery_count > 1 THEN 'duplicate-reused' ELSE 'queued' END
       WHERE dedupe_key = ? AND queue_claim_token = ? AND queue_state IN ('pending', 'failed')`,
    )
    .bind(dedupeKey, claimToken)
    .run();
  const receipt = await getInboxReceiptByMessageId(db, sourceId, messageId);
  return Boolean(receipt && receipt.queue_claim_token === claimToken && receipt.queue_state === "queued");
}

export async function recordUnkeyedInboxReceipt(
  db: D1Database,
  input: InboxReceiptWriteInput,
): Promise<InboxReceiptRecord> {
  if (inboxReceiptDedupeKey(input.sourceId, input.messageId)) {
    throw new Error("Message-ID receipts must use the Queue claim path");
  }
  await db
    .prepare(
      `INSERT INTO inbox_receipts(
        id, source_id, message_id, dedupe_key, sender, recipient, subject,
        received_at, last_received_at, delivery_count, item_count, outcome,
        queue_state, queue_claim_token, queue_claimed_at, metadata_json
      ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, 1, ?, 'queued-unkeyed', 'unkeyed', NULL, NULL, ?)`,
    )
    .bind(
      input.id,
      input.sourceId,
      input.sender ?? null,
      input.recipient ?? null,
      input.subject ?? null,
      input.receivedAt,
      input.receivedAt,
      input.itemCount,
      JSON.stringify(input.metadata ?? {}),
    )
    .run();
  const receipt = await db.prepare("SELECT * FROM inbox_receipts WHERE id = ?").bind(input.id).first<InboxReceiptRecord>();
  if (!receipt) throw new Error("Unkeyed inbox receipt write did not return a row");
  return receipt;
}

export async function listInboxReceipts(db: D1Database, limit = 50): Promise<InboxReceiptRecord[]> {
  return rows(
    await db
      .prepare("SELECT * FROM inbox_receipts ORDER BY last_received_at DESC, received_at DESC LIMIT ?")
      .bind(Math.max(1, Math.min(200, limit)))
      .all<InboxReceiptRecord>(),
  );
}

export async function listSavedViews(db: D1Database): Promise<import("./types").SavedViewRecord[]> {
  return rows(
    await db
      .prepare("SELECT * FROM saved_views ORDER BY name COLLATE NOCASE")
      .all<import("./types").SavedViewRecord>(),
  );
}

export async function getSavedView(db: D1Database, id: string): Promise<import("./types").SavedViewRecord | null> {
  return db.prepare("SELECT * FROM saved_views WHERE id = ?").bind(id).first<import("./types").SavedViewRecord>();
}

export async function upsertSavedView(
  db: D1Database,
  input: { id: string; name: string; query: string; filters?: Record<string, unknown> },
): Promise<void> {
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO saved_views(id, name, query, filters_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         query = excluded.query,
         filters_json = excluded.filters_json,
         updated_at = excluded.updated_at`,
    )
    .bind(input.id, input.name, input.query, JSON.stringify(input.filters ?? {}), now, now)
    .run();
}

export async function deleteSavedView(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM saved_views WHERE id = ?").bind(id).run();
}


export async function insertPublicShare(
  db: D1Database,
  input: { id: string; tokenHash: string; kind: PublicShareRecord["kind"]; title: string; payload: Record<string, unknown>; expiresAt: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO public_shares(id, token_hash, kind, title, payload_json, expires_at, view_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(input.id, input.tokenHash, input.kind, input.title, JSON.stringify(input.payload), input.expiresAt, isoNow())
    .run();
}

export async function getPublicShareByHash(db: D1Database, tokenHash: string): Promise<PublicShareRecord | null> {
  return db
    .prepare("SELECT * FROM public_shares WHERE token_hash = ? AND datetime(expires_at) > datetime('now')")
    .bind(tokenHash)
    .first<PublicShareRecord>();
}

export async function incrementPublicShareView(db: D1Database, shareId: string): Promise<void> {
  await db.prepare("UPDATE public_shares SET view_count = view_count + 1 WHERE id = ?").bind(shareId).run();
}

export async function listPublicShares(db: D1Database, limit = 50): Promise<PublicShareRecord[]> {
  return rows(
    await db
      .prepare("SELECT * FROM public_shares WHERE datetime(expires_at) > datetime('now') ORDER BY created_at DESC LIMIT ?")
      .bind(Math.max(1, Math.min(200, limit)))
      .all<PublicShareRecord>(),
  );
}

export async function deletePublicShare(db: D1Database, shareId: string): Promise<void> {
  await db.prepare("DELETE FROM public_shares WHERE id = ?").bind(shareId).run();
}

export async function purgeExpiredPublicShares(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM public_shares WHERE datetime(expires_at) <= datetime('now')").run();
}


export async function createMissionRun(
  db: D1Database,
  input: { id: string; missionId: string; workflowId?: string; sourceIds?: string[] },
): Promise<void> {
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO mission_runs(
        id, mission_id, workflow_id, status, source_ids_json, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', ?, '{}', ?, ?)`,
    )
    .bind(input.id, input.missionId, input.workflowId ?? null, JSON.stringify(input.sourceIds ?? []), now, now)
    .run();
}

export async function updateMissionRun(
  db: D1Database,
  runId: string,
  input: {
    workflowId?: string;
    status?: MissionRunRecord["status"];
    sourceIds?: string[];
    result?: Record<string, unknown>;
    error?: string | null;
    startedAt?: string;
    completedAt?: string;
  },
): Promise<void> {
  const existing = await getMissionRun(db, runId);
  if (!existing) throw new HttpError(404, `Mission run not found: ${runId}`);
  await db
    .prepare(
      `UPDATE mission_runs SET
        workflow_id = ?,
        status = ?,
        source_ids_json = ?,
        result_json = ?,
        error = ?,
        started_at = ?,
        completed_at = ?,
        updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.workflowId ?? existing.workflow_id,
      input.status ?? existing.status,
      input.sourceIds ? JSON.stringify(input.sourceIds) : existing.source_ids_json,
      input.result ? JSON.stringify(input.result) : existing.result_json,
      input.error === undefined ? existing.error : input.error,
      input.startedAt ?? existing.started_at,
      input.completedAt ?? existing.completed_at,
      isoNow(),
      runId,
    )
    .run();
}

export async function getMissionRun(db: D1Database, runId: string): Promise<MissionRunRecord | null> {
  return db.prepare("SELECT * FROM mission_runs WHERE id = ?").bind(runId).first<MissionRunRecord>();
}

export async function listMissionRuns(
  db: D1Database,
  input: { missionId?: string; limit?: number } = {},
): Promise<MissionRunRecord[]> {
  const limit = Math.max(1, Math.min(100, input.limit ?? 30));
  if (input.missionId) {
    return rows(
      await db
        .prepare("SELECT * FROM mission_runs WHERE mission_id = ? ORDER BY created_at DESC LIMIT ?")
        .bind(input.missionId, limit)
        .all<MissionRunRecord>(),
    );
  }
  return rows(await db.prepare("SELECT * FROM mission_runs ORDER BY created_at DESC LIMIT ?").bind(limit).all<MissionRunRecord>());
}

export async function hasActiveMissionRun(db: D1Database, missionId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM mission_runs WHERE mission_id = ? AND status IN ('queued','running') LIMIT 1")
    .bind(missionId)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function listDueMissionSprints(
  db: D1Database,
  now = isoNow(),
  limit = 3,
): Promise<Array<{ mission: MissionRecord; operator: MissionOperatorRecord }>> {
  const records = rows(
    await db
      .prepare(
        `SELECT
          m.id, m.name, m.question, m.terms_json, m.source_scope_json, m.status, m.priority,
          m.cadence_minutes, m.last_evaluated_at, m.created_at, m.updated_at,
          o.mission_id AS operator_mission_id, o.mode, o.research_policy, o.alert_threshold,
          o.expected_next_event, o.expected_by, o.outcome_status, o.outcome_summary, o.resolved_at,
          o.last_escalated_at, o.sprint_policy, o.next_sprint_at, o.last_sprint_at,
          o.reminder_lead_days, o.expected_event_status, o.updated_at AS operator_updated_at
         FROM missions m
         JOIN mission_operators o ON o.mission_id = m.id
         WHERE m.status = 'active'
           AND o.outcome_status = 'open'
           AND o.sprint_policy = 'scheduled'
           AND (o.next_sprint_at IS NULL OR datetime(o.next_sprint_at) <= datetime(?))
           AND NOT EXISTS (
             SELECT 1 FROM mission_runs r
             WHERE r.mission_id = m.id AND r.status IN ('queued','running')
           )
         ORDER BY COALESCE(o.next_sprint_at, m.created_at) ASC, m.priority DESC
         LIMIT ?`,
      )
      .bind(now, Math.max(1, Math.min(10, limit)))
      .all<Record<string, unknown>>(),
  );
  return records.map((row) => ({
    mission: {
      id: String(row.id), name: String(row.name), question: String(row.question ?? ""),
      terms_json: String(row.terms_json ?? "[]"), source_scope_json: String(row.source_scope_json ?? "[]"),
      status: row.status as MissionRecord["status"], priority: Number(row.priority ?? 1),
      cadence_minutes: Number(row.cadence_minutes ?? 360), last_evaluated_at: row.last_evaluated_at ? String(row.last_evaluated_at) : null,
      created_at: String(row.created_at), updated_at: String(row.updated_at),
    },
    operator: {
      mission_id: String(row.operator_mission_id), mode: row.mode as MissionMode,
      research_policy: row.research_policy as MissionResearchPolicy, alert_threshold: Number(row.alert_threshold ?? 0.65),
      expected_next_event: String(row.expected_next_event ?? ""), expected_by: row.expected_by ? String(row.expected_by) : null,
      outcome_status: row.outcome_status as MissionOutcomeStatus, outcome_summary: String(row.outcome_summary ?? ""),
      resolved_at: row.resolved_at ? String(row.resolved_at) : null,
      last_escalated_at: row.last_escalated_at ? String(row.last_escalated_at) : null,
      sprint_policy: row.sprint_policy as MissionSprintPolicy, next_sprint_at: row.next_sprint_at ? String(row.next_sprint_at) : null,
      last_sprint_at: row.last_sprint_at ? String(row.last_sprint_at) : null,
      reminder_lead_days: Number(row.reminder_lead_days ?? 3),
      expected_event_status: row.expected_event_status as MissionExpectedEventStatus,
      updated_at: String(row.operator_updated_at),
    },
  }));
}

export interface MissionReminderCandidate {
  mission_id: string;
  expected_next_event: string;
  expected_by: string;
  expected_event_status: MissionExpectedEventStatus;
  reminder_lead_days: number;
  reminder_kind: "overdue" | "soon";
  due_key: string;
  days_until: number;
}

/** One bounded candidate read replaces active-Mission/operator N+1 scans. */
export async function listDueMissionReminderCandidates(
  db: D1Database,
  now = isoNow(),
  limit = 12,
): Promise<MissionReminderCandidate[]> {
  return rows(
    await db
      .prepare(
        `WITH candidates AS (
           SELECT m.id AS mission_id, m.priority,
                  o.expected_next_event, o.expected_by, o.expected_event_status,
                  MAX(0, MIN(30, COALESCE(o.reminder_lead_days, 3))) AS reminder_lead_days,
                  CASE WHEN julianday(o.expected_by) < julianday(?) THEN 'overdue' ELSE 'soon' END AS reminder_kind,
                  date(o.expected_by) AS due_key,
                  julianday(o.expected_by) - julianday(?) AS days_until
           FROM missions m
           JOIN mission_operators o ON o.mission_id = m.id
           WHERE m.status = 'active'
             AND o.outcome_status = 'open'
             AND trim(COALESCE(o.expected_next_event, '')) <> ''
             AND o.expected_by IS NOT NULL
             AND o.expected_event_status IN ('pending', 'rescheduled')
             AND julianday(o.expected_by) IS NOT NULL
             AND julianday(o.expected_by) <= julianday(?)
               + MAX(0, MIN(30, COALESCE(o.reminder_lead_days, 3)))
         )
         SELECT mission_id, expected_next_event, expected_by, expected_event_status,
                reminder_lead_days, reminder_kind, due_key, days_until
         FROM candidates candidate
         WHERE due_key IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM mission_events event
             WHERE event.mission_id = candidate.mission_id
               AND event.dedupe_key = (
                 CASE candidate.reminder_kind
                   WHEN 'overdue' THEN 'expected-overdue:'
                   ELSE 'expected-soon:'
                 END
               ) || candidate.due_key
           )
         ORDER BY julianday(candidate.expected_by) ASC, candidate.priority DESC, candidate.mission_id ASC
         LIMIT ?`,
      )
      .bind(now, now, now, Math.max(1, Math.min(12, Math.floor(limit))))
      .all<MissionReminderCandidate>(),
  );
}

export async function markMissionSprintLaunched(
  db: D1Database,
  missionId: string,
  cadenceMinutes: number,
  launchedAt = isoNow(),
): Promise<void> {
  const next = new Date(Date.parse(launchedAt) + Math.max(15, cadenceMinutes) * 60_000).toISOString();
  await db
    .prepare("UPDATE mission_operators SET last_sprint_at = ?, next_sprint_at = ?, updated_at = ? WHERE mission_id = ?")
    .bind(launchedAt, next, launchedAt, missionId)
    .run();
}

/**
 * Move only a still-scheduled Mission out of the head due slot after its
 * Workflow could not be created. This is not a successful launch: the last
 * launch timestamp remains untouched and the failed Mission run is retained.
 */
export async function deferMissionSprintAttempt(
  db: D1Database,
  missionId: string,
  nextAttemptAt: string,
  updatedAt = isoNow(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE mission_operators
       SET next_sprint_at = ?, updated_at = ?
       WHERE mission_id = ?
         AND sprint_policy = 'scheduled'
         AND outcome_status = 'open'`,
    )
    .bind(nextAttemptAt, updatedAt, missionId)
    .run();
}

export async function getMissionResearchState(db: D1Database, missionId: string): Promise<MissionResearchStateRecord | null> {
  return db.prepare("SELECT * FROM mission_research_state WHERE mission_id = ?").bind(missionId).first<MissionResearchStateRecord>();
}

export async function listMissionResearchStatesByIds(
  db: D1Database,
  missionIds: string[],
): Promise<MissionResearchStateRecord[]> {
  const ids = [...new Set(missionIds)].slice(0, 80);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return rows(
    await db
      .prepare(`SELECT * FROM mission_research_state WHERE mission_id IN (${placeholders})`)
      .bind(...ids)
      .all<MissionResearchStateRecord>(),
  );
}

export async function upsertMissionResearchState(
  db: D1Database,
  input: {
    missionId: string;
    currentThesis?: string;
    reportSummary?: string;
    openQuestions?: string[];
    reportTitle?: string;
    reportUrl?: string | null;
    confidence?: number | null;
    lastResearchAt?: string | null;
    lastHandoffId?: string | null;
  },
): Promise<void> {
  const existing = await getMissionResearchState(db, input.missionId);
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO mission_research_state(
        mission_id, current_thesis, report_summary, open_questions_json, report_title, report_url,
        confidence, last_research_at, last_handoff_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mission_id) DO UPDATE SET
        current_thesis = excluded.current_thesis,
        report_summary = excluded.report_summary,
        open_questions_json = excluded.open_questions_json,
        report_title = excluded.report_title,
        report_url = excluded.report_url,
        confidence = excluded.confidence,
        last_research_at = excluded.last_research_at,
        last_handoff_id = excluded.last_handoff_id,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.missionId,
      (input.currentThesis ?? existing?.current_thesis ?? "").slice(0, 12_000),
      (input.reportSummary ?? existing?.report_summary ?? "").slice(0, 8_000),
      JSON.stringify((input.openQuestions ?? parseJson<string[]>(existing?.open_questions_json ?? "[]", [])).slice(0, 100)),
      (input.reportTitle ?? existing?.report_title ?? "").slice(0, 500),
      input.reportUrl === undefined ? existing?.report_url ?? null : input.reportUrl,
      input.confidence === undefined ? existing?.confidence ?? null : input.confidence,
      input.lastResearchAt === undefined ? existing?.last_research_at ?? null : input.lastResearchAt,
      input.lastHandoffId === undefined ? existing?.last_handoff_id ?? null : input.lastHandoffId,
      now,
    )
    .run();
  await setSetting(db, "memory_graph_dirty", "1");
}

export async function createResearchResultImport(
  db: D1Database,
  input: {
    id: string;
    missionId: string;
    payload: Record<string, unknown>;
    diff: Record<string, unknown>;
    source?: string;
    expiresAt: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO research_result_imports(
        id, mission_id, status, payload_json, diff_json, source, expires_at, created_at
      ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .bind(input.id, input.missionId, JSON.stringify(input.payload), JSON.stringify(input.diff), input.source ?? "chatgpt-deep-research", input.expiresAt, isoNow())
    .run();
}

export async function getResearchResultImport(db: D1Database, id: string): Promise<ResearchResultImportRecord | null> {
  return db.prepare("SELECT * FROM research_result_imports WHERE id = ?").bind(id).first<ResearchResultImportRecord>();
}

export async function listResearchResultImports(
  db: D1Database,
  input: { missionId?: string; status?: ResearchResultImportRecord["status"]; limit?: number } = {},
): Promise<ResearchResultImportRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (input.missionId) { conditions.push("mission_id = ?"); values.push(input.missionId); }
  if (input.status) { conditions.push("status = ?"); values.push(input.status); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(Math.max(1, Math.min(200, input.limit ?? 50)));
  return rows(
    await db
      .prepare(`SELECT * FROM research_result_imports ${where} ORDER BY created_at DESC LIMIT ?`)
      .bind(...values)
      .all<ResearchResultImportRecord>(),
  );
}

export async function decideResearchResultImport(
  db: D1Database,
  id: string,
  status: "confirmed" | "rejected" | "expired",
): Promise<void> {
  await db
    .prepare("UPDATE research_result_imports SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .bind(status, isoNow(), id)
    .run();
}

export async function expireResearchResultImports(db: D1Database): Promise<void> {
  await db
    .prepare("UPDATE research_result_imports SET status = 'expired', decided_at = ? WHERE status = 'pending' AND datetime(expires_at) <= datetime('now')")
    .bind(isoNow())
    .run();
}

export async function listRecentlyResolvedMissions(db: D1Database, since: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  return rows(
    await db
      .prepare(
        `SELECT m.id, m.name, m.question, m.status, m.priority,
          o.outcome_status, o.outcome_summary, o.resolved_at, o.expected_next_event
         FROM missions m JOIN mission_operators o ON o.mission_id = m.id
         WHERE o.outcome_status != 'open' AND o.resolved_at IS NOT NULL AND datetime(o.resolved_at) >= datetime(?)
         ORDER BY o.resolved_at DESC LIMIT ?`,
      )
      .bind(since, Math.max(1, Math.min(100, limit)))
      .all<Record<string, unknown>>(),
  );
}

export async function restoreTasteTerm(db: D1Database, term: TasteTermRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO taste_terms(term, weight, positive_count, negative_count, last_story_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(term) DO UPDATE SET
         weight = excluded.weight, positive_count = excluded.positive_count,
         negative_count = excluded.negative_count, last_story_id = excluded.last_story_id,
         updated_at = excluded.updated_at`,
    )
    .bind(term.term, term.weight, term.positive_count, term.negative_count, term.last_story_id, term.updated_at || isoNow())
    .run();
}

export async function restoreTasteSource(db: D1Database, source: TasteSourceRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO taste_sources(source_id, weight, positive_count, negative_count, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         weight = excluded.weight, positive_count = excluded.positive_count,
         negative_count = excluded.negative_count, updated_at = excluded.updated_at`,
    )
    .bind(source.source_id, source.weight, source.positive_count, source.negative_count, source.updated_at || isoNow())
    .run();
}

export async function importMissionEvent(
  db: D1Database,
  event: MissionEventRecord,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO mission_events(
        id, mission_id, event_type, title, detail, story_id, metadata_json, occurred_at, created_at, dedupe_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.id, event.mission_id, event.event_type, event.title, event.detail,
      event.story_id, event.metadata_json, event.occurred_at, event.created_at,
      (event as MissionEventRecord & { dedupe_key?: string | null }).dedupe_key ?? null,
    )
    .run();
}


export async function upsertIntelligencePack(
  db: D1Database,
  input: {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    category?: string;
    icon?: string;
    manifest: Record<string, unknown>;
    sourceUrl?: string | null;
    enabled?: boolean;
    budgetProfile?: string;
  },
): Promise<void> {
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO intelligence_packs(
        id, name, version, description, author, category, icon, manifest_json,
        source_url, enabled, budget_profile, installed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        version = excluded.version,
        description = excluded.description,
        author = excluded.author,
        category = excluded.category,
        icon = excluded.icon,
        manifest_json = excluded.manifest_json,
        source_url = COALESCE(excluded.source_url, intelligence_packs.source_url),
        enabled = excluded.enabled,
        budget_profile = excluded.budget_profile,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.name,
      input.version,
      input.description ?? "",
      input.author ?? "",
      input.category ?? "Community",
      input.icon ?? "✦",
      JSON.stringify(input.manifest),
      input.sourceUrl ?? null,
      input.enabled === false ? 0 : 1,
      input.budgetProfile ?? "free",
      now,
      now,
    )
    .run();
}

export async function listIntelligencePacks(db: D1Database): Promise<IntelligencePackRecord[]> {
  return rows(
    await db
      .prepare("SELECT * FROM intelligence_packs ORDER BY enabled DESC, category, name COLLATE NOCASE")
      .all<IntelligencePackRecord>(),
  );
}

export async function getIntelligencePack(db: D1Database, id: string): Promise<IntelligencePackRecord | null> {
  return db.prepare("SELECT * FROM intelligence_packs WHERE id = ?").bind(id).first<IntelligencePackRecord>();
}

export interface MemoryNodeUpsertInput {
  id: string;
  nodeType: MemoryNodeType;
  canonicalKey: string;
  label: string;
  summary?: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
  importance?: number;
  confidence?: number;
  occurredAt?: string | null;
  seenAt?: string;
  status?: MemoryNodeStatus;
  supersededBy?: string | null;
  sourceRef?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
}

// Keep bulk JSON arguments comfortably below D1's bound-value ceiling. Pack
// preview uses the same partitioner, so its statement estimate stays exact.
export const D1_BULK_JSON_SAFE_BYTES = 1_000_000;
const D1_BULK_JSON_ENCODER = new TextEncoder();

function memoryNodeUpsertRow(input: MemoryNodeUpsertInput, defaultNow: string): Record<string, unknown> {
  const now = input.seenAt ?? defaultNow;
  return {
    id: input.id,
    nodeType: input.nodeType,
    canonicalKey: input.canonicalKey,
    label: input.label,
    summary: input.summary ?? "",
    aliasesJson: JSON.stringify(input.aliases ?? []),
    metadataJson: JSON.stringify(input.metadata ?? {}),
    importance: Math.max(0, Math.min(1, input.importance ?? 0.5)),
    confidence: Math.max(0, Math.min(1, input.confidence ?? 0.5)),
    occurredAt: input.occurredAt ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
    status: input.status ?? "active",
    supersededBy: input.supersededBy ?? null,
    sourceRef: input.sourceRef ?? null,
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
  };
}

export function batchMemoryNodeUpserts(inputs: MemoryNodeUpsertInput[]): MemoryNodeUpsertInput[][] {
  if (!inputs.length) return [];
  const defaultNow = isoNow();
  const unique = new Map<string, MemoryNodeUpsertInput>();
  for (const input of inputs) {
    unique.set(`${input.nodeType}\u0000${input.canonicalKey}`, {
      ...input,
      seenAt: input.seenAt ?? defaultNow,
    });
  }
  const batches: MemoryNodeUpsertInput[][] = [];
  let current: MemoryNodeUpsertInput[] = [];
  let currentBytes = 2; // JSON array brackets.
  for (const input of unique.values()) {
    const rowBytes = D1_BULK_JSON_ENCODER.encode(
      JSON.stringify(memoryNodeUpsertRow(input, defaultNow)),
    ).byteLength;
    if (rowBytes + 2 > D1_BULK_JSON_SAFE_BYTES) {
      throw new Error(`Memory node ${input.nodeType}:${input.canonicalKey} exceeds the safe D1 bulk-write size`);
    }
    const separatorBytes = current.length ? 1 : 0;
    if (current.length && currentBytes + separatorBytes + rowBytes > D1_BULK_JSON_SAFE_BYTES) {
      batches.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(input);
    currentBytes += (current.length > 1 ? 1 : 0) + rowBytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

export async function upsertMemoryNode(
  db: D1Database,
  input: MemoryNodeUpsertInput,
): Promise<MemoryNodeRecord> {
  const now = input.seenAt ?? isoNow();
  const saved = await db
    .prepare(
      `INSERT INTO memory_nodes(
        id, node_type, canonical_key, label, summary, aliases_json, metadata_json,
        importance, confidence, occurred_at, first_seen_at, last_seen_at, updated_at,
        status, superseded_by, source_ref, valid_from, valid_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_type, canonical_key) DO UPDATE SET
        label = excluded.label,
        summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE memory_nodes.summary END,
        aliases_json = CASE WHEN excluded.aliases_json <> '[]' THEN excluded.aliases_json ELSE memory_nodes.aliases_json END,
        metadata_json = excluded.metadata_json,
        importance = MAX(memory_nodes.importance, excluded.importance),
        confidence = MAX(memory_nodes.confidence, excluded.confidence),
        occurred_at = COALESCE(excluded.occurred_at, memory_nodes.occurred_at),
        status = excluded.status,
        superseded_by = COALESCE(excluded.superseded_by, memory_nodes.superseded_by),
        source_ref = COALESCE(excluded.source_ref, memory_nodes.source_ref),
        valid_from = COALESCE(excluded.valid_from, memory_nodes.valid_from),
        valid_to = COALESCE(excluded.valid_to, memory_nodes.valid_to),
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
      RETURNING *`,
    )
    .bind(
      input.id,
      input.nodeType,
      input.canonicalKey,
      input.label,
      input.summary ?? "",
      JSON.stringify(input.aliases ?? []),
      JSON.stringify(input.metadata ?? {}),
      Math.max(0, Math.min(1, input.importance ?? 0.5)),
      Math.max(0, Math.min(1, input.confidence ?? 0.5)),
      input.occurredAt ?? null,
      now,
      now,
      now,
      input.status ?? "active",
      input.supersededBy ?? null,
      input.sourceRef ?? null,
      input.validFrom ?? null,
      input.validTo ?? null,
    )
    .first<MemoryNodeRecord>();
  if (!saved) throw new Error(`Memory node could not be persisted: ${input.nodeType}:${input.canonicalKey}`);
  return saved;
}

export async function upsertMemoryNodes(
  db: D1Database,
  inputs: MemoryNodeUpsertInput[],
): Promise<MemoryNodeRecord[]> {
  if (!inputs.length) return [];
  const batches = batchMemoryNodeUpserts(inputs);
  if (batches.length !== 1) {
    throw new Error(`Memory node bulk write requires ${batches.length} bounded statements`);
  }
  const batch = batches[0];
  if (!batch?.length) throw new Error("Memory node bulk write produced no bounded rows");
  const defaultNow = batch[0]?.seenAt ?? isoNow();
  const payload = JSON.stringify(batch.map((input) => memoryNodeUpsertRow(input, defaultNow)));
  const saved = rows(
    await db
      .prepare(
        `INSERT INTO memory_nodes(
          id, node_type, canonical_key, label, summary, aliases_json, metadata_json,
          importance, confidence, occurred_at, first_seen_at, last_seen_at, updated_at,
          status, superseded_by, source_ref, valid_from, valid_to
        )
        SELECT
          CAST(json_extract(item.value, '$.id') AS TEXT),
          CAST(json_extract(item.value, '$.nodeType') AS TEXT),
          CAST(json_extract(item.value, '$.canonicalKey') AS TEXT),
          CAST(json_extract(item.value, '$.label') AS TEXT),
          CAST(json_extract(item.value, '$.summary') AS TEXT),
          CAST(json_extract(item.value, '$.aliasesJson') AS TEXT),
          CAST(json_extract(item.value, '$.metadataJson') AS TEXT),
          CAST(json_extract(item.value, '$.importance') AS REAL),
          CAST(json_extract(item.value, '$.confidence') AS REAL),
          CAST(json_extract(item.value, '$.occurredAt') AS TEXT),
          CAST(json_extract(item.value, '$.firstSeenAt') AS TEXT),
          CAST(json_extract(item.value, '$.lastSeenAt') AS TEXT),
          CAST(json_extract(item.value, '$.updatedAt') AS TEXT),
          CAST(json_extract(item.value, '$.status') AS TEXT),
          CAST(json_extract(item.value, '$.supersededBy') AS TEXT),
          CAST(json_extract(item.value, '$.sourceRef') AS TEXT),
          CAST(json_extract(item.value, '$.validFrom') AS TEXT),
          CAST(json_extract(item.value, '$.validTo') AS TEXT)
        FROM json_each(?) AS item
        WHERE true
        ON CONFLICT(node_type, canonical_key) DO UPDATE SET
          label = excluded.label,
          summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE memory_nodes.summary END,
          aliases_json = CASE WHEN excluded.aliases_json <> '[]' THEN excluded.aliases_json ELSE memory_nodes.aliases_json END,
          metadata_json = excluded.metadata_json,
          importance = MAX(memory_nodes.importance, excluded.importance),
          confidence = MAX(memory_nodes.confidence, excluded.confidence),
          occurred_at = COALESCE(excluded.occurred_at, memory_nodes.occurred_at),
          status = excluded.status,
          superseded_by = COALESCE(excluded.superseded_by, memory_nodes.superseded_by),
          source_ref = COALESCE(excluded.source_ref, memory_nodes.source_ref),
          valid_from = COALESCE(excluded.valid_from, memory_nodes.valid_from),
          valid_to = COALESCE(excluded.valid_to, memory_nodes.valid_to),
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
        RETURNING *`,
      )
      .bind(payload)
      .all<MemoryNodeRecord>(),
  );
  if (saved.length !== batch.length) {
    throw new Error(`Memory node batch persisted ${saved.length} of ${batch.length} canonical rows`);
  }
  return saved;
}

export interface MemoryEdgeUpsertInput {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relation: MemoryRelation;
  weight?: number;
  confidence?: number;
  evidence?: string[];
  metadata?: Record<string, unknown>;
  seenAt?: string;
  status?: "active" | "superseded" | "retracted";
  rationale?: string;
}

export async function upsertMemoryEdge(
  db: D1Database,
  input: MemoryEdgeUpsertInput,
): Promise<void> {
  const now = input.seenAt ?? isoNow();
  await db
    .prepare(
      `INSERT INTO memory_edges(
        id, from_node_id, to_node_id, relation, weight, confidence,
        evidence_json, metadata_json, first_seen_at, last_seen_at, updated_at, status, rationale
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_node_id, to_node_id, relation) DO UPDATE SET
        weight = MAX(memory_edges.weight, excluded.weight),
        confidence = MAX(memory_edges.confidence, excluded.confidence),
        evidence_json = excluded.evidence_json,
        metadata_json = excluded.metadata_json,
        status = excluded.status,
        rationale = CASE WHEN excluded.rationale <> '' THEN excluded.rationale ELSE memory_edges.rationale END,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.fromNodeId,
      input.toNodeId,
      input.relation,
      Math.max(0, Math.min(1, input.weight ?? 0.5)),
      Math.max(0, Math.min(1, input.confidence ?? 0.5)),
      JSON.stringify(input.evidence ?? []),
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
      now,
      input.status ?? "active",
      input.rationale ?? "",
    )
    .run();
}

export async function upsertMemoryEdges(
  db: D1Database,
  inputs: MemoryEdgeUpsertInput[],
): Promise<void> {
  if (!inputs.length) return;
  const defaultNow = isoNow();
  const unique = new Map<string, Record<string, unknown>>();
  for (const input of inputs) {
    const now = input.seenAt ?? defaultNow;
    unique.set(`${input.fromNodeId}\u0000${input.toNodeId}\u0000${input.relation}`, {
      id: input.id,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      relation: input.relation,
      weight: Math.max(0, Math.min(1, input.weight ?? 0.5)),
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.5)),
      evidenceJson: JSON.stringify(input.evidence ?? []),
      metadataJson: JSON.stringify(input.metadata ?? {}),
      firstSeenAt: now,
      lastSeenAt: now,
      updatedAt: now,
      status: input.status ?? "active",
      rationale: input.rationale ?? "",
    });
  }
  const payload = JSON.stringify([...unique.values()]);
  if (D1_BULK_JSON_ENCODER.encode(payload).byteLength > D1_BULK_JSON_SAFE_BYTES) {
    throw new Error(`Memory edge bulk write exceeds the safe D1 bulk-write size for ${unique.size} rows`);
  }
  await db
    .prepare(
      `INSERT INTO memory_edges(
        id, from_node_id, to_node_id, relation, weight, confidence,
        evidence_json, metadata_json, first_seen_at, last_seen_at, updated_at, status, rationale
      )
      SELECT
        CAST(json_extract(item.value, '$.id') AS TEXT),
        CAST(json_extract(item.value, '$.fromNodeId') AS TEXT),
        CAST(json_extract(item.value, '$.toNodeId') AS TEXT),
        CAST(json_extract(item.value, '$.relation') AS TEXT),
        CAST(json_extract(item.value, '$.weight') AS REAL),
        CAST(json_extract(item.value, '$.confidence') AS REAL),
        CAST(json_extract(item.value, '$.evidenceJson') AS TEXT),
        CAST(json_extract(item.value, '$.metadataJson') AS TEXT),
        CAST(json_extract(item.value, '$.firstSeenAt') AS TEXT),
        CAST(json_extract(item.value, '$.lastSeenAt') AS TEXT),
        CAST(json_extract(item.value, '$.updatedAt') AS TEXT),
        CAST(json_extract(item.value, '$.status') AS TEXT),
        CAST(json_extract(item.value, '$.rationale') AS TEXT)
      FROM json_each(?) AS item
      WHERE true
      ON CONFLICT(from_node_id, to_node_id, relation) DO UPDATE SET
        weight = MAX(memory_edges.weight, excluded.weight),
        confidence = MAX(memory_edges.confidence, excluded.confidence),
        evidence_json = excluded.evidence_json,
        metadata_json = excluded.metadata_json,
        status = excluded.status,
        rationale = CASE WHEN excluded.rationale <> '' THEN excluded.rationale ELSE memory_edges.rationale END,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at`,
    )
    .bind(payload)
    .run();
}

export async function getMemoryNode(db: D1Database, id: string): Promise<MemoryNodeRecord | null> {
  return db.prepare("SELECT * FROM memory_nodes WHERE id = ?").bind(id).first<MemoryNodeRecord>();
}

export async function listMemoryNodesByIds(db: D1Database, nodeIds: string[]): Promise<MemoryNodeRecord[]> {
  const ids = [...new Set(nodeIds)].slice(0, 80);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const found = rows(
    await db
      .prepare(`SELECT * FROM memory_nodes WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<MemoryNodeRecord>(),
  );
  const byId = new Map(found.map((node) => [node.id, node]));
  return ids.flatMap((id) => {
    const node = byId.get(id);
    return node ? [node] : [];
  });
}

function boundedMemoryLikeQuery(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\\%_]+/g, " ")
    .replace(/[^a-z0-9+.#@:/ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "%";
  const encoder = new TextEncoder();
  let bounded = "";
  for (const token of normalized.split(" ")) {
    const next = bounded ? `${bounded} ${token}` : token;
    if (encoder.encode(next).byteLength > 40) break;
    bounded = next;
  }
  if (!bounded) {
    let output = "";
    for (const character of normalized) {
      if (encoder.encode(output + character).byteLength > 40) break;
      output += character;
    }
    bounded = output;
  }
  return `%${bounded}%`;
}

export async function listMemoryNodes(
  db: D1Database,
  options: { nodeType?: MemoryNodeType; limit?: number; query?: string; contextFirst?: boolean } = {},
): Promise<MemoryNodeRecord[]> {
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  if (options.query) {
    const query = boundedMemoryLikeQuery(options.query);
    if (options.nodeType) {
      return rows(
        await db
          .prepare(
            `SELECT * FROM memory_nodes
             WHERE node_type = ? AND (
               lower(label) LIKE ? OR lower(summary) LIKE ? OR lower(aliases_json) LIKE ?
             ) ORDER BY importance DESC, last_seen_at DESC, id ASC LIMIT ?`,
          )
          .bind(options.nodeType, query, query, query, limit)
          .all<MemoryNodeRecord>(),
      );
    }
    return rows(
      await db
        .prepare(
           `SELECT * FROM memory_nodes
           WHERE lower(label) LIKE ? OR lower(summary) LIKE ? OR lower(aliases_json) LIKE ?
           ORDER BY importance DESC, last_seen_at DESC, id ASC LIMIT ?`,
        )
        .bind(query, query, query, limit)
        .all<MemoryNodeRecord>(),
    );
  }
  if (options.nodeType) {
    return rows(
      await db
        .prepare("SELECT * FROM memory_nodes WHERE node_type = ? ORDER BY importance DESC, last_seen_at DESC, id ASC LIMIT ?")
        .bind(options.nodeType, limit)
        .all<MemoryNodeRecord>(),
    );
  }
  if (options.contextFirst) {
    return rows(
      await db
        .prepare(
          `SELECT * FROM memory_nodes
           ORDER BY CASE
             WHEN status = 'active' AND node_type IN ('mission', 'decision', 'question', 'finding', 'expectation', 'outcome') THEN 0
             ELSE 1
           END,
           importance DESC,
           last_seen_at DESC,
           id ASC
           LIMIT ?`,
        )
        .bind(limit)
        .all<MemoryNodeRecord>(),
    );
  }
  return rows(
    await db
      .prepare("SELECT * FROM memory_nodes ORDER BY importance DESC, last_seen_at DESC, id ASC LIMIT ?")
      .bind(limit)
      .all<MemoryNodeRecord>(),
  );
}

export async function listMemoryEdgesForNodes(
  db: D1Database,
  nodeIds: string[],
  limit = 300,
  options: { includeStoryClaimMirrors?: boolean } = {},
): Promise<MemoryEdgeRecord[]> {
  const ids = [...new Set(nodeIds)].slice(0, 80);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  if (options.includeStoryClaimMirrors) {
    return rows(
      await db
        .prepare(
          `WITH anchors(id) AS (
             SELECT id FROM memory_nodes WHERE id IN (${placeholders})
             UNION
             SELECT mirror.id
             FROM memory_nodes seed
             JOIN memory_nodes mirror
               ON mirror.source_ref = seed.source_ref
              AND mirror.node_type IN ('story', 'claim')
             WHERE seed.id IN (${placeholders})
               AND seed.node_type IN ('story', 'claim')
               AND seed.source_ref LIKE 'story:%'
           )
           SELECT edge.* FROM memory_edges edge
           WHERE edge.from_node_id IN (SELECT id FROM anchors)
              OR edge.to_node_id IN (SELECT id FROM anchors)
           ORDER BY edge.weight DESC, edge.last_seen_at DESC, edge.id ASC LIMIT ?`,
        )
        .bind(...ids, ...ids, Math.max(1, Math.min(1_000, limit)))
        .all<MemoryEdgeRecord>(),
    );
  }
  return rows(
    await db
      .prepare(
        `SELECT * FROM memory_edges
         WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})
         ORDER BY weight DESC, last_seen_at DESC, id ASC LIMIT ?`,
      )
      .bind(...ids, ...ids, Math.max(1, Math.min(1_000, limit)))
      .all<MemoryEdgeRecord>(),
  );
}

export async function listMemoryEdges(db: D1Database, limit = 2_000): Promise<MemoryEdgeRecord[]> {
  return rows(
    await db
      .prepare("SELECT * FROM memory_edges ORDER BY weight DESC, last_seen_at DESC LIMIT ?")
      .bind(Math.max(1, Math.min(5_000, limit)))
      .all<MemoryEdgeRecord>(),
  );
}

export async function memoryGraphStats(db: D1Database): Promise<Record<string, number>> {
  const [nodes, edges] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM memory_nodes").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM memory_edges").first<{ count: number }>(),
  ]);
  const byType = rows(
    await db.prepare("SELECT node_type, COUNT(*) AS count FROM memory_nodes GROUP BY node_type").all<{ node_type: string; count: number }>(),
  );
  return Object.fromEntries([
    ["nodes", Number(nodes?.count ?? 0)],
    ["edges", Number(edges?.count ?? 0)],
    ...byType.map((row) => [`type:${row.node_type}`, Number(row.count)]),
  ]);
}

export async function pruneMemoryGraph(db: D1Database, before: string): Promise<{ nodes: number; edges: number }> {
  const edgeResult = await db
    .prepare("DELETE FROM memory_edges WHERE last_seen_at < ? AND weight < 0.5")
    .bind(before)
    .run();
  const nodeResult = await db
    .prepare(
      `DELETE FROM memory_nodes
       WHERE node_type IN ('story', 'source', 'finding', 'question')
         AND last_seen_at < ?
         AND importance < 0.55
         AND NOT EXISTS (
           SELECT 1 FROM memory_edges
           WHERE from_node_id = memory_nodes.id OR to_node_id = memory_nodes.id
         )`,
    )
    .bind(before)
    .run();
  return {
    nodes: Number(nodeResult.meta?.changes ?? 0),
    edges: Number(edgeResult.meta?.changes ?? 0),
  };
}

export async function recordUsage(
  db: D1Database,
  dimension: UsageDimension,
  units: number,
  metadata: Record<string, unknown> = {},
  day = isoNow().slice(0, 10),
): Promise<void> {
  if (!Number.isFinite(units) || units <= 0) return;
  await db
    .prepare(
      `INSERT INTO usage_daily(day, dimension, units, metadata_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day, dimension) DO UPDATE SET
         units = usage_daily.units + excluded.units,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    )
    .bind(day, dimension, units, JSON.stringify(metadata), isoNow())
    .run();
}

export async function getUsageDaily(db: D1Database, day = isoNow().slice(0, 10)): Promise<UsageDailyRecord[]> {
  return rows(
    await db
      .prepare("SELECT * FROM usage_daily WHERE day = ? ORDER BY dimension")
      .bind(day)
      .all<UsageDailyRecord>(),
  );
}

function usageMonthBounds(month: string): { monthStart: string; nextMonthStart: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new RangeError("Usage month must use YYYY-MM");
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonthNumber = monthNumber === 12 ? 1 : monthNumber + 1;
  return {
    monthStart: `${month}-01`,
    nextMonthStart: `${String(nextYear).padStart(4, "0")}-${String(nextMonthNumber).padStart(2, "0")}-01`,
  };
}

export async function getUsageMonth(db: D1Database, month = isoNow().slice(0, 7)): Promise<Array<{ dimension: UsageDimension; units: number }>> {
  const { monthStart, nextMonthStart } = usageMonthBounds(month);
  return rows(
    await db
      .prepare(
        `SELECT dimension, SUM(units) AS units
         FROM usage_daily
         WHERE day >= ? AND day < ?
         GROUP BY dimension ORDER BY dimension`,
      )
      .bind(monthStart, nextMonthStart)
      .all<{ dimension: UsageDimension; units: number }>(),
  );
}


export async function getMemoryNodeByKey(
  db: D1Database,
  nodeType: MemoryNodeType,
  canonicalKey: string,
): Promise<MemoryNodeRecord | null> {
  return db
    .prepare("SELECT * FROM memory_nodes WHERE node_type = ? AND canonical_key = ?")
    .bind(nodeType, canonicalKey)
    .first<MemoryNodeRecord>();
}

export async function createMemoryProposal(
  db: D1Database,
  input: {
    id: string;
    scopeKind: MemoryProposalRecord["scope_kind"];
    scopeId?: string | null;
    provider: string;
    title: string;
    patch: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memory_proposals(id, scope_kind, scope_id, provider, title, patch_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(input.id, input.scopeKind, input.scopeId ?? null, input.provider, input.title, JSON.stringify(input.patch), isoNow())
    .run();
}

export async function getMemoryProposal(db: D1Database, id: string): Promise<MemoryProposalRecord | null> {
  return db.prepare("SELECT * FROM memory_proposals WHERE id = ?").bind(id).first<MemoryProposalRecord>();
}

export async function listMemoryProposals(
  db: D1Database,
  options: { status?: MemoryProposalRecord["status"]; scopeKind?: string; scopeId?: string; limit?: number } = {},
): Promise<MemoryProposalRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.status) { clauses.push("status = ?"); values.push(options.status); }
  if (options.scopeKind) { clauses.push("scope_kind = ?"); values.push(options.scopeKind); }
  if (options.scopeId) { clauses.push("scope_id = ?"); values.push(options.scopeId); }
  values.push(Math.max(1, Math.min(200, options.limit ?? 50)));
  return rows(
    await db
      .prepare(`SELECT * FROM memory_proposals ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`)
      .bind(...values)
      .all<MemoryProposalRecord>(),
  );
}

export async function decideMemoryProposal(
  db: D1Database,
  id: string,
  status: "approved" | "rejected" | "expired",
  note?: string,
): Promise<void> {
  await db
    .prepare("UPDATE memory_proposals SET status = ?, decided_at = ?, decision_note = ? WHERE id = ?")
    .bind(status, isoNow(), note ?? null, id)
    .run();
}

export async function updateMemoryNodeStatus(
  db: D1Database,
  id: string,
  status: MemoryNodeStatus,
  supersededBy?: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE memory_nodes SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ?")
    .bind(status, supersededBy ?? null, isoNow(), id)
    .run();
}

export async function recordIntelligencePackEvent(
  db: D1Database,
  input: { id: string; packId: string; eventType: string; fromVersion?: string | null; toVersion?: string | null; detail?: Record<string, unknown> },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO intelligence_pack_events(id, pack_id, event_type, from_version, to_version, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.id, input.packId, input.eventType, input.fromVersion ?? null, input.toVersion ?? null, JSON.stringify(input.detail ?? {}), isoNow())
    .run();
}


export async function upsertReasoningPlaybook(
  db: D1Database,
  input: {
    id: string;
    packId?: string | null;
    name: string;
    task: ReasoningPlaybookRecord["task"];
    instructions: string;
    trigger?: Record<string, unknown>;
    providerHints?: Record<string, string>;
    enabled?: boolean;
  },
): Promise<void> {
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO reasoning_playbooks(
        id, pack_id, name, task, instructions, trigger_json, provider_hints_json, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        pack_id = excluded.pack_id,
        name = excluded.name,
        task = excluded.task,
        instructions = excluded.instructions,
        trigger_json = excluded.trigger_json,
        provider_hints_json = excluded.provider_hints_json,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.packId ?? null,
      input.name,
      input.task,
      input.instructions,
      JSON.stringify(input.trigger ?? {}),
      JSON.stringify(input.providerHints ?? {}),
      input.enabled === false ? 0 : 1,
      now,
      now,
    )
    .run();
}

export async function listReasoningPlaybooks(
  db: D1Database,
  options: { task?: ReasoningPlaybookRecord["task"]; packId?: string; enabled?: boolean; limit?: number } = {},
): Promise<ReasoningPlaybookRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.task) { clauses.push("task = ?"); values.push(options.task); }
  if (options.packId) { clauses.push("pack_id = ?"); values.push(options.packId); }
  if (options.enabled !== undefined) { clauses.push("enabled = ?"); values.push(options.enabled ? 1 : 0); }
  values.push(Math.max(1, Math.min(200, options.limit ?? 50)));
  return rows(
    await db
      .prepare(
        `SELECT * FROM reasoning_playbooks
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY enabled DESC, name COLLATE NOCASE LIMIT ?`,
      )
      .bind(...values)
      .all<ReasoningPlaybookRecord>(),
  );
}

export async function electMemoryGraphRun(
  db: D1Database,
  id: string,
  details: Record<string, unknown> = {},
  options: { status?: MemoryGraphRunRecord["status"]; workflowId?: string | null; profile?: string; phase?: string } = {},
): Promise<{ created: boolean; run: MemoryGraphRunRecord }> {
  const now = isoNow();
  const results = await db.batch<MemoryGraphRunRecord>([
    db.prepare(
      `INSERT INTO memory_graph_runs(
         id, status, details_json, started_at, workflow_id, profile, phase, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM memory_graph_runs WHERE status IN ('queued', 'running')
       )`,
    ).bind(
      id,
      options.status ?? "queued",
      JSON.stringify(details),
      now,
      options.workflowId ?? null,
      options.profile ?? "free",
      options.phase ?? "queued",
      now,
    ),
    db.prepare(
      `SELECT * FROM memory_graph_runs
       WHERE status IN ('queued', 'running')
       ORDER BY started_at DESC LIMIT 1`,
    ),
  ]);
  const insert = results[0];
  const active = results[1];
  if (!insert || !active) throw new Error("Memory Graph refresh election returned an incomplete D1 batch");
  const run = active.results?.[0];
  if (!run) throw new Error("Memory Graph refresh election completed without an active run");
  return { created: Number(insert.meta?.changes ?? 0) > 0, run };
}

export async function updateMemoryGraphRun(
  db: D1Database,
  id: string,
  input: {
    status?: MemoryGraphRunRecord["status"];
    workflowId?: string | null;
    profile?: string;
    phase?: string;
    nodeWrites?: number;
    edgeWrites?: number;
    details?: Record<string, unknown>;
    error?: string | null;
  },
): Promise<void> {
  const current = await db.prepare("SELECT * FROM memory_graph_runs WHERE id = ?").bind(id).first<MemoryGraphRunRecord>();
  if (!current) throw new Error(`Memory Graph run not found: ${id}`);
  await db
    .prepare(
      `UPDATE memory_graph_runs SET
         status = ?, workflow_id = ?, profile = ?, phase = ?,
         node_writes = ?, edge_writes = ?, details_json = ?, error = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.status ?? current.status,
      input.workflowId === undefined ? current.workflow_id : input.workflowId,
      input.profile ?? current.profile,
      input.phase ?? current.phase,
      Math.max(0, input.nodeWrites ?? current.node_writes),
      Math.max(0, input.edgeWrites ?? current.edge_writes),
      JSON.stringify(input.details ?? parseJson<Record<string, unknown>>(current.details_json, {})),
      input.error === undefined ? current.error : input.error,
      isoNow(),
      id,
    )
    .run();
}

export async function finishMemoryGraphRun(
  db: D1Database,
  input: { id: string; status: "complete" | "partial" | "deferred" | "failed"; nodeWrites?: number; edgeWrites?: number; details?: Record<string, unknown>; error?: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE memory_graph_runs SET
         status = ?, node_writes = ?, edge_writes = ?, details_json = ?, error = ?,
         phase = 'complete', completed_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.status,
      Math.max(0, input.nodeWrites ?? 0),
      Math.max(0, input.edgeWrites ?? 0),
      JSON.stringify(input.details ?? {}),
      input.error ?? null,
      isoNow(),
      isoNow(),
      input.id,
    )
    .run();
}

export async function getActiveMemoryGraphRun(db: D1Database): Promise<MemoryGraphRunRecord | null> {
  return db
    .prepare(
      `SELECT * FROM memory_graph_runs
       WHERE status IN ('queued', 'running')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .first<MemoryGraphRunRecord>();
}

export async function failStaleMemoryGraphRun(
  db: D1Database,
  id: string,
  staleBefore: string,
  error: string,
): Promise<boolean> {
  const now = isoNow();
  const result = await db
    .prepare(
      `UPDATE memory_graph_runs
       SET status = 'failed', phase = 'complete',
           error = COALESCE(error, ?),
           completed_at = COALESCE(completed_at, ?), updated_at = ?
       WHERE id = ? AND status IN ('queued', 'running')
         AND datetime(updated_at) < datetime(?)`,
    )
    .bind(error, now, now, id, staleBefore)
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function getMemoryGraphRun(db: D1Database, id: string): Promise<MemoryGraphRunRecord | null> {
  return db.prepare("SELECT * FROM memory_graph_runs WHERE id = ?").bind(id).first<MemoryGraphRunRecord>();
}

export async function listMemoryGraphRuns(db: D1Database, limit = 20): Promise<MemoryGraphRunRecord[]> {
  return rows(
    await db
      .prepare("SELECT * FROM memory_graph_runs ORDER BY started_at DESC LIMIT ?")
      .bind(Math.max(1, Math.min(100, limit)))
      .all<MemoryGraphRunRecord>(),
  );
}

export interface StoryEvidenceSummaryRow {
  story_id: string;
  item_id: string;
  source_id: string;
  source_name: string;
  source_kind: string;
  source_config_json: string;
  source_health_score: number;
  source_weight: number;
  title: string;
  url: string | null;
  author: string | null;
  published_at: string | null;
  observed_at: string;
  access_class: string;
  metadata_json: string;
  text: string;
  family_key: string | null;
  origin_item_id: string | null;
  origin_family_key: string | null;
  lineage_relation: string | null;
  title_similarity: number | null;
  body_similarity: number | null;
  lineage_independent: number | null;
  lineage_rationale: string | null;
  /** Present on the reasoning projection when this Story has material beyond its indexed candidate window. */
  story_window_has_more?: number;
}

export async function listStoryEvidenceSummary(
  db: D1Database,
  storyIds: string[],
  limit = 300,
): Promise<StoryEvidenceSummaryRow[]> {
  const ids = [...new Set(storyIds)].slice(0, 80);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return rows(
    await db
      .prepare(
        `SELECT si.story_id, i.id AS item_id, i.source_id, s.name AS source_name, s.kind AS source_kind,
                s.config_json AS source_config_json, s.health_score AS source_health_score, s.weight AS source_weight,
                i.title, i.url, i.author, i.published_at, i.observed_at, i.access_class, i.metadata_json,
                substr(i.text, 1, 8192) AS text,
                el.family_key, el.origin_item_id, el.origin_family_key, el.relation AS lineage_relation,
                el.title_similarity, el.body_similarity, el.independent AS lineage_independent,
                el.rationale AS lineage_rationale
         FROM story_items si
         JOIN items i ON i.id = si.item_id
         JOIN sources s ON s.id = i.source_id
         LEFT JOIN evidence_lineage el ON el.item_id = i.id
         WHERE si.story_id IN (${placeholders})
         ORDER BY i.observed_at DESC, i.id ASC, si.story_id ASC, i.source_id ASC
         LIMIT ?`,
      )
      .bind(...ids, Math.max(1, Math.min(2_000, limit)))
      .all(),
  ) as StoryEvidenceSummaryRow[];
}

export const REASONING_EVIDENCE_ROW_LIMIT = 81;
export const REASONING_EVIDENCE_STORY_LIMIT = 20;
export const REASONING_EVIDENCE_STORY_CANDIDATE_LIMIT = 48;
export const REASONING_EVIDENCE_STORY_CANDIDATE_SENTINEL_LIMIT = REASONING_EVIDENCE_STORY_CANDIDATE_LIMIT + 1;
export const REASONING_EVIDENCE_TEXT_CHARACTERS = 1_600;
export const REASONING_EVIDENCE_STORY_ID_CHARACTERS = 128;
export const REASONING_EVIDENCE_ITEM_ID_CHARACTERS = 128;
export const REASONING_EVIDENCE_SOURCE_ID_CHARACTERS = 128;
export const REASONING_EVIDENCE_SOURCE_NAME_CHARACTERS = 160;
export const REASONING_EVIDENCE_SOURCE_KIND_CHARACTERS = 100;
export const REASONING_EVIDENCE_SOURCE_CONFIG_CHARACTERS = 2_048;
export const REASONING_EVIDENCE_TITLE_CHARACTERS = 400;
export const REASONING_EVIDENCE_URL_CHARACTERS = 512;
export const REASONING_EVIDENCE_AUTHOR_CHARACTERS = 200;
export const REASONING_EVIDENCE_TIMESTAMP_CHARACTERS = 64;
export const REASONING_EVIDENCE_ACCESS_CLASS_CHARACTERS = 64;
export const REASONING_EVIDENCE_METADATA_CHARACTERS = 4_096;
export const REASONING_EVIDENCE_LINEAGE_KEY_CHARACTERS = 128;
export const REASONING_EVIDENCE_LINEAGE_RELATION_CHARACTERS = 100;
export const REASONING_EVIDENCE_LINEAGE_RATIONALE_CHARACTERS = 600;

/**
 * Reasoning receives at most 80 evidence rows plus one coverage sentinel. The
 * projection clips every string inside D1, before the Worker allocates it.
 * Only the config and metadata keys used by reasoning cross the boundary;
 * oversized or malformed JSON becomes an empty object.
 */
export async function listReasoningEvidenceSummary(
  db: D1Database,
  storyIds: string[],
  limit = REASONING_EVIDENCE_ROW_LIMIT,
): Promise<StoryEvidenceSummaryRow[]> {
  const ids = [...new Set(storyIds)].slice(0, REASONING_EVIDENCE_STORY_LIMIT);
  if (!ids.length) return [];
  return rows(
    await db
      .prepare(
        `WITH RECURSIVE
         requested(story_id, story_order) AS (
           SELECT CAST(value AS TEXT), CAST(key AS INTEGER) FROM json_each(?)
         ),
         candidate_links(story_id, story_order, item_id, evidence_rank) AS (
           SELECT requested.story_id, requested.story_order,
                  (
                    SELECT first_link.item_id
                    FROM story_items first_link INDEXED BY idx_story_items_match_recent
                    WHERE first_link.story_id = requested.story_id
                    ORDER BY first_link.created_at DESC, first_link.item_id ASC
                    LIMIT 1
                  ),
                  1
           FROM requested
           UNION ALL
           SELECT candidate.story_id, candidate.story_order,
                  (
                    SELECT next_link.item_id
                    FROM story_items next_link INDEXED BY idx_story_items_match_recent
                    WHERE next_link.story_id = candidate.story_id
                      AND (
                        next_link.created_at < current_link.created_at
                        OR (
                          next_link.created_at = current_link.created_at
                          AND next_link.item_id > current_link.item_id
                        )
                      )
                    ORDER BY next_link.created_at DESC, next_link.item_id ASC
                    LIMIT 1
                  ),
                  candidate.evidence_rank + 1
           FROM candidate_links candidate
           JOIN story_items current_link
             ON current_link.story_id = candidate.story_id
            AND current_link.item_id = candidate.item_id
           WHERE candidate.item_id IS NOT NULL
             AND candidate.evidence_rank < ${REASONING_EVIDENCE_STORY_CANDIDATE_SENTINEL_LIMIT}
         )
         SELECT substr(si.story_id, 1, ${REASONING_EVIDENCE_STORY_ID_CHARACTERS}) AS story_id,
                substr(i.id, 1, ${REASONING_EVIDENCE_ITEM_ID_CHARACTERS}) AS item_id,
                substr(i.source_id, 1, ${REASONING_EVIDENCE_SOURCE_ID_CHARACTERS}) AS source_id,
                substr(s.name, 1, ${REASONING_EVIDENCE_SOURCE_NAME_CHARACTERS}) AS source_name,
                substr(s.kind, 1, ${REASONING_EVIDENCE_SOURCE_KIND_CHARACTERS}) AS source_kind,
                CASE WHEN length(substr(s.config_json, 1, ${REASONING_EVIDENCE_SOURCE_CONFIG_CHARACTERS + 1}))
                           <= ${REASONING_EVIDENCE_SOURCE_CONFIG_CHARACTERS}
                       AND json_valid(substr(s.config_json, 1, ${REASONING_EVIDENCE_SOURCE_CONFIG_CHARACTERS}))
                  THEN json_object(
                    'evidenceRole', CASE
                      WHEN json_type(s.config_json, '$.evidenceRole') = 'text'
                           AND length(json_extract(s.config_json, '$.evidenceRole')) <= 32
                        THEN json_extract(s.config_json, '$.evidenceRole') ELSE NULL END,
                    'primarySource', CASE
                      WHEN json_type(s.config_json, '$.primarySource') = 'true' THEN json('true')
                      ELSE json('false') END
                  )
                  ELSE '{}' END AS source_config_json,
                s.health_score AS source_health_score, s.weight AS source_weight,
                substr(i.title, 1, ${REASONING_EVIDENCE_TITLE_CHARACTERS}) AS title,
                CASE WHEN i.url IS NULL THEN NULL ELSE substr(i.url, 1, ${REASONING_EVIDENCE_URL_CHARACTERS}) END AS url,
                CASE WHEN i.author IS NULL THEN NULL ELSE substr(i.author, 1, ${REASONING_EVIDENCE_AUTHOR_CHARACTERS}) END AS author,
                CASE WHEN i.published_at IS NULL THEN NULL
                  ELSE substr(i.published_at, 1, ${REASONING_EVIDENCE_TIMESTAMP_CHARACTERS}) END AS published_at,
                substr(i.observed_at, 1, ${REASONING_EVIDENCE_TIMESTAMP_CHARACTERS}) AS observed_at,
                substr(i.access_class, 1, ${REASONING_EVIDENCE_ACCESS_CLASS_CHARACTERS}) AS access_class,
                CASE WHEN length(substr(i.metadata_json, 1, ${REASONING_EVIDENCE_METADATA_CHARACTERS + 1}))
                           <= ${REASONING_EVIDENCE_METADATA_CHARACTERS}
                       AND json_valid(substr(i.metadata_json, 1, ${REASONING_EVIDENCE_METADATA_CHARACTERS}))
                  THEN json_object(
                    'evidenceRole', CASE
                      WHEN json_type(i.metadata_json, '$.evidenceRole') = 'text'
                           AND length(json_extract(i.metadata_json, '$.evidenceRole')) <= 32
                        THEN json_extract(i.metadata_json, '$.evidenceRole') ELSE NULL END,
                    'provider', CASE
                      WHEN json_type(i.metadata_json, '$.provider') = 'text'
                           AND length(json_extract(i.metadata_json, '$.provider')) <= 64
                        THEN json_extract(i.metadata_json, '$.provider') ELSE NULL END,
                    'operation', CASE
                      WHEN json_type(i.metadata_json, '$.operation') = 'text'
                           AND length(json_extract(i.metadata_json, '$.operation')) <= 64
                        THEN json_extract(i.metadata_json, '$.operation') ELSE NULL END
                  )
                  ELSE '{}' END AS metadata_json,
                substr(i.text, 1, ${REASONING_EVIDENCE_TEXT_CHARACTERS}) AS text,
                CASE WHEN el.family_key IS NULL THEN NULL
                  ELSE substr(el.family_key, 1, ${REASONING_EVIDENCE_LINEAGE_KEY_CHARACTERS}) END AS family_key,
                CASE WHEN el.origin_item_id IS NULL THEN NULL
                  ELSE substr(el.origin_item_id, 1, ${REASONING_EVIDENCE_LINEAGE_KEY_CHARACTERS}) END AS origin_item_id,
                CASE WHEN el.origin_family_key IS NULL THEN NULL
                  ELSE substr(el.origin_family_key, 1, ${REASONING_EVIDENCE_LINEAGE_KEY_CHARACTERS}) END AS origin_family_key,
                CASE WHEN el.relation IS NULL THEN NULL
                  ELSE substr(el.relation, 1, ${REASONING_EVIDENCE_LINEAGE_RELATION_CHARACTERS}) END AS lineage_relation,
                el.title_similarity, el.body_similarity, el.independent AS lineage_independent,
                CASE WHEN el.rationale IS NULL THEN NULL
                  ELSE substr(el.rationale, 1, ${REASONING_EVIDENCE_LINEAGE_RATIONALE_CHARACTERS}) END AS lineage_rationale,
                EXISTS (
                  SELECT 1 FROM candidate_links sentinel
                  WHERE sentinel.story_id = si.story_id
                    AND sentinel.evidence_rank = ${REASONING_EVIDENCE_STORY_CANDIDATE_SENTINEL_LIMIT}
                    AND sentinel.item_id IS NOT NULL
                ) AS story_window_has_more
         FROM candidate_links si
         JOIN items i ON i.id = si.item_id
         JOIN sources s ON s.id = i.source_id
         LEFT JOIN evidence_lineage el ON el.item_id = i.id
         WHERE si.item_id IS NOT NULL
           AND si.evidence_rank <= ${REASONING_EVIDENCE_STORY_CANDIDATE_LIMIT}
         ORDER BY si.evidence_rank ASC, i.observed_at DESC, i.id ASC, si.story_id ASC, i.source_id ASC
         LIMIT ?`,
      )
      .bind(JSON.stringify(ids), Math.max(1, Math.min(REASONING_EVIDENCE_ROW_LIMIT, Math.floor(limit))))
      .all<StoryEvidenceSummaryRow>(),
  );
}

export async function reserveUsage(
  db: D1Database,
  dimension: UsageDimension,
  units: number,
  limit: number,
  metadata: Record<string, unknown> = {},
  day = isoNow().slice(0, 10),
): Promise<{ reserved: boolean; used: number }> {
  if (!Number.isFinite(units) || units <= 0) return { reserved: true, used: 0 };
  const boundedLimit = Math.max(0, limit);
  // The ON CONFLICT predicate below only guards updates. Reject an oversized
  // first reservation explicitly so a new lane cannot leap past its ceiling.
  if (units > boundedLimit) {
    const existing = await db
      .prepare("SELECT units FROM usage_daily WHERE day = ? AND dimension = ?")
      .bind(day, dimension)
      .first<{ units: number }>();
    return { reserved: false, used: Number(existing?.units ?? 0) };
  }
  const result = await db
    .prepare(
      `INSERT INTO usage_daily(day, dimension, units, metadata_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day, dimension) DO UPDATE SET
         units = usage_daily.units + excluded.units,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at
       WHERE usage_daily.units + excluded.units <= ?`,
    )
    .bind(day, dimension, units, JSON.stringify(metadata), isoNow(), boundedLimit)
    .run();
  const row = await db
    .prepare("SELECT units FROM usage_daily WHERE day = ? AND dimension = ?")
    .bind(day, dimension)
    .first<{ units: number }>();
  return { reserved: Number(result.meta?.changes ?? 0) > 0, used: Number(row?.units ?? 0) };
}

export async function reserveMonthlyUsage(
  db: D1Database,
  dimension: UsageDimension,
  units: number,
  limit: number,
  metadata: Record<string, unknown> = {},
  month = isoNow().slice(0, 7),
  day = isoNow().slice(0, 10),
): Promise<{ reserved: boolean; used: number }> {
  if (!Number.isFinite(units) || units <= 0) return { reserved: true, used: 0 };
  const { monthStart, nextMonthStart } = usageMonthBounds(month);
  if (day < monthStart || day >= nextMonthStart) {
    throw new RangeError("Monthly usage reservation day must belong to its month");
  }
  const boundedLimit = Math.max(0, limit);
  const now = isoNow();
  const result = await db
    .prepare(
      `INSERT INTO usage_daily(day, dimension, units, metadata_json, updated_at)
       SELECT ?, ?, ?, ?, ?
       WHERE (
         SELECT COALESCE(SUM(monthly.units), 0)
         FROM usage_daily monthly
         WHERE monthly.day >= ? AND monthly.day < ? AND monthly.dimension = ?
       ) + ? <= ?
       ON CONFLICT(day, dimension) DO UPDATE SET
         units = usage_daily.units + excluded.units,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at
       WHERE (
         SELECT COALESCE(SUM(monthly.units), 0)
         FROM usage_daily monthly
         WHERE monthly.day >= ? AND monthly.day < ? AND monthly.dimension = ?
       ) + excluded.units <= ?`,
    )
    .bind(
      day,
      dimension,
      units,
      JSON.stringify(metadata),
      now,
      monthStart,
      nextMonthStart,
      dimension,
      units,
      boundedLimit,
      monthStart,
      nextMonthStart,
      dimension,
      boundedLimit,
    )
    .run();
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(units), 0) AS units
       FROM usage_daily WHERE day >= ? AND day < ? AND dimension = ?`,
    )
    .bind(monthStart, nextMonthStart, dimension)
    .first<{ units: number }>();
  return { reserved: Number(result.meta?.changes ?? 0) > 0, used: Number(row?.units ?? 0) };
}

export async function trimMemoryGraph(
  db: D1Database,
  limits: { maxNodes: number; maxEdges: number },
): Promise<{ nodes: number; edges: number }> {
  const edgeTrim = await db
    .prepare(
      `DELETE FROM memory_edges WHERE id IN (
         SELECT id FROM memory_edges
         ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                  weight DESC, confidence DESC, last_seen_at DESC
         LIMIT -1 OFFSET ?
       )`,
    )
    .bind(Math.max(100, limits.maxEdges))
    .run();
  const nodeTrim = await db
    .prepare(
      `DELETE FROM memory_nodes WHERE id IN (
         SELECT id FROM memory_nodes
         WHERE node_type NOT IN ('mission', 'pack', 'decision', 'preference')
         ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                  importance DESC, confidence DESC, last_seen_at DESC
         LIMIT -1 OFFSET ?
       )`,
    )
    .bind(Math.max(100, limits.maxNodes))
    .run();
  return { nodes: Number(nodeTrim.meta?.changes ?? 0), edges: Number(edgeTrim.meta?.changes ?? 0) };
}

export async function upsertIntelligenceRoutine(
  db: D1Database,
  input: {
    id: string;
    packId?: string | null;
    missionId?: string | null;
    name: string;
    description?: string;
    definition: Record<string, unknown>;
    enabled?: boolean;
    scheduleMinutes?: number | null;
    nextRunAt?: string | null;
  },
): Promise<void> {
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO intelligence_routines(
         id, pack_id, mission_id, name, description, definition_json, enabled,
         schedule_minutes, next_run_at, last_run_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         pack_id = excluded.pack_id,
         mission_id = excluded.mission_id,
         name = excluded.name,
         description = excluded.description,
         definition_json = excluded.definition_json,
         enabled = excluded.enabled,
         schedule_minutes = excluded.schedule_minutes,
         next_run_at = COALESCE(intelligence_routines.next_run_at, excluded.next_run_at),
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.packId ?? null,
      input.missionId ?? null,
      input.name,
      input.description ?? "",
      JSON.stringify(input.definition),
      input.enabled === false ? 0 : 1,
      input.scheduleMinutes ?? null,
      input.nextRunAt ?? null,
      now,
      now,
    )
    .run();
}

export async function getIntelligenceRoutine(db: D1Database, id: string): Promise<IntelligenceRoutineRecord | null> {
  return db.prepare("SELECT * FROM intelligence_routines WHERE id = ?").bind(id).first<IntelligenceRoutineRecord>();
}

export async function listIntelligenceRoutines(
  db: D1Database,
  options: { packId?: string; missionId?: string; enabled?: boolean; limit?: number } = {},
): Promise<IntelligenceRoutineRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.packId) { clauses.push("pack_id = ?"); values.push(options.packId); }
  if (options.missionId) { clauses.push("mission_id = ?"); values.push(options.missionId); }
  if (options.enabled !== undefined) { clauses.push("enabled = ?"); values.push(options.enabled ? 1 : 0); }
  values.push(Math.max(1, Math.min(500, options.limit ?? 200)));
  return rows(
    await db
      .prepare(`SELECT * FROM intelligence_routines${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY name COLLATE NOCASE LIMIT ?`)
      .bind(...values)
      .all<IntelligenceRoutineRecord>(),
  );
}

export async function dueIntelligenceRoutines(db: D1Database, now = isoNow(), limit = 4): Promise<IntelligenceRoutineRecord[]> {
  return rows(
    await db
      .prepare(
        `SELECT r.* FROM intelligence_routines r
         WHERE r.enabled = 1
           AND r.schedule_minutes IS NOT NULL
           AND r.next_run_at IS NOT NULL
           AND datetime(r.next_run_at) <= datetime(?)
           AND NOT EXISTS (
             SELECT 1 FROM intelligence_routine_runs rr
             WHERE rr.routine_id = r.id AND rr.status IN ('queued', 'running')
           )
         ORDER BY datetime(r.next_run_at) ASC, r.updated_at ASC
         LIMIT ?`,
      )
      .bind(now, Math.max(1, Math.min(20, limit)))
      .all<IntelligenceRoutineRecord>(),
  );
}

export async function createIntelligenceRoutineRun(
  db: D1Database,
  input: { id: string; routineId: string; workflowId?: string | null; plan?: Record<string, unknown> },
): Promise<void> {
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO intelligence_routine_runs(
         id, routine_id, workflow_id, status, plan_json, result_json, created_at, updated_at
       ) VALUES (?, ?, ?, 'queued', ?, '{}', ?, ?)`,
    )
    .bind(input.id, input.routineId, input.workflowId ?? null, JSON.stringify(input.plan ?? {}), now, now)
    .run();
}

export async function updateIntelligenceRoutineRun(
  db: D1Database,
  id: string,
  input: {
    workflowId?: string | null;
    status?: IntelligenceRoutineRunRecord["status"];
    plan?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  },
): Promise<void> {
  const current = await db.prepare("SELECT * FROM intelligence_routine_runs WHERE id = ?").bind(id).first<IntelligenceRoutineRunRecord>();
  if (!current) return;
  await db
    .prepare(
      `UPDATE intelligence_routine_runs SET
         workflow_id = ?, status = ?, plan_json = ?, result_json = ?, error = ?,
         started_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.workflowId !== undefined ? input.workflowId : current.workflow_id,
      input.status ?? current.status,
      input.plan ? JSON.stringify(input.plan) : current.plan_json,
      input.result ? JSON.stringify(input.result) : current.result_json,
      input.error !== undefined ? input.error : current.error,
      input.startedAt !== undefined ? input.startedAt : current.started_at,
      input.completedAt !== undefined ? input.completedAt : current.completed_at,
      isoNow(),
      id,
    )
    .run();
}

export async function getIntelligenceRoutineRun(db: D1Database, id: string): Promise<IntelligenceRoutineRunRecord | null> {
  return db.prepare("SELECT * FROM intelligence_routine_runs WHERE id = ?").bind(id).first<IntelligenceRoutineRunRecord>();
}

export async function listIntelligenceRoutineRuns(
  db: D1Database,
  options: { routineId?: string; status?: string; limit?: number } = {},
): Promise<IntelligenceRoutineRunRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.routineId) { clauses.push("routine_id = ?"); values.push(options.routineId); }
  if (options.status) { clauses.push("status = ?"); values.push(options.status); }
  values.push(Math.max(1, Math.min(200, options.limit ?? 50)));
  return rows(
    await db
      .prepare(`SELECT * FROM intelligence_routine_runs${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`)
      .bind(...values)
      .all<IntelligenceRoutineRunRecord>(),
  );
}

export async function markIntelligenceRoutineScheduled(db: D1Database, routineId: string, nextRunAt: string | null): Promise<void> {
  await db
    .prepare("UPDATE intelligence_routines SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
    .bind(isoNow(), nextRunAt, isoNow(), routineId)
    .run();
}

/**
 * Defer a failed scheduled launch without claiming a successful Routine run.
 * Concurrently disabled or unscheduled Routines are deliberately left alone.
 */
export async function deferIntelligenceRoutineAttempt(
  db: D1Database,
  routineId: string,
  nextAttemptAt: string,
  updatedAt = isoNow(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE intelligence_routines
       SET next_run_at = ?, updated_at = ?
       WHERE id = ? AND enabled = 1 AND schedule_minutes IS NOT NULL`,
    )
    .bind(nextAttemptAt, updatedAt, routineId)
    .run();
}

export async function insertMemoryCheckpoint(
  db: D1Database,
  input: {
    id: string;
    scopeKind: MemoryCheckpointRecord["scope_kind"];
    scopeId?: string | null;
    title: string;
    reason?: string;
    snapshotR2Key: string;
    snapshotHash: string;
    summary?: Record<string, unknown>;
    diff?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memory_checkpoints(
         id, scope_kind, scope_id, title, reason, snapshot_r2_key, snapshot_hash,
         summary_json, diff_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.scopeKind,
      input.scopeId ?? null,
      input.title,
      input.reason ?? "",
      input.snapshotR2Key,
      input.snapshotHash,
      JSON.stringify(input.summary ?? {}),
      JSON.stringify(input.diff ?? {}),
      isoNow(),
    )
    .run();
}

export async function latestMemoryCheckpoint(
  db: D1Database,
  scopeKind: MemoryCheckpointRecord["scope_kind"],
  scopeId?: string | null,
): Promise<MemoryCheckpointRecord | null> {
  return db
    .prepare(
      `SELECT * FROM memory_checkpoints
       WHERE scope_kind = ? AND COALESCE(scope_id, '') = COALESCE(?, '')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(scopeKind, scopeId ?? null)
    .first<MemoryCheckpointRecord>();
}

export async function listMemoryCheckpoints(
  db: D1Database,
  options: { scopeKind?: string; scopeId?: string; limit?: number } = {},
): Promise<MemoryCheckpointRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.scopeKind) { clauses.push("scope_kind = ?"); values.push(options.scopeKind); }
  if (options.scopeId) { clauses.push("scope_id = ?"); values.push(options.scopeId); }
  values.push(Math.max(1, Math.min(200, options.limit ?? 40)));
  return rows(
    await db
      .prepare(`SELECT * FROM memory_checkpoints${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`)
      .bind(...values)
      .all<MemoryCheckpointRecord>(),
  );
}

export async function insertReasoningReceipt(
  db: D1Database,
  input: {
    id: string;
    scopeKind: ReasoningReceiptRecord["scope_kind"];
    scopeId?: string | null;
    task: ReasoningReceiptRecord["task"];
    target: ReasoningReceiptRecord["target"];
    title: string;
    objective?: string;
    bundleVersion?: number;
    bundleHash: string;
    bundleR2Key: string;
    quality?: Record<string, unknown>;
    estimatedTokens?: number;
    evidenceCount?: number;
    independentFamilyCount?: number;
    providerLabel?: string | null;
    modelLabel?: string | null;
    result?: Record<string, unknown>;
    resultR2Key?: string | null;
    confidence?: number | null;
    citations?: unknown[];
    decisionNote?: string | null;
    status?: ReasoningReceiptRecord["status"];
    completedAt?: string | null;
  },
): Promise<void> {
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO reasoning_receipts(
         id, scope_kind, scope_id, task, target, title, objective, bundle_version, bundle_hash, bundle_r2_key,
         quality_json, estimated_tokens, evidence_count, independent_family_count,
         provider_label, model_label, result_json, result_r2_key, confidence, citations_json, decision_note,
         status, completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.scopeKind,
      input.scopeId ?? null,
      input.task,
      input.target,
      input.title,
      input.objective ?? "",
      Math.max(1, Math.min(100, input.bundleVersion ?? 2)),
      input.bundleHash,
      input.bundleR2Key,
      JSON.stringify(input.quality ?? {}),
      Math.max(0, Math.round(input.estimatedTokens ?? 0)),
      Math.max(0, Math.round(input.evidenceCount ?? 0)),
      Math.max(0, Math.round(input.independentFamilyCount ?? 0)),
      input.providerLabel ?? null,
      input.modelLabel ?? null,
      JSON.stringify(input.result ?? {}),
      input.resultR2Key ?? null,
      input.confidence ?? null,
      JSON.stringify(input.citations ?? []),
      input.decisionNote ?? null,
      input.status ?? "prepared",
      input.completedAt ?? null,
      now,
      now,
    )
    .run();
}

export async function getReasoningReceipt(db: D1Database, id: string): Promise<ReasoningReceiptRecord | null> {
  return db.prepare("SELECT * FROM reasoning_receipts WHERE id = ?").bind(id).first<ReasoningReceiptRecord>();
}

export async function listReasoningReceipts(
  db: D1Database,
  options: { scopeKind?: string; scopeId?: string; task?: string; limit?: number } = {},
): Promise<ReasoningReceiptRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.scopeKind) { clauses.push("scope_kind = ?"); values.push(options.scopeKind); }
  if (options.scopeId) { clauses.push("scope_id = ?"); values.push(options.scopeId); }
  if (options.task) { clauses.push("task = ?"); values.push(options.task); }
  values.push(Math.max(1, Math.min(200, options.limit ?? 50)));
  return rows(
    await db
      .prepare(`SELECT * FROM reasoning_receipts${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`)
      .bind(...values)
      .all<ReasoningReceiptRecord>(),
  );
}

export async function updateReasoningReceipt(
  db: D1Database,
  id: string,
  input: {
    providerLabel?: string | null;
    modelLabel?: string | null;
    result?: Record<string, unknown>;
    resultR2Key?: string | null;
    confidence?: number | null;
    citations?: unknown[];
    decisionNote?: string | null;
    status?: ReasoningReceiptRecord["status"];
    completedAt?: string | null;
  },
): Promise<void> {
  const current = await getReasoningReceipt(db, id);
  if (!current) return;
  await db
    .prepare(
      `UPDATE reasoning_receipts SET
         provider_label = ?, model_label = ?, result_json = ?, result_r2_key = ?, confidence = ?,
         citations_json = ?, decision_note = ?, status = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.providerLabel !== undefined ? input.providerLabel : current.provider_label,
      input.modelLabel !== undefined ? input.modelLabel : current.model_label,
      input.result ? JSON.stringify(input.result) : current.result_json,
      input.resultR2Key !== undefined ? input.resultR2Key : current.result_r2_key,
      input.confidence !== undefined ? input.confidence : current.confidence,
      input.citations ? JSON.stringify(input.citations) : current.citations_json,
      input.decisionNote !== undefined ? input.decisionNote : current.decision_note,
      input.status ?? current.status,
      input.completedAt !== undefined ? input.completedAt : current.completed_at,
      isoNow(),
      id,
    )
    .run();
}

export async function insertReasoningRun(
  db: D1Database,
  input: {
    id: string;
    receiptId: string;
    providerLabel: string;
    modelLabel?: string | null;
    clientLabel?: string | null;
    status?: ReasoningRunRecord["status"];
  },
): Promise<void> {
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO reasoning_runs(
         id, receipt_id, provider_label, model_label, client_label, status,
         started_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.receiptId,
      input.providerLabel,
      input.modelLabel ?? null,
      input.clientLabel ?? null,
      input.status ?? "started",
      now,
      now,
      now,
    )
    .run();
}

export async function getReasoningRun(db: D1Database, id: string): Promise<ReasoningRunRecord | null> {
  return db.prepare("SELECT * FROM reasoning_runs WHERE id = ?").bind(id).first<ReasoningRunRecord>();
}

export async function listReasoningRuns(
  db: D1Database,
  options: { receiptId?: string; provider?: string; status?: string; limit?: number } = {},
): Promise<ReasoningRunRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.receiptId) { clauses.push("receipt_id = ?"); values.push(options.receiptId); }
  if (options.provider) { clauses.push("provider_label = ?"); values.push(options.provider); }
  if (options.status) { clauses.push("status = ?"); values.push(options.status); }
  values.push(Math.max(1, Math.min(200, options.limit ?? 50)));
  return rows(
    await db
      .prepare(`SELECT * FROM reasoning_runs${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`)
      .bind(...values)
      .all<ReasoningRunRecord>(),
  );
}

export async function updateReasoningRun(
  db: D1Database,
  id: string,
  input: {
    status?: ReasoningRunRecord["status"];
    responseHash?: string | null;
    responseR2Key?: string | null;
    responseSummary?: string;
    structuredResult?: Record<string, unknown>;
    audit?: Record<string, unknown>;
    outcome?: Record<string, unknown>;
    confidence?: number | null;
    rating?: number | null;
    memoryProposalId?: string | null;
    completedAt?: string | null;
    reviewedAt?: string | null;
  },
): Promise<void> {
  const current = await getReasoningRun(db, id);
  if (!current) throw new HttpError(404, "Reasoning run not found");
  await db
    .prepare(
      `UPDATE reasoning_runs SET
         status = ?, response_hash = ?, response_r2_key = ?, response_summary = ?,
         structured_result_json = ?, audit_json = ?, outcome_json = ?, confidence = ?, rating = ?,
         memory_proposal_id = ?, completed_at = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.status ?? current.status,
      input.responseHash !== undefined ? input.responseHash : current.response_hash,
      input.responseR2Key !== undefined ? input.responseR2Key : current.response_r2_key,
      input.responseSummary !== undefined ? input.responseSummary : current.response_summary,
      input.structuredResult ? JSON.stringify(input.structuredResult) : current.structured_result_json,
      input.audit ? JSON.stringify(input.audit) : current.audit_json,
      input.outcome ? JSON.stringify(input.outcome) : current.outcome_json,
      input.confidence !== undefined ? input.confidence : current.confidence,
      input.rating !== undefined ? input.rating : current.rating,
      input.memoryProposalId !== undefined ? input.memoryProposalId : current.memory_proposal_id,
      input.completedAt !== undefined ? input.completedAt : current.completed_at,
      input.reviewedAt !== undefined ? input.reviewedAt : current.reviewed_at,
      isoNow(),
      id,
    )
    .run();
}

export async function recordReasoningRunEvent(
  db: D1Database,
  input: { runId: string; eventType: ReasoningRunEventRecord["event_type"]; detail?: Record<string, unknown> },
): Promise<string> {
  const id = `rre-${crypto.randomUUID()}`;
  await db
    .prepare("INSERT INTO reasoning_run_events(id, run_id, event_type, detail_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, input.runId, input.eventType, JSON.stringify(input.detail ?? {}), isoNow())
    .run();
  return id;
}

export async function listReasoningRunEvents(db: D1Database, runId: string): Promise<ReasoningRunEventRecord[]> {
  return rows(
    await db
      .prepare("SELECT * FROM reasoning_run_events WHERE run_id = ? ORDER BY created_at ASC")
      .bind(runId)
      .all<ReasoningRunEventRecord>(),
  );
}

export async function listStoryLineageCandidates(
  db: D1Database,
  storyId: string,
  excludeItemId: string,
  limit = 24,
): Promise<Array<{
  item_id: string;
  source_id: string;
  source_kind: string;
  source_config_json: string;
  title: string;
  text: string;
  canonical_url: string | null;
  url: string | null;
  author: string | null;
  metadata_json: string;
  observed_at: string;
  family_key: string | null;
  origin_item_id: string | null;
  origin_family_key: string | null;
  relation: string | null;
}>> {
  return rows(
    await db
      .prepare(
        `SELECT i.id AS item_id, i.source_id, s.kind AS source_kind, s.config_json AS source_config_json,
                i.title, i.text, i.canonical_url, i.url, i.author, i.metadata_json, i.observed_at,
                l.family_key, l.origin_item_id, l.origin_family_key, l.relation
         FROM story_items si
         JOIN items i ON i.id = si.item_id
         JOIN sources s ON s.id = i.source_id
         LEFT JOIN evidence_lineage l ON l.item_id = i.id
         WHERE si.story_id = ? AND i.id <> ?
         ORDER BY i.observed_at ASC
         LIMIT ?`,
      )
      .bind(storyId, excludeItemId, Math.max(1, Math.min(60, limit)))
      .all(),
  ) as Array<any>;
}

export async function upsertEvidenceLineage(
  db: D1Database,
  input: {
    itemId: string;
    storyId: string;
    familyKey: string;
    originItemId?: string | null;
    originFamilyKey?: string | null;
    relation: EvidenceLineageRecord["relation"];
    titleSimilarity?: number;
    bodySimilarity?: number;
    independent: boolean;
    rationale?: string;
  },
): Promise<void> {
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO evidence_lineage(
         item_id, story_id, family_key, origin_item_id, origin_family_key, relation,
         title_similarity, body_similarity, independent, rationale, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         story_id = excluded.story_id,
         family_key = excluded.family_key,
         origin_item_id = excluded.origin_item_id,
         origin_family_key = excluded.origin_family_key,
         relation = excluded.relation,
         title_similarity = excluded.title_similarity,
         body_similarity = excluded.body_similarity,
         independent = excluded.independent,
         rationale = excluded.rationale,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.itemId,
      input.storyId,
      input.familyKey,
      input.originItemId ?? null,
      input.originFamilyKey ?? null,
      input.relation,
      Math.max(0, Math.min(1, input.titleSimilarity ?? 0)),
      Math.max(0, Math.min(1, input.bodySimilarity ?? 0)),
      input.independent ? 1 : 0,
      input.rationale ?? "",
      now,
      now,
    )
    .run();
}

export async function getEvidenceLineage(db: D1Database, itemId: string): Promise<EvidenceLineageRecord | null> {
  return db.prepare("SELECT * FROM evidence_lineage WHERE item_id = ?").bind(itemId).first<EvidenceLineageRecord>();
}

export async function listEvidenceLineage(
  db: D1Database,
  options: { storyId?: string; familyKey?: string; limit?: number } = {},
): Promise<EvidenceLineageRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.storyId) { clauses.push("story_id = ?"); values.push(options.storyId); }
  if (options.familyKey) { clauses.push("family_key = ?"); values.push(options.familyKey); }
  values.push(Math.max(1, Math.min(500, options.limit ?? 100)));
  return rows(
    await db
      .prepare(`SELECT * FROM evidence_lineage${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at ASC LIMIT ?`)
      .bind(...values)
      .all<EvidenceLineageRecord>(),
  );
}

export async function upsertIntelligencePackOverlay(
  db: D1Database,
  input: {
    id: string;
    basePackId: string;
    name: string;
    description?: string;
    baseVersion: string;
    overlay: Record<string, unknown>;
    status?: IntelligencePackOverlayRecord["status"];
    conflicts?: unknown[];
  },
): Promise<void> {
  const now = isoNow();
  await db
    .prepare(
      `INSERT INTO intelligence_pack_overlays(
         id, base_pack_id, name, description, base_version, overlay_json, status, conflicts_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         base_pack_id = excluded.base_pack_id,
         name = excluded.name,
         description = excluded.description,
         base_version = excluded.base_version,
         overlay_json = excluded.overlay_json,
         status = excluded.status,
         conflicts_json = excluded.conflicts_json,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.basePackId,
      input.name,
      input.description ?? "",
      input.baseVersion,
      JSON.stringify(input.overlay),
      input.status ?? "active",
      JSON.stringify(input.conflicts ?? []),
      now,
      now,
    )
    .run();
}

export async function getIntelligencePackOverlay(db: D1Database, id: string): Promise<IntelligencePackOverlayRecord | null> {
  return db.prepare("SELECT * FROM intelligence_pack_overlays WHERE id = ?").bind(id).first<IntelligencePackOverlayRecord>();
}

export async function listIntelligencePackOverlays(
  db: D1Database,
  basePackId?: string,
): Promise<IntelligencePackOverlayRecord[]> {
  return rows(
    basePackId
      ? await db.prepare("SELECT * FROM intelligence_pack_overlays WHERE base_pack_id = ? ORDER BY name COLLATE NOCASE").bind(basePackId).all<IntelligencePackOverlayRecord>()
      : await db.prepare("SELECT * FROM intelligence_pack_overlays ORDER BY updated_at DESC").all<IntelligencePackOverlayRecord>(),
  );
}

export async function deleteIntelligencePackOverlay(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM intelligence_pack_overlays WHERE id = ?").bind(id).run();
}

export async function getSourceCadence(db: D1Database, sourceId: string): Promise<SourceCadenceRecord | null> {
  return db.prepare("SELECT * FROM source_cadence WHERE source_id = ?").bind(sourceId).first<SourceCadenceRecord>();
}

export async function upsertSourceCadence(
  db: D1Database,
  input: {
    sourceId: string;
    mode: SourceCadenceRecord["mode"];
    baseMinutes: number;
    minMinutes: number;
    maxMinutes: number;
    effectiveMinutes: number;
    nextRunAt?: string | null;
    yieldEma?: number;
    latencyEmaMs?: number;
    successEma?: number;
    emptyStreak?: number;
    failureStreak?: number;
    highSignalStreak?: number;
    lastReason?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_cadence(
         source_id, mode, base_minutes, min_minutes, max_minutes, effective_minutes, next_run_at,
         yield_ema, latency_ema_ms, success_ema, empty_streak, failure_streak, high_signal_streak,
         last_reason, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         mode = excluded.mode,
         base_minutes = excluded.base_minutes,
         min_minutes = excluded.min_minutes,
         max_minutes = excluded.max_minutes,
         effective_minutes = excluded.effective_minutes,
         next_run_at = excluded.next_run_at,
         yield_ema = excluded.yield_ema,
         latency_ema_ms = excluded.latency_ema_ms,
         success_ema = excluded.success_ema,
         empty_streak = excluded.empty_streak,
         failure_streak = excluded.failure_streak,
         high_signal_streak = excluded.high_signal_streak,
         last_reason = excluded.last_reason,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.sourceId,
      input.mode,
      Math.round(input.baseMinutes),
      Math.round(input.minMinutes),
      Math.round(input.maxMinutes),
      Math.round(input.effectiveMinutes),
      input.nextRunAt ?? null,
      input.yieldEma ?? 0,
      input.latencyEmaMs ?? 0,
      input.successEma ?? 1,
      input.emptyStreak ?? 0,
      input.failureStreak ?? 0,
      input.highSignalStreak ?? 0,
      input.lastReason ?? "baseline",
      isoNow(),
    )
    .run();
}

export async function listSourceCadence(db: D1Database): Promise<Array<SourceCadenceRecord & { source_name: string; source_kind: string }>> {
  return rows(
    await db
      .prepare(
        `SELECT c.*, s.name AS source_name, s.kind AS source_kind
         FROM source_cadence c JOIN sources s ON s.id = c.source_id
         ORDER BY c.next_run_at ASC, s.name COLLATE NOCASE`,
      )
      .all(),
  ) as Array<any>;
}

export async function listItemsMissingLineage(
  db: D1Database,
  limit = 80,
): Promise<Array<{ item: ItemRecord; story_id: string; source: SourceRecord }>> {
  const records = await db
    .prepare(
      `SELECT i.*, si.story_id,
              s.name AS source_name, s.kind AS source_kind, s.config_json AS source_config_json,
              s.enabled AS source_enabled, s.schedule_minutes AS source_schedule_minutes,
              s.weight AS source_weight, s.last_run_at AS source_last_run_at,
              s.last_success_at AS source_last_success_at, s.last_error AS source_last_error,
              s.health_score AS source_health_score, s.created_at AS source_created_at,
              s.updated_at AS source_updated_at
       FROM items i
       JOIN story_items si ON si.item_id = i.id
       JOIN sources s ON s.id = i.source_id
       LEFT JOIN evidence_lineage l ON l.item_id = i.id
       WHERE l.item_id IS NULL
       ORDER BY i.observed_at ASC
       LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(500, limit)))
    .all<Record<string, unknown>>();
  return rows(records).map((row) => ({
    item: {
      id: String(row.id),
      source_id: String(row.source_id),
      external_id: row.external_id == null ? null : String(row.external_id),
      url: row.url == null ? null : String(row.url),
      canonical_url: row.canonical_url == null ? null : String(row.canonical_url),
      title: String(row.title),
      text: String(row.text ?? ""),
      author: row.author == null ? null : String(row.author),
      published_at: row.published_at == null ? null : String(row.published_at),
      observed_at: String(row.observed_at),
      content_hash: String(row.content_hash),
      raw_r2_key: row.raw_r2_key == null ? null : String(row.raw_r2_key),
      access_class: String(row.access_class) as ItemRecord["access_class"],
      metadata_json: String(row.metadata_json ?? "{}"),
      created_at: String(row.created_at),
    },
    story_id: String(row.story_id),
    source: {
      id: String(row.source_id),
      name: String(row.source_name),
      kind: String(row.source_kind) as SourceRecord["kind"],
      config_json: String(row.source_config_json ?? "{}"),
      enabled: Number(row.source_enabled),
      schedule_minutes: Number(row.source_schedule_minutes),
      weight: Number(row.source_weight),
      last_run_at: row.source_last_run_at == null ? null : String(row.source_last_run_at),
      last_success_at: row.source_last_success_at == null ? null : String(row.source_last_success_at),
      last_error: row.source_last_error == null ? null : String(row.source_last_error),
      health_score: Number(row.source_health_score),
      created_at: String(row.source_created_at),
      updated_at: String(row.source_updated_at),
    },
  }));
}
