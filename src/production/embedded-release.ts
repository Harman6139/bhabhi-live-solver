import {
  productionReleaseBundleSchema,
  UNSELECTED_PRODUCTION_RELEASE_BUNDLE,
  type ProductionReleaseBundle,
} from "./release-contract";

declare const __BHABHI_PRODUCTION_RELEASE_BUNDLE_JSON__: string;

function embeddedBundle(): ProductionReleaseBundle {
  if (
    typeof __BHABHI_PRODUCTION_RELEASE_BUNDLE_JSON__ === "undefined" ||
    __BHABHI_PRODUCTION_RELEASE_BUNDLE_JSON__.length === 0
  ) {
    return UNSELECTED_PRODUCTION_RELEASE_BUNDLE;
  }
  try {
    return productionReleaseBundleSchema.parse(
      JSON.parse(__BHABHI_PRODUCTION_RELEASE_BUNDLE_JSON__) as unknown,
    );
  } catch (cause) {
    throw new TypeError(
      "The build-time production release bundle is invalid.",
      { cause },
    );
  }
}

/**
 * Explicit safe default. The release compiler must replace this value only
 * after Phase 8 selection and final attestations exist. Keeping the generated
 * release bundle outside the preregistered evidence source snapshot prevents
 * circular self-attestation.
 */
export const EMBEDDED_PRODUCTION_RELEASE_BUNDLE: ProductionReleaseBundle =
  embeddedBundle();
