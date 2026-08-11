import {
  listIntelligencePacks,
  listMemoryGraphRuns,
  listMemoryProposals,
  listReasoningPlaybooks,
} from "./db";
import { budgetStatus } from "./budget";
import { memoryGraphHealth, memoryNeighborhood, memoryTimeline } from "./memory-graph";
import type { Env } from "./types";
import { parseJson, readBoundedResponseJson } from "./utils";

export async function loadIntelligencePackCatalog(request: Request, env: Env): Promise<Array<Record<string, unknown>>> {
  try {
    const response = await env.ASSETS.fetch(new Request(new URL("/intelligence-packs/catalog.json", request.url)));
    if (!response.ok) return [];
    const payload = await readBoundedResponseJson<{ packs?: Array<Record<string, unknown>> }>(
      response,
      1_000_000,
      "Intelligence Pack catalog exceeds 1 MB",
    );
    return Array.isArray(payload.packs) ? payload.packs : [];
  } catch {
    return [];
  }
}

export async function intelligenceOverview(env: Env, request?: Request): Promise<Record<string, unknown>> {
  const [graph, neighborhood, timeline, proposals, installed, budget, playbooks, runs, catalog] = await Promise.all([
    memoryGraphHealth(env),
    memoryNeighborhood(env, { limit: 50, contextFirst: true }),
    memoryTimeline(env, { limit: 40 }),
    listMemoryProposals(env.DB, { status: "pending", limit: 30 }),
    listIntelligencePacks(env.DB),
    budgetStatus(env.DB),
    listReasoningPlaybooks(env.DB, { enabled: true, limit: 50 }),
    listMemoryGraphRuns(env.DB, 8),
    request ? loadIntelligencePackCatalog(request, env) : Promise.resolve([]),
  ]);
  return {
    graph,
    nodes: neighborhood.nodes.map((node) => ({
      ...node,
      aliases: parseJson(node.aliases_json, []),
      metadata: parseJson(node.metadata_json, {}),
    })),
    edges: neighborhood.edges.map((edge) => ({
      ...edge,
      evidence: parseJson(edge.evidence_json, []),
      metadata: parseJson(edge.metadata_json, {}),
    })),
    timeline,
    proposals: proposals.map((proposal) => ({
      ...proposal,
      patch: parseJson(proposal.patch_json, {}),
    })),
    packs: installed.map((pack) => ({
      ...pack,
      manifest: parseJson(pack.manifest_json, {}),
    })),
    catalog,
    budget,
    playbooks,
    runs,
  };
}
