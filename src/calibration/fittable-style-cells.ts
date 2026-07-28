/**
 * Browser-safe frozen model-fitting cell IDs. Keep this module free of the
 * Node-only seed derivation used by the offline evaluation protocol.
 */
export const FITTABLE_STYLE_CELL_IDS: readonly string[] = Object.freeze([
  "c01_random__random",
  "c02_always-high__always-high",
  "c03_always-low__always-low",
  "c04_shortest-suit__shortest-suit",
  "c05_early-high-shedder__early-high-shedder",
  "c06_power-avoider__power-avoider",
  "c07_documented-basic__documented-basic",
  "c08_always-high__always-low",
  "c09_always-low__always-high",
  "c10_shortest-suit__early-high-shedder",
  "c11_early-high-shedder__shortest-suit",
  "c12_power-avoider__documented-basic",
  "c13_documented-basic__power-avoider",
  "c14_random__documented-basic",
  "c15_documented-basic__random",
]);
