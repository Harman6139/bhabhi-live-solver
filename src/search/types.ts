import type { Card } from "../domain/cards";
import type { OpponentSeat, Seat } from "../domain/seats";
import type { EscapeGroup, RuleEffect } from "../public/public-state";

export const SEARCH_ALGORITHM_VERSION = "hard-belief-root-rollout-v1" as const;

export const SOLVER_BUDGET_IDS = [
  "instant",
  "balanced",
  "deep",
  "offline",
] as const;
export type SolverBudgetId = (typeof SOLVER_BUDGET_IDS)[number];

export type UserAction =
  | {
      readonly kind: "play-card";
      readonly card: Card;
    }
  | {
      readonly kind: "take-hand";
      readonly target: OpponentSeat;
    };

export type SolverSeedSet = {
  readonly belief: string;
  readonly search: string;
  readonly rollout: string;
  readonly chance: string;
  readonly bootstrap: string;
};

export type SolverBudget = {
  readonly id: SolverBudgetId;
  readonly worldSamples: number;
  readonly rolloutsPerWorld: number;
  readonly maxEventsPerRollout: number;
  readonly intervalResamples: number;
  readonly deadlineMs: number;
};

export type SolverPolicyConfig = {
  readonly userContinuation: string;
  readonly p2: string;
  readonly p3: string;
};

export type ProbabilityInterval = {
  readonly level: 0.95;
  readonly method: "wilson-score" | "cluster-wilson-score";
  readonly lower: number;
  readonly upper: number;
};

export type DifferenceInterval = {
  readonly level: 0.95;
  readonly method:
    | "paired-cluster-bootstrap-percentile"
    | "exact-enumerated-paired-difference";
  readonly lower: number;
  readonly upper: number;
};

export type TerminalOutcome = {
  readonly bhabhi: Seat;
  readonly loss: Readonly<Record<Seat, 0 | 1>>;
  readonly escapeGroups: readonly EscapeGroup[];
  readonly firstOpponentEscape: "p2" | "p3" | "tie" | null;
  readonly userHeadsUpOpponent: "p2" | "p3" | null;
  readonly terminalReason: Extract<
    RuleEffect,
    { readonly type: "game-completed" }
  >["reason"];
  readonly userFinish: "first" | "second" | "bhabhi" | "tied-safe";
};

/**
 * Public-only resolution of the root decision. These records deliberately
 * contain counts and public rule effects, never hidden hands or simulator
 * state.
 */
export type RootResolution =
  | {
      readonly type: "take-hand";
      readonly actor: "user";
      readonly target: OpponentSeat;
      readonly cardCount: number;
    }
  | {
      readonly type: "trick-picked-up";
      readonly picker: Seat;
      readonly thullaBy: Seat;
      readonly cardCount: number;
    }
  | {
      readonly type: "trick-wasted";
      readonly power: Seat;
      readonly cardCount: number;
    }
  | {
      readonly type: "game-completed";
      readonly bhabhi: Seat;
      readonly reason: TerminalOutcome["terminalReason"];
    };

export type RootResolutionProbability = {
  readonly resolution: RootResolution;
  readonly probability: number;
};

export type RolloutOutcome = {
  readonly scenarioOccurrence: number;
  readonly replicate: number;
  readonly actionKey: string;
  readonly terminal: TerminalOutcome;
  readonly rootPickup: boolean;
  readonly rootPickupCount: number;
  readonly rootPower: boolean;
  readonly rootResolution: RootResolution;
  readonly eventCount: number;
  readonly chanceCount: number;
  readonly policyDecisions: readonly {
    readonly seat: Seat;
    readonly decisionOrdinal: number;
    readonly policyId: string;
    readonly actionKey: string;
    readonly rngStreamId: string;
  }[];
  readonly deterministicHash: string;
};

export type ActionEstimate = {
  readonly action: UserAction;
  readonly actionKey: string;
  readonly terminalRollouts: number;
  readonly scenarioClusters: number;
  readonly userBhabhiCount: number;
  readonly bhabhiProbability: number;
  readonly safeProbability: number;
  readonly interval: ProbabilityInterval;
  readonly userFinishProbabilities: Readonly<
    Record<"first" | "second" | "bhabhi" | "tiedSafe", number>
  >;
  readonly bhabhiBySeat: Readonly<Record<Seat, number>>;
  readonly immediatePickupProbability: number;
  readonly expectedImmediatePickupCount: number;
  readonly immediatePowerProbability: number;
  /**
   * Opt-in public causal diagnostic. It is omitted by the frozen baseline
   * entry point and included by the production solver.
   */
  readonly rootResolutionProbabilities?: readonly RootResolutionProbability[];
  readonly firstOpponentEscape: Readonly<
    Record<"p2" | "p3" | "tie" | "none", number>
  >;
  readonly pairedDifferenceVsRecommended: number;
  readonly pairedDifferenceInterval: DifferenceInterval;
  readonly approximateTie: boolean;
  readonly sampleChecksum: string;
};

export type BaselineRecommendationPayload = {
  readonly schemaVersion: 1;
  readonly algorithmVersion: typeof SEARCH_ALGORITHM_VERSION;
  readonly method: "hard-belief-terminal-root-rollout";
  readonly quality: "Approximate";
  readonly stateVersion: number;
  readonly historyHash: string;
  readonly publicStateHash: string;
  readonly configHash: string;
  readonly analysisId: string;
  readonly budgetId: SolverBudgetId;
  readonly legalActions: readonly UserAction[];
  readonly recommendedAction: UserAction;
  readonly recommendedActionKey: string;
  readonly approximateTieActionKeys: readonly string[];
  readonly candidates: readonly ActionEstimate[];
  readonly belief: {
    readonly method: "exact-enumeration" | "direct-uniform-sample";
    readonly totalInitialDealWorlds: string;
    readonly materializedWorldOccurrences: number;
    readonly uniqueWitnesses: number;
    readonly worldSetChecksum: string;
  };
  readonly rollout: {
    readonly completed: number;
    readonly perAction: number;
    readonly scenarios: number;
    readonly replicatesPerScenario: number;
    readonly failures: number;
    readonly eventCapHits: number;
    readonly outcomeChecksum: string;
  };
  readonly reproducibility: {
    readonly beliefSeedId: string;
    readonly searchSeedId: string;
    readonly rolloutSeedId: string;
    readonly chanceSeedId: string;
    readonly bootstrapSeedId: string;
  };
  readonly warnings: readonly string[];
};

export type BaselineRecommendationTelemetry = {
  readonly elapsedMs: number;
  readonly deterministicWorkCompleted: boolean;
  readonly deadlineMs: number;
  readonly deadlineExceeded: boolean;
};

export type BaselineRecommendation = {
  readonly payload: BaselineRecommendationPayload;
  readonly telemetry: BaselineRecommendationTelemetry;
};

export type SearchFailureCode =
  | "INVALID_REQUEST"
  | "NOT_USER_TURN"
  | "NO_LEGAL_ACTION"
  | "STALE_WORLD"
  | "INVARIANT_VIOLATION"
  | "ILLEGAL_POLICY_ACTION"
  | "ROLLOUT_EVENT_CAP"
  | "CANCELLED";

export class SearchError extends Error {
  readonly code: SearchFailureCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: SearchFailureCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SearchError";
    this.code = code;
    this.details = details;
  }
}
