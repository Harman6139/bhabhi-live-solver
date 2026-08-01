import { formatCard, suitOf, type Card } from "../domain/cards";

type PlayingCardProps = {
  readonly card: Card;
  readonly compact?: boolean;
  readonly decorative?: boolean;
};

export function PlayingCard({
  card,
  compact = false,
  decorative = false,
}: PlayingCardProps) {
  const formatted = formatCard(card);
  const rank = formatted.slice(0, -1);
  const suit = formatted.slice(-1);
  const red = suitOf(card) === "diamonds" || suitOf(card) === "hearts";

  return (
    <span
      className={`playing-card ${red ? "playing-card--red" : "playing-card--black"} ${
        compact ? "playing-card--compact" : ""
      }`}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : formatted}
      aria-hidden={decorative ? true : undefined}
    >
      <span className="playing-card__corner playing-card__corner--top">
        <b>{rank}</b>
        <i>{suit}</i>
      </span>
      <span className="playing-card__pip">{suit}</span>
      <span className="playing-card__corner playing-card__corner--bottom">
        <b>{rank}</b>
        <i>{suit}</i>
      </span>
    </span>
  );
}
