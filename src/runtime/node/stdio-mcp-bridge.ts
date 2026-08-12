import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { deriveMcpCapabilityKeys } from "../../security";
import { readBoundedResponseText } from "../../utils";
import type { VerifiedLocalAuthority } from "./authority";

const MCP_HTTP_RESPONSE_MAX_BYTES = 10_000_000;

type JsonRpcMessage = Parameters<StdioServerTransport["send"]>[0];

export type LocalMcpAccess = "read" | "approval";

export interface LocalStdioMcpBridgeOptions {
  readonly origin: string;
  readonly access: LocalMcpAccess;
  readonly authority: VerifiedLocalAuthority;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export function normalizeLocalMcpOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch (error) {
    throw new Error("The local Driftglass origin must be a valid URL", { cause: error });
  }
  const hostname = origin.hostname.toLowerCase();
  if (
    origin.protocol !== "http:"
    || !["127.0.0.1", "[::1]", "::1"].includes(hostname)
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
  ) {
    throw new Error("The local reasoning connection accepts only a plain loopback HTTP origin such as http://127.0.0.1:8787");
  }
  return origin.origin;
}

function responseMessages(body: string, contentType: string): JsonRpcMessage[] {
  if (!body.trim()) return [];
  if (contentType.toLowerCase().includes("text/event-stream")) {
    const messages: JsonRpcMessage[] = [];
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      messages.push(JSON.parse(data) as JsonRpcMessage);
    }
    return messages;
  }
  const parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function messageId(message: JsonRpcMessage): string | number | null | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const value = message as unknown as Record<string, unknown>;
  return typeof value.id === "string" || typeof value.id === "number" || value.id === null
    ? value.id
    : undefined;
}

async function serviceReady(origin: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3_000) });
  } catch (error) {
    throw new Error(`Driftglass is not reachable at ${origin}; start the self-host service before the reasoning connection`, { cause: error });
  }
  if (!response.ok) throw new Error(`Driftglass at ${origin} returned HTTP ${response.status}`);
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload || payload.ok !== true || payload.profile !== "selfhost") {
    throw new Error(`The service at ${origin} is not the expected Driftglass self-host profile`);
  }
}

/**
 * Bridge standard newline-framed stdio MCP to the already-running loopback
 * Driftglass service. Capability keys remain in memory and never appear in
 * process arguments, environment variables, stdout, or diagnostics.
 */
export async function runLocalStdioMcpBridge(options: LocalStdioMcpBridgeOptions): Promise<void> {
  const origin = normalizeLocalMcpOrigin(options.origin);
  await serviceReady(origin);
  const keys = await deriveMcpCapabilityKeys(options.authority.ownerSecret);
  const capabilityPath = options.access === "approval"
    ? `/mcp/${keys.operationsKey}/ops`
    : `/mcp/${keys.readKey}`;
  const endpoint = `${origin}${capabilityPath}`;

  const transport = new StdioServerTransport(
    options.stdin as never,
    options.stdout as never,
    { maxBufferSize: 2_000_000 },
  );
  const diagnostics = options.stderr ?? process.stderr;
  let pending = Promise.resolve();
  let closed = false;
  const ended = new Promise<void>((resolve) => {
    transport.onclose = () => {
      closed = true;
      resolve();
    };
  });
  transport.onerror = (error) => {
    diagnostics.write(`${JSON.stringify({ level: "error", event: "local_reasoning_transport_error", message: errorText(error) })}\n`);
  };
  transport.onmessage = (message) => {
    pending = pending.then(async () => {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(120_000),
        });
        const body = response.status === 204 || response.status === 202
          ? ""
          : await readBoundedResponseText(response, MCP_HTTP_RESPONSE_MAX_BYTES, "Local reasoning response exceeded 10 MB");
        if (!response.ok) throw new Error(`Local Driftglass reasoning request returned HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
        for (const result of responseMessages(body, response.headers.get("content-type") ?? "")) {
          await transport.send(result);
        }
      } catch (error) {
        const id = messageId(message);
        if (id !== undefined) {
          await transport.send({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: errorText(error) },
          } as JsonRpcMessage);
        } else {
          diagnostics.write(`${JSON.stringify({ level: "error", event: "local_reasoning_request_failed", message: errorText(error) })}\n`);
        }
      }
    });
  };

  await transport.start();
  await ended;
  await pending;
  if (!closed) await transport.close();
}
