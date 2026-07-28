import { stableHash, stableStringify } from "../events/stable-hash";
import { importGameArchive, replayTimeline } from "../events/timeline";
import { EMBEDDED_PRODUCTION_RELEASE_BUNDLE } from "../production/embedded-release";
import {
  ProductionReleaseError,
  verifyProductionReleaseBundle,
  type ProductionReleaseBundle,
  type VerifyProductionReleaseOptions,
} from "../production/release-contract";
import {
  analyzeSelectedProductionRole,
  ProductionSolverError,
} from "../production/solver";
import { SearchError, type SolverSeedSet } from "../search/types";
import {
  ANALYSIS_WORKER_PROTOCOL_VERSION,
  analysisBindingSchema,
  analysisWorkerFailureSchema,
  analysisWorkerSuccessSchema,
  parseAnalysisWorkerRequest,
  parseAnalysisWorkerResponse,
  type AnalysisBinding,
  type AnalysisWorkerFailure,
  type AnalysisWorkerRequest,
  type AnalysisWorkerResponse,
} from "./analysis-protocol";

const INVALID_STABLE_HASH = "fnv1a64:0000000000000000";
const INVALID_SHA256 = "0".repeat(64);
const INVALID_BINDING: AnalysisBinding = {
  bundleMode: "evaluation-only",
  manifestScope: "qualification",
  manifestHash: INVALID_SHA256,
  sourceHash: INVALID_SHA256,
  solverConfigHash: INVALID_SHA256,
  modelHash: INVALID_SHA256,
  protocolHash: INVALID_SHA256,
  selectedConfigId: "p8-r-hard-balanced-v1",
  selectionAttestationHash: null,
  finalAttestationHash: null,
};

function validStableHash(value: unknown): string {
  return typeof value === "string" && /^fnv1a64:[0-9a-f]{16}$/u.test(value)
    ? value
    : INVALID_STABLE_HASH;
}

function validNonnegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function failureIdentity(input: {
  readonly requestId?: unknown;
  readonly requestOrdinal?: unknown;
  readonly sessionEpoch?: unknown;
  readonly stateVersion?: unknown;
  readonly historyHash?: unknown;
  readonly publicStateHash?: unknown;
  readonly binding?: unknown;
}): Omit<AnalysisWorkerFailure, "type" | "code" | "message" | "searchCode"> {
  const binding = analysisBindingSchema.safeParse(input.binding);
  return {
    schemaVersion: 2,
    protocolVersion: ANALYSIS_WORKER_PROTOCOL_VERSION,
    requestId: validStableHash(input.requestId),
    requestOrdinal: validNonnegativeInteger(input.requestOrdinal),
    sessionEpoch: validNonnegativeInteger(input.sessionEpoch),
    stateVersion: validNonnegativeInteger(input.stateVersion),
    historyHash: validStableHash(input.historyHash),
    publicStateHash: validStableHash(input.publicStateHash),
    binding: binding.success ? binding.data : INVALID_BINDING,
  };
}

function boundedMessage(value: string): string {
  return value.slice(0, 4_096);
}

function failure(
  request: AnalysisWorkerRequest,
  code: AnalysisWorkerFailure["code"],
  message: string,
  searchCode: string | null = null,
): AnalysisWorkerFailure {
  return analysisWorkerFailureSchema.parse({
    ...failureIdentity(request),
    type: "failure",
    code,
    message: boundedMessage(message),
    searchCode,
  });
}

function invalidEnvelope(
  value: unknown,
  error: unknown,
): AnalysisWorkerFailure {
  const partial =
    typeof value === "object" && value !== null
      ? (value as Partial<AnalysisWorkerRequest>)
      : {};
  const message =
    error instanceof Error
      ? `Invalid analysis request: ${error.message}`
      : "Invalid analysis request.";
  return analysisWorkerFailureSchema.parse({
    ...failureIdentity(partial),
    type: "failure",
    code: "INVALID_ENVELOPE",
    message: boundedMessage(message),
    searchCode: null,
  });
}

function definedSolverSeeds(
  input: AnalysisWorkerRequest["seeds"],
): Partial<SolverSeedSet> {
  const seeds: {
    belief?: string;
    search?: string;
    rollout?: string;
    chance?: string;
    bootstrap?: string;
  } = {};
  for (const key of [
    "belief",
    "search",
    "rollout",
    "chance",
    "bootstrap",
  ] as const) {
    const value = input[key];
    if (value !== undefined) {
      seeds[key] = value;
    }
  }
  return seeds;
}

function sameBinding(left: AnalysisBinding, right: AnalysisBinding): boolean {
  return stableStringify(left) === stableStringify(right);
}

function releaseFailure(
  request: AnalysisWorkerRequest,
  error: ProductionReleaseError,
): AnalysisWorkerFailure {
  return failure(
    request,
    error.code === "RELEASE_UNAVAILABLE"
      ? "RELEASE_UNAVAILABLE"
      : "INVALID_RELEASE",
    error.message,
    error.code,
  );
}

/**
 * The bundle is a worker-owned dependency. The optional argument exists for
 * deterministic tests and dedicated evaluation builds; it is never read from
 * the caller-controlled request envelope.
 */
export async function processAnalysisWorkerRequest(
  value: unknown,
  bundle: ProductionReleaseBundle = EMBEDDED_PRODUCTION_RELEASE_BUNDLE,
  options: VerifyProductionReleaseOptions = {},
): Promise<AnalysisWorkerResponse> {
  let request: AnalysisWorkerRequest;
  try {
    request = parseAnalysisWorkerRequest(value);
  } catch (error) {
    return invalidEnvelope(value, error);
  }

  let release;
  try {
    release = await verifyProductionReleaseBundle(bundle, options);
  } catch (error) {
    if (error instanceof ProductionReleaseError) {
      return releaseFailure(request, error);
    }
    return failure(
      request,
      "INVALID_RELEASE",
      error instanceof Error
        ? `Release verification failed: ${error.message}`
        : "Release verification failed.",
    );
  }
  const releaseWorkerBinding = analysisBindingSchema.parse(release.binding);
  if (!sameBinding(request.binding, releaseWorkerBinding)) {
    return failure(
      request,
      "RELEASE_BINDING_MISMATCH",
      "Caller binding does not match the independently verified worker release.",
    );
  }

  try {
    const timeline = importGameArchive(request.timelineArchive);
    const replay = replayTimeline(timeline);
    const publicStateHash = stableHash(replay.state);
    if (
      timeline.cursor !== request.stateVersion ||
      replay.semanticHash !== request.historyHash ||
      publicStateHash !== request.publicStateHash
    ) {
      return failure(
        request,
        "STALE_REQUEST",
        "The worker request identity does not match its validated timeline.",
      );
    }

    const result = analyzeSelectedProductionRole(
      {
        timeline,
        budgetId: request.budgetId,
        seeds: definedSolverSeeds(request.seeds),
      },
      release,
    );
    if (
      result.identity.stateVersion !== request.stateVersion ||
      result.identity.historyHash !== request.historyHash ||
      result.identity.publicStateHash !== request.publicStateHash
    ) {
      return failure(
        request,
        "STALE_REQUEST",
        "The completed production analysis does not match the requested state.",
      );
    }
    const response = analysisWorkerSuccessSchema.parse({
      ...failureIdentity(request),
      type: "success",
      result,
    });
    return parseAnalysisWorkerResponse(response);
  } catch (error) {
    if (error instanceof SearchError) {
      return failure(request, "SEARCH_FAILURE", error.message, error.code);
    }
    if (error instanceof ProductionSolverError) {
      return failure(
        request,
        error.code === "CONFIGURATION_REFUSED"
          ? "CONFIGURATION_REFUSED"
          : "INTERNAL_FAILURE",
        error.message,
        error.code,
      );
    }
    return failure(
      request,
      "INTERNAL_FAILURE",
      error instanceof Error
        ? `Analysis failed: ${error.message}`
        : "Analysis failed.",
    );
  }
}
