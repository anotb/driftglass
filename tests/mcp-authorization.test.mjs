import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const {
  authorizeMcpPath,
  deriveMcpCapabilityKeys,
  deriveOperationsKey,
  deriveReadKey,
} = require("../.test-dist/security.js");
const { toErrorResponse } = require("../.test-dist/utils.js");

const SECRET = "owner-secret-longer-than-twenty-four-characters-for-mcp-tests";

async function denial(pathname) {
  try {
    await authorizeMcpPath(pathname, SECRET);
  } catch (error) {
    return error;
  }
  assert.fail(`Expected ${pathname} to be denied`);
}

test("MCP reasoning and operations capabilities are deterministic and independently derived", async () => {
  const keys = await deriveMcpCapabilityKeys(SECRET);
  assert.equal(keys.readKey, await deriveReadKey(SECRET));
  assert.equal(keys.operationsKey, await deriveOperationsKey(SECRET));
  assert.match(keys.readKey, /^[0-9a-f]{40}$/);
  assert.match(keys.operationsKey, /^[0-9a-f]{40}$/);
  assert.notEqual(keys.readKey, keys.operationsKey);

  assert.equal(await authorizeMcpPath(`/mcp/${keys.readKey}`, SECRET), "reasoning");
  assert.equal(await authorizeMcpPath(`/mcp/${keys.readKey}/`, SECRET), "reasoning");
  assert.equal(await authorizeMcpPath(`/mcp/${keys.operationsKey}/ops`, SECRET), "operations");
  assert.equal(await authorizeMcpPath(`/mcp/${keys.operationsKey}/ops/`, SECRET), "operations");
  assert.equal(await authorizeMcpPath("/mcp", SECRET), null);
});

test("MCP capabilities cannot cross profiles and denials disclose no capability material", async () => {
  const keys = await deriveMcpCapabilityKeys(SECRET);
  const attempts = [
    `/mcp/${keys.readKey}/ops`,
    `/mcp/${keys.operationsKey}`,
    "/mcp/not-a-capability",
    "/mcp/not-a-capability/ops",
  ];

  for (const pathname of attempts) {
    const error = await denial(pathname);
    assert.equal(error.status, 404);
    assert.equal(error.message, "Not found");
    const response = toErrorResponse(error);
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.equal(body, JSON.stringify({ ok: false, error: "Not found" }, null, 2));
    for (const sensitive of [SECRET, keys.readKey, keys.operationsKey, pathname]) {
      assert.equal(body.includes(sensitive), false);
      assert.equal(error.message.includes(sensitive), false);
    }
  }
});

test("public MCP discovery uses scoped placeholders and never embeds derived keys", async () => {
  const keys = await deriveMcpCapabilityKeys(SECRET);
  const files = [
    "public/.well-known/agent.json",
    "public/.well-known/driftglass.json",
    "public/.well-known/mcp.json",
    "public/openapi.json",
    "public/llms.txt",
    "public/llms-full.txt",
  ];
  const documents = await Promise.all(files.map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")));
  const combined = documents.join("\n");
  assert.match(combined, /private-operations-key|operationsKey/);
  assert.doesNotMatch(combined, /\/mcp\/\{private-read-key\}\/ops|\/mcp\/\{readKey\}\/ops/);
  for (const sensitive of [SECRET, keys.readKey, keys.operationsKey]) assert.equal(combined.includes(sensitive), false);
});

test("deployment telemetry cannot retain capability-bearing request URLs", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  for (const observability of [config.observability, config.env.staging.observability]) {
    assert.equal(observability.enabled, false);
    assert.equal(observability.logs.enabled, false);
    assert.equal(observability.logs.invocation_logs, false);
    assert.equal(observability.traces.enabled, false);
  }
});

test("owner integration and readiness URL producers use the operations capability", async () => {
  const files = ["src/api.ts", "src/intelligence-api.ts", "src/readiness.ts", "src/reasoning.ts"];
  const documents = await Promise.all(files.map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")));
  const combined = documents.join("\n");
  assert.match(combined, /operationsKey/);
  assert.doesNotMatch(combined, /\$\{readKey\}\/ops|\$\{mcpUrl\}\/ops/);
  for (const document of documents.slice(0, 3)) assert.match(document, /operationsKey/);
});

test("compact reasoning paths cannot opt into exporting the operations capability implicitly", async () => {
  const [reasoning, compactMcp, operationsMcp, ledger, intelligenceApi] = await Promise.all([
    readFile(new URL("../src/reasoning.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/reasoning-mcp.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/mcp.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/reasoning-ledger.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/intelligence-api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(reasoning, /security\.includeOperationsCapability/);
  assert.doesNotMatch(compactMcp, /includeOperationsCapability/);
  assert.doesNotMatch(operationsMcp, /includeOperationsCapability/);
  assert.doesNotMatch(ledger, /includeOperationsCapability/);
  assert.match(
    intelligenceApi,
    /reasoning\/interface-kit\.zip[\s\S]*buildReasoningBundle\([^;]+includeOperationsCapability: body\.includeOperations === true/,
  );
  assert.doesNotMatch(intelligenceApi, /includeOperationsCapability: true/);
});
