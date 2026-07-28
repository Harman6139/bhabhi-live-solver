import { describe, expect, it } from "vitest";

import { FULL_DECK, rankValue, suitOf } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import {
  correctTimelineEventRebased,
  type GameTimeline,
} from "../../src/events/timeline";
import { compileHardEvidence } from "../../src/inference/hard-evidence";
import { HardInferenceError } from "../../src/inference/error";
import {
  ownershipProbability,
  suitLengthDistribution,
} from "../../src/inference/queries";
import {
  COMPLETE_GAME_DEAL,
  COMPLETE_GAME_EVENTS,
} from "../support/complete-game";
import {
  TEMPORAL_EVENTS,
  hiddenOpponentTakeTimeline,
  play,
  setupWithUserHand,
  startingHand,
  temporalTimeline,
  timelineFrom,
} from "./test-fixtures";

describe("chronological hard evidence", () => {
  it("counts the full initial support with bigint and declared A♠ ownership", () => {
    const user18 = startingHand(["AS"], ["AH"], 18);
    const evidence18 = compileHardEvidence(
      timelineFrom(setupWithUserHand(user18), []),
    );
    expect(evidence18.support.totalWorldCount).toBe("2333606220");
    expect(evidence18.support.flexible).toBe(34);

    const user17 = startingHand(["AS"], ["AH"], 17);
    const evidence17 = compileHardEvidence(
      timelineFrom(setupWithUserHand(user17), []),
    );
    expect(evidence17.support.totalWorldCount).toBe("4537567650");

    const opponentUserHand = startingHand([], ["AS"], 18);
    const opponentAce = compileHardEvidence(
      timelineFrom(
        setupWithUserHand(opponentUserHand, CANONICAL_RULES, "p3"),
        [],
      ),
    );
    const aceConstraint = opponentAce.hiddenCards.find(
      (constraint) => constraint.card === "AS",
    );
    expect(aceConstraint?.origins.p2.allowed).toBe(false);
    expect(aceConstraint?.origins.p3.allowed).toBe(true);
    expect(opponentAce.support.totalWorldCount).toBe("1166803110");
  });

  it("records opening void and highest-card constraints at the action time", () => {
    const highestRules: RuleConfig = {
      ...CANONICAL_RULES,
      openingOffSuit: "highest",
    };
    const userHand = startingHand(
      [
        "AS",
        "3S",
        "4S",
        "5S",
        "6S",
        "7S",
        "8S",
        "9S",
        "TS",
        "JS",
        "QS",
        "KS",
        "TC",
        "JC",
        "QC",
        "KC",
        "AC",
        "TD",
      ],
      ["9H", "AH", "8H", "2S"],
      18,
    );
    const timeline = timelineFrom(setupWithUserHand(userHand, highestRules), [
      play("user", "AS"),
      play("p2", "9H"),
    ]);
    const evidence = compileHardEvidence(timeline);

    expect(evidence.voidObservations).toEqual([
      {
        eventIndex: 2,
        seat: "p2",
        suit: "spades",
        observedCard: "9H",
        kind: "opening-off-suit",
      },
    ]);
    const hiddenP2 = evidence.hiddenCards.filter(
      (constraint) => constraint.origins.p2.allowed,
    );
    expect(
      hiddenP2.every((constraint) => suitOf(constraint.card) !== "spades"),
    ).toBe(true);
    expect(
      hiddenP2.every(
        (constraint) => rankValue(constraint.card) <= rankValue("9H"),
      ),
    ).toBe(true);
    expect(
      evidence.hiddenCards.find((constraint) => constraint.card === "AH")
        ?.origins.p2.eliminatedBy?.code,
    ).toBe("opening-highest");
    expect(
      evidence.hiddenCards.find((constraint) => constraint.card === "2S")
        ?.origins.p2.eliminatedBy?.code,
    ).toBe("follow-suit-void");
    expect(
      evidence.hiddenCards.find((constraint) => constraint.card === "8H")
        ?.origins.p2.allowed,
    ).toBe(true);
  });

  it("restores only visibly acquired cards after a timed void", () => {
    const afterVoid = compileHardEvidence(temporalTimeline(5));
    expect(afterVoid.voidObservations).toEqual([
      {
        eventIndex: 5,
        seat: "p2",
        suit: "hearts",
        observedCard: "2C",
        kind: "normal-thulla",
      },
    ]);
    expect(suitLengthDistribution(afterVoid, "p2", "hearts").status).toBe(
      "known-void",
    );
    for (const card of afterVoid.finalState.unresolvedCards.filter(
      (candidate) => suitOf(candidate) === "hearts",
    )) {
      expect(ownershipProbability(afterVoid, "p2", card).numerator).toBe("0");
    }

    const afterPickup = compileHardEvidence(temporalTimeline(8));
    expect(afterPickup.finalState.knownOpponentCards.p2).toEqual([
      "3C",
      "KC",
      "4H",
    ]);
    expect(suitLengthDistribution(afterPickup, "p2", "hearts").status).toBe(
      "known-has",
    );
    expect(ownershipProbability(afterPickup, "p2", "4H").value).toBe(1);

    const afterDeparture = compileHardEvidence(temporalTimeline(9));
    expect(afterDeparture.finalState.trick?.plays[0]?.card).toBe("4H");
    expect(afterDeparture.finalState.knownOpponentCards.p2).toEqual([
      "3C",
      "KC",
    ]);
    expect(suitLengthDistribution(afterDeparture, "p2", "hearts").status).toBe(
      "known-void",
    );
    expect(ownershipProbability(afterDeparture, "p2", "4H").value).toBe(0);
  });

  it("restores exact suit ownership through a public waste draw", () => {
    const beforeDraw = compileHardEvidence({
      schemaVersion: 1,
      events: COMPLETE_GAME_EVENTS,
      cursor: 58,
      orphanedEvents: [],
    });
    expect(COMPLETE_GAME_EVENTS[58]).toMatchObject({
      type: "waste-card-drawn",
      seat: "user",
      card: "7D",
    });
    expect(suitLengthDistribution(beforeDraw, "user", "diamonds").status).toBe(
      "known-void",
    );

    const afterDraw = compileHardEvidence({
      schemaVersion: 1,
      events: COMPLETE_GAME_EVENTS,
      cursor: 59,
      orphanedEvents: [],
    });
    expect(suitLengthDistribution(afterDraw, "user", "diamonds").status).toBe(
      "known-has",
    );
    expect(afterDraw.finalState.userHand).toContain("7D");
    expect(afterDraw.finalState.trick?.forcedLeadCard).toBe("7D");
  });

  it("preserves pre-transfer lineage through an unrevealed opponent hand merge", () => {
    const takeRules: RuleConfig = {
      ...CANONICAL_RULES,
      takeHand: { mode: "next-active", configuredTargets: [] },
    };
    const reserved = ["KS", "QS", "2C", "KD", "QD"] as const;
    const setup = setupWithUserHand(
      startingHand(["AS", "2H", "2D"], reserved, 18),
      takeRules,
    );
    const beforeTake = timelineFrom(setup, [
      play("user", "AS"),
      play("p2", "KS"),
      play("p3", "QS"),
      play("user", "2H"),
      play("p2", "2C"),
      play("user", "2D"),
      play("p2", "KD"),
      play("p3", "QD"),
    ]);
    const beforeEvidence = compileHardEvidence(beforeTake);
    expect(suitLengthDistribution(beforeEvidence, "p2", "hearts").status).toBe(
      "known-void",
    );

    const afterTake = hiddenOpponentTakeTimeline();
    const afterEvidence = compileHardEvidence(afterTake);
    expect(afterEvidence.finalState.handCounts.p3).toBe(0);
    expect(suitLengthDistribution(afterEvidence, "p3", "hearts").status).toBe(
      "known-void",
    );
    expect(suitLengthDistribution(afterEvidence, "p2", "hearts").status).toBe(
      "known-has",
    );
    expect(BigInt(afterEvidence.support.totalWorldCount)).toBeGreaterThan(1n);

    const unresolvedHeart = afterEvidence.finalState.unresolvedCards.find(
      (card) => suitOf(card) === "hearts",
    );
    expect(unresolvedHeart).toBeDefined();
    if (unresolvedHeart !== undefined) {
      const constraint = afterEvidence.hiddenCards.find(
        (entry) => entry.card === unresolvedHeart,
      );
      expect(constraint?.origins.p2.allowed).toBe(false);
      expect(constraint?.origins.p3.allowed).toBe(true);
      expect(constraint?.origins.p3.currentLocation).toBe("p2");
    }
  });

  it("uses a full hand reveal as exact ownership evidence", () => {
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      takeHand: {
        mode: "configured",
        configuredTargets: ["p2"],
      },
    };
    const userHand = startingHand(["AS"], ["KS", "QS"], 18);
    const setup = setupWithUserHand(userHand, rules);
    const currentHidden = FULL_DECK.filter(
      (card) => !userHand.includes(card) && card !== "KS" && card !== "QS",
    );
    const revealedP2 = currentHidden.slice(0, 16);
    const timeline = timelineFrom(setup, [
      play("user", "AS"),
      play("p2", "KS"),
      play("p3", "QS"),
      {
        type: "hand-taken",
        schemaVersion: 1,
        actor: "user",
        target: "p2",
        revealedCards: revealedP2,
      },
    ]);
    const evidence = compileHardEvidence(timeline);

    expect(evidence.support.totalWorldCount).toBe("1");
    expect(evidence.finalState.handCounts.p2).toBe(0);
    expect(
      revealedP2.every((card) => evidence.finalState.userHand.includes(card)),
    ).toBe(true);
    for (const card of revealedP2) {
      expect(ownershipProbability(evidence, "user", card).value).toBe(1);
    }
  });

  it("rejects a later suit play when no acquisition followed the earlier void", () => {
    const reserved = ["KS", "QS", "2C", "AD", "KD", "KH"] as const;
    const setup = setupWithUserHand(
      startingHand(["AS", "2H", "2D"], reserved, 18),
    );
    const impossible = timelineFrom(setup, [
      play("user", "AS"),
      play("p2", "KS"),
      play("p3", "QS"),
      play("user", "2H"),
      play("p2", "2C"),
      play("user", "2D"),
      play("p2", "AD"),
      play("p3", "KD"),
      play("p2", "KH"),
    ]);

    expect(() => compileHardEvidence(impossible)).toThrow(
      expect.objectContaining({
        name: "HardInferenceError",
        code: "NO_VALID_WORLDS",
      }) as HardInferenceError,
    );
  });

  it("rebuilds from corrections and ignores redo/orphan tails", () => {
    const original = temporalTimeline(5);
    const originalEvidence = compileHardEvidence(original);
    expect(
      suitLengthDistribution(originalEvidence, "p2", "hearts").status,
    ).toBe("known-void");

    const correction = correctTimelineEventRebased(
      original,
      4,
      play("user", "3C"),
    ).timeline;
    const correctedEvidence = compileHardEvidence(correction);
    expect(correctedEvidence.historyHash).not.toBe(
      originalEvidence.historyHash,
    );
    expect(correctedEvidence.voidObservations).toHaveLength(0);
    const hiddenHeart = correctedEvidence.finalState.unresolvedCards.find(
      (card) => suitOf(card) === "hearts",
    );
    expect(hiddenHeart).toBeDefined();
    if (hiddenHeart !== undefined) {
      expect(
        ownershipProbability(correctedEvidence, "p2", hiddenHeart).value,
      ).toBeGreaterThan(0);
    }

    const undone: GameTimeline = {
      ...original,
      cursor: 5,
      orphanedEvents: [TEMPORAL_EVENTS[4]],
    };
    const clean: GameTimeline = {
      ...undone,
      events: undone.events.slice(0, undone.cursor),
      orphanedEvents: [],
    };
    expect(compileHardEvidence(undone)).toEqual(compileHardEvidence(clean));
  });

  it("never eliminates the concrete truth across every complete-game prefix", () => {
    for (let cursor = 1; cursor <= COMPLETE_GAME_EVENTS.length; cursor += 1) {
      const timeline: GameTimeline = {
        schemaVersion: 1,
        events: COMPLETE_GAME_EVENTS,
        cursor,
        orphanedEvents: [],
      };
      const evidence = compileHardEvidence(timeline);
      for (const constraint of evidence.hiddenCards) {
        const truthOwner = COMPLETE_GAME_DEAL.p2.includes(constraint.card)
          ? "p2"
          : "p3";
        expect(
          constraint.origins[truthOwner].allowed,
          `cursor=${cursor} card=${constraint.card} owner=${truthOwner}`,
        ).toBe(true);
      }
    }
  });
});
