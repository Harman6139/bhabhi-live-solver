import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";

import { stableStringify } from "../../src/events/stable-hash";
import {
  createPhase8TerminalArtifactSession,
  verifyPhase8TerminalArtifacts,
} from "../../src/evaluation/phase8-terminal-artifacts";
import {
  phase8TerminalPlanScientificHash,
  type Phase8TerminalPlan,
  type Phase8TerminalRunResult,
  type Phase8TerminalScenarioResult,
} from "../../src/evaluation/phase8-terminal-runner";
import {
  phase8TerminalComponentAuditSchema,
  phase8TerminalDecisionRecordSchema,
  phase8TerminalFailureRecordSchema,
  phase8TerminalGameRecordSchema,
  phase8TerminalLatencyRecordSchema,
  phase8TerminalSeedRecordSchema,
  phase8TerminalSummaryInputSchema,
  phase8TerminalTruthRecordSchema,
  type Phase8TerminalComponentAudit,
  type Phase8TerminalDecisionRecord,
  type Phase8TerminalFailureRecord,
  type Phase8TerminalGameRecord,
  type Phase8TerminalLatencyRecord,
  type Phase8TerminalSeedRecord,
  type Phase8TerminalSummaryInput,
  type Phase8TerminalTruthRecord,
} from "../../src/evaluation/phase8-terminal-schema";
import { preflightPhase8TerminalConfigurations } from "../../src/evaluation/phase8-terminal-policy";
import { writePhase8TerminalStatisticalReport } from "../../src/evaluation/phase8-terminal-report";
import {
  loadPhase8TerminalPlan,
  type Phase8TerminalPlanPaths,
} from "../../scripts/phase8-terminal-runtime";

const MERGER_VERSION = "phase8-terminal-shard-merger-v1" as const;
const SHARD_ARTIFACT_VERSION = "phase8-terminal-shard-artifact-v1" as const;
const PARTITION_VERSION = "ascending-base-index-modulo-shard-count-v1" as const;
const RAW_FILES = Object.freeze([
  "components.ndjson",
  "seeds.ndjson",
  "games.ndjson",
  "truth.eval-only.ndjson",
  "failures.ndjson",
  "decisions.ndjson",
  "latency.ndjson",
  "summary-inputs.ndjson",
] as const);

type JsonRecord = Readonly<Record<string, unknown>>;

type Options = Phase8TerminalPlanPaths &
  Readonly<{
    modelPath: string;
    shardsRoot: string;
    shardCount: number;
    outputRoot: string;
  }>;

type ShardManifest = Readonly<{
  schemaVersion: 1;
  artifactVersion: typeof SHARD_ARTIFACT_VERSION;
  partitionVersion: typeof PARTITION_VERSION;
  runId: string;
  scope: "qualification" | "final";
  shardId: string;
  shardIndex: number;
  shardCount: number;
  sourceCommit: string;
  planScientificSha256: string;
  authorityKind: string;
  manifestId: string;
  manifestSha256: string;
  splitOpeningSha256: string;
  evidenceClass: string;
  evidenceEligible: boolean;
  fullMatrix: Readonly<{
    baseIndexStart: number;
    baseCount: number;
    styleCellIds: readonly string[];
    rotations: readonly number[];
    configurationIds: readonly string[];
    expectedGames: number;
  }>;
  partition: Readonly<{
    baseIndices: readonly number[];
    expectedCoordinateCount: number;
    expectedCoordinatesSha256: string;
    observedCoordinateCount: number;
    observedCoordinatesSha256: string;
    uniqueObservedCoordinateCount: number;
  }>;
  result: Readonly<{
    started: boolean;
    attemptedGames: number;
    completedGames: number;
    failedGames: number;
    expectedGames: number;
    coordinateGate: boolean;
    countGate: boolean;
    zeroFailureGate: boolean;
    scientificGate: boolean;
  }>;
  recordCounts: Readonly<Record<string, number>>;
  rawScientificFileSha256: Readonly<Record<string, string>>;
  shardScientificSha256: string;
}>;

type ParsedShard = Readonly<{
  directory: string;
  manifest: ShardManifest;
  components: readonly Phase8TerminalComponentAudit[];
  seeds: readonly Phase8TerminalSeedRecord[];
  games: readonly Phase8TerminalGameRecord[];
  truths: readonly Phase8TerminalTruthRecord[];
  failures: readonly Phase8TerminalFailureRecord[];
  decisions: readonly Phase8TerminalDecisionRecord[];
  latencies: readonly Phase8TerminalLatencyRecord[];
  summaryInputs: readonly Phase8TerminalSummaryInput[];
}>;

type Schema<T> = Readonly<{ parse(value: unknown): T }>;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = argument(name);
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseOptions(): Options {
  const scope = required("--scope");
  if (scope !== "qualification" && scope !== "final") {
    throw new Error("--scope must be qualification or final.");
  }
  const shardCount = Number(required("--shard-count"));
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 256) {
    throw new Error("--shard-count must be an integer from 1 through 256.");
  }
  return {
    scope,
    authorityPath: required("--authority"),
    openingPath: required("--opening"),
    qualificationAuthorityPath: argument("--qualification-authority") ?? null,
    selectionPath: argument("--selection") ?? null,
    selectionChecksumPath: argument("--selection-checksum") ?? null,
    modelPath: required("--model"),
    runId: required("--run-id"),
    shardsRoot: required("--shards-root"),
    shardCount,
    outputRoot: required("--output-root"),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as JsonRecord;
}

function integerField(value: JsonRecord, name: string, label: string): number {
  const field = value[name];
  if (!Number.isSafeInteger(field)) {
    throw new Error(`${label}.${name} must be a safe integer.`);
  }
  return field as number;
}

function stringField(value: JsonRecord, name: string, label: string): string {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${name} must be a nonempty string.`);
  }
  return field;
}

function booleanField(value: JsonRecord, name: string, label: string): boolean {
  const field = value[name];
  if (typeof field !== "boolean") {
    throw new Error(`${label}.${name} must be Boolean.`);
  }
  return field;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  return value as readonly string[];
}

function integerArray(value: unknown, label: string): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => !Number.isSafeInteger(item))
  ) {
    throw new Error(`${label} must be a safe-integer array.`);
  }
  return value as readonly number[];
}

function recordOfStrings(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  const record = assertRecord(value, label);
  if (Object.values(record).some((item) => typeof item !== "string")) {
    throw new Error(`${label} must contain only string values.`);
  }
  return record as Readonly<Record<string, string>>;
}

function recordOfNumbers(
  value: unknown,
  label: string,
): Readonly<Record<string, number>> {
  const record = assertRecord(value, label);
  if (Object.values(record).some((item) => !Number.isSafeInteger(item))) {
    throw new Error(`${label} must contain only safe-integer values.`);
  }
  return record as Readonly<Record<string, number>>;
}

function parseManifest(value: unknown): ShardManifest {
  const root = assertRecord(value, "shard manifest");
  const fullMatrix = assertRecord(root.fullMatrix, "fullMatrix");
  const partition = assertRecord(root.partition, "partition");
  const result = assertRecord(root.result, "result");
  const schemaVersion = integerField(root, "schemaVersion", "manifest");
  const artifactVersion = stringField(root, "artifactVersion", "manifest");
  const partitionVersion = stringField(root, "partitionVersion", "manifest");
  if (
    schemaVersion !== 1 ||
    artifactVersion !== SHARD_ARTIFACT_VERSION ||
    partitionVersion !== PARTITION_VERSION
  ) {
    throw new Error("Shard manifest version is unsupported.");
  }
  const scope = stringField(root, "scope", "manifest");
  if (scope !== "qualification" && scope !== "final") {
    throw new Error("Shard scope is invalid.");
  }
  return {
    schemaVersion: 1,
    artifactVersion: SHARD_ARTIFACT_VERSION,
    partitionVersion: PARTITION_VERSION,
    runId: stringField(root, "runId", "manifest"),
    scope,
    shardId: stringField(root, "shardId", "manifest"),
    shardIndex: integerField(root, "shardIndex", "manifest"),
    shardCount: integerField(root, "shardCount", "manifest"),
    sourceCommit: stringField(root, "sourceCommit", "manifest"),
    planScientificSha256: stringField(root, "planScientificSha256", "manifest"),
    authorityKind: stringField(root, "authorityKind", "manifest"),
    manifestId: stringField(root, "manifestId", "manifest"),
    manifestSha256: stringField(root, "manifestSha256", "manifest"),
    splitOpeningSha256: stringField(root, "splitOpeningSha256", "manifest"),
    evidenceClass: stringField(root, "evidenceClass", "manifest"),
    evidenceEligible: booleanField(root, "evidenceEligible", "manifest"),
    fullMatrix: {
      baseIndexStart: integerField(fullMatrix, "baseIndexStart", "fullMatrix"),
      baseCount: integerField(fullMatrix, "baseCount", "fullMatrix"),
      styleCellIds: stringArray(
        fullMatrix.styleCellIds,
        "fullMatrix.styleCellIds",
      ),
      rotations: integerArray(fullMatrix.rotations, "fullMatrix.rotations"),
      configurationIds: stringArray(
        fullMatrix.configurationIds,
        "fullMatrix.configurationIds",
      ),
      expectedGames: integerField(fullMatrix, "expectedGames", "fullMatrix"),
    },
    partition: {
      baseIndices: integerArray(partition.baseIndices, "partition.baseIndices"),
      expectedCoordinateCount: integerField(
        partition,
        "expectedCoordinateCount",
        "partition",
      ),
      expectedCoordinatesSha256: stringField(
        partition,
        "expectedCoordinatesSha256",
        "partition",
      ),
      observedCoordinateCount: integerField(
        partition,
        "observedCoordinateCount",
        "partition",
      ),
      observedCoordinatesSha256: stringField(
        partition,
        "observedCoordinatesSha256",
        "partition",
      ),
      uniqueObservedCoordinateCount: integerField(
        partition,
        "uniqueObservedCoordinateCount",
        "partition",
      ),
    },
    result: {
      started: booleanField(result, "started", "result"),
      attemptedGames: integerField(result, "attemptedGames", "result"),
      completedGames: integerField(result, "completedGames", "result"),
      failedGames: integerField(result, "failedGames", "result"),
      expectedGames: integerField(result, "expectedGames", "result"),
      coordinateGate: booleanField(result, "coordinateGate", "result"),
      countGate: booleanField(result, "countGate", "result"),
      zeroFailureGate: booleanField(result, "zeroFailureGate", "result"),
      scientificGate: booleanField(result, "scientificGate", "result"),
    },
    recordCounts: recordOfNumbers(root.recordCounts, "recordCounts"),
    rawScientificFileSha256: recordOfStrings(
      root.rawScientificFileSha256,
      "rawScientificFileSha256",
    ),
    shardScientificSha256: stringField(
      root,
      "shardScientificSha256",
      "manifest",
    ),
  };
}

async function readCanonicalJson(path: string): Promise<unknown> {
  const payload = await readFile(path, "utf8");
  const parsed = JSON.parse(payload) as unknown;
  if (payload !== `${stableStringify(parsed)}\n`) {
    throw new Error(`${path} is not canonical JSON plus one newline.`);
  }
  return parsed;
}

async function readCanonicalNdjson<T>(
  path: string,
  schema: Schema<T>,
): Promise<readonly T[]> {
  const payload = await readFile(path, "utf8");
  if (payload.length === 0) {
    return [];
  }
  if (!payload.endsWith("\n")) {
    throw new Error(`${path} is not LF-terminated NDJSON.`);
  }
  const lines = payload.slice(0, -1).split("\n");
  const records = lines.map((line, index) => {
    if (line.length === 0) {
      throw new Error(`${path} has an empty line at ${index + 1}.`);
    }
    const parsed = schema.parse(JSON.parse(line) as unknown);
    if (line !== stableStringify(parsed)) {
      throw new Error(`${path} line ${index + 1} is noncanonical.`);
    }
    return parsed;
  });
  return Object.freeze(records);
}

async function directoriesWithFile(
  root: string,
  fileName: string,
): Promise<readonly string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === fileName)) {
      output.push(directory);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name));
      }
    }
  };
  await visit(resolve(root));
  return Object.freeze(output.sort());
}

async function verifyChecksums(directory: string): Promise<void> {
  const payload = await readFile(join(directory, "checksums.sha256"), "utf8");
  if (!payload.endsWith("\n")) {
    throw new Error(`${directory}/checksums.sha256 is not LF-terminated.`);
  }
  const entries = payload
    .trimEnd()
    .split("\n")
    .map((line) => {
      const match = /^([0-9a-f]{64})  ([^/\\]+)$/u.exec(line);
      if (match === null) {
        throw new Error(`${directory} has a malformed checksum line.`);
      }
      return { digest: match[1] as string, name: match[2] as string };
    });
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    throw new Error(`${directory} has duplicate checksum names.`);
  }
  for (const entry of entries) {
    const bytes = await readFile(join(directory, entry.name));
    if (sha256(bytes) !== entry.digest) {
      throw new Error(`${directory}/${entry.name} checksum failed.`);
    }
  }
}

function expectedBaseIndices(
  plan: Phase8TerminalPlan,
  shardIndex: number,
  shardCount: number,
): readonly number[] {
  return Array.from(
    { length: plan.baseCount - plan.baseIndexStart },
    (_, ordinal) => plan.baseIndexStart + ordinal,
  ).filter(
    (baseIndex) =>
      (baseIndex - plan.baseIndexStart) % shardCount === shardIndex,
  );
}

function coordinateKey(value: {
  readonly configId: string;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: number;
  readonly replicate: number;
}): string {
  return stableStringify({
    configId: value.configId,
    styleCellId: value.styleCellId,
    baseIndex: value.baseIndex,
    rotation: value.rotation,
    replicate: value.replicate,
  });
}

function expectedCoordinates(
  plan: Phase8TerminalPlan,
  baseIndices: readonly number[],
): readonly string[] {
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

async function gitCommit(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const result = await promisify(execFile)(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    { encoding: "utf8" },
  );
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Frozen source commit is unavailable.");
  }
  return commit;
}

async function compareInput(
  shardDirectory: string,
  shardName: string,
  expectedPath: string,
): Promise<void> {
  const [observed, expected] = await Promise.all([
    readFile(join(shardDirectory, shardName)),
    readFile(resolve(expectedPath)),
  ]);
  if (sha256(observed) !== sha256(expected)) {
    throw new Error(`${shardDirectory}/${shardName} does not match input.`);
  }
}

function scientificProjection(manifest: ShardManifest): unknown {
  return {
    planScientificSha256: manifest.planScientificSha256,
    partitionVersion: manifest.partitionVersion,
    partition: manifest.partition,
    result: manifest.result,
    rawScientificFileSha256: Object.fromEntries(
      Object.entries(manifest.rawScientificFileSha256).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

async function parseShard(input: {
  readonly directory: string;
  readonly options: Options;
  readonly plan: Phase8TerminalPlan;
  readonly sourceCommit: string;
}): Promise<ParsedShard> {
  await verifyChecksums(input.directory);
  const manifest = parseManifest(
    await readCanonicalJson(join(input.directory, "shard-manifest.json")),
  );
  const expectedBases = expectedBaseIndices(
    input.plan,
    manifest.shardIndex,
    input.options.shardCount,
  );
  const expected = expectedCoordinates(input.plan, expectedBases);
  const planHash = phase8TerminalPlanScientificHash(input.plan);
  const expectedShardId = `shard-${manifest.shardIndex
    .toString()
    .padStart(
      Math.max(2, input.options.shardCount.toString().length),
      "0",
    )}-of-${input.options.shardCount
    .toString()
    .padStart(Math.max(2, input.options.shardCount.toString().length), "0")}`;
  if (
    manifest.scope !== input.options.scope ||
    manifest.runId !== input.options.runId ||
    manifest.shardCount !== input.options.shardCount ||
    manifest.shardIndex < 0 ||
    manifest.shardIndex >= manifest.shardCount ||
    manifest.shardId !== expectedShardId ||
    manifest.sourceCommit !== input.sourceCommit ||
    manifest.planScientificSha256 !== planHash ||
    manifest.authorityKind !== input.plan.authorityKind ||
    manifest.manifestId !== input.plan.manifestId ||
    manifest.manifestSha256 !== input.plan.manifestSha256 ||
    manifest.splitOpeningSha256 !== input.plan.splitOpeningSha256 ||
    manifest.evidenceClass !== input.plan.evidenceClass ||
    manifest.evidenceEligible !== input.plan.evidenceEligible ||
    stableStringify(manifest.fullMatrix) !==
      stableStringify({
        baseIndexStart: input.plan.baseIndexStart,
        baseCount: input.plan.baseCount,
        styleCellIds: input.plan.styleCells.map((cell) => cell.id),
        rotations: input.plan.rotations,
        configurationIds: input.plan.configurations.map(
          (configuration) => configuration.configId,
        ),
        expectedGames: input.plan.expectedGames,
      }) ||
    stableStringify(manifest.partition.baseIndices) !==
      stableStringify(expectedBases) ||
    manifest.partition.expectedCoordinateCount !== expected.length ||
    manifest.partition.expectedCoordinatesSha256 !==
      sha256(stableStringify(expected)) ||
    manifest.partition.observedCoordinateCount !== expected.length ||
    manifest.partition.uniqueObservedCoordinateCount !== expected.length ||
    manifest.partition.observedCoordinatesSha256 !==
      manifest.partition.expectedCoordinatesSha256 ||
    !manifest.result.started ||
    !manifest.result.coordinateGate ||
    !manifest.result.countGate ||
    !manifest.result.zeroFailureGate ||
    !manifest.result.scientificGate ||
    manifest.result.attemptedGames !== expected.length ||
    manifest.result.completedGames !== expected.length ||
    manifest.result.failedGames !== 0 ||
    manifest.result.expectedGames !== expected.length ||
    manifest.shardScientificSha256 !==
      sha256(stableStringify(scientificProjection(manifest)))
  ) {
    throw new Error(`${input.directory} failed its frozen shard contract.`);
  }

  await Promise.all([
    compareInput(
      input.directory,
      "authority.input.json",
      input.options.authorityPath,
    ),
    compareInput(
      input.directory,
      "opening.input.json",
      input.options.openingPath,
    ),
    compareInput(
      input.directory,
      "production-model.input.json",
      input.options.modelPath,
    ),
    ...(input.options.qualificationAuthorityPath === null
      ? []
      : [
          compareInput(
            input.directory,
            "qualification-authority.input.json",
            input.options.qualificationAuthorityPath,
          ),
        ]),
    ...(input.options.selectionPath === null
      ? []
      : [
          compareInput(
            input.directory,
            "selection.input.json",
            input.options.selectionPath,
          ),
        ]),
    ...(input.options.selectionChecksumPath === null
      ? []
      : [
          compareInput(
            input.directory,
            "selection-checksum.input.sha256",
            input.options.selectionChecksumPath,
          ),
        ]),
  ]);

  const [
    components,
    seeds,
    games,
    truths,
    failures,
    decisions,
    latencies,
    summaryInputs,
  ] = await Promise.all([
    readCanonicalNdjson(
      join(input.directory, "components.ndjson"),
      phase8TerminalComponentAuditSchema,
    ),
    readCanonicalNdjson(
      join(input.directory, "seeds.ndjson"),
      phase8TerminalSeedRecordSchema,
    ),
    readCanonicalNdjson(
      join(input.directory, "games.ndjson"),
      phase8TerminalGameRecordSchema,
    ),
    readCanonicalNdjson(
      join(input.directory, "truth.eval-only.ndjson"),
      phase8TerminalTruthRecordSchema,
    ),
    readCanonicalNdjson(
      join(input.directory, "failures.ndjson"),
      phase8TerminalFailureRecordSchema,
    ),
    readCanonicalNdjson(
      join(input.directory, "decisions.ndjson"),
      phase8TerminalDecisionRecordSchema,
    ),
    readCanonicalNdjson(
      join(input.directory, "latency.ndjson"),
      phase8TerminalLatencyRecordSchema,
    ),
    readCanonicalNdjson(
      join(input.directory, "summary-inputs.ndjson"),
      phase8TerminalSummaryInputSchema,
    ),
  ]);
  const values = {
    "components.ndjson": components.length,
    "seeds.ndjson": seeds.length,
    "games.ndjson": games.length,
    "truth.eval-only.ndjson": truths.length,
    "failures.ndjson": failures.length,
    "decisions.ndjson": decisions.length,
    "latency.ndjson": latencies.length,
    "summary-inputs.ndjson": summaryInputs.length,
  };
  if (stableStringify(values) !== stableStringify(manifest.recordCounts)) {
    throw new Error(`${input.directory} record counts do not reproduce.`);
  }
  for (const fileName of RAW_FILES) {
    const bytes = await readFile(join(input.directory, fileName));
    if (sha256(bytes) !== manifest.rawScientificFileSha256[fileName]) {
      throw new Error(`${input.directory}/${fileName} raw hash failed.`);
    }
  }
  const observed = summaryInputs.map(coordinateKey);
  if (
    stableStringify(observed) !== stableStringify(expected) ||
    new Set(observed).size !== expected.length
  ) {
    throw new Error(`${input.directory} coordinate stream is noncanonical.`);
  }
  return Object.freeze({
    directory: input.directory,
    manifest,
    components,
    seeds,
    games,
    truths,
    failures,
    decisions,
    latencies,
    summaryInputs,
  });
}

function oneByKey<T>(
  records: readonly T[],
  key: (record: T) => string,
  label: string,
): ReadonlyMap<string, T> {
  const output = new Map<string, T>();
  for (const record of records) {
    const value = key(record);
    if (output.has(value)) {
      throw new Error(`Duplicate ${label} ${value}.`);
    }
    output.set(value, record);
  }
  return output;
}

function groupedByKey<T>(
  records: readonly T[],
  key: (record: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const output = new Map<string, T[]>();
  for (const record of records) {
    const value = key(record);
    const group = output.get(value) ?? [];
    group.push(record);
    output.set(value, group);
  }
  return output;
}

function requireFromMap<T>(
  values: ReadonlyMap<string, T>,
  key: string,
  label: string,
): T {
  const value = values.get(key);
  if (value === undefined) {
    throw new Error(`Missing ${label} ${key}.`);
  }
  return value;
}

async function main(): Promise<void> {
  const options = parseOptions();
  const [plan, sourceCommit, serializedModel] = await Promise.all([
    loadPhase8TerminalPlan(options),
    gitCommit(),
    readFile(resolve(options.modelPath), "utf8"),
  ]);
  const directories = await directoriesWithFile(
    options.shardsRoot,
    "shard-manifest.json",
  );
  if (directories.length !== options.shardCount) {
    throw new Error(
      `Expected ${options.shardCount.toString()} shard directories; found ${directories.length.toString()}.`,
    );
  }
  const shards = await Promise.all(
    directories.map((directory) =>
      parseShard({ directory, options, plan, sourceCommit }),
    ),
  );
  const orderedShards = [...shards].sort(
    (left, right) => left.manifest.shardIndex - right.manifest.shardIndex,
  );
  if (
    orderedShards.some((shard, index) => shard.manifest.shardIndex !== index)
  ) {
    throw new Error("Shard indices are incomplete or duplicated.");
  }
  const expectedBases = Array.from(
    { length: plan.baseCount - plan.baseIndexStart },
    (_, ordinal) => plan.baseIndexStart + ordinal,
  );
  const observedBases = orderedShards
    .flatMap((shard) => shard.manifest.partition.baseIndices)
    .sort((left, right) => left - right);
  if (
    stableStringify(observedBases) !== stableStringify(expectedBases) ||
    new Set(observedBases).size !== expectedBases.length
  ) {
    throw new Error("Shard base-index partition is incomplete or duplicated.");
  }

  const firstComponents = orderedShards[0]?.components;
  if (
    firstComponents === undefined ||
    orderedShards.some(
      (shard) =>
        stableStringify(shard.components) !== stableStringify(firstComponents),
    )
  ) {
    throw new Error("Shard component audits are not byte-identical.");
  }
  const allSeeds = orderedShards.flatMap((shard) => shard.seeds);
  const allGames = orderedShards.flatMap((shard) => shard.games);
  const allTruths = orderedShards.flatMap((shard) => shard.truths);
  const allFailures = orderedShards.flatMap((shard) => shard.failures);
  const allDecisions = orderedShards.flatMap((shard) => shard.decisions);
  const allLatencies = orderedShards.flatMap((shard) => shard.latencies);
  const allSummaryInputs = orderedShards.flatMap(
    (shard) => shard.summaryInputs,
  );
  if (
    allSummaryInputs.length !== plan.expectedGames ||
    allGames.length + allFailures.length !== plan.expectedGames ||
    allFailures.length !== 0 ||
    allTruths.length !== allGames.length
  ) {
    throw new Error("Merged raw counts fail the complete zero-failure matrix.");
  }

  const styleOrder = new Map<string, number>(
    plan.styleCells.map((cell, index) => [cell.id, index]),
  );
  const configOrder = new Map<string, number>(
    plan.configurations.map((configuration, index) => [
      configuration.configId,
      index,
    ]),
  );
  const coordinateOrder = (
    left: {
      readonly baseIndex: number;
      readonly styleCellId: string;
      readonly rotation: number;
      readonly configId: string;
    },
    right: {
      readonly baseIndex: number;
      readonly styleCellId: string;
      readonly rotation: number;
      readonly configId: string;
    },
  ): number =>
    left.baseIndex - right.baseIndex ||
    (styleOrder.get(left.styleCellId) ?? Number.MAX_SAFE_INTEGER) -
      (styleOrder.get(right.styleCellId) ?? Number.MAX_SAFE_INTEGER) ||
    left.rotation - right.rotation ||
    (configOrder.get(left.configId) ?? Number.MAX_SAFE_INTEGER) -
      (configOrder.get(right.configId) ?? Number.MAX_SAFE_INTEGER);
  const orderedSummaryInputs = [...allSummaryInputs].sort(coordinateOrder);
  const orderedSeeds = [...allSeeds].sort(
    (left, right) =>
      left.baseIndex - right.baseIndex ||
      (styleOrder.get(left.styleCellId) ?? Number.MAX_SAFE_INTEGER) -
        (styleOrder.get(right.styleCellId) ?? Number.MAX_SAFE_INTEGER) ||
      left.rotation - right.rotation,
  );
  if (
    new Set(orderedSummaryInputs.map(coordinateKey)).size !==
      plan.expectedGames ||
    orderedSeeds.length !==
      plan.baseCount * plan.styleCells.length * plan.rotations.length
  ) {
    throw new Error("Merged coordinate or seed coverage is not unique.");
  }

  const games = oneByKey(allGames, (record) => record.gameId, "game");
  const truths = oneByKey(allTruths, (record) => record.gameId, "truth");
  const failures = oneByKey(allFailures, (record) => record.gameId, "failure");
  const decisions = groupedByKey(allDecisions, (record) => record.gameId);
  const latencies = groupedByKey(allLatencies, (record) => record.gameId);

  const session = await createPhase8TerminalArtifactSession({
    rootDirectory: resolve(options.outputRoot),
    plan,
    serializedProductionModel: serializedModel,
    environment: {
      mergerVersion: MERGER_VERSION,
      platform: platform(),
      release: release(),
      node: process.version,
      logicalProcessors: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtStart: freemem(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sourceCommit,
      shardCount: options.shardCount,
      shardScientificSha256: orderedShards.map(
        (shard) => shard.manifest.shardScientificSha256,
      ),
      githubRunId: process.env.GITHUB_RUN_ID ?? null,
      githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    },
    command: process.argv.join(" "),
    createdAt: new Date().toISOString(),
  });
  for (const component of firstComponents) {
    await session.sink.writeComponentAudit(component);
  }
  for (const seed of orderedSeeds) {
    await session.sink.writeSeed(seed);
  }
  for (const summaryInput of orderedSummaryInputs) {
    const game = games.get(summaryInput.gameId) ?? null;
    const truth = truths.get(summaryInput.gameId) ?? null;
    const failure = failures.get(summaryInput.gameId) ?? null;
    const scenario: Phase8TerminalScenarioResult = {
      game,
      truth,
      failure,
      decisions: Object.freeze(
        [...(decisions.get(summaryInput.gameId) ?? [])].sort(
          (left, right) => left.decisionOrdinal - right.decisionOrdinal,
        ),
      ),
      latencies: Object.freeze(
        [...(latencies.get(summaryInput.gameId) ?? [])].sort(
          (left, right) => left.decisionOrdinal - right.decisionOrdinal,
        ),
      ),
      summaryInput,
    };
    await session.sink.writeScenario(scenario);
  }
  const preflight = preflightPhase8TerminalConfigurations({
    configurations: plan.configurations,
    manifestModelSha256: plan.hashes.modelSha256,
    serializedProductionModel: serializedModel,
  });
  const result: Phase8TerminalRunResult = {
    started: true,
    preflight,
    attemptedGames: allSummaryInputs.length,
    completedGames: allGames.length,
    failedGames: allFailures.length,
    expectedGames: plan.expectedGames,
  };
  const verification = await session.finalize(result);
  if (!verification.ok) {
    throw new Error(
      `Merged terminal artifact failed verification: ${verification.failures.join("; ")}`,
    );
  }
  const reportPath = `${session.runDirectory}-statistical-report.json`;
  const report = await writePhase8TerminalStatisticalReport({
    runDirectory: session.runDirectory,
    outputPath: reportPath,
  });
  const reopened = await verifyPhase8TerminalArtifacts(session.runDirectory);
  if (!reopened.ok || !report.evidenceGate) {
    throw new Error("Merged terminal evidence did not pass its frozen gates.");
  }
  const totalBytes = (
    await Promise.all(
      (await readdir(session.runDirectory)).map(
        async (name) => (await stat(join(session.runDirectory, name))).size,
      ),
    )
  ).reduce((sum, value) => sum + value, 0);
  process.stdout.write(
    `${JSON.stringify({
      mergerVersion: MERGER_VERSION,
      runDirectory: session.runDirectory,
      reportPath,
      reportSha256: report.reportSha256,
      evidenceGate: report.evidenceGate,
      shardCount: options.shardCount,
      expectedGames: plan.expectedGames,
      completedGames: allGames.length,
      totalBytes,
    })}\n`,
  );
}

await main();
