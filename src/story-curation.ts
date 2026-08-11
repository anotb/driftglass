import type { BriefingPacketStory } from "./types";

export interface StoryCurationCandidate {
  story: BriefingPacketStory;
  missionIds: string[];
  missionMatchScore: number;
  sourceKeys: string[];
  providerKeys: string[];
  seriesKeys: string[];
  newestPublishedAt?: string;
  newestObservedAt?: string;
  monitorSnapshot: boolean;
  independentFamilies: number;
}

export interface StoryCurationResult {
  stories: BriefingPacketStory[];
  selectedIds: string[];
  filedCount: number;
}

function time(value?: string): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isFresh(candidate: StoryCurationCandidate, periodStart: string): boolean {
  const boundary = time(periodStart);
  const published = time(candidate.newestPublishedAt);
  const observed = Math.max(time(candidate.newestObservedAt), time(candidate.story.changedAt));

  // Package and repository release history is useful evidence, but observing an old
  // release for the first time does not make it a development from today.
  if (candidate.seriesKeys.length > 0) return published >= boundary;

  // A monitored page establishes a baseline on first read. It becomes a current
  // development after a later change. A baseline tied to a standing Mission is
  // also useful now, but an unlinked monitor should not fill Today by itself.
  if (candidate.monitorSnapshot) {
    if (candidate.missionIds.length > 0 && observed >= boundary) return true;
    return candidate.story.change.kind === "changed"
      && Boolean(candidate.story.change.previousBriefingAt)
      && observed >= boundary;
  }

  return Math.max(published, observed) >= boundary;
}

function isMeaningful(candidate: StoryCurationCandidate, periodStart: string): boolean {
  if (candidate.story.change.kind === "recurring" && candidate.story.change.newEvidenceCount <= 0) return false;
  if (candidate.independentFamilies >= 2 && time(candidate.newestObservedAt) >= time(periodStart)) return true;
  if (candidate.missionIds.length === 0 && candidate.story.relevance < 0.5) return false;
  return isFresh(candidate, periodStart);
}

function compareCandidates(left: StoryCurationCandidate, right: StoryCurationCandidate): number {
  const leftMission = left.missionIds.length > 0 ? 1 : 0;
  const rightMission = right.missionIds.length > 0 ? 1 : 0;
  return rightMission - leftMission
    || right.missionMatchScore - left.missionMatchScore
    || right.independentFamilies - left.independentFamilies
    || right.story.importance - left.story.importance
    || right.story.score - left.story.score
    || time(right.newestPublishedAt || right.newestObservedAt || right.story.changedAt)
      - time(left.newestPublishedAt || left.newestObservedAt || left.story.changedAt)
    || left.story.id.localeCompare(right.story.id);
}

function increment(counts: Map<string, number>, keys: string[]): void {
  for (const key of new Set(keys.filter(Boolean))) counts.set(key, (counts.get(key) ?? 0) + 1);
}

function withinCap(counts: Map<string, number>, keys: string[], cap: number): boolean {
  return [...new Set(keys.filter(Boolean))].every((key) => (counts.get(key) ?? 0) < cap);
}

/**
 * Selects a finite, diverse current view without deleting or mutating Story memory.
 * A quiet result is intentional: the selector never fills space with old release
 * history or an unchanged monitor baseline.
 */
export function selectTodayStories(
  candidates: StoryCurationCandidate[],
  options: { limit: number; periodStart: string },
): StoryCurationResult {
  const limit = Math.max(1, Math.min(30, Math.floor(options.limit)));
  const eligible = candidates.filter((candidate) => isMeaningful(candidate, options.periodStart)).sort(compareCandidates);
  const selected: StoryCurationCandidate[] = [];
  const selectedIds = new Set<string>();
  const sourceCounts = new Map<string, number>();
  const providerCounts = new Map<string, number>();
  const seriesCounts = new Map<string, number>();

  const take = (candidate: StoryCurationCandidate, missionPass = false): boolean => {
    if (selected.length >= limit || selectedIds.has(candidate.story.id)) return false;
    if (!withinCap(seriesCounts, candidate.seriesKeys, 1)) return false;
    if (!withinCap(sourceCounts, candidate.sourceKeys, missionPass ? 3 : 2)) return false;
    if (!withinCap(providerCounts, candidate.providerKeys, missionPass ? 4 : 3)) return false;
    selected.push(candidate);
    selectedIds.add(candidate.story.id);
    increment(sourceCounts, candidate.sourceKeys);
    increment(providerCounts, candidate.providerKeys);
    increment(seriesCounts, candidate.seriesKeys);
    return true;
  };

  // Give each standing question one chance to lead with its best current change.
  const missionIds = [...new Set(eligible.flatMap((candidate) => candidate.missionIds))].sort();
  for (const missionId of missionIds) {
    const best = eligible.find((candidate) => candidate.missionIds.includes(missionId) && !selectedIds.has(candidate.story.id));
    if (best) take(best, true);
  }

  for (const candidate of eligible) take(candidate);

  return {
    stories: selected.map((candidate) => candidate.story),
    selectedIds: selected.map((candidate) => candidate.story.id),
    filedCount: Math.max(0, candidates.length - selected.length),
  };
}
