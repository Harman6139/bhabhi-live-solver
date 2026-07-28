import { z } from "zod";

import type { PolicyObservation } from "../agents/policies";
import type { OpponentSeat } from "../domain/seats";
import { stableHash, stableStringify } from "../events/stable-hash";
import type { BehaviorBeliefConfigInput } from "../inference/behavior-belief";
import {
  BEHAVIOR_MODEL_HASH,
  BEHAVIOR_MODEL_IDS,
  allBehaviorModelDistributions,
  behaviorActionKey,
  deepFreezeBehavior,
  enumerateBehaviorActions,
  temperBehaviorLikelihoods,
  validateBehaviorModelConfig,
  type BehaviorAction,
  type BehaviorModelConfig,
  type BehaviorModelId,
} from "../inference/behavior-models";
import { FITTABLE_STYLE_CELL_IDS } from "../calibration/fittable-style-cells";

export const BEHAVIOR_FIT_ALGORITHM_VERSION = "phase8-behavior-fit-v1" as const;
export const BEHAVIOR_FIT_ARTIFACT_KIND =
  "phase8-selected-behavior-model" as const;
export const BEHAVIOR_FIT_SCORER_VERSION =
  "prequential-public-action-log-loss-v1" as const;
export const BEHAVIOR_FIT_PROBABILITY_FLOOR = 1e-12;
export const BEHAVIOR_FIT_PRIOR_PSEUDOCOUNT = 0.5;
export const BEHAVIOR_FIT_MAXIMUM_EM_ITERATIONS = 64;
export const BEHAVIOR_FIT_EM_TOLERANCE = 1e-10;

const opponentSeats = ["p2", "p3"] as const satisfies readonly OpponentSeat[];
const fittableStyleCellIds = new Set<string>(FITTABLE_STYLE_CELL_IDS);
const identifierSchema = z.string().trim().min(1).max(256);
const hashSchema = z.string().trim().min(1).max(256);
const probabilitySchema = z.number().min(0).max(1);
const positiveProbabilitySchema = z.number().gt(0).max(1);

const positiveBehaviorModelProbabilityRecordSchema = z
  .object({
    random: positiveProbabilitySchema,
    "always-high": positiveProbabilitySchema,
    "always-low": positiveProbabilitySchema,
    "shortest-suit": positiveProbabilitySchema,
    "early-high-shedder": positiveProbabilitySchema,
    "power-avoider": positiveProbabilitySchema,
    "documented-basic": positiveProbabilitySchema,
  })
  .strict()
  .superRefine((value, context) => {
    const total = BEHAVIOR_MODEL_IDS.reduce(
      (sum, modelId) => sum + value[modelId],
      0,
    );
    if (Math.abs(total - 1) > 1e-9) {
      context.addIssue({
        code: "custom",
        message: "Behavior-model probabilities must sum to one.",
      });
    }
  });

const behaviorModelFeatureSchema = z
  .object({
    uniformProbability: probabilitySchema,
    preferredProbability: probabilitySchema,
  })
  .strict();

const behaviorModelFeatureRecordSchema = z
  .object({
    random: behaviorModelFeatureSchema,
    "always-high": behaviorModelFeatureSchema,
    "always-low": behaviorModelFeatureSchema,
    "shortest-suit": behaviorModelFeatureSchema,
    "early-high-shedder": behaviorModelFeatureSchema,
    "power-avoider": behaviorModelFeatureSchema,
    "documented-basic": behaviorModelFeatureSchema,
  })
  .strict();

export const behaviorWorldEstimateSchema = z
  .object({
    worldCount: z.number().int().positive(),
    modelFeatures: behaviorModelFeatureRecordSchema,
  })
  .strict();

export type BehaviorWorldEstimate = z.infer<typeof behaviorWorldEstimateSchema>;

export const behaviorFitObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    observationId: identifierSchema,
    split: z.enum(["train", "tune"]),
    styleCellId: identifierSchema,
    sequenceId: identifierSchema,
    seat: z.enum(opponentSeats),
    decisionOrdinal: z.number().int().nonnegative(),
    worldEstimates: z.array(behaviorWorldEstimateSchema).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (!fittableStyleCellIds.has(value.styleCellId)) {
      context.addIssue({
        code: "custom",
        path: ["styleCellId"],
        message:
          "Behavior fitting accepts only fittable cells c01-c15; stress cells c16/c17 are audit-only.",
      });
    }
    const counts = value.worldEstimates.map((entry) => entry.worldCount);
    if (new Set(counts).size !== counts.length) {
      context.addIssue({
        code: "custom",
        path: ["worldEstimates"],
        message: "worldEstimates must contain each world count at most once.",
      });
    }
  });

export type BehaviorFitObservation = z.infer<
  typeof behaviorFitObservationSchema
>;

export type BehaviorFitSplit = BehaviorFitObservation["split"];

export type BehaviorCandidateParameters = {
  readonly lapseProbability: number;
  readonly likelihoodPower: number;
  readonly maximumBayesFactor: number;
  readonly worldCount: number;
  /**
   * Bound into the selected model for later decision-policy evaluation.
   * Public-action likelihood cannot identify this switch, so exact score ties
   * deterministically prefer false.
   */
  readonly robustChoice: boolean;
};

export type BehaviorHyperparameterGridInput = {
  readonly lapseProbabilities: readonly number[];
  readonly likelihoodPowers: readonly number[];
  readonly maximumBayesFactors: readonly number[];
  readonly worldCounts: readonly number[];
  readonly robustChoices?: readonly boolean[];
};

export type BehaviorFitProvenance = {
  readonly sourceHash: string;
  readonly datasetHash: string;
  readonly datasetContentHash: string;
  readonly scheduleHash: string;
  readonly scorerHash: string;
  readonly configFamilyHash: string;
};

export type OpponentRecord<T> = Readonly<{
  readonly p2: T;
  readonly p3: T;
}>;

export type OpponentFitDiagnostics = {
  readonly observationCount: number;
  readonly sequenceCount: number;
  readonly initialPriors: Readonly<Record<BehaviorModelId, number>>;
  readonly fittedPriors: Readonly<Record<BehaviorModelId, number>>;
  readonly meanEndingPosterior: Readonly<Record<BehaviorModelId, number>>;
  readonly cumulativeNegativeLogLikelihood: number;
  readonly meanNegativeLogLikelihood: number;
  readonly emIterations: number;
  readonly emConverged: boolean;
};

export type BehaviorTrainCandidateFit = {
  readonly candidateId: string;
  readonly tieBreakKey: string;
  readonly parameters: BehaviorCandidateParameters;
  readonly opponents: OpponentRecord<OpponentFitDiagnostics>;
  readonly observationCount: number;
  readonly cumulativeNegativeLogLikelihood: number;
  readonly meanNegativeLogLikelihood: number;
};

export type BehaviorTrainGridFit = {
  readonly schemaVersion: 1;
  readonly algorithmVersion: typeof BEHAVIOR_FIT_ALGORITHM_VERSION;
  readonly evidenceClass: "phase8-behavior-train";
  readonly split: "train";
  readonly behaviorModelHash: string;
  readonly provenance: BehaviorFitProvenance;
  readonly candidateCount: number;
  readonly candidates: readonly BehaviorTrainCandidateFit[];
};

export type OpponentTuneDiagnostics = {
  readonly observationCount: number;
  readonly sequenceCount: number;
  readonly startingPriors: Readonly<Record<BehaviorModelId, number>>;
  readonly meanEndingPosterior: Readonly<Record<BehaviorModelId, number>>;
  readonly cumulativeNegativeLogLikelihood: number;
  readonly meanNegativeLogLikelihood: number;
};

export type BehaviorTuneCandidateScore = {
  readonly candidateId: string;
  readonly tieBreakKey: string;
  readonly parameters: BehaviorCandidateParameters;
  readonly opponents: OpponentRecord<OpponentTuneDiagnostics>;
  readonly observationCount: number;
  readonly cumulativeNegativeLogLikelihood: number;
  readonly meanNegativeLogLikelihood: number;
  readonly worstOpponentMeanNegativeLogLikelihood: number;
};

export type BehaviorTuneSelection = {
  readonly schemaVersion: 1;
  readonly algorithmVersion: typeof BEHAVIOR_FIT_ALGORITHM_VERSION;
  readonly evidenceClass: "phase8-behavior-tune";
  readonly split: "tune";
  readonly selectionMetric: "pooled-prequential-negative-log-likelihood";
  readonly behaviorModelHash: string;
  readonly trainProvenance: BehaviorFitProvenance;
  readonly tuneProvenance: BehaviorFitProvenance;
  readonly selectedCandidateId: string;
  readonly candidateScores: readonly BehaviorTuneCandidateScore[];
};

export type SelectedBehaviorModelArtifactPayload = {
  readonly schemaVersion: 1;
  readonly algorithmVersion: typeof BEHAVIOR_FIT_ALGORITHM_VERSION;
  readonly selectionMetric: "pooled-prequential-negative-log-likelihood";
  readonly behaviorModelHash: string;
  readonly sourceHash: string;
  readonly scorerHash: string;
  readonly configFamilyHash: string;
  readonly train: {
    readonly split: "train";
    readonly datasetHash: string;
    readonly datasetContentHash: string;
    readonly scheduleHash: string;
    readonly observationCount: number;
  };
  readonly tune: {
    readonly split: "tune";
    readonly datasetHash: string;
    readonly datasetContentHash: string;
    readonly scheduleHash: string;
    readonly observationCount: number;
  };
  readonly selectedCandidateId: string;
  readonly selectedTieBreakKey: string;
  readonly parameters: BehaviorCandidateParameters;
  readonly opponentConfigs: OpponentRecord<BehaviorModelConfig>;
  readonly trainDiagnostics: OpponentRecord<OpponentFitDiagnostics>;
  readonly tuneDiagnostics: OpponentRecord<OpponentTuneDiagnostics>;
  readonly candidateScores: readonly {
    readonly candidateId: string;
    readonly tieBreakKey: string;
    readonly meanNegativeLogLikelihood: number;
    readonly worstOpponentMeanNegativeLogLikelihood: number;
  }[];
};

export type SelectedBehaviorModelArtifact = {
  readonly schemaVersion: 1;
  readonly artifactKind: typeof BEHAVIOR_FIT_ARTIFACT_KIND;
  readonly payload: SelectedBehaviorModelArtifactPayload;
  readonly payloadChecksum: string;
};

const candidateParametersSchema = z
  .object({
    lapseProbability: z.number().gt(0).lt(1),
    likelihoodPower: z.number().gt(0).max(1),
    maximumBayesFactor: z.number().gt(1).max(4),
    worldCount: z.number().int().positive(),
    robustChoice: z.boolean(),
  })
  .strict();

const behaviorModelConfigSchema = z
  .object({
    lapseProbability: z.number().gt(0).lt(1),
    likelihoodPower: z.number().gt(0).max(1),
    maximumBayesFactor: z.number().gt(1).max(4),
    modelPriors: positiveBehaviorModelProbabilityRecordSchema,
  })
  .strict();

const opponentFitDiagnosticsSchema = z
  .object({
    observationCount: z.number().int().nonnegative(),
    sequenceCount: z.number().int().nonnegative(),
    initialPriors: positiveBehaviorModelProbabilityRecordSchema,
    fittedPriors: positiveBehaviorModelProbabilityRecordSchema,
    meanEndingPosterior: positiveBehaviorModelProbabilityRecordSchema,
    cumulativeNegativeLogLikelihood: z.number().nonnegative(),
    meanNegativeLogLikelihood: z.number().nonnegative(),
    emIterations: z
      .number()
      .int()
      .nonnegative()
      .max(BEHAVIOR_FIT_MAXIMUM_EM_ITERATIONS),
    emConverged: z.boolean(),
  })
  .strict();

const opponentTuneDiagnosticsSchema = z
  .object({
    observationCount: z.number().int().nonnegative(),
    sequenceCount: z.number().int().nonnegative(),
    startingPriors: positiveBehaviorModelProbabilityRecordSchema,
    meanEndingPosterior: positiveBehaviorModelProbabilityRecordSchema,
    cumulativeNegativeLogLikelihood: z.number().nonnegative(),
    meanNegativeLogLikelihood: z.number().nonnegative(),
  })
  .strict();

const artifactPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithmVersion: z.literal(BEHAVIOR_FIT_ALGORITHM_VERSION),
    selectionMetric: z.literal("pooled-prequential-negative-log-likelihood"),
    behaviorModelHash: hashSchema,
    sourceHash: hashSchema,
    scorerHash: hashSchema,
    configFamilyHash: hashSchema,
    train: z
      .object({
        split: z.literal("train"),
        datasetHash: hashSchema,
        datasetContentHash: hashSchema,
        scheduleHash: hashSchema,
        observationCount: z.number().int().positive(),
      })
      .strict(),
    tune: z
      .object({
        split: z.literal("tune"),
        datasetHash: hashSchema,
        datasetContentHash: hashSchema,
        scheduleHash: hashSchema,
        observationCount: z.number().int().positive(),
      })
      .strict(),
    selectedCandidateId: hashSchema,
    selectedTieBreakKey: identifierSchema,
    parameters: candidateParametersSchema,
    opponentConfigs: z
      .object({
        p2: behaviorModelConfigSchema,
        p3: behaviorModelConfigSchema,
      })
      .strict(),
    trainDiagnostics: z
      .object({
        p2: opponentFitDiagnosticsSchema,
        p3: opponentFitDiagnosticsSchema,
      })
      .strict(),
    tuneDiagnostics: z
      .object({
        p2: opponentTuneDiagnosticsSchema,
        p3: opponentTuneDiagnosticsSchema,
      })
      .strict(),
    candidateScores: z
      .array(
        z
          .object({
            candidateId: hashSchema,
            tieBreakKey: identifierSchema,
            meanNegativeLogLikelihood: z.number().nonnegative(),
            worstOpponentMeanNegativeLogLikelihood: z.number().nonnegative(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.train.datasetHash === payload.tune.datasetHash ||
      payload.train.datasetContentHash === payload.tune.datasetContentHash ||
      payload.train.scheduleHash === payload.tune.scheduleHash
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Train and tune provenance must bind disjoint dataset, content, and schedule hashes.",
      });
    }
    if (payload.behaviorModelHash !== BEHAVIOR_MODEL_HASH) {
      context.addIssue({
        code: "custom",
        path: ["behaviorModelHash"],
        message: "Artifact behavior-model family hash is stale.",
      });
    }
    if (payload.scorerHash !== BEHAVIOR_FIT_SCORER_HASH) {
      context.addIssue({
        code: "custom",
        path: ["scorerHash"],
        message: "Artifact scorer hash is stale.",
      });
    }
    if (
      payload.selectedCandidateId !== behaviorCandidateId(payload.parameters)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedCandidateId"],
        message: "Selected candidate ID does not match its parameters.",
      });
    }
    if (
      payload.selectedTieBreakKey !==
      behaviorCandidateTieBreakKey(payload.parameters)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedTieBreakKey"],
        message: "Selected tie-break key does not match its parameters.",
      });
    }
    const selectedScore = payload.candidateScores.find(
      (score) => score.candidateId === payload.selectedCandidateId,
    );
    if (selectedScore === undefined) {
      context.addIssue({
        code: "custom",
        path: ["candidateScores"],
        message: "Candidate scores must include the selected candidate.",
      });
    } else {
      const winner = [...payload.candidateScores].sort(
        compareCandidateScores,
      )[0];
      if (winner?.candidateId !== payload.selectedCandidateId) {
        context.addIssue({
          code: "custom",
          path: ["selectedCandidateId"],
          message:
            "Selected candidate is not the deterministic minimum tune score.",
        });
      }
    }
    for (const seat of opponentSeats) {
      const config = payload.opponentConfigs[seat];
      if (
        config.lapseProbability !== payload.parameters.lapseProbability ||
        config.likelihoodPower !== payload.parameters.likelihoodPower ||
        config.maximumBayesFactor !== payload.parameters.maximumBayesFactor
      ) {
        context.addIssue({
          code: "custom",
          path: ["opponentConfigs", seat],
          message:
            "Opponent config hyperparameters do not match the selected candidate.",
        });
      }
      for (const modelId of BEHAVIOR_MODEL_IDS) {
        if (
          Math.abs(
            config.modelPriors[modelId] -
              payload.trainDiagnostics[seat].fittedPriors[modelId],
          ) > 1e-12
        ) {
          context.addIssue({
            code: "custom",
            path: ["opponentConfigs", seat, "modelPriors", modelId],
            message: "Opponent config priors do not match train-fitted priors.",
          });
        }
      }
    }
  });

export const selectedBehaviorModelArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal(BEHAVIOR_FIT_ARTIFACT_KIND),
    payload: artifactPayloadSchema,
    payloadChecksum: hashSchema,
  })
  .strict();

export const BEHAVIOR_FIT_SCORER_HASH = stableHash({
  schemaVersion: 1,
  scorerVersion: BEHAVIOR_FIT_SCORER_VERSION,
  behaviorModelHash: BEHAVIOR_MODEL_HASH,
  probabilityFloor: BEHAVIOR_FIT_PROBABILITY_FLOOR,
  priorPseudocount: BEHAVIOR_FIT_PRIOR_PSEUDOCOUNT,
  maximumEmIterations: BEHAVIOR_FIT_MAXIMUM_EM_ITERATIONS,
  emTolerance: BEHAVIOR_FIT_EM_TOLERANCE,
  score: "raw-public-action-prequential-log-loss",
  update: "tempered-model-posterior-with-analytic-bayes-factor-cap",
  sequenceReset: true,
  opponentParameters: "separate-p2-p3",
});

type ParsedObservation = z.infer<typeof behaviorFitObservationSchema>;
type ProbabilityRecord = Readonly<Record<BehaviorModelId, number>>;

function canonicalizeObservation(
  observation: ParsedObservation,
): ParsedObservation {
  return {
    ...observation,
    worldEstimates: [...observation.worldEstimates].sort(
      (left, right) => left.worldCount - right.worldCount,
    ),
  };
}

function requireFiniteNonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite and non-negative.`);
  }
  return value;
}

function normalizeProbabilities(values: readonly number[]): number[] {
  const floored = values.map((value) =>
    Math.max(
      BEHAVIOR_FIT_PROBABILITY_FLOOR,
      requireFiniteNonnegative(value, "Model probability"),
    ),
  );
  const total = floored.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("Behavior-model probabilities cannot be normalized.");
  }
  return floored.map((value) => value / total);
}

function probabilitiesToRecord(
  probabilities: readonly number[],
): ProbabilityRecord {
  const normalized = normalizeProbabilities(probabilities);
  return deepFreezeBehavior(
    Object.fromEntries(
      BEHAVIOR_MODEL_IDS.map((modelId, index) => [modelId, normalized[index]]),
    ) as Record<BehaviorModelId, number>,
  );
}

function recordToProbabilities(record: ProbabilityRecord): number[] {
  return BEHAVIOR_MODEL_IDS.map((modelId) => record[modelId]);
}

function parseObservations(
  values: readonly unknown[],
  expectedSplit: BehaviorFitSplit,
): readonly ParsedObservation[] {
  if (values.length === 0) {
    throw new Error(`${expectedSplit} behavior fitting requires observations.`);
  }
  const parsed = values.map((value) =>
    canonicalizeObservation(behaviorFitObservationSchema.parse(value)),
  );
  const observationIds = new Set<string>();
  for (const observation of parsed) {
    if (observation.split !== expectedSplit) {
      throw new Error(
        `Behavior ${expectedSplit} fitting cannot consume ${observation.split} observations.`,
      );
    }
    if (observationIds.has(observation.observationId)) {
      throw new Error(
        `Duplicate behavior-fit observation ID ${observation.observationId}.`,
      );
    }
    observationIds.add(observation.observationId);
  }
  for (const seat of opponentSeats) {
    if (!parsed.some((observation) => observation.seat === seat)) {
      throw new Error(
        `Behavior ${expectedSplit} fitting requires observations for ${seat}.`,
      );
    }
  }
  return deepFreezeBehavior([...parsed].sort(compareObservations));
}

function compareObservations(
  left: ParsedObservation,
  right: ParsedObservation,
): number {
  return (
    left.seat.localeCompare(right.seat) ||
    left.sequenceId.localeCompare(right.sequenceId) ||
    left.decisionOrdinal - right.decisionOrdinal ||
    left.observationId.localeCompare(right.observationId)
  );
}

function canonicalObservationForContentHash(
  observation: ParsedObservation,
): Omit<ParsedObservation, "split"> {
  return {
    schemaVersion: observation.schemaVersion,
    observationId: observation.observationId,
    styleCellId: observation.styleCellId,
    sequenceId: observation.sequenceId,
    seat: observation.seat,
    decisionOrdinal: observation.decisionOrdinal,
    worldEstimates: observation.worldEstimates,
  };
}

export function behaviorFitDatasetHash(
  observations: readonly unknown[],
): string {
  const parsed = observations.map((value) =>
    canonicalizeObservation(behaviorFitObservationSchema.parse(value)),
  );
  return stableHash({
    schemaVersion: 1,
    observations: [...parsed].sort(compareObservations),
  });
}

export function behaviorFitDatasetContentHash(
  observations: readonly unknown[],
): string {
  const parsed = observations.map((value) =>
    canonicalizeObservation(behaviorFitObservationSchema.parse(value)),
  );
  return stableHash({
    schemaVersion: 1,
    observations: [...parsed]
      .sort(compareObservations)
      .map(canonicalObservationForContentHash),
  });
}

export function behaviorCandidateTieBreakKey(
  parameters: BehaviorCandidateParameters,
): string {
  const parsed = candidateParametersSchema.parse(parameters);
  return [
    parsed.lapseProbability.toString().padStart(16, "0"),
    parsed.likelihoodPower.toString().padStart(16, "0"),
    parsed.maximumBayesFactor.toString().padStart(16, "0"),
    parsed.worldCount.toString().padStart(12, "0"),
    parsed.robustChoice ? "1" : "0",
  ].join("|");
}

export function behaviorCandidateId(
  parameters: BehaviorCandidateParameters,
): string {
  const parsed = candidateParametersSchema.parse(parameters);
  return stableHash({
    schemaVersion: 1,
    kind: "phase8-behavior-candidate",
    parameters: parsed,
  });
}

function compareParameters(
  left: BehaviorCandidateParameters,
  right: BehaviorCandidateParameters,
): number {
  return behaviorCandidateTieBreakKey(left).localeCompare(
    behaviorCandidateTieBreakKey(right),
  );
}

export function expandBehaviorHyperparameterGrid(
  input: BehaviorHyperparameterGridInput,
): readonly BehaviorCandidateParameters[] {
  const parsed = z
    .object({
      lapseProbabilities: z.array(z.number()).min(1).max(16),
      likelihoodPowers: z.array(z.number()).min(1).max(16),
      maximumBayesFactors: z.array(z.number()).min(1).max(16),
      worldCounts: z.array(z.number().int().positive()).min(1).max(16),
      robustChoices: z.array(z.boolean()).min(1).max(16).optional(),
    })
    .strict()
    .parse(input);
  const values = new Map<string, BehaviorCandidateParameters>();
  for (const lapseProbability of parsed.lapseProbabilities) {
    for (const likelihoodPower of parsed.likelihoodPowers) {
      for (const maximumBayesFactor of parsed.maximumBayesFactors) {
        for (const worldCount of parsed.worldCounts) {
          for (const robustChoice of parsed.robustChoices ?? [false]) {
            validateBehaviorModelConfig({
              lapseProbability,
              likelihoodPower,
              maximumBayesFactor,
            });
            const parameters = candidateParametersSchema.parse({
              lapseProbability,
              likelihoodPower,
              maximumBayesFactor,
              worldCount,
              robustChoice,
            });
            values.set(behaviorCandidateId(parameters), parameters);
          }
        }
      }
    }
  }
  if (values.size > 512) {
    throw new Error(
      "Behavior hyperparameter grid is bounded to 512 candidates.",
    );
  }
  return deepFreezeBehavior([...values.values()].sort(compareParameters));
}

export function behaviorConfigFamilyHash(
  input: BehaviorHyperparameterGridInput,
): string {
  return stableHash({
    schemaVersion: 1,
    algorithmVersion: BEHAVIOR_FIT_ALGORITHM_VERSION,
    candidates: expandBehaviorHyperparameterGrid(input),
  });
}

export function createBehaviorWorldEstimate(input: {
  readonly observation: PolicyObservation;
  readonly observedAction: BehaviorAction;
  readonly worldCount: number;
}): BehaviorWorldEstimate {
  if (!Number.isSafeInteger(input.worldCount) || input.worldCount <= 0) {
    throw new RangeError("worldCount must be a positive safe integer.");
  }
  const actions = enumerateBehaviorActions(input.observation);
  const observedActionKey = behaviorActionKey(input.observedAction);
  if (
    !actions.some((action) => behaviorActionKey(action) === observedActionKey)
  ) {
    throw new Error(
      "Observed action is not legal in the actor-safe observation.",
    );
  }
  const uniformProbability = 1 / actions.length;
  const distributions = allBehaviorModelDistributions(input.observation);
  const modelFeatures = Object.fromEntries(
    BEHAVIOR_MODEL_IDS.map((modelId) => {
      const preferredActionKey = distributions[modelId].preferredActionKey;
      return [
        modelId,
        {
          uniformProbability,
          preferredProbability:
            modelId === "random"
              ? uniformProbability
              : preferredActionKey === observedActionKey
                ? 1
                : 0,
        },
      ];
    }),
  ) as Record<
    BehaviorModelId,
    { uniformProbability: number; preferredProbability: number }
  >;
  return deepFreezeBehavior(
    behaviorWorldEstimateSchema.parse({
      worldCount: input.worldCount,
      modelFeatures,
    }),
  );
}

function worldEstimate(
  observation: ParsedObservation,
  worldCount: number,
): BehaviorWorldEstimate {
  const estimate = observation.worldEstimates.find(
    (candidate) => candidate.worldCount === worldCount,
  );
  if (estimate === undefined) {
    throw new Error(
      `Observation ${observation.observationId} has no ${worldCount.toString()}-world estimate.`,
    );
  }
  return estimate;
}

function rawLikelihoods(
  observation: ParsedObservation,
  parameters: BehaviorCandidateParameters,
): number[] {
  const estimate = worldEstimate(observation, parameters.worldCount);
  return BEHAVIOR_MODEL_IDS.map((modelId) => {
    const feature = estimate.modelFeatures[modelId];
    const value =
      modelId === "random"
        ? feature.uniformProbability
        : (1 - parameters.lapseProbability) * feature.preferredProbability +
          parameters.lapseProbability * feature.uniformProbability;
    return Math.max(BEHAVIOR_FIT_PROBABILITY_FLOOR, value);
  });
}

function temperedLikelihoods(
  observation: ParsedObservation,
  parameters: BehaviorCandidateParameters,
): {
  readonly raw: readonly number[];
  readonly tempered: readonly number[];
} {
  const raw = rawLikelihoods(observation, parameters);
  const config = validateBehaviorModelConfig({
    lapseProbability: parameters.lapseProbability,
    likelihoodPower: parameters.likelihoodPower,
    maximumBayesFactor: parameters.maximumBayesFactor,
  });
  const tempered = temperBehaviorLikelihoods(raw, config).temperedLikelihoods;
  return { raw, tempered };
}

function updatePosterior(
  prior: readonly number[],
  likelihoods: readonly number[],
): number[] {
  return normalizeProbabilities(
    prior.map((probability, index) => {
      const likelihood = likelihoods[index];
      if (likelihood === undefined) {
        throw new Error("Likelihood vector has the wrong cardinality.");
      }
      return probability * likelihood;
    }),
  );
}

function logSumExp(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("logSumExp requires at least one value.");
  }
  const maximum = Math.max(...values);
  if (!Number.isFinite(maximum)) {
    return maximum;
  }
  return (
    maximum +
    Math.log(values.reduce((sum, value) => sum + Math.exp(value - maximum), 0))
  );
}

function groupSequences(
  observations: readonly ParsedObservation[],
  seat: OpponentSeat,
): readonly (readonly ParsedObservation[])[] {
  const grouped = new Map<string, ParsedObservation[]>();
  for (const observation of observations) {
    if (observation.seat !== seat) {
      continue;
    }
    const sequence = grouped.get(observation.sequenceId) ?? [];
    sequence.push(observation);
    grouped.set(observation.sequenceId, sequence);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, sequence]) =>
      sequence.sort(
        (left, right) =>
          left.decisionOrdinal - right.decisionOrdinal ||
          left.observationId.localeCompare(right.observationId),
      ),
    );
}

function sequenceModelLogLikelihoods(
  sequence: readonly ParsedObservation[],
  parameters: BehaviorCandidateParameters,
): number[] {
  const totals = BEHAVIOR_MODEL_IDS.map(() => 0);
  for (const observation of sequence) {
    const likelihoods = temperedLikelihoods(observation, parameters).tempered;
    for (let index = 0; index < totals.length; index += 1) {
      const likelihood = likelihoods[index];
      const prior = totals[index];
      if (likelihood === undefined || prior === undefined) {
        throw new Error("Behavior-model vector has the wrong cardinality.");
      }
      totals[index] = prior + Math.log(likelihood);
    }
  }
  return totals;
}

function fitOpponentPriors(
  sequences: readonly (readonly ParsedObservation[])[],
  parameters: BehaviorCandidateParameters,
  initialPriors: ProbabilityRecord,
): {
  readonly priors: ProbabilityRecord;
  readonly iterations: number;
  readonly converged: boolean;
} {
  const logLikelihoods = sequences.map((sequence) =>
    sequenceModelLogLikelihoods(sequence, parameters),
  );
  let priors = recordToProbabilities(initialPriors);
  let converged = false;
  let iterations = 0;
  for (
    let iteration = 1;
    iteration <= BEHAVIOR_FIT_MAXIMUM_EM_ITERATIONS;
    iteration += 1
  ) {
    const expectedCounts = BEHAVIOR_MODEL_IDS.map(
      () => BEHAVIOR_FIT_PRIOR_PSEUDOCOUNT,
    );
    for (const sequenceLikelihoods of logLikelihoods) {
      const unnormalizedLogs = sequenceLikelihoods.map(
        (logLikelihood, index) => {
          const prior = priors[index];
          if (prior === undefined) {
            throw new Error("Prior vector has the wrong cardinality.");
          }
          return Math.log(prior) + logLikelihood;
        },
      );
      const normalizer = logSumExp(unnormalizedLogs);
      for (let index = 0; index < expectedCounts.length; index += 1) {
        const value = unnormalizedLogs[index];
        const priorCount = expectedCounts[index];
        if (value === undefined || priorCount === undefined) {
          throw new Error("Responsibility vector has the wrong cardinality.");
        }
        expectedCounts[index] = priorCount + Math.exp(value - normalizer);
      }
    }
    const next = normalizeProbabilities(expectedCounts);
    const maximumDelta = Math.max(
      ...next.map((value, index) => Math.abs(value - (priors[index] ?? 0))),
    );
    priors = next;
    iterations = iteration;
    if (maximumDelta <= BEHAVIOR_FIT_EM_TOLERANCE) {
      converged = true;
      break;
    }
  }
  return {
    priors: probabilitiesToRecord(priors),
    iterations,
    converged,
  };
}

function scoreOpponent(
  sequences: readonly (readonly ParsedObservation[])[],
  parameters: BehaviorCandidateParameters,
  startingPriors: ProbabilityRecord,
): {
  readonly observationCount: number;
  readonly sequenceCount: number;
  readonly cumulativeNegativeLogLikelihood: number;
  readonly meanNegativeLogLikelihood: number;
  readonly meanEndingPosterior: ProbabilityRecord;
} {
  let cumulativeNegativeLogLikelihood = 0;
  let observationCount = 0;
  const endingPosteriorTotals = BEHAVIOR_MODEL_IDS.map(() => 0);
  for (const sequence of sequences) {
    let posterior = recordToProbabilities(startingPriors);
    for (const observation of sequence) {
      const likelihoods = temperedLikelihoods(observation, parameters);
      const predictiveProbability = posterior.reduce(
        (sum, probability, index) =>
          sum + probability * (likelihoods.raw[index] ?? 0),
        0,
      );
      cumulativeNegativeLogLikelihood += -Math.log(
        Math.max(BEHAVIOR_FIT_PROBABILITY_FLOOR, predictiveProbability),
      );
      observationCount += 1;
      posterior = updatePosterior(posterior, likelihoods.tempered);
    }
    for (let index = 0; index < endingPosteriorTotals.length; index += 1) {
      endingPosteriorTotals[index] =
        (endingPosteriorTotals[index] ?? 0) + (posterior[index] ?? 0);
    }
  }
  if (observationCount <= 0 || sequences.length <= 0) {
    throw new Error("Opponent scoring requires at least one sequence.");
  }
  const meanNegativeLogLikelihood =
    cumulativeNegativeLogLikelihood / observationCount;
  if (
    !Number.isFinite(cumulativeNegativeLogLikelihood) ||
    !Number.isFinite(meanNegativeLogLikelihood)
  ) {
    throw new Error("Behavior prequential log likelihood is not finite.");
  }
  return {
    observationCount,
    sequenceCount: sequences.length,
    cumulativeNegativeLogLikelihood,
    meanNegativeLogLikelihood,
    meanEndingPosterior: probabilitiesToRecord(
      endingPosteriorTotals.map((value) => value / sequences.length),
    ),
  };
}

function validateProvenance(input: {
  readonly provenance: BehaviorFitProvenance;
  readonly observations: readonly ParsedObservation[];
  readonly configFamilyHash: string;
}): BehaviorFitProvenance {
  const schema = z
    .object({
      sourceHash: hashSchema,
      datasetHash: hashSchema,
      datasetContentHash: hashSchema,
      scheduleHash: hashSchema,
      scorerHash: hashSchema,
      configFamilyHash: hashSchema,
    })
    .strict();
  const provenance = schema.parse(input.provenance);
  const datasetHash = behaviorFitDatasetHash(input.observations);
  const datasetContentHash = behaviorFitDatasetContentHash(input.observations);
  if (provenance.datasetHash !== datasetHash) {
    throw new Error("Declared behavior-fit dataset hash does not match input.");
  }
  if (provenance.datasetContentHash !== datasetContentHash) {
    throw new Error(
      "Declared behavior-fit dataset content hash does not match input.",
    );
  }
  if (provenance.scorerHash !== BEHAVIOR_FIT_SCORER_HASH) {
    throw new Error("Declared behavior-fit scorer hash is stale.");
  }
  if (provenance.configFamilyHash !== input.configFamilyHash) {
    throw new Error(
      "Declared behavior config-family hash does not match grid.",
    );
  }
  return deepFreezeBehavior(provenance);
}

function validateWorldCountCoverage(
  observations: readonly ParsedObservation[],
  candidates: readonly BehaviorCandidateParameters[],
): void {
  const requiredCounts = new Set(candidates.map((value) => value.worldCount));
  for (const observation of observations) {
    const available = new Set(
      observation.worldEstimates.map((estimate) => estimate.worldCount),
    );
    for (const worldCount of requiredCounts) {
      if (!available.has(worldCount)) {
        throw new Error(
          `Observation ${observation.observationId} is missing the ${worldCount.toString()}-world grid estimate.`,
        );
      }
    }
  }
}

function initialPriorRecord(
  value: Partial<Record<BehaviorModelId, number>> | undefined,
  parameters: BehaviorCandidateParameters,
): ProbabilityRecord {
  return validateBehaviorModelConfig({
    lapseProbability: parameters.lapseProbability,
    likelihoodPower: parameters.likelihoodPower,
    maximumBayesFactor: parameters.maximumBayesFactor,
    ...(value === undefined ? {} : { modelPriors: value }),
  }).modelPriors;
}

export function fitTrainBehaviorGrid(input: {
  readonly observations: readonly unknown[];
  readonly grid: BehaviorHyperparameterGridInput;
  readonly provenance: BehaviorFitProvenance;
  readonly initialPriors?: Partial<
    OpponentRecord<Partial<Record<BehaviorModelId, number>>>
  >;
}): BehaviorTrainGridFit {
  const observations = parseObservations(input.observations, "train");
  const candidates = expandBehaviorHyperparameterGrid(input.grid);
  const configFamilyHash = behaviorConfigFamilyHash(input.grid);
  const provenance = validateProvenance({
    provenance: input.provenance,
    observations,
    configFamilyHash,
  });
  validateWorldCountCoverage(observations, candidates);
  const fits = candidates.map((parameters): BehaviorTrainCandidateFit => {
    const opponents = Object.fromEntries(
      opponentSeats.map((seat) => {
        const sequences = groupSequences(observations, seat);
        const initialPriors = initialPriorRecord(
          input.initialPriors?.[seat],
          parameters,
        );
        const fitted = fitOpponentPriors(sequences, parameters, initialPriors);
        const score = scoreOpponent(sequences, parameters, fitted.priors);
        const diagnostics: OpponentFitDiagnostics = {
          ...score,
          initialPriors,
          fittedPriors: fitted.priors,
          emIterations: fitted.iterations,
          emConverged: fitted.converged,
        };
        return [seat, deepFreezeBehavior(diagnostics)];
      }),
    ) as OpponentRecord<OpponentFitDiagnostics>;
    const observationCount =
      opponents.p2.observationCount + opponents.p3.observationCount;
    const cumulativeNegativeLogLikelihood =
      opponents.p2.cumulativeNegativeLogLikelihood +
      opponents.p3.cumulativeNegativeLogLikelihood;
    return deepFreezeBehavior({
      candidateId: behaviorCandidateId(parameters),
      tieBreakKey: behaviorCandidateTieBreakKey(parameters),
      parameters,
      opponents,
      observationCount,
      cumulativeNegativeLogLikelihood,
      meanNegativeLogLikelihood:
        cumulativeNegativeLogLikelihood / observationCount,
    });
  });
  return deepFreezeBehavior({
    schemaVersion: 1,
    algorithmVersion: BEHAVIOR_FIT_ALGORITHM_VERSION,
    evidenceClass: "phase8-behavior-train",
    split: "train",
    behaviorModelHash: BEHAVIOR_MODEL_HASH,
    provenance,
    candidateCount: fits.length,
    candidates: fits,
  });
}

function compareCandidateScores(
  left: {
    readonly meanNegativeLogLikelihood: number;
    readonly tieBreakKey: string;
  },
  right: {
    readonly meanNegativeLogLikelihood: number;
    readonly tieBreakKey: string;
  },
): number {
  const difference =
    left.meanNegativeLogLikelihood - right.meanNegativeLogLikelihood;
  return Math.abs(difference) <= 1e-12
    ? left.tieBreakKey.localeCompare(right.tieBreakKey)
    : difference;
}

function assertTuneProvenanceDisjoint(
  train: BehaviorFitProvenance,
  tune: BehaviorFitProvenance,
): void {
  if (train.sourceHash !== tune.sourceHash) {
    throw new Error("Train and tune source hashes must match.");
  }
  if (train.scorerHash !== tune.scorerHash) {
    throw new Error("Train and tune scorer hashes must match.");
  }
  if (train.configFamilyHash !== tune.configFamilyHash) {
    throw new Error("Train and tune config-family hashes must match.");
  }
  if (
    train.datasetHash === tune.datasetHash ||
    train.datasetContentHash === tune.datasetContentHash ||
    train.scheduleHash === tune.scheduleHash
  ) {
    throw new Error(
      "Train and tune must have disjoint dataset, content, and schedule hashes.",
    );
  }
}

export function selectTuneBehaviorModel(input: {
  readonly trainFit: BehaviorTrainGridFit;
  readonly observations: readonly unknown[];
  readonly provenance: BehaviorFitProvenance;
}): BehaviorTuneSelection {
  if (
    input.trainFit.behaviorModelHash !== BEHAVIOR_MODEL_HASH ||
    input.trainFit.candidateCount !== input.trainFit.candidates.length ||
    input.trainFit.candidates.length === 0
  ) {
    throw new Error("Train fit is stale, malformed, or empty.");
  }
  const observations = parseObservations(input.observations, "tune");
  const provenance = validateProvenance({
    provenance: input.provenance,
    observations,
    configFamilyHash: input.trainFit.provenance.configFamilyHash,
  });
  assertTuneProvenanceDisjoint(input.trainFit.provenance, provenance);
  validateWorldCountCoverage(
    observations,
    input.trainFit.candidates.map((candidate) => candidate.parameters),
  );
  const scores = input.trainFit.candidates.map(
    (candidate): BehaviorTuneCandidateScore => {
      const opponents = Object.fromEntries(
        opponentSeats.map((seat) => {
          const sequences = groupSequences(observations, seat);
          const score = scoreOpponent(
            sequences,
            candidate.parameters,
            candidate.opponents[seat].fittedPriors,
          );
          const diagnostics: OpponentTuneDiagnostics = {
            ...score,
            startingPriors: candidate.opponents[seat].fittedPriors,
          };
          return [seat, deepFreezeBehavior(diagnostics)];
        }),
      ) as OpponentRecord<OpponentTuneDiagnostics>;
      const observationCount =
        opponents.p2.observationCount + opponents.p3.observationCount;
      const cumulativeNegativeLogLikelihood =
        opponents.p2.cumulativeNegativeLogLikelihood +
        opponents.p3.cumulativeNegativeLogLikelihood;
      return deepFreezeBehavior({
        candidateId: candidate.candidateId,
        tieBreakKey: candidate.tieBreakKey,
        parameters: candidate.parameters,
        opponents,
        observationCount,
        cumulativeNegativeLogLikelihood,
        meanNegativeLogLikelihood:
          cumulativeNegativeLogLikelihood / observationCount,
        worstOpponentMeanNegativeLogLikelihood: Math.max(
          opponents.p2.meanNegativeLogLikelihood,
          opponents.p3.meanNegativeLogLikelihood,
        ),
      });
    },
  );
  const selected = [...scores].sort(compareCandidateScores)[0];
  if (selected === undefined) {
    throw new Error("Tune selection produced no candidate.");
  }
  return deepFreezeBehavior({
    schemaVersion: 1,
    algorithmVersion: BEHAVIOR_FIT_ALGORITHM_VERSION,
    evidenceClass: "phase8-behavior-tune",
    split: "tune",
    selectionMetric: "pooled-prequential-negative-log-likelihood",
    behaviorModelHash: BEHAVIOR_MODEL_HASH,
    trainProvenance: input.trainFit.provenance,
    tuneProvenance: provenance,
    selectedCandidateId: selected.candidateId,
    candidateScores: scores,
  });
}

export function selectedBehaviorModelPayloadChecksum(
  payload: SelectedBehaviorModelArtifactPayload,
): string {
  return stableHash({
    schemaVersion: 1,
    artifactKind: BEHAVIOR_FIT_ARTIFACT_KIND,
    payload,
  });
}

export function createSelectedBehaviorModelArtifact(input: {
  readonly trainFit: BehaviorTrainGridFit;
  readonly tuneSelection: BehaviorTuneSelection;
}): SelectedBehaviorModelArtifact {
  if (
    input.tuneSelection.trainProvenance.datasetHash !==
      input.trainFit.provenance.datasetHash ||
    input.tuneSelection.trainProvenance.configFamilyHash !==
      input.trainFit.provenance.configFamilyHash
  ) {
    throw new Error(
      "Tune selection does not belong to the supplied train fit.",
    );
  }
  const selectedTrain = input.trainFit.candidates.find(
    (candidate) =>
      candidate.candidateId === input.tuneSelection.selectedCandidateId,
  );
  const selectedTune = input.tuneSelection.candidateScores.find(
    (candidate) =>
      candidate.candidateId === input.tuneSelection.selectedCandidateId,
  );
  if (selectedTrain === undefined || selectedTune === undefined) {
    throw new Error("Selected candidate is absent from train or tune results.");
  }
  const opponentConfigs = Object.fromEntries(
    opponentSeats.map((seat) => [
      seat,
      validateBehaviorModelConfig({
        lapseProbability: selectedTrain.parameters.lapseProbability,
        likelihoodPower: selectedTrain.parameters.likelihoodPower,
        maximumBayesFactor: selectedTrain.parameters.maximumBayesFactor,
        modelPriors: selectedTrain.opponents[seat].fittedPriors,
      }),
    ]),
  ) as OpponentRecord<BehaviorModelConfig>;
  const payload = artifactPayloadSchema.parse({
    schemaVersion: 1,
    algorithmVersion: BEHAVIOR_FIT_ALGORITHM_VERSION,
    selectionMetric: input.tuneSelection.selectionMetric,
    behaviorModelHash: BEHAVIOR_MODEL_HASH,
    sourceHash: input.trainFit.provenance.sourceHash,
    scorerHash: input.trainFit.provenance.scorerHash,
    configFamilyHash: input.trainFit.provenance.configFamilyHash,
    train: {
      split: "train",
      datasetHash: input.trainFit.provenance.datasetHash,
      datasetContentHash: input.trainFit.provenance.datasetContentHash,
      scheduleHash: input.trainFit.provenance.scheduleHash,
      observationCount: selectedTrain.observationCount,
    },
    tune: {
      split: "tune",
      datasetHash: input.tuneSelection.tuneProvenance.datasetHash,
      datasetContentHash: input.tuneSelection.tuneProvenance.datasetContentHash,
      scheduleHash: input.tuneSelection.tuneProvenance.scheduleHash,
      observationCount: selectedTune.observationCount,
    },
    selectedCandidateId: selectedTrain.candidateId,
    selectedTieBreakKey: selectedTrain.tieBreakKey,
    parameters: selectedTrain.parameters,
    opponentConfigs,
    trainDiagnostics: selectedTrain.opponents,
    tuneDiagnostics: selectedTune.opponents,
    candidateScores: input.tuneSelection.candidateScores
      .map((score) => ({
        candidateId: score.candidateId,
        tieBreakKey: score.tieBreakKey,
        meanNegativeLogLikelihood: score.meanNegativeLogLikelihood,
        worstOpponentMeanNegativeLogLikelihood:
          score.worstOpponentMeanNegativeLogLikelihood,
      }))
      .sort((left, right) => left.tieBreakKey.localeCompare(right.tieBreakKey)),
  });
  const artifact = {
    schemaVersion: 1,
    artifactKind: BEHAVIOR_FIT_ARTIFACT_KIND,
    payload,
    payloadChecksum: selectedBehaviorModelPayloadChecksum(payload),
  } as const;
  const verification = verifySelectedBehaviorModelArtifact(artifact);
  if (!verification.ok) {
    throw new Error(
      `Selected behavior-model artifact failed verification: ${verification.issues.join("; ")}`,
    );
  }
  return deepFreezeBehavior(artifact);
}

export type SelectedBehaviorModelVerification = {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly artifact: SelectedBehaviorModelArtifact | null;
};

export function verifySelectedBehaviorModelArtifact(
  value: unknown,
): SelectedBehaviorModelVerification {
  const parsed = selectedBehaviorModelArtifactSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      ),
      artifact: null,
    };
  }
  const expectedChecksum = selectedBehaviorModelPayloadChecksum(
    parsed.data.payload,
  );
  if (parsed.data.payloadChecksum !== expectedChecksum) {
    return {
      ok: false,
      issues: ["Selected behavior-model payload checksum mismatch."],
      artifact: null,
    };
  }
  return {
    ok: true,
    issues: [],
    artifact: deepFreezeBehavior(parsed.data as SelectedBehaviorModelArtifact),
  };
}

export function serializeSelectedBehaviorModelArtifact(
  artifact: SelectedBehaviorModelArtifact,
): string {
  const verification = verifySelectedBehaviorModelArtifact(artifact);
  if (!verification.ok || verification.artifact === null) {
    throw new Error(
      `Cannot serialize invalid behavior-model artifact: ${verification.issues.join("; ")}`,
    );
  }
  return `${stableStringify(verification.artifact)}\n`;
}

export function parseSelectedBehaviorModelArtifact(
  serialized: string,
): SelectedBehaviorModelArtifact {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (cause) {
    throw new Error("Selected behavior-model artifact is not valid JSON.", {
      cause,
    });
  }
  const verification = verifySelectedBehaviorModelArtifact(value);
  if (!verification.ok || verification.artifact === null) {
    throw new Error(
      `Selected behavior-model artifact is invalid: ${verification.issues.join("; ")}`,
    );
  }
  return verification.artifact;
}

/**
 * Converts the sealed train/tune selection into the public-inference input.
 * Shared likelihood controls come from the selected candidate while P2/P3
 * retain their independently fitted train priors.
 */
export function behaviorBeliefConfigFromSelectedArtifact(
  value: unknown,
): BehaviorBeliefConfigInput {
  const verification = verifySelectedBehaviorModelArtifact(value);
  if (!verification.ok || verification.artifact === null) {
    throw new Error(
      `Cannot use invalid behavior-model artifact: ${verification.issues.join("; ")}`,
    );
  }
  const artifact = verification.artifact;
  return deepFreezeBehavior({
    lapseProbability: artifact.payload.parameters.lapseProbability,
    likelihoodPower: artifact.payload.parameters.likelihoodPower,
    maximumBayesFactor: artifact.payload.parameters.maximumBayesFactor,
    opponentModelPriors: {
      p2: artifact.payload.opponentConfigs.p2.modelPriors,
      p3: artifact.payload.opponentConfigs.p3.modelPriors,
    },
  });
}
