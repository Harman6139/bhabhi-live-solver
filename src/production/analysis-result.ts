import { z } from "zod";

import { isCard, type Card } from "../domain/cards";
import { ruleConfigSchema } from "../domain/rule-config";
import { stableHash } from "../events/stable-hash";
import { SOLVER_BUDGET_IDS } from "../search/types";
import {
  productionRoleIdSchema,
  productionRoutingContractSchema,
} from "./roles";

export const PRODUCTION_ANALYSIS_VERSION = "production-analysis-v1" as const;

const identifierSchema = z.string().trim().min(1).max(512);
const stableHashSchema = z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const probabilitySchema = z.number().min(0).max(1);
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const cardSchema = z.custom<Card>(isCard, { error: "Invalid card." });
const seatSchema = z.enum(["user", "p2", "p3"]);
const opponentSeatSchema = z.enum(["p2", "p3"]);

export const productionUserActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("play-card"),
      card: cardSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("take-hand"),
      target: opponentSeatSchema,
    })
    .strict(),
]);

export const productionRootResolutionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("take-hand"),
      actor: z.literal("user"),
      target: opponentSeatSchema,
      cardCount: nonnegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("trick-picked-up"),
      picker: seatSchema,
      thullaBy: seatSchema,
      cardCount: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("trick-wasted"),
      power: seatSchema,
      cardCount: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("game-completed"),
      bhabhi: seatSchema,
      reason: z.enum([
        "last-active",
        "pagat-higher-response",
        "pagat-lower-last-response",
        "pagat-off-suit-response",
        "simplified-thulla",
      ]),
    })
    .strict(),
]);

const availableNumberSchema = z
  .object({
    status: z.literal("available"),
    value: z.number(),
  })
  .strict();
const unavailableNumberSchema = z
  .object({
    status: z.literal("unavailable"),
    reason: identifierSchema,
  })
  .strict();
export const diagnosticNumberSchema = z.discriminatedUnion("status", [
  availableNumberSchema,
  unavailableNumberSchema,
]);

const rootResolutionDistributionSchema = z
  .array(
    z
      .object({
        resolution: productionRootResolutionSchema,
        probability: probabilitySchema,
      })
      .strict(),
  )
  .min(1);

const availableRootResolutionsSchema = z
  .object({
    status: z.literal("available"),
    values: rootResolutionDistributionSchema,
  })
  .strict();
const unavailableRootResolutionsSchema = z
  .object({
    status: z.literal("unavailable"),
    reason: identifierSchema,
  })
  .strict();
export const rootResolutionDiagnosticSchema = z.discriminatedUnion("status", [
  availableRootResolutionsSchema,
  unavailableRootResolutionsSchema,
]);

const userFinishProbabilityValuesSchema = z
  .object({
    first: probabilitySchema,
    second: probabilitySchema,
    bhabhi: probabilitySchema,
    tiedSafe: probabilitySchema,
  })
  .strict();
const firstOpponentEscapeValuesSchema = z
  .object({
    p2: probabilitySchema,
    p3: probabilitySchema,
    tie: probabilitySchema,
    none: probabilitySchema,
  })
  .strict();
const availableUserFinishSchema = z
  .object({
    status: z.literal("available"),
    values: userFinishProbabilityValuesSchema,
  })
  .strict();
const availableFirstEscapeSchema = z
  .object({
    status: z.literal("available"),
    values: firstOpponentEscapeValuesSchema,
  })
  .strict();
const unavailableDistributionSchema = z
  .object({
    status: z.literal("unavailable"),
    reason: identifierSchema,
  })
  .strict();
export const userFinishDiagnosticSchema = z.discriminatedUnion("status", [
  availableUserFinishSchema,
  unavailableDistributionSchema,
]);
export const firstOpponentEscapeDiagnosticSchema = z.discriminatedUnion(
  "status",
  [availableFirstEscapeSchema, unavailableDistributionSchema],
);

const intervalSchema = z
  .object({
    level: z.literal(0.95),
    method: identifierSchema,
    lower: z.number().min(-1).max(1),
    upper: z.number().min(-1).max(1),
  })
  .strict()
  .refine((value) => value.lower <= value.upper, {
    error: "Interval lower bound exceeds upper bound.",
  });

export const productionCandidateSchema = z
  .object({
    action: productionUserActionSchema,
    actionKey: identifierSchema,
    userBhabhiRisk: probabilitySchema,
    safeProbability: probabilitySchema,
    interval: intervalSchema.nullable(),
    approximateTie: z.boolean(),
    immediatePickupProbability: probabilitySchema.nullable(),
    expectedImmediatePickupCount: z.number().nonnegative().nullable(),
    immediatePowerProbability: probabilitySchema.nullable(),
    userFinishProbabilities: userFinishDiagnosticSchema,
    firstOpponentEscape: firstOpponentEscapeDiagnosticSchema,
    rootResolutions: rootResolutionDiagnosticSchema,
  })
  .strict();

const opponentPosteriorEntrySchema = z
  .object({
    modelId: identifierSchema,
    probability: probabilitySchema,
  })
  .strict();

const behaviorTraceSchema = z
  .object({
    eventIndex: nonnegativeIntegerSchema,
    seat: opponentSeatSchema,
    decisionOrdinal: nonnegativeIntegerSchema,
    observedActionKey: identifierSchema,
    forced: z.boolean(),
    observedPredictiveProbability: probabilitySchema,
    logLikelihoodContribution: z.number(),
    effectiveSampleSizeBefore: z.number().positive(),
    effectiveSampleSizeAfter: z.number().positive(),
    entropyBefore: z.number().nonnegative(),
    entropyAfter: z.number().nonnegative(),
  })
  .strict();

const availableBehaviorTraceSchema = z
  .object({
    status: z.literal("available"),
    values: z.array(behaviorTraceSchema),
  })
  .strict();
const unavailableBehaviorTraceSchema = z
  .object({
    status: z.literal("unavailable"),
    reason: identifierSchema,
  })
  .strict();
const behaviorTraceDiagnosticSchema = z.discriminatedUnion("status", [
  availableBehaviorTraceSchema,
  unavailableBehaviorTraceSchema,
]);

const hardConstraintSchema = z
  .object({
    evidenceHash: stableHashSchema,
    rules: ruleConfigSchema,
    knownOpponentCards: z
      .object({
        p2: z.array(cardSchema),
        p3: z.array(cardSchema),
      })
      .strict(),
    voidObservations: z.array(
      z
        .object({
          eventIndex: nonnegativeIntegerSchema,
          seat: seatSchema,
          suit: z.enum(["clubs", "diamonds", "hearts", "spades"]),
          observedCard: cardSchema,
          kind: z.enum(["opening-off-suit", "normal-thulla"]),
        })
        .strict(),
    ),
    support: z
      .object({
        forcedP2: nonnegativeIntegerSchema,
        forcedP3: nonnegativeIntegerSchema,
        flexible: nonnegativeIntegerSchema,
        totalWorldCount: z.string().regex(/^(0|[1-9][0-9]*)$/u),
      })
      .strict(),
  })
  .strict();

const behaviorDiagnosticsSchema = z
  .object({
    enabled: z.boolean(),
    configHash: stableHashSchema.nullable(),
    resultHash: stableHashSchema.nullable(),
    p2Posterior: z.array(opponentPosteriorEntrySchema),
    p3Posterior: z.array(opponentPosteriorEntrySchema),
    likelihoodContributionDefinition: z.literal(
      "natural-log-observed-predictive-probability",
    ),
    likelihoodContributions: behaviorTraceDiagnosticSchema,
  })
  .strict();

const availableSensitivitySchema = z
  .object({
    status: z.literal("available"),
    fragile: z.boolean(),
    reason: identifierSchema,
    maximumSwitchRegret: z.number().min(0).max(1),
  })
  .strict();
const unavailableSensitivitySchema = z
  .object({
    status: z.literal("unavailable"),
    fragile: z.null(),
    reason: identifierSchema,
    maximumSwitchRegret: z.null(),
  })
  .strict();
export const sensitivityDiagnosticSchema = z.discriminatedUnion("status", [
  availableSensitivitySchema,
  unavailableSensitivitySchema,
]);

const exactDiagnosticsSchema = z
  .object({
    outcome: z.enum(["not-attempted", "used", "refused"]),
    configHash: stableHashSchema.nullable(),
    resultHash: stableHashSchema.nullable(),
    refusalCode: identifierSchema.nullable(),
    refusalDetail: identifierSchema.nullable(),
    informationStates: nonnegativeIntegerSchema.nullable(),
    branches: nonnegativeIntegerSchema.nullable(),
  })
  .strict();

const fallbackDiagnosticsSchema = z
  .object({
    used: z.boolean(),
    targetConfigId: productionRoleIdSchema.nullable(),
    reasonCode: identifierSchema.nullable(),
    requestHash: stableHashSchema.nullable(),
  })
  .strict();

const unavailableCausalSchema = z
  .object({
    status: z.literal("unavailable"),
    comparatorActionKey: identifierSchema.nullable(),
    terminalRiskDifference: z.number().min(-1).max(1).nullable(),
    primaryMechanism: z.null(),
    reason: identifierSchema,
  })
  .strict();
const availableCausalSchema = z
  .object({
    status: z.literal("available"),
    comparatorActionKey: identifierSchema,
    terminalRiskDifference: z.number().min(-1).max(1),
    primaryMechanism: z
      .object({
        resolution: productionRootResolutionSchema,
        recommendedProbability: probabilitySchema,
        comparatorProbability: probabilitySchema,
        probabilityDifference: z.number().min(-1).max(1),
      })
      .strict(),
    reason: z.null(),
  })
  .strict();
export const causalExplanationSchema = z.discriminatedUnion("status", [
  availableCausalSchema,
  unavailableCausalSchema,
]);

export const productionAnalysisSchema = z
  .object({
    schemaVersion: z.literal(1),
    analysisVersion: z.literal(PRODUCTION_ANALYSIS_VERSION),
    identity: z
      .object({
        stateVersion: nonnegativeIntegerSchema,
        historyHash: stableHashSchema,
        publicStateHash: stableHashSchema,
        underlyingAnalysisId: stableHashSchema,
      })
      .strict(),
    release: z
      .object({
        bundleMode: z.enum(["evaluation-only", "release-selected"]),
        manifestScope: z.enum(["qualification", "final"]),
        manifestHash: sha256Schema,
        selectedConfigId: productionRoleIdSchema,
        routingContract: productionRoutingContractSchema,
        sourceHash: sha256Schema,
        solverConfigHash: sha256Schema,
        modelHash: sha256Schema,
        protocolHash: sha256Schema,
        selectionAttestationHash: sha256Schema.nullable(),
        finalAttestationHash: sha256Schema.nullable(),
      })
      .strict()
      .superRefine((value, context) => {
        const releaseSelected = value.bundleMode === "release-selected";
        if (
          (releaseSelected &&
            (value.manifestScope !== "final" ||
              value.selectionAttestationHash === null ||
              value.finalAttestationHash === null)) ||
          (!releaseSelected &&
            (value.selectionAttestationHash !== null ||
              value.finalAttestationHash !== null))
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Only release-selected results may bind selection/final attestation hashes.",
          });
        }
      }),
    route: z
      .object({
        selectedMethod: z.enum([
          "hard-only-approximate",
          "exact-hard",
          "behavior-weighted-approximate",
          "exact-behavior",
        ]),
        quality: z.enum(["Approximate", "Exact"]),
        fallback: fallbackDiagnosticsSchema,
      })
      .strict(),
    budgetId: z.enum(SOLVER_BUDGET_IDS),
    legalActions: z.array(productionUserActionSchema).min(1),
    recommendedAction: productionUserActionSchema,
    recommendedActionKey: identifierSchema,
    approximateTieActionKeys: z.array(identifierSchema),
    candidates: z.array(productionCandidateSchema).min(1),
    explanation: causalExplanationSchema,
    diagnostics: z
      .object({
        hardConstraints: hardConstraintSchema,
        belief: z
          .object({
            method: z.enum([
              "hard-exact-enumeration",
              "hard-direct-uniform-sample",
              "behavior-weighted",
            ]),
            worldOccurrences: z.number().int().positive(),
            distinctWitnesses: z.number().int().positive(),
            effectiveSampleSize: diagnosticNumberSchema,
            entropy: diagnosticNumberSchema,
          })
          .strict(),
        behavior: behaviorDiagnosticsSchema,
        sensitivity: sensitivityDiagnosticSchema,
        exact: exactDiagnosticsSchema,
        work: z
          .object({
            terminalRollouts: nonnegativeIntegerSchema.nullable(),
            weightedHypotheses: nonnegativeIntegerSchema.nullable(),
          })
          .strict(),
      })
      .strict(),
    reproducibility: z
      .object({
        beliefSeedId: identifierSchema,
        searchSeedId: identifierSchema,
        rolloutSeedId: identifierSchema,
        chanceSeedId: identifierSchema,
        bootstrapSeedId: identifierSchema,
      })
      .strict(),
    telemetry: z
      .object({
        elapsedMs: z.number().nonnegative(),
        deadlineMs: z.number().int().positive(),
        deadlineExceeded: z.boolean(),
      })
      .strict(),
    warnings: z.array(z.string().min(1).max(2_048)),
    analysisHash: stableHashSchema,
  })
  .strict();

export type ProductionAnalysis = z.infer<typeof productionAnalysisSchema>;
export type ProductionCandidate = z.infer<typeof productionCandidateSchema>;
export type ProductionCausalExplanation = z.infer<
  typeof causalExplanationSchema
>;

export function productionAnalysisHash(value: object): string {
  const projection = { ...value } as Record<string, unknown>;
  delete projection.analysisHash;
  delete projection.telemetry;
  return stableHash(projection);
}

export function parseProductionAnalysis(value: unknown): ProductionAnalysis {
  const parsed = productionAnalysisSchema.parse(value);
  if (parsed.analysisHash !== productionAnalysisHash(parsed)) {
    throw new TypeError("Production analysis checksum is invalid.");
  }
  const legal = new Set(
    parsed.legalActions.map((action) =>
      action.kind === "play-card"
        ? `play:${action.card}`
        : `take:${action.target}`,
    ),
  );
  if (
    !legal.has(parsed.recommendedActionKey) ||
    !parsed.candidates.some(
      (candidate) => candidate.actionKey === parsed.recommendedActionKey,
    )
  ) {
    throw new TypeError(
      "Production analysis recommendation is not represented by its legal candidates.",
    );
  }
  return parsed;
}
