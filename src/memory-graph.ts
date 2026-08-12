import {
  createMemoryProposal,
  decideMemoryProposal,
  getIntelligencePack,
  getMemoryNode,
  getMemoryNodeByKey,
  getMemoryProposal,
  getMission,
  getSetting,
  getSource,
  getStory,
  listMemoryEdges,
  listMemoryEdgesForNodes,
  listMemoryNodesByIds,
  listMemoryNodes,
  listMemoryGraphRuns,
  listMemoryProposals,
  memoryGraphStats,
  updateMemoryNodeStatus,
  upsertMemoryEdge,
  upsertMemoryNode,
} from "./db";
import type {
  Env,
  MemoryEdgeRecord,
  MemoryNodeRecord,
  MemoryNodeType,
  MemoryPatch,
  MemoryPatchEdge,
  MemoryPatchNode,
  MemoryProposalRecord,
  MemoryRelation,
  MissionMode,
} from "./types";
import type { StructuredResearchResult } from "./research-results";
import { getBudgetProfile, requireBudget } from "./budget";
import { clamp, isoNow, normalizeStringArray, parseJson } from "./utils";

const NODE_TYPES = new Set<MemoryNodeType>([
  "story", "mission", "source", "entity", "claim", "finding", "decision", "question", "expectation", "event", "preference", "pack",
]);
const RELATIONS = new Set<MemoryRelation>([
  "observed_in", "relevant_to", "mentions", "tracks", "asks", "updates", "resolves", "contradicts",
  "supports", "related_to", "defined_by", "contains", "supersedes", "depends_on", "caused_by", "answers", "prefers",
  "about", "expects", "evidence_for", "evidence_against", "derived_from",
]);
const SCOPE_KINDS = new Set<MemoryProposalRecord["scope_kind"]>(["global", "mission", "story", "pack"]);

interface GraphLimits {
  maxNodes: number;
  maxEdges: number;
  maxPendingProposals: number;
  maxNeighborhoodNodes: number;
}

const DEFAULT_LIMITS: GraphLimits = {
  maxNodes: 500,
  maxEdges: 2_000,
  maxPendingProposals: 50,
  maxNeighborhoodNodes: 80,
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || crypto.randomUUID();
}

function canonicalKey(type: MemoryNodeType, value: string): string {
  return `${type}:${slug(value)}`;
}

function memoryRef(id: string): string {
  return id.startsWith("memory:") ? id : `memory:${id}`;
}

function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid date: ${String(value)}`);
  return new Date(timestamp).toISOString();
}

function normalizePatchNode(value: unknown, index: number): MemoryPatchNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`nodes[${index}] must be an object`);
  const input = value as Record<string, unknown>;
  const key = String(input.key ?? "").trim().slice(0, 100);
  const type = String(input.type ?? "") as MemoryNodeType;
  const label = String(input.label ?? "").trim().slice(0, 500);
  if (!key) throw new Error(`nodes[${index}].key is required`);
  if (!NODE_TYPES.has(type)) throw new Error(`nodes[${index}].type is unsupported`);
  if (!label) throw new Error(`nodes[${index}].label is required`);
  return {
    key,
    type,
    label,
    summary: String(input.summary ?? "").trim().slice(0, 12_000),
    aliases: normalizeStringArray(input.aliases).slice(0, 50),
    importance: clamp(Number(input.importance ?? 0.6)),
    confidence: clamp(Number(input.confidence ?? 0.7)),
    occurredAt: normalizeDate(input.occurredAt ?? input.occurred_at),
    sourceRef: String(input.sourceRef ?? input.source_ref ?? "").trim().slice(0, 300) || null,
    validFrom: normalizeDate(input.validFrom ?? input.valid_from),
    validTo: normalizeDate(input.validTo ?? input.valid_to),
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata as Record<string, unknown>
      : {},
  };
}

function normalizePatchEdge(value: unknown, index: number): MemoryPatchEdge {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`edges[${index}] must be an object`);
  const input = value as Record<string, unknown>;
  const from = String(input.from ?? "").trim().slice(0, 200);
  const to = String(input.to ?? "").trim().slice(0, 200);
  const relation = String(input.relation ?? "") as MemoryRelation;
  if (!from || !to) throw new Error(`edges[${index}] requires from and to`);
  if (!RELATIONS.has(relation)) throw new Error(`edges[${index}].relation is unsupported`);
  return {
    from,
    to,
    relation,
    weight: clamp(Number(input.weight ?? 0.7)),
    confidence: clamp(Number(input.confidence ?? 0.7)),
    rationale: String(input.rationale ?? "").trim().slice(0, 2_000),
    evidence: normalizeStringArray(input.evidence).slice(0, 50),
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata as Record<string, unknown>
      : {},
  };
}

export function normalizeMemoryPatch(value: unknown): MemoryPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Memory patch must be an object");
  const input = value as Record<string, unknown>;
  if (String(input.schemaVersion ?? input.schema_version ?? "1") !== "1") throw new Error("Unsupported memory patch version");
  const nodes = (Array.isArray(input.nodes) ? input.nodes : []).slice(0, 80).map(normalizePatchNode);
  const edges = (Array.isArray(input.edges) ? input.edges : []).slice(0, 240).map(normalizePatchEdge);
  if (!nodes.length && !edges.length) throw new Error("Memory patch must include nodes or edges");
  const nodeKeys = new Set(nodes.map((node) => node.key));
  if (nodeKeys.size !== nodes.length) throw new Error("Memory patch node keys must be unique");
  const supersede = (Array.isArray(input.supersede) ? input.supersede : []).slice(0, 80).map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`supersede[${index}] must be an object`);
    const record = entry as Record<string, unknown>;
    const node = String(record.node ?? "").trim();
    if (!node) throw new Error(`supersede[${index}].node is required`);
    return {
      node,
      by: String(record.by ?? "").trim() || undefined,
      reason: String(record.reason ?? "").trim().slice(0, 1_000) || undefined,
    };
  });
  return {
    schemaVersion: "1",
    title: String(input.title ?? "Memory update").trim().slice(0, 300) || "Memory update",
    nodes,
    edges,
    supersede,
  };
}

async function graphLimits(env: Env): Promise<GraphLimits> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'memory_graph_limits'").first<{ value: string }>();
  const configured = parseJson<Partial<GraphLimits>>(row?.value ?? "{}", {});
  return {
    maxNodes: Math.max(100, Math.min(10_000, Number(configured.maxNodes ?? DEFAULT_LIMITS.maxNodes))),
    maxEdges: Math.max(300, Math.min(50_000, Number(configured.maxEdges ?? DEFAULT_LIMITS.maxEdges))),
    maxPendingProposals: Math.max(5, Math.min(500, Number(configured.maxPendingProposals ?? DEFAULT_LIMITS.maxPendingProposals))),
    maxNeighborhoodNodes: Math.max(10, Math.min(300, Number(configured.maxNeighborhoodNodes ?? DEFAULT_LIMITS.maxNeighborhoodNodes))),
  };
}

async function ensureReferenceNode(env: Env, ref: string): Promise<MemoryNodeRecord> {
  const normalized = ref.trim();
  if (!normalized) throw new Error("Empty memory reference");
  if (normalized.startsWith("memory:")) {
    const node = await getMemoryNode(env.DB, normalized.slice(7));
    if (!node) throw new Error(`Memory node not found: ${normalized}`);
    return node;
  }
  const [kind, ...parts] = normalized.split(":");
  const id = parts.join(":");
  if (!id) {
    const direct = await getMemoryNode(env.DB, normalized);
    if (!direct) throw new Error(`Memory node not found: ${normalized}`);
    return direct;
  }
  if (kind === "story") {
    const detail = await getStory(env.DB, id);
    if (!detail) throw new Error(`Story not found: ${id}`);
    await upsertMemoryNode(env.DB, {
      id: `mem-story-${id}`,
      nodeType: "story",
      canonicalKey: canonicalKey("story", id),
      label: detail.story.title,
      summary: detail.story.summary,
      importance: clamp(detail.story.importance),
      confidence: clamp(detail.story.confidence),
      occurredAt: detail.story.last_changed_at,
      sourceRef: normalized,
      metadata: { storyId: id, score: detail.story.score, sourceCount: detail.story.source_count },
    });
    return (await getMemoryNodeByKey(env.DB, "story", canonicalKey("story", id)))!;
  }
  if (kind === "mission") {
    const mission = await getMission(env.DB, id);
    if (!mission) throw new Error(`Mission not found: ${id}`);
    await upsertMemoryNode(env.DB, {
      id: `mem-mission-${id}`,
      nodeType: "mission",
      canonicalKey: canonicalKey("mission", id),
      label: mission.name,
      summary: mission.question,
      importance: clamp(mission.priority / 5),
      confidence: 1,
      sourceRef: normalized,
      metadata: { missionId: id, status: mission.status },
    });
    return (await getMemoryNodeByKey(env.DB, "mission", canonicalKey("mission", id)))!;
  }
  if (kind === "source") {
    const source = await getSource(env.DB, id);
    if (!source) throw new Error(`Source not found: ${id}`);
    await upsertMemoryNode(env.DB, {
      id: `mem-source-${id}`,
      nodeType: "source",
      canonicalKey: canonicalKey("source", id),
      label: source.name,
      summary: `${source.kind} source`,
      importance: clamp(source.weight / 3),
      confidence: clamp(source.health_score),
      sourceRef: normalized,
      metadata: { sourceId: id, kind: source.kind, enabled: source.enabled === 1 },
    });
    return (await getMemoryNodeByKey(env.DB, "source", canonicalKey("source", id)))!;
  }
  if (kind === "pack") {
    const pack = await getIntelligencePack(env.DB, id);
    if (!pack) throw new Error(`Intelligence Pack not found: ${id}`);
    await upsertMemoryNode(env.DB, {
      id: `mem-pack-${id}`,
      nodeType: "pack",
      canonicalKey: canonicalKey("pack", id),
      label: pack.name,
      summary: pack.description,
      importance: 0.65,
      confidence: 1,
      sourceRef: normalized,
      metadata: { packId: id, version: pack.version, category: pack.category },
    });
    return (await getMemoryNodeByKey(env.DB, "pack", canonicalKey("pack", id)))!;
  }
  throw new Error(`Unsupported memory reference: ${ref}`);
}

/** Resolve an existing graph reference without materializing canonical state. */
async function lookupReferenceNode(env: Env, ref: string): Promise<MemoryNodeRecord | null> {
  const normalized = ref.trim();
  if (!normalized) return null;
  if (normalized.startsWith("memory:")) return getMemoryNode(env.DB, normalized.slice(7));
  const [kind, ...parts] = normalized.split(":");
  const id = parts.join(":");
  if (!id) return getMemoryNode(env.DB, normalized);
  if (kind === "story" || kind === "mission" || kind === "source" || kind === "pack") {
    return getMemoryNodeByKey(env.DB, kind, canonicalKey(kind, id));
  }
  throw new Error(`Unsupported memory reference: ${ref}`);
}

async function resolvePatchRef(env: Env, ref: string, local: Map<string, MemoryNodeRecord>): Promise<MemoryNodeRecord> {
  if (local.has(ref)) return local.get(ref)!;
  return ensureReferenceNode(env, ref);
}

export async function stageMemoryProposal(
  env: Env,
  input: { scopeKind?: string; scopeId?: string | null; provider?: string; patch: unknown },
): Promise<{ proposal: MemoryProposalRecord; patch: MemoryPatch }> {
  const scopeKind = (input.scopeKind ?? "global") as MemoryProposalRecord["scope_kind"];
  if (!SCOPE_KINDS.has(scopeKind)) throw new Error("Unsupported memory proposal scope");
  const limits = await graphLimits(env);
  const pending = await listMemoryProposals(env.DB, { status: "pending", limit: limits.maxPendingProposals + 1 });
  if (pending.length >= limits.maxPendingProposals) throw new Error("Too many pending memory proposals; review existing proposals first");
  const patch = normalizeMemoryPatch(input.patch);
  const id = `mp-${crypto.randomUUID()}`;
  await createMemoryProposal(env.DB, {
    id,
    scopeKind,
    scopeId: input.scopeId ?? null,
    provider: String(input.provider ?? "manual").slice(0, 100),
    title: patch.title,
    patch: patch as unknown as Record<string, unknown>,
  });
  const proposal = await getMemoryProposal(env.DB, id);
  if (!proposal) throw new Error("Memory proposal could not be staged");
  return { proposal, patch };
}

export async function approveMemoryProposal(
  env: Env,
  proposalId: string,
  note?: string,
): Promise<{ nodes: number; edges: number; superseded: number }> {
  const proposal = await getMemoryProposal(env.DB, proposalId);
  if (!proposal) throw new Error(`Memory proposal not found: ${proposalId}`);
  if (proposal.status !== "pending") throw new Error(`Memory proposal is ${proposal.status}`);
  const patch = normalizeMemoryPatch(parseJson(proposal.patch_json, {}));
  const limits = await graphLimits(env);
  const stats = await memoryGraphStats(env.DB);
  const existing = await Promise.all(patch.nodes.map((node) => getMemoryNodeByKey(env.DB, node.type, canonicalKey(node.type, node.key))));
  const newNodeCount = existing.filter((node) => !node).length;
  if (Number(stats.nodes ?? 0) + newNodeCount > limits.maxNodes) throw new Error("Memory graph node budget would be exceeded");
  if (Number(stats.edges ?? 0) + patch.edges.length + (patch.supersede?.length ?? 0) > limits.maxEdges) throw new Error("Memory graph edge budget would be exceeded");
  await requireBudget(env.DB, "memory_writes", Math.max(1, patch.nodes.length + patch.edges.length + (patch.supersede?.length ?? 0) * 2), {
    operation: "approve-memory-proposal",
    proposalId,
    provider: proposal.provider,
  });

  const local = new Map<string, MemoryNodeRecord>();
  for (const node of patch.nodes) {
    const key = canonicalKey(node.type, node.key);
    const id = `mem-${node.type}-${slug(node.key)}-${crypto.randomUUID().slice(0, 8)}`;
    await upsertMemoryNode(env.DB, {
      id,
      nodeType: node.type,
      canonicalKey: key,
      label: node.label,
      summary: node.summary,
      aliases: node.aliases,
      importance: node.importance,
      confidence: node.confidence,
      occurredAt: node.occurredAt,
      sourceRef: node.sourceRef ?? `${proposal.scope_kind}:${proposal.scope_id ?? "global"}`,
      validFrom: node.validFrom,
      validTo: node.validTo,
      metadata: { ...(node.metadata ?? {}), proposalId, provider: proposal.provider },
    });
    const saved = await getMemoryNodeByKey(env.DB, node.type, key);
    if (!saved) throw new Error(`Memory node could not be saved: ${node.key}`);
    local.set(node.key, saved);
    local.set(memoryRef(saved.id), saved);
  }

  for (const edge of patch.edges) {
    const [from, to] = await Promise.all([
      resolvePatchRef(env, edge.from, local),
      resolvePatchRef(env, edge.to, local),
    ]);
    await upsertMemoryEdge(env.DB, {
      id: `me-${crypto.randomUUID()}`,
      fromNodeId: from.id,
      toNodeId: to.id,
      relation: edge.relation,
      weight: edge.weight,
      confidence: edge.confidence,
      rationale: edge.rationale,
      evidence: edge.evidence,
      metadata: { ...(edge.metadata ?? {}), proposalId, provider: proposal.provider },
    });
  }

  let superseded = 0;
  for (const entry of patch.supersede ?? []) {
    const oldNode = await resolvePatchRef(env, entry.node, local);
    const replacement = entry.by ? await resolvePatchRef(env, entry.by, local) : null;
    await updateMemoryNodeStatus(env.DB, oldNode.id, "superseded", replacement?.id ?? null);
    if (replacement) {
      await upsertMemoryEdge(env.DB, {
        id: `me-${crypto.randomUUID()}`,
        fromNodeId: replacement.id,
        toNodeId: oldNode.id,
        relation: "supersedes",
        weight: 1,
        confidence: 1,
        rationale: entry.reason ?? "Superseded by an approved memory update",
        evidence: [proposalId],
      });
    }
    superseded += 1;
  }
  await decideMemoryProposal(env.DB, proposalId, "approved", note);
  return { nodes: patch.nodes.length, edges: patch.edges.length, superseded };
}

export async function rejectMemoryProposal(env: Env, proposalId: string, note?: string): Promise<void> {
  const proposal = await getMemoryProposal(env.DB, proposalId);
  if (!proposal) throw new Error(`Memory proposal not found: ${proposalId}`);
  if (proposal.status !== "pending") return;
  await decideMemoryProposal(env.DB, proposalId, "rejected", note);
}

const MAX_MEMORY_LOGICAL_SEEDS = 40;
const MAX_MEMORY_SEED_CANDIDATES = 80;
const MAX_MEMORY_SOURCE_CANDIDATES = 24;
const MAX_RESERVED_SOURCE_KINDS = 4;
const DIRECT_PROVENANCE_RELATIONS = new Set<MemoryRelation>([
  "observed_in",
  "evidence_for",
  "evidence_against",
  "supports",
  "contradicts",
]);
const LINEAGE_PROVENANCE_RELATIONS = new Set<MemoryRelation>(["observed_in", "evidence_for"]);
const LINEAGE_METADATA_KEYS = [
  "familyKey",
  "originFamilyKey",
  "lineageRelation",
  "lineageIndependent",
  "sourceKind",
] as const;

function logicalMemorySeedLimit(nodeLimit: number): number {
  return Math.max(1, Math.min(MAX_MEMORY_LOGICAL_SEEDS, Math.ceil(nodeLimit / 2)));
}

function memoryMirrorKey(node: MemoryNodeRecord): string {
  if ((node.node_type === "story" || node.node_type === "claim") && node.source_ref?.startsWith("story:")) {
    return node.source_ref;
  }
  return `node:${node.id}`;
}

/** A generated Claim and its Story are one logical seed, with the Claim as the assertion-facing representative. */
function collapseMemoryMirrors(candidates: MemoryNodeRecord[]): MemoryNodeRecord[] {
  const order: string[] = [];
  const selected = new Map<string, MemoryNodeRecord>();
  for (const candidate of candidates) {
    const key = memoryMirrorKey(candidate);
    const current = selected.get(key);
    if (!current) {
      order.push(key);
      selected.set(key, candidate);
      continue;
    }
    if (current.node_type === "story" && candidate.node_type === "claim") selected.set(key, candidate);
  }
  return order.flatMap((key) => {
    const node = selected.get(key);
    return node ? [node] : [];
  });
}

function memorySourceKind(node: MemoryNodeRecord): string {
  if (node.node_type !== "source") return "";
  const metadata = parseJson<Record<string, unknown>>(node.metadata_json, {});
  return typeof metadata.kind === "string" ? metadata.kind.trim().toLowerCase() : "";
}

function reservedSourceSeedLimit(seedLimit: number): number {
  return seedLimit < 6 ? 0 : Math.min(MAX_RESERVED_SOURCE_KINDS, Math.max(1, Math.floor(seedLimit / 3)));
}

function distinctSourceKindSeeds(candidates: MemoryNodeRecord[], limit: number): MemoryNodeRecord[] {
  const selected: MemoryNodeRecord[] = [];
  const kinds = new Set<string>();
  for (const candidate of candidates) {
    const kind = memorySourceKind(candidate);
    if (!kind || kinds.has(kind)) continue;
    selected.push(candidate);
    kinds.add(kind);
    if (selected.length >= limit) break;
  }
  return selected;
}

function selectUnscopedMemorySeeds(
  generalCandidates: MemoryNodeRecord[],
  sourceCandidates: MemoryNodeRecord[],
  seedLimit: number,
): MemoryNodeRecord[] {
  const sourceSeeds = distinctSourceKindSeeds(sourceCandidates, reservedSourceSeedLimit(seedLimit));
  const generalSeeds = collapseMemoryMirrors(generalCandidates.filter((node) => node.node_type !== "source"));
  const selected: MemoryNodeRecord[] = [];
  const selectedIds = new Set<string>();
  const selectedMirrors = new Set<string>();
  const append = (node: MemoryNodeRecord) => {
    const mirror = memoryMirrorKey(node);
    if (selectedIds.has(node.id) || selectedMirrors.has(mirror) || selected.length >= seedLimit) return;
    selected.push(node);
    selectedIds.add(node.id);
    selectedMirrors.add(mirror);
  };

  for (const node of generalSeeds.slice(0, Math.max(0, seedLimit - sourceSeeds.length))) append(node);
  for (const node of sourceSeeds) append(node);
  for (const node of collapseMemoryMirrors([...generalCandidates, ...sourceCandidates])) append(node);
  return selected;
}

function addMemoryEdgeEndpoints(ids: Set<string>, edge: MemoryEdgeRecord, limit: number): boolean {
  const additions = [edge.from_node_id, edge.to_node_id].filter((id) => !ids.has(id));
  if (!additions.length || ids.size + additions.length > limit) return false;
  for (const id of additions) ids.add(id);
  return true;
}

function expandMemorySeedsFairly(
  seeds: MemoryNodeRecord[],
  edges: MemoryEdgeRecord[],
  limit: number,
): Set<string> {
  const ids = new Set(seeds.map((node) => node.id));
  const bySeed = new Map(seeds.map((seed) => [seed.id, [] as MemoryEdgeRecord[]]));
  const seedByAnchor = new Map(seeds.map((seed) => [seed.id, seed.id]));
  for (const edge of edges) {
    if (edge.relation !== "derived_from") continue;
    const fromSeed = seedByAnchor.get(edge.from_node_id);
    const toSeed = seedByAnchor.get(edge.to_node_id);
    if (fromSeed && !toSeed) seedByAnchor.set(edge.to_node_id, fromSeed);
    else if (toSeed && !fromSeed) seedByAnchor.set(edge.from_node_id, toSeed);
  }
  for (const edge of edges) {
    const fromSeed = seedByAnchor.get(edge.from_node_id);
    const toSeed = seedByAnchor.get(edge.to_node_id);
    if (fromSeed) bySeed.get(fromSeed)?.push(edge);
    if (toSeed && toSeed !== fromSeed) bySeed.get(toSeed)?.push(edge);
  }

  const roundRobin = (eligible: (edge: MemoryEdgeRecord) => boolean) => {
    const cursors = new Map(seeds.map((seed) => [seed.id, 0]));
    let progressed = true;
    while (progressed && ids.size < limit) {
      progressed = false;
      for (const seed of seeds) {
        const candidates = bySeed.get(seed.id) ?? [];
        let cursor = cursors.get(seed.id) ?? 0;
        while (cursor < candidates.length) {
          const edge = candidates[cursor++]!;
          if (!eligible(edge)) continue;
          if (!addMemoryEdgeEndpoints(ids, edge, limit)) continue;
          progressed = true;
          break;
        }
        cursors.set(seed.id, cursor);
        if (ids.size >= limit) break;
      }
    }
  };

  roundRobin((edge) => DIRECT_PROVENANCE_RELATIONS.has(edge.relation));
  roundRobin(() => true);
  for (const edge of edges) {
    if (ids.size >= limit) break;
    addMemoryEdgeEndpoints(ids, edge, limit);
  }
  return ids;
}

function normalizeReturnedProvenanceEdges(
  nodes: MemoryNodeRecord[],
  edges: MemoryEdgeRecord[],
): MemoryEdgeRecord[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return edges.map((edge) => {
    if (!LINEAGE_PROVENANCE_RELATIONS.has(edge.relation)) return edge;
    const parsed = parseJson<unknown>(edge.metadata_json, {});
    const metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    if (LINEAGE_METADATA_KEYS.every((key) => Object.hasOwn(metadata, key))) return edge;

    const normalized = { ...metadata };
    if (!Object.hasOwn(metadata, "familyKey")) normalized.familyKey = null;
    if (!Object.hasOwn(metadata, "originFamilyKey")) normalized.originFamilyKey = null;
    if (!Object.hasOwn(metadata, "lineageRelation")) normalized.lineageRelation = null;
    if (!Object.hasOwn(metadata, "lineageIndependent")) normalized.lineageIndependent = null;
    if (!Object.hasOwn(metadata, "sourceKind")) {
      const sourceNode = [nodeById.get(edge.from_node_id), nodeById.get(edge.to_node_id)]
        .find((node) => node?.node_type === "source");
      const sourceMetadata = sourceNode
        ? parseJson<Record<string, unknown>>(sourceNode.metadata_json, {})
        : {};
      normalized.sourceKind = typeof sourceMetadata.kind === "string" ? sourceMetadata.kind : null;
    }
    return { ...edge, metadata_json: JSON.stringify(normalized) };
  });
}

export async function memoryNeighborhood(
  env: Env,
  input: { ref?: string; query?: string; limit?: number; contextFirst?: boolean },
): Promise<{ nodes: MemoryNodeRecord[]; edges: MemoryEdgeRecord[]; stats: Record<string, number> }> {
  const limits = await graphLimits(env);
  const limit = Math.max(1, Math.min(limits.maxNeighborhoodNodes, input.limit ?? 40));
  let seeds: MemoryNodeRecord[] = [];
  if (input.ref) {
    const seed = await lookupReferenceNode(env, input.ref);
    seeds = seed ? [seed] : [];
  }
  else {
    const seedLimit = logicalMemorySeedLimit(limit);
    const candidateLimit = Math.min(MAX_MEMORY_SEED_CANDIDATES, seedLimit * 2);
    if (input.query) {
      const candidates = await listMemoryNodes(env.DB, {
        query: input.query,
        limit: candidateLimit,
        contextFirst: input.contextFirst,
      });
      seeds = collapseMemoryMirrors(candidates).slice(0, seedLimit);
    } else {
      const sourceLimit = reservedSourceSeedLimit(seedLimit);
      const [generalCandidates, sourceCandidates] = await Promise.all([
        listMemoryNodes(env.DB, { limit: candidateLimit, contextFirst: input.contextFirst }),
        sourceLimit > 0
          ? listMemoryNodes(env.DB, { nodeType: "source", limit: MAX_MEMORY_SOURCE_CANDIDATES })
          : Promise.resolve([] as MemoryNodeRecord[]),
      ]);
      seeds = selectUnscopedMemorySeeds(generalCandidates, sourceCandidates, seedLimit);
    }
  }
  const edges = await listMemoryEdgesForNodes(
    env.DB,
    seeds.map((node) => node.id),
    limit * 5,
    { includeStoryClaimMirrors: !input.ref },
  );
  const ids = input.ref
    ? (() => {
        const selected = new Set(seeds.map((node) => node.id));
        for (const edge of edges) {
          selected.add(edge.from_node_id);
          selected.add(edge.to_node_id);
          if (selected.size >= limit) break;
        }
        return selected;
      })()
    : expandMemorySeedsFairly(seeds, edges, limit);
  const nodes = await listMemoryNodesByIds(env.DB, [...ids].slice(0, limit));
  const returnedEdges = edges.filter((edge) => ids.has(edge.from_node_id) && ids.has(edge.to_node_id));
  return { nodes, edges: normalizeReturnedProvenanceEdges(nodes, returnedEdges), stats: await memoryGraphStats(env.DB) };
}

export async function recordApprovedMissionMemory(
  env: Env,
  input: {
    missionId: string;
    missionName: string;
    missionMode: MissionMode;
    research: StructuredResearchResult;
    importId: string;
  },
): Promise<void> {
  const mission = await ensureReferenceNode(env, `mission:${input.missionId}`);
  const timestamp = isoNow();
  const thesisType: MemoryNodeType = input.missionMode === "decision" ? "decision" : "finding";
  const thesisKey = `mission-${input.missionId}-thesis-${timestamp.slice(0, 10)}-${slug(input.research.currentThesis || input.research.reportSummary).slice(0, 36)}`;
  const nodes: MemoryPatchNode[] = [{
    key: thesisKey,
    type: thesisType,
    label: `Current thesis · ${input.missionName}`,
    summary: input.research.currentThesis || input.research.reportSummary,
    confidence: input.research.confidence ?? 0.75,
    importance: 0.9,
    sourceRef: `mission:${input.missionId}`,
    validFrom: timestamp,
    metadata: { importId: input.importId, reportTitle: input.research.reportTitle, reportUrl: input.research.reportUrl },
  }];
  const edges: MemoryPatchEdge[] = [{
    from: memoryRef(mission.id),
    to: thesisKey,
    relation: input.missionMode === "decision" ? "defined_by" : "updates",
    weight: 0.95,
    confidence: input.research.confidence ?? 0.75,
    rationale: "Approved Deep Research result",
    evidence: [input.importId],
  }];
  for (const [index, question] of input.research.openQuestions.slice(0, 12).entries()) {
    const key = `mission-${input.missionId}-question-${slug(question)}-${index}`;
    nodes.push({ key, type: "question", label: question, summary: question, importance: 0.72, confidence: 1, sourceRef: `mission:${input.missionId}` });
    edges.push({ from: memoryRef(mission.id), to: key, relation: "asks", weight: 0.82, confidence: 1, rationale: "Open question retained from approved research" });
  }
  if (input.research.nextExpectedEvent) {
    const key = `mission-${input.missionId}-event-${slug(input.research.nextExpectedEvent)}`;
    nodes.push({
      key,
      type: "expectation",
      label: input.research.nextExpectedEvent,
      summary: `Expected next observable event for ${input.missionName}`,
      importance: 0.82,
      confidence: 0.8,
      occurredAt: input.research.nextExpectedBy,
      sourceRef: `mission:${input.missionId}`,
    });
    edges.push({ from: memoryRef(mission.id), to: key, relation: "expects", weight: 0.9, confidence: 0.9, rationale: "Expected event from approved research" });
  }
  const staged = await stageMemoryProposal(env, {
    scopeKind: "mission",
    scopeId: input.missionId,
    provider: "approved-deep-research",
    patch: { schemaVersion: "1", title: `Memory update · ${input.missionName}`, nodes, edges },
  });
  await approveMemoryProposal(env, staged.proposal.id, "Automatically approved because the source research result was already explicitly confirmed");
}

export function memoryPatchContract(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://driftglass.dev/schemas/memory-patch-v1.json",
    title: "Driftglass durable memory patch",
    description: "A bounded proposal for durable graph memory. It is staged for review before becoming canonical.",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "title", "nodes", "edges"],
    properties: {
      schemaVersion: { const: "1" },
      title: { type: "string", minLength: 1, maxLength: 300 },
      nodes: {
        type: "array",
        maxItems: 80,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "type", "label", "summary"],
          properties: {
            key: { type: "string", minLength: 1, maxLength: 160 },
            type: { enum: ["entity", "claim", "finding", "decision", "question", "expectation", "event", "preference"] },
            label: { type: "string", minLength: 1, maxLength: 300 },
            summary: { type: "string", minLength: 1, maxLength: 8_000 },
            aliases: { type: "array", maxItems: 40, items: { type: "string", maxLength: 180 } },
            importance: { type: "number", minimum: 0, maximum: 1 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            occurredAt: { type: ["string", "null"], maxLength: 80 },
            sourceRef: { type: ["string", "null"], maxLength: 300 },
            validFrom: { type: ["string", "null"], maxLength: 80 },
            validTo: { type: ["string", "null"], maxLength: 80 },
            metadata: { type: "object" },
          },
        },
      },
      edges: {
        type: "array",
        maxItems: 240,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["from", "to", "relation"],
          properties: {
            from: { type: "string", minLength: 1, maxLength: 300 },
            to: { type: "string", minLength: 1, maxLength: 300 },
            relation: { enum: [
              "observed_in", "relevant_to", "mentions", "tracks", "asks", "updates", "resolves", "contradicts",
              "supports", "related_to", "defined_by", "contains", "supersedes", "depends_on", "caused_by", "answers",
              "prefers", "about", "expects", "evidence_for", "evidence_against", "derived_from",
            ] },
            weight: { type: "number", minimum: 0, maximum: 1 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string", maxLength: 1_000 },
            evidence: { type: "array", maxItems: 80, items: { type: "string", maxLength: 300 } },
            metadata: { type: "object" },
          },
        },
      },
      supersede: {
        type: "array",
        maxItems: 80,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["node"],
          properties: {
            node: { type: "string", minLength: 1, maxLength: 300 },
            by: { type: "string", maxLength: 300 },
            reason: { type: "string", maxLength: 1_000 },
          },
        },
      },
    },
  };
}


export async function memoryTimeline(
  env: Env,
  input: { ref?: string; query?: string; limit?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const neighborhood = await memoryNeighborhood(env, { ref: input.ref, query: input.query, limit: input.limit ?? 60 });
  return neighborhood.nodes
    .filter((node) => node.occurred_at || node.valid_from || node.node_type === "event" || node.node_type === "expectation")
    .sort((left, right) => Date.parse(right.occurred_at ?? right.valid_from ?? right.updated_at) - Date.parse(left.occurred_at ?? left.valid_from ?? left.updated_at))
    .slice(0, Math.max(1, Math.min(100, input.limit ?? 40)))
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

export async function memoryGraphHealth(env: Env): Promise<Record<string, unknown>> {
  const [stats, runs, dirty, lastRefresh, budget] = await Promise.all([
    memoryGraphStats(env.DB),
    listMemoryGraphRuns(env.DB, 8),
    getSetting(env.DB, "memory_graph_dirty"),
    getSetting(env.DB, "memory_graph_last_refresh_at"),
    getBudgetProfile(env.DB),
  ]);
  return { stats, dirty: dirty === "1", lastRefreshAt: lastRefresh || null, limits: await graphLimits(env), budgetProfile: budget.profile, recentRuns: runs };
}


export interface MemoryGraphAudit {
  score: number;
  checkedAt: string;
  totals: { nodes: number; edges: number; activeNodes: number; activeEdges: number };
  issues: {
    unresolvedContradictions: Array<Record<string, unknown>>;
    staleExpectations: Array<Record<string, unknown>>;
    unsupportedDurableNodes: Array<Record<string, unknown>>;
    orphanNodes: Array<Record<string, unknown>>;
    incompleteSupersession: Array<Record<string, unknown>>;
  };
  recommendations: string[];
}

export async function memoryGraphAudit(env: Env): Promise<MemoryGraphAudit> {
  const limits = await graphLimits(env);
  const [nodes, edges] = await Promise.all([
    listMemoryNodes(env.DB, { limit: limits.maxNodes }),
    listMemoryEdges(env.DB, limits.maxEdges),
  ]);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const activeNodes = nodes.filter((node) => node.status === "active");
  const activeEdges = edges.filter((edge) => edge.status === "active");
  const linked = new Set<string>();
  const evidenceLinked = new Set<string>();
  const evidenceRelations = new Set<MemoryRelation>([
    "observed_in", "supports", "contradicts", "evidence_for", "evidence_against", "derived_from", "answers", "updates", "resolves",
  ]);
  for (const edge of activeEdges) {
    linked.add(edge.from_node_id);
    linked.add(edge.to_node_id);
    if (evidenceRelations.has(edge.relation) || parseJson<unknown[]>(edge.evidence_json, []).length > 0) {
      evidenceLinked.add(edge.from_node_id);
      evidenceLinked.add(edge.to_node_id);
    }
  }
  const durableNeedsEvidence = new Set<MemoryNodeType>(["claim", "finding", "decision", "expectation", "event"]);
  const unsupportedDurableNodes = activeNodes
    .filter((node) => durableNeedsEvidence.has(node.node_type) && !node.source_ref && !evidenceLinked.has(node.id))
    .sort((left, right) => right.importance - left.importance)
    .slice(0, 30)
    .map((node) => ({ id: node.id, type: node.node_type, label: node.label, importance: node.importance, confidence: node.confidence }));
  const staleExpectations = activeNodes
    .filter((node) => node.node_type === "expectation")
    .filter((node) => {
      const value = node.valid_to ?? node.occurred_at;
      return Boolean(value && Date.parse(value) < Date.now());
    })
    .sort((left, right) => Date.parse(left.valid_to ?? left.occurred_at ?? left.updated_at) - Date.parse(right.valid_to ?? right.occurred_at ?? right.updated_at))
    .slice(0, 30)
    .map((node) => ({ id: node.id, label: node.label, expectedAt: node.valid_to ?? node.occurred_at, sourceRef: node.source_ref }));
  const unresolvedContradictions = activeEdges
    .filter((edge) => edge.relation === "contradicts" || edge.relation === "evidence_against")
    .filter((edge) => nodeById.get(edge.from_node_id)?.status === "active" && nodeById.get(edge.to_node_id)?.status === "active")
    .sort((left, right) => (right.weight * right.confidence) - (left.weight * left.confidence))
    .slice(0, 30)
    .map((edge) => ({
      id: edge.id,
      relation: edge.relation,
      from: nodeById.get(edge.from_node_id)?.label ?? edge.from_node_id,
      to: nodeById.get(edge.to_node_id)?.label ?? edge.to_node_id,
      strength: edge.weight,
      confidence: edge.confidence,
      rationale: edge.rationale,
    }));
  const structuralTypes = new Set<MemoryNodeType>(["story", "mission", "source", "pack"]);
  const orphanNodes = activeNodes
    .filter((node) => !structuralTypes.has(node.node_type) && !linked.has(node.id) && !node.source_ref)
    .sort((left, right) => right.importance - left.importance)
    .slice(0, 30)
    .map((node) => ({ id: node.id, type: node.node_type, label: node.label, importance: node.importance }));
  const incompleteSupersession = nodes
    .filter((node) => node.status === "superseded" && !node.superseded_by)
    .slice(0, 30)
    .map((node) => ({ id: node.id, type: node.node_type, label: node.label }));
  const issueWeight = unresolvedContradictions.length * 1.6
    + staleExpectations.length * 1.4
    + unsupportedDurableNodes.length
    + orphanNodes.length * 0.5
    + incompleteSupersession.length;
  const denominator = Math.max(10, activeNodes.length * 0.35);
  const score = clamp(1 - issueWeight / denominator);
  const recommendations: string[] = [];
  if (unresolvedContradictions.length) recommendations.push("Use a challenge or Deep Research bundle to resolve the highest-confidence contradictions.");
  if (staleExpectations.length) recommendations.push("Review overdue expectations and record whether each was met, delayed, or invalidated.");
  if (unsupportedDurableNodes.length) recommendations.push("Attach evidence or a source reference before relying on unsupported durable findings and decisions.");
  if (orphanNodes.length) recommendations.push("Connect or retire isolated durable nodes so recall remains sparse and explainable.");
  if (incompleteSupersession.length) recommendations.push("Complete supersession links so models can distinguish current state from historical state.");
  if (!recommendations.length) recommendations.push("Memory is sparse, connected, and ready for reasoning.");
  return {
    score,
    checkedAt: isoNow(),
    totals: { nodes: nodes.length, edges: edges.length, activeNodes: activeNodes.length, activeEdges: activeEdges.length },
    issues: { unresolvedContradictions, staleExpectations, unsupportedDurableNodes, orphanNodes, incompleteSupersession },
    recommendations,
  };
}
