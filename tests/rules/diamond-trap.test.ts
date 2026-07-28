import { describe, expect, it } from "vitest";

import { FULL_DECK, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES } from "../../src/domain/rule-config";
import { applyGameEvent } from "../../src/rules/reducer";
import { makeExactPublicState, playEvent } from "../support/state-builders";

function trapHands(): Record<"user" | "p2" | "p3", Card[]> {
  const userRequired: Card[] = [
    "4D",
    "QD",
    ...FULL_DECK.filter(
      (card) =>
        card.endsWith("D") && card !== "JD" && card !== "4D" && card !== "QD",
    ),
  ];
  for (const card of FULL_DECK) {
    if (userRequired.length >= 18) break;
    if (!userRequired.includes(card) && card !== "JD" && card !== "2C") {
      userRequired.push(card);
    }
  }
  const remaining = FULL_DECK.filter((card) => !userRequired.includes(card));
  const p2: Card[] = ["JD"];
  for (const card of remaining) {
    if (p2.length >= 17) break;
    if (card !== "2C" && !card.endsWith("D")) p2.push(card);
  }
  const p3 = remaining.filter((card) => !p2.includes(card));
  expect(p3).toHaveLength(17);
  expect(p3).toContain("2C");
  expect(p3.some((card) => card.endsWith("D"))).toBe(false);
  return { user: userRequired, p2, p3 };
}

function playTrap(userLead: "4D" | "QD") {
  let state = makeExactPublicState({ hands: trapHands(), power: "user" });
  state = applyGameEvent(state, playEvent("user", userLead));
  state = applyGameEvent(state, playEvent("p2", "JD"));
  return applyGameEvent(state, playEvent("p3", "2C"));
}

describe("mandatory low-card thulla trap", () => {
  it("makes Player 2 pick up after 4♦, with later seats skipped", () => {
    const state = playTrap("4D");
    expect(state.power).toBe("p2");
    expect(state.trick?.plays).toEqual([]);
    expect(state.knownOpponentCards.p2).toEqual(
      expect.arrayContaining(["4D", "JD", "2C"]),
    );
    const pickup = state.effects.findLast(
      (effect) => effect.type === "trick-picked-up",
    );
    expect(pickup).toMatchObject({
      type: "trick-picked-up",
      picker: "p2",
      cards: ["4D", "JD", "2C"],
    });
  });

  it("makes the user pick up after Q♦", () => {
    const state = playTrap("QD");
    expect(state.power).toBe("user");
    expect(state.userHand).toEqual(expect.arrayContaining(["QD", "JD", "2C"]));
    expect(
      state.effects.findLast((effect) => effect.type === "trick-picked-up"),
    ).toMatchObject({ picker: "user", cards: ["QD", "JD", "2C"] });
  });

  it("reverses seat order and stops before Player 2 can play J♦", () => {
    const rules = {
      ...CANONICAL_RULES,
      direction: "anticlockwise" as const,
    };
    let state = makeExactPublicState({
      hands: trapHands(),
      power: "user",
      rules,
    });
    const p2Count = state.handCounts.p2;
    state = applyGameEvent(state, playEvent("user", "4D"));
    state = applyGameEvent(state, playEvent("p3", "2C"));
    expect(state.power).toBe("user");
    expect(state.handCounts.p2).toBe(p2Count);
    expect(state.knownOpponentCards.p2).toContain("JD");
  });
});
