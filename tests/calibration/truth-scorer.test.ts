import { beforeAll, describe, expect, it } from "vitest";

import { FULL_DECK, suitOf } from "../../src/domain/cards";
import {
  activeTimelineEvents,
  replayTimeline,
  type GameTimeline,
} from "../../src/events/timeline";
import { buildBehaviorBelief } from "../../src/inference/behavior-belief";
import { buildHardBelief } from "../../src/inference/belief";
import {
  generateCalibrationPredictions,
  type CalibrationCheckpointMetadata,
} from "../../src/calibration/predictions";
import { scoreCalibrationPredictions } from "../../src/calibration/truth-scorer";
import { terminalClusterId } from "../../src/calibration/types";
import {
  legalExactHandCards,
  type ExactHandState,
} from "../../src/rules/exact-hand-transition";
import {
  hiddenOpponentTakeTimeline,
  play,
  setupWithUserHand,
  startingHand,
  timelineFrom,
} from "../inference/test-fixtures";

function leadHeartTimeline(heartsOwnedByUser: number): GameTimeline {
  const hearts = FULL_DECK.filter((card) => suitOf(card) === "hearts").slice(
    0,
    heartsOwnedByUser,
  );
  const userHand = startingHand(
    [...hearts, "AS"],
    [
      "KS",
      "QS",
      ...FULL_DECK.filter((card) => suitOf(card) === "hearts").slice(
        heartsOwnedByUser,
      ),
    ],
    18,
  );
  return timelineFrom(setupWithUserHand(userHand), [
    play("user", "AS"),
    play("p2", "KS"),
    play("p3", "QS"),
    play("user", "2H"),
  ]);
}

function checkpoint(
  timeline: GameTimeline,
  gameId = "game-truth-1",
): CalibrationCheckpointMetadata {
  const state = replayTimeline(timeline).state;
  return {
    runId: "phase6-truth-test",
    split: "dev",
    evidenceClass: "phase6-test",
    gameId,
    scenarioId: "dev/c01/0/0",
    calibrationClusterId: "dev/c01/0",
    checkpointId: "before-opponent-action",
    checkpointEventIndex: activeTimelineEvents(timeline).length,
    checkpointTiming: "pre-action",
    stateVersion: state.appliedEventCount,
    featureBundleHash: "feature-bundle-test",
    queryPlanHash: "query-plan-test",
    seedId: "belief-seed-test",
  };
}

function buildFixture(
  timeline: GameTimeline,
  seed: string,
  sampleCount = 24,
  gameId = "game-truth-1",
) {
  const hardBelief = buildHardBelief(timeline, {
    seed,
    sampleCount,
    forceSampling: true,
  });
  const behaviorBelief = buildBehaviorBelief(timeline, hardBelief);
  const records = generateCalibrationPredictions({
    timeline,
    hardBelief,
    behaviorBelief,
    checkpoint: checkpoint(timeline, gameId),
    config: { conditionalProbabilityFloor: 0.05 },
  });
  return {
    timeline,
    state: replayTimeline(timeline).state,
    hardBelief,
    behaviorBelief,
    records,
  };
}

function exactState(
  fixture: ReturnType<typeof buildFixture>,
  worldIndex = 0,
): ExactHandState {
  const world = fixture.hardBelief.worlds[worldIndex];
  if (world === undefined) {
    throw new Error("Fixture is missing the requested exact world.");
  }
  return {
    publicState: fixture.state,
    hands: {
      user: [...world.currentHands.user],
      p2: [...world.currentHands.p2],
      p3: [...world.currentHands.p3],
    },
  };
}

function firstLegalPlay(
  state: ExactHandState,
): Extract<
  Parameters<typeof scoreCalibrationPredictions>[0]["actualNextEvent"],
  { type: "card-played" }
> {
  const actor = state.publicState.turn;
  if (actor !== "p2" && actor !== "p3") {
    throw new Error("Truth fixture must be at an opponent turn.");
  }
  const card = legalExactHandCards(state, actor)[0];
  if (card === undefined) {
    throw new Error("Truth fixture actor has no legal card.");
  }
  return { type: "card-played", schemaVersion: 1, seat: actor, card };
}

type Fixture = ReturnType<typeof buildFixture>;
let fixture: Fixture;

beforeAll(() => {
  fixture = buildFixture(leadHeartTimeline(13), "truth-scoring-main");
});

describe("eval-only truth join and generic scoring", () => {
  it("joins every pair after generation and produces two scored observations per pair", () => {
    const state = exactState(fixture);
    const result = scoreCalibrationPredictions({
      predictions: fixture.records,
      exactState: state,
      actualNextEvent: firstLegalPlay(state),
      trueOpponentModels: {
        p2: "always-high",
        p3: "always-low",
      },
      terminalClusterId: terminalClusterId("dev", 0),
    });
    const pairCount = new Set(fixture.records.map((record) => record.pairId))
      .size;

    expect(result.truthRecords).toHaveLength(pairCount);
    expect(result.scoredObservations).toHaveLength(pairCount * 2);
    expect(result.skippedConditionalPairIds).toEqual([]);
    expect(
      result.truthRecords.every(
        (truth) => truth.scoreStatus === "scored" && truth.targetLabel !== null,
      ),
    ).toBe(true);

    const actionTruth = result.truthRecords.find((truth) => {
      const pair = fixture.records.find(
        (record) => record.pairId === truth.pairId,
      );
      return pair?.target.kind === "opponent-action";
    });
    expect(actionTruth?.targetLabel).toMatch(/^play:/u);
    expect(actionTruth).toMatchObject({
      forcedAction: false,
      scoreStatus: "scored",
    });
    expect(
      result.scoredObservations.filter(
        (observation) => observation.kind === "action",
      ),
    ).toHaveLength(2);
  });

  it("preserves every hard-known truth at probability one", () => {
    const state = exactState(fixture);
    const result = scoreCalibrationPredictions({
      predictions: fixture.records,
      exactState: state,
      actualNextEvent: firstLegalPlay(state),
      trueOpponentModels: { p2: "random", p3: "random" },
      terminalClusterId: terminalClusterId("dev", 0),
    });
    const truthByPair = new Map(
      result.truthRecords.map((truth) => [truth.pairId, truth]),
    );
    const hardKnown = fixture.records.filter((record) => record.hardKnown);
    expect(hardKnown.length).toBeGreaterThan(0);
    for (const prediction of hardKnown) {
      const truth = truthByPair.get(prediction.pairId);
      expect(truth?.scoreStatus).toBe("scored");
      expect(
        prediction.distribution.find(
          (entry) => entry.label === truth?.targetLabel,
        )?.probability,
      ).toBe(1);
    }
  });

  it("scores a hard-possible legal action omitted by finite sampling at raw zero support", () => {
    const timeline = leadHeartTimeline(13);
    const sampled = buildFixture(timeline, "finite-action-sample", 1);
    const alternatives = buildFixture(
      timeline,
      "finite-action-alternative-truths",
      64,
    );
    const hardAction = sampled.records.find(
      (record) =>
        record.arm === "hard-only" && record.target.kind === "opponent-action",
    );
    if (hardAction === undefined) {
      throw new Error("Finite-sample fixture has no hard action prediction.");
    }
    const positiveLabels = new Set(
      hardAction.distribution
        .filter((entry) => entry.probability > 0)
        .map((entry) => entry.label),
    );
    let selected:
      | {
          readonly exact: ExactHandState;
          readonly card: ReturnType<typeof legalExactHandCards>[number];
        }
      | undefined;
    for (
      let index = 0;
      index < alternatives.hardBelief.worlds.length;
      index += 1
    ) {
      const exact = exactState(alternatives, index);
      const actor = exact.publicState.turn;
      if (actor !== "p2" && actor !== "p3") {
        continue;
      }
      const card = legalExactHandCards(exact, actor).find(
        (candidate) => !positiveLabels.has(`play:${candidate}`),
      );
      if (card !== undefined) {
        selected = { exact, card };
        break;
      }
    }
    if (selected === undefined) {
      throw new Error("Could not find an omitted hard-possible legal action.");
    }
    expect(
      hardAction.distribution.find(
        (entry) => entry.label === `play:${selected.card}`,
      ),
    ).toEqual({
      label: `play:${selected.card}`,
      probability: 0,
    });
    const actor = selected.exact.publicState.turn;
    if (actor !== "p2" && actor !== "p3") {
      throw new Error("Selected truth lost its opponent actor.");
    }
    const scored = scoreCalibrationPredictions({
      predictions: sampled.records,
      exactState: selected.exact,
      actualNextEvent: {
        type: "card-played",
        schemaVersion: 1,
        seat: actor,
        card: selected.card,
      },
      trueOpponentModels: { p2: "random", p3: "random" },
      terminalClusterId: terminalClusterId("dev", 0),
    });
    const actionScores = scored.scoredObservations.filter(
      (observation) => observation.kind === "action",
    );
    expect(actionScores).toHaveLength(2);
    expect(
      actionScores.every((observation) => observation.rawZeroSupport),
    ).toBe(true);
  });

  it("rejects mismatched pair state and post-generation truth fields", () => {
    const state = exactState(fixture);
    const behavioralIndex = fixture.records.findIndex(
      (record) => record.arm === "behavioral",
    );
    const mismatched = fixture.records.map((record, index) =>
      index === behavioralIndex
        ? { ...record, stateId: "other-state" }
        : record,
    );
    expect(() =>
      scoreCalibrationPredictions({
        predictions: mismatched,
        exactState: state,
        actualNextEvent: firstLegalPlay(state),
        trueOpponentModels: { p2: "random", p3: "random" },
        terminalClusterId: terminalClusterId("dev", 0),
      }),
    ).toThrow(/paired records disagree on stateId/u);

    expect(() =>
      scoreCalibrationPredictions({
        predictions: fixture.records.map((record, index) =>
          index === 0 ? { ...record, targetLabel: "leaked-truth" } : record,
        ),
        exactState: state,
        actualNextEvent: firstLegalPlay(state),
        trueOpponentModels: { p2: "random", p3: "random" },
        terminalClusterId: terminalClusterId("dev", 0),
      }),
    ).toThrow();
  });
});

describe("forced and take-hand truth classification", () => {
  it("classifies a public forced opening as a singleton action", () => {
    const userHand = startingHand(["2H"], ["AS"], 18);
    const timeline = timelineFrom(
      setupWithUserHand(userHand, undefined, "p2"),
      [],
    );
    const forced = buildFixture(
      timeline,
      "forced-opening-truth",
      12,
      "game-forced",
    );
    const state = exactState(forced);
    const result = scoreCalibrationPredictions({
      predictions: forced.records,
      exactState: state,
      actualNextEvent: {
        type: "card-played",
        schemaVersion: 1,
        seat: "p2",
        card: "AS",
      },
      trueOpponentModels: { p2: "always-high", p3: "always-low" },
      terminalClusterId: terminalClusterId("dev", 1),
    });
    const actionPredictions = forced.records.filter(
      (record) => record.target.kind === "opponent-action",
    );
    expect(actionPredictions).toHaveLength(2);
    for (const prediction of actionPredictions) {
      expect(prediction.hardKnown).toBe(true);
      expect(prediction.distribution).toEqual([
        { label: "play:AS", probability: 1 },
      ]);
    }
    const actionTruth = result.truthRecords.find(
      (truth) =>
        forced.records.find((record) => record.pairId === truth.pairId)?.target
          .kind === "opponent-action",
    );
    expect(actionTruth).toMatchObject({
      scoreStatus: "scored",
      targetLabel: "play:AS",
      forcedAction: true,
    });
    expect(
      result.scoredObservations.filter(
        (observation) => observation.kind === "action",
      ),
    ).toEqual([
      expect.objectContaining({ decisionClass: "forced" }),
      expect.objectContaining({ decisionClass: "forced" }),
    ]);
  });

  it("scores a legal take target alongside card alternatives as discretionary", () => {
    const complete = hiddenOpponentTakeTimeline();
    const actualNextEvent = complete.events[complete.cursor - 1];
    if (actualNextEvent?.type !== "hand-taken") {
      throw new Error("Take fixture does not end in hand-taken.");
    }
    const prefix: GameTimeline = {
      ...complete,
      cursor: complete.cursor - 1,
    };
    const take = buildFixture(prefix, "take-truth-scoring", 12, "game-take");
    const result = scoreCalibrationPredictions({
      predictions: take.records,
      exactState: exactState(take),
      actualNextEvent,
      trueOpponentModels: { p2: "documented-basic", p3: "always-low" },
      terminalClusterId: terminalClusterId("dev", 2),
    });
    const truth = result.truthRecords.find(
      (candidate) => candidate.targetLabel === "take:p3",
    );
    expect(truth).toMatchObject({
      scoreStatus: "scored",
      targetLabel: "take:p3",
      forcedAction: false,
    });
  });
});

describe("conditional truth status and artifact pairing", () => {
  it("retains conditioning-false truth rows but omits their proper-score observations", () => {
    const partial = buildFixture(
      leadHeartTimeline(11),
      "partial-heart-condition",
      96,
      "game-partial-condition",
    );
    const conditionalRecords = partial.records.filter(
      (record) => record.target.family === "conditional",
    );
    expect(conditionalRecords).toHaveLength(2);
    const falseConditionWorld = partial.hardBelief.worlds.findIndex((world) =>
      world.currentHands.p3.some((card) => suitOf(card) === "hearts"),
    );
    expect(falseConditionWorld).toBeGreaterThanOrEqual(0);
    const state = exactState(partial, falseConditionWorld);
    const result = scoreCalibrationPredictions({
      predictions: partial.records,
      exactState: state,
      actualNextEvent: firstLegalPlay(state),
      trueOpponentModels: { p2: "always-high", p3: "always-low" },
      terminalClusterId: terminalClusterId("dev", 3),
    });
    const conditionalPairId = conditionalRecords[0]?.pairId;
    expect(result.skippedConditionalPairIds).toEqual([conditionalPairId]);
    expect(
      result.truthRecords.find((truth) => truth.pairId === conditionalPairId),
    ).toMatchObject({
      scoreStatus: "conditioning-false",
      targetLabel: null,
      forcedAction: null,
    });
    expect(
      result.scoredObservations.some(
        (observation) =>
          partial.records.find(
            (record) => record.predictionId === observation.predictionId,
          )?.pairId === conditionalPairId,
      ),
    ).toBe(false);
  });

  it("passes generated conditional pairs through full artifact pair validation", () => {
    const state = exactState(fixture);
    const scored = scoreCalibrationPredictions({
      predictions: fixture.records,
      exactState: state,
      actualNextEvent: firstLegalPlay(state),
      trueOpponentModels: { p2: "always-high", p3: "always-low" },
      terminalClusterId: terminalClusterId("dev", 0),
    });
    const predictions = fixture.records.filter(
      (record) => record.target.family === "conditional",
    );
    const pairId = predictions[0]?.pairId;
    const truths = scored.truthRecords.filter(
      (truth) => truth.pairId === pairId,
    );
    expect(predictions).toHaveLength(2);
    expect(predictions.map((record) => record.arm).sort()).toEqual([
      "behavioral",
      "hard-only",
    ]);
    expect(truths).toHaveLength(1);
    expect(truths[0]).toMatchObject({
      pairId,
      scoreStatus: "scored",
    });
  });
});
