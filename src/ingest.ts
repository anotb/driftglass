import {
  advanceItemIngestCompletion,
  claimItemIngestCompletion,
  commitItemStoryIngestStage,
  completeItemIngest,
  countStorySourcesIncluding,
  ensureItemIngestCompletion,
  findExistingItem,
  findStoryForItem,
  findStoryByCanonicalKey,
  findStoryByCanonicalUrl,
  getItemIngestCompletion,
  getSetting,
  getSource,
  getStoryRecord,
  listTasteTerms,
  insertItemWithIngestCompletion,
  recentStories,
  releaseItemIngestCompletionLease,
  renewItemIngestCompletionLease,
  setSetting,
} from "./db";
import { matchStoryToMissions } from "./missions";
import { classifyEvidenceLineage } from "./evidence-lineage";
import { canonicalEvidenceTimestamp } from "./evidence-timestamp";
import { linkedPublicRawR2Key } from "./ingest-queue";
import { putEvidenceObject } from "./r2-budget";
import { canonicalKey, importanceFromMetadata, jaccard, storyScore } from "./scoring";
import { tasteAdjustedRelevance } from "./taste";
import { sha256 } from "./security";
import type {
  Env,
  IngestMessage,
  ItemIngestCompletionRecord,
  ItemRecord,
  SourceRecord,
  StoryRecord,
} from "./types";
import {
  canonicalizeUrl,
  excerpt,
  hoursAgo,
  isoNow,
  normalizeStringArray,
  parseJson,
  safeFilename,
  stableStringify,
} from "./utils";

function clean(value: string | undefined, max: number): string {
  return (value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function ageHours(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, (Date.now() - timestamp) / 3_600_000);
}

async function matchStory(
  env: Env,
  input: { canonicalUrl?: string; title: string; key: string },
): Promise<StoryRecord | null> {
  if (input.canonicalUrl) {
    const urlMatch = await findStoryByCanonicalUrl(env.DB, input.canonicalUrl);
    if (urlMatch) return urlMatch;
  }
  const keyMatch = await findStoryByCanonicalKey(env.DB, input.key);
  if (keyMatch) return keyMatch;

  const candidates = await recentStories(env.DB, hoursAgo(96), 200);
  let best: { story: StoryRecord; similarity: number } | null = null;
  for (const candidate of candidates) {
    const similarity = jaccard(input.title, candidate.title);
    if (similarity >= 0.58 && (!best || similarity > best.similarity)) best = { story: candidate, similarity };
  }
  return best?.story ?? null;
}

async function ingestOriginKeyHash(message: IngestMessage): Promise<string | null> {
  let identity: Record<string, unknown> | null = null;
  if (
    typeof message.sourceRunId === "string" && message.sourceRunId.length > 0 &&
    Number.isSafeInteger(message.sourceRunItemIndex) && Number(message.sourceRunItemIndex) >= 0
  ) {
    identity = {
      kind: "source-run",
      sourceId: message.sourceId,
      runId: message.sourceRunId,
      itemIndex: Number(message.sourceRunItemIndex),
    };
  } else if (message.emailReceiptClaim) {
    identity = {
      kind: "email-receipt",
      sourceId: message.sourceId,
      messageId: message.emailReceiptClaim.messageId,
      claimToken: message.emailReceiptClaim.claimToken,
    };
  } else {
    const rawR2Key = linkedPublicRawR2Key(message);
    if (rawR2Key) identity = { kind: "raw-object", sourceId: message.sourceId, rawR2Key };
  }
  return identity ? sha256(stableStringify(identity)) : null;
}

function insertedOutcome(
  createdInThisCall: boolean,
  originKeyHash: string | null,
  completion: ItemIngestCompletionRecord,
): boolean {
  return createdInThisCall || Boolean(originKeyHash && completion.origin_key_hash === originKeyHash);
}

async function cleanRedundantRawObject(env: Env, message: IngestMessage, item: ItemRecord): Promise<void> {
  const stagedRawR2Key = linkedPublicRawR2Key(message);
  if (!stagedRawR2Key || item.raw_r2_key === stagedRawR2Key) return;
  await env.EVIDENCE.delete(stagedRawR2Key).catch((error) => {
    console.error(JSON.stringify({
      message: "Unable to clean duplicate ingest raw object",
      rawR2Key: stagedRawR2Key,
      itemId: item.id,
      error: error instanceof Error ? error.message : String(error),
    }));
  });
}

function stableLegacyRawId(contentHash: string): string {
  const hex = contentHash.padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function resumeItemIngest(
  env: Env,
  input: {
    item: ItemRecord;
    source: SourceRecord;
    completion: ItemIngestCompletionRecord;
    leaseToken: string;
  },
): Promise<{ story: StoryRecord; completion: ItemIngestCompletionRecord }> {
  const { item, source, leaseToken } = input;
  let completion = input.completion;
  let story = completion.story_id
    ? await getStoryRecord(env.DB, completion.story_id)
    : await findStoryForItem(env.DB, item.id);

  if (completion.stage === 0) {
    const metadata = parseJson<Record<string, unknown>>(item.metadata_json, {});
    const configuredTerms = normalizeStringArray(parseJson<unknown>(await getSetting(env.DB, "interest_terms"), []));
    const itemTerms = normalizeStringArray(metadata.watchTerms);
    const terms = [...new Set([...configuredTerms, ...itemTerms])];
    const learnedTerms = await listTasteTerms(env.DB, 160);
    const relevanceSignal = tasteAdjustedRelevance(`${item.title}\n${item.text}`, terms, learnedTerms);
    const relevance = relevanceSignal.value;
    const importance = importanceFromMetadata(metadata);
    const confidence = Math.max(0.35, Math.min(0.95, 0.45 + source.health_score * 0.35 + (item.canonical_url ? 0.1 : 0)));
    const key = canonicalKey(item.title, item.canonical_url ?? undefined);
    const summary = excerpt(item.text || item.title, 700);
    const matched = story ?? await matchStory(env, {
      canonicalUrl: item.canonical_url ?? undefined,
      title: item.title,
      key,
    });

    if (!matched) {
      const now = isoNow();
      const score = storyScore({
        relevance,
        novelty: 1,
        importance,
        confidence,
        sourceCount: 1,
        sourceWeight: source.weight,
        ageHours: ageHours(item.published_at ?? undefined),
      });
      story = {
        id: crypto.randomUUID(),
        canonical_key: key,
        title: item.title,
        summary,
        status: "developing",
        first_seen_at: item.observed_at,
        last_changed_at: item.observed_at,
        score,
        relevance,
        novelty: 1,
        importance,
        confidence,
        source_count: 1,
        metadata_json: JSON.stringify({
          firstProvider: typeof metadata.provider === "string" ? metadata.provider : "unknown",
          relevanceSignal,
        }),
        created_at: now,
        updated_at: now,
      };
      await renewItemIngestCompletionLease(env.DB, item.id, leaseToken);
      await commitItemStoryIngestStage(env.DB, {
        itemId: item.id,
        leaseToken,
        story,
        createStory: true,
      });
    } else {
      const sourceCount = await countStorySourcesIncluding(env.DB, matched.id, source.id);
      const novelty = Math.max(0.42, 1 - jaccard(item.title, matched.title) * 0.65);
      const score = storyScore({
        relevance: Math.max(relevance, matched.relevance),
        novelty,
        importance: Math.max(importance, matched.importance),
        confidence: Math.max(confidence, matched.confidence),
        sourceCount,
        sourceWeight: source.weight,
        ageHours: ageHours(item.published_at ?? undefined),
      });
      story = {
        ...matched,
        title: item.title,
        summary,
        last_changed_at: item.observed_at,
        relevance: Math.max(relevance, matched.relevance),
        novelty,
        importance: Math.max(importance, matched.importance),
        confidence: Math.max(confidence, matched.confidence),
        score,
        source_count: sourceCount,
      };
      await renewItemIngestCompletionLease(env.DB, item.id, leaseToken);
      await commitItemStoryIngestStage(env.DB, {
        itemId: item.id,
        leaseToken,
        story,
        createStory: false,
        update: {
          storyId: matched.id,
          title: item.title,
          summary,
          changedAt: item.observed_at,
          relevance,
          novelty,
          importance,
          confidence,
          score,
        },
      });
    }
    completion = { ...completion, stage: 1, story_id: story.id };
  }

  if (!story) {
    story = completion.story_id
      ? await getStoryRecord(env.DB, completion.story_id)
      : await findStoryForItem(env.DB, item.id);
  }
  if (!story) throw new Error(`Ingest completion state for ${item.id} is missing its Story`);

  if (completion.stage < 2) {
    await classifyEvidenceLineage(env, { storyId: story.id, item, source });
    await advanceItemIngestCompletion(env.DB, { itemId: item.id, leaseToken, stage: 2, storyId: story.id });
    completion = { ...completion, stage: 2, story_id: story.id };
  }
  if (completion.stage < 3) {
    await matchStoryToMissions(env, {
      story,
      itemText: item.text,
      sourceId: source.id,
      sourceKind: source.kind,
    });
    await advanceItemIngestCompletion(env.DB, { itemId: item.id, leaseToken, stage: 3, storyId: story.id });
    completion = { ...completion, stage: 3, story_id: story.id };
  }
  if (completion.stage < 4) {
    await setSetting(env.DB, "memory_graph_dirty", "1");
    await completeItemIngest(env.DB, item.id, leaseToken);
    completion = {
      ...completion,
      stage: 4,
      story_id: story.id,
      lease_token: null,
      lease_expires_at: null,
      completed_at: isoNow(),
    };
  }
  return { story, completion };
}

export async function ingestMessage(env: Env, message: IngestMessage): Promise<{ inserted: boolean; itemId?: string; storyId?: string }> {
  const source = await getSource(env.DB, message.sourceId);
  if (!source) throw new Error(`Unknown source ${message.sourceId}`);

  const title = clean(message.item.title, 600);
  if (!title) throw new Error("Item title is required");
  const body = clean(message.item.text, 500_000);
  const author = clean(message.item.author, 300) || undefined;
  const canonicalUrl = canonicalizeUrl(message.item.url);
  // Observation time is required, so an invalid claimed value becomes the
  // collection time. Publication time is optional; rejecting an ambiguous
  // value lets bounded readers fall back to the canonical observation time.
  const observedAt = canonicalEvidenceTimestamp(message.item.observedAt) ?? isoNow();
  const publishedAt = canonicalEvidenceTimestamp(message.item.publishedAt) ?? undefined;
  const accessClass = message.item.accessClass ?? "public";
  const metadata = {
    ...(message.item.metadata ?? {}),
    ...(message.preparation ? { ingestPreparation: message.preparation } : {}),
    provider: message.provider ?? "unknown",
    sourceKind: source.kind,
  };
  const contentHash = await sha256(stableStringify({ title, body, canonicalUrl }));
  const originKeyHash = await ingestOriginKeyHash(message);
  let item = await findExistingItem(env.DB, source.id, message.item.externalId, contentHash);
  let createdInThisCall = false;

  if (!item) {
    const itemId = crypto.randomUUID();
    let rawR2Key: string | null = linkedPublicRawR2Key(message) ?? null;
    const legacyRaw = (message.item as typeof message.item & { raw?: string }).raw;
    // Compatibility for messages queued before raw bodies moved to the producer boundary.
    // The content-derived filename is stable across retries, so a failed D1 write
    // cannot strand a fresh raw object on every attempt.
    if (!rawR2Key && legacyRaw && accessClass === "public") {
      rawR2Key = `raw/${observedAt.slice(0, 10)}/${safeFilename(source.id)}/${stableLegacyRawId(contentHash)}.txt`;
      await putEvidenceObject(env, rawR2Key, legacyRaw, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: { sourceId: source.id, capturedAt: observedAt },
      });
    }

    const candidate: ItemRecord = {
      id: itemId,
      source_id: source.id,
      external_id: message.item.externalId?.slice(0, 500) ?? null,
      url: message.item.url?.slice(0, 2_000) ?? null,
      canonical_url: canonicalUrl ?? null,
      title,
      text: body,
      author: author ?? null,
      published_at: publishedAt ?? null,
      observed_at: observedAt,
      content_hash: contentHash,
      raw_r2_key: rawR2Key,
      access_class: accessClass,
      metadata_json: JSON.stringify(metadata),
      created_at: isoNow(),
    };
    try {
      await insertItemWithIngestCompletion(env.DB, candidate, originKeyHash);
      item = candidate;
      createdInThisCall = true;
    } catch (error) {
      // A competing at-least-once delivery may have won the unique item key. If
      // no item is visible, preserve the original failure for Queue retry.
      const concurrent = await findExistingItem(env.DB, source.id, message.item.externalId, contentHash).catch(() => null);
      if (!concurrent) throw error;
      item = concurrent;
      createdInThisCall = concurrent.id === candidate.id;
    }
  }

  await cleanRedundantRawObject(env, message, item);
  let completion = await getItemIngestCompletion(env.DB, item.id)
    ?? await ensureItemIngestCompletion(env.DB, item.id);
  if (completion.completed_at) {
    return {
      inserted: insertedOutcome(createdInThisCall, originKeyHash, completion),
      itemId: item.id,
      storyId: completion.story_id ?? undefined,
    };
  }

  const leaseToken = crypto.randomUUID();
  const claimed = await claimItemIngestCompletion(env.DB, item.id, leaseToken);
  if (!claimed) {
    completion = await getItemIngestCompletion(env.DB, item.id) ?? completion;
    if (completion.completed_at) {
      return {
        inserted: insertedOutcome(createdInThisCall, originKeyHash, completion),
        itemId: item.id,
        storyId: completion.story_id ?? undefined,
      };
    }
    throw new Error(`Ingest completion for ${item.id} is already in progress`);
  }

  try {
    completion = await getItemIngestCompletion(env.DB, item.id) ?? completion;
    const resumed = await resumeItemIngest(env, { item, source, completion, leaseToken });
    return {
      inserted: insertedOutcome(createdInThisCall, originKeyHash, resumed.completion),
      itemId: item.id,
      storyId: resumed.story.id,
    };
  } catch (error) {
    await releaseItemIngestCompletionLease(env.DB, item.id, leaseToken).catch((leaseError) => {
      console.error(JSON.stringify({
        message: "Unable to release failed ingest completion lease",
        itemId: item.id,
        error: leaseError instanceof Error ? leaseError.message : String(leaseError),
      }));
    });
    throw error;
  }
}
