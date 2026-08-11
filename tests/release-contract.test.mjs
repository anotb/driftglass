import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("Email Routing and experimental WebMCP boundaries stay current and explicit", async () => {
  const [html, readme, release] = await Promise.all([
    read("public/index.html"),
    read("README.md"),
    read("docs/RELEASE-0.9.0.md"),
  ]);

  assert.match(
    html,
    /https:\/\/developers\.cloudflare\.com\/email-service\/get-started\/route-emails\/#configure-routing-to-worker/,
  );
  assert.doesNotMatch(html, /developers\.cloudflare\.com\/email-routing\/email-workers/);

  for (const document of [readme, release]) {
    assert.match(document, /WebMCP (?:is an?|remains) experimental/i);
    assert.match(document, /origin-trial token/i);
    assert.match(document, /chrome:\/\/flags\/#enable-webmcp-testing/);
    assert.match(document, /unlocked (?:Driftglass )?dashboard tab/i);
    assert.match(document, /compact remote MCP/);
  }
});
