import type { BriefingPacket } from "./types";
import { plainTextExcerpt } from "./utils";

type BriefingEvidenceSequence = readonly [findMission: string, getMission: string, fetchStory: string];

const DEFAULT_EVIDENCE_SEQUENCE: BriefingEvidenceSequence = ["find_missions", "get_mission", "fetch"];

export function briefingInterfacePayload(
  packet: BriefingPacket,
  requiredNextTools: BriefingEvidenceSequence = DEFAULT_EVIDENCE_SEQUENCE,
) {
  const materialStories = packet.stories.filter((story) =>
    story.change.kind !== "recurring" || story.change.newEvidenceCount > 0
  );
  const attentionActions = packet.actions.filter((action) => action.severity !== "info");
  const actions = (attentionActions.length ? attentionActions : packet.actions).slice(0, 4);
  const [findMission, getMission, fetchStory] = requiredNextTools;
  return {
    answerHandoff: {
      answerReady: false as const,
      citableEvidenceIncluded: false as const,
      requiredNextTools: [fetchStory],
      fallbackNextTools: [...requiredNextTools],
      instruction: `If the requested Mission appears in missions and its nextTool.ids is not empty, call ${fetchStory} once for each relevant ID before answering. Use ${findMission} then ${getMission} only when the Mission is absent or needs more candidates. Use only public URLs returned by ${fetchStory}; never invent or infer source paths.`,
    },
    generatedAt: packet.generatedAt,
    previousBriefingAt: packet.previousBriefingAt,
    coverage: {
      healthySources: packet.coverage.healthySources,
      degradedSources: packet.coverage.degradedSources,
      offlineCollectors: packet.coverage.offlineCollectors,
    },
    actions: actions.map((action) => ({
      id: action.id,
      kind: action.kind,
      severity: action.severity,
      missionId: action.missionId,
      title: action.title,
      detail: action.detail,
      dueAt: action.dueAt,
    })),
    missions: packet.missions.slice(0, 6).map((mission) => {
      const storyCandidates = mission.matches
        .filter((match) => Boolean(match.storyId))
        .slice(0, 3)
        .map((match) => ({
          id: match.storyId,
          title: plainTextExcerpt(match.title, 180),
          changedAt: match.changedAt,
        }));
      return {
        id: mission.id,
        name: plainTextExcerpt(mission.name, 140),
        question: plainTextExcerpt(mission.question, 280),
        matchCount: mission.matches.length,
        sprintPolicy: mission.sprintPolicy,
        nextSprintAt: mission.nextSprintAt,
        expectedEventStatus: mission.expectedEventStatus,
        storyCandidates,
        nextTool: {
          name: fetchStory,
          ids: storyCandidates.map((story) => story.id),
        },
      };
    }),
    resolvedMissions: packet.resolvedMissions.slice(0, 4).map((mission) => ({
      id: mission.id,
      name: plainTextExcerpt(mission.name, 140),
      outcomeStatus: mission.outcomeStatus,
      outcomeSummary: plainTextExcerpt(mission.outcomeSummary, 320),
      resolvedAt: mission.resolvedAt,
    })),
    stories: materialStories.slice(0, 6).map((story) => ({
      id: story.id,
      title: plainTextExcerpt(story.title, 180),
      summary: plainTextExcerpt(story.summary, 420),
      sourceCount: story.sourceCount,
      changeKind: story.change.kind,
      newEvidenceCount: story.change.newEvidenceCount,
    })),
  };
}

export function briefingInterfaceText(payload: ReturnType<typeof briefingInterfacePayload>): string {
  const [fetchStory] = payload.answerHandoff.requiredNextTools;
  const [findMission, getMission] = payload.answerHandoff.fallbackNextTools;
  const lines = [
    `Today is orientation, not source evidence. This result is not answer-ready and contains no citable evidence. For a Mission listed here, call ${fetchStory} once for each relevant ID in its nextTool before answering; use ${findMission} then ${getMission} only when the Mission is absent or needs more candidates, and use only public URLs returned by ${fetchStory}.`,
    "",
    payload.stories.length
      ? "Driftglass found these material changes for orientation. Continue through the required tools before answering."
      : "No Story has a new material delta. A quiet result is valid; do not fill it with recurring items.",
  ];
  if (payload.actions.length) {
    lines.push("", "Needs your attention:", ...payload.actions.map((action) => `- ${plainTextExcerpt(action.title, 160)}: ${plainTextExcerpt(action.detail, 280)}`));
  }
  if (payload.stories.length) {
    lines.push("", "Material changes:", ...payload.stories.map((story) => `- ${story.title}: ${story.summary || "Open the Story and inspect its evidence."}`));
  }
  if (payload.missions.length) {
    lines.push("", "Standing questions:", ...payload.missions.map((mission) => `- ${mission.name}: ${mission.question}`));
  }
  return lines.join("\n");
}
