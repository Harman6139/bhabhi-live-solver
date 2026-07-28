import { describe, expect, it } from "vitest";

import { fnv1a64 } from "../../src/events/stable-hash";

function referenceFnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, "0");
}

function generatedUnicodeFixture(seed: number): string {
  let state = seed >>> 0;
  const codePoints: number[] = [];
  const length = seed % 97;

  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const bucket = state % 4;
    if (bucket === 0) {
      codePoints.push(0x20 + (state % 0x5f));
    } else if (bucket === 1) {
      codePoints.push(0x80 + (state % 0x780));
    } else if (bucket === 2) {
      codePoints.push(0x800 + (state % 0x7800));
    } else {
      codePoints.push(0x1_0000 + (state % 0xf_0000));
    }
  }

  return String.fromCodePoint(...codePoints);
}

describe("fnv1a64", () => {
  it("preserves the standard empty and ASCII vectors", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64("foobar")).toBe("85944171f73967e8");
  });

  it("matches the BigInt reference bit-for-bit across UTF-8 inputs", () => {
    const fixed = [
      "\u0000",
      "Bhabhi / Getaway",
      "é",
      "नमस्ते",
      "🂡🂢🂣",
      "a".repeat(8_193),
    ];

    for (const text of fixed) {
      expect(fnv1a64(text)).toBe(referenceFnv1a64(text));
    }
    for (let seed = 0; seed < 256; seed += 1) {
      const text = generatedUnicodeFixture(seed);
      expect(fnv1a64(text)).toBe(referenceFnv1a64(text));
    }
  });
});
