import { useMemo, useState, type ReactNode, type SyntheticEvent } from "react";

import { parseCard, type Card } from "../domain/cards";
import type { Seat } from "../domain/seats";
import {
  appendTimelineEvent,
  exportGameArchive,
  replayTimeline,
  undoTimeline,
  type GameTimeline,
} from "../events/timeline";
import type {
  PublicInformationState,
  RuleEffect,
} from "../public/public-state";
import { CardGrid } from "./CardGrid";
import { PlayingCard } from "./PlayingCard";
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

function GameTable({
  state,
  children,
}: {
  readonly state: PublicInformationState;
  readonly children: ReactNode;
}) {
  const seats = ["user", "p2", "p3"] as const;
  const counterclockwise = state.rules.direction === "anticlockwise";
  return (
    <section
      className="game-table"
      aria-label={`${counterclockwise ? "Counterclockwise" : "Clockwise"} game table. Current turn: ${
        state.turn === null ? "none" : seatLabel(state.turn)
      }.`}
    >
      <div className="game-table__felt" aria-hidden="true" />
      <span className="game-table__direction">
        <b aria-hidden="true">{counterclockwise ? "↺" : "↻"}</b>
        {counterclockwise ? "Counterclockwise" : "Clockwise"}
      </span>
      {seats.map((seat) => {
        const active = state.activeSeats.includes(seat);
        return (
          <div
            className={`table-seat table-seat--${seat} ${
              state.turn === seat ? "table-seat--current" : ""
            } ${active ? "" : "table-seat--out"}`}
            key={seat}
            aria-current={state.turn === seat ? "step" : undefined}
          >
            {state.turn === seat ? (
              <span className="turn-token">Turn</span>
            ) : null}
            <span className="table-seat__avatar" aria-hidden="true">
              {seat === "user" ? "Y" : seat === "p2" ? "2" : "3"}
            </span>
            <strong>{seatLabel(seat)}</strong>
            <span>{state.handCounts[seat]} cards</span>
            {state.power === seat ? <small>Power / lead</small> : null}
          </div>
        );
      })}

      {state.trick?.plays.map((play) => (
        <div
          className={`table-play table-play--${play.seat}`}
          key={play.eventIndex}
          aria-label={`${seatLabel(play.seat)} played`}
        >
          <PlayingCard card={play.card} compact />
        </div>
      ))}

      <div className="game-table__center">
        {state.trick?.plays.length ? null : (
          <span className="fresh-trick">Fresh trick</span>
        )}
        {children}
      </div>
    </section>
  );
}

function pickupNotice(
  pickup: Extract<RuleEffect, { type: "trick-picked-up" }>,
): string {
  return `Thulla: ${seatLabel(pickup.thullaBy)} played off-suit · ${seatLabel(
    pickup.picker,
  )} picked up ${pickup.cards.length.toString()} cards.`;
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

  function exportGame(): void {
    const archive = exportGameArchive(timeline);
    const blobUrl = URL.createObjectURL(
      new Blob([archive], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `bhabhi-game-${new Date()
      .toISOString()
      .replaceAll(":", "-")
      .replaceAll(".", "-")}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    setNotice("Game archive exported.");
  }

  return (
    <main className="app-shell play-shell">
      <header className="play-header play-header--table">
        <div className="play-brand">
          <span className="play-brand__mark" aria-hidden="true">
            B
          </span>
          <div>
            <p className="eyebrow">Bhabhi live solver</p>
            <h1>{actionPrompt(state)}</h1>
          </div>
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
          <button className="text-button" type="button" onClick={exportGame}>
            Export game
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

      <GameTable state={state}>
        {state.turn === "user" && state.pendingAction === null ? (
          <div className="table-recommendation" aria-live="polite">
            {liveAnalysis.analysis === null ? (
              <div className="recommendation-loading">
                <span className="thinking-dot" aria-hidden="true" />
                <strong>
                  {liveAnalysis.status === "failure" ||
                  liveAnalysis.status === "unavailable"
                    ? "Engine unavailable"
                    : "Finding your move…"}
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
          </div>
        ) : (
          <div className="table-turn-prompt">
            <span className="eyebrow">Now playing</span>
            <strong>{actionPrompt(state)}</strong>
          </div>
        )}
      </GameTable>

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

      {pickup === null ? null : (
        <aside className="thulla-receipt" aria-label="Latest thulla transfer">
          <strong>Thulla registered</strong>
          <span>{pickupNotice(pickup)}</span>
          <small>
            You {state.handCounts.user} · P2 {state.handCounts.p2} · P3{" "}
            {state.handCounts.p3}
          </small>
        </aside>
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
        <section className="move-entry table-controls">
          <div className="move-entry__heading">
            <div>
              <p className="eyebrow">
                {state.turn === "user"
                  ? "Your hand · legal cards"
                  : "Record actual play"}
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
          {state.turn === "user" && state.pendingAction === null ? (
            <CardGrid
              cards={candidateCards}
              label="Your legal cards"
              onCard={commitCard}
              compact
            />
          ) : (
            <details className="observed-card-drawer">
              <summary>Or tap the card you saw</summary>
              <CardGrid
                cards={candidateCards}
                label="Cards available for observed entry"
                onCard={commitCard}
                compact
              />
            </details>
          )}
        </section>
      )}
    </main>
  );
}
