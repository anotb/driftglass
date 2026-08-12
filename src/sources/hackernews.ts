import type { NormalizedItemInput, SourceAdapterResult, SourceRecord } from "../types";
import { fetchWithTimeout, normalizeStringArray, parseJson, readBoundedResponseJson } from "../utils";
import { discardRemoteSourceResponse, settleRemoteSourceRequests } from "./remote-runtime";

const MAX_HACKER_NEWS_IDS_BYTES = 256_000;
const MAX_HACKER_NEWS_ITEM_BYTES = 256_000;
const MAX_HACKER_NEWS_ITEM_REQUESTS = 49;

interface HackerNewsConfig {
  feed?: "top" | "best" | "new";
  limit?: number;
  minScore?: number;
  watchTerms?: string[];
}

interface HackerNewsItem {
  id: number;
  by?: string;
  time?: number;
  title?: string;
  text?: string;
  url?: string;
  score?: number;
  descendants?: number;
  type?: string;
  deleted?: boolean;
  dead?: boolean;
}

export async function collectHackerNews(source: SourceRecord): Promise<SourceAdapterResult> {
  const config = parseJson<HackerNewsConfig>(source.config_json, {});
  const feed = ["top", "best", "new"].includes(config.feed ?? "") ? config.feed! : "top";
  // Reserve one of Workers Free's 50 external subrequests for the feed request.
  const limit = Math.max(1, Math.min(MAX_HACKER_NEWS_ITEM_REQUESTS, config.limit ?? 30));
  const minScore = Math.max(0, config.minScore ?? 0);
  const idsResponse = await fetchWithTimeout(`https://hacker-news.firebaseio.com/v0/${feed}stories.json`, {
    redirect: "manual",
    headers: { "user-agent": "Driftglass/0.1 (+personal intelligence collector)" },
  });
  if (!idsResponse.ok) {
    const status = idsResponse.status;
    await discardRemoteSourceResponse(idsResponse, "Hacker News feed response rejected");
    throw new Error(`Hacker News returned ${status}`);
  }
  const ids = (await readBoundedResponseJson<number[]>(
    idsResponse,
    MAX_HACKER_NEWS_IDS_BYTES,
    "Hacker News story list exceeds 256 KB",
  )).slice(0, limit);
  const settled = await settleRemoteSourceRequests(
    ids,
    async (id) => {
      const response = await fetchWithTimeout(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
        redirect: "manual",
      });
      if (!response.ok) {
        const status = response.status;
        await discardRemoteSourceResponse(response, "Hacker News item response rejected");
        throw new Error(`item ${id}: HTTP ${status}`);
      }
      return readBoundedResponseJson<HackerNewsItem>(
        response,
        MAX_HACKER_NEWS_ITEM_BYTES,
        `Hacker News item ${id} exceeds 256 KB`,
      );
    },
  );

  const records = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failures = settled.filter((result) => result.status === "rejected").length;
  const watchTerms = normalizeStringArray(config.watchTerms);
  const normalizedWatchTerms = watchTerms.map((term) => term.toLowerCase());
  const items: NormalizedItemInput[] = records
    .filter((item) => Boolean(item && !item.deleted && !item.dead && item.type === "story" && item.title))
    .filter((item) => (item.score ?? 0) >= minScore)
    .filter((item) => {
      if (!normalizedWatchTerms.length) return true;
      const haystack = `${item.title ?? ""}\n${item.text ?? ""}`.toLowerCase();
      return normalizedWatchTerms.some((term) => haystack.includes(term));
    })
    .slice(0, limit)
    .map((item) => ({
      externalId: String(item.id),
      url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
      title: item.title ?? "Untitled Hacker News story",
      text: item.text ?? "",
      author: item.by,
      publishedAt: item.time ? new Date(item.time * 1000).toISOString() : undefined,
      metadata: {
        platform: "hackernews",
        discussionUrl: `https://news.ycombinator.com/item?id=${item.id}`,
        score: item.score ?? 0,
        comments: item.descendants ?? 0,
        watchTerms,
      },
    }));

  return {
    items,
    provider: "hackernews-firebase",
    details: { feed, requested: limit, returned: items.length, partial: failures > 0, failures },
  };
}
