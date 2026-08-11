#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { checkReleasePrivacy } from "./check-release-privacy.mjs";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const allowedRootExampleSecrets = new Set([
  ".dev.vars.example",
  ".dev.vars.local.example",
  ".env.example",
  ".deploy-secrets.example",
]);
const forbiddenPackageDirectorySegments = new Set([
  ".wrangler",
  ".agents",
  ".playwright-cli",
  "node_modules",
  "dist",
  ".test-dist",
  "output",
]);

export const REPOSITORY_PLACEHOLDER = ["YOUR", "GITHUB"].join("_");
export const PUBLIC_RELEASE_REPOSITORY_URL = "https://github.com/anotb/driftglass";

export const RELEASE_BOUNDARY_FILES = Object.freeze([
  ".gitattributes",
  ".npmignore",
]);

export const PRIVATE_SOURCE_RELEASE_PATHS = Object.freeze([
  "WORK_PROMPT.md",
  "START_HERE_WORK.md",
  "handoff/",
  "config/milestones.json",
  "scripts/check-milestones.mjs",
  "docs/BUILD-REPORT.md",
  "docs/CLOUDFLARE-SHOWCASE.md",
  "docs/LAUNCH.md",
  "docs/MILESTONES.md",
]);

export const FORBIDDEN_PUBLIC_RELEASE_PATHS = Object.freeze([
  ".internal/",
  ...PRIVATE_SOURCE_RELEASE_PATHS,
]);

const requiredGitAttributeLines = Object.freeze([
  "migrations/*.sql text eol=lf",
  ".internal export-ignore",
  ".internal/** export-ignore",
]);

const requiredGitIgnoreLines = Object.freeze([
  "node_modules/",
  ".dev.vars*",
  "!.dev.vars.example",
  "!.dev.vars.local.example",
  ".env*",
  "!.env.example",
  ".deploy-secrets*",
  "!.deploy-secrets.example",
  ".wrangler/",
  "dist/",
  ".test-dist/",
  "/output/",
  "/.internal/",
  "/.playwright-cli/",
  "/.agents/",
  "/.wrangler.dev.*.jsonc",
  "driftglass-relay/node_modules/",
  ".DS_Store",
  "*.log",
]);

const requiredNpmIgnoreLines = Object.freeze([
  "/.internal/",
  "/docs/assets/launch/",
  ".dev.vars*",
  "!/.dev.vars.example",
  "!/.dev.vars.local.example",
  ".env*",
  "!/.env.example",
  ".deploy-secrets*",
  "!/.deploy-secrets.example",
  ".wrangler.dev.*.jsonc",
  ".wrangler/",
  ".agents/",
  ".playwright-cli/",
  "node_modules/",
  "dist/",
  ".test-dist/",
  "output/",
  "*.tgz",
  "*.log",
  ".DS_Store",
]);

export const REQUIRED_RELEASE_FILES = Object.freeze([
  ".deploy-secrets.example",
  ".dev.vars.example",
  ".dev.vars.local.example",
  ".gitattributes",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".gitignore",
  ".npmignore",
  "README.md",
  "docs/DEPLOY.md",
  "docs/PORTABLE-RUNTIME.md",
  "docs/RELEASE-0.9.0.md",
  "docs/VALIDATION.md",
  "labs/agent-memory-bridge/package-lock.json",
  "labs/deep-dive-lab/package-lock.json",
  "migrations/0018_email_receipt_idempotency.sql",
  "migrations/0019_queue_ingest_durability.sql",
  "migrations/0020_ingest_completion_state.sql",
  "migrations/0021_ingest_deadletter_retry_claims.sql",
  "migrations/0022_source_ingest_producer_outbox.sql",
  "migrations/0023_mission_match_evidence_index.sql",
  "package-lock.json",
  "package.json",
  "plugins/driftglass/.codex-plugin/plugin.json",
  "plugins/driftglass/skills/answer-mission/SKILL.md",
  "plugins/driftglass/skills/answer-mission/agents/openai.yaml",
  "public/app.js",
  "public/index.html",
  "public/install.md",
  "public/icons/driftglass-og.png",
  "public/icons/driftglass-og.source.sha256",
  "public/icons/driftglass-share-fallback.png",
  "public/icons/driftglass-share-fallback.source.sha256",
  "public/styles.css",
  "public/sw.js",
  "public/webmcp.js",
  "scripts/build-selfhost.mjs",
  "scripts/build-social-card.mjs",
  "scripts/check-release-candidate.mjs",
  "scripts/check-release-privacy.mjs",
  "scripts/compile-tests.mjs",
  "scripts/configure-r2-lifecycle.mjs",
  "scripts/generate-migrations.mjs",
  "scripts/run-wrangler-dev.mjs",
  "scripts/verify-repo.mjs",
  "src/index.ts",
  "src/runtime/node/cli.ts",
  "src/runtime/node/cloudflare-import-boundary.ts",
  "src/worker-configuration.d.ts",
  "tests/deploy-packaging.test.mjs",
  "tests/r2-lifecycle.test.mjs",
  "tests/release-candidate.test.mjs",
  "tests/release-privacy.test.mjs",
  "tsconfig.node-http.json",
  "wrangler.jsonc",
]);

function commandDetail(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .map((value) => String(value ?? "").trim())
    .find(Boolean) ?? "unknown command failure";
}

async function runFile(command, args, { cwd, allowNoMatches = false, environment = process.env } = {}) {
  try {
    return await execFile(command, args, {
      cwd,
      env: environment,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (allowNoMatches && error?.code === 1) return { stdout: "", stderr: "" };
    throw new Error(`${command} ${args.join(" ")} failed: ${commandDetail(error)}`, { cause: error });
  }
}

function nulSet(output) {
  return new Set(String(output).split("\0").filter(Boolean));
}

async function gitFileSet(root, args) {
  const { stdout } = await runFile("git", args, { cwd: root });
  return nulSet(stdout);
}

async function placeholderMatches(root, args) {
  const { stdout } = await runFile("git", args, { cwd: root, allowNoMatches: true });
  return String(stdout).trim().split(/\r?\n/).filter(Boolean);
}

function missingFiles(requiredFiles, availableFiles) {
  return requiredFiles.filter((file) => !availableFiles.has(file));
}

function normalizedReleasePath(file) {
  return String(file).replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function matchesPathBoundary(file, boundary) {
  const normalizedFile = normalizedReleasePath(file);
  const normalizedBoundary = normalizedReleasePath(boundary);
  return boundary.endsWith("/")
    ? normalizedFile === normalizedBoundary || normalizedFile.startsWith(`${normalizedBoundary}/`)
    : normalizedFile === normalizedBoundary;
}

export function forbiddenPublicReleasePaths(files) {
  return [...new Set([...files]
    .map(normalizedReleasePath)
    .filter((file) => FORBIDDEN_PUBLIC_RELEASE_PATHS.some((boundary) => matchesPathBoundary(file, boundary))))]
    .sort();
}

function boundaryLines(source) {
  return new Set(String(source).split(/\r?\n/));
}

function privateSourceGitAttributeLines() {
  return PRIVATE_SOURCE_RELEASE_PATHS.flatMap((file) => file.endsWith("/")
    ? [`${file.slice(0, -1)} export-ignore`, `${file}** export-ignore`]
    : [`${file} export-ignore`]);
}

function assertRequiredBoundaryLines(lines, required, label) {
  const missing = required.filter((line) => !lines.has(line));
  if (missing.length > 0) {
    throw new Error(`Release boundary ${label} is missing required public safety rules: ${missing.join(", ")}`);
  }
}

export function assertReleaseBoundaryProfile({ gitAttributes, gitIgnore, npmIgnore }) {
  const attributeLines = boundaryLines(gitAttributes);
  const gitIgnoreLines = boundaryLines(gitIgnore);
  const npmIgnoreLines = boundaryLines(npmIgnore);
  assertRequiredBoundaryLines(attributeLines, requiredGitAttributeLines, ".gitattributes");
  assertRequiredBoundaryLines(gitIgnoreLines, requiredGitIgnoreLines, ".gitignore");
  assertRequiredBoundaryLines(npmIgnoreLines, requiredNpmIgnoreLines, ".npmignore");

  const sourceRules = [
    ...privateSourceGitAttributeLines().map((line) => [".gitattributes", line, attributeLines.has(line)]),
    ...PRIVATE_SOURCE_RELEASE_PATHS.map((file) => [".npmignore", `/${file}`, npmIgnoreLines.has(`/${file}`)]),
  ];
  const presentSourceRules = sourceRules.filter(([, , present]) => present);
  if (presentSourceRules.length > 0 && presentSourceRules.length < sourceRules.length) {
    const missing = sourceRules
      .filter(([, , present]) => !present)
      .map(([file, line]) => `${file}:${line}`);
    throw new Error(`Release boundary mixes private-source and normalized-public rules; missing: ${missing.join(", ")}`);
  }

  if (presentSourceRules.length === sourceRules.length) return "source";

  const privateReference = /(?:WORK_PROMPT|START_HERE_WORK|handoff|milestones|BUILD-REPORT|CLOUDFLARE-SHOWCASE|(?:^|\/)LAUNCH\.md|MILESTONES|private validation)/i;
  const privateReferences = [
    [".gitattributes", gitAttributes],
    [".gitignore", gitIgnore],
    [".npmignore", npmIgnore],
  ].flatMap(([file, source]) => String(source)
    .split(/\r?\n/)
    .filter((line) => privateReference.test(line))
    .map((line) => `${file}:${line}`));
  if (privateReferences.length > 0) {
    throw new Error(`Normalized public release boundary still names private-source paths: ${privateReferences.join(", ")}`);
  }
  return "public";
}

export async function assertInternalWorkspaceUntracked(root = repositoryRoot) {
  const absoluteRoot = path.resolve(root);
  let tracked;
  try {
    tracked = await gitFileSet(absoluteRoot, ["ls-files", "--cached", "-z", "--", ".internal"]);
  } catch (error) {
    if (!/not a git repository/i.test(String(error?.message ?? error))) throw error;
    try {
      await lstat(path.join(absoluteRoot, ".internal"));
    } catch (fileError) {
      if (fileError?.code === "ENOENT") return;
      throw fileError;
    }
    throw new Error("Release artifact contains the private .internal workspace");
  }
  if (tracked.size > 0) {
    throw new Error(`Private .internal workspace files must remain untracked: ${[...tracked].sort().join(", ")}`);
  }
}

function isForbiddenNpmPackagePath(file) {
  const normalized = normalizedReleasePath(file);
  if (forbiddenPublicReleasePaths([normalized]).length > 0) return true;
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  if (/^(?:\.dev\.vars|\.env|\.deploy-secrets)/.test(basename)) {
    return !allowedRootExampleSecrets.has(normalized);
  }
  return segments.some((segment) => forbiddenPackageDirectorySegments.has(segment))
    || /^\.wrangler\.dev\..*\.jsonc$/.test(basename)
    || basename === ".DS_Store"
    || /\.(?:log|tgz)$/.test(basename);
}

function assertNoForbiddenPaths(files, { label, npmPackage = false }) {
  const forbidden = [...new Set([...files]
    .map(normalizedReleasePath)
    .filter((file) => npmPackage ? isForbiddenNpmPackagePath(file) : forbiddenPublicReleasePaths([file]).length > 0))]
    .sort();
  if (forbidden.length > 0) {
    throw new Error(`${label} contains forbidden private or generated paths: ${forbidden.join(", ")}`);
  }
}

async function assertRegularFiles(root, requiredFiles) {
  const missing = [];
  for (const file of requiredFiles) {
    try {
      const metadata = await lstat(path.join(root, file));
      if (!metadata.isFile()) missing.push(file);
    } catch (error) {
      if (error?.code === "ENOENT") missing.push(file);
      else throw error;
    }
  }
  if (missing.length > 0) {
    throw new Error(`Tracked release artifact is missing required files: ${missing.join(", ")}`);
  }
}

async function assertForbiddenPathsAbsent(root, forbiddenPaths) {
  const present = [];
  for (const file of forbiddenPaths) {
    const normalized = normalizedReleasePath(file);
    try {
      const metadata = await lstat(path.join(root, normalized));
      if (file.endsWith("/") && metadata.isDirectory()) {
        const entries = await readdir(path.join(root, normalized));
        present.push(...entries.map((entry) => `${normalized}/${entry}`));
      } else {
        present.push(file);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  assertNoForbiddenPaths(present, { label: "Tracked release archive" });
}

async function artifactFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await artifactFiles(root, absolutePath));
    else files.push(path.relative(root, absolutePath).replaceAll(path.sep, "/"));
  }
  return files;
}

async function runInherited(command, args, cwd, environment = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

function isDependencyBinPath(entry) {
  const unquoted = entry.trim().replace(/^"(.*)"$/, "$1");
  if (!unquoted) return false;
  const normalized = path.resolve(unquoted);
  return path.basename(normalized).toLowerCase() === ".bin"
    && path.basename(path.dirname(normalized)).toLowerCase() === "node_modules";
}

function artifactEnvironment(artifactRoot) {
  const environment = { ...process.env };
  const pathKeys = [];
  for (const key of Object.keys(environment)) {
    const normalized = key.toLowerCase();
    if (normalized === "path") pathKeys.push(key);
    if (
      normalized === "node_path"
      || normalized === "init_cwd"
      || normalized === "pwd"
      || normalized === "oldpwd"
      || normalized === "npm_command"
      || normalized === "npm_config_local_prefix"
      || normalized.startsWith("npm_lifecycle_")
      || normalized.startsWith("npm_package_")
    ) {
      delete environment[key];
    }
  }

  const pathKey = pathKeys[0] ?? "PATH";
  const inheritedPath = pathKeys.map((key) => process.env[key]).find(Boolean) ?? "";
  for (const key of pathKeys) delete environment[key];
  environment[pathKey] = inheritedPath
    .split(path.delimiter)
    .filter((entry) => entry && !isDependencyBinPath(entry))
    .join(path.delimiter);
  environment.INIT_CWD = artifactRoot;
  environment.PWD = artifactRoot;
  return environment;
}

function npmPackReport(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("npm pack --dry-run did not return valid JSON", { cause: error });
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray(parsed.files)
      ? [parsed]
      : parsed && typeof parsed === "object"
        ? Object.values(parsed)
        : [];
  const report = candidates.find((candidate) => candidate && Array.isArray(candidate.files));
  if (!report) throw new Error("npm pack --dry-run did not report package files");
  return report;
}

async function checkoutRevision(root, revision, destination, indexFile) {
  const environment = { ...process.env, GIT_INDEX_FILE: indexFile };
  await runFile("git", ["read-tree", revision], { cwd: root, environment });
  await runFile("git", ["checkout-index", "--all", `--prefix=${destination}${path.sep}`], {
    cwd: root,
    environment,
  });
}

async function npmPackageFiles(root) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await runFile(npmCommand, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    environment: artifactEnvironment(root),
  });
  return new Set(npmPackReport(stdout).files.map((entry) => entry.path));
}

function markdownDestinations(markdown) {
  let activeFence;
  const prose = String(markdown).split(/\r?\n/).map((line) => {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1];
      if (!activeFence) activeFence = { character: marker[0], length: marker.length };
      else if (marker[0] === activeFence.character && marker.length >= activeFence.length) activeFence = undefined;
      return "";
    }
    if (activeFence) return "";
    return line.replace(/(`+)[^`]*\1/g, "");
  }).join("\n");
  const destinations = [];
  const markdownLink = /\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\r\n)]*\)))?\s*\)/g;
  for (const match of prose.matchAll(markdownLink)) {
    destinations.push(match[1] ?? match[2]);
  }

  const markdownReference = /^ {0,3}\[[^\]\r\n]+\]:\s*(?:<([^>\r\n]+)>|(\S+))/gm;
  for (const match of prose.matchAll(markdownReference)) {
    destinations.push(match[1] ?? match[2]);
  }

  const htmlAnchor = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  for (const match of prose.matchAll(htmlAnchor)) {
    destinations.push(match[2].replaceAll("&amp;", "&"));
  }
  return destinations;
}

function localMarkdownPath(destination) {
  const value = String(destination).trim().replaceAll("&amp;", "&");
  if (
    !value
    || value.startsWith("#")
    || value.startsWith("?")
    || value.startsWith("/")
    || value.startsWith("\\")
    || /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) return undefined;
  const encodedPath = value.split(/[?#]/, 1)[0];
  if (!encodedPath) return undefined;
  try {
    return decodeURIComponent(encodedPath).replace(/\\([\\()])/g, "$1");
  } catch {
    return encodedPath;
  }
}

export async function assertLocalMarkdownReferencesResolve(root, files = undefined) {
  const absoluteRoot = path.resolve(root);
  const availableFiles = files ?? await artifactFiles(absoluteRoot);
  const broken = [];
  for (const markdownFile of availableFiles.filter((file) => file.toLowerCase().endsWith(".md")).sort()) {
    const markdown = await readFile(path.join(absoluteRoot, markdownFile), "utf8");
    for (const destination of markdownDestinations(markdown)) {
      const localPath = localMarkdownPath(destination);
      if (!localPath) continue;
      const target = path.resolve(path.dirname(path.join(absoluteRoot, markdownFile)), ...localPath.split("/"));
      const relativeTarget = path.relative(absoluteRoot, target);
      if (relativeTarget.startsWith(`..${path.sep}`) || relativeTarget === ".." || path.isAbsolute(relativeTarget)) {
        broken.push(`${markdownFile} -> ${destination}`);
        continue;
      }
      try {
        await stat(target);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") broken.push(`${markdownFile} -> ${destination}`);
        else throw error;
      }
    }
  }
  if (broken.length > 0) {
    throw new Error(`Tracked release archive has broken local Markdown references:\n${[...new Set(broken)].sort().join("\n")}`);
  }
}

function assertNoPrivatePackageScripts(packageManifest) {
  const privateScripts = Object.entries(packageManifest.scripts ?? {})
    .filter(([name, command]) => name === "milestones:check"
      || (typeof command === "string" && command.includes("scripts/check-milestones.mjs")))
    .map(([name]) => name)
    .sort();
  if (privateScripts.length > 0) {
    throw new Error(`Tracked package.json exposes private or unavailable scripts: ${privateScripts.join(", ")}`);
  }
}

function isSupportedRepositoryUrl(value) {
  let repositoryUrl;
  try {
    repositoryUrl = new URL(value);
  } catch {
    return false;
  }

  const hostname = repositoryUrl.hostname.toLowerCase();
  const pathSegments = repositoryUrl.pathname.split("/").filter(Boolean);
  return repositoryUrl.protocol === "https:"
    && (hostname === "github.com" || hostname === "gitlab.com")
    && repositoryUrl.username === ""
    && repositoryUrl.password === ""
    && repositoryUrl.port === ""
    && repositoryUrl.search === ""
    && repositoryUrl.hash === ""
    && pathSegments.length >= 2;
}

function deployButtonLinks(readme) {
  const deployLinks = [];
  for (const destination of markdownDestinations(readme)) {
    let link;
    try {
      link = new URL(destination);
    } catch {
      continue;
    }
    if (link.protocol === "https:" && link.hostname.toLowerCase() === "deploy.workers.cloudflare.com") {
      deployLinks.push(link);
    }
  }
  return deployLinks;
}

export function assertDeployButtonRepositoryLink(source, { expectedRepositoryUrl, label = "README.md" } = {}) {
  const deployLinks = deployButtonLinks(source);

  if (deployLinks.length === 0) {
    throw new Error(`Tracked ${label} does not contain a Deploy to Cloudflare link`);
  }

  for (const link of deployLinks) {
    const repositoryParameters = link.searchParams.getAll("url");
    if (
      repositoryParameters.length === 1
      && isSupportedRepositoryUrl(repositoryParameters[0])
      && (expectedRepositoryUrl === undefined || repositoryParameters[0] === expectedRepositoryUrl)
    ) return;
  }

  const requirement = expectedRepositoryUrl === undefined
    ? "an HTTPS github.com or gitlab.com repository URL"
    : `the exact repository URL ${expectedRepositoryUrl}`;
  throw new Error(
    `Tracked ${label} Deploy to Cloudflare link must set url to ${requirement}`,
  );
}

export function cleanAccountDeployState(validation) {
  const row = String(validation)
    .split(/\r?\n/)
    .find((line) => /^\|\s*Clean-account Cloudflare deploy\s*\|/i.test(line));
  if (!row) throw new Error("Tracked docs/VALIDATION.md is missing the Clean-account Cloudflare deploy result");
  const columns = row.split("|").slice(1, -1).map((value) => value.trim());
  const result = columns[2] ?? "";
  if (/^Pending, not run$/i.test(result)) return "pending";
  if (/^Passed$/i.test(result)) return "passed";
  throw new Error(`Tracked docs/VALIDATION.md has an unsupported Clean-account Cloudflare deploy result: ${result || "missing"}`);
}

export function assertDeployButtonMatchesValidation({
  readme,
  validation,
  expectedRepositoryUrl = PUBLIC_RELEASE_REPOSITORY_URL,
}) {
  return assertDeployButtonsMatchValidation({
    documents: [["README.md", readme]],
    validation,
    expectedRepositoryUrl,
  });
}

export function assertDeployButtonsMatchValidation({
  documents,
  validation,
  expectedRepositoryUrl = PUBLIC_RELEASE_REPOSITORY_URL,
}) {
  const state = cleanAccountDeployState(validation);
  if (state === "pending") {
    const active = documents
      .filter(([, source]) => deployButtonLinks(source).length > 0)
      .map(([label]) => label);
    if (active.length > 0) {
      throw new Error(`Tracked ${active.join(", ")} must not activate Deploy to Cloudflare while clean-account deployment is Pending, not run`);
    }
    return state;
  }
  for (const [label, source] of documents) {
    assertDeployButtonRepositoryLink(source, { expectedRepositoryUrl, label });
  }
  return state;
}

async function defaultValidateArtifact(artifactRoot) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const environment = artifactEnvironment(artifactRoot);
  await runInherited(npmCommand, ["ci", "--no-audit", "--no-fund"], artifactRoot, environment);
  await runInherited(npmCommand, ["run", "check:deploy"], artifactRoot, environment);
}

export async function checkReleaseCandidate({
  root = repositoryRoot,
  revision = "HEAD",
  requiredFiles = REQUIRED_RELEASE_FILES,
  validateArtifact = defaultValidateArtifact,
} = {}) {
  const absoluteRoot = path.resolve(root);
  await runFile("git", ["rev-parse", "--show-toplevel"], { cwd: absoluteRoot });
  await assertInternalWorkspaceUntracked(absoluteRoot);

  const effectiveRequiredFiles = [...new Set([...RELEASE_BOUNDARY_FILES, ...requiredFiles])];

  const [indexedFiles, revisionFiles, indexedPlaceholders, revisionPlaceholders] = await Promise.all([
    gitFileSet(absoluteRoot, ["ls-files", "--cached", "-z"]),
    gitFileSet(absoluteRoot, ["ls-tree", "-r", "-z", "--name-only", revision]),
    placeholderMatches(absoluteRoot, ["grep", "--cached", "-n", "-I", "-F", REPOSITORY_PLACEHOLDER, "--", "."]),
    placeholderMatches(absoluteRoot, ["grep", "-n", "-I", "-F", REPOSITORY_PLACEHOLDER, revision, "--", "."]),
  ]);

  const missingFromIndex = missingFiles(effectiveRequiredFiles, indexedFiles);
  const missingFromRevision = missingFiles(effectiveRequiredFiles, revisionFiles);
  const failures = [];
  if (missingFromIndex.length > 0) failures.push(`Git index is missing: ${missingFromIndex.join(", ")}`);
  if (missingFromRevision.length > 0) failures.push(`${revision} archive is missing: ${missingFromRevision.join(", ")}`);
  if (indexedPlaceholders.length > 0) {
    failures.push(`Git index still contains ${REPOSITORY_PLACEHOLDER}:\n${indexedPlaceholders.join("\n")}`);
  }
  if (revisionPlaceholders.length > 0) {
    failures.push(`${revision} still contains ${REPOSITORY_PLACEHOLDER}:\n${revisionPlaceholders.join("\n")}`);
  }
  if (failures.length > 0) throw new Error(`Release candidate is not self-contained:\n${failures.join("\n")}`);

  const { stdout: revisionOutput } = await runFile("git", ["rev-parse", revision], { cwd: absoluteRoot });
  const revisionId = revisionOutput.trim();

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "driftglass-release-candidate-"));
  const archivePath = path.join(temporaryRoot, "release.tar");
  const artifactRoot = path.join(temporaryRoot, "artifact");
  const packageRoot = path.join(temporaryRoot, "package");
  const packageIndex = path.join(temporaryRoot, "package.index");
  try {
    await mkdir(artifactRoot);
    await mkdir(packageRoot);
    await runFile("git", ["archive", "--format=tar", "--output", archivePath, revision], { cwd: absoluteRoot });
    await runFile("tar", ["-xf", archivePath, "-C", artifactRoot], { cwd: absoluteRoot });
    await assertRegularFiles(artifactRoot, effectiveRequiredFiles);
    await assertForbiddenPathsAbsent(artifactRoot, FORBIDDEN_PUBLIC_RELEASE_PATHS);
    const archivedFiles = await artifactFiles(artifactRoot);
    assertNoForbiddenPaths(archivedFiles, { label: "Tracked release archive", npmPackage: true });
    await assertLocalMarkdownReferencesResolve(artifactRoot, archivedFiles);
    await checkReleasePrivacy({ artifactRoot, repository: absoluteRoot, commit: revisionId });

    await checkoutRevision(absoluteRoot, revision, packageRoot, packageIndex);
    const packedFiles = await npmPackageFiles(packageRoot);
    assertNoForbiddenPaths(packedFiles, { label: "npm package", npmPackage: true });

    let boundaryProfile;
    if (archivedFiles.includes(".gitignore")) {
      boundaryProfile = assertReleaseBoundaryProfile({
        gitAttributes: await readFile(path.join(artifactRoot, ".gitattributes"), "utf8"),
        gitIgnore: await readFile(path.join(artifactRoot, ".gitignore"), "utf8"),
        npmIgnore: await readFile(path.join(artifactRoot, ".npmignore"), "utf8"),
      });
    }

    const archivedPackage = JSON.parse(await readFile(path.join(artifactRoot, "package.json"), "utf8"));
    if (archivedPackage.scripts?.["release:check"] !== "node scripts/check-release-candidate.mjs") {
      throw new Error("Tracked package.json does not expose the release:check command");
    }
    assertNoPrivatePackageScripts(archivedPackage);
    const archivedReadme = await readFile(path.join(artifactRoot, "README.md"), "utf8");
    let cleanAccountState;
    if (archivedFiles.includes("docs/VALIDATION.md")) {
      cleanAccountState = assertDeployButtonsMatchValidation({
        documents: [
          ["README.md", archivedReadme],
          ["docs/DEPLOY.md", await readFile(path.join(artifactRoot, "docs/DEPLOY.md"), "utf8")],
          ["public/install.md", await readFile(path.join(artifactRoot, "public/install.md"), "utf8")],
        ],
        validation: await readFile(path.join(artifactRoot, "docs/VALIDATION.md"), "utf8"),
      });
    } else {
      assertDeployButtonRepositoryLink(archivedReadme);
    }

    await validateArtifact(artifactRoot);
    return {
      revision: revisionId,
      requiredFileCount: effectiveRequiredFiles.length,
      npmPackageFileCount: packedFiles.size,
      boundaryProfile,
      cleanAccountState,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const result = await checkReleaseCandidate();
  process.stdout.write(
    `Release candidate ${result.revision} passed from its tracked archive (${result.requiredFileCount} required files).\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
