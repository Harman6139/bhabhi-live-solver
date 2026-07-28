import { stableHash, stableStringify } from "../events/stable-hash";
import {
  importGameArchive,
  replayTimeline,
  type GameTimeline,
} from "../events/timeline";
import type { SolverBudgetId } from "../search";
import {
  AnalysisWorkerClient,
  createAnalysisWorkerRequest,
  createBrowserEvaluationAnalysisWorker,
  type AnalysisBinding,
  type AnalysisClientOutcome,
  type AnalysisWorkerLike,
} from "../worker";
import {
  LATENCY_THRESHOLDS_MS,
  PHASE8_LATENCY_BENCHMARK_VERSION,
  PHASE8_LATENCY_SCHEMA_VERSION,
  accountStaleRace,
  availableMetric,
  latencyCorpusHashProjection,
  latencyCorpusSchema,
  latencyFailureRecordSchema,
  longTaskObservationSchema,
  requestLatencyRecordSchema,
  raceLatencyRecordSchema,
  unavailableMetric,
  type LatencyCorpus,
  type LatencyCorpusEntry,
  type LatencyFailureCode,
  type LatencyFailureRecord,
  type LatencyRecord,
  type LatencySnapshot,
  type LongTaskObservation,
  type MetricObservation,
  type RaceLatencyRecord,
  type RequestLatencyRecord,
} from "./latency-contract";

const CPU_UNAVAILABLE_REASON =
  "Dedicated-worker CPU time is not attributable through the browser Performance APIs.";
const WORKER_MEMORY_UNAVAILABLE_REASON =
  "Per-dedicated-worker memory is not attributable through the browser Performance APIs.";
const PROCESS_MEMORY_UNAVAILABLE_REASON =
  "Browser-process memory is not exposed to page JavaScript.";
const JS_HEAP_UNAVAILABLE_REASON =
  "performance.memory.usedJSHeapSize is unavailable in this browser.";
const LONG_TASK_UNAVAILABLE_REASON =
  "PerformanceObserver does not support the longtask entry type.";

type MaterializedSnapshot = Readonly<{
  descriptor: LatencySnapshot;
  timeline: GameTimeline;
}>;

type MaterializedEntry = Readonly<{
  descriptor: LatencyCorpusEntry;
  analysis: MaterializedSnapshot;
  entryProbe: MaterializedSnapshot;
}>;

export type BrowserLatencyInitialization = Readonly<{
  runId: string;
  corpus: LatencyCorpus;
  configId: string;
  binding: AnalysisBinding;
}>;

export type BrowserRequestBatch = Readonly<{
  phase: "warmup" | "measured";
  mode: SolverBudgetId;
  temperature: "warm" | "cold";
  count: number;
  sampleIndexStart: number;
  requestOrdinalBase: number;
  timeoutMs: number;
}>;

export type BrowserRaceBatch = Readonly<{
  count: number;
  raceIndexStart: number;
  requestOrdinalBase: number;
  timeoutMs: number;
}>;

export type BrowserLatencyBatchResult = Readonly<{
  records: readonly LatencyRecord[];
  failures: readonly LatencyFailureRecord[];
}>;

export type BrowserLatencyEnvironment = Readonly<{
  schemaVersion: 1;
  userAgent: string;
  browserLanguage: string;
  browserLanguages: readonly string[];
  timezone: string;
  screen: Readonly<{
    width: number;
    height: number;
    availableWidth: number;
    availableHeight: number;
    colorDepth: number;
    pixelDepth: number;
  }>;
  devicePixelRatio: number;
  hardwareConcurrency: number | null;
  deviceMemoryGiB: number | null;
  visibilityState: DocumentVisibilityState;
  documentHasFocus: boolean;
  crossOriginIsolated: boolean;
  longTaskObserverSupported: boolean;
  performanceMemorySupported: boolean;
  userAgentSpecificMemorySupported: boolean;
  userAgentSpecificMemory: MetricObservation;
}>;

export type BrowserLatencyHarness = Readonly<{
  benchmarkVersion: typeof PHASE8_LATENCY_BENCHMARK_VERSION;
  initialize(input: BrowserLatencyInitialization): Promise<void>;
  runRequestBatch(
    input: BrowserRequestBatch,
  ): Promise<BrowserLatencyBatchResult>;
  runRaceBatch(input: BrowserRaceBatch): Promise<BrowserLatencyBatchResult>;
  captureEnvironment(): Promise<BrowserLatencyEnvironment>;
}>;

export type BrowserLatencyWindow = Window & {
  __bhabhiLatencyHarness?: BrowserLatencyHarness;
};

type PerformanceWithMemory = Performance & {
  readonly memory?: {
    readonly usedJSHeapSize?: number;
  };
  readonly measureUserAgentSpecificMemory?: () => Promise<{
    readonly bytes: number;
  }>;
};

type NavigatorWithDeviceMemory = Navigator & {
  readonly deviceMemory?: number;
};

export function createBrowserLatencyAnalysisWorker(): AnalysisWorkerLike {
  return createBrowserEvaluationAnalysisWorker();
}

function assertNonnegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer.`);
  }
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function materializeSnapshot(
  descriptor: LatencySnapshot,
  label: string,
): Promise<MaterializedSnapshot> {
  const archiveSha256 = await sha256(descriptor.timelineArchive);
  if (archiveSha256 !== descriptor.timelineArchiveSha256) {
    throw new Error(`${label} archive SHA-256 does not match the corpus.`);
  }
  const timeline = importGameArchive(descriptor.timelineArchive);
  const replay = replayTimeline(timeline);
  if (
    timeline.cursor !== descriptor.stateVersion ||
    replay.semanticHash !== descriptor.historyHash ||
    stableHash(replay.state) !== descriptor.publicStateHash
  ) {
    throw new Error(`${label} replay identity does not match the corpus.`);
  }
  return Object.freeze({ descriptor, timeline });
}

async function materializeEntry(
  entry: LatencyCorpusEntry,
): Promise<MaterializedEntry> {
  const [analysis, entryProbe] = await Promise.all([
    materializeSnapshot(entry.analysis, `${entry.entryId}/analysis`),
    materializeSnapshot(entry.entryProbe, `${entry.entryId}/entry-probe`),
  ]);
  return Object.freeze({ descriptor: entry, analysis, entryProbe });
}

function readJsHeap(): MetricObservation {
  const value = (performance as PerformanceWithMemory).memory?.usedJSHeapSize;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? availableMetric(value, "bytes")
    : unavailableMetric("bytes", JS_HEAP_UNAVAILABLE_REASON);
}

class LongTaskMonitor {
  readonly #supported: boolean;
  readonly #entries: PerformanceEntry[] = [];
  readonly #observer: PerformanceObserver | null;

  constructor() {
    this.#supported =
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes.includes("longtask");
    if (!this.#supported) {
      this.#observer = null;
      return;
    }
    this.#observer = new PerformanceObserver((list) => {
      this.#entries.push(...list.getEntries());
    });
    this.#observer.observe({ type: "longtask", buffered: false });
  }

  async stop(): Promise<LongTaskObservation> {
    if (this.#observer === null) {
      return longTaskObservationSchema.parse({
        supported: false,
        thresholdMs: LATENCY_THRESHOLDS_MS.mainThreadLongTask,
        count: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        unavailableReason: LONG_TASK_UNAVAILABLE_REASON,
      });
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    this.#entries.push(...this.#observer.takeRecords());
    this.#observer.disconnect();
    const durations = this.#entries
      .map((entry) => entry.duration)
      .filter(
        (duration) => duration > LATENCY_THRESHOLDS_MS.mainThreadLongTask,
      );
    return longTaskObservationSchema.parse({
      supported: true,
      thresholdMs: LATENCY_THRESHOLDS_MS.mainThreadLongTask,
      count: durations.length,
      totalDurationMs: durations.reduce(
        (total, duration) => total + duration,
        0,
      ),
      maxDurationMs: Math.max(0, ...durations),
      unavailableReason: null,
    });
  }
}

function failureRecord(input: {
  readonly runId: string;
  readonly measurementId: string;
  readonly code: LatencyFailureCode;
  readonly stage: LatencyFailureRecord["stage"];
  readonly mode: SolverBudgetId | null;
  readonly sampleIndex: number;
  readonly requestId: string | null;
  readonly message: string;
  readonly workerFailureCode?: string | null;
}): LatencyFailureRecord {
  const projection = {
    schemaVersion: PHASE8_LATENCY_SCHEMA_VERSION,
    benchmarkVersion: PHASE8_LATENCY_BENCHMARK_VERSION,
    runId: input.runId,
    measurementId: input.measurementId,
    recordType: "latency-failure" as const,
    code: input.code,
    stage: input.stage,
    mode: input.mode,
    sampleIndex: input.sampleIndex,
    requestId: input.requestId,
    message: input.message,
    workerFailureCode: input.workerFailureCode ?? null,
  };
  return latencyFailureRecordSchema.parse({
    ...projection,
    deterministicFailureHash: stableHash(projection),
  });
}

function deterministicSeeds(
  corpus: LatencyCorpus,
  measurementId: string,
): Readonly<{
  belief: string;
  search: string;
  rollout: string;
  chance: string;
  bootstrap: string;
}> {
  return {
    belief: stableHash({
      stream: "belief",
      corpusSha256: corpus.corpusSha256,
      measurementId,
    }),
    search: stableHash({
      stream: "search",
      corpusSha256: corpus.corpusSha256,
      measurementId,
    }),
    rollout: stableHash({
      stream: "rollout",
      corpusSha256: corpus.corpusSha256,
      measurementId,
    }),
    chance: stableHash({
      stream: "chance",
      corpusSha256: corpus.corpusSha256,
      measurementId,
    }),
    bootstrap: stableHash({
      stream: "bootstrap",
      corpusSha256: corpus.corpusSha256,
      measurementId,
    }),
  };
}

function outcomeStatus(
  outcome: AnalysisClientOutcome,
): RequestLatencyRecord["status"] {
  switch (outcome.status) {
    case "success":
      return "success";
    case "failure":
      return "worker-failure";
    case "cancelled":
      return "cancelled";
  }
}

type TimedOutcome =
  | {
      readonly kind: "outcome";
      readonly outcome: AnalysisClientOutcome;
    }
  | {
      readonly kind: "timeout";
    };

async function withTimeout(
  promise: Promise<AnalysisClientOutcome>,
  timeoutMs: number,
): Promise<TimedOutcome> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedOutcome>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const result = await Promise.race([
    promise.then((outcome) => ({ kind: "outcome" as const, outcome })),
    timeout,
  ]);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }
  return result;
}

class BrowserHarnessImplementation implements BrowserLatencyHarness {
  readonly benchmarkVersion = PHASE8_LATENCY_BENCHMARK_VERSION;
  #initialization: BrowserLatencyInitialization | null = null;
  #entries: readonly MaterializedEntry[] = [];
  #probeInput: HTMLInputElement | null = null;
  #activeProbe: MaterializedSnapshot | null = null;
  #probeError: Error | null = null;
  #probeAcknowledgement: string | null = null;

  async initialize(input: BrowserLatencyInitialization): Promise<void> {
    const corpus = latencyCorpusSchema.parse(input.corpus);
    const computedCorpusSha256 = await sha256(
      stableStringify(latencyCorpusHashProjection(corpus)),
    );
    if (computedCorpusSha256 !== corpus.corpusSha256) {
      throw new Error("Latency corpus SHA-256 does not match its contents.");
    }
    if (input.runId.trim().length === 0 || input.configId.trim().length === 0) {
      throw new Error("Run and configuration IDs are required.");
    }
    const entries = await Promise.all(corpus.entries.map(materializeEntry));
    this.#initialization = Object.freeze({
      ...input,
      corpus,
      binding: Object.freeze({ ...input.binding }),
    });
    this.#entries = Object.freeze(entries);
    this.#installProbeInput();
  }

  #installProbeInput(): void {
    this.#probeInput?.remove();
    const input = document.createElement("input");
    input.id = "latency-entry-probe";
    input.type = "text";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Deterministic entry latency probe");
    input.style.position = "fixed";
    input.style.insetInlineStart = "-10000px";
    input.addEventListener("input", () => {
      const active = this.#activeProbe;
      if (active === null) {
        this.#probeError = new Error(
          "Entry probe dispatched with no active snapshot.",
        );
        return;
      }
      try {
        const imported = importGameArchive(active.descriptor.timelineArchive);
        const replay = replayTimeline(imported);
        const publicStateHash = stableHash(replay.state);
        if (
          imported.cursor !== active.descriptor.stateVersion ||
          replay.semanticHash !== active.descriptor.historyHash ||
          publicStateHash !== active.descriptor.publicStateHash
        ) {
          throw new Error(
            "Deterministic entry replay produced a different identity.",
          );
        }
        this.#probeAcknowledgement = stableHash({
          input: input.value,
          stateVersion: imported.cursor,
          historyHash: replay.semanticHash,
          publicStateHash,
        });
      } catch (error) {
        this.#probeError =
          error instanceof Error ? error : new Error(String(error));
      }
    });
    document.body.append(input);
    this.#probeInput = input;
  }

  #measureEntryProbe(probe: MaterializedSnapshot, token: string): number {
    const input = this.#probeInput;
    if (input === null) {
      throw new Error("Latency harness is not initialized.");
    }
    this.#activeProbe = probe;
    this.#probeError = null;
    this.#probeAcknowledgement = null;
    const startedAt = performance.now();
    input.value = token;
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: token,
        inputType: "insertText",
      }),
    );
    const elapsed = performance.now() - startedAt;
    this.#activeProbe = null;
    const result = this.#readProbeResult();
    if (result.error !== null) {
      throw result.error;
    }
    if (result.acknowledgement === null) {
      throw new Error("Deterministic entry probe was not acknowledged.");
    }
    return elapsed;
  }

  #readProbeResult(): Readonly<{
    error: Error | null;
    acknowledgement: string | null;
  }> {
    return {
      error: this.#probeError,
      acknowledgement: this.#probeAcknowledgement,
    };
  }

  #requireInitialization(): BrowserLatencyInitialization {
    if (this.#initialization === null || this.#entries.length === 0) {
      throw new Error("Latency harness must be initialized first.");
    }
    return this.#initialization;
  }

  async runRequestBatch(
    input: BrowserRequestBatch,
  ): Promise<BrowserLatencyBatchResult> {
    assertNonnegativeSafeInteger(input.count, "Batch count");
    assertNonnegativeSafeInteger(input.sampleIndexStart, "Sample index start");
    assertNonnegativeSafeInteger(
      input.requestOrdinalBase,
      "Request ordinal base",
    );
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
      throw new RangeError("Request timeout must be a positive integer.");
    }
    const records: LatencyRecord[] = [];
    const failures: LatencyFailureRecord[] = [];
    for (let offset = 0; offset < input.count; offset += 1) {
      const sampleIndex = input.sampleIndexStart + offset;
      const result = await this.#runRequest({
        ...input,
        sampleIndex,
        requestOrdinal: input.requestOrdinalBase + offset,
      });
      records.push(result.record);
      if (result.failure !== null) {
        failures.push(result.failure);
      }
    }
    return Object.freeze({
      records: Object.freeze(records),
      failures: Object.freeze(failures),
    });
  }

  async #runRequest(input: {
    readonly phase: "warmup" | "measured";
    readonly mode: SolverBudgetId;
    readonly temperature: "warm" | "cold";
    readonly sampleIndex: number;
    readonly requestOrdinal: number;
    readonly timeoutMs: number;
  }): Promise<{
    readonly record: RequestLatencyRecord;
    readonly failure: LatencyFailureRecord | null;
  }> {
    const initialization = this.#requireInitialization();
    const entry = this.#entries[input.sampleIndex % this.#entries.length];
    if (entry === undefined) {
      throw new Error("Latency corpus selected no entry.");
    }
    const measurementId = [
      "request",
      input.phase,
      input.temperature,
      input.mode,
      input.sampleIndex.toString(),
    ].join("/");
    const fallbackRequestId = stableHash({ measurementId, kind: "fallback" });
    const client = new AnalysisWorkerClient(createBrowserLatencyAnalysisWorker);
    const heapBefore = readJsHeap();
    const monitor = new LongTaskMonitor();
    const startedAt = performance.now();
    let requestId = fallbackRequestId;
    let entryElapsedMs = 0;
    let timedOutcome: TimedOutcome | null = null;
    let exception: Error | null = null;
    try {
      const request = createAnalysisWorkerRequest({
        timeline: entry.analysis.timeline,
        requestOrdinal: input.requestOrdinal,
        sessionEpoch: input.sampleIndex + 1,
        budgetId: input.mode,
        seeds: deterministicSeeds(initialization.corpus, measurementId),
        binding: initialization.binding,
      });
      requestId = request.requestId;
      const outcomePromise = client.analyze(request);
      entryElapsedMs = this.#measureEntryProbe(entry.entryProbe, measurementId);
      timedOutcome = await withTimeout(outcomePromise, input.timeoutMs);
      if (timedOutcome.kind === "timeout") {
        client.invalidate();
        await outcomePromise;
      }
    } catch (error) {
      exception = error instanceof Error ? error : new Error(String(error));
      client.invalidate();
    } finally {
      client.dispose();
    }
    const wallElapsedMs = performance.now() - startedAt;
    const longTasks = await monitor.stop();
    const heapAfter = readJsHeap();
    const common = {
      schemaVersion: PHASE8_LATENCY_SCHEMA_VERSION,
      benchmarkVersion: PHASE8_LATENCY_BENCHMARK_VERSION,
      runId: initialization.runId,
      measurementId,
      recordType: "request-latency" as const,
      phase: input.phase,
      mode: input.mode,
      temperature: input.temperature,
      sampleIndex: input.sampleIndex,
      corpusEntryId: entry.descriptor.entryId,
      requestId,
      wallElapsedMs,
      deterministicEntryElapsedMs: entryElapsedMs,
      cpuTime: unavailableMetric("milliseconds", CPU_UNAVAILABLE_REASON),
      jsHeapBefore: heapBefore,
      jsHeapAfter: heapAfter,
      workerMemory: unavailableMetric(
        "bytes",
        WORKER_MEMORY_UNAVAILABLE_REASON,
      ),
      processMemory: unavailableMetric(
        "bytes",
        PROCESS_MEMORY_UNAVAILABLE_REASON,
      ),
      longTasks,
    };

    if (exception !== null) {
      const record = requestLatencyRecordSchema.parse({
        ...common,
        status: "exception",
        solverElapsedMs: null,
        solverDeadlineMs: null,
        solverDeadlineExceeded: null,
        payloadHash: null,
        workerFailureCode: null,
      });
      return {
        record,
        failure: failureRecord({
          runId: initialization.runId,
          measurementId,
          code: "WORKER_EXCEPTION",
          stage: input.phase === "warmup" ? "warmup" : "request",
          mode: input.mode,
          sampleIndex: input.sampleIndex,
          requestId,
          message: exception.message,
        }),
      };
    }
    if (timedOutcome === null || timedOutcome.kind === "timeout") {
      const record = requestLatencyRecordSchema.parse({
        ...common,
        status: "timeout",
        solverElapsedMs: null,
        solverDeadlineMs: null,
        solverDeadlineExceeded: null,
        payloadHash: null,
        workerFailureCode: null,
      });
      return {
        record,
        failure: failureRecord({
          runId: initialization.runId,
          measurementId,
          code: "REQUEST_TIMEOUT",
          stage: input.phase === "warmup" ? "warmup" : "request",
          mode: input.mode,
          sampleIndex: input.sampleIndex,
          requestId,
          message: `${input.mode} request exceeded ${input.timeoutMs.toString()} ms.`,
        }),
      };
    }
    const outcome = timedOutcome.outcome;
    if (outcome.status === "success") {
      const record = requestLatencyRecordSchema.parse({
        ...common,
        status: "success",
        solverElapsedMs: outcome.response.result.telemetry.elapsedMs,
        solverDeadlineMs: outcome.response.result.telemetry.deadlineMs,
        solverDeadlineExceeded:
          outcome.response.result.telemetry.deadlineExceeded,
        payloadHash: stableHash(outcome.response.result.payload),
        workerFailureCode: null,
      });
      return { record, failure: null };
    }
    const status = outcomeStatus(outcome);
    const workerFailureCode =
      outcome.status === "failure" ? outcome.response.code : null;
    const message =
      outcome.status === "failure"
        ? outcome.response.message
        : `Request was unexpectedly cancelled: ${outcome.reason}.`;
    const record = requestLatencyRecordSchema.parse({
      ...common,
      status,
      solverElapsedMs: null,
      solverDeadlineMs: null,
      solverDeadlineExceeded: null,
      payloadHash: null,
      workerFailureCode,
    });
    return {
      record,
      failure: failureRecord({
        runId: initialization.runId,
        measurementId,
        code:
          outcome.status === "failure"
            ? "WORKER_FAILURE"
            : "UNEXPECTED_CANCELLATION",
        stage: input.phase === "warmup" ? "warmup" : "request",
        mode: input.mode,
        sampleIndex: input.sampleIndex,
        requestId,
        message,
        workerFailureCode,
      }),
    };
  }

  async runRaceBatch(
    input: BrowserRaceBatch,
  ): Promise<BrowserLatencyBatchResult> {
    assertNonnegativeSafeInteger(input.count, "Race count");
    assertNonnegativeSafeInteger(input.raceIndexStart, "Race index start");
    assertNonnegativeSafeInteger(
      input.requestOrdinalBase,
      "Request ordinal base",
    );
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
      throw new RangeError("Race timeout must be a positive integer.");
    }
    const records: LatencyRecord[] = [];
    const failures: LatencyFailureRecord[] = [];
    for (let offset = 0; offset < input.count; offset += 1) {
      const result = await this.#runRace({
        raceIndex: input.raceIndexStart + offset,
        requestOrdinalBase: input.requestOrdinalBase + offset * 2,
        timeoutMs: input.timeoutMs,
      });
      records.push(result.record);
      failures.push(...result.failures);
    }
    return Object.freeze({
      records: Object.freeze(records),
      failures: Object.freeze(failures),
    });
  }

  async #runRace(input: {
    readonly raceIndex: number;
    readonly requestOrdinalBase: number;
    readonly timeoutMs: number;
  }): Promise<{
    readonly record: RaceLatencyRecord;
    readonly failures: readonly LatencyFailureRecord[];
  }> {
    const initialization = this.#requireInitialization();
    const oldEntry = this.#entries[input.raceIndex % this.#entries.length];
    const currentEntry =
      this.#entries[(input.raceIndex + 1) % this.#entries.length];
    if (oldEntry === undefined || currentEntry === undefined) {
      throw new Error("Latency corpus selected no race entries.");
    }
    const measurementId = `race/${input.raceIndex.toString()}`;
    const invalidationKind =
      input.raceIndex % 2 === 0
        ? ("supersede" as const)
        : ("invalidate-then-restart" as const);
    const client = new AnalysisWorkerClient(createBrowserLatencyAnalysisWorker);
    const monitor = new LongTaskMonitor();
    const startedAt = performance.now();
    const oldRequest = createAnalysisWorkerRequest({
      timeline: oldEntry.analysis.timeline,
      requestOrdinal: input.requestOrdinalBase,
      sessionEpoch: input.raceIndex * 2 + 1,
      budgetId: "instant",
      seeds: deterministicSeeds(initialization.corpus, `${measurementId}/old`),
      binding: initialization.binding,
    });
    const currentRequest = createAnalysisWorkerRequest({
      timeline: currentEntry.analysis.timeline,
      requestOrdinal: input.requestOrdinalBase + 1,
      sessionEpoch: input.raceIndex * 2 + 2,
      budgetId: "instant",
      seeds: deterministicSeeds(
        initialization.corpus,
        `${measurementId}/current`,
      ),
      binding: initialization.binding,
    });
    let oldPromise: Promise<AnalysisClientOutcome> | null = null;
    let currentPromise: Promise<AnalysisClientOutcome> | null = null;
    let oldOutcome: AnalysisClientOutcome | null = null;
    let timedCurrent: TimedOutcome | null = null;
    let exception: Error | null = null;
    let supersedeDelayMs: number | null = null;
    try {
      oldPromise = client.analyze(oldRequest);
      this.#measureEntryProbe(oldEntry.entryProbe, measurementId);
      if (invalidationKind === "invalidate-then-restart") {
        client.invalidate();
      }
      currentPromise = client.analyze(currentRequest);
      supersedeDelayMs = performance.now() - startedAt;
      oldOutcome = await oldPromise;
      timedCurrent = await withTimeout(currentPromise, input.timeoutMs);
      if (timedCurrent.kind === "timeout") {
        client.invalidate();
        await currentPromise;
      }
    } catch (error) {
      exception = error instanceof Error ? error : new Error(String(error));
    } finally {
      client.invalidate();
      if (oldPromise !== null && oldOutcome === null) {
        oldOutcome = await oldPromise;
      }
      if (currentPromise !== null && timedCurrent === null) {
        timedCurrent = {
          kind: "outcome",
          outcome: await currentPromise,
        };
      }
      client.dispose();
    }
    const recordedSupersedeDelayMs =
      supersedeDelayMs ?? performance.now() - startedAt;
    const wallElapsedMs = performance.now() - startedAt;
    const longTasks = await monitor.stop();
    const currentOutcome =
      timedCurrent?.kind === "outcome" ? timedCurrent.outcome : null;
    const oldStatus = oldOutcome?.status ?? "failure";
    const currentStatus =
      timedCurrent?.kind === "timeout"
        ? ("timeout" as const)
        : currentOutcome?.status === "success"
          ? ("success" as const)
          : currentOutcome?.status === "cancelled"
            ? ("cancelled" as const)
            : ("failure" as const);
    const currentResponseRequestId =
      currentOutcome?.status === "success"
        ? currentOutcome.response.requestId
        : null;
    const accounting = accountStaleRace({
      oldStatus,
      oldRequestId: oldRequest.requestId,
      currentStatus,
      currentRequestId: currentRequest.requestId,
      currentResponseRequestId,
    });
    const record = raceLatencyRecordSchema.parse({
      schemaVersion: PHASE8_LATENCY_SCHEMA_VERSION,
      benchmarkVersion: PHASE8_LATENCY_BENCHMARK_VERSION,
      runId: initialization.runId,
      measurementId,
      recordType: "stale-race",
      raceIndex: input.raceIndex,
      invalidationKind,
      oldCorpusEntryId: oldEntry.descriptor.entryId,
      currentCorpusEntryId: currentEntry.descriptor.entryId,
      oldRequestId: oldRequest.requestId,
      currentRequestId: currentRequest.requestId,
      supersedeDelayMs: recordedSupersedeDelayMs,
      wallElapsedMs,
      oldOutcome: oldStatus,
      currentOutcome: currentStatus,
      ...accounting,
      longTasks,
    });
    const failures: LatencyFailureRecord[] = [];
    if (exception !== null) {
      failures.push(
        failureRecord({
          runId: initialization.runId,
          measurementId,
          code: "WORKER_EXCEPTION",
          stage: "race",
          mode: "instant",
          sampleIndex: input.raceIndex,
          requestId: currentRequest.requestId,
          message: exception.message,
        }),
      );
    }
    if (record.oldCancellationCount !== 1) {
      failures.push(
        failureRecord({
          runId: initialization.runId,
          measurementId,
          code: "RACE_OLD_NOT_CANCELLED",
          stage: "race",
          mode: "instant",
          sampleIndex: input.raceIndex,
          requestId: oldRequest.requestId,
          message: `Obsolete request settled as ${oldStatus}.`,
        }),
      );
    }
    if (record.currentPublicationCount !== 1) {
      const workerFailureCode =
        currentOutcome?.status === "failure"
          ? currentOutcome.response.code
          : null;
      failures.push(
        failureRecord({
          runId: initialization.runId,
          measurementId,
          code:
            currentOutcome?.status === "success"
              ? "IDENTITY_MISMATCH"
              : "RACE_CURRENT_NOT_SUCCESSFUL",
          stage: "race",
          mode: "instant",
          sampleIndex: input.raceIndex,
          requestId: currentRequest.requestId,
          message:
            timedCurrent?.kind === "timeout"
              ? `Current race request exceeded ${input.timeoutMs.toString()} ms.`
              : `Current race request did not publish successfully (${currentStatus}).`,
          workerFailureCode,
        }),
      );
    }
    if (record.obsoletePublicationCount !== 0) {
      failures.push(
        failureRecord({
          runId: initialization.runId,
          measurementId,
          code: "OBSOLETE_PUBLICATION",
          stage: "race",
          mode: "instant",
          sampleIndex: input.raceIndex,
          requestId: oldRequest.requestId,
          message: "An obsolete analysis result was published.",
        }),
      );
    }
    return { record, failures: Object.freeze(failures) };
  }

  async captureEnvironment(): Promise<BrowserLatencyEnvironment> {
    const perf = performance as PerformanceWithMemory;
    let userAgentSpecificMemory: MetricObservation;
    if (perf.measureUserAgentSpecificMemory === undefined) {
      userAgentSpecificMemory = unavailableMetric(
        "bytes",
        "performance.measureUserAgentSpecificMemory is unavailable.",
      );
    } else {
      try {
        const measurement = await perf.measureUserAgentSpecificMemory();
        userAgentSpecificMemory = availableMetric(measurement.bytes, "bytes");
      } catch (error) {
        userAgentSpecificMemory = unavailableMetric(
          "bytes",
          `measureUserAgentSpecificMemory failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const navigatorWithMemory = navigator as NavigatorWithDeviceMemory;
    return Object.freeze({
      schemaVersion: PHASE8_LATENCY_SCHEMA_VERSION,
      userAgent: navigator.userAgent,
      browserLanguage: navigator.language,
      browserLanguages: Object.freeze([...navigator.languages]),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: Object.freeze({
        width: screen.width,
        height: screen.height,
        availableWidth: screen.availWidth,
        availableHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
      }),
      devicePixelRatio,
      hardwareConcurrency:
        Number.isSafeInteger(navigator.hardwareConcurrency) &&
        navigator.hardwareConcurrency > 0
          ? navigator.hardwareConcurrency
          : null,
      deviceMemoryGiB:
        typeof navigatorWithMemory.deviceMemory === "number" &&
        Number.isFinite(navigatorWithMemory.deviceMemory)
          ? navigatorWithMemory.deviceMemory
          : null,
      visibilityState: document.visibilityState,
      documentHasFocus: document.hasFocus(),
      crossOriginIsolated,
      longTaskObserverSupported:
        typeof PerformanceObserver !== "undefined" &&
        PerformanceObserver.supportedEntryTypes.includes("longtask"),
      performanceMemorySupported:
        typeof perf.memory?.usedJSHeapSize === "number",
      userAgentSpecificMemorySupported:
        perf.measureUserAgentSpecificMemory !== undefined,
      userAgentSpecificMemory,
    });
  }
}

export function installBrowserLatencyHarness(): BrowserLatencyHarness {
  const harness = new BrowserHarnessImplementation();
  (window as BrowserLatencyWindow).__bhabhiLatencyHarness = harness;
  return harness;
}
