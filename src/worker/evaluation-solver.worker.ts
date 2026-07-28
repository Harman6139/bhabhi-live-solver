/// <reference lib="webworker" />

import { EMBEDDED_PRODUCTION_RELEASE_BUNDLE } from "../production/embedded-release";
import { processAnalysisWorkerRequest } from "./analysis-handler";

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

/**
 * Dedicated Phase 8 measurement entry. It is intentionally separate from the
 * live worker so evaluation-only bundles cannot be enabled by a runtime flag
 * or a caller-controlled request.
 */
scope.onmessage = async (event: MessageEvent<unknown>) => {
  scope.postMessage(
    await processAnalysisWorkerRequest(
      event.data,
      EMBEDDED_PRODUCTION_RELEASE_BUNDLE,
      { allowEvaluationOnly: true },
    ),
  );
};
