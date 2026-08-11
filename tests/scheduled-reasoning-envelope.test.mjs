import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const { buildActionCenter } = require("../.test-dist/action-center.js");
const { generateBriefing } = require("../.test-dist/briefing.js");
const { listBriefingStoryEvidence } = require("../.test-dist/db.js");
const { memoryNeighborhood } = require("../.test-dist/memory-graph.js");
const originalLoad = Module._load;
let refreshEpistemicMemory;
let refreshEpistemicMemoryLocally;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "cloudflare:workers") {
      return {
        WorkflowEntrypoint: class WorkflowEntrypoint {},
        tracing: { trace: (_name, operation) => operation },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ refreshEpistemicMemory, refreshEpistemicMemoryLocally } = require("../.test-dist/epistemic-memory.js"));
} finally {
  Module._load = originalLoad;
}
const {
  discoverReasoningTaskCandidate,
  materializeNextReasoningTask,
} = require("../.test-dist/reasoning-tasks.js");

const FREE_D1_STATEMENT_CEILING = 47;
const migrationDirectory = new URL("../migrations/", import.meta.url);
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
const migrations = await Promise.all(migrationNames.map(async (name) => ({
  name,
  sql: await readFile(new URL(name, migrationDirectory), "utf8"),
})));

class CountingD1Statement {
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
    this.owner.throwScheduledRunFailure(this);
    this.owner.runScheduledMutation(this);
    const result = this.owner.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }

  async first() {
    this.owner.record("first", this);
    return this.owner.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    this.owner.record("all", this);
    return { success: true, results: this.owner.database.prepare(this.query).all(...this.values), meta: {} };
  }

  async raw() {
    this.owner.record("raw", this);
    const statement = this.owner.database.prepare(this.query);
    const columns = statement.columns().map((column) => column.name);
    return statement.all(...this.values).map((row) => columns.map((column) => row[column]));
  }

  executeForBatch() {
    const statement = this.owner.database.prepare(this.query);
    if (statement.columns().length > 0) {
      this.owner.record("all", this);
      return { success: true, results: statement.all(...this.values), meta: {} };
    }
    this.owner.record("run", this);
    const result = statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }
}

class CountingD1 {
  constructor(database) {
    this.database = database;
    this.queryCount = 0;
    this.calls = [];
    this.scheduledRunFailure = null;
    this.scheduledRunMutation = null;
  }

  prepare(query) {
    return new CountingD1Statement(this, query);
  }

  record(method, statement) {
    this.queryCount += 1;
    this.calls.push({ method, query: statement.query, values: [...statement.values] });
  }

  resetCount() {
    this.queryCount = 0;
    this.calls = [];
  }

  failNextRunMatching(queryFragment, error) {
    this.scheduledRunFailure = { queryFragment, error };
  }

  mutateBeforeNextRunMatching(queryFragment, mutation) {
    this.scheduledRunMutation = { queryFragment, mutation };
  }

  throwScheduledRunFailure(statement) {
    const scheduled = this.scheduledRunFailure;
    if (!scheduled || !statement.query.includes(scheduled.queryFragment)) return;
    this.scheduledRunFailure = null;
    throw scheduled.error;
  }

  runScheduledMutation(statement) {
    const scheduled = this.scheduledRunMutation;
    if (!scheduled || !statement.query.includes(scheduled.queryFragment)) return;
    this.scheduledRunMutation = null;
    scheduled.mutation();
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.executeForBatch());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration.sql);
  database.prepare(
    `INSERT INTO sources(id, name, kind, config_json, enabled, schedule_minutes, weight)
     VALUES ('envelope-source', 'Envelope source', 'manual', '{}', 1, 60, 1)`,
  ).run();
  const d1 = new CountingD1(database);
  const objects = new Map();
  const evidence = {
    async put(key, value) {
      objects.set(key, value);
      return { key };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return {
    database,
    d1,
    objects,
    env: {
      DB: d1,
      EVIDENCE: evidence,
      APP_NAME: "Driftglass",
      MAX_DAILY_STORIES: "30",
      PUBLIC_BASE_URL: "",
      DRIFTGLASS_SECRET: "unused-without-public-base-url",
    },
  };
}

function isoOffset(minutes = 0) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function insertMission(database, id, {
  priority = 1,
  researchPolicy = "manual",
  sprintPolicy = "manual",
} = {}) {
  const now = isoOffset(-5);
  database.prepare(
    `INSERT INTO missions(
       id, name, question, terms_json, source_scope_json, status, priority,
       cadence_minutes, created_at, updated_at
     ) VALUES (?, ?, ?, '[]', '[]', 'active', ?, 360, ?, ?)`,
  ).run(id, `Mission ${id}`, `What changed for ${id}?`, priority, now, now);
  database.prepare(
    `INSERT INTO mission_operators(
       mission_id, research_policy, outcome_status, sprint_policy,
       expected_next_event, expected_event_status, updated_at
     ) VALUES (?, ?, 'open', ?, '', 'none', ?)`,
  ).run(id, researchPolicy, sprintPolicy, now);
  database.prepare(
    `INSERT INTO mission_research_state(mission_id, current_thesis, open_questions_json, updated_at)
     VALUES (?, ?, '[]', ?)`,
  ).run(id, `Current thesis for ${id}`, now);
}

function insertStory(database, storyIndex, evidenceCount = 1) {
  const storyId = `story-${String(storyIndex).padStart(2, "0")}`;
  const changedAt = isoOffset(-(storyIndex + 1));
  database.prepare(
    `INSERT INTO stories(
       id, canonical_key, title, summary, status, first_seen_at, last_changed_at,
       score, relevance, novelty, importance, confidence, source_count, metadata_json
     ) VALUES (?, ?, ?, ?, 'developing', ?, ?, ?, 0.8, 0.8, 0.8, 0.8, ?, '{}')`,
  ).run(
    storyId,
    `canonical-${storyId}`,
    `Story ${storyIndex}`,
    `Summary for Story ${storyIndex}`,
    changedAt,
    changedAt,
    100 - storyIndex,
    evidenceCount,
  );
  for (let evidenceIndex = 0; evidenceIndex < evidenceCount; evidenceIndex += 1) {
    const itemId = `item-${String(storyIndex).padStart(2, "0")}-${String(evidenceIndex).padStart(2, "0")}`;
    const observedAt = isoOffset(-(storyIndex * 12 + evidenceIndex));
    database.prepare(
      `INSERT INTO items(
         id, source_id, external_id, url, canonical_url, title, text, author,
         published_at, observed_at, content_hash, access_class, metadata_json
       ) VALUES (?, 'envelope-source', ?, ?, ?, ?, ?, 'Fixture', ?, ?, ?, 'public', '{}')`,
    ).run(
      itemId,
      itemId,
      `https://example.test/${itemId}`,
      `https://example.test/${itemId}`,
      `Evidence ${itemId}`,
      `Evidence body ${itemId}`,
      observedAt,
      observedAt,
      `hash-${itemId}`,
    );
    database.prepare("INSERT INTO story_items(story_id, item_id) VALUES (?, ?)").run(storyId, itemId);
  }
  return storyId;
}

function matchMission(database, missionId, storyIds) {
  const now = isoOffset(-2);
  const statement = database.prepare(
    `INSERT INTO mission_story_matches(
       mission_id, story_id, match_score, matched_terms_json, first_matched_at, last_matched_at
     ) VALUES (?, ?, 0.9, '["fixture"]', ?, ?)`,
  );
  for (const storyId of storyIds) statement.run(missionId, storyId, now, now);
}

function insertMemoryNeighborhood(database, missionId, neighborCount = 59) {
  const now = isoOffset(-1);
  const seedId = `mem-mission-${missionId}`;
  database.prepare(
    `INSERT INTO memory_nodes(
       id, node_type, canonical_key, label, summary, importance, confidence,
       occurred_at, first_seen_at, last_seen_at, updated_at, status, source_ref
     ) VALUES (?, 'mission', ?, ?, 'Mission memory', 1, 1, ?, ?, ?, ?, 'active', ?)`,
  ).run(seedId, `mission:${missionId}`, `Mission ${missionId}`, now, now, now, now, `mission:${missionId}`);
  for (let index = 0; index < neighborCount; index += 1) {
    const nodeId = `mem-neighbor-${String(index).padStart(2, "0")}`;
    database.prepare(
      `INSERT INTO memory_nodes(
         id, node_type, canonical_key, label, summary, importance, confidence,
         occurred_at, first_seen_at, last_seen_at, updated_at, status
       ) VALUES (?, 'finding', ?, ?, 'Neighbor memory', 0.8, 0.8, ?, ?, ?, ?, 'active')`,
    ).run(nodeId, `finding:neighbor-${index}`, `Neighbor ${index}`, now, now, now, now);
    database.prepare(
      `INSERT INTO memory_edges(
         id, from_node_id, to_node_id, relation, weight, confidence,
         evidence_json, metadata_json, first_seen_at, last_seen_at, updated_at, status, rationale
       ) VALUES (?, ?, ?, 'related_to', 0.8, 0.8, '[]', '{}', ?, ?, ?, 'active', 'fixture')`,
    ).run(`edge-${String(index).padStart(2, "0")}`, seedId, nodeId, now, now, now);
  }
}

function insertRecallDiversityFixture(database) {
  const now = isoOffset(-1);
  const sources = [
    { id: "recall-source-a", kind: "npm", family: "family-a" },
    { id: "recall-source-b", kind: "arxiv", family: "family-b" },
    { id: "recall-source-c", kind: "github", family: "family-c" },
    { id: "recall-source-d", kind: "hackernews", family: "family-d" },
  ];
  const insertSource = database.prepare(
    `INSERT INTO sources(id, name, kind, config_json, enabled, schedule_minutes, weight, health_score, created_at, updated_at)
     VALUES (?, ?, ?, '{}', 1, 60, 2.5, 1, ?, ?)`,
  );
  for (const source of sources) insertSource.run(source.id, `Recall ${source.id}`, source.kind, now, now);

  const insertStory = database.prepare(
    `INSERT INTO stories(
       id, canonical_key, title, summary, first_seen_at, last_changed_at,
       score, relevance, novelty, importance, confidence, source_count, metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 0.95, 1, '{}', ?, ?)`,
  );
  const insertItem = database.prepare(
    `INSERT INTO items(
       id, source_id, external_id, url, canonical_url, title, text,
       observed_at, content_hash, access_class, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', '{}', ?)`,
  );
  const linkStory = database.prepare("INSERT INTO story_items(story_id, item_id) VALUES (?, ?)");
  const insertLineage = database.prepare(
    `INSERT INTO evidence_lineage(
       item_id, story_id, family_key, origin_family_key, relation, independent, rationale, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'fixture lineage', ?, ?)`,
  );

  const addStory = ({
    id,
    source,
    importance,
    score,
    queryMarker = false,
    lineageRelation = "origin",
    lineageIndependent = true,
    originFamily = null,
  }) => {
    const itemId = `item-${id}`;
    const title = queryMarker ? `Recall query marker ${id}` : `Recall development ${id}`;
    insertStory.run(id, id, title, `Summary for ${id}`, now, now, score, importance, now, now);
    insertItem.run(
      itemId,
      source.id,
      itemId,
      `https://example.test/${itemId}`,
      `https://example.test/${itemId}`,
      title,
      `Evidence for ${id}`,
      now,
      `hash-${itemId}`,
      now,
    );
    linkStory.run(id, itemId);
    insertLineage.run(
      itemId,
      id,
      source.family,
      originFamily,
      lineageRelation,
      lineageIndependent ? 1 : 0,
      now,
      now,
    );
  };

  for (let index = 0; index < 6; index += 1) {
    addStory({
      id: `recall-dominant-${index}`,
      source: sources[0],
      importance: 1,
      score: 100 - index,
      queryMarker: index === 0,
    });
  }
  for (const [index, source] of sources.slice(1).entries()) {
    addStory({
      id: `recall-diverse-${index}`,
      source,
      importance: 0.62,
      score: 40 - index,
      ...(index === 0
        ? { lineageRelation: "update", lineageIndependent: false, originFamily: "family-b-origin" }
        : {}),
    });
  }
  return { dominantFamily: sources[0].family };
}

function assertFreeInvocationBound(d1, lane) {
  assert.ok(
    d1.queryCount < FREE_D1_STATEMENT_CEILING,
    `${lane} used ${d1.queryCount} D1 statements; Free-safe invocations require fewer than ${FREE_D1_STATEMENT_CEILING}`,
  );
}

test("Action Center and memory context use set-based reads instead of Mission/node N+1 queries", async () => {
  const actionState = fixture();
  for (let index = 0; index < 80; index += 1) {
    insertMission(actionState.database, `action-${String(index).padStart(2, "0")}`, { sprintPolicy: "scheduled" });
  }
  actionState.d1.resetCount();
  await buildActionCenter(actionState.env);
  assert.equal(actionState.d1.queryCount, 7, "Mission count must not change Action Center statement count");
  assert.equal(actionState.d1.calls.filter((call) => call.query.includes("WHERE r.mission_id = ?")).length, 0);

  const memoryState = fixture();
  insertMission(memoryState.database, "memory-envelope");
  insertMemoryNeighborhood(memoryState.database, "memory-envelope");
  memoryState.d1.resetCount();
  const neighborhood = await memoryNeighborhood(memoryState.env, { ref: "mission:memory-envelope", limit: 60 });
  assert.equal(neighborhood.nodes.length, 60);
  assert.equal(memoryState.d1.queryCount, 7, "neighborhood size must not change memory statement count");
  assert.equal(memoryState.d1.calls.filter((call) => call.query === "SELECT * FROM memory_nodes WHERE id = ?").length, 0);
  assert.equal(memoryState.d1.calls.filter((call) => call.query.includes("WHERE id IN (")).length, 1);
});

test("bounded Memory recall keeps diverse provenance without mirrored seed crowd-out", async () => {
  const state = fixture();
  const inserted = insertRecallDiversityFixture(state.database);
  const refreshed = await refreshEpistemicMemoryLocally(state.env, { maxStories: 9 });
  assert.equal(refreshed.status, "complete");
  assert.equal(
    state.database.prepare(
      "SELECT COUNT(*) AS count FROM memory_edges WHERE relation IN ('observed_in', 'evidence_for')",
    ).get().count,
    18,
    "lineage metadata must ride the existing two evidence edges per Story without extra writes",
  );
  const legacyEdge = state.database.prepare(
    `SELECT edge.id
     FROM memory_edges edge
     JOIN memory_nodes target ON target.id = edge.to_node_id
     WHERE edge.from_node_id = 'mem-source-recall-source-a'
       AND edge.relation = 'evidence_for'
       AND target.source_ref = 'story:recall-dominant-0'`,
  ).get();
  assert.ok(legacyEdge, "the fixture must identify one connected legacy provenance edge");
  const legacyMetadataJson = JSON.stringify({
    legacyMarker: "preserved",
    familyKey: "family-a",
    lineageRelation: "origin",
  });
  state.database.prepare("UPDATE memory_edges SET metadata_json = ? WHERE id = ?").run(
    legacyMetadataJson,
    legacyEdge.id,
  );

  const recall = async (input) => {
    state.d1.resetCount();
    const neighborhood = await memoryNeighborhood(state.env, input);
    const calls = [...state.d1.calls];
    const count = state.d1.queryCount;
    return { neighborhood, calls, count };
  };
  const edgeSeedRows = (calls) => {
    const call = calls.find((entry) => entry.query.includes("FROM memory_edges") && entry.query.includes("from_node_id IN"));
    assert.ok(call, "recall must use one set-based edge read");
    const seedCount = (call.values.length - 1) / 2;
    const seedIds = call.values.slice(0, seedCount);
    const placeholders = seedIds.map(() => "?").join(",");
    return state.database.prepare(
      `SELECT id, node_type, source_ref, metadata_json FROM memory_nodes WHERE id IN (${placeholders})`,
    ).all(...seedIds);
  };

  const first = await recall({ limit: 24 });
  assert.ok(first.neighborhood.nodes.length <= 24);
  assert.ok(first.neighborhood.edges.length <= 24 * 5);
  assert.equal(first.count, 8, "unscoped recall adds one bounded source-candidate read");
  assert.equal(first.calls.filter((call) => call.method === "run").length, 0, "recall must not write canonical state");
  assertFreeInvocationBound(state.d1, "diverse-unscoped-memory-recall");
  const unscopedSeeds = edgeSeedRows(first.calls);
  const mirroredSeeds = unscopedSeeds.filter((node) =>
    ["story", "claim"].includes(node.node_type) && String(node.source_ref || "").startsWith("story:"));
  const seedRefs = new Map();
  for (const node of mirroredSeeds) {
    const group = seedRefs.get(node.source_ref) ?? [];
    group.push(node.node_type);
    seedRefs.set(node.source_ref, group);
  }
  assert.ok([...seedRefs.values()].every((types) => types.length === 1 && types[0] === "claim"));
  const reservedKinds = new Set(unscopedSeeds
    .filter((node) => node.node_type === "source")
    .map((node) => JSON.parse(node.metadata_json).kind));
  assert.ok(reservedKinds.size >= 3, "unscoped logical seeds reserve distinct available source kinds");

  const provenanceEdges = first.neighborhood.edges.filter((edge) =>
    edge.relation === "observed_in" || edge.relation === "evidence_for");
  const provenance = provenanceEdges.map((edge) => JSON.parse(edge.metadata_json));
  assert.ok(new Set(provenance.map((metadata) => metadata.familyKey)).size >= 3);
  assert.ok(new Set(provenance.map((metadata) => metadata.sourceKind)).size >= 3);
  assert.ok(provenance.every((metadata) =>
    Object.hasOwn(metadata, "familyKey")
    && Object.hasOwn(metadata, "originFamilyKey")
    && Object.hasOwn(metadata, "lineageRelation")
    && Object.hasOwn(metadata, "lineageIndependent")
    && Object.hasOwn(metadata, "sourceKind")
    && (typeof metadata.lineageIndependent === "boolean" || metadata.lineageIndependent === null)));
  assert.ok(provenance
    .filter((metadata) => metadata.legacyMarker !== "preserved")
    .every((metadata) => typeof metadata.lineageIndependent === "boolean"));
  assert.ok(provenance.some((metadata) =>
    metadata.lineageIndependent === false && metadata.originFamilyKey === "family-b-origin"));
  const normalizedLegacyEdge = first.neighborhood.edges.find((edge) => edge.id === legacyEdge.id);
  assert.ok(normalizedLegacyEdge, "the returned neighborhood must include the legacy provenance edge");
  assert.deepEqual(JSON.parse(normalizedLegacyEdge.metadata_json), {
    legacyMarker: "preserved",
    familyKey: "family-a",
    lineageRelation: "origin",
    originFamilyKey: null,
    lineageIndependent: null,
    sourceKind: "npm",
  });
  assert.equal(
    state.database.prepare("SELECT metadata_json FROM memory_edges WHERE id = ?").get(legacyEdge.id).metadata_json,
    legacyMetadataJson,
    "response normalization must not rewrite the stored legacy edge",
  );

  const second = await recall({ limit: 24 });
  assert.equal(second.count, 8);
  assert.deepEqual(second.neighborhood.nodes.map((node) => node.id), first.neighborhood.nodes.map((node) => node.id));
  assert.deepEqual(second.neighborhood.edges, first.neighborhood.edges);

  const scoped = await recall({ query: "Recall query marker", limit: 24 });
  assert.equal(scoped.count, 7, "query recall does not perform the unscoped source-candidate read");
  assert.equal(scoped.calls.filter((call) => call.method === "run").length, 0, "query recall must not write canonical state");
  assertFreeInvocationBound(state.d1, "query-scoped-memory-recall");
  const scopedLegacyEdge = scoped.neighborhood.edges.find((edge) => edge.id === legacyEdge.id);
  assert.ok(scopedLegacyEdge, "query recall must return the connected legacy provenance edge");
  assert.deepEqual(
    JSON.parse(scopedLegacyEdge.metadata_json),
    JSON.parse(normalizedLegacyEdge.metadata_json),
    "query recall must return the same normalized legacy metadata without injecting lineage",
  );
  assert.equal(
    state.database.prepare("SELECT metadata_json FROM memory_edges WHERE id = ?").get(legacyEdge.id).metadata_json,
    legacyMetadataJson,
    "repeated and query recall must leave the historical metadata shape unchanged",
  );
  assert.ok(edgeSeedRows(scoped.calls).every((node) => node.node_type !== "source"));
  const scopedFamilies = new Set(scoped.neighborhood.edges
    .filter((edge) => edge.relation === "observed_in" || edge.relation === "evidence_for")
    .map((edge) => JSON.parse(edge.metadata_json).familyKey));
  assert.deepEqual([...scopedFamilies], [inserted.dominantFamily], "query recall must not inject unrelated source families");
});

test("force cannot bypass a denied Memory write reservation", async () => {
  const state = fixture();
  insertStory(state.database, 0, 2);
  state.database.prepare(
    `INSERT INTO settings(key, value) VALUES
       ('budget_profile', 'custom'),
       ('budget_custom_limits', '{"memory_writes_day":0}')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();

  const preflightDenied = await refreshEpistemicMemoryLocally(state.env, { force: true, maxStories: 1 });
  assert.equal(preflightDenied.status, "deferred");
  assert.ok(preflightDenied.estimatedMemoryWrites > 0);
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM memory_graph_runs").get().count, 0);
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count, 0);

  const limit = preflightDenied.estimatedMemoryWrites;
  state.database.prepare("UPDATE settings SET value = ? WHERE key = 'budget_custom_limits'").run(
    JSON.stringify({ memory_writes_day: limit }),
  );
  state.d1.mutateBeforeNextRunMatching("INSERT INTO usage_daily(day, dimension, units", () => {
    const now = new Date().toISOString();
    state.database.prepare(
      `INSERT INTO usage_daily(day, dimension, units, metadata_json, updated_at)
       VALUES (?, 'memory_writes', ?, '{"operation":"concurrent-memory-writer"}', ?)`,
    ).run(now.slice(0, 10), limit, now);
  });

  const atomicallyDenied = await refreshEpistemicMemoryLocally(state.env, { force: true, maxStories: 1 });
  assert.equal(atomicallyDenied.status, "deferred");
  assert.equal(
    state.database.prepare("SELECT status FROM memory_graph_runs ORDER BY started_at DESC LIMIT 1").get().status,
    "deferred",
  );
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count, 0);
  assert.equal(
    state.database.prepare("SELECT units FROM usage_daily WHERE dimension = 'memory_writes'").get().units,
    limit,
    "the rejected refresh does not add its own write reservation",
  );
});

test("scheduled reasoning discovery evaluates and enqueues only one worst-case candidate below the Free ceiling", async () => {
  const state = fixture();
  const storyIds = Array.from({ length: 12 }, (_, index) => insertStory(state.database, index, 4));
  insertMission(state.database, "discovery-a", { priority: 2, researchPolicy: "always" });
  insertMission(state.database, "discovery-b", { priority: 1, researchPolicy: "always" });
  matchMission(state.database, "discovery-a", storyIds);
  matchMission(state.database, "discovery-b", storyIds);

  state.d1.resetCount();
  const task = await discoverReasoningTaskCandidate(state.env);
  assert.ok(task);
  assert.equal(task.scope_id, "discovery-a");
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM reasoning_tasks").get().count, 1);
  assert.equal(state.d1.queryCount, 19, "the one-candidate Deep Research discovery path has a fixed statement cost");
  assertFreeInvocationBound(state.d1, "reasoning-discovery");
  assert.equal(
    state.d1.calls.filter((call) => call.query.includes("WHERE si.story_id = ?")).length,
    0,
    "the selected Deep Research candidate must use the bounded set-based evidence projection",
  );
});

test("a non-escalating Deep Research candidate rotates so the next Mission is evaluated", async () => {
  const state = fixture();
  const quietStory = insertStory(state.database, 1, 1);
  const strongStories = Array.from({ length: 12 }, (_, index) => insertStory(state.database, index + 10, 4));
  insertMission(state.database, "discovery-poison", { priority: 2, researchPolicy: "suggest" });
  insertMission(state.database, "discovery-next", { priority: 1, researchPolicy: "suggest" });
  state.database.prepare("UPDATE mission_operators SET alert_threshold = 1 WHERE mission_id = 'discovery-poison'").run();
  state.database.prepare("UPDATE mission_operators SET alert_threshold = 0.1 WHERE mission_id = 'discovery-next'").run();
  matchMission(state.database, "discovery-poison", [quietStory]);
  matchMission(state.database, "discovery-next", strongStories);

  state.d1.resetCount();
  assert.equal(await discoverReasoningTaskCandidate(state.env), null);
  assertFreeInvocationBound(state.d1, "non-escalating-reasoning-discovery");
  assert.ok(state.database.prepare(
    "SELECT last_evaluated_at FROM missions WHERE id = 'discovery-poison'",
  ).get().last_evaluated_at);

  state.d1.resetCount();
  const task = await discoverReasoningTaskCandidate(state.env);
  assert.equal(task?.scope_id, "discovery-next");
  assertFreeInvocationBound(state.d1, "next-reasoning-discovery");
});

test("stale active Memory Workflow states retain exclusive graph ownership", async (t) => {
  for (const workflowStatus of ["queued", "running", "paused", "waiting", "waitingForPause"]) {
    await t.test(workflowStatus, async () => {
      const state = fixture();
      const staleAt = isoOffset(-7 * 60);
      state.database.prepare(
        `INSERT INTO memory_graph_runs(
           id, status, details_json, started_at, workflow_id, profile, phase, updated_at
         ) VALUES ('stale-memory-run', 'running', '{}', ?, 'stale-workflow', 'free', 'planning', ?)`,
      ).run(staleAt, staleAt);
      let createCalls = 0;
      state.env.MEMORY_WORKFLOW = {
        async get(id) {
          assert.equal(id, "stale-workflow");
          return { async status() { return { status: workflowStatus }; } };
        },
        async create() {
          createCalls += 1;
          throw new Error("active Workflow must not be replaced");
        },
      };

      const result = await refreshEpistemicMemory(state.env);
      assert.equal(result.runId, "stale-memory-run");
      assert.equal(result.status, "running");
      assert.equal(createCalls, 0);
      assert.equal(
        state.database.prepare("SELECT status FROM memory_graph_runs WHERE id = 'stale-memory-run'").get().status,
        "running",
      );
    });
  }
});

test("a transient Memory Workflow status failure cannot authorize a duplicate writer", async () => {
  const state = fixture();
  const staleAt = isoOffset(-7 * 60);
  state.database.prepare(
    `INSERT INTO memory_graph_runs(
       id, status, details_json, started_at, workflow_id, profile, phase, updated_at
     ) VALUES ('stale-memory-run', 'running', '{}', ?, 'stale-workflow', 'free', 'planning', ?)`,
  ).run(staleAt, staleAt);
  state.env.MEMORY_WORKFLOW = {
    async get() {
      throw new Error("temporary control-plane outage");
    },
    async create() {
      throw new Error("transient lookup failure must not create");
    },
  };

  const result = await refreshEpistemicMemory(state.env);
  assert.equal(result.runId, "stale-memory-run");
  assert.equal(
    state.database.prepare("SELECT status FROM memory_graph_runs WHERE id = 'stale-memory-run'").get().status,
    "running",
  );
});

test("unknown, malformed, and future Memory Workflow statuses remain fail-closed at any age", async (t) => {
  const cases = [
    ["unknown", { status: "unknown" }],
    ["missing", { unexpected: true }],
    ["non-string", { status: 17 }],
    ["future", { status: "suspended-for-platform-maintenance" }],
  ];
  for (const [label, remoteStatus] of cases) {
    await t.test(label, async () => {
      const state = fixture();
      const veryStaleAt = isoOffset(-25 * 60);
      state.database.prepare(
        `INSERT INTO memory_graph_runs(
           id, status, details_json, started_at, workflow_id, profile, phase, updated_at
         ) VALUES ('stale-memory-run', 'running', '{}', ?, 'stale-workflow', 'free', 'planning', ?)`,
      ).run(veryStaleAt, veryStaleAt);
      let createCalls = 0;
      state.env.MEMORY_WORKFLOW = {
        async get() {
          return { async status() { return remoteStatus; } };
        },
        async create() {
          createCalls += 1;
          throw new Error("an unrecognized status must not authorize replacement");
        },
      };

      const result = await refreshEpistemicMemory(state.env);
      assert.equal(result.runId, "stale-memory-run");
      assert.equal(result.status, "running");
      assert.equal(createCalls, 0);
      assert.equal(
        state.database.prepare("SELECT status FROM memory_graph_runs WHERE id = 'stale-memory-run'").get().status,
        "running",
      );
    });
  }
});

test("an errored Memory Workflow is failed before a replacement is queued", async () => {
  const state = fixture();
  const staleAt = isoOffset(-7 * 60);
  state.database.prepare(
    `INSERT INTO memory_graph_runs(
       id, status, details_json, started_at, workflow_id, profile, phase, updated_at
     ) VALUES ('stale-memory-run', 'running', '{}', ?, 'stale-workflow', 'free', 'planning', ?)`,
  ).run(staleAt, staleAt);
  state.env.MEMORY_WORKFLOW = {
    async get(id) {
      assert.equal(id, "stale-workflow");
      return { async status() { return { status: "errored" }; } };
    },
    async create(input) {
      return { id: input.id };
    },
  };

  state.d1.resetCount();
  const result = await refreshEpistemicMemory(state.env);
  assert.equal(result.status, "queued");
  assert.notEqual(result.runId, "stale-memory-run");
  const stale = state.database.prepare(
    "SELECT status, phase, error, completed_at FROM memory_graph_runs WHERE id = 'stale-memory-run'",
  ).get();
  assert.equal(stale.status, "failed");
  assert.equal(stale.phase, "complete");
  assert.match(stale.error, /terminal status errored/);
  assert.ok(stale.completed_at);
  assert.equal(state.d1.queryCount, 18, "stale-run recovery and atomic replacement election use a fixed D1 envelope");
  assertFreeInvocationBound(state.d1, "memory-restart-recovery");
});

test("concurrent stale Memory replacement elects one canonical Workflow writer", async () => {
  const state = fixture();
  const staleAt = isoOffset(-7 * 60);
  state.database.prepare(
    `INSERT INTO memory_graph_runs(
       id, status, details_json, started_at, workflow_id, profile, phase, updated_at
     ) VALUES ('stale-memory-run', 'running', '{}', ?, 'stale-workflow', 'free', 'planning', ?)`,
  ).run(staleAt, staleAt);

  let statusArrivals = 0;
  let releaseStatus;
  const statusBarrier = new Promise((resolve) => { releaseStatus = resolve; });
  let createCalls = 0;
  let releaseCreate;
  let signalCreateReached;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const createReached = new Promise((resolve) => { signalCreateReached = resolve; });
  state.env.MEMORY_WORKFLOW = {
    async get(id) {
      assert.equal(id, "stale-workflow");
      return {
        async status() {
          statusArrivals += 1;
          if (statusArrivals === 2) releaseStatus();
          await statusBarrier;
          return { status: "errored" };
        },
      };
    },
    async create(input) {
      createCalls += 1;
      signalCreateReached();
      await createGate;
      return { id: input.id };
    },
  };

  state.d1.resetCount();
  const refreshes = [
    refreshEpistemicMemory(state.env),
    refreshEpistemicMemory(state.env),
  ];
  await createReached;
  for (let turn = 0; turn < 100; turn += 1) {
    const electionCalls = state.d1.calls.filter((call) => call.query.includes("WHERE NOT EXISTS (\n         SELECT 1 FROM memory_graph_runs")).length;
    if (electionCalls === 2) break;
    await Promise.resolve();
  }
  assert.equal(
    state.d1.calls.filter((call) => call.query.includes("WHERE NOT EXISTS (\n         SELECT 1 FROM memory_graph_runs")).length,
    2,
    "both callers must reach the atomic election while the winner's Workflow create is held",
  );
  releaseCreate();
  const [first, second] = await Promise.all(refreshes);

  assert.equal(first.runId, second.runId, "the losing caller returns the canonical elected run");
  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");
  assert.equal(createCalls, 1, "only the elected caller may create a Workflow");
  assert.equal(
    state.database.prepare("SELECT COUNT(*) AS count FROM memory_graph_runs").get().count,
    2,
    "one stale predecessor and exactly one replacement run are retained",
  );
  assert.equal(
    state.database.prepare("SELECT COUNT(*) AS count FROM memory_graph_runs WHERE status IN ('queued', 'running')").get().count,
    1,
  );
  assert.equal(
    state.database.prepare("SELECT units FROM usage_daily WHERE dimension = 'workflow_steps'").get().units,
    first.estimatedWorkflowSteps,
    "the losing caller must not reserve Workflow budget",
  );
  assertFreeInvocationBound(state.d1, "concurrent-memory-restart-recovery");
});

test("a committed Workflow with a lost create response keeps its elected run active", async () => {
  const state = fixture();
  const createdWorkflowIds = new Set();
  let createCalls = 0;
  state.env.MEMORY_WORKFLOW = {
    async create(input) {
      createCalls += 1;
      createdWorkflowIds.add(input.id);
      throw new Error("Workflow create response was lost after commit");
    },
  };

  state.d1.resetCount();
  await assert.rejects(refreshEpistemicMemory(state.env), /response was lost/);
  const elected = state.database.prepare(
    "SELECT * FROM memory_graph_runs WHERE status IN ('queued', 'running')",
  ).get();
  assert.ok(elected);
  assert.equal(elected.status, "queued");
  assert.equal(createdWorkflowIds.has(elected.workflow_id), true);
  const reserved = state.database.prepare(
    "SELECT units FROM usage_daily WHERE dimension = 'workflow_steps'",
  ).get().units;

  const retry = await refreshEpistemicMemory(state.env);
  assert.equal(retry.runId, elected.id);
  assert.equal(retry.status, "queued");
  assert.equal(createCalls, 1, "an ambiguous create result must never be repeated");
  assert.equal(
    state.database.prepare("SELECT units FROM usage_daily WHERE dimension = 'workflow_steps'").get().units,
    reserved,
    "the active elected run must prevent a second reservation",
  );
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM memory_graph_runs").get().count, 1);
  assertFreeInvocationBound(state.d1, "ambiguous-memory-create");
});

test("a post-create D1 update failure keeps the intended Workflow run active", async () => {
  const state = fixture();
  let createCalls = 0;
  state.env.MEMORY_WORKFLOW = {
    async create(input) {
      createCalls += 1;
      return { id: input.id };
    },
  };
  state.d1.failNextRunMatching("UPDATE memory_graph_runs SET", new Error("post-create D1 write failed"));

  state.d1.resetCount();
  await assert.rejects(refreshEpistemicMemory(state.env), /post-create D1 write failed/);
  const elected = state.database.prepare(
    "SELECT * FROM memory_graph_runs WHERE status IN ('queued', 'running')",
  ).get();
  assert.ok(elected);
  assert.equal(elected.status, "queued");
  const reserved = state.database.prepare(
    "SELECT units FROM usage_daily WHERE dimension = 'workflow_steps'",
  ).get().units;

  const retry = await refreshEpistemicMemory(state.env);
  assert.equal(retry.runId, elected.id);
  assert.equal(retry.workflowId, elected.workflow_id);
  assert.equal(createCalls, 1, "a post-create persistence failure must not create another Workflow");
  assert.equal(
    state.database.prepare("SELECT units FROM usage_daily WHERE dimension = 'workflow_steps'").get().units,
    reserved,
    "the active elected run must prevent a second reservation",
  );
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM memory_graph_runs").get().count, 1);
  assertFreeInvocationBound(state.d1, "post-create-memory-persistence-failure");
});

test("positive terminal and missing-instance evidence permits one Memory replacement", async (t) => {
  const cases = [
    ["complete", "stale-workflow", async () => ({ status: "complete" })],
    ["terminated", "stale-workflow", async () => ({ status: "terminated" })],
    ["confident 404", "stale-workflow", async () => { throw Object.assign(new Error("missing"), { status: 404 }); }],
    ["missing workflow id", null, null],
  ];
  for (const [label, workflowId, status] of cases) {
    await t.test(label, async () => {
      const state = fixture();
      const staleAt = isoOffset(-7 * 60);
      state.database.prepare(
        `INSERT INTO memory_graph_runs(
           id, status, details_json, started_at, workflow_id, profile, phase, updated_at
         ) VALUES ('stale-memory-run', 'running', '{}', ?, ?, 'free', 'planning', ?)`,
      ).run(staleAt, workflowId, staleAt);
      let createCalls = 0;
      state.env.MEMORY_WORKFLOW = {
        async get(id) {
          assert.ok(status, "a row without workflow_id must not perform a Workflow lookup");
          assert.equal(id, "stale-workflow");
          return { status };
        },
        async create(input) {
          createCalls += 1;
          return { id: input.id };
        },
      };

      state.d1.resetCount();
      const replacement = await refreshEpistemicMemory(state.env);
      assert.equal(replacement.status, "queued");
      assert.notEqual(replacement.runId, "stale-memory-run");
      assert.equal(createCalls, 1);
      assert.equal(
        state.database.prepare("SELECT status FROM memory_graph_runs WHERE id = 'stale-memory-run'").get().status,
        "failed",
      );
      assert.equal(
        state.database.prepare("SELECT COUNT(*) AS count FROM memory_graph_runs WHERE status IN ('queued', 'running')").get().count,
        1,
      );
      assertFreeInvocationBound(state.d1, `positive-memory-recovery-${label}`);
    });
  }
});

test("scheduled reasoning materialization creates one receipt below the Free ceiling with a full memory neighborhood", async () => {
  const state = fixture();
  const storyIds = Array.from({ length: 12 }, (_, index) => insertStory(state.database, index, 4));
  insertMission(state.database, "materialization", { priority: 2, researchPolicy: "always" });
  matchMission(state.database, "materialization", storyIds);
  insertMemoryNeighborhood(state.database, "materialization");
  const now = isoOffset(-1);
  state.database.prepare(
    `INSERT INTO reasoning_tasks(
       id, scope_kind, scope_id, task, target, objective, priority, reason, status,
       dedupe_key, expires_at, created_at, updated_at
     ) VALUES (
       'task-materialization', 'mission', 'materialization', 'investigate', 'chatgpt',
       'Investigate the Mission', 0.9, 'fixture', 'queued', 'materialization-fixture', ?, ?, ?
     )`,
  ).run(isoOffset(60), now, now);

  state.d1.resetCount();
  const task = await materializeNextReasoningTask(state.env);
  assert.equal(task?.id, "task-materialization");
  assert.equal(task?.status, "ready");
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM reasoning_receipts").get().count, 1);
  assert.equal(state.objects.size, 2);
  assert.equal(state.d1.queryCount, 35, "the full one-receipt materialization path has a fixed statement cost");
  assertFreeInvocationBound(state.d1, "reasoning-materialization");
  assert.equal(state.d1.calls.filter((call) => call.query === "SELECT * FROM memory_nodes WHERE id = ?").length, 0);
  assert.equal(state.d1.calls.filter((call) => call.query.includes("WHERE id IN (")).length, 1);
});

test("bounded Today evidence keeps a substantive release ahead of newer package identities", async () => {
  const state = fixture();
  const storyId = insertStory(state.database, 99, 0);
  state.database.prepare(
    `INSERT INTO sources(id, name, kind, config_json, enabled, schedule_minutes, weight)
     VALUES
       ('briefing-npm', 'npm releases', 'npm_releases', '{}', 1, 60, 1),
       ('briefing-github', 'GitHub releases', 'github_releases', '{}', 1, 60, 1)`,
  ).run();
  const insertItem = state.database.prepare(
    `INSERT INTO items(
       id, source_id, external_id, url, canonical_url, title, text, author,
       published_at, observed_at, content_hash, access_class, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Fixture', ?, ?, ?, 'public', '{}')`,
  );
  const linkStory = state.database.prepare("INSERT INTO story_items(story_id, item_id) VALUES (?, ?)");
  const insertLineage = state.database.prepare(
    `INSERT INTO evidence_lineage(
       item_id, story_id, family_key, origin_family_key, relation, independent,
       rationale, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, ?, ?, 'fixture lineage', ?, ?)`,
  );
  for (let index = 0; index < 6; index += 1) {
    const itemId = `item-briefing-package-${index}`;
    const observedAt = `2026-08-09T12:${String(50 + index).padStart(2, "0")}:00.000Z`;
    insertItem.run(
      itemId,
      "briefing-npm",
      itemId,
      "https://www.npmjs.com/package/agents",
      "https://www.npmjs.com/package/agents",
      `agents 0.20.${index + 2}`,
      `Build AI-powered agents on Cloudflare. Package: agents Version: 0.20.${index + 2}`,
      null,
      observedAt,
      `hash-${itemId}`,
    );
    linkStory.run(storyId, itemId);
    insertLineage.run(
      itemId,
      storyId,
      "npm:agents",
      index === 0 ? "origin" : "same-source-update",
      index === 0 ? 1 : 0,
      observedAt,
      observedAt,
    );
  }
  const releaseId = "item-briefing-github";
  const releaseAt = "2026-08-08T10:00:00.000Z";
  insertItem.run(
    releaseId,
    "briefing-github",
    releaseId,
    "https://github.com/cloudflare/agents/releases/tag/agents%400.20.1",
    "https://github.com/cloudflare/agents/releases/tag/agents%400.20.1",
    "cloudflare/agents agents@0.20.1",
    "Fix AI SDK v7 telemetry so spans retain token counts and finish reasons.",
    releaseAt,
    releaseAt,
    `hash-${releaseId}`,
  );
  linkStory.run(storyId, releaseId);
  insertLineage.run(
    releaseId,
    storyId,
    "github:cloudflare/agents",
    "origin",
    1,
    releaseAt,
    releaseAt,
  );

  state.d1.resetCount();
  const rows = await listBriefingStoryEvidence(state.d1, [storyId], undefined, 6);

  assert.equal(rows.length, 6);
  assert.equal(rows[0].id, releaseId);
  assert.equal(rows.filter((row) => row.source_kind === "npm_releases").length, 5);
  assert.equal(rows[0].new_evidence_count, 7);
  assert.equal(state.d1.queryCount, 1, "quality-aware Today selection does not add a database read");
  assert.match(state.d1.calls[0].query, /s\.kind IN \('npm_releases', 'pypi_releases'\)/);
  assert.equal(state.d1.calls[0].values.at(-1), 6);
});

test("scheduled briefing fetches capped Story evidence and Mission context below the Free ceiling", async () => {
  const state = fixture();
  const storyIds = Array.from({ length: 30 }, (_, index) => insertStory(state.database, index, 10));
  for (let index = 0; index < 25; index += 1) {
    const missionId = `briefing-${String(index).padStart(2, "0")}`;
    insertMission(state.database, missionId, { priority: 25 - index });
    matchMission(state.database, missionId, storyIds.slice(0, 12));
  }

  state.d1.resetCount();
  const briefing = await generateBriefing(state.env, 24);
  assert.equal(briefing.packet.stories.length, 3, "the finite briefing keeps a diverse front page instead of repeating one source");
  assert.ok(briefing.packet.stories.every((story) => story.evidence.length === 8));
  assert.ok(briefing.packet.stories.every((story) => story.change.newEvidenceCount === 10));
  assert.equal(briefing.packet.missions.length, 20);
  assert.ok(briefing.packet.missions.every((mission) => mission.matches.length === 6));
  assert.equal(state.objects.size, 2);
  assert.equal(state.d1.queryCount, 31, "the 30-candidate/20-Mission scheduled briefing has a fixed statement cost");
  assertFreeInvocationBound(state.d1, "briefing");
  assert.equal(state.d1.calls.filter((call) => call.query.includes("WHERE si.story_id = ?")).length, 0);
  assert.equal(state.d1.calls.filter((call) => call.query === "SELECT * FROM mission_operators WHERE mission_id = ?").length, 0);
  assert.equal(state.d1.calls.filter((call) => call.query === "SELECT * FROM mission_research_state WHERE mission_id = ?").length, 0);
});
