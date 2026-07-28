import { describe, expect, it } from "vitest";

import { ACE_OF_SPADES, sortCards, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import type { GameEvent } from "../../src/events/game-events";
import { stableHash, stableStringify } from "../../src/events/stable-hash";
import {
  replayEvents,
  replayTimeline,
  semanticHistoryHash,
  type GameTimeline,
} from "../../src/events/timeline";
import { legalCardsForExactHand } from "../../src/rules/legal-actions";
import {
  projectActiveSimulationTimelineForUser,
  type EvaluationUserTimelinePolicyConfig,
  type EvaluationUserTimelinePolicyInput,
  type ScenarioSolverSeedSet,
} from "../../src/simulator/evaluation-user-policy";
import {
  createSeededDeal,
  simulateCompleteGame,
  type ConcreteDeal,
  type SimulationGameConfig,
} from "../../src/simulator/game";
import {
  getBaselinePolicy,
  type SimulatorPolicy,
} from "../../src/simulator/policies";
import { createSeededRng } from "../../src/simulator/rng";

const SOLVER_SEEDS: ScenarioSolverSeedSet = Object.freeze({
  belief: "phase7/firewall/belief",
  search: "phase7/firewall/search",
  rollout: "phase7/firewall/rollout",
  chance: "phase7/firewall/chance",
  bootstrap: "phase7/firewall/bootstrap",
});

type InvocationAudit = {
  readonly decisionOrdinal: number;
  readonly stateHash: string;
  readonly timeline: GameTimeline;
};

function simulationConfig(
  evaluationUserTimelinePolicy: EvaluationUserTimelinePolicyConfig,
  deal?: ConcreteDeal,
): SimulationGameConfig {
  const forbiddenFallback: SimulatorPolicy = {
    id: "forbidden-user-fallback",
    version: 1,
    chooseCard() {
      throw new Error(
        "The baseline user policy must not run while the timeline hook is configured.",
      );
    },
  };
  return {
    gameId: "phase7/evaluation-user-policy/firewall",
    ...(deal === undefined ? {} : { deal }),
    seeds: {
      deal: "phase7/evaluation-user-policy/deal",
      policy: {
        user: "phase7/evaluation-user-policy/user",
        p2: "phase7/evaluation-user-policy/p2",
        p3: "phase7/evaluation-user-policy/p3",
      },
      chance: "phase7/evaluation-user-policy/chance",
    },
    policies: {
      user: forbiddenFallback,
      p2: getBaselinePolicy("always-low"),
      p3: getBaselinePolicy("always-high"),
    },
    evaluationUserTimelinePolicy,
  };
}

function assertNoTruthShape(input: EvaluationUserTimelinePolicyInput): void {
  expect(Object.keys(input).sort()).toEqual([
    "observation",
    "solverSeeds",
    "timeline",
  ]);
  expect(input).not.toHaveProperty("deal");
  expect(input).not.toHaveProperty("hands");
  expect(input).not.toHaveProperty("truth");
  expect(input).not.toHaveProperty("publicState");
  expect(input.observation).not.toHaveProperty("hands");
  expect(input.observation).not.toHaveProperty("namespace");
  expect(input.observation).not.toHaveProperty("publicState");
  expect(stableStringify(input)).not.toContain("simulator-truth");
}

function firstLegalCard(input: EvaluationUserTimelinePolicyInput): Card {
  const card = input.observation.legalCards[0];
  if (card === undefined) {
    throw new Error("An active user observation has no legal card.");
  }
  return card;
}

describe("evaluation-only user timeline policy", () => {
  it("exposes only detached public replay, actor-safe observation, and solver seeds", () => {
    const audits: InvocationAudit[] = [];
    let factoryCalls = 0;
    const result = simulateCompleteGame(
      simulationConfig({
        solverSeeds: SOLVER_SEEDS,
        createPolicy() {
          factoryCalls += 1;
          return {
            id: "phase7-timeline-probe",
            version: 1,
            chooseAction(input) {
              assertNoTruthShape(input);
              expect(input.solverSeeds).toEqual(SOLVER_SEEDS);
              expect(input.timeline.cursor).toBe(input.timeline.events.length);
              expect(input.timeline.orphanedEvents).toEqual([]);
              expect(input.observation.seat).toBe("user");
              expect(input.observation.turn).toBe("user");

              const replay = replayTimeline(input.timeline);
              expect(replay.state.status).toBe("active");
              expect(replay.state.turn).toBe("user");
              expect(replay.state.pendingAction).toBeNull();
              expect(replay.state.userHand).toEqual(input.observation.ownHand);
              expect(input.observation.legalCards).toEqual(
                legalCardsForExactHand(
                  replay.state,
                  "user",
                  replay.state.userHand,
                ),
              );

              expect(Object.isFrozen(input)).toBe(true);
              expect(Object.isFrozen(input.timeline)).toBe(true);
              expect(Object.isFrozen(input.timeline.events)).toBe(true);
              expect(Object.isFrozen(input.observation)).toBe(true);
              expect(Object.isFrozen(input.observation.ownHand)).toBe(true);
              expect(Object.isFrozen(input.solverSeeds)).toBe(true);
              expect(() => {
                (
                  input.solverSeeds as {
                    belief: string;
                  }
                ).belief = "mutated";
              }).toThrow(TypeError);

              audits.push({
                decisionOrdinal: input.observation.decisionOrdinal,
                stateHash: stableHash(replay.state),
                timeline: input.timeline,
              });
              return {
                kind: "play-card",
                card: firstLegalCard(input),
                rationale: "truth-firewalled-first-legal",
              };
            },
          };
        },
      }),
    );

    expect(factoryCalls).toBe(1);
    expect(audits.length).toBeGreaterThan(0);
    expect(result.policies.user).toBe("phase7-timeline-probe");
    const userDecisions = result.decisions.filter(
      (decision) => decision.seat === "user",
    );
    expect(userDecisions).toHaveLength(audits.length);
    for (const [index, audit] of audits.entries()) {
      const decision = userDecisions[index];
      expect(decision).toBeDefined();
      expect(decision?.decisionOrdinal).toBe(audit.decisionOrdinal);
      expect(decision?.eventIndex).toBe(audit.timeline.events.length);
      expect(decision?.publicStateHashBefore).toBe(audit.stateHash);
      expect(decision?.policyId).toBe("phase7-timeline-probe");
      expect(semanticHistoryHash(audit.timeline.events)).toBe(
        replayTimeline(audit.timeline).semanticHash,
      );
    }

    const replay = replayEvents(result.events);
    expect(replay.state).toEqual(result.finalState);
    expect(replay.semanticHash).toBe(result.semanticHistoryHash);
    expect(stableHash(replay.state)).toBe(result.terminalPublicStateHash);
  });

  it("cannot distinguish consistent hidden deals at the same public history", () => {
    const baseSeed = "phase7/evaluation-user-policy/metamorphic";
    const baseDeal = ([0, 1, 2] as const)
      .map((rotation) => createSeededDeal(baseSeed, rotation))
      .find((deal) => deal.user.includes(ACE_OF_SPADES));
    if (baseDeal === undefined) {
      throw new Error("Deal rotations unexpectedly omitted the Ace of Spades.");
    }
    const p2Swap = baseDeal.p2[0];
    const p3Swap = baseDeal.p3[0];
    if (p2Swap === undefined || p3Swap === undefined) {
      throw new Error("Metamorphic opponent hands are unexpectedly empty.");
    }
    const alternateDeal: ConcreteDeal = {
      user: [...baseDeal.user],
      p2: sortCards([p3Swap, ...baseDeal.p2.slice(1)]),
      p3: sortCards([p2Swap, ...baseDeal.p3.slice(1)]),
    };
    expect(alternateDeal).not.toEqual(baseDeal);

    const firstInputs: string[] = [];
    const makeConfig = (): EvaluationUserTimelinePolicyConfig => ({
      solverSeeds: SOLVER_SEEDS,
      createPolicy: () => ({
        id: "phase7-metamorphic-probe",
        version: 1,
        chooseAction(input) {
          assertNoTruthShape(input);
          if (input.observation.decisionOrdinal === 0) {
            firstInputs.push(stableStringify(input));
          }
          return {
            kind: "play-card",
            card: firstLegalCard(input),
            rationale: "metamorphic-first-legal",
          };
        },
      }),
    });

    const first = simulateCompleteGame(
      simulationConfig(makeConfig(), baseDeal),
    );
    const second = simulateCompleteGame(
      simulationConfig(makeConfig(), alternateDeal),
    );

    expect(firstInputs).toHaveLength(2);
    expect(firstInputs[0]).toBe(firstInputs[1]);
    expect(first.decisions[0]).toMatchObject({
      seat: "user",
      decisionOrdinal: 0,
      chosenCard: ACE_OF_SPADES,
    });
    expect(second.decisions[0]).toMatchObject({
      seat: "user",
      decisionOrdinal: 0,
      chosenCard: ACE_OF_SPADES,
    });
    expect(first.decisions[0]?.observationHash).toBe(
      second.decisions[0]?.observationHash,
    );
    expect(first.decisions[0]?.publicStateHashBefore).toBe(
      second.decisions[0]?.publicStateHashBefore,
    );
  });

  it("withholds both eligible variants of an opponent draw until its forced lead is public", () => {
    const random = getBaselinePolicy("random");
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      twoPlayer: "normal",
      zeroCardsWithPower: {
        mode: "draw-from-player",
        drawFromTarget: "next-active",
        configuredTarget: null,
      },
    };
    const simulationSeeds = {
      deal: "scan-d-31",
      policy: {
        user: "u-31",
        p2: "2-31",
        p3: "3-31",
      },
      chance: "c-31",
    } as const;
    const baseline = simulateCompleteGame({
      gameId: "scan-31",
      rules,
      seeds: simulationSeeds,
      policies: {
        user: random,
        p2: random,
        p3: random,
      },
    });
    const drawIndex = baseline.events.findIndex(
      (event) =>
        event.type === "player-card-drawn" &&
        event.seat === "p2" &&
        event.source === "p3",
    );
    const drawEvent = baseline.events[drawIndex];
    const chance = baseline.chanceEvents.find(
      (candidate) => candidate.eventIndex === drawIndex,
    );
    if (
      drawIndex < 1 ||
      drawEvent?.type !== "player-card-drawn" ||
      chance === undefined
    ) {
      throw new Error(
        "Locked opponent-to-opponent draw witness is unavailable.",
      );
    }
    const alternateCard = chance.eligibleCards.find(
      (card) => card !== drawEvent.card,
    );
    if (alternateCard === undefined) {
      throw new Error("Locked draw witness has no alternate eligible card.");
    }
    const unresolved = baseline.events.slice(0, drawIndex + 1);
    const alternateUnresolved: GameEvent[] = unresolved.map((event, index) =>
      index === drawIndex ? { ...drawEvent, card: alternateCard } : event,
    );
    const privacyMessage =
      "Evaluation user timeline withheld an unresolved private opponent draw.";

    expect(() => projectActiveSimulationTimelineForUser(unresolved)).toThrow(
      privacyMessage,
    );
    expect(() =>
      projectActiveSimulationTimelineForUser(alternateUnresolved),
    ).toThrow(privacyMessage);

    const publicReveal = baseline.events[drawIndex + 1];
    expect(publicReveal).toMatchObject({
      type: "card-played",
      seat: drawEvent.seat,
      card: drawEvent.card,
    });
    const resolved = projectActiveSimulationTimelineForUser(
      baseline.events.slice(0, drawIndex + 2),
    );
    expect(replayTimeline(resolved).activeEvents).toEqual(resolved.events);

    const observedResolvedDraws = new Set<string>();
    const hooked = simulateCompleteGame({
      gameId: "scan-31",
      rules,
      seeds: simulationSeeds,
      policies: {
        user: {
          id: "forbidden-user-fallback",
          version: 1,
          chooseCard() {
            throw new Error("Timeline hook unexpectedly used its fallback.");
          },
        },
        p2: random,
        p3: random,
      },
      evaluationUserTimelinePolicy: {
        solverSeeds: {
          ...SOLVER_SEEDS,
          rollout: simulationSeeds.policy.user,
        },
        createPolicy: () => ({
          id: "phase7-random-replay-hook",
          version: 1,
          chooseAction(input) {
            for (
              let index = 0;
              index < input.timeline.events.length;
              index += 1
            ) {
              const event = input.timeline.events[index];
              if (
                event?.type !== "player-card-drawn" ||
                event.seat === "user" ||
                event.source === "user"
              ) {
                continue;
              }
              expect(input.timeline.events[index + 1]).toMatchObject({
                type: "card-played",
                seat: event.seat,
                card: event.card,
              });
              observedResolvedDraws.add(`${index.toString()}/${event.card}`);
            }
            const rng = createSeededRng(input.solverSeeds.rollout)
              .fork(
                "policy",
                "user",
                "decision",
                input.observation.decisionOrdinal,
              )
              .fork("card");
            const choice = random.chooseCard(input.observation, rng);
            return {
              kind: "play-card",
              card: choice.card,
              rationale: choice.rationale,
            };
          },
        }),
      },
    });

    expect(hooked.events).toEqual(baseline.events);
    expect(observedResolvedDraws).toContain(
      `${drawIndex.toString()}/${drawEvent.card}`,
    );
    expect(
      hooked.decisions.some(
        (decision) =>
          decision.seat === "user" && decision.eventIndex > drawIndex,
      ),
    ).toBe(true);
  });
});
