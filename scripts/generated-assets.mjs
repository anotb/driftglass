import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

export function contentDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export async function verifyGeneratedFiles(output, expectedFiles, label) {
  let actualFiles;
  try {
    actualFiles = (await readdir(output)).sort();
  } catch {
    throw new Error(`${label} output directory is missing`);
  }

  const expectedNames = [...expectedFiles.keys()].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedNames)) {
    throw new Error(`${label} file inventory is stale`);
  }

  for (const [file, expected] of expectedFiles) {
    const actual = await readFile(new URL(file, output)).catch(() => null);
    const expectedBytes = Buffer.isBuffer(expected) ? expected : Buffer.from(expected);
    if (!actual || !actual.equals(expectedBytes)) throw new Error(`${label} asset is stale: ${file}`);
  }
}
