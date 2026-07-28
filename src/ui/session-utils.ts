import { FULL_DECK, parseCard, sortCards, type Card } from "../domain/cards";
import type { Seat } from "../domain/seats";
import {
  type CardPlayedEvent,
  type GameEvent,
  type HandTakenEvent,
  type PlayerCardDrawnEvent,
  type WasteCardDrawnEvent,
} from "../events/game-events";
import type { PublicInformationState } from "../public/public-state";
import { legalTakeTargets } from "../rules/legal-actions";
import { applyGameEvent } from "../rules/reducer";

export function seatLabel(seat: Seat): string {
  switch (seat) {
    case "user":
      return "You";
    case "p2":
      return "Player 2";
    case "p3":
      return "Player 3";
  }
}

export function parseCardList(value: string): Card[] {
  const tokens = value
    .trim()
    .split(/[\s,;|/]+/)
    .filter((token) => token.length > 0);
  const cards = tokens.map(parseCard);
  if (new Set(cards).size !== cards.length) {
    throw new Error("The card list contains a duplicate.");
  }
  return sortCards(cards);
}

function canApplyCardEvent(
  state: PublicInformationState,
  event: CardPlayedEvent | WasteCardDrawnEvent | PlayerCardDrawnEvent,
): boolean {
  try {
    applyGameEvent(state, event);
    return true;
  } catch {
    return false;
  }
}

export function availablePlayCards(state: PublicInformationState): Card[] {
  const seat = state.turn;
  if (
    seat === null ||
    state.status !== "active" ||
    state.pendingAction !== null ||
    state.trick === null
  ) {
    return [];
  }

  const candidates =
    seat === "user"
      ? state.userHand
      : state.knownOpponentCards[seat].length === state.handCounts[seat]
        ? state.knownOpponentCards[seat]
        : [...state.knownOpponentCards[seat], ...state.unresolvedCards];
  return sortCards(
    candidates.filter((card) =>
      canApplyCardEvent(state, {
        type: "card-played",
        schemaVersion: 1,
        seat,
        card,
      }),
    ),
  );
}

export function availablePendingCards(state: PublicInformationState): Card[] {
  const pending = state.pendingAction;
  if (pending === null) {
    return [];
  }
  if (pending.kind === "waste-draw") {
    return sortCards(state.waste);
  }

  const source = pending.source;
  const candidates =
    source === "user"
      ? state.userHand
      : state.knownOpponentCards[source].length === state.handCounts[source]
        ? state.knownOpponentCards[source]
        : [...state.knownOpponentCards[source], ...state.unresolvedCards];
  return sortCards(
    candidates.filter((card) =>
      canApplyCardEvent(state, {
        type: "player-card-drawn",
        schemaVersion: 1,
        seat: pending.player,
        source,
        card,
      }),
    ),
  );
}

export function eventForCardEntry(
  state: PublicInformationState,
  card: Card,
): CardPlayedEvent | WasteCardDrawnEvent | PlayerCardDrawnEvent {
  const pending = state.pendingAction;
  if (pending?.kind === "waste-draw") {
    return {
      type: "waste-card-drawn",
      schemaVersion: 1,
      seat: pending.player,
      card,
    };
  }
  if (pending?.kind === "player-draw") {
    return {
      type: "player-card-drawn",
      schemaVersion: 1,
      seat: pending.player,
      source: pending.source,
      card,
    };
  }
  if (state.turn === null) {
    throw new Error("There is no active turn.");
  }
  return {
    type: "card-played",
    schemaVersion: 1,
    seat: state.turn,
    card,
  };
}

export function takeTargets(state: PublicInformationState): Seat[] {
  return legalTakeTargets(state);
}

export function makeHandTakenEvent(
  state: PublicInformationState,
  target: Seat,
  revealedCards: readonly Card[],
): HandTakenEvent {
  const actor = state.turn;
  if (actor === null) {
    throw new Error("There is no active actor.");
  }
  return {
    type: "hand-taken",
    schemaVersion: 1,
    actor,
    target,
    revealedCards: target === "user" ? [...state.userHand] : [...revealedCards],
  };
}

export function eventLabel(event: GameEvent): string {
  switch (event.type) {
    case "game-created":
      return `Game created · ${event.startingCounts.user}/${event.startingCounts.p2}/${event.startingCounts.p3} cards`;
    case "card-played":
      return `${seatLabel(event.seat)} played ${event.card}`;
    case "waste-card-drawn":
      return `${seatLabel(event.seat)} drew ${event.card} from waste`;
    case "player-card-drawn":
      return `${seatLabel(event.seat)} drew ${event.card} from ${seatLabel(event.source)}`;
    case "hand-taken":
      return `${seatLabel(event.actor)} took ${seatLabel(event.target)}'s hand`;
  }
}

export function visibleCardPool(
  state: PublicInformationState,
): readonly Card[] {
  return FULL_DECK.filter(
    (card) =>
      state.userHand.includes(card) ||
      state.knownOpponentCards.p2.includes(card) ||
      state.knownOpponentCards.p3.includes(card) ||
      state.unresolvedCards.includes(card) ||
      state.waste.includes(card) ||
      (state.trick?.plays.some((play) => play.card === card) ?? false) ||
      (state.pendingAction?.excludedTrick.includes(card) ?? false),
  );
}
