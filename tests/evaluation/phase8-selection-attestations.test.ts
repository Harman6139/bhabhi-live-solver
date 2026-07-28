import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createPhase8FinalAttestation,
  createPhase8SelectionAttestation,
  freezePhase8FinalManifestFromSelection,
  rehydratePhase8FinalArtifact,
  verifyPhase8FinalArtifact,
  verifyPhase8SelectionArtifact,
} from "../../src/evaluation/phase8-attestations";
import {
  createPhase8FinalManifestAuthorityArtifact,
  deriveOpenedPhase8FinalSeed,
  openPhase8FinalSplit,
  parseAndRehydratePhase8FinalSplitOpening,
  rehydratePhase8FinalManifestAuthorityArtifact,
  rehydratePhase8SelectionArtifact,
  serializePhase8FinalSplitOpening,
} from "../../src/evaluation/phase8-final-manifest";
import {
  createPhase8ConfigurationDescriptor,
  freezePhase8Manifest,
} from "../../src/evaluation/phase8-manifest";
import {
  selectPhase8ProductionConfiguration,
  type Phase8ConfigurationEvidence,
} from "../../src/evaluation/phase8-selection";
import { evaluatePhase8TerminalGate } from "../../src/evaluation/phase8-statistics";
import { STYLE_CELLS } from "../../src/evaluation/protocol";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);
const REFERENCE_ID = "p8-r-hard-balanced-v1" as const;
const EXACT_ID = "p8-e-exact-hard-fallback-v1" as const;
const BEHAVIOR_ID = "p8-b-behavior-balanced-v1" as const;

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected fixture value to be defined.");
  }
  return value;
}

function protocolSeed(preimage: string): string {
  return createHash("sha256")
    .update(preimage, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function authority() {
  const reference = createPhase8ConfigurationDescriptor({
    configId: REFERENCE_ID,
    label: "Frozen reference",
    role: "reference",
    budgetId: "balanced",
    components: {
      exactEndgame: false,
      behaviorWeighting: false,
    },
    implementation: { path: "phase5-hard-only" },
  });
  const exact = createPhase8ConfigurationDescriptor({
    configId: EXACT_ID,
    label: "Exact screen",
    role: "candidate",
    budgetId: "balanced",
    components: {
      exactEndgame: true,
      behaviorWeighting: false,
    },
    implementation: { path: "exact-then-hard" },
  });
  const behavior = createPhase8ConfigurationDescriptor({
    configId: BEHAVIOR_ID,
    label: "Behavior weighted",
    role: "candidate",
    budgetId: "balanced",
    components: {
      exactEndgame: false,
      behaviorWeighting: true,
    },
    implementation: { path: "behavior-weighted" },
  });
  return freezePhase8Manifest({
    manifestId: "phase8-selection-test",
    createdAt: "2026-07-28T12:00:00.000Z",
    sourceSha256: SHA_A,
    sourceFileCount: 42,
    modelSha256: SHA_B,
    scorerSha256: SHA_C,
    reportSha256: SHA_D,
    preregistrationSha256: SHA_E,
    configurations: [behavior, exact, reference],
    splits: {
      train: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      tune: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      qualification: {
        baseIndexStart: 0,
        eventCap: 4_096,
      },
    },
    qualificationSampleSize: {
      verifiedDevelopmentVarianceArtifactSha256: SHA_F,
      maxPairedClusterStandardDeviation: 0,
    },
  });
}

const PASS_COMMON = {
  correctnessGate: true,
  conservationGate: true,
  replayGate: true,
  truthFirewallGate: true,
  fixedSeedReproducibilityGate: true,
  completeMatrixGate: true,
  zeroFailureGate: true,
  zeroCapGate: true,
  zeroCancellationGate: true,
  terminalNoninferiorityGate: true,
  styleSafetyGate: true,
  robustnessGate: true,
  latencyBudgetGate: true,
  stalePublicationGate: true,
  memoryBudgetGate: true,
} as const;

function terminalGate(input: {
  estimate: number;
  upper: number;
  lower2: number;
  upper2: number;
}) {
  return evaluatePhase8TerminalGate({
    estimate: input.estimate,
    oneSidedUpper: input.upper,
    twoSidedLower: input.lower2,
    twoSidedUpper: input.upper2,
  });
}

function referenceEvidence(
  calibrationRobustnessRank = 0,
): Phase8ConfigurationEvidence {
  return {
    configId: REFERENCE_ID,
    terminalBhabhiRate: 0.2,
    terminalGate: null,
    latencyP95Ms: 100,
    calibrationRobustnessRank,
    commonGates: PASS_COMMON,
    componentGates: {
      exactIncrementalImprovementGate: null,
      behaviorCalibrationGate: null,
      behaviorZeroSupportGate: null,
      behaviorHardKnownPreservationGate: null,
      behaviorSeparatePosteriorRobustnessGate: null,
    },
  };
}

function exactEvidence(): Phase8ConfigurationEvidence {
  return {
    configId: EXACT_ID,
    terminalBhabhiRate: 0.19,
    terminalGate: terminalGate({
      estimate: -0.01,
      upper: -0.001,
      lower2: -0.02,
      upper2: -0.001,
    }),
    latencyP95Ms: 250,
    calibrationRobustnessRank: 1,
    commonGates: PASS_COMMON,
    componentGates: {
      exactIncrementalImprovementGate: false,
      behaviorCalibrationGate: null,
      behaviorZeroSupportGate: null,
      behaviorHardKnownPreservationGate: null,
      behaviorSeparatePosteriorRobustnessGate: null,
    },
  };
}

function behaviorEvidence(
  overrides: Partial<Phase8ConfigurationEvidence> = {},
): Phase8ConfigurationEvidence {
  return {
    configId: BEHAVIOR_ID,
    terminalBhabhiRate: 0.199,
    terminalGate: terminalGate({
      estimate: -0.001,
      upper: 0.004,
      lower2: -0.004,
      upper2: 0.004,
    }),
    latencyP95Ms: 180,
    calibrationRobustnessRank: 1,
    commonGates: PASS_COMMON,
    componentGates: {
      exactIncrementalImprovementGate: null,
      behaviorCalibrationGate: true,
      behaviorZeroSupportGate: true,
      behaviorHardKnownPreservationGate: true,
      behaviorSeparatePosteriorRobustnessGate: true,
    },
    ...overrides,
  };
}

function referenceSelection() {
  const frozen = authority();
  const decision = selectPhase8ProductionConfiguration(frozen, [
    referenceEvidence(0),
    exactEvidence(),
    behaviorEvidence({ calibrationRobustnessRank: 2 }),
  ]);
  return { frozen, decision };
}

describe("Phase 8 eligibility and point-estimate-first selection", () => {
  it("falls back to reference across an ADR practical tie", () => {
    const { decision } = referenceSelection();
    expect(decision).toMatchObject({
      selectedConfigId: REFERENCE_ID,
      selectionIsReference: true,
      selectionMode: "reference-fallback",
      orderedFallbackConfigIds: [],
      finalRule: {
        mode: "one-arm-reference-confirmation",
        configurationIds: [REFERENCE_ID],
      },
    });
    expect(
      decision.eligibility.find((value) => value.configId === EXACT_ID),
    ).toMatchObject({
      eligible: false,
      failedGates: ["exactIncrementalImprovementGate"],
    });
  });

  it("allows calibrated behavior+NI to win on the lowest point without terminal significance", () => {
    const frozen = authority();
    const behavior = behaviorEvidence({
      terminalBhabhiRate: 0.18,
      terminalGate: terminalGate({
        estimate: -0.02,
        upper: 0.004,
        lower2: -0.04,
        upper2: 0.005,
      }),
    });
    const decision = selectPhase8ProductionConfiguration(frozen, [
      referenceEvidence(),
      exactEvidence(),
      behavior,
    ]);
    expect(decision).toMatchObject({
      selectedConfigId: BEHAVIOR_ID,
      selectionMode: "lowest-terminal-estimate",
      orderedFallbackConfigIds: [REFERENCE_ID],
      finalRule: {
        mode: "paired-selected-vs-reference",
        configurationIds: [REFERENCE_ID, BEHAVIOR_ID],
      },
    });
    expect(behavior.terminalGate?.improvementGate).toBe(false);
  });

  it("uses calibration/robustness before latency and simplicity inside a practical tie", () => {
    const decision = selectPhase8ProductionConfiguration(authority(), [
      referenceEvidence(2),
      exactEvidence(),
      behaviorEvidence({
        calibrationRobustnessRank: 0,
        latencyP95Ms: 500,
      }),
    ]);
    expect(decision).toMatchObject({
      selectedConfigId: BEHAVIOR_ID,
      selectionMode: "practical-tie",
      orderedFallbackConfigIds: [REFERENCE_ID],
    });
  });

  it("disqualifies behavior on any support or preservation failure", () => {
    const unsupported = behaviorEvidence({
      componentGates: {
        exactIncrementalImprovementGate: null,
        behaviorCalibrationGate: true,
        behaviorZeroSupportGate: false,
        behaviorHardKnownPreservationGate: false,
        behaviorSeparatePosteriorRobustnessGate: true,
      },
    });
    const rejected = selectPhase8ProductionConfiguration(authority(), [
      referenceEvidence(),
      exactEvidence(),
      unsupported,
    ]);
    expect(
      rejected.eligibility.find((value) => value.configId === BEHAVIOR_ID),
    ).toMatchObject({
      eligible: false,
      failedGates: [
        "behaviorHardKnownPreservationGate",
        "behaviorZeroSupportGate",
      ],
    });
  });
});

describe("Phase 8 write-once selection and distinct final authority", () => {
  it("binds reference selection, qualification variance, final seeds, and final attestation", () => {
    const { frozen, decision } = referenceSelection();
    const selectionArtifact = createPhase8SelectionAttestation({
      existingTarget: null,
      authority: frozen,
      decision,
      createdAt: "2026-07-28T13:00:00.000Z",
      qualificationArtifactSha256: SHA_A,
      qualificationSummarySha256: SHA_B,
      qualificationIntegrityGate: true,
      eligibilityGate: true,
      splitFirewallGate: true,
    });
    const selection = verifyPhase8SelectionArtifact(selectionArtifact);
    expect(selection).toMatchObject({
      selectionIsReference: true,
      finalMode: "one-arm-reference-confirmation",
      finalConfigIds: [REFERENCE_ID],
      orderedFallbackConfigIds: [],
    });
    expect(
      createHash("sha256")
        .update(selectionArtifact.payload, "utf8")
        .digest("hex"),
    ).toBe(selectionArtifact.payloadSha256);
    const rehydratedSelectionArtifact = rehydratePhase8SelectionArtifact({
      payload: selectionArtifact.payload,
      checksumLine: selectionArtifact.checksumLine,
    });
    expect(rehydratedSelectionArtifact).toEqual(selectionArtifact);

    const finalAuthority = freezePhase8FinalManifestFromSelection({
      qualificationAuthority: frozen,
      selectionArtifact: rehydratedSelectionArtifact,
      manifestId: "phase8-final-reference-test",
      createdAt: "2026-07-28T13:30:00.000Z",
      qualificationVarianceArtifactSha256: SHA_F,
      maxPairedClusterStandardDeviation: 0.05,
      eventCap: 4_096,
    });
    expect(finalAuthority.manifest).toMatchObject({
      qualificationManifestSha256: frozen.manifestSha256,
      configurations: [{ configId: REFERENCE_ID }],
      split: { split: "final", baseCount: 112 },
      sampleSize: { baseCount: 112 },
    });
    const finalAuthorityArtifact = createPhase8FinalManifestAuthorityArtifact({
      existingTarget: null,
      authority: finalAuthority,
    });
    const rehydratedFinalAuthority =
      rehydratePhase8FinalManifestAuthorityArtifact({
        artifact: finalAuthorityArtifact,
        qualificationAuthority: frozen,
        selectionArtifact: rehydratedSelectionArtifact,
      });
    expect(rehydratedFinalAuthority.manifest).toEqual(finalAuthority.manifest);
    const opening = openPhase8FinalSplit(rehydratedFinalAuthority);
    const openingPayload = serializePhase8FinalSplitOpening(
      rehydratedFinalAuthority,
      opening,
    );
    const rehydratedOpening = parseAndRehydratePhase8FinalSplitOpening(
      rehydratedFinalAuthority,
      openingPayload,
    );
    expect(
      deriveOpenedPhase8FinalSeed(rehydratedFinalAuthority, rehydratedOpening, {
        stream: "search",
        styleCellId: defined(STYLE_CELLS[0]).id,
        baseIndex: 0,
        rotation: 0,
        replicate: 0,
      }),
    ).toBe(protocolSeed("bhabhi/eval-v1|final|search|0|0|0"));
    expect(() =>
      parseAndRehydratePhase8FinalSplitOpening(
        rehydratedFinalAuthority,
        `${openingPayload} `,
      ),
    ).toThrow(/noncanonical/u);

    const finalArtifact = createPhase8FinalAttestation({
      existingTarget: null,
      authority: rehydratedFinalAuthority,
      selectionArtifact: rehydratedSelectionArtifact,
      createdAt: "2026-07-28T14:00:00.000Z",
      finalArtifactSha256: SHA_C,
      finalSummarySha256: SHA_D,
      gates: {
        finalIntegrityGate: true,
        completeMatrixGate: true,
        zeroFailureGate: true,
        zeroCapGate: true,
        zeroCancellationGate: true,
        seedReplayGate: true,
        selectedConfirmationGate: true,
      },
    });
    const rehydratedFinalArtifact = rehydratePhase8FinalArtifact({
      payload: finalArtifact.payload,
      checksumLine: finalArtifact.checksumLine,
    });
    expect(verifyPhase8FinalArtifact(rehydratedFinalArtifact)).toMatchObject({
      manifestSha256: rehydratedFinalAuthority.manifestSha256,
      qualificationManifestSha256: frozen.manifestSha256,
      selectionIsReference: true,
      finalMode: "one-arm-reference-confirmation",
      finalConfigIds: [REFERENCE_ID],
    });
  });

  it("does not mint final authority from a tampered selection envelope", () => {
    const { frozen, decision } = referenceSelection();
    const selectionArtifact = createPhase8SelectionAttestation({
      existingTarget: null,
      authority: frozen,
      decision,
      createdAt: "2026-07-28T13:00:00.000Z",
      qualificationArtifactSha256: SHA_A,
      qualificationSummarySha256: SHA_B,
      qualificationIntegrityGate: true,
      eligibilityGate: true,
      splitFirewallGate: true,
    });
    expect(() =>
      freezePhase8FinalManifestFromSelection({
        qualificationAuthority: frozen,
        selectionArtifact: {
          ...selectionArtifact,
          payloadSha256: SHA_F,
        },
        manifestId: "must-not-exist",
        createdAt: "2026-07-28T13:30:00.000Z",
        qualificationVarianceArtifactSha256: SHA_F,
        maxPairedClusterStandardDeviation: 0,
        eventCap: 4_096,
      }),
    ).toThrow(/checksum envelope/u);
  });

  it("rejects overwrite, checksum tampering, and failed final gates", () => {
    const { frozen, decision } = referenceSelection();
    const selectionArtifact = createPhase8SelectionAttestation({
      existingTarget: null,
      authority: frozen,
      decision,
      createdAt: "2026-07-28T13:00:00.000Z",
      qualificationArtifactSha256: SHA_A,
      qualificationSummarySha256: SHA_B,
      qualificationIntegrityGate: true,
      eligibilityGate: true,
      splitFirewallGate: true,
    });
    expect(() =>
      createPhase8SelectionAttestation({
        existingTarget: selectionArtifact.payload,
        authority: frozen,
        decision,
        createdAt: "2026-07-28T13:00:00.000Z",
        qualificationArtifactSha256: SHA_A,
        qualificationSummarySha256: SHA_B,
        qualificationIntegrityGate: true,
        eligibilityGate: true,
        splitFirewallGate: true,
      }),
    ).toThrow(/overwrite/u);
    expect(() =>
      verifyPhase8SelectionArtifact({
        ...selectionArtifact,
        payloadSha256: SHA_F,
      }),
    ).toThrow(/checksum/u);

    const finalAuthority = freezePhase8FinalManifestFromSelection({
      qualificationAuthority: frozen,
      selectionArtifact,
      manifestId: "phase8-final-failure-test",
      createdAt: "2026-07-28T13:30:00.000Z",
      qualificationVarianceArtifactSha256: SHA_F,
      maxPairedClusterStandardDeviation: 0,
      eventCap: 4_096,
    });
    expect(() =>
      createPhase8FinalAttestation({
        existingTarget: null,
        authority: finalAuthority,
        selectionArtifact,
        createdAt: "2026-07-28T14:00:00.000Z",
        finalArtifactSha256: SHA_C,
        finalSummarySha256: SHA_D,
        gates: {
          finalIntegrityGate: true,
          completeMatrixGate: true,
          zeroFailureGate: false,
          zeroCapGate: true,
          zeroCancellationGate: true,
          seedReplayGate: true,
          selectedConfirmationGate: true,
        },
      }),
    ).toThrow(/every final gate/u);
  });
});
