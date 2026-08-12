import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;

class DurableObject {
  constructor(_ctx, env) {
    this.env = env;
  }
}

const tracing = {
  enterSpan: async (_name, operation) => operation({
    setAttribute() {},
    setStatus() {},
  }),
};

let missionComputer;
let memoryFixture = { nodes: [], edges: [], stats: {} };
let trackReadConcurrency = false;
let activeReads = 0;
let maximumConcurrentReads = 0;

async function observedRead(value) {
  if (!trackReadConcurrency) return value;
  activeReads += 1;
  maximumConcurrentReads = Math.max(maximumConcurrentReads, activeReads);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    return value;
  } finally {
    activeReads -= 1;
  }
}

try {
  Module._load = function load(request, parent, isMain) {
    if (request === "cloudflare:workers") return { DurableObject, tracing };
    if (request === "@cloudflare/computer") {
      return {
        getWorkspace() {},
        withWorkspace(Base) { return class WorkspaceTestDouble extends Base {}; },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const db = require("../.test-dist/db.js");
  db.getMission = async (_database, missionId) => observedRead({
    id: missionId,
    name: "Budget Mission",
    question: "What changed?",
    terms_json: "[]",
    source_scope_json: "[]",
    status: "active",
    priority: 1,
    cadence_minutes: 60,
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:00.000Z",
  });
  db.getMissionOperator = async () => observedRead(null);
  db.getMissionResearchState = async () => observedRead(null);
  db.listMissionEvents = async () => observedRead([]);
  db.listMissionMatches = async () => [];
  db.listMissionRuns = async () => observedRead([]);
  db.listSourceHealth = async () => observedRead([]);

  const missionSnapshot = require("../.test-dist/mission-snapshot.js");
  missionSnapshot.loadMissionMatchSnapshot = async () => observedRead({
    matches: [],
    firstSeenAtByStory: new Map(),
    evidenceByStory: new Map(),
    evidence: [],
    identity: {
      matchedStoriesAvailable: 0,
      lastMatchedAt: null,
      latestStoryChangedAt: null,
    },
    coverage: {
      matchLimit: 32,
      matchedStoriesIncluded: 0,
      matchedStoriesAvailable: 0,
      matchedStoriesOmitted: 0,
      hasMoreMatchedStories: false,
      evidencePerStoryLimit: 8,
      evidenceItemLimit: 32,
      evidenceItemsIncluded: 0,
      matchedStoriesWithEvidenceIncluded: 0,
      matchedStoriesWithAdditionalEvidence: 0,
      hasMoreEvidence: false,
      evidenceSelection: "breadth-first",
      evidenceCandidateRowsPerStoryLimit: 9,
      evidenceExcerptCharacters: 192,
      excerptedEvidenceItems: 0,
    },
  });

  const computerInputs = require("../.test-dist/mission-computer-inputs.js");
  computerInputs.loadMissionComputerCoreSnapshot = async (_database, missionId) => {
    const [mission, operator, research] = await Promise.all([
      observedRead({
        id: missionId,
        name: "Budget Mission",
        question: "What changed?",
        terms_json: "[]",
        source_scope_json: "[]",
        status: "active",
        priority: 1,
        cadence_minutes: 60,
        last_evaluated_at: null,
        created_at: "2026-08-09T00:00:00.000Z",
        updated_at: "2026-08-09T00:00:00.000Z",
      }),
      observedRead(null),
      observedRead(null),
    ]);
    return { mission, operator, research };
  };
  computerInputs.loadMissionComputerPeripheralSnapshot = async () => {
    await Promise.all([observedRead(null), observedRead(null), observedRead(null)]);
    return {
      events: [],
      runs: [],
      sourceHealth: [],
      coverage: {
        eventsIncluded: 0,
        hasMoreEvents: false,
        runsIncluded: 0,
        hasMoreRuns: false,
        sourcesIncluded: 0,
        hasMoreSources: false,
      },
    };
  };
  computerInputs.loadMissionComputerMemorySnapshot = async () => observedRead({
    ...memoryFixture,
    coverage: {
      nodesIncluded: memoryFixture.nodes.length,
      hasMoreNodes: false,
      edgesIncluded: memoryFixture.edges.length,
      hasMoreEdges: false,
    },
  });

  const deepResearch = require("../.test-dist/deep-research.js");
  const handoff = (missionId) => ({
    schemaVersion: "1",
    preparedAt: "2026-08-09T00:00:00.000Z",
    mission: {
      id: missionId,
      name: "Budget Mission",
      question: "What changed?",
      status: "active",
      mode: "watch",
      researchPolicy: "suggest",
      alertThreshold: 0.65,
      expectedNextEvent: "",
      expectedBy: null,
      outcomeStatus: "open",
      outcomeSummary: "",
      sprintPolicy: "manual",
      expectedEventStatus: "none",
    },
    researchBaseline: {
      currentThesis: "",
      reportSummary: "",
      openQuestions: [],
      reportTitle: "",
      reportUrl: null,
      confidence: null,
      lastResearchAt: null,
    },
    recommendation: { shouldEscalate: false, score: 0, reasons: [], whyNow: "" },
    currentState: [],
    sourceUrls: [],
    preferredDomains: [],
    coverageGaps: [],
    researchPlan: [],
    prompt: "",
  });
  deepResearch.buildDeepResearchHandoff = async (_env, missionId) => handoff(missionId);
  deepResearch.buildDeepResearchHandoffFromSnapshot = ({ mission }) => handoff(mission.id);

  missionComputer = require("../.test-dist/mission-computer.js");
} finally {
  Module._load = originalLoad;
}

const {
  appendMissionComputerNote,
  importMissionComputerFiles,
  requestMissionComputerSync,
  syncMissionComputer,
} = missionComputer;

class SqliteD1Statement {
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
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }

  async first() {
    if (this.query.includes("GROUP BY mission.id, mission.updated_at")) {
      return {
        mission_updated_at: "2026-08-09T00:00:00.000Z",
        operator_updated_at: null,
        research_updated_at: null,
        matched_stories_available: 0,
        last_matched_at: null,
        latest_story_changed_at: null,
      };
    }
    return this.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    return { success: true, results: this.database.prepare(this.query).all(...this.values), meta: {} };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new SqliteD1Statement(this.database, query);
  }
}

class FakeWorkspace {
  constructor() {
    this.files = new Map();
    this.directories = new Set(["/"]);
    this.writes = [];
    this.mkdirs = [];
    this.fs = {
      mkdir: async (path) => {
        this.mkdirs.push(path);
        this.directories.add(path);
      },
      writeFile: async (path, content) => {
        const text = String(content);
        this.writes.push({ path, content: text, bytes: new TextEncoder().encode(text).byteLength });
        this.files.set(path, text);
      },
      readFile: async (path) => {
        if (!this.files.has(path)) {
          const error = new Error(`Missing ${path}`);
          error.code = "ENOENT";
          throw error;
        }
        return this.files.get(path);
      },
      readdir: async (path) => {
        const prefix = path === "/" ? "/" : `${path.replace(/\/$/, "")}/`;
        const entries = new Map();
        for (const filePath of this.files.keys()) {
          if (!filePath.startsWith(prefix)) continue;
          const relative = filePath.slice(prefix.length);
          if (!relative) continue;
          const [name, ...rest] = relative.split("/");
          entries.set(name, { name, isDirectory: rest.length > 0 });
        }
        return [...entries.values()];
      },
      rm: async () => {},
      grep: async () => [],
    };
  }
}

function fixture(computerLimit) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE usage_daily (
      day TEXT NOT NULL,
      dimension TEXT NOT NULL,
      units REAL NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(day, dimension)
    );
  `);
  database.prepare("INSERT INTO settings(key, value) VALUES ('budget_profile', 'custom')").run();
  database.prepare("INSERT INTO settings(key, value) VALUES ('budget_custom_limits', ?)").run(JSON.stringify({
    computer_sync_bytes_day: computerLimit,
  }));
  const workspace = new FakeWorkspace();
  return {
    database,
    workspace,
    env: {
      DB: new SqliteD1(database),
      RUNTIME_WORKSPACE: { async forMission() { return workspace; } },
    },
  };
}

function usage(database, dimension) {
  return Number(database.prepare("SELECT units FROM usage_daily WHERE dimension = ?").get(dimension)?.units ?? 0);
}

function computerUsage(database) {
  return usage(database, "computer_sync_bytes");
}

function writtenBytes(workspace) {
  return workspace.writes.reduce((total, write) => total + write.bytes, 0);
}

test("zero Computer capacity blocks sync, note, and Companion import before any workspace mutation", async () => {
  const state = fixture(0);

  const summary = await syncMissionComputer(state.env, "mission-zero", "budget-test");
  assert.equal(summary.fileCount, 0);
  assert.equal(state.workspace.writes.length, 0);
  assert.equal(state.workspace.mkdirs.length, 0);

  await assert.rejects(
    appendMissionComputerNote(state.env, "mission-zero", { title: "Blocked", content: "No write" }),
    (error) => error?.name === "BudgetDeferredError" && error?.dimension === "computer_sync_bytes",
  );
  await assert.rejects(
    importMissionComputerFiles(state.env, "mission-zero", { files: { "notes/import.md": "No write" }, source: "companion:test" }),
    (error) => error?.name === "BudgetDeferredError" && error?.dimension === "computer_sync_bytes",
  );

  assert.equal(state.workspace.writes.length, 0);
  assert.equal(state.workspace.mkdirs.length, 0);
  assert.equal(computerUsage(state.database), 0);
});

test("managed sync reserves exactly every changed write, including generated README and metadata files", async () => {
  const state = fixture(10 * 1024 * 1024);
  const result = await syncMissionComputer(state.env, "mission-sync", "budget-test");
  const paths = new Set(state.workspace.writes.map((write) => write.path));

  assert.equal(result.syncedAt !== null, true);
  assert.equal(paths.has("/README.md"), true);
  assert.equal(paths.has("/notes/README.md"), true);
  assert.equal(paths.has("/results/README.md"), true);
  assert.equal(paths.has("/state/latest-sync.json"), true);
  assert.equal(paths.has("/system/manifest.json"), true);
  assert.equal(computerUsage(state.database), writtenBytes(state.workspace));
});

test("Mission sync phases keep top-level D1 read fan-out within six connections", async () => {
  const state = fixture(10 * 1024 * 1024);
  trackReadConcurrency = true;
  activeReads = 0;
  maximumConcurrentReads = 0;
  try {
    await syncMissionComputer(state.env, "mission-concurrency", "concurrency-test");
    assert.equal(maximumConcurrentReads, 6);
    assert.ok(maximumConcurrentReads <= 6);
  } finally {
    trackReadConcurrency = false;
    activeReads = 0;
  }
});

test("Cloud Computer refresh queues the three-step Workflow and cannot use the combined path", async () => {
  const state = fixture(10 * 1024 * 1024);
  const starts = [];
  state.env.MISSION_WORKFLOW = {
    async create(input) {
      starts.push(input);
      return { id: input.id };
    },
  };

  const queued = await requestMissionComputerSync(state.env, "mission-queued", "owner-sync");
  assert.equal(queued.status, "queued");
  assert.match(queued.workflowId, /^mission-computer-mission-queued-/);
  assert.deepEqual(starts[0].params, {
    mode: "computer-sync",
    missionId: "mission-queued",
    reason: "owner-sync",
  });
  assert.equal(computerUsage(state.database), 0);
  assert.equal(usage(state.database, "workflow_steps"), 3);
  assert.equal(state.workspace.writes.length, 0);
  await assert.rejects(
    syncMissionComputer(state.env, "mission-queued", "owner-sync"),
    /must use the bounded prepare and commit Workflow steps/,
  );
});

test("a denied full sync charges only the exact compact candidate", async () => {
  memoryFixture = {
    nodes: Array.from({ length: 8 }, (_, index) => ({
      id: `node-${index}`,
      node_type: "finding",
      label: `Finding ${index}`,
      summary: `Evidence ${index} ${"x".repeat(300)}`,
      status: "active",
      importance: 1 - index / 1_000,
      confidence: 0.8,
      occurred_at: null,
      valid_from: null,
      valid_to: null,
      source_ref: `item:${index}`,
      aliases_json: "[]",
    })),
    edges: [],
    stats: {},
  };
  try {
    const state = fixture(10_000);
    await syncMissionComputer(state.env, "mission-compact", "budget-test");

    const manifest = JSON.parse(state.workspace.files.get("/system/manifest.json"));
    const compactNodes = state.workspace.files.get("/memory/nodes.ndjson").trim().split("\n");
    assert.equal(manifest.syncMode, "compact");
    assert.equal(compactNodes.length, 4);
    assert.equal(computerUsage(state.database), writtenBytes(state.workspace));
    assert.ok(computerUsage(state.database) < 10_000);
  } finally {
    memoryFixture = { nodes: [], edges: [], stats: {} };
  }
});

test("note appends reserve each complete rewritten file body", async () => {
  const state = fixture(10 * 1024 * 1024);

  await appendMissionComputerNote(state.env, "mission-note", { title: "Findings", content: "First café note", file: "findings.md" });
  await appendMissionComputerNote(state.env, "mission-note", { title: "Ignored after creation", content: "Second note", file: "findings.md" });

  assert.equal(state.workspace.writes.length, 2);
  assert.equal(state.workspace.writes.every((write) => write.path === "/notes/findings.md"), true);
  assert.equal(computerUsage(state.database), writtenBytes(state.workspace));
});

test("Companion imports coalesce duplicate paths and reserve file bodies plus push metadata once", async () => {
  const state = fixture(10 * 1024 * 1024);
  const result = await importMissionComputerFiles(state.env, "mission-import", {
    files: {
      "notes/shared.md": "superseded",
      "/notes/shared.md": "kept ✓",
    },
    source: "companion:test",
  });

  assert.deepEqual(result.written, ["/notes/shared.md"]);
  assert.deepEqual(state.workspace.writes.map((write) => write.path), [
    "/notes/shared.md",
    "/system/last-local-push.json",
  ]);
  assert.equal(state.workspace.files.get("/notes/shared.md"), "kept ✓");
  assert.equal(computerUsage(state.database), writtenBytes(state.workspace));
  const metadata = JSON.parse(state.workspace.files.get("/system/last-local-push.json"));
  assert.equal(metadata.totalBytes, new TextEncoder().encode("kept ✓").byteLength);
});
