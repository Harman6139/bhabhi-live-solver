import { z } from "zod";

import { isCard, type Card } from "../domain/cards";
import { ruleConfigSchema } from "../domain/rule-config";
import { SEATS } from "../domain/seats";
import { gameEventSchema } from "../events/game-events";
import { EVALUATION_SPLITS } from "./protocol";

const cardSchema = z.custom<Card>(isCard, {
  message: "Expected a canonical card code.",
});
const rotationSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const nonnegativeInteger = z.int().nonnegative();
const hashSchema = z.string().min(1);

export const artifactEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("eval-v1"),
    runId: z.string().min(1),
    split: z.enum(EVALUATION_SPLITS),
    evidenceClass: z.string().min(1),
    configId: z.string().min(1),
    ruleProfileId: z.string().min(1),
    styleCellId: z.string().min(1),
    baseIndex: nonnegativeInteger,
    rotation: rotationSchema,
    replicate: nonnegativeInteger,
    clusterId: z.string().min(1),
    scenarioId: z.string().min(1),
    gameId: z.string().min(1),
  })
  .strict();

export const seedArtifactRecordSchema = artifactEnvelopeSchema.extend({
  recordType: z.literal("seed"),
  seeds: z.object({
    deal: z.string().length(32),
    userPolicy: z.string().length(32),
    p2Policy: z.string().length(32),
    p3Policy: z.string().length(32),
    chance: z.string().length(32),
    belief: z.string().length(32),
    search: z.string().length(32),
    bootstrap: z.string().length(32),
  }),
  rngAlgorithm: z.literal("splitmix64-counter-v1"),
});
export type SeedArtifactRecord = z.infer<typeof seedArtifactRecordSchema>;

export const gameArtifactRecordSchema = artifactEnvelopeSchema.extend({
  recordType: z.literal("game"),
  completionStatus: z.literal("complete"),
  userPolicyId: z.string().min(1),
  p2PolicyId: z.string().min(1),
  p3PolicyId: z.string().min(1),
  rules: ruleConfigSchema,
  events: z.array(gameEventSchema).min(1),
  bhabhi: z.enum(SEATS),
  escapeOrder: z.array(z.enum(SEATS)),
  escapeGroups: z.array(
    z.object({
      seats: z.array(z.enum(SEATS)),
      eventIndex: nonnegativeInteger,
      reason: z.enum([
        "empty-hand",
        "immediate-zero-power",
        "take-hand",
        "shootout-safe",
      ]),
    }),
  ),
  terminalReason: z.string().min(1),
  terminalHandCounts: z.object({
    user: nonnegativeInteger,
    p2: nonnegativeInteger,
    p3: nonnegativeInteger,
  }),
  aceSpadesHolder: z.enum(SEATS),
  eighteenCardHolder: z.enum(SEATS),
  eventCount: z.int().positive(),
  decisionCount: nonnegativeInteger,
  pickupCount: nonnegativeInteger,
  chanceCount: nonnegativeInteger,
  invariantCheckCount: z.int().positive(),
  publicHistoryHash: hashSchema,
  terminalPublicStateHash: hashSchema,
  deterministicOutcomeHash: hashSchema,
  deterministicGameDigest: hashSchema,
  wallTimeMs: z.number().nonnegative(),
});
export type GameArtifactRecord = z.infer<typeof gameArtifactRecordSchema>;

export const decisionArtifactRecordSchema = artifactEnvelopeSchema.extend({
  recordType: z.literal("decision"),
  decisionId: z.string().min(1),
  eventIndex: nonnegativeInteger,
  stateVersion: nonnegativeInteger,
  actorDecisionOrdinal: nonnegativeInteger,
  actor: z.enum(SEATS),
  policyId: z.string().min(1),
  policyVersion: z.literal(1),
  publicHistoryHash: hashSchema,
  publicStateHash: hashSchema,
  observationHash: hashSchema,
  actionKind: z.enum(["play-card", "take-hand"]),
  selectedCard: cardSchema.nullable(),
  selectedTakeTarget: z.enum(SEATS).nullable(),
  userLegalCards: z.array(cardSchema).nullable(),
  rationale: z.string().min(1),
  rngInvocationId: z.string().min(1),
  method: z.literal("baseline-policy"),
  completionStatus: z.literal("complete"),
});
export type DecisionArtifactRecord = z.infer<
  typeof decisionArtifactRecordSchema
>;

const handsSchema = z.object({
  user: z.array(cardSchema),
  p2: z.array(cardSchema),
  p3: z.array(cardSchema),
});

export const truthArtifactRecordSchema = artifactEnvelopeSchema.extend({
  recordType: z.literal("truth-eval-only"),
  initialHands: handsSchema,
  finalHands: handsSchema,
  truthHash: hashSchema,
  opponentDecisionAudit: z.array(
    z.object({
      eventIndex: nonnegativeInteger,
      actor: z.enum(["p2", "p3"]),
      actionKind: z.enum(["play-card", "take-hand"]),
      legalCards: z.array(cardSchema),
      chosenCard: cardSchema.nullable(),
      chosenTakeTarget: z.enum(SEATS).nullable(),
    }),
  ),
  chanceAudit: z.array(
    z.object({
      eventIndex: nonnegativeInteger,
      kind: z.enum(["waste-draw", "player-draw"]),
      eligibleCards: z.array(cardSchema),
      chosenCard: cardSchema,
    }),
  ),
});
export type TruthArtifactRecord = z.infer<typeof truthArtifactRecordSchema>;

export const failureArtifactRecordSchema = artifactEnvelopeSchema.extend({
  recordType: z.literal("failure"),
  completionStatus: z.enum(["failed", "turn-cap"]),
  failureId: z.string().min(1),
  kind: z.enum([
    "invariant",
    "illegal-policy-action",
    "exception",
    "turn-cap",
    "artifact-validation",
  ]),
  stage: z.string().min(1),
  error: z.object({
    name: z.string().min(1),
    code: z.string().nullable(),
    message: z.string().min(1),
  }),
  lastGoodEventIndex: z.int(),
  replayCommand: z.string().min(1),
  deterministicFailureHash: hashSchema,
});
export type FailureArtifactRecord = z.infer<typeof failureArtifactRecordSchema>;

const aggregateLineSchema = z.object({
  key: z.string().min(1),
  games: nonnegativeInteger,
  userBhabhiCount: nonnegativeInteger,
  userBhabhiRate: z.number().min(0).max(1),
});

export const evaluationSummarySchema = z.object({
  schemaVersion: z.literal(1),
  protocolId: z.literal("eval-v1"),
  runId: z.string().min(1),
  split: z.enum(EVALUATION_SPLITS),
  evidenceClass: z.string().min(1),
  evidenceEligible: z.boolean(),
  expectedGames: nonnegativeInteger,
  attemptedGames: nonnegativeInteger,
  completedGames: nonnegativeInteger,
  failedGames: nonnegativeInteger,
  turnCapGames: nonnegativeInteger,
  invariantFailures: nonnegativeInteger,
  zeroFailureGate: z.boolean(),
  byUserPolicy: z.array(aggregateLineSchema),
  byStyleCell: z.array(aggregateLineSchema),
  byRotation: z.array(aggregateLineSchema),
  reproductionDigest: hashSchema,
});
export type EvaluationSummary = z.infer<typeof evaluationSummarySchema>;

export const evaluationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactSchemaVersion: z.literal(1),
    runnerVersion: z.literal("phase4-runner-v1"),
    protocolId: z.literal("eval-v1"),
    runId: z.string().min(1),
    split: z.enum(EVALUATION_SPLITS),
    evidenceClass: z.string().min(1),
    evidenceEligible: z.boolean(),
    createdAt: z.iso.datetime(),
    protocolPlanSha256: z.string().length(64),
    sourceSnapshotSha256: z.string().length(64),
    sourceFileCount: z.int().positive(),
    gitCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
    gitStatusSha256: z.string().length(64),
    gitDirty: z.boolean(),
    ruleProfileId: z.string().min(1),
    rules: ruleConfigSchema,
    rulesHash: hashSchema,
    scheduleHash: hashSchema,
    policyBundleHash: hashSchema,
    expectedGames: nonnegativeInteger,
    eventCap: z.int().positive(),
    userPolicyIds: z.array(z.string().min(1)),
    styleCellIds: z.array(z.string().min(1)),
    baseIndexStart: nonnegativeInteger,
    baseCount: z.int().positive(),
    rotations: z.array(rotationSchema),
    replicates: z.array(nonnegativeInteger),
    rngAlgorithm: z.literal("splitmix64-counter-v1"),
    shuffleAlgorithm: z.literal("fisher-yates-v1"),
    recordOrder: z.literal("config-cell-baseIndex-rotation-replicate-decision"),
    failureRetention: z.literal("retain-and-fail-gate"),
    nondeterministicFields: z.array(z.string()),
    seedManifestSha256: z.string().length(64),
    command: z.string().min(1),
  })
  .strict();
export type EvaluationManifest = z.infer<typeof evaluationManifestSchema>;

export const environmentArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    capturedAt: z.iso.datetime(),
    platform: z.string().min(1),
    release: z.string().min(1),
    architecture: z.string().min(1),
    cpuModel: z.string().min(1),
    logicalCpus: z.int().positive(),
    totalMemoryBytes: z.int().positive(),
    freeMemoryBytes: nonnegativeInteger,
    nodeVersion: z.string().min(1),
    timezone: z.string().min(1),
    powerMode: z.string().min(1),
    workerCount: z.int().positive(),
  })
  .strict();
export type EnvironmentArtifact = z.infer<typeof environmentArtifactSchema>;
