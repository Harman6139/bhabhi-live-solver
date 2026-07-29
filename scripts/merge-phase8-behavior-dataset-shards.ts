import { resolve } from "node:path";

import { FITTABLE_STYLE_CELL_IDS } from "../src/calibration/protocol";
import { stableStringify } from "../src/events/stable-hash";
import {
  behaviorDatasetScheduleHash,
  createBehaviorDatasetPlan,
  type BehaviorFitDataset,
} from "../src/modeling/behavior-dataset";
import {
  readVerifiedBehaviorDatasetArtifacts,
  writeBehaviorDatasetArtifacts,
} from "../src/modeling/dataset-artifact";

type Options = Readonly<{
  split: "train" | "tune";
  inputRoot: string;
  output: string;
  runId: string;
  expectedCommit: string | undefined;
}>;

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

function parseArguments(argv: readonly string[]): Options {
  let split: "train" | "tune" | null = null;
  let inputRoot: string | null = null;
  let output: string | null = null;
  let runId: string | null = null;
  let expectedCommit: string | undefined;
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
      case "--input-root":
        inputRoot = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--output":
        output = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--run-id":
        runId = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--expected-commit":
        expectedCommit = valueAfter(argv, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument ${argument ?? "<missing>"}.`);
    }
  }
  if (
    split === null ||
    inputRoot === null ||
    output === null ||
    runId === null
  ) {
    throw new Error(
      "Usage: tsx scripts/merge-phase8-behavior-dataset-shards.ts --split train|tune --input-root <download-root> --output <new-directory> --run-id <id> [--expected-commit <sha>]",
    );
  }
  return { split, inputRoot, output, runId, expectedCommit };
}

function same(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const inputRoot = resolve(options.inputRoot);
  const shards = await Promise.all(
    FITTABLE_STYLE_CELL_IDS.map(async (styleCellId) => {
      const directory = resolve(
        inputRoot,
        `behavior-${options.split}-${styleCellId}`,
        "dataset",
      );
      const artifact = await readVerifiedBehaviorDatasetArtifacts(directory);
      const plan = artifact.dataset.plan;
      if (
        plan.split !== options.split ||
        plan.evidenceEligible ||
        plan.baseIndexStart !== 0 ||
        plan.baseCount !== 64 ||
        !same(plan.styleCellIds, [styleCellId]) ||
        !same(plan.rotations, [0, 1, 2])
      ) {
        throw new Error(
          `Shard ${styleCellId} does not match its frozen split/style/base/rotation coordinate.`,
        );
      }
      return { styleCellId, ...artifact };
    }),
  );

  const first = shards[0];
  if (first === undefined) {
    throw new Error("No behavior dataset shards were supplied.");
  }
  for (const shard of shards) {
    if (
      !same(shard.manifest.source, first.manifest.source) ||
      !same(
        shard.dataset.plan.opponentDecisionOrdinals,
        first.dataset.plan.opponentDecisionOrdinals,
      ) ||
      !same(shard.dataset.plan.worldCounts, first.dataset.plan.worldCounts) ||
      shard.dataset.plan.eventCap !== first.dataset.plan.eventCap
    ) {
      throw new Error(
        `Shard ${shard.styleCellId} is not source/schedule-compatible with the other shards.`,
      );
    }
  }
  if (
    options.expectedCommit !== undefined &&
    first.manifest.source.gitCommit !== options.expectedCommit
  ) {
    throw new Error(
      `Shard source commit ${first.manifest.source.gitCommit ?? "<none>"} does not match ${options.expectedCommit}.`,
    );
  }

  const plan = createBehaviorDatasetPlan({
    runId: options.runId,
    split: options.split,
    evidenceEligible: true,
    baseIndexStart: 0,
    baseCount: 64,
    styleCellIds: FITTABLE_STYLE_CELL_IDS,
    rotations: [0, 1, 2],
    opponentDecisionOrdinals:
      first.dataset.plan.opponentDecisionOrdinals,
    worldCounts: first.dataset.plan.worldCounts,
    eventCap: first.dataset.plan.eventCap,
  });
  const observations = shards
    .flatMap((shard) => [...shard.dataset.observations])
    .sort((left, right) =>
      left.observationId.localeCompare(right.observationId),
    );
  const games = shards
    .flatMap((shard) => [...shard.dataset.games])
    .sort((left, right) => left.gameId.localeCompare(right.gameId));
  const failures = shards.flatMap((shard) => [...shard.dataset.failures]);
  if (
    new Set(observations.map((value) => value.observationId)).size !==
      observations.length ||
    new Set(games.map((value) => value.gameId)).size !== games.length
  ) {
    throw new Error("Merged behavior dataset contains duplicate IDs.");
  }
  const dataset: BehaviorFitDataset = Object.freeze({
    plan,
    scheduleHash: behaviorDatasetScheduleHash(plan),
    observations: Object.freeze(observations),
    games: Object.freeze(games),
    failures: Object.freeze(failures),
  });
  const manifest = await writeBehaviorDatasetArtifacts({
    directory: resolve(options.output),
    dataset,
    source: first.manifest.source,
    command: [
      "npx tsx scripts/merge-phase8-behavior-dataset-shards.ts",
      "--split",
      options.split,
      "--input-root",
      options.inputRoot,
      "--output",
      options.output,
      "--run-id",
      options.runId,
      ...(options.expectedCommit === undefined
        ? []
        : ["--expected-commit", options.expectedCommit]),
    ].join(" "),
  });
  console.log(
    JSON.stringify({
      output: resolve(options.output),
      split: options.split,
      shardCount: shards.length,
      sourceCommit: first.manifest.source.gitCommit,
      games: manifest.completedGames,
      observations: manifest.observationCount,
      failures: manifest.failureCount,
      scheduleHash: manifest.scheduleHash,
      datasetHash: manifest.datasetHash,
      manifestSha256: manifest.manifestSha256,
      evidenceGate: manifest.evidenceGate,
    }),
  );
}

await main();
