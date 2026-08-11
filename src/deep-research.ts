import {
  getMission,
  getMissionOperator,
  getMissionResearchState,
} from "./db";
import {
  loadMissionComputerPeripheralSnapshot,
  type MissionComputerPeripheralSnapshot,
} from "./mission-computer-inputs";
import { loadMissionMatchSnapshot, type MissionMatchSnapshot } from "./mission-snapshot";
import type { Env, MissionOperatorRecord } from "./types";
import { deepResearchResultContract } from "./research-results";
import { excerpt, isoNow, parseJson } from "./utils";

export interface DeepResearchSource {
  title: string;
  url: string;
  domain: string;
  source: string;
  storyId: string;
  publishedAt?: string;
}

export interface DeepResearchHandoff {
  schemaVersion: "1";
  preparedAt: string;
  mission: {
    id: string;
    name: string;
    question: string;
    status: string;
    mode: string;
    researchPolicy: string;
    alertThreshold: number;
    expectedNextEvent: string;
    expectedBy: string | null;
    outcomeStatus: string;
    outcomeSummary: string;
    sprintPolicy: string;
    expectedEventStatus: string;
  };
  researchBaseline: {
    currentThesis: string;
    reportSummary: string;
    openQuestions: string[];
    reportTitle: string;
    reportUrl: string | null;
    confidence: number | null;
    lastResearchAt: string | null;
  };
  recommendation: {
    shouldEscalate: boolean;
    score: number;
    reasons: string[];
    whyNow: string;
  };
  currentState: Array<{
    storyId: string;
    title: string;
    summary: string;
    changedAt: string;
    score: number;
    confidence: number;
    sourceCount: number;
    missionMatch: number;
  }>;
  sourceUrls: DeepResearchSource[];
  preferredDomains: string[];
  coverageGaps: string[];
  researchPlan: string[];
  prompt: string;
}

interface DeepResearchHandoffContext {
  mission: NonNullable<Awaited<ReturnType<typeof getMission>>>;
  operatorRow: Awaited<ReturnType<typeof getMissionOperator>>;
  researchState: Awaited<ReturnType<typeof getMissionResearchState>>;
  matches: MissionMatchSnapshot;
  runs: MissionComputerPeripheralSnapshot["runs"];
  events: MissionComputerPeripheralSnapshot["events"];
  sourceHealth: MissionComputerPeripheralSnapshot["sourceHealth"];
}

function defaultOperator(missionId: string): MissionOperatorRecord {
  return {
    mission_id: missionId,
    mode: "watch",
    research_policy: "suggest",
    alert_threshold: 0.65,
    expected_next_event: "",
    expected_by: null,
    outcome_status: "open",
    outcome_summary: "",
    resolved_at: null,
    last_escalated_at: null,
    sprint_policy: "manual",
    next_sprint_at: null,
    last_sprint_at: null,
    reminder_lead_days: 3,
    expected_event_status: "none",
    updated_at: isoNow(),
  };
}

function domainFor(value: string): string | undefined {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function daysSince(value: string | null | undefined): number {
  if (!value) return 999;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 86_400_000) : 999;
}

export async function buildDeepResearchHandoff(env: Env, missionId: string): Promise<DeepResearchHandoff> {
  const mission = await getMission(env.DB, missionId);
  if (!mission) throw new Error(`Mission not found: ${missionId}`);
  const [operatorRow, researchState] = await Promise.all([
    getMissionOperator(env.DB, missionId),
    getMissionResearchState(env.DB, missionId),
  ]);
  const [matches, peripheralSnapshot] = await Promise.all([
    loadMissionMatchSnapshot(env.DB, missionId, {
      matchLimit: 20,
      evidencePerStoryLimit: 12,
      evidenceItemLimit: 48,
      evidenceExcerptCharacters: 1,
    }),
    loadMissionComputerPeripheralSnapshot(env.DB, missionId),
  ]);
  return buildDeepResearchHandoffFromSnapshot({
    mission,
    operatorRow,
    researchState,
    matches,
    runs: peripheralSnapshot.runs.slice(0, 5),
    events: peripheralSnapshot.events,
    sourceHealth: peripheralSnapshot.sourceHealth,
  });
}

export function buildDeepResearchHandoffFromSnapshot(
  input: DeepResearchHandoffContext,
): DeepResearchHandoff {
  const { mission, researchState, matches: snapshot, runs, events, sourceHealth } = input;
  const operator = input.operatorRow ?? defaultOperator(mission.id);
  const currentState: DeepResearchHandoff["currentState"] = [];
  const sources = new Map<string, DeepResearchSource>();

  for (const match of snapshot.matches.slice(0, 12)) {
    const storyId = String(match.story_id ?? "");
    if (!storyId || !snapshot.firstSeenAtByStory.has(storyId)) continue;
    currentState.push({
      storyId,
      title: String(match.title ?? ""),
      summary: String(match.summary ?? ""),
      changedAt: String(match.last_changed_at ?? ""),
      score: Number(match.score ?? 0),
      confidence: Number(match.confidence ?? 0),
      sourceCount: Number(match.source_count ?? 0),
      missionMatch: Number(match.match_score ?? 0),
    });
    for (const item of (snapshot.evidenceByStory.get(storyId) ?? []).slice(0, 12)) {
      if (!item.url) continue;
      const domain = domainFor(item.url);
      if (!domain) continue;
      const canonical = item.url.split("#")[0] ?? item.url;
      if (sources.has(canonical)) continue;
      sources.set(canonical, {
        title: item.title,
        url: canonical,
        domain,
        source: item.source_name,
        storyId,
        publishedAt: item.published_at ?? item.observed_at,
      });
    }
  }

  const sourceUrls = [...sources.values()].slice(0, 80);
  const preferredDomains = [...new Set(sourceUrls.map((source) => source.domain))].slice(0, 30);
  const degraded = sourceHealth.filter((source) => Number(source.enabled ?? 1) === 1 && Number(source.health_score ?? 0) < 0.65);
  const primaryLike = sourceUrls.filter((source) => /(github\.com|arxiv\.org|openalex\.org|sec\.gov|gov|edu|docs\.|developer|developers\.)/i.test(source.domain));
  const coverageGaps: string[] = [];
  if (sourceUrls.length < 5) coverageGaps.push("The Mission has fewer than five linked evidence sources.");
  if (preferredDomains.length < 3) coverageGaps.push("Evidence is concentrated in fewer than three independent domains.");
  if (primaryLike.length === 0) coverageGaps.push("No obvious primary or first-party source is present in the current evidence set.");
  if (degraded.length > 0) coverageGaps.push(`${degraded.length} configured source${degraded.length === 1 ? " is" : "s are"} currently degraded.`);
  if (currentState.length === 0) coverageGaps.push("No Story currently clears the Mission match threshold.");
  if (snapshot.coverage.hasMoreEvidence || snapshot.coverage.hasMoreMatchedStories) {
    coverageGaps.push("Additional matched material sits outside this snapshot.");
  }

  const latest = currentState[0];
  const newestDays = currentState.length ? Math.min(...currentState.map((story) => daysSince(story.changedAt))) : 999;
  const topMatch = currentState.reduce((maximum, story) => Math.max(maximum, story.missionMatch), 0);
  const sourceDiversity = Math.min(1, preferredDomains.length / 6);
  const recency = Math.max(0, 1 - newestDays / 14);
  const evidenceDepth = Math.min(1, sourceUrls.length / 20);
  const expectedSoon = operator.expected_by ? Math.max(0, 1 - Math.abs(Date.parse(operator.expected_by) - Date.now()) / (14 * 86_400_000)) : 0;
  const score = Math.round(Math.min(1, topMatch * 0.35 + sourceDiversity * 0.2 + recency * 0.25 + evidenceDepth * 0.15 + expectedSoon * 0.05) * 1000) / 1000;
  const reasons: string[] = [];
  if (newestDays <= 3) reasons.push("A matched Story changed within the last three days.");
  if (preferredDomains.length >= 4) reasons.push("Evidence spans at least four domains.");
  if (sourceUrls.length >= 12) reasons.push("The current evidence set is deep enough for synthesis rather than simple monitoring.");
  if (operator.expected_next_event) reasons.push(`The Mission is waiting for: ${operator.expected_next_event}`);
  if (operator.outcome_status !== "open") reasons.push(`The Mission outcome is marked ${operator.outcome_status} and may need verification.`);
  if (events.some((event) => event.event_type === "signal" && daysSince(event.occurred_at) <= 7)) reasons.push("A material signal was recorded in the Mission ledger this week.");
  if (runs[0]?.status === "partial" || runs[0]?.status === "failed") reasons.push("The latest Mission Sprint had incomplete source coverage.");
  const threshold = operator.alert_threshold || 0.65;
  const shouldEscalate = operator.outcome_status === "open" && (
    operator.research_policy === "always" ||
    (operator.research_policy === "suggest" && score >= threshold)
  );
  const whyNow = reasons[0] ?? (latest ? `The newest matched Story is “${latest.title}”.` : "The Mission needs more evidence before escalation.");

  if (researchState?.last_research_at) {
    const changesSinceResearch = currentState.filter((story) => Date.parse(story.changedAt) > Date.parse(researchState.last_research_at ?? "")).length;
    if (changesSinceResearch > 0) reasons.push(`${changesSinceResearch} matched ${changesSinceResearch === 1 ? "Story changed" : "Stories changed"} since the saved research baseline.`);
  }

  const researchPlan = [
    `Answer the standing question: ${mission.question || mission.name}`,
    "Start from the Driftglass evidence set, then verify the most consequential claims against primary sources.",
    "Identify what changed since the most recent matched Story and what remains unchanged.",
    "Resolve contradictions, corrections, and differences in definitions or time periods.",
    operator.expected_next_event ? `Assess whether the expected next event is still the right watchpoint: ${operator.expected_next_event}` : "Identify the next observable event that would materially update the answer.",
    "Return a decision-ready answer, confidence, strongest evidence, unresolved gaps, and the next watchpoint.",
  ];
  const sitesLine = preferredDomains.length
    ? `Prioritize these domains because Driftglass has already linked relevant evidence there: ${preferredDomains.join(", ")}.`
    : "Search the public web for primary and independent sources.";
  const resultContract = JSON.stringify(deepResearchResultContract(), null, 2);
  const baselineLine = researchState?.current_thesis
    ? `Saved thesis from ${researchState.last_research_at ?? "the previous research run"}: ${researchState.current_thesis}`
    : "No saved Deep Research thesis exists yet.";
  const prompt = `Use Deep Research to investigate this persistent Driftglass Mission.\n\nMission: ${mission.name}\nStanding question: ${mission.question || mission.name}\nMode: ${operator.mode}\nCurrent outcome: ${operator.outcome_status}${operator.outcome_summary ? ` — ${operator.outcome_summary}` : ""}\nExpected next event: ${operator.expected_next_event || "not set"}${operator.expected_by ? ` by ${operator.expected_by}` : ""}\n\n${sitesLine}\n\nUse the connected Driftglass app to call get_research_mission, prepare_deep_research, fetch, and get_story_graph as needed. Treat Driftglass as the longitudinal memory and source map, not as the final authority. Verify important claims against original sources.\n\nDeliver:\n1. Direct answer to the standing question.\n2. What materially changed since the prior state.\n3. Evidence that strengthens or weakens the leading interpretation.\n4. Contradictions, missing primary evidence, and access limitations.\n5. Confidence and the next expected event or decision trigger.\n6. A concise update suitable for writing back to the Mission ledger.

At the very end, include a fenced JSON block labelled DRIFTGLASS_RESULT using exactly this shape. Keep confidence between 0 and 1, use null for an absent report URL or date, and leave outcomeStatus as open unless the standing question is genuinely resolved, invalidated, or superseded:

${resultContract}`;

  return {
    schemaVersion: "1",
    preparedAt: isoNow(),
    mission: {
      id: mission.id,
      name: mission.name,
      question: mission.question,
      status: mission.status,
      mode: operator.mode,
      researchPolicy: operator.research_policy,
      alertThreshold: operator.alert_threshold,
      expectedNextEvent: operator.expected_next_event,
      expectedBy: operator.expected_by,
      outcomeStatus: operator.outcome_status,
      outcomeSummary: operator.outcome_summary,
      sprintPolicy: operator.sprint_policy,
      expectedEventStatus: operator.expected_event_status,
    },
    researchBaseline: {
      currentThesis: researchState?.current_thesis ?? "",
      reportSummary: researchState?.report_summary ?? "",
      openQuestions: parseJson<string[]>(researchState?.open_questions_json ?? "[]", []),
      reportTitle: researchState?.report_title ?? "",
      reportUrl: researchState?.report_url ?? null,
      confidence: researchState?.confidence ?? null,
      lastResearchAt: researchState?.last_research_at ?? null,
    },
    recommendation: { shouldEscalate, score, reasons, whyNow },
    currentState,
    sourceUrls,
    preferredDomains,
    coverageGaps,
    researchPlan,
    prompt,
  };
}

export function deepResearchMarkdown(handoff: DeepResearchHandoff): string {
  const lines = [
    `# Deep Research handoff · ${handoff.mission.name}`,
    "",
    `Prepared: ${handoff.preparedAt}`,
    `Standing question: ${handoff.mission.question}`,
    `Mode: ${handoff.mission.mode}`,
    `Recommendation: ${handoff.recommendation.shouldEscalate ? "Run Deep Research" : "Continue monitoring"} · score ${handoff.recommendation.score.toFixed(2)}`,
    `Why now: ${handoff.recommendation.whyNow}`,
    "",
    "## Research plan",
    ...handoff.researchPlan.map((step) => `- ${step}`),
    "",
    "## Saved research baseline",
    handoff.researchBaseline.currentThesis || "No saved thesis yet.",
    handoff.researchBaseline.reportSummary ? `Previous report summary: ${handoff.researchBaseline.reportSummary}` : "",
    handoff.researchBaseline.openQuestions.length ? `Open questions: ${handoff.researchBaseline.openQuestions.join(" · ")}` : "",
    "",
    "## Current state",
    ...handoff.currentState.map((story) => `- ${story.title} — ${excerpt(story.summary, 360)} (${story.sourceCount} sources; changed ${story.changedAt})`),
    "",
    "## Coverage gaps",
    ...(handoff.coverageGaps.length ? handoff.coverageGaps.map((gap) => `- ${gap}`) : ["- No obvious structural coverage gap detected."]),
    "",
    "## Source URLs",
    ...handoff.sourceUrls.map((source) => `- ${source.source}: ${source.title} — ${source.url}`),
    "",
    "## Prompt",
    "",
    handoff.prompt,
    "",
  ];
  return `${lines.join("\n")}\n`;
}
