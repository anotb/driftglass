import { readBoundedResponseText } from "../utils";

export const PACKAGE_FETCH_CONCURRENCY = 4;
export const PACKAGE_DESCRIPTION_MAX_BYTES = 4_000;
export const PACKAGE_METADATA_MAX_BYTES = 3_000_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface BoundedPackageDescription {
  text: string;
  originalBytes: number;
  textBytes: number;
  truncated: boolean;
}

/** Bounds untrusted registry prose once, on a valid UTF-8 boundary. */
export function boundedPackageDescription(value: unknown): BoundedPackageDescription {
  const text = value === undefined || value === null ? "" : String(value);
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= PACKAGE_DESCRIPTION_MAX_BYTES) {
    return { text, originalBytes: encoded.byteLength, textBytes: encoded.byteLength, truncated: false };
  }
  let end = PACKAGE_DESCRIPTION_MAX_BYTES;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  const bounded = decoder.decode(encoded.subarray(0, end));
  return { text: bounded, originalBytes: encoded.byteLength, textBytes: end, truncated: true };
}

/**
 * Settles registry requests in input-order batches. Failures stay associated
 * with their package while at most four response bodies are live at once.
 */
export async function settlePackageRequests<T, R>(
  values: readonly T[],
  mapper: (value: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = [];
  for (let offset = 0; offset < values.length; offset += PACKAGE_FETCH_CONCURRENCY) {
    const batch = values.slice(offset, offset + PACKAGE_FETCH_CONCURRENCY);
    results.push(...await Promise.allSettled(batch.map((value, index) => mapper(value, offset + index))));
  }
  return results;
}

export function readPackageMetadataResponse(response: Response, packageName: string): Promise<string> {
  return readBoundedResponseText(
    response,
    PACKAGE_METADATA_MAX_BYTES,
    `${packageName}: package metadata exceeds 3 MB`,
  );
}
