#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const outputDirectory = path.join(repositoryRoot, ".test-dist");
const compilerPath = path.join(repositoryRoot, "node_modules", "typescript", "lib", "tsc.js");

async function runCompiler() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [compilerPath, "-p", path.join(repositoryRoot, "tsconfig.test.json")], {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`TypeScript test compilation exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

await rm(outputDirectory, { recursive: true, force: true });
await runCompiler();
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, "package.json"), '{"type":"commonjs"}\n');
