import { z } from "zod";

import { SEATS, type Direction, type Seat } from "./seats";

export const TAKE_HAND_MODES = [
  "disabled",
  "next-active",
  "adjacent",
  "configured",
] as const;
export type TakeHandMode = (typeof TAKE_HAND_MODES)[number];

export const ZERO_POWER_MODES = [
  "immediate-escape",
  "waste-draw",
  "draw-from-player",
] as const;
export type ZeroCardsWithPowerMode = (typeof ZERO_POWER_MODES)[number];

export const OPENING_OFF_SUIT_MODES = ["any", "highest"] as const;
export type OpeningOffSuitMode = (typeof OPENING_OFF_SUIT_MODES)[number];

export const TWO_PLAYER_MODES = [
  "pagat-shootout",
  "normal",
  "simplified-thulla-wins",
] as const;
export type TwoPlayerMode = (typeof TWO_PLAYER_MODES)[number];

export type RuleConfig = {
  readonly schemaVersion: 1;
  readonly direction: Direction;
  readonly takeHand: {
    readonly mode: TakeHandMode;
    readonly configuredTargets: readonly Seat[];
  };
  readonly zeroCardsWithPower: {
    readonly mode: ZeroCardsWithPowerMode;
    readonly drawFromTarget: "next-active" | "configured";
    readonly configuredTarget: Seat | null;
  };
  readonly openingOffSuit: OpeningOffSuitMode;
  readonly twoPlayer: TwoPlayerMode;
};

export const ruleConfigSchema: z.ZodType<RuleConfig> = z
  .object({
    schemaVersion: z.literal(1),
    direction: z.enum(["clockwise", "anticlockwise"]),
    takeHand: z.object({
      mode: z.enum(TAKE_HAND_MODES),
      configuredTargets: z.array(z.enum(SEATS)),
    }),
    zeroCardsWithPower: z.object({
      mode: z.enum(ZERO_POWER_MODES),
      drawFromTarget: z.enum(["next-active", "configured"]),
      configuredTarget: z.enum(SEATS).nullable(),
    }),
    openingOffSuit: z.enum(OPENING_OFF_SUIT_MODES),
    twoPlayer: z.enum(TWO_PLAYER_MODES),
  })
  .superRefine((config, context) => {
    if (
      config.takeHand.mode === "configured" &&
      config.takeHand.configuredTargets.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["takeHand", "configuredTargets"],
        message: "Configured take-hand mode requires at least one target.",
      });
    }

    if (
      config.zeroCardsWithPower.mode === "draw-from-player" &&
      config.zeroCardsWithPower.drawFromTarget === "configured" &&
      config.zeroCardsWithPower.configuredTarget === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["zeroCardsWithPower", "configuredTarget"],
        message: "Configured draw-from-player mode requires a target.",
      });
    }
  });

export const CANONICAL_RULES = {
  schemaVersion: 1,
  direction: "clockwise",
  takeHand: {
    mode: "disabled",
    configuredTargets: [],
  },
  zeroCardsWithPower: {
    mode: "waste-draw",
    drawFromTarget: "next-active",
    configuredTarget: null,
  },
  openingOffSuit: "any",
  twoPlayer: "pagat-shootout",
} as const satisfies RuleConfig;

export function parseRuleConfig(value: unknown): RuleConfig {
  return ruleConfigSchema.parse(value);
}
