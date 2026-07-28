import { describe, expect, it } from "vitest";

import { FULL_DECK, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { SEATS, type Direction } from "../../src/domain/seats";
import type { GameEvent, HandTakenEvent } from "../../src/events/game-events";
import { replayEvents } from "../../src/events/timeline";
import { cardsInPendingAction } from "../../src/public/public-state";
import {
  createPolicyObservation,
  simulateCompleteGame,
  type SimulationGameConfig,
  type SimulationGameResult,
} from "../../src/simulator/game";
import {
  getBaselinePolicy,
  type SimulatorPolicy,
} from "../../src/simulator/policies";
import {
  applyTruthCardPlay,
  applyTruthHandTaken,
  applyTruthPlayerDraw,
  applyTruthWasteDraw,
  createSimulationTruth,
  type SimulationTruth,
} from "../../src/simulator/truth";

const alwaysLow = getBaselinePolicy("always-low");
const random = getBaselinePolicy("random");

const takeFirstPolicy: SimulatorPolicy = {
  id: "test-take-first",
  version: 1,
  chooseTakeTarget(observation) {
    return observation.legalTakeTargets?.[0] ?? null;
  },
  chooseCard(observation, rng) {
    return alwaysLow.chooseCard(observation, rng);
  },
};

function simulationConfig(
  gameId: string,
  policy: SimulatorPolicy,
  rules: RuleConfig = CANONICAL_RULES,
): SimulationGameConfig {
  return {
    gameId,
    rules,
    seeds: {
      deal: `${gameId}/deal`,
      policy: {
        user: `${gameId}/user`,
        p2: `${gameId}/p2`,
        p3: `${gameId}/p3`,
      },
      chance: `${gameId}/chance`,
    },
    policies: {
      user: policy,
      p2: policy,
      p3: policy,
    },
  };
}

function terminalCards(result: SimulationGameResult): Card[] {
  return [
    ...SEATS.flatMap((seat) => result.finalHands[seat]),
    ...(result.finalState.trick?.plays.map((play) => play.card) ?? []),
    ...result.finalState.waste,
    ...cardsInPendingAction(result.finalState.pendingAction),
  ];
}

function applyTruthEvent(
  truth: SimulationTruth,
  event: Exclude<GameEvent, { readonly type: "game-created" }>,
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

function replayTruthThrough(
  result: SimulationGameResult,
  throughEventIndex: number,
): SimulationTruth {
  let truth = createSimulationTruth(result.deal, result.rules);
  for (let eventIndex = 1; eventIndex <= throughEventIndex; eventIndex += 1) {
    const event = result.events[eventIndex];
    if (event === undefined || event.type === "game-created") {
      throw new Error(`Missing simulator event ${eventIndex.toString()}.`);
    }
    truth = applyTruthEvent(truth, event, eventIndex);
  }
  return truth;
}

const TAKE_CASES = (
  ["clockwise", "anticlockwise"] as const satisfies readonly Direction[]
).flatMap((direction) =>
  (["next-active", "adjacent", "configured"] as const).map((mode) => ({
    direction,
    mode,
  })),
);

describe("take-hand complete-game simulation", () => {
  it.each(TAKE_CASES)(
    "executes $mode takes in the $direction direction with replay and conservation",
    ({ direction, mode }) => {
      const rules: RuleConfig = {
        ...CANONICAL_RULES,
        direction,
        takeHand: {
          mode,
          configuredTargets: mode === "configured" ? [...SEATS] : [],
        },
      };
      const result = simulateCompleteGame(
        simulationConfig(
          `variant-take/${direction}/${mode}`,
          takeFirstPolicy,
          rules,
        ),
      );
      const takeEvents = result.events.filter(
        (event): event is HandTakenEvent => event.type === "hand-taken",
      );
      const takeDecisions = result.decisions.filter(
        (decision) => decision.actionKind === "take-hand",
      );

      expect(takeEvents.length).toBeGreaterThan(0);
      expect(takeDecisions).toHaveLength(takeEvents.length);
      for (const decision of takeDecisions) {
        expect(decision.chosenCard).toBeNull();
        expect(decision.chosenTakeTarget).not.toBeNull();
        expect(decision.legalTakeTargets).toContain(decision.chosenTakeTarget);
        expect(result.events[decision.eventIndex]).toMatchObject({
          type: "hand-taken",
          actor: decision.seat,
          target: decision.chosenTakeTarget,
        });
      }

      const replay = replayEvents(result.events);
      expect(replay.state).toEqual(result.finalState);
      expect(replay.semanticHash).toBe(result.semanticHistoryHash);
      expect(result.status).toBe("complete");
      expect(result.escapeOrder.at(-1)).toBe(result.bhabhi);

      const cards = terminalCards(result);
      expect(cards).toHaveLength(FULL_DECK.length);
      expect(new Set(cards)).toEqual(new Set(FULL_DECK));
    },
  );
});

describe("simulator event-cap validation", () => {
  it.each([
    { label: "NaN", value: Number.NaN },
    { label: "positive infinity", value: Number.POSITIVE_INFINITY },
    { label: "negative infinity", value: Number.NEGATIVE_INFINITY },
    { label: "zero", value: 0 },
    { label: "negative", value: -1 },
    { label: "fractional", value: 1.5 },
    { label: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects $label before simulation", ({ value }) => {
    const config = {
      ...simulationConfig("variant-invalid-event-cap", alwaysLow),
      maxEvents: value,
    };

    expect(() => simulateCompleteGame(config)).toThrow(RangeError);
    expect(() => simulateCompleteGame(config)).toThrow(
      "maxEvents must be a positive safe integer.",
    );
  });
});

describe("temporal policy observation", () => {
  it("removes a drawn known card from its source and transfers it to the recipient", () => {
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      twoPlayer: "normal",
      zeroCardsWithPower: {
        mode: "draw-from-player",
        drawFromTarget: "next-active",
        configuredTarget: null,
      },
    };
    const result = simulateCompleteGame({
      ...simulationConfig("scan-random-11", random, rules),
      seeds: {
        deal: "scan-d-11",
        policy: {
          user: "u-11",
          p2: "2-11",
          p3: "3-11",
        },
        chance: "c-11",
      },
    });
    const drawIndex = result.events.findIndex(
      (event) =>
        event.type === "player-card-drawn" &&
        event.seat === "p2" &&
        event.source === "p3" &&
        event.card === "7H",
    );
    if (drawIndex <= 0) {
      throw new Error("Locked player-draw regression event is missing.");
    }

    const beforeTruth = replayTruthThrough(result, drawIndex - 1);
    const before = createPolicyObservation(
      beforeTruth,
      "p2",
      0,
      result.events.slice(0, drawIndex),
    );
    expect(beforeTruth.publicState.pendingAction).toMatchObject({
      kind: "player-draw",
      player: "p2",
      source: "p3",
    });
    expect(before.currentSuitStatus.p3.hearts).toBe("known-has");

    const afterTruth = replayTruthThrough(result, drawIndex);
    const after = createPolicyObservation(
      afterTruth,
      "p2",
      0,
      result.events.slice(0, drawIndex + 1),
    );
    expect(afterTruth.publicState.turn).toBe("p2");
    expect(afterTruth.publicState.trick?.forcedLeadCard).toBe("7H");
    expect(after.legalCards).toEqual(["7H"]);
    expect(after.currentSuitStatus.p3.hearts).toBe("unknown");
    expect(after.currentSuitStatus.p2.hearts).toBe("known-has");
  });

  it("expires pickup recency after a later trick is wasted", () => {
    const result = simulateCompleteGame({
      ...simulationConfig("pickup-scan", random),
      seeds: {
        deal: "pickup-deal",
        policy: {
          user: "pu",
          p2: "p2",
          p3: "p3",
        },
        chance: "pc",
      },
    });
    const pickup = result.finalState.effects.find(
      (effect) =>
        effect.type === "trick-picked-up" &&
        effect.picker === "p3" &&
        effect.cards.includes("8C") &&
        effect.cards.includes("KH"),
    );
    if (pickup?.type !== "trick-picked-up") {
      throw new Error("Locked pickup regression effect is missing.");
    }
    const laterWaste = result.finalState.effects.find(
      (effect) =>
        effect.type === "trick-wasted" && effect.eventIndex > pickup.eventIndex,
    );
    if (laterWaste?.type !== "trick-wasted") {
      throw new Error("Locked later-waste regression effect is missing.");
    }

    const immediateTruth = replayTruthThrough(result, pickup.eventIndex);
    const immediateSeat = immediateTruth.publicState.turn;
    if (immediateSeat === null) {
      throw new Error("Pickup regression state has no next actor.");
    }
    const immediate = createPolicyObservation(
      immediateTruth,
      immediateSeat,
      0,
      result.events.slice(0, pickup.eventIndex + 1),
    );
    expect(immediate.lastPickup).toEqual({
      picker: pickup.picker,
      cards: pickup.cards,
      thullaBy: pickup.thullaBy,
    });

    const laterTruth = replayTruthThrough(result, laterWaste.eventIndex);
    const laterSeat = laterTruth.publicState.turn;
    if (laterSeat === null) {
      throw new Error("Later-waste regression state has no next actor.");
    }
    const later = createPolicyObservation(
      laterTruth,
      laterSeat,
      0,
      result.events.slice(0, laterWaste.eventIndex + 1),
    );
    expect(later.lastPickup).toBeNull();
  });
});
