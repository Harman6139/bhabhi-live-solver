import { z } from "zod";

import { stableHash, stableStringify } from "../events/stable-hash";
import { SOLVER_BUDGET_IDS, type SolverBudgetId } from "../search";

export const PHASE8_LATENCY_SCHEMA_VERSION = 1 as const;
export const PHASE8_LATENCY_BENCHMARK_VERSION =
  "phase8-production-browser-latency-v1" as const;
export const PHASE8_LATENCY_CORPUS_VERSION =
  "phase8-latency-corpus-v1" as const;

export const LIVE_LATENCY_MODES = ["instant", "balanced", "deep"] as const;
export type LiveLatencyMode = (typeof LIVE_LATENCY_MODES)[number];

export const LATENCY_THRESHOLDS_MS = Object.freeze({
  deterministicEntryP95: 100,
  mainThreadLongTask: 50,
  instantValidResultP95: 750,
  balancedValidResultP95: 3_000,
  deepValidResultP95: 20_000,
});

export const LATENCY_RELEASE_MINIMUMS = Object.freeze({
  warmPerLiveMode: 1_000,
  coldPerLiveMode: 100,
  offline: 100,
  races: 1_000,
});

const identifierSchema = z.string().trim().min(1).max(512);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonnegativeIntegerSchema = z.int().nonnegative();
const positiveIntegerSchema = z.int().positive();
const finiteNonnegativeSchema = z.number().nonnegative();

export const latencySnapshotSchema = z
  .object({
    timelineArchive: z.string().min(1),
    timelineArchiveSha256: sha256Schema,
    stateVersion: nonnegativeIntegerSchema,
    historyHash: identifierSchema,
    publicStateHash: identifierSchema,
  })
  .strict();
export type LatencySnapshot = z.infer<typeof latencySnapshotSchema>;

export const latencyCorpusEntrySchema = z
  .object({
    entryId: identifierSchema,
    category: identifierSchema,
    analysis: latencySnapshotSchema,
    entryProbe: latencySnapshotSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.analysis.stateVersion === value.entryProbe.stateVersion &&
      value.analysis.historyHash === value.entryProbe.historyHash &&
      value.analysis.publicStateHash === value.entryProbe.publicStateHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["entryProbe"],
        message:
          "The deterministic entry probe must represent a distinct public snapshot.",
      });
    }
  });
export type LatencyCorpusEntry = z.infer<typeof latencyCorpusEntrySchema>;

const latencyCorpusBaseSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_LATENCY_SCHEMA_VERSION),
    corpusVersion: z.literal(PHASE8_LATENCY_CORPUS_VERSION),
    corpusId: identifierSchema,
    createdAt: z.iso.datetime(),
    split: z.enum(["train", "tune", "qualification", "final"]),
    phase8ManifestId: identifierSchema,
    phase8ManifestSha256: sha256Schema,
    protocolSha256: sha256Schema,
    candidateIndependent: z.literal(true),
    samplingPolicy: identifierSchema,
    entries: z.array(latencyCorpusEntrySchema).min(2),
    corpusSha256: sha256Schema,
  })
  .strict();

export const latencyCorpusSchema = latencyCorpusBaseSchema.superRefine(
  (value, context) => {
    const ids = value.entries.map((entry) => entry.entryId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Latency corpus entry IDs must be unique.",
      });
    }
    const canonical = [...ids].sort((left, right) => left.localeCompare(right));
    if (stableStringify(ids) !== stableStringify(canonical)) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Latency corpus entries must be in canonical entry-ID order.",
      });
    }
  },
);
export type LatencyCorpus = z.infer<typeof latencyCorpusSchema>;

export function latencyCorpusHashProjection(
  corpus: Omit<LatencyCorpus, "corpusSha256"> | LatencyCorpus,
): unknown {
  const { corpusSha256: _corpusSha256, ...projection } =
    corpus as LatencyCorpus;
  void _corpusSha256;
  return projection;
}

const liveCountsSchema = z
  .object({
    instant: nonnegativeIntegerSchema,
    balanced: nonnegativeIntegerSchema,
    deep: nonnegativeIntegerSchema,
  })
  .strict();

export const latencyScheduleSchema = z
  .object({
    evidenceEligible: z.boolean(),
    warmupPerLiveMode: nonnegativeIntegerSchema,
    warm: liveCountsSchema,
    cold: liveCountsSchema,
    offline: nonnegativeIntegerSchema,
    races: nonnegativeIntegerSchema,
    requestTimeoutMs: z
      .object({
        instant: positiveIntegerSchema,
        balanced: positiveIntegerSchema,
        deep: positiveIntegerSchema,
        offline: positiveIntegerSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.evidenceEligible) {
      return;
    }
    for (const mode of LIVE_LATENCY_MODES) {
      if (value.warm[mode] < LATENCY_RELEASE_MINIMUMS.warmPerLiveMode) {
        context.addIssue({
          code: "custom",
          path: ["warm", mode],
          message: `Evidence-eligible latency requires at least ${LATENCY_RELEASE_MINIMUMS.warmPerLiveMode.toString()} warm ${mode} requests.`,
        });
      }
      if (value.cold[mode] < LATENCY_RELEASE_MINIMUMS.coldPerLiveMode) {
        context.addIssue({
          code: "custom",
          path: ["cold", mode],
          message: `Evidence-eligible latency requires at least ${LATENCY_RELEASE_MINIMUMS.coldPerLiveMode.toString()} cold ${mode} starts.`,
        });
      }
    }
    if (value.offline < LATENCY_RELEASE_MINIMUMS.offline) {
      context.addIssue({
        code: "custom",
        path: ["offline"],
        message: `Evidence-eligible latency requires at least ${LATENCY_RELEASE_MINIMUMS.offline.toString()} Offline requests.`,
      });
    }
    if (value.races < LATENCY_RELEASE_MINIMUMS.races) {
      context.addIssue({
        code: "custom",
        path: ["races"],
        message: `Evidence-eligible latency requires at least ${LATENCY_RELEASE_MINIMUMS.races.toString()} invalidate/supersede races.`,
      });
    }
  });
export type LatencySchedule = z.infer<typeof latencyScheduleSchema>;

export function developmentLatencySchedule(): LatencySchedule {
  return latencyScheduleSchema.parse({
    evidenceEligible: false,
    warmupPerLiveMode: 1,
    warm: { instant: 3, balanced: 2, deep: 1 },
    cold: { instant: 2, balanced: 1, deep: 1 },
    offline: 1,
    races: 10,
    requestTimeoutMs: {
      instant: 10_000,
      balanced: 15_000,
      deep: 40_000,
      offline: 120_000,
    },
  });
}

export function releaseLatencySchedule(): LatencySchedule {
  return latencyScheduleSchema.parse({
    evidenceEligible: true,
    warmupPerLiveMode: 5,
    warm: {
      instant: LATENCY_RELEASE_MINIMUMS.warmPerLiveMode,
      balanced: LATENCY_RELEASE_MINIMUMS.warmPerLiveMode,
      deep: LATENCY_RELEASE_MINIMUMS.warmPerLiveMode,
    },
    cold: {
      instant: LATENCY_RELEASE_MINIMUMS.coldPerLiveMode,
      balanced: LATENCY_RELEASE_MINIMUMS.coldPerLiveMode,
      deep: LATENCY_RELEASE_MINIMUMS.coldPerLiveMode,
    },
    offline: LATENCY_RELEASE_MINIMUMS.offline,
    races: LATENCY_RELEASE_MINIMUMS.races,
    requestTimeoutMs: {
      instant: 10_000,
      balanced: 15_000,
      deep: 40_000,
      offline: 120_000,
    },
  });
}

export const metricObservationSchema = z
  .object({
    value: finiteNonnegativeSchema.nullable(),
    unit: z.enum(["milliseconds", "bytes"]),
    unavailableReason: z.string().trim().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.value === null) === (value.unavailableReason === null)) {
      context.addIssue({
        code: "custom",
        message:
          "A metric must contain either a value or an unavailable reason, but not both.",
      });
    }
  });
export type MetricObservation = z.infer<typeof metricObservationSchema>;

export function availableMetric(
  value: number,
  unit: MetricObservation["unit"],
): MetricObservation {
  return metricObservationSchema.parse({
    value,
    unit,
    unavailableReason: null,
  });
}

export function unavailableMetric(
  unit: MetricObservation["unit"],
  reason: string,
): MetricObservation {
  return metricObservationSchema.parse({
    value: null,
    unit,
    unavailableReason: reason,
  });
}

export const longTaskObservationSchema = z
  .object({
    supported: z.boolean(),
    thresholdMs: z.literal(LATENCY_THRESHOLDS_MS.mainThreadLongTask),
    count: nonnegativeIntegerSchema,
    totalDurationMs: finiteNonnegativeSchema,
    maxDurationMs: finiteNonnegativeSchema,
    unavailableReason: z.string().trim().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.supported && value.unavailableReason !== null) {
      context.addIssue({
        code: "custom",
        path: ["unavailableReason"],
        message: "Supported long-task observation cannot have a reason.",
      });
    }
    if (
      !value.supported &&
      (value.unavailableReason === null ||
        value.count !== 0 ||
        value.totalDurationMs !== 0 ||
        value.maxDurationMs !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Unsupported long-task observation must be zero-valued with a reason.",
      });
    }
  });
export type LongTaskObservation = z.infer<typeof longTaskObservationSchema>;

export const LATENCY_FAILURE_CODES = [
  "CORPUS_MISMATCH",
  "WORKER_FAILURE",
  "WORKER_EXCEPTION",
  "REQUEST_TIMEOUT",
  "UNEXPECTED_CANCELLATION",
  "RACE_OLD_NOT_CANCELLED",
  "RACE_CURRENT_NOT_SUCCESSFUL",
  "OBSOLETE_PUBLICATION",
  "IDENTITY_MISMATCH",
] as const;
export type LatencyFailureCode = (typeof LATENCY_FAILURE_CODES)[number];

const recordIdentitySchema = z
  .object({
    schemaVersion: z.literal(PHASE8_LATENCY_SCHEMA_VERSION),
    benchmarkVersion: z.literal(PHASE8_LATENCY_BENCHMARK_VERSION),
    runId: identifierSchema,
    measurementId: identifierSchema,
  })
  .strict();

export const requestLatencyRecordSchema = recordIdentitySchema
  .extend({
    recordType: z.literal("request-latency"),
    phase: z.enum(["warmup", "measured"]),
    mode: z.enum(SOLVER_BUDGET_IDS),
    temperature: z.enum(["warm", "cold"]),
    sampleIndex: nonnegativeIntegerSchema,
    corpusEntryId: identifierSchema,
    requestId: identifierSchema,
    status: z.enum([
      "success",
      "worker-failure",
      "cancelled",
      "timeout",
      "exception",
    ]),
    wallElapsedMs: finiteNonnegativeSchema,
    deterministicEntryElapsedMs: finiteNonnegativeSchema,
    solverElapsedMs: finiteNonnegativeSchema.nullable(),
    solverDeadlineMs: finiteNonnegativeSchema.nullable(),
    solverDeadlineExceeded: z.boolean().nullable(),
    payloadHash: identifierSchema.nullable(),
    workerFailureCode: identifierSchema.nullable(),
    cpuTime: metricObservationSchema,
    jsHeapBefore: metricObservationSchema,
    jsHeapAfter: metricObservationSchema,
    workerMemory: metricObservationSchema,
    processMemory: metricObservationSchema,
    longTasks: longTaskObservationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const successFieldsPresent =
      value.payloadHash !== null &&
      value.solverElapsedMs !== null &&
      value.solverDeadlineMs !== null &&
      value.solverDeadlineExceeded !== null;
    if (value.status === "success" && !successFieldsPresent) {
      context.addIssue({
        code: "custom",
        message: "Successful latency records require solver result fields.",
      });
    }
    if (
      value.status !== "success" &&
      (value.payloadHash !== null ||
        value.solverElapsedMs !== null ||
        value.solverDeadlineMs !== null ||
        value.solverDeadlineExceeded !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Unsuccessful latency records cannot contain result fields.",
      });
    }
    if (value.mode === "offline" && value.phase === "warmup") {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message: "Offline requests do not use the live-mode warmup phase.",
      });
    }
  });
export type RequestLatencyRecord = z.infer<typeof requestLatencyRecordSchema>;

export const raceLatencyRecordSchema = recordIdentitySchema
  .extend({
    recordType: z.literal("stale-race"),
    raceIndex: nonnegativeIntegerSchema,
    invalidationKind: z.enum(["supersede", "invalidate-then-restart"]),
    oldCorpusEntryId: identifierSchema,
    currentCorpusEntryId: identifierSchema,
    oldRequestId: identifierSchema,
    currentRequestId: identifierSchema,
    supersedeDelayMs: finiteNonnegativeSchema,
    wallElapsedMs: finiteNonnegativeSchema,
    oldOutcome: z.enum(["success", "failure", "cancelled"]),
    currentOutcome: z.enum(["success", "failure", "cancelled", "timeout"]),
    publishedRequestId: identifierSchema.nullable(),
    obsoleteResponseObserved: z.boolean(),
    obsoletePublicationCount: nonnegativeIntegerSchema,
    oldCancellationCount: z.union([z.literal(0), z.literal(1)]),
    currentPublicationCount: z.union([z.literal(0), z.literal(1)]),
    longTasks: longTaskObservationSchema,
  })
  .strict();
export type RaceLatencyRecord = z.infer<typeof raceLatencyRecordSchema>;

export const latencyRecordSchema = z.discriminatedUnion("recordType", [
  requestLatencyRecordSchema,
  raceLatencyRecordSchema,
]);
export type LatencyRecord = z.infer<typeof latencyRecordSchema>;

export const latencyFailureRecordSchema = recordIdentitySchema
  .extend({
    recordType: z.literal("latency-failure"),
    code: z.enum(LATENCY_FAILURE_CODES),
    stage: z.enum(["warmup", "request", "race"]),
    mode: z.enum(SOLVER_BUDGET_IDS).nullable(),
    sampleIndex: nonnegativeIntegerSchema,
    requestId: identifierSchema.nullable(),
    message: z.string().trim().min(1).max(8_192),
    workerFailureCode: identifierSchema.nullable(),
    deterministicFailureHash: identifierSchema,
  })
  .strict();
export type LatencyFailureRecord = z.infer<typeof latencyFailureRecordSchema>;

export type RaceOutcomeForAccounting = Readonly<{
  oldStatus: "success" | "failure" | "cancelled";
  oldRequestId: string;
  currentStatus: "success" | "failure" | "cancelled" | "timeout";
  currentRequestId: string;
  currentResponseRequestId: string | null;
}>;

export type RaceAccounting = Readonly<{
  publishedRequestId: string | null;
  obsoleteResponseObserved: boolean;
  obsoletePublicationCount: number;
  oldCancellationCount: 0 | 1;
  currentPublicationCount: 0 | 1;
}>;

export function accountStaleRace(
  input: RaceOutcomeForAccounting,
): RaceAccounting {
  const oldWouldBeObsolete =
    input.oldStatus === "success" &&
    input.oldRequestId !== input.currentRequestId;
  const currentCanPublish =
    input.currentStatus === "success" &&
    input.currentResponseRequestId === input.currentRequestId;
  const publishedRequestId = currentCanPublish ? input.currentRequestId : null;
  return Object.freeze({
    publishedRequestId,
    obsoleteResponseObserved: oldWouldBeObsolete,
    // Publication always goes through the active-identity guard. An observed
    // obsolete response is reported separately and is never counted as a
    // publication.
    obsoletePublicationCount: 0,
    oldCancellationCount: input.oldStatus === "cancelled" ? 1 : 0,
    currentPublicationCount: currentCanPublish ? 1 : 0,
  });
}

export type DistributionSummary = Readonly<{
  samples: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}>;

export function nearestRankPercentile(
  values: readonly number[],
  quantile: number,
): number {
  if (values.length === 0) {
    throw new RangeError("Cannot compute a percentile from an empty sample.");
  }
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) {
    throw new RangeError("Quantile must be finite and in (0, 1].");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("Nearest-rank percentile selected no observation.");
  }
  return value;
}

export function summarizeDistribution(
  values: readonly number[],
): DistributionSummary {
  if (values.length === 0) {
    throw new RangeError("Cannot summarize an empty distribution.");
  }
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(
        "Distributions require finite nonnegative observations.",
      );
    }
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    samples: values.length,
    min: Math.min(...values),
    mean: total / values.length,
    p50: nearestRankPercentile(values, 0.5),
    p95: nearestRankPercentile(values, 0.95),
    p99: nearestRankPercentile(values, 0.99),
    max: Math.max(...values),
  });
}

const distributionSummarySchema = z
  .object({
    samples: positiveIntegerSchema,
    min: finiteNonnegativeSchema,
    mean: finiteNonnegativeSchema,
    p50: finiteNonnegativeSchema,
    p95: finiteNonnegativeSchema,
    p99: finiteNonnegativeSchema,
    max: finiteNonnegativeSchema,
  })
  .strict();

const metricAvailabilitySummarySchema = z
  .object({
    availableSamples: nonnegativeIntegerSchema,
    unavailableSamples: nonnegativeIntegerSchema,
    distribution: distributionSummarySchema.nullable(),
    unavailableReasons: z.array(identifierSchema),
  })
  .strict();

const bucketSummarySchema = z
  .object({
    mode: z.enum(SOLVER_BUDGET_IDS),
    temperature: z.enum(["warm", "cold"]),
    expected: nonnegativeIntegerSchema,
    attempted: nonnegativeIntegerSchema,
    successful: nonnegativeIntegerSchema,
    failed: nonnegativeIntegerSchema,
    wall: distributionSummarySchema.nullable(),
    solver: distributionSummarySchema.nullable(),
    entry: distributionSummarySchema.nullable(),
    cpu: metricAvailabilitySummarySchema,
    jsHeapAfter: metricAvailabilitySummarySchema,
    solverDeadlineExceeded: nonnegativeIntegerSchema,
    payloadHashes: z.array(identifierSchema),
  })
  .strict();

export const latencySummarySchema = z
  .object({
    schemaVersion: z.literal(PHASE8_LATENCY_SCHEMA_VERSION),
    benchmarkVersion: z.literal(PHASE8_LATENCY_BENCHMARK_VERSION),
    runId: identifierSchema,
    phase8ManifestId: identifierSchema,
    phase8ManifestSha256: sha256Schema,
    corpusId: identifierSchema,
    corpusSha256: sha256Schema,
    configId: identifierSchema,
    evidenceEligible: z.boolean(),
    expectedMeasuredRequests: nonnegativeIntegerSchema,
    attemptedMeasuredRequests: nonnegativeIntegerSchema,
    successfulMeasuredRequests: nonnegativeIntegerSchema,
    failedMeasuredRequests: nonnegativeIntegerSchema,
    warmup: z
      .object({
        expected: nonnegativeIntegerSchema,
        attempted: nonnegativeIntegerSchema,
        successful: nonnegativeIntegerSchema,
      })
      .strict(),
    buckets: z.array(bucketSummarySchema).length(7),
    deterministicEntry: distributionSummarySchema.nullable(),
    longTasks: z
      .object({
        supportedRecords: nonnegativeIntegerSchema,
        unsupportedRecords: nonnegativeIntegerSchema,
        countOver50Ms: nonnegativeIntegerSchema,
        totalDurationMs: finiteNonnegativeSchema,
        maxDurationMs: finiteNonnegativeSchema,
        unavailableReasons: z.array(identifierSchema),
      })
      .strict(),
    races: z
      .object({
        expected: nonnegativeIntegerSchema,
        attempted: nonnegativeIntegerSchema,
        oldCancelled: nonnegativeIntegerSchema,
        currentPublished: nonnegativeIntegerSchema,
        obsoleteResponsesObserved: nonnegativeIntegerSchema,
        obsoletePublications: nonnegativeIntegerSchema,
      })
      .strict(),
    memory: z
      .object({
        jsHeapMaxObservedBytes: finiteNonnegativeSchema.nullable(),
        jsHeapUnavailableReasons: z.array(identifierSchema),
        workerMemoryBytes: z.null(),
        workerMemoryUnavailableReasons: z.array(identifierSchema).min(1),
        processMemoryBytes: z.null(),
        processMemoryUnavailableReasons: z.array(identifierSchema).min(1),
      })
      .strict(),
    failures: z
      .object({
        total: nonnegativeIntegerSchema,
        byCode: z.record(
          z.enum(LATENCY_FAILURE_CODES),
          nonnegativeIntegerSchema,
        ),
      })
      .strict(),
    thresholdsMs: z
      .object({
        deterministicEntryP95: z.literal(
          LATENCY_THRESHOLDS_MS.deterministicEntryP95,
        ),
        mainThreadLongTask: z.literal(LATENCY_THRESHOLDS_MS.mainThreadLongTask),
        instantValidResultP95: z.literal(
          LATENCY_THRESHOLDS_MS.instantValidResultP95,
        ),
        balancedValidResultP95: z.literal(
          LATENCY_THRESHOLDS_MS.balancedValidResultP95,
        ),
        deepValidResultP95: z.literal(LATENCY_THRESHOLDS_MS.deepValidResultP95),
      })
      .strict(),
    gate: z
      .object({
        releaseMinimumsPass: z.boolean(),
        completeCountsPass: z.boolean(),
        zeroFailuresPass: z.boolean(),
        deterministicEntryP95Pass: z.boolean(),
        longTaskObservationSupported: z.boolean(),
        zeroLongTasksOver50MsPass: z.boolean(),
        instantP95Pass: z.boolean(),
        balancedP95Pass: z.boolean(),
        deepP95Pass: z.boolean(),
        zeroObsoletePublicationsPass: z.boolean(),
        allOldRequestsCancelledPass: z.boolean(),
        allCurrentRequestsPublishedPass: z.boolean(),
        operationalPass: z.boolean(),
        evidenceGatePass: z.boolean(),
      })
      .strict(),
    reproductionDigest: identifierSchema,
  })
  .strict();
export type LatencySummary = z.infer<typeof latencySummarySchema>;

export type LatencySummaryBinding = Readonly<{
  runId: string;
  phase8ManifestId: string;
  phase8ManifestSha256: string;
  corpusId: string;
  corpusSha256: string;
  configId: string;
  schedule: LatencySchedule;
}>;

type BucketCoordinate = Readonly<{
  mode: SolverBudgetId;
  temperature: "warm" | "cold";
}>;

const BUCKET_COORDINATES: readonly BucketCoordinate[] = Object.freeze([
  { mode: "instant", temperature: "warm" },
  { mode: "balanced", temperature: "warm" },
  { mode: "deep", temperature: "warm" },
  { mode: "instant", temperature: "cold" },
  { mode: "balanced", temperature: "cold" },
  { mode: "deep", temperature: "cold" },
  { mode: "offline", temperature: "warm" },
]);

function expectedBucketCount(
  schedule: LatencySchedule,
  coordinate: BucketCoordinate,
): number {
  if (coordinate.mode === "offline") {
    return coordinate.temperature === "warm" ? schedule.offline : 0;
  }
  return schedule[coordinate.temperature][coordinate.mode];
}

function maybeDistribution(
  values: readonly number[],
): DistributionSummary | null {
  return values.length === 0 ? null : summarizeDistribution(values);
}

function metricAvailability(
  metrics: readonly MetricObservation[],
): z.infer<typeof metricAvailabilitySummarySchema> {
  const values = metrics.flatMap((metric) =>
    metric.value === null ? [] : [metric.value],
  );
  const reasons = [
    ...new Set(
      metrics.flatMap((metric) =>
        metric.unavailableReason === null ? [] : [metric.unavailableReason],
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return {
    availableSamples: values.length,
    unavailableSamples: metrics.length - values.length,
    distribution: maybeDistribution(values),
    unavailableReasons: reasons,
  };
}

function releaseMinimumsPass(schedule: LatencySchedule): boolean {
  return (
    LIVE_LATENCY_MODES.every(
      (mode) =>
        schedule.warm[mode] >= LATENCY_RELEASE_MINIMUMS.warmPerLiveMode &&
        schedule.cold[mode] >= LATENCY_RELEASE_MINIMUMS.coldPerLiveMode,
    ) &&
    schedule.offline >= LATENCY_RELEASE_MINIMUMS.offline &&
    schedule.races >= LATENCY_RELEASE_MINIMUMS.races
  );
}

function failureCounts(
  failures: readonly LatencyFailureRecord[],
): Record<LatencyFailureCode, number> {
  return Object.fromEntries(
    LATENCY_FAILURE_CODES.map((code) => [
      code,
      failures.filter((failure) => failure.code === code).length,
    ]),
  ) as Record<LatencyFailureCode, number>;
}

function bucketP95(
  buckets: readonly z.infer<typeof bucketSummarySchema>[],
  mode: LiveLatencyMode,
): number | null {
  return (
    buckets.find(
      (bucket) => bucket.mode === mode && bucket.temperature === "warm",
    )?.wall?.p95 ?? null
  );
}

export function createLatencySummary(input: {
  readonly binding: LatencySummaryBinding;
  readonly records: readonly LatencyRecord[];
  readonly failures: readonly LatencyFailureRecord[];
}): LatencySummary {
  const schedule = latencyScheduleSchema.parse(input.binding.schedule);
  const records = input.records.map((record) =>
    latencyRecordSchema.parse(record),
  );
  const failures = input.failures.map((failure) =>
    latencyFailureRecordSchema.parse(failure),
  );
  const requestRecords = records.filter(
    (record): record is RequestLatencyRecord =>
      record.recordType === "request-latency",
  );
  const measured = requestRecords.filter(
    (record) => record.phase === "measured",
  );
  const warmup = requestRecords.filter((record) => record.phase === "warmup");
  const races = records.filter(
    (record): record is RaceLatencyRecord => record.recordType === "stale-race",
  );

  const buckets = BUCKET_COORDINATES.map((coordinate) => {
    const bucketRecords = measured.filter(
      (record) =>
        record.mode === coordinate.mode &&
        record.temperature === coordinate.temperature,
    );
    const successful = bucketRecords.filter(
      (record) => record.status === "success",
    );
    return {
      mode: coordinate.mode,
      temperature: coordinate.temperature,
      expected: expectedBucketCount(schedule, coordinate),
      attempted: bucketRecords.length,
      successful: successful.length,
      failed: bucketRecords.length - successful.length,
      wall: maybeDistribution(successful.map((record) => record.wallElapsedMs)),
      solver: maybeDistribution(
        successful.flatMap((record) =>
          record.solverElapsedMs === null ? [] : [record.solverElapsedMs],
        ),
      ),
      entry: maybeDistribution(
        bucketRecords.map((record) => record.deterministicEntryElapsedMs),
      ),
      cpu: metricAvailability(bucketRecords.map((record) => record.cpuTime)),
      jsHeapAfter: metricAvailability(
        bucketRecords.map((record) => record.jsHeapAfter),
      ),
      solverDeadlineExceeded: successful.filter(
        (record) => record.solverDeadlineExceeded === true,
      ).length,
      payloadHashes: [
        ...new Set(
          successful.flatMap((record) =>
            record.payloadHash === null ? [] : [record.payloadHash],
          ),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    };
  });

  const expectedMeasuredRequests =
    Object.values(schedule.warm).reduce((total, count) => total + count, 0) +
    Object.values(schedule.cold).reduce((total, count) => total + count, 0) +
    schedule.offline;
  const expectedWarmup = schedule.warmupPerLiveMode * LIVE_LATENCY_MODES.length;
  const successfulMeasured = measured.filter(
    (record) => record.status === "success",
  ).length;
  const allLongTasks = records.map((record) => record.longTasks);
  const unsupportedReasons = [
    ...new Set(
      allLongTasks.flatMap((observation) =>
        observation.unavailableReason === null
          ? []
          : [observation.unavailableReason],
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const entryDistribution = maybeDistribution(
    measured.map((record) => record.deterministicEntryElapsedMs),
  );
  const jsHeapValues = measured.flatMap((record) => {
    const before = record.jsHeapBefore.value;
    const after = record.jsHeapAfter.value;
    return [before, after].filter((value): value is number => value !== null);
  });
  const jsHeapReasons = [
    ...new Set(
      measured.flatMap((record) => [
        ...(record.jsHeapBefore.unavailableReason === null
          ? []
          : [record.jsHeapBefore.unavailableReason]),
        ...(record.jsHeapAfter.unavailableReason === null
          ? []
          : [record.jsHeapAfter.unavailableReason]),
      ]),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const workerReasons = [
    ...new Set(
      measured.flatMap((record) =>
        record.workerMemory.unavailableReason === null
          ? []
          : [record.workerMemory.unavailableReason],
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const processReasons = [
    ...new Set(
      measured.flatMap((record) =>
        record.processMemory.unavailableReason === null
          ? []
          : [record.processMemory.unavailableReason],
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));

  const completeCountsPass =
    measured.length === expectedMeasuredRequests &&
    warmup.length === expectedWarmup &&
    races.length === schedule.races &&
    buckets.every((bucket) => bucket.attempted === bucket.expected);
  const zeroFailuresPass = failures.length === 0;
  const deterministicEntryP95Pass =
    entryDistribution !== null &&
    entryDistribution.p95 <= LATENCY_THRESHOLDS_MS.deterministicEntryP95;
  const longTaskObservationSupported =
    allLongTasks.length > 0 &&
    allLongTasks.every((observation) => observation.supported);
  const longTaskCount = allLongTasks.reduce(
    (total, observation) => total + observation.count,
    0,
  );
  const zeroLongTasksOver50MsPass =
    longTaskObservationSupported && longTaskCount === 0;
  const instantP95 = bucketP95(buckets, "instant");
  const balancedP95 = bucketP95(buckets, "balanced");
  const deepP95 = bucketP95(buckets, "deep");
  const instantP95Pass =
    instantP95 !== null &&
    instantP95 <= LATENCY_THRESHOLDS_MS.instantValidResultP95;
  const balancedP95Pass =
    balancedP95 !== null &&
    balancedP95 <= LATENCY_THRESHOLDS_MS.balancedValidResultP95;
  const deepP95Pass =
    deepP95 !== null && deepP95 <= LATENCY_THRESHOLDS_MS.deepValidResultP95;
  const obsoletePublications = races.reduce(
    (total, race) => total + race.obsoletePublicationCount,
    0,
  );
  const oldCancelled = races.reduce(
    (total, race) => total + race.oldCancellationCount,
    0,
  );
  const currentPublished = races.reduce(
    (total, race) => total + race.currentPublicationCount,
    0,
  );
  const zeroObsoletePublicationsPass = obsoletePublications === 0;
  const allOldRequestsCancelledPass =
    oldCancelled === schedule.races && races.length === schedule.races;
  const allCurrentRequestsPublishedPass =
    currentPublished === schedule.races && races.length === schedule.races;
  const releaseCountsPass = releaseMinimumsPass(schedule);
  const operationalPass = [
    completeCountsPass,
    zeroFailuresPass,
    deterministicEntryP95Pass,
    longTaskObservationSupported,
    zeroLongTasksOver50MsPass,
    instantP95Pass,
    balancedP95Pass,
    deepP95Pass,
    zeroObsoletePublicationsPass,
    allOldRequestsCancelledPass,
    allCurrentRequestsPublishedPass,
  ].every(Boolean);
  const summaryWithoutDigest = {
    schemaVersion: PHASE8_LATENCY_SCHEMA_VERSION,
    benchmarkVersion: PHASE8_LATENCY_BENCHMARK_VERSION,
    runId: input.binding.runId,
    phase8ManifestId: input.binding.phase8ManifestId,
    phase8ManifestSha256: input.binding.phase8ManifestSha256,
    corpusId: input.binding.corpusId,
    corpusSha256: input.binding.corpusSha256,
    configId: input.binding.configId,
    evidenceEligible: schedule.evidenceEligible,
    expectedMeasuredRequests,
    attemptedMeasuredRequests: measured.length,
    successfulMeasuredRequests: successfulMeasured,
    failedMeasuredRequests: measured.length - successfulMeasured,
    warmup: {
      expected: expectedWarmup,
      attempted: warmup.length,
      successful: warmup.filter((record) => record.status === "success").length,
    },
    buckets,
    deterministicEntry: entryDistribution,
    longTasks: {
      supportedRecords: allLongTasks.filter(
        (observation) => observation.supported,
      ).length,
      unsupportedRecords: allLongTasks.filter(
        (observation) => !observation.supported,
      ).length,
      countOver50Ms: longTaskCount,
      totalDurationMs: allLongTasks.reduce(
        (total, observation) => total + observation.totalDurationMs,
        0,
      ),
      maxDurationMs: Math.max(
        0,
        ...allLongTasks.map((observation) => observation.maxDurationMs),
      ),
      unavailableReasons: unsupportedReasons,
    },
    races: {
      expected: schedule.races,
      attempted: races.length,
      oldCancelled,
      currentPublished,
      obsoleteResponsesObserved: races.filter(
        (race) => race.obsoleteResponseObserved,
      ).length,
      obsoletePublications,
    },
    memory: {
      jsHeapMaxObservedBytes:
        jsHeapValues.length === 0 ? null : Math.max(...jsHeapValues),
      jsHeapUnavailableReasons: jsHeapReasons,
      workerMemoryBytes: null,
      workerMemoryUnavailableReasons:
        workerReasons.length === 0
          ? ["Dedicated-worker memory attribution was not recorded."]
          : workerReasons,
      processMemoryBytes: null,
      processMemoryUnavailableReasons:
        processReasons.length === 0
          ? ["Browser-process memory attribution was not recorded."]
          : processReasons,
    },
    failures: {
      total: failures.length,
      byCode: failureCounts(failures),
    },
    thresholdsMs: LATENCY_THRESHOLDS_MS,
    gate: {
      releaseMinimumsPass: releaseCountsPass,
      completeCountsPass,
      zeroFailuresPass,
      deterministicEntryP95Pass,
      longTaskObservationSupported,
      zeroLongTasksOver50MsPass,
      instantP95Pass,
      balancedP95Pass,
      deepP95Pass,
      zeroObsoletePublicationsPass,
      allOldRequestsCancelledPass,
      allCurrentRequestsPublishedPass,
      operationalPass,
      evidenceGatePass:
        schedule.evidenceEligible && releaseCountsPass && operationalPass,
    },
  } as const;
  return latencySummarySchema.parse({
    ...summaryWithoutDigest,
    reproductionDigest: stableHash(summaryWithoutDigest),
  });
}
