import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_ASSET_BYTES = 32 * 1024 * 1024;
const RESERVED_ROUTE_ROOTS = Object.freeze([
  "/api",
  "/mcp",
  "/collector",
  "/packet",
  "/corpus",
  "/feedback",
  "/share",
  "/health",
  "/ready",
  "/metrics",
  "/.well-known",
]);

const MIME_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

export interface FileAssetOptions {
  readonly root: string | URL;
  /**
   * Explicit acknowledgement that the caller controls this root and prevents
   * concurrent mutation while it is being served. This adapter does not offer
   * descriptor-relative directory walking.
   */
  readonly trustedAssetRoot: true;
  readonly indexFile?: string;
  readonly spaFallback?: string | false;
  readonly cacheControl?: string;
  readonly htmlCacheControl?: string;
  readonly maxAssetBytes?: number;
}

class InvalidAssetPath extends Error {}
class MissingAsset extends Error {}
class InvalidAssetRoot extends Error {}

function errorResponse(status: number, message: string, headers: HeadersInit = {}): Response {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function absoluteRoot(root: string | URL): string {
  const candidate = root instanceof URL
    ? (() => {
        if (root.protocol !== "file:") throw new TypeError("Asset root URL must use the file protocol");
        return fileURLToPath(root);
      })()
    : root;
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    throw new TypeError("Asset root must be an explicit absolute path or file URL");
  }
  const normalized = normalize(candidate);
  if (parse(normalized).root === normalized) {
    throw new TypeError("Asset root must not be a filesystem or drive root");
  }
  return normalized;
}

function isWindowsDeviceAlias(name: string): boolean {
  const compatibilityName = name.normalize("NFKC");
  const basename = (compatibilityName.split(".", 1)[0] ?? "").replace(/[ .]+$/g, "").toLowerCase();
  return ["con", "prn", "aux", "nul", "clock$", "conin$", "conout$"].includes(basename) ||
    /^(?:com|lpt)[1-9]$/.test(basename);
}

function isUnsafePortableFilename(name: string): boolean {
  return name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    /[\0-\x1f\x7f:]/.test(name) ||
    /[ .]$/.test(name) ||
    isWindowsDeviceAlias(name);
}

function simpleFilename(name: string, field: string): string {
  if (!name || isUnsafePortableFilename(name)) {
    throw new TypeError(field + " must be one plain filename");
  }
  return name;
}

function boundedMaxAssetBytes(value: unknown): number {
  const candidate = value === undefined ? DEFAULT_MAX_ASSET_BYTES : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > 1024 * 1024 * 1024) {
    throw new RangeError("maxAssetBytes must be an integer between 1 and 1073741824");
  }
  return candidate as number;
}

function decodePathSegments(pathname: string): string[] {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\") || pathname.includes("\0")) {
    throw new InvalidAssetPath();
  }
  const rawSegments = pathname.split("/").filter(Boolean);
  const decoded: string[] = [];
  for (const raw of rawSegments) {
    if (/%(?:00|2f|5c)/i.test(raw)) throw new InvalidAssetPath();
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      throw new InvalidAssetPath();
    }
    if (isUnsafePortableFilename(segment) || /%[0-9a-f]{2}/i.test(segment)) {
      throw new InvalidAssetPath();
    }
    decoded.push(segment);
  }
  return decoded;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

async function assertDirectoryWithoutLinks(root: string, target: string): Promise<void> {
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    throw new InvalidAssetRoot();
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new InvalidAssetRoot();

  const rel = relative(root, target);
  if (!contained(root, target)) throw new InvalidAssetPath();
  let current = root;
  for (const part of rel.split(sep).filter(Boolean).slice(0, -1)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch {
      throw new MissingAsset();
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new MissingAsset();
  }
}

async function resolveRegularAsset(root: string, segments: string[], indexFile: string): Promise<string> {
  let target = join(root, ...segments);
  if (!contained(root, target)) throw new InvalidAssetPath();
  await assertDirectoryWithoutLinks(root, target);

  let info;
  try {
    info = await lstat(target);
  } catch {
    throw new MissingAsset();
  }
  if (info.isSymbolicLink()) throw new MissingAsset();
  if (info.isDirectory()) {
    target = join(target, indexFile);
    await assertDirectoryWithoutLinks(root, target);
    try {
      info = await lstat(target);
    } catch {
      throw new MissingAsset();
    }
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new MissingAsset();

  let canonicalRoot: string;
  let canonicalTarget: string;
  try {
    [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
  } catch {
    throw new MissingAsset();
  }
  if (!contained(canonicalRoot, canonicalTarget)) {
    throw new MissingAsset();
  }
  return target;
}

function routeRoot(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(root + "/");
}

function isHtmlNavigation(request: Request, pathname: string): boolean {
  if (!["GET", "HEAD"].includes(request.method)) return false;
  if (RESERVED_ROUTE_ROOTS.some((root) => routeRoot(pathname, root))) return false;
  const finalSegment = pathname.split("/").filter(Boolean).at(-1) ?? "";
  if (extname(finalSegment)) return false;
  const accept = request.headers.get("accept") ?? "";
  if (!accept.split(",").some((part) => part.trim().toLowerCase().startsWith("text/html"))) return false;
  const fetchMode = request.headers.get("sec-fetch-mode");
  if (fetchMode && fetchMode.toLowerCase() !== "navigate") return false;
  const fetchDest = request.headers.get("sec-fetch-dest");
  return !fetchDest || fetchDest.toLowerCase() === "document";
}

function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  const comparable = (value: string): string => value.trim().replace(/^W\//i, "");
  const expected = comparable(etag);
  return header.split(",").some((candidate) => candidate.trim() === "*" || comparable(candidate) === expected);
}

async function revalidateOpenedAsset(root: string, target: string, handle: FileHandle): Promise<BigIntStats> {
  let opened;
  let current;
  let rootInfo;
  let canonicalRoot: string;
  let canonicalTarget: string;
  try {
    [opened, current, rootInfo, canonicalRoot, canonicalTarget] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(target, { bigint: true }),
      lstat(root, { bigint: true }),
      realpath(root),
      realpath(target),
    ]);
  } catch {
    throw new MissingAsset();
  }
  if (
    !opened.isFile() ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    rootInfo.isSymbolicLink() ||
    !rootInfo.isDirectory() ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino ||
    !contained(canonicalRoot, canonicalTarget)
  ) {
    throw new MissingAsset();
  }
  return opened;
}

function metadataEtag(info: BigIntStats): string {
  const values = [info.dev, info.ino, info.size, info.mtimeNs].map((value) => value.toString(16));
  return "W/\"" + values.join("-") + "\"";
}

export class FileAssetAdapter {
  readonly root: string;
  readonly indexFile: string;
  readonly spaFallback: string | false;
  readonly cacheControl: string;
  readonly htmlCacheControl: string;
  readonly maxAssetBytes: number;

  constructor(options: FileAssetOptions) {
    this.root = absoluteRoot(options.root);
    if (options.trustedAssetRoot !== true) {
      throw new TypeError("Asset roots require explicit trustedAssetRoot: true acknowledgement");
    }
    this.indexFile = simpleFilename(options.indexFile ?? "index.html", "indexFile");
    this.spaFallback = options.spaFallback === false
      ? false
      : simpleFilename(options.spaFallback ?? "index.html", "spaFallback");
    this.cacheControl = options.cacheControl ?? "public, max-age=300";
    this.htmlCacheControl = options.htmlCacheControl ?? "no-cache";
    this.maxAssetBytes = boundedMaxAssetBytes(options.maxAssetBytes);
  }

  async fetch(request: Request): Promise<Response> {
    if (!["GET", "HEAD"].includes(request.method)) {
      return errorResponse(405, "Method not allowed", { allow: "GET, HEAD" });
    }

    const pathname = new URL(request.url).pathname;
    let segments: string[];
    try {
      segments = decodePathSegments(pathname);
    } catch {
      return errorResponse(400, "Invalid asset path");
    }
    const canonicalPathname = "/" + segments.join("/");
    if (segments.length === 0) segments = [this.indexFile];

    let target: string;
    let usedFallback = false;
    try {
      target = await resolveRegularAsset(this.root, segments, this.indexFile);
    } catch (error) {
      if (error instanceof InvalidAssetRoot) return errorResponse(500, "Asset service unavailable");
      if (!(error instanceof MissingAsset) || !this.spaFallback || !isHtmlNavigation(request, canonicalPathname)) {
        return errorResponse(error instanceof InvalidAssetPath ? 400 : 404, error instanceof InvalidAssetPath ? "Invalid asset path" : "Not found");
      }
      try {
        target = await resolveRegularAsset(this.root, [this.spaFallback], this.indexFile);
        usedFallback = true;
      } catch (fallbackError) {
        return errorResponse(fallbackError instanceof InvalidAssetRoot ? 500 : 404, fallbackError instanceof InvalidAssetRoot ? "Asset service unavailable" : "Not found");
      }
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await revalidateOpenedAsset(this.root, target, handle);
      if (info.size > BigInt(this.maxAssetBytes)) return errorResponse(413, "Asset exceeds configured limit");
      const etag = metadataEtag(info);
      const extension = extname(target).toLowerCase();
      const cacheControl = extension === ".html" || usedFallback ? this.htmlCacheControl : this.cacheControl;
      if (matchesEtag(request.headers.get("if-none-match"), etag)) {
        await handle.close();
        handle = undefined;
        return new Response(null, {
          status: 304,
          headers: {
            "cache-control": cacheControl,
            etag,
            "x-content-type-options": "nosniff",
          },
        });
      }
      const headers = {
        "cache-control": cacheControl,
        "content-length": info.size.toString(),
        "content-type": MIME_TYPES.get(extension) ?? "application/octet-stream",
        etag,
        "x-content-type-options": "nosniff",
      };
      if (request.method === "HEAD") {
        await handle.close();
        handle = undefined;
        return new Response(null, { status: 200, headers });
      }
      if (info.size === 0n) {
        await handle.close();
        handle = undefined;
        return new Response(null, { status: 200, headers });
      }

      const snapshotBytes = Number(info.size);
      const nodeBody = handle.createReadStream({
        autoClose: true,
        emitClose: true,
        start: 0,
        end: snapshotBytes - 1,
      });
      handle = undefined;
      const body = Readable.toWeb(nodeBody) as unknown as ReadableStream<Uint8Array>;
      try {
        return new Response(body, { status: 200, headers });
      } catch (error) {
        nodeBody.destroy();
        throw error;
      }
    } catch {
      return errorResponse(404, "Not found");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
