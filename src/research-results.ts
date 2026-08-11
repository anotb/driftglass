import {
  createResearchResultImport,
  decideResearchResultImport,
  getMission,
  getMissionOperator,
  getMissionResearchState,
  getResearchResultImport,
  listResearchResultImports,
  recordMissionEvent,
  upsertMissionOperator,
  upsertMissionResearchState,
} from "./db";
import { recordApprovedMissionMemory } from "./memory-graph";
import { assertPublicHttpUrl } from "./security";
import type { Env, MissionOutcomeStatus, MissionResearchStateRecord, ResearchResultImportRecord } from "./types";
import { isoNow, normalizeStringArray, parseJson } from "./utils";

export interface StructuredResearchResult {
  currentThesis: string;
  reportSummary: string;
  openQuestions: string[];
  reportTitle: string;
  reportUrl: string | null;
  confidence: number | null;
  nextExpectedEvent: string;
  nextExpectedBy: string | null;
  outcomeStatus: MissionOutcomeStatus | null;
  outcomeSummary: string;
}

const OUTCOMES = new Set<MissionOutcomeStatus>(["open", "resolved", "invalidated", "superseded"]);

function optionalDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new Error("nextExpectedBy must be a valid date");
  return new Date(timestamp).toISOString();
}

export function normalizeResearchResult(value: unknown): StructuredResearchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research result must be a JSON object");
  const input = value as Record<string, unknown>;
  const currentThesis = String(input.currentThesis ?? input.current_thesis ?? "").trim().slice(0, 12_000);
  const reportSummary = String(input.reportSummary ?? input.report_summary ?? "").trim().slice(0, 8_000);
  if (!currentThesis && !reportSummary) throw new Error("Research result needs currentThesis or reportSummary");
  const reportUrlValue = String(input.reportUrl ?? input.report_url ?? "").trim();
  const reportUrl = reportUrlValue ? assertPublicHttpUrl(reportUrlValue).toString() : null;
  const confidenceValue = input.confidence === null || input.confidence === undefined || input.confidence === ""
    ? null
    : Number(input.confidence);
  if (confidenceValue !== null && (!Number.isFinite(confidenceValue) || confidenceValue < 0 || confidenceValue > 1)) {
    throw new Error("confidence must be between 0 and 1");
  }
  const outcomeValue = String(input.outcomeStatus ?? input.outcome_status ?? "").trim() as MissionOutcomeStatus;
  const outcomeStatus = outcomeValue && OUTCOMES.has(outcomeValue) ? outcomeValue : null;
  return {
    currentThesis,
    reportSummary,
    openQuestions: normalizeStringArray(input.openQuestions ?? input.open_questions).slice(0, 100),
    reportTitle: String(input.reportTitle ?? input.report_title ?? "").trim().slice(0, 500),
    reportUrl,
    confidence: confidenceValue,
    nextExpectedEvent: String(input.nextExpectedEvent ?? input.next_expected_event ?? "").trim().slice(0, 1_000),
    nextExpectedBy: optionalDate(input.nextExpectedBy ?? input.next_expected_by),
    outcomeStatus,
    outcomeSummary: String(input.outcomeSummary ?? input.outcome_summary ?? "").trim().slice(0, 4_000),
  };
}

function stateOrEmpty(missionId: string, state: MissionResearchStateRecord | null): MissionResearchStateRecord {
  return state ?? {
    mission_id: missionId,
    current_thesis: "",
    report_summary: "",
    open_questions_json: "[]",
    report_title: "",
    report_url: null,
    confidence: null,
    last_research_at: null,
    last_handoff_id: null,
    updated_at: isoNow(),
  };
}

export async function stageResearchResult(
  env: Env,
  missionId: string,
  value: unknown,
  source = "chatgpt-deep-research",
): Promise<{ importRecord: ResearchResultImportRecord; payload: StructuredResearchResult; diff: Record<string, unknown> }> {
  const mission = await getMission(env.DB, missionId);
  if (!mission) throw new Error(`Mission not found: ${missionId}`);
  const payload = normalizeResearchResult(value);
  const [stateRow, operator] = await Promise.all([
    getMissionResearchState(env.DB, missionId),
    getMissionOperator(env.DB, missionId),
  ]);
  const state = stateOrEmpty(missionId, stateRow);
  const beforeQuestions = parseJson<string[]>(state.open_questions_json, []);
  const diff: Record<string, unknown> = {
    currentThesis: { before: state.current_thesis, after: payload.currentThesis },
    reportSummary: { before: state.report_summary, after: payload.reportSummary },
    openQuestions: { before: beforeQuestions, after: payload.openQuestions },
    report: { before: { title: state.report_title, url: state.report_url }, after: { title: payload.reportTitle, url: payload.reportUrl } },
    confidence: { before: state.confidence, after: payload.confidence },
    expectedEvent: {
      before: { title: operator?.expected_next_event ?? "", by: operator?.expected_by ?? null },
      after: { title: payload.nextExpectedEvent, by: payload.nextExpectedBy },
    },
    outcome: {
      before: { status: operator?.outcome_status ?? "open", summary: operator?.outcome_summary ?? "" },
      after: { status: payload.outcomeStatus, summary: payload.outcomeSummary },
    },
  };
  const id = `ri-${crypto.randomUUID()}`;
  await createResearchResultImport(env.DB, {
    id,
    missionId,
    payload: payload as unknown as Record<string, unknown>,
    diff,
    source,
    expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  });
  const importRecord = await getResearchResultImport(env.DB, id);
  if (!importRecord) throw new Error("Research result import could not be staged");
  return { importRecord, payload, diff };
}

export async function confirmResearchResult(
  env: Env,
  importId: string,
): Promise<{ missionId: string; state: MissionResearchStateRecord }> {
  const record = await getResearchResultImport(env.DB, importId);
  if (!record) throw new Error(`Research result import not found: ${importId}`);
  if (record.status !== "pending") throw new Error(`Research result import is ${record.status}`);
  if (Date.parse(record.expires_at) <= Date.now()) {
    await decideResearchResultImport(env.DB, importId, "expired");
    throw new Error("Research result import has expired");
  }
  const payload = normalizeResearchResult(parseJson<unknown>(record.payload_json, {}));
  const operator = await getMissionOperator(env.DB, record.mission_id);
  const researchedAt = isoNow();
  await upsertMissionResearchState(env.DB, {
    missionId: record.mission_id,
    currentThesis: payload.currentThesis,
    reportSummary: payload.reportSummary,
    openQuestions: payload.openQuestions,
    reportTitle: payload.reportTitle,
    reportUrl: payload.reportUrl,
    confidence: payload.confidence,
    lastResearchAt: researchedAt,
    lastHandoffId: importId,
  });
  await upsertMissionOperator(env.DB, {
    missionId: record.mission_id,
    expectedNextEvent: payload.nextExpectedEvent || operator?.expected_next_event || "",
    expectedBy: payload.nextExpectedEvent ? payload.nextExpectedBy : operator?.expected_by ?? null,
    expectedEventStatus: payload.nextExpectedEvent ? "pending" : operator?.expected_event_status ?? "none",
    outcomeStatus: payload.outcomeStatus ?? operator?.outcome_status ?? "open",
    outcomeSummary: payload.outcomeSummary || operator?.outcome_summary || "",
    resolvedAt: payload.outcomeStatus && payload.outcomeStatus !== "open" ? researchedAt : operator?.resolved_at ?? null,
  });
  await recordMissionEvent(env.DB, {
    missionId: record.mission_id,
    eventType: "research-result",
    title: payload.reportTitle || "Deep Research result accepted",
    detail: payload.reportSummary || payload.currentThesis,
    metadata: {
      importId,
      source: record.source,
      confidence: payload.confidence,
      reportUrl: payload.reportUrl,
      openQuestions: payload.openQuestions,
    },
    dedupeKey: `research-result:${importId}`,
    occurredAt: researchedAt,
  });
  await decideResearchResultImport(env.DB, importId, "confirmed");
  const mission = await getMission(env.DB, record.mission_id);
  if (mission) {
    try {
      await recordApprovedMissionMemory(env, {
        missionId: mission.id,
        missionName: mission.name,
        missionMode: operator?.mode ?? "watch",
        research: payload,
        importId,
      });
    } catch (error) {
      // The confirmed Mission state remains authoritative even if graph maintenance is deferred by budget or limits.
      console.error("Approved research memory update deferred", error);
      await env.DB
        .prepare("INSERT INTO settings(key, value, updated_at) VALUES ('memory_graph_dirty', '1', ?) ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at")
        .bind(isoNow())
        .run();
    }
  }
  const state = await getMissionResearchState(env.DB, record.mission_id);
  if (!state) throw new Error("Research state was not persisted");
  return { missionId: record.mission_id, state };
}

export async function rejectResearchResult(env: Env, importId: string): Promise<void> {
  const record = await getResearchResultImport(env.DB, importId);
  if (!record) throw new Error(`Research result import not found: ${importId}`);
  if (record.status !== "pending") return;
  await decideResearchResultImport(env.DB, importId, "rejected");
}

export async function pendingResearchResults(env: Env, limit = 50): Promise<Array<Record<string, unknown>>> {
  const rows = await listResearchResultImports(env.DB, { status: "pending", limit });
  return Promise.all(rows.map(async (row) => {
    const mission = await getMission(env.DB, row.mission_id);
    return {
      ...row,
      missionName: mission?.name ?? row.mission_id,
      payload: parseJson(row.payload_json, {}),
      diff: parseJson(row.diff_json, {}),
    };
  }));
}

export function deepResearchResultContract(): Record<string, unknown> {
  return {
    currentThesis: "A durable, decision-ready statement of the best current answer.",
    reportSummary: "A concise summary of what the research established and what materially changed.",
    openQuestions: ["Unresolved question one", "Unresolved question two"],
    reportTitle: "Optional report title",
    reportUrl: "Optional public or shared report URL",
    confidence: 0.78,
    nextExpectedEvent: "The next observable event that would update the answer",
    nextExpectedBy: "2026-09-01",
    outcomeStatus: "open",
    outcomeSummary: "Optional resolution summary when the Mission is closed.",
  };
}
