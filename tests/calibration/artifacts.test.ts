import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  calibrationFailureRecordSchema,
  calibrationManifestSchema,
  calibrationPredictionRecordSchema,
  calibrationSeedRecordSchema,
  calibrationSummarySchema,
  calibrationTruthRecordSchema,
  PHASE6_BEHAVIOR_DISABLED_REASON,
} from "../../src/calibration/artifact-schema";
import {
  calibrationReproductionDigest,
  validateCalibrationArtifactRun,
  validateCalibrationSeedSchedule,
  verifyCalibrationArtifacts,
  writeCalibrationArtifacts,
  type CalibrationArtifactRun,
} from "../../src/calibration/artifacts";
import { createPhase6CalibrationPlan } from "../../src/calibration/protocol";
import {
  buildPhase6CalibrationArtifactRun,
  renderPhase6CalibrationCommand,
  assertPhase6CalibrationSourceUnchanged,
} from "../../src/calibration/run-artifacts";
import { runPhase6Calibration } from "../../src/calibration/runner";
import { renderCalibrationSummaryMarkdown } from "../../src/calibration/summary";
import { stableStringify } from "../../src/events/stable-hash";

const PAYLOAD_FILES = [
  "calibration-predictions.ndjson",
  "command.txt",
  "environment.json",
  "failures.ndjson",
  "logs/run.log",
  "manifest.json",
  "seeds.ndjson",
  "summary.json",
  "summary.md",
  "truth.eval-only.ndjson",
] as const;

const temporaryDirectories: string[] = [];
let canonicalRun: CalibrationArtifactRun;
let smallRun: CalibrationArtifactRun;
let writtenDirectory: string;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function ndjson(values: readonly unknown[]): string {
  return values.length === 0
    ? ""
    : `${values.map((value) => stableStringify(value)).join("\n")}\n`;
}

function withoutRunId<T extends { readonly runId: string }>(
  record: T,
): Omit<T, "runId"> {
  const scientific = { ...record } as Record<string, unknown>;
  delete scientific.runId;
  return scientific as Omit<T, "runId">;
}

function parseNdjson<T>(
  value: string,
  parser: { parse(input: unknown): T },
): T[] {
  return value
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => parser.parse(JSON.parse(line) as unknown));
}

async function rewriteChecksums(directory: string): Promise<void> {
  const lines = await Promise.all(
    PAYLOAD_FILES.map(async (name) => {
      const bytes = await readFile(join(directory, name));
      return `${sha256(bytes)}  ${name}`;
    }),
  );
  await writeFile(
    join(directory, "checksums.sha256"),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

beforeAll(async () => {
  const result = runPhase6Calibration(
    createPhase6CalibrationPlan({
      runId: "phase6-artifact-canonical-test",
      split: "dev",
      hardWorldSamples: 1,
    }),
  );
  expect(result.failures).toEqual([]);
  canonicalRun = await buildPhase6CalibrationArtifactRun(result, {
    command: renderPhase6CalibrationCommand([
      "--run-id",
      result.plan.runId,
      "--split",
      "dev",
      "--worlds",
      "1",
    ]),
    createdAt: "2026-07-28T00:00:00.000Z",
    bootstrapResamples: 64,
    powerMode: "test",
  });
  const root = await mkdtemp(join(tmpdir(), "bhabhi-phase6-artifacts-"));
  temporaryDirectories.push(root);
  writtenDirectory = (await writeCalibrationArtifacts(canonicalRun, root))
    .runDirectory;
  const smallBase = createPhase6CalibrationPlan({
    runId: "phase6-artifact-small-test",
    split: "dev",
    hardWorldSamples: 1,
  });
  const canonicalConditional = canonicalRun.predictions.find(
    (prediction) =>
      prediction.target.kind === "query" &&
      prediction.target.family === "conditional",
  );
  const conditionalSeed = canonicalRun.seeds.find(
    (seed) => seed.gameId === canonicalConditional?.gameId,
  );
  if (conditionalSeed === undefined) {
    throw new Error(
      "Canonical artifact fixture has no conditional schedule coordinate.",
    );
  }
  const smallResult = runPhase6Calibration({
    ...smallBase,
    styleCellIds: [conditionalSeed.styleCellId],
    rotations: [conditionalSeed.rotation],
  });
  expect(smallResult.failures).toEqual([]);
  smallRun = await buildPhase6CalibrationArtifactRun(smallResult, {
    command: renderPhase6CalibrationCommand([
      "--run-id",
      smallResult.plan.runId,
    ]),
    createdAt: "2026-07-28T00:00:00.000Z",
    bootstrapResamples: 16,
    powerMode: "test",
  });
}, 180_000);

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("calibration artifact schemas", () => {
  it("keeps predictions truth-free and pins conditional denominator semantics", () => {
    const prediction = canonicalRun.predictions[0];
    if (prediction === undefined) {
      throw new Error("Canonical run contains no predictions.");
    }
    expect(prediction).not.toHaveProperty("targetLabel");
    expect(prediction).not.toHaveProperty("trueOpponentModels");
    expect(() =>
      calibrationPredictionRecordSchema.parse({
        ...prediction,
        targetLabel: "forbidden",
      }),
    ).toThrow();

    const conditional = canonicalRun.predictions.find(
      (record) =>
        record.target.kind === "query" &&
        record.target.family === "conditional",
    );
    if (conditional !== undefined) {
      expect(conditional.armConditioningProbability).not.toBeNull();
      expect(() =>
        calibrationPredictionRecordSchema.parse({
          ...conditional,
          armConditioningProbability: null,
        }),
      ).toThrow();
      expect(() =>
        calibrationPredictionRecordSchema.parse({
          ...prediction,
          armConditioningProbability: 0.5,
        }),
      ).toThrow();
    }
  });

  it("rejects Phase 8 evidence claims at the Phase 6 artifact boundary", () => {
    expect(() =>
      calibrationManifestSchema.parse({
        ...canonicalRun.manifest,
        split: "final",
        evidenceEligible: true,
      }),
    ).toThrow();
    expect(canonicalRun.manifest).toMatchObject({
      split: "dev",
      evidenceClass: "phase6-calibration-smoke",
      evidenceEligible: false,
      behaviorProductionEnabled: false,
      behaviorEnablementReason: PHASE6_BEHAVIOR_DISABLED_REASON,
      rotations: [0, 1, 2],
      opponentDecisionOrdinals: [2, 5, 8],
      fixedPublicEventOrdinals: [12, 24, 36],
      actualCheckpointClassCounts: {
        initial: 51,
        postOpening: 51,
        fixedPublicEvent: 153,
        postThulla: 51,
        postVisiblePickup: 51,
        preOpponentChoice: 306,
      },
    });
  });
});

describe("calibration artifact integrity", () => {
  it("validates the full frozen schedule and independently replays every truth row", async () => {
    expect(validateCalibrationArtifactRun(canonicalRun)).toEqual([]);
    const verification = await verifyCalibrationArtifacts(writtenDirectory);
    expect(verification).toMatchObject({
      valid: true,
      checkedFiles: 10,
      seedsValidated: 51,
      failures: [],
      reproductionDigest: canonicalRun.summary.reproductionDigest,
    });
    expect(verification.predictionsValidated).toBeGreaterThan(40_000);
    expect(verification.pairsValidated).toBeGreaterThan(20_000);
  }, 180_000);

  it("rejects mismatched arm, seed-coordinate, and denominator metadata", () => {
    const pairId = smallRun.predictions[0]?.pairId;
    const pair = smallRun.predictions.filter(
      (prediction) => prediction.pairId === pairId,
    );
    const behavioral = pair.find(
      (prediction) => prediction.arm === "behavioral",
    );
    if (behavioral === undefined) {
      throw new Error("Canonical run has no behavioral arm.");
    }
    const armMutations = [
      {
        ...behavioral,
        worldOccurrences: behavioral.worldOccurrences + 1,
      },
      {
        ...behavioral,
        uniqueWitnesses: behavioral.uniqueWitnesses + 1,
      },
      {
        ...behavioral,
        hardWorldSetChecksum: "mismatched-world-set-checksum",
      },
      {
        ...behavioral,
        hardBeliefConfigHash: "mismatched-hard-config",
      },
      {
        ...behavioral,
        configHash: "mismatched-behavior-config",
      },
    ];
    for (const mutatedArm of armMutations) {
      const mismatch: CalibrationArtifactRun = {
        ...smallRun,
        predictions: smallRun.predictions.map((prediction) =>
          prediction.predictionId === behavioral.predictionId
            ? mutatedArm
            : prediction,
        ),
      };
      expect(validateCalibrationArtifactRun(mismatch)).toContain(
        `${behavioral.pairId} arms do not describe the same target/state.`,
      );
    }

    const coordinateMismatch: CalibrationArtifactRun = {
      ...smallRun,
      predictions: smallRun.predictions.map((prediction, index) =>
        index === 0
          ? { ...prediction, scenarioId: "scenario:wrong-seed-coordinate" }
          : prediction,
      ),
    };
    expect(
      validateCalibrationArtifactRun(coordinateMismatch).some((failure) =>
        failure.includes("scenario or calibration cluster differs"),
      ),
    ).toBe(true);

    const conditional = smallRun.predictions.find(
      (prediction) =>
        prediction.target.kind === "query" &&
        prediction.target.family === "conditional",
    );
    if (conditional === undefined) {
      throw new Error("Small artifact fixture has no conditional prediction.");
    }
    const belowFloor: CalibrationArtifactRun = {
      ...smallRun,
      predictions: smallRun.predictions.map((prediction) =>
        prediction.predictionId === conditional.predictionId
          ? { ...prediction, armConditioningProbability: 0 }
          : prediction,
      ),
    };
    expect(
      validateCalibrationArtifactRun(belowFloor).some((failure) =>
        failure.includes("arm-specific conditional denominator"),
      ),
    ).toBe(true);

    if (smallRun.truths.length === 0) {
      throw new Error("Small artifact fixture has no truth record.");
    }
    const wrongTruthModels: CalibrationArtifactRun = {
      ...smallRun,
      truths: smallRun.truths.map((truth, index) =>
        index === 0
          ? {
              ...truth,
              trueOpponentModels: {
                p2: "wrong-model",
                p3: truth.trueOpponentModels.p3,
              },
            }
          : truth,
      ),
    };
    expect(
      validateCalibrationArtifactRun(wrongTruthModels).some((failure) =>
        failure.includes("opponent models differ"),
      ),
    ).toBe(true);

    const wrongManifest: CalibrationArtifactRun = {
      ...smallRun,
      manifest: {
        ...smallRun.manifest,
        rulesHash: "wrong-rules-hash",
        behaviorConfigHash: "wrong-behavior-config",
        expectedCounts: {
          ...smallRun.manifest.expectedCounts,
          predictions: smallRun.manifest.expectedCounts.predictions + 1,
        },
        rawStreamsSha256: {
          ...smallRun.manifest.rawStreamsSha256,
          truthsSha256: "f".repeat(64),
        },
      },
    };
    const manifestFailures = validateCalibrationArtifactRun(wrongManifest);
    expect(
      manifestFailures.some((failure) =>
        failure.includes("hash does not regenerate"),
      ),
    ).toBe(true);
    expect(
      manifestFailures.some((failure) =>
        failure.includes("raw-stream SHA-256"),
      ),
    ).toBe(true);
    expect(
      manifestFailures.some((failure) =>
        failure.includes("frozen behavior configuration"),
      ),
    ).toBe(true);
  }, 30_000);

  it("rejects a missing, duplicated, or reordered schedule coordinate", () => {
    const missing = canonicalRun.seeds.slice(1);
    expect(
      validateCalibrationSeedSchedule(canonicalRun.manifest, missing),
    ).toEqual([
      "Calibration seeds do not match the exact frozen cell/base/rotation cross-product and deterministic seed derivation.",
    ]);
    const firstSeed = canonicalRun.seeds[0];
    if (firstSeed === undefined) {
      throw new Error("Canonical schedule is unexpectedly empty.");
    }
    const duplicate = [firstSeed, ...canonicalRun.seeds.slice(0, -1)];
    expect(
      validateCalibrationSeedSchedule(canonicalRun.manifest, duplicate),
    ).toHaveLength(1);
    const swapped = [...canonicalRun.seeds];
    const first = swapped[0];
    const second = swapped[1];
    if (first === undefined || second === undefined) {
      throw new Error("Canonical schedule is unexpectedly short.");
    }
    swapped[0] = second;
    swapped[1] = first;
    expect(
      validateCalibrationSeedSchedule(canonicalRun.manifest, swapped),
    ).toHaveLength(1);
  });

  it("detects coherent truth and derived-text tampering after checksums are regenerated", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "bhabhi-phase6-coherent-tamper-"),
    );
    temporaryDirectories.push(parent);
    const tamperedDirectory = join(parent, canonicalRun.manifest.runId);
    await mkdir(parent, { recursive: true });
    await cp(writtenDirectory, tamperedDirectory, { recursive: true });

    const seeds = parseNdjson(
      await readFile(join(tamperedDirectory, "seeds.ndjson"), "utf8"),
      calibrationSeedRecordSchema,
    );
    const predictions = parseNdjson(
      await readFile(
        join(tamperedDirectory, "calibration-predictions.ndjson"),
        "utf8",
      ),
      calibrationPredictionRecordSchema,
    );
    const truths = parseNdjson(
      await readFile(join(tamperedDirectory, "truth.eval-only.ndjson"), "utf8"),
      calibrationTruthRecordSchema,
    );
    const failures = parseNdjson(
      await readFile(join(tamperedDirectory, "failures.ndjson"), "utf8"),
      calibrationFailureRecordSchema,
    );
    const firstTruth = truths[0];
    if (firstTruth === undefined) {
      throw new Error("Canonical run contains no truth rows.");
    }
    truths[0] = {
      ...firstTruth,
      truthStateHash: "tampered-but-schema-valid-truth-state",
    };
    const truthText = ndjson(truths);
    await writeFile(
      join(tamperedDirectory, "truth.eval-only.ndjson"),
      truthText,
      "utf8",
    );

    const manifest = calibrationManifestSchema.parse(
      JSON.parse(
        await readFile(join(tamperedDirectory, "manifest.json"), "utf8"),
      ) as unknown,
    );
    const rewrittenManifest = {
      ...manifest,
      rawStreamsSha256: {
        ...manifest.rawStreamsSha256,
        truthsSha256: sha256(truthText),
      },
    };
    await writeFile(
      join(tamperedDirectory, "manifest.json"),
      `${stableStringify(rewrittenManifest)}\n`,
      "utf8",
    );

    const summary = calibrationSummarySchema.parse(
      JSON.parse(
        await readFile(join(tamperedDirectory, "summary.json"), "utf8"),
      ) as unknown,
    );
    const rewrittenSummary = calibrationSummarySchema.parse({
      ...summary,
      reproductionDigest: calibrationReproductionDigest({
        seeds,
        predictions,
        truths,
        failures,
      }),
    });
    await writeFile(
      join(tamperedDirectory, "summary.json"),
      `${stableStringify(rewrittenSummary)}\n`,
      "utf8",
    );
    await writeFile(
      join(tamperedDirectory, "summary.md"),
      `${renderCalibrationSummaryMarkdown(rewrittenSummary)}tampered\n`,
      "utf8",
    );
    await writeFile(
      join(tamperedDirectory, "logs/run.log"),
      `${canonicalRun.log}tampered\n`,
      "utf8",
    );
    await writeFile(
      join(tamperedDirectory, "command.txt"),
      "not-the-manifest-command\n",
      "utf8",
    );
    await rewriteChecksums(tamperedDirectory);

    const verification = await verifyCalibrationArtifacts(tamperedDirectory);
    expect(verification.valid).toBe(false);
    expect(verification.failures).toEqual(
      expect.arrayContaining([
        "command.txt does not regenerate from manifest.command.",
        "Summary markdown or run log does not regenerate byte-for-byte.",
        "Deterministic seeded replay does not reproduce raw seeds, predictions, eval-only truth, failures, counts, or checkpoint classes.",
      ]),
    );
  }, 180_000);
});

describe("calibration reproducibility controls", () => {
  it("uses a runnable tokenized command and rejects a source snapshot race", () => {
    expect(
      renderPhase6CalibrationCommand([
        "--run-id",
        "phase6-command-test",
        "--split",
        "dev",
      ]),
    ).toBe(
      "npm run eval:calibration -- --run-id phase6-command-test --split dev",
    );
    const before = {
      sourceSnapshotSha256: "a".repeat(64),
      sourceFileCount: 1,
      gitCommit: null,
      gitStatusSha256: "b".repeat(64),
      gitDirty: true,
    };
    expect(() =>
      assertPhase6CalibrationSourceUnchanged(before, {
        ...before,
        sourceSnapshotSha256: "c".repeat(64),
      }),
    ).toThrow(/changed during calibration execution/iu);
  });

  it("keeps scientific digest and bootstrap intervals invariant to runId", async () => {
    async function tinyRun(runId: string): Promise<CalibrationArtifactRun> {
      const base = createPhase6CalibrationPlan({
        runId,
        split: "dev",
        hardWorldSamples: 4,
      });
      const plan = {
        ...base,
        styleCellIds: [base.styleCellIds[0] ?? "c01_random__random"],
        rotations: [0],
      } as const;
      const result = runPhase6Calibration(plan);
      expect(result.failures).toEqual([]);
      return buildPhase6CalibrationArtifactRun(result, {
        command: renderPhase6CalibrationCommand(["--run-id", runId]),
        createdAt: "2026-07-28T00:00:00.000Z",
        bootstrapResamples: 64,
        powerMode: "test",
      });
    }
    const first = await tinyRun("phase6-reproduction-a");
    const second = await tinyRun("phase6-reproduction-b");
    expect(first.summary.reproductionDigest).toBe(
      second.summary.reproductionDigest,
    );
    expect(first.summary.pairedDifferences).toEqual(
      second.summary.pairedDifferences,
    );
    expect(first.predictions.map(withoutRunId)).toEqual(
      second.predictions.map(withoutRunId),
    );
  }, 60_000);
});
