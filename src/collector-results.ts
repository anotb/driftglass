import { sha256 } from "./security";
import type {
  CollectorDispatchPhase,
  CollectorDispatchState,
  CollectorResultSummary,
  NormalizedItemInput,
  RelayResult,
} from "./types";
import { stableStringify } from "./utils";

export const COMPANION_RESULT_MAX_ITEMS = 250;
export const COMPANION_DISPATCH_TAKEOVER_MS = 60_000;

export function isRelayResult(value: unknown): value is RelayResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.provider === "string"
    && record.provider.trim().length > 0
    && Array.isArray(record.items)
    && record.items.every((item) => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    && (record.diagnostics === undefined || (
      Boolean(record.diagnostics)
      && typeof record.diagnostics === "object"
      && !Array.isArray(record.diagnostics)
    ));
}

export function relayResultValidationError(value: unknown): string | null {
  if (!isRelayResult(value)) return "Successful Collector results require a provider and items array";
  if (value.items.length > COMPANION_RESULT_MAX_ITEMS) {
    return `Collector results are limited to ${COMPANION_RESULT_MAX_ITEMS} items; no items were accepted`;
  }
  return null;
}

export function normalizeCompanionItems(value: unknown): NormalizedItemInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      externalId: typeof item.externalId === "string" ? item.externalId : undefined,
      url: typeof item.url === "string" ? item.url : undefined,
      title: typeof item.title === "string" ? item.title : "Untitled collected item",
      text: typeof item.text === "string" ? item.text : undefined,
      author: typeof item.author === "string" ? item.author : undefined,
      publishedAt: typeof item.publishedAt === "string" ? item.publishedAt : undefined,
      observedAt: typeof item.observedAt === "string" ? item.observedAt : undefined,
      accessClass:
        item.accessClass === "subscriber-local" || item.accessClass === "private"
          ? item.accessClass
          : "authenticated-local",
      metadata: item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : {},
      // Raw authenticated response bodies are intentionally ignored at the cloud boundary.
    }));
}

export async function collectorResultFingerprint(
  result: RelayResult,
  normalizedItems: readonly NormalizedItemInput[],
): Promise<string> {
  return sha256(stableStringify({
    provider: result.provider.trim(),
    items: normalizedItems,
  }));
}

export function collectorDispatchRetryAfterMs(
  dispatch: CollectorDispatchState,
  now = Date.now(),
): number | null {
  if (dispatch.phase === "accepted") return null;
  if (dispatch.phase === "retryable") return 0;
  const startedAt = Date.parse(dispatch.attemptStartedAt);
  if (!Number.isFinite(startedAt)) return COMPANION_DISPATCH_TAKEOVER_MS;
  return Math.max(0, startedAt + COMPANION_DISPATCH_TAKEOVER_MS - now);
}

function boundedCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isDispatchState(value: unknown): value is CollectorDispatchState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.fingerprint === "string"
    && /^[0-9a-f]{64}$/.test(record.fingerprint)
    && typeof record.attemptId === "string"
    && record.attemptId.length >= 16
    && record.attemptId.length <= 100
    && typeof record.attemptStartedAt === "string"
    && Number.isFinite(Date.parse(record.attemptStartedAt))
    && ["dispatching", "retryable", "accepted"].includes(String(record.phase))
    && Number.isSafeInteger(record.plannedCount)
    && Number(record.plannedCount) >= 0
    && Number.isSafeInteger(record.acceptedCount)
    && Number(record.acceptedCount) >= 0
    && Number(record.acceptedCount) <= Number(record.plannedCount)
    && typeof record.collectionPartial === "boolean";
}

export function parseCollectorResultSummary(value: string | null | undefined): CollectorResultSummary | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.provider !== "string"
    || !Number.isSafeInteger(record.collectedCount)
    || Number(record.collectedCount) < 0
    || !Number.isSafeInteger(record.acceptedCount)
    || Number(record.acceptedCount) < 0
    || !record.diagnostics
    || typeof record.diagnostics !== "object"
    || Array.isArray(record.diagnostics)
  ) return null;
  const diagnostics = Object.fromEntries(
    Object.entries(record.diagnostics as Record<string, unknown>)
      .filter((entry): entry is [string, number | boolean] => (
        typeof entry[1] === "boolean" || (typeof entry[1] === "number" && Number.isFinite(entry[1]))
      )),
  );
  if (Object.keys(diagnostics).length !== Object.keys(record.diagnostics as Record<string, unknown>).length) return null;
  const dispatch = record.dispatch === undefined ? undefined : isDispatchState(record.dispatch) ? record.dispatch : null;
  if (dispatch === null) return null;
  if (record.completionId !== undefined && typeof record.completionId !== "string") return null;
  const summary: CollectorResultSummary = {
    provider: record.provider,
    collectedCount: Number(record.collectedCount),
    acceptedCount: Number(record.acceptedCount),
    diagnostics,
    dispatch,
  };
  if (typeof record.completionId === "string") summary.completionId = record.completionId;
  return summary;
}

export function collectorResultSummary(
  result: RelayResult | undefined,
  collectedCount: number,
  acceptedCount: number,
  dispatch?: {
    fingerprint: string;
    attemptId: string;
    attemptStartedAt: string;
    phase: CollectorDispatchPhase;
    plannedCount?: number;
    collectionPartial?: boolean;
  },
): CollectorResultSummary {
  const diagnostics: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(result?.diagnostics ?? {}).slice(0, 20)) {
    if (typeof value === "boolean") diagnostics[key.slice(0, 80)] = value;
    if (typeof value === "number" && Number.isFinite(value)) diagnostics[key.slice(0, 80)] = value;
  }
  const summary: CollectorResultSummary = {
    provider: (result?.provider || "driftglass-relay").slice(0, 200),
    collectedCount: boundedCount(collectedCount),
    acceptedCount: boundedCount(acceptedCount),
    diagnostics,
  };
  if (dispatch) {
    const plannedCount = boundedCount(dispatch.plannedCount ?? collectedCount);
    summary.acceptedCount = Math.min(summary.acceptedCount, plannedCount);
    summary.dispatch = {
      version: 1,
      fingerprint: dispatch.fingerprint,
      attemptId: dispatch.attemptId,
      attemptStartedAt: dispatch.attemptStartedAt,
      phase: dispatch.phase,
      plannedCount,
      acceptedCount: summary.acceptedCount,
      collectionPartial: Boolean(dispatch.collectionPartial),
    };
  }
  return summary;
}
