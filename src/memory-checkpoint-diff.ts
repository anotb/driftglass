import { stableStringify } from "./utils";

export type MemoryCheckpointScope = "global" | "mission" | "story" | "pack";

export interface MemoryCheckpointSnapshot {
  schemaVersion: "1";
  scope: { kind: MemoryCheckpointScope; id: string | null; ref: string | null; title: string };
  capturedAt: string;
  nodes: Array<{
    id: string;
    type: string;
    key: string;
    label: string;
    summary: string;
    aliases: string[];
    metadata: Record<string, unknown>;
    importance: number;
    confidence: number;
    occurredAt: string | null;
    status: string;
    supersededBy: string | null;
    sourceRef: string | null;
    validFrom: string | null;
    validTo: string | null;
  }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    relation: string;
    weight: number;
    confidence: number;
    evidence: string[];
    rationale: string;
    status: string;
  }>;
  summary: {
    nodes: number;
    edges: number;
    activeNodes: number;
    activeEdges: number;
    byType: Record<string, number>;
    byRelation: Record<string, number>;
  };
}

export interface MemoryCheckpointDiff {
  unchanged: boolean;
  previousCheckpointId: string | null;
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: string[];
  addedEdges: string[];
  removedEdges: string[];
  changedEdges: string[];
  counts: {
    addedNodes: number;
    removedNodes: number;
    changedNodes: number;
    addedEdges: number;
    removedEdges: number;
    changedEdges: number;
  };
}

function changedIds<T extends { id: string }>(before: T[], after: T[]): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const previous = new Map(before.map((item) => [item.id, stableStringify(item)]));
  const current = new Map(after.map((item) => [item.id, stableStringify(item)]));
  const added = [...current.keys()].filter((id) => !previous.has(id)).sort();
  const removed = [...previous.keys()].filter((id) => !current.has(id)).sort();
  const changed = [...current.keys()]
    .filter((id) => previous.has(id) && previous.get(id) !== current.get(id))
    .sort();
  return { added, removed, changed };
}

export function diffMemorySnapshots(
  previous: MemoryCheckpointSnapshot | null,
  current: MemoryCheckpointSnapshot,
  previousCheckpointId: string | null = null,
): MemoryCheckpointDiff {
  if (!previous) {
    return {
      unchanged: false,
      previousCheckpointId,
      addedNodes: current.nodes.map((node) => node.id),
      removedNodes: [],
      changedNodes: [],
      addedEdges: current.edges.map((edge) => edge.id),
      removedEdges: [],
      changedEdges: [],
      counts: {
        addedNodes: current.nodes.length,
        removedNodes: 0,
        changedNodes: 0,
        addedEdges: current.edges.length,
        removedEdges: 0,
        changedEdges: 0,
      },
    };
  }
  const nodes = changedIds(previous.nodes, current.nodes);
  const edges = changedIds(previous.edges, current.edges);
  const counts = {
    addedNodes: nodes.added.length,
    removedNodes: nodes.removed.length,
    changedNodes: nodes.changed.length,
    addedEdges: edges.added.length,
    removedEdges: edges.removed.length,
    changedEdges: edges.changed.length,
  };
  return {
    unchanged: Object.values(counts).every((value) => value === 0),
    previousCheckpointId,
    addedNodes: nodes.added,
    removedNodes: nodes.removed,
    changedNodes: nodes.changed,
    addedEdges: edges.added,
    removedEdges: edges.removed,
    changedEdges: edges.changed,
    counts,
  };
}
