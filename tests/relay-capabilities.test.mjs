import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const capabilitySource = await readFile(new URL("../src/relay-capabilities.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(capabilitySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const capabilityModule = { exports: {} };
new Function("exports", "module", compiled)(capabilityModule.exports, capabilityModule);

const {
  missingRelayCapabilityArgs,
  relayCapability,
  relayCapabilityArgsError,
} = capabilityModule.exports;

test("LinkedIn jobs advertises and enforces query as a required cloud capability argument", () => {
  const descriptor = relayCapability("linkedin.jobs");
  assert.deepEqual(descriptor.requiredArgs, ["query"]);
  assert.equal(descriptor.optionalArgs.includes("query"), false);

  assert.deepEqual(missingRelayCapabilityArgs("linkedin.jobs", undefined), ["query"]);
  assert.deepEqual(missingRelayCapabilityArgs("linkedin.jobs", {}), ["query"]);
  assert.deepEqual(missingRelayCapabilityArgs("linkedin.jobs", { query: "   " }), ["query"]);
  assert.deepEqual(missingRelayCapabilityArgs("linkedin.jobs", { query: "platform engineer" }), []);
  assert.equal(
    relayCapabilityArgsError("linkedin.jobs", { limit: 20 }, "config.args"),
    "linkedin.jobs requires config.args.query",
  );
});

test("dashboard source creation and runtime collection validate required args before writes", async () => {
  const [apiSource, registrySource] = await Promise.all([
    readFile(new URL("../src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/sources/registry.ts", import.meta.url), "utf8"),
  ]);

  const sourceParser = apiSource.indexOf("function sourceFromBody");
  const sourceValidation = apiSource.indexOf("relayCapabilityArgsError(operation, config.args", sourceParser);
  const sourceReturn = apiSource.indexOf("\n  return {", sourceParser);
  assert.ok(sourceParser >= 0 && sourceValidation > sourceParser && sourceValidation < sourceReturn);

  const collectorCase = registrySource.indexOf('case "collector"');
  const runtimeValidation = registrySource.indexOf("relayCapabilityArgsError(operation, config.args", collectorCase);
  const enqueue = registrySource.indexOf("queueCollectorJob(env.DB", collectorCase);
  assert.ok(collectorCase >= 0 && runtimeValidation > collectorCase && runtimeValidation < enqueue);
});

test("the generic validator preserves other required-argument capability contracts", () => {
  assert.equal(
    relayCapabilityArgsError("opencli.read", {}, "config.args"),
    "opencli.read requires config.args.site and config.args.command",
  );
  assert.equal(relayCapabilityArgsError("linkedin.timeline", {}, "config.args"), null);
});
