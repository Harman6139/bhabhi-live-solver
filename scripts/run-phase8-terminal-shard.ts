import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { stableStringify } from "../src/events/stable-hash";
import {
  createInMemoryPhase8TerminalSink,
  phase8TerminalPlanScientificHash,
  runPhase8TerminalMatrix,
  type InMemoryPhase8TerminalSink,
  type Phase8TerminalPlan,
} from "../src/evaluation/phase8-terminal-runner";
import {
  loadPhase8TerminalPlan,
  ScenarioWorkerPool,
} from "./phase8-terminal-runtime";

const SHARD_ARTIFACT_VERSION = "phase8-terminal-shard-artifact-v1" as const;
const SHARD_PARTITION_VERSION =
  "ascending-base-index-modulo-shard-count-v1" as const;
const execFileAsync = promisify(execFile);

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
  shardIndex: number;
  shardCount: number;
}>;

type RawFile = Readonly<{
  name: string;
  records: readonly unknown[];
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
      throw new Error(`Unexpected shard argument ${name ?? "<missing>"}.`);
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
  const shardIndex = Number(required("--shard-index"));
  const shardCount = Number(required("--shard-count"));
  if (
    !Number.isSafeInteger(shardCount) ||
    shardCount < 1 ||
    shardCount > 256 ||
    !Number.isSafeInteger(shardIndex) ||
    shardIndex < 0 ||
    shardIndex >= shardCount
  ) {
    throw new Error(
      "Shard index/count must identify one zero-based shard among 1 through 256.",
    );
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
    shardIndex,
    shardCount,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function ndjson(records: readonly unknown[]): string {
  return records.length === 0
    ? ""
    : `${records.map((record) => stableStringify(record)).join("\n")}\n`;
}

function shardBaseIndices(
  plan: Phase8TerminalPlan,
  shardIndex: number,
  shardCount: number,
): number[] {
  return Array.from(
    { length: plan.baseCount - plan.baseIndexStart },
    (_, ordinal) => plan.baseIndexStart + ordinal,
  ).filter(
    (baseIndex) =>
      (baseIndex - plan.baseIndexStart) % shardCount === shardIndex,
  );
}

function coordinateKey(input: {
  readonly configId: string;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: number;
  readonly replicate: number;
}): string {
  return stableStringify({
    configId: input.configId,
    styleCellId: input.styleCellId,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
    replicate: input.replicate,
  });
}

function expectedCoordinates(
  plan: Phase8TerminalPlan,
  baseIndices: readonly number[],
): string[] {
  return baseIndices.flatMap((baseIndex) =>
    plan.styleCells.flatMap((styleCell) =>
      plan.rotations.flatMap((rotation) =>
        plan.configurations.map((configuration) =>
          coordinateKey({
            configId: configuration.configId,
            styleCellId: styleCell.id,
            baseIndex,
            rotation,
            replicate: plan.replicate,
          }),
        ),
      ),
    ),
  );
}

function rawFiles(sink: InMemoryPhase8TerminalSink): readonly RawFile[] {
  return [
    { name: "components.ndjson", records: sink.componentAudits },
    { name: "seeds.ndjson", records: sink.seeds },
    { name: "games.ndjson", records: sink.games },
    { name: "truth.eval-only.ndjson", records: sink.truths },
    { name: "failures.ndjson", records: sink.failures },
    { name: "decisions.ndjson", records: sink.decisions },
    { name: "latency.ndjson", records: sink.latencies },
    { name: "summary-inputs.ndjson", records: sink.summaryInputs },
  ] as const;
}

async function gitCommit(): Promise<string> {
  const result = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
  });
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Shard source commit is unavailable or malformed.");
  }
  return commit;
}

async function writeShard(input: {
  readonly options: Options;
  readonly plan: Phase8TerminalPlan;
  readonly sourceCommit: string;
  readonly baseIndices: readonly number[];
  readonly expected: readonly string[];
  readonly sink: InMemoryPhase8TerminalSink;
  readonly result: Awaited<ReturnType<typeof runPhase8TerminalMatrix>>;
  readonly startedAt: string;
}): Promise<Readonly<{ target: string; scientificGate: boolean }>> {
  const width = Math.max(2, input.options.shardCount.toString().length);
  const shardId = `shard-${input.options.shardIndex
    .toString()
    .padStart(width, "0")}-of-${input.options.shardCount
    .toString()
    .padStart(width, "0")}`;
  const parent = resolve(input.options.outputRoot);
  const target = resolve(parent, shardId);
  const stage = resolve(parent, `.incomplete-${shardId}-${process.pid}`);
  if (
    dirname(target) !== parent ||
    dirname(stage) !== parent ||
    basename(target) !== shardId
  ) {
    throw new Error("Refusing an unsafe shard output path.");
  }
  const observed = input.sink.summaryInputs.map(coordinateKey);
  const uniqueObserved = new Set(observed);
  const coordinateGate =
    stableStringify(observed) === stableStringify(input.expected) &&
    uniqueObserved.size === observed.length;
  const countGate =
    input.result.expectedGames === input.expected.length &&
    input.result.attemptedGames === input.expected.length &&
    input.sink.summaryInputs.length === input.expected.length &&
    input.sink.games.length + input.sink.failures.length ===
      input.expected.length &&
    input.sink.truths.length === input.sink.games.length &&
    input.sink.seeds.length ===
      input.baseIndices.length *
        input.plan.styleCells.length *
        input.plan.rotations.length &&
    input.sink.componentAudits.length === input.plan.configurations.length;
  const scientificGate =
    input.result.started &&
    input.result.failedGames === 0 &&
    coordinateGate &&
    countGate;
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const fileHashes: Record<string, string> = {};
  const fileCounts: Record<string, number> = {};
  try {
    for (const file of rawFiles(input.sink)) {
      const payload = ndjson(file.records);
      await writeFile(join(stage, file.name), payload, {
        encoding: "utf8",
        flag: "wx",
      });
      fileHashes[file.name] = sha256(payload);
      fileCounts[file.name] = file.records.length;
    }
    const inputFiles = [
      ["authority.input.json", input.options.authorityPath],
      ["opening.input.json", input.options.openingPath],
      ["production-model.input.json", input.options.modelPath],
      ...(input.options.qualificationAuthorityPath === null
        ? []
        : [
            [
              "qualification-authority.input.json",
              input.options.qualificationAuthorityPath,
            ] as const,
          ]),
      ...(input.options.selectionPath === null
        ? []
        : [["selection.input.json", input.options.selectionPath] as const]),
      ...(input.options.selectionChecksumPath === null
        ? []
        : [
            [
              "selection-checksum.input.sha256",
              input.options.selectionChecksumPath,
            ] as const,
          ]),
    ] as const;
    for (const [name, path] of inputFiles) {
      const payload = await readFile(resolve(path));
      await writeFile(join(stage, name), payload, { flag: "wx" });
      fileHashes[name] = sha256(payload);
    }
    const environmentPayload = `${stableStringify({
      platform: platform(),
      release: release(),
      node: process.version,
      logicalProcessors: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtStart: freemem(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      workerCount: input.options.concurrency,
      githubRunId: process.env.GITHUB_RUN_ID ?? null,
      githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      githubJob: process.env.GITHUB_JOB ?? null,
    })}\n`;
    await writeFile(join(stage, "environment.json"), environmentPayload, {
      encoding: "utf8",
      flag: "wx",
    });
    fileHashes["environment.json"] = sha256(environmentPayload);
    const commandPayload = `${process.argv.join(" ")}\n`;
    await writeFile(join(stage, "command.txt"), commandPayload, {
      encoding: "utf8",
      flag: "wx",
    });
    fileHashes["command.txt"] = sha256(commandPayload);

    const rawScientificHashes = Object.fromEntries(
      Object.entries(fileHashes)
        .filter(([name]) => name.endsWith(".ndjson"))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    const manifestProjection = {
      schemaVersion: 1,
      artifactVersion: SHARD_ARTIFACT_VERSION,
      partitionVersion: SHARD_PARTITION_VERSION,
      protocolId: input.plan.protocolId,
      runnerVersion: input.plan.runnerVersion,
      runId: input.plan.runId,
      scope: input.options.scope,
      shardId,
      shardIndex: input.options.shardIndex,
      shardCount: input.options.shardCount,
      sourceCommit: input.sourceCommit,
      planScientificSha256: phase8TerminalPlanScientificHash(input.plan),
      authorityKind: input.plan.authorityKind,
      manifestId: input.plan.manifestId,
      manifestSha256: input.plan.manifestSha256,
      splitOpeningSha256: input.plan.splitOpeningSha256,
      evidenceClass: input.plan.evidenceClass,
      evidenceEligible: input.plan.evidenceEligible,
      fullMatrix: {
        baseIndexStart: input.plan.baseIndexStart,
        baseCount: input.plan.baseCount,
        styleCellIds: input.plan.styleCells.map((cell) => cell.id),
        rotations: input.plan.rotations,
        configurationIds: input.plan.configurations.map(
          (configuration) => configuration.configId,
        ),
        expectedGames: input.plan.expectedGames,
      },
      partition: {
        baseIndices: input.baseIndices,
        expectedCoordinateCount: input.expected.length,
        expectedCoordinatesSha256: sha256(stableStringify(input.expected)),
        observedCoordinateCount: observed.length,
        observedCoordinatesSha256: sha256(stableStringify(observed)),
        uniqueObservedCoordinateCount: uniqueObserved.size,
      },
      result: {
        started: input.result.started,
        attemptedGames: input.result.attemptedGames,
        completedGames: input.result.completedGames,
        failedGames: input.result.failedGames,
        expectedGames: input.result.expectedGames,
        coordinateGate,
        countGate,
        zeroFailureGate: input.result.failedGames === 0,
        scientificGate,
      },
      recordCounts: Object.fromEntries(
        Object.entries(fileCounts).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      rawScientificFileSha256: rawScientificHashes,
      truthFirewall: {
        truthFile: "truth.eval-only.ndjson",
        productionInputUse: "forbidden",
        purpose: "post-game-evaluation-and-replay-only",
      },
      startedAt: input.startedAt,
      completedAt: new Date().toISOString(),
    };
    const shardScientificSha256 = sha256(
      stableStringify({
        planScientificSha256: manifestProjection.planScientificSha256,
        partitionVersion: manifestProjection.partitionVersion,
        partition: manifestProjection.partition,
        result: manifestProjection.result,
        rawScientificFileSha256: rawScientificHashes,
      }),
    );
    const manifestPayload = `${stableStringify({
      ...manifestProjection,
      shardScientificSha256,
    })}\n`;
    await writeFile(join(stage, "shard-manifest.json"), manifestPayload, {
      encoding: "utf8",
      flag: "wx",
    });
    fileHashes["shard-manifest.json"] = sha256(manifestPayload);
    for (const [name, expectedSha256] of Object.entries(fileHashes)) {
      const observedSha256 = sha256(await readFile(join(stage, name)));
      if (observedSha256 !== expectedSha256) {
        throw new Error(
          `Shard self-verification found a checksum mismatch in ${name}.`,
        );
      }
    }
    const checksums = Object.entries(fileHashes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, digest]) => `${digest}  ${name}`)
      .join("\n");
    await writeFile(join(stage, "checksums.sha256"), `${checksums}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await mkdir(parent, { recursive: true });
    await rename(stage, target);
    return { target, scientificGate };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const plan = await loadPhase8TerminalPlan(options);
  const baseIndices = shardBaseIndices(
    plan,
    options.shardIndex,
    options.shardCount,
  );
  if (baseIndices.length === 0) {
    throw new Error(
      "This shard has no base indices; reduce the shard count rather than uploading an empty artifact.",
    );
  }
  const expected = expectedCoordinates(plan, baseIndices);
  const serializedModel = await readFile(resolve(options.modelPath), "utf8");
  const sink = createInMemoryPhase8TerminalSink();
  const pool = new ScenarioWorkerPool(options.concurrency);
  const startedAt = new Date().toISOString();
  let lastReported = 0;
  let result: Awaited<ReturnType<typeof runPhase8TerminalMatrix>>;
  try {
    result = await runPhase8TerminalMatrix({
      plan,
      baseIndices,
      serializedProductionModel: serializedModel,
      sink,
      concurrency: options.concurrency,
      scenarioExecutor: (scenario) => pool.execute(scenario),
      onProgress: (progress) => {
        if (
          progress.attemptedGames === progress.expectedGames ||
          progress.attemptedGames - lastReported >= 8
        ) {
          lastReported = progress.attemptedGames;
          process.stdout.write(
            `shard ${options.shardIndex.toString()}/${options.shardCount.toString()} terminal ${progress.attemptedGames.toString()}/${progress.expectedGames.toString()} complete=${progress.completedGames.toString()} failed=${progress.failedGames.toString()}\n`,
          );
        }
      },
    });
  } finally {
    await pool.close();
  }
  const written = await writeShard({
    options,
    plan,
    sourceCommit: await gitCommit(),
    baseIndices,
    expected,
    sink,
    result,
    startedAt,
  });
  process.stdout.write(
    `${JSON.stringify({
      shardDirectory: written.target,
      shardIndex: options.shardIndex,
      shardCount: options.shardCount,
      baseIndices,
      expectedGames: result.expectedGames,
      completedGames: result.completedGames,
      failedGames: result.failedGames,
      scientificGate: written.scientificGate,
    })}\n`,
  );
  if (!written.scientificGate) {
    process.exitCode = 1;
  }
}

await main();
