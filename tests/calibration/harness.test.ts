import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_STYLE_CELL_IDS,
  FITTABLE_STYLE_CELL_IDS,
  calibrationScenarioSeeds,
  createPhase6CalibrationPlan,
  expectedPhase6CalibrationGames,
  phase6CalibrationPlanHash,
} from "../../src/calibration/protocol";

describe("Phase 6 split-safe calibration protocol", () => {
  it("keeps stress policies out of train/tune while retaining them on dev", () => {
    expect(FITTABLE_STYLE_CELL_IDS).toHaveLength(15);
    expect(FITTABLE_STYLE_CELL_IDS).not.toContain(
      "c16_noisy-mixture__phase-switch",
    );
    expect(FITTABLE_STYLE_CELL_IDS).not.toContain(
      "c17_phase-switch__noisy-mixture",
    );
    expect(DEVELOPMENT_STYLE_CELL_IDS).toHaveLength(17);

    const train = createPhase6CalibrationPlan({
      runId: "phase6-train",
      split: "train",
    });
    const tune = createPhase6CalibrationPlan({
      runId: "phase6-tune",
      split: "tune",
    });
    const dev = createPhase6CalibrationPlan({
      runId: "phase6-dev",
      split: "dev",
    });
    expect(train.styleCellIds).toEqual(FITTABLE_STYLE_CELL_IDS);
    expect(tune.styleCellIds).toEqual(FITTABLE_STYLE_CELL_IDS);
    expect(dev.styleCellIds).toEqual(DEVELOPMENT_STYLE_CELL_IDS);
    expect(dev.behaviorProductionEnabled).toBe(false);
  });

  it("rejects qualification/final and creates disjoint deterministic split seeds", () => {
    for (const split of ["qualification", "final"] as const) {
      expect(() =>
        createPhase6CalibrationPlan({
          runId: `phase6-${split}`,
          split,
        }),
      ).toThrow(/cannot open/iu);
    }

    const train = createPhase6CalibrationPlan({
      runId: "phase6-train-seeds",
      split: "train",
      baseCount: 2,
    });
    const tune = createPhase6CalibrationPlan({
      runId: "phase6-tune-seeds",
      split: "tune",
      baseCount: 2,
    });
    const trainSeeds = calibrationScenarioSeeds(train);
    const tuneSeeds = calibrationScenarioSeeds(tune);
    expect(trainSeeds).toHaveLength(expectedPhase6CalibrationGames(train));
    expect(tuneSeeds).toHaveLength(expectedPhase6CalibrationGames(tune));
    expect(new Set(trainSeeds.map((seed) => seed.deal))).not.toEqual(
      new Set(tuneSeeds.map((seed) => seed.deal)),
    );
    expect(new Set(trainSeeds.map((seed) => seed.p2Policy))).not.toEqual(
      new Set(tuneSeeds.map((seed) => seed.p2Policy)),
    );
  });

  it("pins candidate-independent checkpoints, queries, and plan hashes", () => {
    const first = createPhase6CalibrationPlan({
      runId: "phase6-plan-a",
      split: "dev",
      hardWorldSamples: 96,
    });
    const repeated = createPhase6CalibrationPlan({
      runId: "phase6-plan-a",
      split: "dev",
      hardWorldSamples: 96,
    });
    const changed = createPhase6CalibrationPlan({
      runId: "phase6-plan-a",
      split: "dev",
      hardWorldSamples: 97,
    });

    expect(first.opponentDecisionOrdinals).toEqual([2, 5, 8]);
    expect(first.queryFamilies).toEqual([
      "card-owner",
      "current-void",
      "suit-length",
      "can-overtake",
      "joint",
      "conditional",
      "opponent-action",
    ]);
    expect(phase6CalibrationPlanHash(first)).toBe(
      phase6CalibrationPlanHash(repeated),
    );
    expect(phase6CalibrationPlanHash(first)).not.toBe(
      phase6CalibrationPlanHash(changed),
    );
  });
});
