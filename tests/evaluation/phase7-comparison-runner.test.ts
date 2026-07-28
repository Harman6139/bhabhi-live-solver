import { describe, expect, it } from "vitest";

import {
  createPhase7ComparisonPlan,
  derivePhase7ComparisonScenarioSeeds,
  expectedPhase7ComparisonGames,
  runPhase7ComparisonScenario,
} from "../../src/evaluation/phase7-comparison-runner";
import { STYLE_CELLS } from "../../src/evaluation/protocol";

describe("Phase 7 complete-game comparison runner", () => {
  it("freezes the 102-game smoke schedule and distinct exact-off/on configurations", () => {
    const plan = createPhase7ComparisonPlan({
      runId: "phase7-runner-plan-fixture",
      baseCount: 1,
    });
    expect(expectedPhase7ComparisonGames(plan)).toBe(102);
    expect(plan.rotations).toEqual([0, 1, 2]);
    expect(plan.verifyFallbackParity).toBe(true);
    expect(plan.configurations).toMatchObject([
      {
        role: "reference",
        exactEnabled: false,
        behaviorWeightingEnabled: false,
      },
      {
        role: "candidate",
        exactEnabled: true,
        behaviorWeightingEnabled: false,
      },
    ]);
    expect(plan.configurations[0].configHash).not.toBe(
      plan.configurations[1].configHash,
    );
  });

  it("keeps every solver-facing stream independent of the hidden style cell", () => {
    const scenarioSeeds = STYLE_CELLS.map((styleCell) =>
      derivePhase7ComparisonScenarioSeeds({
        split: "dev",
        styleCellId: styleCell.id,
        baseIndex: 7,
        rotation: 2,
      }),
    );
    const first = scenarioSeeds[0];
    const last = scenarioSeeds.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("The frozen style suite is empty.");
    }

    expect(
      new Set(scenarioSeeds.map(({ solver }) => JSON.stringify(solver))).size,
    ).toBe(1);
    expect(first.solver).toEqual(last.solver);
    expect(first.record.belief).toBe(first.solver.belief);
    expect(first.record.search).toBe(first.solver.search);
    expect(first.record.rollout).toBe(first.solver.rollout);
    expect(first.record.solverChance).toBe(first.solver.chance);
    expect(first.record.bootstrap).toBe(first.solver.bootstrap);

    // Hidden-style environment randomness remains private to the simulator.
    expect(first.simulator.p2Policy).not.toBe(last.simulator.p2Policy);
    expect(first.simulator.p3Policy).not.toBe(last.simulator.p3Policy);
    expect(first.simulator.chance).not.toBe(last.simulator.chance);
    expect(first.record.environmentChance).toBe(first.simulator.chance);
    expect(first.solver.chance).not.toBe(first.simulator.chance);
  });

  it("runs a paired scenario with identical environment seeds and auditable candidate fallbacks", () => {
    const styleCell = STYLE_CELLS[0];
    if (styleCell === undefined) {
      throw new Error("The frozen style suite is empty.");
    }
    const plan = createPhase7ComparisonPlan({
      runId: "phase7-runner-paired-fixture",
      baseCount: 1,
    });
    const reference = runPhase7ComparisonScenario({
      plan,
      role: "reference",
      styleCell,
      baseIndex: 0,
      rotation: 0,
    });
    const candidate = runPhase7ComparisonScenario({
      plan,
      role: "candidate",
      styleCell,
      baseIndex: 0,
      rotation: 0,
    });

    expect(reference.failure).toBeNull();
    expect(candidate.failure).toBeNull();
    expect(reference.game).not.toBeNull();
    expect(candidate.game).not.toBeNull();
    expect(reference.truth?.initialHands).toEqual(
      candidate.truth?.initialHands,
    );
    expect(reference.game?.seedIds).toEqual(candidate.game?.seedIds);
    expect(reference.game?.pairId).toBe(candidate.game?.pairId);
    expect(reference.game?.gameId).not.toBe(candidate.game?.gameId);
    expect(reference.decisions.length).toBeGreaterThan(0);
    expect(candidate.decisions.length).toBeGreaterThan(0);
    expect(
      reference.decisions.every(
        (decision) =>
          decision.exactOutcome === "not-attempted" &&
          decision.dispatchOutcome === "fallback",
      ),
    ).toBe(true);
    expect(
      candidate.decisions.every(
        (decision) =>
          decision.exactOutcome === "used" ||
          (decision.exactOutcome === "refused" &&
            decision.exactRefusalCode !== null &&
            decision.exactRefusalDetail?.code === decision.exactRefusalCode &&
            decision.fallbackParity === "passed"),
      ),
    ).toBe(true);
    expect(candidate.latencies).toHaveLength(candidate.decisions.length);
  }, 30_000);
});
