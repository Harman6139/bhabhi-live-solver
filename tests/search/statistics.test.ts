import { describe, expect, it } from "vitest";

import {
  clusterWilsonInterval,
  mean,
  pairedBootstrapDifference,
  wilsonInterval,
} from "../../src/search/statistics";

describe("Wilson probability intervals", () => {
  it.each([
    {
      successes: 0,
      trials: 1,
      lower: 0,
      upper: 0.7934506856227626,
    },
    {
      successes: 1,
      trials: 1,
      lower: 0.20654931437723745,
      upper: 1,
    },
    {
      successes: 5,
      trials: 10,
      lower: 0.236593090512564,
      upper: 0.7634069094874361,
    },
    {
      successes: 50,
      trials: 100,
      lower: 0.4038315303659956,
      upper: 0.5961684696340044,
    },
  ])(
    "matches the 95% regression vector for $successes/$trials",
    ({ successes, trials, lower, upper }) => {
      const interval = wilsonInterval(successes, trials);

      expect(interval).toMatchObject({
        level: 0.95,
        method: "wilson-score",
      });
      expect(interval.lower).toBeCloseTo(lower, 14);
      expect(interval.upper).toBeCloseTo(upper, 14);
      expect(interval.lower).toBeGreaterThanOrEqual(0);
      expect(interval.upper).toBeLessThanOrEqual(1);
    },
  );

  it("uses hidden-world clusters rather than flattened rollout repeats", () => {
    const clustered = clusterWilsonInterval([0, 1]);
    const sameClusterMeans = clusterWilsonInterval([0.25, 0.75]);
    const incorrectlyFlattened = wilsonInterval(100, 200);

    expect(clustered).toEqual({
      level: 0.95,
      method: "cluster-wilson-score",
      lower: 0.09453120573423074,
      upper: 0.9054687942657693,
    });
    expect(sameClusterMeans).toEqual(clustered);
    expect(incorrectlyFlattened.lower).toBeGreaterThan(clustered.lower);
    expect(incorrectlyFlattened.upper).toBeLessThan(clustered.upper);
  });

  it.each([
    [-1, 1],
    [2, 1],
    [0, 0],
    [0.5, 1],
    [Number.NaN, 1],
    [0, Number.POSITIVE_INFINITY],
  ])("rejects invalid binomial counts (%s, %s)", (successes, trials) => {
    expect(() => wilsonInterval(successes, trials)).toThrow(RangeError);
  });

  it.each([
    { values: [] },
    { values: [-0.01] },
    { values: [1.01] },
    { values: [Number.NaN] },
    { values: [Number.NEGATIVE_INFINITY] },
  ])("rejects invalid cluster means $values", ({ values }) => {
    expect(() => clusterWilsonInterval(values)).toThrow(RangeError);
  });
});

describe("paired cluster bootstrap", () => {
  const candidate = [0.92, 0.81, 0.73, 0.44, 0.18, 0.05, 0.61];
  const reference = [0.35, 0.64, 0.71, 0.52, 0.49, 0.09, 0.12];

  it("is deterministic for a fixed seed and preserves its regression vector", () => {
    const first = pairedBootstrapDifference(
      candidate,
      reference,
      128,
      "regression-seed",
    );
    const repeated = pairedBootstrapDifference(
      candidate,
      reference,
      128,
      "regression-seed",
    );

    expect(first).toEqual(repeated);
    expect(first).toEqual({
      level: 0.95,
      method: "paired-cluster-bootstrap-percentile",
      lower: -0.05857142857142857,
      upper: 0.3242857142857143,
    });
  });

  it("retains the sign of consistently better or worse paired outcomes", () => {
    const higher = pairedBootstrapDifference(
      [1, 0.9, 0.8, 0.7],
      [0, 0.1, 0.2, 0.3],
      512,
      "signed-bootstrap",
    );
    const lower = pairedBootstrapDifference(
      [0, 0.1, 0.2, 0.3],
      [1, 0.9, 0.8, 0.7],
      512,
      "signed-bootstrap",
    );

    expect(higher.lower).toBeGreaterThan(0);
    expect(higher.upper).toBeGreaterThan(0);
    expect(lower.lower).toBeLessThan(0);
    expect(lower.upper).toBeLessThan(0);
  });

  it("pairs by hidden-world occurrence rather than comparing flattened multisets", () => {
    const candidateByWorld = [0, 1, 0, 1];
    const referenceBySameWorld = [0, 1, 0, 1];
    const sameMarginalValuesButWrongWorlds = [1, 0, 1, 0];

    expect(
      pairedBootstrapDifference(
        candidateByWorld,
        referenceBySameWorld,
        512,
        "paired-worlds",
      ),
    ).toMatchObject({ lower: 0, upper: 0 });
    expect(
      pairedBootstrapDifference(
        candidateByWorld,
        sameMarginalValuesButWrongWorlds,
        512,
        "paired-worlds",
      ),
    ).toMatchObject({ lower: -1, upper: 1 });
  });

  it("uses a conservative bound when only one unequal cluster exists", () => {
    expect(pairedBootstrapDifference([1], [0], 512, "one-world")).toEqual({
      level: 0.95,
      method: "paired-cluster-bootstrap-percentile",
      lower: -1,
      upper: 1,
    });
  });

  it("returns the exact zero interval for identical arrays", () => {
    expect(
      pairedBootstrapDifference(
        [0, 0.25, 0.5, 0.75, 1],
        [0, 0.25, 0.5, 0.75, 1],
        1,
        "identical",
      ),
    ).toEqual({
      level: 0.95,
      method: "paired-cluster-bootstrap-percentile",
      lower: 0,
      upper: 0,
    });
  });

  it("rejects mismatched, empty, invalid, or nonpositive inputs", () => {
    expect(() => pairedBootstrapDifference([0], [0, 1], 10, "invalid")).toThrow(
      RangeError,
    );
    expect(() => pairedBootstrapDifference([], [], 10, "invalid")).toThrow(
      RangeError,
    );
    expect(() => pairedBootstrapDifference([0], [0], 0, "invalid")).toThrow(
      RangeError,
    );
    expect(() => pairedBootstrapDifference([0], [0], 1.5, "invalid")).toThrow(
      RangeError,
    );
    expect(() =>
      pairedBootstrapDifference([Number.NaN], [0], 10, "invalid"),
    ).toThrow(RangeError);
    expect(() => pairedBootstrapDifference([0], [1.01], 10, "invalid")).toThrow(
      RangeError,
    );
  });
});

describe("mean", () => {
  it("averages finite numeric values and rejects an empty sample", () => {
    expect(mean([0, 0.25, 0.75, 1])).toBe(0.5);
    expect(() => mean([])).toThrow(RangeError);
  });
});
