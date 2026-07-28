import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readSelectedBehaviorModelArtifact,
  writeSelectedBehaviorModelArtifact,
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
  BEHAVIOR_MODEL_IDS,
  type BehaviorModelId,
} from "../../src/inference/behavior-models";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
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

function artifactFixture() {
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
    sourceHash: "sha256:source",
    datasetHash: behaviorFitDatasetHash(values),
    datasetContentHash: behaviorFitDatasetContentHash(values),
    scheduleHash,
    scorerHash: BEHAVIOR_FIT_SCORER_HASH,
    configFamilyHash: behaviorConfigFamilyHash(grid),
  });
  const trainFit = fitTrainBehaviorGrid({
    observations: train,
    grid,
    provenance: provenance(train, "sha256:train-schedule"),
  });
  return createSelectedBehaviorModelArtifact({
    trainFit,
    tuneSelection: selectTuneBehaviorModel({
      trainFit,
      observations: tune,
      provenance: provenance(tune, "sha256:tune-schedule"),
    }),
  });
}

describe("selected behavior-model artifact store", () => {
  it("writes once and reads a verified artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "bhabhi-model-fit-"));
    temporaryRoots.push(root);
    const path = join(root, "nested", "selected-model.json");
    const artifact = artifactFixture();

    await writeSelectedBehaviorModelArtifact(path, artifact);
    await expect(
      writeSelectedBehaviorModelArtifact(path, artifact),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readSelectedBehaviorModelArtifact(path)).resolves.toEqual(
      artifact,
    );
  });
});
