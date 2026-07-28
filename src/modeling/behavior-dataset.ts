import { createActorObservation } from "../agents/observation";
import { getBaselinePolicy } from "../agents/policies";
import type { OpponentSeat } from "../domain/seats";
import { stableHash } from "../events/stable-hash";
import {
  activeTimelineEvents,
  replayTimeline,
  type GameTimeline,
} from "../events/timeline";
import { buildHardBelief } from "../inference/belief";
import {
  BEHAVIOR_MODEL_IDS,
  allBehaviorModelDistributions,
  behaviorActionKey,
  enumerateBehaviorActions,
  type BehaviorAction,
  type BehaviorModelId,
} from "../inference/behavior-models";
import {
  EVALUATION_PROTOCOL_ID,
  STYLE_CELLS,
  deriveDealSeed,
  deriveStreamSeed,
  type StyleCell,
} from "../evaluation/protocol";
import { FITTABLE_STYLE_CELL_IDS } from "../calibration/protocol";
import { projectActiveSimulationTimelineForUser } from "../simulator/evaluation-user-policy";
import {
  DEFAULT_MAX_GAME_EVENTS,
  simulateCompleteGame,
  type SimulationDecision,
} from "../simulator/game";
import {
  behaviorFitObservationSchema,
  behaviorWorldEstimateSchema,
  type BehaviorFitObservation,
  type BehaviorFitSplit,
  type BehaviorWorldEstimate,
} from "./behavior-fit";

export const BEHAVIOR_DATASET_ALGORITHM_VERSION =
  "phase8-public-prequential-dataset-v1" as const;
export const BEHAVIOR_DATASET_RELEASE_BASE_COUNT = 64;
export const BEHAVIOR_DATASET_DECISION_ORDINALS = [2, 5, 8] as const;
export const BEHAVIOR_DATASET_WORLD_COUNTS = [4, 16, 64] as const;

const opponentSeats = ["p2", "p3"] as const;

export type BehaviorDatasetPlan = {
  readonly schemaVersion: 1;
  readonly algorithmVersion: typeof BEHAVIOR_DATASET_ALGORITHM_VERSION;
  readonly protocolId: typeof EVALUATION_PROTOCOL_ID;
  readonly runId: string;
  readonly split: BehaviorFitSplit;
  readonly evidenceEligible: boolean;
  readonly styleCellIds: readonly string[];
  readonly baseIndexStart: number;
  readonly baseCount: number;
  readonly rotations: readonly (0 | 1 | 2)[];
  readonly replicate: 0;
  readonly opponentDecisionOrdinals: readonly number[];
  readonly worldCounts: readonly number[];
  readonly eventCap: number;
};

export type BehaviorDatasetGameAudit = {
  readonly gameId: string;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly opponentDecisions: number;
  readonly scheduledDecisionCheckpoints: number;
  readonly discretionaryObservations: number;
  readonly forcedScheduledDecisions: number;
  readonly publicDatasetHash: string;
};

export type BehaviorDatasetFailure = {
  readonly gameId: string;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly stage: "simulation" | "public-observation";
  readonly name: string;
  readonly message: string;
};

export type BehaviorFitDataset = {
  readonly plan: BehaviorDatasetPlan;
  readonly scheduleHash: string;
  readonly observations: readonly BehaviorFitObservation[];
  readonly games: readonly BehaviorDatasetGameAudit[];
  readonly failures: readonly BehaviorDatasetFailure[];
};

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

function validateUniquePositiveIntegers(
  values: readonly number[],
  label: string,
): readonly number[] {
  if (values.length === 0) {
    throw new Error(`${label} cannot be empty.`);
  }
  for (const value of values) {
    positiveInteger(value, label);
  }
  const sorted = [...new Set(values)].sort((left, right) => left - right);
  if (sorted.length !== values.length) {
    throw new Error(`${label} cannot contain duplicates.`);
  }
  return Object.freeze(sorted);
}

export function createBehaviorDatasetPlan(input: {
  readonly runId: string;
  readonly split: BehaviorFitSplit;
  readonly evidenceEligible?: boolean;
  readonly baseCount?: number;
  readonly baseIndexStart?: number;
  readonly styleCellIds?: readonly string[];
  readonly rotations?: readonly (0 | 1 | 2)[];
  readonly opponentDecisionOrdinals?: readonly number[];
  readonly worldCounts?: readonly number[];
  readonly eventCap?: number;
}): BehaviorDatasetPlan {
  if (!/^[a-z0-9][a-z0-9._-]{2,95}$/u.test(input.runId)) {
    throw new Error("Behavior dataset runId is not filesystem-safe.");
  }
  const evidenceEligible = input.evidenceEligible ?? false;
  const baseIndexStart = input.baseIndexStart ?? 0;
  const baseCount =
    input.baseCount ??
    (evidenceEligible ? BEHAVIOR_DATASET_RELEASE_BASE_COUNT : 1);
  const styleCellIds = [
    ...(input.styleCellIds ?? FITTABLE_STYLE_CELL_IDS),
  ].sort(compareText);
  const rotations = [...(input.rotations ?? [0, 1, 2])].sort(
    (left, right) => left - right,
  );
  const opponentDecisionOrdinals = validateUniquePositiveIntegers(
    input.opponentDecisionOrdinals ?? BEHAVIOR_DATASET_DECISION_ORDINALS,
    "opponentDecisionOrdinals",
  );
  const worldCounts = validateUniquePositiveIntegers(
    input.worldCounts ?? BEHAVIOR_DATASET_WORLD_COUNTS,
    "worldCounts",
  );
  const eventCap = input.eventCap ?? DEFAULT_MAX_GAME_EVENTS;
  positiveInteger(baseCount, "baseCount");
  positiveInteger(eventCap, "eventCap");
  if (!Number.isSafeInteger(baseIndexStart) || baseIndexStart < 0) {
    throw new RangeError("baseIndexStart must be a non-negative safe integer.");
  }
  if (
    styleCellIds.length === 0 ||
    new Set(styleCellIds).size !== styleCellIds.length ||
    styleCellIds.some((id) => !FITTABLE_STYLE_CELL_IDS.includes(id))
  ) {
    throw new Error(
      "Behavior datasets accept unique fittable style cells c01-c15 only.",
    );
  }
  if (rotations.length === 0 || new Set(rotations).size !== rotations.length) {
    throw new Error("Behavior dataset rotations must be unique and non-empty.");
  }
  if (rotations.some((rotation) => ![0, 1, 2].includes(rotation))) {
    throw new Error("Behavior dataset rotations must be 0, 1, or 2.");
  }
  if (evidenceEligible) {
    if (
      baseIndexStart !== 0 ||
      baseCount !== BEHAVIOR_DATASET_RELEASE_BASE_COUNT ||
      stableHash([...styleCellIds].sort(compareText)) !==
        stableHash([...FITTABLE_STYLE_CELL_IDS].sort(compareText)) ||
      stableHash([...rotations].sort()) !== stableHash([0, 1, 2]) ||
      stableHash(opponentDecisionOrdinals) !==
        stableHash(BEHAVIOR_DATASET_DECISION_ORDINALS) ||
      stableHash(worldCounts) !== stableHash(BEHAVIOR_DATASET_WORLD_COUNTS)
    ) {
      throw new Error(
        "Evidence-eligible behavior data requires base 0, exactly 64 bases, all 15 fittable cells, three rotations, and the frozen ordinal/world-count grids.",
      );
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    algorithmVersion: BEHAVIOR_DATASET_ALGORITHM_VERSION,
    protocolId: EVALUATION_PROTOCOL_ID,
    runId: input.runId,
    split: input.split,
    evidenceEligible,
    styleCellIds: Object.freeze(styleCellIds),
    baseIndexStart,
    baseCount,
    rotations: Object.freeze(rotations),
    replicate: 0,
    opponentDecisionOrdinals,
    worldCounts,
    eventCap,
  });
}

export function behaviorDatasetScheduleHash(plan: BehaviorDatasetPlan): string {
  return stableHash({
    schemaVersion: 1,
    algorithmVersion: plan.algorithmVersion,
    protocolId: plan.protocolId,
    split: plan.split,
    styleCellIds: plan.styleCellIds,
    baseIndexStart: plan.baseIndexStart,
    baseCount: plan.baseCount,
    rotations: plan.rotations,
    replicate: plan.replicate,
    opponentDecisionOrdinals: plan.opponentDecisionOrdinals,
    worldCounts: plan.worldCounts,
    eventCap: plan.eventCap,
    seedDerivation: "eval-v1-sha256-roots-plus-keyed-counter-streams",
  });
}

export function expectedBehaviorDatasetGames(
  plan: BehaviorDatasetPlan,
): number {
  return plan.styleCellIds.length * plan.baseCount * plan.rotations.length;
}

function requireStyleCell(id: string): StyleCell {
  const cell = STYLE_CELLS.find((candidate) => candidate.id === id);
  if (cell === undefined) {
    throw new Error(`Unknown style cell ${id}.`);
  }
  return cell;
}

function scenarioSeeds(input: {
  readonly split: BehaviorFitSplit;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
}): Readonly<{
  deal: string;
  userPolicy: string;
  p2Policy: string;
  p3Policy: string;
  chance: string;
  belief: string;
}> {
  const common = {
    split: input.split,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
    replicate: 0,
  } as const;
  return {
    deal: deriveDealSeed(input.split, input.baseIndex),
    userPolicy: deriveStreamSeed({
      ...common,
      stream: "rollout",
      cell: input.styleCellId,
    }),
    p2Policy: deriveStreamSeed({
      ...common,
      stream: "p2-policy",
      cell: input.styleCellId,
    }),
    p3Policy: deriveStreamSeed({
      ...common,
      stream: "p3-policy",
      cell: input.styleCellId,
    }),
    chance: deriveStreamSeed({
      ...common,
      stream: "chance",
      cell: input.styleCellId,
    }),
    belief: deriveStreamSeed({
      ...common,
      stream: "belief",
      cell: "solver-style-neutral",
    }),
  };
}

function observedBehaviorAction(decision: SimulationDecision): BehaviorAction {
  if (decision.actionKind === "play-card" && decision.chosenCard !== null) {
    return { kind: "play-card", card: decision.chosenCard };
  }
  if (
    decision.actionKind === "take-hand" &&
    decision.chosenTakeTarget !== null
  ) {
    return { kind: "take-hand", target: decision.chosenTakeTarget };
  }
  throw new Error("Simulation decision has no matching observed action.");
}

function prefixTimeline(
  events: Parameters<typeof projectActiveSimulationTimelineForUser>[0],
  eventIndex: number,
): GameTimeline {
  return projectActiveSimulationTimelineForUser(events.slice(0, eventIndex));
}

type MutableFeature = {
  uniformProbability: number;
  preferredProbability: number;
};

function emptyFeatureTotals(): Record<BehaviorModelId, MutableFeature> {
  return Object.fromEntries(
    BEHAVIOR_MODEL_IDS.map((modelId) => [
      modelId,
      { uniformProbability: 0, preferredProbability: 0 },
    ]),
  ) as Record<BehaviorModelId, MutableFeature>;
}

function worldEstimate(input: {
  readonly timeline: GameTimeline;
  readonly seat: OpponentSeat;
  readonly decisionOrdinal: number;
  readonly observedAction: BehaviorAction;
  readonly worlds: ReturnType<typeof buildHardBelief>["worlds"];
  readonly worldCount: number;
}): BehaviorWorldEstimate {
  const replay = replayTimeline(input.timeline);
  const events = activeTimelineEvents(input.timeline);
  const observedKey = behaviorActionKey(input.observedAction);
  const totals = emptyFeatureTotals();
  for (const world of input.worlds.slice(0, input.worldCount)) {
    const observation = createActorObservation(
      {
        publicState: replay.state,
        exactHands: world.currentHands,
      },
      input.seat,
      input.decisionOrdinal,
      events,
    );
    const legalKeys = new Set(
      enumerateBehaviorActions(observation).map(behaviorActionKey),
    );
    if (!legalKeys.has(observedKey)) {
      continue;
    }
    const distributions = allBehaviorModelDistributions(observation);
    for (const modelId of BEHAVIOR_MODEL_IDS) {
      const feature = totals[modelId];
      const distribution = distributions[modelId];
      feature.uniformProbability +=
        distribution.probabilities.find(
          (entry) => entry.actionKey === observedKey,
        )?.probability ?? 0;
      feature.preferredProbability +=
        modelId === "random"
          ? 0
          : Number(distribution.preferredActionKey === observedKey);
    }
  }
  return behaviorWorldEstimateSchema.parse({
    worldCount: input.worldCount,
    modelFeatures: Object.fromEntries(
      BEHAVIOR_MODEL_IDS.map((modelId) => {
        const feature = totals[modelId];
        return [
          modelId,
          {
            uniformProbability: feature.uniformProbability / input.worldCount,
            preferredProbability:
              feature.preferredProbability / input.worldCount,
          },
        ];
      }),
    ),
  });
}

function observationForDecision(input: {
  readonly plan: BehaviorDatasetPlan;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly gameId: string;
  readonly events: Parameters<typeof projectActiveSimulationTimelineForUser>[0];
  readonly decision: SimulationDecision;
  readonly beliefSeed: string;
}): BehaviorFitObservation | null {
  const decision = input.decision;
  if (decision.seat !== "p2" && decision.seat !== "p3") {
    return null;
  }
  if (!input.plan.opponentDecisionOrdinals.includes(decision.decisionOrdinal)) {
    return null;
  }
  if (decision.legalCards.length + decision.legalTakeTargets.length <= 1) {
    return null;
  }
  const timeline = prefixTimeline(input.events, decision.eventIndex);
  const replay = replayTimeline(timeline);
  if (
    replay.state.turn !== decision.seat ||
    stableHash(replay.state) !== decision.publicStateHashBefore
  ) {
    throw new Error("Public decision prefix does not match simulator audit.");
  }
  const maximumWorldCount = Math.max(...input.plan.worldCounts);
  const hardBelief = buildHardBelief(timeline, {
    seed: input.beliefSeed,
    sampleCount: maximumWorldCount,
    forceSampling: true,
  });
  const observedAction = observedBehaviorAction(decision);
  const actionKey = behaviorActionKey(observedAction);
  return behaviorFitObservationSchema.parse({
    schemaVersion: 1,
    observationId: stableHash({
      schemaVersion: 1,
      algorithmVersion: input.plan.algorithmVersion,
      split: input.plan.split,
      styleCellId: input.styleCellId,
      baseIndex: input.baseIndex,
      rotation: input.rotation,
      seat: decision.seat,
      decisionOrdinal: decision.decisionOrdinal,
      publicHistoryHash: replay.semanticHash,
      publicStateHash: stableHash(replay.state),
      actionKey,
    }),
    split: input.plan.split,
    styleCellId: input.styleCellId,
    sequenceId: `${input.gameId}/${decision.seat}`,
    seat: decision.seat,
    decisionOrdinal: decision.decisionOrdinal,
    worldEstimates: input.plan.worldCounts.map((worldCount) =>
      worldEstimate({
        timeline,
        seat: decision.seat as OpponentSeat,
        decisionOrdinal: decision.decisionOrdinal,
        observedAction,
        worlds: hardBelief.worlds,
        worldCount,
      }),
    ),
  });
}

export function runBehaviorFitDataset(input: {
  readonly plan: BehaviorDatasetPlan;
  readonly onProgress?: (progress: {
    readonly attemptedGames: number;
    readonly expectedGames: number;
    readonly observations: number;
    readonly failures: number;
  }) => void;
}): BehaviorFitDataset {
  const observations: BehaviorFitObservation[] = [];
  const games: BehaviorDatasetGameAudit[] = [];
  const failures: BehaviorDatasetFailure[] = [];
  const expectedGames = expectedBehaviorDatasetGames(input.plan);
  let attemptedGames = 0;

  for (
    let baseIndex = input.plan.baseIndexStart;
    baseIndex < input.plan.baseIndexStart + input.plan.baseCount;
    baseIndex += 1
  ) {
    for (const styleCellId of input.plan.styleCellIds) {
      const cell = requireStyleCell(styleCellId);
      for (const rotation of input.plan.rotations) {
        const gameId = stableHash({
          schemaVersion: 1,
          algorithmVersion: input.plan.algorithmVersion,
          split: input.plan.split,
          styleCellId,
          baseIndex,
          rotation,
        });
        const coordinates = { styleCellId, baseIndex, rotation };
        const seeds = scenarioSeeds({
          split: input.plan.split,
          ...coordinates,
        });
        attemptedGames += 1;
        try {
          const result = simulateCompleteGame({
            gameId,
            rotation,
            seeds: {
              deal: seeds.deal,
              policy: {
                user: seeds.userPolicy,
                p2: seeds.p2Policy,
                p3: seeds.p3Policy,
              },
              chance: seeds.chance,
            },
            policies: {
              user: getBaselinePolicy("documented-basic"),
              p2: getBaselinePolicy(cell.p2),
              p3: getBaselinePolicy(cell.p3),
            },
            maxEvents: input.plan.eventCap,
          });
          const scheduled = result.decisions.filter(
            (decision) =>
              (decision.seat === "p2" || decision.seat === "p3") &&
              input.plan.opponentDecisionOrdinals.includes(
                decision.decisionOrdinal,
              ),
          );
          let discretionaryObservations = 0;
          for (const decision of scheduled) {
            try {
              const observation = observationForDecision({
                plan: input.plan,
                ...coordinates,
                gameId,
                events: result.events,
                decision,
                beliefSeed: seeds.belief,
              });
              if (observation !== null) {
                observations.push(observation);
                discretionaryObservations += 1;
              }
            } catch (error) {
              failures.push({
                gameId,
                ...coordinates,
                stage: "public-observation",
                name: error instanceof Error ? error.name : "UnknownError",
                message:
                  error instanceof Error ? error.message : "Unknown failure.",
              });
            }
          }
          const gameObservations = observations.filter((observation) =>
            observation.sequenceId.startsWith(`${gameId}/`),
          );
          games.push({
            gameId,
            ...coordinates,
            opponentDecisions: result.decisions.filter((decision) =>
              opponentSeats.includes(decision.seat as OpponentSeat),
            ).length,
            scheduledDecisionCheckpoints: scheduled.length,
            discretionaryObservations,
            forcedScheduledDecisions:
              scheduled.length - discretionaryObservations,
            publicDatasetHash: stableHash(
              [...gameObservations].sort((left, right) =>
                left.observationId.localeCompare(right.observationId),
              ),
            ),
          });
        } catch (error) {
          failures.push({
            gameId,
            ...coordinates,
            stage: "simulation",
            name: error instanceof Error ? error.name : "UnknownError",
            message:
              error instanceof Error ? error.message : "Unknown failure.",
          });
        }
        input.onProgress?.({
          attemptedGames,
          expectedGames,
          observations: observations.length,
          failures: failures.length,
        });
      }
    }
  }
  if (
    attemptedGames !== expectedGames ||
    games.length +
      failures.filter((failure) => failure.stage === "simulation").length !==
      expectedGames
  ) {
    throw new Error(
      "Behavior dataset runner silently omitted a scheduled game.",
    );
  }
  const orderedObservations = [...observations].sort((left, right) =>
    left.observationId.localeCompare(right.observationId),
  );
  if (
    new Set(orderedObservations.map((observation) => observation.observationId))
      .size !== orderedObservations.length
  ) {
    throw new Error("Behavior dataset contains duplicate observation IDs.");
  }
  return Object.freeze({
    plan: input.plan,
    scheduleHash: behaviorDatasetScheduleHash(input.plan),
    observations: Object.freeze(orderedObservations),
    games: Object.freeze(
      [...games].sort((left, right) => left.gameId.localeCompare(right.gameId)),
    ),
    failures: Object.freeze(failures),
  });
}
