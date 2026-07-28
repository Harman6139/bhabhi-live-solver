import { z } from "zod";

import { isCard, type Card } from "../domain/cards";
import { ruleConfigSchema } from "../domain/rule-config";
import { SEATS } from "../domain/seats";
import { gameEventSchema } from "../events/game-events";
import { EXACT_INELIGIBILITY_CODES } from "../search/advanced-types";
import { EVALUATION_SPLITS } from "./protocol";

export const PHASE7_COMPARISON_ARTIFACT_SCHEMA_VERSION = 2 as const;
export const PHASE7_COMPARISON_RUNNER_VERSION =
  "phase7-paired-comparison-v1" as const;
export const PHASE7_COMPARISON_EVIDENCE_CLASS =
  "phase7-development-screen" as const;
export const PHASE7_COMPARISON_BOOTSTRAP_RESAMPLES = 20_000 as const;
export const PHASE7_COMPARISON_CONFIG_ROLES = [
  "reference",
  "candidate",
] as const;
export const PHASE7_COMPARISON_RUN_KINDS = [
  "smoke",
  "development-primary",
  "development-reproduction",
] as const;
export type Phase7ComparisonConfigRole =
  (typeof PHASE7_COMPARISON_CONFIG_ROLES)[number];
export type Phase7ComparisonRunKind =
  (typeof PHASE7_COMPARISON_RUN_KINDS)[number];

const identifier = z.string().trim().min(1);
const hash = identifier;
const nonnegativeInteger = z.int().nonnegative();
const positiveInteger = z.int().positive();
const rotation = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const configRole = z.enum(PHASE7_COMPARISON_CONFIG_ROLES);
const card = z.custom<Card>(isCard, {
  message: "Expected a canonical card code.",
});
const comparisonSeedIdsSchema = z
  .object({
    deal: identifier,
    userPolicy: identifier,
    p2Policy: identifier,
    p3Policy: identifier,
    environmentChance: identifier,
    belief: identifier,
    search: identifier,
    rollout: identifier,
    solverChance: identifier,
    bootstrap: identifier,
  })
  .strict();

export const phase7ComparisonConfigurationSchema = z
  .object({
    role: configRole,
    configId: identifier,
    configHash: hash,
    method: z.enum([
      "frozen-phase5-balanced-hard-only",
      "exact-information-state-then-frozen-phase5-fallback",
    ]),
    executionPath: z.enum([
      "direct-phase5-recommend-from-timeline-v1",
      "research-exact-then-phase5-fallback-v1",
    ]),
    budgetId: z.literal("balanced"),
    beliefMode: z.literal("hard-only"),
    continuationPolicies: z
      .object({
        user: z.literal("documented-basic"),
        p2: z.literal("documented-basic"),
        p3: z.literal("documented-basic"),
      })
      .strict(),
    exactScreen: z
      .object({
        executionMode: z.literal("research-only"),
        maxActiveCards: z.literal(7),
        maxJointHypotheses: z.literal(196),
        maxInformationStates: z.literal(128),
        maxBranches: z.literal(512),
        approximateHypothesisSamples: z.literal(196),
        deadlineMs: z.literal(1_000),
      })
      .strict()
      .nullable(),
    exactEnabled: z.boolean(),
    behaviorWeightingEnabled: z.boolean(),
  })
  .strict();
export type Phase7ComparisonConfiguration = z.infer<
  typeof phase7ComparisonConfigurationSchema
>;

const refusalCountSchema = z
  .object({
    code: identifier,
    count: positiveInteger,
  })
  .strict();
export type Phase7RefusalCount = z.infer<typeof refusalCountSchema>;

const comparisonCoordinateSchema = z
  .object({
    schemaVersion: z.literal(PHASE7_COMPARISON_ARTIFACT_SCHEMA_VERSION),
    protocolId: z.literal("eval-v1"),
    runId: identifier,
    split: z.enum(EVALUATION_SPLITS),
    evidenceClass: z.literal(PHASE7_COMPARISON_EVIDENCE_CLASS),
    pairId: identifier,
    clusterId: identifier,
    configRole,
    configId: identifier,
    styleCellId: identifier,
    baseIndex: nonnegativeInteger,
    rotation,
    replicate: z.literal(0),
    gameId: identifier,
  })
  .strict();

export const phase7ComparisonGameRecordSchema =
  comparisonCoordinateSchema.extend({
    recordType: z.literal("phase7-comparison-game"),
    completionStatus: z.literal("complete"),
    opponentPolicies: z
      .object({
        p2: identifier,
        p3: identifier,
      })
      .strict(),
    bhabhi: z.enum(SEATS),
    userBhabhi: z.boolean(),
    userFinishingPosition: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    escapeOrder: z.array(z.enum(SEATS)),
    terminalReason: identifier,
    terminalHandCounts: z
      .object({
        user: nonnegativeInteger,
        p2: nonnegativeInteger,
        p3: nonnegativeInteger,
      })
      .strict(),
    eventCount: positiveInteger,
    publicHistoryHash: hash,
    terminalPublicStateHash: hash,
    deterministicOutcomeHash: hash,
    deterministicGameDigest: hash,
    events: z.array(gameEventSchema).min(1),
    seedIds: comparisonSeedIdsSchema,
    gameWallTimeMs: z.number().nonnegative(),
  });
export type Phase7ComparisonGameRecord = z.infer<
  typeof phase7ComparisonGameRecordSchema
>;

const handsSchema = z
  .object({
    user: z.array(card),
    p2: z.array(card),
    p3: z.array(card),
  })
  .strict();

export const phase7ComparisonTruthRecordSchema =
  comparisonCoordinateSchema.extend({
    recordType: z.literal("phase7-comparison-truth-eval-only"),
    initialHands: handsSchema,
    finalHands: handsSchema,
    truthHash: hash,
  });
export type Phase7ComparisonTruthRecord = z.infer<
  typeof phase7ComparisonTruthRecordSchema
>;

export const phase7ComparisonFailureRecordSchema =
  comparisonCoordinateSchema.extend({
    recordType: z.literal("phase7-comparison-failure"),
    completionStatus: z.enum(["failed", "turn-cap", "cancelled"]),
    failureId: identifier,
    kind: z.enum([
      "invariant",
      "illegal-policy-action",
      "exception",
      "turn-cap",
      "cancellation",
      "artifact-validation",
    ]),
    stage: identifier,
    error: z
      .object({
        name: identifier,
        code: identifier.nullable(),
        message: identifier,
      })
      .strict(),
    lastGoodEventIndex: z.int(),
    deterministicFailureHash: hash,
    seedIds: comparisonSeedIdsSchema,
  });
export type Phase7ComparisonFailureRecord = z.infer<
  typeof phase7ComparisonFailureRecordSchema
>;

export const phase7ComparisonDecisionRecordSchema =
  comparisonCoordinateSchema.extend({
    recordType: z.literal("phase7-comparison-decision"),
    decisionId: identifier,
    decisionOrdinal: nonnegativeInteger,
    eventIndex: nonnegativeInteger,
    publicHistoryHash: hash,
    publicStateHash: hash,
    observationHash: hash,
    actionKind: z.enum(["play-card", "take-hand"]),
    selectedCard: card.nullable(),
    selectedTakeTarget: z.enum(SEATS).nullable(),
    selectedActionHash: hash,
    dispatchOutcome: z.enum(["exact", "fallback"]),
    quality: z.enum(["Exact", "Approximate"]),
    exactOutcome: z.enum(["not-attempted", "used", "refused", "error"]),
    exactRefusalCode: z.enum(EXACT_INELIGIBILITY_CODES).nullable(),
    exactRefusalDetail: z
      .object({
        code: z.enum(EXACT_INELIGIBILITY_CODES),
        message: identifier,
        boundaryHash: hash,
      })
      .strict()
      .nullable(),
    fallbackParity: z.enum(["not-checked", "passed", "failed"]),
    dispatchHash: hash,
    analysisInputHash: hash,
    analysisOutputHash: hash,
    exactAlgorithmId: identifier.nullable(),
    exactConfigHash: hash.nullable(),
    hypothesisSetHash: hash.nullable(),
    exactResultHash: hash.nullable(),
    exactDiagnosticsHash: hash.nullable(),
    exactActionValuesHash: hash.nullable(),
    positionalDiagnosticsHash: hash.nullable(),
    fallbackConfigHash: hash.nullable(),
    fallbackResultHash: hash.nullable(),
    beliefSeedId: identifier,
    searchSeedId: identifier,
  });
export type Phase7ComparisonDecisionRecord = z.infer<
  typeof phase7ComparisonDecisionRecordSchema
>;

export const phase7ComparisonLatencyRecordSchema =
  comparisonCoordinateSchema.extend({
    recordType: z.literal("phase7-comparison-latency"),
    decisionId: identifier,
    decisionOrdinal: nonnegativeInteger,
    eventIndex: nonnegativeInteger,
    totalMs: z.number().nonnegative(),
    exactMs: z.number().nonnegative().nullable(),
    fallbackMs: z.number().nonnegative().nullable(),
  });
export type Phase7ComparisonLatencyRecord = z.infer<
  typeof phase7ComparisonLatencyRecordSchema
>;

const configAggregateSchema = z
  .object({
    role: configRole,
    configId: identifier,
    games: nonnegativeInteger,
    failures: nonnegativeInteger,
    userBhabhiCount: nonnegativeInteger,
    userBhabhiRate: z.number().min(0).max(1).nullable(),
    userDecisionCount: nonnegativeInteger,
    exactAttemptCount: nonnegativeInteger,
    exactUseCount: nonnegativeInteger,
    exactRefusalCount: nonnegativeInteger,
    exactErrorCount: nonnegativeInteger,
    exactNotAttemptedCount: nonnegativeInteger,
    fallbackUseCount: nonnegativeInteger,
    refusalCounts: z.array(refusalCountSchema),
    silentFallbackCount: nonnegativeInteger,
    fallbackParityCheckCount: nonnegativeInteger,
    fallbackParityFailureCount: nonnegativeInteger,
  })
  .strict();
export type Phase7ConfigAggregate = z.infer<typeof configAggregateSchema>;

const pairedMacroIntervalSchema = z
  .object({
    metric: z.literal("user-bhabhi-rate-candidate-minus-reference"),
    aggregation: z.literal(
      "equal-weight-base-index-cluster-over-17-cells-and-3-rotations",
    ),
    method: z.literal("paired-cluster-bootstrap-percentile"),
    confidenceLevel: z.literal(0.95),
    resamples: z.literal(PHASE7_COMPARISON_BOOTSTRAP_RESAMPLES),
    seedId: identifier,
    clusterCount: positiveInteger,
    outcomesPerConfigPerCluster: z.literal(51),
    referenceRate: z.number().min(0).max(1),
    candidateRate: z.number().min(0).max(1),
    estimate: z.number().min(-1).max(1),
    lower: z.number().min(-1).max(1),
    upper: z.number().min(-1).max(1),
  })
  .strict();
export type Phase7PairedMacroInterval = z.infer<
  typeof pairedMacroIntervalSchema
>;

const latencyAggregateSchema = z
  .object({
    role: configRole,
    configId: identifier,
    samples: nonnegativeInteger,
    p50Ms: z.number().nonnegative().nullable(),
    p95Ms: z.number().nonnegative().nullable(),
    maxMs: z.number().nonnegative().nullable(),
  })
  .strict();

export const phase7ComparisonSummarySchema = z
  .object({
    schemaVersion: z.literal(PHASE7_COMPARISON_ARTIFACT_SCHEMA_VERSION),
    protocolId: z.literal("eval-v1"),
    runnerVersion: z.literal(PHASE7_COMPARISON_RUNNER_VERSION),
    runId: identifier,
    split: z.enum(EVALUATION_SPLITS),
    evidenceClass: z.literal(PHASE7_COMPARISON_EVIDENCE_CLASS),
    evidenceEligible: z.literal(false),
    runKind: z.enum(PHASE7_COMPARISON_RUN_KINDS),
    expectedPairs: positiveInteger,
    expectedGames: positiveInteger,
    attemptedGames: nonnegativeInteger,
    completedPairs: nonnegativeInteger,
    completedGames: nonnegativeInteger,
    failedGames: nonnegativeInteger,
    turnCapGames: nonnegativeInteger,
    invariantFailures: nonnegativeInteger,
    cancellationFailures: nonnegativeInteger,
    truthRecords: nonnegativeInteger,
    decisionRecords: nonnegativeInteger,
    latencyRecords: nonnegativeInteger,
    silentExclusionCount: nonnegativeInteger,
    protocolSampleSizeGate: z.boolean(),
    frozenConfigurationGate: z.boolean(),
    canonicalRulesGate: z.boolean(),
    seedDerivationGate: z.boolean(),
    pairedInitialDealGate: z.boolean(),
    decisionAuditCoverageGate: z.boolean(),
    zeroSilentExclusionGate: z.boolean(),
    fullMatrixGate: z.boolean(),
    identicalScenarioSeedCoverageGate: z.boolean(),
    pairingCompleteGate: z.boolean(),
    zeroFailureGate: z.boolean(),
    zeroTurnCapGate: z.boolean(),
    zeroInvariantFailureGate: z.boolean(),
    zeroCancellationGate: z.boolean(),
    zeroSilentFallbackGate: z.boolean(),
    atLeastOneExactUseGate: z.boolean(),
    zeroDeadlineRefusalGate: z.boolean(),
    everyCandidateFallbackTypedGate: z.boolean(),
    noPartialExactGate: z.boolean(),
    fallbackParityGate: z.boolean(),
    truthReplayGate: z.boolean(),
    configAggregates: z.array(configAggregateSchema).length(2),
    pairedMacro: pairedMacroIntervalSchema.nullable(),
    latency: z.array(latencyAggregateSchema).length(2),
    scientificDigest: hash,
  })
  .strict();
export type Phase7ComparisonSummary = z.infer<
  typeof phase7ComparisonSummarySchema
>;

const rawStreamsSha256Schema = z
  .object({
    gamesSha256: z.string().length(64),
    truthsSha256: z.string().length(64),
    failuresSha256: z.string().length(64),
    decisionsSha256: z.string().length(64),
    latenciesSha256: z.string().length(64),
  })
  .strict();

export const phase7ComparisonReproductionReferenceSchema = z
  .object({
    runId: identifier,
    scientificDigest: hash,
    manifestSha256: z.string().length(64),
    checksumsSha256: z.string().length(64),
  })
  .strict();
export type Phase7ComparisonReproductionReference = z.infer<
  typeof phase7ComparisonReproductionReferenceSchema
>;

export const phase7ComparisonManifestSchema = z
  .object({
    schemaVersion: z.literal(PHASE7_COMPARISON_ARTIFACT_SCHEMA_VERSION),
    artifactSchemaVersion: z.literal(PHASE7_COMPARISON_ARTIFACT_SCHEMA_VERSION),
    runnerVersion: z.literal(PHASE7_COMPARISON_RUNNER_VERSION),
    protocolId: z.literal("eval-v1"),
    runId: identifier,
    split: z.enum(EVALUATION_SPLITS),
    evidenceClass: z.literal(PHASE7_COMPARISON_EVIDENCE_CLASS),
    evidenceEligible: z.literal(false),
    runKind: z.enum(PHASE7_COMPARISON_RUN_KINDS),
    reproductionReference:
      phase7ComparisonReproductionReferenceSchema.nullable(),
    createdAt: z.iso.datetime(),
    sourceSnapshotSha256: z.string().length(64),
    sourceFileCount: positiveInteger,
    gitCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
    gitStatusSha256: z.string().length(64),
    gitDirty: z.boolean(),
    protocolPlanSha256: z.string().length(64),
    ruleProfileId: identifier,
    rules: ruleConfigSchema,
    rulesHash: hash,
    configurations: z.array(phase7ComparisonConfigurationSchema).length(2),
    styleCellIds: z.array(identifier).length(17),
    baseIndexStart: nonnegativeInteger,
    baseCount: positiveInteger,
    rotations: z.array(rotation).length(3),
    replicate: z.literal(0),
    eventCap: positiveInteger,
    verifyFallbackParity: z.literal(true),
    seedPolicyId: z.literal(
      "phase7-private-environment-public-solver-seeds-v1",
    ),
    expectedPairs: positiveInteger,
    expectedGames: positiveInteger,
    bootstrapResamples: z.literal(PHASE7_COMPARISON_BOOTSTRAP_RESAMPLES),
    bootstrapSeedId: identifier,
    clusterDefinition: z.literal(
      "baseIndex-keeps-all-17-style-cells-and-3-rotations",
    ),
    pairingDefinition: z.literal(
      "reference-and-candidate-share-style-cell-baseIndex-rotation",
    ),
    recordOrder: z.literal(
      "baseIndex-style-cell-rotation-config-role-user-decision",
    ),
    rawStreamsSha256: rawStreamsSha256Schema,
    scientificProjectionVersion: z.literal(
      "phase7-timing-environment-free-projection-v1",
    ),
    scientificContractSha256: z.string().length(64),
    scientificDigest: hash,
    nondeterministicFields: z.tuple([
      z.literal("manifest.createdAt"),
      z.literal("environment"),
      z.literal("games[*].gameWallTimeMs"),
      z.literal("latencies"),
    ]),
    command: identifier,
  })
  .strict();
export type Phase7ComparisonManifest = z.infer<
  typeof phase7ComparisonManifestSchema
>;

const phase7ComparisonArtifactBindingSchema = z
  .object({
    runId: identifier,
    manifestSha256: z.string().length(64),
    checksumsSha256: z.string().length(64),
    scientificDigest: hash,
  })
  .strict();

export const phase7ComparisonReproductionAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("eval-v1"),
    runnerVersion: z.literal(PHASE7_COMPARISON_RUNNER_VERSION),
    attestationId: identifier,
    smoke: phase7ComparisonArtifactBindingSchema,
    primary: phase7ComparisonArtifactBindingSchema,
    reproduction: phase7ComparisonArtifactBindingSchema,
    scientificContractSha256: z.string().length(64),
    sourceSnapshotSha256: z.string().length(64),
    protocolPlanSha256: z.string().length(64),
    excludedFields: z.tuple([
      z.literal("manifest.createdAt"),
      z.literal("environment"),
      z.literal("games[*].gameWallTimeMs"),
      z.literal("latencies"),
    ]),
    smokePrerequisiteGate: z.literal(true),
    primaryIntegrityGate: z.literal(true),
    reproductionIntegrityGate: z.literal(true),
    scientificDigestRerunGate: z.literal(true),
  })
  .strict();
export type Phase7ComparisonReproductionAttestation = z.infer<
  typeof phase7ComparisonReproductionAttestationSchema
>;
