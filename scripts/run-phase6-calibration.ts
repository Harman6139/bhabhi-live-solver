import { resolve } from "node:path";

import {
  captureEnvironment,
  captureSourceSnapshot,
} from "../src/evaluation/artifacts";
import {
  verifyCalibrationArtifacts,
  writeCalibrationArtifacts,
} from "../src/calibration/artifacts";
import { createPhase6CalibrationPlan } from "../src/calibration/protocol";
import {
  assertPhase6CalibrationSourceUnchanged,
  buildPhase6CalibrationArtifactRun,
  renderPhase6CalibrationCommand,
} from "../src/calibration/run-artifacts";
import { runPhase6Calibration } from "../src/calibration/runner";

type CliOptions = {
  readonly runId: string;
  readonly split: "dev" | "train" | "tune";
  readonly baseCount: number;
  readonly baseIndexStart: number;
  readonly hardWorldSamples: number;
  readonly artifactRoot: string;
};

function valueAfter(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function integerOption(
  args: readonly string[],
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = valueAfter(args, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(
      `${name} must be a safe integer at least ${minimum.toString()}.`,
    );
  }
  return value;
}

function parseOptions(args: readonly string[]): CliOptions {
  const runId = valueAfter(args, "--run-id");
  if (runId === undefined) {
    throw new Error("--run-id is required for immutable calibration output.");
  }
  const split = valueAfter(args, "--split") ?? "dev";
  if (split !== "dev" && split !== "train" && split !== "tune") {
    throw new Error(
      "--split must be dev, train, or tune; Phase 6 cannot open qualification/final.",
    );
  }
  return {
    runId,
    split,
    baseCount: integerOption(args, "--base-count", 1, 1),
    baseIndexStart: integerOption(args, "--base-index-start", 0, 0),
    hardWorldSamples: integerOption(args, "--worlds", 64, 1),
    artifactRoot: resolve(
      valueAfter(args, "--artifact-root") ?? "artifacts/calibration",
    ),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseOptions(args);
  const projectRoot = resolve(".");
  const createdAt = new Date().toISOString();
  const [sourceBefore, environment] = await Promise.all([
    captureSourceSnapshot(projectRoot),
    Promise.resolve(captureEnvironment(createdAt)),
  ]);
  const plan = createPhase6CalibrationPlan({
    runId: options.runId,
    split: options.split,
    baseCount: options.baseCount,
    baseIndexStart: options.baseIndexStart,
    hardWorldSamples: options.hardWorldSamples,
  });
  const result = runPhase6Calibration(plan);
  const sourceAfter = await captureSourceSnapshot(projectRoot);
  assertPhase6CalibrationSourceUnchanged(sourceBefore, sourceAfter);
  const artifact = await buildPhase6CalibrationArtifactRun(result, {
    projectRoot,
    createdAt,
    sourceSnapshot: sourceBefore,
    environment,
    command: renderPhase6CalibrationCommand(args),
  });
  const written = await writeCalibrationArtifacts(
    artifact,
    options.artifactRoot,
  );
  const verification = await verifyCalibrationArtifacts(written.runDirectory);
  process.stdout.write(
    `${JSON.stringify(
      {
        runDirectory: written.runDirectory,
        split: plan.split,
        attemptedGames: result.attemptedGames,
        completedGames: result.completedGames,
        attemptedCheckpoints: result.attemptedCheckpoints,
        completedCheckpoints: result.completedCheckpoints,
        predictions: result.predictions.length,
        truthRecords: result.truths.length,
        skippedConditionalPairs: result.skippedConditionalPairIds.length,
        failures: result.failures.length,
        zeroFailureGate: artifact.summary.zeroFailureGate,
        behaviorProductionEnabled: artifact.summary.behaviorProductionEnabled,
        verification,
      },
      null,
      2,
    )}\n`,
  );
  if (!artifact.summary.zeroFailureGate || !verification.valid) {
    process.exitCode = 1;
  }
}

await main();
