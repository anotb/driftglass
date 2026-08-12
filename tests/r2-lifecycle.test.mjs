import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LIFECYCLE_PREFIX,
  LIFECYCLE_RULE_ID,
  configureR2Lifecycle,
  expectedLifecycleRule,
  inspectLifecycleRules,
  lifecycleTarget,
  parseArguments,
  parseJsonc,
  parseLifecycleListOutput,
  runLocalWrangler,
} from "../scripts/configure-r2-lifecycle.mjs";

function configFixture({ defaultDays = "30", stagingDays = "45" } = {}) {
  return {
    r2_buckets: [{ binding: "EVIDENCE", bucket_name: "default-evidence" }],
    vars: { RAW_PUBLIC_RETENTION_DAYS: defaultDays },
    env: {
      staging: {
        r2_buckets: [{ binding: "EVIDENCE", bucket_name: "staging-evidence" }],
        vars: { RAW_PUBLIC_RETENTION_DAYS: stagingDays },
      },
    },
  };
}

function listOutput(bucket, rules) {
  if (rules.length === 0) {
    return `Listing lifecycle rules for bucket '${bucket}'...\r\nThere are no lifecycle rules for bucket '${bucket}'.\r\n`;
  }
  return `Listing lifecycle rules for bucket '${bucket}'...\n${rules.map((rule) => [
    `name:     ${rule.name}`,
    `enabled:  ${rule.enabled}`,
    `prefix:   ${rule.prefix}`,
    `action:   ${rule.action}`,
  ].join("\n")).join("\n\n")}\n`;
}

async function withConfig(config, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "driftglass-r2-lifecycle-"));
  try {
    await writeFile(path.join(directory, "wrangler.jsonc"), JSON.stringify(config, null, 2));
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("JSONC parsing preserves comment-like strings and accepts comments and trailing commas", () => {
  const parsed = parseJsonc(`{
    // Wrangler permits JSONC.
    "url": "https://example.com/a//b",
    "r2_buckets": [
      { "binding": "EVIDENCE", "bucket_name": "evidence" },
    ],
    /* Keep retention explicit. */
    "vars": { "RAW_PUBLIC_RETENTION_DAYS": "30", },
  }`);
  assert.equal(parsed.url, "https://example.com/a//b");
  assert.deepEqual(lifecycleTarget(parsed), { bucket: "evidence", days: 30 });
});

test("lifecycle list parser recognizes Wrangler labels and strips terminal color", () => {
  const output = listOutput("evidence", [
    expectedLifecycleRule(30),
    { name: "user-archive", enabled: "Yes", prefix: "archive/", action: "Expire objects after 365 days" },
  ]).replace("name:", "\u001b[37mname:\u001b[39m");
  assert.deepEqual(parseLifecycleListOutput(output), [
    expectedLifecycleRule(30),
    { name: "user-archive", enabled: "Yes", prefix: "archive/", action: "Expire objects after 365 days" },
  ]);
  assert.deepEqual(parseLifecycleListOutput(listOutput("evidence", [])), []);
});

test("lifecycle list parser fails closed on unfamiliar or incomplete output", () => {
  assert.throws(
    () => parseLifecycleListOutput("Listing lifecycle policy...\nNo policy entries.\n"),
    /refusing to assume the bucket has no rules/,
  );
  assert.throws(
    () => parseLifecycleListOutput("name: a\nenabled: Yes\nprefix: raw/\n"),
    /omitted 'action'/,
  );
});

test("exact stable rule is the only no-op policy", () => {
  assert.equal(inspectLifecycleRules([expectedLifecycleRule(30)], 30, "evidence").action, "noop");
  assert.equal(inspectLifecycleRules([], 30, "evidence").action, "add");
  assert.throws(
    () => inspectLifecycleRules([{ ...expectedLifecycleRule(30), prefix: "raw-public/" }], 30, "evidence"),
    /differs from Driftglass policy.*Refusing to overwrite or remove it/,
  );
  assert.throws(
    () => inspectLifecycleRules([{ ...expectedLifecycleRule(30), action: "Expire objects after 30 days, Transition to Infrequent Access after 7 days" }], 30, "evidence"),
    /differs from Driftglass policy/,
  );
});

test("default setup lists the configured bucket and does not add an exact existing rule", async () => {
  await withConfig(configFixture(), async (cwd) => {
    const calls = [];
    const runWrangler = async (args) => {
      calls.push(args);
      return { stdout: listOutput("default-evidence", [expectedLifecycleRule(30)]), stderr: "" };
    };
    const result = await configureR2Lifecycle({ cwd, runWrangler });
    assert.deepEqual(result, { status: "unchanged", bucket: "default-evidence", days: 30 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 5), ["r2", "bucket", "lifecycle", "list", "default-evidence"]);
    assert.deepEqual(calls[0].slice(-3), ["--config", path.join(cwd, "wrangler.jsonc"), "--env="]);
  });
});

test("staging setup adds only the stable rule when its ID is absent", async () => {
  await withConfig(configFixture(), async (cwd) => {
    const calls = [];
    const userRule = { name: "user-archive", enabled: "Yes", prefix: "archive/", action: "Expire objects after 365 days" };
    const runWrangler = async (args) => {
      calls.push(args);
      return calls.length === 1
        ? { stdout: listOutput("staging-evidence", [userRule]), stderr: "" }
        : { stdout: "Added lifecycle rule.\n", stderr: "" };
    };
    const result = await configureR2Lifecycle({ cwd, environment: "staging", runWrangler });
    assert.deepEqual(result, { status: "added", bucket: "staging-evidence", days: 45 });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], [
      "r2", "bucket", "lifecycle", "add", "staging-evidence",
      LIFECYCLE_RULE_ID, LIFECYCLE_PREFIX,
      "--expire-days", "45",
      "--force",
      "--config", path.join(cwd, "wrangler.jsonc"),
      "--env", "staging",
    ]);
    assert.ok(calls.every((args) => !args.includes("remove") && !args.includes("set")));
  });
});

test("a conflicting stable ID fails before any mutation command", async () => {
  await withConfig(configFixture(), async (cwd) => {
    const calls = [];
    const runWrangler = async (args) => {
      calls.push(args);
      return {
        stdout: listOutput("default-evidence", [{
          ...expectedLifecycleRule(90),
          prefix: "raw/",
        }]),
        stderr: "",
      };
    };
    await assert.rejects(
      configureR2Lifecycle({ cwd, runWrangler }),
      /already exists.*Expected.*30 days.*found.*90 days.*Refusing to overwrite or remove it/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][3], "list");
  });
});

test("invalid environment configuration fails before invoking Wrangler", async () => {
  await withConfig(configFixture({ defaultDays: "0" }), async (cwd) => {
    let invoked = false;
    await assert.rejects(
      configureR2Lifecycle({ cwd, runWrangler: async () => { invoked = true; } }),
      /RAW_PUBLIC_RETENTION_DAYS must be a positive integer/,
    );
    assert.equal(invoked, false);
  });
  assert.throws(() => parseArguments(["--env", "production"]), /Usage:/);
});

test("local runner executes the repository Wrangler with no shell and bounded output/time", async () => {
  let captured;
  const result = await runLocalWrangler(["r2", "bucket", "lifecycle", "list", "evidence"], {
    cwd: path.join(path.sep, "workspace"),
    timeoutMs: 1234,
    execFileImpl(executable, args, options, callback) {
      captured = { executable, args, options };
      callback(null, "rules\n", "");
    },
  });
  assert.deepEqual(result, { stdout: "rules\n", stderr: "" });
  assert.equal(captured.executable, process.execPath);
  assert.equal(captured.args[0], path.join(path.sep, "workspace", "node_modules", "wrangler", "bin", "wrangler.js"));
  assert.deepEqual(captured.args.slice(1), ["r2", "bucket", "lifecycle", "list", "evidence"]);
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.timeout, 1234);
  assert.equal(captured.options.maxBuffer, 1024 * 1024);
});

test("every deploy lane configures lifecycle after its D1 migration", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const name of ["deploy", "deploy:first"]) {
    assert.ok(pkg.scripts[name].indexOf("db:migrate:remote") < pkg.scripts[name].indexOf("r2:lifecycle"), name);
  }
  for (const name of ["deploy:staging", "deploy:staging:first"]) {
    assert.ok(pkg.scripts[name].indexOf("db:migrate:staging") < pkg.scripts[name].indexOf("r2:lifecycle:staging"), name);
  }
  assert.match(pkg.scripts["r2:lifecycle:check"], /tests\/r2-lifecycle\.test\.mjs/);
});
