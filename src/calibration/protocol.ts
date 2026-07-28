import {
  STYLE_CELLS,
  deriveDealSeed,
  deriveStreamSeed,
  type EvaluationSplit,
} from "../evaluation/protocol";
import { stableHash } from "../events/stable-hash";
import { FITTABLE_STYLE_CELL_IDS } from "./fittable-style-cells";

export { FITTABLE_STYLE_CELL_IDS } from "./fittable-style-cells";

export const PHASE6_CALIBRATION_RUNNER_VERSION =
  "phase6-calibration-v2" as const;
export const PHASE6_CALIBRATION_SPLITS = ["dev", "train", "tune"] as const;
export type Phase6CalibrationSplit = (typeof PHASE6_CALIBRATION_SPLITS)[number];
export const PHASE6_CALIBRATION_CHECKPOINT_CLASSES = [
  "initial",
  "post-opening",
  "fixed-public-event",
  "post-thulla",
  "post-visible-pickup",
  "pre-opponent-choice",
] as const;
export type Phase6CalibrationCheckpointClass =
  (typeof PHASE6_CALIBRATION_CHECKPOINT_CLASSES)[number];
export type Phase6CalibrationCheckpointClassCounts = {
  readonly initial: number;
  readonly postOpening: number;
  readonly fixedPublicEvent: number;
  readonly postThulla: number;
  readonly postVisiblePickup: number;
  readonly preOpponentChoice: number;
};

export const DEVELOPMENT_STYLE_CELL_IDS = Object.freeze(
  STYLE_CELLS.map((cell) => cell.id),
);

export type Phase6CalibrationPlan = {
  readonly schemaVersion: 1;
  readonly runnerVersion: typeof PHASE6_CALIBRATION_RUNNER_VERSION;
  readonly protocolId: "eval-v1";
  readonly runId: string;
  readonly split: Phase6CalibrationSplit;
  readonly evidenceClass: "phase6-calibration-smoke";
  readonly evidenceEligible: false;
  readonly userPolicyId: "documented-basic";
  readonly styleCellIds: readonly string[];
  readonly baseIndexStart: number;
  readonly baseCount: number;
  readonly rotations: readonly (0 | 1 | 2)[];
  readonly replicate: 0;
  readonly opponentDecisionOrdinals: readonly number[];
  readonly fixedPublicEventOrdinals: readonly number[];
  readonly maximumPreActionCheckpointsPerGame: number;
  readonly maximumPostEventCheckpointsPerGame: number;
  readonly checkpointClasses: typeof PHASE6_CALIBRATION_CHECKPOINT_CLASSES;
  readonly hardWorldSamples: number;
  readonly conditionalProbabilityFloor: number;
  readonly queryFamilies: readonly [
    "card-owner",
    "current-void",
    "suit-length",
    "can-overtake",
    "joint",
    "conditional",
    "opponent-action",
  ];
  readonly behaviorProductionEnabled: false;
};

export type CalibrationScenarioSeed = {
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly replicate: 0;
  readonly deal: string;
  /**
   * Optional opened-manifest user-policy stream. Legacy Phase 6 schedules
   * omit it and retain their historic scenario-derived user seed.
   */
  readonly userPolicy?: string;
  readonly p2Policy: string;
  readonly p3Policy: string;
  readonly chance: string;
  readonly belief: string;
  readonly bootstrap: string;
};

export type Phase6CalibrationScenarioIdentity = {
  readonly scenarioId: string;
  readonly gameId: string;
  readonly calibrationClusterId: string;
};

function phase6Split(split: EvaluationSplit): Phase6CalibrationSplit {
  if (!PHASE6_CALIBRATION_SPLITS.some((candidate) => candidate === split)) {
    throw new Error(
      `Phase 6 calibration runner cannot open ${split}; qualification/final require a frozen Phase 8 manifest.`,
    );
  }
  return split as Phase6CalibrationSplit;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

export function createPhase6CalibrationPlan(input: {
  readonly runId: string;
  readonly split: EvaluationSplit;
  readonly baseCount?: number;
  readonly baseIndexStart?: number;
  readonly hardWorldSamples?: number;
}): Phase6CalibrationPlan {
  const split = phase6Split(input.split);
  const baseCount = input.baseCount ?? 1;
  const baseIndexStart = input.baseIndexStart ?? 0;
  const hardWorldSamples = input.hardWorldSamples ?? 64;
  positiveInteger(baseCount, "baseCount");
  positiveInteger(hardWorldSamples, "hardWorldSamples");
  if (!Number.isSafeInteger(baseIndexStart) || baseIndexStart < 0) {
    throw new RangeError("baseIndexStart must be a non-negative safe integer.");
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/u.test(input.runId)) {
    throw new Error("Calibration run ID is not filesystem-safe.");
  }

  const plan: Phase6CalibrationPlan = {
    schemaVersion: 1,
    runnerVersion: PHASE6_CALIBRATION_RUNNER_VERSION,
    protocolId: "eval-v1",
    runId: input.runId,
    split,
    evidenceClass: "phase6-calibration-smoke",
    evidenceEligible: false,
    userPolicyId: "documented-basic",
    styleCellIds:
      split === "dev"
        ? [...DEVELOPMENT_STYLE_CELL_IDS]
        : [...FITTABLE_STYLE_CELL_IDS],
    baseIndexStart,
    baseCount,
    rotations: [0, 1, 2],
    replicate: 0,
    opponentDecisionOrdinals: [2, 5, 8],
    fixedPublicEventOrdinals: [12, 24, 36],
    maximumPreActionCheckpointsPerGame: 6,
    maximumPostEventCheckpointsPerGame: 7,
    checkpointClasses: PHASE6_CALIBRATION_CHECKPOINT_CLASSES,
    hardWorldSamples,
    conditionalProbabilityFloor: 0.05,
    queryFamilies: [
      "card-owner",
      "current-void",
      "suit-length",
      "can-overtake",
      "joint",
      "conditional",
      "opponent-action",
    ],
    behaviorProductionEnabled: false,
  };
  return Object.freeze(plan);
}

/**
 * Scientific identities deliberately exclude the immutable artifact run label.
 * A rerun under a fresh runId therefore retains the same scenario, game, pair,
 * and prediction identities while the record envelope still records runId.
 */
export function phase6CalibrationScenarioIdentity(
  plan: Pick<Phase6CalibrationPlan, "protocolId" | "split" | "styleCellIds">,
  seed: Pick<
    CalibrationScenarioSeed,
    "styleCellId" | "baseIndex" | "rotation" | "replicate"
  >,
): Phase6CalibrationScenarioIdentity {
  const styleCellIndex = plan.styleCellIds.indexOf(seed.styleCellId);
  if (styleCellIndex < 0) {
    throw new Error(
      `Calibration identity received unscheduled style cell ${seed.styleCellId}.`,
    );
  }
  const scenarioId = `scenario:${stableHash({
    schemaVersion: 1,
    protocolId: plan.protocolId,
    split: plan.split,
    styleCellIndex,
    baseIndex: seed.baseIndex,
    rotation: seed.rotation,
    replicate: seed.replicate,
  })}`;
  return Object.freeze({
    scenarioId,
    gameId: stableHash({
      schemaVersion: 1,
      protocolId: plan.protocolId,
      split: plan.split,
      scenarioId,
    }),
    calibrationClusterId: `cluster:${stableHash({
      schemaVersion: 1,
      protocolId: plan.protocolId,
      split: plan.split,
      styleCellIndex,
      baseIndex: seed.baseIndex,
    })}`,
  });
}

export function phase6CalibrationPlanHash(plan: Phase6CalibrationPlan): string {
  return stableHash(plan);
}

export function phase6CalibrationScientificPlanHash(
  plan: Phase6CalibrationPlan,
): string {
  const scientificPlan: Record<string, unknown> = { ...plan };
  delete scientificPlan.runId;
  return stableHash(scientificPlan);
}

export function phase6CalibrationScheduleHash(
  plan: Phase6CalibrationPlan,
): string {
  return stableHash({
    schemaVersion: 1,
    protocolId: plan.protocolId,
    split: plan.split,
    userPolicyId: plan.userPolicyId,
    styleCellIds: plan.styleCellIds,
    baseIndexStart: plan.baseIndexStart,
    baseCount: plan.baseCount,
    rotations: plan.rotations,
    replicate: plan.replicate,
    opponentDecisionOrdinals: plan.opponentDecisionOrdinals,
    fixedPublicEventOrdinals: plan.fixedPublicEventOrdinals,
    maximumPreActionCheckpointsPerGame: plan.maximumPreActionCheckpointsPerGame,
    maximumPostEventCheckpointsPerGame: plan.maximumPostEventCheckpointsPerGame,
    checkpointClasses: plan.checkpointClasses,
    hardWorldSamples: plan.hardWorldSamples,
    conditionalProbabilityFloor: plan.conditionalProbabilityFloor,
    queryFamilies: plan.queryFamilies,
    rngAlgorithm: "splitmix64-counter-v1",
    seedDerivation: "eval-v1-sha256-roots-plus-keyed-counter-streams",
  });
}

export function expectedPhase6CalibrationGames(
  plan: Phase6CalibrationPlan,
): number {
  return plan.styleCellIds.length * plan.baseCount * plan.rotations.length;
}

export function calibrationScenarioSeeds(
  plan: Phase6CalibrationPlan,
): readonly CalibrationScenarioSeed[] {
  const values: CalibrationScenarioSeed[] = [];
  for (const styleCellId of plan.styleCellIds) {
    for (
      let baseIndex = plan.baseIndexStart;
      baseIndex < plan.baseIndexStart + plan.baseCount;
      baseIndex += 1
    ) {
      for (const rotation of plan.rotations) {
        const seedInput = {
          split: plan.split,
          cell: styleCellId,
          baseIndex,
          rotation,
          replicate: plan.replicate,
        } as const;
        values.push({
          styleCellId,
          baseIndex,
          rotation,
          replicate: plan.replicate,
          deal: deriveDealSeed(plan.split, baseIndex),
          p2Policy: deriveStreamSeed({
            ...seedInput,
            stream: "p2-policy",
          }),
          p3Policy: deriveStreamSeed({
            ...seedInput,
            stream: "p3-policy",
          }),
          chance: deriveStreamSeed({
            ...seedInput,
            stream: "chance",
          }),
          belief: deriveStreamSeed({
            ...seedInput,
            stream: "belief",
          }),
          bootstrap: deriveStreamSeed({
            ...seedInput,
            stream: "bootstrap",
          }),
        });
      }
    }
  }
  if (values.length !== expectedPhase6CalibrationGames(plan)) {
    throw new Error("Calibration seed schedule has the wrong cardinality.");
  }
  return Object.freeze(values);
}
