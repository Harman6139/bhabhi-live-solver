import { describe, expect, it } from "vitest";

import {
  aggregateActionScores,
  aggregateNested,
  pairedClusterDifferences,
  pairedNestedBootstrap,
  type MetricObservation,
} from "../../src/calibration/aggregation";
import { scoreActionPrediction } from "../../src/calibration/metrics";
import {
  calibrationClusterId,
  terminalClusterId,
  type ActionPrediction,
  type CalibrationCoordinates,
} from "../../src/calibration/types";

function coordinates(
  clusterBase: number,
  trajectoryId: string,
  stateId: string,
  familyId: string,
  queryId: string,
): CalibrationCoordinates {
  return {
    queryId,
    familyId,
    stateId,
    trajectoryId,
    calibrationClusterId: calibrationClusterId("dev", "c01", clusterBase),
    terminalClusterId: terminalClusterId("dev", clusterBase),
  };
}

function observation(
  observationId: string,
  value: number,
  coordinateValue: CalibrationCoordinates,
): MetricObservation {
  return {
    observationId,
    coordinates: coordinateValue,
    value,
  };
}

describe("nested calibration aggregation", () => {
  const observations = [
    observation("o1", 0, coordinates(1, "g1", "s1", "fA", "q1")),
    observation("o2", 0, coordinates(1, "g1", "s1", "fA", "q1")),
    observation("o3", 1, coordinates(1, "g1", "s1", "fA", "q2")),
    observation("o4", 1, coordinates(1, "g1", "s1", "fB", "q3")),
    observation("o5", 0, coordinates(1, "g1", "s2", "fA", "q4")),
    observation("o6", 1, coordinates(1, "g2", "s3", "fA", "q5")),
    observation("o7", 0, coordinates(2, "g3", "s4", "fA", "q6")),
  ] as const;

  it("weights queries, families, states, trajectories, and clusters in order", () => {
    const aggregation = aggregateNested(observations);

    expect(aggregation.observationCount).toBe(7);
    expect(aggregation.queryMeans).toHaveLength(6);
    expect(aggregation.familyMeans).toHaveLength(5);
    expect(aggregation.stateMeans).toHaveLength(4);
    expect(aggregation.trajectoryMeans).toHaveLength(3);
    expect(aggregation.clusterMeans).toHaveLength(2);

    const firstState = aggregation.stateMeans.find(
      (state) => state.trajectoryId === "g1" && state.stateId === "s1",
    );
    expect(firstState?.value).toBe(0.75);

    const firstTrajectory = aggregation.trajectoryMeans.find(
      (trajectory) => trajectory.trajectoryId === "g1",
    );
    expect(firstTrajectory?.value).toBe(0.375);

    const firstCluster = aggregation.clusterMeans.find(
      (cluster) =>
        cluster.calibrationClusterId === calibrationClusterId("dev", "c01", 1),
    );
    expect(firstCluster).toMatchObject({
      trajectoryCount: 2,
      value: 0.6875,
    });
    expect(aggregation.value).toBe(0.34375);
  });

  it("is permutation invariant and rejects duplicate observation IDs", () => {
    expect(aggregateNested([...observations].reverse())).toEqual(
      aggregateNested(observations),
    );
    expect(() =>
      aggregateNested([
        observations[0],
        { ...observations[1], observationId: observations[0].observationId },
      ]),
    ).toThrow(/Duplicate metric observationId/u);
  });
});

describe("paired clustered differences and bootstrap", () => {
  function pairedLeaves(
    arm: "candidate" | "reference",
  ): readonly MetricObservation[] {
    const values =
      arm === "candidate"
        ? [
            [1, "r0", 0],
            [1, "r1", 0],
            [1, "r2", 1],
            [2, "r0", 1],
            [2, "r1", 1],
            [2, "r2", 1],
          ]
        : [
            [1, "r0", 0],
            [1, "r1", 1],
            [1, "r2", 1],
            [2, "r0", 0],
            [2, "r1", 0],
            [2, "r2", 0],
          ];
    return values.map(([base, rotation, value], index) =>
      observation(
        `${arm}-${index.toString()}`,
        value as number,
        coordinates(
          base as number,
          `game-${base as number}-${rotation as string}`,
          "state",
          "family",
          "query",
        ),
      ),
    );
  }

  it("retains all three rotations inside each of two paired clusters", () => {
    const pairs = pairedClusterDifferences(
      pairedLeaves("candidate"),
      pairedLeaves("reference"),
    );
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toMatchObject({
      candidate: 1 / 3,
      reference: 2 / 3,
      difference: -1 / 3,
    });
    expect(pairs[1]).toMatchObject({
      candidate: 1,
      reference: 0,
      difference: 1,
    });
  });

  it("is exactly reproducible for a fixed keyed seed", () => {
    const candidate = pairedLeaves("candidate");
    const reference = pairedLeaves("reference");
    const first = pairedNestedBootstrap(candidate, reference, {
      resamples: 512,
      seed: "phase6-fixed-bootstrap",
    });
    const repeated = pairedNestedBootstrap(candidate, reference, {
      resamples: 512,
      seed: "phase6-fixed-bootstrap",
    });

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      method: "paired-cluster-bootstrap-percentile",
      confidenceLevel: 0.95,
      resamples: 512,
      clusterCount: 2,
      lower: -1 / 3,
      upper: 1,
    });
    expect(first.estimate).toBeCloseTo(1 / 3, 15);
  });

  it("rejects unpaired nested query structures instead of dropping failures", () => {
    expect(() =>
      pairedClusterDifferences(
        pairedLeaves("candidate"),
        pairedLeaves("reference").slice(1),
      ),
    ).toThrow(/same nested query hierarchy/u);
  });
});

describe("forced/discretionary and seat-stratified action metrics", () => {
  function actionPrediction(
    id: string,
    seat: "p2" | "p3",
    base: number,
    distribution: ActionPrediction["distribution"],
  ): ActionPrediction {
    return {
      schemaVersion: 1,
      predictionId: id,
      arm: "behavioral",
      coordinates: coordinates(
        base,
        `game-${base.toString()}`,
        "state",
        "opponent-action",
        id,
      ),
      hardKnown: false,
      kind: "action",
      seat,
      distribution,
    };
  }

  it("reports each populated seat/class stratum with nested means", () => {
    const scores = [
      scoreActionPrediction(
        actionPrediction("p2-forced", "p2", 1, [
          { label: "only", probability: 1 },
        ]),
        "only",
        true,
        "obs-p2-forced",
      ),
      scoreActionPrediction(
        actionPrediction("p2-free", "p2", 1, [
          { label: "a", probability: 0.5 },
          { label: "b", probability: 0.5 },
        ]),
        "b",
        false,
        "obs-p2-free",
      ),
      scoreActionPrediction(
        actionPrediction("p3-forced", "p3", 2, [
          { label: "only", probability: 1 },
        ]),
        "only",
        true,
        "obs-p3-forced",
      ),
      scoreActionPrediction(
        actionPrediction("p3-free", "p3", 2, [
          { label: "a", probability: 0.9 },
          { label: "b", probability: 0.1 },
        ]),
        "b",
        false,
        "obs-p3-free",
      ),
    ];

    const summaries = aggregateActionScores(scores);
    expect(
      summaries.map(({ seat, decisionClass, observationCount }) => ({
        seat,
        decisionClass,
        observationCount,
      })),
    ).toEqual([
      { seat: "p2", decisionClass: "forced", observationCount: 1 },
      { seat: "p2", decisionClass: "discretionary", observationCount: 1 },
      { seat: "p3", decisionClass: "forced", observationCount: 1 },
      { seat: "p3", decisionClass: "discretionary", observationCount: 1 },
    ]);

    const p2Discretionary = summaries.find(
      (summary) =>
        summary.seat === "p2" && summary.decisionClass === "discretionary",
    );
    expect(p2Discretionary?.selectedTop1Accuracy.value).toBe(0);
    expect(p2Discretionary?.tieAwareTopSetAccuracy.value).toBe(1);
    expect(p2Discretionary?.tieAwareTop1Credit.value).toBe(0.5);
  });
});
