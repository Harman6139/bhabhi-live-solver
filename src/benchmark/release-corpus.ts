import { FULL_DECK, sortCards, type Card } from "../domain/cards";
import { CANONICAL_RULES } from "../domain/rule-config";
import type { GameCreatedEvent, GameEvent } from "../events/game-events";
import {
  appendTimelineEvent,
  createTimeline,
  type GameTimeline,
} from "../events/timeline";
import {
  createLatencyCorpus,
  createLatencySnapshot,
} from "./latency-artifacts";
import type { LatencyCorpus } from "./latency-contract";

function startingHand(
  required: readonly Card[],
  excluded: readonly Card[],
): readonly Card[] {
  const cards = [...required];
  for (const card of FULL_DECK) {
    if (cards.length === 18) {
      break;
    }
    if (!cards.includes(card) && !excluded.includes(card)) {
      cards.push(card);
    }
  }
  return sortCards(cards);
}

function timeline(eventCount: number): GameTimeline {
  const setup: GameCreatedEvent = {
    type: "game-created",
    schemaVersion: 1,
    rules: CANONICAL_RULES,
    userHand: startingHand(["AS", "2H", "3C"], ["KS", "QS", "2C", "KC", "4H"]),
    startingCounts: { user: 18, p2: 17, p3: 17 },
    aceSpadesHolder: "user",
  };
  const events = [
    { type: "card-played", schemaVersion: 1, seat: "user", card: "AS" },
    { type: "card-played", schemaVersion: 1, seat: "p2", card: "KS" },
    { type: "card-played", schemaVersion: 1, seat: "p3", card: "QS" },
    { type: "card-played", schemaVersion: 1, seat: "user", card: "2H" },
    { type: "card-played", schemaVersion: 1, seat: "p2", card: "2C" },
  ] as const satisfies readonly Exclude<GameEvent, GameCreatedEvent>[];
  return events
    .slice(0, eventCount)
    .reduce(
      (value, event) => appendTimelineEvent(value, event),
      createTimeline(setup),
    );
}

export function createReferenceReleaseLatencyCorpus(input: {
  readonly corpusId: string;
  readonly createdAt: string;
  readonly split: "qualification" | "final";
  readonly manifestId: string;
  readonly manifestSha256: string;
  readonly protocolSha256: string;
}): LatencyCorpus {
  const analysis = createLatencySnapshot(timeline(3));
  return createLatencyCorpus({
    corpusId: input.corpusId,
    createdAt: input.createdAt,
    split: input.split,
    phase8ManifestId: input.manifestId,
    phase8ManifestSha256: input.manifestSha256,
    protocolSha256: input.protocolSha256,
    samplingPolicy:
      "fixed-candidate-independent-public-user-turn-and-distinct-entry-probes-v1",
    entries: [
      {
        entryId: "entry-correction",
        category: "correction-probe",
        analysis,
        entryProbe: createLatencySnapshot(timeline(5)),
      },
      {
        entryId: "entry-normal",
        category: "normal-user-turn",
        analysis,
        entryProbe: createLatencySnapshot(timeline(4)),
      },
    ],
  });
}
