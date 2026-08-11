import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("WebMCP story search registers against the canonical stories endpoint", async () => {
  const registered = [];
  const requests = [];
  const payload = { ok: true, stories: [{ id: "story-1", title: "Cloudflare agents" }] };
  const document = {
    modelContext: {
      registerTool(tool) {
        registered.push(tool);
      },
    },
    documentElement: { dataset: {} },
  };
  const source = await readFile(new URL("../public/webmcp.js", import.meta.url), "utf8");

  runInNewContext(source, {
    console,
    document,
    navigator: {},
    URLSearchParams,
    window: {
      DriftglassApi: {
        isUnlocked: () => true,
        request: async (path, options) => {
          requests.push({ path, options });
          return payload;
        },
      },
    },
  }, { filename: "public/webmcp.js" });
  await new Promise((resolve) => setImmediate(resolve));

  const search = registered.find((tool) => tool.name === "driftglass_search_stories");
  assert.ok(search, "story search tool must be registered");
  assert.deepEqual([...search.inputSchema.required], ["query"]);

  const result = await search.execute({ query: "Cloudflare & agents", limit: 500 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/stories?q=Cloudflare%20%26%20agents&limit=50");
  assert.ok(!requests[0].path.startsWith("/api/search"));
  assert.equal(result.structuredContent, payload);
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), payload);
});

test("WebMCP separates read-only Computer inspection from explicit synchronization", async () => {
  const registered = [];
  const requests = [];
  const document = {
    modelContext: {
      registerTool(tool) {
        registered.push(tool);
      },
    },
    documentElement: { dataset: {} },
  };
  const source = await readFile(new URL("../public/webmcp.js", import.meta.url), "utf8");
  runInNewContext(source, {
    console,
    document,
    navigator: {},
    URLSearchParams,
    window: {
      DriftglassApi: {
        isUnlocked: () => true,
        request: async (path, options) => {
          requests.push({ path, options });
          return { ok: true };
        },
      },
    },
  }, { filename: "public/webmcp.js" });
  await new Promise((resolve) => setImmediate(resolve));

  const open = registered.find((tool) => tool.name === "driftglass_open_mission_computer");
  const sync = registered.find((tool) => tool.name === "driftglass_sync_mission_computer");
  assert.ok(open);
  assert.ok(sync);
  assert.equal(open.annotations.readOnlyHint, true);
  assert.equal(sync.annotations.readOnlyHint, false);
  assert.equal(open.inputSchema.properties.sync, undefined);

  await open.execute({ missionId: "mission one", sync: true });
  assert.deepEqual(requests.shift(), {
    path: "/api/missions/mission%20one/computer",
    options: undefined,
  });
  await sync.execute({ missionId: "mission one" });
  const syncRequest = requests.shift();
  assert.equal(syncRequest.path, "/api/missions/mission%20one/computer/sync");
  assert.equal(syncRequest.options.method, "POST");
  assert.equal(syncRequest.options.body, "{}");

  assert.equal(registered.some((tool) => tool.name === "driftglass_prepare_reasoning_context"), false);
  const receipt = registered.find((tool) => tool.name === "driftglass_prepare_reasoning_receipt");
  assert.ok(receipt);
  assert.equal(receipt.annotations.readOnlyHint, false);
  assert.equal(
    registered.some((tool) => tool.annotations?.readOnlyHint && String(tool.execute).includes("/api/reasoning/receipts")),
    false,
  );
});
