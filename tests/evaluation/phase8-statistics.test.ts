import { describe, expect, it } from "vitest";

import {
  computePhase8TerminalSampleSize,
  crossedPairedClusterBootstrap,
  evaluatePhase8StyleCatastrophe,
  evaluatePhase8TerminalGate,
  validatePhase8CompleteMatrix,
  type Phase8ClusterMetricObservation,
  type Phase8MatrixOutcome,
} from "../../src/evaluation/phase8-statistics";
import type { Phase8SplitPlan } from "../../src/evaluation/phase8-manifest";
import { STYLE_CELLS } from "../../src/evaluation/protocol";

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected fixture value to be defined.");
  }
  return value;
}

function smallPlan(): Phase8SplitPlan {
  return {
    split: "train",
    baseIndexStart: 10,
    baseCount: 2,
    rotations: [0, 1, 2],
    replicates: [0],
    styleCellIds: STYLE_CELLS.map((cell) => cell.id),
    eventCap: 4_096,
  };
}

function completeOutcomes(): Phase8MatrixOutcome[] {
  const plan = smallPlan();
  const outcomes: Phase8MatrixOutcome[] = [];
  for (const configId of ["reference", "candidate"]) {
    for (const styleCellId of plan.styleCellIds) {
      for (
        let baseIndex = plan.baseIndexStart;
        baseIndex < plan.baseIndexStart + plan.baseCount;
        baseIndex += 1
      ) {
        for (const rotation of plan.rotations) {
          outcomes.push({
            split: plan.split,
            configId,
            styleCellId,
            baseIndex,
            rotation,
            replicate: 0,
            status: "complete",
          });
        }
      }
    }
  }
  return outcomes;
}

function bootstrapObservations(): Phase8ClusterMetricObservation[] {
  const observations: Phase8ClusterMetricObservation[] = [];
  for (let cluster = 0; cluster < 8; cluster += 1) {
    for (const pairingKey of ["cell-a", "cell-b"]) {
      const pairOffset = pairingKey === "cell-a" ? 0.004 : -0.004;
      const referenceRisk = 0.2 + cluster * 0.003 + pairOffset;
      const candidateADifference = -0.02 + (cluster % 2 === 0 ? -0.006 : 0.006);
      const candidateBDifference = 0.003 + (cluster % 3 === 0 ? 0.012 : -0.004);
      observations.push(
        {
          clusterId: `cluster-${cluster.toString()}`,
          pairingKey,
          configId: "reference",
          metrics: {
            risk: referenceRisk,
            calibration: 0.1 + cluster * 0.002,
          },
        },
        {
          clusterId: `cluster-${cluster.toString()}`,
          pairingKey,
          configId: "candidate-a",
          metrics: {
            risk: referenceRisk + candidateADifference,
            calibration: 0.1 + cluster * 0.002 - (cluster % 3) * 0.001,
          },
        },
        {
          clusterId: `cluster-${cluster.toString()}`,
          pairingKey,
          configId: "candidate-b",
          metrics: {
            risk: referenceRisk + candidateBDifference,
            calibration: 0.1 + cluster * 0.002 + (cluster % 2) * 0.004,
          },
        },
      );
    }
  }
  return observations;
}

describe("Phase 8 terminal sample size and complete matrix", () => {
  it("applies the frozen formula, block rounding, and 64..512 clamp", () => {
    expect(computePhase8TerminalSampleSize(0)).toMatchObject({
      rawBaseCount: 0,
      blockRoundedBaseCount: 0,
      baseCount: 64,
      minimumApplied: true,
      maximumApplied: false,
    });
    expect(computePhase8TerminalSampleSize(0.05)).toMatchObject({
      baseCount: 112,
      minimumApplied: false,
      maximumApplied: false,
    });
    expect(computePhase8TerminalSampleSize(1)).toMatchObject({
      baseCount: 512,
      maximumApplied: true,
    });
    expect(() => computePhase8TerminalSampleSize(Number.NaN)).toThrow();
    expect(() => computePhase8TerminalSampleSize(-0.1)).toThrow();
  });

  it("detects missing, duplicate, failed, capped, cancelled, and unexpected outcomes", () => {
    const complete = completeOutcomes();
    const passing = validatePhase8CompleteMatrix({
      plan: smallPlan(),
      configurationIds: ["reference", "candidate"],
      outcomes: complete,
    });
    expect(passing).toMatchObject({
      expectedOutcomes: 204,
      observedOutcomes: 204,
      completeMatrixGate: true,
      zeroFailureGate: true,
      zeroCapGate: true,
      zeroCancellationGate: true,
      evidenceGate: true,
    });

    const removed = complete.slice(1);
    const witness = defined(complete[1]);
    const failing = validatePhase8CompleteMatrix({
      plan: smallPlan(),
      configurationIds: ["reference", "candidate"],
      outcomes: [
        ...removed,
        { ...witness, status: "failed" },
        { ...witness, status: "turn-cap" },
        { ...witness, baseIndex: 999, status: "cancelled" },
        { ...witness, configId: "unknown", status: "analysis-cap" },
      ],
      diagnosticLimit: 1,
    });
    expect(failing).toMatchObject({
      missingCount: 1,
      unexpectedCount: 2,
      duplicateCount: 2,
      failedCount: 1,
      turnCapCount: 1,
      analysisCapCount: 1,
      cancellationCount: 1,
      diagnosticsTruncated: true,
      completeMatrixGate: false,
      zeroFailureGate: false,
      zeroCapGate: false,
      zeroCancellationGate: false,
      evidenceGate: false,
    });
  });
});

describe("crossed paired cluster bootstrap", () => {
  it("is deterministic, order-independent, paired, and simultaneous", () => {
    const observations = bootstrapObservations();
    const family = crossedPairedClusterBootstrap({
      observations,
      referenceConfigId: "reference",
      candidateConfigIds: ["candidate-b", "candidate-a"],
      metricIds: ["risk", "calibration"],
      seed: "phase8-bootstrap-test",
      resamples: 1_000,
    });
    const rerun = crossedPairedClusterBootstrap({
      observations: [...observations].reverse(),
      referenceConfigId: "reference",
      candidateConfigIds: ["candidate-a", "candidate-b"],
      metricIds: ["calibration", "risk"],
      seed: "phase8-bootstrap-test",
      resamples: 1_000,
    });
    expect(rerun).toEqual(family);
    expect(family).toMatchObject({
      clusterCount: 8,
      pairingKeysPerCluster: 2,
      familySize: 4,
      resamples: 1_000,
    });
    expect(family.resultSha256).toHaveLength(64);

    const singleton = crossedPairedClusterBootstrap({
      observations: observations.filter((value) =>
        ["reference", "candidate-a"].includes(value.configId),
      ),
      referenceConfigId: "reference",
      candidateConfigIds: ["candidate-a"],
      metricIds: ["risk"],
      seed: "phase8-bootstrap-test",
      resamples: 1_000,
    });
    expect(family.twoSidedCriticalValue).toBeGreaterThanOrEqual(
      singleton.twoSidedCriticalValue,
    );
    const familyRisk = family.contrasts.find(
      (contrast) => contrast.contrastId === "candidate-a::risk",
    );
    const singletonRisk = defined(singleton.contrasts[0]);
    expect(
      defined(familyRisk).twoSidedUpper - defined(familyRisk).estimate,
    ).toBeGreaterThanOrEqual(
      singletonRisk.twoSidedUpper - singletonRisk.estimate,
    );
  });

  it("rejects incomplete crossing and duplicate pairs", () => {
    const observations = bootstrapObservations().filter(
      (value) =>
        !(
          value.clusterId === "cluster-0" &&
          value.pairingKey === "cell-a" &&
          value.configId === "candidate-a"
        ),
    );
    expect(() =>
      crossedPairedClusterBootstrap({
        observations: observations.filter((value) =>
          ["reference", "candidate-a"].includes(value.configId),
        ),
        referenceConfigId: "reference",
        candidateConfigIds: ["candidate-a"],
        metricIds: ["risk"],
        seed: "incomplete",
        resamples: 100,
      }),
    ).toThrow(/not completely crossed/u);

    const complete = bootstrapObservations().filter((value) =>
      ["reference", "candidate-a"].includes(value.configId),
    );
    expect(() =>
      crossedPairedClusterBootstrap({
        observations: [...complete, defined(complete[0])],
        referenceConfigId: "reference",
        candidateConfigIds: ["candidate-a"],
        metricIds: ["risk"],
        seed: "duplicate",
        resamples: 100,
      }),
    ).toThrow(/Duplicate paired observation/u);
  });

  it("executes the preregistered 20,000-resample default", () => {
    const observations: Phase8ClusterMetricObservation[] = [];
    for (let cluster = 0; cluster < 4; cluster += 1) {
      observations.push(
        {
          clusterId: `compact-${cluster.toString()}`,
          pairingKey: "cell",
          configId: "reference",
          metrics: { risk: 0.2 + cluster * 0.01 },
        },
        {
          clusterId: `compact-${cluster.toString()}`,
          pairingKey: "cell",
          configId: "candidate",
          metrics: {
            risk: 0.19 + cluster * 0.01 + (cluster % 2 === 0 ? -0.002 : 0.002),
          },
        },
      );
    }
    const result = crossedPairedClusterBootstrap({
      observations,
      referenceConfigId: "reference",
      candidateConfigIds: ["candidate"],
      metricIds: ["risk"],
      seed: "phase8-20k-answer-vector",
    });
    expect(result.resamples).toBe(20_000);
    expect(result.contrasts).toHaveLength(1);
    expect(result.resultSha256).toHaveLength(64);
  });
});

describe("Phase 8 strict decision thresholds", () => {
  it("keeps NI, improvement, and practical-tie boundaries strict", () => {
    expect(
      evaluatePhase8TerminalGate({
        estimate: 0,
        oneSidedUpper: 0.005,
        twoSidedLower: -0.004,
        twoSidedUpper: 0.004,
      }),
    ).toMatchObject({
      noninferiorityGate: false,
      improvementGate: false,
      finalBeatsGate: false,
      practicalTieGate: true,
    });
    expect(
      evaluatePhase8TerminalGate({
        estimate: -0.0025,
        oneSidedUpper: -Number.EPSILON,
        twoSidedLower: -0.005,
        twoSidedUpper: 0.004,
      }),
    ).toMatchObject({
      noninferiorityGate: true,
      improvementGate: true,
      finalBeatsGate: false,
      practicalTieGate: true,
    });
    expect(
      evaluatePhase8TerminalGate({
        estimate: -0.002_501,
        oneSidedUpper: -Number.EPSILON,
        twoSidedLower: -0.005,
        twoSidedUpper: -Number.EPSILON,
      }),
    ).toMatchObject({
      finalBeatsGate: true,
      practicalTieGate: false,
    });
  });

  it("requires both style-catastrophe conditions", () => {
    expect(
      evaluatePhase8StyleCatastrophe({
        estimate: 0.05,
        oneSidedLower: 0.020_001,
      }),
    ).toMatchObject({ catastrophic: true, styleSafetyGate: false });
    expect(
      evaluatePhase8StyleCatastrophe({
        estimate: 0.05,
        oneSidedLower: 0.02,
      }),
    ).toMatchObject({ catastrophic: false, styleSafetyGate: true });
    expect(
      evaluatePhase8StyleCatastrophe({
        estimate: 0.049_999,
        oneSidedLower: 0.03,
      }),
    ).toMatchObject({ catastrophic: false, styleSafetyGate: true });
  });
});
