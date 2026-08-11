import {
  getMission,
  listMissionMatchCandidateStories,
  listMissionMatchEvidenceExcerpts,
  listMissionMatchStoryProjections,
  listMissions,
  MISSION_MATCH_PERSISTED_TERM_CHARACTERS,
  MISSION_MATCH_PERSISTED_TERM_LIMIT,
  MISSION_MATCH_EXCERPT_BODY_CHARACTERS,
  MISSION_MATCH_EXCERPT_EVIDENCE_PER_STORY_LIMIT,
  MISSION_MATCH_EXCERPT_STORY_PAGE_LIMIT,
  MISSION_MATCH_EXCERPT_TITLE_CHARACTERS,
  recordMissionMatch,
  projectPersistedMissionMatchTerms,
  replaceMissionStoryMatches,
} from "./db";
import { tokenize } from "./scoring";
import { requireBudget } from "./budget";
import type { Env, MissionRecord, StoryRecord } from "./types";
import { clamp, isoNow, normalizeStringArray, parseJson } from "./utils";

export const MISSION_MATCH_REBUILD_STORY_LIMIT = 500;
export const MISSION_MATCH_REBUILD_STORY_SENTINEL_LIMIT = MISSION_MATCH_REBUILD_STORY_LIMIT + 1;
export const MISSION_MATCH_REBUILD_STORY_PAGE_SIZE = MISSION_MATCH_EXCERPT_STORY_PAGE_LIMIT;
export const MISSION_MATCH_PAGE_D1_STATEMENT_LIMIT = MISSION_MATCH_REBUILD_STORY_PAGE_SIZE + 2;
// One match plan, one match commit, and three Computer load/render/commit calls
// surround the independently bounded Story pages.
export const MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_BASE = Math.ceil(
  MISSION_MATCH_REBUILD_STORY_LIMIT / MISSION_MATCH_REBUILD_STORY_PAGE_SIZE,
) + 5;
export const MISSION_MATCH_MAINTENANCE_RETRY_PAGE_LIMIT = 3;
export const MISSION_MATCH_MAINTENANCE_RETRY_COMPUTER_COMMIT_LIMIT = 1;
export const MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_LIMIT = 1_000;
export const MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_WORST_CASE =
  MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_BASE
  + MISSION_MATCH_MAINTENANCE_RETRY_PAGE_LIMIT
  + MISSION_MATCH_MAINTENANCE_RETRY_COMPUTER_COMMIT_LIMIT;
export const MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_RESERVE =
  MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_LIMIT
  - MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_WORST_CASE;
export const MISSION_MATCH_MAINTENANCE_WORKFLOW_STEP_RESERVATION =
  // Cloudflare bills successful Workflow steps; retry attempts are excluded.
  MISSION_MATCH_MAINTENANCE_INTERNAL_SUBREQUEST_BASE;
export const MISSION_MATCH_EVIDENCE_PER_STORY_LIMIT = MISSION_MATCH_EXCERPT_EVIDENCE_PER_STORY_LIMIT;
export const MISSION_MATCH_EVIDENCE_TITLE_CHARACTERS = MISSION_MATCH_EXCERPT_TITLE_CHARACTERS;
export const MISSION_MATCH_EVIDENCE_BODY_CHARACTERS = MISSION_MATCH_EXCERPT_BODY_CHARACTERS;
export const MISSION_MATCH_STORY_SUMMARY_CHARACTERS = 700;
export const MISSION_MATCH_QUESTION_CHARACTERS = 1_000;
export const MISSION_MATCH_SOURCE_VALUE_CHARACTERS = 200;
export const MISSION_MATCH_SCOPE_LIMIT = 100;
export const MISSION_MATCH_PAGE_TEXT_CHARACTER_LIMIT = MISSION_MATCH_REBUILD_STORY_PAGE_SIZE * (
  MISSION_MATCH_EVIDENCE_TITLE_CHARACTERS
  + MISSION_MATCH_STORY_SUMMARY_CHARACTERS
  + MISSION_MATCH_EVIDENCE_PER_STORY_LIMIT * (
    MISSION_MATCH_EVIDENCE_TITLE_CHARACTERS + MISSION_MATCH_EVIDENCE_BODY_CHARACTERS
  )
);

export const MISSION_MATCH_TERM_LIMIT = 100;
export const MISSION_MATCH_TERM_CHARACTERS = 200;

function prefixCharacters(value: string, limit: number): string {
  let result = "";
  let count = 0;
  for (const character of value) {
    if (count >= limit) break;
    result += character;
    count += 1;
  }
  return result;
}

function withinCharacterLimit(value: string, limit: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > limit) return false;
  }
  return true;
}

function missionTermSelection(mission: MissionRecord): { terms: string[]; ignored: number } {
  const configured = normalizeStringArray(parseJson<unknown>(mission.terms_json, []));
  if (configured.length > 0) {
    const eligible = configured.filter((term) => withinCharacterLimit(term, MISSION_MATCH_TERM_CHARACTERS));
    const terms = eligible.slice(0, MISSION_MATCH_TERM_LIMIT);
    return { terms, ignored: configured.length - terms.length };
  }
  const fallbackText = `${prefixCharacters(mission.name, 180)} ${prefixCharacters(
    mission.question,
    MISSION_MATCH_QUESTION_CHARACTERS,
  )}`;
  const fallback = [...new Set(tokenize(fallbackText))];
  const eligible = fallback.filter((term) => withinCharacterLimit(term, MISSION_MATCH_TERM_CHARACTERS));
  return {
    terms: eligible.slice(0, 24),
    ignored: fallback.length - Math.min(eligible.length, 24),
  };
}

function missionScopeSelection(mission: MissionRecord): { scope: string[]; ignored: number } {
  const configured = normalizeStringArray(parseJson<unknown>(mission.source_scope_json, []));
  const eligible = configured.filter((value) => withinCharacterLimit(value, MISSION_MATCH_SOURCE_VALUE_CHARACTERS));
  const scope = eligible.slice(0, MISSION_MATCH_SCOPE_LIMIT).map((value) => value.toLowerCase());
  return { scope, ignored: configured.length - scope.length };
}

export interface MissionMatchDefinition {
  priority: number;
  terms: string[];
  scope: string[];
  questionTokens: string[];
  ignoredMissionTerms: number;
  ignoredMissionScopeValues: number;
  questionTruncated: boolean;
}

function missionMatchDefinition(mission: MissionRecord): MissionMatchDefinition {
  const termSelection = missionTermSelection(mission);
  const scopeSelection = missionScopeSelection(mission);
  const question = prefixCharacters(mission.question, MISSION_MATCH_QUESTION_CHARACTERS);
  return {
    priority: mission.priority,
    terms: termSelection.terms,
    scope: scopeSelection.scope,
    questionTokens: [...new Set(tokenize(question))],
    ignoredMissionTerms: termSelection.ignored,
    ignoredMissionScopeValues: scopeSelection.ignored,
    questionTruncated: !withinCharacterLimit(mission.question, MISSION_MATCH_QUESTION_CHARACTERS),
  };
}

interface CompiledMissionMatcher {
  definition: MissionMatchDefinition;
  termNodes: MissionTermNode[];
  questionTokens: Set<string>;
  allTermMask: bigint;
}

interface MissionTermNode {
  next: Map<string, number>;
  failure: number;
  outputMask: bigint;
}

interface MissionMatchAccumulator {
  matchedTermMask: bigint;
  matchedQuestionTokens: Set<string>;
  sourceIds: Set<string>;
  sourceKinds: Set<string>;
  termState: number;
}

function compileMissionTermNodes(terms: string[]): MissionTermNode[] {
  const nodes: MissionTermNode[] = [{ next: new Map(), failure: 0, outputMask: 0n }];
  for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
    let state = 0;
    for (const character of terms[termIndex]!.toLowerCase()) {
      const existing = nodes[state]!.next.get(character);
      if (existing !== undefined) {
        state = existing;
        continue;
      }
      const next = nodes.length;
      nodes[state]!.next.set(character, next);
      nodes.push({ next: new Map(), failure: 0, outputMask: 0n });
      state = next;
    }
    nodes[state]!.outputMask |= 1n << BigInt(termIndex);
  }

  const queue = [...nodes[0]!.next.values()];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor]!;
    for (const [character, next] of nodes[state]!.next) {
      queue.push(next);
      let failure = nodes[state]!.failure;
      while (failure !== 0 && !nodes[failure]!.next.has(character)) {
        failure = nodes[failure]!.failure;
      }
      nodes[next]!.failure = nodes[failure]!.next.get(character) ?? 0;
      nodes[next]!.outputMask |= nodes[nodes[next]!.failure]!.outputMask;
    }
  }
  return nodes;
}

function compileMissionMatcher(definition: MissionMatchDefinition): CompiledMissionMatcher {
  return {
    definition,
    termNodes: compileMissionTermNodes(definition.terms),
    questionTokens: new Set(definition.questionTokens),
    allTermMask: definition.terms.length > 0 ? (1n << BigInt(definition.terms.length)) - 1n : 0n,
  };
}

function createMissionMatchAccumulator(): MissionMatchAccumulator {
  return {
    matchedTermMask: 0n,
    matchedQuestionTokens: new Set(),
    sourceIds: new Set(),
    sourceKinds: new Set(),
    termState: 0,
  };
}

function appendMissionMatchText(
  matcher: CompiledMissionMatcher,
  accumulator: MissionMatchAccumulator,
  value: string,
): void {
  if (accumulator.matchedTermMask !== matcher.allTermMask) {
    let state = accumulator.termState;
    for (const character of value.toLowerCase()) {
      while (state !== 0 && !matcher.termNodes[state]!.next.has(character)) {
        state = matcher.termNodes[state]!.failure;
      }
      state = matcher.termNodes[state]!.next.get(character) ?? 0;
      accumulator.matchedTermMask |= matcher.termNodes[state]!.outputMask;
      if (accumulator.matchedTermMask === matcher.allTermMask) {
        state = 0;
        break;
      }
    }
    accumulator.termState = state;
  }
  if (
    matcher.questionTokens.size > 0
    && accumulator.matchedQuestionTokens.size < matcher.questionTokens.size
  ) {
    for (const token of tokenize(value)) {
      if (matcher.questionTokens.has(token)) accumulator.matchedQuestionTokens.add(token);
    }
  }
}

function finishMissionMatch(
  matcher: CompiledMissionMatcher,
  accumulator: MissionMatchAccumulator,
): { score: number; matchedTerms: string[]; matchedTermIndexes: number[] } {
  const matchedTermIndexes = matcher.definition.terms.flatMap(
    (_term, index) => (accumulator.matchedTermMask & (1n << BigInt(index))) !== 0n ? [index] : [],
  );
  const matchedTerms = matchedTermIndexes.map((index) => matcher.definition.terms[index]!);
  const sourceValues = [...accumulator.sourceIds, ...accumulator.sourceKinds].map((value) => value.toLowerCase());
  const scopeMatched = matcher.definition.scope.length === 0
    || matcher.definition.scope.some((value) => sourceValues.includes(value));
  if (!scopeMatched || matcher.definition.terms.length === 0) {
    return { score: 0, matchedTerms: [], matchedTermIndexes: [] };
  }

  const coverage = matchedTerms.length / Math.min(matcher.definition.terms.length, 8);
  const phraseBoost = matchedTerms.some((term) => term.includes(" ")) ? 0.2 : 0;
  const questionCoverage = matcher.questionTokens.size
    ? accumulator.matchedQuestionTokens.size / matcher.questionTokens.size
    : 0;
  const score = clamp(coverage * 0.65 + questionCoverage * 0.25 + phraseBoost)
    * Math.min(1.25, matcher.definition.priority);
  return {
    score: Math.round(clamp(score) * 1000) / 1000,
    matchedTerms,
    matchedTermIndexes,
  };
}

export function scoreMissionMatch(
  mission: MissionRecord,
  input: { text: string; sourceIds?: string[]; sourceKinds?: string[] },
): { score: number; matchedTerms: string[] } {
  const matcher = compileMissionMatcher(missionMatchDefinition(mission));
  const accumulator = createMissionMatchAccumulator();
  appendMissionMatchText(matcher, accumulator, input.text);
  for (const sourceId of input.sourceIds ?? []) accumulator.sourceIds.add(sourceId);
  for (const sourceKind of input.sourceKinds ?? []) accumulator.sourceKinds.add(sourceKind);
  const result = finishMissionMatch(matcher, accumulator);
  return { score: result.score, matchedTerms: result.matchedTerms };
}

export async function matchStoryToMissions(
  env: Env,
  input: {
    story: StoryRecord;
    itemText?: string;
    sourceId?: string;
    sourceKind?: string;
  },
): Promise<void> {
  const missions = await listMissions(env.DB, "active");
  if (missions.length === 0) return;
  const text = `${prefixCharacters(input.story.title, MISSION_MATCH_EVIDENCE_TITLE_CHARACTERS)}\n`
    + `${prefixCharacters(input.story.summary, MISSION_MATCH_STORY_SUMMARY_CHARACTERS)}\n`
    + `${prefixCharacters(input.itemText ?? "", MISSION_MATCH_EVIDENCE_BODY_CHARACTERS)}`;
  for (const mission of missions) {
    const result = scoreMissionMatch(mission, {
      text,
      sourceIds: input.sourceId ? [prefixCharacters(input.sourceId, MISSION_MATCH_SOURCE_VALUE_CHARACTERS)] : [],
      sourceKinds: input.sourceKind ? [prefixCharacters(input.sourceKind, MISSION_MATCH_SOURCE_VALUE_CHARACTERS)] : [],
    });
    if (result.score < 0.2 || result.matchedTerms.length === 0) continue;
    await recordMissionMatch(env.DB, {
      missionId: mission.id,
      storyId: input.story.id,
      matchScore: result.score,
      matchedTerms: result.matchedTerms,
    });
  }
}

export interface MissionMatchRebuildPlan {
  missionId: string;
  missionUpdatedAt: string;
  rebuildWatermark: string;
  storyIds: string[];
  storyWindowHasMore: boolean;
}

export interface MissionMatchPageResult {
  storyIds: string[];
  matches: Array<{ storyId: string; matchScore: number; matchedTermIndexes: number[] }>;
  coverage: {
    evidenceItemsConsidered: number;
    storiesWithAdditionalEvidence: number;
    excerptedBodies: number;
  };
}

export interface MissionMatchRebuildCoverage {
  partial: boolean;
  storyLimit: number;
  storyWindowHasMore: boolean;
  storyPageSize: number;
  pageTextCharacterLimit: number;
  evidencePerStoryLimit: number;
  evidenceTitleCharacters: number;
  evidenceBodyCharacters: number;
  questionCharacters: number;
  missionTermLimit: number;
  missionTermCharacters: number;
  persistedMatchedTermLimit: number;
  persistedMatchedTermCharacters: number;
  persistedMatchedTermsOmitted: number;
  ignoredMissionTerms: number;
  ignoredMissionScopeValues: number;
  questionTruncated: boolean;
  evidenceItemsConsidered: number;
  storiesWithAdditionalEvidence: number;
  excerptedBodies: number;
}

export interface MissionMatchRebuildResult {
  matchedStories: number;
  evaluatedStories: number;
  executionComplete: true;
  continuation: null;
  coverage: MissionMatchRebuildCoverage;
}

export async function planMissionMatchRebuild(
  env: Env,
  missionId: string,
): Promise<MissionMatchRebuildPlan> {
  const rebuildWatermark = isoNow();
  const [mission, stories] = await Promise.all([
    getMission(env.DB, missionId),
    listMissionMatchCandidateStories(env.DB, MISSION_MATCH_REBUILD_STORY_SENTINEL_LIMIT),
  ]);
  if (!mission) throw new Error(`Mission not found: ${missionId}`);
  return {
    missionId,
    missionUpdatedAt: mission.updated_at,
    rebuildWatermark,
    storyIds: stories.slice(0, MISSION_MATCH_REBUILD_STORY_LIMIT).map((story) => story.id),
    storyWindowHasMore: stories.length > MISSION_MATCH_REBUILD_STORY_LIMIT,
  };
}

export async function evaluateMissionMatchPage(
  env: Env,
  input: Pick<MissionMatchRebuildPlan, "missionId" | "missionUpdatedAt"> & { storyIds: string[] },
): Promise<MissionMatchPageResult> {
  const storyIds = [...new Set(input.storyIds)];
  if (!storyIds.length || storyIds.length > MISSION_MATCH_REBUILD_STORY_PAGE_SIZE) {
    throw new Error(`Mission match page must contain 1-${MISSION_MATCH_REBUILD_STORY_PAGE_SIZE} Stories`);
  }
  const mission = await getMission(env.DB, input.missionId);
  if (!mission) throw new Error(`Mission not found: ${input.missionId}`);
  if (mission.updated_at !== input.missionUpdatedAt) {
    throw new Error("Mission changed during match rebuild; the stale plan was not committed");
  }
  const matcher = compileMissionMatcher(missionMatchDefinition(mission));
  const stories = await listMissionMatchStoryProjections(env.DB, storyIds);
  const storyById = new Map(stories.map((story) => [story.id, story] as const));
  const evidenceByStory: Array<{
    storyId: string;
    result: Awaited<ReturnType<typeof listMissionMatchEvidenceExcerpts>>;
  }> = [];
  for (const storyId of storyIds) {
    evidenceByStory.push({
      storyId,
      result: await listMissionMatchEvidenceExcerpts(env.DB, {
      storyId,
      evidencePerStory: MISSION_MATCH_EVIDENCE_PER_STORY_LIMIT,
      titleCharacters: MISSION_MATCH_EVIDENCE_TITLE_CHARACTERS,
      bodyCharacters: MISSION_MATCH_EVIDENCE_BODY_CHARACTERS,
      }),
    });
  }
  const matches: MissionMatchPageResult["matches"] = [];
  let evidenceItemsConsidered = 0;
  let storiesWithAdditionalEvidence = 0;
  let excerptedBodies = 0;

  for (const { storyId, result: evidenceResult } of evidenceByStory) {
    const story = storyById.get(storyId);
    if (!story) continue;
    const accumulator = createMissionMatchAccumulator();
    appendMissionMatchText(matcher, accumulator, `${story.title}\n${story.summary}\n`);
    for (const item of evidenceResult.evidence) {
      appendMissionMatchText(matcher, accumulator, `\n${item.title}\n${item.text}`);
      accumulator.sourceIds.add(item.source_id);
      if (typeof item.source_kind === "string") accumulator.sourceKinds.add(item.source_kind);
      evidenceItemsConsidered += 1;
      if (item.body_truncated) excerptedBodies += 1;
    }
    if (evidenceResult.hasAdditionalEvidence) storiesWithAdditionalEvidence += 1;
    const result = finishMissionMatch(matcher, accumulator);
    if (result.score < 0.2 || result.matchedTermIndexes.length === 0) continue;
    matches.push({
      storyId,
      matchScore: result.score,
      matchedTermIndexes: result.matchedTermIndexes,
    });
  }

  return {
    storyIds,
    matches,
    coverage: { evidenceItemsConsidered, storiesWithAdditionalEvidence, excerptedBodies },
  };
}

export async function commitMissionMatchRebuild(
  env: Env,
  plan: MissionMatchRebuildPlan,
  pages: MissionMatchPageResult[],
): Promise<MissionMatchRebuildResult> {
  const pageCounts = new Map<string, number>();
  for (const page of pages) {
    for (const storyId of page.storyIds) pageCounts.set(storyId, (pageCounts.get(storyId) ?? 0) + 1);
  }
  if (
    pageCounts.size !== plan.storyIds.length
    || plan.storyIds.some((storyId) => pageCounts.get(storyId) !== 1)
  ) {
    throw new Error("Mission match rebuild cannot commit an incomplete or overlapping Story plan");
  }
  const mission = await getMission(env.DB, plan.missionId);
  if (!mission || mission.updated_at !== plan.missionUpdatedAt) {
    throw new Error("Mission changed during match rebuild; the stale plan was not committed");
  }
  const definition = missionMatchDefinition(mission);
  const storySet = new Set(plan.storyIds);
  let persistedMatchedTermsOmitted = 0;
  const matches = [...new Map(
    pages.flatMap((page) => page.matches)
      .filter((match) => storySet.has(match.storyId))
      .map((match) => [match.storyId, match] as const),
  ).values()].map((match) => {
    const matchedTerms = [...new Set(match.matchedTermIndexes
      .filter((index) => Number.isInteger(index) && index >= 0 && index < definition.terms.length)
      .map((index) => definition.terms[index]!))];
    const persistedTerms = projectPersistedMissionMatchTerms(matchedTerms);
    persistedMatchedTermsOmitted += matchedTerms.length - persistedTerms.length;
    return {
      storyId: match.storyId,
      matchScore: match.matchScore,
      matchedTerms: persistedTerms,
    };
  });
  const committed = await replaceMissionStoryMatches(env.DB, {
    missionId: plan.missionId,
    missionUpdatedAt: plan.missionUpdatedAt,
    rebuildWatermark: plan.rebuildWatermark,
    evaluatedStoryIds: plan.storyIds,
    matches,
  });
  if (!committed) throw new Error("Mission changed during match rebuild; the stale plan was not committed");

  const evidenceItemsConsidered = pages.reduce(
    (total, page) => total + page.coverage.evidenceItemsConsidered,
    0,
  );
  const storiesWithAdditionalEvidence = pages.reduce(
    (total, page) => total + page.coverage.storiesWithAdditionalEvidence,
    0,
  );
  const excerptedBodies = pages.reduce((total, page) => total + page.coverage.excerptedBodies, 0);
  const partial = plan.storyWindowHasMore
    || storiesWithAdditionalEvidence > 0
    || excerptedBodies > 0
    || definition.ignoredMissionTerms > 0
    || definition.ignoredMissionScopeValues > 0
    || definition.questionTruncated
    || persistedMatchedTermsOmitted > 0;
  return {
    matchedStories: matches.length,
    evaluatedStories: plan.storyIds.length,
    executionComplete: true,
    continuation: null,
    coverage: {
      partial,
      storyLimit: MISSION_MATCH_REBUILD_STORY_LIMIT,
      storyWindowHasMore: plan.storyWindowHasMore,
      storyPageSize: MISSION_MATCH_REBUILD_STORY_PAGE_SIZE,
      pageTextCharacterLimit: MISSION_MATCH_PAGE_TEXT_CHARACTER_LIMIT,
      evidencePerStoryLimit: MISSION_MATCH_EVIDENCE_PER_STORY_LIMIT,
      evidenceTitleCharacters: MISSION_MATCH_EVIDENCE_TITLE_CHARACTERS,
      evidenceBodyCharacters: MISSION_MATCH_EVIDENCE_BODY_CHARACTERS,
      questionCharacters: MISSION_MATCH_QUESTION_CHARACTERS,
      missionTermLimit: MISSION_MATCH_TERM_LIMIT,
      missionTermCharacters: MISSION_MATCH_TERM_CHARACTERS,
      persistedMatchedTermLimit: MISSION_MATCH_PERSISTED_TERM_LIMIT,
      persistedMatchedTermCharacters: MISSION_MATCH_PERSISTED_TERM_CHARACTERS,
      persistedMatchedTermsOmitted,
      ignoredMissionTerms: definition.ignoredMissionTerms,
      ignoredMissionScopeValues: definition.ignoredMissionScopeValues,
      questionTruncated: definition.questionTruncated,
      evidenceItemsConsidered,
      storiesWithAdditionalEvidence,
      excerptedBodies,
    },
  };
}

/**
 * Direct orchestration is retained for self-host and tests. Cloudflare callers
 * use the maintenance Workflow so each page gets a fresh D1 and CPU envelope.
 */
export async function rebuildMissionMatchesWithStatus(
  env: Env,
  missionId: string,
  storyLimit = MISSION_MATCH_REBUILD_STORY_LIMIT,
): Promise<MissionMatchRebuildResult> {
  const plan = await planMissionMatchRebuild(env, missionId);
  if (storyLimit < plan.storyIds.length) {
    plan.storyIds = plan.storyIds.slice(0, Math.max(1, Math.floor(storyLimit)));
    plan.storyWindowHasMore = true;
  }
  const pages: MissionMatchPageResult[] = [];
  for (let offset = 0; offset < plan.storyIds.length; offset += MISSION_MATCH_REBUILD_STORY_PAGE_SIZE) {
    pages.push(await evaluateMissionMatchPage(env, {
      missionId: plan.missionId,
      missionUpdatedAt: plan.missionUpdatedAt,
      storyIds: plan.storyIds.slice(offset, offset + MISSION_MATCH_REBUILD_STORY_PAGE_SIZE),
    }));
  }
  return commitMissionMatchRebuild(env, plan, pages);
}

export async function rebuildMissionMatches(
  env: Env,
  missionId: string,
  storyLimit = MISSION_MATCH_REBUILD_STORY_LIMIT,
): Promise<number> {
  const result = await rebuildMissionMatchesWithStatus(env, missionId, storyLimit);
  if (!result.executionComplete || result.continuation !== null) {
    throw new Error("Mission match rebuild did not complete its bounded Story window");
  }
  return result.matchedStories;
}

export interface MissionMatchMaintenanceStart {
  status: "queued";
  workflowId: string;
  missionId: string;
}

export async function startMissionMatchMaintenance(
  env: Env,
  input: { missionId: string; reason: string },
): Promise<MissionMatchMaintenanceStart> {
  if (!env.MISSION_WORKFLOW) throw new Error("Mission Workflow binding is not configured");
  await requireBudget(env.DB, "workflow_steps", MISSION_MATCH_MAINTENANCE_WORKFLOW_STEP_RESERVATION, {
    operation: "mission-match-maintenance",
    missionId: input.missionId,
    reason: prefixCharacters(input.reason, 100),
  });
  const missionPart = input.missionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 36) || "mission";
  const workflowId = `mission-match-${missionPart}-${crypto.randomUUID().slice(0, 12)}`.slice(0, 100);
  const instance = await env.MISSION_WORKFLOW.create({
    id: workflowId,
    params: {
      mode: "match-maintenance",
      missionId: input.missionId,
      reason: prefixCharacters(input.reason, 100),
    },
  });
  return { status: "queued", workflowId: instance.id, missionId: input.missionId };
}
