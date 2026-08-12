import { getStory, latestStories, listStoryMissionMatches } from "./db";
import { jaccard } from "./scoring";
import type { Env, StoryRecord } from "./types";
import { clamp, parseJson } from "./utils";

type StoryGraphNode = {
  id: string;
  title: string;
  summary: string;
  score: number;
  changedAt: string;
  sourceCount: number;
  confidence: number;
  role: "focus" | "related";
};

type StoryGraphEdge = {
  from: string;
  to: string;
  strength: number;
  relation: "same-development" | "shared-mission" | "shared-sources" | "adjacent-signal";
  reasons: string[];
  sharedMissions: string[];
  sharedSources: string[];
};

function daysApart(left: string, right: string): number {
  const diff = Math.abs(new Date(left).getTime() - new Date(right).getTime());
  return Number.isFinite(diff) ? diff / 86_400_000 : 365;
}

function node(story: StoryRecord, role: StoryGraphNode["role"]): StoryGraphNode {
  return {
    id: story.id,
    title: story.title,
    summary: story.summary,
    score: story.score,
    changedAt: story.last_changed_at,
    sourceCount: story.source_count,
    confidence: story.confidence,
    role,
  };
}

export async function buildStoryGraph(env: Env, storyId: string, limit = 10): Promise<{
  focus: StoryGraphNode;
  nodes: StoryGraphNode[];
  edges: StoryGraphEdge[];
}> {
  const focusDetail = await getStory(env.DB, storyId);
  if (!focusDetail) throw new Error(`Story not found: ${storyId}`);
  const focusMissionRows = await listStoryMissionMatches(env.DB, storyId);
  const focusMissions = new Map(focusMissionRows.map((row) => [String(row.id), String(row.name ?? row.id)]));
  const focusSources = new Map(focusDetail.evidence.map((item) => [item.source_id, item.source_name]));
  const focusText = `${focusDetail.story.title} ${focusDetail.story.summary}`;

  const candidates = (await latestStories(env.DB, 80))
    .filter((story) => story.id !== storyId)
    .map((story) => {
      const lexical = jaccard(focusText, `${story.title} ${story.summary}`);
      const temporal = Math.max(0, 1 - daysApart(focusDetail.story.last_changed_at, story.last_changed_at) / 30);
      return { story, lexical, temporal, cheapScore: lexical * 0.88 + temporal * 0.12 };
    })
    .filter(({ lexical, temporal }) => lexical >= 0.08 || temporal >= 0.54)
    .sort((left, right) => right.cheapScore - left.cheapScore || right.story.score - left.story.score)
    .slice(0, 30);
  const scored: Array<{ story: StoryRecord; edge: StoryGraphEdge }> = [];

  for (const { story: candidate, lexical, temporal } of candidates) {
    const [detail, missionRows] = await Promise.all([
      getStory(env.DB, candidate.id),
      listStoryMissionMatches(env.DB, candidate.id),
    ]);
    if (!detail) continue;
    const candidateSources = new Map(detail.evidence.map((item) => [item.source_id, item.source_name]));
    const candidateMissions = new Map(missionRows.map((row) => [String(row.id), String(row.name ?? row.id)]));
    const sharedSourceIds = [...focusSources.keys()].filter((id) => candidateSources.has(id));
    const sharedMissionIds = [...focusMissions.keys()].filter((id) => candidateMissions.has(id));
    const sourceOverlap = sharedSourceIds.length / Math.max(1, Math.min(focusSources.size, candidateSources.size));
    const missionOverlap = sharedMissionIds.length / Math.max(1, Math.min(focusMissions.size || 1, candidateMissions.size || 1));
    const strength = clamp(lexical * 0.58 + sourceOverlap * 0.18 + missionOverlap * 0.2 + temporal * 0.04);
    if (strength < 0.16 && sharedSourceIds.length === 0 && sharedMissionIds.length === 0) continue;

    const reasons: string[] = [];
    if (lexical >= 0.35) reasons.push(`${Math.round(lexical * 100)}% topic overlap`);
    if (sharedMissionIds.length) reasons.push(`${sharedMissionIds.length} shared Mission${sharedMissionIds.length === 1 ? "" : "s"}`);
    if (sharedSourceIds.length) reasons.push(`${sharedSourceIds.length} shared source${sharedSourceIds.length === 1 ? "" : "s"}`);
    if (temporal >= 0.75) reasons.push("moved in the same time window");

    const relation: StoryGraphEdge["relation"] = lexical >= 0.48
      ? "same-development"
      : sharedMissionIds.length
        ? "shared-mission"
        : sharedSourceIds.length
          ? "shared-sources"
          : "adjacent-signal";

    scored.push({
      story: candidate,
      edge: {
        from: storyId,
        to: candidate.id,
        strength: Math.round(strength * 1000) / 1000,
        relation,
        reasons,
        sharedMissions: sharedMissionIds.map((id) => focusMissions.get(id) ?? candidateMissions.get(id) ?? id),
        sharedSources: sharedSourceIds.map((id) => focusSources.get(id) ?? candidateSources.get(id) ?? id),
      },
    });
  }

  scored.sort((left, right) => right.edge.strength - left.edge.strength || right.story.score - left.story.score);
  const selected = scored.slice(0, Math.max(1, Math.min(20, limit)));
  return {
    focus: node(focusDetail.story, "focus"),
    nodes: [node(focusDetail.story, "focus"), ...selected.map(({ story }) => node(story, "related"))],
    edges: selected.map(({ edge }) => edge),
  };
}
