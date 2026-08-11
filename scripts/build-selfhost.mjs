import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repository, "dist", "selfhost");
const outputFile = join(outputDirectory, "driftglass-selfhost.mjs");
const boundary = join(repository, "src", "runtime", "node", "cloudflare-import-boundary.ts");

function copyTree(source, destination) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`Refusing symlink in self-host distribution input: ${source}`);
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o755 });
    for (const name of readdirSync(source).sort()) copyTree(join(source, name), join(destination, name));
    return;
  }
  if (!info.isFile()) throw new Error(`Refusing special file in self-host distribution input: ${source}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  copyFileSync(source, destination);
  chmodSync(destination, 0o644);
}

if (existsSync(outputDirectory)) rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
let cloudflareBoundaryResolutions = 0;
const result = await build({
  entryPoints: [join(repository, "src", "runtime", "node", "cli.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24.4",
  sourcemap: true,
  metafile: true,
  legalComments: "none",
  plugins: [{
    name: "explicit-cloudflare-workers-node-boundary",
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => {
        cloudflareBoundaryResolutions += 1;
        return { path: boundary };
      });
    },
  }],
  logLevel: "info",
});
if (cloudflareBoundaryResolutions < 1) {
  throw new Error("Self-host build did not encounter the explicit cloudflare:workers boundary");
}
const boundaryInput = Object.keys(result.metafile.inputs).find((path) => resolve(repository, path) === boundary);
if (!boundaryInput) throw new Error("Self-host bundle metafile does not contain the fail-closed Cloudflare boundary");
const bundle = readFileSync(outputFile, "utf8");
if (/(?:from|import\()\s*["']cloudflare:workers["']/.test(bundle)) {
  throw new Error("Self-host bundle retained an unresolved cloudflare:workers import");
}

copyTree(join(repository, "public"), join(outputDirectory, "public"));
copyTree(join(repository, "migrations"), join(outputDirectory, "migrations"));
chmodSync(outputFile, 0o755);
process.stdout.write(`${JSON.stringify({
  ok: true,
  outputDirectory: relative(repository, outputDirectory),
  executable: relative(repository, outputFile),
  bytes: lstatSync(outputFile).size,
  cloudflareBoundaryResolutions,
})}\n`);
