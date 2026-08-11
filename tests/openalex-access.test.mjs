import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assertOpenAlexConfigHasNoEmbeddedSecret,
  collectOpenAlex,
  openAlexAccessStatus,
} = require("../.test-dist/sources/openalex.js");
const { upsertSource } = require("../.test-dist/db.js");

const OPENALEX_KEY = "openalex-test-secret-do-not-expose";

function source(config) {
  return {
    id: "openalex-access-test",
    name: "OpenAlex access test",
    kind: "openalex",
    config_json: JSON.stringify(config),
    enabled: 1,
    schedule_minutes: 60,
    weight: 1,
    last_run_at: null,
    last_success_at: null,
    last_error: null,
    health_score: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function errorCode(error) {
  return error?.code ?? error?.details?.code;
}

function errorRetryAfterSeconds(error) {
  const value = error?.retryAfterSeconds ?? error?.details?.retryAfterSeconds;
  return value === undefined ? undefined : Number(value);
}

function errorSurface(error) {
  return [
    error?.name,
    error?.message,
    error?.stack,
    error?.cause instanceof Error ? error.cause.message : error?.cause,
    JSON.stringify(error),
  ].filter(Boolean).join("\n");
}

async function capturedRejection(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected operation to reject");
}

test("OpenAlex search and direct Work lookup require the runtime key before fetch", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run without OPENALEX_API_KEY");
  };

  for (const config of [
    { query: "personal intelligence" },
    { workIds: ["W2741809807"] },
  ]) {
    const access = openAlexAccessStatus(config);
    assert.equal(access.runnable, false);
    assert.equal(access.authenticated, false);
    assert.equal(access.binding, "OPENALEX_API_KEY");

    const error = await capturedRejection(() => collectOpenAlex(source(config), {}));
    assert.equal(errorCode(error), "OPENALEX_API_KEY_REQUIRED");
    assert.match(error.message, /OPENALEX_API_KEY/);
    assert.doesNotMatch(errorSurface(error), /api_key=/i);
  }

  assert.equal(fetchCalls, 0, "credential preflight must happen before any network request");
});

test("OpenAlex uses a strict source-config allowlist", () => {
  const validSearch = {
    query: "personal intelligence",
    concepts: ["human computer interaction"],
    limit: 20,
    sort: "publication_date:desc",
    fromPublicationDate: "2026-01-01",
    openAccessOnly: true,
  };
  assert.doesNotThrow(() => assertOpenAlexConfigHasNoEmbeddedSecret(validSearch));
  assert.doesNotThrow(() => assertOpenAlexConfigHasNoEmbeddedSecret({ workIds: ["W2741809807"] }));

  for (const config of [
    { query: "personal intelligence", apiKey: OPENALEX_KEY },
    { query: "personal intelligence", OPENALEX_API_KEY: OPENALEX_KEY },
    { query: "personal intelligence", credentials: { apiKey: OPENALEX_KEY } },
    { query: "personal intelligence", futureOption: true },
  ]) {
    assert.throws(
      () => assertOpenAlexConfigHasNoEmbeddedSecret(config),
      (error) => {
        assert.doesNotMatch(errorSurface(error), new RegExp(OPENALEX_KEY, "i"));
        assert.match(error.message, /configuration|source|allowed|credential|secret/i);
        return true;
      },
    );
  }
});

test("the final source upsert barrier rejects OpenAlex credentials before D1", async () => {
  let prepareCalls = 0;
  const db = {
    prepare() {
      prepareCalls += 1;
      throw new Error("D1 must not be reached for rejected OpenAlex config");
    },
  };
  const error = await capturedRejection(() => upsertSource(db, {
    id: "openalex-final-barrier",
    name: "OpenAlex final barrier",
    kind: "openalex",
    config: { query: "personal intelligence", credentials: { apiKey: OPENALEX_KEY } },
  }));
  assert.equal(prepareCalls, 0);
  assert.match(error.message, /unsupported|credential|secret/i);
  assert.doesNotMatch(errorSurface(error), new RegExp(OPENALEX_KEY, "i"));
});

test("runSource checks the OpenAlex prerequisite before durable or budget work", async () => {
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function driftglassOpenAlexTestLoad(request, parent, isMain) {
    if (request === "cloudflare:workers") {
      return { tracing: { enterSpan(_name, callback) { return callback({ setAttribute() {} }); } } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let durableReads = 0;
  const env = {
    DB: new Proxy({}, {
      get() {
        durableReads += 1;
        throw new Error("durable state must not be touched before credential preflight");
      },
    }),
  };
  try {
    const { runSource } = require("../.test-dist/sources/registry.js");
    const error = await capturedRejection(() => runSource(source({ query: "personal intelligence" }), env));
    assert.equal(errorCode(error), "OPENALEX_API_KEY_REQUIRED");
    assert.equal(durableReads, 0);
  } finally {
    Module._load = originalLoad;
  }
});

test("keyed OpenAlex search and direct lookup attach api_key without returning it", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requested = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requested.push(url);
    if (url.pathname === "/works") {
      return new Response(JSON.stringify({
        meta: {
          count: 1,
          db_response_time_ms: 2,
          page: 1,
          per_page: 20,
          cost_usd: 0.001,
          api_key: OPENALEX_KEY,
          opaque_upstream_field: OPENALEX_KEY,
        },
        results: [{ id: "https://openalex.org/W2741809807", title: "Search result" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "https://openalex.org/W2741809807",
      title: "Direct result",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const searchResult = await collectOpenAlex(
    source({ query: "personal intelligence", limit: 20 }),
    { OPENALEX_API_KEY: OPENALEX_KEY },
  );
  const directResult = await collectOpenAlex(
    source({ workIds: ["W2741809807"] }),
    { OPENALEX_API_KEY: OPENALEX_KEY },
  );

  assert.equal(requested.length, 2);
  for (const url of requested) assert.equal(url.searchParams.get("api_key"), OPENALEX_KEY);
  assert.equal(searchResult.items.length, 1);
  assert.equal(directResult.items.length, 1);
  assert.doesNotMatch(JSON.stringify(searchResult), new RegExp(OPENALEX_KEY, "i"));
  assert.doesNotMatch(JSON.stringify(directResult), new RegExp(OPENALEX_KEY, "i"));
  assert.equal(searchResult.details?.meta?.api_key, undefined);
  assert.equal(searchResult.details?.meta?.opaque_upstream_field, undefined);
});

test("OpenAlex 429 errors are typed, safe, and expose only bounded retry guidance", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(`upstream echoed ${OPENALEX_KEY}`, {
    status: 429,
    headers: {
      "content-type": "text/plain",
      "retry-after": "999999999",
      "x-ratelimit-reset": "999999998",
    },
  });

  const error = await capturedRejection(() => collectOpenAlex(
    source({ query: "personal intelligence" }),
    { OPENALEX_API_KEY: OPENALEX_KEY },
  ));
  assert.equal(errorCode(error), "OPENALEX_RATE_LIMITED");
  assert.equal(error.status, 429);
  assert.match(error.message, /OpenAlex|allowance|rate|retry|usage/i);
  assert.doesNotMatch(errorSurface(error), new RegExp(`${OPENALEX_KEY}|api_key=`, "i"));
  const retryAfterSeconds = errorRetryAfterSeconds(error);
  if (retryAfterSeconds !== undefined) {
    assert.ok(Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 1 && retryAfterSeconds <= 86_400);
  }
});

test("OpenAlex 401 and 403 errors are typed and never echo the key or upstream body", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  for (const status of [401, 403]) {
    globalThis.fetch = async () => new Response(`rejected ${OPENALEX_KEY}`, {
      status,
      headers: { "content-type": "text/plain" },
    });
    const error = await capturedRejection(() => collectOpenAlex(
      source({ query: "personal intelligence" }),
      { OPENALEX_API_KEY: OPENALEX_KEY },
    ));
    assert.equal(errorCode(error), "OPENALEX_API_KEY_REJECTED");
    assert.equal(error.status, status);
    assert.match(error.message, /OpenAlex|key|credential|secret/i);
    assert.doesNotMatch(errorSurface(error), new RegExp(`${OPENALEX_KEY}|api_key=`, "i"));
  }
});
