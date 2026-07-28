function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

const UTF8_ENCODER = new TextEncoder();
const FNV_OFFSET_HIGH = 0xcbf29ce4;
const FNV_OFFSET_LOW = 0x84222325;
const FNV_PRIME_LOW = 0x1b3;
const UINT32_RANGE = 0x1_0000_0000;

export function fnv1a64(text: string): string {
  let high = FNV_OFFSET_HIGH;
  let low = FNV_OFFSET_LOW;
  const bytes = UTF8_ENCODER.encode(text);

  for (const byte of bytes) {
    low = (low ^ byte) >>> 0;

    // FNV_PRIME = 2^40 + 0x1b3. Keeping the 64-bit value in two
    // unsigned 32-bit limbs avoids BigInt in this search-critical path.
    const lowProduct = low * FNV_PRIME_LOW;
    const carry = Math.floor(lowProduct / UINT32_RANGE);
    high =
      (Math.imul(high, FNV_PRIME_LOW) + carry + Math.imul(low, 0x100)) >>> 0;
    low = lowProduct >>> 0;
  }

  return `${high.toString(16).padStart(8, "0")}${low
    .toString(16)
    .padStart(8, "0")}`;
}

export function stableHash(value: unknown): string {
  return `fnv1a64:${fnv1a64(stableStringify(value))}`;
}
