import { describe, expect, it } from "vitest";

import { FULL_DECK } from "../../src/domain/cards";
import { CANONICAL_RULES } from "../../src/domain/rule-config";
import { assertPublicStateInvariant } from "../../src/rules/state-invariant";
import {
  applyGameEvent,
  createInitialPublicState,
} from "../../src/rules/reducer";
import { RuleViolation } from "../../src/rules/rule-error";
import { makeExactPublicState, playEvent } from "../support/state-builders";

describe("public ownership honesty", () => {
  it("seeds a declared opponent Ace of Spades as exact ownership", () => {
    const userHand = FULL_DECK.filter((card) => card !== "AS").slice(0, 18);
    const state = createInitialPublicState({
      type: "game-created",
      schemaVersion: 1,
      rules: CANONICAL_RULES,
      userHand,
      startingCounts: { user: 18, p2: 17, p3: 17 },
      aceSpadesHolder: "p3",
    });

    expect(state.knownOpponentCards.p3).toEqual(["AS"]);
    expect(state.knownOpponentCards.p2).toEqual([]);
    expect(state.unresolvedCards).not.toContain("AS");
    expect(state.unresolvedCards).toHaveLength(33);
    assertPublicStateInvariant(state);
  });

  it("does not let an exact-known opponent consume another opponent unresolved card", () => {
    let state = makeExactPublicState({
      hands: {
        user: ["2H", "4C"],
        p2: ["3H", "5C"],
        p3: ["4H", "6C"],
      },
      power: "user",
    });
    const p3Cards = [...state.knownOpponentCards.p3];
    state.knownOpponentCards.p3 = [];
    state.unresolvedCards.push(...p3Cards);
    assertPublicStateInvariant(state);

    state = applyGameEvent(state, playEvent("user", "2H"));
    const before = structuredClone(state);
    expect(() => applyGameEvent(state, playEvent("p2", "4H"))).toThrow(
      expect.objectContaining({ code: "CARD_NOT_OWNED" }) as RuleViolation,
    );
    expect(state).toEqual(before);
  });
});
