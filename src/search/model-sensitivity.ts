import { stableHash } from "../events/stable-hash";

export const MODEL_SENSITIVITY_ALGORITHM_VERSION =
  "model-sensitivity-diagnostic-v1" as const;

const NORMALIZATION_TOLERANCE = 1e-12;
const RISK_TIE_TOLERANCE = 1e-12;

export type ModelCellActionRisk = {
  readonly actionKey: string;
  readonly terminalRisk: number;
};

export type ModelSensitivityCellInput = {
  readonly p2ModelId: string;
  readonly p3ModelId: string;
  readonly posteriorWeight: number;
  readonly actionRisks: readonly ModelCellActionRisk[];
};

export type ModelSensitivityInput = {
  readonly schemaVersion: 1;
  readonly p2ModelIds: readonly string[];
  readonly p3ModelIds: readonly string[];
  readonly actionKeys: readonly string[];
  readonly cells: readonly ModelSensitivityCellInput[];
};

export type ModelSensitivityErrorCode =
  | "INVALID_INPUT"
  | "INVALID_IDENTIFIER"
  | "DUPLICATE_IDENTIFIER"
  | "INVALID_CELL"
  | "DUPLICATE_CELL"
  | "INCOMPLETE_MODEL_GRID"
  | "INVALID_WEIGHT"
  | "WEIGHTS_NOT_NORMALIZED"
  | "INVALID_ACTION_RISKS"
  | "INVALID_TERMINAL_RISK";

export class ModelSensitivityError extends Error {
  readonly code: ModelSensitivityErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ModelSensitivityErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ModelSensitivityError";
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

export type ModelSensitivityActionDiagnostic = {
  readonly actionKey: string;
  readonly posteriorExpectedRisk: number;
  readonly expectedRegret: number;
  readonly worstCellRisk: number;
  readonly winningCellCount: number;
};

export type ModelSensitivityCellDiagnostic = {
  readonly cellId: string;
  readonly p2ModelId: string;
  readonly p3ModelId: string;
  readonly posteriorWeight: number;
  readonly actionRisks: readonly ModelCellActionRisk[];
  readonly minimumRisk: number;
  readonly winningActionKeys: readonly string[];
  readonly recommendedActionKey: string;
  readonly tie: boolean;
  readonly posteriorActionRisk: number;
  readonly posteriorActionRegret: number;
  readonly switchesFromPosteriorRecommendation: boolean;
};

export type ModelSensitivityDiagnostic = {
  readonly schemaVersion: 1;
  readonly algorithmVersion: typeof MODEL_SENSITIVITY_ALGORITHM_VERSION;
  readonly inputHash: string;
  readonly resultHash: string;
  readonly primaryObjective: "posterior-expected-terminal-risk";
  readonly posterior: {
    readonly actionRisks: readonly {
      readonly actionKey: string;
      readonly expectedRisk: number;
    }[];
    readonly minimumExpectedRisk: number;
    readonly winningActionKeys: readonly string[];
    readonly recommendedActionKey: string;
    readonly expectedRisk: number;
    readonly expectedRegret: number;
  };
  readonly cells: readonly ModelSensitivityCellDiagnostic[];
  readonly actions: readonly ModelSensitivityActionDiagnostic[];
  readonly fragility: {
    readonly warning: boolean;
    readonly code:
      "STABLE_ACROSS_MODEL_CELLS" | "MODEL_SENSITIVE_RECOMMENDATION";
    readonly switchCellIds: readonly string[];
    readonly switchPosteriorMass: number;
    readonly maximumSwitchRegret: number;
    readonly expectedSwitchRegret: number;
    readonly zeroWeightCellIds: readonly string[];
    readonly message: string;
  };
  readonly robustDiagnostic: {
    readonly advisoryOnly: true;
    readonly objective: "minimize-worst-cell-terminal-risk";
    readonly candidateActionKeys: readonly string[];
    readonly actionKey: string;
    readonly worstCellRisk: number;
    readonly posteriorExpectedRisk: number;
    readonly differsFromPrimary: boolean;
  };
};

type CanonicalCell = {
  readonly p2ModelId: string;
  readonly p3ModelId: string;
  readonly posteriorWeight: number;
  readonly actionRisks: readonly ModelCellActionRisk[];
};

type CanonicalInput = {
  readonly schemaVersion: 1;
  readonly p2ModelIds: readonly string[];
  readonly p3ModelIds: readonly string[];
  readonly actionKeys: readonly string[];
  readonly cells: readonly CanonicalCell[];
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(
  code: ModelSensitivityErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new ModelSensitivityError(code, message, details);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseIdentifiers(
  value: unknown,
  field: "p2ModelIds" | "p3ModelIds" | "actionKeys",
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("INVALID_IDENTIFIER", `${field} must be a nonempty array.`, {
      field,
    });
  }
  const identifiers = value.map((entry, index) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.trim() !== entry
    ) {
      fail(
        "INVALID_IDENTIFIER",
        `${field}[${index.toString()}] must be a nonempty trimmed string.`,
        { field, index, value: entry },
      );
    }
    return entry;
  });
  if (new Set(identifiers).size !== identifiers.length) {
    fail("DUPLICATE_IDENTIFIER", `${field} contains a duplicate identifier.`, {
      field,
      identifiers,
    });
  }
  return identifiers.sort(compareText);
}

function cellKey(p2ModelId: string, p3ModelId: string): string {
  return JSON.stringify([p2ModelId, p3ModelId]);
}

function parseActionRisks(
  value: unknown,
  actionKeys: readonly string[],
  cell: Readonly<{ p2ModelId: string; p3ModelId: string }>,
): ModelCellActionRisk[] {
  if (!Array.isArray(value)) {
    fail("INVALID_ACTION_RISKS", "Cell actionRisks must be an array.", cell);
  }
  const byAction = new Map<string, number>();
  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate) || typeof candidate.actionKey !== "string") {
      fail(
        "INVALID_ACTION_RISKS",
        "Every action-risk entry must contain an actionKey.",
        { ...cell, index },
      );
    }
    const actionKey = candidate.actionKey;
    if (!actionKeys.includes(actionKey) || byAction.has(actionKey)) {
      fail(
        "INVALID_ACTION_RISKS",
        "Cell action risks must contain every declared action exactly once.",
        { ...cell, actionKey },
      );
    }
    const terminalRisk = candidate.terminalRisk;
    if (
      typeof terminalRisk !== "number" ||
      !Number.isFinite(terminalRisk) ||
      terminalRisk < 0 ||
      terminalRisk > 1
    ) {
      fail(
        "INVALID_TERMINAL_RISK",
        "Every terminal risk must be finite and in [0, 1].",
        { ...cell, actionKey, terminalRisk },
      );
    }
    byAction.set(actionKey, terminalRisk);
  }
  if (
    byAction.size !== actionKeys.length ||
    actionKeys.some((actionKey) => !byAction.has(actionKey))
  ) {
    fail("INVALID_ACTION_RISKS", "Cell action risks are incomplete.", {
      ...cell,
      expectedActionKeys: actionKeys,
      received: [...byAction.keys()],
    });
  }
  return actionKeys.map((actionKey) => ({
    actionKey,
    terminalRisk: byAction.get(actionKey) ?? Number.NaN,
  }));
}

function parseInput(value: unknown): CanonicalInput {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    fail("INVALID_INPUT", "Model sensitivity input must use schemaVersion 1.");
  }
  const p2ModelIds = parseIdentifiers(value.p2ModelIds, "p2ModelIds");
  const p3ModelIds = parseIdentifiers(value.p3ModelIds, "p3ModelIds");
  const actionKeys = parseIdentifiers(value.actionKeys, "actionKeys");
  if (!Array.isArray(value.cells)) {
    fail("INVALID_CELL", "cells must be an array.");
  }

  const declaredP2 = new Set(p2ModelIds);
  const declaredP3 = new Set(p3ModelIds);
  const cells = new Map<string, CanonicalCell>();
  for (const [index, candidate] of value.cells.entries()) {
    if (
      !isRecord(candidate) ||
      typeof candidate.p2ModelId !== "string" ||
      typeof candidate.p3ModelId !== "string"
    ) {
      fail("INVALID_CELL", "Every cell must declare P2 and P3 model IDs.", {
        index,
      });
    }
    const p2ModelId = candidate.p2ModelId;
    const p3ModelId = candidate.p3ModelId;
    if (!declaredP2.has(p2ModelId) || !declaredP3.has(p3ModelId)) {
      fail("INVALID_CELL", "Cell references an undeclared opponent model.", {
        index,
        p2ModelId,
        p3ModelId,
      });
    }
    const key = cellKey(p2ModelId, p3ModelId);
    if (cells.has(key)) {
      fail("DUPLICATE_CELL", "A P2/P3 model cell appears more than once.", {
        p2ModelId,
        p3ModelId,
      });
    }
    const posteriorWeight = candidate.posteriorWeight;
    if (
      typeof posteriorWeight !== "number" ||
      !Number.isFinite(posteriorWeight) ||
      posteriorWeight < 0 ||
      posteriorWeight > 1
    ) {
      fail(
        "INVALID_WEIGHT",
        "Every posterior cell weight must be finite and in [0, 1].",
        { p2ModelId, p3ModelId, posteriorWeight },
      );
    }
    cells.set(key, {
      p2ModelId,
      p3ModelId,
      posteriorWeight,
      actionRisks: parseActionRisks(candidate.actionRisks, actionKeys, {
        p2ModelId,
        p3ModelId,
      }),
    });
  }

  const expectedCellKeys = p2ModelIds.flatMap((p2ModelId) =>
    p3ModelIds.map((p3ModelId) => cellKey(p2ModelId, p3ModelId)),
  );
  const missingCells = expectedCellKeys.filter((key) => !cells.has(key));
  if (cells.size !== expectedCellKeys.length || missingCells.length > 0) {
    fail(
      "INCOMPLETE_MODEL_GRID",
      "The P2/P3 model grid must contain every declared cell exactly once.",
      {
        expectedCellCount: expectedCellKeys.length,
        receivedCellCount: cells.size,
        missingCells,
      },
    );
  }

  const orderedCells = expectedCellKeys.map((key) => {
    const cell = cells.get(key);
    if (cell === undefined) {
      fail("INCOMPLETE_MODEL_GRID", "A required model cell is missing.", {
        key,
      });
    }
    return cell;
  });
  const weightSum = orderedCells.reduce(
    (sum, cell) => sum + cell.posteriorWeight,
    0,
  );
  if (
    !Number.isFinite(weightSum) ||
    Math.abs(weightSum - 1) > NORMALIZATION_TOLERANCE
  ) {
    fail("WEIGHTS_NOT_NORMALIZED", "Posterior cell weights must sum to one.", {
      weightSum,
      tolerance: NORMALIZATION_TOLERANCE,
    });
  }

  return {
    schemaVersion: 1,
    p2ModelIds,
    p3ModelIds,
    actionKeys,
    cells: orderedCells.map((cell) => ({
      ...cell,
      posteriorWeight: cell.posteriorWeight / weightSum,
    })),
  };
}

function riskForAction(
  risks: readonly ModelCellActionRisk[],
  actionKey: string,
): number {
  const risk = risks.find((entry) => entry.actionKey === actionKey);
  if (risk === undefined) {
    fail("INVALID_ACTION_RISKS", "A canonical action risk is missing.", {
      actionKey,
    });
  }
  return risk.terminalRisk;
}

function minimum(values: readonly number[]): number {
  if (values.length === 0) {
    fail("INVALID_INPUT", "A risk minimum requires at least one value.");
  }
  let result = Number.POSITIVE_INFINITY;
  for (const value of values) {
    result = Math.min(result, value);
  }
  return result;
}

function tiedKeys(
  values: readonly { readonly actionKey: string; readonly risk: number }[],
  minimumRisk: number,
): string[] {
  return values
    .filter((entry) => entry.risk <= minimumRisk + RISK_TIE_TOLERANCE)
    .map((entry) => entry.actionKey)
    .sort(compareText);
}

function clampRisk(value: number): number {
  if (value < 0 && value >= -RISK_TIE_TOLERANCE) {
    return 0;
  }
  if (value > 1 && value <= 1 + RISK_TIE_TOLERANCE) {
    return 1;
  }
  return value;
}

/**
 * Computes model sensitivity from already-produced terminal-risk estimates.
 * The posterior expected-risk recommendation remains the primary objective;
 * the minimax action is returned only as a diagnostic.
 */
export function analyzeModelSensitivity(
  value: unknown,
): ModelSensitivityDiagnostic {
  const input = parseInput(value);
  const inputHash = stableHash({
    algorithmVersion: MODEL_SENSITIVITY_ALGORITHM_VERSION,
    input,
  });

  const expectedRisks = input.actionKeys.map((actionKey) => ({
    actionKey,
    expectedRisk: clampRisk(
      input.cells.reduce(
        (sum, cell) =>
          sum +
          cell.posteriorWeight * riskForAction(cell.actionRisks, actionKey),
        0,
      ),
    ),
  }));
  const minimumExpectedRisk = minimum(
    expectedRisks.map((entry) => entry.expectedRisk),
  );
  const posteriorWinningActionKeys = tiedKeys(
    expectedRisks.map((entry) => ({
      actionKey: entry.actionKey,
      risk: entry.expectedRisk,
    })),
    minimumExpectedRisk,
  );
  const posteriorRecommendedActionKey = posteriorWinningActionKeys[0];
  if (posteriorRecommendedActionKey === undefined) {
    fail("INVALID_INPUT", "No posterior recommendation could be selected.");
  }

  const cells = input.cells.map((cell): ModelSensitivityCellDiagnostic => {
    const risks = cell.actionRisks.map((entry) => ({
      actionKey: entry.actionKey,
      risk: entry.terminalRisk,
    }));
    const minimumRisk = minimum(risks.map((entry) => entry.risk));
    const winningActionKeys = tiedKeys(risks, minimumRisk);
    const recommendedActionKey = winningActionKeys[0];
    if (recommendedActionKey === undefined) {
      fail("INVALID_INPUT", "No cell recommendation could be selected.", {
        p2ModelId: cell.p2ModelId,
        p3ModelId: cell.p3ModelId,
      });
    }
    const posteriorActionRisk = riskForAction(
      cell.actionRisks,
      posteriorRecommendedActionKey,
    );
    return {
      cellId: stableHash({
        inputHash,
        p2ModelId: cell.p2ModelId,
        p3ModelId: cell.p3ModelId,
      }),
      p2ModelId: cell.p2ModelId,
      p3ModelId: cell.p3ModelId,
      posteriorWeight: cell.posteriorWeight,
      actionRisks: cell.actionRisks,
      minimumRisk,
      winningActionKeys,
      recommendedActionKey,
      tie: winningActionKeys.length > 1,
      posteriorActionRisk,
      posteriorActionRegret: Math.max(0, posteriorActionRisk - minimumRisk),
      switchesFromPosteriorRecommendation: !winningActionKeys.some(
        (actionKey) => posteriorWinningActionKeys.includes(actionKey),
      ),
    };
  });

  const actions = input.actionKeys.map(
    (actionKey): ModelSensitivityActionDiagnostic => {
      const expectedRisk =
        expectedRisks.find((entry) => entry.actionKey === actionKey)
          ?.expectedRisk ?? Number.NaN;
      return {
        actionKey,
        posteriorExpectedRisk: expectedRisk,
        expectedRegret: Math.max(
          0,
          cells.reduce(
            (sum, cell) =>
              sum +
              cell.posteriorWeight *
                (riskForAction(cell.actionRisks, actionKey) - cell.minimumRisk),
            0,
          ),
        ),
        worstCellRisk: Math.max(
          ...cells.map((cell) => riskForAction(cell.actionRisks, actionKey)),
        ),
        winningCellCount: cells.filter((cell) =>
          cell.winningActionKeys.includes(actionKey),
        ).length,
      };
    },
  );
  const posteriorAction = actions.find(
    (entry) => entry.actionKey === posteriorRecommendedActionKey,
  );
  if (posteriorAction === undefined) {
    fail("INVALID_INPUT", "Posterior action diagnostics are missing.");
  }

  const minimumWorstCellRisk = minimum(
    actions.map((action) => action.worstCellRisk),
  );
  const robustCandidates = actions.filter(
    (action) =>
      action.worstCellRisk <= minimumWorstCellRisk + RISK_TIE_TOLERANCE,
  );
  const minimumRobustExpectedRisk = minimum(
    robustCandidates.map((action) => action.posteriorExpectedRisk),
  );
  const robustCandidateActionKeys = robustCandidates
    .map((action) => action.actionKey)
    .sort(compareText);
  const tieBrokenRobustActionKeys = robustCandidates
    .filter(
      (action) =>
        action.posteriorExpectedRisk <=
        minimumRobustExpectedRisk + RISK_TIE_TOLERANCE,
    )
    .map((action) => action.actionKey)
    .sort(compareText);
  const robustActionKey = tieBrokenRobustActionKeys[0];
  const robustAction = actions.find(
    (action) => action.actionKey === robustActionKey,
  );
  if (robustActionKey === undefined || robustAction === undefined) {
    fail("INVALID_INPUT", "No robust diagnostic action could be selected.");
  }

  const supportedSwitchCells = cells.filter(
    (cell) =>
      cell.posteriorWeight > 0 && cell.switchesFromPosteriorRecommendation,
  );
  const switchCellIds = supportedSwitchCells.map((cell) => cell.cellId);
  const switchPosteriorMass = supportedSwitchCells.reduce(
    (sum, cell) => sum + cell.posteriorWeight,
    0,
  );
  const maximumSwitchRegret =
    supportedSwitchCells.length === 0
      ? 0
      : Math.max(
          ...supportedSwitchCells.map((cell) => cell.posteriorActionRegret),
        );
  const expectedSwitchRegret = supportedSwitchCells.reduce(
    (sum, cell) => sum + cell.posteriorWeight * cell.posteriorActionRegret,
    0,
  );
  const zeroWeightCellIds = cells
    .filter((cell) => cell.posteriorWeight === 0)
    .map((cell) => cell.cellId);
  const warning = switchCellIds.length > 0;
  const content = {
    schemaVersion: 1 as const,
    algorithmVersion: MODEL_SENSITIVITY_ALGORITHM_VERSION,
    inputHash,
    primaryObjective: "posterior-expected-terminal-risk" as const,
    posterior: {
      actionRisks: expectedRisks,
      minimumExpectedRisk,
      winningActionKeys: posteriorWinningActionKeys,
      recommendedActionKey: posteriorRecommendedActionKey,
      expectedRisk: posteriorAction.posteriorExpectedRisk,
      expectedRegret: posteriorAction.expectedRegret,
    },
    cells,
    actions,
    fragility: {
      warning,
      code: warning
        ? ("MODEL_SENSITIVE_RECOMMENDATION" as const)
        : ("STABLE_ACROSS_MODEL_CELLS" as const),
      switchCellIds,
      switchPosteriorMass,
      maximumSwitchRegret,
      expectedSwitchRegret,
      zeroWeightCellIds,
      message: warning
        ? "The posterior recommendation is not optimal in every prespecified opponent-model cell."
        : "The posterior recommendation remains optimal in every prespecified opponent-model cell.",
    },
    robustDiagnostic: {
      advisoryOnly: true as const,
      objective: "minimize-worst-cell-terminal-risk" as const,
      candidateActionKeys: robustCandidateActionKeys,
      actionKey: robustActionKey,
      worstCellRisk: robustAction.worstCellRisk,
      posteriorExpectedRisk: robustAction.posteriorExpectedRisk,
      differsFromPrimary: robustActionKey !== posteriorRecommendedActionKey,
    },
  };
  return deepFreeze({
    ...content,
    resultHash: stableHash(content),
  });
}
