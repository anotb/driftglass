import type {
  Env,
  IngestMessage,
  IngestMessageInput,
  IngestPreparationProvenance,
  NormalizedItemInput,
  QueuedNormalizedItemInput,
} from "./types";
import { requireBudget } from "./budget";
import { putEvidenceObject, putEvidenceObjects, type EvidencePutRequest } from "./r2-budget";
import { requireIngestQueueDurability, requireIngestQueueTransportDurability } from "./queue-health";
import { safeFilename } from "./utils";

// Cloudflare Queues allows 128,000 bytes per message and 256,000 bytes per
// sendBatch call. Staying below 64 KB also keeps each delivery to one billed
// Queue operation per write/read/delete phase.
export const INGEST_QUEUE_MESSAGE_MAX_BYTES = 60_000;
export const INGEST_QUEUE_BATCH_MAX_BYTES = 230_000;
export const INGEST_QUEUE_BATCH_MAX_MESSAGES = 100;

const METADATA_MAX_BYTES = 8_000;
const TEXT_JSON_MAX_BYTES = 48_000;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_ENTRIES = 1_000;
const METADATA_PRIORITY_KEYS = [
  "watchTerms",
  "platform",
  "sender",
  "recipient",
  "messageId",
  "attachments",
  "attachmentCount",
  "contentType",
  "finalUrl",
  "mode",
  "preview",
];
const encoder = new TextEncoder();
const OMIT = Symbol("omit");

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type NormalizedJsonValue = JsonValue | typeof OMIT;

interface NormalizationState {
  changed: boolean;
  stack: Set<object>;
}

export interface PreparedIngestEntry {
  message: IngestMessage;
  rawR2Key?: string;
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : utf8ByteLength(serialized);
}

export function serializedIngestMessageBytes(message: IngestMessage): number {
  return jsonByteLength(message);
}

export function serializedIngestBatchBytes(messages: readonly IngestMessage[]): number {
  return jsonByteLength(messages.map((body) => ({ body, contentType: "json" })));
}

function utf8CharacterByteLength(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(value) <= maxBytes) return value;
  const parts: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8CharacterByteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    parts.push(character);
    bytes += characterBytes;
  }
  return parts.join("");
}

function jsonCharacterByteLength(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (character === "\"" || character === "\\") return 2;
  if (codePoint <= 0x1f) return [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(codePoint) ? 2 : 6;
  if (character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
  return utf8CharacterByteLength(character);
}

function truncateJsonString(value: string, maxBytes: number): string {
  if (maxBytes <= 2) return "";
  if (jsonByteLength(value) <= maxBytes) return value;
  const parts: string[] = [];
  let bytes = 2; // JSON quotes
  for (const character of value) {
    const characterBytes = jsonCharacterByteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    parts.push(character);
    bytes += characterBytes;
  }
  return parts.join("");
}

function normalizedJson(value: unknown, state: NormalizationState, depth: number, inArray: boolean): NormalizedJsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    state.changed = true;
    return null;
  }
  if (typeof value === "bigint") {
    state.changed = true;
    return value.toString();
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    state.changed = true;
    return inArray ? null : OMIT;
  }
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_METADATA_DEPTH) {
    state.changed = true;
    return "[truncated-depth]";
  }
  if (state.stack.has(value)) {
    state.changed = true;
    return "[circular]";
  }

  state.stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_METADATA_ENTRIES) state.changed = true;
      return value.slice(0, MAX_METADATA_ENTRIES).map((entry) => {
        const normalized = normalizedJson(entry, state, depth + 1, true);
        return normalized === OMIT ? null : normalized;
      });
    }

    const output: Record<string, JsonValue> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    if (keys.length > MAX_METADATA_ENTRIES) state.changed = true;
    for (const key of keys.slice(0, MAX_METADATA_ENTRIES)) {
      const normalized = normalizedJson((value as Record<string, unknown>)[key], state, depth + 1, false);
      if (normalized !== OMIT) output[key] = normalized;
    }
    return output;
  } finally {
    state.stack.delete(value);
  }
}

function fitJsonValue(value: JsonValue, maxBytes: number): JsonValue | undefined {
  if (jsonByteLength(value) <= maxBytes) return value;
  if (typeof value === "string") {
    if (maxBytes < 2) return undefined;
    return truncateJsonString(value, maxBytes);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return undefined;

  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    if (jsonByteLength(output) > maxBytes) return undefined;
    for (const entry of value) {
      const baseBytes = jsonByteLength([...output, null]);
      const valueBudget = Math.max(0, maxBytes - baseBytes + jsonByteLength(null));
      const fitted = fitJsonValue(entry, valueBudget);
      if (fitted === undefined) continue;
      const candidate = [...output, fitted];
      if (jsonByteLength(candidate) <= maxBytes) output.push(fitted);
    }
    return output;
  }

  const output: Record<string, JsonValue> = {};
  const priority = new Map(METADATA_PRIORITY_KEYS.map((key, index) => [key, index]));
  const keys = Object.keys(value).sort((left, right) => {
    const leftPriority = priority.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priority.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const key of keys) {
    const baseCandidate = { ...output, [key]: null };
    if (jsonByteLength(baseCandidate) > maxBytes) continue;
    const valueBudget = Math.max(0, maxBytes - jsonByteLength(baseCandidate) + jsonByteLength(null));
    const fitted = fitJsonValue(value[key] ?? null, valueBudget);
    if (fitted === undefined) continue;
    const candidate = { ...output, [key]: fitted };
    if (jsonByteLength(candidate) <= maxBytes) output[key] = fitted;
  }
  return output;
}

function prepareMetadata(value: unknown): {
  metadata: Record<string, unknown>;
  originalBytes: number;
  queuedBytes: number;
  truncated: boolean;
} {
  let originalBytes = 0;
  try {
    originalBytes = jsonByteLength(value ?? {});
  } catch {
    // Cyclic and otherwise non-JSON metadata is normalized below.
  }

  const state: NormalizationState = { changed: false, stack: new Set() };
  const normalized = normalizedJson(value ?? {}, state, 0, false);
  const record = normalized !== OMIT && normalized !== null && !Array.isArray(normalized) && typeof normalized === "object"
    ? normalized
    : {};
  if (record !== normalized) state.changed = true;
  if (originalBytes === 0) originalBytes = jsonByteLength(record);
  const fitted = fitJsonValue(record, METADATA_MAX_BYTES);
  const metadata = fitted && !Array.isArray(fitted) && typeof fitted === "object" ? fitted : {};
  const queuedBytes = jsonByteLength(metadata);
  return {
    metadata,
    originalBytes,
    queuedBytes,
    truncated: state.changed || JSON.stringify(metadata) !== JSON.stringify(record),
  };
}

function boundedOptional(value: string | undefined, maxJsonBytes: number): string | undefined {
  return typeof value === "string" ? truncateJsonString(value, maxJsonBytes) : undefined;
}

function managedPublicRawR2Key(value: string | undefined, sourceId: string): string | undefined {
  if (!value || value.length > 500) return undefined;
  if (!/^raw\/\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9._-]+\/[0-9a-f-]{36}\.txt$/.test(value)) return undefined;
  const expectedSourceSegment = safeFilename(sourceId) || "source";
  return value.split("/")[2] === expectedSourceSegment ? value : undefined;
}

export function linkedPublicRawR2Key(message: IngestMessage): string | undefined {
  if ((message.item.accessClass ?? "public") !== "public") return undefined;
  return managedPublicRawR2Key(message.rawR2Key, message.sourceId);
}

function buildPreparedMessage(
  input: IngestMessageInput,
  metadata: Record<string, unknown>,
  text: string | undefined,
  rawR2Key: string | undefined,
  provenance: IngestPreparationProvenance,
): IngestMessage {
  const sourceId = truncateJsonString(input.sourceId, 512);
  if (sourceId !== input.sourceId) throw new Error("Ingest sourceId exceeds the queue-safe bound");
  const sourceRunId = boundedOptional(input.sourceRunId, 128);
  const sourceRunItemIndex = input.sourceRunItemIndex;
  const hasRunId = typeof input.sourceRunId === "string";
  const hasRunIndex = sourceRunItemIndex !== undefined;
  if (hasRunId !== hasRunIndex) throw new Error("Ingest source-run tracking requires both an ID and item index");
  if (hasRunId && (
    sourceRunId !== input.sourceRunId
    || !sourceRunId
    || !Number.isSafeInteger(sourceRunItemIndex)
    || Number(sourceRunItemIndex) < 0
    || Number(sourceRunItemIndex) > 10_000
  )) throw new Error("Invalid ingest source-run tracking metadata");
  const emailReceiptClaim = input.emailReceiptClaim
    ? {
      messageId: truncateJsonString(input.emailReceiptClaim.messageId, 1_000),
      claimToken: truncateJsonString(input.emailReceiptClaim.claimToken, 128),
    }
    : undefined;
  if (emailReceiptClaim && (
    emailReceiptClaim.messageId !== input.emailReceiptClaim?.messageId
    || emailReceiptClaim.claimToken !== input.emailReceiptClaim?.claimToken
    || input.provider !== "cloudflare-email"
    || (input.item.accessClass ?? "public") === "public"
  )) {
    throw new Error("Invalid Email receipt claim on ingest message");
  }
  const item: QueuedNormalizedItemInput = {
    externalId: boundedOptional(input.item.externalId, 1_000),
    url: boundedOptional(input.item.url, 4_000),
    title: truncateJsonString(input.item.title ?? "", 2_500),
    text,
    author: boundedOptional(input.item.author, 1_000),
    publishedAt: boundedOptional(input.item.publishedAt, 256),
    observedAt: boundedOptional(input.item.observedAt, 256),
    accessClass: input.item.accessClass,
    metadata,
  };
  return {
    sourceId,
    item,
    provider: boundedOptional(input.provider, 512),
    sourceRunId,
    sourceRunItemIndex: hasRunIndex ? Number(sourceRunItemIndex) : undefined,
    emailReceiptClaim,
    rawR2Key,
    preparation: provenance,
  };
}

/** Pure, deterministic queue serialization boundary. The caller supplies the managed R2 key, if any. */
export function prepareQueueSafeIngestMessage(input: IngestMessageInput, rawR2Key?: string): IngestMessage {
  const accessClass = input.item.accessClass ?? "public";
  const linkedRawR2Key = accessClass === "public" ? managedPublicRawR2Key(rawR2Key, input.sourceId) : undefined;
  const originalText = input.item.text ?? "";
  let queuedText = input.item.text === undefined ? undefined : truncateJsonString(originalText, TEXT_JSON_MAX_BYTES);
  let preparedMetadata = prepareMetadata(input.item.metadata);
  const originalRawBytes = utf8ByteLength(input.item.raw ?? "");

  const build = (): IngestMessage => {
    const provenance: IngestPreparationProvenance = {
      version: 1,
      queueMessageLimitBytes: INGEST_QUEUE_MESSAGE_MAX_BYTES,
      originalTextBytes: utf8ByteLength(originalText),
      queuedTextBytes: utf8ByteLength(queuedText ?? ""),
      textTruncated: queuedText !== undefined && queuedText !== originalText,
      originalMetadataBytes: preparedMetadata.originalBytes,
      queuedMetadataBytes: preparedMetadata.queuedBytes,
      metadataTruncated: preparedMetadata.truncated,
      originalRawBytes,
      rawDisposition: originalRawBytes === 0
        ? "none"
        : accessClass === "public" && linkedRawR2Key
          ? "stored-public-r2"
          : accessClass === "public"
            ? "unstored-public"
            : "discarded-restricted",
    };
    return buildPreparedMessage(input, preparedMetadata.metadata, queuedText, linkedRawR2Key, provenance);
  };

  let message = build();
  while (serializedIngestMessageBytes(message) > INGEST_QUEUE_MESSAGE_MAX_BYTES && queuedText) {
    const overage = serializedIngestMessageBytes(message) - INGEST_QUEUE_MESSAGE_MAX_BYTES;
    const nextJsonBudget = Math.max(2, jsonByteLength(queuedText) - overage - 64);
    queuedText = truncateJsonString(queuedText, nextJsonBudget);
    message = build();
  }

  if (serializedIngestMessageBytes(message) > INGEST_QUEUE_MESSAGE_MAX_BYTES) {
    preparedMetadata = {
      ...preparedMetadata,
      metadata: {},
      queuedBytes: 2,
      truncated: true,
    };
    message = build();
  }

  const bytes = serializedIngestMessageBytes(message);
  if (bytes > INGEST_QUEUE_MESSAGE_MAX_BYTES) {
    throw new Error(`Unable to prepare queue-safe ingest message (${bytes} bytes)`);
  }
  return message;
}

function rawCaptureDate(item: NormalizedItemInput): string {
  if (item.observedAt && Number.isFinite(Date.parse(item.observedAt))) {
    return new Date(item.observedAt).toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

async function cleanupRawKeys(env: Env, keys: readonly string[], reason: string): Promise<void> {
  if (keys.length === 0) return;
  try {
    await env.EVIDENCE.delete([...keys]);
  } catch (error) {
    console.error(JSON.stringify({
      message: "Unable to clean staged ingest raw objects",
      reason,
      keys,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function prepareEntry(env: Env, input: IngestMessageInput): Promise<PreparedIngestEntry> {
  const accessClass = input.item.accessClass ?? "public";
  let rawR2Key: string | undefined;
  if (accessClass === "public" && input.item.raw) {
    const sourceSegment = safeFilename(input.sourceId) || "source";
    rawR2Key = `raw/${rawCaptureDate(input.item)}/${sourceSegment}/${crypto.randomUUID()}.txt`;
    try {
      await putEvidenceObject(env, rawR2Key, input.item.raw, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: {
          sourceId: input.sourceId.slice(0, 200),
          capturedAt: input.item.observedAt && Number.isFinite(Date.parse(input.item.observedAt))
            ? input.item.observedAt
            : new Date().toISOString(),
        },
      });
    } catch (error) {
      await cleanupRawKeys(env, [rawR2Key], "raw-stage-failed");
      if (error instanceof Error && error.name === "BudgetDeferredError") throw error;
      throw new Error(`Unable to stage public raw evidence for ${input.sourceId}`, { cause: error });
    }
  }

  try {
    return { message: prepareQueueSafeIngestMessage(input, rawR2Key), rawR2Key };
  } catch (error) {
    if (rawR2Key) await cleanupRawKeys(env, [rawR2Key], "message-preparation-failed");
    throw error;
  }
}

/**
 * Prepares exact Queue bodies for a durable producer without sending them.
 * Callers own the returned managed raw keys until their durable handoff is
 * committed. This intentionally does not reserve Queue budget or perform a
 * transport preflight; the producer must order those operations around its
 * own atomic state transition.
 */
export async function prepareIngestEntries(
  env: Env,
  inputs: readonly IngestMessageInput[],
): Promise<PreparedIngestEntry[]> {
  const rawKeys = new Map<number, string>();
  const rawRequests: EvidencePutRequest[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index]!;
    if ((input.item.accessClass ?? "public") !== "public" || !input.item.raw) continue;
    const sourceSegment = safeFilename(input.sourceId) || "source";
    const key = `raw/${rawCaptureDate(input.item)}/${sourceSegment}/${crypto.randomUUID()}.txt`;
    rawKeys.set(index, key);
    rawRequests.push({
      key,
      value: input.item.raw,
      options: {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: {
          sourceId: input.sourceId.slice(0, 200),
          capturedAt: input.item.observedAt && Number.isFinite(Date.parse(input.item.observedAt))
            ? input.item.observedAt
            : new Date().toISOString(),
        },
      },
    });
  }
  await putEvidenceObjects(env, rawRequests);
  try {
    return inputs.map((input, index) => ({
      message: prepareQueueSafeIngestMessage(input, rawKeys.get(index)),
      rawR2Key: rawKeys.get(index),
    }));
  } catch (error) {
    await cleanupRawKeys(env, [...rawKeys.values()], "durable-producer-preparation-failed");
    throw error;
  }
}

/** Removes public raw captures when a prepared durable handoff is abandoned. */
export async function cleanupPreparedIngestEntries(
  env: Env,
  entries: readonly PreparedIngestEntry[],
  reason: string,
): Promise<void> {
  await cleanupRawKeys(
    env,
    entries.flatMap((entry) => entry.rawR2Key ? [entry.rawR2Key] : []),
    reason,
  );
}

async function sendPreparedBatch(env: Env, entries: readonly PreparedIngestEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const messages = entries.map((entry) => entry.message);
  const batchBytes = serializedIngestBatchBytes(messages);
  if (entries.length > INGEST_QUEUE_BATCH_MAX_MESSAGES || batchBytes > INGEST_QUEUE_BATCH_MAX_BYTES) {
    throw new Error(`Unable to prepare queue-safe ingest batch (${entries.length} messages, ${batchBytes} bytes)`);
  }
  await env.INGEST_QUEUE.sendBatch(messages.map((body) => ({ body, contentType: "json" as const })));
}

export interface EnqueueIngestOptions {
  /** Runs after all preparation succeeds and immediately before the first send. */
  beforeSend?: (messageCount: number) => Promise<void>;
}

export interface EnqueueIngestResult {
  sentCount: number;
}

export class IngestQueueSendError extends Error {
  constructor(
    public readonly sentCount: number,
    public readonly totalCount: number,
    cause: unknown,
  ) {
    const causeText = (cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
    super(`Ingest Queue send stopped after ${sentCount} of ${totalCount} messages: ${causeText}`, { cause });
    this.name = "IngestQueueSendError";
  }
}

function validRecoveryPreparation(value: IngestPreparationProvenance | undefined): value is IngestPreparationProvenance {
  if (!value || value.version !== 1) return false;
  for (const field of [
    "queueMessageLimitBytes",
    "originalTextBytes",
    "queuedTextBytes",
    "originalMetadataBytes",
    "queuedMetadataBytes",
    "originalRawBytes",
  ] as const) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return false;
  }
  return typeof value.textTruncated === "boolean"
    && typeof value.metadataTruncated === "boolean"
    && ["none", "stored-public-r2", "unstored-public", "discarded-restricted"].includes(value.rawDisposition);
}

/**
 * Owner-triggered recovery for a previously validated Queue body. It strips
 * stale run tracking while preserving only a source-scoped managed raw key and
 * its bounded preparation provenance.
 */
export async function enqueueRecoveryIngestMessage(env: Env, input: IngestMessage): Promise<EnqueueIngestResult> {
  // The owner is draining this D1 dead letter, so bypass only the stored-record
  // blocker. DLQ/quarantine transport health remains mandatory.
  await requireIngestQueueTransportDurability(env);
  const managedRawKey = linkedPublicRawR2Key(input);
  const prepared = prepareQueueSafeIngestMessage({
    sourceId: input.sourceId,
    item: input.item,
    provider: input.provider,
    emailReceiptClaim: input.emailReceiptClaim,
  }, managedRawKey);
  if (
    managedRawKey === input.rawR2Key
    && validRecoveryPreparation(input.preparation)
  ) {
    prepared.preparation = { ...input.preparation };
  }
  if (serializedIngestMessageBytes(prepared) > INGEST_QUEUE_MESSAGE_MAX_BYTES) {
    throw new Error("Recovered ingest message exceeds the queue-safe bound");
  }
  await requireBudget(env.DB, "queue_messages", 1, {
    producers: [input.provider ?? "dead-letter-recovery"],
    sourceCount: 1,
    recovery: true,
  });
  try {
    await env.INGEST_QUEUE.sendBatch([{ body: prepared, contentType: "json" }]);
  } catch (error) {
    throw new IngestQueueSendError(0, 1, error);
  }
  return { sentCount: 1 };
}

function preparedBatches(entries: readonly PreparedIngestEntry[]): PreparedIngestEntry[][] {
  const batches: PreparedIngestEntry[][] = [];
  let batch: PreparedIngestEntry[] = [];
  for (const entry of entries) {
    const candidate = [...batch, entry];
    const candidateBytes = serializedIngestBatchBytes(candidate.map((item) => item.message));
    if (batch.length > 0 && (
      candidate.length > INGEST_QUEUE_BATCH_MAX_MESSAGES ||
      candidateBytes > INGEST_QUEUE_BATCH_MAX_BYTES
    )) {
      batches.push(batch);
      batch = [];
    }
    batch.push(entry);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** The only producer path for NormalizedItemInput Queue messages. */
export async function enqueueIngestMessages(
  env: Env,
  inputs: readonly IngestMessageInput[],
  options: EnqueueIngestOptions = {},
): Promise<EnqueueIngestResult> {
  if (inputs.length === 0) return { sentCount: 0 };
  await requireIngestQueueDurability(env);
  await requireBudget(env.DB, "queue_messages", inputs.length, {
    producers: [...new Set(inputs.map((input) => input.provider ?? "unknown"))].slice(0, 20),
    sourceCount: new Set(inputs.map((input) => input.sourceId)).size,
  });
  const entries: PreparedIngestEntry[] = [];
  for (const input of inputs) {
    let entry: PreparedIngestEntry;
    try {
      entry = await prepareEntry(env, input);
    } catch (error) {
      await cleanupRawKeys(
        env,
        entries.flatMap((item) => item.rawR2Key ? [item.rawR2Key] : []),
        "later-message-preparation-failed",
      );
      throw error;
    }
    entries.push(entry);
  }
  const batches = preparedBatches(entries);
  try {
    await options.beforeSend?.(entries.length);
  } catch (error) {
    await cleanupRawKeys(env, entries.flatMap((entry) => entry.rawR2Key ? [entry.rawR2Key] : []), "before-send-failed");
    throw error;
  }

  let sentCount = 0;
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index] ?? [];
    try {
      await sendPreparedBatch(env, batch);
      sentCount += batch.length;
    } catch (error) {
      const unsent = batches.slice(index).flat();
      await cleanupRawKeys(
        env,
        unsent.flatMap((entry) => entry.rawR2Key ? [entry.rawR2Key] : []),
        "queue-send-failed",
      );
      throw new IngestQueueSendError(sentCount, entries.length, error);
    }
  }
  return { sentCount };
}
