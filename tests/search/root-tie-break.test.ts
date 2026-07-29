import { describe, expect, it } from "vitest";

import {
  compareRootRiskCandidates,
  rootTieBreakKey,
  type RootRiskCandidate,
  type RootTieBreakContext,
} from "../../src/search/root-tie-break";

const TIED: readonly RootRiskCandidate[] = [
  {
    action: { kind: "play-card", card: "2C" },
    actionKey: "play:2C",
    risk: 0.5,
  },
  {
    action: { kind: "play-card", card: "3C" },
    actionKey: "play:3C",
    risk: 0.5,
  },
  {
    action: { kind: "play-card", card: "4C" },
    actionKey: "play:4C",
    risk: 0.5,
  },
] as const;

function context(historyHash: string): RootTieBreakContext {
  return {
    historyHash,
    publicStateHash: "fnv1a64:0123456789abcdef",
    searchSeedId: "0123456789abcdef0123456789abcdef",
  };
}

function selected(historyHash: string): string {
  const value = [...TIED].sort((left, right) =>
    compareRootRiskCandidates(context(historyHash), left, right),
  )[0];
  if (value === undefined) {
    throw new Error("Tie-break fixture omitted its candidates.");
  }
  return value.actionKey;
}

describe("public-history root tie breaking", () => {
  it("is byte-reproducible for the same public inputs", () => {
    const first = Array.from({ length: 12 }, () =>
      selected("fnv1a64:1111111111111111"),
    );
    expect(new Set(first).size).toBe(1);
    expect(
      rootTieBreakKey(context("fnv1a64:1111111111111111"), "play:2C"),
    ).toBe(rootTieBreakKey(context("fnv1a64:1111111111111111"), "play:2C"));
  });

  it("does not statically lock exact-risk ties to canonical card order", () => {
    const choices = Array.from({ length: 32 }, (_, index) =>
      selected(`fnv1a64:${index.toString(16).padStart(16, "0")}`),
    );
    expect(new Set(choices).size).toBeGreaterThan(1);
  });

  it("never lets the tie key overturn a genuine risk difference", () => {
    const safer: RootRiskCandidate = {
      action: { kind: "play-card", card: "2C" },
      actionKey: "play:2C",
      risk: 0.25,
    };
    const riskier: RootRiskCandidate = {
      action: { kind: "play-card", card: "3C" },
      actionKey: "play:3C",
      risk: 0.5,
    };
    expect(
      compareRootRiskCandidates(
        context("fnv1a64:2222222222222222"),
        safer,
        riskier,
      ),
    ).toBeLessThan(0);
  });
});
