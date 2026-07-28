import { describe, expect, it } from "vitest";

import {
  calibrationSampleSize,
  sampleStandardDeviation,
} from "../../src/calibration/aggregation";
import {
  calibrationClusterId,
  terminalClusterId,
} from "../../src/calibration/types";

describe("preregistered calibration sample size", () => {
  it("applies the exact formula, 10% inflation, and block-of-16 rounding", () => {
    const plan = calibrationSampleSize({ standardDeviation: 0.1 });

    expect(plan).toMatchObject({
      zMultiplier: 1.96,
      targetHalfWidth: 0.005,
      inflationFactor: 1.1,
      blockSize: 16,
      minimumClusters: 1_000,
      maximumClusters: 10_000,
      formulaClusters: 1_537,
      inflatedClusters: 1_691,
      blockRoundedClusters: 1_696,
      selectedClusters: 1_696,
      clamp: "none",
    });
  });

  it("clamps low and high variance plans to 1,000 and 10,000 clusters", () => {
    expect(calibrationSampleSize({ standardDeviation: 0 })).toMatchObject({
      formulaClusters: 0,
      selectedClusters: 1_000,
      clamp: "minimum",
    });
    expect(calibrationSampleSize({ standardDeviation: 1 })).toMatchObject({
      selectedClusters: 10_000,
      clamp: "maximum",
    });
  });

  it("supports typed policy overrides without changing the formula order", () => {
    expect(
      calibrationSampleSize({
        standardDeviation: 0.05,
        zMultiplier: 1,
        targetHalfWidth: 0.01,
        inflationFactor: 1,
        blockSize: 1,
        minimumClusters: 1,
        maximumClusters: 100,
      }),
    ).toMatchObject({
      formulaClusters: 25,
      inflatedClusters: 25,
      blockRoundedClusters: 25,
      selectedClusters: 25,
      clamp: "none",
    });
  });

  it("uses sample rather than population standard deviation", () => {
    expect(sampleStandardDeviation([1, 2, 3])).toBe(1);
    expect(() => sampleStandardDeviation([1])).toThrow(RangeError);
  });
});

describe("explicit terminal and calibration cluster IDs", () => {
  it("keeps terminal cells crossed while separating calibration style cells", () => {
    const terminal = terminalClusterId("qualification", 42);
    const firstCell = calibrationClusterId("qualification", "c08", 42);
    const secondCell = calibrationClusterId("qualification", "c09", 42);

    expect(terminal).toBe("qualification/base/42");
    expect(firstCell).toBe("qualification/cell/c08/base/42");
    expect(secondCell).toBe("qualification/cell/c09/base/42");
    expect(firstCell).not.toBe(secondCell);

    // Rotation and configuration are deliberately absent from both helpers,
    // so callers cannot accidentally treat them as independent clusters.
    expect(terminalClusterId("qualification", 42)).toBe(terminal);
    expect(calibrationClusterId("qualification", "c08", 42)).toBe(firstCell);
  });

  it("rejects malformed identifiers and indices", () => {
    expect(() => terminalClusterId("", 0)).toThrow(TypeError);
    expect(() => terminalClusterId("dev", -1)).toThrow(RangeError);
    expect(() => calibrationClusterId("dev", "", 0)).toThrow(TypeError);
    expect(() =>
      calibrationClusterId("dev", "c01", Number.POSITIVE_INFINITY),
    ).toThrow(RangeError);
  });
});
