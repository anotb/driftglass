import { renderAdaptive } from "../rendering";
import { assertPublicHttpUrl } from "../security";
import type { Env, NormalizedItemInput, RenderStrategy, SourceAdapterResult, SourceRecord } from "../types";
import { canonicalizeUrl, excerpt, htmlTitle, parseJson, readBoundedResponseText, stripHtml } from "../utils";
import { collectWeb } from "./web";
import {
  discardRemoteSourceResponse,
  fetchPublicSourceResponse,
  MAX_PUBLIC_SOURCE_REQUESTS,
} from "./remote-runtime";

const MAX_LISTING_PAGE_BYTES = 3_000_000;
const MAX_WEB_FEED_SOURCE_REQUESTS = 50;

interface WebFeedConfig {
  url?: string;
  title?: string;
  renderStrategy?: RenderStrategy;
  articleRenderStrategy?: RenderStrategy;
  sameOrigin?: boolean;
  includePattern?: string;
  excludePattern?: string;
  maxLinks?: number;
  fetchArticles?: boolean;
  maxArticles?: number;
  minLinkTextLength?: number;
  selector?: string;
}

interface CandidateLink {
  url: string;
  text: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function linksFromHtml(html: string, base: URL): CandidateLink[] {
  const results: CandidateLink[] = [];
  const anchor = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) && results.length < 1_500) {
    const href = decodeEntities(match[1] || match[2] || match[3] || "").trim();
    if (!href || href.startsWith("#") || /^(?:mailto|tel|javascript):/i.test(href)) continue;
    try {
      const url = assertPublicHttpUrl(new URL(href, base).toString());
      const text = stripHtml(decodeEntities(match[4] || "")).replace(/\s+/g, " ").trim();
      results.push({ url: url.toString(), text });
    } catch {
      // Ignore malformed and non-public links from the listing page.
    }
  }
  return results;
}

function optionalRegex(value: string | undefined, label: string): RegExp | null {
  if (!value?.trim()) return null;
  if (value.length > 300) throw new Error(`${label} is too long`);
  try {
    return new RegExp(value, "i");
  } catch (error) {
    throw new Error(`${label} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function selectCandidates(input: CandidateLink[], base: URL, config: WebFeedConfig): CandidateLink[] {
  const sameOrigin = config.sameOrigin !== false;
  const include = optionalRegex(config.includePattern, "includePattern");
  const exclude = optionalRegex(config.excludePattern, "excludePattern");
  const minText = Math.max(0, Math.min(120, config.minLinkTextLength ?? 8));
  const maxLinks = Math.max(1, Math.min(100, config.maxLinks ?? 30));
  const seen = new Set<string>();
  const selected: CandidateLink[] = [];

  for (const candidate of input) {
    let target: URL;
    try {
      target = assertPublicHttpUrl(new URL(candidate.url, base).toString());
    } catch {
      continue;
    }
    target.hash = "";
    if (sameOrigin && target.origin !== base.origin) continue;
    const canonical = canonicalizeUrl(target.toString()) || target.toString();
    if (canonical === (canonicalizeUrl(base.toString()) || base.toString()) || seen.has(canonical)) continue;
    const text = candidate.text.replace(/\s+/g, " ").trim();
    const haystack = `${target.pathname}${target.search}\n${text}`;
    if (include && !include.test(haystack)) continue;
    if (exclude?.test(haystack)) continue;
    if (!include && /\/(?:tag|tags|category|categories|author|authors|search|login|signin|privacy|terms|about|contact)(?:\/|$)/i.test(target.pathname)) continue;
    if (text.length < minText && target.pathname.split("/").filter(Boolean).length < 2) continue;
    if (/^(?:home|menu|next|previous|older|newer|more|read more|learn more)$/i.test(text)) continue;
    seen.add(canonical);
    selected.push({ url: canonical, text: text || target.pathname.split("/").filter(Boolean).pop() || target.hostname });
    if (selected.length >= maxLinks) break;
  }
  return selected;
}

async function listingLinks(source: SourceRecord, env: Env, config: WebFeedConfig): Promise<{
  links: CandidateLink[];
  provider: string;
  title?: string;
  details: Record<string, unknown>;
}> {
  const requested = assertPublicHttpUrl(config.url!);
  let finalUrl = requested;
  let html = "";
  let title = config.title;
  let directError: string | undefined;

  try {
    const direct = await fetchPublicSourceResponse(requested, {
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9",
        "user-agent": "Driftglass/0.2 (page-feed discovery)",
      },
    });
    const response = direct.response;
    if (!response.ok) {
      const status = response.status;
      await discardRemoteSourceResponse(response, "Web Feed listing response rejected");
      throw new Error(`HTTP ${status}`);
    }
    finalUrl = direct.finalUrl;
    html = await readBoundedResponseText(
      response,
      MAX_LISTING_PAGE_BYTES,
      "Listing page exceeds the 3 MB direct-fetch limit",
    );
    title ||= htmlTitle(html);
  } catch (error) {
    directError = error instanceof Error ? error.message : String(error);
  }

  let candidates = html ? linksFromHtml(html, finalUrl) : [];
  const directSelected = selectCandidates(candidates, finalUrl, config);
  const strategy = config.renderStrategy ?? "adaptive";
  if ((directSelected.length < Math.min(5, config.maxLinks ?? 30) || !html) && strategy !== "direct" && env.BROWSER) {
    const rendered = await renderAdaptive({
      url: requested,
      env,
      sourceId: source.id,
      selector: config.selector,
      strategy,
      includeLinks: true,
    });
    title ||= rendered.title;
    finalUrl = assertPublicHttpUrl(rendered.finalUrl || finalUrl.toString());
    candidates = rendered.links?.length ? rendered.links : rendered.html ? linksFromHtml(rendered.html, finalUrl) : [];
    return {
      links: selectCandidates(candidates, finalUrl, config),
      provider: rendered.engine === "kitesurf" ? "cloudflare-kitesurf-page-feed" : "cloudflare-chromium-page-feed",
      title,
      details: {
        directError,
        engine: rendered.engine,
        elapsedMs: rendered.elapsedMs,
        browserMs: rendered.browserMs,
        attempts: rendered.attempts,
        truncated: rendered.truncated === true,
        discovered: candidates.length,
      },
    };
  }

  if (!directSelected.length && directError) throw new Error(`Page Feed discovery failed: ${directError}`);
  return {
    links: directSelected,
    provider: "direct-page-feed",
    title,
    details: { directError, discovered: candidates.length },
  };
}

async function enrichCandidate(
  source: SourceRecord,
  env: Env,
  config: WebFeedConfig,
  candidate: CandidateLink,
): Promise<NormalizedItemInput> {
  if (config.fetchArticles === false) {
    return {
      externalId: candidate.url,
      url: candidate.url,
      title: candidate.text,
      text: candidate.text,
      metadata: { platform: "web-feed", listingUrl: config.url, preview: candidate.text },
    };
  }

  const articleSource: SourceRecord = {
    ...source,
    kind: "web",
    config_json: JSON.stringify({
      url: candidate.url,
      title: candidate.text,
      mode: "article",
      renderStrategy: config.articleRenderStrategy ?? "direct",
      minDirectTextLength: 600,
    }),
  };
  try {
    const result = await collectWeb(articleSource, env);
    const item = result.items[0];
    if (!item) throw new Error("Article returned no item");
    return {
      ...item,
      externalId: candidate.url,
      title: item.title || candidate.text,
      metadata: {
        ...(item.metadata ?? {}),
        platform: "web-feed",
        listingUrl: config.url,
        listingTitle: config.title,
        discoveryText: candidate.text,
        articleProvider: result.provider,
      },
    };
  } catch (error) {
    return {
      externalId: candidate.url,
      url: candidate.url,
      title: candidate.text,
      text: candidate.text,
      metadata: {
        platform: "web-feed",
        listingUrl: config.url,
        preview: excerpt(candidate.text, 240),
        enrichmentError: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function collectWebFeed(source: SourceRecord, env: Env): Promise<SourceAdapterResult> {
  const config = parseJson<WebFeedConfig>(source.config_json, {});
  if (!config.url) throw new Error("web_feed source needs config.url");
  const listing = await listingLinks(source, env, config);
  const requestedMaxArticles = Math.max(1, Math.min(20, config.maxArticles ?? 8));
  const capacityMaxArticles = config.fetchArticles === false
    ? requestedMaxArticles
    : Math.floor((MAX_WEB_FEED_SOURCE_REQUESTS - MAX_PUBLIC_SOURCE_REQUESTS) / MAX_PUBLIC_SOURCE_REQUESTS);
  const maxArticles = Math.min(requestedMaxArticles, capacityMaxArticles);
  const selected = listing.links.slice(0, maxArticles);
  const items: NormalizedItemInput[] = [];
  for (let offset = 0; offset < selected.length; offset += 4) {
    items.push(...await Promise.all(selected.slice(offset, offset + 4).map((candidate) => enrichCandidate(source, env, config, candidate))));
  }
  return {
    items,
    provider: listing.provider,
    details: {
      ...listing.details,
      listingTitle: listing.title,
      selected: listing.links.length,
      enriched: items.length,
      fetchArticles: config.fetchArticles !== false,
      requestedMaxArticles,
      capacityMaxArticles,
      capacityDeferredArticles: Math.max(0, Math.min(listing.links.length, requestedMaxArticles) - selected.length),
      partial: Boolean(
        listing.details.partial
        || Math.min(listing.links.length, requestedMaxArticles) > selected.length
      ),
    },
  };
}
