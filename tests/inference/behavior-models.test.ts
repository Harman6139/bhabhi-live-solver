import { describe, expect, it } from "vitest";

import type {
  PolicyObservation,
  PublicSuitStatus,
} from "../../src/agents/policies";
import { FULL_DECK, type Suit } from "../../src/domain/cards";
import { CANONICAL_RULES } from "../../src/domain/rule-config";
import type { Seat } from "../../src/domain/seats";
import {
  BEHAVIOR_MODEL_IDS,
  allBehaviorModelDistributions,
  behaviorModelDistribution,
  enumerateBehaviorActions,
  probabilityOfBehaviorAction,
  temperBehaviorLikelihoods,
  validateBehaviorModelConfig,
} from "../../src/inference/behavior-models";
import { HardInferenceError } from "../../src/inference/error";

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

function observation(
  overrides: Partial<PolicyObservation> = {},
): PolicyObservation {
  const ownHand = ["2C", "AC", "5D", "KD"] as const;
  return {
    schemaVersion: 1,
    seat: "p2",
    decisionOrdinal: 4,
    rules: structuredClone(CANONICAL_RULES),
    phase: "normal",
    status: "active",
    startingCounts: { user: 18, p2: 17, p3: 17 },
    handCounts: { user: 14, p2: ownHand.length, p3: 12 },
    ownHand,
    legalCards: ownHand,
    legalTakeTargets: [],
    trick: null,
    waste: [],
    power: "p2",
    turn: "p2",
    activeSeats: ["user", "p2", "p3"],
    escapeGroups: [],
    publicPlays: [],
    currentSuitStatus: unknownSuitStatuses(),
    lastPickup: null,
    ...overrides,
  };
}

function probabilityFor(
  modelId: (typeof BEHAVIOR_MODEL_IDS)[number],
  actionKey: string,
  input: PolicyObservation,
  lapseProbability = 0.2,
): number {
  const entry = behaviorModelDistribution(modelId, input, {
    lapseProbability,
  }).probabilities.find((candidate) => candidate.actionKey === actionKey);
  if (entry === undefined) {
    throw new Error(`Missing ${actionKey} in ${modelId}'s distribution.`);
  }
  return entry.probability;
}

describe("production behavior model family", () => {
  it("uses only uniform-random and deterministic in-family archetypes", () => {
    expect(BEHAVIOR_MODEL_IDS).toEqual([
      "random",
      "always-high",
      "always-low",
      "shortest-suit",
      "early-high-shedder",
      "power-avoider",
      "documented-basic",
    ]);
    expect(BEHAVIOR_MODEL_IDS).not.toContain("noisy-mixture");
    expect(BEHAVIOR_MODEL_IDS).not.toContain("phase-switch");
  });

  it("enumerates the full stable card-plus-take legal alternative set", () => {
    const input = observation({
      legalCards: ["KD", "2C", "AC"],
      legalTakeTargets: ["p3", "user"],
    });
    expect(
      enumerateBehaviorActions(input).map((action) =>
        action.kind === "play-card"
          ? `play:${action.card}`
          : `take:${action.target}`,
      ),
    ).toEqual(["play:2C", "play:AC", "play:KD", "take:user", "take:p3"]);

    const random = behaviorModelDistribution("random", input);
    expect(random.probabilities).toHaveLength(5);
    expect(
      random.probabilities.every((entry) => entry.probability === 0.2),
    ).toBe(true);
  });

  it("makes every model exactly neutral on a forced singleton decision", () => {
    const input = observation({
      ownHand: ["5D"],
      legalCards: ["5D"],
      legalTakeTargets: [],
      handCounts: { user: 14, p2: 1, p3: 12 },
    });
    const distributions = allBehaviorModelDistributions(input, {
      lapseProbability: 0.35,
      likelihoodPower: 0.2,
    });
    for (const modelId of BEHAVIOR_MODEL_IDS) {
      expect(distributions[modelId].probabilities).toEqual([
        {
          action: { kind: "play-card", card: "5D" },
          actionKey: "play:5D",
          probability: 1,
        },
      ]);
    }
  });

  it("assigns preferred mass plus uniform lapse and keeps every legal action positive", () => {
    const input = observation();
    const high = behaviorModelDistribution("always-high", input, {
      lapseProbability: 0.2,
    });
    const low = behaviorModelDistribution("always-low", input, {
      lapseProbability: 0.2,
    });

    expect(high.preferredActionKey).toBe("play:AC");
    expect(low.preferredActionKey).toBe("play:2C");
    expect(probabilityFor("always-high", "play:AC", input)).toBeCloseTo(0.85);
    expect(probabilityFor("always-high", "play:2C", input)).toBeCloseTo(0.05);
    expect(probabilityFor("always-low", "play:2C", input)).toBeCloseTo(0.85);
    expect(probabilityFor("always-low", "play:AC", input)).toBeCloseTo(0.05);
    for (const modelId of BEHAVIOR_MODEL_IDS) {
      const distribution = behaviorModelDistribution(modelId, input, {
        lapseProbability: 0.2,
      });
      expect(
        distribution.probabilities.every((entry) => entry.probability > 0),
      ).toBe(true);
      expect(
        distribution.probabilities.reduce(
          (sum, entry) => sum + entry.probability,
          0,
        ),
      ).toBeCloseTo(1, 14);
    }
  });

  it("updates gradually under repeated discretionary evidence without a zero-probability collapse", () => {
    const input = observation();
    let posterior = Object.fromEntries(
      BEHAVIOR_MODEL_IDS.map((modelId) => [
        modelId,
        1 / BEHAVIOR_MODEL_IDS.length,
      ]),
    ) as Record<(typeof BEHAVIOR_MODEL_IDS)[number], number>;
    const highPosterior: number[] = [];

    for (let decision = 0; decision < 8; decision += 1) {
      const likelihoods = BEHAVIOR_MODEL_IDS.map((modelId) =>
        probabilityFor(modelId, "play:AC", input, 0.2),
      );
      const temperedLikelihoods = temperBehaviorLikelihoods(likelihoods, {
        lapseProbability: 0.2,
        likelihoodPower: 0.5,
      }).temperedLikelihoods;
      const unnormalized = Object.fromEntries(
        BEHAVIOR_MODEL_IDS.map((modelId, modelIndex) => [
          modelId,
          posterior[modelId] * (temperedLikelihoods[modelIndex] ?? 0),
        ]),
      ) as Record<(typeof BEHAVIOR_MODEL_IDS)[number], number>;
      const total = BEHAVIOR_MODEL_IDS.reduce(
        (sum, modelId) => sum + unnormalized[modelId],
        0,
      );
      posterior = Object.fromEntries(
        BEHAVIOR_MODEL_IDS.map((modelId) => [
          modelId,
          unnormalized[modelId] / total,
        ]),
      ) as Record<(typeof BEHAVIOR_MODEL_IDS)[number], number>;
      highPosterior.push(posterior["always-high"]);
      expect(
        BEHAVIOR_MODEL_IDS.every((modelId) => posterior[modelId] > 0),
      ).toBe(true);
    }

    expect(highPosterior[0]).toBeGreaterThan(1 / BEHAVIOR_MODEL_IDS.length);
    expect(
      highPosterior.every(
        (value, index) =>
          index === 0 || value >= (highPosterior[index - 1] ?? 0),
      ),
    ).toBe(true);
    expect(highPosterior.at(-1)).toBeLessThan(1);
  });

  it("rejects illegal observed actions and invalid tempering or lapse configuration", () => {
    const distribution = behaviorModelDistribution(
      "always-high",
      observation(),
    );
    expect(() =>
      probabilityOfBehaviorAction(distribution, {
        kind: "play-card",
        card: "AS",
      }),
    ).toThrow(HardInferenceError);

    for (const invalid of [
      { likelihoodPower: 0 },
      { likelihoodPower: 1.01 },
      { maximumBayesFactor: 1 },
      { maximumBayesFactor: 4.01 },
      { lapseProbability: 0 },
      { lapseProbability: 1 },
      { modelPriors: { random: 0 } },
    ]) {
      expect(() => validateBehaviorModelConfig(invalid)).toThrow(
        HardInferenceError,
      );
    }
  });

  it("analytically caps every tempered one-decision Bayes factor at four", () => {
    const manyCards = FULL_DECK;
    const input = observation({
      ownHand: manyCards,
      legalCards: manyCards,
      handCounts: { user: 0, p2: manyCards.length, p3: 0 },
    });
    const distributions = allBehaviorModelDistributions(input, {
      lapseProbability: 0.01,
      likelihoodPower: 1,
      maximumBayesFactor: 4,
    });
    for (const observed of distributions.random.probabilities) {
      const likelihoods = BEHAVIOR_MODEL_IDS.map(
        (modelId) =>
          distributions[modelId].probabilities.find(
            (entry) => entry.actionKey === observed.actionKey,
          )?.probability ?? 0,
      );
      const tempered = temperBehaviorLikelihoods(likelihoods, {
        lapseProbability: 0.01,
        likelihoodPower: 1,
        maximumBayesFactor: 4,
      });
      expect(tempered.temperedBayesFactor).toBeLessThanOrEqual(
        4 + Number.EPSILON * 64,
      );
      expect(tempered.effectiveLikelihoodPower).toBeLessThanOrEqual(1);
    }
  });
});
