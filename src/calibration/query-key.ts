import { SUITS, isCard, type Card, type Suit } from "../domain/cards";
import type { OpponentSeat } from "../domain/seats";

export type ParsedCalibrationQuery =
  | {
      readonly family: "card-owner";
      readonly card: Card;
    }
  | {
      readonly family: "current-void" | "suit-length";
      readonly seat: OpponentSeat;
      readonly suit: Suit;
    }
  | {
      readonly family: "can-overtake";
      readonly seat: OpponentSeat;
      readonly suit: Suit;
      readonly rankToBeat: number;
    }
  | {
      readonly family: "joint" | "conditional";
      readonly overtakeSeat: OpponentSeat;
      readonly voidSeat: OpponentSeat;
      readonly suit: Suit;
      readonly rankToBeat: number;
    };

function fail(message: string): never {
  throw new Error(`Calibration query key is invalid: ${message}`);
}

function isOpponentSeat(value: string | undefined): value is OpponentSeat {
  return value === "p2" || value === "p3";
}

function isSuit(value: string | undefined): value is Suit {
  return SUITS.some((suit) => suit === value);
}

function parsedRank(value: string | undefined): number {
  const rank = Number(value);
  if (!Number.isSafeInteger(rank) || rank < 2 || rank > 14) {
    fail(`rank "${value ?? ""}" is outside [2, 14].`);
  }
  return rank;
}

export function calibrationQueryKey(query: ParsedCalibrationQuery): string {
  switch (query.family) {
    case "card-owner":
      return `card-owner:${query.card}`;
    case "current-void":
    case "suit-length":
      return `${query.family}:${query.seat}:${query.suit}`;
    case "can-overtake":
      return `can-overtake:${query.seat}:${query.suit}:${query.rankToBeat.toString()}`;
    case "joint":
    case "conditional":
      return `${query.family}:overtake:${query.overtakeSeat}:void:${query.voidSeat}:${query.suit}:${query.rankToBeat.toString()}`;
  }
}

export function parseCalibrationQueryKey(
  value: string,
): ParsedCalibrationQuery {
  const parts = value.split(":");
  const family = parts[0];
  if (family === "card-owner" && parts.length === 2 && isCard(parts[1])) {
    return { family, card: parts[1] };
  }
  if (
    (family === "current-void" || family === "suit-length") &&
    parts.length === 3 &&
    isOpponentSeat(parts[1]) &&
    isSuit(parts[2])
  ) {
    return { family, seat: parts[1], suit: parts[2] };
  }
  if (
    family === "can-overtake" &&
    parts.length === 4 &&
    isOpponentSeat(parts[1]) &&
    isSuit(parts[2])
  ) {
    return {
      family,
      seat: parts[1],
      suit: parts[2],
      rankToBeat: parsedRank(parts[3]),
    };
  }
  if (
    (family === "joint" || family === "conditional") &&
    parts.length === 7 &&
    parts[1] === "overtake" &&
    isOpponentSeat(parts[2]) &&
    parts[3] === "void" &&
    isOpponentSeat(parts[4]) &&
    parts[2] !== parts[4] &&
    isSuit(parts[5])
  ) {
    return {
      family,
      overtakeSeat: parts[2],
      voidSeat: parts[4],
      suit: parts[5],
      rankToBeat: parsedRank(parts[6]),
    };
  }
  fail(`"${value}" is not a supported query.`);
}
