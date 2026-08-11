import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type AuthRequest,
  type ClientInfo,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { MCP_READ_SCOPE } from "./mcp-connections";
import { handleOAuthMcp } from "./mcp";
import {
  assertSecret,
  baseUrlFor,
  hasRecentOwnerSession,
  hmacHex,
  ownerSessionCookie,
  randomToken,
  secureEqual,
} from "./security";
import { ensureSchema } from "./schema";
import type { Env } from "./types";
import { json } from "./utils";

const OWNER_ID = "owner";
const CONSENT_MAX_BYTES = 16_384;
const CONSENT_TTL_SECONDS = 10 * 60;
const CONSENT_TOKEN_VERSION = "v1";
const CONSENT_CLOCK_SKEW_SECONDS = 30;

interface McpAuthProps {
  userId: typeof OWNER_ID;
  access: "read";
  resource: string;
}

type OAuthEnv = Env & {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
};

type CoreFetch = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

function requestScopedOAuthEnv(env: OAuthEnv): OAuthEnv {
  const scoped = Object.create(env) as OAuthEnv;
  Object.defineProperty(scoped, "OAUTH_PROVIDER", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  return scoped;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function cleanClientName(client: ClientInfo): string {
  const clean = String(client.clientName ?? "Connected model")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return clean || "Connected model";
}

function displayOrigin(value: string): string {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback)
      ? url.origin
      : "Unverified origin";
  } catch {
    return "Unverified origin";
  }
}

function consentCallbackOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function consentTokenMessage(request: AuthRequest, issuedAt: number, nonce: string): string {
  return JSON.stringify([
    "driftglass:oauth-consent",
    CONSENT_TOKEN_VERSION,
    issuedAt,
    nonce,
    request.responseType,
    request.clientId,
    request.redirectUri,
    request.scope,
    request.state,
    request.codeChallenge ?? null,
    request.codeChallengeMethod ?? null,
    request.resource ?? null,
    request.issuer ?? null,
  ]);
}

async function createConsentToken(
  request: AuthRequest,
  secret: string,
  now = Date.now(),
): Promise<string> {
  const issuedAt = Math.floor(now / 1_000);
  const nonce = randomToken(16);
  const signature = await hmacHex(secret, consentTokenMessage(request, issuedAt, nonce));
  return `${CONSENT_TOKEN_VERSION}.${issuedAt}.${nonce}.${signature}`;
}

async function validConsentToken(
  token: string,
  request: AuthRequest,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (token.length > 160) return false;
  const [version, rawIssuedAt, nonce, signature, extra] = token.split(".");
  const parsedNonce = nonce ?? "";
  const parsedSignature = signature ?? "";
  if (
    version !== CONSENT_TOKEN_VERSION
    || extra !== undefined
    || !/^\d{10}$/.test(rawIssuedAt ?? "")
    || !/^[a-f0-9]{32}$/.test(parsedNonce)
    || !/^[a-f0-9]{64}$/.test(parsedSignature)
  ) return false;
  const issuedAt = Number(rawIssuedAt);
  const current = Math.floor(now / 1_000);
  if (
    !Number.isSafeInteger(issuedAt)
    || issuedAt > current + CONSENT_CLOCK_SKEW_SECONDS
    || current - issuedAt > CONSENT_TTL_SECONDS
  ) return false;
  const expected = await hmacHex(secret, consentTokenMessage(request, issuedAt, parsedNonce));
  return secureEqual(parsedSignature, expected);
}

function consentPostHasSafeBrowserContext(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  // The signed proof is primary. Browser metadata is defense in depth: reject
  // a stated conflict, but tolerate privacy contexts that omit or null Origin.
  if (origin !== null && origin !== "null" && origin !== requestOrigin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") return false;
  return true;
}

function consentHeaders(callbackOrigin?: string): Headers {
  const formAction = callbackOrigin ? `'self' ${callbackOrigin}` : "'self'";
  return new Headers({
    "cache-control": "no-store, max-age=0",
    "content-security-policy": `default-src 'none'; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'; img-src 'self'; style-src 'self'`,
    "content-type": "text/html; charset=utf-8",
    "cross-origin-opener-policy": "unsafe-none",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

function consentPage(input: {
  clientName: string;
  clientOrigin: string;
  redirectOrigin: string;
  consentToken: string;
  recentlyUnlocked: boolean;
  error?: string;
}): Response {
  const clientName = htmlEscape(input.clientName);
  const clientOrigin = htmlEscape(input.clientOrigin);
  const redirectOrigin = htmlEscape(input.redirectOrigin);
  const title = "Connect a model";
  const ownerKey = input.recentlyUnlocked
    ? '<p class="micro">Driftglass is already unlocked in this browser.</p>'
    : '<label for="owner-key">Owner key <span class="field-note">sent only to this Driftglass</span><input id="owner-key" name="owner_key" type="password" autocomplete="current-password" required /></label>';
  const error = input.error ? `<p class="error" role="alert">${htmlEscape(input.error)}</p>` : "";
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="theme-color" content="#10131a" />
    <link rel="icon" href="/icons/driftglass.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/styles.css?v=20260808.8" />
    <title>${title} — Driftglass</title>
  </head>
  <body>
    <div class="login-shell">
      <main class="login-card glass">
        <p class="eyebrow">Connection request</p>
        <h1>${title}</h1>
        <p class="lede"><strong>${clientName}</strong> is asking to look up your Missions, Stories, sources, and connected memory. It cannot save or change anything.</p>
        <p class="micro">Requested by ${clientOrigin}<br />Returns to ${redirectOrigin}</p>
        <form method="post" class="stack-form">
          <input type="hidden" name="consent_token" value="${htmlEscape(input.consentToken)}" />
          ${ownerKey}
          ${error}
          <div class="top-actions">
            <button class="primary" type="submit" name="decision" value="allow">Connect</button>
            <button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
          </div>
        </form>
        <p class="micro">The connection goes straight to this instance.</p>
      </main>
    </div>
  </body>
</html>`;
  return new Response(body, { headers: consentHeaders(input.redirectOrigin) });
}

function localAuthorizationError(message: string, status = 400): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><link rel="stylesheet" href="/styles.css?v=20260808.8" /><title>Connection could not continue — Driftglass</title></head><body><div class="login-shell"><main class="login-card glass"><p class="eyebrow">Driftglass</p><h1>Connection could not continue</h1><p class="lede">${htmlEscape(message)}</p></main></div></body></html>`;
  return new Response(body, { status, headers: consentHeaders() });
}

function authorizationRedirect(
  request: Pick<AuthRequest, "redirectUri" | "state" | "issuer">,
  code: "access_denied" | "invalid_scope",
  description: string,
): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", code);
  redirect.searchParams.set("error_description", description);
  if (request.state) redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  const headers = new Headers({ location: redirect.toString(), "cache-control": "no-store" });
  return new Response(null, { status: 302, headers });
}

function parsedAuthorizationError(error: AuthorizationError): Response {
  if (!error.redirectUri) return localAuthorizationError("The requesting app or return address could not be verified.");
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return new Response(null, {
    status: 302,
    headers: { location: redirect.toString(), "cache-control": "no-store" },
  });
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new Error("The connection form was not submitted correctly.");
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > CONSENT_MAX_BYTES) throw new Error("The connection form was too large.");
  if (!request.body) throw new Error("The connection form was empty.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > CONSENT_MAX_BYTES) {
        await reader.cancel("form too large").catch(() => undefined);
        throw new Error("The connection form was too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(new TextDecoder().decode(body));
}

async function handleAuthorization(request: Request, env: OAuthEnv): Promise<Response> {
  assertSecret(env.DRIFTGLASS_SECRET);
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST", "cache-control": "no-store" } });
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return parsedAuthorizationError(error);
    if (error instanceof CimdFetchError) return localAuthorizationError("The requesting app could not be verified. Try connecting again.");
    throw error;
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return localAuthorizationError("The requesting app could not be verified.");
  const clientName = cleanClientName(client);
  const callbackOrigin = consentCallbackOrigin(oauthRequest.redirectUri);
  if (!callbackOrigin) {
    return localAuthorizationError("The return address must use HTTPS or an app loopback address.");
  }

  if (request.method === "GET") {
    if (!oauthRequest.scope.includes(MCP_READ_SCOPE)) {
      return authorizationRedirect(oauthRequest, "invalid_scope", "Driftglass access was not requested.");
    }
    return consentPage({
      clientName,
      clientOrigin: displayOrigin(oauthRequest.clientId),
      redirectOrigin: callbackOrigin,
      consentToken: await createConsentToken(oauthRequest, env.DRIFTGLASS_SECRET),
      recentlyUnlocked: await hasRecentOwnerSession(request, env.DRIFTGLASS_SECRET),
    });
  }

  let form: URLSearchParams;
  try {
    form = await readForm(request);
  } catch (error) {
    return localAuthorizationError(error instanceof Error ? error.message : "The connection form was not submitted correctly.", 400);
  }
  const consentToken = form.get("consent_token") ?? "";
  const consentValid = consentPostHasSafeBrowserContext(request)
    && await validConsentToken(consentToken, oauthRequest, env.DRIFTGLASS_SECRET);
  if (!consentValid) return localAuthorizationError("This connection request expired. Start again from ChatGPT.", 403);
  if (form.get("decision") !== "allow") {
    return authorizationRedirect(oauthRequest, "access_denied", "The owner cancelled the connection.");
  }
  if (!oauthRequest.scope.includes(MCP_READ_SCOPE)) {
    return authorizationRedirect(oauthRequest, "invalid_scope", "Driftglass access was not requested.");
  }

  const recentlyUnlocked = await hasRecentOwnerSession(request, env.DRIFTGLASS_SECRET);
  const suppliedKey = form.get("owner_key") ?? "";
  const ownerConfirmed = recentlyUnlocked || (
    suppliedKey.length > 0 && suppliedKey.length <= 1_024 && await secureEqual(suppliedKey, env.DRIFTGLASS_SECRET)
  );
  if (!ownerConfirmed) {
    return consentPage({
      clientName,
      clientOrigin: displayOrigin(oauthRequest.clientId),
      redirectOrigin: callbackOrigin,
      consentToken: await createConsentToken(oauthRequest, env.DRIFTGLASS_SECRET),
      recentlyUnlocked: false,
      error: "That owner key did not match.",
    });
  }

  const resource = `${baseUrlFor(request, env.PUBLIC_BASE_URL)}/mcp`;
  const clientOrigin = displayOrigin(oauthRequest.clientId);
  const redirectOrigin = displayOrigin(oauthRequest.redirectUri);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: OWNER_ID,
    metadata: { clientName, clientOrigin, redirectOrigin },
    scope: [MCP_READ_SCOPE],
    props: { userId: OWNER_ID, access: "read", resource } satisfies McpAuthProps,
  });
  const headers = new Headers({ location: redirectTo, "cache-control": "no-store" });
  headers.append("set-cookie", await ownerSessionCookie(env.DRIFTGLASS_SECRET));
  return new Response(null, { status: 302, headers });
}

function bearerChallenge(request: Request, code: "invalid_token" | "insufficient_scope", description: string): Response {
  const url = new URL(request.url);
  const metadata = `${url.origin}/.well-known/oauth-protected-resource/mcp`;
  const value = `Bearer resource_metadata="${metadata}", error="${code}", error_description="${description}", scope="${MCP_READ_SCOPE}"`;
  return new Response(null, {
    status: code === "insufficient_scope" ? 403 : 401,
    headers: { "cache-control": "no-store", "www-authenticate": value },
  });
}

function exactAudience(audience: string | string[] | undefined, resource: string): boolean {
  return (Array.isArray(audience) ? audience : audience ? [audience] : []).includes(resource);
}

function protectedMcpHandler(resource: string): {
  fetch(request: Request, env: OAuthEnv, ctx: ExecutionContext): Promise<Response>;
} {
  return {
    async fetch(request, env, ctx): Promise<Response> {
      const header = request.headers.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      const summary = token ? await env.OAUTH_PROVIDER.unwrapToken<McpAuthProps>(token) : null;
      const props = summary?.grant.props;
      if (
        !summary
        || !props
        || typeof props !== "object"
        || summary.userId !== OWNER_ID
        || props.userId !== OWNER_ID
      ) {
        return bearerChallenge(request, "invalid_token", "Connect Driftglass again to continue.");
      }
      if (!exactAudience(summary.audience, resource) || props.resource !== resource) {
        return bearerChallenge(request, "invalid_token", "This connection belongs to a different Driftglass address.");
      }
      if (!Array.isArray(summary.scope) || !summary.scope.includes(MCP_READ_SCOPE) || props.access !== "read") {
        return bearerChallenge(request, "insufficient_scope", "This connection does not include Driftglass access.");
      }
      await ensureSchema(env.DB);
      return handleOAuthMcp(request, env, ctx);
    },
  };
}

function isOAuthOnlyPath(path: string): boolean {
  return path === "/mcp"
    || path === "/authorize"
    || path === "/oauth/token"
    || path === "/.well-known/oauth-authorization-server"
    || path === "/.well-known/oauth-protected-resource"
    || path.startsWith("/.well-known/oauth-protected-resource/");
}

/**
 * Adds a direct, per-instance connection without changing legacy capability
 * URLs. Each deployment owns its own tokens and KV namespace.
 */
export async function handleMcpOAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  coreFetch: CoreFetch,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/mcp/")) return coreFetch(request, env, ctx);
  if (!env.OAUTH_KV) {
    if (isOAuthOnlyPath(path)) {
      return json({ ok: false, error: "Connect ChatGPT is not available until OAUTH_KV is bound." }, { status: 503 });
    }
    return coreFetch(request, env, ctx);
  }

  const oauthEnv = env as OAuthEnv;
  const base = baseUrlFor(request, env.PUBLIC_BASE_URL);
  if (!base.startsWith("https://")) {
    if (isOAuthOnlyPath(path)) {
      return json({ ok: false, error: "Connect ChatGPT requires an HTTPS Driftglass address." }, { status: 503 });
    }
    return coreFetch(request, env, ctx);
  }
  const resource = `${base}/mcp`;
  const provider = new OAuthProvider<OAuthEnv>({
    apiRoute: "/mcp",
    apiHandler: protectedMcpHandler(resource),
    defaultHandler: {
      async fetch(innerRequest, innerEnv, innerCtx): Promise<Response> {
        if (new URL(innerRequest.url).pathname === "/authorize") {
          return handleAuthorization(innerRequest, innerEnv);
        }
        return coreFetch(innerRequest, innerEnv, innerCtx);
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: undefined,
    scopesSupported: [MCP_READ_SCOPE],
    resourceMetadata: {
      resource,
      authorization_servers: [base],
      scopes_supported: [MCP_READ_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Driftglass",
    },
    clientIdMetadataDocumentEnabled: true,
    allowPlainPKCE: false,
    allowImplicitFlow: false,
    onError(error): void {
      console.error(JSON.stringify({
        message: "MCP connection error",
        code: error.code,
        status: error.status,
        category: error.internal?.category,
        reason: error.internal?.reason,
      }));
    },
  });
  return provider.fetch(request, requestScopedOAuthEnv(oauthEnv), ctx);
}
