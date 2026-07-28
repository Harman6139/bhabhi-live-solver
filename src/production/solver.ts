import type { BehaviorBelief } from "../inference/behavior-belief";
import { buildBehaviorBelief } from "../inference/behavior-belief";
import type { GameTimeline } from "../events/timeline";
import { stableHash, stableStringify } from "../events/stable-hash";
import {
  analyzeWeightedBehaviorHypothesesForTesting,
  type BehaviorWeightedApproximateRecommendation,
} from "../search/behavior-weighted-approximate";
import type {
  AdvancedSearchConfig,
  ExactEndgameIneligibleResult,
  ExactEndgameSolvedResult,
  WeightedBehaviorHypothesisSet,
} from "../search/advanced-types";
import { solveExactEndgame } from "../search/exact-endgame";
import {
  exactHypothesesFromHardBelief,
  exactHypothesesFromWeightedBehavior,
} from "../search/exact-hypotheses";
import {
  analyzeScenarioSetForTesting,
  prepareTimelineRecommendation,
  type PreparedTimelineRecommendation,
  type TimelineRecommendationRequest,
} from "../search/solver";
import type {
  ActionEstimate,
  BaselineRecommendation,
  SolverBudgetId,
  SolverSeedSet,
  UserAction,
} from "../search/types";
import { SearchError } from "../search/types";
import { buildWeightedBehaviorHypotheses } from "../search/weighted-hypotheses";
import {
  parseProductionAnalysis,
  productionAnalysisHash,
  type ProductionAnalysis,
  type ProductionCandidate,
  type ProductionCausalExplanation,
} from "./analysis-result";
import {
  PRODUCTION_ROLE_FALLBACKS,
  PRODUCTION_ROUTING_CONTRACTS,
  type ProductionRoleId,
} from "./roles";
import type {
  ProductionAnalysisBinding,
  VerifiedProductionRelease,
} from "./release-contract";

export const PRODUCTION_SOLVER_VERSION = "selected-role-dispatch-v1" as const;

export const PRODUCTION_EXACT_CONFIG: AdvancedSearchConfig = Object.freeze({
  schemaVersion: 1,
  executionMode: "research-only",
  exact: Object.freeze({
    maxActiveCards: 7,
    maxJointHypotheses: 196,
    maxInformationStates: 128,
    maxBranches: 512,
  }),
  approximateHypothesisSamples: 196,
  deadlineMs: 1_000,
});

const FROZEN_CONTINUATION_POLICIES = Object.freeze({
  userContinuation: "documented-basic",
  p2: "documented-basic",
  p3: "documented-basic",
});

export type ProductionTimelineAnalysisRequest = Readonly<{
  timeline: GameTimeline;
  budgetId?: SolverBudgetId;
  seeds?: Partial<SolverSeedSet>;
  signal?: AbortSignal;
}>;

export type ProductionSolverErrorCode =
  "CONFIGURATION_REFUSED" | "INVALID_PRODUCTION_RESULT";

export class ProductionSolverError extends Error {
  readonly code: ProductionSolverErrorCode;

  constructor(
    code: ProductionSolverErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProductionSolverError";
    this.code = code;
  }
}

type BehaviorContext = Readonly<{
  belief: BehaviorBelief;
  hypotheses: WeightedBehaviorHypothesisSet;
}>;

type ExactAttempt = ExactEndgameSolvedResult | ExactEndgameIneligibleResult;

type SelectedResult =
  | Readonly<{
      kind: "baseline";
      recommendation: BaselineRecommendation;
      method: "hard-only-approximate";
      exactAttempt: ExactAttempt | null;
      behavior: null;
      fallbackReason: string | null;
      fallbackRequestHash: string | null;
    }>
  | Readonly<{
      kind: "behavior";
      recommendation: BehaviorWeightedApproximateRecommendation;
      method: "behavior-weighted-approximate";
      exactAttempt: ExactAttempt | null;
      behavior: BehaviorContext;
      fallbackReason: string | null;
      fallbackRequestHash: string | null;
    }>
  | Readonly<{
      kind: "exact";
      recommendation: ExactEndgameSolvedResult;
      method: "exact-hard" | "exact-behavior";
      exactAttempt: ExactEndgameSolvedResult;
      behavior: BehaviorContext | null;
      fallbackReason: null;
      fallbackRequestHash: null;
    }>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function publicRequestHash(
  prepared: PreparedTimelineRecommendation,
  behavior: BehaviorContext | null,
): string {
  const request = prepared.analysisRequest;
  return stableHash({
    schemaVersion: 1,
    solverVersion: PRODUCTION_SOLVER_VERSION,
    stateVersion: request.stateVersion,
    historyHash: request.historyHash,
    publicStateHash: stableHash(request.publicState),
    budget: request.budget,
    policies: request.policies,
    seeds: request.seeds,
    beliefMethod: request.belief.method,
    ...(behavior === null
      ? {}
      : {
          behaviorConfigHash: behavior.belief.configHash,
          weightedHypothesisChecksum: behavior.hypotheses.checksum,
        }),
  });
}

function prepareRequest(
  request: ProductionTimelineAnalysisRequest,
  release: VerifiedProductionRelease,
): PreparedTimelineRecommendation {
  const behaviorRole = release.descriptor.components.behaviorWeighting;
  const behaviorModel = behaviorRole ? requireBehaviorModel(release) : null;
  const timelineRequest: TimelineRecommendationRequest = {
    timeline: request.timeline,
    budgetId: request.budgetId ?? "balanced",
    ...(behaviorRole
      ? {
          budgetOverrides: {
            worldSamples: behaviorModel?.worldCount ?? 1,
          },
        }
      : {}),
    policies: FROZEN_CONTINUATION_POLICIES,
    ...(request.seeds === undefined ? {} : { seeds: request.seeds }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    includePublicRootDiagnostics: true,
  };
  return prepareTimelineRecommendation(timelineRequest);
}

function buildBehaviorContext(
  request: ProductionTimelineAnalysisRequest,
  prepared: PreparedTimelineRecommendation,
  release: VerifiedProductionRelease,
): BehaviorContext {
  const modelConfig = requireBehaviorModel(release);
  try {
    const belief = buildBehaviorBelief(
      request.timeline,
      prepared.hardBelief,
      modelConfig.behavior,
    );
    return {
      belief,
      hypotheses: buildWeightedBehaviorHypotheses({
        hardBelief: prepared.hardBelief,
        behaviorBelief: belief,
      }),
    };
  } catch (cause) {
    if (cause instanceof SearchError && cause.code === "CANCELLED") {
      throw cause;
    }
    throw new ProductionSolverError(
      "CONFIGURATION_REFUSED",
      `Selected behavior configuration refused this public history: ${
        cause instanceof Error ? cause.message : "unknown failure"
      }`,
      { cause },
    );
  }
}

function requireBehaviorModel(
  release: VerifiedProductionRelease,
): NonNullable<VerifiedProductionRelease["modelConfig"]> {
  if (release.modelConfig === null) {
    throw new ProductionSolverError(
      "CONFIGURATION_REFUSED",
      "A behavioral production role has no verified fitted model.",
    );
  }
  return release.modelConfig;
}

function runBehaviorApproximate(
  prepared: PreparedTimelineRecommendation,
  behavior: BehaviorContext,
): BehaviorWeightedApproximateRecommendation {
  try {
    const request = prepared.analysisRequest;
    return analyzeWeightedBehaviorHypothesesForTesting({
      publicState: request.publicState,
      historyHash: request.historyHash,
      stateVersion: request.stateVersion,
      ...(request.activeEvents === undefined
        ? {}
        : { activeEvents: request.activeEvents }),
      hypothesisSet: behavior.hypotheses,
      behaviorConfig: behavior.belief.config,
      ...(behavior.belief.opponentModelPriors === undefined
        ? {}
        : { behaviorBeliefConfigHash: behavior.belief.configHash }),
      budget: request.budget,
      userContinuation: FROZEN_CONTINUATION_POLICIES.userContinuation,
      ...(request.seeds === undefined ? {} : { seeds: request.seeds }),
      ...(request.shouldCancel === undefined
        ? {}
        : { shouldCancel: request.shouldCancel }),
      includePublicRootDiagnostics: true,
      publicDiagnostics: {
        entropy: behavior.belief.diagnostics.entropy,
        effectiveSampleSize: behavior.belief.diagnostics.effectiveSampleSize,
        decisionTraces: behavior.belief.decisionTraces.map((trace) => ({
          eventIndex: trace.eventIndex,
          seat: trace.seat,
          decisionOrdinal: trace.decisionOrdinal,
          observedActionKey: trace.observedActionKey,
          forced: trace.forced,
          observedPredictiveProbability: trace.observedPredictiveProbability,
          effectiveSampleSizeBefore: trace.effectiveSampleSizeBefore,
          effectiveSampleSizeAfter: trace.effectiveSampleSizeAfter,
          entropyBefore: trace.entropyBefore,
          entropyAfter: trace.entropyAfter,
        })),
      },
    });
  } catch (cause) {
    if (cause instanceof SearchError && cause.code === "CANCELLED") {
      throw cause;
    }
    throw new ProductionSolverError(
      "CONFIGURATION_REFUSED",
      `Selected behavior rollout refused this public history: ${
        cause instanceof Error ? cause.message : "unknown failure"
      }`,
      { cause },
    );
  }
}

function activeEvents(prepared: PreparedTimelineRecommendation) {
  const events = prepared.analysisRequest.activeEvents;
  if (events === undefined) {
    throw new ProductionSolverError(
      "INVALID_PRODUCTION_RESULT",
      "Timeline-safe production analysis unexpectedly omitted active events.",
    );
  }
  return events;
}

function hardExactAttempt(
  prepared: PreparedTimelineRecommendation,
): ExactAttempt {
  return solveExactEndgame({
    publicState: prepared.analysisRequest.publicState,
    historyHash: prepared.analysisRequest.historyHash,
    hypothesisSet: exactHypothesesFromHardBelief({
      hardBelief: prepared.hardBelief,
      p2ModelId: "documented-basic",
      p3ModelId: "documented-basic",
    }),
    activeEvents: activeEvents(prepared),
    config: PRODUCTION_EXACT_CONFIG,
    opponentPolicyMode: "deterministic-baseline",
    ...(prepared.analysisRequest.shouldCancel === undefined
      ? {}
      : { shouldCancel: prepared.analysisRequest.shouldCancel }),
  });
}

function behaviorExactAttempt(
  prepared: PreparedTimelineRecommendation,
  behavior: BehaviorContext,
): ExactAttempt {
  return solveExactEndgame({
    publicState: prepared.analysisRequest.publicState,
    historyHash: prepared.analysisRequest.historyHash,
    hypothesisSet: exactHypothesesFromWeightedBehavior({
      set: behavior.hypotheses,
      hardBelief: prepared.hardBelief,
      behaviorBelief: behavior.belief,
    }),
    activeEvents: activeEvents(prepared),
    config: PRODUCTION_EXACT_CONFIG,
    behaviorConfig: behavior.belief.config,
    behaviorBeliefConfigHash: behavior.belief.configHash,
    opponentPolicyMode: "behavior-distribution",
    ...(prepared.analysisRequest.shouldCancel === undefined
      ? {}
      : { shouldCancel: prepared.analysisRequest.shouldCancel }),
  });
}

function selectedRoleResult(
  role: ProductionRoleId,
  request: ProductionTimelineAnalysisRequest,
  prepared: PreparedTimelineRecommendation,
  release: VerifiedProductionRelease,
): SelectedResult {
  switch (role) {
    case "p8-r-hard-balanced-v1":
      return {
        kind: "baseline",
        recommendation: analyzeScenarioSetForTesting(prepared.analysisRequest),
        method: "hard-only-approximate",
        exactAttempt: null,
        behavior: null,
        fallbackReason: null,
        fallbackRequestHash: null,
      };
    case "p8-e-exact-hard-fallback-v1": {
      const exact = hardExactAttempt(prepared);
      if (exact.quality === "Exact") {
        return {
          kind: "exact",
          recommendation: exact,
          method: "exact-hard",
          exactAttempt: exact,
          behavior: null,
          fallbackReason: null,
          fallbackRequestHash: null,
        };
      }
      return {
        kind: "baseline",
        recommendation: analyzeScenarioSetForTesting(prepared.analysisRequest),
        method: "hard-only-approximate",
        exactAttempt: exact,
        behavior: null,
        fallbackReason: exact.eligibility.code,
        fallbackRequestHash: publicRequestHash(prepared, null),
      };
    }
    case "p8-b-behavior-balanced-v1": {
      const behavior = buildBehaviorContext(request, prepared, release);
      return {
        kind: "behavior",
        recommendation: runBehaviorApproximate(prepared, behavior),
        method: "behavior-weighted-approximate",
        exactAttempt: null,
        behavior,
        fallbackReason: null,
        fallbackRequestHash: null,
      };
    }
    case "p8-be-behavior-exact-fallback-v1": {
      const behavior = buildBehaviorContext(request, prepared, release);
      const exact = behaviorExactAttempt(prepared, behavior);
      if (exact.quality === "Exact") {
        return {
          kind: "exact",
          recommendation: exact,
          method: "exact-behavior",
          exactAttempt: exact,
          behavior,
          fallbackReason: null,
          fallbackRequestHash: null,
        };
      }
      return {
        kind: "behavior",
        recommendation: runBehaviorApproximate(prepared, behavior),
        method: "behavior-weighted-approximate",
        exactAttempt: exact,
        behavior,
        fallbackReason: exact.eligibility.code,
        fallbackRequestHash: publicRequestHash(prepared, behavior),
      };
    }
  }
}

function baselineCandidate(candidate: ActionEstimate): ProductionCandidate {
  return {
    action: candidate.action,
    actionKey: candidate.actionKey,
    userBhabhiRisk: candidate.bhabhiProbability,
    safeProbability: candidate.safeProbability,
    interval: candidate.interval,
    approximateTie: candidate.approximateTie,
    immediatePickupProbability: candidate.immediatePickupProbability,
    expectedImmediatePickupCount: candidate.expectedImmediatePickupCount,
    immediatePowerProbability: candidate.immediatePowerProbability,
    userFinishProbabilities: {
      status: "available",
      values: candidate.userFinishProbabilities,
    },
    firstOpponentEscape: {
      status: "available",
      values: candidate.firstOpponentEscape,
    },
    rootResolutions:
      candidate.rootResolutionProbabilities === undefined
        ? {
            status: "unavailable",
            reason: "Root-resolution diagnostics were not produced.",
          }
        : {
            status: "available",
            values: candidate.rootResolutionProbabilities.map((entry) => ({
              resolution: entry.resolution,
              probability: entry.probability,
            })),
          },
  };
}

function behaviorCandidate(
  candidate: BehaviorWeightedApproximateRecommendation["payload"]["candidates"][number],
): ProductionCandidate {
  return {
    action: candidate.action,
    actionKey: candidate.actionKey,
    userBhabhiRisk: candidate.bhabhiProbability,
    safeProbability: candidate.safeProbability,
    interval: candidate.interval,
    approximateTie: candidate.approximateTie,
    immediatePickupProbability: candidate.immediatePickupProbability,
    expectedImmediatePickupCount: candidate.expectedImmediatePickupCount,
    immediatePowerProbability: candidate.immediatePowerProbability,
    userFinishProbabilities: {
      status: "available",
      values: candidate.userFinishProbabilities,
    },
    firstOpponentEscape: {
      status: "available",
      values: candidate.firstOpponentEscape,
    },
    rootResolutions:
      candidate.rootResolutionProbabilities === undefined
        ? {
            status: "unavailable",
            reason: "Root-resolution diagnostics were not produced.",
          }
        : {
            status: "available",
            values: candidate.rootResolutionProbabilities.map((entry) => ({
              resolution: entry.resolution,
              probability: entry.probability,
            })),
          },
  };
}

function exactCandidate(
  candidate: ExactEndgameSolvedResult["actionValues"][number],
  tiedBestActionKeys: readonly string[],
): ProductionCandidate {
  return {
    action: candidate.action,
    actionKey: candidate.actionKey,
    userBhabhiRisk: candidate.userBhabhiRisk,
    safeProbability: 1 - candidate.userBhabhiRisk,
    interval: null,
    approximateTie: tiedBestActionKeys.includes(candidate.actionKey),
    immediatePickupProbability:
      candidate.positionalDiagnostics.immediatePickupProbability,
    expectedImmediatePickupCount:
      candidate.positionalDiagnostics.expectedImmediatePickupCount,
    immediatePowerProbability:
      candidate.positionalDiagnostics.immediatePowerProbability,
    userFinishProbabilities: {
      status: "unavailable",
      reason:
        "Exact endgame action values do not expose user finish-order probabilities.",
    },
    firstOpponentEscape: {
      status: "available",
      values: candidate.positionalDiagnostics.firstOpponentEscapeProbabilities,
    },
    rootResolutions: {
      status: "unavailable",
      reason:
        "Exact endgame action values expose aggregate positional values, not root-resolution distributions.",
    },
  };
}

function candidatesFor(result: SelectedResult): ProductionCandidate[] {
  switch (result.kind) {
    case "baseline":
      return result.recommendation.payload.candidates.map(baselineCandidate);
    case "behavior":
      return result.recommendation.payload.candidates.map(behaviorCandidate);
    case "exact":
      return result.recommendation.actionValues.map((candidate) =>
        exactCandidate(candidate, result.recommendation.tiedBestActionKeys),
      );
  }
}

function recommendationFor(result: SelectedResult): {
  readonly action: UserAction;
  readonly actionKey: string;
  readonly analysisId: string;
  readonly legalActions: readonly UserAction[];
  readonly tieKeys: readonly string[];
  readonly warnings: readonly string[];
  readonly reproducibility:
    | BaselineRecommendation["payload"]["reproducibility"]
    | BehaviorWeightedApproximateRecommendation["payload"]["reproducibility"]
    | null;
  readonly terminalRollouts: number | null;
} {
  switch (result.kind) {
    case "baseline":
      return {
        action: result.recommendation.payload.recommendedAction,
        actionKey: result.recommendation.payload.recommendedActionKey,
        analysisId: result.recommendation.payload.analysisId,
        legalActions: result.recommendation.payload.legalActions,
        tieKeys: result.recommendation.payload.approximateTieActionKeys,
        warnings: result.recommendation.payload.warnings,
        reproducibility: result.recommendation.payload.reproducibility,
        terminalRollouts: result.recommendation.payload.rollout.completed,
      };
    case "behavior":
      return {
        action: result.recommendation.payload.recommendedAction,
        actionKey: result.recommendation.payload.recommendedActionKey,
        analysisId: result.recommendation.payload.analysisId,
        legalActions: result.recommendation.payload.legalActions,
        tieKeys: result.recommendation.payload.approximateTieActionKeys,
        warnings: result.recommendation.payload.warnings,
        reproducibility: result.recommendation.payload.reproducibility,
        terminalRollouts: result.recommendation.payload.rollout.completed,
      };
    case "exact":
      return {
        action: result.recommendation.recommendedAction,
        actionKey: result.recommendation.recommendedActionKey,
        analysisId: result.recommendation.resultHash,
        legalActions: result.recommendation.actionValues.map(
          (candidate) => candidate.action,
        ),
        tieKeys: result.recommendation.tiedBestActionKeys,
        warnings: result.recommendation.warnings,
        reproducibility: null,
        terminalRollouts: null,
      };
  }
}

function probabilityForResolution(
  candidate: ProductionCandidate,
  resolutionKey: string,
): number {
  if (candidate.rootResolutions.status === "unavailable") {
    return 0;
  }
  return (
    candidate.rootResolutions.values.find(
      (entry) => stableStringify(entry.resolution) === resolutionKey,
    )?.probability ?? 0
  );
}

function causalExplanation(
  candidates: readonly ProductionCandidate[],
  recommendedActionKey: string,
): ProductionCausalExplanation {
  const recommended = candidates.find(
    (candidate) => candidate.actionKey === recommendedActionKey,
  );
  const comparator = candidates
    .filter((candidate) => candidate.actionKey !== recommendedActionKey)
    .sort(
      (left, right) =>
        left.userBhabhiRisk - right.userBhabhiRisk ||
        left.actionKey.localeCompare(right.actionKey),
    )[0];
  if (recommended === undefined || comparator === undefined) {
    return {
      status: "unavailable",
      comparatorActionKey: comparator?.actionKey ?? null,
      terminalRiskDifference:
        recommended === undefined || comparator === undefined
          ? null
          : comparator.userBhabhiRisk - recommended.userBhabhiRisk,
      primaryMechanism: null,
      reason:
        "A causal comparison requires both the recommendation and an alternative legal action.",
    };
  }
  if (
    recommended.rootResolutions.status === "unavailable" ||
    comparator.rootResolutions.status === "unavailable"
  ) {
    return {
      status: "unavailable",
      comparatorActionKey: comparator.actionKey,
      terminalRiskDifference:
        comparator.userBhabhiRisk - recommended.userBhabhiRisk,
      primaryMechanism: null,
      reason:
        "This solver path does not expose public root-resolution distributions.",
    };
  }
  const resolutions = new Map(
    [
      ...recommended.rootResolutions.values,
      ...comparator.rootResolutions.values,
    ].map((entry) => [stableStringify(entry.resolution), entry.resolution]),
  );
  const mechanism = [...resolutions.entries()]
    .map(([key, resolution]) => {
      const recommendedProbability = probabilityForResolution(recommended, key);
      const comparatorProbability = probabilityForResolution(comparator, key);
      return {
        resolution,
        recommendedProbability,
        comparatorProbability,
        probabilityDifference: recommendedProbability - comparatorProbability,
      };
    })
    .sort(
      (left, right) =>
        Math.abs(right.probabilityDifference) -
          Math.abs(left.probabilityDifference) ||
        stableStringify(left.resolution).localeCompare(
          stableStringify(right.resolution),
        ),
    )[0];
  if (mechanism === undefined) {
    return {
      status: "unavailable",
      comparatorActionKey: comparator.actionKey,
      terminalRiskDifference:
        comparator.userBhabhiRisk - recommended.userBhabhiRisk,
      primaryMechanism: null,
      reason: "No root-resolution event was available for comparison.",
    };
  }
  return {
    status: "available",
    comparatorActionKey: comparator.actionKey,
    terminalRiskDifference:
      comparator.userBhabhiRisk - recommended.userBhabhiRisk,
    primaryMechanism: mechanism,
    reason: null,
  };
}

function releaseForAnalysis(
  binding: ProductionAnalysisBinding,
  role: ProductionRoleId,
) {
  return {
    bundleMode: binding.bundleMode,
    manifestScope: binding.manifestScope,
    manifestHash: binding.manifestHash,
    selectedConfigId: role,
    routingContract: PRODUCTION_ROUTING_CONTRACTS[role],
    sourceHash: binding.sourceHash,
    solverConfigHash: binding.solverConfigHash,
    modelHash: binding.modelHash,
    protocolHash: binding.protocolHash,
    selectionAttestationHash: binding.selectionAttestationHash,
    finalAttestationHash: binding.finalAttestationHash,
  };
}

function buildAnalysis(input: {
  readonly selected: SelectedResult;
  readonly prepared: PreparedTimelineRecommendation;
  readonly release: VerifiedProductionRelease;
  readonly elapsedMs: number;
}): ProductionAnalysis {
  const { selected, prepared, release } = input;
  const role = release.descriptor.configId;
  const recommendation = recommendationFor(selected);
  const candidates = candidatesFor(selected);
  const exact = selected.exactAttempt;
  const behavior = selected.behavior;
  const evidence = prepared.hardBelief.evidence;
  const fallbackTarget =
    selected.fallbackReason === null ? null : PRODUCTION_ROLE_FALLBACKS[role];
  const fallback = {
    used: selected.fallbackReason !== null,
    targetConfigId: fallbackTarget,
    reasonCode: selected.fallbackReason,
    requestHash: selected.fallbackRequestHash,
  };
  const fallbackWarnings =
    exact?.quality === "Unavailable" ? exact.warnings : [];
  const reproducibility =
    recommendation.reproducibility ??
    (() => {
      const seeds = prepared.analysisRequest.seeds;
      if (seeds === undefined) {
        throw new ProductionSolverError(
          "INVALID_PRODUCTION_RESULT",
          "Prepared production request unexpectedly omitted normalized seeds.",
        );
      }
      // Exact paths still bind the identical normalized seed namespace.
      return {
        beliefSeedId: stableHash(seeds.belief ?? ""),
        searchSeedId: stableHash(seeds.search ?? ""),
        rolloutSeedId: stableHash(seeds.rollout ?? ""),
        chanceSeedId: stableHash(seeds.chance ?? ""),
        bootstrapSeedId: stableHash(seeds.bootstrap ?? ""),
      };
    })();
  const content: Omit<ProductionAnalysis, "analysisHash"> = {
    schemaVersion: 1,
    analysisVersion: "production-analysis-v1",
    identity: {
      stateVersion: prepared.analysisRequest.stateVersion,
      historyHash: prepared.analysisRequest.historyHash,
      publicStateHash: stableHash(prepared.analysisRequest.publicState),
      underlyingAnalysisId: recommendation.analysisId,
    },
    release: releaseForAnalysis(release.binding, role),
    route: {
      selectedMethod: selected.method,
      quality: selected.kind === "exact" ? "Exact" : "Approximate",
      fallback,
    },
    budgetId: prepared.analysisRequest.budget.id,
    legalActions: [...recommendation.legalActions],
    recommendedAction: recommendation.action,
    recommendedActionKey: recommendation.actionKey,
    approximateTieActionKeys: [...recommendation.tieKeys],
    candidates: [...candidates],
    explanation: causalExplanation(candidates, recommendation.actionKey),
    diagnostics: {
      hardConstraints: {
        evidenceHash: stableHash(evidence),
        rules: evidence.rules,
        knownOpponentCards: {
          p2: evidence.finalState.knownOpponentCards.p2,
          p3: evidence.finalState.knownOpponentCards.p3,
        },
        voidObservations: evidence.voidObservations.map((observation) => ({
          ...observation,
        })),
        support: {
          forcedP2: evidence.support.forcedP2,
          forcedP3: evidence.support.forcedP3,
          flexible: evidence.support.flexible,
          totalWorldCount: evidence.support.totalWorldCount,
        },
      },
      belief: {
        method:
          behavior === null
            ? prepared.hardBelief.method === "exact-enumeration"
              ? "hard-exact-enumeration"
              : "hard-direct-uniform-sample"
            : "behavior-weighted",
        worldOccurrences: prepared.hardBelief.worlds.length,
        distinctWitnesses: prepared.hardBelief.diagnostics.uniqueWitnesses,
        effectiveSampleSize:
          behavior === null
            ? {
                status: "unavailable",
                reason:
                  "The hard-only payload does not expose normalized world weights.",
              }
            : {
                status: "available",
                value: behavior.belief.diagnostics.effectiveSampleSize,
              },
        entropy:
          behavior === null
            ? {
                status: "unavailable",
                reason:
                  "The hard-only payload does not expose normalized world weights.",
              }
            : {
                status: "available",
                value: behavior.belief.diagnostics.entropy,
              },
      },
      behavior:
        behavior === null
          ? {
              enabled: false,
              configHash: null,
              resultHash: null,
              p2Posterior: [],
              p3Posterior: [],
              likelihoodContributionDefinition:
                "natural-log-observed-predictive-probability",
              likelihoodContributions: {
                status: "unavailable",
                reason:
                  "The selected role does not use behavior-weighted inference.",
              },
            }
          : {
              enabled: true,
              configHash: behavior.belief.configHash,
              resultHash: behavior.belief.resultHash,
              p2Posterior: behavior.belief.opponentPosteriors.p2.map(
                (entry) => ({ ...entry }),
              ),
              p3Posterior: behavior.belief.opponentPosteriors.p3.map(
                (entry) => ({ ...entry }),
              ),
              likelihoodContributionDefinition:
                "natural-log-observed-predictive-probability",
              likelihoodContributions: {
                status: "available",
                values: behavior.belief.decisionTraces.map((trace) => ({
                  eventIndex: trace.eventIndex,
                  seat: trace.seat,
                  decisionOrdinal: trace.decisionOrdinal,
                  observedActionKey: trace.observedActionKey,
                  forced: trace.forced,
                  observedPredictiveProbability:
                    trace.observedPredictiveProbability,
                  logLikelihoodContribution: Math.log(
                    trace.observedPredictiveProbability,
                  ),
                  effectiveSampleSizeBefore: trace.effectiveSampleSizeBefore,
                  effectiveSampleSizeAfter: trace.effectiveSampleSizeAfter,
                  entropyBefore: trace.entropyBefore,
                  entropyAfter: trace.entropyAfter,
                })),
              },
            },
      sensitivity: {
        status: "unavailable",
        fragile: null,
        reason:
          "The selected production route does not execute a counterfactual model-sensitivity grid.",
        maximumSwitchRegret: null,
      },
      exact:
        exact === null
          ? {
              outcome: "not-attempted",
              configHash: null,
              resultHash: null,
              refusalCode: null,
              refusalDetail: null,
              informationStates: null,
              branches: null,
            }
          : {
              outcome: exact.quality === "Exact" ? "used" : "refused",
              configHash: exact.configHash,
              resultHash: exact.resultHash,
              refusalCode:
                exact.quality === "Unavailable" ? exact.eligibility.code : null,
              refusalDetail:
                exact.quality === "Unavailable"
                  ? exact.eligibility.detail
                  : null,
              informationStates: exact.diagnostics.informationStates,
              branches: exact.diagnostics.branches,
            },
      work: {
        terminalRollouts: recommendation.terminalRollouts,
        weightedHypotheses:
          behavior === null ? null : behavior.hypotheses.totalHypotheses,
      },
    },
    reproducibility,
    telemetry: {
      elapsedMs: input.elapsedMs,
      deadlineMs: prepared.analysisRequest.budget.deadlineMs,
      deadlineExceeded:
        input.elapsedMs > prepared.analysisRequest.budget.deadlineMs,
    },
    warnings: [
      ...fallbackWarnings,
      ...recommendation.warnings,
      ...(selected.fallbackReason === null
        ? []
        : [
            `Exact search refused with ${selected.fallbackReason}; the frozen ${String(
              fallbackTarget,
            )} fallback request was used.`,
          ]),
    ],
  };
  return parseProductionAnalysis({
    ...content,
    analysisHash: productionAnalysisHash(content),
  });
}

export function analyzeSelectedProductionRole(
  request: ProductionTimelineAnalysisRequest,
  release: VerifiedProductionRelease,
): ProductionAnalysis {
  const startedAt = globalThis.performance.now();
  if (request.signal?.aborted === true) {
    throw new SearchError("CANCELLED", "Production analysis was cancelled.");
  }
  const prepared = prepareRequest(request, release);
  const selected = selectedRoleResult(
    release.descriptor.configId,
    request,
    prepared,
    release,
  );
  return deepFreeze(
    buildAnalysis({
      selected,
      prepared,
      release,
      elapsedMs: globalThis.performance.now() - startedAt,
    }),
  );
}
