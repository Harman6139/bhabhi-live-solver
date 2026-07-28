import { describe, expect, it } from "vitest";

import {
  ACE_OF_SPADES,
  FULL_DECK,
  SUITS,
  compareCardsByRank,
  formatCard,
  parseCard,
  suitOf,
  tryParseCard,
} from "../../src/domain/cards";

describe("cards", () => {
  it("constructs exactly 52 unique rank/suit identities", () => {
    expect(FULL_DECK).toHaveLength(52);
    expect(new Set(FULL_DECK)).toHaveLength(52);
    for (const suit of SUITS) {
      expect(FULL_DECK.filter((card) => suitOf(card) === suit)).toHaveLength(
        13,
      );
    }
  });

  it("parses keyboard aliases and Unicode suits canonically", () => {
    expect(parseCard("qh")).toBe("QH");
    expect(parseCard("10d")).toBe("TD");
    expect(parseCard(" as ")).toBe(ACE_OF_SPADES);
    expect(parseCard("K♣")).toBe("KC");
    expect(formatCard("TD")).toBe("10♦");
  });

  it("rejects malformed aliases with a recoverable message", () => {
    expect(tryParseCard("1h")).toBeNull();
    expect(tryParseCard("joker")).toBeNull();
    expect(() => parseCard("11s")).toThrow(/not a card/i);
  });

  it("orders ranks from two low through ace high", () => {
    expect(compareCardsByRank("2C", "AC")).toBeLessThan(0);
    expect(compareCardsByRank("TC", "9D")).toBeGreaterThan(0);
    expect(compareCardsByRank("QH", "QS")).toBe(0);
  });
});
