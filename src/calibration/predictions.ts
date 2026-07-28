import { createActorObservation } from "../agents/observation";
import {
  SUITS,
  isCard,
  rankValue,
  sortCards,
  suitOf,
  type Card,
  type Suit,
} from "../domain/cards";
import type { OpponentSeat } from "../domain/seats";
import { stableHash } from "../events/stable-hash";
import {
  activeTimelineEvents,
  replayTimeline,
  type GameTimeline,
} from "../events/timeline";
import type { PublicInformationState } from "../public/public-state";
import type { BehaviorBelief } from "../inference/behavior-belief";
import {
  BEHAVIOR_MODEL_IDS,
  allBehaviorModelDistributions,
  enumerateBehaviorActions,
  type BehaviorActionKey,
  type BehaviorModelId,
} from "../inference/behavior-models";
import type { HardBelief, HiddenWorld } from "../inference/types";
import { legalTakeTargets } from "../rules/legal-actions";
import {
  calibrationPredictionRecordSchema,
  type CalibrationPredictionRecord,
} from "./artifact-schema";

const OPPONENT_SEATS = ["p2", "p3"] as const;
const BOOLEAN_LABELS = ["false", "true"] as const;
const PROBABILITY_TOLERANCE = 1e-12;

export type CalibrationCheckpointMetadata = {
  readonly runId: string;
  readonly split: CalibrationPredictionRecord["split"];
  readonly evidenceClass: string;
  readonly gameId: string;
  readonly scenarioId: string;
  readonly calibrationClusterId: string;
  readonly checkpointId: string;
  /** Index at which the next event would be appended. */
  readonly checkpointEventIndex: number;
  readonly checkpointTiming: "pre-action" | "post-event";
  readonly stateVersion: number;
  readonly featureBundleHash: string;
  readonly queryPlanHash: string;
  readonly seedId: string;
};

export type CalibrationPredictionConfig = {
  readonly conditionalProbabilityFloor: number;
};

export type GenerateCalibrationPredictionsInput = {
  readonly timeline: GameTimeline;
  readonly hardBelief: HardBelief;
  readonly behaviorBelief: BehaviorBelief;
  readonly checkpoint: CalibrationCheckpointMetadata;
  readonly config: CalibrationPredictionConfig;
};

export type ParsedCalibrationQuery =
  | {
      readonly family: "card-owner";
      readonly card: Card;
    }
  | {
      readonly family: "current-void" | "suit-length";
      readonly seat: OpponentSeat;
      readonly suit: Suit;
    }
  | {
      readonly family: "can-overtake";
      readonly seat: OpponentSeat;
      readonly suit: Suit;
      readonly rankToBeat: number;
    }
  | {
      readonly family: "joint" | "conditional";
      readonly overtakeSeat: OpponentSeat;
      readonly voidSeat: OpponentSeat;
      readonly suit: Suit;
      readonly rankToBeat: number;
    };

type WeightedOccurrence = {
  readonly occurrenceIndex: number;
  readonly world: HiddenWorld;
  readonly hardWeight: number;
  readonly behaviorWeight: number;
};

type QueryTarget = Extract<
  CalibrationPredictionRecord["target"],
  { kind: "query" }
>;

type Distribution = CalibrationPredictionRecord["distribution"];

type QueryPair = {
  readonly hardTarget: QueryTarget;
  readonly behaviorTarget: QueryTarget;
  readonly hardDistribution: Distribution;
  readonly behaviorDistribution: Distribution;
  readonly hardConditioningProbability: number | null;
  readonly behaviorConditioningProbability: number | null;
  readonly hardKnown: boolean;
  readonly method: string;
};

type OvertakeContext = {
  readonly suit: Suit;
  readonly rankToBeat: number;
};

function fail(message: string): never {
  throw new Error(`Calibration prediction invariant failed: ${message}`);
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

function requireProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be finite and in [0, 1].`);
  }
}

function normalizeWeights(values: readonly number[], label: string): number[] {
  if (values.length === 0) {
    fail(`${label} cannot be empty.`);
  }
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) {
      fail(`${label} must contain only finite positive values.`);
    }
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    fail(`${label} cannot be normalized.`);
  }
  return values.map((value) => value / total);
}

function effectiveSampleSize(weights: readonly number[]): number {
  const sumSquares = weights.reduce((sum, weight) => sum + weight * weight, 0);
  return 1 / sumSquares;
}

function entropy(weights: readonly number[]): number {
  return weights.reduce((sum, weight) => sum - weight * Math.log(weight), 0);
}

function modelProbability(
  probabilities: BehaviorBelief["worldOccurrences"][number]["conditionalModelProbabilities"][OpponentSeat],
  modelId: BehaviorModelId,
): number {
  const matches = probabilities.filter((entry) => entry.modelId === modelId);
  if (matches.length !== 1) {
    fail(
      `conditional model vector has ${matches.length.toString()} entries for ${modelId}.`,
    );
  }
  const probability = matches[0]?.probability;
  if (probability === undefined) {
    fail(`conditional model vector is missing ${modelId}.`);
  }
  requireProbability(probability, `${modelId} conditional probability`);
  return probability;
}

function assertModelVector(
  probabilities: BehaviorBelief["worldOccurrences"][number]["conditionalModelProbabilities"][OpponentSeat],
  context: string,
): void {
  const total = BEHAVIOR_MODEL_IDS.reduce(
    (sum, modelId) => sum + modelProbability(probabilities, modelId),
    0,
  );
  if (Math.abs(total - 1) > PROBABILITY_TOLERANCE) {
    fail(`${context} model probabilities sum to ${total.toString()}.`);
  }
}

function pairedOccurrences(
  hardBelief: HardBelief,
  behaviorBelief: BehaviorBelief,
  historyHash: string,
): readonly WeightedOccurrence[] {
  if (
    hardBelief.evidence.historyHash !== historyHash ||
    hardBelief.diagnostics.historyHash !== historyHash ||
    behaviorBelief.historyHash !== historyHash
  ) {
    fail("timeline, hard belief, and behavior belief history hashes differ.");
  }
  if (
    behaviorBelief.hardBeliefConfigHash !== hardBelief.diagnostics.configHash ||
    behaviorBelief.worldSetChecksum !==
      hardBelief.diagnostics.worldSetChecksum ||
    behaviorBelief.worldOccurrences.length !== hardBelief.worlds.length
  ) {
    fail("behavior belief does not describe the supplied hard occurrences.");
  }
  if (hardBelief.worlds.length === 0) {
    fail("at least one hard-world occurrence is required.");
  }

  const expectedPrior = 1 / hardBelief.worlds.length;
  const rawBehaviorWeights: number[] = [];
  for (let index = 0; index < hardBelief.worlds.length; index += 1) {
    const world = hardBelief.worlds[index];
    const occurrence = behaviorBelief.worldOccurrences[index];
    if (
      world === undefined ||
      occurrence === undefined ||
      occurrence.occurrenceIndex !== index ||
      occurrence.witnessId !== world.witnessId
    ) {
      fail(
        `behavior occurrence ${index.toString()} is not paired with its hard world.`,
      );
    }
    if (
      Math.abs(occurrence.priorWeight - expectedPrior) > PROBABILITY_TOLERANCE
    ) {
      fail(
        `behavior occurrence ${index.toString()} has a non-uniform hard prior.`,
      );
    }
    assertModelVector(
      occurrence.conditionalModelProbabilities.p2,
      `occurrence ${index.toString()} p2`,
    );
    assertModelVector(
      occurrence.conditionalModelProbabilities.p3,
      `occurrence ${index.toString()} p3`,
    );
    rawBehaviorWeights.push(occurrence.weight);
  }
  const behaviorWeights = normalizeWeights(
    rawBehaviorWeights,
    "behavior world weights",
  );
  return Object.freeze(
    hardBelief.worlds.map((world, occurrenceIndex) => ({
      occurrenceIndex,
      world,
      hardWeight: expectedPrior,
      behaviorWeight: behaviorWeights[occurrenceIndex] ?? 0,
    })),
  );
}

function normalizedDistribution(
  probabilities: ReadonlyMap<string, number>,
): Distribution {
  const ordered = [...probabilities.entries()].sort(([left], [right]) =>
    compareText(left, right),
  );
  if (ordered.length === 0) {
    fail("a prediction distribution cannot be empty.");
  }
  const stabilized = ordered.map(([label, probability]) => {
    if (
      !Number.isFinite(probability) ||
      probability < -PROBABILITY_TOLERANCE ||
      probability > 1 + PROBABILITY_TOLERANCE
    ) {
      fail(
        "unnormalized prediction probability must be finite and numerically in [0, 1].",
      );
    }
    return [label, Math.min(1, Math.max(0, probability))] as const;
  });
  const total = stabilized.reduce(
    (sum, [, probability]) => sum + probability,
    0,
  );
  if (!Number.isFinite(total) || total <= 0) {
    fail("a prediction distribution cannot be normalized.");
  }
  return stabilized.map(([label, probability]) => ({
    label,
    probability: probability / total,
  }));
}

function categoricalDistribution(
  labelsValue: readonly string[],
  outcomes: readonly string[],
  weights: readonly number[],
): Readonly<{ distribution: Distribution; hardKnown: boolean }> {
  if (outcomes.length === 0 || outcomes.length !== weights.length) {
    fail(
      "categorical outcomes and weights must have the same positive length.",
    );
  }
  const labels = [...labelsValue].sort(compareText);
  if (
    labels.length === 0 ||
    new Set(labels).size !== labels.length ||
    outcomes.some((outcome) => !labels.includes(outcome))
  ) {
    fail("categorical labels must be unique and cover every outcome.");
  }
  const hardKnown = outcomes.every((outcome) => outcome === outcomes[0]);
  if (hardKnown) {
    const known = outcomes[0];
    return {
      distribution: labels.map((label) => ({
        label,
        probability: label === known ? 1 : 0,
      })),
      hardKnown: true,
    };
  }
  const probabilities = new Map(labels.map((label) => [label, 0]));
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    const weight = weights[index];
    if (outcome === undefined || weight === undefined) {
      fail(`categorical occurrence ${index.toString()} is missing.`);
    }
    probabilities.set(outcome, (probabilities.get(outcome) ?? 0) + weight);
  }
  return {
    distribution: normalizedDistribution(probabilities),
    hardKnown: false,
  };
}

function conditionalBooleanDistribution(
  outcomes: readonly boolean[],
  conditions: readonly boolean[],
  weights: readonly number[],
): Readonly<{
  distribution: Distribution;
  conditioningProbability: number;
  hardKnown: boolean;
}> | null {
  if (
    outcomes.length === 0 ||
    outcomes.length !== conditions.length ||
    outcomes.length !== weights.length
  ) {
    fail("conditional outcomes, conditions, and weights must align.");
  }
  let conditioningProbability = 0;
  let trueMass = 0;
  const supportedOutcomes: boolean[] = [];
  for (let index = 0; index < outcomes.length; index += 1) {
    if (conditions[index] === true) {
      const weight = weights[index];
      const outcome = outcomes[index];
      if (weight === undefined || outcome === undefined) {
        fail(`conditional occurrence ${index.toString()} is missing.`);
      }
      conditioningProbability += weight;
      trueMass += outcome ? weight : 0;
      supportedOutcomes.push(outcome);
    }
  }
  if (Math.abs(conditioningProbability - 1) <= PROBABILITY_TOLERANCE) {
    conditioningProbability = 1;
  }
  requireProbability(conditioningProbability, "conditioning event probability");
  if (conditioningProbability <= 0 || supportedOutcomes.length === 0) {
    return null;
  }
  const hardKnown = supportedOutcomes.every(
    (outcome) => outcome === supportedOutcomes[0],
  );
  const probabilityTrue = trueMass / conditioningProbability;
  return {
    distribution: hardKnown
      ? [
          {
            label: "false",
            probability: supportedOutcomes[0] === false ? 1 : 0,
          },
          {
            label: "true",
            probability: supportedOutcomes[0] === true ? 1 : 0,
          },
        ]
      : [
          { label: "false", probability: 1 - probabilityTrue },
          { label: "true", probability: probabilityTrue },
        ],
    conditioningProbability,
    hardKnown,
  };
}

function ownerOf(world: HiddenWorld, card: Card): OpponentSeat {
  if (world.currentHands.p2.includes(card)) {
    return "p2";
  }
  if (world.currentHands.p3.includes(card)) {
    return "p3";
  }
  fail(`${card} is absent from both current opponent hands.`);
}

function isVoid(world: HiddenWorld, seat: OpponentSeat, suit: Suit): boolean {
  return !world.currentHands[seat].some((card) => suitOf(card) === suit);
}

function canOvertake(
  world: HiddenWorld,
  seat: OpponentSeat,
  context: OvertakeContext,
): boolean {
  return world.currentHands[seat].some(
    (card) =>
      suitOf(card) === context.suit && rankValue(card) > context.rankToBeat,
  );
}

function overtakeContext(
  state: PublicInformationState,
): OvertakeContext | null {
  const leadSuit = state.trick?.leadSuit;
  if (leadSuit === null || leadSuit === undefined) {
    return null;
  }
  const leadCards =
    state.trick?.plays
      .map((play) => play.card)
      .filter((card) => suitOf(card) === leadSuit) ?? [];
  if (leadCards.length === 0) {
    return null;
  }
  return {
    suit: leadSuit,
    rankToBeat: Math.max(...leadCards.map(rankValue)),
  };
}

function explicitlyKnownVoid(
  state: PublicInformationState,
  seat: OpponentSeat,
  suit: Suit,
): boolean | null {
  if (state.knownOpponentCards[seat].some((card) => suitOf(card) === suit)) {
    return false;
  }
  if (!state.unresolvedCards.some((card) => suitOf(card) === suit)) {
    return true;
  }
  return state.knownOpponentCards[seat].length === state.handCounts[seat]
    ? true
    : null;
}

function explicitlyKnownSuitLength(
  state: PublicInformationState,
  seat: OpponentSeat,
  suit: Suit,
): number | null {
  const knownLength = state.knownOpponentCards[seat].filter(
    (card) => suitOf(card) === suit,
  ).length;
  return state.knownOpponentCards[seat].length === state.handCounts[seat] ||
    !state.unresolvedCards.some((card) => suitOf(card) === suit)
    ? knownLength
    : null;
}

function explicitlyKnownOvertake(
  state: PublicInformationState,
  seat: OpponentSeat,
  context: OvertakeContext,
): boolean | null {
  const isOvertakeCard = (card: Card): boolean =>
    suitOf(card) === context.suit && rankValue(card) > context.rankToBeat;
  if (state.knownOpponentCards[seat].some(isOvertakeCard)) {
    return true;
  }
  return state.unresolvedCards.some(isOvertakeCard) ? null : false;
}

function queryKey(query: ParsedCalibrationQuery): string {
  switch (query.family) {
    case "card-owner":
      return `card-owner:${query.card}`;
    case "current-void":
    case "suit-length":
      return `${query.family}:${query.seat}:${query.suit}`;
    case "can-overtake":
      return `can-overtake:${query.seat}:${query.suit}:${query.rankToBeat.toString()}`;
    case "joint":
    case "conditional":
      return `${query.family}:overtake:${query.overtakeSeat}:void:${query.voidSeat}:${query.suit}:${query.rankToBeat.toString()}`;
  }
}

function isOpponentSeat(value: string | undefined): value is OpponentSeat {
  return value === "p2" || value === "p3";
}

function isSuit(value: string | undefined): value is Suit {
  return SUITS.some((suit) => suit === value);
}

function parsedRank(value: string | undefined): number {
  const rank = Number(value);
  if (!Number.isSafeInteger(rank) || rank < 2 || rank > 14) {
    fail(`query rank "${value ?? ""}" is invalid.`);
  }
  return rank;
}

export function parseCalibrationQueryKey(
  value: string,
): ParsedCalibrationQuery {
  const parts = value.split(":");
  const family = parts[0];
  if (family === "card-owner" && parts.length === 2 && isCard(parts[1])) {
    return { family, card: parts[1] };
  }
  if (
    (family === "current-void" || family === "suit-length") &&
    parts.length === 3 &&
    isOpponentSeat(parts[1]) &&
    isSuit(parts[2])
  ) {
    return { family, seat: parts[1], suit: parts[2] };
  }
  if (
    family === "can-overtake" &&
    parts.length === 4 &&
    isOpponentSeat(parts[1]) &&
    isSuit(parts[2])
  ) {
    return {
      family,
      seat: parts[1],
      suit: parts[2],
      rankToBeat: parsedRank(parts[3]),
    };
  }
  if (
    (family === "joint" || family === "conditional") &&
    parts.length === 7 &&
    parts[1] === "overtake" &&
    isOpponentSeat(parts[2]) &&
    parts[3] === "void" &&
    isOpponentSeat(parts[4]) &&
    parts[2] !== parts[4] &&
    isSuit(parts[5])
  ) {
    return {
      family,
      overtakeSeat: parts[2],
      voidSeat: parts[4],
      suit: parts[5],
      rankToBeat: parsedRank(parts[6]),
    };
  }
  fail(`query key "${value}" is not a supported calibration query.`);
}

function queryTarget(
  query: ParsedCalibrationQuery,
  labels: readonly string[],
  conditioningProbability: number | null = null,
): QueryTarget {
  return {
    kind: "query",
    family: query.family,
    queryKey: queryKey(query),
    labels: [...labels],
    conditioningProbability,
  };
}

function pairedCategoricalQuery(
  query: ParsedCalibrationQuery,
  labels: readonly string[],
  outcomes: readonly string[],
  occurrences: readonly WeightedOccurrence[],
  hardKnownEligible: boolean,
): QueryPair {
  const hard = categoricalDistribution(
    labels,
    outcomes,
    occurrences.map((occurrence) => occurrence.hardWeight),
  );
  const behavior = categoricalDistribution(
    labels,
    outcomes,
    occurrences.map((occurrence) => occurrence.behaviorWeight),
  );
  if (hard.hardKnown !== behavior.hardKnown) {
    fail("positive behavioral weights changed hard-known query status.");
  }
  const target = queryTarget(query, labels);
  return {
    hardTarget: target,
    behaviorTarget: target,
    hardDistribution: hard.distribution,
    behaviorDistribution: behavior.distribution,
    hardConditioningProbability: null,
    behaviorConditioningProbability: null,
    hardKnown: hardKnownEligible && hard.hardKnown,
    method: query.family,
  };
}

function pairedBooleanQuery(
  query: ParsedCalibrationQuery,
  outcomes: readonly boolean[],
  occurrences: readonly WeightedOccurrence[],
  hardKnownEligible: boolean,
): QueryPair {
  return pairedCategoricalQuery(
    query,
    BOOLEAN_LABELS,
    outcomes.map((outcome) => (outcome ? "true" : "false")),
    occurrences,
    hardKnownEligible,
  );
}

function buildQueryPairs(
  state: PublicInformationState,
  occurrences: readonly WeightedOccurrence[],
  conditionalProbabilityFloor: number,
  exactEnumeration: boolean,
): readonly QueryPair[] {
  const pairs: QueryPair[] = [];
  const currentOpponentCards = sortCards([
    ...new Set([
      ...state.knownOpponentCards.p2,
      ...state.knownOpponentCards.p3,
      ...state.unresolvedCards,
    ]),
  ]);
  for (const card of currentOpponentCards) {
    pairs.push(
      pairedCategoricalQuery(
        { family: "card-owner", card },
        OPPONENT_SEATS,
        occurrences.map((occurrence) => ownerOf(occurrence.world, card)),
        occurrences,
        exactEnumeration ||
          state.knownOpponentCards.p2.includes(card) ||
          state.knownOpponentCards.p3.includes(card),
      ),
    );
  }

  for (const seat of OPPONENT_SEATS) {
    for (const suit of SUITS) {
      const knownVoid = explicitlyKnownVoid(state, seat, suit);
      const voidOutcomes = occurrences.map((occurrence) =>
        isVoid(occurrence.world, seat, suit),
      );
      pairs.push(
        pairedBooleanQuery(
          { family: "current-void", seat, suit },
          voidOutcomes,
          occurrences,
          exactEnumeration || knownVoid !== null,
        ),
      );
      const maximumLength = state.handCounts[seat];
      if (maximumLength > 0) {
        const knownLength = explicitlyKnownSuitLength(state, seat, suit);
        const labels = Array.from({ length: maximumLength + 1 }, (_, length) =>
          length.toString(),
        );
        pairs.push(
          pairedCategoricalQuery(
            { family: "suit-length", seat, suit },
            labels,
            occurrences.map((occurrence) =>
              occurrence.world.currentHands[seat]
                .filter((card) => suitOf(card) === suit)
                .length.toString(),
            ),
            occurrences,
            exactEnumeration || knownLength !== null,
          ),
        );
      }
    }
  }

  const context = overtakeContext(state);
  if (context === null || state.trick === null) {
    return pairs;
  }
  const playedSeats = new Set(state.trick.plays.map((play) => play.seat));
  const remainingOpponents = OPPONENT_SEATS.filter(
    (seat) =>
      state.trick?.participants.includes(seat) && !playedSeats.has(seat),
  );
  for (const seat of remainingOpponents) {
    const knownOvertake = explicitlyKnownOvertake(state, seat, context);
    pairs.push(
      pairedBooleanQuery(
        { family: "can-overtake", seat, ...context },
        occurrences.map((occurrence) =>
          canOvertake(occurrence.world, seat, context),
        ),
        occurrences,
        exactEnumeration || knownOvertake !== null,
      ),
    );
  }

  if (remainingOpponents.includes("p2") && remainingOpponents.includes("p3")) {
    const knownOvertake = explicitlyKnownOvertake(state, "p2", context);
    const knownVoid = explicitlyKnownVoid(state, "p3", context.suit);
    const overtakeOutcomes = occurrences.map((occurrence) =>
      canOvertake(occurrence.world, "p2", context),
    );
    const voidConditions = occurrences.map((occurrence) =>
      isVoid(occurrence.world, "p3", context.suit),
    );
    const jointOutcomes = overtakeOutcomes.map(
      (outcome, index) => outcome && voidConditions[index] === true,
    );
    pairs.push(
      pairedBooleanQuery(
        {
          family: "joint",
          overtakeSeat: "p2",
          voidSeat: "p3",
          ...context,
        },
        jointOutcomes,
        occurrences,
        exactEnumeration ||
          knownOvertake === false ||
          knownVoid === false ||
          (knownOvertake === true && knownVoid === true),
      ),
    );

    const hardConditional = conditionalBooleanDistribution(
      overtakeOutcomes,
      voidConditions,
      occurrences.map((occurrence) => occurrence.hardWeight),
    );
    const behaviorConditional = conditionalBooleanDistribution(
      overtakeOutcomes,
      voidConditions,
      occurrences.map((occurrence) => occurrence.behaviorWeight),
    );
    if (
      hardConditional !== null &&
      behaviorConditional !== null &&
      hardConditional.conditioningProbability >= conditionalProbabilityFloor &&
      behaviorConditional.conditioningProbability >= conditionalProbabilityFloor
    ) {
      const query: ParsedCalibrationQuery = {
        family: "conditional",
        overtakeSeat: "p2",
        voidSeat: "p3",
        ...context,
      };
      if (hardConditional.hardKnown !== behaviorConditional.hardKnown) {
        fail(
          "positive behavioral weights changed conditional hard-known status.",
        );
      }
      pairs.push({
        hardTarget: queryTarget(
          query,
          BOOLEAN_LABELS,
          hardConditional.conditioningProbability,
        ),
        behaviorTarget: queryTarget(
          query,
          BOOLEAN_LABELS,
          hardConditional.conditioningProbability,
        ),
        hardDistribution: hardConditional.distribution,
        behaviorDistribution: behaviorConditional.distribution,
        hardConditioningProbability: hardConditional.conditioningProbability,
        behaviorConditioningProbability:
          behaviorConditional.conditioningProbability,
        hardKnown:
          (exactEnumeration ||
            (knownVoid === true && knownOvertake !== null)) &&
          hardConditional.hardKnown,
        method: "conditional",
      });
    }
  }
  return pairs;
}

/**
 * Finite hard-world sampling may omit a legal card that remains possible under
 * the public hard constraints. Keep a conservative zero-probability label for
 * every such action so the scorer records raw zero support instead of
 * discarding the checkpoint. The sampled-world mixture still determines every
 * positive probability.
 */
function conservativeHardPossibleActionKeys(
  state: PublicInformationState,
  seat: OpponentSeat,
  hardBelief: HardBelief,
): readonly BehaviorActionKey[] {
  if (
    state.status !== "active" ||
    state.pendingAction !== null ||
    state.turn !== seat ||
    state.trick === null ||
    !state.activeSeats.includes(seat)
  ) {
    return Object.freeze([]);
  }
  const candidateCards = sortCards([
    ...new Set([
      ...state.knownOpponentCards[seat],
      ...hardBelief.evidence.hiddenCards
        .filter((constraint) =>
          OPPONENT_SEATS.some((initialOwner) => {
            const projection = constraint.origins[initialOwner];
            return projection.allowed && projection.currentLocation === seat;
          }),
        )
        .map((constraint) => constraint.card),
    ]),
  ]);
  const trick = state.trick;
  let possibleCards: readonly Card[];
  if (trick.plays.length === 0) {
    possibleCards =
      trick.forcedLeadCard === null ? candidateCards : [trick.forcedLeadCard];
  } else if (trick.leadSuit === null) {
    possibleCards = [];
  } else {
    const knownFollowers = state.knownOpponentCards[seat].filter(
      (card) => suitOf(card) === trick.leadSuit,
    );
    possibleCards =
      knownFollowers.length > 0
        ? candidateCards.filter((card) => suitOf(card) === trick.leadSuit)
        : candidateCards;
  }
  const plays = possibleCards.map(
    (card) => `play:${card}` as BehaviorActionKey,
  );
  const takes = legalTakeTargets(state, seat).map(
    (target) => `take:${target}` as BehaviorActionKey,
  );
  return Object.freeze([...new Set([...plays, ...takes])].sort(compareText));
}

function actionDistribution(
  occurrences: readonly WeightedOccurrence[],
  behaviorBelief: BehaviorBelief,
  state: PublicInformationState,
  events: ReturnType<typeof activeTimelineEvents>,
  seat: OpponentSeat,
  arm: "hard-only" | "behavioral",
  hardKnownEligible: boolean,
  hardBelief: HardBelief,
): Readonly<{
  distribution: Distribution;
  legalActionKeys: readonly BehaviorActionKey[];
  hardKnown: boolean;
}> {
  const aggregate = new Map<string, number>();
  const legalSets: BehaviorActionKey[][] = [];
  for (const occurrence of occurrences) {
    const observation = createActorObservation(
      {
        publicState: state,
        exactHands: occurrence.world.currentHands,
      },
      seat,
      behaviorBelief.decisionOrdinals[seat],
      events,
    );
    const actions = enumerateBehaviorActions(observation);
    if (actions.length === 0) {
      fail(
        `occurrence ${occurrence.occurrenceIndex.toString()} has no legal action.`,
      );
    }
    const legalActionKeys = actions
      .map((action) =>
        action.kind === "play-card"
          ? (`play:${action.card}` as const)
          : (`take:${action.target}` as const),
      )
      .sort(compareText);
    legalSets.push(legalActionKeys);
    if (arm === "hard-only") {
      const actionProbability = occurrence.hardWeight / legalActionKeys.length;
      for (const actionKey of legalActionKeys) {
        aggregate.set(
          actionKey,
          (aggregate.get(actionKey) ?? 0) + actionProbability,
        );
      }
      continue;
    }

    const distributions = allBehaviorModelDistributions(
      observation,
      behaviorBelief.config,
    );
    const behavioralOccurrence =
      behaviorBelief.worldOccurrences[occurrence.occurrenceIndex];
    if (behavioralOccurrence === undefined) {
      fail("behavior occurrence disappeared during action prediction.");
    }
    for (const modelId of BEHAVIOR_MODEL_IDS) {
      const modelWeight = modelProbability(
        behavioralOccurrence.conditionalModelProbabilities[seat],
        modelId,
      );
      for (const entry of distributions[modelId].probabilities) {
        aggregate.set(
          entry.actionKey,
          (aggregate.get(entry.actionKey) ?? 0) +
            occurrence.behaviorWeight * modelWeight * entry.probability,
        );
      }
    }
  }
  const hardPossibleActions = conservativeHardPossibleActionKeys(
    state,
    seat,
    hardBelief,
  );
  const legalActionKeys = [
    ...new Set([...legalSets.flat(), ...hardPossibleActions]),
  ].sort(compareText);
  for (const actionKey of legalActionKeys) {
    if (!aggregate.has(actionKey)) {
      aggregate.set(actionKey, 0);
    }
  }
  const firstLegalSet = legalSets[0] ?? [];
  const hardKnown =
    hardKnownEligible &&
    legalActionKeys.length === 1 &&
    firstLegalSet.length === 1 &&
    legalSets.every(
      (legalSet) => legalSet.length === 1 && legalSet[0] === firstLegalSet[0],
    );
  return {
    distribution: normalizedDistribution(aggregate),
    legalActionKeys,
    hardKnown,
  };
}

function armDiagnostics(
  occurrences: readonly WeightedOccurrence[],
  arm: "hard-only" | "behavioral",
): Readonly<{
  effectiveSampleSize: number;
  entropyNats: number;
  maximumWorldWeight: number;
}> {
  const weights = occurrences.map((occurrence) =>
    arm === "hard-only" ? occurrence.hardWeight : occurrence.behaviorWeight,
  );
  return {
    effectiveSampleSize: effectiveSampleSize(weights),
    entropyNats: entropy(weights),
    maximumWorldWeight: Math.max(...weights),
  };
}

function assertCheckpoint(
  checkpoint: CalibrationCheckpointMetadata,
  timeline: GameTimeline,
  state: PublicInformationState,
): void {
  for (const [value, label] of [
    [checkpoint.runId, "runId"],
    [checkpoint.evidenceClass, "evidenceClass"],
    [checkpoint.gameId, "gameId"],
    [checkpoint.scenarioId, "scenarioId"],
    [checkpoint.calibrationClusterId, "calibrationClusterId"],
    [checkpoint.checkpointId, "checkpointId"],
    [checkpoint.featureBundleHash, "featureBundleHash"],
    [checkpoint.queryPlanHash, "queryPlanHash"],
    [checkpoint.seedId, "seedId"],
  ] as const) {
    requireNonEmpty(value, label);
  }
  const activeEventCount = activeTimelineEvents(timeline).length;
  if (
    checkpoint.checkpointEventIndex !== activeEventCount ||
    checkpoint.stateVersion !== state.appliedEventCount
  ) {
    fail("checkpoint event index or state version is stale.");
  }
  const currentOpponent = state.turn === "p2" || state.turn === "p3";
  if (
    checkpoint.checkpointTiming === "pre-action" &&
    (!currentOpponent ||
      state.status !== "active" ||
      state.pendingAction !== null)
  ) {
    fail("a pre-action checkpoint must be an active opponent decision.");
  }
}

function pairId(
  checkpoint: CalibrationCheckpointMetadata,
  stateId: string,
  target: CalibrationPredictionRecord["target"],
): string {
  const canonicalTarget =
    target.kind === "query"
      ? { ...target, conditioningProbability: null }
      : target;
  return stableHash({
    schemaVersion: 1,
    protocolId: "eval-v1",
    gameId: checkpoint.gameId,
    stateId,
    checkpointId: checkpoint.checkpointId,
    target: canonicalTarget,
  });
}

function buildRecord(
  input: GenerateCalibrationPredictionsInput,
  state: PublicInformationState,
  stateId: string,
  target: CalibrationPredictionRecord["target"],
  armConditioningProbability: number | null,
  distribution: Distribution,
  hardKnown: boolean,
  arm: "hard-only" | "behavioral",
  method: string,
  occurrences: readonly WeightedOccurrence[],
): CalibrationPredictionRecord {
  const checkpoint = input.checkpoint;
  const pairedId = pairId(checkpoint, stateId, target);
  const diagnostics = armDiagnostics(occurrences, arm);
  return calibrationPredictionRecordSchema.parse({
    schemaVersion: 1,
    protocolId: "eval-v1",
    recordType: "calibration-prediction",
    runId: checkpoint.runId,
    split: checkpoint.split,
    evidenceClass: checkpoint.evidenceClass,
    predictionId: stableHash({
      schemaVersion: 1,
      pairId: pairedId,
      arm,
    }),
    pairId: pairedId,
    gameId: checkpoint.gameId,
    scenarioId: checkpoint.scenarioId,
    calibrationClusterId: checkpoint.calibrationClusterId,
    stateId,
    checkpointId: checkpoint.checkpointId,
    checkpointEventIndex: checkpoint.checkpointEventIndex,
    checkpointTiming: checkpoint.checkpointTiming,
    publicHistoryHash: input.behaviorBelief.historyHash,
    publicStateHash: stableHash(state),
    stateVersion: checkpoint.stateVersion,
    arm,
    target,
    armConditioningProbability,
    distribution,
    hardKnown,
    method,
    worldOccurrences: occurrences.length,
    uniqueWitnesses: new Set(
      occurrences.map((occurrence) => occurrence.world.witnessId),
    ).size,
    ...diagnostics,
    hardWorldSetChecksum: input.hardBelief.diagnostics.worldSetChecksum,
    hardBeliefConfigHash: input.hardBelief.diagnostics.configHash,
    modelBundleHash: input.behaviorBelief.modelHash,
    featureBundleHash: checkpoint.featureBundleHash,
    queryPlanHash: checkpoint.queryPlanHash,
    configHash: input.behaviorBelief.configHash,
    seedId: checkpoint.seedId,
  });
}

export function generateCalibrationPredictions(
  input: GenerateCalibrationPredictionsInput,
): readonly CalibrationPredictionRecord[] {
  requireProbability(
    input.config.conditionalProbabilityFloor,
    "conditionalProbabilityFloor",
  );
  const replay = replayTimeline(input.timeline);
  assertCheckpoint(input.checkpoint, input.timeline, replay.state);
  if (
    stableHash(replay.state) !==
    stableHash(input.hardBelief.evidence.finalState)
  ) {
    fail("hard-belief final state does not match the checkpoint timeline.");
  }
  const occurrences = pairedOccurrences(
    input.hardBelief,
    input.behaviorBelief,
    replay.semanticHash,
  );
  const stateId = stableHash({
    schemaVersion: 1,
    historyHash: replay.semanticHash,
    publicStateHash: stableHash(replay.state),
  });
  const records: CalibrationPredictionRecord[] = [];
  const queryPairs = [
    ...buildQueryPairs(
      replay.state,
      occurrences,
      input.config.conditionalProbabilityFloor,
      input.hardBelief.method === "exact-enumeration",
    ),
  ].sort((left, right) =>
    compareText(left.hardTarget.queryKey, right.hardTarget.queryKey),
  );
  for (const pair of queryPairs) {
    records.push(
      buildRecord(
        input,
        replay.state,
        stateId,
        pair.hardTarget,
        pair.hardConditioningProbability,
        pair.hardDistribution,
        pair.hardKnown,
        "hard-only",
        `uniform-hard-occurrences/${pair.method}`,
        occurrences,
      ),
      buildRecord(
        input,
        replay.state,
        stateId,
        pair.behaviorTarget,
        pair.behaviorConditioningProbability,
        pair.behaviorDistribution,
        pair.hardKnown,
        "behavioral",
        `behavior-weighted-hard-occurrences/${pair.method}`,
        occurrences,
      ),
    );
  }

  if (input.checkpoint.checkpointTiming === "pre-action") {
    const seat = replay.state.turn;
    if (seat !== "p2" && seat !== "p3") {
      fail("pre-action checkpoint lost its opponent actor.");
    }
    const events = activeTimelineEvents(input.timeline);
    const forcedLeadCard = replay.state.trick?.forcedLeadCard;
    const actionHardKnownEligible =
      input.hardBelief.method === "exact-enumeration" ||
      (forcedLeadCard !== null && forcedLeadCard !== undefined) ||
      replay.state.knownOpponentCards[seat].length ===
        replay.state.handCounts[seat];
    const hardAction = actionDistribution(
      occurrences,
      input.behaviorBelief,
      replay.state,
      events,
      seat,
      "hard-only",
      actionHardKnownEligible,
      input.hardBelief,
    );
    const behaviorAction = actionDistribution(
      occurrences,
      input.behaviorBelief,
      replay.state,
      events,
      seat,
      "behavioral",
      actionHardKnownEligible,
      input.hardBelief,
    );
    if (
      hardAction.hardKnown !== behaviorAction.hardKnown ||
      stableHash(hardAction.legalActionKeys) !==
        stableHash(behaviorAction.legalActionKeys)
    ) {
      fail("paired action predictions used different hard-world support.");
    }
    const target = {
      kind: "opponent-action" as const,
      family: "opponent-action" as const,
      actor: seat,
      actorDecisionOrdinal: input.behaviorBelief.decisionOrdinals[seat],
      legalActionKeys: [...hardAction.legalActionKeys],
    };
    records.push(
      buildRecord(
        input,
        replay.state,
        stateId,
        target,
        null,
        hardAction.distribution,
        hardAction.hardKnown,
        "hard-only",
        "uniform-hard-worlds-plus-uniform-legal-actions",
        occurrences,
      ),
      buildRecord(
        input,
        replay.state,
        stateId,
        target,
        null,
        behaviorAction.distribution,
        hardAction.hardKnown,
        "behavioral",
        "posterior-worlds-plus-conditional-actor-models",
        occurrences,
      ),
    );
  }

  return Object.freeze(records);
}
