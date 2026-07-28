import { describe, expect, it } from "vitest";

import { expandBehaviorHyperparameterGrid } from "../../src/modeling/behavior-fit";
import {
  PHASE8_BEHAVIOR_CONFIG_FAMILY_HASH,
  PHASE8_BEHAVIOR_HYPERPARAMETER_GRID,
  PHASE8_MODEL_SELECTION_CONTRACT_HASH,
  PHASE8_SUPPORT_REGULARIZER_GRID,
} from "../../src/modeling/selection-contract";

describe("Phase 8 frozen model-selection contract", () => {
  it("binds the preregistered finite behavior and support grids", () => {
    const candidates = expandBehaviorHyperparameterGrid(
      PHASE8_BEHAVIOR_HYPERPARAMETER_GRID,
    );

    expect(candidates).toHaveLength(108);
    expect(
      new Set(candidates.map((candidate) => candidate.worldCount)),
    ).toEqual(new Set([4, 16, 64]));
    expect(PHASE8_SUPPORT_REGULARIZER_GRID).toEqual([
      { pseudocountPerFeasibleLabel: 0.25 },
      { pseudocountPerFeasibleLabel: 0.5 },
      { pseudocountPerFeasibleLabel: 1 },
    ]);
    expect(PHASE8_BEHAVIOR_CONFIG_FAMILY_HASH).toMatch(/^fnv1a64:/u);
    expect(PHASE8_MODEL_SELECTION_CONTRACT_HASH).toMatch(/^fnv1a64:/u);
    expect(Object.isFrozen(PHASE8_BEHAVIOR_HYPERPARAMETER_GRID)).toBe(true);
    expect(Object.isFrozen(PHASE8_SUPPORT_REGULARIZER_GRID)).toBe(true);
  });
});
