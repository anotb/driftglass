import {
  getStory,
  listTasteSources,
  listTasteTerms,
  recordTasteSourceSignals,
  recordTasteTermSignals,
} from "./db";
import { relevanceFromTerms, tokenize } from "./scoring";
import type { Env, TasteSourceRecord, TasteTermRecord } from "./types";
import { clamp } from "./utils";

const ACTION_IMPACT: Record<string, { terms: number; sources: number }> = {
  more: { terms: 0.34, sources: 0.08 },
  track: { terms: 0.58, sources: 0.12 },
  less: { terms: -0.42, sources: -0.06 },
  mute: { terms: -0.68, sources: -0.12 },
  "already-knew": { terms: 0, sources: 0 },
  "bad-source": { terms: 0, sources: -0.85 },
  wrong: { terms: 0, sources: 0 },
};

function phraseSignals(title: string, summary: string, impact: number): Array<{ term: string; delta: number }> {
  if (!impact) return [];
  const titleTokens = tokenize(title).filter((token) => token.length >= 3 && !/^\d+$/.test(token)).slice(0, 14);
  const summaryTokens = tokenize(summary).filter((token) => token.length >= 3 && !/^\d+$/.test(token)).slice(0, 14);
  const weighted = new Map<string, number>();
  const add = (term: string, multiplier: number) => {
    const normalized = term.trim().toLowerCase();
    if (!normalized) return;
    weighted.set(normalized, (weighted.get(normalized) ?? 0) + impact * multiplier);
  };
  titleTokens.forEach((token) => add(token, 0.68));
  summaryTokens.forEach((token) => add(token, 0.22));
  for (let index = 0; index < Math.min(10, titleTokens.length - 1); index += 1) {
    add(`${titleTokens[index]} ${titleTokens[index + 1]}`, 1);
  }
  return [...weighted.entries()]
    .sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]))
    .slice(0, 24)
    .map(([term, delta]) => ({ term, delta: Math.round(clamp(delta, -1, 1) * 1000) / 1000 }));
}

export async function learnFromFeedback(
  env: Env,
  input: { storyId: string; action: string },
): Promise<{ termsLearned: number; sourcesLearned: number }> {
  const impact = ACTION_IMPACT[input.action];
  if (!impact) return { termsLearned: 0, sourcesLearned: 0 };
  const detail = await getStory(env.DB, input.storyId);
  if (!detail) return { termsLearned: 0, sourcesLearned: 0 };

  const termSignals = phraseSignals(detail.story.title, detail.story.summary, impact.terms);
  const uniqueSourceIds = [...new Set(detail.evidence.map((item) => item.source_id))];
  const sourceSignals = uniqueSourceIds.map((sourceId) => ({ sourceId, delta: impact.sources }));
  await Promise.all([
    termSignals.length ? recordTasteTermSignals(env.DB, { storyId: input.storyId, signals: termSignals }) : Promise.resolve(),
    sourceSignals.length ? recordTasteSourceSignals(env.DB, sourceSignals) : Promise.resolve(),
  ]);
  return { termsLearned: termSignals.length, sourcesLearned: sourceSignals.length };
}

export function tasteAdjustedRelevance(
  text: string,
  configuredTerms: string[],
  learnedTerms: TasteTermRecord[],
): {
  value: number;
  configuredBase: number;
  learnedDelta: number;
  matchedPositive: Array<{ term: string; weight: number }>;
  matchedNegative: Array<{ term: string; weight: number }>;
} {
  const configuredBase = relevanceFromTerms(text, configuredTerms);
  const haystack = text.toLowerCase();
  const matched = learnedTerms.filter((signal) => haystack.includes(signal.term.toLowerCase()));
  const matchedPositive = matched
    .filter((signal) => signal.weight > 0)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 12)
    .map(({ term, weight }) => ({ term, weight }));
  const matchedNegative = matched
    .filter((signal) => signal.weight < 0)
    .sort((left, right) => left.weight - right.weight)
    .slice(0, 12)
    .map(({ term, weight }) => ({ term, weight }));
  const positive = matchedPositive.reduce((sum, signal) => sum + signal.weight, 0);
  const negative = matchedNegative.reduce((sum, signal) => sum + Math.abs(signal.weight), 0);
  const learnedDelta = Math.tanh((positive - negative) / 2.8) * 0.26;
  return {
    value: Math.round(clamp(configuredBase + learnedDelta) * 1000) / 1000,
    configuredBase,
    learnedDelta: Math.round(learnedDelta * 1000) / 1000,
    matchedPositive,
    matchedNegative,
  };
}

export async function getTasteProfile(env: Env): Promise<{
  positiveTerms: TasteTermRecord[];
  negativeTerms: TasteTermRecord[];
  preferredSources: TasteSourceRecord[];
  downweightedSources: TasteSourceRecord[];
}> {
  const [terms, sources] = await Promise.all([listTasteTerms(env.DB, 160), listTasteSources(env.DB, 100)]);
  return {
    positiveTerms: terms.filter((term) => term.weight > 0).slice(0, 40),
    negativeTerms: terms.filter((term) => term.weight < 0).slice(0, 40),
    preferredSources: sources.filter((source) => source.weight > 0).slice(0, 30),
    downweightedSources: sources.filter((source) => source.weight < 0).slice(0, 30),
  };
}
