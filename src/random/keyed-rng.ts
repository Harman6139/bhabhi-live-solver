/**
 * The deterministic, counter-based pseudo-random number generator.
 *
 * The implementation is deliberately small and versioned. It uses the
 * SplitMix64 finalizer over a stream key plus a counter. It is suitable for
 * simulation and reproducible experiments, but it is not cryptographically
 * secure.
 */

export const RNG_ALGORITHM = "splitmix64-counter-v1" as const;

export type SeedInput = string | number | bigint;
export type StreamKey = string | number | bigint;

export type NormalizedSeed = {
  readonly algorithm: typeof RNG_ALGORITHM;
  readonly canonical: string;
  readonly id: string;
  readonly keyHex: string;
};

export type RngSnapshot = {
  readonly schemaVersion: 1;
  readonly algorithm: typeof RNG_ALGORITHM;
  readonly seedId: string;
  readonly rootKeyHex: string;
  readonly streamPath: readonly string[];
  readonly streamId: string;
  readonly counter: string;
};

export type SeededRng = {
  readonly algorithm: typeof RNG_ALGORITHM;
  readonly seedId: string;
  readonly streamId: string;
  readonly counter: bigint;

  /**
   * Return the value at an absolute stream counter without advancing it.
   * Counter zero is the first value returned by nextUint64().
   */
  uint64At(counter: number | bigint): bigint;
  nextUint64(): bigint;
  nextUint32(): number;
  nextFloat(): number;
  nextBigInt(maxExclusive: bigint): bigint;
  nextInt(maxExclusive: number): number;
  pick<T>(values: readonly T[]): T;
  shuffle<T>(values: readonly T[]): T[];
  shuffleInPlace(values: unknown[]): void;

  /**
   * Create a fresh keyed stream. Forking never consumes this stream and is
   * independent of its current counter.
   */
  fork(key: StreamKey, ...additionalKeys: readonly StreamKey[]): SeededRng;
  clone(): SeededRng;
  advance(draws: number | bigint): void;
  snapshot(): RngSnapshot;
};

export type SimulationRngStreams = {
  /** Root for any additional simulation-specific streams. */
  readonly root: SeededRng;
  readonly deal: SeededRng;
  readonly policy: Readonly<{
    user: SeededRng;
    p2: SeededRng;
    p3: SeededRng;
  }>;
  readonly chance: SeededRng;
};

const MASK_64 = (1n << 64n) - 1n;
const RANGE_64 = 1n << 64n;
const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n;
const MIX_MULTIPLIER_1 = 0xbf58476d1ce4e5b9n;
const MIX_MULTIPLIER_2 = 0x94d049bb133111ebn;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FLOAT_DENOMINATOR = 9_007_199_254_740_992;
const HEX_64 = /^[0-9a-f]{16}$/u;
const DECIMAL_COUNTER = /^(0|[1-9][0-9]*)$/u;

const textEncoder = new TextEncoder();

function mix64(input: bigint): bigint {
  let value = input & MASK_64;
  value = ((value ^ (value >> 30n)) * MIX_MULTIPLIER_1) & MASK_64;
  value = ((value ^ (value >> 27n)) * MIX_MULTIPLIER_2) & MASK_64;
  return (value ^ (value >> 31n)) & MASK_64;
}

function hashText(value: string): bigint {
  let hash = FNV_OFFSET;
  for (const byte of textEncoder.encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return mix64(hash);
}

function toHex64(value: bigint): string {
  return (value & MASK_64).toString(16).padStart(16, "0");
}

function canonicalInteger(value: number | bigint): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        "Numeric seeds and stream keys must be safe integers.",
      );
    }
    return `integer:${Object.is(value, -0) ? "0" : value.toString(10)}`;
  }
  return `integer:${value.toString(10)}`;
}

function canonicalSeed(seed: SeedInput): string {
  if (typeof seed === "string") {
    return `string:${textEncoder.encode(seed).length}:${seed}`;
  }
  return canonicalInteger(seed);
}

function canonicalStreamKey(key: StreamKey): string {
  if (typeof key === "string") {
    return `string:${textEncoder.encode(key).length}:${key}`;
  }
  return canonicalInteger(key);
}

function normalizeCounter(
  counter: number | bigint,
  label: string,
  allowExhausted = false,
): bigint {
  let normalized: bigint;
  if (typeof counter === "number") {
    if (!Number.isSafeInteger(counter)) {
      throw new RangeError(`${label} must be a safe integer.`);
    }
    normalized = BigInt(counter);
  } else {
    normalized = counter;
  }
  const maximum = allowExhausted ? RANGE_64 : MASK_64;
  if (normalized < 0n || normalized > maximum) {
    throw new RangeError(
      `${label} must be between 0 and ${maximum.toString(10)}.`,
    );
  }
  return normalized;
}

function deriveStreamKey(
  rootKey: bigint,
  canonicalPath: readonly string[],
): bigint {
  if (canonicalPath.length === 0) {
    return rootKey;
  }
  let material = `root:${toHex64(rootKey)}`;
  for (const segment of canonicalPath) {
    const byteLength = textEncoder.encode(segment).length;
    material += `|${byteLength}:${segment}`;
  }
  return hashText(material);
}

function makeSeedId(rootKey: bigint): string {
  return `${RNG_ALGORITHM}:${toHex64(rootKey)}`;
}

function makeStreamId(rootKey: bigint, streamKey: bigint): string {
  return `${makeSeedId(rootKey)}/stream:${toHex64(streamKey)}`;
}

export function normalizeSeed(seed: SeedInput): NormalizedSeed {
  const canonical = canonicalSeed(seed);
  const rootKey = hashText(`seed:${canonical}`);
  return {
    algorithm: RNG_ALGORITHM,
    canonical,
    id: makeSeedId(rootKey),
    keyHex: toHex64(rootKey),
  };
}

class SplitMixCounterRng implements SeededRng {
  readonly algorithm = RNG_ALGORITHM;
  readonly seedId: string;
  readonly streamId: string;

  readonly #rootKey: bigint;
  readonly #streamKey: bigint;
  readonly #canonicalPath: readonly string[];
  #counter: bigint;

  constructor(rootKey: bigint, canonicalPath: readonly string[], counter = 0n) {
    this.#rootKey = rootKey & MASK_64;
    this.#canonicalPath = Object.freeze([...canonicalPath]);
    this.#streamKey = deriveStreamKey(this.#rootKey, this.#canonicalPath);
    this.#counter = normalizeCounter(counter, "RNG counter", true);
    this.seedId = makeSeedId(this.#rootKey);
    this.streamId = makeStreamId(this.#rootKey, this.#streamKey);
  }

  get counter(): bigint {
    return this.#counter;
  }

  uint64At(counter: number | bigint): bigint {
    const normalized = normalizeCounter(counter, "RNG counter");
    const position = this.#streamKey + SPLITMIX_GAMMA * (normalized + 1n);
    return mix64(position);
  }

  nextUint64(): bigint {
    if (this.#counter === RANGE_64) {
      throw new RangeError(
        "RNG stream is exhausted after 2^64 generated values.",
      );
    }
    const result = this.uint64At(this.#counter);
    this.#counter += 1n;
    return result;
  }

  nextUint32(): number {
    return Number(this.nextUint64() >> 32n);
  }

  nextFloat(): number {
    return Number(this.nextUint64() >> 11n) / FLOAT_DENOMINATOR;
  }

  nextBigInt(maxExclusive: bigint): bigint {
    if (maxExclusive <= 0n || maxExclusive > RANGE_64) {
      throw new RangeError(
        "maxExclusive must be between 1 and 2^64 for nextBigInt().",
      );
    }
    const rejectionCeiling = RANGE_64 - (RANGE_64 % maxExclusive);
    for (;;) {
      const candidate = this.nextUint64();
      if (candidate < rejectionCeiling) {
        return candidate % maxExclusive;
      }
    }
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(
        "maxExclusive must be a positive safe integer for nextInt().",
      );
    }
    return Number(this.nextBigInt(BigInt(maxExclusive)));
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new RangeError("Cannot pick from an empty collection.");
    }
    return values[this.nextInt(values.length)] as T;
  }

  shuffle<T>(values: readonly T[]): T[] {
    const result = [...values];
    this.shuffleInPlace(result);
    return result;
  }

  shuffleInPlace(values: unknown[]): void {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const otherIndex = this.nextInt(index + 1);
      const current = values[index];
      values[index] = values[otherIndex];
      values[otherIndex] = current;
    }
  }

  fork(key: StreamKey, ...additionalKeys: readonly StreamKey[]): SeededRng {
    const childPath = [
      ...this.#canonicalPath,
      canonicalStreamKey(key),
      ...additionalKeys.map(canonicalStreamKey),
    ];
    return new SplitMixCounterRng(this.#rootKey, childPath);
  }

  clone(): SeededRng {
    return new SplitMixCounterRng(
      this.#rootKey,
      this.#canonicalPath,
      this.#counter,
    );
  }

  advance(draws: number | bigint): void {
    const normalized = normalizeCounter(draws, "Advance count", true);
    const nextCounter = this.#counter + normalized;
    if (nextCounter > RANGE_64) {
      throw new RangeError("Advance would exhaust the RNG stream.");
    }
    this.#counter = nextCounter;
  }

  snapshot(): RngSnapshot {
    return {
      schemaVersion: 1,
      algorithm: RNG_ALGORITHM,
      seedId: this.seedId,
      rootKeyHex: toHex64(this.#rootKey),
      streamPath: [...this.#canonicalPath],
      streamId: this.streamId,
      counter: this.#counter.toString(10),
    };
  }
}

export function createSeededRng(
  seed: SeedInput,
  streamPath: readonly StreamKey[] = [],
): SeededRng {
  const normalized = normalizeSeed(seed);
  const rootKey = BigInt(`0x${normalized.keyHex}`);
  return new SplitMixCounterRng(rootKey, streamPath.map(canonicalStreamKey));
}

export function restoreSeededRng(snapshotValue: unknown): SeededRng {
  if (
    typeof snapshotValue !== "object" ||
    snapshotValue === null ||
    Array.isArray(snapshotValue)
  ) {
    throw new TypeError("RNG snapshot must be an object.");
  }
  const snapshot = snapshotValue as Record<string, unknown>;
  if (snapshot.schemaVersion !== 1 || snapshot.algorithm !== RNG_ALGORITHM) {
    throw new TypeError("Unsupported RNG snapshot schema or algorithm.");
  }
  if (
    typeof snapshot.rootKeyHex !== "string" ||
    !HEX_64.test(snapshot.rootKeyHex)
  ) {
    throw new TypeError(
      "RNG snapshot rootKeyHex must be 16 lowercase hex digits.",
    );
  }
  if (
    typeof snapshot.counter !== "string" ||
    !DECIMAL_COUNTER.test(snapshot.counter)
  ) {
    throw new TypeError(
      "RNG snapshot counter must be an unsigned decimal integer.",
    );
  }
  if (
    !Array.isArray(snapshot.streamPath) ||
    !snapshot.streamPath.every((segment) => typeof segment === "string")
  ) {
    throw new TypeError("RNG snapshot streamPath must contain only strings.");
  }
  if (
    typeof snapshot.seedId !== "string" ||
    typeof snapshot.streamId !== "string"
  ) {
    throw new TypeError("RNG snapshot identifiers must be strings.");
  }

  const rootKey = BigInt(`0x${snapshot.rootKeyHex}`);
  const streamPath: string[] = snapshot.streamPath;
  const restored = new SplitMixCounterRng(
    rootKey,
    streamPath,
    normalizeCounter(BigInt(snapshot.counter), "RNG counter", true),
  );
  if (
    restored.seedId !== snapshot.seedId ||
    restored.streamId !== snapshot.streamId
  ) {
    throw new TypeError("RNG snapshot identifiers do not match its contents.");
  }
  return restored;
}

/**
 * Create the standard independent streams used by a complete simulation.
 *
 * Supplying a game key permits stable batches: game N is unchanged by work
 * performed for any other game.
 */
export function createSimulationRngStreams(
  seed: SeedInput,
  gameKey?: StreamKey,
): SimulationRngStreams {
  const seedRoot = createSeededRng(seed);
  const root =
    gameKey === undefined
      ? seedRoot.fork("simulation")
      : seedRoot.fork("simulation", "game", gameKey);
  return {
    root,
    deal: root.fork("deal"),
    policy: Object.freeze({
      user: root.fork("policy", "user"),
      p2: root.fork("policy", "p2"),
      p3: root.fork("policy", "p3"),
    }),
    chance: root.fork("chance"),
  };
}
