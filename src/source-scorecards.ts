import { listSourceCadence } from "./db";
import { isoNow } from "./utils";

function rows<T>(result: D1Result<T>): T[] { return result.results ?? []; }
function clamp(value: number, min = 0, max = 1): number { return Math.max(min, Math.min(max, value)); }

export interface SourceScorecard {
  sourceId: string;
  name: string;
  kind: string;
  enabled: boolean;
  health: number;
  weight: number;
  runs: number;
  successes: number;
  successRate: number;
  items: number;
  uniqueStories: number;
  missionMatches: number;
  independentItems: number;
  echoItems: number;
  independenceRate: number;
  medianLatencyMs: number;
  valueScore: number;
  costClass: "light" | "browser" | "companion";
  cadence: Record<string, unknown> | null;
  recommendation: "accelerate" | "keep" | "slow" | "repair" | "pause";
  reasons: string[];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export async function sourceScorecards(db: D1Database, days = 30): Promise<{ generatedAt: string; days: number; scorecards: SourceScorecard[] }> {
  const windowDays = Math.max(1, Math.min(180, Math.round(days)));
  const maxSources = 500;
  const recentRunsPerSource = 32;
  const [sources, runs, evidence, cadence] = await Promise.all([
    rows(await db.prepare(
      "SELECT id, name, kind, enabled, health_score, weight FROM sources ORDER BY enabled DESC, name COLLATE NOCASE LIMIT ?",
    ).bind(maxSources).all<{ id: string; name: string; kind: string; enabled: number; health_score: number; weight: number }>()),
    rows(await db.prepare(
      `WITH ranked AS (
         SELECT source_id, status, item_count, latency_ms,
                ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY started_at DESC) AS run_rank
         FROM source_runs
         WHERE datetime(started_at) >= datetime('now', '-' || ? || ' days')
       )
       SELECT source_id, status, item_count, latency_ms
       FROM ranked
       WHERE run_rank <= ?
       ORDER BY source_id, run_rank`,
    ).bind(windowDays, recentRunsPerSource).all<{ source_id: string; status: string; item_count: number; latency_ms: number }>()),
    rows(await db.prepare(
      `WITH base_items AS (
         SELECT i.id, i.source_id, MAX(COALESCE(el.independent, 1)) AS independent
         FROM items i
         LEFT JOIN evidence_lineage el ON el.item_id = i.id
         WHERE datetime(i.observed_at) >= datetime('now', '-' || ? || ' days')
         GROUP BY i.id, i.source_id
       ),
       item_stats AS (
         SELECT source_id,
                COUNT(*) AS items,
                SUM(CASE WHEN independent = 1 THEN 1 ELSE 0 END) AS independent_items,
                SUM(CASE WHEN independent = 0 THEN 1 ELSE 0 END) AS echo_items
         FROM base_items
         GROUP BY source_id
       ),
       source_stories AS (
         SELECT DISTINCT base.source_id, links.story_id
         FROM base_items base
         JOIN story_items links ON links.item_id = base.id
       ),
       story_stats AS (
         SELECT linked.source_id, COUNT(*) AS stories, AVG(story.score) AS mean_story_score
         FROM source_stories linked
         JOIN stories story ON story.id = linked.story_id
         GROUP BY linked.source_id
       ),
       mission_stats AS (
         SELECT linked.source_id,
                COUNT(DISTINCT matches.mission_id || ':' || linked.story_id) AS mission_matches
         FROM source_stories linked
         JOIN mission_story_matches matches ON matches.story_id = linked.story_id
         GROUP BY linked.source_id
       )
       SELECT items.source_id,
              items.items,
              COALESCE(stories.stories, 0) AS stories,
              COALESCE(missions.mission_matches, 0) AS mission_matches,
              items.independent_items,
              items.echo_items,
              COALESCE(stories.mean_story_score, 0) AS mean_story_score
       FROM item_stats items
       LEFT JOIN story_stats stories ON stories.source_id = items.source_id
       LEFT JOIN mission_stats missions ON missions.source_id = items.source_id`,
    ).bind(windowDays).all<{ source_id: string; items: number; stories: number; mission_matches: number; independent_items: number; echo_items: number; mean_story_score: number }>()),
    listSourceCadence(db),
  ]);
  const evidenceBySource = new Map(evidence.map((row) => [row.source_id, row]));
  const cadenceBySource = new Map(cadence.map((row) => [row.source_id, row]));
  const scorecards: SourceScorecard[] = sources.map((source) => {
    const sourceRuns = runs.filter((row) => row.source_id === source.id);
    const successes = sourceRuns.filter((row) => ["success", "partial", "queued"].includes(row.status)).length;
    const successRate = sourceRuns.length ? successes / sourceRuns.length : source.health_score;
    const stats = evidenceBySource.get(source.id);
    const items = Number(stats?.items ?? 0);
    const independentItems = Number(stats?.independent_items ?? items);
    const echoItems = Number(stats?.echo_items ?? 0);
    const independenceRate = items ? independentItems / items : 1;
    const missionMatches = Number(stats?.mission_matches ?? 0);
    const uniqueStories = Number(stats?.stories ?? 0);
    const meanStoryScore = Number(stats?.mean_story_score ?? 0);
    const missionYield = items ? Math.min(1, missionMatches / Math.max(1, uniqueStories)) : 0;
    const storyYield = items ? Math.min(1, uniqueStories / items) : 0;
    const quality = clamp(meanStoryScore / 100);
    const valueScore = Math.round(100 * clamp(
      successRate * 0.2
      + source.health_score * 0.14
      + independenceRate * 0.2
      + missionYield * 0.2
      + storyYield * 0.11
      + quality * 0.15,
    ));
    const costClass: SourceScorecard["costClass"] = source.kind === "collector" ? "companion" : ["web", "web_feed"].includes(source.kind) ? "browser" : "light";
    const reasons: string[] = [];
    let recommendation: SourceScorecard["recommendation"] = "keep";
    if (successRate < 0.45 || source.health_score < 0.35) {
      recommendation = source.enabled ? "repair" : "pause";
      reasons.push("Collection reliability is materially degraded");
    } else if (sourceRuns.length >= 3 && items === 0) {
      recommendation = "slow";
      reasons.push("Repeated runs produced no evidence in the selected window");
    } else if (independenceRate < 0.35 && items >= 5) {
      recommendation = "slow";
      reasons.push("Most items duplicate another source family");
    } else if (valueScore >= 75 && missionMatches >= 2 && successRate >= 0.8) {
      recommendation = "accelerate";
      reasons.push("High mission relevance, independent evidence, and reliable collection");
    } else if (missionMatches > 0) reasons.push("Contributes to active Research Missions");
    if (echoItems > independentItems) reasons.push("Echo coverage exceeds independent coverage");
    if (costClass === "browser" && valueScore < 45) reasons.push("Browser cost is high relative to observed value");
    if (!source.enabled) reasons.push("Source is currently disabled");
    return {
      sourceId: source.id,
      name: source.name,
      kind: source.kind,
      enabled: source.enabled === 1,
      health: source.health_score,
      weight: source.weight,
      runs: sourceRuns.length,
      successes,
      successRate,
      items,
      uniqueStories,
      missionMatches,
      independentItems,
      echoItems,
      independenceRate,
      medianLatencyMs: median(sourceRuns.map((row) => Number(row.latency_ms ?? 0)).filter((value) => value > 0)),
      valueScore,
      costClass,
      cadence: cadenceBySource.has(source.id) ? { ...(cadenceBySource.get(source.id) as unknown as Record<string, unknown>) } : null,
      recommendation,
      reasons,
    };
  }).sort((left, right) => right.valueScore - left.valueScore || right.missionMatches - left.missionMatches || left.name.localeCompare(right.name));
  return { generatedAt: isoNow(), days: windowDays, scorecards };
}
