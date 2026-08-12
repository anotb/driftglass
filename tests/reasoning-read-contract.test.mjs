import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

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

function routineDatabase() {
  const state = { prepares: 0, writes: 0, row: null };
  return {
    state,
    db: {
      prepare(query) {
        state.prepares += 1;
        let values = [];
        return {
          bind(...bound) {
            values = bound;
            return this;
          },
          async run() {
            assert.match(query, /INSERT INTO intelligence_routines/);
            state.writes += 1;
            state.row = {
              id: values[0],
              pack_id: values[1],
              mission_id: values[2],
              name: values[3],
              description: values[4],
              definition_json: values[5],
              enabled: values[6],
              schedule_minutes: values[7],
              next_run_at: values[8],
              last_run_at: null,
              created_at: values[9],
              updated_at: values[10],
            };
            return { success: true, meta: { changes: 1 } };
          },
          async first() {
            assert.match(query, /SELECT \* FROM intelligence_routines WHERE id = \?/);
            return state.row?.id === values[0] ? state.row : null;
          },
        };
      },
    },
  };
}

function routineRequest(steps) {
  return new Request("https://driftglass.invalid/api/routines", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "routine-api-contract",
      name: "Routine API contract",
      trigger: "scheduled",
      scheduleMinutes: 360,
      steps,
    }),
  });
}

test("POST routines rejects unsettled evidence consumers before any database write", async () => {
  const { db, state } = routineDatabase();
  await assert.rejects(
    handleV09Api(routineRequest([
      { action: "refresh-sources", sourceIds: ["docs"] },
      { action: "rebuild-mission" },
    ]), { DB: db }, {}),
    (error) => error?.status === 400 && /requires wait-for-ingest after refresh-sources/.test(error.message),
  );
  assert.equal(state.prepares, 0);
  assert.equal(state.writes, 0);
  assert.equal(state.row, null);
});

test("POST routines persists a canonically settled refresh sequence", async () => {
  const { db, state } = routineDatabase();
  const response = await handleV09Api(routineRequest([
    { action: "refresh-sources", sourceIds: ["docs"] },
    { action: "wait-for-ingest", waitSeconds: 45 },
    { action: "rebuild-mission" },
  ]), { DB: db }, {});

  assert.equal(response.status, 201);
  assert.equal(state.writes, 1);
  assert.ok(state.row);
  const persisted = JSON.parse(state.row.definition_json);
  assert.deepEqual(persisted.steps.map((step) => step.action), [
    "refresh-sources", "wait-for-ingest", "rebuild-mission",
  ]);
  const body = await response.json();
  assert.equal(body.routine.id, "routine-api-contract");
});

test("GET next reasoning task returns queued state without materializing a receipt", async () => {
  const queued = {
    id: "task-queued",
    scope_kind: "global",
    scope_id: null,
    task: "investigate",
    target: "chatgpt",
    objective: "Resolve the most consequential evidence gap.",
    priority: 0.8,
    reason: "New contradictory evidence arrived.",
    status: "queued",
    dedupe_key: "queued-contract-test",
    receipt_id: null,
    due_at: null,
    expires_at: "2099-01-01T00:00:00.000Z",
    claimed_by: null,
    claimed_at: null,
    completed_at: null,
    last_error: null,
    created_at: "2026-08-07T00:00:00.000Z",
    updated_at: "2026-08-07T00:00:00.000Z",
  };
  const queries = [];
  const env = {
    DB: {
      prepare(query) {
        queries.push(query);
        return {
          bind() {
            return this;
          },
          async all() {
            return { success: true, results: [queued], meta: {} };
          },
          async first() {
            assert.fail("read-only GET attempted a materialization lookup");
          },
          async run() {
            assert.fail("read-only GET attempted a database write");
          },
        };
      },
    },
  };

  const response = await handleV09Api(
    new Request("https://driftglass.invalid/api/reasoning/tasks/next"),
    env,
    {},
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.task.id, queued.id);
  assert.equal(body.task.status, "queued");
  assert.equal(body.receipt, null);
  assert.equal(body.receiptState, "not-materialized");
  assert.match(body.prompt, /Resolve the most consequential evidence gap/);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^SELECT \* FROM reasoning_tasks/);
});

test("the public contract identifies GET inspection and POST materialization separately", async () => {
  const spec = JSON.parse(await readFile(new URL("../public/openapi.json", import.meta.url), "utf8"));
  const inspect = spec.paths["/api/reasoning/tasks/next"].get;
  const materialize = spec.paths["/api/reasoning/tasks/{taskId}/materialize"].post;

  assert.match(inspect.description, /strictly read-only/i);
  assert.match(inspect.description, /without creating an Evidence-State Receipt/i);
  assert.match(materialize.summary, /materialize/i);
});

test("briefing and Computer read surfaces do not call persistence or synchronization paths", async () => {
  const [compactMcp, operationsMcp, packets, computer, api] = await Promise.all([
    readFile(new URL("../src/reasoning-mcp.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/mcp.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/public-routes.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/mission-computer.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/api.ts", import.meta.url), "utf8"),
  ]);

  assert.match(compactMcp, /latestOrBuildBriefing/);
  assert.match(operationsMcp, /latestOrBuildBriefing/);
  assert.match(packets, /latestOrBuildBriefing/);
  assert.doesNotMatch(`${compactMcp}\n${packets}`, /latestOrGenerateBriefing/);

  const ensureStart = computer.indexOf("export async function ensureMissionComputer");
  const ensureEnd = computer.indexOf("export async function readMissionComputerFile", ensureStart);
  const ensure = computer.slice(ensureStart, ensureEnd);
  assert.match(ensure, /getMissionComputerSummary/);
  assert.doesNotMatch(ensure, /syncMissionComputer/);

  const openStart = operationsMcp.indexOf('"open_mission_computer"');
  const openEnd = operationsMcp.indexOf('"sync_mission_computer"', openStart);
  const open = operationsMcp.slice(openStart, openEnd);
  assert.match(open, /readOnlyAnnotations/);
  assert.doesNotMatch(open, /syncMissionComputer|sync:\s*z\.boolean/);

  const syncStart = operationsMcp.indexOf('"sync_mission_computer"');
  const syncEnd = operationsMcp.indexOf('"read_mission_file"', syncStart);
  const sync = operationsMcp.slice(syncStart, syncEnd);
  assert.match(sync, /writeAnnotations/);
  assert.match(sync, /requestMissionComputerSync/);

  assert.match(api, /launchMissionMatchMaintenance\(env, mission\.id, "mission-created"\)/);
});
