import { z } from "zod";
import { assertPublicHttpUrl } from "./security";

export interface KnowledgeSearchResult {
  id: string;
  title: string;
  url: string;
}

export interface KnowledgeSearchOutput {
  results: KnowledgeSearchResult[];
}

export interface KnowledgeFetchOutput {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata?: Record<string, unknown>;
}

export const knowledgeSearchOutputSchema = {
  results: z.array(z.object({
    id: z.string(),
    title: z.string(),
    url: z.string(),
  })),
};

export const knowledgeFetchOutputSchema = {
  id: z.string(),
  title: z.string(),
  text: z.string(),
  url: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

const PRIVATE_CAPABILITY_PATH = /^\/(?:mcp|packet|corpus|feedback)\/[a-z0-9_-]{24,}(?:\/|$)/i;
const SECRET_PARAMETER = /^(?:access_?token|api_?key|auth|authorization|key|secret|signature|token)$/i;

function isSafeCitationUrl(url: URL): boolean {
  if (PRIVATE_CAPABILITY_PATH.test(url.pathname)) return false;
  if ([...url.searchParams.keys()].some((key) => SECRET_PARAMETER.test(key))) return false;
  if (/(?:^|[?#&])(?:access_?token|api_?key|auth|authorization|key|secret|signature|token)=/i.test(url.hash)) return false;
  return true;
}

export function publicKnowledgeUrl(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = assertPublicHttpUrl(candidate);
      if (isSafeCitationUrl(url)) return url.href;
    } catch {
      // Local, private-network, non-HTTP, and malformed links are not citable.
    }
  }
  return "";
}

export function knowledgeSearchOutput(
  candidates: Array<{ id: string; title: string; url: string | null | undefined }>,
): KnowledgeSearchOutput {
  return {
    results: candidates.flatMap((candidate) => {
      const url = publicKnowledgeUrl(candidate.url);
      return url ? [{ id: candidate.id, title: candidate.title, url }] : [];
    }),
  };
}

export function knowledgeFetchOutput(input: KnowledgeFetchOutput): KnowledgeFetchOutput {
  return {
    id: input.id,
    title: input.title,
    text: input.text,
    url: publicKnowledgeUrl(input.url),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function knowledgeToolResult<T extends KnowledgeSearchOutput | KnowledgeFetchOutput>(payload: T) {
  return {
    structuredContent: payload,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}
