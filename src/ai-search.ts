import {
  getSetting,
  setSetting,
} from "./db";
import type { Env, MissionRecord, StoryRecord } from "./types";
import { requireMonthlyBudget } from "./budget";
import { excerpt, HttpError, isoNow, parseJson } from "./utils";

export const AI_SEARCH_INSTANCE_ID = "driftglass-intelligence";
export const AI_SEARCH_ENABLED_SETTING = "ai_search_enabled";
export const AI_SEARCH_QUERY_OPERATION_RESERVATION = 2;
export const AI_SEARCH_SYNC_PAGE_SIZE = 12;
export const AI_SEARCH_MAX_ATTEMPTS_PER_GENERATION = 2;
export const AI_SEARCH_SYNC_MAX_MATCHES_PER_KEY = 50;
export const AI_SEARCH_SYNC_REPLACE_OPERATION_RESERVATION = AI_SEARCH_SYNC_MAX_MATCHES_PER_KEY + 2;
export const AI_SEARCH_SYNC_DELETE_OPERATION_RESERVATION = AI_SEARCH_SYNC_MAX_MATCHES_PER_KEY + 1;
const AI_SEARCH_SYNC_STATE_SETTING = "ai_search_sync_state_v2";
const AI_SEARCH_INDEXED_KEYS_SETTING = "ai_search_indexed_keys";
const MAX_STORY_DOCS = 180;
const MAX_MISSION_DOCS = 80;

type AISearchDocumentKind = "story" | "mission" | "briefing";

interface AISearchDocumentDescriptor {
  kind: AISearchDocumentKind;
  id: string;
  key: string;
  changedAt: string;
}

interface AISearchDocument {
  key: string;
  content: string;
  metadata: Record<string, string>;
}

interface AISearchPreparedDocument {
  descriptor: AISearchDocumentDescriptor;
  document?: AISearchDocument;
  digest?: string;
}

interface AISearchCycleStats {
  uploaded: number;
  unchanged: number;
  deleted: number;
  counted: Record<string, "uploaded" | "unchanged" | "deleted">;
  failures: Record<string, string>;
  failureAttempts: Record<string, number>;
}

interface AISearchSyncCycle {
  generation: string;
  startedAt: string;
  force: boolean;
  manifest: AISearchDocumentDescriptor[];
  nextDocument: number;
  staleKeys: string[];
  nextStale: number;
  stats: AISearchCycleStats;
}

interface AISearchPersistedSyncState {
  version: 2;
  indexed: Record<string, string>;
  cycle?: AISearchSyncCycle;
}

interface AISearchEvidenceRow {
  story_id: string;
  id: string;
  source_id: string;
  external_id: string | null;
  url: string | null;
  canonical_url: string | null;
  title: string;
  text: string;
  author: string | null;
  published_at: string | null;
  observed_at: string;
  content_hash: string;
  raw_r2_key: string | null;
  access_class: string;
  metadata_json: string;
  created_at: string;
  source_name: string;
  source_kind: string;
  source_health_score: number;
  family_key: string | null;
  lineage_relation: string | null;
  lineage_independent: number | null;
}

interface AISearchMissionRow extends MissionRecord {
  operator_mode: string | null;
  operator_outcome_status: string | null;
  operator_expected_next_event: string | null;
  operator_expected_by: string | null;
  research_current_thesis: string | null;
  research_report_summary: string | null;
  research_open_questions_json: string | null;
}

interface AISearchBriefingRow {
  id: string;
  markdown: string;
  created_at: string;
}

export interface AISearchStatus {
  available: boolean;
  enabled: boolean;
  configured: boolean;
  instanceId: string;
  instance?: Record<string, unknown> | null;
  stats?: Record<string, unknown> | null;
  lastSyncAt?: string | null;
  lastSyncSummary?: Record<string, unknown> | null;
  error?: string;
}

export class AISearchDisabledError extends HttpError {
  readonly code = "AI_SEARCH_DISABLED";

  constructor() {
    super(
      409,
      "AI Search is disabled. Enable it explicitly with POST /api/ai-search/setup before searching or syncing.",
      {
        code: "AI_SEARCH_DISABLED",
        feature: "ai_search",
        setup: "POST /api/ai-search/setup",
      },
    );
    this.name = "AISearchDisabledError";
  }
}

export interface AISearchSyncResult {
  instanceId: string;
  status: "partial" | "complete";
  complete: boolean;
  generation: string;
  phase: "documents" | "stale" | "retry" | "complete";
  uploaded: number;
  unchanged: number;
  failed: Array<{ key: string; error: string; attempts: number; terminal: boolean }>;
  deleted: number;
  processed: number;
  documents: number;
  staleDocuments: number;
  cursor: number;
  total: number;
  remaining: number;
  completedAt: string;
}

export interface AISearchSyncOptions {
  force?: boolean;
  waitForLast?: boolean;
}

async function hashText(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/-{2,}/g, "-").slice(0, 220);
}

function rows<T>(result: D1Result<T>): T[] {
  return result.results ?? [];
}

function storyMarkdown(story: StoryRecord, evidence: readonly AISearchEvidenceRow[]): string {
  return [
    `# ${story.title}`,
    "",
    story.summary,
    "",
    `Story ID: ${story.id}`,
    `First seen: ${story.first_seen_at}`,
    `Last changed: ${story.last_changed_at}`,
    `Score: ${story.score.toFixed(2)}`,
    `Confidence: ${story.confidence.toFixed(2)}`,
    `Sources: ${story.source_count}`,
    "",
    "## Evidence",
    "",
    ...evidence.slice(0, 24).flatMap((item, index) => [
      `### ${index + 1}. ${item.title}`,
      "",
      `Source: ${item.source_name}`,
      item.author ? `Author: ${item.author}` : "",
      `Observed: ${item.published_at ?? item.observed_at}`,
      item.url ? `URL: ${item.url}` : "",
      "",
      excerpt(item.text || item.title, 4_500),
      "",
    ]).filter(Boolean),
  ].join("\n");
}

function missionMarkdown(mission: AISearchMissionRow): string {
  const terms = parseJson<string[]>(mission.terms_json, []);
  const openQuestions = parseJson<string[]>(mission.research_open_questions_json ?? "[]", []);
  return [
    `# Research Mission · ${mission.name}`,
    "",
    mission.question,
    "",
    `Mission ID: ${mission.id}`,
    `Status: ${mission.status}`,
    `Priority: ${mission.priority}`,
    `Terms: ${terms.join(", ")}`,
    mission.operator_mode ? `Mode: ${mission.operator_mode}` : "",
    mission.operator_outcome_status ? `Outcome: ${mission.operator_outcome_status}` : "",
    mission.operator_expected_next_event ? `Expected next event: ${mission.operator_expected_next_event}` : "",
    mission.operator_expected_by ? `Expected by: ${mission.operator_expected_by}` : "",
    "",
    "## Current thesis",
    "",
    mission.research_current_thesis || "No durable thesis has been saved yet.",
    "",
    "## Latest research summary",
    "",
    mission.research_report_summary || "No Deep Research result has been approved yet.",
    "",
    "## Open questions",
    "",
    ...(openQuestions.length ? openQuestions.map((question) => `- ${question}`) : ["- None recorded"]),
    "",
  ].filter(Boolean).join("\n");
}

async function currentDocumentManifest(db: D1Database): Promise<AISearchDocumentDescriptor[]> {
  const [storiesResult, missionsResult, briefing] = await Promise.all([
    db.prepare(
      `SELECT id, last_changed_at FROM stories
       ORDER BY score DESC, last_changed_at DESC, id ASC LIMIT ?`,
    ).bind(MAX_STORY_DOCS).all<{ id: string; last_changed_at: string }>(),
    db.prepare(
      `SELECT id, updated_at FROM missions
       ORDER BY status ASC, priority DESC, updated_at DESC, id ASC LIMIT ?`,
    ).bind(MAX_MISSION_DOCS).all<{ id: string; updated_at: string }>(),
    db.prepare("SELECT id, created_at FROM briefings ORDER BY created_at DESC, id ASC LIMIT 1")
      .first<{ id: string; created_at: string }>(),
  ]);
  return [
    ...rows(storiesResult).map((story): AISearchDocumentDescriptor => ({
      kind: "story",
      id: story.id,
      key: safeKey(`stories/${story.id}.md`),
      changedAt: story.last_changed_at,
    })),
    ...rows(missionsResult).map((mission): AISearchDocumentDescriptor => ({
      kind: "mission",
      id: mission.id,
      key: safeKey(`missions/${mission.id}.md`),
      changedAt: mission.updated_at,
    })),
    ...(briefing ? [{
      kind: "briefing" as const,
      id: briefing.id,
      key: safeKey(`briefings/${briefing.id}.md`),
      changedAt: briefing.created_at,
    }] : []),
  ];
}

async function hydrateStoryDocuments(
  db: D1Database,
  descriptors: readonly AISearchDocumentDescriptor[],
): Promise<Map<string, AISearchDocument>> {
  if (descriptors.length === 0) return new Map();
  const ids = descriptors.map((descriptor) => descriptor.id);
  const encodedIds = JSON.stringify(ids);
  const [storyResult, evidenceResult] = await Promise.all([
    db.prepare(
      `SELECT s.* FROM json_each(?) requested
       JOIN stories s ON s.id = CAST(requested.value AS TEXT)
       ORDER BY CAST(requested.key AS INTEGER)`,
    ).bind(encodedIds).all<StoryRecord>(),
    db.prepare(
      `WITH ranked AS (
         SELECT si.story_id, i.*, s.name AS source_name, s.kind AS source_kind,
                s.health_score AS source_health_score,
                el.family_key, el.relation AS lineage_relation, el.independent AS lineage_independent,
                ROW_NUMBER() OVER (
                  PARTITION BY si.story_id
                  ORDER BY COALESCE(i.published_at, i.observed_at) DESC, i.id ASC
                ) AS evidence_rank
         FROM story_items si
         JOIN items i ON i.id = si.item_id
         JOIN sources s ON s.id = i.source_id
         LEFT JOIN evidence_lineage el ON el.item_id = i.id
         WHERE si.story_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
       )
       SELECT * FROM ranked WHERE evidence_rank <= 24
       ORDER BY story_id ASC, evidence_rank ASC`,
    ).bind(encodedIds).all<AISearchEvidenceRow>(),
  ]);
  const evidenceByStory = new Map<string, AISearchEvidenceRow[]>();
  for (const evidence of rows(evidenceResult)) {
    const group = evidenceByStory.get(evidence.story_id) ?? [];
    group.push(evidence);
    evidenceByStory.set(evidence.story_id, group);
  }
  const descriptorsById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const output = new Map<string, AISearchDocument>();
  for (const story of rows(storyResult)) {
    const descriptor = descriptorsById.get(story.id);
    if (!descriptor) continue;
    output.set(descriptor.key, {
      key: descriptor.key,
      content: storyMarkdown(story, evidenceByStory.get(story.id) ?? []),
      metadata: { kind: "story", record_id: story.id, changed_at: story.last_changed_at },
    });
  }
  return output;
}

async function hydrateMissionDocuments(
  db: D1Database,
  descriptors: readonly AISearchDocumentDescriptor[],
): Promise<Map<string, AISearchDocument>> {
  if (descriptors.length === 0) return new Map();
  const result = await db.prepare(
    `SELECT m.*,
            o.mode AS operator_mode,
            o.outcome_status AS operator_outcome_status,
            o.expected_next_event AS operator_expected_next_event,
            o.expected_by AS operator_expected_by,
            r.current_thesis AS research_current_thesis,
            r.report_summary AS research_report_summary,
            r.open_questions_json AS research_open_questions_json
     FROM json_each(?) requested
     JOIN missions m ON m.id = CAST(requested.value AS TEXT)
     LEFT JOIN mission_operators o ON o.mission_id = m.id
     LEFT JOIN mission_research_state r ON r.mission_id = m.id
     ORDER BY CAST(requested.key AS INTEGER)`,
  ).bind(JSON.stringify(descriptors.map((descriptor) => descriptor.id))).all<AISearchMissionRow>();
  const descriptorsById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const output = new Map<string, AISearchDocument>();
  for (const mission of rows(result)) {
    const descriptor = descriptorsById.get(mission.id);
    if (!descriptor) continue;
    output.set(descriptor.key, {
      key: descriptor.key,
      content: missionMarkdown(mission),
      metadata: { kind: "mission", record_id: mission.id, changed_at: mission.updated_at },
    });
  }
  return output;
}

async function hydrateBriefingDocuments(
  db: D1Database,
  descriptors: readonly AISearchDocumentDescriptor[],
): Promise<Map<string, AISearchDocument>> {
  if (descriptors.length === 0) return new Map();
  const result = await db.prepare(
    `SELECT b.id, b.markdown, b.created_at FROM json_each(?) requested
     JOIN briefings b ON b.id = CAST(requested.value AS TEXT)
     ORDER BY CAST(requested.key AS INTEGER)`,
  ).bind(JSON.stringify(descriptors.map((descriptor) => descriptor.id))).all<AISearchBriefingRow>();
  const descriptorsById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const output = new Map<string, AISearchDocument>();
  for (const briefing of rows(result)) {
    const descriptor = descriptorsById.get(briefing.id);
    if (!descriptor) continue;
    output.set(descriptor.key, {
      key: descriptor.key,
      content: briefing.markdown,
      metadata: { kind: "briefing", record_id: briefing.id, changed_at: briefing.created_at },
    });
  }
  return output;
}

async function hydrateDocuments(
  db: D1Database,
  descriptors: readonly AISearchDocumentDescriptor[],
): Promise<Map<string, AISearchDocument>> {
  const output = new Map<string, AISearchDocument>();
  const groups: Array<[AISearchDocumentKind, typeof hydrateStoryDocuments | typeof hydrateMissionDocuments | typeof hydrateBriefingDocuments]> = [
    ["story", hydrateStoryDocuments],
    ["mission", hydrateMissionDocuments],
    ["briefing", hydrateBriefingDocuments],
  ];
  // Keep cross-kind hydration sequential. Story hydration itself uses two
  // concurrent reads, so this remains well below D1's six-connection ceiling.
  for (const [kind, hydrate] of groups) {
    const hydrated = await hydrate(db, descriptors.filter((descriptor) => descriptor.kind === kind));
    for (const [key, document] of hydrated) output.set(key, document);
  }
  return output;
}

function boundedIndexed(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, digest] of Object.entries(value as Record<string, unknown>).slice(0, 1_000)) {
    if (!/^(stories|missions|briefings)\/[a-z0-9._/-]{1,220}\.md$/.test(key)) continue;
    if (typeof digest === "string" && (digest === "" || /^[a-f0-9]{64}$/.test(digest))) output[key] = digest;
  }
  return output;
}

function boundedManifest(value: unknown): AISearchDocumentDescriptor[] | null {
  if (!Array.isArray(value) || value.length > MAX_STORY_DOCS + MAX_MISSION_DOCS + 1) return null;
  const output: AISearchDocumentDescriptor[] = [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const kind = String(record.kind) as AISearchDocumentKind;
    const id = String(record.id ?? "");
    const key = String(record.key ?? "");
    const changedAt = String(record.changedAt ?? "");
    if (!["story", "mission", "briefing"].includes(kind) || !id || !key || keys.has(key)) return null;
    if (safeKey(`${kind === "story" ? "stories" : kind === "mission" ? "missions" : "briefings"}/${id}.md`) !== key) return null;
    keys.add(key);
    output.push({ kind, id, key, changedAt });
  }
  return output;
}

function boundedStringRecord<T extends string>(value: unknown, allowed?: ReadonlySet<T>): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, T> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 1_000)) {
    if (typeof item !== "string" || (allowed && !allowed.has(item as T))) continue;
    output[key] = item.slice(0, 500) as T;
  }
  return output;
}

function boundedAttemptRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 1_000)) {
    const attempts = Math.floor(Number(item));
    if (!Number.isFinite(attempts) || attempts < 0) continue;
    output[key] = Math.min(AI_SEARCH_MAX_ATTEMPTS_PER_GENERATION, attempts);
  }
  return output;
}

function persistedState(value: string | undefined, legacyKeys: string | undefined): AISearchPersistedSyncState {
  const parsed = parseJson<Record<string, unknown>>(value, {});
  const indexed = Number(parsed.version) === 2
    ? boundedIndexed(parsed.indexed)
    : boundedIndexed(Object.fromEntries(
      parseJson<unknown[]>(legacyKeys, [])
        .filter((key): key is string => typeof key === "string")
        .slice(0, 1_000)
        .map((key) => [key, ""]),
    ));
  if (Number(parsed.version) !== 2 || !parsed.cycle || typeof parsed.cycle !== "object" || Array.isArray(parsed.cycle)) {
    return { version: 2, indexed };
  }
  const raw = parsed.cycle as Record<string, unknown>;
  const manifest = boundedManifest(raw.manifest);
  if (!manifest) return { version: 2, indexed };
  const staleKeys = Array.isArray(raw.staleKeys)
    ? raw.staleKeys.filter((key): key is string => typeof key === "string" && key in indexed).slice(0, 1_000)
    : [];
  const rawStats = raw.stats && typeof raw.stats === "object" && !Array.isArray(raw.stats)
    ? raw.stats as Record<string, unknown>
    : {};
  const counted = boundedStringRecord(
    rawStats.counted,
    new Set<"uploaded" | "unchanged" | "deleted">(["uploaded", "unchanged", "deleted"]),
  );
  const cycleKeys = new Set([...manifest.map((descriptor) => descriptor.key), ...staleKeys]);
  for (const key of Object.keys(counted)) if (!cycleKeys.has(key)) delete counted[key];
  const failures = boundedStringRecord<string>(rawStats.failures);
  for (const key of Object.keys(failures)) {
    if (!cycleKeys.has(key) || key in counted) delete failures[key];
  }
  const failureAttempts = boundedAttemptRecord(rawStats.failureAttempts);
  for (const key of Object.keys(failureAttempts)) {
    if (!cycleKeys.has(key) || !(key in failures)) delete failureAttempts[key];
  }
  // Version-2 state written before bounded retry telemetry had only the error
  // map. Treat those failures as not yet retried so an in-flight generation can
  // advance under the new policy without a state migration.
  for (const key of Object.keys(failures)) failureAttempts[key] ??= 0;
  const countedValues = Object.values(counted);
  const nextDocument = Math.max(0, Math.min(manifest.length, Math.floor(Number(raw.nextDocument) || 0)));
  const nextStale = Math.max(0, Math.min(staleKeys.length, Math.floor(Number(raw.nextStale) || 0)));
  return {
    version: 2,
    indexed,
    cycle: {
      generation: String(raw.generation ?? "") || crypto.randomUUID(),
      startedAt: String(raw.startedAt ?? "") || isoNow(),
      force: raw.force === true,
      manifest,
      nextDocument,
      staleKeys,
      nextStale,
      stats: {
        uploaded: countedValues.filter((outcome) => outcome === "uploaded").length,
        unchanged: countedValues.filter((outcome) => outcome === "unchanged").length,
        deleted: countedValues.filter((outcome) => outcome === "deleted").length,
        counted,
        failures,
        failureAttempts,
      },
    },
  };
}

async function loadPersistedSyncState(db: D1Database): Promise<AISearchPersistedSyncState> {
  const result = await db.prepare(
    "SELECT key, value FROM settings WHERE key IN (?, ?)",
  ).bind(AI_SEARCH_SYNC_STATE_SETTING, AI_SEARCH_INDEXED_KEYS_SETTING).all<{ key: string; value: string }>();
  const settings = Object.fromEntries(rows(result).map((row) => [row.key, row.value]));
  return persistedState(settings[AI_SEARCH_SYNC_STATE_SETTING], settings[AI_SEARCH_INDEXED_KEYS_SETTING]);
}

async function writeSyncSettings(db: D1Database, settings: Record<string, string>): Promise<void> {
  const entries = Object.entries(settings).map(([key, value]) => ({ key, value }));
  if (entries.length === 0) return;
  await db.prepare(
    `INSERT INTO settings(key, value, updated_at)
     SELECT json_extract(entry.value, '$.key'), json_extract(entry.value, '$.value'), ?
     FROM json_each(?) entry
     WHERE true
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(isoNow(), JSON.stringify(entries)).run();
}

async function startSyncCycle(
  db: D1Database,
  state: AISearchPersistedSyncState,
  force: boolean,
): Promise<AISearchSyncCycle> {
  const manifest = await currentDocumentManifest(db);
  const currentKeys = new Set(manifest.map((descriptor) => descriptor.key));
  return {
    generation: crypto.randomUUID(),
    startedAt: isoNow(),
    force,
    manifest,
    nextDocument: 0,
    staleKeys: Object.keys(state.indexed).filter((key) => !currentKeys.has(key)).sort().slice(0, 1_000),
    nextStale: 0,
    stats: { uploaded: 0, unchanged: 0, deleted: 0, counted: {}, failures: {}, failureAttempts: {} },
  };
}

export async function isAISearchEnabled(env: Env): Promise<boolean> {
  return (await getSetting(env.DB, AI_SEARCH_ENABLED_SETTING)) === "enabled";
}

function unavailableError(): HttpError {
  return new HttpError(503, "AI_SEARCH namespace binding is unavailable", {
    code: "AI_SEARCH_UNAVAILABLE",
    feature: "ai_search",
  });
}

async function assertAISearchLocallyAvailable(env: Env, enabledAlready = false): Promise<void> {
  if (!enabledAlready && !await isAISearchEnabled(env)) throw new AISearchDisabledError();
  if (!env.AI_SEARCH) throw unavailableError();
}

async function configuredAISearchInstance(env: Env, enabledAlready = false): Promise<AISearchInstanceBinding> {
  await assertAISearchLocallyAvailable(env, enabledAlready);
  const listed = await env.AI_SEARCH.list({ search: AI_SEARCH_INSTANCE_ID, per_page: 100 });
  if (!(listed.result ?? []).some((instance) => instance.id === AI_SEARCH_INSTANCE_ID)) {
    throw new HttpError(409, "AI Search is enabled but its instance is missing. Run setup again to repair it.", {
      code: "AI_SEARCH_NOT_CONFIGURED",
      feature: "ai_search",
      setup: "POST /api/ai-search/setup",
    });
  }
  return env.AI_SEARCH.get(AI_SEARCH_INSTANCE_ID);
}

export async function assertAISearchEnabled(env: Env): Promise<void> {
  if (!await isAISearchEnabled(env)) throw new AISearchDisabledError();
}

export async function setupAISearch(env: Env): Promise<AISearchInstanceBinding> {
  if (!env.AI_SEARCH) throw unavailableError();
  const listed = await env.AI_SEARCH.list({ search: AI_SEARCH_INSTANCE_ID, per_page: 100 });
  if (!(listed.result ?? []).some((instance) => instance.id === AI_SEARCH_INSTANCE_ID)) {
    await env.AI_SEARCH.create({
      id: AI_SEARCH_INSTANCE_ID,
      index_method: { vector: true, keyword: true },
      fusion_method: "rrf",
      indexing_options: { keyword_tokenizer: "porter" },
      retrieval_options: { keyword_match_mode: "and" },
      reranking: true,
      reranking_model: "@cf/baai/bge-reranker-base",
      chunk_size: 640,
      // Current AI Search treats overlap as a percentage, bounded to 0–30.
      chunk_overlap: 15,
      max_num_results: 20,
      custom_metadata: [
        { field_name: "kind", data_type: "text" },
        { field_name: "record_id", data_type: "text" },
        { field_name: "changed_at", data_type: "datetime" },
      ],
    });
  }
  await setSetting(env.DB, AI_SEARCH_ENABLED_SETTING, "enabled");
  return env.AI_SEARCH.get(AI_SEARCH_INSTANCE_ID);
}

export async function aiSearchStatus(env: Env): Promise<AISearchStatus> {
  const enabled = await isAISearchEnabled(env);
  if (!env.AI_SEARCH) {
    return { available: false, enabled, configured: false, instanceId: AI_SEARCH_INSTANCE_ID, error: "AI_SEARCH binding is unavailable" };
  }
  try {
    const listed = await env.AI_SEARCH.list({ search: AI_SEARCH_INSTANCE_ID, per_page: 100 });
    const instance = (listed.result ?? []).find((entry) => entry.id === AI_SEARCH_INSTANCE_ID) ?? null;
    const lastSyncAt = await getSetting(env.DB, "ai_search_last_sync_at");
    const lastSyncSummary = parseJson<Record<string, unknown> | null>(await getSetting(env.DB, "ai_search_last_sync_summary"), null);
    let stats: Record<string, unknown> | null = null;
    if (instance) stats = await env.AI_SEARCH.get(AI_SEARCH_INSTANCE_ID).stats().catch(() => null);
    return {
      available: true,
      enabled,
      configured: Boolean(instance),
      instanceId: AI_SEARCH_INSTANCE_ID,
      instance,
      stats,
      lastSyncAt,
      lastSyncSummary,
      error: enabled && !instance ? "AI Search is enabled but its instance is missing. Run setup again to repair it." : undefined,
    };
  } catch (error) {
    return {
      available: true,
      enabled,
      configured: false,
      instanceId: AI_SEARCH_INSTANCE_ID,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function replaceDocument(
  instance: AISearchInstanceBinding,
  doc: AISearchDocument,
  waitForCompletion = false,
): Promise<void> {
  const existing = await instance.items.list({
    search: doc.key,
    source: "builtin",
    per_page: AI_SEARCH_SYNC_MAX_MATCHES_PER_KEY,
  });
  for (const item of (existing.result ?? []).slice(0, AI_SEARCH_SYNC_MAX_MATCHES_PER_KEY)) {
    if (item.key === doc.key) await instance.items.delete(item.id);
  }
  if (waitForCompletion) {
    await instance.items.uploadAndPoll(doc.key, doc.content, { metadata: doc.metadata, timeoutMs: 60_000 });
  } else {
    await instance.items.upload(doc.key, doc.content, { metadata: doc.metadata });
  }
}

async function deleteDocument(instance: AISearchInstanceBinding, key: string): Promise<void> {
  const existing = await instance.items.list({
    search: key,
    source: "builtin",
    per_page: AI_SEARCH_SYNC_MAX_MATCHES_PER_KEY,
  });
  for (const item of (existing.result ?? []).slice(0, AI_SEARCH_SYNC_MAX_MATCHES_PER_KEY)) {
    if (item.key === key) await instance.items.delete(item.id);
  }
}

function recordOutcome(
  stats: AISearchCycleStats,
  key: string,
  outcome: "uploaded" | "unchanged" | "deleted",
): void {
  if (stats.counted[key]) return;
  stats.counted[key] = outcome;
  stats[outcome] += 1;
  delete stats.failures[key];
  delete stats.failureAttempts[key];
}

function recordFailure(stats: AISearchCycleStats, key: string, error: unknown, prefix = ""): void {
  stats.failures[key] = `${prefix}${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
  stats.failureAttempts[key] = Math.min(
    AI_SEARCH_MAX_ATTEMPTS_PER_GENERATION,
    Math.max(0, Math.floor(stats.failureAttempts[key] ?? 0)) + 1,
  );
}

function retryableFailureKeys(cycle: AISearchSyncCycle): string[] {
  return Object.keys(cycle.stats.failures)
    .filter((key) => Number(cycle.stats.failureAttempts[key] ?? 0) < AI_SEARCH_MAX_ATTEMPTS_PER_GENERATION)
    .sort();
}

function initialPassComplete(cycle: AISearchSyncCycle): boolean {
  return cycle.nextDocument >= cycle.manifest.length && cycle.nextStale >= cycle.staleKeys.length;
}

function syncResult(cycle: AISearchSyncCycle, complete: boolean, completedAt: string): AISearchSyncResult {
  const total = cycle.manifest.length + cycle.staleKeys.length;
  const cursor = cycle.nextDocument + cycle.nextStale;
  const initialComplete = initialPassComplete(cycle);
  const retrying = initialComplete ? retryableFailureKeys(cycle).length : 0;
  const failures = Object.entries(cycle.stats.failures)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, error]) => ({
      key,
      error,
      attempts: Math.max(0, Math.floor(cycle.stats.failureAttempts[key] ?? 0)),
      terminal: initialComplete
        && Number(cycle.stats.failureAttempts[key] ?? 0) >= AI_SEARCH_MAX_ATTEMPTS_PER_GENERATION,
    }));
  return {
    instanceId: AI_SEARCH_INSTANCE_ID,
    status: complete && failures.length === 0 ? "complete" : "partial",
    complete,
    generation: cycle.generation,
    phase: complete
      ? "complete"
      : cycle.nextDocument < cycle.manifest.length
        ? "documents"
        : cycle.nextStale < cycle.staleKeys.length
          ? "stale"
          : "retry",
    uploaded: cycle.stats.uploaded,
    unchanged: cycle.stats.unchanged,
    failed: failures,
    deleted: cycle.stats.deleted,
    processed: Object.keys(cycle.stats.counted).length,
    documents: cycle.manifest.length,
    staleDocuments: cycle.staleKeys.length,
    cursor,
    total,
    remaining: Math.max(0, total - cursor) + retrying,
    completedAt,
  };
}

async function prepareDocumentDescriptors(
  db: D1Database,
  descriptors: readonly AISearchDocumentDescriptor[],
): Promise<AISearchPreparedDocument[]> {
  const hydrated = await hydrateDocuments(db, descriptors);
  return Promise.all(descriptors.map(async (descriptor) => {
    const document = hydrated.get(descriptor.key);
    return {
      descriptor,
      document,
      digest: document ? await hashText(document.content) : undefined,
    };
  }));
}

function preparedDocumentReservationUnits(
  state: AISearchPersistedSyncState,
  cycle: AISearchSyncCycle,
  prepared: readonly AISearchPreparedDocument[],
): number {
  return prepared.reduce((units, { descriptor, document, digest }) => {
    if (cycle.stats.counted[descriptor.key]) return units;
    if (!document || !digest) return units + AI_SEARCH_SYNC_DELETE_OPERATION_RESERVATION;
    if (!cycle.force && state.indexed[descriptor.key] === digest) return units;
    return units + AI_SEARCH_SYNC_REPLACE_OPERATION_RESERVATION;
  }, 0);
}

function staleKeyReservationUnits(cycle: AISearchSyncCycle, keys: readonly string[]): number {
  return keys.reduce(
    (units, key) => units + (cycle.stats.counted[key] ? 0 : AI_SEARCH_SYNC_DELETE_OPERATION_RESERVATION),
    0,
  );
}

async function processPreparedDocumentDescriptors(
  instance: AISearchInstanceBinding,
  state: AISearchPersistedSyncState,
  cycle: AISearchSyncCycle,
  prepared: readonly AISearchPreparedDocument[],
  waitForLast: boolean,
): Promise<void> {
  const lastUploadKey = [...prepared].reverse().find(({ descriptor, document, digest }) => (
    !cycle.stats.counted[descriptor.key]
    && Boolean(document)
    && (cycle.force || state.indexed[descriptor.key] !== digest)
  ))?.descriptor.key;

  for (const { descriptor, document, digest } of prepared) {
    if (cycle.stats.counted[descriptor.key]) continue;
    try {
      if (!document || !digest) {
        await deleteDocument(instance, descriptor.key);
        delete state.indexed[descriptor.key];
        recordOutcome(cycle.stats, descriptor.key, "deleted");
      } else if (!cycle.force && state.indexed[descriptor.key] === digest) {
        recordOutcome(cycle.stats, descriptor.key, "unchanged");
      } else {
        await replaceDocument(
          instance,
          document,
          waitForLast && descriptor.key === lastUploadKey,
        );
        state.indexed[descriptor.key] = digest;
        recordOutcome(cycle.stats, descriptor.key, "uploaded");
      }
    } catch (error) {
      recordFailure(cycle.stats, descriptor.key, error);
    }
  }
}

async function processStaleKeys(
  instance: AISearchInstanceBinding,
  state: AISearchPersistedSyncState,
  cycle: AISearchSyncCycle,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    if (cycle.stats.counted[key]) continue;
    try {
      await deleteDocument(instance, key);
      delete state.indexed[key];
      recordOutcome(cycle.stats, key, "deleted");
    } catch (error) {
      recordFailure(cycle.stats, key, error, "delete: ");
    }
  }
}

async function syncAISearchPageInternal(
  env: Env,
  options: AISearchSyncOptions,
  enabledAlready: boolean,
): Promise<AISearchSyncResult> {
  await assertAISearchLocallyAvailable(env, enabledAlready);
  const state = await loadPersistedSyncState(env.DB);
  if (!state.cycle || (options.force === true && !state.cycle.force)) {
    state.cycle = await startSyncCycle(env.DB, state, options.force === true);
  }
  const cycle = state.cycle;

  let phase: "documents" | "stale" | "retry";
  let prepared: AISearchPreparedDocument[] = [];
  let staleKeys: string[] = [];
  let documentAdvance = 0;
  let staleAdvance = 0;

  if (cycle.nextDocument < cycle.manifest.length) {
    phase = "documents";
    const descriptors = cycle.manifest.slice(
      cycle.nextDocument,
      cycle.nextDocument + AI_SEARCH_SYNC_PAGE_SIZE,
    );
    prepared = await prepareDocumentDescriptors(env.DB, descriptors);
    // Cursor progress is independent of individual remote item failures. Failed
    // keys receive one bounded retry after the initial manifest/stale pass.
    documentAdvance = descriptors.length;
  } else if (cycle.nextStale < cycle.staleKeys.length) {
    phase = "stale";
    staleKeys = cycle.staleKeys.slice(cycle.nextStale, cycle.nextStale + AI_SEARCH_SYNC_PAGE_SIZE);
    staleAdvance = staleKeys.length;
  } else {
    phase = "retry";
    const retryKeys = retryableFailureKeys(cycle).slice(0, AI_SEARCH_SYNC_PAGE_SIZE);
    const descriptorsByKey = new Map(cycle.manifest.map((descriptor) => [descriptor.key, descriptor]));
    const documentDescriptors = retryKeys.flatMap((key) => {
      const descriptor = descriptorsByKey.get(key);
      return descriptor ? [descriptor] : [];
    });
    prepared = await prepareDocumentDescriptors(env.DB, documentDescriptors);
    staleKeys = retryKeys.filter((key) => !descriptorsByKey.has(key));
  }

  // One unit covers the namespace lookup. Each replacement reserves one item
  // list, at most 50 exact-key deletes, and one upload. Each deletion reserves
  // the same bounded list plus at most 50 deletes. Reservations are retained on
  // failure because the binding may have committed work before reporting it.
  const reservedOperations = 1
    + preparedDocumentReservationUnits(state, cycle, prepared)
    + staleKeyReservationUnits(cycle, staleKeys);
  await requireMonthlyBudget(env.DB, "ai_search_queries", reservedOperations, {
    operation: "ai-search-sync",
    generation: cycle.generation,
    phase,
    documents: prepared.length,
    staleDocuments: staleKeys.length,
    bindingOperationReservation: reservedOperations,
  });

  const instance = await configuredAISearchInstance(env, true);
  await processPreparedDocumentDescriptors(
    instance,
    state,
    cycle,
    prepared,
    options.waitForLast === true,
  );
  await processStaleKeys(instance, state, cycle, staleKeys);
  cycle.nextDocument += documentAdvance;
  cycle.nextStale += staleAdvance;

  const complete = initialPassComplete(cycle) && retryableFailureKeys(cycle).length === 0;
  const result = syncResult(cycle, complete, isoNow());
  if (complete) state.cycle = undefined;
  const settings: Record<string, string> = {
    [AI_SEARCH_SYNC_STATE_SETTING]: JSON.stringify(state),
    ai_search_last_sync_summary: JSON.stringify(result),
  };
  if (complete) {
    settings.ai_search_last_sync_at = result.completedAt;
    settings[AI_SEARCH_INDEXED_KEYS_SETTING] = JSON.stringify(Object.keys(state.indexed).sort());
  }
  await writeSyncSettings(env.DB, settings);
  return result;
}

export async function syncAISearchPage(
  env: Env,
  options: AISearchSyncOptions = {},
): Promise<AISearchSyncResult> {
  return syncAISearchPageInternal(env, options, false);
}

export async function syncAISearch(
  env: Env,
  options: AISearchSyncOptions = {},
): Promise<AISearchSyncResult> {
  return syncAISearchPage(env, options);
}

export async function syncAISearchIfEnabled(
  env: Env,
  options: AISearchSyncOptions = {},
): Promise<AISearchSyncResult | null> {
  if (!await isAISearchEnabled(env)) return null;
  return syncAISearchPageInternal(env, options, true);
}

export async function semanticSearch(
  env: Env,
  query: string,
  options: { limit?: number; threshold?: number; kind?: string } = {},
): Promise<{ query: string; chunks: AISearchChunk[]; errors?: Array<Record<string, unknown>> }> {
  await assertAISearchLocallyAvailable(env);
  await requireMonthlyBudget(env.DB, "ai_search_queries", AI_SEARCH_QUERY_OPERATION_RESERVATION, {
    operation: "ai-search-query",
    kind: options.kind ?? "all",
    bindingOperationReservation: AI_SEARCH_QUERY_OPERATION_RESERVATION,
  });
  const instance = await configuredAISearchInstance(env, true);
  const filters = options.kind ? { kind: options.kind } : undefined;
  const response = await instance.search({
    query: query.trim().slice(0, 1_000),
    ai_search_options: {
      retrieval: {
        retrieval_type: "hybrid",
        max_num_results: Math.max(1, Math.min(30, options.limit ?? 10)),
        match_threshold: Math.max(0, Math.min(1, options.threshold ?? 0.3)),
        context_expansion: 1,
        fusion_method: "rrf",
        filters,
      },
      reranking: { enabled: true, model: "@cf/baai/bge-reranker-base", match_threshold: 0.3 },
    },
  });
  return { query: response.search_query || query, chunks: response.chunks };
}
