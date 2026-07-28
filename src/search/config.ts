import {
  BASELINE_POLICY_IDS,
  baselinePolicyDefinitions,
  type BaselinePolicyId,
} from "../agents/policies";
import { stableHash } from "../events/stable-hash";
import { normalizeSeed, RNG_ALGORITHM } from "../random/keyed-rng";
import {
  SEARCH_ALGORITHM_VERSION,
  type SolverBudget,
  type SolverBudgetId,
  type SolverPolicyConfig,
  type SolverSeedSet,
} from "./types";

export const DEFAULT_SOLVER_SEEDS: SolverSeedSet = Object.freeze({
  belief: "getaway-solver-v1/belief",
  search: "getaway-solver-v1/search",
  rollout: "getaway-solver-v1/rollout",
  chance: "getaway-solver-v1/chance",
  bootstrap: "getaway-solver-v1/bootstrap",
});

export const DEFAULT_SOLVER_POLICIES: SolverPolicyConfig = Object.freeze({
  userContinuation: "documented-basic",
  p2: "documented-basic",
  p3: "documented-basic",
});

export const SOLVER_BUDGETS: Readonly<Record<SolverBudgetId, SolverBudget>> =
  Object.freeze({
    instant: Object.freeze({
      id: "instant",
      worldSamples: 1,
      rolloutsPerWorld: 1,
      maxEventsPerRollout: 1_024,
      intervalResamples: 256,
      deadlineMs: 500,
    }),
    balanced: Object.freeze({
      id: "balanced",
      worldSamples: 4,
      rolloutsPerWorld: 1,
      maxEventsPerRollout: 1_024,
      intervalResamples: 512,
      deadlineMs: 2_500,
    }),
    deep: Object.freeze({
      id: "deep",
      worldSamples: 16,
      rolloutsPerWorld: 2,
      maxEventsPerRollout: 1_024,
      intervalResamples: 1_000,
      deadlineMs: 15_000,
    }),
    offline: Object.freeze({
      id: "offline",
      worldSamples: 64,
      rolloutsPerWorld: 4,
      maxEventsPerRollout: 2_048,
      intervalResamples: 2_000,
      deadlineMs: 60_000,
    }),
  });

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

export function solverBudget(
  id: SolverBudgetId = "balanced",
  overrides: Partial<Omit<SolverBudget, "id">> = {},
): SolverBudget {
  const value: SolverBudget = {
    ...SOLVER_BUDGETS[id],
    ...overrides,
    id,
  };
  positiveSafeInteger(value.worldSamples, "worldSamples");
  positiveSafeInteger(value.rolloutsPerWorld, "rolloutsPerWorld");
  positiveSafeInteger(value.maxEventsPerRollout, "maxEventsPerRollout");
  positiveSafeInteger(value.intervalResamples, "intervalResamples");
  positiveSafeInteger(value.deadlineMs, "deadlineMs");
  return Object.freeze(value);
}

function baselinePolicyId(value: string, label: string): BaselinePolicyId {
  if (!BASELINE_POLICY_IDS.some((candidate) => candidate === value)) {
    throw new RangeError(`${label} names unknown baseline policy ${value}.`);
  }
  return value as BaselinePolicyId;
}

export function validateSolverPolicies(value: SolverPolicyConfig): Readonly<{
  userContinuation: BaselinePolicyId;
  p2: BaselinePolicyId;
  p3: BaselinePolicyId;
}> {
  return Object.freeze({
    userContinuation: baselinePolicyId(
      value.userContinuation,
      "userContinuation",
    ),
    p2: baselinePolicyId(value.p2, "p2"),
    p3: baselinePolicyId(value.p3, "p3"),
  });
}

export function normalizeSolverSeeds(
  value: Partial<SolverSeedSet> = {},
): SolverSeedSet {
  const seeds = { ...DEFAULT_SOLVER_SEEDS, ...value };
  for (const [name, seed] of Object.entries(seeds)) {
    if (seed.trim().length === 0) {
      throw new RangeError(`${name} seed must not be empty.`);
    }
  }
  return Object.freeze(seeds);
}

export function solverSeedIds(
  seeds: SolverSeedSet,
): Readonly<Record<keyof SolverSeedSet, string>> {
  return Object.freeze({
    belief: normalizeSeed(seeds.belief).id,
    search: normalizeSeed(seeds.search).id,
    rollout: normalizeSeed(seeds.rollout).id,
    chance: normalizeSeed(seeds.chance).id,
    bootstrap: normalizeSeed(seeds.bootstrap).id,
  });
}

export function solverConfigurationHash(value: {
  readonly budget: SolverBudget;
  readonly policies: SolverPolicyConfig;
  readonly seeds: SolverSeedSet;
}): string {
  return stableHash({
    schemaVersion: 1,
    searchAlgorithmVersion: SEARCH_ALGORITHM_VERSION,
    rngAlgorithmVersion: RNG_ALGORITHM,
    budget: value.budget,
    policies: value.policies,
    policyDefinitions: baselinePolicyDefinitions().filter((definition) =>
      Object.values(value.policies).includes(definition.id),
    ),
    seedIds: solverSeedIds(value.seeds),
  });
}
