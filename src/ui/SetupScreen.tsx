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
import { CANONICAL_RULES } from "../domain/rule-config";
import type { Seat } from "../domain/seats";
import type { GameCreatedEvent, StartingCounts } from "../events/game-events";
import { CardGrid } from "./CardGrid";
import { seatLabel } from "./session-utils";

type SetupScreenProps = {
  readonly onCreate: (event: GameCreatedEvent) => void;
  readonly onImport: (serialized: string) => void;
};

function automaticCounts(userCount: 17 | 18, aceHolder: Seat): StartingCounts {
  if (userCount === 18) {
    return { user: 18, p2: 17, p3: 17 };
  }

  // One opponent has the extra card. Keep setup choice-free by assigning it
  // to the declared opener when that opener is an opponent; otherwise use the
  // next clockwise seat.
  return aceHolder === "p3"
    ? { user: 17, p2: 17, p3: 18 }
    : { user: 17, p2: 18, p3: 17 };
}

export function SetupScreen({ onCreate, onImport }: SetupScreenProps) {
  const [userCount, setUserCount] = useState<17 | 18>(18);
  const [aceHolder, setAceHolder] = useState<Seat>("p2");
  const [selected, setSelected] = useState<Card[]>([]);
  const [alias, setAlias] = useState("");
  const [error, setError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const remaining = userCount - selected.length;
  const counts = automaticCounts(userCount, aceHolder);

  function toggleCard(card: Card): void {
    setError(null);
    setSelected((current) => {
      if (current.includes(card)) {
        return current.filter((candidate) => candidate !== card);
      }
      if (current.length >= userCount) {
        setError(`Your hand already has ${userCount.toString()} cards.`);
        return current;
      }
      return sortCards([...current, card]);
    });
  }

  function submitAlias(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      toggleCard(parseCard(alias));
      setAlias("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "That card is invalid.",
      );
    }
  }

  function startGame(): void {
    if (remaining !== 0) {
      setError(`Select ${remaining.toString()} more card(s).`);
      return;
    }
    const userHasAce = selectedSet.has(ACE_OF_SPADES);
    if ((aceHolder === "user") !== userHasAce) {
      setError(
        aceHolder === "user"
          ? "You selected yourself as opener, so A♠ must be in your hand."
          : `A♠ is in your hand; set the opener to ${seatLabel("user")}.`,
      );
      return;
    }
    onCreate({
      type: "game-created",
      schemaVersion: 1,
      rules: CANONICAL_RULES,
      userHand: selected,
      startingCounts: counts,
      aceSpadesHolder: aceHolder,
    });
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
        caught instanceof Error ? caught.message : "That archive is invalid.",
      );
    }
  }

  return (
    <main className="app-shell setup-shell compact-setup">
      <header className="compact-hero">
        <div>
          <p className="eyebrow">3-player · clockwise · local only</p>
          <h1>Bhabhi live solver</h1>
        </div>
        <button
          className="text-button"
          type="button"
          onClick={() => importRef.current?.click()}
        >
          Restore game
        </button>
        <input
          ref={importRef}
          className="visually-hidden"
          type="file"
          accept="application/json,.json"
          onChange={(event) => void importArchive(event)}
        />
      </header>

      <section className="panel quick-setup" aria-labelledby="deal-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">One-time setup</p>
            <h2 id="deal-title">Your hand</h2>
          </div>
          <strong className="hand-progress">
            {selected.length.toString()}/{userCount.toString()}
          </strong>
        </div>

        <div className="quick-setup__controls">
          <label>
            Your card count
            <select
              value={userCount}
              onChange={(event) => {
                const next = Number(event.target.value) as 17 | 18;
                setUserCount(next);
                setSelected((current) => current.slice(0, next));
                setError(null);
              }}
            >
              <option value={18}>18</option>
              <option value={17}>17</option>
            </select>
          </label>
          <label>
            Who has A♠ and opens?
            <select
              value={aceHolder}
              onChange={(event) => {
                setAceHolder(event.target.value as Seat);
                setError(null);
              }}
            >
              <option value="user">You</option>
              <option value="p2">Player 2</option>
              <option value="p3">Player 3</option>
            </select>
          </label>
          <div className="auto-counts" aria-label="Automatic starting counts">
            <span>You {counts.user}</span>
            <span>P2 {counts.p2}</span>
            <span>P3 {counts.p3}</span>
          </div>
        </div>

        <form className="quick-entry" onSubmit={submitAlias}>
          <label htmlFor="setup-card-entry">Quick card entry</label>
          <div>
            <input
              id="setup-card-entry"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder="qh, 10d, as"
              autoComplete="off"
            />
            <button className="button button--secondary" type="submit">
              Add
            </button>
          </div>
        </form>
      </section>

      {error === null ? null : (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <section className="panel compact-hand-picker">
        <CardGrid
          cards={FULL_DECK}
          selected={selected}
          label="Select your exact starting hand"
          onCard={toggleCard}
          compact
        />
      </section>

      <div className="sticky-action compact-start">
        <span>
          {remaining === 0
            ? `${seatLabel(aceHolder)} opens with A♠`
            : `${remaining.toString()} card(s) left`}
        </span>
        <button
          className="button button--primary"
          type="button"
          onClick={startGame}
          disabled={remaining !== 0}
        >
          Start game
        </button>
      </div>
    </main>
  );
}
