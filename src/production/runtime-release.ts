import { EMBEDDED_PRODUCTION_RELEASE_BUNDLE } from "./embedded-release";
import {
  verifyProductionReleaseBundle,
  type ProductionAnalysisBinding,
  type VerifiedProductionRelease,
} from "./release-contract";

/**
 * Main-thread live preflight. The dedicated worker repeats the complete
 * verification independently before executing any request.
 */
export async function loadEmbeddedLiveProductionRelease(): Promise<VerifiedProductionRelease> {
  return verifyProductionReleaseBundle(EMBEDDED_PRODUCTION_RELEASE_BUNDLE);
}

export async function loadEmbeddedLiveProductionBinding(): Promise<ProductionAnalysisBinding> {
  return (await loadEmbeddedLiveProductionRelease()).binding;
}

/**
 * Evaluation harness preflight. This opt-in is intentionally not used by the
 * live client or live worker entry.
 */
export async function loadEmbeddedEvaluationProductionRelease(): Promise<VerifiedProductionRelease> {
  return verifyProductionReleaseBundle(EMBEDDED_PRODUCTION_RELEASE_BUNDLE, {
    allowEvaluationOnly: true,
  });
}
