import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ACE_OF_SPADES, FULL_DECK, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { SEATS, type Seat } from "../../src/domain/seats";
import type {
  CardPlayedEvent,
  GameCreatedEvent,
  GameEvent,
} from "../../src/events/game-events";
import {
  appendTimelineEvent,
  createTimeline,
  replayEvents,
  replayTimeline,
  semanticHistoryHash,
} from "../../src/events/timeline";
import {
  cardsInPendingAction,
  type PublicInformationState,
} from "../../src/public/public-state";
import { legalCardsForExactHand } from "../../src/rules/legal-actions";
import {
  applyGameEvent,
  createInitialPublicState,
} from "../../src/rules/reducer";
import { assertPublicStateInvariant } from "../../src/rules/state-invariant";

const DEAL_RUNS = 128;
const DEAL_SEED = 0x5eedc0de;
const REPLAY_RUNS = 64;
const REPLAY_SEED = 0x1a2b3c4d;
const MAX_PREFIX_EVENTS = 30;

type ExactHands = Record<Seat, Card[]>;

const deckPermutationArbitrary = fc.shuffledSubarray([...FULL_DECK], {
  minLength: FULL_DECK.length,
  maxLength: FULL_DECK.length,
});

function dealPermutation(
  permutation: readonly Card[],
  eighteenCardSeatIndex: number,
): ExactHands {
  const eighteenCardSeat = SEATS[eighteenCardSeatIndex];
  if (eighteenCardSeat === undefined) {
    throw new Error(
      `Invalid 18-card seat index ${eighteenCardSeatIndex.toString()}.`,
    );
  }

  const hands: ExactHands = {
    user: [],
    p2: [],
    p3: [],
  };
  let offset = 0;
  for (const seat of SEATS) {
    const count = seat === eighteenCardSeat ? 18 : 17;
    hands[seat] = permutation.slice(offset, offset + count);
    offset += count;
  }
  return hands;
}

function aceSpadesHolder(hands: ExactHands): Seat {
  const holder = SEATS.find((seat) => hands[seat].includes(ACE_OF_SPADES));
  if (holder === undefined) {
    throw new Error("Generated deal does not contain the Ace of Spades.");
  }
  return holder;
}

function gameCreatedEvent(
  hands: ExactHands,
  rules: RuleConfig,
): GameCreatedEvent {
  return {
    type: "game-created",
    schemaVersion: 1,
    rules,
    userHand: [...hands.user],
    startingCounts: {
      user: hands.user.length,
      p2: hands.p2.length,
      p3: hands.p3.length,
    },
    aceSpadesHolder: aceSpadesHolder(hands),
  };
}

function expectFullDeckPartition(locations: readonly Card[]): void {
  expect(locations).toHaveLength(FULL_DECK.length);
  expect(new Set(locations)).toHaveLength(FULL_DECK.length);
  expect(new Set(locations)).toEqual(new Set(FULL_DECK));
}

function expectTruthConserved(
  hands: ExactHands,
  state: PublicInformationState,
): void {
  const locatedCards = [
    ...SEATS.flatMap((seat) => hands[seat]),
    ...(state.trick?.plays.map((play) => play.card) ?? []),
    ...state.waste,
    ...cardsInPendingAction(state.pendingAction),
  ];
  expectFullDeckPartition(locatedCards);
  for (const seat of SEATS) {
    expect(hands[seat]).toHaveLength(state.handCounts[seat]);
  }
  assertPublicStateInvariant(state);
}

function removeExactCard(hand: Card[], card: Card): void {
  const index = hand.indexOf(card);
  if (index === -1) {
    throw new Error(`Generated exact hand does not contain ${card}.`);
  }
  hand.splice(index, 1);
}

function updateExactHandsAfterPlay(
  hands: ExactHands,
  previousEffectCount: number,
  state: PublicInformationState,
): void {
  for (const effect of state.effects.slice(previousEffectCount)) {
    if (effect.type === "trick-picked-up") {
      hands[effect.picker].push(...effect.cards);
    }
  }
}

function generatedCardEvent(
  state: PublicInformationState,
  hands: ExactHands,
  selector: number,
): CardPlayedEvent | null {
  if (
    state.status !== "active" ||
    state.pendingAction !== null ||
    state.turn === null
  ) {
    return null;
  }
  const seat = state.turn;
  const legalCards = legalCardsForExactHand(state, seat, hands[seat]);
  if (legalCards.length === 0) {
    throw new Error(`Generated exact state has no legal card for ${seat}.`);
  }
  const card = legalCards[selector % legalCards.length];
  if (card === undefined) {
    throw new Error("Generated legal-card selector was out of range.");
  }
  return {
    type: "card-played",
    schemaVersion: 1,
    seat,
    card,
  };
}

describe("rules properties", () => {
  it("partitions every generated deck permutation into a conserved 18/17/17 deal", () => {
    fc.assert(
      fc.property(
        deckPermutationArbitrary,
        fc.integer({ min: 0, max: SEATS.length - 1 }),
        (permutation, eighteenCardSeatIndex) => {
          expectFullDeckPartition(permutation);

          const hands = dealPermutation(permutation, eighteenCardSeatIndex);
          expect(SEATS.map((seat) => hands[seat].length).sort()).toEqual([
            17, 17, 18,
          ]);
          expectFullDeckPartition(SEATS.flatMap((seat) => hands[seat]));
          expect(
            SEATS.filter((seat) => hands[seat].includes(ACE_OF_SPADES)),
          ).toHaveLength(1);

          const state = createInitialPublicState(
            gameCreatedEvent(hands, CANONICAL_RULES),
          );
          expectTruthConserved(hands, state);
        },
      ),
      { numRuns: DEAL_RUNS, seed: DEAL_SEED },
    );
  });

  it("replays generated legal prefixes identically to immutable incremental reduction", () => {
    fc.assert(
      fc.property(
        deckPermutationArbitrary,
        fc.integer({ min: 0, max: SEATS.length - 1 }),
        fc.constantFrom("clockwise", "anticlockwise"),
        fc.array(fc.nat(), { maxLength: MAX_PREFIX_EVENTS }),
        (permutation, eighteenCardSeatIndex, direction, selectors) => {
          const hands = dealPermutation(permutation, eighteenCardSeatIndex);
          const rules: RuleConfig = {
            ...CANONICAL_RULES,
            direction,
          };
          const created = gameCreatedEvent(hands, rules);
          const events: GameEvent[] = [created];
          let incrementalState = createInitialPublicState(created);
          let timeline = createTimeline(created);

          expectTruthConserved(hands, incrementalState);
          expect(replayTimeline(timeline).state).toEqual(incrementalState);

          for (const selector of selectors) {
            const event = generatedCardEvent(incrementalState, hands, selector);
            if (event === null) {
              break;
            }

            const stateBefore = structuredClone(incrementalState);
            const effectsBefore = incrementalState.effects.length;
            const firstReduction = applyGameEvent(incrementalState, event);
            const secondReduction = applyGameEvent(
              structuredClone(incrementalState),
              structuredClone(event),
            );

            expect(incrementalState).toEqual(stateBefore);
            expect(secondReduction).toEqual(firstReduction);

            removeExactCard(hands[event.seat], event.card);
            updateExactHandsAfterPlay(hands, effectsBefore, firstReduction);
            incrementalState = firstReduction;
            events.push(event);
            timeline = appendTimelineEvent(timeline, event);

            const replayedEvents = replayEvents(events);
            const replayedTimeline = replayTimeline(timeline);
            expect(replayedEvents.state).toEqual(incrementalState);
            expect(replayedTimeline.state).toEqual(incrementalState);
            expect(replayedEvents.semanticHash).toBe(
              semanticHistoryHash(events),
            );
            expect(replayedTimeline.semanticHash).toBe(
              replayedEvents.semanticHash,
            );
            expectTruthConserved(hands, incrementalState);
          }

          const finalReplay = replayEvents(structuredClone(events));
          expect(finalReplay.state).toEqual(incrementalState);
          expect(finalReplay.semanticHash).toBe(semanticHistoryHash(events));
        },
      ),
      { numRuns: REPLAY_RUNS, seed: REPLAY_SEED },
    );
  });
});
