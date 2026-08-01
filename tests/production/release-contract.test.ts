import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { stableStringify } from "../../src/events/stable-hash";
import {
  createPhase8HardOnlyModel,
  serializePhase8HardOnlyModel,
} from "../../src/modeling/hard-only-model";
import {
  createPhase8ConfigurationDescriptor,
  freezePhase8Manifest,
  phase8Sha256,
} from "../../src/evaluation/phase8-manifest";
import {
  createPhase8TerminalConfigurationDescriptor,
  PHASE8_TERMINAL_BEHAVIOR_ID,
  PHASE8_TERMINAL_REFERENCE_ID,
} from "../../src/evaluation/phase8-terminal-policy";
import {
  createPhase8PracticalBehaviorModelArtifact,
  serializePhase8PracticalBehaviorModelArtifact,
} from "../../src/modeling/practical-behavior-model";
import { parsePhase8ProductionModelArtifact } from "../../src/modeling/production-model";
import {
  PRODUCTION_RELEASE_BUNDLE_VERSION,
  ProductionReleaseError,
  verifyProductionReleaseBundle,
  type EvaluationProductionBundle,
  type ProductionArtifactEnvelope,
} from "../../src/production/release-contract";
import {
  phase8TerminalDescriptors,
  phase8TerminalProductionFixture,
} from "../evaluation/phase8-terminal-fixtures";

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

function practicalBehaviorFixture(): EvaluationProductionBundle {
  const sealedModel = phase8TerminalProductionFixture();
  const sealedArtifact = parsePhase8ProductionModelArtifact(
    sealedModel.serialized,
  );
  const practicalBytes = serializePhase8PracticalBehaviorModelArtifact(
    createPhase8PracticalBehaviorModelArtifact(sealedArtifact.payload.behavior),
  );
  const practicalModel = envelope(practicalBytes);
  const sealedDescriptors = phase8TerminalDescriptors(sealedModel, [
    PHASE8_TERMINAL_REFERENCE_ID,
    PHASE8_TERMINAL_BEHAVIOR_ID,
  ]);
  const reference = sealedDescriptors[0];
  const sealedBehavior = sealedDescriptors[1];
  if (reference === undefined || sealedBehavior === undefined) {
    throw new Error("Practical release test descriptor fixture is incomplete.");
  }
  const descriptor = createPhase8ConfigurationDescriptor({
    configId: sealedBehavior.configId,
    label: sealedBehavior.label,
    role: sealedBehavior.role,
    budgetId: sealedBehavior.budgetId,
    components: sealedBehavior.components,
    implementation: {
      ...sealedBehavior.implementation,
      productionModelSha256: practicalModel.sha256,
    },
  });
  const sourceHash = sealedArtifact.payload.behavior.payload.sourceHash;
  const authority = freezePhase8Manifest({
    manifestId: "phase8-practical-behavior-release-test",
    createdAt: "2026-08-01T12:00:00.000Z",
    sourceSha256: sourceHash,
    sourceFileCount: 1,
    modelSha256: practicalModel.sha256,
    scorerSha256: "b".repeat(64),
    reportSha256: "c".repeat(64),
    preregistrationSha256: "d".repeat(64),
    configurations: [reference, descriptor],
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
  return {
    schemaVersion: 1,
    releaseVersion: PRODUCTION_RELEASE_BUNDLE_VERSION,
    mode: "evaluation-only",
    scope: "qualification",
    sourceHash,
    protocolHash: authority.manifest.hashes.preregistrationSha256,
    manifest: envelope(stableStringify(authority.manifest)),
    descriptor: envelope(stableStringify(descriptor)),
    productionModel: practicalModel,
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

describe("practical behavior release boundary", () => {
  it("accepts the explicit unsealed artifact only with evaluation opt-in", async () => {
    const bundle = practicalBehaviorFixture();
    const verified = await verifyProductionReleaseBundle(bundle, {
      allowEvaluationOnly: true,
    });
    expect(verified).toMatchObject({
      descriptor: { configId: PHASE8_TERMINAL_BEHAVIOR_ID },
      modelArtifact: {
        artifactKind: "phase8-practical-unsealed-behavior-model",
        payload: {
          caveats: { releaseSelectedEligible: false },
          supportRegularizer: { pseudocountPerFeasibleLabel: 1 },
        },
      },
      modelConfig: {
        supportRegularizer: { pseudocountPerFeasibleLabel: 1 },
      },
    });
    await expect(verifyProductionReleaseBundle(bundle)).rejects.toMatchObject({
      code: "EVALUATION_BUNDLE_FORBIDDEN",
    } satisfies Partial<ProductionReleaseError>);
  });

  it("rejects the unsealed artifact at the release-selected boundary", async () => {
    const evaluationBundle = practicalBehaviorFixture();
    const bundle = Object.fromEntries(
      Object.entries(evaluationBundle).filter(([key]) => key !== "scope"),
    );
    await expect(
      verifyProductionReleaseBundle({
        ...bundle,
        mode: "release-selected",
        selectionAttestation: envelope("{}"),
        finalAttestation: envelope("{}"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RELEASE" });
  });
});
