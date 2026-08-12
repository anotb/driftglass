import type { Env, NormalizedItemInput, SourceAdapterResult, SourceRecord } from "../types";
import { canonicalEvidenceTimestamp } from "../evidence-timestamp";
import {
  fetchWithTimeout,
  normalizeStringArray,
  parseJson,
  readBoundedResponseJson,
  readBoundedResponseText,
  stripHtml,
} from "../utils";
import { githubRepositoryApiUrl, normalizeGithubRepositories } from "./github-config";
import { settleRemoteSourceRequests } from "./remote-runtime";

const MAX_GITHUB_RELEASES_RESPONSE_BYTES = 2_000_000;
const MAX_GITHUB_RELEASES_ATOM_RESPONSE_BYTES = 2_000_000;

interface GithubConfig {
  repos?: string[];
  perRepo?: number;
  includePrereleases?: boolean;
  watchTerms?: string[];
}

interface GithubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  author?: { login?: string };
}

interface GithubRepositoryReleases {
  items: NormalizedItemInput[];
  inferredPrereleasesExcluded?: number;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#(\d+);/g, (_match, decimal: string) => {
      const code = Number.parseInt(decimal, 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (entity) => ({
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": "\"",
      "&apos;": "'",
      "&nbsp;": " ",
    })[entity.toLowerCase()] ?? " ");
}

function atomElement(block: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"))?.[1];
}

function atomElements(block: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...block.matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "gi"))]
    .map((match) => match[1] ?? "");
}

function atomText(block: string, name: string): string | undefined {
  const value = atomElement(block, name);
  if (value === undefined) return undefined;
  return stripHtml(decodeXmlEntities(value)) || undefined;
}

function atomAttributes(tag: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...tag.matchAll(new RegExp(`(?:^|[\\t\\n\\r ])${escaped}[\\t\\n\\r ]*=[\\t\\n\\r ]*(["'])([\\s\\S]*?)\\1`, "gi"))]
    .map((match) => decodeXmlEntities(match[2] ?? ""));
}

function githubReleaseAtomUrl(repository: string): string {
  const [owner, name] = repository.split("/");
  return `https://github.com/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/releases.atom`;
}

function githubReleaseUrl(repository: string, tag: string): string {
  const [owner, name] = repository.split("/");
  return `https://github.com/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/releases/tag/${encodeURIComponent(tag)}`;
}

function githubReleaseExternalId(repository: string, tag: string): string {
  return `${repository}:release-tag:${tag}`;
}

function parseGithubReleaseAtomEntries(xml: string, repository: string): string[] {
  const root = xml.match(/^\uFEFF?\s*(?:<\?xml[\s\S]*?\?>\s*)?<feed\b[^>]*>([\s\S]*)<\/feed>\s*$/i);
  if (!root) throw new Error(`${repository}: GitHub releases Atom feed has an incomplete or malformed feed root`);
  const body = root[1] ?? "";
  if (/<\/?feed\b/i.test(body)) {
    throw new Error(`${repository}: GitHub releases Atom feed has nested or unbalanced feed roots`);
  }

  const entries: string[] = [];
  const entryTag = /<(\/?)entry\b[^>]*>/gi;
  let contentStart: number | undefined;
  for (let match = entryTag.exec(body); match; match = entryTag.exec(body)) {
    const tag = match[0];
    const closing = match[1] === "/";
    if (tag.slice(1, -1).includes("<") || (!closing && /\/\s*>$/.test(tag))) {
      throw new Error(`${repository}: GitHub releases Atom feed has malformed entry structure`);
    }
    if (closing && !/^<\/entry\s*>$/i.test(tag)) {
      throw new Error(`${repository}: GitHub releases Atom feed has a malformed closing entry tag`);
    }
    if (!closing) {
      if (contentStart !== undefined) {
        throw new Error(`${repository}: GitHub releases Atom feed has nested or unbalanced entry structure`);
      }
      contentStart = entryTag.lastIndex;
      continue;
    }
    if (contentStart === undefined) {
      throw new Error(`${repository}: GitHub releases Atom feed has an unexpected closing entry tag`);
    }
    entries.push(body.slice(contentStart, match.index));
    contentStart = undefined;
  }
  if (contentStart !== undefined || /<\/?entry\b/i.test(body.replace(entryTag, ""))) {
    throw new Error(`${repository}: GitHub releases Atom feed has unbalanced or truncated entry structure`);
  }
  return entries;
}

function githubReleaseIdentityFromAtom(
  entry: string,
  repository: string,
): { atomId: string; tag: string; url: string } {
  const ids = atomElements(entry, "id");
  const atomId = ids.length === 1 ? stripHtml(decodeXmlEntities(ids[0] ?? "")) : "";
  if (!atomId || !/^tag:github\.com,2008:Repository\/\d+\/.+$/i.test(atomId)) {
    throw new Error(`${repository}: GitHub releases Atom entry is missing a stable GitHub Atom id`);
  }

  const linkPattern = /<link\b[^>]*\/\s*>/gi;
  const linkTags = [...entry.matchAll(linkPattern)].map((match) => match[0]);
  if (/<\/?link\b/i.test(entry.replace(linkPattern, ""))) {
    throw new Error(`${repository}: GitHub releases Atom entry has a malformed alternate link`);
  }
  const alternateLinks: string[] = [];
  for (const link of linkTags) {
    if (link.slice(1, -2).includes("<")) {
      throw new Error(`${repository}: GitHub releases Atom entry has a malformed alternate link`);
    }
    const rels = atomAttributes(link, "rel");
    if (rels.length > 1) throw new Error(`${repository}: GitHub releases Atom entry has a malformed alternate link`);
    if ((rels[0] ?? "alternate").toLowerCase() === "alternate") alternateLinks.push(link);
  }
  if (alternateLinks.length !== 1) {
    throw new Error(`${repository}: GitHub releases Atom entry must have exactly one alternate release link`);
  }
  const hrefValues = atomAttributes(alternateLinks[0]!, "href");
  if (hrefValues.length !== 1 || !hrefValues[0]) {
    throw new Error(`${repository}: GitHub releases Atom entry has a malformed alternate link`);
  }
  const href = hrefValues[0];

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new Error(`${repository}: GitHub releases Atom entry has a malformed alternate link`);
  }
  const prefix = `/${repository}/releases/tag/`;
  if (
    url.protocol !== "https:"
    || url.hostname !== "github.com"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.pathname.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()
  ) {
    throw new Error(`${repository}: GitHub releases Atom entry alternate link escaped the configured repository`);
  }
  const encodedTag = url.pathname.slice(prefix.length);
  if (!encodedTag) throw new Error(`${repository}: GitHub releases Atom entry alternate link is missing a release tag`);
  let tag: string;
  try {
    tag = decodeURIComponent(encodedTag);
  } catch {
    throw new Error(`${repository}: GitHub releases Atom entry has a malformed release tag`);
  }
  if (!tag.trim() || tag !== tag.trim() || /[\u0000-\u001f\u007f]/.test(tag)) {
    throw new Error(`${repository}: GitHub releases Atom entry has a malformed release tag`);
  }
  if (!atomId.endsWith(`/${tag}`)) {
    throw new Error(`${repository}: GitHub releases Atom entry id and alternate release tag disagree`);
  }
  return { atomId, tag, url: githubReleaseUrl(repository, tag) };
}

function isLikelyPrereleaseTag(tag: string | undefined): boolean {
  return tag !== undefined
    && /(?:^|[._@/+~-])(?:alpha|beta|rc|pre(?:view|release)?|dev|canary|nightly|snapshot)(?:$|[._+~-]|\d)/i.test(tag);
}

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel("upstream response rejected").catch(() => undefined);
}

async function collectGithubReleaseAtom(
  repository: string,
  perRepo: number,
  includePrereleases: boolean,
  watchTerms: string[],
): Promise<GithubRepositoryReleases> {
  const response = await fetchWithTimeout(githubReleaseAtomUrl(repository), {
    headers: { accept: "application/atom+xml", "user-agent": "Driftglass/0.9" },
    redirect: "manual",
  });
  if (!response.ok) {
    const status = response.status;
    await discardResponseBody(response);
    throw new Error(`${repository}: GitHub releases Atom feed returned HTTP ${status}`);
  }
  const xml = await readBoundedResponseText(
    response,
    MAX_GITHUB_RELEASES_ATOM_RESPONSE_BYTES,
    `${repository}: GitHub releases Atom feed exceeds 2 MB`,
  );
  const entries = parseGithubReleaseAtomEntries(xml, repository);
  const parsedEntries = entries.map((entry) => {
    const identity = githubReleaseIdentityFromAtom(entry, repository);
    const releaseUpdatedAt = canonicalEvidenceTimestamp(atomText(entry, "updated"));
    if (!releaseUpdatedAt) {
      throw new Error(`${repository}: GitHub releases Atom entry has a missing or invalid updated timestamp`);
    }
    return {
      ...identity,
      releaseUpdatedAt,
      title: atomText(entry, "title") || identity.tag || "GitHub release",
      text: atomText(entry, "content") ?? "",
      author: atomText(atomElement(entry, "author") ?? "", "name"),
      prereleaseTagSignal: isLikelyPrereleaseTag(identity.tag),
    };
  });
  if (new Set(parsedEntries.map((entry) => entry.atomId)).size !== parsedEntries.length) {
    throw new Error(`${repository}: GitHub releases Atom feed repeated a stable entry id`);
  }
  if (new Set(parsedEntries.map((entry) => entry.tag)).size !== parsedEntries.length) {
    throw new Error(`${repository}: GitHub releases Atom feed repeated a release tag`);
  }

  const items: NormalizedItemInput[] = [];
  let inferredPrereleasesExcluded = 0;
  for (const entry of parsedEntries) {
    if (!includePrereleases && entry.prereleaseTagSignal) {
      inferredPrereleasesExcluded += 1;
      continue;
    }
    items.push({
      externalId: githubReleaseExternalId(repository, entry.tag),
      url: entry.url,
      title: `${repository}: ${entry.title}`,
      text: entry.text,
      author: entry.author,
      observedAt: entry.releaseUpdatedAt,
      accessClass: "public",
      metadata: {
        platform: "github",
        repository,
        tag: entry.tag,
        atomEntryId: entry.atomId,
        prereleaseTagSignal: entry.prereleaseTagSignal,
        prereleaseSignalCoverage: "incomplete",
        releaseUpdatedAt: entry.releaseUpdatedAt,
        timestampSource: "atom-updated",
        identityScheme: "repository-tag-v1",
        watchTerms,
      },
    });
    if (items.length >= perRepo) break;
  }
  return { items, inferredPrereleasesExcluded };
}

export async function collectGithubReleases(source: SourceRecord, env: Env): Promise<SourceAdapterResult> {
  const config = parseJson<GithubConfig>(source.config_json, {});
  const repos = normalizeGithubRepositories(config.repos, 25);
  if (repos.length === 0) throw new Error("github_releases source needs config.repos");
  const perRepo = Math.max(1, Math.min(10, config.perRepo ?? 3));
  const headers = new Headers({
    accept: "application/vnd.github+json",
    "user-agent": "Driftglass/0.1",
    "x-github-api-version": "2022-11-28",
  });
  if (env.GITHUB_TOKEN) headers.set("authorization", `Bearer ${env.GITHUB_TOKEN}`);
  const accessClass = env.GITHUB_TOKEN ? "private" as const : "public" as const;
  const authenticated = Boolean(env.GITHUB_TOKEN);

  const watchTerms = normalizeStringArray(config.watchTerms);
  const settled = await settleRemoteSourceRequests(
    repos,
    async (repo): Promise<GithubRepositoryReleases> => {
      if (!authenticated) {
        return collectGithubReleaseAtom(repo, perRepo, Boolean(config.includePrereleases), watchTerms);
      }

      const response = await fetchWithTimeout(githubRepositoryApiUrl(repo, "releases", perRepo), {
        headers,
        redirect: "manual",
      });
      if (!response.ok) {
        const status = response.status;
        await discardResponseBody(response);
        throw new Error(`${repo}: HTTP ${status}`);
      }
      const releases = await readBoundedResponseJson<GithubRelease[]>(
        response,
        MAX_GITHUB_RELEASES_RESPONSE_BYTES,
        `${repo}: GitHub releases response exceeds 2 MB`,
      );
      const items = releases
        .filter((release) => !release.draft && (config.includePrereleases || !release.prerelease))
        .map((release) => ({
          externalId: githubReleaseExternalId(repo, release.tag_name),
          url: githubReleaseUrl(repo, release.tag_name),
          title: `${repo}: ${release.name || release.tag_name}`,
          text: release.body ?? "",
          author: release.author?.login,
          publishedAt: release.published_at ?? undefined,
          accessClass,
          metadata: {
            platform: "github",
            repository: repo,
            tag: release.tag_name,
            restReleaseId: release.id,
            prerelease: release.prerelease,
            identityScheme: "repository-tag-v1",
            watchTerms,
          },
        }));
      return { items };
    },
  );

  const fulfilled = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const items = fulfilled.flatMap((result) => result.items);
  const errors = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : [],
  );
  if (items.length === 0 && errors.length === repos.length) {
    throw new Error(`Every GitHub repository failed: ${errors.join("; ")}`);
  }
  const transport = authenticated ? "rest" as const : "atom" as const;
  return {
    items,
    provider: authenticated ? "github-rest" : "github-atom",
    details: {
      repos,
      returned: items.length,
      partial: errors.length > 0,
      errors: errors.slice(0, 10),
      transport,
      identityScheme: "repository-tag-v1",
      observationTimeSource: authenticated ? "collection" : "atom-updated",
      prereleaseFilter: authenticated ? "github-flag" : "best-effort-tag-signal",
      prereleaseFilterCoverage: authenticated ? "complete" : "incomplete",
      ...(!authenticated ? {
        inferredPrereleasesExcluded: fulfilled.reduce(
          (total, result) => total + (result.inferredPrereleasesExcluded ?? 0),
          0,
        ),
      } : {}),
    },
  };
}
