import { beforeEach, describe, expect, it, vi } from "vitest";

const researchDispatchCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/search/research-dispatch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/search/research-dispatch")>();
  return {
    ...actual,
    recommendResearchFromTimeline: (
      ...args: Parameters<typeof actual.recommendResearchFromTimeline>
    ) => {
      researchDispatchCalls.count += 1;
      return actual.recommendResearchFromTimeline(...args);
    },
  };
});

import { createActorObservation } from "../../src/agents/observation";
import { replayTimeline, type GameTimeline } from "../../src/events/timeline";
import {
  createPhase7SearchPolicyFactory,
  PHASE7_CANDIDATE_CONFIG_ID,
  PHASE7_REFERENCE_CONFIG_ID,
  phase7ComparisonConfigurationHash,
} from "../../src/evaluation/phase7-search-policy";
import { createEvaluationUserTimelinePolicyInput } from "../../src/simulator/evaluation-user-policy";
import { COMPLETE_GAME_EVENTS } from "../support/complete-game";

const SOLVER_SEEDS = Object.freeze({
  belief: "phase7-comparison-test/belief",
  search: "phase7-comparison-test/search",
  rollout: "phase7-comparison-test/rollout",
  chance: "phase7-comparison-test/chance",
  bootstrap: "phase7-comparison-test/bootstrap",
});

function policyInput(cursor: number) {
  const timeline: GameTimeline = {
    schemaVersion: 1,
    events: COMPLETE_GAME_EVENTS.slice(0, cursor),
    cursor,
    orphanedEvents: [],
  };
  const replay = replayTimeline(timeline);
  const observation = createActorObservation(
    {
      publicState: replay.state,
      exactHands: {
        user: replay.state.userHand,
        p2: [],
        p3: [],
      },
    },
    "user",
    0,
    timeline.events,
  );
  return createEvaluationUserTimelinePolicyInput({
    timeline,
    observation,
    solverSeeds: SOLVER_SEEDS,
  });
}

describe("Phase 7 truth-safe search evaluation policy", () => {
  beforeEach(() => {
    researchDispatchCalls.count = 0;
  });

  it("runs the frozen Phase 5 reference directly without entering research dispatch", () => {
    const factory = createPhase7SearchPolicyFactory({
      role: "reference",
      solverSeeds: SOLVER_SEEDS,
      verifyFallbackParity: false,
    });
    const action = factory.policyConfig
      .createPolicy()
      .chooseAction(policyInput(55));

    expect(action.kind).toBe("play-card");
    expect(factory.decisions).toHaveLength(1);
    expect(factory.decisions[0]).toMatchObject({
      role: "reference",
      configId: PHASE7_REFERENCE_CONFIG_ID,
      selectedMethod: "fallback",
      exactOutcome: "not-attempted",
      exactAlgorithmId: null,
      exactResultHash: null,
      exactHypothesisSetChecksum: null,
      exactConfigHash: null,
      exactDiagnosticsHash: null,
      exactActionValuesHash: null,
      exactPositionalDiagnosticsHash: null,
      exactRefusalCode: null,
      exactRefusalDetail: null,
      exactDiagnostics: null,
      exactMs: null,
      fallbackParity: "not-checked",
    });
    expect(researchDispatchCalls.count).toBe(0);
    expect(factory.decisions[0]?.totalMs).toBeGreaterThanOrEqual(
      factory.decisions[0]?.fallbackMs ?? Number.POSITIVE_INFINITY,
    );
    expect(factory.decisions[0]?.dispatchResultHash).toMatch(
      /^fnv1a64:[0-9a-f]{16}$/u,
    );
    expect(factory.decisions[0]?.approximateAnalysisId).toMatch(
      /^fnv1a64:[0-9a-f]{16}$/u,
    );

    const repeatedFactory = createPhase7SearchPolicyFactory({
      role: "reference",
      solverSeeds: SOLVER_SEEDS,
      verifyFallbackParity: false,
    });
    repeatedFactory.policyConfig.createPolicy().chooseAction(policyInput(55));
    expect(repeatedFactory.decisions[0]?.dispatchResultHash).toBe(
      factory.decisions[0]?.dispatchResultHash,
    );
    expect(repeatedFactory.decisions[0]?.auditHash).toBe(
      factory.decisions[0]?.auditHash,
    );
    expect(researchDispatchCalls.count).toBe(0);
  });

  it("retains a typed refusal and independently checks frozen fallback parity", () => {
    const factory = createPhase7SearchPolicyFactory({
      role: "candidate",
      solverSeeds: SOLVER_SEEDS,
      verifyFallbackParity: true,
    });
    factory.policyConfig.createPolicy().chooseAction(policyInput(49));

    expect(factory.decisions).toHaveLength(1);
    expect(factory.decisions[0]).toMatchObject({
      role: "candidate",
      configId: PHASE7_CANDIDATE_CONFIG_ID,
      selectedMethod: "fallback",
      exactOutcome: "refused",
      exactRefusalCode: "ACTIVE_CARD_LIMIT",
      fallbackParity: "passed",
    });
    expect(researchDispatchCalls.count).toBe(1);
    expect(factory.decisions[0]?.exactResultHash).toMatch(
      /^fnv1a64:[0-9a-f]{16}$/u,
    );
  });

  it("selects an eligible exact late result and keeps configuration identities distinct", () => {
    const factory = createPhase7SearchPolicyFactory({
      role: "candidate",
      solverSeeds: SOLVER_SEEDS,
      verifyFallbackParity: true,
    });
    factory.policyConfig.createPolicy().chooseAction(policyInput(55));

    expect(factory.decisions).toHaveLength(1);
    expect(factory.decisions[0]).toMatchObject({
      selectedMethod: "exact",
      exactOutcome: "used",
      exactRefusalCode: null,
      fallbackParity: "not-checked",
      approximateAnalysisId: null,
    });
    expect(researchDispatchCalls.count).toBe(1);
    expect(phase7ComparisonConfigurationHash("reference")).not.toBe(
      phase7ComparisonConfigurationHash("candidate"),
    );
  });
});
