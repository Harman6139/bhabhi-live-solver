import { describe, expect, it } from "vitest";

import { FULL_DECK, sortCards, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES } from "../../src/domain/rule-config";
import type { Seat } from "../../src/domain/seats";
import { stableStringify } from "../../src/events/stable-hash";
import { replayTimeline } from "../../src/events/timeline";
import { buildHardBelief } from "../../src/inference/belief";
import {
  applyTruthCardPlay,
  assertSimulationTruthInvariant,
  createSimulationTruth,
} from "../../src/simulator/truth";
import {
  play,
  setupWithUserHand,
  startingHand,
  timelineFrom,
} from "../inference/test-fixtures";

function truthDeal(
  user: readonly Card[],
  pool: readonly Card[],
  p2ExtraIndices: readonly number[],
): Readonly<Record<Seat, readonly Card[]>> {
  const p2Extras = p2ExtraIndices.map((index) => {
    const card = pool[index];
    if (card === undefined) {
      throw new Error(`Missing truth-pool card ${index}.`);
    }
    return card;
  });
  const p2 = ["KS" as const, ...p2Extras];
  const p3 = [
    "QS" as const,
    ...pool.filter((card) => !p2Extras.includes(card)),
  ];
  return {
    user: sortCards(user),
    p2: sortCards(p2),
    p3: sortCards(p3),
  };
}

describe("truth-firewall metamorphism", () => {
  it("builds byte-identical production belief under three consistent hidden truths", () => {
    const userHand = startingHand(["AS"], ["KS", "QS"], 18);
    const pool = FULL_DECK.filter(
      (card) => !userHand.includes(card) && card !== "KS" && card !== "QS",
    );
    expect(pool).toHaveLength(32);
    const deals = [
      truthDeal(
        userHand,
        pool,
        Array.from({ length: 16 }, (_value, index) => index),
      ),
      truthDeal(
        userHand,
        pool,
        Array.from({ length: 16 }, (_value, index) => index + 8),
      ),
      truthDeal(
        userHand,
        pool,
        Array.from({ length: 16 }, (_value, index) => index * 2),
      ),
    ];
    const setup = setupWithUserHand(userHand);
    const events = [
      play("user", "AS"),
      play("p2", "KS"),
      play("p3", "QS"),
    ] as const;
    const timeline = timelineFrom(setup, events);
    const publicReplay = replayTimeline(timeline);

    const truths = deals.map((deal) => {
      let truth = createSimulationTruth(deal, CANONICAL_RULES);
      events.forEach((event, index) => {
        truth = applyTruthCardPlay(truth, event, index + 1);
      });
      assertSimulationTruthInvariant(truth);
      expect(truth.publicState).toEqual(publicReplay.state);
      return truth;
    });
    expect(
      new Set(truths.map((truth) => stableStringify(truth.hands.p2))).size,
    ).toBe(3);

    const serializedBeliefs = truths.map(() =>
      stableStringify(
        buildHardBelief(timeline, {
          seed: "truth-firewall-fixed-seed",
          sampleCount: 96,
          forceSampling: true,
        }),
      ),
    );
    expect(new Set(serializedBeliefs).size).toBe(1);
  });
});
