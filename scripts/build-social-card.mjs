import { createHash } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSync } from "fontkit";
import sharp from "sharp";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(repository, "public", "icons", "driftglass-og.png");
const fingerprintPath = join(repository, "public", "icons", "driftglass-og.source.sha256");
const shareFallbackOutputPath = join(repository, "public", "icons", "driftglass-share-fallback.png");
const shareFallbackFingerprintPath = join(repository, "public", "icons", "driftglass-share-fallback.source.sha256");
const regularFont = openSync(join(repository, "node_modules", "@fontsource", "inter", "files", "inter-latin-400-normal.woff2"));
const boldFont = openSync(join(repository, "node_modules", "@fontsource", "inter", "files", "inter-latin-700-normal.woff2"));
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const checkFileIndex = args.indexOf("--check-file");
if (checkFileIndex >= 0 && !checkOnly) throw new Error("--check-file requires --check");
if (checkFileIndex >= 0 && (!args[checkFileIndex + 1] || args[checkFileIndex + 1].startsWith("--"))) {
  throw new Error("--check-file requires a path");
}
const checkedOutputPath = checkFileIndex >= 0 ? resolve(repository, args[checkFileIndex + 1]) : outputPath;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SAFE_PNG_CHUNKS = new Set(["IHDR", "PLTE", "pHYs", "IDAT", "IEND", "tRNS"]);

function decimal(value) {
  return Number(value.toFixed(5)).toString();
}

function pathText(text, { x, y, size, fill, weight = 400, letterSpacing = 0 }) {
  const font = weight === 700 ? boldFont : regularFont;
  const run = font.layout(text);
  const scale = size / font.unitsPerEm;
  const spacing = letterSpacing / scale;
  let cursorX = 0;
  let cursorY = 0;
  const paths = [];
  for (let index = 0; index < run.glyphs.length; index += 1) {
    const glyph = run.glyphs[index];
    const position = run.positions[index];
    const path = glyph.path.toSVG();
    if (path) {
      paths.push(`<path d="${path}" transform="translate(${decimal(cursorX + position.xOffset)} ${decimal(cursorY + position.yOffset)})"/>`);
    }
    cursorX += position.xAdvance + spacing;
    cursorY += position.yAdvance;
  }
  return `<g fill="${fill}" transform="translate(${x} ${y}) scale(${decimal(scale)} ${decimal(-scale)})">${paths.join("")}</g>`;
}

function socialCardSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title description">',
    "<title id=\"title\">Driftglass</title>",
    "<desc id=\"description\">Keep a current answer to questions that outlive the news cycle.</desc>",
    '<rect width="1200" height="630" fill="#f6f5f1"/>',
    '<circle cx="1148" cy="72" r="250" fill="#e7e3ff"/>',
    '<circle cx="1148" cy="72" r="176" fill="#d4ceff"/>',
    '<rect x="68" y="52" width="38" height="38" rx="10" fill="#13151c"/>',
    '<path d="M87 59 89.5 68.5 99 71 89.5 73.5 87 83 84.5 73.5 75 71 84.5 68.5Z" fill="#f6f5f1"/>',
    '<circle cx="87" cy="71" r="3" fill="#13151c"/>',
    pathText("DRIFTGLASS", { x: 120, y: 79, size: 20, weight: 700, letterSpacing: 1.5, fill: "#4f46e5" }),
    pathText("Keep a current answer", { x: 68, y: 180, size: 56, weight: 700, letterSpacing: -1.6, fill: "#13151c" }),
    pathText("to questions that", { x: 68, y: 248, size: 56, weight: 700, letterSpacing: -1.6, fill: "#13151c" }),
    pathText("outlive the news cycle.", { x: 68, y: 316, size: 56, weight: 700, letterSpacing: -1.6, fill: "#13151c" }),
    '<rect x="680" y="76" width="460" height="478" rx="30" fill="#ffffff" stroke="#d8d5cf" stroke-width="2"/>',
    '<rect x="708" y="104" width="156" height="28" rx="14" fill="#efedff"/>',
    pathText("HORMUZ GAS MARKET", { x: 722, y: 124, size: 13, weight: 700, letterSpacing: 0.7, fill: "#4f46e5" }),
    pathText("Has Gulf LNG supply", { x: 710, y: 179, size: 31, weight: 700, letterSpacing: -0.5, fill: "#13151c" }),
    pathText("normalized?", { x: 710, y: 215, size: 31, weight: 700, letterSpacing: -0.5, fill: "#13151c" }),
    '<line x1="710" y1="248" x2="1110" y2="248" stroke="#e4e2dd" stroke-width="2"/>',
    pathText("BOTTOM LINE", { x: 710, y: 286, size: 13, weight: 700, letterSpacing: 1.1, fill: "#4f46e5" }),
    pathText("Not yet. Shipping is", { x: 710, y: 328, size: 32, weight: 700, letterSpacing: -0.35, fill: "#13151c" }),
    pathText("recovering, but damaged", { x: 710, y: 369, size: 32, weight: 700, letterSpacing: -0.35, fill: "#13151c" }),
    pathText("Qatari export capacity", { x: 710, y: 410, size: 32, weight: 700, letterSpacing: -0.35, fill: "#13151c" }),
    pathText("still sets the timetable.", { x: 710, y: 451, size: 32, weight: 700, letterSpacing: -0.35, fill: "#13151c" }),
    '<line x1="710" y1="494" x2="1110" y2="494" stroke="#e4e2dd" stroke-width="2"/>',
    pathText("IEA · EIA · As of July 7, 2026", { x: 710, y: 527, size: 18, fill: "#596174" }),
    "</svg>",
  ].join("\n");
}

function shareFallbackSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title description">',
    "<title id=\"title\">Driftglass shared briefing</title>",
    "<desc id=\"description\">Open the shared link to read the question, public sources, and any published answer.</desc>",
    '<rect width="1200" height="630" fill="#f6f5f1"/>',
    '<circle cx="1148" cy="72" r="250" fill="#e7e3ff"/>',
    '<circle cx="1148" cy="72" r="176" fill="#d4ceff"/>',
    '<rect x="68" y="52" width="38" height="38" rx="10" fill="#13151c"/>',
    '<path d="M87 59 89.5 68.5 99 71 89.5 73.5 87 83 84.5 73.5 75 71 84.5 68.5Z" fill="#f6f5f1"/>',
    '<circle cx="87" cy="71" r="3" fill="#13151c"/>',
    pathText("DRIFTGLASS", { x: 120, y: 79, size: 20, weight: 700, letterSpacing: 1.5, fill: "#4f46e5" }),
    pathText("Keep a current answer", { x: 68, y: 180, size: 56, weight: 700, letterSpacing: -1.6, fill: "#13151c" }),
    pathText("to questions that", { x: 68, y: 248, size: 56, weight: 700, letterSpacing: -1.6, fill: "#13151c" }),
    pathText("outlive the news cycle.", { x: 68, y: 316, size: 56, weight: 700, letterSpacing: -1.6, fill: "#13151c" }),
    '<rect x="680" y="76" width="460" height="478" rx="30" fill="#ffffff" stroke="#d8d5cf" stroke-width="2"/>',
    '<rect x="708" y="104" width="164" height="28" rx="14" fill="#efedff"/>',
    pathText("SHARED BRIEFING", { x: 722, y: 124, size: 13, weight: 700, letterSpacing: 0.7, fill: "#4f46e5" }),
    pathText("Open the shared link", { x: 710, y: 202, size: 35, weight: 700, letterSpacing: -0.6, fill: "#13151c" }),
    '<line x1="710" y1="248" x2="1110" y2="248" stroke="#e4e2dd" stroke-width="2"/>',
    pathText("Read the current question,", { x: 710, y: 318, size: 27, weight: 700, letterSpacing: -0.3, fill: "#13151c" }),
    pathText("public sources, and any", { x: 710, y: 360, size: 27, weight: 700, letterSpacing: -0.3, fill: "#13151c" }),
    pathText("answer selected to share.", { x: 710, y: 402, size: 27, weight: 700, letterSpacing: -0.3, fill: "#13151c" }),
    '<line x1="710" y1="494" x2="1110" y2="494" stroke="#e4e2dd" stroke-width="2"/>',
    pathText("DRIFTGLASS", { x: 710, y: 527, size: 18, weight: 700, letterSpacing: 0.8, fill: "#596174" }),
    "</svg>",
  ].join("\n");
}

async function renderSocialCard(svg) {
  const output = await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toBuffer();
  const metadata = await sharp(output).metadata();
  if (metadata.format !== "png" || metadata.width !== 1200 || metadata.height !== 630) {
    throw new Error(`Social card must render as a 1200x630 PNG; received ${metadata.format} ${metadata.width}x${metadata.height}`);
  }
  return output;
}

async function compareRenderedPixels(committed, rendered) {
  assertSafePngChunks(committed);
  if (committed.equals(rendered)) return "exact bytes";
  const [actual, expected] = await Promise.all([
    sharp(committed).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(rendered).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  const dimensions = ["width", "height", "channels"];
  for (const field of dimensions) {
    if (actual.info[field] !== expected.info[field]) {
      throw new Error(`Social card ${field} differs: ${actual.info[field]} !== ${expected.info[field]}`);
    }
  }
  const pixelCount = actual.info.width * actual.info.height;
  let totalDelta = 0;
  let highDeltaPixels = 0;
  for (let offset = 0; offset < actual.data.length; offset += 4) {
    let pixelDelta = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(actual.data[offset + channel] - expected.data[offset + channel]);
      totalDelta += delta;
      pixelDelta = Math.max(pixelDelta, delta);
    }
    if (pixelDelta > 96) highDeltaPixels += 1;
  }
  const meanChannelDelta = totalDelta / actual.data.length;
  const highDeltaRatio = highDeltaPixels / pixelCount;
  if (meanChannelDelta > 0.75 || highDeltaRatio > 0.0001) {
    throw new Error(
      `Social card pixels are stale: mean channel delta ${decimal(meanChannelDelta)}, `
      + `high-delta pixel ratio ${decimal(highDeltaRatio)}`,
    );
  }
  return `portable pixel match (mean ${decimal(meanChannelDelta)}, high-delta ratio ${decimal(highDeltaRatio)})`;
}

function assertSafePngChunks(image) {
  if (image.length < PNG_SIGNATURE.length || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Social card is not a PNG");
  }
  let offset = PNG_SIGNATURE.length;
  let reachedEnd = false;
  while (offset < image.length) {
    if (offset + 12 > image.length) throw new Error("Social card has a truncated PNG chunk");
    const length = image.readUInt32BE(offset);
    const type = image.toString("ascii", offset + 4, offset + 8);
    const nextOffset = offset + 12 + length;
    if (nextOffset > image.length) throw new Error(`Social card has a truncated ${type} chunk`);
    if (!SAFE_PNG_CHUNKS.has(type)) throw new Error(`Social card contains unsafe PNG chunk ${type}`);
    if (type === "IEND") {
      if (length !== 0 || nextOffset !== image.length) throw new Error("Social card has an invalid PNG end chunk");
      reachedEnd = true;
    }
    offset = nextOffset;
  }
  if (!reachedEnd) throw new Error("Social card is missing its PNG end chunk");
}

async function verifyCard(card, candidatePath = card.outputPath) {
  const rendered = await renderSocialCard(card.svg);
  const fingerprint = `${createHash("sha256").update(card.svg).digest("hex")}\n`;
  const [committed, recordedFingerprint] = await Promise.all([readFile(candidatePath), readFile(card.fingerprintPath, "utf8")]);
  if (recordedFingerprint !== fingerprint) {
    throw new Error(`${card.name} source fingerprint is stale; run npm run social-card:build`);
  }
  const comparison = await compareRenderedPixels(committed, rendered);
  console.log(`Verified ${card.publicPath} from deterministic text outlines: ${comparison}.`);
}

async function buildCard(card) {
  const rendered = await renderSocialCard(card.svg);
  const fingerprint = `${createHash("sha256").update(card.svg).digest("hex")}\n`;
  const temporaryPath = `${card.outputPath}.tmp-${process.pid}`;
  const temporaryFingerprintPath = `${card.fingerprintPath}.tmp-${process.pid}`;
  try {
    await Promise.all([
      writeFile(temporaryPath, rendered, { mode: 0o644 }),
      writeFile(temporaryFingerprintPath, fingerprint, { mode: 0o644 }),
    ]);
    await rename(temporaryPath, card.outputPath);
    await rename(temporaryFingerprintPath, card.fingerprintPath);
  } finally {
    await Promise.all([
      unlink(temporaryPath).catch(() => {}),
      unlink(temporaryFingerprintPath).catch(() => {}),
    ]);
  }
  console.log(`Rendered ${card.publicPath} from deterministic text outlines.`);
}

const cards = [
  {
    name: "Repository social card",
    publicPath: "public/icons/driftglass-og.png",
    outputPath,
    fingerprintPath,
    svg: socialCardSvg(),
  },
  {
    name: "Share fallback card",
    publicPath: "public/icons/driftglass-share-fallback.png",
    outputPath: shareFallbackOutputPath,
    fingerprintPath: shareFallbackFingerprintPath,
    svg: shareFallbackSvg(),
  },
];

if (checkOnly) {
  if (checkFileIndex >= 0) {
    await verifyCard(cards[0], checkedOutputPath);
  } else {
    for (const card of cards) await verifyCard(card);
  }
} else {
  for (const card of cards) await buildCard(card);
}
