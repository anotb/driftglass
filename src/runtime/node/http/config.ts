import { isIP } from "node:net";
import { assertPortableNodeRuntime, PORTABLE_NODE_MINIMUM_VERSION } from "../layout";

export { PORTABLE_NODE_MINIMUM_VERSION };

export const NODE_HTTP_DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 8787,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  drainTimeoutMs: 10_000,
  maxHeaderSizeBytes: 16 * 1024,
  maxHeadersCount: 100,
  maxRequestBodyBytes: 8 * 1024 * 1024,
});

export interface NodeHttpConfig {
  readonly host?: string;
  readonly port?: number;
  /** Canonical Request origin. It is never inferred from proxy headers. */
  readonly origin?: string;
  /** Additional exact Host authorities, such as localhost:8787. */
  readonly allowedHosts?: readonly string[];
  /** Required for any bind host other than a numeric loopback address. */
  readonly unsafeAllowNonLoopback?: boolean;
  /** Proxy-derived scheme and authority are unsupported in this phase. */
  readonly trustProxyHeaders?: boolean;
  readonly headersTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly keepAliveTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly maxHeaderSizeBytes?: number;
  readonly maxHeadersCount?: number;
  readonly maxRequestBodyBytes?: number;
}

export interface NormalizedNodeHttpConfig {
  readonly host: string;
  readonly port: number;
  readonly origin: string | null;
  readonly allowedHosts: readonly string[];
  readonly unsafeAllowNonLoopback: boolean;
  readonly trustProxyHeaders: false;
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly maxHeaderSizeBytes: number;
  readonly maxHeadersCount: number;
  readonly maxRequestBodyBytes: number;
}

function boundedInteger(name: string, value: unknown, fallback: number, minimum: number, maximum: number): number {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) {
    throw new RangeError(name + " must be an integer between " + minimum + " and " + maximum);
  }
  return candidate as number;
}

export function isNumericLoopbackHost(host: string): boolean {
  if (isIP(host) === 4) return host.split(".")[0] === "127";
  if (isIP(host) !== 6) return false;
  return host.toLowerCase() === "::1" || host.toLowerCase() === "0:0:0:0:0:0:0:1";
}

function normalizeBindHost(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) {
    throw new TypeError("Node HTTP bind host must be a nonempty value without surrounding whitespace");
  }
  if (/[\0\r\n/\\@\[\]]/.test(input)) {
    throw new TypeError("Node HTTP bind host is malformed; IPv6 listen addresses must not use brackets");
  }
  if (isIP(input)) return input.toLowerCase();
  if (input.length > 253 || !/^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(input)) {
    throw new TypeError("Node HTTP bind host must be a numeric IP address or valid DNS hostname");
  }
  return input.toLowerCase().replace(/\.$/, "");
}

export function normalizeHostAuthority(input: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 512 ||
    input !== input.trim() ||
    /[\0\r\n\t /\\?#@,]/.test(input)
  ) {
    throw new TypeError("Host authority is malformed");
  }
  let parsed: URL;
  try {
    parsed = new URL("http://" + input + "/");
  } catch {
    throw new TypeError("Host authority is malformed");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("Host authority is malformed");
  }
  return parsed.host.toLowerCase();
}

function normalizeOrigin(input: unknown): string {
  if (typeof input !== "string" || input !== input.trim() || input.includes("\\")) {
    throw new TypeError("Node HTTP origin must be an absolute HTTP(S) URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new TypeError("Node HTTP origin must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("Node HTTP origin must contain only an HTTP(S) scheme and authority");
  }
  return parsed.origin;
}

export function normalizeNodeHttpConfig(input: NodeHttpConfig = {}): NormalizedNodeHttpConfig {
  assertPortableNodeRuntime();
  const host = normalizeBindHost(input.host ?? NODE_HTTP_DEFAULTS.host);
  const unsafeAllowNonLoopback = input.unsafeAllowNonLoopback === true;
  if (!isNumericLoopbackHost(host) && !unsafeAllowNonLoopback) {
    throw new TypeError(
      "Non-loopback Node HTTP binds require unsafeAllowNonLoopback: true and an explicit Host allowlist",
    );
  }
  if (input.trustProxyHeaders === true) {
    throw new TypeError("Proxy headers are disabled; configure a canonical origin and exact allowedHosts instead");
  }

  const port = boundedInteger("port", input.port, NODE_HTTP_DEFAULTS.port, 0, 65_535);
  const headersTimeoutMs = boundedInteger(
    "headersTimeoutMs", input.headersTimeoutMs, NODE_HTTP_DEFAULTS.headersTimeoutMs, 1_000, 10 * 60_000,
  );
  const requestTimeoutMs = boundedInteger(
    "requestTimeoutMs", input.requestTimeoutMs, NODE_HTTP_DEFAULTS.requestTimeoutMs, 1_000, 10 * 60_000,
  );
  if (headersTimeoutMs > requestTimeoutMs) {
    throw new RangeError("headersTimeoutMs must not exceed requestTimeoutMs");
  }

  const allowedHosts = Object.freeze((input.allowedHosts ?? []).map((entry) => normalizeHostAuthority(entry)));
  if (!isNumericLoopbackHost(host) && allowedHosts.length === 0 && input.origin === undefined) {
    throw new TypeError("Non-loopback Node HTTP binds require an explicit origin or allowedHosts entry");
  }

  return Object.freeze({
    host,
    port,
    origin: input.origin === undefined ? null : normalizeOrigin(input.origin),
    allowedHosts,
    unsafeAllowNonLoopback,
    trustProxyHeaders: false,
    headersTimeoutMs,
    requestTimeoutMs,
    keepAliveTimeoutMs: boundedInteger(
      "keepAliveTimeoutMs", input.keepAliveTimeoutMs, NODE_HTTP_DEFAULTS.keepAliveTimeoutMs, 0, 5 * 60_000,
    ),
    drainTimeoutMs: boundedInteger(
      "drainTimeoutMs", input.drainTimeoutMs, NODE_HTTP_DEFAULTS.drainTimeoutMs, 1, 5 * 60_000,
    ),
    maxHeaderSizeBytes: boundedInteger(
      "maxHeaderSizeBytes", input.maxHeaderSizeBytes, NODE_HTTP_DEFAULTS.maxHeaderSizeBytes, 1_024, 1024 * 1024,
    ),
    maxHeadersCount: boundedInteger(
      "maxHeadersCount", input.maxHeadersCount, NODE_HTTP_DEFAULTS.maxHeadersCount, 8, 1_000,
    ),
    maxRequestBodyBytes: boundedInteger(
      "maxRequestBodyBytes", input.maxRequestBodyBytes, NODE_HTTP_DEFAULTS.maxRequestBodyBytes, 1, 1024 * 1024 * 1024,
    ),
  });
}

export function formatHostAuthority(host: string, port: number): string {
  const bracketed = isIP(host) === 6 ? "[" + host + "]" : host;
  return normalizeHostAuthority(bracketed + ":" + port);
}

export function allowedHostAuthorities(config: NormalizedNodeHttpConfig, actualPort: number): ReadonlySet<string> {
  const values = new Set(config.allowedHosts);
  values.add(formatHostAuthority(config.host, actualPort));
  if (config.origin) values.add(new URL(config.origin).host.toLowerCase());
  return values;
}
