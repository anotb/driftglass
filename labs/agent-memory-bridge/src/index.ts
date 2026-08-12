interface AgentMemoryMessage {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp?: Date;
}

interface AgentMemoryEntry {
  id: string;
  type: "fact" | "event" | "instruction" | "task";
  summary: string;
  content?: string;
  sessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AgentMemoryProfile {
  ingest(messages: Iterable<AgentMemoryMessage>, options?: { sessionId?: string | null }): Promise<void>;
  remember(memory: { content: string; sessionId?: string | null }): Promise<AgentMemoryEntry>;
  recall(query: string, options?: { thinkingLevel?: "low" | "medium" | "high"; responseLength?: "short" | "medium" | "long"; referenceDate?: Date | string }): Promise<{ count: number; answer: string; candidates: Array<{ id: string; summary: string; sessionId: string | null; score: number }> }>;
  list(options?: { limit?: number; cursor?: string; sessionId?: string; type?: AgentMemoryEntry["type"] }): Promise<{ memories: AgentMemoryEntry[]; cursor?: string }>;
  getSummary(options?: { sessionId?: string | null }): Promise<{ summary: string }>;
}

interface AgentMemoryNamespace {
  getProfile(profileName: string): Promise<AgentMemoryProfile>;
  deleteProfile(profileName: string): Promise<void>;
}

interface Env {
  MEMORY: AgentMemoryNamespace;
  BRIDGE_SECRET: string;
  APP_NAME?: string;
}

const MAX_BODY_BYTES = 1_500_000;
const CHUNK_BYTES = 28_000;
const MAX_CHUNKS = 24;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function safeProfile(value: string): string {
  const profile = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
  if (!profile) throw new Error("A profile name is required");
  return profile;
}

async function authorize(request: Request, env: Env): Promise<Response | null> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return token === env.BRIDGE_SECRET ? null : json({ ok: false, error: "Unauthorized" }, 401);
}

async function readJson<T>(request: Request): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Error("Request body is too large");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("Request body is too large");
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function chunks(value: string): string[] {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(value);
  const output: string[] = [];
  for (let offset = 0; offset < bytes.byteLength && output.length < MAX_CHUNKS; offset += CHUNK_BYTES) {
    output.push(decoder.decode(bytes.slice(offset, Math.min(bytes.byteLength, offset + CHUNK_BYTES))));
  }
  return output;
}

async function ingestCheckpoint(profile: AgentMemoryProfile, content: string, checkpointId?: string): Promise<{ checkpointId: string; chunks: number }> {
  const id = (checkpointId || await digest(content)).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48);
  const parts = chunks(content);
  if (!parts.length) throw new Error("Checkpoint content is empty");
  for (let index = 0; index < parts.length; index += 1) {
    await profile.ingest([
      {
        role: "system",
        content: "This is an approved Driftglass epistemic-memory checkpoint. Retain durable facts, events, instructions, tasks, supersession, temporal context, and provenance. Do not treat transient ranking scores as durable facts.",
      },
      { role: "user", content: parts[index]! },
    ], { sessionId: `${id}-${String(index + 1).padStart(2, "0")}`.slice(0, 64) });
  }
  return { checkpointId: id, chunks: parts.length };
}

async function handleProfile(request: Request, env: Env, profileName: string, action: string): Promise<Response> {
  const profile = await env.MEMORY.getProfile(safeProfile(profileName));
  if (action === "sync" && request.method === "POST") {
    const body = await readJson<{ content?: string; checkpointId?: string }>(request);
    const result = await ingestCheckpoint(profile, String(body.content ?? ""), body.checkpointId);
    return json({ ok: true, profile: safeProfile(profileName), ...result }, 201);
  }
  if (action === "sync-url" && request.method === "POST") {
    const body = await readJson<{ url?: string; checkpointId?: string }>(request);
    const url = new URL(String(body.url ?? ""));
    if (url.protocol !== "https:") throw new Error("Checkpoint URL must use HTTPS");
    const response = await fetch(url, { headers: { accept: "text/markdown, application/json;q=0.9, text/plain;q=0.8" } });
    if (!response.ok) throw new Error(`Checkpoint URL returned HTTP ${response.status}`);
    const content = (await response.text()).slice(0, MAX_BODY_BYTES);
    const result = await ingestCheckpoint(profile, content, body.checkpointId);
    return json({ ok: true, profile: safeProfile(profileName), sourceUrl: url.toString(), ...result }, 201);
  }
  if (action === "remember" && request.method === "POST") {
    const body = await readJson<{ content?: string; sessionId?: string | null }>(request);
    const content = String(body.content ?? "").slice(0, 32_000);
    if (!content) throw new Error("Memory content is required");
    return json({ ok: true, memory: await profile.remember({ content, sessionId: body.sessionId ?? null }) }, 201);
  }
  if (action === "recall" && request.method === "POST") {
    const body = await readJson<{ query?: string; thinkingLevel?: "low" | "medium" | "high"; responseLength?: "short" | "medium" | "long"; referenceDate?: string }>(request);
    const query = String(body.query ?? "").slice(0, 1_024);
    if (!query) throw new Error("Recall query is required");
    return json({ ok: true, result: await profile.recall(query, { thinkingLevel: body.thinkingLevel, responseLength: body.responseLength, referenceDate: body.referenceDate }) });
  }
  if (action === "summary" && request.method === "GET") {
    return json({ ok: true, profile: safeProfile(profileName), ...(await profile.getSummary()) });
  }
  if (action === "memories" && request.method === "GET") {
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 50)));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    return json({ ok: true, profile: safeProfile(profileName), ...(await profile.list({ limit, cursor })) });
  }
  throw new Error("Unsupported profile operation");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const denied = await authorize(request, env);
      if (denied) return denied;
      const url = new URL(request.url);
      if (url.pathname === "/health") return json({ ok: true, app: env.APP_NAME ?? "Driftglass Agent Memory Bridge", beta: true, version: "0.9.0" });
      const match = url.pathname.match(/^\/profiles\/([^/]+)\/(sync|sync-url|remember|recall|summary|memories)$/);
      if (!match) return json({ ok: false, error: "Not found" }, 404);
      return await handleProfile(request, env, decodeURIComponent(match[1]!), match[2]!);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  },
};
