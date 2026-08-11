import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;

class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

let boundaryModule;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "cloudflare:workers") {
      return {
        WorkerEntrypoint,
        tracing: {
          enterSpan: async (_name, operation) => operation({ setAttribute() {}, setStatus() {} }),
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  boundaryModule = require("../.test-dist/source-run-boundary.js");
} finally {
  Module._load = originalLoad;
}

const db = require("../.test-dist/db.js");
const registry = require("../.test-dist/sources/registry.js");
const access = require("../.test-dist/sources/access.js");
const {
  runSourceAcrossBoundary,
  runSourceWithBoundaryFallback,
  runWorkflowSourceAcrossBoundary,
  SourceRunBoundary,
} = boundaryModule;

function sourceRecord(overrides = {}) {
  return {
    id: "source-id",
    name: "Boundary source",
    kind: "hackernews",
    config_json: JSON.stringify({ token: "must-not-cross-rpc" }),
    enabled: 1,
    schedule_minutes: 60,
    weight: 1,
    health_score: 1,
    last_run_at: null,
    last_success_at: null,
    last_error: null,
    created_at: "2026-08-10T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

test("SourceRunBoundary re-reads by ID and returns only bounded structured outcomes", async () => {
  const originals = {
    getSource: db.getSource,
    reconcile: registry.reconcileOrphanedPendingSourceRun,
    runSource: registry.runSource,
    sourceAccess: access.sourceRuntimeAccess,
  };
  let currentSource = sourceRecord({ name: "n".repeat(400) });
  let capturedOptions;
  let reconciliations = 0;
  db.getSource = async (_database, sourceId) => sourceId === "source-id" ? currentSource : null;
  registry.reconcileOrphanedPendingSourceRun = async () => {
    reconciliations += 1;
    return false;
  };
  access.sourceRuntimeAccess = () => ({ runnable: true, detail: "Runnable" });
  registry.runSource = async (_source, _env, options) => {
    capturedOptions = options;
    return {
      runId: "source-run-id",
      count: 49,
      provider: "hackernews-firebase",
      status: "queued",
      collectionPartial: false,
    };
  };

  try {
    const boundary = new SourceRunBoundary({}, { DB: {} });
    const success = await boundary.runSource("source-id", {
      resumeOutbox: false,
      config_json: "must-not-cross-rpc",
      token: "must-not-cross-rpc",
    });
    assert.equal(success.ok, true);
    assert.deepEqual(capturedOptions, { resumeOutbox: false });
    assert.deepEqual(success.source, { name: "n".repeat(300), kind: "hackernews" });
    assert.equal(JSON.stringify(success).includes("must-not-cross-rpc"), false);

    capturedOptions = undefined;
    const directFallback = await runSourceWithBoundaryFallback(undefined, currentSource, { DB: {} }, {
      resumeOutbox: false,
    });
    assert.equal(directFallback.runId, "source-run-id");
    assert.deepEqual(capturedOptions, { resumeOutbox: false }, "self-host execution falls back to direct collection");

    const missing = await boundary.runSource("missing");
    assert.deepEqual(missing, {
      ok: false,
      kind: "unavailable",
      reason: "missing",
      source: undefined,
      code: undefined,
      binding: undefined,
      error: { name: "SourceUnavailableError", message: "Source not found: missing" },
    });
    const invalid = await boundary.runSource(42);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.kind, "error");
    assert.equal(invalid.error.message, "Source id is invalid");

    currentSource = sourceRecord({ enabled: 0 });
    const disabled = await boundary.runSource("source-id");
    assert.equal(disabled.ok, false);
    assert.equal(disabled.kind, "unavailable");
    assert.equal(disabled.reason, "disabled");
    assert.equal(reconciliations, 1);

    currentSource = sourceRecord({ kind: "openalex" });
    access.sourceRuntimeAccess = () => ({
      runnable: false,
      code: "OPENALEX_API_KEY_REQUIRED",
      detail: "Optional OpenAlex key is not configured",
      openalex: { binding: "OPENALEX_API_KEY" },
    });
    const credential = await boundary.runSource("source-id");
    assert.equal(credential.ok, false);
    assert.equal(credential.kind, "unavailable");
    assert.equal(credential.reason, "credential");
    assert.equal(credential.code, "OPENALEX_API_KEY_REQUIRED");
    assert.equal(credential.binding, "OPENALEX_API_KEY");
    assert.equal(reconciliations, 2);

    currentSource = sourceRecord();
    access.sourceRuntimeAccess = () => ({ runnable: true, detail: "Runnable" });
    const longName = "N".repeat(150);
    const longMessage = "M".repeat(750);
    registry.runSource = async () => {
      const error = new Error(longMessage);
      error.name = longName;
      throw error;
    };
    const bounded = await boundary.runSource("source-id");
    assert.equal(bounded.ok, false);
    assert.equal(bounded.kind, "error");
    assert.equal(bounded.error.name.length, 100);
    assert.equal(bounded.error.message.length, 500);

    registry.runSource = async () => { throw new Error("Too many subrequests."); };
    const capacity = await boundary.runSource("source-id");
    assert.deepEqual(capacity, {
      ok: false,
      kind: "capacity",
      error: { name: "Error", message: "Too many subrequests." },
    });
    assert.deepEqual(await runWorkflowSourceAcrossBoundary({ runSource: async () => capacity }, "source-id"), {
      kind: "capacity",
      error: { name: "Error", message: "Too many subrequests." },
    });
    const loopLimitError = Object.assign(new Error("Worker hit loop limit"), { code: 1019 });
    assert.deepEqual(await runWorkflowSourceAcrossBoundary({
      runSource: async () => { throw loopLimitError; },
    }, "source-id"), {
      kind: "capacity",
      error: { name: "Error", message: "Worker hit loop limit" },
    });

    await assert.rejects(
      runSourceAcrossBoundary({
        runSource: async () => ({
          ok: false,
          kind: "error",
          error: { name: "BoundaryFailure", message: "bounded failure" },
        }),
      }, "source-id"),
      (error) => error?.name === "BoundaryFailure" && error.message === "bounded failure",
    );
  } finally {
    db.getSource = originals.getSource;
    registry.reconcileOrphanedPendingSourceRun = originals.reconcile;
    registry.runSource = originals.runSource;
    access.sourceRuntimeAccess = originals.sourceAccess;
  }
});
