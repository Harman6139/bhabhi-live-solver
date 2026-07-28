import { stableHash } from "../events/stable-hash";
import {
  PHASE6_BEHAVIOR_DISABLED_REASON,
  calibrationSummarySchema,
  type CalibrationArm,
  type CalibrationPredictionRecord,
  type CalibrationQueryFamily,
  type CalibrationSeedRecord,
  type CalibrationSummary,
  type CalibrationSummaryFamily,
  type CalibrationTruthRecord,
} from "./artifact-schema";
import {
  aggregateNested,
  pairedNestedBootstrap,
  type MetricObservation,
} from "./aggregation";
import {
  RELIABILITY_BIN_EDGES,
  scoreActionPrediction,
  scoreBinaryPrediction,
  scoreCategoricalPrediction,
  scoreCredibleSets,
} from "./metrics";
import type { Phase6CalibrationRunResult } from "./runner";
import type {
  ActionPrediction,
  CalibrationClusterId,
  CalibrationCoordinates,
  CategoricalPrediction,
  CredibleLevel,
  EvalOnlyScoredObservation,
  ProbabilityEntry,
  TerminalClusterId,
} from "./types";
import { terminalClusterId } from "./types";

export const CALIBRATION_SUMMARIZER_VERSION =
  "phase6-calibration-summary-v2" as const;

export type CalibrationReliabilityBin = {
  readonly index: number;
  readonly lowerInclusive: number;
  readonly upper: number;
  readonly upperInclusive: boolean;
  /** Raw one-vs-rest leaf count; retained for sample-size inspection. */
  readonly count: number;
  /**
   * Protocol mass in this bin after equal weighting at query, family, state,
   * trajectory, and calibration-cluster levels.
   */
  readonly weight: number;
  readonly meanPrediction: number | null;
  readonly observedRate: number | null;
};

export type CalibrationReliabilityLine = {
  readonly arm: CalibrationArm;
  readonly family: CalibrationQueryFamily;
  readonly knowledgeStratum: "hard-known" | "unresolved-soft";
  readonly actionDecisionClass: "forced" | "discretionary" | null;
  readonly opponentSeat: "p2" | "p3" | null;
  readonly observations: number;
  readonly bins: readonly CalibrationReliabilityBin[];
};

export type Phase6CalibrationSummaryResult = {
  readonly summary: CalibrationSummary;
  readonly reliabilityLines: readonly CalibrationReliabilityLine[];
  readonly markdown: string;
};

export type CalibrationDerivedScoring = {
  readonly scoredObservations: readonly EvalOnlyScoredObservation[];
  readonly scoreLines: CalibrationSummary["scoreLines"];
  readonly pairedDifferences: CalibrationSummary["pairedDifferences"];
  readonly reliabilityLines: readonly CalibrationReliabilityLine[];
  readonly hardKnownPreserved: boolean;
  readonly logicallyPossibleZeroSupport: number;
};

function recordCoordinates(
  record: CalibrationPredictionRecord,
  terminalCluster: TerminalClusterId,
): CalibrationCoordinates {
  const queryId =
    record.target.kind === "query"
      ? record.target.queryKey
      : record.target.kind === "opponent-action"
        ? `opponent-action:${record.target.actor}:${record.target.actorDecisionOrdinal.toString()}`
        : `terminal-risk:${record.target.actionKey}`;
  return {
    queryId,
    familyId: record.target.family,
    stateId: record.stateId,
    trajectoryId: record.gameId,
    calibrationClusterId: record.calibrationClusterId as CalibrationClusterId,
    terminalClusterId: terminalCluster,
  };
}

function scoreRecordFromTruth(
  record: CalibrationPredictionRecord,
  truth: CalibrationTruthRecord,
  terminalCluster: TerminalClusterId,
): EvalOnlyScoredObservation | null {
  if (
    truth.scoreStatus === "conditioning-false" ||
    truth.targetLabel === null
  ) {
    return null;
  }
  const observationId = stableHash({
    schemaVersion: 1,
    predictionId: record.predictionId,
    truthLabel: truth.targetLabel,
  });
  const common = {
    schemaVersion: 1 as const,
    predictionId: record.predictionId,
    arm: record.arm,
    coordinates: recordCoordinates(record, terminalCluster),
    hardKnown: record.hardKnown,
  };
  const distribution = record.distribution as readonly ProbabilityEntry[];
  if (record.target.kind === "opponent-action") {
    if (truth.forcedAction === null) {
      throw new Error(
        `Scored action pair ${record.pairId} has no forced-action classification.`,
      );
    }
    const prediction: ActionPrediction = {
      ...common,
      kind: "action",
      seat: record.target.actor,
      distribution,
    };
    return scoreActionPrediction(
      prediction,
      truth.targetLabel,
      truth.forcedAction,
      observationId,
    );
  }
  if (record.target.kind === "terminal-risk") {
    throw new Error(
      "Phase 6 calibration summary cannot rescore terminal-risk without a continuation outcome.",
    );
  }
  if (
    record.target.labels.length === 2 &&
    record.target.labels.includes("false") &&
    record.target.labels.includes("true")
  ) {
    const probabilityTrue = distribution.find(
      (entry) => entry.label === "true",
    )?.probability;
    if (probabilityTrue === undefined) {
      throw new Error(
        `Binary pair ${record.pairId} has no true-label probability.`,
      );
    }
    return scoreBinaryPrediction(
      {
        ...common,
        kind: "binary",
        probability: probabilityTrue,
      },
      truth.targetLabel === "true",
      observationId,
    );
  }
  const prediction: CategoricalPrediction = {
    ...common,
    kind: "categorical",
    distribution,
  };
  return scoreCategoricalPrediction(
    prediction,
    truth.targetLabel,
    observationId,
  );
}

export function scoreCalibrationArtifactRecords(input: {
  readonly predictions: readonly CalibrationPredictionRecord[];
  readonly truths: readonly CalibrationTruthRecord[];
  readonly seeds: readonly CalibrationSeedRecord[];
}): readonly EvalOnlyScoredObservation[] {
  const truthByPair = new Map(
    input.truths.map((truth) => [truth.pairId, truth]),
  );
  const seedByGame = new Map(input.seeds.map((seed) => [seed.gameId, seed]));
  const observations: EvalOnlyScoredObservation[] = [];
  for (const prediction of input.predictions) {
    const truth = truthByPair.get(prediction.pairId);
    if (truth === undefined) {
      throw new Error(
        `Calibration prediction pair ${prediction.pairId} has no truth record.`,
      );
    }
    const seed = seedByGame.get(prediction.gameId);
    if (seed === undefined) {
      throw new Error(
        `Calibration prediction game ${prediction.gameId} has no seed record.`,
      );
    }
    const scored = scoreRecordFromTruth(
      prediction,
      truth,
      terminalClusterId(prediction.split, seed.baseIndex),
    );
    if (scored !== null) {
      observations.push(scored);
    }
  }
  return Object.freeze(observations);
}

const ARMS = ["hard-only", "behavioral"] as const;
const FAMILIES = [
  "card-owner",
  "current-void",
  "suit-length",
  "can-overtake",
  "joint",
  "conditional",
  "opponent-action",
  "terminal-risk",
] as const satisfies readonly CalibrationQueryFamily[];
const PRIMARY_QUERY_FAMILIES = [
  "card-owner",
  "current-void",
  "suit-length",
  "can-overtake",
  "joint",
  "conditional",
] as const satisfies readonly CalibrationQueryFamily[];
const KNOWLEDGE_STRATA = ["hard-known", "unresolved-soft"] as const;
const ACTION_DECISION_CLASSES = ["forced", "discretionary"] as const;
const OPPONENT_SEATS = ["p2", "p3"] as const;

type ScoreStratum = {
  readonly knowledgeStratum: "hard-known" | "unresolved-soft";
  readonly actionDecisionClass: "forced" | "discretionary" | null;
  readonly opponentSeat: "p2" | "p3" | null;
};

function scoreStrata(family: CalibrationQueryFamily): readonly ScoreStratum[] {
  const strata: ScoreStratum[] = [];
  for (const knowledgeStratum of KNOWLEDGE_STRATA) {
    if (family === "opponent-action") {
      for (const opponentSeat of OPPONENT_SEATS) {
        for (const actionDecisionClass of ACTION_DECISION_CLASSES) {
          strata.push({
            knowledgeStratum,
            actionDecisionClass,
            opponentSeat,
          });
        }
      }
    } else {
      strata.push({
        knowledgeStratum,
        actionDecisionClass: null,
        opponentSeat: null,
      });
    }
  }
  return Object.freeze(strata);
}

function inStratum(
  observation: EvalOnlyScoredObservation,
  family: CalibrationQueryFamily,
  stratum: ScoreStratum,
): boolean {
  if (
    observation.coordinates.familyId !== family ||
    (observation.hardKnown ? "hard-known" : "unresolved-soft") !==
      stratum.knowledgeStratum
  ) {
    return false;
  }
  if (family !== "opponent-action") {
    return observation.kind !== "action";
  }
  return (
    observation.kind === "action" &&
    observation.decisionClass === stratum.actionDecisionClass &&
    observation.seat === stratum.opponentSeat
  );
}

function metricObservation(
  observation: EvalOnlyScoredObservation,
  metric: "brier" | "log-loss",
): MetricObservation {
  return {
    observationId: `${observation.observationId}/${metric}`,
    coordinates: observation.coordinates,
    value: metric === "brier" ? observation.brier : observation.logLoss,
  };
}

function derivedMetricObservation(
  observation: EvalOnlyScoredObservation,
  metric: string,
  value: number,
): MetricObservation {
  return {
    observationId: `${observation.observationId}/${metric}`,
    coordinates: observation.coordinates,
    value,
  };
}

function nestedMetricMean(
  observations: readonly EvalOnlyScoredObservation[],
  metric: string,
  valueForObservation: (
    observation: EvalOnlyScoredObservation,
  ) => number | null,
): number | null {
  const values = observations.flatMap((observation) => {
    const value = valueForObservation(observation);
    return value === null
      ? []
      : [derivedMetricObservation(observation, metric, value)];
  });
  return values.length === 0 ? null : aggregateNested(values).value;
}

function predictiveSetCovers(
  observation: EvalOnlyScoredObservation,
  level: CredibleLevel,
): boolean | null {
  if (observation.kind === "action") {
    return null;
  }
  if (observation.kind === "categorical") {
    const credibleSet = observation.credibleSets.find(
      (candidate) => candidate.level === level,
    );
    if (credibleSet === undefined) {
      throw new Error(
        `Categorical observation ${observation.observationId} is missing its ${(level * 100).toString()}% predictive set.`,
      );
    }
    return credibleSet.coversTruth;
  }
  const truthLabel = observation.truth ? "true" : "false";
  const credibleSet = scoreCredibleSets(
    [
      { label: "false", probability: 1 - observation.probability },
      { label: "true", probability: observation.probability },
    ],
    truthLabel,
  ).find((candidate) => candidate.level === level);
  if (credibleSet === undefined) {
    throw new Error(
      `Binary observation ${observation.observationId} is missing its ${(level * 100).toString()}% predictive set.`,
    );
  }
  return credibleSet.coversTruth;
}

function predictiveSetCoverage(
  observations: readonly EvalOnlyScoredObservation[],
  level: CredibleLevel,
): number | null {
  return nestedMetricMean(
    observations,
    `predictive-set-coverage-${level.toString()}`,
    (observation) => {
      const covers = predictiveSetCovers(observation, level);
      return covers === null ? null : covers ? 1 : 0;
    },
  );
}

type ProtocolReliabilityObservation = {
  readonly observationId: string;
  readonly coordinates: CalibrationCoordinates;
  readonly probability: number;
  readonly outcome: boolean;
};

function reliabilityObservations(
  observation: EvalOnlyScoredObservation,
): readonly ProtocolReliabilityObservation[] {
  const common = {
    coordinates: observation.coordinates,
  };
  switch (observation.kind) {
    case "binary":
      return [
        {
          ...common,
          observationId: `${observation.observationId}/reliability/true`,
          probability: observation.probability,
          outcome: observation.truth,
        },
      ];
    case "categorical":
      return observation.distribution.map((entry, index) => ({
        ...common,
        observationId: `${observation.observationId}/reliability/${index.toString()}`,
        probability: entry.probability,
        outcome: entry.label === observation.truthLabel,
      }));
    case "action":
      return observation.distribution.map((entry, index) => ({
        ...common,
        observationId: `${observation.observationId}/reliability/${index.toString()}`,
        probability: entry.probability,
        outcome: entry.label === observation.observedLabel,
      }));
  }
}

type WeightedReliabilityObservation = ProtocolReliabilityObservation & {
  readonly weight: number;
};

const PROTOCOL_HIERARCHY = [
  (coordinates: CalibrationCoordinates) => coordinates.calibrationClusterId,
  (coordinates: CalibrationCoordinates) => coordinates.trajectoryId,
  (coordinates: CalibrationCoordinates) => coordinates.stateId,
  (coordinates: CalibrationCoordinates) => coordinates.familyId,
  (coordinates: CalibrationCoordinates) => coordinates.queryId,
] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function protocolWeightedReliabilityObservations(
  observations: readonly ProtocolReliabilityObservation[],
): readonly WeightedReliabilityObservation[] {
  if (observations.length === 0) {
    return Object.freeze([]);
  }
  const ids = new Set<string>();
  for (const observation of observations) {
    if (ids.has(observation.observationId)) {
      throw new TypeError(
        `Duplicate reliability observationId "${observation.observationId}".`,
      );
    }
    ids.add(observation.observationId);
    if (
      !Number.isFinite(observation.probability) ||
      observation.probability < 0 ||
      observation.probability > 1
    ) {
      throw new RangeError(
        `Reliability probability for ${observation.observationId} must be in [0, 1].`,
      );
    }
  }

  const weighted: WeightedReliabilityObservation[] = [];
  function descend(
    group: readonly ProtocolReliabilityObservation[],
    level: number,
    mass: number,
  ): void {
    const selector = PROTOCOL_HIERARCHY[level];
    if (selector === undefined) {
      const ordered = [...group].sort((left, right) =>
        compareText(left.observationId, right.observationId),
      );
      const leafWeight = mass / ordered.length;
      for (const observation of ordered) {
        weighted.push({ ...observation, weight: leafWeight });
      }
      return;
    }
    const groups = new Map<string, ProtocolReliabilityObservation[]>();
    for (const observation of group) {
      const key = selector(observation.coordinates);
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, [observation]);
      } else {
        existing.push(observation);
      }
    }
    const childMass = mass / groups.size;
    for (const key of [...groups.keys()].sort(compareText)) {
      const child = groups.get(key);
      if (child === undefined) {
        throw new Error("Protocol reliability hierarchy lost a child group.");
      }
      descend(child, level + 1, childMass);
    }
  }
  descend(observations, 0, 1);
  return Object.freeze(weighted);
}

function protocolWeightedReliabilityBins(
  observations: readonly ProtocolReliabilityObservation[],
): readonly CalibrationReliabilityBin[] {
  const accumulators = Array.from({ length: 10 }, () => ({
    count: 0,
    weight: 0,
    weightedProbability: 0,
    weightedOutcome: 0,
  }));
  for (const observation of protocolWeightedReliabilityObservations(
    observations,
  )) {
    const index = Math.min(9, Math.floor(observation.probability * 10));
    const accumulator = accumulators[index];
    if (accumulator === undefined) {
      throw new Error("Reliability bin index is outside the frozen bins.");
    }
    accumulator.count += 1;
    accumulator.weight += observation.weight;
    accumulator.weightedProbability +=
      observation.weight * observation.probability;
    accumulator.weightedOutcome +=
      observation.weight * (observation.outcome ? 1 : 0);
  }
  return Object.freeze(
    accumulators.map((accumulator, index) => ({
      index,
      lowerInclusive: RELIABILITY_BIN_EDGES[index] ?? 0,
      upper: RELIABILITY_BIN_EDGES[index + 1] ?? 1,
      upperInclusive: index === 9,
      count: accumulator.count,
      weight: accumulator.weight,
      meanPrediction:
        accumulator.weight === 0
          ? null
          : accumulator.weightedProbability / accumulator.weight,
      observedRate:
        accumulator.weight === 0
          ? null
          : accumulator.weightedOutcome / accumulator.weight,
    })),
  );
}

function makeScoreLine(
  arm: CalibrationArm,
  family: CalibrationSummaryFamily,
  stratum: ScoreStratum,
  observations: readonly EvalOnlyScoredObservation[],
): CalibrationSummary["scoreLines"][number] {
  if (observations.length === 0) {
    throw new RangeError("Cannot summarize an empty calibration score line.");
  }
  const brier = aggregateNested(
    observations.map((observation) => metricObservation(observation, "brier")),
  );
  const logLoss = aggregateNested(
    observations.map((observation) =>
      metricObservation(observation, "log-loss"),
    ),
  );
  return {
    arm,
    family,
    ...stratum,
    observations: observations.length,
    trajectories: new Set(
      observations.map((observation) => observation.coordinates.trajectoryId),
    ).size,
    clusters: new Set(
      observations.map(
        (observation) => observation.coordinates.calibrationClusterId,
      ),
    ).size,
    meanBrier: brier.value,
    meanLogLoss: logLoss.value,
    rawZeroSupport: observations.filter(
      (observation) => observation.rawZeroSupport,
    ).length,
    top1Accuracy: nestedMetricMean(
      observations,
      "selected-top1",
      (observation) =>
        observation.kind === "action"
          ? observation.top1.selectedCorrect
            ? 1
            : 0
          : null,
    ),
    tieAwareTopSetAccuracy: nestedMetricMean(
      observations,
      "tie-aware-top-set",
      (observation) =>
        observation.kind === "action"
          ? observation.top1.tieAwareCorrect
            ? 1
            : 0
          : null,
    ),
    tieAwareTop1Credit: nestedMetricMean(
      observations,
      "tie-aware-top1-credit",
      (observation) =>
        observation.kind === "action" ? observation.top1.tieAwareCredit : null,
    ),
    coverage50: predictiveSetCoverage(observations, 0.5),
    coverage80: predictiveSetCoverage(observations, 0.8),
    coverage95: predictiveSetCoverage(observations, 0.95),
  };
}

export function aggregateCalibrationScoreLines(
  observationsValue: readonly EvalOnlyScoredObservation[],
): CalibrationSummary["scoreLines"] {
  const lines: CalibrationSummary["scoreLines"] = [];
  for (const arm of ARMS) {
    for (const family of FAMILIES) {
      for (const stratum of scoreStrata(family)) {
        const observations = observationsValue.filter(
          (observation) =>
            observation.arm === arm && inStratum(observation, family, stratum),
        );
        if (observations.length > 0) {
          lines.push(makeScoreLine(arm, family, stratum, observations));
        }
      }
    }
    const overallSoft = observationsValue.filter(
      (observation) =>
        observation.arm === arm &&
        !observation.hardKnown &&
        PRIMARY_QUERY_FAMILIES.some(
          (family) => family === observation.coordinates.familyId,
        ),
    );
    if (overallSoft.length > 0) {
      lines.push(
        makeScoreLine(
          arm,
          "overall-soft",
          {
            knowledgeStratum: "unresolved-soft",
            actionDecisionClass: null,
            opponentSeat: null,
          },
          overallSoft,
        ),
      );
    }
  }
  return lines;
}

function pairedDifferenceLines(
  family: CalibrationSummaryFamily,
  stratum: ScoreStratum,
  hard: readonly EvalOnlyScoredObservation[],
  behavioral: readonly EvalOnlyScoredObservation[],
  bootstrapResamples: number,
  bootstrapSeed: string,
): CalibrationSummary["pairedDifferences"] {
  if (hard.length === 0 && behavioral.length === 0) {
    return [];
  }
  if (hard.length !== behavioral.length) {
    throw new Error(
      `Calibration family ${family}/${stratum.knowledgeStratum}/${stratum.opponentSeat ?? "query"}/${stratum.actionDecisionClass ?? "query"} has unpaired scored observations.`,
    );
  }
  return (["brier", "log-loss"] as const).map((metric) => {
    const interval = pairedNestedBootstrap(
      behavioral.map((observation) => metricObservation(observation, metric)),
      hard.map((observation) => metricObservation(observation, metric)),
      {
        resamples: bootstrapResamples,
        seed: stableHash({
          schemaVersion: 1,
          bootstrapSeed,
          family,
          ...stratum,
          metric,
        }),
      },
    );
    return {
      family,
      ...stratum,
      metric,
      estimate: interval.estimate,
      lower95: interval.lower,
      upper95: interval.upper,
      clusters: interval.clusterCount,
      resamples: interval.resamples,
      seedId: interval.seedId,
    };
  });
}

export function aggregateCalibrationPairedDifferences(
  observationsValue: readonly EvalOnlyScoredObservation[],
  bootstrapResamples: number,
  bootstrapSeed: string,
): CalibrationSummary["pairedDifferences"] {
  const lines: CalibrationSummary["pairedDifferences"] = [];
  for (const family of FAMILIES) {
    for (const stratum of scoreStrata(family)) {
      const hard = observationsValue.filter(
        (observation) =>
          observation.arm === "hard-only" &&
          inStratum(observation, family, stratum),
      );
      const behavioral = observationsValue.filter(
        (observation) =>
          observation.arm === "behavioral" &&
          inStratum(observation, family, stratum),
      );
      lines.push(
        ...pairedDifferenceLines(
          family,
          stratum,
          hard,
          behavioral,
          bootstrapResamples,
          bootstrapSeed,
        ),
      );
    }
  }
  const overallStratum: ScoreStratum = {
    knowledgeStratum: "unresolved-soft",
    actionDecisionClass: null,
    opponentSeat: null,
  };
  lines.push(
    ...pairedDifferenceLines(
      "overall-soft",
      overallStratum,
      observationsValue.filter(
        (observation) =>
          observation.arm === "hard-only" &&
          !observation.hardKnown &&
          PRIMARY_QUERY_FAMILIES.some(
            (family) => family === observation.coordinates.familyId,
          ),
      ),
      observationsValue.filter(
        (observation) =>
          observation.arm === "behavioral" &&
          !observation.hardKnown &&
          PRIMARY_QUERY_FAMILIES.some(
            (family) => family === observation.coordinates.familyId,
          ),
      ),
      bootstrapResamples,
      bootstrapSeed,
    ),
  );
  return lines;
}

export function aggregateCalibrationReliabilityLines(
  observationsValue: readonly EvalOnlyScoredObservation[],
): readonly CalibrationReliabilityLine[] {
  return Object.freeze(
    ARMS.flatMap((arm) =>
      FAMILIES.flatMap((family) =>
        scoreStrata(family).flatMap((stratum) => {
          const observations = observationsValue.filter(
            (observation) =>
              observation.arm === arm &&
              inStratum(observation, family, stratum),
          );
          const values = observations.flatMap(reliabilityObservations);
          return values.length === 0
            ? []
            : [
                {
                  arm,
                  family,
                  ...stratum,
                  observations: values.length,
                  bins: protocolWeightedReliabilityBins(values),
                },
              ];
        }),
      ),
    ),
  );
}

function hardKnownPreserved(input: {
  readonly predictions: readonly CalibrationPredictionRecord[];
  readonly truths: readonly CalibrationTruthRecord[];
}): boolean {
  const truthByPair = new Map(
    input.truths.map((truth) => [truth.pairId, truth]),
  );
  return input.predictions
    .filter((prediction) => prediction.hardKnown)
    .every((prediction) => {
      const truth = truthByPair.get(prediction.pairId);
      if (
        truth === undefined ||
        truth.scoreStatus === "conditioning-false" ||
        truth.targetLabel === null
      ) {
        return (
          prediction.target.kind === "query" &&
          prediction.target.family === "conditional"
        );
      }
      return (
        prediction.distribution.find(
          (entry) => entry.label === truth.targetLabel,
        )?.probability === 1
      );
    });
}

export function deriveCalibrationScoring(input: {
  readonly predictions: readonly CalibrationPredictionRecord[];
  readonly truths: readonly CalibrationTruthRecord[];
  readonly seeds: readonly CalibrationSeedRecord[];
  readonly bootstrapResamples: number;
  readonly bootstrapSeed: string;
}): CalibrationDerivedScoring {
  const observations = scoreCalibrationArtifactRecords(input);
  return {
    scoredObservations: observations,
    scoreLines: aggregateCalibrationScoreLines(observations),
    pairedDifferences: aggregateCalibrationPairedDifferences(
      observations,
      input.bootstrapResamples,
      input.bootstrapSeed,
    ),
    reliabilityLines: aggregateCalibrationReliabilityLines(observations),
    hardKnownPreserved: hardKnownPreserved(input),
    logicallyPossibleZeroSupport: observations.filter(
      (observation) => observation.rawZeroSupport,
    ).length,
  };
}

export function renderCalibrationSummaryMarkdown(
  summary: CalibrationSummary,
): string {
  const rows = summary.scoreLines.map(
    (line) =>
      `| ${line.arm} | ${line.family} | ${line.knowledgeStratum} | ${line.opponentSeat ?? "—"} | ${line.actionDecisionClass ?? "—"} | ${line.observations.toString()} | ${line.meanBrier?.toFixed(6) ?? "n/a"} | ${line.meanLogLoss?.toFixed(6) ?? "n/a"} | ${line.top1Accuracy?.toFixed(6) ?? "n/a"} | ${line.tieAwareTopSetAccuracy?.toFixed(6) ?? "n/a"} | ${line.tieAwareTop1Credit?.toFixed(6) ?? "n/a"} | ${line.coverage50?.toFixed(6) ?? "n/a"} | ${line.coverage80?.toFixed(6) ?? "n/a"} | ${line.coverage95?.toFixed(6) ?? "n/a"} |`,
  );
  const differences = summary.pairedDifferences.map(
    (line) =>
      `| ${line.family} | ${line.knowledgeStratum} | ${line.opponentSeat ?? "—"} | ${line.actionDecisionClass ?? "—"} | ${line.metric} | ${line.estimate.toFixed(6)} | [${line.lower95.toFixed(6)}, ${line.upper95.toFixed(6)}] | ${line.clusters.toString()} |`,
  );
  return [
    "# Phase 6 Calibration Summary",
    "",
    `- Run: \`${summary.runId}\``,
    `- Split/evidence: \`${summary.split}\` / \`${summary.evidenceClass}\``,
    `- Evidence eligible: ${summary.evidenceEligible ? "yes" : "no"}`,
    `- Prediction pairs: ${summary.pairedTargets.toString()}`,
    `- Truth records: ${summary.truthRecords.toString()}`,
    `- Failures: ${summary.failures.toString()}`,
    `- Zero-failure gate: ${summary.zeroFailureGate ? "PASS" : "FAIL"}`,
    `- Raw logically possible zero support: ${summary.logicallyPossibleZeroSupport.toString()}`,
    `- Reliability strata: ${summary.reliabilityLines.length.toString()} (10 frozen protocol-weighted bins each; raw leaf counts retained)`,
    `- Behavior production enabled: ${summary.behaviorProductionEnabled ? "yes" : "no"}`,
    `- Reproduction digest: \`${summary.reproductionDigest}\``,
    "",
    "| Arm | Family | Knowledge | Seat | Decision | Observations | Brier | Log loss | Selected top-1 | Tie-aware top set | Tie-aware fractional | Predictive set 50% | Predictive set 80% | Predictive set 95% |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "| Family | Knowledge | Seat | Decision | Metric | Behavioral - hard | Paired 95% interval | Clusters |",
    "| --- | --- | --- | --- | --- | ---: | --- | ---: |",
    ...differences,
    "",
    "This Phase 6 run is development/model-selection infrastructure evidence.",
    "It cannot enable behavioral inference in production. Qualification and",
    "terminal noninferiority remain Phase 8 gates.",
    "",
  ].join("\n");
}

function omitRunId<T extends { readonly runId: string }>(
  record: T,
): Omit<T, "runId"> {
  const scientific = { ...record } as Record<string, unknown>;
  delete scientific.runId;
  return scientific as Omit<T, "runId">;
}

export function calibrationScientificReproductionDigest(input: {
  readonly seeds: readonly CalibrationSeedRecord[];
  readonly predictions: readonly CalibrationPredictionRecord[];
  readonly truths: readonly CalibrationTruthRecord[];
  readonly failures: Phase6CalibrationRunResult["failures"];
}): string {
  return stableHash({
    schemaVersion: 2,
    purpose: "run-label-independent-calibration-scientific-content",
    seeds: input.seeds.map(omitRunId),
    predictions: input.predictions.map(omitRunId),
    truths: input.truths.map(omitRunId),
    failures: input.failures.map((failure) => {
      const scientific = {
        ...omitRunId(failure),
      } as Record<string, unknown>;
      delete scientific.failureId;
      delete scientific.deterministicFailureHash;
      return scientific;
    }),
  });
}

export function summarizePhase6Calibration(
  result: Phase6CalibrationRunResult,
  options: {
    readonly bootstrapResamples: number;
    readonly bootstrapSeed: string;
  },
): Phase6CalibrationSummaryResult {
  const pairs = new Set(
    result.predictions.map((prediction) => prediction.pairId),
  );
  const derived = deriveCalibrationScoring({
    predictions: result.predictions,
    truths: result.truths,
    seeds: result.seeds,
    bootstrapResamples: options.bootstrapResamples,
    bootstrapSeed: options.bootstrapSeed,
  });
  const summary = calibrationSummarySchema.parse({
    schemaVersion: 1,
    protocolId: "eval-v1",
    runId: result.plan.runId,
    split: result.plan.split,
    evidenceClass: result.plan.evidenceClass,
    evidenceEligible: result.plan.evidenceEligible,
    attemptedGames: result.attemptedGames,
    completedGames: result.completedGames,
    attemptedCheckpoints: result.attemptedCheckpoints,
    completedCheckpoints: result.completedCheckpoints,
    predictions: result.predictions.length,
    pairedTargets: pairs.size,
    truthRecords: result.truths.length,
    skippedConditionalPairs: result.truths.filter(
      (truth) => truth.scoreStatus === "conditioning-false",
    ).length,
    failures: result.failures.length,
    zeroFailureGate:
      result.failures.length === 0 &&
      result.attemptedGames > 0 &&
      result.attemptedCheckpoints > 0 &&
      result.predictions.length > 0 &&
      result.completedGames === result.attemptedGames &&
      result.completedCheckpoints === result.attemptedCheckpoints,
    scoreLines: derived.scoreLines,
    pairedDifferences: derived.pairedDifferences,
    reliabilityLines: derived.reliabilityLines,
    hardKnownPreserved: derived.hardKnownPreserved,
    logicallyPossibleZeroSupport: derived.logicallyPossibleZeroSupport,
    behaviorProductionEnabled: false,
    behaviorEnablementReason: PHASE6_BEHAVIOR_DISABLED_REASON,
    reproductionDigest: calibrationScientificReproductionDigest({
      seeds: result.seeds,
      predictions: result.predictions,
      truths: result.truths,
      failures: result.failures,
    }),
  });
  const reliability = derived.reliabilityLines;
  return {
    summary,
    reliabilityLines: reliability,
    markdown: renderCalibrationSummaryMarkdown(summary),
  };
}

export function calibrationCoordinatesKey(
  coordinates: CalibrationCoordinates,
): string {
  return stableHash(coordinates);
}
