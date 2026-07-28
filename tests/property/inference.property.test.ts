import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ACE_OF_SPADES, FULL_DECK, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { SEATS, type Seat } from "../../src/domain/seats";
import type { GameCreatedEvent, GameEvent } from "../../src/events/game-events";
import { appendTimelineEvent, createTimeline } from "../../src/events/timeline";
import { buildHardBelief } from "../../src/inference/belief";
import { compileHardEvidence } from "../../src/inference/hard-evidence";
import { assertHiddenWorldInvariant } from "../../src/inference/hidden-world";
import {
  applyTruthCardPlay,
  applyTruthPlayerDraw,
  applyTruthWasteDraw,
  createSimulationTruth,
  legalTruthCards,
  type SimulationTruth,
} from "../../src/simulator/truth";

const INFERENCE_PROPERTY_RUNS = 32;
const INFERENCE_PROPERTY_SEED = 0x1f3e7e3;
const MAX_EVENTS = 24;

type ExactDeal = Readonly<Record<Seat, readonly Card[]>>;

const deckPermutationArbitrary = fc.shuffledSubarray([...FULL_DECK], {
  minLength: FULL_DECK.length,
  maxLength: FULL_DECK.length,
});

function dealFromPermutation(
  permutation: readonly Card[],
  eighteenSeatIndex: number,
): ExactDeal {
  const eighteenSeat = SEATS[eighteenSeatIndex];
  if (eighteenSeat === undefined) {
    throw new Error("Generated deal has an invalid 18-card seat.");
  }
  const deal: Record<Seat, Card[]> = { user: [], p2: [], p3: [] };
  let offset = 0;
  for (const seat of SEATS) {
    const count = seat === eighteenSeat ? 18 : 17;
    deal[seat] = permutation.slice(offset, offset + count);
    offset += count;
  }
  return deal;
}

function setupFor(deal: ExactDeal, rules: RuleConfig): GameCreatedEvent {
  const holder = SEATS.find((seat) => deal[seat].includes(ACE_OF_SPADES));
  if (holder === undefined) {
    throw new Error("Generated deal has no Ace of Spades.");
  }
  return {
    type: "game-created",
    schemaVersion: 1,
    rules,
    userHand: deal.user,
    startingCounts: {
      user: deal.user.length,
      p2: deal.p2.length,
      p3: deal.p3.length,
    },
    aceSpadesHolder: holder,
  };
}

function select<T>(values: readonly T[], selector: number): T {
  const value = values[selector % values.length];
  if (value === undefined) {
    throw new Error("Generated selector has no candidate value.");
  }
  return value;
}

function nextEvent(
  truth: SimulationTruth,
  selector: number,
): Exclude<GameEvent, GameCreatedEvent> | null {
  if (truth.publicState.status === "complete") {
    return null;
  }
  const pending = truth.publicState.pendingAction;
  if (pending?.kind === "waste-draw") {
    return {
      type: "waste-card-drawn",
      schemaVersion: 1,
      seat: pending.player,
      card: select(truth.publicState.waste, selector),
    };
  }
  if (pending?.kind === "player-draw") {
    return {
      type: "player-card-drawn",
      schemaVersion: 1,
      seat: pending.player,
      source: pending.source,
      card: select(truth.hands[pending.source], selector),
    };
  }
  const seat = truth.publicState.turn;
  if (seat === null) {
    return null;
  }
  return {
    type: "card-played",
    schemaVersion: 1,
    seat,
    card: select(legalTruthCards(truth, seat), selector),
  };
}

function applyTruthEvent(
  truth: SimulationTruth,
  event: Exclude<GameEvent, GameCreatedEvent>,
  eventIndex: number,
): SimulationTruth {
  switch (event.type) {
    case "card-played":
      return applyTruthCardPlay(truth, event, eventIndex);
    case "waste-card-drawn":
      return applyTruthWasteDraw(truth, event, eventIndex);
    case "player-card-drawn":
      return applyTruthPlayerDraw(truth, event, eventIndex);
    case "hand-taken":
      throw new Error("Canonical property histories cannot take hands.");
  }
}

describe("hard-inference properties", () => {
  it("never eliminates the legal concrete deal and generates only valid worlds", () => {
    fc.assert(
      fc.property(
        deckPermutationArbitrary,
        fc.integer({ min: 0, max: SEATS.length - 1 }),
        fc.constantFrom("clockwise", "anticlockwise"),
        fc.array(fc.nat(), { minLength: 1, maxLength: MAX_EVENTS }),
        (permutation, eighteenSeatIndex, direction, selectors) => {
          const initialDeal = dealFromPermutation(
            permutation,
            eighteenSeatIndex,
          );
          const rules: RuleConfig = { ...CANONICAL_RULES, direction };
          const setup = setupFor(initialDeal, rules);
          let truth = createSimulationTruth(initialDeal, rules);
          let timeline = createTimeline(setup);

          for (const selector of selectors) {
            const event = nextEvent(truth, selector);
            if (event === null) {
              break;
            }
            truth = applyTruthEvent(truth, event, timeline.cursor);
            timeline = appendTimelineEvent(timeline, event);
            const evidence = compileHardEvidence(timeline);
            for (const constraint of evidence.hiddenCards) {
              const owner = initialDeal.p2.includes(constraint.card)
                ? "p2"
                : "p3";
              expect(constraint.origins[owner].allowed).toBe(true);
            }
          }

          const belief = buildHardBelief(timeline, {
            seed: "inference-property",
            sampleCount: 12,
            forceSampling: true,
          });
          for (const world of belief.worlds) {
            assertHiddenWorldInvariant(world, belief.evidence);
          }
        },
      ),
      {
        numRuns: INFERENCE_PROPERTY_RUNS,
        seed: INFERENCE_PROPERTY_SEED,
      },
    );
  });
});
