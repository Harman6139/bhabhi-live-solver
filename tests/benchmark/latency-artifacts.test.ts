import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  latencyRunManifestSchema,
  verifyLatencyArtifacts,
  writeLatencyArtifacts,
} from "../../src/benchmark/node";
import {
  FIXTURE_RUN_ID,
  fixtureCorpus,
  fixtureEnvironment,
  fixturePhase8Manifest,
  fixtureRecords,
  fixtureRunManifest,
} from "./fixtures";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bhabhi-latency-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("Phase 8 immutable latency artifacts", () => {
  it("cannot relabel the baseline-only production worker as an advanced role", () => {
    const phase8Manifest = fixturePhase8Manifest();
    const corpus = fixtureCorpus(phase8Manifest);
    const baseline = fixtureRunManifest(phase8Manifest, corpus);
    const parsed = latencyRunManifestSchema.safeParse({
      ...baseline,
      configId: "p8-e-exact-hard-fallback-v1",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.map((issue) => issue.message).join("\n"),
      ).toMatch(/currently executes only p8-r-hard-balanced-v1/u);
    }
  });

  it("writes once and verifies checksums plus regenerated summary", async () => {
    const parentDirectory = await temporaryDirectory();
    const phase8Manifest = fixturePhase8Manifest();
    const corpus = fixtureCorpus(phase8Manifest);
    const manifest = fixtureRunManifest(phase8Manifest, corpus);
    const result = await writeLatencyArtifacts({
      parentDirectory,
      manifest,
      environment: fixtureEnvironment(),
      corpus,
      records: fixtureRecords(),
      failures: [],
    });

    const verification = await verifyLatencyArtifacts(result.runDirectory);
    expect(verification).toMatchObject({
      valid: true,
      recordsValidated: 11,
      failures: [],
    });
    expect(verification.reproductionDigest).toBe(
      result.summary.reproductionDigest,
    );
    expect(
      await readFile(join(result.runDirectory, "command.txt"), "utf8"),
    ).toBe(`${manifest.command}\n`);
  });

  it("rejects overwrite and detects an in-place artifact mutation", async () => {
    const parentDirectory = await temporaryDirectory();
    const phase8Manifest = fixturePhase8Manifest();
    const corpus = fixtureCorpus(phase8Manifest);
    const input = {
      parentDirectory,
      manifest: fixtureRunManifest(phase8Manifest, corpus),
      environment: fixtureEnvironment(),
      corpus,
      records: fixtureRecords(),
      failures: [],
    };
    const result = await writeLatencyArtifacts(input);

    await expect(writeLatencyArtifacts(input)).rejects.toThrow(
      /Immutable latency artifact already exists/u,
    );

    const summaryPath = join(result.runDirectory, "summary.json");
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Record<
      string,
      unknown
    >;
    summary.runId = `${FIXTURE_RUN_ID}-mutated`;
    await writeFile(summaryPath, `${JSON.stringify(summary)}\n`, "utf8");

    const verification = await verifyLatencyArtifacts(result.runDirectory);
    expect(verification.valid).toBe(false);
    expect(verification.failures.join("\n")).toMatch(
      /SHA-256 mismatch|deterministic regeneration/u,
    );
  });
});
