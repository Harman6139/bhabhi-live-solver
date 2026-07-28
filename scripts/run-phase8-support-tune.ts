import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { captureSourceSnapshot } from "../src/evaluation/artifacts";
import {
  parseAndRehydratePhase8ManifestAuthority,
  parseAndRehydratePhase8SplitOpening,
} from "../src/evaluation/phase8-manifest";
import { readSelectedBehaviorModelArtifact } from "../src/modeling/artifact-store";
import { writePhase8SupportTuneArtifact } from "../src/modeling/support-tune-artifact";
import {
  createPhase8SupportTunePlan,
  runPhase8SupportTune,
} from "../src/modeling/support-tune";

type Options = Readonly<{
  tuneManifestPath: string;
  tuneOpeningPath: string;
  behaviorModelPath: string;
  outputDirectory: string;
  runId: string;
  evidence: boolean;
  smokeBaseCount: number | undefined;
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

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

function parseArguments(argv: readonly string[]): Options {
  let tuneManifestPath: string | null = null;
  let tuneOpeningPath: string | null = null;
  let behaviorModelPath: string | null = null;
  let outputDirectory: string | null = null;
  let runId = `phase8-support-tune-${new Date()
    .toISOString()
    .replaceAll(/[:.]/gu, "-")
    .toLowerCase()}`;
  let evidence = false;
  let smokeBaseCount: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--tune-manifest":
        tuneManifestPath = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--tune-opening":
        tuneOpeningPath = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--behavior-model":
        behaviorModelPath = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--output":
        outputDirectory = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--run-id":
        runId = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--evidence":
        evidence = true;
        break;
      case "--smoke-base-count":
        smokeBaseCount = positiveInteger(
          valueAfter(argv, index, argument),
          argument,
        );
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument ${argument ?? "<missing>"}.`);
    }
  }
  if (
    tuneManifestPath === null ||
    tuneOpeningPath === null ||
    behaviorModelPath === null ||
    outputDirectory === null
  ) {
    throw new Error(
      "Usage: npx tsx scripts/run-phase8-support-tune.ts --tune-manifest <development-tune-only-authority.json> --tune-opening <development-tune-opening.json> --behavior-model <selected-model.json> --output <new-directory> [--evidence | --smoke-base-count N] [--run-id id]",
    );
  }
  if (evidence && smokeBaseCount !== undefined) {
    throw new Error(
      "--evidence and --smoke-base-count are mutually exclusive.",
    );
  }
  return {
    tuneManifestPath,
    tuneOpeningPath,
    behaviorModelPath,
    outputDirectory,
    runId,
    evidence,
    smokeBaseCount,
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const projectRoot = resolve(".");
  const tuneAuthority = parseAndRehydratePhase8ManifestAuthority(
    await readFile(resolve(options.tuneManifestPath), "utf8"),
  );
  const tuneOpening = parseAndRehydratePhase8SplitOpening(
    tuneAuthority,
    await readFile(resolve(options.tuneOpeningPath), "utf8"),
  );
  const behaviorModel = await readSelectedBehaviorModelArtifact(
    resolve(options.behaviorModelPath),
  );
  const source = await captureSourceSnapshot(projectRoot);
  const plan = createPhase8SupportTunePlan({
    tuneAuthority,
    opening: tuneOpening,
    behaviorModel,
    source,
    runId: options.runId,
    mode: options.evidence ? "evidence" : "smoke",
    ...(options.smokeBaseCount === undefined
      ? {}
      : { smokeBaseCount: options.smokeBaseCount }),
  });
  let lastReported = 0;
  const startedAt = performance.now();
  const run = runPhase8SupportTune({
    tuneAuthority,
    opening: tuneOpening,
    plan,
    behaviorModel,
    onProgress: (progress) => {
      if (
        progress.attemptedGames === progress.expectedGames ||
        progress.attemptedGames - lastReported >= 16
      ) {
        lastReported = progress.attemptedGames;
        console.log(
          `support-tune ${progress.attemptedGames.toString()}/${progress.expectedGames.toString()} games, ${progress.completedGames.toString()} completed, ${progress.failures.toString()} failures`,
        );
      }
    },
  });
  const manifest = await writePhase8SupportTuneArtifact(
    resolve(options.outputDirectory),
    run,
  );
  console.log(
    JSON.stringify({
      directory: resolve(options.outputDirectory),
      mode: plan.mode,
      evidenceEligible: plan.evidenceEligible,
      games: run.integrity.completedGames,
      completeStyleBaseClusters: run.integrity.completeStyleBaseClusters,
      observations: run.observations.length,
      selectedPseudocount:
        run.selection?.selectedPseudocountPerFeasibleLabel ??
        run.provisionalSelectedPseudocount,
      evidenceSha256: run.evidenceSha256,
      artifactSha256: manifest.artifactSha256,
      elapsedMs: performance.now() - startedAt,
    }),
  );
}

await main();
