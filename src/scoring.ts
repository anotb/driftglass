import { clamp, numberFrom } from "./utils";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is", "it", "its",
  "of", "on", "or", "that", "the", "this", "to", "was", "were", "will", "with", "you", "your", "new", "says",
]);

function normalizeToken(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  return token;
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map(normalizeToken)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function canonicalKey(title: string, url?: string): string {
  const tokens = [...new Set(tokenize(title))].slice(0, 12).sort();
  let host = "";
  if (url) {
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
  }
  return `${host}|${tokens.join("-")}`;
}

export function jaccard(left: string, right: string): number {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function relevanceFromTerms(text: string, terms: string[]): number {
  if (terms.length === 0) return 0.5;
  const haystack = text.toLowerCase();
  const exactHits = terms.reduce(
    (count, term) => count + (term.trim() && haystack.includes(term.toLowerCase().trim()) ? 1 : 0),
    0,
  );
  return clamp(0.18 + Math.min(0.82, exactHits * 0.19));
}

export function importanceFromMetadata(metadata: Record<string, unknown>): number {
  const score = numberFrom(metadata.score, 0);
  const comments = numberFrom(metadata.comments, 0);
  const likes = numberFrom(metadata.likes, 0);
  const reposts = numberFrom(metadata.reposts ?? metadata.retweets, 0);
  const views = numberFrom(metadata.views, 0);
  const release = metadata.platform === "github" ? 0.18 : 0;
  const social = Math.log10(1 + score + likes + comments * 2 + reposts * 3 + views / 1000) / 5;
  return clamp(0.34 + release + social);
}

export function storyScore(input: {
  relevance: number;
  novelty: number;
  importance: number;
  confidence: number;
  sourceCount: number;
  sourceWeight: number;
  ageHours: number;
}): number {
  const recency = Math.exp(-Math.max(0, input.ageHours) / 48);
  const corroboration = clamp(Math.log2(Math.max(1, input.sourceCount)) / 3);
  const score =
    input.relevance * 0.3 +
    input.novelty * 0.18 +
    input.importance * 0.17 +
    input.confidence * 0.12 +
    corroboration * 0.12 +
    recency * 0.06 +
    clamp(input.sourceWeight / 2) * 0.05;
  return Math.round(clamp(score) * 1000) / 10;
}
