import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { frozenShowcaseEnabled, handleFrozenShowcaseRequest } = require("../.test-dist/frozen-showcase.js");

function fixtureEnv() {
  const assetRequests = [];
  return {
    assetRequests,
    env: {
      PUBLIC_SHOWCASE_MODE: "frozen",
      ASSETS: {
        async fetch(request) {
          assetRequests.push(new URL(request.url).pathname);
          return new Response('<!doctype html><html lang="en"><head></head><body><div id="login" class="login-shell"><form id="login-form">Owner key</form></div><div id="app" class="app-shell" hidden></div><script type="module" src="/app.js?v=1"></script><script type="module" src="/webmcp.js?v=1"></script></body></html>', {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600", etag: '"asset"' },
          });
        },
      },
    },
  };
}

async function getJson(env, pathname) {
  const response = await handleFrozenShowcaseRequest(new Request(`https://driftglass.example${pathname}`), env);
  return { response, payload: await response.json() };
}

test("frozen mode is opt-in and exact", () => {
  assert.equal(frozenShowcaseEnabled({}), false);
  assert.equal(frozenShowcaseEnabled({ PUBLIC_SHOWCASE_MODE: "enabled" }), false);
  assert.equal(frozenShowcaseEnabled({ PUBLIC_SHOWCASE_MODE: "frozen" }), true);
});

test("the frozen root opens the production shell without an owner-key screen or WebMCP", async () => {
  const { env, assetRequests } = fixtureEnv();
  const response = await handleFrozenShowcaseRequest(new Request("https://driftglass.example/"), env);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-driftglass-mode"), "frozen");
  assert.match(html, /<html lang="en" data-driftglass-mode="frozen">/);
  assert.match(html, /<div id="login" class="login-shell" hidden>/);
  assert.match(html, /<div id="app" class="app-shell">/);
  assert.match(html, /href="\/frozen-showcase\.css"/);
  assert.match(html, /src="\/frozen-showcase\.js"[\s\S]*src="\/app\.js/);
  assert.doesNotMatch(html, /src="\/webmcp\.js/);
  assert.deepEqual(assetRequests, ["/"]);

  const head = await handleFrozenShowcaseRequest(new Request("https://driftglass.example/", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.equal(head.headers.get("x-driftglass-mode"), "frozen");
  assert.equal(head.headers.get("etag"), null);
  assert.equal(await head.text(), "");
  assert.deepEqual(assetRequests, ["/", "/"]);
});

test("the injected assets boot the unchanged app read-only and retire stale shell caches", async () => {
  const { env, assetRequests } = fixtureEnv();
  const scriptResponse = await handleFrozenShowcaseRequest(new Request("https://driftglass.example/frozen-showcase.js"), env);
  const script = await scriptResponse.text();
  assert.match(scriptResponse.headers.get("content-type"), /^text\/javascript/);
  assert.equal(scriptResponse.headers.get("cache-control"), "no-store");
  assert.match(script, /form\.requestSubmit\(\)/);
  assert.match(script, /navigator\.serviceWorker\.getRegistrations\(\)/);
  assert.match(script, /key\.startsWith\("driftglass-shell-"\)/);
  assert.match(script, /Object\.defineProperty\(navigator\.serviceWorker, "register"/);
  assert.match(script, /url\.searchParams\.set\("frozen", "20260811"\)/);
  assert.match(script, /cache: "no-store"/);
  assert.match(script, /Source checks are paused/);
  assert.match(script, /freezeControls/);
  assert.match(script, /#close-reasoning-result/);
  assert.match(script, /window\.addEventListener\("hashchange", resetRouteScroll\)/);
  assert.match(script, /window\.scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\)/);
  assert.match(script, /event\.target instanceof HTMLDialogElement/);
  assert.match(script, /dialog\.setAttribute\("aria-labelledby", title\.id\)/);
  assert.match(script, /close\.setAttribute\("aria-label", "Close dialog"\)/);
  assert.match(script, /form\.closest\("\.panel"\)\?\.classList\.add\("frozen-write-panel"\)/);
  assert.match(script, /className = "frozen-mission-header"/);
  assert.match(script, /className = "frozen-story-rail"/);
  assert.match(script, /removeInstallStatus/);
  assert.match(script, /if \(button\.textContent !== label\) button\.textContent = label/);
  assert.match(script, /document\.querySelectorAll\("#mission-ribbon \.list-card"\)\.length >= 3/);
  assert.match(script, /document\.querySelectorAll\("#today \.story"\)\.length >= 9/);
  assert.match(script, /document\.body\.classList\.add\("frozen-showcase-ready"\)/);
  assert.match(script, /label\.textContent = "Recent updates"/);
  assert.match(script, /shortenDisplayTime/);
  assert.match(script, /13 publishers across three active Missions/);
  assert.match(script, /Twenty-seven source items/);
  assert.match(script, /Use Driftglass in ChatGPT/);
  assert.match(script, /Active Missions, conclusions, and open questions stay together/);

  const stylesResponse = await handleFrozenShowcaseRequest(new Request("https://driftglass.example/frozen-showcase.css"), env);
  assert.match(stylesResponse.headers.get("content-type"), /^text\/css/);
  const styles = await stylesResponse.text();
  assert.match(styles, /\.frozen-showcase-note/);
  assert.match(styles, /body:not\(\.frozen-showcase-ready\) #app\{visibility:hidden\}/);
  assert.match(styles, /overflow-x:clip/);
  assert.match(styles, /@media\(max-width:900px\)[\s\S]*\.frozen-showcase-note\{/);
  assert.match(styles, /\.topbar>\.top-actions[\s\S]*\.frozen-write-panel[\s\S]*\.feedback-row/);
  assert.match(styles, /#computer-search-form[\s\S]*#computer-note-form/);
  assert.match(styles, /\.frozen-mission-header/);
  assert.match(styles, /\.frozen-story-rail/);
  assert.match(styles, /#judgment-receipts>\.list-card/);
  assert.match(styles, /\.jump-missions:after/);
  assert.match(styles, /\.mission-next,.frozen-showcase \.research-baseline/);
  assert.match(styles, /\.frozen-overview-metrics/);
  assert.match(styles, /border-radius:var\(--frozen-radius-small\)/);
  assert.match(styles, /min-height:44px/);
  assert.match(styles, /dialog::backdrop/);
  assert.deepEqual(assetRequests, []);
});

test("the frozen Memory view connects Missions, findings, Stories, and a dated timeline", async () => {
  const { env, assetRequests } = fixtureEnv();
  const { response, payload } = await getJson(env, "/api/intelligence/overview");
  assert.equal(response.status, 200);
  assert.equal(payload.graph.stats["type:mission"], 3);
  assert.equal(payload.graph.stats["type:story"], 9);
  assert.equal(payload.nodes.filter((node) => node.node_type === "mission").length, 3);
  assert.equal(payload.nodes.filter((node) => node.node_type === "story").length, 9);
  assert.equal(payload.nodes.filter((node) => node.node_type === "finding").length, 3);
  assert.equal(payload.edges.filter((edge) => edge.relation === "answers").length, 3);
  assert.equal(payload.edges.filter((edge) => edge.relation === "tracks").length, 9);
  assert.equal(payload.edges.filter((edge) => edge.relation === "evidence_for").length, 9);
  assert.equal(payload.timeline.length, 12);
  assert.ok(payload.timeline.every((entry) => Number.isFinite(Date.parse(entry.at))));
  assert.deepEqual(assetRequests, []);
});

test("the existing product showcase gallery remains a separate static path", async () => {
  const { env, assetRequests } = fixtureEnv();
  const response = await handleFrozenShowcaseRequest(new Request("https://driftglass.example/showcase/"), env);
  const html = await response.text();
  assert.doesNotMatch(html, /data-driftglass-mode|frozen-showcase\.(?:js|css)/);
  assert.deepEqual(assetRequests, ["/showcase/"]);
});

test("the frozen API serves three source-backed Missions with complete Story navigation", async () => {
  const { env, assetRequests } = fixtureEnv();
  const { payload: health } = await getJson(env, "/health");
  const { response: overviewResponse, payload: overview } = await getJson(env, "/api/overview");
  const { response: missionsResponse, payload: missions } = await getJson(env, "/api/missions");
  const frozenNow = Date.parse(health.now);
  assert.ok(Number.isFinite(frozenNow));
  assert.equal(overviewResponse.status, 200);
  assert.equal(missionsResponse.status, 200);
  assert.equal(overviewResponse.headers.get("cache-control"), "no-store");
  assert.equal(missionsResponse.headers.get("cache-control"), "no-store");
  assert.equal(overview.stories.length, 9);
  assert.equal(missions.missions.length, 3);

  const expectedMissionIds = new Set([
    "hormuz-gas-normalization",
    "cloudflare-agent-adoption",
    "ai-infrastructure-bottlenecks",
  ]);
  assert.deepEqual(new Set(missions.missions.map((mission) => mission.id)), expectedMissionIds);
  assert.equal(new Set(missions.missions.map((mission) => mission.question)).size, 3);

  const overviewStoryById = new Map(overview.stories.map((story) => [story.id, story]));
  const expectedMatchCounts = new Map([
    ["hormuz-gas-normalization", 1],
    ["cloudflare-agent-adoption", 4],
    ["ai-infrastructure-bottlenecks", 4],
  ]);
  for (const mission of missions.missions) {
    assert.equal(mission.matches.length, expectedMatchCounts.get(mission.id));
    assert.ok(Date.parse(mission.researchState.last_research_at) <= frozenNow);
    for (const match of mission.matches) {
      assert.equal(overviewStoryById.get(match.story_id)?.title, match.title);
      assert.ok(Date.parse(match.last_changed_at) <= frozenNow);
    }
  }

  const evidenceByMission = new Map();
  const allEvidenceIds = new Set();
  for (const mission of missions.missions) {
    const evidence = [];
    for (const match of mission.matches) {
      const { response: detailResponse, payload: detail } = await getJson(env, `/api/stories/${match.story_id}`);
      assert.equal(detailResponse.status, 200);
      assert.equal(detail.story.id, match.story_id);
      assert.equal(detail.story.title, match.title);
      assert.ok(detail.evidence.length > 0);
      assert.ok(detail.evidence.every((item) => item.url.startsWith("https://")));
      assert.ok(detail.evidence.every((item) => Date.parse(item.published_at) <= frozenNow));
      for (const item of detail.evidence) {
        assert.equal(allEvidenceIds.has(item.id), false, `${item.id} is namespaced to one Story`);
        allEvidenceIds.add(item.id);
      }
      evidence.push(...detail.evidence);

      const { response: explainResponse, payload: explain } = await getJson(env, `/api/stories/${match.story_id}/explain`);
      assert.equal(explainResponse.status, 200);
      assert.ok(explain.explanation.components.length > 0);

      const { response: graphResponse, payload: graph } = await getJson(env, `/api/stories/${match.story_id}/graph`);
      assert.equal(graphResponse.status, 200);
      if (mission.matches.length === 1) {
        assert.equal(graph.graph, null);
      } else {
        assert.equal(graph.graph.nodes.length, mission.matches.length);
        assert.equal(graph.graph.edges.length, mission.matches.length - 1);
        assert.ok(graph.graph.nodes.some((node) => node.id === match.story_id));
      }
    }
    evidenceByMission.set(mission.id, evidence);
  }

  assert.equal(evidenceByMission.get("hormuz-gas-normalization").length, 3);
  assert.equal(evidenceByMission.get("cloudflare-agent-adoption").length, 12);
  assert.equal(evidenceByMission.get("ai-infrastructure-bottlenecks").length, 12);
  assert.equal(new Set(evidenceByMission.get("cloudflare-agent-adoption").map((item) => item.url)).size, 10);
  assert.equal(new Set(evidenceByMission.get("ai-infrastructure-bottlenecks").map((item) => item.url)).size, 9);
  assert.equal(allEvidenceIds.size, 27);
  assert.match(
    missions.missions.find((mission) => mission.id === "cloudflare-agent-adoption").researchState.current_thesis,
    /one vendor family/,
  );
  assert.deepEqual(assetRequests, []);
});

test("each frozen Mission has an isolated Computer and one reviewed saved answer", async () => {
  const { env, assetRequests } = fixtureEnv();
  const { payload: health } = await getJson(env, "/health");
  const { payload: missions } = await getJson(env, "/api/missions");
  const { payload: judgment } = await getJson(env, "/api/judgment");
  assert.equal(judgment.receipts.length, 3);
  assert.equal(judgment.reasoningRuns.length, 3);
  assert.equal(judgment.lineage.reduce((total, row) => total + row.count, 0), 27);
  assert.equal(judgment.lineage.find((row) => row.relation === "origin")?.count, 11);
  assert.equal(judgment.lineage.find((row) => row.relation === "same-family")?.count, 11);
  assert.equal(judgment.lineage.find((row) => row.relation === "echo")?.count, 5);

  const missionById = new Map(missions.missions.map((mission) => [mission.id, mission]));
  assert.deepEqual(new Set(judgment.receipts.map((receipt) => receipt.scope_id)), new Set(missionById.keys()));
  assert.equal(new Set(judgment.receipts.map((receipt) => receipt.id)).size, 3);
  assert.equal(new Set(judgment.reasoningRuns.map((run) => run.id)).size, 3);

  for (const mission of missions.missions) {
    const { response: computerResponse, payload: computerPayload } = await getJson(env, `/api/missions/${mission.id}/computer`);
    assert.equal(computerResponse.status, 200);
    const computer = computerPayload.computer;
    assert.ok(Date.parse(computer.syncedAt));
    assert.equal(computer.fileCount, 6);
    assert.equal(computer.fileCount, computer.files.filter((file) => !file.directory).length);
    assert.equal(computer.storyCount, mission.matches.length);
    assert.ok(computer.evidenceCount >= mission.matches.length);
    assert.ok(computer.files.some((file) => file.path === "mission.md" && !file.directory));
    const result = computer.files.find((file) => file.path === "results/Current-answer.md");
    assert.ok(result);

    for (const file of computer.files.filter((entry) => !entry.directory)) {
      const { response: fileResponse, payload: filePayload } = await getJson(
        env,
        `/api/missions/${mission.id}/computer/file?path=${encodeURIComponent(file.path)}`,
      );
      assert.equal(fileResponse.status, 200, `${mission.id}:${file.path}`);
      assert.ok(filePayload.content.length > 0);
      if (file.path === "mission.md") assert.ok(filePayload.content.includes(mission.researchState.current_thesis));
    }
  }

  for (const receipt of judgment.receipts) {
    const mission = missionById.get(receipt.scope_id);
    assert.ok(mission);
    assert.equal(receipt.scope_kind, "mission");
    assert.ok(Date.parse(receipt.created_at) <= Date.parse(health.now));
    const { response: detailResponse, payload: detail } = await getJson(env, `/api/reasoning/receipts/${receipt.id}`);
    assert.equal(detailResponse.status, 200);
    assert.equal(detail.receipt.id, receipt.id);
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.runs[0].receipt_id, receipt.id);
    assert.equal(detail.runs[0].status, "reviewed");
    assert.equal(JSON.parse(detail.runs[0].structured_result_json).answer, mission.researchState.current_thesis);

    const { response: compareResponse, payload: compare } = await getJson(env, `/api/reasoning/receipts/${receipt.id}/compare`);
    assert.equal(compareResponse.status, 200);
    assert.equal(compare.comparison.runCount, 1);
    assert.deepEqual(compare.comparison.runs.map((run) => run.id), [detail.runs[0].id]);
  }

  const cloudflareReceipt = judgment.receipts.find((receipt) => receipt.scope_id === "cloudflare-agent-adoption");
  const infrastructureReceipt = judgment.receipts.find((receipt) => receipt.scope_id === "ai-infrastructure-bottlenecks");
  assert.equal(cloudflareReceipt.evidence_count, 12);
  assert.equal(cloudflareReceipt.independent_family_count, 1);
  assert.equal(infrastructureReceipt.evidence_count, 12);
  assert.equal(infrastructureReceipt.independent_family_count, 8);

  const crossMissionFile = await getJson(
    env,
    `/api/missions/hormuz-gas-normalization/computer/file?path=${encodeURIComponent("notes/Adoption-boundaries.md")}`,
  );
  assert.equal(crossMissionFile.response.status, 404);
  assert.deepEqual(assetRequests, []);
});

test("dynamic frozen routes reject unknown IDs and suffixes", async () => {
  const { env, assetRequests } = fixtureEnv();
  for (const pathname of [
    "/api/stories/not-a-story",
    "/api/stories/hormuz-lng-normalization/explain/extra",
    "/api/missions/not-a-mission/computer",
    "/api/missions/hormuz-gas-normalization/computer/file?path=results%2Fmissing.md",
    "/api/reasoning/receipts/not-a-receipt",
    "/api/reasoning/receipts/showcase-hormuz-share-receipt/compare/extra",
  ]) {
    const { response } = await getJson(env, pathname);
    assert.equal(response.status, 404, pathname);
  }
  assert.deepEqual(assetRequests, []);
});

test("the frozen state stays in lockstep with the reviewed public analysis", async () => {
  const share = JSON.parse(await readFile(new URL("../public/showcase/hormuz-share.json", import.meta.url), "utf8"));
  const { env } = fixtureEnv();
  const missions = await (await handleFrozenShowcaseRequest(new Request("https://driftglass.example/api/missions"), env)).json();
  const story = await (await handleFrozenShowcaseRequest(new Request(`https://driftglass.example/api/stories/${share.stories[0].id}`), env)).json();
  const mission = missions.missions.find((entry) => entry.id === "hormuz-gas-normalization");
  assert.equal(mission.name, share.title);
  assert.equal(mission.researchState.current_thesis, share.reviewedAnswer.answer);
  assert.equal(story.story.title, share.stories[0].title);
  assert.deepEqual(story.evidence.map((item) => item.url), share.stories[0].evidence.map((item) => item.url));
  assert.deepEqual(story.evidence.map((item) => item.title), share.stories[0].evidence.map((item) => item.title));
});

test("the frozen boundary rejects writes and private or metered product routes before bindings", async () => {
  const { env, assetRequests } = fixtureEnv();
  for (const [url, method, expected] of [
    ["https://driftglass.example/api/sources/run-due", "POST", 405],
    ["https://driftglass.example/api/render/inspect", "POST", 405],
    ["https://driftglass.example/mcp", "GET", 404],
    ["https://driftglass.example/.well-known/oauth-authorization-server", "GET", 404],
    ["https://driftglass.example/.well-known/oauth-protected-resource", "GET", 404],
    ["https://driftglass.example/.well-known/oauth-protected-resource/mcp", "GET", 404],
    ["https://driftglass.example/collector/pair", "GET", 404],
    ["https://driftglass.example/share/private", "GET", 404],
  ]) {
    const response = await handleFrozenShowcaseRequest(new Request(url, { method }), env);
    assert.equal(response.status, expected, `${method} ${url}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(assetRequests, []);
});

test("missing source-like paths never fall through to the production login shell", async () => {
  const { env, assetRequests } = fixtureEnv();
  for (const path of ["/.env", "/.git/config", "/package.json", "/wrangler.jsonc", "/src/frozen-showcase.ts", "/foo.js"]) {
    const response = await handleFrozenShowcaseRequest(new Request(`https://driftglass.example${path}`), env);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    const body = await response.text();
    assert.doesNotMatch(body, /Owner key|webmcp\.js|login-shell/, path);
  }
  assert.deepEqual(assetRequests, ["/package.json", "/wrangler.jsonc", "/src/frozen-showcase.ts", "/foo.js"]);
});

test("public installs do not enable the frozen showcase mode", async () => {
  const [configRaw, workerRaw] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  ]);
  const config = JSON.parse(configRaw);
  assert.equal(config.vars.PUBLIC_SHOWCASE_MODE, undefined);
  assert.equal(config.env.staging.vars.PUBLIC_SHOWCASE_MODE, undefined);
  assert.match(workerRaw, /if \(frozenShowcaseEnabled\(env\)\) return;/);
});

test("the approved public capture inputs remain byte-for-byte unchanged", async () => {
  const expected = new Map([
    ["app.js", "fe4ccd7f856dded52b1b6d3d6bc471853ccc403e13066859ae253d697baecdaf"],
    ["index.html", "d12b37747059a558a1f687d34eb16cc31a85989995055c8003a5c0f762e61596"],
    ["styles.css", "4c658b6d695452689d495e9f6eef4752436a2159dc5ab8bfb90194c9826b634b"],
    ["sw.js", "ad2fa7a76a496a362e17fd5b84e44c453aba21477891f188c1260c83cebadc4e"],
  ]);
  for (const [filename, digest] of expected) {
    const bytes = await readFile(new URL(`../public/${filename}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, `${filename} still matches the approved capture input`);
  }
});
