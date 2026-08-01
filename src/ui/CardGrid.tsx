import {
  SUITS,
  formatCard,
  sortCards,
  suitOf,
  type Card,
} from "../domain/cards";
import { PlayingCard } from "./PlayingCard";

type CardGridProps = {
  readonly cards: readonly Card[];
  readonly label: string;
  readonly onCard: (card: Card) => void;
  readonly selected?: readonly Card[];
  readonly disabled?: boolean;
  readonly compact?: boolean;
};

const SUIT_LABEL: Readonly<Record<(typeof SUITS)[number], string>> = {
  clubs: "Clubs",
  diamonds: "Diamonds",
  hearts: "Hearts",
  spades: "Spades",
};

export function CardGrid({
  cards,
  label,
  onCard,
  selected = [],
  disabled = false,
  compact = false,
}: CardGridProps) {
  const sorted = sortCards(cards);
  return (
    <div
      className={`card-grid ${compact ? "card-grid--compact" : ""}`}
      aria-label={label}
    >
      {SUITS.map((suit) => {
        const suitCards = sorted.filter((card) => suitOf(card) === suit);
        const firstCard = suitCards[0];
        if (firstCard === undefined) {
          return null;
        }
        return (
          <section
            className={`suit-row suit-row--${suit}`}
            aria-label={SUIT_LABEL[suit]}
            key={suit}
          >
            <span className="suit-row__label" aria-hidden="true">
              {formatCard(firstCard).slice(-1)}
            </span>
            <div className="suit-row__cards">
              {suitCards.map((card) => {
                const isSelected = selected.includes(card);
                return (
                  <button
                    className={`card-button ${isSelected ? "card-button--selected" : ""}`}
                    type="button"
                    key={card}
                    onClick={() => onCard(card)}
                    aria-pressed={isSelected}
                    aria-label={formatCard(card)}
                    disabled={disabled}
                  >
                    <PlayingCard card={card} compact={compact} decorative />
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
