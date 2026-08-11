import type { ExecutionCapacity } from "./types";
import { HttpError } from "./utils";

export type BrowserAdmissionKind = "session" | "quick-action";

export const BROWSER_ADMISSION_MAX_WAIT_MS = 30_000;
export const FREE_BROWSER_SESSION_INTERVAL_MS = 30_000;
export const CHEAP_BROWSER_SESSION_INTERVAL_MS = 9_000;
export const FREE_BROWSER_QUICK_ACTION_INTERVAL_MS = 10_000;
export const CHEAP_BROWSER_QUICK_ACTION_INTERVAL_MS = 100;

const MAX_SAFE_EPOCH_MS = 8_640_000_000_000_000;

const ADMISSION_KEYS: Record<BrowserAdmissionKind, string> = {
  session: "browser_admission_next_session_ms",
  "quick-action": "browser_admission_next_quick_action_ms",
};

export interface BrowserAdmissionClaim {
  readonly kind: BrowserAdmissionKind;
  readonly scheduledAtMs: number;
  readonly waitMs: number;
  readonly intervalMs: number;
}

export class BrowserAdmissionDeferredError extends HttpError {
  readonly kind: BrowserAdmissionKind;
  readonly retryAfterMs: number;

  constructor(kind: BrowserAdmissionKind, retryAfterMs: number) {
    const boundedRetryMs = Math.max(1, Math.ceil(retryAfterMs));
    super(429, "Browser admission is busy; retry later", {
      code: "BROWSER_ADMISSION_BUSY",
      kind,
      retryAfterSeconds: Math.max(1, Math.ceil(boundedRetryMs / 1_000)),
    });
    this.name = "BrowserAdmissionDeferredError";
    this.kind = kind;
    this.retryAfterMs = boundedRetryMs;
  }
}

export function browserAdmissionInterval(
  kind: BrowserAdmissionKind,
  executionCapacity: ExecutionCapacity,
): number {
  const expanded = executionCapacity === "expanded-confirmed";
  if (kind === "session") {
    return expanded ? CHEAP_BROWSER_SESSION_INTERVAL_MS : FREE_BROWSER_SESSION_INTERVAL_MS;
  }
  return expanded ? CHEAP_BROWSER_QUICK_ACTION_INTERVAL_MS : FREE_BROWSER_QUICK_ACTION_INTERVAL_MS;
}

function validNowMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_EPOCH_MS) {
    throw new TypeError("Browser admission requires a safe epoch-millisecond clock");
  }
  return value;
}

/**
 * Claims one deployment-wide browser start slot through a single atomic D1
 * upsert. The stored value is the next free start time, so a crashed or
 * canceled caller can only waste a slot; it cannot make a later caller start
 * early. Invalid or excessively future state fails closed.
 */
export async function claimBrowserAdmission(
  db: D1Database,
  kind: BrowserAdmissionKind,
  executionCapacity: ExecutionCapacity,
  options: { nowMs?: number; maxWaitMs?: number } = {},
): Promise<BrowserAdmissionClaim> {
  const nowMs = validNowMs(options.nowMs ?? Date.now());
  const maxWaitMs = options.maxWaitMs ?? BROWSER_ADMISSION_MAX_WAIT_MS;
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > BROWSER_ADMISSION_MAX_WAIT_MS) {
    throw new RangeError(`Browser admission wait must be between 0 and ${BROWSER_ADMISSION_MAX_WAIT_MS} ms`);
  }
  const intervalMs = browserAdmissionInterval(kind, executionCapacity);
  const initialNextMs = nowMs + intervalMs;
  const latestStartMs = nowMs + maxWaitMs;
  if (!Number.isSafeInteger(initialNextMs) || !Number.isSafeInteger(latestStartMs)) {
    throw new TypeError("Browser admission clock exceeds the safe integer range");
  }

  const row = await db
    .prepare(
      `INSERT INTO settings(key, value, updated_at)
       VALUES (?, CAST(CAST(? AS INTEGER) AS TEXT), ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CAST(CAST(MAX(CAST(settings.value AS INTEGER), ?) + ? AS INTEGER) AS TEXT),
         updated_at = excluded.updated_at
       WHERE settings.value <> ''
         AND settings.value NOT GLOB '*[^0-9]*'
         AND CAST(settings.value AS INTEGER) BETWEEN 0 AND ?
         AND MAX(CAST(settings.value AS INTEGER), ?) <= ?
       RETURNING CAST(value AS INTEGER) - ? AS scheduled_at_ms`,
    )
    .bind(
      ADMISSION_KEYS[kind],
      initialNextMs,
      new Date(nowMs).toISOString(),
      nowMs,
      intervalMs,
      MAX_SAFE_EPOCH_MS,
      nowMs,
      latestStartMs,
      intervalMs,
    )
    .first<{ scheduled_at_ms: number }>();

  const scheduledAtMs = Number(row?.scheduled_at_ms);
  const waitMs = scheduledAtMs - nowMs;
  if (
    !Number.isSafeInteger(scheduledAtMs) ||
    scheduledAtMs < nowMs ||
    scheduledAtMs > latestStartMs ||
    !Number.isSafeInteger(waitMs)
  ) {
    throw new BrowserAdmissionDeferredError(kind, Math.max(intervalMs, maxWaitMs));
  }
  return Object.freeze({ kind, scheduledAtMs, waitMs, intervalMs });
}

export async function waitForBrowserAdmission(
  db: D1Database,
  kind: BrowserAdmissionKind,
  executionCapacity: ExecutionCapacity,
): Promise<BrowserAdmissionClaim> {
  const claim = await claimBrowserAdmission(db, kind, executionCapacity);
  if (claim.waitMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, claim.waitMs));
  }
  return claim;
}
