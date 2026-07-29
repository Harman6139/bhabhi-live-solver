import { readFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";

import { createPhase8TerminalArtifactSession } from "../src/evaluation/phase8-terminal-artifacts";
import { writePhase8TerminalStatisticalReport } from "../src/evaluation/phase8-terminal-report";
import { runPhase8TerminalMatrix } from "../src/evaluation/phase8-terminal-runner";
import {
  loadPhase8TerminalPlan,
  ScenarioWorkerPool,
} from "./phase8-terminal-runtime";

type Options = Readonly<{
  scope: "qualification" | "final";
  authorityPath: string;
  openingPath: string;
  qualificationAuthorityPath: string | null;
  selectionPath: string | null;
  selectionChecksumPath: string | null;
  modelPath: string;
  outputRoot: string;
  runId: string;
  concurrency: number;
}>;

function valueAfter(argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${argv[index] ?? "argument"} requires a value.`);
  }
  return value;
}

function parseArguments(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (name === undefined || !name.startsWith("--")) {
      throw new Error(`Unexpected terminal argument ${name ?? "<missing>"}.`);
    }
    values.set(name, valueAfter(argv, index));
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value.trim().length === 0) {
      throw new Error(`${name} is required.`);
    }
    return value;
  };
  const scope = required("--scope");
  if (scope !== "qualification" && scope !== "final") {
    throw new Error("--scope must be qualification or final.");
  }
  const concurrency = Number(values.get("--concurrency") ?? "4");
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8
  ) {
    throw new Error("--concurrency must be an integer from 1 through 8.");
  }
  return {
    scope,
    authorityPath: required("--authority"),
    openingPath: required("--opening"),
    qualificationAuthorityPath: values.get("--qualification-authority") ?? null,
    selectionPath: values.get("--selection") ?? null,
    selectionChecksumPath: values.get("--selection-checksum") ?? null,
    modelPath: required("--model"),
    outputRoot: required("--output-root"),
    runId: required("--run-id"),
    concurrency,
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const plan = await loadPhase8TerminalPlan(options);
  const serializedModel = await readFile(resolve(options.modelPath), "utf8");
  const session = await createPhase8TerminalArtifactSession({
    rootDirectory: resolve(options.outputRoot),
    plan,
    serializedProductionModel: serializedModel,
    environment: {
      platform: platform(),
      release: release(),
      node: process.version,
      logicalProcessors: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtStart: freemem(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      workerCount: options.concurrency,
    },
    command: process.argv.join(" "),
    createdAt: new Date().toISOString(),
  });
  const pool = new ScenarioWorkerPool(options.concurrency);
  let lastReported = 0;
  try {
    const result = await runPhase8TerminalMatrix({
      plan,
      serializedProductionModel: serializedModel,
      sink: session.sink,
      concurrency: options.concurrency,
      scenarioExecutor: (scenario) => pool.execute(scenario),
      onProgress: (progress) => {
        if (
          progress.attemptedGames === progress.expectedGames ||
          progress.attemptedGames - lastReported >= 16
        ) {
          lastReported = progress.attemptedGames;
          process.stdout.write(
            `terminal ${progress.attemptedGames.toString()}/${progress.expectedGames.toString()} complete=${progress.completedGames.toString()} failed=${progress.failedGames.toString()}\n`,
          );
        }
      },
    });
    const verification = await session.finalize(result);
    if (!verification.ok) {
      throw new Error(
        `Terminal artifact verification failed: ${verification.failures.join("; ")}`,
      );
    }
    const reportPath = `${session.runDirectory}-statistical-report.json`;
    const report = await writePhase8TerminalStatisticalReport({
      runDirectory: session.runDirectory,
      outputPath: reportPath,
    });
    process.stdout.write(
      `${JSON.stringify({
        runDirectory: session.runDirectory,
        reportPath,
        reportSha256: report.reportSha256,
        evidenceGate: report.evidenceGate,
      })}\n`,
    );
  } finally {
    await pool.close();
  }
}

await main();
