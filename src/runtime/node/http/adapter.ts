import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { normalizeHostAuthority } from "./config";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const STRUCTURAL_ROUTE_ROOTS = new Set([
  "api",
  "mcp",
  "collector",
  "packet",
  "corpus",
  "feedback",
  "share",
  ".well-known",
]);
const EXACT_LOG_ROUTES = new Set(["health", "ready", "metrics"]);
const SAFE_TRANSPORT_LOG_CODES = new Set([
  "body_not_allowed",
  "headers_too_large",
  "host_not_allowed",
  "internal_error",
  "invalid_content_length",
  "invalid_host",
  "invalid_request",
  "invalid_request_target",
  "malformed_http",
  "request_body_too_large",
  "server_draining",
  "server_starting",
  "too_many_headers",
]);

export class NodeHttpTransportError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(status: number, code: string, publicMessage: string) {
    super(publicMessage);
    this.name = "NodeHttpTransportError";
    this.status = status;
    this.code = code.slice(0, 48);
    this.publicMessage = publicMessage.slice(0, 160);
  }
}

export interface NodeRequestAdapterOptions {
  readonly origin: string;
  readonly allowedHosts: ReadonlySet<string>;
  readonly maxHeadersCount: number;
  readonly maxRequestBodyBytes: number;
}

export interface AdaptedNodeRequest {
  readonly request: Request;
  /** Rejects only when a streamed body exceeds its configured limit. */
  readonly bodyFailure: Promise<never>;
  hasUnreadBody(): boolean;
  abort(reason?: unknown): void;
  dispose(): void;
}

function rawHeaderValues(request: IncomingMessage, targetName: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === targetName) values.push(request.rawHeaders[index + 1] ?? "");
  }
  return values;
}

function commaTokens(values: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of value.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized) tokens.add(normalized);
    }
  }
  return tokens;
}

function isProxyHeader(name: string): boolean {
  return name === "forwarded" || name === "x-real-ip" || name.startsWith("x-forwarded-");
}

function validateOriginFormTarget(rawTarget: string): void {
  if (
    !rawTarget.startsWith("/") ||
    rawTarget.startsWith("//") ||
    rawTarget.length > 16 * 1024 ||
    /[\0\r\n\\#]/.test(rawTarget)
  ) {
    throw new NodeHttpTransportError(400, "invalid_request_target", "Invalid request target");
  }
  const pathname = rawTarget.split("?", 1)[0] ?? "/";
  for (const rawSegment of pathname.split("/")) {
    if (/%(?:00|2f|5c)/i.test(rawSegment)) {
      throw new NodeHttpTransportError(400, "invalid_request_target", "Invalid request target");
    }
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      throw new NodeHttpTransportError(400, "invalid_request_target", "Invalid request target");
    }
    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0") ||
      /%[0-9a-f]{2}/i.test(segment)
    ) {
      throw new NodeHttpTransportError(400, "invalid_request_target", "Invalid request target");
    }
  }
}

function validatedHost(request: IncomingMessage, allowedHosts: ReadonlySet<string>): string {
  const hosts = rawHeaderValues(request, "host");
  if (hosts.length !== 1) {
    throw new NodeHttpTransportError(400, "invalid_host", "Exactly one Host header is required");
  }
  let host: string;
  try {
    host = normalizeHostAuthority(hosts[0]!);
  } catch {
    throw new NodeHttpTransportError(400, "invalid_host", "Invalid Host header");
  }
  if (!allowedHosts.has(host)) {
    throw new NodeHttpTransportError(421, "host_not_allowed", "Host is not allowed");
  }
  return host;
}

function requestHeaders(request: IncomingMessage, allowedHosts: ReadonlySet<string>, maximum: number): Headers {
  if (request.rawHeaders.length / 2 > maximum) {
    throw new NodeHttpTransportError(431, "too_many_headers", "Too many request headers");
  }
  validatedHost(request, allowedHosts);
  const connectionTokens = commaTokens(rawHeaderValues(request, "connection"));
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const originalName = request.rawHeaders[index] ?? "";
    const name = originalName.toLowerCase();
    const value = request.rawHeaders[index + 1] ?? "";
    if (HOP_BY_HOP_HEADERS.has(name) || connectionTokens.has(name) || isProxyHeader(name)) continue;
    headers.append(name, value);
  }
  return headers;
}

function declaredContentLength(request: IncomingMessage): number | null {
  const values = rawHeaderValues(request, "content-length");
  if (values.length === 0) return null;
  if (values.length !== 1 || !/^(?:0|[1-9][0-9]*)$/.test(values[0]!)) {
    throw new NodeHttpTransportError(400, "invalid_content_length", "Invalid Content-Length header");
  }
  const length = Number(values[0]);
  if (!Number.isSafeInteger(length)) {
    throw new NodeHttpTransportError(413, "request_body_too_large", "Request body is too large");
  }
  return length;
}

function neverRejects(): Promise<never> {
  return new Promise<never>(() => undefined);
}

export function nodeRequestToWeb(
  incoming: IncomingMessage,
  options: NodeRequestAdapterOptions,
): AdaptedNodeRequest {
  const rawTarget = incoming.url ?? "/";
  validateOriginFormTarget(rawTarget);
  const headers = requestHeaders(incoming, options.allowedHosts, options.maxHeadersCount);
  const method = (incoming.method ?? "GET").toUpperCase();
  const declaredLength = declaredContentLength(incoming);
  if (declaredLength !== null && declaredLength > options.maxRequestBodyBytes) {
    throw new NodeHttpTransportError(413, "request_body_too_large", "Request body is too large");
  }
  const hasBody = (declaredLength ?? 0) > 0 || rawHeaderValues(incoming, "transfer-encoding").length > 0;
  if (["GET", "HEAD"].includes(method) && hasBody) {
    throw new NodeHttpTransportError(400, "body_not_allowed", "Request method does not accept a body");
  }

  const abortController = new AbortController();
  const onAborted = (): void => {
    if (!abortController.signal.aborted) {
      abortController.abort(new DOMException("Client disconnected", "AbortError"));
    }
  };
  const onError = (): void => onAborted();
  incoming.once("aborted", onAborted);
  incoming.once("error", onError);

  let body: ReadableStream<Uint8Array> | undefined;
  let bodyFailure = neverRejects();
  let limiter: Transform | undefined;
  if (!["GET", "HEAD"].includes(method) && hasBody) {
    let received = 0;
    let rejectBody: (error: NodeHttpTransportError) => void = () => undefined;
    bodyFailure = new Promise<never>((_resolve, reject) => {
      rejectBody = reject;
    });
    limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        received += chunk.byteLength;
        if (received > options.maxRequestBodyBytes) {
          const error = new NodeHttpTransportError(413, "request_body_too_large", "Request body is too large");
          rejectBody(error);
          callback(error);
          return;
        }
        callback(null, chunk);
      },
    });
    limiter.once("error", onAborted);
    incoming.pipe(limiter);
    body = Readable.toWeb(limiter) as unknown as ReadableStream<Uint8Array>;
  }

  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    signal: abortController.signal,
    ...(body ? { body, duplex: "half" as const } : {}),
  };
  let request: Request;
  try {
    request = new Request(new URL(rawTarget, options.origin), init);
  } catch {
    throw new NodeHttpTransportError(400, "invalid_request", "Invalid HTTP request");
  }

  return {
    request,
    bodyFailure,
    hasUnreadBody(): boolean {
      return Boolean(limiter && !limiter.readableEnded);
    },
    abort(reason?: unknown): void {
      if (!abortController.signal.aborted) abortController.abort(reason);
    },
    dispose(): void {
      incoming.off("aborted", onAborted);
      incoming.off("error", onError);
      limiter?.off("error", onAborted);
      if (limiter && !limiter.readableEnded) {
        incoming.unpipe(limiter);
        limiter.destroy();
        if (!incoming.complete) incoming.socket.destroySoon();
      }
      void bodyFailure.catch(() => undefined);
    },
  };
}

function responseConnectionTokens(headers: Headers): Set<string> {
  return commaTokens(headers.get("connection") ? [headers.get("connection")!] : []);
}

async function endResponse(response: ServerResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    response.once("error", reject);
    response.end(() => {
      response.off("error", reject);
      resolve();
    });
  });
}

export async function writeWebResponse(
  outgoing: ServerResponse,
  webResponse: Response,
  options: { readonly requestMethod?: string; readonly signal?: AbortSignal } = {},
): Promise<void> {
  outgoing.statusCode = webResponse.status;
  const connectionTokens = responseConnectionTokens(webResponse.headers);
  webResponse.headers.forEach((value, originalName) => {
    const name = originalName.toLowerCase();
    if (name === "set-cookie" || HOP_BY_HOP_HEADERS.has(name) || connectionTokens.has(name)) return;
    outgoing.setHeader(name, value);
  });
  const setCookies = webResponse.headers.getSetCookie();
  if (setCookies.length > 0) outgoing.setHeader("set-cookie", setCookies);

  if (!webResponse.body || options.requestMethod?.toUpperCase() === "HEAD") {
    if (webResponse.body) await webResponse.body.cancel().catch(() => undefined);
    await endResponse(outgoing);
    return;
  }

  if (outgoing.hasHeader("content-length")) outgoing.strictContentLength = true;
  const source = Readable.fromWeb(webResponse.body as unknown as NodeReadableStream<Uint8Array>);
  await pipeline(source, outgoing, options.signal ? { signal: options.signal } : {});
}

export function transportErrorResponse(error: unknown): Response {
  const known = error instanceof NodeHttpTransportError ? error : null;
  const status = known?.status ?? 500;
  const code = known?.code ?? "internal_error";
  const message = known?.publicMessage ?? "Internal server error";
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Return a bounded route class, never a request-derived path. Even short API
 * identifiers and capability segments therefore cannot enter transport logs.
 */
export function httpRouteTemplate(rawTarget: string | undefined): string {
  const pathname = (rawTarget ?? "/").split(/[?#]/, 1)[0] || "/";
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\")) {
    return "/[invalid]";
  }
  const rawSegments = pathname.split("/").filter(Boolean);
  if (rawSegments.length === 0) return "/";

  let first: string;
  try {
    first = decodeURIComponent(rawSegments[0]!).toLowerCase();
  } catch {
    return "/[invalid]";
  }
  if (!/^[a-z0-9.-]{1,32}$/.test(first)) return "/[path]";
  if (EXACT_LOG_ROUTES.has(first) && rawSegments.length === 1) return "/" + first;
  if (STRUCTURAL_ROUTE_ROOTS.has(first)) {
    return "/" + first + (rawSegments.length === 1 ? "" : "/[route]");
  }
  return "/[path]";
}

export function safeTransportErrorCode(error: unknown): string {
  if (!(error instanceof NodeHttpTransportError)) return "internal_error";
  return SAFE_TRANSPORT_LOG_CODES.has(error.code) ? error.code : "transport_error";
}
