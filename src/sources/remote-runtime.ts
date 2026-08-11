import { assertPublicHttpUrl } from "../security";
import { fetchWithTimeout } from "../utils";

export const REMOTE_SOURCE_FETCH_CONCURRENCY = 4;
export const MAX_PUBLIC_SOURCE_REDIRECTS = 3;
export const MAX_PUBLIC_SOURCE_REQUESTS = MAX_PUBLIC_SOURCE_REDIRECTS + 1;

function isHttpRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export async function discardRemoteSourceResponse(response: Response, reason: string): Promise<void> {
  await response.body?.cancel(reason).catch(() => undefined);
}

/** Follows only a bounded, public URL chain and returns the validated final URL. */
export async function fetchPublicSourceResponse(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 12_000,
): Promise<{ response: Response; finalUrl: URL; requests: number }> {
  let url = assertPublicHttpUrl(input.toString());
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchWithTimeout(url, { ...init, redirect: "manual" }, timeoutMs);
    const location = response.headers.get("location");
    if (!isHttpRedirect(response.status) || !location) {
      return { response, finalUrl: assertPublicHttpUrl(response.url || url.toString()), requests: redirects + 1 };
    }
    await discardRemoteSourceResponse(response, "following validated source redirect");
    if (redirects >= MAX_PUBLIC_SOURCE_REDIRECTS) throw new Error("Public source fetch exceeded the redirect limit");
    url = assertPublicHttpUrl(new URL(location, url).toString());
  }
}

/** Keeps aggregate live response bodies bounded while preserving input-order results. */
export async function settleRemoteSourceRequests<T, R>(
  values: readonly T[],
  mapper: (value: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = [];
  for (let offset = 0; offset < values.length; offset += REMOTE_SOURCE_FETCH_CONCURRENCY) {
    const batch = values.slice(offset, offset + REMOTE_SOURCE_FETCH_CONCURRENCY);
    results.push(...await Promise.allSettled(batch.map((value, index) => mapper(value, offset + index))));
  }
  return results;
}
