export const CALIBRATION_SCHEMA_VERSION = 1 as const;

export const CALIBRATION_ARMS = ["hard-only", "behavioral"] as const;
export type CalibrationArm = (typeof CALIBRATION_ARMS)[number];

export const OPPONENT_SEATS = ["p2", "p3"] as const;
export type OpponentSeat = (typeof OPPONENT_SEATS)[number];

export const CREDIBLE_LEVELS = [0.5, 0.8, 0.95] as const;
export type CredibleLevel = (typeof CREDIBLE_LEVELS)[number];

declare const terminalClusterIdBrand: unique symbol;
declare const calibrationClusterIdBrand: unique symbol;

export type TerminalClusterId = string & {
  readonly [terminalClusterIdBrand]: "terminal-cluster-id";
};

export type CalibrationClusterId = string & {
  readonly [calibrationClusterIdBrand]: "calibration-cluster-id";
};

/**
 * Terminal comparisons resample a base deal with its complete style-cell and
 * rotation matrix. The identifier intentionally excludes both configuration
 * and rotation.
 */
export function terminalClusterId(
  split: string,
  baseIndex: number,
): TerminalClusterId {
  assertIdentifier(split, "split");
  assertNonnegativeSafeInteger(baseIndex, "baseIndex");
  return `${split}/base/${baseIndex.toString()}` as TerminalClusterId;
}

/**
 * Calibration comparisons may use a style-specific trajectory cluster, but
 * all seat rotations of that style/deal remain together. The identifier
 * intentionally excludes configuration and rotation.
 */
export function calibrationClusterId(
  split: string,
  styleCellId: string,
  baseIndex: number,
): CalibrationClusterId {
  assertIdentifier(split, "split");
  assertIdentifier(styleCellId, "styleCellId");
  assertNonnegativeSafeInteger(baseIndex, "baseIndex");
  return `${split}/cell/${styleCellId}/base/${baseIndex.toString()}` as CalibrationClusterId;
}

export type CalibrationCoordinates = {
  /** Stable target/query ID within this state. */
  readonly queryId: string;
  readonly familyId: string;
  readonly stateId: string;
  /** A complete synthetic game or trajectory; rotations are separate here. */
  readonly trajectoryId: string;
  readonly calibrationClusterId: CalibrationClusterId;
  readonly terminalClusterId: TerminalClusterId;
};

export type ProbabilityEntry = {
  readonly label: string;
  readonly probability: number;
};

type PredictionBase = {
  readonly schemaVersion: typeof CALIBRATION_SCHEMA_VERSION;
  readonly predictionId: string;
  readonly arm: CalibrationArm;
  readonly coordinates: CalibrationCoordinates;
  readonly hardKnown: boolean;
};

export type BinaryPrediction = PredictionBase & {
  readonly kind: "binary";
  readonly probability: number;
};

export type CategoricalPrediction = PredictionBase & {
  readonly kind: "categorical";
  readonly distribution: readonly ProbabilityEntry[];
};

/**
 * Action predictions are prequential and therefore contain neither the
 * observed action nor the truth-derived forced/discretionary classification.
 */
export type ActionPrediction = PredictionBase & {
  readonly kind: "action";
  readonly seat: OpponentSeat;
  readonly distribution: readonly ProbabilityEntry[];
};

export type CalibrationPrediction =
  BinaryPrediction | CategoricalPrediction | ActionPrediction;

export type LogLossScore = {
  readonly value: number;
  /** True only when the un-clipped probability was exactly zero. */
  readonly rawZeroSupport: boolean;
};

export type Top1Score = {
  /** Lexicographically first label among labels tied for maximum probability. */
  readonly selectedLabel: string;
  /** All maximum-probability labels in deterministic lexicographic order. */
  readonly tiedLabels: readonly string[];
  readonly selectedCorrect: boolean;
  readonly tieAwareCorrect: boolean;
  /**
   * Fractional credit prevents a flat distribution from receiving full credit
   * merely because the observed label belongs to the tied maximum set.
   */
  readonly tieAwareCredit: number;
};

export type CredibleSetScore = {
  readonly level: CredibleLevel;
  readonly labels: readonly string[];
  readonly probabilityMass: number;
  readonly coversTruth: boolean;
};

type ScoredObservationBase = {
  readonly schemaVersion: typeof CALIBRATION_SCHEMA_VERSION;
  readonly observationId: string;
  readonly predictionId: string;
  readonly arm: CalibrationArm;
  readonly coordinates: CalibrationCoordinates;
  readonly hardKnown: boolean;
  readonly brier: number;
  readonly logLoss: number;
  readonly rawZeroSupport: boolean;
};

export type BinaryScoredObservation = ScoredObservationBase & {
  readonly kind: "binary";
  readonly truth: boolean;
  readonly probability: number;
};

export type CategoricalScoredObservation = ScoredObservationBase & {
  readonly kind: "categorical";
  readonly truthLabel: string;
  readonly distribution: readonly ProbabilityEntry[];
  readonly credibleSets: readonly CredibleSetScore[];
};

export type ActionScoredObservation = ScoredObservationBase & {
  readonly kind: "action";
  readonly seat: OpponentSeat;
  readonly decisionClass: "forced" | "discretionary";
  readonly observedLabel: string;
  readonly distribution: readonly ProbabilityEntry[];
  readonly top1: Top1Score;
};

/**
 * This union is eval-only: unlike CalibrationPrediction, it deliberately
 * contains outcome labels and derived scores.
 */
export type EvalOnlyScoredObservation =
  | BinaryScoredObservation
  | CategoricalScoredObservation
  | ActionScoredObservation;

const DISTRIBUTION_SUM_TOLERANCE = 1e-12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      throw new TypeError(`${label} contains unexpected field "${key}".`);
    }
  }
  for (const key of expected) {
    if (!(key in value)) {
      throw new TypeError(`${label} is missing required field "${key}".`);
    }
  }
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function assertBoolean(
  value: unknown,
  label: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean.`);
  }
}

function assertNonnegativeSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer.`);
  }
}

export function assertProbability(
  value: unknown,
  label = "probability",
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new RangeError(`${label} must be a finite number in [0, 1].`);
  }
}

function assertCalibrationArm(
  value: unknown,
  label: string,
): asserts value is CalibrationArm {
  if (value !== "hard-only" && value !== "behavioral") {
    throw new TypeError(`${label} must be "hard-only" or "behavioral".`);
  }
}

function assertOpponentSeat(
  value: unknown,
  label: string,
): asserts value is OpponentSeat {
  if (value !== "p2" && value !== "p3") {
    throw new TypeError(`${label} must be "p2" or "p3".`);
  }
}

function validateCoordinates(value: unknown): CalibrationCoordinates {
  if (!isRecord(value)) {
    throw new TypeError("Prediction coordinates must be an object.");
  }
  assertExactKeys(
    value,
    [
      "queryId",
      "familyId",
      "stateId",
      "trajectoryId",
      "calibrationClusterId",
      "terminalClusterId",
    ],
    "Prediction coordinates",
  );
  assertIdentifier(value.queryId, "coordinates.queryId");
  assertIdentifier(value.familyId, "coordinates.familyId");
  assertIdentifier(value.stateId, "coordinates.stateId");
  assertIdentifier(value.trajectoryId, "coordinates.trajectoryId");
  assertIdentifier(
    value.calibrationClusterId,
    "coordinates.calibrationClusterId",
  );
  assertIdentifier(value.terminalClusterId, "coordinates.terminalClusterId");
  return value as CalibrationCoordinates;
}

export function validateDistribution(
  value: unknown,
  label = "distribution",
): readonly ProbabilityEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array.`);
  }
  const labels = new Set<string>();
  const entries: ProbabilityEntry[] = [];
  let sum = 0;
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      throw new TypeError(`${label}[${index.toString()}] must be an object.`);
    }
    assertExactKeys(item, ["label", "probability"], `${label}[${index}]`);
    assertIdentifier(item.label, `${label}[${index}].label`);
    if (labels.has(item.label)) {
      throw new TypeError(`${label} contains duplicate label "${item.label}".`);
    }
    labels.add(item.label);
    assertProbability(item.probability, `${label}[${index}].probability`);
    sum += item.probability;
    entries.push({
      label: item.label,
      probability: item.probability,
    });
  }
  if (Math.abs(sum - 1) > DISTRIBUTION_SUM_TOLERANCE) {
    throw new RangeError(
      `${label} probabilities must sum to 1 within ${DISTRIBUTION_SUM_TOLERANCE.toString()}; received ${sum.toString()}.`,
    );
  }
  return Object.freeze(entries);
}

export function validateCalibrationPrediction(
  value: unknown,
): CalibrationPrediction {
  if (!isRecord(value)) {
    throw new TypeError("Calibration prediction must be an object.");
  }
  const baseKeys = [
    "schemaVersion",
    "predictionId",
    "arm",
    "coordinates",
    "hardKnown",
    "kind",
  ] as const;
  if (value.kind === "binary") {
    assertExactKeys(value, [...baseKeys, "probability"], "Binary prediction");
  } else if (value.kind === "categorical") {
    assertExactKeys(
      value,
      [...baseKeys, "distribution"],
      "Categorical prediction",
    );
  } else if (value.kind === "action") {
    assertExactKeys(
      value,
      [...baseKeys, "seat", "distribution"],
      "Action prediction",
    );
  } else {
    throw new TypeError(
      'Prediction kind must be "binary", "categorical", or "action".',
    );
  }

  if (value.schemaVersion !== CALIBRATION_SCHEMA_VERSION) {
    throw new TypeError("Unsupported calibration prediction schema version.");
  }
  assertIdentifier(value.predictionId, "predictionId");
  assertCalibrationArm(value.arm, "arm");
  const coordinates = validateCoordinates(value.coordinates);
  assertBoolean(value.hardKnown, "hardKnown");

  if (value.kind === "binary") {
    assertProbability(value.probability);
    return {
      schemaVersion: CALIBRATION_SCHEMA_VERSION,
      predictionId: value.predictionId,
      arm: value.arm,
      coordinates,
      hardKnown: value.hardKnown,
      kind: "binary",
      probability: value.probability,
    };
  }

  const distribution = validateDistribution(value.distribution);
  if (value.kind === "categorical") {
    return {
      schemaVersion: CALIBRATION_SCHEMA_VERSION,
      predictionId: value.predictionId,
      arm: value.arm,
      coordinates,
      hardKnown: value.hardKnown,
      kind: "categorical",
      distribution,
    };
  }
  assertOpponentSeat(value.seat, "seat");
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    predictionId: value.predictionId,
    arm: value.arm,
    coordinates,
    hardKnown: value.hardKnown,
    kind: "action",
    seat: value.seat,
    distribution,
  };
}

export function validateCalibrationPredictions(
  values: readonly unknown[],
): readonly CalibrationPrediction[] {
  const ids = new Set<string>();
  return Object.freeze(
    values.map((value) => {
      const prediction = validateCalibrationPrediction(value);
      if (ids.has(prediction.predictionId)) {
        throw new TypeError(
          `Duplicate predictionId "${prediction.predictionId}".`,
        );
      }
      ids.add(prediction.predictionId);
      return prediction;
    }),
  );
}

export function assertUniqueObservationIds(
  observations: readonly Pick<
    EvalOnlyScoredObservation,
    "observationId" | "predictionId"
  >[],
): void {
  const observationIds = new Set<string>();
  const predictionIds = new Set<string>();
  for (const observation of observations) {
    assertIdentifier(observation.observationId, "observationId");
    assertIdentifier(observation.predictionId, "predictionId");
    if (observationIds.has(observation.observationId)) {
      throw new TypeError(
        `Duplicate observationId "${observation.observationId}".`,
      );
    }
    if (predictionIds.has(observation.predictionId)) {
      throw new TypeError(
        `Duplicate scored predictionId "${observation.predictionId}".`,
      );
    }
    observationIds.add(observation.observationId);
    predictionIds.add(observation.predictionId);
  }
}
