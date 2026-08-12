import {
  getMission,
  getStory,
  upsertMemoryEdge,
  upsertMemoryNode,
} from "./db";
import type {
  DecisionRecord,
  DecisionReviewRecord,
  DecisionStatus,
  DecisionType,
  Env,
  MemoryNodeRecord,
} from "./types";
import { isoNow, parseJson, stableStringify } from "./utils";
import { sha256 } from "./security";

function rows<T>(result: D1Result<T>): T[] { return result.results ?? []; }

export interface DecisionInput {
  missionId?: string | null;
  storyId?: string | null;
  reasoningTaskId?: string | null;
  reasoningReceiptId?: string | null;
  decisionType?: DecisionType;
  title: string;
  statement: string;
  rationale?: string;
  options?: unknown[];
  evidence?: unknown[];
  tags?: string[];
  confidence?: number;
  expectedOutcome?: string;
  reviewAt?: string | null;
}

export interface DecisionReviewInput {
  observedOutcome: string;
  actualValue?: number | null;
  qualityScore?: number | null;
  lesson?: string;
  evidence?: unknown[];
  provider?: string;
  status?: Extract<DecisionStatus, "resolved" | "reversed" | "expired">;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function reviewCalibration(confidence: number, actualValue: number | null | undefined): number | null {
  if (actualValue === null || actualValue === undefined || !Number.isFinite(actualValue)) return null;
  const error = clamp01(confidence) - clamp01(actualValue);
  return Math.max(0, Math.min(1, 1 - error * error));
}

function decisionMemoryKey(id: string): string { return `decision:${id}`; }
function edgeId(from: string, to: string, relation: string): string { return `me-${from}-${relation}-${to}`.slice(0, 180); }

async function projectDecisionToMemory(env: Env, decision: DecisionRecord): Promise<MemoryNodeRecord> {
  const node = await upsertMemoryNode(env.DB, {
    id: `memory-decision-${decision.id}`,
    nodeType: "decision",
    canonicalKey: decisionMemoryKey(decision.id),
    label: decision.title,
    summary: decision.statement,
    metadata: {
      decisionType: decision.decision_type,
      status: decision.status,
      confidence: decision.confidence,
      expectedOutcome: decision.expected_outcome,
      reviewAt: decision.review_at,
      outcomeSummary: decision.outcome_summary,
      calibrationScore: decision.calibration_score,
      tags: parseJson(decision.tags_json, []),
    },
    importance: decision.decision_type === "forecast" ? 0.72 : decision.decision_type === "commitment" ? 0.88 : 0.82,
    confidence: decision.confidence,
    occurredAt: decision.created_at,
    seenAt: decision.updated_at,
    status: decision.status === "open" ? "active" : decision.status === "resolved" ? "resolved" : "superseded",
    sourceRef: decision.reasoning_receipt_id ? `receipt:${decision.reasoning_receipt_id}` : decision.mission_id ? `mission:${decision.mission_id}` : null,
    validFrom: decision.created_at,
    validTo: decision.resolved_at,
  });
  if (decision.mission_id) {
    const mission = await getMission(env.DB, decision.mission_id);
    if (mission) {
      const missionNode = await upsertMemoryNode(env.DB, {
        id: `memory-mission-${mission.id}`,
        nodeType: "mission",
        canonicalKey: `mission:${mission.id}`,
        label: mission.name,
        summary: mission.question,
        importance: mission.priority / 5,
        confidence: 1,
        sourceRef: `mission:${mission.id}`,
      });
      await upsertMemoryEdge(env.DB, {
        id: edgeId(missionNode.id, node.id, "defined_by"),
        fromNodeId: missionNode.id,
        toNodeId: node.id,
        relation: "defined_by",
        weight: 0.92,
        confidence: 1,
        rationale: "Decision belongs to this standing Mission",
        evidence: [decision.id],
      });
    }
  }
  if (decision.story_id) {
    const detail = await getStory(env.DB, decision.story_id);
    if (detail) {
      const storyNode = await upsertMemoryNode(env.DB, {
        id: `memory-story-${detail.story.id}`,
        nodeType: "story",
        canonicalKey: `story:${detail.story.id}`,
        label: detail.story.title,
        summary: detail.story.summary,
        importance: Math.min(1, detail.story.importance),
        confidence: detail.story.confidence,
        occurredAt: detail.story.first_seen_at,
        sourceRef: `story:${detail.story.id}`,
      });
      await upsertMemoryEdge(env.DB, {
        id: edgeId(node.id, storyNode.id, "derived_from"),
        fromNodeId: node.id,
        toNodeId: storyNode.id,
        relation: "derived_from",
        weight: 0.8,
        confidence: Math.max(0.5, decision.confidence),
        rationale: "Decision was linked to this Story state",
        evidence: [decision.id],
      });
    }
  }
  return node;
}

export async function createDecision(env: Env, input: DecisionInput): Promise<DecisionRecord> {
  const title = input.title.trim().slice(0, 300);
  const statement = input.statement.trim().slice(0, 8_000);
  if (!title || !statement) throw new Error("Decision title and statement are required");
  const id = `decision-${crypto.randomUUID()}`;
  const now = isoNow();
  const confidence = clamp01(input.confidence ?? 0.5);
  await env.DB.prepare(
    `INSERT INTO decisions(
      id, mission_id, story_id, reasoning_task_id, reasoning_receipt_id, decision_type,
      title, statement, rationale, options_json, evidence_json, tags_json, status,
      confidence, expected_outcome, review_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    input.missionId ?? null,
    input.storyId ?? null,
    input.reasoningTaskId ?? null,
    input.reasoningReceiptId ?? null,
    input.decisionType ?? "decision",
    title,
    statement,
    (input.rationale ?? "").trim().slice(0, 12_000),
    JSON.stringify(input.options ?? []),
    JSON.stringify(input.evidence ?? []),
    JSON.stringify((input.tags ?? []).map((tag) => String(tag).trim()).filter(Boolean).slice(0, 50)),
    confidence,
    (input.expectedOutcome ?? "").trim().slice(0, 4_000),
    input.reviewAt ?? null,
    now,
    now,
  ).run();
  const decision = await getDecision(env.DB, id);
  if (!decision) throw new Error("Decision was created but could not be read");
  await projectDecisionToMemory(env, decision);
  return decision;
}

export async function getDecision(db: D1Database, id: string): Promise<DecisionRecord | null> {
  return db.prepare("SELECT * FROM decisions WHERE id = ?").bind(id).first<DecisionRecord>();
}

export async function listDecisions(
  db: D1Database,
  options: { missionId?: string; storyId?: string; status?: DecisionStatus; type?: DecisionType; limit?: number } = {},
): Promise<DecisionRecord[]> {
  const clauses: string[] = ["1 = 1"];
  const values: unknown[] = [];
  if (options.missionId) { clauses.push("mission_id = ?"); values.push(options.missionId); }
  if (options.storyId) { clauses.push("story_id = ?"); values.push(options.storyId); }
  if (options.status) { clauses.push("status = ?"); values.push(options.status); }
  if (options.type) { clauses.push("decision_type = ?"); values.push(options.type); }
  values.push(Math.max(1, Math.min(250, options.limit ?? 50)));
  return rows(await db.prepare(
    `SELECT * FROM decisions WHERE ${clauses.join(" AND ")}
     ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
              COALESCE(review_at, updated_at) ASC, updated_at DESC LIMIT ?`,
  ).bind(...values).all<DecisionRecord>());
}

export async function dueDecisionReviews(db: D1Database, limit = 50): Promise<DecisionRecord[]> {
  return rows(await db.prepare(
    `SELECT * FROM decisions
     WHERE status = 'open' AND review_at IS NOT NULL AND datetime(review_at) <= datetime('now')
     ORDER BY datetime(review_at) ASC, confidence DESC LIMIT ?`,
  ).bind(Math.max(1, Math.min(200, limit))).all<DecisionRecord>());
}

export async function updateDecision(
  env: Env,
  id: string,
  input: Partial<Pick<DecisionInput, "title" | "statement" | "rationale" | "options" | "evidence" | "tags" | "confidence" | "expectedOutcome" | "reviewAt">> & { status?: DecisionStatus },
): Promise<DecisionRecord> {
  const current = await getDecision(env.DB, id);
  if (!current) throw new Error(`Decision not found: ${id}`);
  const status = input.status ?? current.status;
  const now = isoNow();
  await env.DB.prepare(
    `UPDATE decisions SET title = ?, statement = ?, rationale = ?, options_json = ?, evidence_json = ?, tags_json = ?,
      status = ?, confidence = ?, expected_outcome = ?, review_at = ?, updated_at = ?, resolved_at = ? WHERE id = ?`,
  ).bind(
    input.title?.trim().slice(0, 300) || current.title,
    input.statement?.trim().slice(0, 8_000) || current.statement,
    input.rationale === undefined ? current.rationale : input.rationale.trim().slice(0, 12_000),
    input.options === undefined ? current.options_json : JSON.stringify(input.options),
    input.evidence === undefined ? current.evidence_json : JSON.stringify(input.evidence),
    input.tags === undefined ? current.tags_json : JSON.stringify(input.tags.map(String).slice(0, 50)),
    status,
    input.confidence === undefined ? current.confidence : clamp01(input.confidence),
    input.expectedOutcome === undefined ? current.expected_outcome : input.expectedOutcome.trim().slice(0, 4_000),
    input.reviewAt === undefined ? current.review_at : input.reviewAt,
    now,
    status === "open" ? null : current.resolved_at ?? now,
    id,
  ).run();
  const updated = await getDecision(env.DB, id);
  if (!updated) throw new Error("Decision was updated but could not be read");
  await projectDecisionToMemory(env, updated);
  return updated;
}

export async function reviewDecision(env: Env, id: string, input: DecisionReviewInput): Promise<{ decision: DecisionRecord; review: DecisionReviewRecord }> {
  const decision = await getDecision(env.DB, id);
  if (!decision) throw new Error(`Decision not found: ${id}`);
  const observedOutcome = input.observedOutcome.trim().slice(0, 12_000);
  if (!observedOutcome) throw new Error("Observed outcome is required");
  const actualValue = input.actualValue === undefined || input.actualValue === null ? null : clamp01(input.actualValue);
  const calibrationScore = reviewCalibration(decision.confidence, actualValue);
  const qualityScore = input.qualityScore === undefined || input.qualityScore === null
    ? calibrationScore
    : clamp01(input.qualityScore);
  const reviewId = `review-${crypto.randomUUID()}`;
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO decision_reviews(
      id, decision_id, observed_outcome, actual_value, quality_score, calibration_score,
      lesson, evidence_json, provider, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    reviewId,
    id,
    observedOutcome,
    actualValue,
    qualityScore,
    calibrationScore,
    (input.lesson ?? "").trim().slice(0, 8_000),
    JSON.stringify(input.evidence ?? []),
    (input.provider ?? "owner").trim().slice(0, 120),
    now,
  ).run();
  await env.DB.prepare(
    `UPDATE decisions SET status = ?, outcome_summary = ?, outcome_value = ?, calibration_score = ?, resolved_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(input.status ?? "resolved", observedOutcome, actualValue, calibrationScore, now, now, id).run();
  const updated = await getDecision(env.DB, id);
  const review = await env.DB.prepare("SELECT * FROM decision_reviews WHERE id = ?").bind(reviewId).first<DecisionReviewRecord>();
  if (!updated || !review) throw new Error("Decision review was stored but could not be read");
  const node = await projectDecisionToMemory(env, updated);
  const outcomeNode = await upsertMemoryNode(env.DB, {
    id: `memory-outcome-${review.id}`,
    nodeType: "outcome",
    canonicalKey: `decision-outcome:${review.id}`,
    label: `Outcome · ${decision.title}`,
    summary: observedOutcome,
    metadata: {
      actualValue,
      calibrationScore,
      qualityScore,
      lesson: review.lesson,
      provider: review.provider,
    },
    importance: 0.82,
    confidence: actualValue === null ? 0.72 : 0.94,
    occurredAt: now,
    sourceRef: `decision:${decision.id}`,
  });
  await upsertMemoryEdge(env.DB, {
    id: edgeId(outcomeNode.id, node.id, "resolves"),
    fromNodeId: outcomeNode.id,
    toNodeId: node.id,
    relation: "resolves",
    weight: 0.96,
    confidence: actualValue === null ? 0.8 : 0.96,
    rationale: "Observed outcome reviewed against the prior judgment",
    evidence: [review.id],
  });
  return { decision: updated, review };
}

export async function listDecisionReviews(db: D1Database, decisionId: string, limit = 50): Promise<DecisionReviewRecord[]> {
  return rows(await db.prepare(
    "SELECT * FROM decision_reviews WHERE decision_id = ? ORDER BY created_at DESC LIMIT ?",
  ).bind(decisionId, Math.max(1, Math.min(200, limit))).all<DecisionReviewRecord>());
}

export async function decisionCalibrationSummary(db: D1Database): Promise<Record<string, unknown>> {
  const reviews = rows(await db.prepare(
    `SELECT d.decision_type, d.confidence, dr.actual_value, dr.calibration_score, dr.quality_score, dr.created_at
     FROM decision_reviews dr JOIN decisions d ON d.id = dr.decision_id
     WHERE dr.actual_value IS NOT NULL ORDER BY dr.created_at DESC LIMIT 500`,
  ).all<{ decision_type: DecisionType; confidence: number; actual_value: number; calibration_score: number; quality_score: number | null; created_at: string }>());
  const buckets = [0.1, 0.3, 0.5, 0.7, 0.9].map((center) => {
    const min = center - 0.1;
    const max = center + 0.1;
    const matches = reviews.filter((row) => row.confidence >= min && (center === 0.9 ? row.confidence <= 1 : row.confidence < max));
    return {
      range: `${Math.round(min * 100)}–${Math.round(Math.min(1, max) * 100)}%`,
      count: matches.length,
      meanConfidence: matches.length ? matches.reduce((total, row) => total + row.confidence, 0) / matches.length : null,
      actualRate: matches.length ? matches.reduce((total, row) => total + row.actual_value, 0) / matches.length : null,
      meanCalibration: matches.length ? matches.reduce((total, row) => total + row.calibration_score, 0) / matches.length : null,
    };
  });
  const byType = [...new Set(reviews.map((row) => row.decision_type))].map((type) => {
    const matches = reviews.filter((row) => row.decision_type === type);
    return {
      type,
      count: matches.length,
      brierScore: matches.length ? matches.reduce((total, row) => total + Math.pow(row.confidence - row.actual_value, 2), 0) / matches.length : null,
      calibrationQuality: matches.length ? matches.reduce((total, row) => total + row.calibration_score, 0) / matches.length : null,
    };
  });
  return {
    generatedAt: isoNow(),
    reviewedCount: reviews.length,
    overallBrierScore: reviews.length ? reviews.reduce((total, row) => total + Math.pow(row.confidence - row.actual_value, 2), 0) / reviews.length : null,
    overallCalibrationQuality: reviews.length ? reviews.reduce((total, row) => total + row.calibration_score, 0) / reviews.length : null,
    buckets,
    byType,
    latestReviewedAt: reviews[0]?.created_at ?? null,
  };
}

export async function decisionFingerprint(input: DecisionInput): Promise<string> {
  return sha256(stableStringify({
    missionId: input.missionId ?? null,
    storyId: input.storyId ?? null,
    decisionType: input.decisionType ?? "decision",
    statement: input.statement.trim(),
    expectedOutcome: input.expectedOutcome ?? "",
    reviewAt: input.reviewAt ?? null,
  }));
}
