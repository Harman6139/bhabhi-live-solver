import {
  CALIBRATION_SCHEMA_VERSION,
  CREDIBLE_LEVELS,
  assertProbability,
  validateDistribution,
  type ActionPrediction,
  type ActionScoredObservation,
  type BinaryPrediction,
  type BinaryScoredObservation,
  type CategoricalPrediction,
  type CategoricalScoredObservation,
  type CredibleLevel,
  type CredibleSetScore,
  type LogLossScore,
  type ProbabilityEntry,
  type Top1Score,
} from "./types";

export const LOG_LOSS_EPSILON = 1e-12 as const;

export const RELIABILITY_BIN_EDGES = [
  0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
] as const;

export type ReliabilityObservation = {
  readonly probability: number;
  readonly outcome: boolean;
};

export type ReliabilityBin = {
  readonly index: number;
  readonly lowerInclusive: number;
  readonly upper: number;
  readonly upperInclusive: boolean;
  readonly count: number;
  readonly meanPrediction: number | null;
  readonly observedRate: number | null;
};

function assertIdentifier(value: string, label: string): void {
  if (value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function compareLabels(
  left: ProbabilityEntry,
  right: ProbabilityEntry,
): number {
  if (left.probability !== right.probability) {
    return right.probability - left.probability;
  }
  if (left.label < right.label) {
    return -1;
  }
  if (left.label > right.label) {
    return 1;
  }
  return 0;
}

function probabilityForLabel(
  distribution: readonly ProbabilityEntry[],
  truthLabel: string,
): number {
  const entry = distribution.find(
    (candidate) => candidate.label === truthLabel,
  );
  if (entry === undefined) {
    throw new RangeError(
      `Truth label "${truthLabel}" is absent from the predicted distribution.`,
    );
  }
  return entry.probability;
}

export function binaryBrier(probability: number, truth: boolean): number {
  assertProbability(probability);
  const outcome = truth ? 1 : 0;
  return (probability - outcome) ** 2;
}

/**
 * Multiclass Brier score under the frozen convention
 * 0.5 * sum_k((p_k - y_k)^2).
 */
export function multiclassBrier(
  distributionValue: readonly ProbabilityEntry[],
  truthLabel: string,
): number {
  assertIdentifier(truthLabel, "truthLabel");
  const distribution = validateDistribution(distributionValue);
  probabilityForLabel(distribution, truthLabel);
  return (
    0.5 *
    distribution.reduce(
      (total, entry) =>
        total + (entry.probability - (entry.label === truthLabel ? 1 : 0)) ** 2,
      0,
    )
  );
}

export function logarithmicLoss(probability: number): LogLossScore {
  assertProbability(probability);
  return {
    value: -Math.log(Math.max(probability, LOG_LOSS_EPSILON)),
    rawZeroSupport: probability === 0,
  };
}

export function deterministicTop1(
  distributionValue: readonly ProbabilityEntry[],
  truthLabel: string,
): Top1Score {
  assertIdentifier(truthLabel, "truthLabel");
  const distribution = validateDistribution(distributionValue);
  probabilityForLabel(distribution, truthLabel);
  const ordered = [...distribution].sort(compareLabels);
  const first = ordered[0];
  if (first === undefined) {
    throw new Error("Validated distributions cannot be empty.");
  }
  const tiedLabels = ordered
    .filter((entry) => entry.probability === first.probability)
    .map((entry) => entry.label);
  const tieAwareCorrect = tiedLabels.includes(truthLabel);
  return {
    selectedLabel: first.label,
    tiedLabels,
    selectedCorrect: first.label === truthLabel,
    tieAwareCorrect,
    tieAwareCredit: tieAwareCorrect ? 1 / tiedLabels.length : 0,
  };
}

export function highestProbabilityCredibleSet(
  distributionValue: readonly ProbabilityEntry[],
  level: CredibleLevel,
): Readonly<{
  level: CredibleLevel;
  labels: readonly string[];
  probabilityMass: number;
}> {
  if (!CREDIBLE_LEVELS.includes(level)) {
    throw new RangeError("Credible level must be 0.5, 0.8, or 0.95.");
  }
  const distribution = validateDistribution(distributionValue);
  const ordered = [...distribution].sort(compareLabels);
  const labels: string[] = [];
  let probabilityMass = 0;
  for (const entry of ordered) {
    labels.push(entry.label);
    probabilityMass += entry.probability;
    if (probabilityMass >= level) {
      break;
    }
  }
  return {
    level,
    labels: Object.freeze(labels),
    probabilityMass,
  };
}

export function scoreCredibleSets(
  distribution: readonly ProbabilityEntry[],
  truthLabel: string,
): readonly CredibleSetScore[] {
  assertIdentifier(truthLabel, "truthLabel");
  probabilityForLabel(validateDistribution(distribution), truthLabel);
  return Object.freeze(
    CREDIBLE_LEVELS.map((level) => {
      const set = highestProbabilityCredibleSet(distribution, level);
      return {
        ...set,
        coversTruth: set.labels.includes(truthLabel),
      };
    }),
  );
}

export function reliabilityBins(
  observations: readonly ReliabilityObservation[],
): readonly ReliabilityBin[] {
  const accumulators = Array.from({ length: 10 }, () => ({
    count: 0,
    probabilityTotal: 0,
    outcomeTotal: 0,
  }));
  for (const observation of observations) {
    assertProbability(observation.probability);
    if (typeof observation.outcome !== "boolean") {
      throw new TypeError("Reliability outcomes must be boolean.");
    }
    const index = Math.min(9, Math.floor(observation.probability * 10));
    const accumulator = accumulators[index];
    if (accumulator === undefined) {
      throw new Error("Reliability bin index is outside the frozen bins.");
    }
    accumulator.count += 1;
    accumulator.probabilityTotal += observation.probability;
    accumulator.outcomeTotal += observation.outcome ? 1 : 0;
  }
  return Object.freeze(
    accumulators.map((accumulator, index) => ({
      index,
      lowerInclusive: RELIABILITY_BIN_EDGES[index] ?? 0,
      upper: RELIABILITY_BIN_EDGES[index + 1] ?? 1,
      upperInclusive: index === 9,
      count: accumulator.count,
      meanPrediction:
        accumulator.count === 0
          ? null
          : accumulator.probabilityTotal / accumulator.count,
      observedRate:
        accumulator.count === 0
          ? null
          : accumulator.outcomeTotal / accumulator.count,
    })),
  );
}

export function scoreBinaryPrediction(
  prediction: BinaryPrediction,
  truth: boolean,
  observationId: string,
): BinaryScoredObservation {
  assertIdentifier(observationId, "observationId");
  const logLoss = logarithmicLoss(
    truth ? prediction.probability : 1 - prediction.probability,
  );
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    observationId,
    predictionId: prediction.predictionId,
    arm: prediction.arm,
    coordinates: prediction.coordinates,
    hardKnown: prediction.hardKnown,
    kind: "binary",
    truth,
    probability: prediction.probability,
    brier: binaryBrier(prediction.probability, truth),
    logLoss: logLoss.value,
    rawZeroSupport: logLoss.rawZeroSupport,
  };
}

export function scoreCategoricalPrediction(
  prediction: CategoricalPrediction,
  truthLabel: string,
  observationId: string,
): CategoricalScoredObservation {
  assertIdentifier(observationId, "observationId");
  const probability = probabilityForLabel(
    validateDistribution(prediction.distribution),
    truthLabel,
  );
  const logLoss = logarithmicLoss(probability);
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    observationId,
    predictionId: prediction.predictionId,
    arm: prediction.arm,
    coordinates: prediction.coordinates,
    hardKnown: prediction.hardKnown,
    kind: "categorical",
    truthLabel,
    distribution: prediction.distribution,
    credibleSets: scoreCredibleSets(prediction.distribution, truthLabel),
    brier: multiclassBrier(prediction.distribution, truthLabel),
    logLoss: logLoss.value,
    rawZeroSupport: logLoss.rawZeroSupport,
  };
}

export function scoreActionPrediction(
  prediction: ActionPrediction,
  observedLabel: string,
  forced: boolean,
  observationId: string,
): ActionScoredObservation {
  assertIdentifier(observationId, "observationId");
  if (typeof forced !== "boolean") {
    throw new TypeError("forced must be boolean.");
  }
  const probability = probabilityForLabel(
    validateDistribution(prediction.distribution),
    observedLabel,
  );
  const logLoss = logarithmicLoss(probability);
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    observationId,
    predictionId: prediction.predictionId,
    arm: prediction.arm,
    coordinates: prediction.coordinates,
    hardKnown: prediction.hardKnown,
    kind: "action",
    seat: prediction.seat,
    decisionClass: forced ? "forced" : "discretionary",
    observedLabel,
    distribution: prediction.distribution,
    top1: deterministicTop1(prediction.distribution, observedLabel),
    brier: multiclassBrier(prediction.distribution, observedLabel),
    logLoss: logLoss.value,
    rawZeroSupport: logLoss.rawZeroSupport,
  };
}
