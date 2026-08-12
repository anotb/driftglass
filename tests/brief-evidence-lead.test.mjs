import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const compiledRoot = process.env.DRIFTGLASS_TEST_DIST;
const {
  briefWhyIncluded,
  publicBriefMatchedTerms,
  selectBriefEvidenceLead,
} = compiledRoot
  ? require(join(compiledRoot, "brief-evidence-lead.js"))
  : require("../.test-dist/brief-evidence-lead.js");

test("evidence lead selects a concrete matched release note and preserves its source URL", () => {
  const capability = "https://owner.example/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const lead = selectBriefEvidenceLead([{
    title: "cloudflare/agents v0.20.1",
    url: "https://github.com/cloudflare/agents/releases/tag/v0.20.1",
    excerpt: `
# v0.20.1
## What's Changed
- chore: update generated fixtures
- Add durable object alarm recovery for scheduled agent work. ${capability}
- Bump a dependency from 1.0.0 to 1.0.1
## Full Changelog
`.replace(/\s+/g, " ").trim(),
  }], ["durable object"]);

  assert.deepEqual(lead, {
    text: "Add durable object alarm recovery for scheduled agent work.",
    sourceUrl: "https://github.com/cloudflare/agents/releases/tag/v0.20.1",
  });
  assert.doesNotMatch(JSON.stringify(lead), /aaaaaaaaaaaaaaaa|owner\.example/);
});

test("Workers SDK release metadata cannot outrank the substantive change", () => {
  const lead = selectBriefEvidenceLead([{
    title: "workers-sdk@4.120.0",
    url: "https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.120.0",
    excerpt: "Minor Changes #15008 a1b2c3d Thanks @worker-user! - Adds automatic retry recovery for interrupted deployments.",
  }]);

  assert.deepEqual(lead, {
    text: "Adds automatic retry recovery for interrupted deployments.",
    sourceUrl: "https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.120.0",
  });
});

test("GitHub PR-list changelog entries cannot outrank the 0.147.0 release features", () => {
  const url = "https://github.com/openai/codex/releases/tag/rust-v0.147.0";
  const matchedTerms = ["Codex", "MCP", "approval", "permissions", "elicitation", "migration"];
  const excerpt = `
## New Features
- Install portable Agent Plugins and search across local, personal, workspace, and remote plugin catalogs. (#36544, #36409, #36919, #36796)
- Organize conversations into persistent, manually ordered sections and browse long transcripts incrementally. (#35722, #36007, #36380, #36948, #36950)
- Enable automatically reviewed approvals with the new \`--approve-for-me\` CLI flag. (#36373)
- Import Cursor-managed skills and synchronize changes to imported Claude and Cursor conversations without creating duplicates. (#36361, #36356, #35623)
- Support the opt-in MCP 2026-07-28 protocol, including paginated discovery, multi-round requests, and non-blocking server startup. (#35724, #35725, #35590, #35742)
- Enable cached web search and remote conversation compaction for Amazon Bedrock. (#36938, #36981)

## Chores
- Upgrade the MCP SDK to 3.0.0, Ratatui to 0.30.2, and V8 to 150.4.0. (#36001, #35959, #35831)
- Secure macOS release notarization using Azure Key Vault instead of exporting private signing keys. (#37154)
- Remove the deprecated \`codex exec --full-auto\` flag; use \`--sandbox workspace-write\` instead. (#36054)
- Stop publishing redundant Linux bundle archives; use the standard \`codex-package-<target>\` release archives. (#36342)

## Changelog

Full Changelog: https://github.com/openai/codex/compare/rust-v0.146.0...rust-v0.147.0

- #35724 Add MCP 2026-07-28 discovery support @copyberry
- #36359 Consolidate MCP config editing in codex-core @copyberry
- #36365 Add strict automatic review for MCP elicitations @copyberry
- #36373 Add an \`--approve-for-me\` CLI flag @copyberry
  `.trim();

  const docsSource = {
    title: "OpenAI Codex CLI changelog",
    url: "https://learn.chatgpt.com/docs/changelog",
    excerpt: `pre]:w-full [&>pre]:max-w-full [&>pre]:mb-0 pt-4\"> $ npm install -g @openai/codex@0.147.0 View details New Features Install portable Agent Plugins and search across local, personal, workspace, and remote plugin catalogs. ( #36544 , #36409 , #36919 , #36796 ) Organize conversations into persistent, manually ordered sections and browse long transcripts incrementally. ( #35722 , #36007 , #36380 , #36948 , #36950 ) Enable automatically reviewed approvals with the new --approve-for-me CLI flag. ( #36373 ) Import Cursor-managed skills and synchronize changes to imported Claude and Cursor conversations without creating duplicates. ( #36361 , #36356 , #35623 ) Support the opt-in MCP 2026-07-28 protocol, including paginated discovery, multi-round requests, and non-blocking server startup. ( #35724 , #35725 , #35590 , #35742 )`,
  };
  const lead = selectBriefEvidenceLead([
    docsSource,
    { title: "openai/codex: 0.147.0", url, excerpt },
  ], matchedTerms);

  assert.deepEqual(lead, {
    text: "Enable automatically reviewed approvals with the new --approve-for-me CLI flag. ( #36373 )",
    sourceUrl: docsSource.url,
  });
  assert.doesNotMatch(lead.text, /pre\]:|skip to content|Remove the deprecated|^#\d+|@copyberry/i);
  assert.equal(selectBriefEvidenceLead([{
    title: "openai/codex: 0.147.0",
    url,
    excerpt: "#36359 Consolidate MCP config editing in codex-core @copyberry",
  }], matchedTerms), null);
});

test("flattened Codex release prose restores feature boundaries before the lead limit", () => {
  const url = "https://learn.chatgpt.com/docs/changelog";
  const lead = selectBriefEvidenceLead([{
    title: "OpenAI Codex CLI changelog",
    url,
    excerpt: `pre]:w-full [&>pre]:max-w-full [&>pre]:mb-0 pt-4\"> $ npm install -g @openai/codex@0.147.0 View details New Features Install portable Agent Plugins and search across local, personal, workspace, and remote plugin catalogs. ( #36544 , #36409 , #36919 , #36796 ) Organize conversations into persistent, manually ordered sections and browse long transcripts incrementally. ( #35722 , #36007 , #36380 , #36948 , #36950 ) Enable automatically reviewed approvals with the new --approve-for-me CLI flag. ( #36373 ) Import Cursor-managed skills and synchronize changes to imported Claude and Cursor conversations without creating duplicates. ( #36361 , #36356 , #35623 ) Support the opt-in MCP 2026-07-28 protocol, including paginated discovery, multi-round requests, and non-blocking server startup. ( #35724 , #35725 , #35590 , #35742 ) Other improvements and bug fixes Added a new Activity view and report-generation polish.`,
  }], ["Codex", "MCP", "approval", "permissions", "elicitation", "migration"]);

  assert.deepEqual(lead, {
    text: "Enable automatically reviewed approvals with the new --approve-for-me CLI flag. ( #36373 )",
    sourceUrl: url,
  });
  assert.doesNotMatch(lead.text, /pre\]:|Activity view|report-generation|Other improvements/i);
});

test("evidence leads decode common typographic HTML entities without parsing HTML", () => {
  const lead = selectBriefEvidenceLead([{
    title: "Approval behavior",
    url: "https://source.example/releases/approval-behavior",
    excerpt: "Adds support for a user&rsquo;s reviewed approvals &mdash; without changing the default policy.",
  }], ["approval"]);

  assert.equal(lead?.text, "Adds support for a user’s reviewed approvals — without changing the default policy.");
  assert.doesNotMatch(lead?.text ?? "", /&(?:rsquo|mdash);/i);
});

test("Cloudflare changelog navigation soup produces no evidence lead", () => {
  const lead = selectBriefEvidenceLead([{
    title: "Cloudflare changelog",
    url: "https://developers.cloudflare.com/changelog/",
    excerpt: "Upgrade To update to this release, run the install command. Later release details follow. Skip to content Cloudflare Docs Docs Directory Search Ctrl K Log in",
  }]);
  assert.equal(lead, null);
});

test("generic package descriptions never masquerade as version-specific changes", () => {
  const lead = selectBriefEvidenceLead([{
    title: "agents 0.20.1",
    url: "https://www.npmjs.com/package/agents",
    excerpt: "Build AI agents with durable state. Package: agents Version: 0.20.1",
  }], ["agents"]);
  assert.equal(lead, null);
});

test("mid-sentence capability URLs and bare capability paths are removed before scoring", () => {
  const lead = selectBriefEvidenceLead([{
    title: "Alarm recovery update",
    url: "https://source.example/releases/alarm-recovery",
    excerpt: "Adds alarm recovery through https://owner.example/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa while retaining retries and removes /packet/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb from diagnostics.",
  }]);

  assert.equal(lead?.sourceUrl, "https://source.example/releases/alarm-recovery");
  assert.match(lead?.text ?? "", /Adds alarm recovery/);
  assert.doesNotMatch(lead?.text ?? "", /https?:\/\/|owner\.example|\/mcp\/|\/packet\/|a{16}|b{16}/i);
});

test("why-included language explains selection without claiming consequence", () => {
  assert.equal(briefWhyIncluded({
    missionName: "Agent infrastructure",
    matchedTerms: ["MCP", "Durable Objects"],
  }), "Matched Agent infrastructure on “mcp” and “durable objects”.");
  assert.equal(briefWhyIncluded({ change: "changed" }), "Materially changed public evidence in the current brief.");
});

test("matched-term rationale names only terms visible in public brief evidence", () => {
  assert.deepEqual(publicBriefMatchedTerms([{
    title: "Durable Object alarm recovery",
    excerpt: "The public release adds alarm recovery.",
    url: "https://source.example/release",
  }], ["Durable Object", "private roadmap"]), ["durable object"]);
});
