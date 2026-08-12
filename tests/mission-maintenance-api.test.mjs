import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
const ownerSecret = "test-secret".repeat(3);

let handleApi;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "cloudflare:workers") {
      return {
        DurableObject: class DurableObject {},
        WorkflowEntrypoint: class WorkflowEntrypoint {},
        WorkerEntrypoint: class WorkerEntrypoint {},
        tracing: {
          enterSpan: async (_name, operation) => operation({ setAttribute() {}, setStatus() {} }),
          trace: (_name, operation) => operation,
        },
      };
    }
    if (request === "@cloudflare/computer") {
      return {
        getWorkspace() {},
        withWorkspace(Base) { return class WorkspaceTestDouble extends Base {}; },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ handleApi } = require("../.test-dist/api.js"));
} finally {
  Module._load = originalLoad;
}

function request(path, init = {}) {
  return new Request(`https://driftglass.invalid${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ownerSecret}`, ...(init.headers ?? {}) },
  });
}

function budgetDb() {
  let units = 0;
  const queries = [];
  return {
    queries,
    prepare(query) {
      queries.push(query);
      const statement = {
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async all() {
          return { success: true, results: [], meta: {} };
        },
        async run() {
          units += Number(this.values[2] ?? 0);
          return { success: true, results: [], meta: { changes: 1 } };
        },
        async first() {
          return { units };
        },
      };
      return statement;
    },
  };
}

test("manual rebuild reserves maintenance and queues a fresh Workflow", async () => {
  const creates = [];
  const db = budgetDb();
  const env = {
    DRIFTGLASS_SECRET: ownerSecret,
    DB: db,
    MISSION_WORKFLOW: {
      async create(input) {
        creates.push(input);
        return { id: input.id };
      },
    },
  };

  const response = await handleApi(
    request("/api/missions/mission-scale/rebuild", { method: "POST", body: "{}" }),
    env,
    { exports: {}, waitUntil() {} },
  );
  const payload = await response.json();

  assert.equal(response.status, 202);
  assert.equal(db.queries.length, 3);
  assert.ok(db.queries.every((query) => /settings|usage_daily/.test(query)), "the route only reserves budget before dispatch");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].params, {
    mode: "match-maintenance",
    missionId: "mission-scale",
    reason: "mission-rebuilt",
  });
  assert.deepEqual(payload, {
    ok: true,
    matchMaintenance: {
      status: "queued",
      workflowId: creates[0].id,
      missionId: "mission-scale",
    },
  });
});

test("Mission writes reject terms and source scopes larger than the matcher contract", async () => {
  const env = {
    DRIFTGLASS_SECRET: ownerSecret,
    DB: { prepare() { throw new Error("validation must run before D1"); } },
    MISSION_WORKFLOW: { async create() { throw new Error("validation must run before Workflow dispatch"); } },
  };
  for (const body of [
    { name: "Oversized term", terms: ["x".repeat(201)] },
    { name: "Oversized scope", sourceScope: ["x".repeat(201)] },
  ]) {
    await assert.rejects(
      handleApi(
        request("/api/missions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        { exports: {}, waitUntil() {} },
      ),
      /at most 200 characters/,
    );
  }
});

test("dashboard and OpenAPI describe queued Mission maintenance", async () => {
  const [app, openapiRaw] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/openapi.json", import.meta.url), "utf8"),
  ]);
  const openapi = JSON.parse(openapiRaw);
  const rebuild = openapi.paths["/api/missions/{missionId}/rebuild"];

  assert.match(app, /mission-rebuild[\s\S]*Mission update started/);
  assert.doesNotMatch(app, /toast\("Mission rebuilt"\)/);
  assert.match(app, /Mission created\. Checking sources\./);
  assert.doesNotMatch(app, /Mission created and backfill started/);
  assert.ok(rebuild.get);
  assert.ok(rebuild.post.responses["202"]);
  assert.ok(rebuild.post.responses["200"]);
  assert.ok(openapi.paths["/api/missions"].post.responses["202"]);
  assert.ok(openapi.paths["/api/missions"].post.responses["201"]);
  assert.ok(openapi.paths["/api/missions/{missionId}"].put.responses["202"]);
  assert.ok(openapi.paths["/api/missions/{missionId}"].put.responses["200"]);
});
