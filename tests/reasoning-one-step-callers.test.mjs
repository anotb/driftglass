import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
const calls = { records: [], comparisons: [] };

const reasoningLedgerMock = {
  async beginReasoningRun() {
    assert.fail("one-step caller used beginReasoningRun");
  },
  async completeReasoningRun() {
    assert.fail("one-step caller used completeReasoningRun");
  },
  async recordReasoningResult(_env, input) {
    calls.records.push(input);
    return {
      run: {
        id: `run-${calls.records.length}`,
        receipt_id: input.receiptId,
        provider_label: input.provider,
        model_label: input.model ?? null,
        client_label: input.client ?? null,
        status: "completed",
      },
      memoryProposalId: null,
    };
  },
  async compareReasoningRuns(_env, receiptId) {
    calls.comparisons.push(receiptId);
    return { receiptId, providerCount: 1, needsAdjudication: false };
  },
};

class FakeMcpServer {
  constructor() {
    this.tools = new Map();
  }

  registerResource() {}

  registerTool(name, _definition, handler) {
    this.tools.set(name, handler);
  }
}

function fakeMcpHandler(factory) {
  return async (request) => {
    const payload = await request.json();
    const server = factory();
    const handler = server.tools.get(payload.params?.name);
    assert.ok(handler, `registered MCP tool ${payload.params?.name}`);
    const result = await handler(payload.params?.arguments ?? {});
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), {
      headers: { "content-type": "application/json" },
    });
  };
}

let handleV09Api;
let handleMcp;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "./reasoning-ledger") return reasoningLedgerMock;
    if (request === "@modelcontextprotocol/server") return { McpServer: FakeMcpServer };
    if (request === "agents/mcp/server") return { createMcpHandler: fakeMcpHandler };
    if (request === "@cloudflare/computer") {
      return { getWorkspace: () => ({}), withWorkspace: (Base) => Base };
    }
    if (request === "./security" && parent?.filename?.endsWith("/.test-dist/mcp.js")) {
      return {
        assertPublicHttpUrl: (value) => value,
        authorizeMcpPath: async () => "operations",
      };
    }
    if (request === "cloudflare:workers") {
      return {
        DurableObject: class DurableObject {},
        WorkflowEntrypoint: class WorkflowEntrypoint {},
        tracing: { trace: (_name, operation) => operation },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ handleV09Api } = require("../.test-dist/v09-api.js"));
  ({ handleMcp } = require("../.test-dist/mcp.js"));
} finally {
  Module._load = originalLoad;
}

test("one-step API preserves attribution and comparison through the atomic ledger helper", async () => {
  calls.records.length = 0;
  calls.comparisons.length = 0;
  const response = await handleV09Api(
    new Request("https://driftglass.invalid/api/reasoning/receipts/receipt-api/results", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "chatgpt",
        model: "subscription-gpt",
        client: "driftglass-dashboard",
        response: "Bounded result",
        structuredResult: { summary: "Canonical" },
      }),
    }),
    { DB: {} },
    {},
  );

  assert.equal(response.status, 201);
  assert.equal(calls.records.length, 1);
  assert.equal(calls.records[0].receiptId, "receipt-api");
  assert.equal(calls.records[0].provider, "chatgpt");
  assert.equal(calls.records[0].model, "subscription-gpt");
  assert.equal(calls.records[0].client, "driftglass-dashboard");
  assert.deepEqual(calls.comparisons, ["receipt-api"]);
  const body = await response.json();
  assert.equal(body.run.provider_label, "chatgpt");
  assert.equal(body.comparison.providerCount, 1);
});

test("record_reasoning_result preserves MCP attribution, comparison, and result text", async () => {
  calls.records.length = 0;
  calls.comparisons.length = 0;
  const response = await handleMcp(
    new Request("https://driftglass.invalid/mcp/test/ops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "record_reasoning_result",
          arguments: {
            receiptId: "receipt-mcp",
            provider: "claude",
            model: "subscription-claude",
            client: "driftglass-operations-mcp",
            response: "Bounded result",
            structuredResult: { summary: "Canonical" },
          },
        },
      }),
    }),
    { DRIFTGLASS_SECRET: "test-secret" },
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(calls.records.length, 1);
  assert.equal(calls.records[0].receiptId, "receipt-mcp");
  assert.equal(calls.records[0].provider, "claude");
  assert.equal(calls.records[0].model, "subscription-claude");
  assert.equal(calls.records[0].client, "driftglass-operations-mcp");
  assert.deepEqual(calls.comparisons, ["receipt-mcp"]);
  const body = await response.json();
  assert.equal(body.result.structuredContent.run.provider_label, "claude");
  assert.match(body.result.content[0].text, /Saved the claude answer/);
  assert.match(body.result.content[0].text, /No major difference needs review/);
});

test("one-step callers retain their bounded request contracts and never compose begin plus complete", async () => {
  const [api, mcp] = await Promise.all([
    readFile(new URL("../src/v09-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/mcp.ts", import.meta.url), "utf8"),
  ]);
  const apiStart = api.indexOf("const receiptResultMatch");
  const apiEnd = api.indexOf("const receiptCompareMatch", apiStart);
  const apiBlock = api.slice(apiStart, apiEnd);
  const mcpStart = mcp.indexOf('"record_reasoning_result"');
  const mcpEnd = mcp.indexOf('"review_reasoning_run"', mcpStart);
  const mcpBlock = mcp.slice(mcpStart, mcpEnd);

  for (const block of [apiBlock, mcpBlock]) {
    assert.match(block, /recordReasoningResult/);
    assert.match(block, /compareReasoningRuns/);
    assert.doesNotMatch(block, /beginReasoningRun|completeReasoningRun/);
  }
  assert.match(apiBlock, /readJson<Record<string, unknown>>\(request, 2_000_000\)/);
  assert.match(mcpBlock, /response: z\.string\(\)\.min\(1\)\.max\(120000\)/);
});
