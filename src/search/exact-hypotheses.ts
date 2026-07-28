import { assertUniqueCards, sortCards } from "../domain/cards";
import { SEATS } from "../domain/seats";
import { stableHash } from "../events/stable-hash";
import {
  BEHAVIOR_MODEL_HASH,
  BEHAVIOR_MODEL_IDS,
  DEFAULT_BEHAVIOR_MODEL_CONFIG,
  validateBehaviorModelConfig,
  type BehaviorModelConfig,
  type BehaviorModelId,
} from "../inference/behavior-models";
import {
  behaviorBeliefConfigurationHash,
  type BehaviorBelief,
} from "../inference/behavior-belief";
import type { HardBelief } from "../inference/types";
import {
  AdvancedSearchContractError,
  EXACT_INFORMATION_HYPOTHESIS_SET_VERSION,
  WEIGHTED_HYPOTHESES_ALGORITHM_VERSION,
  type ExactInformationHypothesis,
  type ExactInformationHypothesisSet,
  type WeightedBehaviorHypothesisSet,
} from "./advanced-types";

const NORMALIZATION_TOLERANCE = 1e-10;
const HYPOTHESES_PER_OCCURRENCE =
  BEHAVIOR_MODEL_IDS.length * BEHAVIOR_MODEL_IDS.length;

export type ExactInformationHypothesisInput = Omit<
  ExactInformationHypothesis,
  "schemaVersion"
>;

export type ExactInformationHypothesisSetInput = {
  readonly historyHash: string;
  readonly sourceKind: ExactInformationHypothesisSet["sourceKind"];
  readonly sourceChecksum: string;
  readonly supportKind: ExactInformationHypothesisSet["supportKind"];
  readonly supportWorldCount: string;
  readonly behaviorConfigHash: string;
  readonly hypotheses: readonly ExactInformationHypothesisInput[];
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function invalidBelief(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): never {
  throw new AdvancedSearchContractError(
    "INVALID_BELIEF",
    message,
    details,
    cause === undefined ? undefined : { cause },
  );
}

function requiredIdentifier(value: string, label: string): string {
  if (value.trim().length === 0 || value.trim() !== value) {
    invalidBelief(`${label} must be a nonempty trimmed string.`, {
      label,
      value,
    });
  }
  return value;
}

function compensatedSum(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const corrected = value - compensation;
    const next = sum + corrected;
    compensation = next - sum - corrected;
    sum = next;
  }
  return sum;
}

function canonicalHypothesis(
  input: ExactInformationHypothesisInput,
): ExactInformationHypothesis {
  const hypothesisId = requiredIdentifier(input.hypothesisId, "hypothesisId");
  const witnessId = requiredIdentifier(input.witnessId, "witnessId");
  if (
    !Number.isSafeInteger(input.occurrenceIndex) ||
    input.occurrenceIndex < 0
  ) {
    invalidBelief("occurrenceIndex must be a nonnegative safe integer.", {
      hypothesisId,
      occurrenceIndex: input.occurrenceIndex,
    });
  }
  if (
    !BEHAVIOR_MODEL_IDS.includes(input.p2ModelId) ||
    !BEHAVIOR_MODEL_IDS.includes(input.p3ModelId)
  ) {
    invalidBelief("An exact hypothesis uses an unknown behavior model.", {
      hypothesisId,
      p2ModelId: input.p2ModelId,
      p3ModelId: input.p3ModelId,
    });
  }
  if (!Number.isFinite(input.mass) || input.mass <= 0) {
    invalidBelief(
      "Exact hypothesis mass must be finite and strictly positive.",
      {
        hypothesisId,
        mass: input.mass,
      },
    );
  }
  const allHandCards = SEATS.flatMap((seat) => input.currentHands[seat]);
  try {
    assertUniqueCards(allHandCards, `exact hypothesis ${hypothesisId} hands`);
  } catch (cause) {
    invalidBelief(
      "An exact hypothesis repeats a card across current hands.",
      { hypothesisId },
      cause,
    );
  }
  return {
    schemaVersion: 1,
    hypothesisId,
    occurrenceIndex: input.occurrenceIndex,
    witnessId,
    p2ModelId: input.p2ModelId,
    p3ModelId: input.p3ModelId,
    mass: input.mass,
    currentHands: {
      user: sortCards(input.currentHands.user),
      p2: sortCards(input.currentHands.p2),
      p3: sortCards(input.currentHands.p3),
    },
  };
}

export function createExactInformationHypothesisSet(
  input: ExactInformationHypothesisSetInput,
): ExactInformationHypothesisSet {
  const historyHash = requiredIdentifier(input.historyHash, "historyHash");
  const sourceChecksum = requiredIdentifier(
    input.sourceChecksum,
    "sourceChecksum",
  );
  const supportWorldCount = requiredIdentifier(
    input.supportWorldCount,
    "supportWorldCount",
  );
  const behaviorConfigHash = requiredIdentifier(
    input.behaviorConfigHash,
    "behaviorConfigHash",
  );
  const sourceKind: string = input.sourceKind;
  if (
    !new Set<string>([
      "weighted-behavior",
      "hard-only",
      "explicit-research",
    ]).has(sourceKind)
  ) {
    invalidBelief("Unknown exact-hypothesis source kind.", {
      sourceKind: input.sourceKind,
    });
  }
  const supportKind: string = input.supportKind;
  if (!new Set<string>(["exhaustive", "sampled"]).has(supportKind)) {
    invalidBelief("Unknown exact-hypothesis support kind.", {
      supportKind: input.supportKind,
    });
  }
  try {
    const supportCount = BigInt(supportWorldCount);
    if (supportCount < 1n) {
      invalidBelief("supportWorldCount must be positive.", {
        supportWorldCount,
      });
    }
  } catch (cause) {
    if (cause instanceof AdvancedSearchContractError) {
      throw cause;
    }
    invalidBelief(
      "supportWorldCount must be a canonical positive integer string.",
      { supportWorldCount },
      cause,
    );
  }
  if (BigInt(supportWorldCount).toString() !== supportWorldCount) {
    invalidBelief(
      "supportWorldCount must be a canonical positive integer string.",
      { supportWorldCount },
    );
  }
  if (input.hypotheses.length === 0) {
    invalidBelief("An exact hypothesis set must be nonempty.");
  }
  const hypotheses = input.hypotheses
    .map(canonicalHypothesis)
    .sort((left, right) => left.hypothesisId.localeCompare(right.hypothesisId));
  const hypothesisIds = hypotheses.map((hypothesis) => hypothesis.hypothesisId);
  if (new Set(hypothesisIds).size !== hypothesisIds.length) {
    invalidBelief("Exact hypothesis IDs must be unique.", {
      hypothesisIds,
    });
  }
  const totalMass = compensatedSum(
    hypotheses.map((hypothesis) => hypothesis.mass),
  );
  if (Math.abs(totalMass - 1) > NORMALIZATION_TOLERANCE) {
    invalidBelief("Exact hypothesis masses must sum to one.", {
      totalMass,
      tolerance: NORMALIZATION_TOLERANCE,
    });
  }
  const canonicalHypotheses = hypotheses.map((hypothesis) => ({
    ...hypothesis,
    mass: hypothesis.mass / totalMass,
  }));
  const content = {
    schemaVersion: 1 as const,
    setVersion: EXACT_INFORMATION_HYPOTHESIS_SET_VERSION,
    historyHash,
    sourceKind: input.sourceKind,
    sourceChecksum,
    supportKind: input.supportKind,
    supportWorldCount,
    behaviorConfigHash,
    totalMass: 1,
    totalHypotheses: canonicalHypotheses.length,
    distinctWitnesses: new Set(
      canonicalHypotheses.map((hypothesis) => hypothesis.witnessId),
    ).size,
    hypotheses: canonicalHypotheses,
  };
  return deepFreeze({
    ...content,
    checksum: stableHash(content),
  });
}

export function exactHypothesesFromHardBelief(input: {
  readonly hardBelief: HardBelief;
  readonly p2ModelId: BehaviorModelId;
  readonly p3ModelId: BehaviorModelId;
  readonly behaviorConfig?: BehaviorModelConfig;
}): ExactInformationHypothesisSet {
  const { hardBelief, p2ModelId, p3ModelId } = input;
  if (
    !BEHAVIOR_MODEL_IDS.includes(p2ModelId) ||
    !BEHAVIOR_MODEL_IDS.includes(p3ModelId)
  ) {
    invalidBelief("Hard-only exact adaptation uses an unknown policy model.", {
      p2ModelId,
      p3ModelId,
    });
  }
  if (hardBelief.worlds.length === 0) {
    invalidBelief("Hard-only exact adaptation requires nonempty support.");
  }
  const exhaustive =
    hardBelief.method === "exact-enumeration" &&
    hardBelief.diagnostics.method === "exact-enumeration" &&
    hardBelief.diagnostics.exactEnumerationEligible &&
    BigInt(hardBelief.diagnostics.totalInitialDealWorlds) ===
      BigInt(hardBelief.worlds.length);
  const behaviorConfig = input.behaviorConfig ?? DEFAULT_BEHAVIOR_MODEL_CONFIG;
  validateBehaviorModelConfig(behaviorConfig);
  const sourceChecksum = stableHash({
    schemaVersion: 1,
    sourceKind: "hard-only",
    historyHash: hardBelief.evidence.historyHash,
    hardBeliefConfigHash: hardBelief.diagnostics.configHash,
    worldSetChecksum: hardBelief.diagnostics.worldSetChecksum,
    method: hardBelief.method,
    p2ModelId,
    p3ModelId,
    behaviorConfigHash: behaviorBeliefConfigurationHash(behaviorConfig),
  });
  return createExactInformationHypothesisSet({
    historyHash: hardBelief.evidence.historyHash,
    sourceKind: "hard-only",
    sourceChecksum,
    supportKind: exhaustive ? "exhaustive" : "sampled",
    supportWorldCount: hardBelief.diagnostics.totalInitialDealWorlds,
    behaviorConfigHash: behaviorBeliefConfigurationHash(behaviorConfig),
    hypotheses: hardBelief.worlds.map((world, occurrenceIndex) => ({
      hypothesisId: stableHash({
        schemaVersion: 1,
        sourceKind: "hard-only",
        historyHash: hardBelief.evidence.historyHash,
        occurrenceIndex,
        witnessId: world.witnessId,
        p2ModelId,
        p3ModelId,
      }),
      occurrenceIndex,
      witnessId: world.witnessId,
      p2ModelId,
      p3ModelId,
      mass: 1 / hardBelief.worlds.length,
      currentHands: world.currentHands,
    })),
  });
}

function assertWeightedBehaviorSet(set: WeightedBehaviorHypothesisSet): void {
  const envelope: {
    readonly schemaVersion: number;
    readonly algorithmVersion: string;
    readonly behaviorModelHash: string;
  } = set;
  if (
    envelope.schemaVersion !== 1 ||
    envelope.algorithmVersion !== WEIGHTED_HYPOTHESES_ALGORITHM_VERSION ||
    envelope.behaviorModelHash !== BEHAVIOR_MODEL_HASH
  ) {
    invalidBelief("Weighted behavior hypotheses use a stale envelope.", {
      schemaVersion: set.schemaVersion,
      algorithmVersion: set.algorithmVersion,
      behaviorModelHash: set.behaviorModelHash,
    });
  }
  if (
    set.occurrenceCount < 1 ||
    set.hypothesesPerOccurrence !== HYPOTHESES_PER_OCCURRENCE ||
    set.totalHypotheses !== set.hypotheses.length ||
    set.totalHypotheses !== set.occurrenceCount * set.hypothesesPerOccurrence
  ) {
    invalidBelief("Weighted behavior hypothesis cardinality is inconsistent.", {
      occurrenceCount: set.occurrenceCount,
      hypothesesPerOccurrence: set.hypothesesPerOccurrence,
      totalHypotheses: set.totalHypotheses,
      actualHypotheses: set.hypotheses.length,
    });
  }
  const actualTotalMass = compensatedSum(
    set.hypotheses.map((hypothesis) => hypothesis.mass),
  );
  if (
    Math.abs(actualTotalMass - 1) > NORMALIZATION_TOLERANCE ||
    Math.abs(set.totalMass - actualTotalMass) > NORMALIZATION_TOLERANCE
  ) {
    invalidBelief("Weighted behavior hypothesis mass is inconsistent.", {
      envelopeTotalMass: set.totalMass,
      actualTotalMass,
    });
  }
  const actualChecksum = stableHash({
    schemaVersion: 1,
    algorithmVersion: WEIGHTED_HYPOTHESES_ALGORITHM_VERSION,
    historyHash: set.historyHash,
    behaviorResultHash: set.behaviorResultHash,
    hypotheses: set.hypotheses.map((hypothesis) => ({
      hypothesisKey: hypothesis.hypothesisKey,
      mass: hypothesis.mass,
    })),
  });
  if (actualChecksum !== set.checksum) {
    invalidBelief("Weighted behavior hypothesis checksum does not match.", {
      expected: set.checksum,
      actual: actualChecksum,
    });
  }
}

export function exactHypothesesFromWeightedBehavior(input: {
  readonly set: WeightedBehaviorHypothesisSet;
  readonly hardBelief: HardBelief;
  readonly behaviorBelief: BehaviorBelief;
}): ExactInformationHypothesisSet {
  const { set, hardBelief, behaviorBelief } = input;
  assertWeightedBehaviorSet(set);
  const exhaustive =
    hardBelief.method === "exact-enumeration" &&
    hardBelief.diagnostics.method === "exact-enumeration" &&
    hardBelief.diagnostics.exactEnumerationEligible &&
    BigInt(hardBelief.diagnostics.totalInitialDealWorlds) ===
      BigInt(hardBelief.worlds.length);
  if (
    set.historyHash !== hardBelief.evidence.historyHash ||
    set.historyHash !== behaviorBelief.historyHash ||
    set.worldSetChecksum !== hardBelief.diagnostics.worldSetChecksum ||
    set.behaviorResultHash !== behaviorBelief.resultHash ||
    set.hardBeliefConfigHash !== hardBelief.diagnostics.configHash ||
    behaviorBelief.hardBeliefConfigHash !== hardBelief.diagnostics.configHash ||
    behaviorBelief.configHash.trim().length === 0
  ) {
    invalidBelief(
      "Weighted, hard, and behavioral beliefs do not share one envelope.",
      {
        setHistoryHash: set.historyHash,
        hardHistoryHash: hardBelief.evidence.historyHash,
        behaviorHistoryHash: behaviorBelief.historyHash,
        setWorldChecksum: set.worldSetChecksum,
        hardWorldChecksum: hardBelief.diagnostics.worldSetChecksum,
        setBehaviorResultHash: set.behaviorResultHash,
        behaviorResultHash: behaviorBelief.resultHash,
      },
    );
  }
  return createExactInformationHypothesisSet({
    historyHash: set.historyHash,
    sourceKind: "weighted-behavior",
    sourceChecksum: set.checksum,
    supportKind: exhaustive ? "exhaustive" : "sampled",
    supportWorldCount: hardBelief.diagnostics.totalInitialDealWorlds,
    behaviorConfigHash: behaviorBelief.configHash,
    hypotheses: set.hypotheses.map((hypothesis) => ({
      hypothesisId: hypothesis.hypothesisKey,
      occurrenceIndex: hypothesis.occurrenceIndex,
      witnessId: hypothesis.witnessId,
      p2ModelId: hypothesis.p2ModelId,
      p3ModelId: hypothesis.p3ModelId,
      mass: hypothesis.mass,
      currentHands: hypothesis.currentHands,
    })),
  });
}
