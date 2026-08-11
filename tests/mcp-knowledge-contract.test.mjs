import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  knowledgeFetchOutput,
  knowledgeSearchOutput,
  knowledgeToolResult,
  publicKnowledgeUrl,
} = require("../.test-dist/mcp-knowledge.js");

test("standard knowledge results expose only absolute public citation URLs at both MCP roots", () => {
  const search = knowledgeSearchOutput([
    { id: "story-1", title: "Public evidence", url: "https://example.com/source" },
    { id: "story-private", title: "Private evidence", url: "http://127.0.0.1/private" },
  ]);
  assert.deepEqual(search, {
    results: [{ id: "story-1", title: "Public evidence", url: "https://example.com/source" }],
  });
  assert.equal(publicKnowledgeUrl("https://owner:secret@example.com/source"), "https://example.com/source");
  assert.equal(publicKnowledgeUrl("https://example.com/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "");
  assert.equal(publicKnowledgeUrl("https://example.com/source?token=private"), "");

  const document = knowledgeFetchOutput({
    id: "story-1",
    title: "Public evidence",
    text: "Decisive evidence.\nSource URL: https://example.com/source",
    url: "https://example.com/source",
    metadata: { evidence: [{ accessClass: "public", url: "https://example.com/source" }] },
  });
  const result = knowledgeToolResult(document);
  assert.deepEqual(Object.keys(result.structuredContent), ["id", "title", "text", "url", "metadata"]);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.url, "https://example.com/source");
});
