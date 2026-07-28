export type HardInferenceErrorCode =
  | "INVALID_PUBLIC_HISTORY"
  | "NO_VALID_WORLDS"
  | "INVARIANT_VIOLATION"
  | "INVALID_CONFIG";

export class HardInferenceError extends Error {
  public readonly code: HardInferenceErrorCode;
  public readonly eventIndex: number | null;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: HardInferenceErrorCode,
    message: string,
    options?: {
      readonly eventIndex?: number | null;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "HardInferenceError";
    this.code = code;
    this.eventIndex = options?.eventIndex ?? null;
    this.details = options?.details ?? {};
  }
}
