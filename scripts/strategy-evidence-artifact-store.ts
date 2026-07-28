import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { stableStringify } from "../src/events/stable-hash";
import {
  createStrategyActionValuesArtifact,
  createStrategyCommandArtifact,
  createStrategyCounterexamplesArtifact,
  createStrategyFailuresArtifact,
  createStrategyManifestArtifact,
  createStrategyStatesArtifact,
  createStrategySummaryArtifact,
  strategyActionValuesPayloadSchema,
  strategyCommandPayloadSchema,
  strategyCounterexamplesPayloadSchema,
  strategyFailuresPayloadSchema,
  strategyManifestPayloadSchema,
  strategyStatesPayloadSchema,
  strategySummaryPayloadSchema,
  verifyStrategyArtifactChecksum,
  type StrategyArtifact,
  type StrategyArtifactKind,
} from "../src/strategy/artifacts";
import {
  parseStrategyEvidenceBundle,
  strategyEvidenceSummarySchema,
  summarizeStrategyEvidence,
  verifyStrategyEvidence,
  type StrategyEvidenceBundle,
  type StrategyEvidenceSummary,
  type StrategyEvidenceVerificationMode,
} from "../src/strategy/evidence";
import {
  PHASE6_STRATEGY_REGISTRY_CHECKSUM,
  PHASE6_STRATEGY_PROTOCOL_ID,
  strategyEvidenceBundleChecksum,
} from "../src/strategy/phase6-evidence";

const RUN_FILE_NAMES = [
  "manifest.json",
  "states.json",
  "action-values.json",
  "counterexamples.json",
  "failures.json",
  "summary.json",
  "command.json",
  "evidence-bundle.json",
  "raw-test-results.json",
  "checksums.sha256",
] as const;

const JSON_FILE_NAMES = RUN_FILE_NAMES.filter((name) => name.endsWith(".json"));
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const checksumSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const rawStrategyTestResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: z.string().trim().min(1),
    argv: z.array(z.string().trim().min(1)).min(1),
    exitCode: z.number().int(),
    signal: z.string().trim().min(1).nullable(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();
export type RawStrategyTestResult = z.infer<typeof rawStrategyTestResultSchema>;

type EvidenceClass =
  "development" | "train" | "tune" | "qualification" | "final";

export type StrategyEvidenceRunVerification = {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly summary: StrategyEvidenceSummary | null;
};

export type StrategyEvidenceProtocolDescriptor = {
  readonly protocolId: string;
  readonly registryChecksum: string;
  readonly verificationMode: StrategyEvidenceVerificationMode;
};

export const PHASE6_STRATEGY_EVIDENCE_PROTOCOL: StrategyEvidenceProtocolDescriptor =
  Object.freeze({
    protocolId: PHASE6_STRATEGY_PROTOCOL_ID,
    registryChecksum: PHASE6_STRATEGY_REGISTRY_CHECKSUM,
    verificationMode: "phase6",
  });

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(stableStringify(value)), null, 2)}\n`;
}

function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function rawStrategyTestResultChecksum(
  value: RawStrategyTestResult,
): string {
  return sha256Text(canonicalJson(rawStrategyTestResultSchema.parse(value)));
}

function fileChecksumLine(fileName: string, contents: string): string {
  return `${sha256Text(contents).slice("sha256:".length)}  ${fileName}`;
}

function isPathInside(parent: string, child: string): boolean {
  return child !== parent && dirname(child) === parent;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export async function writeImmutableStrategyEvidenceRun(input: {
  readonly outputRoot: string;
  readonly runId: string;
  readonly evidenceClass: EvidenceClass;
  readonly sourceRevision: string;
  readonly bundle: StrategyEvidenceBundle;
  readonly rawTestResult: RawStrategyTestResult;
  readonly protocol?: StrategyEvidenceProtocolDescriptor;
}): Promise<string> {
  const runId = runIdSchema.parse(input.runId);
  const bundle = parseStrategyEvidenceBundle(input.bundle);
  const rawTestResult = rawStrategyTestResultSchema.parse(input.rawTestResult);
  const protocol = input.protocol ?? PHASE6_STRATEGY_EVIDENCE_PROTOCOL;
  const verification = verifyStrategyEvidence(bundle, {
    mode: protocol.verificationMode,
  });
  if (!verification.ok) {
    throw new Error(
      `Refusing to write invalid ${protocol.protocolId} evidence: ${verification.issues
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const command = bundle.commands[0];
  if (
    bundle.commands.length !== 1 ||
    command === undefined ||
    command.commandId !== rawTestResult.commandId ||
    stableStringify(command.argv) !== stableStringify(rawTestResult.argv) ||
    command.exitCode !== rawTestResult.exitCode
  ) {
    throw new Error(
      "The immutable run requires one command matching the raw test result.",
    );
  }
  if (command.sourceRevision !== input.sourceRevision) {
    throw new Error(
      "The manifest source revision must match the executed command.",
    );
  }
  const executedArguments = new Set(rawTestResult.argv);
  const unexecutedEvidence = bundle.evidence.find(
    (record) => !executedArguments.has(record.testPath),
  );
  if (unexecutedEvidence !== undefined) {
    throw new Error(
      `${unexecutedEvidence.evidenceId} cites an unexecuted test path: ${unexecutedEvidence.testPath}`,
    );
  }
  const expectedResultChecksum = rawStrategyTestResultChecksum(rawTestResult);
  if (
    bundle.evidence.some(
      (record) => record.resultChecksum !== expectedResultChecksum,
    )
  ) {
    throw new Error(
      "Every executable evidence record must bind the raw test result checksum.",
    );
  }

  const runIdentity = {
    schemaVersion: 1 as const,
    runId,
    evidenceClass: input.evidenceClass,
  };
  const bundleChecksum = strategyEvidenceBundleChecksum(bundle);
  const states = createStrategyStatesArtifact({
    ...runIdentity,
    records: bundle.states,
  });
  const actionValues = createStrategyActionValuesArtifact({
    ...runIdentity,
    records: bundle.actionValues,
  });
  const counterexamples = createStrategyCounterexamplesArtifact({
    ...runIdentity,
    records: bundle.boundaries,
  });
  const failures = createStrategyFailuresArtifact({
    ...runIdentity,
    records: bundle.failures,
  });
  const summary = createStrategySummaryArtifact({
    ...runIdentity,
    evidenceBundleChecksum: bundleChecksum,
    summary: summarizeStrategyEvidence(bundle, {
      mode: protocol.verificationMode,
    }),
  });
  const commandArtifact = createStrategyCommandArtifact({
    ...runIdentity,
    records: bundle.commands,
  });
  const manifest = createStrategyManifestArtifact({
    ...runIdentity,
    protocolId: protocol.protocolId,
    sourceRevision: input.sourceRevision,
    registryChecksum: protocol.registryChecksum,
    evidenceBundleChecksum: bundleChecksum,
    declaredMotifIds: bundle.dispositions.map(
      (disposition) => disposition.motifId,
    ),
    artifactChecksums: {
      states: states.payloadChecksum,
      actionValues: actionValues.payloadChecksum,
      counterexamples: counterexamples.payloadChecksum,
      failures: failures.payloadChecksum,
      summary: summary.payloadChecksum,
      command: commandArtifact.payloadChecksum,
    },
  });

  const contents = new Map<string, string>([
    ["manifest.json", canonicalJson(manifest)],
    ["states.json", canonicalJson(states)],
    ["action-values.json", canonicalJson(actionValues)],
    ["counterexamples.json", canonicalJson(counterexamples)],
    ["failures.json", canonicalJson(failures)],
    ["summary.json", canonicalJson(summary)],
    ["command.json", canonicalJson(commandArtifact)],
    ["evidence-bundle.json", canonicalJson(bundle)],
    ["raw-test-results.json", canonicalJson(rawTestResult)],
  ]);
  const checksumLines = [...contents.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fileName, value]) => fileChecksumLine(fileName, value));
  contents.set("checksums.sha256", `${checksumLines.join("\n")}\n`);

  const outputRoot = resolve(input.outputRoot);
  const target = resolve(outputRoot, runId);
  if (!isPathInside(outputRoot, target)) {
    throw new Error("Run ID resolves outside the evidence output root.");
  }
  await mkdir(outputRoot, { recursive: true });
  if (await pathExists(target)) {
    throw new Error(
      `Immutable strategy evidence run already exists: ${target}`,
    );
  }

  const staging = resolve(
    outputRoot,
    `.${runId}.staging-${process.pid.toString()}-${randomUUID()}`,
  );
  if (!isPathInside(outputRoot, staging)) {
    throw new Error("Staging path resolves outside the evidence output root.");
  }
  await mkdir(staging);
  try {
    for (const [fileName, value] of contents) {
      await writeFile(join(staging, fileName), value, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    await rename(staging, target);
  } catch (error) {
    if (isPathInside(outputRoot, staging) && (await pathExists(staging))) {
      await rm(staging, { recursive: true, force: false });
    }
    throw error;
  }
  return target;
}

function parseJson(
  fileName: string,
  contents: ReadonlyMap<string, string>,
  issues: string[],
): unknown {
  const text = contents.get(fileName);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    issues.push(
      `${fileName} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

function artifactForKind(
  value: unknown,
  expectedKind: StrategyArtifactKind,
  fileName: string,
  issues: string[],
): StrategyArtifact | undefined {
  if (!verifyStrategyArtifactChecksum(value)) {
    issues.push(`${fileName} has an invalid artifact payload checksum.`);
    return undefined;
  }
  if (value.artifactKind !== expectedKind) {
    issues.push(
      `${fileName} is ${value.artifactKind}, expected ${expectedKind}.`,
    );
    return undefined;
  }
  const payloadSchemas: Readonly<Record<StrategyArtifactKind, z.ZodType>> = {
    manifest: strategyManifestPayloadSchema,
    states: strategyStatesPayloadSchema,
    "action-values": strategyActionValuesPayloadSchema,
    counterexamples: strategyCounterexamplesPayloadSchema,
    failures: strategyFailuresPayloadSchema,
    summary: strategySummaryPayloadSchema,
    command: strategyCommandPayloadSchema,
  };
  const payload = payloadSchemas[expectedKind].safeParse(value.payload);
  if (!payload.success) {
    issues.push(`${fileName} has an invalid payload: ${payload.error.message}`);
    return undefined;
  }
  return { ...value, payload: payload.data } as StrategyArtifact;
}

function compareRecords(
  label: string,
  artifactRecords: unknown,
  bundleRecords: unknown,
  issues: string[],
): void {
  if (stableStringify(artifactRecords) !== stableStringify(bundleRecords)) {
    issues.push(`${label} artifact records do not match the evidence bundle.`);
  }
}

export async function verifyStrategyEvidenceRun(
  runDirectory: string,
  options: Readonly<{
    mode?: StrategyEvidenceVerificationMode;
    protocol?: StrategyEvidenceProtocolDescriptor;
  }> = {},
): Promise<StrategyEvidenceRunVerification> {
  const protocol = options.protocol ?? PHASE6_STRATEGY_EVIDENCE_PROTOCOL;
  const verificationMode = options.mode ?? protocol.verificationMode;
  const issues: string[] = [];
  const directory = resolve(runDirectory);
  let fileNames: string[];
  try {
    fileNames = (await readdir(directory)).sort((left, right) =>
      left.localeCompare(right),
    );
  } catch (error) {
    return {
      ok: false,
      issues: [
        `Cannot read strategy evidence directory: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      summary: null,
    };
  }

  const expectedNames = [...RUN_FILE_NAMES].sort((left, right) =>
    left.localeCompare(right),
  );
  if (stableStringify(fileNames) !== stableStringify(expectedNames)) {
    issues.push(
      `Run file set mismatch: expected ${expectedNames.join(", ")}, received ${fileNames.join(", ")}.`,
    );
  }

  const contents = new Map<string, string>();
  for (const fileName of RUN_FILE_NAMES) {
    try {
      contents.set(fileName, await readFile(join(directory, fileName), "utf8"));
    } catch {
      issues.push(`Missing or unreadable ${fileName}.`);
    }
  }

  const checksumText = contents.get("checksums.sha256");
  if (checksumText !== undefined) {
    const declared = new Map<string, string>();
    for (const line of checksumText.trimEnd().split("\n")) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) {
        issues.push(`Malformed checksum line: ${line}`);
      } else {
        declared.set(match[2], `sha256:${match[1]}`);
      }
    }
    for (const fileName of JSON_FILE_NAMES) {
      const text = contents.get(fileName);
      if (text !== undefined) {
        const actual = sha256Text(text);
        const expected = declared.get(fileName);
        if (expected !== actual) {
          issues.push(`${fileName} failed the SHA-256 file checksum.`);
        }
      }
    }
    if (
      declared.size !== JSON_FILE_NAMES.length ||
      [...declared.keys()].some(
        (fileName) =>
          !(JSON_FILE_NAMES as readonly string[]).includes(fileName),
      )
    ) {
      issues.push("checksums.sha256 does not declare every JSON file exactly.");
    }
  }

  const parsed = new Map<string, unknown>();
  for (const fileName of JSON_FILE_NAMES) {
    parsed.set(fileName, parseJson(fileName, contents, issues));
  }

  const manifest = artifactForKind(
    parsed.get("manifest.json"),
    "manifest",
    "manifest.json",
    issues,
  );
  const states = artifactForKind(
    parsed.get("states.json"),
    "states",
    "states.json",
    issues,
  );
  const actionValues = artifactForKind(
    parsed.get("action-values.json"),
    "action-values",
    "action-values.json",
    issues,
  );
  const counterexamples = artifactForKind(
    parsed.get("counterexamples.json"),
    "counterexamples",
    "counterexamples.json",
    issues,
  );
  const failures = artifactForKind(
    parsed.get("failures.json"),
    "failures",
    "failures.json",
    issues,
  );
  const summaryArtifact = artifactForKind(
    parsed.get("summary.json"),
    "summary",
    "summary.json",
    issues,
  );
  const commandArtifact = artifactForKind(
    parsed.get("command.json"),
    "command",
    "command.json",
    issues,
  );

  let bundle: StrategyEvidenceBundle | undefined;
  try {
    bundle = parseStrategyEvidenceBundle(parsed.get("evidence-bundle.json"));
  } catch (error) {
    issues.push(
      `Invalid evidence-bundle.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const rawResult = rawStrategyTestResultSchema.safeParse(
    parsed.get("raw-test-results.json"),
  );
  if (!rawResult.success) {
    issues.push(`Invalid raw-test-results.json: ${rawResult.error.message}`);
  }

  let computedSummary: StrategyEvidenceSummary | null = null;
  if (bundle !== undefined) {
    const verification = verifyStrategyEvidence(bundle, {
      mode: verificationMode,
    });
    issues.push(
      ...verification.issues.map((issue) => `${issue.code}: ${issue.message}`),
    );
    if (verification.ok) {
      computedSummary = summarizeStrategyEvidence(bundle, {
        mode: verificationMode,
      });
    }
  }

  if (
    manifest?.artifactKind === "manifest" &&
    states?.artifactKind === "states" &&
    actionValues?.artifactKind === "action-values" &&
    counterexamples?.artifactKind === "counterexamples" &&
    failures?.artifactKind === "failures" &&
    summaryArtifact?.artifactKind === "summary" &&
    commandArtifact?.artifactKind === "command" &&
    bundle !== undefined
  ) {
    const payload = manifest.payload;
    if (payload.protocolId !== protocol.protocolId) {
      issues.push(`Unexpected strategy protocol ${payload.protocolId}.`);
    }
    if (payload.registryChecksum !== protocol.registryChecksum) {
      issues.push(
        "Manifest registry checksum does not match the expected protocol.",
      );
    }
    const bundleChecksum = strategyEvidenceBundleChecksum(bundle);
    if (payload.evidenceBundleChecksum !== bundleChecksum) {
      issues.push("Manifest evidence bundle checksum does not match.");
    }
    if (summaryArtifact.payload.evidenceBundleChecksum !== bundleChecksum) {
      issues.push("Summary evidence bundle checksum does not match.");
    }
    const linkedChecksums = {
      states: states.payloadChecksum,
      actionValues: actionValues.payloadChecksum,
      counterexamples: counterexamples.payloadChecksum,
      failures: failures.payloadChecksum,
      summary: summaryArtifact.payloadChecksum,
      command: commandArtifact.payloadChecksum,
    };
    if (
      stableStringify(payload.artifactChecksums) !==
      stableStringify(linkedChecksums)
    ) {
      issues.push("Manifest artifact payload checksums do not match.");
    }

    const identities = [
      states.payload,
      actionValues.payload,
      counterexamples.payload,
      failures.payload,
      summaryArtifact.payload,
      commandArtifact.payload,
    ];
    if (
      identities.some(
        (identity) =>
          identity.runId !== payload.runId ||
          identity.evidenceClass !== payload.evidenceClass,
      )
    ) {
      issues.push("Artifact run identity does not match the manifest.");
    }
    if (directory.split(/[\\/]/u).at(-1) !== payload.runId) {
      issues.push("Run directory name does not match the manifest run ID.");
    }

    compareRecords("states", states.payload.records, bundle.states, issues);
    compareRecords(
      "action-values",
      actionValues.payload.records,
      bundle.actionValues,
      issues,
    );
    compareRecords(
      "counterexamples",
      counterexamples.payload.records,
      bundle.boundaries,
      issues,
    );
    compareRecords(
      "failures",
      failures.payload.records,
      bundle.failures,
      issues,
    );
    compareRecords(
      "command",
      commandArtifact.payload.records,
      bundle.commands,
      issues,
    );
    if (
      computedSummary !== null &&
      stableStringify(summaryArtifact.payload.summary) !==
        stableStringify(strategyEvidenceSummarySchema.parse(computedSummary))
    ) {
      issues.push("Summary artifact does not match the verified bundle.");
    }

    const command = bundle.commands[0];
    if (
      rawResult.success &&
      (bundle.commands.length !== 1 ||
        command === undefined ||
        command.commandId !== rawResult.data.commandId ||
        command.exitCode !== rawResult.data.exitCode ||
        stableStringify(command.argv) !== stableStringify(rawResult.data.argv))
    ) {
      issues.push("Raw test result does not match the command artifact.");
    }
    if (rawResult.success) {
      const resultChecksum = rawStrategyTestResultChecksum(rawResult.data);
      if (
        !checksumSchema.safeParse(resultChecksum).success ||
        bundle.evidence.some(
          (record) => record.resultChecksum !== resultChecksum,
        )
      ) {
        issues.push(
          "Executable evidence does not bind the raw test result checksum.",
        );
      }
      const executedArguments = new Set(rawResult.data.argv);
      for (const record of bundle.evidence) {
        if (!executedArguments.has(record.testPath)) {
          issues.push(
            `${record.evidenceId} cites ${record.testPath}, which is absent from the executed command.`,
          );
        }
      }
    }
    if (
      command !== undefined &&
      payload.sourceRevision !== command.sourceRevision
    ) {
      issues.push("Manifest and command source revisions differ.");
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    summary: computedSummary,
  };
}
