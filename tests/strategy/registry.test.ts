import { describe, expect, it } from "vitest";

import {
  MOTIF_IDS,
  MOTIF_REGISTRY,
  StrategyRegistryError,
  motifById,
  validateMotifRegistry,
  type MotifRegistryEntry,
} from "../../src/strategy/registry";

describe("strategy motif registry", () => {
  it("contains exactly M01-M48 in canonical order with frozen classifications", () => {
    expect(MOTIF_REGISTRY.map((entry) => entry.id)).toEqual(MOTIF_IDS);
    expect(validateMotifRegistry(MOTIF_REGISTRY)).toHaveLength(48);

    const classifications = MOTIF_REGISTRY.reduce(
      (counts, entry) => ({
        ...counts,
        [entry.classification]: counts[entry.classification] + 1,
      }),
      {
        "required-correctness": 0,
        reported: 0,
        hypothesis: 0,
      },
    );
    expect(classifications).toEqual({
      "required-correctness": 28,
      reported: 1,
      hypothesis: 19,
    });
  });

  it("records known direct, prerequisite, and absent coverage without experimental claims", () => {
    expect(motifById("M02")).toMatchObject({
      description:
        "A high lead can be a liability into a known later void because it remains pickup-high.",
      classification: "required-correctness",
      proposedExperimentId: "trap:diamond-q-user-pickup",
      currentCoverage: "direct",
      existingExecutableEvidencePaths: [
        "tests/rules/diamond-trap.test.ts",
        "tests/search/solver-strategy.test.ts",
      ],
    });
    expect(motifById("M29")).toMatchObject({
      classification: "hypothesis",
      currentCoverage: "prerequisite",
      proposedExperimentId: "search:crn-variance-ablation",
    });
    expect(motifById("M23")).toMatchObject({
      classification: "required-correctness",
      currentCoverage: "direct",
      existingExecutableEvidencePaths: [
        "tests/inference/behavior-models.test.ts",
        "tests/inference/behavior-belief.test.ts",
      ],
    });
    expect(motifById("M39")).toMatchObject({
      classification: "required-correctness",
      currentCoverage: "direct",
      existingExecutableEvidencePaths: [
        "tests/search/exact-endgame.test.ts",
        "tests/search/exact-endgame-oracle.test.ts",
        "tests/search/exact-information-state.test.ts",
        "tests/search/exact-endgame-dispatch.test.ts",
        "tests/search/research-dispatch.test.ts",
      ],
    });
    expect(motifById("M39").existingExecutableEvidencePaths).not.toContain(
      "tests/inference/belief.test.ts",
    );
    expect(motifById("M40")).toMatchObject({
      classification: "required-correctness",
      currentCoverage: "direct",
      existingExecutableEvidencePaths: [
        "tests/search/model-sensitivity.test.ts",
        "tests/search/exact-model-sensitivity.test.ts",
      ],
    });
    expect(motifById("M40").existingExecutableEvidencePaths).not.toContain(
      "tests/inference/behavior-models.test.ts",
    );
    expect(motifById("M48")).toMatchObject({
      classification: "hypothesis",
      currentCoverage: "prerequisite",
      existingExecutableEvidencePaths: [
        "tests/inference/behavior-models.test.ts",
        "tests/inference/behavior-belief.test.ts",
      ],
    });
    expect(
      MOTIF_REGISTRY.some(
        (entry) =>
          (entry.classification as string) === "experimental" ||
          (entry.classification as string).startsWith("retained"),
      ),
    ).toBe(false);
  });

  it("rejects duplicate, missing, and out-of-range IDs", () => {
    const duplicate: MotifRegistryEntry[] = MOTIF_REGISTRY.map((entry) => ({
      ...entry,
      existingExecutableEvidencePaths: [
        ...entry.existingExecutableEvidencePaths,
      ],
    }));
    const first = duplicate[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new Error("Canonical registry unexpectedly has no first entry.");
    }
    duplicate[1] = { ...first };
    expect(() => validateMotifRegistry(duplicate)).toThrow(
      StrategyRegistryError,
    );

    expect(() => validateMotifRegistry(MOTIF_REGISTRY.slice(1))).toThrow(
      /missing motif ID M01/u,
    );

    const outOfRange: unknown[] = MOTIF_REGISTRY.map((entry) => ({
      ...entry,
      existingExecutableEvidencePaths: [
        ...entry.existingExecutableEvidencePaths,
      ],
    }));
    outOfRange[0] = { ...first, id: "M49" };
    expect(() => validateMotifRegistry(outOfRange)).toThrow(
      StrategyRegistryError,
    );
  });

  it("enforces honest path/coverage consistency and strict entry shapes", () => {
    const absentWithPath: MotifRegistryEntry[] = MOTIF_REGISTRY.map(
      (entry) => ({
        ...entry,
        existingExecutableEvidencePaths: [
          ...entry.existingExecutableEvidencePaths,
        ],
      }),
    );
    const m01Index = absentWithPath.findIndex((entry) => entry.id === "M01");
    const m01 = absentWithPath[m01Index];
    expect(m01).toBeDefined();
    if (m01 === undefined) {
      throw new Error("M01 is missing.");
    }
    absentWithPath[m01Index] = {
      ...m01,
      currentCoverage: "absent",
      existingExecutableEvidencePaths: ["tests/strategy/registry.test.ts"],
    };
    expect(() => validateMotifRegistry(absentWithPath)).toThrow(
      /absent coverage must not cite executable paths/u,
    );

    const extraField: unknown[] = MOTIF_REGISTRY.map((entry) => ({
      ...entry,
      existingExecutableEvidencePaths: [
        ...entry.existingExecutableEvidencePaths,
      ],
    }));
    const canonicalFirst = MOTIF_REGISTRY[0];
    extraField[0] = { ...canonicalFirst, inventedResult: "passed" };
    expect(() => validateMotifRegistry(extraField)).toThrow(
      StrategyRegistryError,
    );
  });
});
