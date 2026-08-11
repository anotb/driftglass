import type { NormalizedItemInput, SourceAdapterResult, SourceRecord } from "../types";
import { fetchWithTimeout, normalizeStringArray, numberFrom, parseJson, readBoundedResponseJson } from "../utils";
import { discardRemoteSourceResponse } from "./remote-runtime";

const MAX_LOBSTERS_RESPONSE_BYTES = 2_000_000;

interface LobstersConfig {
  feed?: "hottest" | "newest";
  limit?: number;
  minScore?: number;
  tags?: string[];
  watchTerms?: string[];
}

interface LobstersStory {
  short_id?: string;
  short_id_url?: string;
  created_at?: string;
  title?: string;
  url?: string;
  score?: number;
  comment_count?: number;
  description?: string;
  comments_url?: string;
  submitter_user?: { username?: string };
  tags?: string[];
}

export async function collectLobsters(source: SourceRecord): Promise<SourceAdapterResult> {
  const config = parseJson<LobstersConfig>(source.config_json, {});
  const feed = config.feed === "newest" ? "newest" : "hottest";
  const limit = Math.max(1, Math.min(100, numberFrom(config.limit, 40)));
  const minScore = Math.max(0, numberFrom(config.minScore, 0));
  const requiredTags = new Set(normalizeStringArray(config.tags).map((tag) => tag.toLowerCase()));
  const watchTerms = normalizeStringArray(config.watchTerms).map((term) => term.toLowerCase());
  const response = await fetchWithTimeout(`https://lobste.rs/${feed}.json`, {
    redirect: "manual",
    headers: { accept: "application/json", "user-agent": "Driftglass/0.2" },
  });
  if (!response.ok) {
    const status = response.status;
    await discardRemoteSourceResponse(response, "Lobsters response rejected");
    throw new Error(`Lobsters returned ${status}`);
  }
  const rows = await readBoundedResponseJson<LobstersStory[]>(
    response,
    MAX_LOBSTERS_RESPONSE_BYTES,
    "Lobsters response exceeds 2 MB",
  );
  const items: NormalizedItemInput[] = [];
  for (const story of rows) {
    if (items.length >= limit) break;
    if (Number(story.score ?? 0) < minScore) continue;
    const tags = (story.tags ?? []).map((tag) => tag.toLowerCase());
    if (requiredTags.size && !tags.some((tag) => requiredTags.has(tag))) continue;
    const haystack = `${story.title ?? ""}\n${story.description ?? ""}\n${tags.join(" ")}`.toLowerCase();
    if (watchTerms.length && !watchTerms.some((term) => haystack.includes(term))) continue;
    const discussionUrl = story.comments_url || story.short_id_url || (story.short_id ? `https://lobste.rs/s/${story.short_id}` : undefined);
    items.push({
      externalId: story.short_id,
      url: story.url || discussionUrl,
      title: story.title || "Lobsters story",
      text: story.description || "",
      author: story.submitter_user?.username,
      publishedAt: story.created_at,
      metadata: {
        platform: "lobsters",
        feed,
        score: story.score ?? 0,
        comments: story.comment_count ?? 0,
        tags,
        discussionUrl,
      },
    });
  }
  return { items, provider: "lobsters-json", details: { feed, returned: items.length } };
}
