import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MAX_KITESURF_HTML_BYTES,
  MAX_KITESURF_LINKS,
  MAX_KITESURF_TEXT_BYTES,
  cdpEvaluationObject,
  cdpEvaluationValue,
  cdpMessageText,
  kitesurfExtractionExpression,
} = require("../.test-dist/rendering-cdp.js");
const { listRenderStats } = require("../.test-dist/db.js");

test("CDP Runtime.evaluate reads the standard single result envelope", () => {
  const scalar = { result: { type: "string", value: "complete" } };
  assert.equal(cdpEvaluationValue(scalar), "complete");

  const page = { result: { type: "object", value: { title: "Example", text: "Rendered content" } } };
  assert.deepEqual(cdpEvaluationObject(page), { title: "Example", text: "Rendered content" });
});

test("CDP Runtime.evaluate rejects page exceptions and non-object page values", () => {
  assert.throws(
    () => cdpEvaluationObject({ exceptionDetails: { text: "ReferenceError" }, result: { type: "object" } }),
    /page evaluation failed/,
  );
  assert.deepEqual(cdpEvaluationObject({ result: { type: "string", value: "not a page object" } }), {});
});

test("CDP messages are byte-bounded before parsing", () => {
  assert.equal(cdpMessageText('{"ok":true}', 32), '{"ok":true}');
  assert.equal(cdpMessageText(new TextEncoder().encode("ok"), 2), "ok");
  assert.throws(() => cdpMessageText("💡💡", 7), /CDP message exceeds 7 bytes/);
  assert.throws(() => cdpMessageText(new Uint8Array(9), 8), /CDP message exceeds 8 bytes/);
});

test("Kitesurf extraction clips page fields and link count inside the page expression", () => {
  const anchors = Array.from({ length: MAX_KITESURF_LINKS + 5 }, (_, index) => ({
    href: `https://example.com/${index}`,
    innerText: "link ".repeat(400),
    textContent: "",
    getAttribute: () => "",
  }));
  const root = { outerHTML: "h".repeat(MAX_KITESURF_HTML_BYTES + 10), innerHTML: "" };
  const document = {
    title: "Example",
    documentElement: root,
    body: { innerText: "💡".repeat(Math.ceil(MAX_KITESURF_TEXT_BYTES / 4) + 10), textContent: "" },
    querySelector: () => root,
    querySelectorAll: () => anchors,
  };
  const expression = kitesurfExtractionExpression(undefined, true);
  const value = Function("document", "location", `return ${expression}`)(document, { href: "https://example.com/" });

  assert.ok(new TextEncoder().encode(value.html).byteLength <= MAX_KITESURF_HTML_BYTES);
  assert.ok(new TextEncoder().encode(value.text).byteLength <= MAX_KITESURF_TEXT_BYTES);
  assert.equal(value.links.length, MAX_KITESURF_LINKS);
  assert.equal(value.truncated, true);
});

test("render stats expose the consecutive failures that drive adaptive routing", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      statements.push(sql);
      return { all: async () => ({ results: [] }) };
    },
  };

  await listRenderStats(db);
  const profileQuery = statements.find((sql) => sql.includes("FROM render_profiles"));
  assert.match(profileQuery, /kitesurf_consecutive_failures/);
  assert.match(profileQuery, /chromium_consecutive_failures/);
});
