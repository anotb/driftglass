import { getStory, searchPublicStoryCandidates } from "./db";
import {
  knowledgeFetchOutput,
  knowledgeSearchOutput,
  publicKnowledgeUrl,
  type KnowledgeFetchOutput,
  type KnowledgeSearchOutput,
} from "./mcp-knowledge";
import { projectPublicStory } from "./share-privacy";
import { plainTextExcerpt } from "./utils";

const SEARCH_OVERSAMPLE = 4;
const FETCH_EVIDENCE_LIMIT = 12;

function publicSearchTitle(value: unknown): string {
  return plainTextExcerpt(String(value ?? ""), 240)
    .replace(/https?:\/\/[^\s<>"'`]+/gi, " ")
    .replace(/\/(?:mcp|packet|corpus|feedback)\/[a-z0-9_-]{16,}(?:[/?#][^\s<>"'`]*)?/gi, " ")
    .replace(/\s+/g, " ")
    .trim() || "Public evidence update";
}

export async function searchPublicStoryKnowledge(
  db: D1Database,
  query: string,
  limit = 10,
): Promise<KnowledgeSearchOutput> {
  const resultLimit = Math.max(1, Math.min(30, Math.floor(limit)));
  const rows = await searchPublicStoryCandidates(
    db,
    query,
    Math.min(100, resultLimit * SEARCH_OVERSAMPLE),
  );
  const candidates: Array<{ id: string; title: string; url: string }> = [];
  const seenStories = new Set<string>();

  for (const row of rows) {
    const id = String(row.story_id || "");
    if (!id || seenStories.has(id)) continue;
    const url = publicKnowledgeUrl(row.canonical_url, row.url);
    if (!url) continue;
    seenStories.add(id);
    candidates.push({ id, title: publicSearchTitle(row.title), url });
    if (candidates.length >= resultLimit) break;
  }

  return knowledgeSearchOutput(candidates);
}

export async function fetchPublicStoryKnowledge(
  db: D1Database,
  id: string,
): Promise<KnowledgeFetchOutput | null> {
  const detail = await getStory(db, id);
  if (!detail) return null;
  const story = projectPublicStory(detail, FETCH_EVIDENCE_LIMIT);
  if (!story) return null;

  const evidence = story.evidence.map((item) => ({
    source: item.source,
    title: item.title,
    url: item.url ?? "",
    author: item.author ?? null,
    publishedAt: item.publishedAt ?? null,
    accessClass: item.accessClass,
    sourceFamily: item.evidenceFamily ?? null,
    lineageRelation: item.lineageRelation,
    independentEvidence: item.independent,
    excerpt: item.excerpt ?? item.title,
  }));
  const url = evidence.find((item) => item.url)?.url ?? "";

  return knowledgeFetchOutput({
    id: story.id,
    title: story.title,
    text: [
      story.summary,
      ...evidence.map((item) => [
        `${item.source}: ${item.excerpt}`,
        item.url ? `Source URL: ${item.url}` : "",
      ].filter(Boolean).join("\n")),
    ].filter(Boolean).join("\n\n"),
    url,
    metadata: {
      changedAt: story.changedAt,
      distinctSources: story.sourceCount,
      evidence,
    },
  });
}
