import { useMemo, useState, type SyntheticEvent } from "react";

import { formatCard, parseCard, type Card } from "../domain/cards";
import type { Seat } from "../domain/seats";
import {
  appendTimelineEvent,
  replayTimeline,
  undoTimeline,
  type GameTimeline,
} from "../events/timeline";
import type {
  PublicInformationState,
  RuleEffect,
} from "../public/public-state";
import { CardGrid } from "./CardGrid";
import { RecommendationPanel } from "./RecommendationPanel";
import {
  availablePendingCards,
  availablePlayCards,
  eventForCardEntry,
  eventLabel,
  seatLabel,
} from "./session-utils";
import { useLiveAnalysis } from "./use-live-analysis";

type PlayScreenProps = {
  readonly timeline: GameTimeline;
  readonly sessionEpoch: number;
  readonly saveState: "idle" | "saving" | "saved" | "error";
  readonly onTimeline: (timeline: GameTimeline) => void;
  readonly onReplaceTimeline: (timeline: GameTimeline) => void;
  readonly onRetrySave: () => Promise<void>;
  readonly onNewGame: () => Promise<void>;
};

function actionPrompt(state: PublicInformationState): string {
  const pending = state.pendingAction;
  if (pending?.kind === "waste-draw") {
    return `${seatLabel(pending.player)}: record the card drawn from waste`;
  }
  if (pending?.kind === "player-draw") {
    return `${seatLabel(pending.player)}: record the card drawn from ${seatLabel(
      pending.source,
    )}`;
  }
  if (state.turn === null) {
    return "No move pending";
  }
  return state.turn === "user"
    ? "Your move"
    : `What did ${seatLabel(state.turn)} play?`;
}

function latestPickup(
  state: PublicInformationState,
): Extract<RuleEffect, { type: "trick-picked-up" }> | null {
  return (
    state.effects.findLast(
      (effect): effect is Extract<RuleEffect, { type: "trick-picked-up" }> =>
        effect.type === "trick-picked-up",
    ) ?? null
  );
}

function TurnCircle({ state }: { readonly state: PublicInformationState }) {
  const seats = ["user", "p2", "p3"] as const;
  return (
    <section
      className="turn-circle"
      aria-label={`Current turn: ${
        state.turn === null ? "none" : seatLabel(state.turn)
      }`}
    >
      <span className="turn-circle__arrow" aria-hidden="true">
        ↻
      </span>
      {seats.map((seat) => {
        const active = state.activeSeats.includes(seat);
        return (
          <div
            className={`turn-seat turn-seat--${seat} ${
              state.turn === seat ? "turn-seat--current" : ""
            } ${active ? "" : "turn-seat--out"}`}
            key={seat}
            aria-current={state.turn === seat ? "step" : undefined}
          >
            <strong>{seat === "user" ? "You" : seat.toUpperCase()}</strong>
            <span>{state.handCounts[seat]} cards</span>
            {state.power === seat ? <small>Power</small> : null}
          </div>
        );
      })}
    </section>
  );
}

function pickupNotice(
  pickup: Extract<RuleEffect, { type: "trick-picked-up" }>,
): string {
  return `Thulla registered: ${seatLabel(pickup.thullaBy)} played off-suit; ${seatLabel(
    pickup.picker,
  )} picked up all ${pickup.cards.length.toString()} table cards.`;
}

export function PlayScreen({
  timeline,
  sessionEpoch,
  saveState,
  onTimeline,
  onNewGame,
}: PlayScreenProps) {
  const replay = useMemo(() => replayTimeline(timeline), [timeline]);
  const state = replay.state;
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const liveAnalysis = useLiveAnalysis({
    timeline,
    sessionEpoch,
    enabled:
      state.status === "active" &&
      state.turn === "user" &&
      state.pendingAction === null,
    selectedBudget: "deep",
  });

  const candidateCards =
    state.pendingAction === null
      ? availablePlayCards(state)
      : availablePendingCards(state);
  const pickup = latestPickup(state);

  function commitCard(card: Card): void {
    try {
      const previousEffectCount = state.effects.length;
      const event = eventForCardEntry(state, card);
      const nextTimeline = appendTimelineEvent(timeline, event);
      const nextState = replayTimeline(nextTimeline).state;
      const transfer = nextState.effects
        .slice(previousEffectCount)
        .find(
          (
            effect,
          ): effect is Extract<RuleEffect, { type: "trick-picked-up" }> =>
            effect.type === "trick-picked-up",
        );
      liveAnalysis.invalidate();
      onTimeline(nextTimeline);
      setEntry("");
      setError(null);
      setNotice(
        transfer === undefined ? eventLabel(event) : pickupNotice(transfer),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "That card cannot be recorded here.",
      );
      setNotice(null);
    }
  }

  function submitEntry(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      commitCard(parseCard(entry));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "That card is invalid.",
      );
    }
  }

  function undo(): void {
    if (timeline.cursor <= 1) {
      return;
    }
    liveAnalysis.invalidate();
    onTimeline(undoTimeline(timeline));
    setError(null);
    setNotice("Last entry undone.");
  }

  return (
    <main className="app-shell play-shell">
      <header className="play-header">
        <div>
          <p className="eyebrow">Bhabhi live solver</p>
          <h1>{actionPrompt(state)}</h1>
        </div>
        <div className="play-header__actions">
          <span className={`save-dot save-dot--${saveState}`}>
            {saveState === "error" ? "Not saved" : "Saved locally"}
          </span>
          <button
            className="text-button"
            type="button"
            onClick={undo}
            disabled={timeline.cursor <= 1}
          >
            Undo
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              if (window.confirm("Start a new game?")) {
                void onNewGame();
              }
            }}
          >
            New game
          </button>
        </div>
      </header>

      <div className="play-top-grid">
        <TurnCircle state={state} />
        <section className="trick-table" aria-label="Cards on the table">
          <span className="trick-table__label">Table</span>
          <div className="trick-table__cards">
            {state.trick?.plays.length ? (
              state.trick.plays.map((play) => (
                <span className="table-card" key={play.eventIndex}>
                  <small>
                    {play.seat === "user" ? "You" : play.seat.toUpperCase()}
                  </small>
                  <strong>{formatCard(play.card)}</strong>
                </span>
              ))
            ) : (
              <span className="muted">Fresh trick</span>
            )}
          </div>
        </section>
      </div>

      {state.turn === "user" && state.pendingAction === null ? (
        <section className="top-move-slot" aria-live="polite">
          {liveAnalysis.analysis === null ? (
            <div className="recommendation-loading">
              <span className="thinking-dot" aria-hidden="true" />
              <strong>
                {liveAnalysis.status === "failure" ||
                liveAnalysis.status === "unavailable"
                  ? "Recommendation unavailable"
                  : "Calculating the strongest move…"}
              </strong>
              {liveAnalysis.message === null ? null : (
                <small>{liveAnalysis.message}</small>
              )}
            </div>
          ) : (
            <RecommendationPanel
              analysis={liveAnalysis.analysis}
              refining={liveAnalysis.refining}
            />
          )}
        </section>
      ) : null}

      {notice === null ? null : (
        <p
          className={`play-notice ${
            notice.startsWith("Thulla") ? "play-notice--thulla" : ""
          }`}
          role="status"
        >
          {notice}
        </p>
      )}
      {error === null ? null : (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {state.status === "complete" ? (
        <section className="panel game-result">
          <p className="eyebrow">Game over</p>
          <h2>
            {state.bhabhi === "user"
              ? "You are Bhabhi"
              : state.bhabhi === null
                ? "Complete"
                : `${seatLabel(state.bhabhi)} is Bhabhi`}
          </h2>
        </section>
      ) : (
        <section className="panel move-entry">
          <div className="move-entry__heading">
            <div>
              <p className="eyebrow">
                {state.turn === "user" ? "Legal cards" : "Record actual play"}
              </p>
              <h2>{actionPrompt(state)}</h2>
            </div>
            <form className="inline-entry" onSubmit={submitEntry}>
              <input
                value={entry}
                onChange={(event) => setEntry(event.target.value)}
                placeholder="Card, e.g. 10h"
                aria-label="Card played"
                autoComplete="off"
              />
              <button className="button button--primary" type="submit">
                Record
              </button>
            </form>
          </div>
          {state.turn !== "user" && state.pendingAction === null ? (
            <p className="entry-clarifier">
              These are unaccounted cards the player could reveal—not a claim
              about their hand. Tap only the card you saw played.
            </p>
          ) : null}
          <CardGrid
            cards={candidateCards}
            label={
              state.turn === "user"
                ? "Your legal cards"
                : "Unaccounted cards available for observed entry"
            }
            onCard={commitCard}
            compact
          />
        </section>
      )}

      {pickup === null ? null : (
        <details className="transfer-receipt">
          <summary>Latest thulla transfer</summary>
          <p>{pickupNotice(pickup)}</p>
          <p>
            Counts now: You {state.handCounts.user} · P2 {state.handCounts.p2} ·
            P3 {state.handCounts.p3}
          </p>
        </details>
      )}
    </main>
  );
}
