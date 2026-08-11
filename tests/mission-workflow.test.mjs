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

let missionWorkflow;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "cloudflare:workers") {
      return {
        WorkflowEntrypoint,
        WorkerEntrypoint: WorkflowEntrypoint,
        DurableObject,
        tracing: {
          enterSpan: async (_name, operation) => operation({ setAttribute() {}, setStatus() {} }),
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
  missionWorkflow = require("../.test-dist/mission-workflow.js");
} finally {
  Module._load = originalLoad;
}

const db = require("../.test-dist/db.js");
const missions = require("../.test-dist/missions.js");
const missionAutopilot = require("../.test-dist/mission-autopilot.js");
const sourceRegistry = require("../.test-dist/sources/registry.js");
const sourceAccess = require("../.test-dist/sources/access.js");
const { MissionSprintWorkflow } = missionWorkflow;

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

function budgetDatabase() {
  let used = 0;
  return {
    prepare(query) {
      const statement = {
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async all() {
          if (query.includes("FROM settings")) {
            return {
              success: true,
              results: [{ key: "budget_profile", value: "free" }],
              meta: {},
            };
          }
          return { success: true, results: [], meta: {} };
        },
        async run() {
          if (query.includes("INSERT INTO usage_daily")) used += Number(this.values[2] ?? 0);
          return { success: true, results: [], meta: { changes: 1 } };
        },
        async first() {
          if (query.includes("SELECT units FROM usage_daily")) return { units: used };
          return null;
        },
      };
      return statement;
    },
  };
}

function sourceRecord(id, kind) {
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

test("Mission Sprint preserves nested source status and cannot count pending as collected", async () => {
  const originals = {
    getMission: db.getMission,
    getSource: db.getSource,
    settlements: db.listBuiltInSourceRunSettlements,
    listMissionMatches: db.listMissionMatches,
    updateMissionRun: db.updateMissionRun,
    reconcilePending: sourceRegistry.reconcileOrphanedPendingSourceRun,
    sourceAccess: sourceAccess.sourceRuntimeAccess,
    runSource: sourceRegistry.runSource,
  };
  const sources = new Map([
    ["healthy", sourceRecord("healthy", "github_releases")],
    ["pending", sourceRecord("pending", "hackernews")],
    ["stale", sourceRecord("stale", "hackernews")],
    ["openalex", sourceRecord("openalex", "openalex")],
  ]);
  const updates = [];
  const runCalls = [];
  const maintenanceStarts = [];
  db.getMission = async () => ({ id: "mission-1", name: "Mission one" });
  db.getSource = async (_database, sourceId) => sources.get(sourceId) ?? null;
  db.listBuiltInSourceRunSettlements = async (_database, runIds) => {
    assert.deepEqual(runIds, ["run-healthy", "run-stale"]);
    return [
      { runId: "run-healthy", status: "success", collectionPartial: false, lastIngestError: null },
      { runId: "run-stale", status: "queued", collectionPartial: false, lastIngestError: null },
    ];
  };
  db.listMissionMatches = async () => [];
  db.updateMissionRun = async (_database, runId, patch) => updates.push({ runId, patch });
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
    runCalls.push(source.id);
    if (source.id === "pending") {
      return { runId: "run-pending", count: 0, provider: "outbox-reconcile", status: "pending", collectionPartial: false };
    }
    return { runId: `run-${source.id}`, count: 2, provider: "github-atom", status: "queued", collectionPartial: false };
  };

  try {
    const step = new CachedWorkflowStep();
    const result = await new MissionSprintWorkflow({}, {
      DB: budgetDatabase(),
      MISSION_WORKFLOW: missionWorkflowBinding(maintenanceStarts),
    }).run({
      payload: {
        runId: "mission-run-1",
        missionId: "mission-1",
        sourceIds: ["healthy", "pending", "stale", "openalex"],
      },
      instanceId: "mission-workflow-1",
      timestamp: new Date("2026-08-09T00:00:00.000Z"),
      workflowName: "mission",
    }, step);

    assert.deepEqual(runCalls, ["healthy", "pending", "stale"], "credential-deferred sources never enter runSource");
    assert.deepEqual(step.doCalls.slice(0, 6), [
      "resolve mission and source plan",
      "collect source 1",
      "collect source 2",
      "collect source 3",
      "collect source 4",
      "settle built-in source runs",
    ]);
    assert.deepEqual(result.sourceResults.map(({ sourceId, status }) => ({ sourceId, status })), [
      { sourceId: "healthy", status: "collected" },
      { sourceId: "pending", status: "failed" },
      { sourceId: "stale", status: "queued" },
      { sourceId: "openalex", status: "deferred" },
    ]);
    assert.equal(result.failedSourceCount, 1);
    assert.equal(result.partialSourceCount, 1);
    assert.equal(result.deferredSourceCount, 1);
    assert.equal(result.sourceResults[2].settlementPending, true);
    assert.equal(result.matchedStories, null);
    assert.equal(result.matchesPending, true);
    assert.deepEqual(result.topMatches, []);
    assert.equal(result.matchMaintenance.status, "queued");
    assert.equal(result.computerSync.workflowId, result.matchMaintenance.workflowId);
    assert.equal(
      step.doConfigs.find(({ name }) => name === "queue Mission match maintenance").config.retries.limit,
      0,
    );
    assert.deepEqual(maintenanceStarts[0].params, {
      mode: "match-maintenance",
      missionId: "mission-1",
      reason: "mission-sprint-complete",
    });
    assert.equal(updates.find((update) => update.patch.completedAt)?.patch.status, "partial");
  } finally {
    db.getMission = originals.getMission;
    db.getSource = originals.getSource;
    db.listBuiltInSourceRunSettlements = originals.settlements;
    db.listMissionMatches = originals.listMissionMatches;
    db.updateMissionRun = originals.updateMissionRun;
    sourceRegistry.reconcileOrphanedPendingSourceRun = originals.reconcilePending;
    sourceAccess.sourceRuntimeAccess = originals.sourceAccess;
    sourceRegistry.runSource = originals.runSource;
  }
});

test("an explicitly empty reserved Mission plan cannot re-resolve new sources", async () => {
  const originals = {
    getMission: db.getMission,
    settlements: db.listBuiltInSourceRunSettlements,
    listMissionMatches: db.listMissionMatches,
    updateMissionRun: db.updateMissionRun,
    resolveMissionSourceIds: missionAutopilot.resolveMissionSourceIds,
  };
  const updates = [];
  let resolverCalls = 0;
  db.getMission = async () => ({ id: "mission-empty", name: "Empty Mission" });
  db.listBuiltInSourceRunSettlements = async () => [];
  db.listMissionMatches = async () => [];
  db.updateMissionRun = async (_database, runId, patch) => updates.push({ runId, patch });
  missionAutopilot.resolveMissionSourceIds = async () => {
    resolverCalls += 1;
    return ["newly-added-source"];
  };
  const maintenanceStarts = [];

  try {
    const result = await new MissionSprintWorkflow({}, {
      DB: budgetDatabase(),
      MISSION_WORKFLOW: missionWorkflowBinding(maintenanceStarts),
    }).run({
      payload: { runId: "mission-run-empty", missionId: "mission-empty", sourceIds: [] },
      instanceId: "mission-workflow-empty",
      timestamp: new Date("2026-08-09T00:00:00.000Z"),
      workflowName: "mission",
    }, new CachedWorkflowStep());

    assert.equal(resolverCalls, 0);
    assert.equal(result.plannedSourceCount, 0);
    assert.deepEqual(result.sourceResults, []);
    assert.equal(result.matchMaintenance.status, "queued");
    assert.equal(maintenanceStarts.length, 1);
    assert.equal(updates.find((update) => update.patch.completedAt)?.patch.status, "partial");
  } finally {
    db.getMission = originals.getMission;
    db.listBuiltInSourceRunSettlements = originals.settlements;
    db.listMissionMatches = originals.listMissionMatches;
    db.updateMissionRun = originals.updateMissionRun;
    missionAutopilot.resolveMissionSourceIds = originals.resolveMissionSourceIds;
  }
});

test("source capacity is partial without retrying the Mission source step", async () => {
  const originals = {
    getMission: db.getMission,
    settlements: db.listBuiltInSourceRunSettlements,
    listMissionMatches: db.listMissionMatches,
    updateMissionRun: db.updateMissionRun,
  };
  const updates = [];
  let boundaryCalls = 0;
  db.getMission = async () => ({ id: "mission-capacity", name: "Capacity Mission" });
  db.listBuiltInSourceRunSettlements = async () => [];
  db.listMissionMatches = async () => [];
  db.updateMissionRun = async (_database, runId, patch) => updates.push({ runId, patch });
  const maintenanceStarts = [];

  try {
    const step = new CachedWorkflowStep();
    const result = await new MissionSprintWorkflow({
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
    }, {
      DB: budgetDatabase(),
      MISSION_WORKFLOW: missionWorkflowBinding(maintenanceStarts),
    }).run({
      payload: { runId: "mission-run-capacity", missionId: "mission-capacity", sourceIds: ["capacity"] },
      instanceId: "mission-workflow-capacity",
      timestamp: new Date("2026-08-10T00:00:00.000Z"),
      workflowName: "mission",
    }, step);

    assert.equal(boundaryCalls, 1);
    assert.equal(maintenanceStarts.length, 1);
    assert.equal(updates.find((update) => update.patch.completedAt)?.patch.status, "partial");
    assert.deepEqual(result.sourceResults[0], {
      sourceId: "capacity",
      name: "capacity",
      status: "deferred",
      count: 0,
      provider: "workers-source-boundary",
      reason: "capacity",
      assignedAttempts: 4,
      collectionPartial: true,
      error: "Too many subrequests.",
    });
    assert.equal(
      step.doConfigs.find(({ name }) => name === "collect source 1").config.retries.limit,
      3,
      "the step was retry-capable, but the structured capacity callback completed on its first call",
    );
  } finally {
    db.getMission = originals.getMission;
    db.listBuiltInSourceRunSettlements = originals.settlements;
    db.listMissionMatches = originals.listMissionMatches;
    db.updateMissionRun = originals.updateMissionRun;
  }
});

test("Mission match maintenance keeps 500 Stories inside the page and service-call envelopes", async () => {
  const storyIds = Array.from({ length: 500 }, (_, index) => `story-${String(index + 1).padStart(3, "0")}`);
  const pageInputs = [];
  let planCalls = 0;
  let commitCalls = 0;
  let computerLoadCalls = 0;
  let computerRenderCalls = 0;
  let computerCommitCalls = 0;
  const boundary = {
    async planMatches(missionId) {
      planCalls += 1;
      assert.equal(missionId, "mission-scale");
      return {
        missionId,
        missionUpdatedAt: "2026-08-11T00:00:00.000Z",
        rebuildWatermark: "2026-08-11T00:01:00.000Z",
        storyIds,
        storyWindowHasMore: true,
      };
    },
    async evaluateMatches(input) {
      pageInputs.push(input);
      return {
        storyIds: input.storyIds,
        matches: [],
        coverage: {
          evidenceItemsConsidered: input.storyIds.length * 8,
          storiesWithAdditionalEvidence: input.storyIds.length,
          excerptedBodies: input.storyIds.length,
        },
      };
    },
    async commitMatches(plan, pages) {
      commitCalls += 1;
      assert.equal(plan.storyIds.length, 500);
      assert.equal(pages.length, Math.ceil(500 / missions.MISSION_MATCH_REBUILD_STORY_PAGE_SIZE));
      return {
        matchedStories: 0,
        evaluatedStories: 500,
        executionComplete: true,
        continuation: null,
        coverage: {
          partial: true,
          storyLimit: missions.MISSION_MATCH_REBUILD_STORY_LIMIT,
          storyWindowHasMore: true,
          storyPageSize: missions.MISSION_MATCH_REBUILD_STORY_PAGE_SIZE,
          pageTextCharacterLimit: missions.MISSION_MATCH_PAGE_TEXT_CHARACTER_LIMIT,
          evidencePerStoryLimit: missions.MISSION_MATCH_EVIDENCE_PER_STORY_LIMIT,
          evidenceTitleCharacters: missions.MISSION_MATCH_EVIDENCE_TITLE_CHARACTERS,
          evidenceBodyCharacters: missions.MISSION_MATCH_EVIDENCE_BODY_CHARACTERS,
          questionCharacters: 1_000,
          missionTermLimit: missions.MISSION_MATCH_TERM_LIMIT,
          missionTermCharacters: missions.MISSION_MATCH_TERM_CHARACTERS,
          ignoredMissionTerms: 0,
          ignoredMissionScopeValues: 0,
          questionTruncated: false,
          evidenceItemsConsidered: 4_000,
          storiesWithAdditionalEvidence: 500,
          excerptedBodies: 500,
        },
      };
    },
    async loadComputer(missionId, reason) {
      computerLoadCalls += 1;
      assert.equal(missionId, "mission-scale");
      assert.equal(reason, "test-envelope");
      return { missionId, reason, snapshotHash: "loaded-snapshot" };
    },
    async renderComputer(snapshot) {
      computerRenderCalls += 1;
      assert.equal(snapshot.snapshotHash, "loaded-snapshot");
      return { missionId: snapshot.missionId, reason: snapshot.reason, planHash: "prepared-plan" };
    },
    async commitComputer(plan) {
      computerCommitCalls += 1;
      assert.equal(plan.planHash, "prepared-plan");
      return { syncedAt: "2026-08-11T00:02:00.000Z", fileCount: 4 };
    },
  };
  const step = new CachedWorkflowStep();
  const result = await new MissionSprintWorkflow({
    exports: { MissionMaintenanceBoundary: boundary },
  }, { DB: {} }).run({
    payload: { mode: "match-maintenance", missionId: "mission-scale", reason: "test-envelope" },
    instanceId: "mission-match-scale",
    timestamp: new Date("2026-08-11T00:00:00.000Z"),
    workflowName: "mission",
  }, step);

  const pageCount = Math.ceil(500 / missions.MISSION_MATCH_REBUILD_STORY_PAGE_SIZE);
  assert.equal(pageInputs.length, pageCount);
  assert.ok(pageInputs.every((page) => page.storyIds.length <= missions.MISSION_MATCH_REBUILD_STORY_PAGE_SIZE));
  assert.equal(planCalls + pageInputs.length + commitCalls + computerLoadCalls + computerRenderCalls + computerCommitCalls, pageCount + 5);
  assert.equal(missions.MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_BASE, pageCount + 5);
  assert.equal(missions.MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_WORST_CASE, pageCount + 9);
  assert.equal(
    missions.MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_RESERVE,
    missions.MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_LIMIT - (pageCount + 9),
  );
  assert.equal(missions.MISSION_MATCH_MAINTENANCE_WORKFLOW_STEP_RESERVATION, pageCount + 5);
  const pageConfigs = step.doConfigs.filter(({ name }) => name.startsWith("evaluate Mission match page"));
  assert.deepEqual(pageConfigs.slice(0, 3).map(({ config }) => config.retries.limit), [1, 1, 1]);
  assert.ok(pageConfigs.slice(3).every(({ config }) => config.retries.limit === 0));
  assert.equal(
    step.doConfigs.find(({ name }) => name === "commit Mission Computer after match maintenance").config.retries.limit,
    1,
  );
  assert.equal(result.executionComplete, true);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.storyWindowHasMore, true);
  assert.equal(result.computerSync.files, 4);
});

test("queued Computer sync uses separate load, render, and retryable commit boundary calls", async () => {
  const loadedSnapshot = { missionId: "mission-computer", snapshotHash: "snapshot-once" };
  const preparedPlan = { missionId: "mission-computer", planHash: "hash-once", fullFiles: {} };
  let loadCalls = 0;
  let renderCalls = 0;
  let commitCalls = 0;
  const boundary = {
    async loadComputer(missionId, reason) {
      loadCalls += 1;
      assert.equal(missionId, "mission-computer");
      assert.equal(reason, "owner-sync");
      return loadedSnapshot;
    },
    async renderComputer(snapshot) {
      renderCalls += 1;
      assert.equal(snapshot, loadedSnapshot);
      return preparedPlan;
    },
    async commitComputer(plan) {
      commitCalls += 1;
      assert.equal(plan, preparedPlan);
      return { missionId: plan.missionId, syncedAt: "2026-08-11T00:03:00.000Z", fileCount: 9 };
    },
  };
  const step = new CachedWorkflowStep();
  const result = await new MissionSprintWorkflow({
    exports: { MissionMaintenanceBoundary: boundary },
  }, { DB: {} }).run({
    payload: { mode: "computer-sync", missionId: "mission-computer", reason: "owner-sync" },
    instanceId: "mission-computer-test",
    timestamp: new Date("2026-08-11T00:00:00.000Z"),
    workflowName: "mission",
  }, step);

  assert.equal(loadCalls, 1);
  assert.equal(renderCalls, 1);
  assert.equal(commitCalls, 1);
  assert.deepEqual(step.doCalls, [
    "load Mission Computer snapshot",
    "render Mission Computer plan",
    "commit Mission Computer",
  ]);
  assert.equal(step.doConfigs[2].config.retries.limit, 1);
  assert.equal(result.computer.fileCount, 9);
});
