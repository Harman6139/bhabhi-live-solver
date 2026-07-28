import { createHash } from "node:crypto";

import type { PolicyObservation } from "../agents/policies";
import { stableHash, stableStringify } from "../events/stable-hash";
import { replayTimeline } from "../events/timeline";
import {
  buildBehaviorBelief,
  type BehaviorBeliefConfigInput,
} from "../inference/behavior-belief";
import {
  parsePhase8ProductionModelArtifact,
  phase8ProductionModelConfig,
  serializePhase8ProductionModelArtifact,
  type Phase8ProductionModelArtifact,
  type Phase8ProductionModelConfig,
} from "../modeling/production-model";
import { parsePhase8HardOnlyModel } from "../modeling/hard-only-model";
import type {
  EvaluationUserTimelinePolicy,
  EvaluationUserTimelinePolicyAction,
  EvaluationUserTimelinePolicyConfig,
  EvaluationUserTimelinePolicyInput,
  ScenarioSolverSeedSet,
} from "../simulator/evaluation-user-policy";
import {
  BEHAVIOR_WEIGHTED_APPROXIMATE_ALGORITHM_VERSION,
  recommendBehaviorAwareApproximateFromTimeline,
  type BehaviorWeightedFailureReason,
  type BehaviorWeightedSelectedDispatch,
} from "../search/behavior-weighted-approximate";
import { exactHypothesesFromWeightedBehavior } from "../search/exact-hypotheses";
import { solveExactEndgame } from "../search/exact-endgame";
import {
  recommendResearchFromTimeline,
  type ResearchSearchDispatchResult,
} from "../search/research-dispatch";
import {
  prepareTimelineRecommendation,
  recommendFromTimeline,
  type TimelineRecommendationRequest,
} from "../search/solver";
import type {
  ExactEndgameIneligibleResult,
  ExactEndgameSolvedResult,
  ExactInformationHypothesisSet,
} from "../search/advanced-types";
import type {
  BaselineRecommendation,
  SolverBudget,
  UserAction,
} from "../search/types";
import { buildWeightedBehaviorHypotheses } from "../search/weighted-hypotheses";
import {
  PHASE7_EXACT_SCREEN_CONFIG,
  PHASE7_FROZEN_CONTINUATION_POLICIES,
  phase7ComparisonConfigurationHash,
} from "./phase7-search-policy";
import {
  PHASE8_CONFIGURATION_ROLE_IDS,
  createPhase8ConfigurationDescriptor,
  phase8ConfigurationDescriptorSchema,
  type Phase8ConfigurationDescriptor,
  type Phase8ConfigurationRoleId,
} from "./phase8-manifest";
import {
  PHASE8_TERMINAL_RUNNER_VERSION,
  type Phase8TerminalComponents,
} from "./phase8-terminal-schema";

export const PHASE8_TERMINAL_REFERENCE_ID = "p8-r-hard-balanced-v1" as const;
export const PHASE8_TERMINAL_EXACT_ID = "p8-e-exact-hard-fallback-v1" as const;
export const PHASE8_TERMINAL_BEHAVIOR_ID = "p8-b-behavior-balanced-v1" as const;
export const PHASE8_TERMINAL_BEHAVIOR_EXACT_ID =
  "p8-be-behavior-exact-fallback-v1" as const;

export const PHASE8_TERMINAL_ROUTING_CONTRACTS = {
  [PHASE8_TERMINAL_REFERENCE_ID]: "direct-phase5-hard-only",
  [PHASE8_TERMINAL_EXACT_ID]: "exact-hard-then-byte-identical-r",
  [PHASE8_TERMINAL_BEHAVIOR_ID]: "behavior-weighted-refuse-on-failure",
  [PHASE8_TERMINAL_BEHAVIOR_EXACT_ID]: "behavior-exact-then-byte-identical-b",
} as const;

export type Phase8TerminalRoutingContract =
  (typeof PHASE8_TERMINAL_ROUTING_CONTRACTS)[Phase8ConfigurationRoleId];

export type Phase8TerminalRuntimeModel = Readonly<{
  serialized: string;
  sha256: string;
  artifact: Phase8ProductionModelArtifact;
  config: Phase8ProductionModelConfig;
}>;

export type Phase8TerminalPreflightEntry = Readonly<{
  configId: Phase8ConfigurationRoleId;
  eligible: boolean;
  reasons: readonly string[];
  descriptor: Phase8ConfigurationDescriptor;
}>;

export type Phase8TerminalPreflight = Readonly<{
  eligible: boolean;
  productionModel: Phase8TerminalRuntimeModel | null;
  entries: readonly Phase8TerminalPreflightEntry[];
}>;

type NormalizedActionEstimate = Readonly<{
  action: UserAction;
  actionKey: string;
  userBhabhiRisk: number;
  interval: Readonly<{
    level: 0.95;
    method: string;
    lower: number;
    upper: number;
  }> | null;
  approximateTie: boolean;
  immediatePickupProbability: number | null;
  expectedImmediatePickupCount: number | null;
  immediatePowerProbability: number | null;
}>;

export type Phase8TerminalExactAudit = Readonly<{
  outcome: "not-attempted" | "used" | "refused";
  algorithmId: string | null;
  configHash: string | null;
  resultHash: string | null;
  hypothesisSetHash: string | null;
  refusalCode: string | null;
  refusalDetail: string | null;
  diagnosticsHash: string | null;
}>;

export type Phase8TerminalBehaviorAudit = Readonly<{
  outcome: "not-attempted" | "used" | "refused";
  algorithmId: string | null;
  modelSha256: string | null;
  behaviorConfigHash: string | null;
  behaviorResultHash: string | null;
  weightedHypothesisHash: string | null;
  refusalCode: string | null;
  refusalDetail: string | null;
  p2PosteriorHash: string | null;
  p3PosteriorHash: string | null;
}>;

export type Phase8TerminalDecisionAudit = Readonly<{
  decisionOrdinal: number;
  eventIndex: number;
  stateVersion: number;
  publicHistoryHash: string;
  publicStateHash: string;
  observationHash: string;
  legalActions: readonly UserAction[];
  legalActionKeys: readonly string[];
  selectedAction: UserAction;
  selectedActionKey: string;
  method:
    "phase5-hard-only" | "exact-hard" | "behavior-weighted" | "exact-behavior";
  quality: "Approximate" | "Exact";
  candidates: readonly NormalizedActionEstimate[];
  exact: Phase8TerminalExactAudit;
  behavior: Phase8TerminalBehaviorAudit;
  fallback: Readonly<{
    used: boolean;
    targetConfigId: Phase8ConfigurationRoleId | null;
    reasonCode: string | null;
    byteIdenticalRequestHash: string | null;
  }>;
  work: Readonly<{
    hardWorldOccurrences: number | null;
    weightedHypotheses: number | null;
    terminalRollouts: number | null;
    effectiveSampleSize: number | null;
    exactInformationStates: number | null;
    exactBranches: number | null;
  }>;
  warnings: readonly string[];
  analysisInputHash: string;
  analysisOutputHash: string;
  totalMs: number;
  exactAttemptMs: number | null;
  behaviorAttemptMs: number | null;
  fallbackMs: number | null;
  deadlineMs: number;
  deadlineExceeded: boolean;
}>;

export type Phase8TerminalPolicyFactoryResult = Readonly<{
  policyConfig: EvaluationUserTimelinePolicyConfig;
  decisions: readonly Phase8TerminalDecisionAudit[];
}>;

export class Phase8TerminalAnalysisError extends Error {
  readonly code: string;
  readonly completionStatus: "failed" | "analysis-cap" | "cancelled";
  readonly stage: "configuration-routing" | "search-analysis";

  constructor(
    code: string,
    message: string,
    input: {
      readonly completionStatus?: "failed" | "analysis-cap" | "cancelled";
      readonly stage?: "configuration-routing" | "search-analysis";
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, { cause: input.cause });
    this.name = "Phase8TerminalAnalysisError";
    this.code = code;
    this.completionStatus = input.completionStatus ?? "failed";
    this.stage = input.stage ?? "search-analysis";
  }
}

const ROLE_COMPONENTS: Readonly<
  Record<Phase8ConfigurationRoleId, Phase8TerminalComponents>
> = Object.freeze({
  [PHASE8_TERMINAL_REFERENCE_ID]: Object.freeze({
    exactEndgame: false,
    behaviorWeighting: false,
  }),
  [PHASE8_TERMINAL_EXACT_ID]: Object.freeze({
    exactEndgame: true,
    behaviorWeighting: false,
  }),
  [PHASE8_TERMINAL_BEHAVIOR_ID]: Object.freeze({
    exactEndgame: false,
    behaviorWeighting: true,
  }),
  [PHASE8_TERMINAL_BEHAVIOR_EXACT_ID]: Object.freeze({
    exactEndgame: true,
    behaviorWeighting: true,
  }),
});

const ROLE_LABELS: Readonly<Record<Phase8ConfigurationRoleId, string>> =
  Object.freeze({
    [PHASE8_TERMINAL_REFERENCE_ID]: "Phase 8 hard-only Balanced reference",
    [PHASE8_TERMINAL_EXACT_ID]: "Phase 8 exact hard then reference fallback",
    [PHASE8_TERMINAL_BEHAVIOR_ID]: "Phase 8 behavior-weighted Balanced",
    [PHASE8_TERMINAL_BEHAVIOR_EXACT_ID]:
      "Phase 8 behavior exact then behavior fallback",
  });

export const PHASE8_TERMINAL_EXACT_CONFIG_HASH = stableHash(
  PHASE7_EXACT_SCREEN_CONFIG,
);
export const PHASE8_TERMINAL_CONTINUATION_POLICY_HASH = stableHash(
  PHASE7_FROZEN_CONTINUATION_POLICIES,
);
export const PHASE8_TERMINAL_PHASE5_REFERENCE_CONFIG_HASH =
  phase7ComparisonConfigurationHash("reference");

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isBehaviorRole(configId: Phase8ConfigurationRoleId): boolean {
  return (
    configId === PHASE8_TERMINAL_BEHAVIOR_ID ||
    configId === PHASE8_TERMINAL_BEHAVIOR_EXACT_ID
  );
}

function isExactRole(configId: Phase8ConfigurationRoleId): boolean {
  return (
    configId === PHASE8_TERMINAL_EXACT_ID ||
    configId === PHASE8_TERMINAL_BEHAVIOR_EXACT_ID
  );
}

function fallbackId(
  configId: Phase8ConfigurationRoleId,
): Phase8ConfigurationRoleId | null {
  if (configId === PHASE8_TERMINAL_EXACT_ID) {
    return PHASE8_TERMINAL_REFERENCE_ID;
  }
  if (configId === PHASE8_TERMINAL_BEHAVIOR_EXACT_ID) {
    return PHASE8_TERMINAL_BEHAVIOR_ID;
  }
  return null;
}

export function parsePhase8TerminalProductionModel(
  serialized: string,
): Phase8TerminalRuntimeModel {
  const artifact = parsePhase8ProductionModelArtifact(serialized);
  const canonical = serializePhase8ProductionModelArtifact(artifact);
  if (canonical !== serialized) {
    throw new Error(
      "Phase 8 production-model bytes are not the canonical serialized artifact.",
    );
  }
  return Object.freeze({
    serialized,
    sha256: sha256Bytes(serialized),
    artifact,
    config: phase8ProductionModelConfig(artifact),
  });
}

function implementationFor(
  configId: Phase8ConfigurationRoleId,
  model: Phase8TerminalRuntimeModel | null,
): Phase8ConfigurationDescriptor["implementation"] {
  if (isBehaviorRole(configId) && model === null) {
    throw new Error(
      `${configId} requires canonical serialized Phase 8 production-model bytes.`,
    );
  }
  return {
    terminalRunnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    routingContract: PHASE8_TERMINAL_ROUTING_CONTRACTS[configId],
    phase5ReferenceConfigHash: PHASE8_TERMINAL_PHASE5_REFERENCE_CONFIG_HASH,
    continuationPolicyHash: PHASE8_TERMINAL_CONTINUATION_POLICY_HASH,
    exactConfigHash: isExactRole(configId)
      ? PHASE8_TERMINAL_EXACT_CONFIG_HASH
      : null,
    fallbackConfigId: fallbackId(configId),
    behaviorFailurePolicy: isBehaviorRole(configId)
      ? "refuse"
      : "not-applicable",
    productionModelSha256: isBehaviorRole(configId)
      ? (model?.sha256 ?? null)
      : null,
    modelSelectionContractHash: isBehaviorRole(configId)
      ? (model?.artifact.payload.modelSelectionContractHash ?? null)
      : null,
    separateOpponentPriors: isBehaviorRole(configId),
    behaviorWorldCount: isBehaviorRole(configId)
      ? (model?.config.worldCount ?? null)
      : null,
    robustChoice: isBehaviorRole(configId)
      ? (model?.config.robustChoice ?? null)
      : null,
  };
}

export function createPhase8TerminalConfigurationDescriptor(input: {
  readonly configId: Phase8ConfigurationRoleId;
  readonly serializedProductionModel?: string;
}): Phase8ConfigurationDescriptor {
  const model =
    input.serializedProductionModel === undefined
      ? null
      : parsePhase8TerminalProductionModel(input.serializedProductionModel);
  return createPhase8ConfigurationDescriptor({
    configId: input.configId,
    label: ROLE_LABELS[input.configId],
    role:
      input.configId === PHASE8_TERMINAL_REFERENCE_ID
        ? "reference"
        : "candidate",
    budgetId: "balanced",
    components: ROLE_COMPONENTS[input.configId],
    implementation: implementationFor(input.configId, model),
  });
}

function loadRuntimeModel(
  serializedProductionModel: string,
  manifestModelSha256: string,
): {
  readonly model: Phase8TerminalRuntimeModel | null;
  readonly reasons: readonly string[];
} {
  try {
    const model = parsePhase8TerminalProductionModel(serializedProductionModel);
    if (model.sha256 !== manifestModelSha256) {
      return {
        model: null,
        reasons: [
          "SHA-256 of exact canonical production-model bytes does not match manifest.hashes.modelSha256.",
        ],
      };
    }
    return { model, reasons: [] };
  } catch (cause) {
    return {
      model: null,
      reasons: [
        `Production-model parse/verification failed: ${
          cause instanceof Error ? cause.message : "unknown failure"
        }`,
      ],
    };
  }
}

function loadNonBehaviorModel(
  serialized: string,
  manifestModelSha256: string,
): {
  readonly model: Phase8TerminalRuntimeModel | null;
  readonly reasons: readonly string[];
} {
  if (sha256Bytes(serialized) !== manifestModelSha256) {
    return {
      model: null,
      reasons: [
        "SHA-256 of exact nonbehavior model bytes does not match manifest.hashes.modelSha256.",
      ],
    };
  }
  try {
    parsePhase8HardOnlyModel(serialized);
    return { model: null, reasons: [] };
  } catch {
    try {
      return {
        model: parsePhase8TerminalProductionModel(serialized),
        reasons: [],
      };
    } catch (cause) {
      return {
        model: null,
        reasons: [
          `Nonbehavior model verification failed: ${
            cause instanceof Error ? cause.message : "unknown failure"
          }`,
        ],
      };
    }
  }
}

export function preflightPhase8TerminalConfigurations(input: {
  readonly configurations: readonly Phase8ConfigurationDescriptor[];
  readonly manifestModelSha256: string;
  readonly serializedProductionModel: string;
}): Phase8TerminalPreflight {
  const descriptors = input.configurations.map((configuration) =>
    phase8ConfigurationDescriptorSchema.parse(configuration),
  );
  const modelLoad = descriptors.some((descriptor) =>
    isBehaviorRole(descriptor.configId),
  )
    ? loadRuntimeModel(
        input.serializedProductionModel,
        input.manifestModelSha256,
      )
    : loadNonBehaviorModel(
        input.serializedProductionModel,
        input.manifestModelSha256,
      );
  const referenceCount = descriptors.filter(
    (descriptor) => descriptor.configId === PHASE8_TERMINAL_REFERENCE_ID,
  ).length;
  const seen = new Set<string>();
  const entries = descriptors.map((descriptor) => {
    const reasons = [...modelLoad.reasons];
    if (referenceCount !== 1) {
      reasons.push("A matrix requires exactly one R arm.");
    }
    if (seen.has(descriptor.configId)) {
      reasons.push(`Duplicate configuration ID ${descriptor.configId}.`);
    }
    seen.add(descriptor.configId);
    let expected: Phase8ConfigurationDescriptor | null = null;
    try {
      expected = createPhase8TerminalConfigurationDescriptor({
        configId: descriptor.configId,
        ...(isBehaviorRole(descriptor.configId) && modelLoad.model !== null
          ? {
              serializedProductionModel: modelLoad.model.serialized,
            }
          : {}),
      });
    } catch (cause) {
      reasons.push(
        `Runtime descriptor construction failed: ${
          cause instanceof Error ? cause.message : "unknown failure"
        }`,
      );
    }
    if (
      expected !== null &&
      stableStringify(descriptor) !== stableStringify(expected)
    ) {
      reasons.push(
        "Manifest descriptor does not match the executable Phase 8 routing contract.",
      );
    }
    if (
      isBehaviorRole(descriptor.configId) &&
      modelLoad.model?.config.robustChoice === true
    ) {
      reasons.push(
        "The selected robust-choice option is on, but no robust-choice decision rule is implemented; label-only execution is forbidden.",
      );
    }
    return Object.freeze({
      configId: descriptor.configId,
      eligible: reasons.length === 0,
      reasons: Object.freeze(reasons),
      descriptor,
    });
  });
  const frozenEntries = Object.freeze(entries);
  return Object.freeze({
    eligible:
      frozenEntries.length > 0 &&
      frozenEntries.every((entry) => entry.eligible),
    productionModel: modelLoad.model,
    entries: frozenEntries,
  });
}

function actionKey(action: UserAction): string {
  return action.kind === "play-card"
    ? `play:${action.card}`
    : `take:${action.target}`;
}

function policyAction(
  action: UserAction,
  rationale: string,
): EvaluationUserTimelinePolicyAction {
  return action.kind === "play-card"
    ? {
        kind: "play-card",
        card: action.card,
        rationale,
      }
    : {
        kind: "take-hand",
        target: action.target,
        rationale,
      };
}

function assertVisibleLegalAction(
  action: UserAction,
  observation: PolicyObservation,
): void {
  if (action.kind === "play-card") {
    if (!observation.legalCards.includes(action.card)) {
      throw new Phase8TerminalAnalysisError(
        "ILLEGAL_POLICY_ACTION",
        `Terminal solver selected illegal card ${action.card}.`,
      );
    }
    return;
  }
  if (!(observation.legalTakeTargets ?? []).includes(action.target)) {
    throw new Phase8TerminalAnalysisError(
      "ILLEGAL_POLICY_ACTION",
      `Terminal solver selected illegal take target ${action.target}.`,
    );
  }
}

function commonRequest(
  input: EvaluationUserTimelinePolicyInput,
  model: Phase8TerminalRuntimeModel | null,
  behavior: boolean,
): TimelineRecommendationRequest {
  if (behavior && model === null) {
    throw new Phase8TerminalAnalysisError(
      "MISSING_PRODUCTION_MODEL",
      "A behavioral route requires a verified production model.",
      { stage: "configuration-routing" },
    );
  }
  return {
    timeline: input.timeline,
    budgetId: "balanced",
    ...(behavior
      ? {
          budgetOverrides: {
            worldSamples: model?.config.worldCount ?? 1,
          },
        }
      : {}),
    policies: PHASE7_FROZEN_CONTINUATION_POLICIES,
    seeds: input.solverSeeds,
  };
}

function requireBehaviorModel(
  model: Phase8TerminalRuntimeModel | null,
  configId: Phase8ConfigurationRoleId,
): Phase8TerminalRuntimeModel {
  if (model === null) {
    throw new Phase8TerminalAnalysisError(
      "MISSING_PRODUCTION_MODEL",
      `${configId} requires a verified production model.`,
      { stage: "configuration-routing" },
    );
  }
  return model;
}

function requestHash(input: {
  readonly request: TimelineRecommendationRequest;
  readonly observation: PolicyObservation;
  readonly configId: Phase8ConfigurationRoleId;
}): string {
  const replay = replayTimeline(input.request.timeline);
  return stableHash({
    schemaVersion: 1,
    configId: input.configId,
    historyHash: replay.semanticHash,
    stateVersion: input.request.timeline.cursor,
    observationHash: stableHash(input.observation),
    budgetId: input.request.budgetId,
    budgetOverrides: input.request.budgetOverrides ?? null,
    policies: input.request.policies ?? null,
    seeds: input.request.seeds ?? null,
  });
}

const NOT_ATTEMPTED_EXACT: Phase8TerminalExactAudit = Object.freeze({
  outcome: "not-attempted",
  algorithmId: null,
  configHash: null,
  resultHash: null,
  hypothesisSetHash: null,
  refusalCode: null,
  refusalDetail: null,
  diagnosticsHash: null,
});

const NOT_ATTEMPTED_BEHAVIOR: Phase8TerminalBehaviorAudit = Object.freeze({
  outcome: "not-attempted",
  algorithmId: null,
  modelSha256: null,
  behaviorConfigHash: null,
  behaviorResultHash: null,
  weightedHypothesisHash: null,
  refusalCode: null,
  refusalDetail: null,
  p2PosteriorHash: null,
  p3PosteriorHash: null,
});

function exactAudit(
  result: ExactEndgameSolvedResult | ExactEndgameIneligibleResult,
): Phase8TerminalExactAudit {
  return result.quality === "Exact"
    ? {
        outcome: "used",
        algorithmId: result.algorithmVersion,
        configHash: result.configHash,
        resultHash: result.resultHash,
        hypothesisSetHash: result.hypothesisSetChecksum,
        refusalCode: null,
        refusalDetail: null,
        diagnosticsHash: stableHash(result.diagnostics),
      }
    : {
        outcome: "refused",
        algorithmId: result.algorithmVersion,
        configHash: result.configHash,
        resultHash: result.resultHash,
        hypothesisSetHash: result.hypothesisSetChecksum,
        refusalCode: result.eligibility.code,
        refusalDetail: result.eligibility.detail,
        diagnosticsHash: stableHash(result.diagnostics),
      };
}

function behaviorAuditFromSelected(
  result: BehaviorWeightedSelectedDispatch,
  model: Phase8TerminalRuntimeModel,
): Phase8TerminalBehaviorAudit {
  return {
    outcome: "used",
    algorithmId: BEHAVIOR_WEIGHTED_APPROXIMATE_ALGORITHM_VERSION,
    modelSha256: model.sha256,
    behaviorConfigHash: result.recommendation.payload.belief.behaviorConfigHash,
    behaviorResultHash: result.recommendation.payload.belief.behaviorResultHash,
    weightedHypothesisHash:
      result.recommendation.payload.belief.weightedHypothesisChecksum,
    refusalCode: null,
    refusalDetail: null,
    p2PosteriorHash: stableHash(
      result.recommendation.payload.belief.opponentModelMass.p2,
    ),
    p3PosteriorHash: stableHash(
      result.recommendation.payload.belief.opponentModelMass.p3,
    ),
  };
}

function behaviorAuditFromBelief(input: {
  readonly model: Phase8TerminalRuntimeModel;
  readonly configHash: string;
  readonly resultHash: string;
  readonly hypothesisSetHash: string;
  readonly p2Posterior: unknown;
  readonly p3Posterior: unknown;
}): Phase8TerminalBehaviorAudit {
  return {
    outcome: "used",
    algorithmId: BEHAVIOR_WEIGHTED_APPROXIMATE_ALGORITHM_VERSION,
    modelSha256: input.model.sha256,
    behaviorConfigHash: input.configHash,
    behaviorResultHash: input.resultHash,
    weightedHypothesisHash: input.hypothesisSetHash,
    refusalCode: null,
    refusalDetail: null,
    p2PosteriorHash: stableHash(input.p2Posterior),
    p3PosteriorHash: stableHash(input.p3Posterior),
  };
}

function baselineCandidates(
  recommendation: BaselineRecommendation,
): readonly NormalizedActionEstimate[] {
  return recommendation.payload.candidates.map((candidate) => ({
    action: candidate.action,
    actionKey: candidate.actionKey,
    userBhabhiRisk: candidate.bhabhiProbability,
    interval: {
      level: 0.95,
      method: candidate.interval.method,
      lower: candidate.interval.lower,
      upper: candidate.interval.upper,
    },
    approximateTie: candidate.approximateTie,
    immediatePickupProbability: candidate.immediatePickupProbability,
    expectedImmediatePickupCount: candidate.expectedImmediatePickupCount,
    immediatePowerProbability: candidate.immediatePowerProbability,
  }));
}

function behaviorCandidates(
  result: BehaviorWeightedSelectedDispatch,
): readonly NormalizedActionEstimate[] {
  return result.recommendation.payload.candidates.map((candidate) => ({
    action: candidate.action,
    actionKey: candidate.actionKey,
    userBhabhiRisk: candidate.bhabhiProbability,
    interval: {
      level: 0.95,
      method: candidate.interval.method,
      lower: candidate.interval.lower,
      upper: candidate.interval.upper,
    },
    approximateTie: candidate.approximateTie,
    immediatePickupProbability: candidate.immediatePickupProbability,
    expectedImmediatePickupCount: candidate.expectedImmediatePickupCount,
    immediatePowerProbability: candidate.immediatePowerProbability,
  }));
}

function exactCandidates(
  result: ExactEndgameSolvedResult,
): readonly NormalizedActionEstimate[] {
  return result.actionValues.map((candidate) => ({
    action: candidate.action,
    actionKey: candidate.actionKey,
    userBhabhiRisk: candidate.userBhabhiRisk,
    interval: null,
    approximateTie: result.tiedBestActionKeys.includes(candidate.actionKey),
    immediatePickupProbability:
      candidate.positionalDiagnostics.immediatePickupProbability,
    expectedImmediatePickupCount:
      candidate.positionalDiagnostics.expectedImmediatePickupCount,
    immediatePowerProbability:
      candidate.positionalDiagnostics.immediatePowerProbability,
  }));
}

function behaviorFailure(error: BehaviorWeightedFailureReason): never {
  throw new Phase8TerminalAnalysisError(error.code, error.detail, {
    completionStatus:
      error.code === "CANCELLED"
        ? "cancelled"
        : error.code === "ROLLOUT_EVENT_CAP"
          ? "analysis-cap"
          : "failed",
  });
}

function requireSelectedBehavior(
  value: ReturnType<typeof recommendBehaviorAwareApproximateFromTimeline>,
): BehaviorWeightedSelectedDispatch {
  if (
    "behaviorEnabled" in value &&
    value.selectedMethod === "behavior-weighted-approximate"
  ) {
    return value;
  }
  if ("fallbackReason" in value) {
    return behaviorFailure(value.fallbackReason);
  }
  throw new Phase8TerminalAnalysisError(
    "INVALID_BEHAVIOR_ROUTE",
    "Behavior role did not return the required behavior-weighted result.",
  );
}

function baseAudit(input: {
  readonly policyInput: EvaluationUserTimelinePolicyInput;
  readonly configId: Phase8ConfigurationRoleId;
  readonly request: TimelineRecommendationRequest;
  readonly selectedAction: UserAction;
  readonly method: Phase8TerminalDecisionAudit["method"];
  readonly quality: Phase8TerminalDecisionAudit["quality"];
  readonly candidates: readonly NormalizedActionEstimate[];
  readonly exact: Phase8TerminalExactAudit;
  readonly behavior: Phase8TerminalBehaviorAudit;
  readonly fallback: Phase8TerminalDecisionAudit["fallback"];
  readonly work: Phase8TerminalDecisionAudit["work"];
  readonly warnings: readonly string[];
  readonly analysisOutput: unknown;
  readonly totalMs: number;
  readonly exactAttemptMs: number | null;
  readonly behaviorAttemptMs: number | null;
  readonly fallbackMs: number | null;
  readonly deadlineMs: number;
  readonly deadlineExceeded: boolean;
}): Phase8TerminalDecisionAudit {
  const legalActions: UserAction[] = [
    ...input.policyInput.observation.legalCards.map((card) => ({
      kind: "play-card" as const,
      card,
    })),
    ...(input.policyInput.observation.legalTakeTargets ?? []).map((target) => ({
      kind: "take-hand" as const,
      target: target as "p2" | "p3",
    })),
  ];
  const selectedActionKey = actionKey(input.selectedAction);
  const outputHash = stableHash(input.analysisOutput);
  const publicReplay = replayTimeline(input.policyInput.timeline);
  return Object.freeze({
    decisionOrdinal: input.policyInput.observation.decisionOrdinal,
    eventIndex: input.policyInput.timeline.cursor,
    stateVersion: input.policyInput.timeline.cursor,
    publicHistoryHash: publicReplay.semanticHash,
    publicStateHash: stableHash(publicReplay.state),
    observationHash: stableHash(input.policyInput.observation),
    legalActions,
    legalActionKeys: legalActions.map(actionKey),
    selectedAction: input.selectedAction,
    selectedActionKey,
    method: input.method,
    quality: input.quality,
    candidates: input.candidates,
    exact: input.exact,
    behavior: input.behavior,
    fallback: input.fallback,
    work: input.work,
    warnings: input.warnings,
    analysisInputHash: requestHash({
      request: input.request,
      observation: input.policyInput.observation,
      configId: input.configId,
    }),
    analysisOutputHash: outputHash,
    totalMs: input.totalMs,
    exactAttemptMs: input.exactAttemptMs,
    behaviorAttemptMs: input.behaviorAttemptMs,
    fallbackMs: input.fallbackMs,
    deadlineMs: input.deadlineMs,
    deadlineExceeded: input.deadlineExceeded,
  });
}

function runReference(input: {
  readonly policyInput: EvaluationUserTimelinePolicyInput;
  readonly model: Phase8TerminalRuntimeModel | null;
}): Phase8TerminalDecisionAudit {
  const request = commonRequest(input.policyInput, input.model, false);
  const startedAt = globalThis.performance.now();
  const recommendation = recommendFromTimeline(request);
  const totalMs = globalThis.performance.now() - startedAt;
  return baseAudit({
    policyInput: input.policyInput,
    configId: PHASE8_TERMINAL_REFERENCE_ID,
    request,
    selectedAction: recommendation.payload.recommendedAction,
    method: "phase5-hard-only",
    quality: "Approximate",
    candidates: baselineCandidates(recommendation),
    exact: NOT_ATTEMPTED_EXACT,
    behavior: NOT_ATTEMPTED_BEHAVIOR,
    fallback: {
      used: false,
      targetConfigId: null,
      reasonCode: null,
      byteIdenticalRequestHash: null,
    },
    work: {
      hardWorldOccurrences:
        recommendation.payload.belief.materializedWorldOccurrences,
      weightedHypotheses: null,
      terminalRollouts: recommendation.payload.rollout.completed,
      effectiveSampleSize: null,
      exactInformationStates: null,
      exactBranches: null,
    },
    warnings: recommendation.payload.warnings,
    analysisOutput: recommendation.payload,
    totalMs,
    exactAttemptMs: null,
    behaviorAttemptMs: null,
    fallbackMs: null,
    deadlineMs: recommendation.telemetry.deadlineMs,
    deadlineExceeded: recommendation.telemetry.deadlineExceeded,
  });
}

function researchExactResult(
  result: ResearchSearchDispatchResult,
): ExactEndgameSolvedResult | ExactEndgameIneligibleResult {
  if (result.exactAttempt === null) {
    throw new Phase8TerminalAnalysisError(
      "MISSING_EXACT_ATTEMPT",
      "Exact-enabled role returned no exact attempt.",
    );
  }
  return result.exactAttempt;
}

function runExactHard(input: {
  readonly policyInput: EvaluationUserTimelinePolicyInput;
  readonly model: Phase8TerminalRuntimeModel | null;
}): Phase8TerminalDecisionAudit {
  const request = commonRequest(input.policyInput, input.model, false);
  const startedAt = globalThis.performance.now();
  const result = recommendResearchFromTimeline({
    ...request,
    exactMode: "try",
    beliefMode: {
      kind: "hard-only",
      p2ModelId: "documented-basic",
      p3ModelId: "documented-basic",
    },
    advancedConfig: PHASE7_EXACT_SCREEN_CONFIG,
  });
  const totalMs = globalThis.performance.now() - startedAt;
  const exact = researchExactResult(result);
  if (result.quality === "Exact") {
    return baseAudit({
      policyInput: input.policyInput,
      configId: PHASE8_TERMINAL_EXACT_ID,
      request,
      selectedAction: result.recommendation.recommendedAction,
      method: "exact-hard",
      quality: "Exact",
      candidates: exactCandidates(result.recommendation),
      exact: exactAudit(exact),
      behavior: NOT_ATTEMPTED_BEHAVIOR,
      fallback: {
        used: false,
        targetConfigId: null,
        reasonCode: null,
        byteIdenticalRequestHash: null,
      },
      work: {
        hardWorldOccurrences: exact.diagnostics.initialHypotheses,
        weightedHypotheses: null,
        terminalRollouts: null,
        effectiveSampleSize: null,
        exactInformationStates: exact.diagnostics.informationStates,
        exactBranches: exact.diagnostics.branches,
      },
      warnings: exact.warnings,
      analysisOutput: exact,
      totalMs,
      exactAttemptMs: result.telemetry.exactAttemptElapsedMs,
      behaviorAttemptMs: null,
      fallbackMs: null,
      deadlineMs: PHASE7_EXACT_SCREEN_CONFIG.deadlineMs,
      deadlineExceeded: false,
    });
  }
  const fallback = result.approximateFallback;
  return baseAudit({
    policyInput: input.policyInput,
    configId: PHASE8_TERMINAL_EXACT_ID,
    request,
    selectedAction: fallback.payload.recommendedAction,
    method: "exact-hard",
    quality: "Approximate",
    candidates: baselineCandidates(fallback),
    exact: exactAudit(exact),
    behavior: NOT_ATTEMPTED_BEHAVIOR,
    fallback: {
      used: true,
      targetConfigId: PHASE8_TERMINAL_REFERENCE_ID,
      reasonCode: result.fallbackReason.code,
      byteIdenticalRequestHash: requestHash({
        request,
        observation: input.policyInput.observation,
        configId: PHASE8_TERMINAL_REFERENCE_ID,
      }),
    },
    work: {
      hardWorldOccurrences:
        fallback.payload.belief.materializedWorldOccurrences,
      weightedHypotheses: null,
      terminalRollouts: fallback.payload.rollout.completed,
      effectiveSampleSize: null,
      exactInformationStates: exact.diagnostics.informationStates,
      exactBranches: exact.diagnostics.branches,
    },
    warnings: [...exact.warnings, ...fallback.payload.warnings],
    analysisOutput: {
      exact,
      fallback: fallback.payload,
    },
    totalMs,
    exactAttemptMs: result.telemetry.exactAttemptElapsedMs,
    behaviorAttemptMs: null,
    fallbackMs: result.telemetry.approximateFallbackElapsedMs,
    deadlineMs: fallback.telemetry.deadlineMs,
    deadlineExceeded: fallback.telemetry.deadlineExceeded,
  });
}

function runBehavior(input: {
  readonly policyInput: EvaluationUserTimelinePolicyInput;
  readonly model: Phase8TerminalRuntimeModel;
  readonly configId:
    | typeof PHASE8_TERMINAL_BEHAVIOR_ID
    | typeof PHASE8_TERMINAL_BEHAVIOR_EXACT_ID;
}): {
  readonly request: TimelineRecommendationRequest;
  readonly result: BehaviorWeightedSelectedDispatch;
  readonly elapsedMs: number;
  readonly audit: Phase8TerminalDecisionAudit;
} {
  const request = commonRequest(input.policyInput, input.model, true);
  const startedAt = globalThis.performance.now();
  const result = requireSelectedBehavior(
    recommendBehaviorAwareApproximateFromTimeline({
      ...request,
      behavior: {
        enabled: true,
        behaviorConfig: input.model.config.behavior,
        onFailure: "refuse",
      },
    }),
  );
  const elapsedMs = globalThis.performance.now() - startedAt;
  const recommendation = result.recommendation;
  const audit = baseAudit({
    policyInput: input.policyInput,
    configId: input.configId,
    request,
    selectedAction: recommendation.payload.recommendedAction,
    method: "behavior-weighted",
    quality: "Approximate",
    candidates: behaviorCandidates(result),
    exact: NOT_ATTEMPTED_EXACT,
    behavior: behaviorAuditFromSelected(result, input.model),
    fallback: {
      used: false,
      targetConfigId: null,
      reasonCode: null,
      byteIdenticalRequestHash: null,
    },
    work: {
      hardWorldOccurrences: recommendation.payload.belief.worldOccurrences,
      weightedHypotheses: recommendation.payload.belief.jointHypotheses,
      terminalRollouts: recommendation.payload.rollout.completed,
      effectiveSampleSize:
        recommendation.payload.belief.effectiveSampleSize.terminalRollout,
      exactInformationStates: null,
      exactBranches: null,
    },
    warnings: recommendation.payload.warnings,
    analysisOutput: {
      resultHash: result.resultHash,
      payload: recommendation.payload,
    },
    totalMs: elapsedMs,
    exactAttemptMs: null,
    behaviorAttemptMs: elapsedMs,
    fallbackMs: null,
    deadlineMs: recommendation.telemetry.deadlineMs,
    deadlineExceeded: recommendation.telemetry.deadlineExceeded,
  });
  return { request, result, elapsedMs, audit };
}

function prepareBehaviorExact(input: {
  readonly policyInput: EvaluationUserTimelinePolicyInput;
  readonly model: Phase8TerminalRuntimeModel;
}): {
  readonly request: TimelineRecommendationRequest;
  readonly exact: ExactEndgameSolvedResult | ExactEndgameIneligibleResult;
  readonly exactElapsedMs: number;
  readonly behavior: Phase8TerminalBehaviorAudit;
  readonly hypothesisSet: ExactInformationHypothesisSet;
} {
  const request = commonRequest(input.policyInput, input.model, true);
  const prepared = prepareTimelineRecommendation(request);
  const behaviorBelief = buildBehaviorBelief(
    input.policyInput.timeline,
    prepared.hardBelief,
    input.model.config.behavior,
  );
  const weighted = buildWeightedBehaviorHypotheses({
    hardBelief: prepared.hardBelief,
    behaviorBelief,
  });
  const hypothesisSet = exactHypothesesFromWeightedBehavior({
    set: weighted,
    hardBelief: prepared.hardBelief,
    behaviorBelief,
  });
  const activeEvents = prepared.analysisRequest.activeEvents;
  if (activeEvents === undefined) {
    throw new Phase8TerminalAnalysisError(
      "MISSING_ACTIVE_EVENTS",
      "Prepared behavior-exact request omitted its active event ledger.",
    );
  }
  const startedAt = globalThis.performance.now();
  const exact = solveExactEndgame({
    publicState: prepared.analysisRequest.publicState,
    historyHash: prepared.analysisRequest.historyHash,
    hypothesisSet,
    activeEvents,
    config: PHASE7_EXACT_SCREEN_CONFIG,
    behaviorConfig: behaviorBelief.config,
    behaviorBeliefConfigHash: behaviorBelief.configHash,
    opponentPolicyMode: "behavior-distribution",
    ...(prepared.analysisRequest.shouldCancel === undefined
      ? {}
      : { shouldCancel: prepared.analysisRequest.shouldCancel }),
  });
  const exactElapsedMs = globalThis.performance.now() - startedAt;
  return {
    request,
    exact,
    exactElapsedMs,
    behavior: behaviorAuditFromBelief({
      model: input.model,
      configHash: behaviorBelief.configHash,
      resultHash: behaviorBelief.resultHash,
      hypothesisSetHash: weighted.checksum,
      p2Posterior: behaviorBelief.opponentPosteriors.p2,
      p3Posterior: behaviorBelief.opponentPosteriors.p3,
    }),
    hypothesisSet,
  };
}

function runBehaviorExact(input: {
  readonly policyInput: EvaluationUserTimelinePolicyInput;
  readonly model: Phase8TerminalRuntimeModel;
}): Phase8TerminalDecisionAudit {
  const startedAt = globalThis.performance.now();
  const prepared = prepareBehaviorExact(input);
  if (prepared.exact.quality === "Exact") {
    const totalMs = globalThis.performance.now() - startedAt;
    return baseAudit({
      policyInput: input.policyInput,
      configId: PHASE8_TERMINAL_BEHAVIOR_EXACT_ID,
      request: prepared.request,
      selectedAction: prepared.exact.recommendedAction,
      method: "exact-behavior",
      quality: "Exact",
      candidates: exactCandidates(prepared.exact),
      exact: exactAudit(prepared.exact),
      behavior: prepared.behavior,
      fallback: {
        used: false,
        targetConfigId: null,
        reasonCode: null,
        byteIdenticalRequestHash: null,
      },
      work: {
        hardWorldOccurrences: prepared.hypothesisSet.distinctWitnesses,
        weightedHypotheses: prepared.hypothesisSet.totalHypotheses,
        terminalRollouts: null,
        effectiveSampleSize: null,
        exactInformationStates: prepared.exact.diagnostics.informationStates,
        exactBranches: prepared.exact.diagnostics.branches,
      },
      warnings: prepared.exact.warnings,
      analysisOutput: prepared.exact,
      totalMs,
      exactAttemptMs: prepared.exactElapsedMs,
      behaviorAttemptMs: Math.max(0, totalMs - prepared.exactElapsedMs),
      fallbackMs: null,
      deadlineMs: PHASE7_EXACT_SCREEN_CONFIG.deadlineMs,
      deadlineExceeded: false,
    });
  }

  const behaviorFallback = runBehavior({
    policyInput: input.policyInput,
    model: input.model,
    configId: PHASE8_TERMINAL_BEHAVIOR_EXACT_ID,
  });
  const totalMs = globalThis.performance.now() - startedAt;
  const fallbackAudit = behaviorFallback.audit;
  return Object.freeze({
    ...fallbackAudit,
    method: "exact-behavior",
    exact: exactAudit(prepared.exact),
    fallback: {
      used: true,
      targetConfigId: PHASE8_TERMINAL_BEHAVIOR_ID,
      reasonCode: prepared.exact.eligibility.code,
      byteIdenticalRequestHash: requestHash({
        request: behaviorFallback.request,
        observation: input.policyInput.observation,
        configId: PHASE8_TERMINAL_BEHAVIOR_ID,
      }),
    },
    work: {
      ...fallbackAudit.work,
      exactInformationStates: prepared.exact.diagnostics.informationStates,
      exactBranches: prepared.exact.diagnostics.branches,
    },
    warnings: [...prepared.exact.warnings, ...fallbackAudit.warnings],
    analysisOutputHash: stableHash({
      exact: prepared.exact,
      behaviorFallback: behaviorFallback.result.resultHash,
    }),
    totalMs,
    exactAttemptMs: prepared.exactElapsedMs,
    behaviorAttemptMs: Math.max(
      0,
      totalMs - prepared.exactElapsedMs - behaviorFallback.elapsedMs,
    ),
    fallbackMs: behaviorFallback.elapsedMs,
    deadlineExceeded: fallbackAudit.deadlineExceeded,
  });
}

function runDecision(input: {
  readonly configId: Phase8ConfigurationRoleId;
  readonly policyInput: EvaluationUserTimelinePolicyInput;
  readonly model: Phase8TerminalRuntimeModel | null;
}): Phase8TerminalDecisionAudit {
  switch (input.configId) {
    case PHASE8_TERMINAL_REFERENCE_ID:
      return runReference(input);
    case PHASE8_TERMINAL_EXACT_ID:
      return runExactHard(input);
    case PHASE8_TERMINAL_BEHAVIOR_ID:
      return runBehavior({
        ...input,
        model: requireBehaviorModel(input.model, input.configId),
        configId: PHASE8_TERMINAL_BEHAVIOR_ID,
      }).audit;
    case PHASE8_TERMINAL_BEHAVIOR_EXACT_ID:
      return runBehaviorExact({
        ...input,
        model: requireBehaviorModel(input.model, input.configId),
      });
    default: {
      const exhaustive: never = input.configId;
      throw new Phase8TerminalAnalysisError(
        "UNKNOWN_CONFIGURATION",
        `Unknown Phase 8 terminal role ${String(exhaustive)}.`,
        { stage: "configuration-routing" },
      );
    }
  }
}

export function createPhase8TerminalSearchPolicy(input: {
  readonly descriptor: Phase8ConfigurationDescriptor;
  readonly model: Phase8TerminalRuntimeModel | null;
  readonly solverSeeds: ScenarioSolverSeedSet;
}): Phase8TerminalPolicyFactoryResult {
  const descriptor = phase8ConfigurationDescriptorSchema.parse(
    input.descriptor,
  );
  const expected = createPhase8TerminalConfigurationDescriptor({
    configId: descriptor.configId,
    ...(isBehaviorRole(descriptor.configId)
      ? {
          serializedProductionModel: requireBehaviorModel(
            input.model,
            descriptor.configId,
          ).serialized,
        }
      : {}),
  });
  if (stableStringify(descriptor) !== stableStringify(expected)) {
    throw new Phase8TerminalAnalysisError(
      "CONFIGURATION_ROUTING_MISMATCH",
      `${descriptor.configId} does not bind its executable routing contract.`,
      { stage: "configuration-routing" },
    );
  }
  if (
    isBehaviorRole(descriptor.configId) &&
    requireBehaviorModel(input.model, descriptor.configId).config.robustChoice
  ) {
    throw new Phase8TerminalAnalysisError(
      "ROBUST_CHOICE_UNIMPLEMENTED",
      "Selected robust-choice is enabled but has no executable decision route.",
      { stage: "configuration-routing" },
    );
  }

  const decisions: Phase8TerminalDecisionAudit[] = [];
  const policyConfig: EvaluationUserTimelinePolicyConfig = {
    solverSeeds: { ...input.solverSeeds },
    createPolicy: (): EvaluationUserTimelinePolicy => ({
      id: descriptor.configId,
      version: 1,
      chooseAction: (
        policyInput: EvaluationUserTimelinePolicyInput,
      ): EvaluationUserTimelinePolicyAction => {
        const audit = runDecision({
          configId: descriptor.configId,
          policyInput,
          model: input.model,
        });
        assertVisibleLegalAction(audit.selectedAction, policyInput.observation);
        decisions.push(audit);
        return policyAction(
          audit.selectedAction,
          `${descriptor.configId}:${audit.method}:${audit.analysisOutputHash}`,
        );
      },
    }),
  };
  return Object.freeze({
    policyConfig,
    decisions,
  });
}

export function phase8TerminalRoleComponents(
  configId: Phase8ConfigurationRoleId,
): Phase8TerminalComponents {
  if (!PHASE8_CONFIGURATION_ROLE_IDS.includes(configId)) {
    throw new Error(`Unknown Phase 8 terminal role ${configId}.`);
  }
  return ROLE_COMPONENTS[configId];
}

export function phase8TerminalRoleFallback(
  configId: Phase8ConfigurationRoleId,
): Phase8ConfigurationRoleId | null {
  return fallbackId(configId);
}

export function phase8TerminalBehaviorConfig(
  model: Phase8TerminalRuntimeModel,
): BehaviorBeliefConfigInput {
  return model.config.behavior;
}

export function phase8TerminalBalancedBudgetOverrides(
  model: Phase8TerminalRuntimeModel,
): Partial<Omit<SolverBudget, "id">> {
  return Object.freeze({
    worldSamples: model.config.worldCount,
  });
}
