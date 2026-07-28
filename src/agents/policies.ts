import {
  compareCardsByRank,
  rankValue,
  sortCards,
  suitOf,
  type Card,
  type Suit,
} from "../domain/cards";
import type { RuleConfig } from "../domain/rule-config";
import { orderedSeatsFrom, type Seat } from "../domain/seats";
import type {
  EscapeGroup,
  GamePhase,
  GameStatus,
  TrickPlay,
} from "../public/public-state";
import type { SeededRng } from "../random/keyed-rng";

export const BASELINE_POLICY_IDS = [
  "random",
  "always-high",
  "always-low",
  "shortest-suit",
  "early-high-shedder",
  "power-avoider",
  "documented-basic",
  "noisy-mixture",
  "phase-switch",
] as const;

export type BaselinePolicyId = (typeof BASELINE_POLICY_IDS)[number];
export type PublicSuitStatus = "known-has" | "known-void" | "unknown";

export type PolicyPublicTrick = {
  readonly kind: GamePhase;
  readonly leader: Seat;
  readonly leadSuit: Suit | null;
  readonly participants: readonly Seat[];
  readonly plays: readonly TrickPlay[];
  readonly forcedLeadCard: Card | null;
};

/**
 * The complete information boundary for simulator policies.
 *
 * It intentionally is not a PublicInformationState. In particular, it never
 * carries the live user's exact hand, user-relative known-owner arrays, the
 * unresolved-card pool, or simulator truth. Each actor receives only its own
 * exact cards plus facts visible at the physical table.
 */
export type PolicyObservation = {
  readonly schemaVersion: 1;
  readonly seat: Seat;
  readonly decisionOrdinal: number;
  readonly rules: RuleConfig;
  readonly phase: GamePhase;
  readonly status: GameStatus;
  readonly startingCounts: Readonly<Record<Seat, number>>;
  readonly handCounts: Readonly<Record<Seat, number>>;
  readonly ownHand: readonly Card[];
  readonly legalCards: readonly Card[];
  readonly legalTakeTargets?: readonly Seat[];
  readonly trick: PolicyPublicTrick | null;
  readonly waste: readonly Card[];
  readonly power: Seat | null;
  readonly turn: Seat | null;
  readonly activeSeats: readonly Seat[];
  readonly escapeGroups: readonly EscapeGroup[];
  readonly publicPlays: readonly TrickPlay[];
  readonly currentSuitStatus: Readonly<
    Record<Seat, Readonly<Record<Suit, PublicSuitStatus>>>
  >;
  readonly lastPickup: {
    readonly picker: Seat;
    readonly cards: readonly Card[];
    readonly thullaBy: Seat;
  } | null;
};

export type PolicyChoice = {
  readonly card: Card;
  readonly rationale: string;
};

export type SimulatorPolicy = {
  readonly id: string;
  readonly version: 1;
  chooseTakeTarget?(
    observation: PolicyObservation,
    rng: SeededRng,
  ): Seat | null;
  chooseCard(observation: PolicyObservation, rng: SeededRng): PolicyChoice;
};

const SUIT_ORDER: Readonly<Record<Suit, number>> = {
  clubs: 0,
  diamonds: 1,
  hearts: 2,
  spades: 3,
};

function requireLegalCards(observation: PolicyObservation): readonly Card[] {
  if (observation.legalCards.length === 0) {
    throw new Error(
      `${observation.seat} has no legal card at decision ${observation.decisionOrdinal.toString()}.`,
    );
  }
  return observation.legalCards;
}

function canonicalCards(cards: readonly Card[]): Card[] {
  return sortCards(cards);
}

function forcedChoice(observation: PolicyObservation): PolicyChoice | null {
  const card = observation.legalCards[0];
  return observation.legalCards.length === 1 && card !== undefined
    ? { card, rationale: "forced-singleton-legal-action" }
    : null;
}

function chooseExtreme(
  cardsValue: readonly Card[],
  mode: "high" | "low",
): Card {
  const cards = canonicalCards(cardsValue);
  const first = cards[0];
  if (first === undefined) {
    throw new Error("Cannot choose from an empty card collection.");
  }
  return cards.reduce((best, card) => {
    const delta = compareCardsByRank(card, best);
    return mode === "high"
      ? delta > 0
        ? card
        : best
      : delta < 0
        ? card
        : best;
  }, first);
}

function suitCounts(hand: readonly Card[]): Readonly<Record<Suit, number>> {
  const counts: Record<Suit, number> = {
    clubs: 0,
    diamonds: 0,
    hearts: 0,
    spades: 0,
  };
  for (const card of hand) {
    counts[suitOf(card)] += 1;
  }
  return counts;
}

function chooseShortestSuitCard(
  observation: PolicyObservation,
  rankMode: "high" | "low",
  cardsValue = requireLegalCards(observation),
): Card {
  const counts = suitCounts(observation.ownHand);
  const candidateSuits = [...new Set(cardsValue.map(suitOf))].sort(
    (left, right) =>
      counts[left] - counts[right] || SUIT_ORDER[left] - SUIT_ORDER[right],
  );
  const selectedSuit = candidateSuits[0];
  if (selectedSuit === undefined) {
    throw new Error("Shortest-suit policy received no candidate suit.");
  }
  return chooseExtreme(
    cardsValue.filter((card) => suitOf(card) === selectedSuit),
    rankMode,
  );
}

function currentHighestLeadCard(observation: PolicyObservation): Card | null {
  const leadSuit = observation.trick?.leadSuit;
  if (leadSuit === null || leadSuit === undefined) {
    return null;
  }
  const leadCards =
    observation.trick?.plays
      .map((play) => play.card)
      .filter((card) => suitOf(card) === leadSuit) ?? [];
  return leadCards.length === 0 ? null : chooseExtreme(leadCards, "high");
}

function choosePowerAvoidingCard(observation: PolicyObservation): PolicyChoice {
  const forced = forcedChoice(observation);
  if (forced !== null) {
    return forced;
  }
  const legal = requireLegalCards(observation);
  const trick = observation.trick;
  const leadSuit = trick?.leadSuit;
  const highest = currentHighestLeadCard(observation);

  if (
    trick === null ||
    trick.plays.length === 0 ||
    leadSuit === null ||
    highest === null
  ) {
    return {
      card: chooseExtreme(legal, "low"),
      rationale: "lead-low-to-limit-power-and-pickup-exposure",
    };
  }

  const following = legal.every((card) => suitOf(card) === leadSuit);
  if (!following) {
    return {
      card: chooseExtreme(legal, "high"),
      rationale: "off-suit-cannot-take-power-so-shed-highest",
    };
  }

  const below = legal.filter((card) => rankValue(card) < rankValue(highest));
  if (below.length > 0) {
    return {
      card: chooseExtreme(below, "high"),
      rationale: "highest-card-that-stays-below-current-winner",
    };
  }
  return {
    card: chooseExtreme(legal, "low"),
    rationale: "unavoidable-overtake-with-lowest-winning-card",
  };
}

function compareScores(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function firstCardSuit(cards: readonly Card[]): Suit | null {
  const first = cards[0];
  return first === undefined ? null : suitOf(first);
}

function chooseDocumentedBasicCard(
  observation: PolicyObservation,
): PolicyChoice {
  const forced = forcedChoice(observation);
  if (forced !== null) {
    return forced;
  }
  const legal = requireLegalCards(observation);
  const trick = observation.trick;

  if (trick?.kind === "opening" && trick.plays.length > 0) {
    return {
      card: chooseShortestSuitCard(observation, "high", legal),
      rationale: "opening-waste-high-from-shortest-suit",
    };
  }

  if (trick !== null && trick.plays.length > 0) {
    const leadSuit = trick.leadSuit;
    const following =
      leadSuit !== null && legal.every((card) => suitOf(card) === leadSuit);
    if (following) {
      return choosePowerAvoidingCard(observation);
    }
    return {
      card: chooseShortestSuitCard(observation, "high", legal),
      rationale: "thulla-shed-high-from-shortest-suit",
    };
  }

  const pickedSuit =
    observation.lastPickup?.picker === observation.seat
      ? firstCardSuit(observation.lastPickup.cards)
      : null;
  const counts = suitCounts(observation.ownHand);
  const followers = orderedSeatsFrom(
    observation.seat,
    observation.rules.direction,
    observation.activeSeats,
  ).slice(1);
  const scored = canonicalCards(legal).map((card) => {
    const suit = suitOf(card);
    const immediate = followers[0];
    const immediateVoid =
      immediate !== undefined &&
      observation.currentSuitStatus[immediate][suit] === "known-void";
    const laterVoid = followers
      .slice(1)
      .some(
        (seat) => observation.currentSuitStatus[seat][suit] === "known-void",
      );
    return {
      card,
      score: [
        immediateVoid ? 1 : 0,
        pickedSuit === suit ? 1 : 0,
        laterVoid ? 0 : 1,
        counts[suit],
        rankValue(card),
      ] as const,
    };
  });
  scored.sort((left, right) => compareScores(left.score, right.score));
  const best = scored[0];
  if (best === undefined) {
    throw new Error("Documented-basic policy has no scored lead.");
  }
  return {
    card: best.card,
    rationale: "public-void-pickup-aware-short-suit-low-lead",
  };
}

function makePolicy(
  id: BaselinePolicyId,
  chooser: (observation: PolicyObservation, rng: SeededRng) => PolicyChoice,
): SimulatorPolicy & { readonly id: BaselinePolicyId } {
  return Object.freeze({
    id,
    version: 1 as const,
    chooseCard: chooser,
  });
}

const POLICIES: Readonly<
  Record<BaselinePolicyId, SimulatorPolicy & { readonly id: BaselinePolicyId }>
> = Object.freeze({
  random: makePolicy("random", (observation, rng) => {
    const forced = forcedChoice(observation);
    return (
      forced ?? {
        card: rng.pick(canonicalCards(requireLegalCards(observation))),
        rationale: "uniform-random-legal",
      }
    );
  }),
  "always-high": makePolicy("always-high", (observation) => {
    const forced = forcedChoice(observation);
    return (
      forced ?? {
        card: chooseExtreme(requireLegalCards(observation), "high"),
        rationale: "highest-rank-legal",
      }
    );
  }),
  "always-low": makePolicy("always-low", (observation) => {
    const forced = forcedChoice(observation);
    return (
      forced ?? {
        card: chooseExtreme(requireLegalCards(observation), "low"),
        rationale: "lowest-rank-legal",
      }
    );
  }),
  "shortest-suit": makePolicy("shortest-suit", (observation) => {
    const forced = forcedChoice(observation);
    return (
      forced ?? {
        card: chooseShortestSuitCard(observation, "low"),
        rationale: "lowest-card-from-shortest-legal-suit",
      }
    );
  }),
  "early-high-shedder": makePolicy("early-high-shedder", (observation) => {
    const forced = forcedChoice(observation);
    if (forced !== null) {
      return forced;
    }
    const starting = observation.startingCounts[observation.seat];
    const ownPriorPlays = observation.publicPlays.filter(
      (play) => play.seat === observation.seat,
    ).length;
    const early = ownPriorPlays < Math.ceil(starting / 2);
    return {
      card: chooseExtreme(
        requireLegalCards(observation),
        early ? "high" : "low",
      ),
      rationale: early
        ? "early-phase-high-card-shedding"
        : "late-phase-low-card-play",
    };
  }),
  "power-avoider": makePolicy("power-avoider", (observation) =>
    choosePowerAvoidingCard(observation),
  ),
  "documented-basic": makePolicy("documented-basic", (observation) =>
    chooseDocumentedBasicCard(observation),
  ),
  "noisy-mixture": makePolicy("noisy-mixture", (observation, rng) => {
    const forced = forcedChoice(observation);
    if (forced !== null) {
      return forced;
    }
    const bucket = rng.fork("component").nextInt(100);
    const component: BaselinePolicyId =
      bucket < 40
        ? "documented-basic"
        : bucket < 50
          ? "always-high"
          : bucket < 60
            ? "always-low"
            : bucket < 70
              ? "shortest-suit"
              : bucket < 80
                ? "early-high-shedder"
                : bucket < 90
                  ? "power-avoider"
                  : "random";
    const selected = POLICIES[component].chooseCard(
      observation,
      rng.fork("component-action", component),
    );
    return {
      ...selected,
      rationale: `noisy-mixture-${component}:${selected.rationale}`,
    };
  }),
  "phase-switch": makePolicy("phase-switch", (observation) => {
    const forced = forcedChoice(observation);
    if (forced !== null) {
      return forced;
    }
    if (observation.activeSeats.length === 3) {
      return {
        card: chooseExtreme(requireLegalCards(observation), "high"),
        rationale: "three-player-always-high-phase",
      };
    }
    const selected = choosePowerAvoidingCard(observation);
    return {
      ...selected,
      rationale: `heads-up-power-avoider-phase:${selected.rationale}`,
    };
  }),
});

export function getBaselinePolicy(
  id: BaselinePolicyId,
): SimulatorPolicy & { readonly id: BaselinePolicyId } {
  return POLICIES[id];
}

export function baselinePolicyDefinitions(): readonly {
  readonly id: BaselinePolicyId;
  readonly version: 1;
}[] {
  return BASELINE_POLICY_IDS.map((id) => ({ id, version: 1 as const }));
}
