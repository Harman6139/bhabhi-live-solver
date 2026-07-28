import type { PolicyObservation } from "../agents/policies";
import { assertUniqueCards } from "../domain/cards";
import { SEATS } from "../domain/seats";
import { stableHash } from "../events/stable-hash";
import {
  BEHAVIOR_MODEL_HASH,
  BEHAVIOR_MODEL_IDS,
  behaviorModelDistribution,
  validateBehaviorModelConfig,
  type BehaviorModelConfig,
  type BehaviorModelConfigInput,
  type BehaviorModelId,
} from "../inference/behavior-models";
import {
  ACTOR_SAFE_POLICY_KERNEL_VERSION,
  AdvancedSearchContractError,
  type ActorSafePolicyDistribution,
} from "./advanced-types";

const NORMALIZATION_TOLERANCE = 1e-12;
const FORBIDDEN_OBSERVATION_KEYS = [
  "exactHands",
  "hands",
  "hiddenWorld",
  "initialHands",
  "currentHands",
  "knownOpponentCards",
  "simulatorState",
  "truth",
  "unresolvedCards",
  "userHand",
  "witnessId",
] as const;
const ALLOWED_OBSERVATION_KEYS = new Set([
  "schemaVersion",
  "seat",
  "decisionOrdinal",
  "rules",
  "phase",
  "status",
  "startingCounts",
  "handCounts",
  "ownHand",
  "legalCards",
  "legalTakeTargets",
  "trick",
  "waste",
  "power",
  "turn",
  "activeSeats",
  "escapeGroups",
  "publicPlays",
  "currentSuitStatus",
  "lastPickup",
]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function invalidObservation(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): never {
  throw new AdvancedSearchContractError(
    "INVALID_POLICY_OBSERVATION",
    message,
    details,
    cause === undefined ? undefined : { cause },
  );
}

function assertActorSafeObservation(
  observation: PolicyObservation,
): asserts observation is PolicyObservation & { readonly seat: "p2" | "p3" } {
  const record = observation as unknown as Readonly<Record<string, unknown>>;
  const forbidden = FORBIDDEN_OBSERVATION_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(record, key),
  );
  if (forbidden.length > 0) {
    invalidObservation(
      "Policy observation contains hidden-world or user-relative fields.",
      { forbidden },
    );
  }
  const unknown = Object.keys(record).filter(
    (key) => !ALLOWED_OBSERVATION_KEYS.has(key),
  );
  if (unknown.length > 0) {
    invalidObservation(
      "Policy observation contains fields outside the actor-safe schema.",
      { unknown: unknown.sort() },
    );
  }
  if (observation.seat !== "p2" && observation.seat !== "p3") {
    invalidObservation("Opponent policy kernel requires p2 or p3.", {
      seat: observation.seat,
    });
  }
  if (
    observation.status !== "active" ||
    observation.turn !== observation.seat
  ) {
    invalidObservation(
      "Opponent policy kernel requires an active decision for its actor.",
      {
        seat: observation.seat,
        status: observation.status,
        turn: observation.turn,
      },
    );
  }
  if (
    !Number.isSafeInteger(observation.decisionOrdinal) ||
    observation.decisionOrdinal < 0
  ) {
    invalidObservation(
      "Policy decisionOrdinal must be a nonnegative safe integer.",
      { decisionOrdinal: observation.decisionOrdinal },
    );
  }
  try {
    assertUniqueCards(observation.ownHand, "policy own hand");
    assertUniqueCards(observation.legalCards, "policy legal cards");
  } catch (cause) {
    invalidObservation(
      "Policy observation contains duplicate cards.",
      {},
      cause,
    );
  }
  if (
    observation.legalCards.some((card) => !observation.ownHand.includes(card))
  ) {
    invalidObservation("Every legal card must belong to the acting opponent.", {
      seat: observation.seat,
      ownHand: observation.ownHand,
      legalCards: observation.legalCards,
    });
  }
  const takeTargets = observation.legalTakeTargets ?? [];
  if (
    new Set(takeTargets).size !== takeTargets.length ||
    takeTargets.some((seat) => !SEATS.includes(seat))
  ) {
    invalidObservation("Policy take targets must be unique valid seats.", {
      takeTargets,
    });
  }
  if (observation.legalCards.length === 0 && takeTargets.length === 0) {
    invalidObservation("Policy observation has no legal action.");
  }
}

export function evaluateActorSafePolicy(input: {
  readonly observation: PolicyObservation;
  readonly modelId: BehaviorModelId;
  readonly config?: BehaviorModelConfigInput | BehaviorModelConfig;
}): ActorSafePolicyDistribution {
  const { observation, modelId } = input;
  assertActorSafeObservation(observation);
  if (!BEHAVIOR_MODEL_IDS.includes(modelId)) {
    invalidObservation("Opponent policy kernel received an unknown model.", {
      modelId,
    });
  }
  let config: BehaviorModelConfig;
  try {
    config = validateBehaviorModelConfig(input.config ?? {});
  } catch (cause) {
    throw new AdvancedSearchContractError(
      "INVALID_CONFIG",
      "Opponent policy kernel received invalid behavior configuration.",
      { modelId },
      { cause },
    );
  }
  let distribution;
  try {
    distribution = behaviorModelDistribution(modelId, observation, config);
  } catch (cause) {
    invalidObservation(
      "Behavior policy could not evaluate the actor-safe observation.",
      { seat: observation.seat, modelId },
      cause,
    );
  }
  const probabilities = [...distribution.probabilities]
    .sort((left, right) => left.actionKey.localeCompare(right.actionKey))
    .map((entry) => ({
      action:
        entry.action.kind === "play-card"
          ? { kind: "play-card" as const, card: entry.action.card }
          : { kind: "take-hand" as const, target: entry.action.target },
      actionKey: entry.actionKey,
      probability: entry.probability,
    }));
  const total = probabilities.reduce(
    (sum, entry) => sum + entry.probability,
    0,
  );
  if (
    probabilities.length === 0 ||
    probabilities.some(
      (entry) => !Number.isFinite(entry.probability) || entry.probability <= 0,
    ) ||
    Math.abs(total - 1) > NORMALIZATION_TOLERANCE
  ) {
    invalidObservation("Behavior policy returned invalid probabilities.", {
      seat: observation.seat,
      modelId,
      total,
    });
  }
  const observationHash = stableHash({
    schemaVersion: 1,
    observation,
  });
  const configHash = stableHash({
    schemaVersion: 1,
    behaviorModelHash: BEHAVIOR_MODEL_HASH,
    config,
  });
  const content = {
    schemaVersion: 1 as const,
    kernelVersion: ACTOR_SAFE_POLICY_KERNEL_VERSION,
    behaviorModelHash: BEHAVIOR_MODEL_HASH,
    seat: observation.seat,
    decisionOrdinal: observation.decisionOrdinal,
    modelId,
    preferredActionKey: distribution.preferredActionKey,
    observationHash,
    configHash,
    probabilities,
  };
  return deepFreeze({
    ...content,
    distributionHash: stableHash(content),
  });
}
