import { z } from "zod";

import {
  parseProductionAnalysis,
  productionAnalysisSchema,
  type ProductionAnalysis,
} from "../production/analysis-result";
import { productionRoleIdSchema } from "../production/roles";
import { SOLVER_BUDGET_IDS } from "../search/types";

export const ANALYSIS_WORKER_PROTOCOL_VERSION =
  "analysis-worker-protocol-v2" as const;
export const MAX_ANALYSIS_ARCHIVE_BYTES = 2 * 1024 * 1024;

const identifierSchema = z.string().trim().min(1).max(512);
const stableHashSchema = z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const seedSetSchema = z
  .object({
    belief: identifierSchema.optional(),
    search: identifierSchema.optional(),
    rollout: identifierSchema.optional(),
    chance: identifierSchema.optional(),
    bootstrap: identifierSchema.optional(),
  })
  .strict();

export const analysisBindingSchema = z
  .object({
    bundleMode: z.enum(["evaluation-only", "release-selected"]),
    manifestScope: z.enum(["qualification", "final"]),
    manifestHash: sha256Schema,
    sourceHash: sha256Schema,
    solverConfigHash: sha256Schema,
    modelHash: sha256Schema,
    protocolHash: sha256Schema,
    selectedConfigId: productionRoleIdSchema,
    selectionAttestationHash: sha256Schema.nullable(),
    finalAttestationHash: sha256Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const selected = value.bundleMode === "release-selected";
    if (
      (selected &&
        (value.manifestScope !== "final" ||
          value.selectionAttestationHash === null ||
          value.finalAttestationHash === null)) ||
      (!selected &&
        (value.selectionAttestationHash !== null ||
          value.finalAttestationHash !== null))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Worker binding mode, scope, and attestations are inconsistent.",
      });
    }
  });
export type AnalysisBinding = z.infer<typeof analysisBindingSchema>;

export const analysisWorkerRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    protocolVersion: z.literal(ANALYSIS_WORKER_PROTOCOL_VERSION),
    type: z.literal("analyze"),
    requestId: stableHashSchema,
    requestOrdinal: nonnegativeIntegerSchema,
    sessionEpoch: nonnegativeIntegerSchema,
    stateVersion: nonnegativeIntegerSchema,
    historyHash: stableHashSchema,
    publicStateHash: stableHashSchema,
    budgetId: z.enum(SOLVER_BUDGET_IDS),
    timelineArchive: z.string().min(1).max(MAX_ANALYSIS_ARCHIVE_BYTES),
    seeds: seedSetSchema,
    binding: analysisBindingSchema,
  })
  .strict();
export type AnalysisWorkerRequest = z.infer<typeof analysisWorkerRequestSchema>;

export const ANALYSIS_WORKER_FAILURE_CODES = [
  "INVALID_ENVELOPE",
  "STALE_REQUEST",
  "RELEASE_UNAVAILABLE",
  "RELEASE_BINDING_MISMATCH",
  "INVALID_RELEASE",
  "CONFIGURATION_REFUSED",
  "SEARCH_FAILURE",
  "INTERNAL_FAILURE",
] as const;
export type AnalysisWorkerFailureCode =
  (typeof ANALYSIS_WORKER_FAILURE_CODES)[number];

const responseIdentitySchema = z
  .object({
    schemaVersion: z.literal(2),
    protocolVersion: z.literal(ANALYSIS_WORKER_PROTOCOL_VERSION),
    requestId: stableHashSchema,
    requestOrdinal: nonnegativeIntegerSchema,
    sessionEpoch: nonnegativeIntegerSchema,
    stateVersion: nonnegativeIntegerSchema,
    historyHash: stableHashSchema,
    publicStateHash: stableHashSchema,
    binding: analysisBindingSchema,
  })
  .strict();

export const analysisWorkerFailureSchema = responseIdentitySchema
  .extend({
    type: z.literal("failure"),
    code: z.enum(ANALYSIS_WORKER_FAILURE_CODES),
    message: z.string().min(1).max(4_096),
    searchCode: z.string().min(1).max(128).nullable(),
  })
  .strict();
export type AnalysisWorkerFailure = z.infer<typeof analysisWorkerFailureSchema>;

export const analysisWorkerSuccessSchema = responseIdentitySchema
  .extend({
    type: z.literal("success"),
    result: productionAnalysisSchema,
  })
  .strict();
export type AnalysisWorkerSuccess = Omit<
  z.infer<typeof analysisWorkerSuccessSchema>,
  "result"
> & {
  readonly result: ProductionAnalysis & {
    /**
     * Non-enumerable migration alias for the Phase 8 latency harness. It is
     * not part of the wire schema or persisted ProductionAnalysis contract.
     */
    readonly payload: ProductionAnalysis;
  };
};

export type AnalysisWorkerResponse =
  AnalysisWorkerFailure | AnalysisWorkerSuccess;

export function parseAnalysisWorkerRequest(
  value: unknown,
): AnalysisWorkerRequest {
  return analysisWorkerRequestSchema.parse(value);
}

export function parseAnalysisWorkerResponse(
  value: unknown,
): AnalysisWorkerResponse {
  const type =
    typeof value === "object" && value !== null && "type" in value
      ? (value as { readonly type?: unknown }).type
      : undefined;
  if (type === "failure") {
    return analysisWorkerFailureSchema.parse(value);
  }
  const parsed = analysisWorkerSuccessSchema.parse(value);
  const result = parseProductionAnalysis(
    parsed.result,
  ) as ProductionAnalysis & {
    readonly payload: ProductionAnalysis;
  };
  if (
    result.identity.stateVersion !== parsed.stateVersion ||
    result.identity.historyHash !== parsed.historyHash ||
    result.identity.publicStateHash !== parsed.publicStateHash ||
    result.release.sourceHash !== parsed.binding.sourceHash ||
    result.release.solverConfigHash !== parsed.binding.solverConfigHash ||
    result.release.modelHash !== parsed.binding.modelHash ||
    result.release.protocolHash !== parsed.binding.protocolHash ||
    result.release.bundleMode !== parsed.binding.bundleMode ||
    result.release.manifestScope !== parsed.binding.manifestScope ||
    result.release.manifestHash !== parsed.binding.manifestHash ||
    result.release.selectedConfigId !== parsed.binding.selectedConfigId ||
    result.release.selectionAttestationHash !==
      parsed.binding.selectionAttestationHash ||
    result.release.finalAttestationHash !== parsed.binding.finalAttestationHash
  ) {
    throw new TypeError(
      "Successful worker response result does not match its public identity and release binding.",
    );
  }
  Object.defineProperty(result, "payload", {
    configurable: false,
    enumerable: false,
    get: () => result,
  });
  return { ...parsed, result };
}

/**
 * Backwards-compatible name with v2 semantics: the entire success payload is
 * validated, not merely its outer identity.
 */
export const parseAnalysisWorkerResponseIdentity = parseAnalysisWorkerResponse;
