import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

type LatencyRecord = {
  readonly budget: string;
  readonly wallElapsedMs: number;
  readonly payloadHash: string;
};

type BucketSummary = {
  readonly samples: number;
  readonly p95Ms: number;
  readonly payloadHashes: readonly string[];
};

type BenchmarkSummary = {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly split: string;
  readonly evidenceEligible: boolean;
  readonly instant: BucketSummary;
  readonly balanced: BucketSummary;
  readonly thresholds: {
    readonly instantInternalDeadlineP95Ms: number;
    readonly balancedInternalDeadlineP95Ms: number;
    readonly instantValidRecommendationP95Ms: number;
    readonly balancedValidRecommendationP95Ms: number;
  };
  readonly gate: {
    readonly instantInternalDeadlineP95Pass: boolean;
    readonly balancedInternalDeadlineP95Pass: boolean;
    readonly instantServiceP95Pass: boolean;
    readonly balancedServiceP95Pass: boolean;
    readonly deterministicPayloads: boolean;
    readonly zeroFailures: boolean;
    readonly overallPass: boolean;
  };
};

const EXPECTED_PAYLOAD_FILES = [
  "command.txt",
  "environment.json",
  "latency.ndjson",
  "summary.json",
  "summary.md",
] as const;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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

function parseJson(text: string, label: string, failures: string[]): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    failures.push(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function equalCheck(
  actual: unknown,
  expected: unknown,
  label: string,
  failures: string[],
): void {
  if (!Object.is(actual, expected)) {
    failures.push(
      `${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

async function main(): Promise<void> {
  const rawRun = argument("--run");
  if (rawRun === undefined) {
    throw new Error(
      "Usage: npm run bench:phase5:verify -- --run <artifact-directory>",
    );
  }
  const runDirectory = resolve(rawRun);
  const failures: string[] = [];
  const names = (await readdir(runDirectory)).sort();
  const expectedNames = [...EXPECTED_PAYLOAD_FILES, "checksums.sha256"].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    failures.push(
      `Artifact file set mismatch: expected ${expectedNames.join(", ")}, received ${names.join(", ")}.`,
    );
  }

  const checksumText = await readFile(
    resolve(runDirectory, "checksums.sha256"),
    "utf8",
  );
  const recordedChecksums = new Map<string, string>();
  for (const line of checksumText.trim().split(/\r?\n/u)) {
    const match = /^([0-9a-f]{64}) {2}([a-z0-9.-]+)$/u.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      failures.push(`Malformed checksum line: ${JSON.stringify(line)}.`);
      continue;
    }
    if (recordedChecksums.has(match[2])) {
      failures.push(`Duplicate checksum entry for ${match[2]}.`);
      continue;
    }
    recordedChecksums.set(match[2], match[1]);
  }
  for (const name of EXPECTED_PAYLOAD_FILES) {
    const bytes = await readFile(resolve(runDirectory, name));
    equalCheck(
      recordedChecksums.get(name),
      sha256(bytes),
      `SHA-256 for ${name}`,
      failures,
    );
  }
  equalCheck(
    recordedChecksums.size,
    EXPECTED_PAYLOAD_FILES.length,
    "checksum entry count",
    failures,
  );

  const summary = parseJson(
    await readFile(resolve(runDirectory, "summary.json"), "utf8"),
    "summary.json",
    failures,
  ) as BenchmarkSummary | null;
  const recordLines = (
    await readFile(resolve(runDirectory, "latency.ndjson"), "utf8")
  )
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  const records = recordLines
    .map(
      (line, index) =>
        parseJson(
          line,
          `latency.ndjson line ${(index + 1).toString()}`,
          failures,
        ) as LatencyRecord | null,
    )
    .filter((record): record is LatencyRecord => record !== null);

  if (summary !== null) {
    equalCheck(summary.schemaVersion, 1, "summary schema version", failures);
    equalCheck(
      summary.runId,
      basename(runDirectory),
      "summary run ID",
      failures,
    );
    equalCheck(summary.split, "dev", "summary split", failures);
    equalCheck(
      summary.evidenceEligible,
      false,
      "summary evidence eligibility",
      failures,
    );

    const instant = records.filter((record) => record.budget === "instant");
    const balanced = records.filter((record) => record.budget === "balanced");
    const unknownBudgets = records.filter(
      (record) => record.budget !== "instant" && record.budget !== "balanced",
    );
    equalCheck(
      unknownBudgets.length,
      0,
      "unknown budget record count",
      failures,
    );
    equalCheck(
      summary.instant.samples,
      instant.length,
      "Instant sample count",
      failures,
    );
    equalCheck(
      summary.balanced.samples,
      balanced.length,
      "Balanced sample count",
      failures,
    );
    if (instant.length > 0) {
      equalCheck(
        summary.instant.p95Ms,
        percentile(
          instant.map((record) => record.wallElapsedMs),
          0.95,
        ),
        "Instant p95",
        failures,
      );
    }
    if (balanced.length > 0) {
      equalCheck(
        summary.balanced.p95Ms,
        percentile(
          balanced.map((record) => record.wallElapsedMs),
          0.95,
        ),
        "Balanced p95",
        failures,
      );
    }

    const instantPayloads = [
      ...new Set(instant.map((record) => record.payloadHash)),
    ];
    const balancedPayloads = [
      ...new Set(balanced.map((record) => record.payloadHash)),
    ];
    equalCheck(
      JSON.stringify(summary.instant.payloadHashes),
      JSON.stringify(instantPayloads),
      "Instant payload hashes",
      failures,
    );
    equalCheck(
      JSON.stringify(summary.balanced.payloadHashes),
      JSON.stringify(balancedPayloads),
      "Balanced payload hashes",
      failures,
    );

    const expectedChecks = {
      instantInternalDeadlineP95Pass:
        summary.instant.p95Ms <=
        summary.thresholds.instantInternalDeadlineP95Ms,
      balancedInternalDeadlineP95Pass:
        summary.balanced.p95Ms <=
        summary.thresholds.balancedInternalDeadlineP95Ms,
      instantServiceP95Pass:
        summary.instant.p95Ms <=
        summary.thresholds.instantValidRecommendationP95Ms,
      balancedServiceP95Pass:
        summary.balanced.p95Ms <=
        summary.thresholds.balancedValidRecommendationP95Ms,
      deterministicPayloads:
        instantPayloads.length === 1 && balancedPayloads.length === 1,
      zeroFailures:
        records.length === summary.instant.samples + summary.balanced.samples,
    };
    for (const [name, expected] of Object.entries(expectedChecks)) {
      equalCheck(
        summary.gate[name as keyof typeof expectedChecks],
        expected,
        `Gate ${name}`,
        failures,
      );
    }
    equalCheck(
      summary.gate.overallPass,
      Object.values(expectedChecks).every(Boolean),
      "Overall gate",
      failures,
    );
  }

  const result = {
    schemaVersion: 1,
    runDirectory,
    valid: failures.length === 0,
    overallGatePass: summary?.gate.overallPass ?? false,
    filesChecked: EXPECTED_PAYLOAD_FILES.length,
    recordsChecked: records.length,
    failures,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid || !result.overallGatePass) {
    process.exitCode = 1;
  }
}

await main();
