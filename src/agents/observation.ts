import {
  ACE_OF_SPADES,
  SUITS,
  suitOf,
  type Card,
  type Suit,
} from "../domain/cards";
import { SEATS, type Seat } from "../domain/seats";
import type { GameEvent } from "../events/game-events";
import type {
  PublicInformationState,
  RuleEffect,
  TrickPlay,
} from "../public/public-state";
import {
  legalCardsForExactHand,
  legalTakeTargets,
} from "../rules/legal-actions";
import type { PolicyObservation, PublicSuitStatus } from "./policies";

export type ActorObservationSource = {
  readonly publicState: PublicInformationState;
  readonly exactHands: Readonly<Record<Seat, readonly Card[]>>;
};

function recentPickup(
  effects: readonly RuleEffect[],
): PolicyObservation["lastPickup"] {
  for (let index = effects.length - 1; index >= 0; index -= 1) {
    const effect = effects[index];
    if (effect?.type === "trick-wasted") {
      return null;
    }
    if (effect?.type === "trick-picked-up") {
      return {
        picker: effect.picker,
        cards: [...effect.cards],
        thullaBy: effect.thullaBy,
      };
    }
  }
  return null;
}

function publicPlayHistory(effects: readonly RuleEffect[]): TrickPlay[] {
  return effects.flatMap((effect): TrickPlay[] =>
    effect.type === "card-played"
      ? [
          {
            seat: effect.seat,
            card: effect.card,
            offSuit: effect.offSuit,
            eventIndex: effect.eventIndex,
          },
        ]
      : [],
  );
}

function publicSuitStatuses(
  source: ActorObservationSource,
  observingSeat: Seat,
  events?: readonly GameEvent[],
): Record<Seat, Record<Suit, PublicSuitStatus>> {
  const statuses = Object.fromEntries(
    SEATS.map((seat) => [
      seat,
      Object.fromEntries(
        SUITS.map((suit) => [suit, "unknown" as const]),
      ) as Record<Suit, PublicSuitStatus>,
    ]),
  ) as Record<Seat, Record<Suit, PublicSuitStatus>>;
  const publicKnown = Object.fromEntries(
    SEATS.map((seat) => [
      seat,
      Object.fromEntries(
        SUITS.map((suit) => [suit, new Set<Card>()]),
      ) as Record<Suit, Set<Card>>,
    ]),
  ) as Record<Seat, Record<Suit, Set<Card>>>;

  const removeKnown = (seat: Seat, card: Card): void => {
    const suit = suitOf(card);
    const known = publicKnown[seat][suit];
    if (known.delete(card) && known.size === 0) {
      statuses[seat][suit] = "unknown";
    }
  };
  const addKnown = (seat: Seat, card: Card): void => {
    const suit = suitOf(card);
    publicKnown[seat][suit].add(card);
    statuses[seat][suit] = "known-has";
  };
  let ambiguousPrivateDraw: {
    readonly source: Seat;
    readonly recipient: Seat;
    readonly priorKnownSourceCards: readonly Card[];
  } | null = null;

  if (events === undefined) {
    for (const effect of source.publicState.effects) {
      if (effect.type === "card-played") {
        removeKnown(effect.seat, effect.card);
      } else if (effect.type === "thulla") {
        statuses[effect.seat][effect.leadSuit] = "known-void";
        publicKnown[effect.seat][effect.leadSuit].clear();
      } else if (effect.type === "trick-picked-up") {
        for (const card of effect.cards) {
          addKnown(effect.picker, card);
        }
      }
    }
  } else {
    const effectsByEvent = new Map<number, RuleEffect[]>();
    for (const effect of source.publicState.effects) {
      const bucket = effectsByEvent.get(effect.eventIndex) ?? [];
      bucket.push(effect);
      effectsByEvent.set(effect.eventIndex, bucket);
    }
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex];
      if (event === undefined) {
        continue;
      }
      switch (event.type) {
        case "game-created":
          addKnown(event.aceSpadesHolder, ACE_OF_SPADES);
          break;
        case "card-played":
          if (
            ambiguousPrivateDraw !== null &&
            event.seat === ambiguousPrivateDraw.recipient
          ) {
            // A player-draw card becomes a forced public lead. Once its public
            // identity is observed, every previously known source card except
            // that card is known to have remained at the source.
            for (const card of ambiguousPrivateDraw.priorKnownSourceCards) {
              if (card !== event.card) {
                addKnown(ambiguousPrivateDraw.source, card);
              }
            }
            ambiguousPrivateDraw = null;
          }
          removeKnown(event.seat, event.card);
          break;
        case "waste-card-drawn":
          addKnown(event.seat, event.card);
          break;
        case "player-card-drawn":
          if (observingSeat === event.source || observingSeat === event.seat) {
            removeKnown(event.source, event.card);
            addKnown(event.seat, event.card);
          } else {
            // An uninvolved actor sees only the count transfer. The exact
            // source card is user-relative/private, so prior known-card
            // locations at the source are no longer certain. Preserve proven
            // voids and conservatively downgrade known-has evidence.
            ambiguousPrivateDraw = {
              source: event.source,
              recipient: event.seat,
              priorKnownSourceCards: SUITS.flatMap((suit) => [
                ...publicKnown[event.source][suit],
              ]),
            };
            for (const suit of SUITS) {
              publicKnown[event.source][suit].clear();
              if (statuses[event.source][suit] === "known-has") {
                statuses[event.source][suit] = "unknown";
              }
            }
          }
          break;
        case "hand-taken":
          for (const suit of SUITS) {
            for (const card of publicKnown[event.target][suit]) {
              addKnown(event.actor, card);
            }
            publicKnown[event.target][suit].clear();
            statuses[event.target][suit] = "known-void";
          }
          if (observingSeat === event.actor || observingSeat === event.target) {
            for (const card of event.revealedCards) {
              addKnown(event.actor, card);
            }
          }
          break;
      }
      for (const effect of effectsByEvent.get(eventIndex) ?? []) {
        if (effect.type === "thulla") {
          statuses[effect.seat][effect.leadSuit] = "known-void";
          publicKnown[effect.seat][effect.leadSuit].clear();
        } else if (effect.type === "trick-picked-up") {
          for (const card of effect.cards) {
            addKnown(effect.picker, card);
          }
        }
      }
    }
  }

  for (const suit of SUITS) {
    statuses[observingSeat][suit] = source.exactHands[observingSeat].some(
      (card) => suitOf(card) === suit,
    )
      ? "known-has"
      : "known-void";
  }
  return statuses;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function createActorObservation(
  sourceValue: ActorObservationSource,
  seat: Seat,
  decisionOrdinal: number,
  events?: readonly GameEvent[],
): PolicyObservation {
  // Every exposed collection is copied before the result is frozen. Keeping
  // this read-only source avoids cloning all hidden hands and accumulated rule
  // effects at every simulated decision.
  const source = sourceValue;
  const state = source.publicState;
  const observation: PolicyObservation = {
    schemaVersion: 1,
    seat,
    decisionOrdinal,
    rules: structuredClone(state.rules),
    phase: state.phase,
    status: state.status,
    startingCounts: structuredClone(state.startingCounts),
    handCounts: structuredClone(state.handCounts),
    ownHand: [...source.exactHands[seat]],
    legalCards: legalCardsForExactHand(state, seat, source.exactHands[seat]),
    legalTakeTargets: legalTakeTargets(state, seat),
    trick:
      state.trick === null
        ? null
        : {
            kind: state.trick.kind,
            leader: state.trick.leader,
            leadSuit: state.trick.leadSuit,
            participants: [...state.trick.participants],
            plays: structuredClone(state.trick.plays),
            forcedLeadCard: state.trick.forcedLeadCard,
          },
    waste: [...state.waste],
    power: state.power,
    turn: state.turn,
    activeSeats: [...state.activeSeats],
    escapeGroups: structuredClone(state.escapeGroups),
    publicPlays: publicPlayHistory(state.effects),
    currentSuitStatus: publicSuitStatuses(source, seat, events),
    lastPickup: recentPickup(state.effects),
  };
  return deepFreeze(observation);
}
