import type { PolicyObservation, PublicSuitStatus } from "../agents/policies";
import {
  SUITS,
  sortCards,
  suitOf,
  type Card,
  type Suit,
} from "../domain/cards";
import { SEATS, type Seat } from "../domain/seats";
import { stableHash, stableStringify } from "../events/stable-hash";
import type {
  PublicInformationState,
  RuleEffect,
} from "../public/public-state";
import { assertPublicStateInvariant } from "../rules/state-invariant";
import {
  AdvancedSearchContractError,
  USER_OBSERVABLE_KEY_VERSION,
  type UserObservablePolicyMemory,
  type UserObservableStateKey,
} from "./advanced-types";

const SUIT_STATUS_VALUES = new Set<PublicSuitStatus>([
  "known-has",
  "known-void",
  "unknown",
]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function invalidObservable(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): never {
  throw new AdvancedSearchContractError(
    "INVALID_OBSERVABLE_STATE",
    message,
    details,
    cause === undefined ? undefined : { cause },
  );
}

function nonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidObservable(`${label} must be a nonnegative safe integer.`, {
      label,
      value,
    });
  }
  return value;
}

function cloneSuitStatuses(
  statuses: PolicyObservation["currentSuitStatus"],
): UserObservablePolicyMemory["currentSuitStatus"] {
  return Object.fromEntries(
    SEATS.map((seat) => [
      seat,
      Object.fromEntries(
        SUITS.map((suit) => {
          const status = statuses[seat][suit];
          if (!SUIT_STATUS_VALUES.has(status)) {
            invalidObservable("Policy memory has an invalid suit status.", {
              seat,
              suit,
              status,
            });
          }
          return [suit, status];
        }),
      ) as Record<Suit, PublicSuitStatus>,
    ]),
  ) as Record<Seat, Record<Suit, PublicSuitStatus>>;
}

export function createUserObservablePolicyMemory(input: {
  readonly observation: PolicyObservation;
  readonly decisionOrdinals: Readonly<Record<Seat, number>>;
}): UserObservablePolicyMemory {
  const { observation, decisionOrdinals } = input;
  if (observation.seat !== "user") {
    invalidObservable("User policy memory requires a user observation.", {
      seat: observation.seat,
    });
  }
  const normalizedOrdinals = Object.fromEntries(
    SEATS.map((seat) => [
      seat,
      nonnegativeSafeInteger(
        decisionOrdinals[seat],
        `decisionOrdinals.${seat}`,
      ),
    ]),
  ) as Record<Seat, number>;
  if (normalizedOrdinals.user !== observation.decisionOrdinal) {
    invalidObservable(
      "User observation ordinal does not match policy memory.",
      {
        observationOrdinal: observation.decisionOrdinal,
        memoryOrdinal: normalizedOrdinals.user,
      },
    );
  }
  const priorPlayCounts = Object.fromEntries(
    SEATS.map((seat) => [
      seat,
      observation.publicPlays.filter((play) => play.seat === seat).length,
    ]),
  ) as Record<Seat, number>;
  return deepFreeze({
    schemaVersion: 1,
    decisionOrdinals: normalizedOrdinals,
    priorPlayCounts,
    currentSuitStatus: cloneSuitStatuses(observation.currentSuitStatus),
    lastPickup:
      observation.lastPickup === null
        ? null
        : {
            picker: observation.lastPickup.picker,
            cards: [...observation.lastPickup.cards],
            thullaBy: observation.lastPickup.thullaBy,
          },
  });
}

function decisionOrdinalsFromEffects(
  effects: readonly RuleEffect[],
): Readonly<Record<Seat, number>> {
  const counts: Record<Seat, number> = { user: 0, p2: 0, p3: 0 };
  for (const effect of effects) {
    if (effect.type === "card-played") {
      counts[effect.seat] += 1;
    } else if (effect.type === "hand-taken") {
      counts[effect.actor] += 1;
    }
  }
  return counts;
}

function playCountsFromEffects(
  effects: readonly RuleEffect[],
): Readonly<Record<Seat, number>> {
  const counts: Record<Seat, number> = { user: 0, p2: 0, p3: 0 };
  for (const effect of effects) {
    if (effect.type === "card-played") {
      counts[effect.seat] += 1;
    }
  }
  return counts;
}

function recentPickupFromEffects(
  effects: readonly RuleEffect[],
): UserObservablePolicyMemory["lastPickup"] {
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

function assertMemoryMatchesPublicState(
  publicState: PublicInformationState,
  memory: UserObservablePolicyMemory,
): void {
  const actualOrdinals = decisionOrdinalsFromEffects(publicState.effects);
  const actualPlayCounts = playCountsFromEffects(publicState.effects);
  for (const seat of SEATS) {
    nonnegativeSafeInteger(
      memory.decisionOrdinals[seat],
      `decisionOrdinals.${seat}`,
    );
    nonnegativeSafeInteger(
      memory.priorPlayCounts[seat],
      `priorPlayCounts.${seat}`,
    );
    if (memory.decisionOrdinals[seat] !== actualOrdinals[seat]) {
      invalidObservable(
        "Policy decision ordinals do not match the public event effects.",
        {
          seat,
          expected: actualOrdinals[seat],
          actual: memory.decisionOrdinals[seat],
        },
      );
    }
    if (memory.priorPlayCounts[seat] !== actualPlayCounts[seat]) {
      invalidObservable(
        "Policy prior-play counts do not match the public event effects.",
        {
          seat,
          expected: actualPlayCounts[seat],
          actual: memory.priorPlayCounts[seat],
        },
      );
    }
    for (const suit of SUITS) {
      const status = memory.currentSuitStatus[seat][suit];
      if (!SUIT_STATUS_VALUES.has(status)) {
        invalidObservable("Policy memory has an invalid suit status.", {
          seat,
          suit,
          status,
        });
      }
    }
  }
  for (const suit of SUITS) {
    const expected = publicState.userHand.some((card) => suitOf(card) === suit)
      ? "known-has"
      : "known-void";
    if (memory.currentSuitStatus.user[suit] !== expected) {
      invalidObservable(
        "User suit memory does not match the user's exact public hand.",
        {
          suit,
          expected,
          actual: memory.currentSuitStatus.user[suit],
        },
      );
    }
  }
  const expectedPickup = recentPickupFromEffects(publicState.effects);
  if (stableStringify(memory.lastPickup) !== stableStringify(expectedPickup)) {
    invalidObservable(
      "Policy last-pickup memory does not match public effects.",
      {
        expectedPickup,
        actualPickup: memory.lastPickup,
      },
    );
  }
}

function sortedCards(cards: readonly Card[]): readonly Card[] {
  return sortCards(cards);
}

function publicProjection(publicState: PublicInformationState): unknown {
  return {
    schemaVersion: publicState.schemaVersion,
    rules: publicState.rules,
    startingCounts: publicState.startingCounts,
    phase: publicState.phase,
    status: publicState.status,
    handCounts: publicState.handCounts,
    userHand: sortedCards(publicState.userHand),
    knownOpponentCards: {
      p2: sortedCards(publicState.knownOpponentCards.p2),
      p3: sortedCards(publicState.knownOpponentCards.p3),
    },
    unresolvedCards: sortedCards(publicState.unresolvedCards),
    trick:
      publicState.trick === null
        ? null
        : {
            kind: publicState.trick.kind,
            leader: publicState.trick.leader,
            leadSuit: publicState.trick.leadSuit,
            participants: [...publicState.trick.participants],
            startedHeadsUp: publicState.trick.startedHeadsUp,
            forcedLeadCard: publicState.trick.forcedLeadCard,
            shootoutForcedLead: publicState.trick.shootoutForcedLead,
            plays: publicState.trick.plays.map((play) => ({ ...play })),
          },
    waste: sortedCards(publicState.waste),
    pendingAction:
      publicState.pendingAction === null
        ? null
        : {
            ...publicState.pendingAction,
            excludedTrick: sortedCards(publicState.pendingAction.excludedTrick),
          },
    power: publicState.power,
    turn: publicState.turn,
    activeSeats: [...publicState.activeSeats],
    escapeGroups: publicState.escapeGroups.map((group) => ({
      seats: [...group.seats],
      eventIndex: group.eventIndex,
      reason: group.reason,
    })),
    bhabhi: publicState.bhabhi,
    appliedEventCount: publicState.appliedEventCount,
  };
}

/**
 * Hashes only information legitimately available to the live user. The raw
 * effect ledger and any extra runtime properties are intentionally excluded;
 * the finite policy-memory projection carries the history features used by
 * the current behavior policies.
 */
export function createUserObservableStateKey(input: {
  readonly publicState: PublicInformationState;
  readonly policyMemory: UserObservablePolicyMemory;
}): UserObservableStateKey {
  try {
    assertPublicStateInvariant(input.publicState);
  } catch (cause) {
    invalidObservable(
      "Cannot key an invalid public information state.",
      {},
      cause,
    );
  }
  assertMemoryMatchesPublicState(input.publicState, input.policyMemory);
  const projection = publicProjection(input.publicState);
  const publicProjectionHash = stableHash({
    schemaVersion: 1,
    projection,
  });
  const policyMemoryHash = stableHash({
    schemaVersion: 1,
    policyMemory: input.policyMemory,
  });
  return deepFreeze({
    schemaVersion: 1,
    keyVersion: USER_OBSERVABLE_KEY_VERSION,
    key: stableHash({
      schemaVersion: 1,
      keyVersion: USER_OBSERVABLE_KEY_VERSION,
      publicProjectionHash,
      policyMemoryHash,
    }),
    publicProjectionHash,
    policyMemoryHash,
  });
}
