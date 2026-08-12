import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const compiledRoot = process.env.DRIFTGLASS_TEST_DIST;
const {
  DRIFTGLASS_ANSWER_MISSION_OPENAI_YAML,
  DRIFTGLASS_ANSWER_MISSION_SKILL,
  DRIFTGLASS_PLUGIN_BASE_MANIFEST,
  driftglassPluginAppManifest,
  driftglassPluginManifest,
  driftglassPluginZip,
  parseDriftglassPluginAppId,
} = compiledRoot
  ? require(`${compiledRoot}/driftglass-plugin.js`)
  : require("../.test-dist/driftglass-plugin.js");
const { driftglassPluginDownloadResponse } = compiledRoot
  ? require(`${compiledRoot}/driftglass-plugin-api.js`)
  : require("../.test-dist/driftglass-plugin-api.js");

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const APP_ID = "plugin_asdk_app_0123456789abcdef0123456789abcdef";
const OWNER_SECRET = "owner-secret-longer-than-twenty-four-characters-for-plugin-tests";

async function extractedPluginZip() {
  const directory = await mkdtemp(join(tmpdir(), "driftglass-plugin-"));
  const zipPath = join(directory, "driftglass-plugin.zip");
  const output = join(directory, "output");
  await writeFile(zipPath, driftglassPluginZip(APP_ID));
  await execFileAsync("unzip", ["-qq", zipPath, "-d", output]);
  return {
    directory,
    output,
    read: (path) => readFile(join(output, path), "utf8"),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

function pluginRequest(body, authorization = OWNER_SECRET) {
  return new Request("https://driftglass.example/api/reasoning/chatgpt-plugin.zip", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("technical app IDs use the exact ChatGPT connection ID shape", () => {
  assert.equal(parseDriftglassPluginAppId(APP_ID), APP_ID);
  for (const invalid of [
    undefined,
    null,
    "",
    ` ${APP_ID}`,
    `${APP_ID} `,
    APP_ID.toUpperCase(),
    "plugin_asdk_app_0123456789abcdef",
    "plugin_asdk_app_0123456789abcdef0123456789abcdeg",
    "plugin_asdk_app-0123456789abcdef0123456789abcdef",
    `https://chatgpt.com/plugins/${APP_ID}`,
  ]) {
    assert.throws(() => parseDriftglassPluginAppId(invalid), /technical app ID/);
  }
});

test("the checked-in plugin is a validator-clean universal base", async () => {
  const [manifestRaw, skill, openaiYaml] = await Promise.all([
    readFile(new URL("plugins/driftglass/.codex-plugin/plugin.json", root), "utf8"),
    readFile(new URL("plugins/driftglass/skills/answer-mission/SKILL.md", root), "utf8"),
    readFile(new URL("plugins/driftglass/skills/answer-mission/agents/openai.yaml", root), "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw);
  assert.deepEqual(manifest, DRIFTGLASS_PLUGIN_BASE_MANIFEST);
  assert.equal(skill, DRIFTGLASS_ANSWER_MISSION_SKILL);
  assert.equal(openaiYaml, DRIFTGLASS_ANSWER_MISSION_OPENAI_YAML);
  assert.equal(manifest.apps, undefined);
  assert.doesNotMatch(`${manifestRaw}\n${skill}\n${openaiYaml}`, /plugin_asdk_app_/);
  await assert.rejects(readFile(new URL("plugins/driftglass/.app.json", root)), { code: "ENOENT" });
});

test("the personalized ZIP is a complete local marketplace with an exact app mapping", async () => {
  const archive = await extractedPluginZip();
  try {
    const { stdout: inventory } = await execFileAsync("unzip", ["-Z1", join(archive.directory, "driftglass-plugin.zip")]);
    assert.deepEqual(inventory.trim().split("\n"), [
      "driftglass-plugin/README.md",
      "driftglass-plugin/.agents/plugins/marketplace.json",
      "driftglass-plugin/plugins/driftglass/.codex-plugin/plugin.json",
      "driftglass-plugin/plugins/driftglass/.app.json",
      "driftglass-plugin/plugins/driftglass/skills/answer-mission/SKILL.md",
      "driftglass-plugin/plugins/driftglass/skills/answer-mission/agents/openai.yaml",
    ]);

    const [readme, marketplaceRaw, manifestRaw, appRaw, skill, openaiYaml] = await Promise.all([
      archive.read("driftglass-plugin/README.md"),
      archive.read("driftglass-plugin/.agents/plugins/marketplace.json"),
      archive.read("driftglass-plugin/plugins/driftglass/.codex-plugin/plugin.json"),
      archive.read("driftglass-plugin/plugins/driftglass/.app.json"),
      archive.read("driftglass-plugin/plugins/driftglass/skills/answer-mission/SKILL.md"),
      archive.read("driftglass-plugin/plugins/driftglass/skills/answer-mission/agents/openai.yaml"),
    ]);
    const marketplace = JSON.parse(marketplaceRaw);
    const manifest = JSON.parse(manifestRaw);
    const app = JSON.parse(appRaw);
    assert.deepEqual(app, { apps: { driftglass: { id: "asdk_app_0123456789abcdef0123456789abcdef" } } });
    assert.deepEqual(app, driftglassPluginAppManifest(APP_ID));
    assert.deepEqual(manifest, driftglassPluginManifest(APP_ID));
    assert.equal(manifest.apps, "./.app.json");
    assert.equal(manifest.version, "0.9.0+codex.456789abcdef");
    assert.equal(marketplace.plugins[0].source.path, "./plugins/driftglass");
    assert.match(readme, /ChatGPT desktop or Codex CLI/);
    assert.match(readme, /codex plugin add driftglass@driftglass-local/);
    assert.match(readme, /local source/);
    assert.doesNotMatch(readme, /select \*\*\+\*\*/);
    assert.match(readme, /website alone cannot open a downloaded plugin folder/);
    assert.match(readme, /does not route it through another service/);
    assert.match(skill, /brief_today/);
    assert.match(skill, /brief_mission/);
    assert.match(skill, /## Today overview/);
    assert.match(skill, /## Active Mission answer/);
    assert.match(skill, /Answer the user's question with the information that changes the answer/);
    assert.match(skill, /Default to `answerMode: synthesis`/);
    assert.match(skill, /required cited `thesis`/);
    assert.match(skill, /stop when the question is answered; do not pad/i);
    assert.match(skill, /one to four `keyJudgments`/);
    assert.match(skill, /zero to two `watchFor` signals/);
    assert.match(skill, /each extra block adds a distinct fact, mechanism, implication, or falsifier/);
    assert.match(skill, /Omit every extra block that does not add one/);
    assert.match(skill, /Call `present_brief` exactly once/);
    assert.match(skill, /every section one to three exact `sources\[\]\.url` values in its `citationUrls`/);
    assert.match(skill, /exactly the requested `decision` rows/);
    assert.match(skill, /bounded `testNow` with comparison and sample or timebox/);
    assert.match(skill, /observable `deferUntil` condition/);
    assert.match(skill, /measurable `rollbackIf` threshold/);
    assert.match(skill, /generic recommendation gets only the single most relevant row/);
    assert.match(skill, /ChatGPT judgment anchored by cited evidence/);
    assert.match(skill, /Do not add synthesis fields or `watchNext` in decision mode/);
    assert.match(skill, /Prefer dates, quantities, mechanisms, and consequences to adjectives or stacked qualifiers/);
    assert.match(skill, /never reuse saved-answer wording as source proof/);
    assert.match(skill, /stop without prose after the card/);
    assert.match(skill, /without calling `present_brief`/);
    assert.match(skill, /## Connected personal sources/);
    assert.match(skill, /prepare_personal_context/);
    assert.match(skill, /Reddit, X, email, subscriptions/);
    assert.match(skill, /only when the user explicitly asks/);
    assert.match(skill, /remove phrases such as “include Reddit and X,” “what changed,” and “what should I watch.”/);
    assert.match(skill, /with only that phrase as `query`/);
    assert.match(skill, /full original request as `objective`/);
    assert.match(openaiYaml, /value: "driftglass"/);

    const compact = `${readme}\n${marketplaceRaw}\n${manifestRaw}\n${appRaw}\n${skill}\n${openaiYaml}`;
    assert.doesNotMatch(compact, /https?:\/\//i);
    assert.doesNotMatch(compact, /\/mcp(?:\/|\b)/i);
    assert.doesNotMatch(compact, /(?:workers\.dev|localhost|YOUR-[A-Z-]+|capability)/i);
    assert.doesNotMatch(appRaw, /plugin_asdk_app_/);
  } finally {
    await archive.close();
  }
});

test("a recreated ChatGPT connection gets a new deterministic plugin cachebuster", () => {
  const otherId = "plugin_asdk_app_fedcba9876543210fedcba9876543210";
  const first = driftglassPluginManifest(APP_ID).version;
  const repeated = driftglassPluginManifest(APP_ID).version;
  const rebound = driftglassPluginManifest(otherId).version;
  assert.equal(first, repeated);
  assert.notEqual(first, rebound);
  assert.match(first, /^0\.9\.0\+codex\.[0-9a-f]{12}$/);
  assert.match(rebound, /^0\.9\.0\+codex\.[0-9a-f]{12}$/);
  assert.equal(String(first).split("+codex.").length, 2);
});

test("the plugin download endpoint requires owner auth and accepts only appId", async () => {
  await assert.rejects(
    driftglassPluginDownloadResponse(pluginRequest({ appId: APP_ID }, ""), OWNER_SECRET),
    (error) => error?.status === 401,
  );
  for (const body of [
    {},
    { appId: APP_ID, extra: true },
    { appId: "plugin_asdk_app_not-an-id" },
  ]) {
    await assert.rejects(
      driftglassPluginDownloadResponse(pluginRequest(body), OWNER_SECRET),
      (error) => error?.status === 400,
    );
  }

  const response = await driftglassPluginDownloadResponse(pluginRequest({ appId: APP_ID }), OWNER_SECRET);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="driftglass-plugin.zip"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), driftglassPluginZip(APP_ID));
});

test("dashboard and OpenAPI expose one bounded personalized-plugin request", async () => {
  const [app, openapiRaw, intelligenceApi] = await Promise.all([
    readFile(new URL("public/app.js", root), "utf8"),
    readFile(new URL("public/openapi.json", root), "utf8"),
    readFile(new URL("src/intelligence-api.ts", root), "utf8"),
  ]);
  assert.match(app, /Technical app ID/);
  assert.match(app, /pattern="plugin_asdk_app_\[0-9a-f\]\{32\}"/);
  assert.match(app, /Download Driftglass plugin/);
  assert.match(app, /JSON\.stringify\(\{ appId: input\.value \}\)/);
  assert.match(intelligenceApi, /path === "\/api\/reasoning\/chatgpt-plugin\.zip"/);

  const operation = JSON.parse(openapiRaw).paths["/api/reasoning/chatgpt-plugin.zip"].post;
  assert.deepEqual(operation.security, [{ ownerSecret: [] }]);
  const schema = operation.requestBody.content["application/json"].schema;
  assert.deepEqual(schema.required, ["appId"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), ["appId"]);
  assert.equal(schema.properties.appId.pattern, "^plugin_asdk_app_[0-9a-f]{32}$");
  assert.ok(operation.responses["200"].content["application/zip"]);
});
