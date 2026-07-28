import {
  isCard,
  rankValue,
  sortCards,
  suitOf,
  type Suit,
} from "../domain/cards";
import type { OpponentSeat, Seat } from "../domain/seats";
import type { GameEvent } from "../events/game-events";
import { stableHash } from "../events/stable-hash";
import {
  assertExactHandStateInvariant,
  legalExactHandCards,
  type ExactHandState,
} from "../rules/exact-hand-transition";
import { legalTakeTargets } from "../rules/legal-actions";
import {
  calibrationPredictionRecordSchema,
  calibrationTruthRecordSchema,
  type CalibrationPredictionRecord,
  type CalibrationTruthRecord,
} from "./artifact-schema";
import {
  scoreActionPrediction,
  scoreBinaryPrediction,
  scoreCategoricalPrediction,
} from "./metrics";
import { parseCalibrationQueryKey } from "./predictions";
import {
  type ActionPrediction,
  type CalibrationClusterId,
  type CalibrationCoordinates,
  type CategoricalPrediction,
  type EvalOnlyScoredObservation,
  type ProbabilityEntry,
  type TerminalClusterId,
  validateDistribution,
} from "./types";

type DecisionEvent = Extract<GameEvent, { type: "card-played" | "hand-taken" }>;

export type CalibrationTruthScorerInput = {
  readonly predictions: readonly unknown[];
  readonly exactState: ExactHandState;
  readonly actualNextEvent: DecisionEvent | null;
  readonly trueOpponentModels: Readonly<Record<OpponentSeat, string>>;
  /**
   * Terminal and calibration resampling units intentionally differ. The
   * prediction artifact carries only the latter, so the scorer receives the
   * terminal cluster explicitly rather than deriving it from an ID string.
   */
  readonly terminalClusterId: TerminalClusterId;
};

export type CalibrationTruthScorerResult = {
  readonly truthRecords: readonly CalibrationTruthRecord[];
  /** Two observations per scored pair: hard-only and behavioral. */
  readonly scoredObservations: readonly EvalOnlyScoredObservation[];
  /**
   * Conditional forecasts are scored only when their conditioning event is
   * true in eval-only truth.
   */
  readonly skippedConditionalPairIds: readonly string[];
};

type PairTruth = {
  readonly targetLabel: string;
  readonly forcedAction: boolean | null;
  readonly score: boolean;
};

function fail(message: string): never {
  throw new Error(`Calibration truth scorer invariant failed: ${message}`);
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    fail(`${label} must be non-empty.`);
  }
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const orderedLeft = [...left].sort(compareText);
  const orderedRight = [...right].sort(compareText);
  return orderedLeft.every((value, index) => value === orderedRight[index]);
}

function assertPairedRecords(
  records: readonly CalibrationPredictionRecord[],
): Readonly<{
  hard: CalibrationPredictionRecord;
  behavioral: CalibrationPredictionRecord;
}> {
  if (records.length !== 2) {
    fail(
      `pair "${records[0]?.pairId ?? "unknown"}" must contain exactly two arms.`,
    );
  }
  const hard = records.find((record) => record.arm === "hard-only");
  const behavioral = records.find((record) => record.arm === "behavioral");
  if (hard === undefined || behavioral === undefined) {
    fail("each pair must contain one hard-only and one behavioral prediction.");
  }
  for (const field of [
    "pairId",
    "runId",
    "split",
    "evidenceClass",
    "gameId",
    "scenarioId",
    "stateId",
    "checkpointId",
    "checkpointEventIndex",
    "checkpointTiming",
    "publicHistoryHash",
    "publicStateHash",
    "stateVersion",
    "calibrationClusterId",
    "seedId",
    "worldOccurrences",
    "uniqueWitnesses",
    "modelBundleHash",
    "featureBundleHash",
    "queryPlanHash",
    "configHash",
  ] as const) {
    if (hard[field] !== behavioral[field]) {
      fail(`paired records disagree on ${field}.`);
    }
  }
  if (
    stableHash(hard.target) !== stableHash(behavioral.target) ||
    hard.hardKnown !== behavioral.hardKnown
  ) {
    fail("paired records disagree on target semantics or hard-known status.");
  }
  return { hard, behavioral };
}

function assertPredictionSupport(record: CalibrationPredictionRecord): void {
  const distribution = validateDistribution(record.distribution);
  const labels = distribution.map((entry) => entry.label);
  switch (record.target.kind) {
    case "query": {
      if (!sameStringSet(labels, record.target.labels)) {
        fail("query distribution labels differ from target labels.");
      }
      const parsed = parseCalibrationQueryKey(record.target.queryKey);
      if (parsed.family !== record.target.family) {
        fail("query key family differs from target family.");
      }
      if (
        (record.target.family === "conditional") !==
        (record.target.conditioningProbability !== null)
      ) {
        fail("only conditional queries may carry a conditioning probability.");
      }
      break;
    }
    case "opponent-action":
      if (
        record.checkpointTiming !== "pre-action" ||
        !sameStringSet(labels, record.target.legalActionKeys)
      ) {
        fail(
          "action prediction is not prequential or differs from legal support.",
        );
      }
      break;
    case "terminal-risk":
      fail("terminal-risk truth requires a separate continuation outcome.");
  }
}

function ownerLabel(state: ExactHandState, card: string): OpponentSeat {
  if (!isCard(card)) {
    fail(`owner query card "${card}" is invalid.`);
  }
  if (state.hands.p2.includes(card)) {
    return "p2";
  }
  if (state.hands.p3.includes(card)) {
    return "p3";
  }
  fail(`owner query card ${card} is absent from both opponent hands.`);
}

function isVoid(
  state: ExactHandState,
  seat: OpponentSeat,
  suit: Suit,
): boolean {
  return !state.hands[seat].some((card) => suitOf(card) === suit);
}

function canOvertake(
  state: ExactHandState,
  seat: OpponentSeat,
  suit: Suit,
  rankToBeat: number,
): boolean {
  return state.hands[seat].some(
    (card) => suitOf(card) === suit && rankValue(card) > rankToBeat,
  );
}

function assertOvertakeContext(
  state: ExactHandState,
  suit: Suit,
  rankToBeat: number,
): void {
  const trick = state.publicState.trick;
  if (trick?.leadSuit !== suit) {
    fail("overtake query suit differs from the exact public trick.");
  }
  const leadCards = trick.plays
    .map((play) => play.card)
    .filter((card) => suitOf(card) === suit);
  if (
    leadCards.length === 0 ||
    Math.max(...leadCards.map(rankValue)) !== rankToBeat
  ) {
    fail("overtake query rank differs from the exact public trick.");
  }
}

function queryTruth(
  record: CalibrationPredictionRecord,
  state: ExactHandState,
): PairTruth {
  if (record.target.kind !== "query") {
    fail("query truth requested for a non-query target.");
  }
  const query = parseCalibrationQueryKey(record.target.queryKey);
  switch (query.family) {
    case "card-owner":
      return {
        targetLabel: ownerLabel(state, query.card),
        forcedAction: null,
        score: true,
      };
    case "current-void":
      return {
        targetLabel: isVoid(state, query.seat, query.suit) ? "true" : "false",
        forcedAction: null,
        score: true,
      };
    case "suit-length":
      return {
        targetLabel: state.hands[query.seat]
          .filter((card) => suitOf(card) === query.suit)
          .length.toString(),
        forcedAction: null,
        score: true,
      };
    case "can-overtake":
      assertOvertakeContext(state, query.suit, query.rankToBeat);
      return {
        targetLabel: canOvertake(
          state,
          query.seat,
          query.suit,
          query.rankToBeat,
        )
          ? "true"
          : "false",
        forcedAction: null,
        score: true,
      };
    case "joint": {
      assertOvertakeContext(state, query.suit, query.rankToBeat);
      const value =
        canOvertake(state, query.overtakeSeat, query.suit, query.rankToBeat) &&
        isVoid(state, query.voidSeat, query.suit);
      return {
        targetLabel: value ? "true" : "false",
        forcedAction: null,
        score: true,
      };
    }
    case "conditional": {
      assertOvertakeContext(state, query.suit, query.rankToBeat);
      const condition = isVoid(state, query.voidSeat, query.suit);
      return {
        targetLabel: canOvertake(
          state,
          query.overtakeSeat,
          query.suit,
          query.rankToBeat,
        )
          ? "true"
          : "false",
        forcedAction: null,
        score: condition,
      };
    }
  }
}

function actionFromEvent(
  event: DecisionEvent,
): Readonly<{ actor: Seat; label: string }> {
  return event.type === "card-played"
    ? { actor: event.seat, label: `play:${event.card}` }
    : { actor: event.actor, label: `take:${event.target}` };
}

function exactLegalActionLabels(
  state: ExactHandState,
  actor: OpponentSeat,
): readonly string[] {
  const labels = [
    ...legalExactHandCards(state, actor).map((card) => `play:${card}`),
    ...legalTakeTargets(state.publicState, actor).map(
      (target) => `take:${target}`,
    ),
  ];
  return Object.freeze([...new Set(labels)].sort(compareText));
}

function actionTruth(
  record: CalibrationPredictionRecord,
  state: ExactHandState,
  actualNextEvent: DecisionEvent | null,
): PairTruth {
  if (record.target.kind !== "opponent-action" || actualNextEvent === null) {
    fail("action predictions require an eval-only next decision event.");
  }
  const actual = actionFromEvent(actualNextEvent);
  if (
    actual.actor !== record.target.actor ||
    state.publicState.turn !== record.target.actor
  ) {
    fail("actual decision actor differs from the pre-action prediction actor.");
  }
  const legalLabels = exactLegalActionLabels(state, record.target.actor);
  if (!legalLabels.includes(actual.label)) {
    fail(`actual action ${actual.label} is not exact-state legal.`);
  }
  if (!record.target.legalActionKeys.includes(actual.label)) {
    fail(
      `actual action ${actual.label} is absent from predicted hard support.`,
    );
  }
  return {
    targetLabel: actual.label,
    forcedAction: legalLabels.length === 1,
    score: true,
  };
}

function coordinates(
  record: CalibrationPredictionRecord,
  terminalCluster: TerminalClusterId,
): CalibrationCoordinates {
  const queryId =
    record.target.kind === "query"
      ? record.target.queryKey
      : record.target.kind === "opponent-action"
        ? `opponent-action:${record.target.actor}:${record.target.actorDecisionOrdinal.toString()}`
        : `terminal-risk:${record.target.actionKey}`;
  return {
    queryId,
    familyId: record.target.family,
    stateId: record.stateId,
    trajectoryId: record.gameId,
    calibrationClusterId: record.calibrationClusterId as CalibrationClusterId,
    terminalClusterId: terminalCluster,
  };
}

function genericScore(
  record: CalibrationPredictionRecord,
  truth: PairTruth,
  terminalCluster: TerminalClusterId,
): EvalOnlyScoredObservation {
  const observationId = stableHash({
    schemaVersion: 1,
    predictionId: record.predictionId,
    truthLabel: truth.targetLabel,
  });
  const common = {
    schemaVersion: 1 as const,
    predictionId: record.predictionId,
    arm: record.arm,
    coordinates: coordinates(record, terminalCluster),
    hardKnown: record.hardKnown,
  };
  const distribution = record.distribution as readonly ProbabilityEntry[];
  if (record.target.kind === "opponent-action") {
    const prediction: ActionPrediction = {
      ...common,
      kind: "action",
      seat: record.target.actor,
      distribution,
    };
    if (truth.forcedAction === null) {
      fail("action truth is missing its forced/discretionary classification.");
    }
    return scoreActionPrediction(
      prediction,
      truth.targetLabel,
      truth.forcedAction,
      observationId,
    );
  }
  if (
    record.target.kind === "query" &&
    sameStringSet(record.target.labels, ["false", "true"])
  ) {
    const probabilityTrue = distribution.find(
      (entry) => entry.label === "true",
    )?.probability;
    if (probabilityTrue === undefined) {
      fail("binary query distribution has no true label.");
    }
    return scoreBinaryPrediction(
      {
        ...common,
        kind: "binary",
        probability: probabilityTrue,
      },
      truth.targetLabel === "true",
      observationId,
    );
  }
  if (record.target.kind === "query") {
    const prediction: CategoricalPrediction = {
      ...common,
      kind: "categorical",
      distribution,
    };
    return scoreCategoricalPrediction(
      prediction,
      truth.targetLabel,
      observationId,
    );
  }
  fail("terminal-risk scoring requires a continuation outcome.");
}

function assertHardKnownTruth(
  record: CalibrationPredictionRecord,
  targetLabel: string,
): void {
  if (!record.hardKnown) {
    return;
  }
  const truthProbability = record.distribution.find(
    (entry) => entry.label === targetLabel,
  )?.probability;
  if (
    truthProbability !== 1 ||
    record.distribution.some(
      (entry) => entry.label !== targetLabel && entry.probability !== 0,
    )
  ) {
    fail("a hard-known prediction did not preserve the exact truth at 0/1.");
  }
}

export function scoreCalibrationPredictions(
  input: CalibrationTruthScorerInput,
): CalibrationTruthScorerResult {
  assertExactHandStateInvariant(input.exactState);
  requireNonEmpty(input.terminalClusterId, "terminalClusterId");
  requireNonEmpty(input.trueOpponentModels.p2, "trueOpponentModels.p2");
  requireNonEmpty(input.trueOpponentModels.p3, "trueOpponentModels.p3");
  if (input.predictions.length === 0) {
    fail("at least one prediction is required.");
  }

  const predictions = input.predictions.map((value) =>
    calibrationPredictionRecordSchema.parse(value),
  );
  const predictionIds = new Set<string>();
  const byPair = new Map<string, CalibrationPredictionRecord[]>();
  for (const prediction of predictions) {
    if (predictionIds.has(prediction.predictionId)) {
      fail(`duplicate predictionId "${prediction.predictionId}".`);
    }
    predictionIds.add(prediction.predictionId);
    assertPredictionSupport(prediction);
    if (
      prediction.publicStateHash !== stableHash(input.exactState.publicState) ||
      prediction.stateVersion !== input.exactState.publicState.appliedEventCount
    ) {
      fail("prediction public state does not match eval-only exact state.");
    }
    const group = byPair.get(prediction.pairId) ?? [];
    group.push(prediction);
    byPair.set(prediction.pairId, group);
  }

  const truthStateHash = stableHash({
    schemaVersion: 1,
    publicState: input.exactState.publicState,
    hands: {
      user: sortCards(input.exactState.hands.user),
      p2: sortCards(input.exactState.hands.p2),
      p3: sortCards(input.exactState.hands.p3),
    },
  });
  const truthRecords: CalibrationTruthRecord[] = [];
  const scoredObservations: EvalOnlyScoredObservation[] = [];
  const skippedConditionalPairIds: string[] = [];
  const orderedPairs = [...byPair.entries()].sort(([left], [right]) =>
    compareText(left, right),
  );
  for (const [pairedId, records] of orderedPairs) {
    const pair = assertPairedRecords(records);
    const representative = pair.hard;
    const truth =
      representative.target.kind === "query"
        ? queryTruth(representative, input.exactState)
        : representative.target.kind === "opponent-action"
          ? actionTruth(representative, input.exactState, input.actualNextEvent)
          : fail("terminal-risk scoring requires a continuation outcome.");
    if (truth.score) {
      if (
        !representative.distribution.some(
          (entry) => entry.label === truth.targetLabel,
        )
      ) {
        fail(
          `truth label "${truth.targetLabel}" is absent from prediction support.`,
        );
      }
      assertHardKnownTruth(pair.hard, truth.targetLabel);
      assertHardKnownTruth(pair.behavioral, truth.targetLabel);
    }

    truthRecords.push(
      calibrationTruthRecordSchema.parse({
        schemaVersion: 1,
        protocolId: "eval-v1",
        recordType: "calibration-truth-eval-only",
        runId: representative.runId,
        split: representative.split,
        pairId: pairedId,
        gameId: representative.gameId,
        stateId: representative.stateId,
        scoreStatus: truth.score ? "scored" : "conditioning-false",
        targetLabel: truth.score ? truth.targetLabel : null,
        forcedAction: truth.score ? truth.forcedAction : null,
        trueOpponentModels: input.trueOpponentModels,
        truthStateHash,
      }),
    );
    if (!truth.score) {
      skippedConditionalPairIds.push(pairedId);
      continue;
    }
    scoredObservations.push(
      genericScore(pair.hard, truth, input.terminalClusterId),
      genericScore(pair.behavioral, truth, input.terminalClusterId),
    );
  }

  return {
    truthRecords: Object.freeze(truthRecords),
    scoredObservations: Object.freeze(scoredObservations),
    skippedConditionalPairIds: Object.freeze(skippedConditionalPairIds),
  };
}
