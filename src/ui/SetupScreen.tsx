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

const COUNTERCLOCKWISE_RULES = {
  ...CANONICAL_RULES,
  direction: "anticlockwise",
} as const;

const SETUP_SEATS = ["user", "p2", "p3"] as const;

function countsForExtraCard(extraCardHolder: Seat): StartingCounts {
  return {
    user: extraCardHolder === "user" ? 18 : 17,
    p2: extraCardHolder === "p2" ? 18 : 17,
    p3: extraCardHolder === "p3" ? 18 : 17,
  };
}

export function SetupScreen({ onCreate, onImport }: SetupScreenProps) {
  const [extraCardHolder, setExtraCardHolder] = useState<Seat>("user");
  const [aceHolder, setAceHolder] = useState<Seat>("p2");
  const [selected, setSelected] = useState<Card[]>([]);
  const [alias, setAlias] = useState("");
  const [error, setError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const counts = countsForExtraCard(extraCardHolder);
  const userCount = counts.user;
  const remaining = userCount - selected.length;

  function chooseExtraCardHolder(seat: Seat): void {
    const nextUserCount = seat === "user" ? 18 : 17;
    setExtraCardHolder(seat);
    setSelected((current) => current.slice(0, nextUserCount));
    setError(null);
  }

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
      rules: COUNTERCLOCKWISE_RULES,
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
          <p className="eyebrow">3 players · counterclockwise ↺ · local only</p>
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

        <div className="deal-questions">
          <fieldset className="seat-choice">
            <legend>Who received the 18th / extra card?</legend>
            <div className="seat-choice__options">
              {SETUP_SEATS.map((seat) => (
                <label
                  className={`seat-choice__option ${
                    extraCardHolder === seat
                      ? "seat-choice__option--active"
                      : ""
                  }`}
                  key={seat}
                >
                  <input
                    type="radio"
                    name="extra-card-holder"
                    value={seat}
                    checked={extraCardHolder === seat}
                    onChange={() => chooseExtraCardHolder(seat)}
                  />
                  <strong>{seatLabel(seat)}</strong>
                  <small>{counts[seat]} cards</small>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="seat-choice">
            <legend>
              Who plays Hukam? <span>(A♠ opener)</span>
            </legend>
            <div className="seat-choice__options">
              {SETUP_SEATS.map((seat) => (
                <label
                  className={`seat-choice__option ${
                    aceHolder === seat ? "seat-choice__option--active" : ""
                  }`}
                  key={seat}
                >
                  <input
                    type="radio"
                    name="hukam-player"
                    value={seat}
                    checked={aceHolder === seat}
                    onChange={() => {
                      setAceHolder(seat);
                      setError(null);
                    }}
                  />
                  <strong>{seatLabel(seat)}</strong>
                  <small>{seat === aceHolder ? "Hukam" : "A♠"}</small>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="auto-counts" aria-label="Automatic starting counts">
          <span>You {counts.user}</span>
          <span>P2 {counts.p2}</span>
          <span>P3 {counts.p3}</span>
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
            ? `${seatLabel(aceHolder)} plays Hukam · A♠ opener`
            : `${remaining.toString()} card(s) left`}
        </span>
        <button
          className="button button--primary"
          type="button"
          onClick={startGame}
          disabled={remaining !== 0}
        >
          Deal & start
        </button>
      </div>
    </main>
  );
}
