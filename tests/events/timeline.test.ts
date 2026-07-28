import { describe, expect, it } from "vitest";

import { FULL_DECK, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES } from "../../src/domain/rule-config";
import type {
  CardPlayedEvent,
  GameCreatedEvent,
  GameEvent,
} from "../../src/events/game-events";
import {
  activeTimelineEvents,
  appendTimelineEvent,
  correctTimelineEventAtomic,
  correctTimelineEventRebased,
  createTimeline,
  exportGameArchive,
  redoTimeline,
  replayEvents,
  replayTimeline,
  semanticHistoryHash,
  undoTimeline,
  type GameTimeline,
} from "../../src/events/timeline";
import { RuleViolation, type RuleErrorCode } from "../../src/rules/rule-error";

const RESERVED_OPPONENT_CARDS: readonly Card[] = [
  "KS",
  "QS",
  "JS",
  "3C",
  "4C",
  "5C",
  "6C",
];

function gameCreated(): GameCreatedEvent {
  const userHand: Card[] = ["AS", "2C", "2D"];
  for (const card of FULL_DECK) {
    if (userHand.length === 18) {
      break;
    }
    if (!userHand.includes(card) && !RESERVED_OPPONENT_CARDS.includes(card)) {
      userHand.push(card);
    }
  }
  if (userHand.length !== 18) {
    throw new Error("Event test fixture could not construct an 18-card hand.");
  }
  return {
    type: "game-created",
    schemaVersion: 1,
    rules: structuredClone(CANONICAL_RULES),
    userHand,
    startingCounts: { user: 18, p2: 17, p3: 17 },
    aceSpadesHolder: "user",
  };
}

function play(seat: CardPlayedEvent["seat"], card: Card): CardPlayedEvent {
  return { type: "card-played", schemaVersion: 1, seat, card };
}

function append(
  timeline: GameTimeline,
  ...events: readonly Exclude<GameEvent, GameCreatedEvent>[]
): GameTimeline {
  return events.reduce(appendTimelineEvent, timeline);
}

function openingTimeline(
  p2Card: Card = "KS",
  p3Card: Card = "QS",
): GameTimeline {
  return append(
    createTimeline(gameCreated()),
    play("user", "AS"),
    play("p2", p2Card),
    play("p3", p3Card),
  );
}

function cleanTrickTimeline(lastCard: Card = "4C"): GameTimeline {
  return append(
    openingTimeline(),
    play("user", "2C"),
    play("p2", "3C"),
    play("p3", lastCard),
  );
}

function expectViolation(
  action: () => unknown,
  code: RuleErrorCode,
  eventIndex: number | null,
): RuleViolation {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RuleViolation);
    const violation = error as RuleViolation;
    expect(violation.code).toBe(code);
    expect(violation.eventIndex).toBe(eventIndex);
    return violation;
  }
  throw new Error(`Expected RuleViolation ${code}.`);
}

describe("deterministic event replay", () => {
  it("replays the same active history to an identical state and hash without mutating input", () => {
    const timeline = cleanTrickTimeline();
    const eventsBefore = structuredClone(timeline.events);

    const first = replayEvents(timeline.events);
    const second = replayEvents(timeline.events);

    expect(first).toEqual(second);
    expect(replayTimeline(timeline)).toEqual(first);
    expect(timeline.events).toEqual(eventsBefore);
    expect(first.activeEvents).toEqual(timeline.events);
    expect(first.activeEvents).not.toBe(timeline.events);
    expect(first.semanticHash).toBe(semanticHistoryHash(timeline.events));
    expect(first.state.appliedEventCount).toBe(timeline.events.length);
    expect(first.state.power).toBe("p3");
  });

  it("rejects histories without one creation event at index zero", () => {
    expectViolation(
      () => replayEvents([play("user", "AS")]),
      "GAME_NOT_CREATED",
      0,
    );

    const created = gameCreated();
    expectViolation(
      () => replayEvents([created, structuredClone(created)]),
      "GAME_ALREADY_CREATED",
      1,
    );
  });
});

describe("undo, redo, and branch semantics", () => {
  it("makes undo equal prefix replay and redo restore the exact full result", () => {
    const full = cleanTrickTimeline();
    const fullReplay = replayTimeline(full);

    const undone = undoTimeline(full);
    const undoneReplay = replayTimeline(undone);
    expect(undone.cursor).toBe(full.cursor - 1);
    expect(undoneReplay).toEqual(
      replayEvents(full.events.slice(0, full.cursor - 1)),
    );
    expect(undoneReplay.semanticHash).not.toBe(fullReplay.semanticHash);

    const redone = redoTimeline(undone);
    expect(redone).toEqual(full);
    expect(replayTimeline(redone)).toEqual(fullReplay);

    expect(undoTimeline(createTimeline(gameCreated())).cursor).toBe(1);
    expect(redoTimeline(full)).toEqual(full);
  });

  it("truncates redo on append and preserves every displaced branch as an orphan", () => {
    const original = cleanTrickTimeline("4C");
    const originalBefore = structuredClone(original);
    const undone = undoTimeline(original);

    const firstBranch = appendTimelineEvent(undone, play("p3", "5C"));
    expect(firstBranch.cursor).toBe(firstBranch.events.length);
    expect(firstBranch.events.at(-1)).toEqual(play("p3", "5C"));
    expect(firstBranch.orphanedEvents).toEqual([play("p3", "4C")]);
    expect(redoTimeline(firstBranch)).toEqual(firstBranch);

    const secondBranch = appendTimelineEvent(
      undoTimeline(firstBranch),
      play("p3", "6C"),
    );
    expect(secondBranch.events.at(-1)).toEqual(play("p3", "6C"));
    expect(secondBranch.orphanedEvents).toEqual([
      play("p3", "5C"),
      play("p3", "4C"),
    ]);
    expect(activeTimelineEvents(secondBranch)).toEqual(secondBranch.events);
    expect(original).toEqual(originalBefore);
  });
});

describe("arbitrary correction policies", () => {
  it("commits an atomic correction only when its complete retained suffix replays", () => {
    const original = cleanTrickTimeline();
    const originalArchive = exportGameArchive(original);
    const originalHash = replayTimeline(original).semanticHash;

    const corrected = correctTimelineEventAtomic(original, 2, play("p2", "JS"));
    expect(corrected.events[2]).toEqual(play("p2", "JS"));
    expect(corrected.orphanedEvents).toEqual([]);
    expect(replayTimeline(corrected).semanticHash).not.toBe(originalHash);
    expect(exportGameArchive(original)).toBe(originalArchive);
  });

  it("rejects atomically when a valid replacement makes a later event illegal", () => {
    const original = cleanTrickTimeline();
    const originalArchive = exportGameArchive(original);

    const violation = expectViolation(
      () => correctTimelineEventAtomic(original, 4, play("user", "2D")),
      "WRONG_TURN",
      6,
    );
    expect(violation.message).toContain("user's turn");
    expect(exportGameArchive(original)).toBe(originalArchive);
  });

  it("rebases through the last valid retained event and orphans the invalid suffix", () => {
    const original = cleanTrickTimeline();
    const originalBefore = structuredClone(original);

    const correction = correctTimelineEventRebased(
      original,
      4,
      play("user", "2D"),
    );

    expect(correction.firstInvalidEventIndex).toBe(6);
    expect(correction.violation?.code).toBe("WRONG_TURN");
    expect(correction.timeline.cursor).toBe(6);
    expect(correction.timeline.events).toEqual([
      ...original.events.slice(0, 4),
      play("user", "2D"),
      original.events[5],
    ]);
    expect(correction.timeline.orphanedEvents).toEqual([play("p3", "4C")]);

    const replay = replayTimeline(correction.timeline);
    expect(replay.state.turn).toBe("user");
    expect(
      replay.state.effects.findLast(
        (effect) => effect.type === "trick-picked-up",
      ),
    ).toMatchObject({
      type: "trick-picked-up",
      picker: "user",
      cards: ["2D", "3C"],
    });
    expect(original).toEqual(originalBefore);
  });

  it("orders newly invalid suffix events before pre-existing orphan branches", () => {
    const original = cleanTrickTimeline("4C");
    const branched = appendTimelineEvent(
      undoTimeline(original),
      play("p3", "5C"),
    );
    expect(branched.orphanedEvents).toEqual([play("p3", "4C")]);

    const correction = correctTimelineEventRebased(
      branched,
      4,
      play("user", "2D"),
    );
    expect(correction.firstInvalidEventIndex).toBe(6);
    expect(correction.timeline.orphanedEvents).toEqual([
      play("p3", "5C"),
      play("p3", "4C"),
    ]);
    expect(() => replayTimeline(correction.timeline)).not.toThrow();
  });

  it("rebases a creation-event correction and orphans the now-wrong directional suffix", () => {
    const original = openingTimeline();
    const correctedCreation: GameCreatedEvent = {
      ...gameCreated(),
      rules: {
        ...CANONICAL_RULES,
        direction: "anticlockwise",
      },
    };

    const correction = correctTimelineEventRebased(
      original,
      0,
      correctedCreation,
    );
    expect(correction.firstInvalidEventIndex).toBe(2);
    expect(correction.violation?.code).toBe("WRONG_TURN");
    expect(correction.timeline.events).toEqual([
      correctedCreation,
      play("user", "AS"),
    ]);
    expect(correction.timeline.orphanedEvents).toEqual([
      play("p2", "KS"),
      play("p3", "QS"),
    ]);
    expect(replayTimeline(correction.timeline).state.turn).toBe("p3");
  });

  it("rejects correction indexes outside active history", () => {
    const timeline = openingTimeline();
    expect(() =>
      correctTimelineEventAtomic(timeline, timeline.cursor, play("p2", "JS")),
    ).toThrow(RangeError);
    expect(() =>
      correctTimelineEventRebased(timeline, -1, play("p2", "JS")),
    ).toThrow(RangeError);
  });
});
