const DEVELOPMENT_LIMIT = 2;
const SOURCE_LIMIT_PER_DEVELOPMENT = 3;
const LEAD_EXCERPT_LIMIT = 360;
const TITLE_LIMIT = 300;
const CONTEXT_LIMIT = 500;
const LABEL_LIMIT = 180;
const DATE_LIMIT = 80;
const SOURCE_LIMIT_NOTE_COUNT = 2;
const WATCH_LIMIT = 2;

export interface BriefToolTextSource {
  label: string;
  url: string;
  excerpt: string;
}

export interface BriefToolTextDevelopment {
  title: string;
  date: string;
  change?: string;
  context?: string;
  evidenceLead?: { text: string; sourceUrl: string } | null;
  whyIncluded?: string;
  sources: BriefToolTextSource[];
}

export interface BriefToolTextInput {
  title: string;
  date?: string;
  context?: string;
  baseline?: string;
  watchNext?: string[];
  emptyMessage?: string;
  developments: BriefToolTextDevelopment[];
  developmentLimit?: number;
  sourceLimitPerDevelopment?: number;
  sourceLimits?: string[];
  presentationHandoff?: string;
}

function boundedText(value: string | undefined, limit: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function markdownText(value: string | undefined, limit: number): string {
  return boundedText(value, limit).replace(/[\\`*_[\]<>]/g, "\\$&");
}

function markdownLink(source: BriefToolTextSource): string {
  const label = markdownText(source.label, LABEL_LIMIT) || "Source";
  return `${label} — <${source.url}>`;
}

function displayDate(value: string | undefined): string {
  const date = boundedText(value, DATE_LIMIT);
  const isoDate = /^(\d{4}-\d{2}-\d{2})/.exec(date)?.[1];
  return markdownText(isoDate || date, DATE_LIMIT);
}

function orderedDevelopments(
  developments: BriefToolTextDevelopment[],
  limit = DEVELOPMENT_LIMIT,
): BriefToolTextDevelopment[] {
  return developments.slice(0, Math.max(1, Math.min(24, Math.floor(limit))));
}

function developmentLine(
  development: BriefToolTextDevelopment,
  lead: boolean,
  sourceLimit = SOURCE_LIMIT_PER_DEVELOPMENT,
): string[] {
  const title = markdownText(development.title, TITLE_LIMIT) || "Untitled development";
  const changedAt = displayDate(development.date);
  const change = markdownText(development.change, DATE_LIMIT);
  const detail = [change, changedAt].filter(Boolean).join(" · ");
  const context = markdownText(development.context, CONTEXT_LIMIT);
  const sources = development.sources.slice(0, Math.max(1, Math.min(24, Math.floor(sourceLimit))));
  const lines = [`**${title}**${detail ? ` — ${detail}` : ""}`];
  if (context) lines.push(`Mission lens: ${context}`);
  const whyIncluded = markdownText(development.whyIncluded, CONTEXT_LIMIT);
  if (whyIncluded) lines.push(`Why it surfaced: ${whyIncluded}`);
  const boundEvidenceLead = development.evidenceLead
    && sources.some((source) => source.url === development.evidenceLead?.sourceUrl)
    ? development.evidenceLead.text
    : "";
  const selectedLead = boundEvidenceLead
    || (lead ? sources.find((source) => source.excerpt)?.excerpt : "");
  const leadExcerpt = markdownText(selectedLead, LEAD_EXCERPT_LIMIT);
  if (leadExcerpt) lines.push(`Evidence cue: ${leadExcerpt}`);
  if (sources.length) lines.push(`Exact sources: ${sources.map(markdownLink).join(" · ")}`);
  return lines;
}

export function renderBriefToolText(input: BriefToolTextInput): string {
  const date = displayDate(input.date);
  const heading = markdownText(input.title, TITLE_LIMIT) || "Brief";
  const lines = [`# ${heading}${date ? ` — ${date}` : ""}`];
  const context = markdownText(input.context, CONTEXT_LIMIT);
  if (context) lines.push("", context);

  const developments = orderedDevelopments(input.developments, input.developmentLimit);
  if (!developments.length) {
    const emptyMessage = markdownText(input.emptyMessage, CONTEXT_LIMIT);
    lines.push("", "Respond with one concise sentence or one clarifying question. Do not call present_brief, and do not invent a development or watch point.");
    if (emptyMessage) lines.push("", emptyMessage);
    return lines.join("\n");
  }
  const [leadDevelopment, ...otherDevelopments] = developments;
  if (!leadDevelopment) return lines.join("\n");

  const presentationHandoff = input.presentationHandoff
    || "Do not answer yet. Call present_brief exactly once with a short grounded interpretation and exact citation URLs from this evidence. After the card renders, stop without a prose recap.";

  const baseline = markdownText(input.baseline, CONTEXT_LIMIT);
  if (baseline) {
    lines.push("", "Saved Mission context (orientation, not current source evidence):", baseline);
  }

  lines.push(
    "",
    "## Lead evidence",
    ...developmentLine(leadDevelopment, true, input.sourceLimitPerDevelopment),
  );

  if (otherDevelopments.length) {
    lines.push("", "## Other supported developments");
    for (const development of otherDevelopments) {
      lines.push("", ...developmentLine(development, false, input.sourceLimitPerDevelopment));
    }
  }

  const watchNext = (input.watchNext ?? [])
    .slice(0, WATCH_LIMIT)
    .map((item) => markdownText(item, CONTEXT_LIMIT))
    .filter(Boolean);
  if (watchNext.length) lines.push("", "## Watch next", ...watchNext.map((item) => `- ${item}`));

  const sourceLimits = (input.sourceLimits ?? [])
    .slice(0, SOURCE_LIMIT_NOTE_COUNT)
    .map((limit) => markdownText(limit, CONTEXT_LIMIT))
    .filter(Boolean);
  if (sourceLimits.length) {
    lines.push("", "Evidence note:", ...sourceLimits.map((limit) => `- ${limit}`));
  }

  lines.push("", presentationHandoff);

  return lines.join("\n");
}
