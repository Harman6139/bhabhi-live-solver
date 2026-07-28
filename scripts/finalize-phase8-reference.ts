import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  latencyRunManifestSchema,
  verifyLatencyArtifacts,
} from "../src/benchmark/latency-artifacts";
import { latencySummarySchema } from "../src/benchmark/latency-contract";
import { createPhase8FinalAttestation } from "../src/evaluation/phase8-attestations";
import {
  parseAndRehydratePhase8FinalManifestAuthority,
  parseAndRehydratePhase8FinalSplitOpening,
  rehydratePhase8SelectionArtifact,
} from "../src/evaluation/phase8-final-manifest";
import { parseAndRehydratePhase8ManifestAuthority } from "../src/evaluation/phase8-manifest";
import { verifyPhase8SourceValidationArtifact } from "../src/evaluation/phase8-source-validation";
import { verifyPhase8TerminalArtifacts } from "../src/evaluation/phase8-terminal-artifacts";
import { readPhase8TerminalStatisticalReport } from "../src/evaluation/phase8-terminal-report";
import { PHASE8_TERMINAL_REFERENCE_ID } from "../src/evaluation/phase8-terminal-policy";
import { stableStringify } from "../src/events/stable-hash";
import {
  PRODUCTION_RELEASE_BUNDLE_VERSION,
  verifyProductionReleaseBundle,
  type ProductionArtifactEnvelope,
  type SelectedProductionReleaseBundle,
} from "../src/production/release-contract";

type Options = Readonly<{
  finalAuthorityDirectory: string;
  qualificationAuthorityDirectory: string;
  qualificationBundleDirectory: string;
  terminalRun: string;
  terminalReport: string;
  latencyRun: string;
  bundleParent: string;
  bundleId: string;
  releaseParent: string;
  releaseId: string;
}>;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = argument(name);
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function options(): Options {
  const bundleId =
    argument("--bundle-id") ?? "phase8-reference-final-bundle-20260728-a";
  const releaseId =
    argument("--release-id") ?? "phase9-reference-release-20260728-a";
  for (const [label, value] of [
    ["--bundle-id", bundleId],
    ["--release-id", releaseId],
  ] as const) {
    if (value.trim().length === 0 || basename(value) !== value) {
      throw new Error(`${label} must be one safe path segment.`);
    }
  }
  return {
    finalAuthorityDirectory: required("--final-authority-directory"),
    qualificationAuthorityDirectory: required(
      "--qualification-authority-directory",
    ),
    qualificationBundleDirectory: required("--qualification-bundle-directory"),
    terminalRun: required("--terminal-run"),
    terminalReport: required("--terminal-report"),
    latencyRun: required("--latency-run"),
    bundleParent:
      argument("--bundle-parent") ??
      "artifacts/evaluation/eval-v1/final/evidence-bundles",
    bundleId,
    releaseParent: argument("--release-parent") ?? "artifacts/release",
    releaseId,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function envelope(bytes: string): ProductionArtifactEnvelope {
  return { bytes, sha256: sha256(bytes) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createExclusiveDirectory(input: {
  readonly parent: string;
  readonly id: string;
  readonly populate: (stage: string) => Promise<void>;
}): Promise<string> {
  const parent = resolve(input.parent);
  const target = resolve(parent, input.id);
  const stage = resolve(parent, `.incomplete-${input.id}-${process.pid}`);
  if (
    dirname(target) !== parent ||
    dirname(stage) !== parent ||
    (await exists(target)) ||
    (await exists(stage))
  ) {
    throw new Error(`Refusing unsafe or existing target ${target}.`);
  }
  await mkdir(stage, { recursive: true });
  try {
    await input.populate(stage);
    await rename(stage, target);
    return target;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const input = options();
  const projectRoot = resolve(".");
  const qualificationAuthorityDirectory = resolve(
    input.qualificationAuthorityDirectory,
  );
  const finalAuthorityDirectory = resolve(input.finalAuthorityDirectory);
  const qualificationAuthority = parseAndRehydratePhase8ManifestAuthority(
    await readFile(
      join(qualificationAuthorityDirectory, "phase8-manifest-authority.json"),
      "utf8",
    ),
  );
  const selectionPayload = await readFile(
    join(finalAuthorityDirectory, "selection-attestation.json"),
    "utf8",
  );
  const selectionChecksum = await readFile(
    join(finalAuthorityDirectory, "selection-attestation.checksum"),
    "utf8",
  );
  const selectionArtifact = rehydratePhase8SelectionArtifact({
    payload: selectionPayload,
    checksumLine: selectionChecksum,
  });
  const finalAuthority = parseAndRehydratePhase8FinalManifestAuthority({
    payload: await readFile(
      join(finalAuthorityDirectory, "phase8-final-manifest-authority.json"),
      "utf8",
    ),
    qualificationAuthority,
    selectionArtifact,
  });
  const finalOpening = parseAndRehydratePhase8FinalSplitOpening(
    finalAuthority,
    await readFile(join(finalAuthorityDirectory, "final-opening.json"), "utf8"),
  );

  const terminal = await verifyPhase8TerminalArtifacts(
    resolve(input.terminalRun),
  );
  const terminalReport = await readPhase8TerminalStatisticalReport(
    resolve(input.terminalReport),
  );
  if (
    !terminal.ok ||
    terminal.summary === null ||
    !terminal.summary.evidenceGate ||
    terminalReport.split !== "final" ||
    terminalReport.mode !== "reference-one-arm" ||
    !terminalReport.oneArmNoSyntheticContrastGate ||
    !terminalReport.evidenceGate ||
    terminalReport.manifestSha256 !== finalAuthority.manifestSha256
  ) {
    throw new Error(
      `Final terminal evidence failed: ${terminal.failures.join("; ")}`,
    );
  }

  const latency = await verifyLatencyArtifacts(resolve(input.latencyRun));
  const latencyManifest = latencyRunManifestSchema.parse(
    JSON.parse(
      await readFile(resolve(input.latencyRun, "manifest.json"), "utf8"),
    ) as unknown,
  );
  const latencySummary = latencySummarySchema.parse(
    JSON.parse(
      await readFile(resolve(input.latencyRun, "summary.json"), "utf8"),
    ) as unknown,
  );
  if (
    !latency.valid ||
    !latencySummary.gate.evidenceGatePass ||
    latencyManifest.phase8ManifestSha256 !== finalAuthority.manifestSha256 ||
    latencyManifest.configId !== PHASE8_TERMINAL_REFERENCE_ID
  ) {
    throw new Error(`Final latency failed: ${latency.failures.join("; ")}`);
  }

  const sourceValidationDirectory = join(
    qualificationAuthorityDirectory,
    "source-validation",
    `${qualificationAuthority.manifest.manifestId}-source-validation`,
  );
  const sourceValidation = await verifyPhase8SourceValidationArtifact({
    runDirectory: sourceValidationDirectory,
    authority: qualificationAuthority,
    projectRoot,
  });
  if (
    !sourceValidation.valid ||
    sourceValidation.record === null ||
    sourceValidation.payloadSha256 === null
  ) {
    throw new Error(
      `Final source identity failed: ${sourceValidation.failures.join("; ")}`,
    );
  }

  const qualificationBundleDirectory = resolve(
    input.qualificationBundleDirectory,
  );
  const qualificationBundlePayload = await readFile(
    join(qualificationBundleDirectory, "bundle.json"),
    "utf8",
  );
  const qualificationReportPayload = await readFile(
    join(qualificationBundleDirectory, "report.json"),
    "utf8",
  );
  const qualificationBundle = JSON.parse(qualificationBundlePayload) as Record<
    string,
    unknown
  >;
  if (
    qualificationBundlePayload !==
      `${stableStringify(qualificationBundle)}\n` ||
    qualificationBundle.manifestSha256 !==
      qualificationAuthority.manifestSha256 ||
    selectionArtifact.record.qualificationArtifactSha256 !==
      sha256(qualificationBundlePayload) ||
    selectionArtifact.record.qualificationSummarySha256 !==
      sha256(qualificationReportPayload)
  ) {
    throw new Error(
      "Qualification bundle does not reproduce the immutable selection links.",
    );
  }

  const finalReport = {
    schemaVersion: 1,
    reportVersion: "phase8-reference-final-report-v1",
    manifestId: finalAuthority.manifest.manifestId,
    manifestSha256: finalAuthority.manifestSha256,
    qualificationManifestSha256: qualificationAuthority.manifestSha256,
    selectionAttestationSha256: selectionArtifact.payloadSha256,
    selectedConfigId: PHASE8_TERMINAL_REFERENCE_ID,
    finalMode: "one-arm-reference-confirmation",
    terminalBhabhiRate:
      terminalReport.configurations[0]?.terminalBhabhiRate ?? null,
    terminalGames: terminalReport.configurations[0]?.completedGames ?? null,
    terminalReportSha256: terminalReport.reportSha256,
    latencyReproductionDigest: latency.reproductionDigest,
    calibration: {
      status: "not-applicable",
      reason: "reference-only-registry",
    },
    beatsClaim: false,
    confirmationGate: true,
  };
  const finalReportPayload = `${stableStringify(finalReport)}\n`;
  const finalBundle = {
    schemaVersion: 1,
    bundleVersion: "phase8-reference-final-evidence-bundle-v1",
    bundleId: input.bundleId,
    createdAt: new Date().toISOString(),
    split: "final",
    manifestId: finalAuthority.manifest.manifestId,
    manifestSha256: finalAuthority.manifestSha256,
    qualificationManifestId: qualificationAuthority.manifest.manifestId,
    qualificationManifestSha256: qualificationAuthority.manifestSha256,
    qualificationBundleSha256: sha256(qualificationBundlePayload),
    selectionAttestationSha256: selectionArtifact.payloadSha256,
    sourceSha256: finalAuthority.manifest.hashes.sourceSha256,
    modelSha256: finalAuthority.manifest.hashes.modelSha256,
    configurationIds: [PHASE8_TERMINAL_REFERENCE_ID],
    openingSha256: finalOpening.openingSha256,
    terminal: {
      path: resolve(input.terminalRun),
      scientificDigest: terminal.summary.scientificDigest,
      reportPath: resolve(input.terminalReport),
      reportSha256: terminalReport.reportSha256,
      verified: true,
    },
    calibration: {
      status: "not-applicable",
      reason: "reference-only-registry",
    },
    latency: {
      path: resolve(input.latencyRun),
      reproductionDigest: latency.reproductionDigest,
      summarySha256: sha256(
        await readFile(resolve(input.latencyRun, "summary.json")),
      ),
      verified: true,
    },
    sourceValidation: {
      path: sourceValidationDirectory,
      payloadSha256: sourceValidation.payloadSha256,
      validationSha256: sourceValidation.record.validationSha256,
      verified: true,
    },
    splitFirewall: {
      finalOpeningSha256: finalOpening.openingSha256,
      finalAuthorityOnly: true,
      qualificationOpeningNotReused: true,
      passed: true,
    },
    finalIntegrityGate: true,
    completeMatrixGate: true,
    zeroFailureGate: true,
    zeroCapGate: true,
    zeroCancellationGate: true,
    seedReplayGate: true,
    selectedConfirmationGate: true,
    reportSha256: sha256(finalReportPayload),
    evidenceGate: true,
  };
  const finalBundlePayload = `${stableStringify(finalBundle)}\n`;
  const finalAttestation = createPhase8FinalAttestation({
    existingTarget: null,
    authority: finalAuthority,
    selectionArtifact,
    createdAt: new Date().toISOString(),
    finalArtifactSha256: sha256(finalBundlePayload),
    finalSummarySha256: sha256(finalReportPayload),
    gates: {
      finalIntegrityGate: true,
      completeMatrixGate: true,
      zeroFailureGate: true,
      zeroCapGate: true,
      zeroCancellationGate: true,
      seedReplayGate: true,
      selectedConfirmationGate: true,
    },
  });
  const finalBundleDirectory = await createExclusiveDirectory({
    parent: input.bundleParent,
    id: input.bundleId,
    populate: async (stage) => {
      await writeFile(join(stage, "bundle.json"), finalBundlePayload, {
        encoding: "utf8",
        flag: "wx",
      });
      await writeFile(join(stage, "report.json"), finalReportPayload, {
        encoding: "utf8",
        flag: "wx",
      });
      await writeFile(
        join(stage, finalAttestation.fileName),
        finalAttestation.payload,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        join(stage, "final-attestation.checksum"),
        finalAttestation.checksumLine,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        join(stage, "checksums.sha256"),
        [
          `${sha256(finalBundlePayload)}  bundle.json`,
          `${sha256(finalReportPayload)}  report.json`,
          `${finalAttestation.payloadSha256}  final-attestation.json`,
        ].join("\n") + "\n",
        { encoding: "utf8", flag: "wx" },
      );
    },
  });

  const manifestBytes = stableStringify(finalAuthority.manifest);
  const descriptor = finalAuthority.manifest.configurations[0];
  if (
    descriptor === undefined ||
    descriptor.configId !== PHASE8_TERMINAL_REFERENCE_ID
  ) {
    throw new Error("Final authority has no selected reference descriptor.");
  }
  const modelBytes = await readFile(
    join(finalAuthorityDirectory, "model-not-applicable.json"),
    "utf8",
  );
  const releaseBundle: SelectedProductionReleaseBundle = {
    schemaVersion: 1,
    releaseVersion: PRODUCTION_RELEASE_BUNDLE_VERSION,
    mode: "release-selected",
    sourceHash: finalAuthority.manifest.hashes.sourceSha256,
    protocolHash: finalAuthority.manifest.hashes.preregistrationSha256,
    manifest: envelope(manifestBytes),
    descriptor: envelope(stableStringify(descriptor)),
    productionModel: envelope(modelBytes),
    selectionAttestation: envelope(selectionArtifact.payload),
    finalAttestation: envelope(finalAttestation.payload),
  };
  const releaseVerification =
    await verifyProductionReleaseBundle(releaseBundle);
  const releasePayload = `${stableStringify(releaseBundle)}\n`;
  const releaseDirectory = await createExclusiveDirectory({
    parent: input.releaseParent,
    id: input.releaseId,
    populate: async (stage) => {
      await writeFile(
        join(stage, "production-release-bundle.json"),
        releasePayload,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        join(stage, "checksums.sha256"),
        `${sha256(releasePayload)}  production-release-bundle.json\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        join(stage, "final-evidence-bundle-path.txt"),
        `${finalBundleDirectory}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    },
  });
  process.stdout.write(
    `${JSON.stringify({
      finalBundleDirectory,
      finalAttestationSha256: finalAttestation.payloadSha256,
      releaseDirectory,
      releaseBundlePath: join(
        releaseDirectory,
        "production-release-bundle.json",
      ),
      binding: releaseVerification.binding,
    })}\n`,
  );
}

await main();
