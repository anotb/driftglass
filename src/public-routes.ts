import { latestOrBuildBriefing } from "./briefing";
import { buildDeepResearchHandoff, deepResearchMarkdown } from "./deep-research";
import { getMission, getMissionOperator, getSavedView, getStory, listMissionEvents, listMissionMatches, recordFeedback, searchStories } from "./db";
import { baseUrlFor, requireReadKey } from "./security";
import { memoryNeighborhood, memoryTimeline } from "./memory-graph";
import { buildReasoningBundle, reasoningBundleMarkdown } from "./reasoning";
import type { BriefingPacket, BriefingPacketStory, Env, ReasoningTarget, ReasoningTask } from "./types";
import { HttpError, markdown, plainTextExcerpt } from "./utils";

const ACTIONS: Record<string, string> = {
  more: "More like this",
  less: "Less like this",
  track: "Track this story",
  mute: "Mute this story",
  "already-knew": "Already knew",
  "bad-source": "Bad source",
  wrong: "Wrong interpretation",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

type ScheduledMission = BriefingPacket["missions"][number];

function inline(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function shortDate(value: string | null | undefined): string {
  const clean = inline(value);
  const parsed = Date.parse(clean);
  return clean && Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : clean;
}

function independentFamilies(story: BriefingPacketStory): number {
  return new Set(story.evidence
    .filter((item) => item.familyKey && item.independent === true)
    .map((item) => item.familyKey as string)).size;
}

function evidenceLimits(story: BriefingPacketStory): string {
  const classified = story.evidence.filter((item) => item.familyKey && typeof item.independent === "boolean");
  const notes = classified.length === 0
    ? ["Source relationships have not been classified yet; multiple source names are not proof of independent confirmation."]
    : independentFamilies(story) >= 2
      ? ["The source trail includes separately classified source families, but that alone does not verify the claim."]
      : ["The classified evidence currently rests on one source family; repeated coverage is not independent confirmation."];
  if (classified.length < story.evidence.length) notes.push("Some source relationships remain unclassified.");
  if (story.evidence.some((item) => item.sourceRelationship === "echo")) notes.push("Some items are repeated coverage.");
  if (story.evidence.some((item) => item.accessClass !== "public")) notes.push("Some evidence needs a signed-in, subscription, or private source and may not be publicly verifiable.");
  return notes.join(" ");
}

function relationshipLabel(item: BriefingPacketStory["evidence"][number]): string {
  if (!item.familyKey || typeof item.independent !== "boolean") return "not yet classified";
  if (item.sourceRelationship === "echo") return "repeated coverage";
  if (item.sourceRelationship === "update") return item.independent ? "update from a separate source family" : "update from the same source family";
  if (item.sourceRelationship === "origin") return "starting source";
  return item.independent ? "separate source family" : "related coverage";
}

function accessLabel(value: string): string {
  if (value === "public") return "public";
  if (value === "authenticated-local") return "signed-in source";
  if (value === "subscriber-local") return "subscription source";
  return "private source";
}

function changeSummary(story: BriefingPacketStory, previousBriefingAt?: string): string {
  const observed = shortDate(story.changedAt);
  if (!previousBriefingAt) return `This appears in the first evidence snapshot, so there is no earlier scheduled check to establish a change${observed ? `; last observed ${observed}` : ""}.`;
  const details: string[] = [];
  if (story.change.newEvidenceCount > 0) details.push("new evidence was collected");
  if (story.change.sourceCountDelta > 0) details.push("coverage widened across additional configured sources");
  const lead = story.change.kind === "new" ? "This is newly included since the previous evidence snapshot" : "Driftglass updated this Story since the previous evidence snapshot";
  return `${lead}${details.length ? `: ${details.join(" and ")}` : ""}${observed ? `; last observed ${observed}` : ""}.`;
}

function whyItMatters(missions: ScheduledMission[]): string {
  if (!missions.length) return "Driftglass has not linked this development to a standing question, so its personal relevance is not yet established.";
  const primary = missions[0];
  const name = inline(primary?.name) || "an active Mission";
  const question = inline(primary?.question);
  return `This bears on “${name}”${question ? `: ${question}` : ""}.`;
}

function whatNext(missions: ScheduledMission[], story: BriefingPacketStory): string {
  const expected = missions.find((mission) => inline(mission.expectedNextEvent));
  if (expected) return `Watch next: ${inline(expected.expectedNextEvent)}${expected.expectedBy ? ` by ${shortDate(expected.expectedBy)}` : ""}. Compare that observation with the saved Mission context before changing a decision.`;
  if (!missions.length) return "No action unless this belongs in an ongoing question. Open the source trail before deciding whether to follow it.";
  return independentFamilies(story) < 2
    ? "Watch for separate support before acting; no specific next event has been recorded for this Mission."
    : "Compare the source claims with the saved Mission context before acting; no specific next event has been recorded.";
}

export async function handlePacket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const latestMatch = url.pathname.match(/^\/packet\/([^/]+)\/latest\.md$/);
  const pulseMatch = url.pathname.match(/^\/packet\/([^/]+)\/pulse\.md$/);
  const lensMatch = url.pathname.match(/^\/packet\/([^/]+)\/lens\/([^/]+)\.md$/);
  const reasoningMatch = url.pathname.match(/^\/packet\/([^/]+)\/reasoning\/([^/]+)\.md$/);
  const memoryMatch = url.pathname.match(/^\/packet\/([^/]+)\/memory\.md$/);
  const missionResearchMatch = url.pathname.match(/^\/packet\/([^/]+)\/mission\/([^/]+)\/deep-research\.md$/);
  const missionMatch = url.pathname.match(/^\/packet\/([^/]+)\/mission\/([^/]+)\.md$/);
  const readKey = latestMatch?.[1] ?? pulseMatch?.[1] ?? lensMatch?.[1] ?? reasoningMatch?.[1] ?? memoryMatch?.[1] ?? missionResearchMatch?.[1] ?? missionMatch?.[1] ?? "";
  if (!readKey) throw new HttpError(404, "Packet not found");
  await requireReadKey(readKey, env.DRIFTGLASS_SECRET);
  const base = baseUrlFor(request, env.PUBLIC_BASE_URL);


  if (reasoningMatch) {
    const requestedTarget = String(reasoningMatch[2] ?? "chatgpt");
    const target: ReasoningTarget = ["chatgpt", "claude", "grok", "generic"].includes(requestedTarget)
      ? requestedTarget as ReasoningTarget
      : "generic";
    const requestedTask = String(url.searchParams.get("task") ?? "investigate");
    const task: ReasoningTask = ["daily-brief", "investigate", "decision", "challenge", "deep-research", "memory-update"].includes(requestedTask)
      ? requestedTask as ReasoningTask
      : "investigate";
    const scopeKind = url.searchParams.get("missionId") ? "mission" : url.searchParams.get("storyId") ? "story" : "global";
    const scopeId = url.searchParams.get("missionId") ?? url.searchParams.get("storyId") ?? undefined;
    const bundle = await buildReasoningBundle(env, {
      target,
      task,
      scopeKind,
      scopeId,
      objective: url.searchParams.get("objective") ?? undefined,
      tokenBudget: Number(url.searchParams.get("tokens") ?? 0) || undefined,
      request,
    });
    return markdown(reasoningBundleMarkdown(bundle), {
      headers: { "x-driftglass-reasoning-target": target, "x-driftglass-reasoning-task": task },
    });
  }

  if (memoryMatch) {
    const ref = url.searchParams.get("ref") ?? undefined;
    const query = url.searchParams.get("q") ?? undefined;
    const [graph, timeline] = await Promise.all([
      memoryNeighborhood(env, { ref, query, limit: 80 }),
      memoryTimeline(env, { ref, query, limit: 60 }),
    ]);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const lines = [
      "# Driftglass Memory Graph",
      "",
      `Generated: ${new Date().toISOString()}`,
      ref ? `Reference: ${ref}` : "",
      query ? `Query: ${query}` : "",
      `Nodes: ${graph.nodes.length} · Relations: ${graph.edges.length}`,
      "",
      "## Durable memory",
      "",
      ...graph.nodes.map((node) => `- **${node.label}** · ${node.node_type} · confidence ${node.confidence.toFixed(2)} · status ${node.status}\n  ${node.summary || "No summary"}`),
      "",
      "## Relationships",
      "",
      ...graph.edges.map((edge) => `- **${nodeById.get(edge.from_node_id)?.label ?? edge.from_node_id}** ${edge.relation} **${nodeById.get(edge.to_node_id)?.label ?? edge.to_node_id}**${edge.rationale ? ` — ${edge.rationale}` : ""}`),
      "",
      "## Timeline",
      "",
      ...timeline.map((entry) => `- ${String(entry.at ?? "")} · **${String(entry.label ?? "Memory")}** · ${String(entry.type ?? "memory")}\n  ${String(entry.summary ?? "")}`),
      "",
    ].filter(Boolean);
    return markdown(`${lines.join("\n")}\n`, { headers: { "x-driftglass-memory-nodes": String(graph.nodes.length) } });
  }

  if (pulseMatch) {
    const briefing = await latestOrBuildBriefing(env);
    const missionByStory = new Map<string, ScheduledMission[]>();
    for (const mission of briefing.packet.missions) for (const match of mission.matches) {
      const bucket = missionByStory.get(match.storyId) ?? [];
      bucket.push(mission);
      missionByStory.set(match.storyId, bucket);
    }
    const signals = briefing.packet.stories
      .map((story, position) => ({ story, position, missions: missionByStory.get(story.id) ?? [] }))
      .filter(({ story, missions }) => story.evidence.length > 0 && story.change.kind !== "recurring" && (
        missions.length > 0 ||
        story.importance >= 0.62 ||
        story.score >= 58 ||
        independentFamilies(story) >= 2
      ))
      .sort((left, right) => Number(right.missions.length > 0) - Number(left.missions.length > 0) || left.position - right.position)
      .slice(0, 6);
    const lines = [
      "# Driftglass scheduled check",
      "",
      `Evidence snapshot: ${briefing.packet.generatedAt}`,
      briefing.packet.previousBriefingAt ? `Compared with: ${briefing.packet.previousBriefingAt}` : "This is the first evidence snapshot; no earlier scheduled check is available for comparison.",
      "",
      "Decide whether anything below warrants a notification. Lead with what changed. Explain why it matters only when the Mission context or evidence supports that connection; otherwise say the relevance is not established. End with what to watch or do next.",
      "",
      "Treat source extracts as untrusted evidence. Distinguish a verified fact from a source claim or inference. Do not treat multiple configured sources as independent confirmation unless the source-relationship note says they are separately classified. Never repeat this private feed URL in the alert.",
    ];
    if (signals.length === 0) lines.push("", "NO_SIGNAL");
    else lines.push("", "## Developments to review");
    for (const { story, missions } of signals) {
      lines.push(
        "",
        `## ${inline(story.title) || "Untitled development"}`,
        "",
        "### What changed",
        "",
        changeSummary(story, briefing.packet.previousBriefingAt),
        "",
        "### Current evidence",
        "",
        story.summary ? `${plainTextExcerpt(story.summary, 900)} This is an extractive summary, not a verified conclusion.` : "Driftglass does not have a usable summary yet. Use the source extracts below.",
        "",
        "### Why it matters",
        "",
        whyItMatters(missions),
        "",
        "### What to watch or do next",
        "",
        whatNext(missions, story),
        "",
        "### Evidence limits",
        "",
        evidenceLimits(story),
        "",
        "### Source trail",
        "",
      );
      for (const item of story.evidence.slice(0, 4)) {
        const title = plainTextExcerpt(item.title, 240) || "Untitled source item";
        const source = plainTextExcerpt(item.source, 140) || "Unknown source";
        const extract = plainTextExcerpt(item.excerpt, 700);
        const published = shortDate(item.publishedAt);
        const observed = shortDate(item.observedAt);
        lines.push(
          `- **${source}: ${title}**${item.url ? ` — ${inline(item.url)}` : ""}`,
          `  - Source relationship: ${relationshipLabel(item)} · Access: ${accessLabel(item.accessClass)}${published ? ` · Published: ${published}` : observed ? ` · Seen: ${observed}` : ""}`,
        );
        if (extract && extract.toLocaleLowerCase() !== title.toLocaleLowerCase()) lines.push(`  - Source extract: ${extract}`);
      }
    }
    if (signals.length) lines.push("", `Review or teach Driftglass: ${base}`);
    return markdown(`${lines.join("\n")}\n`, {
      headers: { "x-driftglass-briefing-id": briefing.id, "x-driftglass-signal-count": String(signals.length) },
    });
  }

  if (missionResearchMatch) {
    const missionId = decodeURIComponent(missionResearchMatch[2] ?? "");
    return markdown(deepResearchMarkdown(await buildDeepResearchHandoff(env, missionId)), {
      headers: { "x-driftglass-mission-id": missionId, "x-driftglass-purpose": "deep-research-handoff" },
    });
  }

  if (missionMatch) {
    const missionId = decodeURIComponent(missionMatch[2] ?? "");
    const mission = await getMission(env.DB, missionId);
    if (!mission) throw new HttpError(404, "Mission not found");
    const [operator, events, matches] = await Promise.all([
      getMissionOperator(env.DB, missionId),
      listMissionEvents(env.DB, missionId, 20),
      listMissionMatches(env.DB, missionId, 20),
    ]);
    const purposeLabels: Record<string, string> = { watch: "stay current", decision: "support a decision", hypothesis: "test a belief", event: "follow an expected event" };
    const aiReviewLabels: Record<string, string> = { manual: "only when requested", suggest: "suggest when useful", always: "prepare after meaningful updates" };
    const outcomeLabels: Record<string, string> = { open: "still open", resolved: "resolved", invalidated: "belief disproved", superseded: "replaced by a newer question" };
    const purpose = operator ? (purposeLabels[operator.mode] ?? "stay current") : "stay current";
    const aiReview = operator ? (aiReviewLabels[operator.research_policy] ?? "suggest when useful") : "suggest when useful";
    const outcome = operator ? (outcomeLabels[operator.outcome_status] ?? operator.outcome_status) : "still open";
    const lines = [
      `# Driftglass Mission · ${mission.name}`,
      "",
      `Generated: ${new Date().toISOString()}`,
      mission.question ? `Question: ${mission.question}` : "",
      `Purpose: ${purpose} · Broader AI review: ${aiReview} · Current state: ${outcome}`,
      operator?.expected_next_event ? `Next signal that could change the answer: ${operator.expected_next_event}${operator.expected_by ? ` by ${operator.expected_by}` : ""}` : "",
      operator?.outcome_summary ? `What was learned or decided: ${operator.outcome_summary}` : "",
      matches.length ? "Recent evidence is included below." : "No recent evidence is linked to this Mission yet.",
      events.length ? "Mission history is available in Driftglass." : "Mission history is still empty.",
      "",
      "Driftglass keeps the question, evidence, and changes over time. Use the broader AI review brief when the evidence needs real interpretation or a decision.",
      `AI review brief: ${base}/packet/${readKey}/mission/${encodeURIComponent(mission.id)}/deep-research.md`,
    ].filter(Boolean);
    for (const match of matches) {
      const storyId = String(match.story_id ?? "");
      const detail = storyId ? await getStory(env.DB, storyId) : null;
      if (!detail) continue;
      lines.push(
        "",
        `## ${detail.story.title}`,
        "",
        detail.story.summary || "No summary available.",
        "",
        `Last changed: ${detail.story.last_changed_at}`,
        "",
        "Evidence:",
      );
      for (const item of detail.evidence.slice(0, 8)) {
        const link = item.url ? ` — ${item.url}` : "";
        lines.push(`- ${item.source_name}: ${item.title}${link}`);
      }
      lines.push("", `Track: ${base}/feedback/${readKey}/${detail.story.id}/track`, `Less like this: ${base}/feedback/${readKey}/${detail.story.id}/less`);
    }
    if (events.length) {
      lines.push("", "## Mission history");
      for (const event of events.slice(0, 12)) {
        lines.push(`- ${event.occurred_at} · ${event.event_type} · ${event.title}${event.detail ? ` — ${event.detail}` : ""}`);
      }
    }
    return markdown(`${lines.join("\n")}\n`, {
      headers: { "x-driftglass-mission-id": mission.id },
    });
  }

  if (lensMatch) {
    const lensId = decodeURIComponent(lensMatch[2] ?? "");
    const lens = await getSavedView(env.DB, lensId);
    if (!lens) throw new HttpError(404, "Lens not found");
    const matches = await searchStories(env.DB, lens.query, 20);
    const lines = [
      `# Driftglass Lens · ${lens.name}`,
      "",
      `Generated: ${new Date().toISOString()}`,
      `Query: ${lens.query}`,
      `Stories: ${matches.length}`,
      "",
      "This is a bounded evidence view from Driftglass story memory. Compare with prior runs and report only meaningful changes.",
    ];
    for (const story of matches) {
      const detail = await getStory(env.DB, story.id);
      lines.push(
        "",
        `## ${story.title}`,
        "",
        story.summary || "No summary available.",
        "",
        `Score: ${story.score.toFixed(1)} · Sources: ${story.source_count} · Last changed: ${story.last_changed_at}`,
        "",
        "Evidence:",
      );
      for (const item of detail?.evidence.slice(0, 6) ?? []) {
        const link = item.url ? ` — ${item.url}` : "";
        lines.push(`- ${item.source_name}: ${item.title}${link}`);
      }
      lines.push("", `Track: ${base}/feedback/${readKey}/${story.id}/track`, `Less like this: ${base}/feedback/${readKey}/${story.id}/less`);
    }
    return markdown(`${lines.join("\n")}\n`, {
      headers: { "x-driftglass-lens-id": lens.id },
    });
  }

  const briefing = await latestOrBuildBriefing(env);
  const feedbackLines = [
    "",
    "## Feedback links",
    "",
    "Use these when the reader wants to help Driftglass learn. Each link opens a confirmation page.",
  ];
  for (const story of briefing.packet.stories) {
    feedbackLines.push("", `- ${story.title}`);
    for (const [action, label] of Object.entries(ACTIONS)) {
      feedbackLines.push(`  - ${label}: ${base}/feedback/${readKey}/${story.id}/${action}`);
    }
  }
  return markdown(`${briefing.markdown}${feedbackLines.join("\n")}\n`, {
    headers: { "x-driftglass-briefing-id": briefing.id },
  });
}

export async function handleFeedbackLink(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/feedback\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) throw new HttpError(404, "Feedback link not found");
  const [, readKey = "", storyId = "", action = ""] = match;
  await requireReadKey(readKey, env.DRIFTGLASS_SECRET);
  const label = ACTIONS[action];
  if (!label) throw new HttpError(400, "Unknown feedback action");
  const detail = await getStory(env.DB, storyId);
  if (!detail) throw new HttpError(404, "Story not found");

  if (request.method === "POST") {
    await recordFeedback(env.DB, { storyId, action });
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Feedback saved</title><style>body{font:16px system-ui;max-width:680px;margin:64px auto;padding:24px;color:#182026}a{color:#3156d3}</style><h1>Feedback saved</h1><p><strong>${escapeHtml(label)}</strong> for “${escapeHtml(detail.story.title)}”.</p><p>You can close this tab.</p>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Confirm feedback</title><style>body{font:16px system-ui;max-width:680px;margin:64px auto;padding:24px;color:#182026}button{font:inherit;padding:12px 18px;border:0;border-radius:10px;background:#182026;color:white;cursor:pointer}.card{padding:24px;border:1px solid #dce1e7;border-radius:16px}</style><div class="card"><p>Help Driftglass learn</p><h1>${escapeHtml(label)}?</h1><p>${escapeHtml(detail.story.title)}</p><form method="post"><button type="submit">Confirm</button></form></div>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
