import type { NormalizedItemInput, SourceAdapterResult, SourceRecord } from "../types";
import { fetchWithTimeout, numberFrom, parseJson, readBoundedResponseText } from "../utils";
import { discardRemoteSourceResponse } from "./remote-runtime";

const MAX_ARXIV_RESPONSE_BYTES = 4_000_000;

interface ArxivConfig {
  query?: string;
  categories?: string[];
  limit?: number;
  sortBy?: "submittedDate" | "lastUpdatedDate" | "relevance";
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match ? decodeXml(match[1] ?? "") : undefined;
}

function allTags(block: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...block.matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "gi"))]
    .map((match) => decodeXml(match[1] ?? ""))
    .filter(Boolean);
}

export async function collectArxiv(source: SourceRecord): Promise<SourceAdapterResult> {
  const config = parseJson<ArxivConfig>(source.config_json, {});
  const categories = Array.isArray(config.categories) ? config.categories.map(String).filter(Boolean) : [];
  const terms: string[] = [];
  if (config.query?.trim()) terms.push(`all:${config.query.trim()}`);
  for (const category of categories) terms.push(`cat:${category}`);
  if (!terms.length) throw new Error("arXiv sources require config.query or config.categories");
  const limit = Math.max(1, Math.min(100, numberFrom(config.limit, 30)));
  const endpoint = new URL("https://export.arxiv.org/api/query");
  endpoint.searchParams.set("search_query", terms.length === 1 ? terms[0]! : terms.map((term) => `(${term})`).join(" OR "));
  endpoint.searchParams.set("start", "0");
  endpoint.searchParams.set("max_results", String(limit));
  endpoint.searchParams.set("sortBy", config.sortBy ?? "submittedDate");
  endpoint.searchParams.set("sortOrder", "descending");
  const response = await fetchWithTimeout(endpoint, {
    redirect: "manual",
    headers: { accept: "application/atom+xml", "user-agent": "Driftglass/0.2 (personal research radar)" },
  });
  if (!response.ok) {
    const status = response.status;
    await discardRemoteSourceResponse(response, "arXiv response rejected");
    throw new Error(`arXiv returned ${status}`);
  }
  const xml = await readBoundedResponseText(response, MAX_ARXIV_RESPONSE_BYTES, "arXiv response exceeds 4 MB");
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1] ?? "");
  const items: NormalizedItemInput[] = entries.slice(0, limit).map((entry) => {
    const id = tag(entry, "id");
    const title = tag(entry, "title") || "arXiv paper";
    const summary = tag(entry, "summary") || "";
    const authors = allTags(entry, "name");
    const categoryMatch = entry.match(/<arxiv:primary_category[^>]*term=["']([^"']+)["']/i)
      ?? entry.match(/<category[^>]*term=["']([^"']+)["']/i);
    const pdfMatch = entry.match(/<link[^>]*title=["']pdf["'][^>]*href=["']([^"']+)["']/i);
    return {
      externalId: id,
      url: id,
      title,
      text: summary,
      author: authors.join(", "),
      publishedAt: tag(entry, "published") ?? tag(entry, "updated"),
      metadata: {
        platform: "arxiv",
        authors,
        updatedAt: tag(entry, "updated"),
        primaryCategory: categoryMatch?.[1],
        categories: [...entry.matchAll(/<category[^>]*term=["']([^"']+)["']/gi)].map((match) => match[1]),
        pdfUrl: pdfMatch?.[1],
      },
    };
  });
  return { items, provider: "arxiv-atom", details: { query: endpoint.searchParams.get("search_query"), returned: items.length } };
}
