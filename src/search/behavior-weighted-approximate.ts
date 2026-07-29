import {
  baselinePolicyDefinitions,
  type BaselinePolicyId,
} from "../agents/policies";
import { SEATS, type Seat } from "../domain/seats";
import type { GameEvent } from "../events/game-events";
import { stableHash } from "../events/stable-hash";
import { replayEvents } from "../events/timeline";
import {
  behaviorBeliefConfigurationHash,
  buildBehaviorBelief,
  type BehaviorBeliefConfigInput,
} from "../inference/behavior-belief";
import {
  BEHAVIOR_MODEL_HASH,
  BEHAVIOR_MODEL_IDS,
  validateBehaviorModelConfig,
  type BehaviorModelConfig,
  type BehaviorModelConfigInput,
  type BehaviorModelId,
} from "../inference/behavior-models";
import { HardInferenceError } from "../inference/error";
import type { PublicInformationState } from "../public/public-state";
import {
  assertExactHandStateInvariant,
  type ExactHands,
} from "../rules/exact-hand-transition";
import { actionKey, compareUserActions, legalUserActions } from "./actions";
import {
  DEFAULT_SOLVER_POLICIES,
  normalizeSolverSeeds,
  solverSeedIds,
  validateSolverPolicies,
} from "./config";
import { runTerminalRollout } from "./rollout";
import { compareRootRiskCandidates } from "./root-tie-break";
import {
  analyzeScenarioSetForTesting,
  prepareTimelineRecommendation,
  recommendFromTimeline,
  type PreparedTimelineRecommendation,
  type TimelineRecommendationRequest,
} from "./solver";
import {
  AdvancedSearchContractError,
  WEIGHTED_HYPOTHESES_ALGORITHM_VERSION,
  type JointBehaviorHypothesis,
  type WeightedBehaviorHypothesisSet,
} from "./advanced-types";
import type {
  BaselineRecommendation,
  RolloutOutcome,
  RootResolutionProbability,
  SolverBudget,
  SolverSeedSet,
  UserAction,
} from "./types";
import { SearchError } from "./types";
import { buildWeightedBehaviorHypotheses } from "./weighted-hypotheses";

export const BEHAVIOR_WEIGHTED_APPROXIMATE_ALGORITHM_VERSION =
  "behavior-weighted-terminal-root-rollout-v2" as const;
export const BEHAVIOR_WEIGHTED_DISPATCH_VERSION =
  "behavior-aware-approximate-dispatch-v1" as const;

const NORMALIZATION_TOLERANCE = 1e-10;
const HYPOTHESES_PER_OCCURRENCE =
  BEHAVIOR_MODEL_IDS.length * BEHAVIOR_MODEL_IDS.length;
const Z_95 = 1.959963984540054;

export type WeightedUncertaintyInterval = {
  readonly level: 0.95;
  readonly method: "weighted-occurrence-cluster-normal";
  readonly lower: number;
  readonly upper: number;
  readonly standardError: number | null;
  readonly effectiveClusters: number;
};

export type WeightedEffectiveSampleSizes = {
  readonly occurrence: number;
  readonly jointHypothesis: number;
  readonly terminalRollout: number;
};

export type BehaviorWeightedPublicDecisionTrace = {
  readonly eventIndex: number;
  readonly seat: "p2" | "p3";
  readonly decisionOrdinal: number;
  readonly observedActionKey: string;
  readonly forced: boolean;
  readonly observedPredictiveProbability: number;
  readonly effectiveSampleSizeBefore: number;
  readonly effectiveSampleSizeAfter: number;
  readonly entropyBefore: number;
  readonly entropyAfter: number;
};

export type BehaviorWeightedPublicDiagnostics = {
  readonly entropy: number;
  readonly effectiveSampleSize: number;
  readonly decisionTraces: readonly BehaviorWeightedPublicDecisionTrace[];
};

export type BehaviorWeightedActionEstimate = {
  readonly action: UserAction;
  readonly actionKey: string;
  readonly terminalRollouts: number;
  readonly weightedTerminalMass: number;
  readonly bhabhiProbability: number;
  readonly safeProbability: number;
  readonly interval: WeightedUncertaintyInterval;
  readonly userFinishProbabilities: Readonly<
    Record<"first" | "second" | "bhabhi" | "tiedSafe", number>
  >;
  readonly bhabhiBySeat: Readonly<Record<Seat, number>>;
  readonly immediatePickupProbability: number;
  readonly expectedImmediatePickupCount: number;
  readonly immediatePowerProbability: number;
  readonly rootResolutionProbabilities?: readonly RootResolutionProbability[];
  readonly firstOpponentEscape: Readonly<
    Record<"p2" | "p3" | "tie" | "none", number>
  >;
  readonly pairedDifferenceVsRecommended: number;
  readonly pairedDifferenceInterval: WeightedUncertaintyInterval;
  readonly approximateTie: boolean;
  readonly effectiveSampleSize: WeightedEffectiveSampleSizes;
  readonly sampleChecksum: string;
};

export type BehaviorWeightedApproximatePayload = {
  readonly schemaVersion: 1;
  readonly algorithmVersion: typeof BEHAVIOR_WEIGHTED_APPROXIMATE_ALGORITHM_VERSION;
  readonly method: "behavior-weighted-terminal-root-rollout";
  readonly quality: "Approximate";
  readonly executionMode: "research-only";
  readonly stateVersion: number;
  readonly historyHash: string;
  readonly publicStateHash: string;
  readonly configHash: string;
  readonly analysisId: string;
  readonly legalActions: readonly UserAction[];
  readonly recommendedAction: UserAction;
  readonly recommendedActionKey: string;
  readonly approximateTieActionKeys: readonly string[];
  readonly candidates: readonly BehaviorWeightedActionEstimate[];
  readonly belief: {
    readonly source: "correlated-world-and-separate-opponent-model-posteriors";
    readonly worldSetChecksum: string;
    readonly behaviorResultHash: string;
    readonly behaviorModelHash: string;
    readonly behaviorConfigHash: string;
    readonly weightedHypothesisChecksum: string;
    readonly worldOccurrences: number;
    readonly distinctWitnesses: number;
    readonly jointHypotheses: number;
    readonly totalMass: number;
    readonly minimumHypothesisMass: number;
    readonly maximumHypothesisMass: number;
    readonly effectiveSampleSize: WeightedEffectiveSampleSizes;
    readonly opponentModelMass: Readonly<
      Record<"p2" | "p3", Readonly<Record<BehaviorModelId, number>>>
    >;
  };
  readonly rollout: {
    readonly completed: number;
    readonly perAction: number;
    readonly occurrences: number;
    readonly jointHypotheses: number;
    readonly replicatesPerHypothesis: number;
    readonly failures: 0;
    readonly eventCapHits: 0;
    readonly outcomeChecksum: string;
    readonly commonRandomNumbers: "semantic-occurrence-keyed-across-root-actions";
  };
  readonly reproducibility: {
    readonly beliefSeedId: string;
    readonly searchSeedId: string;
    readonly rolloutSeedId: string;
    readonly chanceSeedId: string;
    readonly bootstrapSeedId: string;
  };
  readonly publicDiagnostics?: BehaviorWeightedPublicDiagnostics;
  readonly warnings: readonly string[];
};

export type BehaviorWeightedApproximateRecommendation = {
  readonly payload: BehaviorWeightedApproximatePayload;
  readonly telemetry: {
    readonly elapsedMs: number;
    readonly deterministicWorkCompleted: true;
    readonly deadlineMs: number;
    readonly deadlineExceeded: boolean;
  };
};

export type BehaviorWeightedAnalysisRequest = {
  readonly publicState: PublicInformationState;
  readonly historyHash: string;
  readonly stateVersion: number;
  readonly activeEvents?: readonly GameEvent[];
  readonly hypothesisSet: WeightedBehaviorHypothesisSet;
  readonly behaviorConfig?: BehaviorModelConfigInput | BehaviorModelConfig;
  /**
   * Binds optional seat-specific fitted priors already represented by the
   * weighted hypothesis set. Omission preserves the legacy shared-prior hash.
   */
  readonly behaviorBeliefConfigHash?: string;
  readonly budget: SolverBudget;
  readonly userContinuation?: string;
  readonly seeds?: Partial<SolverSeedSet>;
  readonly shouldCancel?: () => boolean;
  readonly includePublicRootDiagnostics?: boolean;
  readonly publicDiagnostics?: BehaviorWeightedPublicDiagnostics;
};

export type BehaviorWeightedFailureCode =
  | "CANCELLED"
  | "STALE_BEHAVIOR_BELIEF"
  | "INVALID_BEHAVIOR_BELIEF"
  | "NO_POSITIVE_WEIGHTED_SUPPORT"
  | "ROLLOUT_EVENT_CAP"
  | "BEHAVIOR_ROLLOUT_FAILURE";

export type BehaviorWeightedFailureReason = {
  readonly code: BehaviorWeightedFailureCode;
  readonly detail: string;
  readonly sourceCode: string | null;
};

export type BehaviorAwareApproximateMode =
  | {
      readonly enabled: false;
    }
  | {
      readonly enabled: true;
      readonly behaviorConfig?: BehaviorBeliefConfigInput;
      readonly onFailure?: "hard-only-fallback" | "refuse";
    };

export type BehaviorAwareTimelineRecommendationRequest =
  TimelineRecommendationRequest & {
    readonly behavior?: BehaviorAwareApproximateMode;
  };

type BehaviorWeightedDispatchEnvelope = {
  readonly schemaVersion: 1;
  readonly dispatchVersion: typeof BEHAVIOR_WEIGHTED_DISPATCH_VERSION;
  readonly executionMode: "research-only";
  readonly behaviorEnabled: true;
  readonly historyHash: string;
  readonly resultHash: string;
};

export type BehaviorWeightedSelectedDispatch =
  BehaviorWeightedDispatchEnvelope & {
    readonly quality: "Approximate";
    readonly selectedMethod: "behavior-weighted-approximate";
    readonly fallbackReason: null;
    readonly recommendation: BehaviorWeightedApproximateRecommendation;
    readonly behaviorAttempt: BehaviorWeightedApproximateRecommendation;
    readonly hardOnlyFallback: null;
  };

export type BehaviorWeightedFallbackDispatch =
  BehaviorWeightedDispatchEnvelope & {
    readonly quality: "Approximate";
    readonly selectedMethod: "hard-only-fallback";
    readonly fallbackReason: BehaviorWeightedFailureReason;
    readonly recommendation: BaselineRecommendation;
    readonly behaviorAttempt: null;
    readonly hardOnlyFallback: BaselineRecommendation;
  };

export type BehaviorWeightedRefusalDispatch =
  BehaviorWeightedDispatchEnvelope & {
    readonly quality: "Unavailable";
    readonly selectedMethod: "none";
    readonly fallbackReason: BehaviorWeightedFailureReason;
    readonly recommendation: null;
    readonly behaviorAttempt: null;
    readonly hardOnlyFallback: null;
  };

export type BehaviorAwareApproximateRecommendation =
  | BaselineRecommendation
  | BehaviorWeightedSelectedDispatch
  | BehaviorWeightedFallbackDispatch
  | BehaviorWeightedRefusalDispatch;

type WeightedOutcome = {
  readonly hypothesisKey: string;
  readonly occurrenceIndex: number;
  readonly weight: number;
  readonly outcome: RolloutOutcome;
};

type OccurrenceRisk = {
  readonly occurrenceIndex: number;
  readonly mass: number;
  readonly risk: number;
};

type CandidateWork = {
  readonly action: UserAction;
  readonly actionKey: string;
  readonly outcomes: readonly WeightedOutcome[];
  readonly occurrenceRisks: readonly OccurrenceRisk[];
  readonly risk: number;
};

type ValidatedWeightedSupport = {
  readonly hypotheses: readonly JointBehaviorHypothesis[];
  readonly occurrenceMasses: readonly number[];
  readonly effectiveSampleSize: WeightedEffectiveSampleSizes;
  readonly opponentModelMass: Readonly<
    Record<"p2" | "p3", Readonly<Record<BehaviorModelId, number>>>
  >;
  readonly minimumHypothesisMass: number;
  readonly maximumHypothesisMass: number;
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function invalidBelief(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new AdvancedSearchContractError("INVALID_BELIEF", message, details);
}

function staleBelief(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new AdvancedSearchContractError("STALE_BELIEF", message, details);
}

function compensatedSum(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const corrected = value - compensation;
    const next = sum + corrected;
    compensation = next - sum - corrected;
    sum = next;
  }
  return sum;
}

function effectiveSampleSize(weights: readonly number[]): number {
  const sumSquares = compensatedSum(weights.map((weight) => weight * weight));
  return sumSquares > 0 ? 1 / sumSquares : 0;
}

function canonicalHypothesisOrder(
  left: JointBehaviorHypothesis,
  right: JointBehaviorHypothesis,
): number {
  return (
    left.occurrenceIndex - right.occurrenceIndex ||
    BEHAVIOR_MODEL_IDS.indexOf(left.p2ModelId) -
      BEHAVIOR_MODEL_IDS.indexOf(right.p2ModelId) ||
    BEHAVIOR_MODEL_IDS.indexOf(left.p3ModelId) -
      BEHAVIOR_MODEL_IDS.indexOf(right.p3ModelId) ||
    left.hypothesisKey.localeCompare(right.hypothesisKey)
  );
}

function requiredIdentifier(value: string, label: string): void {
  if (value.trim().length === 0 || value.trim() !== value) {
    invalidBelief(`${label} must be a nonempty trimmed string.`, {
      label,
      value,
    });
  }
}

function validateWeightedSupport(
  set: WeightedBehaviorHypothesisSet,
  publicState: PublicInformationState,
  historyHash: string,
  replicates: number,
): ValidatedWeightedSupport {
  const setRecord = set as unknown as Readonly<Record<string, unknown>>;
  if (set.historyHash !== historyHash) {
    staleBelief(
      "Weighted behavior hypotheses belong to a different public history.",
      {
        expectedHistoryHash: historyHash,
        actualHistoryHash: set.historyHash,
      },
    );
  }
  if (
    setRecord.schemaVersion !== 1 ||
    setRecord.algorithmVersion !== WEIGHTED_HYPOTHESES_ALGORITHM_VERSION ||
    set.behaviorModelHash !== BEHAVIOR_MODEL_HASH
  ) {
    staleBelief(
      "Weighted behavior hypotheses use an unsupported schema, algorithm, or model family.",
      {
        schemaVersion: set.schemaVersion,
        algorithmVersion: set.algorithmVersion,
        behaviorModelHash: set.behaviorModelHash,
      },
    );
  }
  for (const [label, value] of [
    ["hardBeliefConfigHash", set.hardBeliefConfigHash],
    ["worldSetChecksum", set.worldSetChecksum],
    ["behaviorResultHash", set.behaviorResultHash],
    ["checksum", set.checksum],
  ] as const) {
    requiredIdentifier(value, label);
  }
  if (
    !Number.isSafeInteger(set.occurrenceCount) ||
    set.occurrenceCount < 1 ||
    set.hypothesesPerOccurrence !== HYPOTHESES_PER_OCCURRENCE ||
    set.totalHypotheses !== set.occurrenceCount * HYPOTHESES_PER_OCCURRENCE ||
    set.hypotheses.length !== set.totalHypotheses
  ) {
    invalidBelief(
      "Weighted behavior hypotheses have inconsistent support counts.",
      {
        occurrenceCount: set.occurrenceCount,
        hypothesesPerOccurrence: set.hypothesesPerOccurrence,
        totalHypotheses: set.totalHypotheses,
        actualHypotheses: set.hypotheses.length,
      },
    );
  }
  if (
    set.hypotheses.length === 0 ||
    set.hypotheses.some(
      (hypothesis) => !Number.isFinite(hypothesis.mass) || hypothesis.mass <= 0,
    )
  ) {
    invalidBelief(
      "Weighted behavior search requires finite, strictly positive hypothesis masses.",
      {
        code: "NO_POSITIVE_WEIGHTED_SUPPORT",
      },
    );
  }
  const totalMass = compensatedSum(
    set.hypotheses.map((hypothesis) => hypothesis.mass),
  );
  if (
    !Number.isFinite(set.totalMass) ||
    Math.abs(set.totalMass - 1) > NORMALIZATION_TOLERANCE ||
    Math.abs(totalMass - 1) > NORMALIZATION_TOLERANCE
  ) {
    invalidBelief("Weighted hypothesis mass must normalize to one.", {
      declaredTotalMass: set.totalMass,
      actualTotalMass: totalMass,
      code: "NO_POSITIVE_WEIGHTED_SUPPORT",
    });
  }
  const actualChecksum = stableHash({
    schemaVersion: 1,
    algorithmVersion: WEIGHTED_HYPOTHESES_ALGORITHM_VERSION,
    historyHash: set.historyHash,
    behaviorResultHash: set.behaviorResultHash,
    hypotheses: set.hypotheses.map((hypothesis) => ({
      hypothesisKey: hypothesis.hypothesisKey,
      mass: hypothesis.mass,
    })),
  });
  if (actualChecksum !== set.checksum) {
    invalidBelief("Weighted hypothesis checksum does not match its content.", {
      expected: set.checksum,
      actual: actualChecksum,
    });
  }

  const keys = new Set<string>();
  const occurrenceMasses = Array.from({ length: set.occurrenceCount }, () => 0);
  const occurrenceWitnesses = new Map<number, string>();
  const occurrenceHands = new Map<number, string>();
  const occurrenceModelCells = new Map<number, Set<string>>();
  const p2Mass = Object.fromEntries(
    BEHAVIOR_MODEL_IDS.map((modelId) => [modelId, 0]),
  ) as Record<BehaviorModelId, number>;
  const p3Mass = Object.fromEntries(
    BEHAVIOR_MODEL_IDS.map((modelId) => [modelId, 0]),
  ) as Record<BehaviorModelId, number>;

  for (const hypothesis of set.hypotheses) {
    const hypothesisRecord = hypothesis as unknown as Readonly<
      Record<string, unknown>
    >;
    if (
      hypothesisRecord.schemaVersion !== 1 ||
      !Number.isSafeInteger(hypothesis.occurrenceIndex) ||
      hypothesis.occurrenceIndex < 0 ||
      hypothesis.occurrenceIndex >= set.occurrenceCount ||
      !BEHAVIOR_MODEL_IDS.includes(hypothesis.p2ModelId) ||
      !BEHAVIOR_MODEL_IDS.includes(hypothesis.p3ModelId)
    ) {
      invalidBelief("A weighted hypothesis has invalid identifying fields.", {
        hypothesis,
      });
    }
    requiredIdentifier(hypothesis.witnessId, "witnessId");
    requiredIdentifier(hypothesis.hypothesisKey, "hypothesisKey");
    const expectedKey = stableHash({
      schemaVersion: 1,
      historyHash: set.historyHash,
      occurrenceIndex: hypothesis.occurrenceIndex,
      witnessId: hypothesis.witnessId,
      p2ModelId: hypothesis.p2ModelId,
      p3ModelId: hypothesis.p3ModelId,
    });
    if (expectedKey !== hypothesis.hypothesisKey) {
      invalidBelief(
        "A weighted hypothesis key does not match its semantic identity.",
        {
          expected: expectedKey,
          actual: hypothesis.hypothesisKey,
        },
      );
    }
    if (keys.has(hypothesis.hypothesisKey)) {
      invalidBelief("Weighted hypothesis keys must be unique.", {
        hypothesisKey: hypothesis.hypothesisKey,
      });
    }
    keys.add(hypothesis.hypothesisKey);
    const cell = `${hypothesis.p2ModelId}/${hypothesis.p3ModelId}`;
    const cells =
      occurrenceModelCells.get(hypothesis.occurrenceIndex) ?? new Set<string>();
    if (cells.has(cell)) {
      invalidBelief("An occurrence repeats an opponent-model cell.", {
        occurrenceIndex: hypothesis.occurrenceIndex,
        cell,
      });
    }
    cells.add(cell);
    occurrenceModelCells.set(hypothesis.occurrenceIndex, cells);

    const priorWitness = occurrenceWitnesses.get(hypothesis.occurrenceIndex);
    if (priorWitness !== undefined && priorWitness !== hypothesis.witnessId) {
      invalidBelief("One occurrence contains multiple witness identities.", {
        occurrenceIndex: hypothesis.occurrenceIndex,
        priorWitness,
        witnessId: hypothesis.witnessId,
      });
    }
    occurrenceWitnesses.set(hypothesis.occurrenceIndex, hypothesis.witnessId);
    const handHash = stableHash(hypothesis.currentHands);
    const priorHandHash = occurrenceHands.get(hypothesis.occurrenceIndex);
    if (priorHandHash !== undefined && priorHandHash !== handHash) {
      invalidBelief("One occurrence contains multiple exact hand states.", {
        occurrenceIndex: hypothesis.occurrenceIndex,
      });
    }
    occurrenceHands.set(hypothesis.occurrenceIndex, handHash);
    occurrenceMasses[hypothesis.occurrenceIndex] =
      (occurrenceMasses[hypothesis.occurrenceIndex] ?? 0) + hypothesis.mass;
    p2Mass[hypothesis.p2ModelId] += hypothesis.mass;
    p3Mass[hypothesis.p3ModelId] += hypothesis.mass;
  }

  const representativeHands = new Map<number, ExactHands>();
  for (const hypothesis of set.hypotheses) {
    representativeHands.set(
      hypothesis.occurrenceIndex,
      cloneHands(hypothesis.currentHands),
    );
  }
  for (
    let occurrenceIndex = 0;
    occurrenceIndex < set.occurrenceCount;
    occurrenceIndex += 1
  ) {
    if (
      occurrenceModelCells.get(occurrenceIndex)?.size !==
        HYPOTHESES_PER_OCCURRENCE ||
      occurrenceMasses[occurrenceIndex] === undefined ||
      (occurrenceMasses[occurrenceIndex] ?? 0) <= 0
    ) {
      invalidBelief(
        "Every occurrence must contain one positive-mass cell for each separate P2/P3 model pair.",
        { occurrenceIndex },
      );
    }
    const exactHands = representativeHands.get(occurrenceIndex);
    if (exactHands === undefined) {
      invalidBelief("A weighted occurrence has no exact hand state.", {
        occurrenceIndex,
      });
    }
    try {
      assertExactHandStateInvariant({
        publicState: structuredClone(publicState),
        hands: structuredClone(exactHands),
      });
    } catch (cause) {
      throw new AdvancedSearchContractError(
        "INVALID_BELIEF",
        "A weighted occurrence is incompatible with the public state.",
        { occurrenceIndex },
        { cause },
      );
    }
  }
  const actualDistinctWitnesses = new Set(
    set.hypotheses.map((hypothesis) => hypothesis.witnessId),
  ).size;
  if (actualDistinctWitnesses !== set.distinctWitnesses) {
    invalidBelief("Weighted distinct-witness diagnostics are stale.", {
      declared: set.distinctWitnesses,
      actual: actualDistinctWitnesses,
    });
  }

  const canonical = [...set.hypotheses].sort(canonicalHypothesisOrder);
  const hypothesisWeights = canonical.map(
    (hypothesis) => hypothesis.mass / totalMass,
  );
  const normalizedOccurrenceMasses = occurrenceMasses.map(
    (mass) => mass / totalMass,
  );
  return {
    hypotheses: canonical,
    occurrenceMasses: normalizedOccurrenceMasses,
    effectiveSampleSize: {
      occurrence: effectiveSampleSize(normalizedOccurrenceMasses),
      jointHypothesis: effectiveSampleSize(hypothesisWeights),
      terminalRollout: effectiveSampleSize(
        hypothesisWeights.flatMap((mass) =>
          Array.from({ length: replicates }, () => mass / replicates),
        ),
      ),
    },
    opponentModelMass: {
      p2: Object.fromEntries(
        BEHAVIOR_MODEL_IDS.map((modelId) => [
          modelId,
          p2Mass[modelId] / totalMass,
        ]),
      ) as Record<BehaviorModelId, number>,
      p3: Object.fromEntries(
        BEHAVIOR_MODEL_IDS.map((modelId) => [
          modelId,
          p3Mass[modelId] / totalMass,
        ]),
      ) as Record<BehaviorModelId, number>,
    },
    minimumHypothesisMass: Math.min(...hypothesisWeights),
    maximumHypothesisMass: Math.max(...hypothesisWeights),
  };
}

function verifyActiveEvents(
  publicState: PublicInformationState,
  historyHash: string,
  activeEvents: readonly GameEvent[],
): void {
  if (activeEvents.length !== publicState.appliedEventCount) {
    throw new AdvancedSearchContractError(
      "STALE_BELIEF",
      "Active event count does not match the public state.",
      {
        activeEvents: activeEvents.length,
        appliedEventCount: publicState.appliedEventCount,
      },
    );
  }
  const replay = replayEvents(activeEvents);
  if (
    replay.semanticHash !== historyHash ||
    stableHash(replay.state) !== stableHash(publicState)
  ) {
    throw new AdvancedSearchContractError(
      "STALE_BELIEF",
      "Active events do not reproduce the weighted-search public state.",
      {
        expectedHistoryHash: historyHash,
        actualHistoryHash: replay.semanticHash,
      },
    );
  }
}

function intervalFromOccurrenceValues(
  values: readonly OccurrenceRisk[],
  minimum: number,
  maximum: number,
): WeightedUncertaintyInterval {
  const effectiveClusters = effectiveSampleSize(
    values.map((value) => value.mass),
  );
  if (values.length < 2 || effectiveClusters <= 1) {
    return {
      level: 0.95,
      method: "weighted-occurrence-cluster-normal",
      lower: minimum,
      upper: maximum,
      standardError: null,
      effectiveClusters,
    };
  }
  const point = compensatedSum(values.map((value) => value.mass * value.risk));
  const sumSquares = compensatedSum(
    values.map((value) => value.mass * value.mass),
  );
  const denominator = 1 - sumSquares;
  if (denominator <= 0) {
    return {
      level: 0.95,
      method: "weighted-occurrence-cluster-normal",
      lower: minimum,
      upper: maximum,
      standardError: null,
      effectiveClusters,
    };
  }
  const unbiasedVariance =
    compensatedSum(
      values.map(
        (value) => value.mass * (value.risk - point) * (value.risk - point),
      ),
    ) / denominator;
  const standardError = Math.sqrt(Math.max(0, unbiasedVariance * sumSquares));
  return {
    level: 0.95,
    method: "weighted-occurrence-cluster-normal",
    lower: Math.max(minimum, point - Z_95 * standardError),
    upper: Math.min(maximum, point + Z_95 * standardError),
    standardError,
    effectiveClusters,
  };
}

function weightedProbability(
  outcomes: readonly WeightedOutcome[],
  predicate: (outcome: RolloutOutcome) => boolean,
): number {
  return compensatedSum(
    outcomes.map((entry) => (predicate(entry.outcome) ? entry.weight : 0)),
  );
}

function weightedRootResolutionProbabilities(
  outcomes: readonly WeightedOutcome[],
): readonly RootResolutionProbability[] {
  const grouped = new Map<
    string,
    {
      readonly resolution: RolloutOutcome["rootResolution"];
      weights: number[];
    }
  >();
  for (const outcome of outcomes) {
    const key = stableHash(outcome.outcome.rootResolution);
    const prior = grouped.get(key);
    if (prior === undefined) {
      grouped.set(key, {
        resolution: outcome.outcome.rootResolution,
        weights: [outcome.weight],
      });
    } else {
      prior.weights.push(outcome.weight);
    }
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => ({
      resolution: entry.resolution,
      probability: compensatedSum(entry.weights),
    }));
}

function occurrenceRisks(
  outcomes: readonly WeightedOutcome[],
  occurrenceMasses: readonly number[],
): readonly OccurrenceRisk[] {
  return occurrenceMasses.map((mass, occurrenceIndex) => {
    const lossMass = compensatedSum(
      outcomes
        .filter((entry) => entry.occurrenceIndex === occurrenceIndex)
        .map((entry) => entry.weight * entry.outcome.terminal.loss.user),
    );
    return {
      occurrenceIndex,
      mass,
      risk: lossMass / mass,
    };
  });
}

function cloneHands(
  hands: JointBehaviorHypothesis["currentHands"],
): ExactHands {
  return {
    user: [...hands.user],
    p2: [...hands.p2],
    p3: [...hands.p3],
  };
}

function runCandidate(
  input: BehaviorWeightedAnalysisRequest,
  action: UserAction,
  support: ValidatedWeightedSupport,
  behaviorConfig: BehaviorModelConfig,
  userContinuation: BaselinePolicyId,
  seeds: SolverSeedSet,
): CandidateWork {
  const outcomes: WeightedOutcome[] = [];
  for (const hypothesis of support.hypotheses) {
    const semanticScenarioKey = stableHash({
      schemaVersion: 1,
      historyHash: input.historyHash,
      occurrenceIndex: hypothesis.occurrenceIndex,
      witnessId: hypothesis.witnessId,
    });
    for (
      let replicate = 0;
      replicate < input.budget.rolloutsPerWorld;
      replicate += 1
    ) {
      if (input.shouldCancel?.() === true) {
        throw new SearchError("CANCELLED", "Search was cancelled.");
      }
      const outcome = runTerminalRollout({
        publicState: input.publicState,
        exactHands: cloneHands(hypothesis.currentHands),
        ...(input.activeEvents === undefined
          ? {}
          : { activeEvents: input.activeEvents }),
        action,
        scenarioOccurrence: hypothesis.occurrenceIndex,
        replicate,
        policies: {
          userContinuation,
          p2: DEFAULT_SOLVER_POLICIES.p2 as BaselinePolicyId,
          p3: DEFAULT_SOLVER_POLICIES.p3 as BaselinePolicyId,
        },
        behaviorOpponentPolicy: {
          models: {
            p2: hypothesis.p2ModelId,
            p3: hypothesis.p3ModelId,
          },
          config: behaviorConfig,
          semanticScenarioKey,
        },
        seeds,
        budget: input.budget,
        ...(input.shouldCancel === undefined
          ? {}
          : { shouldCancel: input.shouldCancel }),
      });
      outcomes.push({
        hypothesisKey: hypothesis.hypothesisKey,
        occurrenceIndex: hypothesis.occurrenceIndex,
        weight:
          hypothesis.mass /
          input.hypothesisSet.totalMass /
          input.budget.rolloutsPerWorld,
        outcome,
      });
    }
  }
  const expected = support.hypotheses.length * input.budget.rolloutsPerWorld;
  if (outcomes.length !== expected) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      "Behavior-weighted candidate did not complete its fixed rollout quota.",
      { expected, actual: outcomes.length, actionKey: actionKey(action) },
    );
  }
  const clusters = occurrenceRisks(outcomes, support.occurrenceMasses);
  return {
    action,
    actionKey: actionKey(action),
    outcomes,
    occurrenceRisks: clusters,
    risk: compensatedSum(
      clusters.map((cluster) => cluster.mass * cluster.risk),
    ),
  };
}

function pairedOccurrenceDifferences(
  candidate: CandidateWork,
  reference: CandidateWork,
): readonly OccurrenceRisk[] {
  if (candidate.occurrenceRisks.length !== reference.occurrenceRisks.length) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      "Paired weighted candidates have different occurrence counts.",
    );
  }
  return candidate.occurrenceRisks.map((cluster, index) => {
    const referenceCluster = reference.occurrenceRisks[index];
    if (
      referenceCluster === undefined ||
      referenceCluster.occurrenceIndex !== cluster.occurrenceIndex ||
      Math.abs(referenceCluster.mass - cluster.mass) > NORMALIZATION_TOLERANCE
    ) {
      throw new SearchError(
        "INVARIANT_VIOLATION",
        "Paired weighted candidates have misaligned occurrence clusters.",
        { occurrenceIndex: cluster.occurrenceIndex },
      );
    }
    return {
      occurrenceIndex: cluster.occurrenceIndex,
      mass: cluster.mass,
      risk: cluster.risk - referenceCluster.risk,
    };
  });
}

function candidateEstimate(
  candidate: CandidateWork,
  recommended: CandidateWork,
  support: ValidatedWeightedSupport,
  includePublicRootDiagnostics: boolean,
): BehaviorWeightedActionEstimate {
  const outcomes = candidate.outcomes;
  const difference = candidate.risk - recommended.risk;
  const pairedInterval = intervalFromOccurrenceValues(
    pairedOccurrenceDifferences(candidate, recommended),
    -1,
    1,
  );
  return {
    action: candidate.action,
    actionKey: candidate.actionKey,
    terminalRollouts: outcomes.length,
    weightedTerminalMass: compensatedSum(
      outcomes.map((outcome) => outcome.weight),
    ),
    bhabhiProbability: candidate.risk,
    safeProbability: 1 - candidate.risk,
    interval: intervalFromOccurrenceValues(candidate.occurrenceRisks, 0, 1),
    userFinishProbabilities: {
      first: weightedProbability(
        outcomes,
        (outcome) => outcome.terminal.userFinish === "first",
      ),
      second: weightedProbability(
        outcomes,
        (outcome) => outcome.terminal.userFinish === "second",
      ),
      bhabhi: weightedProbability(
        outcomes,
        (outcome) => outcome.terminal.userFinish === "bhabhi",
      ),
      tiedSafe: weightedProbability(
        outcomes,
        (outcome) => outcome.terminal.userFinish === "tied-safe",
      ),
    },
    bhabhiBySeat: Object.fromEntries(
      SEATS.map((seat) => [
        seat,
        weightedProbability(
          outcomes,
          (outcome) => outcome.terminal.bhabhi === seat,
        ),
      ]),
    ) as Record<Seat, number>,
    immediatePickupProbability: weightedProbability(
      outcomes,
      (outcome) => outcome.rootPickup,
    ),
    expectedImmediatePickupCount: compensatedSum(
      outcomes.map(
        (outcome) => outcome.weight * outcome.outcome.rootPickupCount,
      ),
    ),
    immediatePowerProbability: weightedProbability(
      outcomes,
      (outcome) => outcome.rootPower,
    ),
    ...(includePublicRootDiagnostics
      ? {
          rootResolutionProbabilities:
            weightedRootResolutionProbabilities(outcomes),
        }
      : {}),
    firstOpponentEscape: {
      p2: weightedProbability(
        outcomes,
        (outcome) => outcome.terminal.firstOpponentEscape === "p2",
      ),
      p3: weightedProbability(
        outcomes,
        (outcome) => outcome.terminal.firstOpponentEscape === "p3",
      ),
      tie: weightedProbability(
        outcomes,
        (outcome) => outcome.terminal.firstOpponentEscape === "tie",
      ),
      none: weightedProbability(
        outcomes,
        (outcome) => outcome.terminal.firstOpponentEscape === null,
      ),
    },
    pairedDifferenceVsRecommended: difference,
    pairedDifferenceInterval: pairedInterval,
    approximateTie: pairedInterval.lower <= 0 && pairedInterval.upper >= 0,
    effectiveSampleSize: support.effectiveSampleSize,
    sampleChecksum: stableHash({
      schemaVersion: 1,
      outcomes: outcomes.map((outcome) => ({
        hypothesisKey: outcome.hypothesisKey,
        replicate: outcome.outcome.replicate,
        deterministicHash: outcome.outcome.deterministicHash,
      })),
    }),
  };
}

function analysisConfigurationHash(input: {
  readonly budget: SolverBudget;
  readonly userContinuation: BaselinePolicyId;
  readonly behaviorConfig: BehaviorModelConfig;
  readonly behaviorBeliefConfigHash?: string;
  readonly seeds: SolverSeedSet;
}): string {
  return stableHash({
    schemaVersion: 1,
    algorithmVersion: BEHAVIOR_WEIGHTED_APPROXIMATE_ALGORITHM_VERSION,
    budget: input.budget,
    userContinuationPolicy: baselinePolicyDefinitions().find(
      (definition) => definition.id === input.userContinuation,
    ),
    behaviorModelHash: BEHAVIOR_MODEL_HASH,
    behaviorConfig: input.behaviorConfig,
    ...(input.behaviorBeliefConfigHash === undefined
      ? {}
      : { behaviorBeliefConfigHash: input.behaviorBeliefConfigHash }),
    seedIds: solverSeedIds(input.seeds),
  });
}

/**
 * Explicit research/testing entry for the Phase 8 weighted approximate path.
 * Production callers should use recommendBehaviorAwareApproximateFromTimeline
 * so the hard and behavioral beliefs are rebuilt from one verified timeline.
 */
export function analyzeWeightedBehaviorHypothesesForTesting(
  input: BehaviorWeightedAnalysisRequest,
): BehaviorWeightedApproximateRecommendation {
  const startedAt = globalThis.performance.now();
  if (
    !Number.isSafeInteger(input.stateVersion) ||
    input.stateVersion < 0 ||
    input.historyHash.trim().length === 0
  ) {
    throw new SearchError(
      "INVALID_REQUEST",
      "State version and history hash are required.",
    );
  }
  if (
    input.publicState.status !== "active" ||
    input.publicState.turn !== "user" ||
    input.publicState.pendingAction !== null
  ) {
    throw new SearchError(
      "NOT_USER_TURN",
      "Behavior-weighted recommendations require an active, non-chance user turn.",
    );
  }
  if (input.shouldCancel?.() === true) {
    throw new SearchError("CANCELLED", "Search was cancelled.");
  }
  if (input.activeEvents !== undefined) {
    verifyActiveEvents(
      input.publicState,
      input.historyHash,
      input.activeEvents,
    );
  }
  const behaviorConfig = validateBehaviorModelConfig(
    input.behaviorConfig ?? {},
  );
  if (
    input.behaviorBeliefConfigHash !== undefined &&
    input.behaviorBeliefConfigHash.trim().length === 0
  ) {
    throw new SearchError(
      "INVALID_REQUEST",
      "Behavior-belief configuration hash must be non-empty when supplied.",
    );
  }
  const userContinuation = validateSolverPolicies({
    userContinuation:
      input.userContinuation ?? DEFAULT_SOLVER_POLICIES.userContinuation,
    p2: DEFAULT_SOLVER_POLICIES.p2,
    p3: DEFAULT_SOLVER_POLICIES.p3,
  }).userContinuation;
  const seeds = normalizeSolverSeeds(input.seeds);
  const support = validateWeightedSupport(
    input.hypothesisSet,
    input.publicState,
    input.historyHash,
    input.budget.rolloutsPerWorld,
  );
  const actions = legalUserActions(input.publicState);
  if (actions.length === 0) {
    throw new SearchError(
      "NO_LEGAL_ACTION",
      "The user has no legal root action.",
    );
  }
  const work = actions.map((action) =>
    runCandidate(
      input,
      action,
      support,
      behaviorConfig,
      userContinuation,
      seeds,
    ),
  );
  const publicStateHash = stableHash(input.publicState);
  const seedIds = solverSeedIds(seeds);
  const tieBreakContext = {
    historyHash: input.historyHash,
    publicStateHash,
    searchSeedId: seedIds.search,
  };
  const recommended = [...work].sort((left, right) =>
    compareRootRiskCandidates(tieBreakContext, left, right),
  )[0];
  if (recommended === undefined) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      "Behavior-weighted search produced no candidate.",
    );
  }
  const candidates = work
    .map((candidate) =>
      candidateEstimate(
        candidate,
        recommended,
        support,
        input.includePublicRootDiagnostics === true,
      ),
    )
    .sort(
      (left, right) =>
        left.bhabhiProbability - right.bhabhiProbability ||
        compareUserActions(left.action, right.action),
    );
  const completed = work.reduce(
    (total, candidate) => total + candidate.outcomes.length,
    0,
  );
  const expectedCompleted =
    actions.length * support.hypotheses.length * input.budget.rolloutsPerWorld;
  if (completed !== expectedCompleted) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      "Behavior-weighted search did not complete its fixed deterministic quota.",
      { completed, expectedCompleted },
    );
  }
  const configHash = analysisConfigurationHash({
    budget: input.budget,
    userContinuation,
    behaviorConfig,
    ...(input.behaviorBeliefConfigHash === undefined
      ? {}
      : { behaviorBeliefConfigHash: input.behaviorBeliefConfigHash }),
    seeds,
  });
  const behaviorConfigHash =
    input.behaviorBeliefConfigHash ??
    behaviorBeliefConfigurationHash(behaviorConfig);
  const analysisId = stableHash({
    schemaVersion: 1,
    algorithmVersion: BEHAVIOR_WEIGHTED_APPROXIMATE_ALGORITHM_VERSION,
    stateVersion: input.stateVersion,
    historyHash: input.historyHash,
    publicStateHash,
    configHash,
    weightedHypothesisChecksum: input.hypothesisSet.checksum,
  });
  const outcomeChecksum = stableHash({
    schemaVersion: 1,
    actions: work.map((candidate) => ({
      actionKey: candidate.actionKey,
      outcomes: candidate.outcomes.map((outcome) => ({
        hypothesisKey: outcome.hypothesisKey,
        deterministicHash: outcome.outcome.deterministicHash,
      })),
    })),
  });
  const payload: BehaviorWeightedApproximatePayload = {
    schemaVersion: 1,
    algorithmVersion: BEHAVIOR_WEIGHTED_APPROXIMATE_ALGORITHM_VERSION,
    method: "behavior-weighted-terminal-root-rollout",
    quality: "Approximate",
    executionMode: "research-only",
    stateVersion: input.stateVersion,
    historyHash: input.historyHash,
    publicStateHash,
    configHash,
    analysisId,
    legalActions: actions,
    recommendedAction: recommended.action,
    recommendedActionKey: recommended.actionKey,
    approximateTieActionKeys: candidates
      .filter((candidate) => candidate.approximateTie)
      .map((candidate) => candidate.actionKey),
    candidates,
    belief: {
      source: "correlated-world-and-separate-opponent-model-posteriors",
      worldSetChecksum: input.hypothesisSet.worldSetChecksum,
      behaviorResultHash: input.hypothesisSet.behaviorResultHash,
      behaviorModelHash: input.hypothesisSet.behaviorModelHash,
      behaviorConfigHash,
      weightedHypothesisChecksum: input.hypothesisSet.checksum,
      worldOccurrences: input.hypothesisSet.occurrenceCount,
      distinctWitnesses: input.hypothesisSet.distinctWitnesses,
      jointHypotheses: input.hypothesisSet.totalHypotheses,
      totalMass: input.hypothesisSet.totalMass,
      minimumHypothesisMass: support.minimumHypothesisMass,
      maximumHypothesisMass: support.maximumHypothesisMass,
      effectiveSampleSize: support.effectiveSampleSize,
      opponentModelMass: support.opponentModelMass,
    },
    rollout: {
      completed,
      perAction: support.hypotheses.length * input.budget.rolloutsPerWorld,
      occurrences: input.hypothesisSet.occurrenceCount,
      jointHypotheses: support.hypotheses.length,
      replicatesPerHypothesis: input.budget.rolloutsPerWorld,
      failures: 0,
      eventCapHits: 0,
      outcomeChecksum,
      commonRandomNumbers: "semantic-occurrence-keyed-across-root-actions",
    },
    reproducibility: {
      beliefSeedId: seedIds.belief,
      searchSeedId: seedIds.search,
      rolloutSeedId: seedIds.rollout,
      chanceSeedId: seedIds.chance,
      bootstrapSeedId: seedIds.bootstrap,
    },
    ...(input.publicDiagnostics === undefined
      ? {}
      : { publicDiagnostics: input.publicDiagnostics }),
    warnings: [
      "Research-only behavior-weighted approximate rollout; the frozen hard-only production default is unchanged.",
      "Opponent P2/P3 model identities remain separate static latent variables within each correlated world occurrence.",
      "Weighted occurrence-cluster normal intervals are diagnostic approximations, not exact game-theoretic confidence sets.",
      "One-occurrence uncertainty is reported conservatively as the full feasible range.",
      "Bit-identical root risks are resolved reproducibly from public history, public state, and the frozen search-seed namespace; hidden truth is never consulted.",
      ...(input.activeEvents === undefined
        ? [
            "Synthetic-state test path: no full event ledger was available for chronology verification.",
          ]
        : []),
    ],
  };
  const elapsedMs = globalThis.performance.now() - startedAt;
  return deepFreeze({
    payload,
    telemetry: {
      elapsedMs,
      deterministicWorkCompleted: true,
      deadlineMs: input.budget.deadlineMs,
      deadlineExceeded: elapsedMs > input.budget.deadlineMs,
    },
  });
}

function failureReason(cause: unknown): BehaviorWeightedFailureReason {
  if (cause instanceof AdvancedSearchContractError) {
    const noSupport =
      cause.code === "INVALID_BELIEF" &&
      cause.details.code === "NO_POSITIVE_WEIGHTED_SUPPORT";
    return {
      code: noSupport
        ? "NO_POSITIVE_WEIGHTED_SUPPORT"
        : cause.code === "STALE_BELIEF"
          ? "STALE_BEHAVIOR_BELIEF"
          : "INVALID_BEHAVIOR_BELIEF",
      detail: cause.message,
      sourceCode: cause.code,
    };
  }
  if (cause instanceof SearchError) {
    return {
      code:
        cause.code === "CANCELLED"
          ? "CANCELLED"
          : cause.code === "ROLLOUT_EVENT_CAP"
            ? "ROLLOUT_EVENT_CAP"
            : "BEHAVIOR_ROLLOUT_FAILURE",
      detail: cause.message,
      sourceCode: cause.code,
    };
  }
  if (cause instanceof HardInferenceError) {
    return {
      code: "INVALID_BEHAVIOR_BELIEF",
      detail: cause.message,
      sourceCode: cause.code,
    };
  }
  if (cause instanceof Error) {
    return {
      code: "BEHAVIOR_ROLLOUT_FAILURE",
      detail: cause.message,
      sourceCode: null,
    };
  }
  return {
    code: "BEHAVIOR_ROLLOUT_FAILURE",
    detail: "Behavior-weighted search failed with an unknown cause.",
    sourceCode: null,
  };
}

function dispatchHash(
  content: Omit<BehaviorWeightedDispatchEnvelope, "resultHash"> & {
    readonly quality: "Approximate" | "Unavailable";
    readonly selectedMethod:
      "behavior-weighted-approximate" | "hard-only-fallback" | "none";
    readonly fallbackReason: BehaviorWeightedFailureReason | null;
    readonly recommendationHash: string | null;
  },
): string {
  return stableHash(content);
}

function baselineRequest(
  request: BehaviorAwareTimelineRecommendationRequest,
): TimelineRecommendationRequest {
  const { behavior, ...result } = request;
  void behavior;
  return result;
}

/**
 * Opt-in timeline-safe dispatcher. With behavior absent or disabled it returns
 * recommendFromTimeline() directly, preserving the frozen hard-only payload.
 */
export function recommendBehaviorAwareApproximateFromTimeline(
  request: BehaviorAwareTimelineRecommendationRequest,
): BehaviorAwareApproximateRecommendation {
  if (request.behavior?.enabled !== true) {
    return recommendFromTimeline(baselineRequest(request));
  }
  const prepared: PreparedTimelineRecommendation =
    prepareTimelineRecommendation(baselineRequest(request));
  const historyHash = prepared.analysisRequest.historyHash;
  const envelope = {
    schemaVersion: 1 as const,
    dispatchVersion: BEHAVIOR_WEIGHTED_DISPATCH_VERSION,
    executionMode: "research-only" as const,
    behaviorEnabled: true as const,
    historyHash,
  };
  try {
    const behaviorBelief = buildBehaviorBelief(
      request.timeline,
      prepared.hardBelief,
      request.behavior.behaviorConfig,
    );
    const hypothesisSet = buildWeightedBehaviorHypotheses({
      hardBelief: prepared.hardBelief,
      behaviorBelief,
    });
    const behaviorAttempt = analyzeWeightedBehaviorHypothesesForTesting({
      publicState: prepared.analysisRequest.publicState,
      historyHash,
      stateVersion: prepared.analysisRequest.stateVersion,
      ...(prepared.analysisRequest.activeEvents === undefined
        ? {}
        : { activeEvents: prepared.analysisRequest.activeEvents }),
      hypothesisSet,
      behaviorConfig: behaviorBelief.config,
      ...(behaviorBelief.opponentModelPriors === undefined
        ? {}
        : { behaviorBeliefConfigHash: behaviorBelief.configHash }),
      budget: prepared.analysisRequest.budget,
      ...(prepared.analysisRequest.policies?.userContinuation === undefined
        ? {}
        : {
            userContinuation:
              prepared.analysisRequest.policies.userContinuation,
          }),
      ...(prepared.analysisRequest.seeds === undefined
        ? {}
        : { seeds: prepared.analysisRequest.seeds }),
      ...(prepared.analysisRequest.shouldCancel === undefined
        ? {}
        : { shouldCancel: prepared.analysisRequest.shouldCancel }),
      ...(prepared.analysisRequest.includePublicRootDiagnostics === true
        ? { includePublicRootDiagnostics: true }
        : {}),
      ...(prepared.analysisRequest.includePublicRootDiagnostics === true
        ? {
            publicDiagnostics: {
              entropy: behaviorBelief.diagnostics.entropy,
              effectiveSampleSize:
                behaviorBelief.diagnostics.effectiveSampleSize,
              decisionTraces: behaviorBelief.decisionTraces.map((trace) => ({
                eventIndex: trace.eventIndex,
                seat: trace.seat,
                decisionOrdinal: trace.decisionOrdinal,
                observedActionKey: trace.observedActionKey,
                forced: trace.forced,
                observedPredictiveProbability:
                  trace.observedPredictiveProbability,
                effectiveSampleSizeBefore: trace.effectiveSampleSizeBefore,
                effectiveSampleSizeAfter: trace.effectiveSampleSizeAfter,
                entropyBefore: trace.entropyBefore,
                entropyAfter: trace.entropyAfter,
              })),
            },
          }
        : {}),
    });
    const hashContent = {
      ...envelope,
      quality: "Approximate" as const,
      selectedMethod: "behavior-weighted-approximate" as const,
      fallbackReason: null,
      recommendationHash: behaviorAttempt.payload.analysisId,
    };
    return deepFreeze({
      ...envelope,
      quality: "Approximate",
      selectedMethod: "behavior-weighted-approximate",
      fallbackReason: null,
      recommendation: behaviorAttempt,
      behaviorAttempt,
      hardOnlyFallback: null,
      resultHash: dispatchHash(hashContent),
    });
  } catch (cause) {
    const reason = failureReason(cause);
    const refuse =
      request.behavior.onFailure === "refuse" || reason.code === "CANCELLED";
    if (refuse) {
      const hashContent = {
        ...envelope,
        quality: "Unavailable" as const,
        selectedMethod: "none" as const,
        fallbackReason: reason,
        recommendationHash: null,
      };
      return deepFreeze({
        ...envelope,
        quality: "Unavailable",
        selectedMethod: "none",
        fallbackReason: reason,
        recommendation: null,
        behaviorAttempt: null,
        hardOnlyFallback: null,
        resultHash: dispatchHash(hashContent),
      });
    }
    const hardOnlyFallback = analyzeScenarioSetForTesting(
      prepared.analysisRequest,
    );
    const hashContent = {
      ...envelope,
      quality: "Approximate" as const,
      selectedMethod: "hard-only-fallback" as const,
      fallbackReason: reason,
      recommendationHash: hardOnlyFallback.payload.analysisId,
    };
    return deepFreeze({
      ...envelope,
      quality: "Approximate",
      selectedMethod: "hard-only-fallback",
      fallbackReason: reason,
      recommendation: hardOnlyFallback,
      behaviorAttempt: null,
      hardOnlyFallback,
      resultHash: dispatchHash(hashContent),
    });
  }
}
