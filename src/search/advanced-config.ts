import { stableHash } from "../events/stable-hash";
import { BEHAVIOR_MODEL_HASH } from "../inference/behavior-models";
import { RNG_ALGORITHM } from "../random/keyed-rng";
import {
  ACTOR_SAFE_POLICY_KERNEL_VERSION,
  ADVANCED_SEARCH_ALGORITHM_VERSION,
  AdvancedSearchContractError,
  USER_OBSERVABLE_KEY_VERSION,
  WEIGHTED_HYPOTHESES_ALGORITHM_VERSION,
  type AdvancedSearchConfig,
  type AdvancedSearchConfigInput,
} from "./advanced-types";

const TOP_LEVEL_INPUT_KEYS = new Set([
  "schemaVersion",
  "executionMode",
  "exact",
  "approximateHypothesisSamples",
  "deadlineMs",
]);
const EXACT_INPUT_KEYS = new Set([
  "maxActiveCards",
  "maxJointHypotheses",
  "maxInformationStates",
  "maxBranches",
]);

export const DEFAULT_ADVANCED_SEARCH_CONFIG: AdvancedSearchConfig = deepFreeze({
  schemaVersion: 1,
  executionMode: "research-only",
  exact: {
    maxActiveCards: 12,
    maxJointHypotheses: 196,
    maxInformationStates: 25_000,
    maxBranches: 100_000,
  },
  approximateHypothesisSamples: 128,
  deadlineMs: 2_500,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function invalidConfig(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new AdvancedSearchContractError("INVALID_CONFIG", message, details);
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    invalidConfig(`${label} contains unknown fields.`, {
      label,
      unknown: unknown.sort(),
    });
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalidConfig(`${label} must be a positive safe integer.`, {
      label,
      value,
    });
  }
  return value;
}

export function validateAdvancedSearchConfig(
  input: AdvancedSearchConfigInput | AdvancedSearchConfig = {},
): AdvancedSearchConfig {
  assertOnlyKeys(input, TOP_LEVEL_INPUT_KEYS, "advanced search config");
  const runtimeSchemaVersion: unknown = Reflect.get(input, "schemaVersion");
  if (runtimeSchemaVersion !== undefined && runtimeSchemaVersion !== 1) {
    invalidConfig("Advanced search schemaVersion must be 1.", {
      schemaVersion: runtimeSchemaVersion,
    });
  }
  const runtimeExecutionMode: unknown = Reflect.get(input, "executionMode");
  if (
    runtimeExecutionMode !== undefined &&
    runtimeExecutionMode !== "research-only"
  ) {
    invalidConfig("Advanced search executionMode must remain research-only.", {
      executionMode: runtimeExecutionMode,
    });
  }
  const exactInput = input.exact ?? {};
  assertOnlyKeys(exactInput, EXACT_INPUT_KEYS, "advanced exact limits");

  const config: AdvancedSearchConfig = {
    schemaVersion: 1,
    executionMode: "research-only",
    exact: {
      maxActiveCards: positiveSafeInteger(
        exactInput.maxActiveCards ??
          DEFAULT_ADVANCED_SEARCH_CONFIG.exact.maxActiveCards,
        "exact.maxActiveCards",
      ),
      maxJointHypotheses: positiveSafeInteger(
        exactInput.maxJointHypotheses ??
          DEFAULT_ADVANCED_SEARCH_CONFIG.exact.maxJointHypotheses,
        "exact.maxJointHypotheses",
      ),
      maxInformationStates: positiveSafeInteger(
        exactInput.maxInformationStates ??
          DEFAULT_ADVANCED_SEARCH_CONFIG.exact.maxInformationStates,
        "exact.maxInformationStates",
      ),
      maxBranches: positiveSafeInteger(
        exactInput.maxBranches ??
          DEFAULT_ADVANCED_SEARCH_CONFIG.exact.maxBranches,
        "exact.maxBranches",
      ),
    },
    approximateHypothesisSamples: positiveSafeInteger(
      input.approximateHypothesisSamples ??
        DEFAULT_ADVANCED_SEARCH_CONFIG.approximateHypothesisSamples,
      "approximateHypothesisSamples",
    ),
    deadlineMs: positiveSafeInteger(
      input.deadlineMs ?? DEFAULT_ADVANCED_SEARCH_CONFIG.deadlineMs,
      "deadlineMs",
    ),
  };
  if (config.exact.maxActiveCards > 52) {
    invalidConfig("exact.maxActiveCards cannot exceed the 52-card deck.", {
      maxActiveCards: config.exact.maxActiveCards,
    });
  }
  if (config.exact.maxBranches < config.exact.maxInformationStates) {
    invalidConfig(
      "exact.maxBranches must not be smaller than maxInformationStates.",
      {
        maxBranches: config.exact.maxBranches,
        maxInformationStates: config.exact.maxInformationStates,
      },
    );
  }
  return deepFreeze(config);
}

export function advancedSearchConfigurationHash(
  configValue: AdvancedSearchConfigInput | AdvancedSearchConfig = {},
): string {
  const config = validateAdvancedSearchConfig(configValue);
  return stableHash({
    schemaVersion: 1,
    algorithmVersion: ADVANCED_SEARCH_ALGORITHM_VERSION,
    weightedHypothesesVersion: WEIGHTED_HYPOTHESES_ALGORITHM_VERSION,
    policyKernelVersion: ACTOR_SAFE_POLICY_KERNEL_VERSION,
    observableKeyVersion: USER_OBSERVABLE_KEY_VERSION,
    behaviorModelHash: BEHAVIOR_MODEL_HASH,
    rngAlgorithmVersion: RNG_ALGORITHM,
    config,
  });
}
