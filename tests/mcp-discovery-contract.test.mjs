import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const ts = require("typescript");

async function registrations(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tools = [];

  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "registerTool"
    ) {
      const [name, options] = node.arguments;
      if (name && ts.isStringLiteral(name)) {
        let write = false;
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
              ? property.name.text
              : "";
            if (propertyName === "annotations") {
              write = ts.isCallExpression(property.initializer)
                && ts.isIdentifier(property.initializer.expression)
                && property.initializer.expression.text === "writeAnnotations";
            }
          }
        }
        tools.push({ name: name.text, write });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, `${path} has duplicate tool registrations`);
  return tools;
}

test("public MCP discovery exactly matches registered reasoning, operations, and write tools", async () => {
  const [reasoning, operations, mcpRaw, driftglassRaw] = await Promise.all([
    registrations("src/reasoning-mcp.ts"),
    registrations("src/mcp.ts"),
    readFile(new URL("../public/.well-known/mcp.json", import.meta.url), "utf8"),
    readFile(new URL("../public/.well-known/driftglass.json", import.meta.url), "utf8"),
  ]);
  const mcp = JSON.parse(mcpRaw);
  const driftglass = JSON.parse(driftglassRaw);
  const reasoningNames = reasoning.map((tool) => tool.name);
  const operationNames = operations.map((tool) => tool.name);
  const writeNames = operations.filter((tool) => tool.write).map((tool) => tool.name);

  assert.deepEqual(mcp.tools, reasoningNames);
  assert.deepEqual(mcp.profiles.reasoning.tools, reasoningNames);
  assert.deepEqual(driftglass.mcp.reasoning.tools, reasoningNames);
  assert.deepEqual(mcp.profiles.operations.tools, operationNames);
  assert.deepEqual(driftglass.mcp.operations.tools, operationNames);
  assert.deepEqual(mcp.write_tools, writeNames);
  assert.equal(mcp.tools.length, 17);
  assert.ok(driftglass.optional.includes("Driftglass Companion for local Mission Computer mirroring"));
  assert.ok(driftglass.optional.includes("OpenCLI Browser Bridge for optional signed-in browser sources"));
  assert.equal(driftglass.optional.some((entry) => entry.includes("OpenCLI Companion")), false);
  assert.deepEqual(driftglass.mcp.ui, [
    "ui://driftglass/briefing-v2.html",
    "ui://driftglass/editorial-brief-v9.html",
    "ui://driftglass/editorial-brief-v8.html",
  ]);
});

test("public descriptions and connection policy stay concise and consistent", async () => {
  const [mcpRaw, agentRaw, packageRaw, openapiRaw, html, validation, innovation] = await Promise.all([
    readFile(new URL("../public/.well-known/mcp.json", import.meta.url), "utf8"),
    readFile(new URL("../public/.well-known/agent.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../public/openapi.json", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../docs/VALIDATION.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/INNOVATION-AUDIT.md", import.meta.url), "utf8"),
  ]);
  const mcp = JSON.parse(mcpRaw);
  const agent = JSON.parse(agentRaw);
  const pkg = JSON.parse(packageRaw);
  const openapi = JSON.parse(openapiRaw);
  const productDescription = "Personal intelligence for standing questions: chosen sources become developing Stories, current cited answers, connected memory, decisions, forecasts, Intelligence Packs, and one workspace per Mission.";
  const connectionPolicy = "Use Research for Today, Missions, Stories, sources, and memory. Connect Allow updates when the user wants to save an answer, decision, Pack change, Computer note, or memory proposal.";

  assert.equal(pkg.description, productDescription);
  assert.equal(openapi.info.description, productDescription);
  assert.equal(agent.description, productDescription);
  assert.equal(mcp.description, "Read Driftglass Today, answer standing Research Missions from cited sources, inspect connected memory, and prepare work for the reasoning model you choose.");
  assert.equal(mcp.reasoning_policy, connectionPolicy);
  assert.equal(agent.interface_policy, connectionPolicy);
  assert.equal(mcp.profiles.reasoning.purpose, "Read Today, Missions, Stories, sources, and connected memory.");
  assert.equal(mcp.profiles.operations.purpose, "Save answers, decisions, Mission updates, Pack changes, Computer notes, and memory proposals.");
  assert.ok(agent.skills.includes("record decisions, forecasts, reviews, outcomes, and calibration"));
  assert.ok(agent.skills.includes("apply Pack updates over local overlays and surface conflicts for a choice"));
  assert.match(html, /<meta name="description" content="Follow chosen sources and keep a current cited answer to questions that outlive the news cycle\." \/>/);

  assert.match(validation, /17 read-only research tools/);
  assert.doesNotMatch(validation, /sixteen research tools/);
  assert.match(innovation, /Workers Analytics \| Aggregate request and CPU metrics plus content-free readiness and component telemetry/);
  assert.doesNotMatch(innovation, /Workers traces|Platform traces plus custom/);
});

test("compact agent guidance keeps contrary analysis conditional", async () => {
  const guide = await readFile(new URL("../public/llms.txt", import.meta.url), "utf8");
  assert.match(guide, /Include a contrary case or watch signal only when it adds information/);
  assert.doesNotMatch(guide, /include the strongest plausible alternative case, and name observable signals/);
});
