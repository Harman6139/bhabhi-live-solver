import { describe, expect, it } from "vitest";

import { stableHash } from "../../src/events/stable-hash";
import {
  buildBehaviorBelief,
  type BehaviorBelief,
} from "../../src/inference/behavior-belief";
import {
  BEHAVIOR_MODEL_IDS,
  type BehaviorModelId,
} from "../../src/inference/behavior-models";
import { buildHardBelief } from "../../src/inference/belief";
import type { HardBelief } from "../../src/inference/types";
import { AdvancedSearchContractError } from "../../src/search/advanced-types";
import { buildWeightedBehaviorHypotheses } from "../../src/search/weighted-hypotheses";
import { temporalTimeline } from "../inference/test-fixtures";

function sampledBeliefs(
  eventCount: number,
  sampleCount: number,
  seed: string,
): {
  readonly hardBelief: HardBelief;
  readonly behaviorBelief: BehaviorBelief;
} {
  const timeline = temporalTimeline(eventCount);
  const hardBelief = buildHardBelief(timeline, {
    seed,
    forceSampling: true,
    sampleCount,
    maxExactWorlds: 1,
    maxExactProjectionOperations: 1,
    maxExactEstimatedBytes: 1,
  });
  return {
    hardBelief,
    behaviorBelief: buildBehaviorBelief(timeline, hardBelief),
  };
}

function modelProbability(
  vector: readonly {
    readonly modelId: BehaviorModelId;
    readonly probability: number;
  }[],
  modelId: BehaviorModelId,
): number {
  const entry = vector.find((candidate) => candidate.modelId === modelId);
  if (entry === undefined) {
    throw new Error(`Missing ${modelId} model probability.`);
  }
  return entry.probability;
}

function duplicateOnlyWorld(
  hardBelief: HardBelief,
  copies: number,
): HardBelief {
  const world = hardBelief.worlds[0];
  if (world === undefined) {
    throw new Error("Duplicate fixture has no base world.");
  }
  const worlds = Array.from({ length: copies }, () => world);
  return {
    ...hardBelief,
    worlds,
    diagnostics: {
      ...hardBelief.diagnostics,
      generatedWorlds: copies,
      uniqueWitnesses: 1,
      distinctCurrentHands: 1,
      duplicateSamples: copies - 1,
      worldSetChecksum: stableHash({
        schemaVersion: 1,
        orderedWitnessIds: worlds.map((entry) => entry.witnessId),
      }),
    },
  };
}

describe("correlated weighted behavior hypotheses", () => {
  it("uses each occurrence's conditional model vectors, never marginals", () => {
    const { hardBelief, behaviorBelief } = sampledBeliefs(
      3,
      8,
      "advanced-correlated-worlds",
    );
    const result = buildWeightedBehaviorHypotheses({
      hardBelief,
      behaviorBelief,
    });

    expect(result.occurrenceCount).toBe(8);
    expect(result.hypothesesPerOccurrence).toBe(49);
    expect(result.totalHypotheses).toBe(392);
    expect(result.totalMass).toBeCloseTo(1, 12);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.hypotheses[0])).toBe(true);
    expect(result.checksum).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);

    let differsFromMarginalProduct = false;
    for (const hypothesis of result.hypotheses) {
      const occurrence =
        behaviorBelief.worldOccurrences[hypothesis.occurrenceIndex];
      if (occurrence === undefined) {
        throw new Error("Missing behavior occurrence.");
      }
      const expected =
        occurrence.weight *
        modelProbability(
          occurrence.conditionalModelProbabilities.p2,
          hypothesis.p2ModelId,
        ) *
        modelProbability(
          occurrence.conditionalModelProbabilities.p3,
          hypothesis.p3ModelId,
        );
      expect(hypothesis.mass).toBe(expected);

      const marginalProduct =
        occurrence.weight *
        modelProbability(
          behaviorBelief.opponentPosteriors.p2,
          hypothesis.p2ModelId,
        ) *
        modelProbability(
          behaviorBelief.opponentPosteriors.p3,
          hypothesis.p3ModelId,
        );
      if (Math.abs(expected - marginalProduct) > 1e-12) {
        differsFromMarginalProduct = true;
      }
    }
    expect(differsFromMarginalProduct).toBe(true);
  });

  it("retains duplicate sampled occurrences as distinct weighted clusters", () => {
    const timeline = temporalTimeline(3);
    const single = buildHardBelief(timeline, {
      seed: "advanced-duplicate-base",
      forceSampling: true,
      sampleCount: 1,
      maxExactWorlds: 1,
      maxExactProjectionOperations: 1,
      maxExactEstimatedBytes: 1,
    });
    const hardBelief = duplicateOnlyWorld(single, 2);
    const behaviorBelief = buildBehaviorBelief(timeline, hardBelief);
    const result = buildWeightedBehaviorHypotheses({
      hardBelief,
      behaviorBelief,
    });

    expect(result.occurrenceCount).toBe(2);
    expect(result.distinctWitnesses).toBe(1);
    expect(result.totalHypotheses).toBe(98);
    expect(
      result.hypotheses.filter(
        (hypothesis) => hypothesis.occurrenceIndex === 0,
      ),
    ).toHaveLength(49);
    expect(
      result.hypotheses.filter(
        (hypothesis) => hypothesis.occurrenceIndex === 1,
      ),
    ).toHaveLength(49);
    expect(
      new Set(result.hypotheses.map((hypothesis) => hypothesis.hypothesisKey))
        .size,
    ).toBe(98);

    for (const occurrenceIndex of [0, 1]) {
      const occurrenceMass = result.hypotheses
        .filter((hypothesis) => hypothesis.occurrenceIndex === occurrenceIndex)
        .reduce((sum, hypothesis) => sum + hypothesis.mass, 0);
      expect(occurrenceMass).toBeCloseTo(0.5, 12);
    }
  });

  it("uses deterministic occurrence/model ordering and stable hashes", () => {
    const beliefs = sampledBeliefs(3, 3, "advanced-ordering");
    const first = buildWeightedBehaviorHypotheses(beliefs);
    const second = buildWeightedBehaviorHypotheses(beliefs);

    expect(first).toEqual(second);
    expect(
      first.hypotheses
        .slice(0, 7)
        .map((hypothesis) => [
          hypothesis.occurrenceIndex,
          hypothesis.p2ModelId,
          hypothesis.p3ModelId,
        ]),
    ).toEqual(BEHAVIOR_MODEL_IDS.map((p3ModelId) => [0, "random", p3ModelId]));
    expect(first.hypotheses[49]).toMatchObject({
      occurrenceIndex: 1,
      p2ModelId: "random",
      p3ModelId: "random",
    });
  });

  it("rejects stale envelopes and content-hash tampering", () => {
    const first = sampledBeliefs(3, 2, "advanced-stale-first");
    const second = sampledBeliefs(3, 2, "advanced-stale-second");

    expect(() =>
      buildWeightedBehaviorHypotheses({
        hardBelief: first.hardBelief,
        behaviorBelief: second.behaviorBelief,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "STALE_BELIEF",
      } satisfies Partial<AdvancedSearchContractError>),
    );

    const tampered = structuredClone(first.behaviorBelief);
    const occurrence = tampered.worldOccurrences[0];
    if (occurrence === undefined) {
      throw new Error("Tamper fixture has no occurrence.");
    }
    Object.assign(occurrence, { weight: occurrence.weight / 2 });
    expect(() =>
      buildWeightedBehaviorHypotheses({
        hardBelief: first.hardBelief,
        behaviorBelief: tampered,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_BELIEF",
      } satisfies Partial<AdvancedSearchContractError>),
    );
  });
});
