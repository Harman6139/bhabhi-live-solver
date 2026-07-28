import { describe, expect, it } from "vitest";

import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { stableHash } from "../../src/events/stable-hash";
import { behaviorBeliefConfigurationHash } from "../../src/inference/behavior-belief";
import { DEFAULT_BEHAVIOR_MODEL_CONFIG } from "../../src/inference/behavior-models";
import type { ExactHands } from "../../src/rules/exact-hand-transition";
import { solveExactEndgame } from "../../src/search/exact-endgame";
import { createExactInformationHypothesisSet } from "../../src/search/exact-hypotheses";
import { bruteForceExactEndgameOracle } from "../support/exact-endgame-oracle";
import { makeExactPublicState } from "../support/state-builders";

const IMMEDIATE_NORMAL_RULES: RuleConfig = {
  ...CANONICAL_RULES,
  zeroCardsWithPower: {
    mode: "immediate-escape",
    drawFromTarget: "next-active",
    configuredTarget: null,
  },
  twoPlayer: "normal",
};

function compareWithOracle(input: {
  readonly id: string;
  readonly hands: ExactHands;
  readonly rules: RuleConfig;
  readonly activeSeats?: readonly ("user" | "p2" | "p3")[];
}) {
  const publicState = makeExactPublicState({
    hands: input.hands,
    power: "user",
    rules: input.rules,
    ...(input.activeSeats === undefined
      ? {}
      : { activeSeats: input.activeSeats }),
  });
  const historyHash = stableHash({
    fixture: input.id,
    publicState,
  });
  const hypothesisSet = createExactInformationHypothesisSet({
    historyHash,
    sourceKind: "explicit-research",
    sourceChecksum: stableHash({ fixture: input.id, kind: "oracle-source" }),
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
        p2ModelId: "always-high",
        p3ModelId: "always-low",
        mass: 1,
        currentHands: input.hands,
      },
    ],
  });
  const exact = solveExactEndgame({
    publicState,
    historyHash,
    hypothesisSet,
    behaviorConfig: DEFAULT_BEHAVIOR_MODEL_CONFIG,
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
  const oracle = bruteForceExactEndgameOracle({
    publicState,
    hypotheses: [
      {
        id: `${input.id}-oracle`,
        mass: 1,
        p2ModelId: "always-high",
        p3ModelId: "always-low",
        hands: input.hands,
      },
    ],
    behaviorConfig: DEFAULT_BEHAVIOR_MODEL_CONFIG,
    maximumDepth: 128,
  });
  return { exact, oracle };
}

function expectAgreement(
  comparison: ReturnType<typeof compareWithOracle>,
): void {
  expect(comparison.exact.eligibility).toEqual({ eligible: true });
  if (!comparison.exact.eligibility.eligible) {
    throw new Error("Exact fixture was unexpectedly ineligible.");
  }
  const exactByAction = new Map(
    comparison.exact.actionValues.map((value) => [value.actionKey, value]),
  );
  expect([...exactByAction.keys()].sort()).toEqual(
    comparison.oracle.actionValues.map((value) => value.actionKey).sort(),
  );
  for (const oracleValue of comparison.oracle.actionValues) {
    const exactValue = exactByAction.get(oracleValue.actionKey);
    expect(exactValue).toBeDefined();
    if (exactValue === undefined) {
      throw new Error(`Exact solver omitted ${oracleValue.actionKey}.`);
    }
    expect(exactValue.userBhabhiRisk).toBeCloseTo(
      oracleValue.userBhabhiRisk,
      12,
    );
    for (const seat of ["user", "p2", "p3"] as const) {
      expect(exactValue.bhabhiProbabilities[seat]).toBeCloseTo(
        oracleValue.bhabhiProbabilities[seat],
        12,
      );
    }
    expect(
      exactValue.positionalDiagnostics.immediatePickupProbability,
    ).toBeCloseTo(
      oracleValue.positionalDiagnostics.immediatePickupProbability,
      12,
    );
    expect(
      exactValue.positionalDiagnostics.expectedImmediatePickupCount,
    ).toBeCloseTo(
      oracleValue.positionalDiagnostics.expectedImmediatePickupCount,
      12,
    );
    expect(
      exactValue.positionalDiagnostics.immediatePowerProbability,
    ).toBeCloseTo(
      oracleValue.positionalDiagnostics.immediatePowerProbability,
      12,
    );
    for (const key of ["p2", "p3", "tie", "none"] as const) {
      expect(
        exactValue.positionalDiagnostics.firstOpponentEscapeProbabilities[key],
      ).toBeCloseTo(
        oracleValue.positionalDiagnostics.firstOpponentEscapeProbabilities[key],
        12,
      );
    }
    for (const key of ["p2", "p3", "none"] as const) {
      expect(
        exactValue.positionalDiagnostics.userHeadsUpOpponentProbabilities[key],
      ).toBeCloseTo(
        oracleValue.positionalDiagnostics.userHeadsUpOpponentProbabilities[key],
        12,
      );
    }
  }
  expect(comparison.exact.recommendedActionKey).toBe(
    comparison.oracle.recommendedActionKey,
  );
  expect(comparison.exact.tiedBestActionKeys).toEqual(
    comparison.oracle.tiedBestActionKeys,
  );
}

describe("exact endgame independent brute-force agreement", () => {
  it("agrees for every action and terminal vector in a three-player finish", () => {
    expectAgreement(
      compareWithOracle({
        id: "three-player-finish",
        hands: {
          user: ["2C", "3C"],
          p2: ["4C"],
          p3: ["5C"],
        },
        rules: IMMEDIATE_NORMAL_RULES,
      }),
    );
  });

  it("agrees through the identity-preserving heads-up transition", () => {
    expectAgreement(
      compareWithOracle({
        id: "heads-up-finish",
        hands: {
          user: ["2C", "AC"],
          p2: ["3C", "4C"],
          p3: [],
        },
        rules: IMMEDIATE_NORMAL_RULES,
        activeSeats: ["user", "p2"],
      }),
    );
  });

  it("agrees while exhaustively enumerating player-draw chance", () => {
    const drawRules: RuleConfig = {
      ...IMMEDIATE_NORMAL_RULES,
      zeroCardsWithPower: {
        mode: "draw-from-player",
        drawFromTarget: "configured",
        configuredTarget: "p2",
      },
    };
    expectAgreement(
      compareWithOracle({
        id: "player-draw-chance",
        hands: {
          user: ["AH"],
          p2: ["2H", "2C", "4D"],
          p3: ["3H", "3C"],
        },
        rules: drawRules,
      }),
    );
  });
});
