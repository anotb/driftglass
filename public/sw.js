const CACHE = "driftglass-shell-v20";
const SHELL = [
  "/", "/index.html", "/styles.css?v=20260808.8", "/app.js?v=20260808.8", "/webmcp.js?v=20260808.8",
  "/manifest.webmanifest", "/icons/driftglass.svg", "/icons/driftglass-og.png",
  "/lenses/schema.json", "/lenses/catalog.json",
  "/intelligence-packs/schema.json", "/intelligence-packs/catalog.json",
];
self.addEventListener("install", (event) => event.waitUntil(
  caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
));
self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()),
));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const dynamicPath = url.pathname === "/mcp"
    || url.pathname === "/authorize"
    || url.pathname === "/health"
    || url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/collector/")
    || url.pathname.startsWith("/packet/")
    || url.pathname.startsWith("/corpus/")
    || url.pathname.startsWith("/mcp/")
    || url.pathname.startsWith("/oauth/")
    || url.pathname.startsWith("/.well-known/oauth-")
    || url.pathname.startsWith("/feedback/")
    || url.pathname.startsWith("/share/");
  if (
    event.request.method !== "GET" ||
    url.origin !== location.origin ||
    dynamicPath
  ) return;
  const navigation = event.request.mode === "navigate"
    && (event.request.headers.get("accept") || "").includes("text/html");
  if (navigation && url.search) {
    event.respondWith(fetch(event.request, { cache: "no-store" }).catch(async () => (
      (await caches.match("/index.html")) || Response.error()
    )));
    return;
  }
  event.respondWith(fetch(event.request).then((response) => {
    const cacheControl = response.headers.get("cache-control") || "";
    if (response.ok && !/(?:^|,)\s*(?:no-store|private)\b/i.test(cacheControl)) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    if (navigation) return (await caches.match("/index.html")) || Response.error();
    return Response.error();
  }));
});
