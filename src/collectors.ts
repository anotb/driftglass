import {
  beginCollectorJobDispatch,
  claimCollectorJob,
  completeCollectorJob,
  consumePairingCode,
  createCollector,
  getCollectorByTokenHash,
  heartbeatCollector,
  listMissions,
  reviseSourceRunAfterPartialEnqueue,
  updateCollectorJobDispatch,
} from "./db";
import {
  exportMissionComputer,
  ensureMissionComputer,
  importMissionComputerFiles,
  requestMissionComputerSync,
} from "./mission-computer";
import { enqueueIngestMessages, IngestQueueSendError } from "./ingest-queue";
import { sha256 } from "./security";
import type { CollectorResultSummary, RelayResult, Env } from "./types";
import { HttpError, json, normalizeStringArray, readJson } from "./utils";

import {
  PAIRABLE_COLLECTOR_CAPABILITIES,
  READ_ONLY_CAPABILITIES,
  WORKSPACE_MIRROR_CAPABILITY,
} from "./relay-capabilities";
import {
  collectorResultFingerprint,
  collectorResultSummary,
  collectorDispatchRetryAfterMs,
  COMPANION_RESULT_MAX_ITEMS,
  isRelayResult,
  normalizeCompanionItems,
  parseCollectorResultSummary,
  relayResultValidationError,
} from "./collector-results";

async function settleDispatchedCollectorJob(
  env: Env,
  input: {
    jobId: string;
    collectorId: string;
    summary: CollectorResultSummary;
  },
): Promise<{ accepted: number; duplicate: true }> {
  const dispatch = input.summary.dispatch;
  if (!dispatch) throw new HttpError(409, "Collector job has incompatible result state");
  if (dispatch.phase !== "accepted") {
    throw new HttpError(409, "Collector result dispatch is incomplete; retry the successful result payload");
  }

  await completeCollectorJob(env.DB, {
    jobId: input.jobId,
    collectorId: input.collectorId,
    ok: true,
    resultSummary: input.summary,
    itemCount: input.summary.acceptedCount,
    provider: input.summary.provider,
  });
  return { accepted: input.summary.acceptedCount, duplicate: true };
}

class CollectorDispatchSettledError extends Error {
  constructor(public readonly accepted: number) {
    super("Collector result dispatch was settled by durable source-run receipts");
    this.name = "CollectorDispatchSettledError";
  }
}

async function settleTerminalSourceRunDispatch(
  env: Env,
  input: {
    jobId: string;
    collectorId: string;
    sourceId: string;
    sourceRunId: string;
    resultJson: string;
    summary: CollectorResultSummary;
  },
): Promise<{ accepted: number; duplicate: true } | null> {
  const dispatch = input.summary.dispatch;
  if (!dispatch || dispatch.phase !== "dispatching") return null;
  const run = await env.DB
    .prepare(
      `SELECT status, enqueued_count, collection_partial, terminal_accounted_at
       FROM source_runs WHERE id = ? AND source_id = ?`,
    )
    .bind(input.sourceRunId, input.sourceId)
    .first<{
      status: string;
      enqueued_count: number;
      collection_partial: number;
      terminal_accounted_at: string | null;
    }>();
  if (!run?.terminal_accounted_at || !["success", "partial", "failed"].includes(run.status)) return null;
  const acceptedCount = Math.min(dispatch.plannedCount, Math.max(0, Number(run.enqueued_count ?? 0)));
  const acceptedSummary: CollectorResultSummary = {
    ...input.summary,
    acceptedCount,
    dispatch: {
      ...dispatch,
      phase: "accepted",
      acceptedCount,
      collectionPartial: Boolean(run.collection_partial) || acceptedCount < dispatch.plannedCount,
    },
  };
  const transition = await updateCollectorJobDispatch(env.DB, {
    jobId: input.jobId,
    collectorId: input.collectorId,
    expectedResultJson: input.resultJson,
    resultSummary: acceptedSummary,
  });
  const current = transition.started ? acceptedSummary : parseCollectorResultSummary(transition.resultJson);
  if (!current?.dispatch || current.dispatch.fingerprint !== dispatch.fingerprint || current.dispatch.phase !== "accepted") {
    if (transition.status === "complete" && current) return { accepted: current.acceptedCount, duplicate: true };
    throw new HttpError(409, "Collector result dispatch changed while durable receipts were reconciled");
  }
  return settleDispatchedCollectorJob(env, {
    jobId: input.jobId,
    collectorId: input.collectorId,
    summary: current,
  });
}

async function authenticateCollector(request: Request, env: Env): Promise<{ id: string; capabilities: string[] }> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new HttpError(401, "Collector token required");
  const collector = await getCollectorByTokenHash(env.DB, await sha256(token));
  if (!collector) throw new HttpError(401, "Invalid collector token");
  return {
    id: collector.id,
    capabilities: normalizeStringArray(JSON.parse(collector.capabilities_json || "[]")),
  };
}

function requireCollectorCapability(collector: { capabilities: string[] }, capability: string): void {
  if (!collector.capabilities.includes(capability)) {
    throw new HttpError(403, "This Companion was not granted Mission workspace access; pair it again to enable mirroring");
  }
}

export async function handleCollectorRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/collector/pair" && request.method === "POST") {
    const body = await readJson<{ code?: string; name?: string; version?: string; capabilities?: string[] }>(request);
    const code = (body.code ?? "").trim().toUpperCase();
    if (!code) throw new HttpError(400, "Pairing code required");
    const requested = normalizeStringArray(body.capabilities);
    const capabilities = requested.filter((capability) => PAIRABLE_COLLECTOR_CAPABILITIES.includes(capability));
    if (!capabilities.some((capability) => READ_ONLY_CAPABILITIES.includes(capability))) {
      throw new HttpError(400, "No supported read-only capabilities were offered");
    }
    const pairing = await consumePairingCode(env.DB, await sha256(code));
    if (!pairing) throw new HttpError(400, "Pairing code is invalid or expired");
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const collectorId = await createCollector(env.DB, {
      name: (body.name ?? pairing.name ?? "Local relay").slice(0, 120),
      tokenHash: await sha256(token),
      capabilities,
    });
    await heartbeatCollector(env.DB, {
      collectorId,
      version: body.version,
      capabilities,
      details: { pairedAt: new Date().toISOString() },
    });
    return json({ ok: true, collectorId, token, capabilities });
  }

  const collector = await authenticateCollector(request, env);
  if (path === "/collector/heartbeat" && request.method === "POST") {
    const body = await readJson<{ version?: string; capabilities?: string[]; details?: Record<string, unknown> }>(request);
    await heartbeatCollector(env.DB, {
      collectorId: collector.id,
      version: body.version,
      // A heartbeat describes availability; it can never grant a new scope.
      capabilities: collector.capabilities,
      details: body.details,
    });
    return json({ ok: true, capabilities: collector.capabilities });
  }

  if (path === "/collector/workspaces" && request.method === "GET") {
    requireCollectorCapability(collector, WORKSPACE_MIRROR_CAPABILITY);
    const missions = await listMissions(env.DB);
    return json({
      ok: true,
      workspaces: missions.map((mission) => ({
        id: mission.id,
        name: mission.name,
        question: mission.question,
        status: mission.status,
        updatedAt: mission.updated_at,
      })),
    });
  }

  const workspaceMatch = path.match(/^\/collector\/workspaces\/([^/]+)$/);
  if (workspaceMatch && request.method === "GET") {
    requireCollectorCapability(collector, WORKSPACE_MIRROR_CAPABILITY);
    const missionId = decodeURIComponent(workspaceMatch[1] ?? "");
    // This authenticated Companion pull is an operational compatibility route,
    // not an owner-facing read. Preserve first-pull materialization explicitly.
    const existing = await ensureMissionComputer(env, missionId);
    const needsSync = !existing.syncedAt;
    const sync = needsSync
      ? await requestMissionComputerSync(env, missionId, "companion-workspace-pull")
      : null;
    if (sync?.status === "queued") {
      return json({
        ok: true,
        operation: "companion-workspace-pull",
        synchronized: false,
        missionId,
        computer: existing,
        files: {},
        sync,
      }, { status: 202 });
    }
    const synchronized = sync?.status === "complete";
    const computer = sync?.status === "complete" ? sync.computer : existing;
    const files = await exportMissionComputer(env, missionId);
    return json({ ok: true, operation: "companion-workspace-pull", synchronized, missionId, computer, files, ...(sync ? { sync } : {}) });
  }
  if (workspaceMatch && request.method === "PUT") {
    requireCollectorCapability(collector, WORKSPACE_MIRROR_CAPABILITY);
    const missionId = decodeURIComponent(workspaceMatch[1] ?? "");
    const body = await readJson<{ files?: Record<string, string> }>(request, 4_500_000);
    const imported = await importMissionComputerFiles(env, missionId, { files: body.files ?? {}, source: `companion:${collector.id}` });
    return json({ ok: true, missionId, ...imported });
  }

  if (path === "/collector/jobs" && request.method === "GET") {
    const job = await claimCollectorJob(env.DB, collector.id, collector.capabilities);
    if (!job) return new Response(null, { status: 204 });
    if (!collector.capabilities.includes(job.operation)) {
      await completeCollectorJob(env.DB, {
        jobId: job.id,
        collectorId: collector.id,
        ok: false,
        error: `Collector lacks capability ${job.operation}`,
      });
      return json({ ok: false, error: "Unsupported capability" }, { status: 409 });
    }
    return json({
      ok: true,
      job: {
        id: job.id,
        sourceId: job.source_id,
        operation: job.operation,
        args: JSON.parse(job.args_json || "{}"),
        attempts: job.attempts,
      },
    });
  }

  const match = path.match(/^\/collector\/jobs\/([^/]+)\/result$/);
  if (match && request.method === "POST") {
    const jobId = match[1] ?? "";
    const body = await readJson<{ ok?: boolean; result?: RelayResult; error?: string }>(request, 2_000_000);
    const result = body.result;
    if (body.ok === true) {
      const validationError = relayResultValidationError(result);
      if (validationError) {
        const oversized = isRelayResult(result) && result.items.length > COMPANION_RESULT_MAX_ITEMS;
        throw new HttpError(oversized ? 413 : 400, validationError);
      }
    }
    const successfulResult = body.ok === true && isRelayResult(result) ? result : undefined;
    const items = successfulResult ? normalizeCompanionItems(successfulResult.items) : [];
    const fingerprint = successfulResult ? await collectorResultFingerprint(successfulResult, items) : undefined;
    const jobSource = await env.DB
      .prepare("SELECT source_id, source_run_id, status, result_json FROM collector_jobs WHERE id = ? AND collector_id = ?")
      .bind(jobId, collector.id)
      .first<{ source_id: string; source_run_id: string | null; status: string; result_json: string | null }>();
    if (!jobSource) throw new HttpError(404, "Job not found");
    const storedSummary = parseCollectorResultSummary(jobSource.result_json);
    if (jobSource.result_json && !storedSummary) throw new HttpError(409, "Collector job has incompatible result state");
    if (jobSource.status === "complete") {
      if (fingerprint && storedSummary?.dispatch && storedSummary.dispatch.fingerprint !== fingerprint) {
        throw new HttpError(409, "Collector result conflicts with the result already accepted for this job");
      }
      const completedRun = jobSource.source_run_id
        ? await env.DB.prepare("SELECT enqueued_count FROM source_runs WHERE id = ?")
          .bind(jobSource.source_run_id)
          .first<{ enqueued_count: number }>()
        : null;
      return json({
        ok: true,
        accepted: storedSummary?.acceptedCount ?? Number(completedRun?.enqueued_count ?? 0),
        duplicate: true,
      });
    }
    if (jobSource.status !== "leased") throw new HttpError(409, `Collector job is ${jobSource.status}`);
    if (!jobSource.source_run_id) throw new HttpError(409, "Collector job is not attached to a durable source run");

    if (storedSummary?.dispatch) {
      if (
        fingerprint
        && storedSummary.dispatch.fingerprint !== fingerprint
        && storedSummary.dispatch.phase !== "retryable"
      ) {
        throw new HttpError(409, "Collector result conflicts with the dispatch already recorded for this job");
      }
      if (storedSummary.dispatch.phase === "accepted") {
        const settled = await settleDispatchedCollectorJob(env, {
          jobId,
          collectorId: collector.id,
          summary: storedSummary,
        });
        return json({ ok: true, ...settled }, { status: settled.accepted > 0 ? 202 : 200 });
      }
      if (storedSummary.dispatch.phase === "dispatching") {
        const settled = await settleTerminalSourceRunDispatch(env, {
          jobId,
          collectorId: collector.id,
          sourceId: jobSource.source_id,
          sourceRunId: jobSource.source_run_id,
          resultJson: jobSource.result_json!,
          summary: storedSummary,
        });
        if (settled) return json({ ok: true, ...settled }, { status: settled.accepted > 0 ? 202 : 200 });
      }
      if (!successfulResult) {
        throw new HttpError(409, "Collector result dispatch was not accepted; retry the successful result payload");
      }
      const retryAfterMs = collectorDispatchRetryAfterMs(storedSummary.dispatch);
      if (retryAfterMs !== null && retryAfterMs > 0) {
        throw new HttpError(409, "Collector result dispatch is still in progress", {
          code: "COLLECTOR_DISPATCH_IN_PROGRESS",
          retryAfterMs,
        });
      }
    } else if (jobSource.result_json) {
      throw new HttpError(409, "Collector job has incompatible result state");
    }

    if (!successfulResult || !fingerprint) {
      await completeCollectorJob(env.DB, {
        jobId,
        collectorId: collector.id,
        ok: false,
        error: body.error,
        itemCount: 0,
        provider: "driftglass-relay",
      });
      return json({ ok: true, accepted: 0 });
    }

    const provider = successfulResult.provider || "driftglass-relay";
    const collectionPartial = successfulResult.diagnostics?.collectionPartial === true;
    const dispatchAttemptId = crypto.randomUUID();
    const dispatchAttemptStartedAt = new Date().toISOString();
    let accepted = items.length;
    const dispatchDetails = {
      jobId,
      provider,
      collectedItems: items.length,
      queuedItems: items.length,
      collectionPartial,
      dispatchFingerprint: fingerprint,
    };
    const dispatchingSummary = collectorResultSummary(successfulResult, items.length, 0, {
      fingerprint,
      attemptId: dispatchAttemptId,
      attemptStartedAt: dispatchAttemptStartedAt,
      phase: "dispatching",
      plannedCount: items.length,
      collectionPartial,
    });
    let dispatchResultJson: string | null = null;
    const beginDispatch = async (): Promise<void> => {
      const transition = await beginCollectorJobDispatch(env.DB, {
        jobId,
        collectorId: collector.id,
        sourceId: jobSource.source_id,
        sourceRunId: jobSource.source_run_id!,
        expectedResultJson: jobSource.result_json,
        resultSummary: dispatchingSummary,
        details: dispatchDetails,
      });
      if (!transition.started) {
        const current = parseCollectorResultSummary(transition.resultJson);
        if (!current?.dispatch || current.dispatch.fingerprint !== fingerprint) {
          throw new HttpError(409, "Collector result dispatch changed concurrently");
        }
        if (current.dispatch.phase === "accepted") {
          const settled = await settleDispatchedCollectorJob(env, {
            jobId,
            collectorId: collector.id,
            summary: current,
          });
          throw new CollectorDispatchSettledError(settled.accepted);
        }
        if (current.dispatch.phase === "dispatching") {
          const settled = await settleTerminalSourceRunDispatch(env, {
            jobId,
            collectorId: collector.id,
            sourceId: jobSource.source_id,
            sourceRunId: jobSource.source_run_id!,
            resultJson: transition.resultJson!,
            summary: current,
          });
          if (settled) throw new CollectorDispatchSettledError(settled.accepted);
        }
        throw new HttpError(409, "Collector result dispatch is already in progress");
      }
      dispatchResultJson = transition.resultJson;
    };

    if (items.length === 0) {
      try {
        await beginDispatch();
      } catch (error) {
        if (error instanceof CollectorDispatchSettledError) {
          return json({ ok: true, accepted: error.accepted, duplicate: true });
        }
        throw error;
      }
    } else {
      try {
        await enqueueIngestMessages(
          env,
          items.map((item, index) => ({
            sourceId: jobSource.source_id,
            item,
            provider,
            sourceRunId: jobSource.source_run_id!,
            sourceRunItemIndex: index,
          })),
          {
            beforeSend: async () => beginDispatch(),
          },
        );
      } catch (error) {
        if (error instanceof CollectorDispatchSettledError) {
          return json({ ok: true, accepted: error.accepted, duplicate: true }, { status: error.accepted > 0 ? 202 : 200 });
        }
        if (!(error instanceof IngestQueueSendError) || error.sentCount === 0) {
          if (error instanceof IngestQueueSendError && dispatchResultJson) {
            await updateCollectorJobDispatch(env.DB, {
              jobId,
              collectorId: collector.id,
              expectedResultJson: dispatchResultJson,
              resultSummary: collectorResultSummary(successfulResult, items.length, 0, {
                fingerprint,
                attemptId: dispatchAttemptId,
                attemptStartedAt: dispatchAttemptStartedAt,
                phase: "retryable",
                plannedCount: items.length,
                collectionPartial,
              }),
            });
          }
          throw error;
        }
        accepted = error.sentCount;
        await reviseSourceRunAfterPartialEnqueue(env.DB, {
          runId: jobSource.source_run_id,
          sourceId: jobSource.source_id,
          sentCount: accepted,
          error: `Queue accepted ${accepted} of ${error.totalCount} Companion items`,
          details: {
            jobId,
            provider,
            collectedItems: items.length,
            queuedItems: accepted,
            unsentQueueItems: Math.max(0, error.totalCount - accepted),
            collectionPartial: true,
            queueSendPartial: true,
          },
        });
      }
    }

    if (!dispatchResultJson) throw new HttpError(409, "Collector result dispatch was not recorded");
    const acceptedSummary = collectorResultSummary(successfulResult, items.length, accepted, {
      fingerprint,
      attemptId: dispatchAttemptId,
      attemptStartedAt: dispatchAttemptStartedAt,
      phase: "accepted",
      plannedCount: items.length,
      collectionPartial: collectionPartial || accepted < items.length,
    });
    const acceptedTransition = await updateCollectorJobDispatch(env.DB, {
      jobId,
      collectorId: collector.id,
      expectedResultJson: dispatchResultJson,
      resultSummary: acceptedSummary,
    });
    if (!acceptedTransition.started) {
      const current = parseCollectorResultSummary(acceptedTransition.resultJson);
      if (acceptedTransition.status === "complete" && current) {
        return json({ ok: true, accepted: current.acceptedCount, duplicate: true }, { status: current.acceptedCount > 0 ? 202 : 200 });
      }
      if (!current?.dispatch || current.dispatch.fingerprint !== fingerprint || current.dispatch.phase !== "accepted") {
        throw new HttpError(409, "Collector result dispatch changed before completion");
      }
    }
    await completeCollectorJob(env.DB, {
      jobId,
      collectorId: collector.id,
      ok: true,
      resultSummary: acceptedSummary,
      itemCount: accepted,
      provider,
    });
    return json({ ok: true, accepted }, { status: accepted > 0 ? 202 : 200 });
  }

  throw new HttpError(404, "Collector endpoint not found");
}
