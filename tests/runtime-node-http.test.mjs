import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const nodeParts = process.versions.node.split(".").map(Number);
const node24 = nodeParts[0] > 24 || (nodeParts[0] === 24 && nodeParts[1] >= 4) ? test : test.skip;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const realTemporaryDirectory = realpathSync(tmpdir());

const { createRequestLifecycle } = require("../.test-dist/http/contracts.js");
const { createHttpRouter } = require("../.test-dist/http/router.js");
const {
  NODE_HTTP_DEFAULTS,
  PORTABLE_NODE_MINIMUM_VERSION,
  normalizeNodeHttpConfig,
} = require("../.test-dist/runtime/node/http/config.js");
const { FileAssetAdapter } = require("../.test-dist/runtime/node/http/assets.js");
const { startNodeHttpServer } = require("../.test-dist/runtime/node/http/server.js");

function temporaryRoot(t, prefix) {
  const root = mkdtempSync(join(realTemporaryDirectory, prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out")), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function callServer(started, path, options = {}) {
  const headers = {
    host: "127.0.0.1:" + started.address.port,
    ...(options.headers ?? {}),
  };
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: started.address.port,
      path,
      method: options.method ?? "GET",
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        rawHeaders: response.rawHeaders,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    if (Array.isArray(options.body)) {
      for (const chunk of options.body) request.write(chunk);
      request.end();
    } else {
      request.end(options.body);
    }
  });
}

function callServerRaw(started, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: started.address.port });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(payload));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

test("portable router keeps liveness separate from unavailable readiness and uses only injected handlers", async () => {
  const calls = [];
  const router = createHttpRouter({
    service: "test-service",
    version: "0.9.0",
    routes: [
      {
        name: "api",
        path: "/api",
        handler(request) {
          calls.push(new URL(request.url).pathname);
          return new Response("api");
        },
      },
      {
        name: "exact",
        path: "/fixed",
        match: "exact",
        handler() {
          return new Response("fixed");
        },
      },
    ],
    assets(request) {
      return new Response("asset:" + new URL(request.url).pathname);
    },
  });

  const health = await router.fetch(new Request("http://local.test/health"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    status: "alive",
    service: "test-service",
    version: "0.9.0",
  });
  const ready = await router.fetch(new Request("http://local.test/ready"));
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).status, "unavailable");
  assert.equal(await (await router.fetch(new Request("http://local.test/api/items"))).text(), "api");
  assert.equal(await (await router.fetch(new Request("http://local.test/apiary"))).text(), "asset:/apiary");
  assert.equal(await (await router.fetch(new Request("http://local.test/fixed/child"))).text(), "asset:/fixed/child");
  assert.deepEqual(calls, ["/api/items"]);
  assert.throws(
    () => createHttpRouter({ routes: [{ name: "bad", path: "../api", handler: () => new Response() }] }),
    /absolute URL paths/,
  );
});

test("portable router forwards the neutral request lifecycle and drain observes nested and rejected work", async () => {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let nestedFinished = false;
  const lifecycle = createRequestLifecycle();
  const router = createHttpRouter({
    routes: [{
      name: "lifecycle",
      path: "/work",
      handler(_request, receivedLifecycle) {
        assert.equal(receivedLifecycle, lifecycle);
        receivedLifecycle.waitUntil(released.then(() => {
          receivedLifecycle.waitUntil(Promise.resolve().then(() => { nestedFinished = true; }));
        }));
        receivedLifecycle.waitUntil(Promise.reject(new Error("observed background rejection")));
        return new Response("accepted", { status: 202 });
      },
    }],
  });
  assert.equal((await router.fetch(new Request("http://local.test/work"), lifecycle)).status, 202);
  let drained = false;
  const drain = lifecycle.drain().then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  await drain;
  assert.equal(nestedFinished, true);
  assert.throws(() => lifecycle.waitUntil(Promise.resolve()), /already draining/);
});

node24("Node HTTP config is loopback-first, proxy-blind, bounded, and absent from the neutral barrel", () => {
  assert.equal(PORTABLE_NODE_MINIMUM_VERSION, "24.4.0");
  const defaults = normalizeNodeHttpConfig({ port: 0 });
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.port, 0);
  assert.equal(defaults.trustProxyHeaders, false);
  assert.equal(defaults.maxHeaderSizeBytes, NODE_HTTP_DEFAULTS.maxHeaderSizeBytes);
  assert.throws(() => normalizeNodeHttpConfig({ host: "0.0.0.0" }), /unsafeAllowNonLoopback/);
  assert.throws(
    () => normalizeNodeHttpConfig({ host: "0.0.0.0", unsafeAllowNonLoopback: true }),
    /explicit origin or allowedHosts/,
  );
  assert.doesNotThrow(() => normalizeNodeHttpConfig({
    host: "0.0.0.0",
    unsafeAllowNonLoopback: true,
    allowedHosts: ["driftglass.internal:8787"],
  }));
  assert.throws(() => normalizeNodeHttpConfig({ trustProxyHeaders: true }), /Proxy headers are disabled/);
  assert.throws(() => normalizeNodeHttpConfig({ headersTimeoutMs: 40_000, requestTimeoutMs: 30_000 }), /must not exceed/);

  const neutral = require("../.test-dist/runtime/index.js");
  assert.equal(neutral.startNodeHttpServer, undefined);
  assert.equal(neutral.FileAssetAdapter, undefined);

  const transportSources = [
    "src/http/contracts.ts",
    "src/http/router.ts",
    "src/runtime/node/http/config.ts",
    "src/runtime/node/http/assets.ts",
    "src/runtime/node/http/adapter.ts",
    "src/runtime/node/http/server.ts",
  ].map((path) => readFileSync(join(repositoryRoot, path), "utf8")).join("\n");
  assert.doesNotMatch(transportSources, /from\s+["'][^"']*(?:\/index|\/api|\/mcp|runtime\/cloudflare|worker-configuration)["']/);
  const nodeConfig = readFileSync(join(repositoryRoot, "tsconfig.node-http.json"), "utf8");
  assert.doesNotMatch(nodeConfig, /worker-configuration|cloudflare\.d\.ts/);
});

node24("file assets are cwd-independent and implement exact MIME, HEAD, ETag, and bounded cache semantics", async (t) => {
  const root = temporaryRoot(t, "driftglass-http-assets-");
  writeFileSync(join(root, "index.html"), "<main>dashboard</main>");
  writeFileSync(join(root, "app.js"), "export const ready = true;\n");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "index.html"), "<main>docs</main>");
  const assets = new FileAssetAdapter({
    root: pathToFileURL(root),
    trustedAssetRoot: true,
    cacheControl: "public, max-age=123",
    htmlCacheControl: "no-cache",
  });
  assert.throws(() => new FileAssetAdapter({ root: "public" }), /explicit absolute path/);
  assert.throws(
    () => new FileAssetAdapter({ root }),
    /trustedAssetRoot: true/,
  );

  const script = await assets.fetch(new Request("http://local.test/app.js"));
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(script.headers.get("cache-control"), "public, max-age=123");
  assert.equal(script.headers.get("content-length"), String(Buffer.byteLength("export const ready = true;\n")));
  const etag = script.headers.get("etag");
  assert.match(etag, /^W\/"[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+"$/);
  assert.equal(await script.text(), "export const ready = true;\n");

  const head = await assets.fetch(new Request("http://local.test/app.js", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(head.headers.get("content-length"), script.headers.get("content-length"));
  assert.equal(await head.text(), "");

  const notModified = await assets.fetch(new Request("http://local.test/app.js", {
    headers: { "if-none-match": "\"other\", " + etag.replace(/^W\//, "") },
  }));
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("etag"), etag);
  assert.equal(await notModified.text(), "");
  const movedScript = join(root, "app-moved.js");
  renameSync(join(root, "app.js"), movedScript);
  renameSync(movedScript, join(root, "app.js"));

  const html = await assets.fetch(new Request("http://local.test/"));
  assert.equal(html.headers.get("cache-control"), "no-cache");
  assert.equal(await html.text(), "<main>dashboard</main>");
  assert.equal(await (await assets.fetch(new Request("http://local.test/docs/"))).text(), "<main>docs</main>");
});

node24("file assets reject a filesystem or drive root before touching its contents or modes", () => {
  const filesystemRoot = parse(repositoryRoot).root;
  const before = lstatSync(filesystemRoot);
  const entries = readdirSync(filesystemRoot).sort();
  assert.throws(
    () => new FileAssetAdapter({ root: filesystemRoot }),
    /must not be a filesystem or drive root/,
  );
  const after = lstatSync(filesystemRoot);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(readdirSync(filesystemRoot).sort(), entries);
});

node24("large assets stream from the verified descriptor and cancellation releases it without full buffering", async (t) => {
  const root = temporaryRoot(t, "driftglass-http-large-asset-");
  writeFileSync(join(root, "index.html"), "<main>dashboard</main>");
  const largePath = join(root, "large.bin");
  const byteLength = 2 * 1024 * 1024;
  writeFileSync(largePath, Buffer.alloc(byteLength, 0x61));
  const assets = new FileAssetAdapter({ root, trustedAssetRoot: true });
  const source = readFileSync(join(repositoryRoot, "src", "runtime", "node", "http", "assets.ts"), "utf8");
  assert.doesNotMatch(source, /\.readFile\s*\(/, "the adapter must not buffer through FileHandle.readFile");

  const response = await assets.fetch(new Request("http://local.test/large.bin"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(byteLength));
  appendFileSync(largePath, Buffer.alloc(128 * 1024, 0x62));
  assert.equal((await response.arrayBuffer()).byteLength, byteLength, "a growing inode must stop at the verified snapshot");

  const cancelledResponse = await assets.fetch(new Request("http://local.test/large.bin"));
  assert.equal(cancelledResponse.headers.get("content-length"), String(byteLength + 128 * 1024));
  const reader = cancelledResponse.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(first.value.byteLength > 0 && first.value.byteLength < byteLength + 128 * 1024);
  await reader.cancel("test cancellation");

  const moved = join(root, "large-moved.bin");
  renameSync(largePath, moved);
  renameSync(moved, largePath);

  writeFileSync(join(root, "empty.bin"), "");
  const empty = await assets.fetch(new Request("http://local.test/empty.bin"));
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("content-length"), "0");
  assert.equal((await empty.arrayBuffer()).byteLength, 0);
  renameSync(join(root, "empty.bin"), join(root, "empty-moved.bin"));
});

node24("asset traversal, ambiguous portable names, symlinks, and nonregular targets fail closed", async (t) => {
  const root = temporaryRoot(t, "driftglass-http-asset-safety-");
  const outside = temporaryRoot(t, "driftglass-http-asset-outside-");
  writeFileSync(join(root, "index.html"), "<main>safe</main>");
  writeFileSync(join(outside, "secret.txt"), "must-not-leak");
  const assets = new FileAssetAdapter({ root, trustedAssetRoot: true });

  for (const path of [
    "/%252e%252e/secret.txt",
    "/..%2fsecret.txt",
    "/%5csecret.txt",
    "/bad%00name.txt",
    "/safe.txt:alternate-stream",
    "/safe.txt%3Aalternate-stream",
    "/CON",
    "/con.txt",
    "/%4eUL.json",
    "/COM%C2%B9.log",
    "/LPT9",
    "/trailing.",
  ]) {
    const response = await assets.fetch(new Request("http://local.test" + path));
    assert.equal(response.status, 400, path);
    assert.doesNotMatch(await response.text(), /must-not-leak|driftglass-http-asset/i);
  }

  assert.throws(
    () => new FileAssetAdapter({ root, trustedAssetRoot: true, indexFile: "AUX.html" }),
    /one plain filename/,
  );

  const link = join(root, "linked.txt");
  try {
    symlinkSync(join(outside, "secret.txt"), link, "file");
    const response = await assets.fetch(new Request("http://local.test/linked.txt"));
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /must-not-leak|driftglass-http-asset/i);
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }

  mkdirSync(join(root, "plain-directory"));
  assert.equal((await assets.fetch(new Request("http://local.test/plain-directory"))).status, 404);
});

node24("SPA fallback is restricted to real HTML navigations and never masks API, MCP, or missing files", async (t) => {
  const root = temporaryRoot(t, "driftglass-http-spa-");
  writeFileSync(join(root, "index.html"), "<main>spa</main>");
  const assets = new FileAssetAdapter({ root, trustedAssetRoot: true });
  const navigationHeaders = { accept: "text/html,application/xhtml+xml", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

  assert.equal(await (await assets.fetch(new Request("http://local.test/missions/active", { headers: navigationHeaders }))).text(), "<main>spa</main>");
  for (const path of [
    "/missing.js",
    "/api/missing",
    "/mcp/missing",
    "/.well-known/missing",
    "/%61pi/missing",
    "/%6dcp/missing",
    "/%68ealth/missing",
    "/%72eady/missing",
  ]) {
    assert.equal((await assets.fetch(new Request("http://local.test" + path, { headers: navigationHeaders }))).status, 404, path);
  }
  assert.equal((await assets.fetch(new Request("http://local.test/missions/active", { headers: { accept: "*/*" } }))).status, 404);
  assert.equal((await assets.fetch(new Request("http://local.test/missions/active", {
    headers: { accept: "text/html", "sec-fetch-mode": "cors" },
  }))).status, 404);
  const post = await assets.fetch(new Request("http://local.test/missions/active", { method: "POST" }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
});

node24("Node adapter enforces Host, ignores proxy authority, streams responses, splits cookies, and drops hop headers", async (t) => {
  const logs = [];
  const encoder = new TextEncoder();
  const started = await startNodeHttpServer(async (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/inspect") {
      return Response.json({
        url: request.url,
        forwarded: request.headers.get("forwarded"),
        forwardedHost: request.headers.get("x-forwarded-host"),
        hop: request.headers.get("x-hop"),
      });
    }
    if (pathname === "/stream") {
      let index = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (index === 128) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode("chunk-" + index + "|"));
          index += 1;
        },
      });
      const headers = new Headers({ connection: "x-drop", "x-drop": "must-not-cross" });
      headers.append("set-cookie", "first=1; Path=/; HttpOnly");
      headers.append("set-cookie", "second=2; Path=/; SameSite=Strict");
      return new Response(body, { headers });
    }
    if (pathname === "/head") {
      return new Response("must-not-be-sent", { headers: { "content-length": "16" } });
    }
    throw new Error("INTERNAL_SECRET_MESSAGE");
  }, { port: 0, logger: (entry) => logs.push(entry), drainTimeoutMs: 2_000 });
  t.after(() => started.close().catch(() => undefined));

  const inspected = await callServer(started, "/inspect?do-not-log=QUERY_SECRET", {
    headers: {
      forwarded: "for=198.51.100.2;host=attacker.invalid;proto=https",
      "x-forwarded-host": "attacker.invalid",
      connection: "x-hop",
      "x-hop": "must-not-cross",
    },
  });
  assert.equal(inspected.status, 200);
  assert.deepEqual(JSON.parse(inspected.body), {
    url: started.origin + "/inspect?do-not-log=QUERY_SECRET",
    forwarded: null,
    forwardedHost: null,
    hop: null,
  });

  const rejectedHost = await callServer(started, "/inspect", { headers: { host: "attacker.invalid" } });
  assert.equal(rejectedHost.status, 421);
  assert.equal(JSON.parse(rejectedHost.body).error.code, "host_not_allowed");

  const duplicateHost = await callServerRaw(
    started,
    "GET /inspect HTTP/1.1\r\n" +
      "Host: 127.0.0.1:" + started.address.port + "\r\n" +
      "Host: attacker.invalid\r\n" +
      "Connection: close\r\n\r\n",
  );
  assert.match(duplicateHost, /^HTTP\/1\.1 400 /);

  const streamed = await callServer(started, "/stream");
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers["x-drop"], undefined);
  assert.deepEqual(streamed.headers["set-cookie"], [
    "first=1; Path=/; HttpOnly",
    "second=2; Path=/; SameSite=Strict",
  ]);
  assert.equal(streamed.body, Array.from({ length: 128 }, (_, index) => "chunk-" + index + "|").join(""));

  const head = await callServer(started, "/head", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], "16");
  assert.equal(head.body, "");

  const failure = await callServer(started, "/mcp/SUPER_SECRET_CAPABILITY_123456789?token=QUERY_SECRET");
  assert.equal(failure.status, 500);
  assert.deepEqual(JSON.parse(failure.body), {
    ok: false,
    error: { code: "internal_error", message: "Internal server error" },
  });
  const shortIdentifierFailure = await callServer(started, "/api/missions/tiny-id?token=ANOTHER_QUERY_SECRET");
  assert.equal(shortIdentifierFailure.status, 500);
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /SUPER_SECRET|QUERY_SECRET|ANOTHER_QUERY_SECRET|INTERNAL_SECRET|missions|tiny-id/);
  assert.match(serializedLogs, /\/mcp\/\[route\]/);
  assert.match(serializedLogs, /\/api\/\[route\]/);
  assert.equal(logs.every((entry) => !("path" in entry)), true);
  assert.equal(started.server.maxHeadersCount, started.config.maxHeadersCount);
  assert.equal(started.server.headersTimeout, started.config.headersTimeoutMs);
  assert.equal(started.server.requestTimeout, started.config.requestTimeoutMs);
  assert.equal(started.server.keepAliveTimeout, started.config.keepAliveTimeoutMs);
});

node24("Node adapter bounds declared and streamed request bodies before product handling completes", async (t) => {
  let calls = 0;
  const started = await startNodeHttpServer(async (request) => {
    calls += 1;
    return new Response(await request.text());
  }, { port: 0, maxRequestBodyBytes: 4, drainTimeoutMs: 2_000 });
  t.after(() => started.close().catch(() => undefined));

  const declared = await callServer(started, "/body", {
    method: "POST",
    headers: { "content-length": "5" },
    body: "12345",
  });
  assert.equal(declared.status, 413);
  assert.equal(calls, 0);

  const streamed = await callServer(started, "/body", {
    method: "POST",
    body: ["12", "345"],
  });
  assert.equal(streamed.status, 413);
  assert.equal(JSON.parse(streamed.body).error.code, "request_body_too_large");
});

node24("an unread streaming request body is unpiped and cannot pin graceful shutdown", async () => {
  const started = await startNodeHttpServer(() => new Response(null, { status: 204 }), {
    port: 0,
    maxRequestBodyBytes: 64 * 1024 * 1024,
    drainTimeoutMs: 500,
  });
  const responseStarted = new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: started.address.port,
      path: "/ignore-body",
      method: "POST",
      headers: {
        host: "127.0.0.1:" + started.address.port,
        "content-length": String(32 * 1024 * 1024),
      },
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", (error) => {
      if (error.code !== "ECONNRESET") reject(error);
    });
    request.write(Buffer.alloc(64 * 1024, 0x61));
  });
  assert.equal(await withTimeout(responseStarted, 1_000, "unread-body response"), 204);
  const before = Date.now();
  await withTimeout(started.close(), 1_000, "unread-body close");
  assert.ok(Date.now() - before < 400);
});

node24("Node Request signal aborts on disconnect and graceful close drains an active response", async (t) => {
  let observeAbort;
  let observeAbortEntry;
  const aborted = new Promise((resolve) => { observeAbort = resolve; });
  const abortEntered = new Promise((resolve) => { observeAbortEntry = resolve; });
  const abortServer = await startNodeHttpServer((request) => new Promise((resolve) => {
    observeAbortEntry();
    request.signal.addEventListener("abort", () => {
      observeAbort(request.signal.aborted);
      resolve(new Response(null, { status: 204 }));
    }, { once: true });
  }), { port: 0, drainTimeoutMs: 2_000 });
  t.after(() => abortServer.close().catch(() => undefined));

  const disconnected = httpRequest({
    host: "127.0.0.1",
    port: abortServer.address.port,
    path: "/disconnect",
    method: "POST",
    headers: {
      host: "127.0.0.1:" + abortServer.address.port,
      "content-length": "100",
    },
  });
  disconnected.on("error", () => undefined);
  disconnected.write("partial");
  await withTimeout(abortEntered, 2_000, "disconnect request entry");
  disconnected.destroy();
  assert.equal(await withTimeout(aborted, 2_000, "request abort"), true);

  let enter;
  let release;
  let releaseBackground;
  const entered = new Promise((resolve) => { enter = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const backgroundReleased = new Promise((resolve) => { releaseBackground = resolve; });
  const drainLogs = [];
  const drainServer = await startNodeHttpServer(async (_request, lifecycle) => {
    enter();
    await released;
    lifecycle.waitUntil(backgroundReleased);
    return new Response("drained");
  }, { port: 0, drainTimeoutMs: 2_000, logger: (entry) => drainLogs.push(entry) });
  t.after(() => drainServer.close().catch(() => undefined));
  const active = callServer(drainServer, "/slow");
  await withTimeout(entered, 2_000, "active request");
  const closing = drainServer.close();
  assert.equal(drainServer.close(), closing);
  release();
  assert.equal((await withTimeout(active, 2_000, "drained response")).body, "drained");
  let closeFinished = false;
  void closing.then(() => { closeFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeFinished, false, "close must wait for registered response-independent work");
  releaseBackground();
  const closeResult = await withTimeout(closing, 2_000, "server close");
  assert.equal(closeResult.status, "clean");
  assert.equal(closeResult.remainingBackgroundWork, 0);
  assert.ok(closeResult.durationMs >= 0);
  assert.deepEqual(
    drainLogs.filter((entry) => entry.event === "http_shutdown").map((entry) => entry.shutdownStatus),
    ["clean"],
  );
});

node24("graceful close bounds never-settling request lifecycle work", async () => {
  const logs = [];
  const started = await startNodeHttpServer((_request, lifecycle) => {
    lifecycle.waitUntil(new Promise(() => undefined));
    return new Response("accepted", { status: 202 });
  }, { port: 0, drainTimeoutMs: 30, logger: (entry) => logs.push(entry) });
  assert.equal((await callServer(started, "/background")).status, 202);
  const before = Date.now();
  const closing = started.close();
  assert.equal(started.close(), closing);
  const result = await withTimeout(closing, 1_000, "bounded lifecycle drain");
  assert.ok(Date.now() - before < 500);
  assert.equal(result.status, "forced");
  assert.equal(result.remainingBackgroundWork, 1);
  assert.ok(result.durationMs >= 30 && result.durationMs < 500);
  assert.deepEqual(
    logs.filter((entry) => entry.event === "http_shutdown").map((entry) => ({
      status: entry.shutdownStatus,
      remaining: entry.remainingBackgroundWork,
      level: entry.level,
    })),
    [{ status: "forced", remaining: 1, level: "warn" }],
  );
});

node24("graceful close clears its deadline timer when the raw server was already closed", async () => {
  const serverModule = join(repositoryRoot, ".test-dist/runtime/node/http/server.js");
  const childScript = `
const { performance } = require("node:perf_hooks");
const { startNodeHttpServer } = require(process.argv[1]);

(async () => {
  const started = await startNodeHttpServer(() => new Response("ok"), {
    port: 0,
    drainTimeoutMs: 10_000,
  });
  await new Promise((resolve, reject) => {
    started.server.close((error) => error ? reject(error) : resolve());
  });
  const before = performance.now();
  const closing = started.close();
  if (started.close() !== closing) throw new Error("close did not preserve its promise");
  try {
    await closing;
    throw new Error("close unexpectedly resolved");
  } catch (error) {
    if (error?.code !== "ERR_SERVER_NOT_RUNNING") throw error;
    process.stdout.write(JSON.stringify({ code: error.code, durationMs: performance.now() - before }));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
  const child = spawn(process.execPath, ["-e", childScript, serverModule], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let result;
  try {
    result = await withTimeout(exited, 2_000, "externally closed server process exit");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  const close = JSON.parse(stdout);
  assert.equal(close.code, "ERR_SERVER_NOT_RUNNING");
  assert.ok(close.durationMs < 500, `close rejected after ${close.durationMs} ms`);
});

node24("Node parser applies the configured header byte bound with a sanitized client error", async (t) => {
  const logs = [];
  const started = await startNodeHttpServer(() => new Response("ok"), {
    port: 0,
    maxHeaderSizeBytes: 1_024,
    logger: (entry) => logs.push(entry),
    drainTimeoutMs: 2_000,
  });
  t.after(() => started.close().catch(() => undefined));
  const response = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: started.address.port });
    let body = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:" + started.address.port +
        "\r\nX-Oversized: " + "x".repeat(2_000) + "\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => { body += chunk; });
    socket.on("end", () => resolve(body));
    socket.on("error", reject);
  });
  assert.match(response, /^HTTP\/1\.1 431 /);
  assert.equal(logs.some((entry) => entry.errorCode === "headers_too_large"), true);
  assert.doesNotMatch(JSON.stringify(logs), /x{20}/);
});
