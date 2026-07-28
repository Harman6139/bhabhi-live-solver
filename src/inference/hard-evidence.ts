import {
  ACE_OF_SPADES,
  FULL_DECK,
  rankValue,
  suitOf,
  type Card,
  type Suit,
} from "../domain/cards";
import { type OpponentSeat, type Seat } from "../domain/seats";
import type {
  GameCreatedEvent,
  GameEvent,
  HandTakenEvent,
} from "../events/game-events";
import {
  activeTimelineEvents,
  replayTimeline,
  type GameTimeline,
} from "../events/timeline";
import type { PublicInformationState } from "../public/public-state";
import { applyGameEvent, createInitialPublicState } from "../rules/reducer";
import { countOwnerAssignments, type OwnerMask } from "./combinatorics";
import { HardInferenceError } from "./error";
import {
  HARD_EVIDENCE_ALGORITHM_VERSION,
  type ChronologicalVoidObservation,
  type HardEvidence,
  type HiddenCardConstraint,
  type OriginElimination,
  type SymbolicCardLocation,
} from "./types";

type MutableOrigin = {
  readonly initialOwner: OpponentSeat;
  allowed: boolean;
  location: SymbolicCardLocation;
  eliminatedBy: OriginElimination | null;
};

type MutableConstraint = {
  readonly card: Card;
  readonly origins: Record<OpponentSeat, MutableOrigin>;
};

function isOpponentSeat(seat: Seat): seat is OpponentSeat {
  return seat === "p2" || seat === "p3";
}

function inferenceError(
  message: string,
  eventIndex: number | null,
  details: Readonly<Record<string, unknown>>,
  cause?: unknown,
): HardInferenceError {
  return new HardInferenceError("INVARIANT_VIOLATION", message, {
    eventIndex,
    details,
    cause,
  });
}

function eliminate(
  constraint: MutableConstraint,
  owner: OpponentSeat,
  elimination: Omit<OriginElimination, "initialOwner" | "card">,
): void {
  const origin = constraint.origins[owner];
  if (!origin.allowed) {
    return;
  }
  origin.allowed = false;
  origin.eliminatedBy = {
    ...elimination,
    initialOwner: owner,
    card: constraint.card,
  };
}

function locateExactPublicCard(
  state: PublicInformationState,
  card: Card,
  eventIndex: number,
): SymbolicCardLocation | null {
  const locations: SymbolicCardLocation[] = [];
  if (state.userHand.includes(card)) {
    locations.push("user");
  }
  if (state.knownOpponentCards.p2.includes(card)) {
    locations.push("p2");
  }
  if (state.knownOpponentCards.p3.includes(card)) {
    locations.push("p3");
  }
  if (state.trick?.plays.some((play) => play.card === card) === true) {
    locations.push("trick");
  }
  if (state.waste.includes(card)) {
    locations.push("waste");
  }
  if (state.pendingAction?.excludedTrick.includes(card) === true) {
    locations.push("pending");
  }

  if (locations.length > 1) {
    throw inferenceError(
      `${card} appears in multiple exact public locations.`,
      eventIndex,
      { card, locations },
    );
  }
  if (locations.length === 1) {
    return locations[0] ?? null;
  }
  if (state.unresolvedCards.includes(card)) {
    return null;
  }
  throw inferenceError(
    `${card} is absent from both exact and unresolved public locations.`,
    eventIndex,
    { card },
  );
}

function initialConstraints(setup: GameCreatedEvent): MutableConstraint[] {
  const hiddenCards = FULL_DECK.filter(
    (card) => !setup.userHand.includes(card),
  );
  return hiddenCards.map((card) => {
    const constraint: MutableConstraint = {
      card,
      origins: {
        p2: {
          initialOwner: "p2",
          allowed: true,
          location: "p2",
          eliminatedBy: null,
        },
        p3: {
          initialOwner: "p3",
          allowed: true,
          location: "p3",
          eliminatedBy: null,
        },
      },
    };
    if (card === ACE_OF_SPADES && isOpponentSeat(setup.aceSpadesHolder)) {
      const excluded =
        setup.aceSpadesHolder === "p2" ? ("p3" as const) : ("p2" as const);
      eliminate(constraint, excluded, {
        code: "declared-ace-owner",
        eventIndex: 0,
        seat: setup.aceSpadesHolder,
        suit: "spades",
        observedCard: ACE_OF_SPADES,
      });
    }
    return constraint;
  });
}

function activeLeadSuit(state: PublicInformationState): Suit | null {
  const trick = state.trick;
  if (trick === null || trick.plays.length === 0) {
    return trick?.kind === "opening" ? "spades" : null;
  }
  return trick.leadSuit;
}

function observedVoid(
  state: PublicInformationState,
  event: GameEvent,
  eventIndex: number,
): ChronologicalVoidObservation | null {
  if (event.type !== "card-played") {
    return null;
  }
  const leadSuit = activeLeadSuit(state);
  if (leadSuit === null || suitOf(event.card) === leadSuit) {
    return null;
  }
  return {
    eventIndex,
    seat: event.seat,
    suit: leadSuit,
    observedCard: event.card,
    kind:
      state.trick?.kind === "opening" ? "opening-off-suit" : "normal-thulla",
  };
}

function applyPlayConstraints(
  constraints: readonly MutableConstraint[],
  state: PublicInformationState,
  event: Extract<GameEvent, { type: "card-played" }>,
  eventIndex: number,
): void {
  const leadSuit = activeLeadSuit(state);
  const offSuit = leadSuit !== null && suitOf(event.card) !== leadSuit;
  for (const constraint of constraints) {
    for (const owner of ["p2", "p3"] as const) {
      const origin = constraint.origins[owner];
      if (!origin.allowed) {
        continue;
      }
      if (constraint.card === event.card && origin.location !== event.seat) {
        eliminate(constraint, owner, {
          code: "observed-play-owner",
          eventIndex,
          seat: event.seat,
          suit: suitOf(event.card),
          observedCard: event.card,
        });
        continue;
      }
      if (
        offSuit &&
        origin.location === event.seat &&
        suitOf(constraint.card) === leadSuit
      ) {
        eliminate(constraint, owner, {
          code: "follow-suit-void",
          eventIndex,
          seat: event.seat,
          suit: leadSuit,
          observedCard: event.card,
        });
        continue;
      }
      if (
        offSuit &&
        state.trick?.kind === "opening" &&
        state.rules.openingOffSuit === "highest" &&
        origin.location === event.seat &&
        rankValue(constraint.card) > rankValue(event.card)
      ) {
        eliminate(constraint, owner, {
          code: "opening-highest",
          eventIndex,
          seat: event.seat,
          suit: leadSuit,
          observedCard: event.card,
        });
      }
    }
  }
}

function applyDrawConstraint(
  constraints: readonly MutableConstraint[],
  event:
    | Extract<GameEvent, { type: "waste-card-drawn" }>
    | Extract<GameEvent, { type: "player-card-drawn" }>,
  eventIndex: number,
): void {
  const constraint = constraints.find((entry) => entry.card === event.card);
  if (constraint === undefined) {
    return;
  }
  const requiredLocation =
    event.type === "waste-card-drawn" ? "waste" : event.source;
  for (const owner of ["p2", "p3"] as const) {
    const origin = constraint.origins[owner];
    if (origin.allowed && origin.location !== requiredLocation) {
      eliminate(constraint, owner, {
        code:
          event.type === "waste-card-drawn" ? "waste-source" : "draw-source",
        eventIndex,
        seat: event.seat,
        suit: suitOf(event.card),
        observedCard: event.card,
      });
    }
  }
}

function applyRevealConstraints(
  constraints: readonly MutableConstraint[],
  event: HandTakenEvent,
  eventIndex: number,
): void {
  if (event.revealedCards.length === 0) {
    return;
  }
  const revealed = new Set(event.revealedCards);
  for (const constraint of constraints) {
    const included = revealed.has(constraint.card);
    for (const owner of ["p2", "p3"] as const) {
      const origin = constraint.origins[owner];
      if (!origin.allowed) {
        continue;
      }
      if (included && origin.location !== event.target) {
        eliminate(constraint, owner, {
          code: "revealed-card-owner",
          eventIndex,
          seat: event.target,
          suit: suitOf(constraint.card),
          observedCard: constraint.card,
        });
      } else if (!included && origin.location === event.target) {
        eliminate(constraint, owner, {
          code: "revealed-hand-omission",
          eventIndex,
          seat: event.target,
          suit: suitOf(constraint.card),
          observedCard: null,
        });
      }
    }
  }
}

function updateLocations(
  constraints: readonly MutableConstraint[],
  event: Exclude<GameEvent, GameCreatedEvent>,
  nextState: PublicInformationState,
  eventIndex: number,
): void {
  const hiddenOpponentTransfer =
    event.type === "hand-taken" &&
    event.revealedCards.length === 0 &&
    isOpponentSeat(event.actor) &&
    isOpponentSeat(event.target);

  for (const constraint of constraints) {
    const exactLocation = locateExactPublicCard(
      nextState,
      constraint.card,
      eventIndex,
    );
    for (const owner of ["p2", "p3"] as const) {
      const origin = constraint.origins[owner];
      if (!origin.allowed) {
        continue;
      }
      if (exactLocation !== null) {
        origin.location = exactLocation;
      } else if (hiddenOpponentTransfer && origin.location === event.target) {
        origin.location = event.actor;
      }
      if (
        exactLocation === null &&
        origin.location !== "p2" &&
        origin.location !== "p3"
      ) {
        throw inferenceError(
          `${constraint.card} is unresolved publicly but projects to ${origin.location}.`,
          eventIndex,
          {
            card: constraint.card,
            initialOwner: owner,
            projectedLocation: origin.location,
          },
        );
      }
    }
  }
}

function ownerMask(constraint: MutableConstraint): OwnerMask {
  return ((constraint.origins.p2.allowed ? 1 : 0) |
    (constraint.origins.p3.allowed ? 2 : 0)) as OwnerMask;
}

function immutableConstraint(
  constraint: MutableConstraint,
): HiddenCardConstraint {
  return {
    card: constraint.card,
    origins: {
      p2: {
        initialOwner: "p2",
        allowed: constraint.origins.p2.allowed,
        currentLocation: constraint.origins.p2.allowed
          ? constraint.origins.p2.location
          : null,
        eliminatedBy: constraint.origins.p2.eliminatedBy,
      },
      p3: {
        initialOwner: "p3",
        allowed: constraint.origins.p3.allowed,
        currentLocation: constraint.origins.p3.allowed
          ? constraint.origins.p3.location
          : null,
        eliminatedBy: constraint.origins.p3.eliminatedBy,
      },
    },
  };
}

export function compileHardEvidence(timeline: GameTimeline): HardEvidence {
  let replay;
  try {
    replay = replayTimeline(timeline);
  } catch (cause) {
    throw new HardInferenceError(
      "INVALID_PUBLIC_HISTORY",
      "Hard inference requires a valid active public history.",
      { cause },
    );
  }
  const events = activeTimelineEvents(timeline);
  const setup = events[0];
  if (setup?.type !== "game-created") {
    throw new HardInferenceError(
      "INVALID_PUBLIC_HISTORY",
      "Hard inference history must begin with game-created.",
      { eventIndex: 0 },
    );
  }

  let state: PublicInformationState;
  try {
    state = createInitialPublicState(setup);
  } catch (cause) {
    throw new HardInferenceError(
      "INVALID_PUBLIC_HISTORY",
      "Hard inference could not initialize the public history.",
      { eventIndex: 0, cause },
    );
  }
  const constraints = initialConstraints(setup);
  const voidObservations: ChronologicalVoidObservation[] = [];

  for (let eventIndex = 1; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (event === undefined || event.type === "game-created") {
      throw new HardInferenceError(
        "INVALID_PUBLIC_HISTORY",
        `Event ${eventIndex} is missing or recreates the game.`,
        { eventIndex },
      );
    }

    const voidObservation = observedVoid(state, event, eventIndex);
    if (voidObservation !== null) {
      voidObservations.push(voidObservation);
    }
    switch (event.type) {
      case "card-played":
        applyPlayConstraints(constraints, state, event, eventIndex);
        break;
      case "waste-card-drawn":
      case "player-card-drawn":
        applyDrawConstraint(constraints, event, eventIndex);
        break;
      case "hand-taken":
        applyRevealConstraints(constraints, event, eventIndex);
        break;
    }

    let nextState: PublicInformationState;
    try {
      nextState = applyGameEvent(state, event, eventIndex);
    } catch (cause) {
      throw new HardInferenceError(
        "INVALID_PUBLIC_HISTORY",
        `Public replay failed at event ${eventIndex}.`,
        { eventIndex, cause },
      );
    }
    updateLocations(constraints, event, nextState, eventIndex);
    state = nextState;
  }

  const masks = constraints.map(ownerMask);
  const forcedP2 = masks.filter((mask) => mask === 1).length;
  const forcedP3 = masks.filter((mask) => mask === 2).length;
  const flexible = masks.filter((mask) => mask === 3).length;
  const totalWorldCount = countOwnerAssignments(masks, setup.startingCounts.p2);
  if (totalWorldCount === 0n) {
    const impossibleCards = constraints
      .filter((constraint) => ownerMask(constraint) === 0)
      .map((constraint) => constraint.card);
    throw new HardInferenceError(
      "NO_VALID_WORLDS",
      "Chronological hard evidence leaves no valid initial opponent deal.",
      {
        details: {
          historyHash: replay.semanticHash,
          p2InitialSlots: setup.startingCounts.p2,
          p3InitialSlots: setup.startingCounts.p3,
          forcedP2,
          forcedP3,
          flexible,
          impossibleCards,
          eliminations: constraints.flatMap((constraint) =>
            (["p2", "p3"] as const)
              .map((owner) => constraint.origins[owner].eliminatedBy)
              .filter(
                (elimination): elimination is OriginElimination =>
                  elimination !== null,
              ),
          ),
        },
      },
    );
  }

  for (const card of state.unresolvedCards) {
    const constraint = constraints.find((entry) => entry.card === card);
    if (constraint === undefined) {
      throw inferenceError(
        `Final unresolved card ${card} has no initial hidden constraint.`,
        events.length - 1,
        { card },
      );
    }
    for (const owner of ["p2", "p3"] as const) {
      const origin = constraint.origins[owner];
      if (
        origin.allowed &&
        origin.location !== "p2" &&
        origin.location !== "p3"
      ) {
        throw inferenceError(
          `Final unresolved card ${card} does not project to an opponent hand.`,
          events.length - 1,
          { card, initialOwner: owner, location: origin.location },
        );
      }
    }
  }
  return {
    schemaVersion: 1,
    algorithmVersion: HARD_EVIDENCE_ALGORITHM_VERSION,
    historyHash: replay.semanticHash,
    activeEventCount: events.length,
    rules: structuredClone(setup.rules),
    startingCounts: structuredClone(setup.startingCounts),
    initialUserHand: [...setup.userHand],
    hiddenCards: constraints.map(immutableConstraint),
    voidObservations,
    support: {
      p2InitialSlots: setup.startingCounts.p2,
      p3InitialSlots: setup.startingCounts.p3,
      forcedP2,
      forcedP3,
      flexible,
      totalWorldCount: totalWorldCount.toString(),
    },
    finalState: state,
  };
}
