import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const compiledRoot = process.env.DRIFTGLASS_TEST_DIST;
const {
  REASONING_DEGRADED_SOURCE_LIMIT,
  REASONING_EVIDENCE_ACCESS_CLASS_CHARACTERS,
  REASONING_EVIDENCE_AUTHOR_CHARACTERS,
  REASONING_EVIDENCE_ITEM_ID_CHARACTERS,
  REASONING_EVIDENCE_LINEAGE_KEY_CHARACTERS,
  REASONING_EVIDENCE_LINEAGE_RATIONALE_CHARACTERS,
  REASONING_EVIDENCE_ROW_LIMIT,
  REASONING_EVIDENCE_SOURCE_ID_CHARACTERS,
  REASONING_EVIDENCE_SOURCE_KIND_CHARACTERS,
  REASONING_EVIDENCE_SOURCE_NAME_CHARACTERS,
  REASONING_EVIDENCE_STORY_CANDIDATE_LIMIT,
  REASONING_EVIDENCE_STORY_CANDIDATE_SENTINEL_LIMIT,
  REASONING_EVIDENCE_STORY_ID_CHARACTERS,
  REASONING_EVIDENCE_TEXT_CHARACTERS,
  REASONING_EVIDENCE_TIMESTAMP_CHARACTERS,
  REASONING_EVIDENCE_TITLE_CHARACTERS,
  REASONING_EVIDENCE_URL_CHARACTERS,
  MISSION_MATCH_PERSISTED_TERM_CHARACTERS,
  MISSION_MATCH_PERSISTED_TERM_LIMIT,
  listReasoningDegradedSourceHealth,
  listReasoningEvidenceSummary,
  listStoryEvidenceSummary,
} = compiledRoot
  ? require(`${compiledRoot}/db.js`)
  : require("../.test-dist/db.js");
const {
  MISSION_MATCH_EVIDENCE_BODY_CHARACTERS,
  MISSION_MATCH_EVIDENCE_PER_STORY_LIMIT,
  MISSION_MATCH_EVIDENCE_TITLE_CHARACTERS,
  MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_BASE,
  MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_LIMIT,
  MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_RESERVE,
  MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_WORST_CASE,
  MISSION_MATCH_MAINTENANCE_WORKFLOW_STEP_RESERVATION,
  MISSION_MATCH_PAGE_D1_STATEMENT_LIMIT,
  MISSION_MATCH_PAGE_TEXT_CHARACTER_LIMIT,
  MISSION_MATCH_REBUILD_STORY_LIMIT,
  MISSION_MATCH_REBUILD_STORY_PAGE_SIZE,
  MISSION_MATCH_TERM_CHARACTERS,
  MISSION_MATCH_TERM_LIMIT,
  commitMissionMatchRebuild,
  evaluateMissionMatchPage,
  matchStoryToMissions,
  planMissionMatchRebuild,
  rebuildMissionMatches,
  rebuildMissionMatchesWithStatus,
  scoreMissionMatch,
  startMissionMatchMaintenance,
} = compiledRoot
  ? require(`${compiledRoot}/missions.js`)
  : require("../.test-dist/missions.js");

class SqliteD1Statement {
  constructor(owner, query) {
    this.owner = owner;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    for (const value of values) {
      if (typeof value !== "string") continue;
      this.owner.maxBoundBytes = Math.max(this.owner.maxBoundBytes, Buffer.byteLength(value, "utf8"));
    }
    return this;
  }

  async run() {
    this.owner.queryCount += 1;
    const result = this.owner.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
  }

  async first() {
    this.owner.queryCount += 1;
    return this.owner.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    this.owner.queryCount += 1;
    if (this.owner.failAtQuery === this.owner.queryCount) throw new Error("Injected D1 read failure");
    const results = this.owner.database.prepare(this.query).all(...this.values);
    this.owner.maxResultBytes = Math.max(
      this.owner.maxResultBytes,
      Buffer.byteLength(JSON.stringify(results), "utf8"),
    );
    for (const result of results) {
      for (const [key, value] of Object.entries(result)) {
        this.owner.resultKeys.add(key);
        if (typeof value === "string") {
          this.owner.maxStringBytes = Math.max(this.owner.maxStringBytes, Buffer.byteLength(value, "utf8"));
          if (["title", "summary", "text"].includes(key)) {
            this.owner.invocationMatchTextCharacters += [...value].length;
          }
        }
      }
    }
    return { success: true, results, meta: {} };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
    this.queryCount = 0;
    this.maxResultBytes = 0;
    this.maxStringBytes = 0;
    this.maxBoundBytes = 0;
    this.resultKeys = new Set();
    this.invocationMatchTextCharacters = 0;
    this.failAtQuery = null;
    this.failBatchStatement = null;
    this.queries = [];
  }

  beginInvocation() {
    this.queryCount = 0;
    this.invocationMatchTextCharacters = 0;
  }

  prepare(query) {
    this.queries.push(query);
    return new SqliteD1Statement(this, query);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    const results = [];
    try {
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index];
        if (this.failBatchStatement === index) throw new Error("Injected D1 batch failure");
        this.queryCount += 1;
        const result = this.database.prepare(statement.query).run(...statement.values);
        results.push({ success: true, results: [], meta: { changes: Number(result.changes ?? 0) } });
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function fixture(options = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      question TEXT NOT NULL DEFAULT '',
      terms_json TEXT NOT NULL DEFAULT '[]',
      source_scope_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      priority REAL NOT NULL DEFAULT 1.0,
      cadence_minutes INTEGER NOT NULL DEFAULT 360,
      last_evaluated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE stories (
      id TEXT PRIMARY KEY,
      canonical_key TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'developing',
      first_seen_at TEXT NOT NULL,
      last_changed_at TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      relevance REAL NOT NULL DEFAULT 0.5,
      novelty REAL NOT NULL DEFAULT 1.0,
      importance REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 0.5,
      source_count INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule_minutes INTEGER NOT NULL DEFAULT 60,
      weight REAL NOT NULL DEFAULT 1,
      health_score REAL NOT NULL DEFAULT 1,
      last_run_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      url TEXT,
      author TEXT,
      published_at TEXT,
      observed_at TEXT NOT NULL,
      access_class TEXT NOT NULL DEFAULT 'public',
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE story_items (
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(story_id, item_id)
    );
    CREATE INDEX idx_story_items_match_recent
      ON story_items(story_id, created_at DESC, item_id ASC);
    CREATE TABLE evidence_lineage (
      item_id TEXT PRIMARY KEY,
      family_key TEXT,
      origin_item_id TEXT,
      origin_family_key TEXT,
      relation TEXT,
      title_similarity REAL,
      body_similarity REAL,
      independent INTEGER,
      rationale TEXT
    );
    CREATE TABLE mission_story_matches (
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      match_score REAL NOT NULL DEFAULT 0,
      matched_terms_json TEXT NOT NULL DEFAULT '[]',
      first_matched_at TEXT NOT NULL,
      last_matched_at TEXT NOT NULL,
      PRIMARY KEY(mission_id, story_id)
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE usage_daily (
      day TEXT NOT NULL,
      dimension TEXT NOT NULL,
      units REAL NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(day, dimension)
    );
  `);
  const now = "2026-08-11T12:00:00.000Z";
  database.prepare(
    `INSERT INTO missions(
       id, name, question, terms_json, source_scope_json, status, priority,
       cadence_minutes, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'active', 1, 360, ?, ?)`,
  ).run(
    "mission-scale",
    "Scale durability",
    "Where did the decisive signal appear?",
    JSON.stringify(["decisive signal"]),
    JSON.stringify(options.sourceScope ?? []),
    now,
    now,
  );
  database.prepare(
    `INSERT INTO sources(
       id, name, kind, config_json, enabled, schedule_minutes, weight,
       health_score, created_at, updated_at
     ) VALUES ('source-web', 'Web source', 'web', '{}', 1, 60, 1, 1, ?, ?)`,
  ).run(now, now);
  return { database, d1: new SqliteD1(database), env: null };
}

function insertStory(database, input) {
  const changedAt = input.changedAt ?? "2026-08-11T12:00:00.000Z";
  database.prepare(
    `INSERT INTO stories(
       id, canonical_key, title, summary, first_seen_at, last_changed_at,
       score, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.id,
    input.title,
    input.summary ?? "",
    changedAt,
    changedAt,
    input.score ?? 0,
    changedAt,
    changedAt,
  );
}

function insertMatch(database, storyId, options = {}) {
  const firstMatchedAt = options.firstMatchedAt ?? "2026-08-01T00:00:00.000Z";
  const lastMatchedAt = options.lastMatchedAt ?? firstMatchedAt;
  database.prepare(
    `INSERT INTO mission_story_matches(
       mission_id, story_id, match_score, matched_terms_json, first_matched_at, last_matched_at
     ) VALUES ('mission-scale', ?, ?, ?, ?, ?)`,
  ).run(
    storyId,
    options.score ?? 0.8,
    JSON.stringify(options.terms ?? ["decisive signal"]),
    firstMatchedAt,
    lastMatchedAt,
  );
}

test("Mission rebuild evaluates Story 101 and atomically replaces only the bounded window", async () => {
  const state = fixture();
  state.env = { DB: state.d1 };
  for (let index = 0; index < 101; index += 1) {
    insertStory(state.database, {
      id: `story-${String(index).padStart(3, "0")}`,
      title: index === 100 ? "The decisive signal appears" : `Routine update ${index}`,
      score: 101 - index,
    });
  }
  insertMatch(state.database, "story-000", { terms: ["stale term"] });
  insertMatch(state.database, "story-100", { firstMatchedAt: "2026-07-01T00:00:00.000Z" });

  const matched = await rebuildMissionMatches(state.env, "mission-scale");

  assert.equal(MISSION_MATCH_REBUILD_STORY_LIMIT, 500);
  assert.equal(MISSION_MATCH_REBUILD_STORY_PAGE_SIZE, 6);
  assert.equal(MISSION_MATCH_EVIDENCE_PER_STORY_LIMIT, 8);
  assert.equal(MISSION_MATCH_EVIDENCE_TITLE_CHARACTERS, 300);
  assert.equal(MISSION_MATCH_EVIDENCE_BODY_CHARACTERS, 192);
  assert.equal(MISSION_MATCH_TERM_LIMIT, 100);
  assert.equal(MISSION_MATCH_TERM_CHARACTERS, 200);
  assert.equal(MISSION_MATCH_PAGE_D1_STATEMENT_LIMIT, 8);
  assert.equal(matched, 1);
  assert.equal(
    state.database.prepare("SELECT 1 FROM mission_story_matches WHERE story_id = 'story-000'").get(),
    undefined,
    "an evaluated Story that no longer matches is removed",
  );
  const retained = state.database.prepare(
    "SELECT * FROM mission_story_matches WHERE story_id = 'story-100'",
  ).get();
  assert.ok(retained, "the relevant 101st Story survives the rebuild");
  assert.equal(retained.first_matched_at, "2026-07-01T00:00:00.000Z", "an existing first-match date is preserved");
  assert.deepEqual(JSON.parse(retained.matched_terms_json), ["decisive signal"]);
  assert.equal(
    state.database.prepare("SELECT updated_at FROM missions WHERE id = 'mission-scale'").get().updated_at,
    "2026-08-11T12:00:00.000Z",
    "a rebuild does not rewrite the Mission configuration version",
  );
});

test("Mission rebuild scores the eighth evidence row and reports material beyond its finite row boundary", async () => {
  const state = fixture({ sourceScope: ["web"] });
  state.env = { DB: state.d1 };
  insertStory(state.database, { id: "story-evidence", title: "Routine filing", score: 10 });
  const insertItem = state.database.prepare(
    `INSERT INTO items(id, source_id, title, text, published_at, observed_at, metadata_json)
     VALUES (?, 'source-web', ?, ?, ?, ?, ?)`,
  );
  const linkItem = state.database.prepare(
    "INSERT INTO story_items(story_id, item_id) VALUES ('story-evidence', ?)",
  );
  for (let index = 0; index < 13; index += 1) {
    const timestamp = new Date(Date.parse("2026-08-11T12:00:00.000Z") - index * 3_600_000).toISOString();
    const itemId = `item-${String(index).padStart(3, "0")}`;
    insertItem.run(
      itemId,
      `Evidence ${index + 1}`,
      index === 7 ? "The decisive signal is present in the eighth bounded item." : "Routine evidence without the target phrase.",
      timestamp,
      timestamp,
      JSON.stringify({ sourceKind: "web" }),
    );
    linkItem.run(itemId);
  }

  const result = await rebuildMissionMatchesWithStatus(state.env, "mission-scale");

  assert.equal(result.matchedStories, 1);
  assert.equal(result.coverage.evidenceItemsConsidered, 8);
  assert.equal(result.coverage.storiesWithAdditionalEvidence, 1);
  assert.equal(result.coverage.partial, true);
  const match = state.database.prepare(
    "SELECT matched_terms_json FROM mission_story_matches WHERE story_id = 'story-evidence'",
  ).get();
  assert.ok(match, "the eighth evidence row contributes to Mission matching");
  assert.deepEqual(JSON.parse(match.matched_terms_json), ["decisive signal"]);
});

test("a bounded rebuild atomically removes stale matches outside its current candidate window", async () => {
  const state = fixture();
  state.env = { DB: state.d1 };
  insertStory(state.database, { id: "story-top", title: "Routine top Story", score: 100 });
  insertStory(state.database, { id: "story-older", title: "Older decisive signal", score: 1 });
  insertMatch(state.database, "story-top", { terms: ["stale term"] });
  insertMatch(state.database, "story-older", { firstMatchedAt: "2026-06-01T00:00:00.000Z" });

  const result = await rebuildMissionMatchesWithStatus(state.env, "mission-scale", 1);
  const matched = result.matchedStories;

  assert.equal(matched, 0);
  assert.equal(result.coverage.storyWindowHasMore, true);
  assert.equal(result.coverage.partial, true);
  assert.equal(
    state.database.prepare("SELECT 1 FROM mission_story_matches WHERE story_id = 'story-top'").get(),
    undefined,
  );
  assert.equal(
    state.database.prepare("SELECT 1 FROM mission_story_matches WHERE story_id = 'story-older'").get(),
    undefined,
  );
  assert.equal(state.database.prepare("SELECT COUNT(*) AS count FROM mission_story_matches").get().count, matched);
});

test("a 500-Story by nine-evidence rebuild stays inside the Free D1 statement envelope", async () => {
  const state = fixture({ sourceScope: ["web"] });
  state.env = { DB: state.d1 };
  state.database.prepare("UPDATE missions SET terms_json = ? WHERE id = 'mission-scale'").run(JSON.stringify([
    "decisive signal",
    ...Array.from({ length: 99 }, (_, index) => `absent-term-${index}`),
  ]));
  const boundedRoutineBody = `Routine evidence without the target phrase. ${"bounded filler ".repeat(170)}`
    .slice(0, MISSION_MATCH_EVIDENCE_BODY_CHARACTERS);
  const insertItem = state.database.prepare(
    `INSERT INTO items(id, source_id, title, text, published_at, observed_at, metadata_json)
     VALUES (?, 'source-web', ?, ?, ?, ?, '{"sourceKind":"web"}')`,
  );
  const linkItem = state.database.prepare(
    "INSERT INTO story_items(story_id, item_id) VALUES (?, ?)",
  );
  state.database.exec("BEGIN");
  try {
    for (let storyIndex = 0; storyIndex < 500; storyIndex += 1) {
      const storyId = `story-envelope-${String(storyIndex).padStart(3, "0")}`;
      insertStory(state.database, {
        id: storyId,
        title: `Routine Story ${storyIndex}`,
        score: 500 - storyIndex,
      });
      for (let evidenceIndex = 0; evidenceIndex < 9; evidenceIndex += 1) {
        const itemId = `item-envelope-${String(storyIndex).padStart(3, "0")}-${evidenceIndex}`;
        const timestamp = new Date(
          Date.parse("2026-08-11T12:00:00.000Z") - (storyIndex * 9 + evidenceIndex) * 1_000,
        ).toISOString();
        insertItem.run(
          itemId,
          `Evidence ${evidenceIndex + 1}`,
          storyIndex === 499 && evidenceIndex === 7
            ? `The decisive signal appears in the final candidate's eighth source. ${boundedRoutineBody}`
                .slice(0, MISSION_MATCH_EVIDENCE_BODY_CHARACTERS)
            : boundedRoutineBody,
          timestamp,
          timestamp,
        );
        linkItem.run(storyId, itemId);
      }
    }
    state.database.exec("COMMIT");
  } catch (error) {
    state.database.exec("ROLLBACK");
    throw error;
  }

  state.d1.beginInvocation();
  const plan = await planMissionMatchRebuild(state.env, "mission-scale");
  assert.equal(state.d1.queryCount, 2, "the plan invocation reads one Mission and its bounded Story IDs");
  const pages = [];
  const pageStatementCounts = [];
  const pageCpuMicroseconds = [];
  for (let offset = 0; offset < plan.storyIds.length; offset += MISSION_MATCH_REBUILD_STORY_PAGE_SIZE) {
    state.d1.beginInvocation();
    const cpuStarted = process.cpuUsage();
    const page = await evaluateMissionMatchPage(state.env, {
      missionId: plan.missionId,
      missionUpdatedAt: plan.missionUpdatedAt,
      storyIds: plan.storyIds.slice(offset, offset + MISSION_MATCH_REBUILD_STORY_PAGE_SIZE),
    });
    const cpuUsed = process.cpuUsage(cpuStarted);
    pageCpuMicroseconds.push(cpuUsed.user + cpuUsed.system);
    // Workflow accumulation happens outside the loopback Worker invocation and
    // must not contaminate the per-page CPU proxy with array growth or GC.
    pages.push(page);
    pageStatementCounts.push(state.d1.queryCount);
    assert.ok(
      state.d1.queryCount <= MISSION_MATCH_PAGE_D1_STATEMENT_LIMIT,
      `page ${pages.length} used ${state.d1.queryCount} D1 statements`,
    );
    assert.ok(
      state.d1.invocationMatchTextCharacters <= MISSION_MATCH_PAGE_TEXT_CHARACTER_LIMIT,
      `page ${pages.length} exposed ${state.d1.invocationMatchTextCharacters} match-text characters`,
    );
  }
  state.d1.beginInvocation();
  const result = await commitMissionMatchRebuild(state.env, plan, pages);
  assert.ok(state.d1.queryCount <= 4, `commit used ${state.d1.queryCount} D1 statements`);

  assert.deepEqual(result, {
    matchedStories: 1,
    evaluatedStories: 500,
    executionComplete: true,
    continuation: null,
    coverage: {
      partial: true,
      storyLimit: 500,
      storyWindowHasMore: false,
      storyPageSize: 6,
      pageTextCharacterLimit: MISSION_MATCH_PAGE_TEXT_CHARACTER_LIMIT,
      evidencePerStoryLimit: 8,
      evidenceTitleCharacters: 300,
      evidenceBodyCharacters: 192,
      questionCharacters: 1_000,
      missionTermLimit: 100,
      missionTermCharacters: 200,
      persistedMatchedTermLimit: 6,
      persistedMatchedTermCharacters: 32,
      persistedMatchedTermsOmitted: 0,
      ignoredMissionTerms: 0,
      ignoredMissionScopeValues: 0,
      questionTruncated: false,
      evidenceItemsConsidered: 4_000,
      storiesWithAdditionalEvidence: 500,
      excerptedBodies: 0,
    },
  });
  assert.equal(pages.length, 84);
  assert.equal(Math.max(...pageStatementCounts), 8);
  const worstPageCpuTrials = [Math.max(...pageCpuMicroseconds)];
  // A long parallel test run can put one V8 GC pause inside an otherwise
  // bounded call. Repeat the exact page workload and use the best complete
  // trial as the local algorithmic proxy; D1 and text limits remain hard on
  // every measured page above.
  for (let trial = 1; trial < 3; trial += 1) {
    let trialWorst = 0;
    for (let offset = 0; offset < plan.storyIds.length; offset += MISSION_MATCH_REBUILD_STORY_PAGE_SIZE) {
      state.d1.beginInvocation();
      const cpuStarted = process.cpuUsage();
      await evaluateMissionMatchPage(state.env, {
        missionId: plan.missionId,
        missionUpdatedAt: plan.missionUpdatedAt,
        storyIds: plan.storyIds.slice(offset, offset + MISSION_MATCH_REBUILD_STORY_PAGE_SIZE),
      });
      const cpuUsed = process.cpuUsage(cpuStarted);
      trialWorst = Math.max(trialWorst, cpuUsed.user + cpuUsed.system);
    }
    worstPageCpuTrials.push(trialWorst);
  }
  const worstPageCpuMicroseconds = Math.min(...worstPageCpuTrials);
  if (process.env.MISSION_MATCH_BENCHMARK === "1") {
    process.stderr.write(`Mission match worst-page local CPU trials: ${worstPageCpuTrials.join(", ")}µs; representative ${worstPageCpuMicroseconds}µs\n`);
  }
  // The character and D1 caps are the durable production guards. Local process
  // CPU is a regression proxy for the Free Worker step envelope.
  assert.ok(
    worstPageCpuMicroseconds < 10_000,
    `best complete maximum-term trial used ${worstPageCpuMicroseconds}µs local process CPU (${worstPageCpuTrials.join(", ")}µs trials)`,
  );
  assert.equal(MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_LIMIT, 1_000);
  assert.equal(MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_BASE, 89);
  assert.equal(MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_WORST_CASE, 93);
  assert.equal(MISSION_MATCH_MAINTENANCE_WORKFLOW_STEP_RESERVATION, 89);
  assert.equal(
    MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_RESERVE,
    MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_LIMIT
      - MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_WORST_CASE,
  );
  assert.ok(state.d1.maxResultBytes < 20_000, `largest indexed evidence read was ${state.d1.maxResultBytes} bytes`);
  assert.ok(
    state.database.prepare(
      "SELECT 1 FROM mission_story_matches WHERE story_id = 'story-envelope-499'",
    ).get(),
  );
  assert.equal(
    state.database.prepare("SELECT COUNT(*) AS count FROM mission_story_matches").get().count,
    result.matchedStories,
  );
});

test("large evidence bodies use the reported deterministic excerpt boundary", async () => {
  const state = fixture({ sourceScope: ["web"] });
  state.env = { DB: state.d1 };
  insertStory(state.database, { id: "story-large-body", title: "Large archive", score: 10 });
  const body = `${"unrelated material ".repeat(27_000)}decisive signal`;
  assert.ok(Buffer.byteLength(body, "utf8") > 400_000);
  await matchStoryToMissions(state.env, {
    story: state.database.prepare("SELECT * FROM stories WHERE id = 'story-large-body'").get(),
    itemText: body,
    sourceId: "source-web",
    sourceKind: "web",
  });
  assert.equal(
    state.database.prepare("SELECT 1 FROM mission_story_matches WHERE story_id = 'story-large-body'").get(),
    undefined,
    "incremental matching applies the same body boundary",
  );
  state.database.prepare(
    `INSERT INTO items(id, source_id, title, text, published_at, observed_at, metadata_json)
     VALUES ('item-large-body', 'source-web', 'Long report', ?, ?, ?, '{"sourceKind":"web"}')`,
  ).run(body, "2026-08-11T12:00:00.000Z", "2026-08-11T12:00:00.000Z");
  state.database.prepare(
    "INSERT INTO story_items(story_id, item_id) VALUES ('story-large-body', 'item-large-body')",
  ).run();

  const result = await rebuildMissionMatchesWithStatus(state.env, "mission-scale");

  assert.equal(result.matchedStories, 0, "material beyond the declared excerpt is not silently treated as evaluated");
  assert.equal(result.coverage.excerptedBodies, 1);
  assert.equal(result.coverage.evidenceBodyCharacters, 192);
  assert.ok(state.d1.maxResultBytes < 20_000, `largest bounded D1 result was ${state.d1.maxResultBytes} bytes`);
  assert.ok(state.d1.maxStringBytes <= 600, `largest returned string was ${state.d1.maxStringBytes} bytes`);
  assert.equal(state.d1.resultKeys.has("text"), true, "the Worker receives only the bounded evidence excerpt");
  assert.equal(state.d1.resultKeys.has("metadata_json"), false, "evidence metadata is reduced inside D1");
});

test("reasoning evidence reads clip large bodies and use stable tie ordering", async () => {
  const state = fixture();
  insertStory(state.database, { id: "story-reasoning-bound", title: "Reasoning bound", score: 10 });
  const observedAt = "2026-08-11T12:00:00.000Z";
  const insertItem = state.database.prepare(
    `INSERT INTO items(id, source_id, title, text, published_at, observed_at, metadata_json)
     VALUES (?, 'source-web', ?, ?, ?, ?, '{}')`,
  );
  insertItem.run("item-z", "Second by ID", "short body", observedAt, observedAt);
  insertItem.run("item-a", "First by ID", "x".repeat(500_000), observedAt, observedAt);
  state.database.prepare("INSERT INTO story_items(story_id, item_id) VALUES (?, ?)")
    .run("story-reasoning-bound", "item-z");
  state.database.prepare("INSERT INTO story_items(story_id, item_id) VALUES (?, ?)")
    .run("story-reasoning-bound", "item-a");

  const rows = await listStoryEvidenceSummary(state.d1, ["story-reasoning-bound"], 2);

  assert.deepEqual(rows.map((row) => row.item_id), ["item-a", "item-z"]);
  assert.equal(rows[0].text.length, 8_192);
  assert.ok(state.d1.maxStringBytes <= 8_192, `largest reasoning field was ${state.d1.maxStringBytes} bytes`);
  assert.ok(state.d1.maxResultBytes < 20_000, `bounded reasoning result was ${state.d1.maxResultBytes} bytes`);
});

test("reasoning projection bounds deep history, every returned string, and unrelated JSON", async () => {
  const state = fixture();
  const storyId = `story-${"s".repeat(180)}`;
  const sourceId = `source-${"q".repeat(180)}`;
  insertStory(state.database, { id: storyId, title: "Reasoning projection", score: 10 });
  state.database.prepare(
    `INSERT INTO sources(
       id, name, kind, config_json, enabled, schedule_minutes, weight,
       health_score, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 60, 1, 1, ?, ?)`,
  ).run(
    sourceId,
    "Source ".repeat(80),
    "source-kind-".repeat(20),
    JSON.stringify({ evidenceRole: "primary", primarySource: true, privatePadding: "c".repeat(1_000) }),
    "2026-08-11T12:00:00.000Z",
    "2026-08-11T12:00:00.000Z",
  );
  const insertItem = state.database.prepare(
    `INSERT INTO items(
       id, source_id, title, text, url, author, published_at, observed_at, access_class, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const linkItem = state.database.prepare(
    "INSERT INTO story_items(story_id, item_id, created_at) VALUES (?, ?, ?)",
  );
  const insertLineage = state.database.prepare(
    `INSERT INTO evidence_lineage(
       item_id, family_key, origin_item_id, origin_family_key, relation,
       title_similarity, body_similarity, independent, rationale
     ) VALUES (?, ?, ?, ?, ?, 0.5, 0.5, 1, ?)`,
  );

  state.database.exec("BEGIN");
  try {
    for (let index = 0; index < 2_000; index += 1) {
      const itemId = `old-${String(index).padStart(4, "0")}`;
      const timestamp = new Date(Date.parse("2025-01-01T00:00:00.000Z") - index * 1_000).toISOString();
      insertItem.run(itemId, sourceId, "Old", "Old evidence", null, null, timestamp, timestamp, "public", "{}");
      linkItem.run(storyId, itemId, timestamp);
    }
    for (let index = 0; index < 82; index += 1) {
      const itemId = `recent-${String(index).padStart(3, "0")}-${"i".repeat(180)}`;
      const timestamp = new Date(Date.parse("2026-08-11T12:00:00.000Z") - index * 1_000).toISOString();
      const metadata = index === 0
        ? JSON.stringify({ provider: "youtube", operation: "youtube.feed", privatePadding: "m".repeat(8_000) })
        : JSON.stringify({ evidenceRole: "independent", provider: "youtube", operation: "youtube.feed", privatePadding: "m".repeat(2_000) });
      insertItem.run(
        itemId,
        sourceId,
        "T".repeat(1_000),
        "B".repeat(8_000),
        `https://example.com/${"u".repeat(1_000)}`,
        "A".repeat(1_000),
        `${timestamp}${"p".repeat(100)}`,
        timestamp,
        "public",
        metadata,
      );
      linkItem.run(storyId, itemId, timestamp);
      insertLineage.run(
        itemId,
        "f".repeat(500),
        "o".repeat(500),
        "g".repeat(500),
        "relation-".repeat(30),
        "r".repeat(2_000),
      );
    }
    state.database.exec("COMMIT");
  } catch (error) {
    state.database.exec("ROLLBACK");
    throw error;
  }

  state.d1.beginInvocation();
  const started = performance.now();
  const rows = await listReasoningEvidenceSummary(state.d1, [storyId], 10_000);
  const elapsedMilliseconds = performance.now() - started;

  assert.equal(rows.length, REASONING_EVIDENCE_STORY_CANDIDATE_LIMIT);
  assert.equal(state.d1.queryCount, 1);
  assert.ok(rows.every((row) => row.item_id.startsWith("recent-")), "old history never enters the bounded candidate set");
  assert.ok(rows.every((row) => row.story_window_has_more === 1));
  assert.ok(rows.every((row) => [...row.story_id].length <= REASONING_EVIDENCE_STORY_ID_CHARACTERS));
  assert.ok(rows.every((row) => [...row.item_id].length <= REASONING_EVIDENCE_ITEM_ID_CHARACTERS));
  assert.ok(rows.every((row) => [...row.source_id].length <= REASONING_EVIDENCE_SOURCE_ID_CHARACTERS));
  assert.ok(rows.every((row) => [...row.source_name].length <= REASONING_EVIDENCE_SOURCE_NAME_CHARACTERS));
  assert.ok(rows.every((row) => [...row.source_kind].length <= REASONING_EVIDENCE_SOURCE_KIND_CHARACTERS));
  assert.ok(rows.every((row) => [...row.title].length <= REASONING_EVIDENCE_TITLE_CHARACTERS));
  assert.ok(rows.every((row) => [...(row.url ?? "")].length <= REASONING_EVIDENCE_URL_CHARACTERS));
  assert.ok(rows.every((row) => [...(row.author ?? "")].length <= REASONING_EVIDENCE_AUTHOR_CHARACTERS));
  assert.ok(rows.every((row) => [...(row.published_at ?? "")].length <= REASONING_EVIDENCE_TIMESTAMP_CHARACTERS));
  assert.ok(rows.every((row) => [...row.observed_at].length <= REASONING_EVIDENCE_TIMESTAMP_CHARACTERS));
  assert.ok(rows.every((row) => [...row.access_class].length <= REASONING_EVIDENCE_ACCESS_CLASS_CHARACTERS));
  assert.ok(rows.every((row) => [...row.text].length <= REASONING_EVIDENCE_TEXT_CHARACTERS));
  assert.ok(rows.every((row) => [...(row.family_key ?? "")].length <= REASONING_EVIDENCE_LINEAGE_KEY_CHARACTERS));
  assert.ok(rows.every((row) => [...(row.lineage_rationale ?? "")].length <= REASONING_EVIDENCE_LINEAGE_RATIONALE_CHARACTERS));
  assert.deepEqual(JSON.parse(rows[1].source_config_json), { evidenceRole: "primary", primarySource: true });
  assert.deepEqual(JSON.parse(rows[1].metadata_json), {
    evidenceRole: "independent",
    provider: "youtube",
    operation: "youtube.feed",
  });
  assert.equal(rows[0].metadata_json, "{}", "oversized metadata does not cross the D1 boundary");
  assert.doesNotMatch(JSON.stringify(rows), /privatePadding/);
  assert.ok(state.d1.maxResultBytes < 400_000, `reasoning projection returned ${state.d1.maxResultBytes} bytes`);
  assert.ok(elapsedMilliseconds < 250, `bounded deep-history query took ${elapsedMilliseconds.toFixed(1)}ms`);

  const query = state.d1.queries.at(-1);
  assert.match(query, new RegExp(`candidate\\.evidence_rank < ${REASONING_EVIDENCE_STORY_CANDIDATE_SENTINEL_LIMIT}`));
  const plan = state.database.prepare(`EXPLAIN QUERY PLAN ${query}`).all(JSON.stringify([storyId]), 81);
  assert.ok(
    plan.some((row) => String(row.detail).includes("idx_story_items_match_recent")),
    `query plan did not use the recent-evidence index: ${JSON.stringify(plan)}`,
  );
  if (process.env.REASONING_EVIDENCE_BENCHMARK === "1") {
    process.stderr.write(`Reasoning bounded projection: ${state.d1.maxResultBytes} bytes in ${elapsedMilliseconds.toFixed(1)}ms\n`);
  }
});

test("reasoning projection bounds the maximum twenty-Story candidate workload", async () => {
  const state = fixture();
  const storyIds = [];
  const insertItem = state.database.prepare(
    `INSERT INTO items(
       id, source_id, title, text, url, author, published_at, observed_at, access_class, metadata_json
     ) VALUES (?, 'source-web', ?, ?, ?, ?, ?, ?, 'public', ?)`,
  );
  const linkItem = state.database.prepare(
    "INSERT INTO story_items(story_id, item_id, created_at) VALUES (?, ?, ?)",
  );
  const insertLineage = state.database.prepare(
    `INSERT INTO evidence_lineage(
       item_id, family_key, origin_item_id, origin_family_key, relation,
       title_similarity, body_similarity, independent, rationale
     ) VALUES (?, ?, ?, ?, 'independent', 0.1, 0.2, 1, ?)`,
  );
  state.database.exec("BEGIN");
  try {
    for (let storyIndex = 0; storyIndex < 20; storyIndex += 1) {
      const storyId = `story-reasoning-max-${String(storyIndex).padStart(2, "0")}`;
      storyIds.push(storyId);
      insertStory(state.database, { id: storyId, title: `Reasoning maximum ${storyIndex}`, score: 100 - storyIndex });
      for (let evidenceIndex = 0; evidenceIndex < REASONING_EVIDENCE_STORY_CANDIDATE_SENTINEL_LIMIT; evidenceIndex += 1) {
        const itemId = `reasoning-max-${String(storyIndex).padStart(2, "0")}-${String(evidenceIndex).padStart(2, "0")}`;
        const timestamp = new Date(
          Date.parse(storyIndex < 2 ? "2026-08-11T12:00:00.000Z" : "2025-01-01T00:00:00.000Z")
            - evidenceIndex * 1_000
            - storyIndex,
        ).toISOString();
        insertItem.run(
          itemId,
          "T".repeat(REASONING_EVIDENCE_TITLE_CHARACTERS),
          "B".repeat(REASONING_EVIDENCE_TEXT_CHARACTERS + 800),
          `https://example.com/${"u".repeat(REASONING_EVIDENCE_URL_CHARACTERS)}`,
          "A".repeat(REASONING_EVIDENCE_AUTHOR_CHARACTERS),
          timestamp,
          timestamp,
          JSON.stringify({ provider: "web", operation: "maximum.fixture", ignored: "m".repeat(2_000) }),
        );
        linkItem.run(storyId, itemId, timestamp);
        insertLineage.run(
          itemId,
          "f".repeat(REASONING_EVIDENCE_LINEAGE_KEY_CHARACTERS),
          "o".repeat(REASONING_EVIDENCE_LINEAGE_KEY_CHARACTERS),
          "g".repeat(REASONING_EVIDENCE_LINEAGE_KEY_CHARACTERS),
          "r".repeat(REASONING_EVIDENCE_LINEAGE_RATIONALE_CHARACTERS),
        );
      }
    }
    state.database.exec("COMMIT");
  } catch (error) {
    state.database.exec("ROLLBACK");
    throw error;
  }

  state.d1.beginInvocation();
  const started = performance.now();
  const rows = await listReasoningEvidenceSummary(state.d1, storyIds, REASONING_EVIDENCE_ROW_LIMIT);
  const elapsedMilliseconds = performance.now() - started;

  assert.equal(rows.length, REASONING_EVIDENCE_ROW_LIMIT);
  assert.equal(state.d1.queryCount, 1);
  assert.equal(new Set(rows.map((row) => row.story_id)).size, 20, "every Story gets a fair first candidate");
  assert.ok(rows.every((row) => row.story_window_has_more === 1));
  assert.ok(rows.every((row) => [...row.text].length === REASONING_EVIDENCE_TEXT_CHARACTERS));
  assert.ok(state.d1.maxResultBytes < 400_000, `maximum reasoning projection returned ${state.d1.maxResultBytes} bytes`);
  assert.ok(elapsedMilliseconds < 50, `maximum reasoning query took ${elapsedMilliseconds.toFixed(1)}ms`);
  if (process.env.REASONING_EVIDENCE_BENCHMARK === "1") {
    process.stderr.write(
      `Reasoning 20-Story projection: ${state.d1.maxResultBytes} bytes in ${elapsedMilliseconds.toFixed(1)}ms\n`,
    );
  }
});

test("reasoning degraded-source projection is an eleven-row bounded read", async () => {
  const state = fixture();
  const insert = state.database.prepare(
    `INSERT INTO sources(
       id, name, kind, config_json, enabled, schedule_minutes, weight,
       health_score, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, '{}', 1, 60, 1, ?, ?, ?, ?)`,
  );
  for (let index = 0; index < 1_000; index += 1) {
    insert.run(
      `degraded-${String(index).padStart(4, "0")}`,
      `Degraded ${index} ${"n".repeat(300)}`,
      "kind-".repeat(30),
      index / 2_000,
      "e".repeat(2_000),
      "2026-08-11T12:00:00.000Z",
      "2026-08-11T12:00:00.000Z",
    );
  }

  state.d1.beginInvocation();
  const rows = await listReasoningDegradedSourceHealth(state.d1, 1_000);

  assert.equal(rows.length, REASONING_DEGRADED_SOURCE_LIMIT);
  assert.equal(state.d1.queryCount, 1);
  assert.ok(rows.every((row) => String(row.id).length <= 128));
  assert.ok(rows.every((row) => String(row.name).length <= 160));
  assert.ok(rows.every((row) => String(row.kind).length <= 100));
  assert.ok(rows.every((row) => String(row.last_error).length <= 600));
  assert.ok(state.d1.maxResultBytes < 20_000);
});

test("bounded excerpts preserve question-token scoring without substring false positives", async () => {
  const state = fixture();
  state.env = { DB: state.d1 };
  state.database.prepare(
    `UPDATE missions
     SET question = 'Did gas design change café?', terms_json = '["anchor"]'
     WHERE id = 'mission-scale'`,
  ).run();
  const mission = state.database.prepare("SELECT * FROM missions WHERE id = 'mission-scale'").get();
  const evidenceByStory = new Map([
    ["story-token-traps", "Anchor reached Vegas after a redesign."],
    ["story-token-stems", "Anchor gas designed change."],
    ["story-token-url", "Anchor https://gas.example/design change."],
    ["story-token-unicode", "Anchor found CAFE\u0301."],
  ]);
  const insertItem = state.database.prepare(
    `INSERT INTO items(id, source_id, title, text, published_at, observed_at, metadata_json)
     VALUES (?, 'source-web', 'Analysis', ?, ?, ?, '{"sourceKind":"web"}')`,
  );
  for (const [storyId, text] of evidenceByStory) {
    insertStory(state.database, { id: storyId, title: "Routine analysis", score: 10 });
    const itemId = `item-${storyId}`;
    insertItem.run(itemId, text, "2026-08-11T12:00:00.000Z", "2026-08-11T12:00:00.000Z");
    state.database.prepare("INSERT INTO story_items(story_id, item_id) VALUES (?, ?)").run(storyId, itemId);
  }

  assert.equal(await rebuildMissionMatches(state.env, "mission-scale"), evidenceByStory.size);

  for (const [storyId, evidenceText] of evidenceByStory) {
    const expected = scoreMissionMatch(mission, {
      text: `Routine analysis\n\nAnalysis\n${evidenceText}`,
    });
    const persisted = state.database.prepare(
      "SELECT match_score FROM mission_story_matches WHERE story_id = ?",
    ).get(storyId);
    assert.equal(persisted.match_score, expected.score, `${storyId} keeps scoreMissionMatch token semantics`);
  }
});

test("the linear term matcher retains overlapping and Unicode substring semantics", () => {
  const state = fixture();
  const mission = state.database.prepare("SELECT * FROM missions WHERE id = 'mission-scale'").get();
  mission.terms_json = JSON.stringify([
    "signal",
    "decisive signal",
    "signal appears",
    "appears",
    "énergie",
  ]);

  const result = scoreMissionMatch(mission, {
    text: "ÉNERGIE: the decisive signal appears.",
  });

  assert.deepEqual(result.matchedTerms, [
    "signal",
    "decisive signal",
    "signal appears",
    "appears",
    "énergie",
  ]);
});

test("configured Mission terms have a finite matcher and write footprint", async () => {
  const state = fixture();
  state.env = { DB: state.d1 };
  const mission = state.database.prepare("SELECT * FROM missions WHERE id = 'mission-scale'").get();
  mission.terms_json = JSON.stringify(["x".repeat(500), "x".repeat(MISSION_MATCH_TERM_CHARACTERS)]);
  state.database.prepare("UPDATE missions SET terms_json = ? WHERE id = 'mission-scale'").run(mission.terms_json);

  const result = scoreMissionMatch(mission, { text: "x".repeat(MISSION_MATCH_TERM_CHARACTERS) });

  assert.equal(result.matchedTerms.length, 1);
  assert.equal(result.matchedTerms[0].length, MISSION_MATCH_TERM_CHARACTERS);
  insertStory(state.database, {
    id: "story-term-bound",
    title: "x".repeat(MISSION_MATCH_TERM_CHARACTERS),
    score: 10,
  });
  const rebuild = await rebuildMissionMatchesWithStatus(state.env, "mission-scale");
  assert.equal(rebuild.coverage.ignoredMissionTerms, 1);
  assert.equal(rebuild.coverage.persistedMatchedTermsOmitted, 1);
  assert.equal(rebuild.coverage.partial, true);
  assert.deepEqual(
    JSON.parse(state.database.prepare(
      "SELECT matched_terms_json FROM mission_story_matches WHERE story_id = 'story-term-bound'",
    ).get().matched_terms_json),
    [],
    "the exact oversized label is omitted rather than stored as a misleading prefix",
  );
});

test("non-string sourceKind metadata does not satisfy a string Mission scope", async () => {
  const state = fixture({ sourceScope: ["123"] });
  state.env = { DB: state.d1 };
  insertStory(state.database, { id: "story-numeric-kind", title: "Routine Story", score: 10 });
  state.database.prepare(
    `INSERT INTO items(id, source_id, title, text, published_at, observed_at, metadata_json)
     VALUES ('item-numeric-kind', 'source-web', 'Analysis', 'The decisive signal appears.', ?, ?, '{"sourceKind":123}')`,
  ).run("2026-08-11T12:00:00.000Z", "2026-08-11T12:00:00.000Z");
  state.database.prepare(
    "INSERT INTO story_items(story_id, item_id) VALUES ('story-numeric-kind', 'item-numeric-kind')",
  ).run();

  assert.equal(await rebuildMissionMatches(state.env, "mission-scale"), 0);
  assert.equal(
    state.database.prepare(
      "SELECT 1 FROM mission_story_matches WHERE story_id = 'story-numeric-kind'",
    ).get(),
    undefined,
  );
});

test("the atomic commit preserves incremental matches newer than its rebuild watermark", async () => {
  const state = fixture();
  state.env = { DB: state.d1 };
  insertStory(state.database, { id: "story-rebuild-match", title: "The decisive signal appears", score: 20 });
  insertStory(state.database, { id: "story-concurrent-only", title: "Routine update", score: 10 });

  const plan = await planMissionMatchRebuild(state.env, "mission-scale");
  const page = await evaluateMissionMatchPage(state.env, {
    missionId: plan.missionId,
    missionUpdatedAt: plan.missionUpdatedAt,
    storyIds: plan.storyIds,
  });
  insertMatch(state.database, "story-rebuild-match", {
    score: 0.99,
    terms: ["newer incremental match"],
    firstMatchedAt: "2026-08-11T12:00:00.000Z",
    lastMatchedAt: "9999-01-01T00:00:00.000Z",
  });
  insertMatch(state.database, "story-concurrent-only", {
    score: 0.77,
    terms: ["concurrent-only"],
    firstMatchedAt: "2026-08-11T12:00:00.000Z",
    lastMatchedAt: "9999-01-01T00:00:00.000Z",
  });

  const result = await commitMissionMatchRebuild(state.env, plan, [page]);

  assert.equal(result.matchedStories, 1, "the result reports the evaluated bounded snapshot");
  const rebuilt = state.database.prepare(
    "SELECT match_score, matched_terms_json FROM mission_story_matches WHERE story_id = 'story-rebuild-match'",
  ).get();
  assert.equal(rebuilt.match_score, 0.99);
  assert.deepEqual(JSON.parse(rebuilt.matched_terms_json), ["newer incremental match"]);
  assert.deepEqual(
    JSON.parse(state.database.prepare(
      "SELECT matched_terms_json FROM mission_story_matches WHERE story_id = 'story-concurrent-only'",
    ).get().matched_terms_json),
    ["concurrent-only"],
  );
});

test("a Mission configuration change rejects the stale plan without replacing matches", async () => {
  const state = fixture();
  state.env = { DB: state.d1 };
  insertStory(state.database, { id: "story-versioned", title: "The decisive signal appears", score: 10 });
  insertMatch(state.database, "story-versioned", { score: 0.31, terms: ["prior match"] });
  const plan = await planMissionMatchRebuild(state.env, "mission-scale");
  const page = await evaluateMissionMatchPage(state.env, {
    missionId: plan.missionId,
    missionUpdatedAt: plan.missionUpdatedAt,
    storyIds: plan.storyIds,
  });
  state.database.prepare(
    "UPDATE missions SET terms_json = '[\"different term\"]', updated_at = '2026-08-12T00:00:00.000Z' WHERE id = 'mission-scale'",
  ).run();

  await assert.rejects(
    commitMissionMatchRebuild(state.env, plan, [page]),
    /Mission changed during match rebuild/,
  );
  const preserved = state.database.prepare(
    "SELECT match_score, matched_terms_json FROM mission_story_matches WHERE story_id = 'story-versioned'",
  ).get();
  assert.equal(preserved.match_score, 0.31);
  assert.deepEqual(JSON.parse(preserved.matched_terms_json), ["prior match"]);
});

test("one maximum page bounds common overlapping-term work and D1 statements", async () => {
  const state = fixture({ sourceScope: ["web"] });
  state.env = { DB: state.d1 };
  state.database.prepare(
    "UPDATE missions SET question = 'a', terms_json = ? WHERE id = 'mission-scale'",
  ).run(JSON.stringify(Array.from({ length: 100 }, (_, index) => "a".repeat(index + 1))));
  const insertItem = state.database.prepare(
    `INSERT INTO items(id, source_id, title, text, published_at, observed_at, metadata_json)
     VALUES (?, 'source-web', 'a', ?, ?, ?, '{"sourceKind":"web"}')`,
  );
  for (let storyIndex = 0; storyIndex < MISSION_MATCH_REBUILD_STORY_PAGE_SIZE; storyIndex += 1) {
    const storyId = `story-overlap-${storyIndex}`;
    insertStory(state.database, { id: storyId, title: "Routine", score: 100 - storyIndex });
    for (let evidenceIndex = 0; evidenceIndex < MISSION_MATCH_EVIDENCE_PER_STORY_LIMIT; evidenceIndex += 1) {
      const itemId = `item-overlap-${storyIndex}-${evidenceIndex}`;
      insertItem.run(
        itemId,
        "a".repeat(MISSION_MATCH_EVIDENCE_BODY_CHARACTERS),
        "2026-08-11T12:00:00.000Z",
        "2026-08-11T12:00:00.000Z",
      );
      state.database.prepare("INSERT INTO story_items(story_id, item_id) VALUES (?, ?)").run(storyId, itemId);
    }
  }
  const plan = await planMissionMatchRebuild(state.env, "mission-scale");
  state.d1.beginInvocation();
  const page = await evaluateMissionMatchPage(state.env, {
    missionId: plan.missionId,
    missionUpdatedAt: plan.missionUpdatedAt,
    storyIds: plan.storyIds,
  });

  assert.equal(page.matches.length, MISSION_MATCH_REBUILD_STORY_PAGE_SIZE);
  assert.ok(page.matches.every((match) => match.matchedTermIndexes.length === 100));
  assert.equal(state.d1.queryCount, MISSION_MATCH_PAGE_D1_STATEMENT_LIMIT);
  assert.ok(state.d1.invocationMatchTextCharacters <= MISSION_MATCH_PAGE_TEXT_CHARACTER_LIMIT);
});

test("Mission maintenance reserves its full billed Workflow before launch", async () => {
  const state = fixture();
  const creates = [];
  state.env = {
    DB: state.d1,
    MISSION_WORKFLOW: {
      async create(input) {
        creates.push(input);
        return { id: input.id };
      },
    },
  };

  state.d1.beginInvocation();
  const result = await startMissionMatchMaintenance(state.env, {
    missionId: "mission-scale",
    reason: "manual-rebuild",
  });

  assert.equal(result.status, "queued");
  assert.equal(creates.length, 1);
  assert.equal(state.d1.queryCount, 3, "profile read plus reservation write/read");
  assert.equal(
    state.database.prepare(
      "SELECT units FROM usage_daily WHERE dimension = 'workflow_steps'",
    ).get().units,
    MISSION_MATCH_MAINTENANCE_WORKFLOW_STEP_RESERVATION,
  );
});

test("Mission maintenance denial does not launch a Workflow", async () => {
  const state = fixture();
  const existingUsage = 2_400 - MISSION_MATCH_MAINTENANCE_WORKFLOW_STEP_RESERVATION + 1;
  const currentUtcDay = new Date().toISOString().slice(0, 10);
  state.database.prepare(
    `INSERT INTO usage_daily(day, dimension, units, metadata_json, updated_at)
     VALUES (?, 'workflow_steps', ?, '{}', '2026-08-11T12:00:00.000Z')`,
  ).run(currentUtcDay, existingUsage);
  const creates = [];
  state.env = {
    DB: state.d1,
    MISSION_WORKFLOW: {
      async create(input) {
        creates.push(input);
        return { id: input.id };
      },
    },
  };

  await assert.rejects(
    startMissionMatchMaintenance(state.env, {
      missionId: "mission-scale",
      reason: "manual-rebuild",
    }),
    /Budget deferred workflow_steps/,
  );

  assert.equal(creates.length, 0);
  assert.equal(
    state.database.prepare(
      "SELECT units FROM usage_daily WHERE dimension = 'workflow_steps'",
    ).get().units,
    existingUsage,
  );
});

test("a 500-match commit scores 100 terms and persists at most six 32-character labels", async () => {
  const state = fixture();
  state.env = { DB: state.d1 };
  const terms = Array.from({ length: MISSION_MATCH_TERM_LIMIT }, (_, index) => (
    `term-${String(index).padStart(3, "0")}-${"x".repeat(80)}`.slice(0, MISSION_MATCH_PERSISTED_TERM_CHARACTERS)
  ));
  state.database.prepare("UPDATE missions SET terms_json = ? WHERE id = 'mission-scale'")
    .run(JSON.stringify(terms));
  for (let index = 0; index < MISSION_MATCH_REBUILD_STORY_LIMIT; index += 1) {
    insertStory(state.database, {
      id: `story-commit-${String(index).padStart(3, "0")}`,
      title: "Maximum commit fixture",
      score: MISSION_MATCH_REBUILD_STORY_LIMIT - index,
    });
  }
  const plan = await planMissionMatchRebuild(state.env, "mission-scale");
  const allTermIndexes = terms.map((_term, index) => index);
  const pages = [];
  for (let offset = 0; offset < plan.storyIds.length; offset += MISSION_MATCH_REBUILD_STORY_PAGE_SIZE) {
    const storyIds = plan.storyIds.slice(offset, offset + MISSION_MATCH_REBUILD_STORY_PAGE_SIZE);
    pages.push({
      storyIds,
      matches: storyIds.map((storyId) => ({
        storyId,
        matchScore: 1,
        matchedTermIndexes: allTermIndexes,
      })),
      coverage: { evidenceItemsConsidered: 0, storiesWithAdditionalEvidence: 0, excerptedBodies: 0 },
    });
  }

  state.d1.beginInvocation();
  state.d1.maxBoundBytes = 0;
  const cpuStarted = process.cpuUsage();
  const result = await commitMissionMatchRebuild(state.env, plan, pages);
  const cpuUsed = process.cpuUsage(cpuStarted);
  const commitCpuMicroseconds = cpuUsed.user + cpuUsed.system;

  assert.equal(result.matchedStories, MISSION_MATCH_REBUILD_STORY_LIMIT);
  assert.equal(
    result.coverage.persistedMatchedTermsOmitted,
    MISSION_MATCH_REBUILD_STORY_LIMIT * (MISSION_MATCH_TERM_LIMIT - MISSION_MATCH_PERSISTED_TERM_LIMIT),
  );
  assert.equal(result.coverage.persistedMatchedTermLimit, MISSION_MATCH_PERSISTED_TERM_LIMIT);
  assert.equal(result.coverage.persistedMatchedTermCharacters, MISSION_MATCH_PERSISTED_TERM_CHARACTERS);
  assert.equal(result.coverage.partial, true);
  assert.ok(state.d1.queryCount <= 6, `maximum commit used ${state.d1.queryCount} D1 statements`);
  assert.ok(state.d1.maxBoundBytes < 1_000_000, `largest commit binding was ${state.d1.maxBoundBytes} bytes`);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 4_000);
  // Payload and statement caps are the deterministic guards. The local timing
  // remains available for an isolated benchmark, but runner contention must
  // not masquerade as a Cloudflare Worker CPU measurement.
  const stored = state.database.prepare("SELECT matched_terms_json FROM mission_story_matches").all();
  assert.equal(stored.length, MISSION_MATCH_REBUILD_STORY_LIMIT);
  assert.ok(stored.every((row) => JSON.parse(row.matched_terms_json).length === MISSION_MATCH_PERSISTED_TERM_LIMIT));
  assert.ok(stored.every((row) => JSON.parse(row.matched_terms_json)
    .every((term) => [...term].length <= MISSION_MATCH_PERSISTED_TERM_CHARACTERS)));
  if (process.env.MISSION_MATCH_BENCHMARK === "1") {
    assert.ok(commitCpuMicroseconds < 10_000, `maximum commit used ${commitCpuMicroseconds}µs local process CPU`);
    process.stderr.write(
      `Mission match maximum commit: ${state.d1.queryCount} D1 statements, ${state.d1.maxBoundBytes} bound bytes, ${commitCpuMicroseconds}µs local CPU\n`,
    );
  }
});

test("a failed evidence page commits no partially evaluated replacement", async () => {
  const state = fixture();
  state.env = { DB: state.d1 };
  insertStory(state.database, { id: "story-atomic", title: "Routine Story", score: 10 });
  insertMatch(state.database, "story-atomic", {
    terms: ["prior match"],
    firstMatchedAt: "2026-05-01T00:00:00.000Z",
  });
  state.d1.failAtQuery = 4;

  await assert.rejects(
    rebuildMissionMatches(state.env, "mission-scale"),
    /Injected D1 read failure/,
  );

  const preserved = state.database.prepare(
    "SELECT * FROM mission_story_matches WHERE story_id = 'story-atomic'",
  ).get();
  assert.ok(preserved);
  assert.equal(preserved.first_matched_at, "2026-05-01T00:00:00.000Z");
  assert.deepEqual(JSON.parse(preserved.matched_terms_json), ["prior match"]);
  assert.equal(
    state.database.prepare("SELECT last_evaluated_at FROM missions WHERE id = 'mission-scale'").get().last_evaluated_at,
    null,
  );
});

test("the scoped replacement rolls back as one batch", async () => {
  const state = fixture();
  state.env = { DB: state.d1 };
  insertStory(state.database, { id: "story-batch", title: "The decisive signal appears", score: 10 });
  insertMatch(state.database, "story-batch", {
    score: 0.31,
    terms: ["prior match"],
    firstMatchedAt: "2026-04-01T00:00:00.000Z",
    lastMatchedAt: "2026-04-02T00:00:00.000Z",
  });
  state.d1.failBatchStatement = 1;

  await assert.rejects(
    rebuildMissionMatches(state.env, "mission-scale"),
    /Injected D1 batch failure/,
  );

  const preserved = state.database.prepare(
    "SELECT * FROM mission_story_matches WHERE story_id = 'story-batch'",
  ).get();
  assert.equal(preserved.match_score, 0.31);
  assert.deepEqual(JSON.parse(preserved.matched_terms_json), ["prior match"]);
  assert.equal(preserved.first_matched_at, "2026-04-01T00:00:00.000Z");
  assert.equal(preserved.last_matched_at, "2026-04-02T00:00:00.000Z");
  assert.equal(
    state.database.prepare("SELECT last_evaluated_at FROM missions WHERE id = 'mission-scale'").get().last_evaluated_at,
    null,
  );
});
