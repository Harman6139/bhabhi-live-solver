import { z } from "zod";

import { isCard, type Card } from "../domain/cards";
import { ruleConfigSchema, type RuleConfig } from "../domain/rule-config";
import { SEATS, type Seat } from "../domain/seats";

export type StartingCounts = Readonly<Record<Seat, number>>;

export type GameCreatedEvent = {
  readonly type: "game-created";
  readonly schemaVersion: 1;
  readonly rules: RuleConfig;
  readonly userHand: readonly Card[];
  readonly startingCounts: StartingCounts;
  readonly aceSpadesHolder: Seat;
};

export type CardPlayedEvent = {
  readonly type: "card-played";
  readonly schemaVersion: 1;
  readonly seat: Seat;
  readonly card: Card;
};

export type WasteCardDrawnEvent = {
  readonly type: "waste-card-drawn";
  readonly schemaVersion: 1;
  readonly seat: Seat;
  readonly card: Card;
};

export type PlayerCardDrawnEvent = {
  readonly type: "player-card-drawn";
  readonly schemaVersion: 1;
  readonly seat: Seat;
  readonly source: Seat;
  readonly card: Card;
};

export type HandTakenEvent = {
  readonly type: "hand-taken";
  readonly schemaVersion: 1;
  readonly actor: Seat;
  readonly target: Seat;
  readonly revealedCards: readonly Card[];
};

export type GameEvent =
  | GameCreatedEvent
  | CardPlayedEvent
  | WasteCardDrawnEvent
  | PlayerCardDrawnEvent
  | HandTakenEvent;

const cardSchema = z.custom<Card>(isCard, {
  message: "Expected a canonical card code such as QH or AS.",
});

const startingCountsSchema: z.ZodType<StartingCounts> = z.object({
  user: z.int().nonnegative(),
  p2: z.int().nonnegative(),
  p3: z.int().nonnegative(),
});

export const gameCreatedEventSchema = z.object({
  type: z.literal("game-created"),
  schemaVersion: z.literal(1),
  rules: ruleConfigSchema,
  userHand: z.array(cardSchema),
  startingCounts: startingCountsSchema,
  aceSpadesHolder: z.enum(SEATS),
});

export const gameEventSchema = z.discriminatedUnion("type", [
  gameCreatedEventSchema,
  z.object({
    type: z.literal("card-played"),
    schemaVersion: z.literal(1),
    seat: z.enum(SEATS),
    card: cardSchema,
  }),
  z.object({
    type: z.literal("waste-card-drawn"),
    schemaVersion: z.literal(1),
    seat: z.enum(SEATS),
    card: cardSchema,
  }),
  z.object({
    type: z.literal("player-card-drawn"),
    schemaVersion: z.literal(1),
    seat: z.enum(SEATS),
    source: z.enum(SEATS),
    card: cardSchema,
  }),
  z.object({
    type: z.literal("hand-taken"),
    schemaVersion: z.literal(1),
    actor: z.enum(SEATS),
    target: z.enum(SEATS),
    revealedCards: z.array(cardSchema),
  }),
]);

export function parseGameEvent(value: unknown): GameEvent {
  return gameEventSchema.parse(value);
}
