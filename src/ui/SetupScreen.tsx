import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
} from "react";

import {
  ACE_OF_SPADES,
  FULL_DECK,
  parseCard,
  sortCards,
  type Card,
} from "../domain/cards";
import {
  CANONICAL_RULES,
  parseRuleConfig,
  type OpeningOffSuitMode,
  type RuleConfig,
  type TakeHandMode,
  type TwoPlayerMode,
  type ZeroCardsWithPowerMode,
} from "../domain/rule-config";
import type { Direction, Seat } from "../domain/seats";
import type { GameCreatedEvent } from "../events/game-events";
import { CardGrid } from "./CardGrid";
import { seatLabel } from "./session-utils";

type SetupScreenProps = {
  readonly onCreate: (event: GameCreatedEvent) => void;
  readonly onImport: (serialized: string) => void;
};

export function SetupScreen({ onCreate, onImport }: SetupScreenProps) {
  const [userCount, setUserCount] = useState<17 | 18>(18);
  const [selected, setSelected] = useState<Card[]>([]);
  const [alias, setAlias] = useState("");
  const [aceOpponent, setAceOpponent] = useState<"p2" | "p3">("p2");
  const [eighteenOpponent, setEighteenOpponent] = useState<"p2" | "p3">("p2");
  const [direction, setDirection] = useState<Direction>("clockwise");
  const [takeMode, setTakeMode] = useState<TakeHandMode>("disabled");
  const [takeTargets, setTakeTargets] = useState<Seat[]>([]);
  const [zeroMode, setZeroMode] =
    useState<ZeroCardsWithPowerMode>("waste-draw");
  const [drawTargetMode, setDrawTargetMode] = useState<
    "next-active" | "configured"
  >("next-active");
  const [drawTarget, setDrawTarget] = useState<Seat>("p2");
  const [openingMode, setOpeningMode] = useState<OpeningOffSuitMode>("any");
  const [twoPlayer, setTwoPlayer] = useState<TwoPlayerMode>("pagat-shootout");
  const [error, setError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const aceHolder: Seat = selected.includes(ACE_OF_SPADES)
    ? "user"
    : aceOpponent;
  const remaining = userCount - selected.length;
  const canStart =
    remaining === 0 && (takeMode !== "configured" || takeTargets.length > 0);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  function toggleCard(card: Card): void {
    setError(null);
    setSelected((current) => {
      if (current.includes(card)) {
        return current.filter((candidate) => candidate !== card);
      }
      if (current.length >= userCount) {
        setError(`Your hand is already at ${userCount} cards.`);
        return current;
      }
      return sortCards([...current, card]);
    });
  }

  function submitAlias(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      const card = parseCard(alias);
      toggleCard(card);
      setAlias("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "That card is invalid.",
      );
    }
  }

  function toggleTakeTarget(seat: Seat): void {
    setTakeTargets((current) =>
      current.includes(seat)
        ? current.filter((candidate) => candidate !== seat)
        : [...current, seat],
    );
  }

  function startGame(): void {
    try {
      const opponentCounts =
        userCount === 18
          ? { p2: 17, p3: 17 }
          : eighteenOpponent === "p2"
            ? { p2: 18, p3: 17 }
            : { p2: 17, p3: 18 };
      const rules: RuleConfig = parseRuleConfig({
        ...CANONICAL_RULES,
        direction,
        takeHand: {
          mode: takeMode,
          configuredTargets: takeMode === "configured" ? takeTargets : [],
        },
        zeroCardsWithPower: {
          mode: zeroMode,
          drawFromTarget: drawTargetMode,
          configuredTarget:
            zeroMode === "draw-from-player" && drawTargetMode === "configured"
              ? drawTarget
              : null,
        },
        openingOffSuit: openingMode,
        twoPlayer,
      });
      onCreate({
        type: "game-created",
        schemaVersion: 1,
        rules,
        userHand: selected,
        startingCounts: {
          user: userCount,
          ...opponentCounts,
        },
        aceSpadesHolder: aceHolder,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Setup is invalid.");
    }
  }

  async function importArchive(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) {
      return;
    }
    try {
      onImport(await file.text());
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The selected archive is invalid.",
      );
    }
  }

  return (
    <main className="app-shell setup-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Private by design · saved on this device</p>
          <h1>Set up your hand</h1>
          <p>
            Select exactly 17 or 18 cards. Opponent cards remain unresolved;
            only observations you record become known.
          </p>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => importRef.current?.click()}
          >
            Import an existing game
          </button>
          <input
            className="sr-only"
            ref={importRef}
            type="file"
            accept="application/json,.json"
            onChange={(event) => void importArchive(event)}
            aria-label="Import game archive"
          />
        </div>
        <aside className="setup-counter" aria-live="polite">
          <strong>{selected.length}</strong>
          <span>of {userCount}</span>
          <small>
            {remaining > 0
              ? `${remaining} left`
              : remaining === 0
                ? "Ready"
                : `${Math.abs(remaining)} too many`}
          </small>
        </aside>
      </header>

      <section className="panel setup-controls" aria-labelledby="deal-title">
        <div>
          <h2 id="deal-title">Deal</h2>
          <p className="muted">Choose the physical deal you received.</p>
        </div>
        <label>
          Your starting count
          <select
            value={userCount}
            onChange={(event) => {
              const next = Number(event.target.value) as 17 | 18;
              setUserCount(next);
              setError(null);
            }}
          >
            <option value={18}>18 cards</option>
            <option value={17}>17 cards</option>
          </select>
        </label>
        {userCount === 17 ? (
          <label>
            Opponent with 18
            <select
              value={eighteenOpponent}
              onChange={(event) =>
                setEighteenOpponent(event.target.value as "p2" | "p3")
              }
            >
              <option value="p2">Player 2</option>
              <option value="p3">Player 3</option>
            </select>
          </label>
        ) : null}
        {!selectedSet.has(ACE_OF_SPADES) ? (
          <label>
            A♠ holder
            <select
              value={aceOpponent}
              onChange={(event) =>
                setAceOpponent(event.target.value as "p2" | "p3")
              }
            >
              <option value="p2">Player 2</option>
              <option value="p3">Player 3</option>
            </select>
          </label>
        ) : (
          <p className="known-note">Known: you hold A♠ and open.</p>
        )}
      </section>

      <section className="panel" aria-labelledby="cards-title">
        <div className="section-heading">
          <div>
            <h2 id="cards-title">Your exact cards</h2>
            <p className="muted">
              Tap cards or enter aliases such as qh, 10d, as.
            </p>
          </div>
          <form className="quick-entry" onSubmit={submitAlias}>
            <label className="sr-only" htmlFor="setup-card-entry">
              Add or remove a card
            </label>
            <input
              id="setup-card-entry"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder="Card alias"
              autoComplete="off"
              inputMode="text"
            />
            <button className="button button--secondary" type="submit">
              Toggle
            </button>
          </form>
        </div>
        <CardGrid
          cards={FULL_DECK}
          selected={selected}
          onCard={toggleCard}
          label="Standard 52-card deck"
        />
      </section>

      <details className="panel rules-panel">
        <summary>
          <span>
            Rule profile
            <small>Canonical defaults are already selected</small>
          </span>
        </summary>
        <div className="rules-grid">
          <label>
            Direction
            <select
              value={direction}
              onChange={(event) =>
                setDirection(event.target.value as Direction)
              }
            >
              <option value="clockwise">Clockwise</option>
              <option value="anticlockwise">Anticlockwise</option>
            </select>
          </label>
          <label>
            Take another hand
            <select
              value={takeMode}
              onChange={(event) =>
                setTakeMode(event.target.value as TakeHandMode)
              }
            >
              <option value="disabled">Disabled</option>
              <option value="next-active">Next active</option>
              <option value="adjacent">Adjacent seat</option>
              <option value="configured">Configured targets</option>
            </select>
          </label>
          {takeMode === "configured" ? (
            <fieldset>
              <legend>Allowed take targets</legend>
              {(["user", "p2", "p3"] as const).map((seat) => (
                <label className="check-label" key={seat}>
                  <input
                    type="checkbox"
                    checked={takeTargets.includes(seat)}
                    onChange={() => toggleTakeTarget(seat)}
                  />
                  {seatLabel(seat)}
                </label>
              ))}
            </fieldset>
          ) : null}
          <label>
            Zero cards with power
            <select
              value={zeroMode}
              onChange={(event) =>
                setZeroMode(event.target.value as ZeroCardsWithPowerMode)
              }
            >
              <option value="waste-draw">Draw from prior waste</option>
              <option value="immediate-escape">Escape immediately</option>
              <option value="draw-from-player">Draw from player</option>
            </select>
          </label>
          {zeroMode === "draw-from-player" ? (
            <>
              <label>
                Draw source rule
                <select
                  value={drawTargetMode}
                  onChange={(event) =>
                    setDrawTargetMode(
                      event.target.value as "next-active" | "configured",
                    )
                  }
                >
                  <option value="next-active">Next active</option>
                  <option value="configured">Preferred seat</option>
                </select>
              </label>
              {drawTargetMode === "configured" ? (
                <label>
                  Preferred draw source
                  <select
                    value={drawTarget}
                    onChange={(event) =>
                      setDrawTarget(event.target.value as Seat)
                    }
                  >
                    <option value="user">You</option>
                    <option value="p2">Player 2</option>
                    <option value="p3">Player 3</option>
                  </select>
                </label>
              ) : null}
            </>
          ) : null}
          <label>
            Opening off-suit
            <select
              value={openingMode}
              onChange={(event) =>
                setOpeningMode(event.target.value as OpeningOffSuitMode)
              }
            >
              <option value="any">Any off-suit card</option>
              <option value="highest">Highest-ranked card</option>
            </select>
          </label>
          <label>
            Two-player ending
            <select
              value={twoPlayer}
              onChange={(event) =>
                setTwoPlayer(event.target.value as TwoPlayerMode)
              }
            >
              <option value="pagat-shootout">Pagat shootout</option>
              <option value="normal">Normal tricks</option>
              <option value="simplified-thulla-wins">
                Simplified thulla shortcut
              </option>
            </select>
          </label>
        </div>
      </details>

      <div className="sticky-action">
        <div className="message-slot" aria-live="assertive">
          {error === null ? null : <p className="error-banner">{error}</p>}
        </div>
        <button
          className="button button--primary button--large"
          type="button"
          onClick={startGame}
          disabled={!canStart}
        >
          Start live game
        </button>
      </div>
    </main>
  );
}
