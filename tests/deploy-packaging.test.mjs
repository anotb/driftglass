import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unstable_getVarsForDev } from "wrangler";

import {
  OPTIONAL_LOCAL_BINDINGS,
  buildLocalDevConfig,
  generatedConfigPath,
  runWranglerDev,
  validateDevArguments,
} from "../scripts/run-wrangler-dev.mjs";

const read = async (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

function dotenvKeys(source) {
  return String(source)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.slice(0, line.indexOf("=")))
    .filter(Boolean);
}

function minimumNodeVersion(range) {
  const match = String(range ?? "").match(/>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  assert.ok(match, `expected a minimum Node range, received ${JSON.stringify(range)}`);
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function prepareWrapperDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(directory, "node_modules", "wrangler", "bin"), { recursive: true });
  await writeFile(path.join(directory, "wrangler.jsonc"), await read("wrangler.jsonc"));
  return directory;
}

test("every deployment command preserves deploy, migration, and lifecycle order", async () => {
  const [packageRaw, deployButtonVars, localDevVars, deploySecrets, gitignore, npmignore] = await Promise.all([
    read("package.json"),
    read(".dev.vars.example"),
    read(".dev.vars.local.example"),
    read(".deploy-secrets.example"),
    read(".gitignore"),
    read(".npmignore"),
  ]);
  const pkg = JSON.parse(packageRaw);
  const lanes = [
    ["deploy", "wrangler deploy --env=\"\"", "db:migrate:remote", "r2:lifecycle"],
    ["deploy:first", "wrangler deploy --env=\"\"", "db:migrate:remote", "r2:lifecycle"],
    ["deploy:staging", "wrangler deploy --env staging", "db:migrate:staging", "r2:lifecycle:staging"],
    ["deploy:staging:first", "wrangler deploy --env staging", "db:migrate:staging", "r2:lifecycle:staging"],
  ];

  for (const [name, deploy, migration, lifecycle] of lanes) {
    const command = pkg.scripts[name];
    assert.ok(command.indexOf("npm run build") < command.indexOf(deploy), `${name}: build before deploy`);
    assert.ok(command.indexOf(deploy) < command.indexOf(migration), `${name}: deploy before migration`);
    assert.ok(command.indexOf(migration) < command.indexOf(lifecycle), `${name}: migration before lifecycle`);
  }

  for (const name of ["check:startup", "check:startup:staging"]) {
    const command = pkg.scripts[name];
    assert.match(command, /mkdirSync\('dist',\{recursive:true\}\)/, `${name}: creates its ignored output directory`);
    assert.ok(command.indexOf("mkdirSync") < command.indexOf("wrangler check startup"), `${name}: prepares output before Wrangler`);
  }

  assert.match(pkg.scripts["db:migrate:remote"], /d1 migrations apply DB /);
  assert.match(pkg.scripts["db:migrate:staging"], /d1 migrations apply DB /);
  assert.match(pkg.cloudflare.bindings.DRIFTGLASS_SECRET.description, /Required owner secret/);
  assert.match(pkg.cloudflare.bindings.GITHUB_TOKEN.description, /Optional/);
  assert.deepEqual(dotenvKeys(deployButtonVars), ["DRIFTGLASS_SECRET"], "Deploy button discovers only the owner secret");
  assert.deepEqual(
    dotenvKeys(localDevVars),
    ["DRIFTGLASS_SECRET", ...OPTIONAL_LOCAL_BINDINGS],
    "local development template includes the optional secret names",
  );
  assert.deepEqual(dotenvKeys(deploySecrets), ["DRIFTGLASS_SECRET"], "first CLI deploy has no optional-secret burden");
  assert.ok(gitignore.split(/\r?\n/).includes("!.dev.vars.local.example"), "local development example stays checked in");
  for (const localPath of [
    "/output/",
    "/.internal/",
    "/.playwright-cli/",
    "/.agents/",
    "/.wrangler.dev.*.jsonc",
  ]) {
    assert.ok(gitignore.split(/\r?\n/).includes(localPath), `${localPath} remains local-only`);
  }
  const privateHandoffIgnores = [
    "!handoff/baseline/v0.9.0-validation.log",
    "/handoff/evidence/ux-audit/",
  ].map((line) => gitignore.split(/\r?\n/).includes(line));
  assert.ok(
    privateHandoffIgnores.every(Boolean) || privateHandoffIgnores.every((present) => !present),
    "private-source handoff ignores are either complete or absent from the normalized public root",
  );
  assert.ok(
    npmignore.split(/\r?\n/).includes("/docs/assets/launch/"),
    "repository launch media stays out of the runtime npm package",
  );
});

test("one-click documentation includes the dedicated OAuth KV for each environment", async () => {
  const [configRaw, readme, deploy, install] = await Promise.all([
    read("wrangler.jsonc"),
    read("README.md"),
    read("docs/DEPLOY.md"),
    read("public/install.md"),
  ]);
  const config = JSON.parse(configRaw);
  for (const [label, target] of [
    ["production", config],
    ["staging", config.env.staging],
  ]) {
    assert.deepEqual(target.kv_namespaces, [{ binding: "OAUTH_KV" }], `${label} uses its own unpinned OAuth KV`);
  }
  assert.match(readme, /dedicated per-environment OAuth KV/);
  assert.match(deploy, /dedicated OAuth grant and token KV namespace for each environment/);
  assert.match(install, /dedicated OAuth KV namespace for that environment/);
});

test("Wrangler-backed packages require a compatible Node version", async () => {
  for (const [label, packageFile, lockFile] of [
    ["core", "package.json", "package-lock.json"],
    ["Computer Power Mode", "labs/deep-dive-lab/package.json", "labs/deep-dive-lab/package-lock.json"],
    ["Agent Memory bridge", "labs/agent-memory-bridge/package.json", "labs/agent-memory-bridge/package-lock.json"],
  ]) {
    const [packageRaw, lockRaw] = await Promise.all([read(packageFile), read(lockFile)]);
    const pkg = JSON.parse(packageRaw);
    const lock = JSON.parse(lockRaw);
    const lockedWrangler = lock.packages?.["node_modules/wrangler"];
    assert.deepEqual(lock.packages?.[""]?.engines, pkg.engines, `${label}: lock records the project Node floor`);
    assert.equal(lockedWrangler?.version, pkg.devDependencies.wrangler, `${label}: lock matches Wrangler pin`);
    assert.ok(
      compareVersions(minimumNodeVersion(pkg.engines?.node), minimumNodeVersion(lockedWrangler?.engines?.node)) >= 0,
      `${label}: project Node floor satisfies Wrangler`,
    );
  }

  const [companion, install, portable] = await Promise.all([
    read("driftglass-relay/package.json").then(JSON.parse),
    read("public/install.md"),
    read("docs/PORTABLE-RUNTIME.md"),
  ]);
  assert.equal(companion.engines.node, ">=20", "standalone Companion keeps its independent Node 20 floor");
  assert.match(install, /Node\.js 22 or newer/);
  assert.match(portable, /Cloudflare\/core package uses a Node\.js 22 baseline/);
});

test("Dependabot covers every independently locked npm package", async () => {
  const config = await read(".github/dependabot.yml");
  for (const directory of ["/", "/labs/deep-dive-lab", "/labs/agent-memory-bridge"]) {
    assert.match(config, new RegExp(`directory:\\s+${directory.replaceAll("/", "\\/")}($|\\s)`));
  }
});

test("social preview portability stays in the three-OS CI matrix", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const portable = workflow.slice(workflow.indexOf("  portable-persistence:"));
  assert.match(portable, /os: macos-latest/);
  assert.match(portable, /os: windows-latest/);
  assert.match(portable, /os: ubuntu-latest/);
  assert.match(portable, /npm run social-card:check/);
});

test("local dev loads optional values as secrets without weakening deployment", async () => {
  const [packageRaw, installedWranglerRaw] = await Promise.all([
    read("package.json"),
    read("node_modules/wrangler/package.json"),
  ]);
  const config = JSON.parse(await read("wrangler.jsonc"));
  const pkg = JSON.parse(packageRaw);
  const installedWrangler = JSON.parse(installedWranglerRaw);
  const generated = buildLocalDevConfig(config);

  assert.equal(installedWrangler.version, pkg.devDependencies.wrangler, "secret loading test uses the pinned Wrangler build");
  assert.deepEqual(config.secrets.required, ["DRIFTGLASS_SECRET"]);
  assert.deepEqual(generated.secrets.required, ["DRIFTGLASS_SECRET"]);
  assert.deepEqual(generated.env.staging.secrets.required, ["DRIFTGLASS_SECRET"]);
  const localConfigs = [
    ["top-level", config, generated],
    ...Object.entries(config.env ?? {}).map(([name, source]) => [name, source, generated.env[name]]),
  ];
  for (const [name, source, target] of localConfigs) {
    for (const binding of OPTIONAL_LOCAL_BINDINGS) {
      assert.equal(Object.hasOwn(source.vars, binding), false, `${name}.${binding} stays out of deploy config`);
      assert.equal(target.vars[binding], "");
    }
  }
  const checkedInEmpty = structuredClone(config);
  checkedInEmpty.vars.GITHUB_TOKEN = "";
  assert.throws(() => buildLocalDevConfig(checkedInEmpty), /GITHUB_TOKEN.*must not be a checked-in Worker variable/);
  assert.match(pkg.scripts.dev, /run-wrangler-dev\.mjs$/);
  assert.match(pkg.scripts["dev:remote"], /run-wrangler-dev\.mjs --remote$/);
  for (const name of ["deploy", "deploy:first", "deploy:staging", "deploy:staging:first"]) {
    assert.doesNotMatch(pkg.scripts[name], /run-wrangler-dev/);
  }

  const directory = await mkdtemp(path.join(tmpdir(), "driftglass-dev-vars-"));
  try {
    const sentinels = Object.fromEntries([
      ["DRIFTGLASS_SECRET", "owner-secret-sentinel"],
      ...OPTIONAL_LOCAL_BINDINGS.map((binding, index) => [binding, `optional-sentinel-${index}`]),
    ]);
    await writeFile(
      path.join(directory, ".dev.vars"),
      `${Object.entries(sentinels).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
      { mode: 0o600 },
    );
    const bindings = unstable_getVarsForDev(
      path.join(directory, "wrangler.jsonc"),
      undefined,
      generated.vars,
      undefined,
      true,
      generated.secrets,
    );
    for (const [binding, value] of Object.entries(sentinels)) {
      assert.deepEqual(bindings[binding], { type: "secret_text", value });
      assert.doesNotMatch(JSON.stringify(generated), new RegExp(value));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local dev wrapper rejects config overrides and cleans up after child exit", async () => {
  assert.throws(() => validateDevArguments(["--config", "other.jsonc"]), /owns the temporary --config/);
  assert.throws(() => validateDevArguments(["--config=other.jsonc"]), /owns the temporary --config/);
  assert.throws(() => validateDevArguments(["-c", "other.jsonc"]), /owns the temporary --config/);
  assert.throws(() => validateDevArguments(["-cother.jsonc"]), /owns the temporary --config/);

  const directory = await prepareWrapperDirectory("driftglass-dev-wrapper-");
  const temporaryConfigPath = generatedConfigPath(directory, 4242);
  const wranglerCliPath = path.join(directory, "node_modules", "wrangler", "bin", "wrangler.js");
  const secretSentinel = "must-not-enter-generated-config";
  await writeFile(path.join(directory, ".dev.vars"), `DRIFTGLASS_SECRET=${secretSentinel}\n`, { mode: 0o600 });

  const calls = [];
  let temporaryConfig;
  let temporaryMode;
  const fakeSpawn = (...spawnArgs) => {
    calls.push(spawnArgs);
    temporaryConfig = readFileSync(temporaryConfigPath, "utf8");
    temporaryMode = statSync(temporaryConfigPath).mode & 0o777;
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    queueMicrotask(() => {
      child.exitCode = 7;
      child.emit("exit", 7, null);
    });
    return child;
  };

  try {
    const result = await runWranglerDev({ args: ["--remote"], root: directory, pid: 4242, spawnImpl: fakeSpawn });
    assert.deepEqual(result, { code: 7, signal: null });
    assert.equal(calls.length, 1);
    const [executable, args, options] = calls[0];
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, [wranglerCliPath, "dev", "--config", temporaryConfigPath, "--remote"]);
    assert.equal(options.cwd, directory);
    assert.equal(options.env, process.env);
    assert.equal(options.shell, false);
    assert.equal(options.stdio, "inherit");
    assert.doesNotMatch(temporaryConfig, new RegExp(secretSentinel));
    const parsedTemporary = JSON.parse(temporaryConfig);
    for (const target of [parsedTemporary, parsedTemporary.env.staging]) {
      for (const binding of OPTIONAL_LOCAL_BINDINGS) assert.equal(target.vars[binding], "");
    }
    if (process.platform !== "win32") assert.equal(temporaryMode, 0o600);
    await assert.rejects(stat(temporaryConfigPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local dev wrapper cleans up when Wrangler cannot start", async () => {
  const directory = await prepareWrapperDirectory("driftglass-dev-spawn-error-");
  const temporaryConfigPath = generatedConfigPath(directory, 4244);
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" })));
    return child;
  };

  try {
    await assert.rejects(runWranglerDev({ root: directory, pid: 4244, spawnImpl: fakeSpawn }), /spawn failed/);
    await assert.rejects(stat(temporaryConfigPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local dev wrapper refuses a stale generated config", async () => {
  const directory = await prepareWrapperDirectory("driftglass-dev-stale-");
  const temporaryConfigPath = generatedConfigPath(directory, 4245);
  let spawned = false;
  await writeFile(temporaryConfigPath, "stale", { mode: 0o600 });

  try {
    await assert.rejects(
      runWranglerDev({ root: directory, pid: 4245, spawnImpl: () => { spawned = true; } }),
      { code: "EEXIST" },
    );
    assert.equal(spawned, false);
    assert.equal(await readFile(temporaryConfigPath, "utf8"), "stale");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local dev wrapper refuses a generated-config symlink", { skip: process.platform === "win32" }, async () => {
  const directory = await prepareWrapperDirectory("driftglass-dev-symlink-");
  const temporaryConfigPath = generatedConfigPath(directory, 4246);
  const targetPath = path.join(directory, "outside.jsonc");
  await writeFile(targetPath, "keep", { mode: 0o600 });
  await symlink(targetPath, temporaryConfigPath);

  try {
    await assert.rejects(runWranglerDev({ root: directory, pid: 4246, spawnImpl: () => assert.fail("must not spawn") }), {
      code: "EEXIST",
    });
    assert.equal(await readFile(targetPath, "utf8"), "keep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local dev wrapper forwards termination and still removes its config", async () => {
  const directory = await prepareWrapperDirectory("driftglass-dev-signal-");

  const processRef = new EventEmitter();
  processRef.execPath = process.execPath;
  processRef.env = {};
  const forwarded = [];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      forwarded.push(signal);
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    };
    queueMicrotask(() => processRef.emit("SIGTERM"));
    return child;
  };

  try {
    const result = await runWranglerDev({ root: directory, pid: 4243, spawnImpl: fakeSpawn, processRef });
    assert.deepEqual(forwarded, ["SIGTERM"]);
    assert.deepEqual(result, { code: null, signal: "SIGTERM" });
    await assert.rejects(stat(generatedConfigPath(directory, 4243)), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one-click resources remain deterministic, unpinned, and failure-bounded", async () => {
  const config = JSON.parse(await read("wrangler.jsonc"));

  for (const [label, target, prefix] of [
    ["production", config, "driftglass"],
    ["staging", config.env.staging, "driftglass-staging"],
  ]) {
    assert.equal(target.d1_databases[0].binding, "DB", label);
    assert.equal(target.d1_databases[0].database_id, undefined, label);
    assert.equal(target.r2_buckets[0].binding, "EVIDENCE", label);
    assert.equal(target.r2_buckets[0].bucket_name, `${prefix}-evidence`, label);
    assert.equal(target.queues.producers.length, 3, label);
    assert.equal(target.queues.consumers.length, 3, label);

    const primary = target.queues.consumers.find((consumer) => consumer.queue === `${prefix}-ingest`);
    const deadLetter = target.queues.consumers.find((consumer) => consumer.queue === `${prefix}-ingest-dlq`);
    const quarantine = target.queues.consumers.find((consumer) => consumer.queue === `${prefix}-ingest-quarantine`);
    assert.equal(primary?.dead_letter_queue, `${prefix}-ingest-dlq`, label);
    assert.equal(primary?.max_retries, 3, label);
    assert.equal(deadLetter?.dead_letter_queue, `${prefix}-ingest-quarantine`, label);
    assert.equal(deadLetter?.max_retries, 3, label);
    assert.equal(quarantine?.max_retries, 20, label);
    assert.equal(quarantine?.retry_delay, 3_600, label);
    assert.equal(quarantine?.dead_letter_queue, undefined, label);
    assert.deepEqual(target.secrets.required, ["DRIFTGLASS_SECRET"], label);
  }
});

test("release docs distinguish prerequisites, automatic provisioning, and optional setup", async () => {
  const [readme, deploy, install, validation, roadmap] = await Promise.all([
    read("README.md"),
    read("docs/DEPLOY.md"),
    read("public/install.md"),
    read("docs/VALIDATION.md"),
    read("docs/ROADMAP.md"),
  ]);

  assert.doesNotMatch(readme, /deploy\.workers\.cloudflare\.com/, "the one-click path stays inactive until its clean-account check passes");
  assert.match(readme, /Activate R2 in the target Cloudflare account, then install Git and Node\.js 22 or newer/);
  assert.match(readme, /^## Quick start$/m);
  assert.match(readme, /git clone https:\/\/github\.com\/anotb\/driftglass\.git/);
  assert.match(readme, /source-checkout preview requires Git and Node\.js 24\.4 or newer/);
  assert.doesNotMatch(readme, /repository is private|clean-account installation/);
  assert.doesNotMatch(deploy, /deploy\.workers\.cloudflare\.com|public GitHub or GitLab repository/);
  assert.match(deploy, /R2 requires a one-time subscription and billing acknowledgement/);
  assert.match(deploy, /No Workers Paid subscription is required/);
  assert.match(deploy, /Install Git and Node\.js 22 or newer/);
  assert.match(deploy, /git clone https:\/\/github\.com\/anotb\/driftglass\.git/);
  assert.match(deploy, /Run `npm run types`/);
  assert.match(deploy, /## Free and Cheap profiles/);
  assert.doesNotMatch(deploy, /older long placeholder|Run `wrangler types`|Cheap posture/);
  assert.match(deploy, /primary Queue \(up to 3 configured retries\)[\s\S]*DLQ consumer[\s\S]*bounded quarantine recovery consumer/);
  assert.match(deploy, /Email Routing:[\s\S]*optional/);
  assert.match(deploy, /Use Driftglass's `npm run deploy:first` and `npm run deploy` commands/);
  assert.match(deploy, /cp \.dev\.vars\.local\.example \.dev\.vars/);
  assert.doesNotMatch(deploy, /cp \.dev\.vars\.example \.dev\.vars/);

  assert.doesNotMatch(install, /deploy\.workers\.cloudflare\.com|GitHub or GitLab sign-in/);
  assert.match(install, /Cloudflare account[\s\S]*Sign in with Wrangler before deploying/);
  assert.match(install, /R2 includes a monthly free allowance/);
  assert.match(install, /private recovery copy[\s\S]*retry or dismiss/);
  assert.match(install, /isolated, non-indexed staging installation/);
  assert.match(install, /local persistence implementation requires Git and Node\.js 24\.4 or newer/);
  assert.ok((install.match(/git clone https:\/\/github\.com\/anotb\/driftglass\.git/g) || []).length >= 2);
  assert.doesNotMatch(install, /For a private installation/);
  for (const path of ["DEPLOY", "PORTABLE-RUNTIME", "BUDGET-GOVERNOR"]) {
    assert.match(install, new RegExp(`https://github\\.com/anotb/driftglass/blob/main/docs/${path}\\.md`));
  }
  assert.match(validation, /npm run check:deploy/);
  assert.match(validation, /Clean-account Cloudflare deploy[\s\S]*Pending, not run/);
  assert.match(validation, /compact MCP contract covers 17 read-only research tools/);
  assert.match(validation, /Clean-account Cloudflare deploy[\s\S]*Pending, not run/);
  assert.match(validation, /dry runs validate builds only[\s\S]*clean-account deployment remains pending/);
  assert.doesNotMatch(validation, /statement-counter|activation checklist|feature acceptance matrix/i);
  assert.match(roadmap, /Public collection, Mission state, connected memory, and prepared reasoning stay in the cloud core/);
  assert.doesNotMatch(roadmap, /remains sufficient on its own/);
});
