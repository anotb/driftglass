import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map(channel => Number.parseInt(channel, 16) / 255);
  const [red, green, blue] = channels.map(channel => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function toolBlock(source, name, nextName) {
  const start = source.indexOf(`    "${name}",`);
  const end = source.indexOf(`    "${nextName}",`, start + 1);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing tool after ${name}`);
  return source.slice(start, end);
}

function widgetHarness(source, { includeOpenai = true, toolOutput } = {}) {
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(source)?.[1];
  assert.ok(script, "editorial brief widget script is present");
  const listeners = new Map();
  const messages = [];
  const parent = {
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });
    },
  };
  let html = "<p>Loading Driftglass…</p>";
  let intrinsicHeightNotifications = 0;
  let renderWrites = 0;
  let extraHeight = 0;
  let resizeCallback = null;

  const widgetRoot = {
    className: "",
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      renderWrites += 1;
    },
    querySelector: () => null,
  };
  const measuredHeight = () => 120 + Math.ceil(html.length / 20) + extraHeight;
  const documentElement = {
    style: { height: "" },
    get scrollHeight() { return measuredHeight(); },
    getBoundingClientRect: () => ({ width: 640, height: measuredHeight() }),
  };
  const body = {
    get scrollHeight() { return measuredHeight(); },
    getBoundingClientRect: () => ({ width: 640, height: measuredHeight() }),
  };
  class ResizeObserver {
    constructor(callback) { resizeCallback = callback; }
    observe() {}
  }
  const window = {
    parent,
    innerWidth: 640,
    ResizeObserver,
    addEventListener: (name, handler) => listeners.set(name, handler),
    ...(includeOpenai ? { openai: {
      notifyIntrinsicHeight: () => { intrinsicHeightNotifications += 1; },
      ...(toolOutput === undefined ? {} : { toolOutput }),
    } } : {}),
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
  function dispatch(data) {
    const handler = listeners.get("message");
    assert.ok(handler, "widget registered the MCP Apps listener");
    handler({ source: parent, data });
  }
  return {
    initialize(result = {
      protocolVersion: "2026-01-26",
      hostInfo: { name: "test-host", version: "1.0.0" },
      hostCapabilities: {},
      hostContext: {},
    }) {
      const request = messages.find(entry => entry.message.method === "ui/initialize")?.message;
      assert.ok(request, "widget sent the MCP Apps initialize request");
      dispatch({ jsonrpc: "2.0", id: request.id, result });
    },
    dispatch,
    render(structuredContent) {
      dispatch({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent },
      });
      return widgetRoot.innerHTML;
    },
    intrinsicHeightNotifications: () => intrinsicHeightNotifications,
    renderWrites: () => renderWrites,
    resize(delta = 0) {
      extraHeight += delta;
      resizeCallback?.();
    },
    html: () => widgetRoot.innerHTML,
    messages,
  };
}

function presentation(overrides = {}) {
  const authority = "https://authority.example/notices/change";
  const publication = "https://publication.example/analysis/change";
  return {
    schemaVersion: "1",
    briefKind: "mission",
    interpretationLabel: "ChatGPT interpretation",
    title: "Grid resilience",
    context: "Which constraints change the build sequence?",
    whatChanged: {
      text: "The permit sequence moved forward, removing the delay that had held the build.",
      citationUrls: [authority],
    },
    whyItMatters: {
      text: "This changes the Mission from waiting on approval to checking whether procurement can keep pace.",
      citationUrls: [authority, publication],
    },
    watchNext: {
      text: "Watch the next procurement notice for confirmation that the new sequence is holding.",
      citationUrls: [publication],
    },
    evidence: {
      asOf: "2026-08-09T12:30:00.000Z",
      boundary: "Changes since 2026-08-06T12:30:00.000Z",
      limitations: ["Independent source-family corroboration is limited in this brief."],
      sources: [
        {
          url: authority,
          publisher: "Public authority",
          title: "Official change notice",
          excerpt: "The authority moved the permit sequence forward.",
          publishedAt: "2026-08-09T10:00:00.000Z",
          sourceFamily: "authority.example",
          independence: "independent",
        },
        {
          url: publication,
          publisher: "Independent publication",
          title: "Analysis of the revised sequence",
          excerpt: "The publication described the procurement implication.",
          publishedAt: "2026-08-09T11:00:00.000Z",
          sourceFamily: "publication.example",
          independence: "independent",
        },
      ],
    },
    ...overrides,
  };
}

function decisionPresentation(overrides = {}) {
  const authority = "https://authority.example/notices/change";
  const publication = "https://publication.example/analysis/change";
  return presentation({
    watchNext: undefined,
    decision: {
      testNow: {
        text: "Test the revised sequence on two procurements over seven days, against the current sequence.",
        citationUrls: [authority],
      },
      deferUntil: {
        text: "Defer the full migration until the next authority notice confirms that the sequence is stable.",
        citationUrls: [publication],
      },
      rollbackIf: {
        text: "Roll back if either procurement misses its approval handoff during the seven-day test.",
        citationUrls: [authority, publication],
      },
    },
    ...overrides,
  });
}

function synthesisPresentation(overrides = {}) {
  const authority = "https://authority.example/notices/change";
  const publication = "https://publication.example/analysis/change";
  return presentation({
    answerMode: "synthesis",
    whatChanged: undefined,
    whyItMatters: undefined,
    watchNext: undefined,
    thesis: {
      text: "The permit change removes approval as the pacing constraint, but it does not guarantee a faster build. Delivery now turns on whether procurement and handoffs can adopt the revised sequence before the saved schedule absorbs the gain.",
      citationUrls: [authority, publication],
    },
    keyJudgments: [{
      title: "The critical path moved downstream",
      text: "The authority advanced the permit sequence. That transfers schedule risk from permission to ordering and coordination rather than eliminating it.",
      citationUrls: [authority],
    }, {
      title: "Procurement now decides whether time is saved",
      text: "The independent analysis identifies procurement timing as the immediate implication. If purchase approvals remain on the old cadence, the permit change produces little calendar gain.",
      citationUrls: [publication],
    }],
    competingExplanation: {
      text: "The notice may only reorder administrative steps. If later procurement notices keep the old handoff dates, the operational sequence has not changed enough to accelerate delivery.",
      citationUrls: [authority, publication],
    },
    watchFor: [{
      text: "A procurement notice using the revised order would confirm that the change reached execution; another notice on the old sequence would weaken the answer.",
      citationUrls: [publication],
    }],
    ...overrides,
  });
}

function estimatedInlineCardHeight(data, width = 640) {
  const mainCharsPerLine = width >= 620 ? 78 : 42;
  const decisionCharsPerLine = width >= 620 ? 42 : 34;
  const lineCount = (value, charsPerLine) => Math.max(1, Math.ceil(String(value || "").length / charsPerLine));
  const citationRows = (count, perRow) => Math.max(1, Math.ceil(count / perRow));
  let height = 32 + 88 + (data.context ? lineCount(data.context, mainCharsPerLine) * 18 : 0);
  for (const section of [data.whatChanged, data.whyItMatters]) {
    height += 26 + lineCount(section.text, mainCharsPerLine) * 23 + citationRows(section.citationUrls.length, width >= 620 ? 2 : 1) * 36;
  }
  if (data.decision) {
    height += 28;
    for (const key of ["testNow", "deferUntil", "rollbackIf"]) {
      const row = data.decision[key];
      if (!row) continue;
      const copyHeight = lineCount(row.text, decisionCharsPerLine) * 17;
      const citationsHeight = citationRows(row.citationUrls.length, 1) * 36;
      height += Math.max(copyHeight, citationsHeight) + 12;
    }
  }
  return height + 48;
}

test("evidence tools are data-only and only present_brief mounts the answer card", async () => {
  const [compact, operations, widget, presentationSource, briefToolText] = await Promise.all([
    read("src/reasoning-mcp.ts"),
    read("src/mcp.ts"),
    read("src/chatgpt-brief-widget.ts"),
    read("src/brief-presentation.ts"),
    read("src/brief-tool-text.ts"),
  ]);

  assert.match(widget, /ui:\/\/driftglass\/editorial-brief-v9\.html/);
  assert.match(widget, /ui:\/\/driftglass\/editorial-brief-v8\.html/);
  assert.match(widget, /version:'9\.0\.0'/);
  assert.match(widget, /data\?\.interpretationLabel === 'ChatGPT interpretation'/);
  assert.match(widget, /const answerLabel = isSynthesis \? 'Analysis' : hasDecision \? 'Recommendation' : 'Answer'/);
  assert.match(widget, /Why this is happening/);
  assert.match(widget, /Alternative case/);
  assert.match(widget, /What to watch/);
  assert.match(widget, /Bottom line/);
  assert.match(widget, /What this means/);
  assert.match(widget, /Recommendation/);
  assert.doesNotMatch(widget, /Recommendation based on these sources/);
  assert.match(widget, /Defer until/);
  assert.match(widget, /Roll back if/);
  assert.match(widget, /Watch for/);
  assert.match(widget, /Sources \(/);
  assert.match(widget, /Time covered:/);
  assert.match(widget, /Some source links are missing\./);
  assert.match(widget, /Add a public source for each section\./);
  assert.match(widget, /<details class="evidence">/);
  assert.doesNotMatch(widget, /evidenceLead|whyIncluded|standingAnswer|Saved baseline|The signal|Also moving/);
  assert.match(widget, /@media \(max-width:520px\)/);

  for (const source of [compact, operations]) {
    assert.match(source, /registerResource\("driftglass-editorial-brief", EDITORIAL_BRIEF_WIDGET_URI/);
    assert.match(source, /registerResource\("driftglass-editorial-brief-v8", LEGACY_EDITORIAL_BRIEF_WIDGET_URI/);
    assert.match(source, /csp: \{ connectDomains: \[\], resourceDomains: \[\] \}/);
    const today = toolBlock(source, "brief_today", "brief_mission");
    const mission = toolBlock(source, "brief_mission", "present_brief");
    const present = toolBlock(source, "present_brief", "open_today");
    assert.doesNotMatch(today, /EDITORIAL_BRIEF_WIDGET_URI|openai\/outputTemplate/);
    assert.doesNotMatch(mission, /EDITORIAL_BRIEF_WIDGET_URI|openai\/outputTemplate/);
    assert.match(present, /ui: \{ resourceUri: EDITORIAL_BRIEF_WIDGET_URI \}/);
    assert.match(present, /"openai\/outputTemplate": EDITORIAL_BRIEF_WIDGET_URI/);
    assert.match(present, /readOnlyAnnotations\(\)/);
    assert.match(source, /BRIEF_FLOW_INSTRUCTIONS/);
  }
  assert.match(presentationSource, /call present_brief exactly once/i);
  assert.match(presentationSource, /rejects incomplete mode fields, an empty decision, unknown or altered citation URLs, private values, internal identifiers, and verbatim saved-answer material/i);
  assert.match(presentationSource, /SECTION_TEXT_LIMIT = 300/);
  assert.doesNotMatch(presentationSource, /SECTION_WITH_DECISION_TEXT_LIMIT/);
  assert.match(presentationSource, /WATCH_TEXT_LIMIT = 240/);
  assert.match(presentationSource, /DECISION_TEXT_LIMIT = 240/);
  assert.match(presentationSource, /SECTION_TEXT_TARGET = 240/);
  assert.match(presentationSource, /DECISION_TEXT_TARGET = 190/);
  assert.match(presentationSource, /SYNTHESIS_THESIS_TEXT_LIMIT = 900/);
  assert.match(presentationSource, /SYNTHESIS_JUDGMENT_TEXT_LIMIT = 600/);
  assert.match(presentationSource, /stop when the question is answered; do not pad/i);
  assert.match(presentationSource, /one to four cited keyJudgments/i);
  assert.match(presentationSource, /zero to two cited watchFor signals/i);
  assert.match(presentationSource, /each extra block adds a distinct fact, mechanism, implication, or falsifier/i);
  assert.match(presentationSource, /answerMode decision only when the user explicitly asks/i);
  assert.match(presentationSource, /decision must include at least one of testNow, deferUntil, or rollbackIf/);
  assert.match(briefToolText, /Do not call present_brief/);
  assert.match(briefToolText, /lines\.push\("", presentationHandoff\)/);
});

test("every authored public-brief prompt keeps evidence mechanics out of answer fields", async () => {
  const promptSources = await Promise.all([
    read("src/brief-presentation.ts"),
    read("src/today-brief.ts"),
    read("src/mission-brief.ts"),
    read("src/driftglass-plugin.ts"),
    read("plugins/driftglass/skills/answer-mission/SKILL.md"),
  ]);
  const primaryFieldBan = /Do not narrate source counts, source families, coverage, evidence mechanics,[^\n]*(?:briefing process|answer fields)[^\n]*(?:collapsed source disclosure|collapsed source disclosure)\./;
  for (const source of promptSources) assert.match(source, primaryFieldBan);

  const legacyConflict = /State when evidence comes from one family, related families, or unclear lineage/;
  for (const source of promptSources) assert.doesNotMatch(source, legacyConflict);
  for (const source of promptSources.slice(3)) {
    assert.match(source, /Keep limits in the collapsed source disclosure\./);
    assert.match(source, /Identify which claims came from connected sources, preserve its evidence and lineage limits, and never turn repeated posts into independent support\./);
  }
});

test("the v9 card completes the MCP Apps lifecycle and reports intrinsic size", async () => {
  const widget = widgetHarness(await read("src/chatgpt-brief-widget.ts"), { includeOpenai: false });
  assert.equal(widget.messages.length, 1);
  const initialize = JSON.parse(JSON.stringify(widget.messages[0]));
  assert.equal(initialize.targetOrigin, "*");
  assert.equal(initialize.message.method, "ui/initialize");
  assert.deepEqual(initialize.message.params, {
    appInfo: { name: "driftglass-editorial-brief", version: "9.0.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
    protocolVersion: "2026-01-26",
  });
  assert.equal(widget.renderWrites(), 0);

  widget.dispatch({ jsonrpc: "2.0", id: "another-request", result: {} });
  widget.dispatch({ jsonrpc: "2.0", id: initialize.message.id, result: { protocolVersion: "2026-01-26" } });
  assert.equal(widget.messages.length, 1, "unrelated and malformed responses are ignored");

  widget.initialize();
  assert.deepEqual(
    widget.messages.map(entry => entry.message.method),
    ["ui/initialize", "ui/notifications/initialized", "ui/notifications/size-changed"],
  );
  widget.initialize();
  assert.deepEqual(
    widget.messages.map(entry => entry.message.method),
    ["ui/initialize", "ui/notifications/initialized", "ui/notifications/size-changed"],
    "a replayed initialize result does not repeat initialization",
  );

  widget.render(presentation());
  assert.equal(widget.renderWrites(), 1);
  const sizes = widget.messages.filter(entry => entry.message.method === "ui/notifications/size-changed");
  assert.equal(sizes.length, 2);
  assert.equal(sizes.at(-1).message.params.width, 640);
  assert.ok(sizes.at(-1).message.params.height > sizes[0].message.params.height);

  widget.resize();
  assert.equal(widget.messages.filter(entry => entry.message.method === "ui/notifications/size-changed").length, 2);
  widget.resize(20);
  assert.equal(widget.messages.filter(entry => entry.message.method === "ui/notifications/size-changed").length, 3);
});

test("synthesis renders an answer-first causal analysis with compact numbered citations", async () => {
  const widget = widgetHarness(await read("src/chatgpt-brief-widget.ts"));
  widget.initialize();
  const html = widget.render(synthesisPresentation({
    keyJudgments: [{
      ...synthesisPresentation().keyJudgments[0],
      text: "The authority advanced the permit sequence. <script>alert(1)</script> Schedule risk therefore moves from permission to ordering and coordination.",
    }, synthesisPresentation().keyJudgments[1]],
  }));
  const visibleAnswer = html.slice(0, html.indexOf('<details class="evidence">'));

  assert.match(html, />Analysis</);
  assert.match(html, />Answer<\/h2>/);
  assert.match(html, /Why this is happening/);
  assert.match(html, /The critical path moved downstream/);
  assert.match(html, /Procurement now decides whether time is saved/);
  assert.match(html, /Alternative case/);
  assert.match(html, /What to watch/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal((html.match(/class="citation-ref"/g) ?? []).length, 7);
  assert.match(html, /class="citation-ref"[^>]*aria-label="Open citation 1">\[1\]<\/a>/);
  assert.match(html, /class="citation-ref"[^>]*aria-label="Open citation 2">\[2\]<\/a>/);
  assert.doesNotMatch(visibleAnswer, /Official change notice|Analysis of the revised sequence|Aug 9, 2026/);
  assert.match(html, /<details class="evidence"><summary>Sources \(2\)<\/summary>/);
  assert.match(html, /Official change notice/);
  assert.match(html, /Analysis of the revised sequence/);
  assert.match(html, /Time covered: Changes since 2026-08-06T12:30:00\.000Z/);
  assert.doesNotMatch(html, /mission-private|story-private|<script>alert/);
});

test("synthesis renders the required thesis without empty optional sections", async () => {
  const widget = widgetHarness(await read("src/chatgpt-brief-widget.ts"));
  widget.initialize();
  let html = widget.render(synthesisPresentation({
    keyJudgments: undefined,
    competingExplanation: undefined,
    watchFor: undefined,
  }));

  assert.match(html, />Answer<\/h2>/);
  assert.doesNotMatch(html, /Why this is happening|Alternative case|What to watch/);

  html = widget.render(synthesisPresentation({
    keyJudgments: [synthesisPresentation().keyJudgments[0]],
    competingExplanation: undefined,
    watchFor: [],
  }));
  assert.match(html, /Why this is happening/);
  assert.match(html, /The critical path moved downstream/);
  assert.doesNotMatch(html, /Alternative case|What to watch/);
});

test("legacy v8 non-decision cards still render", async () => {
  const widget = widgetHarness(await read("src/chatgpt-brief-widget.ts"));
  widget.initialize();
  const html = widget.render(presentation({
    whatChanged: {
      text: "The permit sequence <script>alert(1)</script> moved forward.",
      citationUrls: ["https://authority.example/notices/change"],
    },
  }));

  assert.match(html, />Answer</);
  assert.match(html, /The permit sequence &lt;script&gt;alert\(1\)&lt;\/script&gt; moved forward/);
  assert.match(html, /What this means/);
  assert.match(html, /Watch for/);
  assert.equal((html.match(/<nav class="citations"/g) ?? []).length, 3);
  assert.match(html, /Bottom line<\/h2><p class="copy">[\s\S]*?<nav class="citations"/);
  assert.match(html, /href="https:\/\/authority\.example\/notices\/change"/);
  assert.match(html, /href="https:\/\/publication\.example\/analysis\/change"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<span class="citation-title">Official change notice<\/span><span class="citation-date">Aug 9, 2026<\/span>/);
  assert.match(html, /aria-label="Open citation 1: Official change notice, Public authority, Aug 9, 2026"/);
  assert.match(html, /aria-label="Open source 1: Official change notice, Public authority, Aug 9, 2026"/);
  assert.match(html, /<details class="evidence"><summary>Sources \(2\)<\/summary>/);
  assert.match(html, /Time covered: Changes since 2026-08-06T12:30:00\.000Z/);
  assert.match(html, /Official change notice/);
  assert.match(html, /Independent source-family corroboration is limited/);
  assert.doesNotMatch(html, /mission-private|story-private|<script>alert/);
});

test("a complete decision renders as one compact recommendation panel", async () => {
  const widget = widgetHarness(await read("src/chatgpt-brief-widget.ts"));
  widget.initialize();
  const html = widget.render(decisionPresentation({
    decision: {
      ...decisionPresentation().decision,
      testNow: {
        text: "ChatGPT judgment: Test <script>alert(1)</script> on two procurements over seven days.",
        citationUrls: ["https://authority.example/notices/change"],
      },
    },
  }));

  assert.equal((html.match(/<section class="decision"/g) ?? []).length, 1);
  assert.equal((html.match(/class="decision-row"/g) ?? []).length, 3);
  assert.match(html, />Recommendation</);
  assert.match(html, />Recommendation<\/h2>/);
  assert.doesNotMatch(html, /Recommendation based on these sources/);
  assert.match(html, /Test now/);
  assert.match(html, /Defer until/);
  assert.match(html, /Roll back if/);
  assert.match(html, /Test &lt;script&gt;alert\(1\)&lt;\/script&gt; on two procurements/);
  assert.doesNotMatch(html, /ChatGPT judgment:|Watch for/);
  assert.match(html, /class="decision-citations" aria-label="Citations for Test now"/);
  assert.match(html, /<details class="evidence"><summary>Sources \(2\)<\/summary>/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("a generic non-migration recommendation renders only its relevant row", async () => {
  const widget = widgetHarness(await read("src/chatgpt-brief-widget.ts"));
  widget.initialize();
  const html = widget.render(decisionPresentation({
    decision: { testNow: decisionPresentation().decision.testNow },
  }));

  assert.equal((html.match(/class="decision-row"/g) ?? []).length, 1);
  assert.match(html, /Test now/);
  assert.doesNotMatch(html, /Defer until|Roll back if/);
  assert.doesNotMatch(html, /Recommendation based on these sources/);
});

test("the target-length all-row card uses a bounded expanded inline budget", async () => {
  const source = await read("src/chatgpt-brief-widget.ts");
  const baseDecision = decisionPresentation().decision;
  const data = decisionPresentation({
    whatChanged: {
      text: "W".repeat(240),
      citationUrls: ["https://authority.example/notices/change"],
    },
    whyItMatters: {
      text: "M".repeat(240),
      citationUrls: ["https://publication.example/analysis/change"],
    },
    decision: {
      testNow: { ...baseDecision.testNow, text: "T".repeat(190) },
      deferUntil: { ...baseDecision.deferUntil, text: "D".repeat(190) },
      rollbackIf: { ...baseDecision.rollbackIf, text: "R".repeat(190) },
    },
  });
  const widget = widgetHarness(source);
  widget.initialize();
  const html = widget.render(data);

  assert.doesNotMatch(html, /Some source links are missing/);
  assert.ok(estimatedInlineCardHeight(data, 640) > 665);
  assert.ok(estimatedInlineCardHeight(data, 640) <= 840);
  assert.match(source, /const MAIN_TEXT_LIMIT = 300/);
  assert.match(source, /const DECISION_ROW_TEXT_LIMIT = 240/);
  assert.match(source, /const WATCH_TEXT_LIMIT = 240/);
  assert.match(source, /\.masthead \{ padding:15px 18px 12px/);
  assert.match(source, /\.section \{ padding:13px 0/);
  assert.match(source, /\.citations \{[^}]*margin-top:7px/);
  assert.match(source, /\.decision-row \{[^}]*padding:6px 0/);
  assert.match(source, /\.decision \.citation \{ flex:1 1 84px; min-height:32px;[^}]*font-size:11px/);
  assert.match(source, /\.decision \.citation-date \{ display:none; \}/);
  assert.match(source, /<details class="evidence">/);
});

test("small muted text clears AA contrast in every light-theme surface", async () => {
  const source = await read("src/chatgpt-brief-widget.ts");
  const muted = "#60696e";
  const lightSurfaces = ["#f6f4ed", "#eef0ff", "#f3ecdc"];

  assert.match(source, /:root \{[^}]*--muted:#60696e/);
  assert.match(source, /@media \(prefers-color-scheme:dark\) \{ :root \{[^}]*--muted:#a9b0b4/);
  for (const surface of lightSurfaces) {
    assert.ok(
      contrastRatio(muted, surface) >= 4.5,
      `${muted} must reach 4.5:1 against ${surface}`,
    );
  }
});

test("citation and source labels escape malicious metadata while staying descriptive", async () => {
  const widget = widgetHarness(await read("src/chatgpt-brief-widget.ts"));
  widget.initialize();
  const data = presentation();
  data.evidence.sources[0] = {
    ...data.evidence.sources[0],
    title: '<img src=x onerror="alert(1)">',
    publisher: 'Authority & "desk"',
  };
  const html = widget.render(data);

  assert.doesNotMatch(html, /<img|onerror="alert/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /aria-label="Open citation 1: &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;, Authority &amp; &quot;desk&quot;, Aug 9, 2026"/);
  assert.match(html, /aria-label="Open source 1: &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;, Authority &amp; &quot;desk&quot;, Aug 9, 2026"/);
});

test("the widget fails closed for missing, unknown, or evidence-tool citations", async () => {
  const widget = widgetHarness(await read("src/chatgpt-brief-widget.ts"));
  widget.initialize();

  let html = widget.render(presentation({
    whatChanged: { text: "An uncited claim.", citationUrls: [] },
  }));
  assert.match(html, /Some source links are missing/);
  assert.match(html, /Add a public source for each section\./);
  assert.doesNotMatch(html, /An uncited claim/);

  html = widget.render(presentation({
    whyItMatters: { text: "A claim with an unknown URL.", citationUrls: ["https://unknown.example/claim"] },
  }));
  assert.match(html, /Some source links are missing/);
  assert.doesNotMatch(html, /A claim with an unknown URL/);

  html = widget.render({
    status: "ready",
    developments: [{ title: "Raw evidence title", sourceTrail: [{ url: "https://authority.example/notices/change" }] }],
  });
  assert.match(html, /Some source links are missing/);
  assert.doesNotMatch(html, /Raw evidence title/);

  html = widget.render(synthesisPresentation({ thesis: undefined }));
  assert.match(html, /Some source links are missing/);
  assert.doesNotMatch(html, /Why this is happening/);

  html = widget.render(synthesisPresentation({
    keyJudgments: Array.from({ length: 5 }, (_, index) => ({
      ...synthesisPresentation().keyJudgments[0],
      title: `Judgment ${index + 1}`,
    })),
  }));
  assert.match(html, /Some source links are missing/);

  html = widget.render(synthesisPresentation({
    watchFor: Array.from({ length: 3 }, () => synthesisPresentation().watchFor[0]),
  }));
  assert.match(html, /Some source links are missing/);

  html = widget.render(synthesisPresentation({
    watchFor: [{
      text: "An ungrounded watch signal.",
      citationUrls: ["https://unknown.example/claim"],
    }],
  }));
  assert.match(html, /Some source links are missing/);
  assert.doesNotMatch(html, /An ungrounded watch signal/);

  html = widget.render(synthesisPresentation({ whatChanged: presentation().whatChanged }));
  assert.match(html, /Some source links are missing/);

  html = widget.render(decisionPresentation({ decision: {} }));
  assert.match(html, /Some source links are missing/);
  assert.doesNotMatch(html, />Recommendation<\/h2>/);

  html = widget.render(decisionPresentation({
    watchNext: presentation().watchNext,
  }));
  assert.match(html, /Some source links are missing/);
  assert.doesNotMatch(html, />Recommendation<\/h2>/);

  html = widget.render(decisionPresentation({
    decision: {
      ...decisionPresentation().decision,
      rollbackIf: { text: "An ungrounded threshold.", citationUrls: ["https://unknown.example/claim"] },
    },
  }));
  assert.match(html, /Some source links are missing/);
  assert.doesNotMatch(html, /An ungrounded threshold/);

  html = widget.render(presentation({
    whatChanged: { text: "X".repeat(300), citationUrls: ["https://authority.example/notices/change"] },
    whyItMatters: { text: "M".repeat(300), citationUrls: ["https://authority.example/notices/change"] },
    watchNext: { text: "W".repeat(240), citationUrls: ["https://publication.example/analysis/change"] },
  }));
  assert.doesNotMatch(html, /Some source links are missing/);
  assert.ok(html.includes("X".repeat(300)));
  assert.ok(html.includes("M".repeat(300)));
  assert.ok(html.includes("W".repeat(240)));

  html = widget.render(decisionPresentation({
    whatChanged: { text: "X".repeat(300), citationUrls: ["https://authority.example/notices/change"] },
    decision: {
      testNow: { text: "Y".repeat(240), citationUrls: ["https://authority.example/notices/change"] },
    },
  }));
  assert.doesNotMatch(html, /Some source links are missing/);
  assert.ok(html.includes("X".repeat(300)));
  assert.ok(html.includes("Y".repeat(240)));

  html = widget.render(presentation({
    whatChanged: { text: "X".repeat(301), citationUrls: ["https://authority.example/notices/change"] },
  }));
  assert.match(html, /Some source links are missing/);

  html = widget.render(presentation({
    watchNext: { text: "W".repeat(241), citationUrls: ["https://publication.example/analysis/change"] },
  }));
  assert.match(html, /Some source links are missing/);

  html = widget.render(decisionPresentation({
    decision: {
      testNow: { text: "Y".repeat(241), citationUrls: ["https://authority.example/notices/change"] },
    },
  }));
  assert.match(html, /Some source links are missing/);
});

test("window.openai compatibility output is deduplicated when the standard bridge repeats it", async () => {
  const result = presentation();
  const widget = widgetHarness(await read("src/chatgpt-brief-widget.ts"), { toolOutput: result });
  assert.match(widget.html(), />Answer</);
  assert.equal(widget.renderWrites(), 1);
  assert.equal(widget.intrinsicHeightNotifications(), 1);

  widget.initialize();
  widget.render(result);
  assert.equal(widget.renderWrites(), 1);
  assert.equal(widget.intrinsicHeightNotifications(), 1);
});
