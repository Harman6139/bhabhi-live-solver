import { describe, expect, it } from "vitest";

import {
  calibrationScenarioSeeds,
  createPhase6CalibrationPlan,
} from "../../src/calibration/protocol";
import { runPhase6Calibration } from "../../src/calibration/runner";

describe("Phase 6 calibration runner", () => {
  it("runs a candidate-independent paired checkpoint without crossing the truth boundary", () => {
    const base = createPhase6CalibrationPlan({
      runId: "phase6-runner-test",
      split: "dev",
      hardWorldSamples: 8,
    });
    const plan = {
      ...base,
      styleCellIds: ["c08_always-high__always-low"],
      rotations: [0],
      opponentDecisionOrdinals: [2],
      maximumPreActionCheckpointsPerGame: 1,
    } as const;

    const result = runPhase6Calibration(plan);

    expect(result).toMatchObject({
      attemptedGames: 1,
      completedGames: 1,
      attemptedCheckpoints: 7,
      completedCheckpoints: 7,
      failures: [],
    });
    expect(result.checkpointClassCounts).toEqual({
      initial: 1,
      postOpening: 1,
      fixedPublicEvent: 3,
      postThulla: 1,
      postVisiblePickup: 1,
      preOpponentChoice: 1,
    });
    expect(result.predictions.length).toBeGreaterThan(0);
    expect(result.truths.length).toBeGreaterThan(0);
    expect(result.scoredObservations).toHaveLength(result.truths.length * 2);
    expect(JSON.stringify(result.predictions)).not.toMatch(
      /always-high|always-low|c08_/u,
    );

    const armsByPair = new Map<string, string[]>();
    for (const prediction of result.predictions) {
      expect(prediction).not.toHaveProperty("targetLabel");
      expect(prediction).not.toHaveProperty("trueOpponentModels");
      const arms = armsByPair.get(prediction.pairId) ?? [];
      arms.push(prediction.arm);
      armsByPair.set(prediction.pairId, arms);
    }
    for (const arms of armsByPair.values()) {
      expect(arms.sort()).toEqual(["behavioral", "hard-only"]);
    }
    expect(
      result.truths.every(
        (truth) =>
          truth.trueOpponentModels.p2 === "always-high" &&
          truth.trueOpponentModels.p3 === "always-low",
      ),
    ).toBe(true);
  });

  it("accepts an explicitly authorized strict schedule subset", () => {
    const plan = createPhase6CalibrationPlan({
      runId: "phase6-partial-schedule-test",
      split: "tune",
      baseCount: 1,
      hardWorldSamples: 1,
    });
    const firstSeed = calibrationScenarioSeeds(plan)[0];
    if (firstSeed === undefined) {
      throw new Error("Calibration fixture has no seed.");
    }

    expect(() =>
      runPhase6Calibration(plan, { scenarioSeeds: [firstSeed] }),
    ).toThrow(/every planned coordinate/u);

    const result = runPhase6Calibration(plan, {
      scenarioSeeds: [firstSeed],
      allowPartialScenarioSeeds: true,
    });
    expect(result.attemptedGames).toBe(1);
    expect(result.completedGames).toBe(1);
    expect(result.failures).toEqual([]);
  });
});
