import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { captureSourceSnapshot } from "../src/evaluation/artifacts";
import {
  createPhase8ManifestAuthorityArtifact,
  freezePhase8Manifest,
  openPhase8Split,
  phase8Sha256,
  serializePhase8SplitOpening,
} from "../src/evaluation/phase8-manifest";
import {
  createPhase8TerminalConfigurationDescriptor,
  PHASE8_TERMINAL_BEHAVIOR_EXACT_ID,
  PHASE8_TERMINAL_BEHAVIOR_ID,
  PHASE8_TERMINAL_EXACT_ID,
  PHASE8_TERMINAL_REFERENCE_ID,
} from "../src/evaluation/phase8-terminal-policy";
import { stableStringify } from "../src/events/stable-hash";
import { readPhase8ProductionModelArtifact } from "../src/modeling/artifact-store";
import { serializePhase8ProductionModelArtifact } from "../src/modeling/production-model";

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

async function main(): Promise<void> {
  const modelPath = resolve(required("--model"));
  const output = resolve(required("--output"));
  const source = await captureSourceSnapshot(resolve("."));
  const model = await readPhase8ProductionModelArtifact(modelPath);
  const modelBytes = serializePhase8ProductionModelArtifact(model);
  if (
    source.gitDirty ||
    source.gitCommit === null ||
    source.sourceSnapshotSha256 !==
      model.payload.behavior.payload.sourceHash
  ) {
    throw new Error(
      "Practical authority must be built from the same clean source snapshot as the production model.",
    );
  }
  const preregistrationSha256 = phase8Sha256({
    contract: "b-be-practical-ready-v1",
    retainedRequirements: [
      "canonical-fitted-behavior-model",
      "full-support-regularizer-tune",
      "runtime-truth-firewall",
      "local-only-browser-execution",
    ],
  });
  const authority = freezePhase8Manifest({
    manifestId: `phase8-b-be-practical-${model.payloadChecksum.slice(-16)}`,
    createdAt: new Date().toISOString(),
    sourceSha256: source.sourceSnapshotSha256,
    sourceFileCount: source.sourceFileCount,
    modelSha256: sha256(modelBytes),
    scorerSha256: phase8Sha256({
      purpose: "phase8-terminal-practical-comparison",
    }),
    reportSha256: phase8Sha256({
      purpose: "phase8-practical-browser-and-terminal-report",
    }),
    preregistrationSha256,
    configurations: [
      createPhase8TerminalConfigurationDescriptor({
        configId: PHASE8_TERMINAL_REFERENCE_ID,
      }),
      createPhase8TerminalConfigurationDescriptor({
        configId: PHASE8_TERMINAL_EXACT_ID,
      }),
      createPhase8TerminalConfigurationDescriptor({
        configId: PHASE8_TERMINAL_BEHAVIOR_ID,
        serializedProductionModel: modelBytes,
      }),
      createPhase8TerminalConfigurationDescriptor({
        configId: PHASE8_TERMINAL_BEHAVIOR_EXACT_ID,
        serializedProductionModel: modelBytes,
      }),
    ],
    splits: {
      train: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      tune: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      qualification: { baseIndexStart: 0, eventCap: 4_096 },
    },
    qualificationSampleSize: {
      verifiedDevelopmentVarianceArtifactSha256: phase8Sha256({
        purpose: "practical-minimum-qualification-size",
        note: "Full release sizing deliberately not claimed.",
      }),
      maxPairedClusterStandardDeviation: 0,
    },
  });
  const authorityArtifact = createPhase8ManifestAuthorityArtifact({
    existingTarget: null,
    authority,
  });
  const proof = {
    kind: "qualification" as const,
    preregistrationSha256,
    trainClosureSha256: phase8Sha256({
      kind: "train-closure",
      selectedBehaviorPayloadChecksum:
        model.payload.behavior.payloadChecksum,
    }),
    tuneClosureSha256: phase8Sha256({
      kind: "tune-closure",
      supportSelectionSha256:
        model.payload.supportRegularizerSelection.selectionSha256,
    }),
    sourceValidationArtifactSha256: phase8Sha256({
      kind: "source-validation",
      sourceSha256: source.sourceSnapshotSha256,
      gitCommit: source.gitCommit,
    }),
  };
  const opening = openPhase8Split(authority, {
    split: "qualification",
    proof,
  });
  await mkdir(output, { recursive: false });
  await writeFile(
    resolve(output, "phase8-manifest-authority.json"),
    authorityArtifact.payload,
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    resolve(output, "qualification-manifest.json"),
    `${stableStringify(authority.manifest)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    resolve(output, "qualification-opening.json"),
    serializePhase8SplitOpening(authority, opening, proof),
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    resolve(output, "production-model.sha256"),
    `${sha256(await readFile(modelPath, "utf8"))}  phase8-production-model.json\n`,
    { encoding: "utf8", flag: "wx" },
  );
  console.log(
    JSON.stringify({
      output,
      sourceCommit: source.gitCommit,
      manifestSha256: authority.manifestSha256,
      modelSha256: authority.manifest.hashes.modelSha256,
      configurations: authority.manifest.configurations.map(
        (configuration) => configuration.configId,
      ),
      qualificationBaseCount:
        authority.manifest.splits.qualification.baseCount,
    }),
  );
}

await main();
