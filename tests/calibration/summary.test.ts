import { describe, expect, it } from "vitest";

import {
  aggregateCalibrationPairedDifferences,
  aggregateCalibrationReliabilityLines,
  aggregateCalibrationScoreLines,
} from "../../src/calibration/summary";
import type {
  CalibrationArm,
  CalibrationQueryFamily,
} from "../../src/calibration/artifact-schema";
import type {
  CalibrationCoordinates,
  EvalOnlyScoredObservation,
  ProbabilityEntry,
} from "../../src/calibration/types";
import {
  calibrationClusterId,
  terminalClusterId,
} from "../../src/calibration/types";

function coordinates(
  familyId: CalibrationQueryFamily,
  queryId: string,
): CalibrationCoordinates {
  return {
    queryId,
    familyId,
    stateId: "state-1",
    trajectoryId: "trajectory-1",
    calibrationClusterId: calibrationClusterId("dev", "summary-test", 0),
    terminalClusterId: terminalClusterId("dev", 0),
  };
}

function categorical(input: {
  readonly id: string;
  readonly arm: CalibrationArm;
  readonly family: CalibrationQueryFamily;
  readonly brier: number;
  readonly hardKnown?: boolean;
  readonly covers?: boolean;
  readonly distribution?: readonly ProbabilityEntry[];
}): EvalOnlyScoredObservation {
  const distribution = input.distribution ?? [
    { label: "false", probability: 0.5 },
    { label: "true", probability: 0.5 },
  ];
  const covers = input.covers ?? true;
  return {
    schemaVersion: 1,
    observationId: input.id,
    predictionId: `prediction/${input.id}`,
    arm: input.arm,
    coordinates: coordinates(input.family, input.id),
    hardKnown: input.hardKnown ?? false,
    kind: "categorical",
    truthLabel: distribution[0]?.label ?? "truth",
    distribution,
    credibleSets: ([0.5, 0.8, 0.95] as const).map((level) => ({
      level,
      labels: covers ? [distribution[0]?.label ?? "truth"] : ["other"],
      probabilityMass: level,
      coversTruth: covers,
    })),
    brier: input.brier,
    logLoss: input.brier,
    rawZeroSupport: false,
  };
}

describe("protocol-weighted calibration summary", () => {
  it("reports predictive-set coverage for binary query families", () => {
    const binary: EvalOnlyScoredObservation = {
      schemaVersion: 1,
      observationId: "binary-coverage",
      predictionId: "prediction-binary-coverage",
      arm: "hard-only",
      coordinates: coordinates("current-void", "binary-coverage"),
      hardKnown: false,
      kind: "binary",
      truth: true,
      probability: 0.8,
      brier: 0.04,
      logLoss: -Math.log(0.8),
      rawZeroSupport: false,
    };
    const line = aggregateCalibrationScoreLines([binary]).find(
      (candidate) =>
        candidate.family === "current-void" &&
        candidate.knowledgeStratum === "unresolved-soft",
    );
    expect(line).toMatchObject({
      coverage50: 1,
      coverage80: 1,
      coverage95: 1,
    });
  });

  it("uses an equal-family unresolved-soft macro and ignores duplicated hard-known rows", () => {
    const soft: EvalOnlyScoredObservation[] = [
      ...Array.from({ length: 100 }, (_, index) =>
        categorical({
          id: `owner-${index.toString()}`,
          arm: "hard-only",
          family: "card-owner",
          brier: 0,
          covers: true,
        }),
      ),
      categorical({
        id: "void-only",
        arm: "hard-only",
        family: "current-void",
        brier: 1,
        covers: false,
      }),
    ];
    const hardKnown = Array.from({ length: 200 }, (_, index) =>
      categorical({
        id: `hard-known-${index.toString()}`,
        arm: "hard-only",
        family: "card-owner",
        brier: 0,
        hardKnown: true,
      }),
    );
    const base = aggregateCalibrationScoreLines(soft).find(
      (line) => line.arm === "hard-only" && line.family === "overall-soft",
    );
    const duplicated = aggregateCalibrationScoreLines([
      ...soft,
      ...hardKnown,
    ]).find(
      (line) => line.arm === "hard-only" && line.family === "overall-soft",
    );
    expect(base).toMatchObject({
      knowledgeStratum: "unresolved-soft",
      meanBrier: 0.5,
      coverage50: 0.5,
      coverage80: 0.5,
      coverage95: 0.5,
    });
    expect(duplicated).toEqual(base);
  });

  it("produces the equal-family paired macro used by sample-size planning", () => {
    const hard = [
      categorical({
        id: "owner",
        arm: "hard-only",
        family: "card-owner",
        brier: 0,
      }),
      categorical({
        id: "void",
        arm: "hard-only",
        family: "current-void",
        brier: 0,
      }),
    ];
    const behavioral = [
      categorical({
        id: "owner",
        arm: "behavioral",
        family: "card-owner",
        brier: 0,
      }),
      categorical({
        id: "void",
        arm: "behavioral",
        family: "current-void",
        brier: 1,
      }),
    ];
    const overall = aggregateCalibrationPairedDifferences(
      [...hard, ...behavioral],
      32,
      "summary-bootstrap",
    ).find((line) => line.family === "overall-soft" && line.metric === "brier");
    expect(overall).toMatchObject({
      estimate: 0.5,
      lower95: 0.5,
      upper95: 0.5,
      clusters: 1,
    });
  });

  it("retains seat/decision strata and tie-aware action metrics", () => {
    const observation: EvalOnlyScoredObservation = {
      schemaVersion: 1,
      observationId: "action-tie",
      predictionId: "prediction-action-tie",
      arm: "hard-only",
      coordinates: coordinates("opponent-action", "p2-action"),
      hardKnown: false,
      kind: "action",
      seat: "p2",
      decisionClass: "discretionary",
      observedLabel: "play:B",
      distribution: [
        { label: "play:A", probability: 0.5 },
        { label: "play:B", probability: 0.5 },
      ],
      top1: {
        selectedLabel: "play:A",
        tiedLabels: ["play:A", "play:B"],
        selectedCorrect: false,
        tieAwareCorrect: true,
        tieAwareCredit: 0.5,
      },
      brier: 0.25,
      logLoss: Math.log(2),
      rawZeroSupport: false,
    };
    const line = aggregateCalibrationScoreLines([observation]).find(
      (candidate) =>
        candidate.family === "opponent-action" &&
        candidate.opponentSeat === "p2" &&
        candidate.actionDecisionClass === "discretionary",
    );
    expect(line).toMatchObject({
      top1Accuracy: 0,
      tieAwareTopSetAccuracy: 1,
      tieAwareTop1Credit: 0.5,
      coverage50: null,
      coverage80: null,
      coverage95: null,
    });
  });

  it("weights reliability by query hierarchy rather than label-support size", () => {
    const largeSupport = Array.from({ length: 10 }, (_, index) => ({
      label: `label-${index.toString()}`,
      probability: 0.1,
    }));
    const line = aggregateCalibrationReliabilityLines([
      categorical({
        id: "large-support",
        arm: "hard-only",
        family: "card-owner",
        brier: 0,
        distribution: largeSupport,
      }),
      categorical({
        id: "singleton-support",
        arm: "hard-only",
        family: "card-owner",
        brier: 0,
        distribution: [{ label: "only", probability: 1 }],
      }),
    ])[0];
    expect(line?.bins[1]?.count).toBe(10);
    expect(line?.bins[1]?.weight).toBeCloseTo(0.5, 12);
    expect(line?.bins[9]?.count).toBe(1);
    expect(line?.bins[9]?.weight).toBeCloseTo(0.5, 12);
    expect(line?.bins.reduce((sum, bin) => sum + bin.weight, 0)).toBeCloseTo(
      1,
      12,
    );
  });
});
