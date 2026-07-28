import { describe, expect, it } from "vitest";

import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { stableHash } from "../../src/events/stable-hash";
import { behaviorBeliefConfigurationHash } from "../../src/inference/behavior-belief";
import { DEFAULT_BEHAVIOR_MODEL_CONFIG } from "../../src/inference/behavior-models";
import type { ExactHands } from "../../src/rules/exact-hand-transition";
import { assertPublicStateInvariant } from "../../src/rules/state-invariant";
import { solveExactEndgame } from "../../src/search/exact-endgame";
import {
  createExactInformationHypothesisSet,
  type ExactInformationHypothesisInput,
} from "../../src/search/exact-hypotheses";
import { bruteForceExactEndgameOracle } from "../support/exact-endgame-oracle";
import { makeExactPublicState } from "../support/state-builders";

const RULES: RuleConfig = {
  ...CANONICAL_RULES,
  zeroCardsWithPower: {
    mode: "immediate-escape",
    drawFromTarget: "next-active",
    configuredTarget: null,
  },
  twoPlayer: "normal",
};

const WORLD_A: ExactHands = {
  user: ["4H", "AS"],
  p2: ["JH", "2H"],
  p3: ["3S", "KS"],
};
const WORLD_B: ExactHands = {
  user: ["4H", "AS"],
  p2: ["JH", "3S"],
  p3: ["2H", "KS"],
};

function publicFixture() {
  const state = makeExactPublicState({
    hands: WORLD_A,
    power: "user",
    rules: RULES,
  });
  state.knownOpponentCards = { p2: [], p3: [] };
  state.unresolvedCards = ["2H", "JH", "3S", "KS"];
  assertPublicStateInvariant(state);
  return state;
}

const CONFIG = {
  exact: {
    maxActiveCards: 8,
    maxJointHypotheses: 8,
    maxInformationStates: 5_000,
    maxBranches: 25_000,
  },
  deadlineMs: 60_000,
} as const;

function hypothesis(
  id: string,
  hands: ExactHands,
  mass: number,
): ExactInformationHypothesisInput {
  return {
    hypothesisId: id,
    occurrenceIndex: id.charCodeAt(0),
    witnessId: id.startsWith("a") ? "world-a" : "world-b",
    p2ModelId: "always-high",
    p3ModelId: "always-high",
    mass,
    currentHands: hands,
  };
}

function solve(hypotheses: readonly ExactInformationHypothesisInput[]) {
  const publicState = publicFixture();
  const historyHash = stableHash({
    fixture: "shared-information-state",
    publicState,
  });
  const hypothesisSet = createExactInformationHypothesisSet({
    historyHash,
    sourceKind: "explicit-research",
    sourceChecksum: "fnv1a64:shared-information-state",
    supportKind: "exhaustive",
    supportWorldCount: new Set(
      hypotheses.map((entry) => entry.witnessId),
    ).size.toString(),
    behaviorConfigHash: behaviorBeliefConfigurationHash(
      DEFAULT_BEHAVIOR_MODEL_CONFIG,
    ),
    hypotheses,
  });
  return {
    publicState,
    result: solveExactEndgame({
      publicState,
      historyHash,
      hypothesisSet,
      behaviorConfig: DEFAULT_BEHAVIOR_MODEL_CONFIG,
      config: CONFIG,
    }),
  };
}

describe("shared observable information-state backup", () => {
  it("does not choose a different root action after peeking at each hidden world", () => {
    const worldA = solve([hypothesis("a", WORLD_A, 1)]).result;
    const worldB = solve([hypothesis("b", WORLD_B, 1)]).result;
    const combinedFixture = solve([
      hypothesis("a", WORLD_A, 0.5),
      hypothesis("b", WORLD_B, 0.5),
    ]);
    const combined = combinedFixture.result;

    expect(worldA).toMatchObject({
      eligibility: { eligible: true },
      recommendedActionKey: "play:4H",
    });
    expect(worldB).toMatchObject({
      eligibility: { eligible: true },
      recommendedActionKey: "play:AS",
    });
    expect(combined).toMatchObject({
      eligibility: { eligible: true },
      recommendedActionKey: "play:AS",
    });
    if (
      worldA.quality !== "Exact" ||
      worldB.quality !== "Exact" ||
      combined.quality !== "Exact"
    ) {
      throw new Error("Locked information-state fixture became ineligible.");
    }
    const clairvoyantRisk =
      0.5 * worldA.userBhabhiRisk + 0.5 * worldB.userBhabhiRisk;
    expect(clairvoyantRisk).toBeCloseTo(0.00074752, 12);
    expect(combined.userBhabhiRisk).toBeCloseTo(0.48, 12);
    expect(combined.userBhabhiRisk - clairvoyantRisk).toBeCloseTo(
      0.47925248,
      12,
    );

    const oracle = bruteForceExactEndgameOracle({
      publicState: combinedFixture.publicState,
      hypotheses: [
        {
          id: "a",
          mass: 0.5,
          p2ModelId: "always-high",
          p3ModelId: "always-high",
          hands: WORLD_A,
        },
        {
          id: "b",
          mass: 0.5,
          p2ModelId: "always-high",
          p3ModelId: "always-high",
          hands: WORLD_B,
        },
      ],
      behaviorConfig: DEFAULT_BEHAVIOR_MODEL_CONFIG,
      maximumDepth: 128,
    });
    expect(combined.recommendedActionKey).toBe(oracle.recommendedActionKey);
    expect(combined.userBhabhiRisk).toBeCloseTo(
      oracle.actionValues[0]?.userBhabhiRisk ?? Number.NaN,
      12,
    );
    const exactByAction = new Map(
      combined.actionValues.map((value) => [value.actionKey, value]),
    );
    for (const oracleValue of oracle.actionValues) {
      const exactValue = exactByAction.get(oracleValue.actionKey);
      expect(exactValue).toBeDefined();
      expect(
        exactValue?.positionalDiagnostics.immediatePickupProbability,
      ).toBeCloseTo(
        oracleValue.positionalDiagnostics.immediatePickupProbability,
        12,
      );
      expect(
        exactValue?.positionalDiagnostics.expectedImmediatePickupCount,
      ).toBeCloseTo(
        oracleValue.positionalDiagnostics.expectedImmediatePickupCount,
        12,
      );
      expect(
        exactValue?.positionalDiagnostics.immediatePowerProbability,
      ).toBeCloseTo(
        oracleValue.positionalDiagnostics.immediatePowerProbability,
        12,
      );
      for (const key of ["p2", "p3", "tie", "none"] as const) {
        expect(
          exactValue?.positionalDiagnostics.firstOpponentEscapeProbabilities[
            key
          ],
        ).toBeCloseTo(
          oracleValue.positionalDiagnostics.firstOpponentEscapeProbabilities[
            key
          ],
          12,
        );
      }
      for (const key of ["p2", "p3", "none"] as const) {
        expect(
          exactValue?.positionalDiagnostics.userHeadsUpOpponentProbabilities[
            key
          ],
        ).toBeCloseTo(
          oracleValue.positionalDiagnostics.userHeadsUpOpponentProbabilities[
            key
          ],
          12,
        );
      }
    }
  });

  it("is invariant to hypothesis order and preserves split duplicate mass", () => {
    const canonical = solve([
      hypothesis("a", WORLD_A, 0.5),
      hypothesis("b", WORLD_B, 0.5),
    ]).result;
    const reordered = solve([
      hypothesis("b", WORLD_B, 0.5),
      hypothesis("a", WORLD_A, 0.5),
    ]).result;
    const duplicate = solve([
      hypothesis("a-1", WORLD_A, 0.25),
      hypothesis("a-2", WORLD_A, 0.25),
      hypothesis("b", WORLD_B, 0.5),
    ]).result;

    expect(reordered).toEqual(canonical);
    expect(duplicate.recommendedActionKey).toBe(canonical.recommendedActionKey);
    expect(duplicate.userBhabhiRisk).toBeCloseTo(
      canonical.userBhabhiRisk ?? Number.NaN,
      12,
    );
    expect(duplicate.actionValues).toEqual(canonical.actionValues);
  });
});
