import type { NormalizedItemInput, SourceAdapterResult, SourceRecord } from "../types";
import { fetchWithTimeout, normalizeStringArray, numberFrom, parseJson, readBoundedResponseJson } from "../utils";
import { discardRemoteSourceResponse } from "./remote-runtime";

const MAX_BLUESKY_RESPONSE_BYTES = 3_000_000;
const BLUESKY_PUBLIC_APPVIEW = "https://public.api.bsky.app";
const BLUESKY_PRIMARY_APPVIEW = "https://api.bsky.app";

interface BlueskyConfig {
  mode?: "search" | "author" | "feed";
  query?: string;
  actor?: string;
  feedUri?: string;
  limit?: number;
  sort?: "latest" | "top";
  language?: string;
  watchTerms?: string[];
}

interface BlueskyPost {
  uri?: string;
  cid?: string;
  author?: { did?: string; handle?: string; displayName?: string };
  record?: { text?: string; createdAt?: string; langs?: string[] };
  indexedAt?: string;
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  quoteCount?: number;
  labels?: Array<{ val?: string }>;
}

function postUrl(post: BlueskyPost): string | undefined {
  const handle = post.author?.handle;
  const rkey = post.uri?.split("/").pop();
  return handle && rkey ? `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}` : undefined;
}

export async function collectBluesky(source: SourceRecord): Promise<SourceAdapterResult> {
  const config = parseJson<BlueskyConfig>(source.config_json, {});
  const mode = config.mode ?? (config.actor ? "author" : config.feedUri ? "feed" : "search");
  const limit = Math.max(1, Math.min(100, numberFrom(config.limit, 50)));
  // Bluesky documents search as provider-dependent and its cached public
  // AppView currently rejects it, while the primary AppView serves the same
  // unauthenticated query. Keep cacheable feed reads on the public host.
  const endpoint = new URL(
    mode === "author"
      ? `${BLUESKY_PUBLIC_APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed`
      : mode === "feed"
        ? `${BLUESKY_PUBLIC_APPVIEW}/xrpc/app.bsky.feed.getFeed`
        : `${BLUESKY_PRIMARY_APPVIEW}/xrpc/app.bsky.feed.searchPosts`,
  );
  endpoint.searchParams.set("limit", String(limit));
  if (mode === "author") {
    if (!config.actor) throw new Error("Bluesky author sources require config.actor");
    endpoint.searchParams.set("actor", config.actor);
    endpoint.searchParams.set("filter", "posts_no_replies");
  } else if (mode === "feed") {
    if (!config.feedUri) throw new Error("Bluesky feed sources require config.feedUri");
    endpoint.searchParams.set("feed", config.feedUri);
  } else {
    if (!config.query) throw new Error("Bluesky search sources require config.query");
    endpoint.searchParams.set("q", config.query);
    endpoint.searchParams.set("sort", config.sort === "top" ? "top" : "latest");
    if (config.language) endpoint.searchParams.set("lang", config.language);
  }
  const response = await fetchWithTimeout(endpoint, {
    redirect: "manual",
    headers: { accept: "application/json", "user-agent": "Driftglass/0.2" },
  });
  if (!response.ok) {
    const status = response.status;
    await discardRemoteSourceResponse(response, "Bluesky response rejected");
    throw new Error(`Bluesky AppView returned ${status}`);
  }
  const body = await readBoundedResponseJson<{ posts?: BlueskyPost[]; feed?: Array<{ post?: BlueskyPost }> }>(
    response,
    MAX_BLUESKY_RESPONSE_BYTES,
    "Bluesky response exceeds 3 MB",
  );
  const posts = body.posts ?? (body.feed ?? []).map((row) => row.post).filter((post): post is BlueskyPost => Boolean(post));
  const watchTerms = normalizeStringArray(config.watchTerms).map((term) => term.toLowerCase());
  const items: NormalizedItemInput[] = posts
    .filter((post) => {
      if (!watchTerms.length) return true;
      return watchTerms.some((term) => (post.record?.text ?? "").toLowerCase().includes(term));
    })
    .slice(0, limit)
    .map((post) => {
      const text = post.record?.text ?? "";
      const author = post.author?.handle ?? post.author?.displayName;
      return {
        externalId: post.uri || post.cid,
        url: postUrl(post),
        title: `${author ? `@${author}: ` : ""}${text.slice(0, 180) || "Bluesky post"}`,
        text,
        author,
        publishedAt: post.record?.createdAt ?? post.indexedAt,
        metadata: {
          platform: "bluesky",
          mode,
          uri: post.uri,
          cid: post.cid,
          did: post.author?.did,
          displayName: post.author?.displayName,
          likes: post.likeCount ?? 0,
          reposts: post.repostCount ?? 0,
          replies: post.replyCount ?? 0,
          quotes: post.quoteCount ?? 0,
          languages: post.record?.langs ?? [],
          labels: (post.labels ?? []).map((label) => label.val).filter(Boolean),
        },
      };
    });
  return { items, provider: "bluesky-public-appview", details: { mode, returned: items.length } };
}
