import {
  FULL_DECK,
  assertUniqueCards,
  sortCards,
  type Card,
} from "../domain/cards";
import { type OpponentSeat, type Seat } from "../domain/seats";
import { stableHash, stableStringify } from "../events/stable-hash";
import { unrankCombination, type OwnerMask } from "./combinatorics";
import { HardInferenceError } from "./error";
import type { HardEvidence, HiddenCardConstraint, HiddenWorld } from "./types";

const OPPONENTS = ["p2", "p3"] as const;

export function constraintOwnerMask(
  constraint: HiddenCardConstraint,
): OwnerMask {
  return ((constraint.origins.p2.allowed ? 1 : 0) |
    (constraint.origins.p3.allowed ? 2 : 0)) as OwnerMask;
}

function constraintFor(
  evidence: HardEvidence,
  card: Card,
): HiddenCardConstraint {
  const constraint = evidence.hiddenCards.find((entry) => entry.card === card);
  if (constraint === undefined) {
    throw new HardInferenceError(
      "INVARIANT_VIOLATION",
      `${card} has no hidden-card constraint.`,
      { details: { card, historyHash: evidence.historyHash } },
    );
  }
  return constraint;
}

function initialOwnerFor(
  constraint: HiddenCardConstraint,
  initialP2: ReadonlySet<Card>,
): OpponentSeat {
  return initialP2.has(constraint.card) ? "p2" : "p3";
}

export function hiddenWorldAtRank(
  evidence: HardEvidence,
  rank: bigint,
): HiddenWorld {
  const total = BigInt(evidence.support.totalWorldCount);
  if (rank < 0n || rank >= total) {
    throw new HardInferenceError(
      "INVALID_CONFIG",
      `World rank ${rank.toString()} is outside [0, ${total.toString()}).`,
      {
        details: {
          rank: rank.toString(),
          totalWorldCount: total.toString(),
        },
      },
    );
  }

  const forcedP2 = evidence.hiddenCards.filter(
    (constraint) => constraintOwnerMask(constraint) === 1,
  );
  const flexible = evidence.hiddenCards.filter(
    (constraint) => constraintOwnerMask(constraint) === 3,
  );
  const remainingP2 = evidence.startingCounts.p2 - forcedP2.length;
  const selectedFlexible = new Set(
    unrankCombination(flexible.length, remainingP2, rank),
  );
  const initialP2 = new Set<Card>(
    forcedP2.map((constraint) => constraint.card),
  );
  flexible.forEach((constraint, index) => {
    if (selectedFlexible.has(index)) {
      initialP2.add(constraint.card);
    }
  });

  const initialHands: Record<OpponentSeat, Card[]> = {
    p2: [],
    p3: [],
  };
  for (const constraint of evidence.hiddenCards) {
    initialHands[initialOwnerFor(constraint, initialP2)].push(constraint.card);
  }

  const currentHands: Record<Seat, Card[]> = {
    user: [...evidence.finalState.userHand],
    p2: [...evidence.finalState.knownOpponentCards.p2],
    p3: [...evidence.finalState.knownOpponentCards.p3],
  };
  for (const card of evidence.finalState.unresolvedCards) {
    const constraint = constraintFor(evidence, card);
    const owner = initialOwnerFor(constraint, initialP2);
    const location = constraint.origins[owner].currentLocation;
    if (location !== "p2" && location !== "p3") {
      throw new HardInferenceError(
        "INVARIANT_VIOLATION",
        `${card} projects to ${location ?? "no location"} instead of a current opponent hand.`,
        {
          details: {
            card,
            initialOwner: owner,
            currentLocation: location,
          },
        },
      );
    }
    currentHands[location].push(card);
  }

  const sortedInitial = {
    p2: sortCards(initialHands.p2),
    p3: sortCards(initialHands.p3),
  };
  const sortedCurrent = {
    user: sortCards(currentHands.user),
    p2: sortCards(currentHands.p2),
    p3: sortCards(currentHands.p3),
  };
  const world: HiddenWorld = {
    schemaVersion: 1,
    historyHash: evidence.historyHash,
    witnessId: stableHash({
      schemaVersion: 1,
      historyHash: evidence.historyHash,
      initialP2: sortedInitial.p2,
    }),
    initialHands: sortedInitial,
    currentHands: sortedCurrent,
    multiplicity: "1",
  };
  assertHiddenWorldInvariant(world, evidence);
  return world;
}

function sameCards(left: readonly Card[], right: readonly Card[]): boolean {
  const leftSorted = sortCards(left);
  const rightSorted = sortCards(right);
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((card, index) => card === rightSorted[index])
  );
}

function failInvariant(
  evidence: HardEvidence,
  message: string,
  details: Readonly<Record<string, unknown>>,
): never {
  throw new HardInferenceError("INVARIANT_VIOLATION", message, {
    details: { historyHash: evidence.historyHash, ...details },
  });
}

export function assertHiddenWorldInvariant(
  world: HiddenWorld,
  evidence: HardEvidence,
): void {
  if (world.historyHash !== evidence.historyHash) {
    failInvariant(evidence, "Hidden world has a stale public-history hash.", {
      worldHistoryHash: world.historyHash,
    });
  }

  const initialHidden = FULL_DECK.filter(
    (card) => !evidence.initialUserHand.includes(card),
  );
  const initialOpponentCards = [
    ...world.initialHands.p2,
    ...world.initialHands.p3,
  ];
  try {
    assertUniqueCards(initialOpponentCards, "hidden-world initial hands");
  } catch (cause) {
    failInvariant(evidence, "Initial opponent hands contain a duplicate.", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (
    !sameCards(initialOpponentCards, initialHidden) ||
    world.initialHands.p2.length !== evidence.startingCounts.p2 ||
    world.initialHands.p3.length !== evidence.startingCounts.p3
  ) {
    failInvariant(
      evidence,
      "Initial opponent hands do not partition the hidden starting cards with exact slots.",
      {
        p2Count: world.initialHands.p2.length,
        p3Count: world.initialHands.p3.length,
      },
    );
  }

  const initialP2 = new Set(world.initialHands.p2);
  for (const constraint of evidence.hiddenCards) {
    const owner = initialOwnerFor(constraint, initialP2);
    if (!constraint.origins[owner].allowed) {
      failInvariant(
        evidence,
        `${constraint.card} uses an eliminated initial owner.`,
        { card: constraint.card, initialOwner: owner },
      );
    }
  }

  for (const seat of ["user", "p2", "p3"] as const) {
    if (
      world.currentHands[seat].length !== evidence.finalState.handCounts[seat]
    ) {
      failInvariant(
        evidence,
        `${seat} world hand count differs from the public count.`,
        {
          seat,
          worldCount: world.currentHands[seat].length,
          publicCount: evidence.finalState.handCounts[seat],
        },
      );
    }
  }
  if (!sameCards(world.currentHands.user, evidence.finalState.userHand)) {
    failInvariant(
      evidence,
      "Hidden world changes the user's exact current hand.",
      {},
    );
  }
  for (const seat of OPPONENTS) {
    if (
      !evidence.finalState.knownOpponentCards[seat].every((card) =>
        world.currentHands[seat].includes(card),
      )
    ) {
      failInvariant(
        evidence,
        `Hidden world omits exact known ownership for ${seat}.`,
        { seat },
      );
    }
  }

  for (const card of evidence.finalState.unresolvedCards) {
    const inP2 = world.currentHands.p2.includes(card);
    const inP3 = world.currentHands.p3.includes(card);
    if (inP2 === inP3) {
      failInvariant(
        evidence,
        `${card} is not assigned to exactly one opponent.`,
        { card, inP2, inP3 },
      );
    }
    const constraint = constraintFor(evidence, card);
    const owner = initialOwnerFor(constraint, initialP2);
    const projected = constraint.origins[owner].currentLocation;
    if ((projected === "p2") !== inP2 || (projected === "p3") !== inP3) {
      failInvariant(
        evidence,
        `${card} current ownership contradicts its chronological projection.`,
        { card, initialOwner: owner, projected },
      );
    }
  }

  const tableCards =
    evidence.finalState.trick?.plays.map((play) => play.card) ?? [];
  const pendingCards = evidence.finalState.pendingAction?.excludedTrick ?? [];
  const currentLocations = [
    ...world.currentHands.user,
    ...world.currentHands.p2,
    ...world.currentHands.p3,
    ...tableCards,
    ...evidence.finalState.waste,
    ...pendingCards,
  ];
  try {
    assertUniqueCards(currentLocations, "hidden-world current locations");
  } catch (cause) {
    failInvariant(evidence, "Current hidden world duplicates a card.", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (!sameCards(currentLocations, FULL_DECK)) {
    failInvariant(
      evidence,
      `Hidden world accounts for ${currentLocations.length} cards instead of all 52.`,
      { accountedCards: currentLocations.length },
    );
  }
}

export function currentHandsKey(world: HiddenWorld): string {
  return stableStringify({
    user: world.currentHands.user,
    p2: world.currentHands.p2,
    p3: world.currentHands.p3,
  });
}
