import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
} from "react";

import { formatCard, parseCard, type Card } from "../domain/cards";
import type { Seat } from "../domain/seats";
import type { GameEvent } from "../events/game-events";
import {
  appendTimelineEvent,
  correctTimelineEventRebased,
  exportGameArchive,
  importGameArchive,
  redoTimeline,
  replayTimeline,
  undoTimeline,
  type GameTimeline,
} from "../events/timeline";
import type { PublicInformationState } from "../public/public-state";
import type { SolverBudgetId } from "../search";
import { CardGrid } from "./CardGrid";
import { CorrectionEditor } from "./CorrectionEditor";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { RecommendationPanel } from "./RecommendationPanel";
import {
  createPublicDebugSnapshot,
  serializePublicDebugSnapshot,
} from "./debug-snapshot";
import {
  availablePendingCards,
  availablePlayCards,
  eventForCardEntry,
  eventLabel,
  makeHandTakenEvent,
  parseCardList,
  seatLabel,
  takeTargets,
} from "./session-utils";
import { useLiveAnalysis } from "./use-live-analysis";

type TrackerScreenProps = {
  readonly timeline: GameTimeline;
  readonly sessionEpoch: number;
  readonly saveState: "idle" | "saving" | "saved" | "error";
  readonly onTimeline: (timeline: GameTimeline) => void;
  readonly onReplaceTimeline: (timeline: GameTimeline) => void;
  readonly onRetrySave: () => Promise<void>;
  readonly onNewGame: () => Promise<void>;
};

type PlayerPanelProps = {
  readonly seat: Seat;
  readonly state: PublicInformationState;
};

function PlayerPanel({ seat, state }: PlayerPanelProps) {
  const known =
    seat === "user" ? state.userHand : state.knownOpponentCards[seat];
  const active = state.activeSeats.includes(seat);
  return (
    <article
      className={`player-panel ${state.turn === seat ? "player-panel--turn" : ""}`}
      aria-label={seatLabel(seat)}
    >
      <div className="player-panel__topline">
        <h3>{seatLabel(seat)}</h3>
        <span className={`status-dot ${active ? "" : "status-dot--out"}`}>
          {active ? "Active" : "Escaped"}
        </span>
      </div>
      <strong className="hand-count">{state.handCounts[seat]}</strong>
      <span className="muted">cards</span>
      <div className="player-badges">
        {state.power === seat ? <span>Power</span> : null}
        {state.turn === seat ? <span>Turn</span> : null}
        {state.bhabhi === seat ? (
          <span className="danger-chip">Bhabhi</span>
        ) : null}
      </div>
      <p className="known-cards">
        {seat === "user"
          ? "Exact hand"
          : `${known.length} exact known · ${state.handCounts[seat] - known.length} unresolved`}
      </p>
      {known.length > 0 ? (
        <ul
          className="known-card-list"
          aria-label={`${seatLabel(seat)} known cards`}
        >
          {known.map((card) => (
            <li key={card}>{formatCard(card)}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function entryPrompt(state: PublicInformationState): string {
  const pending = state.pendingAction;
  if (pending?.kind === "waste-draw") {
    return `${seatLabel(pending.player)} draws one card from prior waste`;
  }
  if (pending?.kind === "player-draw") {
    return `${seatLabel(pending.player)} draws from ${seatLabel(pending.source)}`;
  }
  if (state.turn !== null) {
    return `${seatLabel(state.turn)} ${state.trick?.plays.length === 0 ? "leads" : "plays"}`;
  }
  return "No action is pending";
}

function SaveIndicator({
  state,
}: {
  readonly state: TrackerScreenProps["saveState"];
}) {
  const copy = {
    idle: "Local save ready",
    saving: "Saving locally…",
    saved: "Saved on this device",
    error: "Local save unavailable",
  }[state];
  return (
    <span
      className={`save-indicator save-indicator--${state}`}
      aria-live="polite"
    >
      {copy}
    </span>
  );
}

export function TrackerScreen({
  timeline,
  sessionEpoch,
  saveState,
  onTimeline,
  onReplaceTimeline,
  onRetrySave,
  onNewGame,
}: TrackerScreenProps) {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const replay = useMemo(() => replayTimeline(timeline), [timeline]);
  const state = replay.state;
  const [selectedBudget, setSelectedBudget] =
    useState<SolverBudgetId>("balanced");
  const liveAnalysis = useLiveAnalysis({
    timeline,
    sessionEpoch,
    enabled:
      state.status === "active" &&
      state.turn === "user" &&
      state.pendingAction === null,
    selectedBudget,
  });
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [takeTarget, setTakeTarget] = useState<Seat | "">("");
  const [revealed, setRevealed] = useState("");
  const [correctingIndex, setCorrectingIndex] = useState<number | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [resetting, setResetting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const resetDialogRef = useRef<HTMLElement>(null);
  const keepGameRef = useRef<HTMLButtonElement>(null);
  const newGameButtonRef = useRef<HTMLButtonElement>(null);
  const restoreResetFocus = useRef(false);

  useEffect(() => {
    if (confirmNew) {
      keepGameRef.current?.focus();
    } else if (restoreResetFocus.current) {
      restoreResetFocus.current = false;
      newGameButtonRef.current?.focus();
    }
  }, [confirmNew]);

  const candidateCards =
    state.pendingAction === null
      ? availablePlayCards(state)
      : availablePendingCards(state);
  const legalTakeTargets = takeTargets(state);

  function publishTimeline(next: GameTimeline): void {
    liveAnalysis.invalidate();
    onTimeline(next);
  }

  function commitEvent(event: Exclude<GameEvent, { type: "game-created" }>) {
    try {
      const next = appendTimelineEvent(timeline, event);
      publishTimeline(next);
      setEntry("");
      setError(null);
      setNotice(eventLabel(event));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The event is not valid in this position.",
      );
      setNotice(null);
    }
  }

  function enterCard(card: Card): void {
    commitEvent(eventForCardEntry(state, card));
  }

  function submitQuickEntry(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      enterCard(parseCard(entry));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "That card is invalid.",
      );
    }
  }

  function submitTake(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (takeTarget === "") {
      setError("Choose the hand that was taken.");
      return;
    }
    try {
      const cards = revealed.trim() === "" ? [] : parseCardList(revealed);
      commitEvent(makeHandTakenEvent(state, takeTarget, cards));
      setTakeTarget("");
      setRevealed("");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The hand transfer is invalid.",
      );
    }
  }

  function beginCorrection(index: number): void {
    const event = timeline.events[index];
    if (event === undefined) {
      return;
    }
    setCorrectingIndex(index);
    setError(null);
  }

  function applyCorrection(replacement: GameEvent): void {
    if (correctingIndex === null) {
      return;
    }
    try {
      const result = correctTimelineEventRebased(
        timeline,
        correctingIndex,
        replacement,
      );
      publishTimeline(result.timeline);
      setCorrectingIndex(null);
      setError(null);
      setNotice(
        result.firstInvalidEventIndex === null
          ? "Correction replayed through the complete history."
          : `Correction kept the valid prefix; ${result.timeline.orphanedEvents.length} stale event(s) moved to review.`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The correction is invalid.",
      );
    }
  }

  function exportArchive(): void {
    const text = exportGameArchive(timeline);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `getaway-game-${replay.semanticHash.slice(-8)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Canonical game archive exported.");
  }

  function downloadDebugSnapshot(): void {
    if (liveAnalysis.analysis === null) {
      return;
    }
    const serialized = serializePublicDebugSnapshot(
      createPublicDebugSnapshot({
        timeline,
        analysis: liveAnalysis.analysis,
        lastIncident: liveAnalysis.lastIncident,
      }),
    );
    const blob = new Blob([serialized], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `getaway-debug-${replay.semanticHash.slice(-8)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importArchive(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) {
      return;
    }
    try {
      const imported = importGameArchive(await file.text());
      liveAnalysis.invalidate();
      onReplaceTimeline(imported);
      setError(null);
      setNotice(`Imported ${imported.cursor} active event(s).`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The selected archive is invalid.",
      );
    }
  }

  function openResetConfirmation(): void {
    restoreResetFocus.current = true;
    setConfirmNew(true);
  }

  function closeResetConfirmation(): void {
    if (!resetting) {
      setConfirmNew(false);
    }
  }

  function handleResetDialogKeyDown(
    event: ReactKeyboardEvent<HTMLElement>,
  ): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeResetConfirmation();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const controls = Array.from(
      resetDialogRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? [],
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function clearAndStartNew(): Promise<void> {
    if (resetting) {
      return;
    }
    setResetting(true);
    setError(null);
    try {
      liveAnalysis.invalidate();
      await onNewGame();
    } catch (caught) {
      setResetting(false);
      setError(
        caught instanceof Error
          ? caught.message
          : "The local game could not be cleared.",
      );
      keepGameRef.current?.focus();
    }
  }

  if (confirmNew) {
    return (
      <main className="app-shell reset-shell">
        <section
          ref={resetDialogRef}
          className="confirm-banner confirm-banner--modal"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="reset-title"
          aria-describedby="reset-description"
          aria-busy={resetting}
          onKeyDown={handleResetDialogKeyDown}
        >
          <div>
            <h1 id="reset-title">Start over?</h1>
            <p id="reset-description">
              The current local save will be cleared. Export first if needed.
            </p>
            {error === null ? null : (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
          </div>
          <div>
            <button
              className="button button--danger"
              type="button"
              disabled={resetting}
              onClick={() => void clearAndStartNew()}
            >
              {resetting ? "Clearing local game…" : "Clear and start new"}
            </button>
            <button
              ref={keepGameRef}
              className="button button--secondary"
              type="button"
              disabled={resetting}
              onClick={closeResetConfirmation}
            >
              Keep game
            </button>
          </div>
        </section>
      </main>
    );
  }

  const lastEffect = state.effects.at(-1);
  return (
    <main className="app-shell tracker-shell">
      <header className="tracker-header">
        <div>
          <p className="eyebrow">
            {state.status === "complete"
              ? "Game complete"
              : `${state.phase} · ${state.rules.direction}`}
          </p>
          <h1>Getaway live tracker</h1>
          <p className="hash-line">
            Public history <code>{replay.semanticHash}</code>
          </p>
        </div>
        <div className="header-actions">
          <SaveIndicator state={saveState} />
          {saveState === "error" ? (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void onRetrySave()}
            >
              Retry local save
            </button>
          ) : null}
          <button
            className="button button--secondary"
            type="button"
            onClick={exportArchive}
          >
            Export
          </button>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => importRef.current?.click()}
          >
            Import
          </button>
          <input
            className="sr-only"
            ref={importRef}
            type="file"
            accept="application/json,.json"
            onChange={(event) => void importArchive(event)}
            aria-label="Import game archive"
          />
          <button
            ref={newGameButtonRef}
            className="button button--ghost"
            type="button"
            onClick={openResetConfirmation}
          >
            New game
          </button>
        </div>
      </header>

      <section className="player-grid" aria-label="Player state">
        {(["user", "p2", "p3"] as const).map((seat) => (
          <PlayerPanel key={seat} seat={seat} state={state} />
        ))}
      </section>

      <section
        className="panel analysis-control-panel"
        aria-labelledby="analysis-control-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">Local-first decision support</p>
            <h2 id="analysis-control-title">Live solver</h2>
          </div>
          <label>
            Analysis budget
            <select
              value={selectedBudget}
              onChange={(event) =>
                setSelectedBudget(event.target.value as SolverBudgetId)
              }
            >
              <option value="instant">Instant</option>
              <option value="balanced">Balanced</option>
              <option value="deep">Deep</option>
              <option value="offline">Offline</option>
            </select>
          </label>
        </div>
        <p aria-live="polite">
          {liveAnalysis.message ??
            (state.turn === "user" && state.pendingAction === null
              ? liveAnalysis.status === "ready"
                ? "Recommendation is current for this public history."
                : "Preparing analysis for this public history."
              : "Analysis waits for the next user decision.")}
        </p>
      </section>

      {liveAnalysis.analysis === null ? null : (
        <>
          <RecommendationPanel
            analysis={liveAnalysis.analysis}
            refining={liveAnalysis.refining}
          />
          <DiagnosticsPanel
            analysis={liveAnalysis.analysis}
            lastIncident={liveAnalysis.lastIncident}
            onDownloadSnapshot={downloadDebugSnapshot}
          />
        </>
      )}

      {state.status === "complete" ? (
        <section
          className="panel terminal-panel"
          aria-labelledby="result-title"
        >
          <p className="eyebrow">Terminal result · exact</p>
          <h2 id="result-title">
            {state.bhabhi === null
              ? "Game complete"
              : state.bhabhi === "user"
                ? "You are Bhabhi"
                : `${seatLabel(state.bhabhi)} is Bhabhi`}
          </h2>
          <p>
            This result was replayed from {timeline.cursor} active events. You
            can undo or correct history below.
          </p>
        </section>
      ) : (
        <section className="panel action-panel" aria-labelledby="action-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Record the table</p>
              <h2 id="action-title">{entryPrompt(state)}</h2>
              {state.trick?.forcedLeadCard === null ||
              state.trick?.forcedLeadCard === undefined ||
              state.trick.plays.length > 0 ? null : (
                <p className="forced-note">
                  Forced lead: {formatCard(state.trick.forcedLeadCard)}
                </p>
              )}
            </div>
            <form className="quick-entry" onSubmit={submitQuickEntry}>
              <label htmlFor="live-card-entry">Keyboard entry</label>
              <div>
                <input
                  id="live-card-entry"
                  value={entry}
                  onChange={(event) => setEntry(event.target.value)}
                  placeholder="qh, 10d, as"
                  autoComplete="off"
                  autoFocus
                />
                <button className="button button--primary" type="submit">
                  Record
                </button>
              </div>
            </form>
          </div>
          <CardGrid
            cards={candidateCards}
            onCard={enterCard}
            label="Cards consistent with current public information"
            compact
          />
          {candidateCards.length === 0 ? (
            <p className="empty-copy">
              No card candidates are available. Check the preceding history or
              active household profile.
            </p>
          ) : null}
        </section>
      )}

      {state.trick !== null && state.trick.plays.length > 0 ? (
        <section className="panel current-trick" aria-labelledby="trick-title">
          <div>
            <p className="eyebrow">Current trick</p>
            <h2 id="trick-title">
              {state.trick.leadSuit ?? "Waiting for lead"}
            </h2>
          </div>
          <ol>
            {state.trick.plays.map((play) => (
              <li key={`${play.eventIndex}-${play.card}`}>
                <span>{seatLabel(play.seat)}</span>
                <strong>{formatCard(play.card)}</strong>
                {play.offSuit ? <em>Thulla</em> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {legalTakeTargets.length > 0 ? (
        <details className="panel take-panel">
          <summary>Record a take-hand action</summary>
          <form onSubmit={submitTake}>
            <label>
              Hand taken
              <select
                value={takeTarget}
                onChange={(event) =>
                  setTakeTarget(event.target.value as Seat | "")
                }
              >
                <option value="">Choose target</option>
                {legalTakeTargets.map((seat) => (
                  <option key={seat} value={seat}>
                    {seatLabel(seat)} · {state.handCounts[seat]} cards
                  </option>
                ))}
              </select>
            </label>
            {state.turn === "user" &&
            takeTarget !== "" &&
            takeTarget !== "user" ? (
              <label>
                Entire revealed hand
                <textarea
                  value={revealed}
                  onChange={(event) => setRevealed(event.target.value)}
                  placeholder="Enter every card, e.g. 2c 5h qs"
                />
              </label>
            ) : null}
            <button className="button button--secondary" type="submit">
              Record hand transfer
            </button>
          </form>
        </details>
      ) : null}

      <section className="panel history-panel" aria-labelledby="history-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Deterministic replay</p>
            <h2 id="history-title">History</h2>
          </div>
          <div className="history-controls">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => {
                publishTimeline(undoTimeline(timeline));
                setNotice("Undid the latest active event.");
              }}
              disabled={timeline.cursor <= 1}
            >
              Undo
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => {
                try {
                  publishTimeline(redoTimeline(timeline));
                  setNotice("Restored the next event.");
                  setError(null);
                } catch (caught) {
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : "Redo is no longer valid.",
                  );
                }
              }}
              disabled={timeline.cursor >= timeline.events.length}
            >
              Redo
            </button>
          </div>
        </div>

        <ol className="event-list">
          {timeline.events.map((event, index) => {
            const active = index < timeline.cursor;
            return (
              <li
                className={active ? "" : "event-list__redo"}
                key={`${index}-${event.type}`}
              >
                <span className="event-index">{index}</span>
                <span>
                  {eventLabel(event)}
                  {!active ? <small>Redo tail</small> : null}
                </span>
                {active ? (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => beginCorrection(index)}
                  >
                    Correct
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>

        {correctingIndex === null ||
        timeline.events[correctingIndex] === undefined ? null : (
          <CorrectionEditor
            eventIndex={correctingIndex}
            event={timeline.events[correctingIndex]}
            onApply={applyCorrection}
            onCancel={() => setCorrectingIndex(null)}
          />
        )}

        {timeline.orphanedEvents.length > 0 ? (
          <details className="orphan-panel">
            <summary>
              Review {timeline.orphanedEvents.length} displaced event(s)
            </summary>
            <ol>
              {timeline.orphanedEvents.map((event, index) => (
                <li key={`${index}-${event.type}`}>{eventLabel(event)}</li>
              ))}
            </ol>
          </details>
        ) : null}
      </section>

      <footer className="tracker-footer">
        <div aria-live="assertive">
          {error === null ? null : <p className="error-banner">{error}</p>}
          {error === null && notice !== null ? (
            <p className="notice-banner">{notice}</p>
          ) : null}
        </div>
        <p>
          Waste: {state.waste.length} · Active events: {timeline.cursor} · Last
          effect: {lastEffect?.type ?? "setup"}
        </p>
      </footer>
    </main>
  );
}
