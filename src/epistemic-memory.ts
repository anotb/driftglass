import { tracing, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  electMemoryGraphRun,
  failStaleMemoryGraphRun,
  finishMemoryGraphRun,
  getActiveMemoryGraphRun,
  getMemoryGraphRun,
  getMissionOperator,
  getSetting,
  getMissionResearchState,
  latestStories,
  listIntelligencePacks,
  listMemoryNodes,
  listMissionEvents,
  listMissionMatches,
  listMissions,
  listSources,
  listStoryEvidenceSummary,
  memoryGraphStats,
  pruneMemoryGraph,
  setSetting,
  trimMemoryGraph,
  updateMemoryGraphRun,
  upsertMemoryEdge,
  upsertMemoryNode,
} from "./db";
import { BudgetDeferredError, canSpend, getBudgetProfile, requireBudget, reserve } from "./budget";
import { sha256 } from "./security";
import type {
  Env,
  IntelligencePackManifest,
  IntelligencePackRecord,
  MemoryGraphWorkflowParams,
  MemoryGraphRunRecord,
  MemoryNodeRecord,
  MemoryNodeType,
  MemoryRelation,
  MissionRecord,
  SourceRecord,
  StoryRecord,
} from "./types";
import { clamp, isoNow, normalizeStringArray, parseJson } from "./utils";

export interface EpistemicRefreshResult {
  status: "complete" | "partial" | "deferred";
  runId: string;
  nodesWritten: number;
  edgesWritten: number;
  stories: number;
  missions: number;
  sources: number;
  entities: number;
  prunedNodes: number;
  prunedEdges: number;
  budgetProfile: string;
  completedAt: string;
}


export interface EpistemicRefreshQueued {
  status: "queued" | "running" | "deferred";
  runId: string;
  workflowId?: string;
  profile: string;
  estimatedWorkflowSteps: number;
  estimatedMemoryWrites: number;
  reason?: string;
  queuedAt: string;
}

interface MemoryGraphBounds {
  missions: number;
  stories: number;
  sources: number;
  packs: number;
  entities: number;
  evidenceRows: number;
  evidencePerStory: number;
  maxNodes: number;
  maxEdges: number;
}

interface MemoryGraphPlan {
  profile: string;
  bounds: MemoryGraphBounds;
  missions: MissionRecord[];
  sources: SourceRecord[];
  stories: StoryRecord[];
  packs: IntelligencePackRecord[];
  entityTerms: string[];
  estimatedWrites: number;
}

const MEMORY_RUN_STALE_MS = 6 * 60 * 60_000;
const ACTIVE_WORKFLOW_STATUSES = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
]);
const TERMINAL_WORKFLOW_STATUSES = new Set(["complete", "errored", "terminated"]);

function workflowInstanceIsMissing(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown };
    if ([candidate.code, candidate.status, candidate.statusCode].some((value) => Number(value) === 404)) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:not found|does not exist|doesn't exist|unknown workflow instance|invalid instance id)/i.test(message);
}

async function reconcileStaleMemoryGraphRun(
  env: Env,
  active: MemoryGraphRunRecord,
): Promise<MemoryGraphRunRecord | null> {
  const updatedAt = Date.parse(active.updated_at);
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt < MEMORY_RUN_STALE_MS) return active;

  let failureReason: string | null = null;
  if (!active.workflow_id) {
    failureReason = "Memory Graph run has no Workflow instance after the recovery window";
  } else {
    try {
      const instance = await env.MEMORY_WORKFLOW.get(active.workflow_id);
      const remote = await instance.status();
      const status = typeof remote?.status === "string" ? remote.status : "unknown";
      if (ACTIVE_WORKFLOW_STATUSES.has(status)) return active;
      if (TERMINAL_WORKFLOW_STATUSES.has(status)) {
        failureReason = `Memory Graph Workflow reached terminal status ${status} without finalizing its run`;
      } else {
        // Workflow may add statuses over time, and a malformed/transient status
        // response cannot prove that the canonical writer stopped. Preserve the
        // active D1 row unless Cloudflare reports a known terminal state.
        return active;
      }
    } catch (error) {
      // A transient control-plane failure must never authorize a duplicate
      // canonical graph writer. Only a confidently missing/invalid instance is
      // replaceable; other lookup failures leave the D1 run active.
      if (!workflowInstanceIsMissing(error)) return active;
      failureReason = "Memory Graph Workflow instance is no longer available";
    }
  }

  const staleBefore = new Date(Date.now() - MEMORY_RUN_STALE_MS).toISOString();
  const failed = await failStaleMemoryGraphRun(env.DB, active.id, staleBefore, failureReason);
  return failed ? null : getActiveMemoryGraphRun(env.DB);
}

export function memoryGraphBounds(profile: string): MemoryGraphBounds {
  if (profile === "cheap") return {
    missions: 25, stories: 80, sources: 60, packs: 20, entities: 72,
    evidenceRows: 400, evidencePerStory: 10, maxNodes: 500, maxEdges: 2_000,
  };
  if (profile === "custom") return {
    missions: 30, stories: 90, sources: 70, packs: 25, entities: 80,
    evidenceRows: 500, evidencePerStory: 10, maxNodes: 500, maxEdges: 2_000,
  };
  return {
    missions: 12, stories: 40, sources: 24, packs: 8, entities: 48,
    evidenceRows: 120, evidencePerStory: 6, maxNodes: 350, maxEdges: 1_200,
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function estimatedWorkflowSteps(bounds: MemoryGraphBounds): number {
  return 3
    + Math.ceil(bounds.entities / 8)
    + Math.ceil(bounds.sources / 12)
    + bounds.missions
    + bounds.packs
    + Math.ceil(bounds.stories / 3)
    + bounds.stories
    + bounds.missions;
}

function estimatedGraphWrites(plan: Pick<MemoryGraphPlan, "missions" | "sources" | "stories" | "packs" | "entityTerms" | "bounds">): number {
  return Math.min(4_800,
    plan.entityTerms.length
      + plan.sources.length
      + plan.missions.length * 20
      + plan.packs.length * 20
      + plan.stories.length * 12
      + Math.min(plan.bounds.evidenceRows, plan.stories.length * plan.bounds.evidencePerStory) * 2
      + 40,
  );
}


function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || "memory";
}

function key(type: MemoryNodeType, value: string): string {
  return `${type}:${slug(value)}`;
}

async function stableId(prefix: string, value: string): Promise<string> {
  return `${prefix}-${(await sha256(value)).slice(0, 20)}`;
}

async function putNode(
  env: Env,
  counter: { nodes: number; edges: number },
  input: Parameters<typeof upsertMemoryNode>[1],
): Promise<MemoryNodeRecord> {
  const saved = await upsertMemoryNode(env.DB, input);
  counter.nodes += 1;
  return saved;
}

async function putEdge(
  env: Env,
  counter: { nodes: number; edges: number },
  input: Omit<Parameters<typeof upsertMemoryEdge>[1], "id">,
): Promise<void> {
  await upsertMemoryEdge(env.DB, {
    ...input,
    id: await stableId("me", `${input.fromNodeId}:${input.relation}:${input.toNodeId}`),
  });
  counter.edges += 1;
}

function entityAliases(node: MemoryNodeRecord): string[] {
  return [...new Set([
    node.label,
    ...parseJson<string[]>(node.aliases_json, []),
  ].map((value) => value.trim().toLowerCase()).filter((value) => value.length >= 3))];
}

function matchAliases(text: string, aliases: string[]): string | undefined {
  const haystack = text.toLowerCase();
  return aliases.find((alias) => haystack.includes(alias));
}

async function sourceNode(env: Env, source: SourceRecord, counter: { nodes: number; edges: number }): Promise<MemoryNodeRecord> {
  return putNode(env, counter, {
    id: `mem-source-${source.id}`,
    nodeType: "source",
    canonicalKey: key("source", source.id),
    label: source.name,
    summary: `${source.kind} source`,
    metadata: { sourceId: source.id, kind: source.kind, enabled: source.enabled === 1, healthScore: source.health_score },
    importance: clamp(0.4 + source.weight * 0.12),
    confidence: clamp(source.health_score),
    occurredAt: source.created_at,
    seenAt: source.updated_at,
    sourceRef: `source:${source.id}`,
  });
}

async function entityNode(
  env: Env,
  term: string,
  counter: { nodes: number; edges: number },
  metadata: Record<string, unknown> = {},
): Promise<MemoryNodeRecord> {
  return putNode(env, counter, {
    id: await stableId("mem-entity", term.toLowerCase()),
    nodeType: "entity",
    canonicalKey: key("entity", term),
    label: term,
    summary: typeof metadata.description === "string" ? metadata.description : "Tracked entity or topic",
    aliases: normalizeStringArray(metadata.aliases),
    metadata,
    importance: clamp(Number(metadata.importance ?? 0.62)),
    confidence: clamp(Number(metadata.confidence ?? 0.9)),
  });
}

async function missionMemory(
  env: Env,
  mission: MissionRecord,
  entities: MemoryNodeRecord[],
  counter: { nodes: number; edges: number },
): Promise<{ mission: MemoryNodeRecord; question?: MemoryNodeRecord }> {
  const [operator, research, events] = await Promise.all([
    getMissionOperator(env.DB, mission.id),
    getMissionResearchState(env.DB, mission.id),
    listMissionEvents(env.DB, mission.id, 4),
  ]);
  const missionNode = await putNode(env, counter, {
    id: `mem-mission-${mission.id}`,
    nodeType: "mission",
    canonicalKey: key("mission", mission.id),
    label: mission.name,
    summary: mission.question,
    aliases: parseJson<string[]>(mission.terms_json, []),
    metadata: { missionId: mission.id, status: mission.status, priority: mission.priority, cadenceMinutes: mission.cadence_minutes },
    importance: clamp(0.58 + mission.priority * 0.08),
    confidence: 1,
    occurredAt: mission.created_at,
    seenAt: mission.updated_at,
    sourceRef: `mission:${mission.id}`,
  });
  let questionNode: MemoryNodeRecord | undefined;
  if (mission.question.trim()) {
    questionNode = await putNode(env, counter, {
      id: await stableId("mem-question", mission.id),
      nodeType: "question",
      canonicalKey: key("question", `${mission.id}:standing`),
      label: mission.question,
      summary: `Standing question for ${mission.name}`,
      metadata: { missionId: mission.id },
      importance: 0.78,
      confidence: 1,
      occurredAt: mission.created_at,
      seenAt: mission.updated_at,
      sourceRef: `mission:${mission.id}`,
    });
    await putEdge(env, counter, {
      fromNodeId: missionNode.id,
      toNodeId: questionNode.id,
      relation: "asks",
      weight: 1,
      confidence: 1,
      evidence: [`mission:${mission.id}`],
      rationale: "This is the standing question maintained by the Mission.",
    });
  }

  const missionText = `${mission.name}\n${mission.question}\n${parseJson<string[]>(mission.terms_json, []).join(" ")}`;
  let trackedEntityEdges = 0;
  for (const entity of entities) {
    const alias = matchAliases(missionText, entityAliases(entity));
    if (!alias) continue;
    await putEdge(env, counter, {
      fromNodeId: missionNode.id,
      toNodeId: entity.id,
      relation: "tracks",
      weight: 0.86,
      confidence: 0.95,
      evidence: [`mission:${mission.id}`],
      rationale: `Mission definition explicitly tracks “${alias}”.`,
    });
    trackedEntityEdges += 1;
    if (trackedEntityEdges >= 6) break;
  }

  if (operator?.expected_next_event) {
    const expectation = await putNode(env, counter, {
      id: await stableId("mem-expectation", mission.id),
      nodeType: "expectation",
      canonicalKey: key("expectation", `${mission.id}:current`),
      label: operator.expected_next_event,
      summary: `Expected next observable event for ${mission.name}`,
      metadata: { missionId: mission.id, expectedBy: operator.expected_by, status: operator.expected_event_status },
      importance: 0.84,
      confidence: 0.82,
      occurredAt: operator.expected_by,
      seenAt: operator.updated_at,
      sourceRef: `mission:${mission.id}`,
      validTo: operator.expected_by,
    });
    await putEdge(env, counter, {
      fromNodeId: missionNode.id,
      toNodeId: expectation.id,
      relation: "expects",
      weight: 0.94,
      confidence: 0.9,
      evidence: [`mission-operator:${mission.id}`],
      rationale: "Mission operator records the next falsifiable observable event.",
    });
  }

  if (research?.current_thesis.trim()) {
    const finding = await putNode(env, counter, {
      id: await stableId("mem-finding", `${mission.id}:current-thesis`),
      nodeType: "finding",
      canonicalKey: key("finding", `${mission.id}:current-thesis`),
      label: `Current thesis · ${mission.name}`,
      summary: research.current_thesis,
      metadata: { missionId: mission.id, reportTitle: research.report_title, reportUrl: research.report_url },
      importance: 0.92,
      confidence: clamp(research.confidence ?? 0.72),
      occurredAt: research.last_research_at ?? research.updated_at,
      seenAt: research.updated_at,
      sourceRef: `mission:${mission.id}`,
      validFrom: research.last_research_at ?? research.updated_at,
    });
    await putEdge(env, counter, {
      fromNodeId: finding.id,
      toNodeId: missionNode.id,
      relation: "updates",
      weight: 0.96,
      confidence: clamp(research.confidence ?? 0.72),
      evidence: [`mission-research:${mission.id}`],
      rationale: "This is the latest approved research thesis for the Mission.",
    });
    if (questionNode) {
      await putEdge(env, counter, {
        fromNodeId: finding.id,
        toNodeId: questionNode.id,
        relation: "answers",
        weight: 0.86,
        confidence: clamp(research.confidence ?? 0.72),
        evidence: [`mission-research:${mission.id}`],
        rationale: "The current thesis is the best available answer to the standing question.",
      });
    }
  }

  if (operator && operator.outcome_status !== "open") {
    const decision = await putNode(env, counter, {
      id: await stableId("mem-decision", `${mission.id}:${operator.outcome_status}`),
      nodeType: "decision",
      canonicalKey: key("decision", `${mission.id}:${operator.outcome_status}`),
      label: `${mission.name} · ${operator.outcome_status}`,
      summary: operator.outcome_summary || `${mission.name} was marked ${operator.outcome_status}.`,
      metadata: { missionId: mission.id, outcomeStatus: operator.outcome_status },
      importance: 0.96,
      confidence: 0.95,
      occurredAt: operator.resolved_at ?? operator.updated_at,
      seenAt: operator.updated_at,
      sourceRef: `mission:${mission.id}`,
    });
    await putEdge(env, counter, {
      fromNodeId: decision.id,
      toNodeId: missionNode.id,
      relation: "resolves",
      weight: 1,
      confidence: 0.98,
      evidence: [`mission-operator:${mission.id}`],
      rationale: "The Mission outcome is an explicit approved decision state.",
    });
  }

  for (const event of events.filter((entry) => ["signal", "expected-event", "outcome", "research-result"].includes(entry.event_type)).slice(0, 3)) {
    const eventNode = await putNode(env, counter, {
      id: `mem-event-${event.id}`,
      nodeType: "event",
      canonicalKey: key("event", event.id),
      label: event.title,
      summary: event.detail,
      metadata: { missionId: mission.id, eventType: event.event_type, storyId: event.story_id },
      importance: event.event_type === "outcome" ? 0.88 : 0.68,
      confidence: 0.9,
      occurredAt: event.occurred_at,
      seenAt: event.created_at,
      sourceRef: `mission-event:${event.id}`,
    });
    await putEdge(env, counter, {
      fromNodeId: eventNode.id,
      toNodeId: missionNode.id,
      relation: "updates",
      weight: 0.75,
      confidence: 0.9,
      evidence: [`mission-event:${event.id}`],
      rationale: "Chronological Mission ledger event.",
    });
  }

  return { mission: missionNode, question: questionNode };
}

async function storyMemory(
  env: Env,
  story: StoryRecord,
  entities: MemoryNodeRecord[],
  counter: { nodes: number; edges: number },
  entityLimit = 4,
): Promise<{ story: MemoryNodeRecord; claim: MemoryNodeRecord }> {
  const storyNode = await putNode(env, counter, {
    id: `mem-story-${story.id}`,
    nodeType: "story",
    canonicalKey: key("story", story.id),
    label: story.title,
    summary: story.summary,
    metadata: { storyId: story.id, score: story.score, sourceCount: story.source_count },
    importance: clamp(story.importance),
    confidence: clamp(story.confidence),
    occurredAt: story.last_changed_at,
    seenAt: story.updated_at,
    sourceRef: `story:${story.id}`,
  });
  const claimNode = await putNode(env, counter, {
    id: await stableId("mem-claim", story.id),
    nodeType: "claim",
    canonicalKey: key("claim", story.id),
    label: story.title,
    summary: story.summary || `Current claim represented by Story ${story.title}`,
    metadata: { storyId: story.id, generatedFromStory: true, sourceCount: story.source_count },
    importance: clamp(story.importance),
    confidence: clamp(story.confidence),
    occurredAt: story.last_changed_at,
    seenAt: story.updated_at,
    sourceRef: `story:${story.id}`,
  });
  await putEdge(env, counter, {
    fromNodeId: claimNode.id,
    toNodeId: storyNode.id,
    relation: "derived_from",
    weight: 0.96,
    confidence: clamp(story.confidence),
    evidence: [`story:${story.id}`],
    rationale: "The durable claim is the epistemic assertion represented by this evolving Story cluster.",
  });
  const storyText = `${story.title}\n${story.summary}`;
  let entityEdges = 0;
  for (const entity of entities) {
    const alias = matchAliases(storyText, entityAliases(entity));
    if (!alias) continue;
    await putEdge(env, counter, {
      fromNodeId: storyNode.id,
      toNodeId: entity.id,
      relation: "mentions",
      weight: 0.62,
      confidence: 0.86,
      evidence: [`story:${story.id}`],
      metadata: { matchedAlias: alias },
      rationale: `Story title or summary mentions “${alias}”.`,
    });
    await putEdge(env, counter, {
      fromNodeId: claimNode.id,
      toNodeId: entity.id,
      relation: "about",
      weight: 0.7,
      confidence: 0.84,
      evidence: [`story:${story.id}`],
      metadata: { matchedAlias: alias },
      rationale: `The claim is about “${alias}”.`,
    });
    entityEdges += 1;
    if (entityEdges >= entityLimit) break;
  }
  return { story: storyNode, claim: claimNode };
}

async function buildMemoryPlan(
  env: Env,
  maxStories?: number,
  boundsOverride?: MemoryGraphBounds,
): Promise<MemoryGraphPlan> {
  const { profile } = await getBudgetProfile(env.DB);
  const bounds = boundsOverride ?? memoryGraphBounds(profile);
  const [missionsAll, sourcesAll, storiesAll, packs, seededEntities] = await Promise.all([
    listMissions(env.DB),
    listSources(env.DB),
    latestStories(env.DB, Math.max(10, Math.min(bounds.stories, maxStories ?? bounds.stories))),
    listIntelligencePacks(env.DB),
    listMemoryNodes(env.DB, { nodeType: "entity", limit: bounds.entities }),
  ]);
  const missions = missionsAll.slice(0, bounds.missions);
  const sources = sourcesAll.filter((source) => source.enabled === 1).slice(0, bounds.sources);
  const stories = storiesAll.slice(0, Math.max(1, Math.min(bounds.stories, maxStories ?? bounds.stories)));
  const entityTerms = [...new Set([
    ...seededEntities.map((entity) => entity.label),
    ...missions.flatMap((mission) => parseJson<string[]>(mission.terms_json, [])),
  ].map((term) => term.trim()).filter(Boolean))].slice(0, bounds.entities);
  const plan: MemoryGraphPlan = {
    profile,
    bounds,
    missions,
    sources,
    stories,
    packs: packs.slice(0, bounds.packs),
    entityTerms,
    estimatedWrites: 0,
  };
  plan.estimatedWrites = estimatedGraphWrites(plan);
  return plan;
}

async function processPackMemory(
  env: Env,
  pack: IntelligencePackRecord,
  selectedMissionIds: Set<string>,
  selectedSourceIds: Set<string>,
): Promise<{ nodes: number; edges: number }> {
  const counter = { nodes: 0, edges: 0 };
  const packNode = await putNode(env, counter, {
    id: `mem-pack-${pack.id}`,
    nodeType: "pack",
    canonicalKey: key("pack", pack.id),
    label: pack.name,
    summary: pack.description,
    metadata: { packId: pack.id, version: pack.version, category: pack.category, sourceUrl: pack.source_url },
    importance: 0.7,
    confidence: 1,
    occurredAt: pack.installed_at,
    seenAt: pack.updated_at,
    sourceRef: `pack:${pack.id}`,
  });
  const manifest = parseJson<IntelligencePackManifest>(pack.manifest_json, {} as IntelligencePackManifest);
  for (const mission of (manifest.missions ?? []).filter((entry) => selectedMissionIds.has(entry.id)).slice(0, 8)) {
    await putEdge(env, counter, {
      fromNodeId: packNode.id,
      toNodeId: `mem-mission-${mission.id}`,
      relation: "contains",
      weight: 0.85,
      confidence: 1,
      evidence: [`pack:${pack.id}`],
      rationale: "The Intelligence Pack defines this Mission.",
    });
  }
  const configuredSources = [...(manifest.cloudSources ?? []), ...(manifest.companionSources ?? []), ...(manifest.sources ?? [])];
  for (const source of configuredSources.filter((entry) => selectedSourceIds.has(entry.id)).slice(0, 12)) {
    await putEdge(env, counter, {
      fromNodeId: packNode.id,
      toNodeId: `mem-source-${source.id}`,
      relation: "contains",
      weight: 0.72,
      confidence: 1,
      evidence: [`pack:${pack.id}`],
      rationale: "The Intelligence Pack configures this source.",
    });
  }
  return counter;
}

async function processStoryEvidence(
  env: Env,
  storyId: string,
  selectedSourceIds: Set<string>,
  limit: number,
): Promise<{ nodes: number; edges: number }> {
  const counter = { nodes: 0, edges: 0 };
  const rows = (await listStoryEvidenceSummary(env.DB, [storyId], limit))
    .filter((row) => selectedSourceIds.has(row.source_id))
    .slice(0, limit);
  const claimId = await stableId("mem-claim", storyId);
  for (const row of rows) {
    const confidence = clamp(Number(row.source_health_score ?? 0.8));
    const provenance = {
      sourceKind: row.source_kind,
      familyKey: row.family_key,
      originFamilyKey: row.origin_family_key,
      lineageRelation: row.lineage_relation,
      lineageIndependent: row.lineage_independent === null
        ? null
        : Number(row.lineage_independent) === 1,
    };
    await putEdge(env, counter, {
      fromNodeId: `mem-story-${storyId}`,
      toNodeId: `mem-source-${row.source_id}`,
      relation: "observed_in",
      weight: 0.68,
      confidence,
      evidence: [row.item_id],
      metadata: { url: row.url, accessClass: row.access_class, ...provenance },
      rationale: "This source supplied evidence attached to the Story.",
    });
    await putEdge(env, counter, {
      fromNodeId: `mem-source-${row.source_id}`,
      toNodeId: claimId,
      relation: "evidence_for",
      weight: 0.76,
      confidence,
      evidence: [row.item_id],
      metadata: { storyId, url: row.url, accessClass: row.access_class, ...provenance },
      rationale: "This source supplied an evidence item supporting the current Story claim.",
    });
  }
  return counter;
}

async function processMissionMatches(
  env: Env,
  mission: MissionRecord,
  selectedStoryIds: Set<string>,
): Promise<{ nodes: number; edges: number }> {
  const counter = { nodes: 0, edges: 0 };
  const matches = await listMissionMatches(env.DB, mission.id, 15);
  for (const match of matches) {
    const storyId = String(match.story_id ?? "");
    if (!selectedStoryIds.has(storyId)) continue;
    await putEdge(env, counter, {
      fromNodeId: `mem-story-${storyId}`,
      toNodeId: `mem-mission-${mission.id}`,
      relation: "relevant_to",
      weight: clamp(Number(match.match_score ?? 0.65)),
      confidence: 0.9,
      evidence: [`mission-match:${mission.id}:${storyId}`],
      metadata: { matchedTerms: parseJson<string[]>(String(match.matched_terms_json ?? "[]"), []) },
      rationale: "Deterministic Mission matching connected this Story to the standing question.",
    });
  }
  return counter;
}

interface MemoryRefreshStepRunner {
  do<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

async function executeMemoryGraphRefresh(
  env: Env,
  input: {
    runId: string;
    executionId: string;
    executionMode: "cloudflare-workflow" | "selfhost-local";
    force?: boolean;
    maxStories?: number;
    boundsOverride?: MemoryGraphBounds;
  },
  step: MemoryRefreshStepRunner,
): Promise<EpistemicRefreshResult | { runId: string; status: "deferred"; profile: string }> {
    const { runId } = input;
    const totals = { nodes: 0, edges: 0 };
    try {
      const plan = await step.do("plan sparse epistemic graph", async () => {
        const next = await buildMemoryPlan(env, input.maxStories, input.boundsOverride);
        const run = await getMemoryGraphRun(env.DB, runId);
        const details = parseJson<Record<string, unknown>>(run?.details_json ?? "{}", {});
        if (details.memoryBudgetReserved !== true) {
          const reservation = await reserve(env.DB, "memory_writes", next.estimatedWrites, {
            operation: input.executionMode === "cloudflare-workflow" ? "memory-graph-workflow" : "selfhost-memory-refresh",
            runId,
            ...(input.executionMode === "cloudflare-workflow"
              ? { workflowId: input.executionId }
              : { executionId: input.executionId }),
          });
          if (!reservation.allowed) {
            await finishMemoryGraphRun(env.DB, {
              id: runId,
              status: "deferred",
              details: { ...details, estimatedWrites: next.estimatedWrites, remaining: reservation.remaining, profile: next.profile },
            });
            return { ...next, deferred: true };
          }
          await updateMemoryGraphRun(env.DB, runId, {
            status: "running",
            workflowId: input.executionId,
            profile: next.profile,
            phase: "planning",
            details: input.executionMode === "cloudflare-workflow"
              ? { ...details, memoryBudgetReserved: true, estimatedWrites: next.estimatedWrites, bounds: next.bounds }
              : { ...details, executionMode: input.executionMode, memoryBudgetReserved: true, estimatedWrites: next.estimatedWrites, bounds: next.bounds },
          });
        }
        return { ...next, deferred: false };
      });
      if (plan.deferred) return { runId, status: "deferred", profile: plan.profile };

      for (const [index, terms] of chunk(plan.entityTerms, 8).entries()) {
        const result = await step.do(`seed entities ${index + 1}`, async () => {
          const counter = { nodes: 0, edges: 0 };
          for (const term of terms) await entityNode(env, term, counter, { origin: "mission-or-pack-term", confidence: 1 });
          return counter;
        });
        totals.nodes += result.nodes; totals.edges += result.edges;
      }

      for (const [index, sources] of chunk(plan.sources, 12).entries()) {
        const result = await step.do(`sync sources ${index + 1}`, async () => {
          const counter = { nodes: 0, edges: 0 };
          for (const source of sources) await sourceNode(env, source, counter);
          return counter;
        });
        totals.nodes += result.nodes; totals.edges += result.edges;
      }

      for (const mission of plan.missions) {
        const result = await step.do(`sync mission ${mission.id}`, async () => {
          const entities = await listMemoryNodes(env.DB, { nodeType: "entity", limit: plan.bounds.entities });
          const counter = { nodes: 0, edges: 0 };
          await missionMemory(env, mission, entities, counter);
          return counter;
        });
        totals.nodes += result.nodes; totals.edges += result.edges;
      }

      const missionIds = new Set(plan.missions.map((mission) => mission.id));
      const sourceIds = new Set(plan.sources.map((source) => source.id));
      for (const pack of plan.packs) {
        const result = await step.do(`sync pack ${pack.id}`, async () => processPackMemory(env, pack, missionIds, sourceIds));
        totals.nodes += result.nodes; totals.edges += result.edges;
      }

      for (const [index, stories] of chunk(plan.stories, 3).entries()) {
        const result = await step.do(`sync stories ${index + 1}`, async () => {
          const entities = await listMemoryNodes(env.DB, { nodeType: "entity", limit: plan.bounds.entities });
          const counter = { nodes: 0, edges: 0 };
          for (const story of stories) await storyMemory(env, story, entities, counter, 4);
          return counter;
        });
        totals.nodes += result.nodes; totals.edges += result.edges;
      }

      let evidenceSeen = 0;
      for (const story of plan.stories) {
        if (evidenceSeen >= plan.bounds.evidenceRows) break;
        const limit = Math.min(plan.bounds.evidencePerStory, plan.bounds.evidenceRows - evidenceSeen);
        const result = await step.do(`link evidence ${story.id}`, async () => processStoryEvidence(env, story.id, sourceIds, limit));
        totals.nodes += result.nodes; totals.edges += result.edges;
        evidenceSeen += Math.floor(result.edges / 2);
      }

      const storyIds = new Set(plan.stories.map((story) => story.id));
      for (const mission of plan.missions) {
        const result = await step.do(`link mission ${mission.id}`, async () => processMissionMatches(env, mission, storyIds));
        totals.nodes += result.nodes; totals.edges += result.edges;
      }

      const final = await step.do("prune and finalize sparse graph", async () => {
        const staleBefore = new Date(Date.now() - 150 * 86_400_000).toISOString();
        const pruned = await pruneMemoryGraph(env.DB, staleBefore);
        const trimmed = await trimMemoryGraph(env.DB, { maxNodes: plan.bounds.maxNodes, maxEdges: plan.bounds.maxEdges });
        const completedAt = isoNow();
        await Promise.all([
          setSetting(env.DB, "memory_graph_dirty", "0"),
          setSetting(env.DB, "memory_graph_last_refresh_at", completedAt),
        ]);
        return { pruned, trimmed, completedAt };
      });
      const prunedNodes = final.pruned.nodes + final.trimmed.nodes;
      const prunedEdges = final.pruned.edges + final.trimmed.edges;
      const status: EpistemicRefreshResult["status"] = prunedNodes + prunedEdges > 0 ? "partial" : "complete";
      const result: EpistemicRefreshResult = {
        status,
        runId,
        nodesWritten: totals.nodes,
        edgesWritten: totals.edges,
        stories: plan.stories.length,
        missions: plan.missions.length,
        sources: plan.sources.length,
        entities: plan.entityTerms.length,
        prunedNodes,
        prunedEdges,
        budgetProfile: plan.profile,
        completedAt: final.completedAt,
      };
      await finishMemoryGraphRun(env.DB, {
        id: runId,
        status,
        nodeWrites: totals.nodes,
        edgeWrites: totals.edges,
        details: input.executionMode === "cloudflare-workflow"
          ? { ...result, workflowId: input.executionId, bounds: plan.bounds }
          : { ...result, executionMode: input.executionMode, executionId: input.executionId, bounds: plan.bounds },
      });
      return result;
    } catch (error) {
      await finishMemoryGraphRun(env.DB, {
        id: runId,
        status: error instanceof BudgetDeferredError ? "deferred" : "failed",
        nodeWrites: totals.nodes,
        edgeWrites: totals.edges,
        details: input.executionMode === "cloudflare-workflow"
          ? { workflowId: input.executionId }
          : { executionMode: input.executionMode, executionId: input.executionId },
        error: error instanceof BudgetDeferredError ? undefined : error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
    }
}

export class MemoryGraphWorkflow extends WorkflowEntrypoint<Env, MemoryGraphWorkflowParams> {
  override async run(event: WorkflowEvent<MemoryGraphWorkflowParams>, step: WorkflowStep) {
    return executeMemoryGraphRefresh(this.env, {
      runId: event.payload.runId,
      executionId: event.instanceId,
      executionMode: "cloudflare-workflow",
      force: event.payload.force,
      maxStories: event.payload.maxStories,
    }, step as unknown as MemoryRefreshStepRunner);
  }
}

const SELFHOST_MEMORY_EXECUTION_PREFIX = "selfhost-memory:";

/**
 * Resume safety for the experimental self-host profile. A verified process
 * lock guarantees that an active local execution belongs to the prior
 * process. The graph remains dirty and is rebuilt idempotently from canonical
 * Story, Mission, source, and approved-memory rows.
 */
export async function recoverInterruptedSelfhostMemoryRefresh(env: Env): Promise<boolean> {
  const active = await getActiveMemoryGraphRun(env.DB);
  const details = parseJson<Record<string, unknown>>(active?.details_json ?? "{}", {});
  const local = Boolean(active) && (
    active!.workflow_id?.startsWith(SELFHOST_MEMORY_EXECUTION_PREFIX) === true
    || details.executionMode === "selfhost-local"
  );
  if (!active || !local) return false;
  await finishMemoryGraphRun(env.DB, {
    id: active.id,
    status: "failed",
    nodeWrites: active.node_writes,
    edgeWrites: active.edge_writes,
    details: { ...details, interrupted: true, recoveredAt: isoNow() },
    error: "Interrupted local memory refresh; rebuilding from saved evidence",
  });
  await setSetting(env.DB, "memory_graph_dirty", "1");
  return true;
}

/** Run the same bounded deterministic graph refresh without a Cloudflare Workflow. */
export async function refreshEpistemicMemoryLocally(
  env: Env,
  options: { force?: boolean; maxStories?: number; executionId?: string } = {},
): Promise<EpistemicRefreshQueued | EpistemicRefreshResult> {
  const active = await getActiveMemoryGraphRun(env.DB);
  if (active) {
    const details = parseJson<Record<string, unknown>>(active.details_json, {});
    return {
      status: active.status === "queued" ? "queued" : "running",
      runId: active.id,
      workflowId: active.workflow_id ?? undefined,
      profile: active.profile,
      estimatedWorkflowSteps: Number(details.estimatedWorkflowSteps ?? 0),
      estimatedMemoryWrites: Number(details.estimatedMemoryWrites ?? 0),
      reason: "Memory is already refreshing.",
      queuedAt: active.started_at,
    };
  }

  const { profile } = await getBudgetProfile(env.DB);
  // Reuse the established larger bound locally: it remains finite, while not
  // discarding an ordinary 50+ Story personal library for a Cloudflare
  // per-invocation constraint that does not exist on this machine.
  const localBounds = memoryGraphBounds(profile === "free" ? "cheap" : profile);
  const plan = await buildMemoryPlan(env, options.maxStories, localBounds);
  const workflowSteps = estimatedWorkflowSteps(plan.bounds);
  const allowance = await canSpend(env.DB, "memory_writes", plan.estimatedWrites);
  if (!allowance.allowed) {
    return {
      status: "deferred",
      runId: `deferred-${crypto.randomUUID()}`,
      profile: plan.profile,
      estimatedWorkflowSteps: workflowSteps,
      estimatedMemoryWrites: plan.estimatedWrites,
      reason: "Memory refresh is deferred by the current usage plan.",
      queuedAt: isoNow(),
    };
  }

  const runId = `mgr-${crypto.randomUUID()}`;
  const executionId = options.executionId?.startsWith(SELFHOST_MEMORY_EXECUTION_PREFIX)
    ? options.executionId
    : `${SELFHOST_MEMORY_EXECUTION_PREFIX}${crypto.randomUUID()}`;
  const election = await electMemoryGraphRun(env.DB, runId, {
    force: Boolean(options.force),
    maxStories: options.maxStories,
    estimatedWorkflowSteps: workflowSteps,
    estimatedMemoryWrites: plan.estimatedWrites,
    bounds: plan.bounds,
    executionMode: "selfhost-local",
  }, { status: "running", workflowId: executionId, profile: plan.profile, phase: "planning" });
  if (!election.created) {
    const winner = election.run;
    const details = parseJson<Record<string, unknown>>(winner.details_json, {});
    return {
      status: winner.status === "queued" ? "queued" : "running",
      runId: winner.id,
      workflowId: winner.workflow_id ?? undefined,
      profile: winner.profile,
      estimatedWorkflowSteps: Number(details.estimatedWorkflowSteps ?? 0),
      estimatedMemoryWrites: Number(details.estimatedMemoryWrites ?? 0),
      reason: "Memory is already refreshing.",
      queuedAt: winner.started_at,
    };
  }

  const result = await executeMemoryGraphRefresh(env, {
    runId,
    executionId,
    executionMode: "selfhost-local",
    force: options.force,
    maxStories: options.maxStories,
    boundsOverride: localBounds,
  }, {
    async do<T>(_name: string, operation: () => Promise<T>): Promise<T> {
      return operation();
    },
  });
  if (result.status === "deferred" && "profile" in result) {
    return {
      status: "deferred",
      runId,
      profile: result.profile,
      estimatedWorkflowSteps: workflowSteps,
      estimatedMemoryWrites: plan.estimatedWrites,
      reason: "Memory refresh is deferred by the current usage plan.",
      queuedAt: isoNow(),
    };
  }
  return result;
}

export async function refreshEpistemicMemory(
  env: Env,
  options: { force?: boolean; maxStories?: number } = {},
): Promise<EpistemicRefreshQueued | EpistemicRefreshResult> {
  if (!env.MEMORY_WORKFLOW) {
    const { profile } = await getBudgetProfile(env.DB);
    const bounds = memoryGraphBounds(profile);
    return {
      status: "deferred",
      runId: `deferred-${crypto.randomUUID()}`,
      profile,
      estimatedWorkflowSteps: estimatedWorkflowSteps(bounds),
      estimatedMemoryWrites: bounds.maxNodes + bounds.maxEdges,
      reason: "The MEMORY_WORKFLOW binding is required for Free-tier-safe graph maintenance.",
      queuedAt: isoNow(),
    };
  }
  // The D1 row is not a Workflow heartbeat. Before replacing an old row,
  // reconcile it with Cloudflare's authoritative instance status so queued,
  // running, paused, or waiting Workflows retain exclusive graph ownership.
  const recordedActive = await getActiveMemoryGraphRun(env.DB);
  const active = recordedActive
    ? await reconcileStaleMemoryGraphRun(env, recordedActive)
    : null;
  if (active) {
    return {
      status: active.status === "queued" ? "queued" : "running",
      runId: active.id,
      workflowId: active.workflow_id ?? undefined,
      profile: active.profile,
      estimatedWorkflowSteps: Number(parseJson<Record<string, unknown>>(active.details_json, {}).estimatedWorkflowSteps ?? 0),
      estimatedMemoryWrites: Number(parseJson<Record<string, unknown>>(active.details_json, {}).estimatedMemoryWrites ?? 0),
      reason: "A Memory Graph refresh is already active.",
      queuedAt: active.started_at,
    };
  }
  const initialPlan = await buildMemoryPlan(env, options.maxStories);
  const profile = initialPlan.profile;
  const bounds = initialPlan.bounds;
  const workflowSteps = estimatedWorkflowSteps(bounds);
  const estimatedMemoryWrites = initialPlan.estimatedWrites;
  const memoryAllowance = await canSpend(env.DB, "memory_writes", estimatedMemoryWrites);
  if (!memoryAllowance.allowed) {
    return {
      status: "deferred",
      runId: `deferred-${crypto.randomUUID()}`,
      profile,
      estimatedWorkflowSteps: workflowSteps,
      estimatedMemoryWrites,
      reason: "The Memory Graph write envelope is exhausted for the active budget profile.",
      queuedAt: isoNow(),
    };
  }
  const runId = `mgr-${crypto.randomUUID()}`;
  const workflowId = `memory-${runId}`;
  const election = await electMemoryGraphRun(env.DB, runId, {
    force: Boolean(options.force),
    maxStories: options.maxStories,
    estimatedWorkflowSteps: workflowSteps,
    estimatedMemoryWrites,
    bounds,
  }, { status: "queued", workflowId, profile, phase: "queued" });
  if (!election.created) {
    const winner = election.run;
    const details = parseJson<Record<string, unknown>>(winner.details_json, {});
    return {
      status: winner.status === "queued" ? "queued" : "running",
      runId: winner.id,
      workflowId: winner.workflow_id ?? undefined,
      profile: winner.profile,
      estimatedWorkflowSteps: Number(details.estimatedWorkflowSteps ?? 0),
      estimatedMemoryWrites: Number(details.estimatedMemoryWrites ?? 0),
      reason: "A Memory Graph refresh is already active.",
      queuedAt: winner.started_at,
    };
  }
  try {
    await requireBudget(env.DB, "workflow_steps", workflowSteps, { operation: "memory-graph-refresh", profile });
  } catch (error) {
    if (error instanceof BudgetDeferredError) {
      await finishMemoryGraphRun(env.DB, {
        id: runId,
        status: "deferred",
        details: { workflowId, phase: "budget" },
      });
    }
    throw error;
  }
  // A create error is ambiguous: Cloudflare may have committed the Workflow
  // before its response was lost. A following D1 update can fail for the same
  // reason. In either case the elected row, already carrying the intended
  // Workflow ID, must remain active until authoritative reconciliation proves
  // that the instance is terminal or absent.
  const instance = await env.MEMORY_WORKFLOW.create({
    id: workflowId,
    params: { runId, force: options.force, maxStories: options.maxStories, requestedAt: isoNow() },
  });
  await updateMemoryGraphRun(env.DB, runId, { workflowId: instance.id, phase: "queued" });
  return {
    status: "queued",
    runId,
    workflowId: instance.id,
    profile,
    estimatedWorkflowSteps: workflowSteps,
    estimatedMemoryWrites,
    queuedAt: isoNow(),
  };
}

export async function epistemicMemoryRefreshIsDue(env: Env): Promise<boolean> {
  const rows = await env.DB
    .prepare("SELECT key, value FROM settings WHERE key IN ('memory_graph_auto_refresh', 'memory_graph_refresh_minutes', 'memory_graph_last_refresh_at', 'memory_graph_dirty')")
    .all<{ key: string; value: string }>();
  const settings = Object.fromEntries((rows.results ?? []).map((row) => [row.key, row.value]));
  if (settings.memory_graph_auto_refresh === "0") return false;
  const minutes = Math.max(30, Math.min(10_080, Number(settings.memory_graph_refresh_minutes ?? 360)));
  const last = Date.parse(settings.memory_graph_last_refresh_at ?? "");
  return settings.memory_graph_dirty === "1" || !Number.isFinite(last) || Date.now() - last >= minutes * 60_000;
}

export async function refreshEpistemicMemoryIfDue(env: Env): Promise<EpistemicRefreshQueued | EpistemicRefreshResult | null> {
  return await epistemicMemoryRefreshIsDue(env) ? refreshEpistemicMemory(env) : null;
}
