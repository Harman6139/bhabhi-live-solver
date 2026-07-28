import { describe, expect, it } from "vitest";
import {
  FEASIBLE_SUPPORT_REGULARIZER_VERSION,
  regularizeFeasibleSupport,
} from "../../src/calibration/support-regularization";

describe("hard-feasible support regularization", () => {
  it("gives every unresolved feasible label positive mass without reviving impossible labels", () => {
    const result = regularizeFeasibleSupport({
      distribution: [
        { label: "impossible", probability: 0 },
        { label: "observed", probability: 1 },
        { label: "sample-missed", probability: 0 },
      ],
      feasibleLabels: ["sample-missed", "observed"],
      hardKnown: false,
      effectiveSampleSize: 64,
      config: { pseudocountPerFeasibleLabel: 0.5 },
    });

    expect(result.distribution).toEqual([
      { label: "impossible", probability: 0 },
      { label: "observed", probability: 64.5 / 65 },
      { label: "sample-missed", probability: 0.5 / 65 },
    ]);
    expect(result.rawZeroFeasibleLabelsBefore).toEqual(["sample-missed"]);
    expect(
      result.distribution.reduce(
        (total, entry) => total + entry.probability,
        0,
      ),
    ).toBeCloseTo(1, 14);
    expect(result.configHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
    expect(FEASIBLE_SUPPORT_REGULARIZER_VERSION).toBe(
      "feasible-support-jeffreys-v1",
    );
  });

  it("leaves a hard-known fact exactly unchanged", () => {
    const result = regularizeFeasibleSupport({
      distribution: [
        { label: "p2", probability: 1 },
        { label: "p3", probability: 0 },
      ],
      feasibleLabels: ["p2"],
      hardKnown: true,
      effectiveSampleSize: 1,
      config: { pseudocountPerFeasibleLabel: 10 },
    });

    expect(result.distribution).toEqual([
      { label: "p2", probability: 1 },
      { label: "p3", probability: 0 },
    ]);
    expect(result.priorMassAdded).toBe(0);
  });

  it("supports a zero-strength diagnostic mode that retains raw zeros", () => {
    const result = regularizeFeasibleSupport({
      distribution: [
        { label: "false", probability: 0 },
        { label: "true", probability: 1 },
      ],
      feasibleLabels: ["false", "true"],
      hardKnown: false,
      effectiveSampleSize: 32,
      config: { pseudocountPerFeasibleLabel: 0 },
    });

    expect(result.distribution).toEqual([
      { label: "false", probability: 0 },
      { label: "true", probability: 1 },
    ]);
    expect(result.rawZeroFeasibleLabelsBefore).toEqual(["false"]);
  });

  it("rejects sampled mass outside hard support and malformed support contracts", () => {
    expect(() =>
      regularizeFeasibleSupport({
        distribution: [
          { label: "p2", probability: 0.9 },
          { label: "p3", probability: 0.1 },
        ],
        feasibleLabels: ["p2"],
        hardKnown: true,
        effectiveSampleSize: 64,
        config: { pseudocountPerFeasibleLabel: 0.5 },
      }),
    ).toThrow(/hard-infeasible label/u);

    expect(() =>
      regularizeFeasibleSupport({
        distribution: [{ label: "only", probability: 1 }],
        feasibleLabels: [],
        hardKnown: false,
        effectiveSampleSize: 1,
        config: { pseudocountPerFeasibleLabel: 0.5 },
      }),
    ).toThrow(/non-empty unique set/u);

    expect(() =>
      regularizeFeasibleSupport({
        distribution: [{ label: "only", probability: 1 }],
        feasibleLabels: ["missing"],
        hardKnown: false,
        effectiveSampleSize: 1,
        config: { pseudocountPerFeasibleLabel: 0.5 },
      }),
    ).toThrow(/absent from the distribution/u);
  });

  it("uses effective sample size as data mass deterministically", () => {
    const small = regularizeFeasibleSupport({
      distribution: [
        { label: "a", probability: 0.75 },
        { label: "b", probability: 0.25 },
      ],
      feasibleLabels: ["a", "b"],
      hardKnown: false,
      effectiveSampleSize: 2,
      config: { pseudocountPerFeasibleLabel: 0.5 },
    });
    const large = regularizeFeasibleSupport({
      distribution: [
        { label: "a", probability: 0.75 },
        { label: "b", probability: 0.25 },
      ],
      feasibleLabels: ["a", "b"],
      hardKnown: false,
      effectiveSampleSize: 200,
      config: { pseudocountPerFeasibleLabel: 0.5 },
    });

    expect(small.distribution[0]?.probability).toBeCloseTo(2 / 3, 14);
    expect(large.distribution[0]?.probability).toBeGreaterThan(
      small.distribution[0]?.probability ?? 1,
    );
    expect(large.distribution[0]?.probability).toBeLessThan(0.75);
  });
});
