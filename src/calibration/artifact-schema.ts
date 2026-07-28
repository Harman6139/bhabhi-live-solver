import { z } from "zod";

import { ruleConfigSchema } from "../domain/rule-config";
import { EVALUATION_SPLITS } from "../evaluation/protocol";

const identifier = z.string().min(1);
const hash = z.string().min(1);
const nonnegativeInteger = z.int().nonnegative();
const probability = z.number().min(0).max(1);
const opponentSeat = z.enum(["p2", "p3"]);

export const calibrationArmSchema = z.enum(["hard-only", "behavioral"]);
export type CalibrationArm = z.infer<typeof calibrationArmSchema>;

export const calibrationQueryFamilySchema = z.enum([
  "card-owner",
  "current-void",
  "suit-length",
  "can-overtake",
  "joint",
  "conditional",
  "opponent-action",
  "terminal-risk",
]);
export type CalibrationQueryFamily = z.infer<
  typeof calibrationQueryFamilySchema
>;

const calibrationSummaryFamilySchema = z.union([
  calibrationQueryFamilySchema,
  z.literal("overall-soft"),
]);
export type CalibrationSummaryFamily = z.infer<
  typeof calibrationSummaryFamilySchema
>;

export const PHASE6_BEHAVIOR_DISABLED_REASON =
  "Development-only Phase 6 smoke is ineligible; behavioral inference remains disabled pending clean qualification calibration and terminal noninferiority." as const;

const distributionEntrySchema = z
  .object({
    label: identifier,
    probability,
  })
  .strict();

const queryTargetSchema = z
  .object({
    kind: z.literal("query"),
    family: calibrationQueryFamilySchema.exclude([
      "opponent-action",
      "terminal-risk",
    ]),
    queryKey: identifier,
    labels: z.array(identifier).min(2),
    conditioningProbability: probability.nullable(),
  })
  .strict()
  .superRefine((target, context) => {
    const isConditional = target.family === "conditional";
    if (isConditional !== (target.conditioningProbability !== null)) {
      context.addIssue({
        code: "custom",
        path: ["conditioningProbability"],
        message:
          "conditional queries require a denominator and non-conditional queries require null",
      });
    }
  });

const actionTargetSchema = z
  .object({
    kind: z.literal("opponent-action"),
    family: z.literal("opponent-action"),
    actor: opponentSeat,
    actorDecisionOrdinal: nonnegativeInteger,
    legalActionKeys: z.array(identifier).min(1),
  })
  .strict();

const terminalTargetSchema = z
  .object({
    kind: z.literal("terminal-risk"),
    family: z.literal("terminal-risk"),
    actionKey: identifier,
    labels: z.tuple([z.literal("safe"), z.literal("bhabhi")]),
  })
  .strict();

function validateActionStratum(
  record: {
    readonly family: CalibrationSummaryFamily;
    readonly actionDecisionClass: "forced" | "discretionary" | null;
    readonly opponentSeat: "p2" | "p3" | null;
  },
  context: z.RefinementCtx,
): void {
  const isAction = record.family === "opponent-action";
  if (
    isAction !==
    (record.actionDecisionClass !== null && record.opponentSeat !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["actionDecisionClass"],
      message:
        "only opponent-action strata require both decision class and opponent seat",
    });
  }
}

export const calibrationPredictionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("eval-v1"),
    recordType: z.literal("calibration-prediction"),
    runId: identifier,
    split: z.enum(EVALUATION_SPLITS),
    evidenceClass: identifier,
    predictionId: identifier,
    pairId: identifier,
    gameId: identifier,
    scenarioId: identifier,
    calibrationClusterId: identifier,
    stateId: identifier,
    checkpointId: identifier,
    checkpointEventIndex: nonnegativeInteger,
    checkpointTiming: z.enum(["pre-action", "post-event"]),
    publicHistoryHash: hash,
    publicStateHash: hash,
    stateVersion: nonnegativeInteger,
    arm: calibrationArmSchema,
    target: z.discriminatedUnion("kind", [
      queryTargetSchema,
      actionTargetSchema,
      terminalTargetSchema,
    ]),
    /**
     * Arm-specific denominator for conditional forecasts. The paired target
     * retains one shared query identity, while this diagnostic proves that
     * both the hard and behavior-weighted condition cleared the frozen floor.
     */
    armConditioningProbability: probability.nullable(),
    // Opponent-action targets can be genuinely forced. In that case the exact
    // predictive support contains one legal action and must not be padded with
    // an impossible sentinel merely to satisfy an artifact shape constraint.
    distribution: z.array(distributionEntrySchema).min(1),
    hardKnown: z.boolean(),
    method: identifier,
    worldOccurrences: z.int().positive(),
    uniqueWitnesses: z.int().positive(),
    effectiveSampleSize: z.number().positive(),
    entropyNats: z.number().nonnegative(),
    maximumWorldWeight: probability,
    hardWorldSetChecksum: hash,
    hardBeliefConfigHash: hash,
    modelBundleHash: hash,
    featureBundleHash: hash,
    queryPlanHash: hash,
    configHash: hash,
    seedId: hash,
  })
  .strict()
  .superRefine((record, context) => {
    const isConditional =
      record.target.kind === "query" && record.target.family === "conditional";
    if (isConditional !== (record.armConditioningProbability !== null)) {
      context.addIssue({
        code: "custom",
        path: ["armConditioningProbability"],
        message:
          "conditional predictions require an arm-specific denominator and all other predictions require null",
      });
    }
  });
export type CalibrationPredictionRecord = z.infer<
  typeof calibrationPredictionRecordSchema
>;

export const calibrationTruthRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("eval-v1"),
    recordType: z.literal("calibration-truth-eval-only"),
    runId: identifier,
    split: z.enum(EVALUATION_SPLITS),
    pairId: identifier,
    gameId: identifier,
    stateId: identifier,
    scoreStatus: z.enum(["scored", "conditioning-false"]),
    targetLabel: identifier.nullable(),
    forcedAction: z.boolean().nullable(),
    trueOpponentModels: z
      .object({
        p2: identifier,
        p3: identifier,
      })
      .strict(),
    truthStateHash: hash,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.scoreStatus === "scored" && record.targetLabel === null) {
      context.addIssue({
        code: "custom",
        path: ["targetLabel"],
        message: "a scored truth record requires a target label",
      });
    }
    if (
      record.scoreStatus === "conditioning-false" &&
      (record.targetLabel !== null || record.forcedAction !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["scoreStatus"],
        message:
          "a conditioning-false truth record must have null target and forced-action fields",
      });
    }
  });
export type CalibrationTruthRecord = z.infer<
  typeof calibrationTruthRecordSchema
>;

export const calibrationSeedRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("eval-v1"),
    recordType: z.literal("calibration-seed"),
    runId: identifier,
    split: z.enum(EVALUATION_SPLITS),
    gameId: identifier,
    scenarioId: identifier,
    calibrationClusterId: identifier,
    styleCellId: identifier,
    baseIndex: nonnegativeInteger,
    rotation: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    replicate: nonnegativeInteger,
    seeds: z
      .object({
        deal: identifier,
        p2Policy: identifier,
        p3Policy: identifier,
        chance: identifier,
        belief: identifier,
        bootstrap: identifier,
      })
      .strict(),
  })
  .strict();
export type CalibrationSeedRecord = z.infer<typeof calibrationSeedRecordSchema>;

export const calibrationFailureRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("eval-v1"),
    recordType: z.literal("calibration-failure"),
    runId: identifier,
    split: z.enum(EVALUATION_SPLITS),
    failureId: identifier,
    gameId: identifier.nullable(),
    stateId: identifier.nullable(),
    stage: identifier,
    kind: z.enum([
      "simulation",
      "hard-inference",
      "behavior-inference",
      "prediction",
      "truth-join",
      "artifact-validation",
    ]),
    errorName: identifier,
    errorCode: identifier.nullable(),
    message: identifier,
    deterministicFailureHash: hash,
  })
  .strict();
export type CalibrationFailureRecord = z.infer<
  typeof calibrationFailureRecordSchema
>;

const scoreLineSchema = z
  .object({
    arm: calibrationArmSchema,
    family: calibrationSummaryFamilySchema,
    knowledgeStratum: z.enum(["hard-known", "unresolved-soft"]),
    actionDecisionClass: z.enum(["forced", "discretionary"]).nullable(),
    opponentSeat: opponentSeat.nullable(),
    observations: nonnegativeInteger,
    trajectories: nonnegativeInteger,
    clusters: nonnegativeInteger,
    meanBrier: z.number().nullable(),
    meanLogLoss: z.number().nullable(),
    rawZeroSupport: nonnegativeInteger,
    top1Accuracy: probability.nullable(),
    tieAwareTopSetAccuracy: probability.nullable(),
    tieAwareTop1Credit: probability.nullable(),
    coverage50: probability.nullable(),
    coverage80: probability.nullable(),
    coverage95: probability.nullable(),
  })
  .strict()
  .superRefine(validateActionStratum);

const pairedDifferenceSchema = z
  .object({
    family: calibrationSummaryFamilySchema,
    knowledgeStratum: z.enum(["hard-known", "unresolved-soft"]),
    actionDecisionClass: z.enum(["forced", "discretionary"]).nullable(),
    opponentSeat: opponentSeat.nullable(),
    metric: z.enum(["brier", "log-loss"]),
    estimate: z.number(),
    lower95: z.number(),
    upper95: z.number(),
    clusters: z.int().positive(),
    resamples: z.int().positive(),
    seedId: hash,
  })
  .strict()
  .superRefine(validateActionStratum);

const reliabilityBinSchema = z
  .object({
    index: z.int().min(0).max(9),
    lowerInclusive: probability,
    upper: probability,
    upperInclusive: z.boolean(),
    count: nonnegativeInteger,
    weight: z.number().nonnegative(),
    meanPrediction: probability.nullable(),
    observedRate: probability.nullable(),
  })
  .strict();

const reliabilityLineSchema = z
  .object({
    arm: calibrationArmSchema,
    family: calibrationQueryFamilySchema,
    knowledgeStratum: z.enum(["hard-known", "unresolved-soft"]),
    actionDecisionClass: z.enum(["forced", "discretionary"]).nullable(),
    opponentSeat: opponentSeat.nullable(),
    observations: nonnegativeInteger,
    bins: z.array(reliabilityBinSchema).length(10),
  })
  .strict()
  .superRefine(validateActionStratum);

export const calibrationSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("eval-v1"),
    runId: identifier,
    split: z.enum(EVALUATION_SPLITS),
    evidenceClass: identifier,
    evidenceEligible: z.boolean(),
    attemptedGames: nonnegativeInteger,
    completedGames: nonnegativeInteger,
    attemptedCheckpoints: nonnegativeInteger,
    completedCheckpoints: nonnegativeInteger,
    predictions: nonnegativeInteger,
    pairedTargets: nonnegativeInteger,
    truthRecords: nonnegativeInteger,
    skippedConditionalPairs: nonnegativeInteger,
    failures: nonnegativeInteger,
    zeroFailureGate: z.boolean(),
    scoreLines: z.array(scoreLineSchema),
    pairedDifferences: z.array(pairedDifferenceSchema),
    reliabilityLines: z.array(reliabilityLineSchema),
    hardKnownPreserved: z.boolean(),
    logicallyPossibleZeroSupport: nonnegativeInteger,
    behaviorProductionEnabled: z.boolean(),
    behaviorEnablementReason: z.literal(PHASE6_BEHAVIOR_DISABLED_REASON),
    reproductionDigest: hash,
  })
  .strict();
export type CalibrationSummary = z.infer<typeof calibrationSummarySchema>;

const runCountSchema = z
  .object({
    seedRecords: nonnegativeInteger,
    attemptedGames: nonnegativeInteger,
    completedGames: nonnegativeInteger,
    attemptedCheckpoints: nonnegativeInteger,
    completedCheckpoints: nonnegativeInteger,
    predictions: nonnegativeInteger,
    pairs: nonnegativeInteger,
    truthRecords: nonnegativeInteger,
    failures: nonnegativeInteger,
  })
  .strict();

const checkpointClassCountsSchema = z
  .object({
    initial: nonnegativeInteger,
    postOpening: nonnegativeInteger,
    fixedPublicEvent: nonnegativeInteger,
    postThulla: nonnegativeInteger,
    postVisiblePickup: nonnegativeInteger,
    preOpponentChoice: nonnegativeInteger,
  })
  .strict();

const rawStreamHashesSchema = z
  .object({
    seedsSha256: z.string().length(64),
    predictionsSha256: z.string().length(64),
    truthsSha256: z.string().length(64),
    failuresSha256: z.string().length(64),
  })
  .strict();

export const calibrationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactSchemaVersion: z.literal(2),
    runnerVersion: z.literal("phase6-calibration-v2"),
    protocolId: z.literal("eval-v1"),
    runId: identifier,
    split: z.enum(["dev", "train", "tune"]),
    evidenceClass: z.literal("phase6-calibration-smoke"),
    evidenceEligible: z.literal(false),
    createdAt: z.iso.datetime(),
    sourceSnapshotSha256: z.string().length(64),
    sourceFileCount: z.int().positive(),
    gitCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
    gitDirty: z.boolean(),
    gitStatusSha256: z.string().length(64),
    protocolPlanSha256: z.string().length(64),
    ruleProfileId: z.literal("canonical-v1"),
    rules: ruleConfigSchema,
    rulesHash: hash,
    userPolicyId: z.literal("documented-basic"),
    styleCellIds: z.array(identifier).min(1),
    baseIndexStart: nonnegativeInteger,
    baseCount: z.int().positive(),
    rotations: z
      .array(z.union([z.literal(0), z.literal(1), z.literal(2)]))
      .min(1),
    replicate: z.literal(0),
    expectedGames: z.int().positive(),
    hardWorldSamples: z.int().positive(),
    queryFamilies: z.tuple([
      z.literal("card-owner"),
      z.literal("current-void"),
      z.literal("suit-length"),
      z.literal("can-overtake"),
      z.literal("joint"),
      z.literal("conditional"),
      z.literal("opponent-action"),
    ]),
    opponentDecisionOrdinals: z.array(z.int().positive()).min(1),
    fixedPublicEventOrdinals: z.array(z.int().positive()),
    maximumPreActionCheckpointsPerGame: z.int().positive(),
    maximumPostEventCheckpointsPerGame: z.int().positive(),
    checkpointClasses: z.tuple([
      z.literal("initial"),
      z.literal("post-opening"),
      z.literal("fixed-public-event"),
      z.literal("post-thulla"),
      z.literal("post-visible-pickup"),
      z.literal("pre-opponent-choice"),
    ]),
    rngAlgorithm: z.literal("splitmix64-counter-v1"),
    seedDerivation: z.literal(
      "eval-v1-sha256-roots-plus-keyed-counter-streams",
    ),
    recordOrder: z.literal(
      "style-cell-base-index-rotation-checkpoint-query-arm",
    ),
    scheduleHash: hash,
    modelBundleHash: hash,
    behaviorConfigHash: hash,
    featureBundleHash: hash,
    scorerHash: hash,
    checkpointPlanHash: hash,
    queryPlanHash: hash,
    seedManifestHash: hash,
    binEdges: z.tuple([
      z.literal(0),
      z.literal(0.1),
      z.literal(0.2),
      z.literal(0.3),
      z.literal(0.4),
      z.literal(0.5),
      z.literal(0.6),
      z.literal(0.7),
      z.literal(0.8),
      z.literal(0.9),
      z.literal(1),
    ]),
    logLossEpsilon: z.literal(1e-12),
    conditionalProbabilityFloor: probability,
    bootstrapResamples: z.int().positive(),
    bootstrapSeedId: hash,
    clusterDefinition: z.literal(
      "calibration-trajectory-keeps-all-checkpoints-queries-and-rotations",
    ),
    predictionTiming: z.literal("prequential-predict-before-update"),
    truthBoundary: z.literal("truth-sidecar-joined-only-by-calibration-scorer"),
    expectedCounts: runCountSchema,
    actualCounts: runCountSchema,
    expectedCheckpointClassCounts: checkpointClassCountsSchema,
    actualCheckpointClassCounts: checkpointClassCountsSchema,
    rawStreamsSha256: rawStreamHashesSchema,
    behaviorProductionEnabled: z.literal(false),
    behaviorEnablementReason: z.literal(PHASE6_BEHAVIOR_DISABLED_REASON),
    command: identifier,
  })
  .strict();
export type CalibrationManifest = z.infer<typeof calibrationManifestSchema>;
