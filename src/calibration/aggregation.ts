import { createSeededRng } from "../random/keyed-rng";
import {
  assertUniqueObservationIds,
  type ActionScoredObservation,
  type CalibrationCoordinates,
  type CalibrationClusterId,
  type OpponentSeat,
} from "./types";

export type MetricObservation = {
  readonly observationId: string;
  readonly coordinates: CalibrationCoordinates;
  readonly value: number;
};

export type QueryMean = {
  readonly calibrationClusterId: CalibrationClusterId;
  readonly trajectoryId: string;
  readonly stateId: string;
  readonly familyId: string;
  readonly queryId: string;
  readonly observationCount: number;
  readonly value: number;
};

export type FamilyMean = {
  readonly calibrationClusterId: CalibrationClusterId;
  readonly trajectoryId: string;
  readonly stateId: string;
  readonly familyId: string;
  readonly queryCount: number;
  readonly value: number;
};

export type StateMean = {
  readonly calibrationClusterId: CalibrationClusterId;
  readonly trajectoryId: string;
  readonly stateId: string;
  readonly familyCount: number;
  readonly value: number;
};

export type TrajectoryMean = {
  readonly calibrationClusterId: CalibrationClusterId;
  readonly trajectoryId: string;
  readonly stateCount: number;
  readonly value: number;
};

export type ClusterMean = {
  readonly calibrationClusterId: CalibrationClusterId;
  readonly trajectoryCount: number;
  readonly value: number;
};

export type NestedAggregation = {
  readonly observationCount: number;
  readonly queryMeans: readonly QueryMean[];
  readonly familyMeans: readonly FamilyMean[];
  readonly stateMeans: readonly StateMean[];
  readonly trajectoryMeans: readonly TrajectoryMean[];
  readonly clusterMeans: readonly ClusterMean[];
  /** Equal-weight mean of cluster means. */
  readonly value: number;
};

export type PairedClusterDifference = {
  readonly calibrationClusterId: CalibrationClusterId;
  readonly candidate: number;
  readonly reference: number;
  readonly difference: number;
};

export type PairedBootstrapOptions = {
  readonly resamples: number;
  readonly seed: string;
  readonly confidenceLevel?: number;
};

export type PairedBootstrapResult = {
  readonly method: "paired-cluster-bootstrap-percentile";
  readonly confidenceLevel: number;
  readonly resamples: number;
  readonly seedId: string;
  readonly clusterCount: number;
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
};

export type CalibrationSampleSizeOptions = {
  readonly standardDeviation: number;
  readonly zMultiplier?: number;
  readonly targetHalfWidth?: number;
  readonly inflationFactor?: number;
  readonly blockSize?: number;
  readonly minimumClusters?: number;
  readonly maximumClusters?: number;
};

export type CalibrationSampleSize = {
  readonly standardDeviation: number;
  readonly zMultiplier: number;
  readonly targetHalfWidth: number;
  readonly inflationFactor: number;
  readonly blockSize: number;
  readonly minimumClusters: number;
  readonly maximumClusters: number;
  /** ceil((z * sd / targetHalfWidth)^2), before inflation. */
  readonly formulaClusters: number;
  readonly inflatedClusters: number;
  readonly blockRoundedClusters: number;
  /** The block-rounded count clamped to [minimumClusters, maximumClusters]. */
  readonly selectedClusters: number;
  readonly clamp: "minimum" | "maximum" | "none";
};

export type ActionStratumSummary = {
  readonly seat: OpponentSeat;
  readonly decisionClass: "forced" | "discretionary";
  readonly observationCount: number;
  readonly rawZeroSupportCount: number;
  readonly brier: NestedAggregation;
  readonly logLoss: NestedAggregation;
  readonly selectedTop1Accuracy: NestedAggregation;
  readonly tieAwareTopSetAccuracy: NestedAggregation;
  readonly tieAwareTop1Credit: NestedAggregation;
};

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite.`);
  }
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("Cannot average an empty collection.");
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function key(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function groupBy<T>(
  values: readonly T[],
  keyForValue: (value: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = keyForValue(value);
    const group = groups.get(groupKey);
    if (group === undefined) {
      groups.set(groupKey, [value]);
    } else {
      group.push(value);
    }
  }
  return groups;
}

function assertNonEmptyId(value: string, label: string): void {
  if (value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function assertCoordinates(
  coordinates: CalibrationCoordinates,
  observationId: string,
): void {
  assertNonEmptyId(coordinates.queryId, `${observationId}.queryId`);
  assertNonEmptyId(coordinates.familyId, `${observationId}.familyId`);
  assertNonEmptyId(coordinates.stateId, `${observationId}.stateId`);
  assertNonEmptyId(coordinates.trajectoryId, `${observationId}.trajectoryId`);
  assertNonEmptyId(
    coordinates.calibrationClusterId,
    `${observationId}.calibrationClusterId`,
  );
  assertNonEmptyId(
    coordinates.terminalClusterId,
    `${observationId}.terminalClusterId`,
  );
}

export function aggregateNested(
  observations: readonly MetricObservation[],
): NestedAggregation {
  if (observations.length === 0) {
    throw new RangeError(
      "Nested aggregation requires at least one observation.",
    );
  }
  const ids = new Set<string>();
  for (const observation of observations) {
    assertNonEmptyId(observation.observationId, "observationId");
    if (ids.has(observation.observationId)) {
      throw new TypeError(
        `Duplicate metric observationId "${observation.observationId}".`,
      );
    }
    ids.add(observation.observationId);
    assertCoordinates(observation.coordinates, observation.observationId);
    assertFinite(observation.value, `${observation.observationId}.value`);
  }

  const queryMeans = [
    ...groupBy(observations, (observation) =>
      key([
        observation.coordinates.calibrationClusterId,
        observation.coordinates.trajectoryId,
        observation.coordinates.stateId,
        observation.coordinates.familyId,
        observation.coordinates.queryId,
      ]),
    ).values(),
  ]
    .map((group): QueryMean => {
      const first = group[0];
      if (first === undefined) {
        throw new Error("Grouped query cannot be empty.");
      }
      return {
        calibrationClusterId: first.coordinates.calibrationClusterId,
        trajectoryId: first.coordinates.trajectoryId,
        stateId: first.coordinates.stateId,
        familyId: first.coordinates.familyId,
        queryId: first.coordinates.queryId,
        observationCount: group.length,
        value: mean(group.map((observation) => observation.value)),
      };
    })
    .sort((left, right) =>
      compareText(
        key([
          left.calibrationClusterId,
          left.trajectoryId,
          left.stateId,
          left.familyId,
          left.queryId,
        ]),
        key([
          right.calibrationClusterId,
          right.trajectoryId,
          right.stateId,
          right.familyId,
          right.queryId,
        ]),
      ),
    );

  const familyMeans = [
    ...groupBy(queryMeans, (query) =>
      key([
        query.calibrationClusterId,
        query.trajectoryId,
        query.stateId,
        query.familyId,
      ]),
    ).values(),
  ]
    .map((group): FamilyMean => {
      const first = group[0];
      if (first === undefined) {
        throw new Error("Grouped family cannot be empty.");
      }
      return {
        calibrationClusterId: first.calibrationClusterId,
        trajectoryId: first.trajectoryId,
        stateId: first.stateId,
        familyId: first.familyId,
        queryCount: group.length,
        value: mean(group.map((query) => query.value)),
      };
    })
    .sort((left, right) =>
      compareText(
        key([
          left.calibrationClusterId,
          left.trajectoryId,
          left.stateId,
          left.familyId,
        ]),
        key([
          right.calibrationClusterId,
          right.trajectoryId,
          right.stateId,
          right.familyId,
        ]),
      ),
    );

  const stateMeans = [
    ...groupBy(familyMeans, (family) =>
      key([family.calibrationClusterId, family.trajectoryId, family.stateId]),
    ).values(),
  ]
    .map((group): StateMean => {
      const first = group[0];
      if (first === undefined) {
        throw new Error("Grouped state cannot be empty.");
      }
      return {
        calibrationClusterId: first.calibrationClusterId,
        trajectoryId: first.trajectoryId,
        stateId: first.stateId,
        familyCount: group.length,
        value: mean(group.map((family) => family.value)),
      };
    })
    .sort((left, right) =>
      compareText(
        key([left.calibrationClusterId, left.trajectoryId, left.stateId]),
        key([right.calibrationClusterId, right.trajectoryId, right.stateId]),
      ),
    );

  const trajectoryMeans = [
    ...groupBy(stateMeans, (state) =>
      key([state.calibrationClusterId, state.trajectoryId]),
    ).values(),
  ]
    .map((group): TrajectoryMean => {
      const first = group[0];
      if (first === undefined) {
        throw new Error("Grouped trajectory cannot be empty.");
      }
      return {
        calibrationClusterId: first.calibrationClusterId,
        trajectoryId: first.trajectoryId,
        stateCount: group.length,
        value: mean(group.map((state) => state.value)),
      };
    })
    .sort((left, right) =>
      compareText(
        key([left.calibrationClusterId, left.trajectoryId]),
        key([right.calibrationClusterId, right.trajectoryId]),
      ),
    );

  const clusterMeans = [
    ...groupBy(trajectoryMeans, (trajectory) =>
      key([trajectory.calibrationClusterId]),
    ).values(),
  ]
    .map((group): ClusterMean => {
      const first = group[0];
      if (first === undefined) {
        throw new Error("Grouped cluster cannot be empty.");
      }
      return {
        calibrationClusterId: first.calibrationClusterId,
        trajectoryCount: group.length,
        value: mean(group.map((trajectory) => trajectory.value)),
      };
    })
    .sort((left, right) =>
      compareText(left.calibrationClusterId, right.calibrationClusterId),
    );

  return {
    observationCount: observations.length,
    queryMeans,
    familyMeans,
    stateMeans,
    trajectoryMeans,
    clusterMeans,
    value: mean(clusterMeans.map((cluster) => cluster.value)),
  };
}

function hierarchySignature(
  observations: readonly MetricObservation[],
): readonly string[] {
  return observations
    .map((observation) =>
      key([
        observation.coordinates.calibrationClusterId,
        observation.coordinates.trajectoryId,
        observation.coordinates.stateId,
        observation.coordinates.familyId,
        observation.coordinates.queryId,
      ]),
    )
    .sort(compareText);
}

export function pairedClusterDifferences(
  candidate: readonly MetricObservation[],
  reference: readonly MetricObservation[],
): readonly PairedClusterDifference[] {
  const candidateSignature = hierarchySignature(candidate);
  const referenceSignature = hierarchySignature(reference);
  if (
    candidateSignature.length !== referenceSignature.length ||
    candidateSignature.some(
      (signature, index) => signature !== referenceSignature[index],
    )
  ) {
    throw new RangeError(
      "Paired observations must contain the same nested query hierarchy.",
    );
  }
  const candidateAggregation = aggregateNested(candidate);
  const referenceAggregation = aggregateNested(reference);
  const referenceByCluster = new Map(
    referenceAggregation.clusterMeans.map((cluster) => [
      cluster.calibrationClusterId,
      cluster,
    ]),
  );
  const pairs = candidateAggregation.clusterMeans.map((cluster) => {
    const referenceCluster = referenceByCluster.get(
      cluster.calibrationClusterId,
    );
    if (referenceCluster === undefined) {
      throw new RangeError(
        `Reference is missing calibration cluster "${cluster.calibrationClusterId}".`,
      );
    }
    return {
      calibrationClusterId: cluster.calibrationClusterId,
      candidate: cluster.value,
      reference: referenceCluster.value,
      difference: cluster.value - referenceCluster.value,
    };
  });
  if (pairs.length !== referenceAggregation.clusterMeans.length) {
    throw new RangeError("Candidate and reference cluster sets differ.");
  }
  return Object.freeze(pairs);
}

function quantile(sorted: readonly number[], probability: number): number {
  const index = Math.floor((sorted.length - 1) * probability);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("Cannot select a percentile from an empty sample.");
  }
  return value;
}

export function percentileBootstrapPairedClusters(
  pairs: readonly PairedClusterDifference[],
  options: PairedBootstrapOptions,
): PairedBootstrapResult {
  if (pairs.length === 0) {
    throw new RangeError("Paired bootstrap requires at least one cluster.");
  }
  if (!Number.isSafeInteger(options.resamples) || options.resamples < 1) {
    throw new RangeError(
      "Bootstrap resamples must be a positive safe integer.",
    );
  }
  assertNonEmptyId(options.seed, "bootstrap seed");
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  if (
    !Number.isFinite(confidenceLevel) ||
    confidenceLevel <= 0 ||
    confidenceLevel >= 1
  ) {
    throw new RangeError("confidenceLevel must be finite and between 0 and 1.");
  }
  const clusterIds = new Set<string>();
  for (const pair of pairs) {
    assertNonEmptyId(pair.calibrationClusterId, "calibrationClusterId");
    if (clusterIds.has(pair.calibrationClusterId)) {
      throw new TypeError(
        `Duplicate calibration cluster "${pair.calibrationClusterId}".`,
      );
    }
    clusterIds.add(pair.calibrationClusterId);
    assertFinite(pair.candidate, "candidate cluster mean");
    assertFinite(pair.reference, "reference cluster mean");
    assertFinite(pair.difference, "paired cluster difference");
    if (pair.difference !== pair.candidate - pair.reference) {
      throw new RangeError(
        "Paired difference must equal candidate minus reference.",
      );
    }
  }

  const rng = createSeededRng(options.seed).fork(
    "calibration-paired-cluster-bootstrap",
    pairs.length,
    options.resamples,
  );
  const estimates: number[] = [];
  for (let resample = 0; resample < options.resamples; resample += 1) {
    let total = 0;
    for (let draw = 0; draw < pairs.length; draw += 1) {
      const pair = pairs[rng.nextInt(pairs.length)];
      if (pair === undefined) {
        throw new Error("Bootstrap selected an absent cluster.");
      }
      total += pair.difference;
    }
    estimates.push(total / pairs.length);
  }
  estimates.sort((left, right) => left - right);
  const tail = (1 - confidenceLevel) / 2;
  return {
    method: "paired-cluster-bootstrap-percentile",
    confidenceLevel,
    resamples: options.resamples,
    seedId: rng.seedId,
    clusterCount: pairs.length,
    estimate: mean(pairs.map((pair) => pair.difference)),
    lower: quantile(estimates, tail),
    upper: quantile(estimates, 1 - tail),
  };
}

export function pairedNestedBootstrap(
  candidate: readonly MetricObservation[],
  reference: readonly MetricObservation[],
  options: PairedBootstrapOptions,
): PairedBootstrapResult {
  return percentileBootstrapPairedClusters(
    pairedClusterDifferences(candidate, reference),
    options,
  );
}

export function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) {
    throw new RangeError(
      "Sample standard deviation requires at least two observations.",
    );
  }
  for (const value of values) {
    assertFinite(value, "sample value");
  }
  const average = mean(values);
  const squaredDeviationTotal = values.reduce(
    (total, value) => total + (value - average) ** 2,
    0,
  );
  return Math.sqrt(squaredDeviationTotal / (values.length - 1));
}

export function calibrationSampleSize(
  options: CalibrationSampleSizeOptions,
): CalibrationSampleSize {
  const zMultiplier = options.zMultiplier ?? 1.96;
  const targetHalfWidth = options.targetHalfWidth ?? 0.005;
  const inflationFactor = options.inflationFactor ?? 1.1;
  const blockSize = options.blockSize ?? 16;
  const minimumClusters = options.minimumClusters ?? 1_000;
  const maximumClusters = options.maximumClusters ?? 10_000;

  assertFinite(options.standardDeviation, "standardDeviation");
  if (options.standardDeviation < 0) {
    throw new RangeError("standardDeviation must be nonnegative.");
  }
  for (const [value, label] of [
    [zMultiplier, "zMultiplier"],
    [targetHalfWidth, "targetHalfWidth"],
    [inflationFactor, "inflationFactor"],
  ] as const) {
    assertFinite(value, label);
    if (value <= 0) {
      throw new RangeError(`${label} must be positive.`);
    }
  }
  if (inflationFactor < 1) {
    throw new RangeError("inflationFactor must be at least 1.");
  }
  for (const [value, label] of [
    [blockSize, "blockSize"],
    [minimumClusters, "minimumClusters"],
    [maximumClusters, "maximumClusters"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${label} must be a positive safe integer.`);
    }
  }
  if (minimumClusters > maximumClusters) {
    throw new RangeError(
      "minimumClusters cannot be greater than maximumClusters.",
    );
  }

  const formulaClusters = Math.ceil(
    ((zMultiplier * options.standardDeviation) / targetHalfWidth) ** 2,
  );
  if (!Number.isSafeInteger(formulaClusters)) {
    throw new RangeError("Calculated sample size exceeds safe integer range.");
  }
  const inflatedClusters = Math.ceil(formulaClusters * inflationFactor);
  const blockRoundedClusters =
    Math.ceil(inflatedClusters / blockSize) * blockSize;
  const selectedClusters = Math.min(
    maximumClusters,
    Math.max(minimumClusters, blockRoundedClusters),
  );
  const clamp =
    selectedClusters === minimumClusters &&
    blockRoundedClusters < minimumClusters
      ? "minimum"
      : selectedClusters === maximumClusters &&
          blockRoundedClusters > maximumClusters
        ? "maximum"
        : "none";

  return {
    standardDeviation: options.standardDeviation,
    zMultiplier,
    targetHalfWidth,
    inflationFactor,
    blockSize,
    minimumClusters,
    maximumClusters,
    formulaClusters,
    inflatedClusters,
    blockRoundedClusters,
    selectedClusters,
    clamp,
  };
}

function metricObservation(
  observation: ActionScoredObservation,
  metric: string,
  value: number,
): MetricObservation {
  return {
    observationId: `${observation.observationId}/${metric}`,
    coordinates: observation.coordinates,
    value,
  };
}

export function aggregateActionScores(
  observations: readonly ActionScoredObservation[],
): readonly ActionStratumSummary[] {
  assertUniqueObservationIds(observations);
  const summaries: ActionStratumSummary[] = [];
  for (const seat of ["p2", "p3"] as const) {
    for (const decisionClass of ["forced", "discretionary"] as const) {
      const stratum = observations.filter(
        (observation) =>
          observation.seat === seat &&
          observation.decisionClass === decisionClass,
      );
      if (stratum.length === 0) {
        continue;
      }
      summaries.push({
        seat,
        decisionClass,
        observationCount: stratum.length,
        rawZeroSupportCount: stratum.filter(
          (observation) => observation.rawZeroSupport,
        ).length,
        brier: aggregateNested(
          stratum.map((observation) =>
            metricObservation(observation, "brier", observation.brier),
          ),
        ),
        logLoss: aggregateNested(
          stratum.map((observation) =>
            metricObservation(observation, "log-loss", observation.logLoss),
          ),
        ),
        selectedTop1Accuracy: aggregateNested(
          stratum.map((observation) =>
            metricObservation(
              observation,
              "selected-top1",
              observation.top1.selectedCorrect ? 1 : 0,
            ),
          ),
        ),
        tieAwareTopSetAccuracy: aggregateNested(
          stratum.map((observation) =>
            metricObservation(
              observation,
              "tie-aware-top-set",
              observation.top1.tieAwareCorrect ? 1 : 0,
            ),
          ),
        ),
        tieAwareTop1Credit: aggregateNested(
          stratum.map((observation) =>
            metricObservation(
              observation,
              "tie-aware-top1-credit",
              observation.top1.tieAwareCredit,
            ),
          ),
        ),
      });
    }
  }
  return Object.freeze(summaries);
}
