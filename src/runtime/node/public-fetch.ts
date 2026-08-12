import { lookup } from "node:dns/promises";
import { request as requestHttp, type IncomingMessage, type RequestOptions } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
} from "node:zlib";

import { assertPublicHttpUrl } from "../../security";
import type { OutboundFetch } from "../../utils";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_HEADER_BYTES = 32 * 1024;
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

interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type PublicHostLookup = (
  hostname: string,
) => Promise<ReadonlyArray<Readonly<{ address: string; family: number }>>>;

function ipv4Value(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    value = value * 256 + byte;
  }
  return value >>> 0;
}

function inIpv4Range(value: number, base: number, bits: number): boolean {
  const divisor = 2 ** (32 - bits);
  return Math.floor(value / divisor) === Math.floor(base / divisor);
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Value(address);
  if (value === null) return false;
  const blocked: ReadonlyArray<readonly [number, number]> = [
    [0x00000000, 8], // Current network / unspecified.
    [0x0a000000, 8], // RFC 1918.
    [0x64400000, 10], // Carrier-grade NAT.
    [0x7f000000, 8], // Loopback.
    [0xa9fe0000, 16], // Link-local.
    [0xac100000, 12], // RFC 1918.
    [0xc0000000, 24], // IETF protocol assignments.
    [0xc0000200, 24], // Documentation.
    [0xc0586300, 24], // Deprecated 6to4 relay anycast.
    [0xc0a80000, 16], // RFC 1918.
    [0xc6120000, 15], // Benchmarking.
    [0xc6336400, 24], // Documentation.
    [0xcb007100, 24], // Documentation.
    [0xe0000000, 4], // Multicast.
    [0xf0000000, 4], // Reserved / limited broadcast.
  ];
  return !blocked.some(([base, bits]) => inIpv4Range(value, base, bits));
}

function ipv6Value(address: string): bigint | null {
  if (address.includes("%")) return null;
  let source = address.toLowerCase();
  const dottedIndex = source.lastIndexOf(":");
  if (source.includes(".")) {
    if (dottedIndex < 0) return null;
    const v4 = ipv4Value(source.slice(dottedIndex + 1));
    if (v4 === null) return null;
    source = `${source.slice(0, dottedIndex)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  if ((source.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = source.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (source.includes("::") ? missing < 1 : missing !== 0) return null;
  const groups = [...left, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((value, part) => (value << 16n) | BigInt(Number.parseInt(part, 16)), 0n);
}

function ipv6Prefix(value: bigint, prefix: bigint, bits: number): boolean {
  return (value >> BigInt(128 - bits)) === prefix;
}

function embeddedIpv4Address(value: bigint): string {
  return [
    Number((value >> 24n) & 0xffn),
    Number((value >> 16n) & 0xffn),
    Number((value >> 8n) & 0xffn),
    Number(value & 0xffn),
  ].join(".");
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6Value(address);
  if (value === null) return false;
  // Reject deprecated IPv4-compatible space; mapped addresses follow the IPv4 policy.
  if ((value >> 32n) === 0n) return false;
  if ((value >> 32n) === 0xffffn) {
    return isPublicIpv4(embeddedIpv4Address(value));
  }
  // IPv4-translatable addresses and native space outside global unicast are not public literals.
  if ((value >> 32n) === 0xffff0000n || !ipv6Prefix(value, 0x1n, 3)) return false;
  // 6to4 embeds its destination IPv4 address in bits 16-47.
  if (ipv6Prefix(value, 0x2002n, 16)) {
    return isPublicIpv4(embeddedIpv4Address(value >> 80n));
  }
  const blocked: ReadonlyArray<readonly [bigint, number]> = [
    [0x100080n, 23], // IETF protocol assignments, including Teredo, benchmarking, and ORCHID.
    [0x20010db8n, 32], // Documentation.
    [0x3ffen, 16], // Deprecated 6bone allocation.
    [0x3fff0n, 20], // Documentation.
  ];
  return !blocked.some(([prefix, bits]) => ipv6Prefix(value, prefix, bits));
}

export function isPublicInternetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

async function resolvePinnedPublicAddress(url: URL, resolveHost: PublicHostLookup): Promise<PinnedAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const answers = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolveHost(hostname);
  if (answers.length === 0) throw new Error("Remote host did not resolve");
  if (answers.some((answer) => !isPublicInternetAddress(answer.address))) {
    throw new Error("Remote host resolves to a private or reserved network address");
  }
  const selected = answers[0]!;
  if (selected.family !== 4 && selected.family !== 6) throw new Error("Remote host returned an unsupported address family");
  return { address: selected.address, family: selected.family };
}

async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = (): Error => signal.reason === "timeout"
    ? new Error("Remote request timed out")
    : signal.reason instanceof Error
      ? signal.reason
      : new Error("Remote request was cancelled");
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function responseHeaders(message: IncomingMessage, decoded: boolean): Headers {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = (message.rawHeaders[index] ?? "").toLowerCase();
    const value = message.rawHeaders[index + 1] ?? "";
    if (!name || HOP_BY_HOP_HEADERS.has(name)) continue;
    if (decoded && (name === "content-encoding" || name === "content-length")) continue;
    headers.append(name, value);
  }
  return headers;
}

function decodedBody(message: IncomingMessage): { readonly body: Readable; readonly decoded: boolean } {
  const encoding = String(message.headers["content-encoding"] ?? "").trim().toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return { body: message.pipe(createGunzip()), decoded: true };
  if (encoding === "deflate") return { body: message.pipe(createInflate()), decoded: true };
  if (encoding === "br") return { body: message.pipe(createBrotliDecompress()), decoded: true };
  return { body: message, decoded: false };
}

function requestHeaders(input: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  input.forEach((value, originalName) => {
    const name = originalName.toLowerCase();
    if (name === "host" || HOP_BY_HOP_HEADERS.has(name)) return;
    headers[name] = value;
  });
  if (!headers["accept-encoding"]) headers["accept-encoding"] = "gzip, br, deflate";
  return headers;
}

function defineResponseMetadata(response: Response, url: URL, redirected: boolean): Response {
  Object.defineProperties(response, {
    url: { configurable: true, enumerable: true, value: url.toString() },
    redirected: { configurable: true, enumerable: true, value: redirected },
  });
  return response;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchPinned(
  request: Request,
  redirectsRemaining: number,
  wasRedirected: boolean,
  resolveHost: PublicHostLookup,
): Promise<Response> {
  const original = new URL(request.url);
  if (original.username || original.password) throw new Error("Remote URL credentials are not allowed");
  const url = assertPublicHttpUrl(original.toString());
  const address = await withAbort(resolvePinnedPublicAddress(url, resolveHost), request.signal);
  const headers = requestHeaders(request.headers);
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new Error("The self-host public fetch transport supports only GET and HEAD requests");
  }

  return await new Promise<Response>((resolve, reject) => {
    const options: RequestOptions = {
      method,
      headers,
      signal: request.signal,
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      lookup: (_hostname, lookupOptions, callback): void => {
        if (typeof lookupOptions === "object" && lookupOptions?.all === true) {
          (callback as unknown as (error: null, addresses: PinnedAddress[]) => void)(null, [address]);
          return;
        }
        callback(null, address.address, address.family);
      },
    };
    const transport = url.protocol === "https:" ? requestHttps : requestHttp;
    const outgoing = transport(url, options, (incoming) => {
      const status = incoming.statusCode ?? 502;
      const location = incoming.headers.location;
      if (isRedirect(status) && location && request.redirect !== "manual") {
        incoming.destroy();
        if (request.redirect === "error") {
          reject(new Error("Remote redirect was not allowed"));
          return;
        }
        if (redirectsRemaining <= 0) {
          reject(new Error("Remote response exceeded the redirect limit"));
          return;
        }
        let redirectedUrl: URL;
        try {
          redirectedUrl = assertPublicHttpUrl(new URL(location, url).toString());
        } catch (error) {
          reject(error);
          return;
        }
        const redirectedHeaders = new Headers(request.headers);
        if (redirectedUrl.origin !== url.origin) {
          redirectedHeaders.delete("authorization");
          redirectedHeaders.delete("cookie");
        }
        const redirectedRequest = new Request(redirectedUrl, {
          method: status === 303 ? "GET" : method,
          headers: redirectedHeaders,
          redirect: request.redirect,
          signal: request.signal,
        });
        void fetchPinned(redirectedRequest, redirectsRemaining - 1, true, resolveHost).then(resolve, reject);
        return;
      }

      const decoded = decodedBody(incoming);
      const body = method === "HEAD" ? null : Readable.toWeb(decoded.body) as ReadableStream<Uint8Array>;
      if (method === "HEAD") incoming.resume();
      const response = new Response(body, {
        status,
        statusText: incoming.statusMessage ?? "",
        headers: responseHeaders(incoming, decoded.decoded),
      });
      resolve(defineResponseMetadata(response, url, wasRedirected));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

export function createNodePublicFetch(
  resolveHost: PublicHostLookup = (hostname) => lookup(hostname, { all: true, verbatim: true }),
): OutboundFetch {
  return async (input, init = {}) => {
    const request = new Request(input, init);
    return fetchPinned(request, MAX_REDIRECTS, false, resolveHost);
  };
}

export const nodePublicFetch = createNodePublicFetch();
