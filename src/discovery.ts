import type { SourceSuggestion } from "./types";

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70) || crypto.randomUUID();
}

function suggestion(
  id: string,
  confidence: number,
  reason: string,
  source: SourceSuggestion["source"],
): SourceSuggestion {
  return { id, confidence, reason, source };
}

function githubRepo(value: string): string | undefined {
  const trimmed = value.trim().replace(/\.git$/, "");
  const urlMatch = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:[/?#].*)?$/i);
  if (urlMatch) return `${urlMatch[1]}/${urlMatch[2]}`;
  const shorthand = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return shorthand ? `${shorthand[1]}/${shorthand[2]}` : undefined;
}


function npmPackage(value: string): string | undefined {
  const trimmed = value.trim();
  const urlMatch = trimmed.match(/^https?:\/\/(?:www\.)?npmjs\.com\/package\/([^?#]+)/i);
  if (urlMatch) return decodeURIComponent(urlMatch[1] ?? "");
  const shorthand = trimmed.match(/^npm:(@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)$/i);
  return shorthand?.[1];
}

function pypiPackage(value: string): string | undefined {
  const trimmed = value.trim();
  const urlMatch = trimmed.match(/^https?:\/\/(?:www\.)?pypi\.org\/project\/([^/?#]+)/i);
  if (urlMatch) return decodeURIComponent(urlMatch[1] ?? "");
  const shorthand = trimmed.match(/^pypi:([A-Za-z0-9_.-]+)$/i);
  return shorthand?.[1];
}

function blueskyActor(value: string): string | undefined {
  const trimmed = value.trim();
  const urlMatch = trimmed.match(/^https?:\/\/(?:www\.)?bsky\.app\/profile\/([^/?#]+)/i);
  if (urlMatch) return decodeURIComponent(urlMatch[1] ?? "");
  const handle = trimmed.match(/^@?([A-Za-z0-9._-]+\.[A-Za-z0-9._-]+)$/);
  return handle?.[1];
}

export function discoverSources(input: string): SourceSuggestion[] {
  const value = input.trim();
  if (!value) return [];
  const output: SourceSuggestion[] = [];
  const npmName = npmPackage(value);
  if (npmName) {
    const packageSlug = slug(npmName);
    output.push(suggestion(
      `npm-${packageSlug}`,
      0.98,
      "Track the latest published npm release without a token.",
      {
        id: `npm-${packageSlug}`,
        name: `npm · ${npmName}`,
        kind: "npm_releases",
        config: { packages: [npmName] },
        scheduleMinutes: 120,
        weight: 1.1,
      },
    ));
    return output;
  }

  const pypiName = pypiPackage(value);
  if (pypiName) {
    const packageSlug = slug(pypiName);
    output.push(suggestion(
      `pypi-${packageSlug}`,
      0.98,
      "Track the latest published PyPI release without a token.",
      {
        id: `pypi-${packageSlug}`,
        name: `PyPI · ${pypiName}`,
        kind: "pypi_releases",
        config: { packages: [pypiName] },
        scheduleMinutes: 180,
        weight: 1.1,
      },
    ));
    return output;
  }

  const repo = githubRepo(value);
  if (repo) {
    const repoSlug = slug(repo);
    output.push(
      suggestion(
        `github-${repoSlug}`,
        0.99,
        "Track every release from this GitHub repository.",
        {
          id: `github-${repoSlug}`,
          name: `${repo} releases`,
          kind: "github_releases",
          config: { repos: [repo], perRepo: 4, includePrereleases: false },
          scheduleMinutes: 180,
          weight: 1.2,
        },
      ),
      suggestion(
        `github-activity-${repoSlug}`,
        0.96,
        "Track pull requests, issues, pushes, reviews, and releases as a live project signal.",
        {
          id: `github-activity-${repoSlug}`,
          name: `${repo} activity`,
          kind: "github_activity",
          config: {
            repos: [repo],
            perRepo: 50,
            includeTypes: ["PullRequestEvent", "PullRequestReviewEvent", "IssuesEvent", "IssueCommentEvent", "PushEvent", "ReleaseEvent"],
          },
          scheduleMinutes: 90,
          weight: 1.05,
        },
      ),
    );
    return output;
  }

  const actor = blueskyActor(value);
  if (actor) {
    const actorSlug = slug(actor);
    output.push(suggestion(
      `bluesky-${actorSlug}`,
      0.96,
      "Follow this public Bluesky account through the AppView API.",
      {
        id: `bluesky-${actorSlug}`,
        name: `Bluesky · @${actor}`,
        kind: "bluesky",
        config: { mode: "author", actor, limit: 50 },
        scheduleMinutes: 90,
        weight: 1.05,
      },
    ));
    return output;
  }

  const arxivCategory = value.match(/^(?:arxiv:)?((?:cs|stat|econ|eess|math|physics|q-bio|q-fin)\.[A-Za-z-]+)$/i)?.[1];
  if (arxivCategory) {
    const category = arxivCategory;
    output.push(suggestion(
      `arxiv-${slug(category)}`,
      0.97,
      "Watch new papers in this arXiv category.",
      {
        id: `arxiv-${slug(category)}`,
        name: `arXiv · ${category}`,
        kind: "arxiv",
        config: { categories: [category], limit: 40, sortBy: "submittedDate" },
        scheduleMinutes: 360,
        weight: 1.05,
      },
    ));
    return output;
  }

  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (url) {
    if (url.hostname === "lobste.rs" || url.hostname.endsWith(".lobste.rs")) {
      output.push(suggestion(
        "lobsters-hottest",
        0.94,
        "Follow the current Lobsters front page.",
        {
          id: "lobsters-hottest",
          name: "Lobsters · hottest",
          kind: "lobsters",
          config: { feed: "hottest", limit: 50, minScore: 3 },
          scheduleMinutes: 60,
          weight: 1.05,
        },
      ));
      return output;
    }
    if (url.hostname === "news.ycombinator.com") {
      output.push(suggestion(
        "hacker-news-best",
        0.94,
        "Follow Hacker News best stories with comments.",
        {
          id: "hacker-news-best",
          name: "Hacker News · best",
          kind: "hackernews",
          config: { feed: "best", limit: 50, minScore: 10 },
          scheduleMinutes: 60,
          weight: 1.05,
        },
      ));
      return output;
    }
    const pageSlug = slug(url.hostname + url.pathname);
    output.push(
      suggestion(
        `web-feed-${pageSlug}`,
        0.91,
        "Discover new links from this page with direct HTML first and Kitesurf when the listing needs a browser.",
        {
          id: `web-feed-${pageSlug}`,
          name: `${url.hostname.replace(/^www\./, "")} · new links`,
          kind: "web_feed",
          config: { url: url.toString(), renderStrategy: "adaptive", articleRenderStrategy: "direct", maxLinks: 30, maxArticles: 8, fetchArticles: true },
          scheduleMinutes: 180,
          weight: 1.1,
        },
      ),
      suggestion(
        `web-${pageSlug}`,
        0.86,
        "Monitor the page itself for meaningful revisions with Driftglass's adaptive direct → Kitesurf → Chromium renderer.",
        {
          id: `web-${pageSlug}`,
          name: url.hostname.replace(/^www\./, ""),
          kind: "web",
          config: { url: url.toString(), mode: "monitor", renderStrategy: "adaptive" },
          scheduleMinutes: 180,
          weight: 1,
        },
      ),
    );
    return output;
  }

  const topic = value.slice(0, 180);
  const topicSlug = slug(topic);
  output.push(
    suggestion(
      `bluesky-topic-${topicSlug}`,
      0.78,
      "Find fresh public discussion on Bluesky.",
      {
        id: `bluesky-topic-${topicSlug}`,
        name: `Bluesky · ${topic}`,
        kind: "bluesky",
        config: { mode: "search", query: topic, sort: "latest", limit: 50 },
        scheduleMinutes: 90,
        weight: 0.95,
      },
    ),
    suggestion(
      `arxiv-topic-${topicSlug}`,
      0.7,
      "Find newly submitted research matching this topic.",
      {
        id: `arxiv-topic-${topicSlug}`,
        name: `arXiv · ${topic}`,
        kind: "arxiv",
        config: { query: topic, limit: 30, sortBy: "submittedDate" },
        scheduleMinutes: 360,
        weight: 1,
      },
    ),
    suggestion(
      `openalex-topic-${topicSlug}`,
      0.74,
      "Track recent and highly cited academic work with author, institution, venue, and open-access context.",
      {
        id: `openalex-topic-${topicSlug}`,
        name: `OpenAlex · ${topic} (optional key)`,
        kind: "openalex",
        config: { query: topic, limit: 30, sort: "publication_date:desc" },
        scheduleMinutes: 360,
        weight: 0.95,
      },
    ),
  );
  return output;
}
