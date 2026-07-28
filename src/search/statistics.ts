import { createSeededRng } from "../random/keyed-rng";
import type { DifferenceInterval, ProbabilityInterval } from "./types";

const Z_95 = 1.959963984540054;

function wilsonBounds(
  successes: number,
  trials: number,
): Readonly<{ lower: number; upper: number }> {
  const probability = successes / trials;
  const zSquared = Z_95 * Z_95;
  const denominator = 1 + zSquared / trials;
  const center = (probability + zSquared / (2 * trials)) / denominator;
  const radius =
    (Z_95 *
      Math.sqrt(
        (probability * (1 - probability) + zSquared / (4 * trials)) / trials,
      )) /
    denominator;
  return {
    lower: Math.max(0, center - radius),
    upper: Math.min(1, center + radius),
  };
}

export function wilsonInterval(
  successes: number,
  trials: number,
): ProbabilityInterval {
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(trials) ||
    successes < 0 ||
    trials < 1 ||
    successes > trials
  ) {
    throw new RangeError(
      "Wilson interval requires integer 0 <= successes <= trials.",
    );
  }
  return {
    level: 0.95,
    method: "wilson-score",
    ...wilsonBounds(successes, trials),
  };
}

/**
 * A bounded-mean Wilson interval with one observation per sampled hidden
 * world. Replicates within a world are averaged before this function is used,
 * so repeated stochastic continuations are not falsely counted as new worlds.
 */
export function clusterWilsonInterval(
  clusterMeans: readonly number[],
): ProbabilityInterval {
  if (
    clusterMeans.length === 0 ||
    clusterMeans.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    )
  ) {
    throw new RangeError(
      "Cluster Wilson interval requires finite cluster means in [0, 1].",
    );
  }
  return {
    level: 0.95,
    method: "cluster-wilson-score",
    ...wilsonBounds(
      clusterMeans.reduce((total, value) => total + value, 0),
      clusterMeans.length,
    ),
  };
}

function quantile(sorted: readonly number[], probability: number): number {
  const index = Math.floor((sorted.length - 1) * probability);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("Cannot select a quantile from an empty sample.");
  }
  return value;
}

export function pairedBootstrapDifference(
  candidateByCluster: readonly number[],
  referenceByCluster: readonly number[],
  resamples: number,
  seed: string,
): DifferenceInterval {
  if (
    candidateByCluster.length !== referenceByCluster.length ||
    candidateByCluster.length === 0
  ) {
    throw new RangeError(
      "Paired bootstrap inputs must have the same positive cluster count.",
    );
  }
  if (!Number.isSafeInteger(resamples) || resamples < 1) {
    throw new RangeError("Bootstrap resamples must be a positive integer.");
  }
  for (const value of [...candidateByCluster, ...referenceByCluster]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError("Cluster risks must be finite values in [0, 1].");
    }
  }
  if (
    candidateByCluster.every(
      (value, index) => value === referenceByCluster[index],
    )
  ) {
    return {
      level: 0.95,
      method: "paired-cluster-bootstrap-percentile",
      lower: 0,
      upper: 0,
    };
  }
  if (candidateByCluster.length < 2) {
    return {
      level: 0.95,
      method: "paired-cluster-bootstrap-percentile",
      lower: -1,
      upper: 1,
    };
  }

  const rng = createSeededRng(seed).fork(
    "paired-cluster-bootstrap",
    candidateByCluster.length,
    resamples,
  );
  const differences: number[] = [];
  for (let resample = 0; resample < resamples; resample += 1) {
    let total = 0;
    for (let draw = 0; draw < candidateByCluster.length; draw += 1) {
      const index = rng.nextInt(candidateByCluster.length);
      total +=
        (candidateByCluster[index] ?? 0) - (referenceByCluster[index] ?? 0);
    }
    differences.push(total / candidateByCluster.length);
  }
  differences.sort((left, right) => left - right);
  return {
    level: 0.95,
    method: "paired-cluster-bootstrap-percentile",
    lower: quantile(differences, 0.025),
    upper: quantile(differences, 0.975),
  };
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("Cannot take the mean of an empty sample.");
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}
