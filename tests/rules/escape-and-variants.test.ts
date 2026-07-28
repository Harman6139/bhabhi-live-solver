import { describe, expect, it } from "vitest";

import type { Card } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import type { Seat } from "../../src/domain/seats";
import type {
  HandTakenEvent,
  PlayerCardDrawnEvent,
  WasteCardDrawnEvent,
} from "../../src/events/game-events";
import { applyGameEvent } from "../../src/rules/reducer";
import { RuleViolation } from "../../src/rules/rule-error";
import { makeExactPublicState, playEvent } from "../support/state-builders";

function zeroPowerRules(
  mode: RuleConfig["zeroCardsWithPower"]["mode"],
  drawFromTarget: RuleConfig["zeroCardsWithPower"]["drawFromTarget"] = "next-active",
  configuredTarget: RuleConfig["zeroCardsWithPower"]["configuredTarget"] = null,
): RuleConfig {
  return {
    ...CANONICAL_RULES,
    twoPlayer: "normal",
    zeroCardsWithPower: {
      mode,
      drawFromTarget,
      configuredTarget,
    },
  };
}

function playZeroPowerCleanTrick(rules: RuleConfig) {
  let state = makeExactPublicState({
    hands: {
      user: ["AH"],
      p2: ["2H", "3C"],
      p3: ["3H", "4C"],
    },
    power: "user",
    rules,
  });
  state = applyGameEvent(state, playEvent("user", "AH"));
  state = applyGameEvent(state, playEvent("p2", "2H"));
  return applyGameEvent(state, playEvent("p3", "3H"));
}

function takeEvent(
  target: "p2" | "p3",
  revealedCards: readonly Card[],
): HandTakenEvent {
  return {
    type: "hand-taken",
    schemaVersion: 1,
    actor: "user",
    target,
    revealedCards,
  };
}

function makeTakeState(
  rules: RuleConfig,
  activeSeats: readonly Seat[] = ["user", "p2", "p3"],
) {
  return makeExactPublicState({
    hands: {
      user: ["2C", "5C"],
      p2: activeSeats.includes("p2") ? ["3C"] : [],
      p3: ["4C"],
    },
    activeSeats,
    power: "user",
    rules,
  });
}

describe("zero cards while retaining power", () => {
  it("keeps the completed trick excluded until an explicit eligible waste draw", () => {
    const state = playZeroPowerCleanTrick(zeroPowerRules("waste-draw"));

    expect(state.pendingAction).toEqual({
      kind: "waste-draw",
      player: "user",
      excludedTrick: ["AH", "2H", "3H"],
      reason: "zero-power",
    });
    expect(state.waste).not.toEqual(expect.arrayContaining(["AH", "2H", "3H"]));

    const beforeInvalid = structuredClone(state);
    const invalidDraw: WasteCardDrawnEvent = {
      type: "waste-card-drawn",
      schemaVersion: 1,
      seat: "user",
      card: "AH",
    };
    expect(() => applyGameEvent(state, invalidDraw)).toThrow(
      expect.objectContaining({
        code: "INVALID_DRAW_CARD",
      }) as RuleViolation,
    );
    expect(state).toEqual(beforeInvalid);

    const draw: WasteCardDrawnEvent = {
      type: "waste-card-drawn",
      schemaVersion: 1,
      seat: "user",
      card: "2C",
    };
    const drawn = applyGameEvent(state, draw);
    expect(drawn.pendingAction).toBeNull();
    expect(drawn.userHand).toEqual(["2C"]);
    expect(drawn.trick?.forcedLeadCard).toBe("2C");
    expect(drawn.waste).toEqual(expect.arrayContaining(["AH", "2H", "3H"]));
  });

  it("lets an empty power holder escape and passes power in direction", () => {
    const state = playZeroPowerCleanTrick(zeroPowerRules("immediate-escape"));

    expect(state.activeSeats).toEqual(["p2", "p3"]);
    expect(state.power).toBe("p2");
    expect(state.turn).toBe("p2");
    expect(state.trick?.leader).toBe("p2");
    expect(state.waste).toEqual(expect.arrayContaining(["AH", "2H", "3H"]));
  });

  it("records a deterministic player draw and can empty its source", () => {
    const state = playZeroPowerCleanTrick(zeroPowerRules("draw-from-player"));
    expect(state.pendingAction).toMatchObject({
      kind: "player-draw",
      player: "user",
      source: "p2",
    });

    const draw: PlayerCardDrawnEvent = {
      type: "player-card-drawn",
      schemaVersion: 1,
      seat: "user",
      source: "p2",
      card: "3C",
    };
    const drawn = applyGameEvent(state, draw);
    expect(drawn.userHand).toEqual(["3C"]);
    expect(drawn.handCounts.p2).toBe(0);
    expect(drawn.activeSeats).toEqual(["user", "p3"]);
    expect(drawn.trick?.forcedLeadCard).toBe("3C");
  });

  it("uses an active configured player-draw source", () => {
    const state = playZeroPowerCleanTrick(
      zeroPowerRules("draw-from-player", "configured", "p3"),
    );
    expect(state.pendingAction).toMatchObject({
      kind: "player-draw",
      player: "user",
      source: "p3",
    });
  });
});

describe("take-hand variants", () => {
  it("rejects the action atomically when disabled", () => {
    const state = makeTakeState(CANONICAL_RULES);
    const before = structuredClone(state);
    expect(() => applyGameEvent(state, takeEvent("p2", ["3C"]))).toThrow(
      expect.objectContaining({ code: "TAKE_DISABLED" }) as RuleViolation,
    );
    expect(state).toEqual(before);
  });

  it("takes the next active hand, transfers exact cards, and keeps power", () => {
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      takeHand: { mode: "next-active", configuredTargets: [] },
    };
    const state = applyGameEvent(makeTakeState(rules), takeEvent("p2", ["3C"]));

    expect(state.userHand).toEqual(["2C", "3C", "5C"]);
    expect(state.handCounts.p2).toBe(0);
    expect(state.activeSeats).toEqual(["user", "p3"]);
    expect(state.power).toBe("user");
    expect(state.trick?.plays).toEqual([]);
  });

  it("distinguishes raw adjacency from next-active skipping", () => {
    const adjacent: RuleConfig = {
      ...CANONICAL_RULES,
      takeHand: { mode: "adjacent", configuredTargets: [] },
    };
    const adjacentState = makeTakeState(adjacent, ["user", "p3"]);
    expect(() =>
      applyGameEvent(adjacentState, takeEvent("p3", ["4C"])),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_TAKE_TARGET",
      }) as RuleViolation,
    );

    const nextActive: RuleConfig = {
      ...CANONICAL_RULES,
      takeHand: { mode: "next-active", configuredTargets: [] },
    };
    const completed = applyGameEvent(
      makeTakeState(nextActive, ["user", "p3"]),
      takeEvent("p3", ["4C"]),
    );
    expect(completed.status).toBe("complete");
    expect(completed.bhabhi).toBe("user");
  });

  it("accepts only active targets listed by configured mode", () => {
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      takeHand: { mode: "configured", configuredTargets: ["p3"] },
    };
    const state = makeTakeState(rules);
    expect(() => applyGameEvent(state, takeEvent("p2", ["3C"]))).toThrow(
      expect.objectContaining({
        code: "INVALID_TAKE_TARGET",
      }) as RuleViolation,
    );

    const taken = applyGameEvent(state, takeEvent("p3", ["4C"]));
    expect(taken.userHand).toEqual(["2C", "4C", "5C"]);
    expect(taken.activeSeats).toEqual(["user", "p2"]);
  });
});
