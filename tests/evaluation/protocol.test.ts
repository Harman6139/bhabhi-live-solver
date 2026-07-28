import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  STYLE_CELLS,
  createPhase4SmokePlan,
  deriveDealSeed,
  deriveStreamSeed,
  expandBatchPlan,
  expectedGameCount,
  type BatchPlan,
} from "../../src/evaluation/protocol";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function groupBy<T>(
  values: readonly T[],
  keyForValue: (value: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyForValue(value);
    const group = grouped.get(key);
    if (group === undefined) {
      grouped.set(key, [value]);
    } else {
      group.push(value);
    }
  }
  return grouped;
}

describe("eval-v1 seed protocol", () => {
  it("matches locked first-128-bit SHA-256 answer vectors", () => {
    const vectors = [
      {
        preimage: "bhabhi/eval-v1|dev|deal|0",
        expectedFull:
          "2c25afa475f0f3c0e832d01a5cbeab79f83df4a5589e38744bd1e9b38b7ab5e4",
        actual: deriveDealSeed("dev", 0),
      },
      {
        preimage: "bhabhi/eval-v1|qualification|deal|127",
        expectedFull:
          "5a3202b583757630b2c8de21c9e1a6d38dcb5376bd8cd94fe8d017dcab3fed64",
        actual: deriveDealSeed("qualification", 127),
      },
      {
        preimage:
          "bhabhi/eval-v1|final|p2-policy|c08_always-high__always-low|42|2|3",
        expectedFull:
          "e0650cb3f293a823b358b4774f32fc7b6fb8eb1d8133b6a8197d0e3e76306e2a",
        actual: deriveStreamSeed({
          split: "final",
          stream: "p2-policy",
          cell: "c08_always-high__always-low",
          baseIndex: 42,
          rotation: 2,
          replicate: 3,
        }),
      },
      {
        preimage:
          "bhabhi/eval-v1|train|bootstrap|c17_phase-switch__noisy-mixture|9|0|0",
        expectedFull:
          "c34200d970e73f19345f29208b7384b3b39baab1b642990c690c083c4b94202a",
        actual: deriveStreamSeed({
          split: "train",
          stream: "bootstrap",
          cell: "c17_phase-switch__noisy-mixture",
          baseIndex: 9,
          rotation: 0,
          replicate: 0,
        }),
      },
    ] as const;

    for (const vector of vectors) {
      expect(sha256Hex(vector.preimage)).toBe(vector.expectedFull);
      expect(vector.actual).toBe(vector.expectedFull.slice(0, 32));
      expect(vector.actual).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("shares crossed seeds across configurations while excluding configuration IDs", () => {
    const plan: BatchPlan = {
      ...createPhase4SmokePlan("seed-sharing", 1),
      userPolicyIds: ["always-high", "always-low"],
      styleCellIds: ["c01_random__random", "c08_always-high__always-low"],
      rotations: [0, 1],
      replicates: [0, 1],
    };
    const specs = expandBatchPlan(plan);

    expect(new Set(specs.map((spec) => spec.seeds.deal))).toHaveLength(1);

    const grouped = groupBy(specs, (spec) => spec.scenarioId);
    expect(grouped.size).toBe(2 * 1 * 2 * 2);
    for (const scenario of grouped.values()) {
      expect(scenario).toHaveLength(2);
      const [first, second] = scenario;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (first === undefined || second === undefined) {
        throw new Error("Expected one spec for each of two configurations.");
      }
      expect(first.configId).not.toBe(second.configId);
      expect(first.gameId).not.toBe(second.gameId);
      expect(first.seeds).toEqual(second.seeds);
    }

    const highCell = specs.find(
      (spec) =>
        spec.userPolicyId === "always-high" &&
        spec.styleCellId === "c01_random__random" &&
        spec.rotation === 0 &&
        spec.replicate === 0,
    );
    const crossedCell = specs.find(
      (spec) =>
        spec.userPolicyId === "always-high" &&
        spec.styleCellId === "c08_always-high__always-low" &&
        spec.rotation === 0 &&
        spec.replicate === 0,
    );
    const rotated = specs.find(
      (spec) =>
        spec.userPolicyId === "always-high" &&
        spec.styleCellId === "c01_random__random" &&
        spec.rotation === 1 &&
        spec.replicate === 0,
    );
    expect(highCell).toBeDefined();
    expect(crossedCell).toBeDefined();
    expect(rotated).toBeDefined();
    expect(highCell?.seeds.deal).toBe(crossedCell?.seeds.deal);
    expect(highCell?.seeds.deal).toBe(rotated?.seeds.deal);
    expect(highCell?.seeds.p2Policy).not.toBe(crossedCell?.seeds.p2Policy);
    expect(highCell?.seeds.p2Policy).not.toBe(rotated?.seeds.p2Policy);
  });
});

describe("frozen opponent-style matrix", () => {
  it("pins all 17 ordered cells and every asymmetric reversal", () => {
    expect(STYLE_CELLS).toEqual([
      { id: "c01_random__random", p2: "random", p3: "random" },
      {
        id: "c02_always-high__always-high",
        p2: "always-high",
        p3: "always-high",
      },
      {
        id: "c03_always-low__always-low",
        p2: "always-low",
        p3: "always-low",
      },
      {
        id: "c04_shortest-suit__shortest-suit",
        p2: "shortest-suit",
        p3: "shortest-suit",
      },
      {
        id: "c05_early-high-shedder__early-high-shedder",
        p2: "early-high-shedder",
        p3: "early-high-shedder",
      },
      {
        id: "c06_power-avoider__power-avoider",
        p2: "power-avoider",
        p3: "power-avoider",
      },
      {
        id: "c07_documented-basic__documented-basic",
        p2: "documented-basic",
        p3: "documented-basic",
      },
      {
        id: "c08_always-high__always-low",
        p2: "always-high",
        p3: "always-low",
      },
      {
        id: "c09_always-low__always-high",
        p2: "always-low",
        p3: "always-high",
      },
      {
        id: "c10_shortest-suit__early-high-shedder",
        p2: "shortest-suit",
        p3: "early-high-shedder",
      },
      {
        id: "c11_early-high-shedder__shortest-suit",
        p2: "early-high-shedder",
        p3: "shortest-suit",
      },
      {
        id: "c12_power-avoider__documented-basic",
        p2: "power-avoider",
        p3: "documented-basic",
      },
      {
        id: "c13_documented-basic__power-avoider",
        p2: "documented-basic",
        p3: "power-avoider",
      },
      {
        id: "c14_random__documented-basic",
        p2: "random",
        p3: "documented-basic",
      },
      {
        id: "c15_documented-basic__random",
        p2: "documented-basic",
        p3: "random",
      },
      {
        id: "c16_noisy-mixture__phase-switch",
        p2: "noisy-mixture",
        p3: "phase-switch",
      },
      {
        id: "c17_phase-switch__noisy-mixture",
        p2: "phase-switch",
        p3: "noisy-mixture",
      },
    ]);

    for (const [leftIndex, rightIndex] of [
      [7, 8],
      [9, 10],
      [11, 12],
      [13, 14],
      [15, 16],
    ] as const) {
      const left = STYLE_CELLS[leftIndex];
      const right = STYLE_CELLS[rightIndex];
      expect(left).toBeDefined();
      expect(right).toBeDefined();
      expect(left?.p2).toBe(right?.p3);
      expect(left?.p3).toBe(right?.p2);
    }
  });
});

describe("batch-plan expansion", () => {
  it("expands the full cross product with stable scenarios, IDs, and rotations", () => {
    const plan: BatchPlan = {
      ...createPhase4SmokePlan("expansion-a", 2),
      userPolicyIds: ["random", "always-low"],
      styleCellIds: ["c01_random__random", "c17_phase-switch__noisy-mixture"],
      baseIndexStart: 5,
      rotations: [0, 1, 2],
      replicates: [0, 1],
    };
    const specs = expandBatchPlan(plan);

    expect(expectedGameCount(plan)).toBe(48);
    expect(specs).toHaveLength(48);
    expect(new Set(specs.map((spec) => spec.gameId))).toHaveLength(48);
    expect(new Set(specs.map((spec) => spec.scenarioId))).toHaveLength(24);
    expect(new Set(specs.map((spec) => spec.clusterId))).toEqual(
      new Set(["dev/5", "dev/6"]),
    );

    const rotationGroups = groupBy(specs, (spec) =>
      [
        spec.userPolicyId,
        spec.styleCellId,
        spec.baseIndex,
        spec.replicate,
      ].join("|"),
    );
    expect(rotationGroups.size).toBe(2 * 2 * 2 * 2);
    for (const group of rotationGroups.values()) {
      expect(group.map((spec) => spec.rotation)).toEqual([0, 1, 2]);
      expect(new Set(group.map((spec) => spec.seeds.deal))).toHaveLength(1);
    }

    const witness = specs.find(
      (spec) =>
        spec.userPolicyId === "always-low" &&
        spec.styleCellId === "c01_random__random" &&
        spec.baseIndex === 5 &&
        spec.rotation === 2 &&
        spec.replicate === 1,
    );
    expect(witness).toMatchObject({
      scenarioId: "dev/c01_random__random/5/2/1/canonical-v1",
      configId: "baseline-always-low-v1",
      clusterId: "dev/5",
      gameId:
        "5e1c74a5a649443058c89a2f4e34f3a4a14eb9a61c970646c8176ea677d01f6b",
    });

    const rerunSpecs = expandBatchPlan({ ...plan, runId: "expansion-b" });
    expect(rerunSpecs.map((spec) => spec.gameId)).toEqual(
      specs.map((spec) => spec.gameId),
    );
    expect(rerunSpecs.map((spec) => spec.seeds)).toEqual(
      specs.map((spec) => spec.seeds),
    );
  });
});
