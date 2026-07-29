import { describe, expect, it } from "vitest";

import {
  DEFAULT_SOLVER_POLICIES,
  DEFAULT_SOLVER_SEEDS,
  normalizeSolverSeeds,
  SOLVER_BUDGETS,
  solverBudget,
  solverConfigurationHash,
  solverSeedIds,
  validateSolverPolicies,
} from "../../src/search/config";
import {
  SOLVER_BUDGET_IDS,
  type SolverBudget,
  type SolverPolicyConfig,
  type SolverSeedSet,
} from "../../src/search/types";

describe("solver budgets", () => {
  it("locks the named deterministic-work presets", () => {
    expect(SOLVER_BUDGET_IDS).toEqual([
      "instant",
      "balanced",
      "deep",
      "offline",
    ]);
    expect(SOLVER_BUDGETS).toEqual({
      instant: {
        id: "instant",
        worldSamples: 1,
        rolloutsPerWorld: 1,
        maxEventsPerRollout: 1_024,
        intervalResamples: 256,
        deadlineMs: 500,
      },
      balanced: {
        id: "balanced",
        worldSamples: 4,
        rolloutsPerWorld: 1,
        maxEventsPerRollout: 1_024,
        intervalResamples: 512,
        deadlineMs: 2_500,
      },
      deep: {
        id: "deep",
        worldSamples: 16,
        rolloutsPerWorld: 2,
        maxEventsPerRollout: 1_024,
        intervalResamples: 1_000,
        deadlineMs: 15_000,
      },
      offline: {
        id: "offline",
        worldSamples: 64,
        rolloutsPerWorld: 4,
        maxEventsPerRollout: 2_048,
        intervalResamples: 2_000,
        deadlineMs: 60_000,
      },
    });
  });

  it("defaults to balanced, applies overrides, and freezes the result", () => {
    const budget = solverBudget("balanced", {
      worldSamples: 11,
      rolloutsPerWorld: 3,
    });

    expect(budget).toEqual({
      ...SOLVER_BUDGETS.balanced,
      worldSamples: 11,
      rolloutsPerWorld: 3,
    });
    expect(Object.isFrozen(budget)).toBe(true);
    expect(SOLVER_BUDGETS.balanced.worldSamples).toBe(4);
    expect(solverBudget()).toEqual(SOLVER_BUDGETS.balanced);
  });

  const numericBudgetFields = [
    "worldSamples",
    "rolloutsPerWorld",
    "maxEventsPerRollout",
    "intervalResamples",
    "deadlineMs",
  ] as const;

  it.each(numericBudgetFields)("rejects an invalid %s override", (field) => {
    for (const invalid of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const overrides: Partial<Omit<SolverBudget, "id">> = {
        [field]: invalid,
      };
      expect(() => solverBudget("instant", overrides)).toThrow(RangeError);
    }
  });
});

describe("solver policy validation", () => {
  it("accepts known policies and returns a detached frozen selection", () => {
    const input: SolverPolicyConfig = {
      userContinuation: "always-low",
      p2: "documented-basic",
      p3: "noisy-mixture",
    };
    const validated = validateSolverPolicies(input);

    expect(validated).toEqual(input);
    expect(validated).not.toBe(input);
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it.each(["userContinuation", "p2", "p3"] as const)(
    "rejects an unknown %s policy",
    (seat) => {
      const policies: SolverPolicyConfig = {
        ...DEFAULT_SOLVER_POLICIES,
        [seat]: "unknown-policy",
      };

      expect(() => validateSolverPolicies(policies)).toThrow(
        /unknown baseline policy/u,
      );
    },
  );
});

describe("solver seed normalization and configuration hashes", () => {
  it("merges partial seeds with defaults and freezes the result", () => {
    const seeds = normalizeSolverSeeds({ search: "custom-search" });

    expect(seeds).toEqual({
      ...DEFAULT_SOLVER_SEEDS,
      search: "custom-search",
    });
    expect(Object.isFrozen(seeds)).toBe(true);
    expect(normalizeSolverSeeds()).toEqual(DEFAULT_SOLVER_SEEDS);
  });

  it.each(["belief", "search", "rollout", "chance", "bootstrap"] as const)(
    "rejects an empty %s seed",
    (name) => {
      const invalid: Partial<SolverSeedSet> = { [name]: " \t\r\n" };

      expect(() => normalizeSolverSeeds(invalid)).toThrow(
        `${name} seed must not be empty.`,
      );
    },
  );

  it("preserves fixed IDs for every default independent stream", () => {
    const seeds = normalizeSolverSeeds();

    expect(solverSeedIds(seeds)).toEqual({
      belief: "splitmix64-counter-v1:df58d28e13250d11",
      search: "splitmix64-counter-v1:4a9a21dddf8b8d4e",
      rollout: "splitmix64-counter-v1:6aa1ca29dcb55020",
      chance: "splitmix64-counter-v1:9403f8ce877bebd4",
      bootstrap: "splitmix64-counter-v1:3bd6e17c286d05d7",
    });
    expect(solverSeedIds(seeds)).toEqual(solverSeedIds(structuredClone(seeds)));
  });

  it("has a fixed default configuration hash independent of object key order", () => {
    const budget = solverBudget("balanced");
    const seeds = normalizeSolverSeeds();
    const hash = solverConfigurationHash({
      budget,
      policies: DEFAULT_SOLVER_POLICIES,
      seeds,
    });
    const reorderedBudget: SolverBudget = {
      deadlineMs: budget.deadlineMs,
      intervalResamples: budget.intervalResamples,
      maxEventsPerRollout: budget.maxEventsPerRollout,
      rolloutsPerWorld: budget.rolloutsPerWorld,
      worldSamples: budget.worldSamples,
      id: budget.id,
    };
    const reorderedPolicies: SolverPolicyConfig = {
      p3: DEFAULT_SOLVER_POLICIES.p3,
      p2: DEFAULT_SOLVER_POLICIES.p2,
      userContinuation: DEFAULT_SOLVER_POLICIES.userContinuation,
    };
    const reorderedSeeds: SolverSeedSet = {
      bootstrap: seeds.bootstrap,
      chance: seeds.chance,
      rollout: seeds.rollout,
      search: seeds.search,
      belief: seeds.belief,
    };

    expect(hash).toBe("fnv1a64:cc223720d5121b4f");
    expect(
      solverConfigurationHash({
        budget: reorderedBudget,
        policies: reorderedPolicies,
        seeds: reorderedSeeds,
      }),
    ).toBe(hash);
  });

  it("binds budget, policy, and seed changes into the hash", () => {
    const budget = solverBudget("balanced");
    const seeds = normalizeSolverSeeds();
    const original = solverConfigurationHash({
      budget,
      policies: DEFAULT_SOLVER_POLICIES,
      seeds,
    });

    expect(
      solverConfigurationHash({
        budget: solverBudget("balanced", { worldSamples: 9 }),
        policies: DEFAULT_SOLVER_POLICIES,
        seeds,
      }),
    ).not.toBe(original);
    expect(
      solverConfigurationHash({
        budget,
        policies: {
          ...DEFAULT_SOLVER_POLICIES,
          p2: "always-high",
        },
        seeds,
      }),
    ).not.toBe(original);
    expect(
      solverConfigurationHash({
        budget,
        policies: DEFAULT_SOLVER_POLICIES,
        seeds: normalizeSolverSeeds({ belief: "changed-belief" }),
      }),
    ).not.toBe(original);
  });
});
