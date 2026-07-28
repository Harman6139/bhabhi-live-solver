import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { CANONICAL_RULES } from "../domain/rule-config";
import { BEHAVIOR_MODEL_HASH } from "../inference/behavior-models";
import {
  captureEnvironment,
  captureSourceSnapshot,
  type SourceSnapshot,
} from "../evaluation/artifacts";
import type { EnvironmentArtifact } from "../evaluation/artifact-schema";
import { stableHash, stableStringify } from "../events/stable-hash";
import {
  PHASE6_BEHAVIOR_DISABLED_REASON,
  calibrationManifestSchema,
  type CalibrationManifest,
  type CalibrationSummary,
} from "./artifact-schema";
import type { CalibrationArtifactRun } from "./artifacts";
import {
  calibrationScenarioSeeds,
  expectedPhase6CalibrationGames,
  phase6CalibrationScheduleHash,
  phase6CalibrationScientificPlanHash,
} from "./protocol";
import {
  PHASE6_CALIBRATION_FEATURE_BUNDLE_HASH,
  phase6CalibrationQueryPlanHash,
  type Phase6CalibrationRunResult,
} from "./runner";
import {
  CALIBRATION_SUMMARIZER_VERSION,
  summarizePhase6Calibration,
} from "./summary";

export type BuildPhase6CalibrationArtifactsOptions = {
  readonly projectRoot?: string;
  readonly command: string;
  readonly createdAt?: string;
  readonly bootstrapResamples?: number;
  readonly bootstrapSeed?: string;
  readonly powerMode?: string;
  readonly sourceSnapshot?: SourceSnapshot;
  readonly environment?: EnvironmentArtifact;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalNdjson(values: readonly unknown[]): string {
  return values.length === 0
    ? ""
    : `${values.map((value) => stableStringify(value)).join("\n")}\n`;
}

export function phase6CalibrationCheckpointPlanHash(
  result: Pick<Phase6CalibrationRunResult, "plan">,
): string {
  return stableHash({
    schemaVersion: 1,
    opponentDecisionOrdinals: result.plan.opponentDecisionOrdinals,
    fixedPublicEventOrdinals: result.plan.fixedPublicEventOrdinals,
    maximumPreActionCheckpointsPerGame:
      result.plan.maximumPreActionCheckpointsPerGame,
    maximumPostEventCheckpointsPerGame:
      result.plan.maximumPostEventCheckpointsPerGame,
    checkpointClasses: result.plan.checkpointClasses,
    checkpointTiming: "prequential-mixed-frozen-checkpoints",
  });
}

export function phase6CalibrationScorerHash(): string {
  return stableHash({
    schemaVersion: 1,
    summarizerVersion: CALIBRATION_SUMMARIZER_VERSION,
    brier: "binary-squared-and-multiclass-half-sum-squared",
    logLossEpsilon: 1e-12,
    reliabilityBins: "10-fixed-width-one-vs-rest",
    nesting: "query-family-state-trajectory-cluster",
    bootstrap: "paired-calibration-trajectory-cluster-percentile",
  });
}

function behaviorConfigHash(result: Phase6CalibrationRunResult): string {
  const hashes = new Set(
    result.predictions.map((prediction) => prediction.configHash),
  );
  if (hashes.size !== 1) {
    throw new Error(
      "Phase 6 calibration requires exactly one frozen behavior configuration.",
    );
  }
  const value = hashes.values().next().value;
  if (typeof value !== "string") {
    throw new Error("Phase 6 calibration behavior configuration is missing.");
  }
  return value;
}

function actualCounts(result: Phase6CalibrationRunResult) {
  return {
    seedRecords: result.seeds.length,
    attemptedGames: result.attemptedGames,
    completedGames: result.completedGames,
    attemptedCheckpoints: result.attemptedCheckpoints,
    completedCheckpoints: result.completedCheckpoints,
    predictions: result.predictions.length,
    pairs: new Set(result.predictions.map((prediction) => prediction.pairId))
      .size,
    truthRecords: result.truths.length,
    failures: result.failures.length,
  };
}

function expectedCounts(result: Phase6CalibrationRunResult) {
  const games = expectedPhase6CalibrationGames(result.plan);
  return {
    seedRecords: games,
    attemptedGames: games,
    completedGames: games,
    attemptedCheckpoints: result.attemptedCheckpoints,
    completedCheckpoints: result.attemptedCheckpoints,
    predictions: result.predictions.length,
    pairs: new Set(result.predictions.map((prediction) => prediction.pairId))
      .size,
    truthRecords: result.truths.length,
    failures: 0,
  };
}

function manifest(input: {
  readonly result: Phase6CalibrationRunResult;
  readonly createdAt: string;
  readonly source: Awaited<ReturnType<typeof captureSourceSnapshot>>;
  readonly command: string;
  readonly bootstrapResamples: number;
  readonly bootstrapSeed: string;
}): CalibrationManifest {
  const plan = input.result.plan;
  return calibrationManifestSchema.parse({
    schemaVersion: 1,
    artifactSchemaVersion: 2,
    runnerVersion: plan.runnerVersion,
    protocolId: "eval-v1",
    runId: plan.runId,
    split: plan.split,
    evidenceClass: plan.evidenceClass,
    evidenceEligible: plan.evidenceEligible,
    createdAt: input.createdAt,
    ...input.source,
    protocolPlanSha256: sha256(stableStringify(plan)),
    ruleProfileId: "canonical-v1",
    rules: CANONICAL_RULES,
    rulesHash: stableHash(CANONICAL_RULES),
    userPolicyId: plan.userPolicyId,
    styleCellIds: plan.styleCellIds,
    baseIndexStart: plan.baseIndexStart,
    baseCount: plan.baseCount,
    rotations: plan.rotations,
    replicate: plan.replicate,
    expectedGames: expectedPhase6CalibrationGames(plan),
    hardWorldSamples: plan.hardWorldSamples,
    queryFamilies: plan.queryFamilies,
    opponentDecisionOrdinals: plan.opponentDecisionOrdinals,
    fixedPublicEventOrdinals: plan.fixedPublicEventOrdinals,
    maximumPreActionCheckpointsPerGame: plan.maximumPreActionCheckpointsPerGame,
    maximumPostEventCheckpointsPerGame: plan.maximumPostEventCheckpointsPerGame,
    checkpointClasses: plan.checkpointClasses,
    rngAlgorithm: "splitmix64-counter-v1",
    seedDerivation: "eval-v1-sha256-roots-plus-keyed-counter-streams",
    recordOrder: "style-cell-base-index-rotation-checkpoint-query-arm",
    scheduleHash: phase6CalibrationScheduleHash(plan),
    modelBundleHash: BEHAVIOR_MODEL_HASH,
    behaviorConfigHash: behaviorConfigHash(input.result),
    featureBundleHash: PHASE6_CALIBRATION_FEATURE_BUNDLE_HASH,
    scorerHash: phase6CalibrationScorerHash(),
    checkpointPlanHash: phase6CalibrationCheckpointPlanHash(input.result),
    queryPlanHash: phase6CalibrationQueryPlanHash(plan),
    seedManifestHash: stableHash(input.result.seeds),
    binEdges: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
    logLossEpsilon: 1e-12,
    conditionalProbabilityFloor: plan.conditionalProbabilityFloor,
    bootstrapResamples: input.bootstrapResamples,
    bootstrapSeedId: input.bootstrapSeed,
    clusterDefinition:
      "calibration-trajectory-keeps-all-checkpoints-queries-and-rotations",
    predictionTiming: "prequential-predict-before-update",
    truthBoundary: "truth-sidecar-joined-only-by-calibration-scorer",
    expectedCounts: expectedCounts(input.result),
    actualCounts: actualCounts(input.result),
    expectedCheckpointClassCounts: input.result.checkpointClassCounts,
    actualCheckpointClassCounts: input.result.checkpointClassCounts,
    rawStreamsSha256: {
      seedsSha256: sha256(canonicalNdjson(input.result.seeds)),
      predictionsSha256: sha256(canonicalNdjson(input.result.predictions)),
      truthsSha256: sha256(canonicalNdjson(input.result.truths)),
      failuresSha256: sha256(canonicalNdjson(input.result.failures)),
    },
    behaviorProductionEnabled: false,
    behaviorEnablementReason: PHASE6_BEHAVIOR_DISABLED_REASON,
    command: input.command,
  });
}

export function phase6CalibrationSourceSnapshotsEqual(
  before: SourceSnapshot,
  after: SourceSnapshot,
): boolean {
  return stableStringify(before) === stableStringify(after);
}

export function assertPhase6CalibrationSourceUnchanged(
  before: SourceSnapshot,
  after: SourceSnapshot,
): void {
  if (!phase6CalibrationSourceSnapshotsEqual(before, after)) {
    throw new Error(
      "Project source or Git state changed during calibration execution; no evidence artifact may be emitted.",
    );
  }
}

export function renderPhase6CalibrationCommand(
  args: readonly string[],
): string {
  return ["npm", "run", "eval:calibration", "--", ...args]
    .map((part) =>
      /^[a-zA-Z0-9_./:\\-]+$/u.test(part) ? part : JSON.stringify(part),
    )
    .join(" ");
}

export function renderPhase6CalibrationRunLog(
  summary: CalibrationSummary,
): string {
  return [
    `status=${summary.zeroFailureGate ? "complete" : "failed"}`,
    `attemptedGames=${summary.attemptedGames.toString()}`,
    `completedGames=${summary.completedGames.toString()}`,
    `attemptedCheckpoints=${summary.attemptedCheckpoints.toString()}`,
    `completedCheckpoints=${summary.completedCheckpoints.toString()}`,
    `predictions=${summary.predictions.toString()}`,
    `truthRecords=${summary.truthRecords.toString()}`,
    `skippedConditionalPairs=${summary.skippedConditionalPairs.toString()}`,
    `failures=${summary.failures.toString()}`,
    `behaviorProductionEnabled=${summary.behaviorProductionEnabled ? "true" : "false"}`,
    `reproductionDigest=${summary.reproductionDigest}`,
    "",
  ].join("\n");
}

export async function buildPhase6CalibrationArtifactRun(
  result: Phase6CalibrationRunResult,
  options: BuildPhase6CalibrationArtifactsOptions,
): Promise<CalibrationArtifactRun> {
  const projectRoot = resolve(options.projectRoot ?? ".");
  const createdAt =
    options.createdAt ??
    options.environment?.capturedAt ??
    new Date().toISOString();
  const bootstrapResamples = options.bootstrapResamples ?? 20_000;
  if (!Number.isSafeInteger(bootstrapResamples) || bootstrapResamples < 1) {
    throw new RangeError(
      "Calibration bootstrap resamples must be a positive safe integer.",
    );
  }
  const bootstrapSeed =
    options.bootstrapSeed ??
    stableHash({
      schemaVersion: 1,
      protocolId: result.plan.protocolId,
      split: result.plan.split,
      scientificPlanHash: phase6CalibrationScientificPlanHash(result.plan),
      scenarioSeeds: calibrationScenarioSeeds(result.plan),
      stream: "calibration-paired-bootstrap",
    });
  const source =
    options.sourceSnapshot ?? (await captureSourceSnapshot(projectRoot));
  const environment =
    options.environment ??
    captureEnvironment(
      createdAt,
      options.powerMode ?? "not-programmatically-available",
    );
  if (environment.capturedAt !== createdAt) {
    throw new Error(
      "Provided calibration environment timestamp differs from createdAt.",
    );
  }
  const summaryResult = summarizePhase6Calibration(result, {
    bootstrapResamples,
    bootstrapSeed,
  });
  const runManifest = manifest({
    result,
    createdAt,
    source,
    command: options.command,
    bootstrapResamples,
    bootstrapSeed,
  });
  const log = renderPhase6CalibrationRunLog(summaryResult.summary);
  return {
    manifest: runManifest,
    environment,
    seeds: result.seeds,
    predictions: result.predictions,
    truths: result.truths,
    failures: result.failures,
    summary: summaryResult.summary,
    summaryMarkdown: summaryResult.markdown,
    log,
  };
}
