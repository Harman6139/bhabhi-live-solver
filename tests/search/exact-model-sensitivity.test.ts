import { describe, expect, it } from "vitest";

import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { stableHash } from "../../src/events/stable-hash";
import { behaviorBeliefConfigurationHash } from "../../src/inference/behavior-belief";
import {
  DEFAULT_BEHAVIOR_MODEL_CONFIG,
  type BehaviorModelId,
} from "../../src/inference/behavior-models";
import type { ExactHands } from "../../src/rules/exact-hand-transition";
import { analyzeExactModelSensitivity } from "../../src/search/exact-model-sensitivity";
import { createExactInformationHypothesisSet } from "../../src/search/exact-hypotheses";
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

const P2_MODELS = ["always-high", "always-low"] as const;
const P3_MODELS = ["always-high", "always-low"] as const;

function report(input: {
  readonly id: string;
  readonly hands: ExactHands;
  readonly weight: (
    p2ModelId: BehaviorModelId,
    p3ModelId: BehaviorModelId,
  ) => number;
}) {
  const publicState = makeExactPublicState({
    hands: input.hands,
    power: "user",
    rules: RULES,
  });
  const historyHash = stableHash({
    fixture: input.id,
    publicState,
  });
  const cells = P2_MODELS.flatMap((p2ModelId) =>
    P3_MODELS.map((p3ModelId) => ({
      p2ModelId,
      p3ModelId,
      mass: input.weight(p2ModelId, p3ModelId),
    })),
  );
  const hypothesisSet = createExactInformationHypothesisSet({
    historyHash,
    sourceKind: "explicit-research",
    sourceChecksum: stableHash({ fixture: input.id, cells }),
    supportKind: "exhaustive",
    supportWorldCount: "1",
    behaviorConfigHash: behaviorBeliefConfigurationHash(
      DEFAULT_BEHAVIOR_MODEL_CONFIG,
    ),
    hypotheses: cells.map((cell, index) => ({
      hypothesisId: `${cell.p2ModelId}/${cell.p3ModelId}`,
      occurrenceIndex: index,
      witnessId: "one-world",
      p2ModelId: cell.p2ModelId,
      p3ModelId: cell.p3ModelId,
      mass: cell.mass,
      currentHands: input.hands,
    })),
  });
  return analyzeExactModelSensitivity({
    publicState,
    historyHash,
    hypothesisSet,
    behaviorConfig: DEFAULT_BEHAVIOR_MODEL_CONFIG,
    config: {
      exact: {
        maxActiveCards: 8,
        maxJointHypotheses: 8,
        maxInformationStates: 5_000,
        maxBranches: 25_000,
      },
      deadlineMs: 60_000,
    },
  });
}

describe("solver-backed exact model sensitivity", () => {
  it("reports stable dominance from actual terminal values", () => {
    const result = report({
      id: "exact-model-stable",
      hands: {
        user: ["2C", "3C"],
        p2: ["4C"],
        p3: ["5C"],
      },
      weight: () => 0.25,
    });

    expect(result.eligibility).toEqual({ eligible: true });
    if (result.quality !== "Exact") {
      throw new Error("Stable exact model fixture became ineligible.");
    }
    expect(result.cells).toHaveLength(4);
    expect(
      result.cells.every(
        (cell) =>
          cell.exactResultHash.startsWith("fnv1a64:") &&
          cell.actionRisks.every(
            (risk) => risk.terminalRisk >= 0 && risk.terminalRisk <= 1,
          ),
      ),
    ).toBe(true);
    expect(result.diagnostic.fragility).toMatchObject({
      warning: false,
      code: "STABLE_ACROSS_MODEL_CELLS",
      switchPosteriorMass: 0,
      maximumSwitchRegret: 0,
      expectedSwitchRegret: 0,
    });
  });

  it("warns when real opponent model cells reverse the terminal winner", () => {
    const result = report({
      id: "exact-model-fragile",
      hands: {
        user: ["TS", "6C"],
        p2: ["AS", "8S"],
        p3: ["4D", "5S"],
      },
      weight: (p2ModelId) => (p2ModelId === "always-high" ? 0.375 : 0.125),
    });

    expect(result.eligibility).toEqual({ eligible: true });
    if (result.quality !== "Exact") {
      throw new Error("Fragile exact model fixture became ineligible.");
    }
    expect(result.baseResult.recommendedActionKey).toBe("play:TS");
    expect(result.diagnostic.posterior.recommendedActionKey).toBe("play:TS");
    expect(result.diagnostic.fragility).toMatchObject({
      warning: true,
      code: "MODEL_SENSITIVE_RECOMMENDATION",
      switchPosteriorMass: 0.25,
    });
    expect(result.diagnostic.fragility.maximumSwitchRegret).toBeCloseTo(
      0.92,
      12,
    );
    expect(result.diagnostic.fragility.expectedSwitchRegret).toBeCloseTo(
      0.23,
      12,
    );
    expect(
      result.cells
        .filter((cell) => cell.p2ModelId === "always-low")
        .every((cell) => {
          const low = cell.actionRisks.find(
            (risk) => risk.actionKey === "play:6C",
          );
          const spade = cell.actionRisks.find(
            (risk) => risk.actionKey === "play:TS",
          );
          return (
            low !== undefined &&
            spade !== undefined &&
            low.terminalRisk < spade.terminalRisk
          );
        }),
    ).toBe(true);
    expect(result.diagnostic.robustDiagnostic.advisoryOnly).toBe(true);
    expect(result.baseResult.recommendedActionKey).toBe("play:TS");
  });
});
