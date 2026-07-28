import { sortCards } from "../domain/cards";
import { SEATS } from "../domain/seats";
import { stableHash } from "../events/stable-hash";
import type {
  BehaviorBelief,
  BehaviorModelProbability,
  BehaviorWorldOccurrence,
} from "../inference/behavior-belief";
import {
  BEHAVIOR_MODEL_HASH,
  BEHAVIOR_MODEL_IDS,
  type BehaviorModelId,
} from "../inference/behavior-models";
import { assertHiddenWorldInvariant } from "../inference/hidden-world";
import type { HardBelief, HiddenWorld } from "../inference/types";
import {
  AdvancedSearchContractError,
  WEIGHTED_HYPOTHESES_ALGORITHM_VERSION,
  type JointBehaviorHypothesis,
  type WeightedBehaviorHypothesisSet,
} from "./advanced-types";

const NORMALIZATION_TOLERANCE = 1e-10;
const HYPOTHESES_PER_OCCURRENCE =
  BEHAVIOR_MODEL_IDS.length * BEHAVIOR_MODEL_IDS.length;

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

function staleBelief(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new AdvancedSearchContractError("STALE_BELIEF", message, details);
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

function assertNormalized(
  values: readonly number[],
  label: string,
  details: Readonly<Record<string, unknown>>,
): void {
  if (
    values.length === 0 ||
    values.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    invalidBelief(`${label} must contain finite, strictly positive values.`, {
      ...details,
      values,
    });
  }
  const total = compensatedSum(values);
  if (Math.abs(total - 1) > NORMALIZATION_TOLERANCE) {
    invalidBelief(`${label} must sum to one.`, {
      ...details,
      total,
    });
  }
}

function canonicalModelVector(
  probabilities: readonly BehaviorModelProbability[],
  occurrenceIndex: number,
  seat: "p2" | "p3",
): ReadonlyMap<BehaviorModelId, number> {
  if (probabilities.length !== BEHAVIOR_MODEL_IDS.length) {
    invalidBelief("A conditional model vector has the wrong length.", {
      occurrenceIndex,
      seat,
      length: probabilities.length,
    });
  }
  const byId = new Map<BehaviorModelId, number>();
  for (const entry of probabilities) {
    if (!BEHAVIOR_MODEL_IDS.includes(entry.modelId)) {
      invalidBelief("A conditional model vector names an unknown model.", {
        occurrenceIndex,
        seat,
        modelId: entry.modelId,
      });
    }
    if (byId.has(entry.modelId)) {
      invalidBelief("A conditional model vector repeats a model.", {
        occurrenceIndex,
        seat,
        modelId: entry.modelId,
      });
    }
    byId.set(entry.modelId, entry.probability);
  }
  for (const modelId of BEHAVIOR_MODEL_IDS) {
    if (!byId.has(modelId)) {
      invalidBelief("A conditional model vector omits a model.", {
        occurrenceIndex,
        seat,
        modelId,
      });
    }
  }
  assertNormalized(
    BEHAVIOR_MODEL_IDS.map((modelId) => byId.get(modelId) ?? 0),
    "Conditional model probabilities",
    { occurrenceIndex, seat },
  );
  return byId;
}

function assertAlignedOccurrence(
  world: HiddenWorld,
  occurrence: BehaviorWorldOccurrence,
  occurrenceIndex: number,
  occurrenceCount: number,
): void {
  if (
    occurrence.occurrenceIndex !== occurrenceIndex ||
    occurrence.witnessId !== world.witnessId
  ) {
    staleBelief("Behavioral occurrence does not align with its hard world.", {
      occurrenceIndex,
      hardWitnessId: world.witnessId,
      behaviorWitnessId: occurrence.witnessId,
      behaviorOccurrenceIndex: occurrence.occurrenceIndex,
    });
  }
  const expectedPrior = 1 / occurrenceCount;
  if (
    !Number.isFinite(occurrence.priorWeight) ||
    Math.abs(occurrence.priorWeight - expectedPrior) > NORMALIZATION_TOLERANCE
  ) {
    invalidBelief("Behavioral occurrence has an invalid hard-world prior.", {
      occurrenceIndex,
      priorWeight: occurrence.priorWeight,
      expectedPrior,
    });
  }
  if (!Number.isFinite(occurrence.weight) || occurrence.weight <= 0) {
    invalidBelief("Behavioral occurrence weight must be finite and positive.", {
      occurrenceIndex,
      weight: occurrence.weight,
    });
  }
}

function assertBeliefEnvelope(
  hardBelief: HardBelief,
  behaviorBelief: BehaviorBelief,
): void {
  if (hardBelief.worlds.length === 0) {
    invalidBelief("Weighted hypotheses require nonempty hard support.");
  }
  if (
    hardBelief.evidence.historyHash !== hardBelief.diagnostics.historyHash ||
    behaviorBelief.historyHash !== hardBelief.evidence.historyHash ||
    behaviorBelief.hardBeliefConfigHash !== hardBelief.diagnostics.configHash ||
    behaviorBelief.worldSetChecksum !==
      hardBelief.diagnostics.worldSetChecksum ||
    behaviorBelief.worldOccurrences.length !== hardBelief.worlds.length
  ) {
    staleBelief("Hard and behavioral beliefs do not describe one history.", {
      evidenceHistoryHash: hardBelief.evidence.historyHash,
      diagnosticsHistoryHash: hardBelief.diagnostics.historyHash,
      behaviorHistoryHash: behaviorBelief.historyHash,
      hardWorlds: hardBelief.worlds.length,
      behaviorOccurrences: behaviorBelief.worldOccurrences.length,
    });
  }
  if (behaviorBelief.modelHash !== BEHAVIOR_MODEL_HASH) {
    staleBelief("Behavioral belief uses a different model family.", {
      expectedModelHash: BEHAVIOR_MODEL_HASH,
      actualModelHash: behaviorBelief.modelHash,
    });
  }
  if (hardBelief.diagnostics.generatedWorlds !== hardBelief.worlds.length) {
    invalidBelief("Hard-belief diagnostics have a stale occurrence count.", {
      generatedWorlds: hardBelief.diagnostics.generatedWorlds,
      actualWorlds: hardBelief.worlds.length,
    });
  }
  const actualWorldSetChecksum = stableHash({
    schemaVersion: 1,
    orderedWitnessIds: hardBelief.worlds.map((world) => world.witnessId),
  });
  if (actualWorldSetChecksum !== hardBelief.diagnostics.worldSetChecksum) {
    invalidBelief(
      "Hard-belief world checksum does not match its occurrences.",
      {
        expected: hardBelief.diagnostics.worldSetChecksum,
        actual: actualWorldSetChecksum,
      },
    );
  }
  const behaviorContent = {
    schemaVersion: behaviorBelief.schemaVersion,
    algorithmVersion: behaviorBelief.algorithmVersion,
    historyHash: behaviorBelief.historyHash,
    hardBeliefConfigHash: behaviorBelief.hardBeliefConfigHash,
    worldSetChecksum: behaviorBelief.worldSetChecksum,
    configHash: behaviorBelief.configHash,
    modelHash: behaviorBelief.modelHash,
    config: behaviorBelief.config,
    ...(behaviorBelief.opponentModelPriors === undefined
      ? {}
      : { opponentModelPriors: behaviorBelief.opponentModelPriors }),
    decisionOrdinals: behaviorBelief.decisionOrdinals,
    worldOccurrences: behaviorBelief.worldOccurrences,
    opponentPosteriors: behaviorBelief.opponentPosteriors,
    diagnostics: behaviorBelief.diagnostics,
    decisionTraces: behaviorBelief.decisionTraces,
  };
  const actualBehaviorResultHash = stableHash(behaviorContent);
  if (actualBehaviorResultHash !== behaviorBelief.resultHash) {
    invalidBelief("Behavior-belief result hash does not match its content.", {
      expected: behaviorBelief.resultHash,
      actual: actualBehaviorResultHash,
    });
  }
}

function clonedHands(
  world: HiddenWorld,
): JointBehaviorHypothesis["currentHands"] {
  return deepFreeze(
    Object.fromEntries(
      SEATS.map((seat) => [seat, sortCards(world.currentHands[seat])]),
    ) as Record<(typeof SEATS)[number], ReturnType<typeof sortCards>>,
  );
}

export function buildWeightedBehaviorHypotheses(input: {
  readonly hardBelief: HardBelief;
  readonly behaviorBelief: BehaviorBelief;
}): WeightedBehaviorHypothesisSet {
  const { hardBelief, behaviorBelief } = input;
  assertBeliefEnvelope(hardBelief, behaviorBelief);

  const hypotheses: JointBehaviorHypothesis[] = [];
  const occurrenceWeights: number[] = [];
  const hypothesisKeys = new Set<string>();

  for (
    let occurrenceIndex = 0;
    occurrenceIndex < hardBelief.worlds.length;
    occurrenceIndex += 1
  ) {
    const world = hardBelief.worlds[occurrenceIndex];
    const occurrence = behaviorBelief.worldOccurrences[occurrenceIndex];
    if (world === undefined || occurrence === undefined) {
      invalidBelief("A belief occurrence is unexpectedly missing.", {
        occurrenceIndex,
      });
    }
    try {
      assertHiddenWorldInvariant(world, hardBelief.evidence);
    } catch (cause) {
      invalidBelief(
        "A hard-world occurrence violates its evidence.",
        { occurrenceIndex, witnessId: world.witnessId },
        cause,
      );
    }
    assertAlignedOccurrence(
      world,
      occurrence,
      occurrenceIndex,
      hardBelief.worlds.length,
    );
    occurrenceWeights.push(occurrence.weight);
    const p2 = canonicalModelVector(
      occurrence.conditionalModelProbabilities.p2,
      occurrenceIndex,
      "p2",
    );
    const p3 = canonicalModelVector(
      occurrence.conditionalModelProbabilities.p3,
      occurrenceIndex,
      "p3",
    );
    const currentHands = clonedHands(world);

    for (const p2ModelId of BEHAVIOR_MODEL_IDS) {
      for (const p3ModelId of BEHAVIOR_MODEL_IDS) {
        const p2Probability = p2.get(p2ModelId);
        const p3Probability = p3.get(p3ModelId);
        if (p2Probability === undefined || p3Probability === undefined) {
          invalidBelief("A validated model probability is missing.", {
            occurrenceIndex,
            p2ModelId,
            p3ModelId,
          });
        }
        const mass = occurrence.weight * p2Probability * p3Probability;
        if (!Number.isFinite(mass) || mass <= 0) {
          invalidBelief("A joint hypothesis has invalid probability mass.", {
            occurrenceIndex,
            p2ModelId,
            p3ModelId,
            mass,
          });
        }
        const hypothesisKey = stableHash({
          schemaVersion: 1,
          historyHash: behaviorBelief.historyHash,
          occurrenceIndex,
          witnessId: world.witnessId,
          p2ModelId,
          p3ModelId,
        });
        if (hypothesisKeys.has(hypothesisKey)) {
          invalidBelief("Joint hypothesis keys are not unique.", {
            occurrenceIndex,
            hypothesisKey,
          });
        }
        hypothesisKeys.add(hypothesisKey);
        hypotheses.push({
          schemaVersion: 1,
          occurrenceIndex,
          witnessId: world.witnessId,
          p2ModelId,
          p3ModelId,
          mass,
          currentHands,
          hypothesisKey,
        });
      }
    }
  }

  assertNormalized(
    occurrenceWeights,
    "Behavioral world occurrence weights",
    {},
  );
  const totalMass = compensatedSum(
    hypotheses.map((hypothesis) => hypothesis.mass),
  );
  if (Math.abs(totalMass - 1) > NORMALIZATION_TOLERANCE) {
    invalidBelief("Joint hypothesis masses do not sum to one.", {
      totalMass,
    });
  }

  const checksum = stableHash({
    schemaVersion: 1,
    algorithmVersion: WEIGHTED_HYPOTHESES_ALGORITHM_VERSION,
    historyHash: behaviorBelief.historyHash,
    behaviorResultHash: behaviorBelief.resultHash,
    hypotheses: hypotheses.map((hypothesis) => ({
      hypothesisKey: hypothesis.hypothesisKey,
      mass: hypothesis.mass,
    })),
  });
  return deepFreeze({
    schemaVersion: 1,
    algorithmVersion: WEIGHTED_HYPOTHESES_ALGORITHM_VERSION,
    historyHash: behaviorBelief.historyHash,
    hardBeliefConfigHash: hardBelief.diagnostics.configHash,
    worldSetChecksum: hardBelief.diagnostics.worldSetChecksum,
    behaviorResultHash: behaviorBelief.resultHash,
    behaviorModelHash: behaviorBelief.modelHash,
    occurrenceCount: hardBelief.worlds.length,
    distinctWitnesses: new Set(
      hardBelief.worlds.map((world) => world.witnessId),
    ).size,
    hypothesesPerOccurrence: HYPOTHESES_PER_OCCURRENCE,
    totalHypotheses: hypotheses.length,
    totalMass,
    hypotheses,
    checksum,
  });
}
