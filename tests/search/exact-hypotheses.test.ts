import { describe, expect, it } from "vitest";

import type { GameTimeline } from "../../src/events/timeline";
import {
  behaviorBeliefConfigurationHash,
  buildBehaviorBelief,
} from "../../src/inference/behavior-belief";
import { DEFAULT_BEHAVIOR_MODEL_CONFIG } from "../../src/inference/behavior-models";
import { buildHardBelief } from "../../src/inference/belief";
import { AdvancedSearchContractError } from "../../src/search/advanced-types";
import {
  exactHypothesesFromHardBelief,
  exactHypothesesFromWeightedBehavior,
} from "../../src/search/exact-hypotheses";
import { buildWeightedBehaviorHypotheses } from "../../src/search/weighted-hypotheses";
import { COMPLETE_GAME_EVENTS } from "../support/complete-game";
import { temporalTimeline } from "../inference/test-fixtures";

function exactTimeline(): GameTimeline {
  return {
    schemaVersion: 1,
    events: COMPLETE_GAME_EVENTS,
    cursor: 40,
    orphanedEvents: [],
  };
}

describe("exact information-hypothesis adapters", () => {
  it("marks complete hard support exhaustive and sampled hard support inexact", () => {
    const exactBelief = buildHardBelief(exactTimeline());
    const exactSet = exactHypothesesFromHardBelief({
      hardBelief: exactBelief,
      p2ModelId: "always-high",
      p3ModelId: "always-low",
    });

    expect(exactBelief.method).toBe("exact-enumeration");
    expect(exactSet).toMatchObject({
      sourceKind: "hard-only",
      supportKind: "exhaustive",
      supportWorldCount: "56",
      totalHypotheses: 56,
      distinctWitnesses: 56,
      totalMass: 1,
    });
    expect(exactSet.behaviorConfigHash).toBe(
      behaviorBeliefConfigurationHash(DEFAULT_BEHAVIOR_MODEL_CONFIG),
    );
    expect(
      exactSet.hypotheses.every(
        (hypothesis) =>
          hypothesis.p2ModelId === "always-high" &&
          hypothesis.p3ModelId === "always-low",
      ),
    ).toBe(true);
    expect(
      exactSet.hypotheses.reduce((sum, hypothesis) => sum + hypothesis.mass, 0),
    ).toBeCloseTo(1, 12);

    const sampledBelief = buildHardBelief(temporalTimeline(3), {
      seed: "exact-adapter-sampled",
      forceSampling: true,
      sampleCount: 7,
      maxExactWorlds: 1,
      maxExactProjectionOperations: 1,
      maxExactEstimatedBytes: 1,
    });
    const sampledSet = exactHypothesesFromHardBelief({
      hardBelief: sampledBelief,
      p2ModelId: "always-high",
      p3ModelId: "always-low",
    });
    expect(sampledBelief.method).toBe("direct-uniform-sample");
    expect(sampledSet.supportKind).toBe("sampled");
    expect(sampledSet.totalHypotheses).toBe(7);
    expect(BigInt(sampledSet.supportWorldCount)).toBeGreaterThan(7n);
  });

  it("preserves the weighted world/model envelope and exact support quality", () => {
    const timeline = exactTimeline();
    const hardBelief = buildHardBelief(timeline);
    const behaviorBelief = buildBehaviorBelief(timeline, hardBelief);
    const weighted = buildWeightedBehaviorHypotheses({
      hardBelief,
      behaviorBelief,
    });
    const exactSet = exactHypothesesFromWeightedBehavior({
      set: weighted,
      hardBelief,
      behaviorBelief,
    });

    expect(exactSet).toMatchObject({
      sourceKind: "weighted-behavior",
      sourceChecksum: weighted.checksum,
      supportKind: "exhaustive",
      supportWorldCount: "56",
      behaviorConfigHash: behaviorBelief.configHash,
      totalHypotheses: 56 * 49,
      distinctWitnesses: 56,
      totalMass: 1,
    });
    expect(exactSet.historyHash).toBe(hardBelief.evidence.historyHash);
    expect(
      new Set(exactSet.hypotheses.map((hypothesis) => hypothesis.hypothesisId)),
    ).toEqual(
      new Set(
        weighted.hypotheses.map((hypothesis) => hypothesis.hypothesisKey),
      ),
    );
    expect(Object.isFrozen(exactSet)).toBe(true);
    expect(Object.isFrozen(exactSet.hypotheses)).toBe(true);
  });

  it("rejects a stale or tampered weighted-belief envelope", () => {
    const timeline = temporalTimeline(3);
    const hardBelief = buildHardBelief(timeline, {
      seed: "exact-adapter-stale",
      forceSampling: true,
      sampleCount: 3,
      maxExactWorlds: 1,
      maxExactProjectionOperations: 1,
      maxExactEstimatedBytes: 1,
    });
    const behaviorBelief = buildBehaviorBelief(timeline, hardBelief);
    const weighted = buildWeightedBehaviorHypotheses({
      hardBelief,
      behaviorBelief,
    });
    const tampered = {
      ...weighted,
      historyHash: "fnv1a64:0000000000000000",
    };

    expect(() =>
      exactHypothesesFromWeightedBehavior({
        set: tampered,
        hardBelief,
        behaviorBelief,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_BELIEF",
      } satisfies Partial<AdvancedSearchContractError>),
    );
  });
});
