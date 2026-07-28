import { stableStringify } from "../events/stable-hash";
import { createSeededRng } from "../random/keyed-rng";
import {
  PHASE8_BOOTSTRAP_RESAMPLES,
  PHASE8_MAX_CONFIGURATIONS,
  phase8Sha256,
  phase8SplitPlanSchema,
  type Phase8SplitPlan,
} from "./phase8-manifest";
export {
  PHASE8_TERMINAL_SAMPLE_SIZE_BLOCK,
  PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA,
  PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_CONTRACT,
  PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_VERSION,
  PHASE8_TERMINAL_SAMPLE_SIZE_INFLATION,
  PHASE8_TERMINAL_SAMPLE_SIZE_MARGIN,
  PHASE8_TERMINAL_SAMPLE_SIZE_MAX,
  PHASE8_TERMINAL_SAMPLE_SIZE_MIN,
  PHASE8_TERMINAL_SAMPLE_SIZE_Z,
  computePhase8TerminalSampleSize,
  type Phase8TerminalSampleSize,
} from "./phase8-sample-size";
export const PHASE8_TERMINAL_NI_MARGIN = 0.005 as const;
export const PHASE8_PRACTICAL_TIE_MARGIN = 0.0025 as const;
export const PHASE8_STYLE_CATASTROPHE_POINT = 0.05 as const;
export const PHASE8_STYLE_CATASTROPHE_LOWER = 0.02 as const;
export const PHASE8_BOOTSTRAP_MAX_CLUSTERS = 512 as const;
export const PHASE8_BOOTSTRAP_MAX_PAIRING_KEYS = 51 as const;
export const PHASE8_BOOTSTRAP_MAX_FAMILY_SIZE = 128 as const;

export const PHASE8_MATRIX_OUTCOME_STATUSES = [
  "complete",
  "failed",
  "turn-cap",
  "analysis-cap",
  "cancelled",
] as const;
export type Phase8MatrixOutcomeStatus =
  (typeof PHASE8_MATRIX_OUTCOME_STATUSES)[number];

export type Phase8MatrixOutcome = {
  readonly split: Phase8SplitPlan["split"];
  readonly configId: string;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly replicate: 0;
  readonly status: Phase8MatrixOutcomeStatus;
};

export type Phase8CompleteMatrixValidation = {
  readonly expectedOutcomes: number;
  readonly observedOutcomes: number;
  readonly uniqueExpectedCoordinatesObserved: number;
  readonly missingCount: number;
  readonly unexpectedCount: number;
  readonly duplicateCount: number;
  readonly failedCount: number;
  readonly turnCapCount: number;
  readonly analysisCapCount: number;
  readonly cancellationCount: number;
  readonly missingCoordinates: readonly string[];
  readonly unexpectedCoordinates: readonly string[];
  readonly duplicateCoordinates: readonly string[];
  readonly diagnosticsTruncated: boolean;
  readonly completeMatrixGate: boolean;
  readonly zeroFailureGate: boolean;
  readonly zeroCapGate: boolean;
  readonly zeroCancellationGate: boolean;
  readonly evidenceGate: boolean;
};

function requireConfigurationIds(
  configurationIds: readonly string[],
): readonly string[] {
  if (
    configurationIds.length === 0 ||
    configurationIds.length > PHASE8_MAX_CONFIGURATIONS
  ) {
    throw new RangeError(
      `A matrix must contain between 1 and ${PHASE8_MAX_CONFIGURATIONS.toString()} configurations.`,
    );
  }
  if (
    configurationIds.some((configId) => configId.trim().length === 0) ||
    new Set(configurationIds).size !== configurationIds.length
  ) {
    throw new Error("Matrix configuration IDs must be nonempty and unique.");
  }
  return [...configurationIds].sort();
}

function matrixCoordinate(value: Omit<Phase8MatrixOutcome, "status">): string {
  return [
    value.configId,
    value.styleCellId,
    value.baseIndex.toString(),
    value.rotation.toString(),
    value.replicate.toString(),
  ].join("/");
}

function pushDiagnostic(values: string[], value: string, limit: number): void {
  if (values.length < limit) {
    values.push(value);
  }
}

export function validatePhase8CompleteMatrix(input: {
  readonly plan: Phase8SplitPlan;
  readonly configurationIds: readonly string[];
  readonly outcomes: Iterable<Phase8MatrixOutcome>;
  readonly diagnosticLimit?: number;
}): Phase8CompleteMatrixValidation {
  const plan = phase8SplitPlanSchema.parse(input.plan);
  const configurationIds = requireConfigurationIds(input.configurationIds);
  const configurationIdSet = new Set(configurationIds);
  const styleCellSet = new Set(plan.styleCellIds);
  const rotationSet = new Set<number>(plan.rotations);
  const replicateSet = new Set<number>(plan.replicates);
  const diagnosticLimit = input.diagnosticLimit ?? 100;
  if (!Number.isSafeInteger(diagnosticLimit) || diagnosticLimit < 0) {
    throw new RangeError(
      "Matrix diagnostic limit must be a nonnegative safe integer.",
    );
  }

  const seenExpected = new Set<string>();
  const duplicates = new Set<string>();
  const unexpectedCoordinates: string[] = [];
  const duplicateCoordinates: string[] = [];
  let observedOutcomes = 0;
  let unexpectedCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;
  let turnCapCount = 0;
  let analysisCapCount = 0;
  let cancellationCount = 0;

  for (const outcome of input.outcomes) {
    observedOutcomes += 1;
    const coordinate = matrixCoordinate(outcome);
    const expected =
      outcome.split === plan.split &&
      configurationIdSet.has(outcome.configId) &&
      styleCellSet.has(outcome.styleCellId) &&
      rotationSet.has(outcome.rotation) &&
      replicateSet.has(outcome.replicate) &&
      Number.isSafeInteger(outcome.baseIndex) &&
      outcome.baseIndex >= plan.baseIndexStart &&
      outcome.baseIndex < plan.baseIndexStart + plan.baseCount;
    if (!expected) {
      unexpectedCount += 1;
      pushDiagnostic(
        unexpectedCoordinates,
        `${outcome.split}:${coordinate}`,
        diagnosticLimit,
      );
    } else if (seenExpected.has(coordinate)) {
      duplicateCount += 1;
      if (!duplicates.has(coordinate)) {
        duplicates.add(coordinate);
        pushDiagnostic(duplicateCoordinates, coordinate, diagnosticLimit);
      }
    } else {
      seenExpected.add(coordinate);
    }
    switch (outcome.status) {
      case "complete":
        break;
      case "failed":
        failedCount += 1;
        break;
      case "turn-cap":
        turnCapCount += 1;
        break;
      case "analysis-cap":
        analysisCapCount += 1;
        break;
      case "cancelled":
        cancellationCount += 1;
        break;
      default: {
        const exhaustive: never = outcome.status;
        throw new Error(`Unknown matrix status ${String(exhaustive)}.`);
      }
    }
  }

  const expectedOutcomes =
    configurationIds.length *
    plan.styleCellIds.length *
    plan.baseCount *
    plan.rotations.length *
    plan.replicates.length;
  let missingCount = 0;
  const missingCoordinates: string[] = [];
  for (const configId of configurationIds) {
    for (const styleCellId of plan.styleCellIds) {
      for (
        let baseIndex = plan.baseIndexStart;
        baseIndex < plan.baseIndexStart + plan.baseCount;
        baseIndex += 1
      ) {
        for (const rotation of plan.rotations) {
          for (const replicate of plan.replicates) {
            const coordinate = matrixCoordinate({
              split: plan.split,
              configId,
              styleCellId,
              baseIndex,
              rotation,
              replicate,
            });
            if (!seenExpected.has(coordinate)) {
              missingCount += 1;
              pushDiagnostic(missingCoordinates, coordinate, diagnosticLimit);
            }
          }
        }
      }
    }
  }
  const completeMatrixGate =
    missingCount === 0 &&
    unexpectedCount === 0 &&
    duplicateCount === 0 &&
    seenExpected.size === expectedOutcomes;
  const zeroFailureGate = failedCount === 0;
  const zeroCapGate = turnCapCount === 0 && analysisCapCount === 0;
  const zeroCancellationGate = cancellationCount === 0;
  return {
    expectedOutcomes,
    observedOutcomes,
    uniqueExpectedCoordinatesObserved: seenExpected.size,
    missingCount,
    unexpectedCount,
    duplicateCount,
    failedCount,
    turnCapCount,
    analysisCapCount,
    cancellationCount,
    missingCoordinates,
    unexpectedCoordinates,
    duplicateCoordinates,
    diagnosticsTruncated:
      missingCoordinates.length < missingCount ||
      unexpectedCoordinates.length < unexpectedCount ||
      duplicateCoordinates.length < duplicates.size,
    completeMatrixGate,
    zeroFailureGate,
    zeroCapGate,
    zeroCancellationGate,
    evidenceGate:
      completeMatrixGate &&
      zeroFailureGate &&
      zeroCapGate &&
      zeroCancellationGate,
  };
}

export type Phase8ClusterMetricObservation = {
  /**
   * The base-index cluster. Every configuration is resampled together.
   */
  readonly clusterId: string;
  /**
   * A crossed scenario within the cluster, normally style/rotation/replicate.
   */
  readonly pairingKey: string;
  readonly configId: string;
  readonly metrics: Readonly<Record<string, number>>;
};

export type Phase8SimultaneousContrast = {
  readonly contrastId: string;
  readonly candidateConfigId: string;
  readonly referenceConfigId: string;
  readonly metricId: string;
  readonly estimate: number;
  readonly standardError: number;
  readonly oneSidedLower: number;
  readonly oneSidedUpper: number;
  readonly twoSidedLower: number;
  readonly twoSidedUpper: number;
};

export type Phase8PairedBootstrapResult = {
  readonly method: "crossed-paired-cluster-bootstrap-max-statistic-v1";
  readonly confidenceLevel: number;
  readonly resamples: number;
  readonly seedId: string;
  readonly clusterCount: number;
  readonly pairingKeysPerCluster: number;
  readonly familySize: number;
  readonly referenceConfigId: string;
  readonly candidateConfigIds: readonly string[];
  readonly metricIds: readonly string[];
  readonly oneSidedUpperCriticalValue: number;
  readonly oneSidedLowerCriticalValue: number;
  readonly twoSidedCriticalValue: number;
  readonly contrasts: readonly Phase8SimultaneousContrast[];
  readonly resultSha256: string;
};

type ContrastWork = {
  readonly contrastId: string;
  readonly candidateConfigId: string;
  readonly metricId: string;
  readonly clusterDifferences: readonly number[];
  readonly estimate: number;
  readonly standardError: number;
};

function requireIdentifierList(
  values: readonly string[],
  label: string,
): readonly string[] {
  if (
    values.length === 0 ||
    values.some((value) => value.trim().length === 0) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`${label} must be nonempty, unique identifiers.`);
  }
  return [...values].sort();
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("Cannot average an empty collection.");
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

function standardError(values: readonly number[], mean: number): number {
  if (values.length < 2) {
    throw new RangeError(
      "Paired cluster inference requires at least two clusters.",
    );
  }
  let squaredDeviation = 0;
  for (const value of values) {
    const deviation = value - mean;
    squaredDeviation += deviation * deviation;
  }
  const sampleVariance = squaredDeviation / (values.length - 1);
  return Math.sqrt(sampleVariance / values.length);
}

function empiricalQuantile(values: number[], probability: number): number {
  if (values.length === 0) {
    throw new RangeError("Cannot select a quantile from an empty collection.");
  }
  values.sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(probability * values.length) - 1);
  const value = values[rank];
  if (value === undefined) {
    throw new Error("Empirical quantile rank is outside the sample.");
  }
  return value;
}

function standardizedDeviation(
  deviation: number,
  standardErrorValue: number,
): number {
  if (standardErrorValue === 0) {
    return deviation === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return deviation / standardErrorValue;
}

function metricValue(
  observation: Phase8ClusterMetricObservation,
  metricId: string,
): number {
  const value = observation.metrics[metricId];
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(
      `Observation ${observation.clusterId}/${observation.pairingKey}/${observation.configId} lacks finite metric ${metricId}.`,
    );
  }
  return value;
}

export function crossedPairedClusterBootstrap(input: {
  readonly observations: Iterable<Phase8ClusterMetricObservation>;
  readonly referenceConfigId: string;
  readonly candidateConfigIds: readonly string[];
  readonly metricIds: readonly string[];
  readonly seed: string;
  readonly resamples?: number;
  readonly confidenceLevel?: number;
}): Phase8PairedBootstrapResult {
  const candidateConfigIds = requireIdentifierList(
    input.candidateConfigIds,
    "Candidate configuration IDs",
  );
  const metricIds = requireIdentifierList(input.metricIds, "Metric IDs");
  if (
    input.referenceConfigId.trim().length === 0 ||
    candidateConfigIds.includes(input.referenceConfigId)
  ) {
    throw new Error(
      "Reference configuration must be nonempty and distinct from candidates.",
    );
  }
  if (candidateConfigIds.length + 1 > PHASE8_MAX_CONFIGURATIONS) {
    throw new RangeError(
      `Bootstrap family exceeds ${PHASE8_MAX_CONFIGURATIONS.toString()} configurations.`,
    );
  }
  const confidenceLevel = input.confidenceLevel ?? 0.95;
  if (
    !Number.isFinite(confidenceLevel) ||
    confidenceLevel <= 0.5 ||
    confidenceLevel >= 1
  ) {
    throw new RangeError(
      "Bootstrap confidence level must be between 0.5 and 1.",
    );
  }
  const resamples = input.resamples ?? PHASE8_BOOTSTRAP_RESAMPLES;
  if (
    !Number.isSafeInteger(resamples) ||
    resamples < 100 ||
    resamples > PHASE8_BOOTSTRAP_RESAMPLES
  ) {
    throw new RangeError(
      `Bootstrap resamples must be a safe integer from 100 through ${PHASE8_BOOTSTRAP_RESAMPLES.toString()}.`,
    );
  }
  if (input.seed.trim().length === 0) {
    throw new Error("Bootstrap seed must be nonempty.");
  }

  const allConfigIds = [input.referenceConfigId, ...candidateConfigIds];
  const configIdSet = new Set(allConfigIds);
  const clusters = new Map<
    string,
    Map<string, Map<string, Phase8ClusterMetricObservation>>
  >();
  for (const observation of input.observations) {
    if (
      observation.clusterId.trim().length === 0 ||
      observation.pairingKey.trim().length === 0 ||
      !configIdSet.has(observation.configId)
    ) {
      throw new Error(
        "Bootstrap observations must use declared nonempty cluster, pairing, and configuration IDs.",
      );
    }
    for (const metricId of metricIds) {
      metricValue(observation, metricId);
    }
    const cluster =
      clusters.get(observation.clusterId) ??
      new Map<string, Map<string, Phase8ClusterMetricObservation>>();
    if (
      !clusters.has(observation.clusterId) &&
      clusters.size >= PHASE8_BOOTSTRAP_MAX_CLUSTERS
    ) {
      throw new RangeError(
        `Bootstrap input exceeds ${PHASE8_BOOTSTRAP_MAX_CLUSTERS.toString()} clusters.`,
      );
    }
    const config =
      cluster.get(observation.configId) ??
      new Map<string, Phase8ClusterMetricObservation>();
    if (config.has(observation.pairingKey)) {
      throw new Error(
        `Duplicate paired observation ${observation.clusterId}/${observation.pairingKey}/${observation.configId}.`,
      );
    }
    if (config.size >= PHASE8_BOOTSTRAP_MAX_PAIRING_KEYS) {
      throw new RangeError(
        `Bootstrap cluster/configuration exceeds ${PHASE8_BOOTSTRAP_MAX_PAIRING_KEYS.toString()} pairing keys.`,
      );
    }
    config.set(observation.pairingKey, observation);
    cluster.set(observation.configId, config);
    clusters.set(observation.clusterId, cluster);
  }
  const clusterIds = [...clusters.keys()].sort();
  if (clusterIds.length < 2) {
    throw new RangeError(
      "Paired cluster bootstrap requires at least two clusters.",
    );
  }

  let canonicalPairingKeys: readonly string[] | null = null;
  for (const clusterId of clusterIds) {
    const cluster = clusters.get(clusterId);
    if (cluster === undefined) {
      throw new Error(`Missing cluster ${clusterId}.`);
    }
    if (
      cluster.size !== allConfigIds.length ||
      allConfigIds.some((configId) => !cluster.has(configId))
    ) {
      throw new Error(
        `Cluster ${clusterId} does not contain every declared configuration.`,
      );
    }
    const reference = cluster.get(input.referenceConfigId);
    if (reference === undefined || reference.size === 0) {
      throw new Error(
        `Cluster ${clusterId} has no reference pairing coordinates.`,
      );
    }
    const pairingKeys = [...reference.keys()].sort();
    for (const configId of allConfigIds) {
      const configPairingKeys = [
        ...(cluster.get(configId)?.keys() ?? []),
      ].sort();
      if (stableStringify(configPairingKeys) !== stableStringify(pairingKeys)) {
        throw new Error(
          `Cluster ${clusterId} is not completely crossed for ${configId}.`,
        );
      }
    }
    if (canonicalPairingKeys === null) {
      canonicalPairingKeys = pairingKeys;
    } else if (
      stableStringify(pairingKeys) !== stableStringify(canonicalPairingKeys)
    ) {
      throw new Error(
        `Cluster ${clusterId} does not retain the common crossed pairing suite.`,
      );
    }
  }
  if (canonicalPairingKeys === null) {
    throw new Error("Bootstrap observation set is empty.");
  }

  const contrasts: ContrastWork[] = [];
  if (
    candidateConfigIds.length * metricIds.length >
    PHASE8_BOOTSTRAP_MAX_FAMILY_SIZE
  ) {
    throw new RangeError(
      `Bootstrap family exceeds ${PHASE8_BOOTSTRAP_MAX_FAMILY_SIZE.toString()} simultaneous contrasts.`,
    );
  }
  for (const candidateConfigId of candidateConfigIds) {
    for (const metricId of metricIds) {
      const clusterDifferences: number[] = [];
      for (const clusterId of clusterIds) {
        const cluster = clusters.get(clusterId);
        const reference = cluster?.get(input.referenceConfigId);
        const candidate = cluster?.get(candidateConfigId);
        if (reference === undefined || candidate === undefined) {
          throw new Error("Validated crossed cluster disappeared.");
        }
        let referenceTotal = 0;
        let candidateTotal = 0;
        for (const pairingKey of canonicalPairingKeys) {
          const referenceObservation = reference.get(pairingKey);
          const candidateObservation = candidate.get(pairingKey);
          if (
            referenceObservation === undefined ||
            candidateObservation === undefined
          ) {
            throw new Error("Validated paired observation disappeared.");
          }
          referenceTotal += metricValue(referenceObservation, metricId);
          candidateTotal += metricValue(candidateObservation, metricId);
        }
        clusterDifferences.push(
          (candidateTotal - referenceTotal) / canonicalPairingKeys.length,
        );
      }
      const estimate = average(clusterDifferences);
      contrasts.push({
        contrastId: `${candidateConfigId}::${metricId}`,
        candidateConfigId,
        metricId,
        clusterDifferences,
        estimate,
        standardError: standardError(clusterDifferences, estimate),
      });
    }
  }

  const familyContract = {
    method: "crossed-paired-cluster-bootstrap-max-statistic-v1",
    referenceConfigId: input.referenceConfigId,
    candidateConfigIds,
    metricIds,
    clusterIds,
    pairingKeys: canonicalPairingKeys,
    confidenceLevel,
    resamples,
  };
  const rng = createSeededRng(input.seed).fork(
    "phase8-crossed-paired-cluster-bootstrap-v1",
    phase8Sha256(familyContract),
  );
  const upperMaxima: number[] = [];
  const lowerMaxima: number[] = [];
  const twoSidedMaxima: number[] = [];
  const totals = new Float64Array(contrasts.length);
  for (let resample = 0; resample < resamples; resample += 1) {
    totals.fill(0);
    for (let draw = 0; draw < clusterIds.length; draw += 1) {
      const clusterIndex = rng.nextInt(clusterIds.length);
      for (
        let contrastIndex = 0;
        contrastIndex < contrasts.length;
        contrastIndex += 1
      ) {
        totals[contrastIndex] =
          (totals[contrastIndex] ?? 0) +
          (contrasts[contrastIndex]?.clusterDifferences[clusterIndex] ?? 0);
      }
    }
    let maximumUpper = Number.NEGATIVE_INFINITY;
    let maximumLower = Number.NEGATIVE_INFINITY;
    let maximumTwoSided = 0;
    for (
      let contrastIndex = 0;
      contrastIndex < contrasts.length;
      contrastIndex += 1
    ) {
      const contrast = contrasts[contrastIndex];
      if (contrast === undefined) {
        continue;
      }
      const bootstrapEstimate =
        (totals[contrastIndex] ?? 0) / clusterIds.length;
      const standardized = standardizedDeviation(
        bootstrapEstimate - contrast.estimate,
        contrast.standardError,
      );
      maximumUpper = Math.max(maximumUpper, standardized);
      maximumLower = Math.max(maximumLower, -standardized);
      maximumTwoSided = Math.max(maximumTwoSided, Math.abs(standardized));
    }
    upperMaxima.push(maximumUpper);
    lowerMaxima.push(maximumLower);
    twoSidedMaxima.push(maximumTwoSided);
  }
  const oneSidedUpperCriticalValue = empiricalQuantile(
    upperMaxima,
    confidenceLevel,
  );
  const oneSidedLowerCriticalValue = empiricalQuantile(
    lowerMaxima,
    confidenceLevel,
  );
  const twoSidedCriticalValue = empiricalQuantile(
    twoSidedMaxima,
    confidenceLevel,
  );
  const simultaneousContrasts: Phase8SimultaneousContrast[] = contrasts.map(
    (contrast) => ({
      contrastId: contrast.contrastId,
      candidateConfigId: contrast.candidateConfigId,
      referenceConfigId: input.referenceConfigId,
      metricId: contrast.metricId,
      estimate: contrast.estimate,
      standardError: contrast.standardError,
      oneSidedLower:
        contrast.estimate - oneSidedLowerCriticalValue * contrast.standardError,
      oneSidedUpper:
        contrast.estimate + oneSidedUpperCriticalValue * contrast.standardError,
      twoSidedLower:
        contrast.estimate - twoSidedCriticalValue * contrast.standardError,
      twoSidedUpper:
        contrast.estimate + twoSidedCriticalValue * contrast.standardError,
    }),
  );
  const resultWithoutHash = {
    method: "crossed-paired-cluster-bootstrap-max-statistic-v1" as const,
    confidenceLevel,
    resamples,
    seedId: createSeededRng(input.seed).seedId,
    clusterCount: clusterIds.length,
    pairingKeysPerCluster: canonicalPairingKeys.length,
    familySize: simultaneousContrasts.length,
    referenceConfigId: input.referenceConfigId,
    candidateConfigIds,
    metricIds,
    oneSidedUpperCriticalValue,
    oneSidedLowerCriticalValue,
    twoSidedCriticalValue,
    contrasts: simultaneousContrasts,
  };
  return {
    ...resultWithoutHash,
    resultSha256: phase8Sha256(resultWithoutHash),
  };
}

export type Phase8TerminalGateResult = {
  readonly estimate: number;
  readonly oneSidedUpper: number;
  readonly twoSidedLower: number;
  readonly twoSidedUpper: number;
  readonly noninferiorityMargin: typeof PHASE8_TERMINAL_NI_MARGIN;
  readonly practicalTieMargin: typeof PHASE8_PRACTICAL_TIE_MARGIN;
  readonly noninferiorityGate: boolean;
  readonly improvementGate: boolean;
  readonly finalBeatsGate: boolean;
  readonly practicalTieGate: boolean;
};

export function evaluatePhase8TerminalGate(
  contrast: Pick<
    Phase8SimultaneousContrast,
    "estimate" | "oneSidedUpper" | "twoSidedLower" | "twoSidedUpper"
  >,
): Phase8TerminalGateResult {
  for (const value of [
    contrast.estimate,
    contrast.oneSidedUpper,
    contrast.twoSidedLower,
    contrast.twoSidedUpper,
  ]) {
    if (!Number.isFinite(value)) {
      throw new Error("Terminal contrast bounds must be finite.");
    }
  }
  return {
    estimate: contrast.estimate,
    oneSidedUpper: contrast.oneSidedUpper,
    twoSidedLower: contrast.twoSidedLower,
    twoSidedUpper: contrast.twoSidedUpper,
    noninferiorityMargin: PHASE8_TERMINAL_NI_MARGIN,
    practicalTieMargin: PHASE8_PRACTICAL_TIE_MARGIN,
    noninferiorityGate: contrast.oneSidedUpper < PHASE8_TERMINAL_NI_MARGIN,
    improvementGate: contrast.oneSidedUpper < 0,
    finalBeatsGate: contrast.twoSidedUpper < 0,
    practicalTieGate:
      Math.abs(contrast.estimate) <= PHASE8_PRACTICAL_TIE_MARGIN &&
      contrast.twoSidedLower <= 0 &&
      contrast.twoSidedUpper >= 0,
  };
}

export type Phase8StyleCatastropheGate = {
  readonly estimate: number;
  readonly oneSidedLower: number;
  readonly pointThreshold: typeof PHASE8_STYLE_CATASTROPHE_POINT;
  readonly lowerThreshold: typeof PHASE8_STYLE_CATASTROPHE_LOWER;
  readonly catastrophic: boolean;
  readonly styleSafetyGate: boolean;
};

export function evaluatePhase8StyleCatastrophe(
  contrast: Pick<Phase8SimultaneousContrast, "estimate" | "oneSidedLower">,
): Phase8StyleCatastropheGate {
  if (
    !Number.isFinite(contrast.estimate) ||
    !Number.isFinite(contrast.oneSidedLower)
  ) {
    throw new Error("Style contrast bounds must be finite.");
  }
  const catastrophic =
    contrast.estimate >= PHASE8_STYLE_CATASTROPHE_POINT &&
    contrast.oneSidedLower > PHASE8_STYLE_CATASTROPHE_LOWER;
  return {
    estimate: contrast.estimate,
    oneSidedLower: contrast.oneSidedLower,
    pointThreshold: PHASE8_STYLE_CATASTROPHE_POINT,
    lowerThreshold: PHASE8_STYLE_CATASTROPHE_LOWER,
    catastrophic,
    styleSafetyGate: !catastrophic,
  };
}
