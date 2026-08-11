import type {
  MemoryEdgeRecord,
  MemoryNodeRecord,
  MissionEventRecord,
  MissionOperatorRecord,
  MissionRecord,
  MissionResearchStateRecord,
  MissionRunRecord,
} from "./types";

export const MISSION_COMPUTER_SOURCE_HEALTH_LIMIT = 32;
export const MISSION_COMPUTER_EVENT_LIMIT = 8;
export const MISSION_COMPUTER_RUN_LIMIT = 4;
export const MISSION_COMPUTER_MEMORY_NODE_LIMIT = 8;
export const MISSION_COMPUTER_MEMORY_EDGE_LIMIT = 16;

export interface MissionComputerCoreSnapshot {
  mission: MissionRecord | null;
  operator: MissionOperatorRecord | null;
  research: MissionResearchStateRecord | null;
}

export type MissionComputerMemoryNode = Pick<MemoryNodeRecord,
  | "id" | "node_type" | "label" | "summary" | "aliases_json"
  | "importance" | "confidence" | "occurred_at" | "updated_at" | "status"
  | "source_ref" | "valid_from" | "valid_to"
>;

export type MissionComputerMemoryEdge = Pick<MemoryEdgeRecord,
  | "id" | "from_node_id" | "to_node_id" | "relation" | "weight"
  | "confidence" | "evidence_json" | "rationale"
>;

export interface MissionComputerPeripheralSnapshot {
  events: MissionEventRecord[];
  runs: MissionRunRecord[];
  sourceHealth: Array<Record<string, string | number | null>>;
  coverage: {
    eventsIncluded: number;
    hasMoreEvents: boolean;
    runsIncluded: number;
    hasMoreRuns: boolean;
    sourcesIncluded: number;
    hasMoreSources: boolean;
  };
}

export interface MissionComputerMemorySnapshot {
  nodes: MissionComputerMemoryNode[];
  edges: MissionComputerMemoryEdge[];
  coverage: {
    nodesIncluded: number;
    hasMoreNodes: boolean;
    edgesIncluded: number;
    hasMoreEdges: boolean;
  };
}

function rows<T>(result: D1Result<T>): T[] {
  return result.results ?? [];
}

function canonicalMissionKey(missionId: string): string {
  const slug = missionId
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
  return `mission:${slug || missionId.slice(0, 90)}`;
}

export async function loadMissionComputerCoreSnapshot(
  db: D1Database,
  missionId: string,
): Promise<MissionComputerCoreSnapshot> {
  const [mission, operator, research] = await Promise.all([
    db.prepare(
      `SELECT substr(id, 1, 128) AS id, substr(name, 1, 128) AS name,
              substr(question, 1, 800) AS question,
              CASE WHEN json_valid(terms_json) AND length(terms_json) <= 3000
                THEN terms_json ELSE '[]' END AS terms_json,
              CASE WHEN json_valid(source_scope_json) AND length(source_scope_json) <= 3000
                THEN source_scope_json ELSE '[]' END AS source_scope_json,
              substr(status, 1, 32) AS status, priority, cadence_minutes,
              last_evaluated_at, created_at, updated_at
       FROM missions WHERE id = ?`,
    ).bind(missionId).first<MissionRecord>(),
    db.prepare(
      `SELECT substr(mission_id, 1, 128) AS mission_id,
              substr(mode, 1, 32) AS mode, substr(research_policy, 1, 32) AS research_policy,
              alert_threshold, substr(expected_next_event, 1, 400) AS expected_next_event,
              expected_by, substr(outcome_status, 1, 32) AS outcome_status,
              substr(outcome_summary, 1, 800) AS outcome_summary,
              resolved_at, last_escalated_at, substr(sprint_policy, 1, 32) AS sprint_policy,
              next_sprint_at, last_sprint_at, reminder_lead_days,
              substr(expected_event_status, 1, 32) AS expected_event_status, updated_at
       FROM mission_operators WHERE mission_id = ?`,
    ).bind(missionId).first<MissionOperatorRecord>(),
    db.prepare(
      `SELECT substr(mission_id, 1, 128) AS mission_id,
              substr(current_thesis, 1, 2000) AS current_thesis,
              substr(report_summary, 1, 1500) AS report_summary,
              CASE WHEN json_valid(open_questions_json) AND length(open_questions_json) <= 2000
                THEN open_questions_json ELSE '[]' END AS open_questions_json,
              substr(report_title, 1, 240) AS report_title,
              substr(report_url, 1, 384) AS report_url,
              confidence, last_research_at, substr(last_handoff_id, 1, 128) AS last_handoff_id,
              updated_at
       FROM mission_research_state WHERE mission_id = ?`,
    ).bind(missionId).first<MissionResearchStateRecord>(),
  ]);
  return { mission, operator, research };
}

export async function loadMissionComputerPeripheralSnapshot(
  db: D1Database,
  missionId: string,
): Promise<MissionComputerPeripheralSnapshot> {
  const [eventResult, runResult, sourceResult] = await Promise.all([
    db.prepare(
      `SELECT substr(id, 1, 128) AS id, substr(mission_id, 1, 128) AS mission_id,
              substr(event_type, 1, 32) AS event_type, substr(title, 1, 128) AS title,
              substr(detail, 1, 256) AS detail, substr(story_id, 1, 128) AS story_id,
              CASE WHEN json_valid(metadata_json) AND length(metadata_json) <= 192
                THEN metadata_json ELSE '{"truncated":true}' END AS metadata_json,
              substr(dedupe_key, 1, 128) AS dedupe_key, occurred_at, created_at
       FROM mission_events
       WHERE mission_id = ?
       ORDER BY occurred_at DESC, created_at DESC
       LIMIT ?`,
    ).bind(missionId, MISSION_COMPUTER_EVENT_LIMIT + 1).all<MissionEventRecord>(),
    db.prepare(
      `SELECT substr(id, 1, 128) AS id, substr(mission_id, 1, 128) AS mission_id,
              substr(workflow_id, 1, 128) AS workflow_id, substr(status, 1, 32) AS status,
              CASE WHEN json_valid(source_ids_json) AND length(source_ids_json) <= 768
                THEN source_ids_json ELSE '[]' END AS source_ids_json,
              CASE WHEN json_valid(result_json) AND length(result_json) <= 384
                THEN result_json ELSE '{"truncated":true}' END AS result_json,
              substr(error, 1, 128) AS error, started_at, completed_at, created_at, updated_at
       FROM mission_runs
       WHERE mission_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).bind(missionId, MISSION_COMPUTER_RUN_LIMIT + 1).all<MissionRunRecord>(),
    db.prepare(
      `SELECT substr(id, 1, 128) AS id, substr(name, 1, 64) AS name,
              substr(kind, 1, 48) AS kind, enabled, health_score,
              last_run_at, last_success_at, substr(last_error, 1, 96) AS last_error
       FROM sources
       ORDER BY health_score ASC, name COLLATE NOCASE
       LIMIT ?`,
    ).bind(MISSION_COMPUTER_SOURCE_HEALTH_LIMIT + 1).all<Record<string, string | number | null>>(),
  ]);
  const eventsWithSentinel = rows(eventResult);
  const runsWithSentinel = rows(runResult);
  const sourcesWithSentinel = rows(sourceResult);
  return {
    events: eventsWithSentinel.slice(0, MISSION_COMPUTER_EVENT_LIMIT),
    runs: runsWithSentinel.slice(0, MISSION_COMPUTER_RUN_LIMIT),
    sourceHealth: sourcesWithSentinel.slice(0, MISSION_COMPUTER_SOURCE_HEALTH_LIMIT),
    coverage: {
      eventsIncluded: Math.min(eventsWithSentinel.length, MISSION_COMPUTER_EVENT_LIMIT),
      hasMoreEvents: eventsWithSentinel.length > MISSION_COMPUTER_EVENT_LIMIT,
      runsIncluded: Math.min(runsWithSentinel.length, MISSION_COMPUTER_RUN_LIMIT),
      hasMoreRuns: runsWithSentinel.length > MISSION_COMPUTER_RUN_LIMIT,
      sourcesIncluded: Math.min(sourcesWithSentinel.length, MISSION_COMPUTER_SOURCE_HEALTH_LIMIT),
      hasMoreSources: sourcesWithSentinel.length > MISSION_COMPUTER_SOURCE_HEALTH_LIMIT,
    },
  };
}

export async function loadMissionComputerMemorySnapshot(
  db: D1Database,
  missionId: string,
): Promise<MissionComputerMemorySnapshot> {
  const nodeResult = await db.prepare(
    `WITH seed AS MATERIALIZED (
       SELECT id FROM memory_nodes
       WHERE node_type = 'mission' AND canonical_key = ?
       LIMIT 1
     ), outgoing AS MATERIALIZED (
       SELECT edge.to_node_id AS id
       FROM seed JOIN memory_edges edge INDEXED BY idx_memory_edges_from ON edge.from_node_id = seed.id
       ORDER BY edge.weight DESC, edge.last_seen_at DESC, edge.id ASC
       LIMIT 24
     ), incoming AS MATERIALIZED (
       SELECT edge.from_node_id AS id
       FROM seed JOIN memory_edges edge INDEXED BY idx_memory_edges_to ON edge.to_node_id = seed.id
       ORDER BY edge.weight DESC, edge.last_seen_at DESC, edge.id ASC
       LIMIT 24
     ), candidate_ids AS (
       SELECT id, 0 AS seed_order FROM seed
       UNION
       SELECT id, 1 AS seed_order FROM outgoing
       UNION
       SELECT id, 1 AS seed_order FROM incoming
     )
     SELECT substr(node.id, 1, 128) AS id, substr(node.node_type, 1, 32) AS node_type,
            substr(node.label, 1, 128) AS label, substr(node.summary, 1, 240) AS summary,
            CASE WHEN json_valid(node.aliases_json) AND length(node.aliases_json) <= 192
              THEN node.aliases_json ELSE '[]' END AS aliases_json,
            node.importance, node.confidence, node.occurred_at, node.updated_at,
            substr(node.status, 1, 32) AS status, substr(node.source_ref, 1, 192) AS source_ref,
            node.valid_from, node.valid_to
     FROM candidate_ids selected
     JOIN memory_nodes node ON node.id = selected.id
     ORDER BY selected.seed_order ASC, node.importance DESC, node.last_seen_at DESC, node.id ASC
     LIMIT ?`,
  ).bind(canonicalMissionKey(missionId), MISSION_COMPUTER_MEMORY_NODE_LIMIT + 1).all<MissionComputerMemoryNode>();
  const nodesWithSentinel = rows(nodeResult);
  const nodes = nodesWithSentinel.slice(0, MISSION_COMPUTER_MEMORY_NODE_LIMIT);
  if (!nodes.length) {
    return {
      nodes: [],
      edges: [],
      coverage: { nodesIncluded: 0, hasMoreNodes: false, edgesIncluded: 0, hasMoreEdges: false },
    };
  }
  const nodeIdsJson = JSON.stringify(nodes.map((node) => node.id));
  const edgeResult = await db.prepare(
    `WITH selected(id) AS (
       SELECT CAST(value AS TEXT) FROM json_each(?)
     )
     SELECT substr(edge.id, 1, 128) AS id, substr(edge.from_node_id, 1, 128) AS from_node_id,
            substr(edge.to_node_id, 1, 128) AS to_node_id, substr(edge.relation, 1, 48) AS relation,
            edge.weight, edge.confidence,
            CASE WHEN json_valid(edge.evidence_json) AND length(edge.evidence_json) <= 192
              THEN edge.evidence_json ELSE '[]' END AS evidence_json,
            substr(edge.rationale, 1, 128) AS rationale
     FROM memory_edges edge
     WHERE edge.from_node_id IN (SELECT id FROM selected)
       AND edge.to_node_id IN (SELECT id FROM selected)
     ORDER BY edge.weight DESC, edge.last_seen_at DESC, edge.id ASC
     LIMIT ?`,
  ).bind(nodeIdsJson, MISSION_COMPUTER_MEMORY_EDGE_LIMIT + 1).all<MissionComputerMemoryEdge>();
  const edgesWithSentinel = rows(edgeResult);
  return {
    nodes,
    edges: edgesWithSentinel.slice(0, MISSION_COMPUTER_MEMORY_EDGE_LIMIT),
    coverage: {
      nodesIncluded: nodes.length,
      hasMoreNodes: nodesWithSentinel.length > MISSION_COMPUTER_MEMORY_NODE_LIMIT,
      edgesIncluded: Math.min(edgesWithSentinel.length, MISSION_COMPUTER_MEMORY_EDGE_LIMIT),
      hasMoreEdges: edgesWithSentinel.length > MISSION_COMPUTER_MEMORY_EDGE_LIMIT,
    },
  };
}
