import { getSetting, recordPackInstall, setSetting, upsertSource } from "./db";
import type { Env, StarterPack } from "./types";
import { normalizeStringArray, parseJson } from "./utils";

export const STARTER_PACKS: StarterPack[] = [
  {
    id: "cloudflare-agent-week",
    name: "Cloudflare Agent Week",
    description: "Cloudflare Computer, Kitesurf, Agents SDK, MCP, AI Search, Workflows, Wallets, and the projects adopting them.",
    category: "Featured",
    icon: "⚡",
    featured: true,
    interestTerms: [
      "Cloudflare Agents", "Cloudflare Computer", "Kitesurf", "Browser Run", "MCP", "Dynamic Workers", "Artifacts", "Workflows", "AI Search",
      "Cloudflare Wallets", "agent payments", "WebMCP", "Agent Access Model",
    ],
    sources: [
      {
        id: "cloudflare-agent-week-blog",
        name: "Cloudflare Agent Week — new posts",
        kind: "web_feed",
        config: {
          url: "https://blog.cloudflare.com/tag/agents-week/",
          title: "Cloudflare Agent Week",
          renderStrategy: "adaptive",
          articleRenderStrategy: "direct",
          includePattern: "cloudflare\.com/",
          excludePattern: "/tag/|/author/",
          maxLinks: 30,
          maxArticles: 10,
          fetchArticles: true,
        },
        scheduleMinutes: 120,
        weight: 1.5,
      },
      {
        id: "cloudflare-ai-changelog",
        name: "Cloudflare AI changelog",
        kind: "web",
        config: { url: "https://developers.cloudflare.com/changelog/product-group/ai/", title: "Cloudflare AI changelog", mode: "monitor", renderStrategy: "adaptive" },
        scheduleMinutes: 180,
        weight: 1.45,
      },
      {
        id: "github-cloudflare-agent-stack",
        name: "Cloudflare agent stack releases",
        kind: "github_releases",
        config: {
          repos: ["cloudflare/agents", "cloudflare/computer", "cloudflare/workers-sdk", "cloudflare/cloudflare-docs", "cloudflare/playwright", "cloudflare/sandbox-sdk"],
          perRepo: 5,
          includePrereleases: true,
        },
        scheduleMinutes: 120,
        weight: 1.4,
      },
      {
        id: "github-cloudflare-agent-activity",
        name: "Cloudflare agent stack — live GitHub activity",
        kind: "github_activity",
        config: {
          repos: ["cloudflare/agents", "cloudflare/computer", "cloudflare/playwright", "cloudflare/sandbox-sdk", "cloudflare/workers-sdk"],
          perRepo: 60,
          includeTypes: ["PullRequestEvent", "PullRequestReviewEvent", "IssuesEvent", "IssueCommentEvent", "PushEvent", "ReleaseEvent"],
          watchTerms: ["computer", "worker-shell", "kitesurf", "sandbox", "artifact", "mcp", "agent", "browser", "workflow"],
        },
        scheduleMinutes: 90,
        weight: 1.25,
      },
      {
        id: "npm-cloudflare-agent-stack",
        name: "npm — Cloudflare agent stack",
        kind: "npm_releases",
        config: { packages: ["agents", "wrangler", "@cloudflare/computer", "@cloudflare/playwright-mcp"], includePrereleases: true },
        scheduleMinutes: 90,
        weight: 1.35,
      },
      {
        id: "lobsters-cloudflare-agents",
        name: "Lobsters — Cloudflare and agents",
        kind: "lobsters",
        config: { feed: "hottest", limit: 50, watchTerms: ["cloudflare", "computer", "agent", "browser", "mcp", "sandbox"] },
        scheduleMinutes: 90,
        weight: 1.05,
      },
      {
        id: "bluesky-cloudflare-agents",
        name: "Bluesky — Cloudflare agents",
        kind: "bluesky",
        config: { mode: "search", query: "cloudflare agents OR cloudflare computer OR kitesurf OR cloudflare sandbox", sort: "latest", limit: 75 },
        scheduleMinutes: 90,
        weight: 0.95,
      },
    ],
  },
  {
    id: "personal-social",
    name: "My social intelligence",
    description: "X For You/Following, bookmarks, Reddit Home/saved, and YouTube recommendations through one optional cross-platform Relay.",
    category: "Personal",
    icon: "◉",
    featured: true,
    requiresCompanion: true,
    interestTerms: ["frontier AI", "coding agents", "Cloudflare", "data centers", "power", "economics", "markets"],
    sources: [
      { id: "relay-x-for-you", name: "X — For You", kind: "collector", config: { operation: "x.timeline", args: { type: "for-you", limit: 75 } }, scheduleMinutes: 180, weight: 1.15 },
      { id: "relay-x-following", name: "X — Following", kind: "collector", config: { operation: "x.timeline", args: { type: "following", limit: 75 } }, scheduleMinutes: 180, weight: 1.1 },
      { id: "relay-x-bookmarks", name: "X — Bookmarks", kind: "collector", config: { operation: "x.bookmarks", args: { limit: 100 } }, scheduleMinutes: 360, weight: 1.75 },
      { id: "relay-reddit-home", name: "Reddit — Home", kind: "collector", config: { operation: "reddit.home", args: { limit: 75 } }, scheduleMinutes: 180, weight: 1.05 },
      { id: "relay-reddit-saved", name: "Reddit — Saved", kind: "collector", config: { operation: "reddit.saved", args: { limit: 100 } }, scheduleMinutes: 360, weight: 1.7 },
      { id: "relay-youtube-feed", name: "YouTube — Home recommendations", kind: "collector", config: { operation: "youtube.feed", args: { limit: 50 } }, scheduleMinutes: 360, weight: 1.0 },
    ],
  },
  {
    id: "frontier-ai",
    name: "Frontier AI & coding agents",
    description: "Model, coding-agent, context-engineering, MCP, and developer-tool developments across primary releases and technical communities.",
    category: "Technology",
    icon: "✦",
    featured: true,
    interestTerms: [
      "OpenAI", "Anthropic", "Claude Code", "Codex", "MCP", "agents", "browser automation", "context engineering",
      "inference", "developer tools", "agent memory", "computer use",
    ],
    sources: [
      { id: "openai-news-feed", name: "OpenAI — new announcements", kind: "web_feed", config: { url: "https://openai.com/news/", renderStrategy: "adaptive", articleRenderStrategy: "direct", sameOrigin: true, maxLinks: 30, maxArticles: 8, fetchArticles: true }, scheduleMinutes: 180, weight: 1.35 },
      { id: "anthropic-news-feed", name: "Anthropic — new announcements", kind: "web_feed", config: { url: "https://www.anthropic.com/news", renderStrategy: "adaptive", articleRenderStrategy: "direct", sameOrigin: true, maxLinks: 30, maxArticles: 8, fetchArticles: true }, scheduleMinutes: 180, weight: 1.35 },
      { id: "hn-ai-builders", name: "Hacker News — AI builders", kind: "hackernews", config: { feed: "best", limit: 60, minScore: 12, watchTerms: ["agent", "openai", "anthropic", "model", "mcp", "inference"] }, scheduleMinutes: 60, weight: 1.1 },
      { id: "lobsters-ai-builders", name: "Lobsters — AI builders", kind: "lobsters", config: { feed: "hottest", limit: 60, watchTerms: ["agent", "llm", "inference", "mcp", "browser"] }, scheduleMinutes: 90, weight: 1.0 },
      {
        id: "github-frontier-ai",
        name: "GitHub releases — AI & agents",
        kind: "github_releases",
        config: {
          repos: [
            "openai/openai-node", "openai/openai-python", "anthropics/anthropic-sdk-typescript",
            "modelcontextprotocol/typescript-sdk", "cloudflare/agents", "jackwener/OpenCLI", "Panniantong/Agent-Reach",
          ],
          perRepo: 4,
          includePrereleases: true,
        },
        scheduleMinutes: 150,
        weight: 1.3,
      },
      { id: "github-frontier-ai-activity", name: "GitHub activity — frontier agents", kind: "github_activity", config: { repos: ["openai/openai-agents-python", "openai/openai-agents-js", "anthropics/claude-code", "modelcontextprotocol/typescript-sdk", "jackwener/OpenCLI", "Panniantong/Agent-Reach"], perRepo: 40, includeTypes: ["PullRequestEvent", "PullRequestReviewEvent", "IssuesEvent", "IssueCommentEvent", "ReleaseEvent"] }, scheduleMinutes: 120, weight: 1.1 },
      { id: "npm-frontier-agent-sdks", name: "npm — frontier agent SDKs", kind: "npm_releases", config: { packages: ["openai", "@anthropic-ai/sdk", "@modelcontextprotocol/server", "@modelcontextprotocol/client", "agents"], includePrereleases: true }, scheduleMinutes: 120, weight: 1.25 },
      { id: "pypi-frontier-agent-sdks", name: "PyPI — frontier AI SDKs", kind: "pypi_releases", config: { packages: ["openai", "anthropic", "mcp", "playwright"] }, scheduleMinutes: 180, weight: 1.1 },
      { id: "arxiv-agent-systems", name: "arXiv — agent systems", kind: "arxiv", config: { query: "large language model agents OR computer use agents OR tool use language models", limit: 30, sortBy: "submittedDate" }, scheduleMinutes: 360, weight: 0.9 },
      { id: "openalex-agent-systems", name: "OpenAlex — agent systems (optional key)", kind: "openalex", config: { query: "large language model agents computer use tool use", limit: 35, sort: "publication_date:desc", openAccessOnly: false }, scheduleMinutes: 360, weight: 0.95 },
    ],
  },
  {
    id: "open-source-momentum",
    name: "Open-source momentum",
    description: "Fast-rising agent infrastructure and the maintained projects Driftglass can integrate with instead of rebuilding.",
    category: "Technology",
    icon: "⌘",
    interestTerms: ["open source", "GitHub", "agent tools", "browser automation", "personal intelligence"],
    sources: [
      {
        id: "github-access-upstreams",
        name: "GitHub releases — live access ecosystem",
        kind: "github_releases",
        config: {
          repos: [
            "jackwener/OpenCLI", "Panniantong/Agent-Reach", "vladkens/twscrape", "ythx-101/x-tweet-fetcher",
            "nirholas/XActions", "yt-dlp/yt-dlp", "ggerganov/whisper.cpp",
          ],
          perRepo: 4,
          includePrereleases: true,
        },
        scheduleMinutes: 180,
        weight: 1.25,
      },
      { id: "github-open-source-agent-activity", name: "GitHub activity — live access ecosystem", kind: "github_activity", config: { repos: ["jackwener/OpenCLI", "Panniantong/Agent-Reach", "vladkens/twscrape", "ythx-101/x-tweet-fetcher", "nirholas/XActions"], perRepo: 50, includeTypes: ["PullRequestEvent", "PullRequestReviewEvent", "IssuesEvent", "IssueCommentEvent", "ReleaseEvent"] }, scheduleMinutes: 120, weight: 1.05 },
      { id: "npm-open-source-agent-tools", name: "npm — open-source agent tools", kind: "npm_releases", config: { packages: ["@jackwener/opencli", "@modelcontextprotocol/server", "@modelcontextprotocol/client", "agents", "wrangler"], includePrereleases: true }, scheduleMinutes: 120, weight: 1.15 },
      { id: "hn-open-source-agents", name: "Hacker News — open-source agents", kind: "hackernews", config: { feed: "new", limit: 80, watchTerms: ["open source agent", "browser agent", "personal assistant", "mcp"] }, scheduleMinutes: 60, weight: 0.95 },
    ],
  },
  {
    id: "infra-power",
    name: "AI infrastructure, data centers & power",
    description: "Data-center buildout, utilities, transmission, chips, large loads, and infrastructure finance.",
    category: "Infrastructure",
    icon: "⌁",
    interestTerms: [
      "data center", "power", "utility", "transmission", "interconnection", "substation", "GPU", "NVIDIA",
      "AI infrastructure", "large load", "electricity rates", "grid", "generation",
    ],
    sources: [
      { id: "hn-infra", name: "Hacker News — infrastructure", kind: "hackernews", config: { feed: "best", limit: 60, minScore: 15, watchTerms: ["data center", "power grid", "nvidia", "gpu", "electricity"] }, scheduleMinutes: 90, weight: 1.0 },
      { id: "bluesky-infra", name: "Bluesky — AI infrastructure", kind: "bluesky", config: { mode: "search", query: '"data center" power OR grid OR utility', sort: "latest", limit: 60 }, scheduleMinutes: 120, weight: 0.85 },
      { id: "arxiv-ai-systems", name: "arXiv — AI systems efficiency", kind: "arxiv", config: { query: "AI data center energy OR large language model inference systems OR GPU cluster efficiency", limit: 25, sortBy: "submittedDate" }, scheduleMinutes: 720, weight: 0.75 },
      { id: "openalex-ai-infrastructure", name: "OpenAlex — AI infrastructure & energy (optional key)", kind: "openalex", config: { query: "artificial intelligence data center energy power grid GPU cluster", limit: 30, sort: "publication_date:desc" }, scheduleMinutes: 720, weight: 0.8 },
      { id: "github-infra", name: "GitHub releases — infrastructure tooling", kind: "github_releases", config: { repos: ["cloudflare/workers-sdk", "duckdb/duckdb", "OSGeo/gdal", "qgis/QGIS"], perRepo: 3 }, scheduleMinutes: 360, weight: 0.8 },
    ],
  },
  {
    id: "research-frontier",
    name: "Research frontier",
    description: "A clean academic lane across arXiv and technical discussion, designed to feed Research Missions rather than a giant paper inbox.",
    category: "Research",
    icon: "∑",
    interestTerms: ["research paper", "benchmark", "evaluation", "agents", "inference", "AI systems"],
    sources: [
      { id: "arxiv-frontier-agents", name: "arXiv — frontier agents", kind: "arxiv", config: { query: "language model agents OR tool use language models OR computer use agents OR agent evaluation", limit: 40, sortBy: "submittedDate" }, scheduleMinutes: 360, weight: 1.0 },
      { id: "openalex-frontier-agents", name: "OpenAlex — frontier agents (optional key)", kind: "openalex", config: { query: "language model agents tool use computer use agent evaluation", limit: 40, sort: "publication_date:desc" }, scheduleMinutes: 360, weight: 1.05 },
      { id: "lobsters-research", name: "Lobsters — research discussion", kind: "lobsters", config: { feed: "hottest", limit: 50, watchTerms: ["paper", "benchmark", "evaluation", "model"] }, scheduleMinutes: 120, weight: 0.8 },
    ],
  },
];

export function getStarterPack(id: string): StarterPack | undefined {
  return STARTER_PACKS.find((pack) => pack.id === id);
}

export async function applyStarterPack(env: Env, pack: StarterPack): Promise<void> {
  for (const source of pack.sources) {
    await upsertSource(env.DB, {
      id: source.id,
      name: source.name,
      kind: source.kind,
      config: source.config,
      scheduleMinutes: source.scheduleMinutes,
      weight: source.weight,
    });
  }
  const existing = normalizeStringArray(parseJson<unknown>(await getSetting(env.DB, "interest_terms"), []));
  await setSetting(env.DB, "interest_terms", JSON.stringify([...new Set([...existing, ...pack.interestTerms])]));
  await recordPackInstall(env.DB, pack.id, pack.sources.length, { name: pack.name, requiresCompanion: Boolean(pack.requiresCompanion) });
}
