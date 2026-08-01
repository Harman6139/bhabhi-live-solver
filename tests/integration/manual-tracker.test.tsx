// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { FULL_DECK } from "../../src/domain/cards";
import type { GameCreatedEvent } from "../../src/events/game-events";
import {
  createTimeline,
  replayTimeline,
  type GameTimeline,
} from "../../src/events/timeline";
import { PlayScreen } from "../../src/ui/PlayScreen";
import { SetupScreen } from "../../src/ui/SetupScreen";
import { TrackerScreen } from "../../src/ui/TrackerScreen";
import {
  COMPLETE_GAME_EVENTS,
  COMPLETE_GAME_SETUP,
} from "../support/complete-game";
import {
  createdEventWithUserHand,
  userHandIncluding,
} from "../support/state-builders";

afterEach(cleanup);
beforeAll(() => {
  window.scrollTo = vi.fn();
});

function trackerCreation(): GameCreatedEvent {
  return createdEventWithUserHand(
    userHandIncluding(["AS", "2C", "2D"], 18),
    "user",
  );
}

function TrackerHarness({
  initial = createTimeline(trackerCreation()),
}: {
  readonly initial?: GameTimeline;
}) {
  const [timeline, setTimeline] = useState(initial);
  return (
    <TrackerScreen
      timeline={timeline}
      sessionEpoch={0}
      saveState="saved"
      onTimeline={setTimeline}
      onReplaceTimeline={setTimeline}
      onRetrySave={() => Promise.resolve()}
      onNewGame={() => Promise.resolve()}
    />
  );
}

function PlayHarness() {
  const [timeline, setTimeline] = useState(() =>
    createTimeline({
      type: "game-created",
      schemaVersion: 1,
      rules: {
        ...COMPLETE_GAME_SETUP.rules,
        direction: "anticlockwise",
      },
      userHand: FULL_DECK.filter((card) => card !== "AS").slice(0, 17),
      startingCounts: { user: 17, p2: 18, p3: 17 },
      aceSpadesHolder: "p2",
    }),
  );
  return (
    <PlayScreen
      timeline={timeline}
      sessionEpoch={0}
      saveState="saved"
      onTimeline={setTimeline}
      onReplaceTimeline={setTimeline}
      onRetrySave={() => Promise.resolve()}
      onNewGame={() => Promise.resolve()}
    />
  );
}

describe("manual tracker interface", () => {
  it("derives a counterclockwise 17/17/18 setup from the extra-card seat", async () => {
    const user = userEvent.setup();
    const createdEvents: GameCreatedEvent[] = [];
    render(
      <SetupScreen
        onCreate={(event) => {
          createdEvents.push(event);
        }}
        onImport={() => undefined}
      />,
    );

    const extraCardGroup = screen.getByRole("group", {
      name: "Who received the 18th / extra card?",
    });
    await user.click(
      within(extraCardGroup).getByRole("radio", { name: /Player 3/ }),
    );

    const selected = FULL_DECK.filter((card) => card !== "AS").slice(0, 17);
    for (const card of selected) {
      const button = screen.getByRole("button", {
        name: card
          .replace("T", "10")
          .replace("C", "♣")
          .replace("D", "♦")
          .replace("H", "♥")
          .replace("S", "♠"),
      });
      expect(button.querySelector(".playing-card")).not.toBeNull();
      await user.click(button);
    }

    expect(
      screen.getByLabelText("Automatic starting counts"),
    ).toHaveTextContent("You 17");
    expect(
      screen.getByLabelText("Automatic starting counts"),
    ).toHaveTextContent("P3 18");
    await user.click(screen.getByRole("button", { name: "Deal & start" }));
    const created = createdEvents[0];
    expect(created).toBeDefined();
    expect(created?.aceSpadesHolder).toBe("p2");
    expect(created?.userHand).toHaveLength(17);
    expect(created?.startingCounts).toEqual({ user: 17, p2: 17, p3: 18 });
    expect(created?.rules).toMatchObject({
      direction: "anticlockwise",
      openingOffSuit: "any",
      twoPlayer: "pagat-shootout",
    });
  });

  it("lays seats around a counterclockwise table and rings the current turn", () => {
    render(<PlayHarness />);

    const table = screen.getByRole("region", {
      name: "Counterclockwise game table. Current turn: Player 2.",
    });
    expect(within(table).getByText("Counterclockwise")).toBeInTheDocument();
    expect(within(table).getByText("Turn").closest(".table-seat")).toHaveClass(
      "table-seat--p2",
      "table-seat--current",
    );
  });

  it("records keyboard and tap plays, then supports undo, redo, and correction", async () => {
    const user = userEvent.setup();
    render(<TrackerHarness />);

    const exactHand = screen.getByRole("list", {
      name: "You known cards",
    });
    expect(within(exactHand).getAllByRole("listitem")).toHaveLength(18);
    expect(within(exactHand).getByText("A♠")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "A♠" }));
    expect(within(exactHand).getAllByRole("listitem")).toHaveLength(17);
    expect(within(exactHand).queryByText("A♠")).not.toBeInTheDocument();
    const entry = screen.getByRole("textbox", { name: "Keyboard entry" });
    await user.type(entry, "ks{Enter}");
    await user.type(entry, "qs{Enter}");

    expect(
      screen.getByRole("heading", { name: "You leads" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Waste: 3/)).toBeInTheDocument();
    expect(screen.getByText("Player 2 played KS")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      screen.getByRole("heading", { name: "Player 3 plays" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(
      screen.getByRole("heading", { name: "You leads" }),
    ).toBeInTheDocument();

    const history = screen
      .getByRole("heading", {
        name: "History",
      })
      .closest("section");
    if (history === null) {
      throw new Error("History section was not rendered.");
    }
    const correctButtons = within(history).getAllByRole("button", {
      name: "Correct",
    });
    const playerTwoCorrection = correctButtons[2];
    if (playerTwoCorrection === undefined) {
      throw new Error("Player 2 correction control was not rendered.");
    }
    await user.click(playerTwoCorrection);
    const editor = screen.getByRole("textbox", { name: "Event JSON" });
    const correctedJson = (editor as HTMLTextAreaElement).value.replace(
      '"KS"',
      '"JS"',
    );
    fireEvent.change(editor, { target: { value: correctedJson } });
    await user.click(screen.getByRole("button", { name: "Apply and replay" }));

    expect(screen.getByText("Player 2 played JS")).toBeInTheDocument();
    expect(
      screen.getByText("Correction replayed through the complete history."),
    ).toBeInTheDocument();
  });

  it("keeps setup history correctable from the first event", () => {
    const timeline = createTimeline(trackerCreation());
    expect(replayTimeline(timeline).state.status).toBe("active");
    render(<TrackerHarness initial={timeline} />);
    expect(screen.getAllByRole("button", { name: "Correct" })[0]).toBeEnabled();
  });

  it("shows exact opponent pickup cards until they are played", () => {
    const pickupTimeline: GameTimeline = {
      schemaVersion: 1,
      events: COMPLETE_GAME_EVENTS.slice(0, 36),
      cursor: 36,
      orphanedEvents: [],
    };
    expect(replayTimeline(pickupTimeline).state.knownOpponentCards.p2).toEqual([
      "4D",
      "5H",
    ]);

    render(<TrackerHarness initial={pickupTimeline} />);
    const playerTwoCards = screen.getByRole("list", {
      name: "Player 2 known cards",
    });
    expect(within(playerTwoCards).getByText("4♦")).toBeInTheDocument();
    expect(within(playerTwoCards).getByText("5♥")).toBeInTheDocument();
  });

  it("makes reset modal, focus-safe, and non-interactive behind the dialog", async () => {
    const user = userEvent.setup();
    const pendingReset = new Promise<void>(() => undefined);
    const initial = createTimeline(COMPLETE_GAME_SETUP);
    const Harness = () => {
      const [timeline, setTimeline] = useState(initial);
      return (
        <TrackerScreen
          timeline={timeline}
          sessionEpoch={0}
          saveState="saved"
          onTimeline={setTimeline}
          onReplaceTimeline={setTimeline}
          onRetrySave={() => Promise.resolve()}
          onNewGame={() => pendingReset}
        />
      );
    };
    render(<Harness />);

    const newGame = screen.getByRole("button", { name: "New game" });
    await user.click(newGame);
    const dialog = screen.getByRole("alertdialog", { name: "Start over?" });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Keyboard entry" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Keep game" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: "New game" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "New game" }));
    await user.click(
      screen.getByRole("button", { name: "Clear and start new" }),
    );
    expect(
      screen.getByRole("button", { name: "Clearing local game…" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep game" })).toBeDisabled();
  });
});
