import { describe, expect, it } from "vitest";

import { createActorObservation } from "../../src/agents/observation";
import { getBaselinePolicy } from "../../src/agents/policies";
import { sortCards, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import type { Seat } from "../../src/domain/seats";
import { stableHash } from "../../src/events/stable-hash";
import { createSeededRng } from "../../src/random/keyed-rng";
import { applyExactHandEvent } from "../../src/rules/exact-hand-transition";
import { assertPublicStateInvariant } from "../../src/rules/state-invariant";
import {
  analyzeScenarioSetForTesting,
  DEFAULT_SOLVER_SEEDS,
  SearchError,
  solverBudget,
  type ActionEstimate,
  type BaselineRecommendation,
  type SearchScenario,
} from "../../src/search";
import { runTerminalRollout } from "../../src/search/rollout";
import type { TerminalRolloutInput } from "../../src/search/rollout";
import type { PublicInformationState } from "../../src/public/public-state";
import { makeExactPublicState } from "../support/state-builders";

type ExactHands = Record<Seat, Card[]>;

const DETERMINISTIC_POLICIES = {
  userContinuation: "always-high",
  p2: "always-high",
  p3: "always-high",
} as const;

const TOY_RULES = {
  ...CANONICAL_RULES,
  zeroCardsWithPower: {
    ...CANONICAL_RULES.zeroCardsWithPower,
    mode: "immediate-escape",
  },
  twoPlayer: "normal",
} as const satisfies RuleConfig;

function hands(
  user: readonly Card[],
  p2: readonly Card[],
  p3: readonly Card[],
): ExactHands {
  return {
    user: [...user],
    p2: [...p2],
    p3: [...p3],
  };
}

function exactState(
  exactHands: ExactHands,
  rules: RuleConfig = TOY_RULES,
): PublicInformationState {
  return makeExactPublicState({
    hands: exactHands,
    power: "user",
    rules,
  });
}

function partiallyKnownState(
  witness: ExactHands,
  known: Readonly<{ p2: readonly Card[]; p3: readonly Card[] }>,
  rules: RuleConfig = TOY_RULES,
): PublicInformationState {
  const state = exactState(witness, rules);
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

function scenarios(exactHands: readonly ExactHands[]): SearchScenario[] {
  return exactHands.map((currentHands, index) => ({
    witnessId: stableHash({
      fixture: "phase5-strategy",
      index,
      currentHands,
    }),
    currentHands,
  }));
}

function analyze(
  publicState: PublicInformationState,
  exactHands: readonly ExactHands[],
  options: Readonly<{
    method?: "exact-enumeration" | "direct-uniform-sample";
    uniqueWitnesses?: number;
    rolloutsPerWorld?: number;
    shouldCancel?: () => boolean;
  }> = {},
): BaselineRecommendation {
  const materialized = scenarios(exactHands);
  const method = options.method ?? "exact-enumeration";
  return analyzeScenarioSetForTesting({
    publicState,
    historyHash: stableHash({
      fixture: "phase5-strategy-history",
      publicState,
    }),
    stateVersion: 0,
    scenarios: materialized,
    belief: {
      method,
      totalInitialDealWorlds:
        method === "exact-enumeration"
          ? exactHands.length.toString()
          : "1000000000",
      worldSetChecksum: stableHash(materialized),
      uniqueWitnesses:
        options.uniqueWitnesses ??
        new Set(materialized.map((scenario) => scenario.witnessId)).size,
    },
    budget: solverBudget("instant", {
      worldSamples: exactHands.length,
      rolloutsPerWorld: options.rolloutsPerWorld ?? 1,
      maxEventsPerRollout: 256,
      intervalResamples: 64,
      deadlineMs: 60_000,
    }),
    policies: DETERMINISTIC_POLICIES,
    seeds: DEFAULT_SOLVER_SEEDS,
    ...(options.shouldCancel === undefined
      ? {}
      : { shouldCancel: options.shouldCancel }),
  });
}

function candidate(
  recommendation: BaselineRecommendation,
  actionKey: string,
): ActionEstimate {
  const result = recommendation.payload.candidates.find(
    (value) => value.actionKey === actionKey,
  );
  if (result === undefined) {
    throw new Error(`Missing candidate ${actionKey}.`);
  }
  return result;
}

function rolloutInput(
  publicState: PublicInformationState,
  exactHands: ExactHands,
  action: TerminalRolloutInput["action"],
  overrides: Partial<TerminalRolloutInput> = {},
): TerminalRolloutInput {
  return {
    publicState,
    exactHands,
    action,
    scenarioOccurrence: 0,
    replicate: 0,
    seeds: DEFAULT_SOLVER_SEEDS,
    policies: DETERMINISTIC_POLICIES,
    budget: solverBudget("instant", {
      maxEventsPerRollout: 256,
      intervalResamples: 16,
      deadlineMs: 60_000,
    }),
    ...overrides,
  };
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to throw.");
}

describe("Phase 5 strategic terminal traps", () => {
  it("solves the deterministic diamond trap instead of optimizing the immediate card count", () => {
    const world = hands(["4D", "QD"], ["JD"], ["2C"]);
    const recommendation = analyze(exactState(world), [world]);
    const lowLead = candidate(recommendation, "play:4D");
    const queenLead = candidate(recommendation, "play:QD");

    expect(recommendation.payload.recommendedActionKey).toBe("play:4D");
    expect(lowLead).toMatchObject({
      bhabhiProbability: 0,
      safeProbability: 1,
      immediatePickupProbability: 0,
    });
    expect(lowLead.bhabhiBySeat.p2).toBe(1);
    expect(queenLead).toMatchObject({
      bhabhiProbability: 1,
      safeProbability: 0,
      immediatePickupProbability: 1,
    });
    expect(queenLead.bhabhiBySeat.user).toBe(1);
  });

  it("recognizes that the only non-losing lead can be the singleton void option", () => {
    const world = hands(["2C", "4D", "5D"], ["AC", "3C"], ["KC", "4C"]);
    const recommendation = analyze(exactState(world), [world]);

    expect(recommendation.payload.recommendedActionKey).toBe("play:2C");
    expect(candidate(recommendation, "play:2C").bhabhiProbability).toBe(0);
    expect(candidate(recommendation, "play:4D").bhabhiProbability).toBe(1);
    expect(candidate(recommendation, "play:5D").bhabhiProbability).toBe(1);
  });

  it("reports immediate pickup separately from full-game loss risk", () => {
    const world = hands(
      ["7C", "QS", "9S"],
      ["2H", "TD", "TS"],
      ["AS", "JS", "2C"],
    );
    const recommendation = analyze(exactState(world), [world]);
    const club = candidate(recommendation, "play:7C");
    const queen = candidate(recommendation, "play:QS");
    const nine = candidate(recommendation, "play:9S");

    expect(club).toMatchObject({
      immediatePickupProbability: 1,
      bhabhiProbability: 0,
    });
    expect(queen.bhabhiProbability).toBe(0);
    expect(nine).toMatchObject({
      immediatePickupProbability: 0,
      bhabhiProbability: 1,
    });
    expect(recommendation.payload.recommendedActionKey).not.toBe("play:9S");
  });

  it("reverses the preferred rank when the next player's exact response changes", () => {
    const worldA = hands(["QC", "4D"], ["JC", "JD"], ["2H"]);
    const resultA = analyze(exactState(worldA), [worldA]);
    expect(candidate(resultA, "play:QC").bhabhiProbability).toBe(1);
    expect(candidate(resultA, "play:4D").bhabhiProbability).toBe(0);
    expect(resultA.payload.recommendedActionKey).toBe("play:4D");

    const worldB = hands(["QC", "4D"], ["KC", "3D"], ["2H"]);
    const resultB = analyze(exactState(worldB), [worldB]);
    expect(candidate(resultB, "play:QC").bhabhiProbability).toBe(0);
    expect(candidate(resultB, "play:4D").bhabhiProbability).toBe(1);
    expect(resultB.payload.recommendedActionKey).toBe("play:QC");
  });

  it("preserves which opponent escapes first and who reaches heads-up play", () => {
    const world = hands(["4C", "QD"], ["JC"], ["JD"]);
    const state = exactState(world);

    const club = runTerminalRollout(
      rolloutInput(state, world, { kind: "play-card", card: "4C" }),
    );
    expect(club.terminal).toMatchObject({
      bhabhi: "p2",
      firstOpponentEscape: "p3",
      userHeadsUpOpponent: "p2",
    });
    expect(club.terminal.loss.user).toBe(0);

    const diamond = runTerminalRollout(
      rolloutInput(state, world, { kind: "play-card", card: "QD" }),
    );
    expect(diamond.terminal).toMatchObject({
      bhabhi: "user",
      firstOpponentEscape: "p2",
      userHeadsUpOpponent: "p3",
    });
    expect(diamond.terminal.loss.user).toBe(1);
  });

  it("uses a self-interested opponent policy rather than an anti-user collusion oracle", () => {
    const world = hands(["2D", "JC", "8D"], ["5C", "TH"], ["QH", "2C", "AD"]);
    const rules = {
      ...TOY_RULES,
      twoPlayer: "pagat-shootout",
    } as const satisfies RuleConfig;
    const state = exactState(world, rules);
    const afterRoot = applyExactHandEvent(
      { publicState: state, hands: world },
      {
        type: "card-played",
        schemaVersion: 1,
        seat: "user",
        card: "2D",
      },
    );
    const observation = createActorObservation(
      {
        publicState: afterRoot.publicState,
        exactHands: afterRoot.hands,
      },
      "p2",
      0,
    );
    const choice = getBaselinePolicy("always-high").chooseCard(
      observation,
      createSeededRng(DEFAULT_SOLVER_SEEDS.rollout).fork(
        "terminal-root-rollout",
        "replicate",
        0,
        "policy",
        "p2",
        "decision",
        0,
        "card",
      ),
    );

    expect(observation.ownHand).toEqual(["5C", "TH"]);
    expect(observation.legalCards).toEqual(["5C", "TH"]);
    expect(choice).toMatchObject({
      card: "TH",
      rationale: "highest-rank-legal",
    });

    const outcome = runTerminalRollout(
      rolloutInput(state, world, {
        kind: "play-card",
        card: "2D",
      }),
    );

    // P2 sheds its own highest legal off-suit card; it is not allowed to
    // substitute a hidden-truth action chosen solely to maximize user loss.
    expect(outcome.terminal.bhabhi).toBe("p3");
    expect(outcome.terminal.loss.user).toBe(0);
  });
});

describe("correlated hidden worlds and occurrence weighting", () => {
  const world1 = hands(["4D", "QD"], ["2D", "JD"], ["2C", "3C"]);
  const world2 = hands(["4D", "QD"], ["2D", "2C"], ["JD", "3C"]);
  const world3 = hands(["4D", "QD"], ["2D", "3C"], ["JD", "2C"]);
  const publicState = partiallyKnownState(
    world1,
    { p2: ["2D"], p3: [] },
    TOY_RULES,
  );

  it("evaluates whole correlated worlds without multiplying incompatible marginals", () => {
    const recommendation = analyze(publicState, [world1, world2, world3]);
    const lowLead = candidate(recommendation, "play:4D");
    const queenLead = candidate(recommendation, "play:QD");

    expect(lowLead.bhabhiProbability).toBe(0);
    expect(lowLead.immediatePickupProbability).toBe(0);
    expect(queenLead.bhabhiProbability).toBe(1);
    expect(queenLead.immediatePickupProbability).toBeCloseTo(1 / 3, 12);
    expect(recommendation.payload.recommendedActionKey).toBe("play:4D");
    expect(recommendation.payload.belief.materializedWorldOccurrences).toBe(3);
  });

  it("retains duplicate sampled occurrences and therefore their probability mass", () => {
    const recommendation = analyze(publicState, [world1, world1, world2], {
      method: "direct-uniform-sample",
      uniqueWitnesses: 2,
    });
    const queenLead = candidate(recommendation, "play:QD");

    expect(recommendation.payload.belief).toMatchObject({
      method: "direct-uniform-sample",
      materializedWorldOccurrences: 3,
      uniqueWitnesses: 2,
    });
    expect(recommendation.payload.rollout.perAction).toBe(3);
    expect(queenLead.scenarioClusters).toBe(3);
    expect(queenLead.immediatePickupProbability).toBeCloseTo(2 / 3, 12);
    expect(recommendation.payload.warnings).toContain(
      "Duplicate sampled world occurrences are retained by design.",
    );
  });
});

describe("chance nodes, common random numbers, and visible failures", () => {
  const DRAW_RULES = {
    ...TOY_RULES,
    zeroCardsWithPower: {
      mode: "draw-from-player",
      drawFromTarget: "next-active",
      configuredTarget: null,
    },
  } as const satisfies RuleConfig;
  const chanceWorld = hands(["AH"], ["2H", "2C", "AC"], ["3H", "5C"]);
  const chanceState = exactState(chanceWorld, DRAW_RULES);

  it("samples only the exact source hand and is reproducible for each keyed replicate", () => {
    const observed = new Map<Card, Set<number>>();

    for (let replicate = 0; replicate < 32; replicate += 1) {
      const expectedDraw = createSeededRng(DEFAULT_SOLVER_SEEDS.chance)
        .fork(
          "terminal-root-rollout",
          "scenario",
          0,
          "replicate",
          replicate,
          "chance",
          0,
          "player-draw",
          "user",
          "p2",
        )
        .pick(sortCards(["2C", "AC"]));
      const input = rolloutInput(
        chanceState,
        chanceWorld,
        { kind: "play-card", card: "AH" },
        { replicate },
      );
      const first = runTerminalRollout(input);
      const replay = runTerminalRollout(input);

      expect(first).toEqual(replay);
      expect(first.deterministicHash).toBe(replay.deterministicHash);
      expect(first.chanceCount).toBeGreaterThanOrEqual(1);
      const losses = observed.get(expectedDraw) ?? new Set<number>();
      losses.add(first.terminal.loss.user);
      observed.set(expectedDraw, losses);
    }

    expect([...observed.keys()].sort()).toEqual(["2C", "AC"]);
    expect(observed.get("2C")).toEqual(new Set([0]));
    expect(observed.get("AC")).toEqual(new Set([1]));
  });

  it("keeps fixed rollout quotas independent of duplicate-world outcomes", () => {
    const duplicateRecommendation = analyze(
      partiallyKnownState(
        chanceWorld,
        { p2: ["2H"], p3: ["3H", "5C"] },
        DRAW_RULES,
      ),
      [chanceWorld, chanceWorld],
      {
        method: "direct-uniform-sample",
        uniqueWitnesses: 1,
        rolloutsPerWorld: 4,
      },
    );

    // The retained duplicate clusters receive identical fixed rollout quotas
    // rather than adaptive, action-dependent sampling.
    expect(duplicateRecommendation.payload.rollout).toMatchObject({
      scenarios: 2,
      replicatesPerScenario: 4,
      perAction: 8,
      failures: 0,
      eventCapHits: 0,
    });
    expect(
      duplicateRecommendation.payload.candidates.every(
        (value) => value.terminalRollouts === 8,
      ),
    ).toBe(true);
  });

  it("uses one future user strategy at the same information set across hidden worlds", () => {
    const worldA = hands(["QD", "4C", "5C"], ["JD", "2H"], ["TD", "3S"]);
    const worldB = hands(["QD", "4C", "5C"], ["JD", "3S"], ["TD", "2H"]);
    const publicState = partiallyKnownState(worldA, {
      p2: ["JD"],
      p3: ["TD"],
    });

    const reachNextUserDecision = (world: ExactHands) => {
      let exact = {
        publicState,
        hands: world,
      };
      for (const [seat, card] of [
        ["user", "QD"],
        ["p2", "JD"],
        ["p3", "TD"],
      ] as const) {
        exact = applyExactHandEvent(exact, {
          type: "card-played",
          schemaVersion: 1,
          seat,
          card,
        });
      }
      expect(exact.publicState.turn).toBe("user");
      return createActorObservation(
        {
          publicState: exact.publicState,
          exactHands: exact.hands,
        },
        "user",
        1,
      );
    };

    const observationA = reachNextUserDecision(worldA);
    const observationB = reachNextUserDecision(worldB);
    expect(observationA).toEqual(observationB);

    const choiceAtInformationSet = (observation: typeof observationA): Card => {
      const decisionRng = createSeededRng(DEFAULT_SOLVER_SEEDS.rollout).fork(
        "terminal-root-rollout",
        "replicate",
        0,
        "policy",
        "user",
        "decision",
        1,
      );
      return getBaselinePolicy("random").chooseCard(
        observation,
        decisionRng.fork("card"),
      ).card;
    };
    expect(choiceAtInformationSet(observationA)).toBe(
      choiceAtInformationSet(observationB),
    );
  });

  it("throws a typed event-cap failure instead of returning a partial estimate", () => {
    const world = hands(["4D", "QD"], ["JD"], ["2C"]);
    const input = rolloutInput(
      exactState(world),
      world,
      { kind: "play-card", card: "4D" },
      {
        budget: solverBudget("instant", {
          maxEventsPerRollout: 1,
          intervalResamples: 16,
          deadlineMs: 60_000,
        }),
      },
    );

    const error = thrownBy(() => runTerminalRollout(input));
    expect(error).toBeInstanceOf(SearchError);
    if (!(error instanceof SearchError)) {
      throw new Error("Expected a SearchError.");
    }
    expect(error).toMatchObject({
      name: "SearchError",
      code: "ROLLOUT_EVENT_CAP",
      details: {
        scenarioOccurrence: 0,
        replicate: 0,
        action: { kind: "play-card", card: "4D" },
      },
    });
  });

  it("surfaces cancellation before and during deterministic work", () => {
    const world = hands(["4D", "QD"], ["JD"], ["2C"]);
    const immediate = thrownBy(() =>
      runTerminalRollout(
        rolloutInput(
          exactState(world),
          world,
          { kind: "play-card", card: "4D" },
          { shouldCancel: () => true },
        ),
      ),
    );
    expect(immediate).toBeInstanceOf(SearchError);
    if (!(immediate instanceof SearchError)) {
      throw new Error("Expected a SearchError.");
    }
    expect(immediate.code).toBe("CANCELLED");

    let cancellationPolls = 0;
    const during = thrownBy(() =>
      analyze(exactState(world), [world], {
        shouldCancel: () => {
          cancellationPolls += 1;
          return cancellationPolls >= 3;
        },
      }),
    );
    expect(during).toBeInstanceOf(SearchError);
    if (!(during instanceof SearchError)) {
      throw new Error("Expected a SearchError.");
    }
    expect(during.code).toBe("CANCELLED");
    expect(cancellationPolls).toBeGreaterThanOrEqual(3);
  });
});
