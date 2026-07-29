import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PHASE8_CALIBRATION_PRIMARY_FAMILIES } from "../../src/calibration/phase8-plan";
import {
  createPhase8ConfigurationDescriptor,
  freezePhase8Manifest,
  openPhase8Split,
  phase8Sha256,
  type FrozenPhase8ManifestAuthority,
  type Phase8SplitOpening,
} from "../../src/evaluation/phase8-manifest";
import type { SourceSnapshot } from "../../src/evaluation/artifacts";
import { stableHash, stableStringify } from "../../src/events/stable-hash";
import {
  BEHAVIOR_MODEL_IDS,
  type BehaviorModelId,
} from "../../src/inference/behavior-models";
import {
  BEHAVIOR_FIT_SCORER_HASH,
  behaviorConfigFamilyHash,
  behaviorFitDatasetContentHash,
  behaviorFitDatasetHash,
  createSelectedBehaviorModelArtifact,
  fitTrainBehaviorGrid,
  selectTuneBehaviorModel,
  serializeSelectedBehaviorModelArtifact,
  type BehaviorFitObservation,
  type BehaviorHyperparameterGridInput,
  type SelectedBehaviorModelArtifact,
} from "../../src/modeling/behavior-fit";
import {
  readPhase8SupportTuneArtifact,
  verifyPhase8SupportTuneArtifact,
  writePhase8SupportTuneArtifact,
} from "../../src/modeling/support-tune-artifact";
import {
  PHASE8_SUPPORT_TUNE_EVIDENCE_CLUSTER_COUNT,
  PHASE8_SUPPORT_TUNE_EVIDENCE_GAME_COUNT,
  createPhase8SupportTunePlan,
  iteratePhase8SupportTuneSchedule,
  phase8SupportTuneEvidenceSha256,
  runPhase8SupportTune,
  scorePhase8SupportTuneCandidates,
  type Phase8SupportTuneGameRecord,
  type Phase8SupportTuneObservationRecord,
  type Phase8SupportTunePlan,
  type Phase8SupportTuneRunResult,
} from "../../src/modeling/support-tune";

const SOURCE_SHA256 = "a".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function behaviorObservations(
  split: "train" | "tune",
): readonly BehaviorFitObservation[] {
  return (["p2", "p3"] as const).map((seat) => {
    const preferred: BehaviorModelId =
      seat === "p2" ? "always-high" : "always-low";
    return {
      schemaVersion: 1,
      observationId: `${split}-${seat}`,
      split,
      styleCellId: "c08_always-high__always-low",
      sequenceId: `${split}-${seat}-sequence`,
      seat,
      decisionOrdinal: 0,
      worldEstimates: [
        {
          worldCount: 16,
          modelFeatures: Object.fromEntries(
            BEHAVIOR_MODEL_IDS.map((modelId) => [
              modelId,
              {
                uniformProbability: 0.25,
                preferredProbability:
                  modelId === "random" ? 0.25 : modelId === preferred ? 1 : 0,
              },
            ]),
          ) as BehaviorFitObservation["worldEstimates"][number]["modelFeatures"],
        },
      ],
    };
  });
}

function behaviorModel(): SelectedBehaviorModelArtifact {
  const grid: BehaviorHyperparameterGridInput = {
    lapseProbabilities: [0.08],
    likelihoodPowers: [0.5],
    maximumBayesFactors: [4],
    worldCounts: [16],
    robustChoices: [false],
  };
  const train = behaviorObservations("train");
  const tune = behaviorObservations("tune");
  const provenance = (
    values: readonly BehaviorFitObservation[],
    scheduleHash: string,
  ) => ({
    sourceHash: SOURCE_SHA256,
    datasetHash: behaviorFitDatasetHash(values),
    datasetContentHash: behaviorFitDatasetContentHash(values),
    scheduleHash,
    scorerHash: BEHAVIOR_FIT_SCORER_HASH,
    configFamilyHash: behaviorConfigFamilyHash(grid),
  });
  const trainFit = fitTrainBehaviorGrid({
    observations: train,
    grid,
    provenance: provenance(train, "train-schedule"),
  });
  return createSelectedBehaviorModelArtifact({
    trainFit,
    tuneSelection: selectTuneBehaviorModel({
      trainFit,
      observations: tune,
      provenance: provenance(tune, "tune-schedule"),
    }),
  });
}

function modelSha256(model: SelectedBehaviorModelArtifact): string {
  return createHash("sha256")
    .update(serializeSelectedBehaviorModelArtifact(model), "utf8")
    .digest("hex");
}

function tuneAuthority(
  model: SelectedBehaviorModelArtifact,
  manifestModelSha256 = modelSha256(model),
): FrozenPhase8ManifestAuthority {
  return freezePhase8Manifest({
    manifestId: "phase8-support-tune-test-manifest",
    createdAt: "2026-07-28T12:00:00.000Z",
    sourceSha256: SOURCE_SHA256,
    sourceFileCount: 42,
    modelSha256: manifestModelSha256,
    scorerSha256: SHA_C,
    reportSha256: SHA_D,
    preregistrationSha256: SHA_E,
    configurations: [
      createPhase8ConfigurationDescriptor({
        configId: "p8-r-hard-balanced-v1",
        label: "Reference",
        role: "reference",
        budgetId: "balanced",
        components: {
          exactEndgame: false,
          behaviorWeighting: false,
        },
        implementation: { executionPath: "reference-test" },
      }),
      createPhase8ConfigurationDescriptor({
        configId: "p8-b-behavior-balanced-v1",
        label: "Behavior",
        role: "candidate",
        budgetId: "balanced",
        components: {
          exactEndgame: false,
          behaviorWeighting: true,
        },
        implementation: { executionPath: "behavior-test" },
      }),
    ],
    splits: {
      train: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      tune: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      qualification: { baseIndexStart: 0, eventCap: 4_096 },
    },
    qualificationSampleSize: {
      verifiedDevelopmentVarianceArtifactSha256: SHA_F,
      maxPairedClusterStandardDeviation: 0,
    },
  });
}

function sourceSnapshot(): SourceSnapshot {
  return {
    sourceSnapshotSha256: SOURCE_SHA256,
    sourceFileCount: 42,
    gitCommit: "1".repeat(40),
    gitStatusSha256: "2".repeat(64),
    gitDirty: false,
  };
}

function fixture(mode: "evidence" | "smoke"): Readonly<{
  model: SelectedBehaviorModelArtifact;
  tuneAuthority: FrozenPhase8ManifestAuthority;
  opening: Phase8SplitOpening;
  plan: Phase8SupportTunePlan;
}> {
  const model = behaviorModel();
  const frozen = tuneAuthority(model);
  const opening = openPhase8Split(frozen, {
    split: "tune",
    proof: {
      kind: "development",
      disclosureAuthoritySha256: "3".repeat(64),
    },
  });
  return {
    model,
    tuneAuthority: frozen,
    opening,
    plan: createPhase8SupportTunePlan({
      tuneAuthority: frozen,
      opening,
      behaviorModel: model,
      source: sourceSnapshot(),
      runId: `phase8-support-${mode}-test`,
      mode,
      ...(mode === "smoke" ? { smokeBaseCount: 1 } : {}),
    }),
  };
}

function gameRecord(input: {
  readonly plan: Phase8SupportTunePlan;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly completed?: boolean;
  readonly failureCount?: number;
}): Phase8SupportTuneGameRecord {
  const styleBaseClusterId = `tune/${input.styleCellId}/base/${input.baseIndex.toString()}`;
  const gameId = stableHash({
    styleBaseClusterId,
    rotation: input.rotation,
  });
  const projection = {
    schemaVersion: 1 as const,
    recordType: "phase8-support-tune-game" as const,
    planSha256: input.plan.planSha256,
    styleCellId: input.styleCellId,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
    styleBaseClusterId,
    gameId,
    seedCommitmentSha256: phase8Sha256({
      styleBaseClusterId,
      rotation: input.rotation,
    }),
    completed: input.completed ?? true,
    failureCount: input.failureCount ?? 0,
  };
  return Object.freeze({
    ...projection,
    recordSha256: phase8Sha256(projection),
  });
}

function observationRecord(input: {
  readonly plan: Phase8SupportTunePlan;
  readonly game: Phase8SupportTuneGameRecord;
  readonly family: (typeof PHASE8_CALIBRATION_PRIMARY_FAMILIES)[number];
  readonly arm: "hard-only" | "behavioral";
  readonly suffix?: string;
  readonly skip?: boolean;
  readonly rawTruthProbability?: number;
}): Phase8SupportTuneObservationRecord {
  const suffix = input.suffix ?? "primary";
  const pairId = stableHash({
    gameId: input.game.gameId,
    family: input.family,
    suffix,
  });
  const rawTruthProbability =
    input.rawTruthProbability ?? (input.arm === "behavioral" ? 0.7 : 0.6);
  const projection = {
    schemaVersion: 1 as const,
    recordType: "phase8-support-tune-observation-eval-only" as const,
    planSha256: input.plan.planSha256,
    observationId: stableHash({ pairId, arm: input.arm }),
    pairId,
    arm: input.arm,
    family: input.family,
    queryId: `${input.family}/${suffix}`,
    styleCellId: input.game.styleCellId,
    baseIndex: input.game.baseIndex,
    rotation: input.game.rotation,
    styleBaseClusterId: input.game.styleBaseClusterId,
    gameId: input.game.gameId,
    stateId: `${input.game.gameId}/state`,
    hardKnown: false,
    feasibleLabels: ["no", "yes"],
    rawDistribution: [
      { label: "no", probability: 1 - rawTruthProbability },
      { label: "yes", probability: rawTruthProbability },
    ],
    effectiveSampleSize: 16,
    scoreStatus: input.skip
      ? ("conditioning-false" as const)
      : ("scored" as const),
    realizedLabel: input.skip ? null : "yes",
  };
  return Object.freeze({
    ...projection,
    recordSha256: phase8Sha256(projection),
  });
}

function syntheticCorpus(plan: Phase8SupportTunePlan): Readonly<{
  games: readonly Phase8SupportTuneGameRecord[];
  observations: readonly Phase8SupportTuneObservationRecord[];
}> {
  const games: Phase8SupportTuneGameRecord[] = [];
  const observations: Phase8SupportTuneObservationRecord[] = [];
  for (const styleCellId of plan.styleCellIds) {
    for (
      let baseIndex = plan.baseIndexStart;
      baseIndex < plan.baseIndexStart + plan.baseCount;
      baseIndex += 1
    ) {
      for (const rotation of [0, 1, 2] as const) {
        const game = gameRecord({
          plan,
          styleCellId,
          baseIndex,
          rotation,
        });
        games.push(game);
        for (const family of PHASE8_CALIBRATION_PRIMARY_FAMILIES) {
          for (const arm of ["hard-only", "behavioral"] as const) {
            observations.push(observationRecord({ plan, game, family, arm }));
            if (family === "conditional") {
              observations.push(
                observationRecord({
                  plan,
                  game,
                  family,
                  arm,
                  suffix: "conditioning-false",
                  skip: true,
                }),
              );
            }
          }
        }
      }
    }
  }
  return {
    games: Object.freeze(games),
    observations: Object.freeze(observations),
  };
}

function syntheticSmokeRun(): Phase8SupportTuneRunResult {
  const { model, plan } = fixture("smoke");
  const corpus = syntheticCorpus(plan);
  const scored = scorePhase8SupportTuneCandidates({
    plan,
    games: corpus.games,
    observations: corpus.observations,
  });
  const evidenceSha256 = phase8SupportTuneEvidenceSha256({
    plan,
    behaviorModel: model,
    games: corpus.games,
    observations: corpus.observations,
  });
  return Object.freeze({
    plan,
    behaviorModel: model,
    games: corpus.games,
    observations: corpus.observations,
    candidateEvaluations: scored.evaluations,
    integrity: scored.integrity,
    evidenceSha256,
    selection: null,
    provisionalSelectedPseudocount: 0.25,
  });
}

describe("Phase 8 support-regularizer tune evidence", () => {
  it("preregisters exactly 64×15×3 tune games and excludes confirmatory namespaces", () => {
    const { model, tuneAuthority: frozen, opening, plan } = fixture("evidence");
    const first = iteratePhase8SupportTuneSchedule(frozen, opening, plan);
    const second = iteratePhase8SupportTuneSchedule(frozen, opening, plan);

    expect(plan).toMatchObject({
      evidenceEligible: true,
      split: "tune",
      authorityPurpose: "development-tune-only",
      baseCount: 64,
      scheduledGames: PHASE8_SUPPORT_TUNE_EVIDENCE_GAME_COUNT,
      scheduledStyleBaseClusters: PHASE8_SUPPORT_TUNE_EVIDENCE_CLUSTER_COUNT,
      confirmatoryNamespacesExcluded: ["qualification", "final"],
      selectedWorldCount: 16,
    });
    expect(plan.p2BehaviorConfigHash).not.toBe(plan.p3BehaviorConfigHash);
    expect(model.payload.opponentConfigs.p2).not.toEqual(
      model.payload.opponentConfigs.p3,
    );
    expect(first).toHaveLength(2_880);
    expect(new Set(first.map((entry) => entry.styleBaseClusterId)).size).toBe(
      960,
    );
    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(stableStringify(first)).not.toMatch(
      /"(?:deal|hands|runnerSeed|seeds)"/u,
    );
  }, 60_000);

  it("returns raw evidence without prematurely scoring an authorized shard", () => {
    const { model, tuneAuthority: frozen, opening, plan } = fixture("smoke");
    const styleCellId = plan.styleCellIds[0];
    if (styleCellId === undefined) {
      throw new Error("Support-tune fixture has no style cell.");
    }
    const run = runPhase8SupportTune({
      tuneAuthority: frozen,
      opening,
      plan,
      behaviorModel: model,
      scheduleSlice: {
        styleCellId,
        baseIndexStart: plan.baseIndexStart,
        baseCount: 1,
      },
    });

    expect(run.games).toHaveLength(3);
    expect(run.candidateEvaluations).toEqual([]);
    expect(run.selection).toBeNull();
    expect(run.integrity.runFailureCount).toBe(0);
    expect(run.integrity.passed).toBe(false);
  }, 60_000);

  it("requires a tune-only authority bound to selected behavior bytes and rejects confirmatory openings", () => {
    const model = behaviorModel();
    const productionModelSha256 = createHash("sha256")
      .update(
        '{"artifactKind":"phase8-production-model","supportSelection":"frozen"}\n',
        "utf8",
      )
      .digest("hex");
    const productionBoundAuthority = tuneAuthority(
      model,
      productionModelSha256,
    );
    const productionBoundTuneOpening = openPhase8Split(
      productionBoundAuthority,
      {
        split: "tune",
        proof: {
          kind: "development",
          disclosureAuthoritySha256: "3".repeat(64),
        },
      },
    );
    expect(() =>
      createPhase8SupportTunePlan({
        tuneAuthority: productionBoundAuthority,
        opening: productionBoundTuneOpening,
        behaviorModel: model,
        source: sourceSnapshot(),
        runId: "phase8-support-production-authority-rejected",
        mode: "evidence",
      }),
    ).toThrow(/source\/model|model manifest hashes/u);

    const developmentTuneAuthority = tuneAuthority(model);
    const qualificationOpening = openPhase8Split(developmentTuneAuthority, {
      split: "qualification",
      proof: {
        kind: "qualification",
        preregistrationSha256: SHA_E,
        trainClosureSha256: SOURCE_SHA256,
        tuneClosureSha256: SHA_C,
        sourceValidationArtifactSha256: SHA_D,
      },
    });
    expect(() =>
      createPhase8SupportTunePlan({
        tuneAuthority: developmentTuneAuthority,
        opening: qualificationOpening,
        behaviorModel: model,
        source: sourceSnapshot(),
        runId: "phase8-support-confirmatory-opening-rejected",
        mode: "evidence",
      }),
    ).toThrow(/development\/tune-only|tune opening/u);
  });

  it("pairs every candidate score or typed skip and nests all six families deterministically", () => {
    const { plan } = fixture("smoke");
    const corpus = syntheticCorpus(plan);
    const first = scorePhase8SupportTuneCandidates({
      plan,
      games: corpus.games,
      observations: corpus.observations,
    });
    const second = scorePhase8SupportTuneCandidates({
      plan,
      games: corpus.games,
      observations: corpus.observations,
    });

    expect(first.integrity).toMatchObject({
      passed: true,
      completeStyleBaseClusters: 15,
      incompleteStyleBaseClusters: 0,
      rawZeroFeasibleTruthCount: 0,
      hardKnownViolationCount: 0,
    });
    expect(first.integrity.candidateAccountingActual).toBe(
      first.integrity.candidateAccountingExpected,
    );
    expect(
      first.evaluations.map(
        (candidate) => candidate.score.pseudocountPerFeasibleLabel,
      ),
    ).toEqual([0.25, 0.5, 1]);
    expect(Object.keys(first.evaluations[0]?.familyScores ?? {})).toEqual(
      PHASE8_CALIBRATION_PRIMARY_FAMILIES,
    );
    expect(
      first.evaluations.every(
        (candidate) =>
          candidate.conditioningFalseSkips > 0 &&
          candidate.score.unresolvedSoftObservations === 270,
      ),
    ).toBe(true);
    expect(stableStringify(first)).toBe(stableStringify(second));
  });

  it("nests conditional scores over applicable rotations only", () => {
    const { plan } = fixture("smoke");
    const corpus = syntheticCorpus(plan);
    const observations = corpus.observations.filter(
      (observation) =>
        observation.family !== "conditional" ||
        observation.rotation === 0 ||
        observation.scoreStatus === "conditioning-false",
    );
    const scored = scorePhase8SupportTuneCandidates({
      plan,
      games: corpus.games,
      observations,
    });

    expect(scored.integrity.passed).toBe(true);
    expect(
      scored.evaluations.every(
        (evaluation) => evaluation.missingFamilyRotationCells === 0,
      ),
    ).toBe(true);
    expect(
      scored.evaluations.every((evaluation) =>
        Number.isFinite(evaluation.familyScores.conditional),
      ),
    ).toBe(true);
  });

  it("treats a hard-known-only conditional family as non-tunable", () => {
    const { plan } = fixture("smoke");
    const corpus = syntheticCorpus(plan);
    const observations = corpus.observations.filter(
      (observation) =>
        observation.family !== "conditional" ||
        observation.scoreStatus === "conditioning-false",
    );
    const scored = scorePhase8SupportTuneCandidates({
      plan,
      games: corpus.games,
      observations,
    });

    expect(scored.integrity.passed).toBe(true);
    expect(
      scored.evaluations.every(
        (evaluation) => evaluation.familyScores.conditional === 0,
      ),
    ).toBe(true);
    expect(
      scored.evaluations.every((evaluation) =>
        Number.isFinite(evaluation.score.equalFamilyUnresolvedSoftBrier),
      ),
    ).toBe(true);
  });

  it("rejects incomplete clusters, execution failures, and raw-zero feasible truths", async () => {
    const { model, plan } = fixture("smoke");
    const corpus = syntheticCorpus(plan);
    const firstGame = corpus.games[0];
    if (firstGame === undefined) {
      throw new Error("Synthetic corpus has no games.");
    }
    const incompleteGame = gameRecord({
      plan,
      styleCellId: firstGame.styleCellId,
      baseIndex: firstGame.baseIndex,
      rotation: firstGame.rotation,
      completed: false,
      failureCount: 1,
    });
    const incompleteGames = [incompleteGame, ...corpus.games.slice(1)];
    const incomplete = scorePhase8SupportTuneCandidates({
      plan,
      games: incompleteGames,
      observations: corpus.observations,
      runFailureCount: 1,
    });
    expect(incomplete.integrity.passed).toBe(false);
    expect(incomplete.integrity.incompleteStyleBaseClusters).toBe(1);
    expect(
      incomplete.evaluations.every(
        (candidate) => candidate.score.failureCount > 0,
      ),
    ).toBe(true);

    const rawZeroSource = corpus.observations.find(
      (observation) =>
        observation.arm === "behavioral" &&
        observation.scoreStatus === "scored",
    );
    if (rawZeroSource === undefined) {
      throw new Error("Synthetic corpus has no scored behavioral prediction.");
    }
    const { recordSha256: _ignored, ...rawZeroProjection } = {
      ...rawZeroSource,
      rawDistribution: [
        { label: "no", probability: 1 },
        { label: "yes", probability: 0 },
      ],
    };
    void _ignored;
    const rawZero = {
      ...rawZeroProjection,
      recordSha256: phase8Sha256(rawZeroProjection),
    };
    const rawZeroCorpus = corpus.observations.map((observation) =>
      observation.observationId === rawZero.observationId
        ? rawZero
        : observation,
    );
    const rawZeroScored = scorePhase8SupportTuneCandidates({
      plan,
      games: corpus.games,
      observations: rawZeroCorpus,
    });
    expect(rawZeroScored.integrity).toMatchObject({
      passed: false,
      rawZeroFeasibleTruthCount: 1,
    });

    const invalidRun: Phase8SupportTuneRunResult = {
      plan,
      behaviorModel: model,
      games: incompleteGames,
      observations: corpus.observations,
      candidateEvaluations: incomplete.evaluations,
      integrity: incomplete.integrity,
      evidenceSha256: phase8SupportTuneEvidenceSha256({
        plan,
        behaviorModel: model,
        games: incompleteGames,
        observations: corpus.observations,
      }),
      selection: null,
      provisionalSelectedPseudocount: 0.25,
    };
    const root = await mkdtemp(join(tmpdir(), "bhabhi-support-reject-"));
    temporaryDirectories.push(root);
    await expect(
      writePhase8SupportTuneArtifact(join(root, "invalid"), invalidRun),
    ).rejects.toThrow(/integrity/u);
  });

  it("round-trips deterministic checksums and refuses immutable overwrite", async () => {
    const run = syntheticSmokeRun();
    const root = await mkdtemp(join(tmpdir(), "bhabhi-support-artifact-"));
    temporaryDirectories.push(root);
    const firstPath = join(root, "first");
    const secondPath = join(root, "second");
    const first = await writePhase8SupportTuneArtifact(firstPath, run);
    const second = await writePhase8SupportTuneArtifact(secondPath, run);

    expect(first.artifactSha256).toBe(second.artifactSha256);
    await expect(readPhase8SupportTuneArtifact(firstPath)).resolves.toEqual(
      run,
    );
    await expect(
      verifyPhase8SupportTuneArtifact(firstPath),
    ).resolves.toMatchObject({ valid: true });
    await expect(
      writePhase8SupportTuneArtifact(firstPath, run),
    ).rejects.toThrow(/overwrite/u);
  });

  it("keeps inference diagnostics public-only and stores no simulator hands or seed material", async () => {
    const predictionSource = await readFile(
      resolve("src/calibration/predictions.ts"),
      "utf8",
    );
    const supportSource = await readFile(
      resolve("src/modeling/support-tune.ts"),
      "utf8",
    );
    const runScript = await readFile(
      resolve("scripts/run-phase8-support-tune.ts"),
      "utf8",
    );
    const diagnosticContract =
      predictionSource
        .split("export type CalibrationFeasibleSupportDiagnostic")[1]
        ?.split("export type GenerateCalibrationPredictionsInput")[0] ?? "";

    expect(diagnosticContract).not.toMatch(
      /\b(?:exactState|realizedLabel|truth|hands?)\b/u,
    );
    expect(`${supportSource}\n${runScript}`).not.toMatch(
      /deriveOpenedPhase8FinalSeed|openPhase8FinalSplit|phase8-final-manifest/u,
    );
    expect(runScript).toContain("--tune-manifest");
    expect(runScript).toContain("--tune-opening");
    expect(runScript).not.toMatch(/case "--manifest"|case "--opening"/u);

    const run = syntheticSmokeRun();
    const publicGameRecords = stableStringify(run.games);
    expect(publicGameRecords).not.toMatch(/"(?:deal|hands|runnerSeed|seeds)"/u);
    expect(
      run.observations.every((record) =>
        record.recordType.endsWith("-eval-only"),
      ),
    ).toBe(true);
  });
});
