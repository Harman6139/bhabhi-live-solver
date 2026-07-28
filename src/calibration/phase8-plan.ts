import { createHash } from "node:crypto";

import {
  PHASE8_BOOTSTRAP_RESAMPLES,
  PHASE8_MANIFEST_VERSION,
  PHASE8_ROTATIONS,
  deriveOpenedPhase8Seed,
  phase8Sha256,
  verifyPhase8ManifestAuthority,
  type FrozenPhase8ManifestAuthority,
  type Phase8ConfirmatorySplit,
  type Phase8Json,
  type Phase8SplitOpening,
  type Phase8SplitPlan,
} from "../evaluation/phase8-manifest";
import {
  PHASE8_FINAL_MANIFEST_VERSION,
  deriveOpenedPhase8FinalSeed,
  verifyPhase8FinalManifestAuthority,
  type FrozenPhase8FinalManifestAuthority,
  type Phase8FinalSplitOpening,
} from "../evaluation/phase8-final-manifest";
import {
  FEASIBLE_SUPPORT_REGULARIZER_VERSION,
  type FeasibleSupportRegularizerConfig,
} from "./support-regularization";

export const PHASE8_CALIBRATION_PLAN_VERSION =
  "phase8-clean-calibration-v1" as const;
export const PHASE8_CALIBRATION_MINIMUM_BASES = 64 as const;
export const PHASE8_CALIBRATION_MINIMUM_STYLE_BASE_CLUSTERS = 1_000 as const;
export const PHASE8_CALIBRATION_PRIMARY_FAMILIES = [
  "card-owner",
  "current-void",
  "suit-length",
  "can-overtake",
  "joint",
  "conditional",
] as const;
export const PHASE8_CALIBRATION_PREDICTION_FAMILIES = [
  ...PHASE8_CALIBRATION_PRIMARY_FAMILIES,
  "opponent-action",
] as const;
export const PHASE8_CALIBRATION_ALL_FAMILIES = [
  ...PHASE8_CALIBRATION_PREDICTION_FAMILIES,
  "terminal-risk",
] as const;
export const PHASE8_CALIBRATION_STRESS_CELL_IDS = [
  "c16_noisy-mixture__phase-switch",
  "c17_phase-switch__noisy-mixture",
] as const;

export type Phase8CalibrationPrimaryFamily =
  (typeof PHASE8_CALIBRATION_PRIMARY_FAMILIES)[number];
export type Phase8CalibrationPredictionFamily =
  (typeof PHASE8_CALIBRATION_PREDICTION_FAMILIES)[number];
export type Phase8CalibrationFamily =
  (typeof PHASE8_CALIBRATION_ALL_FAMILIES)[number];
export type Phase8CalibrationMode =
  "behavioral-comparison" | "reference-one-arm-confirmation";
export type Phase8CalibrationManifestAuthority =
  FrozenPhase8ManifestAuthority | FrozenPhase8FinalManifestAuthority;
export type Phase8CalibrationSplitOpening =
  Phase8SplitOpening | Phase8FinalSplitOpening;

const PHASE8_CALIBRATION_PLAN_AUTHORITY = Symbol(
  "phase8-calibration-plan-authority",
);

export type Phase8CalibrationPlan = Readonly<{
  schemaVersion: 1;
  planVersion: typeof PHASE8_CALIBRATION_PLAN_VERSION;
  protocolId: "eval-v1";
  runId: string;
  mode: Phase8CalibrationMode;
  evidenceClass: "phase8-clean-calibration";
  evidenceEligible: true;
  manifestId: string;
  manifestSha256: string;
  split: Phase8ConfirmatorySplit;
  splitOpeningSha256: string;
  splitPlanSha256: string;
  baseIndexStart: number;
  baseCount: number;
  rotations: readonly [0, 1, 2];
  replicate: 0;
  styleCellIds: readonly string[];
  stressCellIds: typeof PHASE8_CALIBRATION_STRESS_CELL_IDS;
  scheduledStyleBaseClusters: number;
  scheduledGames: number;
  hardConfigId: string;
  hardConfigSha256: string;
  behaviorConfigId: string | null;
  behaviorConfigSha256: string | null;
  selectionIsReference: boolean | null;
  configurationRegistrySha256: string;
  selectedModelSerializedSha256: string;
  selectedModelSerializedBytes: number;
  supportRegularizerVersion: typeof FEASIBLE_SUPPORT_REGULARIZER_VERSION;
  supportRegularizer: FeasibleSupportRegularizerConfig;
  supportRegularizerSha256: string;
  sourceSha256: string;
  scorerSha256: string;
  queryPlanId: string;
  queryPlanSha256: string;
  reportSha256: string;
  preregistrationSha256: string;
  primaryEndpoint: Readonly<{
    endpointId: "equal-family-unresolved-soft-brier-v1";
    families: typeof PHASE8_CALIBRATION_PRIMARY_FAMILIES;
    exclusions: readonly ["hard-known", "opponent-action-is-secondary"];
    nesting: readonly [
      "queries-within-state",
      "states-within-game",
      "rotated-games-within-style-base-cluster",
      "equal-families-within-cluster",
      "equal-style-base-clusters",
    ];
    contrast: "behavior-minus-hard" | "not-applicable-reference-one-arm";
    improvementThreshold: 0;
  }>;
  secondaryMetrics: readonly [
    "brier",
    "log-loss",
    "reliability-10-fixed-bins",
    "predictive-set-coverage-50-80-95",
    "opponent-action-p2-p3",
    "terminal-risk-brier-log-loss",
  ];
  bootstrap:
    | Readonly<{
        method: "paired-style-base-cluster-max-statistic-v1";
        confidenceLevel: 0.95;
        resamples: typeof PHASE8_BOOTSTRAP_RESAMPLES;
        seed: string;
      }>
    | Readonly<{
        method: "not-applicable-reference-one-arm";
        confidenceLevel: null;
        resamples: 0;
        seed: null;
      }>;
  planSha256: string;
  [PHASE8_CALIBRATION_PLAN_AUTHORITY]: true;
}>;

export type Phase8CalibrationPlanRecord = Omit<
  Phase8CalibrationPlan,
  typeof PHASE8_CALIBRATION_PLAN_AUTHORITY
>;

export type Phase8CalibrationScheduleRecord = Readonly<{
  schemaVersion: 1;
  recordType: "phase8-calibration-schedule";
  planSha256: string;
  split: Phase8ConfirmatorySplit;
  scheduleIndex: number;
  styleCellId: string;
  baseIndex: number;
  rotation: 0 | 1 | 2;
  replicate: 0;
  styleBaseClusterId: string;
  gameId: string;
  seeds: Readonly<{
    deal: string;
    p2Policy: string;
    p3Policy: string;
    chance: string;
    belief: string;
  }>;
  recordSha256: string;
}>;

function fail(message: string): never {
  throw new Error(`Phase 8 calibration plan rejected: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function byteSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{2,119}$/u.test(value)) {
    fail(`${label} must be a filesystem-safe lowercase identifier.`);
  }
}

function phase8CalibrationPlanProjection(
  plan: Omit<Phase8CalibrationPlanRecord, "planSha256">,
): Omit<Phase8CalibrationPlanRecord, "planSha256"> {
  return plan;
}

export function phase8CalibrationPlanSha256(
  plan: Omit<Phase8CalibrationPlanRecord, "planSha256">,
): string {
  return phase8Sha256(phase8CalibrationPlanProjection(plan));
}

function hasPlanAuthority(value: unknown): value is Phase8CalibrationPlan {
  return (
    isRecord(value) &&
    Reflect.get(value, PHASE8_CALIBRATION_PLAN_AUTHORITY) === true
  );
}

export function verifyPhase8CalibrationPlan(plan: Phase8CalibrationPlan): true {
  if (!hasPlanAuthority(plan) || !Object.isFrozen(plan)) {
    fail("a genuine frozen calibration-plan authority is required.");
  }
  const { planSha256, ...projection } = plan;
  if (planSha256 !== phase8CalibrationPlanSha256(projection)) {
    fail("plan checksum does not match its canonical projection.");
  }
  if (
    plan.baseCount < PHASE8_CALIBRATION_MINIMUM_BASES ||
    plan.scheduledStyleBaseClusters <
      PHASE8_CALIBRATION_MINIMUM_STYLE_BASE_CLUSTERS ||
    plan.scheduledStyleBaseClusters !==
      plan.baseCount * plan.styleCellIds.length ||
    plan.scheduledGames !==
      plan.scheduledStyleBaseClusters * plan.rotations.length
  ) {
    fail("the evidence-eligible schedule is undersized or inconsistent.");
  }
  if (
    PHASE8_CALIBRATION_STRESS_CELL_IDS.some(
      (cellId) => !plan.styleCellIds.includes(cellId),
    )
  ) {
    fail("the two preregistered stress cells must remain scheduled.");
  }
  if (
    plan.supportRegularizer.pseudocountPerFeasibleLabel <= 0 ||
    !Number.isFinite(plan.supportRegularizer.pseudocountPerFeasibleLabel)
  ) {
    fail("clean evidence requires a positive finite support pseudocount.");
  }
  if (
    (plan.mode === "behavioral-comparison" &&
      (plan.behaviorConfigId === null ||
        plan.behaviorConfigSha256 === null ||
        plan.primaryEndpoint.contrast !== "behavior-minus-hard" ||
        plan.bootstrap.method !==
          "paired-style-base-cluster-max-statistic-v1" ||
        plan.selectionIsReference === true)) ||
    (plan.mode === "reference-one-arm-confirmation" &&
      (plan.split !== "final" ||
        plan.behaviorConfigId !== null ||
        plan.behaviorConfigSha256 !== null ||
        plan.selectionIsReference !== true ||
        plan.primaryEndpoint.contrast !== "not-applicable-reference-one-arm" ||
        plan.bootstrap.method !== "not-applicable-reference-one-arm"))
  ) {
    fail("calibration mode, arms, and selection binding are inconsistent.");
  }
  return true;
}

function validateOpeningWithoutExposingSchedule(
  authority: Phase8CalibrationManifestAuthority,
  opening: Phase8CalibrationSplitOpening,
): string {
  const split = opening.split;
  if (split === "final") {
    return deriveOpenedPhase8FinalSeed(
      authority as FrozenPhase8FinalManifestAuthority,
      opening,
      {
        stream: "bootstrap",
        styleCellId:
          (authority as FrozenPhase8FinalManifestAuthority).manifest.split
            .styleCellIds[0] ?? fail("final style suite is empty."),
        baseIndex: (authority as FrozenPhase8FinalManifestAuthority).manifest
          .split.baseIndexStart,
        rotation: 0,
        replicate: 0,
      },
    );
  }
  if (split !== "qualification") {
    fail("only qualification or final may produce clean calibration evidence.");
  }
  const qualificationAuthority = authority as FrozenPhase8ManifestAuthority;
  const splitPlan = qualificationAuthority.manifest.splits.qualification;
  const firstStyleCellId = splitPlan.styleCellIds[0];
  if (firstStyleCellId === undefined) {
    fail("the opened split has no calibration coordinates.");
  }
  return deriveOpenedPhase8Seed(qualificationAuthority, opening, {
    stream: "bootstrap",
    styleCellId: firstStyleCellId,
    baseIndex: splitPlan.baseIndexStart,
    rotation: 0,
    replicate: 0,
  });
}

export function createPhase8CalibrationPlan(input: {
  readonly authority: Phase8CalibrationManifestAuthority;
  readonly opening: Phase8CalibrationSplitOpening;
  readonly runId: string;
  readonly mode?: Phase8CalibrationMode;
  readonly hardConfigId: string;
  readonly behaviorConfigId?: string;
  readonly selectedModelSerialized: string;
  readonly supportRegularizer: FeasibleSupportRegularizerConfig;
  readonly queryPlanId: string;
  readonly queryPlan: Phase8Json;
}): Phase8CalibrationPlan {
  requireIdentifier(input.runId, "runId");
  requireIdentifier(input.queryPlanId, "queryPlanId");
  if (input.selectedModelSerialized.length === 0) {
    fail("the selected serialized model must not be empty.");
  }
  if (
    !Number.isFinite(input.supportRegularizer.pseudocountPerFeasibleLabel) ||
    input.supportRegularizer.pseudocountPerFeasibleLabel <= 0
  ) {
    fail(
      "the evidence support regularizer requires a positive finite pseudocount.",
    );
  }

  const mode = input.mode ?? "behavioral-comparison";
  const split = input.opening.split;
  let manifest:
    | FrozenPhase8ManifestAuthority["manifest"]
    | FrozenPhase8FinalManifestAuthority["manifest"];
  let manifestSha256: string;
  let splitPlan: Phase8SplitPlan;
  let selectionIsReference: boolean | null = null;
  if (split === "final") {
    const authority = input.authority as FrozenPhase8FinalManifestAuthority;
    verifyPhase8FinalManifestAuthority(authority);
    manifest = authority.manifest;
    manifestSha256 = authority.manifestSha256;
    splitPlan = authority.manifest.split;
    selectionIsReference = authority.manifest.selection.selectionIsReference;
  } else {
    if (split !== "qualification") {
      fail(
        "only qualification or final may produce clean calibration evidence.",
      );
    }
    const authority = input.authority as FrozenPhase8ManifestAuthority;
    verifyPhase8ManifestAuthority(authority);
    manifest = authority.manifest;
    manifestSha256 = authority.manifestSha256;
    splitPlan = authority.manifest.splits.qualification;
  }
  if (
    (mode === "reference-one-arm-confirmation" &&
      (split !== "final" || selectionIsReference !== true)) ||
    (mode === "behavioral-comparison" && selectionIsReference === true)
  ) {
    fail(
      "reference-one-arm mode is required exactly for a reference-selected final.",
    );
  }
  const bootstrapSeed = validateOpeningWithoutExposingSchedule(
    input.authority,
    input.opening,
  );
  if (
    splitPlan.baseCount < PHASE8_CALIBRATION_MINIMUM_BASES ||
    splitPlan.styleCellIds.length !== 17
  ) {
    fail("the opened manifest split is not the complete calibration matrix.");
  }
  if (
    PHASE8_CALIBRATION_STRESS_CELL_IDS.some(
      (cellId) => !splitPlan.styleCellIds.includes(cellId),
    )
  ) {
    fail("the opened manifest omits a preregistered stress cell.");
  }

  const hardConfiguration = manifest.configurations.find(
    (configuration) => configuration.configId === input.hardConfigId,
  );
  if (
    hardConfiguration === undefined ||
    hardConfiguration.components.behaviorWeighting
  ) {
    fail("the hard calibration configuration must be behavior-off.");
  }
  const behaviorConfiguration =
    input.behaviorConfigId === undefined
      ? null
      : (manifest.configurations.find(
          (configuration) => configuration.configId === input.behaviorConfigId,
        ) ?? null);
  if (mode === "behavioral-comparison") {
    if (
      behaviorConfiguration === null ||
      hardConfiguration.configId === behaviorConfiguration.configId ||
      !behaviorConfiguration.components.behaviorWeighting
    ) {
      fail(
        "behavioral comparison requires distinct behavior-off hard and behavior-on configurations.",
      );
    }
  } else if (
    input.behaviorConfigId !== undefined ||
    behaviorConfiguration !== null ||
    manifest.configurations.length !== 1 ||
    hardConfiguration.role !== "reference" ||
    (split === "final" &&
      (manifest as FrozenPhase8FinalManifestAuthority["manifest"]).selection
        .selectedConfigId !== hardConfiguration.configId)
  ) {
    fail(
      "reference one-arm confirmation requires the sole selected reference configuration and no behavior arm.",
    );
  }

  const selectedModelSerializedSha256 = byteSha256(
    input.selectedModelSerialized,
  );
  if (selectedModelSerializedSha256 !== manifest.hashes.modelSha256) {
    fail(
      "the selected serialized model does not match the manifest model hash.",
    );
  }
  const scheduledStyleBaseClusters =
    splitPlan.baseCount * splitPlan.styleCellIds.length;
  if (
    scheduledStyleBaseClusters < PHASE8_CALIBRATION_MINIMUM_STYLE_BASE_CLUSTERS
  ) {
    fail("the opened split schedules fewer than 1,000 style-base clusters.");
  }
  const supportRegularizerSha256 = phase8Sha256({
    schemaVersion: 1,
    algorithmVersion: FEASIBLE_SUPPORT_REGULARIZER_VERSION,
    config: input.supportRegularizer,
  });

  const withoutHash = {
    schemaVersion: 1 as const,
    planVersion: PHASE8_CALIBRATION_PLAN_VERSION,
    protocolId: "eval-v1" as const,
    runId: input.runId,
    mode,
    evidenceClass: "phase8-clean-calibration" as const,
    evidenceEligible: true as const,
    manifestId: manifest.manifestId,
    manifestSha256,
    split,
    splitOpeningSha256: input.opening.openingSha256,
    splitPlanSha256: input.opening.splitPlanSha256,
    baseIndexStart: splitPlan.baseIndexStart,
    baseCount: splitPlan.baseCount,
    rotations: [0, 1, 2] as const,
    replicate: 0 as const,
    styleCellIds: [...splitPlan.styleCellIds],
    stressCellIds: PHASE8_CALIBRATION_STRESS_CELL_IDS,
    scheduledStyleBaseClusters,
    scheduledGames: scheduledStyleBaseClusters * PHASE8_ROTATIONS.length,
    hardConfigId: hardConfiguration.configId,
    hardConfigSha256: hardConfiguration.configSha256,
    behaviorConfigId: behaviorConfiguration?.configId ?? null,
    behaviorConfigSha256: behaviorConfiguration?.configSha256 ?? null,
    selectionIsReference,
    configurationRegistrySha256: manifest.hashes.configSha256,
    selectedModelSerializedSha256,
    selectedModelSerializedBytes: Buffer.byteLength(
      input.selectedModelSerialized,
      "utf8",
    ),
    supportRegularizerVersion: FEASIBLE_SUPPORT_REGULARIZER_VERSION,
    supportRegularizer: {
      pseudocountPerFeasibleLabel:
        input.supportRegularizer.pseudocountPerFeasibleLabel,
    },
    supportRegularizerSha256,
    sourceSha256: manifest.hashes.sourceSha256,
    scorerSha256: manifest.hashes.scorerSha256,
    queryPlanId: input.queryPlanId,
    queryPlanSha256: phase8Sha256(input.queryPlan),
    reportSha256: manifest.hashes.reportSha256,
    preregistrationSha256: manifest.hashes.preregistrationSha256,
    primaryEndpoint: {
      endpointId: "equal-family-unresolved-soft-brier-v1" as const,
      families: PHASE8_CALIBRATION_PRIMARY_FAMILIES,
      exclusions: ["hard-known", "opponent-action-is-secondary"] as const,
      nesting: [
        "queries-within-state",
        "states-within-game",
        "rotated-games-within-style-base-cluster",
        "equal-families-within-cluster",
        "equal-style-base-clusters",
      ] as const,
      contrast:
        mode === "behavioral-comparison"
          ? ("behavior-minus-hard" as const)
          : ("not-applicable-reference-one-arm" as const),
      improvementThreshold: 0 as const,
    },
    secondaryMetrics: [
      "brier",
      "log-loss",
      "reliability-10-fixed-bins",
      "predictive-set-coverage-50-80-95",
      "opponent-action-p2-p3",
      "terminal-risk-brier-log-loss",
    ] as const,
    bootstrap:
      mode === "behavioral-comparison"
        ? {
            method: "paired-style-base-cluster-max-statistic-v1" as const,
            confidenceLevel: 0.95 as const,
            resamples: PHASE8_BOOTSTRAP_RESAMPLES,
            seed: bootstrapSeed,
          }
        : {
            method: "not-applicable-reference-one-arm" as const,
            confidenceLevel: null,
            resamples: 0 as const,
            seed: null,
          },
  };
  const plan = {
    ...withoutHash,
    planSha256: phase8CalibrationPlanSha256(withoutHash),
    [PHASE8_CALIBRATION_PLAN_AUTHORITY]: true as const,
  };
  return deepFreeze(plan);
}

function assertPlanMatchesAuthority(
  authority: Phase8CalibrationManifestAuthority,
  opening: Phase8CalibrationSplitOpening,
  plan: Phase8CalibrationPlan,
): void {
  verifyPhase8CalibrationPlan(plan);
  if (opening.split === "final") {
    verifyPhase8FinalManifestAuthority(
      authority as FrozenPhase8FinalManifestAuthority,
    );
  } else {
    verifyPhase8ManifestAuthority(authority as FrozenPhase8ManifestAuthority);
  }
  validateOpeningWithoutExposingSchedule(authority, opening);
  if (
    plan.manifestSha256 !== authority.manifestSha256 ||
    plan.manifestId !== authority.manifest.manifestId ||
    plan.split !== opening.split ||
    plan.splitOpeningSha256 !== opening.openingSha256 ||
    plan.splitPlanSha256 !== opening.splitPlanSha256
  ) {
    fail("the plan, manifest authority, and split opening are not identical.");
  }
}

function scheduleRecordProjection(
  record: Omit<Phase8CalibrationScheduleRecord, "recordSha256">,
): Omit<Phase8CalibrationScheduleRecord, "recordSha256"> {
  return record;
}

export function* iteratePhase8CalibrationSchedule(
  authority: Phase8CalibrationManifestAuthority,
  opening: Phase8CalibrationSplitOpening,
  plan: Phase8CalibrationPlan,
): Generator<Phase8CalibrationScheduleRecord> {
  assertPlanMatchesAuthority(authority, opening, plan);
  const splitPlan =
    plan.split === "final"
      ? (authority as FrozenPhase8FinalManifestAuthority).manifest.split
      : (authority as FrozenPhase8ManifestAuthority).manifest.splits
          .qualification;
  let scheduleIndex = 0;
  for (const styleCellId of splitPlan.styleCellIds) {
    const styleCellIndex = splitPlan.styleCellIds.indexOf(styleCellId);
    for (
      let baseIndex = splitPlan.baseIndexStart;
      baseIndex < splitPlan.baseIndexStart + splitPlan.baseCount;
      baseIndex += 1
    ) {
      const styleBaseClusterId = `phase8-calibration-cluster:${phase8Sha256({
        schemaVersion: 1,
        manifestSha256: plan.manifestSha256,
        split: plan.split,
        styleCellIndex,
        baseIndex,
      })}`;
      for (const rotation of splitPlan.rotations) {
        const coordinate = {
          styleCellId,
          baseIndex,
          rotation,
          replicate: 0 as const,
        };
        const withoutHash = {
          schemaVersion: 1 as const,
          recordType: "phase8-calibration-schedule" as const,
          planSha256: plan.planSha256,
          split: plan.split,
          scheduleIndex,
          styleCellId,
          baseIndex,
          rotation,
          replicate: 0 as const,
          styleBaseClusterId,
          gameId: `phase8-calibration-game:${phase8Sha256({
            schemaVersion: 1,
            manifestSha256: plan.manifestSha256,
            split: plan.split,
            styleCellIndex,
            baseIndex,
            rotation,
            replicate: 0,
          })}`,
          seeds: {
            deal: deriveCalibrationScheduleSeed(opening, "deal", coordinate),
            p2Policy: deriveCalibrationScheduleSeed(
              opening,
              "p2-policy",
              coordinate,
            ),
            p3Policy: deriveCalibrationScheduleSeed(
              opening,
              "p3-policy",
              coordinate,
            ),
            chance: deriveCalibrationScheduleSeed(
              opening,
              "chance",
              coordinate,
            ),
            belief: deriveCalibrationScheduleSeed(
              opening,
              "belief",
              coordinate,
            ),
          },
        };
        const record = {
          ...withoutHash,
          recordSha256: phase8Sha256(scheduleRecordProjection(withoutHash)),
        };
        scheduleIndex += 1;
        yield deepFreeze(record);
      }
    }
  }
  if (scheduleIndex !== plan.scheduledGames) {
    fail("schedule enumeration did not produce the frozen game count.");
  }
}

function deriveCalibrationScheduleSeed(
  opening: Phase8CalibrationSplitOpening,
  stream: "deal" | "p2-policy" | "p3-policy" | "chance" | "belief",
  coordinate: Readonly<{
    styleCellId: string;
    baseIndex: number;
    rotation: 0 | 1 | 2;
    replicate: 0;
  }>,
): string {
  const coordinateMaterial =
    stream === "deal"
      ? [coordinate.baseIndex.toString()]
      : stream === "belief"
        ? [
            coordinate.baseIndex.toString(),
            coordinate.rotation.toString(),
            coordinate.replicate.toString(),
          ]
        : [
            coordinate.styleCellId,
            coordinate.baseIndex.toString(),
            coordinate.rotation.toString(),
            coordinate.replicate.toString(),
          ];
  const manifestVersion =
    opening.split === "final"
      ? PHASE8_FINAL_MANIFEST_VERSION
      : PHASE8_MANIFEST_VERSION;
  return createHash("sha256")
    .update(
      [
        "bhabhi",
        "eval-v1",
        manifestVersion,
        opening.manifestSha256,
        opening.openingSha256,
        opening.split,
        stream,
        ...coordinateMaterial,
      ].join("|"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}
