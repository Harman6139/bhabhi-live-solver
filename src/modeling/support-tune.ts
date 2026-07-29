import { createHash } from "node:crypto";

import type {
  CalibrationPredictionRecord,
  CalibrationTruthRecord,
} from "../calibration/artifact-schema";
import type { CalibrationFeasibleSupportDiagnostic } from "../calibration/predictions";
import { multiclassBrier } from "../calibration/metrics";
import {
  PHASE8_CALIBRATION_PRIMARY_FAMILIES,
  type Phase8CalibrationPrimaryFamily,
} from "../calibration/phase8-plan";
import {
  createPhase6CalibrationPlan,
  FITTABLE_STYLE_CELL_IDS,
  phase6CalibrationScenarioIdentity,
  type CalibrationScenarioSeed,
} from "../calibration/protocol";
import {
  runPhase6Calibration,
  type Phase6CalibrationProgress,
} from "../calibration/runner";
import {
  FEASIBLE_SUPPORT_REGULARIZER_VERSION,
  regularizeFeasibleSupport,
} from "../calibration/support-regularization";
import type { ProbabilityEntry } from "../calibration/types";
import {
  deriveOpenedPhase8Seed,
  phase8Sha256,
  verifyPhase8ManifestAuthority,
  type FrozenPhase8ManifestAuthority,
  type Phase8SplitOpening,
} from "../evaluation/phase8-manifest";
import type { SourceSnapshot } from "../evaluation/artifacts";
import { stableHash, stableStringify } from "../events/stable-hash";
import {
  behaviorBeliefConfigFromSelectedArtifact,
  serializeSelectedBehaviorModelArtifact,
  verifySelectedBehaviorModelArtifact,
  type SelectedBehaviorModelArtifact,
} from "./behavior-fit";
import {
  createPhase8SupportRegularizerTuneSelection,
  type Phase8SupportRegularizerCandidateScore,
  type Phase8SupportRegularizerTuneSelection,
} from "./production-model";
import { PHASE8_SUPPORT_REGULARIZER_GRID } from "./selection-contract";

export const PHASE8_SUPPORT_TUNE_VERSION =
  "phase8-support-regularizer-tune-v1" as const;
export const PHASE8_SUPPORT_TUNE_EVIDENCE_BASE_COUNT = 64 as const;
export const PHASE8_SUPPORT_TUNE_STYLE_COUNT = 15 as const;
export const PHASE8_SUPPORT_TUNE_ROTATIONS = [0, 1, 2] as const;
export const PHASE8_SUPPORT_TUNE_EVIDENCE_GAME_COUNT = 2_880 as const;
export const PHASE8_SUPPORT_TUNE_EVIDENCE_CLUSTER_COUNT = 960 as const;

const SUPPORT_TUNE_QUERY_PLAN = {
  schemaVersion: 1,
  planVersion: PHASE8_SUPPORT_TUNE_VERSION,
  split: "tune",
  checkpointTiming: "prequential-mixed-frozen-checkpoints",
  opponentDecisionOrdinals: [2, 5, 8],
  fixedPublicEventOrdinals: [12, 24, 36],
  maximumPreActionCheckpointsPerGame: 6,
  maximumPostEventCheckpointsPerGame: 7,
  conditionalProbabilityFloor: 0.05,
  families: PHASE8_CALIBRATION_PRIMARY_FAMILIES,
  arms: ["hard-only", "behavioral"],
  selectedArm: "behavioral",
  knowledgeStrata: ["hard-known", "unresolved-soft"],
  candidateGrid: PHASE8_SUPPORT_REGULARIZER_GRID,
} as const;

const SUPPORT_TUNE_SCORER_CONTRACT = {
  schemaVersion: 1,
  scorerVersion: PHASE8_SUPPORT_TUNE_VERSION,
  score: "multiclass-brier-half-sum-squared-error",
  primaryArm: "behavioral",
  primaryKnowledgeStratum: "unresolved-soft",
  conditioningFalse: "typed-skip",
  nesting: [
    "queries-within-state",
    "states-within-game",
    "rotations-within-style-base-cluster",
    "equal-style-base-clusters-within-family",
    "equal-primary-families",
  ],
  integrity: [
    "one-score-or-conditioning-false-skip-per-candidate-prediction",
    "raw-zero-feasible-realized-labels-rejected",
    "hard-known-exactness-rejected-on-violation",
    "all-scheduled-games-and-rotations-required",
  ],
} as const;

export const PHASE8_SUPPORT_TUNE_QUERY_PLAN_SHA256 = phase8Sha256(
  SUPPORT_TUNE_QUERY_PLAN,
);
export const PHASE8_SUPPORT_TUNE_SCORER_SHA256 = phase8Sha256(
  SUPPORT_TUNE_SCORER_CONTRACT,
);

export type Phase8SupportTuneMode = "evidence" | "smoke";

export type Phase8SupportTunePlan = Readonly<{
  schemaVersion: 1;
  planVersion: typeof PHASE8_SUPPORT_TUNE_VERSION;
  protocolId: "eval-v1";
  runId: string;
  mode: Phase8SupportTuneMode;
  evidenceEligible: boolean;
  split: "tune";
  authorityPurpose: "development-tune-only";
  manifestId: string;
  manifestSha256: string;
  splitOpeningSha256: string;
  splitPlanSha256: string;
  openingAuthorizationKind: "development";
  seedNamespace: "tune";
  confirmatoryNamespacesExcluded: readonly ["qualification", "final"];
  baseIndexStart: number;
  baseCount: number;
  rotations: readonly [0, 1, 2];
  replicate: 0;
  styleCellIds: readonly string[];
  scheduledGames: number;
  scheduledStyleBaseClusters: number;
  evidenceSchedule: Readonly<{
    baseCount: 64;
    styleCellCount: 15;
    rotations: readonly [0, 1, 2];
    games: 2_880;
    styleBaseClusters: 960;
  }>;
  selectedBehaviorModelSha256: string;
  selectedBehaviorPayloadChecksum: string;
  selectedBehaviorCandidateId: string;
  selectedWorldCount: number;
  selectedRobustChoice: boolean;
  p2BehaviorConfigHash: string;
  p3BehaviorConfigHash: string;
  behaviorTuneDatasetHash: string;
  behaviorTuneDatasetContentHash: string;
  behaviorTuneScheduleHash: string;
  sourceSha256: string;
  sourceGitCommit: string | null;
  sourceGitStatusSha256: string;
  sourceGitDirty: boolean;
  scorerSha256: string;
  queryPlanSha256: string;
  candidatePseudocounts: readonly [0.25, 0.5, 1];
  selectionMetric: "equal-family-unresolved-soft-hidden-state-brier";
  selectionArm: "behavioral";
  tieBreak: "smallest-pseudocount-within-1e-12";
  nesting: readonly [
    "queries-within-state",
    "states-within-game",
    "rotations-within-style-base-cluster",
    "equal-style-base-clusters-within-family",
    "equal-primary-families",
  ];
  planSha256: string;
}>;

export type Phase8SupportTuneScheduleEntry = Readonly<{
  styleCellId: string;
  baseIndex: number;
  rotation: 0 | 1 | 2;
  replicate: 0;
  styleBaseClusterId: string;
  gameId: string;
  seedCommitmentSha256: string;
}>;

type InternalPhase8SupportTuneScheduleEntry = Phase8SupportTuneScheduleEntry &
  Readonly<{
    runnerSeed: CalibrationScenarioSeed;
  }>;

export type Phase8SupportTuneGameRecord = Readonly<{
  schemaVersion: 1;
  recordType: "phase8-support-tune-game";
  planSha256: string;
  styleCellId: string;
  baseIndex: number;
  rotation: 0 | 1 | 2;
  styleBaseClusterId: string;
  gameId: string;
  seedCommitmentSha256: string;
  completed: boolean;
  failureCount: number;
  recordSha256: string;
}>;

export type Phase8SupportTuneObservationRecord = Readonly<{
  schemaVersion: 1;
  recordType: "phase8-support-tune-observation-eval-only";
  planSha256: string;
  observationId: string;
  pairId: string;
  arm: "hard-only" | "behavioral";
  family: Phase8CalibrationPrimaryFamily;
  queryId: string;
  styleCellId: string;
  baseIndex: number;
  rotation: 0 | 1 | 2;
  styleBaseClusterId: string;
  gameId: string;
  stateId: string;
  hardKnown: boolean;
  feasibleLabels: readonly string[];
  rawDistribution: readonly ProbabilityEntry[];
  effectiveSampleSize: number;
  scoreStatus: "scored" | "conditioning-false";
  realizedLabel: string | null;
  recordSha256: string;
}>;

export type Phase8SupportTuneIntegrity = Readonly<{
  scheduledGames: number;
  completedGames: number;
  expectedStyleBaseClusters: number;
  completeStyleBaseClusters: number;
  incompleteStyleBaseClusters: number;
  runFailureCount: number;
  structuralFailureCount: number;
  candidateAccountingExpected: number;
  candidateAccountingActual: number;
  rawZeroFeasibleTruthCount: number;
  hardKnownViolationCount: number;
  passed: boolean;
}>;

export type Phase8SupportTuneCandidateEvaluation = Readonly<{
  score: Phase8SupportRegularizerCandidateScore;
  familyScores: Readonly<Record<Phase8CalibrationPrimaryFamily, number>>;
  accountedScores: number;
  conditioningFalseSkips: number;
  missingFamilyRotationCells: number;
}>;

export type Phase8SupportTuneRunResult = Readonly<{
  plan: Phase8SupportTunePlan;
  behaviorModel: SelectedBehaviorModelArtifact;
  games: readonly Phase8SupportTuneGameRecord[];
  observations: readonly Phase8SupportTuneObservationRecord[];
  candidateEvaluations: readonly Phase8SupportTuneCandidateEvaluation[];
  integrity: Phase8SupportTuneIntegrity;
  evidenceSha256: string;
  selection: Phase8SupportRegularizerTuneSelection | null;
  provisionalSelectedPseudocount: number;
}>;

export type Phase8SupportTuneProgress = Phase6CalibrationProgress;

function fail(message: string): never {
  throw new Error(`Phase 8 support tune rejected: ${message}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mean(values: readonly number[], label: string): number {
  if (values.length === 0) {
    fail(`${label} has no values.`);
  }
  const value =
    values.reduce((total, entry) => total + entry, 0) / values.length;
  if (!Number.isFinite(value) || value < 0) {
    fail(`${label} produced an invalid mean.`);
  }
  return value;
}

function byteSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireRunId(value: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{2,119}$/u.test(value)) {
    fail("runId must be a filesystem-safe lowercase identifier.");
  }
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function differs(left: unknown, right: unknown): boolean {
  return left !== right;
}

function planProjection(
  value: Omit<Phase8SupportTunePlan, "planSha256">,
): Omit<Phase8SupportTunePlan, "planSha256"> {
  return value;
}

export function phase8SupportTunePlanSha256(
  value: Omit<Phase8SupportTunePlan, "planSha256">,
): string {
  return phase8Sha256(planProjection(value));
}

function verifyPlanShape(plan: Phase8SupportTunePlan): void {
  const { planSha256, ...projection } = plan;
  if (
    differs(plan.schemaVersion, 1) ||
    differs(plan.planVersion, PHASE8_SUPPORT_TUNE_VERSION) ||
    differs(plan.split, "tune") ||
    differs(plan.authorityPurpose, "development-tune-only") ||
    differs(plan.seedNamespace, "tune") ||
    differs(plan.openingAuthorizationKind, "development") ||
    planSha256 !== phase8SupportTunePlanSha256(projection) ||
    !sameArray(plan.rotations, PHASE8_SUPPORT_TUNE_ROTATIONS) ||
    !sameArray(plan.styleCellIds, FITTABLE_STYLE_CELL_IDS) ||
    differs(plan.candidatePseudocounts[0], 0.25) ||
    differs(plan.candidatePseudocounts[1], 0.5) ||
    differs(plan.candidatePseudocounts[2], 1) ||
    plan.queryPlanSha256 !== PHASE8_SUPPORT_TUNE_QUERY_PLAN_SHA256 ||
    plan.scorerSha256 !== PHASE8_SUPPORT_TUNE_SCORER_SHA256 ||
    plan.scheduledGames !==
      plan.baseCount *
        plan.styleCellIds.length *
        PHASE8_SUPPORT_TUNE_ROTATIONS.length ||
    plan.scheduledStyleBaseClusters !==
      plan.baseCount * plan.styleCellIds.length
  ) {
    fail("support-tune plan shape or checksum is invalid.");
  }
  if (
    plan.mode === "evidence" &&
    (!plan.evidenceEligible ||
      plan.baseCount !== PHASE8_SUPPORT_TUNE_EVIDENCE_BASE_COUNT ||
      plan.scheduledGames !== PHASE8_SUPPORT_TUNE_EVIDENCE_GAME_COUNT ||
      plan.scheduledStyleBaseClusters !==
        PHASE8_SUPPORT_TUNE_EVIDENCE_CLUSTER_COUNT ||
      plan.sourceGitDirty ||
      plan.sourceGitCommit === null)
  ) {
    fail("evidence mode does not carry the exact clean committed schedule.");
  }
  if (plan.mode === "smoke" && plan.evidenceEligible) {
    fail("smoke mode cannot claim evidence eligibility.");
  }
}

export function verifyPhase8SupportTunePlan(plan: Phase8SupportTunePlan): true {
  verifyPlanShape(plan);
  return true;
}

/**
 * Freezes support selection against the development/tune-only authority whose
 * model hash is the selected behavior-model artifact. After this artifact is
 * verified, callers must build the final production-model bytes and freeze a
 * distinct qualification authority against those bytes. Qualification/final
 * openings are never inputs to this workflow.
 */
export function createPhase8SupportTunePlan(input: {
  readonly tuneAuthority: FrozenPhase8ManifestAuthority;
  readonly opening: Phase8SplitOpening;
  readonly behaviorModel: SelectedBehaviorModelArtifact;
  readonly source: SourceSnapshot;
  readonly runId: string;
  readonly mode: Phase8SupportTuneMode;
  readonly smokeBaseCount?: number;
}): Phase8SupportTunePlan {
  requireRunId(input.runId);
  verifyPhase8ManifestAuthority(input.tuneAuthority);
  const verification = verifySelectedBehaviorModelArtifact(input.behaviorModel);
  if (!verification.ok || verification.artifact === null) {
    fail(
      `selected behavior model is invalid: ${verification.issues.join("; ")}`,
    );
  }
  const behaviorModel = verification.artifact;
  const splitPlan = input.tuneAuthority.manifest.splits.tune;
  if (
    input.opening.split !== "tune" ||
    input.opening.authorizationKind !== "development" ||
    input.opening.manifestSha256 !== input.tuneAuthority.manifestSha256 ||
    input.opening.splitPlanSha256 !==
      phase8Sha256(input.tuneAuthority.manifest.splits.tune)
  ) {
    fail(
      "a genuine development/tune-only authority and tune opening are required.",
    );
  }
  const firstStyleCellId = splitPlan.styleCellIds[0];
  if (firstStyleCellId === undefined) {
    fail("the tune split is empty.");
  }
  deriveOpenedPhase8Seed(input.tuneAuthority, input.opening, {
    stream: "belief",
    styleCellId: firstStyleCellId,
    baseIndex: splitPlan.baseIndexStart,
    rotation: 0,
    replicate: 0,
  });
  if (
    !sameArray(splitPlan.styleCellIds, FITTABLE_STYLE_CELL_IDS) ||
    !sameArray(splitPlan.rotations, PHASE8_SUPPORT_TUNE_ROTATIONS) ||
    !sameArray(splitPlan.replicates, [0])
  ) {
    fail(
      "the opened tune split is not the frozen 15-cell, three-rotation plan.",
    );
  }
  const baseCount =
    input.mode === "evidence"
      ? splitPlan.baseCount
      : (input.smokeBaseCount ?? Math.min(1, splitPlan.baseCount));
  if (
    !Number.isSafeInteger(baseCount) ||
    baseCount < 1 ||
    baseCount > splitPlan.baseCount
  ) {
    fail("smokeBaseCount must be within the opened tune split.");
  }

  const serializedBehaviorModel =
    serializeSelectedBehaviorModelArtifact(behaviorModel);
  const selectedBehaviorModelSha256 = byteSha256(serializedBehaviorModel);
  const manifest = input.tuneAuthority.manifest;
  const evidenceEligible = input.mode === "evidence";
  if (
    evidenceEligible &&
    (splitPlan.baseIndexStart !== 0 ||
      splitPlan.baseCount !== PHASE8_SUPPORT_TUNE_EVIDENCE_BASE_COUNT ||
      input.source.gitDirty ||
      input.source.gitCommit === null ||
      input.source.sourceSnapshotSha256 !== manifest.hashes.sourceSha256 ||
      behaviorModel.payload.sourceHash !== input.source.sourceSnapshotSha256 ||
      selectedBehaviorModelSha256 !== manifest.hashes.modelSha256)
  ) {
    fail(
      "evidence mode requires the exact 64-base tune plan and matching clean source/model manifest hashes.",
    );
  }

  const withoutHash = {
    schemaVersion: 1 as const,
    planVersion: PHASE8_SUPPORT_TUNE_VERSION,
    protocolId: "eval-v1" as const,
    runId: input.runId,
    mode: input.mode,
    evidenceEligible,
    split: "tune" as const,
    authorityPurpose: "development-tune-only" as const,
    manifestId: manifest.manifestId,
    manifestSha256: input.tuneAuthority.manifestSha256,
    splitOpeningSha256: input.opening.openingSha256,
    splitPlanSha256: input.opening.splitPlanSha256,
    openingAuthorizationKind: "development" as const,
    seedNamespace: "tune" as const,
    confirmatoryNamespacesExcluded: ["qualification", "final"] as const,
    baseIndexStart: splitPlan.baseIndexStart,
    baseCount,
    rotations: PHASE8_SUPPORT_TUNE_ROTATIONS,
    replicate: 0 as const,
    styleCellIds: [...FITTABLE_STYLE_CELL_IDS],
    scheduledGames:
      baseCount *
      FITTABLE_STYLE_CELL_IDS.length *
      PHASE8_SUPPORT_TUNE_ROTATIONS.length,
    scheduledStyleBaseClusters: baseCount * FITTABLE_STYLE_CELL_IDS.length,
    evidenceSchedule: {
      baseCount: PHASE8_SUPPORT_TUNE_EVIDENCE_BASE_COUNT,
      styleCellCount: PHASE8_SUPPORT_TUNE_STYLE_COUNT,
      rotations: PHASE8_SUPPORT_TUNE_ROTATIONS,
      games: PHASE8_SUPPORT_TUNE_EVIDENCE_GAME_COUNT,
      styleBaseClusters: PHASE8_SUPPORT_TUNE_EVIDENCE_CLUSTER_COUNT,
    },
    selectedBehaviorModelSha256,
    selectedBehaviorPayloadChecksum: behaviorModel.payloadChecksum,
    selectedBehaviorCandidateId: behaviorModel.payload.selectedCandidateId,
    selectedWorldCount: behaviorModel.payload.parameters.worldCount,
    selectedRobustChoice: behaviorModel.payload.parameters.robustChoice,
    p2BehaviorConfigHash: stableHash(behaviorModel.payload.opponentConfigs.p2),
    p3BehaviorConfigHash: stableHash(behaviorModel.payload.opponentConfigs.p3),
    behaviorTuneDatasetHash: behaviorModel.payload.tune.datasetHash,
    behaviorTuneDatasetContentHash:
      behaviorModel.payload.tune.datasetContentHash,
    behaviorTuneScheduleHash: behaviorModel.payload.tune.scheduleHash,
    sourceSha256: input.source.sourceSnapshotSha256,
    sourceGitCommit: input.source.gitCommit,
    sourceGitStatusSha256: input.source.gitStatusSha256,
    sourceGitDirty: input.source.gitDirty,
    scorerSha256: PHASE8_SUPPORT_TUNE_SCORER_SHA256,
    queryPlanSha256: PHASE8_SUPPORT_TUNE_QUERY_PLAN_SHA256,
    candidatePseudocounts: [0.25, 0.5, 1] as const,
    selectionMetric: "equal-family-unresolved-soft-hidden-state-brier" as const,
    selectionArm: "behavioral" as const,
    tieBreak: "smallest-pseudocount-within-1e-12" as const,
    nesting: SUPPORT_TUNE_SCORER_CONTRACT.nesting,
  };
  const plan = Object.freeze({
    ...withoutHash,
    planSha256: phase8SupportTunePlanSha256(withoutHash),
  });
  verifyPlanShape(plan);
  return plan;
}

function scheduleSeed(
  tuneAuthority: FrozenPhase8ManifestAuthority,
  opening: Phase8SplitOpening,
  styleCellId: string,
  baseIndex: number,
  rotation: 0 | 1 | 2,
  stream:
    | "deal"
    | "user-policy"
    | "p2-policy"
    | "p3-policy"
    | "chance"
    | "belief"
    | "bootstrap",
): string {
  return deriveOpenedPhase8Seed(tuneAuthority, opening, {
    stream,
    styleCellId,
    baseIndex,
    rotation,
    replicate: 0,
  });
}

function openedPhase8SupportTuneSchedule(
  tuneAuthority: FrozenPhase8ManifestAuthority,
  opening: Phase8SplitOpening,
  plan: Phase8SupportTunePlan,
): readonly InternalPhase8SupportTuneScheduleEntry[] {
  verifyPlanShape(plan);
  verifyPhase8ManifestAuthority(tuneAuthority);
  if (
    tuneAuthority.manifestSha256 !== plan.manifestSha256 ||
    opening.openingSha256 !== plan.splitOpeningSha256 ||
    opening.split !== "tune" ||
    opening.authorizationKind !== "development"
  ) {
    fail(
      "plan, development/tune-only authority, and tune opening do not match.",
    );
  }
  const phase6Plan = createPhase6CalibrationPlan({
    runId: plan.runId,
    split: "tune",
    baseIndexStart: plan.baseIndexStart,
    baseCount: plan.baseCount,
    hardWorldSamples: plan.selectedWorldCount,
  });
  const entries: InternalPhase8SupportTuneScheduleEntry[] = [];
  for (const styleCellId of plan.styleCellIds) {
    for (
      let baseIndex = plan.baseIndexStart;
      baseIndex < plan.baseIndexStart + plan.baseCount;
      baseIndex += 1
    ) {
      for (const rotation of PHASE8_SUPPORT_TUNE_ROTATIONS) {
        const runnerSeed: CalibrationScenarioSeed = {
          styleCellId,
          baseIndex,
          rotation,
          replicate: 0,
          deal: scheduleSeed(
            tuneAuthority,
            opening,
            styleCellId,
            baseIndex,
            rotation,
            "deal",
          ),
          userPolicy: scheduleSeed(
            tuneAuthority,
            opening,
            styleCellId,
            baseIndex,
            rotation,
            "user-policy",
          ),
          p2Policy: scheduleSeed(
            tuneAuthority,
            opening,
            styleCellId,
            baseIndex,
            rotation,
            "p2-policy",
          ),
          p3Policy: scheduleSeed(
            tuneAuthority,
            opening,
            styleCellId,
            baseIndex,
            rotation,
            "p3-policy",
          ),
          chance: scheduleSeed(
            tuneAuthority,
            opening,
            styleCellId,
            baseIndex,
            rotation,
            "chance",
          ),
          belief: scheduleSeed(
            tuneAuthority,
            opening,
            styleCellId,
            baseIndex,
            rotation,
            "belief",
          ),
          bootstrap: scheduleSeed(
            tuneAuthority,
            opening,
            styleCellId,
            baseIndex,
            rotation,
            "bootstrap",
          ),
        };
        const identity = phase6CalibrationScenarioIdentity(
          phase6Plan,
          runnerSeed,
        );
        const styleBaseClusterId = `tune/${styleCellId}/base/${baseIndex.toString()}`;
        entries.push(
          Object.freeze({
            styleCellId,
            baseIndex,
            rotation,
            replicate: 0,
            styleBaseClusterId,
            gameId: identity.gameId,
            seedCommitmentSha256: phase8Sha256({
              schemaVersion: 1,
              coordinate: {
                styleCellId,
                baseIndex,
                rotation,
                replicate: 0,
              },
              streams: runnerSeed,
            }),
            runnerSeed: Object.freeze(runnerSeed),
          }),
        );
      }
    }
  }
  if (entries.length !== plan.scheduledGames) {
    fail("the opened tune schedule has the wrong cardinality.");
  }
  return Object.freeze(entries);
}

/**
 * Public schedule projection. Raw opened seeds remain confined to the runner;
 * persisted and inspectable schedule records expose only a commitment.
 */
export function iteratePhase8SupportTuneSchedule(
  tuneAuthority: FrozenPhase8ManifestAuthority,
  opening: Phase8SplitOpening,
  plan: Phase8SupportTunePlan,
): readonly Phase8SupportTuneScheduleEntry[] {
  return Object.freeze(
    openedPhase8SupportTuneSchedule(tuneAuthority, opening, plan).map(
      (internalEntry) => {
        const { runnerSeed, ...entry } = internalEntry;
        void runnerSeed;
        return Object.freeze(entry);
      },
    ),
  );
}

function gameRecordProjection(
  record: Omit<Phase8SupportTuneGameRecord, "recordSha256">,
): Omit<Phase8SupportTuneGameRecord, "recordSha256"> {
  return record;
}

function observationRecordProjection(
  record: Omit<Phase8SupportTuneObservationRecord, "recordSha256">,
): Omit<Phase8SupportTuneObservationRecord, "recordSha256"> {
  return record;
}

export function verifyPhase8SupportTuneGameRecord(
  record: Phase8SupportTuneGameRecord,
): true {
  const { recordSha256, ...projection } = record;
  if (
    differs(record.recordType, "phase8-support-tune-game") ||
    record.failureCount < 0 ||
    recordSha256 !== phase8Sha256(gameRecordProjection(projection))
  ) {
    fail("game record is invalid.");
  }
  return true;
}

export function verifyPhase8SupportTuneObservationRecord(
  record: Phase8SupportTuneObservationRecord,
): true {
  const { recordSha256, ...projection } = record;
  if (
    differs(record.recordType, "phase8-support-tune-observation-eval-only") ||
    !PHASE8_CALIBRATION_PRIMARY_FAMILIES.includes(record.family) ||
    record.feasibleLabels.length < 1 ||
    new Set(record.feasibleLabels).size !== record.feasibleLabels.length ||
    !Number.isFinite(record.effectiveSampleSize) ||
    record.effectiveSampleSize <= 0 ||
    (record.scoreStatus === "scored") !== (record.realizedLabel !== null) ||
    recordSha256 !== phase8Sha256(observationRecordProjection(projection))
  ) {
    fail("observation record is invalid.");
  }
  regularizeFeasibleSupport({
    distribution: record.rawDistribution,
    feasibleLabels: record.feasibleLabels,
    hardKnown: record.hardKnown,
    effectiveSampleSize: record.effectiveSampleSize,
    config: { pseudocountPerFeasibleLabel: 0 },
  });
  return true;
}

function probability(
  distribution: readonly ProbabilityEntry[],
  label: string,
): number {
  const entry = distribution.find((candidate) => candidate.label === label);
  if (entry === undefined) {
    fail(`realized label ${label} is absent from its prediction.`);
  }
  return entry.probability;
}

function completeClusterCount(
  games: readonly Phase8SupportTuneGameRecord[],
): number {
  const byCluster = new Map<string, Phase8SupportTuneGameRecord[]>();
  for (const game of games) {
    const records = byCluster.get(game.styleBaseClusterId) ?? [];
    records.push(game);
    byCluster.set(game.styleBaseClusterId, records);
  }
  let complete = 0;
  for (const records of byCluster.values()) {
    if (
      records.length === PHASE8_SUPPORT_TUNE_ROTATIONS.length &&
      records.every(
        (record) => record.completed && record.failureCount === 0,
      ) &&
      PHASE8_SUPPORT_TUNE_ROTATIONS.every(
        (rotation) =>
          records.filter((record) => record.rotation === rotation).length === 1,
      )
    ) {
      complete += 1;
    }
  }
  return complete;
}

type CandidateObservationScore = Readonly<{
  family: Phase8CalibrationPrimaryFamily;
  styleBaseClusterId: string;
  gameId: string;
  rotation: 0 | 1 | 2;
  stateId: string;
  brier: number;
}>;

function nestedCandidateScore(input: {
  readonly observations: readonly CandidateObservationScore[];
  readonly games: readonly Phase8SupportTuneGameRecord[];
}): Readonly<{
  score: number;
  familyScores: Readonly<Record<Phase8CalibrationPrimaryFamily, number>>;
  missingFamilyRotationCells: number;
}> {
  const completeClusterIds = new Set<string>();
  const groupedGames = new Map<string, Phase8SupportTuneGameRecord[]>();
  for (const game of input.games) {
    const values = groupedGames.get(game.styleBaseClusterId) ?? [];
    values.push(game);
    groupedGames.set(game.styleBaseClusterId, values);
  }
  for (const [clusterId, games] of groupedGames) {
    if (
      games.length === 3 &&
      games.every((game) => game.completed && game.failureCount === 0) &&
      PHASE8_SUPPORT_TUNE_ROTATIONS.every(
        (rotation) =>
          games.filter((game) => game.rotation === rotation).length === 1,
      )
    ) {
      completeClusterIds.add(clusterId);
    }
  }

  type Group = {
    family: Phase8CalibrationPrimaryFamily;
    styleBaseClusterId: string;
    rotation: 0 | 1 | 2;
    gameId: string;
    values: number[];
  };
  const stateGroups = new Map<string, Group>();
  for (const observation of input.observations) {
    const stateKey = [
      observation.family,
      observation.styleBaseClusterId,
      observation.rotation.toString(),
      observation.gameId,
      observation.stateId,
    ].join("\u0000");
    const group = stateGroups.get(stateKey) ?? {
      family: observation.family,
      styleBaseClusterId: observation.styleBaseClusterId,
      rotation: observation.rotation,
      gameId: observation.gameId,
      values: [],
    };
    group.values.push(observation.brier);
    stateGroups.set(stateKey, group);
  }
  const gameGroups = new Map<string, Group>();
  for (const group of stateGroups.values()) {
    const gameKey = [
      group.family,
      group.styleBaseClusterId,
      group.rotation.toString(),
      group.gameId,
    ].join("\u0000");
    const gameGroup = gameGroups.get(gameKey) ?? {
      family: group.family,
      styleBaseClusterId: group.styleBaseClusterId,
      rotation: group.rotation,
      gameId: group.gameId,
      values: [],
    };
    gameGroup.values.push(
      mean(group.values, `${group.family} queries within state`),
    );
    gameGroups.set(gameKey, gameGroup);
  }
  const rotationGroups = new Map<string, number[]>();
  for (const group of gameGroups.values()) {
    const rotationKey = [
      group.family,
      group.styleBaseClusterId,
      group.rotation.toString(),
    ].join("\u0000");
    const values = rotationGroups.get(rotationKey) ?? [];
    values.push(mean(group.values, `${group.family} states within game`));
    rotationGroups.set(rotationKey, values);
  }

  let missingFamilyRotationCells = 0;
  const familyScores = {} as Record<Phase8CalibrationPrimaryFamily, number>;
  const tunableFamilyScores: number[] = [];
  for (const family of PHASE8_CALIBRATION_PRIMARY_FAMILIES) {
    const clusterScores: number[] = [];
    for (const clusterId of [...completeClusterIds].sort(compareText)) {
      const rotationScores: number[] = [];
      for (const rotation of PHASE8_SUPPORT_TUNE_ROTATIONS) {
        const gameScores =
          rotationGroups.get(
            [family, clusterId, rotation.toString()].join("\u0000"),
          ) ?? [];
        if (gameScores.length > 1) {
          missingFamilyRotationCells += 1;
          continue;
        }
        const gameScore = gameScores[0];
        if (gameScore !== undefined) {
          rotationScores.push(gameScore);
        }
      }
      if (rotationScores.length > 0) {
        clusterScores.push(
          mean(
            rotationScores,
            `${family} applicable rotations within cluster`,
          ),
        );
      }
    }
    if (clusterScores.length === 0) {
      if (family !== "conditional") {
        fail(`${family} complete style-base clusters has no values.`);
      }
      // Conditional queries can be hard-known-only by construction. They
      // contain no pseudocount-tunable error and therefore cannot distinguish
      // candidates; retain a finite zero diagnostic while excluding that
      // uninformative family from the equal-family candidate objective.
      familyScores[family] = 0;
      continue;
    }
    const familyScore = mean(
      clusterScores,
      `${family} complete style-base clusters`,
    );
    familyScores[family] = familyScore;
    tunableFamilyScores.push(familyScore);
  }
  return Object.freeze({
    score: mean(tunableFamilyScores, "equal tunable primary families"),
    familyScores: Object.freeze(familyScores),
    missingFamilyRotationCells,
  });
}

function regularizerConfigHash(pseudocountPerFeasibleLabel: number): string {
  return stableHash({
    schemaVersion: 1,
    algorithmVersion: FEASIBLE_SUPPORT_REGULARIZER_VERSION,
    config: { pseudocountPerFeasibleLabel },
  });
}

function hardKnownViolations(
  observations: readonly Phase8SupportTuneObservationRecord[],
): number {
  let count = 0;
  for (const observation of observations.filter(
    (candidate) => candidate.hardKnown,
  )) {
    const knownLabel = observation.feasibleLabels[0];
    if (
      observation.feasibleLabels.length !== 1 ||
      knownLabel === undefined ||
      probability(observation.rawDistribution, knownLabel) !== 1 ||
      (observation.realizedLabel !== null &&
        observation.realizedLabel !== knownLabel)
    ) {
      count += 1;
    }
  }
  return count;
}

function rawZeroFeasibleTruths(
  observations: readonly Phase8SupportTuneObservationRecord[],
): number {
  let count = 0;
  for (const observation of observations) {
    const label = observation.realizedLabel;
    if (
      label !== null &&
      observation.feasibleLabels.includes(label) &&
      probability(observation.rawDistribution, label) === 0
    ) {
      count += 1;
    }
  }
  return count;
}

export function scorePhase8SupportTuneCandidates(input: {
  readonly plan: Phase8SupportTunePlan;
  readonly games: readonly Phase8SupportTuneGameRecord[];
  readonly observations: readonly Phase8SupportTuneObservationRecord[];
  readonly runFailureCount?: number;
}): Readonly<{
  evaluations: readonly Phase8SupportTuneCandidateEvaluation[];
  integrity: Phase8SupportTuneIntegrity;
}> {
  verifyPlanShape(input.plan);
  for (const game of input.games) {
    verifyPhase8SupportTuneGameRecord(game);
  }
  for (const observation of input.observations) {
    verifyPhase8SupportTuneObservationRecord(observation);
  }
  const runFailureCount =
    input.runFailureCount ??
    input.games.reduce((total, game) => total + game.failureCount, 0);
  const completedGames = input.games.filter((game) => game.completed).length;
  const completeStyleBaseClusters = completeClusterCount(input.games);
  const incompleteStyleBaseClusters =
    input.plan.scheduledStyleBaseClusters - completeStyleBaseClusters;
  const rawZeroFeasibleTruthCount = rawZeroFeasibleTruths(input.observations);
  const hardKnownViolationCount = hardKnownViolations(input.observations);
  let candidateAccountingActual = 0;
  let structuralFailureCount =
    Math.max(0, input.plan.scheduledGames - input.games.length) +
    Math.max(0, input.games.length - input.plan.scheduledGames);
  const evaluations: Phase8SupportTuneCandidateEvaluation[] = [];

  for (const config of PHASE8_SUPPORT_REGULARIZER_GRID) {
    const scored: CandidateObservationScore[] = [];
    let accountedScores = 0;
    let conditioningFalseSkips = 0;
    let applicationFailures = 0;
    for (const observation of input.observations) {
      try {
        const regularized = regularizeFeasibleSupport({
          distribution: observation.rawDistribution,
          feasibleLabels: observation.feasibleLabels,
          hardKnown: observation.hardKnown,
          effectiveSampleSize: observation.effectiveSampleSize,
          config,
        });
        if (observation.scoreStatus === "conditioning-false") {
          conditioningFalseSkips += 1;
          candidateAccountingActual += 1;
          continue;
        }
        const realizedLabel =
          observation.realizedLabel ?? fail("scored observation has no label.");
        if (observation.arm === "behavioral" && !observation.hardKnown) {
          scored.push({
            family: observation.family,
            styleBaseClusterId: observation.styleBaseClusterId,
            gameId: observation.gameId,
            rotation: observation.rotation,
            stateId: observation.stateId,
            brier: multiclassBrier(regularized.distribution, realizedLabel),
          });
        }
        accountedScores += 1;
        candidateAccountingActual += 1;
      } catch {
        applicationFailures += 1;
      }
    }
    const nested = nestedCandidateScore({
      observations: scored,
      games: input.games,
    });
    structuralFailureCount +=
      applicationFailures + nested.missingFamilyRotationCells;
    const failureCount =
      runFailureCount +
      incompleteStyleBaseClusters +
      applicationFailures +
      nested.missingFamilyRotationCells;
    evaluations.push(
      Object.freeze({
        score: Object.freeze({
          pseudocountPerFeasibleLabel: config.pseudocountPerFeasibleLabel,
          configHash: regularizerConfigHash(config.pseudocountPerFeasibleLabel),
          completeClusters: completeStyleBaseClusters,
          unresolvedSoftObservations: scored.length,
          equalFamilyUnresolvedSoftBrier: nested.score,
          rawZeroFeasibleTruthCount,
          hardKnownViolationCount,
          failureCount,
        }),
        familyScores: nested.familyScores,
        accountedScores,
        conditioningFalseSkips,
        missingFamilyRotationCells: nested.missingFamilyRotationCells,
      }),
    );
  }

  const candidateAccountingExpected =
    input.observations.length * PHASE8_SUPPORT_REGULARIZER_GRID.length;
  if (candidateAccountingActual !== candidateAccountingExpected) {
    structuralFailureCount += Math.abs(
      candidateAccountingExpected - candidateAccountingActual,
    );
  }
  const passed =
    completedGames === input.plan.scheduledGames &&
    completeStyleBaseClusters === input.plan.scheduledStyleBaseClusters &&
    incompleteStyleBaseClusters === 0 &&
    runFailureCount === 0 &&
    structuralFailureCount === 0 &&
    candidateAccountingActual === candidateAccountingExpected &&
    rawZeroFeasibleTruthCount === 0 &&
    hardKnownViolationCount === 0 &&
    evaluations.every((evaluation) => evaluation.score.failureCount === 0);
  return Object.freeze({
    evaluations: Object.freeze(evaluations),
    integrity: Object.freeze({
      scheduledGames: input.plan.scheduledGames,
      completedGames,
      expectedStyleBaseClusters: input.plan.scheduledStyleBaseClusters,
      completeStyleBaseClusters,
      incompleteStyleBaseClusters,
      runFailureCount,
      structuralFailureCount,
      candidateAccountingExpected,
      candidateAccountingActual,
      rawZeroFeasibleTruthCount,
      hardKnownViolationCount,
      passed,
    }),
  });
}

function deterministicCandidateWinner(
  evaluations: readonly Phase8SupportTuneCandidateEvaluation[],
): Phase8SupportTuneCandidateEvaluation {
  const winner = [...evaluations].sort((left, right) => {
    const difference =
      left.score.equalFamilyUnresolvedSoftBrier -
      right.score.equalFamilyUnresolvedSoftBrier;
    return Math.abs(difference) <= 1e-12
      ? left.score.pseudocountPerFeasibleLabel -
          right.score.pseudocountPerFeasibleLabel
      : difference;
  })[0];
  return winner ?? fail("candidate grid produced no winner.");
}

export function phase8SupportTuneEvidenceSha256(input: {
  readonly plan: Phase8SupportTunePlan;
  readonly behaviorModel: SelectedBehaviorModelArtifact;
  readonly games: readonly Phase8SupportTuneGameRecord[];
  readonly observations: readonly Phase8SupportTuneObservationRecord[];
}): string {
  return phase8Sha256({
    schemaVersion: 1,
    artifactKind: "phase8-support-tune-evidence",
    planSha256: input.plan.planSha256,
    selectedBehaviorModelSha256: byteSha256(
      serializeSelectedBehaviorModelArtifact(input.behaviorModel),
    ),
    gamesSha256: byteSha256(
      input.games.map((record) => stableStringify(record)).join("\n") + "\n",
    ),
    observationsSha256: byteSha256(
      input.observations.map((record) => stableStringify(record)).join("\n") +
        "\n",
    ),
  });
}

type SupportDiagnostic = CalibrationFeasibleSupportDiagnostic;

function diagnosticKey(pairId: string, arm: string): string {
  return `${pairId}/${arm}`;
}

function primaryPrediction(
  prediction: CalibrationPredictionRecord,
): prediction is CalibrationPredictionRecord & {
  readonly target: Extract<
    CalibrationPredictionRecord["target"],
    { readonly kind: "query" }
  > & { readonly family: Phase8CalibrationPrimaryFamily };
} {
  return (
    prediction.target.kind === "query" &&
    PHASE8_CALIBRATION_PRIMARY_FAMILIES.includes(prediction.target.family)
  );
}

function truthByPair(
  truths: readonly CalibrationTruthRecord[],
): ReadonlyMap<string, CalibrationTruthRecord> {
  const values = new Map<string, CalibrationTruthRecord>();
  for (const truth of truths) {
    if (values.has(truth.pairId)) {
      fail(`duplicate truth record for pair ${truth.pairId}.`);
    }
    values.set(truth.pairId, truth);
  }
  return values;
}

export function runPhase8SupportTune(input: {
  readonly tuneAuthority: FrozenPhase8ManifestAuthority;
  readonly opening: Phase8SplitOpening;
  readonly plan: Phase8SupportTunePlan;
  readonly behaviorModel: SelectedBehaviorModelArtifact;
  readonly scheduleSlice?: Readonly<{
    styleCellId: string;
    baseIndexStart: number;
    baseCount: number;
  }>;
  readonly onProgress?: (progress: Phase8SupportTuneProgress) => void;
}): Phase8SupportTuneRunResult {
  const completeSchedule = openedPhase8SupportTuneSchedule(
    input.tuneAuthority,
    input.opening,
    input.plan,
  );
  const schedule =
    input.scheduleSlice === undefined
      ? completeSchedule
      : (() => {
          const { styleCellId, baseIndexStart, baseCount } =
            input.scheduleSlice;
          if (
            !input.plan.styleCellIds.includes(styleCellId) ||
            !Number.isSafeInteger(baseIndexStart) ||
            !Number.isSafeInteger(baseCount) ||
            baseCount < 1 ||
            baseIndexStart < input.plan.baseIndexStart ||
            baseIndexStart + baseCount >
              input.plan.baseIndexStart + input.plan.baseCount
          ) {
            fail("support-tune schedule slice is outside the frozen plan.");
          }
          const filtered = completeSchedule.filter(
            (entry) =>
              entry.styleCellId === styleCellId &&
              entry.baseIndex >= baseIndexStart &&
              entry.baseIndex < baseIndexStart + baseCount,
          );
          if (
            filtered.length !==
            baseCount * PHASE8_SUPPORT_TUNE_ROTATIONS.length
          ) {
            fail("support-tune schedule slice has the wrong cardinality.");
          }
          return Object.freeze(filtered);
        })();
  const behaviorVerification = verifySelectedBehaviorModelArtifact(
    input.behaviorModel,
  );
  if (
    !behaviorVerification.ok ||
    behaviorVerification.artifact === null ||
    behaviorVerification.artifact.payloadChecksum !==
      input.plan.selectedBehaviorPayloadChecksum ||
    byteSha256(
      serializeSelectedBehaviorModelArtifact(behaviorVerification.artifact),
    ) !== input.plan.selectedBehaviorModelSha256
  ) {
    fail("run behavior model does not match the preregistered plan.");
  }
  const behaviorModel = behaviorVerification.artifact;
  const phase6Plan = createPhase6CalibrationPlan({
    runId: input.plan.runId,
    split: "tune",
    baseIndexStart: input.plan.baseIndexStart,
    baseCount: input.plan.baseCount,
    hardWorldSamples: input.plan.selectedWorldCount,
  });
  const diagnostics = new Map<string, SupportDiagnostic>();
  const run = runPhase6Calibration(phase6Plan, {
    scenarioSeeds: schedule.map((entry) => entry.runnerSeed),
    allowPartialScenarioSeeds: input.scheduleSlice !== undefined,
    behaviorBeliefConfig:
      behaviorBeliefConfigFromSelectedArtifact(behaviorModel),
    feasibleSupportRegularizer: {
      pseudocountPerFeasibleLabel: 0,
    },
    onFeasibleSupportDiagnostic: (diagnostic) => {
      const key = diagnosticKey(diagnostic.pairId, diagnostic.arm);
      if (diagnostics.has(key)) {
        fail(`duplicate support diagnostic ${key}.`);
      }
      diagnostics.set(key, diagnostic);
    },
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  });

  const failuresByGame = new Map<string, number>();
  for (const failure of run.failures) {
    if (failure.gameId === null) {
      continue;
    }
    failuresByGame.set(
      failure.gameId,
      (failuresByGame.get(failure.gameId) ?? 0) + 1,
    );
  }
  const games = schedule.map((entry) => {
    const failureCount = failuresByGame.get(entry.gameId) ?? 0;
    const projection = {
      schemaVersion: 1 as const,
      recordType: "phase8-support-tune-game" as const,
      planSha256: input.plan.planSha256,
      styleCellId: entry.styleCellId,
      baseIndex: entry.baseIndex,
      rotation: entry.rotation,
      styleBaseClusterId: entry.styleBaseClusterId,
      gameId: entry.gameId,
      seedCommitmentSha256: entry.seedCommitmentSha256,
      completed: !run.failures.some(
        (failure) =>
          failure.gameId === entry.gameId && failure.kind === "simulation",
      ),
      failureCount,
    };
    return Object.freeze({
      ...projection,
      recordSha256: phase8Sha256(gameRecordProjection(projection)),
    });
  });
  const scheduleByGame = new Map(
    schedule.map((entry) => [entry.gameId, entry] as const),
  );
  const truths = truthByPair(run.truths);
  const observations: Phase8SupportTuneObservationRecord[] = [];
  for (const prediction of run.predictions.filter(primaryPrediction)) {
    const diagnostic = diagnostics.get(
      diagnosticKey(prediction.pairId, prediction.arm),
    );
    const truth = truths.get(prediction.pairId);
    const scheduleEntry = scheduleByGame.get(prediction.gameId);
    if (
      diagnostic === undefined ||
      truth === undefined ||
      scheduleEntry === undefined ||
      diagnostic.target.kind !== "query" ||
      diagnostic.target.family !== prediction.target.family
    ) {
      fail(`prediction ${prediction.predictionId} is not exactly accounted.`);
    }
    const projection = {
      schemaVersion: 1 as const,
      recordType: "phase8-support-tune-observation-eval-only" as const,
      planSha256: input.plan.planSha256,
      observationId: stableHash({
        schemaVersion: 1,
        planSha256: input.plan.planSha256,
        pairId: prediction.pairId,
        arm: prediction.arm,
      }),
      pairId: prediction.pairId,
      arm: prediction.arm,
      family: prediction.target.family,
      queryId: prediction.target.queryKey,
      styleCellId: scheduleEntry.styleCellId,
      baseIndex: scheduleEntry.baseIndex,
      rotation: scheduleEntry.rotation,
      styleBaseClusterId: scheduleEntry.styleBaseClusterId,
      gameId: prediction.gameId,
      stateId: prediction.stateId,
      hardKnown: diagnostic.hardKnown,
      feasibleLabels: [...diagnostic.feasibleLabels],
      rawDistribution: diagnostic.rawDistribution.map((entry) => ({
        ...entry,
      })),
      effectiveSampleSize: diagnostic.effectiveSampleSize,
      scoreStatus: truth.scoreStatus,
      realizedLabel: truth.targetLabel,
    };
    observations.push(
      Object.freeze({
        ...projection,
        recordSha256: phase8Sha256(observationRecordProjection(projection)),
      }),
    );
  }
  observations.sort(
    (left, right) =>
      compareText(left.gameId, right.gameId) ||
      compareText(left.stateId, right.stateId) ||
      compareText(left.queryId, right.queryId) ||
      compareText(left.arm, right.arm),
  );
  if (input.scheduleSlice !== undefined) {
    const completeStyleBaseClusters = completeClusterCount(games);
    const runFailureCount = run.failures.length;
    const evidenceSha256 = phase8SupportTuneEvidenceSha256({
      plan: input.plan,
      behaviorModel,
      games,
      observations,
    });
    return Object.freeze({
      plan: input.plan,
      behaviorModel,
      games: Object.freeze(games),
      observations: Object.freeze(observations),
      candidateEvaluations: Object.freeze([]),
      integrity: Object.freeze({
        scheduledGames: input.plan.scheduledGames,
        completedGames: games.filter((game) => game.completed).length,
        expectedStyleBaseClusters: input.plan.scheduledStyleBaseClusters,
        completeStyleBaseClusters,
        incompleteStyleBaseClusters:
          input.plan.scheduledStyleBaseClusters - completeStyleBaseClusters,
        runFailureCount,
        structuralFailureCount: input.plan.scheduledGames - games.length,
        candidateAccountingExpected: 0,
        candidateAccountingActual: 0,
        rawZeroFeasibleTruthCount: rawZeroFeasibleTruths(observations),
        hardKnownViolationCount: hardKnownViolations(observations),
        passed: false,
      }),
      evidenceSha256,
      selection: null,
      provisionalSelectedPseudocount: 0.25,
    });
  }
  const scored = scorePhase8SupportTuneCandidates({
    plan: input.plan,
    games,
    observations,
    runFailureCount: run.failures.length,
  });
  const evidenceSha256 = phase8SupportTuneEvidenceSha256({
    plan: input.plan,
    behaviorModel,
    games,
    observations,
  });
  const winner = deterministicCandidateWinner(scored.evaluations);
  let selection: Phase8SupportRegularizerTuneSelection | null = null;
  if (input.plan.mode === "evidence") {
    if (
      !scored.integrity.passed ||
      scored.integrity.completeStyleBaseClusters !==
        PHASE8_SUPPORT_TUNE_EVIDENCE_CLUSTER_COUNT
    ) {
      fail(
        `evidence selection has integrity failures: ${stableStringify(scored.integrity)}`,
      );
    }
    selection = createPhase8SupportRegularizerTuneSelection({
      sourceSha256: input.plan.sourceSha256,
      tuneArtifactSha256: evidenceSha256,
      tuneDatasetHash: input.plan.behaviorTuneDatasetHash,
      scorerSha256: input.plan.scorerSha256,
      queryPlanSha256: input.plan.queryPlanSha256,
      candidates: scored.evaluations.map((evaluation) => evaluation.score),
    });
  }
  return Object.freeze({
    plan: input.plan,
    behaviorModel,
    games: Object.freeze(games),
    observations: Object.freeze(observations),
    candidateEvaluations: scored.evaluations,
    integrity: scored.integrity,
    evidenceSha256,
    selection,
    provisionalSelectedPseudocount: winner.score.pseudocountPerFeasibleLabel,
  });
}

export function assertPhase8SupportTuneArtifactEligible(
  run: Phase8SupportTuneRunResult,
): true {
  verifyPlanShape(run.plan);
  if (!run.integrity.passed) {
    fail("an artifact cannot be written with nonzero integrity failures.");
  }
  if (
    run.plan.mode === "evidence" &&
    (run.selection === null ||
      run.integrity.completeStyleBaseClusters !==
        PHASE8_SUPPORT_TUNE_EVIDENCE_CLUSTER_COUNT)
  ) {
    fail("evidence artifacts require the exact selected 960-cluster result.");
  }
  return true;
}
