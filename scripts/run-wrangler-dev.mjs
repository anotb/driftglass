#!/usr/bin/env node
import { spawn as nodeSpawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseJsonc } from "./configure-r2-lifecycle.mjs";

export const OPTIONAL_LOCAL_BINDINGS = Object.freeze([
  "GITHUB_TOKEN",
  "OPENALEX_API_KEY",
  "DEEP_DIVE_LAB_URL",
  "DEEP_DIVE_LAB_TOKEN",
]);

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");

function localTargets(config) {
  const environments = config.env && typeof config.env === "object"
    ? Object.values(config.env).filter((value) => value && typeof value === "object")
    : [];
  return [config, ...environments];
}

export function buildLocalDevConfig(config) {
  const generated = structuredClone(config);
  for (const target of localTargets(generated)) {
    const vars = target.vars && typeof target.vars === "object" ? { ...target.vars } : {};
    for (const binding of OPTIONAL_LOCAL_BINDINGS) {
      if (Object.hasOwn(vars, binding)) {
        throw new Error(`${binding} is reserved for local secret loading and must not be a checked-in Worker variable`);
      }
      vars[binding] = "";
    }
    target.vars = vars;
  }
  return generated;
}

export function validateDevArguments(args) {
  for (const argument of args) {
    if ((argument.startsWith("-c") && !argument.startsWith("--")) || argument === "--config" || argument.startsWith("--config=")) {
      throw new Error("run-wrangler-dev owns the temporary --config; remove the extra config argument");
    }
  }
  return [...args];
}

export function generatedConfigPath(root = repositoryRoot, pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("A positive process ID is required");
  return path.join(root, `.wrangler.dev.${pid}.jsonc`);
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

export async function runWranglerDev({
  args = process.argv.slice(2),
  root = repositoryRoot,
  pid = process.pid,
  spawnImpl = nodeSpawn,
  processRef = process,
} = {}) {
  const forwardedArgs = validateDevArguments(args);
  const sourceConfigPath = path.join(root, "wrangler.jsonc");
  const temporaryConfigPath = generatedConfigPath(root, pid);
  const wranglerCliPath = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  const source = await readFile(sourceConfigPath, "utf8");
  const generated = buildLocalDevConfig(parseJsonc(source, sourceConfigPath));

  await writeFile(temporaryConfigPath, `${JSON.stringify(generated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  let child;
  let forwardedSignal = null;
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      forwardedSignal ??= signal;
      if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    processRef.once(signal, handler);
  }

  try {
    child = spawnImpl(processRef.execPath, [wranglerCliPath, "dev", "--config", temporaryConfigPath, ...forwardedArgs], {
      cwd: root,
      env: processRef.env,
      shell: false,
      stdio: "inherit",
    });
    const result = await waitForChild(child);
    return { ...result, signal: forwardedSignal ?? result.signal };
  } finally {
    for (const [signal, handler] of signalHandlers) processRef.removeListener(signal, handler);
    await rm(temporaryConfigPath, { force: true });
  }
}

async function main() {
  const result = await runWranglerDev();
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`Driftglass dev failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
