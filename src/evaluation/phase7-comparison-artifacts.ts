import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { ACE_OF_SPADES, type Card } from "../domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../domain/rule-config";
import { SEATS, type Seat } from "../domain/seats";
import { stableHash, stableStringify } from "../events/stable-hash";
import { replayEvents } from "../events/timeline";
import { createSeededRng } from "../random/keyed-rng";
import {
  PHASE7_CANDIDATE_CONFIG_ID,
  PHASE7_REFERENCE_CONFIG_ID,
  phase7ComparisonConfigurationHash,
} from "./phase7-search-policy";
import {
  environmentArtifactSchema,
  type EnvironmentArtifact,
} from "./artifact-schema";
import {
  captureEnvironment,
  captureSourceSnapshot,
  type SourceSnapshot,
} from "./artifacts";
import {
  PHASE7_COMPARISON_BOOTSTRAP_RESAMPLES,
  PHASE7_COMPARISON_ARTIFACT_SCHEMA_VERSION,
  PHASE7_COMPARISON_EVIDENCE_CLASS,
  PHASE7_COMPARISON_RUNNER_VERSION,
  phase7ComparisonConfigurationSchema,
  phase7ComparisonDecisionRecordSchema,
  phase7ComparisonFailureRecordSchema,
  phase7ComparisonGameRecordSchema,
  phase7ComparisonLatencyRecordSchema,
  phase7ComparisonManifestSchema,
  phase7ComparisonReproductionAttestationSchema,
  phase7ComparisonReproductionReferenceSchema,
  phase7ComparisonSummarySchema,
  phase7ComparisonTruthRecordSchema,
  type Phase7ComparisonConfiguration,
  type Phase7ComparisonConfigRole,
  type Phase7ComparisonDecisionRecord,
  type Phase7ComparisonFailureRecord,
  type Phase7ComparisonGameRecord,
  type Phase7ComparisonLatencyRecord,
  type Phase7ComparisonManifest,
  type Phase7ComparisonReproductionAttestation,
  type Phase7ComparisonReproductionReference,
  type Phase7ComparisonRunKind,
  type Phase7ComparisonSummary,
  type Phase7ComparisonTruthRecord,
  type Phase7ConfigAggregate,
  type Phase7PairedMacroInterval,
  type Phase7RefusalCount,
} from "./phase7-comparison-schema";
import {
  EVALUATION_SPLITS,
  STYLE_CELLS,
  deriveDealSeed,
  deriveStreamSeed,
  type EvaluationSplit,
} from "./protocol";
import { createPolicyObservation, createSeededDeal } from "../simulator/game";
import {
  applyTruthCardPlay,
  applyTruthHandTaken,
  applyTruthPlayerDraw,
  applyTruthWasteDraw,
  assertSimulationTruthInvariant,
  createSimulationTruth,
  type SimulationTruth,
} from "../simulator/truth";

const PAYLOAD_FILES = [
  "command.txt",
  "decisions.ndjson",
  "environment.json",
  "failures.ndjson",
  "games.ndjson",
  "latencies.ndjson",
  "logs/run.log",
  "manifest.json",
  "summary.json",
  "summary.md",
  "truth.eval-only.ndjson",
] as const;
const ALL_FILES = [...PAYLOAD_FILES, "checksums.sha256"].sort();
const ATTESTATION_PAYLOAD_FILE = "attestation.json";
const ATTESTATION_FILES = [
  ATTESTATION_PAYLOAD_FILE,
  "checksums.sha256",
] as const;
const REQUIRED_STYLE_CELL_IDS = STYLE_CELLS.map((cell) => cell.id);
const REQUIRED_ROTATIONS = [0, 1, 2] as const;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._-]{2,79}$/u;
const PHASE7_SOLVER_SEED_CELL = "phase7-public-solver-inputs-v1";
const PHASE7_MACRO_BOOTSTRAP_CELL = "phase7-paired-macro";

export type Phase7ComparisonArtifactRun = {
  readonly manifest: Phase7ComparisonManifest;
  readonly environment: EnvironmentArtifact;
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly truths: readonly Phase7ComparisonTruthRecord[];
  readonly failures: readonly Phase7ComparisonFailureRecord[];
  readonly decisions: readonly Phase7ComparisonDecisionRecord[];
  readonly latencies: readonly Phase7ComparisonLatencyRecord[];
  readonly summary: Phase7ComparisonSummary;
  readonly summaryMarkdown: string;
  readonly log: string;
};

export type BuildPhase7ComparisonArtifactRunInput = {
  readonly projectRoot: string;
  readonly protocolPlanPath: string;
  readonly runId: string;
  readonly runKind: Phase7ComparisonRunKind;
  readonly reproductionReference?: Phase7ComparisonReproductionReference;
  readonly split: EvaluationSplit;
  readonly ruleProfileId: string;
  readonly rules: RuleConfig;
  readonly configurations: readonly Phase7ComparisonConfiguration[];
  readonly baseIndexStart: number;
  readonly baseCount: number;
  readonly eventCap: number;
  readonly verifyFallbackParity: true;
  readonly bootstrapSeedId: string;
  readonly command: string;
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly truths: readonly Phase7ComparisonTruthRecord[];
  readonly failures?: readonly Phase7ComparisonFailureRecord[];
  readonly decisions: readonly Phase7ComparisonDecisionRecord[];
  readonly latencies: readonly Phase7ComparisonLatencyRecord[];
  readonly createdAt?: string;
  readonly environment?: EnvironmentArtifact;
  readonly sourceSnapshot?: SourceSnapshot;
  readonly log?: string;
};

export type Phase7ComparisonArtifactVerification = {
  readonly valid: boolean;
  readonly runDirectory: string;
  readonly checkedFiles: number;
  readonly gamesReplayed: number;
  readonly truthsReplayed: number;
  readonly decisionsValidated: number;
  readonly latencyRecordsValidated: number;
  readonly recordedFailures: number;
  readonly failures: readonly string[];
  readonly scientificDigest: string | null;
  readonly zeroFailureGate: boolean | null;
};

export const PHASE7_COMPARISON_INDIVIDUAL_GATE_KEYS = [
  "protocolSampleSizeGate",
  "frozenConfigurationGate",
  "canonicalRulesGate",
  "seedDerivationGate",
  "pairedInitialDealGate",
  "decisionAuditCoverageGate",
  "zeroSilentExclusionGate",
  "fullMatrixGate",
  "identicalScenarioSeedCoverageGate",
  "pairingCompleteGate",
  "zeroFailureGate",
  "zeroTurnCapGate",
  "zeroInvariantFailureGate",
  "zeroCancellationGate",
  "zeroSilentFallbackGate",
  "atLeastOneExactUseGate",
  "zeroDeadlineRefusalGate",
  "everyCandidateFallbackTypedGate",
  "noPartialExactGate",
  "fallbackParityGate",
  "truthReplayGate",
] as const;

export function phase7ComparisonIndividualGateFailures(
  summary: Phase7ComparisonSummary,
): string[] {
  return PHASE7_COMPARISON_INDIVIDUAL_GATE_KEYS.filter((key) => !summary[key]);
}

export type Phase7ComparisonReproductionVerification = {
  readonly valid: boolean;
  readonly smokeDirectory: string;
  readonly primaryDirectory: string;
  readonly reproductionDirectory: string;
  readonly failures: readonly string[];
  readonly scientificDigestRerunGate: boolean;
  readonly scientificDigest: string | null;
  readonly scientificContractSha256: string | null;
  readonly attestation: Phase7ComparisonReproductionAttestation | null;
};

export type Phase7ComparisonAttestationVerification = {
  readonly valid: boolean;
  readonly attestationDirectory: string;
  readonly reproduction: Phase7ComparisonReproductionVerification;
  readonly failures: readonly string[];
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function ndjson(values: readonly unknown[]): string {
  return values.length === 0
    ? ""
    : `${values.map((value) => stableStringify(value)).join("\n")}\n`;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("Cannot average an empty collection.");
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function quantile(sorted: readonly number[], probability: number): number {
  const value = sorted[Math.floor((sorted.length - 1) * probability)];
  if (value === undefined) {
    throw new RangeError("Cannot select a quantile from an empty collection.");
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function expectedPhase7Configuration(
  role: Phase7ComparisonConfigRole,
): Phase7ComparisonConfiguration {
  return phase7ComparisonConfigurationSchema.parse({
    role,
    configId:
      role === "reference"
        ? PHASE7_REFERENCE_CONFIG_ID
        : PHASE7_CANDIDATE_CONFIG_ID,
    configHash: phase7ComparisonConfigurationHash(role),
    method:
      role === "reference"
        ? "frozen-phase5-balanced-hard-only"
        : "exact-information-state-then-frozen-phase5-fallback",
    executionPath:
      role === "reference"
        ? "direct-phase5-recommend-from-timeline-v1"
        : "research-exact-then-phase5-fallback-v1",
    budgetId: "balanced",
    beliefMode: "hard-only",
    continuationPolicies: {
      user: "documented-basic",
      p2: "documented-basic",
      p3: "documented-basic",
    },
    exactScreen:
      role === "candidate"
        ? {
            executionMode: "research-only",
            maxActiveCards: 7,
            maxJointHypotheses: 196,
            maxInformationStates: 128,
            maxBranches: 512,
            approximateHypothesisSamples: 196,
            deadlineMs: 1_000,
          }
        : null,
    exactEnabled: role === "candidate",
    behaviorWeightingEnabled: false,
  });
}

const EXPECTED_PHASE7_CONFIGURATIONS = Object.freeze([
  expectedPhase7Configuration("reference"),
  expectedPhase7Configuration("candidate"),
]);

function frozenConfigurationPass(
  configurations: readonly Phase7ComparisonConfiguration[],
): boolean {
  return (
    stableStringify(configurations) ===
    stableStringify(EXPECTED_PHASE7_CONFIGURATIONS)
  );
}

function canonicalRulesPass(ruleProfileId: string, rules: RuleConfig): boolean {
  return (
    ruleProfileId === "canonical-v1" &&
    stableStringify(rules) === stableStringify(CANONICAL_RULES)
  );
}

export function phase7ComparisonPairId(input: {
  readonly split: EvaluationSplit;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly replicate?: 0;
}): string {
  return [
    input.split,
    input.styleCellId,
    input.baseIndex.toString(),
    input.rotation.toString(),
    (input.replicate ?? 0).toString(),
  ].join("/");
}

export function phase7ComparisonClusterId(
  split: EvaluationSplit,
  baseIndex: number,
): string {
  return `${split}/${baseIndex.toString()}`;
}

function coordinateKey(value: {
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly configRole: Phase7ComparisonConfigRole;
}): string {
  return [
    value.baseIndex.toString().padStart(12, "0"),
    value.styleCellId,
    value.rotation.toString(),
    value.configRole === "reference" ? "0-reference" : "1-candidate",
  ].join("/");
}

function decisionKey(value: Phase7ComparisonDecisionRecord): string {
  return `${coordinateKey(value)}/${value.decisionOrdinal
    .toString()
    .padStart(8, "0")}/${value.decisionId}`;
}

function latencyKey(value: Phase7ComparisonLatencyRecord): string {
  return `${coordinateKey(value)}/${value.decisionOrdinal
    .toString()
    .padStart(8, "0")}/${value.decisionId}`;
}

export function canonicalizePhase7ComparisonRecords(input: {
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly truths: readonly Phase7ComparisonTruthRecord[];
  readonly failures?: readonly Phase7ComparisonFailureRecord[];
  readonly decisions: readonly Phase7ComparisonDecisionRecord[];
  readonly latencies: readonly Phase7ComparisonLatencyRecord[];
}): {
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly truths: readonly Phase7ComparisonTruthRecord[];
  readonly failures: readonly Phase7ComparisonFailureRecord[];
  readonly decisions: readonly Phase7ComparisonDecisionRecord[];
  readonly latencies: readonly Phase7ComparisonLatencyRecord[];
} {
  return Object.freeze({
    games: Object.freeze(
      [...input.games].sort((left, right) =>
        compareText(coordinateKey(left), coordinateKey(right)),
      ),
    ),
    truths: Object.freeze(
      [...input.truths].sort((left, right) =>
        compareText(coordinateKey(left), coordinateKey(right)),
      ),
    ),
    failures: Object.freeze(
      [...(input.failures ?? [])].sort((left, right) =>
        compareText(coordinateKey(left), coordinateKey(right)),
      ),
    ),
    decisions: Object.freeze(
      [...input.decisions].sort((left, right) =>
        compareText(decisionKey(left), decisionKey(right)),
      ),
    ),
    latencies: Object.freeze(
      [...input.latencies].sort((left, right) =>
        compareText(latencyKey(left), latencyKey(right)),
      ),
    ),
  });
}

function refusalCounts(
  decisions: readonly Phase7ComparisonDecisionRecord[],
): readonly Phase7RefusalCount[] {
  const counts = new Map<string, number>();
  for (const decision of decisions) {
    if (
      decision.exactOutcome === "refused" &&
      decision.exactRefusalCode !== null
    ) {
      counts.set(
        decision.exactRefusalCode,
        (counts.get(decision.exactRefusalCode) ?? 0) + 1,
      );
    }
  }
  return [...counts]
    .sort(([left], [right]) => compareText(left, right))
    .map(([code, count]) => ({ code, count }));
}

function configurationForRole(
  configurations: readonly Phase7ComparisonConfiguration[],
  role: Phase7ComparisonConfigRole,
): Phase7ComparisonConfiguration {
  const configuration = configurations.find(
    (candidate) => candidate.role === role,
  );
  if (configuration === undefined) {
    throw new Error(`Missing ${role} comparison configuration.`);
  }
  return configuration;
}

function aggregateForRole(input: {
  readonly role: Phase7ComparisonConfigRole;
  readonly configuration: Phase7ComparisonConfiguration;
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly failures: readonly Phase7ComparisonFailureRecord[];
  readonly decisions: readonly Phase7ComparisonDecisionRecord[];
}): Phase7ConfigAggregate {
  const games = input.games.filter((game) => game.configRole === input.role);
  const failures = input.failures.filter(
    (failure) => failure.configRole === input.role,
  );
  const decisions = input.decisions.filter(
    (decision) => decision.configRole === input.role,
  );
  const userBhabhiCount = games.filter((game) => game.userBhabhi).length;
  const exactAttemptCount = decisions.filter(
    (decision) => decision.exactOutcome !== "not-attempted",
  ).length;
  const exactUseCount = decisions.filter(
    (decision) => decision.exactOutcome === "used",
  ).length;
  const exactRefusalCount = decisions.filter(
    (decision) => decision.exactOutcome === "refused",
  ).length;
  const exactErrorCount = decisions.filter(
    (decision) => decision.exactOutcome === "error",
  ).length;
  const exactNotAttemptedCount = decisions.length - exactAttemptCount;
  const fallbackUseCount = decisions.filter(
    (decision) => decision.dispatchOutcome === "fallback",
  ).length;
  const silentFallbackCount = input.configuration.exactEnabled
    ? decisions.filter(
        (decision) =>
          decision.dispatchOutcome === "fallback" &&
          decision.exactOutcome === "not-attempted",
      ).length
    : 0;
  const fallbackParityCheckCount = decisions.filter(
    (decision) => decision.fallbackParity !== "not-checked",
  ).length;
  const fallbackParityFailureCount = decisions.filter(
    (decision) => decision.fallbackParity === "failed",
  ).length;
  return {
    role: input.role,
    configId: input.configuration.configId,
    games: games.length,
    failures: failures.length,
    userBhabhiCount,
    userBhabhiRate: games.length === 0 ? null : userBhabhiCount / games.length,
    userDecisionCount: decisions.length,
    exactAttemptCount,
    exactUseCount,
    exactRefusalCount,
    exactErrorCount,
    exactNotAttemptedCount,
    fallbackUseCount,
    refusalCounts: [...refusalCounts(decisions)],
    silentFallbackCount,
    fallbackParityCheckCount,
    fallbackParityFailureCount,
  };
}

function pairedMacroInterval(input: {
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly baseIndexStart: number;
  readonly baseCount: number;
  readonly bootstrapSeedId: string;
}): Phase7PairedMacroInterval {
  const referenceRates: number[] = [];
  const candidateRates: number[] = [];
  for (
    let baseIndex = input.baseIndexStart;
    baseIndex < input.baseIndexStart + input.baseCount;
    baseIndex += 1
  ) {
    const cluster = input.games.filter((game) => game.baseIndex === baseIndex);
    const reference = cluster.filter((game) => game.configRole === "reference");
    const candidate = cluster.filter((game) => game.configRole === "candidate");
    if (reference.length !== 51 || candidate.length !== 51) {
      throw new RangeError(
        `Base-index cluster ${baseIndex.toString()} is not a complete 51-outcome pair.`,
      );
    }
    referenceRates.push(
      mean(reference.map((game) => (game.userBhabhi ? 1 : 0))),
    );
    candidateRates.push(
      mean(candidate.map((game) => (game.userBhabhi ? 1 : 0))),
    );
  }
  const differences = candidateRates.map(
    (candidate, index) => candidate - (referenceRates[index] ?? 0),
  );
  const rng = createSeededRng(input.bootstrapSeedId).fork(
    "phase7-paired-macro-bootstrap",
    input.baseCount,
    PHASE7_COMPARISON_BOOTSTRAP_RESAMPLES,
  );
  const bootstrap: number[] = [];
  for (
    let resample = 0;
    resample < PHASE7_COMPARISON_BOOTSTRAP_RESAMPLES;
    resample += 1
  ) {
    let total = 0;
    for (let draw = 0; draw < differences.length; draw += 1) {
      total += differences[rng.nextInt(differences.length)] ?? 0;
    }
    bootstrap.push(total / differences.length);
  }
  bootstrap.sort((left, right) => left - right);
  return {
    metric: "user-bhabhi-rate-candidate-minus-reference",
    aggregation:
      "equal-weight-base-index-cluster-over-17-cells-and-3-rotations",
    method: "paired-cluster-bootstrap-percentile",
    confidenceLevel: 0.95,
    resamples: PHASE7_COMPARISON_BOOTSTRAP_RESAMPLES,
    seedId: input.bootstrapSeedId,
    clusterCount: input.baseCount,
    outcomesPerConfigPerCluster: 51,
    referenceRate: mean(referenceRates),
    candidateRate: mean(candidateRates),
    estimate: mean(differences),
    lower: quantile(bootstrap, 0.025),
    upper: quantile(bootstrap, 0.975),
  };
}

function latencyAggregate(
  role: Phase7ComparisonConfigRole,
  configuration: Phase7ComparisonConfiguration,
  latencies: readonly Phase7ComparisonLatencyRecord[],
): Phase7ComparisonSummary["latency"][number] {
  const values = latencies
    .filter((record) => record.configRole === role)
    .map((record) => record.totalMs)
    .sort((left, right) => left - right);
  return {
    role,
    configId: configuration.configId,
    samples: values.length,
    p50Ms: values.length === 0 ? null : quantile(values, 0.5),
    p95Ms: values.length === 0 ? null : quantile(values, 0.95),
    maxMs: values.at(-1) ?? null,
  };
}

function scientificGame(game: Phase7ComparisonGameRecord): unknown {
  return {
    pairId: game.pairId,
    clusterId: game.clusterId,
    configRole: game.configRole,
    configId: game.configId,
    styleCellId: game.styleCellId,
    baseIndex: game.baseIndex,
    rotation: game.rotation,
    replicate: game.replicate,
    opponentPolicies: game.opponentPolicies,
    bhabhi: game.bhabhi,
    userBhabhi: game.userBhabhi,
    userFinishingPosition: game.userFinishingPosition,
    escapeOrder: game.escapeOrder,
    terminalReason: game.terminalReason,
    terminalHandCounts: game.terminalHandCounts,
    eventCount: game.eventCount,
    publicHistoryHash: game.publicHistoryHash,
    terminalPublicStateHash: game.terminalPublicStateHash,
    deterministicOutcomeHash: game.deterministicOutcomeHash,
    deterministicGameDigest: game.deterministicGameDigest,
    events: game.events,
    seedIds: game.seedIds,
  };
}

function scientificTruth(truth: Phase7ComparisonTruthRecord): unknown {
  return {
    pairId: truth.pairId,
    configRole: truth.configRole,
    configId: truth.configId,
    styleCellId: truth.styleCellId,
    baseIndex: truth.baseIndex,
    rotation: truth.rotation,
    replicate: truth.replicate,
    initialHands: truth.initialHands,
    finalHands: truth.finalHands,
    truthHash: truth.truthHash,
  };
}

function scientificFailure(failure: Phase7ComparisonFailureRecord): unknown {
  return {
    pairId: failure.pairId,
    configRole: failure.configRole,
    configId: failure.configId,
    styleCellId: failure.styleCellId,
    baseIndex: failure.baseIndex,
    rotation: failure.rotation,
    replicate: failure.replicate,
    completionStatus: failure.completionStatus,
    kind: failure.kind,
    stage: failure.stage,
    error: failure.error,
    lastGoodEventIndex: failure.lastGoodEventIndex,
    deterministicFailureHash: failure.deterministicFailureHash,
    seedIds: failure.seedIds,
  };
}

function scientificDecision(decision: Phase7ComparisonDecisionRecord): unknown {
  return {
    pairId: decision.pairId,
    configRole: decision.configRole,
    configId: decision.configId,
    styleCellId: decision.styleCellId,
    baseIndex: decision.baseIndex,
    rotation: decision.rotation,
    replicate: decision.replicate,
    decisionOrdinal: decision.decisionOrdinal,
    eventIndex: decision.eventIndex,
    publicHistoryHash: decision.publicHistoryHash,
    publicStateHash: decision.publicStateHash,
    observationHash: decision.observationHash,
    actionKind: decision.actionKind,
    selectedCard: decision.selectedCard,
    selectedTakeTarget: decision.selectedTakeTarget,
    selectedActionHash: decision.selectedActionHash,
    dispatchOutcome: decision.dispatchOutcome,
    quality: decision.quality,
    exactOutcome: decision.exactOutcome,
    exactRefusalCode: decision.exactRefusalCode,
    exactRefusalDetail: decision.exactRefusalDetail,
    fallbackParity: decision.fallbackParity,
    dispatchHash: decision.dispatchHash,
    analysisInputHash: decision.analysisInputHash,
    analysisOutputHash: decision.analysisOutputHash,
    exactAlgorithmId: decision.exactAlgorithmId,
    exactConfigHash: decision.exactConfigHash,
    hypothesisSetHash: decision.hypothesisSetHash,
    exactResultHash: decision.exactResultHash,
    exactDiagnosticsHash: decision.exactDiagnosticsHash,
    exactActionValuesHash: decision.exactActionValuesHash,
    positionalDiagnosticsHash: decision.positionalDiagnosticsHash,
    fallbackConfigHash: decision.fallbackConfigHash,
    fallbackResultHash: decision.fallbackResultHash,
    beliefSeedId: decision.beliefSeedId,
    searchSeedId: decision.searchSeedId,
  };
}

export function phase7ComparisonScientificDigest(input: {
  readonly configurations: readonly Phase7ComparisonConfiguration[];
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly truths: readonly Phase7ComparisonTruthRecord[];
  readonly failures?: readonly Phase7ComparisonFailureRecord[];
  readonly decisions: readonly Phase7ComparisonDecisionRecord[];
}): string {
  const records = canonicalizePhase7ComparisonRecords({
    games: input.games,
    truths: input.truths,
    ...(input.failures === undefined ? {} : { failures: input.failures }),
    decisions: input.decisions,
    latencies: [],
  });
  const configurations = [...input.configurations].sort((left, right) =>
    compareText(left.role, right.role),
  );
  return `sha256:${sha256(
    stableStringify({
      protocol: PHASE7_COMPARISON_RUNNER_VERSION,
      configurations,
      games: records.games.map(scientificGame),
      truths: records.truths.map(scientificTruth),
      failures: records.failures.map(scientificFailure),
      decisions: records.decisions.map(scientificDecision),
    }),
  )}`;
}

export function phase7ComparisonScientificContractSha256(input: {
  readonly sourceSnapshotSha256: string;
  readonly sourceFileCount: number;
  readonly protocolPlanSha256: string;
  readonly split: EvaluationSplit;
  readonly ruleProfileId: string;
  readonly rules: RuleConfig;
  readonly rulesHash: string;
  readonly configurations: readonly Phase7ComparisonConfiguration[];
  readonly styleCellIds: readonly string[];
  readonly baseIndexStart: number;
  readonly baseCount: number;
  readonly rotations: readonly (0 | 1 | 2)[];
  readonly replicate: 0;
  readonly eventCap: number;
  readonly verifyFallbackParity: true;
  readonly bootstrapSeedId: string;
}): string {
  return sha256(
    stableStringify({
      schemaVersion: 1,
      protocolId: "eval-v1",
      runnerVersion: PHASE7_COMPARISON_RUNNER_VERSION,
      evidenceClass: PHASE7_COMPARISON_EVIDENCE_CLASS,
      scientificProjectionVersion:
        "phase7-timing-environment-free-projection-v1",
      sourceSnapshotSha256: input.sourceSnapshotSha256,
      sourceFileCount: input.sourceFileCount,
      protocolPlanSha256: input.protocolPlanSha256,
      split: input.split,
      ruleProfileId: input.ruleProfileId,
      rules: input.rules,
      rulesHash: input.rulesHash,
      configurations: input.configurations,
      styleCellIds: input.styleCellIds,
      baseIndexStart: input.baseIndexStart,
      baseCount: input.baseCount,
      rotations: input.rotations,
      replicate: input.replicate,
      eventCap: input.eventCap,
      verifyFallbackParity: input.verifyFallbackParity,
      seedPolicyId: "phase7-private-environment-public-solver-seeds-v1",
      bootstrapResamples: PHASE7_COMPARISON_BOOTSTRAP_RESAMPLES,
      bootstrapSeedId: input.bootstrapSeedId,
      clusterDefinition: "baseIndex-keeps-all-17-style-cells-and-3-rotations",
      pairingDefinition:
        "reference-and-candidate-share-style-cell-baseIndex-rotation",
      recordOrder: "baseIndex-style-cell-rotation-config-role-user-decision",
      nondeterministicFields: [
        "manifest.createdAt",
        "environment",
        "games[*].gameWallTimeMs",
        "latencies",
      ],
    }),
  );
}

function completePairCount(
  games: readonly Phase7ComparisonGameRecord[],
): number {
  const rolesByPair = new Map<string, Set<Phase7ComparisonConfigRole>>();
  for (const game of games) {
    const roles = rolesByPair.get(game.pairId) ?? new Set();
    roles.add(game.configRole);
    rolesByPair.set(game.pairId, roles);
  }
  return [...rolesByPair.values()].filter(
    (roles) => roles.has("reference") && roles.has("candidate"),
  ).length;
}

function completeMatrix(input: {
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly failures: readonly Phase7ComparisonFailureRecord[];
  readonly expectedGames: number;
}): boolean {
  const keys = [
    ...input.games.map(coordinateKey),
    ...input.failures.map(coordinateKey),
  ];
  return (
    keys.length === input.expectedGames && new Set(keys).size === keys.length
  );
}

function identicalScenarioSeedCoverage(input: {
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly failures: readonly Phase7ComparisonFailureRecord[];
  readonly expectedPairs: number;
}): boolean {
  const outcomes = [...input.games, ...input.failures];
  const byPair = new Map<
    string,
    (Phase7ComparisonGameRecord | Phase7ComparisonFailureRecord)[]
  >();
  for (const outcome of outcomes) {
    const pair = byPair.get(outcome.pairId) ?? [];
    pair.push(outcome);
    byPair.set(outcome.pairId, pair);
  }
  return (
    byPair.size === input.expectedPairs &&
    [...byPair.values()].every((pair) => {
      const reference = pair.find(
        (record) => record.configRole === "reference",
      );
      const candidate = pair.find(
        (record) => record.configRole === "candidate",
      );
      return (
        pair.length === 2 &&
        reference !== undefined &&
        candidate !== undefined &&
        stableStringify(reference.seedIds) ===
          stableStringify(candidate.seedIds)
      );
    })
  );
}

function expectedScenarioSeedIds(record: {
  readonly split: EvaluationSplit;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
}): Phase7ComparisonGameRecord["seedIds"] {
  const simulatorCommon = {
    split: record.split,
    cell: record.styleCellId,
    baseIndex: record.baseIndex,
    rotation: record.rotation,
    replicate: 0,
  } as const;
  const solverCommon = {
    split: record.split,
    cell: PHASE7_SOLVER_SEED_CELL,
    baseIndex: record.baseIndex,
    rotation: record.rotation,
    replicate: 0,
  } as const;
  const rollout = deriveStreamSeed({
    ...solverCommon,
    stream: "rollout",
  });
  return {
    deal: deriveDealSeed(record.split, record.baseIndex),
    userPolicy: rollout,
    p2Policy: deriveStreamSeed({
      ...simulatorCommon,
      stream: "p2-policy",
    }),
    p3Policy: deriveStreamSeed({
      ...simulatorCommon,
      stream: "p3-policy",
    }),
    environmentChance: deriveStreamSeed({
      ...simulatorCommon,
      stream: "chance",
    }),
    belief: deriveStreamSeed({ ...solverCommon, stream: "belief" }),
    search: deriveStreamSeed({ ...solverCommon, stream: "search" }),
    rollout,
    solverChance: deriveStreamSeed({
      ...solverCommon,
      stream: "chance",
    }),
    bootstrap: deriveStreamSeed({
      ...solverCommon,
      stream: "bootstrap",
    }),
  };
}

function seedDerivationPass(
  outcomes: readonly (
    Phase7ComparisonGameRecord | Phase7ComparisonFailureRecord
  )[],
): boolean {
  return outcomes.every(
    (record) =>
      stableStringify(record.seedIds) ===
      stableStringify(expectedScenarioSeedIds(record)),
  );
}

function pairedInitialDealPass(input: {
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly truths: readonly Phase7ComparisonTruthRecord[];
  readonly expectedPairs: number;
}): boolean {
  if (
    input.games.length !== input.expectedPairs * 2 ||
    input.truths.length !== input.expectedPairs * 2
  ) {
    return false;
  }
  const truthsByPair = new Map<string, Phase7ComparisonTruthRecord[]>();
  for (const truth of input.truths) {
    const pair = truthsByPair.get(truth.pairId) ?? [];
    pair.push(truth);
    truthsByPair.set(truth.pairId, pair);
  }
  return (
    truthsByPair.size === input.expectedPairs &&
    [...truthsByPair.values()].every((pair) => {
      const reference = pair.find((truth) => truth.configRole === "reference");
      const candidate = pair.find((truth) => truth.configRole === "candidate");
      if (
        pair.length !== 2 ||
        reference === undefined ||
        candidate === undefined
      ) {
        return false;
      }
      const expectedDeal = createSeededDeal(
        deriveDealSeed(reference.split, reference.baseIndex),
        reference.rotation,
      );
      return (
        stableStringify(reference.initialHands) ===
          stableStringify(candidate.initialHands) &&
        stableStringify(reference.initialHands) ===
          stableStringify(expectedDeal)
      );
    })
  );
}

function hasCompleteExactAudit(
  decision: Phase7ComparisonDecisionRecord,
): boolean {
  if (decision.exactOutcome === "used") {
    return (
      decision.dispatchOutcome === "exact" &&
      decision.quality === "Exact" &&
      decision.exactRefusalCode === null &&
      decision.exactRefusalDetail === null &&
      decision.exactAlgorithmId !== null &&
      decision.exactConfigHash !== null &&
      decision.hypothesisSetHash !== null &&
      decision.exactResultHash !== null &&
      decision.exactDiagnosticsHash !== null &&
      decision.exactActionValuesHash !== null &&
      decision.positionalDiagnosticsHash !== null &&
      decision.fallbackConfigHash === null &&
      decision.fallbackResultHash === null
    );
  }
  if (decision.exactOutcome === "refused") {
    return (
      decision.dispatchOutcome === "fallback" &&
      decision.quality === "Approximate" &&
      decision.exactRefusalCode !== null &&
      decision.exactRefusalDetail?.code === decision.exactRefusalCode &&
      decision.exactAlgorithmId !== null &&
      decision.exactConfigHash !== null &&
      decision.hypothesisSetHash !== null &&
      decision.exactResultHash !== null &&
      decision.exactDiagnosticsHash !== null &&
      decision.exactActionValuesHash !== null &&
      decision.positionalDiagnosticsHash === null &&
      decision.fallbackConfigHash !== null &&
      decision.fallbackResultHash !== null
    );
  }
  if (decision.exactOutcome === "error") {
    return (
      decision.dispatchOutcome === "fallback" &&
      decision.quality === "Approximate" &&
      decision.exactRefusalCode === null &&
      decision.exactRefusalDetail === null &&
      decision.exactResultHash !== null &&
      decision.exactDiagnosticsHash !== null &&
      decision.exactActionValuesHash === null &&
      decision.positionalDiagnosticsHash === null &&
      decision.fallbackConfigHash !== null &&
      decision.fallbackResultHash !== null
    );
  }
  return (
    decision.dispatchOutcome === "fallback" &&
    decision.quality === "Approximate" &&
    decision.exactRefusalCode === null &&
    decision.exactRefusalDetail === null &&
    decision.exactAlgorithmId === null &&
    decision.exactConfigHash === null &&
    decision.hypothesisSetHash === null &&
    decision.exactResultHash === null &&
    decision.exactDiagnosticsHash === null &&
    decision.exactActionValuesHash === null &&
    decision.positionalDiagnosticsHash === null &&
    decision.fallbackConfigHash !== null &&
    decision.fallbackResultHash !== null
  );
}

function truthReplayPass(
  rules: RuleConfig,
  games: readonly Phase7ComparisonGameRecord[],
  truths: readonly Phase7ComparisonTruthRecord[],
): boolean {
  if (games.length !== truths.length) {
    return false;
  }
  const truthsByGame = new Map(truths.map((truth) => [truth.gameId, truth]));
  if (truthsByGame.size !== truths.length) {
    return false;
  }
  try {
    for (const game of games) {
      const truth = truthsByGame.get(game.gameId);
      if (truth === undefined || !sameCoordinate(game, truth)) {
        return false;
      }
      const replay = replayEvents(game.events);
      if (
        replay.semanticHash !== game.publicHistoryHash ||
        stableHash(replay.state) !== game.terminalPublicStateHash
      ) {
        return false;
      }
      replayTruth(rules, game, truth);
    }
    return true;
  } catch {
    return false;
  }
}

function userActionForEvent(
  event: Phase7ComparisonGameRecord["events"][number],
):
  | {
      readonly actionKind: "play-card";
      readonly selectedCard: Card;
      readonly selectedTakeTarget: null;
    }
  | {
      readonly actionKind: "take-hand";
      readonly selectedCard: null;
      readonly selectedTakeTarget: Seat;
    }
  | null {
  if (event.type === "card-played" && event.seat === "user") {
    return {
      actionKind: "play-card",
      selectedCard: event.card,
      selectedTakeTarget: null,
    };
  }
  if (event.type === "hand-taken" && event.actor === "user") {
    return {
      actionKind: "take-hand",
      selectedCard: null,
      selectedTakeTarget: event.target,
    };
  }
  return null;
}

function decisionAuditCoveragePass(input: {
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly decisions: readonly Phase7ComparisonDecisionRecord[];
}): boolean {
  const completedGameIds = new Set(input.games.map((game) => game.gameId));
  const completedDecisions = input.decisions.filter((decision) =>
    completedGameIds.has(decision.gameId),
  );
  const decisionsByGameAndEvent = new Map<
    string,
    Phase7ComparisonDecisionRecord[]
  >();
  for (const decision of completedDecisions) {
    const key = `${decision.gameId}/${decision.eventIndex.toString()}`;
    const records = decisionsByGameAndEvent.get(key) ?? [];
    records.push(decision);
    decisionsByGameAndEvent.set(key, records);
  }
  let expectedDecisionCount = 0;
  for (const game of input.games) {
    for (let eventIndex = 0; eventIndex < game.events.length; eventIndex += 1) {
      const event = game.events[eventIndex];
      if (event === undefined) {
        return false;
      }
      const action = userActionForEvent(event);
      const key = `${game.gameId}/${eventIndex.toString()}`;
      const records = decisionsByGameAndEvent.get(key) ?? [];
      if (action === null) {
        if (records.length > 0) {
          return false;
        }
        continue;
      }
      expectedDecisionCount += 1;
      const record = records[0];
      if (
        records.length !== 1 ||
        record === undefined ||
        record.actionKind !== action.actionKind ||
        record.selectedCard !== action.selectedCard ||
        record.selectedTakeTarget !== action.selectedTakeTarget
      ) {
        return false;
      }
    }
  }
  return expectedDecisionCount === completedDecisions.length;
}

function protocolSampleSizePass(
  runKind: Phase7ComparisonRunKind,
  baseIndexStart: number,
  baseCount: number,
): boolean {
  return (
    baseIndexStart === 0 &&
    ((runKind === "smoke" && baseCount === 1) ||
      (runKind !== "smoke" && baseCount === 4))
  );
}

export function summarizePhase7Comparison(input: {
  readonly runId: string;
  readonly runKind: Phase7ComparisonRunKind;
  readonly ruleProfileId: string;
  readonly split: EvaluationSplit;
  readonly rules: RuleConfig;
  readonly configurations: readonly Phase7ComparisonConfiguration[];
  readonly baseIndexStart: number;
  readonly baseCount: number;
  readonly bootstrapSeedId: string;
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly truths: readonly Phase7ComparisonTruthRecord[];
  readonly failures?: readonly Phase7ComparisonFailureRecord[];
  readonly decisions: readonly Phase7ComparisonDecisionRecord[];
  readonly latencies: readonly Phase7ComparisonLatencyRecord[];
}): Phase7ComparisonSummary {
  const failures = input.failures ?? [];
  const expectedPairs = input.baseCount * REQUIRED_STYLE_CELL_IDS.length * 3;
  const expectedGames = expectedPairs * 2;
  const attemptedGames = input.games.length + failures.length;
  const completedPairs = completePairCount(input.games);
  const silentExclusionCount = Math.max(0, expectedGames - attemptedGames);
  const reference = configurationForRole(input.configurations, "reference");
  const candidate = configurationForRole(input.configurations, "candidate");
  const configAggregates = [
    aggregateForRole({
      role: "reference",
      configuration: reference,
      games: input.games,
      failures,
      decisions: input.decisions,
    }),
    aggregateForRole({
      role: "candidate",
      configuration: candidate,
      games: input.games,
      failures,
      decisions: input.decisions,
    }),
  ] as const;
  const candidateDecisions = input.decisions.filter(
    (decision) => decision.configRole === "candidate",
  );
  const fullMatrixGate = completeMatrix({
    games: input.games,
    failures,
    expectedGames,
  });
  const identicalScenarioSeedCoverageGate = identicalScenarioSeedCoverage({
    games: input.games,
    failures,
    expectedPairs,
  });
  const noPartialExactGate = input.decisions.every(hasCompleteExactAudit);
  const truthReplayGate = truthReplayPass(
    input.rules,
    input.games,
    input.truths,
  );
  const scientificDigest = phase7ComparisonScientificDigest({
    configurations: input.configurations,
    games: input.games,
    truths: input.truths,
    failures,
    decisions: input.decisions,
  });
  return phase7ComparisonSummarySchema.parse({
    schemaVersion: PHASE7_COMPARISON_ARTIFACT_SCHEMA_VERSION,
    protocolId: "eval-v1",
    runnerVersion: PHASE7_COMPARISON_RUNNER_VERSION,
    runId: input.runId,
    split: input.split,
    evidenceClass: PHASE7_COMPARISON_EVIDENCE_CLASS,
    evidenceEligible: false,
    runKind: input.runKind,
    expectedPairs,
    expectedGames,
    attemptedGames,
    completedPairs,
    completedGames: input.games.length,
    failedGames: failures.length,
    turnCapGames: failures.filter(
      (failure) => failure.completionStatus === "turn-cap",
    ).length,
    invariantFailures: failures.filter(
      (failure) => failure.kind === "invariant",
    ).length,
    cancellationFailures: failures.filter(
      (failure) => failure.completionStatus === "cancelled",
    ).length,
    truthRecords: input.truths.length,
    decisionRecords: input.decisions.length,
    latencyRecords: input.latencies.length,
    silentExclusionCount,
    protocolSampleSizeGate: protocolSampleSizePass(
      input.runKind,
      input.baseIndexStart,
      input.baseCount,
    ),
    frozenConfigurationGate: frozenConfigurationPass(input.configurations),
    canonicalRulesGate: canonicalRulesPass(input.ruleProfileId, input.rules),
    seedDerivationGate: seedDerivationPass([...input.games, ...failures]),
    pairedInitialDealGate: pairedInitialDealPass({
      games: input.games,
      truths: input.truths,
      expectedPairs,
    }),
    decisionAuditCoverageGate: decisionAuditCoveragePass({
      games: input.games,
      decisions: input.decisions,
    }),
    zeroSilentExclusionGate:
      silentExclusionCount === 0 && attemptedGames === expectedGames,
    fullMatrixGate,
    identicalScenarioSeedCoverageGate,
    pairingCompleteGate: completedPairs === expectedPairs,
    zeroFailureGate:
      failures.length === 0 && input.games.length === expectedGames,
    zeroTurnCapGate: failures.every(
      (failure) => failure.completionStatus !== "turn-cap",
    ),
    zeroInvariantFailureGate: failures.every(
      (failure) => failure.kind !== "invariant",
    ),
    zeroCancellationGate: failures.every(
      (failure) => failure.completionStatus !== "cancelled",
    ),
    zeroSilentFallbackGate: configAggregates.every(
      (aggregate) => aggregate.silentFallbackCount === 0,
    ),
    atLeastOneExactUseGate: candidateDecisions.some(
      (decision) => decision.exactOutcome === "used",
    ),
    zeroDeadlineRefusalGate: candidateDecisions.every(
      (decision) => decision.exactRefusalCode !== "DEADLINE",
    ),
    everyCandidateFallbackTypedGate: candidateDecisions
      .filter((decision) => decision.dispatchOutcome === "fallback")
      .every(
        (decision) =>
          decision.exactOutcome === "refused" &&
          decision.exactRefusalCode !== null &&
          decision.exactRefusalDetail?.code === decision.exactRefusalCode,
      ),
    noPartialExactGate,
    fallbackParityGate: candidateDecisions
      .filter((decision) => decision.dispatchOutcome === "fallback")
      .every((decision) => decision.fallbackParity === "passed"),
    truthReplayGate,
    configAggregates,
    pairedMacro:
      input.games.length === expectedGames &&
      failures.length === 0 &&
      completedPairs === expectedPairs
        ? pairedMacroInterval({
            games: input.games,
            baseIndexStart: input.baseIndexStart,
            baseCount: input.baseCount,
            bootstrapSeedId: input.bootstrapSeedId,
          })
        : null,
    latency: [
      latencyAggregate("reference", reference, input.latencies),
      latencyAggregate("candidate", candidate, input.latencies),
    ],
    scientificDigest,
  });
}

export function renderPhase7ComparisonSummaryMarkdown(
  summary: Phase7ComparisonSummary,
): string {
  const aggregates = summary.configAggregates
    .map(
      (aggregate) =>
        `| ${aggregate.role} | ${aggregate.configId} | ${aggregate.games.toString()} | ${aggregate.failures.toString()} | ${
          aggregate.userBhabhiRate === null
            ? "n/a"
            : `${(aggregate.userBhabhiRate * 100).toFixed(2)}%`
        } | ${aggregate.exactUseCount.toString()} | ${aggregate.exactRefusalCount.toString()} |`,
    )
    .join("\n");
  const macro =
    summary.pairedMacro === null
      ? "Unavailable because the complete paired schedule did not finish."
      : `${summary.pairedMacro.estimate.toFixed(6)} [${summary.pairedMacro.lower.toFixed(6)}, ${summary.pairedMacro.upper.toFixed(6)}]`;
  return [
    "# Phase 7 Paired Comparison",
    "",
    `- Run: \`${summary.runId}\``,
    `- Run kind: \`${summary.runKind}\``,
    `- Split: \`${summary.split}\``,
    `- Evidence eligible: no`,
    `- Attempted/completed/expected games: ${summary.attemptedGames.toString()} / ${summary.completedGames.toString()} / ${summary.expectedGames.toString()}`,
    `- Recorded failures: ${summary.failedGames.toString()}`,
    `- Silent exclusions: ${summary.silentExclusionCount.toString()}`,
    `- Complete paired base-cell-rotation units: ${summary.completedPairs.toString()} / ${summary.expectedPairs.toString()}`,
    `- Candidate minus reference paired macro interval: ${macro}`,
    `- Scientific digest: \`${summary.scientificDigest}\``,
    `- Rerun equality: not claimed by an individual run; requires the cross-artifact attestation`,
    "",
    "This is development evidence only and is never production-enable evidence.",
    "",
    "| Role | Config | Games | Failures | User Bhabhi rate | Exact uses | Typed refusals |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    aggregates,
    "",
  ].join("\n");
}

function sameCoordinate(
  left: {
    readonly runId: string;
    readonly split: string;
    readonly evidenceClass: string;
    readonly pairId: string;
    readonly clusterId: string;
    readonly configRole: Phase7ComparisonConfigRole;
    readonly configId: string;
    readonly styleCellId: string;
    readonly baseIndex: number;
    readonly rotation: 0 | 1 | 2;
    readonly replicate: 0;
    readonly gameId: string;
  },
  right: {
    readonly runId: string;
    readonly split: string;
    readonly evidenceClass: string;
    readonly pairId: string;
    readonly clusterId: string;
    readonly configRole: Phase7ComparisonConfigRole;
    readonly configId: string;
    readonly styleCellId: string;
    readonly baseIndex: number;
    readonly rotation: 0 | 1 | 2;
    readonly replicate: 0;
    readonly gameId: string;
  },
): boolean {
  return (
    stableStringify({
      runId: left.runId,
      split: left.split,
      evidenceClass: left.evidenceClass,
      pairId: left.pairId,
      clusterId: left.clusterId,
      configRole: left.configRole,
      configId: left.configId,
      styleCellId: left.styleCellId,
      baseIndex: left.baseIndex,
      rotation: left.rotation,
      replicate: left.replicate,
      gameId: left.gameId,
    }) ===
    stableStringify({
      runId: right.runId,
      split: right.split,
      evidenceClass: right.evidenceClass,
      pairId: right.pairId,
      clusterId: right.clusterId,
      configRole: right.configRole,
      configId: right.configId,
      styleCellId: right.styleCellId,
      baseIndex: right.baseIndex,
      rotation: right.rotation,
      replicate: right.replicate,
      gameId: right.gameId,
    })
  );
}

function replayTruthPrefix(
  rules: RuleConfig,
  game: Phase7ComparisonGameRecord,
  truth: Phase7ComparisonTruthRecord,
  endExclusive: number,
): SimulationTruth {
  const setup = game.events[0];
  if (setup?.type !== "game-created") {
    throw new Error(`${game.gameId} has no game-created setup event.`);
  }
  const aceSpadesHolder = SEATS.find((seat) =>
    truth.initialHands[seat].includes(ACE_OF_SPADES),
  );
  if (
    stableStringify(setup.rules) !== stableStringify(rules) ||
    stableStringify(setup.userHand) !==
      stableStringify(truth.initialHands.user) ||
    stableStringify(setup.startingCounts) !==
      stableStringify({
        user: truth.initialHands.user.length,
        p2: truth.initialHands.p2.length,
        p3: truth.initialHands.p3.length,
      }) ||
    setup.aceSpadesHolder !== aceSpadesHolder
  ) {
    throw new Error(`${game.gameId} setup does not bind its truth sidecar.`);
  }
  if (
    !Number.isSafeInteger(endExclusive) ||
    endExclusive < 1 ||
    endExclusive > game.events.length
  ) {
    throw new RangeError(
      `${game.gameId} truth prefix ${endExclusive.toString()} is invalid.`,
    );
  }
  let simulation = createSimulationTruth(truth.initialHands, rules);
  for (let eventIndex = 1; eventIndex < endExclusive; eventIndex += 1) {
    const event = game.events[eventIndex];
    if (event === undefined || event.type === "game-created") {
      throw new Error(
        `${game.gameId} contains an invalid truth event at ${eventIndex.toString()}.`,
      );
    }
    simulation = applyTruthEvent(simulation, event, eventIndex);
  }
  assertSimulationTruthInvariant(simulation);
  return simulation;
}

function applyTruthEvent(
  simulation: SimulationTruth,
  event: Exclude<
    Phase7ComparisonGameRecord["events"][number],
    { readonly type: "game-created" }
  >,
  eventIndex: number,
): SimulationTruth {
  switch (event.type) {
    case "card-played":
      return applyTruthCardPlay(simulation, event, eventIndex);
    case "waste-card-drawn":
      return applyTruthWasteDraw(simulation, event, eventIndex);
    case "player-card-drawn":
      return applyTruthPlayerDraw(simulation, event, eventIndex);
    case "hand-taken":
      return applyTruthHandTaken(simulation, event, eventIndex);
  }
}

function replayUserObservationHashes(
  rules: RuleConfig,
  game: Phase7ComparisonGameRecord,
  truth: Phase7ComparisonTruthRecord,
): ReadonlyMap<number, string> {
  let simulation = replayTruthPrefix(rules, game, truth, 1);
  const hashes = new Map<number, string>();
  let decisionOrdinal = 0;
  for (let eventIndex = 1; eventIndex < game.events.length; eventIndex += 1) {
    const event = game.events[eventIndex];
    if (event === undefined || event.type === "game-created") {
      throw new Error(
        `${game.gameId} contains an invalid event at ${eventIndex.toString()}.`,
      );
    }
    if (userActionForEvent(event) !== null) {
      hashes.set(
        eventIndex,
        stableHash(
          createPolicyObservation(
            simulation,
            "user",
            decisionOrdinal,
            game.events.slice(0, eventIndex),
          ),
        ),
      );
      decisionOrdinal += 1;
    }
    simulation = applyTruthEvent(simulation, event, eventIndex);
  }
  return hashes;
}

function replayTruth(
  rules: RuleConfig,
  game: Phase7ComparisonGameRecord,
  truth: Phase7ComparisonTruthRecord,
): SimulationTruth {
  const simulation = replayTruthPrefix(rules, game, truth, game.events.length);
  if (stableStringify(simulation.hands) !== stableStringify(truth.finalHands)) {
    throw new Error(`${game.gameId} final truth hands mismatch.`);
  }
  const publicReplay = replayEvents(game.events);
  if (
    stableStringify(simulation.publicState) !==
    stableStringify(publicReplay.state)
  ) {
    throw new Error(`${game.gameId} truth/public terminal states diverge.`);
  }
  const derivedEscapeOrder = [
    ...simulation.publicState.escapeGroups.flatMap((group) => group.seats),
    ...(simulation.publicState.bhabhi === null
      ? []
      : [simulation.publicState.bhabhi]),
  ];
  const derivedUserPosition = derivedEscapeOrder.indexOf("user") + 1;
  const terminalEffect = [...simulation.publicState.effects]
    .reverse()
    .find((effect) => effect.type === "game-completed");
  if (
    simulation.publicState.bhabhi !== game.bhabhi ||
    stableStringify(derivedEscapeOrder) !== stableStringify(game.escapeOrder) ||
    derivedUserPosition !== game.userFinishingPosition ||
    terminalEffect?.type !== "game-completed" ||
    terminalEffect.reason !== game.terminalReason
  ) {
    throw new Error(`${game.gameId} terminal outcome fields are not derived.`);
  }
  const truthHash = stableHash({
    hands: simulation.hands,
    publicState: simulation.publicState,
  });
  if (truthHash !== truth.truthHash) {
    throw new Error(`${game.gameId} terminal truth hash mismatch.`);
  }
  return simulation;
}

function validateDecisionSemantics(
  decision: Phase7ComparisonDecisionRecord,
  configuration: Phase7ComparisonConfiguration,
  failures: string[],
): void {
  if (!hasCompleteExactAudit(decision)) {
    failures.push(
      `${decision.decisionId} has a partial or internally inconsistent exact audit.`,
    );
  }
  if (
    (decision.actionKind === "play-card" &&
      (decision.selectedCard === null ||
        decision.selectedTakeTarget !== null)) ||
    (decision.actionKind === "take-hand" &&
      (decision.selectedCard !== null || decision.selectedTakeTarget === null))
  ) {
    failures.push(
      `${decision.decisionId} has an inconsistent selected action.`,
    );
  }
  if (
    decision.selectedActionHash !==
    stableHash({
      actionKind: decision.actionKind,
      selectedCard: decision.selectedCard,
      selectedTakeTarget: decision.selectedTakeTarget,
    })
  ) {
    failures.push(`${decision.decisionId} selected-action hash mismatch.`);
  }
  if (
    decision.exactOutcome === "used" &&
    (decision.dispatchOutcome !== "exact" ||
      decision.quality !== "Exact" ||
      decision.exactRefusalCode !== null ||
      decision.exactAlgorithmId === null ||
      decision.exactConfigHash === null ||
      decision.hypothesisSetHash === null ||
      decision.exactResultHash === null ||
      decision.fallbackResultHash !== null)
  ) {
    failures.push(`${decision.decisionId} has an invalid exact-use audit.`);
  }
  if (
    decision.exactOutcome === "refused" &&
    (decision.dispatchOutcome !== "fallback" ||
      decision.quality !== "Approximate" ||
      decision.exactRefusalCode === null ||
      decision.exactAlgorithmId === null ||
      decision.exactConfigHash === null ||
      decision.exactResultHash === null ||
      decision.fallbackConfigHash === null ||
      decision.fallbackResultHash === null)
  ) {
    failures.push(`${decision.decisionId} has an invalid typed-refusal audit.`);
  }
  if (
    decision.exactOutcome === "error" &&
    (decision.dispatchOutcome !== "fallback" ||
      decision.quality !== "Approximate" ||
      decision.exactRefusalCode !== null ||
      decision.exactResultHash === null ||
      decision.fallbackConfigHash === null ||
      decision.fallbackResultHash === null)
  ) {
    failures.push(`${decision.decisionId} has an invalid exact-error audit.`);
  }
  if (
    decision.exactOutcome === "not-attempted" &&
    (decision.dispatchOutcome !== "fallback" ||
      decision.quality !== "Approximate" ||
      decision.exactRefusalCode !== null ||
      decision.exactAlgorithmId !== null ||
      decision.exactConfigHash !== null ||
      decision.hypothesisSetHash !== null ||
      decision.exactResultHash !== null ||
      decision.fallbackConfigHash === null ||
      decision.fallbackResultHash === null)
  ) {
    failures.push(
      `${decision.decisionId} has an invalid exact-not-attempted audit.`,
    );
  }
  if (
    !configuration.exactEnabled &&
    decision.exactOutcome !== "not-attempted"
  ) {
    failures.push(
      `${decision.decisionId} attempted exact search under an exact-disabled configuration.`,
    );
  }
}

function recordIdentityIssues(
  manifest: Phase7ComparisonManifest,
  record:
    | Phase7ComparisonGameRecord
    | Phase7ComparisonTruthRecord
    | Phase7ComparisonFailureRecord
    | Phase7ComparisonDecisionRecord
    | Phase7ComparisonLatencyRecord,
): readonly string[] {
  const issues: string[] = [];
  const configuration = configurationForRole(
    manifest.configurations,
    record.configRole,
  );
  if (record.runId !== manifest.runId || record.split !== manifest.split) {
    issues.push(`${record.recordType} record has a mismatched run identity.`);
  }
  if (record.configId !== configuration.configId) {
    issues.push(`${record.recordType} record has a mismatched config ID.`);
  }
  if (
    !manifest.styleCellIds.includes(record.styleCellId) ||
    !manifest.rotations.includes(record.rotation) ||
    record.baseIndex < manifest.baseIndexStart ||
    record.baseIndex >= manifest.baseIndexStart + manifest.baseCount
  ) {
    issues.push(`${record.recordType} record is outside the frozen schedule.`);
  }
  const expectedPairId = phase7ComparisonPairId({
    split: manifest.split,
    styleCellId: record.styleCellId,
    baseIndex: record.baseIndex,
    rotation: record.rotation,
  });
  if (record.pairId !== expectedPairId) {
    issues.push(`${record.recordType} record has a mismatched pair ID.`);
  }
  if (
    record.clusterId !==
    phase7ComparisonClusterId(manifest.split, record.baseIndex)
  ) {
    issues.push(`${record.recordType} record has a mismatched cluster ID.`);
  }
  const expectedGameId = stableHash({
    schemaVersion: 1,
    protocol: "phase7-paired-comparison-v1",
    pairId: expectedPairId,
    configId: configuration.configId,
    rules: manifest.rules,
  });
  if (record.gameId !== expectedGameId) {
    issues.push(`${record.recordType} record has a mismatched game ID.`);
  }
  return issues;
}

export function validatePhase7ComparisonArtifactRun(
  runValue: Phase7ComparisonArtifactRun,
): readonly string[] {
  const failures: string[] = [];
  let run: Phase7ComparisonArtifactRun;
  try {
    run = {
      manifest: phase7ComparisonManifestSchema.parse(runValue.manifest),
      environment: environmentArtifactSchema.parse(runValue.environment),
      games: phase7ComparisonGameRecordSchema.array().parse(runValue.games),
      truths: phase7ComparisonTruthRecordSchema.array().parse(runValue.truths),
      failures: phase7ComparisonFailureRecordSchema
        .array()
        .parse(runValue.failures),
      decisions: phase7ComparisonDecisionRecordSchema
        .array()
        .parse(runValue.decisions),
      latencies: phase7ComparisonLatencyRecordSchema
        .array()
        .parse(runValue.latencies),
      summary: phase7ComparisonSummarySchema.parse(runValue.summary),
      summaryMarkdown: runValue.summaryMarkdown,
      log: runValue.log,
    };
  } catch (error) {
    return [
      `Phase 7 comparison schema validation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  const { manifest } = run;
  if (!SAFE_RUN_ID.test(manifest.runId)) {
    failures.push("Manifest run ID is not filesystem-safe.");
  }
  if (run.environment.capturedAt !== manifest.createdAt) {
    failures.push("Environment and manifest capture timestamps differ.");
  }
  if (
    stableStringify(manifest.styleCellIds) !==
      stableStringify(REQUIRED_STYLE_CELL_IDS) ||
    stableStringify(manifest.rotations) !== stableStringify(REQUIRED_ROTATIONS)
  ) {
    failures.push(
      "Manifest must contain the exact frozen 17-cell by 3-rotation schedule.",
    );
  }
  if (
    !protocolSampleSizePass(
      manifest.runKind,
      manifest.baseIndexStart,
      manifest.baseCount,
    )
  ) {
    failures.push(
      "Manifest run kind does not match the preregistered sample profile.",
    );
  }
  if (
    (manifest.runKind === "development-reproduction") !==
      (manifest.reproductionReference !== null) ||
    manifest.reproductionReference?.runId === manifest.runId
  ) {
    failures.push(
      "Manifest reproduction reference is missing, misplaced, or self-referential.",
    );
  }
  if (!frozenConfigurationPass(manifest.configurations)) {
    failures.push(
      "Manifest configurations differ from the full frozen Phase 7 descriptors.",
    );
  }
  if (
    !canonicalRulesPass(manifest.ruleProfileId, manifest.rules) ||
    manifest.rulesHash !== stableHash(manifest.rules)
  ) {
    failures.push(
      "Manifest rules/profile/hash differ from the canonical frozen rules.",
    );
  }
  const expectedBootstrapSeed = deriveStreamSeed({
    split: manifest.split,
    stream: "bootstrap",
    cell: PHASE7_MACRO_BOOTSTRAP_CELL,
    baseIndex: manifest.baseIndexStart,
    rotation: 0,
    replicate: 0,
  });
  if (manifest.bootstrapSeedId !== expectedBootstrapSeed) {
    failures.push("Manifest bootstrap seed is not coordinate-derived.");
  }
  const expectedScientificContract = phase7ComparisonScientificContractSha256({
    sourceSnapshotSha256: manifest.sourceSnapshotSha256,
    sourceFileCount: manifest.sourceFileCount,
    protocolPlanSha256: manifest.protocolPlanSha256,
    split: manifest.split,
    ruleProfileId: manifest.ruleProfileId,
    rules: manifest.rules,
    rulesHash: manifest.rulesHash,
    configurations: manifest.configurations,
    styleCellIds: manifest.styleCellIds,
    baseIndexStart: manifest.baseIndexStart,
    baseCount: manifest.baseCount,
    rotations: manifest.rotations,
    replicate: manifest.replicate,
    eventCap: manifest.eventCap,
    verifyFallbackParity: manifest.verifyFallbackParity,
    bootstrapSeedId: manifest.bootstrapSeedId,
  });
  if (manifest.scientificContractSha256 !== expectedScientificContract) {
    failures.push("Manifest scientific contract hash does not regenerate.");
  }
  const roles = manifest.configurations.map((config) => config.role);
  if (
    new Set(roles).size !== 2 ||
    !roles.includes("reference") ||
    !roles.includes("candidate")
  ) {
    failures.push(
      "Manifest must contain exactly one reference and one candidate configuration.",
    );
  } else {
    const reference = configurationForRole(
      manifest.configurations,
      "reference",
    );
    const candidate = configurationForRole(
      manifest.configurations,
      "candidate",
    );
    if (reference.exactEnabled || !candidate.exactEnabled) {
      failures.push(
        "Phase 7 comparison requires exact-disabled reference and exact-enabled candidate configurations.",
      );
    }
  }
  const expectedPairs = manifest.baseCount * REQUIRED_STYLE_CELL_IDS.length * 3;
  if (
    manifest.expectedPairs !== expectedPairs ||
    manifest.expectedGames !== expectedPairs * 2
  ) {
    failures.push("Manifest expected counts do not match its frozen schedule.");
  }

  const canonical = canonicalizePhase7ComparisonRecords(run);
  for (const [label, actual, expected] of [
    ["games", run.games, canonical.games],
    ["truths", run.truths, canonical.truths],
    ["failures", run.failures, canonical.failures],
    ["decisions", run.decisions, canonical.decisions],
    ["latencies", run.latencies, canonical.latencies],
  ] as const) {
    if (stableStringify(actual) !== stableStringify(expected)) {
      failures.push(`${label} records are not in canonical record order.`);
    }
  }
  for (const record of [
    ...run.games,
    ...run.truths,
    ...run.failures,
    ...run.decisions,
    ...run.latencies,
  ]) {
    failures.push(...recordIdentityIssues(manifest, record));
  }

  const outcomes = new Map<string, "game" | "failure">();
  for (const game of run.games) {
    const key = coordinateKey(game);
    if (outcomes.has(key)) {
      failures.push(`Duplicate scheduled outcome ${key}.`);
    }
    outcomes.set(key, "game");
  }
  for (const failure of run.failures) {
    const key = coordinateKey(failure);
    if (outcomes.has(key)) {
      failures.push(`Duplicate scheduled outcome ${key}.`);
    }
    outcomes.set(key, "failure");
  }
  for (
    let baseIndex = manifest.baseIndexStart;
    baseIndex < manifest.baseIndexStart + manifest.baseCount;
    baseIndex += 1
  ) {
    for (const styleCellId of manifest.styleCellIds) {
      for (const rotation of manifest.rotations) {
        for (const configRole of ["reference", "candidate"] as const) {
          const key = coordinateKey({
            styleCellId,
            baseIndex,
            rotation,
            configRole,
          });
          if (!outcomes.has(key)) {
            failures.push(`Missing scheduled outcome ${key}.`);
          }
        }
      }
    }
  }
  if (outcomes.size !== manifest.expectedGames) {
    failures.push(
      `Scheduled outcome denominator is ${outcomes.size.toString()}, expected ${manifest.expectedGames.toString()}.`,
    );
  }
  if (
    !identicalScenarioSeedCoverage({
      games: run.games,
      failures: run.failures,
      expectedPairs: manifest.expectedPairs,
    })
  ) {
    failures.push(
      "Reference/candidate scenario coverage or deterministic seed IDs differ.",
    );
  }
  if (!seedDerivationPass([...run.games, ...run.failures])) {
    failures.push(
      "One or more scenario seeds do not match the frozen public/private derivation.",
    );
  }
  if (
    run.truths.some(
      (truth) =>
        stableStringify(truth.initialHands) !==
        stableStringify(
          createSeededDeal(
            deriveDealSeed(truth.split, truth.baseIndex),
            truth.rotation,
          ),
        ),
    ) ||
    (run.failures.length === 0 &&
      !pairedInitialDealPass({
        games: run.games,
        truths: run.truths,
        expectedPairs: manifest.expectedPairs,
      }))
  ) {
    failures.push(
      "Paired truth sidecars do not share the coordinate-derived initial deal.",
    );
  }

  const truthsByGame = new Map(
    run.truths.map((truth) => [truth.gameId, truth]),
  );
  if (truthsByGame.size !== run.truths.length) {
    failures.push("Eval-only truth records contain duplicate game IDs.");
  }
  const expectedObservationHashes = new Map<string, string>();
  for (const game of run.games) {
    if (game.userBhabhi !== (game.bhabhi === "user")) {
      failures.push(`${game.gameId} has an inconsistent user-Bhabhi flag.`);
    }
    const style = STYLE_CELLS.find((cell) => cell.id === game.styleCellId);
    if (
      style === undefined ||
      style.p2 !== game.opponentPolicies.p2 ||
      style.p3 !== game.opponentPolicies.p3
    ) {
      failures.push(`${game.gameId} has mismatched opponent policies.`);
    }
    try {
      const replay = replayEvents(game.events);
      if (
        game.eventCount !== game.events.length ||
        replay.semanticHash !== game.publicHistoryHash ||
        stableHash(replay.state) !== game.terminalPublicStateHash
      ) {
        throw new Error(`${game.gameId} public replay hash/count mismatch.`);
      }
      if (
        replay.state.bhabhi !== game.bhabhi ||
        stableStringify(replay.state.handCounts) !==
          stableStringify(game.terminalHandCounts)
      ) {
        throw new Error(`${game.gameId} terminal public outcome mismatch.`);
      }
      const outcomeHash = stableHash({
        bhabhi: replay.state.bhabhi,
        escapeOrder: game.escapeOrder,
        historyHash: replay.semanticHash,
        terminalPublicStateHash: game.terminalPublicStateHash,
      });
      if (outcomeHash !== game.deterministicOutcomeHash) {
        throw new Error(`${game.gameId} deterministic outcome hash mismatch.`);
      }
      const gameDigest = stableHash({
        gameId: game.gameId,
        events: game.events,
        bhabhi: game.bhabhi,
        escapeOrder: game.escapeOrder,
        terminalPublicStateHash: game.terminalPublicStateHash,
        deterministicOutcomeHash: game.deterministicOutcomeHash,
      });
      if (gameDigest !== game.deterministicGameDigest) {
        throw new Error(`${game.gameId} deterministic game digest mismatch.`);
      }
      const truth = truthsByGame.get(game.gameId);
      if (truth === undefined || !sameCoordinate(game, truth)) {
        throw new Error(`${game.gameId} has no matching eval-only truth.`);
      }
      replayTruth(manifest.rules, game, truth);
      for (const [eventIndex, observationHash] of replayUserObservationHashes(
        manifest.rules,
        game,
        truth,
      )) {
        expectedObservationHashes.set(
          `${game.gameId}/${eventIndex.toString()}`,
          observationHash,
        );
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (run.truths.length !== run.games.length) {
    failures.push("Completed game and eval-only truth cardinalities differ.");
  }
  for (const truth of run.truths) {
    if (!run.games.some((game) => game.gameId === truth.gameId)) {
      failures.push(`${truth.gameId} truth has no completed game.`);
    }
  }

  const recordsByGame = new Map<
    string,
    Phase7ComparisonGameRecord | Phase7ComparisonFailureRecord
  >();
  for (const record of [...run.games, ...run.failures]) {
    recordsByGame.set(record.gameId, record);
  }
  const decisionIds = new Set<string>();
  const decisionById = new Map<string, Phase7ComparisonDecisionRecord>();
  for (const decision of run.decisions) {
    if (decisionIds.has(decision.decisionId)) {
      failures.push(`Duplicate decision ID ${decision.decisionId}.`);
    }
    decisionIds.add(decision.decisionId);
    decisionById.set(decision.decisionId, decision);
    const owner = recordsByGame.get(decision.gameId);
    if (owner === undefined || !sameCoordinate(owner, decision)) {
      failures.push(`${decision.decisionId} has no matching game outcome.`);
      continue;
    }
    const configuration = configurationForRole(
      manifest.configurations,
      decision.configRole,
    );
    validateDecisionSemantics(decision, configuration, failures);
    if ("events" in owner) {
      if (
        decision.eventIndex < 1 ||
        decision.eventIndex >= owner.events.length
      ) {
        failures.push(
          `${decision.decisionId} does not bind its pre-action public history/state.`,
        );
      } else {
        try {
          if (
            decision.decisionId !==
            `${decision.gameId}/${decision.eventIndex.toString()}`
          ) {
            throw new Error(
              `${decision.decisionId} does not use the canonical event-bound ID`,
            );
          }
          const decisionEvent = owner.events[decision.eventIndex];
          if (decisionEvent === undefined) {
            throw new Error(
              `${decision.decisionId} has no event at its bound index`,
            );
          }
          const action = userActionForEvent(decisionEvent);
          if (
            action === null ||
            decision.actionKind !== action.actionKind ||
            decision.selectedCard !== action.selectedCard ||
            decision.selectedTakeTarget !== action.selectedTakeTarget
          ) {
            throw new Error(
              `${decision.decisionId} does not match the recorded user action`,
            );
          }
          const publicPrefix = replayEvents(
            owner.events.slice(0, decision.eventIndex),
          );
          if (
            publicPrefix.semanticHash !== decision.publicHistoryHash ||
            stableHash(publicPrefix.state) !== decision.publicStateHash
          ) {
            failures.push(
              `${decision.decisionId} does not bind its pre-action public history/state.`,
            );
          }
          if (
            expectedObservationHashes.get(
              `${owner.gameId}/${decision.eventIndex.toString()}`,
            ) !== decision.observationHash
          ) {
            throw new Error(
              `${decision.decisionId} observation hash does not replay`,
            );
          }
          if (
            decision.beliefSeedId !== owner.seedIds.belief ||
            decision.searchSeedId !== owner.seedIds.search ||
            decision.analysisInputHash !==
              stableHash({
                configId: decision.configId,
                historyHash: decision.publicHistoryHash,
                publicStateHash: decision.publicStateHash,
                observationHash: decision.observationHash,
                beliefSeed: owner.seedIds.belief,
                searchSeed: owner.seedIds.search,
                rolloutSeed: owner.seedIds.rollout,
                chanceSeed: owner.seedIds.solverChance,
                bootstrapSeed: owner.seedIds.bootstrap,
              })
          ) {
            throw new Error(
              `${decision.decisionId} solver-input seed/hash binding is invalid`,
            );
          }
        } catch (error) {
          failures.push(
            `${decision.decisionId} decision replay failed: ${
              error instanceof Error ? error.message : String(error)
            }.`,
          );
        }
      }
    } else if (decision.eventIndex > owner.lastGoodEventIndex + 1) {
      failures.push(`${decision.decisionId} exceeds its failed run prefix.`);
    }
  }
  const decisionsByGame = new Map<string, number[]>();
  for (const decision of run.decisions) {
    const ordinals = decisionsByGame.get(decision.gameId) ?? [];
    ordinals.push(decision.decisionOrdinal);
    decisionsByGame.set(decision.gameId, ordinals);
  }
  for (const [gameId, ordinals] of decisionsByGame) {
    const sorted = [...ordinals].sort((left, right) => left - right);
    if (
      sorted.some(
        (ordinal, index) => ordinal !== index || sorted[index - 1] === ordinal,
      )
    ) {
      failures.push(`${gameId} user decision ordinals are not contiguous.`);
    }
  }
  if (
    !decisionAuditCoveragePass({
      games: run.games,
      decisions: run.decisions,
    })
  ) {
    failures.push(
      "Completed games do not have exactly one action-matching audit per user decision.",
    );
  }
  for (const game of run.games) {
    let expectedOrdinal = 0;
    for (let eventIndex = 0; eventIndex < game.events.length; eventIndex += 1) {
      const event = game.events[eventIndex];
      if (event === undefined || userActionForEvent(event) === null) {
        continue;
      }
      const matches = run.decisions.filter(
        (decision) =>
          decision.gameId === game.gameId && decision.eventIndex === eventIndex,
      );
      if (
        matches.length === 1 &&
        matches[0]?.decisionOrdinal !== expectedOrdinal
      ) {
        failures.push(
          `${game.gameId}/${eventIndex.toString()} has a nonchronological user decision ordinal.`,
        );
      }
      expectedOrdinal += 1;
    }
  }

  const latencyIds = new Set<string>();
  for (const latency of run.latencies) {
    if (latencyIds.has(latency.decisionId)) {
      failures.push(`Duplicate latency for ${latency.decisionId}.`);
    }
    latencyIds.add(latency.decisionId);
    const decision = decisionById.get(latency.decisionId);
    if (
      decision === undefined ||
      !sameCoordinate(decision, latency) ||
      decision.decisionOrdinal !== latency.decisionOrdinal ||
      decision.eventIndex !== latency.eventIndex
    ) {
      failures.push(`${latency.decisionId} latency has no matching decision.`);
      continue;
    }
    if (
      (decision.exactOutcome === "not-attempted") !==
        (latency.exactMs === null) ||
      (decision.dispatchOutcome === "fallback") !==
        (latency.fallbackMs !== null)
    ) {
      failures.push(`${latency.decisionId} latency stages are inconsistent.`);
    }
  }
  if (
    latencyIds.size !== decisionIds.size ||
    [...decisionIds].some((decisionId) => !latencyIds.has(decisionId))
  ) {
    failures.push(
      "Every deterministic decision must have one latency sidecar.",
    );
  }

  const regenerated = summarizePhase7Comparison({
    runId: manifest.runId,
    runKind: manifest.runKind,
    ruleProfileId: manifest.ruleProfileId,
    split: manifest.split,
    rules: manifest.rules,
    configurations: manifest.configurations,
    baseIndexStart: manifest.baseIndexStart,
    baseCount: manifest.baseCount,
    bootstrapSeedId: manifest.bootstrapSeedId,
    games: run.games,
    truths: run.truths,
    failures: run.failures,
    decisions: run.decisions,
    latencies: run.latencies,
  });
  if (stableStringify(regenerated) !== stableStringify(run.summary)) {
    failures.push("summary.json does not regenerate from raw records.");
  }
  if (
    renderPhase7ComparisonSummaryMarkdown(regenerated) !== run.summaryMarkdown
  ) {
    failures.push("summary.md does not regenerate from summary.json.");
  }
  const rawHashes = {
    gamesSha256: sha256(ndjson(run.games)),
    truthsSha256: sha256(ndjson(run.truths)),
    failuresSha256: sha256(ndjson(run.failures)),
    decisionsSha256: sha256(ndjson(run.decisions)),
    latenciesSha256: sha256(ndjson(run.latencies)),
  };
  if (
    stableStringify(rawHashes) !== stableStringify(manifest.rawStreamsSha256)
  ) {
    failures.push("Manifest raw stream hashes do not match raw records.");
  }
  if (
    manifest.scientificDigest !== regenerated.scientificDigest ||
    run.summary.scientificDigest !== regenerated.scientificDigest
  ) {
    failures.push("Scientific digest does not match raw scientific records.");
  }
  return failures;
}

export async function buildPhase7ComparisonArtifactRun(
  input: BuildPhase7ComparisonArtifactRunInput,
): Promise<Phase7ComparisonArtifactRun> {
  if (!EVALUATION_SPLITS.includes(input.split)) {
    throw new RangeError(`Unsupported evaluation split ${input.split}.`);
  }
  const records = canonicalizePhase7ComparisonRecords(input);
  const configurations = phase7ComparisonConfigurationSchema
    .array()
    .length(2)
    .parse(input.configurations);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const environment =
    input.environment ?? captureEnvironment(createdAt, "not-recorded");
  const sourceSnapshot =
    input.sourceSnapshot ??
    (await captureSourceSnapshot(resolve(input.projectRoot)));
  const protocolPlanSha256 = sha256(
    await readFile(resolve(input.protocolPlanPath)),
  );
  const rulesHash = stableHash(input.rules);
  const scientificContractSha256 = phase7ComparisonScientificContractSha256({
    sourceSnapshotSha256: sourceSnapshot.sourceSnapshotSha256,
    sourceFileCount: sourceSnapshot.sourceFileCount,
    protocolPlanSha256,
    split: input.split,
    ruleProfileId: input.ruleProfileId,
    rules: input.rules,
    rulesHash,
    configurations,
    styleCellIds: REQUIRED_STYLE_CELL_IDS,
    baseIndexStart: input.baseIndexStart,
    baseCount: input.baseCount,
    rotations: REQUIRED_ROTATIONS,
    replicate: 0,
    eventCap: input.eventCap,
    verifyFallbackParity: input.verifyFallbackParity,
    bootstrapSeedId: input.bootstrapSeedId,
  });
  const summary = summarizePhase7Comparison({
    runId: input.runId,
    runKind: input.runKind,
    ruleProfileId: input.ruleProfileId,
    split: input.split,
    rules: input.rules,
    configurations,
    baseIndexStart: input.baseIndexStart,
    baseCount: input.baseCount,
    bootstrapSeedId: input.bootstrapSeedId,
    ...records,
  });
  const manifest = phase7ComparisonManifestSchema.parse({
    schemaVersion: PHASE7_COMPARISON_ARTIFACT_SCHEMA_VERSION,
    artifactSchemaVersion: PHASE7_COMPARISON_ARTIFACT_SCHEMA_VERSION,
    runnerVersion: PHASE7_COMPARISON_RUNNER_VERSION,
    protocolId: "eval-v1",
    runId: input.runId,
    split: input.split,
    evidenceClass: PHASE7_COMPARISON_EVIDENCE_CLASS,
    evidenceEligible: false,
    runKind: input.runKind,
    reproductionReference:
      input.reproductionReference === undefined
        ? null
        : phase7ComparisonReproductionReferenceSchema.parse(
            input.reproductionReference,
          ),
    createdAt,
    ...sourceSnapshot,
    protocolPlanSha256,
    ruleProfileId: input.ruleProfileId,
    rules: input.rules,
    rulesHash,
    configurations,
    styleCellIds: REQUIRED_STYLE_CELL_IDS,
    baseIndexStart: input.baseIndexStart,
    baseCount: input.baseCount,
    rotations: REQUIRED_ROTATIONS,
    replicate: 0,
    eventCap: input.eventCap,
    verifyFallbackParity: input.verifyFallbackParity,
    seedPolicyId: "phase7-private-environment-public-solver-seeds-v1",
    expectedPairs: input.baseCount * REQUIRED_STYLE_CELL_IDS.length * 3,
    expectedGames: input.baseCount * REQUIRED_STYLE_CELL_IDS.length * 3 * 2,
    bootstrapResamples: PHASE7_COMPARISON_BOOTSTRAP_RESAMPLES,
    bootstrapSeedId: input.bootstrapSeedId,
    clusterDefinition: "baseIndex-keeps-all-17-style-cells-and-3-rotations",
    pairingDefinition:
      "reference-and-candidate-share-style-cell-baseIndex-rotation",
    recordOrder: "baseIndex-style-cell-rotation-config-role-user-decision",
    rawStreamsSha256: {
      gamesSha256: sha256(ndjson(records.games)),
      truthsSha256: sha256(ndjson(records.truths)),
      failuresSha256: sha256(ndjson(records.failures)),
      decisionsSha256: sha256(ndjson(records.decisions)),
      latenciesSha256: sha256(ndjson(records.latencies)),
    },
    scientificProjectionVersion: "phase7-timing-environment-free-projection-v1",
    scientificContractSha256,
    scientificDigest: summary.scientificDigest,
    nondeterministicFields: [
      "manifest.createdAt",
      "environment",
      "games[*].gameWallTimeMs",
      "latencies",
    ],
    command: input.command,
  });
  const run = Object.freeze({
    manifest,
    environment,
    ...records,
    summary,
    summaryMarkdown: renderPhase7ComparisonSummaryMarkdown(summary),
    log:
      input.log ??
      [
        `runner=${PHASE7_COMPARISON_RUNNER_VERSION}`,
        `runId=${input.runId}`,
        `scientificDigest=${summary.scientificDigest}`,
      ].join("\n"),
  });
  const issues = validatePhase7ComparisonArtifactRun(run);
  if (issues.length > 0) {
    const shown = issues.slice(0, 40);
    const omitted = issues.length - shown.length;
    throw new Error(
      `Invalid Phase 7 comparison run (${issues.length.toString()} issue(s)): ${shown.join(
        " ",
      )}${omitted > 0 ? ` … ${omitted.toString()} more.` : ""}`,
    );
  }
  return run;
}

function runPayloads(
  run: Phase7ComparisonArtifactRun,
): Readonly<Record<(typeof PAYLOAD_FILES)[number], string>> {
  return {
    "command.txt": `${run.manifest.command}\n`,
    "decisions.ndjson": ndjson(run.decisions),
    "environment.json": `${stableStringify(run.environment)}\n`,
    "failures.ndjson": ndjson(run.failures),
    "games.ndjson": ndjson(run.games),
    "latencies.ndjson": ndjson(run.latencies),
    "logs/run.log": run.log.endsWith("\n") ? run.log : `${run.log}\n`,
    "manifest.json": `${stableStringify(run.manifest)}\n`,
    "summary.json": `${stableStringify(run.summary)}\n`,
    "summary.md": run.summaryMarkdown.endsWith("\n")
      ? run.summaryMarkdown
      : `${run.summaryMarkdown}\n`,
    "truth.eval-only.ndjson": ndjson(run.truths),
  };
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
}

export async function writePhase7ComparisonArtifacts(
  run: Phase7ComparisonArtifactRun,
  artifactRoot: string,
): Promise<{ readonly runDirectory: string }> {
  const issues = validatePhase7ComparisonArtifactRun(run);
  if (issues.length > 0) {
    throw new Error(
      `Refusing to write invalid Phase 7 comparison run: ${issues.join(" ")}`,
    );
  }
  const parent = resolve(artifactRoot, "eval-v1", run.manifest.split);
  const target = join(parent, run.manifest.runId);
  await mkdir(parent, { recursive: true });
  try {
    await access(target);
    throw new Error(`Phase 7 comparison run already exists: ${target}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Phase 7 comparison run already exists:")
    ) {
      throw error;
    }
  }
  const stage = await mkdtemp(join(parent, `.${run.manifest.runId}.stage-`));
  try {
    const payloads = runPayloads(run);
    await mkdir(join(stage, "logs"));
    for (const fileName of PAYLOAD_FILES) {
      await writeExclusive(join(stage, fileName), payloads[fileName]);
    }
    const checksumLines = await Promise.all(
      PAYLOAD_FILES.map(async (fileName) => {
        const bytes = await readFile(join(stage, fileName));
        return `${sha256(bytes)}  ${fileName}`;
      }),
    );
    await writeExclusive(
      join(stage, "checksums.sha256"),
      `${checksumLines.join("\n")}\n`,
    );
    await rename(stage, target);
    return { runDirectory: target };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function relativeFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await relativeFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

function parseNdjson<T>(
  text: string,
  parser: { readonly parse: (value: unknown) => T },
): T[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => parser.parse(JSON.parse(line) as unknown));
}

export async function verifyPhase7ComparisonArtifacts(
  runDirectoryValue: string,
): Promise<Phase7ComparisonArtifactVerification> {
  const runDirectory = resolve(runDirectoryValue);
  const failures: string[] = [];
  let checkedFiles = 0;
  let gamesReplayed = 0;
  let truthsReplayed = 0;
  let decisionsValidated = 0;
  let latencyRecordsValidated = 0;
  let recordedFailures = 0;
  let scientificDigest: string | null = null;
  let zeroFailureGate: boolean | null = null;
  try {
    const files = await relativeFiles(runDirectory);
    if (stableStringify(files) !== stableStringify(ALL_FILES)) {
      failures.push(`Artifact file set mismatch: ${files.join(", ")}.`);
    }
    const checksumLines = (
      await readFile(join(runDirectory, "checksums.sha256"), "utf8")
    )
      .trim()
      .split(/\r?\n/u);
    const checksums = new Map<string, string>();
    for (const line of checksumLines) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) {
        failures.push(`Malformed checksum line ${JSON.stringify(line)}.`);
      } else if (checksums.has(match[2])) {
        failures.push(`Duplicate checksum entry for ${match[2]}.`);
      } else {
        checksums.set(match[2], match[1]);
      }
    }
    for (const fileName of PAYLOAD_FILES) {
      const actual = sha256(await readFile(join(runDirectory, fileName)));
      if (checksums.get(fileName) !== actual) {
        failures.push(`Checksum mismatch for ${fileName}.`);
      }
      checkedFiles += 1;
    }
    if (checksums.size !== PAYLOAD_FILES.length) {
      failures.push("Checksum manifest does not cover every payload exactly.");
    }
    const manifest = phase7ComparisonManifestSchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "manifest.json"), "utf8"),
      ) as unknown,
    );
    const environment = environmentArtifactSchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "environment.json"), "utf8"),
      ) as unknown,
    );
    const games = parseNdjson(
      await readFile(join(runDirectory, "games.ndjson"), "utf8"),
      phase7ComparisonGameRecordSchema,
    );
    const truths = parseNdjson(
      await readFile(join(runDirectory, "truth.eval-only.ndjson"), "utf8"),
      phase7ComparisonTruthRecordSchema,
    );
    const failureRecords = parseNdjson(
      await readFile(join(runDirectory, "failures.ndjson"), "utf8"),
      phase7ComparisonFailureRecordSchema,
    );
    const decisions = parseNdjson(
      await readFile(join(runDirectory, "decisions.ndjson"), "utf8"),
      phase7ComparisonDecisionRecordSchema,
    );
    const latencies = parseNdjson(
      await readFile(join(runDirectory, "latencies.ndjson"), "utf8"),
      phase7ComparisonLatencyRecordSchema,
    );
    const summary = phase7ComparisonSummarySchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "summary.json"), "utf8"),
      ) as unknown,
    );
    const summaryMarkdown = await readFile(
      join(runDirectory, "summary.md"),
      "utf8",
    );
    const log = await readFile(join(runDirectory, "logs/run.log"), "utf8");
    const command = await readFile(join(runDirectory, "command.txt"), "utf8");
    if (command !== `${manifest.command}\n`) {
      failures.push("command.txt does not regenerate from manifest.command.");
    }
    const structuralIssues = validatePhase7ComparisonArtifactRun({
      manifest,
      environment,
      games,
      truths,
      failures: failureRecords,
      decisions,
      latencies,
      summary,
      summaryMarkdown,
      log,
    });
    failures.push(...structuralIssues);
    if (manifest.runId !== basename(runDirectory)) {
      failures.push("Manifest run ID differs from the run directory name.");
    }
    gamesReplayed = games.length;
    truthsReplayed = truths.length;
    decisionsValidated = decisions.length;
    latencyRecordsValidated = latencies.length;
    recordedFailures = failureRecords.length;
    scientificDigest = summary.scientificDigest;
    zeroFailureGate = summary.zeroFailureGate;
  } catch (error) {
    failures.push(
      `Artifact verification failed: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }
  return {
    valid: failures.length === 0,
    runDirectory,
    checkedFiles,
    gamesReplayed,
    truthsReplayed,
    decisionsValidated,
    latencyRecordsValidated,
    recordedFailures,
    failures,
    scientificDigest,
    zeroFailureGate,
  };
}

type Phase7ComparisonArtifactMetadata = {
  readonly manifest: Phase7ComparisonManifest;
  readonly summary: Phase7ComparisonSummary;
  readonly binding: Phase7ComparisonReproductionAttestation["primary"];
};

async function readPhase7ComparisonArtifactMetadata(
  runDirectoryValue: string,
): Promise<Phase7ComparisonArtifactMetadata> {
  const runDirectory = resolve(runDirectoryValue);
  const manifestBytes = await readFile(join(runDirectory, "manifest.json"));
  const checksumsBytes = await readFile(join(runDirectory, "checksums.sha256"));
  const manifest = phase7ComparisonManifestSchema.parse(
    JSON.parse(manifestBytes.toString("utf8")) as unknown,
  );
  const summary = phase7ComparisonSummarySchema.parse(
    JSON.parse(
      await readFile(join(runDirectory, "summary.json"), "utf8"),
    ) as unknown,
  );
  return {
    manifest,
    summary,
    binding: {
      runId: manifest.runId,
      manifestSha256: sha256(manifestBytes),
      checksumsSha256: sha256(checksumsBytes),
      scientificDigest: summary.scientificDigest,
    },
  };
}

export async function phase7ComparisonReproductionReferenceFor(
  primaryDirectoryValue: string,
): Promise<Phase7ComparisonReproductionReference> {
  const primaryDirectory = resolve(primaryDirectoryValue);
  const verification = await verifyPhase7ComparisonArtifacts(primaryDirectory);
  if (!verification.valid) {
    throw new Error(
      `Primary Phase 7 artifact is invalid: ${verification.failures.join(" ")}`,
    );
  }
  const metadata = await readPhase7ComparisonArtifactMetadata(primaryDirectory);
  const gateFailures = phase7ComparisonIndividualGateFailures(metadata.summary);
  if (
    metadata.manifest.runKind !== "development-primary" ||
    metadata.manifest.reproductionReference !== null ||
    gateFailures.length > 0
  ) {
    throw new Error(
      `Primary Phase 7 artifact is not gate-ready: ${gateFailures.join(", ")}`,
    );
  }
  return phase7ComparisonReproductionReferenceSchema.parse(metadata.binding);
}

function attestationIdFor(input: {
  readonly smoke: Phase7ComparisonReproductionAttestation["smoke"];
  readonly primary: Phase7ComparisonReproductionAttestation["primary"];
  readonly reproduction: Phase7ComparisonReproductionAttestation["reproduction"];
}): string {
  return `phase7-reproduction-${sha256(stableStringify(input)).slice(0, 20)}`;
}

export async function verifyPhase7ComparisonReproduction(input: {
  readonly smokeDirectory: string;
  readonly primaryDirectory: string;
  readonly reproductionDirectory: string;
}): Promise<Phase7ComparisonReproductionVerification> {
  const smokeDirectory = resolve(input.smokeDirectory);
  const primaryDirectory = resolve(input.primaryDirectory);
  const reproductionDirectory = resolve(input.reproductionDirectory);
  const failures: string[] = [];
  let scientificDigest: string | null = null;
  let scientificContractSha256: string | null = null;
  let attestation: Phase7ComparisonReproductionAttestation | null = null;
  let scientificDigestRerunGate = false;
  try {
    if (
      new Set([smokeDirectory, primaryDirectory, reproductionDirectory])
        .size !== 3
    ) {
      failures.push(
        "Smoke, primary, and reproduction directories must be distinct.",
      );
    }
    const [smokeVerification, primaryVerification, reproductionVerification] =
      await Promise.all([
        verifyPhase7ComparisonArtifacts(smokeDirectory),
        verifyPhase7ComparisonArtifacts(primaryDirectory),
        verifyPhase7ComparisonArtifacts(reproductionDirectory),
      ]);
    for (const [label, verification] of [
      ["smoke", smokeVerification],
      ["primary", primaryVerification],
      ["reproduction", reproductionVerification],
    ] as const) {
      if (!verification.valid) {
        failures.push(
          `${label} artifact failed independent verification: ${verification.failures.join(
            " ",
          )}`,
        );
      }
    }
    const [smoke, primary, reproduction] = await Promise.all([
      readPhase7ComparisonArtifactMetadata(smokeDirectory),
      readPhase7ComparisonArtifactMetadata(primaryDirectory),
      readPhase7ComparisonArtifactMetadata(reproductionDirectory),
    ]);
    const runIds = [
      smoke.manifest.runId,
      primary.manifest.runId,
      reproduction.manifest.runId,
    ];
    if (new Set(runIds).size !== runIds.length) {
      failures.push("Smoke, primary, and reproduction run IDs must differ.");
    }
    if (
      smoke.manifest.runKind !== "smoke" ||
      primary.manifest.runKind !== "development-primary" ||
      reproduction.manifest.runKind !== "development-reproduction"
    ) {
      failures.push(
        "Artifact run kinds must be smoke, development-primary, and development-reproduction in order.",
      );
    }
    for (const [label, summary] of [
      ["smoke", smoke.summary],
      ["primary", primary.summary],
      ["reproduction", reproduction.summary],
    ] as const) {
      const gateFailures = phase7ComparisonIndividualGateFailures(summary);
      if (gateFailures.length > 0) {
        failures.push(
          `${label} individual gates failed: ${gateFailures.join(", ")}.`,
        );
      }
    }
    if (
      smoke.summary.expectedGames !== 102 ||
      smoke.summary.completedGames !== 102 ||
      smoke.summary.pairedMacro?.clusterCount !== 1 ||
      primary.summary.expectedGames !== 408 ||
      primary.summary.completedGames !== 408 ||
      primary.summary.pairedMacro?.clusterCount !== 4 ||
      reproduction.summary.expectedGames !== 408 ||
      reproduction.summary.completedGames !== 408 ||
      reproduction.summary.pairedMacro?.clusterCount !== 4
    ) {
      failures.push(
        "Artifacts do not satisfy the preregistered 102/408/408 sample profiles.",
      );
    }
    if (
      smoke.manifest.sourceSnapshotSha256 !==
        primary.manifest.sourceSnapshotSha256 ||
      primary.manifest.sourceSnapshotSha256 !==
        reproduction.manifest.sourceSnapshotSha256 ||
      smoke.manifest.sourceFileCount !== primary.manifest.sourceFileCount ||
      primary.manifest.sourceFileCount !==
        reproduction.manifest.sourceFileCount ||
      smoke.manifest.protocolPlanSha256 !==
        primary.manifest.protocolPlanSha256 ||
      primary.manifest.protocolPlanSha256 !==
        reproduction.manifest.protocolPlanSha256
    ) {
      failures.push(
        "Smoke/development artifacts do not share one frozen source and protocol plan.",
      );
    }
    if (
      primary.manifest.scientificContractSha256 !==
      reproduction.manifest.scientificContractSha256
    ) {
      failures.push("Primary and reproduction scientific contracts differ.");
    }
    const expectedReference = phase7ComparisonReproductionReferenceSchema.parse(
      primary.binding,
    );
    if (
      stableStringify(reproduction.manifest.reproductionReference) !==
      stableStringify(expectedReference)
    ) {
      failures.push(
        "Reproduction artifact does not precommit to the supplied primary artifact.",
      );
    }
    if (primary.manifest.reproductionReference !== null) {
      failures.push(
        "Development primary must not contain a reproduction reference.",
      );
    }
    if (
      Date.parse(smoke.manifest.createdAt) >
        Date.parse(primary.manifest.createdAt) ||
      Date.parse(primary.manifest.createdAt) >
        Date.parse(reproduction.manifest.createdAt)
    ) {
      failures.push(
        "Artifacts were not created in smoke, primary, reproduction order.",
      );
    }
    scientificDigestRerunGate =
      primary.summary.scientificDigest ===
      reproduction.summary.scientificDigest;
    if (!scientificDigestRerunGate) {
      failures.push(
        "Primary and reproduction scientific digests are not byte-identical.",
      );
    }
    scientificDigest = primary.summary.scientificDigest;
    scientificContractSha256 = primary.manifest.scientificContractSha256;
    if (failures.length === 0) {
      const bindings = {
        smoke: smoke.binding,
        primary: primary.binding,
        reproduction: reproduction.binding,
      };
      attestation = phase7ComparisonReproductionAttestationSchema.parse({
        schemaVersion: 1,
        protocolId: "eval-v1",
        runnerVersion: PHASE7_COMPARISON_RUNNER_VERSION,
        attestationId: attestationIdFor(bindings),
        ...bindings,
        scientificContractSha256,
        sourceSnapshotSha256: primary.manifest.sourceSnapshotSha256,
        protocolPlanSha256: primary.manifest.protocolPlanSha256,
        excludedFields: [
          "manifest.createdAt",
          "environment",
          "games[*].gameWallTimeMs",
          "latencies",
        ],
        smokePrerequisiteGate: true,
        primaryIntegrityGate: true,
        reproductionIntegrityGate: true,
        scientificDigestRerunGate: true,
      });
    }
  } catch (error) {
    failures.push(
      `Phase 7 reproduction verification failed: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }
  return {
    valid: failures.length === 0 && attestation !== null,
    smokeDirectory,
    primaryDirectory,
    reproductionDirectory,
    failures,
    scientificDigestRerunGate,
    scientificDigest,
    scientificContractSha256,
    attestation,
  };
}

export async function writePhase7ComparisonReproductionAttestation(input: {
  readonly smokeDirectory: string;
  readonly primaryDirectory: string;
  readonly reproductionDirectory: string;
  readonly artifactRoot: string;
}): Promise<{ readonly attestationDirectory: string }> {
  const verification = await verifyPhase7ComparisonReproduction(input);
  if (!verification.valid || verification.attestation === null) {
    throw new Error(
      `Refusing to attest an invalid Phase 7 reproduction: ${verification.failures.join(
        " ",
      )}`,
    );
  }
  const attestation = verification.attestation;
  const parent = resolve(
    input.artifactRoot,
    "eval-v1",
    "dev",
    "phase7-reproduction-attestations",
  );
  const target = join(parent, attestation.attestationId);
  await mkdir(parent, { recursive: true });
  try {
    await access(target);
    throw new Error(
      `Phase 7 reproduction attestation already exists: ${target}`,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(
        "Phase 7 reproduction attestation already exists:",
      )
    ) {
      throw error;
    }
  }
  const stage = await mkdtemp(
    join(parent, `.${attestation.attestationId}.stage-`),
  );
  try {
    const payload = `${stableStringify(attestation)}\n`;
    await writeExclusive(join(stage, ATTESTATION_PAYLOAD_FILE), payload);
    await writeExclusive(
      join(stage, "checksums.sha256"),
      `${sha256(payload)}  ${ATTESTATION_PAYLOAD_FILE}\n`,
    );
    await rename(stage, target);
    return { attestationDirectory: target };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyPhase7ComparisonReproductionAttestation(input: {
  readonly smokeDirectory: string;
  readonly primaryDirectory: string;
  readonly reproductionDirectory: string;
  readonly attestationDirectory: string;
}): Promise<Phase7ComparisonAttestationVerification> {
  const attestationDirectory = resolve(input.attestationDirectory);
  const failures: string[] = [];
  const reproduction = await verifyPhase7ComparisonReproduction(input);
  try {
    const files = await relativeFiles(attestationDirectory);
    if (stableStringify(files) !== stableStringify(ATTESTATION_FILES)) {
      failures.push(`Attestation file set mismatch: ${files.join(", ")}.`);
    }
    const payload = await readFile(
      join(attestationDirectory, ATTESTATION_PAYLOAD_FILE),
    );
    const checksum = await readFile(
      join(attestationDirectory, "checksums.sha256"),
      "utf8",
    );
    if (checksum !== `${sha256(payload)}  ${ATTESTATION_PAYLOAD_FILE}\n`) {
      failures.push("Attestation checksum does not match its payload.");
    }
    const recorded = phase7ComparisonReproductionAttestationSchema.parse(
      JSON.parse(payload.toString("utf8")) as unknown,
    );
    if (
      recorded.attestationId !== basename(attestationDirectory) ||
      reproduction.attestation === null ||
      stableStringify(recorded) !== stableStringify(reproduction.attestation)
    ) {
      failures.push(
        "Attestation does not regenerate from the three supplied artifacts.",
      );
    }
  } catch (error) {
    failures.push(
      `Attestation verification failed: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }
  failures.push(...reproduction.failures);
  return {
    valid: failures.length === 0 && reproduction.valid,
    attestationDirectory,
    reproduction,
    failures,
  };
}
