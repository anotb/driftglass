import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  RUNTIME_PROFILES,
  RuntimeProfileError,
  describeRuntimeProfile,
  parseRuntimeProfile,
  runtimeProfileDefinition,
} = require("../.test-dist/runtime/profiles.js");
const {
  CloudflareIngressPort,
  CloudflareD1Database,
  CloudflareR2ObjectStore,
  CloudflareWorkflowPort,
  createCloudflareRuntime,
} = require("../.test-dist/runtime/cloudflare.js");

function d1Result(results = [], meta = {}) {
  return { success: true, results, meta };
}

function fakeD1() {
  const calls = [];
  const statement = (sql, values = []) => ({
    bind(...nextValues) {
      calls.push(["bind", sql, nextValues]);
      return statement(sql, nextValues);
    },
    async first(column) {
      calls.push(["first", sql, values, column]);
      return column ? "column-value" : { value: 7 };
    },
    async all() {
      calls.push(["all", sql, values]);
      return d1Result([{ value: 7 }], { rows_read: 1 });
    },
    async run() {
      calls.push(["run", sql, values]);
      return d1Result([], { changes: 1 });
    },
    async raw() {
      calls.push(["raw", sql, values]);
      return [[7]];
    },
  });
  return {
    calls,
    prepare(sql) {
      calls.push(["prepare", sql]);
      return statement(sql);
    },
    async batch(statements) {
      calls.push(["batch", statements.length]);
      return statements.map(() => d1Result([], { changes: 1 }));
    },
    async exec(sql) {
      calls.push(["exec", sql]);
      return { count: 2, duration: 3.5 };
    },
  };
}

function queue(name) {
  const calls = [];
  const metrics = { backlogCount: 0, backlogBytes: 0 };
  return {
    name,
    calls,
    async send(body, options) {
      calls.push(["send", body, options]);
      return { metadata: { metrics } };
    },
    async sendBatch(messages, options) {
      calls.push(["sendBatch", [...messages], options]);
      return { metadata: { metrics } };
    },
    async metrics() {
      calls.push(["metrics"]);
      return metrics;
    },
  };
}

function workflow(name) {
  const calls = [];
  const instance = (id) => ({
    id,
    async status() { return { status: "queued" }; },
    async terminate() { calls.push(["terminate", id]); },
  });
  return {
    calls,
    async create(input) {
      calls.push(["create", input]);
      return instance(input.id ?? `${name}-generated`);
    },
    async get(id) {
      calls.push(["get", id]);
      return instance(id);
    },
  };
}

function fakeEnv() {
  const DB = fakeD1();
  const INGEST_QUEUE = queue("primary");
  const INGEST_DLQ = queue("dlq");
  const INGEST_QUARANTINE = queue("quarantine");
  const MISSION_WORKFLOW = workflow("mission");
  const MEMORY_WORKFLOW = workflow("memory");
  const ROUTINE_WORKFLOW = workflow("routine");
  const assetCalls = [];
  return {
    DB,
    EVIDENCE: {
      async put() { return { key: "object" }; },
      async get() { return null; },
      async delete() {},
      async head() { return null; },
      async list() { return { objects: [], truncated: false }; },
    },
    INGEST_QUEUE,
    INGEST_DLQ,
    INGEST_QUARANTINE,
    MISSION_WORKFLOW,
    MEMORY_WORKFLOW,
    ROUTINE_WORKFLOW,
    ASSETS: {
      async fetch(request) {
        assetCalls.push(request.url);
        return new Response("asset");
      },
    },
    PUBLIC_BASE_URL: "https://example.invalid",
    DRIFTGLASS_SECRET: "test-only-secret",
    assetCalls,
  };
}

test("runtime profiles are exact and keep local-canonical modes experimental", () => {
  assert.deepEqual(RUNTIME_PROFILES, ["cloudflare", "selfhost", "hybrid-local-canonical"]);
  assert.equal(parseRuntimeProfile("cloudflare"), "cloudflare");
  assert.throws(() => parseRuntimeProfile("Cloudflare"), RuntimeProfileError);
  assert.throws(() => parseRuntimeProfile("local"), RuntimeProfileError);
  assert.throws(() => runtimeProfileDefinition("local"), RuntimeProfileError);
  assert.equal(describeRuntimeProfile(undefined).id, "cloudflare");
  assert.throws(() => describeRuntimeProfile("selfhost"), /experimental/);
  assert.equal(describeRuntimeProfile("selfhost", { includeExperimental: true }).canonicalState, "local");
  assert.equal(
    describeRuntimeProfile("hybrid-local-canonical", { includeExperimental: true }).canonicalState,
    "local",
  );
  assert.equal(runtimeProfileDefinition("selfhost").availability, "experimental-preview");
  assert.equal(Object.isFrozen(runtimeProfileDefinition("cloudflare")), true);
  assert.equal(Object.isFrozen(runtimeProfileDefinition("hybrid-local-canonical").optionalProjections), true);
});

test("profile description cannot activate a local-canonical service factory", () => {
  const hybrid = describeRuntimeProfile("hybrid-local-canonical", { includeExperimental: true });
  assert.equal(hybrid.canonicalState, "local");
  const neutral = require("../.test-dist/runtime/index.js");
  assert.equal(neutral.createSelfhostRuntime, undefined);
  assert.equal(neutral.verifyCanonicalAuthorityReceipt, undefined);
});

test("Cloudflare D1 façade preserves prepare, bind, result, batch, and exec behavior", async () => {
  const native = fakeD1();
  const database = new CloudflareD1Database(native);
  const statement = database.prepare("SELECT ? AS value").bind(7);
  assert.deepEqual(await statement.first(), { value: 7 });
  assert.equal(await statement.first("value"), "column-value");
  assert.deepEqual((await statement.all()).results, [{ value: 7 }]);
  assert.equal((await statement.run()).meta.changes, 1);
  assert.deepEqual(await statement.raw(), [[7]]);
  assert.equal((await database.batch([statement]))[0].meta.changes, 1);
  assert.deepEqual(await database.exec("PRAGMA optimize"), {
    success: true,
    results: [],
    meta: { count: 2, duration: 3.5 },
  });
  await assert.rejects(
    database.batch([{ bind() { return this; } }]),
    /statements prepared by the same runtime adapter/,
  );
  const other = new CloudflareD1Database(fakeD1());
  await assert.rejects(
    database.batch([other.prepare("SELECT 1")]),
    /statements prepared by the same runtime adapter/,
  );
});

test("conditional object writes report a failed precondition instead of false success", async () => {
  const writes = [];
  const stored = new CloudflareR2ObjectStore({
    async put(key, value, options) {
      writes.push({ key, value, options });
      return { key, etag: "saved" };
    },
  });
  assert.deepEqual(await stored.put("one", "body"), { stored: true, etag: "saved" });

  const rejected = new CloudflareR2ObjectStore({ async put() { return null; } });
  assert.deepEqual(
    await rejected.put("one", "body", { onlyIf: { etagDoesNotMatch: "*" } }),
    { stored: false },
  );
  assert.equal(writes.length, 1);
});

test("Cloudflare ingress is healthy only when the façade has a concrete public URL", async () => {
  assert.equal((await new CloudflareIngressPort(null).health()).ok, false);
  assert.deepEqual(await new CloudflareIngressPort("https://example.invalid").health(), {
    ok: true,
    mode: "workers-https",
    publicUrl: "https://example.invalid",
  });
});

test("Workflow status preserves current states and normalizes future platform values", async () => {
  const current = ["queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause", "unknown"];
  for (const status of [...current, "future-platform-state"]) {
    const workflow = new CloudflareWorkflowPort({
      async create() {
        return {
          id: status,
          async status() { return { status }; },
          async terminate() {},
        };
      },
    });
    const instance = await workflow.create({ id: status });
    assert.equal((await instance.status()).status, current.includes(status) ? status : "unknown");
  }
});

test("the neutral runtime barrel does not load Cloudflare adapters", () => {
  const neutral = require("../.test-dist/runtime/index.js");
  assert.equal(neutral.createCloudflareRuntime, undefined);
  assert.equal(typeof neutral.describeRuntimeProfile, "function");
});

test("Cloudflare runtime factory is additive, canonical, and delegates native bindings", async () => {
  const env = fakeEnv();
  assert.throws(
    () => createCloudflareRuntime(env, { profile: "selfhost" }),
    /unavailable; Cloudflare is the sole current writable factory/,
  );
  const runtime = createCloudflareRuntime(env);

  assert.equal(runtime.profile, "cloudflare");
  assert.equal(runtime.canonicalState, "cloudflare");
  assert.equal(runtime.experimental, false);
  assert.deepEqual(runtime.authority, {
    mode: "platform-binding",
    profile: "cloudflare",
    canonicalState: "cloudflare",
    writable: true,
  });
  assert.equal(runtime.capabilities.database.platformAvailable, true);
  assert.equal(runtime.capabilities.database.facadeIntegrated, true);
  assert.equal(runtime.capabilities.workspace.platformAvailable, false);
  assert.equal(runtime.capabilities.workspace.facadeIntegrated, false);
  assert.equal(runtime.capabilities.workspace.requiredForProfile, true);
  assert.equal(runtime.capabilities.workflows.requiredForProfile, true);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.queues), true);
  assert.equal(runtime.workspace, undefined);
  assert.equal(await runtime.secrets.get("DRIFTGLASS_SECRET"), "test-only-secret");
  assert.equal(await runtime.secrets.get("DB"), null, "non-string bindings are not exposed as secrets");
  assert.equal(await runtime.secrets.get("PUBLIC_BASE_URL"), null, "public string configuration is not exposed as a secret");
  assert.equal(runtime.secrets.mutable, false);
  assert.equal(await runtime.ingress.publicUrl(), "https://example.invalid");

  await runtime.queues.ingest.send({ id: "one" }, { contentType: "json" });
  await runtime.queues.deadLetter.sendBatch(
    [{ body: { id: "two" }, contentType: "json" }],
    { delaySeconds: 3 },
  );
  assert.equal(env.INGEST_QUEUE.calls[0][0], "send");
  assert.equal(env.INGEST_DLQ.calls[0][0], "sendBatch");
  assert.deepEqual(env.INGEST_DLQ.calls[0][1], [{ body: { id: "two" }, contentType: "json" }]);
  assert.deepEqual(env.INGEST_DLQ.calls[0][2], { delaySeconds: 3 });

  const instance = await runtime.workflows.mission.create({ id: "mission-1", params: { missionId: "m" } });
  assert.equal(instance.id, "mission-1");
  assert.equal((await instance.status()).status, "queued");
  await instance.cancel();
  assert.deepEqual(env.MISSION_WORKFLOW.calls.map((entry) => entry[0]), ["create", "terminate"]);

  const asset = await runtime.assets.fetch(new Request("https://example.invalid/app.js"));
  assert.equal(await asset.text(), "asset");
  assert.deepEqual(env.assetCalls, ["https://example.invalid/app.js"]);
});
