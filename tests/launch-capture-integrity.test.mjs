import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectLaunchCaptureInputEntries,
  launchCaptureInputFingerprint,
  modelInsertManifestBinding,
} from "../scripts/build-launch-assets.mjs";
import { parseFfmpegMaxVolume, resolveLaunchModelInsertBinding } from "../scripts/check-launch-assets.mjs";
import { loadApprovedModelInsertBinding } from "../scripts/capture-launch-assets.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function approvedInsert(insertSha256, overrides = {}) {
  return {
    insertSha256,
    reviewedFrameCount: 360,
    conversationOnly: true,
    noBrowserChrome: true,
    noSidebar: true,
    noAccountUi: true,
    noOtherChats: true,
    ...overrides,
  };
}

test("launch capture fingerprint changes with source, insert, or approval input", () => {
  const insertSha256 = digest("approved insert");
  const inputEntries = [
    { path: "public/index.html", sha256: digest("index") },
    { path: "src/drop-capsule.ts", sha256: digest("renderer") },
  ];
  const approval = approvedInsert(insertSha256);
  const binding = modelInsertManifestBinding({ modelInsertSha256: insertSha256, modelInsertApproval: approval });
  const fingerprint = launchCaptureInputFingerprint({ inputEntries, modelInsertBinding: binding });
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(launchCaptureInputFingerprint({ inputEntries: [...inputEntries].reverse(), modelInsertBinding: binding }), fingerprint);
  assert.notEqual(
    launchCaptureInputFingerprint({ inputEntries: [{ ...inputEntries[0], sha256: digest("changed index") }, inputEntries[1]], modelInsertBinding: binding }),
    fingerprint,
  );
  assert.notEqual(
    launchCaptureInputFingerprint({ inputEntries, modelInsertBinding: modelInsertManifestBinding({ modelInsertSha256: digest("different insert"), modelInsertApproval: { ...approval, insertSha256: digest("different insert") } }) }),
    fingerprint,
  );
  assert.notEqual(
    launchCaptureInputFingerprint({ inputEntries, modelInsertBinding: modelInsertManifestBinding({ modelInsertSha256: insertSha256, modelInsertApproval: { ...approval, reviewNote: "changed" } }) }),
    fingerprint,
  );
});

test("launch capture inventory includes browser inputs and transitive production renderers", async () => {
  const paths = new Set((await collectLaunchCaptureInputEntries()).map((entry) => entry.path));
  for (const requiredPath of [
    "public/index.html",
    "public/sw.js",
    "public/webmcp.js",
    "public/icons/driftglass.svg",
    "public/icons/driftglass-og.png",
    "public/lenses/schema.json",
    "public/lenses/catalog.json",
    "public/intelligence-packs/schema.json",
    "public/intelligence-packs/catalog.json",
    "scripts/capture-launch-assets.mjs",
    "src/db.ts",
    "src/zip.ts",
  ]) {
    assert.ok(paths.has(requiredPath), `capture fingerprint includes ${requiredPath}`);
  }
  assert.ok([...paths].some((inputPath) => inputPath.startsWith("node_modules/@cfworker/json-schema/")), "capture fingerprint includes bundled renderer dependencies");
  assert.ok([...paths].every((inputPath) => !inputPath.startsWith("launch-cloudflare-workers:")), "capture fingerprint excludes virtual modules that have no file bytes");
});

test("approved model insert binding is required and hash-bound", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "driftglass-model-insert-"));
  const insertPath = path.join(directory, "insert.mp4");
  const approvalPath = path.join(directory, "approval.json");
  try {
    await assert.rejects(
      loadApprovedModelInsertBinding({ insertPath, approvalPath }),
      /approved model insert is required/i,
    );
    const insert = Buffer.from("silent conversation crop");
    const insertSha256 = digest(insert);
    await writeFile(insertPath, insert);
    await writeFile(approvalPath, `${JSON.stringify(approvedInsert(insertSha256))}\n`);
    const binding = await loadApprovedModelInsertBinding({ insertPath, approvalPath });
    assert.equal(binding.insertSha256, insertSha256);
    assert.deepEqual(binding.approval, approvedInsert(insertSha256));
    assert.deepEqual(binding.manifestBinding, modelInsertManifestBinding({ modelInsertSha256: insertSha256, modelInsertApproval: approvedInsert(insertSha256) }));
    await writeFile(approvalPath, `${JSON.stringify(approvedInsert(insertSha256, { noOtherChats: false }))}\n`);
    await assert.rejects(
      loadApprovedModelInsertBinding({ insertPath, approvalPath }),
      /does not bind noOtherChats to true/,
    );
    await writeFile(approvalPath, `${JSON.stringify(approvedInsert(digest("wrong insert")))}\n`);
    await assert.rejects(
      loadApprovedModelInsertBinding({ insertPath, approvalPath }),
      /does not bind insertSha256/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("launch check requires private insert files only in the source profile", async () => {
  const insertSha256 = digest("approved insert");
  const persistedBinding = modelInsertManifestBinding({
    modelInsertSha256: insertSha256,
    modelInsertApproval: approvedInsert(insertSha256),
  });
  let loadCount = 0;
  const matchingSource = async () => {
    loadCount += 1;
    return { manifestBinding: persistedBinding };
  };
  assert.deepEqual(await resolveLaunchModelInsertBinding({
    sourceProfile: false,
    persistedBinding,
    loadSourceBinding: async () => { throw new Error("public root must not read ignored source files"); },
  }), persistedBinding);
  assert.deepEqual(await resolveLaunchModelInsertBinding({ sourceProfile: true, persistedBinding, loadSourceBinding: matchingSource }), persistedBinding);
  assert.equal(loadCount, 1);
  await assert.rejects(
    resolveLaunchModelInsertBinding({
      sourceProfile: true,
      persistedBinding,
      loadSourceBinding: async () => ({ manifestBinding: { ...persistedBinding, approvalDigest: digest("other approval") } }),
    }),
    /source checkout model insert and approval match/,
  );
});

test("walkthrough audio-edge parser fails closed", () => {
  assert.equal(parseFfmpegMaxVolume("[Parsed_volumedetect] max_volume: -41.2 dB"), -41.2);
  assert.equal(parseFfmpegMaxVolume("[Parsed_volumedetect] max_volume: -inf dB"), -Infinity);
  for (const invalid of [
    "volumedetect completed without a peak",
    "max_volume: NaN dB",
    "max_volume: inf dB",
    "max_volume: -INF dB",
    "max_volume: -Infinity dB",
  ]) {
    assert.throws(() => parseFfmpegMaxVolume(invalid), /finite max_volume or explicit -inf/);
  }
});
