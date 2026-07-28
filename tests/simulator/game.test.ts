import { describe, expect, it } from "vitest";

import { FULL_DECK, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES } from "../../src/domain/rule-config";
import { SEATS, type Seat } from "../../src/domain/seats";
import { stableHash } from "../../src/events/stable-hash";
import { replayEvents, semanticHistoryHash } from "../../src/events/timeline";
import { cardsInPendingAction } from "../../src/public/public-state";
import {
  DEFAULT_MAX_GAME_EVENTS,
  SimulationRunError,
  createPolicyObservation,
  createSeededDeal,
  simulateCompleteGame,
  type ConcreteDeal,
  type SimulationGameConfig,
  type SimulationGameResult,
} from "../../src/simulator/game";
import {
  BASELINE_POLICY_IDS,
  getBaselinePolicy,
  type SimulatorPolicy,
} from "../../src/simulator/policies";
import { createSimulationTruth } from "../../src/simulator/truth";

function expectCompleteDeck(cards: readonly Card[]): void {
  expect(cards).toHaveLength(FULL_DECK.length);
  expect(new Set(cards)).toHaveLength(FULL_DECK.length);
  expect(new Set(cards)).toEqual(new Set(FULL_DECK));
}

function cardsAtTerminal(result: SimulationGameResult): Card[] {
  return [
    ...SEATS.flatMap((seat) => result.finalHands[seat]),
    ...(result.finalState.trick?.plays.map((play) => play.card) ?? []),
    ...result.finalState.waste,
    ...cardsInPendingAction(result.finalState.pendingAction),
  ];
}

function selfPlayConfig(
  policy: SimulatorPolicy,
  overrides: Partial<SimulationGameConfig> = {},
): SimulationGameConfig {
  const gameId = overrides.gameId ?? `self-play/${policy.id}`;
  return {
    gameId,
    seeds: {
      deal: "phase4/game/deal-all",
      policy: {
        user: `phase4/game/${policy.id}/user`,
        p2: `phase4/game/${policy.id}/p2`,
        p3: `phase4/game/${policy.id}/p3`,
      },
      chance: `phase4/game/${policy.id}/chance`,
    },
    policies: {
      user: policy,
      p2: policy,
      p3: policy,
    },
    ...overrides,
  };
}

function expectDealPartition(deal: ConcreteDeal): void {
  expectCompleteDeck(SEATS.flatMap((seat) => deal[seat]));
  expect(SEATS.map((seat) => deal[seat].length).sort()).toEqual([17, 17, 18]);
}

describe("seeded complete deals", () => {
  it("conserves all 52 cards and rotates whole 18/17/17 buckets", () => {
    const rotation0 = createSeededDeal("phase4/rotation-witness", 0);
    const rotation1 = createSeededDeal("phase4/rotation-witness", 1);
    const rotation2 = createSeededDeal("phase4/rotation-witness", 2);

    for (const deal of [rotation0, rotation1, rotation2]) {
      expectDealPartition(deal);
      expect(Object.isFrozen(deal)).toBe(true);
      expect(SEATS.every((seat) => Object.isFrozen(deal[seat]))).toBe(true);
    }

    expect(SEATS.map((seat) => rotation0[seat].length)).toEqual([18, 17, 17]);
    expect(SEATS.map((seat) => rotation1[seat].length)).toEqual([17, 18, 17]);
    expect(SEATS.map((seat) => rotation2[seat].length)).toEqual([17, 17, 18]);

    expect(rotation1).toEqual({
      user: rotation0.p3,
      p2: rotation0.user,
      p3: rotation0.p2,
    });
    expect(rotation2).toEqual({
      user: rotation0.p2,
      p2: rotation0.p3,
      p3: rotation0.user,
    });
    expect(createSeededDeal("phase4/rotation-witness", 0)).toEqual(rotation0);
    expect(createSeededDeal("phase4/another-deal", 0)).not.toEqual(rotation0);
  });
});

describe("baseline complete-game execution", () => {
  it.each(BASELINE_POLICY_IDS)(
    "completes invariant-safe %s self-play below the event cap",
    (policyId) => {
      const policy = getBaselinePolicy(policyId);
      const result = simulateCompleteGame(selfPlayConfig(policy));

      expect(result.status).toBe("complete");
      expect(result.eventCount).toBe(result.events.length);
      expect(result.eventCount).toBeLessThan(DEFAULT_MAX_GAME_EVENTS);
      expect(result.decisionCount).toBe(result.decisions.length);
      expect(result.decisionCount + result.chanceEvents.length + 1).toBe(
        result.eventCount,
      );
      expect(result.finalState.status).toBe("complete");
      expect(result.finalState.bhabhi).toBe(result.bhabhi);
      expect(result.finalState.activeSeats).toEqual([result.bhabhi]);
      expect(result.finalState.turn).toBeNull();
      expect(result.finalState.trick).toBeNull();
      expect(result.finalState.pendingAction).toBeNull();
      expect(result.escapeOrder.at(-1)).toBe(result.bhabhi);
      expect(new Set(result.escapeOrder)).toEqual(new Set(SEATS));
      expect(result.policies).toEqual({
        user: policyId,
        p2: policyId,
        p3: policyId,
      });
      expectCompleteDeck(cardsAtTerminal(result));

      for (const decision of result.decisions) {
        expect(decision.legalCards).toContain(decision.chosenCard);
        expect(result.events[decision.eventIndex]).toMatchObject({
          type: "card-played",
          seat: decision.seat,
          card: decision.chosenCard,
        });
      }
      for (const chance of result.chanceEvents) {
        expect(chance.eligibleCards).toContain(chance.chosenCard);
        expect(result.events[chance.eventIndex]).toMatchObject({
          card: chance.chosenCard,
        });
      }
    },
  );

  it("is byte-reproducible for the same deal, policy, and chance seeds", () => {
    const policy = getBaselinePolicy("noisy-mixture");
    const config = selfPlayConfig(policy, {
      gameId: "phase4/reproducibility-witness",
      seeds: {
        deal: "phase4/repro/deal",
        policy: {
          user: "phase4/repro/user",
          p2: "phase4/repro/p2",
          p3: "phase4/repro/p3",
        },
        chance: "phase4/repro/chance",
      },
    });

    const first = simulateCompleteGame(config);
    const second = simulateCompleteGame(config);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.events)).toBe(true);
    expect(Object.isFrozen(first.finalState)).toBe(true);
  });

  it("keeps actor policy and chance streams isolated from policy consumption", () => {
    const delegate = getBaselinePolicy("power-avoider");
    const makeBurningPolicy = (draws: number): SimulatorPolicy => ({
      id: "policy-consumption-probe",
      version: 1,
      chooseCard(observation, rng) {
        for (let draw = 0; draw < draws; draw += 1) {
          rng.nextUint64();
        }
        return delegate.chooseCard(observation, rng);
      },
    });
    const seeds = {
      deal: "deal-all",
      policy: {
        user: "stream-root",
        p2: "stream-root",
        p3: "stream-root",
      },
      chance: "stream-root",
    } as const;
    const withoutBurn = simulateCompleteGame(
      selfPlayConfig(makeBurningPolicy(0), {
        gameId: "phase4/stream-isolation",
        seeds,
      }),
    );
    const withBurn = simulateCompleteGame(
      selfPlayConfig(makeBurningPolicy(97), {
        gameId: "phase4/stream-isolation",
        seeds,
      }),
    );

    expect(withoutBurn.chanceEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(withBurn)).toBe(JSON.stringify(withoutBurn));

    const firstActorStreams = SEATS.map((seat) => {
      const record = withoutBurn.decisions.find(
        (decision) => decision.seat === seat && decision.decisionOrdinal === 0,
      );
      expect(record).toBeDefined();
      return record?.rngStreamId;
    });
    expect(new Set(firstActorStreams)).toHaveLength(SEATS.length);
    const allDecisionStreamIds = new Set(
      withoutBurn.decisions.map((decision) => decision.rngStreamId),
    );
    for (const chance of withoutBurn.chanceEvents) {
      expect(allDecisionStreamIds.has(chance.rngStreamId)).toBe(false);
    }
  });
});

describe("actor-safe policy observations", () => {
  it("is a deeply frozen detached view with no truth-only state shape", () => {
    const deal = createSeededDeal("actor-0", 0);
    const truth = createSimulationTruth(deal, CANONICAL_RULES);
    const seat = truth.publicState.turn;
    if (seat === null) {
      throw new Error("The initial simulation has no acting seat.");
    }
    expect(seat).not.toBe("user");

    const observation = createPolicyObservation(truth, seat, 0);
    const expectedKeys = [
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
    ];
    expect(Object.keys(observation).sort()).toEqual(expectedKeys);
    expect(observation.seat).toBe(seat);
    expect(observation.ownHand).toEqual(truth.hands[seat]);
    expect(observation.ownHand).not.toEqual(truth.hands.user);
    expect(observation.ownHand).not.toEqual(
      truth.hands[seat === "p2" ? "p3" : "p2"],
    );
    expect(observation.legalCards).toHaveLength(1);
    expect(observation.legalCards[0]).toBe("AS");

    const forbiddenKeys = new Set([
      "userHand",
      "knownOpponentCards",
      "unresolvedCards",
      "effects",
      "hands",
      "namespace",
      "publicState",
    ]);
    const visited = new Set<object>();
    const foundForbidden: string[] = [];
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object" || visited.has(value)) {
        return;
      }
      visited.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (forbiddenKeys.has(key)) {
          foundForbidden.push(key);
        }
        visit(child);
      }
    };
    visit(observation);
    expect(foundForbidden).toEqual([]);

    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.ownHand)).toBe(true);
    expect(Object.isFrozen(observation.rules.takeHand)).toBe(true);
    expect(Object.isFrozen(observation.currentSuitStatus[seat])).toBe(true);
    expect(() => {
      (observation.ownHand as Card[]).pop();
    }).toThrow(TypeError);
    expect(() => {
      (observation.handCounts as Record<Seat, number>)[seat] = 999;
    }).toThrow(TypeError);

    const truthHash = stableHash(truth);
    const mutableCopy = structuredClone(observation);
    (mutableCopy.ownHand as Card[]).pop();
    (mutableCopy.handCounts as Record<Seat, number>)[seat] = 999;
    expect(stableHash(truth)).toBe(truthHash);
    expect(observation.ownHand).toEqual(deal[seat]);
    expect(observation.handCounts[seat]).toBe(deal[seat].length);
  });
});

describe("complete-game replay and integrity hashes", () => {
  it("replays to the terminal state and binds all published hashes", () => {
    const result = simulateCompleteGame(
      selfPlayConfig(getBaselinePolicy("random"), {
        gameId: "phase4/replay-hash-witness",
        seeds: {
          deal: "phase4/replay/deal",
          policy: {
            user: "phase4/replay/user",
            p2: "phase4/replay/p2",
            p3: "phase4/replay/p3",
          },
          chance: "phase4/replay/chance",
        },
      }),
    );
    const replay = replayEvents(result.events);

    expect(replay.state).toEqual(result.finalState);
    expect(replay.semanticHash).toBe(result.semanticHistoryHash);
    expect(semanticHistoryHash(result.events)).toBe(result.semanticHistoryHash);
    expect(stableHash(replay.state)).toBe(result.terminalPublicStateHash);
    expect(
      stableHash({
        hands: result.finalHands,
        publicState: replay.state,
      }),
    ).toBe(result.terminalTruthHash);
    expect(
      stableHash({
        bhabhi: result.bhabhi,
        escapeOrder: result.escapeOrder,
        historyHash: result.semanticHistoryHash,
        terminalPublicStateHash: result.terminalPublicStateHash,
      }),
    ).toBe(result.outcomeHash);
    expect(result.finalState.appliedEventCount).toBe(result.eventCount);
    expect(
      result.finalState.effects.filter(
        (effect) => effect.type === "game-completed",
      ),
    ).toHaveLength(1);
  });

  it("raises a typed, contextual event-cap failure", () => {
    const gameId = "phase4/deliberate-event-cap";
    let caught: unknown = null;
    try {
      simulateCompleteGame(
        selfPlayConfig(getBaselinePolicy("always-low"), {
          gameId,
          maxEvents: 1,
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SimulationRunError);
    if (!(caught instanceof SimulationRunError)) {
      throw new Error("Expected a SimulationRunError.");
    }
    expect(caught).toMatchObject({
      name: "SimulationRunError",
      code: "EVENT_CAP",
      gameId,
      eventCount: 1,
    });
    expect(caught.message).toContain("1-event safety cap");
  });
});
