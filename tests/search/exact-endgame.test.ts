import { describe, expect, it } from "vitest";

import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { stableHash } from "../../src/events/stable-hash";
import { behaviorBeliefConfigurationHash } from "../../src/inference/behavior-belief";
import { DEFAULT_BEHAVIOR_MODEL_CONFIG } from "../../src/inference/behavior-models";
import type { BehaviorModelId } from "../../src/inference/behavior-models";
import type { ExactHands } from "../../src/rules/exact-hand-transition";
import type { ExactOpponentPolicyMode } from "../../src/search/advanced-types";
import { solveExactEndgame } from "../../src/search/exact-endgame";
import { createExactInformationHypothesisSet } from "../../src/search/exact-hypotheses";
import { makeExactPublicState } from "../support/state-builders";

const ACYCLIC_RULES: RuleConfig = {
  ...CANONICAL_RULES,
  zeroCardsWithPower: {
    mode: "immediate-escape",
    drawFromTarget: "next-active",
    configuredTarget: null,
  },
  twoPlayer: "normal",
};

function exactFixture(
  hands: ExactHands,
  options: {
    readonly supportKind?: "exhaustive" | "sampled";
    readonly maxActiveCards?: number;
    readonly shouldCancel?: () => boolean;
    readonly p2ModelId?: BehaviorModelId;
    readonly opponentPolicyMode?: ExactOpponentPolicyMode;
  } = {},
) {
  const publicState = makeExactPublicState({
    hands,
    power: "user",
    rules: ACYCLIC_RULES,
  });
  const historyHash = stableHash({
    fixture: "phase7-exact-smoke",
    publicState,
  });
  const hypothesisSet = createExactInformationHypothesisSet({
    historyHash,
    sourceKind: "explicit-research",
    sourceChecksum: stableHash({ fixture: "phase7-exact-smoke-source" }),
    supportKind: options.supportKind ?? "exhaustive",
    supportWorldCount: "1",
    behaviorConfigHash: behaviorBeliefConfigurationHash(
      DEFAULT_BEHAVIOR_MODEL_CONFIG,
    ),
    hypotheses: [
      {
        hypothesisId: "fixture-hypothesis",
        occurrenceIndex: 0,
        witnessId: "fixture-world",
        p2ModelId: options.p2ModelId ?? "always-high",
        p3ModelId: "always-high",
        mass: 1,
        currentHands: hands,
      },
    ],
  });
  return solveExactEndgame({
    publicState,
    historyHash,
    hypothesisSet,
    behaviorConfig: DEFAULT_BEHAVIOR_MODEL_CONFIG,
    ...(options.opponentPolicyMode === undefined
      ? {}
      : { opponentPolicyMode: options.opponentPolicyMode }),
    config: {
      exact: {
        maxActiveCards: options.maxActiveCards ?? 12,
        maxJointHypotheses: 16,
        maxInformationStates: 5_000,
        maxBranches: 20_000,
      },
      deadlineMs: 60_000,
    },
    ...(options.shouldCancel === undefined
      ? {}
      : { shouldCancel: options.shouldCancel }),
  });
}

describe("bounded exact information-state endgame", () => {
  it("exhausts a small acyclic state and returns only normalized terminal values", () => {
    const result = exactFixture({
      user: ["2C", "3C"],
      p2: ["4C"],
      p3: ["5C"],
    });

    expect(result.eligibility).toEqual({ eligible: true });
    expect(result.quality).toBe("Exact");
    expect(result.algorithmVersion).toBe(
      "exact-behavioral-information-state-dp-v3",
    );
    expect(result.actionValues.map((value) => value.actionKey)).toEqual([
      "play:2C",
      "play:3C",
    ]);
    for (const value of result.actionValues) {
      expect(
        Object.values(value.bhabhiProbabilities).reduce(
          (sum, probability) => sum + probability,
          0,
        ),
      ).toBeCloseTo(1, 12);
      expect(
        Object.values(
          value.positionalDiagnostics.firstOpponentEscapeProbabilities,
        ).reduce((sum, probability) => sum + probability, 0),
      ).toBeCloseTo(1, 12);
      expect(
        Object.values(
          value.positionalDiagnostics.userHeadsUpOpponentProbabilities,
        ).reduce((sum, probability) => sum + probability, 0),
      ).toBeCloseTo(1, 12);
    }
    expect(result.diagnostics.terminalStates).toBeGreaterThan(0);
    expect(result.resultHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
  });

  it("refuses sampled support, active-card overflow, and cancellation without partial values", () => {
    const hands: ExactHands = {
      user: ["2C", "3C"],
      p2: ["4C"],
      p3: ["5C"],
    };
    const sampled = exactFixture(hands, { supportKind: "sampled" });
    const overLimit = exactFixture(hands, { maxActiveCards: 3 });
    const cancelled = exactFixture(hands, { shouldCancel: () => true });
    const unsupportedDeterministicRandom = exactFixture(hands, {
      p2ModelId: "random",
      opponentPolicyMode: "deterministic-baseline",
    });

    expect(sampled).toMatchObject({
      quality: "Unavailable",
      eligibility: { eligible: false, code: "INCOMPLETE_ENUMERATION" },
      positionalDiagnostics: null,
      actionValues: [],
    });
    expect(overLimit).toMatchObject({
      quality: "Unavailable",
      eligibility: { eligible: false, code: "ACTIVE_CARD_LIMIT" },
      positionalDiagnostics: null,
      actionValues: [],
    });
    expect(cancelled).toMatchObject({
      quality: "Unavailable",
      eligibility: { eligible: false, code: "CANCELLED" },
      positionalDiagnostics: null,
      actionValues: [],
    });
    expect(unsupportedDeterministicRandom).toMatchObject({
      quality: "Unavailable",
      eligibility: {
        eligible: false,
        code: "UNSUPPORTED_POLICY_MEMORY",
      },
      positionalDiagnostics: null,
      actionValues: [],
    });
  });
});
