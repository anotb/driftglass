import { DurableObject } from "cloudflare:workers";
import {
  type DurableObjectStorageLike,
  getWorkspace,
  shellQuote,
  type WorkspaceClient,
  WorkspaceServiceProxy,
  withWorkspace,
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

export { WorkspaceServiceProxy };

interface Env {
  CASE_COMPUTER: DurableObjectNamespace<CaseComputer>;
  LOADER: WorkerLoader;
  DEEP_DIVE_LAB_SECRET?: string;
  APP_NAME?: string;
}

interface EvidenceEntry {
  itemId?: string;
  storyId?: string;
  title: string;
  url?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  excerpt?: string;
  text?: string;
  source?: string;
  provider?: string;
  accessClass?: string;
  metadata?: Record<string, unknown>;
}

interface ResearchBundle {
  schemaVersion: string;
  generatedAt: string;
  mission?: { id: string; name: string; question: string };
  story?: { id: string; title: string; summary?: string };
  stories?: Array<{ id: string; title: string; summary?: string; lastChangedAt?: string }>;
  evidence: EvidenceEntry[];
}

interface CaseManifest {
  caseId: string;
  title: string;
  question: string;
  preparedAt: string;
  evidenceCount: number;
  sourceCount: number;
  storyCount: number;
  runtime: "cloudflare-computer";
  execution: "worker-shell";
  executionBackends: Array<"worker-shell" | "worker-javascript">;
  files: string[];
}

interface CaseDetail {
  caseId: string;
  manifest: CaseManifest | null;
  files: Array<{ path: string; directory: boolean }>;
}

const MAX_BODY_BYTES = 4_000_000;
const MAX_EVIDENCE = 500;
const encoder = new TextEncoder();

type ToolResultPromise = Promise<Awaited<ReturnType<Parameters<McpServer["registerTool"]>[2]>>>;

// Computer 0.1.1 accepts object-shaped SQL rows, while current Workers types
// narrow SqlStorage rows to Cloudflare's serializable SQLite value union.
class ComputerSqlStorage {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  exec<Row extends object = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): Row[] };
  exec(query: string, ...bindings: unknown[]): { toArray(): object[] } {
    const rows = this.#sql.exec(query, ...bindings).toArray();
    return { toArray: () => rows };
  }
}

class ComputerDurableStorage implements DurableObjectStorageLike {
  readonly sql: ComputerSqlStorage;
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.sql = new ComputerSqlStorage(storage.sql);
  }

  transactionSync<T>(closure: () => T): T {
    return this.#storage.transactionSync(closure);
  }
}

class CaseComputerDurableObject extends DurableObject<Env> {
  readonly workspaceStorage = new ComputerDurableStorage(this.ctx.storage);
  readonly workspaceLoader = this.env.LOADER;
  readonly workspaceId = this.ctx.id.toString();
  readonly workspaceContext = this.ctx;
  readonly workspaceWaitUntil = this.ctx.waitUntil.bind(this.ctx);
}

const CaseComputerWithWorkspace = withWorkspace(
  CaseComputerDurableObject,
  (self) => {
    return {
      storage: self.workspaceStorage,
      waitUntil: self.workspaceWaitUntil,
      backends: [
        new WorkerShellBackend({
          loader: self.workspaceLoader,
          workspace: { binding: "CASE_COMPUTER", id: self.workspaceId },
          ctx: self.workspaceContext,
        }),
        new WorkerJavaScriptBackend({ loader: self.workspaceLoader, root: "/" }),
      ],
    };
  },
);

export class CaseComputer extends CaseComputerWithWorkspace {
  override __getWorkspaceStub() {
    return super.__getWorkspaceStub();
  }

  prepareCase(caseId: string, raw: unknown): Promise<CaseManifest> {
    return withLocalCase(this, (workspace) => prepareCaseInWorkspace(workspace, caseId, raw));
  }

  getCase(caseId: string): Promise<CaseDetail> {
    return withLocalCase(this, (workspace) => getCaseInWorkspace(workspace, caseId));
  }

  readCaseFile(caseId: string, path: string): Promise<string> {
    return withLocalCase(this, (workspace) => readCaseFileInWorkspace(workspace, caseId, path));
  }

  searchCase(caseId: string, query: string): Promise<Record<string, unknown>> {
    return withLocalCase(this, (workspace) => searchCaseInWorkspace(workspace, caseId, query));
  }

  appendCaseNote(caseId: string, note: string): Promise<Record<string, unknown>> {
    return withLocalCase(this, (workspace) => appendCaseNoteInWorkspace(workspace, caseId, note));
  }

  auditCase(caseId: string): Promise<Record<string, unknown>> {
    return withLocalCase(this, (workspace) => auditCaseInWorkspace(workspace, caseId));
  }

  runStructuredTransform(caseId: string, program: StructuredTransform): Promise<Record<string, unknown>> {
    return withLocalCase(this, (workspace) => runStructuredTransformInWorkspace(workspace, caseId, program));
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function safeSegment(value: string): string {
  const output = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  if (!output) throw new Error("A non-empty case ID is required");
  return output;
}

function safePath(value: string): string {
  const normalized = `/${String(value || "").replace(/^\/+/, "")}`.replace(/\/+/g, "/");
  if (normalized.includes("..") || normalized.includes("\0")) throw new Error("Invalid workspace path");
  return normalized;
}

function csv(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function firstSentence(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const match = clean.match(/^(.{1,420}?[.!?])(?:\s|$)/);
  return (match?.[1] || clean.slice(0, 420)).trim();
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function mcpKey(env: Env): Promise<string> {
  const secret = env.DEEP_DIVE_LAB_SECRET || "";
  if (secret.length < 24) throw new Error("DEEP_DIVE_LAB_SECRET is not configured");
  return (await digest(`driftglass-computer-power-mode:mcp:${secret}`)).slice(0, 40);
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new Error("Request body is too large");
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) throw new Error("Request body is too large");
  return JSON.parse(new TextDecoder().decode(buffer));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function normalizeStory(value: unknown): { id: string; title: string; summary?: string; lastChangedAt?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalString(value.id);
  const title = optionalString(value.title);
  if (!id || !title) return undefined;
  return {
    id,
    title,
    summary: optionalString(value.summary),
    lastChangedAt: optionalString(value.lastChangedAt),
  };
}

function normalizeBundle(value: unknown): ResearchBundle {
  if (!isRecord(value) || !Array.isArray(value.evidence)) throw new Error("evidence must be an array");
  const mission = isRecord(value.mission)
    ? {
        id: optionalString(value.mission.id) || "",
        name: optionalString(value.mission.name) || "",
        question: optionalString(value.mission.question) || "",
      }
    : undefined;
  const story = normalizeStory(value.story);
  const stories = Array.isArray(value.stories)
    ? value.stories.map(normalizeStory).filter((item): item is NonNullable<typeof item> => item !== undefined).slice(0, 100)
    : [];
  return {
    schemaVersion: optionalString(value.schemaVersion) || "1",
    generatedAt: optionalString(value.generatedAt) || new Date().toISOString(),
    mission,
    story,
    stories,
    evidence: value.evidence.slice(0, MAX_EVIDENCE).map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`evidence[${index}] must be an object`);
      const title = optionalString(entry.title) || `Evidence ${index + 1}`;
      return {
        itemId: optionalString(entry.itemId) || `evidence-${index + 1}`,
        storyId: optionalString(entry.storyId),
        title: title.slice(0, 600),
        url: optionalNullableString(entry.url),
        author: optionalNullableString(entry.author),
        publishedAt: optionalNullableString(entry.publishedAt),
        excerpt: (optionalString(entry.excerpt) || optionalString(entry.text) || "").slice(0, 20_000),
        text: optionalString(entry.text),
        source: optionalString(entry.source),
        provider: optionalString(entry.provider),
        accessClass: optionalString(entry.accessClass),
        metadata: isRecord(entry.metadata) ? entry.metadata : undefined,
      };
    }),
  };
}

function parseCaseManifest(value: unknown): CaseManifest | null {
  if (!isRecord(value)) return null;
  const executionBackends = Array.isArray(value.executionBackends)
    ? value.executionBackends.filter((backend): backend is "worker-shell" | "worker-javascript" => backend === "worker-shell" || backend === "worker-javascript")
    : [];
  const files = Array.isArray(value.files) ? value.files.filter((file): file is string => typeof file === "string") : [];
  if (
    typeof value.caseId !== "string" || typeof value.title !== "string" || typeof value.question !== "string" ||
    typeof value.preparedAt !== "string" || typeof value.evidenceCount !== "number" || typeof value.sourceCount !== "number" ||
    typeof value.storyCount !== "number" || value.runtime !== "cloudflare-computer" || value.execution !== "worker-shell" ||
    executionBackends.length !== (Array.isArray(value.executionBackends) ? value.executionBackends.length : -1) ||
    files.length !== (Array.isArray(value.files) ? value.files.length : -1)
  ) return null;
  return {
    caseId: value.caseId,
    title: value.title,
    question: value.question,
    preparedAt: value.preparedAt,
    evidenceCount: value.evidenceCount,
    sourceCount: value.sourceCount,
    storyCount: value.storyCount,
    runtime: value.runtime,
    execution: value.execution,
    executionBackends,
    files,
  };
}

function requestString(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function titleFor(bundle: ResearchBundle): string {
  return bundle.mission?.name || bundle.story?.title || bundle.stories?.[0]?.title || "Evidence case";
}

function questionFor(bundle: ResearchBundle): string {
  return bundle.mission?.question || bundle.story?.summary || "What does the collected evidence establish, contradict, and leave unresolved?";
}

function buildTimeline(bundle: ResearchBundle): string {
  const rows = [...bundle.evidence].sort((left, right) => String(left.publishedAt || "").localeCompare(String(right.publishedAt || "")));
  return [`# Timeline — ${titleFor(bundle)}`, "", ...rows.map((entry) => `- **${entry.publishedAt || "Undated"}** — ${entry.title}${entry.source ? ` · ${entry.source}` : ""}${entry.url ? ` · ${entry.url}` : ""}`), ""].join("\n");
}

function buildSourceCsv(bundle: ResearchBundle): string {
  const header = ["item_id", "story_id", "published_at", "source", "provider", "author", "title", "url", "access_class"].map(csv).join(",");
  const rows = bundle.evidence.map((entry) => [entry.itemId, entry.storyId, entry.publishedAt, entry.source, entry.provider, entry.author, entry.title, entry.url, entry.accessClass].map(csv).join(","));
  return [header, ...rows, ""].join("\n");
}

function buildClaims(bundle: ResearchBundle): Array<Record<string, unknown>> {
  return bundle.evidence.map((entry, index) => ({
    id: `claim-${String(index + 1).padStart(3, "0")}`,
    type: "source_claim",
    text: firstSentence(entry.excerpt || entry.text || entry.title),
    title: entry.title,
    evidenceItemId: entry.itemId,
    storyId: entry.storyId,
    source: entry.source,
    provider: entry.provider,
    publishedAt: entry.publishedAt,
    url: entry.url,
    reviewStatus: "unreviewed",
  }));
}

function buildResearchPlan(bundle: ResearchBundle): string {
  const sources = [...new Set(bundle.evidence.map((entry) => entry.source || entry.provider || "Unknown source"))];
  return [
    `# Research plan — ${titleFor(bundle)}`, "", "## Core question", "", questionFor(bundle), "",
    "## Available evidence", "", `- ${bundle.evidence.length} evidence items`, `- ${sources.length} distinct sources`, `- ${bundle.story ? 1 : bundle.stories?.length || 0} linked Stories`, "",
    "## Computer workflow", "",
    "1. Establish chronology from `timeline.md`.",
    "2. Review `claims.json` and mark claims supported, contradicted, repeated, or unresolved.",
    "3. Use `sources.csv` and `xan` to inspect concentration and coverage.",
    "4. Search `/evidence` for names, quantities, corrections, and missing primary records.",
    "5. Use `jq`, SQLite, HTML-to-Markdown, or the JavaScript isolate when deterministic transformation helps.",
    "6. Append durable findings to `notes.md` and update `dossier.md`.",
    "7. Run the audit before exporting.", "",
  ].join("\n");
}

function buildDossier(bundle: ResearchBundle): string {
  const sources = new Map<string, number>();
  for (const entry of bundle.evidence) {
    const source = entry.source || entry.provider || "Unknown source";
    sources.set(source, (sources.get(source) || 0) + 1);
  }
  const stories = bundle.story ? [bundle.story] : bundle.stories || [];
  return [
    `# ${titleFor(bundle)}`, "", `> ${questionFor(bundle)}`, "",
    `Prepared ${new Date().toISOString()} from ${bundle.evidence.length} evidence items across ${sources.size} sources.`, "",
    "## Story map", "", ...(stories.length ? stories.map((story) => `- **${story.title}**${story.summary ? ` — ${story.summary}` : ""}`) : ["- Single evidence-led case"]), "",
    "## Source distribution", "", ...[...sources.entries()].sort((a, b) => b[1] - a[1]).map(([source, count]) => `- ${source}: ${count}`), "",
    "## Evidence index", "", ...bundle.evidence.map((entry, index) => `### ${index + 1}. ${entry.title}\n\n${[entry.source, entry.author, entry.publishedAt].filter(Boolean).join(" · ")}\n\n${firstSentence(entry.excerpt || entry.text || "")}${entry.url ? `\n\n${entry.url}` : ""}`), "",
    "## Questions for the reasoning pass", "", "1. Which claims are directly supported by primary evidence?", "2. Where do sources disagree or repeat one another?", "3. What changed over time?", "4. What would falsify the leading interpretation?", "5. What should be watched next?", "",
  ].join("\n");
}

function caseWorkspace(env: Env, caseId: string) {
  const id = env.CASE_COMPUTER.idFromName(`case:${safeSegment(caseId)}`);
  return env.CASE_COMPUTER.get(id);
}

async function withLocalCase<T>(computer: CaseComputer, callback: (workspace: WorkspaceClient) => Promise<T>): Promise<T> {
  using workspace = await getWorkspace(computer);
  return await callback(workspace);
}

async function prepareCase(env: Env, caseId: string, raw: unknown): Promise<CaseManifest> {
  const safeId = safeSegment(caseId);
  return caseWorkspace(env, safeId).prepareCase(safeId, raw);
}

async function prepareCaseInWorkspace(workspace: WorkspaceClient, caseId: string, raw: unknown): Promise<CaseManifest> {
  const safeId = safeSegment(caseId);
  const bundle = normalizeBundle(raw);
  const sources = new Set(bundle.evidence.map((entry) => entry.source || entry.provider || "Unknown source"));
  const manifest: CaseManifest = {
    caseId: safeId,
    title: titleFor(bundle),
    question: questionFor(bundle),
    preparedAt: new Date().toISOString(),
    evidenceCount: bundle.evidence.length,
    sourceCount: sources.size,
    storyCount: bundle.story ? 1 : bundle.stories?.length || 0,
    runtime: "cloudflare-computer",
    execution: "worker-shell",
    executionBackends: ["worker-shell", "worker-javascript"],
    files: [],
  };
  const files: Record<string, string> = {
    "/case.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "/bundle.json": `${JSON.stringify(bundle, null, 2)}\n`,
    "/research-plan.md": buildResearchPlan(bundle),
    "/evidence.ndjson": bundle.evidence.map((entry) => JSON.stringify(entry)).join("\n") + (bundle.evidence.length ? "\n" : ""),
    "/timeline.md": buildTimeline(bundle),
    "/sources.csv": buildSourceCsv(bundle),
    "/claims.json": `${JSON.stringify(buildClaims(bundle), null, 2)}\n`,
    "/dossier.md": buildDossier(bundle),
  };
  await workspace.fs.rm("/evidence", { recursive: true, force: true });
  await workspace.fs.mkdir("/evidence", { recursive: true });
  for (const [path, content] of Object.entries(files)) await workspace.fs.writeFile(path, content);
  for (let index = 0; index < bundle.evidence.length; index += 1) {
    const entry = bundle.evidence[index]!;
    const itemId = safeSegment(entry.itemId || `${index + 1}-${entry.title}`);
    await workspace.fs.writeFile(`/evidence/${String(index + 1).padStart(3, "0")}-${itemId}.json`, `${JSON.stringify(entry, null, 2)}\n`);
  }
  try { await workspace.fs.readFile("/notes.md", "utf8"); } catch { await workspace.fs.writeFile("/notes.md", "# Notes\n\n"); }
  const detail = await getCaseInWorkspace(workspace, safeId);
  manifest.files = detail.files.map((file) => file.path);
  await workspace.fs.writeFile("/case.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function walk(workspace: WorkspaceClient, path = "/", output: Array<{ path: string; directory: boolean }> = []): Promise<Array<{ path: string; directory: boolean }>> {
  const entries = await workspace.fs.readdir(path).catch(() => []);
  for (const entry of entries) {
    const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
    output.push({ path: child, directory: Boolean(entry.isDirectory) });
    if (entry.isDirectory && output.length < 1000) await walk(workspace, child, output);
  }
  return output;
}

async function getCase(env: Env, caseId: string): Promise<CaseDetail> {
  const safeId = safeSegment(caseId);
  return caseWorkspace(env, safeId).getCase(safeId);
}

async function getCaseInWorkspace(workspace: WorkspaceClient, caseId: string): Promise<CaseDetail> {
  const safeId = safeSegment(caseId);
  const files = await walk(workspace);
  let manifest: CaseManifest | null = null;
  try { manifest = parseCaseManifest(JSON.parse(await workspace.fs.readFile("/case.json", "utf8"))); } catch { /* empty case */ }
  return { caseId: safeId, manifest, files };
}

async function readCaseFile(env: Env, caseId: string, inputPath: string): Promise<string> {
  const safeId = safeSegment(caseId);
  return caseWorkspace(env, safeId).readCaseFile(safeId, inputPath);
}

async function readCaseFileInWorkspace(workspace: WorkspaceClient, caseId: string, inputPath: string): Promise<string> {
  safeSegment(caseId);
  const path = safePath(inputPath);
  return workspace.fs.readFile(path, "utf8");
}

async function searchCase(env: Env, caseId: string, query: string): Promise<Record<string, unknown>> {
  const safeId = safeSegment(caseId);
  return caseWorkspace(env, safeId).searchCase(safeId, query);
}

async function searchCaseInWorkspace(workspace: WorkspaceClient, caseId: string, query: string): Promise<Record<string, unknown>> {
  const clean = query.trim().slice(0, 300);
  if (!clean) throw new Error("query is required");
  return { caseId: safeSegment(caseId), query: clean, matches: await workspace.fs.grep(clean, "/", { ignoreCase: true }) };
}

async function appendCaseNote(env: Env, caseId: string, note: string): Promise<Record<string, unknown>> {
  const safeId = safeSegment(caseId);
  return caseWorkspace(env, safeId).appendCaseNote(safeId, note);
}

async function appendCaseNoteInWorkspace(workspace: WorkspaceClient, caseId: string, note: string): Promise<Record<string, unknown>> {
  const clean = note.trim().slice(0, 20_000);
  if (!clean) throw new Error("note is required");
  const safeId = safeSegment(caseId);
  let current = "# Notes\n\n";
  try { current = await workspace.fs.readFile("/notes.md", "utf8"); } catch { /* first note */ }
  await workspace.fs.writeFile("/notes.md", `${current.trimEnd()}\n\n## ${new Date().toISOString()}\n\n${clean}\n`);
  return { ok: true, caseId: safeId, path: "/notes.md", bytes: clean.length };
}

async function auditCase(env: Env, caseId: string): Promise<Record<string, unknown>> {
  const safeId = safeSegment(caseId);
  return caseWorkspace(env, safeId).auditCase(safeId);
}

async function auditCaseInWorkspace(workspace: WorkspaceClient, caseId: string): Promise<Record<string, unknown>> {
  const safeId = safeSegment(caseId);
  const files = (await walk(workspace)).filter((entry) => !entry.directory);
  const required = ["/case.json", "/bundle.json", "/research-plan.md", "/evidence.ndjson", "/timeline.md", "/sources.csv", "/claims.json", "/dossier.md", "/notes.md"];
  const available = new Set(files.map((entry) => entry.path));
  const missing = required.filter((path) => !available.has(path));
  const hashTargets = files.filter((file) => file.path !== "/audit.md");
  const hashCommand = hashTargets.length > 0
    ? `sha256sum ${hashTargets.map((file) => shellQuote(file.path)).join(" ")}`
    : "sha256sum /dev/null";
  using handle = await workspace.runtime.exec(hashCommand, { encoding: "utf8" });
  const result = await handle.result();
  const hashes = result.stdout.trim().split("\n").filter(Boolean);
  const report = ["# Mission Computer audit", "", `Run ${new Date().toISOString()}`, "", "- Runtime: Cloudflare Computer", "- Execution backend: Worker shell", `- Required files present: ${missing.length === 0 ? "yes" : "no"}`, `- Files: ${files.length}`, "", "## Missing", "", ...(missing.length ? missing.map((path) => `- ${path}`) : ["- None"]), "", "## SHA-256", "", "```text", result.stdout.trim(), "```", ""].join("\n");
  await workspace.fs.writeFile("/audit.md", report);
  return { caseId: safeId, ok: missing.length === 0 && result.exitCode === 0 && hashes.length === hashTargets.length, missing, files, hashes, stderr: result.stderr, path: "/audit.md", runtime: "cloudflare-computer", execution: "worker-shell" };
}


const STRUCTURED_TRANSFORM_SOURCE = `
import { mkdir, readFile, writeFile } from "node:fs/promises";

const countBy = (rows, key) => {
  const counts = {};
  for (const row of rows) {
    const value = String(key(row) ?? "Unknown");
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, count]) => ({ label, count }));
};

export default async (input) => {
  const bundle = JSON.parse(await readFile("/bundle.json", "utf8"));
  const evidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  const program = String(input?.program || "source-map");
  let result;

  if (program === "source-map") {
    result = {
      evidenceCount: evidence.length,
      bySource: countBy(evidence, (row) => row.source || row.provider),
      byProvider: countBy(evidence, (row) => row.provider || row.source),
      byAccessClass: countBy(evidence, (row) => row.accessClass || "public"),
      linkedStories: countBy(evidence, (row) => row.storyId || "unlinked"),
    };
  } else if (program === "timeline-gaps") {
    const dated = evidence
      .filter((row) => row.publishedAt && !Number.isNaN(Date.parse(row.publishedAt)))
      .map((row) => ({ id: row.itemId, title: row.title, source: row.source, url: row.url, at: new Date(row.publishedAt).toISOString() }))
      .sort((left, right) => left.at.localeCompare(right.at));
    const gaps = [];
    for (let index = 1; index < dated.length; index += 1) {
      const previous = dated[index - 1];
      const current = dated[index];
      const hours = (Date.parse(current.at) - Date.parse(previous.at)) / 3_600_000;
      if (hours >= 24) gaps.push({ hours: Math.round(hours * 10) / 10, previous, current });
    }
    result = { datedCount: dated.length, first: dated[0] || null, last: dated.at(-1) || null, gaps: gaps.sort((a, b) => b.hours - a.hours).slice(0, 50) };
  } else if (program === "evidence-matrix") {
    const matrix = {};
    for (const row of evidence) {
      const story = String(row.storyId || "unlinked");
      const source = String(row.source || row.provider || "Unknown");
      matrix[story] ||= {};
      matrix[story][source] = (matrix[story][source] || 0) + 1;
    }
    result = { stories: Object.entries(matrix).map(([storyId, sources]) => ({ storyId, sources, evidenceCount: Object.values(sources).reduce((a, b) => a + b, 0) })) };
  } else if (program === "claim-review-queue") {
    const claims = JSON.parse(await readFile("/claims.json", "utf8"));
    const queue = (Array.isArray(claims) ? claims : [])
      .filter((claim) => claim.reviewStatus !== "reviewed")
      .map((claim) => ({ id: claim.id, text: claim.text, source: claim.source, url: claim.url, publishedAt: claim.publishedAt, reviewStatus: claim.reviewStatus }));
    result = { pendingCount: queue.length, queue };
  } else {
    throw new Error("Unknown structured transform: " + program);
  }

  await mkdir("/exports", { recursive: true });
  const path = "/exports/transform-" + program + ".json";
  await writeFile(path, JSON.stringify({ program, generatedAt: new Date().toISOString(), result }, null, 2) + "\\n");
  return { program, path, result };
};
`;

type StructuredTransform = "source-map" | "timeline-gaps" | "evidence-matrix" | "claim-review-queue";

function structuredTransform(value: unknown): StructuredTransform {
  return value === "source-map" || value === "timeline-gaps" || value === "evidence-matrix" || value === "claim-review-queue"
    ? value
    : "source-map";
}

async function runStructuredTransform(env: Env, caseId: string, program: StructuredTransform): Promise<Record<string, unknown>> {
  const safeId = safeSegment(caseId);
  return caseWorkspace(env, safeId).runStructuredTransform(safeId, program);
}

async function runStructuredTransformInWorkspace(workspace: WorkspaceClient, caseId: string, program: StructuredTransform): Promise<Record<string, unknown>> {
  const safeId = safeSegment(caseId);
  const allowed: StructuredTransform[] = ["source-map", "timeline-gaps", "evidence-matrix", "claim-review-queue"];
  if (!allowed.includes(program)) throw new Error(`Unsupported structured transform: ${program}`);
  using handle = await workspace.runtime.exec(STRUCTURED_TRANSFORM_SOURCE, {
    backend: "worker-javascript",
    cwd: "/",
    input: { program },
    encoding: "utf8",
  });
  const result = await handle.result();
  if (result.exitCode !== 0) throw new Error(result.stderr || `Transform exited ${result.exitCode}`);
  return {
    ok: true,
    caseId: safeId,
    backend: "worker-javascript",
    program,
    stdout: result.stdout,
    value: result.value,
  };
}

async function authorize(request: Request, env: Env): Promise<Response | null> {
  if (!env.DEEP_DIVE_LAB_SECRET || env.DEEP_DIVE_LAB_SECRET.length < 24) return json({ ok: false, error: "DEEP_DIVE_LAB_SECRET is not configured" }, 503);
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return token === env.DEEP_DIVE_LAB_SECRET ? null : json({ ok: false, error: "Unauthorized" }, 401);
}

function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "driftglass-computer-power-mode", version: "0.9.0" });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool("get_case", { title: "Get a Mission Computer case", description: "Get the manifest and file inventory for a powered Driftglass evidence workspace.", inputSchema: { caseId: z.string().min(1).max(100) }, annotations: readOnly }, async ({ caseId }: { caseId: string }): ToolResultPromise => { const value = await getCase(env, caseId); return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; });
  server.registerTool("read_case_file", { title: "Read a case file", description: "Read a dossier, timeline, source ledger, claim set, note, audit, or evidence file.", inputSchema: { caseId: z.string().min(1).max(100), path: z.string().min(1).max(300) }, annotations: readOnly }, async ({ caseId, path }: { caseId: string; path: string }): ToolResultPromise => ({ content: [{ type: "text", text: await readCaseFile(env, caseId, path) }] }));
  server.registerTool("search_case", { title: "Search a Mission Computer case", description: "Search every durable case file through Cloudflare Computer's filesystem.", inputSchema: { caseId: z.string().min(1).max(100), query: z.string().min(1).max(300) }, annotations: readOnly }, async ({ caseId, query }: { caseId: string; query: string }): ToolResultPromise => { const value = await searchCase(env, caseId, query); return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; });
  server.registerTool("append_case_note", { title: "Append a durable case note", description: "Persist a finding or hypothesis in the powered Mission Computer.", inputSchema: { caseId: z.string().min(1).max(100), note: z.string().min(1).max(20_000) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, async ({ caseId, note }: { caseId: string; note: string }): ToolResultPromise => { const value = await appendCaseNote(env, caseId, note); return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; });
  server.registerTool("run_case_audit", { title: "Run a Computer workspace audit", description: "Use the isolate-shell backend to hash and verify a case workspace.", inputSchema: { caseId: z.string().min(1).max(100) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ caseId }: { caseId: string }): ToolResultPromise => { const value = await auditCase(env, caseId); return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; });
  server.registerTool("run_structured_transform", { title: "Run a structured Computer transform", description: "Run a typed JavaScript-isolate transform over the durable case workspace and save the JSON result under exports/.", inputSchema: { caseId: z.string().min(1).max(100), program: z.enum(["source-map", "timeline-gaps", "evidence-matrix", "claim-review-queue"]) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ caseId, program }: { caseId: string; program: StructuredTransform }): ToolResultPromise => { const value = await runStructuredTransform(env, caseId, program); return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; });
  return server;
}

async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const incoming = new URL(request.url);
  const match = incoming.pathname.match(/^\/mcp\/([^/]+)\/?$/);
  if (!match || match[1] !== await mcpKey(env)) return new Response("Not found", { status: 404 });
  const rewritten = new URL(request.url); rewritten.pathname = "/mcp";
  const handler = createMcpHandler(() => createMcpServer(env), { route: "/mcp", responseMode: "json", legacy: "stateless", allowedHostnames: [incoming.hostname], allowedOriginHostnames: [incoming.hostname, "chatgpt.com", "chat.openai.com"], onerror: (error: Error) => console.error("Computer Power Mode MCP error", error) });
  return handler(new Request(rewritten, request), env, ctx);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") return json({ ok: true, app: env.APP_NAME ?? "Driftglass Computer Power Mode", runtime: "@cloudflare/computer", storage: "durable-object-sqlite", execution: ["worker-shell", "worker-javascript"], version: "0.9.0" });
      if (url.pathname.startsWith("/mcp/")) return handleMcp(request, env, ctx);
      const denied = await authorize(request, env); if (denied) return denied;
      if (url.pathname === "/integration" && request.method === "GET") return json({ ok: true, mcpUrl: `${url.origin}/mcp/${await mcpKey(env)}`, apiBaseUrl: url.origin, runtime: "@cloudflare/computer", storage: "durable-object-sqlite", execution: ["worker-shell", "worker-javascript"] });
      const match = url.pathname.match(/^\/cases\/([^/]+)(?:\/(bundle|files|file|grep|note|audit|transform|export))?$/);
      if (!match) return json({ ok: false, error: "Not found" }, 404);
      const caseId = decodeURIComponent(match[1]!); const action = match[2] ?? "files";
      if (action === "bundle" && request.method === "POST") return json({ ok: true, manifest: await prepareCase(env, caseId, await readJson(request)) }, 201);
      if (action === "files" && request.method === "GET") return json({ ok: true, ...(await getCase(env, caseId)) });
      if (action === "file" && request.method === "GET") { const path = url.searchParams.get("path") || "/dossier.md"; return new Response(await readCaseFile(env, caseId, path), { headers: { "content-type": path.endsWith(".json") ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "cache-control": "no-store" } }); }
      if (action === "grep" && request.method === "POST") { const body = await readJson(request); return json({ ok: true, ...(await searchCase(env, caseId, requestString(body, "query"))) }); }
      if (action === "note" && request.method === "POST") { const body = await readJson(request); return json(await appendCaseNote(env, caseId, requestString(body, "note"))); }
      if (action === "audit" && request.method === "POST") return json({ ok: true, ...(await auditCase(env, caseId)) });
      if (action === "transform" && request.method === "POST") { const body = await readJson(request); return json(await runStructuredTransform(env, caseId, structuredTransform(isRecord(body) ? body.program : undefined))); }
      if (action === "export" && request.method === "GET") return new Response(await readCaseFile(env, caseId, "/dossier.md"), { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${safeSegment(caseId)}-dossier.md"`, "cache-control": "no-store" } });
      return json({ ok: false, error: "Method not allowed" }, 405);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  },
} satisfies ExportedHandler<Env>;
