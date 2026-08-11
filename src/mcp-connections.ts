import type { Env } from "./types";
import { json } from "./utils";

export const MCP_READ_SCOPE = "driftglass:read";
const OWNER_ID = "owner";

interface ConnectionGrant {
  id: string;
  scope: string[];
  metadata: unknown;
  createdAt: number;
  expiresAt?: number;
}

interface ConnectionGrantPage {
  items: ConnectionGrant[];
  cursor?: string;
}

interface ConnectionHelpers {
  listUserGrants(userId: string, options?: { limit?: number; cursor?: string }): Promise<ConnectionGrantPage>;
  revokeGrant(grantId: string, userId: string): Promise<void>;
}

const CONNECTION_PAGE_SIZE = 100;
const MAX_CONNECTION_PAGES = 10;

function oauthHelpers(env: Env): ConnectionHelpers | null {
  return (env as Env & { OAUTH_PROVIDER?: ConnectionHelpers }).OAUTH_PROVIDER ?? null;
}

function connectionName(grant: ConnectionGrant): string {
  if (!grant.metadata || typeof grant.metadata !== "object") return "Connected model";
  const value = (grant.metadata as Record<string, unknown>).clientName;
  if (typeof value !== "string") return "Connected model";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "Connected model";
}

function connectionOrigin(grant: ConnectionGrant): string | null {
  if (!grant.metadata || typeof grant.metadata !== "object") return null;
  const value = (grant.metadata as Record<string, unknown>).clientOrigin;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

async function listConnectionGrants(helpers: ConnectionHelpers): Promise<ConnectionGrant[]> {
  const grants: ConnectionGrant[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_CONNECTION_PAGES; pageNumber += 1) {
    const page = await helpers.listUserGrants(OWNER_ID, { limit: CONNECTION_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    grants.push(...page.items);
    if (!page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }
  return grants;
}

export async function handleMcpConnectionApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/reasoning/connections" && request.method === "GET") {
    const helpers = oauthHelpers(env);
    if (!helpers) return json({ ok: true, available: false, connections: [] });
    const grants = await listConnectionGrants(helpers);
    return json({
      ok: true,
      available: true,
      connections: grants
        .filter((grant) => Array.isArray(grant.scope) && grant.scope.includes(MCP_READ_SCOPE))
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((grant) => ({
          id: grant.id,
          name: connectionName(grant),
          origin: connectionOrigin(grant),
          connectedAt: new Date(grant.createdAt * 1_000).toISOString(),
          expiresAt: grant.expiresAt ? new Date(grant.expiresAt * 1_000).toISOString() : null,
        })),
    });
  }

  const match = url.pathname.match(/^\/api\/reasoning\/connections\/([^/]+)$/);
  if (!match || request.method !== "DELETE") return null;
  const helpers = oauthHelpers(env);
  if (!helpers) return json({ ok: false, error: "No model connection was found." }, { status: 404 });
  let grantId: string;
  try {
    grantId = decodeURIComponent(match[1] ?? "");
  } catch {
    return json({ ok: false, error: "Invalid connection." }, { status: 400 });
  }
  if (!grantId || grantId.length > 200) return json({ ok: false, error: "Invalid connection." }, { status: 400 });
  const grants = await listConnectionGrants(helpers);
  if (!grants.some((grant) => grant.id === grantId)) {
    return json({ ok: false, error: "Connection not found." }, { status: 404 });
  }
  await helpers.revokeGrant(grantId, OWNER_ID);
  return json({ ok: true, disconnected: true });
}
