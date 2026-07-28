import { describe, expect, it } from "vitest";

import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { stableHash } from "../../src/events/stable-hash";
import { behaviorBeliefConfigurationHash } from "../../src/inference/behavior-belief";
import { DEFAULT_BEHAVIOR_MODEL_CONFIG } from "../../src/inference/behavior-models";
import type { ExactHands } from "../../src/rules/exact-hand-transition";
import { solveExactEndgame } from "../../src/search/exact-endgame";
import { createExactInformationHypothesisSet } from "../../src/search/exact-hypotheses";
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

function run(input: {
  readonly id: string;
  readonly hands: ExactHands;
  readonly rules?: RuleConfig;
  readonly copies?: number;
  readonly limits: {
    readonly maxActiveCards: number;
    readonly maxJointHypotheses: number;
    readonly maxInformationStates: number;
    readonly maxBranches: number;
  };
  readonly deadlineMs?: number;
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
  const copies = input.copies ?? 1;
  const hypothesisSet = createExactInformationHypothesisSet({
    historyHash,
    sourceKind: "explicit-research",
    sourceChecksum: stableHash({ fixture: input.id, copies }),
    supportKind: "exhaustive",
    supportWorldCount: "1",
    behaviorConfigHash: behaviorBeliefConfigurationHash(
      DEFAULT_BEHAVIOR_MODEL_CONFIG,
    ),
    hypotheses: Array.from({ length: copies }, (_, index) => ({
      hypothesisId: `hypothesis-${index.toString()}`,
      occurrenceIndex: index,
      witnessId: "one-world",
      p2ModelId: "always-high" as const,
      p3ModelId: "always-high" as const,
      mass: 1 / copies,
      currentHands: input.hands,
    })),
  });
  return solveExactEndgame({
    publicState,
    historyHash,
    hypothesisSet,
    behaviorConfig: DEFAULT_BEHAVIOR_MODEL_CONFIG,
    config: {
      exact: input.limits,
      deadlineMs: input.deadlineMs ?? 60_000,
    },
  });
}

const SMALL_HANDS: ExactHands = {
  user: ["2C", "3C"],
  p2: ["4C"],
  p3: ["5C"],
};

describe("exact eligibility and dispatch boundaries", () => {
  it("returns typed refusals at the hypothesis and information-state boundaries", () => {
    const hypothesisLimited = run({
      id: "joint-hypothesis-limit",
      hands: SMALL_HANDS,
      copies: 2,
      limits: {
        maxActiveCards: 12,
        maxJointHypotheses: 1,
        maxInformationStates: 100,
        maxBranches: 100,
      },
    });
    const stateLimited = run({
      id: "information-state-limit",
      hands: SMALL_HANDS,
      limits: {
        maxActiveCards: 12,
        maxJointHypotheses: 4,
        maxInformationStates: 1,
        maxBranches: 100,
      },
    });

    expect(hypothesisLimited).toMatchObject({
      quality: "Unavailable",
      eligibility: {
        eligible: false,
        code: "JOINT_HYPOTHESIS_LIMIT",
      },
      actionValues: [],
    });
    expect(stateLimited).toMatchObject({
      quality: "Unavailable",
      eligibility: {
        eligible: false,
        code: "INFORMATION_STATE_LIMIT",
      },
      actionValues: [],
    });
  });

  it("returns a branch-limit refusal instead of a survivor-only estimate", () => {
    const drawRules: RuleConfig = {
      ...IMMEDIATE_RULES,
      zeroCardsWithPower: {
        mode: "draw-from-player",
        drawFromTarget: "configured",
        configuredTarget: "p2",
      },
    };
    const result = run({
      id: "branch-limit",
      hands: {
        user: ["AH"],
        p2: ["2H", "2C", "4D"],
        p3: ["3H", "3C"],
      },
      rules: drawRules,
      limits: {
        maxActiveCards: 12,
        maxJointHypotheses: 4,
        maxInformationStates: 10,
        maxBranches: 10,
      },
    });

    expect(result).toMatchObject({
      quality: "Unavailable",
      eligibility: { eligible: false, code: "BRANCH_LIMIT" },
      actionValues: [],
      recommendedAction: null,
    });
  });

  it("detects a locked pickup cycle and never labels it Exact", () => {
    const result = run({
      id: "semantic-pickup-cycle",
      hands: {
        user: ["6H", "JC", "TH"],
        p2: ["QS", "QC", "6D"],
        p3: ["QD", "8D", "KS"],
      },
      limits: {
        maxActiveCards: 12,
        maxJointHypotheses: 4,
        maxInformationStates: 10_000,
        maxBranches: 100_000,
      },
    });

    expect(result).toMatchObject({
      quality: "Unavailable",
      eligibility: {
        eligible: false,
        code: "CYCLIC_INFORMATION_GRAPH",
      },
      actionValues: [],
    });
    expect(result.diagnostics.cycleProbeStates).toBeGreaterThan(0);
    expect(result.diagnostics.informationStates).toBe(0);
  });

  it("returns a deterministic deadline refusal with no partial action values", () => {
    const result = run({
      id: "deadline",
      hands: {
        user: ["6H", "JC", "TH"],
        p2: ["QS", "QC", "6D"],
        p3: ["QD", "8D", "KS"],
      },
      limits: {
        maxActiveCards: 12,
        maxJointHypotheses: 4,
        maxInformationStates: 10_000,
        maxBranches: 100_000,
      },
      deadlineMs: 1,
    });

    expect(result).toMatchObject({
      quality: "Unavailable",
      eligibility: { eligible: false, code: "DEADLINE" },
      actionValues: [],
      userBhabhiRisk: null,
    });
  });
});
