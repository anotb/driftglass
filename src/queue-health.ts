import type { Env } from "./types";
import { quarantineRecoveryHealth } from "./quarantine-recovery";
import { HttpError, isoNow } from "./utils";

export interface QueueBacklogSnapshot {
  available: boolean;
  backlogCount: number | null;
  backlogBytes: number | null;
  oldestMessageAt: string | null;
  error?: string;
}

export interface IngestQueueDurabilityHealth {
  checkedAt: string;
  primary: QueueBacklogSnapshot;
  deadLetter: QueueBacklogSnapshot;
  quarantine: QueueBacklogSnapshot;
  releaseBlocked: boolean;
  blockingReasons: string[];
}

export type IngestRecoverySelection =
  | { storage: "d1"; id: string }
  | { storage: "r2"; id: string };

type QueueBinding = Pick<Queue, "metrics">;
const PRIMARY_BACKLOG_MAX_AGE_MS = 10 * 60_000;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function backlog(binding: QueueBinding | undefined): Promise<QueueBacklogSnapshot> {
  if (!binding) {
    return {
      available: false,
      backlogCount: null,
      backlogBytes: null,
      oldestMessageAt: null,
      error: "Queue binding is missing",
    };
  }
  try {
    const metrics = await binding.metrics();
    return {
      available: true,
      backlogCount: Math.max(0, Number(metrics.backlogCount ?? 0)),
      backlogBytes: Math.max(0, Number(metrics.backlogBytes ?? 0)),
      oldestMessageAt: Number.isFinite(Number(metrics.oldestMessageTimestamp)) && Number(metrics.oldestMessageTimestamp) > 0
        ? new Date(Number(metrics.oldestMessageTimestamp)).toISOString()
        : metrics.oldestMessageTimestamp instanceof Date
          ? metrics.oldestMessageTimestamp.toISOString()
          : null,
    };
  } catch (error) {
    return {
      available: false,
      backlogCount: null,
      backlogBytes: null,
      oldestMessageAt: null,
      error: errorMessage(error),
    };
  }
}

function backlogAgeMs(snapshot: QueueBacklogSnapshot, now = Date.now()): number | null {
  if (!snapshot.oldestMessageAt) return null;
  const timestamp = Date.parse(snapshot.oldestMessageAt);
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
}

async function requirePrimaryQueueAvailableAndFresh(
  env: Pick<Env, "INGEST_QUEUE">,
): Promise<void> {
  const primary = await backlog(env.INGEST_QUEUE);
  if (!primary.available) {
    throw new HttpError(503, "Primary ingest Queue health is unavailable", {
      code: "INGEST_DLQ_UNAVAILABLE",
      primaryError: primary.error,
    });
  }
  const primaryCount = Number(primary.backlogCount ?? 0);
  const primaryAgeMs = backlogAgeMs(primary);
  if (primaryCount > 0 && (primaryAgeMs === null || primaryAgeMs >= PRIMARY_BACKLOG_MAX_AGE_MS)) {
    throw new HttpError(503, "Ingest is blocked by a stale primary Queue backlog", {
      code: "INGEST_PRIMARY_STALE",
      primary: {
        backlogCount: primary.backlogCount,
        backlogBytes: primary.backlogBytes,
        oldestMessageAt: primary.oldestMessageAt,
      },
      action: "Inspect the primary Queue consumer before collecting or retrying evidence.",
    });
  }
}

export async function ingestQueueDurabilityHealth(
  env: Pick<Env, "INGEST_QUEUE" | "INGEST_DLQ" | "INGEST_QUARANTINE">,
): Promise<IngestQueueDurabilityHealth> {
  const [primary, deadLetter, quarantine] = await Promise.all([
    backlog(env.INGEST_QUEUE),
    backlog(env.INGEST_DLQ),
    backlog(env.INGEST_QUARANTINE),
  ]);
  const blockingReasons: string[] = [];
  if (!primary.available) blockingReasons.push("Primary ingest Queue health is unavailable");
  if (Number(primary.backlogCount ?? 0) > 0) {
    const ageMs = backlogAgeMs(primary);
    const age = ageMs === null ? "unknown age" : `${Math.max(0, Math.floor(ageMs / 1_000))}s old`;
    blockingReasons.push(`Primary ingest Queue is draining ${primary.backlogCount} message${primary.backlogCount === 1 ? "" : "s"} (${age})`);
  }
  if (!deadLetter.available) blockingReasons.push("Dead-letter Queue health is unavailable");
  if (Number(deadLetter.backlogCount ?? 0) > 0) {
    blockingReasons.push(`${deadLetter.backlogCount} exhausted ingest message${deadLetter.backlogCount === 1 ? "" : "s"} require inspection`);
  }
  if (!quarantine.available) blockingReasons.push("Ingest quarantine Queue health is unavailable");
  if (Number(quarantine.backlogCount ?? 0) > 0) {
    blockingReasons.push(`${quarantine.backlogCount} ingest message${quarantine.backlogCount === 1 ? "" : "s"} could not be durably recorded from the dead-letter consumer`);
  }
  return {
    checkedAt: isoNow(),
    primary,
    deadLetter,
    quarantine,
    releaseBlocked: blockingReasons.length > 0,
    blockingReasons,
  };
}

/** Transport-only preflight shared by normal producers and owner recovery. */
export async function requireIngestQueueTransportDurability(
  env: Pick<Env, "INGEST_DLQ" | "INGEST_QUARANTINE">,
): Promise<void> {
  const [deadLetter, quarantine] = await Promise.all([
    backlog(env.INGEST_DLQ),
    backlog(env.INGEST_QUARANTINE),
  ]);
  if (!deadLetter.available || !quarantine.available) {
    throw new HttpError(503, "Ingest durability check is unavailable", {
      code: "INGEST_DLQ_UNAVAILABLE",
      deadLetterError: deadLetter.error,
      quarantineError: quarantine.error,
    });
  }
  if (Number(deadLetter.backlogCount ?? 0) > 0 || Number(quarantine.backlogCount ?? 0) > 0) {
    throw new HttpError(503, "Ingest is blocked by exhausted Queue messages", {
      code: "INGEST_DLQ_BLOCKED",
      deadLetter: { backlogCount: deadLetter.backlogCount, backlogBytes: deadLetter.backlogBytes },
      quarantine: { backlogCount: quarantine.backlogCount, backlogBytes: quarantine.backlogBytes },
      action: "Inspect the dead-letter and quarantine Queues and the corresponding source-run durability state before collecting more evidence.",
    });
  }
}

/**
 * Owner retry preflight. Durable incident records are the work this path is
 * explicitly draining, so neither the selected record nor independent D1/R2
 * incidents block one-at-a-time repair. Transport still fails closed: primary
 * health must be observable/non-stale and both failure Queues must be empty.
 */
export async function requireIngestRecoveryQueueDurability(
  env: Pick<Env, "INGEST_QUEUE" | "INGEST_DLQ" | "INGEST_QUARANTINE">,
  _selection: IngestRecoverySelection,
): Promise<void> {
  await requireIngestQueueTransportDurability(env);
  await requirePrimaryQueueAvailableAndFresh(env);
}

/** Fail closed before staging raw bodies or writing new Queue messages. */
export async function requireIngestQueueDurability(
  env: Pick<Env, "DB" | "EVIDENCE" | "INGEST_QUEUE" | "INGEST_DLQ" | "INGEST_QUARANTINE">,
): Promise<void> {
  await requireIngestQueueTransportDurability(env);
  await requirePrimaryQueueAvailableAndFresh(env);
  const [deadLetterDatabase, fallback] = await Promise.all([
    env.DB
      .prepare("SELECT COUNT(*) AS count FROM ingest_dead_letters WHERE status = 'unresolved'")
      .first<{ count: number }>()
      .then((value) => ({ value, error: null as unknown }))
      .catch((error: unknown) => ({ value: null, error })),
    // One budgeted R2 Class A list per otherwise transport-healthy normal
    // producer preflight makes the emergency store durable backpressure.
    quarantineRecoveryHealth(env),
  ]);
  if (deadLetterDatabase.error) {
    throw new HttpError(503, "Ingest durability check is unavailable", {
      code: "INGEST_DLQ_UNAVAILABLE",
      deadLetterDatabaseError: errorMessage(deadLetterDatabase.error),
    });
  }
  const unresolved = deadLetterDatabase.value;
  const unresolvedCount = Math.max(0, Number(unresolved?.count ?? 0));
  if (unresolvedCount > 0) {
    throw new HttpError(503, "Ingest is blocked by exhausted Queue messages", {
      code: "INGEST_DLQ_BLOCKED",
      unresolvedDeadLetters: unresolvedCount,
      action: "Retry or dismiss the unresolved ingest dead letters before collecting more evidence.",
    });
  }
  if (!fallback.available) {
    throw new HttpError(503, "Ingest durability check is unavailable", {
      code: "INGEST_DLQ_UNAVAILABLE",
      quarantineRecoveryError: fallback.error,
    });
  }
  if (Number(fallback.incidentCount ?? 0) > 0) {
    throw new HttpError(503, "Ingest is blocked by an emergency R2 recovery incident", {
      code: "INGEST_DLQ_BLOCKED",
      r2QuarantineRecoveries: fallback.incidentCount,
      action: "Retry or dismiss the private R2 quarantine recovery incident before collecting more evidence.",
    });
  }
}

export function isIngestDurabilityBackpressure(error: unknown): boolean {
  if (!(error instanceof HttpError) || !error.details || typeof error.details !== "object") return false;
  const code = String((error.details as Record<string, unknown>).code ?? "");
  return code === "INGEST_DLQ_UNAVAILABLE" || code === "INGEST_DLQ_BLOCKED" || code === "INGEST_PRIMARY_STALE";
}
