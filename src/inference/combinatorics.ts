export const OWNER_NONE = 0 as const;
export const OWNER_P2 = 1 as const;
export const OWNER_P3 = 2 as const;
export const OWNER_BOTH = 3 as const;

/**
 * A bit mask describing the opponents that may own a card.
 *
 * Bit 0 is P2 and bit 1 is P3. Zero represents an impossible assignment.
 */
export type OwnerMask =
  typeof OWNER_NONE | typeof OWNER_P2 | typeof OWNER_P3 | typeof OWNER_BOTH;

const UINT64_SPACE = 1n << 64n;
const UINT64_MASK = UINT64_SPACE - 1n;
const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n;
const INDEX_SALT = 0xd1b54a32d192ed03n;
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer.`);
  }
}

function assertNonnegativeSafeInteger(value: number, name: string): void {
  assertSafeInteger(value, name);
  if (value < 0) {
    throw new RangeError(`${name} must be nonnegative.`);
  }
}

function assertOwnerMask(
  mask: number,
  index: number,
): asserts mask is OwnerMask {
  if (
    mask !== OWNER_NONE &&
    mask !== OWNER_P2 &&
    mask !== OWNER_P3 &&
    mask !== OWNER_BOTH
  ) {
    throw new RangeError(
      `Owner mask at index ${index} must be one of 0, 1, 2, or 3.`,
    );
  }
}

/**
 * Returns the exact binomial coefficient C(n, k).
 *
 * The mathematical out-of-range case k > n is zero. Negative or non-integral
 * inputs are programmer errors and are rejected.
 */
export function binomial(n: number, k: number): bigint {
  assertNonnegativeSafeInteger(n, "n");
  assertNonnegativeSafeInteger(k, "k");

  if (k > n) {
    return 0n;
  }

  const reducedK = Math.min(k, n - k);
  let result = 1n;
  for (let index = 1; index <= reducedK; index += 1) {
    result = (result * BigInt(n - reducedK + index)) / BigInt(index);
  }
  return result;
}

/**
 * Counts assignments satisfying one owner mask per card and an exact P2 hand
 * size. P3 receives every card not assigned to P2.
 *
 * Capacity contradictions and OWNER_NONE masks produce zero assignments.
 */
export function countOwnerAssignments(
  masks: readonly OwnerMask[],
  p2Slots: number,
): bigint {
  assertSafeInteger(p2Slots, "p2Slots");
  if (p2Slots < 0 || p2Slots > masks.length) {
    return 0n;
  }

  let forcedP2 = 0;
  let flexible = 0;

  for (const [index, mask] of masks.entries()) {
    assertOwnerMask(mask, index);
    if (mask === OWNER_NONE) {
      return 0n;
    }
    if (mask === OWNER_P2) {
      forcedP2 += 1;
    } else if (mask === OWNER_BOTH) {
      flexible += 1;
    }
  }

  const flexibleP2Slots = p2Slots - forcedP2;
  if (flexibleP2Slots < 0 || flexibleP2Slots > flexible) {
    return 0n;
  }

  return binomial(flexible, flexibleP2Slots);
}

function assertCombinationDimensions(n: number, k: number): void {
  assertNonnegativeSafeInteger(n, "n");
  assertNonnegativeSafeInteger(k, "k");
  if (k > n) {
    throw new RangeError("k must not exceed n.");
  }
}

/**
 * Returns the zero-based rank of an ascending k-combination in ordinary
 * lexicographic order.
 */
export function rankCombination(
  n: number,
  k: number,
  combination: readonly number[],
): bigint {
  assertCombinationDimensions(n, k);
  if (combination.length !== k) {
    throw new RangeError(`Combination must contain exactly ${k} indices.`);
  }

  let rank = 0n;
  let previous = -1;

  for (let position = 0; position < k; position += 1) {
    const value = combination[position];
    if (value === undefined || !Number.isSafeInteger(value)) {
      throw new RangeError(
        `Combination index at position ${position} must be a safe integer.`,
      );
    }

    const remaining = k - position - 1;
    const maximum = n - remaining - 1;
    if (value <= previous || value > maximum) {
      throw new RangeError(
        "Combination indices must be strictly ascending and in range.",
      );
    }

    for (let skipped = previous + 1; skipped < value; skipped += 1) {
      rank += binomial(n - skipped - 1, remaining);
    }
    previous = value;
  }

  return rank;
}

/**
 * Inverts rankCombination for the zero-based lexicographic rank.
 */
export function unrankCombination(
  n: number,
  k: number,
  rank: bigint,
): number[] {
  assertCombinationDimensions(n, k);
  if (typeof rank !== "bigint") {
    throw new TypeError("rank must be a bigint.");
  }

  const count = binomial(n, k);
  if (rank < 0n || rank >= count) {
    throw new RangeError(`rank must be in [0, ${count}).`);
  }

  const combination: number[] = [];
  let residual = rank;
  let previous = -1;

  for (let position = 0; position < k; position += 1) {
    const remaining = k - position - 1;
    const maximum = n - remaining - 1;
    let selected = -1;

    for (let candidate = previous + 1; candidate <= maximum; candidate += 1) {
      const blockSize = binomial(n - candidate - 1, remaining);
      if (residual < blockSize) {
        selected = candidate;
        break;
      }
      residual -= blockSize;
    }

    if (selected < 0) {
      throw new Error("Combination unranking invariant failed.");
    }
    combination.push(selected);
    previous = selected;
  }

  return combination;
}

function fnv1a64(text: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return hash;
}

function mix64(input: bigint): bigint {
  let value = input & UINT64_MASK;
  value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & UINT64_MASK;
  value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & UINT64_MASK;
  return (value ^ (value >> 31n)) & UINT64_MASK;
}

/**
 * Produces a reproducible rank below upperExclusive without modulo bias.
 *
 * Candidate words are generated by a 64-bit SplitMix-style permutation and
 * rejected above the largest multiple of upperExclusive below 2^64. The
 * game's complete hidden-world support is below that 64-bit ceiling.
 */
export function deterministicRank(
  seedMaterial: string,
  sampleIndex: number,
  upperExclusive: bigint,
): bigint {
  if (typeof seedMaterial !== "string") {
    throw new TypeError("seedMaterial must be a string.");
  }
  assertNonnegativeSafeInteger(sampleIndex, "sampleIndex");
  if (typeof upperExclusive !== "bigint") {
    throw new TypeError("upperExclusive must be a bigint.");
  }
  if (upperExclusive <= 0n || upperExclusive > UINT64_SPACE) {
    throw new RangeError(`upperExclusive must be in [1, ${UINT64_SPACE}].`);
  }

  const seed = fnv1a64(seedMaterial);
  const index = BigInt(sampleIndex);
  const base = mix64(seed ^ mix64((index + INDEX_SALT) & UINT64_MASK));
  const acceptanceLimit = UINT64_SPACE - (UINT64_SPACE % upperExclusive);

  for (let attempt = 0n; ; attempt += 1n) {
    const candidate = mix64(
      (base + SPLITMIX_GAMMA * (attempt + 1n)) & UINT64_MASK,
    );
    if (candidate < acceptanceLimit) {
      return candidate % upperExclusive;
    }
  }
}
