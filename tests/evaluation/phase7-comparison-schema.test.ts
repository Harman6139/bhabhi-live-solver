import { describe, expect, it } from "vitest";

import {
  PHASE7_COMPARISON_BOOTSTRAP_RESAMPLES,
  phase7ComparisonConfigurationSchema,
  phase7ComparisonDecisionRecordSchema,
} from "../../src/evaluation/phase7-comparison-schema";

function exactDecisionFixture() {
  return {
    schemaVersion: 2,
    protocolId: "eval-v1",
    runId: "phase7-schema-fixture",
    split: "dev",
    evidenceClass: "phase7-development-screen",
    pairId: "dev/c01_random__random/0/0/0",
    clusterId: "dev/0",
    configRole: "candidate",
    configId: "candidate-fixture",
    styleCellId: "c01_random__random",
    baseIndex: 0,
    rotation: 0,
    replicate: 0,
    gameId: "game-fixture",
    recordType: "phase7-comparison-decision",
    decisionId: "game-fixture/user/0",
    decisionOrdinal: 0,
    eventIndex: 3,
    publicHistoryHash: "fnv1a64:history",
    publicStateHash: "fnv1a64:state",
    observationHash: "fnv1a64:observation",
    actionKind: "play-card",
    selectedCard: "AS",
    selectedTakeTarget: null,
    selectedActionHash: "fnv1a64:action",
    dispatchOutcome: "exact",
    quality: "Exact",
    exactOutcome: "used",
    exactRefusalCode: null,
    exactRefusalDetail: null,
    fallbackParity: "not-checked",
    dispatchHash: "fnv1a64:dispatch",
    analysisInputHash: "fnv1a64:input",
    analysisOutputHash: "fnv1a64:output",
    exactAlgorithmId: "exact-fixture-v1",
    exactConfigHash: "fnv1a64:exact-config",
    hypothesisSetHash: "fnv1a64:hypotheses",
    exactResultHash: "fnv1a64:exact-result",
    exactDiagnosticsHash: "fnv1a64:exact-diagnostics",
    exactActionValuesHash: "fnv1a64:exact-action-values",
    positionalDiagnosticsHash: "fnv1a64:positional",
    fallbackConfigHash: null,
    fallbackResultHash: null,
    beliefSeedId: "belief-seed",
    searchSeedId: "search-seed",
  } as const;
}

describe("Phase 7 paired-comparison schemas", () => {
  it("freezes two explicit config roles and the 20k bootstrap contract", () => {
    expect(PHASE7_COMPARISON_BOOTSTRAP_RESAMPLES).toBe(20_000);
    expect(
      phase7ComparisonConfigurationSchema.parse({
        role: "reference",
        configId: "phase5-balanced-hard-only-reference-v1",
        configHash: "fnv1a64:reference",
        method: "frozen-phase5-balanced-hard-only",
        executionPath: "direct-phase5-recommend-from-timeline-v1",
        budgetId: "balanced",
        beliefMode: "hard-only",
        continuationPolicies: {
          user: "documented-basic",
          p2: "documented-basic",
          p3: "documented-basic",
        },
        exactScreen: null,
        exactEnabled: false,
        behaviorWeightingEnabled: false,
      }),
    ).toMatchObject({
      role: "reference",
      exactEnabled: false,
    });
    expect(() =>
      phase7ComparisonConfigurationSchema.parse({
        role: "third-arm",
        configId: "invalid",
        configHash: "invalid",
        method: "invalid",
        exactEnabled: false,
        behaviorWeightingEnabled: false,
      }),
    ).toThrow();
  });

  it("accepts zero-based decision ordinals and binds non-partial Exact diagnostics", () => {
    expect(
      phase7ComparisonDecisionRecordSchema.parse(exactDecisionFixture()),
    ).toMatchObject({
      decisionOrdinal: 0,
      exactOutcome: "used",
      exactDiagnosticsHash: "fnv1a64:exact-diagnostics",
      positionalDiagnosticsHash: "fnv1a64:positional",
    });
    expect(() =>
      phase7ComparisonDecisionRecordSchema.parse({
        ...exactDecisionFixture(),
        decisionOrdinal: -1,
      }),
    ).toThrow();
  });
});
