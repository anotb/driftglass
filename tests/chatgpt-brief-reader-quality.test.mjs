import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const fixtureUrl = new URL("fixtures/chatgpt-brief-reader-quality-v8.json", import.meta.url);

async function corpus() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

async function widgetSource() {
  return readFile(new URL("src/chatgpt-brief-widget.ts", root), "utf8");
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function widgetHarness(source) {
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(source)?.[1];
  assert.ok(script, "v8 widget script is present");
  const listeners = new Map();
  const parent = { postMessage() {} };
  let html = "<p>Loading Driftglass…</p>";
  const widgetRoot = {
    className: "",
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; },
    querySelector: () => null,
  };
  const documentElement = {
    style: { height: "" },
    scrollHeight: 0,
    getBoundingClientRect: () => ({ width: 640, height: 0 }),
  };
  const body = {
    scrollHeight: 0,
    getBoundingClientRect: () => ({ width: 640, height: 0 }),
  };
  const window = {
    parent,
    innerWidth: 640,
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  vm.runInNewContext(script, {
    window,
    document: { getElementById: () => widgetRoot, documentElement, body },
    URL,
    Date,
    Map,
    Set,
    Object,
    Array,
    Math,
    String,
    Number,
  });
  return presentation => {
    const listener = listeners.get("message");
    assert.ok(listener, "v8 widget registered its result listener");
    listener({
      source: parent,
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: presentation },
      },
    });
    return widgetRoot.innerHTML;
  };
}

function sections(presentation) {
  return [
    ["whatChanged", presentation.whatChanged],
    ["whyItMatters", presentation.whyItMatters],
    ...Object.entries(presentation.decision ?? {}).map(([name, section]) => [`decision.${name}`, section]),
    ...(presentation.watchNext ? [["watchNext", presentation.watchNext]] : []),
  ];
}

function expectedDecisionRows(presentation) {
  return ["testNow", "deferUntil", "rollbackIf"].filter(name => presentation.decision?.[name]);
}

function fieldText(presentation, field) {
  if (field === "quietResponse") return "";
  return field.split(".").reduce((value, key) => value?.[key], presentation)?.text ?? "";
}

function visibleAnswerText(field, value) {
  if (!field.startsWith("decision.")) return value;
  return value.replace(/^ChatGPT judgment(?::(?:\s+|$)|\s+[-–—]\s+)/, "").trim();
}

function causalSynthesis() {
  const flow = "https://energy-agency.example/reports/hormuz-flows";
  const security = "https://maritime-center.example/advisories/hormuz-risk";
  const lng = "https://energy-admin.example/analysis/gulf-lng";
  return {
    schemaVersion: "1",
    briefKind: "mission",
    interpretationLabel: "ChatGPT interpretation",
    answerMode: "synthesis",
    title: "Strait of Hormuz normalization",
    context: "Has the Strait reopened enough for energy markets to normalize, and what would prove it?",
    thesis: {
      text: "The Strait is open enough to move crude again, but the energy system has not normalized. Gulf exports recovered to 16.1 million barrels a day in June, still below the 24 million prewar baseline, while refined products and LPG remained below half of prior volumes. Three tanker strikes and traffic near 25 transits a day versus a historical 138 show why one security incident could still reverse the recovery. Crude prices alone therefore overstate how much transport, refining, and LNG capacity has healed.",
      citationUrls: [flow, security, lng],
    },
    keyJudgments: [{
      title: "Crude recovered before the rest of the chain",
      text: "Tanker flows can restart faster than shut-in production, refineries, and export terminals. June crude exports reached roughly three quarters of the prewar rate, yet refined products and LPG stayed below half, shifting scarcity from benchmark crude into fuels, freight, and insurance.",
      citationUrls: [flow],
    }, {
      title: "Security still sets the corridor's usable capacity",
      text: "Mines, tanker attacks, crew risk, and navigation interference can suppress traffic without a legal closure. The maritime advisory recorded three strikes and about 24 to 25 daily transits, so the corridor was carrying energy under severe risk rather than operating on its old 138-vessel rhythm.",
      citationUrls: [security],
    }, {
      title: "LNG damage will outlast tanker disruption",
      text: "More than 10 billion cubic feet a day of LNG depended on the route, and damage at two export trains removed 17% of Qatar's capacity. Oil can use some bypass pipelines and floating storage; concentrated LNG liquefaction cannot recover on the same timetable.",
      citationUrls: [lng],
    }],
    competingExplanation: {
      text: "A durable ceasefire could make the low transit count a temporary lag: vessels, insurers, and crews may return before monthly production data catches up. That explanation would become more likely if daily traffic rises for several weeks without another strike while product exports approach their prewar rate.",
      citationUrls: [flow, security],
    },
    watchFor: [{
      text: "Sustained exports near 24 million barrels a day plus product and LPG volumes above half of prewar levels would strengthen the normalization case; another retreat toward a trickle would reverse it.",
      citationUrls: [flow],
    }, {
      text: "Several weeks without attacks, traffic moving back toward 138 vessels a day, and restart dates for the two damaged LNG trains would strengthen the normalization case; another strike or further outage would weaken it.",
      citationUrls: [security, lng],
    }],
    evidence: {
      asOf: "2026-08-09T12:00:00.000Z",
      boundary: "Accumulated state; newest evidence 2026-08-08T18:00:00.000Z",
      limitations: ["Maritime traffic can change faster than monthly energy reports."],
      sources: [{
        url: flow,
        publisher: "Energy Agency",
        title: "Gulf export recovery remains incomplete",
        excerpt: "Exports recovered in June but remained below the prewar baseline, with products lagging crude.",
        publishedAt: "2026-08-08T12:00:00.000Z",
      }, {
        url: security,
        publisher: "Maritime Center",
        title: "Hormuz threat advisory",
        excerpt: "The advisory recorded tanker strikes, navigation interference, and traffic below historical levels.",
        publishedAt: "2026-08-09T08:00:00.000Z",
      }, {
        url: lng,
        publisher: "Energy Administration",
        title: "LNG capacity damage assessment",
        excerpt: "Damage to two trains reduced export capacity and requires a longer repair cycle.",
        publishedAt: "2026-08-07T15:00:00.000Z",
      }],
    },
  };
}

function hasCausalSynthesisQuality(presentation) {
  const judgments = presentation.keyJudgments ?? [];
  const watchFor = presentation.watchFor ?? [];
  const answerSections = [
    presentation.thesis?.text,
    ...judgments.map(item => item.text),
    presentation.competingExplanation?.text,
    ...watchFor.map(item => item.text),
  ].filter(Boolean);
  const answer = answerSections.join(" ");
  const numericFacts = answer.match(/\b\d+(?:\.\d+)?%?|\b\d+(?:\.\d+)?\s+(?:million|billion)/gi) ?? [];
  const causalLinks = answer.match(/\b(?:because|therefore|while|so|shifting|rather than|cannot|depends?|sets?|controls?|would)\b/gi) ?? [];
  const genericTitles = /^(?:key |main )?(?:judgment|insight|finding|evidence|update)\b/i;
  const metaLanguage = /\b(?:source count|source family|evidence coverage|briefing process|receipt)\b/i;
  return presentation.answerMode === "synthesis" &&
    presentation.thesis?.text.length >= 300 && presentation.thesis.text.length <= 900 &&
    judgments.length >= 2 && judgments.length <= 4 &&
    judgments.every(item => item.title.length >= 12 && !genericTitles.test(item.title) && item.text.length >= 120) &&
    new Set(judgments.map(item => item.title.toLowerCase())).size === judgments.length &&
    numericFacts.length >= 8 && causalLinks.length >= 7 &&
    typeof presentation.competingExplanation?.text === "string" && /\b(?:could|if|would)\b/i.test(presentation.competingExplanation.text) &&
    watchFor.length >= 1 && watchFor.length <= 2 &&
    watchFor.every(item => /\b(?:strengthen|weaken|reverse|confirm|narrow)\b/i.test(item.text)) &&
    answerSections.every(text => !metaLanguage.test(text));
}

function passesQualityAnchors(scenario, presentation) {
  const values = scenario.qualityAnchors.required.map(rule => (
    rule.field === "quietResponse" ? scenario.expected.quietResponse : fieldText(presentation, rule.field)
  ));
  const visibleValues = values.map((value, index) => (
    visibleAnswerText(scenario.qualityAnchors.required[index].field, value)
  ));
  const required = scenario.qualityAnchors.required.every((rule, index) => {
    const visible = visibleValues[index];
    return visible.startsWith(rule.startsWith) &&
      rule.allOf.every(anchor => visible.toLowerCase().includes(anchor.toLowerCase()));
  });
  const allCopy = visibleValues.join("\n").toLowerCase();
  return required && scenario.qualityAnchors.forbidden.every(claim => !allCopy.includes(claim.toLowerCase()));
}

function scoreScenario(scenario, data, render, candidate = scenario.presentation) {
  const checks = [];
  const expectedCard = scenario.expected.renderCard;
  checks.push(Boolean(candidate) === expectedCard && Boolean(scenario.goldenCard) === expectedCard);

  if (!expectedCard) {
    const response = scenario.expected.quietResponse ?? "";
    checks.push(
      passesQualityAnchors(scenario, candidate) &&
      response.length > 0 &&
      !data.rubric.forbiddenModelNarration.some(term => response.toLowerCase().includes(term))
    );
    checks.push(response.length <= 160);
    checks.push(response.split(/[.!?]+/).filter(part => part.trim()).length === 1);
    const boundaryHtml = render(scenario.boundaryProbe);
    checks.push(
      boundaryHtml.includes("Some source links are missing.") &&
      boundaryHtml.includes("Add a public source for each section.") &&
      !boundaryHtml.includes('<article class="brief">') &&
      !boundaryHtml.includes("ChatGPT interpretation") &&
      !boundaryHtml.includes("Sources (")
    );
    checks.push(scenario.expected.decisionRows.length === 0);
    return checks.filter(Boolean).length;
  }

  const presentation = candidate;
  const fieldEntries = sections(presentation);
  const modelCopy = fieldEntries.map(([, section]) => section.text.toLowerCase());
  checks.push(
    passesQualityAnchors(scenario, presentation) &&
    modelCopy.every(text => data.rubric.forbiddenModelNarration.every(term => !text.includes(term)))
  );

  checks.push(fieldEntries.every(([name, section]) => {
    const limit = name === "whatChanged" || name === "whyItMatters" ? 300 : 240;
    return section.text.length > 0 && section.text.length <= limit;
  }));

  const sourceUrls = new Set(presentation.evidence.sources.map(source => new URL(source.url).href));
  const citedUrls = new Set(fieldEntries.flatMap(([, section]) => section.citationUrls.map(url => new URL(url).href)));
  checks.push(
    fieldEntries.every(([, section]) => section.citationUrls.length >= 1 && section.citationUrls.length <= 3 && section.citationUrls.every(url => sourceUrls.has(new URL(url).href))) &&
    sourceUrls.size === citedUrls.size && [...sourceUrls].every(url => citedUrls.has(url))
  );

  const actualRows = expectedDecisionRows(presentation);
  const requestedRows = scenario.expected.decisionRows;
  const shapeMatches = JSON.stringify(actualRows) === JSON.stringify(requestedRows) && !(presentation.decision && presentation.watchNext);
  const preservesConflict = !scenario.expected.preserveConflict || (
    presentation.whatChanged.citationUrls.length >= 2 && /\b(?:but|however|while|yet|although)\b/i.test(presentation.whatChanged.text)
  );
  checks.push(shapeMatches && preservesConflict);

  const html = render(presentation);
  const golden = scenario.goldenCard;
  const goldenSections = sections(scenario.presentation);
  const sectionOrder = golden.sectionLabels.map(label => html.indexOf(`>${escapeHtml(label)}</h2>`));
  const semanticGolden = !html.includes("Some source links are missing.") &&
    sectionOrder.every(index => index >= 0) &&
    sectionOrder.every((index, position) => position === 0 || index > sectionOrder[position - 1]) &&
    golden.decisionLabels.every(label => html.includes(`>${escapeHtml(label)}</span>`)) &&
    html.includes(`Sources (${golden.sourceCount})`) &&
    goldenSections.filter(([name]) => !name.startsWith("decision.")).every(([, section]) => html.includes(escapeHtml(section.text))) &&
    (golden.normalizedDecisionText ?? []).every(text => html.includes(escapeHtml(text))) &&
    scenario.presentation.evidence.sources.every(source => html.includes(`href="${escapeHtml(new URL(source.url).href)}"`));
  checks.push(semanticGolden);

  return checks.filter(Boolean).length;
}

test("the v8 reader-quality corpus covers five distinct, sanitized brief problems", async () => {
  const data = await corpus();
  assert.equal(data.schemaVersion, "1");
  assert.equal(data.widgetUri, "ui://driftglass/editorial-brief-v8.html");
  for (const narration of ["source count", "source family", "source families", "source coverage", "evidence coverage"]) {
    assert.ok(data.rubric.forbiddenModelNarration.includes(narration));
  }
  assert.deepEqual(
    data.scenarios.map(scenario => scenario.coverage).sort(),
    [
      "broader-non-meta-mission",
      "conflicting-multi-source-evidence",
      "operational-decision",
      "quiet-no-card-state",
      "sparse-decisive-evidence",
    ],
  );

  for (const scenario of data.scenarios) {
    assert.doesNotMatch(JSON.stringify(scenario), /bearer\s+|capability[_/-]|[0-9a-f]{8}-[0-9a-f-]{27,}/i, scenario.id);
    assert.equal(
      scenario.qualityAnchors.required.every(rule => typeof rule.startsWith === "string" && rule.startsWith.length > 0),
      true,
      `${scenario.id} owns an answer-first lead for every scored field`,
    );
    for (const source of scenario.presentation?.evidence?.sources ?? []) {
      assert.equal(new URL(source.url).hostname.endsWith(".example"), true, `${scenario.id} uses a reserved example domain`);
    }
  }
});

test("a broad synthesis preserves causal mechanisms, quantitative anchors, an alternative, and reversal signals", async () => {
  const source = await widgetSource();
  const presentation = causalSynthesis();
  assert.equal(hasCausalSynthesisQuality(presentation), true);

  const html = widgetHarness(source)(presentation);
  const answerHtml = html.slice(0, html.indexOf('<details class="evidence">'));
  assert.doesNotMatch(html, /Some source links are missing/);
  assert.match(answerHtml, /Why this is happening/);
  assert.match(answerHtml, /Alternative case/);
  assert.match(answerHtml, /What to watch/);
  assert.equal((answerHtml.match(/class="judgment"/g) ?? []).length, 3);
  assert.equal((answerHtml.match(/class="watch-item"/g) ?? []).length, 2);
  assert.match(answerHtml, /class="citation-ref"/);
  assert.doesNotMatch(answerHtml, /Gulf export recovery remains incomplete|Hormuz threat advisory|LNG capacity damage assessment/);

  const generic = structuredClone(presentation);
  generic.thesis.text = "The situation remains complex and uncertain, with several important developments that could have meaningful implications for the Mission.";
  generic.keyJudgments = generic.keyJudgments.map((item, index) => ({
    ...item,
    title: `Key insight ${index + 1}`,
    text: "The available information highlights an evolving situation with significant risks and opportunities that deserve continued monitoring.",
  }));
  generic.competingExplanation.text = "There may be another interpretation of the available information.";
  generic.watchFor = [{ ...generic.watchFor[0], text: "Watch for further developments and new information." }];
  assert.equal(hasCausalSynthesisQuality(generic), false);
});

test("every scenario passes the deterministic answer-first and grounding rubric", async () => {
  const [data, source] = await Promise.all([corpus(), widgetSource()]);
  const render = widgetHarness(source);
  assert.equal(data.rubric.criteria.length, data.rubric.maximumScore);

  for (const scenario of data.scenarios) {
    assert.equal(
      scoreScenario(scenario, data, render),
      data.rubric.passScore,
      `${scenario.id} must pass every deterministic reader-quality gate`,
    );
  }
});

test("a generic grounded recap cannot pass the scenario's consequence anchors", async () => {
  const [data, source] = await Promise.all([corpus(), widgetSource()]);
  const scenario = data.scenarios.find(candidate => candidate.id === "sparse-decisive-evidence");
  assert.ok(scenario);
  const genericRecap = structuredClone(scenario.presentation);
  genericRecap.whatChanged.text = "A clinic update was published during the current window.";
  genericRecap.whyItMatters.text = "The update may affect the Mission and deserves attention.";
  genericRecap.watchNext.text = "Watch for another update before making a decision.";
  const genericCopy = sections(genericRecap).map(([, section]) => section.text.toLowerCase());
  assert.equal(
    genericCopy.every(text => data.rubric.forbiddenModelNarration.every(term => !text.includes(term))),
    true,
    "the negative probe is generic without relying on forbidden meta narration",
  );

  const score = scoreScenario(scenario, data, widgetHarness(source), genericRecap);
  assert.ok(score < data.rubric.passScore);
  assert.equal(score, 4, "generic copy passes structure and grounding but fails consequence anchors and the golden card");
});

test("a reporting preface cannot hide in front of otherwise exact golden sections", async () => {
  const [data, source] = await Promise.all([corpus(), widgetSource()]);
  const scenario = data.scenarios.find(candidate => candidate.id === "operational-decision");
  assert.ok(scenario);
  assert.equal(data.rubric.forbiddenModelNarration.includes("source recap"), false);
  const prefaced = structuredClone(scenario.presentation);
  for (const [, section] of sections(prefaced)) section.text = `Source recap: ${section.text}`;

  assert.deepEqual(
    sections(prefaced).map(([, section]) => section.citationUrls),
    sections(scenario.presentation).map(([, section]) => section.citationUrls),
    "the negative control preserves every citation and section",
  );
  for (const [, goldenSection] of sections(scenario.presentation)) {
    assert.equal(
      sections(prefaced).some(([, section]) => section.text.includes(goldenSection.text)),
      true,
      "every exact golden claim remains present after the reporting preface",
    );
  }

  const score = scoreScenario(scenario, data, widgetHarness(source), prefaced);
  assert.equal(score, 5, "answer-first leads are the only failed gate");
  assert.ok(score < data.rubric.passScore);
});

test("evidence-coverage narration cannot hide behind an answer-first lead", async () => {
  const [data, source] = await Promise.all([corpus(), widgetSource()]);
  const scenario = data.scenarios.find(candidate => candidate.id === "sparse-decisive-evidence");
  assert.ok(scenario);
  const narrated = structuredClone(scenario.presentation);
  narrated.whyItMatters.text += " Evidence coverage comes from one source family.";
  assert.equal(passesQualityAnchors(scenario, narrated), true, "the factual and answer-first anchors remain intact");

  const score = scoreScenario(scenario, data, widgetHarness(source), narrated);
  assert.equal(score, 5, "primary-field evidence mechanics fail the narration gate");
  assert.ok(score < data.rubric.passScore);
});

test("a quiet evidence result sent through the widget boundary cannot mount an interpretation card", async () => {
  const [data, source] = await Promise.all([corpus(), widgetSource()]);
  const scenario = data.scenarios.find(candidate => candidate.id === "quiet-no-card");
  assert.ok(scenario?.boundaryProbe);
  const html = widgetHarness(source)(scenario.boundaryProbe);
  assert.match(html, /<h2>Some source links are missing\.<\/h2>/);
  assert.match(html, /<p>Add a public source for each section\.<\/p>/);
  assert.doesNotMatch(html, /<article class="brief">|ChatGPT interpretation|Sources \(/);
});

test("the operational golden card removes repeated model labels without weakening the judgment boundary", async () => {
  const [data, source] = await Promise.all([corpus(), widgetSource()]);
  const scenario = data.scenarios.find(candidate => candidate.id === "operational-decision");
  assert.ok(scenario);
  assert.equal(
    Object.values(scenario.presentation.decision).every(section => section.text.startsWith("ChatGPT judgment:")),
    true,
    "the fixture preserves the repeated label observed in the live ChatGPT card",
  );

  const html = widgetHarness(source)(scenario.presentation);
  assert.equal((html.match(/<h2 id="recommended-move">Recommendation<\/h2>/g) ?? []).length, 1);
  assert.equal((html.match(/Recommendation based on these sources/g) ?? []).length, 0);
  assert.doesNotMatch(html, /Recommended move|ChatGPT judgment, anchored by cited evidence/);
  assert.doesNotMatch(html, /ChatGPT judgment:/i);
  for (const text of scenario.goldenCard.normalizedDecisionText) assert.ok(html.includes(escapeHtml(text)));
  assert.equal((html.match(/class="decision-row"/g) ?? []).length, 3);
  assert.equal((html.match(/class="decision-citations"/g) ?? []).length, 3);

  const emptyAfterNormalization = structuredClone(scenario.presentation);
  emptyAfterNormalization.decision.testNow.text = "ChatGPT judgment:";
  const rejected = widgetHarness(source)(emptyAfterNormalization);
  assert.match(rejected, /Some source links are missing\./);

  const hyphenated = structuredClone(scenario.presentation);
  hyphenated.decision.testNow.text = "ChatGPT judgment-based recommendations should remain visible.";
  const preserved = widgetHarness(source)(hyphenated);
  assert.match(preserved, /ChatGPT judgment-based recommendations should remain visible\./);

  const spacedDash = structuredClone(scenario.presentation);
  spacedDash.decision.testNow.text = "ChatGPT judgment - Keep this recommendation concise.";
  const normalizedDash = widgetHarness(source)(spacedDash);
  assert.match(normalizedDash, />Keep this recommendation concise\.<\/p>/);
  assert.doesNotMatch(normalizedDash, /ChatGPT judgment -/);
});
