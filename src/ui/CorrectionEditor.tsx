import { useMemo, useState } from "react";

import { parseCard } from "../domain/cards";
import type { Seat } from "../domain/seats";
import { parseGameEvent, type GameEvent } from "../events/game-events";
import { parseCardList, seatLabel } from "./session-utils";

type CorrectionEditorProps = {
  readonly eventIndex: number;
  readonly event: GameEvent;
  readonly onApply: (replacement: GameEvent) => void;
  readonly onCancel: () => void;
};

const SEAT_OPTIONS = ["user", "p2", "p3"] as const;

export function CorrectionEditor({
  eventIndex,
  event,
  onApply,
  onCancel,
}: CorrectionEditorProps) {
  const prefix = `correction-${eventIndex.toString()}`;
  const [seat, setSeat] = useState<Seat>(
    event.type === "card-played"
      ? event.seat
      : event.type === "waste-card-drawn"
        ? event.seat
        : event.type === "player-card-drawn"
          ? event.seat
          : event.type === "hand-taken"
            ? event.actor
            : "user",
  );
  const [source, setSource] = useState<Seat>(
    event.type === "player-card-drawn" ? event.source : "p2",
  );
  const [target, setTarget] = useState<Seat>(
    event.type === "hand-taken" ? event.target : "p2",
  );
  const [cardText, setCardText] = useState(
    event.type === "card-played" ||
      event.type === "waste-card-drawn" ||
      event.type === "player-card-drawn"
      ? event.card
      : "",
  );
  const [revealedText, setRevealedText] = useState(
    event.type === "hand-taken" ? event.revealedCards.join(" ") : "",
  );
  const [rawJson, setRawJson] = useState(JSON.stringify(event, null, 2));
  const [rawDirty, setRawDirty] = useState(event.type === "game-created");
  const [editorError, setEditorError] = useState<string | null>(null);

  const structured = useMemo((): GameEvent | null => {
    try {
      switch (event.type) {
        case "game-created":
          return null;
        case "card-played":
          return parseGameEvent({
            ...event,
            seat,
            card: parseCard(cardText),
          });
        case "waste-card-drawn":
          return parseGameEvent({
            ...event,
            seat,
            card: parseCard(cardText),
          });
        case "player-card-drawn":
          return parseGameEvent({
            ...event,
            seat,
            source,
            card: parseCard(cardText),
          });
        case "hand-taken":
          return parseGameEvent({
            ...event,
            actor: seat,
            target,
            revealedCards:
              revealedText.trim().length === 0
                ? []
                : parseCardList(revealedText),
          });
      }
    } catch {
      return null;
    }
  }, [cardText, event, revealedText, seat, source, target]);

  const displayedJson = rawDirty
    ? rawJson
    : JSON.stringify(structured ?? event, null, 2);

  function apply(): void {
    try {
      const replacement = rawDirty
        ? parseGameEvent(JSON.parse(rawJson) as unknown)
        : structured;
      if (replacement === null) {
        throw new Error(
          "Complete every structured field or use advanced JSON.",
        );
      }
      onApply(replacement);
    } catch (caught) {
      setEditorError(
        caught instanceof Error
          ? caught.message
          : "The corrected event is invalid.",
      );
    }
  }

  return (
    <section className="correction-editor" aria-labelledby={`${prefix}-title`}>
      <div className="section-heading">
        <div>
          <h3 id={`${prefix}-title`}>Correct event {eventIndex}</h3>
          <p className="muted">
            Structured controls cover card plays, draws, and transfers. Replay
            preserves only the valid suffix.
          </p>
        </div>
        <button className="text-button" type="button" onClick={onCancel}>
          Cancel correction {eventIndex}
        </button>
      </div>

      {event.type === "game-created" ? (
        <p className="muted">
          Setup corrections use advanced JSON because the rule profile and exact
          starting hand form one atomic event.
        </p>
      ) : (
        <div className="structured-correction-grid">
          <label htmlFor={`${prefix}-seat`}>
            {event.type === "hand-taken" ? "Actor" : "Player"}
            <select
              id={`${prefix}-seat`}
              value={seat}
              onChange={(change) => {
                setSeat(change.target.value as Seat);
                setRawDirty(false);
              }}
            >
              {SEAT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {seatLabel(option)}
                </option>
              ))}
            </select>
          </label>

          {event.type === "player-card-drawn" ? (
            <label htmlFor={`${prefix}-source`}>
              Draw source
              <select
                id={`${prefix}-source`}
                value={source}
                onChange={(change) => {
                  setSource(change.target.value as Seat);
                  setRawDirty(false);
                }}
              >
                {SEAT_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {seatLabel(option)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {event.type === "hand-taken" ? (
            <>
              <label htmlFor={`${prefix}-target`}>
                Hand target
                <select
                  id={`${prefix}-target`}
                  value={target}
                  onChange={(change) => {
                    setTarget(change.target.value as Seat);
                    setRawDirty(false);
                  }}
                >
                  {SEAT_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {seatLabel(option)}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor={`${prefix}-revealed`}>
                Revealed cards
                <textarea
                  id={`${prefix}-revealed`}
                  value={revealedText}
                  onChange={(change) => {
                    setRevealedText(change.target.value);
                    setRawDirty(false);
                  }}
                  placeholder="2c 5h qs"
                />
              </label>
            </>
          ) : (
            <label htmlFor={`${prefix}-card`}>
              Card
              <input
                id={`${prefix}-card`}
                value={cardText}
                onChange={(change) => {
                  setCardText(change.target.value);
                  setRawDirty(false);
                }}
                placeholder="qh"
                autoComplete="off"
              />
            </label>
          )}
        </div>
      )}

      <details className="advanced-correction">
        <summary>Advanced developer JSON</summary>
        <label htmlFor={`${prefix}-json`}>
          Event JSON
          <textarea
            id={`${prefix}-json`}
            className="code-editor"
            value={displayedJson}
            onChange={(change) => {
              setRawJson(change.target.value);
              setRawDirty(true);
            }}
            spellCheck={false}
          />
        </label>
      </details>

      {editorError === null ? null : (
        <p className="error-banner" role="alert">
          {editorError}
        </p>
      )}
      <button
        className="button button--primary"
        type="button"
        aria-label="Apply and replay"
        onClick={apply}
      >
        Apply correction {eventIndex} and replay
      </button>
    </section>
  );
}
