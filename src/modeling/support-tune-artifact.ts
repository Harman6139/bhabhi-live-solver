import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { phase8Sha256 } from "../evaluation/phase8-manifest";
import { stableStringify } from "../events/stable-hash";
import {
  parseSelectedBehaviorModelArtifact,
  serializeSelectedBehaviorModelArtifact,
} from "./behavior-fit";
import {
  verifyPhase8SupportRegularizerTuneSelection,
  type Phase8SupportRegularizerTuneSelection,
} from "./production-model";
import {
  assertPhase8SupportTuneArtifactEligible,
  phase8SupportTuneEvidenceSha256,
  scorePhase8SupportTuneCandidates,
  verifyPhase8SupportTuneGameRecord,
  verifyPhase8SupportTuneObservationRecord,
  verifyPhase8SupportTunePlan,
  type Phase8SupportTuneCandidateEvaluation,
  type Phase8SupportTuneGameRecord,
  type Phase8SupportTuneIntegrity,
  type Phase8SupportTuneObservationRecord,
  type Phase8SupportTunePlan,
  type Phase8SupportTuneRunResult,
} from "./support-tune";

export const PHASE8_SUPPORT_TUNE_ARTIFACT_VERSION =
  "phase8-support-tune-artifact-v1" as const;

const DATA_FILES = [
  "plan.json",
  "selected-behavior-model.json",
  "games.ndjson",
  "observations.eval-only.ndjson",
  "candidate-scores.json",
  "integrity.json",
  "selection.json",
] as const;

type DataFileName = (typeof DATA_FILES)[number];

export type Phase8SupportTuneArtifactFile = Readonly<{
  path: DataFileName;
  sha256: string;
  bytes: number;
}>;

export type Phase8SupportTuneArtifactManifest = Readonly<{
  schemaVersion: 1;
  artifactVersion: typeof PHASE8_SUPPORT_TUNE_ARTIFACT_VERSION;
  artifactKind: "phase8-support-tune";
  evidenceEligible: boolean;
  planSha256: string;
  evidenceSha256: string;
  selectionSha256: string | null;
  provisionalSelectedPseudocount: number;
  files: readonly Phase8SupportTuneArtifactFile[];
  manifestSha256: string;
  artifactSha256: string;
}>;

export type Phase8SupportTuneArtifactVerification = Readonly<{
  valid: boolean;
  directory: string;
  failures: readonly string[];
  manifest: Phase8SupportTuneArtifactManifest | null;
  run: Phase8SupportTuneRunResult | null;
}>;

function fail(message: string): never {
  throw new Error(`Phase 8 support-tune artifact rejected: ${message}`);
}

function byteSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonLine(value: unknown): string {
  return `${stableStringify(value)}\n`;
}

function ndjson(values: readonly unknown[]): string {
  return values.map((value) => stableStringify(value)).join("\n") + "\n";
}

function parseJson(serialized: string, label: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch (cause) {
    throw new Error(`${label} is not valid JSON.`, { cause });
  }
}

function parseCanonicalJson(serialized: string, label: string): unknown {
  const value = parseJson(serialized, label);
  if (serialized !== jsonLine(value)) {
    fail(`${label} is not canonical JSON.`);
  }
  return value;
}

function parseCanonicalNdjson(
  serialized: string,
  label: string,
): readonly unknown[] {
  if (!serialized.endsWith("\n")) {
    fail(`${label} must end with one newline.`);
  }
  const lines = serialized.slice(0, -1).split("\n");
  if (lines.length === 1 && lines[0] === "") {
    return Object.freeze([]);
  }
  const values = lines.map((line, index) =>
    parseJson(line, `${label} line ${(index + 1).toString()}`),
  );
  if (serialized !== ndjson(values)) {
    fail(`${label} is not canonical NDJSON.`);
  }
  return Object.freeze(values);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function differs(left: unknown, right: unknown): boolean {
  return left !== right;
}

function deterministicWinner(
  candidates: readonly Phase8SupportTuneCandidateEvaluation[],
): number {
  const winner = [...candidates].sort((left, right) => {
    const difference =
      left.score.equalFamilyUnresolvedSoftBrier -
      right.score.equalFamilyUnresolvedSoftBrier;
    return Math.abs(difference) <= 1e-12
      ? left.score.pseudocountPerFeasibleLabel -
          right.score.pseudocountPerFeasibleLabel
      : difference;
  })[0];
  return (
    winner?.score.pseudocountPerFeasibleLabel ??
    fail("candidate artifact has no winner.")
  );
}

function verifyRun(run: Phase8SupportTuneRunResult): true {
  assertPhase8SupportTuneArtifactEligible(run);
  verifyPhase8SupportTunePlan(run.plan);
  for (const game of run.games) {
    verifyPhase8SupportTuneGameRecord(game);
  }
  for (const observation of run.observations) {
    verifyPhase8SupportTuneObservationRecord(observation);
  }
  const rescored = scorePhase8SupportTuneCandidates({
    plan: run.plan,
    games: run.games,
    observations: run.observations,
    runFailureCount: run.integrity.runFailureCount,
  });
  if (
    !sameCanonical(rescored.evaluations, run.candidateEvaluations) ||
    !sameCanonical(rescored.integrity, run.integrity)
  ) {
    fail("candidate scores or integrity do not reproduce from observations.");
  }
  const evidenceSha256 = phase8SupportTuneEvidenceSha256({
    plan: run.plan,
    behaviorModel: run.behaviorModel,
    games: run.games,
    observations: run.observations,
  });
  if (evidenceSha256 !== run.evidenceSha256) {
    fail("evidence hash does not reproduce.");
  }
  const winner = deterministicWinner(run.candidateEvaluations);
  if (winner !== run.provisionalSelectedPseudocount) {
    fail("provisional winner is not deterministic.");
  }
  if (run.plan.mode === "evidence") {
    if (run.selection === null) {
      fail("evidence artifact is missing its sealed selection.");
    }
    const selection = verifyPhase8SupportRegularizerTuneSelection(
      run.selection,
    );
    if (
      selection.tuneArtifactSha256 !== run.evidenceSha256 ||
      selection.sourceSha256 !== run.plan.sourceSha256 ||
      selection.tuneDatasetHash !== run.plan.behaviorTuneDatasetHash ||
      selection.scorerSha256 !== run.plan.scorerSha256 ||
      selection.queryPlanSha256 !== run.plan.queryPlanSha256 ||
      selection.selectedPseudocountPerFeasibleLabel !== winner ||
      !sameCanonical(
        selection.candidates,
        run.candidateEvaluations.map((candidate) => candidate.score),
      )
    ) {
      fail("sealed selection does not match the reproduced evidence.");
    }
  } else if (run.selection !== null) {
    fail("a smoke artifact may not carry an evidence selection.");
  }
  return true;
}

function filePayloads(
  run: Phase8SupportTuneRunResult,
): Readonly<Record<DataFileName, string>> {
  verifyRun(run);
  return Object.freeze({
    "plan.json": jsonLine(run.plan),
    "selected-behavior-model.json": serializeSelectedBehaviorModelArtifact(
      run.behaviorModel,
    ),
    "games.ndjson": ndjson(run.games),
    "observations.eval-only.ndjson": ndjson(run.observations),
    "candidate-scores.json": jsonLine(run.candidateEvaluations),
    "integrity.json": jsonLine(run.integrity),
    "selection.json": jsonLine({
      schemaVersion: 1,
      evidenceEligible: run.plan.evidenceEligible,
      evidenceSha256: run.evidenceSha256,
      provisionalSelectedPseudocount: run.provisionalSelectedPseudocount,
      selection: run.selection,
    }),
  });
}

function manifestProjection(
  value: Omit<
    Phase8SupportTuneArtifactManifest,
    "manifestSha256" | "artifactSha256"
  >,
): Omit<
  Phase8SupportTuneArtifactManifest,
  "manifestSha256" | "artifactSha256"
> {
  return value;
}

function createManifest(
  run: Phase8SupportTuneRunResult,
  payloads: Readonly<Record<DataFileName, string>>,
): Phase8SupportTuneArtifactManifest {
  const files = DATA_FILES.map((path) => {
    const payload = payloads[path];
    return Object.freeze({
      path,
      sha256: byteSha256(payload),
      bytes: Buffer.byteLength(payload, "utf8"),
    });
  });
  const projection = {
    schemaVersion: 1 as const,
    artifactVersion: PHASE8_SUPPORT_TUNE_ARTIFACT_VERSION,
    artifactKind: "phase8-support-tune" as const,
    evidenceEligible: run.plan.evidenceEligible,
    planSha256: run.plan.planSha256,
    evidenceSha256: run.evidenceSha256,
    selectionSha256: run.selection?.selectionSha256 ?? null,
    provisionalSelectedPseudocount: run.provisionalSelectedPseudocount,
    files,
  };
  const manifestSha256 = phase8Sha256(manifestProjection(projection));
  return Object.freeze({
    ...projection,
    manifestSha256,
    artifactSha256: phase8Sha256({
      schemaVersion: 1,
      artifactVersion: PHASE8_SUPPORT_TUNE_ARTIFACT_VERSION,
      manifestSha256,
      evidenceSha256: run.evidenceSha256,
    }),
  });
}

function checksumsPayload(
  manifest: Phase8SupportTuneArtifactManifest,
  manifestPayload: string,
): string {
  return (
    [
      ...manifest.files.map((file) => `${file.sha256}  ${file.path}`),
      `${byteSha256(manifestPayload)}  manifest.json`,
    ].join("\n") + "\n"
  );
}

async function targetExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
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

function assertSafeStagingPath(parent: string, staging: string): void {
  const resolvedParent = resolve(parent);
  const resolvedStaging = resolve(staging);
  if (
    resolvedStaging === resolvedParent ||
    !resolvedStaging.startsWith(`${resolvedParent}${sep}`)
  ) {
    fail("temporary artifact path escaped its intended parent.");
  }
}

/**
 * Writes to a sibling staging directory and atomically renames it into place.
 * Both the final directory and every staged file are create-exclusive.
 */
export async function writePhase8SupportTuneArtifact(
  directory: string,
  run: Phase8SupportTuneRunResult,
): Promise<Phase8SupportTuneArtifactManifest> {
  const target = resolve(directory);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  if (await targetExists(target)) {
    fail(`refusing to overwrite existing target ${target}.`);
  }
  const staging = join(
    parent,
    `.${basename(target)}.tmp-${process.pid.toString()}-${randomUUID()}`,
  );
  assertSafeStagingPath(parent, staging);
  const payloads = filePayloads(run);
  const manifest = createManifest(run, payloads);
  const manifestPayload = jsonLine(manifest);
  const checksums = checksumsPayload(manifest, manifestPayload);
  await mkdir(staging, { recursive: false });
  try {
    for (const path of DATA_FILES) {
      await writeFile(join(staging, path), payloads[path], {
        encoding: "utf8",
        flag: "wx",
      });
    }
    await writeFile(join(staging, "manifest.json"), manifestPayload, {
      encoding: "utf8",
      flag: "wx",
    });
    await writeFile(join(staging, "checksums.sha256"), checksums, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

function verifyManifestShape(
  manifest: Phase8SupportTuneArtifactManifest,
): void {
  const { manifestSha256, artifactSha256, ...projection } = manifest;
  if (
    differs(manifest.schemaVersion, 1) ||
    differs(manifest.artifactVersion, PHASE8_SUPPORT_TUNE_ARTIFACT_VERSION) ||
    differs(manifest.artifactKind, "phase8-support-tune") ||
    manifest.files.length !== DATA_FILES.length ||
    !DATA_FILES.every((path, index) => manifest.files[index]?.path === path) ||
    manifestSha256 !== phase8Sha256(manifestProjection(projection)) ||
    artifactSha256 !==
      phase8Sha256({
        schemaVersion: 1,
        artifactVersion: PHASE8_SUPPORT_TUNE_ARTIFACT_VERSION,
        manifestSha256,
        evidenceSha256: manifest.evidenceSha256,
      })
  ) {
    fail("manifest shape or checksum is invalid.");
  }
}

export async function readPhase8SupportTuneArtifact(
  directory: string,
): Promise<Phase8SupportTuneRunResult> {
  const root = resolve(directory);
  const manifestPayload = await readFile(join(root, "manifest.json"), "utf8");
  const manifest = parseCanonicalJson(
    manifestPayload,
    "manifest.json",
  ) as Phase8SupportTuneArtifactManifest;
  verifyManifestShape(manifest);
  const payloads = {} as Record<DataFileName, string>;
  for (const file of manifest.files) {
    const payload = await readFile(join(root, file.path), "utf8");
    if (
      byteSha256(payload) !== file.sha256 ||
      Buffer.byteLength(payload, "utf8") !== file.bytes
    ) {
      fail(`${file.path} checksum or byte count is invalid.`);
    }
    payloads[file.path] = payload;
  }
  const expectedChecksums = checksumsPayload(manifest, manifestPayload);
  const actualChecksums = await readFile(
    join(root, "checksums.sha256"),
    "utf8",
  );
  if (actualChecksums !== expectedChecksums) {
    fail("checksums.sha256 is invalid.");
  }

  const plan = parseCanonicalJson(
    payloads["plan.json"],
    "plan.json",
  ) as Phase8SupportTunePlan;
  verifyPhase8SupportTunePlan(plan);
  const behaviorModel = parseSelectedBehaviorModelArtifact(
    payloads["selected-behavior-model.json"],
  );
  const games = parseCanonicalNdjson(
    payloads["games.ndjson"],
    "games.ndjson",
  ) as readonly Phase8SupportTuneGameRecord[];
  const observations = parseCanonicalNdjson(
    payloads["observations.eval-only.ndjson"],
    "observations.eval-only.ndjson",
  ) as readonly Phase8SupportTuneObservationRecord[];
  const candidateEvaluations = parseCanonicalJson(
    payloads["candidate-scores.json"],
    "candidate-scores.json",
  ) as readonly Phase8SupportTuneCandidateEvaluation[];
  const integrity = parseCanonicalJson(
    payloads["integrity.json"],
    "integrity.json",
  ) as Phase8SupportTuneIntegrity;
  const selectionEnvelope = parseCanonicalJson(
    payloads["selection.json"],
    "selection.json",
  ) as {
    readonly schemaVersion: 1;
    readonly evidenceEligible: boolean;
    readonly evidenceSha256: string;
    readonly provisionalSelectedPseudocount: number;
    readonly selection: Phase8SupportRegularizerTuneSelection | null;
  };
  const run = Object.freeze({
    plan,
    behaviorModel,
    games,
    observations,
    candidateEvaluations,
    integrity,
    evidenceSha256: selectionEnvelope.evidenceSha256,
    selection: selectionEnvelope.selection,
    provisionalSelectedPseudocount:
      selectionEnvelope.provisionalSelectedPseudocount,
  });
  verifyRun(run);
  if (
    manifest.evidenceEligible !== plan.evidenceEligible ||
    manifest.planSha256 !== plan.planSha256 ||
    manifest.evidenceSha256 !== run.evidenceSha256 ||
    manifest.selectionSha256 !== (run.selection?.selectionSha256 ?? null) ||
    manifest.provisionalSelectedPseudocount !==
      run.provisionalSelectedPseudocount ||
    selectionEnvelope.evidenceEligible !== plan.evidenceEligible
  ) {
    fail("manifest, selection envelope, and reproduced run disagree.");
  }
  return run;
}

export async function verifyPhase8SupportTuneArtifact(
  directory: string,
): Promise<Phase8SupportTuneArtifactVerification> {
  const root = resolve(directory);
  try {
    const run = await readPhase8SupportTuneArtifact(root);
    const manifest = parseCanonicalJson(
      await readFile(join(root, "manifest.json"), "utf8"),
      "manifest.json",
    ) as Phase8SupportTuneArtifactManifest;
    return Object.freeze({
      valid: true,
      directory: root,
      failures: Object.freeze([]),
      manifest,
      run,
    });
  } catch (error) {
    return Object.freeze({
      valid: false,
      directory: root,
      failures: Object.freeze([
        error instanceof Error
          ? error.message
          : "Unknown verification failure.",
      ]),
      manifest: null,
      run: null,
    });
  }
}
