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

import { stableStringify } from "../src/events/stable-hash";
import { captureSourceSnapshot } from "../src/evaluation/artifacts";
import { verifyPhase7ComparisonArtifacts } from "../src/evaluation/phase7-comparison-artifacts";
import { phase7ComparisonSummarySchema } from "../src/evaluation/phase7-comparison-schema";
import {
  createPhase8ManifestAuthorityArtifact,
  freezePhase8Manifest,
  openPhase8Split,
  phase8Sha256,
  serializePhase8SplitOpening,
} from "../src/evaluation/phase8-manifest";
import { runPhase8SourceValidation } from "../src/evaluation/phase8-source-validation";
import {
  createPhase8TerminalConfigurationDescriptor,
  PHASE8_TERMINAL_REFERENCE_ID,
} from "../src/evaluation/phase8-terminal-policy";
import { PHASE8_TERMINAL_REPORT_VERSION } from "../src/evaluation/phase8-terminal-report";
import { PHASE8_TERMINAL_RUNNER_VERSION } from "../src/evaluation/phase8-terminal-schema";
import {
  PHASE8_PRACTICAL_TIE_MARGIN,
  PHASE8_STYLE_CATASTROPHE_LOWER,
  PHASE8_STYLE_CATASTROPHE_POINT,
  PHASE8_TERMINAL_NI_MARGIN,
} from "../src/evaluation/phase8-statistics";
import {
  createPhase8HardOnlyModel,
  serializePhase8HardOnlyModel,
} from "../src/modeling/hard-only-model";

type Options = Readonly<{
  authorityId: string;
  outputParent: string;
  developmentVarianceRun: string;
}>;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function options(): Options {
  const authorityId =
    argument("--authority-id") ?? "phase8-reference-qualification-20260728-a";
  if (
    authorityId.trim().length === 0 ||
    basename(authorityId) !== authorityId
  ) {
    throw new Error("--authority-id must be one safe nonempty path segment.");
  }
  return {
    authorityId,
    outputParent:
      argument("--output-parent") ??
      "artifacts/evaluation/eval-v1/qualification/authorities",
    developmentVarianceRun:
      argument("--development-variance-run") ??
      "artifacts/evaluation/eval-v1/dev/phase7-comparison-dev-primary-v2-20260728-a",
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

async function preregistrationSha256(projectRoot: string): Promise<string> {
  const paths = [
    "GOAL.md",
    "docs/evaluation-plan.md",
    "docs/decisions/0007-phase8-confirmatory-selection-contract.md",
    "docs/decisions/0008-phase8-evidence-bundle-and-release-binding.md",
    "docs/decisions/0009-reference-only-first-release.md",
  ];
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(await readFile(join(projectRoot, path)));
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

async function writeExclusive(
  path: string,
  value: string | Uint8Array,
): Promise<void> {
  await writeFile(path, value, { flag: "wx" });
}

async function main(): Promise<void> {
  const input = options();
  const projectRoot = resolve(".");
  const source = await captureSourceSnapshot(projectRoot);
  if (source.gitDirty || source.gitCommit === null) {
    throw new Error(
      "Qualification preparation requires a clean committed source snapshot.",
    );
  }

  const developmentRun = resolve(input.developmentVarianceRun);
  const development = await verifyPhase7ComparisonArtifacts(developmentRun);
  if (!development.valid || development.scientificDigest === null) {
    throw new Error(
      `Verified Phase 7 development variance evidence is required: ${development.failures.join("; ")}`,
    );
  }
  const developmentSummary = phase7ComparisonSummarySchema.parse(
    JSON.parse(
      await readFile(join(developmentRun, "summary.json"), "utf8"),
    ) as unknown,
  );
  if (
    developmentSummary.pairedMacro === null ||
    developmentSummary.pairedMacro.estimate !== 0 ||
    developmentSummary.pairedMacro.lower !== 0 ||
    developmentSummary.pairedMacro.upper !== 0
  ) {
    throw new Error(
      "Reference-only minimum sizing requires the verified zero-difference Phase 7 development result.",
    );
  }
  const varianceDigest = /^sha256:([0-9a-f]{64})$/u.exec(
    development.scientificDigest,
  )?.[1];
  if (varianceDigest === undefined) {
    throw new Error("Phase 7 development scientific digest is malformed.");
  }

  const modelBytes = serializePhase8HardOnlyModel(
    createPhase8HardOnlyModel(source.sourceSnapshotSha256),
  );
  const modelSha256 = sha256(modelBytes);
  const descriptor = createPhase8TerminalConfigurationDescriptor({
    configId: PHASE8_TERMINAL_REFERENCE_ID,
  });
  const scorerSha256 = phase8Sha256({
    terminalRunnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    terminalNoninferiorityMargin: PHASE8_TERMINAL_NI_MARGIN,
    practicalTieMargin: PHASE8_PRACTICAL_TIE_MARGIN,
    styleCatastrophePoint: PHASE8_STYLE_CATASTROPHE_POINT,
    styleCatastropheLower: PHASE8_STYLE_CATASTROPHE_LOWER,
  });
  const reportSha256 = phase8Sha256({
    reportVersion: PHASE8_TERMINAL_REPORT_VERSION,
    referenceOnlyMode: "genuine-one-arm-no-bootstrap",
  });
  const authority = freezePhase8Manifest({
    manifestId: input.authorityId,
    createdAt: new Date().toISOString(),
    sourceSha256: source.sourceSnapshotSha256,
    sourceFileCount: source.sourceFileCount,
    modelSha256,
    scorerSha256,
    reportSha256,
    preregistrationSha256: await preregistrationSha256(projectRoot),
    configurations: [descriptor],
    splits: {
      train: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      tune: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      qualification: { baseIndexStart: 0, eventCap: 4_096 },
    },
    qualificationSampleSize: {
      verifiedDevelopmentVarianceArtifactSha256: varianceDigest,
      maxPairedClusterStandardDeviation: 0,
    },
  });
  const authorityArtifact = createPhase8ManifestAuthorityArtifact({
    existingTarget: null,
    authority,
  });

  const parent = resolve(input.outputParent);
  const target = resolve(parent, input.authorityId);
  const stage = resolve(
    parent,
    `.incomplete-${input.authorityId}-${process.pid}`,
  );
  if (
    dirname(target) !== parent ||
    dirname(stage) !== parent ||
    (await exists(target)) ||
    (await exists(stage))
  ) {
    throw new Error("Refusing an unsafe or existing authority target.");
  }
  await mkdir(stage, { recursive: true });
  try {
    await writeExclusive(
      join(stage, "phase8-manifest-authority.json"),
      authorityArtifact.payload,
    );
    const manifestPayload = `${stableStringify(authority.manifest)}\n`;
    await writeExclusive(
      join(stage, "qualification-manifest.json"),
      manifestPayload,
    );
    await writeExclusive(join(stage, "model-not-applicable.json"), modelBytes);
    const trainClosure = `${stableStringify({
      schemaVersion: 1,
      kind: "phase8-train-closure-not-applicable",
      reason: "reference-only-registry",
      sourceSha256: source.sourceSnapshotSha256,
    })}\n`;
    const tuneClosure = `${stableStringify({
      schemaVersion: 1,
      kind: "phase8-tune-closure-not-applicable",
      reason: "reference-only-registry",
      sourceSha256: source.sourceSnapshotSha256,
    })}\n`;
    await writeExclusive(join(stage, "train-closure.json"), trainClosure);
    await writeExclusive(join(stage, "tune-closure.json"), tuneClosure);

    const sourceValidation = await runPhase8SourceValidation({
      projectRoot,
      parentDirectory: join(stage, "source-validation"),
      validationId: `${input.authorityId}-source-validation`,
      authority,
      onCommandStart: (commandClass, ordinal) => {
        process.stdout.write(
          `source-validation ${ordinal.toString()}/12 ${commandClass}\n`,
        );
      },
    });
    const proof = {
      kind: "qualification" as const,
      preregistrationSha256: authority.manifest.hashes.preregistrationSha256,
      trainClosureSha256: sha256(trainClosure),
      tuneClosureSha256: sha256(tuneClosure),
      sourceValidationArtifactSha256: sourceValidation.payloadSha256,
    };
    const opening = openPhase8Split(authority, {
      split: "qualification",
      proof,
    });
    const openingPayload = serializePhase8SplitOpening(
      authority,
      opening,
      proof,
    );
    await writeExclusive(
      join(stage, "qualification-opening.json"),
      openingPayload,
    );
    const checksums = [
      [sha256(authorityArtifact.payload), "phase8-manifest-authority.json"],
      [sha256(manifestPayload), "qualification-manifest.json"],
      [modelSha256, "model-not-applicable.json"],
      [sha256(trainClosure), "train-closure.json"],
      [sha256(tuneClosure), "tune-closure.json"],
      [sha256(openingPayload), "qualification-opening.json"],
    ]
      .map(([digest, path]) => `${digest}  ${path}`)
      .join("\n");
    await writeExclusive(join(stage, "checksums.sha256"), `${checksums}\n`);
    await mkdir(parent, { recursive: true });
    await rename(stage, target);
    process.stdout.write(
      `${JSON.stringify({
        authorityDirectory: target,
        manifestId: authority.manifest.manifestId,
        manifestSha256: authority.manifestSha256,
        sourceSha256: source.sourceSnapshotSha256,
        modelSha256,
        qualificationBaseCount:
          authority.manifest.splits.qualification.baseCount,
        sourceValidationDirectory: sourceValidation.runDirectory.replace(
          stage,
          target,
        ),
      })}\n`,
    );
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

await main();
