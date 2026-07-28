export const RULE_ERROR_CODES = [
  "INVALID_SETUP",
  "GAME_ALREADY_CREATED",
  "GAME_NOT_CREATED",
  "GAME_COMPLETE",
  "WRONG_EVENT",
  "WRONG_TURN",
  "INACTIVE_PLAYER",
  "CARD_NOT_OWNED",
  "CARD_ALREADY_ACCOUNTED",
  "OPENING_REQUIRES_ACE_OF_SPADES",
  "MUST_FOLLOW_SUIT",
  "OPENING_REQUIRES_HIGHEST_OFF_SUIT",
  "FORCED_LEAD_REQUIRED",
  "TAKE_DISABLED",
  "TAKE_NOT_AVAILABLE",
  "INVALID_TAKE_TARGET",
  "DRAW_NOT_REQUIRED",
  "INVALID_DRAW_CARD",
  "INVALID_DRAW_SOURCE",
  "INVARIANT_VIOLATION",
] as const;

export type RuleErrorCode = (typeof RULE_ERROR_CODES)[number];

export class RuleViolation extends Error {
  public readonly code: RuleErrorCode;
  public readonly eventIndex: number | null;

  public constructor(
    code: RuleErrorCode,
    message: string,
    eventIndex: number | null = null,
  ) {
    super(message);
    this.name = "RuleViolation";
    this.code = code;
    this.eventIndex = eventIndex;
  }

  public atEvent(eventIndex: number): RuleViolation {
    return new RuleViolation(this.code, this.message, eventIndex);
  }
}
