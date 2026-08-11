import { text } from "./utils";

function xmlEscape(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  })[character] ?? character);
}

export function handleDiscoveryRoute(request: Request, publicIndexing = true): Response | null {
  const url = new URL(request.url);
  if (url.pathname === "/robots.txt") {
    return text(publicIndexing ? [
      "User-agent: *",
      "Allow: /",
      "Disallow: /api/",
      "Disallow: /collector/",
      "Disallow: /packet/",
      "Disallow: /corpus/",
      "Disallow: /mcp/",
      "Disallow: /feedback/",
      `Sitemap: ${url.origin}/sitemap.xml`,
      "",
    ].join("\n") : [
      "User-agent: *",
      "Disallow: /",
      "",
    ].join("\n"), { headers: { "cache-control": "public, max-age=3600" } });
  }
  if (url.pathname === "/sitemap.xml") {
    if (!publicIndexing) return text("Not found\n", { status: 404 });
    const paths = [
      "/", "/install.md", "/llms.txt", "/llms-full.txt", "/openapi.json",
      "/.well-known/driftglass.json", "/.well-known/mcp.json", "/.well-known/agent.json",
      "/lenses/catalog.json", "/lenses/schema.json",
      "/intelligence-packs/catalog.json", "/intelligence-packs/schema.json",
    ];
    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...paths.map((path) => `  <url><loc>${xmlEscape(`${url.origin}${path}`)}</loc></url>`),
      "</urlset>",
      "",
    ].join("\n");
    return new Response(body, {
      headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  }
  return null;
}
