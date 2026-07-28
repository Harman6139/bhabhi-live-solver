import {
  exportGameArchive,
  importGameArchive,
  type GameTimeline,
} from "../events/timeline";

export const GAME_STORE_DATABASE_NAME = "getaway-live-solver";
export const GAME_STORE_DATABASE_VERSION = 1;
export const GAME_STORE_OBJECT_STORE_NAME = "current-session";
export const GAME_STORE_CURRENT_KEY = "current";

type StoredGameRecordV1 = {
  readonly schemaVersion: 1;
  readonly archive: string;
  readonly savedAt: string;
};

export type GameStoreErrorCode =
  | "unavailable"
  | "open-failed"
  | "read-failed"
  | "write-failed"
  | "corrupt-record";

export class GameStoreError extends Error {
  public readonly code: GameStoreErrorCode;

  public constructor(
    code: GameStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GameStoreError";
    this.code = code;
  }
}

function indexedDbFactory(): IDBFactory {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (factory === undefined || typeof factory.open !== "function") {
    throw new GameStoreError(
      "unavailable",
      "IndexedDB is unavailable in this environment.",
    );
  }
  return factory;
}

function openDatabase(): Promise<IDBDatabase> {
  const factory = indexedDbFactory();
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(
        GAME_STORE_DATABASE_NAME,
        GAME_STORE_DATABASE_VERSION,
      );
    } catch (cause) {
      reject(
        new GameStoreError(
          "open-failed",
          "Could not open local game storage.",
          { cause },
        ),
      );
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(GAME_STORE_OBJECT_STORE_NAME)) {
        database.createObjectStore(GAME_STORE_OBJECT_STORE_NAME);
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        new GameStoreError(
          "open-failed",
          "Could not open local game storage.",
          { cause: request.error },
        ),
      );
    };
  });
}

async function withDatabase<T>(
  operation: (database: IDBDatabase) => Promise<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

function readCurrentRecord(database: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let request: IDBRequest<unknown>;
    try {
      const transaction = database.transaction(
        GAME_STORE_OBJECT_STORE_NAME,
        "readonly",
      );
      request = transaction
        .objectStore(GAME_STORE_OBJECT_STORE_NAME)
        .get(GAME_STORE_CURRENT_KEY);
    } catch (cause) {
      reject(
        new GameStoreError("read-failed", "Could not read the saved game.", {
          cause,
        }),
      );
      return;
    }

    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        new GameStoreError("read-failed", "Could not read the saved game.", {
          cause: request.error,
        }),
      );
    };
  });
}

function runWriteTransaction(
  database: IDBDatabase,
  operation: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(
        GAME_STORE_OBJECT_STORE_NAME,
        "readwrite",
      );
      operation(transaction.objectStore(GAME_STORE_OBJECT_STORE_NAME));
    } catch (cause) {
      reject(
        new GameStoreError("write-failed", "Could not update the saved game.", {
          cause,
        }),
      );
      return;
    }

    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(
        new GameStoreError("write-failed", "Could not update the saved game.", {
          cause: transaction.error,
        }),
      );
    };
    transaction.onabort = () => {
      reject(
        new GameStoreError("write-failed", "Could not update the saved game.", {
          cause: transaction.error,
        }),
      );
    };
  });
}

function parseStoredRecord(value: unknown): StoredGameRecordV1 {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as Record<string, unknown>).schemaVersion !== 1 ||
    typeof (value as Record<string, unknown>).archive !== "string" ||
    typeof (value as Record<string, unknown>).savedAt !== "string" ||
    !Number.isFinite(
      Date.parse((value as Record<string, unknown>).savedAt as string),
    )
  ) {
    throw new GameStoreError(
      "corrupt-record",
      "The saved-game record is malformed or has an unsupported version.",
    );
  }
  return value as StoredGameRecordV1;
}

export async function saveGameTimeline(timeline: GameTimeline): Promise<void> {
  const record: StoredGameRecordV1 = {
    schemaVersion: 1,
    archive: exportGameArchive(timeline),
    savedAt: new Date().toISOString(),
  };
  await withDatabase((database) =>
    runWriteTransaction(database, (store) => {
      store.put(record, GAME_STORE_CURRENT_KEY);
    }),
  );
}

export async function loadGameTimeline(): Promise<GameTimeline | null> {
  const value = await withDatabase(readCurrentRecord);
  if (value === undefined) {
    return null;
  }

  const record = parseStoredRecord(value);
  try {
    return importGameArchive(record.archive);
  } catch (cause) {
    throw new GameStoreError(
      "corrupt-record",
      "The saved game failed archive validation.",
      { cause },
    );
  }
}

export async function clearSavedGame(): Promise<void> {
  await withDatabase((database) =>
    runWriteTransaction(database, (store) => {
      store.delete(GAME_STORE_CURRENT_KEY);
    }),
  );
}
