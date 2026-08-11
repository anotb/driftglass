import assert from "node:assert/strict";
import { test } from "node:test";

import { renderWalkthroughMusic } from "../scripts/build-walkthrough-music.mjs";

test("walkthrough score is deterministic original stereo PCM with clean boundaries", () => {
  const options = { durationSeconds: 4, sampleRate: 48_000, channels: 2 };
  const first = renderWalkthroughMusic(options);
  const second = renderWalkthroughMusic(options);
  assert.deepEqual(first, second);
  assert.equal(first.toString("ascii", 0, 4), "RIFF");
  assert.equal(first.toString("ascii", 8, 12), "WAVE");
  assert.equal(first.toString("ascii", 12, 16), "fmt ");
  assert.equal(first.readUInt16LE(20), 1);
  assert.equal(first.readUInt16LE(22), 2);
  assert.equal(first.readUInt32LE(24), 48_000);
  assert.equal(first.readUInt16LE(34), 16);
  assert.equal(first.toString("ascii", 36, 40), "data");
  assert.equal(first.length, 44 + 4 * 48_000 * 2 * 2);

  const left = [];
  const right = [];
  let peak = 0;
  for (let offset = 44; offset < first.length; offset += 4) {
    const leftSample = first.readInt16LE(offset);
    const rightSample = first.readInt16LE(offset + 2);
    left.push(leftSample);
    right.push(rightSample);
    peak = Math.max(peak, Math.abs(leftSample), Math.abs(rightSample));
  }
  assert.equal(left[0], 0);
  assert.equal(right[0], 0);
  assert.ok(peak <= 16_426, "score peaks at or below -6 dBFS");
  assert.ok(left.some((sample) => Math.abs(sample) > 1_000));
  assert.ok(right.some((sample) => Math.abs(sample) > 1_000));
  assert.notDeepEqual(left.slice(2_000, 2_200), right.slice(2_000, 2_200), "stereo channels carry distinct, mono-compatible voicings");
  assert.ok(left.slice(-64).every((sample) => Math.abs(sample) <= 4));
  assert.ok(right.slice(-64).every((sample) => Math.abs(sample) <= 4));
});
