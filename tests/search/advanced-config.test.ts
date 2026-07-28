import { describe, expect, it } from "vitest";

import {
  DEFAULT_ADVANCED_SEARCH_CONFIG,
  advancedSearchConfigurationHash,
  validateAdvancedSearchConfig,
} from "../../src/search/advanced-config";
import {
  AdvancedSearchContractError,
  EXACT_INELIGIBILITY_CODES,
} from "../../src/search/advanced-types";

describe("advanced search foundation config", () => {
  it("stays research-only, deeply frozen, and conservatively capped", () => {
    const config = validateAdvancedSearchConfig();

    expect(config).toEqual(DEFAULT_ADVANCED_SEARCH_CONFIG);
    expect(advancedSearchConfigurationHash(config)).toBe(
      advancedSearchConfigurationHash(),
    );
    expect(config.executionMode).toBe("research-only");
    expect(config.exact.maxActiveCards).toBeLessThanOrEqual(52);
    expect(config.exact.maxBranches).toBeGreaterThanOrEqual(
      config.exact.maxInformationStates,
    );
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.exact)).toBe(true);
    expect(EXACT_INELIGIBILITY_CODES).toContain("INCOMPLETE_ENUMERATION");
    expect(EXACT_INELIGIBILITY_CODES).toContain("CYCLIC_INFORMATION_GRAPH");
  });

  it("validates overrides without mutating the frozen defaults", () => {
    const config = validateAdvancedSearchConfig({
      exact: {
        maxActiveCards: 8,
        maxJointHypotheses: 49,
        maxInformationStates: 1_000,
        maxBranches: 2_000,
      },
      approximateHypothesisSamples: 32,
      deadlineMs: 750,
    });

    expect(config).toEqual({
      schemaVersion: 1,
      executionMode: "research-only",
      exact: {
        maxActiveCards: 8,
        maxJointHypotheses: 49,
        maxInformationStates: 1_000,
        maxBranches: 2_000,
      },
      approximateHypothesisSamples: 32,
      deadlineMs: 750,
    });
    expect(DEFAULT_ADVANCED_SEARCH_CONFIG.exact.maxActiveCards).toBe(12);
  });

  it.each([
    { exact: { maxActiveCards: 0 } },
    { exact: { maxActiveCards: 53 } },
    { exact: { maxJointHypotheses: Number.NaN } },
    {
      exact: {
        maxInformationStates: 101,
        maxBranches: 100,
      },
    },
    { approximateHypothesisSamples: 1.5 },
    { deadlineMs: Number.POSITIVE_INFINITY },
  ])("rejects invalid limits %#", (input) => {
    expect(() => validateAdvancedSearchConfig(input)).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
      } satisfies Partial<AdvancedSearchContractError>),
    );
  });

  it("rejects unknown fields and any attempted production mode", () => {
    expect(() =>
      validateAdvancedSearchConfig({
        productionEnabled: true,
      } as never),
    ).toThrow(/unknown fields/u);
    expect(() =>
      validateAdvancedSearchConfig({
        executionMode: "production",
      } as never),
    ).toThrow(/research-only/u);
    expect(() =>
      validateAdvancedSearchConfig({
        schemaVersion: 2,
      } as never),
    ).toThrow(/schemaVersion must be 1/u);
    expect(() =>
      validateAdvancedSearchConfig({
        exact: { magicPruning: true },
      } as never),
    ).toThrow(/unknown fields/u);
  });

  it("hashes normalized semantics deterministically and binds every limit", () => {
    const first = advancedSearchConfigurationHash({
      exact: {
        maxActiveCards: 9,
        maxBranches: 8_000,
        maxInformationStates: 2_000,
        maxJointHypotheses: 98,
      },
      deadlineMs: 1_500,
      approximateHypothesisSamples: 64,
    });
    const reordered = advancedSearchConfigurationHash({
      approximateHypothesisSamples: 64,
      deadlineMs: 1_500,
      exact: {
        maxJointHypotheses: 98,
        maxInformationStates: 2_000,
        maxBranches: 8_000,
        maxActiveCards: 9,
      },
    });

    expect(first).toBe(reordered);
    expect(first).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
    expect(
      advancedSearchConfigurationHash({
        exact: {
          maxActiveCards: 10,
          maxBranches: 8_000,
          maxInformationStates: 2_000,
          maxJointHypotheses: 98,
        },
        deadlineMs: 1_500,
        approximateHypothesisSamples: 64,
      }),
    ).not.toBe(first);
  });
});
