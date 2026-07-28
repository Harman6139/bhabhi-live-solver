import { describe, expect, it } from "vitest";

import type { Card } from "../../src/domain/cards";
import { legalCardsForExactHand } from "../../src/rules/legal-actions";
import { applyGameEvent } from "../../src/rules/reducer";
import { RuleViolation, type RuleErrorCode } from "../../src/rules/rule-error";
import { makeExactPublicState, playEvent } from "../support/state-builders";

type Hands = Record<"user" | "p2" | "p3", Card[]>;

function expectRuleViolation(action: () => unknown, code: RuleErrorCode): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RuleViolation);
  expect(thrown).toMatchObject({ code });
}

describe("normal tricks", () => {
  it("wastes a clean trick and gives power to the highest lead-suit player", () => {
    const hands: Hands = {
      user: ["4H", "2C"],
      p2: ["QH", "3C"],
      p3: ["9H", "4C"],
    };
    let state = makeExactPublicState({ hands, power: "user" });

    state = applyGameEvent(state, playEvent("user", "4H"));
    state = applyGameEvent(state, playEvent("p2", "QH"));
    state = applyGameEvent(state, playEvent("p3", "9H"));

    expect(state.power).toBe("p2");
    expect(state.turn).toBe("p2");
    expect(state.trick).toMatchObject({
      kind: "normal",
      leader: "p2",
      plays: [],
    });
    expect(state.waste).toEqual(expect.arrayContaining(["4H", "QH", "9H"]));
    expect(
      state.effects.findLast((effect) => effect.type === "trick-wasted"),
    ).toMatchObject({
      cards: ["4H", "QH", "9H"],
      power: "p2",
    });
    expect(
      state.effects.some((effect) => effect.type === "trick-picked-up"),
    ).toBe(false);
  });

  it("allows any lead-suit rank without requiring a follower to beat the current high card", () => {
    const hands: Hands = {
      user: ["9H", "2C"],
      p2: ["2H", "KH", "3C"],
      p3: ["3H", "4C"],
    };
    let state = makeExactPublicState({ hands, power: "user" });

    state = applyGameEvent(state, playEvent("user", "9H"));

    expect(
      legalCardsForExactHand(state, "p2", state.knownOpponentCards.p2),
    ).toEqual(["2H", "KH"]);

    state = applyGameEvent(state, playEvent("p2", "2H"));
    expect(state.turn).toBe("p3");
    state = applyGameEvent(state, playEvent("p3", "3H"));

    expect(state.power).toBe("user");
    expect(
      state.effects.findLast((effect) => effect.type === "trick-wasted"),
    ).toMatchObject({ cards: ["9H", "2H", "3H"], power: "user" });
  });

  it("ignores an off-suit Ace when choosing the lead-suit pickup owner", () => {
    const hands: Hands = {
      user: ["4D", "2C"],
      p2: ["JD", "3C"],
      p3: ["AH", "4C"],
    };
    let state = makeExactPublicState({ hands, power: "user" });

    state = applyGameEvent(state, playEvent("user", "4D"));
    state = applyGameEvent(state, playEvent("p2", "JD"));
    state = applyGameEvent(state, playEvent("p3", "AH"));

    expect(state.power).toBe("p2");
    expect(state.turn).toBe("p2");
    expect(state.knownOpponentCards.p2).toEqual(
      expect.arrayContaining(["4D", "JD", "AH"]),
    );
    expect(
      state.effects.findLast((effect) => effect.type === "trick-picked-up"),
    ).toMatchObject({
      cards: ["4D", "JD", "AH"],
      picker: "p2",
      thullaBy: "p3",
    });
  });

  it("rejects an off-suit play when a known lead-suit card remains", () => {
    const hands: Hands = {
      user: ["4H", "2C"],
      p2: ["KH", "AC", "3C"],
      p3: ["6H", "4C"],
    };
    let state = makeExactPublicState({ hands, power: "user" });

    state = applyGameEvent(state, playEvent("user", "4H"));

    expect(
      legalCardsForExactHand(state, "p2", state.knownOpponentCards.p2),
    ).toEqual(["KH"]);
    expectRuleViolation(
      () => applyGameEvent(state, playEvent("p2", "AC")),
      "MUST_FOLLOW_SUIT",
    );
    expect(state.turn).toBe("p2");
    expect(state.knownOpponentCards.p2).toEqual(
      expect.arrayContaining(["KH", "AC"]),
    );
    expect(state.trick?.plays.map((play) => play.card)).toEqual(["4H"]);
  });

  it("ends on the first thulla and skips every later seat", () => {
    const hands: Hands = {
      user: ["4D", "2H"],
      p2: ["2C", "3H"],
      p3: ["JD", "4H"],
    };
    let state = makeExactPublicState({ hands, power: "user" });
    const skippedCount = state.handCounts.p3;

    state = applyGameEvent(state, playEvent("user", "4D"));
    state = applyGameEvent(state, playEvent("p2", "2C"));

    expect(state.power).toBe("user");
    expect(state.turn).toBe("user");
    expect(state.handCounts.p3).toBe(skippedCount);
    expect(state.knownOpponentCards.p3).toContain("JD");
    expect(state.trick).toMatchObject({
      leader: "user",
      plays: [],
    });
    expect(
      state.effects.findLast((effect) => effect.type === "trick-picked-up"),
    ).toMatchObject({
      cards: ["4D", "2C"],
      picker: "user",
      thullaBy: "p2",
    });
    expectRuleViolation(
      () => applyGameEvent(state, playEvent("p3", "JD")),
      "WRONG_TURN",
    );
  });
});
