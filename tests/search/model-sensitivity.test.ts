import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  analyzeModelSensitivity,
  ModelSensitivityError,
  type ModelSensitivityErrorCode,
  type ModelSensitivityInput,
} from "../../src/search/model-sensitivity";

function stableDominanceFixture(): ModelSensitivityInput {
  return {
    schemaVersion: 1,
    p2ModelIds: ["always-high", "random"],
    p3ModelIds: ["always-low", "random"],
    actionKeys: ["play:4D", "play:QD"],
    cells: [
      {
        p2ModelId: "always-high",
        p3ModelId: "always-low",
        posteriorWeight: 0.25,
        actionRisks: [
          { actionKey: "play:4D", terminalRisk: 0.1 },
          { actionKey: "play:QD", terminalRisk: 0.4 },
        ],
      },
      {
        p2ModelId: "always-high",
        p3ModelId: "random",
        posteriorWeight: 0.25,
        actionRisks: [
          { actionKey: "play:4D", terminalRisk: 0.2 },
          { actionKey: "play:QD", terminalRisk: 0.5 },
        ],
      },
      {
        p2ModelId: "random",
        p3ModelId: "always-low",
        posteriorWeight: 0.25,
        actionRisks: [
          { actionKey: "play:4D", terminalRisk: 0.3 },
          { actionKey: "play:QD", terminalRisk: 0.6 },
        ],
      },
      {
        p2ModelId: "random",
        p3ModelId: "random",
        posteriorWeight: 0.25,
        actionRisks: [
          { actionKey: "play:4D", terminalRisk: 0.4 },
          { actionKey: "play:QD", terminalRisk: 0.7 },
        ],
      },
    ],
  };
}

function fragileSwitchFixture(): ModelSensitivityInput {
  return {
    schemaVersion: 1,
    p2ModelIds: ["always-high", "always-low"],
    p3ModelIds: ["power-avoider", "random"],
    actionKeys: ["play:A", "play:B"],
    cells: [
      {
        p2ModelId: "always-high",
        p3ModelId: "power-avoider",
        posteriorWeight: 0.6,
        actionRisks: [
          { actionKey: "play:A", terminalRisk: 0.1 },
          { actionKey: "play:B", terminalRisk: 0.4 },
        ],
      },
      {
        p2ModelId: "always-high",
        p3ModelId: "random",
        posteriorWeight: 0.2,
        actionRisks: [
          { actionKey: "play:A", terminalRisk: 0.2 },
          { actionKey: "play:B", terminalRisk: 0.3 },
        ],
      },
      {
        p2ModelId: "always-low",
        p3ModelId: "power-avoider",
        posteriorWeight: 0.1,
        actionRisks: [
          { actionKey: "play:A", terminalRisk: 0.6 },
          { actionKey: "play:B", terminalRisk: 0.2 },
        ],
      },
      {
        p2ModelId: "always-low",
        p3ModelId: "random",
        posteriorWeight: 0.1,
        actionRisks: [
          { actionKey: "play:A", terminalRisk: 0.7 },
          { actionKey: "play:B", terminalRisk: 0.1 },
        ],
      },
    ],
  };
}

function expectErrorCode(
  input: unknown,
  expectedCode: ModelSensitivityErrorCode,
): void {
  let thrown: unknown;
  try {
    analyzeModelSensitivity(input);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ModelSensitivityError);
  expect(thrown).toMatchObject({ code: expectedCode });
}

describe("model-sensitivity diagnostic", () => {
  it("reports stable dominance without changing the posterior expected-risk objective", () => {
    const result = analyzeModelSensitivity(stableDominanceFixture());

    expect(result.primaryObjective).toBe("posterior-expected-terminal-risk");
    expect(result.posterior).toMatchObject({
      recommendedActionKey: "play:4D",
      winningActionKeys: ["play:4D"],
      minimumExpectedRisk: 0.25,
      expectedRisk: 0.25,
      expectedRegret: 0,
    });
    expect(result.cells).toHaveLength(4);
    expect(
      result.cells.every(
        (cell) =>
          cell.winningActionKeys.length === 1 &&
          cell.winningActionKeys[0] === "play:4D" &&
          !cell.tie &&
          !cell.switchesFromPosteriorRecommendation,
      ),
    ).toBe(true);
    expect(result.fragility).toMatchObject({
      warning: false,
      code: "STABLE_ACROSS_MODEL_CELLS",
      switchCellIds: [],
      switchPosteriorMass: 0,
      maximumSwitchRegret: 0,
      expectedSwitchRegret: 0,
      zeroWeightCellIds: [],
    });
    expect(result.robustDiagnostic).toMatchObject({
      advisoryOnly: true,
      objective: "minimize-worst-cell-terminal-risk",
      candidateActionKeys: ["play:4D"],
      actionKey: "play:4D",
      worstCellRisk: 0.4,
      posteriorExpectedRisk: 0.25,
      differsFromPrimary: false,
    });
    expect(result.resultHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cells)).toBe(true);
    expect(Object.isFrozen(result.cells[0]?.actionRisks)).toBe(true);
    expect(() => {
      (
        result.posterior as { recommendedActionKey: string }
      ).recommendedActionKey = "play:QD";
    }).toThrow(TypeError);
  });

  it("warns when model cells switch the winner and keeps the robust action diagnostic-only", () => {
    const result = analyzeModelSensitivity(fragileSwitchFixture());

    expect(result.posterior.recommendedActionKey).toBe("play:A");
    expect(result.posterior.expectedRisk).toBeCloseTo(0.23, 14);
    expect(result.posterior.expectedRegret).toBeCloseTo(0.1, 14);
    expect(result.fragility).toMatchObject({
      warning: true,
      code: "MODEL_SENSITIVE_RECOMMENDATION",
      switchPosteriorMass: 0.2,
      maximumSwitchRegret: 0.6,
      expectedSwitchRegret: 0.1,
      zeroWeightCellIds: [],
    });
    expect(result.fragility.switchCellIds).toHaveLength(2);
    expect(
      result.cells
        .filter((cell) => cell.switchesFromPosteriorRecommendation)
        .every(
          (cell) =>
            cell.winningActionKeys.length === 1 &&
            cell.winningActionKeys[0] === "play:B",
        ),
    ).toBe(true);
    expect(result.robustDiagnostic).toMatchObject({
      advisoryOnly: true,
      actionKey: "play:B",
      candidateActionKeys: ["play:B"],
      worstCellRisk: 0.4,
      posteriorExpectedRisk: 0.33,
      differsFromPrimary: true,
    });
    expect(result.posterior.recommendedActionKey).toBe("play:A");
    expect(result.actions.map((action) => action.actionKey)).toEqual([
      "play:A",
      "play:B",
    ]);
    expect(result.actions[0]).toMatchObject({
      worstCellRisk: 0.7,
      winningCellCount: 2,
    });
    expect(result.actions[0]?.posteriorExpectedRisk).toBeCloseTo(0.23, 14);
    expect(result.actions[0]?.expectedRegret).toBeCloseTo(0.1, 14);
    expect(result.actions[1]).toMatchObject({
      worstCellRisk: 0.4,
      winningCellCount: 2,
    });
    expect(result.actions[1]?.posteriorExpectedRisk).toBeCloseTo(0.33, 14);
    expect(result.actions[1]?.expectedRegret).toBeCloseTo(0.2, 14);
  });

  it("reports deterministic ties without a false switch warning when the posterior action remains co-optimal", () => {
    const fixture = stableDominanceFixture();
    const tied: ModelSensitivityInput = {
      ...fixture,
      cells: fixture.cells.map((cell, index) =>
        index === 0
          ? {
              ...cell,
              actionRisks: [
                { actionKey: "play:QD", terminalRisk: 0.1 },
                { actionKey: "play:4D", terminalRisk: 0.1 },
              ],
            }
          : cell,
      ),
    };

    const result = analyzeModelSensitivity(tied);
    expect(result.cells[0]).toMatchObject({
      winningActionKeys: ["play:4D", "play:QD"],
      recommendedActionKey: "play:4D",
      tie: true,
      switchesFromPosteriorRecommendation: false,
    });
    expect(result.fragility.warning).toBe(false);
  });

  it("does not warn for winner switches confined to zero-posterior-weight stress cells", () => {
    const fixture = stableDominanceFixture();
    const zeroWeightSwitches: ModelSensitivityInput = {
      ...fixture,
      cells: fixture.cells.map((cell, index) => ({
        ...cell,
        posteriorWeight: index < 2 ? 0.5 : 0,
        actionRisks:
          index < 2
            ? cell.actionRisks
            : [
                { actionKey: "play:4D", terminalRisk: 0.9 },
                { actionKey: "play:QD", terminalRisk: 0.1 },
              ],
      })),
    };

    const result = analyzeModelSensitivity(zeroWeightSwitches);
    expect(result.posterior).toMatchObject({
      recommendedActionKey: "play:4D",
      winningActionKeys: ["play:4D"],
    });
    expect(
      result.cells.filter((cell) => cell.posteriorWeight === 0),
    ).toHaveLength(2);
    expect(
      result.cells
        .filter((cell) => cell.posteriorWeight === 0)
        .every((cell) => cell.switchesFromPosteriorRecommendation),
    ).toBe(true);
    expect(result.fragility).toMatchObject({
      warning: false,
      code: "STABLE_ACROSS_MODEL_CELLS",
      switchCellIds: [],
      switchPosteriorMass: 0,
      maximumSwitchRegret: 0,
      expectedSwitchRegret: 0,
    });
    expect(result.fragility.zeroWeightCellIds).toHaveLength(2);
  });

  it("does not manufacture fragility by lexicographically breaking a posterior tie", () => {
    const fixture = stableDominanceFixture();
    const posteriorTie: ModelSensitivityInput = {
      ...fixture,
      cells: fixture.cells.map((cell, index) => ({
        ...cell,
        actionRisks:
          index < 2
            ? [
                { actionKey: "play:4D", terminalRisk: 0.1 },
                { actionKey: "play:QD", terminalRisk: 0.9 },
              ]
            : [
                { actionKey: "play:4D", terminalRisk: 0.9 },
                { actionKey: "play:QD", terminalRisk: 0.1 },
              ],
      })),
    };

    const result = analyzeModelSensitivity(posteriorTie);
    expect(result.posterior).toMatchObject({
      minimumExpectedRisk: 0.5,
      winningActionKeys: ["play:4D", "play:QD"],
      recommendedActionKey: "play:4D",
    });
    expect(
      result.cells.every((cell) => !cell.switchesFromPosteriorRecommendation),
    ).toBe(true);
    expect(result.fragility).toMatchObject({
      warning: false,
      code: "STABLE_ACROSS_MODEL_CELLS",
      switchCellIds: [],
      switchPosteriorMass: 0,
      maximumSwitchRegret: 0,
      expectedSwitchRegret: 0,
    });
  });

  it("is invariant to model, cell, action, and action-risk ordering", () => {
    const fixture = fragileSwitchFixture();
    const reordered: ModelSensitivityInput = {
      ...fixture,
      p2ModelIds: [...fixture.p2ModelIds].reverse(),
      p3ModelIds: [...fixture.p3ModelIds].reverse(),
      actionKeys: [...fixture.actionKeys].reverse(),
      cells: [...fixture.cells].reverse().map((cell) => ({
        ...cell,
        actionRisks: [...cell.actionRisks].reverse(),
      })),
    };

    const canonical = analyzeModelSensitivity(fixture);
    const metamorphic = analyzeModelSensitivity(reordered);
    expect(metamorphic).toEqual(canonical);
    expect(metamorphic.inputHash).toBe(canonical.inputHash);
    expect(metamorphic.resultHash).toBe(canonical.resultHash);
  });

  it("rejects malformed grids, weights, and terminal risks", () => {
    expectErrorCode(null, "INVALID_INPUT");

    const fixture = stableDominanceFixture();
    const duplicateAction = {
      ...fixture,
      actionKeys: ["play:4D", "play:4D"],
    };
    expectErrorCode(duplicateAction, "DUPLICATE_IDENTIFIER");

    const missingCell = {
      ...fixture,
      cells: fixture.cells.slice(1),
    };
    expectErrorCode(missingCell, "INCOMPLETE_MODEL_GRID");

    const firstCell = fixture.cells[0];
    if (firstCell === undefined) {
      throw new Error("Missing duplicate-cell fixture.");
    }
    const duplicateCell = {
      ...fixture,
      cells: [...fixture.cells, structuredClone(firstCell)],
    };
    expectErrorCode(duplicateCell, "DUPLICATE_CELL");

    const unnormalized = {
      ...fixture,
      cells: fixture.cells.map((cell) => ({
        ...cell,
        posteriorWeight: 0.2,
      })),
    };
    expectErrorCode(unnormalized, "WEIGHTS_NOT_NORMALIZED");

    const nonfiniteWeight = {
      ...fixture,
      cells: fixture.cells.map((cell, index) => ({
        ...cell,
        posteriorWeight:
          index === 0 ? Number.POSITIVE_INFINITY : cell.posteriorWeight,
      })),
    };
    expectErrorCode(nonfiniteWeight, "INVALID_WEIGHT");

    const missingRisk = {
      ...fixture,
      cells: fixture.cells.map((cell, index) => ({
        ...cell,
        actionRisks: index === 0 ? cell.actionRisks.slice(1) : cell.actionRisks,
      })),
    };
    expectErrorCode(missingRisk, "INVALID_ACTION_RISKS");

    const nonfinite = {
      ...fixture,
      cells: fixture.cells.map((cell, cellIndex) => ({
        ...cell,
        actionRisks: cell.actionRisks.map((risk, riskIndex) =>
          cellIndex === 0 && riskIndex === 0
            ? { ...risk, terminalRisk: Number.NaN }
            : risk,
        ),
      })),
    };
    expectErrorCode(nonfinite, "INVALID_TERMINAL_RISK");

    const outOfRange = {
      ...fixture,
      cells: fixture.cells.map((cell, cellIndex) => ({
        ...cell,
        actionRisks: cell.actionRisks.map((risk, riskIndex) =>
          cellIndex === 0 && riskIndex === 0
            ? { ...risk, terminalRisk: 1.01 }
            : risk,
        ),
      })),
    };
    expectErrorCode(outOfRange, "INVALID_TERMINAL_RISK");
  });

  it("has no simulator or hidden-truth dependency", () => {
    const source = readFileSync(
      new URL("../../src/search/model-sensitivity.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /(?:\/simulator\/|SimulationTruth|createSimulationTruth|truthState)/u,
    );
  });
});
