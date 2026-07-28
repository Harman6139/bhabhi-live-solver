export const PHASE8_TERMINAL_SAMPLE_SIZE_MIN = 64 as const;
export const PHASE8_TERMINAL_SAMPLE_SIZE_MAX = 512 as const;
export const PHASE8_TERMINAL_SAMPLE_SIZE_BLOCK = 16 as const;
export const PHASE8_TERMINAL_SAMPLE_SIZE_INFLATION = 1.1 as const;
export const PHASE8_TERMINAL_SAMPLE_SIZE_Z = 1.96 as const;
export const PHASE8_TERMINAL_SAMPLE_SIZE_MARGIN = 0.01 as const;
export const PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_VERSION =
  "phase8-terminal-sample-size-v1" as const;
export const PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA =
  "clamp(64,512,roundUpTo16(1.10*(1.96*s/0.01)^2))" as const;
export const PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_CONTRACT = Object.freeze({
  version: PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_VERSION,
  formula: PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA,
  minimum: PHASE8_TERMINAL_SAMPLE_SIZE_MIN,
  maximum: PHASE8_TERMINAL_SAMPLE_SIZE_MAX,
  block: PHASE8_TERMINAL_SAMPLE_SIZE_BLOCK,
  inflation: PHASE8_TERMINAL_SAMPLE_SIZE_INFLATION,
  z: PHASE8_TERMINAL_SAMPLE_SIZE_Z,
  margin: PHASE8_TERMINAL_SAMPLE_SIZE_MARGIN,
});

export type Phase8TerminalSampleSize = {
  readonly maxPairedClusterStandardDeviation: number;
  readonly rawBaseCount: number;
  readonly blockRoundedBaseCount: number;
  readonly baseCount: number;
  readonly minimumApplied: boolean;
  readonly maximumApplied: boolean;
};

/**
 * Frozen Phase 8 terminal sizing rule:
 * clamp(64, 512, roundUpTo16(1.10 * (1.96 * s / 0.01)^2)).
 */
export function computePhase8TerminalSampleSize(
  maxPairedClusterStandardDeviation: number,
): Phase8TerminalSampleSize {
  if (
    !Number.isFinite(maxPairedClusterStandardDeviation) ||
    maxPairedClusterStandardDeviation < 0
  ) {
    throw new RangeError(
      "Maximum paired-cluster standard deviation must be finite and nonnegative.",
    );
  }
  const standardized =
    (PHASE8_TERMINAL_SAMPLE_SIZE_Z * maxPairedClusterStandardDeviation) /
    PHASE8_TERMINAL_SAMPLE_SIZE_MARGIN;
  const rawBaseCount =
    PHASE8_TERMINAL_SAMPLE_SIZE_INFLATION * standardized * standardized;
  const blockRoundedBaseCount =
    Math.ceil(rawBaseCount / PHASE8_TERMINAL_SAMPLE_SIZE_BLOCK) *
    PHASE8_TERMINAL_SAMPLE_SIZE_BLOCK;
  const baseCount = Math.min(
    PHASE8_TERMINAL_SAMPLE_SIZE_MAX,
    Math.max(PHASE8_TERMINAL_SAMPLE_SIZE_MIN, blockRoundedBaseCount),
  );
  return {
    maxPairedClusterStandardDeviation,
    rawBaseCount,
    blockRoundedBaseCount,
    baseCount,
    minimumApplied: blockRoundedBaseCount < PHASE8_TERMINAL_SAMPLE_SIZE_MIN,
    maximumApplied: blockRoundedBaseCount > PHASE8_TERMINAL_SAMPLE_SIZE_MAX,
  };
}
