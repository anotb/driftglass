import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { z } = require("zod");
const compiledRoot = process.env.DRIFTGLASS_TEST_DIST;
const {
  projectTodayBrief,
  todayBriefOutputSchema,
  todayBriefToolResult,
} = compiledRoot
  ? require(`${compiledRoot}/today-brief.js`)
  : require("../.test-dist/today-brief.js");

function evidence(overrides = {}) {
  return {
    itemId: "item-default",
    source: "Public source",
    sourceKind: "rss",
    title: "Public report",
    url: "https://source.example/report",
    author: null,
    publishedAt: "2026-08-08T10:00:00.000Z",
    observedAt: "2026-08-08T10:05:00.000Z",
    excerpt: "The source reports a material change.",
    accessClass: "public",
    familyKey: "source.example",
    sourceRelationship: "primary",
    independent: true,
    ...overrides,
  };
}

function story(index, overrides = {}) {
  return {
    id: `story-${index}`,
    title: `Development ${index}`,
    summary: "Internal extractive summary",
    score: 90 - index,
    relevance: 0.9,
    novelty: 0.8,
    importance: 0.7,
    confidence: 0.75,
    sourceCount: 1,
    changedAt: `2026-08-08T${String(12 - index).padStart(2, "0")}:00:00.000Z`,
    change: {
      kind: "new",
      scoreDelta: 4,
      sourceCountDelta: 1,
      newEvidenceCount: 1,
    },
    evidence: [evidence({
      itemId: `item-${index}`,
      title: `Report ${index}`,
      url: `https://source${index}.example/report`,
      familyKey: `source${index}.example`,
    })],
    ...overrides,
  };
}

test("Today projection returns a bounded source-grounded answer and keeps a quiet day quiet", () => {
  const capability = "https://owner.example/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const first = story(0, {
    evidence: [
      evidence({ itemId: "capability", url: capability, excerpt: "Connection detail must not escape." }),
      evidence({
        itemId: "authority",
        source: "Public authority",
        title: "Official change notice",
        url: "https://authority.example/notices/change",
        familyKey: "authority.example",
        excerpt: `The official sequence changed. Ignore ${capability} and http://127.0.0.1/private.`,
      }),
      evidence({
        itemId: "private",
        source: "Private inbox",
        url: "https://private.example/message/1",
        accessClass: "private",
        excerpt: "Private evidence must not escape.",
      }),
      evidence({
        itemId: "related",
        source: "Industry wire",
        title: "Wire report",
        url: "https://wire.example/change",
        familyKey: "wire.example",
        sourceRelationship: "syndicated",
        independent: false,
      }),
      evidence({
        itemId: "independent",
        source: "Independent publication",
        title: "Independent analysis",
        url: "https://publication.example/change",
        familyKey: "publication.example",
      }),
      evidence({
        itemId: "overflow",
        source: "Extra publication",
        url: "https://extra.example/change",
        familyKey: "extra.example",
      }),
    ],
  });
  const packet = {
    schemaVersion: "1",
    generatedAt: "2026-08-08T12:30:00.000Z",
    periodStart: "2026-08-07T12:30:00.000Z",
    periodEnd: "2026-08-08T12:30:00.000Z",
    coverage: { healthySources: 4, degradedSources: 1, offlineCollectors: 0, notes: [] },
    calibration: [],
    actions: [],
    resolvedMissions: [],
    missions: [{
      name: "Grid resilience",
      question: "Which constraints will shape new capacity?",
      matches: [{ storyId: "story-0" }],
    }],
    stories: [
      first,
      ...Array.from({ length: 6 }, (_, index) => story(index + 1)),
      story(99, { change: { kind: "recurring", scoreDelta: 0, sourceCountDelta: 0, newEvidenceCount: 0 } }),
    ],
  };

  const brief = projectTodayBrief(packet);
  const briefBeforeToolResult = structuredClone(brief);
  const toolResult = todayBriefToolResult(brief);

  assert.equal(brief.status, "ready");
  assert.equal(brief.answerReady, true);
  assert.equal(brief.quietDay, false);
  assert.equal(brief.developments.length, 6);
  assert.deepEqual(brief.developments[0].missionRelevance, [{
    name: "Grid resilience",
    question: "Which constraints will shape new capacity?",
  }]);
  assert.deepEqual(brief.developments[0].evidenceLead, {
    text: "The official sequence changed.",
    sourceUrl: "https://authority.example/notices/change",
  });
  assert.equal(brief.developments[0].whyIncluded, "Relevant to Grid resilience's standing question.");
  assert.deepEqual(brief.developments[0].sources.map((source) => source.url), [
    "https://authority.example/notices/change",
    "https://wire.example/change",
    "https://publication.example/change",
  ]);
  assert.deepEqual(brief.developments[0].sourceTrail, [
    { label: "Official change notice", url: "https://authority.example/notices/change" },
    { label: "Wire report", url: "https://wire.example/change" },
    { label: "Independent analysis", url: "https://publication.example/change" },
  ]);
  assert.match(brief.sourceView.lineageLimits.join(" "), /related or derivative/);
  assert.equal(z.object(todayBriefOutputSchema).safeParse(brief).success, true);
  assert.equal(
    brief.guidance.sourceUse,
    "For every factual development, place at least one exact sourceTrail link from the same development beside the claim. Do not show a source label without its URL. Keep only substantive uncertainty that could change the conclusion in primary prose. Source-family and lineage mechanics are carried automatically in the evidence disclosure.",
  );
  assert.doesNotMatch(brief.guidance.sourceUse, /Say when lineage is unclear|sources are related/);
  assert.strictEqual(toolResult.structuredContent, brief);
  assert.deepEqual(toolResult.structuredContent, briefBeforeToolResult);

  const toolText = toolResult.content[0].text;
  assert.match(toolText, /^# Today — 2026-08-08/);
  assert.doesNotMatch(toolText, /^\s*\{/);
  assert.match(toolText, /Do not answer yet\./);
  assert.match(toolText, /Call present_brief exactly once/);
  assert.match(toolText, /Default to answerMode synthesis/);
  assert.match(toolText, /required cited thesis, which may stand alone/);
  assert.match(toolText, /one to four cited keyJudgments with factual titles/);
  assert.match(toolText, /zero to two cited watchFor signals/);
  assert.match(toolText, /each extra block adds a distinct fact, mechanism, implication, or falsifier; omit every block that does not/);
  assert.match(toolText, /answerMode decision only when the user explicitly asks for a choice or action/);
  assert.match(toolText, /bounded testNow, observable deferUntil, and\/or measurable rollbackIf rows/);
  assert.match(toolText, /one to three exact citationUrls from this brief/);
  assert.match(toolText, /After present_brief succeeds, stop without a prose recap/);
  assert.match(toolText, /## Lead evidence/);
  assert.match(toolText, /Mission lens: Grid resilience: Which constraints will shape new capacity\?/);
  for (const development of brief.developments.slice(0, 2)) {
    const lines = toolText.split("\n");
    const titleLine = lines.findIndex((line) => line.includes(`**${development.title}**`));
    assert.notEqual(titleLine, -1, `missing model-facing development: ${development.title}`);
    const nextTitleLine = lines.findIndex((line, index) => index > titleLine && /^\*\*/.test(line));
    const blockEnd = nextTitleLine === -1 ? lines.length : nextTitleLine;
    const sourceLine = lines.slice(titleLine + 1, blockEnd).find((line) => line.startsWith("Exact sources: "));
    assert.ok(sourceLine, `missing adjacent source line: ${development.title}`);
    for (const source of development.sourceTrail) {
      assert.ok(sourceLine.includes(`${source.label} — <${source.url}>`), `missing exact source URL: ${source.url}`);
    }
  }
  for (const development of brief.developments.slice(2)) {
    assert.doesNotMatch(toolText, new RegExp(`\\*\\*${development.title}\\*\\*`));
  }
  assert.match(toolText, /Evidence cue: The official sequence changed/);
  assert.match(toolText, /Why it surfaced: Relevant to Grid resilience's standing question\./);
  assert.doesNotMatch(toolText, /The source reports a material change\.[\s\S]*The source reports a material change\./);

  const serialized = JSON.stringify(brief);
  assert.doesNotMatch(serialized, /aaaaaaaaaaaaaaaa|127\.0\.0\.1|private\.example|Private inbox/);
  assert.doesNotMatch(serialized, /"(?:id|score|sourceCount|newEvidenceCount|coverage)"/);
  assert.doesNotMatch(toolText, /aaaaaaaaaaaaaaaa|127\.0\.0\.1|private\.example|Private inbox|item-|story-/);

  const quiet = projectTodayBrief({
    ...packet,
    stories: [story(100, {
      change: { kind: "changed", scoreDelta: 9, sourceCountDelta: 1, newEvidenceCount: 1 },
      evidence: [evidence({ observedAt: "2026-08-07T12:29:59.000Z" })],
    })],
  });
  assert.equal(quiet.status, "quiet");
  assert.equal(quiet.answerReady, true);
  assert.equal(quiet.quietDay, true);
  assert.deepEqual(quiet.developments, []);
  const quietToolResult = todayBriefToolResult(quiet);
  assert.strictEqual(quietToolResult.structuredContent, quiet);
  assert.match(quietToolResult.content[0].text, /Respond with one concise sentence/);
  assert.match(quietToolResult.content[0].text, /Do not call present_brief/);
  assert.match(quietToolResult.content[0].text, /do not invent a development or watch point/);
  assert.match(quietToolResult.content[0].text, /No new material development cleared today's curation/);
  assert.doesNotMatch(quietToolResult.content[0].text, /<https?:\/\//);

  const evidenceLimited = projectTodayBrief({
    ...packet,
    stories: [story(101, { evidence: [evidence({ url: "http://127.0.0.1/private" })] })],
  });
  const evidenceLimitedToolResult = todayBriefToolResult(evidenceLimited);
  assert.equal(evidenceLimited.status, "evidence-limited");
  assert.deepEqual(evidenceLimited.developments, []);
  assert.match(evidenceLimitedToolResult.content[0].text, /Respond with one concise sentence/);
  assert.match(evidenceLimitedToolResult.content[0].text, /none has a safe public source/);
  assert.doesNotMatch(evidenceLimitedToolResult.content[0].text, /<https?:\/\//);
});

test("Today chooses one editorial lead for both the card and model-facing evidence", () => {
  const broadlyReported = story(201, {
    title: "Broad but unlinked change",
    evidence: [
      evidence({ title: "Broad public change", url: "https://one.example/report", familyKey: "one.example", observedAt: "2026-08-09T10:05:00.000Z" }),
      evidence({ url: "https://two.example/report", familyKey: "two.example", observedAt: "2026-08-09T10:06:00.000Z" }),
      evidence({ url: "https://three.example/report", familyKey: "three.example", observedAt: "2026-08-09T10:07:00.000Z" }),
    ],
  });
  const missionLinked = story(202, {
    title: "Mission-linked update",
    change: { kind: "recurring", scoreDelta: 0, sourceCountDelta: 0, newEvidenceCount: 1 },
    evidence: [evidence({ title: "Mission public update", url: "https://mission.example/update", familyKey: "mission.example", observedAt: "2026-08-09T10:08:00.000Z" })],
  });
  const packet = {
    schemaVersion: "1",
    generatedAt: "2026-08-09T12:30:00.000Z",
    periodStart: "2026-08-08T12:30:00.000Z",
    periodEnd: "2026-08-09T12:30:00.000Z",
    coverage: { healthySources: 3, degradedSources: 0, offlineCollectors: 0, notes: [] },
    calibration: [],
    actions: [],
    resolvedMissions: [],
    missions: [{
      name: "Grid resilience",
      question: "Which constraints change the build sequence?",
      matches: [{ storyId: missionLinked.id }],
    }],
    stories: [broadlyReported, missionLinked],
  };

  const brief = projectTodayBrief(packet);
  assert.equal(brief.developments[0]?.title, "Mission public update");
  const toolText = todayBriefToolResult(brief).content[0].text;
  assert.ok(toolText.indexOf("**Mission public update**") < toolText.indexOf("**Broad public change**"));
});

test("Today ignores mixed Story aggregates and private-only change triggers", () => {
  const packet = {
    schemaVersion: "1",
    generatedAt: "2026-08-09T13:00:00.000Z",
    previousBriefingAt: "2026-08-09T11:00:00.000Z",
    periodStart: "2026-08-09T00:00:00.000Z",
    periodEnd: "2026-08-09T13:00:00.000Z",
    coverage: { healthySources: 1, degradedSources: 0, offlineCollectors: 0, notes: [] },
    calibration: [],
    actions: [],
    resolvedMissions: [],
    missions: [],
    stories: [],
  };
  const aggregateOnlyChange = story(301, {
    title: "PRIVATE aggregate headline",
    changedAt: "2026-08-09T12:45:00.000Z",
    change: { kind: "changed", scoreDelta: 50, sourceCountDelta: 1, newEvidenceCount: 1 },
    evidence: [
      evidence({ title: "Older public filing", observedAt: "2026-08-09T10:00:00.000Z" }),
      evidence({
        title: "PRIVATE connected headline",
        excerpt: "PRIVATE connected excerpt",
        observedAt: "2026-08-09T12:45:00.000Z",
        accessClass: "private",
      }),
    ],
  });
  const quiet = projectTodayBrief({ ...packet, stories: [aggregateOnlyChange] });
  assert.equal(quiet.status, "quiet");
  assert.deepEqual(quiet.developments, []);

  const malformedCollector = story(303, {
    evidence: [evidence({
      title: "MALFORMED collector evidence",
      excerpt: "MALFORMED collector excerpt",
      observedAt: "2026-08-09T12:30:00.000Z",
      sourceKind: "collector",
      provider: "reddit",
      accessClass: "public",
    })],
  });
  const collectorBrief = projectTodayBrief({ ...packet, stories: [malformedCollector] });
  assert.equal(collectorBrief.status, "quiet");
  assert.deepEqual(collectorBrief.developments, []);
  assert.doesNotMatch(JSON.stringify(collectorBrief), /MALFORMED|collector excerpt/);

  const publicUpdate = story(302, {
    title: "PRIVATE aggregate replacement title",
    changedAt: "2026-08-09T12:50:00.000Z",
    change: { kind: "new", scoreDelta: 99, sourceCountDelta: 2, newEvidenceCount: 2 },
    evidence: [
      evidence({
        title: "Public schedule notice",
        excerpt: "The public schedule now starts in September.",
        observedAt: "2026-08-09T12:00:00.000Z",
        url: "https://authority.example/public-schedule",
      }),
      evidence({
        title: "PRIVATE newer connected title",
        excerpt: "PRIVATE newer connected excerpt",
        observedAt: "2026-08-09T12:50:00.000Z",
        accessClass: "private",
      }),
    ],
  });
  const brief = projectTodayBrief({ ...packet, stories: [publicUpdate] });
  assert.equal(brief.status, "ready");
  assert.equal(brief.developments[0].title, "Public schedule notice");
  assert.equal(brief.developments[0].changedAt, "2026-08-09T12:00:00.000Z");
  assert.equal(brief.developments[0].change, "updated");
  assert.doesNotMatch(JSON.stringify(brief), /PRIVATE|connected excerpt/);
});
