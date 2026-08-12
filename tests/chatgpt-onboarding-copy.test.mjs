import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
test("per-instance ChatGPT setup separates the bare Tools path from @Driftglass", async () => {
  const [install, reasoning, tunnel, app] = await Promise.all([
    readFile(new URL("public/install.md", root), "utf8"),
    readFile(new URL("docs/REASONING-INTERFACES.md", root), "utf8"),
    readFile(new URL("src/runtime/node/chatgpt-tunnel.ts", root), "utf8"),
    readFile(new URL("public/app.js", root), "utf8"),
  ]);

  assert.match(install, /available from \*\*Tools\*\*/);
  assert.match(reasoning, /bare connection is available from \*\*Tools\*\*/);
  assert.match(tunnel, /use Tools for a quick check/);
  assert.match(app, /start a new ChatGPT Work chat, open Tools, and select Driftglass/i);
  assert.match(app, /get a source-linked answer/i);

  for (const source of [install, reasoning, tunnel, app]) {
    assert.match(source, /Add @Driftglass/);
  }
  assert.match(install, /does not add a Driftglass relay/);
  assert.match(reasoning, /does not need a shared gateway/);
});
