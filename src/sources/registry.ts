import { tracing } from "cloudflare:workers";
import { beginSourceRun, finishSourceRun, queueCollectorJob } from "../db";
import { observeSourceCadence } from "../adaptive-cadence";
import { BudgetDeferredError, canSpend, requireBudget } from "../budget";
import { isRelayCapability, relayCapabilityArgsError } from "../relay-capabilities";
import { isIngestDurabilityBackpressure, requireIngestQueueDurability } from "../queue-health";
import {
  deleteOneTerminalTrackedSourceOutboxRun,
  drainTrackedSourceOutbox,
  enqueueTrackedSourceRun,
  fitTrackedSourceOutboxPrefix,
  isSourceOutboxBackpressure,
  SourceOutboxActivationUnknownError,
} from "../source-ingest-outbox";
import type { Env, SourceAdapterResult, SourceRecord } from "../types";
import { HttpError, isoNow, parseJson } from "../utils";
import { collectArxiv } from "./arxiv";
import { collectBluesky } from "./bluesky";
import { collectGithubReleases } from "./github";
import { collectGithubActivity } from "./github-activity";
import { collectHackerNews } from "./hackernews";
import { collectLobsters } from "./lobsters";
import { collectNpmReleases } from "./npm";
import {
  collectOpenAlex,
  OpenAlexPrerequisiteError,
} from "./openalex";
import { sourceRuntimeAccess } from "./access";
export { sourceRuntimeAccess } from "./access";
export type { SourceRuntimeAccess } from "./access";
import { collectPypiReleases } from "./pypi";
import { collectWeb } from "./web";
import { collectWebFeed } from "./web-feed";

export async function collectSource(source: SourceRecord, env: Env, sourceRunId?: string): Promise<SourceAdapterResult> {
  switch (source.kind) {
    case "hackernews":
      return collectHackerNews(source);
    case "lobsters":
      return collectLobsters(source);
    case "bluesky":
      return collectBluesky(source);
    case "arxiv":
      return collectArxiv(source);
    case "github_releases":
      return collectGithubReleases(source, env);
    case "github_activity":
      return collectGithubActivity(source, env);
    case "openalex":
      return collectOpenAlex(source, env);
    case "npm_releases":
      return collectNpmReleases(source);
    case "pypi_releases":
      return collectPypiReleases(source);
    case "web":
      return collectWeb(source, env);
    case "web_feed":
      return collectWebFeed(source, env);
    case "collector": {
      if (!sourceRunId) throw new Error("Relay collection requires a source run");
      const config = parseJson<{ operation?: string; args?: Record<string, unknown>; collectorId?: string }>(source.config_json, {});
      const operation = config.operation?.trim();
      if (!operation) throw new Error("Relay sources require config.operation");
      if (!isRelayCapability(operation)) throw new Error(`Relay operation is not allowlisted: ${operation}`);
      const argsError = relayCapabilityArgsError(operation, config.args, "config.args");
      if (argsError) throw new Error(argsError);
      const job = await queueCollectorJob(env.DB, {
        sourceId: source.id,
        sourceRunId,
        operation,
        args: config.args ?? {},
        collectorId: config.collectorId,
      });
      return {
        items: [],
        provider: "driftglass-relay",
        details: {
          queued: true,
          pending: false,
          jobId: job.id,
          operation,
          sourceRunId: job.sourceRunId,
          canonicalSourceRunId: job.sourceRunId,
          requestedSourceRunId: sourceRunId,
          deduplicated: !job.created,
          superseded: job.superseded,
        },
      };
    }
    case "manual":
    case "email":
      return { items: [], provider: source.kind, details: { passive: true } };
    default:
      throw new Error(`Unsupported source kind: ${String(source.kind)}`);
  }
}

export interface SourceRunResult {
  runId: string;
  requestedRunId?: string;
  deduplicated?: boolean;
  count: number;
  provider: string;
  status: "success" | "partial" | "failed" | "queued" | "pending";
  collectionPartial: boolean;
}

export interface RunSourceOptions {
  /** Batch entrypoints may perform one shared bounded drain before the loop. */
  resumeOutbox?: boolean;
}

export function isWorkersSubrequestLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /too many subrequests|subrequest limit exceeded/i.test(message);
}

const ORPHANED_PENDING_SOURCE_RUN_PREDICATE = `run.source_id = ?
  AND source.kind NOT IN ('collector', 'manual', 'email')
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
  AND NOT EXISTS (SELECT 1 FROM collector_jobs job WHERE job.source_run_id = run.id)`;

/**
 * Retires one legacy pending run only when its own flags and the absence of
 * every durable handoff prove that no consumer or collector can finish it.
 * Ambiguous producer outboxes and collector supersession rows are excluded.
 */
export async function reconcileOrphanedPendingSourceRun(db: D1Database, sourceId: string): Promise<boolean> {
  const candidate = await db
    .prepare(
      `SELECT 1 AS candidate
       FROM source_runs run
       JOIN sources source ON source.id = run.source_id
       WHERE ${ORPHANED_PENDING_SOURCE_RUN_PREDICATE}
       LIMIT 1`,
    )
    .bind(sourceId)
    .first<{ candidate: number }>();
  if (!candidate) return false;
  const now = isoNow();
  const reconciliationId = crypto.randomUUID();
  const reconciliation = JSON.stringify({
    id: reconciliationId,
    reason: "no-durable-handoff",
    previousStatus: "pending",
    reconciledAt: now,
  });
  const latestReconciledRunGuard = `EXISTS (
    SELECT 1
    FROM source_runs retry_run
    JOIN sources retry_source ON retry_source.id = retry_run.source_id
    WHERE retry_run.source_id = ?
      AND retry_run.status = 'failed'
      AND retry_run.terminal_accounted_at = ?
      AND json_extract(retry_run.details_json, '$.reconciliation.id') = ?
      AND retry_source.last_run_at = retry_run.started_at
      AND NOT EXISTS (
        SELECT 1 FROM source_runs newer
        WHERE newer.source_id = retry_run.source_id
          AND newer.rowid > retry_run.rowid
      )
  )`;
  const [reconciled] = await db.batch([
    db
      .prepare(
        `UPDATE source_runs
         SET status = 'failed',
             collection_partial = 1,
             last_ingest_error = COALESCE(last_ingest_error, 'Deferred source run had no durable handoff'),
             ingest_updated_at = ?,
             terminal_accounted_at = ?,
             details_json = json_set(details_json, '$.reconciliation', json(?))
         WHERE id = (
           SELECT run.id
           FROM source_runs run
           JOIN sources source ON source.id = run.source_id
           WHERE ${ORPHANED_PENDING_SOURCE_RUN_PREDICATE}
           ORDER BY run.finished_at ASC, run.rowid ASC
           LIMIT 1
         )`,
      )
      .bind(now, now, reconciliation, sourceId),
    db
      .prepare(
        `UPDATE source_cadence
         SET next_run_at = ?, last_reason = 'transport-retry-due', updated_at = ?
         WHERE source_id = ? AND ${latestReconciledRunGuard}`,
      )
      .bind(now, now, sourceId, sourceId, now, reconciliationId),
    db
      .prepare(
        `UPDATE sources
         SET last_run_at = NULL, updated_at = ?
         WHERE id = ? AND ${latestReconciledRunGuard}`,
      )
      .bind(now, sourceId, sourceId, now, reconciliationId),
  ]);
  return Number(reconciled?.meta?.changes ?? 0) > 0;
}

export async function runSource(source: SourceRecord, env: Env, options: RunSourceOptions = {}): Promise<SourceRunResult> {
  return tracing.enterSpan("driftglass.source.collect", async (span) => {
    span.setAttribute("driftglass.source.id", source.id);
    span.setAttribute("driftglass.source.kind", source.kind);
    // Provider prerequisites must be resolved before outbox recovery, run-row
    // creation, reconciliation, budget reservation, or any other D1/cost-bearing action.
    const access = sourceRuntimeAccess(source, env);
    if (!access.runnable) {
      span.setAttribute("driftglass.source.status", "source-prerequisite");
      if (access.code === "OPENALEX_API_KEY_REQUIRED") throw new OpenAlexPrerequisiteError();
      throw new Error(access.detail);
    }
    await reconcileOrphanedPendingSourceRun(env.DB, source.id);
    const builtInPublicSource = !["collector", "manual", "email"].includes(source.kind);
    if (builtInPublicSource && options.resumeOutbox !== false) {
      // Resume an older exact producer handoff before creating or budgeting a
      // new source run. If work was claimed, this invocation is that canonical
      // resume and performs no duplicate adapter collection.
      const resumed = await drainTrackedSourceOutbox(env, {
        maxBatches: 1,
        skipMaintenance: true,
        resumeStaging: true,
        sourceId: source.id,
      });
      if (resumed.claimed && resumed.runId) {
        const canonical = await env.DB
          .prepare("SELECT status, enqueued_count, provider, collection_partial FROM source_runs WHERE id = ?")
          .bind(resumed.runId)
          .first<{ status: string; enqueued_count: number; provider: string | null; collection_partial: number }>();
        const canonicalStatus = canonical?.status;
        const status: SourceRunResult["status"] = canonicalStatus === "success"
          || canonicalStatus === "partial"
          || canonicalStatus === "failed"
          || canonicalStatus === "pending"
          || canonicalStatus === "queued"
          ? canonicalStatus
          : "queued";
        span.setAttribute("driftglass.source.status", resumed.ambiguous ? "outbox-resume-ambiguous" : "outbox-resumed");
        span.setAttribute("driftglass.source.resumed_run_id", resumed.runId);
        return {
          runId: resumed.runId,
          count: Math.max(0, Number(canonical?.enqueued_count ?? resumed.sentCount)),
          provider: canonical?.provider ?? "producer-outbox-resume",
          status,
          collectionPartial: canonical?.collection_partial === 1,
        };
      }
    }
    if (builtInPublicSource) {
      // Every producer invocation retires one fully accounted body set before
      // creating another. This single statement also runs for shared-drain
      // batch members and cannot substitute old handoff work for collection.
      await deleteOneTerminalTrackedSourceOutboxRun(env.DB).catch((error) => {
        console.error("Terminal tracked source outbox cleanup failed", error);
      });
      // Fail before creating a run row when the Queue cannot currently accept
      // another producer. A Workflow or later scheduled invocation can retry
      // this source without leaving an unowned pending run behind. The durable
      // sender repeats the preflight after collection to close the TOCTOU gap.
      await requireIngestQueueDurability(env);
    }
    await requireBudget(env.DB, "source_runs", 1, { sourceId: source.id, kind: source.kind });
    const started = Date.now();
    const runId = await beginSourceRun(env.DB, source.id, source.kind);
    let collectedItems = 0;
    let runProvider: string = source.kind;
    let collectionPartial = false;
    let senderStarted = false;
    let runDetails: Record<string, unknown> | undefined;
    try {
      const result = await collectSource(source, env, runId);
      collectedItems = result.items.length;
      runProvider = result.provider;
      const canonicalSourceRunId = source.kind === "collector" && typeof result.details?.canonicalSourceRunId === "string"
        ? result.details.canonicalSourceRunId
        : runId;
      if (canonicalSourceRunId !== runId) {
        const canonical = await env.DB
          .prepare("SELECT status, enqueued_count, provider, collection_partial FROM source_runs WHERE id = ? AND source_id = ?")
          .bind(canonicalSourceRunId, source.id)
          .first<{ status: string; enqueued_count: number; provider: string | null; collection_partial: number }>();
        const canonicalStatus = canonical?.status;
        const status: SourceRunResult["status"] = canonicalStatus === "success"
          || canonicalStatus === "partial"
          || canonicalStatus === "failed"
          || canonicalStatus === "pending"
          || canonicalStatus === "queued"
          ? canonicalStatus
          : "queued";
        span.setAttribute("driftglass.source.provider", canonical?.provider ?? result.provider);
        span.setAttribute("driftglass.source.status", "deduplicated");
        span.setAttribute("driftglass.source.canonical_run_id", canonicalSourceRunId);
        return {
          runId: canonicalSourceRunId,
          requestedRunId: runId,
          deduplicated: true,
          count: Math.max(0, Number(canonical?.enqueued_count ?? 0)),
          provider: canonical?.provider ?? result.provider,
          status,
          collectionPartial: canonical?.collection_partial === 1,
        };
      }
      let queuedItems = result.items;
      let outboxDeferredItems = 0;
      let outboxMessageBytes = 0;
      let outboxStagingChunks = 0;
      if (builtInPublicSource && queuedItems.length > 0) {
        const fit = fitTrackedSourceOutboxPrefix(queuedItems.map((item, index) => ({
          sourceId: source.id,
          item,
          provider: result.provider,
          sourceRunId: runId,
          sourceRunItemIndex: index,
        })));
        queuedItems = queuedItems.slice(0, fit.acceptedCount);
        outboxDeferredItems = fit.deferredCount;
        outboxMessageBytes = fit.messageBytes;
        outboxStagingChunks = fit.stagingChunks;
      }
      let budgetDeferredItems = 0;
      if (queuedItems.length > 0) {
        const outboxAcceptedItems = queuedItems.length;
        const allowance = await canSpend(env.DB, "queue_messages", queuedItems.length);
        const permitted = allowance.allowed ? queuedItems.length : Math.max(0, Math.floor(allowance.remaining));
        queuedItems = queuedItems.slice(0, permitted);
        budgetDeferredItems = outboxAcceptedItems - queuedItems.length;
      }
      const queued = Boolean(result.details?.queued);
      const adapterPartial = Boolean(result.details?.partial);
      collectionPartial = adapterPartial || budgetDeferredItems > 0 || outboxDeferredItems > 0;
      const collectionHealthDelta = source.kind === "collector"
        ? 0
        : adapterPartial
          ? -0.02
          : budgetDeferredItems > 0 || outboxDeferredItems > 0
            ? 0
            : 0.08;
      const adapterPending = Boolean(result.details?.pending);
      const status = queuedItems.length > 0 ? "queued" : queued ? "queued" : collectionPartial ? "partial" : "success";
      const latencyMs = Date.now() - started;
      runDetails = {
        ...(result.details ?? {}),
        provider: result.provider,
        collectedAt: isoNow(),
        collectedItems: result.items.length,
        queuedItems: queuedItems.length,
        budgetDeferredItems,
        outboxDeferredItems,
        outboxMessageBytes,
        outboxStagingChunks,
        collectionPartial,
      };
      if (adapterPending) {
        throw new Error("Source adapters cannot return pending without a durable handoff owner");
      }
      if (queued && source.kind !== "collector") {
        throw new Error("Built-in source adapters cannot return queued without a tracked Queue handoff");
      }
      if (result.items.length > 0 && queuedItems.length === 0) {
        throw new HttpError(503, "Collected source evidence could not obtain a durable Queue handoff", {
          code: "INGEST_OUTBOX_CAPACITY",
          collectedItems: result.items.length,
          budgetDeferredItems,
          outboxDeferredItems,
          action: "Retry after Queue or producer-outbox capacity is available.",
        });
      }
      if (queuedItems.length > 0) {
        senderStarted = true;
        await enqueueTrackedSourceRun(
          env,
          queuedItems.map((item, index) => ({
            sourceId: source.id,
            item,
            provider: result.provider,
            sourceRunId: runId,
            sourceRunItemIndex: index,
          })),
          {
            runId,
            sourceId: source.id,
            collectionPartial,
            collectionHealthDelta,
            latencyMs: Date.now() - started,
            provider: result.provider,
            details: runDetails,
          },
        );
      } else {
        await finishSourceRun(env.DB, {
          runId,
          sourceId: source.id,
          status,
          itemCount: 0,
          enqueuedCount: 0,
          collectionPartial,
          latencyMs,
          provider: result.provider,
          details: runDetails,
        });
      }
      span.setAttribute("driftglass.source.provider", result.provider);
      span.setAttribute("driftglass.source.status", status);
      span.setAttribute("driftglass.source.item_count", queuedItems.length);
      if (budgetDeferredItems > 0) span.setAttribute("driftglass.source.budget_deferred_items", budgetDeferredItems);
      if (outboxDeferredItems > 0) span.setAttribute("driftglass.source.outbox_deferred_items", outboxDeferredItems);
      await observeSourceCadence(env.DB, source, {
        status,
        itemCount: queuedItems.length,
        latencyMs,
        meaningfulCount: Number(result.details?.meaningfulItems ?? queuedItems.length),
      }).catch((error) => console.error("Adaptive cadence update failed", error));
      return { runId, count: queuedItems.length, provider: result.provider, status, collectionPartial };
    } catch (error) {
      if (error instanceof SourceOutboxActivationUnknownError) {
        span.setAttribute("driftglass.source.status", "outbox-reconcile");
        return { runId, count: 0, provider: runProvider, status: "pending", collectionPartial };
      }
      const prerequisite = error instanceof OpenAlexPrerequisiteError;
      const deferred = error instanceof BudgetDeferredError;
      const backpressure = isIngestDurabilityBackpressure(error) || isSourceOutboxBackpressure(error);
      const subrequestEnvelopeExhausted = isWorkersSubrequestLimitError(error);
      const status = "failed";
      const errorMessage = error instanceof Error ? error.message : String(error);
      span.setAttribute(
        "driftglass.source.status",
        prerequisite
          ? "source-prerequisite"
          : backpressure
            ? "ingest-backpressure"
            : deferred
              ? "budget-deferred"
              : subrequestEnvelopeExhausted
                ? "subrequest-capacity"
                : "failed",
      );
      await finishSourceRun(env.DB, {
        runId,
        sourceId: source.id,
        status,
        itemCount: 0,
        enqueuedCount: senderStarted ? 0 : undefined,
        collectionPartial,
        latencyMs: Date.now() - started,
        provider: runProvider,
        details: prerequisite
          ? { sourcePrerequisite: true, code: error.code, binding: error.binding, detail: error.message }
          : deferred
          ? { budgetDeferred: true, dimension: error.dimension, requested: error.requested, remaining: error.remaining }
          : backpressure
            ? { ...(runDetails ?? {}), ingestBackpressure: true, error: errorMessage }
            : subrequestEnvelopeExhausted
              ? { ...(runDetails ?? {}), subrequestEnvelopeExhausted: true, error: errorMessage }
            : {
              ...(runDetails ?? {}),
              queuedItems: 0,
              collectedItems,
              queueSendFailed: senderStarted,
            },
        error: errorMessage,
        affectSourceHealth: prerequisite || deferred || backpressure || subrequestEnvelopeExhausted ? false : !senderStarted,
        retryDue: backpressure || subrequestEnvelopeExhausted,
      });
      if (prerequisite) {
        await env.DB
          .prepare("UPDATE sources SET last_error = ?, updated_at = ? WHERE id = ?")
          .bind(error.message, isoNow(), source.id)
          .run();
      }
      if (!backpressure && !prerequisite && !deferred && !subrequestEnvelopeExhausted) {
        await observeSourceCadence(env.DB, source, {
          status,
          itemCount: 0,
          latencyMs: Date.now() - started,
        }).catch((cadenceError) => console.error("Adaptive cadence update failed", cadenceError));
      }
      throw error;
    }
  });
}
