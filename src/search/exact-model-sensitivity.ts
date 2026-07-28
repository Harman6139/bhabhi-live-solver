import { stableHash } from "../events/stable-hash";
import type { BehaviorModelId } from "../inference/behavior-models";
import {
  type ExactEndgameIneligibleResult,
  type ExactEndgameSolvedResult,
  type ExactIneligibilityCode,
  type ExactInformationHypothesis,
} from "./advanced-types";
import {
  solveExactEndgame,
  type ExactEndgameSearchInput,
} from "./exact-endgame";
import { createExactInformationHypothesisSet } from "./exact-hypotheses";
import {
  analyzeModelSensitivity,
  type ModelSensitivityDiagnostic,
} from "./model-sensitivity";

export const EXACT_MODEL_SENSITIVITY_ALGORITHM_VERSION =
  "exact-model-sensitivity-v1" as const;

export type ExactModelSensitivityCell = {
  readonly p2ModelId: BehaviorModelId;
  readonly p3ModelId: BehaviorModelId;
  readonly posteriorWeight: number;
  readonly exactResultHash: string;
  readonly actionRisks: readonly {
    readonly actionKey: string;
    readonly terminalRisk: number;
  }[];
};

type ExactModelSensitivityEnvelope = {
  readonly schemaVersion: 1;
  readonly algorithmVersion: typeof EXACT_MODEL_SENSITIVITY_ALGORITHM_VERSION;
  readonly method: "exact-cell-conditioned-terminal-risk";
  readonly historyHash: string;
  readonly hypothesisSetChecksum: string;
  readonly resultHash: string;
};

export type ExactModelSensitivitySolved = ExactModelSensitivityEnvelope & {
  readonly quality: "Exact";
  readonly eligibility: { readonly eligible: true };
  readonly baseResult: ExactEndgameSolvedResult;
  readonly cells: readonly ExactModelSensitivityCell[];
  readonly diagnostic: ModelSensitivityDiagnostic;
};

export type ExactModelSensitivityIneligible = ExactModelSensitivityEnvelope & {
  readonly quality: "Unavailable";
  readonly eligibility: {
    readonly eligible: false;
    readonly code: ExactIneligibilityCode;
    readonly detail: string;
  };
  readonly baseResult: ExactEndgameSolvedResult | ExactEndgameIneligibleResult;
  readonly failedCell: {
    readonly p2ModelId: BehaviorModelId;
    readonly p3ModelId: BehaviorModelId;
  } | null;
  readonly cells: readonly ExactModelSensitivityCell[];
  readonly diagnostic: null;
};

export type ExactModelSensitivityResult =
  ExactModelSensitivitySolved | ExactModelSensitivityIneligible;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function cellKey(
  p2ModelId: BehaviorModelId,
  p3ModelId: BehaviorModelId,
): string {
  return JSON.stringify([p2ModelId, p3ModelId]);
}

function resultWithHash<
  T extends Omit<ExactModelSensitivityEnvelope, "resultHash">,
>(content: T): T & { readonly resultHash: string } {
  return deepFreeze({
    ...content,
    resultHash: stableHash(content),
  });
}

function ineligible(input: {
  readonly request: ExactEndgameSearchInput;
  readonly baseResult: ExactEndgameSolvedResult | ExactEndgameIneligibleResult;
  readonly code: ExactIneligibilityCode;
  readonly detail: string;
  readonly failedCell: {
    readonly p2ModelId: BehaviorModelId;
    readonly p3ModelId: BehaviorModelId;
  } | null;
  readonly cells: readonly ExactModelSensitivityCell[];
}): ExactModelSensitivityIneligible {
  return resultWithHash({
    schemaVersion: 1,
    algorithmVersion: EXACT_MODEL_SENSITIVITY_ALGORITHM_VERSION,
    method: "exact-cell-conditioned-terminal-risk",
    historyHash: input.request.historyHash,
    hypothesisSetChecksum: input.request.hypothesisSet.checksum,
    quality: "Unavailable",
    eligibility: {
      eligible: false,
      code: input.code,
      detail: input.detail,
    },
    baseResult: input.baseResult,
    failedCell: input.failedCell,
    cells: input.cells,
    diagnostic: null,
  });
}

function conditionedHypotheses(input: {
  readonly request: ExactEndgameSearchInput;
  readonly hypotheses: readonly ExactInformationHypothesis[];
  readonly p2ModelId: BehaviorModelId;
  readonly p3ModelId: BehaviorModelId;
  readonly cellMass: number;
}) {
  const source = input.request.hypothesisSet;
  return createExactInformationHypothesisSet({
    historyHash: source.historyHash,
    sourceKind: "explicit-research",
    sourceChecksum: stableHash({
      schemaVersion: 1,
      algorithmVersion: EXACT_MODEL_SENSITIVITY_ALGORITHM_VERSION,
      parentHypothesisSetChecksum: source.checksum,
      p2ModelId: input.p2ModelId,
      p3ModelId: input.p3ModelId,
    }),
    supportKind: source.supportKind,
    supportWorldCount: source.supportWorldCount,
    behaviorConfigHash: source.behaviorConfigHash,
    hypotheses: input.hypotheses.map((hypothesis) => ({
      hypothesisId: hypothesis.hypothesisId,
      occurrenceIndex: hypothesis.occurrenceIndex,
      witnessId: hypothesis.witnessId,
      p2ModelId: hypothesis.p2ModelId,
      p3ModelId: hypothesis.p3ModelId,
      mass: hypothesis.mass / input.cellMass,
      currentHands: hypothesis.currentHands,
    })),
  });
}

/**
 * Re-solves every positive posterior P2/P3 model cell under the same exact
 * information-state semantics, then feeds those engine-produced terminal
 * risks into the advisory sensitivity diagnostic.
 */
export function analyzeExactModelSensitivity(
  request: ExactEndgameSearchInput,
): ExactModelSensitivityResult {
  const base = solveExactEndgame(request);
  if (base.quality === "Unavailable") {
    return ineligible({
      request,
      baseResult: base,
      code: base.eligibility.code,
      detail: base.eligibility.detail,
      failedCell: null,
      cells: [],
    });
  }
  const p2ModelIds = [
    ...new Set(
      request.hypothesisSet.hypotheses.map(
        (hypothesis) => hypothesis.p2ModelId,
      ),
    ),
  ].sort();
  const p3ModelIds = [
    ...new Set(
      request.hypothesisSet.hypotheses.map(
        (hypothesis) => hypothesis.p3ModelId,
      ),
    ),
  ].sort();
  const byCell = new Map<string, ExactInformationHypothesis[]>();
  for (const hypothesis of request.hypothesisSet.hypotheses) {
    const key = cellKey(hypothesis.p2ModelId, hypothesis.p3ModelId);
    const bucket = byCell.get(key) ?? [];
    bucket.push(hypothesis);
    byCell.set(key, bucket);
  }
  const actionKeys = base.actionValues.map((value) => value.actionKey).sort();
  const cells: ExactModelSensitivityCell[] = [];
  for (const p2ModelId of p2ModelIds) {
    for (const p3ModelId of p3ModelIds) {
      const hypotheses = byCell.get(cellKey(p2ModelId, p3ModelId));
      if (hypotheses === undefined || hypotheses.length === 0) {
        return ineligible({
          request,
          baseResult: base,
          code: "INCOMPLETE_ENUMERATION",
          detail:
            "Exact model sensitivity requires a complete positive rectangular model grid.",
          failedCell: { p2ModelId, p3ModelId },
          cells,
        });
      }
      const cellMass = hypotheses.reduce(
        (sum, hypothesis) => sum + hypothesis.mass,
        0,
      );
      const cellResult = solveExactEndgame({
        ...request,
        hypothesisSet: conditionedHypotheses({
          request,
          hypotheses,
          p2ModelId,
          p3ModelId,
          cellMass,
        }),
      });
      if (!cellResult.eligibility.eligible) {
        return ineligible({
          request,
          baseResult: base,
          code: cellResult.eligibility.code,
          detail: `Model cell ${p2ModelId}/${p3ModelId} was ineligible: ${cellResult.eligibility.detail}`,
          failedCell: { p2ModelId, p3ModelId },
          cells,
        });
      }
      const risksByAction = new Map(
        cellResult.actionValues.map((value) => [
          value.actionKey,
          value.userBhabhiRisk,
        ]),
      );
      if (
        risksByAction.size !== actionKeys.length ||
        actionKeys.some((actionKey) => !risksByAction.has(actionKey))
      ) {
        return ineligible({
          request,
          baseResult: base,
          code: "INCOMPLETE_ENUMERATION",
          detail: `Model cell ${p2ModelId}/${p3ModelId} did not evaluate the common root action set.`,
          failedCell: { p2ModelId, p3ModelId },
          cells,
        });
      }
      cells.push({
        p2ModelId,
        p3ModelId,
        posteriorWeight: cellMass,
        exactResultHash: cellResult.resultHash,
        actionRisks: actionKeys.map((actionKey) => ({
          actionKey,
          terminalRisk: risksByAction.get(actionKey) ?? Number.NaN,
        })),
      });
    }
  }
  const totalCellMass = cells.reduce(
    (sum, cell) => sum + cell.posteriorWeight,
    0,
  );
  const normalizedCells = cells.map((cell) => ({
    ...cell,
    posteriorWeight: cell.posteriorWeight / totalCellMass,
  }));
  const diagnostic = analyzeModelSensitivity({
    schemaVersion: 1,
    p2ModelIds,
    p3ModelIds,
    actionKeys,
    cells: normalizedCells,
  });
  return resultWithHash({
    schemaVersion: 1,
    algorithmVersion: EXACT_MODEL_SENSITIVITY_ALGORITHM_VERSION,
    method: "exact-cell-conditioned-terminal-risk",
    historyHash: request.historyHash,
    hypothesisSetChecksum: request.hypothesisSet.checksum,
    quality: "Exact",
    eligibility: { eligible: true },
    baseResult: base,
    cells: normalizedCells,
    diagnostic,
  });
}
