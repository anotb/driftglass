#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(path.join(root, "config", "upstreams.lock.json"), "utf8"));
const outputArg = process.argv.findIndex((value) => value === "--output");
const outputPath = outputArg >= 0 ? process.argv[outputArg + 1] : undefined;
const headers = {
  accept: "application/vnd.github+json",
  "user-agent": "Driftglass-Upstream-Watch/0.1",
  "x-github-api-version": "2022-11-28",
};
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

function compareVersions(left, right) {
  const parse = (value) => String(value).replace(/^v/, "").split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  const a = parse(left); const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0; const y = b[i] ?? 0;
    if (typeof x === "number" && typeof y === "number") { if (x !== y) return x > y ? 1 : -1; }
    else if (String(x) !== String(y)) return String(x).localeCompare(String(y));
  }
  return 0;
}

const results = [];
for (const upstream of lock.upstreams) {
  try {
    const response = await fetch(`https://api.github.com/repos/${upstream.repository}/contents/${upstream.versionFile}`, { headers });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const body = await response.json();
    const content = Buffer.from(body.content || "", "base64").toString("utf8");
    const match = content.match(new RegExp(upstream.versionPattern));
    if (!match?.[1]) throw new Error(`Version pattern did not match ${upstream.versionFile}`);
    const current = match[1];
    results.push({ ...upstream, current, updateAvailable: compareVersions(current, upstream.version) > 0, status: "ok" });
  } catch (error) {
    results.push({ ...upstream, current: null, updateAvailable: false, status: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

const updates = results.filter((entry) => entry.updateAvailable);
const errors = results.filter((entry) => entry.status === "error");
const lines = [
  "# Driftglass upstream adapter report",
  "",
  `Checked: ${new Date().toISOString()}`,
  "",
  "| Upstream | Role | Pinned | Current | Status |",
  "|---|---|---:|---:|---|",
  ...results.map((entry) => `| [${entry.name}](https://github.com/${entry.repository}) | ${entry.role} | ${entry.version} | ${entry.current ?? "unknown"} | ${entry.updateAvailable ? "update available" : entry.status === "error" ? `check failed: ${entry.error}` : "current"} |`),
  "",
  updates.length ? "Review the updates with the Relay smoke-test contract before changing the lock file." : "No newer tracked versions were detected.",
];
const markdown = `${lines.join("\n")}\n`;
if (outputPath) await writeFile(path.resolve(outputPath), markdown);
else process.stdout.write(markdown);
if (updates.length || errors.length) process.exitCode = 1;
