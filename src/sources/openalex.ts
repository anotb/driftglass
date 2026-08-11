import type { NormalizedItemInput, SourceAdapterResult, SourceRecord } from "../types";
import { fetchWithTimeout, normalizeStringArray, numberFrom, parseJson, readBoundedResponseJson } from "../utils";

const MAX_OPENALEX_RESPONSE_BYTES = 8_000_000;
const MAX_OPENALEX_SINGLETON_BYTES = 1_000_000;
const MAX_OPENALEX_DIRECT_WORKS = 20;

export const OPENALEX_API_KEY_BINDING = "OPENALEX_API_KEY";

export interface OpenAlexConfig extends Record<string, unknown> {
  query?: string;
  concepts?: string[];
  /** Bounded OpenAlex Work IDs (`W…`) use the zero-cost, authenticated singleton endpoint. */
  workIds?: string[];
  limit?: number;
  sort?: "publication_date:desc" | "cited_by_count:desc" | "relevance_score:desc";
  fromPublicationDate?: string;
  openAccessOnly?: boolean;
  evidenceRole?: string;
  estimatedItemsPerRun?: number;
}

interface OpenAlexWork {
  id?: string;
  doi?: string;
  title?: string;
  publication_date?: string;
  cited_by_count?: number;
  type?: string;
  abstract_inverted_index?: Record<string, number[]> | null;
  authorships?: Array<{ author?: { display_name?: string }; institutions?: Array<{ display_name?: string }> }>;
  primary_location?: { landing_page_url?: string; pdf_url?: string; source?: { display_name?: string } };
  primary_topic?: { display_name?: string; subfield?: { display_name?: string }; field?: { display_name?: string } };
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string };
  relevance_score?: number;
}

export interface OpenAlexAccessStatus {
  mode: "search" | "direct";
  runnable: boolean;
  authenticated: boolean;
  binding?: typeof OPENALEX_API_KEY_BINDING;
  detail: string;
}

export class OpenAlexPrerequisiteError extends Error {
  readonly code = "OPENALEX_API_KEY_REQUIRED";
  readonly status = 424;
  readonly binding = OPENALEX_API_KEY_BINDING;
  readonly details = {
    code: this.code,
    binding: this.binding,
    action: "Create or reuse a free OpenAlex account key and add it as the OPENALEX_API_KEY Worker secret, then rerun the source.",
    documentation: "https://developers.openalex.org/guides/authentication",
  };

  constructor() {
    super(
      "OpenAlex collection is waiting for the optional OPENALEX_API_KEY Worker secret. "
      + "OpenAlex requires a key for every API request; add a free OpenAlex key, then rerun this source. "
      + "Other Driftglass sources continue normally.",
    );
    this.name = "OpenAlexPrerequisiteError";
  }
}

export class OpenAlexRateLimitError extends Error {
  readonly code = "OPENALEX_RATE_LIMITED";
  readonly status = 429;
  readonly details: Record<string, unknown>;

  constructor(mode: "search" | "direct", readonly retryAfterSeconds?: number) {
    super(
      `OpenAlex ${mode} reached its API allowance (HTTP 429). Check OpenAlex usage or wait for the allowance to reset; `
      + "the configured key was not logged or stored.",
    );
    this.name = "OpenAlexRateLimitError";
    this.details = {
      code: this.code,
      action: "Check the OpenAlex usage dashboard and retry after the allowance resets.",
      documentation: "https://developers.openalex.org/guides/rate-limits-and-authentication",
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
}

export class OpenAlexCredentialError extends Error {
  readonly code = "OPENALEX_API_KEY_REJECTED";
  readonly details: Record<string, unknown>;

  constructor(readonly status: 401 | 403) {
    super(
      `OpenAlex rejected the configured API key (HTTP ${status}). Replace the OPENALEX_API_KEY Worker secret with a valid key, then rerun this source.`,
    );
    this.name = "OpenAlexCredentialError";
    this.details = {
      code: this.code,
      binding: OPENALEX_API_KEY_BINDING,
      action: "Replace the OPENALEX_API_KEY Worker secret with a valid OpenAlex account key.",
      documentation: "https://developers.openalex.org/guides/authentication",
    };
  }
}

export class OpenAlexUpstreamError extends Error {
  readonly code = "OPENALEX_UPSTREAM_ERROR";
  readonly status = 502;
  readonly details: Record<string, unknown>;

  constructor(mode: "search" | "direct", upstreamStatus?: number) {
    super(upstreamStatus
      ? `OpenAlex ${mode} returned HTTP ${upstreamStatus}. Retry later or inspect OpenAlex service status.`
      : `OpenAlex ${mode} request failed before a response was received.`);
    this.name = "OpenAlexUpstreamError";
    this.details = {
      code: this.code,
      action: "Retry later and inspect OpenAlex service status if the failure persists.",
      documentation: "https://status.openalex.org/",
    };
  }
}

function normalizeOpenAlexWorkIds(value: unknown): string[] {
  const ids = normalizeStringArray(value).map((entry) => {
    const match = entry.trim().match(/^(?:https:\/\/(?:api\.)?openalex\.org\/(?:works\/)?){0,1}(W\d+)\/?$/i);
    if (!match?.[1]) {
      throw new Error("OpenAlex workIds must contain only OpenAlex Work IDs such as W2741809807");
    }
    return match[1].toUpperCase();
  });
  return [...new Set(ids)].slice(0, MAX_OPENALEX_DIRECT_WORKS);
}

const OPENALEX_CONFIG_KEYS = new Set([
  "query",
  "concepts",
  "workIds",
  "limit",
  "sort",
  "fromPublicationDate",
  "openAccessOnly",
  // Non-adapter Pack metadata used by evidence policy and cost projection.
  "evidenceRole",
  "estimatedItemsPerRun",
]);

/**
 * OpenAlex credentials are Worker secrets, never source configuration. A
 * strict allowlist is the final defense against both obvious and nested future
 * credential fields entering a source, profile, Lens, Pack, or overlay row.
 */
export function normalizeOpenAlexConfig(config: Record<string, unknown>): OpenAlexConfig {
  if (Object.keys(config).some((key) => !OPENALEX_CONFIG_KEYS.has(key))) {
    throw new Error(
      "OpenAlex source configuration contains an unsupported field. Credentials must use the optional "
      + "OPENALEX_API_KEY Worker secret and cannot be stored in source configuration.",
    );
  }
  const invalidShape = (
    (config.query !== undefined && typeof config.query !== "string")
    || (config.concepts !== undefined && (!Array.isArray(config.concepts) || config.concepts.some((value) => typeof value !== "string")))
    || (config.workIds !== undefined && (!Array.isArray(config.workIds) || config.workIds.some((value) => typeof value !== "string")))
    || (config.sort !== undefined && typeof config.sort !== "string")
    || (config.fromPublicationDate !== undefined && typeof config.fromPublicationDate !== "string")
    || (config.openAccessOnly !== undefined && typeof config.openAccessOnly !== "boolean")
    || (config.evidenceRole !== undefined && typeof config.evidenceRole !== "string")
    || (config.limit !== undefined && !Number.isFinite(Number(config.limit)))
    || (config.estimatedItemsPerRun !== undefined && !Number.isFinite(Number(config.estimatedItemsPerRun)))
  );
  if (invalidShape) {
    throw new Error("OpenAlex source configuration has an invalid value type; credentials cannot be stored in source configuration.");
  }
  const query = typeof config.query === "string" ? config.query.trim().slice(0, 1_000) : "";
  const concepts = normalizeStringArray(config.concepts).slice(0, 50);
  const workIds = normalizeOpenAlexWorkIds(config.workIds);
  if (workIds.length > 0 && (query || concepts.length > 0)) {
    throw new Error("OpenAlex sources must use either workIds or search terms, not both");
  }
  if (!query && concepts.length === 0 && workIds.length === 0) {
    throw new Error("OpenAlex sources need config.query, config.concepts, or config.workIds");
  }
  const allowedSorts = new Set(["publication_date:desc", "cited_by_count:desc", "relevance_score:desc"]);
  if (config.sort !== undefined && !allowedSorts.has(String(config.sort))) {
    throw new Error("OpenAlex source sort is not supported");
  }
  const fromPublicationDate = typeof config.fromPublicationDate === "string"
    ? config.fromPublicationDate.trim()
    : "";
  if (fromPublicationDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromPublicationDate)) {
    throw new Error("OpenAlex fromPublicationDate must use YYYY-MM-DD");
  }
  const limit = config.limit === undefined ? undefined : Math.max(1, Math.min(100, numberFrom(config.limit, 30)));
  const estimatedItemsPerRun = config.estimatedItemsPerRun === undefined
    ? undefined
    : Math.max(0, Math.min(250, numberFrom(config.estimatedItemsPerRun, 20)));
  return {
    ...(query ? { query } : {}),
    ...(concepts.length ? { concepts } : {}),
    ...(workIds.length ? { workIds } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(config.sort !== undefined ? { sort: String(config.sort) as OpenAlexConfig["sort"] } : {}),
    ...(fromPublicationDate ? { fromPublicationDate } : {}),
    ...(config.openAccessOnly !== undefined ? { openAccessOnly: config.openAccessOnly === true } : {}),
    ...(typeof config.evidenceRole === "string" && config.evidenceRole.trim()
      ? { evidenceRole: config.evidenceRole.trim().slice(0, 80) }
      : {}),
    ...(estimatedItemsPerRun !== undefined ? { estimatedItemsPerRun } : {}),
  };
}

export function assertOpenAlexConfigHasNoEmbeddedSecret(config: Record<string, unknown>): void {
  normalizeOpenAlexConfig(config);
}

export function openAlexAccessStatus(
  rawConfig: Record<string, unknown>,
  apiKey?: string,
): OpenAlexAccessStatus {
  const config = normalizeOpenAlexConfig(rawConfig);
  const query = String(config.query ?? "").trim();
  const concepts = normalizeStringArray(config.concepts);
  const workIds = normalizeOpenAlexWorkIds(config.workIds);
  if (workIds.length > 0) {
    return {
      mode: "direct",
      runnable: Boolean(apiKey?.trim()),
      authenticated: Boolean(apiKey?.trim()),
      ...(!apiKey?.trim() ? { binding: OPENALEX_API_KEY_BINDING } : {}),
      detail: apiKey?.trim()
        ? `${workIds.length} bounded zero-cost direct Work lookup${workIds.length === 1 ? "" : "s"} using authenticated access`
        : `${workIds.length} direct Work lookup${workIds.length === 1 ? "" : "s"} deferred until the optional OPENALEX_API_KEY Worker secret is configured`,
    };
  }
  if (!apiKey?.trim()) {
    return {
      mode: "search",
      runnable: false,
      authenticated: false,
      binding: OPENALEX_API_KEY_BINDING,
      detail: "Search is deferred until the optional OPENALEX_API_KEY Worker secret is configured; OpenAlex requires a key for every request",
    };
  }
  return {
    mode: "search",
    runnable: true,
    authenticated: true,
    detail: "Search uses the private OpenAlex API-key allowance",
  };
}

function abstractFromIndex(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words.push([position, word]);
  }
  return words.sort((left, right) => left[0] - right[0]).map((entry) => entry[1]).join(" ");
}

function normalizedWork(work: OpenAlexWork): NormalizedItemInput {
  const authors = (work.authorships ?? []).map((entry) => entry.author?.display_name).filter((value): value is string => Boolean(value));
  const institutions = [...new Set((work.authorships ?? []).flatMap((entry) => entry.institutions ?? []).map((entry) => entry.display_name).filter((value): value is string => Boolean(value)))];
  const url = work.primary_location?.landing_page_url || work.doi || work.open_access?.oa_url || work.id;
  return {
    externalId: work.id || work.doi,
    url,
    title: work.title || "OpenAlex work",
    text: abstractFromIndex(work.abstract_inverted_index),
    author: authors.join(", "),
    publishedAt: work.publication_date,
    metadata: {
      platform: "openalex",
      doi: work.doi,
      authors,
      institutions,
      citedByCount: work.cited_by_count ?? 0,
      score: work.cited_by_count ?? 0,
      workType: work.type,
      venue: work.primary_location?.source?.display_name,
      pdfUrl: work.primary_location?.pdf_url,
      topic: work.primary_topic?.display_name,
      subfield: work.primary_topic?.subfield?.display_name,
      field: work.primary_topic?.field?.display_name,
      openAccess: work.open_access,
      relevanceScore: work.relevance_score,
    },
  };
}

async function openAlexResponse(
  endpoint: URL,
  apiKey: string | undefined,
  mode: "search" | "direct",
): Promise<Response> {
  const configuredKey = apiKey?.trim();
  if (configuredKey) endpoint.searchParams.set("api_key", configuredKey);
  let response: Response;
  try {
    response = await fetchWithTimeout(endpoint, {
      redirect: "manual",
      headers: { accept: "application/json", "user-agent": "Driftglass/0.9 (personal intelligence)" },
    });
  } catch {
    // Fetch implementations may attach the complete request URL to an error.
    // Never let a query-carried API key cross the adapter boundary.
    throw new OpenAlexUpstreamError(mode);
  }
  if (response.status === 429) {
    const retryAfterSeconds = boundedRetryAfterSeconds(response.headers);
    await response.body?.cancel("OpenAlex rate-limited response discarded").catch(() => undefined);
    throw new OpenAlexRateLimitError(mode, retryAfterSeconds);
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel("OpenAlex credential rejection response discarded").catch(() => undefined);
    throw new OpenAlexCredentialError(response.status);
  }
  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel("OpenAlex error response discarded").catch(() => undefined);
    throw new OpenAlexUpstreamError(mode, status);
  }
  return response;
}

function boundedRetryAfterSeconds(headers: Headers): number | undefined {
  const values = [headers.get("retry-after"), headers.get("x-ratelimit-reset")].filter((value): value is string => Boolean(value));
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      const seconds = numeric > Date.now() / 1_000 - 60 ? numeric - Date.now() / 1_000 : numeric;
      if (seconds > 0) return Math.max(1, Math.min(86_400, Math.ceil(seconds)));
    }
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp) && timestamp > Date.now()) {
      return Math.max(1, Math.min(86_400, Math.ceil((timestamp - Date.now()) / 1_000)));
    }
  }
  return undefined;
}

function safeOpenAlexMeta(meta: Record<string, unknown> | undefined): Record<string, number> {
  const output: Record<string, number> = {};
  for (const key of ["count", "db_response_time_ms", "page", "per_page", "groups_count", "cost_usd"]) {
    const value = Number(meta?.[key]);
    if (Number.isFinite(value)) output[key] = value;
  }
  return output;
}

export async function collectOpenAlex(
  source: SourceRecord,
  env: { OPENALEX_API_KEY?: string } = {},
): Promise<SourceAdapterResult> {
  const rawConfig = parseJson<Record<string, unknown>>(source.config_json, {});
  const config = normalizeOpenAlexConfig(rawConfig);
  const access = openAlexAccessStatus(rawConfig, env.OPENALEX_API_KEY);
  if (!access.runnable) throw new OpenAlexPrerequisiteError();

  const workIds = normalizeOpenAlexWorkIds(config.workIds);
  if (access.mode === "direct") {
    const items: NormalizedItemInput[] = [];
    for (const workId of workIds) {
      const endpoint = new URL(`https://api.openalex.org/works/${encodeURIComponent(workId)}`);
      const response = await openAlexResponse(endpoint, env.OPENALEX_API_KEY, "direct");
      const work = await readBoundedResponseJson<OpenAlexWork>(
        response,
        MAX_OPENALEX_SINGLETON_BYTES,
        "OpenAlex singleton response exceeds 1 MB",
      );
      items.push(normalizedWork(work));
    }
    return {
      items,
      provider: "openalex-api",
      details: { mode: "direct", returned: items.length, access: access.authenticated ? "keyed" : "anonymous-direct" },
    };
  }

  const query = String(config.query ?? "").trim();
  const concepts = normalizeStringArray(config.concepts);
  const limit = Math.max(1, Math.min(100, numberFrom(config.limit, 30)));
  const endpoint = new URL("https://api.openalex.org/works");
  if (query) endpoint.searchParams.set("search", query);
  const filters: string[] = [];
  if (concepts.length) filters.push(`default.search:${concepts.join("|")}`);
  if (config.fromPublicationDate) filters.push(`from_publication_date:${config.fromPublicationDate}`);
  if (config.openAccessOnly) filters.push("is_oa:true");
  if (filters.length) endpoint.searchParams.set("filter", filters.join(","));
  endpoint.searchParams.set("per-page", String(limit));
  endpoint.searchParams.set("sort", config.sort ?? "publication_date:desc");
  endpoint.searchParams.set("select", "id,doi,title,publication_date,cited_by_count,type,abstract_inverted_index,authorships,primary_location,primary_topic,open_access,relevance_score");

  const response = await openAlexResponse(endpoint, env.OPENALEX_API_KEY, "search");
  const payload = await readBoundedResponseJson<{ results?: OpenAlexWork[]; meta?: Record<string, unknown> }>(
    response,
    MAX_OPENALEX_RESPONSE_BYTES,
    "OpenAlex response exceeds 8 MB",
  );
  const items = (payload.results ?? []).slice(0, limit).map(normalizedWork);
  return {
    items,
    provider: "openalex-api",
    details: { mode: "search", query, concepts, returned: items.length, meta: safeOpenAlexMeta(payload.meta), access: "keyed" },
  };
}
