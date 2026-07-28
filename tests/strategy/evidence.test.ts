import { describe, expect, it } from "vitest";

import {
  pairedActionValueRecordSchema,
  stateProvenanceSchema,
  strategyFailureRecordSchema,
  summarizeStrategyEvidence,
  verifyFinalStrategyEvidence,
  verifyStrategyEvidence,
  type MotifDisposition,
  type StrategyCommandRecord,
  type StrategyEvidenceBundle,
} from "../../src/strategy/evidence";
import { MOTIF_REGISTRY, type MotifId } from "../../src/strategy/registry";

const PASS_COMMAND: StrategyCommandRecord = {
  commandId: "command/pass",
  argv: ["npm", "run", "test:strategy"],
  workingDirectory: ".",
  sourceRevision: "source-revision",
  environmentChecksum: "environment-checksum",
  exitCode: 0,
};

function dispositionForRegistryEntry(
  motifId: MotifId,
  classification: (typeof MOTIF_REGISTRY)[number]["classification"],
): MotifDisposition {
  if (classification === "required-correctness") {
    return {
      motifId,
      disposition: "retained-required",
      rationale:
        "Required rule or contract behavior has direct passing evidence.",
      evidenceIds: [`evidence/${motifId}`],
      actionValueIds: [],
      boundaryRecordIds: [],
      failureIds: [],
    };
  }
  return {
    motifId,
    disposition: "deferred-phase7",
    phase7Dependency: `Phase 7 dependency for ${motifId}`,
    rationale: "No experimental claim is made by this verifier fixture.",
    evidenceIds: [],
    actionValueIds: [],
    boundaryRecordIds: [],
    failureIds: [],
  };
}

function completeVerifierFixture(): StrategyEvidenceBundle {
  const required = MOTIF_REGISTRY.filter(
    (entry) => entry.classification === "required-correctness",
  );
  return {
    schemaVersion: 1,
    commands: [PASS_COMMAND],
    states: [],
    actionValues: [],
    boundaries: [],
    failures: [],
    evidence: required.map((entry) => ({
      evidenceId: `evidence/${entry.id}`,
      motifId: entry.id,
      kind: "direct-correctness",
      status: "passed",
      testPath: "tests/strategy/evidence.test.ts",
      commandId: PASS_COMMAND.commandId,
      resultChecksum: `result/${entry.id}`,
    })),
    dispositions: MOTIF_REGISTRY.map((entry) =>
      dispositionForRegistryEntry(entry.id, entry.classification),
    ),
    eligibility: [],
    productionDecisions: [],
  };
}

function replaceDisposition(
  bundle: StrategyEvidenceBundle,
  replacement: MotifDisposition,
): void {
  const index = bundle.dispositions.findIndex(
    (entry) => entry.motifId === replacement.motifId,
  );
  if (index < 0) {
    throw new Error(`Missing ${replacement.motifId} disposition.`);
  }
  bundle.dispositions[index] = replacement;
}

function addExperimentalM01(bundle: StrategyEvidenceBundle): void {
  bundle.states.push({
    stateId: "state/M01",
    motifId: "M01",
    provenance: {
      kind: "synthetic-transition",
      fixtureId: "fixture/M01",
      stateHash: "state-hash",
      transitionSystemVersion: "exact-transition-v1",
      constructionDigest: "construction-digest",
    },
    rulesChecksum: "rules-checksum",
    solverConfigChecksum: "solver-checksum",
    seedIds: ["paired-seed"],
    commandId: PASS_COMMAND.commandId,
  });
  bundle.actionValues.push({
    actionValueId: "action-value/M01",
    motifId: "M01",
    stateId: "state/M01",
    pairId: "pair/M01",
    pairedSeedId: "paired-seed",
    commandId: PASS_COMMAND.commandId,
    confirmation: "tune",
    finding: "positive-witness",
    left: {
      actionKey: "play:2C",
      terminalBhabhiRisk: 0.2,
      terminalRollouts: 100,
      outcomeChecksum: "left-outcomes",
    },
    right: {
      actionKey: "play:3D",
      terminalBhabhiRisk: 0.3,
      terminalRollouts: 100,
      outcomeChecksum: "right-outcomes",
    },
    deltaLeftMinusRight: -0.1,
    preferredActionKey: "play:2C",
  });
  bundle.boundaries.push({
    boundaryRecordId: "boundary/M01",
    motifId: "M01",
    commandId: PASS_COMMAND.commandId,
    finding: "boundary",
    scope: "finite-search",
    description: "The witness reverses when the resulting thulla is unsafe.",
    stateIds: ["state/M01"],
    actionValueIds: ["action-value/M01"],
  });
  bundle.evidence.push({
    evidenceId: "evidence/M01",
    motifId: "M01",
    kind: "experimental",
    status: "passed",
    testPath: "tests/strategy/evidence.test.ts",
    commandId: PASS_COMMAND.commandId,
    resultChecksum: "experimental-result/M01",
  });
  replaceDisposition(bundle, {
    motifId: "M01",
    disposition: "retained-experimental",
    rationale:
      "Verifier fixture with the complete experimental evidence shape.",
    evidenceIds: ["evidence/M01"],
    actionValueIds: ["action-value/M01"],
    boundaryRecordIds: ["boundary/M01"],
    failureIds: [],
  });
}

describe("strict strategy evidence records", () => {
  it("distinguishes replayable history from synthetic transition provenance", () => {
    expect(
      stateProvenanceSchema.parse({
        kind: "replayable-history",
        timelineArtifactChecksum: "timeline-checksum",
        semanticHistoryHash: "history-hash",
        activeEventCount: 12,
        stateVersion: 11,
      }),
    ).toMatchObject({ kind: "replayable-history" });
    expect(
      stateProvenanceSchema.parse({
        kind: "synthetic-transition",
        fixtureId: "fixture",
        stateHash: "state-hash",
        transitionSystemVersion: "transition-v1",
        constructionDigest: "construction-digest",
      }),
    ).toMatchObject({ kind: "synthetic-transition" });
    expect(
      stateProvenanceSchema.safeParse({
        kind: "replayable-history",
        fixtureId: "not-a-history",
      }).success,
    ).toBe(false);
  });

  it("validates paired values, derived delta, and witness preference", () => {
    const valid = {
      actionValueId: "value",
      motifId: "M01",
      stateId: "state",
      pairId: "pair",
      pairedSeedId: "seed",
      commandId: "command",
      confirmation: "tune",
      finding: "positive-witness",
      left: {
        actionKey: "left",
        terminalBhabhiRisk: 0.1,
        terminalRollouts: 10,
        outcomeChecksum: "left-hash",
      },
      right: {
        actionKey: "right",
        terminalBhabhiRisk: 0.4,
        terminalRollouts: 10,
        outcomeChecksum: "right-hash",
      },
      deltaLeftMinusRight: -0.3,
      preferredActionKey: "left",
    } as const;
    expect(pairedActionValueRecordSchema.safeParse(valid).success).toBe(true);
    expect(
      pairedActionValueRecordSchema.safeParse({
        ...valid,
        deltaLeftMinusRight: 0.3,
      }).success,
    ).toBe(false);
    expect(
      pairedActionValueRecordSchema.safeParse({
        ...valid,
        preferredActionKey: "right",
      }).success,
    ).toBe(false);
  });

  it("keeps failure records strict and typed", () => {
    const failure = {
      failureId: "failure",
      motifId: "M01",
      commandId: "command",
      stage: "search",
      code: "EVENT_CAP",
      message: "Search reached its cap.",
      stateId: "state",
      recoverable: true,
    } as const;
    expect(strategyFailureRecordSchema.safeParse(failure).success).toBe(true);
    expect(
      strategyFailureRecordSchema.safeParse({
        ...failure,
        inventedSuccess: true,
      }).success,
    ).toBe(false);
  });
});

describe("strategy evidence verifier", () => {
  it("requires exactly one disposition and direct passing evidence for every required motif", () => {
    const valid = completeVerifierFixture();
    expect(verifyStrategyEvidence(valid)).toEqual({ ok: true, issues: [] });

    const missingDisposition = structuredClone(valid);
    missingDisposition.dispositions.pop();
    expect(
      verifyStrategyEvidence(missingDisposition).issues.map(
        (issue) => issue.code,
      ),
    ).toContain("missing-disposition");

    const duplicateDisposition = structuredClone(valid);
    const first = duplicateDisposition.dispositions[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new Error("No disposition fixture.");
    }
    duplicateDisposition.dispositions.push(first);
    expect(
      verifyStrategyEvidence(duplicateDisposition).issues.map(
        (issue) => issue.code,
      ),
    ).toContain("duplicate-disposition");

    const noDirectM02 = structuredClone(valid);
    noDirectM02.evidence = noDirectM02.evidence.filter(
      (record) => record.motifId !== "M02",
    );
    const m02 = noDirectM02.dispositions.find(
      (record) => record.motifId === "M02",
    );
    expect(m02).toBeDefined();
    if (m02 === undefined) {
      throw new Error("No M02 disposition.");
    }
    m02.evidenceIds = [];
    expect(
      verifyStrategyEvidence(noDirectM02).issues.map((issue) => issue.code),
    ).toContain("required-without-direct-pass");
  });

  it("permits an explicit required Phase 7 deferral in Phase 6 but rejects it at final verification", () => {
    const phase6 = completeVerifierFixture();
    phase6.evidence = phase6.evidence.filter(
      (record) => record.motifId !== "M39",
    );
    replaceDisposition(phase6, {
      motifId: "M39",
      disposition: "deferred-phase7",
      phase7Dependency:
        "Phase 7 exact endgame DP must pass enumeration-threshold agreement.",
      rationale:
        "Phase 6 has the hard-belief threshold prerequisite, not exact endgame agreement.",
      evidenceIds: [],
      actionValueIds: [],
      boundaryRecordIds: [],
      failureIds: [],
    });

    expect(verifyStrategyEvidence(phase6)).toEqual({ ok: true, issues: [] });
    expect(
      verifyFinalStrategyEvidence(phase6).issues.map((issue) => issue.code),
    ).toContain("required-deferred-at-final");

    const implicit = structuredClone(phase6);
    const disposition = implicit.dispositions.find(
      (entry) => entry.motifId === "M39",
    );
    expect(disposition?.disposition).toBe("deferred-phase7");
    if (disposition?.disposition !== "deferred-phase7") {
      throw new Error("Missing deferred M39 fixture.");
    }
    disposition.phase7Dependency = "Implement exact endgame agreement.";
    expect(
      verifyStrategyEvidence(implicit).issues.map((issue) => issue.code),
    ).toContain("implicit-phase7-dependency");

    const unapproved = completeVerifierFixture();
    unapproved.evidence = unapproved.evidence.filter(
      (record) => record.motifId !== "M02",
    );
    replaceDisposition(unapproved, {
      motifId: "M02",
      disposition: "deferred-phase7",
      phase7Dependency:
        "Phase 7 would revisit a correctness fixture already required in Phase 6.",
      rationale: "Deliberately invalid required deferral.",
      evidenceIds: [],
      actionValueIds: [],
      boundaryRecordIds: [],
      failureIds: [],
    });
    expect(
      verifyStrategyEvidence(unapproved).issues.map((issue) => issue.code),
    ).toContain("unapproved-required-deferral");
  });

  it("permits experimental retention only with a confirmed positive witness and boundary", () => {
    const valid = completeVerifierFixture();
    addExperimentalM01(valid);
    expect(verifyStrategyEvidence(valid)).toEqual({ ok: true, issues: [] });

    const noBoundary = structuredClone(valid);
    const m01 = noBoundary.dispositions.find(
      (record) => record.motifId === "M01",
    );
    expect(m01).toBeDefined();
    if (m01 === undefined) {
      throw new Error("No M01 disposition.");
    }
    m01.boundaryRecordIds = [];
    expect(
      verifyStrategyEvidence(noBoundary).issues.map((issue) => issue.code),
    ).toContain("retained-experimental-insufficient");

    const developmentOnly = structuredClone(valid);
    const value = developmentOnly.actionValues[0];
    expect(value).toBeDefined();
    if (value === undefined) {
      throw new Error("No action-value fixture.");
    }
    value.confirmation = "development";
    expect(
      verifyStrategyEvidence(developmentOnly).issues.map((issue) => issue.code),
    ).toContain("retained-experimental-insufficient");
  });

  it("never converts a finite no-witness search into a false/rejected claim", () => {
    const finite = completeVerifierFixture();
    finite.boundaries.push({
      boundaryRecordId: "boundary/M01",
      motifId: "M01",
      commandId: PASS_COMMAND.commandId,
      finding: "finite-no-witness",
      scope: "finite-search",
      description: "No witness occurred in the finite searched region.",
      stateIds: [],
      actionValueIds: [],
    });
    replaceDisposition(finite, {
      motifId: "M01",
      disposition: "rejected",
      rationale:
        "This deliberately invalid fixture overclaims a finite search.",
      evidenceIds: [],
      actionValueIds: [],
      boundaryRecordIds: ["boundary/M01"],
      failureIds: [],
    });
    expect(
      verifyStrategyEvidence(finite).issues.map((issue) => issue.code),
    ).toContain("finite-no-witness-is-not-false");

    const finiteBoundary = finite.boundaries[0];
    expect(finiteBoundary).toBeDefined();
    if (finiteBoundary === undefined) {
      throw new Error("No finite boundary fixture.");
    }
    finite.boundaries[0] = {
      ...finiteBoundary,
      finding: "counterexample",
      description: "A concrete counterexample reverses the proposed motif.",
    };
    expect(verifyStrategyEvidence(finite)).toEqual({ ok: true, issues: [] });
  });

  it("requires separate passing qualification eligibility before production enablement", () => {
    const missing = completeVerifierFixture();
    missing.productionDecisions.push({
      featureId: "feature/hard-trap",
      motifIds: ["M02"],
      decision: "enabled",
      eligibilityRecordId: null,
      rationale: "Deliberately missing eligibility.",
    });
    expect(
      verifyStrategyEvidence(missing).issues.map((issue) => issue.code),
    ).toContain("enabled-without-eligibility");

    const eligible = completeVerifierFixture();
    eligible.eligibility.push({
      eligibilityRecordId: "eligibility/hard-trap",
      featureId: "feature/hard-trap",
      status: "eligible",
      evaluationSplit: "qualification",
      manifestChecksum: "manifest-checksum",
      productionConfigChecksum: "config-checksum",
      commandId: PASS_COMMAND.commandId,
      criteria: {
        correctness: true,
        reproducibility: true,
        liveLatency: true,
        terminalNoninferiority: true,
        robustness: true,
        evidenceSpecificImprovement: true,
      },
    });
    eligible.productionDecisions.push({
      featureId: "feature/hard-trap",
      motifIds: ["M02"],
      decision: "enabled",
      eligibilityRecordId: "eligibility/hard-trap",
      rationale: "A separate eligibility record satisfies every criterion.",
    });
    expect(verifyStrategyEvidence(eligible)).toEqual({ ok: true, issues: [] });
  });

  it("summarizes deterministically independent of record order", () => {
    const left = completeVerifierFixture();
    const right = structuredClone(left);
    right.evidence.reverse();
    right.dispositions.reverse();
    expect(summarizeStrategyEvidence(right)).toEqual(
      summarizeStrategyEvidence(left),
    );
    expect(summarizeStrategyEvidence(left)).toMatchObject({
      registryEntryCount: 48,
      classificationCounts: {
        requiredCorrectness: 28,
        reported: 1,
        hypothesis: 19,
      },
      dispositionCounts: {
        retainedRequired: 28,
        retainedExperimental: 0,
        rejected: 0,
        inconclusive: 0,
        deferredPhase7: 20,
      },
      requiredDirectPassingCount: 28,
    });
  });
});
