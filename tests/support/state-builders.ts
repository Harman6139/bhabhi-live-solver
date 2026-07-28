import { FULL_DECK, sortCards, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { SEATS, orderedSeatsFrom, type Seat } from "../../src/domain/seats";
import type { GameCreatedEvent } from "../../src/events/game-events";
import type { PublicInformationState } from "../../src/public/public-state";
import { assertPublicStateInvariant } from "../../src/rules/state-invariant";

export function createdEventWithUserHand(
  userHand: readonly Card[],
  aceSpadesHolder: Seat,
  rules: RuleConfig = CANONICAL_RULES,
): GameCreatedEvent {
  const userCount = userHand.length;
  const remainingCounts =
    userCount === 18 ? ([17, 17] as const) : ([18, 17] as const);
  return {
    type: "game-created",
    schemaVersion: 1,
    rules,
    userHand,
    startingCounts: {
      user: userCount,
      p2: remainingCounts[0],
      p3: remainingCounts[1],
    },
    aceSpadesHolder,
  };
}

export function userHandIncluding(
  required: readonly Card[],
  size: 17 | 18 = 18,
): Card[] {
  const selected = [...required];
  for (const card of FULL_DECK) {
    if (selected.length >= size) {
      break;
    }
    if (!selected.includes(card)) {
      selected.push(card);
    }
  }
  return sortCards(selected);
}

export type ExactStateOptions = {
  readonly hands: Readonly<Record<Seat, readonly Card[]>>;
  readonly activeSeats?: readonly Seat[];
  readonly power?: Seat;
  readonly rules?: RuleConfig;
  readonly waste?: readonly Card[];
  readonly forcedLeadCard?: Card | null;
  readonly shootoutForcedLead?: boolean;
};

export function makeExactPublicState(
  options: ExactStateOptions,
): PublicInformationState {
  const rules = options.rules ?? CANONICAL_RULES;
  const activeSeats = [...(options.activeSeats ?? SEATS)];
  const power = options.power ?? activeSeats[0];
  if (power === undefined) {
    throw new Error("Test state requires a power holder.");
  }
  const handCards = SEATS.flatMap((seat) => options.hands[seat]);
  const waste =
    options.waste ?? FULL_DECK.filter((card) => !handCards.includes(card));
  const all = [...handCards, ...waste];
  expectUniqueFullDeck(all);

  const state: PublicInformationState = {
    schemaVersion: 1,
    rules: structuredClone(rules),
    startingCounts: { user: 18, p2: 17, p3: 17 },
    phase: "normal",
    status: "active",
    handCounts: {
      user: options.hands.user.length,
      p2: options.hands.p2.length,
      p3: options.hands.p3.length,
    },
    userHand: sortCards(options.hands.user),
    knownOpponentCards: {
      p2: sortCards(options.hands.p2),
      p3: sortCards(options.hands.p3),
    },
    unresolvedCards: [],
    trick: {
      kind: "normal",
      leader: power,
      leadSuit: null,
      participants: orderedSeatsFrom(power, rules.direction, activeSeats),
      startedHeadsUp: activeSeats.length === 2,
      forcedLeadCard: options.forcedLeadCard ?? null,
      shootoutForcedLead: options.shootoutForcedLead ?? false,
      plays: [],
    },
    waste: [...waste],
    pendingAction: null,
    power,
    turn: power,
    activeSeats,
    escapeGroups: SEATS.filter((seat) => !activeSeats.includes(seat)).map(
      (seat) => ({
        seats: [seat],
        eventIndex: -1,
        reason: "empty-hand" as const,
      }),
    ),
    bhabhi: null,
    effects: [],
    appliedEventCount: 0,
  };
  assertPublicStateInvariant(state);
  return state;
}

function expectUniqueFullDeck(cards: readonly Card[]): void {
  const set = new Set(cards);
  if (
    set.size !== FULL_DECK.length ||
    cards.length !== FULL_DECK.length ||
    !FULL_DECK.every((card) => set.has(card))
  ) {
    throw new Error("Test fixture does not partition the full deck.");
  }
}

export function playEvent(seat: Seat, card: Card) {
  return {
    type: "card-played" as const,
    schemaVersion: 1 as const,
    seat,
    card,
  };
}
