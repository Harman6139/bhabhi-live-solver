import {
  ACE_OF_SPADES,
  FULL_DECK,
  assertUniqueCards,
  compareCardsByRank,
  rankValue,
  sortCards,
  suitOf,
  type Card,
  type Suit,
} from "../domain/cards";
import { parseRuleConfig } from "../domain/rule-config";
import {
  SEATS,
  adjacentSeat,
  nextActiveSeat,
  orderedSeatsFrom,
  type OpponentSeat,
  type Seat,
} from "../domain/seats";
import {
  gameCreatedEventSchema,
  gameEventSchema,
  type CardPlayedEvent,
  type GameCreatedEvent,
  type GameEvent,
  type HandTakenEvent,
  type PlayerCardDrawnEvent,
  type WasteCardDrawnEvent,
} from "../events/game-events";
import type {
  EscapeGroup,
  PublicInformationState,
  RuleEffect,
  TrickPlay,
  TrickState,
} from "../public/public-state";
import { RuleViolation } from "./rule-error";
import { assertPublicStateInvariant } from "./state-invariant";

function opponentSeat(seat: Seat): seat is OpponentSeat {
  return seat !== "user";
}

function removeCard(cards: Card[], card: Card): boolean {
  const index = cards.indexOf(card);
  if (index === -1) {
    return false;
  }
  cards.splice(index, 1);
  return true;
}

function sameCards(left: readonly Card[], right: readonly Card[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((card) => rightSet.has(card));
}

function copyRuleEffect(effect: RuleEffect): RuleEffect {
  switch (effect.type) {
    case "trick-wasted":
    case "trick-picked-up":
      return { ...effect, cards: [...effect.cards] };
    case "players-escaped":
      return { ...effect, seats: [...effect.seats] };
    default:
      return { ...effect };
  }
}

/**
 * Detached copy of every reducer-owned mutable branch.
 *
 * This preserves the reducer's immutable API without paying for a generic
 * structured clone of the ever-growing event-effect tree on every move.
 */
function copyPublicStateForTransition(
  input: PublicInformationState,
): PublicInformationState {
  return {
    ...input,
    rules: {
      ...input.rules,
      takeHand: {
        ...input.rules.takeHand,
        configuredTargets: [...input.rules.takeHand.configuredTargets],
      },
      zeroCardsWithPower: { ...input.rules.zeroCardsWithPower },
    },
    startingCounts: { ...input.startingCounts },
    handCounts: { ...input.handCounts },
    userHand: [...input.userHand],
    knownOpponentCards: {
      p2: [...input.knownOpponentCards.p2],
      p3: [...input.knownOpponentCards.p3],
    },
    unresolvedCards: [...input.unresolvedCards],
    trick:
      input.trick === null
        ? null
        : {
            ...input.trick,
            participants: [...input.trick.participants],
            plays: input.trick.plays.map((play) => ({ ...play })),
          },
    waste: [...input.waste],
    pendingAction:
      input.pendingAction === null
        ? null
        : {
            ...input.pendingAction,
            excludedTrick: [...input.pendingAction.excludedTrick],
          },
    activeSeats: [...input.activeSeats],
    escapeGroups: input.escapeGroups.map((group) => ({
      ...group,
      seats: [...group.seats],
    })),
    effects: input.effects.map(copyRuleEffect),
  };
}

function knownCardsForSeat(
  state: PublicInformationState,
  seat: Seat,
): readonly Card[] {
  return seat === "user" ? state.userHand : state.knownOpponentCards[seat];
}

function hasKnownSuit(
  state: PublicInformationState,
  seat: Seat,
  suit: Suit,
): boolean {
  return knownCardsForSeat(state, seat).some((card) => suitOf(card) === suit);
}

function exactHandForSeat(
  state: PublicInformationState,
  seat: Seat,
): readonly Card[] | null {
  if (seat === "user") {
    return state.userHand;
  }
  const known = state.knownOpponentCards[seat];
  return known.length === state.handCounts[seat] ? known : null;
}

function removeCardFromHand(
  state: PublicInformationState,
  seat: Seat,
  card: Card,
): void {
  if (state.handCounts[seat] <= 0) {
    throw new RuleViolation(
      "CARD_NOT_OWNED",
      `${seat} has no cards and cannot play or transfer ${card}.`,
    );
  }

  if (seat === "user") {
    if (!removeCard(state.userHand, card)) {
      throw new RuleViolation(
        "CARD_NOT_OWNED",
        `${card} is not in the user's exact hand.`,
      );
    }
  } else {
    const known = state.knownOpponentCards[seat];
    if (!removeCard(known, card)) {
      if (known.length === state.handCounts[seat]) {
        throw new RuleViolation(
          "CARD_NOT_OWNED",
          `${card} is not in ${seat}'s exact known hand.`,
        );
      }
      if (!removeCard(state.unresolvedCards, card)) {
        throw new RuleViolation(
          "CARD_NOT_OWNED",
          `${card} cannot belong to ${seat} in the public state.`,
        );
      }
    }
  }

  state.handCounts[seat] -= 1;
}

function addCardToHand(
  state: PublicInformationState,
  seat: Seat,
  card: Card,
): void {
  if (seat === "user") {
    state.userHand.push(card);
    state.userHand = sortCards(state.userHand);
  } else {
    state.knownOpponentCards[seat].push(card);
    state.knownOpponentCards[seat] = sortCards(state.knownOpponentCards[seat]);
  }
  state.handCounts[seat] += 1;
}

function addCardsToHand(
  state: PublicInformationState,
  seat: Seat,
  cards: readonly Card[],
): void {
  for (const card of cards) {
    addCardToHand(state, seat, card);
  }
}

function highestLeadPlay(trick: TrickState): TrickPlay {
  if (trick.leadSuit === null) {
    throw new RuleViolation(
      "INVARIANT_VIOLATION",
      "A resolved trick has no lead suit.",
    );
  }
  const leadPlays = trick.plays.filter(
    (play) => suitOf(play.card) === trick.leadSuit,
  );
  const first = leadPlays[0];
  if (first === undefined) {
    throw new RuleViolation(
      "INVARIANT_VIOLATION",
      "A trick contains no lead-suit card.",
    );
  }
  return leadPlays.reduce((highest, play) =>
    compareCardsByRank(play.card, highest.card) > 0 ? play : highest,
  );
}

function pushEffect(state: PublicInformationState, effect: RuleEffect): void {
  state.effects.push(effect);
}

function startNormalTrick(
  state: PublicInformationState,
  forcedLeadCard: Card | null = null,
  shootoutForcedLead = false,
): void {
  const leader = state.power;
  if (leader === null || !state.activeSeats.includes(leader)) {
    throw new RuleViolation(
      "INVARIANT_VIOLATION",
      "Cannot begin a trick without an active power holder.",
    );
  }
  state.phase = "normal";
  state.trick = {
    kind: "normal",
    leader,
    leadSuit: null,
    participants: orderedSeatsFrom(
      leader,
      state.rules.direction,
      state.activeSeats,
    ),
    startedHeadsUp: state.activeSeats.length === 2,
    forcedLeadCard,
    shootoutForcedLead,
    plays: [],
  };
  state.pendingAction = null;
  state.turn = leader;
}

function escapeSeats(
  state: PublicInformationState,
  seats: readonly Seat[],
  eventIndex: number,
  reason: EscapeGroup["reason"],
): void {
  const unique = seats.filter(
    (seat, index) =>
      seats.indexOf(seat) === index && state.activeSeats.includes(seat),
  );
  if (unique.length === 0) {
    return;
  }
  state.activeSeats = state.activeSeats.filter(
    (seat) => !unique.includes(seat),
  );
  state.escapeGroups.push({ seats: [...unique], eventIndex, reason });
  pushEffect(state, {
    type: "players-escaped",
    eventIndex,
    seats: [...unique],
    reason,
  });
}

function completeGame(
  state: PublicInformationState,
  bhabhi: Seat,
  eventIndex: number,
  reason:
    | "last-active"
    | "pagat-higher-response"
    | "pagat-lower-last-response"
    | "pagat-off-suit-response"
    | "simplified-thulla",
): void {
  state.status = "complete";
  state.bhabhi = bhabhi;
  state.activeSeats = [bhabhi];
  state.power = bhabhi;
  state.turn = null;
  state.trick = null;
  state.pendingAction = null;
  pushEffect(state, {
    type: "game-completed",
    eventIndex,
    bhabhi,
    reason,
  });
}

function completeIfOneActive(
  state: PublicInformationState,
  eventIndex: number,
): boolean {
  const survivor = state.activeSeats[0];
  if (state.activeSeats.length === 1 && survivor !== undefined) {
    completeGame(state, survivor, eventIndex, "last-active");
    return true;
  }
  return false;
}

function recordPower(
  state: PublicInformationState,
  power: Seat,
  eventIndex: number,
): void {
  state.power = power;
  pushEffect(state, {
    type: "power-changed",
    eventIndex,
    power,
  });
}

function selectPlayerDrawSource(
  state: PublicInformationState,
  player: Seat,
): Seat {
  const configured = state.rules.zeroCardsWithPower.configuredTarget;
  if (
    state.rules.zeroCardsWithPower.drawFromTarget === "configured" &&
    configured !== null &&
    configured !== player &&
    state.activeSeats.includes(configured)
  ) {
    return configured;
  }
  return nextActiveSeat(player, state.rules.direction, state.activeSeats);
}

function requireZeroPowerResolution(
  state: PublicInformationState,
  winner: Seat,
  excludedTrick: Card[],
  eventIndex: number,
  pagatShootout: boolean,
): void {
  if (pagatShootout) {
    state.pendingAction = {
      kind: "waste-draw",
      player: winner,
      excludedTrick,
      reason: "pagat-shootout",
    };
    state.turn = winner;
    pushEffect(state, {
      type: "draw-required",
      eventIndex,
      player: winner,
      source: "waste",
    });
    return;
  }

  switch (state.rules.zeroCardsWithPower.mode) {
    case "immediate-escape": {
      escapeSeats(state, [winner], eventIndex, "immediate-zero-power");
      state.waste.push(...excludedTrick);
      pushEffect(state, {
        type: "trick-wasted",
        eventIndex,
        cards: excludedTrick,
        power: winner,
      });
      if (completeIfOneActive(state, eventIndex)) {
        return;
      }
      const next = nextActiveSeat(
        winner,
        state.rules.direction,
        state.activeSeats,
      );
      recordPower(state, next, eventIndex);
      startNormalTrick(state);
      return;
    }
    case "waste-draw": {
      if (state.waste.length === 0) {
        throw new RuleViolation(
          "INVALID_DRAW_CARD",
          "A zero-card power holder must draw, but the eligible waste is empty.",
        );
      }
      state.pendingAction = {
        kind: "waste-draw",
        player: winner,
        excludedTrick,
        reason: "zero-power",
      };
      state.turn = winner;
      pushEffect(state, {
        type: "draw-required",
        eventIndex,
        player: winner,
        source: "waste",
      });
      return;
    }
    case "draw-from-player": {
      const source = selectPlayerDrawSource(state, winner);
      state.pendingAction = {
        kind: "player-draw",
        player: winner,
        source,
        excludedTrick,
        reason: "zero-power",
      };
      state.turn = winner;
      pushEffect(state, {
        type: "draw-required",
        eventIndex,
        player: winner,
        source,
      });
      return;
    }
  }
}

function resolveOpening(
  state: PublicInformationState,
  eventIndex: number,
): void {
  const trick = state.trick;
  if (trick === null) {
    throw new RuleViolation(
      "INVARIANT_VIOLATION",
      "Opening resolution has no trick.",
    );
  }
  const cards = trick.plays.map((play) => play.card);
  const power = trick.leader;
  state.trick = null;
  state.waste.push(...cards);
  recordPower(state, power, eventIndex);
  pushEffect(state, {
    type: "trick-wasted",
    eventIndex,
    cards,
    power,
  });
  startNormalTrick(state);
}

function resolveCleanTrick(
  state: PublicInformationState,
  eventIndex: number,
): void {
  const trick = state.trick;
  if (trick === null) {
    throw new RuleViolation(
      "INVARIANT_VIOLATION",
      "Clean trick resolution has no trick.",
    );
  }
  const cards = trick.plays.map((play) => play.card);
  const winner = highestLeadPlay(trick).seat;
  state.trick = null;
  recordPower(state, winner, eventIndex);

  const pagatLastLead =
    trick.startedHeadsUp &&
    state.rules.twoPlayer === "pagat-shootout" &&
    state.handCounts[trick.leader] === 0;
  if (pagatLastLead) {
    const responder = trick.participants.find((seat) => seat !== trick.leader);
    if (responder === undefined) {
      throw new RuleViolation(
        "INVARIANT_VIOLATION",
        "A heads-up trick has no responder.",
      );
    }

    if (winner !== trick.leader) {
      escapeSeats(state, [trick.leader], eventIndex, "shootout-safe");
      state.waste.push(...cards);
      pushEffect(state, {
        type: "trick-wasted",
        eventIndex,
        cards,
        power: winner,
      });
      completeGame(state, winner, eventIndex, "pagat-higher-response");
      return;
    }

    if (state.handCounts[responder] === 0) {
      escapeSeats(state, [responder], eventIndex, "shootout-safe");
      state.waste.push(...cards);
      pushEffect(state, {
        type: "trick-wasted",
        eventIndex,
        cards,
        power: winner,
      });
      completeGame(
        state,
        trick.leader,
        eventIndex,
        "pagat-lower-last-response",
      );
      return;
    }
  }

  const zeroNonPower = state.activeSeats.filter(
    (seat) => seat !== winner && state.handCounts[seat] === 0,
  );
  escapeSeats(state, zeroNonPower, eventIndex, "empty-hand");

  if (state.activeSeats.length === 1) {
    state.waste.push(...cards);
    pushEffect(state, {
      type: "trick-wasted",
      eventIndex,
      cards,
      power: winner,
    });
    completeIfOneActive(state, eventIndex);
    return;
  }

  if (state.handCounts[winner] === 0) {
    requireZeroPowerResolution(
      state,
      winner,
      cards,
      eventIndex,
      trick.startedHeadsUp && state.rules.twoPlayer === "pagat-shootout",
    );
    return;
  }

  state.waste.push(...cards);
  pushEffect(state, {
    type: "trick-wasted",
    eventIndex,
    cards,
    power: winner,
  });
  startNormalTrick(state);
}

function resolveThulla(
  state: PublicInformationState,
  eventIndex: number,
): void {
  const trick = state.trick;
  if (trick === null || trick.leadSuit === null) {
    throw new RuleViolation(
      "INVARIANT_VIOLATION",
      "Thulla resolution has no led trick.",
    );
  }
  const thullaPlay = trick.plays.at(-1);
  if (thullaPlay === undefined) {
    throw new RuleViolation(
      "INVARIANT_VIOLATION",
      "Thulla resolution has no thulla play.",
    );
  }
  const cards = trick.plays.map((play) => play.card);
  const winner = highestLeadPlay(trick).seat;
  const pagatLastLead =
    trick.startedHeadsUp &&
    state.rules.twoPlayer === "pagat-shootout" &&
    state.handCounts[trick.leader] === 0;
  state.trick = null;
  addCardsToHand(state, winner, cards);
  recordPower(state, winner, eventIndex);
  pushEffect(state, {
    type: "trick-picked-up",
    eventIndex,
    cards,
    picker: winner,
    thullaBy: thullaPlay.seat,
  });

  if (
    trick.startedHeadsUp &&
    state.rules.twoPlayer === "simplified-thulla-wins"
  ) {
    escapeSeats(state, [thullaPlay.seat], eventIndex, "shootout-safe");
    completeGame(state, winner, eventIndex, "simplified-thulla");
    return;
  }

  if (
    trick.startedHeadsUp &&
    state.rules.twoPlayer === "pagat-shootout" &&
    (trick.shootoutForcedLead || pagatLastLead)
  ) {
    escapeSeats(state, [thullaPlay.seat], eventIndex, "shootout-safe");
    completeGame(state, winner, eventIndex, "pagat-off-suit-response");
    return;
  }

  const zeroNonPower = state.activeSeats.filter(
    (seat) => seat !== winner && state.handCounts[seat] === 0,
  );
  escapeSeats(state, zeroNonPower, eventIndex, "empty-hand");
  if (completeIfOneActive(state, eventIndex)) {
    return;
  }
  startNormalTrick(state);
}

function validateOpeningChoice(
  state: PublicInformationState,
  seat: Seat,
  card: Card,
  trick: TrickState,
): void {
  if (trick.plays.length === 0) {
    if (card !== ACE_OF_SPADES || seat !== trick.leader) {
      throw new RuleViolation(
        "OPENING_REQUIRES_ACE_OF_SPADES",
        `The opening leader ${trick.leader} must play A♠.`,
      );
    }
    return;
  }

  if (suitOf(card) === "spades") {
    return;
  }
  if (hasKnownSuit(state, seat, "spades")) {
    throw new RuleViolation(
      "MUST_FOLLOW_SUIT",
      `${seat} must play a Spade in the opening trick.`,
    );
  }

  if (state.rules.openingOffSuit === "highest") {
    const exactHand = exactHandForSeat(state, seat);
    if (exactHand !== null) {
      const highest = Math.max(...exactHand.map(rankValue));
      if (rankValue(card) !== highest) {
        throw new RuleViolation(
          "OPENING_REQUIRES_HIGHEST_OFF_SUIT",
          `${seat} must play a highest-ranked off-suit card in the opening trick.`,
        );
      }
    }
  }
}

function validateNormalChoice(
  state: PublicInformationState,
  seat: Seat,
  card: Card,
  trick: TrickState,
): void {
  if (trick.plays.length === 0) {
    if (trick.forcedLeadCard !== null && card !== trick.forcedLeadCard) {
      throw new RuleViolation(
        "FORCED_LEAD_REQUIRED",
        `${seat} must lead the drawn card ${trick.forcedLeadCard}.`,
      );
    }
    return;
  }
  const leadSuit = trick.leadSuit;
  if (
    leadSuit !== null &&
    suitOf(card) !== leadSuit &&
    hasKnownSuit(state, seat, leadSuit)
  ) {
    throw new RuleViolation(
      "MUST_FOLLOW_SUIT",
      `${seat} must follow ${leadSuit}; a known card of that suit remains in hand.`,
    );
  }
}

function applyCardPlayed(
  state: PublicInformationState,
  event: CardPlayedEvent,
  eventIndex: number,
): void {
  const trick = state.trick;
  if (trick === null || state.pendingAction !== null) {
    throw new RuleViolation(
      "WRONG_EVENT",
      "A card cannot be played while a draw is pending.",
    );
  }
  if (state.turn !== event.seat) {
    throw new RuleViolation(
      "WRONG_TURN",
      `It is ${state.turn ?? "nobody"}'s turn, not ${event.seat}'s.`,
    );
  }
  if (!state.activeSeats.includes(event.seat)) {
    throw new RuleViolation(
      "INACTIVE_PLAYER",
      `${event.seat} has escaped and cannot play.`,
    );
  }

  if (trick.kind === "opening") {
    validateOpeningChoice(state, event.seat, event.card, trick);
  } else {
    validateNormalChoice(state, event.seat, event.card, trick);
  }

  const leadSuit =
    trick.leadSuit ??
    (trick.kind === "opening" ? "spades" : suitOf(event.card));
  const offSuit = suitOf(event.card) !== leadSuit;
  removeCardFromHand(state, event.seat, event.card);
  trick.leadSuit = leadSuit;
  trick.plays.push({
    seat: event.seat,
    card: event.card,
    offSuit,
    eventIndex,
  });
  pushEffect(state, {
    type: "card-played",
    eventIndex,
    seat: event.seat,
    card: event.card,
    offSuit,
  });
  if (offSuit) {
    pushEffect(state, {
      type: "thulla",
      eventIndex,
      seat: event.seat,
      leadSuit,
    });
  }

  if (trick.kind === "opening") {
    if (trick.plays.length === trick.participants.length) {
      resolveOpening(state, eventIndex);
      return;
    }
  } else if (offSuit) {
    resolveThulla(state, eventIndex);
    return;
  } else if (trick.plays.length === trick.participants.length) {
    resolveCleanTrick(state, eventIndex);
    return;
  }

  state.turn = trick.participants[trick.plays.length] ?? null;
}

function validateTakeTarget(
  state: PublicInformationState,
  event: HandTakenEvent,
): void {
  const { mode } = state.rules.takeHand;
  if (mode === "disabled") {
    throw new RuleViolation(
      "TAKE_DISABLED",
      "Taking another hand is disabled in this rule profile.",
    );
  }
  const trick = state.trick;
  if (
    state.phase !== "normal" ||
    trick === null ||
    trick.plays.length !== 0 ||
    trick.forcedLeadCard !== null ||
    state.pendingAction !== null ||
    state.turn !== event.actor ||
    state.power !== event.actor
  ) {
    throw new RuleViolation(
      "TAKE_NOT_AVAILABLE",
      "A hand can be taken only by the power holder before a fresh normal trick.",
    );
  }
  if (
    event.target === event.actor ||
    !state.activeSeats.includes(event.target)
  ) {
    throw new RuleViolation(
      "INVALID_TAKE_TARGET",
      "The take target must be another active player.",
    );
  }

  const expected =
    mode === "next-active"
      ? nextActiveSeat(event.actor, state.rules.direction, state.activeSeats)
      : mode === "adjacent"
        ? adjacentSeat(event.actor, state.rules.direction)
        : null;
  if (expected !== null && event.target !== expected) {
    throw new RuleViolation(
      "INVALID_TAKE_TARGET",
      `${mode} take mode requires target ${expected}.`,
    );
  }
  if (
    mode === "configured" &&
    !state.rules.takeHand.configuredTargets.includes(event.target)
  ) {
    throw new RuleViolation(
      "INVALID_TAKE_TARGET",
      `${event.target} is not permitted by the configured take targets.`,
    );
  }
}

function revealAndTransferOpponentHandToUser(
  state: PublicInformationState,
  target: OpponentSeat,
  revealedCards: readonly Card[],
): void {
  assertUniqueCards(revealedCards, "revealed taken hand");
  if (revealedCards.length !== state.handCounts[target]) {
    throw new RuleViolation(
      "INVALID_TAKE_TARGET",
      `Taking ${target}'s hand requires exactly ${state.handCounts[target]} revealed cards.`,
    );
  }
  const known = state.knownOpponentCards[target];
  if (!known.every((card) => revealedCards.includes(card))) {
    throw new RuleViolation(
      "CARD_NOT_OWNED",
      `The revealed hand omits cards known to belong to ${target}.`,
    );
  }
  for (const card of revealedCards) {
    if (!removeCard(known, card) && !removeCard(state.unresolvedCards, card)) {
      throw new RuleViolation(
        "CARD_NOT_OWNED",
        `${card} cannot belong to ${target}'s taken hand.`,
      );
    }
    state.userHand.push(card);
  }
  state.userHand = sortCards(state.userHand);
}

function applyHandTaken(
  state: PublicInformationState,
  event: HandTakenEvent,
  eventIndex: number,
): void {
  validateTakeTarget(state, event);
  const count = state.handCounts[event.target];

  if (event.actor === "user" && opponentSeat(event.target)) {
    revealAndTransferOpponentHandToUser(
      state,
      event.target,
      event.revealedCards,
    );
  } else if (event.target === "user" && opponentSeat(event.actor)) {
    if (
      event.revealedCards.length > 0 &&
      !sameCards(event.revealedCards, state.userHand)
    ) {
      throw new RuleViolation(
        "CARD_NOT_OWNED",
        "The revealed transfer does not match the user hand.",
      );
    }
    state.knownOpponentCards[event.actor].push(...state.userHand);
    state.knownOpponentCards[event.actor] = sortCards(
      state.knownOpponentCards[event.actor],
    );
    state.userHand = [];
  } else if (opponentSeat(event.actor) && opponentSeat(event.target)) {
    const targetKnown = state.knownOpponentCards[event.target];
    if (event.revealedCards.length > 0) {
      assertUniqueCards(event.revealedCards, "revealed taken hand");
      if (
        event.revealedCards.length !== count ||
        !targetKnown.every((card) => event.revealedCards.includes(card))
      ) {
        throw new RuleViolation(
          "CARD_NOT_OWNED",
          "The revealed opponent transfer is inconsistent with known ownership.",
        );
      }
      for (const card of event.revealedCards) {
        if (
          !removeCard(targetKnown, card) &&
          !removeCard(state.unresolvedCards, card)
        ) {
          throw new RuleViolation(
            "CARD_NOT_OWNED",
            `${card} cannot belong to the taken opponent hand.`,
          );
        }
        state.knownOpponentCards[event.actor].push(card);
      }
    } else {
      state.knownOpponentCards[event.actor].push(...targetKnown);
      targetKnown.splice(0, targetKnown.length);
    }
    state.knownOpponentCards[event.actor] = sortCards(
      state.knownOpponentCards[event.actor],
    );
  }

  state.handCounts[event.actor] += count;
  state.handCounts[event.target] = 0;
  if (opponentSeat(event.target)) {
    state.knownOpponentCards[event.target] = [];
  }
  escapeSeats(state, [event.target], eventIndex, "take-hand");
  pushEffect(state, {
    type: "hand-taken",
    eventIndex,
    actor: event.actor,
    target: event.target,
    count,
  });

  if (completeIfOneActive(state, eventIndex)) {
    return;
  }
  recordPower(state, event.actor, eventIndex);
  startNormalTrick(state);
}

function applyWasteCardDrawn(
  state: PublicInformationState,
  event: WasteCardDrawnEvent,
  eventIndex: number,
): void {
  const pending = state.pendingAction;
  if (pending?.kind !== "waste-draw") {
    throw new RuleViolation(
      "DRAW_NOT_REQUIRED",
      "No waste draw is currently required.",
    );
  }
  if (event.seat !== pending.player) {
    throw new RuleViolation(
      "WRONG_TURN",
      `${pending.player} must perform the pending waste draw.`,
    );
  }
  if (!removeCard(state.waste, event.card)) {
    throw new RuleViolation(
      "INVALID_DRAW_CARD",
      `${event.card} is not in the eligible prior waste.`,
    );
  }
  addCardToHand(state, event.seat, event.card);
  state.waste.push(...pending.excludedTrick);
  pushEffect(state, {
    type: "trick-wasted",
    eventIndex,
    cards: pending.excludedTrick,
    power: event.seat,
  });
  state.pendingAction = null;
  recordPower(state, event.seat, eventIndex);
  startNormalTrick(
    state,
    event.card,
    state.activeSeats.length === 2 &&
      state.rules.twoPlayer === "pagat-shootout",
  );
}

function applyPlayerCardDrawn(
  state: PublicInformationState,
  event: PlayerCardDrawnEvent,
  eventIndex: number,
): void {
  const pending = state.pendingAction;
  if (pending?.kind !== "player-draw") {
    throw new RuleViolation(
      "DRAW_NOT_REQUIRED",
      "No player-hand draw is currently required.",
    );
  }
  if (event.seat !== pending.player) {
    throw new RuleViolation(
      "WRONG_TURN",
      `${pending.player} must perform the pending player draw.`,
    );
  }
  if (event.source !== pending.source) {
    throw new RuleViolation(
      "INVALID_DRAW_SOURCE",
      `The configured draw source is ${pending.source}, not ${event.source}.`,
    );
  }
  removeCardFromHand(state, event.source, event.card);
  addCardToHand(state, event.seat, event.card);
  state.waste.push(...pending.excludedTrick);
  pushEffect(state, {
    type: "trick-wasted",
    eventIndex,
    cards: pending.excludedTrick,
    power: event.seat,
  });
  state.pendingAction = null;

  if (state.handCounts[event.source] === 0) {
    escapeSeats(state, [event.source], eventIndex, "empty-hand");
  }
  if (completeIfOneActive(state, eventIndex)) {
    return;
  }
  recordPower(state, event.seat, eventIndex);
  startNormalTrick(
    state,
    event.card,
    state.activeSeats.length === 2 &&
      state.rules.twoPlayer === "pagat-shootout",
  );
}

export function createInitialPublicState(
  eventValue: GameCreatedEvent,
): PublicInformationState {
  const event = gameCreatedEventSchema.parse(eventValue);
  parseRuleConfig(event.rules);
  assertUniqueCards(event.userHand, "starting user hand");

  const counts = SEATS.map((seat) => event.startingCounts[seat]);
  const sortedCounts = [...counts].sort((left, right) => left - right);
  if (
    sortedCounts[0] !== 17 ||
    sortedCounts[1] !== 17 ||
    sortedCounts[2] !== 18 ||
    event.startingCounts.user !== event.userHand.length
  ) {
    throw new RuleViolation(
      "INVALID_SETUP",
      "Starting counts must be a permutation of 18, 17, 17 and match the user hand.",
    );
  }
  if (
    (event.aceSpadesHolder === "user") !==
    event.userHand.includes(ACE_OF_SPADES)
  ) {
    throw new RuleViolation(
      "INVALID_SETUP",
      "The declared A♠ holder contradicts the exact user hand.",
    );
  }

  const opponentAceHolder =
    event.aceSpadesHolder === "user" ? null : event.aceSpadesHolder;
  const unresolvedCards = FULL_DECK.filter(
    (card) =>
      !event.userHand.includes(card) &&
      (opponentAceHolder === null || card !== ACE_OF_SPADES),
  );
  const participants = orderedSeatsFrom(
    event.aceSpadesHolder,
    event.rules.direction,
    SEATS,
  );
  const state: PublicInformationState = {
    schemaVersion: 1,
    rules: structuredClone(event.rules),
    startingCounts: structuredClone(event.startingCounts),
    phase: "opening",
    status: "active",
    handCounts: structuredClone(event.startingCounts),
    userHand: sortCards(event.userHand),
    knownOpponentCards: {
      p2: opponentAceHolder === "p2" ? [ACE_OF_SPADES] : [],
      p3: opponentAceHolder === "p3" ? [ACE_OF_SPADES] : [],
    },
    unresolvedCards: [...unresolvedCards],
    trick: {
      kind: "opening",
      leader: event.aceSpadesHolder,
      leadSuit: "spades",
      participants,
      startedHeadsUp: false,
      forcedLeadCard: ACE_OF_SPADES,
      shootoutForcedLead: false,
      plays: [],
    },
    waste: [],
    pendingAction: null,
    power: event.aceSpadesHolder,
    turn: event.aceSpadesHolder,
    activeSeats: [...SEATS],
    escapeGroups: [],
    bhabhi: null,
    effects: [],
    appliedEventCount: 1,
  };
  assertPublicStateInvariant(state);
  return state;
}

export function applyGameEvent(
  inputState: PublicInformationState,
  eventValue: Exclude<GameEvent, GameCreatedEvent>,
  eventIndex = inputState.appliedEventCount,
): PublicInformationState {
  if (inputState.status === "complete") {
    throw new RuleViolation(
      "GAME_COMPLETE",
      "The game is complete. Undo or correct history before adding an event.",
      eventIndex,
    );
  }
  const parsed = gameEventSchema.parse(eventValue);
  if (parsed.type === "game-created") {
    throw new RuleViolation(
      "GAME_ALREADY_CREATED",
      "A game-created event is valid only at history index 0.",
      eventIndex,
    );
  }

  const state = copyPublicStateForTransition(inputState);
  try {
    switch (parsed.type) {
      case "card-played":
        applyCardPlayed(state, parsed, eventIndex);
        break;
      case "waste-card-drawn":
        applyWasteCardDrawn(state, parsed, eventIndex);
        break;
      case "player-card-drawn":
        applyPlayerCardDrawn(state, parsed, eventIndex);
        break;
      case "hand-taken":
        applyHandTaken(state, parsed, eventIndex);
        break;
    }
    state.appliedEventCount = eventIndex + 1;
    assertPublicStateInvariant(state);
    return state;
  } catch (error) {
    if (error instanceof RuleViolation && error.eventIndex === null) {
      throw error.atEvent(eventIndex);
    }
    throw error;
  }
}
