import { describe, expect, it } from "vitest";

import { FULL_DECK, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { legalCardsForExactHand } from "../../src/rules/legal-actions";
import {
  applyGameEvent,
  createInitialPublicState,
} from "../../src/rules/reducer";
import { RuleViolation, type RuleErrorCode } from "../../src/rules/rule-error";
import {
  createdEventWithUserHand,
  playEvent,
  userHandIncluding,
} from "../support/state-builders";

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

function noSpadeHandWithOnlyRequiredAces(
  required: readonly Card[],
  size: 17 | 18 = 17,
): Card[] {
  const hand = [...required];
  for (const card of FULL_DECK) {
    if (hand.length >= size) {
      break;
    }
    if (
      !card.endsWith("S") &&
      !hand.includes(card) &&
      (!card.startsWith("A") || required.includes(card))
    ) {
      hand.push(card);
    }
  }
  return hand;
}

describe("canonical opening trick", () => {
  it("requires the declared holder to open A-spades, ignores opening thullas, wastes every card, and returns power to the opener", () => {
    const userHand = userHandIncluding(["AS"], 18);
    let state = createInitialPublicState(
      createdEventWithUserHand(userHand, "user"),
    );

    expectRuleViolation(
      () => applyGameEvent(state, playEvent("user", "2C")),
      "OPENING_REQUIRES_ACE_OF_SPADES",
    );

    state = applyGameEvent(state, playEvent("user", "AS"));
    state = applyGameEvent(state, playEvent("p2", "2H"));

    expect(state.phase).toBe("opening");
    expect(state.turn).toBe("p3");
    expect(state.trick?.plays.map((play) => play.card)).toEqual(["AS", "2H"]);
    expect(
      state.effects.some((effect) => effect.type === "trick-picked-up"),
    ).toBe(false);
    expect(state.waste).toEqual([]);

    state = applyGameEvent(state, playEvent("p3", "3H"));

    expect(state.phase).toBe("normal");
    expect(state.power).toBe("user");
    expect(state.turn).toBe("user");
    expect(state.trick).toMatchObject({
      kind: "normal",
      leader: "user",
      plays: [],
    });
    expect(state.waste).toEqual(["AS", "2H", "3H"]);
    expect(
      state.effects.findLast((effect) => effect.type === "trick-wasted"),
    ).toMatchObject({
      cards: ["AS", "2H", "3H"],
      power: "user",
    });
  });

  it("rejects an opening off-suit observation when the exact hand contains a Spade", () => {
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      direction: "anticlockwise",
    };
    const userHand = userHandIncluding(["2S", "KH"], 17);
    let state = createInitialPublicState(
      createdEventWithUserHand(userHand, "p2", rules),
    );

    state = applyGameEvent(state, playEvent("p2", "AS"));

    expect(state.turn).toBe("user");
    expect(legalCardsForExactHand(state, "user", state.userHand)).toEqual([
      "2S",
    ]);
    expectRuleViolation(
      () => applyGameEvent(state, playEvent("user", "KH")),
      "MUST_FOLLOW_SUIT",
    );
    expect(state.userHand).toEqual(expect.arrayContaining(["2S", "KH"]));
    expect(state.trick?.plays.map((play) => play.card)).toEqual(["AS"]);
  });

  it("requires a globally highest off-suit rank while allowing equal-rank ties", () => {
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      openingOffSuit: "highest",
    };
    const userHand = noSpadeHandWithOnlyRequiredAces(["AD", "AH", "2C"]);
    let state = createInitialPublicState(
      createdEventWithUserHand(userHand, "p2", rules),
    );

    state = applyGameEvent(state, playEvent("p2", "AS"));
    state = applyGameEvent(state, playEvent("p3", "2S"));

    expect(state.turn).toBe("user");
    expect(legalCardsForExactHand(state, "user", state.userHand)).toEqual([
      "AD",
      "AH",
    ]);
    expectRuleViolation(
      () => applyGameEvent(state, playEvent("user", "2C")),
      "OPENING_REQUIRES_HIGHEST_OFF_SUIT",
    );

    const diamondTie = applyGameEvent(state, playEvent("user", "AD"));
    const heartTie = applyGameEvent(state, playEvent("user", "AH"));

    expect(diamondTie.waste).toEqual(["AS", "2S", "AD"]);
    expect(heartTie.waste).toEqual(["AS", "2S", "AH"]);
    expect(diamondTie.power).toBe("p2");
    expect(heartTie.power).toBe("p2");
  });
});
