import { beforeAll, describe, expect, it } from "vitest";

import { createActorObservation } from "../../src/agents/observation";
import { FULL_DECK, suitOf } from "../../src/domain/cards";
import { stableStringify } from "../../src/events/stable-hash";
import {
  activeTimelineEvents,
  replayTimeline,
  type GameTimeline,
} from "../../src/events/timeline";
import {
  buildBehaviorBelief,
  predictCurrentOpponentAction,
} from "../../src/inference/behavior-belief";
import { enumerateBehaviorActions } from "../../src/inference/behavior-models";
import { buildHardBelief } from "../../src/inference/belief";
import {
  generateCalibrationPredictions,
  parseCalibrationQueryKey,
  type CalibrationCheckpointMetadata,
} from "../../src/calibration/predictions";
import { deriveCalibrationFeasibleSupport } from "../../src/calibration/support-feasibility";
import {
  hiddenOpponentTakeTimeline,
  play,
  setupWithUserHand,
  startingHand,
  temporalTimeline,
  timelineFrom,
} from "../inference/test-fixtures";

function allHeartsTimeline(): GameTimeline {
  const hearts = FULL_DECK.filter((card) => suitOf(card) === "hearts");
  const userHand = startingHand([...hearts, "AS"], ["KS", "QS"], 18);
  return timelineFrom(setupWithUserHand(userHand), [
    play("user", "AS"),
    play("p2", "KS"),
    play("p3", "QS"),
    play("user", "2H"),
  ]);
}

function checkpoint(
  timeline: GameTimeline,
  timing: "pre-action" | "post-event" = "pre-action",
): CalibrationCheckpointMetadata {
  const state = replayTimeline(timeline).state;
  return {
    runId: "phase6-prediction-test",
    split: "dev",
    evidenceClass: "phase6-test",
    gameId: "game-prediction-1",
    scenarioId: "dev/c01/0/0",
    calibrationClusterId: "dev/c01/0",
    checkpointId: timing === "pre-action" ? "before-p2" : "after-user-lead",
    checkpointEventIndex: activeTimelineEvents(timeline).length,
    checkpointTiming: timing,
    stateVersion: state.appliedEventCount,
    featureBundleHash: "feature-bundle-test",
    queryPlanHash: "query-plan-test",
    seedId: "belief-seed-test",
  };
}

function buildFixture(
  timeline = allHeartsTimeline(),
  seed = "prediction-test",
) {
  const hardBelief = buildHardBelief(timeline, {
    seed,
    sampleCount: 24,
    forceSampling: true,
  });
  const behaviorBelief = buildBehaviorBelief(timeline, hardBelief);
  const records = generateCalibrationPredictions({
    timeline,
    hardBelief,
    behaviorBelief,
    checkpoint: checkpoint(timeline),
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

type Fixture = ReturnType<typeof buildFixture>;
let fixture: Fixture;

beforeAll(() => {
  fixture = buildFixture();
});

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (value === null || typeof value !== "object") {
    return keys;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

describe("truth-free paired calibration predictions", () => {
  it("is byte-identical in the presence of three distinct consistent hidden truths", () => {
    const truths = fixture.hardBelief.worlds.slice(0, 3).map((world) => ({
      publicState: fixture.state,
      hands: world.currentHands,
    }));
    expect(
      new Set(
        fixture.hardBelief.worlds.slice(0, 3).map((world) => world.witnessId),
      ),
    ).toHaveLength(3);

    const bytes = truths.map(() =>
      stableStringify(
        generateCalibrationPredictions({
          timeline: fixture.timeline,
          hardBelief: fixture.hardBelief,
          behaviorBelief: fixture.behaviorBelief,
          checkpoint: checkpoint(fixture.timeline),
          config: { conditionalProbabilityFloor: 0.05 },
        }),
      ),
    );
    expect(new Set(bytes)).toHaveLength(1);

    const keys = collectKeys(fixture.records);
    for (const forbidden of [
      "truth",
      "truthLabel",
      "targetLabel",
      "observedAction",
      "actualNextEvent",
      "trueOpponentModels",
      "initialHands",
      "currentHands",
      "hands",
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it("emits paired, normalized records for every frozen query family and action", () => {
    expect(
      new Set(fixture.records.map((record) => record.target.family)),
    ).toEqual(
      new Set([
        "card-owner",
        "current-void",
        "suit-length",
        "can-overtake",
        "joint",
        "conditional",
        "opponent-action",
      ]),
    );

    const byPair = new Map<string, typeof fixture.records>();
    for (const record of fixture.records) {
      const group = byPair.get(record.pairId) ?? [];
      byPair.set(record.pairId, [...group, record]);
      expect(record.worldOccurrences).toBe(fixture.hardBelief.worlds.length);
      expect(record.seedId).toBe("belief-seed-test");
      expect(
        record.distribution.reduce((sum, entry) => sum + entry.probability, 0),
      ).toBeCloseTo(1, 12);
      expect(
        new Set(record.distribution.map((entry) => entry.label)),
      ).toHaveLength(record.distribution.length);
    }
    for (const pair of byPair.values()) {
      expect(pair).toHaveLength(2);
      expect(pair.map((record) => record.arm).sort()).toEqual([
        "behavioral",
        "hard-only",
      ]);
      expect(pair[0]?.target).toEqual(pair[1]?.target);
      expect(pair[0]?.publicHistoryHash).toBe(pair[1]?.publicHistoryHash);
      expect(pair[0]?.seedId).toBe(pair[1]?.seedId);
      expect(pair[0]?.worldOccurrences).toBe(pair[1]?.worldOccurrences);
    }
  });

  it("preserves public hard-known facts at exact zero and one", () => {
    const heartVoid = fixture.records.filter(
      (record) =>
        record.target.kind === "query" &&
        record.target.queryKey === "current-void:p3:hearts",
    );
    expect(heartVoid).toHaveLength(2);
    for (const record of heartVoid) {
      expect(record.hardKnown).toBe(true);
      expect(record.distribution).toEqual([
        { label: "false", probability: 0 },
        { label: "true", probability: 1 },
      ]);
    }
  });

  it("matches hand-reduced hard and behavior weights on a tiny owner query", () => {
    const hardOwner = fixture.records.find(
      (record) =>
        record.arm === "hard-only" &&
        record.target.kind === "query" &&
        record.target.family === "card-owner" &&
        !record.hardKnown,
    );
    expect(hardOwner?.target.kind).toBe("query");
    if (hardOwner?.target.kind !== "query") {
      throw new Error("Expected an unresolved owner query.");
    }
    const parsed = parseCalibrationQueryKey(hardOwner.target.queryKey);
    if (parsed.family !== "card-owner") {
      throw new Error("Expected a card-owner key.");
    }
    const behaviorOwner = fixture.records.find(
      (record) =>
        record.arm === "behavioral" && record.pairId === hardOwner.pairId,
    );
    expect(behaviorOwner).toBeDefined();

    const expectedHard =
      fixture.hardBelief.worlds.filter((world) =>
        world.currentHands.p2.includes(parsed.card),
      ).length / fixture.hardBelief.worlds.length;
    const totalBehaviorWeight = fixture.behaviorBelief.worldOccurrences.reduce(
      (sum, occurrence) => sum + occurrence.weight,
      0,
    );
    const expectedBehavior = fixture.behaviorBelief.worldOccurrences.reduce(
      (sum, occurrence, index) =>
        sum +
        (fixture.hardBelief.worlds[index]?.currentHands.p2.includes(parsed.card)
          ? occurrence.weight / totalBehaviorWeight
          : 0),
      0,
    );
    expect(
      hardOwner.distribution.find((entry) => entry.label === "p2")?.probability,
    ).toBeCloseTo(expectedHard, 14);
    expect(
      behaviorOwner?.distribution.find((entry) => entry.label === "p2")
        ?.probability,
    ).toBeCloseTo(expectedBehavior, 14);
  });
});

describe("prequential action head", () => {
  it("uses uniform legal actions for hard-only and the existing posterior head for behavior", () => {
    const actionRecords = fixture.records.filter(
      (record) => record.target.kind === "opponent-action",
    );
    expect(actionRecords).toHaveLength(2);
    const hard = actionRecords.find((record) => record.arm === "hard-only");
    const behavioral = actionRecords.find(
      (record) => record.arm === "behavioral",
    );
    expect(hard?.method).toBe("uniform-hard-worlds-plus-uniform-legal-actions");

    const actor = fixture.state.turn;
    if (actor !== "p2" && actor !== "p3") {
      throw new Error("Fixture must be at an opponent decision.");
    }
    const expected = new Map<string, number>();
    for (const world of fixture.hardBelief.worlds) {
      const observation = createActorObservation(
        {
          publicState: fixture.state,
          exactHands: world.currentHands,
        },
        actor,
        fixture.behaviorBelief.decisionOrdinals[actor],
        activeTimelineEvents(fixture.timeline),
      );
      const actions = enumerateBehaviorActions(observation);
      for (const action of actions) {
        const key =
          action.kind === "play-card"
            ? `play:${action.card}`
            : `take:${action.target}`;
        expected.set(
          key,
          (expected.get(key) ?? 0) +
            1 / fixture.hardBelief.worlds.length / actions.length,
        );
      }
    }
    for (const entry of hard?.distribution ?? []) {
      expect(entry.probability).toBeCloseTo(
        expected.get(entry.label) ?? -1,
        14,
      );
    }

    const direct = predictCurrentOpponentAction(
      fixture.behaviorBelief,
      fixture.hardBelief,
      fixture.timeline,
    );
    expect(direct).not.toBeNull();
    for (const entry of behavioral?.distribution ?? []) {
      expect(entry.probability).toBeCloseTo(
        direct?.actionDistribution.find(
          (candidate) => candidate.actionKey === entry.label,
        )?.probability ?? -1,
        14,
      );
    }
  });

  it("never emits action predictions at a post-event checkpoint", () => {
    const records = generateCalibrationPredictions({
      timeline: fixture.timeline,
      hardBelief: fixture.hardBelief,
      behaviorBelief: fixture.behaviorBelief,
      checkpoint: checkpoint(fixture.timeline, "post-event"),
      config: { conditionalProbabilityFloor: 0.05 },
    });
    expect(
      records.some((record) => record.target.kind === "opponent-action"),
    ).toBe(false);
  });

  it("preserves exact play and take labels in variant legal support", () => {
    const complete = hiddenOpponentTakeTimeline();
    const timeline: GameTimeline = {
      ...complete,
      cursor: complete.cursor - 1,
    };
    const takeFixture = buildFixture(timeline, "take-action-prediction");
    const actions = takeFixture.records.filter(
      (record) => record.target.kind === "opponent-action",
    );
    expect(actions).toHaveLength(2);
    for (const record of actions) {
      if (record.target.kind !== "opponent-action") {
        throw new Error("Expected action target.");
      }
      expect(record.target.legalActionKeys).toContain("take:p3");
      expect(record.distribution.map((entry) => entry.label)).toContain(
        "take:p3",
      );
      expect(
        record.distribution.some((entry) => entry.label.startsWith("play:")),
      ).toBe(true);
    }
  });
});

describe("conditional query floor", () => {
  it("emits a shared paired target above the floor and skips zero-denominator conditions", () => {
    const conditional = fixture.records.filter(
      (record) => record.target.family === "conditional",
    );
    expect(conditional).toHaveLength(2);
    expect(conditional[0]?.target).toEqual(conditional[1]?.target);
    if (conditional[0]?.target.kind !== "query") {
      throw new Error("Expected conditional query target.");
    }
    expect(conditional[0].target.conditioningProbability).toBe(1);
    expect(
      conditional.every(
        (record) =>
          record.armConditioningProbability !== null &&
          record.armConditioningProbability >= 0.05,
      ),
    ).toBe(true);
    expect(
      fixture.records
        .filter((record) => record.target.family !== "conditional")
        .every((record) => record.armConditioningProbability === null),
    ).toBe(true);

    const noConditionTimeline = temporalTimeline(4);
    const noConditionFixture = buildFixture(
      noConditionTimeline,
      "zero-condition-prediction",
    );
    expect(
      noConditionFixture.records.some(
        (record) => record.target.family === "conditional",
      ),
    ).toBe(false);
    const sampledUnanimous = noConditionFixture.records.find(
      (record) =>
        record.target.kind === "query" &&
        record.target.family === "can-overtake" &&
        record.distribution.some(
          (entry) => entry.label === "true" && entry.probability === 1,
        ),
    );
    // Sampling unanimity alone is not promoted to a logical hard fact.
    expect(sampledUnanimous?.hardKnown).toBe(false);
  });
});

describe("Phase 8 hard-feasible support regularization", () => {
  it("fills finite-sample misses only inside exact hard support", () => {
    const hardBelief = buildHardBelief(fixture.timeline, {
      seed: "single-world-support-regularization",
      sampleCount: 1,
      forceSampling: true,
    });
    const behaviorBelief = buildBehaviorBelief(fixture.timeline, hardBelief);
    const raw = generateCalibrationPredictions({
      timeline: fixture.timeline,
      hardBelief,
      behaviorBelief,
      checkpoint: checkpoint(fixture.timeline),
      config: { conditionalProbabilityFloor: 0.05 },
    });
    const regularized = generateCalibrationPredictions({
      timeline: fixture.timeline,
      hardBelief,
      behaviorBelief,
      checkpoint: checkpoint(fixture.timeline),
      config: {
        conditionalProbabilityFloor: 0.05,
        feasibleSupportRegularizer: {
          pseudocountPerFeasibleLabel: 0.5,
        },
      },
    });
    const state = replayTimeline(fixture.timeline).state;
    const rawByPrediction = new Map(
      raw.map((record) => [record.predictionId, record]),
    );
    let correctedSampleMisses = 0;

    for (const record of regularized) {
      if (record.target.kind === "terminal-risk") {
        throw new Error("Hidden-state predictions cannot be terminal records.");
      }
      const support = deriveCalibrationFeasibleSupport({
        target: record.target,
        state,
        evidence: hardBelief.evidence,
      });
      expect(record.hardKnown).toBe(support.hardKnown);
      expect(record.method).toContain("feasible-support-jeffreys-v1");
      for (const entry of record.distribution) {
        if (support.labels.includes(entry.label)) {
          expect(entry.probability).toBeGreaterThan(0);
          if (
            rawByPrediction
              .get(record.predictionId)
              ?.distribution.find(
                (candidate) => candidate.label === entry.label,
              )?.probability === 0
          ) {
            correctedSampleMisses += 1;
          }
        } else {
          expect(entry.probability).toBe(0);
        }
      }
      if (support.hardKnown) {
        const knownLabel = support.labels[0];
        expect(
          record.distribution.find((entry) => entry.label === knownLabel)
            ?.probability,
        ).toBe(1);
      }
    }
    expect(correctedSampleMisses).toBeGreaterThan(0);
  });
});
