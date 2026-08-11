import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("local stdio MCP bridge preserves JSON-RPC framing and keeps the capability out of output", async (t) => {
  const { deriveMcpCapabilityKeys } = require("../.test-dist/security.js");
  const ownerSecret = "stdio-regression-owner-secret-000000000000000000000000";
  const keys = await deriveMcpCapabilityKeys(ownerSecret);
  const observedPaths = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, profile: "selfhost", schemaVersion: 22 }));
      return;
    }
    observedPaths.push(request.url);
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const bridgeModule = `${repositoryRoot}.test-dist/runtime/node/stdio-mcp-bridge.js`;
  const script = `const bridge=require(process.argv[1]);bridge.runLocalStdioMcpBridge({origin:process.argv[2],access:"read",authority:{ownerSecret:${JSON.stringify(ownerSecret)}}}).catch(error=>{process.stderr.write(String(error));process.exitCode=1})`;
  const child = spawn(process.execPath, ["-e", script, bridgeModule, `http://127.0.0.1:${address.port}`], {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const output = [];
  const line = new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.once("line", (value) => {
      output.push(value);
      resolve(JSON.parse(value));
    });
    lines.once("error", reject);
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  })}\n`);
  const response = await line;
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2025-11-25");
  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(observedPaths, [`/mcp/${keys.readKey}`]);
  assert.equal(output.join("\n").includes(keys.readKey), false);
  assert.equal(stderr.includes(keys.readKey), false);
  assert.throws(
    () => require("../.test-dist/runtime/node/stdio-mcp-bridge.js").normalizeLocalMcpOrigin("https://example.com"),
    /loopback HTTP origin/,
  );
});
