import {
  getSetting,
  getStory,
  listStoryFeedback,
  listStoryMissionMatches,
  listTasteSources,
  listTasteTerms,
} from "./db";
import { tasteAdjustedRelevance } from "./taste";
import type { Env, RankingExplanation } from "./types";
import { clamp, normalizeStringArray, parseJson } from "./utils";

const FEEDBACK_ADJUSTMENTS: Record<string, number> = {
  track: 12,
  more: 8,
  less: -12,
  "already-knew": -10,
  "bad-source": -8,
  wrong: -18,
};

function component(
  id: string,
  label: string,
  raw: number,
  weight: number,
  explanation: string,
): RankingExplanation["components"][number] {
  return {
    id,
    label,
    raw: Math.round(raw * 1000) / 1000,
    weight,
    contribution: Math.round(raw * weight * 1000) / 10,
    explanation,
  };
}

export async function explainStoryRanking(env: Env, storyId: string): Promise<RankingExplanation | null> {
  const detail = await getStory(env.DB, storyId);
  if (!detail) return null;
  const [feedbackRows, missionRows, learnedTerms, learnedSources, configuredRaw] = await Promise.all([
    listStoryFeedback(env.DB, storyId),
    listStoryMissionMatches(env.DB, storyId),
    listTasteTerms(env.DB, 200),
    listTasteSources(env.DB, 100),
    getSetting(env.DB, "interest_terms"),
  ]);
  const configuredTerms = normalizeStringArray(parseJson<unknown>(configuredRaw, []));
  const taste = tasteAdjustedRelevance(`${detail.story.title}\n${detail.story.summary}`, configuredTerms, learnedTerms);
  const uniqueActions = new Set(feedbackRows.map((row) => String(row.action ?? "")));
  const muted = uniqueActions.has("mute");
  const feedbackAdjustment = [...uniqueActions].reduce((sum, action) => sum + (FEEDBACK_ADJUSTMENTS[action] ?? 0), 0);
  const corroboration = clamp(Math.log2(Math.max(1, detail.story.source_count)) / 3);
  const ageHours = Math.max(0, (Date.now() - Date.parse(detail.story.last_changed_at)) / 3_600_000);
  const recency = Math.exp(-ageHours / 48);
  const sourceIds = new Set(detail.evidence.map((item) => item.source_id));
  const sourceSignals = learnedSources
    .filter((signal) => sourceIds.has(signal.source_id))
    .map((signal) => ({ sourceId: signal.source_id, sourceName: signal.source_name, weight: signal.weight }));
  const currentRelevance = Math.max(detail.story.relevance, taste.value);
  const components = [
    component("relevance", "Personal relevance", currentRelevance, 0.3, "Explicit interests plus the learned Taste Profile."),
    component("novelty", "Novelty", detail.story.novelty, 0.18, "How different the newest evidence is from the existing Story."),
    component("importance", "Importance", detail.story.importance, 0.17, "Release, discussion, and engagement signals in source metadata."),
    component("confidence", "Confidence", detail.story.confidence, 0.12, "Source health, canonical evidence, and collection quality."),
    component("corroboration", "Source breadth", corroboration, 0.12, `${detail.story.source_count} distinct configured source${detail.story.source_count === 1 ? "" : "s"}. Evidence lineage determines whether they are independent.`),
    component("recency", "Recency", recency, 0.06, `Last meaningful change was ${Math.round(ageHours)} hour${Math.round(ageHours) === 1 ? "" : "s"} ago.`),
  ];
  const reasons: string[] = [];
  if (taste.matchedPositive.length) reasons.push(`Learned interests matched: ${taste.matchedPositive.slice(0, 5).map((item) => item.term).join(", ")}.`);
  if (taste.matchedNegative.length) reasons.push(`Learned downweights matched: ${taste.matchedNegative.slice(0, 4).map((item) => item.term).join(", ")}.`);
  if (detail.story.source_count > 1) reasons.push(`${detail.story.source_count} distinct configured sources broadened coverage; inspect evidence lineage before treating them as independent.`);
  if (missionRows.length) reasons.push(`Matched ${missionRows.length} active or historical Research Mission${missionRows.length === 1 ? "" : "s"}.`);
  if (feedbackAdjustment) reasons.push(`Explicit feedback changes briefing order by ${feedbackAdjustment > 0 ? "+" : ""}${feedbackAdjustment} points.`);
  if (!reasons.length) reasons.push("Ranked from relevance, novelty, importance, confidence, corroboration, and recency.");

  return {
    storyId,
    title: detail.story.title,
    storedScore: detail.story.score,
    effectiveScore: Math.round((detail.story.score + feedbackAdjustment) * 10) / 10,
    feedbackAdjustment,
    muted,
    components,
    taste: {
      matchedPositive: taste.matchedPositive,
      matchedNegative: taste.matchedNegative,
      sourceSignals,
    },
    feedback: feedbackRows.map((row) => ({
      action: String(row.action ?? ""),
      note: typeof row.note === "string" ? row.note : undefined,
      createdAt: String(row.created_at ?? ""),
    })),
    missions: missionRows.map((row) => ({
      id: String(row.id ?? ""),
      name: String(row.name ?? ""),
      matchScore: Number(row.match_score ?? 0),
      matchedTerms: parseJson<string[]>(String(row.matched_terms_json ?? "[]"), []),
    })),
    reasons,
  };
}
