import { describe, expect, it } from "vitest";

import {
  BEHAVIOR_FIT_SCORER_HASH,
  behaviorBeliefConfigFromSelectedArtifact,
  behaviorConfigFamilyHash,
  behaviorFitDatasetContentHash,
  behaviorFitDatasetHash,
  createSelectedBehaviorModelArtifact,
  expandBehaviorHyperparameterGrid,
  fitTrainBehaviorGrid,
  parseSelectedBehaviorModelArtifact,
  selectTuneBehaviorModel,
  serializeSelectedBehaviorModelArtifact,
  verifySelectedBehaviorModelArtifact,
  type BehaviorCandidateParameters,
  type BehaviorFitObservation,
  type BehaviorFitProvenance,
  type BehaviorHyperparameterGridInput,
} from "../../src/modeling/behavior-fit";
import {
  BEHAVIOR_MODEL_IDS,
  type BehaviorModelId,
} from "../../src/inference/behavior-models";

const grid: BehaviorHyperparameterGridInput = {
  lapseProbabilities: [0.2, 0.05],
  likelihoodPowers: [0.5, 1],
  maximumBayesFactors: [2, 4],
  worldCounts: [32, 16],
  robustChoices: [true, false],
};

function modelFeatures(
  preferredModelId: BehaviorModelId,
  degenerate = false,
): BehaviorFitObservation["worldEstimates"][number]["modelFeatures"] {
  return Object.fromEntries(
    BEHAVIOR_MODEL_IDS.map((modelId) => [
      modelId,
      {
        uniformProbability: degenerate ? 0 : 0.25,
        preferredProbability: degenerate
          ? 0
          : modelId === "random"
            ? 0.25
            : modelId === preferredModelId
              ? 1
              : 0,
      },
    ]),
  ) as BehaviorFitObservation["worldEstimates"][number]["modelFeatures"];
}

function syntheticObservations(
  split: "train" | "tune",
  options: {
    readonly degenerate?: boolean;
    readonly reverse?: boolean;
  } = {},
): BehaviorFitObservation[] {
  const observations: BehaviorFitObservation[] = [];
  for (const seat of ["p2", "p3"] as const) {
    const preferredModelId =
      seat === "p2" ? ("always-high" as const) : ("always-low" as const);
    for (let sequence = 0; sequence < 10; sequence += 1) {
      for (let decisionOrdinal = 0; decisionOrdinal < 4; decisionOrdinal += 1) {
        observations.push({
          schemaVersion: 1,
          observationId: `${split}-${seat}-${sequence.toString()}-${decisionOrdinal.toString()}`,
          split,
          styleCellId:
            seat === "p2"
              ? "c08_always-high__always-low"
              : "c09_always-low__always-high",
          sequenceId: `${split}-${seat}-sequence-${sequence.toString()}`,
          seat,
          decisionOrdinal,
          worldEstimates: [32, 16].map((worldCount) => ({
            worldCount,
            modelFeatures: modelFeatures(preferredModelId, options.degenerate),
          })),
        });
      }
    }
  }
  return options.reverse ? observations.reverse() : observations;
}

function provenance(
  observations: readonly BehaviorFitObservation[],
  scheduleHash: string,
): BehaviorFitProvenance {
  return {
    sourceHash: "sha256:source-fixture",
    datasetHash: behaviorFitDatasetHash(observations),
    datasetContentHash: behaviorFitDatasetContentHash(observations),
    scheduleHash,
    scorerHash: BEHAVIOR_FIT_SCORER_HASH,
    configFamilyHash: behaviorConfigFamilyHash(grid),
  };
}

function fitFixture(options: { readonly degenerate?: boolean } = {}) {
  const train = syntheticObservations("train", options);
  const tune = syntheticObservations("tune", options);
  const trainFit = fitTrainBehaviorGrid({
    observations: train,
    grid,
    provenance: provenance(train, "sha256:train-schedule"),
  });
  const tuneSelection = selectTuneBehaviorModel({
    trainFit,
    observations: tune,
    provenance: provenance(tune, "sha256:tune-schedule"),
  });
  return {
    train,
    tune,
    trainFit,
    tuneSelection,
    artifact: createSelectedBehaviorModelArtifact({
      trainFit,
      tuneSelection,
    }),
  };
}

describe("Phase 8 behavior model fitting", () => {
  it("recovers distinct public-action archetypes for P2 and P3", () => {
    const { trainFit, artifact } = fitFixture();
    const selected = trainFit.candidates.find(
      (candidate) =>
        candidate.candidateId === artifact.payload.selectedCandidateId,
    );

    expect(selected).toBeDefined();
    expect(selected?.opponents.p2.fittedPriors["always-high"]).toBeGreaterThan(
      0.7,
    );
    expect(selected?.opponents.p3.fittedPriors["always-low"]).toBeGreaterThan(
      0.7,
    );
    expect(
      artifact.payload.opponentConfigs.p2.modelPriors["always-high"],
    ).toBeGreaterThan(
      artifact.payload.opponentConfigs.p2.modelPriors["always-low"],
    );
    expect(
      artifact.payload.opponentConfigs.p3.modelPriors["always-low"],
    ).toBeGreaterThan(
      artifact.payload.opponentConfigs.p3.modelPriors["always-high"],
    );
    const inferenceConfig = behaviorBeliefConfigFromSelectedArtifact(artifact);
    expect(inferenceConfig).toMatchObject({
      lapseProbability: artifact.payload.parameters.lapseProbability,
      likelihoodPower: artifact.payload.parameters.likelihoodPower,
      maximumBayesFactor: artifact.payload.parameters.maximumBayesFactor,
      opponentModelPriors: {
        p2: artifact.payload.opponentConfigs.p2.modelPriors,
        p3: artifact.payload.opponentConfigs.p3.modelPriors,
      },
    });
    expect(Object.isFrozen(inferenceConfig)).toBe(true);
  });

  it("is invariant to grid, observation, and world-estimate ordering", () => {
    const first = fitFixture();
    const reversedTrain = syntheticObservations("train", {
      reverse: true,
    }).map((observation) => ({
      ...observation,
      worldEstimates: [...observation.worldEstimates].reverse(),
    }));
    const reversedTune = syntheticObservations("tune", {
      reverse: true,
    }).map((observation) => ({
      ...observation,
      worldEstimates: [...observation.worldEstimates].reverse(),
    }));
    const reversedGrid: BehaviorHyperparameterGridInput = {
      lapseProbabilities: [...grid.lapseProbabilities].reverse(),
      likelihoodPowers: [...grid.likelihoodPowers].reverse(),
      maximumBayesFactors: [...grid.maximumBayesFactors].reverse(),
      worldCounts: [...grid.worldCounts].reverse(),
      robustChoices: [...(grid.robustChoices ?? [])].reverse(),
    };
    const trainFit = fitTrainBehaviorGrid({
      observations: reversedTrain,
      grid: reversedGrid,
      provenance: {
        ...provenance(reversedTrain, "sha256:train-schedule"),
        configFamilyHash: behaviorConfigFamilyHash(reversedGrid),
      },
    });
    const selection = selectTuneBehaviorModel({
      trainFit,
      observations: reversedTune,
      provenance: {
        ...provenance(reversedTune, "sha256:tune-schedule"),
        configFamilyHash: behaviorConfigFamilyHash(reversedGrid),
      },
    });
    const second = createSelectedBehaviorModelArtifact({
      trainFit,
      tuneSelection: selection,
    });

    expect(second.payloadChecksum).toBe(first.artifact.payloadChecksum);
    expect(behaviorConfigFamilyHash(reversedGrid)).toBe(
      behaviorConfigFamilyHash(grid),
    );
  });

  it("rejects qualification/final data, truth-bearing records, and stress cells", () => {
    const train = syntheticObservations("train");
    const base = train[0];
    expect(base).toBeDefined();

    expect(() =>
      fitTrainBehaviorGrid({
        observations: train.map((observation, index) =>
          index === 0
            ? { ...observation, split: "qualification" }
            : observation,
        ),
        grid,
        provenance: provenance(train, "sha256:train-schedule"),
      }),
    ).toThrow(/Invalid option|train|qualification/u);

    expect(() =>
      fitTrainBehaviorGrid({
        observations: train.map((observation, index) =>
          index === 0
            ? { ...observation, truth: { hiddenHands: true } }
            : observation,
        ),
        grid,
        provenance: provenance(train, "sha256:train-schedule"),
      }),
    ).toThrow(/Unrecognized key|truth/u);

    expect(() =>
      fitTrainBehaviorGrid({
        observations: train.map((observation, index) =>
          index === 0
            ? {
                ...observation,
                styleCellId: "c16_noisy-mixture__phase-switch",
              }
            : observation,
        ),
        grid,
        provenance: provenance(train, "sha256:train-schedule"),
      }),
    ).toThrow(/fittable|stress/u);
  });

  it("enforces declared hashes and disjoint train/tune schedules", () => {
    const train = syntheticObservations("train");
    expect(() =>
      fitTrainBehaviorGrid({
        observations: train,
        grid,
        provenance: {
          ...provenance(train, "sha256:train-schedule"),
          datasetHash: "sha256:wrong",
        },
      }),
    ).toThrow(/dataset hash/u);

    const trainFit = fitTrainBehaviorGrid({
      observations: train,
      grid,
      provenance: provenance(train, "sha256:shared-schedule"),
    });
    const tune = syntheticObservations("tune");
    expect(() =>
      selectTuneBehaviorModel({
        trainFit,
        observations: tune,
        provenance: provenance(tune, "sha256:shared-schedule"),
      }),
    ).toThrow(/disjoint/u);
  });

  it("keeps log likelihood and posteriors finite for zero-mass estimates", () => {
    const { trainFit, tuneSelection, artifact } = fitFixture({
      degenerate: true,
    });

    for (const candidate of trainFit.candidates) {
      expect(Number.isFinite(candidate.meanNegativeLogLikelihood)).toBe(true);
      expect(candidate.meanNegativeLogLikelihood).toBeGreaterThan(0);
      for (const seat of ["p2", "p3"] as const) {
        for (const modelId of BEHAVIOR_MODEL_IDS) {
          expect(
            Number.isFinite(candidate.opponents[seat].fittedPriors[modelId]),
          ).toBe(true);
          expect(
            candidate.opponents[seat].fittedPriors[modelId],
          ).toBeGreaterThan(0);
        }
      }
    }
    expect(
      tuneSelection.candidateScores.every((score) =>
        Number.isFinite(score.meanNegativeLogLikelihood),
      ),
    ).toBe(true);
    expect(verifySelectedBehaviorModelArtifact(artifact).ok).toBe(true);
  });

  it("deduplicates the grid and deterministically prefers non-robust exact ties", () => {
    const duplicateGrid: BehaviorHyperparameterGridInput = {
      lapseProbabilities: [0.1, 0.1],
      likelihoodPowers: [0.5, 0.5],
      maximumBayesFactors: [4, 4],
      worldCounts: [16, 16],
      robustChoices: [true, false, true],
    };
    const expanded = expandBehaviorHyperparameterGrid(duplicateGrid);

    expect(expanded).toHaveLength(2);
    expect(expanded[0]?.robustChoice).toBe(false);
  });

  it("detects provenance, configuration, and checksum mutation", () => {
    const { artifact } = fitFixture();
    const mutated = structuredClone(artifact) as {
      payload: {
        sourceHash: string;
        parameters: BehaviorCandidateParameters;
      };
      payloadChecksum: string;
    };
    mutated.payload.sourceHash = "sha256:mutated-source";

    const verification = verifySelectedBehaviorModelArtifact(mutated);
    expect(verification.ok).toBe(false);
    expect(verification.issues.join(" ")).toMatch(/checksum/u);

    const configMutation = structuredClone(artifact) as {
      payload: {
        opponentConfigs: {
          p2: { lapseProbability: number };
        };
      };
    };
    configMutation.payload.opponentConfigs.p2.lapseProbability = 0.4;
    const configVerification =
      verifySelectedBehaviorModelArtifact(configMutation);
    expect(configVerification.ok).toBe(false);
    expect(configVerification.issues.join(" ")).toMatch(
      /hyperparameters|checksum/u,
    );
  });

  it("round-trips canonical immutable serialization", () => {
    const { artifact } = fitFixture();
    const first = serializeSelectedBehaviorModelArtifact(artifact);
    const parsed = parseSelectedBehaviorModelArtifact(first);
    const second = serializeSelectedBehaviorModelArtifact(parsed);

    expect(second).toBe(first);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.payload.opponentConfigs.p2.modelPriors)).toBe(
      true,
    );
    expect(parsed).toEqual(artifact);
  });
});
