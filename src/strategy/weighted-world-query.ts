import { suitOf, type Suit } from "../domain/cards";
import type { OpponentSeat } from "../domain/seats";
import type { BehaviorWorldOccurrence } from "../inference/behavior-belief";
import type { HiddenWorld, SuitStatus } from "../inference/types";

const NORMALIZATION_TOLERANCE = 1e-10;

type SuitWorld = Pick<HiddenWorld, "witnessId" | "currentHands">;
type WeightedOccurrence = Pick<
  BehaviorWorldOccurrence,
  "occurrenceIndex" | "witnessId" | "weight"
>;

export type WeightedSuitVoidResult = {
  readonly seat: OpponentSeat;
  readonly suit: Suit;
  readonly probability: number;
  readonly voidWorldOccurrences: number;
  readonly worldOccurrences: number;
  readonly counterfactualRange: readonly [0 | 1, 0 | 1];
  readonly certainty:
    "hard-known-void" | "hard-known-has" | "soft" | "sample-degenerate";
};

export class WeightedWorldQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeightedWorldQueryError";
  }
}

/**
 * Computes a suit-void probability from the same correlated world
 * occurrences and behavioral weights used by inference. A probability of
 * zero or one is called hard only when chronological hard evidence says so;
 * a degenerate finite sample is not promoted to a categorical fact.
 */
export function queryBehaviorWeightedSuitVoid(input: {
  readonly worlds: readonly SuitWorld[];
  readonly occurrences: readonly WeightedOccurrence[];
  readonly seat: OpponentSeat;
  readonly suit: Suit;
  readonly hardStatus: SuitStatus;
}): WeightedSuitVoidResult {
  if (
    input.worlds.length === 0 ||
    input.worlds.length !== input.occurrences.length
  ) {
    throw new WeightedWorldQueryError(
      "Weighted suit query requires one nonempty occurrence per world.",
    );
  }

  let totalWeight = 0;
  let voidWeight = 0;
  let voidWorldOccurrences = 0;
  let minimumIndicator: 0 | 1 = 1;
  let maximumIndicator: 0 | 1 = 0;

  for (const [index, world] of input.worlds.entries()) {
    const occurrence = input.occurrences[index];
    if (
      occurrence === undefined ||
      occurrence.occurrenceIndex !== index ||
      occurrence.witnessId !== world.witnessId
    ) {
      throw new WeightedWorldQueryError(
        `Occurrence ${index.toString()} does not align with its hard world.`,
      );
    }
    if (!Number.isFinite(occurrence.weight) || occurrence.weight <= 0) {
      throw new WeightedWorldQueryError(
        `Occurrence ${index.toString()} must have a finite positive weight.`,
      );
    }

    const isVoid = !world.currentHands[input.seat].some(
      (card) => suitOf(card) === input.suit,
    );
    const indicator: 0 | 1 = isVoid ? 1 : 0;
    totalWeight += occurrence.weight;
    voidWeight += indicator * occurrence.weight;
    voidWorldOccurrences += indicator;
    minimumIndicator = Math.min(minimumIndicator, indicator) as 0 | 1;
    maximumIndicator = Math.max(maximumIndicator, indicator) as 0 | 1;
  }

  if (Math.abs(totalWeight - 1) > NORMALIZATION_TOLERANCE) {
    throw new WeightedWorldQueryError(
      `Behavioral occurrence weights sum to ${totalWeight.toString()}, not one.`,
    );
  }

  const probability = voidWeight / totalWeight;
  if (input.hardStatus === "known-void" && probability !== 1) {
    throw new WeightedWorldQueryError(
      "Hard known-void evidence conflicts with a non-void world.",
    );
  }
  if (input.hardStatus === "known-has" && probability !== 0) {
    throw new WeightedWorldQueryError(
      "Hard known-has evidence conflicts with a void world.",
    );
  }

  const certainty =
    input.hardStatus === "known-void"
      ? ("hard-known-void" as const)
      : input.hardStatus === "known-has"
        ? ("hard-known-has" as const)
        : probability > 0 && probability < 1
          ? ("soft" as const)
          : ("sample-degenerate" as const);

  return {
    seat: input.seat,
    suit: input.suit,
    probability,
    voidWorldOccurrences,
    worldOccurrences: input.worlds.length,
    counterfactualRange: [minimumIndicator, maximumIndicator],
    certainty,
  };
}
