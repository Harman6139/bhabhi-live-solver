import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { z } from "zod";

import {
  phase8FinalManifestSchema,
  type Phase8FinalManifest,
} from "../evaluation/phase8-final-manifest";
import {
  phase8ManifestSchema,
  phase8Sha256,
  type Phase8Manifest,
} from "../evaluation/phase8-manifest";
import { stableHash, stableStringify } from "../events/stable-hash";
import {
  exportGameArchive,
  importGameArchive,
  replayTimeline,
  type GameTimeline,
} from "../events/timeline";
import { analysisBindingSchema, type AnalysisBinding } from "../worker";
import {
  PHASE8_LATENCY_BENCHMARK_VERSION,
  PHASE8_LATENCY_CORPUS_VERSION,
  PHASE8_LATENCY_SCHEMA_VERSION,
  createLatencySummary,
  latencyCorpusHashProjection,
  latencyCorpusSchema,
  latencyFailureRecordSchema,
  latencyRecordSchema,
  latencyScheduleSchema,
  latencySnapshotSchema,
  latencySummarySchema,
  metricObservationSchema,
  type LatencyCorpus,
  type LatencyCorpusEntry,
  type LatencyFailureRecord,
  type LatencyRecord,
  type LatencySchedule,
  type LatencySnapshot,
  type LatencySummary,
} from "./latency-contract";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const identifierSchema = z.string().trim().min(1).max(512);
const nonnegativeIntegerSchema = z.int().nonnegative();

/**
 * The current production worker executes the frozen Phase 5 hard-only route.
 * Keeping this executable-role allowlist explicit prevents a configuration ID
 * from relabeling baseline timings as exact or behavior-aware evidence.
 */
export const PHASE8_LATENCY_EXECUTABLE_CONFIG_IDS = [
  "p8-r-hard-balanced-v1",
] as const;

export const LATENCY_ARTIFACT_FILES = [
  "command.txt",
  "corpus.json",
  "environment.json",
  "failures.ndjson",
  "latency.ndjson",
  "manifest.json",
  "summary.json",
] as const;

const browserEnvironmentSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_LATENCY_SCHEMA_VERSION),
    userAgent: z.string().min(1),
    browserLanguage: z.string().min(1),
    browserLanguages: z.array(z.string().min(1)),
    timezone: z.string().min(1),
    screen: z
      .object({
        width: nonnegativeIntegerSchema,
        height: nonnegativeIntegerSchema,
        availableWidth: nonnegativeIntegerSchema,
        availableHeight: nonnegativeIntegerSchema,
        colorDepth: nonnegativeIntegerSchema,
        pixelDepth: nonnegativeIntegerSchema,
      })
      .strict(),
    devicePixelRatio: z.number().positive(),
    hardwareConcurrency: z.int().positive().nullable(),
    deviceMemoryGiB: z.number().positive().nullable(),
    visibilityState: z.enum(["hidden", "visible"]),
    documentHasFocus: z.boolean(),
    crossOriginIsolated: z.boolean(),
    longTaskObserverSupported: z.boolean(),
    performanceMemorySupported: z.boolean(),
    userAgentSpecificMemorySupported: z.boolean(),
    userAgentSpecificMemory: metricObservationSchema,
  })
  .strict();

export const latencyEnvironmentSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_LATENCY_SCHEMA_VERSION),
    capturedAtStart: z.iso.datetime(),
    capturedAtEnd: z.iso.datetime(),
    platform: z.string().min(1),
    release: z.string().min(1),
    architecture: z.string().min(1),
    cpuModel: z.string().min(1),
    logicalCpus: z.int().positive(),
    totalMemoryBytes: z.int().positive(),
    freeMemoryBytesAtStart: nonnegativeIntegerSchema,
    freeMemoryBytesAtEnd: nonnegativeIntegerSchema,
    nodeVersion: z.string().min(1),
    timezone: z.string().min(1),
    powerMode: z.string().min(1),
    powerSource: z.string().min(1),
    backgroundLoadPolicy: z.string().min(1),
    workerCount: z.literal(1),
    browserEngine: z.literal("chromium"),
    browserVersion: z.string().min(1),
    headless: z.boolean(),
    coldStartDefinition: z.literal(
      "fresh-production-document-reload-and-fresh-dedicated-worker",
    ),
    warmDefinition: z.literal(
      "warmed-production-document-and-module-cache-with-fresh-dedicated-worker-per-request",
    ),
    browserAtStart: browserEnvironmentSchema,
    browserAtEnd: browserEnvironmentSchema,
    nodeHarnessRssMaxObservedBytes: nonnegativeIntegerSchema,
    browserProcessMemoryBytes: z.null(),
    browserProcessMemoryUnavailableReason: z.string().min(1),
    dedicatedWorkerMemoryBytes: z.null(),
    dedicatedWorkerMemoryUnavailableReason: z.string().min(1),
    dedicatedWorkerCpuTimeMs: z.null(),
    dedicatedWorkerCpuTimeUnavailableReason: z.string().min(1),
  })
  .strict();
export type LatencyEnvironment = z.infer<typeof latencyEnvironmentSchema>;

const productionBuildSchema = z
  .object({
    kind: z.literal("vite-production-multipage"),
    distSha256: sha256Schema,
    fileCount: z.int().positive(),
    latencyPagePath: z.literal("latency.html"),
    latencyPageSha256: sha256Schema,
    sourceMapIncluded: z.boolean(),
  })
  .strict();

export const phase8LatencyManifestSchema = z.union([
  phase8ManifestSchema,
  phase8FinalManifestSchema,
]);
export type Phase8LatencyManifest = Phase8Manifest | Phase8FinalManifest;

export const latencyRunManifestSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_LATENCY_SCHEMA_VERSION),
    benchmarkVersion: z.literal(PHASE8_LATENCY_BENCHMARK_VERSION),
    runId: identifierSchema,
    createdAt: z.iso.datetime(),
    phase8Manifest: phase8LatencyManifestSchema,
    phase8ManifestSha256: sha256Schema,
    configId: identifierSchema,
    configSha256: sha256Schema,
    corpusId: identifierSchema,
    corpusSha256: sha256Schema,
    corpusEntryCount: z.int().min(2),
    candidateIndependentCorpus: z.literal(true),
    schedule: latencyScheduleSchema,
    binding: analysisBindingSchema,
    productionBuild: productionBuildSchema,
    recordOrder: z.literal(
      "warmups-then-warm-live-then-cold-live-then-offline-then-stale-races",
    ),
    workerContract: z.literal(
      "AnalysisWorkerClient/createBrowserAnalysisWorker/analysis-worker-protocol-v1",
    ),
    longTaskContract: z.literal(
      "PerformanceObserver-longtask-duration-over-50ms",
    ),
    entryContract: z.literal(
      "input-event-synchronous-import-replay-public-identity",
    ),
    memoryContract: z.literal(
      "report-observed-browser-js-heap-and-null-with-reason-when-worker-or-process-attribution-is-unavailable",
    ),
    command: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !PHASE8_LATENCY_EXECUTABLE_CONFIG_IDS.some(
        (configId) => configId === value.configId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["configId"],
        message:
          "The production latency worker currently executes only p8-r-hard-balanced-v1; advanced IDs cannot relabel baseline measurements.",
      });
    }
    if (value.phase8ManifestSha256 !== phase8Sha256(value.phase8Manifest)) {
      context.addIssue({
        code: "custom",
        path: ["phase8ManifestSha256"],
        message: "Phase 8 manifest SHA-256 does not match the embedding.",
      });
    }
    const configuration = value.phase8Manifest.configurations.find(
      (candidate) => candidate.configId === value.configId,
    );
    if (
      configuration === undefined ||
      configuration.configSha256 !== value.configSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["configSha256"],
        message:
          "Latency configuration does not match the frozen Phase 8 registry.",
      });
    }
    if (
      value.binding.sourceHash !== value.phase8Manifest.hashes.sourceSha256 ||
      value.binding.solverConfigHash !== value.configSha256 ||
      value.binding.modelHash !== value.phase8Manifest.hashes.modelSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["binding"],
        message:
          "Worker binding does not match the selected frozen configuration.",
      });
    }
  });
export type LatencyRunManifest = z.infer<typeof latencyRunManifestSchema>;

export type DirectorySnapshot = Readonly<{
  sha256: string;
  fileCount: number;
  latencyPageSha256: string;
  sourceMapIncluded: boolean;
}>;

export type LatencyArtifactWriteResult = Readonly<{
  runDirectory: string;
  checksums: Readonly<Record<string, string>>;
  summary: LatencySummary;
}>;

export type LatencyArtifactVerification = Readonly<{
  valid: boolean;
  runDirectory: string;
  checkedFiles: number;
  recordsValidated: number;
  failures: readonly string[];
  reproductionDigest: string;
}>;

export function latencySha256(value: unknown): string {
  const hash = createHash("sha256");
  if (typeof value === "string" || value instanceof Uint8Array) {
    hash.update(value);
  } else {
    hash.update(stableStringify(value), "utf8");
  }
  return hash.digest("hex");
}

export function createLatencySnapshot(timeline: GameTimeline): LatencySnapshot {
  const timelineArchive = exportGameArchive(timeline);
  const replay = replayTimeline(timeline);
  return latencySnapshotSchema.parse({
    timelineArchive,
    timelineArchiveSha256: latencySha256(timelineArchive),
    stateVersion: timeline.cursor,
    historyHash: replay.semanticHash,
    publicStateHash: stableHash(replay.state),
  });
}

export function createLatencyCorpus(
  input: Readonly<{
    corpusId: string;
    createdAt: string;
    split: LatencyCorpus["split"];
    phase8ManifestId: string;
    phase8ManifestSha256: string;
    protocolSha256: string;
    samplingPolicy: string;
    entries: readonly LatencyCorpusEntry[];
  }>,
): LatencyCorpus {
  const projection = {
    schemaVersion: PHASE8_LATENCY_SCHEMA_VERSION,
    corpusVersion: PHASE8_LATENCY_CORPUS_VERSION,
    corpusId: input.corpusId,
    createdAt: input.createdAt,
    split: input.split,
    phase8ManifestId: input.phase8ManifestId,
    phase8ManifestSha256: input.phase8ManifestSha256,
    protocolSha256: input.protocolSha256,
    candidateIndependent: true as const,
    samplingPolicy: input.samplingPolicy,
    entries: input.entries,
  };
  return latencyCorpusSchema.parse({
    ...projection,
    corpusSha256: latencySha256(projection),
  });
}

async function recursiveFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
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

export async function captureDirectorySnapshot(
  directory: string,
): Promise<DirectorySnapshot> {
  const files = await recursiveFiles(directory);
  if (!files.includes("latency.html")) {
    throw new Error(
      `Production build does not contain latency.html: ${directory}`,
    );
  }
  const hash = createHash("sha256");
  let latencyPageSha256 = "";
  for (const file of files) {
    const bytes = await readFile(join(directory, file));
    const digest = latencySha256(bytes);
    hash.update(file, "utf8");
    hash.update("\0", "utf8");
    hash.update(digest, "utf8");
    hash.update("\n", "utf8");
    if (file === "latency.html") {
      latencyPageSha256 = digest;
    }
  }
  return Object.freeze({
    sha256: hash.digest("hex"),
    fileCount: files.length,
    latencyPageSha256,
    sourceMapIncluded: files.some((file) => file.endsWith(".map")),
  });
}

function ndjson(values: readonly unknown[]): string {
  return values.length === 0
    ? ""
    : `${values.map((value) => stableStringify(value)).join("\n")}\n`;
}

async function writeUtf8(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: "utf8", flag: "wx" });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function checksumRecord(
  directory: string,
): Promise<Record<string, string>> {
  const entries: (readonly [string, string])[] = await Promise.all(
    LATENCY_ARTIFACT_FILES.map(
      async (name): Promise<readonly [string, string]> => [
        name,
        latencySha256(await readFile(join(directory, name))),
      ],
    ),
  );
  return Object.fromEntries(entries);
}

function checksumText(checksums: Readonly<Record<string, string>>): string {
  return `${Object.entries(checksums)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, digest]) => `${digest}  ${name}`)
    .join("\n")}\n`;
}

function validateSnapshot(
  snapshot: LatencySnapshot,
  label: string,
): string | null {
  try {
    if (
      latencySha256(snapshot.timelineArchive) !== snapshot.timelineArchiveSha256
    ) {
      throw new Error("archive SHA-256 mismatch");
    }
    const timeline = importGameArchive(snapshot.timelineArchive);
    const replay = replayTimeline(timeline);
    if (
      timeline.cursor !== snapshot.stateVersion ||
      replay.semanticHash !== snapshot.historyHash ||
      stableHash(replay.state) !== snapshot.publicStateHash
    ) {
      throw new Error("replayed public identity mismatch");
    }
    return null;
  } catch (error) {
    return `${label}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function validateLatencyCorpus(value: unknown): Readonly<{
  corpus: LatencyCorpus | null;
  failures: readonly string[];
}> {
  const failures: string[] = [];
  let corpus: LatencyCorpus;
  try {
    corpus = latencyCorpusSchema.parse(value);
  } catch (error) {
    return {
      corpus: null,
      failures: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (
    latencySha256(latencyCorpusHashProjection(corpus)) !== corpus.corpusSha256
  ) {
    failures.push("Latency corpus SHA-256 does not match its contents.");
  }
  for (const entry of corpus.entries) {
    const analysisFailure = validateSnapshot(
      entry.analysis,
      `${entry.entryId}/analysis`,
    );
    if (analysisFailure !== null) {
      failures.push(analysisFailure);
    }
    const probeFailure = validateSnapshot(
      entry.entryProbe,
      `${entry.entryId}/entry-probe`,
    );
    if (probeFailure !== null) {
      failures.push(probeFailure);
    }
  }
  return { corpus, failures: Object.freeze(failures) };
}

export async function writeLatencyArtifacts(
  input: Readonly<{
    parentDirectory: string;
    manifest: LatencyRunManifest;
    environment: LatencyEnvironment;
    corpus: LatencyCorpus;
    records: readonly LatencyRecord[];
    failures: readonly LatencyFailureRecord[];
  }>,
): Promise<LatencyArtifactWriteResult> {
  const manifest = latencyRunManifestSchema.parse(input.manifest);
  const environment = latencyEnvironmentSchema.parse(input.environment);
  const corpusValidation = validateLatencyCorpus(input.corpus);
  if (
    corpusValidation.corpus === null ||
    corpusValidation.failures.length > 0
  ) {
    throw new Error(
      `Cannot write an invalid latency corpus: ${corpusValidation.failures.join("; ")}`,
    );
  }
  const corpus = corpusValidation.corpus;
  if (
    corpus.phase8ManifestId !== manifest.phase8Manifest.manifestId ||
    corpus.phase8ManifestSha256 !== manifest.phase8ManifestSha256 ||
    corpus.corpusId !== manifest.corpusId ||
    corpus.corpusSha256 !== manifest.corpusSha256 ||
    corpus.protocolSha256 !== manifest.binding.protocolHash ||
    corpus.entries.length !== manifest.corpusEntryCount ||
    (corpus.split === "final") !==
      (manifest.phase8Manifest.manifestVersion ===
        "phase8-final-evaluation-manifest-v1")
  ) {
    throw new Error("Latency run manifest does not bind the supplied corpus.");
  }
  const records = input.records.map((record) =>
    latencyRecordSchema.parse(record),
  );
  const failures = input.failures.map((failure) =>
    latencyFailureRecordSchema.parse(failure),
  );
  const summary = createLatencySummary({
    binding: {
      runId: manifest.runId,
      phase8ManifestId: manifest.phase8Manifest.manifestId,
      phase8ManifestSha256: manifest.phase8ManifestSha256,
      corpusId: corpus.corpusId,
      corpusSha256: corpus.corpusSha256,
      configId: manifest.configId,
      schedule: manifest.schedule,
    },
    records,
    failures,
  });
  await mkdir(input.parentDirectory, { recursive: true });
  const target = join(input.parentDirectory, manifest.runId);
  if (await pathExists(target)) {
    throw new Error(`Immutable latency artifact already exists: ${target}`);
  }
  const stage = join(
    input.parentDirectory,
    `.${manifest.runId}.stage-${process.pid.toString()}-${Date.now().toString()}`,
  );
  if (await pathExists(stage)) {
    throw new Error(`Latency artifact staging path already exists: ${stage}`);
  }
  await mkdir(stage);
  const files: Readonly<
    Record<(typeof LATENCY_ARTIFACT_FILES)[number], string>
  > = {
    "command.txt": `${manifest.command}\n`,
    "corpus.json": `${stableStringify(corpus)}\n`,
    "environment.json": `${stableStringify(environment)}\n`,
    "failures.ndjson": ndjson(failures),
    "latency.ndjson": ndjson(records),
    "manifest.json": `${stableStringify(manifest)}\n`,
    "summary.json": `${stableStringify(summary)}\n`,
  };
  try {
    for (const name of LATENCY_ARTIFACT_FILES) {
      await writeUtf8(join(stage, name), files[name]);
    }
    const checksums = await checksumRecord(stage);
    await writeUtf8(join(stage, "checksums.sha256"), checksumText(checksums));
    await rename(stage, target);
    return Object.freeze({
      runDirectory: target,
      checksums: Object.freeze(checksums),
      summary,
    });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

function parseJson(text: string, label: string, failures: string[]): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    failures.push(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function parseNdjson<T>(
  text: string,
  label: string,
  failures: string[],
  parse: (value: unknown) => T,
): T[] {
  const values: T[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }
    try {
      values.push(parse(JSON.parse(line) as unknown));
    } catch (error) {
      failures.push(
        `${label}:${(index + 1).toString()} failed validation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return values;
}

function parseChecksums(text: string, failures: string[]): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }
    const match = /^([0-9a-f]{64}) {2}([a-z0-9.-]+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      failures.push(`Malformed checksum line: ${JSON.stringify(line)}.`);
      continue;
    }
    if (checksums.has(match[2])) {
      failures.push(`Duplicate checksum entry for ${match[2]}.`);
      continue;
    }
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

export async function verifyLatencyArtifacts(
  runDirectory: string,
): Promise<LatencyArtifactVerification> {
  const failures: string[] = [];
  const names = (await readdir(runDirectory)).sort((left, right) =>
    left.localeCompare(right),
  );
  const expectedNames = [...LATENCY_ARTIFACT_FILES, "checksums.sha256"].sort(
    (left, right) => left.localeCompare(right),
  );
  if (stableStringify(names) !== stableStringify(expectedNames)) {
    failures.push(
      `Artifact file set mismatch: expected ${expectedNames.join(", ")}, received ${names.join(", ")}.`,
    );
  }
  const checksumPath = join(runDirectory, "checksums.sha256");
  const recordedChecksums = parseChecksums(
    await readFile(checksumPath, "utf8"),
    failures,
  );
  for (const name of LATENCY_ARTIFACT_FILES) {
    try {
      const actual = latencySha256(await readFile(join(runDirectory, name)));
      if (recordedChecksums.get(name) !== actual) {
        failures.push(`SHA-256 mismatch for ${name}.`);
      }
    } catch (error) {
      failures.push(
        `Unable to read ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (recordedChecksums.size !== LATENCY_ARTIFACT_FILES.length) {
    failures.push("Checksum entry count does not match the payload file set.");
  }

  let manifest: LatencyRunManifest | null = null;
  let environment: LatencyEnvironment | null = null;
  let corpus: LatencyCorpus | null = null;
  let summary: LatencySummary | null = null;
  try {
    manifest = latencyRunManifestSchema.parse(
      parseJson(
        await readFile(join(runDirectory, "manifest.json"), "utf8"),
        "manifest.json",
        failures,
      ),
    );
  } catch (error) {
    failures.push(
      `manifest.json failed validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    environment = latencyEnvironmentSchema.parse(
      parseJson(
        await readFile(join(runDirectory, "environment.json"), "utf8"),
        "environment.json",
        failures,
      ),
    );
  } catch (error) {
    failures.push(
      `environment.json failed validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const rawCorpus = parseJson(
      await readFile(join(runDirectory, "corpus.json"), "utf8"),
      "corpus.json",
      failures,
    );
    const validation = validateLatencyCorpus(rawCorpus);
    corpus = validation.corpus;
    failures.push(...validation.failures);
  } catch (error) {
    failures.push(
      `corpus.json failed validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    summary = latencySummarySchema.parse(
      parseJson(
        await readFile(join(runDirectory, "summary.json"), "utf8"),
        "summary.json",
        failures,
      ),
    );
  } catch (error) {
    failures.push(
      `summary.json failed validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const records = parseNdjson(
    await readFile(join(runDirectory, "latency.ndjson"), "utf8"),
    "latency.ndjson",
    failures,
    (value) => latencyRecordSchema.parse(value),
  );
  const rawFailures = parseNdjson(
    await readFile(join(runDirectory, "failures.ndjson"), "utf8"),
    "failures.ndjson",
    failures,
    (value) => latencyFailureRecordSchema.parse(value),
  );
  if (manifest !== null) {
    if (manifest.runId !== basename(runDirectory)) {
      failures.push("Run ID does not match the artifact directory name.");
    }
    if (
      (await readFile(join(runDirectory, "command.txt"), "utf8")) !==
      `${manifest.command}\n`
    ) {
      failures.push("command.txt does not match manifest.command.");
    }
  }
  if (manifest !== null && corpus !== null) {
    if (
      corpus.phase8ManifestId !== manifest.phase8Manifest.manifestId ||
      corpus.phase8ManifestSha256 !== manifest.phase8ManifestSha256 ||
      corpus.corpusId !== manifest.corpusId ||
      corpus.corpusSha256 !== manifest.corpusSha256 ||
      corpus.protocolSha256 !== manifest.binding.protocolHash ||
      corpus.entries.length !== manifest.corpusEntryCount ||
      (corpus.split === "final") !==
        (manifest.phase8Manifest.manifestVersion ===
          "phase8-final-evaluation-manifest-v1")
    ) {
      failures.push("Manifest/corpus binding mismatch.");
    }
  }
  const measurementIds = records.map((record) => record.measurementId);
  if (new Set(measurementIds).size !== measurementIds.length) {
    failures.push("Latency measurement IDs are not unique.");
  }
  if (
    manifest !== null &&
    records.some((record) => record.runId !== manifest.runId)
  ) {
    failures.push("A latency record is bound to another run ID.");
  }
  if (
    manifest !== null &&
    rawFailures.some((failure) => failure.runId !== manifest.runId)
  ) {
    failures.push("A failure record is bound to another run ID.");
  }
  let reproductionDigest = "unavailable";
  if (manifest !== null && corpus !== null) {
    const regenerated = createLatencySummary({
      binding: {
        runId: manifest.runId,
        phase8ManifestId: manifest.phase8Manifest.manifestId,
        phase8ManifestSha256: manifest.phase8ManifestSha256,
        corpusId: corpus.corpusId,
        corpusSha256: corpus.corpusSha256,
        configId: manifest.configId,
        schedule: manifest.schedule,
      },
      records,
      failures: rawFailures,
    });
    reproductionDigest = regenerated.reproductionDigest;
    if (
      summary === null ||
      stableStringify(regenerated) !== stableStringify(summary)
    ) {
      failures.push(
        "summary.json does not match deterministic regeneration from raw records.",
      );
    }
  }
  // Parsing the environment is itself part of the contract. Retain the read
  // to make an accidental removal visible to strict TypeScript and reviewers.
  void environment;
  return Object.freeze({
    valid: failures.length === 0,
    runDirectory,
    checkedFiles: recordedChecksums.size,
    recordsValidated: records.length,
    failures: Object.freeze(failures),
    reproductionDigest,
  });
}

export function createLatencyRunManifest(
  input: Readonly<{
    runId: string;
    createdAt: string;
    phase8Manifest: Phase8LatencyManifest;
    configId: string;
    corpus: LatencyCorpus;
    schedule: LatencySchedule;
    binding: AnalysisBinding;
    productionBuild: DirectorySnapshot;
    command: string;
  }>,
): LatencyRunManifest {
  const phase8Manifest = phase8LatencyManifestSchema.parse(
    input.phase8Manifest,
  );
  const isFinalManifest =
    phase8Manifest.manifestVersion === "phase8-final-evaluation-manifest-v1";
  if ((input.corpus.split === "final") !== isFinalManifest) {
    throw new Error(
      "Final latency corpora require the distinct frozen final manifest, and non-final corpora require the qualification manifest.",
    );
  }
  const configuration = phase8Manifest.configurations.find(
    (candidate) => candidate.configId === input.configId,
  );
  if (configuration === undefined) {
    throw new Error(`Unknown Phase 8 latency configuration ${input.configId}.`);
  }
  if (
    !PHASE8_LATENCY_EXECUTABLE_CONFIG_IDS.some(
      (configId) => configId === input.configId,
    )
  ) {
    throw new Error(
      "The production latency worker currently executes only p8-r-hard-balanced-v1; advanced configurations require a genuine worker route before measurement.",
    );
  }
  return latencyRunManifestSchema.parse({
    schemaVersion: PHASE8_LATENCY_SCHEMA_VERSION,
    benchmarkVersion: PHASE8_LATENCY_BENCHMARK_VERSION,
    runId: input.runId,
    createdAt: input.createdAt,
    phase8Manifest,
    phase8ManifestSha256: phase8Sha256(phase8Manifest),
    configId: input.configId,
    configSha256: configuration.configSha256,
    corpusId: input.corpus.corpusId,
    corpusSha256: input.corpus.corpusSha256,
    corpusEntryCount: input.corpus.entries.length,
    candidateIndependentCorpus: true,
    schedule: input.schedule,
    binding: input.binding,
    productionBuild: {
      kind: "vite-production-multipage",
      distSha256: input.productionBuild.sha256,
      fileCount: input.productionBuild.fileCount,
      latencyPagePath: "latency.html",
      latencyPageSha256: input.productionBuild.latencyPageSha256,
      sourceMapIncluded: input.productionBuild.sourceMapIncluded,
    },
    recordOrder:
      "warmups-then-warm-live-then-cold-live-then-offline-then-stale-races",
    workerContract:
      "AnalysisWorkerClient/createBrowserAnalysisWorker/analysis-worker-protocol-v1",
    longTaskContract: "PerformanceObserver-longtask-duration-over-50ms",
    entryContract: "input-event-synchronous-import-replay-public-identity",
    memoryContract:
      "report-observed-browser-js-heap-and-null-with-reason-when-worker-or-process-attribution-is-unavailable",
    command: input.command,
  });
}
