import { DurableObject, tracing } from "cloudflare:workers";
import {
  getWorkspace,
  withWorkspace,
  type DurableObjectStorageLike,
} from "@cloudflare/computer";
import { getMission } from "./db";
import { buildDeepResearchHandoffFromSnapshot, deepResearchMarkdown } from "./deep-research";
import { requireBudget, reserve } from "./budget";
import {
  loadMissionComputerCoreSnapshot,
  loadMissionComputerMemorySnapshot,
  loadMissionComputerPeripheralSnapshot,
  type MissionComputerMemoryNode,
} from "./mission-computer-inputs";
import {
  loadMissionMatchSnapshot,
  MISSION_SNAPSHOT_EVIDENCE_TEXT_CHARACTERS,
  type MissionMatchSnapshot,
} from "./mission-snapshot";
import type { WorkspacePort } from "./runtime/ports";
import { sha256 } from "./security";
import type { Env, MissionOperatorRecord, MissionRecord, MissionResearchStateRecord } from "./types";
import { excerpt, HttpError, isMissingPathError, isoNow, parseJson } from "./utils";

const MAX_FILE_BYTES = 1_000_000;
export const MISSION_COMPUTER_SYNC_SNAPSHOT_MAX_BYTES = 500_000;
export const MISSION_COMPUTER_SYNC_PLAN_MAX_BYTES = 750_000;
const TEXT_ENCODER = new TextEncoder();
const WORKSPACE_STORAGE = Symbol("mission-computer-workspace-storage");

function workspaceStorage(storage: DurableObjectStorage): DurableObjectStorageLike {
  return {
    sql: {
      exec<Row extends object = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
        const rows = storage.sql.exec<Record<string, SqlStorageValue>>(query, ...bindings).toArray();
        return {
          // Computer currently permits arbitrary object rows while Workers SQL
          // correctly narrows values to the platform's serializable SQL values.
          toArray: () => rows as Row[],
        };
      },
    },
    transactionSync: <T>(closure: () => T) => storage.transactionSync(closure),
  };
}

class MissionComputerStorageHost extends DurableObject<Record<string, never>> {
  readonly [WORKSPACE_STORAGE]: DurableObjectStorageLike;

  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    this[WORKSPACE_STORAGE] = workspaceStorage(ctx.storage);
  }
}

export class MissionComputer extends withWorkspace(
  MissionComputerStorageHost,
  (self) => ({ storage: self[WORKSPACE_STORAGE] }),
) {}

export interface MissionComputerFile {
  path: string;
  name: string;
  directory: boolean;
  depth: number;
}

export interface MissionComputerSummary {
  missionId: string;
  mode: "filesystem";
  freeTierCapable: true;
  syncedAt: string | null;
  syncReason: string | null;
  fileCount: number;
  evidenceCount: number;
  storyCount: number;
  files: MissionComputerFile[];
}

export interface MissionComputerSyncPlan {
  schemaVersion: "1";
  planHash: string;
  snapshotId: string;
  missionId: string;
  reason: string;
  syncedAt: string;
  missionUpdatedAt: string;
  operatorUpdatedAt: string | null;
  researchUpdatedAt: string | null;
  matchedStoriesAvailable: number;
  lastMatchedAt: string | null;
  latestStoryChangedAt: string | null;
  storyCount: number;
  evidenceCount: number;
  memoryNodeCount: number;
  memoryEdgeCount: number;
  snapshotCoverage: MissionMatchSnapshot["coverage"];
  peripheralCoverage: Awaited<ReturnType<typeof loadMissionComputerPeripheralSnapshot>>["coverage"];
  memoryCoverage: Awaited<ReturnType<typeof loadMissionComputerMemorySnapshot>>["coverage"];
  fullFiles: Record<string, string>;
  seedFiles: Record<string, string>;
}

type MissionComputerSyncPlanPayload = Omit<MissionComputerSyncPlan, "planHash">;

export interface MissionComputerSyncSnapshot {
  schemaVersion: "1";
  snapshotHash: string;
  snapshotId: string;
  missionId: string;
  reason: string;
  syncedAt: string;
  localWorkspace: boolean;
  core: {
    mission: MissionRecord;
    operator: MissionOperatorRecord | null;
    research: MissionResearchStateRecord | null;
  };
  peripheralSnapshot: Awaited<ReturnType<typeof loadMissionComputerPeripheralSnapshot>>;
  matchedSnapshot: {
    matches: MissionMatchSnapshot["matches"];
    firstSeenAtByStory: string[][];
    evidence: MissionMatchSnapshot["evidence"];
    identity: MissionMatchSnapshot["identity"];
    coverage: MissionMatchSnapshot["coverage"];
  };
  memory: Awaited<ReturnType<typeof loadMissionComputerMemorySnapshot>>;
}

type MissionComputerSyncSnapshotPayload = Omit<MissionComputerSyncSnapshot, "snapshotHash">;

interface WorkspaceClient {
  fs: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    writeFile(path: string, content: string | Uint8Array | ReadableStream): Promise<void>;
    readFile(path: string, encoding?: "utf8"): Promise<string | ReadableStream>;
    readdir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    grep(pattern: string, path: string, options?: { ignoreCase?: boolean }): Promise<unknown>;
  };
  [Symbol.dispose]?: () => void;
}

type WorkspaceEnabledEnv = Env & { readonly RUNTIME_WORKSPACE?: WorkspacePort };

function injectedWorkspace(env: Env): WorkspacePort | undefined {
  return (env as WorkspaceEnabledEnv).RUNTIME_WORKSPACE;
}

function missionComputerStub(env: Env, missionId: string) {
  if (!env.MISSION_COMPUTER) throw new Error("MISSION_COMPUTER binding is unavailable");
  const id = env.MISSION_COMPUTER.idFromName(`mission:${missionId}`);
  return env.MISSION_COMPUTER.get(id);
}

// Computer 0.1.1's public handle type names the concrete WorkspaceStub class,
// while Workers RPC correctly rewrites that returned RpcTarget into Stub<T>.
// The runtime API is designed for this DO stub; widen only that package edge.
const getDurableWorkspace = getWorkspace as (
  handle: ReturnType<typeof missionComputerStub>,
) => ReturnType<typeof getWorkspace>;

async function withComputer<T>(env: Env, missionId: string, callback: (workspace: WorkspaceClient) => Promise<T>): Promise<T> {
  const local = injectedWorkspace(env);
  if (local) {
    try {
      const workspace = await local.forMission(missionId);
      return await callback(workspace as unknown as WorkspaceClient);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ERR_DRIFTGLASS_WORKSPACE_PATH") {
        throw new HttpError(400, "Mission workspace path is unsafe");
      }
      throw error;
    }
  }
  const workspace = await getDurableWorkspace(missionComputerStub(env, missionId));
  try {
    return await callback(workspace);
  } finally {
    workspace[Symbol.dispose]?.();
  }
}

function safePath(value: string): string {
  const normalized = `/${String(value || "").replace(/^\/+/, "")}`.replace(/\/+/g, "/");
  if (normalized.includes("..") || normalized.includes("\0")) throw new HttpError(400, "Invalid Mission Computer path");
  return normalized;
}


const WRITABLE_LOCAL_PREFIXES = ["/notes/", "/results/", "/exports/"] as const;

function localWritablePath(value: string): string {
  const path = safePath(value);
  if (!WRITABLE_LOCAL_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new Error("Local workspace pushes must target notes/, results/, or exports/");
  }
  return path;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ndjson(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

function textBytes(content: string): number {
  return TEXT_ENCODER.encode(content).byteLength;
}

interface ComputerFileWrite {
  path: string;
  content: string;
}

function computerWriteBytes(writes: readonly ComputerFileWrite[]): number {
  return writes.reduce((total, write) => total + textBytes(write.content), 0);
}

async function textOrNull(workspace: WorkspaceClient, path: string): Promise<string | null> {
  try {
    const value = await workspace.fs.readFile(path, "utf8");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

async function changedComputerFiles(
  workspace: WorkspaceClient,
  files: Record<string, string>,
  seedOnlyFiles: Record<string, string> = {},
): Promise<ComputerFileWrite[]> {
  const writes: ComputerFileWrite[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (await textOrNull(workspace, path) !== content) writes.push({ path, content });
  }
  for (const [path, content] of Object.entries(seedOnlyFiles)) {
    if (await textOrNull(workspace, path) === null) writes.push({ path, content });
  }
  return writes;
}

async function applyComputerFiles(workspace: WorkspaceClient, writes: readonly ComputerFileWrite[]): Promise<void> {
  const markerRank = (path: string) => path === "/state/latest-sync.json"
    ? 2
    : path === "/system/manifest.json" ? 1 : 0;
  const orderedWrites = [...writes].sort((left, right) => markerRank(left.path) - markerRank(right.path));
  for (const write of orderedWrites) {
    const parent = write.path.slice(0, write.path.lastIndexOf("/")) || "/";
    if (parent !== "/") await workspace.fs.mkdir(parent, { recursive: true });
    await workspace.fs.writeFile(write.path, write.content);
  }
}

function missionMarkdown(input: {
  mission: MissionRecord;
  operator: MissionOperatorRecord | null;
  research: MissionResearchStateRecord | null;
  storyCount: number;
  evidenceCount: number;
  snapshotCoverage: MissionMatchSnapshot["coverage"];
  syncedAt: string;
}): string {
  const terms = parseJson<string[]>(input.mission.terms_json, []);
  const scope = parseJson<string[]>(input.mission.source_scope_json, []);
  const openQuestions = parseJson<string[]>(input.research?.open_questions_json ?? "[]", []);
  const purpose = ({
    watch: "Stay current",
    decision: "Support a decision",
    hypothesis: "Test a belief",
    forecast: "Follow an expected event",
  } as Record<string, string>)[input.operator?.mode ?? "watch"] ?? "Stay current";
  const sourceChecks = ({
    manual: "When you ask",
    automatic: "Automatic",
  } as Record<string, string>)[input.operator?.sprint_policy ?? "manual"] ?? input.operator?.sprint_policy ?? "When you ask";
  const aiReview = ({
    never: "Only when you ask",
    suggest: "Suggest when it would help",
    automatic: "Prepare for meaningful updates",
  } as Record<string, string>)[input.operator?.research_policy ?? "suggest"] ?? "Suggest when it would help";
  return [
    `# ${input.mission.name}`,
    "",
    input.mission.question ? `> ${input.mission.question}` : "> A standing research question",
    "",
    "## At a glance",
    "",
    `- Status: ${input.mission.status === "active" ? "Active" : input.mission.status}`,
    `- Purpose: ${purpose}`,
    input.operator?.outcome_status && input.operator.outcome_status !== "open" ? `- Outcome: ${input.operator.outcome_status}` : "",
    `- Source checks: ${sourceChecks}`,
    `- Broader AI review: ${aiReview}`,
    input.operator?.expected_next_event ? `- Next observable event: ${input.operator.expected_next_event}` : "",
    input.operator?.expected_by ? `- Expected by: ${input.operator.expected_by}` : "",
    "",
    "## Current thesis",
    "",
    input.research?.current_thesis || input.research?.report_summary || "No durable research conclusion has been saved yet.",
    "",
    "## Open questions",
    "",
    ...(openQuestions.length ? openQuestions.map((question) => `- ${question}`) : ["- No open questions recorded yet."]),
    "",
    "## Signals being followed",
    "",
    terms.length ? terms.map((term) => `- ${term}`).join("\n") : "- No explicit terms configured.",
    "",
    "## Sources included",
    "",
    scope.length ? scope.map((source) => `- ${source}`).join("\n") : "- All enabled sources",
    "",
    "## What is saved here",
    "",
    `- Snapshot: ${input.storyCount} matched Stories and ${input.evidenceCount} source items`,
    input.snapshotCoverage.hasMoreMatchedStories || input.snapshotCoverage.hasMoreEvidence
      ? "- Additional matched material sits outside this snapshot"
      : "",
    "- Connected memory and a timeline of changes",
    "- Source material prepared for deeper reasoning",
    "- Notes, reviewed results, and exports that survive refreshes",
    "",
  ].filter(Boolean).join("\n");
}

function collectMissionEvidence(snapshot: MissionMatchSnapshot) {
  const stories: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];

  for (const match of snapshot.matches) {
    const storyId = String(match.story_id ?? "");
    const firstSeenAt = snapshot.firstSeenAtByStory.get(storyId);
    if (!storyId || !firstSeenAt) continue;
    stories.push({
      id: storyId,
      title: String(match.title ?? ""),
      summary: String(match.summary ?? ""),
      score: Number(match.score ?? 0),
      confidence: Number(match.confidence ?? 0),
      sourceCount: Number(match.source_count ?? 0),
      firstSeenAt,
      lastChangedAt: String(match.last_changed_at ?? ""),
      matchScore: Number(match.match_score ?? 0),
      matchedTerms: parseJson<unknown[]>(String(match.matched_terms_json ?? "[]"), [])
        .slice(0, 32)
        .map((term) => String(term).slice(0, 100)),
    });
  }
  for (const item of snapshot.evidence) {
    const metadata = Object.fromEntries(
      Object.entries(parseJson<Record<string, unknown>>(item.metadata_json, {}))
        .filter((entry) => entry[1] !== null),
    );
    evidence.push({
      id: item.item_id,
      storyId: item.story_id,
      title: item.title,
      url: item.url,
      author: item.author,
      source: item.source_name,
      publishedAt: item.published_at ?? item.observed_at,
      accessClass: item.access_class,
      provider: typeof metadata.provider === "string" ? metadata.provider : undefined,
      excerpt: excerpt(item.text, MISSION_SNAPSHOT_EVIDENCE_TEXT_CHARACTERS),
      metadata,
    });
  }
  return { stories, evidence };
}

function memoryTimelineFromNodes(
  nodes: MissionComputerMemoryNode[],
  limit = 60,
): Array<Record<string, unknown>> {
  return nodes
    .filter((node) => node.occurred_at || node.valid_from || node.node_type === "event" || node.node_type === "expectation")
    .sort((left, right) => Date.parse(right.occurred_at ?? right.valid_from ?? right.updated_at)
      - Date.parse(left.occurred_at ?? left.valid_from ?? left.updated_at))
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map((node) => ({
      id: node.id,
      type: node.node_type,
      label: node.label,
      summary: node.summary,
      at: node.occurred_at ?? node.valid_from ?? node.updated_at,
      status: node.status,
      importance: node.importance,
      confidence: node.confidence,
      sourceRef: node.source_ref,
    }));
}

export async function loadMissionComputerSyncSnapshot(
  env: Env,
  missionId: string,
  reason = "manual",
): Promise<MissionComputerSyncSnapshot> {
  return tracing.enterSpan("driftglass.mission_computer.load", async (span) => {
    span.setAttribute("driftglass.mission.id", missionId);
    span.setAttribute("driftglass.mission_computer.reason", reason);
    const [core, peripheralSnapshot] = await Promise.all([
      loadMissionComputerCoreSnapshot(env.DB, missionId),
      loadMissionComputerPeripheralSnapshot(env.DB, missionId),
    ]);
    const { mission, operator, research } = core;
    if (!mission) throw new Error(`Mission not found: ${missionId}`);
    const [matchedSnapshot, memory] = await Promise.all([
      loadMissionMatchSnapshot(env.DB, missionId),
      loadMissionComputerMemorySnapshot(env.DB, missionId),
    ]);
    const payload: MissionComputerSyncSnapshotPayload = {
      schemaVersion: "1",
      snapshotId: crypto.randomUUID(),
      missionId,
      reason,
      syncedAt: isoNow(),
      localWorkspace: Boolean(injectedWorkspace(env)),
      core: { mission, operator, research },
      peripheralSnapshot,
      matchedSnapshot: {
        matches: matchedSnapshot.matches,
        firstSeenAtByStory: [...matchedSnapshot.firstSeenAtByStory],
        evidence: matchedSnapshot.evidence,
        identity: matchedSnapshot.identity,
        coverage: matchedSnapshot.coverage,
      },
      memory,
    };
    const snapshot: MissionComputerSyncSnapshot = {
      ...payload,
      snapshotHash: await sha256(JSON.stringify(payload)),
    };
    const snapshotBytes = textBytes(JSON.stringify(snapshot));
    if (snapshotBytes > MISSION_COMPUTER_SYNC_SNAPSHOT_MAX_BYTES) {
      throw new Error(`Mission Computer sync snapshot exceeds ${MISSION_COMPUTER_SYNC_SNAPSHOT_MAX_BYTES} bytes`);
    }
    span.setAttribute("driftglass.mission_computer.snapshot_bytes", snapshotBytes);
    return snapshot;
  });
}

export async function renderMissionComputerSyncPlan(
  snapshot: MissionComputerSyncSnapshot,
): Promise<MissionComputerSyncPlan> {
  return tracing.enterSpan("driftglass.mission_computer.render", async (span) => {
    if (snapshot.schemaVersion !== "1" || !snapshot.snapshotHash || !snapshot.snapshotId) {
      throw new Error("Mission Computer sync snapshot is invalid");
    }
    if (textBytes(JSON.stringify(snapshot)) > MISSION_COMPUTER_SYNC_SNAPSHOT_MAX_BYTES) {
      throw new Error("Mission Computer sync snapshot is too large");
    }
    const { snapshotHash, ...snapshotPayload } = snapshot;
    if (await sha256(JSON.stringify(snapshotPayload)) !== snapshotHash) {
      throw new Error("Mission Computer sync snapshot failed its integrity check");
    }
    const { mission, operator, research } = snapshot.core;
    const evidenceByStory = new Map<string, MissionMatchSnapshot["evidence"]>();
    for (const item of snapshot.matchedSnapshot.evidence) {
      const group = evidenceByStory.get(item.story_id) ?? [];
      group.push(item);
      evidenceByStory.set(item.story_id, group);
    }
    const matchedSnapshot: MissionMatchSnapshot = {
      matches: snapshot.matchedSnapshot.matches,
      firstSeenAtByStory: new Map(snapshot.matchedSnapshot.firstSeenAtByStory
        .filter((entry) => entry.length >= 2)
        .map((entry) => [entry[0] ?? "", entry[1] ?? ""] as [string, string])),
      evidenceByStory,
      evidence: snapshot.matchedSnapshot.evidence,
      identity: snapshot.matchedSnapshot.identity,
      coverage: snapshot.matchedSnapshot.coverage,
    };
    const { peripheralSnapshot, memory } = snapshot;
    const { events, runs, sourceHealth } = peripheralSnapshot;
    const handoff = buildDeepResearchHandoffFromSnapshot({
      mission,
      operatorRow: operator,
      researchState: research,
      matches: matchedSnapshot,
      runs: runs.slice(0, 5),
      events: events.slice(0, 20),
      sourceHealth,
    });
    const collected = collectMissionEvidence(matchedSnapshot);
    const timeline = memoryTimelineFromNodes(memory.nodes, 60);
    const { missionId, reason, syncedAt, snapshotId } = snapshot;
    span.setAttribute("driftglass.mission.id", missionId);
    span.setAttribute("driftglass.mission_computer.reason", reason);
    const memoryNodes = memory.nodes.map((node) => ({
      id: node.id,
      type: node.node_type,
      label: node.label,
      summary: node.summary,
      status: node.status,
      importance: node.importance,
      confidence: node.confidence,
      occurredAt: node.occurred_at,
      validFrom: node.valid_from,
      validTo: node.valid_to,
      sourceRef: node.source_ref,
      aliases: parseJson(node.aliases_json, []),
    }));
    const memoryEdges = memory.edges.map((edge) => ({
      id: edge.id,
      from: edge.from_node_id,
      to: edge.to_node_id,
      relation: edge.relation,
      weight: edge.weight,
      confidence: edge.confidence,
      rationale: edge.rationale,
      evidence: parseJson(edge.evidence_json, []),
    }));
    const memoryContextFor = (
      nodes: typeof memoryNodes,
      edges: typeof memoryEdges,
      timelineEntries: Array<Record<string, unknown>>,
    ) => [
      `# Durable memory · ${mission.name}`,
      "",
      "This is a bounded, provenance-aware neighborhood around the Mission. It complements evidence excerpts rather than replacing them.",
      "",
      `- ${nodes.length} memory nodes`,
      `- ${edges.length} memory relations`,
      `- ${timelineEntries.length} timeline entries`,
      "",
      "## High-importance memory",
      "",
      ...[...nodes].sort((left, right) => Number(right.importance) - Number(left.importance)).slice(0, 30).map((node) => `- **${node.label}** · ${node.type} · confidence ${Number(node.confidence).toFixed(2)}\n  ${node.summary || "No summary"}`),
      "",
      "## Important relationships",
      "",
      ...[...edges].sort((left, right) => Number(right.weight) - Number(left.weight)).slice(0, 50).map((edge) => `- \`${edge.from}\` **${edge.relation}** \`${edge.to}\`${edge.rationale ? ` — ${edge.rationale}` : ""}`),
      "",
    ].join("\n");
    const memoryTimelineText = (entries: Array<Record<string, unknown>>) => [
      "# Mission memory timeline",
      "",
      ...entries.map((entry) => `- ${String(entry.at ?? "")} · **${String(entry.label ?? "Memory")}** · ${String(entry.type ?? "memory")}\n  ${String(entry.summary ?? "")}`),
      "",
    ].join("\n");
    const memoryContext = memoryContextFor(memoryNodes, memoryEdges, timeline);
    const localWorkspace = snapshot.localWorkspace;
    const fullFiles: Record<string, string> = {
      "/README.md": [
        `# Mission Computer · ${mission.name}`,
        "",
        "This durable workspace belongs to one Driftglass Research Mission.",
        localWorkspace
          ? "It is stored in this Driftglass server's private Mission directory and remains available across restarts."
          : "It is backed by Cloudflare Computer's SQLite virtual filesystem and remains available across Worker restarts.",
        "",
        "Start with `mission.md`, inspect `stories/index.ndjson` and `evidence/index.ndjson`, and keep durable working notes under `notes/`.",
        "",
      ].join("\n"),
      "/mission.md": missionMarkdown({
        mission,
        operator,
        research,
        storyCount: collected.stories.length,
        evidenceCount: collected.evidence.length,
        snapshotCoverage: matchedSnapshot.coverage,
        syncedAt,
      }),
      "/state/mission.json": jsonText({ ...mission, terms: parseJson(mission.terms_json, []), sourceScope: parseJson(mission.source_scope_json, []) }),
      "/state/operator.json": jsonText(operator),
      "/state/research.json": jsonText(research ? { ...research, openQuestions: parseJson(research.open_questions_json, []) } : null),
      "/state/latest-sync.json": jsonText({
        missionId,
        snapshotId,
        syncedAt,
        reason,
        syncMode: "full",
        storyCount: collected.stories.length,
        evidenceCount: collected.evidence.length,
        runCount: runs.length,
        snapshotCoverage: matchedSnapshot.coverage,
        peripheralCoverage: peripheralSnapshot.coverage,
        memoryCoverage: memory.coverage,
      }),
      "/ledger/events.ndjson": ndjson(events),
      "/ledger/sprints.ndjson": ndjson(runs.map((run) => ({ ...run, sourceIds: parseJson(run.source_ids_json, []), result: parseJson(run.result_json, {}) }))),
      "/stories/index.ndjson": ndjson(collected.stories),
      "/evidence/index.ndjson": ndjson(collected.evidence),
      "/memory/nodes.ndjson": ndjson(memoryNodes),
      "/memory/edges.ndjson": ndjson(memoryEdges),
      "/memory/timeline.md": memoryTimelineText(timeline),
      "/memory/context.md": memoryContext,
      "/handoffs/deep-research.md": deepResearchMarkdown(handoff),
      "/handoffs/deep-research.json": jsonText(handoff),
    };
    const seedFiles: Record<string, string> = {
      "/notes/README.md": "# Working notes\n\nDurable notes written here are preserved across Mission refreshes.\n",
      "/results/README.md": "# Reviewed results\n\nStore approved research conclusions and reusable artifacts here.\n",
    };
    const snapshotIdentity = matchedSnapshot.identity ?? {
      matchedStoriesAvailable: matchedSnapshot.coverage.matchedStoriesAvailable,
      lastMatchedAt: typeof matchedSnapshot.matches[0]?.last_matched_at === "string"
        ? matchedSnapshot.matches[0].last_matched_at
        : null,
      latestStoryChangedAt: matchedSnapshot.matches.reduce<string | null>((latest, match) => {
        const changedAt = typeof match.last_changed_at === "string" ? match.last_changed_at : null;
        return changedAt && (!latest || changedAt > latest) ? changedAt : latest;
      }, null),
    };
    const payload: MissionComputerSyncPlanPayload = {
      schemaVersion: "1",
      snapshotId,
      missionId,
      reason,
      syncedAt,
      missionUpdatedAt: mission.updated_at,
      operatorUpdatedAt: operator?.updated_at ?? null,
      researchUpdatedAt: research?.updated_at ?? null,
      matchedStoriesAvailable: snapshotIdentity.matchedStoriesAvailable,
      lastMatchedAt: snapshotIdentity.lastMatchedAt,
      latestStoryChangedAt: snapshotIdentity.latestStoryChangedAt,
      storyCount: collected.stories.length,
      evidenceCount: collected.evidence.length,
      memoryNodeCount: memoryNodes.length,
      memoryEdgeCount: memoryEdges.length,
      snapshotCoverage: matchedSnapshot.coverage,
      peripheralCoverage: peripheralSnapshot.coverage,
      memoryCoverage: memory.coverage,
      fullFiles,
      seedFiles,
    };
    const plan: MissionComputerSyncPlan = {
      ...payload,
      planHash: await sha256(JSON.stringify(payload)),
    };
    const planBytes = textBytes(JSON.stringify(plan));
    if (planBytes > MISSION_COMPUTER_SYNC_PLAN_MAX_BYTES) {
      throw new Error(`Mission Computer sync plan exceeds ${MISSION_COMPUTER_SYNC_PLAN_MAX_BYTES} bytes`);
    }
    span.setAttribute("driftglass.mission_computer.plan_bytes", planBytes);
    span.setAttribute("driftglass.mission_computer.story_count", collected.stories.length);
    span.setAttribute("driftglass.mission_computer.evidence_count", collected.evidence.length);
    span.setAttribute("driftglass.mission_computer.memory_nodes", memoryNodes.length);
    span.setAttribute("driftglass.mission_computer.memory_edges", memoryEdges.length);
    return plan;
  });
}

export async function prepareMissionComputerSync(
  env: Env,
  missionId: string,
  reason = "manual",
): Promise<MissionComputerSyncPlan> {
  return renderMissionComputerSyncPlan(
    await loadMissionComputerSyncSnapshot(env, missionId, reason),
  );
}

function parseNdjsonRecords(content: string): Array<Record<string, unknown>> {
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => parseJson<Record<string, unknown>>(line, {}));
}

function compactFilesForPlan(plan: MissionComputerSyncPlan): Record<string, string> {
  const evidence = parseNdjsonRecords(plan.fullFiles["/evidence/index.ndjson"] ?? "").slice(0, 16);
  const nodes = parseNdjsonRecords(plan.fullFiles["/memory/nodes.ndjson"] ?? "").slice(0, 4);
  const nodeIds = new Set(nodes.map((node) => String(node.id ?? "")));
  const edges = parseNdjsonRecords(plan.fullFiles["/memory/edges.ndjson"] ?? "")
    .filter((edge) => nodeIds.has(String(edge.from ?? "")) && nodeIds.has(String(edge.to ?? "")))
    .slice(0, 8);
  const timeline = nodes
    .filter((node) => node.occurredAt || node.validFrom)
    .map((node) => ({
      at: node.occurredAt ?? node.validFrom,
      label: node.label,
      type: node.type,
      summary: node.summary,
    }));
  const mission = parseJson<Record<string, unknown>>(plan.fullFiles["/state/mission.json"] ?? "{}", {});
  const context = [
    `# Durable memory · ${String(mission.name ?? plan.missionId)}`,
    "",
    `- ${nodes.length} memory nodes`,
    `- ${edges.length} memory relations`,
    `- ${timeline.length} timeline entries`,
    "",
    "## High-importance memory",
    "",
    ...nodes.map((node) => `- **${String(node.label ?? "Memory")}** · ${String(node.type ?? "memory")}\n  ${String(node.summary ?? "")}`),
    "",
    "## Important relationships",
    "",
    ...edges.map((edge) => `- \`${String(edge.from ?? "")}\` **${String(edge.relation ?? "related_to")}** \`${String(edge.to ?? "")}\`${edge.rationale ? ` — ${String(edge.rationale)}` : ""}`),
    "",
  ].join("\n");
  const latestSync = parseJson<Record<string, unknown>>(
    plan.fullFiles["/state/latest-sync.json"] ?? "{}",
    {},
  );
  return {
    ...plan.fullFiles,
    "/mission.md": (plan.fullFiles["/mission.md"] ?? "").replace(
      /(- Snapshot: \d+ matched Stories and )\d+( source items)/,
      `$1${evidence.length}$2`,
    ),
    "/state/latest-sync.json": jsonText({
      ...latestSync,
      syncMode: "compact",
      evidenceCount: evidence.length,
    }),
    "/evidence/index.ndjson": ndjson(evidence),
    "/memory/nodes.ndjson": ndjson(nodes),
    "/memory/edges.ndjson": ndjson(edges),
    "/memory/timeline.md": [
      "# Mission memory timeline",
      "",
      ...timeline.map((entry) => `- ${String(entry.at ?? "")} · **${String(entry.label ?? "Memory")}** · ${String(entry.type ?? "memory")}\n  ${String(entry.summary ?? "")}`),
      "",
    ].join("\n"),
    "/memory/context.md": context,
  };
}

function manifestForPlan(
  plan: MissionComputerSyncPlan,
  managedFiles: Record<string, string>,
  syncMode: "full" | "compact",
): string {
  return jsonText({
    schemaVersion: "1",
    product: "Driftglass Mission Computer",
    missionId: plan.missionId,
    snapshotId: plan.snapshotId,
    syncedAt: plan.syncedAt,
    reason: plan.reason,
    mode: "filesystem",
    freeTierCapable: true,
    syncMode,
    snapshotCoverage: plan.snapshotCoverage,
    peripheralCoverage: plan.peripheralCoverage,
    memoryCoverage: plan.memoryCoverage,
    memoryNodeCount: syncMode === "full"
      ? plan.memoryNodeCount
      : parseNdjsonRecords(managedFiles["/memory/nodes.ndjson"] ?? "").length,
    memoryEdgeCount: syncMode === "full"
      ? plan.memoryEdgeCount
      : parseNdjsonRecords(managedFiles["/memory/edges.ndjson"] ?? "").length,
    managedFiles: Object.keys(managedFiles),
    preservedDirectories: ["/notes", "/results", "/exports"],
  });
}

interface MissionComputerCurrentState {
  mission_updated_at: string;
  operator_updated_at: string | null;
  research_updated_at: string | null;
  matched_stories_available: number;
  last_matched_at: string | null;
  latest_story_changed_at: string | null;
}

async function assertCurrentSyncPlan(env: Env, plan: MissionComputerSyncPlan): Promise<void> {
  if (plan.schemaVersion !== "1" || !plan.missionId || !plan.snapshotId || !plan.planHash) {
    throw new Error("Mission Computer sync plan is invalid");
  }
  if (textBytes(JSON.stringify(plan)) > MISSION_COMPUTER_SYNC_PLAN_MAX_BYTES) {
    throw new Error("Mission Computer sync plan is too large");
  }
  const { planHash, ...payload } = plan;
  if (await sha256(JSON.stringify(payload)) !== planHash) {
    throw new Error("Mission Computer sync plan failed its integrity check");
  }
  const current = await env.DB.prepare(
    `SELECT mission.updated_at AS mission_updated_at,
            operator.updated_at AS operator_updated_at,
            research.updated_at AS research_updated_at,
            COUNT(matched.story_id) AS matched_stories_available,
            MAX(matched.last_matched_at) AS last_matched_at,
            MAX(story.last_changed_at) AS latest_story_changed_at
     FROM missions mission
     LEFT JOIN mission_operators operator ON operator.mission_id = mission.id
     LEFT JOIN mission_research_state research ON research.mission_id = mission.id
     LEFT JOIN mission_story_matches matched ON matched.mission_id = mission.id
     LEFT JOIN stories story ON story.id = matched.story_id
     WHERE mission.id = ?
     GROUP BY mission.id, mission.updated_at, operator.updated_at, research.updated_at`,
  ).bind(plan.missionId).first<MissionComputerCurrentState>();
  const stale = !current
    || current.mission_updated_at !== plan.missionUpdatedAt
    || (current.operator_updated_at ?? null) !== plan.operatorUpdatedAt
    || (current.research_updated_at ?? null) !== plan.researchUpdatedAt
    || Number(current.matched_stories_available) !== plan.matchedStoriesAvailable
    || (current.last_matched_at ?? null) !== plan.lastMatchedAt
    || (current.latest_story_changed_at ?? null) !== plan.latestStoryChangedAt;
  if (stale) throw new Error("Mission Computer sync plan is stale; prepare it again");
}

export async function commitMissionComputerSync(
  env: Env,
  plan: MissionComputerSyncPlan,
): Promise<MissionComputerSummary> {
  return tracing.enterSpan("driftglass.mission_computer.commit", async (span) => {
    span.setAttribute("driftglass.mission.id", plan.missionId);
    span.setAttribute("driftglass.mission_computer.reason", plan.reason);
    await assertCurrentSyncPlan(env, plan);
    let files = plan.fullFiles;
    let syncMode: "full" | "compact" = "full";
    const wrote = await withComputer(env, plan.missionId, async (workspace) => {
      const previousSync = parseJson<Record<string, unknown>>(
        await textOrNull(workspace, "/state/latest-sync.json"),
        {},
      );
      const previousSyncedAt = typeof previousSync.syncedAt === "string" ? previousSync.syncedAt : null;
      const previousSnapshotId = typeof previousSync.snapshotId === "string" ? previousSync.snapshotId : null;
      if (previousSyncedAt && (
        previousSyncedAt > plan.syncedAt
        || (previousSyncedAt === plan.syncedAt && previousSnapshotId !== plan.snapshotId)
      )) {
        throw new Error("Mission Computer sync plan is older than the current snapshot");
      }
      const candidateWrites = async (managedFiles: Record<string, string>, mode: "full" | "compact") => changedComputerFiles(
        workspace,
        { ...managedFiles, "/system/manifest.json": manifestForPlan(plan, managedFiles, mode) },
        plan.seedFiles,
      );
      let writes = await candidateWrites(plan.fullFiles, "full");
      let bytes = computerWriteBytes(writes);
      let reservation = await reserve(env.DB, "computer_sync_bytes", bytes, {
        missionId: plan.missionId,
        reason: plan.reason,
        mode: "full",
        fileCount: writes.length,
      });
      if (!reservation.allowed) {
        const compactFiles = compactFilesForPlan(plan);
        files = compactFiles;
        syncMode = "compact";
        writes = await candidateWrites(compactFiles, "compact");
        bytes = computerWriteBytes(writes);
        reservation = await reserve(env.DB, "computer_sync_bytes", bytes, {
          missionId: plan.missionId,
          reason: plan.reason,
          mode: "compact",
          fileCount: writes.length,
        });
      }
      if (!reservation.allowed) return false;
      await applyComputerFiles(workspace, writes);
      if (writes.length > 0) await workspace.fs.mkdir("/exports", { recursive: true });
      return true;
    });
    if (!wrote) {
      span.setAttribute("driftglass.mission_computer.budget_deferred", true);
      return getMissionComputerSummary(env, plan.missionId);
    }
    span.setAttribute("driftglass.mission_computer.managed_file_count", Object.keys(files).length);
    span.setAttribute("driftglass.mission_computer.sync_mode", syncMode);
    return getMissionComputerSummary(env, plan.missionId);
  });
}

export async function syncMissionComputer(env: Env, missionId: string, reason = "manual"): Promise<MissionComputerSummary> {
  if (env.MISSION_WORKFLOW) {
    throw new Error("Cloud Mission Computer sync must use the bounded prepare and commit Workflow steps");
  }
  const plan = await prepareMissionComputerSync(env, missionId, reason);
  return commitMissionComputerSync(env, plan);
}

export interface MissionComputerSyncStart {
  status: "queued";
  workflowId: string;
  missionId: string;
}

export type MissionComputerSyncRequest = MissionComputerSyncStart | {
  status: "complete";
  missionId: string;
  computer: MissionComputerSummary;
};

export async function requestMissionComputerSync(
  env: Env,
  missionId: string,
  reason = "manual",
): Promise<MissionComputerSyncRequest> {
  if (!env.MISSION_WORKFLOW) {
    return {
      status: "complete",
      missionId,
      computer: await syncMissionComputer(env, missionId, reason),
    };
  }
  const boundedReason = reason.slice(0, 100);
  await requireBudget(env.DB, "workflow_steps", 3, {
    operation: "mission-computer-sync",
    missionId,
    reason: boundedReason,
  });
  const missionPart = missionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 36) || "mission";
  const workflowId = `mission-computer-${missionPart}-${crypto.randomUUID().slice(0, 12)}`.slice(0, 100);
  const instance = await env.MISSION_WORKFLOW.create({
    id: workflowId,
    params: {
      mode: "computer-sync",
      missionId,
      reason: boundedReason,
    },
  });
  return { status: "queued", workflowId: instance.id, missionId };
}

async function walkFiles(workspace: WorkspaceClient, path = "/", depth = 0, output: MissionComputerFile[] = []): Promise<MissionComputerFile[]> {
  if (depth > 6 || output.length >= 600) return output;
  const entries = await workspace.fs.readdir(path).catch(() => []);
  for (const entry of entries.sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory) || left.name.localeCompare(right.name))) {
    const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
    output.push({ path: child, name: entry.name, directory: Boolean(entry.isDirectory), depth });
    if (entry.isDirectory) await walkFiles(workspace, child, depth + 1, output);
    if (output.length >= 600) break;
  }
  return output;
}

export async function getMissionComputerSummary(env: Env, missionId: string): Promise<MissionComputerSummary> {
  return withComputer(env, missionId, async (workspace) => {
    const files = await walkFiles(workspace);
    const sync = parseJson<Record<string, unknown>>(await textOrNull(workspace, "/state/latest-sync.json"), {});
    return {
      missionId,
      mode: "filesystem",
      freeTierCapable: true,
      syncedAt: typeof sync.syncedAt === "string" ? sync.syncedAt : null,
      syncReason: typeof sync.reason === "string" ? sync.reason : null,
      fileCount: files.filter((file) => !file.directory).length,
      evidenceCount: Number(sync.evidenceCount ?? 0),
      storyCount: Number(sync.storyCount ?? 0),
      files,
    };
  });
}

export async function ensureMissionComputer(env: Env, missionId: string): Promise<MissionComputerSummary> {
  // Compatibility alias retained for callers that used the historical name.
  // This boundary is read-only: synchronization belongs to explicit write paths.
  return getMissionComputerSummary(env, missionId);
}

export async function readMissionComputerFile(env: Env, missionId: string, inputPath: string): Promise<{ path: string; content: string }> {
  const path = safePath(inputPath);
  return withComputer(env, missionId, async (workspace) => {
    let value: string | ReadableStream;
    try {
      value = await workspace.fs.readFile(path, "utf8");
    } catch (error) {
      if (isMissingPathError(error)) throw new HttpError(404, `Mission Computer file not found: ${path}`);
      throw error;
    }
    if (typeof value !== "string") throw new Error("Mission Computer file is not text");
    if (TEXT_ENCODER.encode(value).byteLength > MAX_FILE_BYTES) throw new Error("Mission Computer file exceeds the text preview limit");
    return { path, content: value };
  });
}

export async function searchMissionComputer(env: Env, missionId: string, query: string): Promise<{ query: string; matches: unknown }> {
  const clean = query.trim().slice(0, 300);
  if (!clean) throw new Error("Search query is required");
  return withComputer(env, missionId, async (workspace) => ({
    query: clean,
    matches: await workspace.fs.grep(clean, "/", { ignoreCase: true }),
  }));
}

export async function appendMissionComputerNote(
  env: Env,
  missionId: string,
  input: { title?: string; content: string; file?: string },
): Promise<{ path: string; appendedAt: string }> {
  const content = input.content.trim();
  if (!content) throw new Error("Note content is required");
  if (TEXT_ENCODER.encode(content).byteLength > 200_000) throw new Error("Note is too large");
  const date = new Date().toISOString().slice(0, 10);
  const filename = (input.file || `${date}.md`).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || `${date}.md`;
  const path = safePath(`/notes/${filename.endsWith(".md") ? filename : `${filename}.md`}`);
  const appendedAt = isoNow();
  await withComputer(env, missionId, async (workspace) => {
    const existing = await textOrNull(workspace, path) ?? `# ${input.title?.trim() || "Mission notes"}\n\n`;
    const nextContent = `${existing.trimEnd()}\n\n## ${appendedAt}\n\n${content}\n`;
    if (textBytes(nextContent) > MAX_FILE_BYTES) throw new Error("Mission Computer note exceeds the file limit");
    await requireBudget(env.DB, "computer_sync_bytes", textBytes(nextContent), {
      missionId,
      operation: "note-append",
      path,
    });
    await applyComputerFiles(workspace, [{ path, content: nextContent }]);
  });
  return { path, appendedAt };
}

export async function exportMissionComputer(env: Env, missionId: string): Promise<Record<string, string>> {
  const summary = await getMissionComputerSummary(env, missionId);
  const textFiles = summary.files.filter((file) => !file.directory && /\.(?:md|json|ndjson|txt|csv)$/i.test(file.path)).slice(0, 300);
  const output: Record<string, string> = {};
  for (const file of textFiles) {
    try {
      output[file.path] = (await readMissionComputerFile(env, missionId, file.path)).content;
    } catch {
      // A single oversized or transient file should not prevent the rest of the workspace export.
    }
  }
  return output;
}


export async function importMissionComputerFiles(
  env: Env,
  missionId: string,
  input: { files: Record<string, string>; source?: string },
): Promise<{ written: string[]; pushedAt: string }> {
  const mission = await getMission(env.DB, missionId);
  if (!mission) throw new Error(`Mission not found: ${missionId}`);
  const entries = Object.entries(input.files ?? {}).slice(0, 120);
  if (!entries.length) throw new Error("No Mission Computer files were provided");
  let submittedBytes = 0;
  const preparedByPath = new Map<string, { path: string; content: string }>();
  for (const [rawPath, rawContent] of entries) {
    const path = localWritablePath(rawPath);
    const content = String(rawContent ?? "");
    const bytes = textBytes(content);
    if (bytes > MAX_FILE_BYTES) throw new Error(`Mission Computer file is too large: ${path}`);
    submittedBytes += bytes;
    if (submittedBytes > 4_000_000) throw new Error("Mission Computer push exceeds 4 MB");
    preparedByPath.set(path, { path, content });
  }
  const prepared = [...preparedByPath.values()];
  const totalBytes = computerWriteBytes(prepared);
  const pushedAt = isoNow();
  const metadata = jsonText({
    missionId,
    pushedAt,
    source: String(input.source || "companion").slice(0, 200),
    files: prepared.map((entry) => entry.path),
    totalBytes,
  });
  const writes = [...prepared, { path: "/system/last-local-push.json", content: metadata }];
  await requireBudget(env.DB, "computer_sync_bytes", computerWriteBytes(writes), {
    missionId,
    operation: "workspace-import",
    source: String(input.source || "companion").slice(0, 200),
    fileCount: prepared.length,
  });
  await withComputer(env, missionId, async (workspace) => {
    await applyComputerFiles(workspace, writes);
  });
  return { written: prepared.map((entry) => entry.path), pushedAt };
}
