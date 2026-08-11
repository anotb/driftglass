import { buildDeepResearchHandoff } from "./deep-research";
import { getSetting } from "./db";
import { prepareReasoningReceipt } from "./reasoning-ledger";
import type { DecisionRecord, Env, ReasoningTarget, ReasoningTask, ReasoningTaskRecord, ReasoningTaskStatus } from "./types";
import { isoNow, stableStringify } from "./utils";
import { sha256 } from "./security";

function rows<T>(result: D1Result<T>): T[] { return result.results ?? []; }

export async function enqueueReasoningTask(
  env: Env,
  input: {
    scopeKind?: ReasoningTaskRecord["scope_kind"];
    scopeId?: string | null;
    task: ReasoningTask;
    target?: ReasoningTarget;
    objective: string;
    priority?: number;
    reason?: string;
    dueAt?: string | null;
    expiresInHours?: number;
    dedupeKey?: string;
  },
): Promise<ReasoningTaskRecord> {
  const scopeKind = input.scopeKind ?? "global";
  const scopeId = input.scopeId ?? null;
  const target = input.target ?? "chatgpt";
  const objective = input.objective.trim().slice(0, 2_000);
  if (!objective) throw new Error("Reasoning task objective is required");
  const dedupeKey = input.dedupeKey ?? await sha256(stableStringify({ scopeKind, scopeId, task: input.task, target, objective }));
  const existing = await env.DB
    .prepare("SELECT * FROM reasoning_tasks WHERE dedupe_key = ? AND status IN ('queued', 'ready', 'claimed') LIMIT 1")
    .bind(dedupeKey)
    .first<ReasoningTaskRecord>();
  if (existing) return existing;
  const now = isoNow();
  const id = `task-${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + Math.max(1, Math.min(24 * 30, input.expiresInHours ?? 72)) * 3_600_000).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO reasoning_tasks(
         id, scope_kind, scope_id, task, target, objective, priority, reason, status,
         dedupe_key, due_at, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).bind(
      id, scopeKind, scopeId, input.task, target, objective,
      Math.max(0, Math.min(1, input.priority ?? 0.5)),
      (input.reason ?? "").slice(0, 2_000), dedupeKey, input.dueAt ?? null, expiresAt, now, now,
    ).run();
  } catch (error) {
    // The partial unique index is the final concurrency guard when two scheduled paths enqueue together.
    const raced = await env.DB
      .prepare("SELECT * FROM reasoning_tasks WHERE dedupe_key = ? AND status IN ('queued', 'ready', 'claimed') LIMIT 1")
      .bind(dedupeKey)
      .first<ReasoningTaskRecord>();
    if (raced) return raced;
    throw error;
  }
  const task = await getReasoningTask(env.DB, id);
  if (!task) throw new Error("Reasoning task was created but could not be read");
  return task;
}

export async function getReasoningTask(db: D1Database, id: string): Promise<ReasoningTaskRecord | null> {
  return db.prepare("SELECT * FROM reasoning_tasks WHERE id = ?").bind(id).first<ReasoningTaskRecord>();
}

export async function listReasoningTasks(
  db: D1Database,
  options: { status?: ReasoningTaskStatus; scopeKind?: string; scopeId?: string; limit?: number } = {},
): Promise<ReasoningTaskRecord[]> {
  const clauses: string[] = ["datetime(expires_at) > datetime('now')"];
  const values: unknown[] = [];
  if (options.status) { clauses.push("status = ?"); values.push(options.status); }
  if (options.scopeKind) { clauses.push("scope_kind = ?"); values.push(options.scopeKind); }
  if (options.scopeId) { clauses.push("scope_id = ?"); values.push(options.scopeId); }
  values.push(Math.max(1, Math.min(200, options.limit ?? 50)));
  return rows(await db.prepare(
    `SELECT * FROM reasoning_tasks WHERE ${clauses.join(" AND ")}
     ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'queued' THEN 1 WHEN 'claimed' THEN 2 ELSE 3 END,
              priority DESC, COALESCE(due_at, created_at), created_at DESC LIMIT ?`,
  ).bind(...values).all<ReasoningTaskRecord>());
}

export async function setReasoningTaskStatus(
  db: D1Database,
  id: string,
  input: { status: ReasoningTaskStatus; receiptId?: string | null; claimedBy?: string | null },
): Promise<void> {
  const task = await getReasoningTask(db, id);
  if (!task) throw new Error(`Reasoning task not found: ${id}`);
  const now = isoNow();
  await db.prepare(
    `UPDATE reasoning_tasks SET status = ?, receipt_id = ?, claimed_by = ?, claimed_at = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(
    input.status,
    input.receiptId !== undefined ? input.receiptId : task.receipt_id,
    input.claimedBy !== undefined ? input.claimedBy : task.claimed_by,
    input.status === "claimed" ? now : task.claimed_at,
    ["completed", "dismissed", "failed", "expired"].includes(input.status) ? now : task.completed_at,
    now,
    id,
  ).run();
}

export async function materializeReasoningTask(env: Env, taskId: string): Promise<ReasoningTaskRecord> {
  const task = await getReasoningTask(env.DB, taskId);
  if (!task) throw new Error(`Reasoning task not found: ${taskId}`);
  if (task.receipt_id && task.status === "ready") return task;
  try {
    const prepared = await prepareReasoningReceipt(env, {
      target: task.target,
      task: task.task,
      scopeKind: task.scope_kind === "dossier" ? "global" : task.scope_kind,
      scopeId: task.scope_id ?? undefined,
      objective: task.objective,
    });
    await setReasoningTaskStatus(env.DB, task.id, { status: "ready", receiptId: prepared.receipt.id });
  } catch (error) {
    await setReasoningTaskStatus(env.DB, task.id, { status: "failed" });
    throw error;
  }
  const updated = await getReasoningTask(env.DB, task.id);
  if (!updated) throw new Error("Reasoning task was prepared but could not be read");
  return updated;
}

export async function expireReasoningTasks(db: D1Database): Promise<number> {
  const result = await db.prepare(
    `UPDATE reasoning_tasks SET status = 'expired', completed_at = ?, updated_at = ?
     WHERE status IN ('queued','ready','claimed') AND datetime(expires_at) <= datetime('now')`,
  ).bind(isoNow(), isoNow()).run();
  return Number(result.meta?.changes ?? 0);
}

export async function nextReasoningTask(env: Env): Promise<ReasoningTaskRecord | null> {
  const tasks = await listReasoningTasks(env.DB, { limit: 1 });
  return tasks[0] ?? null;
}

interface ExpectedEventReasoningCandidate {
  id: string;
  name: string;
  question: string;
  expected_by: string;
  kind: "expected-overdue" | "expected-soon";
  days_from_now: number;
}

async function discoverReasoningTaskCandidateUnchecked(env: Env): Promise<ReasoningTaskRecord | null> {
  const review = await env.DB.prepare(
    `SELECT d.* FROM decisions d
     WHERE d.status = 'open'
       AND d.review_at IS NOT NULL
       AND datetime(d.review_at) <= datetime('now')
       AND NOT EXISTS (
         SELECT 1 FROM reasoning_tasks rt
         WHERE rt.dedupe_key = 'decision-review:' || d.id
           AND rt.status IN ('queued','ready','claimed')
           AND datetime(rt.expires_at) > datetime('now')
       )
     ORDER BY datetime(d.review_at) ASC, d.confidence DESC
     LIMIT 1`,
  ).first<DecisionRecord>();
  if (review) {
    return enqueueReasoningTask(env, {
      scopeKind: review.mission_id ? "mission" : review.story_id ? "story" : "global",
      scopeId: review.mission_id ?? review.story_id,
      task: "challenge",
      target: "chatgpt",
      objective: `Review the outcome of this prior ${review.decision_type}: ${review.statement}. Determine what happened, why, and what Driftglass should learn.`,
      priority: 0.88,
      reason: `Decision review is due${review.review_at ? ` at ${review.review_at}` : ""}.`,
      dueAt: review.review_at,
      expiresInHours: 24 * 14,
      dedupeKey: `decision-review:${review.id}`,
    });
  }

  const expected = await env.DB.prepare(
    `WITH candidates AS (
       SELECT m.id, m.name, m.question, o.expected_by,
              CASE WHEN datetime(o.expected_by) < datetime('now')
                   THEN 'expected-overdue' ELSE 'expected-soon' END AS kind,
              julianday(o.expected_by) - julianday('now') AS days_from_now
       FROM missions m
       JOIN mission_operators o ON o.mission_id = m.id
       WHERE m.status = 'active'
         AND o.outcome_status = 'open'
         AND o.expected_next_event != ''
         AND o.expected_by IS NOT NULL
         AND o.expected_event_status IN ('pending','rescheduled')
         AND datetime(o.expected_by) <= datetime('now', '+' || o.reminder_lead_days || ' days')
     )
     SELECT c.* FROM candidates c
     WHERE NOT EXISTS (
       SELECT 1 FROM reasoning_tasks rt
       WHERE rt.dedupe_key = c.kind || ':' || c.id || ':' || c.expected_by
         AND rt.status IN ('queued','ready','claimed')
         AND datetime(rt.expires_at) > datetime('now')
     )
     ORDER BY CASE c.kind WHEN 'expected-overdue' THEN 0 ELSE 1 END,
              datetime(c.expected_by) ASC
     LIMIT 1`,
  ).first<ExpectedEventReasoningCandidate>();
  if (expected) {
    const overdueDays = Math.max(1, Math.ceil(Math.abs(Number(expected.days_from_now))));
    const soonDays = Math.max(0, Math.ceil(Number(expected.days_from_now)));
    return enqueueReasoningTask(env, {
      scopeKind: "mission",
      scopeId: expected.id,
      task: expected.kind === "expected-overdue" ? "challenge" : "investigate",
      objective: `Assess the Mission's expected event and update the standing answer: ${expected.question || expected.name}`,
      priority: expected.kind === "expected-overdue" ? 0.94 : 0.76,
      reason: expected.kind === "expected-overdue"
        ? `Expected ${overdueDays} day${overdueDays === 1 ? "" : "s"} ago. Mark it occurred, missed, or rescheduled.`
        : `Expected in ${soonDays} day${soonDays === 1 ? "" : "s"}.`,
      dueAt: expected.expected_by,
      expiresInHours: 72,
      dedupeKey: `${expected.kind}:${expected.id}:${expected.expected_by}`,
    });
  }

  const mission = await env.DB.prepare(
    `SELECT m.id, m.name, m.question
     FROM missions m
     JOIN mission_operators o ON o.mission_id = m.id
     WHERE m.status = 'active'
       AND o.outcome_status = 'open'
       AND o.research_policy IN ('always','suggest')
       AND EXISTS (SELECT 1 FROM mission_story_matches msm WHERE msm.mission_id = m.id)
       AND NOT EXISTS (
         SELECT 1 FROM reasoning_tasks rt
         WHERE rt.scope_kind = 'mission' AND rt.scope_id = m.id AND rt.task = 'deep-research'
           AND rt.status IN ('queued','ready','claimed')
           AND datetime(rt.expires_at) > datetime('now')
       )
     ORDER BY CASE o.research_policy WHEN 'always' THEN 0 ELSE 1 END,
              COALESCE(m.last_evaluated_at, m.created_at) ASC, m.priority DESC
     LIMIT 1`,
  ).first<{ id: string; name: string; question: string }>();
  if (!mission) return null;
  const handoff = await buildDeepResearchHandoff(env, mission.id).catch(() => null);
  // Discovery is deliberately limited to one expensive handoff per scheduled
  // invocation. Record that evaluation even when it does not merit escalation
  // (or could not be compiled) so one poison/low-signal Mission cannot starve
  // every later eligible Mission forever.
  await env.DB
    .prepare("UPDATE missions SET last_evaluated_at = ? WHERE id = ?")
    .bind(isoNow(), mission.id)
    .run();
  if (!handoff?.recommendation.shouldEscalate) return null;
  return enqueueReasoningTask(env, {
    scopeKind: "mission",
    scopeId: mission.id,
    task: "deep-research",
    objective: mission.question || mission.name,
    priority: Math.min(1, 0.55 + handoff.recommendation.score * 0.45),
    reason: handoff.recommendation.reasons.join(" ") || handoff.recommendation.whyNow,
    expiresInHours: 24 * 7,
    dedupeKey: `deep-research:${mission.id}:${handoff.currentState[0]?.changedAt?.slice(0, 10) ?? "baseline"}`,
  });
}

/** Discover and enqueue at most one deterministic reasoning candidate. */
export async function discoverReasoningTaskCandidate(env: Env): Promise<ReasoningTaskRecord | null> {
  if ((await getSetting(env.DB, "reasoning_tasks_auto_create")) === "0") return null;
  await expireReasoningTasks(env.DB);
  return discoverReasoningTaskCandidateUnchecked(env);
}

/** Materialize at most one queued task into one immutable Evidence-State Receipt. */
export async function materializeNextReasoningTask(env: Env): Promise<ReasoningTaskRecord | null> {
  const [task] = await listReasoningTasks(env.DB, { status: "queued", limit: 1 });
  return task ? materializeReasoningTask(env, task.id) : null;
}

/**
 * Compatibility boundary for manual callers. A single invocation performs one
 * bounded unit: prepare one existing task, otherwise discover one candidate.
 */
export async function refreshReasoningTaskQueue(env: Env, _limit = 1): Promise<{ created: string[]; prepared: string[] }> {
  if ((await getSetting(env.DB, "reasoning_tasks_auto_create")) === "0") return { created: [], prepared: [] };
  await expireReasoningTasks(env.DB);
  const queued = await materializeNextReasoningTask(env).catch((error) => {
    console.error("Reasoning task preparation failed", error);
    return null;
  });
  if (queued) return { created: [], prepared: [queued.id] };
  const created = await discoverReasoningTaskCandidateUnchecked(env);
  return { created: created ? [created.id] : [], prepared: [] };
}

export function reasoningTaskPrompt(task: ReasoningTaskRecord, receiptUrl?: string): string {
  return [
    `Driftglass has prepared a ${task.task} task.`,
    `Objective: ${task.objective}`,
    task.reason ? `Why now: ${task.reason}` : "",
    receiptUrl ? `Open the exact evidence-state receipt: ${receiptUrl}` : "Use the connected Driftglass app to fetch the prepared receipt.",
    "Answer the objective rather than summarizing the packet. Inspect supporting evidence, disconfirming evidence, missing evidence, and prior durable memory. State what would change the conclusion.",
  ].filter(Boolean).join("\n\n");
}
