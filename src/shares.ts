import {
  getMission,
  getPublicShareByHash,
  getReasoningReceipt,
  getReasoningRun,
  getStory,
  incrementPublicShareView,
  insertPublicShare,
  latestBriefing,
  listMissionMatches,
} from "./db";
import { generateBriefing } from "./briefing";
import { captureKitesurfScreenshot } from "./rendering";
import { getEvidenceObject, putEvidenceObject } from "./r2-budget";
import { readReasoningReceiptBundle } from "./reasoning-ledger";
import { buildDropCapsule } from "./drop-capsule";
import { renderPublicSharePage } from "./public-share-page";
import { publicKnowledgeUrl } from "./mcp-knowledge";
import { baseUrlFor, randomToken, sha256 } from "./security";
import {
  isPublicShareEvidence,
  normalizePublicSharePayload,
  normalizeReviewedShareAnswer,
  projectPublicStory,
  publicShareResponseHeaders,
  recipientShareDocument,
  PUBLIC_SHARE_SCHEMA_VERSION,
} from "./share-privacy";
import type {
  PublicSharePayload,
  ReviewedShareAnswer,
  ReviewedShareJudgment,
  SharedEvidence,
  SharedStory,
} from "./share-privacy";
import type { AccessClass, Env, PublicShareRecord, ReasoningBundle, ReasoningReceiptRecord, ReasoningRunRecord } from "./types";
import { HttpError, isoNow, parseJson, stableStringify } from "./utils";

export type ShareKind = PublicShareRecord["kind"];
export type { PublicSharePayload, SharedEvidence, SharedStory } from "./share-privacy";

type SharedStoryResult =
  | { status: "ready"; story: SharedStory }
  | { status: "missing" }
  | { status: "private-only" };

async function sharedStory(env: Env, storyId: string, evidenceLimit = 8): Promise<SharedStoryResult> {
  const detail = await getStory(env.DB, storyId);
  if (!detail) return { status: "missing" };
  const story = projectPublicStory(detail, evidenceLimit);
  return story ? { status: "ready", story } : { status: "private-only" };
}

async function buildSharePayload(env: Env, kind: ShareKind, targetId?: string): Promise<PublicSharePayload> {
  if (kind === "story") {
    if (!targetId) throw new HttpError(400, "Story share requires id");
    const result = await sharedStory(env, targetId, 12);
    if (result.status === "missing") throw new HttpError(404, "Story not found");
    if (result.status === "private-only") {
      throw new HttpError(422, "This Story has no public evidence. Email, Companion, subscriber, and private evidence cannot be shared.");
    }
    const story = result.story;
    return {
      schemaVersion: PUBLIC_SHARE_SCHEMA_VERSION,
      publicEvidenceOnly: true,
      kind,
      title: story.title,
      generatedAt: isoNow(),
      stories: [story],
    };
  }

  if (kind === "mission") {
    if (!targetId) throw new HttpError(400, "Mission share requires id");
    const mission = await getMission(env.DB, targetId);
    if (!mission) throw new HttpError(404, "Mission not found");
    // Read beyond the display limit so private-only matches cannot crowd public Stories out of the share.
    const matches = await listMissionMatches(env.DB, targetId, 24);
    const results = await Promise.all(matches.map((match) => sharedStory(env, String(match.story_id ?? ""), 5)));
    const stories = results.flatMap((result) => result.status === "ready" ? [result.story] : []).slice(0, 12);
    if (!stories.length) {
      throw new HttpError(422, "This Mission has no public evidence to share. Email, Companion, subscriber, and private evidence were excluded.");
    }
    return {
      schemaVersion: PUBLIC_SHARE_SCHEMA_VERSION,
      publicEvidenceOnly: true,
      kind,
      title: mission.name,
      subtitle: mission.question || "Research Mission update",
      generatedAt: isoNow(),
      stories,
    };
  }

  const briefing = await latestBriefing(env.DB) ?? await generateBriefing(env, 24);
  const packet = briefing.packet;
  const results = await Promise.all(packet.stories.map((story) => sharedStory(env, story.id, 4)));
  const stories = results.flatMap((result) => result.status === "ready" ? [result.story] : []).slice(0, 8);
  if (!stories.length) {
    throw new HttpError(422, "This briefing has no public evidence to share. Email, Companion, subscriber, and private evidence were excluded.");
  }
  return {
    schemaVersion: PUBLIC_SHARE_SCHEMA_VERSION,
    publicEvidenceOnly: true,
    kind: "briefing",
    title: "Intelligence briefing",
    subtitle: `Public findings from ${packet.periodStart} to ${packet.periodEnd}`,
    generatedAt: packet.generatedAt,
    stories,
  };
}

function structuredString(input: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function structuredList(input: Record<string, unknown>, names: string[]): string[] | undefined {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value.trim()) return [value];
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
      if (items.length) return items;
    }
  }
  return undefined;
}

function structuredTextList(
  input: Record<string, unknown>,
  names: string[],
  objectKeys = ["claim", "judgment", "driver", "text", "summary", "action", "step", "description"],
): string[] | undefined {
  for (const name of names) {
    const value = input[name];
    const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    const items = values.flatMap<string>((item) => {
      if (typeof item === "string" && item.trim()) return [item];
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const title = structuredString(record, ["title", "name"]);
      let text = structuredString(record, objectKeys);
      if (!text) {
        for (const key of objectKeys) {
          const nested = record[key];
          if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
          text = structuredString(nested as Record<string, unknown>, ["text", "summary", "claim", "judgment", "driver", "description"]);
          if (text) break;
        }
      }
      const output = title && text && title !== text ? `${title}: ${text}` : text ?? title;
      return output ? [output] : [];
    });
    if (items.length) return items;
  }
  return undefined;
}

function structuredJudgmentList(
  input: Record<string, unknown>,
  names: string[],
  allowedCitationUrls: ReadonlySet<string>,
  objectKeys = ["claim", "judgment", "driver", "text", "summary"],
): ReviewedShareAnswer["keyJudgments"] {
  for (const name of names) {
    const value = input[name];
    const values = typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value
        : value && typeof value === "object"
          ? [value]
          : [];
    const items = values.flatMap<string | ReviewedShareJudgment>((item) => {
      if (typeof item === "string" && item.trim()) return [item];
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const title = structuredString(record, ["title", "name"]);
      let itemText = structuredString(record, objectKeys);
      if (!itemText) {
        for (const key of objectKeys) {
          const nested = record[key];
          if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
          itemText = structuredString(nested as Record<string, unknown>, ["text", "summary", "claim", "judgment", "driver", "description"]);
          if (itemText) break;
        }
      }
      const text = title && itemText && title !== itemText ? `${title}: ${itemText}` : itemText ?? title;
      if (!text) return [];
      const citationValues = [
        ...(typeof record.citationUrl === "string" ? [record.citationUrl] : []),
        ...(Array.isArray(record.citationUrls) ? record.citationUrls : []),
      ];
      const citationUrls = [...new Set(citationValues.filter(
        (url): url is string => typeof url === "string" && allowedCitationUrls.has(url),
      ))].slice(0, 3);
      return citationUrls.length ? [{ text, citationUrls }] : [text];
    });
    if (items.length) return items;
  }
  return undefined;
}

function structuredNarrative(input: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const narrative = structuredString(record, ["summary", "outlook", "case", "description", "text"])
        ?? (record.text && typeof record.text === "object" && !Array.isArray(record.text)
          ? structuredString(record.text as Record<string, unknown>, ["text", "summary", "description"])
          : undefined);
      if (narrative) return narrative;
    }
  }
  return undefined;
}

function structuredOptions(input: Record<string, unknown>): ReviewedShareAnswer["options"] {
  if (!Array.isArray(input.options)) return undefined;
  const options = input.options.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [{ name: item }];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const option = item as Record<string, unknown>;
    const name = structuredString(option, ["name", "option", "title"]);
    if (!name) return [];
    const tradeoff = structuredString(option, ["tradeoff", "reason", "consequence", "description"]);
    return [{ name, tradeoff }];
  });
  return options.length ? options : undefined;
}

function shareScopeMatches(
  kind: ShareKind,
  targetId: string | undefined,
  receipt: { scope_kind: string; scope_id: string | null },
): boolean {
  if (kind === "briefing") return receipt.scope_kind === "global" && receipt.scope_id === null;
  return receipt.scope_kind === kind && Boolean(targetId) && receipt.scope_id === targetId;
}

async function reviewedAnswerForShare(
  env: Env,
  input: { kind: ShareKind; id?: string; reviewedRunId: string },
): Promise<ReviewedShareAnswer> {
  const unavailable = (): never => {
    throw new HttpError(422, "That reviewed answer cannot be included in this share. Choose a reviewed answer prepared for the same Story, Mission, or briefing.");
  };
  const run = await getReasoningRun(env.DB, input.reviewedRunId);
  if (!run || run.status !== "reviewed" || !run.reviewed_at) return unavailable();
  const receipt = await getReasoningReceipt(env.DB, run.receipt_id);
  if (!receipt) return unavailable();
  const bundle = await readReasoningReceiptBundle(env, receipt);
  if (!bundle) return unavailable();
  if (bundle.sourceScope !== "share") {
    throw new HttpError(422, "Prepare and review a version for sharing before adding this answer. Personal context stays out of public Shares.");
  }
  return await projectReviewedAnswerForShare({ ...input, run, receipt, bundle }) ?? unavailable();
}

export async function projectReviewedAnswerForShare(input: {
  kind: ShareKind;
  id?: string;
  run: ReasoningRunRecord;
  receipt: ReasoningReceiptRecord;
  bundle: ReasoningBundle;
}): Promise<ReviewedShareAnswer | null> {
  const { run, receipt, bundle } = input;
  if (
    run.status !== "reviewed" || !run.reviewed_at || run.receipt_id !== receipt.id ||
    !shareScopeMatches(input.kind, input.id, receipt) ||
    bundle.sourceScope !== "share" || !Array.isArray(bundle.evidence) || !bundle.evidence.length
  ) return null;
  if (
    Number(bundle.coverage?.localEvidenceCount ?? 0) !== 0 ||
    bundle.evidence.some((item) => {
      if (!item || typeof item !== "object") return true;
      const accessClass = item.accessClass as AccessClass;
      const sourceKind = typeof item.sourceKind === "string" ? item.sourceKind : "";
      const url = typeof item.url === "string" ? item.url : "";
      return !sourceKind
        || !isPublicShareEvidence({ access_class: accessClass, source_kind: sourceKind })
        || !url
        || publicKnowledgeUrl(url) !== url;
    })
  ) return null;
  const bundleRecord = bundle as unknown as Record<string, unknown>;
  if (bundleRecord.receiptId !== receipt.id) return null;
  const { receiptId: _receiptId, generatedAt: _generatedAt, ...hashableBundle } = bundleRecord;
  if (await sha256(stableStringify(hashableBundle)) !== receipt.bundle_hash) return null;
  const allowedCitationUrls = new Set(bundle.evidence.flatMap((item) => (
    typeof item.url === "string" ? [item.url] : []
  )));

  const structured = parseJson<Record<string, unknown>>(run.structured_result_json, {});
  const recommendation = structuredString(structured, ["recommendation"]);
  const explicitAnswer = structuredString(structured, ["answer", "conclusion", "thesis", "bottomLine", "bottom_line"]);
  const summary = structuredString(structured, ["summary"]);
  const answer = normalizeReviewedShareAnswer({
    answer: recommendation ?? explicitAnswer ?? summary ?? run.response_summary,
    whyItMatters: structuredString(structured, ["whyItMatters", "why_it_matters", "significance"])
      ?? ((recommendation ?? explicitAnswer) && summary && summary !== (recommendation ?? explicitAnswer) ? summary : undefined),
    keyJudgments: structuredJudgmentList(
      structured,
      ["keyJudgments", "key_judgments", "drivers", "causalDrivers", "causal_drivers"],
      allowedCitationUrls,
    ) ?? structuredJudgmentList(
      structured,
      ["strongestEvidence", "strongest_evidence"],
      allowedCitationUrls,
      ["claim", "judgment", "summary", "text"],
    ),
    options: structuredOptions(structured),
    outlook: structuredNarrative(structured, ["outlook", "baseCase", "base_case", "mostLikelyCase", "most_likely_case"]),
    alternativeCase: structuredJudgmentList(
      structured,
      ["alternativeCase", "alternative_case", "strongestContraryCase", "strongest_contrary_case", "contraryCase", "contrary_case", "competingExplanation", "competing_explanation"],
      allowedCitationUrls,
      ["text", "summary", "case", "description"],
    )?.[0],
    whatWouldChange: structuredTextList(structured, ["whatWouldChange", "what_would_change", "reversalTrigger", "reversal_trigger"]),
    signposts: structuredJudgmentList(
      structured,
      ["signposts", "indicators", "watchSignals", "watch_signals", "watchFor", "watch_for"],
      allowedCitationUrls,
      ["text", "summary", "signal", "description"],
    ),
    nextSteps: structuredTextList(structured, ["nextSteps", "next_steps", "reversibleNextSteps", "reversible_next_steps"]),
    whatToWatch: structuredList(structured, ["whatToWatch", "what_to_watch", "watchConditions", "nextChecks"]),
    uncertainty: structuredTextList(structured, ["uncertainty", "uncertainties", "caveats", "evidenceGaps", "evidence_gaps"]),
    evidenceSnapshotHash: receipt.bundle_hash,
    reviewedAt: run.reviewed_at,
  }, allowedCitationUrls);
  return answer;
}

export async function createPublicShare(
  request: Request,
  env: Env,
  input: { kind: ShareKind; id?: string; expiresDays?: number; reviewedRunId?: string },
): Promise<{ id: string; url: string; dropUrl: string; expiresAt: string; payload: PublicSharePayload }> {
  const basePayload = await buildSharePayload(env, input.kind, input.id);
  const reviewedAnswer = input.reviewedRunId
    ? await reviewedAnswerForShare(env, { kind: input.kind, id: input.id, reviewedRunId: input.reviewedRunId })
    : undefined;
  const payload = normalizePublicSharePayload({ ...basePayload, reviewedAnswer });
  if (!payload) throw new HttpError(500, "Public share projection failed validation");
  const token = randomToken(24);
  const tokenHash = await sha256(token);
  const expiresDays = Math.max(1, Math.min(90, Number(input.expiresDays ?? 14)));
  const expiresAt = new Date(Date.now() + expiresDays * 86_400_000).toISOString();
  const id = crypto.randomUUID();
  await insertPublicShare(env.DB, {
    id,
    tokenHash,
    kind: input.kind,
    title: payload.title,
    payload: payload as unknown as Record<string, unknown>,
    expiresAt,
  });
  const url = `${baseUrlFor(request, env.PUBLIC_BASE_URL)}/share/${token}`;
  return {
    id,
    url,
    dropUrl: `${url}/drop.zip`,
    expiresAt,
    payload,
  };
}

function storedPublicPayload(share: PublicShareRecord): PublicSharePayload {
  let value: unknown;
  try {
    value = JSON.parse(share.payload_json);
  } catch {
    throw new HttpError(410, "This share is unavailable. Create a new public-evidence-only share.");
  }
  const payload = normalizePublicSharePayload(value);
  if (!payload) {
    throw new HttpError(410, "This share predates public-evidence safeguards or is invalid. Create a new share.");
  }
  return payload;
}

function shareHeaders(env: Env, initial: HeadersInit): Headers {
  return publicShareResponseHeaders(env.PUBLIC_INDEXING === "enabled", initial);
}

function applyShareHeaders(env: Env, response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: shareHeaders(env, response.headers),
  });
}

export async function handlePublicShare(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: "Method not allowed; use GET" }), {
      status: 405,
      headers: shareHeaders(env, {
        "allow": "GET",
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      }),
    });
  }
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/share\/([a-f0-9]{48})(?:\/(og\.png|drop\.zip))?$/i);
  if (!match) throw new HttpError(404, "Share not found");
  const token = match[1] ?? "";
  const tokenHash = await sha256(token);
  const share = await getPublicShareByHash(env.DB, tokenHash);
  if (!share) throw new HttpError(410, "This intelligence card is unavailable or has expired");
  // Validate before selecting a representation. This also blocks legacy OG objects and Drop Capsules
  // whose stored payload did not prove that every evidence item was public.
  const payload = storedPublicPayload(share);
  const publicIndexing = env.PUBLIC_INDEXING === "enabled";

  if (match[2] === "drop.zip") {
    const capsule = buildDropCapsule(payload, { publicIndexing });
    const filename = `${payload.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "driftglass"}-shared-copy.zip`;
    return new Response(capsule, {
      headers: shareHeaders(env, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, max-age=300",
        "x-driftglass-capsule": "portable",
      }),
    });
  }

  if (match[2] === "og.png") {
    const key = `public-shares/${share.id}/og.png`;
    try {
      const cached = await getEvidenceObject(env, key);
      if (cached) {
        return new Response(cached.body, {
          headers: shareHeaders(env, { "content-type": "image/png", "cache-control": "public, max-age=86400, stale-while-revalidate=604800" }),
        });
      }
      const previewUrl = new URL(`/share/${token}?preview=1`, request.url);
      const image = await captureKitesurfScreenshot({ url: previewUrl, env, width: 1200, height: 630 });
      await putEvidenceObject(env, key, image, {
        httpMetadata: { contentType: "image/png", cacheControl: publicIndexing ? "public, max-age=86400" : "private, no-store" },
      });
      return new Response(image, {
        headers: shareHeaders(env, { "content-type": "image/png", "cache-control": "public, max-age=86400" }),
      });
    } catch {
      return applyShareHeaders(env, await env.ASSETS.fetch(new Request(new URL("/icons/driftglass-share-fallback.png", request.url))));
    }
  }

  // Internal OG screenshots use preview=1 and must not inflate human-facing
  // share analytics. Direct HTML/JSON reads retain the deliberate view count.
  if (url.searchParams.get("preview") !== "1") {
    await incrementPublicShareView(env.DB, share.id);
  }

  if (url.searchParams.get("format") === "json" || request.headers.get("accept")?.includes("application/json")) {
    return new Response(JSON.stringify(recipientShareDocument(payload, share.expires_at), null, 2), {
      headers: shareHeaders(env, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" }),
    });
  }

  const ogImage = new URL(`/share/${token}/og.png`, request.url).toString();
  const page = renderPublicSharePage({
    payload,
    publicIndexing,
    dropUrl: new URL(`/share/${token}/drop.zip`, request.url).toString(),
    ogImageUrl: ogImage,
  });
  return new Response(page, {
    headers: shareHeaders(env, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" }),
  });
}
