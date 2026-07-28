import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { stableStringify } from "../../src/events/stable-hash";
import {
  createPhase8HardOnlyModel,
  serializePhase8HardOnlyModel,
} from "../../src/modeling/hard-only-model";
import {
  freezePhase8Manifest,
  phase8Sha256,
} from "../../src/evaluation/phase8-manifest";
import {
  createPhase8TerminalConfigurationDescriptor,
  PHASE8_TERMINAL_REFERENCE_ID,
} from "../../src/evaluation/phase8-terminal-policy";
import {
  PRODUCTION_RELEASE_BUNDLE_VERSION,
  ProductionReleaseError,
  verifyProductionReleaseBundle,
  type EvaluationProductionBundle,
  type ProductionArtifactEnvelope,
} from "../../src/production/release-contract";

function envelope(bytes: string): ProductionArtifactEnvelope {
  return {
    bytes,
    sha256: createHash("sha256").update(bytes, "utf8").digest("hex"),
  };
}

function fixture(): EvaluationProductionBundle {
  const sourceHash = "a".repeat(64);
  const modelBytes = serializePhase8HardOnlyModel(
    createPhase8HardOnlyModel(sourceHash),
  );
  const descriptor = createPhase8TerminalConfigurationDescriptor({
    configId: PHASE8_TERMINAL_REFERENCE_ID,
  });
  const authority = freezePhase8Manifest({
    manifestId: "phase8-hard-only-release-test",
    createdAt: "2026-07-28T12:00:00.000Z",
    sourceSha256: sourceHash,
    sourceFileCount: 1,
    modelSha256: envelope(modelBytes).sha256,
    scorerSha256: "b".repeat(64),
    reportSha256: "c".repeat(64),
    preregistrationSha256: "d".repeat(64),
    configurations: [descriptor],
    splits: {
      train: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      tune: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      qualification: { baseIndexStart: 0, eventCap: 4_096 },
    },
    qualificationSampleSize: {
      verifiedDevelopmentVarianceArtifactSha256: "e".repeat(64),
      maxPairedClusterStandardDeviation: 0,
    },
  });
  expect(authority.manifest.hashes.configSha256).toBe(
    phase8Sha256([descriptor]),
  );
  return {
    schemaVersion: 1,
    releaseVersion: PRODUCTION_RELEASE_BUNDLE_VERSION,
    mode: "evaluation-only",
    scope: "qualification",
    sourceHash,
    protocolHash: authority.manifest.hashes.preregistrationSha256,
    manifest: envelope(stableStringify(authority.manifest)),
    descriptor: envelope(stableStringify(descriptor)),
    productionModel: envelope(modelBytes),
  };
}

describe("hard-only production release binding", () => {
  it("accepts the explicit model-not-applicable marker only at the evaluation boundary", async () => {
    const bundle = fixture();
    const verified = await verifyProductionReleaseBundle(bundle, {
      allowEvaluationOnly: true,
    });
    expect(verified).toMatchObject({
      descriptor: { configId: PHASE8_TERMINAL_REFERENCE_ID },
      manifestScope: "qualification",
      modelArtifact: null,
      modelConfig: null,
      binding: {
        bundleMode: "evaluation-only",
        selectedConfigId: PHASE8_TERMINAL_REFERENCE_ID,
      },
    });
    await expect(verifyProductionReleaseBundle(bundle)).rejects.toMatchObject({
      code: "EVALUATION_BUNDLE_FORBIDDEN",
    } satisfies Partial<ProductionReleaseError>);
  });

  it("rejects a canonical marker bound to another source", async () => {
    const bundle = fixture();
    const wrongBytes = serializePhase8HardOnlyModel(
      createPhase8HardOnlyModel("f".repeat(64)),
    );
    await expect(
      verifyProductionReleaseBundle(
        { ...bundle, productionModel: envelope(wrongBytes) },
        { allowEvaluationOnly: true },
      ),
    ).rejects.toMatchObject({ code: "INVALID_RELEASE" });
  });
});
