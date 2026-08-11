import assert from "node:assert/strict";
import test from "node:test";

const { selectTodayStories } = await import("../.test-dist/story-curation.js");

const periodStart = "2026-08-08T00:00:00.000Z";

function candidate(id, overrides = {}) {
  const story = {
    id,
    title: id,
    summary: `${id} summary`,
    score: 60,
    relevance: 0.7,
    novelty: 1,
    importance: 0.7,
    confidence: 0.8,
    sourceCount: 1,
    changedAt: "2026-08-08T10:00:00.000Z",
    change: {
      kind: "new",
      scoreDelta: 1,
      sourceCountDelta: 1,
      newEvidenceCount: 1,
    },
    evidence: [],
    ...(overrides.story ?? {}),
  };
  return {
    story,
    missionIds: [],
    missionMatchScore: 0,
    sourceKeys: [id],
    providerKeys: [id],
    seriesKeys: [],
    newestPublishedAt: "2026-08-08T09:00:00.000Z",
    newestObservedAt: "2026-08-08T10:00:00.000Z",
    monitorSnapshot: false,
    independentFamilies: 0,
    ...overrides,
    story,
  };
}

test("Today keeps current Mission evidence diverse and files old release history", () => {
  const oldMissionRelease = candidate("old-mission-release", {
    missionIds: ["mission-a"],
    missionMatchScore: 0.9,
    sourceKeys: ["github-releases"],
    providerKeys: ["github_releases"],
    seriesKeys: ["github:example/mono"],
    newestPublishedAt: "2026-07-01T09:00:00.000Z",
  });
  const currentMissionStory = candidate("current-mission-story", {
    missionIds: ["mission-a"],
    missionMatchScore: 0.7,
    sourceKeys: ["public-feed"],
    providerKeys: ["web_feed"],
  });
  const releaseOne = candidate("release-one", {
    sourceKeys: ["github-releases"],
    providerKeys: ["github_releases"],
    seriesKeys: ["github:example/mono"],
  });
  const releaseTwo = candidate("release-two", {
    sourceKeys: ["github-releases"],
    providerKeys: ["github_releases"],
    seriesKeys: ["github:example/mono"],
    story: { score: 59 },
  });
  const independentlySupported = candidate("independent-reporting", {
    newestPublishedAt: "2026-07-01T09:00:00.000Z",
    independentFamilies: 2,
  });

  const result = selectTodayStories([
    oldMissionRelease,
    currentMissionStory,
    releaseOne,
    releaseTwo,
    independentlySupported,
  ], { limit: 8, periodStart });

  assert.deepEqual(result.selectedIds, [
    "current-mission-story",
    "independent-reporting",
    "release-one",
  ]);
  assert.equal(result.filedCount, 2);
});

test("Today is allowed to be quiet when only an unchanged baseline and old releases exist", () => {
  const result = selectTodayStories([
    candidate("old-release", {
      seriesKeys: ["npm:example"],
      newestPublishedAt: "2026-06-01T09:00:00.000Z",
    }),
    candidate("first-monitor-baseline", {
      monitorSnapshot: true,
      newestPublishedAt: undefined,
    }),
  ], { limit: 6, periodStart });

  assert.deepEqual(result.selectedIds, []);
  assert.equal(result.filedCount, 2);
});

test("a fresh monitor baseline can orient a standing Mission without filling an unlinked Today", () => {
  const result = selectTodayStories([
    candidate("mission-monitor", {
      missionIds: ["mission-a"],
      missionMatchScore: 0.8,
      monitorSnapshot: true,
      newestPublishedAt: undefined,
    }),
    candidate("unlinked-monitor", {
      monitorSnapshot: true,
      newestPublishedAt: undefined,
    }),
  ], { limit: 6, periodStart });

  assert.deepEqual(result.selectedIds, ["mission-monitor"]);
});
