import { rankValue, suitOf, type Card } from "../domain/cards";
import { adjacentSeat, nextActiveSeat, type Seat } from "../domain/seats";
import type { PublicInformationState } from "../public/public-state";

export function legalCardsForExactHand(
  state: PublicInformationState,
  seat: Seat,
  exactHand: readonly Card[],
): Card[] {
  if (
    state.status !== "active" ||
    state.pendingAction !== null ||
    state.turn !== seat ||
    state.trick === null ||
    !state.activeSeats.includes(seat)
  ) {
    return [];
  }

  const trick = state.trick;
  if (trick.plays.length === 0) {
    if (trick.forcedLeadCard !== null) {
      return exactHand.includes(trick.forcedLeadCard)
        ? [trick.forcedLeadCard]
        : [];
    }
    return [...exactHand];
  }

  const leadSuit = trick.leadSuit;
  if (leadSuit === null) {
    return [];
  }
  const followers = exactHand.filter((card) => suitOf(card) === leadSuit);
  if (followers.length > 0) {
    return followers;
  }

  if (trick.kind === "opening" && state.rules.openingOffSuit === "highest") {
    const highest = Math.max(...exactHand.map(rankValue));
    return exactHand.filter((card) => rankValue(card) === highest);
  }
  return [...exactHand];
}

export function legalTakeTargets(
  state: PublicInformationState,
  actor: Seat | null = state.turn,
): Seat[] {
  const trick = state.trick;
  if (
    actor === null ||
    state.turn !== actor ||
    state.status !== "active" ||
    state.rules.takeHand.mode === "disabled" ||
    state.phase !== "normal" ||
    trick === null ||
    trick.plays.length !== 0 ||
    trick.forcedLeadCard !== null ||
    state.pendingAction !== null ||
    state.power !== actor
  ) {
    return [];
  }

  switch (state.rules.takeHand.mode) {
    case "next-active":
      return [nextActiveSeat(actor, state.rules.direction, state.activeSeats)];
    case "adjacent": {
      const adjacent = adjacentSeat(actor, state.rules.direction);
      return state.activeSeats.includes(adjacent) ? [adjacent] : [];
    }
    case "configured":
      return state.rules.takeHand.configuredTargets.filter(
        (seat) => seat !== actor && state.activeSeats.includes(seat),
      );
  }
}
