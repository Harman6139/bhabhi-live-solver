import { z } from "zod";

import { phase8Sha256 } from "../evaluation/phase8-manifest";
import {
  regularizeFeasibleSupport,
  type FeasibleSupportRegularization,
} from "./support-regularization";
import { validateDistribution, type ProbabilityEntry } from "./types";
import {
  PHASE8_CALIBRATION_PRIMARY_FAMILIES,
  verifyPhase8CalibrationPlan,
  type Phase8CalibrationFamily,
  type Phase8CalibrationPlan,
} from "./phase8-plan";

export const PHASE8_CALIBRATION_RECORD_SCHEMA_VERSION = 1 as const;

const identifierSchema = z.string().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const positiveIntegerSchema = z.int().positive();
const probabilitySchema = z.number().min(0).max(1);
const distributionEntrySchema = z
  .object({
    label: identifierSchema,
    probability: probabilitySchema,
  })
  .strict();
const distributionSchema = z
  .array(distributionEntrySchema)
  .min(1)
  .superRefine((distribution, context) => {
    const labels = new Set<string>();
    let sum = 0;
    for (const [index, entry] of distribution.entries()) {
      if (labels.has(entry.label)) {
        context.addIssue({
          code: "custom",
          path: [index, "label"],
          message: "Distribution labels must be unique.",
        });
      }
      labels.add(entry.label);
      sum += entry.probability;
      if (
        index > 0 &&
        (distribution[index - 1]?.label ?? "").localeCompare(entry.label) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "label"],
          message: "Distribution labels must use canonical ascending order.",
        });
      }
    }
    if (Math.abs(sum - 1) > 1e-12) {
      context.addIssue({
        code: "custom",
        message: "Distribution probabilities must sum to one.",
      });
    }
  });

const queryFamilySchema = z.enum(PHASE8_CALIBRATION_PRIMARY_FAMILIES);

const queryTargetSchema = z
  .object({
    kind: z.literal("query"),
    family: queryFamilySchema,
    labels: z.array(identifierSchema).min(1),
  })
  .strict();
const actionTargetSchema = z
  .object({
    kind: z.literal("opponent-action"),
    family: z.literal("opponent-action"),
    opponentSeat: z.enum(["p2", "p3"]),
    labels: z.array(identifierSchema).min(1),
  })
  .strict();
const targetSchema = z.discriminatedUnion("kind", [
  queryTargetSchema,
  actionTargetSchema,
]);

export type Phase8CalibrationTarget = z.infer<typeof targetSchema>;

const armForecastSchema = z
  .object({
    arm: z.enum(["hard-only", "behavioral"]),
    configId: identifierSchema,
    configSha256: sha256Schema,
    modelSha256: sha256Schema,
    sampledDistribution: distributionSchema,
    rawDistribution: distributionSchema,
    effectiveSampleSize: z.number().positive(),
    worldOccurrences: positiveIntegerSchema,
    uniqueWitnesses: positiveIntegerSchema,
    maximumWorldWeight: probabilitySchema,
    hardWorldSetHash: identifierSchema,
    modelBundleHash: identifierSchema,
    sampledZeroFeasibleLabels: z.array(identifierSchema),
    priorMassAdded: z.number().nonnegative(),
    distributionSha256: sha256Schema,
    forecastSha256: sha256Schema,
  })
  .strict();

export type Phase8CalibrationArmForecast = z.infer<typeof armForecastSchema>;

const supportDiagnosticsSchema = z
  .object({
    feasibleLabels: z.array(identifierSchema).min(1),
    hardKnown: z.boolean(),
    derivationHash: identifierSchema,
    supportSha256: sha256Schema,
    regularizerSha256: sha256Schema,
  })
  .strict();

export const phase8PairedPredictionRecordSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_CALIBRATION_RECORD_SCHEMA_VERSION),
    recordType: z.literal("phase8-paired-calibration-prediction"),
    planSha256: sha256Schema,
    manifestSha256: sha256Schema,
    split: z.enum(["qualification", "final"]),
    recordId: identifierSchema,
    styleCellId: identifierSchema,
    styleBaseClusterId: identifierSchema,
    gameId: identifierSchema,
    stateId: identifierSchema,
    queryId: identifierSchema,
    target: targetSchema,
    targetSha256: sha256Schema,
    support: supportDiagnosticsSchema,
    hard: armForecastSchema,
    behavior: armForecastSchema,
    recordSha256: sha256Schema,
  })
  .strict();

export type Phase8PairedPredictionRecord = z.infer<
  typeof phase8PairedPredictionRecordSchema
>;

export const phase8ReferenceOneArmPredictionRecordSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_CALIBRATION_RECORD_SCHEMA_VERSION),
    recordType: z.literal("phase8-reference-one-arm-calibration-prediction"),
    planSha256: sha256Schema,
    manifestSha256: sha256Schema,
    split: z.literal("final"),
    recordId: identifierSchema,
    styleCellId: identifierSchema,
    styleBaseClusterId: identifierSchema,
    gameId: identifierSchema,
    stateId: identifierSchema,
    queryId: identifierSchema,
    target: targetSchema,
    targetSha256: sha256Schema,
    support: supportDiagnosticsSchema,
    hard: armForecastSchema,
    recordSha256: sha256Schema,
  })
  .strict();

export type Phase8ReferenceOneArmPredictionRecord = z.infer<
  typeof phase8ReferenceOneArmPredictionRecordSchema
>;

export type Phase8CalibrationPredictionRecord =
  Phase8PairedPredictionRecord | Phase8ReferenceOneArmPredictionRecord;

export type Phase8CalibrationForecastInput = Readonly<{
  sampledDistribution: readonly ProbabilityEntry[];
  effectiveSampleSize: number;
  worldOccurrences: number;
  uniqueWitnesses: number;
  maximumWorldWeight: number;
  hardWorldSetHash: string;
  modelBundleHash: string;
}>;

function fail(message: string): never {
  throw new Error(`Phase 8 calibration record rejected: ${message}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function normalizeLabels(labels: readonly string[], label: string): string[] {
  if (
    labels.length === 0 ||
    labels.some((value) => value.length === 0) ||
    new Set(labels).size !== labels.length
  ) {
    fail(`${label} must be a non-empty unique label set.`);
  }
  return [...labels].sort(compareText);
}

function normalizeDistribution(
  distribution: readonly ProbabilityEntry[],
  targetLabels: readonly string[],
): ProbabilityEntry[] {
  const validated = validateDistribution(distribution);
  const normalized = [...validated].sort((left, right) =>
    compareText(left.label, right.label),
  );
  if (
    normalized.length !== targetLabels.length ||
    normalized.some((entry, index) => entry.label !== targetLabels[index])
  ) {
    fail("every arm distribution must contain exactly the target labels.");
  }
  return normalized;
}

function requireIdentifier(value: string, label: string): void {
  if (value.length === 0) {
    fail(`${label} must not be empty.`);
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer.`);
  }
}

function validateForecastInput(input: Phase8CalibrationForecastInput): void {
  if (
    !Number.isFinite(input.effectiveSampleSize) ||
    input.effectiveSampleSize <= 0
  ) {
    fail("effectiveSampleSize must be finite and positive.");
  }
  requirePositiveInteger(input.worldOccurrences, "worldOccurrences");
  requirePositiveInteger(input.uniqueWitnesses, "uniqueWitnesses");
  if (input.uniqueWitnesses > input.worldOccurrences) {
    fail("uniqueWitnesses cannot exceed worldOccurrences.");
  }
  if (
    !Number.isFinite(input.maximumWorldWeight) ||
    input.maximumWorldWeight < 0 ||
    input.maximumWorldWeight > 1
  ) {
    fail("maximumWorldWeight must be in [0, 1].");
  }
  requireIdentifier(input.hardWorldSetHash, "hardWorldSetHash");
  requireIdentifier(input.modelBundleHash, "modelBundleHash");
}

function hardDisabledModelSha256(): string {
  return phase8Sha256({
    schemaVersion: 1,
    behaviorWeighting: false,
    model: "hard-only-no-behavior-model",
  });
}

function forecastProjection(
  forecast: Omit<Phase8CalibrationArmForecast, "forecastSha256">,
): Omit<Phase8CalibrationArmForecast, "forecastSha256"> {
  return forecast;
}

function buildForecast(
  plan: Phase8CalibrationPlan,
  arm: "hard-only" | "behavioral",
  targetLabels: readonly string[],
  feasibleLabels: readonly string[],
  hardKnown: boolean,
  input: Phase8CalibrationForecastInput,
): Phase8CalibrationArmForecast {
  validateForecastInput(input);
  const sampledDistribution = normalizeDistribution(
    input.sampledDistribution,
    targetLabels,
  );
  let regularized: FeasibleSupportRegularization;
  try {
    regularized = regularizeFeasibleSupport({
      distribution: sampledDistribution,
      feasibleLabels,
      hardKnown,
      effectiveSampleSize: input.effectiveSampleSize,
      config: plan.supportRegularizer,
    });
  } catch (cause) {
    throw new Error(
      `Phase 8 calibration record rejected: ${arm} support regularization failed.`,
      { cause },
    );
  }
  const rawDistribution = normalizeDistribution(
    regularized.distribution,
    targetLabels,
  );
  const stillZero = feasibleLabels.filter(
    (label) =>
      rawDistribution.find((entry) => entry.label === label)?.probability === 0,
  );
  if (stillZero.length > 0) {
    fail(
      `${arm} assigns zero raw predictive support to hard-feasible labels: ${stillZero.join(", ")}.`,
    );
  }
  const configId =
    arm === "hard-only" ? plan.hardConfigId : plan.behaviorConfigId;
  const configSha256 =
    arm === "hard-only" ? plan.hardConfigSha256 : plan.behaviorConfigSha256;
  if (configId === null || configSha256 === null) {
    fail("a behavioral forecast cannot be built for a one-arm plan.");
  }
  const withoutHash = {
    arm,
    configId,
    configSha256,
    modelSha256:
      arm === "hard-only"
        ? hardDisabledModelSha256()
        : plan.selectedModelSerializedSha256,
    sampledDistribution,
    rawDistribution,
    effectiveSampleSize: input.effectiveSampleSize,
    worldOccurrences: input.worldOccurrences,
    uniqueWitnesses: input.uniqueWitnesses,
    maximumWorldWeight: input.maximumWorldWeight,
    hardWorldSetHash: input.hardWorldSetHash,
    modelBundleHash: input.modelBundleHash,
    sampledZeroFeasibleLabels: [...regularized.rawZeroFeasibleLabelsBefore],
    priorMassAdded: regularized.priorMassAdded,
    distributionSha256: phase8Sha256(rawDistribution),
  };
  return deepFreeze({
    ...withoutHash,
    forecastSha256: phase8Sha256(forecastProjection(withoutHash)),
  });
}

function recordProjection(
  record: Omit<Phase8PairedPredictionRecord, "recordSha256">,
): Omit<Phase8PairedPredictionRecord, "recordSha256"> {
  return record;
}

function validateHardKnown(
  record: Pick<Phase8PairedPredictionRecord, "support" | "hard" | "behavior">,
): void {
  const feasibleLabels = record.support.feasibleLabels;
  if (record.support.hardKnown !== (feasibleLabels.length === 1)) {
    fail("hardKnown must exactly match singleton hard-feasible support.");
  }
  if (!record.support.hardKnown) {
    return;
  }
  const knownLabel = feasibleLabels[0];
  if (knownLabel === undefined) {
    fail("hard-known support unexpectedly has no label.");
  }
  for (const forecast of [record.hard, record.behavior]) {
    for (const distribution of [
      forecast.sampledDistribution,
      forecast.rawDistribution,
    ]) {
      if (
        distribution.some(
          (entry) => entry.probability !== (entry.label === knownLabel ? 1 : 0),
        )
      ) {
        fail("hard-known facts must remain exact in both arms.");
      }
    }
  }
}

function validateArmForecast(
  forecast: Phase8CalibrationArmForecast,
  plan: Phase8CalibrationPlan | undefined,
): void {
  if (forecast.distributionSha256 !== phase8Sha256(forecast.rawDistribution)) {
    fail(`${forecast.arm} distribution checksum is invalid.`);
  }
  const { forecastSha256, ...projection } = forecast;
  if (forecastSha256 !== phase8Sha256(forecastProjection(projection))) {
    fail(`${forecast.arm} forecast checksum is invalid.`);
  }
  if (plan === undefined) {
    return;
  }
  const expected =
    forecast.arm === "hard-only"
      ? {
          configId: plan.hardConfigId,
          configSha256: plan.hardConfigSha256,
          modelSha256: hardDisabledModelSha256(),
        }
      : {
          configId: plan.behaviorConfigId,
          configSha256: plan.behaviorConfigSha256,
          modelSha256: plan.selectedModelSerializedSha256,
        };
  if (
    forecast.configId !== expected.configId ||
    forecast.configSha256 !== expected.configSha256 ||
    forecast.modelSha256 !== expected.modelSha256
  ) {
    fail(
      `${forecast.arm} does not match the frozen configuration/model binding.`,
    );
  }
}

export function validatePhase8PairedPredictionRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8PairedPredictionRecord {
  const parsed = phase8PairedPredictionRecordSchema.parse(value);
  if (plan !== undefined) {
    verifyPhase8CalibrationPlan(plan);
    if (plan.mode !== "behavioral-comparison") {
      fail("a paired prediction cannot be bound to a one-arm plan.");
    }
    if (
      parsed.planSha256 !== plan.planSha256 ||
      parsed.manifestSha256 !== plan.manifestSha256 ||
      parsed.split !== plan.split ||
      parsed.support.regularizerSha256 !== plan.supportRegularizerSha256 ||
      !plan.styleCellIds.includes(parsed.styleCellId)
    ) {
      fail("record provenance does not match the frozen calibration plan.");
    }
  }
  const normalizedTargetLabels = normalizeLabels(
    parsed.target.labels,
    "target labels",
  );
  if (
    parsed.target.labels.some(
      (label, index) => label !== normalizedTargetLabels[index],
    )
  ) {
    fail("target labels must use canonical ascending order.");
  }
  const feasibleLabels = normalizeLabels(
    parsed.support.feasibleLabels,
    "feasible labels",
  );
  if (feasibleLabels.some((label) => !normalizedTargetLabels.includes(label))) {
    fail("hard-feasible support contains a label outside the target.");
  }
  if (
    parsed.targetSha256 !== phase8Sha256(parsed.target) ||
    parsed.support.supportSha256 !==
      phase8Sha256({
        schemaVersion: 1,
        feasibleLabels,
        hardKnown: parsed.support.hardKnown,
        derivationHash: parsed.support.derivationHash,
      })
  ) {
    fail("target or hard-support checksum is invalid.");
  }
  validateArmForecast(parsed.hard, plan);
  validateArmForecast(parsed.behavior, plan);
  if (parsed.hard.arm !== "hard-only" || parsed.behavior.arm !== "behavioral") {
    fail("paired record arm identities are reversed or duplicated.");
  }
  validateHardKnown(parsed);
  for (const forecast of [parsed.hard, parsed.behavior]) {
    for (const label of feasibleLabels) {
      const probability = forecast.rawDistribution.find(
        (entry) => entry.label === label,
      )?.probability;
      if (probability === undefined || probability <= 0) {
        fail(
          `${forecast.arm} has zero raw support for hard-feasible label ${label}.`,
        );
      }
    }
  }
  const { recordSha256, ...projection } = parsed;
  if (recordSha256 !== phase8Sha256(recordProjection(projection))) {
    fail("paired prediction record checksum is invalid.");
  }
  return deepFreeze(parsed);
}

export function createPhase8PairedPredictionRecord(
  plan: Phase8CalibrationPlan,
  input: {
    readonly styleCellId: string;
    readonly styleBaseClusterId: string;
    readonly gameId: string;
    readonly stateId: string;
    readonly queryId: string;
    readonly target: Phase8CalibrationTarget;
    readonly feasibleLabels: readonly string[];
    readonly hardKnown: boolean;
    readonly supportDerivationHash: string;
    readonly hard: Phase8CalibrationForecastInput;
    readonly behavior: Phase8CalibrationForecastInput;
  },
): Phase8PairedPredictionRecord {
  verifyPhase8CalibrationPlan(plan);
  if (plan.mode !== "behavioral-comparison") {
    fail("a paired prediction cannot be created for a one-arm plan.");
  }
  for (const [value, label] of [
    [input.styleCellId, "styleCellId"],
    [input.styleBaseClusterId, "styleBaseClusterId"],
    [input.gameId, "gameId"],
    [input.stateId, "stateId"],
    [input.queryId, "queryId"],
    [input.supportDerivationHash, "supportDerivationHash"],
  ] as const) {
    requireIdentifier(value, label);
  }
  if (!plan.styleCellIds.includes(input.styleCellId)) {
    fail("styleCellId is outside the frozen plan.");
  }
  const parsedTarget = targetSchema.parse(input.target);
  const targetLabels = normalizeLabels(parsedTarget.labels, "target labels");
  const target: Phase8CalibrationTarget =
    parsedTarget.kind === "query"
      ? {
          kind: "query",
          family: parsedTarget.family,
          labels: targetLabels,
        }
      : {
          kind: "opponent-action",
          family: "opponent-action",
          opponentSeat: parsedTarget.opponentSeat,
          labels: targetLabels,
        };
  const feasibleLabels = normalizeLabels(
    input.feasibleLabels,
    "feasible labels",
  );
  if (feasibleLabels.some((label) => !targetLabels.includes(label))) {
    fail("hard-feasible support contains a label outside the target.");
  }
  if (input.hardKnown !== (feasibleLabels.length === 1)) {
    fail("hardKnown must exactly match singleton hard-feasible support.");
  }
  const supportProjection = {
    schemaVersion: 1 as const,
    feasibleLabels,
    hardKnown: input.hardKnown,
    derivationHash: input.supportDerivationHash,
  };
  const hard = buildForecast(
    plan,
    "hard-only",
    targetLabels,
    feasibleLabels,
    input.hardKnown,
    input.hard,
  );
  const behavior = buildForecast(
    plan,
    "behavioral",
    targetLabels,
    feasibleLabels,
    input.hardKnown,
    input.behavior,
  );
  const recordId = `phase8-calibration-prediction:${phase8Sha256({
    schemaVersion: 1,
    planSha256: plan.planSha256,
    styleBaseClusterId: input.styleBaseClusterId,
    gameId: input.gameId,
    stateId: input.stateId,
    queryId: input.queryId,
    target,
  })}`;
  const withoutHash = {
    schemaVersion: PHASE8_CALIBRATION_RECORD_SCHEMA_VERSION,
    recordType: "phase8-paired-calibration-prediction" as const,
    planSha256: plan.planSha256,
    manifestSha256: plan.manifestSha256,
    split: plan.split,
    recordId,
    styleCellId: input.styleCellId,
    styleBaseClusterId: input.styleBaseClusterId,
    gameId: input.gameId,
    stateId: input.stateId,
    queryId: input.queryId,
    target,
    targetSha256: phase8Sha256(target),
    support: {
      feasibleLabels,
      hardKnown: input.hardKnown,
      derivationHash: input.supportDerivationHash,
      supportSha256: phase8Sha256(supportProjection),
      regularizerSha256: plan.supportRegularizerSha256,
    },
    hard,
    behavior,
  };
  return validatePhase8PairedPredictionRecord(
    {
      ...withoutHash,
      recordSha256: phase8Sha256(recordProjection(withoutHash)),
    },
    plan,
  );
}

function oneArmRecordProjection(
  record: Omit<Phase8ReferenceOneArmPredictionRecord, "recordSha256">,
): Omit<Phase8ReferenceOneArmPredictionRecord, "recordSha256"> {
  return record;
}

export function validatePhase8ReferenceOneArmPredictionRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8ReferenceOneArmPredictionRecord {
  const parsed = phase8ReferenceOneArmPredictionRecordSchema.parse(value);
  if (plan !== undefined) {
    verifyPhase8CalibrationPlan(plan);
    if (
      plan.mode !== "reference-one-arm-confirmation" ||
      parsed.planSha256 !== plan.planSha256 ||
      parsed.manifestSha256 !== plan.manifestSha256 ||
      parsed.split !== plan.split ||
      parsed.support.regularizerSha256 !== plan.supportRegularizerSha256 ||
      !plan.styleCellIds.includes(parsed.styleCellId)
    ) {
      fail("one-arm record provenance does not match the frozen plan.");
    }
  }
  const normalizedTargetLabels = normalizeLabels(
    parsed.target.labels,
    "target labels",
  );
  if (
    parsed.target.labels.some(
      (label, index) => label !== normalizedTargetLabels[index],
    )
  ) {
    fail("target labels must use canonical ascending order.");
  }
  const feasibleLabels = normalizeLabels(
    parsed.support.feasibleLabels,
    "feasible labels",
  );
  if (feasibleLabels.some((label) => !normalizedTargetLabels.includes(label))) {
    fail("hard-feasible support contains a label outside the target.");
  }
  if (
    parsed.targetSha256 !== phase8Sha256(parsed.target) ||
    parsed.support.supportSha256 !==
      phase8Sha256({
        schemaVersion: 1,
        feasibleLabels,
        hardKnown: parsed.support.hardKnown,
        derivationHash: parsed.support.derivationHash,
      })
  ) {
    fail("target or hard-support checksum is invalid.");
  }
  validateArmForecast(parsed.hard, plan);
  if (parsed.hard.arm !== "hard-only") {
    fail("one-arm prediction must contain only the hard arm.");
  }
  if (parsed.support.hardKnown !== (feasibleLabels.length === 1)) {
    fail("hardKnown must exactly match singleton hard-feasible support.");
  }
  if (parsed.support.hardKnown) {
    const knownLabel =
      feasibleLabels[0] ?? fail("hard-known label is missing.");
    for (const distribution of [
      parsed.hard.sampledDistribution,
      parsed.hard.rawDistribution,
    ]) {
      if (
        distribution.some(
          (entry) => entry.probability !== (entry.label === knownLabel ? 1 : 0),
        )
      ) {
        fail("hard-known facts must remain exact in the hard arm.");
      }
    }
  }
  for (const label of feasibleLabels) {
    const probability = parsed.hard.rawDistribution.find(
      (entry) => entry.label === label,
    )?.probability;
    if (probability === undefined || probability <= 0) {
      fail(`hard-only has zero raw support for hard-feasible label ${label}.`);
    }
  }
  const { recordSha256, ...projection } = parsed;
  if (recordSha256 !== phase8Sha256(oneArmRecordProjection(projection))) {
    fail("one-arm prediction record checksum is invalid.");
  }
  return deepFreeze(parsed);
}

export function validatePhase8CalibrationPredictionRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8CalibrationPredictionRecord {
  if (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "recordType") ===
      "phase8-reference-one-arm-calibration-prediction"
  ) {
    return validatePhase8ReferenceOneArmPredictionRecord(value, plan);
  }
  return validatePhase8PairedPredictionRecord(value, plan);
}

export function createPhase8ReferenceOneArmPredictionRecord(
  plan: Phase8CalibrationPlan,
  input: {
    readonly styleCellId: string;
    readonly styleBaseClusterId: string;
    readonly gameId: string;
    readonly stateId: string;
    readonly queryId: string;
    readonly target: Phase8CalibrationTarget;
    readonly feasibleLabels: readonly string[];
    readonly hardKnown: boolean;
    readonly supportDerivationHash: string;
    readonly hard: Phase8CalibrationForecastInput;
  },
): Phase8ReferenceOneArmPredictionRecord {
  verifyPhase8CalibrationPlan(plan);
  if (plan.mode !== "reference-one-arm-confirmation") {
    fail("a one-arm prediction requires a reference-one-arm plan.");
  }
  for (const [value, label] of [
    [input.styleCellId, "styleCellId"],
    [input.styleBaseClusterId, "styleBaseClusterId"],
    [input.gameId, "gameId"],
    [input.stateId, "stateId"],
    [input.queryId, "queryId"],
    [input.supportDerivationHash, "supportDerivationHash"],
  ] as const) {
    requireIdentifier(value, label);
  }
  if (!plan.styleCellIds.includes(input.styleCellId)) {
    fail("styleCellId is outside the frozen plan.");
  }
  const parsedTarget = targetSchema.parse(input.target);
  const targetLabels = normalizeLabels(parsedTarget.labels, "target labels");
  const target: Phase8CalibrationTarget =
    parsedTarget.kind === "query"
      ? {
          kind: "query",
          family: parsedTarget.family,
          labels: targetLabels,
        }
      : {
          kind: "opponent-action",
          family: "opponent-action",
          opponentSeat: parsedTarget.opponentSeat,
          labels: targetLabels,
        };
  const feasibleLabels = normalizeLabels(
    input.feasibleLabels,
    "feasible labels",
  );
  if (feasibleLabels.some((label) => !targetLabels.includes(label))) {
    fail("hard-feasible support contains a label outside the target.");
  }
  if (input.hardKnown !== (feasibleLabels.length === 1)) {
    fail("hardKnown must exactly match singleton hard-feasible support.");
  }
  const supportProjection = {
    schemaVersion: 1 as const,
    feasibleLabels,
    hardKnown: input.hardKnown,
    derivationHash: input.supportDerivationHash,
  };
  const hard = buildForecast(
    plan,
    "hard-only",
    targetLabels,
    feasibleLabels,
    input.hardKnown,
    input.hard,
  );
  const recordId = `phase8-reference-one-arm-prediction:${phase8Sha256({
    schemaVersion: 1,
    planSha256: plan.planSha256,
    styleBaseClusterId: input.styleBaseClusterId,
    gameId: input.gameId,
    stateId: input.stateId,
    queryId: input.queryId,
    target,
  })}`;
  const withoutHash = {
    schemaVersion: PHASE8_CALIBRATION_RECORD_SCHEMA_VERSION,
    recordType: "phase8-reference-one-arm-calibration-prediction" as const,
    planSha256: plan.planSha256,
    manifestSha256: plan.manifestSha256,
    split: "final" as const,
    recordId,
    styleCellId: input.styleCellId,
    styleBaseClusterId: input.styleBaseClusterId,
    gameId: input.gameId,
    stateId: input.stateId,
    queryId: input.queryId,
    target,
    targetSha256: phase8Sha256(target),
    support: {
      feasibleLabels,
      hardKnown: input.hardKnown,
      derivationHash: input.supportDerivationHash,
      supportSha256: phase8Sha256(supportProjection),
      regularizerSha256: plan.supportRegularizerSha256,
    },
    hard,
  };
  return validatePhase8ReferenceOneArmPredictionRecord(
    {
      ...withoutHash,
      recordSha256: phase8Sha256(oneArmRecordProjection(withoutHash)),
    },
    plan,
  );
}

const terminalArmForecastBaseSchema = z
  .object({
    arm: z.enum(["hard-only", "behavioral"]),
    configId: identifierSchema,
    configSha256: sha256Schema,
    modelSha256: sha256Schema,
    probabilityBhabhi: probabilitySchema,
    interval95: z
      .object({
        lower: probabilitySchema,
        upper: probabilitySchema,
      })
      .strict(),
    effectiveSampleSize: z.number().positive(),
    forecastSha256: sha256Schema,
  })
  .strict();

const terminalArmForecastSchema = terminalArmForecastBaseSchema.superRefine(
  (forecast, context) => {
    if (
      forecast.interval95.lower > forecast.probabilityBhabhi ||
      forecast.interval95.upper < forecast.probabilityBhabhi
    ) {
      context.addIssue({
        code: "custom",
        path: ["interval95"],
        message: "The 95% interval must contain the point prediction.",
      });
    }
  },
);

export type Phase8TerminalRiskArmForecast = z.infer<
  typeof terminalArmForecastSchema
>;

export const phase8TerminalRiskPredictionRecordSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_CALIBRATION_RECORD_SCHEMA_VERSION),
    recordType: z.literal("phase8-terminal-risk-prediction"),
    planSha256: sha256Schema,
    manifestSha256: sha256Schema,
    split: z.enum(["qualification", "final"]),
    recordId: identifierSchema,
    styleCellId: identifierSchema,
    styleBaseClusterId: identifierSchema,
    gameId: identifierSchema,
    stateId: identifierSchema,
    queryId: identifierSchema,
    actionKey: identifierSchema,
    hard: terminalArmForecastSchema,
    behavior: terminalArmForecastSchema,
    recordSha256: sha256Schema,
  })
  .strict();

export type Phase8TerminalRiskPredictionRecord = z.infer<
  typeof phase8TerminalRiskPredictionRecordSchema
>;

export const phase8ReferenceOneArmTerminalRiskPredictionRecordSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_CALIBRATION_RECORD_SCHEMA_VERSION),
    recordType: z.literal("phase8-reference-one-arm-terminal-risk-prediction"),
    planSha256: sha256Schema,
    manifestSha256: sha256Schema,
    split: z.literal("final"),
    recordId: identifierSchema,
    styleCellId: identifierSchema,
    styleBaseClusterId: identifierSchema,
    gameId: identifierSchema,
    stateId: identifierSchema,
    queryId: identifierSchema,
    actionKey: identifierSchema,
    hard: terminalArmForecastSchema,
    recordSha256: sha256Schema,
  })
  .strict();

export type Phase8ReferenceOneArmTerminalRiskPredictionRecord = z.infer<
  typeof phase8ReferenceOneArmTerminalRiskPredictionRecordSchema
>;

export type Phase8CalibrationTerminalRiskPredictionRecord =
  | Phase8TerminalRiskPredictionRecord
  | Phase8ReferenceOneArmTerminalRiskPredictionRecord;

export type Phase8TerminalRiskForecastInput = Readonly<{
  probabilityBhabhi: number;
  interval95: Readonly<{ lower: number; upper: number }>;
  effectiveSampleSize: number;
}>;

function terminalForecastProjection(
  forecast: Omit<Phase8TerminalRiskArmForecast, "forecastSha256">,
): Omit<Phase8TerminalRiskArmForecast, "forecastSha256"> {
  return forecast;
}

function buildTerminalForecast(
  plan: Phase8CalibrationPlan,
  arm: "hard-only" | "behavioral",
  input: Phase8TerminalRiskForecastInput,
): Phase8TerminalRiskArmForecast {
  const configId =
    arm === "hard-only" ? plan.hardConfigId : plan.behaviorConfigId;
  const configSha256 =
    arm === "hard-only" ? plan.hardConfigSha256 : plan.behaviorConfigSha256;
  if (configId === null || configSha256 === null) {
    fail("a behavioral terminal forecast cannot be built for a one-arm plan.");
  }
  const withoutHash = terminalArmForecastBaseSchema
    .omit({ forecastSha256: true })
    .parse({
      arm,
      configId,
      configSha256,
      modelSha256:
        arm === "hard-only"
          ? hardDisabledModelSha256()
          : plan.selectedModelSerializedSha256,
      probabilityBhabhi: input.probabilityBhabhi,
      interval95: input.interval95,
      effectiveSampleSize: input.effectiveSampleSize,
    });
  return deepFreeze({
    ...withoutHash,
    forecastSha256: phase8Sha256(terminalForecastProjection(withoutHash)),
  });
}

function terminalRecordProjection(
  record: Omit<Phase8TerminalRiskPredictionRecord, "recordSha256">,
): Omit<Phase8TerminalRiskPredictionRecord, "recordSha256"> {
  return record;
}

export function validatePhase8TerminalRiskPredictionRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8TerminalRiskPredictionRecord {
  const parsed = phase8TerminalRiskPredictionRecordSchema.parse(value);
  if (plan !== undefined) {
    verifyPhase8CalibrationPlan(plan);
    if (
      plan.mode !== "behavioral-comparison" ||
      parsed.planSha256 !== plan.planSha256 ||
      parsed.manifestSha256 !== plan.manifestSha256 ||
      parsed.split !== plan.split ||
      !plan.styleCellIds.includes(parsed.styleCellId)
    ) {
      fail("terminal-risk provenance does not match the frozen plan.");
    }
  }
  for (const forecast of [parsed.hard, parsed.behavior]) {
    const { forecastSha256, ...projection } = forecast;
    if (
      forecastSha256 !== phase8Sha256(terminalForecastProjection(projection))
    ) {
      fail(`${forecast.arm} terminal-risk forecast checksum is invalid.`);
    }
    if (plan !== undefined) {
      const expected =
        forecast.arm === "hard-only"
          ? [
              plan.hardConfigId,
              plan.hardConfigSha256,
              hardDisabledModelSha256(),
            ]
          : [
              plan.behaviorConfigId,
              plan.behaviorConfigSha256,
              plan.selectedModelSerializedSha256,
            ];
      if (
        forecast.configId !== expected[0] ||
        forecast.configSha256 !== expected[1] ||
        forecast.modelSha256 !== expected[2]
      ) {
        fail(`${forecast.arm} terminal-risk binding is stale.`);
      }
    }
  }
  if (parsed.hard.arm !== "hard-only" || parsed.behavior.arm !== "behavioral") {
    fail("terminal-risk paired arm identities are invalid.");
  }
  const { recordSha256, ...projection } = parsed;
  if (recordSha256 !== phase8Sha256(terminalRecordProjection(projection))) {
    fail("terminal-risk record checksum is invalid.");
  }
  return deepFreeze(parsed);
}

export function createPhase8TerminalRiskPredictionRecord(
  plan: Phase8CalibrationPlan,
  input: {
    readonly styleCellId: string;
    readonly styleBaseClusterId: string;
    readonly gameId: string;
    readonly stateId: string;
    readonly queryId: string;
    readonly actionKey: string;
    readonly hard: Phase8TerminalRiskForecastInput;
    readonly behavior: Phase8TerminalRiskForecastInput;
  },
): Phase8TerminalRiskPredictionRecord {
  verifyPhase8CalibrationPlan(plan);
  if (plan.mode !== "behavioral-comparison") {
    fail("paired terminal risk cannot be created for a one-arm plan.");
  }
  for (const [value, label] of [
    [input.styleCellId, "styleCellId"],
    [input.styleBaseClusterId, "styleBaseClusterId"],
    [input.gameId, "gameId"],
    [input.stateId, "stateId"],
    [input.queryId, "queryId"],
    [input.actionKey, "actionKey"],
  ] as const) {
    requireIdentifier(value, label);
  }
  if (!plan.styleCellIds.includes(input.styleCellId)) {
    fail("terminal-risk style cell is outside the frozen plan.");
  }
  const hard = buildTerminalForecast(plan, "hard-only", input.hard);
  const behavior = buildTerminalForecast(plan, "behavioral", input.behavior);
  const recordId = `phase8-terminal-risk:${phase8Sha256({
    schemaVersion: 1,
    planSha256: plan.planSha256,
    gameId: input.gameId,
    stateId: input.stateId,
    queryId: input.queryId,
    actionKey: input.actionKey,
  })}`;
  const withoutHash = {
    schemaVersion: PHASE8_CALIBRATION_RECORD_SCHEMA_VERSION,
    recordType: "phase8-terminal-risk-prediction" as const,
    planSha256: plan.planSha256,
    manifestSha256: plan.manifestSha256,
    split: plan.split,
    recordId,
    styleCellId: input.styleCellId,
    styleBaseClusterId: input.styleBaseClusterId,
    gameId: input.gameId,
    stateId: input.stateId,
    queryId: input.queryId,
    actionKey: input.actionKey,
    hard,
    behavior,
  };
  return validatePhase8TerminalRiskPredictionRecord(
    {
      ...withoutHash,
      recordSha256: phase8Sha256(terminalRecordProjection(withoutHash)),
    },
    plan,
  );
}

function oneArmTerminalRecordProjection(
  record: Omit<
    Phase8ReferenceOneArmTerminalRiskPredictionRecord,
    "recordSha256"
  >,
): Omit<Phase8ReferenceOneArmTerminalRiskPredictionRecord, "recordSha256"> {
  return record;
}

export function validatePhase8ReferenceOneArmTerminalRiskPredictionRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8ReferenceOneArmTerminalRiskPredictionRecord {
  const parsed =
    phase8ReferenceOneArmTerminalRiskPredictionRecordSchema.parse(value);
  if (plan !== undefined) {
    verifyPhase8CalibrationPlan(plan);
    if (
      plan.mode !== "reference-one-arm-confirmation" ||
      parsed.planSha256 !== plan.planSha256 ||
      parsed.manifestSha256 !== plan.manifestSha256 ||
      parsed.split !== plan.split ||
      !plan.styleCellIds.includes(parsed.styleCellId)
    ) {
      fail("one-arm terminal-risk provenance does not match the frozen plan.");
    }
  }
  const { forecastSha256, ...forecastProjection } = parsed.hard;
  if (
    parsed.hard.arm !== "hard-only" ||
    forecastSha256 !==
      phase8Sha256(terminalForecastProjection(forecastProjection))
  ) {
    fail("one-arm terminal-risk hard forecast is invalid.");
  }
  if (
    plan !== undefined &&
    (parsed.hard.configId !== plan.hardConfigId ||
      parsed.hard.configSha256 !== plan.hardConfigSha256 ||
      parsed.hard.modelSha256 !== hardDisabledModelSha256())
  ) {
    fail("one-arm terminal-risk hard binding is stale.");
  }
  const { recordSha256, ...projection } = parsed;
  if (
    recordSha256 !== phase8Sha256(oneArmTerminalRecordProjection(projection))
  ) {
    fail("one-arm terminal-risk record checksum is invalid.");
  }
  return deepFreeze(parsed);
}

export function validatePhase8CalibrationTerminalRiskPredictionRecord(
  value: unknown,
  plan?: Phase8CalibrationPlan,
): Phase8CalibrationTerminalRiskPredictionRecord {
  if (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "recordType") ===
      "phase8-reference-one-arm-terminal-risk-prediction"
  ) {
    return validatePhase8ReferenceOneArmTerminalRiskPredictionRecord(
      value,
      plan,
    );
  }
  return validatePhase8TerminalRiskPredictionRecord(value, plan);
}

export function createPhase8ReferenceOneArmTerminalRiskPredictionRecord(
  plan: Phase8CalibrationPlan,
  input: {
    readonly styleCellId: string;
    readonly styleBaseClusterId: string;
    readonly gameId: string;
    readonly stateId: string;
    readonly queryId: string;
    readonly actionKey: string;
    readonly hard: Phase8TerminalRiskForecastInput;
  },
): Phase8ReferenceOneArmTerminalRiskPredictionRecord {
  verifyPhase8CalibrationPlan(plan);
  if (plan.mode !== "reference-one-arm-confirmation") {
    fail("one-arm terminal risk requires a reference-one-arm plan.");
  }
  for (const [value, label] of [
    [input.styleCellId, "styleCellId"],
    [input.styleBaseClusterId, "styleBaseClusterId"],
    [input.gameId, "gameId"],
    [input.stateId, "stateId"],
    [input.queryId, "queryId"],
    [input.actionKey, "actionKey"],
  ] as const) {
    requireIdentifier(value, label);
  }
  if (!plan.styleCellIds.includes(input.styleCellId)) {
    fail("terminal-risk style cell is outside the frozen plan.");
  }
  const hard = buildTerminalForecast(plan, "hard-only", input.hard);
  const recordId = `phase8-reference-one-arm-terminal-risk:${phase8Sha256({
    schemaVersion: 1,
    planSha256: plan.planSha256,
    gameId: input.gameId,
    stateId: input.stateId,
    queryId: input.queryId,
    actionKey: input.actionKey,
  })}`;
  const withoutHash = {
    schemaVersion: PHASE8_CALIBRATION_RECORD_SCHEMA_VERSION,
    recordType: "phase8-reference-one-arm-terminal-risk-prediction" as const,
    planSha256: plan.planSha256,
    manifestSha256: plan.manifestSha256,
    split: "final" as const,
    recordId,
    styleCellId: input.styleCellId,
    styleBaseClusterId: input.styleBaseClusterId,
    gameId: input.gameId,
    stateId: input.stateId,
    queryId: input.queryId,
    actionKey: input.actionKey,
    hard,
  };
  return validatePhase8ReferenceOneArmTerminalRiskPredictionRecord(
    {
      ...withoutHash,
      recordSha256: phase8Sha256(oneArmTerminalRecordProjection(withoutHash)),
    },
    plan,
  );
}

export function phase8CalibrationRecordFamily(
  record:
    | Phase8CalibrationPredictionRecord
    | Phase8CalibrationTerminalRiskPredictionRecord,
): Phase8CalibrationFamily {
  return record.recordType === "phase8-terminal-risk-prediction" ||
    record.recordType === "phase8-reference-one-arm-terminal-risk-prediction"
    ? "terminal-risk"
    : record.target.family;
}
