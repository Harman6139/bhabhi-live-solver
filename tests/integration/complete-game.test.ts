import { describe, expect, it } from "vitest";

import { FULL_DECK, type Card } from "../../src/domain/cards";
import { SEATS } from "../../src/domain/seats";
import type { GameCreatedEvent, GameEvent } from "../../src/events/game-events";
import { replayEvents } from "../../src/events/timeline";
import { cardsInPendingAction } from "../../src/public/public-state";
import { assertPublicStateInvariant } from "../../src/rules/state-invariant";
import {
  applyTruthCardPlay,
  applyTruthHandTaken,
  applyTruthPlayerDraw,
  applyTruthWasteDraw,
  assertSimulationTruthInvariant,
  createSimulationTruth,
  type SimulationTruth,
} from "../../src/simulator/truth";
import {
  COMPLETE_GAME_DEAL,
  COMPLETE_GAME_EVENTS,
  COMPLETE_GAME_FIXTURE,
  COMPLETE_GAME_MAX_EVENTS,
  COMPLETE_GAME_SETUP,
  generateCompleteGameFixture,
} from "../support/complete-game";

function applyEvent(
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
      return applyTruthHandTaken(truth, event, eventIndex);
  }
}

function expectFullDeck(cards: readonly Card[]): void {
  expect(cards).toHaveLength(FULL_DECK.length);
  expect(new Set(cards)).toHaveLength(FULL_DECK.length);
  expect(new Set(cards)).toEqual(new Set(FULL_DECK));
}

function expectTruthAndPublicConservation(truth: SimulationTruth): void {
  const state = truth.publicState;
  const truthLocations = [
    ...SEATS.flatMap((seat) => truth.hands[seat]),
    ...(state.trick?.plays.map((play) => play.card) ?? []),
    ...state.waste,
    ...cardsInPendingAction(state.pendingAction),
  ];
  expectFullDeck(truthLocations);

  const publicLocations = [
    ...state.userHand,
    ...state.knownOpponentCards.p2,
    ...state.knownOpponentCards.p3,
    ...state.unresolvedCards,
    ...(state.trick?.plays.map((play) => play.card) ?? []),
    ...state.waste,
    ...cardsInPendingAction(state.pendingAction),
  ];
  expectFullDeck(publicLocations);

  for (const seat of SEATS) {
    expect(truth.hands[seat]).toHaveLength(state.handCounts[seat]);
  }
  assertSimulationTruthInvariant(truth);
  assertPublicStateInvariant(state);
}

describe("deterministic canonical complete-game fixture", () => {
  it("uses a fixed complete 18/17/17 deal and generates byte-identical events", () => {
    expect(SEATS.map((seat) => COMPLETE_GAME_DEAL[seat].length)).toEqual([
      18, 17, 17,
    ]);
    expectFullDeck(SEATS.flatMap((seat) => COMPLETE_GAME_DEAL[seat]));
    expect(COMPLETE_GAME_SETUP.userHand).toEqual(COMPLETE_GAME_DEAL.user);

    const first = generateCompleteGameFixture();
    const second = generateCompleteGameFixture();
    expect(JSON.stringify(first.events)).toBe(JSON.stringify(second.events));
    expect(first).toEqual(second);
    expect(COMPLETE_GAME_EVENTS).toEqual(first.events);
  });

  it("conserves all 52 cards in concrete and public state at every prefix", () => {
    let truth = createSimulationTruth(
      COMPLETE_GAME_DEAL,
      COMPLETE_GAME_SETUP.rules,
    );
    expectTruthAndPublicConservation(truth);

    for (let index = 1; index < COMPLETE_GAME_EVENTS.length; index += 1) {
      const event = COMPLETE_GAME_EVENTS[index];
      if (event === undefined || event.type === "game-created") {
        throw new Error(`Fixture event ${index} is missing or invalid.`);
      }
      const pending = truth.publicState.pendingAction;
      if (pending?.kind === "waste-draw") {
        expect(event).toMatchObject({
          type: "waste-card-drawn",
          seat: pending.player,
        });
        if (event.type === "waste-card-drawn") {
          expect(truth.publicState.waste).toContain(event.card);
          expect(pending.excludedTrick).not.toContain(event.card);
        }
      } else if (pending?.kind === "player-draw") {
        expect(event).toMatchObject({
          type: "player-card-drawn",
          seat: pending.player,
          source: pending.source,
        });
        if (event.type === "player-card-drawn") {
          expect(truth.hands[pending.source]).toContain(event.card);
        }
      }
      truth = applyEvent(truth, event, index);
      expectTruthAndPublicConservation(truth);

      const replay = replayEvents(COMPLETE_GAME_EVENTS.slice(0, index + 1));
      expect(replay.state).toEqual(truth.publicState);
    }
  });

  it("terminates below the safety bound with exactly one named Bhabhi", () => {
    const { finalState, finalHands, events } = COMPLETE_GAME_FIXTURE;
    expect(events).toHaveLength(61);
    expect(events.length).toBeLessThan(COMPLETE_GAME_MAX_EVENTS);
    expect(finalState.status).toBe("complete");
    expect(finalState.bhabhi).toBe("user");
    expect(
      events.filter((event) => event.type === "waste-card-drawn"),
    ).toHaveLength(1);
    expect(finalState.activeSeats).toEqual([finalState.bhabhi]);
    expect(finalState.turn).toBeNull();
    expect(finalState.trick).toBeNull();
    expect(finalState.pendingAction).toBeNull();
    expect(
      finalState.bhabhi === null ? null : finalHands[finalState.bhabhi],
    ).not.toHaveLength(0);
    expect(
      finalState.effects.filter((effect) => effect.type === "game-completed"),
    ).toHaveLength(1);
    expect(replayEvents(events).state).toEqual(finalState);
  });
});
