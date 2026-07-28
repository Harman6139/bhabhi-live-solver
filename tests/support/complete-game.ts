import { FULL_DECK, sortCards, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES } from "../../src/domain/rule-config";
import { SEATS, type Seat } from "../../src/domain/seats";
import type {
  CardPlayedEvent,
  GameCreatedEvent,
  GameEvent,
  PlayerCardDrawnEvent,
  WasteCardDrawnEvent,
} from "../../src/events/game-events";
import type { PublicInformationState } from "../../src/public/public-state";
import {
  applyTruthCardPlay,
  applyTruthPlayerDraw,
  applyTruthWasteDraw,
  createSimulationTruth,
  legalTruthCards,
  type SimulationTruth,
} from "../../src/simulator/truth";

export const COMPLETE_GAME_MAX_EVENTS = 512;
export const COMPLETE_GAME_POLICY_SEED = 1;

const COMPLETE_GAME_DECK_ORDER = [...FULL_DECK.slice(1), FULL_DECK[0]].filter(
  (card): card is Card => card !== undefined,
);

export const COMPLETE_GAME_DEAL: Readonly<Record<Seat, readonly Card[]>> =
  Object.freeze({
    user: Object.freeze(
      COMPLETE_GAME_DECK_ORDER.filter(
        (_card, index) => index % SEATS.length === 0,
      ),
    ),
    p2: Object.freeze(
      COMPLETE_GAME_DECK_ORDER.filter(
        (_card, index) => index % SEATS.length === 1,
      ),
    ),
    p3: Object.freeze(
      COMPLETE_GAME_DECK_ORDER.filter(
        (_card, index) => index % SEATS.length === 2,
      ),
    ),
  });

const COMPLETE_GAME_ACE_SPADES_HOLDER = SEATS.find((seat) =>
  COMPLETE_GAME_DEAL[seat].includes("AS"),
);
if (COMPLETE_GAME_ACE_SPADES_HOLDER === undefined) {
  throw new Error("The fixed complete-game deal has no Ace of Spades holder.");
}

export const COMPLETE_GAME_SETUP: GameCreatedEvent = Object.freeze({
  type: "game-created",
  schemaVersion: 1,
  rules: structuredClone(CANONICAL_RULES),
  userHand: Object.freeze([...COMPLETE_GAME_DEAL.user]),
  startingCounts: Object.freeze({
    user: COMPLETE_GAME_DEAL.user.length,
    p2: COMPLETE_GAME_DEAL.p2.length,
    p3: COMPLETE_GAME_DEAL.p3.length,
  }),
  aceSpadesHolder: COMPLETE_GAME_ACE_SPADES_HOLDER,
});

export type CompleteGameFixture = {
  readonly deal: Readonly<Record<Seat, readonly Card[]>>;
  readonly setup: GameCreatedEvent;
  readonly events: readonly GameEvent[];
  readonly finalState: PublicInformationState;
  readonly finalHands: Readonly<Record<Seat, readonly Card[]>>;
};

function stableCardOrder(cards: readonly Card[]): Card[] {
  const deckPosition = new Map(
    FULL_DECK.map((card, index) => [card, index] as const),
  );
  return [...cards].sort(
    (left, right) =>
      (deckPosition.get(left) ?? 0) - (deckPosition.get(right) ?? 0),
  );
}

function selectCard(
  cards: readonly Card[],
  selector: number,
  context: string,
): Card {
  const ordered = stableCardOrder(cards);
  const card = ordered[selector % ordered.length];
  if (card === undefined) {
    throw new Error(`No deterministic card exists for ${context}.`);
  }
  return card;
}

function chooseCardPlay(
  truth: SimulationTruth,
  selector: number,
): CardPlayedEvent {
  const seat = truth.publicState.turn;
  if (seat === null) {
    throw new Error("An active fixture state has no turn.");
  }
  const legal = legalTruthCards(truth, seat);
  if (legal.length === 0) {
    throw new Error(`The deterministic fixture has no legal card for ${seat}.`);
  }

  const card = selectCard(legal, selector, `${seat}'s legal actions`);
  return {
    type: "card-played",
    schemaVersion: 1,
    seat,
    card,
  };
}

function choosePendingEvent(
  truth: SimulationTruth,
  selector: number,
): WasteCardDrawnEvent | PlayerCardDrawnEvent {
  const pending = truth.publicState.pendingAction;
  if (pending === null) {
    throw new Error("A pending-event choice requires a pending action.");
  }

  if (pending.kind === "waste-draw") {
    const card = selectCard(
      truth.publicState.waste,
      selector,
      "an eligible waste draw",
    );
    return {
      type: "waste-card-drawn",
      schemaVersion: 1,
      seat: pending.player,
      card,
    };
  }

  const card = selectCard(
    truth.hands[pending.source],
    selector,
    `a player draw from ${pending.source}`,
  );
  return {
    type: "player-card-drawn",
    schemaVersion: 1,
    seat: pending.player,
    source: pending.source,
    card,
  };
}

function applyFixtureEvent(
  truth: SimulationTruth,
  event: Exclude<GameEvent, GameCreatedEvent>,
  eventIndex: number,
): SimulationTruth {
  switch (event.type) {
    case "card-played":
      return applyTruthCardPlay(truth, event, eventIndex);
    case "waste-card-drawn":
      return applyTruthWasteDraw(truth, event, eventIndex);
    case "player-card-drawn":
      return applyTruthPlayerDraw(truth, event, eventIndex);
    case "hand-taken":
      throw new Error("Canonical rules disable hand-taking.");
  }
}

function nextPolicyValue(value: number): number {
  let next = value | 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

export function generateCompleteGameFixture(
  policySeed = COMPLETE_GAME_POLICY_SEED,
): CompleteGameFixture {
  let truth = createSimulationTruth(COMPLETE_GAME_DEAL, CANONICAL_RULES);
  const events: GameEvent[] = [structuredClone(COMPLETE_GAME_SETUP)];
  let policyValue = policySeed >>> 0;

  while (
    truth.publicState.status === "active" &&
    events.length < COMPLETE_GAME_MAX_EVENTS
  ) {
    policyValue = nextPolicyValue(policyValue);
    const event =
      truth.publicState.pendingAction === null
        ? chooseCardPlay(truth, policyValue)
        : choosePendingEvent(truth, policyValue);
    truth = applyFixtureEvent(truth, event, events.length);
    events.push(event);
  }

  if (truth.publicState.status !== "complete") {
    throw new Error(
      `Deterministic complete-game fixture exceeded ${COMPLETE_GAME_MAX_EVENTS} events.`,
    );
  }

  return {
    deal: structuredClone(COMPLETE_GAME_DEAL),
    setup: structuredClone(COMPLETE_GAME_SETUP),
    events: structuredClone(events),
    finalState: structuredClone(truth.publicState),
    finalHands: {
      user: sortCards(truth.hands.user),
      p2: sortCards(truth.hands.p2),
      p3: sortCards(truth.hands.p3),
    },
  };
}

export const COMPLETE_GAME_FIXTURE = generateCompleteGameFixture();
export const COMPLETE_GAME_EVENTS = COMPLETE_GAME_FIXTURE.events;
