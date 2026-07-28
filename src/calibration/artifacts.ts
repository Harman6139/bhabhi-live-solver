import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { CANONICAL_RULES } from "../domain/rule-config";
import { STYLE_CELLS } from "../evaluation/protocol";
import { stableHash, stableStringify } from "../events/stable-hash";
import {
  environmentArtifactSchema,
  type EnvironmentArtifact,
} from "../evaluation/artifact-schema";
import {
  calibrationFailureRecordSchema,
  calibrationManifestSchema,
  calibrationPredictionRecordSchema,
  calibrationSeedRecordSchema,
  calibrationSummarySchema,
  calibrationTruthRecordSchema,
  type CalibrationFailureRecord,
  type CalibrationManifest,
  type CalibrationPredictionRecord,
  type CalibrationSeedRecord,
  type CalibrationSummary,
  type CalibrationTruthRecord,
} from "./artifact-schema";
import {
  DEVELOPMENT_STYLE_CELL_IDS,
  FITTABLE_STYLE_CELL_IDS,
  PHASE6_CALIBRATION_CHECKPOINT_CLASSES,
  calibrationScenarioSeeds,
  expectedPhase6CalibrationGames,
  phase6CalibrationScenarioIdentity,
  phase6CalibrationScheduleHash,
  type Phase6CalibrationPlan,
} from "./protocol";
import {
  PHASE6_CALIBRATION_FEATURE_BUNDLE_HASH,
  phase6CalibrationQueryPlanHash,
  runPhase6Calibration,
} from "./runner";
import {
  phase6CalibrationCheckpointPlanHash,
  phase6CalibrationScorerHash,
  renderPhase6CalibrationRunLog,
} from "./run-artifacts";
import {
  calibrationScientificReproductionDigest,
  deriveCalibrationScoring,
  renderCalibrationSummaryMarkdown,
} from "./summary";
import { BEHAVIOR_MODEL_HASH } from "../inference/behavior-models";

const PAYLOAD_FILES = [
  "calibration-predictions.ndjson",
  "command.txt",
  "environment.json",
  "failures.ndjson",
  "logs/run.log",
  "manifest.json",
  "seeds.ndjson",
  "summary.json",
  "summary.md",
  "truth.eval-only.ndjson",
] as const;
const ALL_FILES = [...PAYLOAD_FILES, "checksums.sha256"].sort();
const NORMALIZATION_TOLERANCE = 1e-12;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._-]{2,79}$/u;

export type CalibrationArtifactRun = {
  readonly manifest: CalibrationManifest;
  readonly environment: EnvironmentArtifact;
  readonly seeds: readonly CalibrationSeedRecord[];
  readonly predictions: readonly CalibrationPredictionRecord[];
  readonly truths: readonly CalibrationTruthRecord[];
  readonly failures: readonly CalibrationFailureRecord[];
  readonly summary: CalibrationSummary;
  readonly summaryMarkdown: string;
  readonly log: string;
};

export type CalibrationArtifactVerification = {
  readonly valid: boolean;
  readonly runDirectory: string;
  readonly checkedFiles: number;
  readonly seedsValidated: number;
  readonly predictionsValidated: number;
  readonly pairsValidated: number;
  readonly failures: readonly string[];
  readonly reproductionDigest: string | null;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function ndjson(values: readonly unknown[]): string {
  return values.length === 0
    ? ""
    : `${values.map((value) => stableStringify(value)).join("\n")}\n`;
}

function normalizedDistribution(
  record: CalibrationPredictionRecord,
  failures: string[],
): void {
  const labels = record.distribution.map((entry) => entry.label);
  if (new Set(labels).size !== labels.length) {
    failures.push(`${record.predictionId} contains duplicate labels.`);
  }
  const targetLabels =
    record.target.kind === "opponent-action"
      ? record.target.legalActionKeys
      : record.target.labels;
  if (
    stableStringify([...labels].sort()) !==
    stableStringify([...targetLabels].sort())
  ) {
    failures.push(
      `${record.predictionId} distribution labels differ from its target labels.`,
    );
  }
  const total = record.distribution.reduce(
    (sum, entry) => sum + entry.probability,
    0,
  );
  if (Math.abs(total - 1) > NORMALIZATION_TOLERANCE) {
    failures.push(
      `${record.predictionId} probabilities sum to ${total.toString()} instead of 1.`,
    );
  }
  if (
    record.target.kind === "opponent-action" &&
    record.checkpointTiming !== "pre-action"
  ) {
    failures.push(
      `${record.predictionId} action prediction is not pre-action.`,
    );
  }
  if (
    record.uniqueWitnesses > record.worldOccurrences ||
    record.effectiveSampleSize >
      record.worldOccurrences + NORMALIZATION_TOLERANCE ||
    record.maximumWorldWeight <
      1 / record.worldOccurrences - NORMALIZATION_TOLERANCE
  ) {
    failures.push(`${record.predictionId} has inconsistent world diagnostics.`);
  }
}

function pairSignature(record: CalibrationPredictionRecord): string {
  return stableStringify({
    runId: record.runId,
    split: record.split,
    pairId: record.pairId,
    gameId: record.gameId,
    scenarioId: record.scenarioId,
    calibrationClusterId: record.calibrationClusterId,
    stateId: record.stateId,
    checkpointId: record.checkpointId,
    checkpointEventIndex: record.checkpointEventIndex,
    checkpointTiming: record.checkpointTiming,
    publicHistoryHash: record.publicHistoryHash,
    publicStateHash: record.publicStateHash,
    stateVersion: record.stateVersion,
    target: record.target,
    hardKnown: record.hardKnown,
    worldOccurrences: record.worldOccurrences,
    uniqueWitnesses: record.uniqueWitnesses,
    hardWorldSetChecksum: record.hardWorldSetChecksum,
    hardBeliefConfigHash: record.hardBeliefConfigHash,
    modelBundleHash: record.modelBundleHash,
    featureBundleHash: record.featureBundleHash,
    queryPlanHash: record.queryPlanHash,
    configHash: record.configHash,
    seedId: record.seedId,
  });
}

function reproductionDigest(run: {
  readonly seeds: readonly CalibrationSeedRecord[];
  readonly predictions: readonly CalibrationPredictionRecord[];
  readonly truths: readonly CalibrationTruthRecord[];
  readonly failures: readonly CalibrationFailureRecord[];
}): string {
  return calibrationScientificReproductionDigest(run);
}

function planFromManifest(
  manifest: CalibrationManifest,
): Phase6CalibrationPlan {
  return Object.freeze({
    schemaVersion: 1,
    runnerVersion: manifest.runnerVersion,
    protocolId: "eval-v1",
    runId: manifest.runId,
    split: manifest.split,
    evidenceClass: "phase6-calibration-smoke",
    evidenceEligible: false,
    userPolicyId: manifest.userPolicyId,
    styleCellIds: Object.freeze([...manifest.styleCellIds]),
    baseIndexStart: manifest.baseIndexStart,
    baseCount: manifest.baseCount,
    rotations: Object.freeze([...manifest.rotations]),
    replicate: manifest.replicate,
    opponentDecisionOrdinals: Object.freeze([
      ...manifest.opponentDecisionOrdinals,
    ]),
    fixedPublicEventOrdinals: Object.freeze([
      ...manifest.fixedPublicEventOrdinals,
    ]),
    maximumPreActionCheckpointsPerGame:
      manifest.maximumPreActionCheckpointsPerGame,
    maximumPostEventCheckpointsPerGame:
      manifest.maximumPostEventCheckpointsPerGame,
    checkpointClasses: PHASE6_CALIBRATION_CHECKPOINT_CLASSES,
    hardWorldSamples: manifest.hardWorldSamples,
    conditionalProbabilityFloor: manifest.conditionalProbabilityFloor,
    queryFamilies: manifest.queryFamilies,
    behaviorProductionEnabled: false,
  });
}

function expectedSeedRecords(
  manifest: CalibrationManifest,
  plan: Phase6CalibrationPlan,
): readonly CalibrationSeedRecord[] {
  return calibrationScenarioSeeds(plan).map((seed) => {
    const identity = phase6CalibrationScenarioIdentity(plan, seed);
    return calibrationSeedRecordSchema.parse({
      schemaVersion: 1,
      protocolId: "eval-v1",
      recordType: "calibration-seed",
      runId: manifest.runId,
      split: manifest.split,
      gameId: identity.gameId,
      scenarioId: identity.scenarioId,
      calibrationClusterId: identity.calibrationClusterId,
      styleCellId: seed.styleCellId,
      baseIndex: seed.baseIndex,
      rotation: seed.rotation,
      replicate: seed.replicate,
      seeds: {
        deal: seed.deal,
        p2Policy: seed.p2Policy,
        p3Policy: seed.p3Policy,
        chance: seed.chance,
        belief: seed.belief,
        bootstrap: seed.bootstrap,
      },
    });
  });
}

export function validateCalibrationSeedSchedule(
  manifestValue: CalibrationManifest,
  seedsValue: readonly CalibrationSeedRecord[],
): readonly string[] {
  const manifest = calibrationManifestSchema.parse(manifestValue);
  const seeds = calibrationSeedRecordSchema.array().parse(seedsValue);
  const plan = planFromManifest(manifest);
  return stableStringify(seeds) ===
    stableStringify(expectedSeedRecords(manifest, plan))
    ? []
    : [
        "Calibration seeds do not match the exact frozen cell/base/rotation cross-product and deterministic seed derivation.",
      ];
}

function recordCounts(run: {
  readonly seeds: readonly CalibrationSeedRecord[];
  readonly predictions: readonly CalibrationPredictionRecord[];
  readonly truths: readonly CalibrationTruthRecord[];
  readonly failures: readonly CalibrationFailureRecord[];
  readonly summary: CalibrationSummary;
}) {
  return {
    seedRecords: run.seeds.length,
    attemptedGames: run.summary.attemptedGames,
    completedGames: run.summary.completedGames,
    attemptedCheckpoints: run.summary.attemptedCheckpoints,
    completedCheckpoints: run.summary.completedCheckpoints,
    predictions: run.predictions.length,
    pairs: new Set(run.predictions.map((prediction) => prediction.pairId)).size,
    truthRecords: run.truths.length,
    failures: run.failures.length,
  };
}

function rawStreamHashes(run: {
  readonly seeds: readonly CalibrationSeedRecord[];
  readonly predictions: readonly CalibrationPredictionRecord[];
  readonly truths: readonly CalibrationTruthRecord[];
  readonly failures: readonly CalibrationFailureRecord[];
}) {
  return {
    seedsSha256: sha256(ndjson(run.seeds)),
    predictionsSha256: sha256(ndjson(run.predictions)),
    truthsSha256: sha256(ndjson(run.truths)),
    failuresSha256: sha256(ndjson(run.failures)),
  };
}

export function validateCalibrationArtifactRun(
  run: CalibrationArtifactRun,
): readonly string[] {
  const failures: string[] = [];
  const manifest = calibrationManifestSchema.parse(run.manifest);
  const environment = environmentArtifactSchema.parse(run.environment);
  const seeds = calibrationSeedRecordSchema.array().parse(run.seeds);
  const predictions = calibrationPredictionRecordSchema
    .array()
    .parse(run.predictions);
  const truths = calibrationTruthRecordSchema.array().parse(run.truths);
  const failureRecords = calibrationFailureRecordSchema
    .array()
    .parse(run.failures);
  const summary = calibrationSummarySchema.parse(run.summary);
  const plan = planFromManifest(manifest);

  if (!SAFE_RUN_ID.test(manifest.runId)) {
    failures.push("Manifest run ID is not filesystem-safe.");
  }
  if (environment.capturedAt !== manifest.createdAt) {
    failures.push("Environment and manifest capture timestamps differ.");
  }
  for (const record of [
    ...seeds,
    ...predictions,
    ...truths,
    ...failureRecords,
  ]) {
    if (record.runId !== manifest.runId || record.split !== manifest.split) {
      failures.push(
        `${record.recordType} record does not match manifest run/split.`,
      );
    }
  }
  if (
    summary.runId !== manifest.runId ||
    summary.split !== manifest.split ||
    summary.evidenceClass !== manifest.evidenceClass ||
    summary.evidenceEligible !== manifest.evidenceEligible
  ) {
    failures.push("Summary identity does not match the manifest.");
  }
  const requiredStyleCellIds =
    manifest.split === "dev"
      ? DEVELOPMENT_STYLE_CELL_IDS
      : FITTABLE_STYLE_CELL_IDS;
  if (
    stableStringify(manifest.styleCellIds) !==
      stableStringify(requiredStyleCellIds) ||
    stableStringify(manifest.rotations) !== stableStringify([0, 1, 2]) ||
    stableStringify(manifest.opponentDecisionOrdinals) !==
      stableStringify([2, 5, 8]) ||
    stableStringify(manifest.fixedPublicEventOrdinals) !==
      stableStringify([12, 24, 36]) ||
    manifest.maximumPreActionCheckpointsPerGame !== 6 ||
    manifest.maximumPostEventCheckpointsPerGame !== 7 ||
    stableStringify(manifest.checkpointClasses) !==
      stableStringify(PHASE6_CALIBRATION_CHECKPOINT_CLASSES)
  ) {
    failures.push(
      "Manifest does not preserve the frozen Phase 6 style/rotation/checkpoint schedule.",
    );
  }
  if (
    stableStringify(manifest.rules) !== stableStringify(CANONICAL_RULES) ||
    manifest.rulesHash !== stableHash(CANONICAL_RULES) ||
    manifest.expectedGames !== expectedPhase6CalibrationGames(plan) ||
    manifest.protocolPlanSha256 !== sha256(stableStringify(plan)) ||
    manifest.scheduleHash !== phase6CalibrationScheduleHash(plan) ||
    manifest.modelBundleHash !== BEHAVIOR_MODEL_HASH ||
    manifest.featureBundleHash !== PHASE6_CALIBRATION_FEATURE_BUNDLE_HASH ||
    manifest.scorerHash !== phase6CalibrationScorerHash() ||
    manifest.checkpointPlanHash !==
      phase6CalibrationCheckpointPlanHash({ plan }) ||
    manifest.queryPlanHash !== phase6CalibrationQueryPlanHash(plan)
  ) {
    failures.push(
      "Manifest rule, plan, schedule, model, feature, scorer, checkpoint, or query hash does not regenerate.",
    );
  }

  const seedGameIds = new Set<string>();
  const seedByGame = new Map<string, CalibrationSeedRecord>();
  for (const seed of seeds) {
    if (seedGameIds.has(seed.gameId)) {
      failures.push(`Duplicate calibration seed game ${seed.gameId}.`);
    }
    seedGameIds.add(seed.gameId);
    seedByGame.set(seed.gameId, seed);
  }
  if (manifest.seedManifestHash !== stableHash(seeds)) {
    failures.push("Manifest seed hash does not regenerate.");
  }
  failures.push(...validateCalibrationSeedSchedule(manifest, seeds));

  const predictionIds = new Set<string>();
  const behaviorConfigHashes = new Set<string>();
  const pairs = new Map<string, CalibrationPredictionRecord[]>();
  for (const prediction of predictions) {
    if (predictionIds.has(prediction.predictionId)) {
      failures.push(`Duplicate prediction ID ${prediction.predictionId}.`);
    }
    predictionIds.add(prediction.predictionId);
    behaviorConfigHashes.add(prediction.configHash);
    const matchingSeed = seedByGame.get(prediction.gameId);
    if (matchingSeed === undefined) {
      failures.push(
        `${prediction.predictionId} references a game with no seed record.`,
      );
    } else if (
      prediction.scenarioId !== matchingSeed.scenarioId ||
      prediction.calibrationClusterId !== matchingSeed.calibrationClusterId
    ) {
      failures.push(
        `${prediction.predictionId} scenario or calibration cluster differs from its seed record.`,
      );
    }
    if (
      prediction.evidenceClass !== manifest.evidenceClass ||
      prediction.modelBundleHash !== manifest.modelBundleHash ||
      prediction.featureBundleHash !== manifest.featureBundleHash ||
      prediction.queryPlanHash !== manifest.queryPlanHash
    ) {
      failures.push(
        `${prediction.predictionId} does not match the manifest evidence/model/feature/query bundle.`,
      );
    }
    if (
      prediction.target.kind === "query" &&
      prediction.target.family === "conditional" &&
      ((prediction.target.conditioningProbability ?? 0) <
        manifest.conditionalProbabilityFloor ||
        (prediction.armConditioningProbability ?? 0) <
          manifest.conditionalProbabilityFloor)
    ) {
      failures.push(
        `${prediction.predictionId} shared or arm-specific conditional denominator is below the manifest floor.`,
      );
    }
    normalizedDistribution(prediction, failures);
    const pair = pairs.get(prediction.pairId) ?? [];
    pair.push(prediction);
    pairs.set(prediction.pairId, pair);
  }
  if (
    behaviorConfigHashes.size !== 1 ||
    !behaviorConfigHashes.has(manifest.behaviorConfigHash)
  ) {
    failures.push(
      "Calibration predictions do not use the manifest's one frozen behavior configuration.",
    );
  }

  const truthByPair = new Map<string, CalibrationTruthRecord>();
  for (const truth of truths) {
    if (truthByPair.has(truth.pairId)) {
      failures.push(`Duplicate truth record for pair ${truth.pairId}.`);
    }
    truthByPair.set(truth.pairId, truth);
    const matchingSeed = seedByGame.get(truth.gameId);
    if (matchingSeed === undefined) {
      failures.push(
        `Truth record ${truth.pairId} references a game with no seed record.`,
      );
    } else {
      const style = STYLE_CELLS.find(
        (candidate) => candidate.id === matchingSeed.styleCellId,
      );
      if (
        style === undefined ||
        truth.trueOpponentModels.p2 !== style.p2 ||
        truth.trueOpponentModels.p3 !== style.p3
      ) {
        failures.push(
          `Truth record ${truth.pairId} opponent models differ from its eval-only seed style.`,
        );
      }
    }
  }
  for (const [pairId, pair] of pairs) {
    const arms = pair.map((record) => record.arm).sort();
    if (
      pair.length !== 2 ||
      stableStringify(arms) !== stableStringify(["behavioral", "hard-only"])
    ) {
      failures.push(
        `${pairId} must contain exactly one hard-only and one behavioral prediction.`,
      );
      continue;
    }
    const first = pair[0];
    const second = pair[1];
    if (
      first === undefined ||
      second === undefined ||
      pairSignature(first) !== pairSignature(second)
    ) {
      failures.push(`${pairId} arms do not describe the same target/state.`);
      continue;
    }
    const truth = truthByPair.get(pairId);
    if (truth === undefined) {
      failures.push(`${pairId} has no eval-only truth record.`);
      continue;
    }
    if (truth.gameId !== first.gameId || truth.stateId !== first.stateId) {
      failures.push(`${pairId} truth joins to a different game/state.`);
    }
    if (truth.scoreStatus === "conditioning-false") {
      if (
        first.target.kind !== "query" ||
        first.target.family !== "conditional"
      ) {
        failures.push(
          `${pairId} marks a non-conditional target as conditioning-false.`,
        );
      }
    } else {
      const targetLabel = truth.targetLabel;
      if (targetLabel === null) {
        failures.push(`${pairId} scored truth has no target label.`);
        continue;
      }
      const labels = first.distribution.map((entry) => entry.label);
      if (!labels.includes(targetLabel)) {
        failures.push(`${pairId} truth label is absent from the prediction.`);
      }
      const action = first.target.kind === "opponent-action";
      if ((truth.forcedAction !== null) !== action) {
        failures.push(`${pairId} has inconsistent forced-action metadata.`);
      }
      if (first.hardKnown) {
        for (const prediction of pair) {
          const truthProbability =
            prediction.distribution.find((entry) => entry.label === targetLabel)
              ?.probability ?? 0;
          if (truthProbability !== 1) {
            failures.push(
              `${pairId} does not preserve a hard-known truth exactly.`,
            );
          }
        }
      }
    }
  }
  for (const pairId of truthByPair.keys()) {
    if (!pairs.has(pairId)) {
      failures.push(`Truth record ${pairId} has no prediction pair.`);
    }
  }

  const digest = reproductionDigest({
    seeds,
    predictions,
    truths,
    failures: failureRecords,
  });
  const completedCheckpointKeys = new Set(
    predictions.map((prediction) =>
      stableStringify({
        gameId: prediction.gameId,
        checkpointId: prediction.checkpointId,
        stateId: prediction.stateId,
      }),
    ),
  );
  const simulationFailures = failureRecords.filter(
    (failure) => failure.kind === "simulation",
  ).length;
  const checkpointFailures = failureRecords.length - simulationFailures;
  const skippedConditionalPairs = truths.filter(
    (truth) => truth.scoreStatus === "conditioning-false",
  ).length;
  const actualRecordCounts = recordCounts({
    seeds,
    predictions,
    truths,
    failures: failureRecords,
    summary,
  });
  if (
    stableStringify(manifest.actualCounts) !==
      stableStringify(actualRecordCounts) ||
    stableStringify(manifest.rawStreamsSha256) !==
      stableStringify(
        rawStreamHashes({
          seeds,
          predictions,
          truths,
          failures: failureRecords,
        }),
      )
  ) {
    failures.push(
      "Manifest actual counts or canonical raw-stream SHA-256 hashes do not regenerate.",
    );
  }
  if (
    manifest.expectedCounts.seedRecords !==
      expectedPhase6CalibrationGames(plan) ||
    manifest.expectedCounts.attemptedGames !==
      expectedPhase6CalibrationGames(plan) ||
    manifest.expectedCounts.completedGames !==
      expectedPhase6CalibrationGames(plan) ||
    manifest.expectedCounts.failures !== 0
  ) {
    failures.push(
      "Manifest expected counts do not preserve the zero-failure frozen game schedule.",
    );
  }
  if (
    summary.zeroFailureGate &&
    (stableStringify(manifest.expectedCounts) !==
      stableStringify(manifest.actualCounts) ||
      stableStringify(manifest.expectedCheckpointClassCounts) !==
        stableStringify(manifest.actualCheckpointClassCounts))
  ) {
    failures.push(
      "A successful run's expected and actual record/checkpoint-class counts differ.",
    );
  }
  if (
    summary.attemptedGames !== seeds.length ||
    summary.completedGames !== seeds.length - simulationFailures ||
    summary.completedCheckpoints !== completedCheckpointKeys.size ||
    summary.attemptedCheckpoints !==
      completedCheckpointKeys.size + checkpointFailures ||
    summary.predictions !== predictions.length ||
    summary.pairedTargets !== pairs.size ||
    summary.truthRecords !== truths.length ||
    summary.skippedConditionalPairs !== skippedConditionalPairs ||
    summary.failures !== failureRecords.length ||
    summary.zeroFailureGate !==
      (failureRecords.length === 0 &&
        seeds.length > 0 &&
        completedCheckpointKeys.size > 0 &&
        predictions.length > 0) ||
    summary.reproductionDigest !== digest
  ) {
    failures.push(
      "Summary run counts, failure gate, or digest do not regenerate.",
    );
  }
  try {
    const derived = deriveCalibrationScoring({
      predictions,
      truths,
      seeds,
      bootstrapResamples: manifest.bootstrapResamples,
      bootstrapSeed: manifest.bootstrapSeedId,
    });
    if (
      stableStringify(summary.scoreLines) !==
        stableStringify(derived.scoreLines) ||
      stableStringify(summary.pairedDifferences) !==
        stableStringify(derived.pairedDifferences) ||
      stableStringify(summary.reliabilityLines) !==
        stableStringify(derived.reliabilityLines) ||
      summary.hardKnownPreserved !== derived.hardKnownPreserved ||
      summary.logicallyPossibleZeroSupport !==
        derived.logicallyPossibleZeroSupport
    ) {
      failures.push(
        "Summary scores, intervals, reliability, or support diagnostics do not regenerate.",
      );
    }
  } catch (error) {
    failures.push(
      `Summary scoring regeneration failed: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (
    run.summaryMarkdown !== renderCalibrationSummaryMarkdown(summary) ||
    run.log !== renderPhase6CalibrationRunLog(summary)
  ) {
    failures.push(
      "Summary markdown or run log does not regenerate byte-for-byte.",
    );
  }
  return failures;
}

async function writeExclusive(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: "utf8", flag: "wx" });
}

async function relativeFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await relativeFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

function runPayloads(
  run: CalibrationArtifactRun,
): Readonly<Record<(typeof PAYLOAD_FILES)[number], string>> {
  return {
    "calibration-predictions.ndjson": ndjson(run.predictions),
    "command.txt": `${run.manifest.command}\n`,
    "environment.json": `${stableStringify(run.environment)}\n`,
    "failures.ndjson": ndjson(run.failures),
    "logs/run.log": run.log.endsWith("\n") ? run.log : `${run.log}\n`,
    "manifest.json": `${stableStringify(run.manifest)}\n`,
    "seeds.ndjson": ndjson(run.seeds),
    "summary.json": `${stableStringify(run.summary)}\n`,
    "summary.md": run.summaryMarkdown.endsWith("\n")
      ? run.summaryMarkdown
      : `${run.summaryMarkdown}\n`,
    "truth.eval-only.ndjson": ndjson(run.truths),
  };
}

export async function writeCalibrationArtifacts(
  run: CalibrationArtifactRun,
  artifactRoot: string,
): Promise<{ readonly runDirectory: string }> {
  const validationFailures = validateCalibrationArtifactRun(run);
  if (validationFailures.length > 0) {
    throw new Error(
      `Calibration artifact run is invalid: ${validationFailures.join(" ")}`,
    );
  }
  const parent = resolve(artifactRoot, "eval-v1", run.manifest.split);
  const target = join(parent, run.manifest.runId);
  await mkdir(parent, { recursive: true });
  try {
    await access(target);
    throw new Error(`Calibration artifact run already exists: ${target}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Calibration artifact run already exists:")
    ) {
      throw error;
    }
  }
  const stage = await mkdtemp(join(parent, `.${run.manifest.runId}.stage-`));
  try {
    const payloads = runPayloads(run);
    await mkdir(join(stage, "logs"));
    for (const name of PAYLOAD_FILES) {
      await writeExclusive(join(stage, name), payloads[name]);
    }
    const checksums = await Promise.all(
      PAYLOAD_FILES.map(async (name) => {
        const bytes = await readFile(join(stage, name));
        return `${sha256(bytes)}  ${name}`;
      }),
    );
    await writeExclusive(
      join(stage, "checksums.sha256"),
      `${checksums.join("\n")}\n`,
    );
    await rename(stage, target);
    return { runDirectory: target };
  } catch (error) {
    await rm(stage, { force: true, recursive: true });
    throw error;
  }
}

function parseNdjson<T>(
  text: string,
  parser: { parse(value: unknown): T },
): T[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => parser.parse(JSON.parse(line) as unknown));
}

export async function verifyCalibrationArtifacts(
  runDirectoryValue: string,
): Promise<CalibrationArtifactVerification> {
  const runDirectory = resolve(runDirectoryValue);
  const failures: string[] = [];
  let checkedFiles = 0;
  let seedsValidated = 0;
  let predictionsValidated = 0;
  let pairsValidated = 0;
  let digest: string | null = null;
  try {
    const files = await relativeFiles(runDirectory);
    if (stableStringify(files) !== stableStringify(ALL_FILES)) {
      failures.push(
        `Artifact file set mismatch: ${files.join(", ") || "empty"}.`,
      );
    }
    const checksumLines = (
      await readFile(join(runDirectory, "checksums.sha256"), "utf8")
    )
      .trim()
      .split(/\r?\n/u);
    const checksums = new Map<string, string>();
    for (const line of checksumLines) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) {
        failures.push(`Malformed checksum line ${JSON.stringify(line)}.`);
      } else {
        if (checksums.has(match[2])) {
          failures.push(`Duplicate checksum entry for ${match[2]}.`);
        }
        checksums.set(match[2], match[1]);
      }
    }
    for (const name of PAYLOAD_FILES) {
      const actual = sha256(await readFile(join(runDirectory, name)));
      if (checksums.get(name) !== actual) {
        failures.push(`Checksum mismatch for ${name}.`);
      }
      checkedFiles += 1;
    }
    if (checksums.size !== PAYLOAD_FILES.length) {
      failures.push("Checksum manifest does not cover each payload exactly.");
    }

    const manifest = calibrationManifestSchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "manifest.json"), "utf8"),
      ) as unknown,
    );
    const environment = environmentArtifactSchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "environment.json"), "utf8"),
      ) as unknown,
    );
    const seeds = parseNdjson(
      await readFile(join(runDirectory, "seeds.ndjson"), "utf8"),
      calibrationSeedRecordSchema,
    );
    const predictions = parseNdjson(
      await readFile(
        join(runDirectory, "calibration-predictions.ndjson"),
        "utf8",
      ),
      calibrationPredictionRecordSchema,
    );
    const truths = parseNdjson(
      await readFile(join(runDirectory, "truth.eval-only.ndjson"), "utf8"),
      calibrationTruthRecordSchema,
    );
    const failureRecords = parseNdjson(
      await readFile(join(runDirectory, "failures.ndjson"), "utf8"),
      calibrationFailureRecordSchema,
    );
    const summary = calibrationSummarySchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "summary.json"), "utf8"),
      ) as unknown,
    );
    const summaryMarkdown = await readFile(
      join(runDirectory, "summary.md"),
      "utf8",
    );
    const log = await readFile(join(runDirectory, "logs/run.log"), "utf8");
    const commandText = await readFile(
      join(runDirectory, "command.txt"),
      "utf8",
    );
    if (commandText !== `${manifest.command}\n`) {
      failures.push("command.txt does not regenerate from manifest.command.");
    }
    const structural = validateCalibrationArtifactRun({
      manifest,
      environment,
      seeds,
      predictions,
      truths,
      failures: failureRecords,
      summary,
      summaryMarkdown,
      log,
    });
    failures.push(...structural);
    try {
      const replayed = runPhase6Calibration(planFromManifest(manifest));
      const replayCounts = {
        seedRecords: replayed.seeds.length,
        attemptedGames: replayed.attemptedGames,
        completedGames: replayed.completedGames,
        attemptedCheckpoints: replayed.attemptedCheckpoints,
        completedCheckpoints: replayed.completedCheckpoints,
        predictions: replayed.predictions.length,
        pairs: new Set(
          replayed.predictions.map((prediction) => prediction.pairId),
        ).size,
        truthRecords: replayed.truths.length,
        failures: replayed.failures.length,
      };
      if (
        stableStringify(replayed.seeds) !== stableStringify(seeds) ||
        stableStringify(replayed.predictions) !==
          stableStringify(predictions) ||
        stableStringify(replayed.truths) !== stableStringify(truths) ||
        stableStringify(replayed.failures) !==
          stableStringify(failureRecords) ||
        stableStringify(replayCounts) !==
          stableStringify(manifest.actualCounts) ||
        stableStringify(replayed.checkpointClassCounts) !==
          stableStringify(manifest.actualCheckpointClassCounts)
      ) {
        failures.push(
          "Deterministic seeded replay does not reproduce raw seeds, predictions, eval-only truth, failures, counts, or checkpoint classes.",
        );
      }
    } catch (error) {
      failures.push(
        `Deterministic calibration replay failed: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    seedsValidated = seeds.length;
    predictionsValidated = predictions.length;
    pairsValidated = new Set(predictions.map((record) => record.pairId)).size;
    digest = reproductionDigest({
      seeds,
      predictions,
      truths,
      failures: failureRecords,
    });
    if (manifest.runId !== basename(runDirectory)) {
      failures.push("Manifest run ID differs from the run directory name.");
    }
  } catch (error) {
    failures.push(
      `Artifact verification failed: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return {
    valid: failures.length === 0,
    runDirectory,
    checkedFiles,
    seedsValidated,
    predictionsValidated,
    pairsValidated,
    failures,
    reproductionDigest: digest,
  };
}

export function calibrationReproductionDigest(input: {
  readonly seeds: readonly CalibrationSeedRecord[];
  readonly predictions: readonly CalibrationPredictionRecord[];
  readonly truths: readonly CalibrationTruthRecord[];
  readonly failures: readonly CalibrationFailureRecord[];
}): string {
  return reproductionDigest(input);
}
