import { expect, test } from "@playwright/test";

import {
  exportGameArchive,
  type GameTimeline,
} from "../../src/events/timeline";
import { COMPLETE_GAME_EVENTS } from "../support/complete-game";

const selectedRelease =
  process.env.BHABHI_RELEASE_EXPECT_MODE === "release-selected" &&
  typeof process.env.BHABHI_RELEASE_BUNDLE_PATH === "string";

function userDecisionArchive(): string {
  const events = COMPLETE_GAME_EVENTS.slice(0, 53);
  const timeline: GameTimeline = {
    schemaVersion: 1,
    events,
    cursor: events.length,
    orphanedEvents: [],
  };
  return exportGameArchive(timeline);
}

test("selected release publishes current analysis and remains accessible after invalidation", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  test.skip(!selectedRelease, "Requires a release-selected production build.");
  test.setTimeout(120_000);

  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await page.getByLabel("Import game archive").setInputFiles({
    name: "selected-release-user-turn.json",
    mimeType: "application/json",
    buffer: Buffer.from(userDecisionArchive()),
  });
  await expect(
    page.getByRole("heading", { name: "Getaway live tracker" }),
  ).toBeVisible();
  await page.getByLabel("Analysis budget").selectOption("instant");

  const recommendation = page.locator(".recommendation-panel");
  await expect(recommendation).toBeVisible({ timeout: 60_000 });
  await expect(
    recommendation.getByText("Known legal", { exact: true }),
  ).toBeVisible();
  await expect(
    recommendation.getByText("Approximate", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Ranked legal alternatives")).not.toBeEmpty();

  const diagnostics = page.getByText("Public diagnostics", { exact: true });
  await diagnostics.click();
  await expect(
    page.getByRole("heading", { name: "Release identity" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Public-only: this view and its export omit hidden worlds/),
  ).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(recommendation).toHaveCount(0);
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(recommendation).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByText("Recommendation is current for this public history."),
  ).toBeVisible();

  const controls = page.locator("button, input, select, textarea");
  for (let index = 0; index < (await controls.count()); index += 1) {
    await expect(controls.nth(index)).toHaveAccessibleName(/\S/u);
  }
  expect(browserErrors).toEqual([]);
});
