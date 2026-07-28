import { FULL_DECK, type Card } from "../domain/cards";
import { SEATS, type OpponentSeat, type Seat } from "../domain/seats";
import {
  cardsInPendingAction,
  type PublicInformationState,
} from "../public/public-state";
import { RuleViolation } from "./rule-error";

type CardLocation = {
  readonly card: Card;
  readonly location: string;
};

function collectLocations(state: PublicInformationState): CardLocation[] {
  const locations: CardLocation[] = [];
  for (const card of state.userHand) {
    locations.push({ card, location: "user hand" });
  }
  for (const seat of ["p2", "p3"] as const) {
    for (const card of state.knownOpponentCards[seat]) {
      locations.push({ card, location: `${seat} known hand` });
    }
  }
  for (const card of state.unresolvedCards) {
    locations.push({ card, location: "unresolved opponent allocation" });
  }
  for (const play of state.trick?.plays ?? []) {
    locations.push({ card: play.card, location: "current trick" });
  }
  for (const card of state.waste) {
    locations.push({ card, location: "waste" });
  }
  for (const card of cardsInPendingAction(state.pendingAction)) {
    locations.push({ card, location: "pending excluded trick" });
  }
  return locations;
}

function fail(message: string): never {
  throw new RuleViolation(
    "INVARIANT_VIOLATION",
    `Card-accounting invariant failed: ${message}`,
  );
}

export function assertPublicStateInvariant(
  state: PublicInformationState,
): void {
  const locations = collectLocations(state);
  const seen = new Map<Card, string>();

  for (const entry of locations) {
    const previous = seen.get(entry.card);
    if (previous !== undefined) {
      fail(`${entry.card} appears in both ${previous} and ${entry.location}.`);
    }
    seen.set(entry.card, entry.location);
  }

  if (seen.size !== FULL_DECK.length) {
    const missing = FULL_DECK.filter((card) => !seen.has(card));
    fail(
      `expected 52 unique cards, found ${seen.size}; missing ${missing.join(", ") || "none"}.`,
    );
  }

  if (state.handCounts.user !== state.userHand.length) {
    fail(
      `user count ${state.handCounts.user} does not match exact hand ${state.userHand.length}.`,
    );
  }

  let unresolvedSlots = 0;
  for (const seat of ["p2", "p3"] as const satisfies readonly OpponentSeat[]) {
    const knownCount = state.knownOpponentCards[seat].length;
    const handCount = state.handCounts[seat];
    if (handCount < knownCount) {
      fail(`${seat} has ${knownCount} known cards but count ${handCount}.`);
    }
    unresolvedSlots += handCount - knownCount;
  }

  if (unresolvedSlots !== state.unresolvedCards.length) {
    fail(
      `unresolved pool has ${state.unresolvedCards.length} cards for ${unresolvedSlots} opponent slots.`,
    );
  }

  const handTotal = SEATS.reduce(
    (total, seat) => total + state.handCounts[seat],
    0,
  );
  const locatedOutsideHands =
    (state.trick?.plays.length ?? 0) +
    state.waste.length +
    cardsInPendingAction(state.pendingAction).length;
  if (handTotal + locatedOutsideHands !== FULL_DECK.length) {
    fail(
      `hand total ${handTotal} plus table/waste ${locatedOutsideHands} is not 52.`,
    );
  }

  const uniqueActive = new Set<Seat>(state.activeSeats);
  if (uniqueActive.size !== state.activeSeats.length) {
    fail("active seat list contains duplicates.");
  }
  for (const seat of state.activeSeats) {
    if (!SEATS.includes(seat)) {
      fail(`unknown active seat ${seat}.`);
    }
  }

  if (state.status === "complete") {
    if (state.bhabhi === null) {
      fail("complete game has no Bhabhi.");
    }
    if (
      state.turn !== null ||
      state.trick !== null ||
      state.pendingAction !== null
    ) {
      fail("complete game still has a turn, trick, or pending action.");
    }
  } else {
    if (state.bhabhi !== null) {
      fail("active game already names a Bhabhi.");
    }
    if (state.activeSeats.length < 2) {
      fail("active game has fewer than two active seats.");
    }
    if (state.power === null || !state.activeSeats.includes(state.power)) {
      fail("active game power holder is missing or inactive.");
    }
    if (state.pendingAction === null && state.trick === null) {
      fail("active game has neither a trick nor a pending rule action.");
    }
    if (state.turn === null || !state.activeSeats.includes(state.turn)) {
      fail("active game turn is missing or inactive.");
    }
  }

  if (state.trick !== null) {
    const expectedPrefix = state.trick.participants.slice(
      0,
      state.trick.plays.length,
    );
    const actual = state.trick.plays.map((play) => play.seat);
    if (expectedPrefix.some((seat, index) => seat !== actual[index])) {
      fail("trick plays are not a prefix of captured participant order.");
    }
  }
}
