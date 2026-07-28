import { stableHash } from "../events/stable-hash";
import { buildBehaviorBelief } from "../inference/behavior-belief";
import {
  BEHAVIOR_MODEL_IDS,
  DEFAULT_BEHAVIOR_MODEL_CONFIG,
  validateBehaviorModelConfig,
  type BehaviorModelConfigInput,
  type BehaviorModelId,
} from "../inference/behavior-models";
import { buildWeightedBehaviorHypotheses } from "./weighted-hypotheses";
import {
  AdvancedSearchContractError,
  type AdvancedSearchConfig,
  type AdvancedSearchConfigInput,
  type ExactEndgameIneligibleResult,
  type ExactEndgameSolvedResult,
  type ExactIneligibilityCode,
  type ExactInformationHypothesisSet,
} from "./advanced-types";
import {
  solveExactEndgame,
  type ExactEndgameSearchInput,
} from "./exact-endgame";
import {
  exactHypothesesFromHardBelief,
  exactHypothesesFromWeightedBehavior,
} from "./exact-hypotheses";
import {
  analyzeScenarioSetForTesting,
  prepareTimelineRecommendation,
  type ScenarioAnalysisRequest,
  type TimelineRecommendationRequest,
} from "./solver";
import type { BaselineRecommendation } from "./types";

export const RESEARCH_SEARCH_DISPATCH_VERSION =
  "research-exact-then-phase5-fallback-v1" as const;

export type ResearchSearchSwitches = {
  readonly exactEndgameEnabled: boolean;
  readonly behaviorWeightingEnabled: boolean;
};

export type ResearchSearchDispatchInput = {
  readonly switches: ResearchSearchSwitches;
  readonly exactRequest: ExactEndgameSearchInput;
  readonly approximateFallbackRequest: ScenarioAnalysisRequest;
};

export type ResearchTimelineBeliefMode =
  | {
      readonly kind: "hard-only";
      readonly p2ModelId?: BehaviorModelId;
      readonly p3ModelId?: BehaviorModelId;
      readonly behaviorConfig?: BehaviorModelConfigInput;
    }
  | {
      readonly kind: "behavior-weighted";
      readonly behaviorConfig?: BehaviorModelConfigInput;
    };

export type ResearchTimelineRecommendationRequest =
  TimelineRecommendationRequest & {
    readonly exactMode: "off" | "try";
    readonly beliefMode?: ResearchTimelineBeliefMode;
    readonly advancedConfig?: AdvancedSearchConfigInput | AdvancedSearchConfig;
  };

export type ResearchDispatchTelemetry = {
  readonly exactAttemptElapsedMs: number | null;
  readonly approximateFallbackElapsedMs: number | null;
  readonly dispatchElapsedMs: number;
};

type ResearchDispatchEnvelope = {
  readonly schemaVersion: 1;
  readonly dispatchVersion: typeof RESEARCH_SEARCH_DISPATCH_VERSION;
  readonly executionMode: "research-only";
  readonly switches: ResearchSearchSwitches;
  readonly historyHash: string;
  readonly publicStateHash: string;
  readonly telemetry: ResearchDispatchTelemetry;
  readonly resultHash: string;
};

export type ResearchExactDispatchResult = ResearchDispatchEnvelope & {
  readonly quality: "Exact";
  readonly selectedMethod: "exact-endgame";
  readonly fallbackReason: null;
  readonly exactAttempt: ExactEndgameSolvedResult;
  readonly recommendation: ExactEndgameSolvedResult;
  readonly approximateFallback: null;
};

export type ResearchApproximateDispatchResult = ResearchDispatchEnvelope & {
  readonly quality: "Approximate";
  readonly selectedMethod: "phase5-approximate-fallback";
  readonly fallbackReason:
    | {
        readonly code: "EXACT_DISABLED";
        readonly detail: string;
      }
    | {
        readonly code: ExactIneligibilityCode;
        readonly detail: string;
      };
  readonly exactAttempt: ExactEndgameIneligibleResult | null;
  readonly recommendation: BaselineRecommendation;
  readonly approximateFallback: BaselineRecommendation;
};

export type ResearchSearchDispatchResult =
  ResearchExactDispatchResult | ResearchApproximateDispatchResult;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function invalidRequest(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new AdvancedSearchContractError("INVALID_BELIEF", message, details);
}

function validateDispatchInput(input: ResearchSearchDispatchInput): {
  readonly historyHash: string;
  readonly publicStateHash: string;
} {
  if (
    typeof input.switches.exactEndgameEnabled !== "boolean" ||
    typeof input.switches.behaviorWeightingEnabled !== "boolean"
  ) {
    invalidRequest("Research dispatch switches must be explicit booleans.");
  }
  const exact = input.exactRequest;
  const approximate = input.approximateFallbackRequest;
  if (exact.historyHash !== approximate.historyHash) {
    invalidRequest(
      "Exact and approximate requests must describe the same public history.",
      {
        exactHistoryHash: exact.historyHash,
        approximateHistoryHash: approximate.historyHash,
      },
    );
  }
  const exactPublicStateHash = stableHash(exact.publicState);
  const approximatePublicStateHash = stableHash(approximate.publicState);
  if (exactPublicStateHash !== approximatePublicStateHash) {
    invalidRequest(
      "Exact and approximate requests must describe the same public state.",
      {
        exactPublicStateHash,
        approximatePublicStateHash,
      },
    );
  }
  const weighted = exact.hypothesisSet.sourceKind === "weighted-behavior";
  if (weighted !== input.switches.behaviorWeightingEnabled) {
    invalidRequest(
      "The behavior-weighting switch does not match the exact hypothesis source.",
      {
        sourceKind: exact.hypothesisSet.sourceKind,
        behaviorWeightingEnabled: input.switches.behaviorWeightingEnabled,
      },
    );
  }
  return {
    historyHash: exact.historyHash,
    publicStateHash: exactPublicStateHash,
  };
}

function withResultHash<
  T extends Omit<ResearchDispatchEnvelope, "resultHash"> & {
    readonly quality: "Exact" | "Approximate";
    readonly selectedMethod: "exact-endgame" | "phase5-approximate-fallback";
    readonly fallbackReason: unknown;
    readonly exactAttempt: unknown;
    readonly recommendation: unknown;
    readonly approximateFallback: unknown;
  },
>(
  content: T,
  stableResultContent: Readonly<Record<string, unknown>>,
): T & { readonly resultHash: string } {
  return deepFreeze({
    ...content,
    resultHash: stableHash({
      schemaVersion: 1,
      dispatchVersion: RESEARCH_SEARCH_DISPATCH_VERSION,
      ...stableResultContent,
    }),
  });
}

/**
 * Research-only boundary used to ablate exact endgames independently from
 * behavioral weighting. Exact success is selected as-is; every typed exact
 * refusal falls back to the frozen Phase 5 approximate analyzer and remains
 * explicitly labelled Approximate.
 *
 * This module is intentionally not exported by the production search index.
 */
export function dispatchResearchSearch(
  input: ResearchSearchDispatchInput,
): ResearchSearchDispatchResult {
  const dispatchStartedAt = globalThis.performance.now();
  const aligned = validateDispatchInput(input);
  const envelopeWithoutTelemetry = {
    schemaVersion: 1 as const,
    dispatchVersion: RESEARCH_SEARCH_DISPATCH_VERSION,
    executionMode: "research-only" as const,
    switches: { ...input.switches },
    historyHash: aligned.historyHash,
    publicStateHash: aligned.publicStateHash,
  };

  if (input.switches.exactEndgameEnabled) {
    const exactStartedAt = globalThis.performance.now();
    const exactAttempt = solveExactEndgame(input.exactRequest);
    const exactAttemptElapsedMs = globalThis.performance.now() - exactStartedAt;
    if (exactAttempt.quality === "Exact") {
      return withResultHash(
        {
          ...envelopeWithoutTelemetry,
          telemetry: {
            exactAttemptElapsedMs,
            approximateFallbackElapsedMs: null,
            dispatchElapsedMs: globalThis.performance.now() - dispatchStartedAt,
          },
          quality: "Exact",
          selectedMethod: "exact-endgame",
          fallbackReason: null,
          exactAttempt,
          recommendation: exactAttempt,
          approximateFallback: null,
        },
        {
          switches: input.switches,
          historyHash: aligned.historyHash,
          publicStateHash: aligned.publicStateHash,
          quality: "Exact",
          selectedMethod: "exact-endgame",
          exactResultHash: exactAttempt.resultHash,
        },
      );
    }

    const fallbackStartedAt = globalThis.performance.now();
    const approximateFallback = analyzeScenarioSetForTesting(
      input.approximateFallbackRequest,
    );
    const approximateFallbackElapsedMs =
      globalThis.performance.now() - fallbackStartedAt;
    return withResultHash(
      {
        ...envelopeWithoutTelemetry,
        telemetry: {
          exactAttemptElapsedMs,
          approximateFallbackElapsedMs,
          dispatchElapsedMs: globalThis.performance.now() - dispatchStartedAt,
        },
        quality: "Approximate",
        selectedMethod: "phase5-approximate-fallback",
        fallbackReason: {
          code: exactAttempt.eligibility.code,
          detail: exactAttempt.eligibility.detail,
        },
        exactAttempt,
        recommendation: approximateFallback,
        approximateFallback,
      },
      {
        switches: input.switches,
        historyHash: aligned.historyHash,
        publicStateHash: aligned.publicStateHash,
        quality: "Approximate",
        selectedMethod: "phase5-approximate-fallback",
        exactResultHash: exactAttempt.resultHash,
        fallbackReason: exactAttempt.eligibility,
        approximateAnalysisId: approximateFallback.payload.analysisId,
        approximateOutcomeChecksum:
          approximateFallback.payload.rollout.outcomeChecksum,
      },
    );
  }

  const fallbackStartedAt = globalThis.performance.now();
  const approximateFallback = analyzeScenarioSetForTesting(
    input.approximateFallbackRequest,
  );
  const approximateFallbackElapsedMs =
    globalThis.performance.now() - fallbackStartedAt;
  return withResultHash(
    {
      ...envelopeWithoutTelemetry,
      telemetry: {
        exactAttemptElapsedMs: null,
        approximateFallbackElapsedMs,
        dispatchElapsedMs: globalThis.performance.now() - dispatchStartedAt,
      },
      quality: "Approximate",
      selectedMethod: "phase5-approximate-fallback",
      fallbackReason: {
        code: "EXACT_DISABLED",
        detail: "The research exact-endgame switch is disabled.",
      },
      exactAttempt: null,
      recommendation: approximateFallback,
      approximateFallback,
    },
    {
      switches: input.switches,
      historyHash: aligned.historyHash,
      publicStateHash: aligned.publicStateHash,
      quality: "Approximate",
      selectedMethod: "phase5-approximate-fallback",
      fallbackReason: "EXACT_DISABLED",
      approximateAnalysisId: approximateFallback.payload.analysisId,
      approximateOutcomeChecksum:
        approximateFallback.payload.rollout.outcomeChecksum,
    },
  );
}

function behaviorModelIdForFallback(
  value: string,
  seat: "p2" | "p3",
): BehaviorModelId {
  if (!BEHAVIOR_MODEL_IDS.includes(value as BehaviorModelId)) {
    throw new AdvancedSearchContractError(
      "INVALID_CONFIG",
      `Hard-only exact search requires the ${seat} fallback policy to be a deterministic behavior-model member.`,
      { seat, policyId: value },
    );
  }
  if (value === "random") {
    throw new AdvancedSearchContractError(
      "INVALID_CONFIG",
      `Hard-only exact search cannot mirror the stochastic random ${seat} fallback policy.`,
      { seat, policyId: value },
    );
  }
  return value as BehaviorModelId;
}

/**
 * Timeline-safe research entry used by evaluation harnesses. It shares the
 * frozen Phase 5 request builder, constructs hidden-world support only from
 * the public timeline, supplies the complete active event ledger to exact
 * search, and falls back to the exact same Phase 5 analysis request.
 */
export function recommendResearchFromTimeline(
  request: ResearchTimelineRecommendationRequest,
): ResearchSearchDispatchResult {
  const prepared = prepareTimelineRecommendation(request);
  const beliefMode = request.beliefMode ?? { kind: "hard-only" as const };
  let behaviorConfig = validateBehaviorModelConfig(
    beliefMode.behaviorConfig ?? DEFAULT_BEHAVIOR_MODEL_CONFIG,
  );
  let hypothesisSet: ExactInformationHypothesisSet;
  if (beliefMode.kind === "behavior-weighted") {
    const behaviorBelief = buildBehaviorBelief(
      request.timeline,
      prepared.hardBelief,
      beliefMode.behaviorConfig,
    );
    behaviorConfig = behaviorBelief.config;
    hypothesisSet = exactHypothesesFromWeightedBehavior({
      set: buildWeightedBehaviorHypotheses({
        hardBelief: prepared.hardBelief,
        behaviorBelief,
      }),
      hardBelief: prepared.hardBelief,
      behaviorBelief,
    });
  } else {
    const p2FallbackPolicy = request.policies?.p2 ?? "documented-basic";
    const p3FallbackPolicy = request.policies?.p3 ?? "documented-basic";
    const p2ModelId =
      beliefMode.p2ModelId ??
      behaviorModelIdForFallback(p2FallbackPolicy, "p2");
    const p3ModelId =
      beliefMode.p3ModelId ??
      behaviorModelIdForFallback(p3FallbackPolicy, "p3");
    if (p2ModelId !== p2FallbackPolicy || p3ModelId !== p3FallbackPolicy) {
      throw new AdvancedSearchContractError(
        "INVALID_CONFIG",
        "Hard-only exact models must match the frozen Phase 5 opponent fallback policies.",
        {
          p2ModelId,
          p2FallbackPolicy,
          p3ModelId,
          p3FallbackPolicy,
        },
      );
    }
    hypothesisSet = exactHypothesesFromHardBelief({
      hardBelief: prepared.hardBelief,
      p2ModelId,
      p3ModelId,
      behaviorConfig,
    });
  }
  const activeEvents = prepared.analysisRequest.activeEvents;
  if (activeEvents === undefined) {
    invalidRequest(
      "A prepared production timeline unexpectedly omitted its active event ledger.",
    );
  }
  return dispatchResearchSearch({
    switches: {
      exactEndgameEnabled: request.exactMode === "try",
      behaviorWeightingEnabled: beliefMode.kind === "behavior-weighted",
    },
    exactRequest: {
      publicState: prepared.analysisRequest.publicState,
      historyHash: prepared.analysisRequest.historyHash,
      hypothesisSet,
      activeEvents,
      behaviorConfig,
      opponentPolicyMode:
        beliefMode.kind === "hard-only"
          ? "deterministic-baseline"
          : "behavior-distribution",
      ...(request.advancedConfig === undefined
        ? {}
        : { config: request.advancedConfig }),
      ...(prepared.analysisRequest.shouldCancel === undefined
        ? {}
        : { shouldCancel: prepared.analysisRequest.shouldCancel }),
    },
    approximateFallbackRequest: prepared.analysisRequest,
  });
}
