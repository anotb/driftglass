import {
  deleteEvidenceObjects,
  EMERGENCY_RECOVERY_MAX_BYTES,
  EMERGENCY_RECOVERY_PREFIX,
  getEvidenceObject,
  listEvidenceObjects,
  putEmergencyRecoveryObject,
} from "./r2-budget";
import {
  recordSourceRunIngestOutcome,
  recordUnresolvedIngestDeadLetter,
  type IngestDeadLetterSummary,
} from "./db";
import { sha256 } from "./security";
import type { Env, IngestMessage } from "./types";
import { HttpError, parseJson } from "./utils";

const INCIDENT_ID_PREFIX = "r2:";
const INCIDENT_KEY_PATTERN = /^recovery\/ingest-quarantine\/([a-f0-9]{64})\.json$/;

type RecoveryEnv = Pick<Env, "DB" | "EVIDENCE">;
type EmergencyRecoveryEnv = Pick<Env, "EVIDENCE">;

export interface QuarantineRecoverySummary {
  id: string;
  queue_message_id: string;
  queue_name: string;
  source_id: null;
  provider: "quarantine-fallback";
  source_run_id: null;
  source_run_item_index: null;
  attempts: number;
  reason: string;
  body_hash: string;
  body_bytes: number;
  status: "unresolved" | "resolved" | "ignored";
  created_at: string;
  resolved_at: string | null;
  storage: "r2";
}

export interface QuarantineRecoveryHealth {
  available: boolean;
  incidentCount: number | null;
  error?: string;
}

export interface QuarantineRecoveryHealthOptions {
  /** The one owner-selected incident may not block its own retry preflight. */
  excludeId?: string;
}

export interface MaterializedQuarantineRecovery {
  deadLetter: IngestDeadLetterSummary;
  summary: QuarantineRecoverySummary;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function bodyJson(message: IngestMessage): string {
  const serialized = JSON.stringify(message);
  if (typeof serialized !== "string") throw new Error("Quarantined ingest message is not JSON serializable");
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes <= 0 || bytes > EMERGENCY_RECOVERY_MAX_BYTES) {
    throw new Error(`Quarantined ingest recovery body exceeds ${EMERGENCY_RECOVERY_MAX_BYTES} bytes`);
  }
  return serialized;
}

function digestFromId(id: string): string | null {
  if (!id.startsWith(INCIDENT_ID_PREFIX)) return null;
  const digest = id.slice(INCIDENT_ID_PREFIX.length);
  return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}

function keyFromDigest(digest: string): string {
  return `${EMERGENCY_RECOVERY_PREFIX}${digest}.json`;
}

function summaryFromObject(object: R2Object, queueName: string): QuarantineRecoverySummary | null {
  const match = object.key.match(INCIDENT_KEY_PATTERN);
  if (!match) return null;
  const digest = match[1] ?? "";
  return {
    id: `${INCIDENT_ID_PREFIX}${digest}`,
    queue_message_id: `${INCIDENT_ID_PREFIX}${digest}`,
    queue_name: queueName,
    source_id: null,
    provider: "quarantine-fallback",
    source_run_id: null,
    source_run_item_index: null,
    attempts: Math.max(0, Math.floor(Number(object.customMetadata?.attempts ?? 0))) || 0,
    reason: "D1 dead-letter persistence failed; a private R2 recovery body requires owner action",
    body_hash: object.customMetadata?.bodySha256 ?? digest,
    body_bytes: object.size,
    status: "unresolved",
    created_at: object.uploaded.toISOString(),
    resolved_at: null,
    storage: "r2",
  };
}

/**
 * D1-unavailable escape hatch. The raw Queue JSON is the private recovery body;
 * the object key and metadata form a content-free deterministic incident index.
 */
export async function persistEmergencyQuarantineRecovery(
  env: EmergencyRecoveryEnv,
  message: Message<IngestMessage>,
  queueName: string,
): Promise<{ id: string; disposition: "stored" | "already-stored" }> {
  const serialized = bodyJson(message.body);
  const bodyHash = await sha256(serialized);
  const digest = await sha256(`${queueName}\n${message.id}\n${bodyHash}`);
  const disposition = await putEmergencyRecoveryObject(env, keyFromDigest(digest), serialized, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      kind: "driftglass-ingest-quarantine-v1",
      bodySha256: bodyHash,
      attempts: String(Math.max(0, Math.floor(message.attempts))),
    },
  });
  return { id: `${INCIDENT_ID_PREFIX}${digest}`, disposition };
}

export async function listQuarantineRecoveries(
  env: RecoveryEnv,
  queueName: string,
  limit = 100,
): Promise<QuarantineRecoverySummary[]> {
  const result = await listEvidenceObjects(env, {
    prefix: EMERGENCY_RECOVERY_PREFIX,
    limit: Math.max(1, Math.min(1_000, limit)),
    include: ["customMetadata"],
  });
  return result.objects
    .map((object) => summaryFromObject(object, queueName))
    .filter((summary): summary is QuarantineRecoverySummary => Boolean(summary))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, Math.max(1, Math.min(100, limit)));
}

export async function quarantineRecoveryHealth(
  env: RecoveryEnv,
  options: QuarantineRecoveryHealthOptions = {},
): Promise<QuarantineRecoveryHealth> {
  try {
    const excludedDigest = options.excludeId ? digestFromId(options.excludeId) : null;
    const excludedKey = excludedDigest ? keyFromDigest(excludedDigest) : null;
    const result = await listEvidenceObjects(env, {
      prefix: EMERGENCY_RECOVERY_PREFIX,
      // Two objects distinguish "only the selected incident" from any other
      // blocker without listing the private recovery inventory unboundedly.
      limit: excludedKey ? 2 : 1,
    });
    const hasOtherIncident = result.objects.some((object) => object.key !== excludedKey)
      || (Boolean(result.truncated) && result.objects.every((object) => object.key === excludedKey));
    return { available: true, incidentCount: hasOtherIncident ? 1 : 0 };
  } catch (error) {
    return { available: false, incidentCount: null, error: errorText(error) };
  }
}

export async function getQuarantineRecoveryMessage(
  env: RecoveryEnv,
  id: string,
  queueName: string,
): Promise<{
  message: IngestMessage;
  summary: QuarantineRecoverySummary;
  bodyJson: string;
  bodyHash: string;
}> {
  const digest = digestFromId(id);
  if (!digest) throw new HttpError(404, "Ingest dead letter not found");
  const object = await getEvidenceObject(env, keyFromDigest(digest));
  if (!object) throw new HttpError(404, "Ingest dead letter not found");
  const summary = summaryFromObject(object, queueName);
  if (!summary) throw new HttpError(404, "Ingest dead letter not found");
  if (object.size <= 0 || object.size > EMERGENCY_RECOVERY_MAX_BYTES) {
    throw new HttpError(409, "Quarantine recovery body exceeds its bounded size");
  }
  const serialized = await object.text();
  const actualBytes = new TextEncoder().encode(serialized).byteLength;
  if (actualBytes !== object.size) {
    throw new HttpError(409, "Quarantine recovery body size failed its integrity check");
  }
  const bodyHash = await sha256(serialized);
  if (
    object.customMetadata?.kind !== "driftglass-ingest-quarantine-v1" ||
    !/^[a-f0-9]{64}$/.test(object.customMetadata?.bodySha256 ?? "") ||
    object.customMetadata?.bodySha256 !== bodyHash
  ) {
    throw new HttpError(409, "Quarantine recovery body failed its integrity check");
  }
  const message = parseJson<IngestMessage | null>(serialized, null);
  if (!message || typeof message.sourceId !== "string" || !message.item || typeof message.item.title !== "string") {
    throw new HttpError(409, "Quarantine recovery body is invalid");
  }
  return {
    message,
    summary: { ...summary, body_hash: bodyHash, body_bytes: actualBytes },
    bodyJson: serialized,
    bodyHash,
  };
}

function trackedSourceRun(message: IngestMessage): { runId: string; itemIndex: number } | null {
  if (
    typeof message.sourceRunId === "string" && message.sourceRunId.length > 0 &&
    Number.isSafeInteger(message.sourceRunItemIndex) && Number(message.sourceRunItemIndex) >= 0
  ) {
    return { runId: message.sourceRunId, itemIndex: Number(message.sourceRunItemIndex) };
  }
  return null;
}

function validEmailReceiptClaim(message: IngestMessage): { messageId: string; claimToken: string } | undefined {
  const claim = message.emailReceiptClaim;
  if (
    claim && typeof claim === "object" &&
    typeof claim.messageId === "string" && claim.messageId.trim() &&
    typeof claim.claimToken === "string" && claim.claimToken.trim()
  ) {
    return { messageId: claim.messageId, claimToken: claim.claimToken };
  }
  return undefined;
}

function materializationReason(
  message: IngestMessage,
  summary: QuarantineRecoverySummary,
  trackingState: "terminalized" | "run-missing" | "receipt-missing" | "malformed" | "untracked",
): string {
  const emailState = message.emailReceiptClaim
    ? validEmailReceiptClaim(message) ? "email-claim-failed" : "email-claim-malformed"
    : "no-email-claim";
  return [
    "Emergency private-R2 quarantine recovery materialized",
    `tracking=${trackingState}`,
    emailState,
    `original_body_bytes=${Math.max(0, Math.floor(summary.body_bytes))}`,
    "storage=r2",
  ].join("; ");
}

async function materializedDeadLetter(
  db: D1Database,
  queueMessageId: string,
): Promise<IngestDeadLetterSummary | null> {
  return db
    .prepare(
      `SELECT id, queue_message_id, queue_name, source_id, provider,
              source_run_id, source_run_item_index, attempts, reason,
              body_hash, body_bytes, status, created_at, resolved_at
       FROM ingest_dead_letters WHERE queue_message_id = ?`,
    )
    .bind(queueMessageId)
    .first<IngestDeadLetterSummary>();
}

/**
 * Reconstitute one integrity-checked private R2 body as the normal D1 recovery
 * record before any owner action. Source-run and Email failure accounting is
 * idempotent; the stable queue_message_id makes repeated materialization safe.
 */
export async function materializeQuarantineRecovery(
  env: RecoveryEnv,
  id: string,
  queueName: string,
): Promise<MaterializedQuarantineRecovery> {
  const digest = digestFromId(id);
  if (!digest) throw new HttpError(404, "Ingest dead letter not found");
  const recovery = await getQuarantineRecoveryMessage(env, id, queueName);
  const queueMessageId = `${INCIDENT_ID_PREFIX}${digest}`;
  // A present row proves the earlier materialization batch (including an
  // Email failure update) committed. Do not replay those transitions during
  // cleanup, especially after a recovered Email has since reconciled queued.
  const existing = await materializedDeadLetter(env.DB, queueMessageId);
  if (existing) return { deadLetter: existing, summary: recovery.summary };

  const tracked = trackedSourceRun(recovery.message);
  let trackingState: "terminalized" | "run-missing" | "receipt-missing" | "malformed" | "untracked";
  if (tracked) {
    const receipt = await recordSourceRunIngestOutcome(env.DB, {
      runId: tracked.runId,
      sourceId: recovery.message.sourceId,
      itemIndex: tracked.itemIndex,
      outcome: "failed",
      error: "Primary ingest Queue retries were exhausted; recovered from private R2 quarantine",
    });
    trackingState = receipt.runFound
      ? receipt.receiptRecorded ? "terminalized" : "receipt-missing"
      : "run-missing";
  } else {
    trackingState = recovery.message.sourceRunId !== undefined || recovery.message.sourceRunItemIndex !== undefined
      ? "malformed"
      : "untracked";
  }

  await recordUnresolvedIngestDeadLetter(env.DB, {
    queueMessageId,
    queueName,
    sourceId: recovery.message.sourceId,
    provider: typeof recovery.message.provider === "string" ? recovery.message.provider : "quarantine-fallback",
    sourceRunId: typeof recovery.message.sourceRunId === "string" ? recovery.message.sourceRunId : undefined,
    sourceRunItemIndex: Number.isSafeInteger(recovery.message.sourceRunItemIndex) && Number(recovery.message.sourceRunItemIndex) >= 0
      ? Number(recovery.message.sourceRunItemIndex)
      : undefined,
    attempts: recovery.summary.attempts,
    reason: materializationReason(recovery.message, recovery.summary, trackingState),
    bodyJson: recovery.bodyJson,
    bodyHash: recovery.bodyHash,
    bodyBytes: recovery.summary.body_bytes,
    emailReceiptClaim: validEmailReceiptClaim(recovery.message),
  });

  const deadLetter = await materializedDeadLetter(env.DB, queueMessageId);
  if (!deadLetter) throw new Error("Materialized quarantine recovery could not be reloaded");
  return { deadLetter, summary: recovery.summary };
}

/** Delete the private body only after its D1 dead-letter action is durable. */
export async function deleteQuarantineRecoveryObject(
  env: EmergencyRecoveryEnv,
  id: string,
): Promise<void> {
  const digest = digestFromId(id);
  if (!digest) throw new HttpError(404, "Ingest dead letter not found");
  await deleteEvidenceObjects(env, keyFromDigest(digest));
}

export function isQuarantineRecoveryId(id: string): boolean {
  return digestFromId(id) !== null;
}
