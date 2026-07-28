import { useEffect, useRef, useState } from "react";

import type { GameCreatedEvent } from "../events/game-events";
import {
  createTimeline,
  importGameArchive,
  type GameTimeline,
} from "../events/timeline";
import {
  clearSavedGame,
  loadGameTimeline,
  saveGameTimeline,
} from "../persistence/game-store";
import { SetupScreen } from "./SetupScreen";
import { TrackerScreen } from "./TrackerScreen";

type SaveState = "idle" | "saving" | "saved" | "error";

export function App() {
  const [timeline, setTimeline] = useState<GameTimeline | null>(null);
  const [booting, setBooting] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [bootError, setBootError] = useState<string | null>(null);
  const loaded = useRef(false);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const sessionEpoch = useRef(0);
  const resetting = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadGameTimeline()
      .then((saved) => {
        if (!cancelled) {
          setTimeline(saved);
          setSaveState(saved === null ? "idle" : "saved");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBootError(
            error instanceof Error
              ? `Local restore unavailable: ${error.message}`
              : "Local restore is unavailable.",
          );
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
    const epoch = sessionEpoch.current;
    setSaveState("saving");
    const pendingSave = saveChain.current.then(async () => {
      if (sessionEpoch.current === epoch) {
        await saveGameTimeline(timeline);
      }
    });
    saveChain.current = pendingSave.catch(() => undefined);
    void pendingSave
      .then(() => {
        if (!cancelled && sessionEpoch.current === epoch) {
          setSaveState("saved");
        }
      })
      .catch(() => {
        if (!cancelled && sessionEpoch.current === epoch) {
          setSaveState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [timeline]);

  function createGame(event: GameCreatedEvent): void {
    setTimeline(createTimeline(event));
    setBootError(null);
    window.scrollTo(0, 0);
  }

  function importGame(serialized: string): void {
    setTimeline(importGameArchive(serialized));
    setBootError(null);
    window.scrollTo(0, 0);
  }

  function updateTimeline(
    nextTimeline: GameTimeline,
    expectedEpoch: number,
  ): void {
    if (!resetting.current && sessionEpoch.current === expectedEpoch) {
      setTimeline(nextTimeline);
    }
  }

  async function newGame(): Promise<void> {
    if (resetting.current) {
      return;
    }
    resetting.current = true;
    sessionEpoch.current += 1;
    try {
      await saveChain.current;
      await clearSavedGame();
    } catch {
      // A new in-memory session must remain available if persistence is blocked.
    }
    setTimeline(null);
    setSaveState("idle");
    setBootError(null);
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

  const activeSessionEpoch = sessionEpoch.current;
  return (
    <>
      {bootError === null ? null : (
        <p className="boot-warning" role="status">
          {bootError} The tracker still works in this tab.
        </p>
      )}
      {timeline === null ? (
        <SetupScreen onCreate={createGame} onImport={importGame} />
      ) : (
        <TrackerScreen
          timeline={timeline}
          saveState={saveState}
          onTimeline={(nextTimeline) =>
            updateTimeline(nextTimeline, activeSessionEpoch)
          }
          onNewGame={newGame}
        />
      )}
    </>
  );
}
