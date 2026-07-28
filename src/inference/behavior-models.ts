import { sortCards, type Card } from "../domain/cards";
import { SEATS, type Seat } from "../domain/seats";
import { stableHash } from "../events/stable-hash";
import { createSeededRng } from "../random/keyed-rng";
import {
  getBaselinePolicy,
  type BaselinePolicyId,
  type PolicyObservation,
} from "../agents/policies";
import { HardInferenceError } from "./error";

export const BEHAVIOR_MODEL_ALGORITHM_VERSION =
  "behavior-model-family-v1" as const;

/**
 * Production behavioral inference deliberately excludes composite and
 * time-varying policies. Every member is either a uniform random policy or a
 * deterministic, inspectable baseline archetype.
 */
export const BEHAVIOR_MODEL_IDS = [
  "random",
  "always-high",
  "always-low",
  "shortest-suit",
  "early-high-shedder",
  "power-avoider",
  "documented-basic",
] as const satisfies readonly BaselinePolicyId[];

export type BehaviorModelId = (typeof BEHAVIOR_MODEL_IDS)[number];

export type BehaviorAction =
  | {
      readonly kind: "play-card";
      readonly card: Card;
    }
  | {
      readonly kind: "take-hand";
      readonly target: Seat;
    };

export type BehaviorActionKey = `play:${Card}` | `take:${Seat}`;

export type BehaviorActionProbability = {
  readonly action: BehaviorAction;
  readonly actionKey: BehaviorActionKey;
  readonly probability: number;
};

export type BehaviorModelDistribution = {
  readonly modelId: BehaviorModelId;
  readonly preferredActionKey: BehaviorActionKey | null;
  readonly probabilities: readonly BehaviorActionProbability[];
};

export type BehaviorModelConfig = {
  readonly lapseProbability: number;
  readonly likelihoodPower: number;
  readonly maximumBayesFactor: number;
  readonly modelPriors: Readonly<Record<BehaviorModelId, number>>;
};

export type BehaviorModelConfigInput = {
  readonly lapseProbability?: number;
  readonly likelihoodPower?: number;
  readonly maximumBayesFactor?: number;
  readonly modelPriors?: Partial<Record<BehaviorModelId, number>>;
};

export type TemperedBehaviorLikelihoods = {
  readonly rawLikelihoods: readonly number[];
  readonly temperedLikelihoods: readonly number[];
  readonly effectiveLikelihoodPower: number;
  readonly rawBayesFactor: number;
  readonly temperedBayesFactor: number;
  readonly capApplied: boolean;
};

const DEFAULT_PRIOR = 1 / BEHAVIOR_MODEL_IDS.length;

export const DEFAULT_BEHAVIOR_MODEL_CONFIG: BehaviorModelConfig =
  deepFreezeBehavior({
    lapseProbability: 0.08,
    likelihoodPower: 0.5,
    maximumBayesFactor: 4,
    modelPriors: Object.fromEntries(
      BEHAVIOR_MODEL_IDS.map((modelId) => [modelId, DEFAULT_PRIOR]),
    ) as Record<BehaviorModelId, number>,
  });

export const BEHAVIOR_MODEL_HASH = stableHash({
  schemaVersion: 1,
  algorithmVersion: BEHAVIOR_MODEL_ALGORITHM_VERSION,
  members: BEHAVIOR_MODEL_IDS.map((id) => ({
    id,
    baselinePolicyVersion: getBaselinePolicy(id).version,
    distribution:
      id === "random"
        ? "uniform-all-legal-actions"
        : "preferred-plus-uniform-lapse-all-legal-actions",
  })),
});

export function deepFreezeBehavior<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeBehavior(child);
    }
    Object.freeze(value);
  }
  return value;
}

function invalidConfig(
  message: string,
  details: Readonly<Record<string, unknown>>,
): never {
  throw new HardInferenceError("INVALID_CONFIG", message, { details });
}

export function validateBehaviorModelConfig(
  input: BehaviorModelConfigInput = {},
): BehaviorModelConfig {
  const lapseProbability =
    input.lapseProbability ?? DEFAULT_BEHAVIOR_MODEL_CONFIG.lapseProbability;
  const likelihoodPower =
    input.likelihoodPower ?? DEFAULT_BEHAVIOR_MODEL_CONFIG.likelihoodPower;
  const maximumBayesFactor =
    input.maximumBayesFactor ??
    DEFAULT_BEHAVIOR_MODEL_CONFIG.maximumBayesFactor;

  if (
    !Number.isFinite(lapseProbability) ||
    lapseProbability <= 0 ||
    lapseProbability >= 1
  ) {
    invalidConfig(
      "lapseProbability must be finite and strictly between 0 and 1.",
      {
        lapseProbability,
      },
    );
  }
  if (
    !Number.isFinite(likelihoodPower) ||
    likelihoodPower <= 0 ||
    likelihoodPower > 1
  ) {
    invalidConfig("likelihoodPower must be finite and in (0, 1].", {
      likelihoodPower,
    });
  }
  if (
    !Number.isFinite(maximumBayesFactor) ||
    maximumBayesFactor <= 1 ||
    maximumBayesFactor > 4
  ) {
    invalidConfig("maximumBayesFactor must be finite and in (1, 4].", {
      maximumBayesFactor,
    });
  }

  const suppliedPriors = input.modelPriors ?? {};
  const unknownModelIds = Object.keys(suppliedPriors).filter(
    (key) => !BEHAVIOR_MODEL_IDS.includes(key as BehaviorModelId),
  );
  if (unknownModelIds.length > 0) {
    invalidConfig("modelPriors contains an unknown behavior model.", {
      unknownModelIds,
    });
  }

  const unnormalized = Object.fromEntries(
    BEHAVIOR_MODEL_IDS.map((modelId) => [
      modelId,
      suppliedPriors[modelId] ??
        DEFAULT_BEHAVIOR_MODEL_CONFIG.modelPriors[modelId],
    ]),
  ) as Record<BehaviorModelId, number>;
  for (const modelId of BEHAVIOR_MODEL_IDS) {
    const prior = unnormalized[modelId];
    if (!Number.isFinite(prior) || prior <= 0) {
      invalidConfig("Every behavior-model prior must be finite and positive.", {
        modelId,
        prior,
      });
    }
  }
  const total = BEHAVIOR_MODEL_IDS.reduce(
    (sum, modelId) => sum + unnormalized[modelId],
    0,
  );
  if (!Number.isFinite(total) || total <= 0) {
    invalidConfig("Behavior-model priors cannot be normalized safely.", {
      total,
    });
  }
  const modelPriors = Object.fromEntries(
    BEHAVIOR_MODEL_IDS.map((modelId) => [
      modelId,
      unnormalized[modelId] / total,
    ]),
  ) as Record<BehaviorModelId, number>;

  return deepFreezeBehavior({
    lapseProbability,
    likelihoodPower,
    maximumBayesFactor,
    modelPriors,
  });
}

export function behaviorActionKey(action: BehaviorAction): BehaviorActionKey {
  return action.kind === "play-card"
    ? `play:${action.card}`
    : `take:${action.target}`;
}

/**
 * Applies a per-observation analytic cap to likelihood ratios. The adaptive
 * exponent is derived from log(cap) / log(raw ratio), so the guarantee does
 * not depend on the number of legal actions.
 */
export function temperBehaviorLikelihoods(
  likelihoodsValue: readonly number[],
  configValue: BehaviorModelConfigInput | BehaviorModelConfig = {},
): TemperedBehaviorLikelihoods {
  const config = validateBehaviorModelConfig(configValue);
  if (likelihoodsValue.length === 0) {
    throw new HardInferenceError(
      "INVARIANT_VIOLATION",
      "Behavioral tempering requires at least one model likelihood.",
    );
  }
  const rawLikelihoods = [...likelihoodsValue];
  if (
    rawLikelihoods.some(
      (likelihood) => !Number.isFinite(likelihood) || likelihood <= 0,
    )
  ) {
    throw new HardInferenceError(
      "INVARIANT_VIOLATION",
      "Behavioral tempering requires finite, strictly positive likelihoods.",
      { details: { rawLikelihoods } },
    );
  }
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const likelihood of rawLikelihoods) {
    minimum = Math.min(minimum, likelihood);
    maximum = Math.max(maximum, likelihood);
  }
  const rawBayesFactor = maximum / minimum;
  const capPower =
    rawBayesFactor <= 1
      ? config.likelihoodPower
      : Math.log(config.maximumBayesFactor) / Math.log(rawBayesFactor);
  const effectiveLikelihoodPower = Math.min(config.likelihoodPower, capPower);
  const temperedLikelihoods = rawLikelihoods.map(
    (likelihood) => likelihood ** effectiveLikelihoodPower,
  );
  let temperedMinimum = Number.POSITIVE_INFINITY;
  let temperedMaximum = Number.NEGATIVE_INFINITY;
  for (const likelihood of temperedLikelihoods) {
    temperedMinimum = Math.min(temperedMinimum, likelihood);
    temperedMaximum = Math.max(temperedMaximum, likelihood);
  }
  const temperedBayesFactor = temperedMaximum / temperedMinimum;
  const roundingAllowance = config.maximumBayesFactor * Number.EPSILON * 16;
  if (
    !Number.isFinite(temperedBayesFactor) ||
    temperedBayesFactor > config.maximumBayesFactor + roundingAllowance
  ) {
    throw new HardInferenceError(
      "INVARIANT_VIOLATION",
      "Tempered behavioral likelihoods exceeded the analytic Bayes-factor cap.",
      {
        details: {
          rawBayesFactor,
          temperedBayesFactor,
          maximumBayesFactor: config.maximumBayesFactor,
          effectiveLikelihoodPower,
        },
      },
    );
  }
  return deepFreezeBehavior({
    rawLikelihoods,
    temperedLikelihoods,
    effectiveLikelihoodPower,
    rawBayesFactor,
    temperedBayesFactor,
    capApplied: effectiveLikelihoodPower < config.likelihoodPower,
  });
}

export function enumerateBehaviorActions(
  observation: PolicyObservation,
): readonly BehaviorAction[] {
  const actions: BehaviorAction[] = sortCards(observation.legalCards).map(
    (card) => ({ kind: "play-card", card }),
  );
  const legalTargets = new Set(observation.legalTakeTargets ?? []);
  for (const seat of SEATS) {
    if (legalTargets.has(seat)) {
      actions.push({ kind: "take-hand", target: seat });
    }
  }
  const unique = new Map<BehaviorActionKey, BehaviorAction>();
  for (const action of actions) {
    unique.set(behaviorActionKey(action), action);
  }
  return deepFreezeBehavior([...unique.values()]);
}

function deterministicPreferredAction(
  modelId: Exclude<BehaviorModelId, "random">,
  observation: PolicyObservation,
  actions: readonly BehaviorAction[],
): BehaviorAction {
  const policy = getBaselinePolicy(modelId);
  const rng = createSeededRng(
    "behavior-model-deterministic-preference-v1",
  ).fork(modelId, observation.seat, observation.decisionOrdinal);
  const legalActionKeys = new Set(actions.map(behaviorActionKey));
  const preferredTake = policy.chooseTakeTarget?.(
    observation,
    rng.fork("take"),
  );
  if (preferredTake !== undefined && preferredTake !== null) {
    const action: BehaviorAction = {
      kind: "take-hand",
      target: preferredTake,
    };
    if (legalActionKeys.has(behaviorActionKey(action))) {
      return action;
    }
  }
  if (observation.legalCards.length === 0) {
    const onlyAvailableTake = actions.find(
      (action) => action.kind === "take-hand",
    );
    if (onlyAvailableTake !== undefined) {
      return onlyAvailableTake;
    }
  }

  const choice = policy.chooseCard(observation, rng.fork("card"));
  const action: BehaviorAction = { kind: "play-card", card: choice.card };
  if (!legalActionKeys.has(behaviorActionKey(action))) {
    throw new HardInferenceError(
      "INVARIANT_VIOLATION",
      `${modelId} selected an action outside the actor's legal alternatives.`,
      {
        details: {
          modelId,
          selectedActionKey: behaviorActionKey(action),
          legalActionKeys: [...legalActionKeys],
        },
      },
    );
  }
  return action;
}

function behaviorModelDistributionWithConfig(
  modelId: BehaviorModelId,
  observation: PolicyObservation,
  config: BehaviorModelConfig,
): BehaviorModelDistribution {
  const actions = enumerateBehaviorActions(observation);
  if (actions.length === 0) {
    throw new HardInferenceError(
      "INVALID_PUBLIC_HISTORY",
      "An observed opponent decision has no legal card or take-hand action.",
      {
        details: {
          modelId,
          seat: observation.seat,
          decisionOrdinal: observation.decisionOrdinal,
        },
      },
    );
  }

  if (actions.length === 1) {
    const action = actions[0];
    if (action === undefined) {
      throw new HardInferenceError(
        "INVARIANT_VIOLATION",
        "A singleton legal-action set is unexpectedly empty.",
      );
    }
    return deepFreezeBehavior({
      modelId,
      preferredActionKey:
        modelId === "random" ? null : behaviorActionKey(action),
      probabilities: [
        {
          action,
          actionKey: behaviorActionKey(action),
          probability: 1,
        },
      ],
    });
  }

  if (modelId === "random") {
    const probability = 1 / actions.length;
    return deepFreezeBehavior({
      modelId,
      preferredActionKey: null,
      probabilities: actions.map((action) => ({
        action,
        actionKey: behaviorActionKey(action),
        probability,
      })),
    });
  }

  const preferred = deterministicPreferredAction(modelId, observation, actions);
  const preferredActionKey = behaviorActionKey(preferred);
  const lapseShare = config.lapseProbability / actions.length;
  return deepFreezeBehavior({
    modelId,
    preferredActionKey,
    probabilities: actions.map((action) => ({
      action,
      actionKey: behaviorActionKey(action),
      probability:
        lapseShare +
        (behaviorActionKey(action) === preferredActionKey
          ? 1 - config.lapseProbability
          : 0),
    })),
  });
}

export function behaviorModelDistribution(
  modelId: BehaviorModelId,
  observation: PolicyObservation,
  configValue: BehaviorModelConfigInput | BehaviorModelConfig = {},
): BehaviorModelDistribution {
  return behaviorModelDistributionWithConfig(
    modelId,
    observation,
    validateBehaviorModelConfig(configValue),
  );
}

export function allBehaviorModelDistributions(
  observation: PolicyObservation,
  configValue: BehaviorModelConfigInput | BehaviorModelConfig = {},
): Readonly<Record<BehaviorModelId, BehaviorModelDistribution>> {
  const config = validateBehaviorModelConfig(configValue);
  return deepFreezeBehavior(
    Object.fromEntries(
      BEHAVIOR_MODEL_IDS.map((modelId) => [
        modelId,
        behaviorModelDistributionWithConfig(modelId, observation, config),
      ]),
    ) as Record<BehaviorModelId, BehaviorModelDistribution>,
  );
}

export function probabilityOfBehaviorAction(
  distribution: BehaviorModelDistribution,
  observedAction: BehaviorAction,
): number {
  const actionKey = behaviorActionKey(observedAction);
  const match = distribution.probabilities.find(
    (entry) => entry.actionKey === actionKey,
  );
  if (match === undefined) {
    throw new HardInferenceError(
      "INVALID_PUBLIC_HISTORY",
      `Observed action ${actionKey} is not legal in the actor-safe observation.`,
      {
        details: {
          modelId: distribution.modelId,
          observedActionKey: actionKey,
          legalActionKeys: distribution.probabilities.map(
            (entry) => entry.actionKey,
          ),
        },
      },
    );
  }
  return match.probability;
}
