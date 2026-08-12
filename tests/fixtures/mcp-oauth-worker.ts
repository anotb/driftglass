import { handleMcpConnectionApi } from "../../src/mcp-connections";
import { handleMcpOAuth } from "../../src/mcp-oauth";
import type { Env } from "../../src/types";

async function coreFetch(request: Request, env: Env): Promise<Response> {
  const connection = await handleMcpConnectionApi(request, env);
  if (connection) return connection;
  return new Response("Not found", { status: 404 });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleMcpOAuth(request, env, ctx, coreFetch);
  },
};
