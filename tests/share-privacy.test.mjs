import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const {
  normalizePublicSharePayload,
  projectPublicStory,
  publicShareResponseHeaders,
  recipientShareDocument,
} = require("../.test-dist/share-privacy.js");
const { buildDropCapsule } = require("../.test-dist/drop-capsule.js");
const Module = require("node:module");
const originalLoad = Module._load;
let handlePublicShare;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "cloudflare:workers") return { tracing: { trace: (_name, operation) => operation } };
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ handlePublicShare } = require("../.test-dist/shares.js"));
} finally {
  Module._load = originalLoad;
}

function evidence(overrides = {}) {
  return {
    id: "item-public-1",
    source_id: "source-public-1",
    external_id: null,
    url: "https://public.example/evidence",
    canonical_url: "https://public.example/evidence",
    title: "Public launch evidence",
    text: "Public source text that can safely appear in a shared card.",
    author: "Public author",
    published_at: "2026-08-07T10:00:00.000Z",
    observed_at: "2026-08-07T10:05:00.000Z",
    content_hash: "public-hash",
    raw_r2_key: "raw/public.txt",
    access_class: "public",
    metadata_json: "{}",
    created_at: "2026-08-07T10:05:00.000Z",
    source_name: "Public source",
    source_kind: "web",
    source_health_score: 0.8,
    family_key: "public.example",
    lineage_relation: "origin",
    lineage_independent: 1,
    ...overrides,
  };
}

function payload(story) {
  return {
    schemaVersion: "2",
    publicEvidenceOnly: true,
    kind: "story",
    title: story.title,
    generatedAt: "2026-08-07T12:00:00.000Z",
    stories: [story],
  };
}

test("public-only Stories are rebuilt with public evidence, source, and independence counts", () => {
  const story = projectPublicStory({
    story: { id: "story-public", title: "PRIVATE-DERIVED STORED TITLE", summary: "PRIVATE-DERIVED STORED SUMMARY" },
    evidence: [
      evidence(),
      evidence({
        id: "item-public-2",
        source_id: "source-public-2",
        source_name: "Second public source",
        url: "https://second.example/report",
        canonical_url: "https://second.example/report",
        title: "Longer public title from the second source",
        text: "A longer public explanation from an independent second reporting family that is safe to publish.",
        observed_at: "2026-08-07T11:05:00.000Z",
        family_key: "second.example",
      }),
    ],
  }, 12);

  assert.ok(story);
  assert.equal(story.title, "Longer public title from the second source");
  assert.equal(story.evidenceCount, 2);
  assert.equal(story.sourceCount, 2);
  assert.equal(story.sourceFamilyCount, 2);
  assert.equal(story.independentFamilyCount, 2);
  assert.equal(story.echoCount, 0);
  assert.equal(story.score, undefined);
  assert.ok(story.evidence.every((item) => item.accessClass === "public" && item.independent));
  assert.doesNotMatch(JSON.stringify(story), /PRIVATE-DERIVED/);
});

test("public Story projection prefers a safe canonical URL and falls back to a safe source URL", () => {
  const canonical = projectPublicStory({
    story: { id: "story-canonical" },
    evidence: [evidence({
      canonical_url: "https://canonical.example/evidence",
      url: "https://public.example/evidence?token=private",
    })],
  });
  assert.equal(canonical?.evidence[0]?.url, "https://canonical.example/evidence");

  const fallback = projectPublicStory({
    story: { id: "story-fallback" },
    evidence: [evidence({
      canonical_url: "https://canonical.example/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      url: "https://public.example/fallback",
    })],
  });
  assert.equal(fallback?.evidence[0]?.url, "https://public.example/fallback");
});

test("mixed Stories omit Email, Companion, subscriber, and private evidence and recompute public fields", () => {
  const story = projectPublicStory({
    story: { id: "story-mixed", title: "Authenticated inbox secret", summary: "Companion-only synthesis" },
    evidence: [
      evidence({
        id: "public-origin",
        source_id: "public-source",
        title: "Public corroboration",
        text: "Only this public explanation may leave the owner boundary.",
      }),
      evidence({
        id: "public-echo",
        source_id: "public-source",
        title: "Public repeated coverage",
        text: "Public repeated coverage.",
        lineage_relation: "echo",
        lineage_independent: 0,
      }),
      evidence({
        id: "email-authenticated",
        source_id: "email-source",
        source_name: "Private inbox",
        source_kind: "email",
        access_class: "authenticated-local",
        title: "EMAIL SECRET SUBJECT",
        text: "EMAIL SECRET BODY",
      }),
      evidence({
        id: "subscriber-local",
        source_id: "subscriber-source",
        access_class: "subscriber-local",
        title: "SUBSCRIBER SECRET",
        text: "SUBSCRIBER BODY",
      }),
      evidence({
        id: "companion-misstamped",
        source_id: "collector-source",
        source_kind: "collector",
        access_class: "public",
        title: "COMPANION SECRET",
        text: "COMPANION BODY",
      }),
      evidence({
        id: "private-item",
        source_id: "private-source",
        access_class: "private",
        title: "PRIVATE SECRET",
        text: "PRIVATE BODY",
      }),
    ],
  }, 12);

  assert.ok(story);
  assert.equal(story.evidenceCount, 2);
  assert.equal(story.sourceCount, 1);
  assert.equal(story.sourceFamilyCount, 1);
  assert.equal(story.independentFamilyCount, 1);
  assert.equal(story.echoCount, 1);
  assert.equal(story.evidence.length, 2);
  assert.doesNotMatch(JSON.stringify(story), /EMAIL SECRET|SUBSCRIBER SECRET|COMPANION SECRET|PRIVATE SECRET|owner boundary.*SECRET/i);
});

test("recipient projection cleans feed markup and omits internal IDs, counters, and legacy Mission context", () => {
  const story = projectPublicStory({
    story: { id: "story-internal-secret" },
    evidence: [evidence({
      title: "[Release notes](https://public.example/release)",
      text: "<p>Shipped the durable workspace.</p> ![badge](https://public.example/badge.svg) https://public.example/raw",
    })],
  });
  assert.ok(story);
  const shared = normalizePublicSharePayload({
    ...payload(story),
    kind: "mission",
    title: "Workspace adoption",
    subtitle: "Did the durable workspace ship?",
    context: [
      { label: "Mode", value: "autopilot" },
      { label: "Current conclusion", value: "PRIVATE OPERATOR SYNTHESIS" },
    ],
  });
  assert.ok(shared);
  assert.equal(shared.context, undefined);
  const recipient = recipientShareDocument(shared, "2026-08-21T12:00:00.000Z");
  const serialized = JSON.stringify(recipient);
  assert.equal(recipient.type, "Shared Mission");
  assert.equal(recipient.stories[0].title, "Release notes");
  assert.equal(recipient.stories[0].summary, "Shipped the durable workspace.");
  assert.doesNotMatch(serialized, /story-internal-secret|evidenceCount|sourceCount|confidence|PRIVATE OPERATOR|autopilot/);
});

test("private-only Stories fail closed, including Email or Companion rows accidentally marked public", () => {
  const story = projectPublicStory({
    story: { id: "story-private" },
    evidence: [
      evidence({ source_kind: "email", access_class: "public", title: "Mislabeled Email" }),
      evidence({ source_kind: "collector", access_class: "public", title: "Mislabeled Companion" }),
      evidence({ source_kind: "web", access_class: "authenticated-local", title: "Authenticated web" }),
      evidence({ source_kind: "web", access_class: "private", title: "Private web" }),
    ],
  });
  assert.equal(story, null);
});

test("stored payload validation rejects legacy and private evidence instead of trusting a marker", () => {
  const story = projectPublicStory({ story: { id: "story-valid" }, evidence: [evidence()] });
  assert.ok(story);
  const valid = payload(story);
  const normalized = normalizePublicSharePayload(valid);
  assert.ok(normalized);
  assert.equal(normalized.schemaVersion, "2");
  assert.equal(normalized.publicEvidenceOnly, true);
  assert.deepEqual(normalized.stories, valid.stories);
  assert.equal(normalizePublicSharePayload({ ...valid, schemaVersion: "1" }), null);
  const privatePayload = structuredClone(valid);
  privatePayload.stories[0].evidence[0].accessClass = "private";
  assert.equal(normalizePublicSharePayload(privatePayload), null);
  assert.throws(() => buildDropCapsule(privatePayload), /public-evidence-only/i);

  const unsafeUrlPayload = structuredClone(valid);
  unsafeUrlPayload.stories[0].evidence[0].url = "https://public.example/evidence?token=private";
  assert.equal(normalizePublicSharePayload(unsafeUrlPayload), null);
  assert.throws(() => buildDropCapsule(unsafeUrlPayload), /public-evidence-only/i);
});

test("staging noindex policy applies to HTML, JSON, OG, and Drop responses", () => {
  for (const contentType of ["text/html", "application/json", "image/png", "application/zip"]) {
    const headers = publicShareResponseHeaders(false, {
      "content-type": contentType,
      "cache-control": "public, max-age=86400",
    });
    assert.equal(headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(headers.get("cache-control"), "private, no-store");
  }
  const production = publicShareResponseHeaders(true, { "cache-control": "public, max-age=300" });
  assert.equal(production.get("x-robots-tag"), "index, follow");
  assert.equal(production.get("cache-control"), "public, max-age=300");
});

test("public Share routes reject non-GET methods before storage or rendering work", async () => {
  const env = {
    PUBLIC_INDEXING: "disabled",
    get DB() {
      throw new Error("method rejection must not read the share database");
    },
  };

  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "HEAD"]) {
    const response = await handlePublicShare(new Request("https://staging.example/share/not-a-token", { method }), env);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET", method);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", method);
    assert.equal(response.headers.get("cache-control"), "private, no-store", method);
    if (method === "HEAD") {
      assert.equal(await response.text(), "", method);
    } else {
      assert.match(await response.text(), /Method not allowed; use GET/, method);
    }
  }
});

test("staging Drop Capsules carry noindex HTML and a disallowing robots.txt", async () => {
  const story = projectPublicStory({ story: { id: "story-drop" }, evidence: [evidence()] });
  assert.ok(story);
  const archive = buildDropCapsule(payload(story), { publicIndexing: false });
  const directory = await mkdtemp(join(tmpdir(), "driftglass-private-drop-"));
  const zipPath = join(directory, "drop.zip");
  await writeFile(zipPath, archive);
  try {
    const [{ stdout: index }, { stdout: robots }, { stdout: data }] = await Promise.all([
      execFileAsync("unzip", ["-p", zipPath, "index.html"]),
      execFileAsync("unzip", ["-p", zipPath, "robots.txt"]),
      execFileAsync("unzip", ["-p", zipPath, "data.json"]),
    ]);
    assert.match(index, /name="robots" content="noindex,nofollow"/);
    assert.equal(robots, "User-agent: *\nDisallow: /\n");
    assert.match(data, /"publicEvidenceOnly": true/);
    assert.match(data, /"type": "Shared Story"/);
    assert.doesNotMatch(data, /"id"|evidenceCount|sourceCount|confidence/);
    assert.doesNotMatch(data, /authenticated-local|subscriber-local|"accessClass": "private"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OG preview rendering never increments public share view analytics", async () => {
  const source = await readFile(new URL("../src/shares.ts", import.meta.url), "utf8");
  assert.match(source, /new URL\(`\/share\/\$\{token\}\?preview=1`/);
  const counter = source.slice(
    source.indexOf("Internal OG screenshots use preview=1"),
    source.indexOf('if (url.searchParams.get("format")', source.indexOf("Internal OG screenshots use preview=1")),
  );
  assert.match(counter, /url\.searchParams\.get\("preview"\) !== "1"/);
  assert.match(counter, /incrementPublicShareView/);
});
