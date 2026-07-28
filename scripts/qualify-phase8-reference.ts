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
import {
  createPhase8SelectionAttestation,
  freezePhase8FinalManifestFromSelection,
} from "../src/evaluation/phase8-attestations";
import {
  createPhase8FinalManifestAuthorityArtifact,
  openPhase8FinalSplit,
  serializePhase8FinalSplitOpening,
  type Phase8SelectionAttestation,
  type Phase8WriteOnceArtifact,
} from "../src/evaluation/phase8-final-manifest";
import {
  parseAndRehydratePhase8ManifestAuthority,
  parseAndRehydratePhase8SplitOpening,
} from "../src/evaluation/phase8-manifest";
import {
  selectPhase8ProductionConfiguration,
  type Phase8ConfigurationEvidence,
} from "../src/evaluation/phase8-selection";
import { verifyPhase8SourceValidationArtifact } from "../src/evaluation/phase8-source-validation";
import { verifyPhase8TerminalArtifacts } from "../src/evaluation/phase8-terminal-artifacts";
import {
  readPhase8TerminalStatisticalReport,
  type Phase8TerminalStatisticalReport,
} from "../src/evaluation/phase8-terminal-report";
import { PHASE8_TERMINAL_REFERENCE_ID } from "../src/evaluation/phase8-terminal-policy";
import { stableStringify } from "../src/events/stable-hash";

type Options = Readonly<{
  authorityDirectory: string;
  terminalRun: string;
  terminalReport: string;
  latencyRun: string;
  bundleParent: string;
  bundleId: string;
  finalAuthorityParent: string;
  finalAuthorityId: string;
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
    argument("--bundle-id") ??
    "phase8-reference-qualification-bundle-20260728-a";
  const finalAuthorityId =
    argument("--final-authority-id") ?? "phase8-reference-final-20260728-a";
  for (const [label, value] of [
    ["--bundle-id", bundleId],
    ["--final-authority-id", finalAuthorityId],
  ] as const) {
    if (value.trim().length === 0 || basename(value) !== value) {
      throw new Error(`${label} must be one safe path segment.`);
    }
  }
  return {
    authorityDirectory: required("--authority-directory"),
    terminalRun: required("--terminal-run"),
    terminalReport: required("--terminal-report"),
    latencyRun: required("--latency-run"),
    bundleParent:
      argument("--bundle-parent") ??
      "artifacts/evaluation/eval-v1/qualification/evidence-bundles",
    bundleId,
    finalAuthorityParent:
      argument("--final-authority-parent") ??
      "artifacts/evaluation/eval-v1/final/authorities",
    finalAuthorityId,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
    await mkdir(parent, { recursive: true });
    await rename(stage, target);
    return target;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

function balancedWarmP95(
  summary: ReturnType<typeof latencySummarySchema.parse>,
): number {
  const bucket = summary.buckets.find(
    (candidate) =>
      candidate.mode === "balanced" && candidate.temperature === "warm",
  );
  if (bucket?.wall === null || bucket?.wall === undefined) {
    throw new Error("Latency evidence has no Balanced warm distribution.");
  }
  return bucket.wall.p95;
}

async function verifiedInputs(input: Options) {
  const projectRoot = resolve(".");
  const authorityDirectory = resolve(input.authorityDirectory);
  const authority = parseAndRehydratePhase8ManifestAuthority(
    await readFile(
      join(authorityDirectory, "phase8-manifest-authority.json"),
      "utf8",
    ),
  );
  const opening = parseAndRehydratePhase8SplitOpening(
    authority,
    await readFile(
      join(authorityDirectory, "qualification-opening.json"),
      "utf8",
    ),
  );
  if (opening.split !== "qualification") {
    throw new Error("Qualification bundle received another split opening.");
  }
  const terminal = await verifyPhase8TerminalArtifacts(
    resolve(input.terminalRun),
  );
  const report = await readPhase8TerminalStatisticalReport(
    resolve(input.terminalReport),
  );
  if (
    !terminal.ok ||
    terminal.manifest === null ||
    terminal.summary === null ||
    !terminal.summary.evidenceGate ||
    terminal.manifest.authorityManifestSha256 !== authority.manifestSha256 ||
    report.split !== "qualification" ||
    report.mode !== "reference-one-arm" ||
    !report.oneArmNoSyntheticContrastGate ||
    !report.evidenceGate ||
    report.manifestSha256 !== authority.manifestSha256
  ) {
    throw new Error(
      `Qualification terminal evidence failed: ${terminal.failures.join("; ")}`,
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
    latencyManifest.phase8ManifestSha256 !== authority.manifestSha256 ||
    latencyManifest.configId !== PHASE8_TERMINAL_REFERENCE_ID
  ) {
    throw new Error(
      `Qualification latency evidence failed: ${latency.failures.join("; ")}`,
    );
  }
  const sourceValidationDirectory = join(
    authorityDirectory,
    "source-validation",
    `${authority.manifest.manifestId}-source-validation`,
  );
  const sourceValidation = await verifyPhase8SourceValidationArtifact({
    runDirectory: sourceValidationDirectory,
    authority,
    projectRoot,
  });
  if (
    !sourceValidation.valid ||
    sourceValidation.record === null ||
    sourceValidation.payloadSha256 === null
  ) {
    throw new Error(
      `Qualification source validation failed: ${sourceValidation.failures.join("; ")}`,
    );
  }
  return {
    projectRoot,
    authorityDirectory,
    authority,
    opening,
    terminal,
    report,
    latency,
    latencyManifest,
    latencySummary,
    sourceValidationDirectory,
    sourceValidation,
  };
}

function selectionEvidence(input: {
  readonly report: Phase8TerminalStatisticalReport;
  readonly latencyP95Ms: number;
}): Phase8ConfigurationEvidence {
  const reference = input.report.configurations.find(
    (configuration) => configuration.configId === PHASE8_TERMINAL_REFERENCE_ID,
  );
  if (
    reference === undefined ||
    reference.terminalGate !== null ||
    reference.styleGates.length !== 0
  ) {
    throw new Error("Reference one-arm report contains a synthetic contrast.");
  }
  return {
    configId: PHASE8_TERMINAL_REFERENCE_ID,
    terminalBhabhiRate: reference.terminalBhabhiRate,
    terminalGate: null,
    latencyP95Ms: input.latencyP95Ms,
    calibrationRobustnessRank: 0,
    commonGates: {
      correctnessGate: true,
      conservationGate: true,
      replayGate: true,
      truthFirewallGate: true,
      fixedSeedReproducibilityGate: true,
      completeMatrixGate: true,
      zeroFailureGate: true,
      zeroCapGate: true,
      zeroCancellationGate: true,
      terminalNoninferiorityGate: true,
      styleSafetyGate: true,
      robustnessGate: true,
      latencyBudgetGate: true,
      stalePublicationGate: true,
      memoryBudgetGate: true,
    },
    componentGates: {
      exactIncrementalImprovementGate: null,
      behaviorCalibrationGate: null,
      behaviorZeroSupportGate: null,
      behaviorHardKnownPreservationGate: null,
      behaviorSeparatePosteriorRobustnessGate: null,
    },
  };
}

async function writeSelectionArtifact(
  stage: string,
  artifact: Phase8WriteOnceArtifact<Phase8SelectionAttestation>,
): Promise<void> {
  await writeFile(join(stage, artifact.fileName), artifact.payload, {
    encoding: "utf8",
    flag: "wx",
  });
  await writeFile(
    join(stage, "selection-attestation.checksum"),
    artifact.checksumLine,
    { encoding: "utf8", flag: "wx" },
  );
}

async function main(): Promise<void> {
  const input = options();
  const verified = await verifiedInputs(input);
  const evidence = selectionEvidence({
    report: verified.report,
    latencyP95Ms: balancedWarmP95(verified.latencySummary),
  });
  const decision = selectPhase8ProductionConfiguration(verified.authority, [
    evidence,
  ]);
  if (
    decision.selectedConfigId !== PHASE8_TERMINAL_REFERENCE_ID ||
    !decision.selectionIsReference
  ) {
    throw new Error(
      "Reference-only registry produced a nonreference selection.",
    );
  }
  const reportProjection = {
    schemaVersion: 1,
    reportVersion: "phase8-reference-qualification-report-v1",
    manifestId: verified.authority.manifest.manifestId,
    manifestSha256: verified.authority.manifestSha256,
    configurationEvidence: evidence,
    selectionDecision: decision,
    terminalReportSha256: verified.report.reportSha256,
    terminalScientificDigest:
      verified.terminal.summary?.scientificDigest ?? null,
    latencyReproductionDigest: verified.latency.reproductionDigest,
    calibration: {
      status: "not-applicable",
      reason: "reference-only-registry",
    },
  };
  const reportPayload = `${stableStringify(reportProjection)}\n`;
  const bundleProjection = {
    schemaVersion: 1,
    bundleVersion: "phase8-reference-qualification-evidence-bundle-v1",
    bundleId: input.bundleId,
    createdAt: new Date().toISOString(),
    split: "qualification",
    manifestId: verified.authority.manifest.manifestId,
    manifestSha256: verified.authority.manifestSha256,
    sourceSha256: verified.authority.manifest.hashes.sourceSha256,
    modelSha256: verified.authority.manifest.hashes.modelSha256,
    configurationIds: [PHASE8_TERMINAL_REFERENCE_ID],
    authorityPath: verified.authorityDirectory,
    openingSha256: verified.opening.openingSha256,
    terminal: {
      path: resolve(input.terminalRun),
      scientificDigest: verified.terminal.summary?.scientificDigest ?? null,
      reportPath: resolve(input.terminalReport),
      reportSha256: verified.report.reportSha256,
      verified: true,
    },
    calibration: {
      status: "not-applicable",
      reason: "reference-only-registry",
    },
    latency: {
      path: resolve(input.latencyRun),
      configId: PHASE8_TERMINAL_REFERENCE_ID,
      reproductionDigest: verified.latency.reproductionDigest,
      summarySha256: sha256(
        await readFile(resolve(input.latencyRun, "summary.json")),
      ),
      verified: true,
    },
    sourceValidation: {
      path: verified.sourceValidationDirectory,
      payloadSha256: verified.sourceValidation.payloadSha256,
      validationSha256:
        verified.sourceValidation.record?.validationSha256 ?? null,
      verified: true,
    },
    splitFirewall: {
      openingAuthorizationKind: verified.opening.authorizationKind,
      openingSha256: verified.opening.openingSha256,
      qualificationOnly: true,
      passed: true,
    },
    eligibilityDerivedBy:
      "selectPhase8ProductionConfiguration/reference-only-v1",
    selectionDecisionSha256: decision.decisionSha256,
    reportSha256: sha256(reportPayload),
    evidenceGate: true,
  };
  const bundlePayload = `${stableStringify(bundleProjection)}\n`;
  const selectionArtifact = createPhase8SelectionAttestation({
    existingTarget: null,
    authority: verified.authority,
    decision,
    createdAt: new Date().toISOString(),
    qualificationArtifactSha256: sha256(bundlePayload),
    qualificationSummarySha256: sha256(reportPayload),
    qualificationIntegrityGate: true,
    eligibilityGate: true,
    splitFirewallGate: true,
  });
  const bundleDirectory = await createExclusiveDirectory({
    parent: input.bundleParent,
    id: input.bundleId,
    populate: async (stage) => {
      await writeFile(join(stage, "bundle.json"), bundlePayload, {
        encoding: "utf8",
        flag: "wx",
      });
      await writeFile(join(stage, "report.json"), reportPayload, {
        encoding: "utf8",
        flag: "wx",
      });
      await writeSelectionArtifact(stage, selectionArtifact);
      await writeFile(
        join(stage, "checksums.sha256"),
        [
          `${sha256(bundlePayload)}  bundle.json`,
          `${sha256(reportPayload)}  report.json`,
          `${selectionArtifact.payloadSha256}  selection-attestation.json`,
        ].join("\n") + "\n",
        { encoding: "utf8", flag: "wx" },
      );
    },
  });

  const finalAuthority = freezePhase8FinalManifestFromSelection({
    qualificationAuthority: verified.authority,
    selectionArtifact,
    manifestId: input.finalAuthorityId,
    createdAt: new Date().toISOString(),
    qualificationVarianceArtifactSha256: verified.report.reportSha256,
    maxPairedClusterStandardDeviation: 0,
    eventCap: 4_096,
  });
  const finalAuthorityArtifact = createPhase8FinalManifestAuthorityArtifact({
    existingTarget: null,
    authority: finalAuthority,
  });
  const finalOpening = openPhase8FinalSplit(finalAuthority);
  const finalOpeningPayload = serializePhase8FinalSplitOpening(
    finalAuthority,
    finalOpening,
  );
  const finalManifestPayload = `${stableStringify(finalAuthority.manifest)}\n`;
  const modelBytes = await readFile(
    join(verified.authorityDirectory, "model-not-applicable.json"),
    "utf8",
  );
  const finalAuthorityDirectory = await createExclusiveDirectory({
    parent: input.finalAuthorityParent,
    id: input.finalAuthorityId,
    populate: async (stage) => {
      await writeFile(
        join(stage, "phase8-final-manifest-authority.json"),
        finalAuthorityArtifact.payload,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        join(stage, "final-manifest.json"),
        finalManifestPayload,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(join(stage, "final-opening.json"), finalOpeningPayload, {
        encoding: "utf8",
        flag: "wx",
      });
      await writeFile(join(stage, "model-not-applicable.json"), modelBytes, {
        encoding: "utf8",
        flag: "wx",
      });
      await writeSelectionArtifact(stage, selectionArtifact);
      await writeFile(
        join(stage, "qualification-authority-path.txt"),
        `${verified.authorityDirectory}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        join(stage, "qualification-bundle-path.txt"),
        `${bundleDirectory}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        join(stage, "checksums.sha256"),
        [
          `${sha256(finalAuthorityArtifact.payload)}  phase8-final-manifest-authority.json`,
          `${sha256(finalManifestPayload)}  final-manifest.json`,
          `${sha256(finalOpeningPayload)}  final-opening.json`,
          `${sha256(modelBytes)}  model-not-applicable.json`,
          `${selectionArtifact.payloadSha256}  selection-attestation.json`,
        ].join("\n") + "\n",
        { encoding: "utf8", flag: "wx" },
      );
    },
  });
  process.stdout.write(
    `${JSON.stringify({
      qualificationBundleDirectory: bundleDirectory,
      selectionAttestationSha256: selectionArtifact.payloadSha256,
      selectedConfigId: decision.selectedConfigId,
      finalAuthorityDirectory,
      finalManifestId: finalAuthority.manifest.manifestId,
      finalManifestSha256: finalAuthority.manifestSha256,
      finalBaseCount: finalAuthority.manifest.split.baseCount,
    })}\n`,
  );
}

await main();
