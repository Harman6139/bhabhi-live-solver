import { describe, expect, it } from "vitest";

import {
  createActorObservation,
  type ActorObservationSource,
} from "../../src/agents/observation";
import { sortCards, type Card } from "../../src/domain/cards";
import type { Seat } from "../../src/domain/seats";
import type { GameEvent } from "../../src/events/game-events";
import type { PolicyObservation } from "../../src/agents/policies";
import { makeExactPublicState } from "../support/state-builders";

type ObservationWorld = {
  readonly source: ActorObservationSource;
  readonly events: readonly GameEvent[];
};

const PUBLIC_PICKUP_CARDS = ["8H", "9H"] as const;
const PUBLIC_WASTE_DRAW = "7S" as const;

function makeSource(
  handsValue: Readonly<Record<Seat, readonly Card[]>>,
  pickup: {
    readonly picker: Seat;
    readonly thullaBy: Seat;
  },
  activeSeats: readonly Seat[] = ["user", "p2", "p3"],
): ActorObservationSource {
  const exactHands = {
    user: sortCards(handsValue.user),
    p2: sortCards(handsValue.p2),
    p3: sortCards(handsValue.p3),
  };
  const publicState = makeExactPublicState({
    hands: exactHands,
    activeSeats,
  });
  publicState.effects.push({
    type: "trick-picked-up",
    eventIndex: 0,
    cards: [...PUBLIC_PICKUP_CARDS],
    picker: pickup.picker,
    thullaBy: pickup.thullaBy,
  });

  return { publicState, exactHands };
}

function observe(world: ObservationWorld, seat: Seat): PolicyObservation {
  return createActorObservation(world.source, seat, 11, world.events);
}

function observedStrings(value: unknown, strings = new Set<string>()) {
  if (typeof value === "string") {
    strings.add(value);
  } else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      observedStrings(child, strings);
    }
  }
  return strings;
}

function expectPublicKnowledge(
  observation: PolicyObservation,
  pickup: {
    readonly picker: Seat;
    readonly thullaBy: Seat;
  },
  wasteDrawer: Seat,
): void {
  expect(observation.lastPickup).toEqual({
    picker: pickup.picker,
    cards: [...PUBLIC_PICKUP_CARDS],
    thullaBy: pickup.thullaBy,
  });
  expect(observation.currentSuitStatus[pickup.picker].hearts).toBe("known-has");
  expect(observation.currentSuitStatus[wasteDrawer].spades).toBe("known-has");
  expect(observation.waste).not.toContain(PUBLIC_WASTE_DRAW);
}

function privateDrawWorld(card: "4D" | "5S"): ObservationWorld {
  const otherCard = card === "4D" ? "5S" : "4D";
  return {
    source: makeSource(
      {
        user: ["2C", card, ...PUBLIC_PICKUP_CARDS],
        p2: [otherCard, "6C"],
        p3: [PUBLIC_WASTE_DRAW, "TD"],
      },
      { picker: "user", thullaBy: "p2" },
    ),
    events: [
      {
        type: "waste-card-drawn",
        schemaVersion: 1,
        seat: "p3",
        card: PUBLIC_WASTE_DRAW,
      },
      {
        type: "player-card-drawn",
        schemaVersion: 1,
        seat: "user",
        source: "p2",
        card,
      },
    ],
  };
}

function privateTakeWorld(
  revealedCards: readonly ["4D" | "5S", "6C"],
): ObservationWorld {
  const source = makeSource(
    {
      user: ["2C", PUBLIC_WASTE_DRAW],
      p2: ["4D", "5S", "6C", ...PUBLIC_PICKUP_CARDS],
      p3: [],
    },
    { picker: "p2", thullaBy: "p3" },
    ["user", "p2"],
  );
  source.publicState.effects.push({
    type: "hand-taken",
    eventIndex: 1,
    actor: "p2",
    target: "p3",
    count: revealedCards.length,
  });

  return {
    source,
    events: [
      {
        type: "waste-card-drawn",
        schemaVersion: 1,
        seat: "user",
        card: PUBLIC_WASTE_DRAW,
      },
      {
        type: "hand-taken",
        schemaVersion: 1,
        actor: "p2",
        target: "p3",
        revealedCards,
      },
    ],
  };
}

function forcedPrivateDrawWorld(drawnCard: "5S" | "8H"): ObservationWorld {
  const retainedCard = drawnCard === "5S" ? "8H" : "5S";
  const exactHands = {
    user: ["2C"] as Card[],
    p2: [retainedCard, "6C"] as Card[],
    p3: ["TD"] as Card[],
  };
  const publicState = makeExactPublicState({ hands: exactHands });
  publicState.waste.splice(publicState.waste.indexOf(drawnCard), 1);
  publicState.trick = {
    kind: "normal",
    leader: "p3",
    leadSuit: drawnCard === "5S" ? "spades" : "hearts",
    participants: ["p3", "user", "p2"],
    startedHeadsUp: false,
    forcedLeadCard: drawnCard,
    shootoutForcedLead: false,
    plays: [
      {
        seat: "p3",
        card: drawnCard,
        offSuit: false,
        eventIndex: 3,
      },
    ],
  };
  publicState.turn = "user";
  publicState.effects.push(
    {
      type: "trick-picked-up",
      eventIndex: 1,
      cards: ["8H"],
      picker: "p2",
      thullaBy: "user",
    },
    {
      type: "card-played",
      eventIndex: 3,
      seat: "p3",
      card: drawnCard,
      offSuit: false,
    },
  );
  return {
    source: { publicState, exactHands },
    events: [
      {
        type: "game-created",
        schemaVersion: 1,
        rules: publicState.rules,
        userHand: ["2C"],
        startingCounts: { user: 18, p2: 17, p3: 17 },
        aceSpadesHolder: "user",
      },
      {
        type: "card-played",
        schemaVersion: 1,
        seat: "p2",
        card: "8H",
      },
      {
        type: "player-card-drawn",
        schemaVersion: 1,
        seat: "p3",
        source: "p2",
        card: drawnCard,
      },
      {
        type: "card-played",
        schemaVersion: 1,
        seat: "p3",
        card: drawnCard,
      },
    ],
  };
}

describe("actor-observation private event identities", () => {
  it("hides a player-draw identity from the uninvolved actor but not its recipient or source", () => {
    const diamondDraw = privateDrawWorld("4D");
    const spadeDraw = privateDrawWorld("5S");

    const uninvolvedDiamond = observe(diamondDraw, "p3");
    const uninvolvedSpade = observe(spadeDraw, "p3");
    expect(uninvolvedDiamond).toEqual(uninvolvedSpade);
    expect(
      [...observedStrings(uninvolvedDiamond)].filter(
        (value) => value === "4D" || value === "5S",
      ),
    ).toEqual([]);

    const recipientDiamond = observe(diamondDraw, "user");
    const recipientSpade = observe(spadeDraw, "user");
    expect(recipientDiamond.ownHand).toContain("4D");
    expect(recipientDiamond.ownHand).not.toContain("5S");
    expect(recipientSpade.ownHand).toContain("5S");
    expect(recipientSpade.ownHand).not.toContain("4D");
    expect(recipientDiamond).not.toEqual(recipientSpade);

    const sourceDiamond = observe(diamondDraw, "p2");
    const sourceSpade = observe(spadeDraw, "p2");
    expect(sourceDiamond.ownHand).toContain("5S");
    expect(sourceDiamond.ownHand).not.toContain("4D");
    expect(sourceSpade.ownHand).toContain("4D");
    expect(sourceSpade.ownHand).not.toContain("5S");
    expect(sourceDiamond).not.toEqual(sourceSpade);

    expectPublicKnowledge(
      uninvolvedDiamond,
      { picker: "user", thullaBy: "p2" },
      "p3",
    );
    expectPublicKnowledge(
      uninvolvedSpade,
      { picker: "user", thullaBy: "p2" },
      "p3",
    );
  });

  it("hides taken-hand reveal identities from the uninvolved actor while retaining them for the source", () => {
    const diamondReveal = privateTakeWorld(["4D", "6C"]);
    const spadeReveal = privateTakeWorld(["5S", "6C"]);

    const uninvolvedDiamond = observe(diamondReveal, "user");
    const uninvolvedSpade = observe(spadeReveal, "user");
    expect(uninvolvedDiamond).toEqual(uninvolvedSpade);
    expect(
      [...observedStrings(uninvolvedDiamond)].filter(
        (value) => value === "4D" || value === "5S",
      ),
    ).toEqual([]);

    const sourceDiamond = observe(diamondReveal, "p3");
    const sourceSpade = observe(spadeReveal, "p3");
    expect(sourceDiamond.currentSuitStatus.p2.diamonds).toBe("known-has");
    expect(sourceDiamond.currentSuitStatus.p2.spades).toBe("unknown");
    expect(sourceSpade.currentSuitStatus.p2.diamonds).toBe("unknown");
    expect(sourceSpade.currentSuitStatus.p2.spades).toBe("known-has");
    expect(sourceDiamond).not.toEqual(sourceSpade);

    const actor = observe(diamondReveal, "p2");
    expect(actor.ownHand).toEqual(
      sortCards(["4D", "5S", "6C", ...PUBLIC_PICKUP_CARDS]),
    );
    expect(actor.currentSuitStatus.p2).toMatchObject({
      clubs: "known-has",
      diamonds: "known-has",
      hearts: "known-has",
      spades: "known-has",
    });

    expectPublicKnowledge(
      uninvolvedDiamond,
      { picker: "p2", thullaBy: "p3" },
      "user",
    );
    expectPublicKnowledge(
      uninvolvedSpade,
      { picker: "p2", thullaBy: "p3" },
      "user",
    );
  });

  it("reconciles an ambiguous private draw when its forced card is publicly led", () => {
    const unknownSpadeMoved = observe(forcedPrivateDrawWorld("5S"), "user");
    const knownHeartMoved = observe(forcedPrivateDrawWorld("8H"), "user");

    expect(unknownSpadeMoved.currentSuitStatus.p2.hearts).toBe("known-has");
    expect(knownHeartMoved.currentSuitStatus.p2.hearts).toBe("unknown");
  });
});
