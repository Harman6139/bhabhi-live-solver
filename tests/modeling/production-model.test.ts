import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { stableHash } from "../../src/events/stable-hash";
import {
  BEHAVIOR_MODEL_IDS,
  type BehaviorModelId,
} from "../../src/inference/behavior-models";
import {
  readPhase8ProductionModelArtifact,
  writePhase8ProductionModelArtifact,
} from "../../src/modeling/artifact-store";
import {
  BEHAVIOR_FIT_SCORER_HASH,
  behaviorConfigFamilyHash,
  behaviorFitDatasetContentHash,
  behaviorFitDatasetHash,
  createSelectedBehaviorModelArtifact,
  fitTrainBehaviorGrid,
  selectTuneBehaviorModel,
  type BehaviorFitObservation,
  type BehaviorHyperparameterGridInput,
} from "../../src/modeling/behavior-fit";
import {
  createPhase8ProductionModelArtifact,
  createPhase8SupportRegularizerTuneSelection,
  parsePhase8ProductionModelArtifact,
  phase8ProductionModelConfig,
  serializePhase8ProductionModelArtifact,
  verifyPhase8ProductionModelArtifact,
} from "../../src/modeling/production-model";
import { PHASE8_SUPPORT_REGULARIZER_GRID } from "../../src/modeling/selection-contract";
import { FEASIBLE_SUPPORT_REGULARIZER_VERSION } from "../../src/calibration/support-regularization";

const SOURCE_SHA256 = "a".repeat(64);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function observations(
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

function behaviorArtifact() {
  const grid: BehaviorHyperparameterGridInput = {
    lapseProbabilities: [0.08],
    likelihoodPowers: [0.5],
    maximumBayesFactors: [4],
    worldCounts: [16],
  };
  const train = observations("train");
  const tune = observations("tune");
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

function regularizerHash(pseudocountPerFeasibleLabel: number): string {
  return stableHash({
    schemaVersion: 1,
    algorithmVersion: FEASIBLE_SUPPORT_REGULARIZER_VERSION,
    config: { pseudocountPerFeasibleLabel },
  });
}

function productionArtifact() {
  const selection = createPhase8SupportRegularizerTuneSelection({
    sourceSha256: SOURCE_SHA256,
    tuneArtifactSha256: "b".repeat(64),
    tuneDatasetHash: stableHash({ tune: "dataset" }),
    scorerSha256: "c".repeat(64),
    queryPlanSha256: "d".repeat(64),
    candidates: PHASE8_SUPPORT_REGULARIZER_GRID.map((config) => ({
      pseudocountPerFeasibleLabel: config.pseudocountPerFeasibleLabel,
      configHash: regularizerHash(config.pseudocountPerFeasibleLabel),
      completeClusters: 1_000,
      unresolvedSoftObservations: 10_000,
      equalFamilyUnresolvedSoftBrier:
        config.pseudocountPerFeasibleLabel === 0.5 ? 0.12 : 0.13,
      rawZeroFeasibleTruthCount: 0,
      hardKnownViolationCount: 0,
      failureCount: 0,
    })),
  });
  return createPhase8ProductionModelArtifact({
    behavior: behaviorArtifact(),
    supportRegularizerSelection: selection,
  });
}

describe("Phase 8 production-model envelope", () => {
  it("selects support on tune and round-trips one canonical model", () => {
    const artifact = productionArtifact();
    const serialized = serializePhase8ProductionModelArtifact(artifact);
    const parsed = parsePhase8ProductionModelArtifact(serialized);
    const config = phase8ProductionModelConfig(parsed);

    expect(parsed).toEqual(artifact);
    expect(config.supportRegularizer.pseudocountPerFeasibleLabel).toBe(0.5);
    expect(config.behavior.opponentModelPriors?.p2).not.toEqual(
      config.behavior.opponentModelPriors?.p3,
    );
    expect(config.worldCount).toBe(16);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects mutation and writes the canonical model once", async () => {
    const artifact = productionArtifact();
    const mutated = structuredClone(artifact);
    mutated.payload.supportRegularizer.pseudocountPerFeasibleLabel = 1;
    expect(() => verifyPhase8ProductionModelArtifact(mutated)).toThrow(
      /checksum|inconsistent/u,
    );

    const root = await mkdtemp(join(tmpdir(), "bhabhi-production-model-"));
    temporaryRoots.push(root);
    const path = join(root, "nested", "production-model.json");
    await writePhase8ProductionModelArtifact(path, artifact);
    await expect(readPhase8ProductionModelArtifact(path)).resolves.toEqual(
      artifact,
    );
    await expect(
      writePhase8ProductionModelArtifact(path, artifact),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });
});
