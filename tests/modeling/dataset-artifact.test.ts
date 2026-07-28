import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SourceSnapshot } from "../../src/evaluation/artifacts";
import {
  createBehaviorDatasetPlan,
  runBehaviorFitDataset,
} from "../../src/modeling/behavior-dataset";
import {
  readVerifiedBehaviorDatasetArtifacts,
  verifyBehaviorDatasetArtifacts,
  writeBehaviorDatasetArtifacts,
} from "../../src/modeling/dataset-artifact";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bhabhi-behavior-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const source: SourceSnapshot = {
  sourceSnapshotSha256: "a".repeat(64),
  sourceFileCount: 123,
  gitCommit: "b".repeat(40),
  gitStatusSha256: "c".repeat(64),
  gitDirty: false,
};

function tinyDataset() {
  const plan = createBehaviorDatasetPlan({
    runId: "phase8-behavior-artifact-test",
    split: "train",
    styleCellIds: ["c01_random__random"],
    rotations: [0],
    baseCount: 1,
    opponentDecisionOrdinals: [2],
    worldCounts: [4],
  });
  return runBehaviorFitDataset({ plan });
}

describe("Phase 8 behavior dataset artifacts", () => {
  it("writes once and round-trips a complete public-only dataset", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "run");
    const dataset = tinyDataset();
    const manifest = await writeBehaviorDatasetArtifacts({
      directory,
      dataset,
      source,
      command: "npm run model:dataset -- --split train --development",
      createdAt: "2026-07-28T12:00:00.000Z",
    });

    const verification = await verifyBehaviorDatasetArtifacts(directory);
    const loaded = await readVerifiedBehaviorDatasetArtifacts(directory);
    expect(verification).toMatchObject({
      valid: true,
      failures: [],
    });
    expect(loaded.manifest).toEqual(manifest);
    expect(loaded.dataset.observations).toEqual(dataset.observations);
    expect(loaded.dataset.games).toEqual(dataset.games);
    expect(loaded.dataset.failures).toEqual([]);
    expect(manifest.publicOnlyGate).toBe(true);
    expect(manifest.completeScheduleGate).toBe(true);
    await expect(
      writeBehaviorDatasetArtifacts({
        directory,
        dataset,
        source,
        command: "duplicate",
      }),
    ).rejects.toThrow();
  });

  it("detects payload mutation through cryptographic checksums", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "run");
    await writeBehaviorDatasetArtifacts({
      directory,
      dataset: tinyDataset(),
      source,
      command: "artifact-mutation-test",
      createdAt: "2026-07-28T12:00:00.000Z",
    });
    const observationsPath = join(directory, "observations.ndjson");
    const original = await readFile(observationsPath, "utf8");
    await writeFile(observationsPath, original.replace("c01", "c02"), "utf8");

    const verification = await verifyBehaviorDatasetArtifacts(directory);
    expect(verification.valid).toBe(false);
    expect(verification.failures.join(" ")).toMatch(/checksum/u);
  });
});
