import { describe, expect, it } from "vitest";

import { FULL_DECK, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES } from "../../src/domain/rule-config";
import type {
  CardPlayedEvent,
  GameCreatedEvent,
  GameEvent,
} from "../../src/events/game-events";
import {
  appendTimelineEvent,
  createTimeline,
  exportGameArchive,
  importGameArchive,
  replayEvents,
  replayTimeline,
  semanticHistoryHash,
  undoTimeline,
  type GameTimeline,
} from "../../src/events/timeline";
import { stableHash, stableStringify } from "../../src/events/stable-hash";
import type { PublicInformationState } from "../../src/public/public-state";
import { RuleViolation } from "../../src/rules/rule-error";

const RESERVED_OPPONENT_CARDS: readonly Card[] = ["KS", "QS", "JS", "3C", "4C"];

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

function cleanTrickTimeline(): GameTimeline {
  return append(
    openingTimeline(),
    play("user", "2C"),
    play("p2", "3C"),
    play("p3", "4C"),
  );
}

function superficialState(
  state: PublicInformationState,
): PublicInformationState {
  const copy = structuredClone(state);
  copy.effects = [];
  copy.waste.sort();
  copy.unresolvedCards.sort();
  return copy;
}

function expectInvalidSetup(action: () => unknown): RuleViolation {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RuleViolation);
    const violation = error as RuleViolation;
    expect(violation.code).toBe("INVALID_SETUP");
    return violation;
  }
  throw new Error("Expected an INVALID_SETUP RuleViolation.");
}

type MutableArchive = {
  schemaVersion: number;
  semanticHash: string;
  documentHash: string;
  timeline: {
    schemaVersion: number;
    cursor: number;
    events: Record<string, unknown>[];
    orphanedEvents: Record<string, unknown>[];
  };
};

function parseMutableArchive(serialized: string): MutableArchive {
  return JSON.parse(serialized) as MutableArchive;
}

describe("stable semantic hashing", () => {
  it("canonicalizes object key order and preserves a fixed FNV-1a regression vector", () => {
    const first = {
      b: 2,
      a: 1,
    };
    const second = {
      a: 1,
      b: 2,
    };

    expect(stableStringify(first)).toBe('{"a":1,"b":2}');
    expect(stableStringify(second)).toBe(stableStringify(first));
    expect(stableHash(first)).toBe("fnv1a64:a0ebc03bdc71de7b");
    expect(stableHash(second)).toBe(stableHash(first));
  });

  it("is deterministic across cloned event objects and changes with active order", () => {
    const timeline = cleanTrickTimeline();
    const clonedEvents = structuredClone(timeline.events);
    expect(semanticHistoryHash(clonedEvents)).toBe(
      semanticHistoryHash(timeline.events),
    );

    const reordered = [...clonedEvents];
    const left = reordered[5];
    const right = reordered[6];
    if (left === undefined || right === undefined) {
      throw new Error("Hash fixture is missing normal trick events.");
    }
    reordered[5] = right;
    reordered[6] = left;
    expect(semanticHistoryHash(reordered)).not.toBe(
      semanticHistoryHash(timeline.events),
    );
  });

  it("distinguishes histories with the same superficial current card state", () => {
    const firstEvents = openingTimeline("KS", "QS").events;
    const secondEvents = openingTimeline("QS", "KS").events;
    const first = replayEvents(firstEvents);
    const second = replayEvents(secondEvents);

    expect(superficialState(first.state)).toEqual(
      superficialState(second.state),
    );
    expect(first.semanticHash).not.toBe(second.semanticHash);
  });

  it("hashes only active canonical history, restoring prefix and full hashes on undo/redo", () => {
    const full = cleanTrickTimeline();
    const undone = undoTimeline(full);

    expect(replayTimeline(undone).semanticHash).toBe(
      semanticHistoryHash(full.events.slice(0, undone.cursor)),
    );
    expect(replayTimeline(full).semanticHash).toBe(
      semanticHistoryHash(full.events),
    );
    expect(replayTimeline(undone).semanticHash).not.toBe(
      replayTimeline(full).semanticHash,
    );

    const withUnrelatedOrphan: GameTimeline = {
      ...undone,
      orphanedEvents: [play("p3", "JS")],
    };
    expect(replayTimeline(withUnrelatedOrphan).semanticHash).toBe(
      replayTimeline(undone).semanticHash,
    );
  });
});

describe("canonical archive export and import", () => {
  it("round-trips active history, redo tail, and orphan history canonically", () => {
    const full = cleanTrickTimeline();
    const undone = undoTimeline(full);
    const timeline: GameTimeline = {
      ...undone,
      orphanedEvents: [play("p3", "JS")],
    };

    const serialized = exportGameArchive(timeline);
    expect(serialized).toBe(stableStringify(JSON.parse(serialized)));

    const imported = importGameArchive(serialized);
    expect(imported).toEqual(timeline);
    expect(imported).not.toBe(timeline);
    expect(imported.events).not.toBe(timeline.events);
    expect(exportGameArchive(imported)).toBe(serialized);
    expect(replayTimeline(imported)).toEqual(replayTimeline(timeline));
  });

  it("accepts semantically identical JSON regardless of source key order", () => {
    const timeline = openingTimeline();
    const canonical = exportGameArchive(timeline);
    const archive = parseMutableArchive(canonical);
    const reordered = JSON.stringify({
      documentHash: archive.documentHash,
      semanticHash: archive.semanticHash,
      timeline: archive.timeline,
      schemaVersion: archive.schemaVersion,
    });

    expect(importGameArchive(reordered)).toEqual(timeline);
    expect(exportGameArchive(importGameArchive(reordered))).toBe(canonical);
  });

  it("rejects a bad archive hash", () => {
    const archive = parseMutableArchive(exportGameArchive(openingTimeline()));
    archive.semanticHash = "fnv1a64:0000000000000000";

    const violation = expectInvalidSetup(() =>
      importGameArchive(JSON.stringify(archive)),
    );
    expect(violation.message).toContain("semantic hash");
  });

  it("rejects a valid active-history edit when its old hash is retained", () => {
    const archive = parseMutableArchive(exportGameArchive(openingTimeline()));
    const p2Play = archive.timeline.events[2];
    if (p2Play === undefined) {
      throw new Error("Archive fixture has no Player 2 opening event.");
    }
    p2Play.card = "JS";

    const violation = expectInvalidSetup(() =>
      importGameArchive(JSON.stringify(archive)),
    );
    expect(violation.message).toContain("semantic hash");
  });

  it("rejects an altered active cursor when its old hash is retained", () => {
    const archive = parseMutableArchive(
      exportGameArchive(cleanTrickTimeline()),
    );
    archive.timeline.cursor -= 1;

    expectInvalidSetup(() => importGameArchive(JSON.stringify(archive)));
  });

  it("rejects redo-tail or orphan tampering with the whole-document hash", () => {
    const original = cleanTrickTimeline();
    const timeline: GameTimeline = {
      ...undoTimeline(original),
      orphanedEvents: [play("p3", "JS")],
    };
    const redoTamper = parseMutableArchive(exportGameArchive(timeline));
    const redoEvent = redoTamper.timeline.events.at(-1);
    if (redoEvent === undefined) {
      throw new Error("Archive fixture has no redo event.");
    }
    redoEvent.card = "5C";
    const redoViolation = expectInvalidSetup(() =>
      importGameArchive(JSON.stringify(redoTamper)),
    );
    expect(redoViolation.message).toContain("document hash");

    const orphanTamper = parseMutableArchive(exportGameArchive(timeline));
    const orphan = orphanTamper.timeline.orphanedEvents[0];
    if (orphan === undefined) {
      throw new Error("Archive fixture has no orphan event.");
    }
    orphan.card = "QS";
    const orphanViolation = expectInvalidSetup(() =>
      importGameArchive(JSON.stringify(orphanTamper)),
    );
    expect(orphanViolation.message).toContain("document hash");
  });

  it("rejects invalid JSON and a cursor outside the stored event list", () => {
    expectInvalidSetup(() => importGameArchive("{not-json"));

    const archive = parseMutableArchive(exportGameArchive(openingTimeline()));
    archive.timeline.cursor = archive.timeline.events.length + 1;
    const violation = expectInvalidSetup(() =>
      importGameArchive(JSON.stringify(archive)),
    );
    expect(violation.message).toContain("cursor");
  });
});
