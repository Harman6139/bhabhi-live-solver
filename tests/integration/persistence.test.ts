import { IDBFactory } from "fake-indexeddb";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

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
  type GameTimeline,
} from "../../src/events/timeline";
import {
  clearSavedGame,
  GAME_STORE_CURRENT_KEY,
  GAME_STORE_DATABASE_NAME,
  GAME_STORE_DATABASE_VERSION,
  GAME_STORE_OBJECT_STORE_NAME,
  GameStoreError,
  loadGameTimeline,
  saveGameTimeline,
} from "../../src/persistence/game-store";

const originalIndexedDbDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "indexedDB",
);

const RESERVED_OPPONENT_CARDS: readonly Card[] = ["KS", "QS", "JS"];

function installIndexedDb(value: IDBFactory | undefined): void {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

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

function partialTimeline(): GameTimeline {
  return append(createTimeline(gameCreated()), play("user", "AS"));
}

function openingTimeline(): GameTimeline {
  return append(partialTimeline(), play("p2", "KS"), play("p3", "QS"));
}

function openRawDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(
      GAME_STORE_DATABASE_NAME,
      GAME_STORE_DATABASE_VERSION,
    );
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Raw IndexedDB open failed."));
    };
  });
}

async function putRawCurrentRecord(value: unknown): Promise<void> {
  const database = await openRawDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        GAME_STORE_OBJECT_STORE_NAME,
        "readwrite",
      );
      transaction
        .objectStore(GAME_STORE_OBJECT_STORE_NAME)
        .put(value, GAME_STORE_CURRENT_KEY);
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("Raw IndexedDB write failed."));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("Raw IndexedDB write aborted."));
      };
    });
  } finally {
    database.close();
  }
}

async function getRawCurrentRecord(): Promise<unknown> {
  const database = await openRawDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        GAME_STORE_OBJECT_STORE_NAME,
        "readonly",
      );
      const request = transaction
        .objectStore(GAME_STORE_OBJECT_STORE_NAME)
        .get(GAME_STORE_CURRENT_KEY);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Raw IndexedDB read failed."));
      };
    });
  } finally {
    database.close();
  }
}

beforeEach(() => {
  installIndexedDb(new IDBFactory());
});

afterAll(() => {
  if (originalIndexedDbDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "indexedDB");
  } else {
    Object.defineProperty(globalThis, "indexedDB", originalIndexedDbDescriptor);
  }
});

describe("current-session IndexedDB persistence", () => {
  it("returns null when no current session has been saved", async () => {
    await expect(loadGameTimeline()).resolves.toBeNull();
  });

  it("saves a canonical archive and loads a deep timeline round trip", async () => {
    const timeline = openingTimeline();

    await saveGameTimeline(timeline);
    const loaded = await loadGameTimeline();

    expect(loaded).toEqual(timeline);
    expect(loaded).not.toBe(timeline);
    expect(loaded?.events).not.toBe(timeline.events);

    const raw = await getRawCurrentRecord();
    expect(raw).toBeTypeOf("object");
    const record = raw as {
      schemaVersion: unknown;
      archive: unknown;
      savedAt: unknown;
    };
    expect(record.schemaVersion).toBe(1);
    expect(record.archive).toBe(exportGameArchive(timeline));
    expect(record.savedAt).toBeTypeOf("string");
    const savedAt = record.savedAt as string;
    expect(Number.isFinite(Date.parse(savedAt))).toBe(true);
  });

  it("atomically overwrites the current-session key with the latest timeline", async () => {
    const first = partialTimeline();
    const second = openingTimeline();

    await saveGameTimeline(first);
    expect(await loadGameTimeline()).toEqual(first);

    await saveGameTimeline(second);
    expect(await loadGameTimeline()).toEqual(second);
    expect(await getRawCurrentRecord()).toMatchObject({
      schemaVersion: 1,
      archive: exportGameArchive(second),
    });
  });

  it("clears a saved session and remains idempotent when already empty", async () => {
    await saveGameTimeline(openingTimeline());
    await clearSavedGame();
    await expect(loadGameTimeline()).resolves.toBeNull();

    await clearSavedGame();
    await expect(loadGameTimeline()).resolves.toBeNull();
  });

  it("rejects a malformed versioned record without deleting or rewriting it", async () => {
    await saveGameTimeline(openingTimeline());
    const malformed = {
      schemaVersion: 2,
      archive: "not-an-archive",
      savedAt: "not-a-date",
    };
    await putRawCurrentRecord(malformed);

    await expect(loadGameTimeline()).rejects.toMatchObject({
      name: "GameStoreError",
      code: "corrupt-record",
    });
    expect(await getRawCurrentRecord()).toEqual(malformed);
  });

  it("rejects a corrupt canonical archive without replacing its record", async () => {
    const timeline = openingTimeline();
    await saveGameTimeline(timeline);
    const raw = (await getRawCurrentRecord()) as {
      schemaVersion: 1;
      archive: string;
      savedAt: string;
    };
    const archive = JSON.parse(raw.archive) as Record<string, unknown>;
    archive.documentHash = "fnv1a64:0000000000000000";
    const corrupt = {
      ...raw,
      archive: JSON.stringify(archive),
    };
    await putRawCurrentRecord(corrupt);

    await expect(loadGameTimeline()).rejects.toMatchObject({
      name: "GameStoreError",
      code: "corrupt-record",
    });
    expect(await getRawCurrentRecord()).toEqual(corrupt);
  });

  it("reports unavailable IndexedDB consistently for load, save, and clear", async () => {
    installIndexedDb(undefined);
    const timeline = openingTimeline();

    for (const operation of [
      () => loadGameTimeline(),
      () => saveGameTimeline(timeline),
      () => clearSavedGame(),
    ]) {
      try {
        await operation();
        throw new Error("Expected IndexedDB operation to reject.");
      } catch (error) {
        expect(error).toBeInstanceOf(GameStoreError);
        const storeError = error as GameStoreError;
        expect(storeError.code).toBe("unavailable");
        expect(storeError.message).toContain("IndexedDB is unavailable");
      }
    }
  });

  it("exposes a typed storage error for callers", () => {
    const error = new GameStoreError("read-failed", "read failed");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GameStoreError");
    expect(error.code).toBe("read-failed");
  });
});
