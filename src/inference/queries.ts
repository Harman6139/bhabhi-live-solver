import { FULL_DECK, suitOf, type Card, type Suit } from "../domain/cards";
import type { Seat } from "../domain/seats";
import {
  OWNER_NONE,
  OWNER_P2,
  OWNER_P3,
  countOwnerAssignments,
  type OwnerMask,
} from "./combinatorics";
import { HardInferenceError } from "./error";
import { constraintOwnerMask } from "./hidden-world";
import type {
  ExactProbability,
  HardBelief,
  HardEvidence,
  HiddenCardConstraint,
  HiddenWorld,
  SuitLengthDistribution,
  WorldPredicateEstimate,
} from "./types";

export type OwnershipClaim = {
  readonly seat: Seat;
  readonly card: Card;
};

function exactProbability(
  numerator: bigint,
  denominator: bigint,
): ExactProbability {
  if (denominator <= 0n || numerator < 0n || numerator > denominator) {
    throw new HardInferenceError(
      "INVARIANT_VIOLATION",
      "Exact probability received invalid support counts.",
      {
        details: {
          numerator: numerator.toString(),
          denominator: denominator.toString(),
        },
      },
    );
  }
  return {
    quality: "exact",
    numerator: numerator.toString(),
    denominator: denominator.toString(),
    value: Number(numerator) / Number(denominator),
  };
}

function exactCurrentSeat(
  evidence: HardEvidence,
  card: Card,
): Seat | "public" | null {
  const state = evidence.finalState;
  if (state.userHand.includes(card)) {
    return "user";
  }
  if (state.knownOpponentCards.p2.includes(card)) {
    return "p2";
  }
  if (state.knownOpponentCards.p3.includes(card)) {
    return "p3";
  }
  if (state.unresolvedCards.includes(card)) {
    return null;
  }
  return "public";
}

function projectedMask(
  constraint: HiddenCardConstraint,
  seat: Seat,
): OwnerMask {
  let mask: OwnerMask = OWNER_NONE;
  if (
    constraint.origins.p2.allowed &&
    constraint.origins.p2.currentLocation === seat
  ) {
    mask = (mask | OWNER_P2) as OwnerMask;
  }
  if (
    constraint.origins.p3.allowed &&
    constraint.origins.p3.currentLocation === seat
  ) {
    mask = (mask | OWNER_P3) as OwnerMask;
  }
  return mask;
}

function numeratorForClaims(
  evidence: HardEvidence,
  claims: readonly OwnershipClaim[],
): bigint {
  const claimByCard = new Map<Card, Seat>();
  for (const claim of claims) {
    if (!FULL_DECK.includes(claim.card)) {
      return 0n;
    }
    const existing = claimByCard.get(claim.card);
    if (existing !== undefined && existing !== claim.seat) {
      return 0n;
    }
    claimByCard.set(claim.card, claim.seat);
  }

  const masks = evidence.hiddenCards.map(constraintOwnerMask);
  for (const [card, seat] of claimByCard) {
    const exactSeat = exactCurrentSeat(evidence, card);
    if (exactSeat !== null) {
      if (exactSeat !== seat) {
        return 0n;
      }
      continue;
    }
    if (seat === "user") {
      return 0n;
    }
    const index = evidence.hiddenCards.findIndex(
      (constraint) => constraint.card === card,
    );
    const constraint = evidence.hiddenCards[index];
    if (index < 0 || constraint === undefined) {
      return 0n;
    }
    const existingMask = masks[index];
    if (existingMask === undefined) {
      return 0n;
    }
    masks[index] = (existingMask &
      projectedMask(constraint, seat)) as OwnerMask;
  }
  return countOwnerAssignments(masks, evidence.startingCounts.p2);
}

export function jointOwnershipProbability(
  evidence: HardEvidence,
  claims: readonly OwnershipClaim[],
): ExactProbability {
  const denominator = BigInt(evidence.support.totalWorldCount);
  return exactProbability(numeratorForClaims(evidence, claims), denominator);
}

export function ownershipProbability(
  evidence: HardEvidence,
  seat: Seat,
  card: Card,
): ExactProbability {
  return jointOwnershipProbability(evidence, [{ seat, card }]);
}

export function conditionalOwnershipProbability(
  evidence: HardEvidence,
  claims: readonly OwnershipClaim[],
  given: readonly OwnershipClaim[],
): ExactProbability {
  const denominator = numeratorForClaims(evidence, given);
  if (denominator === 0n) {
    throw new HardInferenceError(
      "NO_VALID_WORLDS",
      "The requested ownership condition has zero hard support.",
      { details: { claims, given } },
    );
  }
  const numerator = numeratorForClaims(evidence, [...given, ...claims]);
  return exactProbability(numerator, denominator);
}

function dpKey(p2Used: number, suitLength: number): string {
  return `${p2Used}:${suitLength}`;
}

function parseDpKey(key: string): [p2Used: number, suitLength: number] {
  const [p2Text, lengthText] = key.split(":");
  return [Number(p2Text), Number(lengthText)];
}

function exactKnownSuitCount(
  evidence: HardEvidence,
  seat: Seat,
  suit: Suit,
): number {
  const cards =
    seat === "user"
      ? evidence.finalState.userHand
      : evidence.finalState.knownOpponentCards[seat];
  return cards.filter((card) => suitOf(card) === suit).length;
}

export function suitLengthDistribution(
  evidence: HardEvidence,
  seat: Seat,
  suit: Suit,
): SuitLengthDistribution {
  const denominator = BigInt(evidence.support.totalWorldCount);
  const exactCount = exactKnownSuitCount(evidence, seat, suit);
  if (seat === "user") {
    return {
      seat,
      suit,
      status: exactCount === 0 ? "known-void" : "known-has",
      expectedLength: exactCount,
      probabilities: [
        {
          ...exactProbability(denominator, denominator),
          length: exactCount,
        },
      ],
    };
  }

  const unresolved = new Set(evidence.finalState.unresolvedCards);
  let support = new Map<string, bigint>([[dpKey(0, 0), 1n]]);
  for (const constraint of evidence.hiddenCards) {
    const next = new Map<string, bigint>();
    for (const [key, ways] of support) {
      const [p2Used, uncertainSuitLength] = parseDpKey(key);
      for (const owner of ["p2", "p3"] as const) {
        const origin = constraint.origins[owner];
        if (!origin.allowed) {
          continue;
        }
        const nextP2 = p2Used + (owner === "p2" ? 1 : 0);
        const contributes =
          unresolved.has(constraint.card) &&
          suitOf(constraint.card) === suit &&
          origin.currentLocation === seat;
        const nextLength = uncertainSuitLength + (contributes ? 1 : 0);
        const nextKey = dpKey(nextP2, nextLength);
        next.set(nextKey, (next.get(nextKey) ?? 0n) + ways);
      }
    }
    support = next;
  }

  const byLength = new Map<number, bigint>();
  for (const [key, ways] of support) {
    const [p2Used, uncertainSuitLength] = parseDpKey(key);
    if (p2Used !== evidence.startingCounts.p2) {
      continue;
    }
    const length = exactCount + uncertainSuitLength;
    byLength.set(length, (byLength.get(length) ?? 0n) + ways);
  }
  const accounted = [...byLength.values()].reduce(
    (total, ways) => total + ways,
    0n,
  );
  if (accounted !== denominator) {
    throw new HardInferenceError(
      "INVARIANT_VIOLATION",
      "Suit-length support does not match the hard world count.",
      {
        details: {
          seat,
          suit,
          accounted: accounted.toString(),
          denominator: denominator.toString(),
        },
      },
    );
  }
  const probabilities = [...byLength.entries()]
    .sort(([left], [right]) => left - right)
    .map(([length, ways]) => ({
      ...exactProbability(ways, denominator),
      length,
    }));
  const voidWays = byLength.get(0) ?? 0n;
  const status =
    voidWays === denominator
      ? ("known-void" as const)
      : voidWays === 0n
        ? ("known-has" as const)
        : ("unknown" as const);
  const expectedNumerator = [...byLength.entries()].reduce(
    (total, [length, ways]) => total + BigInt(length) * ways,
    0n,
  );
  return {
    seat,
    suit,
    status,
    expectedLength: Number(expectedNumerator) / Number(denominator),
    probabilities,
  };
}

export function estimateWorldPredicate(
  belief: HardBelief,
  predicate: (world: HiddenWorld) => boolean,
): WorldPredicateEstimate {
  const successes = belief.worlds.filter(predicate).length;
  const trials = belief.worlds.length;
  if (trials === 0) {
    throw new HardInferenceError(
      "INVARIANT_VIOLATION",
      "Belief contains no materialized worlds.",
    );
  }
  return {
    quality: belief.method === "exact-enumeration" ? "exact" : "sample",
    successes,
    trials,
    value: successes / trials,
  };
}
