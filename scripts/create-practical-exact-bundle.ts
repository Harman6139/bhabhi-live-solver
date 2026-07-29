import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { captureSourceSnapshot } from "../src/evaluation/artifacts";
import {
  freezePhase8Manifest,
  phase8Sha256,
} from "../src/evaluation/phase8-manifest";
import {
  createPhase8TerminalConfigurationDescriptor,
  PHASE8_TERMINAL_EXACT_ID,
  PHASE8_TERMINAL_REFERENCE_ID,
} from "../src/evaluation/phase8-terminal-policy";
import { stableStringify } from "../src/events/stable-hash";
import {
  createPhase8HardOnlyModel,
  serializePhase8HardOnlyModel,
} from "../src/modeling/hard-only-model";
import {
  PRODUCTION_RELEASE_BUNDLE_VERSION,
  verifyProductionReleaseBundle,
  type EvaluationProductionBundle,
  type ProductionArtifactEnvelope,
} from "../src/production/release-contract";

function required(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function envelope(bytes: string): ProductionArtifactEnvelope {
  return { bytes, sha256: sha256(bytes) };
}

async function main(): Promise<void> {
  const output = resolve(required("--output"));
  const source = await captureSourceSnapshot(resolve("."));
  const modelBytes = serializePhase8HardOnlyModel(
    createPhase8HardOnlyModel(source.sourceSnapshotSha256),
  );
  const configurations = [
    createPhase8TerminalConfigurationDescriptor({
      configId: PHASE8_TERMINAL_REFERENCE_ID,
    }),
    createPhase8TerminalConfigurationDescriptor({
      configId: PHASE8_TERMINAL_EXACT_ID,
    }),
  ];
  const authority = freezePhase8Manifest({
    manifestId: `practical-exact-${source.sourceSnapshotSha256.slice(0, 16)}`,
    createdAt: new Date().toISOString(),
    sourceSha256: source.sourceSnapshotSha256,
    sourceFileCount: source.sourceFileCount,
    modelSha256: sha256(modelBytes),
    scorerSha256: phase8Sha256({
      purpose: "practical-local-exact-play",
    }),
    reportSha256: phase8Sha256({
      purpose: "practical-local-exact-play-ui",
    }),
    preregistrationSha256: phase8Sha256({
      purpose: "practical-play-not-release-evidence",
    }),
    configurations,
    splits: {
      train: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      tune: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      qualification: { baseIndexStart: 0, eventCap: 4_096 },
    },
    qualificationSampleSize: {
      verifiedDevelopmentVarianceArtifactSha256: phase8Sha256({
        purpose: "practical-play-placeholder",
      }),
      maxPairedClusterStandardDeviation: 0,
    },
  });
  const descriptor = authority.manifest.configurations.find(
    (candidate) => candidate.configId === PHASE8_TERMINAL_EXACT_ID,
  );
  if (descriptor === undefined) {
    throw new Error("Practical exact descriptor was not created.");
  }
  const bundle: EvaluationProductionBundle = {
    schemaVersion: 1,
    releaseVersion: PRODUCTION_RELEASE_BUNDLE_VERSION,
    mode: "evaluation-only",
    scope: "qualification",
    sourceHash: authority.manifest.hashes.sourceSha256,
    protocolHash: authority.manifest.hashes.preregistrationSha256,
    manifest: envelope(stableStringify(authority.manifest)),
    descriptor: envelope(stableStringify(descriptor)),
    productionModel: envelope(modelBytes),
  };
  await verifyProductionReleaseBundle(bundle, { allowEvaluationOnly: true });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${stableStringify(bundle)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      output,
      selectedConfigId: descriptor.configId,
      sourceSha256: source.sourceSnapshotSha256,
    })}\n`,
  );
}

await main();
