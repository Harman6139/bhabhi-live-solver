import { describe, expect, it } from "vitest";

import { ACE_OF_SPADES } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { SEATS } from "../../src/domain/seats";
import type {
  CardPlayedEvent,
  HandTakenEvent,
  PlayerCardDrawnEvent,
} from "../../src/events/game-events";
import { legalTakeTargets } from "../../src/rules/legal-actions";
import {
  applyExactHandCardPlay,
  applyExactHandEvent,
  applyExactHandPlayerDraw,
  applyExactHandTake,
  assertExactHandStateInvariant,
  createExactHandState,
  legalExactHandCards,
  type ExactHandState,
} from "../../src/rules/exact-hand-transition";
import { RuleViolation } from "../../src/rules/rule-error";
import {
  COMPLETE_GAME_DEAL,
  COMPLETE_GAME_EVENTS,
  COMPLETE_GAME_FIXTURE,
} from "../support/complete-game";

function applyOpening(state: ExactHandState): ExactHandState {
  let next = state;
  while (next.publicState.phase === "opening") {
    const seat = next.publicState.turn;
    if (seat === null) {
      throw new Error("Opening state has no actor.");
    }
    const card = legalExactHandCards(next, seat)[0];
    if (card === undefined) {
      throw new Error(`Opening state has no legal card for ${seat}.`);
    }
    next = applyExactHandCardPlay(next, {
      type: "card-played",
      schemaVersion: 1,
      seat,
      card,
    });
  }
  return next;
}

describe("exact-hand transition boundary", () => {
  it("creates a detached 52-card position and exposes exact legal cards", () => {
    const deal = {
      user: [...COMPLETE_GAME_DEAL.user],
      p2: [...COMPLETE_GAME_DEAL.p2],
      p3: [...COMPLETE_GAME_DEAL.p3],
    };
    const state = createExactHandState(deal, CANONICAL_RULES);
    const holder = SEATS.find((seat) => deal[seat].includes(ACE_OF_SPADES));

    expect(holder).toBe("p3");
    expect(state.publicState.turn).toBe(holder);
    expect(legalExactHandCards(state, holder)).toEqual([ACE_OF_SPADES]);
    expect(() => assertExactHandStateInvariant(state)).not.toThrow();

    deal.p3.splice(0, deal.p3.length);
    expect(state.hands.p3).toHaveLength(17);
  });

  it("replays every card play and waste draw in the canonical complete game immutably", () => {
    let state = createExactHandState(COMPLETE_GAME_DEAL, CANONICAL_RULES);
    let wasteDraws = 0;

    for (let index = 1; index < COMPLETE_GAME_EVENTS.length; index += 1) {
      const event = COMPLETE_GAME_EVENTS[index];
      if (event === undefined || event.type === "game-created") {
        throw new Error(`Missing concrete event ${index.toString()}.`);
      }
      const input = state;
      const before = structuredClone(input);
      if (event.type === "waste-card-drawn") {
        wasteDraws += 1;
        expect(state.publicState.waste).toContain(event.card);
      }

      state = applyExactHandEvent(input, event, index);
      expect(input).toEqual(before);
      expect(() => assertExactHandStateInvariant(state)).not.toThrow();
    }

    expect(wasteDraws).toBe(1);
    expect(state.publicState).toEqual(COMPLETE_GAME_FIXTURE.finalState);
    expect(state.hands).toEqual(COMPLETE_GAME_FIXTURE.finalHands);
  });

  it("moves a pending draw card between exact player hands", () => {
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      twoPlayer: "normal",
      zeroCardsWithPower: {
        mode: "draw-from-player",
        drawFromTarget: "next-active",
        configuredTarget: null,
      },
    };
    let state = createExactHandState(COMPLETE_GAME_DEAL, rules);
    let appliedDraw: PlayerCardDrawnEvent | null = null;

    for (let index = 1; index < COMPLETE_GAME_EVENTS.length; index += 1) {
      const fixtureEvent = COMPLETE_GAME_EVENTS[index];
      if (fixtureEvent === undefined || fixtureEvent.type === "game-created") {
        throw new Error(`Missing concrete event ${index.toString()}.`);
      }
      const pending = state.publicState.pendingAction;
      if (pending?.kind === "player-draw") {
        const card = state.hands[pending.source][0];
        if (card === undefined) {
          throw new Error("Pending player-draw source has no card.");
        }
        appliedDraw = {
          type: "player-card-drawn",
          schemaVersion: 1,
          seat: pending.player,
          source: pending.source,
          card,
        };
        const sourceBefore = state.hands[pending.source].length;
        const recipientBefore = state.hands[pending.player].length;
        state = applyExactHandPlayerDraw(state, appliedDraw, index);
        expect(state.hands[pending.source]).toHaveLength(sourceBefore - 1);
        expect(state.hands[pending.player]).toHaveLength(recipientBefore + 1);
        expect(state.publicState.trick?.forcedLeadCard).toBe(card);
        break;
      }
      if (fixtureEvent.type !== "card-played") {
        throw new Error(
          "The concrete fixture diverged before the first pending draw.",
        );
      }
      state = applyExactHandCardPlay(state, fixtureEvent, index);
    }

    expect(appliedDraw).not.toBeNull();
    expect(() => assertExactHandStateInvariant(state)).not.toThrow();
  });

  it("transfers a hidden opponent hand exactly while preserving public hiding", () => {
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      takeHand: {
        mode: "configured",
        configuredTargets: ["p2"],
      },
    };
    const state = applyOpening(createExactHandState(COMPLETE_GAME_DEAL, rules));
    expect(state.publicState.turn).toBe("p3");
    expect(legalTakeTargets(state.publicState, "p3")).toEqual(["p2"]);

    const event: HandTakenEvent = {
      type: "hand-taken",
      schemaVersion: 1,
      actor: "p3",
      target: "p2",
      revealedCards: [],
    };
    const before = structuredClone(state);
    const actorBefore = [...state.hands.p3];
    const targetBefore = [...state.hands.p2];
    const falselyRevealedCard = actorBefore[0];
    if (falselyRevealedCard === undefined) {
      throw new Error("Fixture actor hand is unexpectedly empty.");
    }
    const falseReveal = [...targetBefore];
    falseReveal.splice(0, 1, falselyRevealedCard);
    expect(() =>
      applyExactHandTake(state, { ...event, revealedCards: falseReveal }),
    ).toThrow(/not p2's exact hand/);

    const next = applyExactHandTake(state, event);

    expect(state).toEqual(before);
    expect(next.hands.p2).toEqual([]);
    expect(new Set(next.hands.p3)).toEqual(
      new Set([...actorBefore, ...targetBefore]),
    );
    expect(next.publicState.knownOpponentCards.p3).not.toEqual(next.hands.p3);
    expect(next.publicState.activeSeats).not.toContain("p2");
    expect(() => assertExactHandStateInvariant(next)).not.toThrow();
  });

  it("rejects illegal exact plays and corrupted ownership evidence", () => {
    const state = createExactHandState(COMPLETE_GAME_DEAL, CANONICAL_RULES);
    const illegalCard = state.hands.user[0];
    if (illegalCard === undefined) {
      throw new Error("Fixture user hand is unexpectedly empty.");
    }
    const illegal: CardPlayedEvent = {
      type: "card-played",
      schemaVersion: 1,
      seat: "user",
      card: illegalCard,
    };
    expect(() => applyExactHandCardPlay(state, illegal)).toThrow(
      expect.objectContaining({
        code: "MUST_FOLLOW_SUIT",
      } satisfies Partial<RuleViolation>),
    );

    const corrupted = structuredClone(state);
    const p2Card = corrupted.hands.p2[0];
    if (p2Card === undefined) {
      throw new Error("Fixture p2 hand is unexpectedly empty.");
    }
    const aceIndex = corrupted.hands.p3.indexOf(ACE_OF_SPADES);
    expect(aceIndex).toBeGreaterThanOrEqual(0);
    corrupted.hands.p3.splice(aceIndex, 1, p2Card);
    corrupted.hands.p2.splice(0, 1, ACE_OF_SPADES);

    expect(() => assertExactHandStateInvariant(corrupted)).toThrow(
      /known to belong to p3/,
    );
  });

  it("rejects draw cards not owned by the exact source without mutation", () => {
    const state = createExactHandState(COMPLETE_GAME_DEAL, CANONICAL_RULES);
    const before = structuredClone(state);
    const foreignCard = state.hands.user[0];
    if (foreignCard === undefined) {
      throw new Error("Fixture user hand is unexpectedly empty.");
    }
    const event: PlayerCardDrawnEvent = {
      type: "player-card-drawn",
      schemaVersion: 1,
      seat: "p2",
      source: "p3",
      card: foreignCard,
    };

    expect(() => applyExactHandPlayerDraw(state, event, 7)).toThrow(
      expect.objectContaining({
        code: "CARD_NOT_OWNED",
        eventIndex: 7,
      } satisfies Partial<RuleViolation>),
    );
    expect(state).toEqual(before);
  });
});
