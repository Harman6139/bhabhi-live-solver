import { resolve } from "node:path";

import { captureSourceSnapshot } from "../src/evaluation/artifacts";
import {
  createBehaviorDatasetPlan,
  runBehaviorFitDataset,
} from "../src/modeling/behavior-dataset";
import {
  readVerifiedBehaviorDatasetArtifacts,
  writeBehaviorDatasetArtifacts,
} from "../src/modeling/dataset-artifact";
import {
  BEHAVIOR_FIT_SCORER_HASH,
  behaviorFitDatasetContentHash,
  behaviorFitDatasetHash,
  createSelectedBehaviorModelArtifact,
  fitTrainBehaviorGrid,
  selectTuneBehaviorModel,
  type BehaviorFitSplit,
} from "../src/modeling/behavior-fit";
import { writeSelectedBehaviorModelArtifact } from "../src/modeling/artifact-store";
import {
  PHASE8_BEHAVIOR_CONFIG_FAMILY_HASH,
  PHASE8_BEHAVIOR_HYPERPARAMETER_GRID,
  PHASE8_MODEL_SELECTION_CONTRACT_HASH,
} from "../src/modeling/selection-contract";

type DatasetOptions = {
  readonly mode: "dataset";
  readonly split: BehaviorFitSplit;
  readonly runId: string;
  readonly artifactRoot: string;
  readonly evidenceEligible: boolean;
  readonly baseCount: number | undefined;
  readonly styleCellIds: readonly string[] | undefined;
  readonly rotations: readonly (0 | 1 | 2)[] | undefined;
  readonly decisionOrdinals: readonly number[] | undefined;
  readonly worldCounts: readonly number[] | undefined;
  readonly noWrite: boolean;
};

type FitOptions = {
  readonly mode: "fit";
  readonly trainDirectory: string;
  readonly tuneDirectory: string;
  readonly outputPath: string;
  readonly evidenceEligible: boolean;
};

type Options = DatasetOptions | FitOptions;

function valueAfter(
  argv: readonly string[],
  index: number,
  name: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function integer(value: string, name: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new RangeError(
      `${name} must be a safe integer >= ${minimum.toString()}.`,
    );
  }
  return parsed;
}

function commaIntegers(value: string, name: string): number[] {
  const values = value.split(",").map((entry) => integer(entry, name, 0));
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`${name} must be a non-empty unique comma list.`);
  }
  return values;
}

function parseDataset(argv: readonly string[]): DatasetOptions {
  let split: BehaviorFitSplit | null = null;
  let runId = `phase8-behavior-${new Date()
    .toISOString()
    .replaceAll(/[:.]/gu, "-")}`;
  let artifactRoot = "artifacts/modeling/eval-v1";
  let evidenceEligible = false;
  let baseCount: number | undefined;
  let styleCellIds: string[] | undefined;
  let rotations: (0 | 1 | 2)[] | undefined;
  let decisionOrdinals: number[] | undefined;
  let worldCounts: number[] | undefined;
  let noWrite = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--split": {
        const value = valueAfter(argv, index, argument);
        if (value !== "train" && value !== "tune") {
          throw new Error("--split must be train or tune.");
        }
        split = value;
        index += 1;
        break;
      }
      case "--run-id":
        runId = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--artifact-root":
        artifactRoot = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--evidence-eligible":
        evidenceEligible = true;
        break;
      case "--base-count":
        baseCount = integer(valueAfter(argv, index, argument), argument, 1);
        index += 1;
        break;
      case "--style-cells":
        styleCellIds = valueAfter(argv, index, argument).split(",");
        index += 1;
        break;
      case "--rotations": {
        const values = commaIntegers(
          valueAfter(argv, index, argument),
          argument,
        );
        if (values.some((value) => value > 2)) {
          throw new Error("--rotations values must be 0, 1, or 2.");
        }
        rotations = values as (0 | 1 | 2)[];
        index += 1;
        break;
      }
      case "--decision-ordinals":
        decisionOrdinals = commaIntegers(
          valueAfter(argv, index, argument),
          argument,
        );
        index += 1;
        break;
      case "--world-counts":
        worldCounts = commaIntegers(
          valueAfter(argv, index, argument),
          argument,
        );
        index += 1;
        break;
      case "--no-write":
        noWrite = true;
        break;
      default:
        throw new Error(`Unknown dataset argument ${argument ?? "<missing>"}.`);
    }
  }
  if (split === null) {
    throw new Error("Dataset mode requires --split train|tune.");
  }
  if (evidenceEligible && noWrite) {
    throw new Error("Evidence-eligible datasets cannot use --no-write.");
  }
  return {
    mode: "dataset",
    split,
    runId,
    artifactRoot,
    evidenceEligible,
    baseCount,
    styleCellIds,
    rotations,
    decisionOrdinals,
    worldCounts,
    noWrite,
  };
}

function parseFit(argv: readonly string[]): FitOptions {
  let trainDirectory: string | null = null;
  let tuneDirectory: string | null = null;
  let outputPath: string | null = null;
  let evidenceEligible = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--train":
        trainDirectory = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--tune":
        tuneDirectory = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--output":
        outputPath = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--evidence-eligible":
        evidenceEligible = true;
        break;
      default:
        throw new Error(`Unknown fit argument ${argument ?? "<missing>"}.`);
    }
  }
  if (
    trainDirectory === null ||
    tuneDirectory === null ||
    outputPath === null
  ) {
    throw new Error("Fit mode requires --train, --tune, and --output.");
  }
  return {
    mode: "fit",
    trainDirectory,
    tuneDirectory,
    outputPath,
    evidenceEligible,
  };
}

function parseArguments(argv: readonly string[]): Options {
  const mode = argv[0];
  if (mode === "dataset") {
    return parseDataset(argv.slice(1));
  }
  if (mode === "fit") {
    return parseFit(argv.slice(1));
  }
  throw new Error("First argument must be dataset or fit.");
}

function datasetCommand(options: DatasetOptions): string {
  return [
    "npm run model:phase8",
    "--",
    "--",
    "dataset",
    "--split",
    options.split,
    "--run-id",
    options.runId,
    "--artifact-root",
    options.artifactRoot,
    ...(options.evidenceEligible ? ["--evidence-eligible"] : []),
    ...(options.baseCount === undefined
      ? []
      : ["--base-count", options.baseCount.toString()]),
    ...(options.styleCellIds === undefined
      ? []
      : ["--style-cells", options.styleCellIds.join(",")]),
    ...(options.rotations === undefined
      ? []
      : ["--rotations", options.rotations.join(",")]),
    ...(options.decisionOrdinals === undefined
      ? []
      : ["--decision-ordinals", options.decisionOrdinals.join(",")]),
    ...(options.worldCounts === undefined
      ? []
      : ["--world-counts", options.worldCounts.join(",")]),
    ...(options.noWrite ? ["--no-write"] : []),
  ].join(" ");
}

async function runDataset(options: DatasetOptions): Promise<void> {
  const projectRoot = resolve(".");
  const source = await captureSourceSnapshot(projectRoot);
  if (options.evidenceEligible && source.gitDirty) {
    throw new Error(
      "Evidence-eligible train/tune generation requires a clean committed source snapshot.",
    );
  }
  const plan = createBehaviorDatasetPlan({
    runId: options.runId,
    split: options.split,
    evidenceEligible: options.evidenceEligible,
    ...(options.baseCount === undefined
      ? {}
      : { baseCount: options.baseCount }),
    ...(options.styleCellIds === undefined
      ? {}
      : { styleCellIds: options.styleCellIds }),
    ...(options.rotations === undefined
      ? {}
      : { rotations: options.rotations }),
    ...(options.decisionOrdinals === undefined
      ? {}
      : { opponentDecisionOrdinals: options.decisionOrdinals }),
    ...(options.worldCounts === undefined
      ? {}
      : { worldCounts: options.worldCounts }),
  });
  const startedAt = performance.now();
  let lastReported = 0;
  const dataset = runBehaviorFitDataset({
    plan,
    onProgress: (progress) => {
      if (
        progress.attemptedGames === progress.expectedGames ||
        progress.attemptedGames - lastReported >= 32
      ) {
        lastReported = progress.attemptedGames;
        console.log(
          `behavior-data ${progress.attemptedGames.toString()}/${progress.expectedGames.toString()} games, ${progress.observations.toString()} observations, ${progress.failures.toString()} failures`,
        );
      }
    },
  });
  const elapsedMs = performance.now() - startedAt;
  if (options.noWrite) {
    console.log(
      JSON.stringify({
        split: plan.split,
        expectedGames: dataset.games.length,
        observations: dataset.observations.length,
        failures: dataset.failures.length,
        scheduleHash: dataset.scheduleHash,
        elapsedMs,
        evidenceEligible: false,
        written: false,
      }),
    );
    return;
  }
  const directory = resolve(options.artifactRoot, options.split, options.runId);
  const manifest = await writeBehaviorDatasetArtifacts({
    directory,
    dataset,
    source,
    command: datasetCommand(options),
  });
  console.log(
    JSON.stringify({
      directory,
      manifestSha256: manifest.manifestSha256,
      datasetHash: manifest.datasetHash,
      observations: manifest.observationCount,
      games: manifest.completedGames,
      failures: manifest.failureCount,
      evidenceGate: manifest.evidenceGate,
      elapsedMs,
    }),
  );
}

async function runFit(options: FitOptions): Promise<void> {
  const train = await readVerifiedBehaviorDatasetArtifacts(
    resolve(options.trainDirectory),
  );
  const tune = await readVerifiedBehaviorDatasetArtifacts(
    resolve(options.tuneDirectory),
  );
  if (
    train.manifest.plan.split !== "train" ||
    tune.manifest.plan.split !== "tune"
  ) {
    throw new Error("Fit inputs must be train and tune respectively.");
  }
  if (
    options.evidenceEligible &&
    (!train.manifest.plan.evidenceEligible ||
      !tune.manifest.plan.evidenceEligible ||
      !train.manifest.evidenceGate ||
      !tune.manifest.evidenceGate)
  ) {
    throw new Error(
      "Evidence-eligible fitting requires two verified evidence-eligible datasets.",
    );
  }
  if (
    train.manifest.source.sourceSnapshotSha256 !==
      tune.manifest.source.sourceSnapshotSha256 ||
    train.manifest.source.gitCommit !== tune.manifest.source.gitCommit
  ) {
    throw new Error(
      "Train and tune datasets must bind the same committed source snapshot.",
    );
  }
  const sourceHash = train.manifest.source.sourceSnapshotSha256;
  const trainFit = fitTrainBehaviorGrid({
    observations: train.dataset.observations,
    grid: PHASE8_BEHAVIOR_HYPERPARAMETER_GRID,
    provenance: {
      sourceHash,
      datasetHash: behaviorFitDatasetHash(train.dataset.observations),
      datasetContentHash: behaviorFitDatasetContentHash(
        train.dataset.observations,
      ),
      scheduleHash: train.dataset.scheduleHash,
      scorerHash: BEHAVIOR_FIT_SCORER_HASH,
      configFamilyHash: PHASE8_BEHAVIOR_CONFIG_FAMILY_HASH,
    },
  });
  const tuneSelection = selectTuneBehaviorModel({
    trainFit,
    observations: tune.dataset.observations,
    provenance: {
      sourceHash,
      datasetHash: behaviorFitDatasetHash(tune.dataset.observations),
      datasetContentHash: behaviorFitDatasetContentHash(
        tune.dataset.observations,
      ),
      scheduleHash: tune.dataset.scheduleHash,
      scorerHash: BEHAVIOR_FIT_SCORER_HASH,
      configFamilyHash: PHASE8_BEHAVIOR_CONFIG_FAMILY_HASH,
    },
  });
  const artifact = createSelectedBehaviorModelArtifact({
    trainFit,
    tuneSelection,
  });
  await writeSelectedBehaviorModelArtifact(
    resolve(options.outputPath),
    artifact,
  );
  console.log(
    JSON.stringify({
      outputPath: resolve(options.outputPath),
      payloadChecksum: artifact.payloadChecksum,
      selectedCandidateId: artifact.payload.selectedCandidateId,
      parameters: artifact.payload.parameters,
      trainObservations: artifact.payload.train.observationCount,
      tuneObservations: artifact.payload.tune.observationCount,
      modelSelectionContractHash: PHASE8_MODEL_SELECTION_CONTRACT_HASH,
      evidenceEligible: options.evidenceEligible,
    }),
  );
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "dataset") {
    await runDataset(options);
  } else {
    await runFit(options);
  }
}

await main();
