import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CANONICAL_RULES } from "../src/domain/rule-config";
import {
  buildPhase7ComparisonArtifactRun,
  phase7ComparisonIndividualGateFailures,
  phase7ComparisonReproductionReferenceFor,
  phase7ComparisonScientificDigest,
  verifyPhase7ComparisonArtifacts,
  writePhase7ComparisonArtifacts,
} from "../src/evaluation/phase7-comparison-artifacts";
import {
  phase7ComparisonManifestSchema,
  type Phase7ComparisonReproductionReference,
  type Phase7ComparisonRunKind,
} from "../src/evaluation/phase7-comparison-schema";
import { captureSourceSnapshot } from "../src/evaluation/artifacts";
import {
  createPhase7ComparisonPlan,
  runPhase7Comparison,
  type Phase7ComparisonProgress,
} from "../src/evaluation/phase7-comparison-runner";

type CliOptions = {
  readonly runId: string;
  readonly runKind: Phase7ComparisonRunKind;
  readonly baseIndexStart: number;
  readonly baseCount: number;
  readonly artifactRoot: string;
  readonly primaryDirectory: string | null;
  readonly noWrite: boolean;
};

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

function parseSafeInteger(
  value: string,
  name: string,
  minimum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new RangeError(
      `${name} must be a safe integer greater than or equal to ${minimum.toString()}.`,
    );
  }
  return parsed;
}

function parseArguments(argv: readonly string[]): CliOptions {
  let runId = `phase7-comparison-${new Date()
    .toISOString()
    .replaceAll(/[:.]/gu, "-")}`;
  let runKind: Phase7ComparisonRunKind | null = null;
  let baseIndexStart = 0;
  let baseCount: number | null = null;
  let artifactRoot = "artifacts/evaluation";
  let primaryDirectory: string | null = null;
  let noWrite = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--run-id":
        runId = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--run-kind": {
        const value = valueAfter(argv, index, argument);
        if (
          value !== "smoke" &&
          value !== "development-primary" &&
          value !== "development-reproduction"
        ) {
          throw new Error(`Unsupported Phase 7 run kind: ${value}.`);
        }
        runKind = value;
        index += 1;
        break;
      }
      case "--base-index-start":
        baseIndexStart = parseSafeInteger(
          valueAfter(argv, index, argument),
          argument,
          0,
        );
        index += 1;
        break;
      case "--base-count":
        baseCount = parseSafeInteger(
          valueAfter(argv, index, argument),
          argument,
          1,
        );
        index += 1;
        break;
      case "--artifact-root":
        artifactRoot = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--primary":
        primaryDirectory = resolve(valueAfter(argv, index, argument));
        index += 1;
        break;
      case "--no-write":
        noWrite = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument ?? "<missing>"}`);
    }
  }
  if (runKind === null) {
    throw new Error(
      "--run-kind is required: smoke, development-primary, or development-reproduction.",
    );
  }
  const requiredBaseCount = runKind === "smoke" ? 1 : 4;
  const resolvedBaseCount = baseCount ?? requiredBaseCount;
  if (baseIndexStart !== 0 || resolvedBaseCount !== requiredBaseCount) {
    throw new Error(
      `${runKind} requires --base-index-start 0 and --base-count ${requiredBaseCount.toString()}.`,
    );
  }
  if (
    (runKind === "development-reproduction") !==
    (primaryDirectory !== null)
  ) {
    throw new Error(
      "Only development-reproduction requires exactly one --primary artifact directory.",
    );
  }
  if (noWrite && runKind !== "smoke") {
    throw new Error("--no-write is permitted only for a smoke run.");
  }
  return {
    runId,
    runKind,
    baseIndexStart,
    baseCount: resolvedBaseCount,
    artifactRoot,
    primaryDirectory,
    noWrite,
  };
}

function commandFor(options: CliOptions): string {
  return [
    "npm run eval:phase7",
    "--",
    "--run-id",
    options.runId,
    "--run-kind",
    options.runKind,
    "--base-index-start",
    options.baseIndexStart.toString(),
    "--base-count",
    options.baseCount.toString(),
    ...(options.primaryDirectory === null
      ? []
      : ["--primary", options.primaryDirectory]),
    ...(options.noWrite ? ["--no-write"] : []),
  ].join(" ");
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const plan = createPhase7ComparisonPlan({
    runId: options.runId,
    baseIndexStart: options.baseIndexStart,
    baseCount: options.baseCount,
    verifyFallbackParity: true,
  });
  const sourceBefore = await captureSourceSnapshot(process.cwd());
  let reproductionReference: Phase7ComparisonReproductionReference | undefined;
  if (options.primaryDirectory !== null) {
    reproductionReference = await phase7ComparisonReproductionReferenceFor(
      options.primaryDirectory,
    );
    const primaryManifest = phase7ComparisonManifestSchema.parse(
      JSON.parse(
        await readFile(
          resolve(options.primaryDirectory, "manifest.json"),
          "utf8",
        ),
      ) as unknown,
    );
    if (
      primaryManifest.sourceSnapshotSha256 !==
        sourceBefore.sourceSnapshotSha256 ||
      primaryManifest.sourceFileCount !== sourceBefore.sourceFileCount ||
      primaryManifest.baseIndexStart !== plan.baseIndexStart ||
      primaryManifest.baseCount !== plan.baseCount ||
      primaryManifest.eventCap !== plan.eventCap ||
      JSON.stringify(primaryManifest.configurations) !==
        JSON.stringify(plan.configurations)
    ) {
      throw new Error(
        "Current source or frozen run contract differs from the primary artifact; refusing to spend a reproduction run.",
      );
    }
  }
  const progressLog: string[] = [];
  let lastProgressAt = 0;
  const onProgress = (progress: Phase7ComparisonProgress): void => {
    const now = Date.now();
    if (
      progress.attemptedGames !== 1 &&
      progress.attemptedGames !== progress.expectedGames &&
      now - lastProgressAt < 10_000
    ) {
      return;
    }
    lastProgressAt = now;
    const line = [
      `attempted=${progress.attemptedGames.toString()}/${progress.expectedGames.toString()}`,
      `complete=${progress.completedGames.toString()}`,
      `failed=${progress.failedGames.toString()}`,
      `exact=${progress.exactUses.toString()}`,
      `refused=${progress.exactRefusals.toString()}`,
      `at=${progress.current.baseIndex.toString()}/${progress.current.styleCellId}/${progress.current.rotation.toString()}/${progress.current.role}`,
    ].join(" ");
    progressLog.push(line);
    process.stdout.write(`${line}\n`);
  };

  process.stdout.write(
    `Phase 7 ${options.runKind} run: 2 configs x 17 cells x ${options.baseCount.toString()} base deal(s) x 3 rotations.\n`,
  );
  const raw = runPhase7Comparison({ plan, onProgress });
  const sourceAfter = await captureSourceSnapshot(process.cwd());
  if (
    sourceAfter.sourceSnapshotSha256 !== sourceBefore.sourceSnapshotSha256 ||
    sourceAfter.sourceFileCount !== sourceBefore.sourceFileCount
  ) {
    throw new Error(
      "Project source changed during the Phase 7 run; refusing to construct or publish an artifact.",
    );
  }
  const command = commandFor(options);
  const scientificDigest = phase7ComparisonScientificDigest({
    configurations: plan.configurations,
    games: raw.games,
    truths: raw.truths,
    failures: raw.failures,
    decisions: raw.decisions,
  });
  const artifactRun = await buildPhase7ComparisonArtifactRun({
    projectRoot: process.cwd(),
    protocolPlanPath: resolve("docs/evaluation-plan.md"),
    runId: plan.runId,
    runKind: options.runKind,
    ...(reproductionReference === undefined ? {} : { reproductionReference }),
    split: plan.split,
    ruleProfileId: "canonical-v1",
    rules: CANONICAL_RULES,
    configurations: plan.configurations,
    baseIndexStart: plan.baseIndexStart,
    baseCount: plan.baseCount,
    eventCap: plan.eventCap,
    verifyFallbackParity: true,
    bootstrapSeedId: plan.bootstrapSeedId,
    command,
    games: raw.games,
    truths: raw.truths,
    failures: raw.failures,
    decisions: raw.decisions,
    latencies: raw.latencies,
    sourceSnapshot: sourceBefore,
    log: [
      `command=${command}`,
      ...progressLog,
      `sourceSnapshotSha256=${sourceBefore.sourceSnapshotSha256}`,
      `scientificDigest=${scientificDigest}`,
    ].join("\n"),
  });
  const failedGates = phase7ComparisonIndividualGateFailures(
    artifactRun.summary,
  );
  let runDirectory: string | null = null;
  if (!options.noWrite) {
    const written = await writePhase7ComparisonArtifacts(
      artifactRun,
      resolve(options.artifactRoot),
    );
    runDirectory = written.runDirectory;
    const verification = await verifyPhase7ComparisonArtifacts(runDirectory);
    if (!verification.valid) {
      throw new Error(
        `Written Phase 7 comparison failed verification:\n${verification.failures.join(
          "\n",
        )}`,
      );
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        runDirectory,
        summary: artifactRun.summary,
        failedGates,
      },
      null,
      2,
    )}\n`,
  );
  if (failedGates.length > 0) {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
