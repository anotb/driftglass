import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { checkReleaseCandidate } from "../scripts/check-release-candidate.mjs";
import {
  assertNoPrivacyFindings,
  findPrivacyFindings,
} from "../scripts/check-release-privacy.mjs";

const execFile = promisify(execFileCallback);
const VALID_DEPLOY_BUTTON = "[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fexample%2Fdriftglass)\n";
const VALID_GIT_ATTRIBUTES = await readFile(new URL("../.gitattributes", import.meta.url), "utf8");
const VALID_NPM_IGNORE = await readFile(new URL("../.npmignore", import.meta.url), "utf8");
const fixtureRequiredFiles = ["package.json", "README.md"];

async function git(root, ...args) {
  const { stdout } = await execFile("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

async function writeFixtureFile(root, file, content) {
  const destination = path.join(root, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

async function fixtureRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "driftglass-release-privacy-test-"));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Driftglass Privacy Test");
  await git(root, "config", "user.email", "privacy-test@invalid.example");
  await writeFixtureFile(root, ".gitattributes", VALID_GIT_ATTRIBUTES);
  await writeFixtureFile(root, ".npmignore", VALID_NPM_IGNORE);
  await writeFixtureFile(root, "README.md", VALID_DEPLOY_BUTTON);
  await writeFixtureFile(root, "package.json", `${JSON.stringify({
    name: "driftglass-privacy-fixture",
    version: "1.0.0",
    private: true,
    scripts: { "release:check": "node scripts/check-release-candidate.mjs" },
  }, null, 2)}\n`);
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "safe base");
  return root;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

test("privacy findings are narrow and never print matched values", () => {
  const credential = ["ghp", "A1".repeat(18)].join("_");
  const privateKeyHeader = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
  const assignedSecret = [
    "eyJhbGciOiJIUzI1NiJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "VeryLongSignature_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  ].join(".");
  const quotedPassword = ["v9!Qp@2#Lm$8^Rt", "&4*Wx(6)Za-0_Ne+7"].join("");
  const capability = "0123456789abcdef".repeat(4);
  const capabilityUrl = `https://private.example/corpus/${capability}/index.html`;
  const personalPath = ["", "Users", "private-person", "driftglass", "notes.txt"].join("/");
  const windowsPersonalPath = ["C:", "Users", "private-person", "driftglass", "notes.txt"].join("\\\\");
  const source = [
    credential,
    privateKeyHeader,
    `authToken=${assignedSecret}`,
    `PASSWORD="${quotedPassword}"`,
    capabilityUrl,
    personalPath,
    windowsPersonalPath,
  ].join("\n");
  const commit = "a".repeat(40);
  const findings = findPrivacyFindings(source, { file: "config/release.env", commit });
  assert.deepEqual(new Set(findings.map((finding) => finding.rule)), new Set([
    "credential-prefix/github",
    "private-key-header",
    "high-entropy-secret-assignment",
    "capability-bearing-url",
    "personal-absolute-path",
  ]));
  assert.deepEqual(
    findings.filter((finding) => finding.rule === "high-entropy-secret-assignment").map((finding) => finding.line),
    [3, 4],
  );
  assert.deepEqual(
    findings.filter((finding) => finding.rule === "personal-absolute-path").map((finding) => finding.line),
    [6, 7],
  );

  assert.throws(
    () => assertNoPrivacyFindings(findings),
    (error) => {
      const message = errorMessage(error);
      for (const value of [credential, privateKeyHeader, assignedSecret, quotedPassword, capability, capabilityUrl, personalPath, windowsPersonalPath]) {
        assert.doesNotMatch(message, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      for (const line of message.split("\n").slice(1)) {
        assert.match(line, /^rule="[^"]+" path="config\/release\.env" line=\d+ commit="a{40}"$/);
      }
      return true;
    },
  );
});

test("exact release placeholders remain allowed", () => {
  const source = [
    "DRIFTGLASS_SECRET=replace-me",
    "https://YOUR-DRIFTGLASS/mcp/YOUR-PRIVATE-KEY",
    "https://docs.example/home/alice/project",
    "/home/user/driftglass",
  ].join("\n");
  assert.deepEqual(findPrivacyFindings(source, { file: ".dev.vars.example", commit: "b".repeat(40) }), []);
});

test("Driftglass bearer routes are capability-bearing URLs", () => {
  const capability = "abcdef0123456789".repeat(4);
  for (const route of [
    `https://private.example/corpus/${capability}/index.html`,
    `https://private.example/feedback/${capability}/story-id/track`,
  ]) {
    assert.deepEqual(
      findPrivacyFindings(route, { file: "release-notes.txt", commit: "c".repeat(40) })
        .map((finding) => finding.rule),
      ["capability-bearing-url"],
    );
  }
});

test("release gate rejects a privacy finding in the extracted current tree before validation", async () => {
  const root = await fixtureRepository();
  const assignedSecret = ["0f1e2d3c4b5a6978", "89abcdef01234567", "76543210fedcba98"].join("");
  let validated = false;
  try {
    await writeFixtureFile(root, "private.env", `DRIFTGLASS_SECRET=${assignedSecret}\n`);
    await git(root, "add", "private.env");
    await git(root, "commit", "--quiet", "-m", "current tree leak");
    await assert.rejects(
      checkReleaseCandidate({
        root,
        requiredFiles: fixtureRequiredFiles,
        validateArtifact: async () => { validated = true; },
      }),
      (error) => {
        const message = errorMessage(error);
        assert.match(message, /rule="high-entropy-secret-assignment" path="private\.env" line=1 commit="[a-f0-9]{40}"/);
        assert.doesNotMatch(message, new RegExp(assignedSecret));
        return true;
      },
    );
    assert.equal(validated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release gate rejects a privacy finding removed from the current tree but reachable in history", async () => {
  const root = await fixtureRepository();
  const credential = ["ghp", "Z9".repeat(18)].join("_");
  let validated = false;
  try {
    await writeFixtureFile(root, "removed-secret.txt", `${credential}\n`);
    await git(root, "add", "removed-secret.txt");
    await git(root, "commit", "--quiet", "-m", "historic leak");
    const leakedCommit = await git(root, "rev-parse", "HEAD");
    await unlink(path.join(root, "removed-secret.txt"));
    await git(root, "add", "-A");
    await git(root, "commit", "--quiet", "-m", "remove leak from tree");

    await assert.rejects(
      checkReleaseCandidate({
        root,
        requiredFiles: fixtureRequiredFiles,
        validateArtifact: async () => { validated = true; },
      }),
      (error) => {
        const message = errorMessage(error);
        assert.match(
          message,
          new RegExp(`rule="credential-prefix/github" path="removed-secret\\.txt" line=1 commit="${leakedCommit}"`),
        );
        assert.doesNotMatch(message, new RegExp(credential));
        return true;
      },
    );
    assert.equal(validated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
