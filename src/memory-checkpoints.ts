import {
  getIntelligencePack,
  getMission,
  getStory,
  insertMemoryCheckpoint,
  latestMemoryCheckpoint,
  listMemoryEdges,
  listMemoryNodes,
} from "./db";
import { memoryGraphBounds } from "./epistemic-memory";
import { diffMemorySnapshots, type MemoryCheckpointDiff, type MemoryCheckpointSnapshot, type MemoryCheckpointScope } from "./memory-checkpoint-diff";
export { diffMemorySnapshots } from "./memory-checkpoint-diff";
export type { MemoryCheckpointDiff, MemoryCheckpointSnapshot, MemoryCheckpointScope } from "./memory-checkpoint-diff";
import { memoryNeighborhood } from "./memory-graph";
import { getEvidenceObject, putEvidenceObject } from "./r2-budget";
import { sha256 } from "./security";
import type {
  Env,
  MemoryCheckpointRecord,
  MemoryEdgeRecord,
  MemoryNodeRecord,
} from "./types";
import { isoNow, parseJson, stableStringify } from "./utils";

function snapshotNode(node: MemoryNodeRecord): MemoryCheckpointSnapshot["nodes"][number] {
  return {
    id: node.id,
    type: node.node_type,
    key: node.canonical_key,
    label: node.label,
    summary: node.summary,
    aliases: parseJson<string[]>(node.aliases_json, []),
    metadata: parseJson<Record<string, unknown>>(node.metadata_json, {}),
    importance: Number(node.importance),
    confidence: Number(node.confidence),
    occurredAt: node.occurred_at,
    status: node.status,
    supersededBy: node.superseded_by,
    sourceRef: node.source_ref,
    validFrom: node.valid_from,
    validTo: node.valid_to,
  };
}

function snapshotEdge(edge: MemoryEdgeRecord): MemoryCheckpointSnapshot["edges"][number] {
  return {
    id: edge.id,
    from: edge.from_node_id,
    to: edge.to_node_id,
    relation: edge.relation,
    weight: Number(edge.weight),
    confidence: Number(edge.confidence),
    evidence: parseJson<string[]>(edge.evidence_json, []),
    rationale: edge.rationale,
    status: edge.status,
  };
}

function contentForHash(snapshot: MemoryCheckpointSnapshot): Omit<MemoryCheckpointSnapshot, "capturedAt"> {
  const { capturedAt: _capturedAt, ...content } = snapshot;
  return content;
}

async function checkpointTitle(env: Env, scopeKind: MemoryCheckpointScope, scopeId?: string | null): Promise<string> {
  if (scopeKind === "mission" && scopeId) return (await getMission(env.DB, scopeId))?.name ?? `Mission ${scopeId}`;
  if (scopeKind === "story" && scopeId) return (await getStory(env.DB, scopeId))?.story.title ?? `Story ${scopeId}`;
  if (scopeKind === "pack" && scopeId) return (await getIntelligencePack(env.DB, scopeId))?.name ?? `Pack ${scopeId}`;
  return "Personal Intelligence Memory";
}

function scopeRef(scopeKind: MemoryCheckpointScope, scopeId?: string | null): string | null {
  if (scopeKind === "global") return null;
  if (!scopeId) throw new Error(`${scopeKind} checkpoints require scopeId`);
  return `${scopeKind}:${scopeId}`;
}

async function snapshotRows(
  env: Env,
  scopeKind: MemoryCheckpointScope,
  scopeId?: string | null,
): Promise<{ nodes: MemoryNodeRecord[]; edges: MemoryEdgeRecord[] }> {
  const profile = (await import("./budget")).getBudgetProfile;
  const budget = await profile(env.DB);
  const bounds = memoryGraphBounds(budget.profile);
  if (scopeKind === "global") {
    const nodes = await listMemoryNodes(env.DB, { limit: Math.min(bounds.maxNodes, 500) });
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = (await listMemoryEdges(env.DB, Math.min(bounds.maxEdges, 2_000)))
      .filter((edge) => nodeIds.has(edge.from_node_id) && nodeIds.has(edge.to_node_id));
    return { nodes, edges };
  }
  const neighborhood = await memoryNeighborhood(env, {
    ref: scopeRef(scopeKind, scopeId) ?? undefined,
    limit: Math.min(Math.max(40, Math.floor(bounds.maxNodes / 3)), 120),
  });
  return { nodes: neighborhood.nodes, edges: neighborhood.edges };
}

export async function buildMemoryCheckpointSnapshot(
  env: Env,
  input: { scopeKind: MemoryCheckpointScope; scopeId?: string | null; title?: string },
): Promise<MemoryCheckpointSnapshot> {
  const title = input.title?.trim() || await checkpointTitle(env, input.scopeKind, input.scopeId);
  const rows = await snapshotRows(env, input.scopeKind, input.scopeId);
  const nodes = rows.nodes.map(snapshotNode).sort((left, right) => left.id.localeCompare(right.id));
  const edges = rows.edges.map(snapshotEdge).sort((left, right) => left.id.localeCompare(right.id));
  const byType: Record<string, number> = {};
  const byRelation: Record<string, number> = {};
  for (const node of nodes) byType[node.type] = (byType[node.type] ?? 0) + 1;
  for (const edge of edges) byRelation[edge.relation] = (byRelation[edge.relation] ?? 0) + 1;
  return {
    schemaVersion: "1",
    scope: { kind: input.scopeKind, id: input.scopeId ?? null, ref: scopeRef(input.scopeKind, input.scopeId), title },
    capturedAt: isoNow(),
    nodes,
    edges,
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      activeNodes: nodes.filter((node) => node.status === "active").length,
      activeEdges: edges.filter((edge) => edge.status === "active").length,
      byType,
      byRelation,
    },
  };
}

export async function readMemoryCheckpointSnapshot(
  env: Env,
  checkpoint: MemoryCheckpointRecord,
): Promise<MemoryCheckpointSnapshot | null> {
  const object = await getEvidenceObject(env, checkpoint.snapshot_r2_key);
  if (!object) return null;
  return object.json<MemoryCheckpointSnapshot>();
}

export async function createMemoryCheckpoint(
  env: Env,
  input: {
    scopeKind: MemoryCheckpointScope;
    scopeId?: string | null;
    title?: string;
    reason?: string;
    force?: boolean;
  },
): Promise<{
  created: boolean;
  checkpoint: MemoryCheckpointRecord;
  snapshot: MemoryCheckpointSnapshot;
  diff: MemoryCheckpointDiff;
}> {
  const snapshot = await buildMemoryCheckpointSnapshot(env, input);
  const hash = await sha256(stableStringify(contentForHash(snapshot)));
  const previous = await latestMemoryCheckpoint(env.DB, input.scopeKind, input.scopeId);
  const previousSnapshot = previous ? await readMemoryCheckpointSnapshot(env, previous) : null;
  const diff = diffMemorySnapshots(previousSnapshot, snapshot, previous?.id ?? null);
  if (previous && previous.snapshot_hash === hash && !input.force) {
    return { created: false, checkpoint: previous, snapshot, diff: { ...diff, unchanged: true } };
  }
  const id = crypto.randomUUID();
  const date = snapshot.capturedAt.slice(0, 10).replaceAll("-", "/");
  const key = `memory-checkpoints/${date}/${id}.json`;
  await putEvidenceObject(env, key, `${JSON.stringify(snapshot, null, 2)}\n`, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      scopeKind: input.scopeKind,
      scopeId: input.scopeId ?? "",
      snapshotHash: hash,
    },
  });
  await insertMemoryCheckpoint(env.DB, {
    id,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    title: snapshot.scope.title,
    reason: input.reason ?? "Memory checkpoint",
    snapshotR2Key: key,
    snapshotHash: hash,
    summary: snapshot.summary,
    diff: diff as unknown as Record<string, unknown>,
  });
  const checkpoint = await latestMemoryCheckpoint(env.DB, input.scopeKind, input.scopeId);
  if (!checkpoint) throw new Error("Memory checkpoint was stored but could not be loaded");
  return { created: true, checkpoint, snapshot, diff };
}
