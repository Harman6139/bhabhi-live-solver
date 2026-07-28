import { describe, expect, it } from "vitest";

import { runBatch, summarizeBatch } from "../../src/evaluation/batch";
import {
  STYLE_CELLS,
  createPhase4SmokePlan,
  expectedGameCount,
  type BatchPlan,
} from "../../src/evaluation/protocol";

describe("Phase 4 baseline batches", () => {
  it("completes a three-rotation batch across all 17 cells with zero failures", () => {
    const plan: BatchPlan = {
      ...createPhase4SmokePlan("all-cell-test", 1),
      userPolicyIds: ["random"],
    };
    const result = runBatch(plan);

    expect(expectedGameCount(plan)).toBe(51);
    expect(result.seeds).toHaveLength(51);
    expect(result.games).toHaveLength(51);
    expect(result.truths).toHaveLength(51);
    expect(result.decisions.length).toBeGreaterThan(51);
    expect(result.failures).toEqual([]);
    expect(result.summary).toMatchObject({
      expectedGames: 51,
      attemptedGames: 51,
      completedGames: 51,
      failedGames: 0,
      turnCapGames: 0,
      invariantFailures: 0,
      zeroFailureGate: true,
    });
    expect(result.summary.byStyleCell.map((row) => row.key)).toEqual(
      STYLE_CELLS.map((cell) => cell.id),
    );
    expect(result.summary.byStyleCell.every((row) => row.games === 3)).toBe(
      true,
    );
    expect(result.summary.byRotation).toEqual([
      expect.objectContaining({ key: "0", games: 17 }),
      expect.objectContaining({ key: "1", games: 17 }),
      expect.objectContaining({ key: "2", games: 17 }),
    ]);
    expect(
      result.games.every(
        (game) => game.invariantCheckCount === game.eventCount,
      ),
    ).toBe(true);
  }, 30_000);

  it("reproduces the deterministic digest across run IDs and ignores timing", () => {
    const basePlan: BatchPlan = {
      ...createPhase4SmokePlan("reproduction-a", 1),
      userPolicyIds: ["noisy-mixture"],
      styleCellIds: ["c16_noisy-mixture__phase-switch"],
    };
    const first = runBatch(basePlan);
    const second = runBatch({
      ...basePlan,
      runId: "reproduction-b",
    });

    expect(first.failures).toEqual([]);
    expect(second.failures).toEqual([]);
    expect(first.summary.reproductionDigest).toBe(
      second.summary.reproductionDigest,
    );
    expect(first.games.map((game) => game.gameId)).toEqual(
      second.games.map((game) => game.gameId),
    );
    expect(first.games.map((game) => game.runId)).toEqual([
      "reproduction-a",
      "reproduction-a",
      "reproduction-a",
    ]);
    expect(second.games.map((game) => game.runId)).toEqual([
      "reproduction-b",
      "reproduction-b",
      "reproduction-b",
    ]);

    const timingAndRunIdChanged = summarizeBatch(
      { ...basePlan, runId: "synthetic-timing-change" },
      first.games.map((game, index) => ({
        ...game,
        runId: "synthetic-timing-change",
        wallTimeMs: game.wallTimeMs + 10_000 + index,
      })),
      first.decisions.map((decision) => ({
        ...decision,
        runId: "synthetic-timing-change",
      })),
      first.failures,
    );
    expect(timingAndRunIdChanged.reproductionDigest).toBe(
      first.summary.reproductionDigest,
    );
  }, 30_000);

  it("preserves the locked Phase 4 no-hook artifact bytes", () => {
    const plan: BatchPlan = {
      ...createPhase4SmokePlan("hook-compatibility", 1),
      userPolicyIds: ["random"],
      styleCellIds: ["c16_noisy-mixture__phase-switch"],
      rotations: [0],
    };
    const result = runBatch(plan);

    expect(result.failures).toEqual([]);
    expect(result.decisions).toHaveLength(56);
    expect(result.games[0]?.deterministicGameDigest).toBe(
      "fnv1a64:e6c33bcb339502c0",
    );
    expect(result.games[0]?.deterministicOutcomeHash).toBe(
      "fnv1a64:b980f0d6a84b315b",
    );
    expect(result.summary.reproductionDigest).toBe("fnv1a64:6aefeb4172935686");
  }, 30_000);
});
