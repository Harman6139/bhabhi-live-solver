import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  phase7ComparisonIndividualGateFailures,
  verifyPhase7ComparisonArtifacts,
} from "../src/evaluation/phase7-comparison-artifacts";
import { phase7ComparisonSummarySchema } from "../src/evaluation/phase7-comparison-schema";

function runArgument(argv: readonly string[]): string {
  const index = argv.indexOf("--run");
  const value =
    index >= 0
      ? argv[index + 1]
      : argv.find((argument) => !argument.startsWith("-"));
  if (value === undefined || value.trim().length === 0) {
    throw new Error("Supply a Phase 7 artifact directory with --run <path>.");
  }
  return resolve(value);
}

async function main(): Promise<void> {
  const runDirectory = runArgument(process.argv.slice(2));
  const verification = await verifyPhase7ComparisonArtifacts(runDirectory);
  const summary = phase7ComparisonSummarySchema.parse(
    JSON.parse(
      await readFile(resolve(runDirectory, "summary.json"), "utf8"),
    ) as unknown,
  );
  const failedGates = phase7ComparisonIndividualGateFailures(summary);
  process.stdout.write(
    `${JSON.stringify(
      {
        runDirectory,
        verification,
        failedGates,
        runKind: summary.runKind,
        pairedMacro: summary.pairedMacro,
        scientificDigest: summary.scientificDigest,
        reproductionClaim: "none; use the cross-artifact reproduction verifier",
      },
      null,
      2,
    )}\n`,
  );
  if (!verification.valid || failedGates.length > 0) {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
