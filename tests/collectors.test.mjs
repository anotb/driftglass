import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { claimCollectorJob, heartbeatCollector } = require("../.test-dist/db.js");

class RecordingD1Statement {
  constructor(database, query) {
    this.database = database;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    this.database.calls.push({ kind: "run", query: this.query, values: this.values });
    if (/UPDATE collectors SET/.test(this.query)) {
      const [lastSeenAt, version, capabilitiesJson, detailsJson, collectorId] = this.values;
      assert.equal(collectorId, this.database.collector.id);
      this.database.collector.status = "online";
      this.database.collector.last_seen_at = lastSeenAt;
      if (version !== null) this.database.collector.version = version;
      if (capabilitiesJson !== null) this.database.collector.capabilities_json = capabilitiesJson;
      if (detailsJson !== null) this.database.collector.details_json = detailsJson;
    }
    return { success: true, results: [], meta: { changes: 1 } };
  }

  async first() {
    this.database.calls.push({ kind: "first", query: this.query, values: this.values });
    return this.database.firstResults.shift() ?? null;
  }
}

class RecordingD1 {
  constructor() {
    this.collector = {
      id: "companion-1",
      status: "offline",
      last_seen_at: null,
      version: null,
      capabilities_json: "[]",
      details_json: "{}",
    };
    this.calls = [];
    this.firstResults = [];
  }

  prepare(query) {
    return new RecordingD1Statement(this, query);
  }
}

test("collector heartbeats preserve the last advertised catalog when details are omitted", async () => {
  const db = new RecordingD1();
  const advertised = {
    catalog: [{ site: "x", command: "bookmarks", title: "X bookmarks" }],
    health: { x: "ready" },
  };

  await heartbeatCollector(db, {
    collectorId: db.collector.id,
    version: "0.9.0",
    capabilities: ["x.bookmarks"],
    details: advertised,
  });
  await heartbeatCollector(db, { collectorId: db.collector.id });

  assert.deepEqual(JSON.parse(db.collector.details_json), advertised);
  assert.equal(db.collector.capabilities_json, JSON.stringify(["x.bookmarks"]));
  const omittedDetailsUpdate = db.calls.at(-1);
  assert.match(omittedDetailsUpdate.query, /details_json = COALESCE\(\?, details_json\)/);
  assert.equal(omittedDetailsUpdate.values[3], null);
});

test("repeated empty job polls claim only jobs and never update collector heartbeat state", async () => {
  const db = new RecordingD1();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(await claimCollectorJob(db, db.collector.id, ["x.bookmarks"]), null);
  }

  assert.equal(db.calls.length, 3);
  assert.ok(db.calls.every((call) => /UPDATE collector_jobs SET/.test(call.query)));
  assert.ok(db.calls.every((call) => !/UPDATE collectors SET/.test(call.query)));
  assert.equal(db.collector.status, "offline");
  assert.equal(db.collector.last_seen_at, null);

  const source = await readFile(new URL("../src/collectors.ts", import.meta.url), "utf8");
  const pollStart = source.indexOf('if (path === "/collector/jobs" && request.method === "GET")');
  const pollEnd = source.indexOf("const match = path.match", pollStart);
  assert.ok(pollStart >= 0 && pollEnd > pollStart, "collector jobs route must remain discoverable");
  const pollRoute = source.slice(pollStart, pollEnd);
  assert.match(pollRoute, /claimCollectorJob/);
  assert.doesNotMatch(pollRoute, /heartbeatCollector/);
});

test("Companion workspace GET is explicitly structured as an operational first-pull sync", async () => {
  const source = await readFile(new URL("../src/collectors.ts", import.meta.url), "utf8");
  const start = source.indexOf("const workspaceMatch");
  const end = source.indexOf('if (workspaceMatch && request.method === "PUT")', start);
  const route = source.slice(start, end);
  assert.match(route, /requireCollectorCapability\(collector, WORKSPACE_MIRROR_CAPABILITY\)/);
  assert.match(route, /companion-workspace-pull/);
  assert.match(route, /requestMissionComputerSync/);
  assert.match(route, /status:\s*202/);
  assert.match(route, /synchronized/);
});

test("collector heartbeat reports cannot expand pairing-time grants", async () => {
  const source = await readFile(new URL("../src/collectors.ts", import.meta.url), "utf8");
  const start = source.indexOf('if (path === "/collector/heartbeat"');
  const end = source.indexOf('if (path === "/collector/workspaces"', start);
  const route = source.slice(start, end);
  assert.match(route, /capabilities: collector\.capabilities/);
  assert.doesNotMatch(route, /READ_ONLY_CAPABILITIES\.includes/);
});

test("Companion result dispatch validates bounds and reconciles persisted dispatch before Queue send", async () => {
  const source = await readFile(new URL("../src/collectors.ts", import.meta.url), "utf8");
  const routeStart = source.indexOf("const match = path.match");
  const route = source.slice(routeStart);
  const validation = route.indexOf("relayResultValidationError(result)");
  const jobLookup = route.indexOf("SELECT source_id, source_run_id, status, result_json");
  const persistedDispatch = route.indexOf("if (storedSummary?.dispatch)");
  const untrackedFailure = route.indexOf("if (!successfulResult || !fingerprint)");
  const queueSend = route.indexOf("await enqueueIngestMessages");
  assert.ok(validation >= 0 && validation < jobLookup, "251+ items must be rejected before job/source-run mutation");
  assert.ok(persistedDispatch >= 0 && persistedDispatch < queueSend, "accepted dispatch metadata must short-circuit Queue retries");
  assert.ok(persistedDispatch < untrackedFailure, "the Companion's follow-up ok:false must reconcile or reject stored dispatch state before failure completion");
  assert.doesNotMatch(route, /normalizeCompanionItems\([^)]*\)\.slice\(0,\s*250\)/);
});

test("deduplicated Collector runs return the canonical winning run pointer", async () => {
  const source = await readFile(new URL("../src/sources/registry.ts", import.meta.url), "utf8");
  assert.match(source, /canonicalSourceRunId: job\.sourceRunId/);
  assert.match(source, /if \(canonicalSourceRunId !== runId\)/);
  assert.match(source, /runId: canonicalSourceRunId,[\s\S]*requestedRunId: runId,[\s\S]*deduplicated: true/);
});
