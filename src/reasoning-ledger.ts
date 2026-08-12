import { Validator, type Schema, type ValidationResult } from "@cfworker/json-schema";
import {
  getReasoningReceipt,
  getReasoningRun,
  insertReasoningReceipt,
  insertReasoningRun,
  listReasoningRunEvents,
  listReasoningRuns,
  recordReasoningRunEvent,
  updateReasoningReceipt,
  updateReasoningRun,
} from "./db";
import { memoryPatchContract, normalizeMemoryPatch, stageMemoryProposal } from "./memory-graph";
import { buildReasoningBundle, reasoningBundleMarkdown, type ReasoningBundleInput } from "./reasoning";
import { sha256 } from "./security";
import { jaccard, tokenize } from "./scoring";
import { getEvidenceObject, putEvidenceObject } from "./r2-budget";
import type { Env, MemoryPatch, ReasoningBundle, ReasoningReceiptRecord, ReasoningRunRecord } from "./types";
import { excerpt, HttpError, isoNow, parseJson, stableStringify } from "./utils";

export interface PreparedReasoningReceipt {
  receipt: ReasoningReceiptRecord;
  bundle: ReasoningBundle;
  markdown: string;
}

export interface ReasoningResultInput {
  response?: string;
  summary?: string;
  structuredResult?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
  audit?: Record<string, unknown>;
  citations?: unknown[];
  confidence?: number | null;
  decisionNote?: string;
  memoryPatch?: unknown;
}

export interface RecordReasoningResultInput extends ReasoningResultInput {
  receiptId: string;
  provider: string;
  model?: string | null;
  client?: string | null;
}

export interface CanonicalReasoningResult {
  structuredResult: Record<string, unknown>;
  summary: string;
  citations: unknown[];
  confidence: number | null;
  contractEnforced: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSchema(value: unknown): value is Schema {
  return isRecord(value);
}

function unprocessableReasoningResult(code: string, message: string, details: Record<string, unknown> = {}): HttpError {
  return new HttpError(422, message, { code, ...details });
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) return false;
  for (const value of leftSet) if (!rightSet.has(value)) return false;
  return true;
}

function rejectTopLevelConflict(field: "summary" | "citations" | "confidence"): never {
  throw unprocessableReasoningResult(
    "REASONING_RESULT_TOP_LEVEL_CONFLICT",
    `Top-level ${field} conflicts with the receipt-contracted structured result`,
    { field },
  );
}

/**
 * Validate and canonicalize a model result without performing I/O.
 *
 * Historical receipts with no structured-result contract retain the original
 * permissive behavior. Contracted receipts take their duplicated ledger fields
 * only from the validated structured result.
 */
export function canonicalizeReasoningResult(
  bundle: { resultContract?: unknown },
  input: ReasoningResultInput,
  response: string,
): CanonicalReasoningResult {
  const contract = bundle.resultContract;
  if (contract === undefined || contract === null || (isRecord(contract) && Object.keys(contract).length === 0)) {
    return {
      structuredResult: input.structuredResult ?? {},
      summary: String(input.summary ?? input.structuredResult?.summary ?? excerpt(response, 8_000)).trim().slice(0, 8_000),
      citations: input.citations ?? [],
      confidence: input.confidence ?? null,
      contractEnforced: false,
    };
  }
  if (!isSchema(contract)) {
    throw unprocessableReasoningResult(
      "REASONING_RESULT_CONTRACT_INVALID",
      "The receipt structured-result contract is invalid",
    );
  }
  if (!isRecord(input.structuredResult)) {
    throw unprocessableReasoningResult(
      "REASONING_RESULT_REQUIRED",
      "A structured result is required by this receipt",
    );
  }

  let validation: ValidationResult;
  try {
    validation = new Validator(contract, "2020-12", false).validate(input.structuredResult);
  } catch {
    throw unprocessableReasoningResult(
      "REASONING_RESULT_CONTRACT_INVALID",
      "The receipt structured-result contract could not be evaluated",
    );
  }
  if (!validation.valid) {
    throw unprocessableReasoningResult(
      "REASONING_RESULT_CONTRACT_MISMATCH",
      "The structured result does not match its receipt contract",
      {
        errors: validation.errors.slice(0, 16).map((error) => ({
          keyword: error.keyword,
          instanceLocation: error.instanceLocation,
          message: error.error,
        })),
      },
    );
  }

  const summary = input.structuredResult.summary;
  const citationsValue = input.structuredResult.citations;
  const confidence = input.structuredResult.confidence;
  const strongestEvidence = input.structuredResult.strongestEvidence;
  if (typeof summary !== "string" || !Array.isArray(citationsValue) || !citationsValue.every((value) => typeof value === "string") || typeof confidence !== "number" || !Number.isFinite(confidence) || !Array.isArray(strongestEvidence)) {
    throw unprocessableReasoningResult(
      "REASONING_RESULT_CANONICAL_FIELDS_INVALID",
      "The structured result must provide canonical summary, citations, confidence, and strongest evidence fields",
    );
  }
  const citations = citationsValue as string[];
  const evidenceCitations: string[] = [];
  for (const item of strongestEvidence) {
    if (!isRecord(item) || typeof item.citationUrl !== "string") {
      throw unprocessableReasoningResult(
        "REASONING_RESULT_CANONICAL_FIELDS_INVALID",
        "Every strongest-evidence item must provide an exact citation URL",
      );
    }
    evidenceCitations.push(item.citationUrl);
  }
  if (new Set(citations).size !== citations.length) {
    throw unprocessableReasoningResult(
      "REASONING_RESULT_CITATIONS_DUPLICATE",
      "Structured-result citations must be unique",
    );
  }
  if (!sameStringSet(citations, evidenceCitations)) {
    throw unprocessableReasoningResult(
      "REASONING_RESULT_CITATIONS_MISMATCH",
      "Structured-result citations must exactly match the strongest-evidence citation URLs",
    );
  }

  if (input.summary !== undefined && input.summary !== summary) rejectTopLevelConflict("summary");
  if (input.citations !== undefined && JSON.stringify(input.citations) !== JSON.stringify(citations)) rejectTopLevelConflict("citations");
  if (input.confidence !== undefined && input.confidence !== confidence) rejectTopLevelConflict("confidence");

  return {
    structuredResult: input.structuredResult,
    summary,
    citations,
    confidence,
    contractEnforced: true,
  };
}

export function canonicalizeReasoningMemoryPatch(value: unknown): MemoryPatch | null {
  if (value === undefined || value === null) return null;
  const contract = memoryPatchContract();
  if (!isSchema(contract)) throw new Error("Memory patch contract is invalid");
  const validation = new Validator(contract, "2020-12", false).validate(value);
  if (!validation.valid) {
    throw unprocessableReasoningResult(
      "REASONING_MEMORY_PATCH_INVALID",
      "The proposed Memory patch does not match the review contract",
      {
        errors: validation.errors.slice(0, 16).map((error) => ({
          keyword: error.keyword,
          instanceLocation: error.instanceLocation,
          message: error.error,
        })),
      },
    );
  }
  try {
    return normalizeMemoryPatch(value);
  } catch {
    throw unprocessableReasoningResult(
      "REASONING_MEMORY_PATCH_INVALID",
      "The proposed Memory patch could not be normalized",
    );
  }
}

function datePath(value = isoNow()): string {
  return value.slice(0, 10).replaceAll("-", "/");
}

function receiptTitle(bundle: ReasoningBundle): string {
  return bundle.title || `${bundle.task} · ${bundle.objective.slice(0, 120)}`;
}

function receiptScope(bundle: ReasoningBundle): { kind: ReasoningReceiptRecord["scope_kind"]; id: string | null } {
  if (bundle.mission?.id) return { kind: "mission", id: bundle.mission.id };
  const story = bundle.evidence.find((item) => typeof item.storyId === "string")?.storyId;
  if (bundle.task !== "daily-brief" && typeof story === "string" && new Set(bundle.evidence.map((item) => item.storyId)).size === 1) {
    return { kind: "story", id: story };
  }
  return { kind: "global", id: null };
}

export async function prepareReasoningReceipt(
  env: Env,
  input: ReasoningBundleInput,
): Promise<PreparedReasoningReceipt> {
  const bundle = await buildReasoningBundle(env, input);
  const receiptId = `receipt-${crypto.randomUUID()}`;
  // Hash the exact JSON value that is written to object storage. JavaScript
  // object properties whose value is undefined disappear during JSON
  // serialization; hashing the pre-serialization object makes that immutable
  // snapshot impossible to verify after it is read back.
  const stableBundle = JSON.parse(JSON.stringify({ ...bundle, receiptId })) as ReasoningBundle;
  const jsonBody = `${JSON.stringify(stableBundle, null, 2)}\n`;
  const markdownBody = reasoningBundleMarkdown(stableBundle);
  const { receiptId: _receiptId, generatedAt: _generatedAt, ...hashableBundle } = stableBundle;
  const bundleHash = await sha256(stableStringify(hashableBundle));
  const root = `reasoning/${datePath()}/${receiptId}`;
  const jsonKey = `${root}/bundle.json`;
  const markdownKey = `${root}/bundle.md`;
  try {
    await putEvidenceObject(env, jsonKey, jsonBody, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { receiptId, bundleHash, task: stableBundle.task, target: stableBundle.target },
    });
    await putEvidenceObject(env, markdownKey, markdownBody, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { receiptId, bundleHash, task: stableBundle.task, target: stableBundle.target },
    });
  } catch (error) {
    await Promise.allSettled([env.EVIDENCE.delete(jsonKey), env.EVIDENCE.delete(markdownKey)]);
    throw error;
  }
  const scope = receiptScope(stableBundle);
  try {
    await insertReasoningReceipt(env.DB, {
      id: receiptId,
      scopeKind: scope.kind,
      scopeId: scope.id,
      task: stableBundle.task,
      target: stableBundle.target,
      title: receiptTitle(stableBundle),
      objective: stableBundle.objective,
      bundleVersion: Number(stableBundle.schemaVersion),
      bundleHash,
      bundleR2Key: jsonKey,
      quality: {
        ...(stableBundle.quality as unknown as Record<string, unknown>),
        sourceScope: stableBundle.sourceScope,
      },
      estimatedTokens: stableBundle.contextBudget.estimatedTokens,
      evidenceCount: stableBundle.coverage.evidenceCount,
      independentFamilyCount: stableBundle.coverage.independentFamilyCount,
      status: "prepared",
    });
  } catch (error) {
    await Promise.allSettled([env.EVIDENCE.delete(jsonKey), env.EVIDENCE.delete(markdownKey)]);
    throw error;
  }
  const receipt = await getReasoningReceipt(env.DB, receiptId);
  if (!receipt) {
    await Promise.allSettled([env.EVIDENCE.delete(jsonKey), env.EVIDENCE.delete(markdownKey)]);
    throw new Error("Reasoning receipt was stored but could not be read");
  }
  return { receipt, bundle: stableBundle, markdown: markdownBody };
}

export async function readReasoningReceiptBundle(
  env: Env,
  receiptOrId: ReasoningReceiptRecord | string,
): Promise<ReasoningBundle | null> {
  const receipt = typeof receiptOrId === "string" ? await getReasoningReceipt(env.DB, receiptOrId) : receiptOrId;
  if (!receipt) return null;
  const object = await getEvidenceObject(env, receipt.bundle_r2_key);
  return object ? object.json<ReasoningBundle>() : null;
}

export async function readVerifiedReasoningReceiptBundle(
  env: Env,
  receipt: ReasoningReceiptRecord,
): Promise<Record<string, unknown>> {
  const object = await getEvidenceObject(env, receipt.bundle_r2_key);
  if (!object) {
    throw unprocessableReasoningResult(
      "REASONING_RECEIPT_BUNDLE_MISSING",
      "The immutable receipt bundle is unavailable",
    );
  }
  let bundle: unknown;
  try {
    bundle = await object.json<unknown>();
  } catch {
    throw unprocessableReasoningResult(
      "REASONING_RECEIPT_BUNDLE_INVALID",
      "The immutable receipt bundle is not valid JSON",
    );
  }
  if (!isRecord(bundle) || bundle.receiptId !== receipt.id) {
    throw unprocessableReasoningResult(
      "REASONING_RECEIPT_BUNDLE_INVALID",
      "The immutable receipt bundle does not match this receipt",
    );
  }
  const { receiptId: _receiptId, generatedAt: _generatedAt, ...hashableBundle } = bundle;
  const actualHash = await sha256(stableStringify(hashableBundle));
  if (actualHash !== receipt.bundle_hash) {
    throw unprocessableReasoningResult(
      "REASONING_RECEIPT_BUNDLE_HASH_MISMATCH",
      "The immutable receipt bundle failed hash verification",
    );
  }
  return bundle;
}

async function beginReasoningRunForReceipt(
  env: Env,
  receipt: ReasoningReceiptRecord,
  input: { provider: string; model?: string | null; client?: string | null },
): Promise<ReasoningRunRecord> {
  const id = `run-${crypto.randomUUID()}`;
  await insertReasoningRun(env.DB, {
    id,
    receiptId: receipt.id,
    providerLabel: input.provider.trim().slice(0, 100) || "unknown",
    modelLabel: input.model?.trim().slice(0, 160) || null,
    clientLabel: input.client?.trim().slice(0, 160) || null,
  });
  await recordReasoningRunEvent(env.DB, {
    runId: id,
    eventType: "started",
    detail: { receiptId: receipt.id, bundleHash: receipt.bundle_hash, provider: input.provider, model: input.model ?? null },
  });
  await env.DB.prepare(
    `UPDATE reasoning_tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
     WHERE receipt_id = ? AND status IN ('queued','ready')`,
  ).bind(input.client ?? input.provider, isoNow(), isoNow(), receipt.id).run();
  const run = await getReasoningRun(env.DB, id);
  if (!run) throw new Error("Reasoning run was created but could not be read");
  return run;
}

export async function beginReasoningRun(
  env: Env,
  input: { receiptId: string; provider: string; model?: string | null; client?: string | null },
): Promise<ReasoningRunRecord> {
  const receipt = await getReasoningReceipt(env.DB, input.receiptId);
  if (!receipt) throw new Error(`Reasoning receipt not found: ${input.receiptId}`);
  return beginReasoningRunForReceipt(env, receipt, input);
}

interface PreparedReasoningCompletion {
  response: string;
  canonical: CanonicalReasoningResult;
  memoryPatch: MemoryPatch | null;
}

async function prepareReasoningCompletion(
  env: Env,
  receipt: ReasoningReceiptRecord,
  input: ReasoningResultInput,
): Promise<PreparedReasoningCompletion> {
  const bundle = await readVerifiedReasoningReceiptBundle(env, receipt);
  const response = String(input.response ?? "").trim();
  const canonical = canonicalizeReasoningResult(bundle, input, response);
  const memoryPatch = canonicalizeReasoningMemoryPatch(input.memoryPatch);
  return { response, canonical, memoryPatch };
}

async function persistReasoningCompletion(
  env: Env,
  run: ReasoningRunRecord,
  receipt: ReasoningReceiptRecord,
  input: ReasoningResultInput,
  prepared: PreparedReasoningCompletion,
): Promise<{ run: ReasoningRunRecord; memoryProposalId: string | null }> {
  const { response, canonical } = prepared;
  const completedAt = isoNow();
  const responseHash = response ? await sha256(response) : null;
  const resultKey = `reasoning/${datePath(completedAt)}/${receipt.id}/runs/${run.id}.json`;
  const payload = {
    schemaVersion: "1",
    runId: run.id,
    receiptId: receipt.id,
    bundleHash: receipt.bundle_hash,
    provider: run.provider_label,
    model: run.model_label,
    client: run.client_label,
    completedAt,
    response,
    summary: canonical.summary,
    structuredResult: canonical.structuredResult,
    outcome: input.outcome ?? {},
    audit: input.audit ?? {},
    citations: canonical.citations,
    confidence: canonical.confidence,
    decisionNote: input.decisionNote ?? "",
  };
  await putEvidenceObject(env, resultKey, `${JSON.stringify(payload, null, 2)}\n`, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { receiptId: receipt.id, runId: run.id, bundleHash: receipt.bundle_hash },
  });

  let memoryProposalId: string | null = null;
  if (prepared.memoryPatch) {
    const staged = await stageMemoryProposal(env, {
      scopeKind: receipt.scope_kind,
      scopeId: receipt.scope_id ?? undefined,
      provider: `${run.provider_label}${run.model_label ? `/${run.model_label}` : ""}`,
      patch: prepared.memoryPatch,
    });
    memoryProposalId = staged.proposal.id;
    await recordReasoningRunEvent(env.DB, {
      runId: run.id,
      eventType: "memory-proposed",
      detail: { proposalId: memoryProposalId },
    });
  }

  const audit = {
    ...(input.audit ?? {}),
    receiptBundleHash: receipt.bundle_hash,
    responseHash,
    citationCount: canonical.citations.length,
    resultContractEnforced: canonical.contractEnforced,
    hasMemoryProposal: Boolean(memoryProposalId),
  };
  await updateReasoningRun(env.DB, run.id, {
    status: "completed",
    responseHash,
    responseR2Key: resultKey,
    responseSummary: canonical.summary,
    structuredResult: canonical.structuredResult,
    audit,
    outcome: input.outcome ?? {},
    confidence: canonical.confidence,
    memoryProposalId,
    completedAt,
  });
  await updateReasoningReceipt(env.DB, receipt.id, {
    providerLabel: run.provider_label,
    modelLabel: run.model_label,
    result: input.structuredResult ? canonical.structuredResult : { summary: canonical.summary },
    resultR2Key: resultKey,
    confidence: canonical.confidence,
    citations: canonical.citations,
    decisionNote: input.decisionNote ?? null,
    status: "completed",
    completedAt,
  });
  await recordReasoningRunEvent(env.DB, { runId: run.id, eventType: "completed", detail: { resultKey, memoryProposalId } });
  await env.DB.prepare(
    `UPDATE reasoning_tasks SET status = 'completed', completed_at = ?, updated_at = ?
     WHERE receipt_id = ? AND status IN ('queued','ready','claimed')`,
  ).bind(completedAt, completedAt, receipt.id).run();
  const updated = await getReasoningRun(env.DB, run.id);
  if (!updated) throw new Error("Reasoning run completed but could not be read");
  return { run: updated, memoryProposalId };
}

export async function completeReasoningRun(
  env: Env,
  runId: string,
  input: ReasoningResultInput,
): Promise<{ run: ReasoningRunRecord; memoryProposalId: string | null }> {
  const run = await getReasoningRun(env.DB, runId);
  if (!run) throw new Error(`Reasoning run not found: ${runId}`);
  if (["completed", "reviewed", "rejected"].includes(run.status)) {
    return { run, memoryProposalId: run.memory_proposal_id };
  }
  const receipt = await getReasoningReceipt(env.DB, run.receipt_id);
  if (!receipt) throw new Error(`Reasoning receipt not found: ${run.receipt_id}`);
  const prepared = await prepareReasoningCompletion(env, receipt, input);
  return persistReasoningCompletion(env, run, receipt, input, prepared);
}

/**
 * Validate a one-step result against its immutable receipt before creating the
 * run. API and MCP convenience callers use this path so rejected input cannot
 * leave a started run, event, or claimed task behind.
 */
export async function recordReasoningResult(
  env: Env,
  input: RecordReasoningResultInput,
): Promise<{ run: ReasoningRunRecord; memoryProposalId: string | null }> {
  const receipt = await getReasoningReceipt(env.DB, input.receiptId);
  if (!receipt) throw new Error(`Reasoning receipt not found: ${input.receiptId}`);
  const prepared = await prepareReasoningCompletion(env, receipt, input);
  const run = await beginReasoningRunForReceipt(env, receipt, input);
  return persistReasoningCompletion(env, run, receipt, input, prepared);
}

export async function reviewReasoningRun(
  env: Env,
  runId: string,
  input: { decision: "approve" | "reject"; rating?: number; note?: string },
): Promise<ReasoningRunRecord> {
  const run = await getReasoningRun(env.DB, runId);
  if (!run) throw new Error(`Reasoning run not found: ${runId}`);
  const status = input.decision === "approve" ? "reviewed" : "rejected";
  await updateReasoningRun(env.DB, runId, {
    status,
    rating: input.rating === undefined ? run.rating : Math.max(1, Math.min(5, Math.round(input.rating))),
    reviewedAt: isoNow(),
    audit: { ...parseJson<Record<string, unknown>>(run.audit_json, {}), reviewNote: input.note ?? "", reviewDecision: input.decision },
  });
  await updateReasoningReceipt(env.DB, run.receipt_id, { status: input.decision === "approve" ? "reviewed" : "rejected" });
  await recordReasoningRunEvent(env.DB, { runId, eventType: status, detail: { rating: input.rating ?? null, note: input.note ?? "" } });
  const updated = await getReasoningRun(env.DB, runId);
  if (!updated) throw new Error("Reasoning run review was stored but could not be read");
  return updated;
}

export async function reasoningReceiptDetail(env: Env, receiptId: string): Promise<Record<string, unknown>> {
  const receipt = await getReasoningReceipt(env.DB, receiptId);
  if (!receipt) throw new HttpError(404, "Reasoning receipt not found");
  const [bundle, runs, markdownObject] = await Promise.all([
    readReasoningReceiptBundle(env, receipt),
    listReasoningRuns(env.DB, { receiptId, limit: 20 }),
    getEvidenceObject(env, receipt.bundle_r2_key.replace(/bundle\.json$/, "bundle.md")),
  ]);
  const detailedRuns = await Promise.all(runs.map(async (run) => ({
    ...run,
    structuredResult: parseJson(run.structured_result_json, {}),
    audit: parseJson(run.audit_json, {}),
    outcome: parseJson(run.outcome_json, {}),
    events: await listReasoningRunEvents(env.DB, run.id),
  })));
  return {
    receipt: {
      ...receipt,
      quality: parseJson(receipt.quality_json, {}),
      result: parseJson(receipt.result_json, {}),
      citations: parseJson(receipt.citations_json, []),
    },
    bundle,
    markdown: markdownObject ? await markdownObject.text() : bundle ? reasoningBundleMarkdown(bundle) : "",
    runs: detailedRuns,
  };
}


function reasoningRunText(run: ReasoningRunRecord): string {
  const structured = parseJson<Record<string, unknown>>(run.structured_result_json, {});
  const values: string[] = [run.response_summary];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 3) return;
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) for (const item of value.slice(0, 30)) visit(item, depth + 1);
    else if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>).slice(0, 30)) visit(item, depth + 1);
  };
  visit(structured);
  return values.filter(Boolean).join(" ").slice(0, 40_000);
}

export async function compareReasoningRuns(
  env: Env,
  receiptId: string,
): Promise<Record<string, unknown>> {
  const receipt = await getReasoningReceipt(env.DB, receiptId);
  if (!receipt) throw new HttpError(404, "Reasoning receipt not found");
  const runs = (await listReasoningRuns(env.DB, { receiptId, limit: 20 }))
    .filter((run) => ["completed", "reviewed", "rejected"].includes(run.status));
  const pairs: Array<Record<string, unknown>> = [];
  for (let leftIndex = 0; leftIndex < runs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < runs.length; rightIndex += 1) {
      const left = runs[leftIndex]!;
      const right = runs[rightIndex]!;
      const agreement = jaccard(reasoningRunText(left), reasoningRunText(right));
      pairs.push({
        leftRunId: left.id,
        rightRunId: right.id,
        leftProvider: left.provider_label,
        rightProvider: right.provider_label,
        agreement: Number(agreement.toFixed(3)),
      });
    }
  }
  const averageAgreement = pairs.length
    ? pairs.reduce((total, pair) => total + Number(pair.agreement ?? 0), 0) / pairs.length
    : runs.length === 1 ? 1 : 0;
  const confidences = runs.map((run) => run.confidence).filter((value): value is number => value !== null && Number.isFinite(value));
  const confidenceSpread = confidences.length > 1 ? Math.max(...confidences) - Math.min(...confidences) : 0;
  const tokenCounts = new Map<string, number>();
  for (const run of runs) {
    for (const token of new Set(tokenize(reasoningRunText(run)))) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(runs.length * 0.6));
  const consensusTerms = [...tokenCounts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 20)
    .map(([term, count]) => ({ term, providers: count }));
  const divergentPairs = pairs
    .filter((pair) => Number(pair.agreement ?? 0) < 0.35)
    .sort((left, right) => Number(left.agreement ?? 0) - Number(right.agreement ?? 0))
    .slice(0, 8);
  return {
    receiptId,
    bundleHash: receipt.bundle_hash,
    runCount: runs.length,
    providerCount: new Set(runs.map((run) => run.provider_label)).size,
    averageAgreement: Number(averageAgreement.toFixed(3)),
    confidenceSpread: Number(confidenceSpread.toFixed(3)),
    consensusTerms,
    divergentPairs,
    needsAdjudication: runs.length >= 2 && (averageAgreement < 0.45 || confidenceSpread > 0.3),
    runs: runs.map((run) => ({
      id: run.id,
      provider: run.provider_label,
      model: run.model_label,
      client: run.client_label,
      status: run.status,
      summary: run.response_summary,
      confidence: run.confidence,
      rating: run.rating,
      completedAt: run.completed_at,
      memoryProposalId: run.memory_proposal_id,
    })),
  };
}
