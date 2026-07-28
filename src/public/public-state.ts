import type { Card, Suit } from "../domain/cards";
import type { RuleConfig } from "../domain/rule-config";
import type { OpponentSeat, Seat } from "../domain/seats";
import type { StartingCounts } from "../events/game-events";

export type GamePhase = "opening" | "normal";
export type GameStatus = "active" | "complete";

export type TrickPlay = {
  readonly seat: Seat;
  readonly card: Card;
  readonly offSuit: boolean;
  readonly eventIndex: number;
};

export type TrickState = {
  readonly kind: GamePhase;
  readonly leader: Seat;
  leadSuit: Suit | null;
  readonly participants: Seat[];
  readonly startedHeadsUp: boolean;
  readonly forcedLeadCard: Card | null;
  readonly shootoutForcedLead: boolean;
  plays: TrickPlay[];
};

export type PendingRuleAction =
  | {
      readonly kind: "waste-draw";
      readonly player: Seat;
      readonly excludedTrick: Card[];
      readonly reason: "zero-power" | "pagat-shootout";
    }
  | {
      readonly kind: "player-draw";
      readonly player: Seat;
      readonly source: Seat;
      readonly excludedTrick: Card[];
      readonly reason: "zero-power";
    };

export type EscapeGroup = {
  readonly seats: Seat[];
  readonly eventIndex: number;
  readonly reason:
    "empty-hand" | "immediate-zero-power" | "take-hand" | "shootout-safe";
};

export type RuleEffect =
  | {
      readonly type: "card-played";
      readonly eventIndex: number;
      readonly seat: Seat;
      readonly card: Card;
      readonly offSuit: boolean;
    }
  | {
      readonly type: "thulla";
      readonly eventIndex: number;
      readonly seat: Seat;
      readonly leadSuit: Suit;
    }
  | {
      readonly type: "trick-wasted";
      readonly eventIndex: number;
      readonly cards: Card[];
      readonly power: Seat;
    }
  | {
      readonly type: "trick-picked-up";
      readonly eventIndex: number;
      readonly cards: Card[];
      readonly picker: Seat;
      readonly thullaBy: Seat;
    }
  | {
      readonly type: "power-changed";
      readonly eventIndex: number;
      readonly power: Seat;
    }
  | {
      readonly type: "players-escaped";
      readonly eventIndex: number;
      readonly seats: Seat[];
      readonly reason: EscapeGroup["reason"];
    }
  | {
      readonly type: "draw-required";
      readonly eventIndex: number;
      readonly player: Seat;
      readonly source: "waste" | Seat;
    }
  | {
      readonly type: "hand-taken";
      readonly eventIndex: number;
      readonly actor: Seat;
      readonly target: Seat;
      readonly count: number;
    }
  | {
      readonly type: "game-completed";
      readonly eventIndex: number;
      readonly bhabhi: Seat;
      readonly reason:
        | "last-active"
        | "pagat-higher-response"
        | "pagat-lower-last-response"
        | "pagat-off-suit-response"
        | "simplified-thulla";
    };

export type PublicInformationState = {
  readonly schemaVersion: 1;
  readonly rules: RuleConfig;
  readonly startingCounts: StartingCounts;
  phase: GamePhase;
  status: GameStatus;
  handCounts: Record<Seat, number>;
  userHand: Card[];
  knownOpponentCards: Record<OpponentSeat, Card[]>;
  unresolvedCards: Card[];
  trick: TrickState | null;
  waste: Card[];
  pendingAction: PendingRuleAction | null;
  power: Seat | null;
  turn: Seat | null;
  activeSeats: Seat[];
  escapeGroups: EscapeGroup[];
  bhabhi: Seat | null;
  effects: RuleEffect[];
  appliedEventCount: number;
};

export function cardsInPendingAction(
  pendingAction: PendingRuleAction | null,
): readonly Card[] {
  return pendingAction?.excludedTrick ?? [];
}
