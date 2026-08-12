import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

const SERVER = "https://driftglass.example";
const RESOURCE = `${SERVER}/mcp`;
const CLIENT_ID = "https://client.example/chatgpt.json";
const REDIRECT_URI = "https://callback.example/oauth/return?registered=1";
const LOOPBACK_REDIRECT_URI = "http://127.0.0.1:54321/callback";
const LOCALHOST_REDIRECT_URI = "http://localhost:54322/callback";
const OWNER_KEY = "owner-secret-longer-than-twenty-four-characters-for-oauth-tests";
const VERIFIER = "test-code-verifier-that-is-deliberately-long-enough-for-pkce-s256";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

function authorizationUrl(method = "S256", server = SERVER, redirectUri = REDIRECT_URI) {
  const url = new URL("/authorize", server);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "driftglass:read");
  url.searchParams.set("state", "state-for-test");
  url.searchParams.set("resource", `${server}/mcp`);
  url.searchParams.set("code_challenge", method === "S256" ? CHALLENGE : VERIFIER);
  url.searchParams.set("code_challenge_method", method);
  return url.toString();
}

function form(values) {
  return new URLSearchParams(values).toString();
}

async function oauthWorker({ publicBaseUrl = SERVER } = {}) {
  const built = await build({
    entryPoints: [new URL("./fixtures/mcp-oauth-worker.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["main", "module"],
    conditions: ["workerd", "worker", "browser"],
    // Keep CIMD metadata hermetic: the production flag is asserted below,
    // while the test bundle exposes the same gate value to the real provider.
    define: {
      Cloudflare: '{"compatibilityFlags":{"global_fetch_strictly_public":true}}',
    },
    external: ["cloudflare:*", "node:*"],
    write: false,
    logLevel: "silent",
  });
  let cimdFetches = 0;
  const worker = new Miniflare({
    log: new Log(LogLevel.NONE),
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: ["OAUTH_KV"],
    d1Databases: ["DB"],
    bindings: {
      DRIFTGLASS_SECRET: OWNER_KEY,
      ...(publicBaseUrl ? { PUBLIC_BASE_URL: publicBaseUrl } : {}),
    },
    outboundService: async (request) => {
      if (request.url !== CLIENT_ID) return new Response("Not found", { status: 404 });
      cimdFetches += 1;
      return Response.json({
        client_id: CLIENT_ID,
        client_name: "ChatGPT",
        redirect_uris: [REDIRECT_URI, LOOPBACK_REDIRECT_URI, LOCALHOST_REDIRECT_URI],
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    },
  });
  try {
    const db = await worker.getD1Database("DB");
    await db.prepare(`CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).run();
    await db.prepare("INSERT INTO settings(key, value) VALUES ('schema_version', '23')").run();
  } catch (error) {
    await worker.dispose();
    throw error;
  }
  return { worker, cimdFetches: () => cimdFetches };
}

async function authorize(worker) {
  const url = authorizationUrl();
  const consent = await worker.dispatchFetch(url);
  assert.equal(consent.status, 200);
  const consentCsp = consent.headers.get("content-security-policy") ?? "";
  assert.match(consentCsp, /frame-ancestors 'none'/);
  assert.match(consentCsp, /form-action 'self' https:\/\/callback\.example(?:;|$)/);
  assert.doesNotMatch(consentCsp, /https:\/\/client\.example|\/oauth\/return|registered=1/);
  assert.equal(consent.headers.get("cross-origin-opener-policy"), "unsafe-none");
  assert.equal(consent.headers.get("cache-control"), "no-store, max-age=0");
  const page = await consent.text();
  assert.match(page, /Connect a model/);
  assert.match(page, /Requested by https:\/\/client\.example/);
  assert.match(page, /Returns to https:\/\/callback\.example/);
  assert.doesNotMatch(page, /Connect ChatGPT/);
  const consentToken = page.match(/name="consent_token" value="([^"]+)"/)?.[1];
  assert.ok(consentToken);

  const browserHeaders = {
    origin: SERVER,
    "sec-fetch-site": "same-origin",
    "content-type": "application/x-www-form-urlencoded",
  };

  const changedRequest = new URL(url);
  changedRequest.searchParams.set("state", "different-state");

  const rejected = await worker.dispatchFetch(changedRequest, {
    method: "POST",
    headers: browserHeaders,
    body: form({ consent_token: consentToken, owner_key: OWNER_KEY, decision: "allow" }),
  });
  assert.equal(rejected.status, 403);
  const rejectedCsp = rejected.headers.get("content-security-policy") ?? "";
  assert.match(rejectedCsp, /form-action 'self'(?:;|$)/);
  assert.doesNotMatch(rejectedCsp, /https:\/\/callback\.example/);
  assert.match(await rejected.text(), /request expired/i);

  const crossSite = await worker.dispatchFetch(url, {
    method: "POST",
    headers: {
      ...browserHeaders,
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
    body: form({ consent_token: consentToken, owner_key: OWNER_KEY, decision: "allow" }),
  });
  assert.equal(crossSite.status, 403);

  const allowed = await worker.dispatchFetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { ...browserHeaders, origin: "null" },
    body: form({ consent_token: consentToken, owner_key: OWNER_KEY, decision: "allow" }),
  });
  assert.equal(allowed.status, 302);
  const redirect = new URL(allowed.headers.get("location"));
  const registeredRedirect = new URL(REDIRECT_URI);
  assert.equal(redirect.origin + redirect.pathname, registeredRedirect.origin + registeredRedirect.pathname);
  assert.equal(redirect.searchParams.get("registered"), "1");
  assert.equal(redirect.searchParams.get("state"), "state-for-test");
  assert.ok(redirect.searchParams.get("code"));
  return redirect.searchParams.get("code");
}

async function exchange(worker, code) {
  const response = await worker.dispatchFetch(`${SERVER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const token = await response.json();
  assert.equal(token.scope, "driftglass:read");
  assert.equal(token.token_type, "bearer");
  assert.ok(token.access_token);
  assert.ok(token.refresh_token);
  return { accessToken: token.access_token, refreshToken: token.refresh_token };
}

test("direct MCP OAuth discovers, consents, enforces, and revokes through one per-instance flow", async (t) => {
  const { worker, cimdFetches } = await oauthWorker();
  t.after(() => worker.dispose());

  const resourceDiscovery = await worker.dispatchFetch(`${SERVER}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(resourceDiscovery.status, 200);
  assert.deepEqual(await resourceDiscovery.json(), {
    resource: RESOURCE,
    authorization_servers: [SERVER],
    scopes_supported: ["driftglass:read"],
    bearer_methods_supported: ["header"],
    resource_name: "Driftglass",
  });

  const serverDiscovery = await worker.dispatchFetch(`${SERVER}/.well-known/oauth-authorization-server`);
  assert.equal(serverDiscovery.status, 200);
  const metadata = await serverDiscovery.json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.equal("registration_endpoint" in metadata, false);

  const loopbackConsent = await worker.dispatchFetch(authorizationUrl("S256", SERVER, LOOPBACK_REDIRECT_URI));
  assert.equal(loopbackConsent.status, 200);
  const loopbackCsp = loopbackConsent.headers.get("content-security-policy") ?? "";
  assert.match(loopbackCsp, /form-action 'self' http:\/\/127\.0\.0\.1:54321(?:;|$)/);
  assert.doesNotMatch(loopbackCsp, /\/callback|https:\/\/client\.example/);
  assert.equal(loopbackConsent.headers.get("cross-origin-opener-policy"), "unsafe-none");
  assert.match(await loopbackConsent.text(), /Returns to http:\/\/127\.0\.0\.1:54321/);

  const localhostConsent = await worker.dispatchFetch(authorizationUrl("S256", SERVER, LOCALHOST_REDIRECT_URI));
  assert.equal(localhostConsent.status, 200);
  const localhostCsp = localhostConsent.headers.get("content-security-policy") ?? "";
  assert.match(localhostCsp, /form-action 'self' http:\/\/localhost:54322(?:;|$)/);
  assert.doesNotMatch(localhostCsp, /\/callback|https:\/\/client\.example/);
  assert.equal(localhostConsent.headers.get("cross-origin-opener-policy"), "unsafe-none");
  assert.match(await localhostConsent.text(), /Returns to http:\/\/localhost:54322/);

  const plain = await worker.dispatchFetch(authorizationUrl("plain"), { redirect: "manual" });
  assert.equal(plain.status, 302);
  assert.equal(new URL(plain.headers.get("location")).searchParams.get("error"), "invalid_request");

  const code = await authorize(worker);
  const { accessToken, refreshToken } = await exchange(worker, code);
  assert.ok(cimdFetches() >= 1);

  const toolList = await worker.dispatchFetch(RESOURCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(toolList.status, 200, await toolList.clone().text());
  const toolBody = await toolList.text();
  const toolJson = (toolList.headers.get("content-type") ?? "").includes("text/event-stream")
    ? toolBody.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6)
    : toolBody;
  assert.ok(toolJson);
  const toolPayload = JSON.parse(toolJson);
  assert.ok(toolPayload.result.tools.length > 0);
  for (const tool of toolPayload.result.tools) {
    assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["driftglass:read"] }]);
    assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
  }

  const subscriptionAbort = new AbortController();
  const subscription = await worker.dispatchFetch(RESOURCE, {
    method: "POST",
    signal: subscriptionAbort.signal,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "subscriptions/listen", params: {} }),
  });
  assert.match(subscription.headers.get("content-type") ?? "", /text\/event-stream/, await subscription.clone().text());
  subscriptionAbort.abort();
  await subscription.body?.cancel();

  const kv = await worker.getKVNamespace("OAUTH_KV");
  const tokenKeys = await kv.list({ prefix: "token:" });
  assert.equal(tokenKeys.keys.length, 1);
  const tokenKey = tokenKeys.keys[0].name;
  const original = await kv.get(tokenKey, { type: "json" });
  assert.ok(original);

  await kv.put(tokenKey, JSON.stringify({ ...original, audience: `${SERVER}/other` }));
  const wrongAudience = await worker.dispatchFetch(RESOURCE, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(wrongAudience.status, 401);
  assert.match(wrongAudience.headers.get("www-authenticate") ?? "", /invalid_token/);

  await kv.put(tokenKey, JSON.stringify({ ...original, scope: [], grant: { ...original.grant, scope: [] } }));
  const wrongScope = await worker.dispatchFetch(RESOURCE, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(wrongScope.status, 403);
  assert.match(wrongScope.headers.get("www-authenticate") ?? "", /insufficient_scope/);

  await kv.put(tokenKey, JSON.stringify(original));
  const connections = await worker.dispatchFetch(`${SERVER}/api/reasoning/connections`);
  assert.equal(connections.status, 200);
  const connectionPayload = await connections.json();
  assert.equal(connectionPayload.available, true);
  assert.equal(connectionPayload.connections.length, 1);
  assert.equal(connectionPayload.connections[0].name, "ChatGPT");
  assert.equal(connectionPayload.connections[0].origin, "https://client.example");
  assert.equal(connectionPayload.connections[0].expiresAt, null);

  const disconnected = await worker.dispatchFetch(
    `${SERVER}/api/reasoning/connections/${encodeURIComponent(connectionPayload.connections[0].id)}`,
    { method: "DELETE" },
  );
  assert.equal(disconnected.status, 200);
  assert.deepEqual(await disconnected.json(), { ok: true, disconnected: true });

  const revoked = await worker.dispatchFetch(RESOURCE, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(revoked.status, 401);

  const revokedRefresh = await worker.dispatchFetch(`${SERVER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      resource: RESOURCE,
    }),
  });
  assert.equal(revokedRefresh.status, 400);
  assert.equal((await revokedRefresh.json()).error, "invalid_grant");
});

test("local HTTP keeps the core app available and fails the remote connection clearly", async (t) => {
  const { worker } = await oauthWorker({ publicBaseUrl: "" });
  t.after(() => worker.dispose());

  const core = await worker.dispatchFetch("http://localhost/api/reasoning/connections");
  assert.equal(core.status, 200);
  assert.deepEqual(await core.json(), { ok: true, available: false, connections: [] });

  const remote = await worker.dispatchFetch("http://localhost/mcp");
  assert.equal(remote.status, 503);
  assert.match((await remote.json()).error, /requires an HTTPS Driftglass address/);
});

test("one hostname cannot poison a later per-instance OAuth request", async (t) => {
  const { worker } = await oauthWorker({ publicBaseUrl: "" });
  t.after(() => worker.dispose());

  const first = await worker.dispatchFetch("https://first.example/api/reasoning/connections");
  assert.equal(first.status, 200);

  const second = await worker.dispatchFetch(authorizationUrl("S256", "https://second.example"), { redirect: "manual" });
  assert.equal(second.status, 200, await second.clone().text());
  assert.match(await second.text(), /Connect a model/);
});

test("the pinned Cloudflare deploy contract auto-provisions one OAuth KV binding per environment", async () => {
  const [configRaw, packageRaw, source] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../src/mcp-oauth.ts", import.meta.url), "utf8"),
  ]);
  const config = JSON.parse(configRaw);
  const manifest = JSON.parse(packageRaw);
  assert.equal(manifest.dependencies["@cloudflare/workers-oauth-provider"], "0.10.2");
  assert.equal(manifest.devDependencies.wrangler, "4.120.0");
  assert.ok(config.compatibility_flags.includes("global_fetch_strictly_public"));
  for (const bindings of [config.kv_namespaces, config.env.staging.kv_namespaces]) {
    assert.deepEqual(bindings, [{ binding: "OAUTH_KV" }]);
    assert.equal("id" in bindings[0], false);
  }
  assert.ok(config.assets.run_worker_first.includes("/mcp"));
  assert.ok(config.assets.run_worker_first.includes("/authorize"));
  assert.ok(config.assets.run_worker_first.includes("/oauth/*"));
  assert.doesNotMatch(source, /clientRegistrationEndpoint\s*:/);
  assert.match(source, /clientIdMetadataDocumentEnabled:\s*true/);
  assert.match(source, /allowPlainPKCE:\s*false/);
  assert.match(source, /refreshTokenTTL:\s*undefined/);
});
