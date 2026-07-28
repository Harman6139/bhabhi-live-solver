import { z } from "zod";

import { phase8Sha256 } from "../evaluation/phase8-manifest";
import { createSeededRng } from "../random/keyed-rng";
import {
  deterministicTop1,
  logarithmicLoss,
  multiclassBrier,
  RELIABILITY_BIN_EDGES,
  scoreCredibleSets,
} from "./metrics";
import {
  PHASE8_CALIBRATION_ALL_FAMILIES,
  PHASE8_CALIBRATION_MINIMUM_STYLE_BASE_CLUSTERS,
  PHASE8_CALIBRATION_PREDICTION_FAMILIES,
  PHASE8_CALIBRATION_PRIMARY_FAMILIES,
  PHASE8_CALIBRATION_STRESS_CELL_IDS,
  verifyPhase8CalibrationPlan,
  type Phase8CalibrationFamily,
  type Phase8CalibrationPlan,
  type Phase8CalibrationPrimaryFamily,
} from "./phase8-plan";
import {
  validatePhase8CalibrationPredictionRecord,
  validatePhase8CalibrationTerminalRiskPredictionRecord,
  validatePhase8PairedPredictionRecord,
  validatePhase8ReferenceOneArmPredictionRecord,
  validatePhase8ReferenceOneArmTerminalRiskPredictionRecord,
  validatePhase8TerminalRiskPredictionRecord,
  type Phase8CalibrationPredictionRecord,
  type Phase8CalibrationTerminalRiskPredictionRecord,
  type Phase8PairedPredictionRecord,
  type Phase8ReferenceOneArmPredictionRecord,
  type Phase8ReferenceOneArmTerminalRiskPredictionRecord,
  type Phase8TerminalRiskPredictionRecord,
} from "./phase8-records";
import type { ProbabilityEntry } from "./types";

export const PHASE8_CALIBRATION_SCORER_VERSION =
  "phase8-clean-calibration-scorer-v1" as const;
export const PHASE8_CALIBRATION_BOOTSTRAP_METHOD =
  "paired-style-base-cluster-max-statistic-v1" as const;
export const PHASE8_CALIBRATION_BOOTSTRAP_RESAMPLES = 20_000 as const;

const identifierSchema = z.string().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const probabilitySchema = z.number().min(0).max(1);
const reliabilityContributionSchema = z
  .object({
    probability: probabilitySchema,
    outcome: z.boolean(),
  })
  .strict();
const armScoreSchema = z
  .object({
    brier: z.number().nonnegative(),
    logLoss: z.number().nonnegative(),
    truthProbability: probabilitySchema,
    rawZeroTruthSupport: z.boolean(),
    selectedTop1Correct: z.boolean().nullable(),
    tieAwareTopSetCorrect: z.boolean().nullable(),
    tieAwareTop1Credit: probabilitySchema.nullable(),
    coverage50: z.boolean().nullable(),
    coverage80: z.boolean().nullable(),
    coverage95: z.boolean().nullable(),
    reliability: z.array(reliabilityContributionSchema).min(1),
  })
  .strict();

export type Phase8CalibrationArmScore = z.infer<typeof armScoreSchema>;

export const phase8PairedScoreRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    scorerVersion: z.literal(PHASE8_CALIBRATION_SCORER_VERSION),
    recordType: z.literal("phase8-paired-calibration-score"),
    planSha256: sha256Schema,
    predictionRecordId: identifierSchema,
    scoreId: identifierSchema,
    styleCellId: identifierSchema,
    styleBaseClusterId: identifierSchema,
    gameId: identifierSchema,
    stateId: identifierSchema,
    queryId: identifierSchema,
    family: z.enum(PHASE8_CALIBRATION_PREDICTION_FAMILIES),
    hardKnown: z.boolean(),
    forcedAction: z.boolean().nullable(),
    opponentSeat: z.enum(["p2", "p3"]).nullable(),
    truthLabel: identifierSchema,
    truthSha256: sha256Schema,
    hard: armScoreSchema,
    behavior: armScoreSchema,
    scoreSha256: sha256Schema,
  })
  .strict()
  .superRefine((score, context) => {
    const action = score.family === "opponent-action";
    if (
      action !== (score.forcedAction !== null && score.opponentSeat !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["forcedAction"],
        message:
          "Only opponent-action scores require forcedAction and opponentSeat.",
      });
    }
  });

export type Phase8PairedScoreRecord = z.infer<
  typeof phase8PairedScoreRecordSchema
>;

export const phase8ReferenceOneArmScoreRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    scorerVersion: z.literal(PHASE8_CALIBRATION_SCORER_VERSION),
    recordType: z.literal("phase8-reference-one-arm-calibration-score"),
    planSha256: sha256Schema,
    predictionRecordId: identifierSchema,
    scoreId: identifierSchema,
    styleCellId: identifierSchema,
    styleBaseClusterId: identifierSchema,
    gameId: identifierSchema,
    stateId: identifierSchema,
    queryId: identifierSchema,
    family: z.enum(PHASE8_CALIBRATION_PREDICTION_FAMILIES),
    hardKnown: z.boolean(),
    forcedAction: z.boolean().nullable(),
    opponentSeat: z.enum(["p2", "p3"]).nullable(),
    truthLabel: identifierSchema,
    truthSha256: sha256Schema,
    hard: armScoreSchema,
    scoreSha256: sha256Schema,
  })
  .strict()
  .superRefine((score, context) => {
    const action = score.family === "opponent-action";
    if (
      action !== (score.forcedAction !== null && score.opponentSeat !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["forcedAction"],
        message:
          "Only opponent-action scores require forcedAction and opponentSeat.",
      });
    }
  });

export type Phase8ReferenceOneArmScoreRecord = z.infer<
  typeof phase8ReferenceOneArmScoreRecordSchema
>;

export type Phase8CalibrationScoreRecord =
  Phase8PairedScoreRecord | Phase8ReferenceOneArmScoreRecord;

export type Phase8CalibrationTruthInput =
  | Readonly<{
      scoreStatus: "scored";
      truthLabel: string;
      forcedAction: boolean | null;
    }>
  | Readonly<{
      scoreStatus: "conditioning-false";
      truthLabel: null;
      forcedAction: null;
    }>;

export const phase8CalibrationScoreSkipRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    scorerVersion: z.literal(PHASE8_CALIBRATION_SCORER_VERSION),
    recordType: z.literal("phase8-calibration-score-skip"),
    planSha256: sha256Schema,
    predictionRecordId: identifierSchema,
    skipId: identifierSchema,
    styleCellId: identifierSchema,
    styleBaseClusterId: identifierSchema,
    gameId: identifierSchema,
    stateId: identifierSchema,
    queryId: identifierSchema,
    family: z.literal("conditional"),
    reason: z.literal("conditioning-false"),
    truthSha256: sha256Schema,
    skipSha256: sha256Schema,
  })
  .strict();

export type Phase8CalibrationScoreSkipRecord = z.infer<
  typeof phase8CalibrationScoreSkipRecordSchema
>;

export const phase8TerminalRiskScoreRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    scorerVersion: z.literal(PHASE8_CALIBRATION_SCORER_VERSION),
    recordType: z.literal("phase8-terminal-risk-score"),
    planSha256: sha256Schema,
    predictionRecordId: identifierSchema,
    scoreId: identifierSchema,
    styleCellId: identifierSchema,
    styleBaseClusterId: identifierSchema,
    gameId: identifierSchema,
    stateId: identifierSchema,
    queryId: identifierSchema,
    actionKey: identifierSchema,
    userWasBhabhi: z.boolean(),
    truthSha256: sha256Schema,
    hard: armScoreSchema,
    behavior: armScoreSchema,
    scoreSha256: sha256Schema,
  })
  .strict();

export type Phase8TerminalRiskScoreRecord = z.infer<
  typeof phase8TerminalRiskScoreRecordSchema
>;

export const phase8ReferenceOneArmTerminalRiskScoreRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    scorerVersion: z.literal(PHASE8_CALIBRATION_SCORER_VERSION),
    recordType: z.literal("phase8-reference-one-arm-terminal-risk-score"),
    planSha256: sha256Schema,
    predictionRecordId: identifierSchema,
    scoreId: identifierSchema,
    styleCellId: identifierSchema,
    styleBaseClusterId: identifierSchema,
    gameId: identifierSchema,
    stateId: identifierSchema,
    queryId: identifierSchema,
    actionKey: identifierSchema,
    userWasBhabhi: z.boolean(),
    truthSha256: sha256Schema,
    hard: armScoreSchema,
    scoreSha256: sha256Schema,
  })
  .strict();

export type Phase8ReferenceOneArmTerminalRiskScoreRecord = z.infer<
  typeof phase8ReferenceOneArmTerminalRiskScoreRecordSchema
>;

export type Phase8CalibrationTerminalRiskScoreRecord =
  Phase8TerminalRiskScoreRecord | Phase8ReferenceOneArmTerminalRiskScoreRecord;

function fail(message: string): never {
  throw new Error(`Phase 8 calibration scoring rejected: ${message}`);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function probabilityForLabel(
  distribution: readonly ProbabilityEntry[],
  truthLabel: string,
): number {
  const entry = distribution.find(
    (candidate) => candidate.label === truthLabel,
  );
  if (entry === undefined) {
    fail(`truth label "${truthLabel}" is absent from the distribution.`);
  }
  return entry.probability;
}

function armScore(
  distribution: readonly ProbabilityEntry[],
  truthLabel: string,
  action: boolean,
): Phase8CalibrationArmScore {
  const truthProbability = probabilityForLabel(distribution, truthLabel);
  const logLoss = logarithmicLoss(truthProbability);
  const top1 = action ? deterministicTop1(distribution, truthLabel) : null;
  const credibleSets = action
    ? null
    : scoreCredibleSets(distribution, truthLabel);
  function coverage(level: 0.5 | 0.8 | 0.95): boolean | null {
    if (credibleSets === null) {
      return null;
    }
    const set = credibleSets.find((candidate) => candidate.level === level);
    if (set === undefined) {
      fail(`predictive set ${(level * 100).toString()} is missing.`);
    }
    return set.coversTruth;
  }
  return {
    brier: multiclassBrier(distribution, truthLabel),
    logLoss: logLoss.value,
    truthProbability,
    rawZeroTruthSupport: logLoss.rawZeroSupport,
    selectedTop1Correct: top1?.selectedCorrect ?? null,
    tieAwareTopSetCorrect: top1?.tieAwareCorrect ?? null,
    tieAwareTop1Credit: top1?.tieAwareCredit ?? null,
    coverage50: coverage(0.5),
    coverage80: coverage(0.8),
    coverage95: coverage(0.95),
    reliability: distribution.map((entry) => ({
      probability: entry.probability,
      outcome: entry.label === truthLabel,
    })),
  };
}

function scoreProjection(
  score: Omit<Phase8PairedScoreRecord, "scoreSha256">,
): Omit<Phase8PairedScoreRecord, "scoreSha256"> {
  return score;
}

export function validatePhase8PairedScoreRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8PairedScoreRecord {
  const parsed = phase8PairedScoreRecordSchema.parse(value);
  if (plan !== undefined) {
    verifyPhase8CalibrationPlan(plan);
    if (
      plan.mode !== "behavioral-comparison" ||
      parsed.planSha256 !== plan.planSha256 ||
      !plan.styleCellIds.includes(parsed.styleCellId)
    ) {
      fail("paired score provenance does not match the frozen plan.");
    }
  }
  const { scoreSha256, ...projection } = parsed;
  if (scoreSha256 !== phase8Sha256(scoreProjection(projection))) {
    fail("paired score checksum is invalid.");
  }
  return deepFreeze(parsed);
}

function skipProjection(
  skip: Omit<Phase8CalibrationScoreSkipRecord, "skipSha256">,
): Omit<Phase8CalibrationScoreSkipRecord, "skipSha256"> {
  return skip;
}

export function validatePhase8CalibrationScoreSkipRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8CalibrationScoreSkipRecord {
  const parsed = phase8CalibrationScoreSkipRecordSchema.parse(value);
  if (plan !== undefined) {
    verifyPhase8CalibrationPlan(plan);
    if (
      parsed.planSha256 !== plan.planSha256 ||
      !plan.styleCellIds.includes(parsed.styleCellId)
    ) {
      fail("score-skip provenance does not match the frozen plan.");
    }
  }
  const { skipSha256, ...projection } = parsed;
  if (skipSha256 !== phase8Sha256(skipProjection(projection))) {
    fail("score-skip checksum is invalid.");
  }
  return deepFreeze(parsed);
}

export function scorePhase8PairedPrediction(
  plan: Phase8CalibrationPlan,
  predictionValue: Phase8PairedPredictionRecord,
  truth: Phase8CalibrationTruthInput,
): Phase8PairedScoreRecord | Phase8CalibrationScoreSkipRecord {
  verifyPhase8CalibrationPlan(plan);
  const prediction = validatePhase8PairedPredictionRecord(
    predictionValue,
    plan,
  );
  if (truth.scoreStatus === "conditioning-false") {
    if (prediction.target.family !== "conditional") {
      fail("only conditional queries may have conditioning-false truth.");
    }
    const truthProjection = {
      schemaVersion: 1 as const,
      predictionRecordId: prediction.recordId,
      scoreStatus: truth.scoreStatus,
    };
    const withoutHash = {
      schemaVersion: 1 as const,
      scorerVersion: PHASE8_CALIBRATION_SCORER_VERSION,
      recordType: "phase8-calibration-score-skip" as const,
      planSha256: plan.planSha256,
      predictionRecordId: prediction.recordId,
      skipId: `phase8-calibration-score-skip:${phase8Sha256(truthProjection)}`,
      styleCellId: prediction.styleCellId,
      styleBaseClusterId: prediction.styleBaseClusterId,
      gameId: prediction.gameId,
      stateId: prediction.stateId,
      queryId: prediction.queryId,
      family: "conditional" as const,
      reason: "conditioning-false" as const,
      truthSha256: phase8Sha256(truthProjection),
    };
    return validatePhase8CalibrationScoreSkipRecord(
      {
        ...withoutHash,
        skipSha256: phase8Sha256(skipProjection(withoutHash)),
      },
      plan,
    );
  }
  if (!prediction.target.labels.includes(truth.truthLabel)) {
    fail("truth label is outside the frozen target labels.");
  }
  if (!prediction.support.feasibleLabels.includes(truth.truthLabel)) {
    fail("truth label is logically impossible under the hard support.");
  }
  const action = prediction.target.kind === "opponent-action";
  if (action !== (truth.forcedAction !== null)) {
    fail("forcedAction must be Boolean exactly for opponent-action truth.");
  }
  if (
    prediction.support.hardKnown &&
    prediction.support.feasibleLabels[0] !== truth.truthLabel
  ) {
    fail("a hard-known prediction disagrees with eval-only truth.");
  }
  const truthProjection = {
    schemaVersion: 1 as const,
    predictionRecordId: prediction.recordId,
    truthLabel: truth.truthLabel,
    forcedAction: truth.forcedAction,
  };
  const withoutHash = {
    schemaVersion: 1 as const,
    scorerVersion: PHASE8_CALIBRATION_SCORER_VERSION,
    recordType: "phase8-paired-calibration-score" as const,
    planSha256: plan.planSha256,
    predictionRecordId: prediction.recordId,
    scoreId: `phase8-calibration-score:${phase8Sha256(truthProjection)}`,
    styleCellId: prediction.styleCellId,
    styleBaseClusterId: prediction.styleBaseClusterId,
    gameId: prediction.gameId,
    stateId: prediction.stateId,
    queryId: prediction.queryId,
    family: prediction.target.family,
    hardKnown: prediction.support.hardKnown,
    forcedAction: truth.forcedAction,
    opponentSeat:
      prediction.target.kind === "opponent-action"
        ? prediction.target.opponentSeat
        : null,
    truthLabel: truth.truthLabel,
    truthSha256: phase8Sha256(truthProjection),
    hard: armScore(prediction.hard.rawDistribution, truth.truthLabel, action),
    behavior: armScore(
      prediction.behavior.rawDistribution,
      truth.truthLabel,
      action,
    ),
  };
  return validatePhase8PairedScoreRecord(
    {
      ...withoutHash,
      scoreSha256: phase8Sha256(scoreProjection(withoutHash)),
    },
    plan,
  );
}

function oneArmScoreProjection(
  score: Omit<Phase8ReferenceOneArmScoreRecord, "scoreSha256">,
): Omit<Phase8ReferenceOneArmScoreRecord, "scoreSha256"> {
  return score;
}

export function validatePhase8ReferenceOneArmScoreRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8ReferenceOneArmScoreRecord {
  const parsed = phase8ReferenceOneArmScoreRecordSchema.parse(value);
  if (plan !== undefined) {
    verifyPhase8CalibrationPlan(plan);
    if (
      plan.mode !== "reference-one-arm-confirmation" ||
      parsed.planSha256 !== plan.planSha256 ||
      !plan.styleCellIds.includes(parsed.styleCellId)
    ) {
      fail("one-arm score provenance does not match the frozen plan.");
    }
  }
  const { scoreSha256, ...projection } = parsed;
  if (scoreSha256 !== phase8Sha256(oneArmScoreProjection(projection))) {
    fail("one-arm score checksum is invalid.");
  }
  return deepFreeze(parsed);
}

export function validatePhase8CalibrationScoreRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8CalibrationScoreRecord {
  if (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "recordType") ===
      "phase8-reference-one-arm-calibration-score"
  ) {
    return validatePhase8ReferenceOneArmScoreRecord(value, plan);
  }
  return validatePhase8PairedScoreRecord(value, plan);
}

export function scorePhase8ReferenceOneArmPrediction(
  plan: Phase8CalibrationPlan,
  predictionValue: Phase8ReferenceOneArmPredictionRecord,
  truth: Phase8CalibrationTruthInput,
): Phase8ReferenceOneArmScoreRecord | Phase8CalibrationScoreSkipRecord {
  verifyPhase8CalibrationPlan(plan);
  const prediction = validatePhase8ReferenceOneArmPredictionRecord(
    predictionValue,
    plan,
  );
  if (truth.scoreStatus === "conditioning-false") {
    if (prediction.target.family !== "conditional") {
      fail("only conditional queries may have conditioning-false truth.");
    }
    const truthProjection = {
      schemaVersion: 1 as const,
      predictionRecordId: prediction.recordId,
      scoreStatus: truth.scoreStatus,
    };
    const withoutHash = {
      schemaVersion: 1 as const,
      scorerVersion: PHASE8_CALIBRATION_SCORER_VERSION,
      recordType: "phase8-calibration-score-skip" as const,
      planSha256: plan.planSha256,
      predictionRecordId: prediction.recordId,
      skipId: `phase8-calibration-score-skip:${phase8Sha256(truthProjection)}`,
      styleCellId: prediction.styleCellId,
      styleBaseClusterId: prediction.styleBaseClusterId,
      gameId: prediction.gameId,
      stateId: prediction.stateId,
      queryId: prediction.queryId,
      family: "conditional" as const,
      reason: "conditioning-false" as const,
      truthSha256: phase8Sha256(truthProjection),
    };
    return validatePhase8CalibrationScoreSkipRecord(
      {
        ...withoutHash,
        skipSha256: phase8Sha256(skipProjection(withoutHash)),
      },
      plan,
    );
  }
  if (!prediction.target.labels.includes(truth.truthLabel)) {
    fail("truth label is outside the frozen target labels.");
  }
  if (!prediction.support.feasibleLabels.includes(truth.truthLabel)) {
    fail("truth label is logically impossible under the hard support.");
  }
  const action = prediction.target.kind === "opponent-action";
  if (action !== (truth.forcedAction !== null)) {
    fail("forcedAction must be Boolean exactly for opponent-action truth.");
  }
  if (
    prediction.support.hardKnown &&
    prediction.support.feasibleLabels[0] !== truth.truthLabel
  ) {
    fail("a hard-known prediction disagrees with eval-only truth.");
  }
  const truthProjection = {
    schemaVersion: 1 as const,
    predictionRecordId: prediction.recordId,
    truthLabel: truth.truthLabel,
    forcedAction: truth.forcedAction,
  };
  const withoutHash = {
    schemaVersion: 1 as const,
    scorerVersion: PHASE8_CALIBRATION_SCORER_VERSION,
    recordType: "phase8-reference-one-arm-calibration-score" as const,
    planSha256: plan.planSha256,
    predictionRecordId: prediction.recordId,
    scoreId: `phase8-reference-one-arm-score:${phase8Sha256(truthProjection)}`,
    styleCellId: prediction.styleCellId,
    styleBaseClusterId: prediction.styleBaseClusterId,
    gameId: prediction.gameId,
    stateId: prediction.stateId,
    queryId: prediction.queryId,
    family: prediction.target.family,
    hardKnown: prediction.support.hardKnown,
    forcedAction: truth.forcedAction,
    opponentSeat:
      prediction.target.kind === "opponent-action"
        ? prediction.target.opponentSeat
        : null,
    truthLabel: truth.truthLabel,
    truthSha256: phase8Sha256(truthProjection),
    hard: armScore(prediction.hard.rawDistribution, truth.truthLabel, action),
  };
  return validatePhase8ReferenceOneArmScoreRecord(
    {
      ...withoutHash,
      scoreSha256: phase8Sha256(oneArmScoreProjection(withoutHash)),
    },
    plan,
  );
}

export function scorePhase8CalibrationPrediction(
  plan: Phase8CalibrationPlan,
  prediction: Phase8CalibrationPredictionRecord,
  truth: Phase8CalibrationTruthInput,
): Phase8CalibrationScoreRecord | Phase8CalibrationScoreSkipRecord {
  return prediction.recordType ===
    "phase8-reference-one-arm-calibration-prediction"
    ? scorePhase8ReferenceOneArmPrediction(plan, prediction, truth)
    : scorePhase8PairedPrediction(plan, prediction, truth);
}

function terminalScoreProjection(
  score: Omit<Phase8TerminalRiskScoreRecord, "scoreSha256">,
): Omit<Phase8TerminalRiskScoreRecord, "scoreSha256"> {
  return score;
}

export function validatePhase8TerminalRiskScoreRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8TerminalRiskScoreRecord {
  const parsed = phase8TerminalRiskScoreRecordSchema.parse(value);
  if (plan !== undefined) {
    verifyPhase8CalibrationPlan(plan);
    if (
      plan.mode !== "behavioral-comparison" ||
      parsed.planSha256 !== plan.planSha256 ||
      !plan.styleCellIds.includes(parsed.styleCellId)
    ) {
      fail("terminal-risk score provenance does not match the frozen plan.");
    }
  }
  const { scoreSha256, ...projection } = parsed;
  if (scoreSha256 !== phase8Sha256(terminalScoreProjection(projection))) {
    fail("terminal-risk score checksum is invalid.");
  }
  return deepFreeze(parsed);
}

function terminalArmScore(
  probabilityBhabhi: number,
  userWasBhabhi: boolean,
): Phase8CalibrationArmScore {
  const distribution = [
    { label: "bhabhi", probability: probabilityBhabhi },
    { label: "safe", probability: 1 - probabilityBhabhi },
  ].sort((left, right) => left.label.localeCompare(right.label));
  return armScore(distribution, userWasBhabhi ? "bhabhi" : "safe", false);
}

/**
 * Eval-only complete-game injection point. The prediction record contains no
 * terminal outcome; only this scorer accepts the observed Bhabhi label.
 */
export function scorePhase8TerminalRiskPrediction(
  plan: Phase8CalibrationPlan,
  predictionValue: Phase8TerminalRiskPredictionRecord,
  truth: Readonly<{ userWasBhabhi: boolean }>,
): Phase8TerminalRiskScoreRecord {
  verifyPhase8CalibrationPlan(plan);
  const prediction = validatePhase8TerminalRiskPredictionRecord(
    predictionValue,
    plan,
  );
  if (typeof truth.userWasBhabhi !== "boolean") {
    fail("terminal-risk truth must be Boolean.");
  }
  const truthProjection = {
    schemaVersion: 1 as const,
    predictionRecordId: prediction.recordId,
    userWasBhabhi: truth.userWasBhabhi,
  };
  const withoutHash = {
    schemaVersion: 1 as const,
    scorerVersion: PHASE8_CALIBRATION_SCORER_VERSION,
    recordType: "phase8-terminal-risk-score" as const,
    planSha256: plan.planSha256,
    predictionRecordId: prediction.recordId,
    scoreId: `phase8-terminal-risk-score:${phase8Sha256(truthProjection)}`,
    styleCellId: prediction.styleCellId,
    styleBaseClusterId: prediction.styleBaseClusterId,
    gameId: prediction.gameId,
    stateId: prediction.stateId,
    queryId: prediction.queryId,
    actionKey: prediction.actionKey,
    userWasBhabhi: truth.userWasBhabhi,
    truthSha256: phase8Sha256(truthProjection),
    hard: terminalArmScore(
      prediction.hard.probabilityBhabhi,
      truth.userWasBhabhi,
    ),
    behavior: terminalArmScore(
      prediction.behavior.probabilityBhabhi,
      truth.userWasBhabhi,
    ),
  };
  return validatePhase8TerminalRiskScoreRecord(
    {
      ...withoutHash,
      scoreSha256: phase8Sha256(terminalScoreProjection(withoutHash)),
    },
    plan,
  );
}

function oneArmTerminalScoreProjection(
  score: Omit<Phase8ReferenceOneArmTerminalRiskScoreRecord, "scoreSha256">,
): Omit<Phase8ReferenceOneArmTerminalRiskScoreRecord, "scoreSha256"> {
  return score;
}

export function validatePhase8ReferenceOneArmTerminalRiskScoreRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8ReferenceOneArmTerminalRiskScoreRecord {
  const parsed =
    phase8ReferenceOneArmTerminalRiskScoreRecordSchema.parse(value);
  if (plan !== undefined) {
    verifyPhase8CalibrationPlan(plan);
    if (
      plan.mode !== "reference-one-arm-confirmation" ||
      parsed.planSha256 !== plan.planSha256 ||
      !plan.styleCellIds.includes(parsed.styleCellId)
    ) {
      fail("one-arm terminal score provenance does not match the plan.");
    }
  }
  const { scoreSha256, ...projection } = parsed;
  if (scoreSha256 !== phase8Sha256(oneArmTerminalScoreProjection(projection))) {
    fail("one-arm terminal score checksum is invalid.");
  }
  return deepFreeze(parsed);
}

export function validatePhase8CalibrationTerminalRiskScoreRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8CalibrationTerminalRiskScoreRecord {
  if (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "recordType") ===
      "phase8-reference-one-arm-terminal-risk-score"
  ) {
    return validatePhase8ReferenceOneArmTerminalRiskScoreRecord(value, plan);
  }
  return validatePhase8TerminalRiskScoreRecord(value, plan);
}

export function scorePhase8ReferenceOneArmTerminalRiskPrediction(
  plan: Phase8CalibrationPlan,
  predictionValue: Phase8ReferenceOneArmTerminalRiskPredictionRecord,
  truth: Readonly<{ userWasBhabhi: boolean }>,
): Phase8ReferenceOneArmTerminalRiskScoreRecord {
  verifyPhase8CalibrationPlan(plan);
  const prediction = validatePhase8ReferenceOneArmTerminalRiskPredictionRecord(
    predictionValue,
    plan,
  );
  if (typeof truth.userWasBhabhi !== "boolean") {
    fail("terminal-risk truth must be Boolean.");
  }
  const truthProjection = {
    schemaVersion: 1 as const,
    predictionRecordId: prediction.recordId,
    userWasBhabhi: truth.userWasBhabhi,
  };
  const withoutHash = {
    schemaVersion: 1 as const,
    scorerVersion: PHASE8_CALIBRATION_SCORER_VERSION,
    recordType: "phase8-reference-one-arm-terminal-risk-score" as const,
    planSha256: plan.planSha256,
    predictionRecordId: prediction.recordId,
    scoreId: `phase8-reference-one-arm-terminal-score:${phase8Sha256(
      truthProjection,
    )}`,
    styleCellId: prediction.styleCellId,
    styleBaseClusterId: prediction.styleBaseClusterId,
    gameId: prediction.gameId,
    stateId: prediction.stateId,
    queryId: prediction.queryId,
    actionKey: prediction.actionKey,
    userWasBhabhi: truth.userWasBhabhi,
    truthSha256: phase8Sha256(truthProjection),
    hard: terminalArmScore(
      prediction.hard.probabilityBhabhi,
      truth.userWasBhabhi,
    ),
  };
  return validatePhase8ReferenceOneArmTerminalRiskScoreRecord(
    {
      ...withoutHash,
      scoreSha256: phase8Sha256(oneArmTerminalScoreProjection(withoutHash)),
    },
    plan,
  );
}

export function scorePhase8CalibrationTerminalRiskPrediction(
  plan: Phase8CalibrationPlan,
  prediction: Phase8CalibrationTerminalRiskPredictionRecord,
  truth: Readonly<{ userWasBhabhi: boolean }>,
): Phase8CalibrationTerminalRiskScoreRecord {
  return prediction.recordType ===
    "phase8-reference-one-arm-terminal-risk-prediction"
    ? scorePhase8ReferenceOneArmTerminalRiskPrediction(plan, prediction, truth)
    : scorePhase8TerminalRiskPrediction(plan, prediction, truth);
}

type HierarchyValue = Readonly<{
  observationId: string;
  styleBaseClusterId: string;
  gameId: string;
  stateId: string;
  family: Phase8CalibrationFamily;
  queryId: string;
  value: number;
}>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    fail("cannot average an empty collection.");
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const existing = groups.get(groupKey);
    if (existing === undefined) {
      groups.set(groupKey, [value]);
    } else {
      existing.push(value);
    }
  }
  return groups;
}

function key(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function nestedClusterMeans(
  values: readonly HierarchyValue[],
): ReadonlyMap<string, number> {
  if (values.length === 0) {
    return new Map();
  }
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.observationId)) {
      fail(`duplicate hierarchy observation ${value.observationId}.`);
    }
    ids.add(value.observationId);
    if (!Number.isFinite(value.value)) {
      fail(`hierarchy observation ${value.observationId} is non-finite.`);
    }
  }
  const queryMeans = [
    ...groupBy(values, (value) =>
      key([
        value.styleBaseClusterId,
        value.gameId,
        value.stateId,
        value.family,
        value.queryId,
      ]),
    ).values(),
  ].map((group) => {
    const first = group[0];
    if (first === undefined) {
      fail("query hierarchy group is empty.");
    }
    return {
      styleBaseClusterId: first.styleBaseClusterId,
      gameId: first.gameId,
      stateId: first.stateId,
      family: first.family,
      value: mean(group.map((entry) => entry.value)),
    };
  });
  const stateMeans = [
    ...groupBy(queryMeans, (value) =>
      key([
        value.styleBaseClusterId,
        value.gameId,
        value.stateId,
        value.family,
      ]),
    ).values(),
  ].map((group) => {
    const first = group[0];
    if (first === undefined) {
      fail("state hierarchy group is empty.");
    }
    return {
      styleBaseClusterId: first.styleBaseClusterId,
      gameId: first.gameId,
      family: first.family,
      value: mean(group.map((entry) => entry.value)),
    };
  });
  const gameMeans = [
    ...groupBy(stateMeans, (value) =>
      key([value.styleBaseClusterId, value.gameId, value.family]),
    ).values(),
  ].map((group) => {
    const first = group[0];
    if (first === undefined) {
      fail("game hierarchy group is empty.");
    }
    return {
      styleBaseClusterId: first.styleBaseClusterId,
      family: first.family,
      value: mean(group.map((entry) => entry.value)),
    };
  });
  return new Map(
    [
      ...groupBy(gameMeans, (value) =>
        key([value.styleBaseClusterId, value.family]),
      ).values(),
    ]
      .map((group) => {
        const first = group[0];
        if (first === undefined) {
          fail("cluster hierarchy group is empty.");
        }
        return [
          first.styleBaseClusterId,
          mean(group.map((entry) => entry.value)),
        ] as const;
      })
      .sort(([left], [right]) => compareText(left, right)),
  );
}

export type Phase8CalibrationContrastSeries = Readonly<{
  contrastId: string;
  clusterDifferences: Readonly<Record<string, number>>;
}>;

export type Phase8CalibrationBootstrapContrast = Readonly<{
  contrastId: string;
  estimate: number;
  standardError: number;
  oneSidedUpper: number;
  improvementGate: boolean;
}>;

export type Phase8CalibrationBootstrapResult = Readonly<{
  method: typeof PHASE8_CALIBRATION_BOOTSTRAP_METHOD;
  confidenceLevel: 0.95;
  resamples: typeof PHASE8_CALIBRATION_BOOTSTRAP_RESAMPLES;
  seedId: string;
  clusterCount: number;
  familySize: number;
  oneSidedUpperCriticalValue: number;
  contrasts: readonly Phase8CalibrationBootstrapContrast[];
  simultaneousImprovementGate: boolean;
  resultSha256: string;
}>;

function contrastEntries(
  differences: Phase8CalibrationContrastSeries["clusterDifferences"],
): readonly (readonly [string, number])[] {
  const entries = Object.entries(differences);
  return entries.sort(([left], [right]) => compareText(left, right));
}

function sampleStandardError(values: readonly number[]): number {
  if (values.length < 2) {
    fail("the confirmatory bootstrap requires at least two clusters.");
  }
  const average = mean(values);
  const variance =
    values.reduce((total, value) => total + (value - average) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance / values.length);
}

function empiricalQuantile(
  values: readonly number[],
  probability: number,
): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(ordered.length - 1, Math.ceil(probability * ordered.length) - 1),
  );
  const value = ordered[index];
  if (value === undefined) {
    fail("cannot select a bootstrap quantile from an empty sample.");
  }
  return value;
}

function standardizedDeviation(
  deviation: number,
  standardError: number,
): number {
  if (standardError <= Number.EPSILON) {
    return 0;
  }
  return deviation / standardError;
}

/**
 * A single keyed resampling loop is shared by every frozen contrast. The
 * maximum studentized deviation supplies a simultaneous one-sided 95% upper
 * bound; evidence uses exactly 20,000 whole style-base-cluster resamples.
 */
export function simultaneousPhase8CalibrationBootstrap(input: {
  readonly contrasts: readonly Phase8CalibrationContrastSeries[];
  readonly seed: string;
}): Phase8CalibrationBootstrapResult {
  if (input.contrasts.length === 0 || input.contrasts.length > 32) {
    fail("bootstrap family size must be between 1 and 32.");
  }
  if (input.seed.length === 0) {
    fail("bootstrap seed must not be empty.");
  }
  const ids = new Set<string>();
  const work = input.contrasts.map((contrast) => {
    if (contrast.contrastId.length === 0 || ids.has(contrast.contrastId)) {
      fail("bootstrap contrast IDs must be non-empty and unique.");
    }
    ids.add(contrast.contrastId);
    const entries = contrastEntries(contrast.clusterDifferences);
    if (entries.length < 2 || entries.length > 10_000) {
      fail("bootstrap cluster count must be between 2 and 10,000.");
    }
    for (const [, value] of entries) {
      if (!Number.isFinite(value)) {
        fail("bootstrap cluster differences must be finite.");
      }
    }
    const values = entries.map((entry) => entry[1]);
    return {
      contrastId: contrast.contrastId,
      clusterIds: entries.map((entry) => entry[0]),
      values,
      estimate: mean(values),
      standardError: sampleStandardError(values),
    };
  });
  const canonicalClusterIds = work[0]?.clusterIds;
  if (canonicalClusterIds === undefined) {
    fail("bootstrap work set unexpectedly is empty.");
  }
  for (const contrast of work.slice(1)) {
    if (
      contrast.clusterIds.length !== canonicalClusterIds.length ||
      contrast.clusterIds.some(
        (clusterId, index) => clusterId !== canonicalClusterIds[index],
      )
    ) {
      fail("every simultaneous contrast must use the same cluster IDs.");
    }
  }
  const rng = createSeededRng(input.seed).fork(
    PHASE8_CALIBRATION_BOOTSTRAP_METHOD,
    phase8Sha256({
      schemaVersion: 1,
      contrastIds: work.map((contrast) => contrast.contrastId),
      clusterIds: canonicalClusterIds,
      resamples: PHASE8_CALIBRATION_BOOTSTRAP_RESAMPLES,
    }),
  );
  const maxima: number[] = [];
  const totals = new Float64Array(work.length);
  for (
    let resample = 0;
    resample < PHASE8_CALIBRATION_BOOTSTRAP_RESAMPLES;
    resample += 1
  ) {
    totals.fill(0);
    for (let draw = 0; draw < canonicalClusterIds.length; draw += 1) {
      const clusterIndex = rng.nextInt(canonicalClusterIds.length);
      for (
        let contrastIndex = 0;
        contrastIndex < work.length;
        contrastIndex += 1
      ) {
        totals[contrastIndex] =
          (totals[contrastIndex] ?? 0) +
          (work[contrastIndex]?.values[clusterIndex] ?? 0);
      }
    }
    let maximum = Number.NEGATIVE_INFINITY;
    for (
      let contrastIndex = 0;
      contrastIndex < work.length;
      contrastIndex += 1
    ) {
      const contrast = work[contrastIndex];
      if (contrast === undefined) {
        fail("bootstrap contrast index is missing.");
      }
      const bootstrapEstimate =
        (totals[contrastIndex] ?? 0) / canonicalClusterIds.length;
      maximum = Math.max(
        maximum,
        standardizedDeviation(
          bootstrapEstimate - contrast.estimate,
          contrast.standardError,
        ),
      );
    }
    maxima.push(maximum);
  }
  const criticalValue = empiricalQuantile(maxima, 0.95);
  const contrasts = work.map((contrast) => {
    const oneSidedUpper =
      contrast.estimate + criticalValue * contrast.standardError;
    return {
      contrastId: contrast.contrastId,
      estimate: contrast.estimate,
      standardError: contrast.standardError,
      oneSidedUpper,
      improvementGate: oneSidedUpper < 0,
    };
  });
  const withoutHash = {
    method: PHASE8_CALIBRATION_BOOTSTRAP_METHOD,
    confidenceLevel: 0.95 as const,
    resamples: PHASE8_CALIBRATION_BOOTSTRAP_RESAMPLES,
    seedId: rng.seedId,
    clusterCount: canonicalClusterIds.length,
    familySize: contrasts.length,
    oneSidedUpperCriticalValue: criticalValue,
    contrasts,
    simultaneousImprovementGate: contrasts.every(
      (contrast) => contrast.improvementGate,
    ),
  };
  return deepFreeze({
    ...withoutHash,
    resultSha256: phase8Sha256(withoutHash),
  });
}

type Arm = "hard-only" | "behavioral";

type ScoreView = Readonly<{
  observationId: string;
  styleCellId: string;
  styleBaseClusterId: string;
  gameId: string;
  stateId: string;
  queryId: string;
  family: Phase8CalibrationFamily;
  hardKnown: boolean;
  forcedAction: boolean | null;
  opponentSeat: "p2" | "p3" | null;
  arm: Arm;
  score: Phase8CalibrationArmScore;
}>;

function scoreViews(
  scores: readonly Phase8CalibrationScoreRecord[],
  terminalScores: readonly Phase8CalibrationTerminalRiskScoreRecord[],
): readonly ScoreView[] {
  const views: ScoreView[] = [];
  for (const score of scores) {
    const arms =
      score.recordType === "phase8-paired-calibration-score"
        ? (["hard-only", "behavioral"] as const)
        : (["hard-only"] as const);
    for (const arm of arms) {
      views.push({
        observationId: `${score.scoreId}/${arm}`,
        styleCellId: score.styleCellId,
        styleBaseClusterId: score.styleBaseClusterId,
        gameId: score.gameId,
        stateId: score.stateId,
        queryId: score.queryId,
        family: score.family,
        hardKnown: score.hardKnown,
        forcedAction: score.forcedAction,
        opponentSeat: score.opponentSeat,
        arm,
        score:
          arm === "hard-only"
            ? score.hard
            : score.recordType === "phase8-paired-calibration-score"
              ? score.behavior
              : fail("one-arm score exposed a behavioral view."),
      });
    }
  }
  for (const score of terminalScores) {
    const arms =
      score.recordType === "phase8-terminal-risk-score"
        ? (["hard-only", "behavioral"] as const)
        : (["hard-only"] as const);
    for (const arm of arms) {
      views.push({
        observationId: `${score.scoreId}/${arm}`,
        styleCellId: score.styleCellId,
        styleBaseClusterId: score.styleBaseClusterId,
        gameId: score.gameId,
        stateId: score.stateId,
        queryId: score.queryId,
        family: "terminal-risk",
        hardKnown: false,
        forcedAction: null,
        opponentSeat: null,
        arm,
        score:
          arm === "hard-only"
            ? score.hard
            : score.recordType === "phase8-terminal-risk-score"
              ? score.behavior
              : fail("one-arm terminal score exposed a behavioral view."),
      });
    }
  }
  return Object.freeze(views);
}

function hierarchyValues(
  views: readonly ScoreView[],
  metric: string,
  value: (view: ScoreView) => number | null,
): readonly HierarchyValue[] {
  return views.flatMap((view) => {
    const metricValue = value(view);
    return metricValue === null
      ? []
      : [
          {
            observationId: `${view.observationId}/${metric}`,
            styleBaseClusterId: view.styleBaseClusterId,
            gameId: view.gameId,
            stateId: view.stateId,
            family: view.family,
            queryId: view.queryId,
            value: metricValue,
          },
        ];
  });
}

function nestedMean(
  views: readonly ScoreView[],
  metric: string,
  value: (view: ScoreView) => number | null,
): number | null {
  const clusters = nestedClusterMeans(hierarchyValues(views, metric, value));
  return clusters.size === 0 ? null : mean([...clusters.values()]);
}

export type Phase8ReliabilityBin = Readonly<{
  index: number;
  lowerInclusive: number;
  upper: number;
  upperInclusive: boolean;
  count: number;
  weight: number;
  meanPrediction: number | null;
  observedRate: number | null;
}>;

function reliabilityBins(
  views: readonly ScoreView[],
): readonly Phase8ReliabilityBin[] {
  const accumulators = Array.from({ length: 10 }, () => ({
    count: 0,
    weight: 0,
    probability: 0,
    outcome: 0,
  }));
  const clusters = groupBy(views, (view) => view.styleBaseClusterId);
  for (const cluster of clusters.values()) {
    const clusterWeight = 1 / clusters.size;
    const games = groupBy(cluster, (view) => view.gameId);
    for (const game of games.values()) {
      const gameWeight = clusterWeight / games.size;
      const states = groupBy(game, (view) => view.stateId);
      for (const state of states.values()) {
        const stateWeight = gameWeight / states.size;
        const queries = groupBy(state, (view) => view.queryId);
        for (const query of queries.values()) {
          const queryWeight = stateWeight / queries.size / query.length;
          for (const view of query) {
            const contributionWeight =
              queryWeight / view.score.reliability.length;
            for (const contribution of view.score.reliability) {
              const index = Math.min(
                9,
                Math.floor(contribution.probability * 10),
              );
              const accumulator = accumulators[index];
              if (accumulator === undefined) {
                fail("reliability bin index is outside 0..9.");
              }
              accumulator.count += 1;
              accumulator.weight += contributionWeight;
              accumulator.probability +=
                contributionWeight * contribution.probability;
              accumulator.outcome +=
                contributionWeight * (contribution.outcome ? 1 : 0);
            }
          }
        }
      }
    }
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
          : accumulator.probability / accumulator.weight,
      observedRate:
        accumulator.weight === 0
          ? null
          : accumulator.outcome / accumulator.weight,
    })),
  );
}

export type Phase8CalibrationSecondaryLine = Readonly<{
  arm: Arm;
  family: Phase8CalibrationFamily;
  knowledgeStratum: "hard-known" | "unresolved-soft";
  actionDecisionClass: "forced" | "discretionary" | null;
  opponentSeat: "p2" | "p3" | null;
  observations: number;
  games: number;
  clusters: number;
  meanBrier: number;
  meanLogLoss: number;
  rawZeroTruthSupport: number;
  selectedTop1Accuracy: number | null;
  tieAwareTopSetAccuracy: number | null;
  tieAwareTop1Credit: number | null;
  coverage50: number | null;
  coverage80: number | null;
  coverage95: number | null;
  reliability: readonly Phase8ReliabilityBin[];
}>;

function secondaryLines(
  views: readonly ScoreView[],
): readonly Phase8CalibrationSecondaryLine[] {
  const lines: Phase8CalibrationSecondaryLine[] = [];
  for (const arm of ["hard-only", "behavioral"] as const) {
    for (const family of PHASE8_CALIBRATION_ALL_FAMILIES) {
      for (const knowledgeStratum of [
        "hard-known",
        "unresolved-soft",
      ] as const) {
        const decisions =
          family === "opponent-action"
            ? (["forced", "discretionary"] as const)
            : ([null] as const);
        const seats =
          family === "opponent-action"
            ? (["p2", "p3"] as const)
            : ([null] as const);
        for (const actionDecisionClass of decisions) {
          for (const opponentSeat of seats) {
            const stratum = views.filter(
              (view) =>
                view.arm === arm &&
                view.family === family &&
                (view.hardKnown ? "hard-known" : "unresolved-soft") ===
                  knowledgeStratum &&
                (family !== "opponent-action" ||
                  ((view.forcedAction ? "forced" : "discretionary") ===
                    actionDecisionClass &&
                    view.opponentSeat === opponentSeat)),
            );
            if (stratum.length === 0) {
              continue;
            }
            const meanBrier = nestedMean(
              stratum,
              "brier",
              (view) => view.score.brier,
            );
            const meanLogLoss = nestedMean(
              stratum,
              "log-loss",
              (view) => view.score.logLoss,
            );
            if (meanBrier === null || meanLogLoss === null) {
              fail("non-empty score stratum produced an empty metric.");
            }
            lines.push({
              arm,
              family,
              knowledgeStratum,
              actionDecisionClass,
              opponentSeat,
              observations: stratum.length,
              games: new Set(stratum.map((view) => view.gameId)).size,
              clusters: new Set(stratum.map((view) => view.styleBaseClusterId))
                .size,
              meanBrier,
              meanLogLoss,
              rawZeroTruthSupport: stratum.filter(
                (view) => view.score.rawZeroTruthSupport,
              ).length,
              selectedTop1Accuracy: nestedMean(
                stratum,
                "selected-top1",
                (view) =>
                  view.score.selectedTop1Correct === null
                    ? null
                    : view.score.selectedTop1Correct
                      ? 1
                      : 0,
              ),
              tieAwareTopSetAccuracy: nestedMean(
                stratum,
                "tie-aware-top-set",
                (view) =>
                  view.score.tieAwareTopSetCorrect === null
                    ? null
                    : view.score.tieAwareTopSetCorrect
                      ? 1
                      : 0,
              ),
              tieAwareTop1Credit: nestedMean(
                stratum,
                "tie-aware-credit",
                (view) => view.score.tieAwareTop1Credit,
              ),
              coverage50: nestedMean(stratum, "coverage-50", (view) =>
                view.score.coverage50 === null
                  ? null
                  : view.score.coverage50
                    ? 1
                    : 0,
              ),
              coverage80: nestedMean(stratum, "coverage-80", (view) =>
                view.score.coverage80 === null
                  ? null
                  : view.score.coverage80
                    ? 1
                    : 0,
              ),
              coverage95: nestedMean(stratum, "coverage-95", (view) =>
                view.score.coverage95 === null
                  ? null
                  : view.score.coverage95
                    ? 1
                    : 0,
              ),
              reliability: reliabilityBins(stratum),
            });
          }
        }
      }
    }
  }
  return Object.freeze(lines);
}

export type Phase8CalibrationNotApplicableBootstrap = Readonly<{
  method: "not-applicable-reference-one-arm";
  confidenceLevel: null;
  resamples: 0;
  seedId: null;
  clusterCount: number;
  familySize: 0;
  oneSidedUpperCriticalValue: null;
  contrasts: readonly Phase8CalibrationBootstrapContrast[];
  simultaneousImprovementGate: null;
  resultSha256: string;
}>;

export type Phase8CalibrationPrimaryEndpoint = Readonly<{
  endpointId: "equal-family-unresolved-soft-brier-v1";
  mode: "behavioral-comparison" | "reference-one-arm-confirmation";
  contrastApplicability: "applicable" | "not-applicable";
  families: typeof PHASE8_CALIBRATION_PRIMARY_FAMILIES;
  observedClusters: number;
  completeClusters: number;
  incompleteClusters: number;
  hardBrier: number;
  behaviorBrier: number | null;
  behaviorMinusHard: number | null;
  clusterDifferences: readonly Readonly<{
    styleBaseClusterId: string;
    hardBrier: number;
    behaviorBrier: number | null;
    difference: number | null;
  }>[];
  bootstrap:
    Phase8CalibrationBootstrapResult | Phase8CalibrationNotApplicableBootstrap;
}>;

function behavioralPrimaryEndpoint(
  scores: readonly Phase8PairedScoreRecord[],
  plan: Phase8CalibrationPlan,
): Phase8CalibrationPrimaryEndpoint {
  if (
    plan.mode !== "behavioral-comparison" ||
    plan.bootstrap.method !== "paired-style-base-cluster-max-statistic-v1"
  ) {
    fail("behavioral primary endpoint requires the paired bootstrap plan.");
  }
  const familyClusterMeans = new Map<
    Phase8CalibrationPrimaryFamily,
    Readonly<{
      hard: ReadonlyMap<string, number>;
      behavior: ReadonlyMap<string, number>;
    }>
  >();
  const observedClusters = new Set<string>();
  for (const family of PHASE8_CALIBRATION_PRIMARY_FAMILIES) {
    const eligible = scores.filter(
      (score) => score.family === family && !score.hardKnown,
    );
    for (const score of eligible) {
      observedClusters.add(score.styleBaseClusterId);
    }
    const common = eligible.map((score) => ({
      observationId: score.scoreId,
      styleBaseClusterId: score.styleBaseClusterId,
      gameId: score.gameId,
      stateId: score.stateId,
      family,
      queryId: score.queryId,
    }));
    familyClusterMeans.set(family, {
      hard: nestedClusterMeans(
        common.map((value, index) => ({
          ...value,
          observationId: `${value.observationId}/hard/${index.toString()}`,
          value: eligible[index]?.hard.brier ?? Number.NaN,
        })),
      ),
      behavior: nestedClusterMeans(
        common.map((value, index) => ({
          ...value,
          observationId: `${value.observationId}/behavior/${index.toString()}`,
          value: eligible[index]?.behavior.brier ?? Number.NaN,
        })),
      ),
    });
  }
  const completeClusterIds = [...observedClusters]
    .filter((clusterId) =>
      PHASE8_CALIBRATION_PRIMARY_FAMILIES.every((family) => {
        const means = familyClusterMeans.get(family);
        return (
          means?.hard.has(clusterId) === true && means.behavior.has(clusterId)
        );
      }),
    )
    .sort(compareText);
  if (completeClusterIds.length < 2) {
    fail(
      "the primary endpoint requires at least two clusters containing every frozen family.",
    );
  }
  const clusterDifferences = completeClusterIds.map((styleBaseClusterId) => {
    const hardValues = PHASE8_CALIBRATION_PRIMARY_FAMILIES.map((family) =>
      familyClusterMeans.get(family)?.hard.get(styleBaseClusterId),
    );
    const behaviorValues = PHASE8_CALIBRATION_PRIMARY_FAMILIES.map((family) =>
      familyClusterMeans.get(family)?.behavior.get(styleBaseClusterId),
    );
    if (
      hardValues.some((value) => value === undefined) ||
      behaviorValues.some((value) => value === undefined)
    ) {
      fail("a primary-complete cluster lost a frozen family.");
    }
    const hardBrier = mean(hardValues as number[]);
    const behaviorBrier = mean(behaviorValues as number[]);
    return {
      styleBaseClusterId,
      hardBrier,
      behaviorBrier,
      difference: behaviorBrier - hardBrier,
    };
  });
  const bootstrap = simultaneousPhase8CalibrationBootstrap({
    contrasts: [
      {
        contrastId: "equal-family-unresolved-soft-brier/behavior-minus-hard",
        clusterDifferences: Object.fromEntries(
          clusterDifferences.map((cluster) => [
            cluster.styleBaseClusterId,
            cluster.difference,
          ]),
        ),
      },
    ],
    seed: plan.bootstrap.seed,
  });
  return deepFreeze({
    endpointId: "equal-family-unresolved-soft-brier-v1" as const,
    mode: "behavioral-comparison" as const,
    contrastApplicability: "applicable" as const,
    families: PHASE8_CALIBRATION_PRIMARY_FAMILIES,
    observedClusters: observedClusters.size,
    completeClusters: completeClusterIds.length,
    incompleteClusters: observedClusters.size - completeClusterIds.length,
    hardBrier: mean(clusterDifferences.map((cluster) => cluster.hardBrier)),
    behaviorBrier: mean(
      clusterDifferences.map((cluster) => cluster.behaviorBrier),
    ),
    behaviorMinusHard: mean(
      clusterDifferences.map((cluster) => cluster.difference),
    ),
    clusterDifferences,
    bootstrap,
  });
}

function referenceOneArmPrimaryEndpoint(
  scores: readonly Phase8ReferenceOneArmScoreRecord[],
): Phase8CalibrationPrimaryEndpoint {
  const familyClusterMeans = new Map<
    Phase8CalibrationPrimaryFamily,
    ReadonlyMap<string, number>
  >();
  const observedClusters = new Set<string>();
  for (const family of PHASE8_CALIBRATION_PRIMARY_FAMILIES) {
    const eligible = scores.filter(
      (score) => score.family === family && !score.hardKnown,
    );
    for (const score of eligible) {
      observedClusters.add(score.styleBaseClusterId);
    }
    familyClusterMeans.set(
      family,
      nestedClusterMeans(
        eligible.map((score, index) => ({
          observationId: `${score.scoreId}/hard/${index.toString()}`,
          styleBaseClusterId: score.styleBaseClusterId,
          gameId: score.gameId,
          stateId: score.stateId,
          family,
          queryId: score.queryId,
          value: score.hard.brier,
        })),
      ),
    );
  }
  const completeClusterIds = [...observedClusters]
    .filter((clusterId) =>
      PHASE8_CALIBRATION_PRIMARY_FAMILIES.every(
        (family) => familyClusterMeans.get(family)?.has(clusterId) === true,
      ),
    )
    .sort(compareText);
  if (completeClusterIds.length < 2) {
    fail(
      "the one-arm primary endpoint requires at least two clusters containing every frozen family.",
    );
  }
  const clusterDifferences = completeClusterIds.map((styleBaseClusterId) => {
    const hardValues = PHASE8_CALIBRATION_PRIMARY_FAMILIES.map((family) =>
      familyClusterMeans.get(family)?.get(styleBaseClusterId),
    );
    if (hardValues.some((value) => value === undefined)) {
      fail("a one-arm primary-complete cluster lost a frozen family.");
    }
    return {
      styleBaseClusterId,
      hardBrier: mean(hardValues as number[]),
      behaviorBrier: null,
      difference: null,
    };
  });
  const bootstrapWithoutHash = {
    method: "not-applicable-reference-one-arm" as const,
    confidenceLevel: null,
    resamples: 0 as const,
    seedId: null,
    clusterCount: completeClusterIds.length,
    familySize: 0 as const,
    oneSidedUpperCriticalValue: null,
    contrasts: [] as readonly Phase8CalibrationBootstrapContrast[],
    simultaneousImprovementGate: null,
  };
  return deepFreeze({
    endpointId: "equal-family-unresolved-soft-brier-v1" as const,
    mode: "reference-one-arm-confirmation" as const,
    contrastApplicability: "not-applicable" as const,
    families: PHASE8_CALIBRATION_PRIMARY_FAMILIES,
    observedClusters: observedClusters.size,
    completeClusters: completeClusterIds.length,
    incompleteClusters: observedClusters.size - completeClusterIds.length,
    hardBrier: mean(clusterDifferences.map((cluster) => cluster.hardBrier)),
    behaviorBrier: null,
    behaviorMinusHard: null,
    clusterDifferences,
    bootstrap: {
      ...bootstrapWithoutHash,
      resultSha256: phase8Sha256(bootstrapWithoutHash),
    },
  });
}

function primaryEndpoint(
  scores: readonly Phase8CalibrationScoreRecord[],
  plan: Phase8CalibrationPlan,
): Phase8CalibrationPrimaryEndpoint {
  if (plan.mode === "reference-one-arm-confirmation") {
    if (
      scores.some(
        (score) =>
          score.recordType !== "phase8-reference-one-arm-calibration-score",
      )
    ) {
      fail("one-arm primary endpoint received a paired score.");
    }
    return referenceOneArmPrimaryEndpoint(
      scores as readonly Phase8ReferenceOneArmScoreRecord[],
    );
  }
  if (
    scores.some(
      (score) => score.recordType !== "phase8-paired-calibration-score",
    )
  ) {
    fail("behavioral primary endpoint received a one-arm score.");
  }
  return behavioralPrimaryEndpoint(
    scores as readonly Phase8PairedScoreRecord[],
    plan,
  );
}

export type Phase8CalibrationSummary = Readonly<{
  schemaVersion: 1;
  scorerVersion: typeof PHASE8_CALIBRATION_SCORER_VERSION;
  planSha256: string;
  split: "qualification" | "final";
  mode: "behavioral-comparison" | "reference-one-arm-confirmation";
  pairedPredictions: number;
  pairedScores: number;
  pairedScoreSkips: number;
  oneArmPredictions: number;
  oneArmScores: number;
  oneArmScoreSkips: number;
  terminalRiskPredictions: number;
  terminalRiskScores: number;
  oneArmTerminalRiskPredictions: number;
  oneArmTerminalRiskScores: number;
  observedStyleCells: number;
  observedStyleBaseClusters: number;
  primary: Phase8CalibrationPrimaryEndpoint;
  secondary: readonly Phase8CalibrationSecondaryLine[];
  gates: Readonly<{
    completePairing: boolean;
    scheduledClusterCoverage: boolean;
    minimumStyleBaseClusters: boolean;
    stressCellsIncluded: boolean;
    hardKnownExact: boolean;
    zeroRawLogicallyPossibleSupport: boolean;
    actionP2P3Separated: boolean;
    terminalRiskPresent: boolean;
    simultaneousCalibrationImprovement: boolean | null;
    evidenceEligible: boolean;
  }>;
  summarySha256: string;
}>;

function summaryProjection(
  summary: Omit<Phase8CalibrationSummary, "summarySha256">,
): Omit<Phase8CalibrationSummary, "summarySha256"> {
  return summary;
}

function assertUniqueRecords(
  records: readonly Readonly<{ recordId: string }>[],
  label: string,
): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.recordId)) {
      fail(`duplicate ${label} record ID ${record.recordId}.`);
    }
    ids.add(record.recordId);
  }
}

function assertUniqueScores(
  records: readonly Readonly<{ scoreId: string }>[],
  label: string,
): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.scoreId)) {
      fail(`duplicate ${label} score ID ${record.scoreId}.`);
    }
    ids.add(record.scoreId);
  }
}

export function summarizePhase8Calibration(input: {
  readonly plan: Phase8CalibrationPlan;
  readonly predictions: readonly Phase8CalibrationPredictionRecord[];
  readonly scores: readonly Phase8CalibrationScoreRecord[];
  readonly scoreSkips: readonly Phase8CalibrationScoreSkipRecord[];
  readonly terminalRiskPredictions: readonly Phase8CalibrationTerminalRiskPredictionRecord[];
  readonly terminalRiskScores: readonly Phase8CalibrationTerminalRiskScoreRecord[];
}): Phase8CalibrationSummary {
  verifyPhase8CalibrationPlan(input.plan);
  const predictions = input.predictions.map((record) =>
    validatePhase8CalibrationPredictionRecord(record, input.plan),
  );
  const scores = input.scores.map((record) =>
    validatePhase8CalibrationScoreRecord(record, input.plan),
  );
  const scoreSkips = input.scoreSkips.map((record) =>
    validatePhase8CalibrationScoreSkipRecord(record, input.plan),
  );
  const terminalRiskPredictions = input.terminalRiskPredictions.map((record) =>
    validatePhase8CalibrationTerminalRiskPredictionRecord(record, input.plan),
  );
  const terminalRiskScores = input.terminalRiskScores.map((record) =>
    validatePhase8CalibrationTerminalRiskScoreRecord(record, input.plan),
  );
  assertUniqueRecords(predictions, "paired prediction");
  assertUniqueScores(scores, "paired");
  assertUniqueRecords(
    scoreSkips.map((skip) => ({ recordId: skip.skipId })),
    "score-skip",
  );
  assertUniqueRecords(terminalRiskPredictions, "terminal prediction");
  assertUniqueScores(terminalRiskScores, "terminal");

  const predictionById = new Map(
    predictions.map((prediction) => [prediction.recordId, prediction]),
  );
  const pairedAccountCounts = new Map<string, number>();
  let hardKnownExact = true;
  for (const score of scores) {
    const prediction = predictionById.get(score.predictionRecordId);
    if (prediction === undefined) {
      fail(`score ${score.scoreId} has no paired prediction.`);
    }
    const reproduced = scorePhase8CalibrationPrediction(
      input.plan,
      prediction,
      {
        scoreStatus: "scored",
        truthLabel: score.truthLabel,
        forcedAction: score.forcedAction,
      },
    );
    if (
      reproduced.recordType === "phase8-calibration-score-skip" ||
      reproduced.scoreSha256 !== score.scoreSha256
    ) {
      fail(`score ${score.scoreId} does not reproduce from its prediction.`);
    }
    pairedAccountCounts.set(
      score.predictionRecordId,
      (pairedAccountCounts.get(score.predictionRecordId) ?? 0) + 1,
    );
    if (
      prediction.support.hardKnown &&
      (prediction.hard.rawDistribution.find(
        (entry) => entry.label === score.truthLabel,
      )?.probability !== 1 ||
        (prediction.recordType === "phase8-paired-calibration-prediction" &&
          prediction.behavior.rawDistribution.find(
            (entry) => entry.label === score.truthLabel,
          )?.probability !== 1))
    ) {
      hardKnownExact = false;
    }
  }
  for (const skip of scoreSkips) {
    const prediction = predictionById.get(skip.predictionRecordId);
    if (prediction === undefined) {
      fail(`score skip ${skip.skipId} has no paired prediction.`);
    }
    const reproduced = scorePhase8CalibrationPrediction(
      input.plan,
      prediction,
      {
        scoreStatus: "conditioning-false",
        truthLabel: null,
        forcedAction: null,
      },
    );
    if (
      reproduced.recordType !== "phase8-calibration-score-skip" ||
      reproduced.skipSha256 !== skip.skipSha256
    ) {
      fail(`score skip ${skip.skipId} does not reproduce.`);
    }
    pairedAccountCounts.set(
      skip.predictionRecordId,
      (pairedAccountCounts.get(skip.predictionRecordId) ?? 0) + 1,
    );
  }
  const terminalPredictionById = new Map(
    terminalRiskPredictions.map((prediction) => [
      prediction.recordId,
      prediction,
    ]),
  );
  const terminalAccountCounts = new Map<string, number>();
  for (const score of terminalRiskScores) {
    const prediction = terminalPredictionById.get(score.predictionRecordId);
    if (prediction === undefined) {
      fail(`terminal score ${score.scoreId} has no prediction.`);
    }
    const reproduced = scorePhase8CalibrationTerminalRiskPrediction(
      input.plan,
      prediction,
      { userWasBhabhi: score.userWasBhabhi },
    );
    if (reproduced.scoreSha256 !== score.scoreSha256) {
      fail(`terminal score ${score.scoreId} does not reproduce.`);
    }
    terminalAccountCounts.set(
      score.predictionRecordId,
      (terminalAccountCounts.get(score.predictionRecordId) ?? 0) + 1,
    );
  }

  const views = scoreViews(scores, terminalRiskScores);
  const secondary = secondaryLines(views);
  const primary = primaryEndpoint(scores, input.plan);
  const observedStyleCells = new Set(views.map((view) => view.styleCellId));
  const observedClusters = new Set(
    views.map((view) => view.styleBaseClusterId),
  );
  const completePairing =
    predictions.every(
      (prediction) => pairedAccountCounts.get(prediction.recordId) === 1,
    ) &&
    pairedAccountCounts.size === predictions.length &&
    terminalRiskPredictions.every(
      (prediction) => terminalAccountCounts.get(prediction.recordId) === 1,
    ) &&
    terminalAccountCounts.size === terminalRiskPredictions.length;
  const scheduledClusterCoverage =
    primary.completeClusters === input.plan.scheduledStyleBaseClusters &&
    primary.incompleteClusters === 0;
  const minimumStyleBaseClusters =
    primary.completeClusters >= PHASE8_CALIBRATION_MINIMUM_STYLE_BASE_CLUSTERS;
  const stressCellsIncluded = PHASE8_CALIBRATION_STRESS_CELL_IDS.every(
    (cellId) => observedStyleCells.has(cellId),
  );
  const zeroRawLogicallyPossibleSupport = views.every(
    (view) => !view.score.rawZeroTruthSupport,
  );
  const actionP2P3Separated = (["p2", "p3"] as const).every((seat) =>
    secondary.some(
      (line) =>
        line.family === "opponent-action" &&
        line.knowledgeStratum === "unresolved-soft" &&
        line.actionDecisionClass === "discretionary" &&
        line.opponentSeat === seat,
    ),
  );
  const terminalRiskPresent = terminalRiskScores.length > 0;
  const simultaneousCalibrationImprovement =
    primary.bootstrap.simultaneousImprovementGate;
  const behaviorContrastSatisfied =
    input.plan.mode === "reference-one-arm-confirmation" ||
    simultaneousCalibrationImprovement === true;
  const evidenceEligible =
    completePairing &&
    scheduledClusterCoverage &&
    minimumStyleBaseClusters &&
    stressCellsIncluded &&
    hardKnownExact &&
    zeroRawLogicallyPossibleSupport &&
    actionP2P3Separated &&
    terminalRiskPresent &&
    behaviorContrastSatisfied;
  const withoutHash = {
    schemaVersion: 1 as const,
    scorerVersion: PHASE8_CALIBRATION_SCORER_VERSION,
    planSha256: input.plan.planSha256,
    split: input.plan.split,
    mode: input.plan.mode,
    pairedPredictions: predictions.filter(
      (prediction) =>
        prediction.recordType === "phase8-paired-calibration-prediction",
    ).length,
    pairedScores: scores.filter(
      (score) => score.recordType === "phase8-paired-calibration-score",
    ).length,
    pairedScoreSkips:
      input.plan.mode === "behavioral-comparison" ? scoreSkips.length : 0,
    oneArmPredictions: predictions.filter(
      (prediction) =>
        prediction.recordType ===
        "phase8-reference-one-arm-calibration-prediction",
    ).length,
    oneArmScores: scores.filter(
      (score) =>
        score.recordType === "phase8-reference-one-arm-calibration-score",
    ).length,
    oneArmScoreSkips:
      input.plan.mode === "reference-one-arm-confirmation"
        ? scoreSkips.length
        : 0,
    terminalRiskPredictions: terminalRiskPredictions.length,
    terminalRiskScores: terminalRiskScores.length,
    oneArmTerminalRiskPredictions: terminalRiskPredictions.filter(
      (prediction) =>
        prediction.recordType ===
        "phase8-reference-one-arm-terminal-risk-prediction",
    ).length,
    oneArmTerminalRiskScores: terminalRiskScores.filter(
      (score) =>
        score.recordType === "phase8-reference-one-arm-terminal-risk-score",
    ).length,
    observedStyleCells: observedStyleCells.size,
    observedStyleBaseClusters: observedClusters.size,
    primary,
    secondary,
    gates: {
      completePairing,
      scheduledClusterCoverage,
      minimumStyleBaseClusters,
      stressCellsIncluded,
      hardKnownExact,
      zeroRawLogicallyPossibleSupport,
      actionP2P3Separated,
      terminalRiskPresent,
      simultaneousCalibrationImprovement,
      evidenceEligible,
    },
  };
  return deepFreeze({
    ...withoutHash,
    summarySha256: phase8Sha256(summaryProjection(withoutHash)),
  });
}

export function verifyPhase8CalibrationSummary(
  summary: Phase8CalibrationSummary,
): true {
  const { summarySha256, ...projection } = summary;
  if (summarySha256 !== phase8Sha256(summaryProjection(projection))) {
    fail("summary checksum is invalid.");
  }
  const bootstrapRuntime: object = summary.primary.bootstrap;
  const runtimeResamples: unknown = Reflect.get(bootstrapRuntime, "resamples");
  const runtimeMethod: unknown = Reflect.get(bootstrapRuntime, "method");
  if (summary.mode === "behavioral-comparison") {
    if (
      summary.primary.mode !== "behavioral-comparison" ||
      summary.primary.contrastApplicability !== "applicable" ||
      summary.primary.behaviorBrier === null ||
      summary.primary.behaviorMinusHard === null ||
      runtimeResamples !== PHASE8_CALIBRATION_BOOTSTRAP_RESAMPLES ||
      runtimeMethod !== PHASE8_CALIBRATION_BOOTSTRAP_METHOD
    ) {
      fail("behavioral summary bootstrap contract drifted.");
    }
  } else if (
    summary.primary.mode !== "reference-one-arm-confirmation" ||
    summary.primary.contrastApplicability !== "not-applicable" ||
    summary.primary.behaviorBrier !== null ||
    summary.primary.behaviorMinusHard !== null ||
    summary.primary.clusterDifferences.some(
      (cluster) =>
        cluster.behaviorBrier !== null || cluster.difference !== null,
    ) ||
    runtimeResamples !== 0 ||
    runtimeMethod !== "not-applicable-reference-one-arm" ||
    summary.primary.bootstrap.contrasts.length !== 0 ||
    summary.primary.bootstrap.simultaneousImprovementGate !== null ||
    summary.gates.simultaneousCalibrationImprovement !== null
  ) {
    fail("one-arm summary fabricated or mislabeled a behavior contrast.");
  }
  return true;
}
