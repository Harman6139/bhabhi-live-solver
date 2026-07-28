import { describe, expect, it } from "vitest";

import {
  LOG_LOSS_EPSILON,
  binaryBrier,
  deterministicTop1,
  highestProbabilityCredibleSet,
  logarithmicLoss,
  multiclassBrier,
  reliabilityBins,
  scoreActionPrediction,
  scoreCategoricalPrediction,
  scoreCredibleSets,
} from "../../src/calibration/metrics";
import {
  calibrationClusterId,
  terminalClusterId,
  validateCalibrationPrediction,
  validateCalibrationPredictions,
  validateDistribution,
  type ActionPrediction,
  type CalibrationCoordinates,
  type CategoricalPrediction,
} from "../../src/calibration/types";

function coordinates(queryId = "query-1"): CalibrationCoordinates {
  return {
    queryId,
    familyId: "card-owner",
    stateId: "state-1",
    trajectoryId: "game-1/rotation-0",
    calibrationClusterId: calibrationClusterId("dev", "c01", 1),
    terminalClusterId: terminalClusterId("dev", 1),
  };
}

describe("proper scoring rules", () => {
  it("matches hand-calculated binary and half-sum multiclass Brier scores", () => {
    expect(binaryBrier(0.8, true)).toBeCloseTo(0.04, 15);
    expect(binaryBrier(0.8, false)).toBeCloseTo(0.64, 15);

    const distribution = [
      { label: "a", probability: 0.7 },
      { label: "b", probability: 0.2 },
      { label: "c", probability: 0.1 },
    ];
    // 0.5 * (0.7^2 + (0.2 - 1)^2 + 0.1^2) = 0.57.
    expect(multiclassBrier(distribution, "b")).toBeCloseTo(0.57, 15);
    expect(multiclassBrier([...distribution].reverse(), "b")).toBeCloseTo(
      0.57,
      15,
    );
  });

  it("uses epsilon 1e-12 while retaining a raw zero-support count", () => {
    expect(LOG_LOSS_EPSILON).toBe(1e-12);
    expect(logarithmicLoss(0)).toEqual({
      value: -Math.log(1e-12),
      rawZeroSupport: true,
    });
    expect(logarithmicLoss(1e-15)).toEqual({
      value: -Math.log(1e-12),
      rawZeroSupport: false,
    });
    expect(logarithmicLoss(0.25)).toEqual({
      value: -Math.log(0.25),
      rawZeroSupport: false,
    });
  });

  it("rejects missing truth labels and non-finite or unnormalized inputs", () => {
    expect(() =>
      multiclassBrier([{ label: "a", probability: 1 }], "missing"),
    ).toThrow(RangeError);
    expect(() => binaryBrier(Number.NaN, true)).toThrow(RangeError);
    expect(() =>
      validateDistribution([
        { label: "a", probability: 0.4 },
        { label: "b", probability: 0.4 },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      validateDistribution([
        { label: "a", probability: 0.5 },
        { label: "a", probability: 0.5 },
      ]),
    ).toThrow(/duplicate label/u);
  });
});

describe("deterministic top-1 and credible sets", () => {
  const tiedDistribution = [
    { label: "b", probability: 0.4 },
    { label: "c", probability: 0.2 },
    { label: "a", probability: 0.4 },
  ] as const;

  it("breaks top ties lexicographically while reporting tie-aware correctness", () => {
    expect(deterministicTop1(tiedDistribution, "b")).toEqual({
      selectedLabel: "a",
      tiedLabels: ["a", "b"],
      selectedCorrect: false,
      tieAwareCorrect: true,
      tieAwareCredit: 0.5,
    });
    expect(deterministicTop1([...tiedDistribution].reverse(), "b")).toEqual(
      deterministicTop1(tiedDistribution, "b"),
    );
  });

  it("builds deterministic 50/80/95 highest-probability sets and coverage", () => {
    expect(highestProbabilityCredibleSet(tiedDistribution, 0.5)).toEqual({
      level: 0.5,
      labels: ["a", "b"],
      probabilityMass: 0.8,
    });
    expect(highestProbabilityCredibleSet(tiedDistribution, 0.8)).toEqual({
      level: 0.8,
      labels: ["a", "b"],
      probabilityMass: 0.8,
    });
    expect(highestProbabilityCredibleSet(tiedDistribution, 0.95)).toEqual({
      level: 0.95,
      labels: ["a", "b", "c"],
      probabilityMass: 1,
    });

    const scored = scoreCredibleSets(tiedDistribution, "c");
    expect(
      scored.map(({ level, coversTruth }) => ({ level, coversTruth })),
    ).toEqual([
      { level: 0.5, coversTruth: false },
      { level: 0.8, coversTruth: false },
      { level: 0.95, coversTruth: true },
    ]);
    expect(scoreCredibleSets([...tiedDistribution].reverse(), "c")).toEqual(
      scored,
    );
  });
});

describe("fixed-width reliability bins", () => {
  it("places left boundaries in the next bin and keeps probability one in bin 9", () => {
    const observations = [
      { probability: 0, outcome: false },
      { probability: 0.099, outcome: true },
      ...Array.from({ length: 9 }, (_, index) => ({
        probability: (index + 1) / 10,
        outcome: (index + 1) % 2 === 0,
      })),
      { probability: 1, outcome: true },
    ];
    const bins = reliabilityBins(observations);

    expect(bins).toHaveLength(10);
    expect(bins[0]).toMatchObject({
      lowerInclusive: 0,
      upper: 0.1,
      upperInclusive: false,
      count: 2,
      meanPrediction: 0.0495,
      observedRate: 0.5,
    });
    for (let index = 1; index < 9; index += 1) {
      expect(bins[index]).toMatchObject({
        lowerInclusive: index / 10,
        count: 1,
      });
    }
    expect(bins[9]).toMatchObject({
      lowerInclusive: 0.9,
      upper: 1,
      upperInclusive: true,
      count: 2,
      meanPrediction: 0.95,
      observedRate: 0.5,
    });
  });
});

describe("truth-free prediction records and eval-only scores", () => {
  const categoricalPrediction: CategoricalPrediction = {
    schemaVersion: 1,
    predictionId: "categorical-1",
    arm: "behavioral",
    coordinates: coordinates(),
    hardKnown: false,
    kind: "categorical",
    distribution: [
      { label: "p2", probability: 0 },
      { label: "p3", probability: 1 },
    ],
  };

  const actionPrediction: ActionPrediction = {
    schemaVersion: 1,
    predictionId: "action-1",
    arm: "hard-only",
    coordinates: {
      ...coordinates("action-query"),
      familyId: "opponent-action",
    },
    hardKnown: false,
    kind: "action",
    seat: "p2",
    distribution: [
      { label: "play:3H", probability: 0.5 },
      { label: "play:KH", probability: 0.5 },
    ],
  };

  it("keeps truth and forced status only in eval-only scored observations", () => {
    const categorical = scoreCategoricalPrediction(
      categoricalPrediction,
      "p2",
      "observation-1",
    );
    expect(categorical).toMatchObject({
      truthLabel: "p2",
      rawZeroSupport: true,
      logLoss: -Math.log(1e-12),
    });

    const action = scoreActionPrediction(
      actionPrediction,
      "play:KH",
      false,
      "observation-2",
    );
    expect(action).toMatchObject({
      seat: "p2",
      decisionClass: "discretionary",
      observedLabel: "play:KH",
      top1: {
        selectedLabel: "play:3H",
        selectedCorrect: false,
        tieAwareCorrect: true,
        tieAwareCredit: 0.5,
      },
    });
  });

  it("strictly rejects truth fields and duplicate prediction IDs", () => {
    expect(() =>
      validateCalibrationPrediction({
        ...categoricalPrediction,
        truthLabel: "p2",
      }),
    ).toThrow(/unexpected field "truthLabel"/u);
    expect(() =>
      validateCalibrationPrediction({
        ...actionPrediction,
        forced: false,
      }),
    ).toThrow(/unexpected field "forced"/u);
    expect(() =>
      validateCalibrationPredictions([
        categoricalPrediction,
        {
          ...categoricalPrediction,
          kind: "binary",
          probability: 0.5,
          distribution: undefined,
        },
      ]),
    ).toThrow();
    expect(() =>
      validateCalibrationPredictions([
        categoricalPrediction,
        categoricalPrediction,
      ]),
    ).toThrow(/Duplicate predictionId/u);
  });
});
