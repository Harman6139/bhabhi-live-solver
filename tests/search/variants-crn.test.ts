import { describe, expect, it } from "vitest";

import type { Card } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import type { Seat } from "../../src/domain/seats";
import { stableHash } from "../../src/events/stable-hash";
import {
  analyzeScenarioSetForTesting,
  DEFAULT_SOLVER_SEEDS,
  solverBudget,
} from "../../src/search";
import { runTerminalRollout } from "../../src/search/rollout";
import { makeExactPublicState } from "../support/state-builders";

type ExactHands = Record<Seat, Card[]>;

const HIGH_POLICIES = {
  userContinuation: "always-high",
  p2: "always-high",
  p3: "always-high",
} as const;

function exactHands(
  user: readonly Card[],
  p2: readonly Card[],
  p3: readonly Card[],
): ExactHands {
  return { user: [...user], p2: [...p2], p3: [...p3] };
}

function exactState(hands: ExactHands, rules: RuleConfig) {
  return makeExactPublicState({
    hands,
    power: "user",
    rules,
  });
}

describe("root take and waste-draw variants", () => {
  it("evaluates an enabled legal root take to terminal utility", () => {
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      takeHand: {
        mode: "configured",
        configuredTargets: ["p2"],
      },
      zeroCardsWithPower: {
        mode: "immediate-escape",
        drawFromTarget: "next-active",
        configuredTarget: null,
      },
      twoPlayer: "normal",
    };
    const hands = exactHands(["4D", "QD"], ["JD"], ["2C"]);
    const state = exactState(hands, rules);
    const scenario = {
      witnessId: "take-root-world",
      currentHands: hands,
    };
    const recommendation = analyzeScenarioSetForTesting({
      publicState: state,
      historyHash: stableHash({ fixture: "take-root", state }),
      stateVersion: 0,
      scenarios: [scenario],
      belief: {
        method: "exact-enumeration",
        totalInitialDealWorlds: "1",
        worldSetChecksum: stableHash([scenario]),
        uniqueWitnesses: 1,
      },
      budget: solverBudget("instant", {
        maxEventsPerRollout: 256,
        intervalResamples: 32,
        deadlineMs: 60_000,
      }),
      policies: HIGH_POLICIES,
    });
    const take = recommendation.payload.candidates.find(
      (candidate) => candidate.actionKey === "take:p2",
    );

    expect(recommendation.payload.legalActions).toContainEqual({
      kind: "take-hand",
      target: "p2",
    });
    expect(take).toBeDefined();
    expect(take).toMatchObject({
      terminalRollouts: 1,
      immediatePickupProbability: 0,
      expectedImmediatePickupCount: 0,
      immediatePowerProbability: 1,
    });
    expect(recommendation.payload.warnings).toContain(
      "Bundled continuation policies decline optional future take-hand actions; every legal root take is still evaluated.",
    );
  });

  it("resolves a zero-power waste draw as a reproducible chance node", () => {
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      takeHand: { mode: "disabled", configuredTargets: [] },
      zeroCardsWithPower: {
        mode: "waste-draw",
        drawFromTarget: "next-active",
        configuredTarget: null,
      },
      twoPlayer: "normal",
    };
    const hands = exactHands(["AH"], ["2H", "2C"], ["3H", "3C"]);
    const state = exactState(hands, rules);
    const input = {
      publicState: state,
      exactHands: hands,
      action: { kind: "play-card", card: "AH" } as const,
      scenarioOccurrence: 7,
      replicate: 3,
      seeds: DEFAULT_SOLVER_SEEDS,
      policies: HIGH_POLICIES,
      budget: solverBudget("instant", {
        maxEventsPerRollout: 256,
        intervalResamples: 32,
        deadlineMs: 60_000,
      }),
    };
    const first = runTerminalRollout(input);
    const repeated = runTerminalRollout(input);

    expect(first).toEqual(repeated);
    expect(first.chanceCount).toBeGreaterThanOrEqual(1);
    expect(first.rootPickup).toBe(false);
    expect(first.rootPickupCount).toBe(0);
    expect(first.rootPower).toBe(true);
  });
});

describe("semantic common random numbers", () => {
  it("uses the same stochastic opponent tape across candidate root actions", () => {
    const rules: RuleConfig = {
      ...CANONICAL_RULES,
      zeroCardsWithPower: {
        mode: "immediate-escape",
        drawFromTarget: "next-active",
        configuredTarget: null,
      },
      twoPlayer: "normal",
    };
    const hands = exactHands(
      ["4D", "QD", "2C"],
      ["2D", "JD", "5H"],
      ["3D", "6H", "7S"],
    );
    const state = exactState(hands, rules);
    const base = {
      publicState: state,
      exactHands: hands,
      scenarioOccurrence: 11,
      replicate: 5,
      seeds: DEFAULT_SOLVER_SEEDS,
      policies: {
        userContinuation: "always-high",
        p2: "random",
        p3: "always-high",
      } as const,
      budget: solverBudget("instant", {
        maxEventsPerRollout: 256,
        intervalResamples: 32,
        deadlineMs: 60_000,
      }),
    };
    const low = runTerminalRollout({
      ...base,
      action: { kind: "play-card", card: "4D" },
    });
    const queen = runTerminalRollout({
      ...base,
      action: { kind: "play-card", card: "QD" },
    });
    const firstP2 = (outcome: typeof low) =>
      outcome.policyDecisions.find(
        (decision) => decision.seat === "p2" && decision.decisionOrdinal === 0,
      );

    expect(firstP2(low)).toMatchObject({
      policyId: "random",
      actionKey: firstP2(queen)?.actionKey,
      rngStreamId: firstP2(queen)?.rngStreamId,
    });
    expect(firstP2(low)?.rngStreamId).not.toContain("play:");
  });
});
