/**
 * A Worker request may enter at most 32 Worker invocations through Service
 * Bindings. Reserve the root invocation and one spare instead of depending on
 * Workflow replay or retry boundaries to reset that chain.
 */
export const SOURCE_BOUNDARY_CALL_LIMIT = 30;

// Workflows retries.limit counts retries after the initial callback attempt.
export const REQUIRED_SOURCE_MAX_ATTEMPTS = 4;
export const OPTIONAL_SOURCE_MAX_ATTEMPTS = 2;

export interface SourceAttemptRequest {
  optional?: boolean;
}

/**
 * Allocate the shared call envelope breadth-first. Every in-cap source gets
 * one attempt before any source receives a retry credit.
 */
export function allocateSourceBoundaryAttempts(
  requests: readonly SourceAttemptRequest[],
  callLimit = SOURCE_BOUNDARY_CALL_LIMIT,
): number[] {
  const normalizedLimit = Number.isFinite(callLimit) ? Math.floor(callLimit) : SOURCE_BOUNDARY_CALL_LIMIT;
  const boundedLimit = Math.max(0, Math.min(SOURCE_BOUNDARY_CALL_LIMIT, normalizedLimit));
  const assigned = requests.map(() => 0);
  let remaining = boundedLimit;
  if (remaining === 0) return assigned;
  const requiredFirst = [
    ...requests.flatMap((request, index) => request.optional ? [] : [index]),
    ...requests.flatMap((request, index) => request.optional ? [index] : []),
  ];
  for (const index of requiredFirst) {
    assigned[index] = 1;
    remaining -= 1;
    if (remaining === 0) return assigned;
  }
  for (let round = 2; remaining > 0 && round <= REQUIRED_SOURCE_MAX_ATTEMPTS; round += 1) {
    let allocatedThisRound = 0;
    for (const [index, request] of requests.entries()) {
      const desired = request.optional ? OPTIONAL_SOURCE_MAX_ATTEMPTS : REQUIRED_SOURCE_MAX_ATTEMPTS;
      if (round > desired) continue;
      assigned[index] = round;
      remaining -= 1;
      allocatedThisRound += 1;
      if (remaining === 0) break;
    }
    if (allocatedThisRound === 0) break;
  }
  return assigned;
}

export function sourceBoundaryAttemptCount(requests: readonly SourceAttemptRequest[]): number {
  return allocateSourceBoundaryAttempts(requests).reduce((total, attempts) => total + attempts, 0);
}
