import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import { stableHash, stableStringify } from "../events/stable-hash";
import { replayEvents } from "../events/timeline";
import {
  applyTruthCardPlay,
  applyTruthHandTaken,
  applyTruthPlayerDraw,
  applyTruthWasteDraw,
  assertSimulationTruthInvariant,
  createSimulationTruth,
} from "../simulator/truth";
import { baselinePolicyDefinitions } from "../simulator/policies";
import {
  decisionArtifactRecordSchema,
  environmentArtifactSchema,
  evaluationManifestSchema,
  evaluationSummarySchema,
  failureArtifactRecordSchema,
  gameArtifactRecordSchema,
  seedArtifactRecordSchema,
  truthArtifactRecordSchema,
  type DecisionArtifactRecord,
  type EnvironmentArtifact,
  type EvaluationManifest,
  type FailureArtifactRecord,
  type GameArtifactRecord,
  type SeedArtifactRecord,
  type TruthArtifactRecord,
} from "./artifact-schema";
import { summarizeBatch, type BatchRunResult } from "./batch";
import type { BatchPlan } from "./protocol";

const REQUIRED_FILES = [
  "manifest.json",
  "environment.json",
  "seeds.ndjson",
  "games.ndjson",
  "decisions.ndjson",
  "calibration-predictions.ndjson",
  "truth.eval-only.ndjson",
  "latency.ndjson",
  "failures.ndjson",
  "summary.json",
  "summary.md",
  "command.txt",
  "logs/run.log",
] as const;

export type WriteArtifactOptions = {
  readonly artifactRoot: string;
  readonly protocolPlanPath: string;
  readonly projectRoot?: string;
  readonly command: string;
  readonly createdAt?: string;
  readonly environment?: EnvironmentArtifact;
  readonly powerMode?: string;
};

export type SourceSnapshot = {
  readonly sourceSnapshotSha256: string;
  readonly sourceFileCount: number;
  readonly gitCommit: string | null;
  readonly gitStatusSha256: string;
  readonly gitDirty: boolean;
};

/**
 * Result-bearing human documentation is finalized only after clean holdout
 * artifacts exist. Excluding these three files keeps that reporting step from
 * changing the scientific implementation hash. Their exact bytes are instead
 * covered by the post-selection README/release-validation attestation.
 */
export const SOURCE_SNAPSHOT_EXCLUDED_FILES = Object.freeze([
  "README.md",
  "docs/final-report.md",
  "docs/progress.md",
] as const);

export type ArtifactWriteResult = {
  readonly runDirectory: string;
  readonly manifest: EvaluationManifest;
  readonly checksums: Readonly<Record<string, string>>;
};

export type ArtifactVerification = {
  readonly valid: boolean;
  readonly runDirectory: string;
  readonly checkedFiles: number;
  readonly gamesReplayed: number;
  readonly decisionsValidated: number;
  readonly failures: readonly string[];
  readonly reproductionDigest: string;
};

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const execFileAsync = promisify(execFile);
const SOURCE_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "outputs",
  "playwright-report",
  "test-results",
  "work",
]);
const SOURCE_EXCLUDED_FILES = new Set<string>(SOURCE_SNAPSHOT_EXCLUDED_FILES);

async function sourceFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && SOURCE_EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const relativePath = relative(root, path).replaceAll("\\", "/");
        if (!SOURCE_EXCLUDED_FILES.has(relativePath)) {
          output.push(relativePath);
        }
      }
    }
  }
  await visit(root);
  return output;
}

export async function captureSourceSnapshot(
  projectRoot: string,
): Promise<SourceSnapshot> {
  const files = await sourceFiles(projectRoot);
  const hash = createHash("sha256");
  for (const file of files) {
    const content = await readFile(join(projectRoot, file));
    hash.update(file, "utf8");
    hash.update("\0", "utf8");
    hash.update(sha256Bytes(content), "utf8");
    hash.update("\n", "utf8");
  }
  const gitCommit = await readGitCommit(projectRoot);
  const gitStatus = await readGitStatus(projectRoot);
  return {
    sourceSnapshotSha256: hash.digest("hex"),
    sourceFileCount: files.length,
    gitCommit,
    gitStatusSha256: sha256Bytes(gitStatus),
    gitDirty: gitStatus.trim().length > 0,
  };
}

async function readGitCommit(projectRoot: string): Promise<string | null> {
  try {
    const commitResult = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      { cwd: projectRoot, encoding: "utf8" },
    );
    const candidate = commitResult.stdout.trim();
    return /^[0-9a-f]{40}$/u.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

async function readGitStatus(projectRoot: string): Promise<string> {
  try {
    const statusResult = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: projectRoot, encoding: "utf8" },
    );
    return statusResult.stdout.replaceAll("\r\n", "\n");
  } catch {
    return "git-status-unavailable\n";
  }
}

function ndjson(records: readonly unknown[]): string {
  return records.length === 0
    ? ""
    : `${records.map((record) => stableStringify(record)).join("\n")}\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function writeUtf8(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value.replaceAll("\r\n", "\n"), "utf8");
}

function summaryMarkdown(result: BatchRunResult): string {
  const summary = result.summary;
  const policyRows = summary.byUserPolicy
    .map(
      (line) =>
        `| ${line.key} | ${line.games.toString()} | ${line.userBhabhiCount.toString()} | ${(line.userBhabhiRate * 100).toFixed(2)}% |`,
    )
    .join("\n");
  return [
    "# Phase 4 Simulator Smoke Summary",
    "",
    `- Protocol: \`${summary.protocolId}\``,
    `- Run: \`${summary.runId}\``,
    `- Split/evidence: \`${summary.split}\` / \`${summary.evidenceClass}\``,
    `- Evidence eligible: ${summary.evidenceEligible ? "yes" : "no"}`,
    `- Completed: ${summary.completedGames.toString()} / ${summary.expectedGames.toString()}`,
    `- Failures / caps: ${summary.failedGames.toString()} / ${summary.turnCapGames.toString()}`,
    `- Zero-failure gate: ${summary.zeroFailureGate ? "PASS" : "FAIL"}`,
    `- Deterministic reproduction digest: \`${summary.reproductionDigest}\``,
    "",
    "These development results validate infrastructure only. They are not",
    "qualification/final evidence and do not support a strongest-policy claim.",
    "",
    "| User policy | Games | User Bhabhi | Rate |",
    "| --- | ---: | ---: | ---: |",
    policyRows,
    "",
  ].join("\n");
}

export function captureEnvironment(
  capturedAt = new Date().toISOString(),
  powerMode = "not-programmatically-available",
): EnvironmentArtifact {
  const cpu = cpus()[0];
  return environmentArtifactSchema.parse({
    schemaVersion: 1,
    capturedAt,
    platform: platform(),
    release: release(),
    architecture: arch(),
    cpuModel: cpu?.model ?? "unknown",
    logicalCpus: Math.max(1, cpus().length),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    nodeVersion: process.version,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    powerMode,
    workerCount: 1,
  });
}

async function recursiveFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        output.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
  }
  await visit(root);
  return output;
}

async function computeChecksums(
  directory: string,
): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {};
  for (const file of await recursiveFiles(directory)) {
    if (file === "checksums.sha256") {
      continue;
    }
    checksums[file] = sha256Bytes(await readFile(join(directory, file)));
  }
  return checksums;
}

function checksumText(checksums: Readonly<Record<string, string>>): string {
  return `${Object.entries(checksums)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, digest]) => `${digest}  ${file}`)
    .join("\n")}\n`;
}

function manifestFor(
  result: BatchRunResult,
  createdAt: string,
  protocolPlanSha256: string,
  seedManifestSha256: string,
  command: string,
  sourceSnapshot: SourceSnapshot,
): EvaluationManifest {
  const plan = result.plan;
  return evaluationManifestSchema.parse({
    schemaVersion: 1,
    artifactSchemaVersion: 1,
    runnerVersion: "phase4-runner-v1",
    protocolId: "eval-v1",
    runId: plan.runId,
    split: plan.split,
    evidenceClass: plan.evidenceClass,
    evidenceEligible: plan.evidenceEligible,
    createdAt,
    protocolPlanSha256,
    ...sourceSnapshot,
    ruleProfileId: plan.ruleProfileId,
    rules: plan.rules,
    rulesHash: stableHash(plan.rules),
    scheduleHash: stableHash({
      userPolicyIds: plan.userPolicyIds,
      styleCellIds: plan.styleCellIds,
      baseIndexStart: plan.baseIndexStart,
      baseCount: plan.baseCount,
      rotations: plan.rotations,
      replicates: plan.replicates,
    }),
    policyBundleHash: stableHash({
      tieOrder: "rank-then-canonical-full-deck-order",
      takeStrategy: "never-for-phase4-baselines",
      policies: baselinePolicyDefinitions(),
    }),
    expectedGames: result.summary.expectedGames,
    eventCap: plan.eventCap,
    userPolicyIds: plan.userPolicyIds,
    styleCellIds: plan.styleCellIds,
    baseIndexStart: plan.baseIndexStart,
    baseCount: plan.baseCount,
    rotations: plan.rotations,
    replicates: plan.replicates,
    rngAlgorithm: "splitmix64-counter-v1",
    shuffleAlgorithm: "fisher-yates-v1",
    recordOrder: "config-cell-baseIndex-rotation-replicate-decision",
    failureRetention: "retain-and-fail-gate",
    nondeterministicFields: [
      "manifest.createdAt",
      "environment",
      "games[*].wallTimeMs",
    ],
    seedManifestSha256,
    command,
  });
}

export async function writeEvaluationArtifacts(
  result: BatchRunResult,
  options: WriteArtifactOptions,
): Promise<ArtifactWriteResult> {
  const target = join(
    options.artifactRoot,
    "eval-v1",
    result.plan.split,
    result.plan.runId,
  );
  if (await exists(target)) {
    throw new Error(`Artifact run directory already exists: ${target}`);
  }
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, ".phase4-stage-"));
  const createdAt = options.createdAt ?? new Date().toISOString();
  const environment =
    options.environment ?? captureEnvironment(createdAt, options.powerMode);
  const seedsText = ndjson(result.seeds);
  const protocolPlanSha256 = sha256Bytes(
    await readFile(options.protocolPlanPath),
  );
  const sourceSnapshot = await captureSourceSnapshot(
    options.projectRoot ?? process.cwd(),
  );
  const manifest = manifestFor(
    result,
    createdAt,
    protocolPlanSha256,
    sha256Bytes(seedsText),
    options.command,
    sourceSnapshot,
  );

  try {
    await Promise.all([
      writeUtf8(join(stage, "manifest.json"), `${stableStringify(manifest)}\n`),
      writeUtf8(
        join(stage, "environment.json"),
        `${stableStringify(environment)}\n`,
      ),
      writeUtf8(join(stage, "seeds.ndjson"), seedsText),
      writeUtf8(join(stage, "games.ndjson"), ndjson(result.games)),
      writeUtf8(join(stage, "decisions.ndjson"), ndjson(result.decisions)),
      writeUtf8(join(stage, "calibration-predictions.ndjson"), ""),
      writeUtf8(join(stage, "truth.eval-only.ndjson"), ndjson(result.truths)),
      writeUtf8(join(stage, "latency.ndjson"), ""),
      writeUtf8(join(stage, "failures.ndjson"), ndjson(result.failures)),
      writeUtf8(
        join(stage, "summary.json"),
        `${stableStringify(result.summary)}\n`,
      ),
      writeUtf8(join(stage, "summary.md"), summaryMarkdown(result)),
      writeUtf8(join(stage, "command.txt"), `${options.command}\n`),
      writeUtf8(
        join(stage, "logs", "run.log"),
        [
          `run=${result.plan.runId}`,
          `attempted=${result.summary.attemptedGames.toString()}`,
          `completed=${result.summary.completedGames.toString()}`,
          `failures=${result.summary.failedGames.toString()}`,
          `reproductionDigest=${result.summary.reproductionDigest}`,
          "",
        ].join("\n"),
      ),
    ]);
    const checksums = await computeChecksums(stage);
    await writeUtf8(join(stage, "checksums.sha256"), checksumText(checksums));
    await rename(stage, target);
    return {
      runDirectory: target,
      manifest,
      checksums: Object.freeze(checksums),
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

function parseNdjson<T>(
  text: string,
  filename: string,
  parse: (value: unknown) => T,
): T[] {
  const records: T[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }
    try {
      records.push(parse(JSON.parse(line) as unknown));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${filename}:${(index + 1).toString()} failed schema validation: ${message}`,
        { cause: error },
      );
    }
  }
  return records;
}

async function readNdjson<T>(
  runDirectory: string,
  filename: string,
  parse: (value: unknown) => T,
): Promise<T[]> {
  return parseNdjson(
    await readFile(join(runDirectory, filename), "utf8"),
    filename,
    parse,
  );
}

function planFromManifest(manifest: EvaluationManifest): BatchPlan {
  return {
    schemaVersion: 1,
    protocolId: "eval-v1",
    runId: manifest.runId,
    split: manifest.split,
    evidenceClass: manifest.evidenceClass,
    evidenceEligible: manifest.evidenceEligible,
    ruleProfileId: manifest.ruleProfileId,
    rules: manifest.rules,
    userPolicyIds: manifest.userPolicyIds as BatchPlan["userPolicyIds"],
    styleCellIds: manifest.styleCellIds,
    baseIndexStart: manifest.baseIndexStart,
    baseCount: manifest.baseCount,
    rotations: manifest.rotations,
    replicates: manifest.replicates,
    eventCap: manifest.eventCap,
  };
}

function replayTruth(
  game: GameArtifactRecord,
  truth: TruthArtifactRecord,
): void {
  let simulation = createSimulationTruth(truth.initialHands, game.rules);
  for (let eventIndex = 1; eventIndex < game.events.length; eventIndex += 1) {
    const event = game.events[eventIndex];
    if (event === undefined || event.type === "game-created") {
      throw new Error(
        `${game.gameId} contains an invalid event at ${eventIndex.toString()}.`,
      );
    }
    switch (event.type) {
      case "card-played":
        simulation = applyTruthCardPlay(simulation, event, eventIndex);
        break;
      case "waste-card-drawn":
        simulation = applyTruthWasteDraw(simulation, event, eventIndex);
        break;
      case "player-card-drawn":
        simulation = applyTruthPlayerDraw(simulation, event, eventIndex);
        break;
      case "hand-taken":
        simulation = applyTruthHandTaken(simulation, event, eventIndex);
        break;
    }
  }
  assertSimulationTruthInvariant(simulation);
  const replayedTruthHash = stableHash({
    hands: simulation.hands,
    publicState: simulation.publicState,
  });
  if (replayedTruthHash !== truth.truthHash) {
    throw new Error(`${game.gameId} terminal truth hash mismatch.`);
  }
}

async function verifyChecksums(
  runDirectory: string,
): Promise<{ readonly checked: number; readonly errors: readonly string[] }> {
  const errors: string[] = [];
  const text = await readFile(join(runDirectory, "checksums.sha256"), "utf8");
  const expected = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      errors.push(`Malformed checksum line: ${line}`);
      continue;
    }
    expected.set(match[2], match[1]);
  }
  const actualFiles = (await recursiveFiles(runDirectory)).filter(
    (file) => file !== "checksums.sha256",
  );
  for (const required of REQUIRED_FILES) {
    if (!actualFiles.includes(required)) {
      errors.push(`Missing required artifact ${required}.`);
    }
  }
  for (const file of actualFiles) {
    const expectedDigest = expected.get(file);
    const actualDigest = sha256Bytes(await readFile(join(runDirectory, file)));
    if (expectedDigest === undefined) {
      errors.push(`Checksum manifest omits ${file}.`);
    } else if (actualDigest !== expectedDigest) {
      errors.push(`Checksum mismatch for ${file}.`);
    }
  }
  for (const file of expected.keys()) {
    if (!actualFiles.includes(file)) {
      errors.push(`Checksum references missing file ${file}.`);
    }
  }
  return { checked: actualFiles.length, errors };
}

export async function verifyEvaluationArtifacts(
  runDirectory: string,
): Promise<ArtifactVerification> {
  const failures: string[] = [];
  const checksum = await verifyChecksums(runDirectory);
  failures.push(...checksum.errors);
  let loaded:
    | {
        readonly manifest: EvaluationManifest;
        readonly summary: ReturnType<typeof evaluationSummarySchema.parse>;
        readonly seeds: SeedArtifactRecord[];
        readonly games: GameArtifactRecord[];
        readonly decisions: DecisionArtifactRecord[];
        readonly truths: TruthArtifactRecord[];
        readonly rawFailures: FailureArtifactRecord[];
      }
    | undefined;
  try {
    const manifest = evaluationManifestSchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "manifest.json"), "utf8"),
      ) as unknown,
    );
    environmentArtifactSchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "environment.json"), "utf8"),
      ) as unknown,
    );
    const summary = evaluationSummarySchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "summary.json"), "utf8"),
      ) as unknown,
    );
    const seeds = await readNdjson(runDirectory, "seeds.ndjson", (value) =>
      seedArtifactRecordSchema.parse(value),
    );
    const games = await readNdjson(runDirectory, "games.ndjson", (value) =>
      gameArtifactRecordSchema.parse(value),
    );
    const decisions = await readNdjson(
      runDirectory,
      "decisions.ndjson",
      (value) => decisionArtifactRecordSchema.parse(value),
    );
    const truths = await readNdjson(
      runDirectory,
      "truth.eval-only.ndjson",
      (value) => truthArtifactRecordSchema.parse(value),
    );
    const rawFailures = await readNdjson(
      runDirectory,
      "failures.ndjson",
      (value) => failureArtifactRecordSchema.parse(value),
    );
    loaded = {
      manifest,
      summary,
      seeds,
      games,
      decisions,
      truths,
      rawFailures,
    };
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    return {
      valid: false,
      runDirectory,
      checkedFiles: checksum.checked,
      gamesReplayed: 0,
      decisionsValidated: 0,
      failures,
      reproductionDigest: "unavailable",
    };
  }
  const { manifest, summary, seeds, games, decisions, truths, rawFailures } =
    loaded;

  if (sha256Bytes(ndjson(seeds)) !== manifest.seedManifestSha256) {
    failures.push("Seed manifest SHA-256 does not match manifest.");
  }
  const truthsByGame = new Map(truths.map((truth) => [truth.gameId, truth]));
  let gamesReplayed = 0;
  for (const game of games) {
    try {
      const replay = replayEvents(game.events);
      if (replay.semanticHash !== game.publicHistoryHash) {
        throw new Error(`${game.gameId} public history hash mismatch.`);
      }
      const terminalStateHash = stableHash(replay.state);
      if (terminalStateHash !== game.terminalPublicStateHash) {
        throw new Error(`${game.gameId} public state hash mismatch.`);
      }
      const outcomeHash = stableHash({
        bhabhi: replay.state.bhabhi,
        escapeOrder: game.escapeOrder,
        historyHash: replay.semanticHash,
        terminalPublicStateHash: terminalStateHash,
      });
      if (outcomeHash !== game.deterministicOutcomeHash) {
        throw new Error(`${game.gameId} outcome hash mismatch.`);
      }
      const truth = truthsByGame.get(game.gameId);
      if (truth === undefined) {
        throw new Error(`${game.gameId} has no eval-only truth record.`);
      }
      replayTruth(game, truth);
      gamesReplayed += 1;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (games.length !== truths.length) {
    failures.push(
      `Game/truth cardinality differs (${games.length.toString()} vs ${truths.length.toString()}).`,
    );
  }
  if (games.length + rawFailures.length !== seeds.length) {
    failures.push("Seed records do not cover every completed/failed game.");
  }
  const regenerated = summarizeBatch(
    planFromManifest(manifest),
    games,
    decisions,
    rawFailures,
  );
  if (stableStringify(regenerated) !== stableStringify(summary)) {
    failures.push("summary.json does not match regeneration from raw records.");
  }
  if (rawFailures.length > 0 || !summary.zeroFailureGate) {
    failures.push(
      "Run contains failures or does not pass the zero-failure gate.",
    );
  }
  return {
    valid: failures.length === 0,
    runDirectory,
    checkedFiles: checksum.checked,
    gamesReplayed,
    decisionsValidated: decisions.length,
    failures,
    reproductionDigest: regenerated.reproductionDigest,
  };
}
