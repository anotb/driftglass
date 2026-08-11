import {
  getSetting,
  listItemsMissingLineage,
  listStoryLineageCandidates,
  upsertEvidenceLineage,
} from "./db";
import { jaccard } from "./scoring";
import type { Env, ItemRecord, SourceRecord } from "./types";
import { parseJson } from "./utils";

interface LineageCandidate {
  item_id: string;
  source_id: string;
  source_kind: string;
  source_config_json: string;
  title: string;
  text: string;
  canonical_url: string | null;
  observed_at: string;
  family_key: string | null;
  origin_item_id: string | null;
  origin_family_key: string | null;
  relation: string | null;
}

function hostname(value: string | null | undefined): string | undefined {
  try { return value ? new URL(value).hostname.replace(/^www\./, "").toLowerCase() : undefined; }
  catch { return undefined; }
}

export function evidenceFamilyKey(input: {
  item: Pick<ItemRecord, "url" | "canonical_url" | "author" | "metadata_json" | "source_id">;
  source: Pick<SourceRecord, "kind" | "config_json" | "id">;
}): string {
  const metadata = parseJson<Record<string, unknown>>(input.item.metadata_json, {});
  const config = parseJson<Record<string, unknown>>(input.source.config_json, {});
  const explicit = [metadata.sourceFamily, metadata.publisher, metadata.publisherDomain, config.sourceFamily]
    .find((value) => typeof value === "string" && value.trim());
  if (typeof explicit === "string") return explicit.trim().toLowerCase().slice(0, 240);

  const repository = typeof metadata.repository === "string" ? metadata.repository.trim().toLowerCase() : "";
  if (repository) return `github:${repository}`;
  const packageName = typeof metadata.package === "string" ? metadata.package.trim().toLowerCase() : "";
  if (packageName) return `${input.source.kind}:${packageName}`;

  const domain = hostname(input.item.canonical_url || input.item.url);
  const subreddit = typeof metadata.subreddit === "string"
    ? metadata.subreddit.trim().toLowerCase().replace(/^r\//, "")
    : "";
  if (domain && subreddit) return `${domain}:r/${subreddit}`;
  const author = input.item.author?.trim().toLowerCase().replace(/^@/, "");
  if (domain && author && ["collector", "bluesky"].includes(input.source.kind)) return `${domain}:${author}`;
  return domain ?? `source:${input.item.source_id || input.source.id}`;
}

function bodySimilarity(left: string, right: string): number {
  const a = left.replace(/\s+/g, " ").trim().slice(0, 12_000);
  const b = right.replace(/\s+/g, " ").trim().slice(0, 12_000);
  if (!a || !b) return 0;
  return jaccard(a, b);
}

function lineageScore(titleSimilarity: number, textSimilarity: number): number {
  return titleSimilarity * 0.58 + textSimilarity * 0.42;
}

async function classifyEvidenceLineageEnabled(
  env: Env,
  input: { storyId: string; item: ItemRecord; source: SourceRecord },
): Promise<void> {
  const familyKey = evidenceFamilyKey(input);
  const candidates = await listStoryLineageCandidates(env.DB, input.storyId, input.item.id, 24) as LineageCandidate[];
  if (!candidates.length) {
    await upsertEvidenceLineage(env.DB, {
      itemId: input.item.id,
      storyId: input.storyId,
      familyKey,
      relation: "origin",
      independent: true,
      rationale: "First evidence item in this Story cluster.",
    });
    return;
  }

  const ranked = candidates.map((candidate) => {
    const titleSimilarity = jaccard(input.item.title, candidate.title);
    const textSimilarity = bodySimilarity(input.item.text, candidate.text);
    return { candidate, titleSimilarity, textSimilarity, score: lineageScore(titleSimilarity, textSimilarity) };
  }).sort((left, right) => right.score - left.score || right.titleSimilarity - left.titleSimilarity);
  const best = ranked[0]!;
  const sameCanonical = Boolean(input.item.canonical_url && best.candidate.canonical_url === input.item.canonical_url);
  const sameFamily = (best.candidate.family_key ?? evidenceFamilyKey({
    item: {
      url: best.candidate.canonical_url,
      canonical_url: best.candidate.canonical_url,
      author: null,
      metadata_json: "{}",
      source_id: best.candidate.source_id,
    },
    source: { id: best.candidate.source_id, kind: best.candidate.source_kind as SourceRecord["kind"], config_json: best.candidate.source_config_json },
  })) === familyKey;
  const strongEcho = best.titleSimilarity >= 0.88 || best.textSimilarity >= 0.72 || best.score >= 0.8;
  const update = sameCanonical || (sameFamily && best.score >= 0.62);
  const relation = update ? "update" : strongEcho ? "echo" : "origin";
  const originItemId = relation === "origin"
    ? null
    : best.candidate.origin_item_id ?? best.candidate.item_id;
  const originFamilyKey = relation === "origin"
    ? null
    : best.candidate.origin_family_key ?? best.candidate.family_key ?? familyKey;
  const independent = relation === "origin" || (relation === "update" && !sameFamily);
  const rationale = relation === "echo"
    ? `Likely repeated coverage: title similarity ${best.titleSimilarity.toFixed(2)}, body similarity ${best.textSimilarity.toFixed(2)}.`
    : relation === "update"
      ? `Likely update from the same evidence family${sameCanonical ? " and canonical URL" : ""}.`
      : "No sufficiently similar earlier evidence item was found in this Story cluster.";

  await upsertEvidenceLineage(env.DB, {
    itemId: input.item.id,
    storyId: input.storyId,
    familyKey,
    originItemId,
    originFamilyKey,
    relation,
    titleSimilarity: best.titleSimilarity,
    bodySimilarity: best.textSimilarity,
    independent,
    rationale,
  });
}

export async function classifyEvidenceLineage(
  env: Env,
  input: { storyId: string; item: ItemRecord; source: SourceRecord },
): Promise<void> {
  if ((await getSetting(env.DB, "evidence_lineage_enabled")) === "0") return;
  await classifyEvidenceLineageEnabled(env, input);
}

export async function backfillEvidenceLineage(
  env: Env,
  limit = 12,
): Promise<{ processed: number; failed: number }> {
  if ((await getSetting(env.DB, "evidence_lineage_enabled")) === "0") return { processed: 0, failed: 0 };
  const boundedLimit = Math.max(1, Math.min(12, Math.floor(Number.isFinite(limit) ? limit : 12)));
  const records = await listItemsMissingLineage(env.DB, boundedLimit);
  let processed = 0;
  let failed = 0;
  for (const record of records) {
    try {
      await classifyEvidenceLineageEnabled(env, {
        storyId: record.story_id,
        item: record.item,
        source: record.source,
      });
      processed += 1;
    } catch (error) {
      failed += 1;
      console.error(`Evidence lineage backfill failed for ${record.item.id}`, error);
    }
  }
  return { processed, failed };
}
