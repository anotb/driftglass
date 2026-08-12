import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
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

let commitMissionComputerSync;
let loadMissionComputerSyncSnapshot;
let prepareMissionComputerSync;
let renderMissionComputerSyncPlan;
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
  ({
    commitMissionComputerSync,
    loadMissionComputerSyncSnapshot,
    prepareMissionComputerSync,
    renderMissionComputerSyncPlan,
  } = require("../.test-dist/mission-computer.js"));
} finally {
  Module._load = originalLoad;
}

const migrationDirectory = new URL("../migrations/", import.meta.url);
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
const migrations = await Promise.all(migrationNames.map(async (name) => ({
  name,
  sql: await readFile(new URL(name, migrationDirectory), "utf8"),
})));

class CountingStatement {
  constructor(owner, query) {
    this.owner = owner;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    this.owner.record("run", this);
    const startedAt = performance.now();
    const result = this.owner.database.prepare(this.query).run(...this.values);
    this.owner.databaseMilliseconds += performance.now() - startedAt;
    return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
  }

  async first() {
    this.owner.record("first", this);
    const startedAt = performance.now();
    const result = this.owner.database.prepare(this.query).get(...this.values) ?? null;
    this.owner.databaseMilliseconds += performance.now() - startedAt;
    const instrumentationStartedAt = performance.now();
    this.owner.recordResults(result ? [result] : []);
    this.owner.instrumentationMilliseconds += performance.now() - instrumentationStartedAt;
    return result;
  }

  async all() {
    this.owner.record("all", this);
    const startedAt = performance.now();
    const results = this.owner.database.prepare(this.query).all(...this.values);
    this.owner.databaseMilliseconds += performance.now() - startedAt;
    const instrumentationStartedAt = performance.now();
    this.owner.recordResults(results);
    this.owner.instrumentationMilliseconds += performance.now() - instrumentationStartedAt;
    return { success: true, results, meta: {} };
  }
}

class CountingD1 {
  constructor(database) {
    this.database = database;
    this.queryCount = 0;
    this.calls = [];
    this.maxRowsReturned = 0;
    this.totalRowsReturned = 0;
    this.maxResultBytes = 0;
    this.evidenceTextCharactersReturned = 0;
    this.databaseMilliseconds = 0;
    this.instrumentationMilliseconds = 0;
  }

  prepare(query) {
    return new CountingStatement(this, query);
  }

  record(method, statement) {
    this.queryCount += 1;
    this.calls.push({ method, query: statement.query, values: [...statement.values] });
  }

  recordResults(results) {
    this.maxRowsReturned = Math.max(this.maxRowsReturned, results.length);
    this.totalRowsReturned += results.length;
    this.maxResultBytes = Math.max(
      this.maxResultBytes,
      Buffer.byteLength(JSON.stringify(results), "utf8"),
    );
    for (const row of results) {
      if (Object.hasOwn(row, "body_truncated")) {
        this.evidenceTextCharactersReturned += String(row.text ?? "").length;
      }
    }
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class FakeWorkspace {
  constructor() {
    this.files = new Map();
    this.writes = [];
    this.fs = {
      mkdir: async () => {},
      writeFile: async (path, content) => {
        const text = String(content);
        this.files.set(path, text);
        this.writes.push({ path, bytes: Buffer.byteLength(text, "utf8") });
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

function insertEnvelope(database, options = {}) {
  const storyCount = options.storyCount ?? 81;
  const evidencePerStory = options.evidencePerStory ?? 17;
  const emptyLastStory = options.emptyLastStory ?? true;
  const distinctEvidenceSources = options.distinctEvidenceSources ?? false;
  const missionId = "mission-envelope";
  const now = "2026-08-11T12:00:00.000Z";
  database.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('budget_profile', 'custom')").run();
  database.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('budget_custom_limits', ?)").run(JSON.stringify({
    computer_sync_bytes_day: 20 * 1024 * 1024,
  }));
  database.prepare(
    `INSERT INTO missions(
       id, name, question, terms_json, source_scope_json, status, priority,
       cadence_minutes, created_at, updated_at
     ) VALUES (?, 'Large source Mission', 'What changed across the source set?', '["change"]', '[]', 'active', 1, 60, ?, ?)`,
  ).run(missionId, now, now);
  database.prepare(
    `UPDATE missions SET name = ?, question = ?, terms_json = ?, source_scope_json = ? WHERE id = ?`,
  ).run(
    "Mission ".repeat(200),
    "Question ".repeat(500),
    JSON.stringify(Array.from({ length: 100 }, () => "term".repeat(50))),
    JSON.stringify(Array.from({ length: 100 }, () => "source".repeat(50))),
    missionId,
  );
  database.prepare(
    `INSERT INTO mission_operators(mission_id, expected_next_event, outcome_summary)
     VALUES (?, ?, ?)`,
  ).run(missionId, "expected ".repeat(1_000), "outcome ".repeat(1_000));
  database.prepare(
    `INSERT INTO mission_research_state(
       mission_id, current_thesis, report_summary, open_questions_json, report_title, report_url
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    missionId,
    "thesis ".repeat(2_000),
    "summary ".repeat(2_000),
    JSON.stringify(Array.from({ length: 100 }, () => "question".repeat(100))),
    "title ".repeat(500),
    `https://example.com/${"u".repeat(2_000)}`,
  );
  database.prepare(
    `INSERT INTO sources(id, name, kind, config_json, enabled, schedule_minutes, weight, health_score)
     VALUES ('source-envelope', ?, ?, '{}', 1, 60, 1, 1)`,
  ).run("S".repeat(200), "K".repeat(200));
  const insertSource = database.prepare(
    `INSERT INTO sources(
       id, name, kind, config_json, enabled, schedule_minutes, weight,
       health_score, last_error
     ) VALUES (?, ?, ?, '{}', 1, 60, 1, ?, ?)`,
  );
  for (let sourceIndex = 0; sourceIndex < 48; sourceIndex += 1) {
    insertSource.run(
      `source-${String(sourceIndex).padStart(2, "0")}`,
      `Source ${sourceIndex} ${"N".repeat(180)}`,
      "kind".repeat(40),
      sourceIndex / 100,
      "source failure detail ".repeat(100),
    );
  }

  const insertEvent = database.prepare(
    `INSERT INTO mission_events(
       id, mission_id, event_type, title, detail, metadata_json, occurred_at, created_at, dedupe_key
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let eventIndex = 0; eventIndex < 17; eventIndex += 1) {
    const eventAt = new Date(Date.parse(now) - eventIndex * 1_000).toISOString();
    insertEvent.run(
      `event-${eventIndex}`,
      missionId,
      eventIndex === 0 ? "signal" : "note",
      `Event ${eventIndex} ${"E".repeat(500)}`,
      "event detail ".repeat(700),
      JSON.stringify({ blob: "m".repeat(2_000) }),
      eventAt,
      eventAt,
      `dedupe-${eventIndex}-${"d".repeat(300)}`,
    );
  }

  const insertRun = database.prepare(
    `INSERT INTO mission_runs(
       id, mission_id, workflow_id, status, source_ids_json, result_json, error,
       started_at, completed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let runIndex = 0; runIndex < 9; runIndex += 1) {
    const runAt = new Date(Date.parse(now) - runIndex * 1_000).toISOString();
    insertRun.run(
      `run-${runIndex}`,
      missionId,
      `workflow-${runIndex}-${"w".repeat(300)}`,
      runIndex === 0 ? "partial" : "complete",
      JSON.stringify(Array.from({ length: 48 }, (_, index) => `source-${index}`)),
      JSON.stringify({ blob: "r".repeat(5_000) }),
      "run error ".repeat(100),
      runAt,
      runAt,
      runAt,
      runAt,
    );
  }

  const insertMemoryNode = database.prepare(
    `INSERT INTO memory_nodes(
       id, node_type, canonical_key, label, summary, aliases_json, metadata_json,
       importance, confidence, occurred_at, first_seen_at, last_seen_at, updated_at,
       status, source_ref, valid_from, valid_to
     ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 0.8, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
  );
  insertMemoryNode.run(
    "memory-mission",
    "mission",
    "mission:mission-envelope",
    "Mission memory",
    "mission summary ".repeat(600),
    JSON.stringify(["a".repeat(1_000)]),
    1,
    now,
    now,
    now,
    now,
    `mission:${missionId}`,
    now,
  );
  for (let nodeIndex = 0; nodeIndex < 17; nodeIndex += 1) {
    insertMemoryNode.run(
      `memory-${nodeIndex}`,
      "finding",
      `finding:${nodeIndex}`,
      `Finding ${nodeIndex} ${"L".repeat(400)}`,
      "memory summary ".repeat(600),
      JSON.stringify(["a".repeat(1_000)]),
      0.99 - nodeIndex / 100,
      now,
      now,
      now,
      now,
      `mission:${missionId}`,
      now,
    );
  }
  const insertMemoryEdge = database.prepare(
    `INSERT INTO memory_edges(
       id, from_node_id, to_node_id, relation, weight, confidence,
       evidence_json, metadata_json, first_seen_at, last_seen_at, updated_at,
       status, rationale
     ) VALUES (?, ?, ?, ?, ?, 0.8, ?, '{}', ?, ?, ?, 'active', ?)`,
  );
  for (let edgeIndex = 0; edgeIndex < 17; edgeIndex += 1) {
    insertMemoryEdge.run(
      `edge-seed-${edgeIndex}`,
      "memory-mission",
      `memory-${edgeIndex}`,
      "relevant_to",
      1 - edgeIndex / 100,
      JSON.stringify(["e".repeat(1_000)]),
      now,
      now,
      now,
      "edge rationale ".repeat(200),
    );
  }
  for (let edgeIndex = 0; edgeIndex < 20; edgeIndex += 1) {
    insertMemoryEdge.run(
      `edge-inner-${edgeIndex}`,
      `memory-${edgeIndex % 15}`,
      `memory-${(edgeIndex + 1) % 15}`,
      `related_${edgeIndex}`,
      0.8 - edgeIndex / 100,
      JSON.stringify(["e".repeat(1_000)]),
      now,
      now,
      now,
      "edge rationale ".repeat(200),
    );
  }

  const insertStory = database.prepare(
    `INSERT INTO stories(
       id, canonical_key, title, summary, status, first_seen_at, last_changed_at,
       score, relevance, novelty, importance, confidence, source_count,
       metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'developing', ?, ?, ?, 1, 1, 1, 0.9, ?, '{}', ?, ?)`,
  );
  const insertMatch = database.prepare(
    `INSERT INTO mission_story_matches(
       mission_id, story_id, match_score, matched_terms_json, first_matched_at, last_matched_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const maximumMatchedTerms = JSON.stringify(
    Array.from({ length: 100 }, (_, index) => `${index}-${"term".repeat(50)}`),
  );
  const insertItem = database.prepare(
    `INSERT INTO items(
       id, source_id, external_id, url, canonical_url, title, text, author,
       published_at, observed_at, content_hash, access_class, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', ?, ?)`,
  );
  const linkItem = database.prepare(
    `INSERT INTO story_items(story_id, item_id, relationship, created_at)
     VALUES (?, ?, 'coverage', ?)`,
  );
  const maxMetadata = JSON.stringify({
    provider: "P".repeat(200),
    sourceKind: "Q".repeat(200),
    platform: "L".repeat(200),
    repo: "R".repeat(200),
    version: "V".repeat(200),
    ignored: "not copied into the snapshot",
  });

  for (let storyIndex = 0; storyIndex < storyCount; storyIndex += 1) {
    const storyId = `story-${String(storyIndex).padStart(3, "0")}`;
    const changedAt = new Date(Date.parse(now) - storyIndex * 1_000).toISOString();
    insertStory.run(
      storyId,
      `key-${storyIndex}`,
      `${String(storyIndex).padStart(3, "0")}${"T".repeat(597)}`,
      `${String(storyIndex).padStart(3, "0")}${"M".repeat(697)}`,
      changedAt,
      changedAt,
      1 - storyIndex / 1_000,
      evidencePerStory,
      changedAt,
      changedAt,
    );
    insertMatch.run(missionId, storyId, 1 - storyIndex / 1_000, maximumMatchedTerms, now, changedAt);
    if (emptyLastStory && storyIndex === storyCount - 1) continue;

    for (let evidenceIndex = 0; evidenceIndex < evidencePerStory; evidenceIndex += 1) {
      const itemId = `item-${String(storyIndex).padStart(3, "0")}-${String(evidenceIndex).padStart(2, "0")}`;
      const itemAt = new Date(Date.parse(now) - evidenceIndex * 1_000).toISOString();
      const urlPrefix = `https://source.example/${itemId}/`;
      const url = `${urlPrefix}${"u".repeat(2_000 - urlPrefix.length)}`;
      const body = evidenceIndex === 0 ? "B".repeat(500_000) : "b".repeat(3_000);
      insertItem.run(
        itemId,
        distinctEvidenceSources ? `source-${String(evidenceIndex).padStart(2, "0")}` : "source-envelope",
        itemId,
        url,
        url,
        `${itemId}${"I".repeat(600 - itemId.length)}`,
        body,
        "A".repeat(300),
        itemAt,
        itemAt,
        `hash-${storyIndex}-${evidenceIndex}`,
        maxMetadata,
        itemAt,
      );
      linkItem.run(storyId, itemId, itemAt);
    }
  }
  return missionId;
}

function fixture(options = {}) {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration.sql);
  const missionId = insertEnvelope(database, options);
  const d1 = new CountingD1(database);
  const workspace = new FakeWorkspace();
  return {
    database,
    d1,
    missionId,
    workspace,
    env: {
      DB: d1,
      RUNTIME_WORKSPACE: { async forMission() { return workspace; } },
    },
  };
}

test("maximum Mission Computer snapshot stays broad, bounded, and below the Free D1 statement ceiling", async (t) => {
  const state = fixture();
  const loadStartedAt = performance.now();
  const loadedSnapshot = await loadMissionComputerSyncSnapshot(state.env, state.missionId, "envelope-test");
  const loadMilliseconds = performance.now() - loadStartedAt;
  const loadStatements = state.d1.queryCount;
  const serializedSnapshot = JSON.stringify(loadedSnapshot);
  const snapshotBytes = Buffer.byteLength(serializedSnapshot, "utf8");
  const renderStartedAt = performance.now();
  const preparedPlan = await renderMissionComputerSyncPlan(JSON.parse(serializedSnapshot));
  const renderMilliseconds = performance.now() - renderStartedAt;
  const serializedPlan = JSON.stringify(preparedPlan);
  const planBytes = Buffer.byteLength(serializedPlan, "utf8");
  const plan = JSON.parse(serializedPlan);
  const commitStartedAt = performance.now();
  const summary = await commitMissionComputerSync(state.env, plan);
  const commitMilliseconds = performance.now() - commitStartedAt;
  const commitStatements = state.d1.queryCount - loadStatements;

  assert.equal(summary.storyCount, 32);
  assert.equal(summary.evidenceCount, 32);
  assert.equal(loadStatements, 12);
  assert.equal(commitStatements, 4);
  assert.equal(state.d1.queryCount, 16);
  assert.ok(state.d1.queryCount < 46, `${state.d1.queryCount} D1 statements crossed the Free-safe ceiling`);
  assert.ok(snapshotBytes < 150_000, `${snapshotBytes} serialized snapshot bytes`);
  assert.ok(planBytes < 400_000, `${planBytes} serialized plan bytes`);
  assert.equal(state.d1.maxRowsReturned, 32 * 9);
  assert.ok(state.d1.totalRowsReturned <= 500);
  assert.equal(state.d1.evidenceTextCharactersReturned, 32 * 192);
  assert.ok(state.d1.maxResultBytes < 45_000);
  assert.equal(
    state.d1.calls.some((call) => /FROM stories WHERE id = \?/i.test(call.query)),
    false,
    "Mission sync must not restore the Story N+1 read",
  );

  const latestSync = JSON.parse(state.workspace.files.get("/state/latest-sync.json"));
  const manifest = JSON.parse(state.workspace.files.get("/system/manifest.json"));
  const handoff = JSON.parse(state.workspace.files.get("/handoffs/deep-research.json"));
  const missionState = JSON.parse(state.workspace.files.get("/state/mission.json"));
  const operatorState = JSON.parse(state.workspace.files.get("/state/operator.json"));
  const researchState = JSON.parse(state.workspace.files.get("/state/research.json"));
  const missionMarkdown = state.workspace.files.get("/mission.md");
  const evidenceText = state.workspace.files.get("/evidence/index.ndjson");
  const evidence = evidenceText.trim().split("\n").map((line) => JSON.parse(line));
  const stories = state.workspace.files.get("/stories/index.ndjson").trim().split("\n");
  assert.equal(stories.length, 32);
  assert.equal(evidence.length, 32);
  assert.equal(new Set(evidence.map((item) => item.storyId)).size, 32);
  assert.equal(evidence.every((item) => item.excerpt.length <= 192), true);
  assert.equal(evidence.every((item) => item.title.length <= 120), true);
  assert.equal(evidence.every((item) => item.url.length <= 384), true);
  assert.equal(evidence.every((item) => item.author.length <= 32), true);
  assert.equal(evidence.every((item) => item.source.length <= 32), true);
  assert.equal(evidence.every((item) => Object.values(item.metadata).every((value) => String(value).length <= 32)), true);
  assert.equal(evidence.every((item) => !Object.hasOwn(item.metadata, "ignored")), true);
  assert.ok(missionState.name.length <= 128);
  assert.ok(missionState.question.length <= 800);
  assert.deepEqual(missionState.terms, []);
  assert.deepEqual(missionState.sourceScope, []);
  assert.ok(operatorState.expected_next_event.length <= 400);
  assert.ok(operatorState.outcome_summary.length <= 800);
  assert.ok(researchState.current_thesis.length <= 2_000);
  assert.ok(researchState.report_summary.length <= 1_500);
  assert.deepEqual(researchState.openQuestions, []);
  assert.ok(researchState.report_title.length <= 240);
  assert.ok(researchState.report_url.length <= 384);
  assert.ok(Buffer.byteLength(evidenceText, "utf8") < 45_000);
  assert.equal(handoff.currentState.length, 12);
  assert.equal(handoff.sourceUrls.length, 12);
  assert.equal(handoff.coverageGaps.includes("Additional matched material sits outside this snapshot."), true);
  assert.match(missionMarkdown, /Additional matched material sits outside this snapshot/);
  assert.doesNotMatch(missionMarkdown, /full archive|remains available/i);
  assert.deepEqual(latestSync.snapshotCoverage, manifest.snapshotCoverage);
  assert.deepEqual(latestSync.peripheralCoverage, manifest.peripheralCoverage);
  assert.deepEqual(latestSync.memoryCoverage, manifest.memoryCoverage);
  assert.deepEqual(latestSync.peripheralCoverage, {
    eventsIncluded: 8,
    hasMoreEvents: true,
    runsIncluded: 4,
    hasMoreRuns: true,
    sourcesIncluded: 32,
    hasMoreSources: true,
  });
  assert.deepEqual(latestSync.memoryCoverage, {
    nodesIncluded: 8,
    hasMoreNodes: true,
    edgesIncluded: 16,
    hasMoreEdges: true,
  });
  assert.equal(state.workspace.files.get("/ledger/events.ndjson").trim().split("\n").length, 8);
  assert.equal(state.workspace.files.get("/ledger/sprints.ndjson").trim().split("\n").length, 4);
  assert.equal(state.workspace.files.get("/memory/nodes.ndjson").trim().split("\n").length, 8);
  assert.equal(state.workspace.files.get("/memory/edges.ndjson").trim().split("\n").length, 16);
  const workspaceBytes = state.workspace.writes.reduce((sum, write) => sum + write.bytes, 0);
  assert.ok(workspaceBytes < 600_000, `${workspaceBytes} serialized workspace bytes`);
  assert.deepEqual(state.workspace.writes.slice(-2).map((write) => write.path), [
    "/system/manifest.json",
    "/state/latest-sync.json",
  ]);
  assert.deepEqual(latestSync.snapshotCoverage, {
    matchLimit: 32,
    matchedStoriesIncluded: 32,
    matchedStoriesAvailable: 81,
    matchedStoriesOmitted: 49,
    hasMoreMatchedStories: true,
    evidencePerStoryLimit: 8,
    evidenceItemLimit: 32,
    evidenceItemsIncluded: 32,
    matchedStoriesWithEvidenceIncluded: 32,
    matchedStoriesWithAdditionalEvidence: 32,
    hasMoreEvidence: true,
    evidenceSelection: "breadth-first",
    evidenceCandidateRowsPerStoryLimit: 9,
    evidenceExcerptCharacters: 192,
    excerptedEvidenceItems: 32,
  });
  t.diagnostic(
    `max Computer load: ${loadMilliseconds.toFixed(1)} ms; render: ${renderMilliseconds.toFixed(1)} ms; commit: ${commitMilliseconds.toFixed(1)} ms; `
    + `${state.d1.databaseMilliseconds.toFixed(1)} ms inside local SQLite, `
    + `${state.d1.instrumentationMilliseconds.toFixed(1)} ms test measurement, `
    + `${loadStatements}+0+${commitStatements} D1 statements, ${snapshotBytes} snapshot bytes, ${planBytes} plan bytes, `
    + `${Buffer.byteLength(evidenceText, "utf8")} evidence bytes, `
    + `${workspaceBytes} workspace bytes`,
  );
  t.diagnostic(state.workspace.writes
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 6)
    .map((write) => `${write.path}=${write.bytes}`)
    .join(", "));
});

test("one matched Story fills the 32-item snapshot across 48 sources", async () => {
  const state = fixture({
    storyCount: 1,
    evidencePerStory: 48,
    emptyLastStory: false,
    distinctEvidenceSources: true,
  });
  const plan = await prepareMissionComputerSync(state.env, state.missionId, "one-story-envelope");
  const evidence = plan.fullFiles["/evidence/index.ndjson"].trim().split("\n").map((line) => JSON.parse(line));
  const latestSync = JSON.parse(plan.fullFiles["/state/latest-sync.json"]);

  assert.equal(evidence.length, 32);
  assert.equal(new Set(evidence.map((item) => item.source)).size, 32);
  assert.equal(48 - evidence.length, 16);
  assert.equal(latestSync.snapshotCoverage.evidenceItemsIncluded, 32);
  assert.equal(latestSync.snapshotCoverage.evidenceCandidateRowsPerStoryLimit, 33);
  assert.equal(latestSync.snapshotCoverage.matchedStoriesWithAdditionalEvidence, 1);
  assert.equal(latestSync.snapshotCoverage.hasMoreEvidence, true);
  assert.ok(state.d1.maxRowsReturned <= 288, `${state.d1.maxRowsReturned} candidate rows`);
});

test("sparse Stories donate unused evidence slots without false has-more coverage", async () => {
  const uneven = fixture({ storyCount: 2, evidencePerStory: 48, emptyLastStory: false });
  uneven.database.prepare(
    "DELETE FROM story_items WHERE story_id = 'story-001' AND item_id <> 'item-001-00'",
  ).run();
  const unevenPlan = await prepareMissionComputerSync(uneven.env, uneven.missionId, "uneven-envelope");
  const unevenEvidence = unevenPlan.fullFiles["/evidence/index.ndjson"].trim().split("\n");
  const unevenCoverage = JSON.parse(unevenPlan.fullFiles["/state/latest-sync.json"]).snapshotCoverage;
  assert.equal(unevenEvidence.length, 32);
  assert.equal(unevenCoverage.matchedStoriesWithAdditionalEvidence, 1);
  assert.equal(unevenCoverage.hasMoreEvidence, true);

  const exact = fixture({ storyCount: 1, evidencePerStory: 9, emptyLastStory: false });
  const exactPlan = await prepareMissionComputerSync(exact.env, exact.missionId, "exact-envelope");
  const exactCoverage = JSON.parse(exactPlan.fullFiles["/state/latest-sync.json"]).snapshotCoverage;
  assert.equal(exactCoverage.evidenceItemsIncluded, 9);
  assert.equal(exactCoverage.matchedStoriesWithAdditionalEvidence, 0);
  assert.equal(exactCoverage.hasMoreEvidence, false);

  const duplicateRanks = fixture({ storyCount: 4, evidencePerStory: 48, emptyLastStory: false });
  for (let storyIndex = 1; storyIndex < 4; storyIndex += 1) {
    const storyId = `story-${String(storyIndex).padStart(3, "0")}`;
    duplicateRanks.database.prepare("DELETE FROM story_items WHERE story_id = ?").run(storyId);
    const relink = duplicateRanks.database.prepare(
      `INSERT INTO story_items(story_id, item_id, relationship, created_at)
       SELECT ?, item_id, relationship, created_at
       FROM story_items
       WHERE story_id = 'story-000'
       ORDER BY created_at DESC, item_id ASC
       LIMIT 9`,
    );
    relink.run(storyId);
  }
  const duplicatePlan = await prepareMissionComputerSync(
    duplicateRanks.env,
    duplicateRanks.missionId,
    "duplicate-rank-envelope",
  );
  const duplicateEvidence = duplicatePlan.fullFiles["/evidence/index.ndjson"].trim().split("\n");
  assert.equal(duplicateEvidence.length, 32);
});

test("Computer commit rejects modified and stale prepared plans before writing", async () => {
  const state = fixture({ storyCount: 1, evidencePerStory: 1, emptyLastStory: false });
  const plan = await prepareMissionComputerSync(state.env, state.missionId, "stale-plan-test");
  const modified = {
    ...plan,
    fullFiles: { ...plan.fullFiles, "/mission.md": "modified after preparation\n" },
  };
  await assert.rejects(
    commitMissionComputerSync(state.env, modified),
    /integrity check/,
  );
  state.database.prepare("UPDATE missions SET updated_at = ? WHERE id = ?")
    .run("2026-08-11T12:01:00.000Z", state.missionId);
  await assert.rejects(
    commitMissionComputerSync(state.env, plan),
    /stale; prepare it again/,
  );
  assert.equal(state.workspace.writes.length, 0);
});
