#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify, TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf16LittleEndianDecoder = new TextDecoder("utf-16le", { fatal: true });
const utf16BigEndianDecoder = new TextDecoder("utf-16be", { fatal: true });

const CREDENTIAL_PREFIX_RULES = Object.freeze([
  ["credential-prefix/aws", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["credential-prefix/github", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{40,255})\b/],
  ["credential-prefix/gitlab", /\bglpat-[A-Za-z0-9_-]{20,255}\b/],
  ["credential-prefix/google", /\bAIza[A-Za-z0-9_-]{35}\b/],
  ["credential-prefix/npm", /\bnpm_[A-Za-z0-9]{36,255}\b/],
  ["credential-prefix/openai", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,255}\b/],
  ["credential-prefix/pypi", /\bpypi-AgEIcH[A-Za-z0-9_-]{40,255}\b/],
  ["credential-prefix/slack", /\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/],
  ["credential-prefix/stripe", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,255}\b/],
]);

const PRIVATE_KEY_HEADER = /-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED) )?PRIVATE KEY(?: BLOCK)?-----/;
const KNOWN_SECRET_NAMES = Object.freeze([
  "ACCESS[_-]?TOKEN",
  "API[_-]?KEY",
  "AUTH[_-]?TOKEN",
  "BRIDGE[_-]?SECRET",
  "CLIENT[_-]?SECRET",
  "CLOUDFLARE[_-]?API[_-]?TOKEN",
  "COOKIE[_-]?SIGNING[_-]?KEY",
  "DEEP[_-]?DIVE[_-]?LAB[_-]?(?:SECRET|TOKEN)",
  "DRIFTGLASS[_-]?SECRET",
  "GITHUB[_-]?TOKEN",
  "OPENALEX[_-]?API[_-]?KEY",
  "OPERATIONS[_-]?KEY",
  "OWNER[_-]?SECRET",
  "PASSWORD",
  "PRIVATE[_-]?KEY",
  "READ[_-]?KEY",
  "REFRESH[_-]?TOKEN",
  "SECRET",
  "SESSION[_-]?SECRET",
  "SIGNING[_-]?KEY",
  "TOKEN",
]);
const SECRET_ASSIGNMENT = new RegExp(
  `(?:^|[\\s{,])["'\`]?(?:${KNOWN_SECRET_NAMES.join("|")})["'\`]?\\s*(?:=|:)\\s*(?:"([^"\\r\\n]{24,4096})"|'([^'\\r\\n]{24,4096})'|\`([^\`\\r\\n]{24,4096})\`|([A-Za-z0-9+/_=.:-]{24,4096})(?=\\s*(?:#|$|[,;}\\]])))`,
  "gi",
);
const ALLOWED_SECRET_VALUES = new Set([
  "change-me",
  "example-secret",
  "not-sent",
  "replace-me",
  "test-secret",
  "your-secret-here",
]);
const ALLOWED_CAPABILITY_VALUES = new Set([
  "YOUR-PRIVATE-KEY",
  "{operationsKey}",
  "{private-operations-key}",
  "{private-read-key}",
  "{readKey}",
]);
const CAPABILITY_QUERY_NAMES = new Set([
  "access_token",
  "capability",
  "key",
  "operations_key",
  "read_key",
  "secret",
  "token",
]);
const CAPABILITY_PATH_PREFIXES = new Set(["corpus", "feedback", "mcp", "packet", "share"]);
const ALLOWED_PATH_USERS = new Set(["example", "runner", "shared", "user", "username"]);

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function looksHighEntropy(value) {
  const candidate = String(value).trim();
  if (candidate.length < 24 || candidate.length > 4096) return false;
  if (ALLOWED_SECRET_VALUES.has(candidate.toLowerCase())) return false;

  const entropy = shannonEntropy(candidate);
  if (/^[a-f0-9]{32,}$/i.test(candidate)) return entropy >= 3.2;

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]
    .filter((pattern) => pattern.test(candidate)).length;
  if (classes >= 3) return entropy >= 3.5;
  return /^[A-Za-z0-9]+$/.test(candidate) && entropy >= 4;
}

function hasCredentialPrefix(value) {
  return CREDENTIAL_PREFIX_RULES.some(([, pattern]) => pattern.test(value));
}

function looksCapabilityBearing(value) {
  if (ALLOWED_CAPABILITY_VALUES.has(value)) return false;
  return hasCredentialPrefix(value) || looksHighEntropy(value);
}

function capabilityUrlOnLine(line) {
  const urls = line.match(/\bhttps?:\/\/[^\s<>"'`()\[\]]+/gi) ?? [];
  for (const rawUrl of urls) {
    let parsed;
    try {
      parsed = new URL(rawUrl.replace(/[.,;:!?]+$/, ""));
    } catch {
      continue;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (!CAPABILITY_PATH_PREFIXES.has(segments[index].toLowerCase())) continue;
      let capability = segments[index + 1];
      try {
        capability = decodeURIComponent(capability);
      } catch {
        // Invalid URL escapes cannot become a valid capability.
      }
      if (looksCapabilityBearing(capability)) return true;
    }

    for (const [name, value] of parsed.searchParams) {
      if (CAPABILITY_QUERY_NAMES.has(name.toLowerCase()) && looksCapabilityBearing(value)) return true;
    }
  }
  return false;
}

function personalPathOnLine(line) {
  const pathText = line.replace(/\bhttps?:\/\/[^\s<>"'`()\[\]]+/gi, "");
  for (const match of pathText.matchAll(/\/(?:Users|home)\/([^/\s"'`<>:]+)/g)) {
    if (!ALLOWED_PATH_USERS.has(match[1].toLowerCase())) return true;
  }
  for (const match of pathText.matchAll(/\b[A-Za-z]:\\+Users\\+([^\\/\s"'`<>:]+)/gi)) {
    if (!ALLOWED_PATH_USERS.has(match[1].toLowerCase())) return true;
  }
  return false;
}

export function findPrivacyFindings(text, { file, commit }) {
  const findings = [];
  const seen = new Set();
  const lines = String(text).split(/\r\n|\n|\r/);

  function add(rule, line) {
    const key = `${rule}\0${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, path: file, line, commit });
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    for (const [rule, pattern] of CREDENTIAL_PREFIX_RULES) {
      if (pattern.test(line)) add(rule, lineNumber);
    }
    if (PRIVATE_KEY_HEADER.test(line)) add("private-key-header", lineNumber);

    SECRET_ASSIGNMENT.lastIndex = 0;
    for (const match of line.matchAll(SECRET_ASSIGNMENT)) {
      if (looksHighEntropy(match[1] ?? match[2] ?? match[3] ?? match[4])) {
        add("high-entropy-secret-assignment", lineNumber);
      }
    }
    if (capabilityUrlOnLine(line)) add("capability-bearing-url", lineNumber);
    if (personalPathOnLine(line)) add("personal-absolute-path", lineNumber);
  }
  return findings;
}

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    try {
      return utf16LittleEndianDecoder.decode(buffer);
    } catch {
      return null;
    }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    try {
      return utf16BigEndianDecoder.decode(buffer);
    } catch {
      return null;
    }
  }
  if (buffer.includes(0)) return null;
  try {
    return utf8Decoder.decode(buffer);
  } catch {
    return null;
  }
}

async function walkRegularFiles(root, current = root) {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkRegularFiles(root, target));
    else {
      const metadata = await lstat(target);
      if (metadata.isFile()) files.push(target);
    }
  }
  return files;
}

export async function scanExtractedReleaseTree(root, commit) {
  const absoluteRoot = path.resolve(root);
  const findings = [];
  for (const file of await walkRegularFiles(absoluteRoot)) {
    const text = decodeText(await readFile(file));
    if (text === null) continue;
    const relativePath = path.relative(absoluteRoot, file).split(path.sep).join("/");
    findings.push(...findPrivacyFindings(text, { file: relativePath, commit }));
  }
  return findings;
}

async function gitOutput(root, args, { binary = false } = {}) {
  const { stdout } = await execFile("git", args, {
    cwd: root,
    encoding: binary ? null : "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function parseTreeEntries(buffer) {
  const entries = [];
  for (const record of buffer.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object] = record.slice(0, tab).split(" ");
    if (type === "blob") entries.push({ mode, object, path: record.slice(tab + 1) });
  }
  return entries;
}

export async function scanReachableGitHistory(root = repositoryRoot) {
  const absoluteRoot = path.resolve(root);
  const shallow = String(await gitOutput(absoluteRoot, ["rev-parse", "--is-shallow-repository"])).trim();
  if (shallow === "true") {
    throw new Error("Release privacy history scan requires a complete Git clone; shallow history is not sufficient.");
  }
  const commitsRaw = await gitOutput(absoluteRoot, ["rev-list", "--all", "HEAD"]);
  const commits = [...new Set(String(commitsRaw).split(/\r?\n/).filter(Boolean))];
  const findings = [];
  const textByObject = new Map();
  const seenObjectPaths = new Set();

  for (const commit of commits) {
    const tree = await gitOutput(
      absoluteRoot,
      ["ls-tree", "-r", "-z", "--full-tree", commit],
      { binary: true },
    );
    for (const entry of parseTreeEntries(tree)) {
      const contextKey = `${entry.object}\0${entry.path}`;
      if (seenObjectPaths.has(contextKey)) continue;
      seenObjectPaths.add(contextKey);

      if (!textByObject.has(entry.object)) {
        const blob = await gitOutput(absoluteRoot, ["cat-file", "blob", entry.object], { binary: true });
        textByObject.set(entry.object, decodeText(blob));
      }
      const text = textByObject.get(entry.object);
      if (text === null) continue;
      findings.push(...findPrivacyFindings(text, { file: entry.path, commit }));
    }
  }
  return findings;
}

function uniqueSortedFindings(findings) {
  const unique = new Map();
  for (const finding of findings) {
    const key = `${finding.rule}\0${finding.path}\0${finding.line}\0${finding.commit}`;
    unique.set(key, finding);
  }
  return [...unique.values()].sort((left, right) => (
    left.commit.localeCompare(right.commit)
    || left.path.localeCompare(right.path)
    || left.line - right.line
    || left.rule.localeCompare(right.rule)
  ));
}

export function assertNoPrivacyFindings(findings) {
  const ordered = uniqueSortedFindings(findings);
  if (ordered.length === 0) return;
  const details = ordered.map((finding) => (
    `rule=${JSON.stringify(finding.rule)} path=${JSON.stringify(finding.path)} line=${finding.line} commit=${JSON.stringify(finding.commit)}`
  ));
  throw new Error(`Release privacy scan failed:\n${details.join("\n")}`);
}

export async function checkReleasePrivacy({ artifactRoot, repository = repositoryRoot, commit }) {
  const [treeFindings, historyFindings] = await Promise.all([
    scanExtractedReleaseTree(artifactRoot, commit),
    scanReachableGitHistory(repository),
  ]);
  assertNoPrivacyFindings([...treeFindings, ...historyFindings]);
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--history") {
    throw new Error("Usage: node scripts/check-release-privacy.mjs --history");
  }
  const findings = await scanReachableGitHistory(repositoryRoot);
  assertNoPrivacyFindings(findings);
  process.stdout.write("Release privacy history scan passed for all reachable Git blobs.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
