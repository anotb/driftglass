import type { ItemRecord, StoryRecord } from "./types";
import { publicKnowledgeUrl } from "./mcp-knowledge";

export const PUBLIC_SHARE_SCHEMA_VERSION = "2" as const;
export const PUBLIC_SHARE_ROBOTS_DISABLED = "noindex, nofollow";
export const PUBLIC_SHARE_ROBOTS_ENABLED = "index, follow";

export type ShareKind = "story" | "mission" | "briefing";

export interface SharedEvidence {
  accessClass: "public";
  independent: boolean;
  lineageRelation: "origin" | "independent" | "same-family" | "echo" | "update" | "unclassified";
  evidenceFamily?: string;
  source: string;
  title: string;
  url?: string;
  author?: string;
  publishedAt?: string;
  excerpt?: string;
}

export interface SharedStory {
  id: string;
  title: string;
  summary: string;
  evidenceCount: number;
  sourceCount: number;
  sourceFamilyCount: number;
  independentFamilyCount: number;
  echoCount: number;
  confidence: number;
  changedAt: string;
  evidence: SharedEvidence[];
}

export interface PublicSharePayload {
  schemaVersion: typeof PUBLIC_SHARE_SCHEMA_VERSION;
  publicEvidenceOnly: true;
  kind: ShareKind;
  title: string;
  subtitle?: string;
  generatedAt: string;
  context?: Array<{ label: string; value: string }>;
  reviewedAnswer?: ReviewedShareAnswer;
  stories: SharedStory[];
  footer?: string;
}

export interface ReviewedShareAnswer {
  answer?: string;
  whyItMatters?: string;
  keyJudgments?: Array<string | ReviewedShareJudgment>;
  options?: Array<{ name: string; tradeoff?: string }>;
  outlook?: string;
  alternativeCase?: string | ReviewedShareJudgment;
  whatWouldChange?: string[];
  signposts?: Array<string | ReviewedShareJudgment>;
  nextSteps?: string[];
  whatToWatch?: string[];
  uncertainty?: string[];
  evidenceSnapshotHash: string;
  reviewedAt: string;
}

export interface ReviewedShareJudgment {
  text: string;
  citationUrls: string[];
}

export interface RecipientEvidence {
  relationship: "Primary evidence" | "Independent evidence" | "Related coverage" | "Repeated coverage" | "Update" | "Lineage not established";
  source: string;
  title: string;
  url?: string;
  author?: string;
  publishedAt?: string;
  excerpt?: string;
}

export interface RecipientStory {
  title: string;
  summary: string;
  evidenceStatus: string;
  evidenceNote: string;
  updatedAt: string;
  evidence: RecipientEvidence[];
}

export interface RecipientShareDocument {
  format: "driftglass.shared-intelligence.v1";
  publicEvidenceOnly: true;
  type: "Shared Story" | "Shared Mission" | "Shared Briefing";
  title: string;
  question?: string;
  generatedAt: string;
  expiresAt?: string;
  reviewedAnswer?: ReviewedShareAnswer;
  stories: RecipientStory[];
}

export type ShareEvidenceRecord = ItemRecord & {
  source_name: string;
  source_kind: string;
  source_health_score: number;
  family_key: string | null;
  lineage_relation: string | null;
  lineage_independent: number | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function publicStringList(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => publicExcerpt(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
  return output.length ? output : undefined;
}

function publicFlexibleStringList(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  return publicStringList(typeof value === "string" ? [value] : value, maxItems, maxLength);
}

function publicReviewedJudgments(
  value: unknown,
  allowedCitationUrls?: ReadonlySet<string>,
): ReviewedShareAnswer["keyJudgments"] {
  if (!Array.isArray(value)) return undefined;
  const output = value.flatMap((item): Array<string | ReviewedShareJudgment> => {
    if (typeof item === "string") {
      const text = publicExcerpt(item, 1_200);
      return text ? [text] : [];
    }
    const input = record(item);
    if (!input || typeof input.text !== "string") return [];
    const text = publicExcerpt(input.text, 1_200);
    if (!text) return [];
    const citationUrls = Array.isArray(input.citationUrls)
      ? [...new Set(input.citationUrls.flatMap((value) => {
        if (typeof value !== "string") return [];
        const publicUrl = storedPublicUrl(value);
        if (!publicUrl || publicUrl !== value) return [];
        if (allowedCitationUrls && !allowedCitationUrls.has(value)) return [];
        return [value];
      }))].slice(0, 3)
      : [];
    return citationUrls.length ? [{ text, citationUrls }] : [text];
  }).slice(0, 8);
  return output.length ? output : undefined;
}

function publicReviewedSection(
  value: unknown,
  maxLength: number,
  allowedCitationUrls?: ReadonlySet<string>,
): string | ReviewedShareJudgment | undefined {
  if (typeof value === "string") {
    const text = publicExcerpt(value, maxLength);
    return text || undefined;
  }
  const input = record(value);
  if (!input || typeof input.text !== "string") return undefined;
  const text = publicExcerpt(input.text, maxLength);
  if (!text) return undefined;
  const citationUrls = Array.isArray(input.citationUrls)
    ? [...new Set(input.citationUrls.flatMap((candidate) => {
      if (typeof candidate !== "string") return [];
      const publicUrl = storedPublicUrl(candidate);
      if (!publicUrl || publicUrl !== candidate) return [];
      if (allowedCitationUrls && !allowedCitationUrls.has(candidate)) return [];
      return [candidate];
    }))].slice(0, 3)
    : [];
  return citationUrls.length ? { text, citationUrls } : text;
}

function publicReviewedSections(
  value: unknown,
  maxItems: number,
  maxLength: number,
  allowedCitationUrls?: ReadonlySet<string>,
): Array<string | ReviewedShareJudgment> | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value
    .flatMap((item) => {
      const section = publicReviewedSection(item, maxLength, allowedCitationUrls);
      return section === undefined ? [] : [section];
    })
    .slice(0, maxItems);
  return output.length ? output : undefined;
}

function publicReviewedOptions(value: unknown): ReviewedShareAnswer["options"] {
  if (!Array.isArray(value)) return undefined;
  const output = value.flatMap((item) => {
    const input = record(item);
    if (!input || typeof input.name !== "string") return [];
    const name = publicExcerpt(input.name, 300);
    if (!name) return [];
    const tradeoff = typeof input.tradeoff === "string" ? publicExcerpt(input.tradeoff, 1_200) : "";
    return [{ name, tradeoff: tradeoff || undefined }];
  }).slice(0, 4);
  return output.length ? output : undefined;
}

function storedPublicUrl(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  return publicKnowledgeUrl(value) || null;
}

function decodePublicEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function publicExcerpt(value: string, max: number): string {
  const clean = decodePublicEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[`*~]+/g, "")
    .replace(/(?:^|\s)[#>*_`~-]+(?=\s)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  const clipped = clean.slice(0, Math.max(0, max - 1));
  const boundary = Math.max(clipped.lastIndexOf(". ") + 1, clipped.lastIndexOf("; ") + 1, clipped.lastIndexOf(" "));
  return `${clipped.slice(0, boundary > max * 0.65 ? boundary : clipped.length).trimEnd()}…`;
}

function publicEvidenceConfidence(item: ShareEvidenceRecord): number {
  const health = Number.isFinite(item.source_health_score)
    ? Math.max(0, Math.min(1, item.source_health_score))
    : 0;
  return Math.max(0.35, Math.min(0.95, 0.45 + health * 0.35 + (item.canonical_url ? 0.1 : 0)));
}

export function isPublicShareEvidence(item: Pick<ShareEvidenceRecord, "access_class" | "source_kind">): boolean {
  // Email and collector sources are authenticated/local lanes. Exclude them even if a malformed row
  // was accidentally stamped public; access_class remains the primary boundary for all other lanes.
  return item.access_class === "public" && !["email", "collector"].includes(item.source_kind);
}

/**
 * Rebuild a Story exclusively from public evidence. The stored Story title, summary, score, confidence,
 * change time, and source count may all have been influenced by authenticated evidence, so none of them
 * are copied into the public schema.
 */
export function projectPublicStory(
  detail: { story: Pick<StoryRecord, "id">; evidence: ShareEvidenceRecord[] },
  evidenceLimit = 8,
): SharedStory | null {
  const publicItems = detail.evidence.filter(isPublicShareEvidence);
  if (!publicItems.length) return null;

  let changedAt = "";
  let confidence = 0.35;
  const sourceIds = new Set<string>();
  const knownFamilies = new Set<string>();
  const independentFamilies = new Set<string>();
  let hasUnclassifiedFamily = false;
  let echoCount = 0;

  for (const item of publicItems) {
    if (item.observed_at > changedAt) changedAt = item.observed_at;
    confidence = Math.max(confidence, publicEvidenceConfidence(item));
    sourceIds.add(item.source_id);

    const family = item.family_key?.trim();
    if (family) {
      knownFamilies.add(family);
      if (Number(item.lineage_independent) === 1) independentFamilies.add(family);
    } else {
      // Missing lineage is grouped conservatively and is never claimed as independent.
      hasUnclassifiedFamily = true;
    }
    if (item.lineage_relation === "echo") echoCount += 1;
  }

  const rankedItems = [...publicItems].sort((left, right) => {
    const score = (item: ShareEvidenceRecord): number =>
      (item.lineage_relation === "origin" ? 3 : item.lineage_relation === "independent" ? 2 : 0) +
      (Number(item.lineage_independent) === 1 ? 2 : 0) +
      Math.max(0, Math.min(1, Number(item.source_health_score) || 0)) +
      (item.canonical_url ? 0.5 : 0);
    return score(right) - score(left) || right.observed_at.localeCompare(left.observed_at);
  });
  const lead = rankedItems[0]!;
  const publicTitle = publicExcerpt(lead.title, 240);
  const publicSummary = publicExcerpt(lead.text || lead.title, 700);
  const limit = Math.max(1, Math.min(24, Math.floor(evidenceLimit)));
  return {
    id: detail.story.id,
    title: publicTitle || "Public evidence update",
    summary: publicSummary || publicTitle || "Public evidence collected by Driftglass.",
    evidenceCount: publicItems.length,
    sourceCount: sourceIds.size,
    sourceFamilyCount: knownFamilies.size + (hasUnclassifiedFamily ? 1 : 0),
    independentFamilyCount: independentFamilies.size,
    echoCount,
    confidence: Math.round(confidence * 1_000) / 1_000,
    changedAt: changedAt || new Date(0).toISOString(),
    evidence: rankedItems.slice(0, limit).map((item) => ({
      accessClass: "public",
      independent: Boolean(item.family_key?.trim()) && Number(item.lineage_independent) === 1,
      lineageRelation: (["origin", "independent", "same-family", "echo", "update"] as const).includes(
        item.lineage_relation as "origin" | "independent" | "same-family" | "echo" | "update",
      ) ? item.lineage_relation as "origin" | "independent" | "same-family" | "echo" | "update" : "unclassified",
      evidenceFamily: item.family_key?.trim() || undefined,
      source: publicExcerpt(item.source_name, 120) || "Public source",
      title: publicExcerpt(item.title, 300) || "Public evidence",
      url: publicKnowledgeUrl(item.canonical_url, item.url) || undefined,
      author: item.author ? publicExcerpt(item.author, 160) : undefined,
      publishedAt: item.published_at ?? item.observed_at,
      excerpt: publicExcerpt(item.text || item.title, 480),
    })),
  };
}

function normalizeEvidence(value: unknown): SharedEvidence | null {
  const input = record(value);
  const lineageRelation = String(input?.lineageRelation ?? "");
  if (
    !input || input.accessClass !== "public" || typeof input.independent !== "boolean" ||
    !["origin", "independent", "same-family", "echo", "update", "unclassified"].includes(lineageRelation) ||
    typeof input.source !== "string" || typeof input.title !== "string"
  ) {
    return null;
  }
  const source = publicExcerpt(input.source, 120);
  const title = publicExcerpt(input.title, 300);
  if (!source || !title) return null;
  const url = storedPublicUrl(input.url);
  if (url === null) return null;
  return {
    accessClass: "public",
    independent: input.independent,
    lineageRelation: lineageRelation as SharedEvidence["lineageRelation"],
    evidenceFamily: optionalString(input.evidenceFamily),
    source,
    title,
    url,
    author: optionalString(input.author) ? publicExcerpt(String(input.author), 160) : undefined,
    publishedAt: optionalString(input.publishedAt),
    excerpt: optionalString(input.excerpt) ? publicExcerpt(String(input.excerpt), 480) : undefined,
  };
}

function normalizeStory(value: unknown): SharedStory | null {
  const input = record(value);
  if (!input || typeof input.id !== "string" || typeof input.title !== "string" || typeof input.summary !== "string") return null;
  if (!Array.isArray(input.evidence) || !input.evidence.length) return null;
  const evidence = input.evidence.map(normalizeEvidence);
  if (evidence.some((item) => item === null)) return null;

  const evidenceCount = finiteInteger(input.evidenceCount);
  const sourceCount = finiteInteger(input.sourceCount);
  const sourceFamilyCount = finiteInteger(input.sourceFamilyCount);
  const independentFamilyCount = finiteInteger(input.independentFamilyCount);
  const echoCount = finiteInteger(input.echoCount);
  const confidence = finiteNumber(input.confidence);
  if (
    evidenceCount === null || evidenceCount < evidence.length ||
    sourceCount === null || sourceCount < 1 || sourceCount > evidenceCount ||
    sourceFamilyCount === null || sourceFamilyCount < 1 || sourceFamilyCount > evidenceCount ||
    independentFamilyCount === null || independentFamilyCount < 0 || independentFamilyCount > sourceFamilyCount ||
    echoCount === null || echoCount < 0 || echoCount > evidenceCount ||
    confidence === null || confidence < 0 || confidence > 1 ||
    typeof input.changedAt !== "string"
  ) return null;

  const title = publicExcerpt(input.title, 240);
  const summary = publicExcerpt(input.summary, 700);
  if (!title || !summary) return null;
  return {
    id: input.id,
    title,
    summary,
    evidenceCount,
    sourceCount,
    sourceFamilyCount,
    independentFamilyCount,
    echoCount,
    confidence,
    changedAt: input.changedAt,
    evidence: evidence as SharedEvidence[],
  };
}

export function normalizeReviewedShareAnswer(
  value: unknown,
  allowedCitationUrls?: ReadonlySet<string>,
): ReviewedShareAnswer | null {
  const input = record(value);
  if (
    !input || typeof input.evidenceSnapshotHash !== "string" || !/^[a-f0-9]{64}$/i.test(input.evidenceSnapshotHash) ||
    typeof input.reviewedAt !== "string" || !Number.isFinite(Date.parse(input.reviewedAt))
  ) return null;
  const answer = optionalString(input.answer) ? publicExcerpt(String(input.answer), 2_400) : undefined;
  const whyItMatters = optionalString(input.whyItMatters) ? publicExcerpt(String(input.whyItMatters), 1_600) : undefined;
  const keyJudgments = publicReviewedJudgments(input.keyJudgments, allowedCitationUrls);
  const options = publicReviewedOptions(input.options);
  const outlook = optionalString(input.outlook) ? publicExcerpt(String(input.outlook), 2_400) : undefined;
  const alternativeCase = publicReviewedSection(input.alternativeCase, 2_400, allowedCitationUrls);
  const whatWouldChange = publicFlexibleStringList(input.whatWouldChange, 8, 1_200);
  const signposts = publicReviewedSections(input.signposts, 8, 1_200, allowedCitationUrls);
  const nextSteps = publicFlexibleStringList(input.nextSteps, 8, 1_200);
  const whatToWatch = publicStringList(input.whatToWatch, 8, 600);
  const uncertainty = publicStringList(input.uncertainty, 8, 600);
  if (
    !answer && !whyItMatters && !keyJudgments?.length && !options?.length && !outlook && !alternativeCase &&
    !whatWouldChange?.length && !signposts?.length && !nextSteps?.length && !whatToWatch?.length && !uncertainty?.length
  ) return null;
  return {
    answer,
    whyItMatters,
    ...(keyJudgments ? { keyJudgments } : {}),
    ...(options ? { options } : {}),
    ...(outlook ? { outlook } : {}),
    ...(alternativeCase ? { alternativeCase } : {}),
    ...(whatWouldChange ? { whatWouldChange } : {}),
    ...(signposts ? { signposts } : {}),
    ...(nextSteps ? { nextSteps } : {}),
    whatToWatch,
    uncertainty,
    evidenceSnapshotHash: input.evidenceSnapshotHash.toLowerCase(),
    reviewedAt: input.reviewedAt,
  };
}

/**
 * Parse and reconstruct the allow-listed public schema. Schema v1 rows are deliberately rejected because
 * they do not prove evidence access class and may contain authenticated material.
 */
export function normalizePublicSharePayload(value: unknown): PublicSharePayload | null {
  const input = record(value);
  if (
    !input || input.schemaVersion !== PUBLIC_SHARE_SCHEMA_VERSION || input.publicEvidenceOnly !== true ||
    !["story", "mission", "briefing"].includes(String(input.kind)) ||
    typeof input.title !== "string" || !input.title || typeof input.generatedAt !== "string" ||
    !Array.isArray(input.stories) || !input.stories.length
  ) return null;

  const stories = input.stories.map(normalizeStory);
  if (stories.some((story) => story === null)) return null;
  const reviewedAnswer = input.reviewedAnswer === undefined
    ? undefined
    : normalizeReviewedShareAnswer(input.reviewedAnswer);
  if (input.reviewedAnswer !== undefined && !reviewedAnswer) return null;

  // Legacy v2 Mission context could contain operator conclusions influenced by private evidence.
  // Keep the field in the stored schema for compatibility, but never project it to a recipient.

  const title = publicExcerpt(input.title, 240);
  if (!title) return null;
  return {
    schemaVersion: PUBLIC_SHARE_SCHEMA_VERSION,
    publicEvidenceOnly: true,
    kind: input.kind as ShareKind,
    title,
    subtitle: optionalString(input.subtitle) ? publicExcerpt(String(input.subtitle), 600) : undefined,
    generatedAt: input.generatedAt,
    reviewedAnswer: reviewedAnswer ?? undefined,
    stories: stories as SharedStory[],
    footer: optionalString(input.footer) ? publicExcerpt(String(input.footer), 300) : undefined,
  };
}

function evidenceRelationship(item: SharedEvidence): RecipientEvidence["relationship"] {
  if (item.lineageRelation === "origin") return "Primary evidence";
  if (item.lineageRelation === "independent") return "Independent evidence";
  if (item.lineageRelation === "same-family") return "Related coverage";
  if (item.lineageRelation === "echo") return "Repeated coverage";
  if (item.lineageRelation === "update") return "Update";
  return "Lineage not established";
}

export function publicEvidenceAssessment(story: SharedStory): { status: string; note: string } {
  const repeated = story.echoCount > 0 ? " Repeated coverage is shown separately." : "";
  if (story.independentFamilyCount >= 2) {
    return { status: "Independently corroborated", note: `Multiple independent source families support this finding.${repeated}` };
  }
  if (story.independentFamilyCount === 1 && story.sourceFamilyCount > 1) {
    return { status: "Partially corroborated", note: `One source family is independently classified; other coverage may overlap.${repeated}` };
  }
  if (story.sourceCount > 1) {
    return { status: "Lineage still unclear", note: `Several sources report this, but their independence has not been established.${repeated}` };
  }
  return { status: "Single-source finding", note: `Treat this as provisional until independent evidence appears.${repeated}` };
}

export function recipientShareDocument(payload: PublicSharePayload, expiresAt?: string): RecipientShareDocument {
  payload = requirePublicSharePayload(payload);
  const type: RecipientShareDocument["type"] = payload.kind === "story"
    ? "Shared Story"
    : payload.kind === "mission" ? "Shared Mission" : "Shared Briefing";
  return {
    format: "driftglass.shared-intelligence.v1",
    publicEvidenceOnly: true,
    type,
    title: payload.title,
    question: payload.subtitle,
    generatedAt: payload.generatedAt,
    expiresAt,
    reviewedAnswer: payload.reviewedAnswer,
    stories: payload.stories.map((story) => {
      const assessment = publicEvidenceAssessment(story);
      return {
        title: story.title,
        summary: story.summary,
        evidenceStatus: assessment.status,
        evidenceNote: assessment.note,
        updatedAt: story.changedAt,
        evidence: story.evidence.map((item) => ({
          relationship: evidenceRelationship(item),
          source: item.source,
          title: item.title,
          url: item.url,
          author: item.author,
          publishedAt: item.publishedAt,
          excerpt: item.excerpt,
        })),
      };
    }),
  };
}

export function requirePublicSharePayload(value: unknown): PublicSharePayload {
  const payload = normalizePublicSharePayload(value);
  if (!payload) throw new Error("A public-evidence-only share payload is required");
  return payload;
}

export function publicShareRobotsContent(publicIndexing: boolean): string {
  return publicIndexing ? PUBLIC_SHARE_ROBOTS_ENABLED : PUBLIC_SHARE_ROBOTS_DISABLED;
}

export function publicShareResponseHeaders(
  publicIndexing: boolean,
  initial: HeadersInit = {},
): Headers {
  const headers = new Headers(initial);
  headers.set("x-robots-tag", publicShareRobotsContent(publicIndexing));
  if ((headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
    headers.set(
      "content-security-policy",
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'",
    );
  }
  if (!publicIndexing) headers.set("cache-control", "private, no-store");
  return headers;
}
