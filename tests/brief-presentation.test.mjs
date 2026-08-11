import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { z } = require("zod");
const compiledRoot = process.env.DRIFTGLASS_TEST_DIST;
const {
  BRIEF_PRESENTATION_TOOL_DESCRIPTION,
  briefPresentationInputSchema,
  briefPresentationOutputSchema,
  groundBriefPresentation,
} = compiledRoot
  ? require(join(compiledRoot, "brief-presentation.js"))
  : require("../.test-dist/brief-presentation.js");

const AUTHORITY_URL = "https://authority.example/notices/change";
const PUBLICATION_URL = "https://publication.example/analysis/change";

test("the presentation tool independently keeps evidence mechanics out of primary fields", () => {
  assert.match(
    BRIEF_PRESENTATION_TOOL_DESCRIPTION,
    /Do not narrate source counts, source families, coverage, evidence mechanics, tools, receipts, or the briefing process in thesis, keyJudgments, competingExplanation, watchFor, whatChanged, whyItMatters, or decision; keep limits in the collapsed source disclosure\./,
  );
  assert.match(BRIEF_PRESENTATION_TOOL_DESCRIPTION, /state, trajectory, explanation, comparison, or broad what-changed question, use answerMode synthesis/i);
  assert.match(BRIEF_PRESENTATION_TOOL_DESCRIPTION, /required cited thesis/i);
  assert.match(BRIEF_PRESENTATION_TOOL_DESCRIPTION, /one to four cited keyJudgments/);
  assert.match(BRIEF_PRESENTATION_TOOL_DESCRIPTION, /zero to two cited watchFor signals/);
  assert.match(BRIEF_PRESENTATION_TOOL_DESCRIPTION, /each extra block adds a distinct fact, mechanism, implication, or falsifier; omit every block that does not/);
  assert.match(BRIEF_PRESENTATION_TOOL_DESCRIPTION, /answerMode decision only when the user explicitly asks for a choice, action, test, deferral, or rollback rule/i);
});

function source(url, overrides = {}) {
  return {
    source: "Public authority",
    title: "Official change notice",
    url,
    author: null,
    publishedAt: "2026-08-09T10:00:00.000Z",
    observedAt: "2026-08-09T10:15:00.000Z",
    sourceFamily: "authority.example",
    lineageRelation: null,
    independence: "independent",
    excerpt: "The authority moved the permit sequence forward.",
    ...overrides,
  };
}

function readyToday() {
  const authority = source(AUTHORITY_URL);
  const publication = source(PUBLICATION_URL, {
    source: "Independent publication",
    title: "Analysis of the revised sequence",
    sourceFamily: "publication.example",
    excerpt: "The publication described the procurement implication.",
  });
  return {
    schemaVersion: "1",
    status: "ready",
    answerReady: true,
    quietDay: false,
    generatedAt: "2026-08-09T12:30:00.000Z",
    period: { start: "2026-08-08T12:30:00.000Z", end: "2026-08-09T12:30:00.000Z" },
    message: "Use the source excerpts below.",
    developments: [{
      title: "Raw source title",
      changedAt: "2026-08-09T10:15:00.000Z",
      change: "changed",
      evidenceLead: { text: "The permit sequence moved.", sourceUrl: AUTHORITY_URL },
      whyIncluded: "Relevant to the Mission.",
      missionRelevance: [{ name: "Grid resilience", question: "Which constraints change the build sequence?" }],
      sources: [authority, publication],
      sourceTrail: [
        { label: authority.title, url: authority.url },
        { label: publication.title, url: publication.url },
      ],
    }],
    sourceView: {
      sourceFamilies: ["authority.example", "publication.example"],
      independentSourceFamilies: ["authority.example", "publication.example"],
      lineageLimits: [],
    },
    citationUrls: [AUTHORITY_URL, PUBLICATION_URL],
    guidance: { evidenceBoundary: "Public evidence only.", sourceUse: "Cite exact URLs." },
  };
}

function input(overrides = {}) {
  return {
    briefKind: "today",
    whatChanged: {
      text: "The permit sequence moved forward.",
      citationUrls: [AUTHORITY_URL],
    },
    whyItMatters: {
      text: "The Mission can move from approval risk to procurement timing.",
      citationUrls: [AUTHORITY_URL, PUBLICATION_URL],
    },
    watchNext: {
      text: "Watch the next procurement notice.",
      citationUrls: [PUBLICATION_URL],
    },
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    testNow: {
      text: "Test the revised sequence on two procurements over seven days, against the current sequence.",
      citationUrls: [AUTHORITY_URL],
    },
    deferUntil: {
      text: "Defer the full migration until the next authority notice confirms that the sequence is stable.",
      citationUrls: [PUBLICATION_URL],
    },
    rollbackIf: {
      text: "Roll back if either procurement misses its approval handoff during the seven-day test.",
      citationUrls: [AUTHORITY_URL, PUBLICATION_URL],
    },
    ...overrides,
  };
}

function synthesisInput(overrides = {}) {
  return {
    briefKind: "today",
    answerMode: "synthesis",
    thesis: {
      text: "The permit change removes the formal approval bottleneck, so delivery now depends on whether procurement can absorb the revised sequence. The next constraint is execution capacity: the authority has moved the gate, while the independent analysis places the remaining risk in ordering and handoffs.",
      citationUrls: [AUTHORITY_URL, PUBLICATION_URL],
    },
    keyJudgments: [{
      title: "Approval is no longer the pacing item",
      text: "The authority moved the permit sequence forward. That changes the critical path from waiting for permission to coordinating purchases against the new order.",
      citationUrls: [AUTHORITY_URL],
    }, {
      title: "Procurement inherits the schedule risk",
      text: "The independent analysis identifies procurement timing as the consequence of the revised sequence. A permit milestone will not accelerate the build if ordering and approval handoffs remain on the old cadence.",
      citationUrls: [PUBLICATION_URL],
    }],
    competingExplanation: {
      text: "The change could still be administrative rather than operational if later notices preserve the old handoff dates. That would leave the build sequence effectively unchanged despite the revised permit order.",
      citationUrls: [AUTHORITY_URL, PUBLICATION_URL],
    },
    watchFor: [{
      text: "A procurement notice using the revised order would confirm that the permit change has propagated into execution; another notice on the old sequence would weaken the thesis.",
      citationUrls: [PUBLICATION_URL],
    }],
    ...overrides,
  };
}

function readyMission() {
  const authority = {
    ...source(AUTHORITY_URL),
    id: "evidence-private-id",
    sourceKind: "web",
  };
  const publication = {
    ...source(PUBLICATION_URL, {
      source: "Independent publication",
      title: "Analysis of the revised sequence",
      sourceFamily: "publication.example",
      excerpt: "The publication described the procurement implication.",
    }),
    id: "evidence-private-id-2",
    sourceKind: "web",
  };
  return {
    schemaVersion: "1",
    answerReady: true,
    evidenceWindow: {
      mode: "changes",
      asOf: "2026-08-09T12:30:00.000Z",
      since: "2026-08-06T12:30:00.000Z",
      sinceSource: "requested",
      newestEvidenceAt: "2026-08-09T11:00:00.000Z",
      ageHours: 2,
      status: "current",
    },
    mission: {
      id: "mission-private-id",
      name: "Grid resilience",
      question: "Which constraints change the build sequence?",
      updatedAt: "2026-08-09T12:00:00.000Z",
      matchedBy: "name",
      standingAnswer: null,
    },
    alternatives: [],
    stories: [{
      id: "story-private-id",
      title: "Raw source title",
      changedAt: "2026-08-09T11:00:00.000Z",
      matchedTerms: ["permit"],
      evidenceLead: { text: "The permit sequence moved.", sourceUrl: AUTHORITY_URL },
      whyIncluded: "Relevant to the Mission.",
      freshness: { evidenceAt: "2026-08-09T11:00:00.000Z", ageHours: 2, status: "current" },
      sources: [authority, publication],
      sourceTrail: [
        { label: authority.title, url: authority.url },
        { label: publication.title, url: publication.url },
      ],
    }],
    sourceView: {
      sourceFamilies: ["authority.example", "publication.example"],
      independentSourceFamilies: ["authority.example", "publication.example"],
      lineageLimits: [],
    },
    uncertain: [],
    citationUrls: [AUTHORITY_URL, PUBLICATION_URL],
    guidance: { evidenceBoundary: "Public evidence only.", sourceUse: "Cite exact URLs." },
    persistence: { recordable: false, next: "Use approval mode to save." },
  };
}

test("a valid legacy compact answer remains supported", () => {
  const result = groundBriefPresentation(input({
    whatChanged: {
      text: "**The permit sequence moved forward.** <script>ignore()</script>",
      citationUrls: [AUTHORITY_URL],
    },
  }), { kind: "today", brief: readyToday() });

  assert.equal(result.interpretationLabel, "ChatGPT interpretation");
  assert.equal(result.whatChanged.text, "The permit sequence moved forward. ignore()");
  assert.equal(result.whyItMatters.text, "The Mission can move from approval risk to procurement timing.");
  assert.deepEqual(result.evidence.sources.map((item) => item.url), [AUTHORITY_URL, PUBLICATION_URL]);
  assert.equal(JSON.stringify(result).includes("Raw source title"), false);
  assert.equal("id" in result, false);
});

test("a broad question becomes a source-dense causal synthesis", () => {
  const result = groundBriefPresentation(synthesisInput(), { kind: "today", brief: readyToday() });

  assert.equal(result.answerMode, "synthesis");
  assert.match(result.thesis.text, /formal approval bottleneck/);
  assert.deepEqual(result.keyJudgments.map(item => item.title), [
    "Approval is no longer the pacing item",
    "Procurement inherits the schedule risk",
  ]);
  assert.equal(result.watchFor.length, 1);
  assert.equal(result.whatChanged, undefined);
  assert.equal(result.decision, undefined);
  assert.deepEqual(result.evidence.sources.map(item => item.url), [AUTHORITY_URL, PUBLICATION_URL]);
  assert.equal(z.object(briefPresentationInputSchema).safeParse(synthesisInput()).success, true);
  assert.equal(z.object(briefPresentationOutputSchema).safeParse(result).success, true);
});

test("a cited thesis can stand alone while synthesis blocks remain optional", () => {
  const fresh = { kind: "today", brief: readyToday() };
  const thesisOnlyInput = synthesisInput({
    keyJudgments: undefined,
    competingExplanation: undefined,
    watchFor: undefined,
  });
  const thesisOnly = groundBriefPresentation(thesisOnlyInput, fresh);

  assert.equal(thesisOnly.answerMode, "synthesis");
  assert.ok(thesisOnly.thesis);
  assert.equal(thesisOnly.keyJudgments, undefined);
  assert.equal(thesisOnly.competingExplanation, undefined);
  assert.equal(thesisOnly.watchFor, undefined);
  assert.equal(z.object(briefPresentationInputSchema).safeParse(thesisOnlyInput).success, true);
  assert.equal(z.object(briefPresentationOutputSchema).safeParse(thesisOnly).success, true);

  const oneJudgment = groundBriefPresentation(synthesisInput({
    keyJudgments: [synthesisInput().keyJudgments[0]],
    competingExplanation: undefined,
    watchFor: [],
  }), fresh);
  assert.equal(oneJudgment.keyJudgments.length, 1);
  assert.equal(oneJudgment.watchFor, undefined);
});

test("synthesis mode enforces optional block bounds, mode separation, and grounding", () => {
  const fresh = { kind: "today", brief: readyToday() };
  assert.throws(
    () => groundBriefPresentation(synthesisInput({ thesis: undefined }), fresh),
    /requires a cited thesis/,
  );
  assert.throws(
    () => groundBriefPresentation(synthesisInput({ keyJudgments: [] }), fresh),
    /one to four cited keyJudgments/,
  );
  assert.throws(
    () => groundBriefPresentation(synthesisInput({
      keyJudgments: Array.from({ length: 5 }, (_, index) => ({
        ...synthesisInput().keyJudgments[0],
        title: `Judgment ${index + 1}`,
      })),
    }), fresh),
    /one to four cited keyJudgments/,
  );
  assert.throws(
    () => groundBriefPresentation(synthesisInput({
      watchFor: Array.from({ length: 3 }, () => synthesisInput().watchFor[0]),
    }), fresh),
    /zero to two cited watchFor signals/,
  );
  assert.throws(
    () => groundBriefPresentation(synthesisInput({ whatChanged: input().whatChanged }), fresh),
    /cannot include legacy decision-card fields/,
  );
  assert.throws(
    () => groundBriefPresentation(synthesisInput({
      keyJudgments: [{
        ...synthesisInput().keyJudgments[0],
        citationUrls: ["https://unknown.example/claim"],
      }, synthesisInput().keyJudgments[1]],
    }), fresh),
    /keyJudgments\[0\] cites a URL that is not in the fresh bounded brief/,
  );

  const privateMission = readyMission();
  assert.throws(() => groundBriefPresentation({
    ...synthesisInput(),
    briefKind: "mission",
    mission: "Grid resilience",
    keyJudgments: [{
      ...synthesisInput().keyJudgments[0],
      title: "Use mission-private-id",
    }, synthesisInput().keyJudgments[1]],
  }, { kind: "mission", brief: privateMission }), /keyJudgments\[0\]\.title echoes an internal identifier/);
});

test("explicit decision mode requires an operational row and excludes synthesis fields", () => {
  const fresh = { kind: "today", brief: readyToday() };
  assert.throws(
    () => groundBriefPresentation(input({ answerMode: "decision", watchNext: undefined, decision: undefined }), fresh),
    /decision mode requires at least one requested operational row/,
  );
  assert.throws(
    () => groundBriefPresentation(input({
      answerMode: "decision",
      watchNext: undefined,
      decision: { testNow: decision().testNow },
      thesis: synthesisInput().thesis,
    }), fresh),
    /decision mode cannot include synthesis fields/,
  );
  const result = groundBriefPresentation(input({
    answerMode: "decision",
    watchNext: undefined,
    decision: { testNow: decision().testNow },
  }), fresh);
  assert.equal(result.answerMode, "decision");
});

test("a valid Mission synthesis projects no private evidence or Mission IDs", () => {
  const result = groundBriefPresentation({
    ...input(),
    briefKind: "mission",
    mission: "Grid resilience",
    mode: "changes",
    since: "2026-08-06T12:30:00.000Z",
  }, { kind: "mission", brief: readyMission() });

  assert.equal(result.briefKind, "mission");
  assert.equal(result.title, "Grid resilience");
  assert.equal(result.context, "Which constraints change the build sequence?");
  assert.doesNotMatch(JSON.stringify(result), /mission-private-id|story-private-id|evidence-private-id/);
});

test("a complete decision is independently grounded and retains decision-only sources", () => {
  const result = groundBriefPresentation(input({
    whatChanged: { text: "The permit sequence moved.", citationUrls: [AUTHORITY_URL] },
    whyItMatters: { text: "The Mission can test the new sequence before committing.", citationUrls: [AUTHORITY_URL] },
    watchNext: undefined,
    decision: decision(),
  }), { kind: "today", brief: readyToday() });

  assert.deepEqual(result.decision, decision());
  assert.equal(result.watchNext, undefined);
  assert.deepEqual(result.evidence.sources.map((item) => item.url), [AUTHORITY_URL, PUBLICATION_URL]);
});

test("a non-migration recommendation can use one requested decision row", () => {
  const fresh = { kind: "today", brief: readyToday() };
  const result = groundBriefPresentation(input({
    watchNext: undefined,
    decision: {
      testNow: decision().testNow,
    },
  }), fresh);
  assert.deepEqual(result.decision, { testNow: decision().testNow });
  assert.equal(result.decision.deferUntil, undefined);
  assert.equal(result.decision.rollbackIf, undefined);
  assert.equal(z.object(briefPresentationInputSchema).safeParse(input({
    watchNext: undefined,
    decision: { testNow: decision().testNow },
  })).success, true);
  assert.equal(z.object(briefPresentationOutputSchema).safeParse(result).success, true);
  assert.equal(z.object(briefPresentationInputSchema).safeParse(input({
    watchNext: undefined,
    decision: {},
  })).success, false);
});

test("output schema enforces the same exact main, watch, and decision boundaries", () => {
  const schema = z.object(briefPresentationOutputSchema);
  const base = groundBriefPresentation(input(), { kind: "today", brief: readyToday() });
  const exact = {
    ...base,
    whatChanged: { ...base.whatChanged, text: "M".repeat(300) },
    whyItMatters: { ...base.whyItMatters, text: "N".repeat(300) },
    watchNext: { ...base.watchNext, text: "W".repeat(240) },
  };

  assert.equal(schema.safeParse(exact).success, true);
  assert.equal(schema.safeParse({
    ...exact,
    whatChanged: { ...exact.whatChanged, text: "M".repeat(301) },
  }).success, false);
  assert.equal(schema.safeParse({
    ...exact,
    watchNext: { ...exact.watchNext, text: "W".repeat(241) },
  }).success, false);

  const decisionBase = groundBriefPresentation(input({
    watchNext: undefined,
    decision: { testNow: decision().testNow },
  }), { kind: "today", brief: readyToday() });
  const exactDecision = {
    ...decisionBase,
    whatChanged: { ...decisionBase.whatChanged, text: "M".repeat(300) },
    decision: {
      testNow: { ...decisionBase.decision.testNow, text: "D".repeat(240) },
    },
  };
  assert.equal(schema.safeParse(exactDecision).success, true);
  assert.equal(schema.safeParse({
    ...exactDecision,
    decision: {
      testNow: { ...exactDecision.decision.testNow, text: "D".repeat(241) },
    },
  }).success, false);
});

test("output schema and grounding enforce finite synthesis boundaries", () => {
  const schema = z.object(briefPresentationOutputSchema);
  const base = groundBriefPresentation(synthesisInput(), { kind: "today", brief: readyToday() });
  const exact = {
    ...base,
    thesis: { ...base.thesis, text: "T".repeat(900) },
    keyJudgments: base.keyJudgments.map((item, index) => ({
      ...item,
      title: index === 0 ? "H".repeat(100) : item.title,
      text: "J".repeat(600),
    })),
    competingExplanation: { ...base.competingExplanation, text: "C".repeat(600) },
    watchFor: [{ ...base.watchFor[0], text: "W".repeat(360) }],
  };
  assert.equal(schema.safeParse(exact).success, true);
  assert.equal(schema.safeParse({
    ...exact,
    keyJudgments: [exact.keyJudgments[0]],
    competingExplanation: undefined,
    watchFor: [],
  }).success, true);
  assert.equal(schema.safeParse({
    ...exact,
    keyJudgments: undefined,
    competingExplanation: undefined,
    watchFor: undefined,
  }).success, true);
  assert.equal(schema.safeParse({ ...exact, keyJudgments: [] }).success, false);
  assert.equal(schema.safeParse({
    ...exact,
    watchFor: [exact.watchFor[0], exact.watchFor[0], exact.watchFor[0]],
  }).success, false);
  assert.equal(schema.safeParse({
    ...exact,
    thesis: { ...exact.thesis, text: "T".repeat(901) },
  }).success, false);
  assert.equal(schema.safeParse({
    ...exact,
    keyJudgments: exact.keyJudgments.map((item, index) => index === 0 ? { ...item, text: "J".repeat(601) } : item),
  }).success, false);
  assert.equal(schema.safeParse({
    ...exact,
    watchFor: [{ ...exact.watchFor[0], text: "W".repeat(361) }],
  }).success, false);

  const repeated = word => Array.from({ length: 400 }, () => word).join(" ");
  const grounded = groundBriefPresentation(synthesisInput({
    thesis: { text: repeated("thesis"), citationUrls: [AUTHORITY_URL] },
    keyJudgments: synthesisInput().keyJudgments.map(item => ({ ...item, text: repeated("mechanism") })),
    competingExplanation: { text: repeated("alternative"), citationUrls: [PUBLICATION_URL] },
    watchFor: [{ text: repeated("signal"), citationUrls: [AUTHORITY_URL] }],
  }), { kind: "today", brief: readyToday() });
  assert.ok(grounded.thesis.text.length <= 900);
  assert.ok(grounded.keyJudgments.every(item => item.text.length <= 600));
  assert.ok(grounded.competingExplanation.text.length <= 600);
  assert.ok(grounded.watchFor.every(item => item.text.length <= 360));
});

test("presentation rejects an empty decision, decision plus watchNext, and ungrounded included rows", () => {
  const fresh = { kind: "today", brief: readyToday() };
  assert.throws(() => groundBriefPresentation(input({
    watchNext: undefined,
    decision: {},
  }), fresh), /decision must include at least one of testNow, deferUntil, or rollbackIf/);
  assert.throws(() => groundBriefPresentation(input({
    decision: decision(),
  }), fresh), /decision and watchNext cannot be combined/);
  assert.throws(() => groundBriefPresentation(input({
    watchNext: undefined,
    decision: decision({
      deferUntil: { text: "Defer the migration.", citationUrls: ["https://unknown.example/change"] },
    }),
  }), fresh), /decision\.deferUntil cites a URL that is not in the fresh bounded brief/);
  assert.throws(() => groundBriefPresentation(input({
    watchNext: undefined,
    decision: decision({
      rollbackIf: { text: `Roll back after reading ${AUTHORITY_URL}.`, citationUrls: [AUTHORITY_URL] },
    }),
  }), fresh), /decision\.rollbackIf must keep URLs in citationUrls/);
});

test("presentation rejects exact internal IDs, private values, and saved-answer proof echoes", () => {
  const brief = readyMission();
  brief.mission.standingAnswer = {
    currentThesis: "Adopt the cached baseline immediately after the next release.",
    reportSummary: "The reviewed baseline favored the previous workflow.",
    openQuestions: ["Will the old approval path remain available?"],
    updatedAt: "2026-08-08T12:00:00.000Z",
  };
  brief.privateCapability = "capability-secret-value-987654";
  const base = {
    ...input(),
    briefKind: "mission",
    mission: "Grid resilience",
    mode: "changes",
    since: "2026-08-06T12:30:00.000Z",
  };

  for (const echoed of [
    "mission-private-id",
    "MISSION-PRIVATE-ID",
    "story-private-id",
    "StOrY-PrIvAtE-Id",
    "evidence-private-id",
    "capability-secret-value-987654",
    "Adopt the cached baseline immediately after the next release",
    "ADOPT THE CACHED BASELINE IMMEDIATELY AFTER THE NEXT RELEASE",
    "The Reviewed Baseline Favored The Previous Workflow",
  ]) {
    assert.throws(() => groundBriefPresentation({
      ...base,
      whatChanged: { text: `Use ${echoed} as the deciding fact.`, citationUrls: [AUTHORITY_URL] },
    }, { kind: "mission", brief }), /internal identifier, private value, or non-citable saved orientation/);
  }
});

test("projected source metadata redacts internal values before the widget sees it", () => {
  const brief = readyMission();
  brief.stories[0].sources[0].title = "Notice for EVIDENCE-PRIVATE-ID";
  brief.stories[0].sources[0].excerpt = "The internal Mission was MISSION-PRIVATE-ID.";
  brief.stories[0].sourceTrail[0].label = "Notice for EVIDENCE-PRIVATE-ID";
  const result = groundBriefPresentation({
    ...input(),
    briefKind: "mission",
    mission: "Grid resilience",
    mode: "changes",
    since: "2026-08-06T12:30:00.000Z",
  }, { kind: "mission", brief });

  assert.doesNotMatch(JSON.stringify(result.evidence.sources), /mission-private-id|evidence-private-id/i);
  assert.match(JSON.stringify(result.evidence.sources), /private value omitted/);
});

test("presentation rejects missing, altered, private, and prose-embedded citation URLs", () => {
  const fresh = { kind: "today", brief: readyToday() };
  assert.throws(() => groundBriefPresentation(input({
    whatChanged: { text: "Uncited.", citationUrls: [] },
  }), fresh), /one to three exact citation URLs/);
  assert.throws(() => groundBriefPresentation(input({
    whatChanged: { text: "Altered.", citationUrls: [`${AUTHORITY_URL}/extra`] },
  }), fresh), /not in the fresh bounded brief/);
  assert.throws(() => groundBriefPresentation(input({
    whatChanged: { text: "Private.", citationUrls: ["http://127.0.0.1/private"] },
  }), fresh), /not in the fresh bounded brief/);
  assert.throws(() => groundBriefPresentation(input({
    whatChanged: { text: `Read ${AUTHORITY_URL}.`, citationUrls: [AUTHORITY_URL] },
  }), fresh), /keep URLs in citationUrls/);
});

test("quiet and evidence-limited briefs cannot mount a synthetic interpretation", () => {
  const quiet = { ...readyToday(), status: "quiet", answerReady: true, quietDay: true, developments: [], citationUrls: [] };
  assert.throws(
    () => groundBriefPresentation(input(), { kind: "today", brief: quiet }),
    /no citable development to present/,
  );

  const limited = { ...readyToday(), status: "evidence-limited", answerReady: false, developments: [], citationUrls: [] };
  assert.throws(
    () => groundBriefPresentation(input(), { kind: "today", brief: limited }),
    /no citable development to present/,
  );

  const emptyMission = { ...readyMission(), answerReady: false, stories: [], citationUrls: [] };
  assert.throws(
    () => groundBriefPresentation({
      ...input(),
      briefKind: "mission",
      mission: "Grid resilience",
    }, { kind: "mission", brief: emptyMission }),
    /Mission brief has no citable development to present/,
  );
});

test("presentation rejects routing mismatches and returns only the cited source subset", () => {
  assert.throws(
    () => groundBriefPresentation(input(), { kind: "mission", brief: readyMission() }),
    /presentation scope does not match/,
  );
  assert.throws(
    () => groundBriefPresentation(input({ mission: "Grid resilience" }), { kind: "today", brief: readyToday() }),
    /Today presentation cannot carry Mission routing arguments/,
  );

  const result = groundBriefPresentation(input({
    whatChanged: { text: "The sequence moved.", citationUrls: [AUTHORITY_URL] },
    whyItMatters: { text: "The delay cleared.", citationUrls: [AUTHORITY_URL] },
    watchNext: undefined,
  }), { kind: "today", brief: readyToday() });
  assert.deepEqual(result.evidence.sources.map((item) => item.url), [AUTHORITY_URL]);
});

test("model-facing schema accepts verbose bounded drafts before grounding clamps every render mode", () => {
  const repeated = (word, count) => Array.from({ length: count }, () => word).join(" ");
  const schema = z.object(briefPresentationInputSchema);
  const verboseBrief = input({
    whatChanged: { text: repeated("change", 100), citationUrls: [AUTHORITY_URL] },
    whyItMatters: { text: repeated("impact", 100), citationUrls: [AUTHORITY_URL] },
    watchNext: { text: repeated("trigger", 80), citationUrls: [PUBLICATION_URL] },
  });

  assert.equal(schema.safeParse(verboseBrief).success, true);
  const briefResult = groundBriefPresentation(verboseBrief, { kind: "today", brief: readyToday() });
  assert.ok(briefResult.whatChanged.text.length <= 300);
  assert.ok(briefResult.whyItMatters.text.length <= 300);
  assert.ok(briefResult.watchNext.text.length <= 240);
  assert.match(briefResult.whatChanged.text, /change…$/);
  assert.match(briefResult.watchNext.text, /trigger…$/);

  const verboseDecision = input({
    watchNext: undefined,
    whatChanged: { text: repeated("change", 100), citationUrls: [AUTHORITY_URL] },
    whyItMatters: { text: repeated("impact", 100), citationUrls: [AUTHORITY_URL] },
    decision: {
      testNow: { text: repeated("checkpoint", 100), citationUrls: [AUTHORITY_URL] },
    },
  });
  assert.equal(schema.safeParse(verboseDecision).success, true);
  const decisionResult = groundBriefPresentation(verboseDecision, { kind: "today", brief: readyToday() });
  assert.ok(decisionResult.whatChanged.text.length <= 300);
  assert.ok(decisionResult.whyItMatters.text.length <= 300);
  assert.ok(decisionResult.decision.testNow.text.length <= 240);
  assert.match(decisionResult.decision.testNow.text, /checkpoint…$/);
  assert.equal(z.object(briefPresentationOutputSchema).safeParse(decisionResult).success, true);

  assert.equal(schema.safeParse(input({
    whatChanged: { text: "A".repeat(2_001), citationUrls: [AUTHORITY_URL] },
  })).success, false);
  assert.equal(schema.safeParse(input({
    watchNext: undefined,
    decision: {
      testNow: { text: "A".repeat(2_001), citationUrls: [AUTHORITY_URL] },
    },
  })).success, false);
});

test("decision-card compaction drops a trailing partial sentence cleanly", () => {
  const first = "The core request path now uses stateless exchange while preserving compatibility hooks for callers on the older contract.";
  const second = "The release also keeps explicit approvals, an unchanged fallback, and observable review gates while every team validates authorization behavior.";
  const third = "This third sentence should disappear instead of leaving a dangling fragment in the live card.";
  const draft = `${first} ${second} ${third}`;
  const submitted = input({
    watchNext: undefined,
    whatChanged: { text: draft, citationUrls: [AUTHORITY_URL] },
    decision: { testNow: decision().testNow },
  });

  assert.equal(z.object(briefPresentationInputSchema).safeParse(submitted).success, true);
  const result = groundBriefPresentation(submitted, { kind: "today", brief: readyToday() });
  assert.equal(result.whatChanged.text, `${first} ${second}`);
  assert.doesNotMatch(result.whatChanged.text, /\bThis\b|…$/);
  assert.ok(result.whatChanged.text.length <= 300);
});

test("decision-row fallback prefers a stable clause and strips dangling connectors", () => {
  const stableClause = "Test the new route against the current fallback for twenty requests with identical payloads, reviewers, approval timing, and retry policy";
  const clauseDraft = `${stableClause}; keep collecting secondary observations until every possible edge case has been exhausted and or if the route changes`;
  const connectorDraft = `${"checkpoint ".repeat(21)}or if the remaining observations disagree with the baseline`;
  const result = groundBriefPresentation(input({
    watchNext: undefined,
    decision: {
      testNow: { text: clauseDraft, citationUrls: [AUTHORITY_URL] },
      deferUntil: { text: connectorDraft, citationUrls: [PUBLICATION_URL] },
    },
  }), { kind: "today", brief: readyToday() });

  assert.equal(result.decision.testNow.text, `${stableClause}…`);
  assert.match(result.decision.deferUntil.text, /checkpoint…$/);
  assert.doesNotMatch(result.decision.deferUntil.text, /\b(?:or|if|the|use)…$/i);
  assert.ok(result.decision.testNow.text.length <= 240);
  assert.ok(result.decision.deferUntil.text.length <= 240);
});

test("submitted fields remain tightly bounded", () => {
  const result = groundBriefPresentation(input({
    whatChanged: { text: "A".repeat(600), citationUrls: [AUTHORITY_URL] },
    whyItMatters: { text: "B".repeat(600), citationUrls: [AUTHORITY_URL] },
    watchNext: { text: "C".repeat(400), citationUrls: [PUBLICATION_URL] },
  }), { kind: "today", brief: readyToday() });
  assert.ok(result.whatChanged.text.length <= 300);
  assert.ok(result.whyItMatters.text.length <= 300);
  assert.ok(result.watchNext.text.length <= 240);

  const mission = readyMission();
  mission.mission = {
    ...mission.mission,
    name: "N".repeat(300),
    question: "Q".repeat(700),
  };
  const missionResult = groundBriefPresentation({
    ...input(),
    briefKind: "mission",
    mission: "Grid resilience",
  }, { kind: "mission", brief: mission });
  assert.ok(missionResult.title.length <= 160);
  assert.ok(missionResult.context.length <= 360);

  const decisionResult = groundBriefPresentation(input({
    watchNext: undefined,
    whatChanged: { text: "G".repeat(400), citationUrls: [AUTHORITY_URL] },
    whyItMatters: { text: "H".repeat(400), citationUrls: [AUTHORITY_URL] },
    decision: decision({
      testNow: { text: "D".repeat(300), citationUrls: [AUTHORITY_URL] },
      deferUntil: { text: "E".repeat(300), citationUrls: [PUBLICATION_URL] },
      rollbackIf: { text: "F".repeat(300), citationUrls: [AUTHORITY_URL] },
    }),
  }), { kind: "today", brief: readyToday() });
  assert.ok(decisionResult.whatChanged.text.length <= 300);
  assert.ok(decisionResult.whyItMatters.text.length <= 300);
  assert.ok(decisionResult.decision.testNow.text.length <= 240);
  assert.ok(decisionResult.decision.deferUntil.text.length <= 240);
  assert.ok(decisionResult.decision.rollbackIf.text.length <= 240);
});
