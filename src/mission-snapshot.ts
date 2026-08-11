export const MISSION_SNAPSHOT_MATCH_LIMIT = 32;
export const MISSION_SNAPSHOT_EVIDENCE_PER_STORY_LIMIT = 8;
export const MISSION_SNAPSHOT_EVIDENCE_LIMIT = 32;
export const MISSION_SNAPSHOT_EVIDENCE_TEXT_CHARACTERS = 192;
export const MISSION_SNAPSHOT_STORY_TITLE_CHARACTERS = 160;
export const MISSION_SNAPSHOT_STORY_SUMMARY_CHARACTERS = 128;
export const MISSION_SNAPSHOT_EVIDENCE_TITLE_CHARACTERS = 120;
export const MISSION_SNAPSHOT_EVIDENCE_URL_CHARACTERS = 384;
export const MISSION_SNAPSHOT_EVIDENCE_FIELD_CHARACTERS = 32;
export const MISSION_SNAPSHOT_MATCH_TERM_LIMIT = 4;
export const MISSION_SNAPSHOT_MATCH_TERM_CHARACTERS = 32;
export const MISSION_SNAPSHOT_EVIDENCE_CANDIDATE_PER_STORY_LIMIT =
  MISSION_SNAPSHOT_EVIDENCE_PER_STORY_LIMIT + 1;
export const MISSION_SNAPSHOT_EVIDENCE_OVERFLOW_PER_STORY_LIMIT =
  MISSION_SNAPSHOT_EVIDENCE_LIMIT + 1;
export const MISSION_SNAPSHOT_EVIDENCE_CANDIDATE_ROW_LIMIT =
  MISSION_SNAPSHOT_MATCH_LIMIT * MISSION_SNAPSHOT_EVIDENCE_CANDIDATE_PER_STORY_LIMIT;

export interface MissionSnapshotEvidenceRow {
  story_id: string;
  item_id: string;
  source_id: string;
  source_name: string;
  source_kind: string;
  title: string;
  url: string | null;
  author: string | null;
  published_at: string | null;
  observed_at: string;
  access_class: string;
  metadata_json: string;
  text: string;
  body_truncated: number;
}

export interface MissionSnapshotMatchRow {
  mission_id: string;
  story_id: string;
  match_score: number;
  matched_terms_json: string;
  first_matched_at: string;
  last_matched_at: string;
  title: string;
  summary: string;
  score: number;
  last_changed_at: string;
  source_count: number;
  confidence: number;
}

export interface MissionMatchSnapshot {
  matches: MissionSnapshotMatchRow[];
  firstSeenAtByStory: ReadonlyMap<string, string>;
  evidenceByStory: ReadonlyMap<string, MissionSnapshotEvidenceRow[]>;
  evidence: MissionSnapshotEvidenceRow[];
  identity: {
    matchedStoriesAvailable: number;
    lastMatchedAt: string | null;
    latestStoryChangedAt: string | null;
  };
  coverage: {
    matchLimit: number;
    matchedStoriesIncluded: number;
    matchedStoriesAvailable: number;
    matchedStoriesOmitted: number;
    hasMoreMatchedStories: boolean;
    evidencePerStoryLimit: number;
    evidenceItemLimit: number;
    evidenceItemsIncluded: number;
    matchedStoriesWithEvidenceIncluded: number;
    matchedStoriesWithAdditionalEvidence: number;
    hasMoreEvidence: boolean;
    evidenceSelection: "breadth-first";
    evidenceCandidateRowsPerStoryLimit: number;
    evidenceExcerptCharacters: number;
    excerptedEvidenceItems: number;
  };
}

interface MissionMatchSnapshotOptions {
  matchLimit?: number;
  evidencePerStoryLimit?: number;
  evidenceItemLimit?: number;
  evidenceExcerptCharacters?: number;
}

function rows<T>(result: D1Result<T>): T[] {
  return result.results ?? [];
}

/**
 * Load the matched-Story snapshot with a fixed number of D1 statements.
 * Evidence selection is breadth-first across matched Stories, deduplicated by
 * item, and clipped before it crosses into the Worker. The final rows retain
 * Story-major presentation order. Extra match and evidence rows are coverage
 * sentinels only.
 */
export async function loadMissionMatchSnapshot(
  db: D1Database,
  missionId: string,
  options: MissionMatchSnapshotOptions = {},
): Promise<MissionMatchSnapshot> {
  const matchLimit = Math.max(1, Math.min(MISSION_SNAPSHOT_MATCH_LIMIT, Math.floor(
    options.matchLimit ?? MISSION_SNAPSHOT_MATCH_LIMIT,
  )));
  const evidencePerStoryLimit = Math.max(1, Math.min(
    MISSION_SNAPSHOT_EVIDENCE_PER_STORY_LIMIT,
    Math.floor(options.evidencePerStoryLimit ?? MISSION_SNAPSHOT_EVIDENCE_PER_STORY_LIMIT),
  ));
  const evidenceItemLimit = Math.max(1, Math.min(
    MISSION_SNAPSHOT_EVIDENCE_LIMIT,
    Math.floor(options.evidenceItemLimit ?? MISSION_SNAPSHOT_EVIDENCE_LIMIT),
  ));
  const evidenceExcerptCharacters = Math.max(1, Math.min(
    MISSION_SNAPSHOT_EVIDENCE_TEXT_CHARACTERS,
    Math.floor(options.evidenceExcerptCharacters ?? MISSION_SNAPSHOT_EVIDENCE_TEXT_CHARACTERS),
  ));

  const matchesWithSentinel = rows(await db.prepare(
    `SELECT substr(matched.mission_id, 1, 128) AS mission_id,
            substr(matched.story_id, 1, 128) AS story_id, matched.match_score,
            COALESCE((
              SELECT json_group_array(term)
              FROM (
                SELECT substr(CAST(value AS TEXT), 1, ?) AS term
                FROM json_each(CASE WHEN json_valid(matched.matched_terms_json)
                  THEN matched.matched_terms_json ELSE '[]' END)
                WHERE type = 'text'
                LIMIT ?
              )
            ), '[]') AS matched_terms_json,
            matched.first_matched_at, matched.last_matched_at,
            substr(story.title, 1, ?) AS title,
            substr(story.summary, 1, ?) AS summary,
            story.score, story.last_changed_at, story.source_count, story.confidence
     FROM mission_story_matches matched
     JOIN stories story ON story.id = matched.story_id
     WHERE matched.mission_id = ?
     ORDER BY matched.last_matched_at DESC, matched.match_score DESC, story.score DESC, story.id ASC
     LIMIT ?`,
  ).bind(
    MISSION_SNAPSHOT_MATCH_TERM_CHARACTERS,
    MISSION_SNAPSHOT_MATCH_TERM_LIMIT,
    MISSION_SNAPSHOT_STORY_TITLE_CHARACTERS,
    MISSION_SNAPSHOT_STORY_SUMMARY_CHARACTERS,
    missionId,
    matchLimit + 1,
  ).all<MissionSnapshotMatchRow>());
  const matches = matchesWithSentinel.slice(0, matchLimit);
  const storyIds = matches
    .map((match) => String(match.story_id ?? ""))
    .filter(Boolean);
  if (!storyIds.length) {
    return {
      matches,
      firstSeenAtByStory: new Map(),
      evidenceByStory: new Map(),
      evidence: [],
      identity: {
        matchedStoriesAvailable: 0,
        lastMatchedAt: null,
        latestStoryChangedAt: null,
      },
      coverage: {
        matchLimit,
        matchedStoriesIncluded: matches.length,
        matchedStoriesAvailable: matches.length,
        matchedStoriesOmitted: 0,
        hasMoreMatchedStories: matchesWithSentinel.length > matchLimit,
        evidencePerStoryLimit,
        evidenceItemLimit,
        evidenceItemsIncluded: 0,
        matchedStoriesWithEvidenceIncluded: 0,
        matchedStoriesWithAdditionalEvidence: 0,
        hasMoreEvidence: false,
        evidenceSelection: "breadth-first",
        evidenceCandidateRowsPerStoryLimit: evidencePerStoryLimit + 1,
        evidenceExcerptCharacters,
        excerptedEvidenceItems: 0,
      },
    };
  }

  const storyIdsJson = JSON.stringify(storyIds);
  const candidateRowBudget = MISSION_SNAPSHOT_EVIDENCE_CANDIDATE_ROW_LIMIT;
  let evidenceCandidateRowsPerStoryLimit = Math.min(
    MISSION_SNAPSHOT_EVIDENCE_CANDIDATE_PER_STORY_LIMIT,
    evidenceItemLimit + 1,
  );
  type EvidenceCandidateRow = { story_id: string; story_order: number; item_id: string };
  const loadEvidenceCandidates = async (
    requestedStoryIds: string[],
    perStoryLimit: number,
  ): Promise<EvidenceCandidateRow[]> => rows(await db
    .prepare(
      `WITH requested(story_id, story_order) AS (
         SELECT CAST(value AS TEXT), CAST(key AS INTEGER) FROM json_each(?)
       )
       SELECT requested.story_id, requested.story_order, link.item_id
       FROM requested
       JOIN story_items link
         ON link.story_id = requested.story_id
        AND link.item_id IN (
          SELECT recent.item_id
          FROM story_items recent INDEXED BY idx_story_items_match_recent
          WHERE recent.story_id = requested.story_id
          ORDER BY recent.created_at DESC, recent.item_id ASC
          LIMIT ?
        )
       ORDER BY requested.story_order ASC, link.created_at DESC, link.item_id ASC
       LIMIT ?`,
    )
    .bind(JSON.stringify(requestedStoryIds), perStoryLimit, candidateRowBudget)
    .all<EvidenceCandidateRow>());
  const [storyRows, initialCandidateRows] = await Promise.all([
    db
      .prepare(
        `WITH requested(story_id, story_order) AS (
           SELECT CAST(value AS TEXT), CAST(key AS INTEGER) FROM json_each(?)
         )
         SELECT story.id, story.first_seen_at,
                (SELECT COUNT(*) FROM mission_story_matches counted WHERE counted.mission_id = ?) AS total_matched_stories,
                (SELECT MAX(recent.last_matched_at)
                 FROM mission_story_matches recent
                 WHERE recent.mission_id = ?) AS last_matched_at,
                (SELECT MAX(changed.last_changed_at)
                 FROM mission_story_matches matched_story
                 JOIN stories changed ON changed.id = matched_story.story_id
                 WHERE matched_story.mission_id = ?) AS latest_story_changed_at
         FROM requested
         JOIN stories story ON story.id = requested.story_id
         ORDER BY requested.story_order ASC`,
      )
      .bind(storyIdsJson, missionId, missionId, missionId)
      .all<{
        id: string;
        first_seen_at: string;
        total_matched_stories: number;
        last_matched_at: string | null;
        latest_story_changed_at: string | null;
      }>(),
    loadEvidenceCandidates(storyIds, evidenceCandidateRowsPerStoryLimit),
  ]);

  const firstSeenAtByStory = new Map(
    rows(storyRows).map((story) => [story.id, story.first_seen_at] as const),
  );
  const candidatesByStory = new Map<
    string,
    EvidenceCandidateRow[]
  >();
  const candidateKeys = new Set<string>();
  const addCandidate = (candidate: EvidenceCandidateRow) => {
    const candidateKey = `${candidate.story_id}\u0000${candidate.item_id}`;
    if (candidateKeys.has(candidateKey)) return;
    candidateKeys.add(candidateKey);
    const group = candidatesByStory.get(candidate.story_id) ?? [];
    group.push(candidate);
    candidatesByStory.set(candidate.story_id, group);
  };
  for (const candidate of initialCandidateRows) addCandidate(candidate);

  // If sparse Stories leave global slots unused, only the Stories that filled
  // the first bounded page can have more rows. One small follow-up lets those
  // Stories donate unused capacity without making the dense 32-Story path scan
  // more than 288 link rows.
  const initialUniqueItemCount = new Set(initialCandidateRows.map((candidate) => candidate.item_id)).size;
  if (initialUniqueItemCount < evidenceItemLimit + 1) {
    const overflowStoryIds = storyIds.filter(
      (storyId) => (candidatesByStory.get(storyId)?.length ?? 0) >= evidenceCandidateRowsPerStoryLimit,
    );
    if (overflowStoryIds.length) {
      evidenceCandidateRowsPerStoryLimit = Math.min(
        MISSION_SNAPSHOT_EVIDENCE_OVERFLOW_PER_STORY_LIMIT,
        evidenceItemLimit + 1,
      );
      const overflowCandidates = await loadEvidenceCandidates(
        overflowStoryIds,
        evidenceCandidateRowsPerStoryLimit,
      );
      for (const candidate of overflowCandidates) addCandidate(candidate);
    }
  }
  const uniqueCandidates: Array<{ storyId: string; storyOrder: number; itemId: string; evidenceRank: number }> = [];
  const seenItemIds = new Set<string>();
  const addEvidenceRank = (evidenceRank: number) => {
    for (let storyOrder = 0; storyOrder < storyIds.length; storyOrder += 1) {
      const storyId = storyIds[storyOrder];
      if (!storyId) continue;
      const candidate = candidatesByStory.get(storyId)?.[evidenceRank];
      if (!candidate || seenItemIds.has(candidate.item_id)) continue;
      seenItemIds.add(candidate.item_id);
      uniqueCandidates.push({
        storyId: candidate.story_id,
        storyOrder,
        itemId: candidate.item_id,
        evidenceRank,
      });
    }
  };
  for (let evidenceRank = 0; evidenceRank < evidencePerStoryLimit; evidenceRank += 1) {
    addEvidenceRank(evidenceRank);
  }
  for (
    let evidenceRank = evidencePerStoryLimit;
    evidenceRank < evidenceCandidateRowsPerStoryLimit && uniqueCandidates.length <= evidenceItemLimit;
    evidenceRank += 1
  ) {
    addEvidenceRank(evidenceRank);
  }
  const selectedCandidates = uniqueCandidates.slice(0, evidenceItemLimit);
  const selectedEvidenceCountByStory = new Map<string, number>();
  for (const selected of selectedCandidates) {
    selectedEvidenceCountByStory.set(
      selected.storyId,
      (selectedEvidenceCountByStory.get(selected.storyId) ?? 0) + 1,
    );
  }
  const matchedStoriesWithAdditionalEvidence = [...candidatesByStory]
    .filter(([storyId, group]) => group.length > (selectedEvidenceCountByStory.get(storyId) ?? 0))
    .length;
  const selectedJson = JSON.stringify(selectedCandidates);
  const evidence = selectedCandidates.length
    ? await db
      .prepare(
        `WITH selected(story_id, story_order, item_id, evidence_rank) AS (
           SELECT json_extract(value, '$.storyId'),
                  CAST(json_extract(value, '$.storyOrder') AS INTEGER),
                  json_extract(value, '$.itemId'),
                  CAST(json_extract(value, '$.evidenceRank') AS INTEGER)
           FROM json_each(?)
         )
         SELECT selected.story_id, selected.item_id, item.source_id,
                substr(source.name, 1, ?) AS source_name,
                substr(source.kind, 1, ?) AS source_kind,
                substr(item.title, 1, ?) AS title,
                substr(item.url, 1, ?) AS url,
                substr(item.author, 1, ?) AS author,
                item.published_at, item.observed_at, item.access_class,
                CASE WHEN json_valid(item.metadata_json) THEN json_object(
                  'provider', CASE WHEN json_type(item.metadata_json, '$.provider') = 'text'
                    THEN substr(json_extract(item.metadata_json, '$.provider'), 1, ?) END,
                  'sourceKind', CASE WHEN json_type(item.metadata_json, '$.sourceKind') = 'text'
                    THEN substr(json_extract(item.metadata_json, '$.sourceKind'), 1, ?) END,
                  'platform', CASE WHEN json_type(item.metadata_json, '$.platform') = 'text'
                    THEN substr(json_extract(item.metadata_json, '$.platform'), 1, ?) END,
                  'repo', CASE WHEN json_type(item.metadata_json, '$.repo') = 'text'
                    THEN substr(json_extract(item.metadata_json, '$.repo'), 1, ?) END,
                  'version', CASE WHEN json_type(item.metadata_json, '$.version') = 'text'
                    THEN substr(json_extract(item.metadata_json, '$.version'), 1, ?) END
                ) ELSE '{}' END AS metadata_json,
                substr(item.text, 1, ?) AS text,
                CASE WHEN substr(item.text, ? + 1, 1) <> '' THEN 1 ELSE 0 END AS body_truncated
         FROM selected
         JOIN items item ON item.id = selected.item_id
         JOIN sources source ON source.id = item.source_id
         ORDER BY selected.story_order ASC, selected.evidence_rank ASC`,
      )
      .bind(
        selectedJson,
        MISSION_SNAPSHOT_EVIDENCE_FIELD_CHARACTERS,
        MISSION_SNAPSHOT_EVIDENCE_FIELD_CHARACTERS,
        MISSION_SNAPSHOT_EVIDENCE_TITLE_CHARACTERS,
        MISSION_SNAPSHOT_EVIDENCE_URL_CHARACTERS,
        MISSION_SNAPSHOT_EVIDENCE_FIELD_CHARACTERS,
        MISSION_SNAPSHOT_EVIDENCE_FIELD_CHARACTERS,
        MISSION_SNAPSHOT_EVIDENCE_FIELD_CHARACTERS,
        MISSION_SNAPSHOT_EVIDENCE_FIELD_CHARACTERS,
        MISSION_SNAPSHOT_EVIDENCE_FIELD_CHARACTERS,
        MISSION_SNAPSHOT_EVIDENCE_FIELD_CHARACTERS,
        evidenceExcerptCharacters,
        evidenceExcerptCharacters,
      )
      .all<MissionSnapshotEvidenceRow>()
      .then(rows)
    : [];
  const evidenceByStory = new Map<string, MissionSnapshotEvidenceRow[]>();
  for (const item of evidence) {
    const group = evidenceByStory.get(item.story_id) ?? [];
    group.push(item);
    evidenceByStory.set(item.story_id, group);
  }
  const matchedStoriesAvailable = Math.max(
    matches.length,
    Number(rows(storyRows)[0]?.total_matched_stories ?? matchesWithSentinel.length),
  );
  const identityRow = rows(storyRows)[0];

  return {
    matches,
    firstSeenAtByStory,
    evidenceByStory,
    evidence,
    identity: {
      matchedStoriesAvailable,
      lastMatchedAt: identityRow?.last_matched_at ?? null,
      latestStoryChangedAt: identityRow?.latest_story_changed_at ?? null,
    },
    coverage: {
      matchLimit,
      matchedStoriesIncluded: matches.length,
      matchedStoriesAvailable,
      matchedStoriesOmitted: Math.max(0, matchedStoriesAvailable - matches.length),
      hasMoreMatchedStories: matchedStoriesAvailable > matches.length,
      evidencePerStoryLimit,
      evidenceItemLimit,
      evidenceItemsIncluded: evidence.length,
      matchedStoriesWithEvidenceIncluded: evidenceByStory.size,
      matchedStoriesWithAdditionalEvidence,
      hasMoreEvidence: matchedStoriesWithAdditionalEvidence > 0,
      evidenceSelection: "breadth-first",
      evidenceCandidateRowsPerStoryLimit,
      evidenceExcerptCharacters,
      excerptedEvidenceItems: evidence.reduce(
        (count, item) => count + (Number(item.body_truncated) > 0 ? 1 : 0),
        0,
      ),
    },
  };
}
