import {
  getMission,
  getMissionResearchState,
  getStory,
  listMemoryNodes,
  listMissionMatches,
  listMissions,
  listStoryEvidenceSummary,
  searchStories,
} from "./db";
import { listDecisions } from "./decision-ledger";
import { memoryNeighborhood } from "./memory-graph";
import type { Env, LivingDossier, MemoryNodeRecord, StoryRecord } from "./types";
import { excerpt, isoNow, parseJson } from "./utils";

function time(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function metadata(node: MemoryNodeRecord): Record<string, unknown> {
  return parseJson(node.metadata_json, {});
}

function memoryView(node: MemoryNodeRecord): Record<string, unknown> {
  return {
    id: node.id,
    type: node.node_type,
    label: node.label,
    summary: node.summary,
    confidence: node.confidence,
    importance: node.importance,
    status: node.status,
    occurredAt: node.occurred_at,
    validFrom: node.valid_from,
    validTo: node.valid_to,
    sourceRef: node.source_ref,
    metadata: metadata(node),
  };
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function qualityScore(input: {
  evidence: number;
  sources: number;
  domains: number;
  primary: number;
  contradictions: number;
  openQuestions: number;
  memoryNodes: number;
}): LivingDossier["quality"] {
  let score = 0;
  score += Math.min(24, input.evidence * 2.4);
  score += Math.min(18, input.sources * 3);
  score += Math.min(14, input.domains * 2.8);
  score += Math.min(18, input.primary * 6);
  score += Math.min(12, input.memoryNodes * 0.8);
  if (input.contradictions > 0) score += 7;
  if (input.openQuestions > 0) score += 4;
  const blockers: string[] = [];
  if (input.evidence < 4) blockers.push("Too little evidence for a durable conclusion");
  if (input.sources < 3) blockers.push("Fewer than three distinct sources");
  if (input.domains < 2) blockers.push("Evidence is concentrated in one domain or platform");
  if (input.primary < 1) blockers.push("No primary or authoritative source identified");
  if (input.memoryNodes < 3) blockers.push("Insufficient prior memory for longitudinal comparison");
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  return { grade: bounded >= 74 && blockers.length <= 1 ? "strong" : bounded >= 45 ? "usable" : "insufficient", score: bounded, blockers };
}

async function storySetForScope(
  env: Env,
  input: { scopeKind?: "global" | "mission" | "story" | "query"; scopeId?: string; query?: string; limit?: number },
): Promise<StoryRecord[]> {
  const limit = Math.max(1, Math.min(40, input.limit ?? 20));
  if (input.scopeKind === "story" && input.scopeId) {
    const detail = await getStory(env.DB, input.scopeId);
    return detail ? [detail.story] : [];
  }
  if (input.scopeKind === "mission" && input.scopeId) {
    const matches = await listMissionMatches(env.DB, input.scopeId, limit);
    const details = await Promise.all(matches.map((match) => getStory(env.DB, String(match.story_id ?? ""))));
    return details.map((detail) => detail?.story).filter((story): story is StoryRecord => Boolean(story));
  }
  const query = input.query?.trim();
  if (query) return searchStories(env.DB, query, limit);
  const rows = await env.DB.prepare("SELECT * FROM stories ORDER BY score DESC, last_changed_at DESC LIMIT ?").bind(limit).all<StoryRecord>();
  return rows.results ?? [];
}

export async function buildLivingDossier(
  env: Env,
  input: { scopeKind?: "global" | "mission" | "story" | "query"; scopeId?: string; query?: string; limit?: number },
): Promise<LivingDossier> {
  const scopeKind = input.scopeKind ?? (input.scopeId ? "mission" : input.query ? "query" : "global");
  const stories = await storySetForScope(env, { ...input, scopeKind });
  const mission = scopeKind === "mission" && input.scopeId ? await getMission(env.DB, input.scopeId) : null;
  const research = mission ? await getMissionResearchState(env.DB, mission.id) : null;
  const query = input.query?.trim() || mission?.question || stories[0]?.title || "Current personal intelligence state";
  const memory = await memoryNeighborhood(env, {
    ref: scopeKind === "mission" && input.scopeId ? `mission:${input.scopeId}` : scopeKind === "story" && input.scopeId ? `story:${input.scopeId}` : undefined,
    query: scopeKind === "query" || scopeKind === "global" ? query : undefined,
    limit: 60,
  }).catch(() => ({ nodes: [] as MemoryNodeRecord[], edges: [], stats: {} }));
  const allDecisions = await listDecisions(env.DB, {
    missionId: scopeKind === "mission" ? input.scopeId : undefined,
    storyId: scopeKind === "story" ? input.scopeId : undefined,
    limit: 30,
  });
  const missions = mission ? [mission] : (await listMissions(env.DB)).filter((candidate) => {
    const haystack = `${candidate.name} ${candidate.question} ${candidate.terms_json}`.toLowerCase();
    return query.split(/\s+/).some((term) => term.length >= 4 && haystack.includes(term.toLowerCase()));
  }).slice(0, 12);

  const evidence = await listStoryEvidenceSummary(env.DB, stories.slice(0, 24).map((story) => story.id), 300);
  const storyById = new Map(stories.map((story) => [story.id, story]));
  const evidenceRows = evidence.map((item) => ({ story: storyById.get(item.story_id), item }));
  const sourceIds = new Set(evidenceRows.map(({ item }) => String(item.source_id ?? "")).filter(Boolean));
  const domains = new Set(evidenceRows.map(({ item }) => {
    try { return item.url ? new URL(String(item.url)).hostname.replace(/^www\./, "") : ""; } catch { return ""; }
  }).filter(Boolean));
  const primary = evidenceRows.filter(({ item }) => {
    const raw = parseJson<Record<string, unknown>>(String(item.metadata_json ?? "{}"), {});
    const role = String(raw.evidenceRole ?? raw.role ?? "").toLowerCase();
    return role === "primary" || role === "authoritative" || /github\.com|arxiv\.org|sec\.gov|gov$/.test(String(item.url ?? ""));
  }).length;

  const claims = memory.nodes.filter((node) => node.node_type === "claim").map(memoryView);
  const findings = memory.nodes.filter((node) => ["finding", "outcome"].includes(node.node_type)).map(memoryView);
  const entities = memory.nodes.filter((node) => node.node_type === "entity").map(memoryView);
  const questions = memory.nodes.filter((node) => node.node_type === "question" && node.status === "active");
  const contradictions = memory.edges.filter((edge) => edge.relation === "contradicts").map((edge) => {
    const from = memory.nodes.find((node) => node.id === edge.from_node_id);
    const to = memory.nodes.find((node) => node.id === edge.to_node_id);
    return { from: from ? memoryView(from) : edge.from_node_id, to: to ? memoryView(to) : edge.to_node_id, strength: edge.weight, rationale: edge.rationale };
  });
  const openQuestions = dedupe([
    ...parseJson<string[]>(research?.open_questions_json ?? "[]", []),
    ...questions.map((node) => node.label),
    ...contradictions.slice(0, 6).map((row) => `Resolve contradiction: ${typeof row.from === "string" ? row.from : row.from.label} vs ${typeof row.to === "string" ? row.to : row.to.label}`),
  ].filter(Boolean), (value) => value.toLowerCase()).slice(0, 20);

  const thesis = dedupe([
    research?.current_thesis ?? "",
    ...memory.nodes.filter((node) => ["finding", "claim", "decision", "outcome"].includes(node.node_type) && node.status === "active")
      .sort((left, right) => right.importance * right.confidence - left.importance * left.confidence)
      .map((node) => node.summary || node.label),
  ].filter(Boolean), (value) => value.toLowerCase()).slice(0, 12);

  const timeline = [
    ...stories.map((story) => ({ kind: "story", id: story.id, at: story.last_changed_at, title: story.title, summary: story.summary, score: story.score })),
    ...memory.nodes.filter((node) => node.occurred_at || node.valid_from).map((node) => ({ kind: node.node_type, id: node.id, at: node.occurred_at ?? node.valid_from, title: node.label, summary: node.summary })),
    ...allDecisions.map((decision) => ({ kind: decision.decision_type, id: decision.id, at: decision.created_at, title: decision.title, summary: decision.statement, status: decision.status })),
  ].filter((row) => Boolean(row.at)).sort((left, right) => time(String(right.at)) - time(String(left.at))).slice(0, 80);

  const latestAt = evidenceRows.map(({ item }) => String(item.published_at ?? item.observed_at ?? "")).sort().at(-1);
  const quality = qualityScore({
    evidence: evidenceRows.length,
    sources: sourceIds.size,
    domains: domains.size,
    primary,
    contradictions: contradictions.length,
    openQuestions: openQuestions.length,
    memoryNodes: memory.nodes.length,
  });
  return {
    schemaVersion: "1",
    generatedAt: isoNow(),
    query,
    focus: mission
      ? { id: mission.id, type: "mission", label: mission.name, summary: mission.question }
      : stories[0]
        ? { id: stories[0].id, type: "story", label: stories[0].title, summary: stories[0].summary }
        : undefined,
    thesis,
    entities,
    claims: [...claims, ...findings].slice(0, 40),
    contradictions: contradictions.slice(0, 20),
    decisions: allDecisions.map((decision) => ({
      id: decision.id,
      type: decision.decision_type,
      title: decision.title,
      statement: decision.statement,
      status: decision.status,
      confidence: decision.confidence,
      expectedOutcome: decision.expected_outcome,
      outcomeSummary: decision.outcome_summary,
      calibrationScore: decision.calibration_score,
      reviewAt: decision.review_at,
    })),
    missions: missions.map((row) => ({ id: row.id, name: row.name, question: row.question, status: row.status, priority: row.priority, lastEvaluatedAt: row.last_evaluated_at })),
    stories: stories.map((story) => ({ id: story.id, title: story.title, summary: story.summary, score: story.score, confidence: story.confidence, sourceCount: story.source_count, changedAt: story.last_changed_at })),
    timeline,
    evidenceCoverage: { sources: sourceIds.size, domains: domains.size, primaryOrAuthoritative: primary, latestAt },
    openQuestions,
    quality,
  };
}

export function livingDossierMarkdown(dossier: LivingDossier): string {
  return [
    `# Living dossier · ${dossier.focus?.label ?? dossier.query}`,
    "",
    `Generated: ${dossier.generatedAt}`,
    `Quality: **${dossier.quality.grade}** (${dossier.quality.score}/100)`,
    dossier.quality.blockers.length ? `Blockers: ${dossier.quality.blockers.join(" · ")}` : "",
    "",
    "## Current thesis",
    ...(dossier.thesis.length ? dossier.thesis.map((item) => `- ${item}`) : ["- No durable thesis has been established yet."]),
    "",
    "## Open questions",
    ...(dossier.openQuestions.length ? dossier.openQuestions.map((item) => `- ${item}`) : ["- No explicit open questions."]),
    "",
    "## Decisions and forecasts",
    ...(dossier.decisions.length ? dossier.decisions.map((item) => `- **${String(item.title)}** · ${String(item.status)} · confidence ${Math.round(Number(item.confidence ?? 0) * 100)}%\n  ${String(item.statement)}`) : ["- None recorded."]),
    "",
    "## Recent developments",
    ...(dossier.stories.slice(0, 20).map((item) => `- **${String(item.title)}** · ${String(item.changedAt)} · ${Number(item.sourceCount ?? 0)} sources\n  ${excerpt(String(item.summary ?? ""), 600)}`)),
    "",
    "## Evidence coverage",
    `- Sources: ${dossier.evidenceCoverage.sources}`,
    `- Domains: ${dossier.evidenceCoverage.domains}`,
    `- Primary or authoritative: ${dossier.evidenceCoverage.primaryOrAuthoritative}`,
    dossier.evidenceCoverage.latestAt ? `- Latest evidence: ${dossier.evidenceCoverage.latestAt}` : "",
    "",
  ].filter(Boolean).join("\n");
}
