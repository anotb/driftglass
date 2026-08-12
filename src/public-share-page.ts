import { publicShareRobotsContent } from "./share-privacy";
import type { PublicSharePayload, ReviewedShareAnswer, SharedStory } from "./share-privacy";

const DRIFTGLASS_QUICK_START_URL = "https://github.com/anotb/driftglass#quick-start";

export interface PublicSharePageOptions {
  payload: PublicSharePayload;
  publicIndexing: boolean;
  dropUrl: string;
  ogImageUrl?: string;
  presentation?: PublicSharePresentationOptions;
}

export interface PublicSharePresentationOptions {
  watchLabel?: "What to watch next" | "Before committing" | "Signals to watch";
  downloadLabel?: "Download a copy" | "Download decision pack" | "Download the brief";
  disclosure?: "Illustrative decision · public sources" | "Illustrative analysis · public sources" | "Illustrative example · public sources";
}

function html(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function publicDate(value: string, withTime = false): string {
  return withTime
    ? new Date(value).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })
    : new Date(value).toLocaleDateString("en-US", { dateStyle: "medium" });
}

function storyMarkup(story: SharedStory, showContext: boolean, sourceNumbers: ReadonlyMap<string, number>): string {
  const evidence = story.evidence.map((item) => {
    const number = item.url ? sourceNumbers.get(item.url) : undefined;
    const link = item.url ? `<a href="${html(item.url)}" target="_blank" rel="noopener noreferrer">Open source${number ? ` [${number}]` : ""}</a>` : "";
    const relationship = item.lineageRelation === "origin" ? "Original source"
      : item.lineageRelation === "independent" ? "Independent source"
        : item.lineageRelation === "same-family" ? "Related report"
          : item.lineageRelation === "echo" ? "Repeated report" : "Relationship unknown";
    return `<li><div><strong>${html(item.source)}</strong><span>${html(relationship)}${item.publishedAt ? ` · ${html(publicDate(item.publishedAt))}` : ""}</span></div><p>${html(item.title)}</p>${item.excerpt ? `<small>${html(item.excerpt)}</small>` : ""}${link}</li>`;
  }).join("");
  return `<article class="story">${showContext ? `<h2>${html(story.title)}</h2>${story.summary ? `<p class="summary">${html(story.summary)}</p>` : ""}` : ""}<details><summary>Open links</summary><ul>${evidence}</ul></details></article>`;
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

function answerList(
  title: string,
  items: ReviewedShareAnswer["keyJudgments"] | string[] | undefined,
  sourceNumbers: ReadonlyMap<string, number>,
): string {
  if (!items?.length) return "";
  const itemMarkup = (item: string | { text: string; citationUrls: string[] }): string => {
    if (typeof item === "string") return html(item);
    const citations = item.citationUrls.map((url) => {
      const number = sourceNumbers.get(url);
      return number ? `<a href="${html(url)}" target="_blank" rel="noopener noreferrer">[${number}]</a>` : "";
    }).filter(Boolean).join(" ");
    return `${html(item.text)}${citations ? ` <span class="claim-citations">${citations}</span>` : ""}`;
  };
  const list = items.map((item) => `<li>${itemMarkup(item)}</li>`).join("");
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
    return number ? `<a href="${html(url)}" target="_blank" rel="noopener noreferrer">[${number}]</a>` : "";
  }).filter(Boolean).join(" ");
  return `<div><h3>${html(title)}</h3><p>${html(item.text)}${citations ? ` <span class="claim-citations">${citations}</span>` : ""}</p></div>`;
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

function reviewedAnswerMarkup(
  answer: ReviewedShareAnswer,
  title: string,
  watchLabel: PublicSharePresentationOptions["watchLabel"],
  sourceNumbers: ReadonlyMap<string, number>,
  trailingMarkup = "",
): string {
  const visibleAnswer = distinctAnswer(answer.answer, title);
  const options = answer.options?.length
    ? `<div><h3>Other choices</h3><ul>${answer.options.map((option) => `<li><strong>${html(option.name)}</strong>${option.tradeoff ? `: ${html(option.tradeoff)}` : ""}</li>`).join("")}</ul></div>`
    : "";
  const signposts = [...new Set([...(answer.signposts ?? []), ...(answer.whatToWatch ?? [])])];
  const watch = answerList(watchLabel ?? "What to watch next", signposts, sourceNumbers);
  const uncertainty = answer.uncertainty?.length
    ? `<div><h3>Open questions</h3><ul>${answer.uncertainty.map((item) => `<li>${html(item)}</li>`).join("")}</ul></div>`
    : "";
  return `<section class="reviewed-answer"><p class="assessment">${visibleAnswer ? "Bottom line" : "Analysis"}</p>${visibleAnswer ? `<p class="answer">${html(visibleAnswer)}</p>` : ""}${answer.whyItMatters ? `<div><h3>What this means</h3><p>${html(answer.whyItMatters)}</p></div>` : ""}${answerList("Why this is happening", answer.keyJudgments, sourceNumbers)}${answer.outlook ? `<div><h3>Outlook</h3><p>${html(answer.outlook)}</p></div>` : ""}${options}${answerSection("Alternative case", answer.alternativeCase, sourceNumbers)}${answerList("What could change", answer.whatWouldChange, sourceNumbers)}${watch}${answerList("Next steps", answer.nextSteps, sourceNumbers)}${uncertainty}${trailingMarkup}</section>`;
}

export function renderPublicSharePage(options: PublicSharePageOptions): string {
  const payload = options.payload;
  const description = payload.subtitle || payload.stories[0]?.summary || "A sourced answer from Driftglass";
  const type = payload.kind === "story" ? "Shared Story" : payload.kind === "mission" ? "Shared Mission" : "Shared Briefing";
  const robots = publicShareRobotsContent(options.publicIndexing).replace(/, /g, ",");
  const openGraphImage = options.ogImageUrl
    ? `<meta property="og:image" content="${html(options.ogImageUrl)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${html(options.ogImageUrl)}">`
    : "";
  const watchLabel = options.presentation?.watchLabel ?? "What to watch next";
  const downloadLabel = options.presentation?.downloadLabel ?? "Download a copy";
  const footerCopy = payload.footer || "";
  const disclosure = options.presentation?.disclosure
    ? `<small class="illustrative-disclosure">${html(options.presentation.disclosure)}</small>`
    : "";
  const sourceLabel = options.presentation?.disclosure ? "" : " · Public sources";
  const presentationClass = options.presentation?.disclosure ? ' class="portfolio-presentation"' : "";
  const quickStartLink = `<a class="repo-link" href="${DRIFTGLASS_QUICK_START_URL}" target="_blank" rel="noopener noreferrer">Quick start</a>`;
  const portfolioDownload = options.presentation?.disclosure
    ? `<div class="portfolio-download">${footerCopy ? `<span>${html(footerCopy)}</span>` : ""}<span><a class="cta" href="${html(options.dropUrl)}">${html(downloadLabel)}</a> <span class="brand">Driftglass</span> ${quickStartLink}</span></div>`
    : "";
  const footer = options.presentation?.disclosure
    ? ""
    : `<footer>${footerCopy ? `<span>${html(footerCopy)}</span>` : ""}<span><a class="cta" href="${html(options.dropUrl)}">${html(downloadLabel)}</a> <span class="brand">Driftglass</span> ${quickStartLink}</span></footer>`;
  const presentationStyles = options.presentation?.disclosure
    ? ".portfolio-presentation{width:min(1040px,calc(100% - 32px));padding-top:18px}.portfolio-presentation .hero{padding:14px 0}.portfolio-presentation h1{max-width:none;font-size:50px}.portfolio-presentation .subtitle{margin-top:8px}.portfolio-presentation .date{margin-top:10px}.portfolio-presentation .privacy-note{margin-top:8px}.portfolio-presentation .reviewed-answer{margin:14px 0;padding:18px 22px}.portfolio-presentation .reviewed-answer .answer{font-size:20px;line-height:1.38}.portfolio-presentation .reviewed-answer h3{margin-top:10px}.portfolio-presentation .reviewed-answer p{margin:4px 0}.portfolio-presentation .reviewed-answer .review-details{margin-top:10px;padding-top:10px}.portfolio-download{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}.portfolio-download>span:last-child{display:flex;align-items:center;gap:10px}"
    : "";
  const sourceNumbers = new Map<string, number>();
  for (const story of payload.stories) {
    for (const item of story.evidence) {
      if (item.url && !sourceNumbers.has(item.url)) sourceNumbers.set(item.url, sourceNumbers.size + 1);
    }
  }
  for (const url of answerCitationUrls(payload.reviewedAnswer)) {
    if (!sourceNumbers.has(url)) sourceNumbers.set(url, sourceNumbers.size + 1);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${html(robots)}"><link rel="icon" href="/icons/driftglass.svg" type="image/svg+xml"><title>${html(payload.title)} · Driftglass</title><meta name="description" content="${html(description.slice(0, 240))}"><meta property="og:title" content="${html(payload.title)}"><meta property="og:description" content="${html(description.slice(0, 240))}"><meta property="og:type" content="article">${openGraphImage}<style>${presentationStyles}
  :root{color-scheme:light;--ink:#17191f;--muted:#5f6672;--line:#dedfdf;--paper:#f3f1eb;--card:#fff;--accent:#4d43ad}*{box-sizing:border-box}body{margin:0;background:var(--paper);font:16px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}main{width:min(840px,calc(100% - 32px));margin:0 auto;padding:56px 0 72px}.hero{padding:38px 0 34px;border-bottom:1px solid var(--line)}.eyebrow,.assessment{margin:0 0 12px;text-transform:uppercase;letter-spacing:.1em;font-size:11px;font-weight:760;color:var(--accent)}h1{font-size:clamp(36px,7vw,64px);line-height:1.02;letter-spacing:-.05em;margin:0;max-width:16ch}.subtitle{font-size:19px;color:var(--muted);max-width:66ch;margin:18px 0 0}.illustrative-disclosure{display:block;margin-top:9px;color:var(--muted);font-size:12px}.date{display:inline-block;margin-top:22px;color:var(--muted);font-size:13px}.section-heading{margin:34px 0 14px;font-size:14px;letter-spacing:.06em;text-transform:uppercase}.reviewed-answer{margin:28px 0;padding:28px;border-radius:18px;background:#ebe9e2;border:1px solid var(--line)}.reviewed-answer .answer{font-size:21px;line-height:1.45;letter-spacing:-.01em}.reviewed-answer h3{font-size:13px;margin:20px 0 4px}.reviewed-answer p{margin:6px 0}.reviewed-answer ul{display:block;margin:5px 0;padding-left:20px;list-style:disc}.reviewed-answer li{padding:2px 0;border:0;background:transparent}.stories{display:grid;gap:16px}.story{padding:28px;background:var(--card);border:1px solid var(--line);border-radius:18px}h2{margin:0;font-size:clamp(23px,4vw,34px);line-height:1.12;letter-spacing:-.03em}.summary{color:#3f4550;font-size:17px;margin:14px 0 0}details{margin-top:20px;border-top:1px solid var(--line);padding-top:15px}summary{cursor:pointer;font-weight:700}ul{list-style:none;padding:0;margin:14px 0 0;display:grid;gap:10px}li{padding:15px;border-radius:12px;background:#f8f8f6;border:1px solid #e8e8e5}li>div{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:12px}li p{margin:6px 0 5px;font-weight:650}li small{display:block;color:#626873}a{color:var(--accent);font-weight:700;text-decoration:none}.claim-citations{white-space:nowrap}footer{display:flex;justify-content:space-between;gap:24px;align-items:center;margin-top:28px;padding:22px 0;border-top:1px solid var(--line);color:var(--muted);font-size:13px}footer>span:last-child{display:flex;gap:12px;align-items:center}.brand{color:var(--ink);font-weight:800}.repo-link{color:var(--muted);font-size:12px;font-weight:650}.cta{display:inline-flex;padding:9px 12px;border-radius:10px;background:var(--ink);color:#fff!important;font-size:12px}@media(max-width:640px){main{padding-top:20px}.hero{padding-top:24px}.story,.reviewed-answer{padding:21px}li>div{align-items:flex-start;flex-direction:column;gap:2px}footer{align-items:flex-start;flex-direction:column}}</style></head><body><main${presentationClass}><header class="hero"><p class="eyebrow">${html(type)}</p><h1>${html(payload.title)}</h1>${payload.subtitle ? `<p class="subtitle">${html(payload.subtitle)}</p>` : ""}${disclosure}<span class="date">As of ${html(publicDate(payload.generatedAt, true))}${sourceLabel}</span></header>${payload.reviewedAnswer ? reviewedAnswerMarkup(payload.reviewedAnswer, payload.title, watchLabel, sourceNumbers, portfolioDownload) : ""}<h2 class="section-heading">${payload.reviewedAnswer ? "Sources" : payload.kind === "story" ? "Finding" : "What changed"}</h2><section class="stories">${payload.stories.map((story) => storyMarkup(story, payload.stories.length > 1, sourceNumbers)).join("")}</section>${footer}</main></body></html>`;
}
