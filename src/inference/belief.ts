import { stableHash, stableStringify } from "../events/stable-hash";
import type { GameTimeline } from "../events/timeline";
import { deterministicRank } from "./combinatorics";
import { HardInferenceError } from "./error";
import { compileHardEvidence } from "./hard-evidence";
import { currentHandsKey, hiddenWorldAtRank } from "./hidden-world";
import {
  HARD_BELIEF_ALGORITHM_VERSION,
  type HardBelief,
  type HardBeliefConfig,
  type HardBeliefMethod,
  type HardEvidence,
  type HiddenWorld,
} from "./types";

export const DEFAULT_HARD_BELIEF_CONFIG: HardBeliefConfig = Object.freeze({
  seed: "getaway-hard-belief-v1",
  maxExactWorlds: 50_000,
  maxExactProjectionOperations: 2_000_000,
  maxExactEstimatedBytes: 32 * 1_024 * 1_024,
  sampleCount: 2_048,
  forceSampling: false,
});

const MAX_MATERIALIZED_WORLDS = 100_000;
const ESTIMATED_WORLD_BYTES = 1_536;

function validateConfig(value: Partial<HardBeliefConfig>): HardBeliefConfig {
  const config: HardBeliefConfig = {
    ...DEFAULT_HARD_BELIEF_CONFIG,
    ...value,
  };
  if (config.seed.trim().length === 0) {
    throw new HardInferenceError(
      "INVALID_CONFIG",
      "Hard-belief seed must not be empty.",
    );
  }
  for (const [name, number] of [
    ["maxExactWorlds", config.maxExactWorlds],
    ["sampleCount", config.sampleCount],
  ] as const) {
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > MAX_MATERIALIZED_WORLDS
    ) {
      throw new HardInferenceError(
        "INVALID_CONFIG",
        `${name} must be an integer in [1, ${MAX_MATERIALIZED_WORLDS}].`,
        { details: { [name]: number } },
      );
    }
  }
  for (const [name, number] of [
    ["maxExactProjectionOperations", config.maxExactProjectionOperations],
    ["maxExactEstimatedBytes", config.maxExactEstimatedBytes],
  ] as const) {
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new HardInferenceError(
        "INVALID_CONFIG",
        `${name} must be a positive safe integer.`,
        { details: { [name]: number } },
      );
    }
  }
  return config;
}

function worldRanks(
  evidence: HardEvidence,
  config: HardBeliefConfig,
  method: HardBeliefMethod,
  seedMaterial: string,
): bigint[] {
  const total = BigInt(evidence.support.totalWorldCount);
  if (method === "exact-enumeration") {
    return Array.from({ length: Number(total) }, (_value, index) =>
      BigInt(index),
    );
  }
  return Array.from({ length: config.sampleCount }, (_value, sampleIndex) =>
    deterministicRank(seedMaterial, sampleIndex, total),
  );
}

export function buildHardBeliefFromEvidence(
  evidence: HardEvidence,
  configValue: Partial<HardBeliefConfig> = {},
): HardBelief {
  const config = validateConfig(configValue);
  const total = BigInt(evidence.support.totalWorldCount);
  if (total <= 0n) {
    throw new HardInferenceError(
      "NO_VALID_WORLDS",
      "Hard belief cannot materialize an empty support.",
      { details: { historyHash: evidence.historyHash } },
    );
  }
  const estimatedExactProjectionOperations =
    total * BigInt(evidence.hiddenCards.length);
  const estimatedExactBytes = total * BigInt(ESTIMATED_WORLD_BYTES);
  const exactEnumerationEligible =
    total <= BigInt(config.maxExactWorlds) &&
    estimatedExactProjectionOperations <=
      BigInt(config.maxExactProjectionOperations) &&
    estimatedExactBytes <= BigInt(config.maxExactEstimatedBytes);
  const method: HardBeliefMethod =
    !config.forceSampling && exactEnumerationEligible
      ? "exact-enumeration"
      : "direct-uniform-sample";
  const configHash = stableHash({
    schemaVersion: 1,
    algorithmVersion: HARD_BELIEF_ALGORITHM_VERSION,
    config,
  });
  const seedMaterial = stableStringify({
    schemaVersion: 1,
    algorithmVersion: HARD_BELIEF_ALGORITHM_VERSION,
    historyHash: evidence.historyHash,
    seed: config.seed,
  });
  const seedId = stableHash(seedMaterial);
  const ranks = worldRanks(evidence, config, method, seedMaterial);
  const worlds: HiddenWorld[] = ranks.map((rank) =>
    hiddenWorldAtRank(evidence, rank),
  );
  const witnessIds = worlds.map((world) => world.witnessId);
  const uniqueWitnesses = new Set(witnessIds).size;
  const distinctCurrentHands = new Set(worlds.map(currentHandsKey)).size;
  const finalState = evidence.finalState;

  return {
    schemaVersion: 1,
    method,
    evidence,
    worlds,
    diagnostics: {
      historyHash: evidence.historyHash,
      configHash,
      seedId,
      algorithmVersion: HARD_BELIEF_ALGORITHM_VERSION,
      method,
      totalInitialDealWorlds: total.toString(),
      exactEnumerationEligible,
      estimatedExactProjectionOperations:
        estimatedExactProjectionOperations.toString(),
      estimatedExactBytes: estimatedExactBytes.toString(),
      generatedWorlds: worlds.length,
      uniqueWitnesses,
      distinctCurrentHands,
      duplicateSamples: worlds.length - uniqueWitnesses,
      forcedP2: evidence.support.forcedP2,
      forcedP3: evidence.support.forcedP3,
      flexible: evidence.support.flexible,
      p2CurrentUnknownSlots:
        finalState.handCounts.p2 - finalState.knownOpponentCards.p2.length,
      p3CurrentUnknownSlots:
        finalState.handCounts.p3 - finalState.knownOpponentCards.p3.length,
      worldSetChecksum: stableHash({
        schemaVersion: 1,
        orderedWitnessIds: witnessIds,
      }),
      voidObservations: evidence.voidObservations,
    },
  };
}

export function buildHardBelief(
  timeline: GameTimeline,
  config: Partial<HardBeliefConfig> = {},
): HardBelief {
  return buildHardBeliefFromEvidence(compileHardEvidence(timeline), config);
}
