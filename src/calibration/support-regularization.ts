import { stableHash } from "../events/stable-hash";
import type { ProbabilityEntry } from "./types";

const DISTRIBUTION_TOLERANCE = 1e-12;

export const FEASIBLE_SUPPORT_REGULARIZER_VERSION =
  "feasible-support-jeffreys-v1" as const;

export type FeasibleSupportRegularizerConfig = {
  /**
   * Symmetric prior mass assigned to each hard-feasible label. Zero preserves
   * the unregularized estimator and is useful for development diagnostics.
   */
  readonly pseudocountPerFeasibleLabel: number;
};

export type FeasibleSupportRegularization = {
  readonly distribution: readonly ProbabilityEntry[];
  readonly feasibleLabels: readonly string[];
  readonly rawZeroFeasibleLabelsBefore: readonly string[];
  readonly priorMassAdded: number;
  readonly configHash: string;
};

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function fail(message: string): never {
  throw new Error(`Feasible-support regularization failed: ${message}`);
}

function finiteNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative.`);
  }
}

function validateDistribution(
  distribution: readonly ProbabilityEntry[],
): readonly ProbabilityEntry[] {
  if (distribution.length === 0) {
    fail("the input distribution is empty.");
  }
  const labels = new Set<string>();
  let total = 0;
  for (const entry of distribution) {
    if (entry.label.length === 0 || labels.has(entry.label)) {
      fail("distribution labels must be non-empty and unique.");
    }
    finiteNonnegative(entry.probability, `probability for ${entry.label}`);
    if (entry.probability > 1 + DISTRIBUTION_TOLERANCE) {
      fail(`probability for ${entry.label} exceeds one.`);
    }
    labels.add(entry.label);
    total += entry.probability;
  }
  if (Math.abs(total - 1) > DISTRIBUTION_TOLERANCE) {
    fail(`input probabilities sum to ${total.toString()}, not one.`);
  }
  return distribution;
}

/**
 * Applies a symmetric finite-sample prior only inside an independently
 * established hard-feasible label set.
 *
 * `effectiveSampleSize` is the data mass of the weighted empirical
 * distribution. The function never discovers feasibility from sampled
 * frequency: callers must derive `feasibleLabels` from hard constraints.
 * Infeasible labels remain exactly zero, and hard-known singleton support
 * remains exactly one.
 */
export function regularizeFeasibleSupport(input: {
  readonly distribution: readonly ProbabilityEntry[];
  readonly feasibleLabels: readonly string[];
  readonly hardKnown: boolean;
  readonly effectiveSampleSize: number;
  readonly config: FeasibleSupportRegularizerConfig;
}): FeasibleSupportRegularization {
  const distribution = validateDistribution(input.distribution);
  if (
    !Number.isFinite(input.effectiveSampleSize) ||
    input.effectiveSampleSize <= 0
  ) {
    throw new RangeError("effectiveSampleSize must be finite and positive.");
  }
  finiteNonnegative(
    input.config.pseudocountPerFeasibleLabel,
    "pseudocountPerFeasibleLabel",
  );

  const distributionLabels = new Set(distribution.map((entry) => entry.label));
  const feasibleLabels = [...input.feasibleLabels].sort(compareText);
  if (
    feasibleLabels.length === 0 ||
    new Set(feasibleLabels).size !== feasibleLabels.length
  ) {
    fail("hard-feasible labels must be a non-empty unique set.");
  }
  for (const label of feasibleLabels) {
    if (!distributionLabels.has(label)) {
      fail(`hard-feasible label "${label}" is absent from the distribution.`);
    }
  }

  const feasible = new Set(feasibleLabels);
  for (const entry of distribution) {
    if (
      !feasible.has(entry.label) &&
      entry.probability > DISTRIBUTION_TOLERANCE
    ) {
      fail(`hard-infeasible label "${entry.label}" has positive sampled mass.`);
    }
  }

  if (input.hardKnown) {
    if (feasibleLabels.length !== 1) {
      fail("a hard-known prediction must have singleton feasible support.");
    }
    const knownLabel = feasibleLabels[0];
    const knownEntry = distribution.find((entry) => entry.label === knownLabel);
    if (
      knownEntry === undefined ||
      Math.abs(knownEntry.probability - 1) > DISTRIBUTION_TOLERANCE
    ) {
      fail("a hard-known prediction must assign probability one to its fact.");
    }
  }

  const rawZeroFeasibleLabelsBefore = feasibleLabels.filter((label) => {
    const probability =
      distribution.find((entry) => entry.label === label)?.probability ?? 0;
    return probability === 0;
  });
  const pseudocount = input.hardKnown
    ? 0
    : input.config.pseudocountPerFeasibleLabel;
  const denominator =
    input.effectiveSampleSize + pseudocount * feasibleLabels.length;
  const regularized = distribution.map((entry) => ({
    label: entry.label,
    probability: feasible.has(entry.label)
      ? (entry.probability * input.effectiveSampleSize + pseudocount) /
        denominator
      : 0,
  }));
  const configHash = stableHash({
    schemaVersion: 1,
    algorithmVersion: FEASIBLE_SUPPORT_REGULARIZER_VERSION,
    config: input.config,
  });

  return Object.freeze({
    distribution: Object.freeze(regularized),
    feasibleLabels: Object.freeze(feasibleLabels),
    rawZeroFeasibleLabelsBefore: Object.freeze(rawZeroFeasibleLabelsBefore),
    priorMassAdded: pseudocount * feasibleLabels.length,
    configHash,
  });
}
