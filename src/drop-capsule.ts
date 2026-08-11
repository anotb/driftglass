import {
  publicShareRobotsContent,
  recipientShareDocument,
  requirePublicSharePayload,
} from "./share-privacy";
import type { PublicSharePayload, ReviewedShareAnswer, SharedStory } from "./share-privacy";
import type { PublicSharePresentationOptions } from "./public-share-page";
import type { IntelligencePackManifest, StarterPack } from "./types";
import { createStoredZip } from "./zip";

const DRIFTGLASS_QUICK_START_URL = "https://github.com/anotb/driftglass#quick-start";

function html(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function slug(value: string, fallback = "shared-intelligence"): string {
  const output = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  return output || fallback;
}

function distinctAnswer(answer: string | undefined, title: string): string | undefined {
  if (!answer) return undefined;
  const stopwords = new Set(["a", "an", "and", "are", "as", "at", "back", "but", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "treat", "was", "were", "with"]);
  const normalize = (value: string): string[] => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).flatMap((word) => {
    if (!word || stopwords.has(word)) return [];
    if (/^reopen/.test(word)) return ["open"];
    if (/^normaliz/.test(word)) return ["normal"];
    return [word];
  });
  const answerWords = normalize(answer);
  const titleWords = normalize(title);
  if (!answerWords.length || !titleWords.length) return answer;
  if (answerWords.join(" ") === titleWords.join(" ")) return undefined;
  const answerSet = new Set(answerWords);
  const titleSet = new Set(titleWords);
  const overlap = [...answerSet].filter((word) => titleSet.has(word)).length / Math.min(answerSet.size, titleSet.size);
  const lengthRatio = Math.min(answerSet.size, titleSet.size) / Math.max(answerSet.size, titleSet.size);
  return overlap >= 0.82 && lengthRatio >= 0.55 ? undefined : answer;
}

function uniqueItems(...lists: Array<string[] | undefined>): string[] {
  return [...new Set(lists.flatMap((items) => items ?? []))];
}

function answerCitationUrls(answer: ReviewedShareAnswer | undefined): string[] {
  if (!answer) return [];
  const sections = [
    ...(answer.keyJudgments ?? []),
    ...(answer.signposts ?? []),
    ...(answer.alternativeCase ? [answer.alternativeCase] : []),
  ];
  return [...new Set(sections.flatMap((item) => typeof item === "string" ? [] : item.citationUrls))];
}

function markdownAnswerItem(
  item: string | { text: string; citationUrls: string[] },
  sourceNumbers: ReadonlyMap<string, number>,
): string {
  if (typeof item === "string") return item;
  const citations = item.citationUrls
    .map((url) => sourceNumbers.has(url) ? `[[${sourceNumbers.get(url)}]](${url})` : "")
    .filter(Boolean)
    .join(" ");
  return `${item.text}${citations ? ` ${citations}` : ""}`;
}

const TERM_STOPWORDS = new Set([
  "a", "about", "added", "after", "again", "against", "all", "also", "am", "an", "and", "answer", "any", "assumes",
  "are", "as", "at", "be", "because", "been", "before", "being", "between", "billion", "bcm", "both", "but", "by", "can",
  "changed", "close", "could", "cumulative", "current", "cuts", "delays", "did", "do", "does", "doing", "down", "driftglass", "during", "each", "early", "else", "elsewhere", "estimate", "estimates",
  "decline", "earlier", "enough", "even", "ever", "every", "existing", "facilities", "faster", "fell", "few", "first", "flat", "flexible", "for", "forecast", "fourth", "from", "fully", "further", "global", "had", "has", "have", "higher",
  "annual", "having", "here", "how", "if", "iea", "eia", "immediate", "in", "into", "is", "it", "its", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "joins", "just", "loss", "lower", "market", "markets", "more", "most", "much",
  "eight", "five", "four", "million", "mbtu", "new", "next", "nine", "no", "nor", "not", "now", "of", "off", "offset", "offsetting", "on", "once", "one", "only", "or", "other", "our", "out",
  "over", "own", "per", "public", "quarter", "quarters", "question", "recover", "recovered", "recovering", "return", "returns", "risk", "roughly", "same", "seven", "several", "should", "since", "six", "so", "some", "still", "such", "ten", "than", "that", "three", "two",
  "the", "their", "them", "then", "there", "these", "they", "this", "those", "through", "to", "too", "under",
  "until", "up", "update", "updated", "updates", "very", "was", "we", "were", "what", "when", "where", "which", "year", "years",
  "while", "who", "will", "with", "would", "you", "your",
]);

function withoutTerminalPunctuation(value: string): string {
  return value.trim().replace(/[.!?…。！？]+$/u, "").trimEnd();
}

function standingQuestion(payload: PublicSharePayload): string {
  const subtitle = payload.subtitle?.trim();
  if (subtitle) return subtitle.slice(0, 1_000);
  const title = payload.title.trim();
  if (/[?？]$/u.test(title)) return title.slice(0, 1_000);
  return `What is the current answer to “${withoutTerminalPunctuation(title)}”?`.slice(0, 1_000);
}

function asSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?…。！？]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function answerChangeQuestion(title: string): string {
  const prefix = "What would change the answer to “";
  const suffix = "”?";
  const subject = withoutTerminalPunctuation(title);
  const available = Math.max(0, 500 - prefix.length - suffix.length);
  return `${prefix}${subject.slice(0, available).trimEnd()}${suffix}`;
}

function packTerms(payload: PublicSharePayload): string[] {
  const counts = new Map<string, number>();
  const add = (text: string | undefined, weight: number): void => {
    for (const token of (text ?? "").toLowerCase().match(/[a-z0-9][a-z0-9+_-]{2,}/g) ?? []) {
      if (TERM_STOPWORDS.has(token) || /^\d+$/.test(token)) continue;
      const term = token === "cargoes" ? "cargo"
        : token === "damaged" ? "damage"
          : token === "reopened" || token === "reopening" || token === "reopens" ? "reopen"
            : token === "normalization" ? "normalize"
              : token === "producers" ? "production"
                : token;
      counts.set(term, (counts.get(term) ?? 0) + weight);
    }
  };
  const answerItemText = (item: string | { text: string } | undefined): string => typeof item === "string" ? item : item?.text ?? "";
  add(payload.title, 5);
  add(payload.subtitle, 4);
  for (const story of payload.stories) {
    add(story.title, 4);
    add(story.summary, 4);
    for (const evidence of story.evidence) {
      add(evidence.title, 2);
      add(evidence.excerpt, 1);
    }
  }
  const answer = payload.reviewedAnswer;
  if (answer) {
    add(answer.answer, 2);
    add(answer.whyItMatters, 2);
    add(answer.outlook, 2);
    add(answerItemText(answer.alternativeCase), 4);
    for (const item of answer.keyJudgments ?? []) add(answerItemText(item), 2);
    for (const item of answer.signposts ?? []) add(answerItemText(item), 4);
    for (const item of [...(answer.whatToWatch ?? []), ...(answer.whatWouldChange ?? []), ...(answer.uncertainty ?? [])]) add(item, 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 24)
    .map(([term]) => term);
}

function forkSourceId(packId: string, index: number, domain: string): string {
  const tail = `-source-${index + 1}-${slug(domain, "source").slice(0, 20)}`;
  const prefix = packId.slice(0, Math.max(1, 80 - tail.length)).replace(/-+$/, "");
  return `${prefix}${tail}`;
}

function publicEvidenceSources(payload: PublicSharePayload, packId: string): StarterPack["sources"] {
  const seen = new Set<string>();
  const output: StarterPack["sources"] = [];
  for (const story of payload.stories) {
    for (const item of story.evidence) {
      if (!item.url || seen.has(item.url) || output.length >= 12) continue;
      let parsed: URL;
      try { parsed = new URL(item.url); }
      catch { continue; }
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
      seen.add(parsed.toString());
      const domain = parsed.hostname.replace(/^www\./, "");
      output.push({
        id: forkSourceId(packId, output.length, domain),
        name: item.source || domain,
        kind: "web",
        config: {
          url: parsed.toString(),
          mode: "monitor",
          renderStrategy: "adaptive",
          evidenceRole: item.independent ? "independent" : "context",
          evidenceFamily: item.evidenceFamily,
          lineageRelation: item.lineageRelation,
          estimatedItemsPerRun: 1,
          sharedSnapshot: true,
        },
        scheduleMinutes: 720,
        weight: 1,
      });
    }
  }
  return output;
}

export function buildForkableIntelligencePack(payload: PublicSharePayload): IntelligencePackManifest {
  payload = requirePublicSharePayload(payload);
  const base = slug(payload.title);
  const packId = `fork-${base}`.slice(0, 80);
  const missionId = `mission-${base}`.slice(0, 80);
  const question = standingQuestion(payload);
  const sources = publicEvidenceSources(payload, packId);
  const terms = packTerms(payload);
  const sourceIds = sources.map((source) => source.id);
  const independentFamilies = new Set(payload.stories.flatMap((story) => story.evidence
    .filter((item) => item.independent)
    .map((item) => item.evidenceFamily ?? item.url ?? item.source)));
  const claimSummary = payload.stories[0]?.summary
    || payload.subtitle
    || "A current answer from the attached public sources.";

  return {
    driftglassPack: "3",
    id: packId,
    version: "1.0.0",
    name: `Follow · ${payload.title}`.slice(0, 180),
    description: "Follow this question using the same public sources and current answer.",
    author: "Driftglass Drop",
    category: "Forked intelligence",
    icon: "✦",
    featured: false,
    requiresCompanion: false,
    cloudSources: sources,
    companionSources: [],
    missions: [{
      id: missionId,
      name: `Follow · ${payload.title}`.slice(0, 180),
      question,
      terms,
      sourceScope: sourceIds,
      status: "active",
      priority: 1.4,
      cadenceMinutes: 720,
      mode: "watch",
      researchPolicy: "suggest",
      sprintPolicy: "scheduled",
      alertThreshold: 0.68,
    }],
    routines: sources.length ? [{
      id: `routine-${base}`.slice(0, 80),
      name: `Refresh · ${payload.title}`.slice(0, 180),
      description: "Refresh the public sources, update the standing Mission, and prepare the next answer.",
      missionId,
      enabled: true,
      scheduleMinutes: 720,
      budgetClass: "light",
      trigger: "scheduled",
      steps: [
        { id: "refresh", action: "refresh-sources", runtime: "auto", sourceIds },
        { id: "settle", action: "wait-for-ingest", runtime: "worker", waitSeconds: 35 },
        { id: "rebuild", action: "rebuild-mission", runtime: "worker" },
        {
          id: "prepare",
          action: "compile-context",
          runtime: "worker",
          reasoningTask: "investigate",
          target: "chatgpt",
          args: { objective: `Answer this standing question: ${asSentence(question)} Explain the causal drivers, the strongest competing case, and the signals that would reverse the current view.` },
        },
        { id: "checkpoint", action: "checkpoint-memory", runtime: "auto", optional: true, args: { reason: "Forked Intelligence Pack checkpoint" } },
      ],
    }] : [],
    memory: {
      claims: [{
        id: `snapshot-${base}`.slice(0, 80),
        title: payload.title.slice(0, 500),
        summary: claimSummary.slice(0, 4_000),
        confidence: payload.stories[0]?.confidence ?? 0.55,
        importance: 0.7,
        validFrom: payload.generatedAt,
      }],
      questions: [{
        id: `question-${base}`.slice(0, 80),
        title: answerChangeQuestion(payload.title),
        summary: "Track the few public developments that can change the current answer.",
        importance: 0.78,
      }],
    },
    reasoning: {
      briefingContract: [
        "Answer the standing question from the strongest current evidence.",
        "Explain the causal drivers, strongest competing explanation, and evidence that would change the answer.",
      ],
      researchPlaybooks: [{
        id: `playbook-${base}`.slice(0, 80),
        name: "Update the answer",
        task: "challenge",
        trigger: "A new source contradicts the provisional claim or the expected direction changes.",
        instructions: "Re-answer the standing question from the current evidence. State the answer, explain why, and identify the next observable signals.",
      }],
      outputContract: [
        "Lead with the answer to the standing question.",
        "Use concrete facts to explain the causal chain and strongest competing case.",
        "End with the few observable signals that would change the answer.",
      ],
    },
    evidencePolicy: {
      minPrimarySources: 1,
      minIndependentSources: Math.min(2, independentFamilies.size),
      maxDiscoveryShare: 0.35,
      maxEvidenceAgeHours: 2_160,
      preferredDomains: [...new Set(sources.flatMap((source) => {
        try { return [new URL(String(source.config.url)).hostname.replace(/^www\./, "")]; }
        catch { return []; }
      }))].slice(0, 20),
    },
    budget: {
      profile: "free",
      maxSources: Math.max(1, sources.length),
      browserMinutesPerDay: 2,
      workflowStepsPerDay: 80,
      projectedRunsPerDay: sources.length ? 2 : 0,
    },
    interestTerms: terms,
    lineage: { forkedFrom: `${payload.kind}:${payload.title}`, upstreamVersion: "snapshot-1" },
  };
}

function sourceNumberMap(payload: PublicSharePayload): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const story of payload.stories) {
    for (const item of story.evidence) {
      if (item.url && !numbers.has(item.url)) numbers.set(item.url, numbers.size + 1);
    }
  }
  for (const url of answerCitationUrls(payload.reviewedAnswer)) {
    if (!numbers.has(url)) numbers.set(url, numbers.size + 1);
  }
  return numbers;
}

function markdown(payload: PublicSharePayload, presentation?: PublicSharePresentationOptions): string {
  const sourceNumbers = sourceNumberMap(payload);
  const lines = [
    `# ${payload.title}`,
    "",
    payload.subtitle ?? "A sourced answer from Driftglass",
    "",
  ];
  if (presentation?.disclosure) lines.push(`<small class="illustrative-disclosure">${html(presentation.disclosure)}</small>`, "");
  lines.push(`As of: ${payload.generatedAt}${presentation?.disclosure ? "" : " · Public sources"}`, "");
  if (payload.reviewedAnswer) {
    const answer = payload.reviewedAnswer;
    const visibleAnswer = distinctAnswer(answer.answer, payload.title);
    lines.push(visibleAnswer ? "## Bottom line" : "## Analysis", "");
    if (visibleAnswer) lines.push(visibleAnswer, "");
    if (answer.whyItMatters) lines.push("### What this means", "", answer.whyItMatters, "");
    if (answer.keyJudgments?.length) lines.push("### Why this is happening", "", ...answer.keyJudgments.map((item) => `- ${markdownAnswerItem(item, sourceNumbers)}`), "");
    if (answer.outlook) lines.push("### Outlook", "", answer.outlook, "");
    if (answer.options?.length) lines.push("### Other choices", "", ...answer.options.map((option) => `- **${option.name}:** ${option.tradeoff ?? ""}`.trimEnd()), "");
    if (answer.alternativeCase) lines.push("### Alternative case", "", markdownAnswerItem(answer.alternativeCase, sourceNumbers), "");
    if (answer.whatWouldChange?.length) lines.push("### What could change", "", ...answer.whatWouldChange.map((item) => `- ${item}`), "");
    const signposts = [...(answer.signposts ?? []), ...(answer.whatToWatch ?? [])];
    if (signposts.length) lines.push(`### ${presentation?.watchLabel ?? "What to watch next"}`, "", ...signposts.map((item) => `- ${markdownAnswerItem(item, sourceNumbers)}`), "");
    if (answer.nextSteps?.length) lines.push("### Next steps", "", ...answer.nextSteps.map((item) => `- ${item}`), "");
    if (answer.uncertainty?.length) lines.push("### Open questions", "", ...answer.uncertainty.map((item) => `- ${item}`), "");
  }
  lines.push(payload.reviewedAnswer ? "## Sources" : "## What changed", "");
  for (const story of payload.stories) {
    if (payload.stories.length > 1) {
      lines.push(`### ${story.title}`, "", ...(story.summary ? [story.summary, ""] : []), "#### Sources", "");
    }
    for (const item of story.evidence) {
      const relationship = item.lineageRelation === "origin" ? "Original source"
        : item.lineageRelation === "independent" ? "Independent source"
          : item.lineageRelation === "same-family" ? "Related report"
            : item.lineageRelation === "echo" ? "Repeated report" : "Relationship unknown";
      const number = item.url ? sourceNumbers.get(item.url) : undefined;
      lines.push(`- ${number ? `[${number}] ` : ""}**${item.source}:** ${item.title} _(${relationship})_${item.url ? ` — ${item.url}` : ""}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function answerList(
  title: string,
  items: ReviewedShareAnswer["keyJudgments"] | string[] | undefined,
  sourceNumbers: ReadonlyMap<string, number>,
): string {
  if (!items?.length) return "";
  const list = items.map((item) => {
    if (typeof item === "string") return `<li>${html(item)}</li>`;
    const citations = item.citationUrls.map((url) => {
      const number = sourceNumbers.get(url);
      return `<a href="${html(url)}" target="_blank" rel="noopener noreferrer">${number ? `[${number}]` : "Source"}</a>`;
    }).join(" ");
    return `<li>${html(item.text)}${citations ? ` <span class="claim-citations">${citations}</span>` : ""}</li>`;
  }).join("");
  return `<div><h3>${html(title)}</h3><ul>${list}</ul></div>`;
}

function answerSection(
  title: string,
  item: ReviewedShareAnswer["alternativeCase"],
  sourceNumbers: ReadonlyMap<string, number>,
): string {
  if (!item) return "";
  if (typeof item === "string") return `<div><h3>${html(title)}</h3><p>${html(item)}</p></div>`;
  const citations = item.citationUrls.map((url) => {
    const number = sourceNumbers.get(url);
    return `<a href="${html(url)}" target="_blank" rel="noopener noreferrer">${number ? `[${number}]` : "Source"}</a>`;
  }).join(" ");
  return `<div><h3>${html(title)}</h3><p>${html(item.text)}${citations ? ` <span class="claim-citations">${citations}</span>` : ""}</p></div>`;
}

function reviewedAnswerMarkup(
  answer: ReviewedShareAnswer,
  title: string,
  watchLabel: PublicSharePresentationOptions["watchLabel"],
  sourceNumbers: ReadonlyMap<string, number>,
): string {
  const visibleAnswer = distinctAnswer(answer.answer, title);
  const options = answer.options?.length
    ? `<div><h3>Other choices</h3><ul>${answer.options.map((option) => `<li><strong>${html(option.name)}</strong>${option.tradeoff ? `: ${html(option.tradeoff)}` : ""}</li>`).join("")}</ul></div>`
    : "";
  const watch = answerList(
    watchLabel ?? "What to watch next",
    [...(answer.signposts ?? []), ...(answer.whatToWatch ?? [])],
    sourceNumbers,
  );
  const uncertainty = answer.uncertainty?.length
    ? `<div><h3>Open questions</h3><ul>${answer.uncertainty.map((item) => `<li>${html(item)}</li>`).join("")}</ul></div>`
    : "";
  return `<section class="reviewed"><span class="eyebrow">${visibleAnswer ? "Bottom line" : "Analysis"}</span>${visibleAnswer ? `<p class="answer">${html(visibleAnswer)}</p>` : ""}${answer.whyItMatters ? `<div><h3>What this means</h3><p>${html(answer.whyItMatters)}</p></div>` : ""}${answerList("Why this is happening", answer.keyJudgments, sourceNumbers)}${answer.outlook ? `<div><h3>Outlook</h3><p>${html(answer.outlook)}</p></div>` : ""}${options}${answerSection("Alternative case", answer.alternativeCase, sourceNumbers)}${answerList("What could change", answer.whatWouldChange, sourceNumbers)}${watch}${answerList("Next steps", answer.nextSteps, sourceNumbers)}${uncertainty}</section>`;
}

function storyMarkup(story: SharedStory, sourceNumbers: ReadonlyMap<string, number>, stories?: SharedStory[]): string {
  const showTitle = (stories?.length ?? 2) > 1;
  const evidence = story.evidence.map((item) => {
    const relationship = item.lineageRelation === "origin" ? "Original source"
      : item.lineageRelation === "independent" ? "Independent source"
        : item.lineageRelation === "same-family" ? "Related report"
          : item.lineageRelation === "echo" ? "Repeated report" : "Relationship unknown";
    const published = item.publishedAt ? new Date(item.publishedAt).toLocaleDateString("en-US", { dateStyle: "medium" }) : "";
    const number = item.url ? sourceNumbers.get(item.url) : undefined;
    return `<li><div><strong>${html(item.source)}</strong><span>${html(relationship)}${published ? ` · ${html(published)}` : ""}</span></div><p>${html(item.title)}</p>${item.excerpt ? `<small>${html(item.excerpt)}</small>` : ""}${item.url ? `<a href="${html(item.url)}" target="_blank" rel="noopener noreferrer">Open source${number ? ` [${number}]` : ""}</a>` : ""}</li>`;
  }).join("");
  return `<article class="story">${showTitle ? `<h2>${html(story.title)}</h2>${story.summary ? `<p>${html(story.summary)}</p>` : ""}` : ""}<details><summary>Open links</summary><ul>${evidence}</ul></details></article>`;
}

function page(payload: PublicSharePayload, publicIndexing: boolean, presentation?: PublicSharePresentationOptions): string {
  const robots = publicShareRobotsContent(publicIndexing).replace(/, /g, ",");
  const type = payload.kind === "story" ? "Shared Story" : payload.kind === "mission" ? "Shared Mission" : "Shared Briefing";
  const disclosure = presentation?.disclosure
    ? `<small class="illustrative-disclosure">${html(presentation.disclosure)}</small>`
    : "";
  const sourceNumbers = sourceNumberMap(payload);
  const sourceLabel = presentation?.disclosure ? "" : " · Public sources";
  const footerCopy = html(payload.footer || "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${html(robots)}"><meta name="description" content="${html(payload.subtitle ?? payload.title)}"><link rel="manifest" href="manifest.webmanifest"><meta name="theme-color" content="#17191f"><title>${html(payload.title)} · ${html(type)}</title><style>:root{--ink:#17191f;--muted:#5f6672;--line:#dedfdf;--paper:#f3f1eb;--card:#fff;--accent:#4d43ad}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(840px,calc(100% - 30px));margin:auto;padding:52px 0 64px}.hero{padding:36px 0 32px;border-bottom:1px solid var(--line)}.eyebrow,.assessment{text-transform:uppercase;letter-spacing:.1em;color:var(--accent);font-size:11px;font-weight:760}h1{font-size:clamp(36px,7vw,64px);line-height:1.02;letter-spacing:-.05em;margin:8px 0 16px;max-width:16ch}.hero>p{color:var(--muted);font-size:19px;max-width:66ch}.illustrative-disclosure{display:block;margin-top:8px;color:var(--muted);font-size:12px}.privacy{font-size:13px!important}.section-heading{margin:32px 0 14px;font-size:14px;letter-spacing:.06em;text-transform:uppercase}.reviewed{margin:26px 0;padding:28px;border:1px solid var(--line);border-radius:18px;background:#ebe9e2}.reviewed .answer{font-size:21px;line-height:1.45}.reviewed h3{font-size:13px;margin:20px 0 4px}.reviewed p{margin:6px 0}.reviewed ul{display:block;list-style:disc;padding-left:20px}.reviewed li{padding:2px 0;border:0;background:transparent}.reviewed .snapshot{margin-top:10px;color:var(--muted);font-size:12px}.reviewed .review-details{margin-top:20px}.stories{display:grid;gap:16px}.story{padding:28px;background:var(--card);border:1px solid var(--line);border-radius:18px}.assessment{margin:0 0 10px}h2{font-size:clamp(23px,4vw,34px);line-height:1.12;letter-spacing:-.03em;margin:0}.story>p:not(.assessment){color:#474e58}.evidence-note{font-size:14px}details{border-top:1px solid var(--line);padding-top:14px;margin-top:18px}summary{font-weight:700;cursor:pointer}ul{list-style:none;padding:0;display:grid;gap:10px}li{background:#f8f8f6;border:1px solid #e8e8e5;border-radius:12px;padding:14px}li div{display:flex;justify-content:space-between;color:var(--muted);font-size:12px}li p{font-weight:650;margin:7px 0}li small{display:block;color:var(--muted)}a{color:var(--accent);font-weight:700;text-decoration:none}.claim-citations{white-space:nowrap}.continue{margin-top:22px;padding:26px;border:1px solid var(--line);border-radius:18px;background:#ebe9e2}.continue h2{margin-top:4px}.continue>p{color:var(--muted)}.install{display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:18px}.install input{min-width:0;border:1px solid var(--line);border-radius:10px;padding:12px;font:inherit;background:#fff}.install button,.download{border:0;border-radius:10px;padding:12px 15px;background:var(--ink);color:#fff;font:700 14px inherit;cursor:pointer}.download{display:inline-block;margin-top:10px}.status{font-size:13px;color:var(--muted);min-height:22px}footer{display:flex;justify-content:space-between;gap:20px;color:var(--muted);font-size:13px;padding:22px 0;border-top:1px solid var(--line);margin-top:26px}.brand{font-weight:800;color:var(--ink)}.repo-link{color:var(--muted);font-size:12px;font-weight:650}@media(max-width:640px){main{padding-top:20px}.hero{padding-top:24px}.story,.reviewed,.continue{padding:21px}.install{grid-template-columns:1fr}li div{align-items:flex-start;flex-direction:column;gap:2px}}</style></head><body><main><header class="hero"><span class="eyebrow">${html(type)}</span><h1>${html(payload.title)}</h1><p>${html(payload.subtitle ?? "A sourced answer from Driftglass.")}</p>${disclosure}<small>As of ${html(new Date(payload.generatedAt).toLocaleString())}${sourceLabel}</small></header>${payload.reviewedAnswer ? reviewedAnswerMarkup(payload.reviewedAnswer, payload.title, presentation?.watchLabel, sourceNumbers) : ""}<h2 class="section-heading">${payload.reviewedAnswer ? "Sources" : "What changed"}</h2><section class="stories">${payload.stories.map((story) => storyMarkup(story, sourceNumbers, payload.stories)).join("")}</section><section class="continue"><span class="eyebrow">Follow this question</span><h2>Continue in Driftglass</h2><p>Install the Pack to track updates from the same public sources.</p><form class="install" id="install"><input id="driftglass" type="url" inputmode="url" placeholder="http://localhost:8787" aria-label="Your Driftglass URL"><button type="submit">Open in Driftglass</button></form><p class="status" id="status"></p><a class="download" href="driftglass-pack.json" download>Download Pack</a></section><footer>${footerCopy ? `<span>${footerCopy}</span>` : ""}<span><span class="brand">Driftglass</span> · <a class="repo-link" href="${DRIFTGLASS_QUICK_START_URL}" target="_blank" rel="noopener noreferrer">Quick start</a></span></footer></main><script>(()=>{const form=document.getElementById('install'),input=document.getElementById('driftglass'),status=document.getElementById('status');const remembered=localStorage.getItem('driftglass-home');if(remembered)input.value=remembered;form.addEventListener('submit',event=>{event.preventDefault();try{const home=new URL(input.value);if(!['http:','https:'].includes(home.protocol))throw new Error();localStorage.setItem('driftglass-home',home.origin);const pack=new URL('driftglass-pack.json',location.href).toString();const destination=new URL(home.origin);destination.searchParams.set('pack',pack);destination.hash='sources';location.href=destination.toString()}catch{status.textContent='Enter the URL of your Driftglass.'}})})()</script></body></html>`;
}

export interface DropCapsuleOptions {
  publicIndexing?: boolean;
  presentation?: PublicSharePresentationOptions;
}

export function buildDropCapsule(
  payload: PublicSharePayload,
  options: DropCapsuleOptions = {},
): Uint8Array {
  payload = requirePublicSharePayload(payload);
  const publicIndexing = options.publicIndexing === true;
  const evidenceMarkdown = markdown(payload, options.presentation);
  const pack = buildForkableIntelligencePack(payload);
  const readme = `# Driftglass shared briefing\n\nOpen \`index.html\` to read this briefing locally, or publish the folder with any static host.\n\n## Contents\n\n- \`index.html\`: recipient-facing briefing\n- \`evidence.md\`: readable source record\n- \`data.json\`: structured recipient copy\n- \`driftglass-pack.json\`: optional Driftglass follow-up setup\n\n## Optional Cloudflare hosting\n\nOpen https://www.cloudflare.com/drop/ and upload this ZIP. Share the generated URL, or claim the deployment if you want to keep it. Cloudflare Drop is one hosting option; it is not required to read the briefing.\n`;
  const llms = `# ${payload.title}\n\n${payload.subtitle ?? "A sourced answer from Driftglass"}\n\nRead the briefing: /evidence.md\nStructured recipient copy: /data.json\nOptional Driftglass follow-up setup: /driftglass-pack.json\n`;
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="116" fill="#11141a"/><path d="M256 76 286 214 436 256 286 298 256 436 226 298 76 256 226 214Z" fill="#f3f1eb"/><circle cx="256" cy="256" r="32" fill="#5145cd"/></svg>`;
  const manifest = {
    name: payload.title,
    short_name: "Shared briefing",
    description: payload.subtitle ?? "A sourced briefing from Driftglass",
    start_url: "/",
    display: "standalone",
    background_color: "#f3f1eb",
    theme_color: "#11141a",
    icons: [{ src: "driftglass.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
  };
  return createStoredZip([
    { name: "index.html", data: page(payload, publicIndexing, options.presentation) },
    { name: "data.json", data: `${JSON.stringify(recipientShareDocument(payload), null, 2)}\n` },
    { name: "evidence.md", data: evidenceMarkdown },
    { name: "driftglass-pack.json", data: `${JSON.stringify(pack, null, 2)}\n` },
    { name: "manifest.webmanifest", data: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: "driftglass.svg", data: icon },
    // Browsers request this conventionally even when no icon link is present. Supplying the same
    // self-contained vector avoids a noisy 404 when a capsule is opened from a static host.
    { name: "favicon.ico", data: icon },
    { name: "llms.txt", data: llms },
    { name: "robots.txt", data: publicIndexing ? "User-agent: *\nAllow: /\n" : "User-agent: *\nDisallow: /\n" },
    { name: "README.md", data: readme },
  ], new Date(payload.generatedAt));
}
