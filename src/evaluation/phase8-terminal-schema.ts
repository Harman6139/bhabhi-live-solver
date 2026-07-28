import { z } from "zod";

import { isCard, type Card } from "../domain/cards";
import { ruleConfigSchema } from "../domain/rule-config";
import { SEATS } from "../domain/seats";
import { gameEventSchema } from "../events/game-events";
import {
  PHASE8_CONFIGURATION_ROLE_IDS,
  phase8ConfigurationDescriptorSchema,
} from "./phase8-manifest";

export const PHASE8_TERMINAL_SCHEMA_VERSION = 1 as const;
export const PHASE8_TERMINAL_RUNNER_VERSION =
  "phase8-terminal-matrix-runner-v1" as const;
export const PHASE8_TERMINAL_EVIDENCE_CLASS =
  "phase8-confirmatory-terminal" as const;
export const PHASE8_TERMINAL_DEV_EVIDENCE_CLASS =
  "phase8-terminal-development-pilot" as const;
export const PHASE8_TERMINAL_AUTHORITY_KINDS = [
  "development-pilot",
  "qualification",
  "final",
] as const;
export const PHASE8_TERMINAL_EVIDENCE_CLASSES = [
  "phase8-terminal-development-pilot",
  "phase8-confirmatory-terminal",
] as const;
export const PHASE8_TERMINAL_OUTCOME_STATUSES = [
  "complete",
  "failed",
  "turn-cap",
  "analysis-cap",
  "cancelled",
] as const;

export type Phase8TerminalAuthorityKind =
  (typeof PHASE8_TERMINAL_AUTHORITY_KINDS)[number];
export type Phase8TerminalOutcomeStatus =
  (typeof PHASE8_TERMINAL_OUTCOME_STATUSES)[number];

const identifierSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const stableHashSchema = z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u);
const seedSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const nonnegativeIntegerSchema = z.int().nonnegative();
const positiveIntegerSchema = z.int().positive();
const nonnegativeFiniteSchema = z.number().nonnegative();
const probabilitySchema = z.number().min(0).max(1);
const cardSchema = z.custom<Card>(isCard, {
  message: "Expected a canonical card code.",
});

const userActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("play-card"),
      card: cardSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("take-hand"),
      target: z.enum(["p2", "p3"]),
    })
    .strict(),
]);

export const phase8TerminalComponentsSchema = z
  .object({
    exactEndgame: z.boolean(),
    behaviorWeighting: z.boolean(),
  })
  .strict();
export type Phase8TerminalComponents = z.infer<
  typeof phase8TerminalComponentsSchema
>;

const coordinateSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_TERMINAL_SCHEMA_VERSION),
    protocolId: z.literal("eval-v1"),
    runnerVersion: z.literal(PHASE8_TERMINAL_RUNNER_VERSION),
    evidenceClass: z.enum(PHASE8_TERMINAL_EVIDENCE_CLASSES),
    runId: identifierSchema,
    authorityKind: z.enum(PHASE8_TERMINAL_AUTHORITY_KINDS),
    manifestId: identifierSchema,
    manifestSha256: sha256Schema,
    split: z.enum(["dev", "qualification", "final"]),
    configId: z.enum(PHASE8_CONFIGURATION_ROLE_IDS),
    styleCellId: identifierSchema,
    baseIndex: nonnegativeIntegerSchema,
    rotation: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    replicate: z.literal(0),
    clusterId: identifierSchema,
    pairingKey: identifierSchema,
    scenarioId: stableHashSchema,
    gameId: stableHashSchema,
  })
  .strict();
export type Phase8TerminalCoordinate = z.infer<typeof coordinateSchema>;

export const phase8TerminalSeedRecordSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_TERMINAL_SCHEMA_VERSION),
    recordType: z.literal("phase8-terminal-seeds"),
    protocolId: z.literal("eval-v1"),
    runnerVersion: z.literal(PHASE8_TERMINAL_RUNNER_VERSION),
    evidenceClass: z.enum(PHASE8_TERMINAL_EVIDENCE_CLASSES),
    runId: identifierSchema,
    authorityKind: z.enum(PHASE8_TERMINAL_AUTHORITY_KINDS),
    manifestId: identifierSchema,
    manifestSha256: sha256Schema,
    split: z.enum(["dev", "qualification", "final"]),
    styleCellId: identifierSchema,
    baseIndex: nonnegativeIntegerSchema,
    rotation: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    replicate: z.literal(0),
    clusterId: identifierSchema,
    pairingKey: identifierSchema,
    scenarioId: stableHashSchema,
    seedIds: z
      .object({
        deal: seedSchema,
        userPolicy: seedSchema,
        p2Policy: seedSchema,
        p3Policy: seedSchema,
        environmentChance: seedSchema,
        belief: seedSchema,
        search: seedSchema,
        rollout: seedSchema,
        solverChance: seedSchema,
        bootstrap: seedSchema,
      })
      .strict(),
    seedRecordSha256: sha256Schema,
  })
  .strict();
export type Phase8TerminalSeedRecord = z.infer<
  typeof phase8TerminalSeedRecordSchema
>;

const terminalCommonSchema = coordinateSchema.extend({
  components: phase8TerminalComponentsSchema,
  configSha256: sha256Schema,
});

const handCountsSchema = z
  .object({
    user: nonnegativeIntegerSchema,
    p2: nonnegativeIntegerSchema,
    p3: nonnegativeIntegerSchema,
  })
  .strict();

export const phase8TerminalGameRecordSchema = terminalCommonSchema
  .extend({
    recordType: z.literal("phase8-terminal-game"),
    completionStatus: z.literal("complete"),
    opponentPolicies: z
      .object({
        p2: identifierSchema,
        p3: identifierSchema,
      })
      .strict(),
    bhabhi: z.enum(SEATS),
    userBhabhi: z.boolean(),
    userFinishingPosition: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    escapeOrder: z.array(z.enum(SEATS)).length(3),
    terminalReason: identifierSchema,
    terminalHandCounts: handCountsSchema,
    eventCount: positiveIntegerSchema,
    decisionCount: positiveIntegerSchema,
    solverDecisionCount: nonnegativeIntegerSchema,
    publicHistoryHash: stableHashSchema,
    terminalPublicStateHash: stableHashSchema,
    deterministicOutcomeHash: stableHashSchema,
    deterministicGameHash: sha256Schema,
    events: z.array(gameEventSchema).min(1),
    gameWallTimeMs: nonnegativeFiniteSchema,
  })
  .strict();
export type Phase8TerminalGameRecord = z.infer<
  typeof phase8TerminalGameRecordSchema
>;

const exactHandsSchema = z
  .object({
    user: z.array(cardSchema),
    p2: z.array(cardSchema),
    p3: z.array(cardSchema),
  })
  .strict();

export const phase8TerminalTruthRecordSchema = coordinateSchema
  .extend({
    recordType: z.literal("phase8-terminal-truth-eval-only"),
    initialHands: exactHandsSchema,
    finalHands: exactHandsSchema,
    terminalTruthHash: stableHashSchema,
    truthRecordSha256: sha256Schema,
  })
  .strict();
export type Phase8TerminalTruthRecord = z.infer<
  typeof phase8TerminalTruthRecordSchema
>;

const actionEstimateSchema = z
  .object({
    action: userActionSchema,
    actionKey: identifierSchema,
    userBhabhiRisk: probabilitySchema,
    interval: z
      .object({
        level: z.literal(0.95),
        method: identifierSchema,
        lower: probabilitySchema,
        upper: probabilitySchema,
      })
      .strict()
      .nullable(),
    approximateTie: z.boolean(),
    immediatePickupProbability: probabilitySchema.nullable(),
    expectedImmediatePickupCount: nonnegativeFiniteSchema.nullable(),
    immediatePowerProbability: probabilitySchema.nullable(),
  })
  .strict();

const exactAuditSchema = z
  .object({
    outcome: z.enum(["not-attempted", "used", "refused"]),
    algorithmId: identifierSchema.nullable(),
    configHash: stableHashSchema.nullable(),
    resultHash: stableHashSchema.nullable(),
    hypothesisSetHash: stableHashSchema.nullable(),
    refusalCode: identifierSchema.nullable(),
    refusalDetail: z.string().min(1).nullable(),
    diagnosticsHash: stableHashSchema.nullable(),
  })
  .strict();

const behaviorAuditSchema = z
  .object({
    outcome: z.enum(["not-attempted", "used", "refused"]),
    algorithmId: identifierSchema.nullable(),
    modelSha256: sha256Schema.nullable(),
    behaviorConfigHash: stableHashSchema.nullable(),
    behaviorResultHash: stableHashSchema.nullable(),
    weightedHypothesisHash: stableHashSchema.nullable(),
    refusalCode: identifierSchema.nullable(),
    refusalDetail: z.string().min(1).nullable(),
    p2PosteriorHash: stableHashSchema.nullable(),
    p3PosteriorHash: stableHashSchema.nullable(),
  })
  .strict();

export const phase8TerminalDecisionRecordSchema = terminalCommonSchema
  .extend({
    recordType: z.literal("phase8-terminal-decision"),
    decisionId: identifierSchema,
    decisionOrdinal: nonnegativeIntegerSchema,
    eventIndex: positiveIntegerSchema,
    stateVersion: positiveIntegerSchema,
    publicHistoryHash: stableHashSchema,
    publicStateHash: stableHashSchema,
    observationHash: stableHashSchema,
    legalActions: z.array(userActionSchema).min(1),
    legalActionKeys: z.array(identifierSchema).min(1),
    selectedAction: userActionSchema,
    selectedActionKey: identifierSchema,
    method: z.enum([
      "phase5-hard-only",
      "exact-hard",
      "behavior-weighted",
      "exact-behavior",
    ]),
    quality: z.enum(["Approximate", "Exact"]),
    budgetId: z.literal("balanced"),
    candidates: z.array(actionEstimateSchema).min(1),
    exact: exactAuditSchema,
    behavior: behaviorAuditSchema,
    fallback: z
      .object({
        used: z.boolean(),
        targetConfigId: z.enum(PHASE8_CONFIGURATION_ROLE_IDS).nullable(),
        reasonCode: identifierSchema.nullable(),
        byteIdenticalRequestHash: stableHashSchema.nullable(),
      })
      .strict(),
    work: z
      .object({
        hardWorldOccurrences: nonnegativeIntegerSchema.nullable(),
        weightedHypotheses: nonnegativeIntegerSchema.nullable(),
        terminalRollouts: nonnegativeIntegerSchema.nullable(),
        effectiveSampleSize: nonnegativeFiniteSchema.nullable(),
        exactInformationStates: nonnegativeIntegerSchema.nullable(),
        exactBranches: nonnegativeIntegerSchema.nullable(),
      })
      .strict(),
    cancellationStatus: z.literal("not-cancelled"),
    warnings: z.array(z.string()),
    analysisInputHash: stableHashSchema,
    analysisOutputHash: stableHashSchema,
    deterministicDecisionHash: sha256Schema,
  })
  .strict();
export type Phase8TerminalDecisionRecord = z.infer<
  typeof phase8TerminalDecisionRecordSchema
>;

export const phase8TerminalLatencyRecordSchema = coordinateSchema
  .extend({
    recordType: z.literal("phase8-terminal-latency"),
    decisionId: identifierSchema,
    decisionOrdinal: nonnegativeIntegerSchema,
    eventIndex: positiveIntegerSchema,
    method: z.enum([
      "phase5-hard-only",
      "exact-hard",
      "behavior-weighted",
      "exact-behavior",
    ]),
    totalMs: nonnegativeFiniteSchema,
    exactAttemptMs: nonnegativeFiniteSchema.nullable(),
    behaviorAttemptMs: nonnegativeFiniteSchema.nullable(),
    fallbackMs: nonnegativeFiniteSchema.nullable(),
    deadlineMs: nonnegativeFiniteSchema,
    deadlineExceeded: z.boolean(),
  })
  .strict();
export type Phase8TerminalLatencyRecord = z.infer<
  typeof phase8TerminalLatencyRecordSchema
>;

export const phase8TerminalFailureRecordSchema = terminalCommonSchema
  .extend({
    recordType: z.literal("phase8-terminal-failure"),
    completionStatus: z.enum([
      "failed",
      "turn-cap",
      "analysis-cap",
      "cancelled",
    ]),
    failureId: identifierSchema,
    kind: z.enum([
      "invariant",
      "illegal-policy-action",
      "exception",
      "turn-cap",
      "analysis-cap",
      "cancellation",
    ]),
    stage: z.enum([
      "configuration-routing",
      "search-analysis",
      "complete-game-simulation",
      "artifact-recording",
    ]),
    code: identifierSchema.nullable(),
    errorName: identifierSchema,
    message: z.string().min(1),
    lastGoodEventIndex: z.int().min(-1),
    retainedDecisionCount: nonnegativeIntegerSchema,
    failureHash: sha256Schema,
  })
  .strict();
export type Phase8TerminalFailureRecord = z.infer<
  typeof phase8TerminalFailureRecordSchema
>;

export const phase8TerminalComponentAuditSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_TERMINAL_SCHEMA_VERSION),
    recordType: z.literal("phase8-terminal-component-audit"),
    protocolId: z.literal("eval-v1"),
    runnerVersion: z.literal(PHASE8_TERMINAL_RUNNER_VERSION),
    runId: identifierSchema,
    authorityKind: z.enum(PHASE8_TERMINAL_AUTHORITY_KINDS),
    manifestId: identifierSchema,
    manifestSha256: sha256Schema,
    split: z.enum(["dev", "qualification", "final"]),
    configId: z.enum(PHASE8_CONFIGURATION_ROLE_IDS),
    configSha256: sha256Schema,
    components: phase8TerminalComponentsSchema,
    routingContract: z.enum([
      "direct-phase5-hard-only",
      "exact-hard-then-byte-identical-r",
      "behavior-weighted-refuse-on-failure",
      "behavior-exact-then-byte-identical-b",
    ]),
    fallbackConfigId: z.enum(PHASE8_CONFIGURATION_ROLE_IDS).nullable(),
    exactConfigHash: stableHashSchema.nullable(),
    phase5ReferenceConfigHash: stableHashSchema,
    continuationPolicyHash: stableHashSchema,
    productionModelSha256: sha256Schema.nullable(),
    modelSelectionContractHash: stableHashSchema.nullable(),
    separateOpponentPriors: z.boolean(),
    behaviorFailurePolicy: z.enum(["not-applicable", "refuse"]),
    preflightStatus: z.enum(["eligible", "ineligible"]),
    preflightReasons: z.array(z.string()),
    auditSha256: sha256Schema,
  })
  .strict();
export type Phase8TerminalComponentAudit = z.infer<
  typeof phase8TerminalComponentAuditSchema
>;

export const phase8TerminalSummaryInputSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_TERMINAL_SCHEMA_VERSION),
    recordType: z.literal("phase8-terminal-summary-input"),
    protocolId: z.literal("eval-v1"),
    runnerVersion: z.literal(PHASE8_TERMINAL_RUNNER_VERSION),
    runId: identifierSchema,
    split: z.enum(["dev", "qualification", "final"]),
    configId: z.enum(PHASE8_CONFIGURATION_ROLE_IDS),
    styleCellId: identifierSchema,
    baseIndex: nonnegativeIntegerSchema,
    rotation: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    replicate: z.literal(0),
    clusterId: identifierSchema,
    pairingKey: identifierSchema,
    gameId: stableHashSchema,
    status: z.enum(PHASE8_TERMINAL_OUTCOME_STATUSES),
    userBhabhi: z.union([z.literal(0), z.literal(1)]).nullable(),
    userFinishingPosition: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .nullable(),
    eventCount: nonnegativeIntegerSchema,
    decisionCount: nonnegativeIntegerSchema,
    solverDecisionCount: nonnegativeIntegerSchema,
    exactUses: nonnegativeIntegerSchema,
    exactRefusals: nonnegativeIntegerSchema,
    behaviorUses: nonnegativeIntegerSchema,
    behaviorRefusals: nonnegativeIntegerSchema,
    terminalOutcomeHash: stableHashSchema.nullable(),
    deterministicInputSha256: sha256Schema,
  })
  .strict();
export type Phase8TerminalSummaryInput = z.infer<
  typeof phase8TerminalSummaryInputSchema
>;

const matrixValidationSchema = z
  .object({
    expectedOutcomes: nonnegativeIntegerSchema,
    observedOutcomes: nonnegativeIntegerSchema,
    uniqueExpectedCoordinatesObserved: nonnegativeIntegerSchema,
    missingCount: nonnegativeIntegerSchema,
    unexpectedCount: nonnegativeIntegerSchema,
    duplicateCount: nonnegativeIntegerSchema,
    failedCount: nonnegativeIntegerSchema,
    turnCapCount: nonnegativeIntegerSchema,
    analysisCapCount: nonnegativeIntegerSchema,
    cancellationCount: nonnegativeIntegerSchema,
    missingCoordinates: z.array(z.string()),
    unexpectedCoordinates: z.array(z.string()),
    duplicateCoordinates: z.array(z.string()),
    diagnosticsTruncated: z.boolean(),
    completeMatrixGate: z.boolean(),
    zeroFailureGate: z.boolean(),
    zeroCapGate: z.boolean(),
    zeroCancellationGate: z.boolean(),
    evidenceGate: z.boolean(),
  })
  .strict();

const configAggregateSchema = z
  .object({
    configId: z.enum(PHASE8_CONFIGURATION_ROLE_IDS),
    completedGames: nonnegativeIntegerSchema,
    userBhabhiGames: nonnegativeIntegerSchema,
    userBhabhiRate: probabilitySchema.nullable(),
    finishingPositionCounts: z
      .object({
        first: nonnegativeIntegerSchema,
        second: nonnegativeIntegerSchema,
        third: nonnegativeIntegerSchema,
      })
      .strict(),
    exactUses: nonnegativeIntegerSchema,
    exactRefusals: nonnegativeIntegerSchema,
    behaviorUses: nonnegativeIntegerSchema,
    behaviorRefusals: nonnegativeIntegerSchema,
    decisionCount: nonnegativeIntegerSchema,
    latencyP50Ms: nonnegativeFiniteSchema.nullable(),
    latencyP95Ms: nonnegativeFiniteSchema.nullable(),
    latencyP99Ms: nonnegativeFiniteSchema.nullable(),
  })
  .strict();

const cellAggregateSchema = z
  .object({
    configId: z.enum(PHASE8_CONFIGURATION_ROLE_IDS),
    styleCellId: identifierSchema,
    completedGames: nonnegativeIntegerSchema,
    userBhabhiGames: nonnegativeIntegerSchema,
    userBhabhiRate: probabilitySchema.nullable(),
  })
  .strict();

export const phase8TerminalSummarySchema = z
  .object({
    schemaVersion: z.literal(PHASE8_TERMINAL_SCHEMA_VERSION),
    protocolId: z.literal("eval-v1"),
    runnerVersion: z.literal(PHASE8_TERMINAL_RUNNER_VERSION),
    evidenceClass: z.enum(PHASE8_TERMINAL_EVIDENCE_CLASSES),
    runId: identifierSchema,
    authorityKind: z.enum(PHASE8_TERMINAL_AUTHORITY_KINDS),
    manifestId: identifierSchema,
    manifestSha256: sha256Schema,
    split: z.enum(["dev", "qualification", "final"]),
    configurationIds: z.array(z.enum(PHASE8_CONFIGURATION_ROLE_IDS)).min(1),
    expectedScenarios: positiveIntegerSchema,
    expectedGames: positiveIntegerSchema,
    recordedSeedScenarios: nonnegativeIntegerSchema,
    matrix: matrixValidationSchema,
    configAggregates: z.array(configAggregateSchema).min(1),
    cellAggregates: z.array(cellAggregateSchema).min(1),
    componentRoutingGate: z.boolean(),
    seedCoverageGate: z.boolean(),
    decisionCoverageGate: z.boolean(),
    publicReplayGate: z.boolean(),
    truthReplayGate: z.boolean(),
    zeroSilentExclusionGate: z.boolean(),
    deterministicSummaryGate: z.boolean(),
    preflightEligibleForQualification: z.boolean(),
    pairedClusterStandardDeviations: z.array(
      z
        .object({
          candidateConfigId: z.enum(PHASE8_CONFIGURATION_ROLE_IDS),
          referenceConfigId: z.literal("p8-r-hard-balanced-v1"),
          standardDeviation: nonnegativeFiniteSchema.nullable(),
        })
        .strict(),
    ),
    maxPairedClusterStandardDeviation: nonnegativeFiniteSchema.nullable(),
    evidenceGate: z.boolean(),
    scientificDigest: sha256Schema,
  })
  .strict();
export type Phase8TerminalSummary = z.infer<typeof phase8TerminalSummarySchema>;

const rawStreamHashesSchema = z
  .object({
    seedsSha256: sha256Schema,
    gamesSha256: sha256Schema,
    decisionsSha256: sha256Schema,
    truthsSha256: sha256Schema,
    latenciesSha256: sha256Schema,
    failuresSha256: sha256Schema,
    componentsSha256: sha256Schema,
    summaryInputsSha256: sha256Schema,
  })
  .strict();

export const phase8TerminalRunManifestSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_TERMINAL_SCHEMA_VERSION),
    protocolId: z.literal("eval-v1"),
    runnerVersion: z.literal(PHASE8_TERMINAL_RUNNER_VERSION),
    evidenceClass: z.enum(PHASE8_TERMINAL_EVIDENCE_CLASSES),
    runId: identifierSchema,
    authorityKind: z.enum(PHASE8_TERMINAL_AUTHORITY_KINDS),
    authorityManifestVersion: identifierSchema,
    authorityManifestId: identifierSchema,
    authorityManifestSha256: sha256Schema,
    splitOpeningSha256: sha256Schema,
    split: z.enum(["dev", "qualification", "final"]),
    evidenceEligible: z.boolean(),
    createdAt: z.iso.datetime(),
    configurationIds: z.array(z.enum(PHASE8_CONFIGURATION_ROLE_IDS)).min(1),
    configurations: z.array(phase8ConfigurationDescriptorSchema).min(1).max(4),
    styleCellIds: z.array(identifierSchema).length(17),
    baseIndexStart: z.literal(0),
    baseCount: z.int().positive().max(512),
    rotations: z.tuple([z.literal(0), z.literal(1), z.literal(2)]),
    replicate: z.literal(0),
    eventCap: positiveIntegerSchema,
    expectedScenarios: positiveIntegerSchema,
    expectedGames: positiveIntegerSchema,
    rules: ruleConfigSchema,
    seedPolicyId: identifierSchema,
    planScientificSha256: sha256Schema,
    productionModelSha256: sha256Schema,
    sourceSha256: sha256Schema,
    rulesSha256: sha256Schema,
    configRegistrySha256: sha256Schema,
    scorerSha256: sha256Schema,
    reportSha256: sha256Schema,
    preregistrationSha256: sha256Schema,
    rawStreamsSha256: rawStreamHashesSchema,
    nondeterministicFields: z.tuple([
      z.literal("manifest.createdAt"),
      z.literal("environment"),
      z.literal("games[*].gameWallTimeMs"),
      z.literal("latencies"),
    ]),
    recordOrder: z.literal("baseIndex-styleCell-rotation-config-userDecision"),
    command: z.string().min(1),
  })
  .strict();
export type Phase8TerminalRunManifest = z.infer<
  typeof phase8TerminalRunManifestSchema
>;
