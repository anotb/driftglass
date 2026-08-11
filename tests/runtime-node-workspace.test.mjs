import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const nodeMajor = Number(process.versions.node.split(".", 1)[0]);
const nodeMinor = Number(process.versions.node.split(".")[1] ?? 0);
const node24 = nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 4) ? test : test.skip;
const cleanupRoots = [];

after(() => {
  for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
});

node24("local Mission workspaces never follow a symbolic-link escape", async () => {
  const { LocalMissionWorkspacePort } = require("../.test-dist/runtime/node/workspace.js");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "driftglass-local-workspace-"));
  cleanupRoots.push(root);
  const store = new LocalMissionWorkspacePort(root);
  const workspace = await store.forMission("workspace-symlink-regression");
  await workspace.fs.mkdir("/notes", { recursive: true });
  await workspace.fs.writeFile("/notes/safe.md", "private Mission note");

  const directories = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.equal(directories.length, 1);
  const escape = join(root, directories[0].name, "notes", process.platform === "win32" ? "escape" : "escape.md");
  symlinkSync(process.platform === "win32" ? "C:\\Windows" : "/etc/hosts", escape, process.platform === "win32" ? "junction" : "file");
  const unsafePath = process.platform === "win32" ? "/notes/escape/win.ini" : "/notes/escape.md";

  await assert.rejects(
    () => workspace.fs.readFile(unsafePath, "utf8"),
    (error) => error?.code === "ERR_DRIFTGLASS_WORKSPACE_PATH",
  );
  assert.equal(await workspace.fs.readFile("/notes/safe.md", "utf8"), "private Mission note");
  assert.equal(workspace.runtime, undefined);
});
