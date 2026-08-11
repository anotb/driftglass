#!/usr/bin/env node
import { execFile as nodeExecFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

export const LIFECYCLE_RULE_ID = "driftglass-raw-retention";
export const LIFECYCLE_PREFIX = "raw/";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];

    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        output += character;
      } else {
        output += " ";
      }
      continue;
    }

    if (blockComment) {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        blockComment = false;
      } else {
        output += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }

    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      output += "  ";
      index += 1;
      lineComment = true;
    } else if (character === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockComment = true;
    } else {
      output += character;
    }
  }

  if (blockComment) throw new Error("Unterminated block comment");
  return output;
}

function stripTrailingCommas(input) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }

    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(input[lookahead] ?? "")) lookahead += 1;
      if (input[lookahead] === "}" || input[lookahead] === "]") {
        output += " ";
        continue;
      }
    }
    output += character;
  }
  return output;
}

export function parseJsonc(input, file = "wrangler.jsonc") {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(String(input).replace(/^\uFEFF/, ""))));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${file}: ${message}`);
  }
}

function selectedConfig(config, environment) {
  if (environment === undefined) return config;
  if (environment !== "staging") {
    throw new Error(`Unsupported environment '${environment}'. Use the default environment or --env staging.`);
  }
  const staging = config?.env?.staging;
  if (!staging || typeof staging !== "object") throw new Error("wrangler.jsonc does not define env.staging");
  return staging;
}

export function lifecycleTarget(config, environment) {
  const target = selectedConfig(config, environment);
  const buckets = Array.isArray(target.r2_buckets) ? target.r2_buckets : [];
  const evidenceBuckets = buckets.filter((bucket) => bucket?.binding === "EVIDENCE");
  if (evidenceBuckets.length !== 1 || typeof evidenceBuckets[0].bucket_name !== "string" || !evidenceBuckets[0].bucket_name.trim()) {
    throw new Error(`${environment === "staging" ? "env.staging" : "the default environment"} must define exactly one EVIDENCE R2 bucket`);
  }

  const rawDays = target.vars?.RAW_PUBLIC_RETENTION_DAYS;
  const daysText = String(rawDays ?? "").trim();
  if (!/^\d+$/.test(daysText) || !Number.isSafeInteger(Number(daysText)) || Number(daysText) <= 0) {
    throw new Error(`${environment === "staging" ? "env.staging.vars" : "vars"}.RAW_PUBLIC_RETENTION_DAYS must be a positive integer`);
  }

  return {
    bucket: evidenceBuckets[0].bucket_name.trim(),
    days: Number(daysText),
  };
}

function finishRule(rule, rules) {
  if (!rule) return;
  for (const field of ["name", "enabled", "prefix", "action"]) {
    if (typeof rule[field] !== "string" || !rule[field]) {
      throw new Error(`Wrangler lifecycle list output omitted '${field}' for a rule; refusing to make changes`);
    }
  }
  rules.push(rule);
}

export function parseLifecycleListOutput(output) {
  const plain = stripVTControlCharacters(String(output));
  const rules = [];
  let current;

  for (const line of plain.split(/\r?\n/)) {
    const match = line.match(/^\s*(name|enabled|prefix|action):\s*(.*?)\s*$/i);
    if (!match) continue;
    const field = match[1].toLowerCase();
    if (field === "name") {
      finishRule(current, rules);
      current = {};
    }
    if (!current) throw new Error("Wrangler lifecycle list output contained fields before a rule name; refusing to make changes");
    if (Object.hasOwn(current, field)) throw new Error(`Wrangler lifecycle list output repeated '${field}'; refusing to make changes`);
    current[field] = match[2].trim().replace(/\s+/g, " ");
  }
  finishRule(current, rules);

  if (rules.length === 0 && !/There are no lifecycle rules for bucket\s+['"][^'"]+['"]\./i.test(plain)) {
    throw new Error("Could not recognize Wrangler lifecycle list output; refusing to assume the bucket has no rules");
  }
  return rules;
}

export function expectedLifecycleRule(days) {
  return {
    name: LIFECYCLE_RULE_ID,
    enabled: "Yes",
    prefix: LIFECYCLE_PREFIX,
    action: `Expire objects after ${days} days`,
  };
}

function ruleDescription(rule) {
  return `enabled=${JSON.stringify(rule.enabled)}, prefix=${JSON.stringify(rule.prefix)}, action=${JSON.stringify(rule.action)}`;
}

export function inspectLifecycleRules(rules, days, bucket) {
  const matches = rules.filter((rule) => rule.name === LIFECYCLE_RULE_ID);
  if (matches.length > 1) {
    throw new Error(`Bucket '${bucket}' contains ${matches.length} rules with ID '${LIFECYCLE_RULE_ID}'; refusing to change any rule`);
  }
  if (matches.length === 0) return { action: "add", expected: expectedLifecycleRule(days) };

  const expected = expectedLifecycleRule(days);
  const existing = matches[0];
  const exact = ["enabled", "prefix", "action"].every((field) => existing[field] === expected[field]);
  if (!exact) {
    throw new Error(
      `Lifecycle rule '${LIFECYCLE_RULE_ID}' already exists on bucket '${bucket}' but differs from Driftglass policy. ` +
      `Expected ${ruleDescription(expected)}; found ${ruleDescription(existing)}. Refusing to overwrite or remove it.`,
    );
  }
  return { action: "noop", expected };
}

export function runLocalWrangler(args, {
  cwd = repositoryRoot,
  execFileImpl = nodeExecFile,
  timeoutMs = 60_000,
} = {}) {
  const cliPath = path.join(cwd, "node_modules", "wrangler", "bin", "wrangler.js");
  return new Promise((resolve, reject) => {
    execFileImpl(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout = "", stderr = "") => {
      if (!error) {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      const detail = [String(stderr).trim(), String(stdout).trim(), error.message].find(Boolean);
      reject(new Error(`Local Wrangler command failed: ${detail || "unknown error"}`, { cause: error }));
    });
  });
}

function environmentArgs(environment) {
  return environment === "staging" ? ["--env", "staging"] : ["--env="];
}

export async function configureR2Lifecycle({
  cwd = repositoryRoot,
  environment,
  runWrangler = (args) => runLocalWrangler(args, { cwd }),
} = {}) {
  if (environment !== undefined && environment !== "staging") {
    throw new Error(`Unsupported environment '${environment}'. Use the default environment or --env staging.`);
  }
  const configPath = path.join(cwd, "wrangler.jsonc");
  const config = parseJsonc(await readFile(configPath, "utf8"), configPath);
  const { bucket, days } = lifecycleTarget(config, environment);
  const commonArgs = ["--config", configPath, ...environmentArgs(environment)];
  const listed = await runWrangler([
    "r2", "bucket", "lifecycle", "list", bucket, ...commonArgs,
  ]);
  const plan = inspectLifecycleRules(parseLifecycleListOutput(listed.stdout), days, bucket);

  if (plan.action === "noop") return { status: "unchanged", bucket, days };

  await runWrangler([
    "r2", "bucket", "lifecycle", "add", bucket,
    LIFECYCLE_RULE_ID, LIFECYCLE_PREFIX,
    "--expire-days", String(days),
    "--force",
    ...commonArgs,
  ]);
  return { status: "added", bucket, days };
}

export function parseArguments(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--env" && argv[1] === "staging") return { environment: "staging" };
  if (argv.length === 1 && argv[0] === "--env=staging") return { environment: "staging" };
  throw new Error("Usage: node scripts/configure-r2-lifecycle.mjs [--env staging]");
}

async function main() {
  const result = await configureR2Lifecycle(parseArguments(process.argv.slice(2)));
  const disposition = result.status === "added" ? "added" : "already exact; no changes";
  process.stdout.write(
    `R2 lifecycle '${LIFECYCLE_RULE_ID}' ${disposition} on '${result.bucket}' (${LIFECYCLE_PREFIX}, ${result.days} days).\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`R2 lifecycle setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
