import { getMission, getStory, latestStories, listMissions } from "./db";
import { baseUrlFor, requireReadKey } from "./security";
import type { Env } from "./types";
import { HttpError, excerpt, markdown, parseJson } from "./utils";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function escapeXml(value: string): string {
  return escapeHtml(value);
}

export async function handleCorpus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/corpus\/([^/]+)\/(.*)$/);
  if (!match) throw new HttpError(404, "Corpus route not found");
  const readKey = match[1] ?? "";
  const route = match[2] || "index.html";
  await requireReadKey(readKey, env.DRIFTGLASS_SECRET);
  const base = baseUrlFor(request, env.PUBLIC_BASE_URL);
  const corpusBase = `${base}/corpus/${readKey}`;

  if (route === "index.html" || route === "") {
    const [stories, missions] = await Promise.all([latestStories(env.DB, 100), listMissions(env.DB)]);
    const storyLinks = stories.map((story) => `<li><a href="${corpusBase}/stories/${encodeURIComponent(story.id)}.md">${escapeHtml(story.title)}</a><small> changed ${escapeHtml(story.last_changed_at)} · ${story.source_count} sources</small></li>`).join("\n");
    const missionLinks = missions.map((mission) => `<li><a href="${corpusBase}/missions/${encodeURIComponent(mission.id)}.md">${escapeHtml(mission.name)}</a><small> ${escapeHtml(mission.question)}</small></li>`).join("\n");
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Driftglass private intelligence corpus</title></head><body><main><h1>Driftglass private intelligence corpus</h1><p>Generated from persistent story memory and Research Missions. This index is designed for private Cloudflare AI Search ingestion.</p><h2>Research Missions</h2><ul>${missionLinks}</ul><h2>Stories</h2><ul>${storyLinks}</ul></main></body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, max-age=300", "x-robots-tag": "noindex, nofollow" },
    });
  }

  if (route === "sitemap.xml") {
    const [stories, missions] = await Promise.all([latestStories(env.DB, 100), listMissions(env.DB)]);
    const urls = [
      ...missions.map((mission) => `${corpusBase}/missions/${encodeURIComponent(mission.id)}.md`),
      ...stories.map((story) => `${corpusBase}/stories/${encodeURIComponent(story.id)}.md`),
    ];
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((entry) => `<url><loc>${escapeXml(entry)}</loc></url>`).join("")}</urlset>`, {
      headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "private, max-age=300", "x-robots-tag": "noindex, nofollow" },
    });
  }

  const storyMatch = route.match(/^stories\/([^/]+)\.md$/);
  if (storyMatch) {
    const detail = await getStory(env.DB, decodeURIComponent(storyMatch[1] ?? ""));
    if (!detail) throw new HttpError(404, "Story not found");
    const lines = [
      `# ${detail.story.title}`,
      "",
      detail.story.summary,
      "",
      `Story ID: ${detail.story.id}`,
      `First seen: ${detail.story.first_seen_at}`,
      `Last changed: ${detail.story.last_changed_at}`,
      `Score: ${detail.story.score.toFixed(1)}`,
      `Sources: ${detail.story.source_count}`,
      `Confidence: ${detail.story.confidence.toFixed(2)}`,
      "",
      "## Evidence",
    ];
    for (const item of detail.evidence.slice(0, 30)) {
      const metadata = parseJson<Record<string, unknown>>(item.metadata_json, {});
      lines.push(
        "",
        `### ${item.title}`,
        "",
        `Source: ${item.source_name}`,
        item.author ? `Author: ${item.author}` : "",
        `Observed: ${item.published_at ?? item.observed_at}`,
        item.url ? `URL: ${item.url}` : "",
        typeof metadata.provider === "string" ? `Provider: ${metadata.provider}` : "",
        "",
        excerpt(item.text, 8_000),
      );
    }
    return markdown(`${lines.filter(Boolean).join("\n")}\n`, { headers: { "cache-control": "private, max-age=300", "x-robots-tag": "noindex, nofollow" } });
  }

  const missionMatch = route.match(/^missions\/([^/]+)\.md$/);
  if (missionMatch) {
    const mission = await getMission(env.DB, decodeURIComponent(missionMatch[1] ?? ""));
    if (!mission) throw new HttpError(404, "Mission not found");
    return markdown([
      `# Research Mission · ${mission.name}`,
      "",
      mission.question,
      "",
      `Status: ${mission.status}`,
      `Priority: ${mission.priority}`,
      `Terms: ${parseJson<string[]>(mission.terms_json, []).join(", ")}`,
      `Source scope: ${parseJson<string[]>(mission.source_scope_json, []).join(", ") || "all sources"}`,
      `Last evaluated: ${mission.last_evaluated_at ?? "not yet"}`,
      "",
      `Mission packet: ${base}/packet/${readKey}/mission/${encodeURIComponent(mission.id)}.md`,
      "",
    ].join("\n"), { headers: { "cache-control": "private, max-age=300", "x-robots-tag": "noindex, nofollow" } });
  }

  throw new HttpError(404, "Corpus document not found");
}
