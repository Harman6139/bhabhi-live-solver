import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  verifyPhase8CalibrationArtifact,
  writePhase8CalibrationArtifact,
} from "../../src/calibration/phase8-artifacts";
import {
  PHASE8_CALIBRATION_PREDICTION_FAMILIES,
  PHASE8_CALIBRATION_PRIMARY_FAMILIES,
  createPhase8CalibrationPlan,
  iteratePhase8CalibrationSchedule,
  type Phase8CalibrationPlan,
} from "../../src/calibration/phase8-plan";
import {
  createPhase8PairedPredictionRecord,
  createPhase8ReferenceOneArmPredictionRecord,
  createPhase8ReferenceOneArmTerminalRiskPredictionRecord,
  createPhase8TerminalRiskPredictionRecord,
  type Phase8CalibrationTarget,
  type Phase8PairedPredictionRecord,
  type Phase8ReferenceOneArmPredictionRecord,
  type Phase8ReferenceOneArmTerminalRiskPredictionRecord,
  type Phase8TerminalRiskPredictionRecord,
} from "../../src/calibration/phase8-records";
import {
  scorePhase8PairedPrediction,
  scorePhase8ReferenceOneArmPrediction,
  scorePhase8ReferenceOneArmTerminalRiskPrediction,
  scorePhase8TerminalRiskPrediction,
  simultaneousPhase8CalibrationBootstrap,
  summarizePhase8Calibration,
  type Phase8PairedScoreRecord,
  type Phase8CalibrationScoreSkipRecord,
  type Phase8ReferenceOneArmScoreRecord,
  type Phase8ReferenceOneArmTerminalRiskScoreRecord,
  type Phase8TerminalRiskScoreRecord,
} from "../../src/calibration/phase8-scoring";
import {
  createPhase8SelectionAttestation,
  freezePhase8FinalManifestFromSelection,
  openPhase8FinalSplit,
} from "../../src/evaluation/phase8-final-manifest";
import {
  createPhase8ConfigurationDescriptor,
  deriveOpenedPhase8Seed,
  freezePhase8Manifest,
  openPhase8Split,
  type FrozenPhase8ManifestAuthority,
  type Phase8ConfigurationDescriptor,
  type Phase8ConfigurationRoleId,
  type Phase8SplitOpening,
} from "../../src/evaluation/phase8-manifest";
import { STYLE_CELLS } from "../../src/evaluation/protocol";
import {
  selectPhase8ProductionConfiguration,
  type Phase8ConfigurationEvidence,
} from "../../src/evaluation/phase8-selection";
import { evaluatePhase8TerminalGate } from "../../src/evaluation/phase8-statistics";

const SHA_A = "a".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);
const MODEL_SERIALIZED = '{"selectedModel":"phase8-test"}\n';
const MODEL_SHA256 = createHash("sha256")
  .update(MODEL_SERIALIZED, "utf8")
  .digest("hex");
const QUERY_PLAN = {
  version: "phase8-query-plan-test-v1",
  checkpointClasses: ["initial", "pre-opponent-choice"],
  conditionalProbabilityFloor: 0.05,
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected fixture value.");
  }
  return value;
}

function configuration(
  configId: Phase8ConfigurationRoleId,
  role: "reference" | "candidate",
  behaviorWeighting: boolean,
): Phase8ConfigurationDescriptor {
  return createPhase8ConfigurationDescriptor({
    configId,
    label: `Configuration ${configId}`,
    role,
    budgetId: "balanced",
    components: {
      exactEndgame: false,
      behaviorWeighting,
    },
    implementation: {
      executionPath: `${configId}-test-v1`,
      hardWorldSamples: 64,
    },
  });
}

function qualificationAuthority(): FrozenPhase8ManifestAuthority {
  return freezePhase8Manifest({
    manifestId: "phase8-calibration-test-manifest",
    createdAt: "2026-07-28T12:00:00.000Z",
    sourceSha256: SHA_A,
    sourceFileCount: 50,
    modelSha256: MODEL_SHA256,
    scorerSha256: SHA_C,
    reportSha256: SHA_D,
    preregistrationSha256: SHA_E,
    configurations: [
      configuration("p8-r-hard-balanced-v1", "reference", false),
      configuration("p8-b-behavior-balanced-v1", "candidate", true),
    ],
    splits: {
      train: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      tune: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      qualification: {
        baseIndexStart: 0,
        eventCap: 4_096,
      },
    },
    qualificationSampleSize: {
      verifiedDevelopmentVarianceArtifactSha256: SHA_F,
      maxPairedClusterStandardDeviation: 0,
    },
  });
}

function qualificationOpening(
  authority: FrozenPhase8ManifestAuthority,
): Phase8SplitOpening {
  return openPhase8Split(authority, {
    split: "qualification",
    proof: {
      kind: "qualification",
      preregistrationSha256: SHA_E,
      trainClosureSha256: SHA_A,
      tuneClosureSha256: SHA_C,
      sourceValidationArtifactSha256: SHA_D,
    },
  });
}

function calibrationPlan(): Readonly<{
  authority: FrozenPhase8ManifestAuthority;
  opening: Phase8SplitOpening;
  plan: Phase8CalibrationPlan;
}> {
  const authority = qualificationAuthority();
  const opening = qualificationOpening(authority);
  return {
    authority,
    opening,
    plan: createPhase8CalibrationPlan({
      authority,
      opening,
      runId: "phase8-calibration-test-run",
      hardConfigId: "p8-r-hard-balanced-v1",
      behaviorConfigId: "p8-b-behavior-balanced-v1",
      selectedModelSerialized: MODEL_SERIALIZED,
      supportRegularizer: {
        pseudocountPerFeasibleLabel: 0.5,
      },
      queryPlanId: "phase8-query-plan-test",
      queryPlan: QUERY_PLAN,
    }),
  };
}

function referenceOneArmFinalPlan(): Phase8CalibrationPlan {
  const authority = qualificationAuthority();
  const commonGates = {
    correctnessGate: true,
    conservationGate: true,
    replayGate: true,
    truthFirewallGate: true,
    fixedSeedReproducibilityGate: true,
    completeMatrixGate: true,
    zeroFailureGate: true,
    zeroCapGate: true,
    zeroCancellationGate: true,
    terminalNoninferiorityGate: true,
    styleSafetyGate: true,
    robustnessGate: true,
    latencyBudgetGate: true,
    stalePublicationGate: true,
    memoryBudgetGate: true,
  } as const;
  const referenceEvidence: Phase8ConfigurationEvidence = {
    configId: "p8-r-hard-balanced-v1",
    terminalBhabhiRate: 0.2,
    terminalGate: null,
    latencyP95Ms: 100,
    calibrationRobustnessRank: 0,
    commonGates,
    componentGates: {
      exactIncrementalImprovementGate: null,
      behaviorCalibrationGate: null,
      behaviorZeroSupportGate: null,
      behaviorHardKnownPreservationGate: null,
      behaviorSeparatePosteriorRobustnessGate: null,
    },
  };
  const ineligibleBehavior: Phase8ConfigurationEvidence = {
    configId: "p8-b-behavior-balanced-v1",
    terminalBhabhiRate: 0.1,
    terminalGate: evaluatePhase8TerminalGate({
      estimate: -0.1,
      oneSidedUpper: -0.01,
      twoSidedLower: -0.2,
      twoSidedUpper: -0.01,
    }),
    latencyP95Ms: 90,
    calibrationRobustnessRank: 0,
    commonGates,
    componentGates: {
      exactIncrementalImprovementGate: null,
      behaviorCalibrationGate: false,
      behaviorZeroSupportGate: false,
      behaviorHardKnownPreservationGate: false,
      behaviorSeparatePosteriorRobustnessGate: false,
    },
  };
  const decision = selectPhase8ProductionConfiguration(authority, [
    referenceEvidence,
    ineligibleBehavior,
  ]);
  expect(decision.selectionIsReference).toBe(true);
  const selectionArtifact = createPhase8SelectionAttestation({
    existingTarget: null,
    authority,
    decision,
    createdAt: "2026-07-28T16:00:00.000Z",
    qualificationArtifactSha256: SHA_C,
    qualificationSummarySha256: SHA_D,
    qualificationIntegrityGate: true,
    eligibilityGate: true,
    splitFirewallGate: true,
  });
  const finalAuthority = freezePhase8FinalManifestFromSelection({
    qualificationAuthority: authority,
    selectionArtifact,
    manifestId: "phase8-reference-one-arm-final-test",
    createdAt: "2026-07-28T16:30:00.000Z",
    qualificationVarianceArtifactSha256: SHA_E,
    maxPairedClusterStandardDeviation: 0,
    eventCap: 4_096,
  });
  return createPhase8CalibrationPlan({
    authority: finalAuthority,
    opening: openPhase8FinalSplit(finalAuthority),
    runId: "phase8-reference-one-arm-calibration",
    mode: "reference-one-arm-confirmation",
    hardConfigId: "p8-r-hard-balanced-v1",
    selectedModelSerialized: MODEL_SERIALIZED,
    supportRegularizer: {
      pseudocountPerFeasibleLabel: 0.5,
    },
    queryPlanId: "phase8-query-plan-test",
    queryPlan: QUERY_PLAN,
  });
}

function distribution(
  truthProbability: number,
): readonly { readonly label: string; readonly probability: number }[] {
  return [
    { label: "no", probability: 1 - truthProbability },
    { label: "yes", probability: truthProbability },
  ];
}

function targetForFamily(
  family: (typeof PHASE8_CALIBRATION_PREDICTION_FAMILIES)[number],
  opponentSeat: "p2" | "p3",
): Phase8CalibrationTarget {
  return family === "opponent-action"
    ? {
        kind: "opponent-action",
        family,
        opponentSeat,
        labels: ["no", "yes"],
      }
    : {
        kind: "query",
        family,
        labels: ["no", "yes"],
      };
}

function pairedPrediction(input: {
  plan: Phase8CalibrationPlan;
  clusterIndex: number;
  family: (typeof PHASE8_CALIBRATION_PREDICTION_FAMILIES)[number];
  querySuffix?: string;
  hardTruthProbability: number;
  behaviorTruthProbability: number;
  sampledBehaviorTruthProbability?: number;
  hardKnown?: boolean;
  forced?: boolean;
}): Readonly<{
  prediction: Phase8PairedPredictionRecord;
  score: Phase8PairedScoreRecord;
}> {
  const hardKnown = input.hardKnown ?? false;
  const styleCellId = defined(STYLE_CELLS[input.clusterIndex]).id;
  const prediction = createPhase8PairedPredictionRecord(input.plan, {
    styleCellId,
    styleBaseClusterId: `cluster-${input.clusterIndex.toString()}`,
    gameId: `game-${input.clusterIndex.toString()}-rotation-0`,
    stateId: `state-${input.clusterIndex.toString()}`,
    queryId: `${input.family}-${input.querySuffix ?? "primary"}`,
    target: targetForFamily(
      input.family,
      input.clusterIndex === 0 ? "p2" : "p3",
    ),
    feasibleLabels: hardKnown ? ["yes"] : ["no", "yes"],
    hardKnown,
    supportDerivationHash: `hard-support-${input.family}`,
    hard: {
      sampledDistribution: distribution(input.hardTruthProbability),
      effectiveSampleSize: 64,
      worldOccurrences: 64,
      uniqueWitnesses: 32,
      maximumWorldWeight: 1 / 64,
      hardWorldSetHash: "hard-world-set",
      modelBundleHash: "hard-model-disabled",
    },
    behavior: {
      sampledDistribution: distribution(
        input.sampledBehaviorTruthProbability ?? input.behaviorTruthProbability,
      ),
      effectiveSampleSize: 64,
      worldOccurrences: 64,
      uniqueWitnesses: 32,
      maximumWorldWeight: 1 / 64,
      hardWorldSetHash: "hard-world-set",
      modelBundleHash: "separate-p2-p3-model-bundle",
    },
  });
  const score = scorePhase8PairedPrediction(input.plan, prediction, {
    scoreStatus: "scored",
    truthLabel: "yes",
    forcedAction:
      input.family === "opponent-action" ? (input.forced ?? false) : null,
  });
  if (score.recordType !== "phase8-paired-calibration-score") {
    throw new Error("Fixture score unexpectedly skipped.");
  }
  return { prediction, score };
}

function terminalPrediction(input: {
  plan: Phase8CalibrationPlan;
  clusterIndex: number;
}): Readonly<{
  prediction: Phase8TerminalRiskPredictionRecord;
  score: Phase8TerminalRiskScoreRecord;
}> {
  const styleCellId = defined(STYLE_CELLS[input.clusterIndex]).id;
  const prediction = createPhase8TerminalRiskPredictionRecord(input.plan, {
    styleCellId,
    styleBaseClusterId: `cluster-${input.clusterIndex.toString()}`,
    gameId: `game-${input.clusterIndex.toString()}-rotation-0`,
    stateId: `state-${input.clusterIndex.toString()}`,
    queryId: `terminal-risk-${input.clusterIndex.toString()}`,
    actionKey: "play:AS",
    hard: {
      probabilityBhabhi: 0.4,
      interval95: { lower: 0.2, upper: 0.6 },
      effectiveSampleSize: 64,
    },
    behavior: {
      probabilityBhabhi: 0.2,
      interval95: { lower: 0.1, upper: 0.4 },
      effectiveSampleSize: 64,
    },
  });
  return {
    prediction,
    score: scorePhase8TerminalRiskPrediction(input.plan, prediction, {
      userWasBhabhi: false,
    }),
  };
}

function conditioningFalsePair(plan: Phase8CalibrationPlan): Readonly<{
  prediction: Phase8PairedPredictionRecord;
  skip: Phase8CalibrationScoreSkipRecord;
}> {
  const prediction = createPhase8PairedPredictionRecord(plan, {
    styleCellId: defined(STYLE_CELLS[0]).id,
    styleBaseClusterId: "cluster-0",
    gameId: "game-0-rotation-0",
    stateId: "state-0",
    queryId: "conditional-conditioning-false",
    target: {
      kind: "query",
      family: "conditional",
      labels: ["no", "yes"],
    },
    feasibleLabels: ["no", "yes"],
    hardKnown: false,
    supportDerivationHash: "conditional-hard-support",
    hard: {
      sampledDistribution: distribution(0.6),
      effectiveSampleSize: 64,
      worldOccurrences: 64,
      uniqueWitnesses: 32,
      maximumWorldWeight: 1 / 64,
      hardWorldSetHash: "hard-world-set",
      modelBundleHash: "hard-model-disabled",
    },
    behavior: {
      sampledDistribution: distribution(0.8),
      effectiveSampleSize: 64,
      worldOccurrences: 64,
      uniqueWitnesses: 32,
      maximumWorldWeight: 1 / 64,
      hardWorldSetHash: "hard-world-set",
      modelBundleHash: "separate-p2-p3-model-bundle",
    },
  });
  const skip = scorePhase8PairedPrediction(plan, prediction, {
    scoreStatus: "conditioning-false",
    truthLabel: null,
    forcedAction: null,
  });
  if (skip.recordType !== "phase8-calibration-score-skip") {
    throw new Error("Conditional fixture unexpectedly produced a score.");
  }
  return { prediction, skip };
}

function scoredCorpus(plan: Phase8CalibrationPlan): Readonly<{
  predictions: readonly Phase8PairedPredictionRecord[];
  scores: readonly Phase8PairedScoreRecord[];
  scoreSkips: readonly Phase8CalibrationScoreSkipRecord[];
  terminalRiskPredictions: readonly Phase8TerminalRiskPredictionRecord[];
  terminalRiskScores: readonly Phase8TerminalRiskScoreRecord[];
}> {
  const pairs: {
    prediction: Phase8PairedPredictionRecord;
    score: Phase8PairedScoreRecord;
  }[] = [];
  for (const clusterIndex of [0, 1]) {
    for (const family of PHASE8_CALIBRATION_PRIMARY_FAMILIES) {
      pairs.push(
        pairedPrediction({
          plan,
          clusterIndex,
          family,
          hardTruthProbability: family === "card-owner" ? 0.9 : 0.6,
          behaviorTruthProbability: family === "card-owner" ? 0.5 : 0.8,
        }),
      );
    }
    for (let duplicate = 0; duplicate < 9; duplicate += 1) {
      pairs.push(
        pairedPrediction({
          plan,
          clusterIndex,
          family: "card-owner",
          querySuffix: `duplicate-${duplicate.toString()}`,
          hardTruthProbability: 0.9,
          behaviorTruthProbability: 0.5,
        }),
      );
    }
    pairs.push(
      pairedPrediction({
        plan,
        clusterIndex,
        family: "opponent-action",
        querySuffix: "discretionary-secondary",
        hardTruthProbability: 0.6,
        behaviorTruthProbability: 0.8,
        forced: false,
      }),
    );
    pairs.push(
      pairedPrediction({
        plan,
        clusterIndex,
        family: "opponent-action",
        querySuffix: "forced-excluded",
        hardTruthProbability: 0.99,
        behaviorTruthProbability: 0.01,
        forced: true,
      }),
    );
  }
  const hardKnown = pairedPrediction({
    plan,
    clusterIndex: 0,
    family: "current-void",
    querySuffix: "hard-known",
    hardTruthProbability: 1,
    behaviorTruthProbability: 1,
    hardKnown: true,
  });
  pairs.push(hardKnown);

  const sampledZero = pairedPrediction({
    plan,
    clusterIndex: 1,
    family: "opponent-action",
    querySuffix: "sampled-zero-regularized",
    hardTruthProbability: 0.6,
    behaviorTruthProbability: 0.8,
    sampledBehaviorTruthProbability: 0,
    forced: true,
  });
  pairs.push(sampledZero);

  const terminal = [0, 1].map((clusterIndex) =>
    terminalPrediction({ plan, clusterIndex }),
  );
  const conditioningFalse = conditioningFalsePair(plan);
  return {
    predictions: [
      ...pairs.map((pair) => pair.prediction),
      conditioningFalse.prediction,
    ],
    scores: pairs.map((pair) => pair.score),
    scoreSkips: [conditioningFalse.skip],
    terminalRiskPredictions: terminal.map((pair) => pair.prediction),
    terminalRiskScores: terminal.map((pair) => pair.score),
  };
}

function referenceOneArmCorpus(plan: Phase8CalibrationPlan): Readonly<{
  predictions: readonly Phase8ReferenceOneArmPredictionRecord[];
  scores: readonly Phase8ReferenceOneArmScoreRecord[];
  scoreSkips: readonly Phase8CalibrationScoreSkipRecord[];
  terminalRiskPredictions: readonly Phase8ReferenceOneArmTerminalRiskPredictionRecord[];
  terminalRiskScores: readonly Phase8ReferenceOneArmTerminalRiskScoreRecord[];
}> {
  const predictions: Phase8ReferenceOneArmPredictionRecord[] = [];
  const scores: Phase8ReferenceOneArmScoreRecord[] = [];
  for (const clusterIndex of [0, 1]) {
    const styleCellId = defined(STYLE_CELLS[clusterIndex]).id;
    for (const family of PHASE8_CALIBRATION_PRIMARY_FAMILIES) {
      const prediction = createPhase8ReferenceOneArmPredictionRecord(plan, {
        styleCellId,
        styleBaseClusterId: `one-arm-cluster-${clusterIndex.toString()}`,
        gameId: `one-arm-game-${clusterIndex.toString()}-rotation-0`,
        stateId: `one-arm-state-${clusterIndex.toString()}`,
        queryId: `one-arm-${family}`,
        target: targetForFamily(family, clusterIndex === 0 ? "p2" : "p3"),
        feasibleLabels: ["no", "yes"],
        hardKnown: false,
        supportDerivationHash: `one-arm-hard-support-${family}`,
        hard: {
          sampledDistribution: distribution(
            family === "card-owner" ? 0.75 : 0.65,
          ),
          effectiveSampleSize: 64,
          worldOccurrences: 64,
          uniqueWitnesses: 32,
          maximumWorldWeight: 1 / 64,
          hardWorldSetHash: "one-arm-hard-world-set",
          modelBundleHash: "hard-only-reference-model-bundle",
        },
      });
      const score = scorePhase8ReferenceOneArmPrediction(plan, prediction, {
        scoreStatus: "scored",
        truthLabel: "yes",
        forcedAction: null,
      });
      if (score.recordType !== "phase8-reference-one-arm-calibration-score") {
        throw new Error("One-arm primary fixture unexpectedly skipped.");
      }
      predictions.push(prediction);
      scores.push(score);
    }

    const actionPrediction = createPhase8ReferenceOneArmPredictionRecord(plan, {
      styleCellId,
      styleBaseClusterId: `one-arm-cluster-${clusterIndex.toString()}`,
      gameId: `one-arm-game-${clusterIndex.toString()}-rotation-0`,
      stateId: `one-arm-state-${clusterIndex.toString()}`,
      queryId: "one-arm-opponent-action",
      target: targetForFamily(
        "opponent-action",
        clusterIndex === 0 ? "p2" : "p3",
      ),
      feasibleLabels: ["no", "yes"],
      hardKnown: false,
      supportDerivationHash: "one-arm-hard-support-opponent-action",
      hard: {
        sampledDistribution: distribution(0.6),
        effectiveSampleSize: 64,
        worldOccurrences: 64,
        uniqueWitnesses: 32,
        maximumWorldWeight: 1 / 64,
        hardWorldSetHash: "one-arm-hard-world-set",
        modelBundleHash: "hard-only-reference-model-bundle",
      },
    });
    const actionScore = scorePhase8ReferenceOneArmPrediction(
      plan,
      actionPrediction,
      {
        scoreStatus: "scored",
        truthLabel: "yes",
        forcedAction: false,
      },
    );
    if (
      actionScore.recordType !== "phase8-reference-one-arm-calibration-score"
    ) {
      throw new Error("One-arm action fixture unexpectedly skipped.");
    }
    predictions.push(actionPrediction);
    scores.push(actionScore);
  }

  const terminalRiskPredictions = [0, 1].map((clusterIndex) => {
    const prediction = createPhase8ReferenceOneArmTerminalRiskPredictionRecord(
      plan,
      {
        styleCellId: defined(STYLE_CELLS[clusterIndex]).id,
        styleBaseClusterId: `one-arm-cluster-${clusterIndex.toString()}`,
        gameId: `one-arm-game-${clusterIndex.toString()}-rotation-0`,
        stateId: `one-arm-state-${clusterIndex.toString()}`,
        queryId: `one-arm-terminal-risk-${clusterIndex.toString()}`,
        actionKey: "play:AS",
        hard: {
          probabilityBhabhi: 0.2,
          interval95: { lower: 0.1, upper: 0.3 },
          effectiveSampleSize: 64,
        },
      },
    );
    return prediction;
  });
  return {
    predictions,
    scores,
    scoreSkips: [],
    terminalRiskPredictions,
    terminalRiskScores: terminalRiskPredictions.map((prediction) =>
      scorePhase8ReferenceOneArmTerminalRiskPrediction(plan, prediction, {
        userWasBhabhi: false,
      }),
    ),
  };
}

describe("Phase 8 clean calibration plan and seed firewall", () => {
  it("requires a genuine confirmatory opening and schedules all 3,264 games", () => {
    const { authority, opening, plan } = calibrationPlan();
    expect(plan.split).toBe("qualification");
    expect(plan.styleCellIds).toHaveLength(17);
    expect(plan.scheduledStyleBaseClusters).toBe(1_088);
    expect(plan.scheduledGames).toBe(3_264);
    expect(plan.styleCellIds).toEqual(STYLE_CELLS.map((cell) => cell.id));
    expect(plan.styleCellIds).toContain("c16_noisy-mixture__phase-switch");
    expect(plan.styleCellIds).toContain("c17_phase-switch__noisy-mixture");

    const schedule = [
      ...iteratePhase8CalibrationSchedule(authority, opening, plan),
    ];
    expect(schedule).toHaveLength(3_264);
    expect(
      new Set(schedule.map((record) => record.styleBaseClusterId)),
    ).toHaveLength(1_088);
    expect(new Set(schedule.map((record) => record.gameId))).toHaveLength(
      3_264,
    );
    expect(new Set(schedule.map((record) => record.rotation))).toEqual(
      new Set([0, 1, 2]),
    );
    expect(new Set(schedule.map((record) => record.styleCellId))).toEqual(
      new Set(STYLE_CELLS.map((cell) => cell.id)),
    );

    expect(() =>
      createPhase8CalibrationPlan({
        authority,
        opening: {} as Phase8SplitOpening,
        runId: "phase8-forged-opening",
        hardConfigId: "p8-r-hard-balanced-v1",
        behaviorConfigId: "p8-b-behavior-balanced-v1",
        selectedModelSerialized: MODEL_SERIALIZED,
        supportRegularizer: {
          pseudocountPerFeasibleLabel: 0.5,
        },
        queryPlanId: "phase8-query-plan-test",
        queryPlan: QUERY_PLAN,
      }),
    ).toThrow(/opening|split|qualification or final/u);
  });

  it("keeps split namespaces disjoint and supports a selection-authorized final plan", () => {
    const authority = qualificationAuthority();
    const qualification = qualificationOpening(authority);
    const train = openPhase8Split(authority, {
      split: "train",
      proof: {
        kind: "development",
        disclosureAuthoritySha256: SHA_F,
      },
    });
    const coordinate = {
      stream: "belief",
      styleCellId: defined(authority.manifest.splits.train.styleCellIds[0]),
      baseIndex: 0,
      rotation: 0,
      replicate: 0,
    } as const;
    expect(deriveOpenedPhase8Seed(authority, train, coordinate)).not.toBe(
      deriveOpenedPhase8Seed(authority, qualification, coordinate),
    );
    expect(() =>
      createPhase8CalibrationPlan({
        authority,
        opening: train,
        runId: "phase8-train-is-not-evidence",
        hardConfigId: "p8-r-hard-balanced-v1",
        behaviorConfigId: "p8-b-behavior-balanced-v1",
        selectedModelSerialized: MODEL_SERIALIZED,
        supportRegularizer: {
          pseudocountPerFeasibleLabel: 0.5,
        },
        queryPlanId: "phase8-query-plan-test",
        queryPlan: QUERY_PLAN,
      }),
    ).toThrow(/qualification or final/u);

    const commonGates = {
      correctnessGate: true,
      conservationGate: true,
      replayGate: true,
      truthFirewallGate: true,
      fixedSeedReproducibilityGate: true,
      completeMatrixGate: true,
      zeroFailureGate: true,
      zeroCapGate: true,
      zeroCancellationGate: true,
      terminalNoninferiorityGate: true,
      styleSafetyGate: true,
      robustnessGate: true,
      latencyBudgetGate: true,
      stalePublicationGate: true,
      memoryBudgetGate: true,
    } as const;
    const referenceEvidence: Phase8ConfigurationEvidence = {
      configId: "p8-r-hard-balanced-v1",
      terminalBhabhiRate: 0.2,
      terminalGate: null,
      latencyP95Ms: 100,
      calibrationRobustnessRank: 1,
      commonGates,
      componentGates: {
        exactIncrementalImprovementGate: null,
        behaviorCalibrationGate: null,
        behaviorZeroSupportGate: null,
        behaviorHardKnownPreservationGate: null,
        behaviorSeparatePosteriorRobustnessGate: null,
      },
    };
    const behaviorEvidence: Phase8ConfigurationEvidence = {
      configId: "p8-b-behavior-balanced-v1",
      terminalBhabhiRate: 0.18,
      terminalGate: evaluatePhase8TerminalGate({
        estimate: -0.02,
        oneSidedUpper: 0.004,
        twoSidedLower: -0.04,
        twoSidedUpper: 0.005,
      }),
      latencyP95Ms: 200,
      calibrationRobustnessRank: 0,
      commonGates,
      componentGates: {
        exactIncrementalImprovementGate: null,
        behaviorCalibrationGate: true,
        behaviorZeroSupportGate: true,
        behaviorHardKnownPreservationGate: true,
        behaviorSeparatePosteriorRobustnessGate: true,
      },
    };
    const decision = selectPhase8ProductionConfiguration(authority, [
      referenceEvidence,
      behaviorEvidence,
    ]);
    const selectionArtifact = createPhase8SelectionAttestation({
      existingTarget: null,
      authority,
      decision,
      createdAt: "2026-07-28T14:30:00.000Z",
      qualificationArtifactSha256: SHA_C,
      qualificationSummarySha256: SHA_D,
      qualificationIntegrityGate: true,
      eligibilityGate: true,
      splitFirewallGate: true,
    });
    const finalAuthority = freezePhase8FinalManifestFromSelection({
      qualificationAuthority: authority,
      selectionArtifact,
      manifestId: "phase8-calibration-final-test",
      createdAt: "2026-07-28T15:00:00.000Z",
      qualificationVarianceArtifactSha256: SHA_E,
      maxPairedClusterStandardDeviation: 0,
      eventCap: 4_096,
    });
    const finalOpening = openPhase8FinalSplit(finalAuthority);
    const finalPlan = createPhase8CalibrationPlan({
      authority: finalAuthority,
      opening: finalOpening,
      runId: "phase8-calibration-final-run",
      hardConfigId: "p8-r-hard-balanced-v1",
      behaviorConfigId: "p8-b-behavior-balanced-v1",
      selectedModelSerialized: MODEL_SERIALIZED,
      supportRegularizer: {
        pseudocountPerFeasibleLabel: 0.5,
      },
      queryPlanId: "phase8-query-plan-test",
      queryPlan: QUERY_PLAN,
    });
    expect(finalPlan.split).toBe("final");
    expect(finalPlan.scheduledGames).toBe(3_264);
    expect([
      ...iteratePhase8CalibrationSchedule(
        finalAuthority,
        finalOpening,
        finalPlan,
      ),
    ]).toHaveLength(3_264);
  });

  it("binds model/query/support/source/scorer/report hashes before any schedule is usable", () => {
    const { authority, opening, plan } = calibrationPlan();
    expect(plan.selectedModelSerializedSha256).toBe(MODEL_SHA256);
    expect(plan.sourceSha256).toBe(SHA_A);
    expect(plan.scorerSha256).toBe(SHA_C);
    expect(plan.reportSha256).toBe(SHA_D);
    expect(plan.queryPlanSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(plan.supportRegularizerSha256).toMatch(/^[0-9a-f]{64}$/u);

    expect(() =>
      createPhase8CalibrationPlan({
        authority,
        opening,
        runId: "phase8-model-mismatch",
        hardConfigId: "p8-r-hard-balanced-v1",
        behaviorConfigId: "p8-b-behavior-balanced-v1",
        selectedModelSerialized: "mutated",
        supportRegularizer: {
          pseudocountPerFeasibleLabel: 0.5,
        },
        queryPlanId: "phase8-query-plan-test",
        queryPlan: QUERY_PLAN,
      }),
    ).toThrow(/model hash/u);
    expect(() =>
      createPhase8CalibrationPlan({
        authority,
        opening,
        runId: "phase8-zero-pseudocount",
        hardConfigId: "p8-r-hard-balanced-v1",
        behaviorConfigId: "p8-b-behavior-balanced-v1",
        selectedModelSerialized: MODEL_SERIALIZED,
        supportRegularizer: {
          pseudocountPerFeasibleLabel: 0,
        },
        queryPlanId: "phase8-query-plan-test",
        queryPlan: QUERY_PLAN,
      }),
    ).toThrow(/pseudocount/u);
  });
});

describe("Phase 8 paired scoring and summaries", () => {
  it("preserves hard facts and regularizes sampled misses without hiding raw diagnostics", () => {
    const { plan } = calibrationPlan();
    const hardKnown = pairedPrediction({
      plan,
      clusterIndex: 0,
      family: "current-void",
      hardTruthProbability: 1,
      behaviorTruthProbability: 1,
      hardKnown: true,
    });
    expect(hardKnown.prediction.hard.rawDistribution).toEqual(distribution(1));
    expect(hardKnown.prediction.behavior.rawDistribution).toEqual(
      distribution(1),
    );

    const sampledMiss = pairedPrediction({
      plan,
      clusterIndex: 1,
      family: "suit-length",
      hardTruthProbability: 0.6,
      behaviorTruthProbability: 0.8,
      sampledBehaviorTruthProbability: 0,
    });
    expect(sampledMiss.prediction.behavior.sampledZeroFeasibleLabels).toContain(
      "yes",
    );
    expect(
      defined(
        sampledMiss.prediction.behavior.rawDistribution.find(
          (entry) => entry.label === "yes",
        ),
      ).probability,
    ).toBeGreaterThan(0);
    expect(sampledMiss.score.behavior.rawZeroTruthSupport).toBe(false);

    expect(() =>
      scorePhase8PairedPrediction(plan, sampledMiss.prediction, {
        scoreStatus: "scored",
        truthLabel: "impossible",
        forcedAction: null,
      }),
    ).toThrow(/outside/u);
  });

  it("uses the six-family nested Brier endpoint and keeps P2/P3 actions secondary", () => {
    const { plan } = calibrationPlan();
    const corpus = scoredCorpus(plan);
    const summary = summarizePhase8Calibration({
      plan,
      ...corpus,
    });
    const regularized = (probability: number) => (64 * probability + 0.5) / 65;
    const brier = (probability: number) => (1 - regularized(probability)) ** 2;
    const expectedDifference =
      (brier(0.5) - brier(0.9) + 5 * (brier(0.8) - brier(0.6))) / 6;
    expect(summary.primary.behaviorMinusHard).toBeCloseTo(
      expectedDifference,
      10,
    );
    expect(summary.primary.bootstrap.resamples).toBe(20_000);
    expect(
      defined(summary.primary.bootstrap.contrasts[0]).oneSidedUpper,
    ).toBeLessThan(0);
    expect(summary.primary.bootstrap.simultaneousImprovementGate).toBe(true);
    expect(summary.primary.completeClusters).toBe(2);
    expect(summary.primary.families).toEqual(
      PHASE8_CALIBRATION_PRIMARY_FAMILIES,
    );
    expect(summary.primary.families).not.toContain("opponent-action");
    expect(summary.pairedScoreSkips).toBe(1);
    expect(summary.gates.completePairing).toBe(true);
    expect(summary.gates.scheduledClusterCoverage).toBe(false);
    expect(summary.gates.zeroRawLogicallyPossibleSupport).toBe(true);
    expect(summary.gates.hardKnownExact).toBe(true);
    expect(summary.gates.actionP2P3Separated).toBe(true);
    expect(summary.gates.terminalRiskPresent).toBe(true);

    const silentlyMissing = summarizePhase8Calibration({
      plan,
      ...corpus,
      scoreSkips: [],
    });
    expect(silentlyMissing.gates.completePairing).toBe(false);

    const actionLines = summary.secondary.filter(
      (line) =>
        line.family === "opponent-action" &&
        line.arm === "behavioral" &&
        line.actionDecisionClass === "discretionary",
    );
    expect(new Set(actionLines.map((line) => line.opponentSeat))).toEqual(
      new Set(["p2", "p3"]),
    );
    expect(
      summary.secondary.some(
        (line) =>
          line.family === "terminal-risk" &&
          line.meanBrier >= 0 &&
          line.reliability.length === 10,
      ),
    ).toBe(true);
  });

  it("scores terminal risk only when eval truth is injected and bootstraps deterministically", () => {
    const { plan } = calibrationPlan();
    const terminal = terminalPrediction({ plan, clusterIndex: 0 });
    expect(terminal.prediction).not.toHaveProperty("userWasBhabhi");
    expect(terminal.score.userWasBhabhi).toBe(false);
    expect(terminal.score.behavior.brier).toBeLessThan(
      terminal.score.hard.brier,
    );

    const input = {
      contrasts: [
        {
          contrastId: "primary",
          clusterDifferences: {
            a: -0.1,
            b: -0.2,
            c: -0.15,
          },
        },
        {
          contrastId: "secondary",
          clusterDifferences: {
            a: -0.05,
            b: -0.08,
            c: -0.06,
          },
        },
      ],
      seed: "phase8-deterministic-bootstrap",
    } as const;
    const first = simultaneousPhase8CalibrationBootstrap(input);
    const second = simultaneousPhase8CalibrationBootstrap(input);
    expect(first).toEqual(second);
    expect(first.familySize).toBe(2);
    expect(first.resamples).toBe(20_000);
    expect(first.simultaneousImprovementGate).toBe(true);
  });
});

describe("Phase 8 immutable calibration artifacts", () => {
  it("round-trips canonical streams, rejects overwrite, and detects provenance mutation", async () => {
    const { plan } = calibrationPlan();
    const corpus = scoredCorpus(plan);
    const summary = summarizePhase8Calibration({ plan, ...corpus });
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "phase8-calibration-test-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const artifactRoot = join(temporaryRoot, "artifact");

    const manifest = await writePhase8CalibrationArtifact({
      root: artifactRoot,
      plan,
      ...corpus,
      summary,
    });
    expect(manifest.files.predictions.records).toBe(corpus.predictions.length);
    await expect(
      verifyPhase8CalibrationArtifact({
        root: artifactRoot,
        expectedPlan: plan,
      }),
    ).resolves.toMatchObject({
      valid: true,
      summary: {
        summarySha256: summary.summarySha256,
      },
    });
    await expect(
      writePhase8CalibrationArtifact({
        root: artifactRoot,
        plan,
        ...corpus,
        summary,
      }),
    ).rejects.toThrow();

    const predictionPath = join(artifactRoot, "paired-predictions.ndjson");
    const original = await readFile(predictionPath, "utf8");
    await writeFile(
      predictionPath,
      original.replace(
        /"modelBundleHash":"separate-p2-p3-model-bundle"/u,
        '"modelBundleHash":"mutated-model-bundle"',
      ),
      "utf8",
    );
    const verification = await verifyPhase8CalibrationArtifact({
      root: artifactRoot,
      expectedPlan: plan,
    });
    expect(verification.valid).toBe(false);
    expect(verification.issues.join(" ")).toMatch(/checksum|forecast/u);
  });

  it("round-trips a reference-selected final as an explicit hard-only one-arm artifact", async () => {
    const plan = referenceOneArmFinalPlan();
    const corpus = referenceOneArmCorpus(plan);
    const summary = summarizePhase8Calibration({ plan, ...corpus });

    expect(plan).toMatchObject({
      split: "final",
      mode: "reference-one-arm-confirmation",
      behaviorConfigId: null,
      behaviorConfigSha256: null,
      selectionIsReference: true,
      primaryEndpoint: {
        contrast: "not-applicable-reference-one-arm",
      },
      bootstrap: {
        method: "not-applicable-reference-one-arm",
        confidenceLevel: null,
        resamples: 0,
        seed: null,
      },
    });
    expect(() =>
      createPhase8PairedPredictionRecord(plan, {
        styleCellId: defined(STYLE_CELLS[0]).id,
        styleBaseClusterId: "one-arm-cluster-reject-paired",
        gameId: "one-arm-game-reject-paired",
        stateId: "one-arm-state-reject-paired",
        queryId: "one-arm-query-reject-paired",
        target: targetForFamily("card-owner", "p2"),
        feasibleLabels: ["no", "yes"],
        hardKnown: false,
        supportDerivationHash: "one-arm-support-reject-paired",
        hard: {
          sampledDistribution: distribution(0.6),
          effectiveSampleSize: 64,
          worldOccurrences: 64,
          uniqueWitnesses: 32,
          maximumWorldWeight: 1 / 64,
          hardWorldSetHash: "one-arm-hard-world-set",
          modelBundleHash: "hard-only-reference-model-bundle",
        },
        behavior: {
          sampledDistribution: distribution(0.7),
          effectiveSampleSize: 64,
          worldOccurrences: 64,
          uniqueWitnesses: 32,
          maximumWorldWeight: 1 / 64,
          hardWorldSetHash: "one-arm-hard-world-set",
          modelBundleHash: "forbidden-behavior-model-bundle",
        },
      }),
    ).toThrow(/one-arm|behavioral-comparison/u);

    expect(corpus.predictions.every((record) => !("behavior" in record))).toBe(
      true,
    );
    expect(corpus.scores.every((record) => !("behavior" in record))).toBe(true);
    expect(
      corpus.terminalRiskPredictions.every((record) => !("behavior" in record)),
    ).toBe(true);
    expect(
      corpus.terminalRiskScores.every((record) => !("behavior" in record)),
    ).toBe(true);
    expect(summary).toMatchObject({
      mode: "reference-one-arm-confirmation",
      pairedPredictions: 0,
      pairedScores: 0,
      pairedScoreSkips: 0,
      oneArmPredictions: corpus.predictions.length,
      oneArmScores: corpus.scores.length,
      oneArmScoreSkips: 0,
      oneArmTerminalRiskPredictions: corpus.terminalRiskPredictions.length,
      oneArmTerminalRiskScores: corpus.terminalRiskScores.length,
      primary: {
        mode: "reference-one-arm-confirmation",
        contrastApplicability: "not-applicable",
        behaviorBrier: null,
        behaviorMinusHard: null,
        bootstrap: {
          method: "not-applicable-reference-one-arm",
          confidenceLevel: null,
          resamples: 0,
          seedId: null,
          familySize: 0,
          contrasts: [],
          simultaneousImprovementGate: null,
        },
      },
      gates: {
        completePairing: true,
        actionP2P3Separated: true,
        terminalRiskPresent: true,
        simultaneousCalibrationImprovement: null,
      },
    });
    expect(summary.primary.clusterDifferences).toSatisfy(
      (clusters: typeof summary.primary.clusterDifferences) =>
        clusters.every(
          (cluster) =>
            cluster.behaviorBrier === null && cluster.difference === null,
        ),
    );
    expect(summary.secondary.length).toBeGreaterThan(0);
    expect(summary.secondary.every((line) => line.arm === "hard-only")).toBe(
      true,
    );

    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "phase8-one-arm-calibration-test-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const artifactRoot = join(temporaryRoot, "artifact");
    const manifest = await writePhase8CalibrationArtifact({
      root: artifactRoot,
      plan,
      ...corpus,
      summary,
    });
    expect(manifest).toMatchObject({
      split: "final",
      mode: "reference-one-arm-confirmation",
    });
    await expect(
      verifyPhase8CalibrationArtifact({
        root: artifactRoot,
        expectedPlan: plan,
      }),
    ).resolves.toMatchObject({
      valid: true,
      summary: {
        summarySha256: summary.summarySha256,
        mode: "reference-one-arm-confirmation",
      },
    });

    const predictionPath = join(artifactRoot, "paired-predictions.ndjson");
    const original = await readFile(predictionPath, "utf8");
    expect(original).not.toMatch(/"behavior":/u);
    await writeFile(
      predictionPath,
      original.replace(
        /"modelBundleHash":"hard-only-reference-model-bundle"/u,
        '"modelBundleHash":"mutated-reference-model-bundle"',
      ),
      "utf8",
    );
    const verification = await verifyPhase8CalibrationArtifact({
      root: artifactRoot,
      expectedPlan: plan,
    });
    expect(verification.valid).toBe(false);
    expect(verification.issues.join(" ")).toMatch(/checksum|forecast/u);
  });
});
