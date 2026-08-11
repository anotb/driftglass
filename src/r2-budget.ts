import { requireBudget } from "./budget";
import type { Env } from "./types";

type EvidenceEnv = Pick<Env, "DB" | "EVIDENCE">;
type EvidencePutValue = Parameters<R2Bucket["put"]>[1];
type EvidenceBucketEnv = Pick<Env, "EVIDENCE">;

const encoder = new TextEncoder();

export const EMERGENCY_RECOVERY_PREFIX = "recovery/ingest-quarantine/";
export const EMERGENCY_RECOVERY_MAX_BYTES = 60_000;

export interface EvidencePutRequest {
  key: string;
  value: EvidencePutValue;
  options?: R2PutOptions;
}

function keyPrefix(key: string): string {
  const separator = key.indexOf("/");
  return (separator >= 0 ? key.slice(0, separator) : key).slice(0, 80) || "root";
}

/** Return the exact buffered byte size; unknown-length streams are intentionally unsupported. */
export function evidencePutByteLength(value: EvidencePutValue): number {
  if (value === null) return 0;
  if (typeof value === "string") return encoder.encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Blob) return value.size;
  throw new TypeError("Budgeted R2 writes require a bounded string, Blob, ArrayBuffer, or ArrayBufferView; streams must be bounded before upload");
}

/**
 * The sole core R2 put boundary. Reservations are deliberately conservative:
 * a failed R2 request keeps its reservation because it may still be billable.
 */
export async function putEvidenceObject(
  env: EvidenceEnv,
  key: string,
  value: EvidencePutValue,
  options?: R2PutOptions,
): Promise<R2Object | null> {
  const bytes = evidencePutByteLength(value);
  const metadata = { operation: "put", prefix: keyPrefix(key), bytes };
  await requireBudget(env.DB, "r2_write_bytes", bytes, metadata);
  await requireBudget(env.DB, "r2_class_a_ops", 1, metadata);
  return env.EVIDENCE.put(key, value, options);
}

/**
 * Reserves one exact aggregate byte amount and one aggregate Class A count,
 * then performs bounded puts. Unique caller-owned keys make whole-batch cleanup
 * safe after a partial failure; conservative reservations are intentionally not
 * refunded because Cloudflare may still account for attempted operations.
 */
export async function putEvidenceObjects(
  env: EvidenceEnv,
  requests: readonly EvidencePutRequest[],
): Promise<Array<R2Object | null>> {
  if (requests.length === 0) return [];
  const keys = requests.map((request) => request.key);
  if (new Set(keys).size !== keys.length) throw new TypeError("Budgeted R2 batch puts require unique keys");
  const bytes = requests.reduce((sum, request) => sum + evidencePutByteLength(request.value), 0);
  const prefixes = [...new Set(keys.map(keyPrefix))].slice(0, 20);
  const metadata = { operation: "put-batch", prefixes, objects: requests.length, bytes };
  await requireBudget(env.DB, "r2_write_bytes", bytes, metadata);
  await requireBudget(env.DB, "r2_class_a_ops", requests.length, metadata);
  const results: Array<R2Object | null> = [];
  try {
    for (const request of requests) {
      results.push(await env.EVIDENCE.put(request.key, request.value, request.options));
    }
    return results;
  } catch (error) {
    try {
      await env.EVIDENCE.delete(keys);
    } catch (cleanupError) {
      console.error(JSON.stringify({
        message: "Unable to clean partially written budgeted R2 batch",
        objects: keys.length,
        error: cleanupError instanceof Error ? cleanupError.message.slice(0, 300) : String(cleanupError).slice(0, 300),
      }));
    }
    throw error;
  }
}

/** The sole core R2 get boundary. Misses reserve one Class B operation too. */
export async function getEvidenceObject(
  env: EvidenceEnv,
  key: string,
): Promise<R2ObjectBody | null> {
  await requireBudget(env.DB, "r2_class_b_ops", 1, { operation: "get", prefix: keyPrefix(key) });
  return env.EVIDENCE.get(key);
}

/** R2 list is a Class A operation and must remain visible to the Budget Governor. */
export async function listEvidenceObjects(
  env: EvidenceEnv,
  options?: R2ListOptions,
): Promise<R2Objects> {
  await requireBudget(env.DB, "r2_class_a_ops", 1, {
    operation: "list",
    prefix: keyPrefix(options?.prefix ?? "root"),
    limit: options?.limit ?? null,
  });
  return env.EVIDENCE.list(options);
}

/** Cloudflare currently classifies R2 object deletion as a free operation. */
export async function deleteEvidenceObjects(
  env: EvidenceBucketEnv,
  keys: string | string[],
): Promise<void> {
  await env.EVIDENCE.delete(keys);
}

/**
 * Last-resort evidence preservation when D1 itself is unavailable.
 *
 * This is intentionally the only core R2 write that may bypass the D1-backed
 * Budget Governor. The keyspace and body size are hard bounded, and the
 * conditional write makes Queue redelivery idempotent. Callers must try the
 * normal D1 dead-letter store first.
 */
export async function putEmergencyRecoveryObject(
  env: EvidenceBucketEnv,
  key: string,
  value: string,
  options: Omit<R2PutOptions, "onlyIf"> = {},
): Promise<"stored" | "already-stored"> {
  if (!key.startsWith(EMERGENCY_RECOVERY_PREFIX) || !/^[a-f0-9]{64}\.json$/.test(key.slice(EMERGENCY_RECOVERY_PREFIX.length))) {
    throw new TypeError("Emergency R2 recovery writes are restricted to deterministic quarantine incident keys");
  }
  const bytes = evidencePutByteLength(value);
  if (bytes <= 0 || bytes > EMERGENCY_RECOVERY_MAX_BYTES) {
    throw new RangeError(`Emergency R2 recovery bodies must be between 1 and ${EMERGENCY_RECOVERY_MAX_BYTES} bytes`);
  }
  const stored = await env.EVIDENCE.put(key, value, {
    ...options,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return stored ? "stored" : "already-stored";
}
