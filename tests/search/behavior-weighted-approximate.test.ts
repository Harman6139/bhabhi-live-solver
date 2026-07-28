import { describe, expect, it } from "vitest";

import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import { stableHash } from "../../src/events/stable-hash";
import type { GameTimeline } from "../../src/events/timeline";
import {
  BEHAVIOR_MODEL_HASH,
  BEHAVIOR_MODEL_IDS,
  validateBehaviorModelConfig,
  type BehaviorModelId,
} from "../../src/inference/behavior-models";
import type { ExactHands } from "../../src/rules/exact-hand-transition";
import {
  analyzeWeightedBehaviorHypothesesForTesting,
  recommendBehaviorAwareApproximateFromTimeline,
  recommendFromTimeline,
  solverBudget,
  type BaselineRecommendation,
} from "../../src/search";
import {
  AdvancedSearchContractError,
  WEIGHTED_HYPOTHESES_ALGORITHM_VERSION,
  type JointBehaviorHypothesis,
  type WeightedBehaviorHypothesisSet,
} from "../../src/search/advanced-types";
import { runTerminalRollout } from "../../src/search/rollout";
import { temporalTimeline } from "../inference/test-fixtures";
import { COMPLETE_GAME_EVENTS } from "../support/complete-game";
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

const SEPARATE_POLICY_HANDS: ExactHands = {
  user: ["2H", "JC"],
  p2: ["5H", "TH"],
  p3: ["3H", "QH"],
};

const FRAGILE_HANDS: ExactHands = {
  user: ["TS", "6C"],
  p2: ["AS", "8S"],
  p3: ["4D", "5S"],
};

function focusedModelVector(
  focus: BehaviorModelId,
  concentration = 0.999,
): Readonly<Record<BehaviorModelId, number>> {
  const remainder = (1 - concentration) / (BEHAVIOR_MODEL_IDS.length - 1);
  return Object.fromEntries(
    BEHAVIOR_MODEL_IDS.map((modelId) => [
      modelId,
      modelId === focus ? concentration : remainder,
    ]),
  ) as Record<BehaviorModelId, number>;
}

function weightedSet(input: {
  readonly id: string;
  readonly historyHash: string;
  readonly hands: ExactHands;
  readonly p2Focus: BehaviorModelId;
  readonly p3Focus: BehaviorModelId;
}): WeightedBehaviorHypothesisSet {
  const p2 = focusedModelVector(input.p2Focus);
  const p3 = focusedModelVector(input.p3Focus);
  const witnessId = stableHash({
    fixture: input.id,
    hands: input.hands,
  });
  const raw = BEHAVIOR_MODEL_IDS.flatMap((p2ModelId) =>
    BEHAVIOR_MODEL_IDS.map((p3ModelId) => ({
      p2ModelId,
      p3ModelId,
      mass: p2[p2ModelId] * p3[p3ModelId],
    })),
  );
  const rawTotal = raw.reduce((sum, cell) => sum + cell.mass, 0);
  const hypotheses: JointBehaviorHypothesis[] = raw.map((cell) => {
    const hypothesisKey = stableHash({
      schemaVersion: 1,
      historyHash: input.historyHash,
      occurrenceIndex: 0,
      witnessId,
      p2ModelId: cell.p2ModelId,
      p3ModelId: cell.p3ModelId,
    });
    return {
      schemaVersion: 1,
      occurrenceIndex: 0,
      witnessId,
      p2ModelId: cell.p2ModelId,
      p3ModelId: cell.p3ModelId,
      mass: cell.mass / rawTotal,
      currentHands: input.hands,
      hypothesisKey,
    };
  });
  const behaviorResultHash = stableHash({
    fixture: input.id,
    p2,
    p3,
  });
  const checksum = stableHash({
    schemaVersion: 1,
    algorithmVersion: WEIGHTED_HYPOTHESES_ALGORITHM_VERSION,
    historyHash: input.historyHash,
    behaviorResultHash,
    hypotheses: hypotheses.map((hypothesis) => ({
      hypothesisKey: hypothesis.hypothesisKey,
      mass: hypothesis.mass,
    })),
  });
  return {
    schemaVersion: 1,
    algorithmVersion: WEIGHTED_HYPOTHESES_ALGORITHM_VERSION,
    historyHash: input.historyHash,
    hardBeliefConfigHash: stableHash({
      fixture: input.id,
      kind: "hard-config",
    }),
    worldSetChecksum: stableHash({
      schemaVersion: 1,
      orderedWitnessIds: [witnessId],
    }),
    behaviorResultHash,
    behaviorModelHash: BEHAVIOR_MODEL_HASH,
    occurrenceCount: 1,
    distinctWitnesses: 1,
    hypothesesPerOccurrence: BEHAVIOR_MODEL_IDS.length ** 2,
    totalHypotheses: hypotheses.length,
    totalMass: hypotheses.reduce((sum, hypothesis) => sum + hypothesis.mass, 0),
    hypotheses,
    checksum,
  };
}

function weightedAnalysis(input: {
  readonly id: string;
  readonly hands: ExactHands;
  readonly p2Focus: BehaviorModelId;
  readonly p3Focus: BehaviorModelId;
  readonly rolloutsPerWorld?: number;
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
  return analyzeWeightedBehaviorHypothesesForTesting({
    publicState,
    historyHash,
    stateVersion: 0,
    hypothesisSet: weightedSet({
      id: input.id,
      historyHash,
      hands: input.hands,
      p2Focus: input.p2Focus,
      p3Focus: input.p3Focus,
    }),
    behaviorConfig: {
      lapseProbability: 1e-9,
    },
    budget: solverBudget("instant", {
      rolloutsPerWorld: input.rolloutsPerWorld ?? 1,
      maxEventsPerRollout: 256,
      deadlineMs: 60_000,
    }),
    userContinuation: "always-high",
    seeds: {
      rollout: "phase8-weighted-test/rollout",
      chance: "phase8-weighted-test/chance",
    },
  });
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw.");
}

describe("behavior-weighted approximate search", () => {
  it("returns the frozen hard-only production result directly when behavior is off", () => {
    const timeline = temporalTimeline(3);
    const direct = recommendFromTimeline({
      timeline,
      budgetId: "instant",
    });
    const behaviorOff = recommendBehaviorAwareApproximateFromTimeline({
      timeline,
      budgetId: "instant",
      behavior: { enabled: false },
    }) as BaselineRecommendation;

    expect(behaviorOff.payload).toEqual(direct.payload);
    expect(behaviorOff.payload.method).toBe(
      "hard-belief-terminal-root-rollout",
    );
  });

  it("builds aligned hard and behavioral support from a verified timeline", () => {
    const timeline = {
      schemaVersion: 1,
      events: COMPLETE_GAME_EVENTS,
      cursor: 55,
      orphanedEvents: [],
    } satisfies GameTimeline;
    const result = recommendBehaviorAwareApproximateFromTimeline({
      timeline,
      budgetId: "instant",
      behavior: { enabled: true, onFailure: "refuse" },
    });

    expect(result).toMatchObject({
      quality: "Approximate",
      selectedMethod: "behavior-weighted-approximate",
      fallbackReason: null,
      recommendation: {
        payload: {
          method: "behavior-weighted-terminal-root-rollout",
          belief: {
            source: "correlated-world-and-separate-opponent-model-posteriors",
            worldOccurrences: 1,
            jointHypotheses: 49,
          },
          rollout: {
            completed: 49,
            failures: 0,
            eventCapHits: 0,
          },
        },
      },
    });
  });

  it("uses separate P2/P3 latent policies with semantic CRN streams", () => {
    const publicState = makeExactPublicState({
      hands: SEPARATE_POLICY_HANDS,
      power: "user",
      rules: RULES,
    });
    const behaviorConfig = validateBehaviorModelConfig({
      lapseProbability: 1e-9,
    });
    const common = {
      publicState,
      exactHands: SEPARATE_POLICY_HANDS,
      action: { kind: "play-card" as const, card: "2H" as const },
      scenarioOccurrence: 0,
      replicate: 0,
      seeds: {
        belief: "phase8-crn/belief",
        search: "phase8-crn/search",
        rollout: "phase8-crn/rollout",
        chance: "phase8-crn/chance",
        bootstrap: "phase8-crn/bootstrap",
      },
      policies: {
        userContinuation: "always-high" as const,
        p2: "always-high" as const,
        p3: "always-high" as const,
      },
      budget: solverBudget("instant", {
        maxEventsPerRollout: 256,
        deadlineMs: 60_000,
      }),
    };
    const highLow = runTerminalRollout({
      ...common,
      behaviorOpponentPolicy: {
        models: { p2: "always-high", p3: "always-low" },
        config: behaviorConfig,
        semanticScenarioKey: "one-correlated-world",
      },
    });
    const lowHigh = runTerminalRollout({
      ...common,
      behaviorOpponentPolicy: {
        models: { p2: "always-low", p3: "always-high" },
        config: behaviorConfig,
        semanticScenarioKey: "one-correlated-world",
      },
    });
    const highP2 = highLow.policyDecisions.find(
      (decision) => decision.seat === "p2" && decision.decisionOrdinal === 0,
    );
    const lowP2 = lowHigh.policyDecisions.find(
      (decision) => decision.seat === "p2" && decision.decisionOrdinal === 0,
    );
    const lowP3 = highLow.policyDecisions.find(
      (decision) => decision.seat === "p3" && decision.decisionOrdinal === 0,
    );

    expect(highP2).toMatchObject({
      policyId: "always-high",
      actionKey: "play:TH",
    });
    expect(lowP2).toMatchObject({
      policyId: "always-low",
      actionKey: "play:5H",
    });
    expect(lowP3).toMatchObject({
      policyId: "always-low",
      actionKey: "play:3H",
    });
    expect(highP2?.rngStreamId).toBe(lowP2?.rngStreamId);
  });

  it("is deterministic and reports weighted terminal uncertainty and ESS", () => {
    const first = weightedAnalysis({
      id: "weighted-determinism",
      hands: SEPARATE_POLICY_HANDS,
      p2Focus: "always-high",
      p3Focus: "always-low",
      rolloutsPerWorld: 2,
    });
    const second = weightedAnalysis({
      id: "weighted-determinism",
      hands: SEPARATE_POLICY_HANDS,
      p2Focus: "always-high",
      p3Focus: "always-low",
      rolloutsPerWorld: 2,
    });

    expect(first.payload).toEqual(second.payload);
    expect(first.payload.rollout).toMatchObject({
      jointHypotheses: 49,
      replicatesPerHypothesis: 2,
      commonRandomNumbers: "semantic-occurrence-keyed-across-root-actions",
      failures: 0,
      eventCapHits: 0,
    });
    for (const candidate of first.payload.candidates) {
      expect(candidate.weightedTerminalMass).toBeCloseTo(1, 12);
      expect(candidate.interval.method).toBe(
        "weighted-occurrence-cluster-normal",
      );
      expect(candidate.effectiveSampleSize.occurrence).toBeCloseTo(1, 12);
      expect(candidate.effectiveSampleSize.jointHypothesis).toBeGreaterThan(1);
      expect(candidate.effectiveSampleSize.terminalRollout).toBeGreaterThan(
        candidate.effectiveSampleSize.jointHypothesis,
      );
    }
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.payload.candidates[0])).toBe(true);
  });

  it("lets the separate P2 posterior change complete-game continuation values", () => {
    const high = weightedAnalysis({
      id: "posterior-high",
      hands: FRAGILE_HANDS,
      p2Focus: "always-high",
      p3Focus: "always-high",
    });
    const low = weightedAnalysis({
      id: "posterior-low",
      hands: FRAGILE_HANDS,
      p2Focus: "always-low",
      p3Focus: "always-high",
    });
    const highRisks = Object.fromEntries(
      high.payload.candidates.map((candidate) => [
        candidate.actionKey,
        candidate.bhabhiProbability,
      ]),
    );
    const lowRisks = Object.fromEntries(
      low.payload.candidates.map((candidate) => [
        candidate.actionKey,
        candidate.bhabhiProbability,
      ]),
    );

    expect(high.payload.belief.opponentModelMass.p2["always-high"]).toBeCloseTo(
      0.999,
      12,
    );
    expect(low.payload.belief.opponentModelMass.p2["always-low"]).toBeCloseTo(
      0.999,
      12,
    );
    expect(highRisks).not.toEqual(lowRisks);
  });

  it("is root-action-order invariant under the keyed rollout contract", () => {
    const publicState = makeExactPublicState({
      hands: SEPARATE_POLICY_HANDS,
      power: "user",
      rules: RULES,
    });
    const behaviorConfig = validateBehaviorModelConfig({
      lapseProbability: 1e-9,
    });
    const actions = [
      { kind: "play-card" as const, card: "2H" as const },
      { kind: "play-card" as const, card: "JC" as const },
    ];
    const run = (orderedActions: typeof actions) =>
      Object.fromEntries(
        orderedActions.map((action) => {
          const outcome = runTerminalRollout({
            publicState,
            exactHands: SEPARATE_POLICY_HANDS,
            action,
            scenarioOccurrence: 0,
            replicate: 3,
            seeds: {
              belief: "phase8-order/belief",
              search: "phase8-order/search",
              rollout: "phase8-order/rollout",
              chance: "phase8-order/chance",
              bootstrap: "phase8-order/bootstrap",
            },
            policies: {
              userContinuation: "always-high",
              p2: "always-high",
              p3: "always-high",
            },
            behaviorOpponentPolicy: {
              models: { p2: "always-high", p3: "always-low" },
              config: behaviorConfig,
              semanticScenarioKey: "action-order-world",
            },
            budget: solverBudget("instant", {
              maxEventsPerRollout: 256,
              deadlineMs: 60_000,
            }),
          });
          return [outcome.actionKey, outcome.deterministicHash];
        }),
      );

    expect(run(actions)).toEqual(run([...actions].reverse()));
  });

  it("rejects zero-weight support and returns typed fallback/refusal diagnostics", () => {
    const publicState = makeExactPublicState({
      hands: SEPARATE_POLICY_HANDS,
      power: "user",
      rules: RULES,
    });
    const historyHash = stableHash({
      fixture: "zero-weight",
      publicState,
    });
    const degenerate = structuredClone(
      weightedSet({
        id: "zero-weight",
        historyHash,
        hands: SEPARATE_POLICY_HANDS,
        p2Focus: "always-high",
        p3Focus: "always-low",
      }),
    );
    const first = degenerate.hypotheses[0];
    if (first === undefined) {
      throw new Error("Degenerate fixture has no hypothesis.");
    }
    Object.assign(first, { mass: 0 });
    const degenerateError = thrownBy(() =>
      analyzeWeightedBehaviorHypothesesForTesting({
        publicState,
        historyHash,
        stateVersion: 0,
        hypothesisSet: degenerate,
        budget: solverBudget("instant"),
      }),
    );
    expect(degenerateError).toBeInstanceOf(AdvancedSearchContractError);
    if (!(degenerateError instanceof AdvancedSearchContractError)) {
      throw new Error("Expected a typed advanced-search contract error.");
    }
    expect(degenerateError.code).toBe("INVALID_BELIEF");
    expect(degenerateError.details.code).toBe("NO_POSITIVE_WEIGHTED_SUPPORT");

    const timeline = temporalTimeline(3);
    const fallback = recommendBehaviorAwareApproximateFromTimeline({
      timeline,
      budgetId: "instant",
      behavior: {
        enabled: true,
        behaviorConfig: { lapseProbability: 0 },
      },
    });
    expect(fallback).toMatchObject({
      quality: "Approximate",
      selectedMethod: "hard-only-fallback",
      fallbackReason: {
        code: "INVALID_BEHAVIOR_BELIEF",
        sourceCode: "INVALID_CONFIG",
      },
      recommendation: {
        payload: {
          method: "hard-belief-terminal-root-rollout",
        },
      },
    });

    const refusal = recommendBehaviorAwareApproximateFromTimeline({
      timeline,
      budgetId: "instant",
      behavior: {
        enabled: true,
        behaviorConfig: { lapseProbability: 0 },
        onFailure: "refuse",
      },
    });
    expect(refusal).toMatchObject({
      quality: "Unavailable",
      selectedMethod: "none",
      fallbackReason: {
        code: "INVALID_BEHAVIOR_BELIEF",
        sourceCode: "INVALID_CONFIG",
      },
      recommendation: null,
    });
  });
});
