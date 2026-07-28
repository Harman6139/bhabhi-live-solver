import { describe, expect, it } from "vitest";

import { sortCards, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import type { Seat } from "../../src/domain/seats";
import { stableHash } from "../../src/events/stable-hash";
import type { PublicInformationState } from "../../src/public/public-state";
import { applyGameEvent } from "../../src/rules/reducer";
import { assertPublicStateInvariant } from "../../src/rules/state-invariant";
import {
  analyzeScenarioSetForTesting,
  DEFAULT_SOLVER_SEEDS,
  solverBudget,
  type ActionEstimate,
  type BaselineRecommendation,
  type SearchScenario,
} from "../../src/search";
import { queryBehaviorWeightedSuitVoid } from "../../src/strategy";
import { makeExactPublicState, playEvent } from "../support/state-builders";

type ExactHands = Record<Seat, Card[]>;

const TEST_RULES = {
  ...CANONICAL_RULES,
  zeroCardsWithPower: {
    ...CANONICAL_RULES.zeroCardsWithPower,
    mode: "immediate-escape",
  },
  twoPlayer: "normal",
} as const satisfies RuleConfig;

const TEST_POLICIES = {
  userContinuation: "always-high",
  p2: "always-high",
  p3: "always-high",
} as const;

function hands(
  user: readonly Card[],
  p2: readonly Card[],
  p3: readonly Card[],
): ExactHands {
  return { user: [...user], p2: [...p2], p3: [...p3] };
}

function exactState(exactHands: ExactHands): PublicInformationState {
  return makeExactPublicState({
    hands: exactHands,
    power: "user",
    rules: TEST_RULES,
  });
}

function partiallyKnownState(
  witness: ExactHands,
  known: Readonly<{ p2: readonly Card[]; p3: readonly Card[] }>,
): PublicInformationState {
  const state = exactState(witness);
  state.knownOpponentCards = {
    p2: sortCards(known.p2),
    p3: sortCards(known.p3),
  };
  const knownCards = new Set<Card>([...known.p2, ...known.p3]);
  state.unresolvedCards = sortCards(
    [...witness.p2, ...witness.p3].filter((card) => !knownCards.has(card)),
  );
  assertPublicStateInvariant(state);
  return state;
}

function analyze(
  publicState: PublicInformationState,
  exactHands: readonly ExactHands[],
): BaselineRecommendation {
  const scenarios: SearchScenario[] = exactHands.map((currentHands, index) => ({
    witnessId: stableHash({
      fixture: "required-strategy-motifs",
      index,
      currentHands,
    }),
    currentHands,
  }));
  return analyzeScenarioSetForTesting({
    publicState,
    historyHash: stableHash({
      fixture: "required-strategy-motifs-history",
      publicState,
    }),
    stateVersion: 0,
    scenarios,
    belief: {
      method: "exact-enumeration",
      totalInitialDealWorlds: exactHands.length.toString(),
      worldSetChecksum: stableHash(scenarios),
      uniqueWitnesses: new Set(scenarios.map((scenario) => scenario.witnessId))
        .size,
    },
    budget: solverBudget("instant", {
      worldSamples: exactHands.length,
      rolloutsPerWorld: 1,
      maxEventsPerRollout: 256,
      intervalResamples: 64,
      deadlineMs: 60_000,
    }),
    policies: TEST_POLICIES,
    seeds: DEFAULT_SOLVER_SEEDS,
  });
}

function candidate(
  recommendation: BaselineRecommendation,
  actionKey: string,
): ActionEstimate {
  const result = recommendation.payload.candidates.find(
    (entry) => entry.actionKey === actionKey,
  );
  if (result === undefined) {
    throw new Error(`Missing candidate ${actionKey}.`);
  }
  return result;
}

describe("required Phase 6 strategy motifs", () => {
  it("M18: an immediate next-seat void stops the trick and forces the still-high leader to pick up", () => {
    const exactHands = hands(["4D", "2H"], ["2C", "3H"], ["JD", "4H"]);
    let state = makeExactPublicState({
      hands: exactHands,
      power: "user",
    });
    const skippedP3Count = state.handCounts.p3;

    state = applyGameEvent(state, playEvent("user", "4D"));
    state = applyGameEvent(state, playEvent("p2", "2C"));

    expect(state.power).toBe("user");
    expect(state.turn).toBe("user");
    expect(state.handCounts.p3).toBe(skippedP3Count);
    expect(
      state.effects.findLast((effect) => effect.type === "trick-picked-up"),
    ).toMatchObject({
      picker: "user",
      thullaBy: "p2",
      cards: ["4D", "2C"],
    });
  });

  it("M20: weighted uncertain worlds stay soft while chronological hard evidence stays categorical", () => {
    const worlds = [
      {
        witnessId: "world/void",
        currentHands: hands(["4D"], ["JD"], ["2C"]),
      },
      {
        witnessId: "world/has",
        currentHands: hands(["4D"], ["JD"], ["2H"]),
      },
    ];
    const soft = queryBehaviorWeightedSuitVoid({
      worlds,
      occurrences: [
        {
          occurrenceIndex: 0,
          witnessId: "world/void",
          weight: 0.7,
        },
        {
          occurrenceIndex: 1,
          witnessId: "world/has",
          weight: 0.3,
        },
      ],
      seat: "p3",
      suit: "hearts",
      hardStatus: "unknown",
    });
    expect(soft).toMatchObject({
      probability: 0.7,
      counterfactualRange: [0, 1],
      certainty: "soft",
    });

    const voidWorld = worlds[0];
    if (voidWorld === undefined) {
      throw new Error("Missing void-world fixture.");
    }
    const hard = queryBehaviorWeightedSuitVoid({
      worlds: [voidWorld],
      occurrences: [
        {
          occurrenceIndex: 0,
          witnessId: "world/void",
          weight: 1,
        },
      ],
      seat: "p3",
      suit: "hearts",
      hardStatus: "known-void",
    });
    expect(hard).toMatchObject({
      probability: 1,
      counterfactualRange: [1, 1],
      certainty: "hard-known-void",
    });
  });

  it("M21: exact opponent high-card ownership changes the safe lead", () => {
    const jackResponse = hands(["QC", "4D"], ["JC", "JD"], ["2H"]);
    const kingResponse = hands(["QC", "4D"], ["KC", "3D"], ["2H"]);

    const withKnownJacks = analyze(exactState(jackResponse), [jackResponse]);
    const withKnownKings = analyze(exactState(kingResponse), [kingResponse]);

    expect(withKnownJacks.payload.recommendedActionKey).toBe("play:4D");
    expect(candidate(withKnownJacks, "play:QC").bhabhiProbability).toBe(1);
    expect(withKnownKings.payload.recommendedActionKey).toBe("play:QC");
    expect(candidate(withKnownKings, "play:4D").bhabhiProbability).toBe(1);
  });

  it("M46: known J-diamond possession changes the whole causal trap probability", () => {
    const knownJack = hands(["4D", "QD"], ["JD"], ["2C"]);
    const jackElsewhere = hands(["4D", "QD"], ["2C"], ["JD"]);
    const known = analyze(exactState(knownJack), [knownJack]);
    const uncertain = analyze(
      partiallyKnownState(knownJack, { p2: [], p3: [] }),
      [knownJack, jackElsewhere],
    );

    expect(candidate(known, "play:4D").immediatePickupProbability).toBe(0);
    expect(
      candidate(uncertain, "play:4D").immediatePickupProbability,
    ).toBeCloseTo(0.5, 12);
    expect(candidate(known, "play:QD").immediatePickupProbability).toBe(1);
  });
});
