import { plainTextExcerpt } from "./utils";

const LEAD_LIMIT = 280;
const TERM_LIMIT = 3;

const BOILERPLATE = /^(?:(?:major|minor|patch) changes?|changes?|changelog|full changelog|what'?s changed|release notes?|new contributors?|contributors?|installation|install|package|version|compare|thanks? to|thank you)\b/i;
const LOW_SIGNAL = /^(?:build|bump|chore|ci|deps?|docs?|merge|refactor|release|style|tests?)(?:\b|\s*[:([])/i;
const NAVIGATION_SOUP = /\b(?:skip to content|docs directory|search ctrl k|log in)\b/i;
const CONCRETE_CHANGE = /\b(?:adds?|added|allows?|allowed|break(?:s|ing)?|changes?|changed|deprecat(?:e|es|ed|ing)|enables?|enabled|fix(?:es|ed)?|introduc(?:e|es|ed|ing)|moves?|moved|now|remov(?:e|es|ed|ing)|replac(?:e|es|ed|ing)|requires?|required|ships?|shipped|supports?|supported|updates?|updated)\b/gi;
const RELEASE_IDENTITY = /^@?[a-z0-9._/-]+(?:\s+|@)v?\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?$/i;
const GITHUB_CHANGELOG_ENTRY = /^#\d+\s+\S/;
const GITHUB_PR_REFERENCE_BOUNDARY = /(\(\s*#\d+(?:\s*,\s*#\d+)*\s*\))(?=\s+[A-Z0-9@])/g;
const HASH_ONLY = /^(?:[a-f0-9]{7,64}\s*)+$/i;
const INLINE_HTTP_URL = /https?:\/\/[^\s<>"'`]+/gi;
const INLINE_CAPABILITY_PATH = /\/(?:mcp|packet|corpus|feedback)\/[a-z0-9_-]{16,}(?:\/ops)?(?:[/?#][^\s<>"'`]*)?/gi;
const COMMON_TEXT_ENTITY = /&(lsquo|rsquo|ldquo|rdquo|ndash|mdash|hellip);/gi;

const COMMON_TEXT_ENTITY_VALUE: Readonly<Record<string, string>> = Object.freeze({
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
  hellip: "…",
});

export interface BriefEvidenceSource {
  title?: string;
  excerpt: string;
  url: string;
}

export interface BriefEvidenceLead {
  text: string;
  sourceUrl: string;
}

function normalizedTerms(values: readonly string[]): string[] {
  return [...new Set(values
    .map((value) => plainTextExcerpt(value, 120).toLocaleLowerCase("en"))
    .filter((value) => value.length >= 2))]
    .slice(0, 10);
}

function candidateSegments(value: string): string[] {
  const raw = String(value || "")
    .replace(COMMON_TEXT_ENTITY, (_entity, name: string) => COMMON_TEXT_ENTITY_VALUE[name.toLocaleLowerCase("en")] ?? " ")
    .replace(INLINE_HTTP_URL, " ")
    .replace(INLINE_CAPABILITY_PATH, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/<\/?(?:p|li|h[1-6]|br|div)[^>]*>/gi, "\n")
    // Flattened GitHub release pages often keep the sentence-ending period
    // before a PR-reference group, then run the next feature directly after
    // the closing parenthesis. Preserve the references but restore that lost
    // clause boundary before applying the general sentence splitter.
    .replace(GITHUB_PR_REFERENCE_BOUNDARY, "$1\n")
    .replace(/\s(?:[-*+]\s+|\d+[.)]\s+)/g, "\n")
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9@])/)
    .map((segment) => plainTextExcerpt(segment, LEAD_LIMIT))
    .filter(Boolean);
  return [...new Set(raw)];
}

function termHits(candidate: string, terms: readonly string[]): number {
  const lower = candidate.toLocaleLowerCase("en");
  return terms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
}

function concreteChangeCount(candidate: string): number {
  return [...candidate.matchAll(CONCRETE_CHANGE)].length;
}

function usableCandidate(candidate: string): boolean {
  if (candidate.length < 16
      || BOILERPLATE.test(candidate)
      || NAVIGATION_SOUP.test(candidate)
      || RELEASE_IDENTITY.test(candidate)
      || GITHUB_CHANGELOG_ENTRY.test(candidate)
      || HASH_ONLY.test(candidate)) return false;
  return !/^https?:\/\//i.test(candidate);
}

function candidateScore(
  candidate: string,
  terms: readonly string[],
  packageDescriptionOnly: boolean,
  index: number,
): number | null {
  if (!usableCandidate(candidate)) return null;
  // npm and PyPI adapters intentionally capture package description plus
  // release identity, not version-specific notes. Do not present that stable
  // description as the change introduced by this version.
  if (packageDescriptionOnly) return null;
  const hits = termHits(candidate, terms);
  const concrete = concreteChangeCount(candidate);
  if (LOW_SIGNAL.test(candidate) && hits === 0) return null;
  return hits * 20
    + concrete * 5
    + (candidate.length >= 40 && candidate.length <= 220 ? 3 : 1)
    - index / 1_000;
}

/**
 * Select one exact, display-safe evidence clause without paraphrasing it.
 * Callers provide only sources that already crossed the public citation boundary.
 */
export function selectBriefEvidenceLead(
  sources: readonly BriefEvidenceSource[],
  matchedTerms: readonly string[] = [],
): BriefEvidenceLead | null {
  const terms = normalizedTerms(matchedTerms);
  let best: { text: string; sourceUrl: string; score: number; order: number } | null = null;
  let order = 0;
  for (const source of sources) {
    // Reject the source as a whole. Navigation-heavy pages can otherwise put a
    // plausible-looking sentence before "Skip to content" is split into a
    // later segment, allowing site furniture to masquerade as a change claim.
    if (NAVIGATION_SOUP.test(source.excerpt)) continue;
    // A Mission term already carried by the source title describes the shared
    // actor or product, so it cannot distinguish one clause inside that source.
    const sourceTitle = plainTextExcerpt(source.title ?? "", 300).toLocaleLowerCase("en");
    const sourceTerms = terms.filter((term) => !sourceTitle.includes(term));
    const packageDescriptionOnly = /(?:^|\s)Package:\s*\S+/i.test(source.excerpt)
      && /(?:^|\s)Version:\s*v?\d/i.test(source.excerpt);
    for (const candidate of candidateSegments(source.excerpt)) {
      const score = candidateScore(candidate, sourceTerms, packageDescriptionOnly, order);
      if (score !== null && (!best || score > best.score || (score === best.score && order < best.order))) {
        best = { text: candidate, sourceUrl: source.url, score, order };
      }
      order += 1;
    }
  }
  return best ? { text: best.text, sourceUrl: best.sourceUrl } : null;
}

/** Return only Mission terms that are visible in this brief's public evidence. */
export function publicBriefMatchedTerms(
  sources: readonly BriefEvidenceSource[],
  matchedTerms: readonly string[],
): string[] {
  const publicText = sources
    .flatMap((source) => [source.title ?? "", source.excerpt])
    .map((value) => plainTextExcerpt(value, 1_500).toLocaleLowerCase("en"))
    .join("\n");
  return normalizedTerms(matchedTerms).filter((term) => publicText.includes(term));
}

function quotedTerms(values: readonly string[]): string {
  const terms = normalizedTerms(values).slice(0, TERM_LIMIT);
  return terms.map((term) => `“${term}”`).join(terms.length > 2 ? ", " : " and ");
}

export function briefWhyIncluded(input: {
  missionName?: string;
  matchedTerms?: readonly string[];
  change?: "new" | "changed" | "updated";
}): string {
  const missionName = plainTextExcerpt(input.missionName ?? "", 160);
  const terms = quotedTerms(input.matchedTerms ?? []);
  if (missionName && terms) return `Matched ${missionName} on ${terms}.`;
  if (missionName) return `Relevant to ${missionName}'s standing question.`;
  if (input.change === "changed") return "Materially changed public evidence in the current brief.";
  if (input.change === "updated") return "New public evidence for a developing Story.";
  return "New public evidence in the current brief.";
}
