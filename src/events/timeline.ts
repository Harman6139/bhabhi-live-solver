import { z } from "zod";

import {
  gameEventSchema,
  type GameCreatedEvent,
  type GameEvent,
} from "./game-events";
import type { PublicInformationState } from "../public/public-state";
import { RuleViolation } from "../rules/rule-error";
import { applyGameEvent, createInitialPublicState } from "../rules/reducer";
import { stableHash, stableStringify } from "./stable-hash";

export type GameTimeline = {
  readonly schemaVersion: 1;
  readonly events: readonly GameEvent[];
  readonly cursor: number;
  readonly orphanedEvents: readonly GameEvent[];
};

export type ReplayResult = {
  readonly state: PublicInformationState;
  readonly semanticHash: string;
  readonly activeEvents: readonly GameEvent[];
};

export type RebasedCorrection = {
  readonly timeline: GameTimeline;
  readonly firstInvalidEventIndex: number | null;
  readonly violation: RuleViolation | null;
};

const timelineSchema = z.object({
  schemaVersion: z.literal(1),
  events: z.array(gameEventSchema),
  cursor: z.int().min(1),
  orphanedEvents: z.array(gameEventSchema),
});

const archiveSchema = z.object({
  schemaVersion: z.literal(1),
  timeline: timelineSchema,
  semanticHash: z.string().min(1),
  documentHash: z.string().min(1),
});

function asTimeline(value: z.infer<typeof timelineSchema>): GameTimeline {
  if (value.cursor > value.events.length) {
    throw new RuleViolation(
      "INVALID_SETUP",
      `Timeline cursor ${value.cursor} exceeds ${value.events.length} events.`,
    );
  }
  return value;
}

export function createTimeline(event: GameCreatedEvent): GameTimeline {
  createInitialPublicState(event);
  return {
    schemaVersion: 1,
    events: [structuredClone(event)],
    cursor: 1,
    orphanedEvents: [],
  };
}

export function activeTimelineEvents(
  timeline: GameTimeline,
): readonly GameEvent[] {
  return timeline.events.slice(0, timeline.cursor);
}

export function semanticHistoryHash(events: readonly GameEvent[]): string {
  return stableHash({
    schemaVersion: 1,
    activeEvents: events,
  });
}

export function replayEvents(events: readonly GameEvent[]): ReplayResult {
  const first = events[0];
  if (first?.type !== "game-created") {
    throw new RuleViolation(
      "GAME_NOT_CREATED",
      "Event history must begin with game-created.",
      0,
    );
  }

  let state = createInitialPublicState(first);
  for (let index = 1; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) {
      throw new RuleViolation(
        "INVARIANT_VIOLATION",
        `Event ${index} is missing.`,
        index,
      );
    }
    if (event.type === "game-created") {
      throw new RuleViolation(
        "GAME_ALREADY_CREATED",
        "Only event 0 may create the game.",
        index,
      );
    }
    state = applyGameEvent(state, event, index);
  }
  return {
    state,
    semanticHash: semanticHistoryHash(events),
    activeEvents: structuredClone(events),
  };
}

export function replayTimeline(timeline: GameTimeline): ReplayResult {
  return replayEvents(activeTimelineEvents(timeline));
}

export function appendTimelineEvent(
  timeline: GameTimeline,
  event: Exclude<GameEvent, GameCreatedEvent>,
): GameTimeline {
  const active = activeTimelineEvents(timeline);
  replayEvents([...active, event]);
  return {
    schemaVersion: 1,
    events: [...active, structuredClone(event)],
    cursor: active.length + 1,
    orphanedEvents: [
      ...timeline.events.slice(timeline.cursor),
      ...timeline.orphanedEvents,
    ],
  };
}

export function undoTimeline(timeline: GameTimeline): GameTimeline {
  return {
    ...timeline,
    cursor: Math.max(1, timeline.cursor - 1),
  };
}

export function redoTimeline(timeline: GameTimeline): GameTimeline {
  const cursor = Math.min(timeline.events.length, timeline.cursor + 1);
  const next = { ...timeline, cursor };
  replayTimeline(next);
  return next;
}

export function correctTimelineEventAtomic(
  timeline: GameTimeline,
  index: number,
  replacement: GameEvent,
): GameTimeline {
  const active = [...activeTimelineEvents(timeline)];
  if (index < 0 || index >= active.length) {
    throw new RangeError(
      `Correction index ${index} is outside active history.`,
    );
  }
  active[index] = structuredClone(replacement);
  replayEvents(active);
  return {
    schemaVersion: 1,
    events: active,
    cursor: active.length,
    orphanedEvents: [
      ...timeline.events.slice(timeline.cursor),
      ...timeline.orphanedEvents,
    ],
  };
}

export function correctTimelineEventRebased(
  timeline: GameTimeline,
  index: number,
  replacement: GameEvent,
): RebasedCorrection {
  const active = [...activeTimelineEvents(timeline)];
  if (index < 0 || index >= active.length) {
    throw new RangeError(
      `Correction index ${index} is outside active history.`,
    );
  }
  active[index] = structuredClone(replacement);

  let validLength = 0;
  let violation: RuleViolation | null = null;
  try {
    const first = active[0];
    if (first?.type !== "game-created") {
      throw new RuleViolation(
        "GAME_NOT_CREATED",
        "Corrected history no longer begins with game-created.",
        0,
      );
    }
    let state = createInitialPublicState(first);
    validLength = 1;
    for (let eventIndex = 1; eventIndex < active.length; eventIndex += 1) {
      const event = active[eventIndex];
      if (event === undefined || event.type === "game-created") {
        throw new RuleViolation(
          "GAME_ALREADY_CREATED",
          "A retained suffix contains an invalid game-created event.",
          eventIndex,
        );
      }
      state = applyGameEvent(state, event, eventIndex);
      validLength = eventIndex + 1;
    }
  } catch (error) {
    if (!(error instanceof RuleViolation)) {
      throw error;
    }
    if ((error.eventIndex ?? 0) === 0) {
      throw error.eventIndex === null ? error.atEvent(0) : error;
    }
    violation = error;
    validLength = error.eventIndex ?? validLength;
  }

  const validEvents = active.slice(0, validLength);
  const newlyOrphaned = [
    ...active.slice(validLength),
    ...timeline.events.slice(timeline.cursor),
    ...timeline.orphanedEvents,
  ];
  const rebased: GameTimeline = {
    schemaVersion: 1,
    events: validEvents,
    cursor: validEvents.length,
    orphanedEvents: newlyOrphaned,
  };
  replayTimeline(rebased);
  return {
    timeline: rebased,
    firstInvalidEventIndex: violation?.eventIndex ?? null,
    violation,
  };
}

export type GameArchive = {
  readonly schemaVersion: 1;
  readonly timeline: GameTimeline;
  readonly semanticHash: string;
  readonly documentHash: string;
};

export function exportGameArchive(timeline: GameTimeline): string {
  const replay = replayTimeline(timeline);
  const content = {
    schemaVersion: 1,
    timeline: structuredClone(timeline),
    semanticHash: replay.semanticHash,
  } as const;
  const archive: GameArchive = {
    ...content,
    documentHash: stableHash(content),
  };
  return stableStringify(archive);
}

export function importGameArchive(serialized: string): GameTimeline {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new RuleViolation(
      "INVALID_SETUP",
      "The imported file is not valid JSON.",
    );
  }
  const archive = archiveSchema.parse(value);
  const timeline = asTimeline(archive.timeline);
  const replay = replayTimeline(timeline);
  if (replay.semanticHash !== archive.semanticHash) {
    throw new RuleViolation(
      "INVALID_SETUP",
      "The imported semantic hash does not match its active history.",
    );
  }
  const expectedDocumentHash = stableHash({
    schemaVersion: archive.schemaVersion,
    timeline: archive.timeline,
    semanticHash: archive.semanticHash,
  });
  if (expectedDocumentHash !== archive.documentHash) {
    throw new RuleViolation(
      "INVALID_SETUP",
      "The imported document hash does not match the complete timeline, redo tail, and orphan history.",
    );
  }
  return structuredClone(timeline);
}
