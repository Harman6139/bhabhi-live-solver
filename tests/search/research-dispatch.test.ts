import { describe, expect, it } from "vitest";

import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { stableHash } from "../../src/events/stable-hash";
import type { GameTimeline } from "../../src/events/timeline";
import { behaviorBeliefConfigurationHash } from "../../src/inference/behavior-belief";
import { DEFAULT_BEHAVIOR_MODEL_CONFIG } from "../../src/inference/behavior-models";
import type { ExactHands } from "../../src/rules/exact-hand-transition";
import { solverBudget } from "../../src/search/config";
import { solveExactEndgame } from "../../src/search/exact-endgame";
import { createExactInformationHypothesisSet } from "../../src/search/exact-hypotheses";
import {
  dispatchResearchSearch,
  recommendResearchFromTimeline,
  type ResearchSearchDispatchInput,
} from "../../src/search/research-dispatch";
import {
  analyzeScenarioSetForTesting,
  recommendFromTimeline,
} from "../../src/search/solver";
import { COMPLETE_GAME_EVENTS } from "../support/complete-game";
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

const SMALL_HANDS: ExactHands = {
  user: ["4D", "QD"],
  p2: ["JD"],
  p3: ["2C"],
};

function request(options: {
  readonly id: string;
  readonly maxActiveCards: number;
  readonly exactEndgameEnabled: boolean;
  readonly behaviorWeightingEnabled?: boolean;
}): ResearchSearchDispatchInput {
  const publicState = makeExactPublicState({
    hands: SMALL_HANDS,
    power: "user",
    rules: ACYCLIC_RULES,
  });
  const historyHash = stableHash({
    fixture: options.id,
    publicState,
  });
  const behaviorWeightingEnabled = options.behaviorWeightingEnabled ?? false;
  const hypothesisSet = createExactInformationHypothesisSet({
    historyHash,
    sourceKind: behaviorWeightingEnabled ? "weighted-behavior" : "hard-only",
    sourceChecksum: stableHash({
      fixture: options.id,
      behaviorWeightingEnabled,
    }),
    supportKind: "exhaustive",
    supportWorldCount: "1",
    behaviorConfigHash: behaviorBeliefConfigurationHash(
      DEFAULT_BEHAVIOR_MODEL_CONFIG,
    ),
    hypotheses: [
      {
        hypothesisId: "fixture-hypothesis",
        occurrenceIndex: 0,
        witnessId: "fixture-world",
        p2ModelId: "always-high",
        p3ModelId: "always-high",
        mass: 1,
        currentHands: SMALL_HANDS,
      },
    ],
  });
  return {
    switches: {
      exactEndgameEnabled: options.exactEndgameEnabled,
      behaviorWeightingEnabled,
    },
    exactRequest: {
      publicState,
      historyHash,
      hypothesisSet,
      behaviorConfig: DEFAULT_BEHAVIOR_MODEL_CONFIG,
      opponentPolicyMode: "deterministic-baseline",
      config: {
        exact: {
          maxActiveCards: options.maxActiveCards,
          maxJointHypotheses: 16,
          maxInformationStates: 5_000,
          maxBranches: 20_000,
        },
        deadlineMs: 60_000,
      },
    },
    approximateFallbackRequest: {
      publicState,
      historyHash,
      stateVersion: 0,
      scenarios: [
        {
          witnessId: "fixture-world",
          currentHands: SMALL_HANDS,
        },
      ],
      belief: {
        method: "exact-enumeration",
        totalInitialDealWorlds: "1",
        worldSetChecksum: stableHash({
          schemaVersion: 1,
          orderedWitnessIds: ["fixture-world"],
        }),
        uniqueWitnesses: 1,
      },
      budget: solverBudget("instant"),
      policies: {
        userContinuation: "always-high",
        p2: "always-high",
        p3: "always-high",
      },
      seeds: {
        belief: "research-dispatch/belief",
        search: "research-dispatch/search",
        rollout: "research-dispatch/rollout",
        chance: "research-dispatch/chance",
        bootstrap: "research-dispatch/bootstrap",
      },
    },
  };
}

function completeGameTimeline(cursor: number): GameTimeline {
  return {
    schemaVersion: 1,
    events: COMPLETE_GAME_EVENTS,
    cursor,
    orphanedEvents: [],
  };
}

describe("research exact/approximate dispatch boundary", () => {
  it("selects an eligible exact result without running the approximate fallback", () => {
    const input = request({
      id: "eligible-exact",
      maxActiveCards: 4,
      exactEndgameEnabled: true,
    });
    const direct = solveExactEndgame(input.exactRequest);
    const result = dispatchResearchSearch(input);

    expect(direct.quality).toBe("Exact");
    expect(result).toMatchObject({
      quality: "Exact",
      selectedMethod: "exact-endgame",
      fallbackReason: null,
      approximateFallback: null,
      switches: {
        exactEndgameEnabled: true,
        behaviorWeightingEnabled: false,
      },
    });
    if (result.quality !== "Exact") {
      throw new Error("Expected exact dispatch.");
    }
    expect(result.exactAttempt.resultHash).toBe(direct.resultHash);
    expect(result.recommendation.resultHash).toBe(direct.resultHash);
    expect(result.exactAttempt.assumptions.opponentPolicy).toBe(
      "separate-deterministic-baseline-models",
    );
    const frozenPhase5 = analyzeScenarioSetForTesting(
      input.approximateFallbackRequest,
    );
    expect(
      new Map(
        result.exactAttempt.actionValues.map((value) => [
          value.actionKey,
          value.userBhabhiRisk,
        ]),
      ),
    ).toEqual(
      new Map(
        frozenPhase5.payload.candidates.map((value) => [
          value.actionKey,
          value.bhabhiProbability,
        ]),
      ),
    );
    expect(result.resultHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
  });

  it("falls back above the exact card boundary and never relabels the result Exact", () => {
    const result = dispatchResearchSearch(
      request({
        id: "active-card-fallback",
        maxActiveCards: 3,
        exactEndgameEnabled: true,
      }),
    );

    expect(result).toMatchObject({
      quality: "Approximate",
      selectedMethod: "phase5-approximate-fallback",
      fallbackReason: {
        code: "ACTIVE_CARD_LIMIT",
      },
      exactAttempt: {
        quality: "Unavailable",
        eligibility: {
          eligible: false,
          code: "ACTIVE_CARD_LIMIT",
        },
        actionValues: [],
      },
      recommendation: {
        payload: {
          quality: "Approximate",
          method: "hard-belief-terminal-root-rollout",
        },
      },
    });
    if (result.quality !== "Approximate") {
      throw new Error("Expected approximate fallback.");
    }
    expect(result.approximateFallback).toBe(result.recommendation);
    expect(result.approximateFallback.payload).toEqual(
      analyzeScenarioSetForTesting(
        request({
          id: "active-card-fallback",
          maxActiveCards: 3,
          exactEndgameEnabled: true,
        }).approximateFallbackRequest,
      ).payload,
    );
  });

  it("keeps exact solving and behavioral weighting independently switchable", () => {
    const hardOnly = dispatchResearchSearch(
      request({
        id: "exact-disabled-hard-only",
        maxActiveCards: 1,
        exactEndgameEnabled: false,
      }),
    );
    const behaviorWeighted = dispatchResearchSearch(
      request({
        id: "exact-disabled-behavior-weighted",
        maxActiveCards: 1,
        exactEndgameEnabled: false,
        behaviorWeightingEnabled: true,
      }),
    );

    for (const result of [hardOnly, behaviorWeighted]) {
      expect(result).toMatchObject({
        quality: "Approximate",
        fallbackReason: { code: "EXACT_DISABLED" },
        exactAttempt: null,
      });
    }
    expect(hardOnly.switches).toEqual({
      exactEndgameEnabled: false,
      behaviorWeightingEnabled: false,
    });
    expect(behaviorWeighted.switches).toEqual({
      exactEndgameEnabled: false,
      behaviorWeightingEnabled: true,
    });
  });

  it("rejects a behavior switch that does not match the hypothesis envelope", () => {
    const input = request({
      id: "mismatched-switch",
      maxActiveCards: 4,
      exactEndgameEnabled: true,
    });

    expect(() =>
      dispatchResearchSearch({
        ...input,
        switches: {
          ...input.switches,
          behaviorWeightingEnabled: true,
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_BELIEF",
      }),
    );
  });
});

describe("timeline-safe research recommendation entry", () => {
  it("selects exact on an eligible late public timeline with the full event ledger", () => {
    const result = recommendResearchFromTimeline({
      timeline: completeGameTimeline(55),
      budgetId: "instant",
      exactMode: "try",
      advancedConfig: {
        exact: {
          maxActiveCards: 7,
          maxJointHypotheses: 196,
          maxInformationStates: 5_000,
          maxBranches: 20_000,
        },
        deadlineMs: 60_000,
      },
    });

    expect(result).toMatchObject({
      quality: "Exact",
      selectedMethod: "exact-endgame",
      switches: {
        exactEndgameEnabled: true,
        behaviorWeightingEnabled: false,
      },
    });
    if (result.quality !== "Exact") {
      throw new Error("Expected an eligible timeline exact result.");
    }
    expect(result.exactAttempt.hypothesisSetChecksum).toMatch(
      /^fnv1a64:[0-9a-f]{16}$/u,
    );
    expect(result.exactAttempt.assumptions.opponentPolicy).toBe(
      "separate-deterministic-baseline-models",
    );
    expect(
      result.exactAttempt.warnings.some((warning) =>
        warning.includes("Synthetic/effects-only"),
      ),
    ).toBe(false);
  });

  it("falls back byte-for-byte at an ineligible late timeline", () => {
    const timeline = completeGameTimeline(49);
    const request = {
      timeline,
      budgetId: "instant" as const,
      exactMode: "try" as const,
      advancedConfig: {
        exact: {
          maxActiveCards: 7,
          maxJointHypotheses: 196,
          maxInformationStates: 128,
          maxBranches: 512,
        },
        deadlineMs: 1_000,
      },
    };
    const result = recommendResearchFromTimeline(request);
    const direct = recommendFromTimeline({
      timeline,
      budgetId: "instant",
    });

    expect(result).toMatchObject({
      quality: "Approximate",
      selectedMethod: "phase5-approximate-fallback",
      fallbackReason: { code: "ACTIVE_CARD_LIMIT" },
      exactAttempt: {
        quality: "Unavailable",
        actionValues: [],
      },
    });
    if (result.quality !== "Approximate") {
      throw new Error("Expected a timeline fallback.");
    }
    expect(result.approximateFallback.payload).toEqual(direct.payload);
  });

  it("keeps exact-off and behavior-weighted switches independent on timelines", () => {
    const timeline = completeGameTimeline(55);
    const direct = recommendFromTimeline({
      timeline,
      budgetId: "instant",
    });
    const exactOff = recommendResearchFromTimeline({
      timeline,
      budgetId: "instant",
      exactMode: "off",
    });
    const behaviorWeighted = recommendResearchFromTimeline({
      timeline,
      budgetId: "instant",
      exactMode: "off",
      beliefMode: { kind: "behavior-weighted" },
    });

    for (const result of [exactOff, behaviorWeighted]) {
      expect(result).toMatchObject({
        quality: "Approximate",
        fallbackReason: { code: "EXACT_DISABLED" },
        exactAttempt: null,
      });
      if (result.quality !== "Approximate") {
        throw new Error("Expected an exact-off fallback.");
      }
      expect(result.approximateFallback.payload).toEqual(direct.payload);
    }
    expect(exactOff.switches.behaviorWeightingEnabled).toBe(false);
    expect(behaviorWeighted.switches.behaviorWeightingEnabled).toBe(true);
  });

  it("rejects model/fallback mismatches and pre-cancelled publication", () => {
    const timeline = completeGameTimeline(55);
    expect(() =>
      recommendResearchFromTimeline({
        timeline,
        budgetId: "instant",
        exactMode: "try",
        policies: {
          userContinuation: "always-high",
          p2: "always-high",
          p3: "always-high",
        },
        beliefMode: {
          kind: "hard-only",
          p2ModelId: "always-low",
          p3ModelId: "always-high",
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
      }),
    );

    const controller = new AbortController();
    controller.abort();
    expect(() =>
      recommendResearchFromTimeline({
        timeline,
        budgetId: "instant",
        exactMode: "try",
        signal: controller.signal,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "CANCELLED",
      }),
    );
  });
});
