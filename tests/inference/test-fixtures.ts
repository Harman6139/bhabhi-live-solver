import { FULL_DECK, sortCards, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../../src/domain/rule-config";
import type { GameCreatedEvent, GameEvent } from "../../src/events/game-events";
import {
  appendTimelineEvent,
  createTimeline,
  type GameTimeline,
} from "../../src/events/timeline";

export function startingHand(
  required: readonly Card[],
  excluded: readonly Card[] = [],
  size: 17 | 18 = 18,
): Card[] {
  if (
    required.length > size ||
    required.some((card) => excluded.includes(card)) ||
    new Set(required).size !== required.length
  ) {
    throw new Error("Invalid starting-hand requirements.");
  }
  const cards = [...required];
  for (const card of FULL_DECK) {
    if (cards.length === size) {
      break;
    }
    if (!cards.includes(card) && !excluded.includes(card)) {
      cards.push(card);
    }
  }
  if (cards.length !== size) {
    throw new Error(`Could not construct a ${size}-card starting hand.`);
  }
  return sortCards(cards);
}

export function setupWithUserHand(
  userHand: readonly Card[],
  rules: RuleConfig = CANONICAL_RULES,
  aceSpadesHolder: GameCreatedEvent["aceSpadesHolder"] = "user",
): GameCreatedEvent {
  return {
    type: "game-created",
    schemaVersion: 1,
    rules,
    userHand,
    startingCounts:
      userHand.length === 18
        ? { user: 18, p2: 17, p3: 17 }
        : { user: 17, p2: 18, p3: 17 },
    aceSpadesHolder,
  };
}

export function timelineFrom(
  setup: GameCreatedEvent,
  events: readonly Exclude<GameEvent, GameCreatedEvent>[],
): GameTimeline {
  return events.reduce(
    (timeline, event) => appendTimelineEvent(timeline, event),
    createTimeline(setup),
  );
}

export function play(
  seat: "user" | "p2" | "p3",
  card: Card,
): Extract<GameEvent, { type: "card-played" }> {
  return { type: "card-played", schemaVersion: 1, seat, card };
}

export const TEMPORAL_RESERVED = [
  "KS",
  "QS",
  "2C",
  "KC",
  "4H",
] as const satisfies readonly Card[];

export const TEMPORAL_SETUP = setupWithUserHand(
  startingHand(["AS", "2H", "3C"], TEMPORAL_RESERVED, 18),
);

export const TEMPORAL_EVENTS = [
  play("user", "AS"),
  play("p2", "KS"),
  play("p3", "QS"),
  play("user", "2H"),
  play("p2", "2C"),
  play("user", "3C"),
  play("p2", "KC"),
  play("p3", "4H"),
  play("p2", "4H"),
] as const;

export function temporalTimeline(
  eventCount: number = TEMPORAL_EVENTS.length,
): GameTimeline {
  return timelineFrom(TEMPORAL_SETUP, TEMPORAL_EVENTS.slice(0, eventCount));
}

export function hiddenOpponentTakeTimeline(): GameTimeline {
  const takeRules: RuleConfig = {
    ...CANONICAL_RULES,
    takeHand: { mode: "next-active", configuredTargets: [] },
  };
  const setup = setupWithUserHand(
    startingHand(["AS", "2H", "2D"], ["KS", "QS", "2C", "KD", "QD"], 18),
    takeRules,
  );
  return timelineFrom(setup, [
    play("user", "AS"),
    play("p2", "KS"),
    play("p3", "QS"),
    play("user", "2H"),
    play("p2", "2C"),
    play("user", "2D"),
    play("p2", "KD"),
    play("p3", "QD"),
    {
      type: "hand-taken",
      schemaVersion: 1,
      actor: "p2",
      target: "p3",
      revealedCards: [],
    },
  ]);
}
