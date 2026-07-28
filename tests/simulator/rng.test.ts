import { describe, expect, it } from "vitest";

import * as keyedRng from "../../src/random/keyed-rng";
import * as compatibilityRng from "../../src/simulator/rng";
import {
  RNG_ALGORITHM,
  createSeededRng,
  createSimulationRngStreams,
  normalizeSeed,
  restoreSeededRng,
  type RngSnapshot,
} from "../../src/random/keyed-rng";

describe("module boundary", () => {
  it("keeps the simulator path as an exact runtime compatibility re-export", () => {
    expect(compatibilityRng).toEqual(keyedRng);
    expect(compatibilityRng.createSeededRng).toBe(keyedRng.createSeededRng);
  });
});

describe("seed normalization", () => {
  it("normalizes equivalent numeric seeds and distinguishes typed strings", () => {
    expect(normalizeSeed(42)).toEqual(normalizeSeed(42n));
    expect(normalizeSeed(-0)).toEqual(normalizeSeed(0n));
    expect(normalizeSeed("42").id).not.toBe(normalizeSeed(42).id);
    expect(normalizeSeed("é").canonical).toBe("string:2:é");
    expect(normalizeSeed("")).toMatchObject({
      algorithm: RNG_ALGORITHM,
      canonical: "string:0:",
    });
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects invalid numeric seed %s",
    (seed) => {
      expect(() => normalizeSeed(seed)).toThrow(RangeError);
    },
  );
});

describe("counter output", () => {
  it("matches a locked platform-stable answer vector", () => {
    const rng = createSeededRng("answer-vector");

    expect(normalizeSeed("answer-vector")).toMatchInlineSnapshot(`
      {
        "algorithm": "splitmix64-counter-v1",
        "canonical": "string:13:answer-vector",
        "id": "splitmix64-counter-v1:36494a6e68bd3bcc",
        "keyHex": "36494a6e68bd3bcc",
      }
    `);
    expect(
      Array.from({ length: 6 }, () =>
        rng.nextUint64().toString(16).padStart(16, "0"),
      ),
    ).toEqual([
      "41dc2658b3be85e5",
      "516966eead81fd70",
      "96805fdd5d33ab72",
      "2f37b866d7d78306",
      "e6d379d02909ad56",
      "39b486ff554df5e6",
    ]);
  });

  it("supports random access without advancing the stream", () => {
    const rng = createSeededRng(20260727);
    const third = rng.uint64At(2);

    expect(rng.counter).toBe(0n);
    expect(rng.nextUint64()).toBe(rng.uint64At(0));
    expect(rng.nextUint64()).toBe(rng.uint64At(1));
    expect(rng.nextUint64()).toBe(third);
    expect(rng.counter).toBe(3n);
  });

  it("clones and advances without changing the source stream", () => {
    const source = createSeededRng("clone");
    source.advance(7);
    const clone = source.clone();

    expect(clone.counter).toBe(7n);
    expect(clone.nextUint64()).toBe(source.nextUint64());
    clone.advance(10n);
    expect(clone.counter).toBe(18n);
    expect(source.counter).toBe(8n);
  });

  it("exposes 32-bit integers and half-open unit floats", () => {
    const integers = createSeededRng("uint32");
    const floats = createSeededRng("float");

    for (let index = 0; index < 1_000; index += 1) {
      const integer = integers.nextUint32();
      const float = floats.nextFloat();
      expect(Number.isInteger(integer)).toBe(true);
      expect(integer).toBeGreaterThanOrEqual(0);
      expect(integer).toBeLessThan(2 ** 32);
      expect(float).toBeGreaterThanOrEqual(0);
      expect(float).toBeLessThan(1);
    }
  });
});

describe("unbiased bounded values", () => {
  it("honors number and bigint boundaries", () => {
    const rng = createSeededRng("bounds");

    for (const bound of [1, 2, 3, 52, 65_537, Number.MAX_SAFE_INTEGER]) {
      for (let draw = 0; draw < 200; draw += 1) {
        const value = rng.nextInt(bound);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(bound);
      }
    }

    expect(createSeededRng("one").nextBigInt(1n)).toBe(0n);
    const fullWidth = createSeededRng("full-width").nextBigInt(1n << 64n);
    expect(fullWidth).toBeGreaterThanOrEqual(0n);
    expect(fullWidth).toBeLessThan(1n << 64n);
  });

  it("uses rejection sampling when a modulo would be biased", () => {
    const rng = createSeededRng("rejection-vector");
    const bound = (1n << 63n) + 1n;
    const ceiling = (1n << 64n) - ((1n << 64n) % bound);
    let expectedCounter = 0n;

    while (rng.uint64At(expectedCounter) >= ceiling) {
      expectedCounter += 1n;
    }
    const expected = rng.uint64At(expectedCounter) % bound;

    expect(rng.nextBigInt(bound)).toBe(expected);
    expect(rng.counter).toBe(expectedCounter + 1n);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects invalid integer bound %s",
    (bound) => {
      expect(() => createSeededRng(1).nextInt(bound)).toThrow(RangeError);
    },
  );

  it.each([0n, -1n, (1n << 64n) + 1n])(
    "rejects invalid bigint bound %s",
    (bound) => {
      expect(() => createSeededRng(1).nextBigInt(bound)).toThrow(RangeError);
    },
  );
});

describe("selection and Fisher-Yates shuffle", () => {
  it("returns a reproducible permutation without changing the input", () => {
    const input = ["a", "b", "c", "d", "e", "f", "g"];
    const first = createSeededRng("shuffle");
    const second = createSeededRng("shuffle");

    const shuffled = first.shuffle(input);
    expect(shuffled).toEqual(second.shuffle(input));
    expect(shuffled).not.toEqual(input);
    expect([...shuffled].sort()).toEqual(input);
    expect(input).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(first.counter).toBe(6n);
  });

  it("supports in-place shuffling, stable degenerate cases, and picking", () => {
    const rng = createSeededRng("collections");
    const values = [1, 2, 3, 4, 5];
    rng.shuffleInPlace(values);

    expect([...values].sort((left, right) => left - right)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    const beforeDegenerate = rng.counter;
    expect(rng.shuffle([])).toEqual([]);
    expect(rng.shuffle(["only"])).toEqual(["only"]);
    expect(rng.counter).toBe(beforeDegenerate);
    expect([1, 2, 3, 4, 5]).toContain(rng.pick([1, 2, 3, 4, 5]));
    expect(() => rng.pick([])).toThrow(RangeError);
  });
});

describe("keyed substreams", () => {
  it("forks independently of parent consumption and isolates sibling keys", () => {
    const root = createSeededRng("forks");
    const dealBefore = root.fork("deal");
    const dealVector = Array.from({ length: 8 }, () => dealBefore.nextUint64());

    for (let index = 0; index < 500; index += 1) {
      root.nextUint64();
    }
    const dealAfter = root.fork("deal");
    expect(Array.from({ length: 8 }, () => dealAfter.nextUint64())).toEqual(
      dealVector,
    );
    expect(root.fork("deal").streamId).not.toBe(root.fork("chance").streamId);
  });

  it("uses typed, composable path keys", () => {
    const root = createSeededRng("paths");

    expect(root.fork(1).streamId).toBe(root.fork(1n).streamId);
    expect(root.fork(1).streamId).not.toBe(root.fork("1").streamId);
    expect(root.fork("policy", "p2").streamId).toBe(
      root.fork("policy").fork("p2").streamId,
    );
  });

  it("provides isolated standard simulation streams per stable game key", () => {
    const first = createSimulationRngStreams("batch-seed", 17);
    const again = createSimulationRngStreams("batch-seed", 17n);
    const anotherGame = createSimulationRngStreams("batch-seed", 18);

    expect(first.deal.nextUint64()).toBe(again.deal.nextUint64());
    expect(first.policy.user.nextUint64()).toBe(again.policy.user.nextUint64());
    expect(first.chance.streamId).not.toBe(first.deal.streamId);
    expect(
      new Set(Object.values(first.policy).map((rng) => rng.streamId)).size,
    ).toBe(3);
    expect(first.deal.streamId).not.toBe(anotherGame.deal.streamId);

    const p2Control = createSimulationRngStreams("batch-seed", 17).policy.p2;
    for (let draw = 0; draw < 100; draw += 1) {
      first.deal.nextUint64();
      first.policy.user.nextUint64();
      first.chance.nextUint64();
    }
    expect(first.policy.p2.nextUint64()).toBe(p2Control.nextUint64());
  });
});

describe("snapshot and restore", () => {
  it("round-trips stream identity and counter", () => {
    const original = createSeededRng("snapshot")
      .fork("simulation", "game", 91)
      .fork("policy", "p3");
    original.advance(123);
    const snapshot = original.snapshot();
    const restored = restoreSeededRng(snapshot);

    expect(restored.snapshot()).toEqual(snapshot);
    expect(Array.from({ length: 20 }, () => restored.nextUint64())).toEqual(
      Array.from({ length: 20 }, () => original.nextUint64()),
    );
  });

  it("detects malformed and internally inconsistent snapshots", () => {
    const valid = createSeededRng("tamper").fork("chance").snapshot();
    const replace = (patch: Partial<RngSnapshot>): RngSnapshot => ({
      ...valid,
      ...patch,
    });

    expect(() => restoreSeededRng(replace({ rootKeyHex: "xyz" }))).toThrow(
      TypeError,
    );
    expect(() => restoreSeededRng(replace({ counter: "-1" }))).toThrow(
      TypeError,
    );
    expect(() =>
      restoreSeededRng(replace({ seedId: `${valid.seedId}-changed` })),
    ).toThrow(TypeError);
    expect(() =>
      restoreSeededRng(replace({ streamPath: ["string:6:chance", "x"] })),
    ).toThrow(TypeError);
  });

  it("enforces the finite 2^64 counter domain", () => {
    const base = createSeededRng("exhaustion").snapshot();
    const exhausted = restoreSeededRng({
      ...base,
      counter: (1n << 64n).toString(10),
    });

    expect(() => exhausted.nextUint64()).toThrow(RangeError);
    expect(() => createSeededRng(1).uint64At(1n << 64n)).toThrow(RangeError);
    expect(() => createSeededRng(1).advance(-1)).toThrow(RangeError);
  });
});
