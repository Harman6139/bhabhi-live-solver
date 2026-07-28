import { describe, expect, it } from "vitest";

import type { Card, Suit } from "../../src/domain/cards";
import { CANONICAL_RULES } from "../../src/domain/rule-config";
import { SEATS, type Seat } from "../../src/domain/seats";
import type { TrickPlay } from "../../src/public/public-state";
import {
  createPolicyObservation,
  createSeededDeal,
} from "../../src/simulator/game";
import {
  BASELINE_POLICY_IDS,
  baselinePolicyDefinitions,
  getBaselinePolicy,
  type PolicyObservation,
  type PolicyPublicTrick,
  type PublicSuitStatus,
} from "../../src/simulator/policies";
import { createSeededRng } from "../../src/simulator/rng";
import { createSimulationTruth } from "../../src/simulator/truth";

function unknownSuitStatuses(): Record<Seat, Record<Suit, PublicSuitStatus>> {
  return {
    user: {
      clubs: "unknown",
      diamonds: "unknown",
      hearts: "unknown",
      spades: "unknown",
    },
    p2: {
      clubs: "unknown",
      diamonds: "unknown",
      hearts: "unknown",
      spades: "unknown",
    },
    p3: {
      clubs: "unknown",
      diamonds: "unknown",
      hearts: "unknown",
      spades: "unknown",
    },
  };
}

function makePlay(
  seat: Seat,
  card: Card,
  eventIndex = 0,
  offSuit = false,
): TrickPlay {
  return { seat, card, eventIndex, offSuit };
}

function makeTrick(
  plays: readonly TrickPlay[],
  overrides: Partial<PolicyPublicTrick> = {},
): PolicyPublicTrick {
  return {
    kind: "normal",
    leader: "p2",
    leadSuit: plays[0]?.card.endsWith("H") ? "hearts" : "clubs",
    participants: ["p2", "user", "p3"],
    plays,
    forcedLeadCard: null,
    ...overrides,
  };
}

function makeObservation(
  overrides: Partial<PolicyObservation> = {},
): PolicyObservation {
  const ownHand = ["2C", "AC", "5D", "KD", "9H"] as const;
  return {
    schemaVersion: 1,
    seat: "user",
    decisionOrdinal: 3,
    rules: structuredClone(CANONICAL_RULES),
    phase: "normal",
    status: "active",
    startingCounts: { user: 18, p2: 17, p3: 17 },
    handCounts: { user: ownHand.length, p2: 12, p3: 11 },
    ownHand,
    legalCards: ["2C", "AC", "5D", "KD"],
    trick: null,
    waste: [],
    power: "p2",
    turn: "user",
    activeSeats: ["user", "p2", "p3"],
    escapeGroups: [],
    publicPlays: [],
    currentSuitStatus: unknownSuitStatuses(),
    lastPickup: null,
    ...overrides,
  };
}

function choose(
  policyId: (typeof BASELINE_POLICY_IDS)[number],
  observation: PolicyObservation,
  seed = "policy-test",
) {
  return getBaselinePolicy(policyId).chooseCard(
    observation,
    createSeededRng(seed),
  );
}

function recursivelyCollectKeys(value: unknown, keys = new Set<string>()) {
  if (value === null || typeof value !== "object") {
    return keys;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key);
    recursivelyCollectKeys(child, keys);
  }
  return keys;
}

function recursivelyCollectStrings(
  value: unknown,
  strings = new Set<string>(),
) {
  if (typeof value === "string") {
    strings.add(value);
  } else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      recursivelyCollectStrings(child, strings);
    }
  }
  return strings;
}

describe("baseline policy registry and common contract", () => {
  it("registers all nine versioned baseline policies exactly once", () => {
    expect(BASELINE_POLICY_IDS).toEqual([
      "random",
      "always-high",
      "always-low",
      "shortest-suit",
      "early-high-shedder",
      "power-avoider",
      "documented-basic",
      "noisy-mixture",
      "phase-switch",
    ]);
    expect(baselinePolicyDefinitions()).toEqual(
      BASELINE_POLICY_IDS.map((id) => ({ id, version: 1 })),
    );
    expect(new Set(BASELINE_POLICY_IDS).size).toBe(9);
    for (const id of BASELINE_POLICY_IDS) {
      expect(getBaselinePolicy(id)).toMatchObject({ id, version: 1 });
    }
  });

  it.each(BASELINE_POLICY_IDS)(
    "%s is legal, deterministic, permutation invariant, and non-mutating",
    (policyId) => {
      const observation = makeObservation();
      const permuted = makeObservation({
        ownHand: [...observation.ownHand].reverse(),
        legalCards: [...observation.legalCards].reverse(),
      });
      const before = structuredClone(observation);

      const first = choose(policyId, observation, "contract-seed");
      const repeated = choose(policyId, observation, "contract-seed");
      const fromPermutation = choose(policyId, permuted, "contract-seed");

      expect(observation.legalCards).toContain(first.card);
      expect(first).toEqual(repeated);
      expect(fromPermutation).toEqual(first);
      expect(observation).toEqual(before);
      expect(first.rationale.length).toBeGreaterThan(0);
    },
  );

  it.each(BASELINE_POLICY_IDS)(
    "%s returns the sole legal action without consuming its root RNG",
    (policyId) => {
      const observation = makeObservation({
        ownHand: ["7H", "AS"],
        legalCards: ["7H"],
      });
      const rng = createSeededRng("singleton");

      expect(getBaselinePolicy(policyId).chooseCard(observation, rng)).toEqual({
        card: "7H",
        rationale: "forced-singleton-legal-action",
      });
      expect(rng.counter).toBe(0n);
    },
  );

  it.each(BASELINE_POLICY_IDS)(
    "%s rejects a decision with no legal action",
    (policyId) => {
      expect(() =>
        choose(
          policyId,
          makeObservation({ legalCards: [] }),
          "empty-legal-set",
        ),
      ).toThrow(/no legal card|empty card collection|no candidate suit/iu);
    },
  );
});

describe("rank, suit, and phase heuristics", () => {
  it("always-high and always-low use rank with canonical suit tie-breaks", () => {
    const highObservation = makeObservation({
      ownHand: ["AH", "3S", "AD", "KC"],
      legalCards: ["AH", "3S", "AD", "KC"],
    });
    const lowObservation = makeObservation({
      ownHand: ["2H", "3S", "2C", "KD"],
      legalCards: ["2H", "3S", "2C", "KD"],
    });

    expect(choose("always-high", highObservation).card).toBe("AD");
    expect(choose("always-low", lowObservation).card).toBe("2C");
  });

  it("shortest-suit chooses the lowest rank in the shortest legal suit", () => {
    const observation = makeObservation({
      ownHand: ["2C", "3C", "4C", "5D", "KD", "2H", "9H"],
      legalCards: ["4C", "KD", "5D", "9H", "2H"],
    });

    // Diamonds and hearts both have two cards; canonical suit order breaks
    // the suit tie, then the lower diamond is selected.
    expect(choose("shortest-suit", observation)).toMatchObject({
      card: "5D",
      rationale: "lowest-card-from-shortest-legal-suit",
    });
  });

  it("early-high-shedder switches exactly at half its starting actions", () => {
    const onePriorPlay = makeObservation({
      startingCounts: { user: 4, p2: 4, p3: 4 },
      ownHand: ["2C", "AC"],
      legalCards: ["2C", "AC"],
      publicPlays: [makePlay("user", "3D")],
    });
    const twoPriorPlays = makeObservation({
      ...onePriorPlay,
      publicPlays: [makePlay("user", "3D", 0), makePlay("user", "4H", 1)],
    });

    expect(choose("early-high-shedder", onePriorPlay)).toMatchObject({
      card: "AC",
      rationale: "early-phase-high-card-shedding",
    });
    expect(choose("early-high-shedder", twoPriorPlays)).toMatchObject({
      card: "2C",
      rationale: "late-phase-low-card-play",
    });
  });

  it("power-avoider stays below the winner, minimizes forced power, and sheds off-suit", () => {
    const followedTrick = makeTrick([makePlay("p2", "9H")], {
      leadSuit: "hearts",
    });

    expect(
      choose(
        "power-avoider",
        makeObservation({
          ownHand: ["2H", "8H", "QH"],
          legalCards: ["2H", "8H", "QH"],
          trick: followedTrick,
        }),
      ),
    ).toMatchObject({
      card: "8H",
      rationale: "highest-card-that-stays-below-current-winner",
    });
    expect(
      choose(
        "power-avoider",
        makeObservation({
          ownHand: ["TH", "QH"],
          legalCards: ["TH", "QH"],
          trick: followedTrick,
        }),
      ),
    ).toMatchObject({
      card: "TH",
      rationale: "unavoidable-overtake-with-lowest-winning-card",
    });
    expect(
      choose(
        "power-avoider",
        makeObservation({
          ownHand: ["3C", "KD", "KS"],
          legalCards: ["3C", "KD", "KS"],
          trick: followedTrick,
        }),
      ),
    ).toMatchObject({
      card: "KD",
      rationale: "off-suit-cannot-take-power-so-shed-highest",
    });
    expect(
      choose(
        "power-avoider",
        makeObservation({
          ownHand: ["2C", "AC"],
          legalCards: ["2C", "AC"],
          trick: null,
        }),
      ),
    ).toMatchObject({
      card: "2C",
      rationale: "lead-low-to-limit-power-and-pickup-exposure",
    });
  });

  it("documented-basic handles opening waste, follow-suit, and public lead hazards", () => {
    const opening = makeObservation({
      phase: "opening",
      ownHand: ["2C", "5C", "KC", "3D", "8D", "QD", "2H", "QH"],
      legalCards: ["2C", "5C", "KC", "3D", "8D", "QD", "2H", "QH"],
      trick: makeTrick([makePlay("p2", "AS")], {
        kind: "opening",
        leadSuit: "spades",
      }),
    });
    expect(choose("documented-basic", opening)).toMatchObject({
      card: "QH",
      rationale: "opening-waste-high-from-shortest-suit",
    });

    const following = makeObservation({
      ownHand: ["2H", "8H", "QH"],
      legalCards: ["2H", "8H", "QH"],
      trick: makeTrick([makePlay("p2", "9H")], {
        leadSuit: "hearts",
      }),
    });
    expect(choose("documented-basic", following).card).toBe("8H");

    const statuses = unknownSuitStatuses();
    statuses.p2.clubs = "known-void";
    const lead = makeObservation({
      ownHand: ["2C", "3D", "6D", "4H", "5S"],
      legalCards: ["2C", "3D", "6D", "4H", "5S"],
      currentSuitStatus: statuses,
      lastPickup: {
        picker: "user",
        cards: ["4H", "JH"],
        thullaBy: "p3",
      },
    });
    expect(choose("documented-basic", lead)).toMatchObject({
      card: "5S",
      rationale: "public-void-pickup-aware-short-suit-low-lead",
    });
  });

  it("phase-switch changes from high-card play to heads-up power avoidance", () => {
    const trick = makeTrick([makePlay("p2", "9H")], {
      leadSuit: "hearts",
      participants: ["p2", "user"],
    });
    const common = {
      ownHand: ["2H", "8H", "QH"] as const,
      legalCards: ["2H", "8H", "QH"] as const,
      trick,
    };

    expect(
      choose(
        "phase-switch",
        makeObservation({
          ...common,
          activeSeats: ["user", "p2", "p3"],
        }),
      ),
    ).toMatchObject({
      card: "QH",
      rationale: "three-player-always-high-phase",
    });
    expect(
      choose(
        "phase-switch",
        makeObservation({ ...common, activeSeats: ["user", "p2"] }),
      ),
    ).toMatchObject({
      card: "8H",
      rationale:
        "heads-up-power-avoider-phase:highest-card-that-stays-below-current-winner",
    });
  });

  it("noisy-mixture deterministically reaches every documented component", () => {
    const observation = makeObservation();
    const seen = new Set<string>();

    for (let index = 0; index < 512; index += 1) {
      const rng = createSeededRng(`mixture-component-${index.toString()}`);
      const first = getBaselinePolicy("noisy-mixture").chooseCard(
        observation,
        rng,
      );
      const repeated = choose(
        "noisy-mixture",
        observation,
        `mixture-component-${index.toString()}`,
      );
      const match = /^noisy-mixture-([^:]+):/u.exec(first.rationale);

      expect(observation.legalCards).toContain(first.card);
      expect(repeated).toEqual(first);
      expect(rng.counter).toBe(0n);
      expect(match).not.toBeNull();
      if (match?.[1] !== undefined) {
        seen.add(match[1]);
      }
    }

    expect([...seen].sort()).toEqual(
      [
        "always-high",
        "always-low",
        "documented-basic",
        "early-high-shedder",
        "power-avoider",
        "random",
        "shortest-suit",
      ].sort(),
    );
  });
});

describe("actor-safe simulator observation", () => {
  it("contains only the actor's private cards and an immutable public shape", () => {
    const deal = createSeededDeal("actor-safe-observation");
    const truth = createSimulationTruth(deal, CANONICAL_RULES);
    const seat = truth.publicState.turn;
    if (seat === null) {
      throw new Error("A fresh simulator deal must have an opening actor.");
    }

    const observation = createPolicyObservation(truth, seat, 17);
    const rootKeys = Object.keys(observation).sort();
    const allKeys = recursivelyCollectKeys(observation);
    const allStrings = recursivelyCollectStrings(observation);
    const hiddenCards = SEATS.filter((candidate) => candidate !== seat).flatMap(
      (candidate) => deal[candidate],
    );

    expect(rootKeys).toEqual(
      [
        "activeSeats",
        "currentSuitStatus",
        "decisionOrdinal",
        "escapeGroups",
        "handCounts",
        "lastPickup",
        "legalCards",
        "legalTakeTargets",
        "ownHand",
        "phase",
        "power",
        "publicPlays",
        "rules",
        "schemaVersion",
        "seat",
        "startingCounts",
        "status",
        "trick",
        "turn",
        "waste",
      ].sort(),
    );
    expect(observation.ownHand).toEqual(deal[seat]);
    expect(observation.legalCards).toEqual(["AS"]);
    expect(hiddenCards.every((card) => !allStrings.has(card))).toBe(true);
    expect(
      [
        "hands",
        "namespace",
        "userHand",
        "knownOpponentCards",
        "unresolvedCards",
        "pendingAction",
        "effects",
        "bhabhi",
      ].every((forbidden) => !allKeys.has(forbidden)),
    ).toBe(true);

    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.ownHand)).toBe(true);
    expect(Object.isFrozen(observation.rules)).toBe(true);
    expect(Object.isFrozen(observation.currentSuitStatus[seat])).toBe(true);
    expect(() => (observation.ownHand as Card[]).push("2C")).toThrow(TypeError);

    const observedHand = [...observation.ownHand];
    truth.hands[seat].pop();
    expect(observation.ownHand).toEqual(observedHand);
  });
});
