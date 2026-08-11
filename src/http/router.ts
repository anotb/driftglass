import { createRequestLifecycle, type HttpRoute, type HttpRouter, type HttpRouterOptions, type RequestLifecycle } from "./contracts";

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function normalizeRoute(route: HttpRoute): HttpRoute {
  const path = route.path;
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.includes("\\")) {
    throw new TypeError("HTTP route paths must be absolute URL paths without query, fragment, or backslash");
  }
  if (path.length > 1 && path.endsWith("/")) {
    throw new TypeError("HTTP route paths must not end with a slash");
  }
  if (!route.name.trim()) throw new TypeError("HTTP routes require a stable nonempty name");
  if (typeof route.handler !== "function") throw new TypeError("HTTP routes require an injected handler");
  return Object.freeze({ ...route, match: route.match ?? "prefix" });
}

function routeMatches(route: HttpRoute, pathname: string): boolean {
  if (route.match === "exact") return pathname === route.path;
  return pathname === route.path || pathname.startsWith(route.path === "/" ? "/" : route.path + "/");
}

/**
 * Create the inert portable router. Readiness is intentionally unavailable in
 * Phase 3a: constructing a router neither activates a local profile nor
 * authorizes canonical writes.
 */
export function createHttpRouter(options: HttpRouterOptions = {}): HttpRouter {
  const routes = (options.routes ?? []).map(normalizeRoute);
  const identities = new Set<string>();
  for (const route of routes) {
    const identity = (route.match ?? "prefix") + ":" + route.path;
    if (identities.has(identity)) throw new TypeError("Duplicate HTTP route: " + identity);
    identities.add(identity);
  }

  const service = (options.service ?? "driftglass-portable-http").slice(0, 80);
  const version = (options.version ?? "0.9.0").slice(0, 32);

  return Object.freeze({
    async fetch(request: Request, suppliedLifecycle?: RequestLifecycle): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/health") {
        return json({ ok: true, status: "alive", service, version }, 200);
      }
      if (pathname === "/ready") {
        return json({ ok: false, status: "unavailable", reason: "portable runtime is not activated" }, 503);
      }

      const lifecycle = suppliedLifecycle ?? createRequestLifecycle();
      const ownsLifecycle = suppliedLifecycle === undefined;
      try {
        for (const route of routes) {
          if (routeMatches(route, pathname)) return await route.handler(request, lifecycle);
        }
        if (options.assets) return await options.assets(request, lifecycle);
        return json({ ok: false, error: "Not found" }, 404);
      } finally {
        if (ownsLifecycle) void lifecycle.drain();
      }
    },
  });
}
