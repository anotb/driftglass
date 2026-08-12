import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
let handleV09Api;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "cloudflare:workers") {
      return {
        DurableObject: class DurableObject {},
        WorkflowEntrypoint: class WorkflowEntrypoint {},
        tracing: { trace: (_name, operation) => operation },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ handleV09Api } = require("../.test-dist/v09-api.js"));
} finally {
  Module._load = originalLoad;
}
const { HttpError } = require("../.test-dist/utils.js");

function databaseReturning(results, calls) {
  return {
    prepare(query) {
      const call = { query, bindings: [] };
      calls.push(call);
      return {
        bind(...bindings) {
          call.bindings = bindings;
          return this;
        },
        async all() {
          return { success: true, results, meta: {} };
        },
      };
    },
  };
}

test("GET evidence lineage preserves the unfiltered aggregate response", async () => {
  const calls = [];
  const summary = [{ relation: "origin", independent: 1, count: 3 }];
  const response = await handleV09Api(
    new Request("https://driftglass.invalid/api/evidence/lineage"),
    { DB: databaseReturning(summary, calls) },
    {},
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, summary });
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /GROUP BY relation, independent/);
  assert.deepEqual(calls[0].bindings, []);
});

test("GET evidence lineage returns bounded detailed rows for combined filters", async () => {
  const calls = [];
  const record = {
    item_id: "item-1",
    story_id: "story one",
    family_key: "github:owner/repo",
    origin_item_id: null,
    origin_family_key: null,
    relation: "origin",
    title_similarity: 0,
    body_similarity: 0,
    independent: 1,
    rationale: "First evidence item in this Story cluster.",
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
  };
  const response = await handleV09Api(
    new Request("https://driftglass.invalid/api/evidence/lineage?storyId=%20story%20one%20&familyKey=github%3Aowner%2Frepo&limit=7"),
    { DB: databaseReturning([record], calls) },
    {},
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    filters: { storyId: "story one", familyKey: "github:owner/repo", limit: 7 },
    lineage: [record],
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /WHERE story_id = \? AND family_key = \?/);
  assert.match(calls[0].query, /ORDER BY created_at ASC LIMIT \?/);
  assert.deepEqual(calls[0].bindings, ["story one", "github:owner/repo", 7]);
});

test("GET evidence lineage treats limit alone as a detailed bounded read", async () => {
  const calls = [];
  const response = await handleV09Api(
    new Request("https://driftglass.invalid/api/evidence/lineage?limit=1"),
    { DB: databaseReturning([], calls) },
    {},
  );

  assert.deepEqual(await response.json(), {
    ok: true,
    filters: { limit: 1 },
    lineage: [],
  });
  assert.doesNotMatch(calls[0].query, / WHERE /);
  assert.deepEqual(calls[0].bindings, [1]);
});

for (const query of [
  "storyId=",
  "storyId=one&storyId=two",
  "familyKey=%00bad",
  "limit=",
  "limit=0",
  "limit=501",
  "limit=1.5",
  "limit=1e2",
  "limit=abc",
]) {
  test(`GET evidence lineage rejects invalid filter ${query}`, async () => {
    let prepareCalls = 0;
    const env = {
      DB: {
        prepare() {
          prepareCalls += 1;
          assert.fail("invalid lineage filters must fail before database access");
        },
      },
    };

    await assert.rejects(
      () => handleV09Api(
        new Request(`https://driftglass.invalid/api/evidence/lineage?${query}`),
        env,
        {},
      ),
      (error) => error instanceof HttpError && error.status === 400,
    );
    assert.equal(prepareCalls, 0);
  });
}
