import { HttpError } from "./utils";

const encoder = new TextEncoder();
const FORBIDDEN_SECRET_VALUES = new Set([
  "replace-with-a-long-random-secret",
  "replace-me",
]);
const MCP_PATH_PATTERN = /^\/mcp\/([^/]+)(?:\/(ops))?\/?$/;
const OWNER_SESSION_COOKIE = "__Host-driftglass_owner";
const OWNER_SESSION_VERSION = "v1";
const OWNER_SESSION_TTL_SECONDS = 15 * 60;

export type McpCapabilityProfile = "reasoning" | "operations";

export interface McpCapabilityKeys {
  readKey: string;
  operationsKey: string;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function secureEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export function assertSecret(secret: string): void {
  const normalized = String(secret ?? "").trim().toLowerCase();
  if (normalized.length < 24 || FORBIDDEN_SECRET_VALUES.has(normalized)) {
    throw new HttpError(503, "DRIFTGLASS_SECRET is missing, too short, or still set to an example placeholder");
  }
}

export async function requireAdmin(request: Request, secret: string): Promise<void> {
  assertSecret(secret);
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!candidate || !(await secureEqual(candidate, secret))) {
    throw new HttpError(401, "Unauthorized");
  }
}

function cookieValue(request: Request, name: string): string {
  const prefix = `${name}=`;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const candidate = part.trim();
    if (candidate.startsWith(prefix)) return candidate.slice(prefix.length);
  }
  return "";
}

/**
 * A short, signed browser session lets the owner approve a model connection
 * soon after unlocking Driftglass without putting the owner key in an OAuth
 * redirect, token, client record, or ChatGPT request.
 */
export async function ownerSessionCookie(
  secret: string,
  now = Date.now(),
): Promise<string> {
  assertSecret(secret);
  const issuedAt = Math.floor(now / 1_000);
  const signature = await hmacHex(secret, `driftglass:owner-session:${OWNER_SESSION_VERSION}:${issuedAt}`);
  const value = `${OWNER_SESSION_VERSION}.${issuedAt}.${signature}`;
  return `${OWNER_SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${OWNER_SESSION_TTL_SECONDS}`;
}

export function clearOwnerSessionCookie(): string {
  return `${OWNER_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function hasRecentOwnerSession(
  request: Request,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  assertSecret(secret);
  const value = cookieValue(request, OWNER_SESSION_COOKIE);
  const [version, rawIssuedAt, signature, extra] = value.split(".");
  if (version !== OWNER_SESSION_VERSION || extra !== undefined || !/^\d{10}$/.test(rawIssuedAt ?? "") || !signature) {
    return false;
  }
  const issuedAt = Number(rawIssuedAt);
  const current = Math.floor(now / 1_000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > current + 30 || current - issuedAt > OWNER_SESSION_TTL_SECONDS) {
    return false;
  }
  const expected = await hmacHex(secret, `driftglass:owner-session:${OWNER_SESSION_VERSION}:${issuedAt}`);
  return secureEqual(signature, expected);
}

export async function deriveReadKey(secret: string): Promise<string> {
  assertSecret(secret);
  return (await hmacHex(secret, "driftglass:read:v1")).slice(0, 40);
}

export async function deriveOperationsKey(secret: string): Promise<string> {
  assertSecret(secret);
  return (await hmacHex(secret, "driftglass:operations:v1")).slice(0, 40);
}

export async function deriveMcpCapabilityKeys(secret: string): Promise<McpCapabilityKeys> {
  const [readKey, operationsKey] = await Promise.all([
    deriveReadKey(secret),
    deriveOperationsKey(secret),
  ]);
  return { readKey, operationsKey };
}

export async function requireReadKey(candidate: string, secret: string): Promise<void> {
  const expected = await deriveReadKey(secret);
  if (!candidate || !(await secureEqual(candidate, expected))) {
    throw new HttpError(404, "Not found");
  }
}

export async function requireOperationsKey(candidate: string, secret: string): Promise<void> {
  const expected = await deriveOperationsKey(secret);
  if (!candidate || !(await secureEqual(candidate, expected))) {
    throw new HttpError(404, "Not found");
  }
}

export async function authorizeMcpPath(
  pathname: string,
  secret: string,
): Promise<McpCapabilityProfile | null> {
  const match = pathname.match(MCP_PATH_PATTERN);
  if (!match) return null;
  const profile: McpCapabilityProfile = match[2] === "ops" ? "operations" : "reasoning";
  if (profile === "operations") {
    await requireOperationsKey(match[1] ?? "", secret);
  } else {
    await requireReadKey(match[1] ?? "", secret);
  }
  return profile;
}

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Invalid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new HttpError(400, "Only http and https URLs are allowed");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  const isIpv6Literal = host.includes(":");
  const ipv4 = isIpv6Literal ? null : ipv4Value(host);
  const isNonPublicLiteral = isIpv6Literal ? !isPublicIpv6(host) : ipv4 !== null && !isPublicIpv4(host);
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "home.arpa" ||
    host.endsWith(".home.arpa") ||
    host === "metadata.google.internal" ||
    isNonPublicLiteral
  ) {
    throw new HttpError(400, "Private or local network URLs are not allowed");
  }
  url.username = "";
  url.password = "";
  return url;
}

export function baseUrlFor(request: Request, configured: string): string {
  if (configured) {
    const url = assertPublicHttpUrl(configured);
    return url.origin;
  }
  return new URL(request.url).origin;
}
