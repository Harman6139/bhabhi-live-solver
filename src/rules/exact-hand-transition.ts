import {
  ACE_OF_SPADES,
  FULL_DECK,
  assertUniqueCards,
  sortCards,
  type Card,
} from "../domain/cards";
import type { RuleConfig } from "../domain/rule-config";
import { SEATS, type Seat } from "../domain/seats";
import type {
  CardPlayedEvent,
  GameCreatedEvent,
  GameEvent,
  HandTakenEvent,
  PlayerCardDrawnEvent,
  WasteCardDrawnEvent,
} from "../events/game-events";
import {
  cardsInPendingAction,
  type PublicInformationState,
} from "../public/public-state";
import { legalCardsForExactHand } from "./legal-actions";
import { RuleViolation } from "./rule-error";
import { applyGameEvent, createInitialPublicState } from "./reducer";
import { assertPublicStateInvariant } from "./state-invariant";

export type ExactHands = Record<Seat, Card[]>;

/**
 * A rules-layer position whose three hands are all known exactly.
 *
 * This type deliberately has no simulator, search, or inference semantics. It
 * is the common transition boundary for any caller that legitimately owns a
 * complete concrete deal.
 */
export type ExactHandState = {
  publicState: PublicInformationState;
  hands: ExactHands;
};

export type ExactHandEvent = Exclude<GameEvent, GameCreatedEvent>;
export type ExactTransitionValidation = "full" | "trusted-input";

function failInvariant(message: string): never {
  throw new RuleViolation(
    "INVARIANT_VIOLATION",
    `Exact-hand invariant failed: ${message}`,
  );
}

function sameCardSet(left: readonly Card[], right: readonly Card[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((card) => rightSet.has(card));
}

function copyForTransition(state: ExactHandState): ExactHandState {
  return {
    // applyGameEvent returns a detached public state; keep the input by
    // reference until then instead of cloning this comparatively large tree
    // twice on every exact transition.
    publicState: state.publicState,
    hands: {
      user: [...state.hands.user],
      p2: [...state.hands.p2],
      p3: [...state.hands.p3],
    },
  };
}

function removeExactCard(
  state: ExactHandState,
  seat: Seat,
  card: Card,
  eventIndex?: number,
): void {
  const index = state.hands[seat].indexOf(card);
  if (index === -1) {
    throw new RuleViolation(
      "CARD_NOT_OWNED",
      `${seat} does not own ${card} in the exact-hand state.`,
      eventIndex,
    );
  }
  state.hands[seat].splice(index, 1);
}

function addExactCards(
  state: ExactHandState,
  seat: Seat,
  cards: readonly Card[],
): void {
  state.hands[seat].push(...cards);
  state.hands[seat] = sortCards(state.hands[seat]);
}

function asPublicTakeEvent(
  state: ExactHandState,
  event: HandTakenEvent,
): HandTakenEvent {
  const targetCards = state.hands[event.target];
  return {
    ...event,
    revealedCards:
      event.actor === "user" || event.target === "user"
        ? [...targetCards]
        : event.revealedCards,
  };
}

export function createExactHandState(
  handsValue: Readonly<Record<Seat, readonly Card[]>>,
  rules: RuleConfig,
): ExactHandState {
  const allCards = SEATS.flatMap((seat) => handsValue[seat]);
  assertUniqueCards(allCards, "concrete deal");
  if (
    allCards.length !== FULL_DECK.length ||
    !FULL_DECK.every((card) => allCards.includes(card))
  ) {
    throw new RuleViolation(
      "INVALID_SETUP",
      "Concrete deal must partition all 52 cards exactly once.",
    );
  }

  const aceSpadesHolder = SEATS.find((seat) =>
    handsValue[seat].includes(ACE_OF_SPADES),
  );
  if (aceSpadesHolder === undefined) {
    throw new RuleViolation("INVALID_SETUP", "Concrete deal has no A♠ holder.");
  }

  const created: GameCreatedEvent = {
    type: "game-created",
    schemaVersion: 1,
    rules,
    userHand: handsValue.user,
    startingCounts: {
      user: handsValue.user.length,
      p2: handsValue.p2.length,
      p3: handsValue.p3.length,
    },
    aceSpadesHolder,
  };
  const state: ExactHandState = {
    publicState: createInitialPublicState(created),
    hands: {
      user: sortCards(handsValue.user),
      p2: sortCards(handsValue.p2),
      p3: sortCards(handsValue.p3),
    },
  };
  assertExactHandStateInvariant(state);
  return state;
}

export function legalExactHandCards(
  state: ExactHandState,
  seat: Seat = state.publicState.turn ?? "user",
): Card[] {
  return legalCardsForExactHand(state.publicState, seat, state.hands[seat]);
}

export function applyExactHandCardPlay(
  inputState: ExactHandState,
  event: CardPlayedEvent,
  eventIndex = inputState.publicState.appliedEventCount,
  validation: ExactTransitionValidation = "full",
): ExactHandState {
  if (validation === "full") {
    assertExactHandStateInvariant(inputState);
  }
  const state = copyForTransition(inputState);
  const legal = legalExactHandCards(state, event.seat);
  if (!legal.includes(event.card)) {
    throw new RuleViolation(
      "MUST_FOLLOW_SUIT",
      `${event.card} is not legal for ${event.seat} in the exact-hand state.`,
      eventIndex,
    );
  }

  const priorEffectCount = state.publicState.effects.length;
  removeExactCard(state, event.seat, event.card, eventIndex);
  state.publicState = applyGameEvent(state.publicState, event, eventIndex);
  const pickup = state.publicState.effects
    .slice(priorEffectCount)
    .find((effect) => effect.type === "trick-picked-up");
  if (pickup?.type === "trick-picked-up") {
    addExactCards(state, pickup.picker, pickup.cards);
  }
  if (validation === "full") {
    assertExactHandOwnershipInvariant(state);
  }
  return state;
}

export function applyExactHandWasteDraw(
  inputState: ExactHandState,
  event: WasteCardDrawnEvent,
  eventIndex = inputState.publicState.appliedEventCount,
  validation: ExactTransitionValidation = "full",
): ExactHandState {
  if (validation === "full") {
    assertExactHandStateInvariant(inputState);
  }
  const state = copyForTransition(inputState);
  state.publicState = applyGameEvent(state.publicState, event, eventIndex);
  addExactCards(state, event.seat, [event.card]);
  if (validation === "full") {
    assertExactHandOwnershipInvariant(state);
  }
  return state;
}

export function applyExactHandPlayerDraw(
  inputState: ExactHandState,
  event: PlayerCardDrawnEvent,
  eventIndex = inputState.publicState.appliedEventCount,
  validation: ExactTransitionValidation = "full",
): ExactHandState {
  if (validation === "full") {
    assertExactHandStateInvariant(inputState);
  }
  const state = copyForTransition(inputState);
  removeExactCard(state, event.source, event.card, eventIndex);
  addExactCards(state, event.seat, [event.card]);
  state.publicState = applyGameEvent(state.publicState, event, eventIndex);
  if (validation === "full") {
    assertExactHandOwnershipInvariant(state);
  }
  return state;
}

export function applyExactHandTake(
  inputState: ExactHandState,
  event: HandTakenEvent,
  eventIndex = inputState.publicState.appliedEventCount,
  validation: ExactTransitionValidation = "full",
): ExactHandState {
  if (validation === "full") {
    assertExactHandStateInvariant(inputState);
  }
  const state = copyForTransition(inputState);
  const cards = [...state.hands[event.target]];
  const publicEvent = asPublicTakeEvent(state, event);
  const nextPublicState = applyGameEvent(
    state.publicState,
    publicEvent,
    eventIndex,
  );
  if (
    event.actor !== "user" &&
    event.target !== "user" &&
    event.revealedCards.length > 0 &&
    !sameCardSet(event.revealedCards, cards)
  ) {
    throw new RuleViolation(
      "CARD_NOT_OWNED",
      `The revealed cards are not ${event.target}'s exact hand.`,
      eventIndex,
    );
  }
  state.hands[event.target] = [];
  addExactCards(state, event.actor, cards);
  state.publicState = nextPublicState;
  if (validation === "full") {
    assertExactHandOwnershipInvariant(state);
  }
  return state;
}

export function applyExactHandEvent(
  state: ExactHandState,
  event: ExactHandEvent,
  eventIndex = state.publicState.appliedEventCount,
  validation: ExactTransitionValidation = "full",
): ExactHandState {
  switch (event.type) {
    case "card-played":
      return applyExactHandCardPlay(state, event, eventIndex, validation);
    case "waste-card-drawn":
      return applyExactHandWasteDraw(state, event, eventIndex, validation);
    case "player-card-drawn":
      return applyExactHandPlayerDraw(state, event, eventIndex, validation);
    case "hand-taken":
      return applyExactHandTake(state, event, eventIndex, validation);
  }
}

/**
 * Checks both representations and their cross-representation ownership facts.
 * Every one of the 52 cards must occupy exactly one concrete location.
 */
function assertExactHandOwnershipInvariant(state: ExactHandState): void {
  const publicState = state.publicState;
  const locations = [
    ...SEATS.flatMap((seat) =>
      state.hands[seat].map((card) => ({
        card,
        location: `hand:${seat}`,
      })),
    ),
    ...(publicState.trick?.plays.map((play) => ({
      card: play.card,
      location: "trick",
    })) ?? []),
    ...publicState.waste.map((card) => ({ card, location: "waste" })),
    ...cardsInPendingAction(publicState.pendingAction).map((card) => ({
      card,
      location: "pending",
    })),
  ];
  const seen = new Map<Card, string>();
  for (const { card, location } of locations) {
    const previous = seen.get(card);
    if (previous !== undefined) {
      failInvariant(`${card} appears in both ${previous} and ${location}.`);
    }
    seen.set(card, location);
  }
  if (
    seen.size !== FULL_DECK.length ||
    !FULL_DECK.every((card) => seen.has(card))
  ) {
    const missing = FULL_DECK.filter((card) => !seen.has(card));
    failInvariant(
      `expected all 52 cards exactly once, found ${seen.size}; missing ${missing.join(", ") || "none"}.`,
    );
  }

  for (const seat of SEATS) {
    const exactCount = state.hands[seat].length;
    const publicCount = publicState.handCounts[seat];
    if (exactCount !== publicCount) {
      failInvariant(
        `${seat} exact hand has ${exactCount} cards but public count is ${publicCount}.`,
      );
    }
  }

  if (!sameCardSet(state.hands.user, publicState.userHand)) {
    failInvariant("the user's public hand differs from the exact hand.");
  }

  for (const seat of ["p2", "p3"] as const) {
    const known = publicState.knownOpponentCards[seat];
    const exact = state.hands[seat];
    const misplaced = known.filter((card) => !exact.includes(card));
    if (misplaced.length > 0) {
      failInvariant(
        `cards known to belong to ${seat} are absent from its exact hand: ${misplaced.join(", ")}.`,
      );
    }
  }

  const unknownExactOpponentCards = (["p2", "p3"] as const).flatMap((seat) => {
    const known = new Set(publicState.knownOpponentCards[seat]);
    return state.hands[seat].filter((card) => !known.has(card));
  });
  if (!sameCardSet(unknownExactOpponentCards, publicState.unresolvedCards)) {
    failInvariant(
      "the unresolved public pool differs from the exact opponents' unknown cards.",
    );
  }
}

export function assertExactHandStateInvariant(state: ExactHandState): void {
  assertPublicStateInvariant(state.publicState);
  assertExactHandOwnershipInvariant(state);
}
