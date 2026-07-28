import { createActorObservation } from "../agents/observation";
import type { PolicyObservation } from "../agents/policies";
import { sortCards, type Card } from "../domain/cards";
import type { OpponentSeat, Seat } from "../domain/seats";
import type { GameEvent } from "../events/game-events";
import { stableHash } from "../events/stable-hash";
import {
  activeTimelineEvents,
  replayTimeline,
  type GameTimeline,
} from "../events/timeline";
import {
  applyExactHandEvent,
  assertExactHandStateInvariant,
  createExactHandState,
  type ExactHandState,
} from "../rules/exact-hand-transition";
import {
  BEHAVIOR_MODEL_HASH,
  BEHAVIOR_MODEL_IDS,
  allBehaviorModelDistributions,
  behaviorActionKey,
  deepFreezeBehavior,
  enumerateBehaviorActions,
  probabilityOfBehaviorAction,
  temperBehaviorLikelihoods,
  validateBehaviorModelConfig,
  type BehaviorAction,
  type BehaviorActionKey,
  type BehaviorModelConfig,
  type BehaviorModelConfigInput,
  type BehaviorModelDistribution,
  type BehaviorModelId,
} from "./behavior-models";
import { HardInferenceError } from "./error";
import { assertHiddenWorldInvariant } from "./hidden-world";
import type { HardBelief, HiddenWorld } from "./types";

export const BEHAVIOR_BELIEF_ALGORITHM_VERSION =
  "behavior-belief-replay-v1" as const;

export type BehaviorModelProbability = {
  readonly modelId: BehaviorModelId;
  readonly probability: number;
};

export type BehaviorActionPredictionEntry = {
  readonly action: BehaviorAction;
  readonly actionKey: BehaviorActionKey;
  readonly probability: number;
};

export type BehaviorWorldOccurrence = {
  readonly occurrenceIndex: number;
  readonly witnessId: string;
  readonly priorWeight: number;
  readonly weight: number;
  readonly conditionalModelProbabilities: Readonly<
    Record<OpponentSeat, readonly BehaviorModelProbability[]>
  >;
};

export type BehaviorDecisionTrace = {
  readonly eventIndex: number;
  readonly seat: OpponentSeat;
  readonly decisionOrdinal: number;
  readonly observedAction: BehaviorAction;
  readonly observedActionKey: BehaviorActionKey;
  readonly forced: boolean;
  readonly forcedWorldOccurrences: number;
  readonly discretionaryWorldOccurrences: number;
  readonly legalActionKeys: readonly BehaviorActionKey[];
  readonly predictiveDistribution: readonly BehaviorActionPredictionEntry[];
  readonly observedPredictiveProbability: number;
  readonly temperedNormalization: number;
  readonly minimumModelLikelihood: number;
  readonly maximumModelLikelihood: number;
  readonly minimumEffectiveLikelihoodPower: number;
  readonly maximumEffectiveLikelihoodPower: number;
  readonly maximumRawBayesFactor: number;
  readonly maximumTemperedBayesFactor: number;
  readonly cappedWorldOccurrences: number;
  readonly effectiveSampleSizeBefore: number;
  readonly effectiveSampleSizeAfter: number;
  readonly entropyBefore: number;
  readonly entropyAfter: number;
  readonly actingPosteriorBefore: readonly BehaviorModelProbability[];
  readonly actingPosteriorAfter: readonly BehaviorModelProbability[];
  /**
   * Updating one actor must never mutate the other actor's conditional model
   * vector inside any world. Marginal changes caused by reweighting worlds are
   * intentionally not represented by this invariant.
   */
  readonly nonActingConditionalMaximumDelta: number;
};

export type BehaviorBeliefDiagnostics = {
  readonly worldOccurrences: number;
  readonly uniqueWitnesses: number;
  readonly duplicateOccurrences: number;
  readonly hardSupportPreserved: true;
  readonly zeroWeightOccurrences: 0;
  readonly minimumWorldWeight: number;
  readonly maximumWorldWeight: number;
  readonly effectiveSampleSize: number;
  readonly entropy: number;
  readonly normalizedEntropy: number;
  readonly configuredMaximumBayesFactor: number;
  readonly maximumObservedTemperedBayesFactor: number;
  readonly cappedWorldDecisionEvaluations: number;
  readonly totalWorldDecisionEvaluations: number;
  readonly opponentDecisions: number;
  readonly forcedDecisions: number;
  readonly discretionaryDecisions: number;
  readonly decisionsBySeat: Readonly<
    Record<
      OpponentSeat,
      {
        readonly total: number;
        readonly forced: number;
        readonly discretionary: number;
      }
    >
  >;
};

export type BehaviorBelief = {
  readonly schemaVersion: 1;
  readonly algorithmVersion: typeof BEHAVIOR_BELIEF_ALGORITHM_VERSION;
  readonly historyHash: string;
  readonly hardBeliefConfigHash: string;
  readonly worldSetChecksum: string;
  readonly configHash: string;
  readonly modelHash: string;
  readonly resultHash: string;
  readonly config: BehaviorModelConfig;
  readonly decisionOrdinals: Readonly<Record<Seat, number>>;
  readonly worldOccurrences: readonly BehaviorWorldOccurrence[];
  readonly opponentPosteriors: Readonly<
    Record<OpponentSeat, readonly BehaviorModelProbability[]>
  >;
  readonly diagnostics: BehaviorBeliefDiagnostics;
  readonly decisionTraces: readonly BehaviorDecisionTrace[];
};

export type CurrentOpponentActionPrediction = {
  readonly schemaVersion: 1;
  readonly historyHash: string;
  readonly behaviorResultHash: string;
  readonly seat: OpponentSeat;
  readonly decisionOrdinal: number;
  readonly forced: boolean;
  readonly forcedWorldOccurrences: number;
  readonly actionDistribution: readonly BehaviorActionPredictionEntry[];
};

export function behaviorBeliefConfigurationHash(
  config: BehaviorModelConfig,
): string {
  return stableHash({
    schemaVersion: 1,
    algorithmVersion: BEHAVIOR_BELIEF_ALGORITHM_VERSION,
    config,
  });
}

type MutableWorldReplay = {
  readonly occurrenceIndex: number;
  readonly world: HiddenWorld;
  exactState: ExactHandState;
  logWeight: number;
  readonly modelLogProbabilities: Record<OpponentSeat, number[]>;
};

type RawWorldDecisionEvaluation = {
  readonly replay: MutableWorldReplay;
  readonly observation: PolicyObservation;
  readonly distributions: Readonly<
    Record<BehaviorModelId, BehaviorModelDistribution>
  >;
  readonly likelihoods: readonly number[];
  readonly forced: boolean;
};

type WorldDecisionEvaluation = RawWorldDecisionEvaluation & {
  readonly temperedLogLikelihoods: readonly number[];
  readonly effectiveLikelihoodPower: number;
  readonly rawBayesFactor: number;
  readonly temperedBayesFactor: number;
  readonly capApplied: boolean;
  readonly logEvidence: number;
  readonly forced: boolean;
};

function inferenceFailure(
  code: "INVALID_PUBLIC_HISTORY" | "NO_VALID_WORLDS" | "INVARIANT_VIOLATION",
  message: string,
  details: Readonly<Record<string, unknown>>,
  eventIndex: number | null = null,
  cause?: unknown,
): never {
  throw new HardInferenceError(code, message, {
    eventIndex,
    details,
    cause,
  });
}

function isOpponentSeat(seat: Seat): seat is OpponentSeat {
  return seat === "p2" || seat === "p3";
}

function decisionSeat(event: GameEvent): Seat | null {
  switch (event.type) {
    case "card-played":
      return event.seat;
    case "hand-taken":
      return event.actor;
    case "game-created":
    case "player-card-drawn":
    case "waste-card-drawn":
      return null;
  }
}

function actionFromDecisionEvent(event: GameEvent): BehaviorAction | null {
  switch (event.type) {
    case "card-played":
      return { kind: "play-card", card: event.card };
    case "hand-taken":
      return { kind: "take-hand", target: event.target };
    case "game-created":
    case "player-card-drawn":
    case "waste-card-drawn":
      return null;
  }
}

function logSumExp(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    maximum = Math.max(maximum, value);
  }
  if (!Number.isFinite(maximum)) {
    return maximum;
  }
  let shiftedSum = 0;
  for (const value of values) {
    shiftedSum += Math.exp(value - maximum);
  }
  return maximum + Math.log(shiftedSum);
}

function numericMinimum(values: readonly number[], context: string): number {
  if (values.length === 0) {
    inferenceFailure(
      "INVARIANT_VIOLATION",
      `${context} has no numeric values.`,
      { context },
    );
  }
  let minimum = Number.POSITIVE_INFINITY;
  for (const value of values) {
    minimum = Math.min(minimum, value);
  }
  return minimum;
}

function numericMaximum(values: readonly number[], context: string): number {
  if (values.length === 0) {
    inferenceFailure(
      "INVARIANT_VIOLATION",
      `${context} has no numeric values.`,
      { context },
    );
  }
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    maximum = Math.max(maximum, value);
  }
  return maximum;
}

function normalizeLogProbabilities(logProbabilities: number[]): void {
  const normalizer = logSumExp(logProbabilities);
  if (!Number.isFinite(normalizer)) {
    inferenceFailure(
      "INVARIANT_VIOLATION",
      "Behavioral probabilities could not be normalized safely.",
      { logProbabilities },
    );
  }
  for (let index = 0; index < logProbabilities.length; index += 1) {
    const value = logProbabilities[index];
    if (value === undefined) {
      inferenceFailure(
        "INVARIANT_VIOLATION",
        "A behavioral probability vector contains a missing entry.",
        { index },
      );
    }
    logProbabilities[index] = value - normalizer;
  }
}

function requiredArrayValue<T>(
  values: readonly T[],
  index: number,
  context: string,
): T {
  const value = values[index];
  if (value === undefined) {
    inferenceFailure(
      "INVARIANT_VIOLATION",
      `${context} is missing array entry ${index}.`,
      { context, index, length: values.length },
    );
  }
  return value;
}

function probabilityVector(
  logProbabilities: readonly number[],
): readonly BehaviorModelProbability[] {
  return BEHAVIOR_MODEL_IDS.map((modelId, index) => ({
    modelId,
    probability: Math.exp(
      requiredArrayValue(logProbabilities, index, "model log probabilities"),
    ),
  }));
}

function worldWeights(replays: readonly MutableWorldReplay[]): number[] {
  return replays.map((replay) => Math.exp(replay.logWeight));
}

function effectiveSampleSize(weights: readonly number[]): number {
  const sumSquares = weights.reduce((sum, weight) => sum + weight * weight, 0);
  return sumSquares > 0 && Number.isFinite(sumSquares) ? 1 / sumSquares : 0;
}

function entropy(weights: readonly number[]): number {
  return weights.reduce(
    (sum, weight) => sum - (weight > 0 ? weight * Math.log(weight) : 0),
    0,
  );
}

function marginalModelPosterior(
  replays: readonly MutableWorldReplay[],
  seat: OpponentSeat,
): readonly BehaviorModelProbability[] {
  const probabilities = BEHAVIOR_MODEL_IDS.map((modelId, modelIndex) => ({
    modelId,
    probability: replays.reduce(
      (sum, replay) =>
        sum +
        Math.exp(replay.logWeight) *
          Math.exp(
            requiredArrayValue(
              replay.modelLogProbabilities[seat],
              modelIndex,
              `${seat} model log probabilities`,
            ),
          ),
      0,
    ),
  }));
  const total = probabilities.reduce(
    (sum, entry) => sum + entry.probability,
    0,
  );
  if (!Number.isFinite(total) || total <= 0) {
    inferenceFailure(
      "INVARIANT_VIOLATION",
      "A marginalized opponent model posterior could not be normalized.",
      { seat, total },
    );
  }
  return probabilities.map((entry) => ({
    ...entry,
    probability: entry.probability / total,
  }));
}

function maximumVectorDelta(
  before: readonly number[],
  after: readonly number[],
): number {
  let maximum = 0;
  for (let index = 0; index < before.length; index += 1) {
    maximum = Math.max(
      maximum,
      Math.abs(
        requiredArrayValue(before, index, "before vector") -
          requiredArrayValue(after, index, "after vector"),
      ),
    );
  }
  return maximum;
}

function sameCards(left: readonly Card[], right: readonly Card[]): boolean {
  const sortedLeft = sortCards(left);
  const sortedRight = sortCards(right);
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((card, index) => card === sortedRight[index])
  );
}

function assertMatchingHardBelief(
  timeline: GameTimeline,
  hardBelief: HardBelief,
): {
  readonly events: readonly GameEvent[];
  readonly historyHash: string;
} {
  let replay;
  try {
    replay = replayTimeline(timeline);
  } catch (cause) {
    inferenceFailure(
      "INVALID_PUBLIC_HISTORY",
      "Behavioral inference requires a valid active timeline.",
      {},
      null,
      cause,
    );
  }
  const events = activeTimelineEvents(timeline);
  const historyHash = replay.semanticHash;
  if (
    historyHash !== hardBelief.evidence.historyHash ||
    historyHash !== hardBelief.diagnostics.historyHash ||
    events.length !== hardBelief.evidence.activeEventCount
  ) {
    inferenceFailure(
      "INVALID_PUBLIC_HISTORY",
      "The hard belief is stale or belongs to a different active timeline.",
      {
        timelineHistoryHash: historyHash,
        evidenceHistoryHash: hardBelief.evidence.historyHash,
        diagnosticsHistoryHash: hardBelief.diagnostics.historyHash,
        timelineEventCount: events.length,
        evidenceEventCount: hardBelief.evidence.activeEventCount,
      },
    );
  }
  if (stableHash(replay.state) !== stableHash(hardBelief.evidence.finalState)) {
    inferenceFailure(
      "INVALID_PUBLIC_HISTORY",
      "The hard-belief final public state does not match timeline replay.",
      { historyHash },
    );
  }
  if (hardBelief.worlds.length === 0) {
    inferenceFailure(
      "NO_VALID_WORLDS",
      "Behavioral inference requires at least one hard-support occurrence.",
      { historyHash },
    );
  }
  const orderedWitnessIds = hardBelief.worlds.map((world) => world.witnessId);
  const checksum = stableHash({
    schemaVersion: 1,
    orderedWitnessIds,
  });
  if (
    checksum !== hardBelief.diagnostics.worldSetChecksum ||
    hardBelief.diagnostics.generatedWorlds !== hardBelief.worlds.length
  ) {
    inferenceFailure(
      "INVARIANT_VIOLATION",
      "The hard-belief world list does not match its diagnostics.",
      {
        expectedWorldSetChecksum: hardBelief.diagnostics.worldSetChecksum,
        actualWorldSetChecksum: checksum,
        generatedWorlds: hardBelief.diagnostics.generatedWorlds,
        actualWorlds: hardBelief.worlds.length,
      },
    );
  }
  for (const world of hardBelief.worlds) {
    assertHiddenWorldInvariant(world, hardBelief.evidence);
  }
  return { events, historyHash };
}

function createWorldReplays(
  hardBelief: HardBelief,
  config: BehaviorModelConfig,
): MutableWorldReplay[] {
  const occurrenceCount = hardBelief.worlds.length;
  const initialLogWeight = -Math.log(occurrenceCount);
  const initialModelLogs = BEHAVIOR_MODEL_IDS.map((modelId) =>
    Math.log(config.modelPriors[modelId]),
  );
  return hardBelief.worlds.map((world, occurrenceIndex) => {
    let exactState: ExactHandState;
    try {
      exactState = createExactHandState(
        {
          user: hardBelief.evidence.initialUserHand,
          p2: world.initialHands.p2,
          p3: world.initialHands.p3,
        },
        hardBelief.evidence.rules,
      );
    } catch (cause) {
      inferenceFailure(
        "INVARIANT_VIOLATION",
        "A hard-support occurrence cannot initialize an exact rules state.",
        { occurrenceIndex, witnessId: world.witnessId },
        0,
        cause,
      );
    }
    return {
      occurrenceIndex,
      world,
      exactState,
      logWeight: initialLogWeight,
      modelLogProbabilities: {
        p2: [...initialModelLogs],
        p3: [...initialModelLogs],
      },
    };
  });
}

function aggregatePredictiveDistribution(
  evaluations: readonly WorldDecisionEvaluation[],
  seat: OpponentSeat,
): readonly BehaviorActionPredictionEntry[] {
  const aggregate = new Map<
    BehaviorActionKey,
    { action: BehaviorAction; probability: number }
  >();
  for (const evaluation of evaluations) {
    const worldWeight = Math.exp(evaluation.replay.logWeight);
    const modelLogs = evaluation.replay.modelLogProbabilities[seat];
    for (const [modelIndex, modelId] of BEHAVIOR_MODEL_IDS.entries()) {
      const mixtureWeight =
        worldWeight *
        Math.exp(
          requiredArrayValue(
            modelLogs,
            modelIndex,
            `${seat} predictive model probabilities`,
          ),
        );
      for (const entry of evaluation.distributions[modelId].probabilities) {
        const prior = aggregate.get(entry.actionKey);
        aggregate.set(entry.actionKey, {
          action: entry.action,
          probability:
            (prior?.probability ?? 0) + mixtureWeight * entry.probability,
        });
      }
    }
  }
  const total = [...aggregate.values()].reduce(
    (sum, entry) => sum + entry.probability,
    0,
  );
  if (!Number.isFinite(total) || total <= 0) {
    inferenceFailure(
      "INVARIANT_VIOLATION",
      "A predictive action distribution could not be normalized.",
      { seat, total },
    );
  }
  return [...aggregate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([actionKey, entry]) => ({
      action: entry.action,
      actionKey,
      probability: entry.probability / total,
    }));
}

function evaluateOpponentDecision(
  replays: readonly MutableWorldReplay[],
  seat: OpponentSeat,
  decisionOrdinal: number,
  observedAction: BehaviorAction,
  prefixEvents: readonly GameEvent[],
  config: BehaviorModelConfig,
  eventIndex: number,
): WorldDecisionEvaluation[] {
  const rawEvaluations: RawWorldDecisionEvaluation[] = replays.map((replay) => {
    let observation: PolicyObservation;
    try {
      observation = createActorObservation(
        {
          publicState: replay.exactState.publicState,
          exactHands: replay.exactState.hands,
        },
        seat,
        decisionOrdinal,
        prefixEvents,
      );
    } catch (cause) {
      inferenceFailure(
        "INVARIANT_VIOLATION",
        "Could not create an actor-safe observation for a hard-support occurrence.",
        {
          occurrenceIndex: replay.occurrenceIndex,
          witnessId: replay.world.witnessId,
          seat,
          decisionOrdinal,
        },
        eventIndex,
        cause,
      );
    }
    const distributions = allBehaviorModelDistributions(observation, config);
    const likelihoods = BEHAVIOR_MODEL_IDS.map((modelId) => {
      try {
        return probabilityOfBehaviorAction(
          distributions[modelId],
          observedAction,
        );
      } catch (cause) {
        if (cause instanceof HardInferenceError) {
          throw new HardInferenceError(cause.code, cause.message, {
            eventIndex,
            details: {
              ...cause.details,
              occurrenceIndex: replay.occurrenceIndex,
              witnessId: replay.world.witnessId,
              seat,
              decisionOrdinal,
            },
            cause,
          });
        }
        throw cause;
      }
    });
    if (
      likelihoods.some(
        (likelihood) => !Number.isFinite(likelihood) || likelihood <= 0,
      )
    ) {
      inferenceFailure(
        "INVARIANT_VIOLATION",
        "Every legal observed action must retain positive model likelihood.",
        {
          occurrenceIndex: replay.occurrenceIndex,
          seat,
          likelihoods,
        },
        eventIndex,
      );
    }
    return {
      replay,
      observation,
      distributions,
      likelihoods,
      forced: enumerateBehaviorActions(observation).length === 1,
    };
  });
  const globalTempering = temperBehaviorLikelihoods(
    rawEvaluations.flatMap((evaluation) => [...evaluation.likelihoods]),
    config,
  );

  return rawEvaluations.map((evaluation) => {
    const temperedLogLikelihoods = evaluation.likelihoods.map(
      (likelihood) =>
        globalTempering.effectiveLikelihoodPower * Math.log(likelihood),
    );
    const logEvidence = logSumExp(
      temperedLogLikelihoods.map(
        (logLikelihood, modelIndex) =>
          requiredArrayValue(
            evaluation.replay.modelLogProbabilities[seat],
            modelIndex,
            `${seat} decision model probabilities`,
          ) + logLikelihood,
      ),
    );
    return {
      ...evaluation,
      temperedLogLikelihoods,
      effectiveLikelihoodPower: globalTempering.effectiveLikelihoodPower,
      rawBayesFactor: globalTempering.rawBayesFactor,
      temperedBayesFactor: globalTempering.temperedBayesFactor,
      capApplied: globalTempering.capApplied,
      logEvidence,
    };
  });
}

function updateFromEvaluations(
  replays: readonly MutableWorldReplay[],
  evaluations: readonly WorldDecisionEvaluation[],
  seat: OpponentSeat,
): {
  readonly nonActingConditionalMaximumDelta: number;
  readonly temperedNormalization: number;
} {
  const nonActingSeat: OpponentSeat = seat === "p2" ? "p3" : "p2";
  const nonActingBefore = evaluations.map((evaluation) => [
    ...evaluation.replay.modelLogProbabilities[nonActingSeat],
  ]);
  const unnormalizedWorldLogs: number[] = [];

  for (const evaluation of evaluations) {
    const actorLogs = evaluation.replay.modelLogProbabilities[seat];
    for (let modelIndex = 0; modelIndex < actorLogs.length; modelIndex += 1) {
      actorLogs[modelIndex] =
        requiredArrayValue(actorLogs, modelIndex, "actor model probabilities") +
        requiredArrayValue(
          evaluation.temperedLogLikelihoods,
          modelIndex,
          "tempered model likelihoods",
        ) -
        evaluation.logEvidence;
    }
    normalizeLogProbabilities(actorLogs);
    evaluation.replay.logWeight += evaluation.logEvidence;
    unnormalizedWorldLogs.push(evaluation.replay.logWeight);
  }

  const worldNormalizer = logSumExp(unnormalizedWorldLogs);
  if (!Number.isFinite(worldNormalizer)) {
    inferenceFailure(
      "INVARIANT_VIOLATION",
      "Behavioral world weights could not be normalized safely.",
      { seat, unnormalizedWorldLogs },
    );
  }
  for (const replay of replays) {
    replay.logWeight -= worldNormalizer;
  }

  let nonActingConditionalMaximumDelta = 0;
  for (let index = 0; index < evaluations.length; index += 1) {
    const evaluation = requiredArrayValue(
      evaluations,
      index,
      "world decision evaluations",
    );
    nonActingConditionalMaximumDelta = Math.max(
      nonActingConditionalMaximumDelta,
      maximumVectorDelta(
        requiredArrayValue(nonActingBefore, index, "non-acting before vectors"),
        evaluation.replay.modelLogProbabilities[nonActingSeat],
      ),
    );
  }
  return {
    nonActingConditionalMaximumDelta,
    temperedNormalization: Math.exp(worldNormalizer),
  };
}

function applyEventAcrossWorlds(
  replays: readonly MutableWorldReplay[],
  event: Exclude<GameEvent, { readonly type: "game-created" }>,
  eventIndex: number,
): void {
  for (const replay of replays) {
    try {
      replay.exactState = applyExactHandEvent(
        replay.exactState,
        event,
        eventIndex,
        "full",
      );
    } catch (cause) {
      inferenceFailure(
        "INVALID_PUBLIC_HISTORY",
        "An active event is illegal in a hard-support occurrence.",
        {
          occurrenceIndex: replay.occurrenceIndex,
          witnessId: replay.world.witnessId,
          eventType: event.type,
        },
        eventIndex,
        cause,
      );
    }
  }
}

function assertFinalWorldStates(
  replays: readonly MutableWorldReplay[],
  expectedPublicStateHash: string,
): void {
  for (const replay of replays) {
    try {
      assertExactHandStateInvariant(replay.exactState);
    } catch (cause) {
      inferenceFailure(
        "INVARIANT_VIOLATION",
        "A replayed hard-support occurrence ends in an invalid exact state.",
        {
          occurrenceIndex: replay.occurrenceIndex,
          witnessId: replay.world.witnessId,
        },
        null,
        cause,
      );
    }
    if (stableHash(replay.exactState.publicState) !== expectedPublicStateHash) {
      inferenceFailure(
        "INVARIANT_VIOLATION",
        "Exact replay diverged from the active public timeline.",
        {
          occurrenceIndex: replay.occurrenceIndex,
          witnessId: replay.world.witnessId,
        },
      );
    }
    for (const seat of ["user", "p2", "p3"] as const) {
      if (
        !sameCards(
          replay.exactState.hands[seat],
          replay.world.currentHands[seat],
        )
      ) {
        inferenceFailure(
          "INVARIANT_VIOLATION",
          "Exact replay does not reproduce a hard world's current hand.",
          {
            occurrenceIndex: replay.occurrenceIndex,
            witnessId: replay.world.witnessId,
            seat,
          },
        );
      }
    }
  }
}

function buildDiagnostics(
  replays: readonly MutableWorldReplay[],
  traces: readonly BehaviorDecisionTrace[],
  config: BehaviorModelConfig,
): BehaviorBeliefDiagnostics {
  const weights = worldWeights(replays);
  const worldEntropy = entropy(weights);
  const forcedDecisions = traces.filter((trace) => trace.forced).length;
  const countsFor = (
    seat: OpponentSeat,
  ): {
    readonly total: number;
    readonly forced: number;
    readonly discretionary: number;
  } => {
    const seatTraces = traces.filter((trace) => trace.seat === seat);
    const forced = seatTraces.filter((trace) => trace.forced).length;
    return {
      total: seatTraces.length,
      forced,
      discretionary: seatTraces.length - forced,
    };
  };
  return {
    worldOccurrences: replays.length,
    uniqueWitnesses: new Set(replays.map((replay) => replay.world.witnessId))
      .size,
    duplicateOccurrences:
      replays.length -
      new Set(replays.map((replay) => replay.world.witnessId)).size,
    hardSupportPreserved: true,
    zeroWeightOccurrences: 0,
    minimumWorldWeight: numericMinimum(weights, "world weights"),
    maximumWorldWeight: numericMaximum(weights, "world weights"),
    effectiveSampleSize: effectiveSampleSize(weights),
    entropy: worldEntropy,
    normalizedEntropy:
      replays.length <= 1 ? 1 : worldEntropy / Math.log(replays.length),
    configuredMaximumBayesFactor: config.maximumBayesFactor,
    maximumObservedTemperedBayesFactor:
      traces.length === 0
        ? 1
        : Math.max(...traces.map((trace) => trace.maximumTemperedBayesFactor)),
    cappedWorldDecisionEvaluations: traces.reduce(
      (sum, trace) => sum + trace.cappedWorldOccurrences,
      0,
    ),
    totalWorldDecisionEvaluations: traces.reduce(
      (sum, trace) =>
        sum +
        trace.forcedWorldOccurrences +
        trace.discretionaryWorldOccurrences,
      0,
    ),
    opponentDecisions: traces.length,
    forcedDecisions,
    discretionaryDecisions: traces.length - forcedDecisions,
    decisionsBySeat: {
      p2: countsFor("p2"),
      p3: countsFor("p3"),
    },
  };
}

export function buildBehaviorBelief(
  timeline: GameTimeline,
  hardBelief: HardBelief,
  configInput: BehaviorModelConfigInput = {},
): BehaviorBelief {
  const config = validateBehaviorModelConfig(configInput);
  const { events, historyHash } = assertMatchingHardBelief(
    timeline,
    hardBelief,
  );
  const finalReplay = replayTimeline(timeline);
  const replays = createWorldReplays(hardBelief, config);
  const decisionOrdinals: Record<Seat, number> = {
    user: 0,
    p2: 0,
    p3: 0,
  };
  const traces: BehaviorDecisionTrace[] = [];
  const prefixEvents: GameEvent[] = [];
  const setup = events[0];
  if (setup?.type !== "game-created") {
    inferenceFailure(
      "INVALID_PUBLIC_HISTORY",
      "Behavioral inference history must begin with game-created.",
      {},
      0,
    );
  }
  prefixEvents.push(setup);

  for (let eventIndex = 1; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (event === undefined || event.type === "game-created") {
      inferenceFailure(
        "INVALID_PUBLIC_HISTORY",
        "The active timeline contains a missing or repeated setup event.",
        { eventType: event?.type ?? null },
        eventIndex,
      );
    }
    const seat = decisionSeat(event);
    const observedAction = actionFromDecisionEvent(event);
    if (seat !== null && observedAction !== null && isOpponentSeat(seat)) {
      const weightsBefore = worldWeights(replays);
      const actingPosteriorBefore = marginalModelPosterior(replays, seat);
      const evaluations = evaluateOpponentDecision(
        replays,
        seat,
        decisionOrdinals[seat],
        observedAction,
        prefixEvents,
        config,
        eventIndex,
      );
      const predictiveDistribution = aggregatePredictiveDistribution(
        evaluations,
        seat,
      );
      const observedActionKey = behaviorActionKey(observedAction);
      const observedPredictiveProbability = predictiveDistribution.find(
        (entry) => entry.actionKey === observedActionKey,
      )?.probability;
      if (
        observedPredictiveProbability === undefined ||
        observedPredictiveProbability <= 0
      ) {
        inferenceFailure(
          "INVALID_PUBLIC_HISTORY",
          "The observed action has no positive predictive probability.",
          { seat, observedActionKey },
          eventIndex,
        );
      }
      const otherSeat: OpponentSeat = seat === "p2" ? "p3" : "p2";
      const otherVectorsBefore = replays.map((replay) => [
        ...replay.modelLogProbabilities[otherSeat],
      ]);
      const update = updateFromEvaluations(replays, evaluations, seat);
      const otherVectorsAfter = replays.map(
        (replay) => replay.modelLogProbabilities[otherSeat],
      );
      const directOtherDeltas = otherVectorsBefore.map((before, index) =>
        maximumVectorDelta(
          before,
          requiredArrayValue(
            otherVectorsAfter,
            index,
            "non-acting after vectors",
          ),
        ),
      );
      const directOtherDelta = numericMaximum(
        directOtherDeltas,
        "non-acting conditional deltas",
      );
      const likelihoods = evaluations.flatMap((evaluation) => [
        ...evaluation.likelihoods,
      ]);
      const legalActionKeys = [
        ...new Set(
          evaluations.flatMap((evaluation) =>
            evaluation.distributions.random.probabilities.map(
              (entry) => entry.actionKey,
            ),
          ),
        ),
      ].sort();
      const forcedWorldOccurrences = evaluations.filter(
        (evaluation) => evaluation.forced,
      ).length;
      const weightsAfter = worldWeights(replays);
      traces.push({
        eventIndex,
        seat,
        decisionOrdinal: decisionOrdinals[seat],
        observedAction,
        observedActionKey,
        forced: forcedWorldOccurrences === evaluations.length,
        forcedWorldOccurrences,
        discretionaryWorldOccurrences:
          evaluations.length - forcedWorldOccurrences,
        legalActionKeys,
        predictiveDistribution,
        observedPredictiveProbability,
        temperedNormalization: update.temperedNormalization,
        minimumModelLikelihood: numericMinimum(
          likelihoods,
          "model likelihoods",
        ),
        maximumModelLikelihood: numericMaximum(
          likelihoods,
          "model likelihoods",
        ),
        minimumEffectiveLikelihoodPower: numericMinimum(
          evaluations.map((evaluation) => evaluation.effectiveLikelihoodPower),
          "effective likelihood powers",
        ),
        maximumEffectiveLikelihoodPower: numericMaximum(
          evaluations.map((evaluation) => evaluation.effectiveLikelihoodPower),
          "effective likelihood powers",
        ),
        maximumRawBayesFactor: numericMaximum(
          evaluations.map((evaluation) => evaluation.rawBayesFactor),
          "raw Bayes factors",
        ),
        maximumTemperedBayesFactor: numericMaximum(
          evaluations.map((evaluation) => evaluation.temperedBayesFactor),
          "tempered Bayes factors",
        ),
        cappedWorldOccurrences: evaluations.filter(
          (evaluation) => evaluation.capApplied,
        ).length,
        effectiveSampleSizeBefore: effectiveSampleSize(weightsBefore),
        effectiveSampleSizeAfter: effectiveSampleSize(weightsAfter),
        entropyBefore: entropy(weightsBefore),
        entropyAfter: entropy(weightsAfter),
        actingPosteriorBefore,
        actingPosteriorAfter: marginalModelPosterior(replays, seat),
        nonActingConditionalMaximumDelta: Math.max(
          update.nonActingConditionalMaximumDelta,
          directOtherDelta,
        ),
      });
    }

    applyEventAcrossWorlds(replays, event, eventIndex);
    prefixEvents.push(event);
    if (seat !== null) {
      decisionOrdinals[seat] += 1;
    }
  }

  assertFinalWorldStates(replays, stableHash(finalReplay.state));
  const priorWeight = 1 / replays.length;
  const worldOccurrences: BehaviorWorldOccurrence[] = replays.map((replay) => ({
    occurrenceIndex: replay.occurrenceIndex,
    witnessId: replay.world.witnessId,
    priorWeight,
    weight: Math.exp(replay.logWeight),
    conditionalModelProbabilities: {
      p2: probabilityVector(replay.modelLogProbabilities.p2),
      p3: probabilityVector(replay.modelLogProbabilities.p3),
    },
  }));
  const opponentPosteriors = {
    p2: marginalModelPosterior(replays, "p2"),
    p3: marginalModelPosterior(replays, "p3"),
  } as const;
  const diagnostics = buildDiagnostics(replays, traces, config);
  const configHash = behaviorBeliefConfigurationHash(config);
  const content = {
    schemaVersion: 1 as const,
    algorithmVersion: BEHAVIOR_BELIEF_ALGORITHM_VERSION,
    historyHash,
    hardBeliefConfigHash: hardBelief.diagnostics.configHash,
    worldSetChecksum: hardBelief.diagnostics.worldSetChecksum,
    configHash,
    modelHash: BEHAVIOR_MODEL_HASH,
    config,
    decisionOrdinals,
    worldOccurrences,
    opponentPosteriors,
    diagnostics,
    decisionTraces: traces,
  };
  return deepFreezeBehavior({
    ...content,
    resultHash: stableHash(content),
  });
}

function assertPredictionInputs(
  behaviorBelief: BehaviorBelief,
  hardBelief: HardBelief,
  timeline: GameTimeline,
): ReturnType<typeof replayTimeline> {
  const replay = replayTimeline(timeline);
  if (
    replay.semanticHash !== behaviorBelief.historyHash ||
    replay.semanticHash !== hardBelief.evidence.historyHash ||
    behaviorBelief.hardBeliefConfigHash !== hardBelief.diagnostics.configHash ||
    behaviorBelief.worldSetChecksum !==
      hardBelief.diagnostics.worldSetChecksum ||
    behaviorBelief.modelHash !== BEHAVIOR_MODEL_HASH ||
    behaviorBelief.worldOccurrences.length !== hardBelief.worlds.length
  ) {
    inferenceFailure(
      "INVALID_PUBLIC_HISTORY",
      "Current-action prediction inputs do not describe the same rebuilt belief.",
      {
        timelineHistoryHash: replay.semanticHash,
        behaviorHistoryHash: behaviorBelief.historyHash,
        hardHistoryHash: hardBelief.evidence.historyHash,
      },
    );
  }
  for (let index = 0; index < hardBelief.worlds.length; index += 1) {
    if (
      hardBelief.worlds[index]?.witnessId !==
        behaviorBelief.worldOccurrences[index]?.witnessId ||
      behaviorBelief.worldOccurrences[index]?.occurrenceIndex !== index
    ) {
      inferenceFailure(
        "INVARIANT_VIOLATION",
        "Behavioral occurrence ordering no longer matches hard support.",
        { occurrenceIndex: index },
      );
    }
  }
  return replay;
}

export function predictCurrentOpponentAction(
  behaviorBelief: BehaviorBelief,
  hardBelief: HardBelief,
  timeline: GameTimeline,
): CurrentOpponentActionPrediction | null {
  const replay = assertPredictionInputs(behaviorBelief, hardBelief, timeline);
  const seat = replay.state.turn;
  if (
    !isOpponentSeat(seat ?? "user") ||
    replay.state.status !== "active" ||
    replay.state.pendingAction !== null
  ) {
    return null;
  }
  const opponentSeat = seat as OpponentSeat;
  const events = activeTimelineEvents(timeline);
  const aggregate = new Map<
    BehaviorActionKey,
    { action: BehaviorAction; probability: number }
  >();
  let forcedWorldOccurrences = 0;

  for (
    let occurrenceIndex = 0;
    occurrenceIndex < hardBelief.worlds.length;
    occurrenceIndex += 1
  ) {
    const world = requiredArrayValue(
      hardBelief.worlds,
      occurrenceIndex,
      "hard-support worlds",
    );
    const behavioralOccurrence = requiredArrayValue(
      behaviorBelief.worldOccurrences,
      occurrenceIndex,
      "behavioral world occurrences",
    );
    const exactState: ExactHandState = {
      publicState: replay.state,
      hands: {
        user: [...world.currentHands.user],
        p2: [...world.currentHands.p2],
        p3: [...world.currentHands.p3],
      },
    };
    try {
      assertExactHandStateInvariant(exactState);
    } catch (cause) {
      inferenceFailure(
        "INVARIANT_VIOLATION",
        "A current hard-support occurrence is not a valid exact rules state.",
        { occurrenceIndex, witnessId: world.witnessId },
        null,
        cause,
      );
    }
    const observation = createActorObservation(
      {
        publicState: exactState.publicState,
        exactHands: exactState.hands,
      },
      opponentSeat,
      behaviorBelief.decisionOrdinals[opponentSeat],
      events,
    );
    const actions = enumerateBehaviorActions(observation);
    if (actions.length === 1) {
      forcedWorldOccurrences += 1;
    }
    const distributions = allBehaviorModelDistributions(
      observation,
      behaviorBelief.config,
    );
    const modelProbabilities =
      behavioralOccurrence.conditionalModelProbabilities[opponentSeat];
    for (const [modelIndex, modelId] of BEHAVIOR_MODEL_IDS.entries()) {
      const mixtureWeight =
        behavioralOccurrence.weight *
        (modelProbabilities[modelIndex]?.probability ?? 0);
      for (const entry of distributions[modelId].probabilities) {
        const previous = aggregate.get(entry.actionKey);
        aggregate.set(entry.actionKey, {
          action: entry.action,
          probability:
            (previous?.probability ?? 0) + mixtureWeight * entry.probability,
        });
      }
    }
  }

  const total = [...aggregate.values()].reduce(
    (sum, entry) => sum + entry.probability,
    0,
  );
  if (!Number.isFinite(total) || total <= 0) {
    inferenceFailure(
      "INVARIANT_VIOLATION",
      "Current opponent action prediction could not be normalized.",
      { seat: opponentSeat, total },
    );
  }
  const actionDistribution = [...aggregate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([actionKey, entry]) => ({
      action: entry.action,
      actionKey,
      probability: entry.probability / total,
    }));
  return deepFreezeBehavior({
    schemaVersion: 1,
    historyHash: replay.semanticHash,
    behaviorResultHash: behaviorBelief.resultHash,
    seat: opponentSeat,
    decisionOrdinal: behaviorBelief.decisionOrdinals[opponentSeat],
    forced: forcedWorldOccurrences === hardBelief.worlds.length,
    forcedWorldOccurrences,
    actionDistribution,
  });
}
