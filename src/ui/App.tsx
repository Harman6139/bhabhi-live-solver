import { useEffect, useRef, useState } from "react";

import type { GameCreatedEvent } from "../events/game-events";
import {
  createTimeline,
  importGameArchive,
  type GameTimeline,
} from "../events/timeline";
import {
  clearSavedGame,
  isCorruptGameStoreError,
  loadGameTimeline,
  saveGameTimeline,
} from "../persistence/game-store";
import { PlayScreen } from "./PlayScreen";
import { SetupScreen } from "./SetupScreen";

export type SaveState = "idle" | "saving" | "saved" | "error";

type BootProblem = Readonly<{
  message: string;
  corrupt: boolean;
}>;

export function App() {
  const [timeline, setTimeline] = useState<GameTimeline | null>(null);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [booting, setBooting] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [bootProblem, setBootProblem] = useState<BootProblem | null>(null);
  const loaded = useRef(false);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const sessionEpochRef = useRef(0);
  const resetting = useRef(false);

  function replaceSession(nextTimeline: GameTimeline | null): void {
    sessionEpochRef.current += 1;
    setSessionEpoch(sessionEpochRef.current);
    setTimeline(nextTimeline);
  }

  useEffect(() => {
    let cancelled = false;
    void loadGameTimeline()
      .then((saved) => {
        if (!cancelled) {
          if (saved !== null) {
            replaceSession(saved);
          }
          setSaveState(saved === null ? "idle" : "saved");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBootProblem({
            message:
              error instanceof Error
                ? `Local restore unavailable: ${error.message}`
                : "Local restore is unavailable.",
            corrupt: isCorruptGameStoreError(error),
          });
          setSaveState("error");
        }
      })
      .finally(() => {
        if (!cancelled) {
          loaded.current = true;
          setBooting(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded.current || timeline === null) {
      return;
    }
    let cancelled = false;
    const epoch = sessionEpoch;
    setSaveState("saving");
    const pendingSave = saveChain.current.then(async () => {
      if (sessionEpochRef.current === epoch) {
        await saveGameTimeline(timeline);
      }
    });
    saveChain.current = pendingSave.catch(() => undefined);
    void pendingSave
      .then(() => {
        if (!cancelled && sessionEpochRef.current === epoch) {
          setSaveState("saved");
        }
      })
      .catch(() => {
        if (!cancelled && sessionEpochRef.current === epoch) {
          setSaveState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionEpoch, timeline]);

  function createGame(event: GameCreatedEvent): void {
    replaceSession(createTimeline(event));
    setBootProblem(null);
    window.scrollTo(0, 0);
  }

  function importGame(serialized: string): void {
    replaceSession(importGameArchive(serialized));
    setBootProblem(null);
    window.scrollTo(0, 0);
  }

  function importActiveGame(nextTimeline: GameTimeline): void {
    replaceSession(nextTimeline);
    setBootProblem(null);
    window.scrollTo(0, 0);
  }

  function updateTimeline(
    nextTimeline: GameTimeline,
    expectedEpoch: number,
  ): void {
    if (!resetting.current && sessionEpochRef.current === expectedEpoch) {
      setTimeline(nextTimeline);
    }
  }

  async function retrySave(): Promise<void> {
    if (timeline === null) {
      return;
    }
    const epoch = sessionEpochRef.current;
    const snapshot = timeline;
    setSaveState("saving");
    const pendingSave = saveChain.current.then(async () => {
      if (sessionEpochRef.current === epoch) {
        await saveGameTimeline(snapshot);
      }
    });
    saveChain.current = pendingSave.catch(() => undefined);
    try {
      await pendingSave;
      if (sessionEpochRef.current === epoch) {
        setSaveState("saved");
      }
    } catch {
      if (sessionEpochRef.current === epoch) {
        setSaveState("error");
      }
    }
  }

  async function discardCorruptSave(): Promise<void> {
    try {
      await clearSavedGame();
      setBootProblem(null);
      setSaveState("idle");
    } catch (error) {
      setBootProblem({
        message:
          error instanceof Error
            ? `Could not discard the corrupt save: ${error.message}`
            : "Could not discard the corrupt save.",
        corrupt: true,
      });
    }
  }

  async function newGame(): Promise<void> {
    if (resetting.current) {
      return;
    }
    resetting.current = true;
    replaceSession(null);
    try {
      await saveChain.current;
      await clearSavedGame();
    } catch {
      // The fresh in-memory session remains usable if persistence is blocked.
    }
    setSaveState("idle");
    setBootProblem(null);
    resetting.current = false;
    window.scrollTo(0, 0);
  }

  if (booting) {
    return (
      <main className="app-shell loading-shell" aria-busy="true">
        <div className="loading-mark" aria-hidden="true">
          G
        </div>
        <p>Restoring the local table…</p>
      </main>
    );
  }

  const activeSessionEpoch = sessionEpoch;
  return (
    <>
      {bootProblem === null ? null : (
        <aside className="boot-warning" role="status">
          <p>
            {bootProblem.message} The manual tracker still works in this tab,
            and you can import a known-good archive.
          </p>
          {bootProblem.corrupt ? (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void discardCorruptSave()}
            >
              Discard corrupt save
            </button>
          ) : null}
        </aside>
      )}
      {timeline === null ? (
        <SetupScreen onCreate={createGame} onImport={importGame} />
      ) : (
        <PlayScreen
          timeline={timeline}
          sessionEpoch={activeSessionEpoch}
          saveState={saveState}
          onTimeline={(nextTimeline) =>
            updateTimeline(nextTimeline, activeSessionEpoch)
          }
          onReplaceTimeline={importActiveGame}
          onRetrySave={retrySave}
          onNewGame={newGame}
        />
      )}
    </>
  );
}
