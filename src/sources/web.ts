import { renderAdaptive, renderEngineLabel } from "../rendering";
import { assertPublicHttpUrl } from "../security";
import type { Env, NormalizedItemInput, RenderStrategy, SourceAdapterResult, SourceRecord } from "../types";
import { excerpt, htmlTitle, parseJson, readableHtmlText, readBoundedResponseText } from "../utils";
import { discardRemoteSourceResponse, fetchPublicSourceResponse } from "./remote-runtime";

const MAX_DIRECT_PAGE_BYTES = 3_000_000;

interface WebConfig {
  url?: string;
  title?: string;
  browserFallback?: boolean; // v0.1 import compatibility
  renderStrategy?: RenderStrategy;
  minDirectTextLength?: number;
  mode?: "monitor" | "article";
  selector?: string;
  waitForRenderedPage?: boolean;
}

export async function collectWeb(source: SourceRecord, env: Env): Promise<SourceAdapterResult> {
  const config = parseJson<WebConfig>(source.config_json, {});
  if (!config.url) throw new Error("web source needs config.url");
  const requestedUrl = assertPublicHttpUrl(config.url);
  const minimum = Math.max(100, config.minDirectTextLength ?? 700);
  const strategy: RenderStrategy = config.browserFallback === false
    ? "direct"
    : config.renderStrategy ?? "adaptive";

  let title = config.title;
  let pageText = "";
  let publicRaw = "";
  let contentType = "";
  let provider = "direct-fetch";
  let finalUrl = requestedUrl.toString();
  let etag: string | null = null;
  let lastModified: string | null = null;
  let directError: string | undefined;
  let renderDetails: Record<string, unknown> | undefined;

  try {
    const direct = await fetchPublicSourceResponse(requestedUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8",
        "user-agent": "Driftglass/0.2 (personal intelligence collector)",
      },
    });
    const response = direct.response;
    if (!response.ok) {
      const status = response.status;
      await discardRemoteSourceResponse(response, "Web source response rejected");
      throw new Error(`HTTP ${status}`);
    }
    finalUrl = direct.finalUrl.toString();
    contentType = response.headers.get("content-type") ?? "";
    etag = response.headers.get("etag");
    lastModified = response.headers.get("last-modified");
    publicRaw = await readBoundedResponseText(
      response,
      MAX_DIRECT_PAGE_BYTES,
      "Page is larger than the 3 MB direct-fetch limit",
    );
    pageText = publicRaw;
    if (contentType.includes("html")) {
      title ||= htmlTitle(publicRaw);
      pageText = readableHtmlText(publicRaw, {
        preferArticle: true,
        firstArticleOnly: (config.mode ?? "monitor") === "monitor",
      });
    }
  } catch (error) {
    directError = error instanceof Error ? error.message : String(error);
  }

  const shouldRender = strategy !== "direct" && (
    config.waitForRenderedPage === true ||
    !pageText ||
    pageText.length < minimum
  );

  if (shouldRender && env.BROWSER) {
    const rendered = await renderAdaptive({
      url: requestedUrl,
      env,
      sourceId: source.id,
      selector: config.selector,
      strategy,
    });
    const renderedText = rendered.text.trim() || (rendered.html
      ? readableHtmlText(rendered.html, {
        preferArticle: true,
        firstArticleOnly: (config.mode ?? "monitor") === "monitor",
      })
      : "");
    if (renderedText.length > pageText.length || !pageText || config.waitForRenderedPage === true) {
      pageText = renderedText;
      title ||= rendered.title;
      finalUrl = rendered.finalUrl || finalUrl;
      publicRaw = rendered.html?.slice(0, 1_000_000) || renderedText.slice(0, 1_000_000);
      provider = rendered.engine === "kitesurf" ? "cloudflare-kitesurf" : "cloudflare-chromium";
      contentType ||= rendered.html ? "text/html" : "text/markdown";
      renderDetails = {
        engine: rendered.engine,
        engineLabel: renderEngineLabel(rendered.engine),
        elapsedMs: rendered.elapsedMs,
        browserMs: rendered.browserMs,
        attempts: rendered.attempts,
        truncated: rendered.truncated === true,
      };
    }
  }

  if (!pageText.trim()) {
    throw new Error(directError ? `Direct fetch failed (${directError}) and adaptive rendering returned no content` : "Page returned no usable content");
  }

  const item: NormalizedItemInput = {
    // Deliberately omit externalId: a monitored URL can produce multiple revisions.
    url: finalUrl,
    title: title || requestedUrl.hostname,
    text: pageText,
    publishedAt: lastModified ?? undefined,
    metadata: {
      platform: "web",
      mode: config.mode ?? "monitor",
      contentType,
      etag,
      contentLength: pageText.length,
      preview: excerpt(pageText, 240),
      finalUrl,
      directError,
      renderStrategy: strategy,
      render: renderDetails,
      selector: config.selector,
    },
    raw: publicRaw ? publicRaw.slice(0, 1_000_000) : undefined,
  };
  return {
    items: [item],
    provider,
    details: {
      contentLength: pageText.length,
      directError,
      renderStrategy: strategy,
      render: renderDetails,
      partial: Boolean((directError && provider !== "direct-fetch") || renderDetails?.truncated === true),
    },
  };
}
