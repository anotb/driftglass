export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

export function text(data: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(data, { ...init, headers });
}

export function markdown(data: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/markdown; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(data, { ...init, headers });
}

export async function readJson<T>(request: Request, maxBytes = 1_000_000): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new HttpError(415, "Expected application/json");
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, "Request body too large");
  }
  if (!request.body) throw new HttpError(400, "JSON body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body too large").catch(() => undefined);
        throw new HttpError(413, "Request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

/** Reads and cancels an upstream response once its real streamed byte count exceeds the bound. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  tooLargeMessage = "Response body too large",
  signal?: AbortSignal,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel("body too large").catch(() => undefined);
    throw new Error(tooLargeMessage);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const abortReader = (): void => {
    void reader.cancel("response body read aborted").catch(() => undefined);
  };
  if (signal?.aborted) abortReader();
  else signal?.addEventListener("abort", abortReader, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body too large").catch(() => undefined);
        throw new Error(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }

  if (signal?.aborted) throw new Error("Response body read aborted");

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/** Parses JSON only after the upstream stream has passed the same exact byte bound. */
export async function readBoundedResponseJson<T>(
  response: Response,
  maxBytes: number,
  tooLargeMessage = "JSON response body too large",
  signal?: AbortSignal,
): Promise<T> {
  return JSON.parse(await readBoundedResponseText(response, maxBytes, tooLargeMessage, signal)) as T;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function isMissingPathError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && String(error.code).toUpperCase() === "ENOENT") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b|no such (?:file|path)/i.test(message);
}

export function toErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const details = error.details && typeof error.details === "object"
      ? error.details as Record<string, unknown>
      : undefined;
    const code = typeof details?.code === "string" ? details.code : undefined;
    const retryAfterSeconds = Number(details?.retryAfterSeconds);
    const headers = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? { "retry-after": String(Math.ceil(retryAfterSeconds)) }
      : undefined;
    return json(
      { ok: false, ...(code ? { code } : {}), error: error.message, details: error.details },
      { status: error.status, headers },
    );
  }
  if (error instanceof Error && error.name === "BudgetDeferredError") {
    const deferred = error as Error & { dimension?: unknown; requested?: unknown; remaining?: unknown };
    const dimension = typeof deferred.dimension === "string" ? deferred.dimension : "unknown";
    const requested = Number.isFinite(Number(deferred.requested)) ? Number(deferred.requested) : null;
    const remaining = Number.isFinite(Number(deferred.remaining)) ? Math.max(0, Number(deferred.remaining)) : null;
    return json({
      ok: false,
      status: "deferred",
      code: "BUDGET_DEFERRED",
      error: `Budget Governor deferred ${dimension}`,
      budget: { dimension, requested, remaining },
    }, {
      status: 429,
      headers: { "retry-after": "60" },
    });
  }
  console.error(error);
  return json({ ok: false, error: "Internal error" }, { status: 500 });
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

export function excerpt(value: string, max = 420): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Convert source-authored HTML or Markdown into compact display text. */
export function plainTextExcerpt(value: string, max = 420): string {
  const decoded = String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#(\d+);/g, (_match, decimal: string) => {
      const code = Number.parseInt(decimal, 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (entity) => ({
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
      "&nbsp;": " ",
    })[entity.toLowerCase()] ?? " ");
  return excerpt(decoded
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[`*~]+/g, "")
    .replace(/(^|\s)[#>*_~`-]+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim(), max);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function canonicalizeUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    url.hash = "";
    const deleteKeys: string[] = [];
    url.searchParams.forEach((_value, key) => {
      if (
        key.toLowerCase().startsWith("utm_") ||
        ["ref", "ref_src", "source", "fbclid", "gclid", "mc_cid", "mc_eid"].includes(key.toLowerCase())
      ) {
        deleteKeys.push(key);
      }
    });
    for (const key of deleteKeys) url.searchParams.delete(key);
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return url.toString();
  } catch {
    return raw.trim();
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the authored body of a page before flattening it to text. This keeps
 * navigation, cookie prompts, and site furniture out of Stories without
 * pretending to understand the page semantically.
 */
export function readableHtmlText(
  html: string,
  options: { preferArticle?: boolean; firstArticleOnly?: boolean } = {},
): string {
  const withoutFurniture = html
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|aside|form|dialog|menu)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, " ")
    .replace(/<[^>]+(?:role=["'](?:navigation|banner|contentinfo|complementary)["']|(?:id|class)=["'][^"']*(?:cookie|breadcrumb|sidebar|site-nav|site-header|site-footer)[^"']*["'])[^>]*>[\s\S]*?<\/[^>]+>/gi, " ");
  const main = withoutFurniture.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? withoutFurniture.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]
    ?? withoutFurniture.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    ?? withoutFurniture;
  if (options.preferArticle) {
    const articles = [...main.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)]
      .map((match) => match[1] ?? "")
      .filter(Boolean);
    const selected = options.firstArticleOnly ? articles.slice(0, 1) : articles;
    const articleText = stripHtml(selected.join("\n\n"));
    if (articleText.length >= 120) return articleText;
  }
  const primary = stripHtml(main);
  return primary || stripHtml(withoutFurniture);
}

export function htmlTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1] ?? "") : undefined;
}

export function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").slice(0, 120);
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function numberFrom(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type OutboundFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const outboundFetchImplementations: Array<Readonly<{ token: symbol; implementation: OutboundFetch }>> = [];

/**
 * Install a runtime-specific outbound transport. The portable Node runtime uses
 * this seam to pin public DNS answers and validate every redirect; Workers keep
 * the platform fetch implementation.
 */
export function setOutboundFetchImplementation(implementation: OutboundFetch): () => void {
  const token = Symbol("outbound-fetch");
  outboundFetchImplementations.push({ token, implementation });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const index = outboundFetchImplementations.findIndex((entry) => entry.token === token);
    if (index >= 0) outboundFetchImplementations.splice(index, 1);
  };
}

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const abortFromCaller = (): void => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abortFromCaller();
  else init.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const cleanup = (): void => {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortFromCaller);
  };
  try {
    const outboundFetch = outboundFetchImplementations.at(-1)?.implementation ?? globalThis.fetch;
    const response = await outboundFetch(input, { ...init, signal: controller.signal });
    if (!response.body) {
      cleanup();
      return response;
    }

    const reader = response.body.getReader();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      controller.signal.removeEventListener("abort", abortBody);
      cleanup();
    };
    const abortBody = (): void => {
      if (finished) return;
      const reason = controller.signal.reason === "timeout"
        ? new Error("Remote response timed out")
        : controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("Remote response was aborted");
      streamController?.error(reason);
      void reader.cancel(reason).catch(() => undefined);
      finish();
    };
    const body = new ReadableStream<Uint8Array>({
      start(current): void {
        streamController = current;
        if (controller.signal.aborted) abortBody();
        else controller.signal.addEventListener("abort", abortBody, { once: true });
      },
      async pull(current): Promise<void> {
        if (finished) return;
        try {
          const chunk = await reader.read();
          if (finished) return;
          if (chunk.done) {
            current.close();
            finish();
            return;
          }
          if (chunk.value) current.enqueue(chunk.value);
        } catch (error) {
          if (!finished) current.error(error);
          finish();
        }
      },
      async cancel(reason): Promise<void> {
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    });
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperties(wrapped, {
      url: { configurable: true, enumerable: true, value: response.url },
      redirected: { configurable: true, enumerable: true, value: response.redirected },
      type: { configurable: true, enumerable: true, value: response.type },
    });
    return wrapped;
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function withSecurityHeaders(response: Response, options: { assets?: boolean; noIndex?: boolean } = {}): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("x-frame-options", "DENY");
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  if (options.noIndex) headers.set("x-robots-tag", "noindex, nofollow");
  const contentType = headers.get("content-type") ?? "";
  if (options.assets && contentType.includes("text/html")) {
    headers.set(
      "content-security-policy",
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    );
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
