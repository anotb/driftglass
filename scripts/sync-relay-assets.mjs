#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentDigest, verifyGeneratedFiles } from "./generated-assets.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "driftglass-relay");
const targetUrl = new URL("../public/relay/", import.meta.url);
const target = fileURLToPath(targetUrl);
const files = ["driftglass-relay.mjs", "install.sh", "install.ps1"];
const checkOnly = process.argv.includes("--check");

if (!checkOnly) await mkdir(target, { recursive: true });
const hashes = {};
const outputFiles = new Map();
for (const file of files) {
  const sourcePath = join(source, file);
  const targetPath = join(target, file);
  const bytes = await readFile(sourcePath);
  hashes[file] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  outputFiles.set(file, bytes);
  if (!checkOnly) await copyFile(sourcePath, targetPath);
}
if (!checkOnly) await chmod(join(target, "install.sh"), 0o755);
const packageJson = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const manifestContent = {
  name: "driftglass-companion",
  version: packageJson.version,
  sha256: hashes["driftglass-relay.mjs"].sha256,
  files: hashes,
};
const manifest = {
  ...manifestContent,
  contentDigest: contentDigest(manifestContent),
};
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
outputFiles.set("manifest.json", manifestText);
if (checkOnly) {
  await verifyGeneratedFiles(targetUrl, outputFiles, "Hosted Relay");
  console.log("Hosted Relay assets are current.");
} else {
  await writeFile(join(target, "manifest.json"), manifestText);
}
