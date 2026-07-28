import { describe, expect, it } from "vitest";

import { CANONICAL_RULES, parseRuleConfig } from "../../src/domain/rule-config";

describe("RuleConfig", () => {
  it("freezes the source-backed canonical profile", () => {
    expect(CANONICAL_RULES).toMatchObject({
      direction: "clockwise",
      takeHand: { mode: "disabled" },
      zeroCardsWithPower: { mode: "waste-draw" },
      openingOffSuit: "any",
      twoPlayer: "pagat-shootout",
    });
    expect(
      parseRuleConfig(JSON.parse(JSON.stringify(CANONICAL_RULES))),
    ).toEqual(CANONICAL_RULES);
  });

  it("rejects incomplete configured variants", () => {
    expect(() =>
      parseRuleConfig({
        ...CANONICAL_RULES,
        takeHand: { mode: "configured", configuredTargets: [] },
      }),
    ).toThrow(/requires at least one target/i);
    expect(() =>
      parseRuleConfig({
        ...CANONICAL_RULES,
        zeroCardsWithPower: {
          mode: "draw-from-player",
          drawFromTarget: "configured",
          configuredTarget: null,
        },
      }),
    ).toThrow(/requires a target/i);
  });
});
