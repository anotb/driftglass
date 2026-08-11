#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WALKTHROUGH_AUDIO_CHANNELS,
  WALKTHROUGH_AUDIO_SAMPLE_RATE,
  WALKTHROUGH_DURATION_SECONDS,
  WALKTHROUGH_MODEL_INSERT_END_SECONDS,
  WALKTHROUGH_MODEL_INSERT_START_SECONDS,
} from "./walkthrough-contract.mjs";

// Original Driftglass score synthesized from the note and envelope data below.
// It contains no recorded samples or third-party audio.
const SCORE_CELLS = Object.freeze([
  { root: 38, voices: [50, 57, 60, 64] },
  { root: 34, voices: [46, 53, 57, 62] },
  { root: 36, voices: [48, 55, 62, 64] },
  { root: 38, voices: [50, 57, 60, 64] },
  { root: 31, voices: [43, 50, 52, 57] },
  { root: 34, voices: [46, 53, 57, 62] },
  { root: 36, voices: [48, 55, 62, 64] },
  { root: 38, voices: [50, 57, 60, 64] },
  { root: 29, voices: [41, 48, 57, 62] },
  { root: 36, voices: [48, 55, 62, 64] },
  { root: 38, voices: [50, 57, 60, 64] },
  { root: 34, voices: [46, 53, 57, 62] },
  { root: 31, voices: [43, 50, 53, 57] },
  { root: 33, voices: [45, 52, 59, 62] },
  { root: 34, voices: [46, 53, 57, 62] },
  { root: 38, voices: [50, 55, 60, 64] },
  { root: 38, voices: [50, 57, 60, 64] },
]);

const TAU = Math.PI * 2;

function midiFrequency(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function raisedCosine(value) {
  const t = clamp(value);
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

function cellEnvelope(localTime, cellSeconds) {
  const attack = raisedCosine(localTime / 0.28);
  const release = raisedCosine((cellSeconds - localTime) / 0.8);
  return Math.min(attack, release);
}

function oscillator(frequency, time, channelPhase = 0) {
  const phase = TAU * frequency * time + channelPhase;
  return Math.sin(phase) + 0.18 * Math.sin(phase * 2 + 0.19) + 0.05 * Math.sin(phase * 3 + 0.41);
}

function padSample(cell, time, localTime, cellSeconds, channel) {
  const channelPhase = channel === 0 ? -0.035 : 0.035;
  const panWeights = channel === 0 ? [0.95, 0.74, 0.52, 0.34] : [0.34, 0.52, 0.74, 0.95];
  let value = 0;
  for (let index = 0; index < cell.voices.length; index += 1) {
    value += oscillator(midiFrequency(cell.voices[index]), time, channelPhase * (index + 1)) * panWeights[index];
  }
  return value * cellEnvelope(localTime, cellSeconds) * 0.018;
}

function pluckSample(cell, time, localTime, channel, cellIndex) {
  const interval = 0.5;
  const step = Math.floor(localTime / interval);
  const stepTime = localTime - step * interval;
  const modelAnswerIsVisible = time >= WALKTHROUGH_MODEL_INSERT_START_SECONDS && time < WALKTHROUGH_MODEL_INSERT_END_SECONDS;
  if (stepTime > 0.82 || (modelAnswerIsVisible && step % 2 === 1)) return 0;
  const voice = cell.voices[(step + cellIndex) % cell.voices.length] + 12;
  const attack = raisedCosine(stepTime / 0.012);
  const decay = Math.exp(-stepTime * 5.5);
  const phase = TAU * midiFrequency(voice) * time + (channel === 0 ? -0.08 : 0.08);
  const pan = (step + cellIndex) % 2 === channel ? 0.85 : 0.38;
  return (Math.sin(phase) + 0.24 * Math.sin(phase * 2 + 0.23)) * attack * decay * pan * 0.018;
}

function bassSample(cell, time, localTime) {
  const modelAnswerIsVisible = time >= WALKTHROUGH_MODEL_INSERT_START_SECONDS && time < WALKTHROUGH_MODEL_INSERT_END_SECONDS;
  if (modelAnswerIsVisible || time >= 24) return 0;
  const pulseSeconds = 1;
  const pulseTime = localTime % pulseSeconds;
  const attack = raisedCosine(pulseTime / 0.015);
  const decay = Math.exp(-pulseTime * 4.2);
  const phase = TAU * midiFrequency(cell.root) * time;
  return (Math.sin(phase) + 0.08 * Math.sin(phase * 2 + 0.31)) * attack * decay * 0.026;
}

function accentSample(time, channel) {
  let value = 0;
  for (const cue of [4.05, WALKTHROUGH_MODEL_INSERT_END_SECONDS, 23.95]) {
    const local = time - cue;
    if (local < 0 || local > 1.2) continue;
    const attack = raisedCosine(local / 0.018);
    const decay = Math.exp(-local * 4.6);
    const frequency = midiFrequency(channel === 0 ? 74 : 81);
    value += Math.sin(TAU * frequency * local) * attack * decay * 0.012;
  }
  return value;
}

function masterEnvelope(time, durationSeconds) {
  const fadeIn = raisedCosine(time / 0.45);
  const fadeOut = time < durationSeconds - 1.8 ? 1 : raisedCosine((durationSeconds - time) / 1.8);
  return Math.min(fadeIn, fadeOut);
}

function writeWavHeader(buffer, sampleFrames, sampleRate, channels) {
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = sampleFrames * blockAlign;
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
}

export function renderWalkthroughMusic({
  durationSeconds = WALKTHROUGH_DURATION_SECONDS,
  sampleRate = WALKTHROUGH_AUDIO_SAMPLE_RATE,
  channels = WALKTHROUGH_AUDIO_CHANNELS,
} = {}) {
  if (!(durationSeconds > 0) || !Number.isInteger(sampleRate) || sampleRate < 8_000 || channels !== 2) {
    throw new Error("Walkthrough score requires a positive duration and 48 kHz-style stereo PCM output");
  }
  const sampleFrames = Math.round(durationSeconds * sampleRate);
  const floatSamples = new Float64Array(sampleFrames * channels);
  const cellSeconds = durationSeconds / SCORE_CELLS.length;
  let peak = 0;
  for (let frame = 0; frame < sampleFrames; frame += 1) {
    const time = frame / sampleRate;
    const cellIndex = Math.min(SCORE_CELLS.length - 1, Math.floor(time / cellSeconds));
    const localTime = time - cellIndex * cellSeconds;
    const cell = SCORE_CELLS[cellIndex];
    const envelope = masterEnvelope(time, durationSeconds);
    for (let channel = 0; channel < channels; channel += 1) {
      const value = envelope * (
        padSample(cell, time, localTime, cellSeconds, channel)
        + pluckSample(cell, time, localTime, channel, cellIndex)
        + bassSample(cell, time, localTime)
        + accentSample(time, channel)
      );
      floatSamples[frame * channels + channel] = value;
      peak = Math.max(peak, Math.abs(value));
    }
  }
  const targetPeak = 10 ** (-6 / 20);
  const gain = peak > 0 ? targetPeak / peak : 1;
  const buffer = Buffer.alloc(44 + sampleFrames * channels * 2);
  writeWavHeader(buffer, sampleFrames, sampleRate, channels);
  for (let index = 0; index < floatSamples.length; index += 1) {
    const sample = Math.round(clamp(floatSamples[index] * gain, -1, 1) * 32_767);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  return buffer;
}

export async function writeWalkthroughMusic(outputPath, options = {}) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const buffer = renderWalkthroughMusic(options);
  await writeFile(outputPath, buffer);
  return { outputPath, bytes: buffer.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputPath = path.resolve(process.argv[2] || "output/launch-assets/walkthrough-score.wav");
  const result = await writeWalkthroughMusic(outputPath);
  process.stdout.write(`Built original walkthrough score: ${result.outputPath} (${result.bytes} bytes).\n`);
}
