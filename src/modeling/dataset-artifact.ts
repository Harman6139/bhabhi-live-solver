import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { stableHash, stableStringify } from "../events/stable-hash";
import type { SourceSnapshot } from "../evaluation/artifacts";
import {
  behaviorFitDatasetContentHash,
  behaviorFitDatasetHash,
  behaviorFitObservationSchema,
} from "./behavior-fit";
import {
  behaviorDatasetScheduleHash,
  createBehaviorDatasetPlan,
  expectedBehaviorDatasetGames,
  type BehaviorDatasetFailure,
  type BehaviorDatasetGameAudit,
  type BehaviorDatasetPlan,
  type BehaviorFitDataset,
} from "./behavior-dataset";

export const BEHAVIOR_DATASET_ARTIFACT_VERSION =
  "phase8-behavior-dataset-artifact-v1" as const;

const PAYLOAD_FILES = [
  "command.txt",
  "failures.ndjson",
  "games.ndjson",
  "manifest.json",
  "observations.ndjson",
] as const;
const ALL_FILES = [...PAYLOAD_FILES, "checksums.sha256"].sort();
const FORBIDDEN_PUBLIC_DATA_KEYS = new Set([
  "deal",
  "exactHands",
  "finalHands",
  "hands",
  "hiddenHands",
  "initialHands",
  "truth",
  "truthHash",
]);

export type BehaviorDatasetArtifactManifest = {
  readonly schemaVersion: 1;
  readonly artifactVersion: typeof BEHAVIOR_DATASET_ARTIFACT_VERSION;
  readonly artifactKind: "phase8-public-behavior-fit-dataset";
  readonly createdAt: string;
  readonly writeMode: "atomic-create-exclusive";
  readonly plan: BehaviorDatasetPlan;
  readonly scheduleHash: string;
  readonly source: SourceSnapshot;
  readonly command: string;
  readonly expectedGames: number;
  readonly completedGames: number;
  readonly observationCount: number;
  readonly failureCount: number;
  readonly datasetHash: string;
  readonly datasetContentHash: string;
  readonly observationsSha256: string;
  readonly gamesHash: string;
  readonly failuresHash: string;
  readonly publicOnlyGate: true;
  readonly completeScheduleGate: boolean;
  readonly zeroFailureGate: boolean;
  readonly evidenceGate: boolean;
  readonly manifestSha256: string;
};

export type BehaviorDatasetArtifactVerification = {
  readonly valid: boolean;
  readonly directory: string;
  readonly failures: readonly string[];
  readonly manifest: BehaviorDatasetArtifactManifest | null;
  readonly dataset: BehaviorFitDataset | null;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function ndjson(values: readonly unknown[]): string {
  return values.length === 0
    ? ""
    : `${values.map((value) => stableStringify(value)).join("\n")}\n`;
}

function lines(value: string): unknown[] {
  if (value.trim().length === 0) {
    return [];
  }
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function manifestPayload(
  manifest: Omit<BehaviorDatasetArtifactManifest, "manifestSha256">,
): Omit<BehaviorDatasetArtifactManifest, "manifestSha256"> {
  return manifest;
}

function manifestSha256(
  manifest: Omit<BehaviorDatasetArtifactManifest, "manifestSha256">,
): string {
  return sha256(stableStringify(manifestPayload(manifest)));
}

function publicDataViolation(value: unknown, path = "<root>"): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const violation = publicDataViolation(value[index], `${path}[${index}]`);
      if (violation !== null) {
        return violation;
      }
    }
    return null;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PUBLIC_DATA_KEYS.has(key)) {
      return `${path}.${key}`;
    }
    const violation = publicDataViolation(child, `${path}.${key}`);
    if (violation !== null) {
      return violation;
    }
  }
  return null;
}

function safeTimestamp(value: string): boolean {
  return (
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function parseGameAudit(value: unknown): BehaviorDatasetGameAudit {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Behavior dataset game audit must be an object.");
  }
  const record = value as Record<string, unknown>;
  const numericKeys = [
    "baseIndex",
    "rotation",
    "opponentDecisions",
    "scheduledDecisionCheckpoints",
    "discretionaryObservations",
    "forcedScheduledDecisions",
  ] as const;
  for (const key of numericKeys) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0) {
      throw new Error(`Behavior dataset game audit has invalid ${key}.`);
    }
  }
  for (const key of ["gameId", "styleCellId", "publicDatasetHash"] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new Error(`Behavior dataset game audit has invalid ${key}.`);
    }
  }
  if (record.rotation !== 0 && record.rotation !== 1 && record.rotation !== 2) {
    throw new Error("Behavior dataset game audit has invalid rotation.");
  }
  return value as BehaviorDatasetGameAudit;
}

function parseFailure(value: unknown): BehaviorDatasetFailure {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Behavior dataset failure must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.gameId !== "string" ||
    typeof record.styleCellId !== "string" ||
    !Number.isSafeInteger(record.baseIndex) ||
    (record.rotation !== 0 && record.rotation !== 1 && record.rotation !== 2) ||
    (record.stage !== "simulation" && record.stage !== "public-observation") ||
    typeof record.name !== "string" ||
    typeof record.message !== "string"
  ) {
    throw new Error("Behavior dataset failure record is malformed.");
  }
  return value as BehaviorDatasetFailure;
}

function canonicalPlan(value: unknown): BehaviorDatasetPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Behavior dataset manifest plan must be an object.");
  }
  const rawPlan = value as Record<string, unknown>;
  if (rawPlan.split !== "train" && rawPlan.split !== "tune") {
    throw new Error("Behavior dataset plan split must be train or tune.");
  }
  const plan = value as BehaviorDatasetPlan;
  const rebuilt = createBehaviorDatasetPlan({
    runId: plan.runId,
    split: plan.split,
    evidenceEligible: plan.evidenceEligible,
    baseCount: plan.baseCount,
    baseIndexStart: plan.baseIndexStart,
    styleCellIds: plan.styleCellIds,
    rotations: plan.rotations,
    opponentDecisionOrdinals: plan.opponentDecisionOrdinals,
    worldCounts: plan.worldCounts,
    eventCap: plan.eventCap,
  });
  if (stableStringify(rebuilt) !== stableStringify(value)) {
    throw new Error("Behavior dataset manifest plan is not canonical.");
  }
  return rebuilt;
}

function parseManifest(value: unknown): BehaviorDatasetArtifactManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Behavior dataset manifest must be an object.");
  }
  const manifest = value as Partial<BehaviorDatasetArtifactManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.artifactVersion !== BEHAVIOR_DATASET_ARTIFACT_VERSION ||
    manifest.artifactKind !== "phase8-public-behavior-fit-dataset" ||
    manifest.writeMode !== "atomic-create-exclusive" ||
    typeof manifest.createdAt !== "string" ||
    !safeTimestamp(manifest.createdAt) ||
    typeof manifest.command !== "string" ||
    manifest.command.length === 0 ||
    typeof manifest.scheduleHash !== "string" ||
    typeof manifest.datasetHash !== "string" ||
    typeof manifest.datasetContentHash !== "string" ||
    typeof manifest.observationsSha256 !== "string" ||
    typeof manifest.gamesHash !== "string" ||
    typeof manifest.failuresHash !== "string" ||
    typeof manifest.manifestSha256 !== "string" ||
    manifest.publicOnlyGate !== true ||
    typeof manifest.completeScheduleGate !== "boolean" ||
    typeof manifest.zeroFailureGate !== "boolean" ||
    typeof manifest.evidenceGate !== "boolean"
  ) {
    throw new Error("Behavior dataset manifest envelope is malformed.");
  }
  for (const key of [
    "expectedGames",
    "completedGames",
    "observationCount",
    "failureCount",
  ] as const) {
    const numericValue = manifest[key];
    if (
      typeof numericValue !== "number" ||
      !Number.isSafeInteger(numericValue) ||
      numericValue < 0
    ) {
      throw new Error(`Behavior dataset manifest has invalid ${key}.`);
    }
  }
  if (
    manifest.source === undefined ||
    typeof manifest.source.sourceSnapshotSha256 !== "string" ||
    !Number.isSafeInteger(manifest.source.sourceFileCount) ||
    typeof manifest.source.gitStatusSha256 !== "string" ||
    typeof manifest.source.gitDirty !== "boolean"
  ) {
    throw new Error("Behavior dataset source snapshot is malformed.");
  }
  const plan = canonicalPlan(manifest.plan);
  const parsed = { ...manifest, plan } as BehaviorDatasetArtifactManifest;
  const { manifestSha256: recorded, ...payload } = parsed;
  if (recorded !== manifestSha256(payload)) {
    throw new Error("Behavior dataset manifest checksum mismatch.");
  }
  return parsed;
}

function scheduleCoordinate(input: {
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: number;
}): string {
  return `${input.styleCellId}/${input.baseIndex.toString()}/${input.rotation.toString()}`;
}

function scheduleIssues(dataset: BehaviorFitDataset): string[] {
  const issues: string[] = [];
  const expected = new Set<string>();
  for (
    let baseIndex = dataset.plan.baseIndexStart;
    baseIndex < dataset.plan.baseIndexStart + dataset.plan.baseCount;
    baseIndex += 1
  ) {
    for (const styleCellId of dataset.plan.styleCellIds) {
      for (const rotation of dataset.plan.rotations) {
        expected.add(scheduleCoordinate({ styleCellId, baseIndex, rotation }));
      }
    }
  }
  const seen = new Set<string>();
  for (const game of dataset.games) {
    const coordinate = scheduleCoordinate(game);
    if (!expected.has(coordinate)) {
      issues.push(`Game ${game.gameId} is outside the frozen schedule.`);
    }
    if (seen.has(coordinate)) {
      issues.push(`Duplicate completed coordinate ${coordinate}.`);
    }
    seen.add(coordinate);
    const observations = dataset.observations
      .filter((observation) =>
        observation.sequenceId.startsWith(`${game.gameId}/`),
      )
      .sort((left, right) =>
        left.observationId.localeCompare(right.observationId),
      );
    if (
      observations.length !== game.discretionaryObservations ||
      stableHash(observations) !== game.publicDatasetHash ||
      game.scheduledDecisionCheckpoints !==
        game.discretionaryObservations + game.forcedScheduledDecisions
    ) {
      issues.push(`Game ${game.gameId} has inconsistent observation audit.`);
    }
  }
  for (const failure of dataset.failures.filter(
    (entry) => entry.stage === "simulation",
  )) {
    const coordinate = scheduleCoordinate(failure);
    if (!expected.has(coordinate)) {
      issues.push(`Failure ${failure.gameId} is outside the frozen schedule.`);
    }
    if (seen.has(coordinate)) {
      issues.push(`Duplicate terminal coordinate ${coordinate}.`);
    }
    seen.add(coordinate);
  }
  if (seen.size !== expected.size) {
    issues.push(
      `Schedule coverage is ${seen.size.toString()} of ${expected.size.toString()} coordinates.`,
    );
  }
  return issues;
}

export function buildBehaviorDatasetArtifactManifest(input: {
  readonly dataset: BehaviorFitDataset;
  readonly source: SourceSnapshot;
  readonly command: string;
  readonly createdAt?: string;
}): BehaviorDatasetArtifactManifest {
  const violation = publicDataViolation([
    input.dataset.observations,
    input.dataset.games,
  ]);
  if (violation !== null) {
    throw new Error(
      `Behavior dataset leaks a forbidden truth key at ${violation}.`,
    );
  }
  const observationsText = ndjson(input.dataset.observations);
  const issues = scheduleIssues(input.dataset);
  const expectedGames = expectedBehaviorDatasetGames(input.dataset.plan);
  const zeroFailureGate = input.dataset.failures.length === 0;
  const completeScheduleGate =
    issues.length === 0 && input.dataset.games.length === expectedGames;
  const evidenceGate =
    !input.dataset.plan.evidenceEligible ||
    (zeroFailureGate &&
      completeScheduleGate &&
      !input.source.gitDirty &&
      input.source.gitCommit !== null);
  const payload = {
    schemaVersion: 1 as const,
    artifactVersion: BEHAVIOR_DATASET_ARTIFACT_VERSION,
    artifactKind: "phase8-public-behavior-fit-dataset" as const,
    createdAt: input.createdAt ?? new Date().toISOString(),
    writeMode: "atomic-create-exclusive" as const,
    plan: input.dataset.plan,
    scheduleHash: input.dataset.scheduleHash,
    source: input.source,
    command: input.command,
    expectedGames,
    completedGames: input.dataset.games.length,
    observationCount: input.dataset.observations.length,
    failureCount: input.dataset.failures.length,
    datasetHash: behaviorFitDatasetHash(input.dataset.observations),
    datasetContentHash: behaviorFitDatasetContentHash(
      input.dataset.observations,
    ),
    observationsSha256: sha256(observationsText),
    gamesHash: stableHash(input.dataset.games),
    failuresHash: stableHash(input.dataset.failures),
    publicOnlyGate: true as const,
    completeScheduleGate,
    zeroFailureGate,
    evidenceGate,
  };
  return Object.freeze({
    ...payload,
    manifestSha256: manifestSha256(payload),
  });
}

function checksumText(
  payloads: Readonly<Record<(typeof PAYLOAD_FILES)[number], string>>,
): string {
  return `${PAYLOAD_FILES.map((file) => `${sha256(payloads[file])}  ${file}`)
    .sort()
    .join("\n")}\n`;
}

export async function writeBehaviorDatasetArtifacts(input: {
  readonly directory: string;
  readonly dataset: BehaviorFitDataset;
  readonly source: SourceSnapshot;
  readonly command: string;
  readonly createdAt?: string;
}): Promise<BehaviorDatasetArtifactManifest> {
  const directory = resolve(input.directory);
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  const manifest = buildBehaviorDatasetArtifactManifest(input);
  if (input.dataset.plan.evidenceEligible && !manifest.evidenceGate) {
    throw new Error(
      "Evidence-eligible behavior dataset failed its clean-source, schedule, or zero-failure gate.",
    );
  }
  const payloads = {
    "command.txt": `${input.command}\n`,
    "failures.ndjson": ndjson(input.dataset.failures),
    "games.ndjson": ndjson(input.dataset.games),
    "manifest.json": `${stableStringify(manifest)}\n`,
    "observations.ndjson": ndjson(input.dataset.observations),
  } satisfies Record<(typeof PAYLOAD_FILES)[number], string>;
  const staging = await mkdtemp(
    join(parent, `.${basename(directory)}.staging-`),
  );
  try {
    for (const file of PAYLOAD_FILES) {
      await writeFile(join(staging, file), payloads[file], {
        encoding: "utf8",
        flag: "wx",
      });
    }
    await writeFile(join(staging, "checksums.sha256"), checksumText(payloads), {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(staging, directory);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }
  return manifest;
}

function checksumMap(value: string): ReadonlyMap<string, string> {
  const output = new Map<string, string>();
  for (const line of value.replaceAll("\r\n", "\n").split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const match = /^([0-9a-f]{64}) {2}([a-z0-9.-]+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`Malformed checksum line: ${line}`);
    }
    output.set(match[2], match[1]);
  }
  return output;
}

function requiredFileContent(
  contents: Readonly<Record<string, string | undefined>>,
  file: string,
): string {
  const value = contents[file];
  if (value === undefined) {
    throw new Error(`Required artifact file ${file} was not read.`);
  }
  return value;
}

export async function verifyBehaviorDatasetArtifacts(
  directoryValue: string,
): Promise<BehaviorDatasetArtifactVerification> {
  const directory = resolve(directoryValue);
  const failures: string[] = [];
  let manifest: BehaviorDatasetArtifactManifest | null = null;
  let dataset: BehaviorFitDataset | null = null;
  try {
    const files = (await readdir(directory)).sort();
    if (stableStringify(files) !== stableStringify(ALL_FILES)) {
      failures.push(
        `Artifact files differ: expected ${ALL_FILES.join(", ")}, found ${files.join(", ")}.`,
      );
    }
    const contents = Object.fromEntries(
      await Promise.all(
        ALL_FILES.map(async (file) => [
          file,
          await readFile(join(directory, file), "utf8"),
        ]),
      ),
    ) as Record<(typeof ALL_FILES)[number], string>;
    const checksums = checksumMap(
      requiredFileContent(contents, "checksums.sha256"),
    );
    for (const file of PAYLOAD_FILES) {
      if (checksums.get(file) !== sha256(requiredFileContent(contents, file))) {
        failures.push(`${file} checksum mismatch.`);
      }
    }
    if (
      checksums.size !== PAYLOAD_FILES.length ||
      [...checksums.keys()].some(
        (file) =>
          !PAYLOAD_FILES.includes(file as (typeof PAYLOAD_FILES)[number]),
      )
    ) {
      failures.push("checksums.sha256 has unexpected coverage.");
    }
    const manifestText = requiredFileContent(contents, "manifest.json");
    const commandText = requiredFileContent(contents, "command.txt");
    const observationsText = requiredFileContent(
      contents,
      "observations.ndjson",
    );
    const gamesText = requiredFileContent(contents, "games.ndjson");
    const failuresText = requiredFileContent(contents, "failures.ndjson");
    manifest = parseManifest(JSON.parse(manifestText) as unknown);
    if (`${manifest.command}\n` !== commandText) {
      failures.push("command.txt does not match the manifest.");
    }
    const observations = lines(observationsText).map((value) =>
      behaviorFitObservationSchema.parse(value),
    );
    const games = lines(gamesText).map(parseGameAudit);
    const recordsFailures = lines(failuresText).map(parseFailure);
    dataset = Object.freeze({
      plan: manifest.plan,
      scheduleHash: manifest.scheduleHash,
      observations: Object.freeze(observations),
      games: Object.freeze(games),
      failures: Object.freeze(recordsFailures),
    });
    const violation = publicDataViolation([observations, games]);
    if (violation !== null) {
      failures.push(`Forbidden truth key found at ${violation}.`);
    }
    if (
      manifest.scheduleHash !== behaviorDatasetScheduleHash(manifest.plan) ||
      manifest.scheduleHash !== dataset.scheduleHash
    ) {
      failures.push("Dataset schedule hash mismatch.");
    }
    if (
      manifest.observationCount !== observations.length ||
      manifest.completedGames !== games.length ||
      manifest.failureCount !== recordsFailures.length ||
      manifest.expectedGames !== expectedBehaviorDatasetGames(manifest.plan)
    ) {
      failures.push("Dataset manifest counts do not match payloads.");
    }
    if (
      manifest.datasetHash !== behaviorFitDatasetHash(observations) ||
      manifest.datasetContentHash !==
        behaviorFitDatasetContentHash(observations) ||
      manifest.observationsSha256 !== sha256(observationsText) ||
      manifest.gamesHash !== stableHash(games) ||
      manifest.failuresHash !== stableHash(recordsFailures)
    ) {
      failures.push("Dataset manifest content hashes do not match payloads.");
    }
    failures.push(...scheduleIssues(dataset));
    const zeroFailureGate = recordsFailures.length === 0;
    const completeScheduleGate =
      scheduleIssues(dataset).length === 0 &&
      games.length === expectedBehaviorDatasetGames(manifest.plan);
    const evidenceGate =
      !manifest.plan.evidenceEligible ||
      (zeroFailureGate &&
        completeScheduleGate &&
        !manifest.source.gitDirty &&
        manifest.source.gitCommit !== null);
    if (
      manifest.zeroFailureGate !== zeroFailureGate ||
      manifest.completeScheduleGate !== completeScheduleGate ||
      manifest.evidenceGate !== evidenceGate
    ) {
      failures.push("Dataset manifest gates do not recompute.");
    }
    if (manifest.plan.evidenceEligible && !evidenceGate) {
      failures.push(
        "Evidence-eligible dataset does not pass its evidence gate.",
      );
    }
  } catch (cause) {
    failures.push(cause instanceof Error ? cause.message : String(cause));
  }
  return {
    valid: failures.length === 0,
    directory,
    failures: Object.freeze(failures),
    manifest,
    dataset,
  };
}

export async function readVerifiedBehaviorDatasetArtifacts(
  directory: string,
): Promise<{
  readonly manifest: BehaviorDatasetArtifactManifest;
  readonly dataset: BehaviorFitDataset;
}> {
  const verification = await verifyBehaviorDatasetArtifacts(directory);
  if (
    !verification.valid ||
    verification.manifest === null ||
    verification.dataset === null
  ) {
    throw new Error(
      `Behavior dataset artifact verification failed: ${verification.failures.join("; ")}`,
    );
  }
  return {
    manifest: verification.manifest,
    dataset: verification.dataset,
  };
}
