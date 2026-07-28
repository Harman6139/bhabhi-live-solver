import type { PolicyPublicTrick, PublicSuitStatus } from "../agents/policies";
import type { Card, Suit } from "../domain/cards";
import type { OpponentSeat, Seat } from "../domain/seats";
import type {
  BehaviorAction,
  BehaviorActionKey,
  BehaviorModelId,
} from "../inference/behavior-models";
import type { UserAction } from "./types";

export const ADVANCED_SEARCH_ALGORITHM_VERSION =
  "behavior-weighted-information-state-foundation-v1" as const;
export const WEIGHTED_HYPOTHESES_ALGORITHM_VERSION =
  "correlated-behavior-hypotheses-v1" as const;
export const ACTOR_SAFE_POLICY_KERNEL_VERSION =
  "actor-safe-behavior-policy-kernel-v1" as const;
export const USER_OBSERVABLE_KEY_VERSION =
  "user-observable-information-key-v1" as const;
export const EXACT_INFORMATION_HYPOTHESIS_SET_VERSION =
  "exact-information-hypothesis-set-v1" as const;
export const EXACT_ENDGAME_ALGORITHM_VERSION =
  "exact-behavioral-information-state-dp-v3" as const;

export const EXACT_OPPONENT_POLICY_MODES = [
  "behavior-distribution",
  "deterministic-baseline",
] as const;
export type ExactOpponentPolicyMode =
  (typeof EXACT_OPPONENT_POLICY_MODES)[number];

export const EXACT_INELIGIBILITY_CODES = [
  "ACTIVE_CARD_LIMIT",
  "JOINT_HYPOTHESIS_LIMIT",
  "INFORMATION_STATE_LIMIT",
  "BRANCH_LIMIT",
  "DEADLINE",
  "CANCELLED",
  "UNSUPPORTED_POLICY_MEMORY",
  "CYCLIC_INFORMATION_GRAPH",
  "INCOMPLETE_ENUMERATION",
] as const;
export type ExactIneligibilityCode = (typeof EXACT_INELIGIBILITY_CODES)[number];

export type ExactEligibility =
  | {
      readonly eligible: true;
    }
  | {
      readonly eligible: false;
      readonly code: ExactIneligibilityCode;
      readonly detail: string;
    };

export type AdvancedExactLimits = {
  readonly maxActiveCards: number;
  readonly maxJointHypotheses: number;
  readonly maxInformationStates: number;
  readonly maxBranches: number;
};

/**
 * Phase 7's initial configuration is deliberately research-only. Exporting
 * these contracts does not make the advanced solver a production path.
 */
export type AdvancedSearchConfig = {
  readonly schemaVersion: 1;
  readonly executionMode: "research-only";
  readonly exact: AdvancedExactLimits;
  readonly approximateHypothesisSamples: number;
  readonly deadlineMs: number;
};

export type AdvancedSearchConfigInput = {
  readonly executionMode?: "research-only";
  readonly exact?: Partial<AdvancedExactLimits>;
  readonly approximateHypothesisSamples?: number;
  readonly deadlineMs?: number;
};

export type JointBehaviorHypothesis = {
  readonly schemaVersion: 1;
  readonly occurrenceIndex: number;
  readonly witnessId: string;
  readonly p2ModelId: BehaviorModelId;
  readonly p3ModelId: BehaviorModelId;
  readonly mass: number;
  readonly currentHands: Readonly<Record<Seat, readonly Card[]>>;
  readonly hypothesisKey: string;
};

export type WeightedBehaviorHypothesisSet = {
  readonly schemaVersion: 1;
  readonly algorithmVersion: typeof WEIGHTED_HYPOTHESES_ALGORITHM_VERSION;
  readonly historyHash: string;
  readonly hardBeliefConfigHash: string;
  readonly worldSetChecksum: string;
  readonly behaviorResultHash: string;
  readonly behaviorModelHash: string;
  readonly occurrenceCount: number;
  readonly distinctWitnesses: number;
  readonly hypothesesPerOccurrence: number;
  readonly totalHypotheses: number;
  readonly totalMass: number;
  readonly hypotheses: readonly JointBehaviorHypothesis[];
  readonly checksum: string;
};

export type ActorSafePolicyActionProbability = {
  readonly action: BehaviorAction;
  readonly actionKey: BehaviorActionKey;
  readonly probability: number;
};

export type ActorSafePolicyDistribution = {
  readonly schemaVersion: 1;
  readonly kernelVersion: typeof ACTOR_SAFE_POLICY_KERNEL_VERSION;
  readonly behaviorModelHash: string;
  readonly seat: OpponentSeat;
  readonly decisionOrdinal: number;
  readonly modelId: BehaviorModelId;
  readonly preferredActionKey: BehaviorActionKey | null;
  readonly observationHash: string;
  readonly configHash: string;
  readonly probabilities: readonly ActorSafePolicyActionProbability[];
  readonly distributionHash: string;
};

export type UserObservablePolicyMemory = {
  readonly schemaVersion: 1;
  readonly decisionOrdinals: Readonly<Record<Seat, number>>;
  readonly priorPlayCounts: Readonly<Record<Seat, number>>;
  readonly currentSuitStatus: Readonly<
    Record<Seat, Readonly<Record<Suit, PublicSuitStatus>>>
  >;
  readonly lastPickup: {
    readonly picker: Seat;
    readonly cards: readonly Card[];
    readonly thullaBy: Seat;
  } | null;
};

export type UserObservableStateKey = {
  readonly schemaVersion: 1;
  readonly keyVersion: typeof USER_OBSERVABLE_KEY_VERSION;
  readonly key: string;
  readonly publicProjectionHash: string;
  readonly policyMemoryHash: string;
};

export type UserObservableTrick = PolicyPublicTrick;

export type ExactInformationHypothesis = {
  readonly schemaVersion: 1;
  readonly hypothesisId: string;
  readonly occurrenceIndex: number;
  readonly witnessId: string;
  readonly p2ModelId: BehaviorModelId;
  readonly p3ModelId: BehaviorModelId;
  readonly mass: number;
  readonly currentHands: Readonly<Record<Seat, readonly Card[]>>;
};

export type ExactInformationHypothesisSet = {
  readonly schemaVersion: 1;
  readonly setVersion: typeof EXACT_INFORMATION_HYPOTHESIS_SET_VERSION;
  readonly historyHash: string;
  readonly sourceKind: "weighted-behavior" | "hard-only" | "explicit-research";
  readonly sourceChecksum: string;
  readonly supportKind: "exhaustive" | "sampled";
  readonly supportWorldCount: string;
  readonly behaviorConfigHash: string;
  readonly totalMass: number;
  readonly totalHypotheses: number;
  readonly distinctWitnesses: number;
  readonly hypotheses: readonly ExactInformationHypothesis[];
  readonly checksum: string;
};

export type ExactTerminalProbabilities = Readonly<Record<Seat, number>>;

export type ExactFirstOpponentEscapeProbabilities = Readonly<
  Record<"p2" | "p3" | "tie" | "none", number>
>;

export type ExactUserHeadsUpOpponentProbabilities = Readonly<
  Record<"p2" | "p3" | "none", number>
>;

/**
 * Solver-derived positional values under the same exhaustive support,
 * opponent policies, chance enumeration, and downstream user policy as the
 * terminal Bhabhi value. These are diagnostics only; action selection remains
 * ordered by terminal user Bhabhi risk.
 */
export type ExactEndgamePositionalDiagnostics = {
  readonly immediatePickupProbability: number;
  readonly expectedImmediatePickupCount: number;
  readonly immediatePowerProbability: number;
  readonly firstOpponentEscapeProbabilities: ExactFirstOpponentEscapeProbabilities;
  readonly userHeadsUpOpponentProbabilities: ExactUserHeadsUpOpponentProbabilities;
};

export type ExactEndgameActionValue = {
  readonly action: UserAction;
  readonly actionKey: string;
  readonly userBhabhiRisk: number;
  readonly bhabhiProbabilities: ExactTerminalProbabilities;
  readonly positionalDiagnostics: ExactEndgamePositionalDiagnostics;
};

export type ExactEndgameDiagnostics = {
  readonly activeCardCount: number;
  readonly initialHypotheses: number;
  readonly informationStates: number;
  readonly branches: number;
  readonly terminalStates: number;
  readonly memoHits: number;
  readonly userNodes: number;
  readonly opponentNodes: number;
  readonly chanceNodes: number;
  readonly maximumDepth: number;
  readonly cycleChecks: number;
  readonly cycleProbeStates: number;
  readonly cycleProbeBranches: number;
};

type ExactEndgameResultEnvelope = {
  readonly schemaVersion: 1;
  readonly algorithmVersion: typeof EXACT_ENDGAME_ALGORITHM_VERSION;
  readonly method: "exact-behavioral-information-state-dp";
  readonly executionMode: "research-only";
  readonly historyHash: string;
  readonly publicStateHash: string;
  readonly hypothesisSetChecksum: string;
  readonly configHash: string;
  readonly behaviorConfigHash: string;
  readonly assumptions: {
    readonly userPolicy: "optimal-shared-observable-information-state";
    readonly opponentPolicy:
      | "separate-static-behavior-models"
      | "separate-deterministic-baseline-models";
    readonly chance: "uniform-over-eligible-cards";
    readonly cycleHandling: "detect-and-decline";
    readonly numericTolerance: number;
  };
  readonly diagnostics: ExactEndgameDiagnostics;
  readonly warnings: readonly string[];
  readonly resultHash: string;
};

export type ExactEndgameSolvedResult = ExactEndgameResultEnvelope & {
  readonly quality: "Exact";
  readonly eligibility: {
    readonly eligible: true;
  };
  readonly recommendedAction: UserAction;
  readonly recommendedActionKey: string;
  readonly tiedBestActionKeys: readonly string[];
  readonly userBhabhiRisk: number;
  readonly bhabhiProbabilities: ExactTerminalProbabilities;
  readonly positionalDiagnostics: ExactEndgamePositionalDiagnostics;
  readonly actionValues: readonly ExactEndgameActionValue[];
};

export type ExactEndgameIneligibleResult = ExactEndgameResultEnvelope & {
  readonly quality: "Unavailable";
  readonly eligibility: {
    readonly eligible: false;
    readonly code: ExactIneligibilityCode;
    readonly detail: string;
  };
  readonly recommendedAction: null;
  readonly recommendedActionKey: null;
  readonly tiedBestActionKeys: readonly [];
  readonly userBhabhiRisk: null;
  readonly bhabhiProbabilities: null;
  readonly positionalDiagnostics: null;
  readonly actionValues: readonly [];
};

export type ExactEndgameResult =
  ExactEndgameSolvedResult | ExactEndgameIneligibleResult;

export type AdvancedSearchContractErrorCode =
  | "INVALID_CONFIG"
  | "STALE_BELIEF"
  | "INVALID_BELIEF"
  | "INVALID_POLICY_OBSERVATION"
  | "INVALID_OBSERVABLE_STATE";

export class AdvancedSearchContractError extends Error {
  readonly code: AdvancedSearchContractErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: AdvancedSearchContractErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AdvancedSearchContractError";
    this.code = code;
    this.details = details;
  }
}
