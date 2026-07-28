import { createHash } from "node:crypto";

import { FEASIBLE_SUPPORT_REGULARIZER_VERSION } from "../../src/calibration/support-regularization";
import { CANONICAL_RULES } from "../../src/domain/rule-config";
import { stableHash } from "../../src/events/stable-hash";
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
  type BehaviorFitObservation,
  type BehaviorHyperparameterGridInput,
} from "../../src/modeling/behavior-fit";
import {
  createPhase8ProductionModelArtifact,
  createPhase8SupportRegularizerTuneSelection,
  serializePhase8ProductionModelArtifact,
} from "../../src/modeling/production-model";
import { PHASE8_SUPPORT_REGULARIZER_GRID } from "../../src/modeling/selection-contract";
import {
  phase8Sha256,
  type Phase8ConfigurationDescriptor,
  type Phase8ConfigurationRoleId,
  type Phase8HashBundle,
} from "../../src/evaluation/phase8-manifest";
import {
  createPhase8TerminalConfigurationDescriptor,
  PHASE8_TERMINAL_REFERENCE_ID,
} from "../../src/evaluation/phase8-terminal-policy";

const SOURCE_SHA256 = "a".repeat(64);

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

function behaviorArtifact(robustChoice: boolean) {
  const grid: BehaviorHyperparameterGridInput = {
    lapseProbabilities: [0.08],
    likelihoodPowers: [0.5],
    maximumBayesFactors: [4],
    worldCounts: [16],
    robustChoices: [robustChoice],
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
    provenance: provenance(train, "phase8-terminal-train-schedule"),
  });
  return createSelectedBehaviorModelArtifact({
    trainFit,
    tuneSelection: selectTuneBehaviorModel({
      trainFit,
      observations: tune,
      provenance: provenance(tune, "phase8-terminal-tune-schedule"),
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

export function phase8TerminalProductionFixture(
  robustChoice = false,
): Readonly<{
  serialized: string;
  sha256: string;
}> {
  const supportSelection = createPhase8SupportRegularizerTuneSelection({
    sourceSha256: SOURCE_SHA256,
    tuneArtifactSha256: "b".repeat(64),
    tuneDatasetHash: stableHash({
      fixture: "phase8-terminal-tune-dataset",
    }),
    scorerSha256: "c".repeat(64),
    queryPlanSha256: "d".repeat(64),
    candidates: PHASE8_SUPPORT_REGULARIZER_GRID.map((config) => ({
      pseudocountPerFeasibleLabel: config.pseudocountPerFeasibleLabel,
      configHash: regularizerHash(config.pseudocountPerFeasibleLabel),
      completeClusters: 24,
      unresolvedSoftObservations: 48,
      equalFamilyUnresolvedSoftBrier:
        config.pseudocountPerFeasibleLabel === 0.5 ? 0.12 : 0.13,
      rawZeroFeasibleTruthCount: 0,
      hardKnownViolationCount: 0,
      failureCount: 0,
    })),
  });
  const serialized = serializePhase8ProductionModelArtifact(
    createPhase8ProductionModelArtifact({
      behavior: behaviorArtifact(robustChoice),
      supportRegularizerSelection: supportSelection,
    }),
  );
  return Object.freeze({
    serialized,
    sha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
  });
}

export function phase8TerminalDescriptors(
  model: Readonly<{ serialized: string }>,
  configIds: readonly Phase8ConfigurationRoleId[] = [
    PHASE8_TERMINAL_REFERENCE_ID,
  ],
): readonly Phase8ConfigurationDescriptor[] {
  return Object.freeze(
    configIds.map((configId) =>
      createPhase8TerminalConfigurationDescriptor({
        configId,
        serializedProductionModel: model.serialized,
      }),
    ),
  );
}

export function phase8TerminalHashBundle(input: {
  readonly modelSha256: string;
  readonly configurations: readonly Phase8ConfigurationDescriptor[];
}): Phase8HashBundle {
  return Object.freeze({
    sourceSha256: SOURCE_SHA256,
    rulesSha256: phase8Sha256(CANONICAL_RULES),
    configSha256: phase8Sha256(input.configurations),
    modelSha256: input.modelSha256,
    scorerSha256: "e".repeat(64),
    reportSha256: "f".repeat(64),
    preregistrationSha256: "1".repeat(64),
  });
}
