import { resolve } from "node:path";

import { verifyPhase8TerminalArtifacts } from "../src/evaluation/phase8-terminal-artifacts";

function runArgument(argv: readonly string[]): string {
  const index = argv.indexOf("--run");
  const value =
    index >= 0
      ? argv[index + 1]
      : argv.find((argument) => !argument.startsWith("-"));
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      "Usage: tsx scripts/verify-phase8-terminal.ts --run <artifact-directory>",
    );
  }
  return resolve(value);
}

async function main(): Promise<void> {
  const runDirectory = runArgument(process.argv.slice(2));
  const verification = await verifyPhase8TerminalArtifacts(runDirectory);
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  if (!verification.ok) {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
