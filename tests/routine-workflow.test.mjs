import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;

class WorkflowEntrypoint {
  constructor(ctx, env) {
    this.env = env;
    this.ctx = ctx?.exports ? ctx : {
      exports: {
        SourceRunBoundary: {
          async runSource(sourceId, options) {
            const source = await db.getSource(env.DB, sourceId);
            if (!source) {
              return {
                ok: false,
                kind: "unavailable",
                reason: "missing",
                error: { name: "SourceUnavailableError", message: `Source not found: ${sourceId}` },
              };
            }
            const metadata = { name: source.name, kind: source.kind };
            if (source.enabled !== 1) {
              await sourceRegistry.reconcileOrphanedPendingSourceRun(env.DB, source.id);
              return {
                ok: false,
                kind: "unavailable",
                reason: "disabled",
                source: metadata,
                error: { name: "SourceUnavailableError", message: "Source is disabled" },
              };
            }
            const access = sourceAccess.sourceRuntimeAccess(source, env);
            if (!access.runnable) {
              await sourceRegistry.reconcileOrphanedPendingSourceRun(env.DB, source.id);
              return {
                ok: false,
                kind: "unavailable",
                reason: access.code === "OPENALEX_API_KEY_REQUIRED" ? "credential" : "prerequisite",
                source: metadata,
                code: access.code,
                binding: access.openalex?.binding,
                error: { name: "SourceUnavailableError", message: access.detail },
              };
            }
            try {
              return { ok: true, result: await sourceRegistry.runSource(source, env, options), source: metadata };
            } catch (error) {
              return {
                ok: false,
                kind: /too many subrequests/i.test(error instanceof Error ? error.message : String(error)) ? "capacity" : "error",
                error: {
                  name: error instanceof Error ? error.name : "Error",
                  message: error instanceof Error ? error.message : String(error),
                },
              };
            }
          },
        },
      },
    };
  }
}

class DurableObject {
  constructor(_ctx, env) {
    this.env = env;
  }
}

const tracing = {
  trace: (_name, operation) => operation,
  enterSpan: async (_name, operation) => operation({
    setAttribute() {},
    setStatus() {},
  }),
};

let routineWorkflow;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "cloudflare:workers") return {
      WorkflowEntrypoint,
      WorkerEntrypoint: WorkflowEntrypoint,
      DurableObject,
      tracing,
    };
    if (request === "@cloudflare/computer") {
      return {
        getWorkspace() {},
        withWorkspace(Base) { return class WorkspaceTestDouble extends Base {}; },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  routineWorkflow = require("../.test-dist/routine-workflow.js");
} finally {
  Module._load = originalLoad;
}

const db = require("../.test-dist/db.js");
const intelligenceRoutines = require("../.test-dist/intelligence-routines.js");
const missions = require("../.test-dist/missions.js");
const sourceRegistry = require("../.test-dist/sources/registry.js");
const sourceAccess = require("../.test-dist/sources/access.js");
const { IntelligenceRoutineWorkflow, checkpointMemoryStepResult } = routineWorkflow;

function routineRecord(id, definition, scheduleMinutes = 60) {
  return {
    id,
    pack_id: null,
    mission_id: definition.missionId ?? null,
    name: definition.name,
    description: definition.description ?? "",
    definition_json: JSON.stringify(definition),
    enabled: 1,
    schedule_minutes: scheduleMinutes,
    next_run_at: null,
    last_run_at: null,
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:00.000Z",
  };
}

function sourceRecord(id, kind = "hackernews") {
  return {
    id,
    name: `Source ${id}`,
    kind,
    config_json: "{}",
    enabled: 1,
    schedule_minutes: 60,
    weight: 1,
    health_score: 1,
    last_run_at: null,
    last_success_at: null,
    last_error: null,
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:00.000Z",
  };
}

class CachedWorkflowStep {
  constructor(cache = new Map()) {
    this.cache = cache;
    this.doCalls = [];
    this.doConfigs = [];
    this.sleepCalls = [];
  }

  async do(name, configOrCallback, configuredCallback) {
    this.doCalls.push(name);
    if (typeof configOrCallback !== "function") this.doConfigs.push({ name, config: configOrCallback });
    if (this.cache.has(name)) return this.cache.get(name);
    const callback = typeof configOrCallback === "function" ? configOrCallback : configuredCallback;
    const result = await callback();
    this.cache.set(name, result);
    return result;
  }

  async sleep(name, duration) {
    this.sleepCalls.push({ name, duration });
  }
}

function missionWorkflowBinding(starts = []) {
  return {
    async create(input) {
      starts.push(input);
      return { id: input.id };
    },
  };
}

function budgetD1() {
  let units = 0;
  const queries = [];
  return {
    queries,
    get units() { return units; },
    prepare(query) {
      queries.push(query);
      return {
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
    },
  };
}

test("routine replay uses cached initialization and finalization", async () => {
  const originalGetRoutine = db.getIntelligenceRoutine;
  const originalUpdateRun = db.updateIntelligenceRoutineRun;
  const originalAdvanceSchedule = intelligenceRoutines.advanceRoutineSchedule;
  const originalDefinition = {
    id: "replay-routine",
    name: "Replay routine",
    enabled: true,
    scheduleMinutes: 60,
    trigger: "manual",
    steps: [{ id: "original-wait", action: "wait-for-ingest", waitSeconds: 2 }],
  };
  const editedDefinition = {
    ...originalDefinition,
    steps: [{ id: "edited-wait", action: "wait-for-ingest", waitSeconds: 9 }],
  };
  let currentRecord = routineRecord("replay-routine", originalDefinition);
  let routineReads = 0;
  const runUpdates = [];
  const scheduleUpdates = [];

  db.getIntelligenceRoutine = async (_database, routineId) => {
    routineReads += 1;
    assert.equal(routineId, "replay-routine");
    return currentRecord;
  };
  db.updateIntelligenceRoutineRun = async (_database, runId, patch) => {
    runUpdates.push({ runId, patch });
  };
  intelligenceRoutines.advanceRoutineSchedule = async (_database, record) => {
    scheduleUpdates.push({ id: record.id, minutes: record.schedule_minutes });
  };

  try {
    const cache = new Map();
    const event = {
      payload: { runId: "run-replay", routineId: "replay-routine", trigger: "manual" },
      instanceId: "workflow-replay",
      timestamp: new Date("2026-08-09T00:00:00.000Z"),
      workflowName: "routine",
    };
    const firstStep = new CachedWorkflowStep(cache);
    const first = await new IntelligenceRoutineWorkflow({}, { DB: {} }).run(event, firstStep);

    assert.equal(first.status, "complete");
    assert.equal(first.steps[0].id, "original-wait");
    assert.deepEqual(firstStep.doCalls, ["initialize routine", "step 1 · settle sources", "finalize routine"]);
    assert.deepEqual(firstStep.sleepCalls, [{ name: "step 1 · wait", duration: "2 seconds" }]);
    assert.deepEqual(runUpdates.map((update) => update.patch.status), ["running", "complete"]);
    assert.deepEqual(scheduleUpdates, [{ id: "replay-routine", minutes: 60 }]);

    currentRecord = routineRecord("replay-routine", editedDefinition, 15);
    const replayStep = new CachedWorkflowStep(cache);
    const replayed = await new IntelligenceRoutineWorkflow({}, { DB: {} }).run(event, replayStep);

    assert.equal(replayed.status, "complete");
    assert.equal(replayed.steps[0].id, "original-wait", "the cached definition remains the replay plan");
    assert.deepEqual(replayStep.doCalls, ["initialize routine", "step 1 · settle sources", "finalize routine"]);
    assert.deepEqual(replayStep.sleepCalls, [{ name: "step 1 · wait", duration: "2 seconds" }]);
    assert.equal(routineReads, 1, "replay does not reload a mid-run routine edit");
    assert.deepEqual(runUpdates.map((update) => update.patch.status), ["running", "complete"], "replay does not mark a completed run as running");
    assert.deepEqual(scheduleUpdates, [{ id: "replay-routine", minutes: 60 }], "cached finalization does not advance the schedule twice");
  } finally {
    db.getIntelligenceRoutine = originalGetRoutine;
    db.updateIntelligenceRoutineRun = originalUpdateRun;
    intelligenceRoutines.advanceRoutineSchedule = originalAdvanceSchedule;
  }
});

test("initialization failure terminalizes the queued Routine through a cached failure step", async () => {
  const originalGetRoutine = db.getIntelligenceRoutine;
  const originalUpdateRun = db.updateIntelligenceRoutineRun;
  const originalAdvanceSchedule = intelligenceRoutines.advanceRoutineSchedule;
  const runUpdates = [];
  let routineReads = 0;
  db.getIntelligenceRoutine = async () => {
    routineReads += 1;
    return null;
  };
  db.updateIntelligenceRoutineRun = async (_database, runId, patch) => runUpdates.push({ runId, patch });
  intelligenceRoutines.advanceRoutineSchedule = async () => {
    throw new Error("a missing Routine has no schedule to advance");
  };
  const event = {
    payload: { runId: "run-missing-routine", routineId: "removed-routine", trigger: "scheduled" },
    instanceId: "workflow-missing-routine",
    timestamp: new Date("2026-08-09T00:00:00.000Z"),
    workflowName: "routine",
  };

  try {
    const cache = new Map();
    const firstStep = new CachedWorkflowStep(cache);
    await assert.rejects(
      new IntelligenceRoutineWorkflow({}, { DB: {} }).run(event, firstStep),
      /Routine not found: removed-routine/,
    );
    assert.deepEqual(firstStep.doCalls, ["initialize routine", "fail routine"]);
    assert.deepEqual(runUpdates.map((update) => update.patch.status), ["failed"]);
    assert.equal(runUpdates[0].patch.result.steps.length, 0);

    const replayStep = new CachedWorkflowStep(cache);
    await assert.rejects(
      new IntelligenceRoutineWorkflow({}, { DB: {} }).run(event, replayStep),
      /Routine not found: removed-routine/,
    );
    assert.deepEqual(replayStep.doCalls, ["initialize routine", "fail routine"]);
    assert.equal(routineReads, 2, "only the failing initialization reruns");
    assert.deepEqual(runUpdates.map((update) => update.patch.status), ["failed"], "failure persistence is replay-cached");
  } finally {
    db.getIntelligenceRoutine = originalGetRoutine;
    db.updateIntelligenceRoutineRun = originalUpdateRun;
    intelligenceRoutines.advanceRoutineSchedule = originalAdvanceSchedule;
  }
});

test("source-granular refresh exposes credential deferral without misreporting coverage", async () => {
  const originalGetRoutine = db.getIntelligenceRoutine;
  const originalGetSource = db.getSource;
  const originalUpdateRun = db.updateIntelligenceRoutineRun;
  const originalAdvanceSchedule = intelligenceRoutines.advanceRoutineSchedule;
  const originalReconcilePending = sourceRegistry.reconcileOrphanedPendingSourceRun;
  const originalSourceAccess = sourceAccess.sourceRuntimeAccess;
  const originalRunSource = sourceRegistry.runSource;
  const definition = {
    id: "clean-source-routine",
    name: "Clean source routine",
    scheduleMinutes: 60,
    steps: [
      { id: "refresh", action: "refresh-sources", sourceIds: ["github", "github", "openalex", "disabled", "hn"] },
      { id: "refresh", action: "refresh-sources", sourceIds: ["hn"] },
    ],
  };
  const allDeferredDefinition = {
    id: "all-deferred-source-routine",
    name: "All deferred source routine",
    scheduleMinutes: 60,
    steps: [{ id: "refresh", action: "refresh-sources", sourceIds: ["openalex"] }],
  };
  const partialPrefixDefinition = {
    id: "partial-prefix-source-routine",
    name: "Partial prefix source routine",
    scheduleMinutes: 60,
    steps: [{ id: "refresh", action: "refresh-sources", sourceIds: ["prefix"] }],
  };
  const sources = new Map([
    ["github", sourceRecord("github", "github_releases")],
    ["openalex", sourceRecord("openalex", "openalex")],
    ["disabled", { ...sourceRecord("disabled", "hackernews"), enabled: 0 }],
    ["hn", sourceRecord("hn")],
    ["prefix", sourceRecord("prefix", "npm_releases")],
  ]);
  const runUpdates = [];
  const scheduleUpdates = [];
  const sourceCalls = [];
  db.getIntelligenceRoutine = async (_database, routineId) => {
    const selected = routineId === allDeferredDefinition.id
      ? allDeferredDefinition
      : routineId === partialPrefixDefinition.id
        ? partialPrefixDefinition
        : definition;
    return routineRecord(selected.id, selected);
  };
  db.getSource = async (_database, sourceId) => sources.get(sourceId) ?? null;
  db.updateIntelligenceRoutineRun = async (_database, runId, patch) => runUpdates.push({ runId, patch });
  intelligenceRoutines.advanceRoutineSchedule = async (_database, schedule) => scheduleUpdates.push(schedule.id);
  sourceRegistry.reconcileOrphanedPendingSourceRun = async () => false;
  sourceAccess.sourceRuntimeAccess = (source) => source.kind === "openalex"
    ? {
      runnable: false,
      code: "OPENALEX_API_KEY_REQUIRED",
      detail: "Optional OpenAlex key is not configured",
      openalex: { binding: "OPENALEX_API_KEY" },
    }
    : { runnable: true, detail: "Runnable" };
  sourceRegistry.runSource = async (source) => {
    sourceCalls.push(source.id);
    return {
      runId: `run-${source.id}`,
      count: source.id === "github" ? 2 : 0,
      provider: `${source.id}-provider`,
      status: source.id === "github" || source.id === "prefix" ? "queued" : "success",
      collectionPartial: source.id === "prefix",
    };
  };

  try {
    const workflowStep = new CachedWorkflowStep();
    const result = await new IntelligenceRoutineWorkflow({}, { DB: {} }).run({
      payload: { runId: "run-clean-sources", routineId: definition.id, trigger: "scheduled" },
      instanceId: "workflow-clean-sources",
      timestamp: new Date("2026-08-09T00:00:00.000Z"),
      workflowName: "routine",
    }, workflowStep);

    assert.equal(result.status, "complete");
    assert.deepEqual(sourceCalls, ["github", "hn", "hn"], "duplicates within a refresh are deduplicated and the optional prerequisite is deferred");
    assert.deepEqual(workflowStep.doCalls, [
      "initialize routine",
      "step 1 · source 1",
      "step 1 · source 2",
      "step 1 · source 3",
      "step 1 · source 4",
      "step 2 · source 1",
      "finalize routine",
    ]);
    assert.deepEqual(result.steps[0].result.sources.map(({ sourceId, status }) => ({ sourceId, status })), [
      { sourceId: "github", status: "queued" },
      { sourceId: "openalex", status: "deferred" },
      { sourceId: "disabled", status: "skipped" },
      { sourceId: "hn", status: "collected" },
    ]);
    assert.deepEqual(
      {
        completedCount: result.steps[0].result.completedCount,
        skippedCount: result.steps[0].result.skippedCount,
        deferredCount: result.steps[0].result.deferredCount,
        partialCount: result.steps[0].result.partialCount,
        failedCount: result.steps[0].result.failedCount,
      },
      { completedCount: 2, skippedCount: 1, deferredCount: 1, partialCount: 0, failedCount: 0 },
    );
    assert.deepEqual(
      result.steps[0].result.sources[1],
      {
        sourceId: "openalex",
        name: "Source openalex",
        status: "deferred",
        provider: "source-prerequisite",
        reason: "credential",
        assignedAttempts: 4,
        code: "OPENALEX_API_KEY_REQUIRED",
        binding: "OPENALEX_API_KEY",
        detail: "Optional OpenAlex key is not configured",
      },
    );
    assert.deepEqual(runUpdates.map((update) => update.patch.status), ["running", "complete"]);
    assert.deepEqual(scheduleUpdates, [definition.id]);

    const allDeferred = await new IntelligenceRoutineWorkflow({}, { DB: {} }).run({
      payload: { runId: "run-all-deferred", routineId: allDeferredDefinition.id, trigger: "scheduled" },
      instanceId: "workflow-all-deferred",
      timestamp: new Date("2026-08-09T00:02:00.000Z"),
      workflowName: "routine",
    }, new CachedWorkflowStep());
    assert.equal(allDeferred.status, "partial", "no runnable source cannot be an ordinary completed refresh");
    assert.equal(allDeferred.steps[0].result.status, "partial");
    assert.equal(allDeferred.steps[0].result.completedCount, 0);
    assert.equal(allDeferred.steps[0].result.deferredCount, 1);
    assert.deepEqual(runUpdates.map((update) => update.patch.status), ["running", "complete", "running", "partial"]);
    assert.deepEqual(scheduleUpdates, [definition.id, allDeferredDefinition.id]);

    const partialPrefix = await new IntelligenceRoutineWorkflow({}, { DB: {} }).run({
      payload: { runId: "run-partial-prefix", routineId: partialPrefixDefinition.id, trigger: "scheduled" },
      instanceId: "workflow-partial-prefix",
      timestamp: new Date("2026-08-09T00:03:00.000Z"),
      workflowName: "routine",
    }, new CachedWorkflowStep());
    assert.equal(partialPrefix.status, "partial");
    assert.equal(partialPrefix.steps[0].result.sources[0].status, "queued");
    assert.equal(partialPrefix.steps[0].result.sources[0].collectionPartial, true);
    assert.equal(partialPrefix.steps[0].result.partialCount, 1);
    assert.deepEqual(
      runUpdates.map((update) => update.patch.status),
      ["running", "complete", "running", "partial", "running", "partial"],
    );
    assert.deepEqual(scheduleUpdates, [definition.id, allDeferredDefinition.id, partialPrefixDefinition.id]);
  } finally {
    db.getIntelligenceRoutine = originalGetRoutine;
    db.getSource = originalGetSource;
    db.updateIntelligenceRoutineRun = originalUpdateRun;
    intelligenceRoutines.advanceRoutineSchedule = originalAdvanceSchedule;
    sourceRegistry.reconcileOrphanedPendingSourceRun = originalReconcilePending;
    sourceAccess.sourceRuntimeAccess = originalSourceAccess;
    sourceRegistry.runSource = originalRunSource;
  }
});

test("wait-for-ingest settles before queued match maintenance and folds in the following Computer sync", async () => {
  const originals = {
    getRoutine: db.getIntelligenceRoutine,
    getSource: db.getSource,
    settlements: db.listBuiltInSourceRunSettlements,
    updateRun: db.updateIntelligenceRoutineRun,
    advanceSchedule: intelligenceRoutines.advanceRoutineSchedule,
    sourceAccess: sourceAccess.sourceRuntimeAccess,
    runSource: sourceRegistry.runSource,
  };
  const definition = {
    id: "settled-source-routine",
    name: "Settled source routine",
    missionId: "mission-settlement",
    scheduleMinutes: 60,
    steps: [
      { id: "refresh", action: "refresh-sources", sourceIds: ["terminal", "stale"] },
      { id: "wait", action: "wait-for-ingest", waitSeconds: 1 },
      { id: "rebuild", action: "rebuild-mission" },
      { id: "sync", action: "sync-computer" },
    ],
  };
  const sources = new Map([
    ["terminal", sourceRecord("terminal", "github_releases")],
    ["stale", sourceRecord("stale", "hackernews")],
  ]);
  const runUpdates = [];
  const maintenanceStarts = [];
  db.getIntelligenceRoutine = async () => routineRecord(definition.id, definition);
  db.getSource = async (_database, sourceId) => sources.get(sourceId) ?? null;
  db.listBuiltInSourceRunSettlements = async (_database, runIds) => {
    assert.deepEqual(runIds, ["run-terminal", "run-stale"]);
    return [
      { runId: "run-terminal", status: "success", collectionPartial: false, lastIngestError: null },
      { runId: "run-stale", status: "queued", collectionPartial: false, lastIngestError: null },
    ];
  };
  db.updateIntelligenceRoutineRun = async (_database, runId, patch) => runUpdates.push({ runId, patch });
  intelligenceRoutines.advanceRoutineSchedule = async () => undefined;
  sourceAccess.sourceRuntimeAccess = () => ({ runnable: true, detail: "Runnable" });
  sourceRegistry.runSource = async (source) => ({
    runId: `run-${source.id}`,
    count: 1,
    provider: `${source.id}-provider`,
    status: "queued",
    collectionPartial: false,
  });

  try {
    const step = new CachedWorkflowStep();
    const budget = budgetD1();
    const result = await new IntelligenceRoutineWorkflow({}, {
      DB: budget,
      MISSION_WORKFLOW: missionWorkflowBinding(maintenanceStarts),
    }).run({
      payload: { runId: "run-settlement", routineId: definition.id, trigger: "scheduled" },
      instanceId: "workflow-settlement",
      timestamp: new Date("2026-08-09T00:00:00.000Z"),
      workflowName: "routine",
    }, step);

    assert.equal(result.status, "partial");
    assert.deepEqual(
      result.steps[0].result.sources.map(({ sourceId, status, settlementPending }) => ({ sourceId, status, settlementPending })),
      [
        { sourceId: "terminal", status: "collected", settlementPending: undefined },
        { sourceId: "stale", status: "queued", settlementPending: true },
      ],
    );
    assert.equal(result.steps[0].result.partialCount, 1);
    assert.equal(maintenanceStarts.length, 1);
    assert.deepEqual(maintenanceStarts[0].params, {
      mode: "match-maintenance",
      missionId: "mission-settlement",
      reason: "intelligence-routine",
    });
    assert.equal(result.steps[2].result.status, "queued");
    assert.equal(
      step.doConfigs.find(({ name }) => name === "step 3 · rebuild-mission").config.retries.limit,
      0,
      "an ambiguous child-Workflow launch is never replayed",
    );
    assert.equal(budget.units, missions.MISSION_MATCH_MAINTENANCE_WORKFLOW_STEP_RESERVATION);
    assert.equal(budget.queries.length, 3);
    assert.deepEqual(result.steps[3].result, {
      includedInMatchMaintenance: true,
      workflowId: result.steps[2].result.workflowId,
      status: "queued",
    });
    assert.equal(step.doCalls.includes("step 4 · sync-computer"), false);
    assert.ok(
      step.doCalls.indexOf("step 2 · settle sources") < step.doCalls.indexOf("step 3 · rebuild-mission"),
      "settlement is cached before evidence-dependent rebuild",
    );
    assert.deepEqual(runUpdates.map((update) => update.patch.status), ["running", "partial"]);
  } finally {
    db.getIntelligenceRoutine = originals.getRoutine;
    db.getSource = originals.getSource;
    db.listBuiltInSourceRunSettlements = originals.settlements;
    db.updateIntelligenceRoutineRun = originals.updateRun;
    intelligenceRoutines.advanceRoutineSchedule = originals.advanceSchedule;
    sourceAccess.sourceRuntimeAccess = originals.sourceAccess;
    sourceRegistry.runSource = originals.runSource;
  }
});

test("nested source failures fail a required Routine and retain every source outcome", async () => {
  const originalGetRoutine = db.getIntelligenceRoutine;
  const originalGetSource = db.getSource;
  const originalUpdateRun = db.updateIntelligenceRoutineRun;
  const originalAdvanceSchedule = intelligenceRoutines.advanceRoutineSchedule;
  const originalSourceAccess = sourceAccess.sourceRuntimeAccess;
  const originalRunSource = sourceRegistry.runSource;
  const definition = {
    id: "failed-source-routine",
    name: "Failed source routine",
    scheduleMinutes: 60,
    steps: [{ id: "refresh", action: "refresh-sources", sourceIds: ["github", "backpressure", "missing"] }],
  };
  const sources = new Map([
    ["github", sourceRecord("github", "github_releases")],
    ["backpressure", sourceRecord("backpressure")],
  ]);
  const runUpdates = [];
  const scheduleUpdates = [];
  const sourceCalls = [];
  db.getIntelligenceRoutine = async () => routineRecord(definition.id, definition);
  db.getSource = async (_database, sourceId) => sources.get(sourceId) ?? null;
  db.updateIntelligenceRoutineRun = async (_database, runId, patch) => runUpdates.push({ runId, patch });
  intelligenceRoutines.advanceRoutineSchedule = async (_database, schedule) => scheduleUpdates.push(schedule.id);
  sourceAccess.sourceRuntimeAccess = () => ({ runnable: true, detail: "Runnable" });
  sourceRegistry.runSource = async (source) => {
    sourceCalls.push(source.id);
    if (source.id === "backpressure") throw new Error("Ingest is blocked by a fresh prior handoff");
    return { runId: "run-github", count: 2, provider: "github-atom", status: "queued" };
  };

  try {
    const cache = new Map();
    const workflowStep = new CachedWorkflowStep(cache);
    const event = {
      payload: { runId: "run-failed-sources", routineId: definition.id, trigger: "scheduled" },
      instanceId: "workflow-failed-sources",
      timestamp: new Date("2026-08-09T00:00:00.000Z"),
      workflowName: "routine",
    };
    await assert.rejects(
      new IntelligenceRoutineWorkflow({}, { DB: {} }).run(event, workflowStep),
      /2 of 3 source refreshes failed/,
    );

    assert.deepEqual(workflowStep.doCalls, [
      "initialize routine",
      "step 1 · source 1",
      "step 1 · source 2",
      "step 1 · source 3",
      "fail routine",
    ]);
    assert.deepEqual(runUpdates.map((update) => update.patch.status), ["running", "failed"]);
    const failed = runUpdates.at(-1).patch;
    assert.equal(failed.error, "2 of 3 source refreshes failed");
    assert.equal(failed.result.steps[0].ok, false);
    assert.deepEqual(failed.result.steps[0].result.sources.map(({ sourceId, status }) => ({ sourceId, status })), [
      { sourceId: "github", status: "queued" },
      { sourceId: "backpressure", status: "failed" },
      { sourceId: "missing", status: "missing" },
    ]);
    assert.equal(failed.result.steps[0].result.sources[0].runId, "run-github");
    assert.match(failed.result.steps[0].result.sources[1].error, /fresh prior handoff/);
    const replayStep = new CachedWorkflowStep(cache);
    await assert.rejects(
      new IntelligenceRoutineWorkflow({}, { DB: {} }).run(event, replayStep),
      /2 of 3 source refreshes failed/,
    );
    assert.deepEqual(runUpdates.map((update) => update.patch.status), ["running", "failed"]);
    assert.deepEqual(scheduleUpdates, [definition.id], "cached failure finalization advances the schedule once");
    assert.deepEqual(
      sourceCalls,
      ["github", "backpressure", "backpressure"],
      "replay reuses the earlier GitHub success and reruns only the source step that threw",
    );
    assert.deepEqual(replayStep.doCalls, [
      "initialize routine",
      "step 1 · source 1",
      "step 1 · source 2",
      "step 1 · source 3",
      "fail routine",
    ]);
  } finally {
    db.getIntelligenceRoutine = originalGetRoutine;
    db.getSource = originalGetSource;
    db.updateIntelligenceRoutineRun = originalUpdateRun;
    intelligenceRoutines.advanceRoutineSchedule = originalAdvanceSchedule;
    sourceAccess.sourceRuntimeAccess = originalSourceAccess;
    sourceRegistry.runSource = originalRunSource;
  }
});

test("max Hacker News collection and the next network source use distinct external envelopes", async () => {
  const originals = {
    getRoutine: db.getIntelligenceRoutine,
    updateRun: db.updateIntelligenceRoutineRun,
    advanceSchedule: intelligenceRoutines.advanceRoutineSchedule,
  };
  const definition = {
    id: "isolated-source-envelope",
    name: "Isolated source envelope",
    steps: [{ id: "refresh", action: "refresh-sources", sourceIds: ["hn-max", "arxiv-next"] }],
  };
  const boundaryCalls = [];
  const externalRequestsByInvocation = [];
  db.getIntelligenceRoutine = async () => routineRecord(definition.id, definition);
  db.updateIntelligenceRoutineRun = async () => undefined;
  intelligenceRoutines.advanceRoutineSchedule = async () => undefined;
  const boundary = {
    async runSource(sourceId) {
      boundaryCalls.push(sourceId);
      const externalRequests = sourceId === "hn-max" ? 50 : 1;
      externalRequestsByInvocation.push(externalRequests);
      assert.ok(externalRequests <= 50);
      return {
        ok: true,
        source: { name: `Source ${sourceId}`, kind: sourceId === "hn-max" ? "hackernews" : "arxiv" },
        result: {
          runId: `run-${sourceId}`,
          count: sourceId === "hn-max" ? 49 : 1,
          provider: sourceId,
          status: "success",
          collectionPartial: false,
        },
      };
    },
  };

  try {
    const step = new CachedWorkflowStep();
    const result = await new IntelligenceRoutineWorkflow(
      { exports: { SourceRunBoundary: boundary } },
      { DB: {} },
    ).run({
      payload: { runId: "run-isolated-envelope", routineId: definition.id, trigger: "scheduled" },
      instanceId: "workflow-isolated-envelope",
      timestamp: new Date("2026-08-10T00:00:00.000Z"),
      workflowName: "routine",
    }, step);

    assert.equal(result.status, "complete");
    assert.deepEqual(boundaryCalls, ["hn-max", "arxiv-next"]);
    assert.deepEqual(externalRequestsByInvocation, [50, 1]);
    assert.deepEqual(
      result.steps[0].result.sources.map(({ sourceId, status, assignedAttempts }) => ({ sourceId, status, assignedAttempts })),
      [
        { sourceId: "hn-max", status: "collected", assignedAttempts: 4 },
        { sourceId: "arxiv-next", status: "collected", assignedAttempts: 4 },
      ],
    );
    assert.deepEqual(
      step.doConfigs.filter(({ name }) => name.includes("· source")).map(({ config }) => config.retries.limit),
      [3, 3],
    );
  } finally {
    db.getIntelligenceRoutine = originals.getRoutine;
    db.updateIntelligenceRoutineRun = originals.updateRun;
    intelligenceRoutines.advanceRoutineSchedule = originals.advanceSchedule;
  }
});

test("source capacity is partial without retrying the Routine source step", async () => {
  const originals = {
    getRoutine: db.getIntelligenceRoutine,
    updateRun: db.updateIntelligenceRoutineRun,
    advanceSchedule: intelligenceRoutines.advanceRoutineSchedule,
  };
  const definition = {
    id: "routine-source-capacity",
    name: "Routine source capacity",
    steps: [{ id: "refresh", action: "refresh-sources", sourceIds: ["capacity"] }],
  };
  let boundaryCalls = 0;
  db.getIntelligenceRoutine = async () => routineRecord(definition.id, definition);
  db.updateIntelligenceRoutineRun = async () => undefined;
  intelligenceRoutines.advanceRoutineSchedule = async () => undefined;

  try {
    const result = await new IntelligenceRoutineWorkflow({
      exports: {
        SourceRunBoundary: {
          async runSource() {
            boundaryCalls += 1;
            return {
              ok: false,
              kind: "capacity",
              error: { name: "Error", message: "Too many subrequests." },
            };
          },
        },
      },
    }, { DB: {} }).run({
      payload: { runId: "run-routine-capacity", routineId: definition.id, trigger: "scheduled" },
      instanceId: "workflow-routine-capacity",
      timestamp: new Date("2026-08-10T00:00:00.000Z"),
      workflowName: "routine",
    }, new CachedWorkflowStep());

    assert.equal(boundaryCalls, 1);
    assert.equal(result.status, "partial");
    assert.deepEqual(result.steps[0].result.sources[0], {
      sourceId: "capacity",
      status: "deferred",
      provider: "workers-source-boundary",
      reason: "capacity",
      assignedAttempts: 4,
      collectionPartial: true,
      detail: "Too many subrequests.",
    });
  } finally {
    db.getIntelligenceRoutine = originals.getRoutine;
    db.updateIntelligenceRoutineRun = originals.updateRun;
    intelligenceRoutines.advanceRoutineSchedule = originals.advanceSchedule;
  }
});

test("multiple Routine refresh steps share one required-first 30-call boundary plan", async () => {
  const originals = {
    getRoutine: db.getIntelligenceRoutine,
    updateRun: db.updateIntelligenceRoutineRun,
    advanceSchedule: intelligenceRoutines.advanceRoutineSchedule,
  };
  const optionalIds = Array.from({ length: 20 }, (_, index) => `optional-${index}`);
  const requiredIds = Array.from({ length: 20 }, (_, index) => `required-${index}`);
  const definition = {
    id: "shared-runtime-boundary-plan",
    name: "Shared runtime boundary plan",
    steps: [
      { id: "optional", action: "refresh-sources", sourceIds: optionalIds, optional: true },
      { id: "required", action: "refresh-sources", sourceIds: requiredIds },
    ],
  };
  const boundaryCalls = [];
  db.getIntelligenceRoutine = async () => routineRecord(definition.id, definition);
  db.updateIntelligenceRoutineRun = async () => undefined;
  intelligenceRoutines.advanceRoutineSchedule = async () => undefined;

  try {
    const step = new CachedWorkflowStep();
    const result = await new IntelligenceRoutineWorkflow({
      exports: {
        SourceRunBoundary: {
          async runSource(sourceId) {
            boundaryCalls.push(sourceId);
            return {
              ok: true,
              source: { name: sourceId, kind: "hackernews" },
              result: {
                runId: `run-${sourceId}`,
                count: 1,
                provider: "test",
                status: "success",
                collectionPartial: false,
              },
            };
          },
        },
      },
    }, { DB: {} }).run({
      payload: { runId: "run-shared-runtime-plan", routineId: definition.id, trigger: "scheduled" },
      instanceId: "workflow-shared-runtime-plan",
      timestamp: new Date("2026-08-10T00:00:00.000Z"),
      workflowName: "routine",
    }, step);

    assert.equal(result.status, "partial");
    assert.deepEqual(boundaryCalls, [...optionalIds.slice(0, 10), ...requiredIds]);
    assert.equal(boundaryCalls.length, 30);
    assert.deepEqual(
      result.steps[0].result.sources.slice(10).map(({ sourceId, status, reason, assignedAttempts }) => ({
        sourceId,
        status,
        reason,
        assignedAttempts,
      })),
      optionalIds.slice(10).map((sourceId) => ({
        sourceId,
        status: "deferred",
        reason: "capacity",
        assignedAttempts: 0,
      })),
    );
    assert.ok(result.steps[1].result.sources.every((source) => source.assignedAttempts === 1));
    assert.deepEqual(
      step.doConfigs.filter(({ name }) => name.includes("· source")).map(({ config }) => config.retries.limit),
      Array.from({ length: 30 }, () => 0),
    );
  } finally {
    db.getIntelligenceRoutine = originals.getRoutine;
    db.updateIntelligenceRoutineRun = originals.updateRun;
    intelligenceRoutines.advanceRoutineSchedule = originals.advanceSchedule;
  }
});

test("required failure waits for queued prefix settlement and aborts before rebuild", async () => {
  const originals = {
    getRoutine: db.getIntelligenceRoutine,
    settlements: db.listBuiltInSourceRunSettlements,
    updateRun: db.updateIntelligenceRoutineRun,
    advanceSchedule: intelligenceRoutines.advanceRoutineSchedule,
    rebuild: missions.rebuildMissionMatches,
  };
  const definition = {
    id: "required-prefix-settlement",
    name: "Required prefix settlement",
    missionId: "mission-prefix",
    steps: [
      { id: "refresh-one", action: "refresh-sources", sourceIds: ["queued-prefix"] },
      { id: "refresh-two", action: "refresh-sources", sourceIds: ["required-failure"] },
      { id: "wait", action: "wait-for-ingest", waitSeconds: 1 },
      { id: "rebuild", action: "rebuild-mission" },
    ],
  };
  const runUpdates = [];
  let rebuilds = 0;
  const boundaryCalls = [];
  db.getIntelligenceRoutine = async () => routineRecord(definition.id, definition);
  db.listBuiltInSourceRunSettlements = async (_database, runIds) => {
    assert.deepEqual(runIds, ["run-queued-prefix"]);
    return [{ runId: "run-queued-prefix", status: "success", collectionPartial: false, lastIngestError: null }];
  };
  db.updateIntelligenceRoutineRun = async (_database, runId, patch) => runUpdates.push({ runId, patch });
  intelligenceRoutines.advanceRoutineSchedule = async () => undefined;
  missions.rebuildMissionMatches = async () => {
    rebuilds += 1;
    return 1;
  };
  const boundary = {
    async runSource(sourceId) {
      boundaryCalls.push(sourceId);
      if (sourceId === "required-failure") {
        return { ok: false, kind: "error", error: { name: "Error", message: "required source failed" } };
      }
      return {
        ok: true,
        source: { name: "Queued prefix", kind: "hackernews" },
        result: {
          runId: "run-queued-prefix",
          count: 1,
          provider: "hackernews-firebase",
          status: "queued",
          collectionPartial: false,
        },
      };
    },
  };

  try {
    const step = new CachedWorkflowStep();
    await assert.rejects(
      new IntelligenceRoutineWorkflow(
        { exports: { SourceRunBoundary: boundary } },
        { DB: {} },
      ).run({
        payload: { runId: "run-required-prefix", routineId: definition.id, trigger: "scheduled" },
        instanceId: "workflow-required-prefix",
        timestamp: new Date("2026-08-10T00:00:00.000Z"),
        workflowName: "routine",
      }, step),
      /1 of 1 source refresh failed/,
    );

    assert.deepEqual(boundaryCalls, ["queued-prefix", "required-failure"]);
    assert.deepEqual(step.sleepCalls, [{ name: "step 3 · wait", duration: "1 seconds" }]);
    assert.ok(step.doCalls.includes("step 3 · settle sources"));
    assert.equal(step.doCalls.includes("step 4 · rebuild-mission"), false);
    assert.equal(rebuilds, 0);
    const failed = runUpdates.at(-1).patch;
    assert.equal(failed.status, "failed");
    assert.equal(failed.result.steps[0].result.sources[0].status, "collected");
    assert.equal(failed.result.steps[1].result.sources[0].status, "failed");
  } finally {
    db.getIntelligenceRoutine = originals.getRoutine;
    db.listBuiltInSourceRunSettlements = originals.settlements;
    db.updateIntelligenceRoutineRun = originals.updateRun;
    intelligenceRoutines.advanceRoutineSchedule = originals.advanceSchedule;
    missions.rebuildMissionMatches = originals.rebuild;
  }
});

test("maximum routine input produces bounded cloneable initialization state", async () => {
  const originalGetRoutine = db.getIntelligenceRoutine;
  const originalUpdateRun = db.updateIntelligenceRoutineRun;
  const originalAdvanceSchedule = intelligenceRoutines.advanceRoutineSchedule;
  const oversizedText = "x".repeat(4_096);
  const oversizedSourceId = "source-" + "s".repeat(1_024);
  const rawDefinition = {
    id: `maximum-${oversizedText}`,
    name: `Maximum ${oversizedText}`,
    description: oversizedText,
    missionId: `mission-${oversizedText}`,
    scheduleMinutes: 60,
    steps: Array.from({ length: 24 }, (_, index) => ({
      id: `${index}-${oversizedText}`,
      name: `Step ${index} ${oversizedText}`,
      action: "wait-for-ingest",
      runtime: "worker",
      sourceIds: Array.from({ length: 80 }, (_, sourceIndex) => `${sourceIndex}-${oversizedSourceId}`),
      waitSeconds: 1,
      reasoningTask: "investigate",
      target: "chatgpt",
      args: {
        objective: oversizedText,
        reason: oversizedText,
        priority: 99,
        expiresInHours: 99_999,
        ignored: { blob: oversizedText, nested: [oversizedText] },
      },
    })),
  };
  const record = routineRecord("maximum-routine", rawDefinition, 60);
  assert.ok(Buffer.byteLength(record.definition_json) > 1024 * 1024, "the raw definition exercises an oversized input");

  db.getIntelligenceRoutine = async () => record;
  db.updateIntelligenceRoutineRun = async () => {};
  intelligenceRoutines.advanceRoutineSchedule = async () => {};

  try {
    const cache = new Map();
    const step = new CachedWorkflowStep(cache);
    await new IntelligenceRoutineWorkflow({}, { DB: {} }).run({
      payload: { runId: "run-maximum", routineId: "maximum-routine" },
      instanceId: "workflow-maximum",
      timestamp: new Date("2026-08-09T00:00:00.000Z"),
      workflowName: "routine",
    }, step);
    const initialization = cache.get("initialize routine");
    const serialized = JSON.stringify(initialization);
    const definition = JSON.parse(initialization.definitionJson);

    assert.deepEqual(Object.keys(initialization).sort(), ["definitionJson", "schedule"]);
    assert.deepEqual(initialization.schedule, { id: "maximum-routine", schedule_minutes: 60 });
    assert.deepEqual(structuredClone(initialization), initialization);
    assert.ok(Buffer.byteLength(serialized) < 512 * 1024, "maximum normalized initialization state stays well below 1 MiB");
    assert.equal(serialized.includes("definition_json"), false, "the D1 record is not duplicated into Workflow state");
    assert.equal(definition.missionId.length, 160);
    assert.equal(definition.description.length, 1_500);
    assert.equal(definition.steps.length, 24);
    assert.ok(definition.steps.every((routineStep) => routineStep.sourceIds.length === 50));
    assert.ok(definition.steps.every((routineStep) => routineStep.sourceIds.every((sourceId) => sourceId.length <= 80)));
    assert.ok(definition.steps.every((routineStep) => routineStep.args.objective.length === 1_500));
    assert.ok(definition.steps.every((routineStep) => routineStep.args.reason.length === 500));
    assert.ok(definition.steps.every((routineStep) => routineStep.args.priority === 1));
    assert.ok(definition.steps.every((routineStep) => routineStep.args.expiresInHours === 8_760));
    assert.ok(definition.steps.every((routineStep) => !("ignored" in routineStep.args)));
  } finally {
    db.getIntelligenceRoutine = originalGetRoutine;
    db.updateIntelligenceRoutineRun = originalUpdateRun;
    intelligenceRoutines.advanceRoutineSchedule = originalAdvanceSchedule;
  }
});

function syntheticNode(index) {
  return {
    id: `node-${index}-${"n".repeat(512)}`,
    type: `type-${index}-${"t".repeat(256)}`,
    key: `key-${index}`,
    label: `Node ${index}`,
    summary: `oversized-node-payload-${"s".repeat(2_048)}`,
    aliases: [],
    metadata: { payload: "m".repeat(2_048) },
    importance: 1,
    confidence: 1,
    occurredAt: null,
    status: "active",
    supersededBy: null,
    sourceRef: null,
    validFrom: null,
    validTo: null,
  };
}

function syntheticEdge(index) {
  return {
    id: `edge-${index}-${"e".repeat(512)}`,
    from: `node-${index % 500}`,
    to: `node-${(index + 1) % 500}`,
    relation: `relation-${index}-${"r".repeat(256)}`,
    weight: 1,
    confidence: 1,
    evidence: [],
    rationale: `oversized-edge-payload-${"p".repeat(1_024)}`,
    status: "active",
  };
}

test("checkpoint workflow result keeps maximum snapshot payloads out of step state", () => {
  const nodes = Array.from({ length: 500 }, (_, index) => syntheticNode(index));
  const edges = Array.from({ length: 2_000 }, (_, index) => syntheticEdge(index));
  const nodeIds = nodes.map((node) => node.id);
  const edgeIds = edges.map((edge) => edge.id);
  const byType = Object.fromEntries(nodes.map((node) => [node.type, 1]));
  const byRelation = Object.fromEntries(edges.map((edge) => [edge.relation, 1]));
  const input = {
    created: true,
    checkpoint: {
      id: `checkpoint-${"c".repeat(1_024)}`,
      scope_kind: "global",
      scope_id: null,
      title: `Synthetic checkpoint ${"x".repeat(2_048)}`,
      reason: "Synthetic upper-bound check",
      snapshot_r2_key: `memory-checkpoints/${"k".repeat(4_096)}.json`,
      snapshot_hash: "h".repeat(1_024),
      summary_json: "{}",
      diff_json: "{}",
      created_at: "2026-08-09T00:00:00.000Z",
    },
    snapshot: {
      schemaVersion: "1",
      scope: {
        kind: "global",
        id: null,
        ref: null,
        title: `Synthetic scope ${"q".repeat(2_048)}`,
      },
      capturedAt: "2026-08-09T00:00:00.000Z",
      nodes,
      edges,
      summary: {
        nodes: nodes.length,
        edges: edges.length,
        activeNodes: nodes.length,
        activeEdges: edges.length,
        byType,
        byRelation,
      },
    },
    diff: {
      unchanged: false,
      previousCheckpointId: `previous-${"v".repeat(1_024)}`,
      addedNodes: nodeIds,
      removedNodes: nodeIds,
      changedNodes: nodeIds,
      addedEdges: edgeIds,
      removedEdges: edgeIds,
      changedEdges: edgeIds,
      counts: {
        addedNodes: nodes.length,
        removedNodes: nodes.length,
        changedNodes: nodes.length,
        addedEdges: edges.length,
        removedEdges: edges.length,
        changedEdges: edges.length,
      },
    },
  };

  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024, "the synthetic full checkpoint exceeds the Workflow result limit");
  const result = checkpointMemoryStepResult(input);
  const serialized = JSON.stringify(result);

  assert.deepEqual(Object.keys(result).sort(), ["capturedAt", "diff", "metadata", "reference", "scope", "summary"]);
  assert.equal("snapshot" in result, false);
  assert.equal(serialized.includes("oversized-node-payload"), false);
  assert.equal(serialized.includes("oversized-edge-payload"), false);
  assert.ok(Buffer.byteLength(serialized) < 1024 * 1024, "the bounded Workflow step result stays below 1 MiB");
  assert.equal(result.diff.truncated, true);
  assert.equal(result.diff.addedNodes.length, result.diff.sampleLimit);
  assert.equal(result.diff.addedEdges.length, result.diff.sampleLimit);
  assert.equal(result.summary.truncated, true);
  assert.ok(Object.keys(result.summary.byType).length <= result.summary.bucketLimit);
  assert.ok(Object.keys(result.summary.byRelation).length <= result.summary.bucketLimit);

  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "nodes" || key === "edges") assert.equal(Array.isArray(child), false, `${key} must be a count, not a full array`);
      visit(child);
    }
  };
  visit(result);
});
