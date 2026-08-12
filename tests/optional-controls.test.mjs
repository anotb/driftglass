import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const {
  AI_SEARCH_ENABLED_SETTING,
  AISearchDisabledError,
  aiSearchStatus,
  semanticSearch,
  setupAISearch,
  syncAISearch,
  syncAISearchIfEnabled,
} = require("../.test-dist/ai-search.js");
const { assertSecret } = require("../.test-dist/security.js");
const { toErrorResponse } = require("../.test-dist/utils.js");

class SettingsStatement {
  constructor(database, query) {
    this.database = database;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (!this.query.includes("SELECT value FROM settings")) throw new Error(`Unexpected first query: ${this.query}`);
    const value = this.database.settings.get(String(this.values[0]));
    return value === undefined ? null : { value };
  }

  async run() {
    if (!this.query.includes("INSERT INTO settings")) throw new Error(`Unexpected run query: ${this.query}`);
    this.database.settings.set(String(this.values[0]), String(this.values[1]));
    return { success: true, results: [], meta: { changes: 1 } };
  }
}

class SettingsDatabase {
  constructor(initial = {}) {
    this.settings = new Map(Object.entries(initial));
  }

  prepare(query) {
    return new SettingsStatement(this, query);
  }
}

class RecordingAISearchNamespace {
  constructor(instanceIds = []) {
    this.instanceIds = new Set(instanceIds);
    this.listCalls = 0;
    this.createCalls = [];
    this.getCalls = 0;
    this.instance = {
      stats: async () => ({ items: 0 }),
      items: {},
      search: async () => ({ search_query: "", chunks: [] }),
    };
  }

  async list() {
    this.listCalls += 1;
    return { result: [...this.instanceIds].map((id) => ({ id })) };
  }

  async create(config) {
    this.createCalls.push(config);
    this.instanceIds.add(config.id);
  }

  get() {
    this.getCalls += 1;
    return this.instance;
  }
}

function env({ settings = {}, instanceIds = [] } = {}) {
  return {
    DB: new SettingsDatabase(settings),
    AI_SEARCH: new RecordingAISearchNamespace(instanceIds),
  };
}

test("AI Search status separates binding availability, explicit enablement, and instance configuration", async () => {
  const configuredButDisabled = env({ instanceIds: ["driftglass-intelligence"] });
  const status = await aiSearchStatus(configuredButDisabled);

  assert.equal(status.available, true);
  assert.equal(status.enabled, false);
  assert.equal(status.configured, true);
  assert.equal(configuredButDisabled.AI_SEARCH.createCalls.length, 0);

  const unavailable = await aiSearchStatus({ DB: new SettingsDatabase(), AI_SEARCH: undefined });
  assert.deepEqual(
    { available: unavailable.available, enabled: unavailable.enabled, configured: unavailable.configured },
    { available: false, enabled: false, configured: false },
  );
});

test("disabled semantic reads, manual syncs, and automatic hooks never create or open an AI Search instance", async () => {
  const disabled = env();

  await assert.rejects(
    semanticSearch(disabled, "durable agent memory"),
    (error) => error instanceof AISearchDisabledError && error.code === "AI_SEARCH_DISABLED" && error.status === 409,
  );
  await assert.rejects(syncAISearch(disabled), (error) => error instanceof AISearchDisabledError);
  assert.equal(await syncAISearchIfEnabled(disabled), null);

  assert.equal(disabled.AI_SEARCH.listCalls, 0);
  assert.equal(disabled.AI_SEARCH.getCalls, 0);
  assert.equal(disabled.AI_SEARCH.createCalls.length, 0);
});

test("explicit setup is the only path that creates and enables AI Search", async () => {
  const target = env();

  await setupAISearch(target);
  assert.equal(target.DB.settings.get(AI_SEARCH_ENABLED_SETTING), "enabled");
  assert.equal(target.AI_SEARCH.createCalls.length, 1);
  assert.equal(target.AI_SEARCH.createCalls[0].chunk_overlap, 15);

  const status = await aiSearchStatus(target);
  assert.equal(status.enabled, true);
  assert.equal(status.configured, true);

  await setupAISearch(target);
  assert.equal(target.AI_SEARCH.createCalls.length, 1, "setup reuses an existing instance");
});

test("disabled AI Search produces a stable typed HTTP error", async () => {
  const response = toErrorResponse(new AISearchDisabledError());
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "AI_SEARCH_DISABLED",
    error: "AI Search is disabled. Enable it explicitly with POST /api/ai-search/setup before searching or syncing.",
    details: {
      code: "AI_SEARCH_DISABLED",
      feature: "ai_search",
      setup: "POST /api/ai-search/setup",
    },
  });
});

test("checked-in owner-secret placeholders are intentionally invalid", async () => {
  for (const file of [".deploy-secrets.example", ".dev.vars.example"]) {
    const raw = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const secret = raw.match(/^DRIFTGLASS_SECRET=(.*)$/m)?.[1] ?? "";
    assert.throws(() => assertSecret(secret), /placeholder|too short/);
  }
  assert.throws(() => assertSecret("replace-with-a-long-random-secret"), /placeholder/);
  assert.doesNotThrow(() => assertSecret("7b739241ef227c6d132d1ccbf8e26cdd33ee1ed44f01f9f1b9417202e7461384"));
});

test("automatic hooks, readiness, public API docs, and telemetry config preserve the opt-in posture", async () => {
  const [api, index, readiness, specRaw, configRaw] = await Promise.all([
    readFile(new URL("../src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/readiness.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/openapi.json", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ]);
  const spec = JSON.parse(specRaw);
  const config = JSON.parse(configRaw);

  assert.match(api, /syncAISearchIfEnabled/);
  assert.doesNotMatch(api, /env\.AI_SEARCH\s*\?\s*syncAISearch/);
  assert.match(index, /syncAISearchIfEnabled/);
  assert.match(readiness, /semanticMemory\.enabled && semanticMemory\.configured/);
  assert.match(spec.paths["/api/ai-search/setup"].post.description, /sole creation and enablement path/i);
  assert.match(spec.paths["/api/ai-search/status"].get.description, /availability.*enablement.*configuration/i);
  for (const observability of [config.observability, config.env.staging.observability]) {
    assert.equal(observability.enabled, false);
    assert.equal(observability.logs.enabled, false);
    assert.equal(observability.logs.invocation_logs, false);
    assert.equal(observability.traces.enabled, false);
  }
});
