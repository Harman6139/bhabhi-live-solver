import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stableHash, stableStringify } from "../src/events/stable-hash";
import { recommendFromTimeline } from "../src/search";
import { temporalTimeline } from "../tests/inference/test-fixtures";

type BudgetName = "instant" | "balanced";

type LatencyRecord = {
  readonly schemaVersion: 1;
  readonly budget: BudgetName;
  readonly sampleIndex: number;
  readonly wallElapsedMs: number;
  readonly solverElapsedMs: number;
  readonly deadlineMs: number;
  readonly deadlineExceeded: boolean;
  readonly rssBeforeBytes: number;
  readonly rssAfterBytes: number;
  readonly heapUsedBeforeBytes: number;
  readonly heapUsedAfterBytes: number;
  readonly analysisId: string;
  readonly configHash: string;
  readonly payloadHash: string;
  readonly outcomeChecksum: string;
  readonly legalActions: number;
  readonly completedRollouts: number;
};

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const EXCLUDED_SOURCE_DIRECTORIES = new Set([
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

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function positiveIntegerArgument(name: string, fallback: number): number {
  const raw = argument(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDED_SOURCE_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(relative(directory, path).replaceAll("\\", "/"));
      }
    }
  }
  await visit(directory);
  return files;
}

async function sourceSnapshot(): Promise<{
  readonly sha256: string;
  readonly fileCount: number;
}> {
  const files = await sourceFiles(PROJECT_ROOT);
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(join(PROJECT_ROOT, file));
    hash.update(file, "utf8");
    hash.update("\0", "utf8");
    hash.update(sha256(bytes), "utf8");
    hash.update("\n", "utf8");
  }
  return { sha256: hash.digest("hex"), fileCount: files.length };
}

function gitValue(args: readonly string[], fallback: string): string {
  try {
    return execFileSync("git", args, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).replaceAll("\r\n", "\n");
  } catch {
    return fallback;
  }
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("Cannot compute a percentile from an empty sample.");
  }
  return value;
}

function summarize(records: readonly LatencyRecord[]) {
  const elapsed = records.map((record) => record.wallElapsedMs);
  return {
    samples: records.length,
    minMs: Math.min(...elapsed),
    meanMs: elapsed.reduce((total, value) => total + value, 0) / elapsed.length,
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    maxMs: Math.max(...elapsed),
    deadlineExceeded: records.filter((record) => record.deadlineExceeded)
      .length,
    payloadHashes: [...new Set(records.map((record) => record.payloadHash))],
    outcomeChecksums: [
      ...new Set(records.map((record) => record.outcomeChecksum)),
    ],
    analysisIds: [...new Set(records.map((record) => record.analysisId))],
    maxObservedPostRequestRssBytes: Math.max(
      ...records.map((record) => record.rssAfterBytes),
    ),
  };
}

function measure(budget: BudgetName, sampleIndex: number): LatencyRecord {
  const before = process.memoryUsage();
  const startedAt = performance.now();
  const recommendation = recommendFromTimeline({
    timeline: temporalTimeline(3),
    budgetId: budget,
  });
  const wallElapsedMs = performance.now() - startedAt;
  const after = process.memoryUsage();
  return {
    schemaVersion: 1,
    budget,
    sampleIndex,
    wallElapsedMs,
    solverElapsedMs: recommendation.telemetry.elapsedMs,
    deadlineMs: recommendation.telemetry.deadlineMs,
    deadlineExceeded: recommendation.telemetry.deadlineExceeded,
    rssBeforeBytes: before.rss,
    rssAfterBytes: after.rss,
    heapUsedBeforeBytes: before.heapUsed,
    heapUsedAfterBytes: after.heapUsed,
    analysisId: recommendation.payload.analysisId,
    configHash: recommendation.payload.configHash,
    payloadHash: stableHash(recommendation.payload),
    outcomeChecksum: recommendation.payload.rollout.outcomeChecksum,
    legalActions: recommendation.payload.legalActions.length,
    completedRollouts: recommendation.payload.rollout.completed,
  };
}

async function writeUtf8(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: "utf8", flag: "wx" });
}

async function main(): Promise<void> {
  const runId = requiredArgument("--run-id");
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/u.test(runId)) {
    throw new Error(
      "Run ID must be 3-80 lowercase letters, digits, dots, underscores, or hyphens.",
    );
  }
  const warmup = positiveIntegerArgument("--warmup", 3);
  const instantSamples = positiveIntegerArgument("--instant-samples", 20);
  const balancedSamples = positiveIntegerArgument("--balanced-samples", 10);
  const powerMode =
    argument("--power-mode") ?? "not-programmatically-available";
  const parent = join(PROJECT_ROOT, "artifacts", "search", "phase5");
  const target = join(parent, runId);
  const stage = join(parent, `.${runId}.stage-${process.pid.toString()}`);
  await mkdir(parent, { recursive: true });
  try {
    await access(target);
    throw new Error(`Immutable benchmark run already exists: ${target}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Immutable benchmark run already exists:")
    ) {
      throw error;
    }
  }
  await mkdir(stage);

  try {
    for (let index = 0; index < warmup; index += 1) {
      measure("instant", index);
      measure("balanced", index);
    }

    const records: LatencyRecord[] = [];
    for (let index = 0; index < instantSamples; index += 1) {
      records.push(measure("instant", index));
    }
    for (let index = 0; index < balancedSamples; index += 1) {
      records.push(measure("balanced", index));
    }
    const instant = summarize(
      records.filter((record) => record.budget === "instant"),
    );
    const balanced = summarize(
      records.filter((record) => record.budget === "balanced"),
    );
    const snapshot = await sourceSnapshot();
    const gitCommit = gitValue(["rev-parse", "--verify", "HEAD"], "").trim();
    const gitStatus = gitValue(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "git-status-unavailable\n",
    );
    const createdAt = new Date().toISOString();
    const environment = {
      schemaVersion: 1,
      createdAt,
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpuModel: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtCapture: freemem(),
      nodeVersion: process.version,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      powerMode,
      executionMode: "tsx-node-local-phase5-smoke",
      workerCount: 1,
      sourceSnapshotSha256: snapshot.sha256,
      sourceFileCount: snapshot.fileCount,
      gitCommit: /^[0-9a-f]{40}$/u.test(gitCommit) ? gitCommit : null,
      gitDirty: gitStatus.trim().length > 0,
      gitStatusSha256: sha256(gitStatus),
    };
    const gateChecks = {
      instantInternalDeadlineP95Pass: instant.p95Ms <= 500,
      balancedInternalDeadlineP95Pass: balanced.p95Ms <= 2_500,
      instantServiceP95Pass: instant.p95Ms <= 750,
      balancedServiceP95Pass: balanced.p95Ms <= 3_000,
      deterministicPayloads:
        instant.payloadHashes.length === 1 &&
        balanced.payloadHashes.length === 1,
      zeroFailures: records.length === instantSamples + balancedSamples,
    };
    const summary = {
      schemaVersion: 1,
      runId,
      split: "dev",
      evidenceEligible: false,
      method: "hard-belief-terminal-root-rollout",
      corpus: "temporalTimeline(3): normal-phase user lead with 17 legal cards",
      warmupPairs: warmup,
      instant,
      balanced,
      thresholds: {
        instantInternalDeadlineP95Ms: 500,
        balancedInternalDeadlineP95Ms: 2_500,
        instantValidRecommendationP95Ms: 750,
        balancedValidRecommendationP95Ms: 3_000,
      },
      gate: {
        ...gateChecks,
        overallPass: Object.values(gateChecks).every(Boolean),
      },
      limitations: [
        "Development-only Node/tsx smoke, not final production-browser latency evidence.",
        "One representative 17-action state; Phase 8 requires a preregistered corpus, cold starts, at least 1,000 warm requests per live budget, and browser worker measurements.",
        "RSS is sampled before and after synchronous requests; it is not an in-request peak-memory measurement.",
      ],
    };
    const command = [
      "npm run bench:phase5 --",
      `--run-id ${runId}`,
      `--warmup ${warmup.toString()}`,
      `--instant-samples ${instantSamples.toString()}`,
      `--balanced-samples ${balancedSamples.toString()}`,
      `--power-mode ${JSON.stringify(powerMode)}`,
    ].join(" ");
    const summaryMarkdown = [
      `# Phase 5 latency smoke: ${runId}`,
      "",
      "- Split: development only; not evidence-eligible",
      `- Created: ${createdAt}`,
      `- Source snapshot: \`${snapshot.sha256}\` (${snapshot.fileCount.toString()} files)`,
      `- Corpus: ${summary.corpus}`,
      `- Instant: n=${instant.samples.toString()}, p50=${instant.p50Ms.toFixed(2)} ms, p95=${instant.p95Ms.toFixed(2)} ms, max=${instant.maxMs.toFixed(2)} ms`,
      `- Balanced: n=${balanced.samples.toString()}, p50=${balanced.p50Ms.toFixed(2)} ms, p95=${balanced.p95Ms.toFixed(2)} ms, max=${balanced.maxMs.toFixed(2)} ms`,
      `- Instant internal 500 ms p95 budget: ${summary.gate.instantInternalDeadlineP95Pass ? "PASS" : "FAIL"}`,
      `- Balanced internal 2,500 ms p95 budget: ${summary.gate.balancedInternalDeadlineP95Pass ? "PASS" : "FAIL"}`,
      `- Instant 750 ms service target: ${summary.gate.instantServiceP95Pass ? "PASS" : "FAIL"}`,
      `- Balanced 3,000 ms service target: ${summary.gate.balancedServiceP95Pass ? "PASS" : "FAIL"}`,
      `- Deterministic payloads: ${summary.gate.deterministicPayloads ? "PASS" : "FAIL"}`,
      `- Zero failures: ${summary.gate.zeroFailures ? "PASS" : "FAIL"}`,
      "",
      "This is a development smoke only. Phase 8 retains the full preregistered",
      "production-browser, worker, cold-start, corpus, and sample-count gates.",
      "",
    ].join("\n");

    const files: Readonly<Record<string, string>> = {
      "command.txt": `${command}\n`,
      "environment.json": `${stableStringify(environment)}\n`,
      "latency.ndjson": `${records
        .map((record) => stableStringify(record))
        .join("\n")}\n`,
      "summary.json": `${stableStringify(summary)}\n`,
      "summary.md": summaryMarkdown,
    };
    for (const [name, content] of Object.entries(files)) {
      await writeUtf8(join(stage, name), content);
    }
    const checksums = Object.fromEntries(
      await Promise.all(
        Object.keys(files)
          .sort()
          .map(async (name) => [
            name,
            sha256(await readFile(join(stage, name))),
          ]),
      ),
    ) as Record<string, string>;
    await writeUtf8(
      join(stage, "checksums.sha256"),
      `${Object.entries(checksums)
        .map(([name, digest]) => `${digest}  ${name}`)
        .join("\n")}\n`,
    );
    await rename(stage, target);
    console.log(
      stableStringify({
        runDirectory: target,
        instantP95Ms: instant.p95Ms,
        balancedP95Ms: balanced.p95Ms,
        gate: summary.gate,
      }),
    );
    if (!summary.gate.overallPass) {
      process.exitCode = 1;
    }
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

await main();
