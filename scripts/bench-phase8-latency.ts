import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import {
  PHASE8_LATENCY_BENCHMARK_VERSION,
  developmentLatencySchedule,
  latencyScheduleSchema,
  releaseLatencySchedule,
  type BrowserLatencyBatchResult,
  type BrowserLatencyEnvironment,
  type BrowserLatencyInitialization,
  type BrowserLatencyWindow,
  type BrowserRaceBatch,
  type BrowserRequestBatch,
  type LatencyCorpus,
  type LatencyFailureRecord,
  type LatencyRecord,
  type LatencySchedule,
} from "../src/benchmark";
import {
  captureDirectorySnapshot,
  createLatencyRunManifest,
  latencyEnvironmentSchema,
  phase8LatencyManifestSchema,
  validateLatencyCorpus,
  verifyLatencyArtifacts,
  writeLatencyArtifacts,
  type LatencyEnvironment,
} from "../src/benchmark/node";
import { phase8Sha256 } from "../src/evaluation/phase8-manifest";
import { stableStringify } from "../src/events/stable-hash";
import {
  verifyProductionReleaseBundle,
  type ProductionAnalysisBinding,
} from "../src/production/release-contract";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
});

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

function nonnegativeIntegerArgument(name: string, fallback: number): number {
  const raw = argument(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer.`);
  }
  return value;
}

function positiveIntegerArgument(name: string, fallback: number): number {
  const value = nonnegativeIntegerArgument(name, fallback);
  if (value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function resolveProjectPath(path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(PROJECT_ROOT, path);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function scheduleFromArguments(): LatencySchedule {
  const base = process.argv.includes("--evidence-eligible")
    ? releaseLatencySchedule()
    : developmentLatencySchedule();
  return latencyScheduleSchema.parse({
    evidenceEligible: process.argv.includes("--evidence-eligible"),
    warmupPerLiveMode: nonnegativeIntegerArgument(
      "--warmup-per-live",
      base.warmupPerLiveMode,
    ),
    warm: {
      instant: nonnegativeIntegerArgument("--warm-instant", base.warm.instant),
      balanced: nonnegativeIntegerArgument(
        "--warm-balanced",
        base.warm.balanced,
      ),
      deep: nonnegativeIntegerArgument("--warm-deep", base.warm.deep),
    },
    cold: {
      instant: nonnegativeIntegerArgument("--cold-instant", base.cold.instant),
      balanced: nonnegativeIntegerArgument(
        "--cold-balanced",
        base.cold.balanced,
      ),
      deep: nonnegativeIntegerArgument("--cold-deep", base.cold.deep),
    },
    offline: nonnegativeIntegerArgument("--offline", base.offline),
    races: nonnegativeIntegerArgument("--races", base.races),
    requestTimeoutMs: {
      instant: positiveIntegerArgument(
        "--timeout-instant-ms",
        base.requestTimeoutMs.instant,
      ),
      balanced: positiveIntegerArgument(
        "--timeout-balanced-ms",
        base.requestTimeoutMs.balanced,
      ),
      deep: positiveIntegerArgument(
        "--timeout-deep-ms",
        base.requestTimeoutMs.deep,
      ),
      offline: positiveIntegerArgument(
        "--timeout-offline-ms",
        base.requestTimeoutMs.offline,
      ),
    },
  });
}

function commandText(input: {
  readonly runId: string;
  readonly manifestPath: string;
  readonly corpusPath: string;
  readonly configId: string;
  readonly distPath: string;
  readonly outputParent: string;
  readonly schedule: LatencySchedule;
  readonly powerMode: string;
  readonly powerSource: string;
  readonly backgroundLoadPolicy: string;
  readonly headed: boolean;
  readonly releaseBundlePath: string | null;
}): string {
  const parts = [
    "npm run bench:latency --",
    "--run-id",
    JSON.stringify(input.runId),
    "--manifest",
    JSON.stringify(input.manifestPath),
    "--corpus",
    JSON.stringify(input.corpusPath),
    "--config-id",
    JSON.stringify(input.configId),
    "--dist",
    JSON.stringify(input.distPath),
    "--output-parent",
    JSON.stringify(input.outputParent),
    "--warmup-per-live",
    input.schedule.warmupPerLiveMode.toString(),
    "--warm-instant",
    input.schedule.warm.instant.toString(),
    "--warm-balanced",
    input.schedule.warm.balanced.toString(),
    "--warm-deep",
    input.schedule.warm.deep.toString(),
    "--cold-instant",
    input.schedule.cold.instant.toString(),
    "--cold-balanced",
    input.schedule.cold.balanced.toString(),
    "--cold-deep",
    input.schedule.cold.deep.toString(),
    "--offline",
    input.schedule.offline.toString(),
    "--races",
    input.schedule.races.toString(),
    "--timeout-instant-ms",
    input.schedule.requestTimeoutMs.instant.toString(),
    "--timeout-balanced-ms",
    input.schedule.requestTimeoutMs.balanced.toString(),
    "--timeout-deep-ms",
    input.schedule.requestTimeoutMs.deep.toString(),
    "--timeout-offline-ms",
    input.schedule.requestTimeoutMs.offline.toString(),
    "--power-mode",
    JSON.stringify(input.powerMode),
    "--power-source",
    JSON.stringify(input.powerSource),
    "--background-load",
    JSON.stringify(input.backgroundLoadPolicy),
  ];
  if (input.schedule.evidenceEligible) {
    parts.push("--evidence-eligible");
  }
  if (input.headed) {
    parts.push("--headed");
  }
  if (input.releaseBundlePath !== null) {
    parts.push("--release-bundle", JSON.stringify(input.releaseBundlePath));
  }
  return parts.join(" ");
}

function contentType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function startProductionServer(
  distDirectory: string,
): Promise<Readonly<{ server: Server; url: string }>> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        const decoded = decodeURIComponent(requestUrl.pathname);
        const requestedRelative =
          decoded === "/" ? "latency.html" : decoded.slice(1);
        const target = resolve(distDirectory, requestedRelative);
        const escaped = relative(distDirectory, target);
        if (
          escaped.startsWith("..") ||
          isAbsolute(escaped) ||
          escaped.length === 0
        ) {
          response.statusCode = 403;
          response.end("Forbidden");
          return;
        }
        const bytes = await readFile(target);
        response.statusCode = 200;
        response.setHeader("Content-Type", contentType(target));
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        response.setHeader(
          "Cache-Control",
          "public, max-age=31536000, immutable",
        );
        response.end(bytes);
      } catch {
        response.statusCode = 404;
        response.end("Not found");
      }
    })();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolveClose) => {
      server.close(() => {
        resolveClose();
      });
    });
    throw new Error("Unable to determine benchmark server address.");
  }
  return Object.freeze({
    server,
    url: `http://127.0.0.1:${address.port.toString()}/latency.html`,
  });
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        reject(error);
      }
    });
  });
}

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(
    (version) =>
      (window as BrowserLatencyWindow).__bhabhiLatencyHarness
        ?.benchmarkVersion === version,
    PHASE8_LATENCY_BENCHMARK_VERSION,
    { timeout: 30_000 },
  );
}

async function initializePage(
  page: Page,
  url: string,
  initialization: BrowserLatencyInitialization,
  navigate: boolean,
): Promise<void> {
  if (navigate) {
    await page.goto(url, { waitUntil: "networkidle" });
  }
  await waitForHarness(page);
  await page.evaluate(async (value) => {
    const harness = (window as BrowserLatencyWindow).__bhabhiLatencyHarness;
    if (harness === undefined) {
      throw new Error("Latency harness is unavailable.");
    }
    await harness.initialize(value);
  }, initialization);
}

async function runRequestBatch(
  page: Page,
  input: BrowserRequestBatch,
): Promise<BrowserLatencyBatchResult> {
  return page.evaluate(async (value) => {
    const harness = (window as BrowserLatencyWindow).__bhabhiLatencyHarness;
    if (harness === undefined) {
      throw new Error("Latency harness is unavailable.");
    }
    return harness.runRequestBatch(value);
  }, input);
}

async function runRaceBatch(
  page: Page,
  input: BrowserRaceBatch,
): Promise<BrowserLatencyBatchResult> {
  return page.evaluate(async (value) => {
    const harness = (window as BrowserLatencyWindow).__bhabhiLatencyHarness;
    if (harness === undefined) {
      throw new Error("Latency harness is unavailable.");
    }
    return harness.runRaceBatch(value);
  }, input);
}

async function captureBrowserEnvironment(
  page: Page,
): Promise<BrowserLatencyEnvironment> {
  return page.evaluate(async () => {
    const harness = (window as BrowserLatencyWindow).__bhabhiLatencyHarness;
    if (harness === undefined) {
      throw new Error("Latency harness is unavailable.");
    }
    return harness.captureEnvironment();
  });
}

async function closeBrowserResources(
  browser: Browser | null,
  context: BrowserContext | null,
): Promise<void> {
  await context?.close();
  await browser?.close();
}

async function main(): Promise<void> {
  const runId = requiredArgument("--run-id");
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/u.test(runId)) {
    throw new Error(
      "Run ID must be 3-80 lowercase letters, digits, dots, underscores, or hyphens.",
    );
  }
  const manifestPath = resolveProjectPath(requiredArgument("--manifest"));
  const corpusPath = resolveProjectPath(requiredArgument("--corpus"));
  const configId = requiredArgument("--config-id");
  const distPath = resolveProjectPath(argument("--dist") ?? "dist");
  const configuredReleaseBundlePath = argument("--release-bundle");
  const releaseBundlePath =
    configuredReleaseBundlePath === undefined
      ? null
      : resolveProjectPath(configuredReleaseBundlePath);
  const phase8Manifest = phase8LatencyManifestSchema.parse(
    await readJson(manifestPath),
  );
  const corpusValidation = validateLatencyCorpus(await readJson(corpusPath));
  if (
    corpusValidation.corpus === null ||
    corpusValidation.failures.length > 0
  ) {
    throw new Error(
      `Latency corpus is invalid: ${corpusValidation.failures.join("; ")}`,
    );
  }
  const corpus: LatencyCorpus = corpusValidation.corpus;
  const isFinalManifest =
    phase8Manifest.manifestVersion === "phase8-final-evaluation-manifest-v1";
  if ((corpus.split === "final") !== isFinalManifest) {
    throw new Error(
      "Final latency corpora require a frozen Phase 8 final manifest; other splits require the qualification manifest.",
    );
  }
  const phase8ManifestSha256 = phase8Sha256(phase8Manifest);
  if (
    corpus.phase8ManifestId !== phase8Manifest.manifestId ||
    corpus.phase8ManifestSha256 !== phase8ManifestSha256
  ) {
    throw new Error(
      "Candidate-independent latency corpus is bound to a different Phase 8 manifest.",
    );
  }
  const configuration = phase8Manifest.configurations.find(
    (candidate) => candidate.configId === configId,
  );
  if (configuration === undefined) {
    throw new Error(`Unknown Phase 8 configuration ${configId}.`);
  }
  const schedule = scheduleFromArguments();
  const buildSnapshot = await captureDirectorySnapshot(distPath);
  const outputParent = resolveProjectPath(
    argument("--output-parent") ??
      join(
        "artifacts",
        "evaluation",
        "eval-v1",
        corpus.split,
        "phase8-latency",
      ),
  );
  const powerMode =
    argument("--power-mode") ?? "not-programmatically-available";
  const powerSource =
    argument("--power-source") ?? "not-programmatically-available";
  const backgroundLoadPolicy =
    argument("--background-load") ??
    "no-controlled-background-load; manual observation not recorded";
  const headed = process.argv.includes("--headed");
  const command = commandText({
    runId,
    manifestPath,
    corpusPath,
    configId,
    distPath,
    outputParent,
    schedule,
    powerMode,
    powerSource,
    backgroundLoadPolicy,
    headed,
    releaseBundlePath,
  });
  let binding: ProductionAnalysisBinding;
  if (releaseBundlePath === null) {
    binding = {
      bundleMode: "evaluation-only",
      manifestScope:
        phase8Manifest.manifestVersion === "phase8-final-evaluation-manifest-v1"
          ? "final"
          : "qualification",
      manifestHash: phase8Sha256(phase8Manifest),
      sourceHash: phase8Manifest.hashes.sourceSha256,
      solverConfigHash: configuration.configSha256,
      modelHash: phase8Manifest.hashes.modelSha256,
      protocolHash: corpus.protocolSha256,
      selectedConfigId: configuration.configId,
      selectionAttestationHash: null,
      finalAttestationHash: null,
    };
  } else {
    const release = await verifyProductionReleaseBundle(
      await readJson(releaseBundlePath),
    );
    binding = release.binding;
    if (
      binding.bundleMode !== "release-selected" ||
      binding.manifestScope !== "final" ||
      binding.manifestHash !== phase8Sha256(phase8Manifest) ||
      binding.sourceHash !== phase8Manifest.hashes.sourceSha256 ||
      binding.solverConfigHash !== configuration.configSha256 ||
      binding.modelHash !== phase8Manifest.hashes.modelSha256 ||
      binding.protocolHash !== corpus.protocolSha256 ||
      binding.selectedConfigId !== configuration.configId
    ) {
      throw new Error(
        "Selected release bundle does not match the final latency manifest, corpus, and configuration.",
      );
    }
  }
  const initialization: BrowserLatencyInitialization = {
    runId,
    corpus,
    configId,
    binding,
  };
  const createdAt = new Date().toISOString();
  const runManifest = createLatencyRunManifest({
    runId,
    createdAt,
    phase8Manifest,
    configId,
    corpus,
    schedule,
    binding,
    productionBuild: buildSnapshot,
    command,
  });

  const productionServer = await startProductionServer(distPath);
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let nodeHarnessRssMaxObservedBytes = process.memoryUsage().rss;
  const records: LatencyRecord[] = [];
  const failures: LatencyFailureRecord[] = [];
  const append = (result: BrowserLatencyBatchResult): void => {
    records.push(...result.records);
    failures.push(...result.failures);
    nodeHarnessRssMaxObservedBytes = Math.max(
      nodeHarnessRssMaxObservedBytes,
      process.memoryUsage().rss,
    );
  };
  const capturedAtStart = new Date().toISOString();
  const freeMemoryBytesAtStart = freemem();
  let browserAtStart: BrowserLatencyEnvironment;
  let browserAtEnd: BrowserLatencyEnvironment;
  let browserVersion: string;
  try {
    browser = await chromium.launch({ headless: !headed });
    browserVersion = browser.version();
    context = await browser.newContext({
      viewport: { width: 1_440, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await initializePage(page, productionServer.url, initialization, true);
    browserAtStart = await captureBrowserEnvironment(page);

    let requestOrdinalBase = 0;
    for (const mode of ["instant", "balanced", "deep"] as const) {
      append(
        await runRequestBatch(page, {
          phase: "warmup",
          mode,
          temperature: "warm",
          count: schedule.warmupPerLiveMode,
          sampleIndexStart: 0,
          requestOrdinalBase,
          timeoutMs: schedule.requestTimeoutMs[mode],
        }),
      );
      requestOrdinalBase += schedule.warmupPerLiveMode;
    }
    requestOrdinalBase = 1_000_000;
    for (const mode of ["instant", "balanced", "deep"] as const) {
      append(
        await runRequestBatch(page, {
          phase: "measured",
          mode,
          temperature: "warm",
          count: schedule.warm[mode],
          sampleIndexStart: 0,
          requestOrdinalBase,
          timeoutMs: schedule.requestTimeoutMs[mode],
        }),
      );
      requestOrdinalBase += schedule.warm[mode];
    }

    requestOrdinalBase = 2_000_000;
    for (const mode of ["instant", "balanced", "deep"] as const) {
      for (
        let sampleIndex = 0;
        sampleIndex < schedule.cold[mode];
        sampleIndex += 1
      ) {
        await page.reload({ waitUntil: "networkidle" });
        await initializePage(page, productionServer.url, initialization, false);
        append(
          await runRequestBatch(page, {
            phase: "measured",
            mode,
            temperature: "cold",
            count: 1,
            sampleIndexStart: sampleIndex,
            requestOrdinalBase,
            timeoutMs: schedule.requestTimeoutMs[mode],
          }),
        );
        requestOrdinalBase += 1;
      }
    }

    await page.reload({ waitUntil: "networkidle" });
    await initializePage(page, productionServer.url, initialization, false);
    append(
      await runRequestBatch(page, {
        phase: "measured",
        mode: "offline",
        temperature: "warm",
        count: schedule.offline,
        sampleIndexStart: 0,
        requestOrdinalBase: 3_000_000,
        timeoutMs: schedule.requestTimeoutMs.offline,
      }),
    );
    append(
      await runRaceBatch(page, {
        count: schedule.races,
        raceIndexStart: 0,
        requestOrdinalBase: 4_000_000,
        timeoutMs: schedule.requestTimeoutMs.instant,
      }),
    );
    browserAtEnd = await captureBrowserEnvironment(page);
  } finally {
    await closeBrowserResources(browser, context);
    await stopServer(productionServer.server);
  }
  const capturedAtEnd = new Date().toISOString();
  const hostCpus = cpus();
  const environment: LatencyEnvironment = latencyEnvironmentSchema.parse({
    schemaVersion: 1,
    capturedAtStart,
    capturedAtEnd,
    platform: platform(),
    release: release(),
    architecture: arch(),
    cpuModel: hostCpus[0]?.model ?? "unknown",
    logicalCpus: hostCpus.length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart,
    freeMemoryBytesAtEnd: freemem(),
    nodeVersion: process.version,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    powerMode,
    powerSource,
    backgroundLoadPolicy,
    workerCount: 1,
    browserEngine: "chromium",
    browserVersion,
    headless: !headed,
    coldStartDefinition:
      "fresh-production-document-reload-and-fresh-dedicated-worker",
    warmDefinition:
      "warmed-production-document-and-module-cache-with-fresh-dedicated-worker-per-request",
    browserAtStart,
    browserAtEnd,
    nodeHarnessRssMaxObservedBytes,
    browserProcessMemoryBytes: null,
    browserProcessMemoryUnavailableReason:
      "Playwright does not expose an attributable browser-process peak-memory metric in this harness.",
    dedicatedWorkerMemoryBytes: null,
    dedicatedWorkerMemoryUnavailableReason:
      "The browser does not expose per-dedicated-worker memory attribution.",
    dedicatedWorkerCpuTimeMs: null,
    dedicatedWorkerCpuTimeUnavailableReason:
      "The browser does not expose per-dedicated-worker CPU attribution.",
  });
  const artifact = await writeLatencyArtifacts({
    parentDirectory: outputParent,
    manifest: runManifest,
    environment,
    corpus,
    records,
    failures,
  });
  const verification = await verifyLatencyArtifacts(artifact.runDirectory);
  if (!verification.valid) {
    throw new Error(
      `Written latency artifact failed verification: ${verification.failures.join("; ")}`,
    );
  }
  console.log(
    stableStringify({
      runDirectory: artifact.runDirectory,
      recordCount: records.length,
      failureCount: failures.length,
      gate: artifact.summary.gate,
      reproductionDigest: artifact.summary.reproductionDigest,
    }),
  );
  if (
    schedule.evidenceEligible
      ? !artifact.summary.gate.evidenceGatePass
      : !artifact.summary.gate.operationalPass
  ) {
    process.exitCode = 1;
  }
}

await main();
