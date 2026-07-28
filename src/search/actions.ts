import { FULL_DECK, sortCards, type Card } from "../domain/cards";
import { SEATS, type OpponentSeat, type Seat } from "../domain/seats";
import type { CardPlayedEvent, HandTakenEvent } from "../events/game-events";
import type { PublicInformationState } from "../public/public-state";
import {
  legalCardsForExactHand,
  legalTakeTargets,
} from "../rules/legal-actions";
import type { UserAction } from "./types";

const CARD_ORDINAL = new Map(
  FULL_DECK.map((card, index) => [card, index] as const),
);

export function actionKey(action: UserAction): string {
  return action.kind === "play-card"
    ? `play:${action.card}`
    : `take:${action.target}`;
}

export function compareUserActions(
  left: UserAction,
  right: UserAction,
): number {
  if (left.kind !== right.kind) {
    return left.kind === "play-card" ? -1 : 1;
  }
  if (left.kind === "play-card" && right.kind === "play-card") {
    return (
      (CARD_ORDINAL.get(left.card) ?? Number.MAX_SAFE_INTEGER) -
      (CARD_ORDINAL.get(right.card) ?? Number.MAX_SAFE_INTEGER)
    );
  }
  if (left.kind === "take-hand" && right.kind === "take-hand") {
    return SEATS.indexOf(left.target) - SEATS.indexOf(right.target);
  }
  return 0;
}

export function legalUserActions(state: PublicInformationState): UserAction[] {
  const cards = sortCards(
    legalCardsForExactHand(state, "user", state.userHand),
  ).map((card): UserAction => ({
    kind: "play-card",
    card,
  }));
  const takes = legalTakeTargets(state, "user")
    .filter(
      (target): target is OpponentSeat => target === "p2" || target === "p3",
    )
    .map((target): UserAction => ({
      kind: "take-hand",
      target,
    }));
  return [...cards, ...takes].sort(compareUserActions);
}

export function actionEvent(
  action: UserAction,
  exactHands: Readonly<Record<Seat, readonly Card[]>>,
): CardPlayedEvent | HandTakenEvent {
  if (action.kind === "play-card") {
    return {
      type: "card-played" as const,
      schemaVersion: 1 as const,
      seat: "user" as const,
      card: action.card,
    };
  }
  return {
    type: "hand-taken" as const,
    schemaVersion: 1 as const,
    actor: "user" as const,
    target: action.target,
    revealedCards: [...exactHands[action.target]],
  };
}
