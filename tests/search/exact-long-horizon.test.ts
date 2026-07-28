import { describe, expect, it } from "vitest";

import { createActorObservation } from "../../src/agents/observation";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { stableHash } from "../../src/events/stable-hash";
import { behaviorBeliefConfigurationHash } from "../../src/inference/behavior-belief";
import {
  DEFAULT_BEHAVIOR_MODEL_CONFIG,
  type BehaviorModelId,
} from "../../src/inference/behavior-models";
import {
  applyExactHandEvent,
  type ExactHands,
} from "../../src/rules/exact-hand-transition";
import { DEFAULT_SOLVER_SEEDS, solverBudget } from "../../src/search/config";
import type {
  ExactEndgameSolvedResult,
  ExactOpponentPolicyMode,
} from "../../src/search/advanced-types";
import { solveExactEndgame } from "../../src/search/exact-endgame";
import { createExactInformationHypothesisSet } from "../../src/search/exact-hypotheses";
import { evaluateActorSafePolicy } from "../../src/search/policy-kernel";
import { runTerminalRollout } from "../../src/search/rollout";
import { makeExactPublicState } from "../support/state-builders";

const IMMEDIATE_RULES: RuleConfig = {
  ...CANONICAL_RULES,
  zeroCardsWithPower: {
    mode: "immediate-escape",
    drawFromTarget: "next-active",
    configuredTarget: null,
  },
  twoPlayer: "normal",
};

function solveFixture(input: {
  readonly id: string;
  readonly hands: ExactHands;
  readonly rules?: RuleConfig;
  readonly p2ModelId?: BehaviorModelId;
  readonly p3ModelId?: BehaviorModelId;
  readonly opponentPolicyMode?: ExactOpponentPolicyMode;
}) {
  const publicState = makeExactPublicState({
    hands: input.hands,
    power: "user",
    rules: input.rules ?? IMMEDIATE_RULES,
  });
  const historyHash = stableHash({
    fixture: input.id,
    publicState,
  });
  const hypothesisSet = createExactInformationHypothesisSet({
    historyHash,
    sourceKind: "explicit-research",
    sourceChecksum: stableHash({ fixture: input.id }),
    supportKind: "exhaustive",
    supportWorldCount: "1",
    behaviorConfigHash: behaviorBeliefConfigurationHash(
      DEFAULT_BEHAVIOR_MODEL_CONFIG,
    ),
    hypotheses: [
      {
        hypothesisId: `${input.id}-hypothesis`,
        occurrenceIndex: 0,
        witnessId: `${input.id}-world`,
        p2ModelId: input.p2ModelId ?? "always-high",
        p3ModelId: input.p3ModelId ?? "always-high",
        mass: 1,
        currentHands: input.hands,
      },
    ],
  });
  const result = solveExactEndgame({
    publicState,
    historyHash,
    hypothesisSet,
    behaviorConfig: DEFAULT_BEHAVIOR_MODEL_CONFIG,
    opponentPolicyMode: input.opponentPolicyMode ?? "deterministic-baseline",
    config: {
      exact: {
        maxActiveCards: 12,
        maxJointHypotheses: 8,
        maxInformationStates: 25_000,
        maxBranches: 100_000,
      },
      deadlineMs: 60_000,
    },
  });
  if (result.quality !== "Exact") {
    throw new Error(
      `${input.id} became exact-ineligible: ${result.eligibility.code}`,
    );
  }
  return { publicState, result };
}

function actionValue(result: ExactEndgameSolvedResult, actionKey: string) {
  const value = result.actionValues.find(
    (candidate) => candidate.actionKey === actionKey,
  );
  if (value === undefined) {
    throw new Error(`Missing exact action ${actionKey}.`);
  }
  return value;
}

function risk(result: ExactEndgameSolvedResult, actionKey: string): number {
  return actionValue(result, actionKey).userBhabhiRisk;
}

describe("exact long-horizon and dynamic-rank fixtures", () => {
  it("reverses the value of a high card when the downstream suit context changes", () => {
    const highIntoVoid = solveFixture({
      id: "dynamic-rank-high-into-void",
      hands: {
        user: ["QC", "4D"],
        p2: ["JC", "JD"],
        p3: ["2H"],
      },
    }).result;
    const cleanHigh = solveFixture({
      id: "dynamic-rank-clean-high",
      hands: {
        user: ["QC", "4D"],
        p2: ["KC", "3D"],
        p3: ["2H"],
      },
    }).result;

    expect(highIntoVoid.recommendedActionKey).toBe("play:4D");
    expect(risk(highIntoVoid, "play:4D")).toBe(0);
    expect(risk(highIntoVoid, "play:QC")).toBe(1);

    expect(cleanHigh.recommendedActionKey).toBe("play:QC");
    expect(risk(cleanHigh, "play:QC")).toBe(0);
    expect(risk(cleanHigh, "play:4D")).toBe(1);
  });

  it("prefers a terminally safe pickup over a clean immediate shed", () => {
    const hands: ExactHands = {
      user: ["9H", "6S"],
      p2: ["4S", "9C"],
      p3: ["6D", "5S"],
    };
    const { publicState, result } = solveFixture({
      id: "pickup-composition-over-card-count",
      hands,
    });

    let pickupLine = { publicState, hands };
    for (const [seat, card] of [
      ["user", "9H"],
      ["p2", "9C"],
    ] as const) {
      pickupLine = applyExactHandEvent(pickupLine, {
        type: "card-played",
        schemaVersion: 1,
        seat,
        card,
      });
    }
    let cleanLine = { publicState, hands };
    for (const [seat, card] of [
      ["user", "6S"],
      ["p2", "4S"],
      ["p3", "5S"],
    ] as const) {
      cleanLine = applyExactHandEvent(cleanLine, {
        type: "card-played",
        schemaVersion: 1,
        seat,
        card,
      });
    }

    expect(
      pickupLine.publicState.effects.findLast(
        (effect) => effect.type === "trick-picked-up",
      ),
    ).toMatchObject({
      picker: "user",
      thullaBy: "p2",
      cards: ["9H", "9C"],
    });
    expect(pickupLine.publicState.handCounts.user).toBe(3);
    expect(
      cleanLine.publicState.effects.findLast(
        (effect) => effect.type === "trick-wasted",
      ),
    ).toBeDefined();
    expect(cleanLine.publicState.handCounts.user).toBe(1);

    expect(result.recommendedActionKey).toBe("play:9H");
    expect(risk(result, "play:9H")).toBe(0);
    expect(risk(result, "play:6S")).toBe(1);
    expect(actionValue(result, "play:9H").positionalDiagnostics).toMatchObject({
      immediatePickupProbability: 1,
      expectedImmediatePickupCount: 2,
      immediatePowerProbability: 1,
    });
    expect(actionValue(result, "play:6S").positionalDiagnostics).toMatchObject({
      immediatePickupProbability: 0,
      expectedImmediatePickupCount: 0,
      immediatePowerProbability: 1,
    });
    expect(result.positionalDiagnostics).toEqual(
      actionValue(result, result.recommendedActionKey).positionalDiagnostics,
    );
  });

  it("preserves first-escape identity and the resulting heads-up opponent", () => {
    const hands: ExactHands = {
      user: ["4C", "QD"],
      p2: ["JC"],
      p3: ["JD"],
    };
    const { publicState, result } = solveFixture({
      id: "escape-identity-heads-up",
      hands,
    });
    const rollout = (card: "4C" | "QD") =>
      runTerminalRollout({
        publicState,
        exactHands: hands,
        action: { kind: "play-card", card },
        scenarioOccurrence: 0,
        replicate: 0,
        seeds: DEFAULT_SOLVER_SEEDS,
        policies: {
          userContinuation: "always-high",
          p2: "always-high",
          p3: "always-high",
        },
        budget: solverBudget("instant", {
          maxEventsPerRollout: 256,
          intervalResamples: 16,
          deadlineMs: 60_000,
        }),
      });

    expect(result.recommendedActionKey).toBe("play:4C");
    expect(risk(result, "play:4C")).toBe(0);
    expect(actionValue(result, "play:4C").positionalDiagnostics).toMatchObject({
      firstOpponentEscapeProbabilities: {
        p2: 0,
        p3: 1,
        tie: 0,
        none: 0,
      },
      userHeadsUpOpponentProbabilities: {
        p2: 1,
        p3: 0,
        none: 0,
      },
    });
    expect(rollout("4C").terminal).toMatchObject({
      firstOpponentEscape: "p3",
      userHeadsUpOpponent: "p2",
      bhabhi: "p2",
    });
    expect(risk(result, "play:QD")).toBe(1);
    expect(actionValue(result, "play:QD").positionalDiagnostics).toMatchObject({
      firstOpponentEscapeProbabilities: {
        p2: 1,
        p3: 0,
        tie: 0,
        none: 0,
      },
      userHeadsUpOpponentProbabilities: {
        p2: 0,
        p3: 1,
        none: 0,
      },
    });
    expect(rollout("QD").terminal).toMatchObject({
      firstOpponentEscape: "p2",
      userHeadsUpOpponent: "p3",
      bhabhi: "user",
    });
  });

  it("enumerates genuine player-draw chance to the analytic half-risk value", () => {
    const result = solveFixture({
      id: "analytic-player-draw-half-risk",
      hands: {
        user: ["AH"],
        p2: ["2H", "2C", "AC"],
        p3: ["3H", "5C"],
      },
      rules: {
        ...IMMEDIATE_RULES,
        zeroCardsWithPower: {
          mode: "draw-from-player",
          drawFromTarget: "next-active",
          configuredTarget: null,
        },
      },
    }).result;

    expect(result.recommendedActionKey).toBe("play:AH");
    expect(result.userBhabhiRisk).toBe(0.5);
    expect(result.bhabhiProbabilities).toEqual({
      user: 0.5,
      p2: 0.5,
      p3: 0,
    });
    expect(result.diagnostics.chanceNodes).toBe(1);
  });

  it("uses separate, conflicting P2 and P3 policies instead of one colluding actor", () => {
    const hands: ExactHands = {
      user: ["2H", "JC"],
      p2: ["5H", "TH"],
      p3: ["3H", "QH"],
    };
    const { publicState, result } = solveFixture({
      id: "separate-opponent-preferences",
      hands,
      p2ModelId: "always-high",
      p3ModelId: "always-low",
      opponentPolicyMode: "behavior-distribution",
    });
    const afterLead = applyExactHandEvent(
      { publicState, hands },
      {
        type: "card-played",
        schemaVersion: 1,
        seat: "user",
        card: "2H",
      },
    );
    const p2 = evaluateActorSafePolicy({
      observation: createActorObservation(
        {
          publicState: afterLead.publicState,
          exactHands: afterLead.hands,
        },
        "p2",
        0,
      ),
      modelId: "always-high",
    });
    const afterP2 = applyExactHandEvent(afterLead, {
      type: "card-played",
      schemaVersion: 1,
      seat: "p2",
      card: "TH",
    });
    const p3 = evaluateActorSafePolicy({
      observation: createActorObservation(
        {
          publicState: afterP2.publicState,
          exactHands: afterP2.hands,
        },
        "p3",
        0,
      ),
      modelId: "always-low",
    });

    expect(p2.preferredActionKey).toBe("play:TH");
    expect(p3.preferredActionKey).toBe("play:3H");
    expect(result.assumptions.opponentPolicy).toBe(
      "separate-static-behavior-models",
    );
    expect(result.diagnostics.opponentNodes).toBeGreaterThan(0);
  });
});
