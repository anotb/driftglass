import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentDigest, verifyGeneratedFiles } from "../scripts/generated-assets.mjs";

const root = new URL("../", import.meta.url);

test("generated asset revisions are deterministic and content-addressed", () => {
  const source = { schemaVersion: 1, entries: [{ id: "one", enabled: true }] };
  const first = contentDigest(source);
  const second = contentDigest(source);

  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(first, contentDigest({ ...source, entries: [{ id: "two", enabled: true }] }));
});

test("generated asset verification compares without writing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "driftglass-generated-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "one.txt"), "one\n");
  await writeFile(join(directory, "two.txt"), "two\n");
  const output = new URL(`file://${directory}/`);
  const expected = new Map([["one.txt", "one\n"], ["two.txt", Buffer.from("two\n")]]);
  const before = await Promise.all([...expected.keys()].map(async (file) => ({
    file,
    bytes: await readFile(join(directory, file)),
    mtimeNs: (await stat(join(directory, file), { bigint: true })).mtimeNs,
  })));

  await verifyGeneratedFiles(output, expected, "Test output");
  const after = await Promise.all([...expected.keys()].map(async (file) => ({
    file,
    bytes: await readFile(join(directory, file)),
    mtimeNs: (await stat(join(directory, file), { bigint: true })).mtimeNs,
  })));
  assert.deepEqual(after, before);

  const stale = new Map(expected);
  stale.set("one.txt", "changed\n");
  await assert.rejects(verifyGeneratedFiles(output, stale, "Test output"), /asset is stale: one\.txt/);
  assert.equal(await readFile(join(directory, "one.txt"), "utf8"), "one\n");
});

test("catalogs and Companion manifest carry only source-derived revision metadata", async () => {
  for (const file of [
    "public/lenses/catalog.json",
    "public/intelligence-packs/catalog.json",
    "public/relay/manifest.json",
  ]) {
    const artifact = JSON.parse(await readFile(new URL(file, root), "utf8"));
    const { contentDigest: revision, ...sourceContent } = artifact;
    assert.equal(revision, contentDigest(sourceContent), file);
    assert.equal("generatedAt" in artifact, false, file);
  }
});

test("repository checks verify generated assets instead of healing them", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.doesNotMatch(pkg.scripts.check, /npm run build/);
  assert.doesNotMatch(pkg.scripts.test, /sync:(?:relay|lenses|intelligence-packs)/);
  assert.match(pkg.scripts.build, /sync:relay/);
  for (const name of ["relay:assets:check", "lenses:check", "intelligence-packs:check", "migrations:check"]) {
    assert.match(pkg.scripts[name], /--check$/, name);
  }

  for (const file of [
    "scripts/sync-lenses.mjs",
    "scripts/sync-intelligence-packs.mjs",
    "scripts/sync-relay-assets.mjs",
  ]) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.match(source, /verifyGeneratedFiles/);
    assert.doesNotMatch(source, /new Date|Date\.now|SOURCE_DATE_EPOCH/, file);
  }
});
