// Application-facing aliases for Wrangler-generated Cloudflare runtime types.
// Platform bindings and APIs are defined in worker-configuration.d.ts.
type BrowserBinding = BrowserRun;
type AISearchNamespaceBinding = AiSearchNamespace;
type AISearchInstanceBinding = AiSearchInstance;
type AISearchItemRecord = AiSearchItemInfo;
type AISearchChunk = AiSearchSearchResponse["chunks"][number];
