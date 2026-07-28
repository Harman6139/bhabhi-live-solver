/// <reference lib="webworker" />

import { processAnalysisWorkerRequest } from "./analysis-handler";
import { EMBEDDED_PRODUCTION_RELEASE_BUNDLE } from "../production/embedded-release";

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<unknown>) => {
  scope.postMessage(
    await processAnalysisWorkerRequest(
      event.data,
      EMBEDDED_PRODUCTION_RELEASE_BUNDLE,
    ),
  );
};
