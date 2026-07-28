import { describe, expect, it } from "vitest";

import { createActorObservation } from "../../src/agents/observation";
import type { PolicyObservation } from "../../src/agents/policies";
import {
  activeTimelineEvents,
  replayTimeline,
} from "../../src/events/timeline";
import { buildBehaviorBelief } from "../../src/inference/behavior-belief";
import { BEHAVIOR_MODEL_IDS } from "../../src/inference/behavior-models";
import { buildHardBelief } from "../../src/inference/belief";
import { AdvancedSearchContractError } from "../../src/search/advanced-types";
import { evaluateActorSafePolicy } from "../../src/search/policy-kernel";
import { temporalTimeline } from "../inference/test-fixtures";

function p2DecisionObservation(): PolicyObservation {
  const timeline = temporalTimeline(1);
  const replay = replayTimeline(timeline);
  const hardBelief = buildHardBelief(timeline, {
    seed: "advanced-policy-kernel",
    forceSampling: true,
    sampleCount: 1,
    maxExactWorlds: 1,
    maxExactProjectionOperations: 1,
    maxExactEstimatedBytes: 1,
  });
  const behaviorBelief = buildBehaviorBelief(timeline, hardBelief);
  const world = hardBelief.worlds[0];
  if (world === undefined) {
    throw new Error("Policy-kernel fixture has no world.");
  }
  return createActorObservation(
    {
      publicState: replay.state,
      exactHands: world.currentHands,
    },
    "p2",
    behaviorBelief.decisionOrdinals.p2,
    activeTimelineEvents(timeline),
  );
}

describe("actor-safe behavior policy kernel", () => {
  it("returns canonical positive distributions for every Phase 6 model", () => {
    const observation = p2DecisionObservation();

    for (const modelId of BEHAVIOR_MODEL_IDS) {
      const result = evaluateActorSafePolicy({ observation, modelId });
      expect(result.seat).toBe("p2");
      expect(result.modelId).toBe(modelId);
      expect(result.decisionOrdinal).toBe(observation.decisionOrdinal);
      expect(result.probabilities.length).toBeGreaterThan(0);
      expect(
        result.probabilities.reduce((sum, entry) => sum + entry.probability, 0),
      ).toBeCloseTo(1, 12);
      expect(
        result.probabilities.every(
          (entry) =>
            entry.probability > 0 &&
            (entry.action.kind === "take-hand" ||
              observation.ownHand.includes(entry.action.card)),
        ),
      ).toBe(true);
      expect(result.probabilities.map((entry) => entry.actionKey)).toEqual(
        [...result.probabilities]
          .map((entry) => entry.actionKey)
          .sort((left, right) => left.localeCompare(right)),
      );
      expect(result.distributionHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.probabilities)).toBe(true);
    }
  });

  it("is deterministic and binds the model/config to its hashes", () => {
    const observation = p2DecisionObservation();
    const first = evaluateActorSafePolicy({
      observation,
      modelId: "always-high",
      config: { lapseProbability: 0.08 },
    });
    const repeat = evaluateActorSafePolicy({
      observation,
      modelId: "always-high",
      config: { lapseProbability: 0.08 },
    });
    const changedModel = evaluateActorSafePolicy({
      observation,
      modelId: "always-low",
      config: { lapseProbability: 0.08 },
    });
    const changedConfig = evaluateActorSafePolicy({
      observation,
      modelId: "always-high",
      config: { lapseProbability: 0.2 },
    });

    expect(first).toEqual(repeat);
    expect(changedModel.distributionHash).not.toBe(first.distributionHash);
    expect(changedConfig.configHash).not.toBe(first.configHash);
    expect(changedConfig.distributionHash).not.toBe(first.distributionHash);
  });

  it("rejects user decisions, stale turns, unknown models, and bad config", () => {
    const observation = p2DecisionObservation();
    for (const invalid of [
      { ...observation, seat: "user" as const },
      { ...observation, turn: "p3" as const },
    ]) {
      expect(() =>
        evaluateActorSafePolicy({
          observation: invalid,
          modelId: "always-high",
        }),
      ).toThrow(
        expect.objectContaining({
          code: "INVALID_POLICY_OBSERVATION",
        } satisfies Partial<AdvancedSearchContractError>),
      );
    }
    expect(() =>
      evaluateActorSafePolicy({
        observation,
        modelId: "imaginary-model" as never,
      }),
    ).toThrow(/unknown model/u);
    expect(() =>
      evaluateActorSafePolicy({
        observation,
        modelId: "always-high",
        config: { lapseProbability: 0 },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
      } satisfies Partial<AdvancedSearchContractError>),
    );
  });

  it("rejects hidden-world fields even when smuggled through runtime casts", () => {
    const observation = p2DecisionObservation();
    const unsafe = {
      ...observation,
      exactHands: {
        user: ["AS"],
        p2: observation.ownHand,
        p3: ["KS"],
      },
      witnessId: "hidden-world-a",
    } as unknown as PolicyObservation;

    expect(() =>
      evaluateActorSafePolicy({
        observation: unsafe,
        modelId: "always-high",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_POLICY_OBSERVATION",
      } satisfies Partial<AdvancedSearchContractError>),
    );

    const unknownSecret = {
      ...observation,
      opponentCardsUnderAnotherName: ["AS", "KS"],
    } as unknown as PolicyObservation;
    expect(() =>
      evaluateActorSafePolicy({
        observation: unknownSecret,
        modelId: "always-high",
      }),
    ).toThrow(/outside the actor-safe schema/u);
  });
});
