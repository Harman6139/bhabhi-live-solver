import { createHash } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod";

import { stableStringify } from "../events/stable-hash";
import { phase8Sha256 } from "../evaluation/phase8-manifest";
import {
  verifyPhase8CalibrationPlan,
  type Phase8CalibrationPlan,
} from "./phase8-plan";
import {
  validatePhase8CalibrationPredictionRecord,
  validatePhase8CalibrationTerminalRiskPredictionRecord,
  type Phase8CalibrationPredictionRecord,
  type Phase8CalibrationTerminalRiskPredictionRecord,
} from "./phase8-records";
import {
  summarizePhase8Calibration,
  validatePhase8CalibrationScoreRecord,
  validatePhase8CalibrationScoreSkipRecord,
  validatePhase8CalibrationTerminalRiskScoreRecord,
  verifyPhase8CalibrationSummary,
  type Phase8CalibrationScoreRecord,
  type Phase8CalibrationSummary,
  type Phase8CalibrationScoreSkipRecord,
  type Phase8CalibrationTerminalRiskScoreRecord,
} from "./phase8-scoring";

export const PHASE8_CALIBRATION_ARTIFACT_VERSION =
  "phase8-clean-calibration-artifact-v1" as const;

const PLAN_FILE = "calibration-plan.json";
const PREDICTIONS_FILE = "paired-predictions.ndjson";
const SCORES_FILE = "paired-scores.ndjson";
const SCORE_SKIPS_FILE = "score-skips.ndjson";
const TERMINAL_PREDICTIONS_FILE = "terminal-risk-predictions.ndjson";
const TERMINAL_SCORES_FILE = "terminal-risk-scores.ndjson";
const SUMMARY_FILE = "summary.json";
const MANIFEST_FILE = "manifest.json";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const fileSchema = z
  .object({
    file: z.string().min(1),
    records: z.int().nonnegative(),
    bytes: z.int().nonnegative(),
    sha256: sha256Schema,
  })
  .strict();

export const phase8CalibrationArtifactManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactVersion: z.literal(PHASE8_CALIBRATION_ARTIFACT_VERSION),
    protocolId: z.literal("eval-v1"),
    runId: z.string().min(1),
    split: z.enum(["qualification", "final"]),
    mode: z.enum(["behavioral-comparison", "reference-one-arm-confirmation"]),
    evidenceClass: z.literal("phase8-clean-calibration"),
    evidenceEligible: z.boolean(),
    manifestSha256: sha256Schema,
    planSha256: sha256Schema,
    sourceSha256: sha256Schema,
    configurationRegistrySha256: sha256Schema,
    selectedModelSerializedSha256: sha256Schema,
    supportRegularizerSha256: sha256Schema,
    scorerSha256: sha256Schema,
    queryPlanSha256: sha256Schema,
    reportSha256: sha256Schema,
    preregistrationSha256: sha256Schema,
    files: z
      .object({
        plan: fileSchema.extend({ file: z.literal(PLAN_FILE) }),
        predictions: fileSchema.extend({
          file: z.literal(PREDICTIONS_FILE),
        }),
        scores: fileSchema.extend({ file: z.literal(SCORES_FILE) }),
        scoreSkips: fileSchema.extend({
          file: z.literal(SCORE_SKIPS_FILE),
        }),
        terminalRiskPredictions: fileSchema.extend({
          file: z.literal(TERMINAL_PREDICTIONS_FILE),
        }),
        terminalRiskScores: fileSchema.extend({
          file: z.literal(TERMINAL_SCORES_FILE),
        }),
        summary: fileSchema.extend({ file: z.literal(SUMMARY_FILE) }),
      })
      .strict(),
    summarySha256: sha256Schema,
    artifactSha256: sha256Schema,
  })
  .strict();

export type Phase8CalibrationArtifactManifest = z.infer<
  typeof phase8CalibrationArtifactManifestSchema
>;

type SyncOrAsyncIterable<T> = Iterable<T> | AsyncIterable<T>;

type StoredFile = Readonly<{
  file: string;
  records: number;
  bytes: number;
  sha256: string;
}>;

function fail(message: string): never {
  throw new Error(`Phase 8 calibration artifact rejected: ${message}`);
}

function serializeJson(value: unknown): string {
  return `${stableStringify(value)}\n`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function writeExclusiveJson(
  root: string,
  file: string,
  value: unknown,
): Promise<StoredFile> {
  const serialized = serializeJson(value);
  await using handle = await open(join(root, file), "wx");
  await handle.writeFile(serialized, "utf8");
  return {
    file,
    records: 1,
    bytes: Buffer.byteLength(serialized, "utf8"),
    sha256: sha256Text(serialized),
  };
}

function isAsyncIterable<T>(
  value: SyncOrAsyncIterable<T>,
): value is AsyncIterable<T> {
  return Symbol.asyncIterator in value;
}

async function* asAsyncIterable<T>(
  value: SyncOrAsyncIterable<T>,
): AsyncGenerator<T> {
  if (isAsyncIterable(value)) {
    yield* value;
  } else {
    yield* value;
  }
}

async function writeNdjson<T>(
  root: string,
  file: string,
  records: SyncOrAsyncIterable<T>,
  validate: (value: unknown) => T,
): Promise<StoredFile> {
  let handle: FileHandle | null = null;
  const digest = createHash("sha256");
  let count = 0;
  let bytes = 0;
  try {
    handle = await open(join(root, file), "wx");
    for await (const value of asAsyncIterable(records)) {
      const record = validate(value);
      const line = serializeJson(record);
      await handle.write(line, null, "utf8");
      digest.update(line, "utf8");
      bytes += Buffer.byteLength(line, "utf8");
      count += 1;
    }
  } finally {
    await handle?.close();
  }
  return {
    file,
    records: count,
    bytes,
    sha256: digest.digest("hex"),
  };
}

function manifestProjection(
  manifest: Omit<Phase8CalibrationArtifactManifest, "artifactSha256">,
): Omit<Phase8CalibrationArtifactManifest, "artifactSha256"> {
  return manifest;
}

/**
 * Creates one immutable artifact directory. `mkdir(root)` and every file use
 * exclusive creation, so a previous run can never be truncated or replaced.
 * NDJSON inputs may be synchronous or asynchronous iterables and are written
 * one canonical line at a time.
 */
export async function writePhase8CalibrationArtifact(input: {
  readonly root: string;
  readonly plan: Phase8CalibrationPlan;
  readonly predictions: SyncOrAsyncIterable<Phase8CalibrationPredictionRecord>;
  readonly scores: SyncOrAsyncIterable<Phase8CalibrationScoreRecord>;
  readonly scoreSkips: SyncOrAsyncIterable<Phase8CalibrationScoreSkipRecord>;
  readonly terminalRiskPredictions: SyncOrAsyncIterable<Phase8CalibrationTerminalRiskPredictionRecord>;
  readonly terminalRiskScores: SyncOrAsyncIterable<Phase8CalibrationTerminalRiskScoreRecord>;
  readonly summary: Phase8CalibrationSummary;
}): Promise<Phase8CalibrationArtifactManifest> {
  verifyPhase8CalibrationPlan(input.plan);
  verifyPhase8CalibrationSummary(input.summary);
  if (
    input.summary.planSha256 !== input.plan.planSha256 ||
    input.summary.split !== input.plan.split
  ) {
    fail("summary provenance does not match the frozen plan.");
  }
  await mkdir(dirname(input.root), { recursive: true });
  await mkdir(input.root);
  const planFile = await writeExclusiveJson(input.root, PLAN_FILE, input.plan);
  const predictionsFile = await writeNdjson(
    input.root,
    PREDICTIONS_FILE,
    input.predictions,
    (value) => validatePhase8CalibrationPredictionRecord(value, input.plan),
  );
  const scoresFile = await writeNdjson(
    input.root,
    SCORES_FILE,
    input.scores,
    (value) => validatePhase8CalibrationScoreRecord(value, input.plan),
  );
  const scoreSkipsFile = await writeNdjson(
    input.root,
    SCORE_SKIPS_FILE,
    input.scoreSkips,
    (value) => validatePhase8CalibrationScoreSkipRecord(value, input.plan),
  );
  const terminalRiskPredictionsFile = await writeNdjson(
    input.root,
    TERMINAL_PREDICTIONS_FILE,
    input.terminalRiskPredictions,
    (value) =>
      validatePhase8CalibrationTerminalRiskPredictionRecord(value, input.plan),
  );
  const terminalRiskScoresFile = await writeNdjson(
    input.root,
    TERMINAL_SCORES_FILE,
    input.terminalRiskScores,
    (value) =>
      validatePhase8CalibrationTerminalRiskScoreRecord(value, input.plan),
  );
  const summaryFile = await writeExclusiveJson(
    input.root,
    SUMMARY_FILE,
    input.summary,
  );
  const withoutHash = {
    schemaVersion: 1 as const,
    artifactVersion: PHASE8_CALIBRATION_ARTIFACT_VERSION,
    protocolId: "eval-v1" as const,
    runId: input.plan.runId,
    split: input.plan.split,
    mode: input.plan.mode,
    evidenceClass: "phase8-clean-calibration" as const,
    evidenceEligible: input.summary.gates.evidenceEligible,
    manifestSha256: input.plan.manifestSha256,
    planSha256: input.plan.planSha256,
    sourceSha256: input.plan.sourceSha256,
    configurationRegistrySha256: input.plan.configurationRegistrySha256,
    selectedModelSerializedSha256: input.plan.selectedModelSerializedSha256,
    supportRegularizerSha256: input.plan.supportRegularizerSha256,
    scorerSha256: input.plan.scorerSha256,
    queryPlanSha256: input.plan.queryPlanSha256,
    reportSha256: input.plan.reportSha256,
    preregistrationSha256: input.plan.preregistrationSha256,
    files: {
      plan: planFile,
      predictions: predictionsFile,
      scores: scoresFile,
      scoreSkips: scoreSkipsFile,
      terminalRiskPredictions: terminalRiskPredictionsFile,
      terminalRiskScores: terminalRiskScoresFile,
      summary: summaryFile,
    },
    summarySha256: input.summary.summarySha256,
  };
  const manifest = phase8CalibrationArtifactManifestSchema.parse({
    ...withoutHash,
    artifactSha256: phase8Sha256(withoutHash),
  });
  await writeExclusiveJson(input.root, MANIFEST_FILE, manifest);
  return manifest;
}

async function readJson(path: string): Promise<unknown> {
  const serialized = await readFile(path, "utf8");
  try {
    return JSON.parse(serialized) as unknown;
  } catch (cause) {
    throw new Error(`Artifact JSON ${path} is invalid.`, { cause });
  }
}

type ReadNdjsonResult<T> = Readonly<{
  records: readonly T[];
  bytes: number;
  sha256: string;
}>;

async function readNdjson<T>(
  path: string,
  validate: (value: unknown) => T,
): Promise<ReadNdjsonResult<T>> {
  const records: T[] = [];
  const rawBytes = await readFile(path);
  const digest = createHash("sha256").update(rawBytes);
  const bytes = rawBytes.byteLength;
  if (
    rawBytes.includes(13) ||
    (bytes > 0 && rawBytes.at(-1) !== "\n".charCodeAt(0))
  ) {
    fail(`${path} must use canonical LF-terminated NDJSON.`);
  }
  let stream: ReadStream | null = null;
  try {
    stream = createReadStream(path);
    const lines = createInterface({
      input: stream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (line.length === 0) {
        fail(`${path} contains a blank NDJSON line.`);
      }
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (cause) {
        throw new Error(`Artifact NDJSON ${path} is invalid.`, { cause });
      }
      const record = validate(value);
      if (line !== stableStringify(record)) {
        fail(`${path} contains a non-canonical NDJSON record.`);
      }
      records.push(record);
    }
  } finally {
    stream?.close();
  }
  return {
    records: Object.freeze(records),
    bytes,
    sha256: digest.digest("hex"),
  };
}

function assertStoredFile(
  expected: StoredFile,
  actual: Readonly<{ records: number; bytes: number; sha256: string }>,
): void {
  if (
    actual.records !== expected.records ||
    actual.bytes !== expected.bytes ||
    actual.sha256 !== expected.sha256
  ) {
    fail(`stream ${expected.file} count, size, or checksum is invalid.`);
  }
}

export type Phase8CalibrationArtifactVerification = Readonly<{
  valid: boolean;
  issues: readonly string[];
  manifest: Phase8CalibrationArtifactManifest | null;
  summary: Phase8CalibrationSummary | null;
}>;

/**
 * Verifies immutable bytes, every record checksum/provenance binding, all
 * score joins, and a fresh deterministic summary derivation.
 */
export async function verifyPhase8CalibrationArtifact(input: {
  readonly root: string;
  readonly expectedPlan: Phase8CalibrationPlan;
}): Promise<Phase8CalibrationArtifactVerification> {
  try {
    verifyPhase8CalibrationPlan(input.expectedPlan);
    const manifest = phase8CalibrationArtifactManifestSchema.parse(
      await readJson(join(input.root, MANIFEST_FILE)),
    );
    const { artifactSha256, ...manifestWithoutHash } = manifest;
    if (
      artifactSha256 !== phase8Sha256(manifestProjection(manifestWithoutHash))
    ) {
      fail("artifact manifest checksum is invalid.");
    }
    if (
      manifest.planSha256 !== input.expectedPlan.planSha256 ||
      manifest.manifestSha256 !== input.expectedPlan.manifestSha256 ||
      manifest.split !== input.expectedPlan.split ||
      manifest.mode !== input.expectedPlan.mode
    ) {
      fail("artifact is bound to a different calibration plan.");
    }

    const planSerialized = await readFile(join(input.root, PLAN_FILE), "utf8");
    assertStoredFile(manifest.files.plan, {
      records: 1,
      bytes: Buffer.byteLength(planSerialized, "utf8"),
      sha256: sha256Text(planSerialized),
    });
    if (planSerialized !== serializeJson(input.expectedPlan)) {
      fail("serialized calibration plan differs from expected authority.");
    }

    const predictions = await readNdjson(
      join(input.root, PREDICTIONS_FILE),
      (value) =>
        validatePhase8CalibrationPredictionRecord(value, input.expectedPlan),
    );
    assertStoredFile(manifest.files.predictions, {
      records: predictions.records.length,
      bytes: predictions.bytes,
      sha256: predictions.sha256,
    });
    const scores = await readNdjson(join(input.root, SCORES_FILE), (value) =>
      validatePhase8CalibrationScoreRecord(value, input.expectedPlan),
    );
    assertStoredFile(manifest.files.scores, {
      records: scores.records.length,
      bytes: scores.bytes,
      sha256: scores.sha256,
    });
    const scoreSkips = await readNdjson(
      join(input.root, SCORE_SKIPS_FILE),
      (value) =>
        validatePhase8CalibrationScoreSkipRecord(value, input.expectedPlan),
    );
    assertStoredFile(manifest.files.scoreSkips, {
      records: scoreSkips.records.length,
      bytes: scoreSkips.bytes,
      sha256: scoreSkips.sha256,
    });
    const terminalPredictions = await readNdjson(
      join(input.root, TERMINAL_PREDICTIONS_FILE),
      (value) =>
        validatePhase8CalibrationTerminalRiskPredictionRecord(
          value,
          input.expectedPlan,
        ),
    );
    assertStoredFile(manifest.files.terminalRiskPredictions, {
      records: terminalPredictions.records.length,
      bytes: terminalPredictions.bytes,
      sha256: terminalPredictions.sha256,
    });
    const terminalScores = await readNdjson(
      join(input.root, TERMINAL_SCORES_FILE),
      (value) =>
        validatePhase8CalibrationTerminalRiskScoreRecord(
          value,
          input.expectedPlan,
        ),
    );
    assertStoredFile(manifest.files.terminalRiskScores, {
      records: terminalScores.records.length,
      bytes: terminalScores.bytes,
      sha256: terminalScores.sha256,
    });

    const summarySerialized = await readFile(
      join(input.root, SUMMARY_FILE),
      "utf8",
    );
    assertStoredFile(manifest.files.summary, {
      records: 1,
      bytes: Buffer.byteLength(summarySerialized, "utf8"),
      sha256: sha256Text(summarySerialized),
    });
    const storedSummary = JSON.parse(
      summarySerialized,
    ) as Phase8CalibrationSummary;
    verifyPhase8CalibrationSummary(storedSummary);
    const reproducedSummary = summarizePhase8Calibration({
      plan: input.expectedPlan,
      predictions: predictions.records,
      scores: scores.records,
      scoreSkips: scoreSkips.records,
      terminalRiskPredictions: terminalPredictions.records,
      terminalRiskScores: terminalScores.records,
    });
    if (
      serializeJson(storedSummary) !== serializeJson(reproducedSummary) ||
      manifest.summarySha256 !== reproducedSummary.summarySha256 ||
      manifest.evidenceEligible !== reproducedSummary.gates.evidenceEligible
    ) {
      fail("stored calibration summary does not reproduce from raw streams.");
    }
    return {
      valid: true,
      issues: [],
      manifest,
      summary: reproducedSummary,
    };
  } catch (cause) {
    return {
      valid: false,
      issues: [cause instanceof Error ? cause.message : String(cause)],
      manifest: null,
      summary: null,
    };
  }
}
