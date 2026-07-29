import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  parseAndRehydratePhase8FinalManifestAuthority,
  parseAndRehydratePhase8FinalSplitOpening,
  rehydratePhase8SelectionArtifact,
} from "../src/evaluation/phase8-final-manifest";
import {
  parseAndRehydratePhase8ManifestAuthority,
  parseAndRehydratePhase8SplitOpening,
} from "../src/evaluation/phase8-manifest";
import {
  createPhase8TerminalAuthorityPlan,
  type Phase8TerminalPlan,
  type Phase8TerminalScenarioInput,
  type Phase8TerminalScenarioResult,
} from "../src/evaluation/phase8-terminal-runner";

export type Phase8TerminalPlanPaths = Readonly<{
  scope: "qualification" | "final";
  authorityPath: string;
  openingPath: string;
  qualificationAuthorityPath: string | null;
  selectionPath: string | null;
  selectionChecksumPath: string | null;
  runId: string;
}>;

export async function loadPhase8TerminalPlan(
  options: Phase8TerminalPlanPaths,
): Promise<Phase8TerminalPlan> {
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
  const selection = rehydratePhase8SelectionArtifact({
    payload: await readFile(resolve(options.selectionPath), "utf8"),
    checksumLine: await readFile(
      resolve(options.selectionChecksumPath),
      "utf8",
    ),
  });
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

type PendingTask = Readonly<{
  id: number;
  scenario: Phase8TerminalScenarioInput;
  resolve: (result: Phase8TerminalScenarioResult) => void;
  reject: (error: Error) => void;
}>;

type ActiveTask = PendingTask &
  Readonly<{
    worker: Worker;
  }>;

type WorkerMessage = Readonly<{
  id: number;
  ok: boolean;
  result?: Phase8TerminalScenarioResult;
  error?: Readonly<{
    message?: string;
    stack?: string;
  }>;
}>;

/**
 * Worker assignment is completion-driven. A slow scenario occupies only its
 * own worker; every other worker immediately receives the next queued task.
 */
export class ScenarioWorkerPool {
  readonly workers: Worker[];
  private readonly idleWorkers: Worker[];
  private readonly queued: PendingTask[] = [];
  private readonly active = new Map<number, ActiveTask>();
  private nextId = 0;
  private closed = false;
  private failed: Error | null = null;

  constructor(size: number) {
    this.workers = Array.from(
      { length: size },
      () =>
        new Worker(
          new URL("./phase8-terminal-worker-bootstrap.mjs", import.meta.url),
          { execArgv: [] },
        ),
    );
    this.idleWorkers = [...this.workers];
    for (const worker of this.workers) {
      worker.on("message", (message: WorkerMessage) => {
        this.complete(worker, message);
      });
      worker.on("error", (error) => {
        this.fail(error);
      });
      worker.on("exit", (code) => {
        if (!this.closed && code !== 0) {
          this.fail(
            new Error(
              `Terminal scenario worker exited unexpectedly with code ${code.toString()}.`,
            ),
          );
        }
      });
    }
  }

  private complete(worker: Worker, message: WorkerMessage): void {
    const task = this.active.get(message.id);
    if (task === undefined || task.worker !== worker || this.failed !== null) {
      return;
    }
    this.active.delete(message.id);
    this.idleWorkers.push(worker);
    if (message.ok && message.result !== undefined) {
      task.resolve(message.result);
    } else {
      task.reject(
        new Error(
          message.error?.stack ??
            message.error?.message ??
            "Terminal worker failed without an error payload.",
        ),
      );
    }
    this.dispatch();
  }

  private dispatch(): void {
    while (
      this.failed === null &&
      !this.closed &&
      this.idleWorkers.length > 0 &&
      this.queued.length > 0
    ) {
      const worker = this.idleWorkers.shift();
      const task = this.queued.shift();
      if (worker === undefined || task === undefined) {
        throw new Error("Terminal worker-pool queue accounting failed.");
      }
      this.active.set(task.id, { ...task, worker });
      try {
        worker.postMessage({ id: task.id, scenario: task.scenario });
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new Error("Terminal worker postMessage failed."),
        );
      }
    }
  }

  private fail(error: Error): void {
    if (this.failed !== null) {
      return;
    }
    this.failed = error;
    for (const task of this.active.values()) {
      task.reject(error);
    }
    for (const task of this.queued) {
      task.reject(error);
    }
    this.active.clear();
    this.queued.length = 0;
  }

  execute(
    scenario: Phase8TerminalScenarioInput,
  ): Promise<Phase8TerminalScenarioResult> {
    if (this.failed !== null) {
      return Promise.reject(this.failed);
    }
    if (this.closed) {
      return Promise.reject(new Error("Terminal worker pool is closed."));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolvePromise, rejectPromise) => {
      this.queued.push({
        id,
        scenario,
        resolve: resolvePromise,
        reject: rejectPromise,
      });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const closeError = new Error("Terminal worker pool closed.");
    for (const task of this.active.values()) {
      task.reject(closeError);
    }
    for (const task of this.queued) {
      task.reject(closeError);
    }
    this.active.clear();
    this.queued.length = 0;
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}
