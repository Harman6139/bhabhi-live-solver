import { describe, expect, it } from "vitest";

import { suitOf } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { stableStringify } from "../../src/events/stable-hash";
import type { GameTimeline } from "../../src/events/timeline";
import {
  buildHardBelief,
  buildHardBeliefFromEvidence,
} from "../../src/inference/belief";
import { binomial } from "../../src/inference/combinatorics";
import { compileHardEvidence } from "../../src/inference/hard-evidence";
import {
  assertHiddenWorldInvariant,
  currentHandsKey,
} from "../../src/inference/hidden-world";
import {
  conditionalOwnershipProbability,
  estimateWorldPredicate,
  jointOwnershipProbability,
  ownershipProbability,
  suitLengthDistribution,
} from "../../src/inference/queries";
import { COMPLETE_GAME_EVENTS } from "../support/complete-game";
import {
  hiddenOpponentTakeTimeline,
  setupWithUserHand,
  startingHand,
  timelineFrom,
} from "./test-fixtures";

describe("correlated hard belief", () => {
  it("materializes reproducible uniformly ranked worlds without hidden truth", () => {
    const setup = setupWithUserHand(startingHand(["AS"], ["AH", "KH"], 18));
    const timeline = timelineFrom(setup, []);
    const config = {
      seed: "belief-repeatability",
      sampleCount: 128,
      forceSampling: true,
    };
    const first = buildHardBelief(timeline, config);
    const second = buildHardBelief(timeline, config);

    expect(first.method).toBe("direct-uniform-sample");
    expect(first.diagnostics.totalInitialDealWorlds).toBe("2333606220");
    expect(first.worlds).toHaveLength(128);
    expect(stableStringify(second)).toBe(stableStringify(first));
    expect(first.diagnostics.uniqueWitnesses).toBeGreaterThan(120);
    for (const world of first.worlds) {
      assertHiddenWorldInvariant(world, first.evidence);
      expect(world.initialHands.p2).toHaveLength(17);
      expect(world.initialHands.p3).toHaveLength(17);
    }

    const shorter = buildHardBelief(timeline, {
      ...config,
      sampleCount: 32,
    });
    expect(shorter.worlds.map((world) => world.witnessId)).toEqual(
      first.worlds.slice(0, 32).map((world) => world.witnessId),
    );
  });

  it("answers exact ownership and conditional queries from joint assignments", () => {
    const setup = setupWithUserHand(startingHand(["AS"], ["AH", "KH"], 18));
    const evidence = compileHardEvidence(timelineFrom(setup, []));
    const ownsAce = ownershipProbability(evidence, "p2", "AH");
    const ownsKing = ownershipProbability(evidence, "p2", "KH");
    const ownsBoth = jointOwnershipProbability(evidence, [
      { seat: "p2", card: "AH" },
      { seat: "p2", card: "KH" },
    ]);
    const kingGivenAce = conditionalOwnershipProbability(
      evidence,
      [{ seat: "p2", card: "KH" }],
      [{ seat: "p2", card: "AH" }],
    );

    expect(ownsAce.numerator).toBe(binomial(33, 16).toString());
    expect(ownsAce.denominator).toBe(binomial(34, 17).toString());
    expect(ownsAce.value).toBe(0.5);
    expect(ownsKing.value).toBe(0.5);
    expect(ownsBoth.numerator).toBe(binomial(32, 15).toString());
    expect(ownsBoth.value).not.toBe(ownsAce.value * ownsKing.value);
    expect(kingGivenAce.value).toBeCloseTo(16 / 33, 12);
  });

  it("matches exact world enumeration for marginals, joints, and suit lengths", () => {
    const timeline: GameTimeline = {
      schemaVersion: 1,
      events: COMPLETE_GAME_EVENTS,
      cursor: 40,
      orphanedEvents: [],
    };
    const belief = buildHardBelief(timeline);
    expect(belief.method).toBe("exact-enumeration");
    expect(belief.worlds).toHaveLength(56);
    const firstCard = belief.evidence.finalState.unresolvedCards[0];
    const secondCard = belief.evidence.finalState.unresolvedCards[1];
    if (firstCard === undefined || secondCard === undefined) {
      throw new Error("Exact query fixture requires two unresolved cards.");
    }

    const marginal = ownershipProbability(belief.evidence, "p2", firstCard);
    const marginalOracle = estimateWorldPredicate(belief, (world) =>
      world.currentHands.p2.includes(firstCard),
    );
    expect(marginal.numerator).toBe(String(marginalOracle.successes));
    expect(marginal.denominator).toBe(String(marginalOracle.trials));

    const joint = jointOwnershipProbability(belief.evidence, [
      { seat: "p2", card: firstCard },
      { seat: "p2", card: secondCard },
    ]);
    const jointOracle = estimateWorldPredicate(
      belief,
      (world) =>
        world.currentHands.p2.includes(firstCard) &&
        world.currentHands.p2.includes(secondCard),
    );
    expect(joint.numerator).toBe(String(jointOracle.successes));
    expect(joint.denominator).toBe(String(jointOracle.trials));

    for (const suit of ["clubs", "diamonds", "hearts", "spades"] as const) {
      const distribution = suitLengthDistribution(belief.evidence, "p2", suit);
      const oracle = new Map<number, number>();
      for (const world of belief.worlds) {
        const length = world.currentHands.p2.filter(
          (card) => suitOf(card) === suit,
        ).length;
        oracle.set(length, (oracle.get(length) ?? 0) + 1);
      }
      expect(
        distribution.probabilities.map((entry) => [
          entry.length,
          Number(entry.numerator),
        ]),
      ).toEqual([...oracle.entries()].sort(([left], [right]) => left - right));
    }
  });

  it("requires world, projection, and memory limits before exact enumeration", () => {
    const timeline: GameTimeline = {
      schemaVersion: 1,
      events: COMPLETE_GAME_EVENTS,
      cursor: 40,
      orphanedEvents: [],
    };
    const constrained = buildHardBelief(timeline, {
      seed: "exact-eligibility",
      sampleCount: 7,
      maxExactProjectionOperations: 1,
    });
    expect(constrained.method).toBe("direct-uniform-sample");
    expect(constrained.worlds).toHaveLength(7);
    expect(constrained.diagnostics.exactEnumerationEligible).toBe(false);
    expect(
      BigInt(constrained.diagnostics.estimatedExactProjectionOperations),
    ).toBeGreaterThan(1n);
  });

  it("retains initial witnesses when a hidden hand merge collapses current hands", () => {
    const belief = buildHardBelief(hiddenOpponentTakeTimeline(), {
      seed: "merged-current-hands",
      sampleCount: 256,
      forceSampling: true,
    });
    expect(BigInt(belief.diagnostics.totalInitialDealWorlds)).toBeGreaterThan(
      1n,
    );
    expect(belief.diagnostics.uniqueWitnesses).toBeGreaterThan(1);
    expect(belief.diagnostics.distinctCurrentHands).toBe(1);
    expect(new Set(belief.worlds.map(currentHandsKey)).size).toBe(1);
    expect(
      belief.worlds.every((world) => world.currentHands.p3.length === 0),
    ).toBe(true);
  });

  it("keeps initial user cards exact when an opponent takes the user hand", () => {
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      takeHand: {
        mode: "configured",
        configuredTargets: ["user"],
      },
    };
    const initialUserHand = startingHand(
      ["AS", "2D"],
      ["KS", "QS", "AD", "KD"],
      18,
    );
    const timeline = timelineFrom(setupWithUserHand(initialUserHand, rules), [
      {
        type: "card-played",
        schemaVersion: 1,
        seat: "user",
        card: "AS",
      },
      {
        type: "card-played",
        schemaVersion: 1,
        seat: "p2",
        card: "KS",
      },
      {
        type: "card-played",
        schemaVersion: 1,
        seat: "p3",
        card: "QS",
      },
      {
        type: "card-played",
        schemaVersion: 1,
        seat: "user",
        card: "2D",
      },
      {
        type: "card-played",
        schemaVersion: 1,
        seat: "p2",
        card: "AD",
      },
      {
        type: "card-played",
        schemaVersion: 1,
        seat: "p3",
        card: "KD",
      },
      {
        type: "hand-taken",
        schemaVersion: 1,
        actor: "p2",
        target: "user",
        revealedCards: [],
      },
    ]);
    const belief = buildHardBelief(timeline, {
      seed: "opponent-takes-user",
      sampleCount: 32,
      forceSampling: true,
    });
    const transferred = initialUserHand.filter(
      (card) => card !== "AS" && card !== "2D",
    );

    expect(belief.evidence.finalState.userHand).toEqual([]);
    expect(
      transferred.every((card) =>
        belief.evidence.finalState.knownOpponentCards.p2.includes(card),
      ),
    ).toBe(true);
    for (const world of belief.worlds) {
      expect(world.currentHands.user).toEqual([]);
      expect(
        transferred.every((card) => world.currentHands.p2.includes(card)),
      ).toBe(true);
      assertHiddenWorldInvariant(world, belief.evidence);
    }
  });

  it("recomputes checksums and evidence for a different active history", () => {
    const original: GameTimeline = {
      schemaVersion: 1,
      events: COMPLETE_GAME_EVENTS,
      cursor: 39,
      orphanedEvents: [],
    };
    const advanced: GameTimeline = { ...original, cursor: 40 };
    const first = buildHardBelief(original, {
      seed: "history-isolation",
      sampleCount: 64,
      forceSampling: true,
    });
    const second = buildHardBelief(advanced, {
      seed: "history-isolation",
      sampleCount: 64,
      forceSampling: true,
    });
    expect(second.evidence.historyHash).not.toBe(first.evidence.historyHash);
    expect(second.diagnostics.seedId).not.toBe(first.diagnostics.seedId);
    expect(second.diagnostics.worldSetChecksum).not.toBe(
      first.diagnostics.worldSetChecksum,
    );

    const rebuilt = buildHardBeliefFromEvidence(compileHardEvidence(advanced), {
      seed: "history-isolation",
      sampleCount: 64,
      forceSampling: true,
    });
    expect(stableStringify(rebuilt)).toBe(stableStringify(second));
  });
});
