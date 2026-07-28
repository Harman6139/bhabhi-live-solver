import { describe, expect, it } from "vitest";

import {
  PHASE6_OPPONENT_DECISION_ORDINALS,
  PHASE6_PUBLIC_EVENT_ORDINALS,
  selectPhase6CalibrationCheckpoints,
  type CalibrationCheckpoint,
} from "../../src/calibration/checkpoints";
import { replayEvents } from "../../src/events/timeline";
import {
  COMPLETE_GAME_EVENTS,
  COMPLETE_GAME_SETUP,
  generateCompleteGameFixture,
} from "../support/complete-game";

function checkpointAt(
  checkpoints: readonly CalibrationCheckpoint[],
  eventIndex: number,
): CalibrationCheckpoint {
  const checkpoint = checkpoints.find(
    (candidate) => candidate.eventIndex === eventIndex,
  );
  if (checkpoint === undefined) {
    throw new Error(`Missing checkpoint at event index ${eventIndex}.`);
  }
  return checkpoint;
}

describe("Phase 6 deterministic calibration checkpoints", () => {
  it("selects the complete frozen schedule with deterministic cardinality", () => {
    const checkpoints =
      selectPhase6CalibrationCheckpoints(COMPLETE_GAME_EVENTS);

    expect(PHASE6_PUBLIC_EVENT_ORDINALS).toEqual([12, 24, 36]);
    expect(PHASE6_OPPONENT_DECISION_ORDINALS).toEqual([2, 5, 8]);
    expect(checkpoints).toHaveLength(11);
    expect(checkpoints.map((checkpoint) => checkpoint.eventIndex)).toEqual([
      1, 4, 8, 9, 12, 16, 17, 24, 25, 27, 36,
    ]);
    expect(
      checkpoints.filter((checkpoint) => checkpoint.timing === "post-event"),
    ).toHaveLength(5);
    expect(
      checkpoints.filter((checkpoint) => checkpoint.timing === "pre-action"),
    ).toHaveLength(6);
    expect(new Set(checkpoints.map((checkpoint) => checkpoint.id)).size).toBe(
      checkpoints.length,
    );
    expect(Object.isFrozen(checkpoints)).toBe(true);
    expect(checkpoints.every((checkpoint) => Object.isFrozen(checkpoint))).toBe(
      true,
    );
  });

  it("preserves combined post-event reasons while deduplicating one state", () => {
    const checkpoints =
      selectPhase6CalibrationCheckpoints(COMPLETE_GAME_EVENTS);

    expect(checkpointAt(checkpoints, 1)).toMatchObject({
      timing: "post-event",
      checkpointClass: ["initial"],
      actualNextEvent: null,
    });
    expect(checkpointAt(checkpoints, 4)).toMatchObject({
      timing: "post-event",
      checkpointClass: ["post-opening"],
      actualNextEvent: null,
    });
    expect(replayEvents(COMPLETE_GAME_EVENTS.slice(0, 3)).state.phase).toBe(
      "opening",
    );
    expect(replayEvents(COMPLETE_GAME_EVENTS.slice(0, 4)).state.phase).toBe(
      "normal",
    );
    expect(checkpointAt(checkpoints, 12).checkpointClass).toEqual([
      "fixed-public-event",
    ]);
    expect(checkpointAt(checkpoints, 24).checkpointClass).toEqual([
      "fixed-public-event",
    ]);
    expect(checkpointAt(checkpoints, 36)).toMatchObject({
      timing: "post-event",
      checkpointClass: [
        "fixed-public-event",
        "post-thulla",
        "post-visible-pickup",
      ],
      actualNextEvent: null,
    });
    expect(
      checkpoints.filter((checkpoint) =>
        checkpoint.checkpointClass.includes("post-thulla"),
      ),
    ).toHaveLength(1);
    expect(
      checkpoints.filter((checkpoint) =>
        checkpoint.checkpointClass.includes("post-visible-pickup"),
      ),
    ).toHaveLength(1);
  });

  it("selects P2/P3 ordinals independently and retains the actual event", () => {
    const checkpoints =
      selectPhase6CalibrationCheckpoints(COMPLETE_GAME_EVENTS);
    const preAction = checkpoints.filter(
      (checkpoint) => checkpoint.timing === "pre-action",
    );

    expect(
      preAction.map((checkpoint) => [
        checkpoint.eventIndex,
        checkpoint.checkpointClass,
      ]),
    ).toEqual([
      [8, ["pre-opponent-choice"]],
      [9, ["pre-opponent-choice"]],
      [16, ["pre-opponent-choice"]],
      [17, ["pre-opponent-choice"]],
      [25, ["pre-opponent-choice"]],
      [27, ["pre-opponent-choice"]],
    ]);
    for (const checkpoint of preAction) {
      expect(checkpoint.actualNextEvent).toEqual(
        COMPLETE_GAME_EVENTS[checkpoint.eventIndex],
      );
      expect(
        COMPLETE_GAME_EVENTS.slice(0, checkpoint.eventIndex),
      ).not.toContainEqual(checkpoint.actualNextEvent);
      const prefixState = replayEvents(
        COMPLETE_GAME_EVENTS.slice(0, checkpoint.eventIndex),
      ).state;
      const actor =
        checkpoint.actualNextEvent.type === "card-played"
          ? checkpoint.actualNextEvent.seat
          : checkpoint.actualNextEvent.actor;
      expect(prefixState.turn).toBe(actor);
      expect(checkpoint.eventIndex).toBeLessThan(COMPLETE_GAME_EVENTS.length);
      expect(Object.isFrozen(checkpoint.actualNextEvent)).toBe(true);
    }
  });

  it("merges post-event and pre-action reasons at one shared prefix state", () => {
    const collisionFixture = generateCompleteGameFixture(204);
    const checkpoints = selectPhase6CalibrationCheckpoints(
      collisionFixture.events,
    );
    const combined = checkpointAt(checkpoints, 24);

    expect(combined).toMatchObject({
      eventIndex: 24,
      timing: "pre-action",
      checkpointClass: [
        "fixed-public-event",
        "post-thulla",
        "post-visible-pickup",
        "pre-opponent-choice",
      ],
      actualNextEvent: {
        type: "card-played",
        seat: "p3",
      },
    });
    expect(
      checkpoints.filter((checkpoint) => checkpoint.eventIndex === 24),
    ).toHaveLength(1);
    if (combined.timing !== "pre-action") {
      throw new Error("Combined collision checkpoint lost pre-action timing.");
    }
    expect(combined.actualNextEvent).toEqual(collisionFixture.events[24]);
    expect(
      replayEvents(collisionFixture.events.slice(0, combined.eventIndex)).state
        .turn,
    ).toBe("p3");
  });

  it("is independent of object identity and does not mutate its input", () => {
    const input = structuredClone(COMPLETE_GAME_EVENTS);
    const before = structuredClone(input);
    const first = selectPhase6CalibrationCheckpoints(input);
    const second = selectPhase6CalibrationCheckpoints(
      structuredClone(COMPLETE_GAME_EVENTS),
    );

    expect(first).toEqual(second);
    expect(input).toEqual(before);
    expect(first.map((checkpoint) => checkpoint.id)).toEqual(
      second.map((checkpoint) => checkpoint.id),
    );
  });

  it("allows a post-event checkpoint at events.length", () => {
    const prefixThroughFirstPickup = COMPLETE_GAME_EVENTS.slice(0, 36);
    replayEvents(prefixThroughFirstPickup);
    const checkpoints = selectPhase6CalibrationCheckpoints(
      prefixThroughFirstPickup,
    );
    const finalCheckpoint = checkpointAt(checkpoints, 36);

    expect(finalCheckpoint.timing).toBe("post-event");
    expect(finalCheckpoint.actualNextEvent).toBeNull();
    expect(finalCheckpoint.eventIndex).toBe(prefixThroughFirstPickup.length);
    expect(finalCheckpoint.checkpointClass).toEqual([
      "fixed-public-event",
      "post-thulla",
      "post-visible-pickup",
    ]);
  });

  it("degrades to only the initial checkpoint for a one-event game", () => {
    const checkpoints = selectPhase6CalibrationCheckpoints([
      structuredClone(COMPLETE_GAME_SETUP),
    ]);

    expect(checkpoints).toEqual([
      {
        eventIndex: 1,
        timing: "post-event",
        id: "phase6-checkpoint/1/post-event/initial",
        checkpointClass: ["initial"],
        actualNextEvent: null,
      },
    ]);
  });

  it("omits fixed and action checkpoints that are not yet valid", () => {
    const shortPrefix = COMPLETE_GAME_EVENTS.slice(0, 7);
    const checkpoints = selectPhase6CalibrationCheckpoints(shortPrefix);

    expect(checkpoints.map((checkpoint) => checkpoint.eventIndex)).toEqual([
      1, 4,
    ]);
    expect(
      checkpoints.every(
        (checkpoint) =>
          checkpoint.eventIndex <= shortPrefix.length &&
          checkpoint.timing === "post-event",
      ),
    ).toBe(true);
  });
});
