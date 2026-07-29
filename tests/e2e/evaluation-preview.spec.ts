import { expect, test } from "@playwright/test";

import {
  exportGameArchive,
  type GameTimeline,
} from "../../src/events/timeline";
import { COMPLETE_GAME_EVENTS } from "../support/complete-game";

const evaluationPreview =
  process.env.BHABHI_RELEASE_EXPECT_MODE === "evaluation-only" &&
  process.env.VITE_BHABHI_EVALUATION_PREVIEW === "true";

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

test("evaluation preview publishes an explicitly unvalidated recommendation", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  test.skip(!evaluationPreview, "Requires the evaluation play-preview build.");
  test.setTimeout(120_000);

  await page.goto("/");
  await page.getByLabel("Import game archive").setInputFiles({
    name: "evaluation-preview-user-turn.json",
    mimeType: "application/json",
    buffer: Buffer.from(userDecisionArchive()),
  });
  await expect(page.getByText(/Unvalidated evaluation preview/u)).toBeVisible();
  await page.getByLabel("Analysis budget").selectOption("instant");
  await expect(page.locator(".recommendation-panel")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByLabel("Ranked legal alternatives")).not.toBeEmpty();
});
