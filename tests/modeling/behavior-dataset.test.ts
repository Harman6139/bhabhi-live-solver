import { describe, expect, it } from "vitest";

import { stableStringify } from "../../src/events/stable-hash";
import {
  BEHAVIOR_DATASET_DECISION_ORDINALS,
  BEHAVIOR_DATASET_RELEASE_BASE_COUNT,
  BEHAVIOR_DATASET_WORLD_COUNTS,
  createBehaviorDatasetPlan,
  expectedBehaviorDatasetGames,
  runBehaviorFitDataset,
} from "../../src/modeling/behavior-dataset";

describe("Phase 8 public prequential behavior dataset", () => {
  it("enforces the evidence schedule without opening qualification/final", () => {
    const plan = createBehaviorDatasetPlan({
      runId: "phase8-train-release-test",
      split: "train",
      evidenceEligible: true,
    });
    expect(plan.baseCount).toBe(BEHAVIOR_DATASET_RELEASE_BASE_COUNT);
    expect(plan.styleCellIds).toHaveLength(15);
    expect(plan.rotations).toEqual([0, 1, 2]);
    expect(plan.opponentDecisionOrdinals).toEqual(
      BEHAVIOR_DATASET_DECISION_ORDINALS,
    );
    expect(plan.worldCounts).toEqual(BEHAVIOR_DATASET_WORLD_COUNTS);
    expect(expectedBehaviorDatasetGames(plan)).toBe(2_880);

    expect(() =>
      createBehaviorDatasetPlan({
        runId: "phase8-tune-too-small",
        split: "tune",
        evidenceEligible: true,
        baseCount: 63,
      }),
    ).toThrow(/Evidence-eligible/u);
  });

  it("runs deterministically from public prefixes and emits no truth fields", () => {
    const plan = createBehaviorDatasetPlan({
      runId: "phase8-train-dataset-smoke",
      split: "train",
      styleCellIds: ["c08_always-high__always-low"],
      rotations: [0],
      baseCount: 1,
      opponentDecisionOrdinals: [2],
      worldCounts: [4],
    });
    const first = runBehaviorFitDataset({ plan });
    const second = runBehaviorFitDataset({ plan });

    expect(first.failures).toEqual([]);
    expect(first.games).toHaveLength(1);
    expect(first.observations.length).toBeGreaterThan(0);
    expect(stableStringify(first)).toBe(stableStringify(second));
    const bytes = stableStringify(first.observations);
    for (const forbidden of [
      "truth",
      "initialHands",
      "currentHands",
      "deal",
      "trueOpponentModels",
    ]) {
      expect(bytes).not.toContain(`"${forbidden}"`);
    }
    for (const observation of first.observations) {
      expect(observation.split).toBe("train");
      expect(observation.styleCellId).toBe("c08_always-high__always-low");
      expect(observation.worldEstimates).toHaveLength(1);
      expect(observation.worldEstimates[0]?.worldCount).toBe(4);
      expect(["p2", "p3"]).toContain(observation.seat);
    }
  });

  it("keeps train and tune identities disjoint under identical coordinates", () => {
    const common = {
      styleCellIds: ["c01_random__random"],
      rotations: [0] as const,
      baseCount: 1,
      opponentDecisionOrdinals: [2],
      worldCounts: [4],
    };
    const train = createBehaviorDatasetPlan({
      ...common,
      runId: "phase8-train-split-test",
      split: "train",
    });
    const tune = createBehaviorDatasetPlan({
      ...common,
      runId: "phase8-tune-split-test",
      split: "tune",
    });

    expect(runBehaviorFitDataset({ plan: train }).scheduleHash).not.toBe(
      runBehaviorFitDataset({ plan: tune }).scheduleHash,
    );
  });
});
