export const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;
export type Suit = (typeof SUITS)[number];

export const RANK_CODES = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "T",
  "J",
  "Q",
  "K",
  "A",
] as const;
export type RankCode = (typeof RANK_CODES)[number];

export const SUIT_CODES = ["C", "D", "H", "S"] as const;
export type SuitCode = (typeof SUIT_CODES)[number];
export type Card = `${RankCode}${SuitCode}`;

const SUIT_BY_CODE: Readonly<Record<SuitCode, Suit>> = {
  C: "clubs",
  D: "diamonds",
  H: "hearts",
  S: "spades",
};

const CODE_BY_SUIT: Readonly<Record<Suit, SuitCode>> = {
  clubs: "C",
  diamonds: "D",
  hearts: "H",
  spades: "S",
};

const SUIT_SYMBOL: Readonly<Record<Suit, string>> = {
  clubs: "♣",
  diamonds: "♦",
  hearts: "♥",
  spades: "♠",
};

const RANK_VALUE: Readonly<Record<RankCode, number>> = Object.fromEntries(
  RANK_CODES.map((rank, index) => [rank, index + 2]),
) as Readonly<Record<RankCode, number>>;

const CARD_PATTERN = /^(10|[2-9tjqka])([cdhs♣♦♥♠])$/i;

const SYMBOL_TO_CODE: Readonly<Record<string, SuitCode>> = {
  "♣": "C",
  "♦": "D",
  "♥": "H",
  "♠": "S",
};

export const FULL_DECK: readonly Card[] = Object.freeze(
  SUIT_CODES.flatMap((suit) =>
    RANK_CODES.map((rank): Card => `${rank}${suit}`),
  ),
);

export const ACE_OF_SPADES: Card = "AS";

export class CardParseError extends Error {
  public readonly input: string;

  public constructor(input: string) {
    super(`"${input}" is not a card. Use aliases such as qh, 10d, or as.`);
    this.name = "CardParseError";
    this.input = input;
  }
}

export function isCard(value: unknown): value is Card {
  return typeof value === "string" && FULL_DECK.includes(value as Card);
}

export function parseCard(input: string): Card {
  const normalized = input.trim();
  const match = CARD_PATTERN.exec(normalized);
  if (match === null) {
    throw new CardParseError(input);
  }

  const rawRank = match[1];
  const rawSuit = match[2];
  if (rawRank === undefined || rawSuit === undefined) {
    throw new CardParseError(input);
  }

  const rank = (
    rawRank.toUpperCase() === "10" ? "T" : rawRank.toUpperCase()
  ) as RankCode;
  const suit = (SYMBOL_TO_CODE[rawSuit] ?? rawSuit.toUpperCase()) as SuitCode;
  const card: Card = `${rank}${suit}`;
  if (!isCard(card)) {
    throw new CardParseError(input);
  }
  return card;
}

export function tryParseCard(input: string): Card | null {
  try {
    return parseCard(input);
  } catch (error) {
    if (error instanceof CardParseError) {
      return null;
    }
    throw error;
  }
}

export function rankCodeOf(card: Card): RankCode {
  return card.slice(0, -1) as RankCode;
}

export function rankValue(card: Card): number {
  return RANK_VALUE[rankCodeOf(card)];
}

export function suitCodeOf(card: Card): SuitCode {
  return card.at(-1) as SuitCode;
}

export function suitOf(card: Card): Suit {
  return SUIT_BY_CODE[suitCodeOf(card)];
}

export function cardFrom(rank: RankCode, suit: Suit): Card {
  return `${rank}${CODE_BY_SUIT[suit]}`;
}

export function compareCardsByRank(left: Card, right: Card): number {
  return rankValue(left) - rankValue(right);
}

export function sortCards(cards: readonly Card[]): Card[] {
  const suitOrder = new Map<Suit, number>(
    SUITS.map((suit, index) => [suit, index]),
  );
  return [...cards].sort((left, right) => {
    const suitDelta =
      (suitOrder.get(suitOf(left)) ?? 0) - (suitOrder.get(suitOf(right)) ?? 0);
    return suitDelta === 0 ? compareCardsByRank(left, right) : suitDelta;
  });
}

export function formatCard(card: Card): string {
  const rank = rankCodeOf(card) === "T" ? "10" : rankCodeOf(card);
  return `${rank}${SUIT_SYMBOL[suitOf(card)]}`;
}

export function assertUniqueCards(
  cards: readonly Card[],
  context = "card collection",
): void {
  const seen = new Set<Card>();
  for (const card of cards) {
    if (seen.has(card)) {
      throw new Error(
        `${context} contains duplicate card ${formatCard(card)}.`,
      );
    }
    seen.add(card);
  }
}
