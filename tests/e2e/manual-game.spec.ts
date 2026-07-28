import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { formatCard } from "../../src/domain/cards";
import type { GameEvent } from "../../src/events/game-events";
import { importGameArchive } from "../../src/events/timeline";
import {
  COMPLETE_GAME_EVENTS,
  COMPLETE_GAME_FIXTURE,
  COMPLETE_GAME_SETUP,
} from "../support/complete-game";

async function clearLocalGame(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("getaway-live-solver", 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("current-session")) {
            database.createObjectStore("current-session");
          }
        };
        request.onerror = () =>
          reject(request.error ?? new Error("IndexedDB reset failed."));
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction(
            "current-session",
            "readwrite",
          );
          transaction.objectStore("current-session").delete("current");
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => {
            database.close();
            reject(transaction.error ?? new Error("IndexedDB reset failed."));
          };
        };
      }),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Set up your hand" }),
  ).toBeVisible();
}

async function enterSetup(page: Page): Promise<void> {
  if (COMPLETE_GAME_SETUP.startingCounts.user === 17) {
    await page.getByLabel("Your starting count").selectOption({ value: "17" });
    const eighteenOpponent =
      COMPLETE_GAME_SETUP.startingCounts.p2 === 18 ? "p2" : "p3";
    await page.getByLabel("Opponent with 18").selectOption(eighteenOpponent);
  }

  for (const card of COMPLETE_GAME_SETUP.userHand) {
    await page
      .getByRole("button", { name: formatCard(card), exact: true })
      .click();
  }

  if (COMPLETE_GAME_SETUP.aceSpadesHolder !== "user") {
    await page
      .getByLabel("A♠ holder")
      .selectOption(COMPLETE_GAME_SETUP.aceSpadesHolder);
  }
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start live game" }).click();
  await expect(
    page.getByRole("heading", { name: "Getaway live tracker" }),
  ).toBeVisible();
}

function cardCode(event: Exclude<GameEvent, { type: "game-created" }>): string {
  switch (event.type) {
    case "card-played":
    case "waste-card-drawn":
    case "player-card-drawn":
      return event.card.toLowerCase();
    case "hand-taken":
      throw new Error("Canonical complete-game fixture cannot take a hand.");
  }
}

async function enterFixtureEvent(
  page: Page,
  event: Exclude<GameEvent, { type: "game-created" }>,
  expectedActiveEvents: number,
): Promise<void> {
  const entry = page.getByRole("textbox", { name: "Keyboard entry" });
  await entry.fill(cardCode(event));
  await entry.press("Enter");
  await expect(page.locator(".event-list > li")).toHaveCount(
    expectedActiveEvents,
  );
  await expect(page.locator(".error-banner")).toHaveCount(0);
}

async function waitForSavedCursor(
  page: Page,
  expectedCursor: number,
): Promise<void> {
  await page.waitForFunction(
    async (cursor) =>
      await new Promise<boolean>((resolve) => {
        const request = indexedDB.open("getaway-live-solver", 1);
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction(
            "current-session",
            "readonly",
          );
          const get = transaction.objectStore("current-session").get("current");
          get.onerror = () => {
            database.close();
            resolve(false);
          };
          get.onsuccess = () => {
            database.close();
            const value = get.result as { archive?: string } | undefined;
            if (typeof value?.archive !== "string") {
              resolve(false);
              return;
            }
            try {
              const parsed = JSON.parse(value.archive) as {
                timeline?: { cursor?: number };
              };
              resolve(parsed.timeline?.cursor === cursor);
            } catch {
              resolve(false);
            }
          };
        };
      }),
    expectedCursor,
  );
}

async function waitForSavedEventCard(
  page: Page,
  eventIndex: number,
  card: string,
): Promise<void> {
  await page.waitForFunction(
    async ([index, expectedCard]) =>
      await new Promise<boolean>((resolve) => {
        const request = indexedDB.open("getaway-live-solver", 1);
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction(
            "current-session",
            "readonly",
          );
          const get = transaction.objectStore("current-session").get("current");
          get.onerror = () => {
            database.close();
            resolve(false);
          };
          get.onsuccess = () => {
            database.close();
            const value = get.result as { archive?: string } | undefined;
            if (typeof value?.archive !== "string") {
              resolve(false);
              return;
            }
            try {
              const parsed = JSON.parse(value.archive) as {
                timeline?: { events?: { card?: string }[] };
              };
              resolve(parsed.timeline?.events?.[index]?.card === expectedCard);
            } catch {
              resolve(false);
            }
          };
        };
      }),
    [eventIndex, card] as const,
  );
}

test("enters, corrects, saves, restores, exports, imports, and completes a full game", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  test.setTimeout(180_000);

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await clearLocalGame(page);
  await enterSetup(page);

  const activeEvents = COMPLETE_GAME_EVENTS.slice(1);
  const checkpoint = 8;
  for (let offset = 0; offset < checkpoint; offset += 1) {
    const event = activeEvents[offset];
    if (event === undefined || event.type === "game-created") {
      throw new Error(`Complete-game event ${offset + 1} is invalid.`);
    }
    await enterFixtureEvent(page, event, offset + 2);
  }

  await waitForSavedCursor(page, checkpoint + 1);
  await page.reload();
  await expect(page.locator(".event-list > li")).toHaveCount(checkpoint + 1);
  await expect(page.getByText("Saved on this device")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Redo" })).toBeEnabled();
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.locator(".event-list > li")).toHaveCount(checkpoint + 1);

  for (let offset = checkpoint; offset < activeEvents.length; offset += 1) {
    const event = activeEvents[offset];
    if (event === undefined || event.type === "game-created") {
      throw new Error(`Complete-game event ${offset + 1} is invalid.`);
    }
    await enterFixtureEvent(page, event, offset + 2);
  }

  const terminalCopy =
    COMPLETE_GAME_FIXTURE.finalState.bhabhi === "user"
      ? "You are Bhabhi"
      : `Player ${COMPLETE_GAME_FIXTURE.finalState.bhabhi === "p2" ? "2" : "3"} is Bhabhi`;
  await expect(page.getByRole("heading", { name: terminalCopy })).toBeVisible();
  await waitForSavedCursor(page, COMPLETE_GAME_EVENTS.length);

  const terminalCorrectionIndex = 60;
  await page
    .locator(".event-list > li")
    .nth(terminalCorrectionIndex)
    .getByRole("button", { name: "Correct" })
    .click();
  await page.getByText("Advanced developer JSON", { exact: true }).click();
  await page.getByRole("textbox", { name: "Event JSON" }).fill(
    JSON.stringify(
      {
        type: "card-played",
        schemaVersion: 1,
        seat: "p2",
        card: "5H",
      },
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Apply and replay" }).click();
  await expect(
    page.getByText("Correction replayed through the complete history."),
  ).toBeVisible();
  await expect(
    page.locator(".event-list > li").nth(terminalCorrectionIndex),
  ).toContainText("Player 2 played 5H");
  await expect(page.getByRole("heading", { name: terminalCopy })).toBeVisible();
  await waitForSavedEventCard(page, terminalCorrectionIndex, "5H");
  await page.reload();
  await expect(page.getByRole("heading", { name: terminalCopy })).toBeVisible();
  await expect(
    page.locator(".event-list > li").nth(terminalCorrectionIndex),
  ).toContainText("Player 2 played 5H");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^getaway-game-.+\.json$/);
  const downloadPath = await download.path();
  const archiveText = await readFile(downloadPath, "utf8");
  const exported = importGameArchive(archiveText);
  expect(exported.cursor).toBe(COMPLETE_GAME_EVENTS.length);
  expect(exported.events[terminalCorrectionIndex]).toMatchObject({
    type: "card-played",
    seat: "p2",
    card: "5H",
  });

  await page.getByRole("button", { name: "New game" }).click();
  const resetDialog = page.getByRole("alertdialog", { name: "Start over?" });
  await expect(resetDialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep game" })).toBeFocused();
  await page.getByRole("button", { name: "Clear and start new" }).click();
  await expect(
    page.getByRole("heading", { name: "Set up your hand" }),
  ).toBeVisible();
  await page.getByLabel("Import game archive").setInputFiles({
    name: "complete-getaway-game.json",
    mimeType: "application/json",
    buffer: Buffer.from(archiveText),
  });
  await expect(page.getByRole("heading", { name: terminalCopy })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("mobile setup and live tracking stay usable without horizontal overflow", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await clearLocalGame(page);
  const entry = page.getByRole("textbox", {
    name: "Add or remove a card",
  });
  await entry.fill("as");
  await entry.press("Enter");
  await expect(
    page.getByRole("button", { name: "A♠", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await entry.fill("as");
  await entry.press("Enter");
  await expect(
    page.getByRole("button", { name: "A♠", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");

  await enterSetup(page);
  await expect(
    page.getByRole("list", { name: "You known cards" }),
  ).toBeVisible();
  const activeEvents = COMPLETE_GAME_EVENTS.slice(1, 4);
  for (let offset = 0; offset < activeEvents.length; offset += 1) {
    const event = activeEvents[offset];
    if (event === undefined || event.type === "game-created") {
      throw new Error(`Complete-game mobile event ${offset + 1} is invalid.`);
    }
    await enterFixtureEvent(page, event, offset + 2);
  }
  await page.getByRole("button", { name: "Correct" }).last().click();
  await expect(
    page.getByRole("heading", { name: "Correct event 3" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "New game" }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Start over?" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Getaway live tracker" }),
  ).toBeVisible();
  const dimensions = await page.locator("body").evaluate((body) => ({
    clientWidth: body.clientWidth,
    scrollWidth: body.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  expect(consoleErrors).toEqual([]);
});
