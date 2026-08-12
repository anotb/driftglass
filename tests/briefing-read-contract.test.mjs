import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { latestOrBuildBriefing } = require("../.test-dist/briefing.js");
const { briefingInterfacePayload, briefingInterfaceText } = require("../.test-dist/briefing-interface.js");

class ReadOnlyStatement {
  constructor(database, query) {
    this.database = database;
    this.query = query;
  }

  bind() {
    return this;
  }

  async first() {
    this.database.calls.push({ kind: "first", query: this.query });
    return null;
  }

  async all() {
    this.database.calls.push({ kind: "all", query: this.query });
    return { success: true, results: [], meta: {} };
  }

  async run() {
    assert.fail(`briefing read attempted a database write: ${this.query}`);
  }
}

class ReadOnlyD1 {
  constructor() {
    this.calls = [];
  }

  prepare(query) {
    return new ReadOnlyStatement(this, query);
  }
}

test("missing or stale briefing reads build an ephemeral packet without persistence", async () => {
  const db = new ReadOnlyD1();
  const env = {
    DB: db,
    APP_NAME: "Driftglass test",
    MAX_DAILY_STORIES: "12",
    EVIDENCE: {
      put: async () => assert.fail("briefing read attempted an R2 write"),
      delete: async () => assert.fail("briefing read attempted R2 cleanup"),
    },
  };

  const result = await latestOrBuildBriefing(env);

  assert.match(result.id, /^ephemeral-/);
  assert.equal(result.packet.stories.length, 0);
  assert.match(result.markdown, /Driftglass test evidence packet/);
  assert.ok(db.calls.length > 0);
});

test("scheduled and explicit briefing generation remain persistent write paths", async () => {
  const [index, api, briefing] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/briefing.ts", import.meta.url), "utf8"),
  ]);
  assert.match(index, /await generateBriefing\(env, 24\)/);
  assert.match(api, /\/api\/briefings\/generate[\s\S]*await generateBriefing/);
  const readBoundary = briefing.slice(briefing.indexOf("export async function latestOrBuildBriefing"));
  assert.doesNotMatch(readBoundary, /generateBriefing\(|putEvidenceObject\(|insertBriefing\(/);
});

test("Today hands visible Mission candidates directly to citable Story fetches", () => {
  const payload = briefingInterfacePayload({
    generatedAt: "2026-08-08T12:00:00.000Z",
    coverage: { healthySources: 1, degradedSources: 0, offlineCollectors: 0 },
    actions: [],
    missions: [{
      id: "mission-one",
      name: "A standing question",
      question: "What materially changed?",
      sprintPolicy: "manual",
      nextSprintAt: null,
      expectedEventStatus: "none",
      matches: [1, 2, 3, 4].map((position) => ({
        storyId: `story-${position}`,
        title: `Story ${position}`,
        changedAt: `2026-08-0${position}T12:00:00.000Z`,
      })),
    }],
    resolvedMissions: [],
    stories: [],
  });
  const firstLine = briefingInterfaceText(payload).split("\n", 1)[0];

  assert.equal(payload.answerHandoff.answerReady, false);
  assert.equal(payload.answerHandoff.citableEvidenceIncluded, false);
  assert.deepEqual(payload.answerHandoff.requiredNextTools, ["fetch"]);
  assert.deepEqual(payload.answerHandoff.fallbackNextTools, ["find_missions", "get_mission", "fetch"]);
  assert.deepEqual(payload.missions[0].storyCandidates, [1, 2, 3].map((position) => ({
    id: `story-${position}`,
    title: `Story ${position}`,
    changedAt: `2026-08-0${position}T12:00:00.000Z`,
  })));
  assert.deepEqual(payload.missions[0].nextTool, {
    name: "fetch",
    ids: ["story-1", "story-2", "story-3"],
  });
  assert.match(firstLine, /^Today is orientation, not source evidence\./);
  assert.match(firstLine, /not answer-ready and contains no citable evidence/);
  assert.match(firstLine, /call fetch once for each relevant ID in its nextTool/);
  assert.match(firstLine, /find_missions then get_mission only when the Mission is absent or needs more candidates/);
});

test("Today overview payload matches its compact declared contract", () => {
  const payload = briefingInterfacePayload({
    generatedAt: "2026-08-09T12:00:00.000Z",
    coverage: { healthySources: 2, degradedSources: 1, offlineCollectors: 0, notes: ["internal coverage note"] },
    actions: [{
      id: "action-one",
      kind: "expected-soon",
      severity: "attention",
      missionId: "mission-one",
      missionName: "Private duplicate label",
      title: "Expected event is near",
      detail: "Check the event window.",
      dueAt: null,
      action: "internal-action-name",
      metadata: { privateShape: true },
    }],
    missions: [],
    resolvedMissions: [{
      id: "mission-resolved",
      name: "Resolved question",
      question: "Internal resolved question",
      outcomeStatus: "resolved",
      outcomeSummary: "The expected event occurred.",
      resolvedAt: "2026-08-09T11:00:00.000Z",
    }],
    stories: [],
  });

  assert.deepEqual(payload.coverage, { healthySources: 2, degradedSources: 1, offlineCollectors: 0 });
  assert.deepEqual(payload.actions[0], {
    id: "action-one",
    kind: "expected-soon",
    severity: "attention",
    missionId: "mission-one",
    title: "Expected event is near",
    detail: "Check the event window.",
    dueAt: null,
  });
  assert.deepEqual(payload.resolvedMissions[0], {
    id: "mission-resolved",
    name: "Resolved question",
    outcomeStatus: "resolved",
    outcomeSummary: "The expected event occurred.",
    resolvedAt: "2026-08-09T11:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(payload), /internal coverage note|Private duplicate label|internal-action-name|privateShape|Internal resolved question/);
});
