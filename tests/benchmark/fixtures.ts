import {
  latencyScheduleSchema,
  requestLatencyRecordSchema,
  raceLatencyRecordSchema,
  unavailableMetric,
  availableMetric,
  type LatencyRecord,
  type LatencySchedule,
  type LatencyCorpus,
} from "../../src/benchmark";
import {
  createLatencyCorpus,
  createLatencyRunManifest,
  createLatencySnapshot,
  latencyEnvironmentSchema,
  type LatencyEnvironment,
  type LatencyRunManifest,
} from "../../src/benchmark/node";
import {
  createPhase8ConfigurationDescriptor,
  freezePhase8Manifest,
  phase8Sha256,
  type Phase8Manifest,
} from "../../src/evaluation/phase8-manifest";
import type { SolverBudgetId } from "../../src/search";
import { temporalTimeline } from "../inference/test-fixtures";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);
const RUN_ID = "phase8-latency-test";

export function fixtureSchedule(): LatencySchedule {
  return latencyScheduleSchema.parse({
    evidenceEligible: false,
    warmupPerLiveMode: 1,
    warm: { instant: 1, balanced: 1, deep: 1 },
    cold: { instant: 1, balanced: 1, deep: 1 },
    offline: 1,
    races: 1,
    requestTimeoutMs: {
      instant: 10_000,
      balanced: 15_000,
      deep: 40_000,
      offline: 120_000,
    },
  });
}

export function fixturePhase8Manifest(): Phase8Manifest {
  const configuration = createPhase8ConfigurationDescriptor({
    configId: "p8-r-hard-balanced-v1",
    label: "Reference",
    role: "reference",
    budgetId: "balanced",
    components: {
      exactEndgame: false,
      behaviorWeighting: false,
    },
    implementation: {
      executionPath: "production-worker-reference-v1",
    },
  });
  return freezePhase8Manifest({
    manifestId: "phase8-latency-manifest-test",
    createdAt: "2026-07-28T12:00:00.000Z",
    sourceSha256: SHA_A,
    sourceFileCount: 42,
    modelSha256: SHA_B,
    scorerSha256: SHA_C,
    reportSha256: SHA_D,
    preregistrationSha256: SHA_E,
    qualificationSampleSize: {
      verifiedDevelopmentVarianceArtifactSha256: SHA_F,
      maxPairedClusterStandardDeviation: 0,
    },
    configurations: [configuration],
    splits: {
      train: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      tune: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      qualification: {
        baseIndexStart: 0,
        eventCap: 4_096,
      },
    },
  }).manifest;
}

export function fixtureCorpus(
  manifest: Phase8Manifest = fixturePhase8Manifest(),
): LatencyCorpus {
  const analysis = createLatencySnapshot(temporalTimeline(3));
  const entryProbe = createLatencySnapshot(temporalTimeline(4));
  return createLatencyCorpus({
    corpusId: "phase8-latency-corpus-test",
    createdAt: "2026-07-28T12:30:00.000Z",
    split: "qualification",
    phase8ManifestId: manifest.manifestId,
    phase8ManifestSha256: phase8Sha256(manifest),
    protocolSha256: SHA_F,
    samplingPolicy: "fixed-candidate-independent-test-snapshots",
    entries: [
      {
        entryId: "entry-a",
        category: "normal-user-turn",
        analysis,
        entryProbe,
      },
      {
        entryId: "entry-b",
        category: "correction-probe",
        analysis,
        entryProbe,
      },
    ],
  });
}

const LONG_TASKS = {
  supported: true as const,
  thresholdMs: 50 as const,
  count: 0,
  totalDurationMs: 0,
  maxDurationMs: 0,
  unavailableReason: null,
};

function deadline(mode: SolverBudgetId): number {
  switch (mode) {
    case "instant":
      return 500;
    case "balanced":
      return 2_500;
    case "deep":
      return 15_000;
    case "offline":
      return 60_000;
  }
}

function requestRecord(input: {
  readonly phase: "warmup" | "measured";
  readonly mode: SolverBudgetId;
  readonly temperature: "warm" | "cold";
  readonly sampleIndex: number;
}): LatencyRecord {
  const measurementId = [
    "request",
    input.phase,
    input.temperature,
    input.mode,
    input.sampleIndex.toString(),
  ].join("/");
  return requestLatencyRecordSchema.parse({
    schemaVersion: 1,
    benchmarkVersion: "phase8-production-browser-latency-v1",
    runId: RUN_ID,
    measurementId,
    recordType: "request-latency",
    phase: input.phase,
    mode: input.mode,
    temperature: input.temperature,
    sampleIndex: input.sampleIndex,
    corpusEntryId: "entry-a",
    requestId: `request-${measurementId}`,
    status: "success",
    wallElapsedMs:
      input.mode === "deep" ? 30 : input.mode === "balanced" ? 20 : 10,
    deterministicEntryElapsedMs: 2,
    solverElapsedMs: 5,
    solverDeadlineMs: deadline(input.mode),
    solverDeadlineExceeded: false,
    payloadHash: `payload-${measurementId}`,
    workerFailureCode: null,
    cpuTime: unavailableMetric(
      "milliseconds",
      "Worker CPU attribution unavailable.",
    ),
    jsHeapBefore: availableMetric(1_000, "bytes"),
    jsHeapAfter: availableMetric(1_100, "bytes"),
    workerMemory: unavailableMetric(
      "bytes",
      "Worker memory attribution unavailable.",
    ),
    processMemory: unavailableMetric(
      "bytes",
      "Process memory attribution unavailable.",
    ),
    longTasks: LONG_TASKS,
  });
}

export function fixtureRecords(): LatencyRecord[] {
  const records: LatencyRecord[] = [];
  for (const mode of ["instant", "balanced", "deep"] as const) {
    records.push(
      requestRecord({
        phase: "warmup",
        mode,
        temperature: "warm",
        sampleIndex: 0,
      }),
    );
    records.push(
      requestRecord({
        phase: "measured",
        mode,
        temperature: "warm",
        sampleIndex: 0,
      }),
    );
    records.push(
      requestRecord({
        phase: "measured",
        mode,
        temperature: "cold",
        sampleIndex: 0,
      }),
    );
  }
  records.push(
    requestRecord({
      phase: "measured",
      mode: "offline",
      temperature: "warm",
      sampleIndex: 0,
    }),
  );
  records.push(
    raceLatencyRecordSchema.parse({
      schemaVersion: 1,
      benchmarkVersion: "phase8-production-browser-latency-v1",
      runId: RUN_ID,
      measurementId: "race/0",
      recordType: "stale-race",
      raceIndex: 0,
      invalidationKind: "supersede",
      oldCorpusEntryId: "entry-a",
      currentCorpusEntryId: "entry-b",
      oldRequestId: "request-old",
      currentRequestId: "request-current",
      supersedeDelayMs: 1,
      wallElapsedMs: 10,
      oldOutcome: "cancelled",
      currentOutcome: "success",
      publishedRequestId: "request-current",
      obsoleteResponseObserved: false,
      obsoletePublicationCount: 0,
      oldCancellationCount: 1,
      currentPublicationCount: 1,
      longTasks: LONG_TASKS,
    }),
  );
  return records;
}

export function fixtureRunManifest(
  manifest: Phase8Manifest = fixturePhase8Manifest(),
  corpus: LatencyCorpus = fixtureCorpus(manifest),
  schedule: LatencySchedule = fixtureSchedule(),
): LatencyRunManifest {
  const configuration = manifest.configurations[0];
  if (configuration === undefined) {
    throw new Error("Fixture manifest has no configuration.");
  }
  return createLatencyRunManifest({
    runId: RUN_ID,
    createdAt: "2026-07-28T13:00:00.000Z",
    phase8Manifest: manifest,
    configId: configuration.configId,
    corpus,
    schedule,
    binding: {
      bundleMode: "evaluation-only",
      manifestScope: "qualification",
      manifestHash: phase8Sha256(manifest),
      sourceHash: manifest.hashes.sourceSha256,
      solverConfigHash: configuration.configSha256,
      modelHash: manifest.hashes.modelSha256,
      protocolHash: corpus.protocolSha256,
      selectedConfigId: configuration.configId,
      selectionAttestationHash: null,
      finalAttestationHash: null,
    },
    productionBuild: {
      sha256: SHA_A,
      fileCount: 3,
      latencyPageSha256: SHA_B,
      sourceMapIncluded: true,
    },
    command: "npm run bench:latency -- --run-id phase8-latency-test",
  });
}

function browserEnvironment() {
  return {
    schemaVersion: 1 as const,
    userAgent: "fixture chromium",
    browserLanguage: "en-US",
    browserLanguages: ["en-US"],
    timezone: "America/New_York",
    screen: {
      width: 1_440,
      height: 900,
      availableWidth: 1_440,
      availableHeight: 860,
      colorDepth: 24,
      pixelDepth: 24,
    },
    devicePixelRatio: 1,
    hardwareConcurrency: 8,
    deviceMemoryGiB: 8,
    visibilityState: "visible" as const,
    documentHasFocus: true,
    crossOriginIsolated: true,
    longTaskObserverSupported: true,
    performanceMemorySupported: true,
    userAgentSpecificMemorySupported: false,
    userAgentSpecificMemory: unavailableMetric(
      "bytes",
      "Fixture API unavailable.",
    ),
  };
}

export function fixtureEnvironment(): LatencyEnvironment {
  return latencyEnvironmentSchema.parse({
    schemaVersion: 1,
    capturedAtStart: "2026-07-28T13:00:00.000Z",
    capturedAtEnd: "2026-07-28T13:01:00.000Z",
    platform: "win32",
    release: "fixture",
    architecture: "x64",
    cpuModel: "fixture cpu",
    logicalCpus: 8,
    totalMemoryBytes: 8_000_000_000,
    freeMemoryBytesAtStart: 4_000_000_000,
    freeMemoryBytesAtEnd: 3_900_000_000,
    nodeVersion: "v22.13.0",
    timezone: "America/New_York",
    powerMode: "best-performance",
    powerSource: "AC",
    backgroundLoadPolicy: "fixture controlled idle",
    workerCount: 1,
    browserEngine: "chromium",
    browserVersion: "fixture",
    headless: true,
    coldStartDefinition:
      "fresh-production-document-reload-and-fresh-dedicated-worker",
    warmDefinition:
      "warmed-production-document-and-module-cache-with-fresh-dedicated-worker-per-request",
    browserAtStart: browserEnvironment(),
    browserAtEnd: browserEnvironment(),
    nodeHarnessRssMaxObservedBytes: 100_000_000,
    browserProcessMemoryBytes: null,
    browserProcessMemoryUnavailableReason: "Fixture unavailable.",
    dedicatedWorkerMemoryBytes: null,
    dedicatedWorkerMemoryUnavailableReason: "Fixture unavailable.",
    dedicatedWorkerCpuTimeMs: null,
    dedicatedWorkerCpuTimeUnavailableReason: "Fixture unavailable.",
  });
}

export const FIXTURE_RUN_ID = RUN_ID;
