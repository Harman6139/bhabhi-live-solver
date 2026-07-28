import { stableHash } from "../events/stable-hash";
import type { FeasibleSupportRegularizerConfig } from "../calibration/support-regularization";
import {
  behaviorConfigFamilyHash,
  type BehaviorHyperparameterGridInput,
} from "./behavior-fit";

/**
 * Frozen before train/tune generation. The Cartesian product contains 108
 * candidates and is deliberately small enough to audit exhaustively.
 */
export const PHASE8_BEHAVIOR_HYPERPARAMETER_GRID = Object.freeze({
  lapseProbabilities: Object.freeze([0.04, 0.08, 0.16]),
  likelihoodPowers: Object.freeze([0.25, 0.5, 1]),
  maximumBayesFactors: Object.freeze([2, 4]),
  worldCounts: Object.freeze([4, 16, 64]),
  robustChoices: Object.freeze([false, true]),
}) satisfies BehaviorHyperparameterGridInput;

/**
 * Symmetric prior mass per independently hard-feasible label. Tune selects
 * exactly one; qualification and final may not alter it.
 */
export const PHASE8_SUPPORT_REGULARIZER_GRID = Object.freeze([
  Object.freeze({ pseudocountPerFeasibleLabel: 0.25 }),
  Object.freeze({ pseudocountPerFeasibleLabel: 0.5 }),
  Object.freeze({ pseudocountPerFeasibleLabel: 1 }),
]) satisfies readonly FeasibleSupportRegularizerConfig[];

export const PHASE8_BEHAVIOR_CONFIG_FAMILY_HASH = behaviorConfigFamilyHash(
  PHASE8_BEHAVIOR_HYPERPARAMETER_GRID,
);

export const PHASE8_MODEL_SELECTION_CONTRACT_HASH = stableHash({
  schemaVersion: 1,
  kind: "phase8-model-selection-contract",
  behaviorHyperparameterGrid: PHASE8_BEHAVIOR_HYPERPARAMETER_GRID,
  behaviorConfigFamilyHash: PHASE8_BEHAVIOR_CONFIG_FAMILY_HASH,
  supportRegularizerGrid: PHASE8_SUPPORT_REGULARIZER_GRID,
  selection: {
    behavior:
      "minimum-pooled-prequential-public-action-negative-log-likelihood",
    behaviorTieBreak:
      "numeric-parameter-order-preferring-robust-off-on-exact-score-tie",
    regularizer:
      "minimum-equal-family-unresolved-soft-brier-on-tune-with-smallest-pseudocount-tie-break",
  },
});
