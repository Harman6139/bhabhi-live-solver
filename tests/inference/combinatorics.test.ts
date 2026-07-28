import { describe, expect, it, vi } from "vitest";

import {
  OWNER_BOTH,
  OWNER_NONE,
  OWNER_P2,
  OWNER_P3,
  binomial,
  countOwnerAssignments,
  deterministicRank,
  rankCombination,
  unrankCombination,
  type OwnerMask,
} from "../../src/inference/combinatorics";

function popcount(value: number): number {
  let remaining = value;
  let count = 0;
  while (remaining > 0) {
    count += remaining & 1;
    remaining >>>= 1;
  }
  return count;
}

function oracleBinomial(n: number, k: number): bigint {
  let count = 0n;
  for (let subset = 0; subset < 2 ** n; subset += 1) {
    if (popcount(subset) === k) {
      count += 1n;
    }
  }
  return count;
}

function masksFromBaseFour(value: number, length: number): OwnerMask[] {
  const masks: OwnerMask[] = [];
  let remaining = value;
  for (let index = 0; index < length; index += 1) {
    masks.push((remaining % 4) as OwnerMask);
    remaining = Math.floor(remaining / 4);
  }
  return masks;
}

function oracleOwnerAssignments(
  masks: readonly OwnerMask[],
  p2Slots: number,
): bigint {
  if (p2Slots < 0 || p2Slots > masks.length) {
    return 0n;
  }

  let count = 0n;
  for (let assignment = 0; assignment < 2 ** masks.length; assignment += 1) {
    if (popcount(assignment) !== p2Slots) {
      continue;
    }

    const allowed = masks.every((mask, index) => {
      const owner = (assignment & (1 << index)) === 0 ? OWNER_P3 : OWNER_P2;
      return (mask & owner) !== 0;
    });
    if (allowed) {
      count += 1n;
    }
  }
  return count;
}

function combinations(n: number, k: number): number[][] {
  const result: number[][] = [];

  function visit(prefix: number[], next: number): void {
    if (prefix.length === k) {
      result.push(prefix);
      return;
    }

    const remaining = k - prefix.length - 1;
    for (let value = next; value <= n - remaining - 1; value += 1) {
      visit([...prefix, value], value + 1);
    }
  }

  visit([], 0);
  return result;
}

describe("binomial", () => {
  it("matches an exhaustive subset oracle for small dimensions", () => {
    for (let n = 0; n <= 10; n += 1) {
      for (let k = 0; k <= n; k += 1) {
        expect(binomial(n, k), `C(${n}, ${k})`).toBe(oracleBinomial(n, k));
      }
      expect(binomial(n, n + 1)).toBe(0n);
    }
  });

  it("counts the two largest ordinary three-player unknown splits", () => {
    expect(binomial(34, 17)).toBe(2_333_606_220n);
    expect(binomial(35, 18)).toBe(4_537_567_650n);
  });

  it("rejects malformed dimensions", () => {
    expect(() => binomial(-1, 0)).toThrow(/nonnegative/i);
    expect(() => binomial(3, -1)).toThrow(/nonnegative/i);
    expect(() => binomial(3.5, 1)).toThrow(/safe integer/i);
  });
});

describe("countOwnerAssignments", () => {
  it("matches exhaustive owner assignment enumeration for every small mask", () => {
    for (let length = 0; length <= 5; length += 1) {
      for (let encoded = 0; encoded < 4 ** length; encoded += 1) {
        const masks = masksFromBaseFour(encoded, length);
        for (let p2Slots = -1; p2Slots <= length + 1; p2Slots += 1) {
          expect(
            countOwnerAssignments(masks, p2Slots),
            `masks=${masks.join(",")} p2Slots=${p2Slots}`,
          ).toBe(oracleOwnerAssignments(masks, p2Slots));
        }
      }
    }
  });

  it("returns zero for impossible masks and hand capacities", () => {
    expect(countOwnerAssignments([OWNER_NONE], 0)).toBe(0n);
    expect(countOwnerAssignments([OWNER_NONE], 1)).toBe(0n);
    expect(countOwnerAssignments([OWNER_P2, OWNER_P2], 1)).toBe(0n);
    expect(countOwnerAssignments([OWNER_P3, OWNER_P3], 1)).toBe(0n);
    expect(countOwnerAssignments([OWNER_BOTH], -1)).toBe(0n);
    expect(countOwnerAssignments([OWNER_BOTH], 2)).toBe(0n);
  });

  it("counts only the flexible cards after forced ownership", () => {
    const masks: OwnerMask[] = [
      OWNER_P2,
      OWNER_P3,
      OWNER_BOTH,
      OWNER_BOTH,
      OWNER_BOTH,
      OWNER_BOTH,
    ];
    expect(countOwnerAssignments(masks, 3)).toBe(binomial(4, 2));
  });

  it("rejects malformed runtime values", () => {
    expect(() => countOwnerAssignments([4 as OwnerMask], 1)).toThrow(
      /owner mask/i,
    );
    expect(() => countOwnerAssignments([OWNER_BOTH], Number.NaN)).toThrow(
      /safe integer/i,
    );
  });
});

describe("lexicographic combination rank and unrank", () => {
  it("is a bijection over every small combination", () => {
    for (let n = 0; n <= 9; n += 1) {
      for (let k = 0; k <= n; k += 1) {
        const ordered = combinations(n, k);
        expect(BigInt(ordered.length)).toBe(binomial(n, k));

        ordered.forEach((combination, expectedRank) => {
          const rank = BigInt(expectedRank);
          expect(rankCombination(n, k, combination)).toBe(rank);
          expect(unrankCombination(n, k, rank)).toEqual(combination);
        });
      }
    }
  });

  it("uses ordinary lexicographic rather than colexicographic order", () => {
    expect(combinations(5, 3)).toEqual([
      [0, 1, 2],
      [0, 1, 3],
      [0, 1, 4],
      [0, 2, 3],
      [0, 2, 4],
      [0, 3, 4],
      [1, 2, 3],
      [1, 2, 4],
      [1, 3, 4],
      [2, 3, 4],
    ]);
    expect(rankCombination(5, 3, [0, 2, 3])).toBe(3n);
    expect(unrankCombination(5, 3, 3n)).toEqual([0, 2, 3]);
  });

  it("rejects malformed combinations and ranks", () => {
    expect(() => rankCombination(5, 2, [0])).toThrow(/exactly 2/i);
    expect(() => rankCombination(5, 2, [1, 1])).toThrow(/ascending/i);
    expect(() => rankCombination(5, 2, [0, 5])).toThrow(/ascending/i);
    expect(() => unrankCombination(5, 2, -1n)).toThrow(/rank/i);
    expect(() => unrankCombination(5, 2, binomial(5, 2))).toThrow(/rank/i);
    expect(() => unrankCombination(2, 3, 0n)).toThrow(/exceed/i);
  });
});

describe("deterministicRank", () => {
  it("is repeatable, index-addressable, and never calls Math.random", () => {
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random must not be used");
    });

    const first = Array.from({ length: 32 }, (_, sampleIndex) =>
      deterministicRank("deal:fixed-seed", sampleIndex, 4_537_567_650n),
    );
    const second = Array.from({ length: 32 }, (_, sampleIndex) =>
      deterministicRank("deal:fixed-seed", sampleIndex, 4_537_567_650n),
    );

    expect(second).toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(24);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it("stays within every supported bound", () => {
    const bounds = [1n, 2n, 3n, 17n, 2_333_606_220n, 4_537_567_650n, 1n << 64n];

    for (const bound of bounds) {
      for (let sampleIndex = 0; sampleIndex < 256; sampleIndex += 1) {
        const rank = deterministicRank(
          "deterministic bounds â™ ",
          sampleIndex,
          bound,
        );
        expect(rank).toBeGreaterThanOrEqual(0n);
        expect(rank).toBeLessThan(bound);
      }
    }
    expect(deterministicRank("anything", 0, 1n)).toBe(0n);
  });

  it("rejects unsupported seed, index, and rank bounds", () => {
    expect(() => deterministicRank("seed", -1, 2n)).toThrow(/nonnegative/i);
    expect(() => deterministicRank("seed", 0.5, 2n)).toThrow(/safe integer/i);
    expect(() => deterministicRank("seed", 0, 0n)).toThrow(/upperExclusive/i);
    expect(() => deterministicRank("seed", 0, (1n << 64n) + 1n)).toThrow(
      /upperExclusive/i,
    );
  });
});
