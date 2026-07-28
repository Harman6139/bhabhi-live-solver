import type { Card, Suit } from "../domain/cards";
import type { RuleConfig } from "../domain/rule-config";
import type { OpponentSeat, Seat } from "../domain/seats";
import type { StartingCounts } from "../events/game-events";
import type { PublicInformationState } from "../public/public-state";

export const HARD_EVIDENCE_ALGORITHM_VERSION = "hard-evidence-v1" as const;
export const HARD_BELIEF_ALGORITHM_VERSION = "hard-belief-v1" as const;

export type SymbolicCardLocation = Seat | "trick" | "waste" | "pending";

export type EliminationCode =
  | "declared-ace-owner"
  | "observed-play-owner"
  | "follow-suit-void"
  | "opening-highest"
  | "draw-source"
  | "waste-source"
  | "revealed-card-owner"
  | "revealed-hand-omission";

export type OriginElimination = {
  readonly code: EliminationCode;
  readonly eventIndex: number;
  readonly initialOwner: OpponentSeat;
  readonly card: Card;
  readonly seat: Seat | null;
  readonly suit: Suit | null;
  readonly observedCard: Card | null;
};

export type OriginProjection = {
  readonly initialOwner: OpponentSeat;
  readonly allowed: boolean;
  readonly currentLocation: SymbolicCardLocation | null;
  readonly eliminatedBy: OriginElimination | null;
};

export type HiddenCardConstraint = {
  readonly card: Card;
  readonly origins: Readonly<Record<OpponentSeat, OriginProjection>>;
};

export type ChronologicalVoidObservation = {
  readonly eventIndex: number;
  readonly seat: Seat;
  readonly suit: Suit;
  readonly observedCard: Card;
  readonly kind: "opening-off-suit" | "normal-thulla";
};

export type HardSupportSummary = {
  readonly p2InitialSlots: number;
  readonly p3InitialSlots: number;
  readonly forcedP2: number;
  readonly forcedP3: number;
  readonly flexible: number;
  readonly totalWorldCount: string;
};

export type HardEvidence = {
  readonly schemaVersion: 1;
  readonly algorithmVersion: typeof HARD_EVIDENCE_ALGORITHM_VERSION;
  readonly historyHash: string;
  readonly activeEventCount: number;
  readonly rules: RuleConfig;
  readonly startingCounts: StartingCounts;
  readonly initialUserHand: readonly Card[];
  readonly hiddenCards: readonly HiddenCardConstraint[];
  readonly voidObservations: readonly ChronologicalVoidObservation[];
  readonly support: HardSupportSummary;
  readonly finalState: PublicInformationState;
};

export type HiddenWorld = {
  readonly schemaVersion: 1;
  readonly historyHash: string;
  readonly witnessId: string;
  readonly initialHands: Readonly<Record<OpponentSeat, readonly Card[]>>;
  readonly currentHands: Readonly<Record<Seat, readonly Card[]>>;
  readonly multiplicity: "1";
};

export type HardBeliefMethod = "exact-enumeration" | "direct-uniform-sample";

export type HardBeliefConfig = {
  readonly seed: string;
  readonly maxExactWorlds: number;
  readonly maxExactProjectionOperations: number;
  readonly maxExactEstimatedBytes: number;
  readonly sampleCount: number;
  readonly forceSampling: boolean;
};

export type HardBeliefDiagnostics = {
  readonly historyHash: string;
  readonly configHash: string;
  readonly seedId: string;
  readonly algorithmVersion: typeof HARD_BELIEF_ALGORITHM_VERSION;
  readonly method: HardBeliefMethod;
  readonly totalInitialDealWorlds: string;
  readonly exactEnumerationEligible: boolean;
  readonly estimatedExactProjectionOperations: string;
  readonly estimatedExactBytes: string;
  readonly generatedWorlds: number;
  readonly uniqueWitnesses: number;
  readonly distinctCurrentHands: number;
  readonly duplicateSamples: number;
  readonly forcedP2: number;
  readonly forcedP3: number;
  readonly flexible: number;
  readonly p2CurrentUnknownSlots: number;
  readonly p3CurrentUnknownSlots: number;
  readonly worldSetChecksum: string;
  readonly voidObservations: readonly ChronologicalVoidObservation[];
};

export type HardBelief = {
  readonly schemaVersion: 1;
  readonly method: HardBeliefMethod;
  readonly evidence: HardEvidence;
  readonly worlds: readonly HiddenWorld[];
  readonly diagnostics: HardBeliefDiagnostics;
};

export type ExactProbability = {
  readonly quality: "exact";
  readonly numerator: string;
  readonly denominator: string;
  readonly value: number;
};

export type SuitStatus = "known-has" | "known-void" | "unknown";

export type SuitLengthProbability = ExactProbability & {
  readonly length: number;
};

export type SuitLengthDistribution = {
  readonly seat: Seat;
  readonly suit: Suit;
  readonly status: SuitStatus;
  readonly expectedLength: number;
  readonly probabilities: readonly SuitLengthProbability[];
};

export type WorldPredicateEstimate = {
  readonly quality: "exact" | "sample";
  readonly successes: number;
  readonly trials: number;
  readonly value: number;
};
