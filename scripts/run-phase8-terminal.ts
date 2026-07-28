import { readFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  parseAndRehydratePhase8FinalManifestAuthority,
  parseAndRehydratePhase8FinalSplitOpening,
  rehydratePhase8SelectionArtifact,
  type Phase8SelectionAttestation,
  type Phase8WriteOnceArtifact,
} from "../src/evaluation/phase8-final-manifest";
import {
  parseAndRehydratePhase8ManifestAuthority,
  parseAndRehydratePhase8SplitOpening,
} from "../src/evaluation/phase8-manifest";
import { createPhase8TerminalArtifactSession } from "../src/evaluation/phase8-terminal-artifacts";
import { writePhase8TerminalStatisticalReport } from "../src/evaluation/phase8-terminal-report";
import {
  createPhase8TerminalAuthorityPlan,
  runPhase8TerminalMatrix,
  type Phase8TerminalPlan,
  type Phase8TerminalScenarioInput,
  type Phase8TerminalScenarioResult,
} from "../src/evaluation/phase8-terminal-runner";

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

async function selectionArtifact(
  payloadPath: string,
  checksumPath: string,
): Promise<Phase8WriteOnceArtifact<Phase8SelectionAttestation>> {
  return rehydratePhase8SelectionArtifact({
    payload: await readFile(resolve(payloadPath), "utf8"),
    checksumLine: await readFile(resolve(checksumPath), "utf8"),
  });
}

async function createPlan(options: Options): Promise<Phase8TerminalPlan> {
  if (options.scope === "qualification") {
    const authority = parseAndRehydratePhase8ManifestAuthority(
      await readFile(resolve(options.authorityPath), "utf8"),
    );
    const opening = parseAndRehydratePhase8SplitOpening(
      authority,
      await readFile(resolve(options.openingPath), "utf8"),
    );
    return createPhase8TerminalAuthorityPlan({
      runId: options.runId,
      seedAuthority: { kind: "qualification", authority, opening },
    });
  }
  if (
    options.qualificationAuthorityPath === null ||
    options.selectionPath === null ||
    options.selectionChecksumPath === null
  ) {
    throw new Error(
      "Final scope requires --qualification-authority, --selection, and --selection-checksum.",
    );
  }
  const qualificationAuthority = parseAndRehydratePhase8ManifestAuthority(
    await readFile(resolve(options.qualificationAuthorityPath), "utf8"),
  );
  const selection = await selectionArtifact(
    options.selectionPath,
    options.selectionChecksumPath,
  );
  const authority = parseAndRehydratePhase8FinalManifestAuthority({
    payload: await readFile(resolve(options.authorityPath), "utf8"),
    qualificationAuthority,
    selectionArtifact: selection,
  });
  const opening = parseAndRehydratePhase8FinalSplitOpening(
    authority,
    await readFile(resolve(options.openingPath), "utf8"),
  );
  return createPhase8TerminalAuthorityPlan({
    runId: options.runId,
    seedAuthority: { kind: "final", authority, opening },
  });
}

class ScenarioWorkerPool {
  readonly workers: Worker[];
  private nextId = 0;
  private nextWorker = 0;
  private readonly pending = new Map<
    number,
    Readonly<{
      resolve: (result: Phase8TerminalScenarioResult) => void;
      reject: (error: Error) => void;
    }>
  >();

  constructor(size: number) {
    this.workers = Array.from(
      { length: size },
      () =>
        new Worker(
          new URL("./phase8-terminal-worker-bootstrap.mjs", import.meta.url),
          {
            execArgv: [],
          },
        ),
    );
    for (const worker of this.workers) {
      worker.on(
        "message",
        (message: {
          readonly id: number;
          readonly ok: boolean;
          readonly result?: Phase8TerminalScenarioResult;
          readonly error?: {
            readonly message?: string;
            readonly stack?: string;
          };
        }) => {
          const pending = this.pending.get(message.id);
          if (pending === undefined) {
            return;
          }
          this.pending.delete(message.id);
          if (message.ok && message.result !== undefined) {
            pending.resolve(message.result);
          } else {
            pending.reject(
              new Error(
                message.error?.stack ??
                  message.error?.message ??
                  "Terminal worker failed without an error payload.",
              ),
            );
          }
        },
      );
      worker.on("error", (error) => {
        for (const pending of this.pending.values()) {
          pending.reject(error);
        }
        this.pending.clear();
      });
    }
  }

  execute(
    scenario: Phase8TerminalScenarioInput,
  ): Promise<Phase8TerminalScenarioResult> {
    const worker = this.workers[this.nextWorker];
    if (worker === undefined) {
      return Promise.reject(new Error("Terminal worker pool is empty."));
    }
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
      });
      worker.postMessage({ id, scenario });
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const plan = await createPlan(options);
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
