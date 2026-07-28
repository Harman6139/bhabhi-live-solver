import { getBaselinePolicy } from "../agents/policies";
import type { GameEvent } from "../events/game-events";
import { stableHash } from "../events/stable-hash";
import type { GameTimeline } from "../events/timeline";
import {
  buildBehaviorBelief,
  type BehaviorBelief,
} from "../inference/behavior-belief";
import { buildHardBelief } from "../inference/belief";
import type { HardBelief } from "../inference/types";
import {
  applyExactHandEvent,
  createExactHandState,
  type ExactHandState,
} from "../rules/exact-hand-transition";
import {
  createSeededDeal,
  simulateCompleteGame,
  type SimulationGameResult,
} from "../simulator/game";
import { STYLE_CELLS } from "../evaluation/protocol";
import {
  selectPhase6CalibrationCheckpoints,
  type CalibrationCheckpoint,
} from "./checkpoints";
import {
  calibrationFailureRecordSchema,
  calibrationSeedRecordSchema,
  type CalibrationFailureRecord,
  type CalibrationPredictionRecord,
  type CalibrationSeedRecord,
  type CalibrationTruthRecord,
} from "./artifact-schema";
import {
  generateCalibrationPredictions,
  type CalibrationCheckpointMetadata,
} from "./predictions";
import { terminalClusterId, type EvalOnlyScoredObservation } from "./types";
import {
  calibrationScenarioSeeds,
  phase6CalibrationScenarioIdentity,
  phase6CalibrationScientificPlanHash,
  type CalibrationScenarioSeed,
  type Phase6CalibrationCheckpointClassCounts,
  type Phase6CalibrationPlan,
} from "./protocol";
import { scoreCalibrationPredictions } from "./truth-scorer";

export type Phase6CalibrationRunResult = {
  readonly plan: Phase6CalibrationPlan;
  readonly seeds: readonly CalibrationSeedRecord[];
  readonly predictions: readonly CalibrationPredictionRecord[];
  readonly truths: readonly CalibrationTruthRecord[];
  readonly scoredObservations: readonly EvalOnlyScoredObservation[];
  readonly skippedConditionalPairIds: readonly string[];
  readonly failures: readonly CalibrationFailureRecord[];
  readonly attemptedGames: number;
  readonly completedGames: number;
  readonly attemptedCheckpoints: number;
  readonly completedCheckpoints: number;
  readonly checkpointClassCounts: Phase6CalibrationCheckpointClassCounts;
};

export const PHASE6_CALIBRATION_FEATURE_BUNDLE_HASH = stableHash({
  schemaVersion: 1,
  featureBundle: [
    "card-owner",
    "current-void",
    "suit-length",
    "can-overtake",
    "joint-overtake-and-void",
    "conditional-overtake-given-void",
    "full-legal-opponent-action",
  ],
});

export function phase6CalibrationQueryPlanHash(
  plan: Phase6CalibrationPlan,
): string {
  return stableHash({
    schemaVersion: 1,
    queryFamilies: plan.queryFamilies,
    conditionalProbabilityFloor: plan.conditionalProbabilityFloor,
    opponentDecisionOrdinals: plan.opponentDecisionOrdinals,
    fixedPublicEventOrdinals: plan.fixedPublicEventOrdinals,
    maximumPreActionCheckpointsPerGame: plan.maximumPreActionCheckpointsPerGame,
    maximumPostEventCheckpointsPerGame: plan.maximumPostEventCheckpointsPerGame,
    checkpointTiming: "prequential-mixed-frozen-checkpoints",
  });
}

function seedRecord(
  plan: Phase6CalibrationPlan,
  seed: CalibrationScenarioSeed,
): CalibrationSeedRecord {
  const identity = phase6CalibrationScenarioIdentity(plan, seed);
  return calibrationSeedRecordSchema.parse({
    schemaVersion: 1,
    protocolId: "eval-v1",
    recordType: "calibration-seed",
    runId: plan.runId,
    split: plan.split,
    gameId: identity.gameId,
    scenarioId: identity.scenarioId,
    calibrationClusterId: identity.calibrationClusterId,
    styleCellId: seed.styleCellId,
    baseIndex: seed.baseIndex,
    rotation: seed.rotation,
    replicate: seed.replicate,
    seeds: {
      deal: seed.deal,
      p2Policy: seed.p2Policy,
      p3Policy: seed.p3Policy,
      chance: seed.chance,
      belief: seed.belief,
      bootstrap: seed.bootstrap,
    },
  });
}

function timelinePrefix(
  events: readonly GameEvent[],
  eventIndex: number,
): GameTimeline {
  if (
    !Number.isSafeInteger(eventIndex) ||
    eventIndex < 1 ||
    eventIndex > events.length
  ) {
    throw new RangeError(
      `Calibration checkpoint event index ${eventIndex.toString()} is outside the simulated history.`,
    );
  }
  const prefix = events.slice(0, eventIndex);
  return {
    schemaVersion: 1,
    events: prefix,
    cursor: prefix.length,
    orphanedEvents: [],
  };
}

function exactPrefixState(
  result: SimulationGameResult,
  eventIndex: number,
): ExactHandState {
  let state = createExactHandState(result.deal, result.rules);
  for (let index = 1; index < eventIndex; index += 1) {
    const event = result.events[index];
    if (event === undefined || event.type === "game-created") {
      throw new Error(
        `Calibration exact replay is missing event ${index.toString()}.`,
      );
    }
    state = applyExactHandEvent(state, event, index, "full");
  }
  return state;
}

function selectedCheckpoints(
  result: SimulationGameResult,
  plan: Phase6CalibrationPlan,
): readonly CalibrationCheckpoint[] {
  const selected = selectPhase6CalibrationCheckpoints(result.events);
  const post = selected
    .filter((checkpoint) => checkpoint.timing === "post-event")
    .slice(0, plan.maximumPostEventCheckpointsPerGame);
  const pre = selected
    .filter((checkpoint) => checkpoint.timing === "pre-action")
    .filter((checkpoint) =>
      (() => {
        const match = /pre-opponent-choice-(?:p2|p3)-([0-9]+)/u.exec(
          checkpoint.id,
        );
        return (
          match?.[1] !== undefined &&
          plan.opponentDecisionOrdinals.includes(Number(match[1]))
        );
      })(),
    )
    .slice(0, plan.maximumPreActionCheckpointsPerGame);
  return Object.freeze(
    [...post, ...pre].sort(
      (left, right) =>
        left.eventIndex - right.eventIndex || left.id.localeCompare(right.id),
    ),
  );
}

function buildBeliefs(
  timeline: GameTimeline,
  seed: CalibrationScenarioSeed,
  eventIndex: number,
  plan: Phase6CalibrationPlan,
): {
  readonly hard: HardBelief;
  readonly behavior: BehaviorBelief;
} {
  const hard = buildHardBelief(timeline, {
    seed: stableHash({
      schemaVersion: 1,
      calibrationBeliefSeed: seed.belief,
      eventIndex,
    }),
    sampleCount: plan.hardWorldSamples,
    forceSampling: true,
  });
  return {
    hard,
    behavior: buildBehaviorBelief(timeline, hard),
  };
}

function checkpointMetadata(
  plan: Phase6CalibrationPlan,
  seed: CalibrationScenarioSeed,
  checkpoint: CalibrationCheckpoint,
  exactState: ExactHandState,
): CalibrationCheckpointMetadata {
  const identity = phase6CalibrationScenarioIdentity(plan, seed);
  return {
    runId: plan.runId,
    split: plan.split,
    evidenceClass: plan.evidenceClass,
    gameId: identity.gameId,
    scenarioId: identity.scenarioId,
    calibrationClusterId: identity.calibrationClusterId,
    checkpointId: checkpoint.id,
    checkpointEventIndex: checkpoint.eventIndex,
    checkpointTiming: checkpoint.timing,
    stateVersion: exactState.publicState.appliedEventCount,
    featureBundleHash: PHASE6_CALIBRATION_FEATURE_BUNDLE_HASH,
    queryPlanHash: phase6CalibrationQueryPlanHash(plan),
    seedId: stableHash({
      schemaVersion: 1,
      belief: seed.belief,
      eventIndex: checkpoint.eventIndex,
    }),
  };
}

function emptyCheckpointClassCounts(): {
  -readonly [Key in keyof Phase6CalibrationCheckpointClassCounts]: number;
} {
  return {
    initial: 0,
    postOpening: 0,
    fixedPublicEvent: 0,
    postThulla: 0,
    postVisiblePickup: 0,
    preOpponentChoice: 0,
  };
}

function addCheckpointClassCounts(
  counts: ReturnType<typeof emptyCheckpointClassCounts>,
  checkpoint: CalibrationCheckpoint,
): void {
  for (const checkpointClass of checkpoint.checkpointClass) {
    if (checkpointClass === "initial") {
      counts.initial += 1;
    } else if (checkpointClass === "post-opening") {
      counts.postOpening += 1;
    } else if (checkpointClass === "fixed-public-event") {
      counts.fixedPublicEvent += 1;
    } else if (checkpointClass === "post-thulla") {
      counts.postThulla += 1;
    } else if (checkpointClass === "post-visible-pickup") {
      counts.postVisiblePickup += 1;
    } else {
      counts.preOpponentChoice += 1;
    }
  }
}

function failureRecord(input: {
  readonly plan: Phase6CalibrationPlan;
  readonly gameId: string;
  readonly stateId: string | null;
  readonly stage: string;
  readonly kind: CalibrationFailureRecord["kind"];
  readonly error: unknown;
}): CalibrationFailureRecord {
  const errorName =
    input.error instanceof Error ? input.error.name : "UnknownError";
  const message =
    input.error instanceof Error
      ? input.error.message
      : "Unknown non-Error calibration failure.";
  const errorCode =
    input.error !== null &&
    typeof input.error === "object" &&
    "code" in input.error &&
    typeof input.error.code === "string"
      ? input.error.code
      : null;
  const deterministicFailureHash = stableHash({
    schemaVersion: 1,
    gameId: input.gameId,
    stateId: input.stateId,
    stage: input.stage,
    kind: input.kind,
    errorName,
    errorCode,
    message,
  });
  return calibrationFailureRecordSchema.parse({
    schemaVersion: 1,
    protocolId: "eval-v1",
    recordType: "calibration-failure",
    runId: input.plan.runId,
    split: input.plan.split,
    failureId: `${input.gameId}/${deterministicFailureHash}`,
    gameId: input.gameId,
    stateId: input.stateId,
    stage: input.stage,
    kind: input.kind,
    errorName,
    errorCode,
    message,
    deterministicFailureHash,
  });
}

function simulateScenario(
  plan: Phase6CalibrationPlan,
  seed: CalibrationScenarioSeed,
): SimulationGameResult {
  const style = STYLE_CELLS.find(
    (candidate) => candidate.id === seed.styleCellId,
  );
  if (style === undefined) {
    throw new Error(`Unknown calibration style cell ${seed.styleCellId}.`);
  }
  const identity = phase6CalibrationScenarioIdentity(plan, seed);
  const deal = createSeededDeal(seed.deal, seed.rotation);
  return simulateCompleteGame({
    gameId: identity.gameId,
    rotation: seed.rotation,
    deal,
    seeds: {
      deal: seed.deal,
      policy: {
        user: stableHash({
          schemaVersion: 1,
          scenarioId: identity.scenarioId,
          stream: "user-policy",
        }),
        p2: seed.p2Policy,
        p3: seed.p3Policy,
      },
      chance: seed.chance,
    },
    policies: {
      user: getBaselinePolicy(plan.userPolicyId),
      p2: getBaselinePolicy(style.p2),
      p3: getBaselinePolicy(style.p3),
    },
  });
}

export function runPhase6Calibration(
  plan: Phase6CalibrationPlan,
): Phase6CalibrationRunResult {
  const seeds: CalibrationSeedRecord[] = [];
  const predictions: CalibrationPredictionRecord[] = [];
  const truths: CalibrationTruthRecord[] = [];
  const scoredObservations: EvalOnlyScoredObservation[] = [];
  const skippedConditionalPairIds: string[] = [];
  const failures: CalibrationFailureRecord[] = [];
  let completedGames = 0;
  let attemptedCheckpoints = 0;
  let completedCheckpoints = 0;
  const checkpointClassCounts = emptyCheckpointClassCounts();
  const planHash = phase6CalibrationScientificPlanHash(plan);
  const scenarioSeeds = calibrationScenarioSeeds(plan);

  for (const scenarioSeed of scenarioSeeds) {
    const identity = phase6CalibrationScenarioIdentity(plan, scenarioSeed);
    seeds.push(seedRecord(plan, scenarioSeed));
    let result: SimulationGameResult;
    try {
      result = simulateScenario(plan, scenarioSeed);
      completedGames += 1;
    } catch (error) {
      failures.push(
        failureRecord({
          plan,
          gameId: identity.gameId,
          stateId: null,
          stage: "simulate-complete-game",
          kind: "simulation",
          error,
        }),
      );
      continue;
    }

    const style = STYLE_CELLS.find(
      (candidate) => candidate.id === scenarioSeed.styleCellId,
    );
    if (style === undefined) {
      throw new Error("A simulated calibration style disappeared.");
    }
    for (const selectedCheckpoint of selectedCheckpoints(result, plan)) {
      attemptedCheckpoints += 1;
      addCheckpointClassCounts(checkpointClassCounts, selectedCheckpoint);
      const timeline = timelinePrefix(
        result.events,
        selectedCheckpoint.eventIndex,
      );
      let stateId: string | null = null;
      try {
        const exactState = exactPrefixState(
          result,
          selectedCheckpoint.eventIndex,
        );
        stateId = stableHash({
          schemaVersion: 1,
          publicState: exactState.publicState,
        });
        const beliefs = buildBeliefs(
          timeline,
          scenarioSeed,
          selectedCheckpoint.eventIndex,
          plan,
        );
        const checkpoint = checkpointMetadata(
          plan,
          scenarioSeed,
          selectedCheckpoint,
          exactState,
        );
        const checkpointPredictions = generateCalibrationPredictions({
          timeline,
          hardBelief: beliefs.hard,
          behaviorBelief: beliefs.behavior,
          checkpoint,
          config: {
            conditionalProbabilityFloor: plan.conditionalProbabilityFloor,
          },
        });
        const scored = scoreCalibrationPredictions({
          predictions: checkpointPredictions,
          exactState,
          actualNextEvent: selectedCheckpoint.actualNextEvent,
          trueOpponentModels: {
            p2: style.p2,
            p3: style.p3,
          },
          terminalClusterId: terminalClusterId(
            plan.split,
            scenarioSeed.baseIndex,
          ),
        });
        predictions.push(...checkpointPredictions);
        truths.push(...scored.truthRecords);
        scoredObservations.push(...scored.scoredObservations);
        skippedConditionalPairIds.push(...scored.skippedConditionalPairIds);
        completedCheckpoints += 1;
      } catch (error) {
        failures.push(
          failureRecord({
            plan,
            gameId: identity.gameId,
            stateId,
            stage: `checkpoint/${selectedCheckpoint.eventIndex.toString()}/${planHash}`,
            kind: "prediction",
            error,
          }),
        );
      }
    }
  }

  return Object.freeze({
    plan: structuredClone(plan),
    seeds: Object.freeze(seeds),
    predictions: Object.freeze(predictions),
    truths: Object.freeze(truths),
    scoredObservations: Object.freeze(scoredObservations),
    skippedConditionalPairIds: Object.freeze(skippedConditionalPairIds),
    failures: Object.freeze(failures),
    attemptedGames: scenarioSeeds.length,
    completedGames,
    attemptedCheckpoints,
    completedCheckpoints,
    checkpointClassCounts: Object.freeze(checkpointClassCounts),
  });
}
