import type { BaselinePolicyId } from "../agents/policies";
import type { Card } from "../domain/cards";
import { SEATS, type Seat } from "../domain/seats";
import type { GameEvent } from "../events/game-events";
import { stableHash } from "../events/stable-hash";
import {
  activeTimelineEvents,
  replayEvents,
  replayTimeline,
  type GameTimeline,
} from "../events/timeline";
import { buildHardBelief } from "../inference/belief";
import type {
  HardBelief,
  HardBeliefMethod,
  HiddenWorld,
} from "../inference/types";
import type { PublicInformationState } from "../public/public-state";
import type { ExactHands } from "../rules/exact-hand-transition";
import { actionKey, compareUserActions, legalUserActions } from "./actions";
import {
  DEFAULT_SOLVER_POLICIES,
  normalizeSolverSeeds,
  solverBudget,
  solverConfigurationHash,
  solverSeedIds,
  validateSolverPolicies,
} from "./config";
import { runTerminalRollout } from "./rollout";
import {
  clusterWilsonInterval,
  mean,
  pairedBootstrapDifference,
} from "./statistics";
import {
  SEARCH_ALGORITHM_VERSION,
  SearchError,
  type ActionEstimate,
  type BaselineRecommendation,
  type BaselineRecommendationPayload,
  type DifferenceInterval,
  type RolloutOutcome,
  type SolverBudget,
  type SolverBudgetId,
  type SolverPolicyConfig,
  type SolverSeedSet,
  type UserAction,
} from "./types";

export type SearchScenario = {
  readonly witnessId: string;
  readonly currentHands: Readonly<Record<Seat, readonly Card[]>>;
};

type BeliefEnvelope = {
  readonly method: HardBeliefMethod;
  readonly totalInitialDealWorlds: string;
  readonly worldSetChecksum: string;
  readonly uniqueWitnesses: number;
};

export type ScenarioAnalysisRequest = {
  readonly publicState: PublicInformationState;
  readonly historyHash: string;
  readonly stateVersion: number;
  readonly activeEvents?: readonly GameEvent[];
  readonly scenarios: readonly SearchScenario[];
  readonly belief: BeliefEnvelope;
  readonly budget: SolverBudget;
  readonly policies?: SolverPolicyConfig;
  readonly seeds?: Partial<SolverSeedSet>;
  readonly shouldCancel?: () => boolean;
};

export type TimelineRecommendationRequest = {
  readonly timeline: GameTimeline;
  readonly budgetId?: SolverBudgetId;
  readonly budgetOverrides?: Partial<Omit<SolverBudget, "id">>;
  readonly policies?: SolverPolicyConfig;
  readonly seeds?: Partial<SolverSeedSet>;
  readonly signal?: AbortSignal;
};

export type PreparedTimelineRecommendation = {
  readonly analysisRequest: ScenarioAnalysisRequest;
  readonly hardBelief: HardBelief;
};

type CandidateWork = {
  readonly action: UserAction;
  readonly actionKey: string;
  readonly outcomes: readonly RolloutOutcome[];
  readonly clusterRisks: readonly number[];
  readonly risk: number;
};

const STOCHASTIC_POLICY_IDS = new Set<BaselinePolicyId>([
  "random",
  "noisy-mixture",
]);

function clockNow(): number {
  return globalThis.performance.now();
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function cloneExactHands(
  hands: Readonly<Record<Seat, readonly Card[]>>,
): ExactHands {
  return {
    user: [...hands.user],
    p2: [...hands.p2],
    p3: [...hands.p3],
  };
}

function probability(
  outcomes: readonly RolloutOutcome[],
  predicate: (outcome: RolloutOutcome) => boolean,
): number {
  return outcomes.filter(predicate).length / outcomes.length;
}

function clusterRisks(
  outcomes: readonly RolloutOutcome[],
  scenarioCount: number,
  replicatesPerScenario: number,
): number[] {
  const result: number[] = [];
  for (let scenario = 0; scenario < scenarioCount; scenario += 1) {
    const cluster = outcomes.filter(
      (outcome) => outcome.scenarioOccurrence === scenario,
    );
    if (cluster.length !== replicatesPerScenario) {
      throw new SearchError(
        "INVARIANT_VIOLATION",
        `Scenario ${scenario.toString()} has ${cluster.length.toString()} outcomes instead of ${replicatesPerScenario.toString()}.`,
      );
    }
    result.push(
      cluster.reduce(
        (total, outcome) => total + outcome.terminal.loss.user,
        0,
      ) / cluster.length,
    );
  }
  return result;
}

function exactDeterministicDifference(
  candidate: CandidateWork,
  reference: CandidateWork,
  beliefMethod: HardBeliefMethod,
  policies: Readonly<{
    userContinuation: BaselinePolicyId;
    p2: BaselinePolicyId;
    p3: BaselinePolicyId;
  }>,
): DifferenceInterval | null {
  if (
    beliefMethod !== "exact-enumeration" ||
    STOCHASTIC_POLICY_IDS.has(policies.userContinuation) ||
    STOCHASTIC_POLICY_IDS.has(policies.p2) ||
    STOCHASTIC_POLICY_IDS.has(policies.p3) ||
    [...candidate.outcomes, ...reference.outcomes].some(
      (outcome) => outcome.chanceCount > 0,
    )
  ) {
    return null;
  }
  const difference = candidate.risk - reference.risk;
  return {
    level: 0.95,
    method: "exact-enumerated-paired-difference",
    lower: difference,
    upper: difference,
  };
}

function pairedInterval(
  candidate: CandidateWork,
  reference: CandidateWork,
  input: ScenarioAnalysisRequest,
  policies: Readonly<{
    userContinuation: BaselinePolicyId;
    p2: BaselinePolicyId;
    p3: BaselinePolicyId;
  }>,
  seeds: SolverSeedSet,
): DifferenceInterval {
  return (
    exactDeterministicDifference(
      candidate,
      reference,
      input.belief.method,
      policies,
    ) ??
    pairedBootstrapDifference(
      candidate.clusterRisks,
      reference.clusterRisks,
      input.budget.intervalResamples,
      stableHash({
        schemaVersion: 1,
        bootstrapSeed: seeds.bootstrap,
        candidate: candidate.actionKey,
        reference: reference.actionKey,
      }),
    )
  );
}

function candidateEstimate(
  candidate: CandidateWork,
  recommended: CandidateWork,
  input: ScenarioAnalysisRequest,
  policies: Readonly<{
    userContinuation: BaselinePolicyId;
    p2: BaselinePolicyId;
    p3: BaselinePolicyId;
  }>,
  seeds: SolverSeedSet,
): ActionEstimate {
  const outcomes = candidate.outcomes;
  const interval = pairedInterval(
    candidate,
    recommended,
    input,
    policies,
    seeds,
  );
  const difference = candidate.risk - recommended.risk;
  return {
    action: candidate.action,
    actionKey: candidate.actionKey,
    terminalRollouts: outcomes.length,
    scenarioClusters: input.scenarios.length,
    userBhabhiCount: outcomes.reduce(
      (total, outcome) => total + outcome.terminal.loss.user,
      0,
    ),
    bhabhiProbability: candidate.risk,
    safeProbability: 1 - candidate.risk,
    interval: clusterWilsonInterval(candidate.clusterRisks),
    userFinishProbabilities: {
      first: probability(
        outcomes,
        (outcome) => outcome.terminal.userFinish === "first",
      ),
      second: probability(
        outcomes,
        (outcome) => outcome.terminal.userFinish === "second",
      ),
      bhabhi: probability(
        outcomes,
        (outcome) => outcome.terminal.userFinish === "bhabhi",
      ),
      tiedSafe: probability(
        outcomes,
        (outcome) => outcome.terminal.userFinish === "tied-safe",
      ),
    },
    bhabhiBySeat: Object.fromEntries(
      SEATS.map((seat) => [
        seat,
        probability(outcomes, (outcome) => outcome.terminal.bhabhi === seat),
      ]),
    ) as Record<Seat, number>,
    immediatePickupProbability: probability(
      outcomes,
      (outcome) => outcome.rootPickup,
    ),
    expectedImmediatePickupCount: mean(
      outcomes.map((outcome) => outcome.rootPickupCount),
    ),
    immediatePowerProbability: probability(
      outcomes,
      (outcome) => outcome.rootPower,
    ),
    firstOpponentEscape: {
      p2: probability(
        outcomes,
        (outcome) => outcome.terminal.firstOpponentEscape === "p2",
      ),
      p3: probability(
        outcomes,
        (outcome) => outcome.terminal.firstOpponentEscape === "p3",
      ),
      tie: probability(
        outcomes,
        (outcome) => outcome.terminal.firstOpponentEscape === "tie",
      ),
      none: probability(
        outcomes,
        (outcome) => outcome.terminal.firstOpponentEscape === null,
      ),
    },
    pairedDifferenceVsRecommended: difference,
    pairedDifferenceInterval: interval,
    approximateTie: interval.lower <= 0 && interval.upper >= 0,
    sampleChecksum: stableHash({
      schemaVersion: 1,
      hashes: outcomes.map((outcome) => outcome.deterministicHash),
    }),
  };
}

function verifyProductionHistory(
  publicState: PublicInformationState,
  historyHash: string,
  activeEvents: readonly GameEvent[],
): void {
  if (activeEvents.length !== publicState.appliedEventCount) {
    throw new SearchError(
      "STALE_WORLD",
      "Active event count does not match the public state.",
      {
        activeEvents: activeEvents.length,
        appliedEventCount: publicState.appliedEventCount,
      },
    );
  }
  const replay = replayEvents(activeEvents);
  if (
    replay.semanticHash !== historyHash ||
    stableHash(replay.state) !== stableHash(publicState)
  ) {
    throw new SearchError(
      "STALE_WORLD",
      "Active events do not reproduce the supplied public state and history hash.",
      {
        expectedHistoryHash: historyHash,
        actualHistoryHash: replay.semanticHash,
        expectedStateHash: stableHash(publicState),
        actualStateHash: stableHash(replay.state),
      },
    );
  }
}

function runCandidateWork(
  input: ScenarioAnalysisRequest,
  action: UserAction,
  policies: Readonly<{
    userContinuation: BaselinePolicyId;
    p2: BaselinePolicyId;
    p3: BaselinePolicyId;
  }>,
  seeds: SolverSeedSet,
): CandidateWork {
  const outcomes: RolloutOutcome[] = [];
  for (
    let scenarioOccurrence = 0;
    scenarioOccurrence < input.scenarios.length;
    scenarioOccurrence += 1
  ) {
    const scenario = input.scenarios[scenarioOccurrence];
    if (scenario === undefined) {
      throw new SearchError(
        "INVARIANT_VIOLATION",
        `Scenario occurrence ${scenarioOccurrence.toString()} is missing.`,
      );
    }
    for (
      let replicate = 0;
      replicate < input.budget.rolloutsPerWorld;
      replicate += 1
    ) {
      if (input.shouldCancel?.() === true) {
        throw new SearchError("CANCELLED", "Search was cancelled.");
      }
      try {
        outcomes.push(
          runTerminalRollout({
            publicState: input.publicState,
            exactHands: cloneExactHands(scenario.currentHands),
            ...(input.activeEvents === undefined
              ? {}
              : { activeEvents: input.activeEvents }),
            action,
            scenarioOccurrence,
            replicate,
            policies,
            seeds,
            budget: input.budget,
            ...(input.shouldCancel === undefined
              ? {}
              : { shouldCancel: input.shouldCancel }),
          }),
        );
      } catch (cause) {
        if (cause instanceof SearchError) {
          throw cause;
        }
        throw new SearchError(
          "INVARIANT_VIOLATION",
          `Terminal rollout failed for ${actionKey(action)} at scenario ${scenarioOccurrence.toString()}, replicate ${replicate.toString()}.`,
          {
            actionKey: actionKey(action),
            scenarioOccurrence,
            replicate,
            witnessId: scenario.witnessId,
          },
          { cause },
        );
      }
    }
  }
  const expected = input.scenarios.length * input.budget.rolloutsPerWorld;
  if (outcomes.length !== expected) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      `${actionKey(action)} produced ${outcomes.length.toString()} terminal outcomes instead of ${expected.toString()}.`,
    );
  }
  const risks = clusterRisks(
    outcomes,
    input.scenarios.length,
    input.budget.rolloutsPerWorld,
  );
  return {
    action,
    actionKey: actionKey(action),
    outcomes,
    clusterRisks: risks,
    risk: mean(risks),
  };
}

function analyzeScenarioSet(
  input: ScenarioAnalysisRequest,
  startedAt: number,
): BaselineRecommendation {
  if (
    !Number.isSafeInteger(input.stateVersion) ||
    input.stateVersion < 0 ||
    input.historyHash.trim().length === 0
  ) {
    throw new SearchError(
      "INVALID_REQUEST",
      "State version and history hash are required.",
    );
  }
  if (input.scenarios.length === 0) {
    throw new SearchError(
      "INVALID_REQUEST",
      "At least one correlated hidden-world occurrence is required.",
    );
  }
  if (input.activeEvents !== undefined) {
    verifyProductionHistory(
      input.publicState,
      input.historyHash,
      input.activeEvents,
    );
  }
  if (
    input.publicState.status !== "active" ||
    input.publicState.turn !== "user" ||
    input.publicState.pendingAction !== null
  ) {
    throw new SearchError(
      "NOT_USER_TURN",
      "Recommendations require an active, non-chance user turn.",
    );
  }
  if (input.shouldCancel?.() === true) {
    throw new SearchError("CANCELLED", "Search was cancelled.");
  }

  const policies = validateSolverPolicies(
    input.policies ?? DEFAULT_SOLVER_POLICIES,
  );
  const seeds = normalizeSolverSeeds(input.seeds);
  const actions = legalUserActions(input.publicState);
  if (actions.length === 0) {
    throw new SearchError(
      "NO_LEGAL_ACTION",
      "The user has no legal root action.",
    );
  }
  const work = actions.map((action) =>
    runCandidateWork(input, action, policies, seeds),
  );
  const recommended = [...work].sort(
    (left, right) =>
      left.risk - right.risk || compareUserActions(left.action, right.action),
  )[0];
  if (recommended === undefined) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      "Search did not produce a recommended candidate.",
    );
  }
  const candidates = work
    .map((candidate) =>
      candidateEstimate(candidate, recommended, input, policies, seeds),
    )
    .sort(
      (left, right) =>
        left.bhabhiProbability - right.bhabhiProbability ||
        compareUserActions(left.action, right.action),
    );
  const completed = work.reduce(
    (total, candidate) => total + candidate.outcomes.length,
    0,
  );
  const expectedCompleted =
    actions.length * input.scenarios.length * input.budget.rolloutsPerWorld;
  if (completed !== expectedCompleted) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      "Search did not complete its fixed deterministic rollout quota.",
      { completed, expectedCompleted },
    );
  }

  const configHash = solverConfigurationHash({
    budget: input.budget,
    policies,
    seeds,
  });
  const publicStateHash = stableHash(input.publicState);
  const analysisId = stableHash({
    schemaVersion: 1,
    algorithmVersion: SEARCH_ALGORITHM_VERSION,
    stateVersion: input.stateVersion,
    historyHash: input.historyHash,
    publicStateHash,
    configHash,
    worldSetChecksum: input.belief.worldSetChecksum,
  });
  const seedIds = solverSeedIds(seeds);
  const outcomeChecksum = stableHash({
    schemaVersion: 1,
    actions: work.map((candidate) => ({
      actionKey: candidate.actionKey,
      outcomes: candidate.outcomes.map((outcome) => outcome.deterministicHash),
    })),
  });
  const warnings = [
    "Approximate terminal rollout under frozen baseline continuation policies; not an exact game-theoretic solution.",
    "Approximate-tie intervals are heuristic paired comparisons against the data-selected minimum.",
    "The search seed is a reserved reproducibility namespace for later tree-search components; Phase 5 root-action ordering is deterministic.",
    ...(input.activeEvents === undefined
      ? [
          "Synthetic-state test path: actor chronology is derived from public rule effects rather than a verified full event ledger.",
        ]
      : []),
    ...(input.belief.method === "direct-uniform-sample"
      ? ["Hidden worlds are direct uniform samples with replacement."]
      : []),
    ...(input.belief.uniqueWitnesses < input.scenarios.length
      ? ["Duplicate sampled world occurrences are retained by design."]
      : []),
    ...(input.publicState.rules.takeHand.mode === "disabled"
      ? []
      : [
          "Bundled continuation policies decline optional future take-hand actions; every legal root take is still evaluated.",
        ]),
  ];
  const payload: BaselineRecommendationPayload = {
    schemaVersion: 1,
    algorithmVersion: SEARCH_ALGORITHM_VERSION,
    method: "hard-belief-terminal-root-rollout",
    quality: "Approximate",
    stateVersion: input.stateVersion,
    historyHash: input.historyHash,
    publicStateHash,
    configHash,
    analysisId,
    budgetId: input.budget.id,
    legalActions: actions,
    recommendedAction: recommended.action,
    recommendedActionKey: recommended.actionKey,
    approximateTieActionKeys: candidates
      .filter((candidate) => candidate.approximateTie)
      .map((candidate) => candidate.actionKey),
    candidates,
    belief: {
      method: input.belief.method,
      totalInitialDealWorlds: input.belief.totalInitialDealWorlds,
      materializedWorldOccurrences: input.scenarios.length,
      uniqueWitnesses: input.belief.uniqueWitnesses,
      worldSetChecksum: input.belief.worldSetChecksum,
    },
    rollout: {
      completed,
      perAction: input.scenarios.length * input.budget.rolloutsPerWorld,
      scenarios: input.scenarios.length,
      replicatesPerScenario: input.budget.rolloutsPerWorld,
      failures: 0,
      eventCapHits: 0,
      outcomeChecksum,
    },
    reproducibility: {
      beliefSeedId: seedIds.belief,
      searchSeedId: seedIds.search,
      rolloutSeedId: seedIds.rollout,
      chanceSeedId: seedIds.chance,
      bootstrapSeedId: seedIds.bootstrap,
    },
    warnings,
  };
  const elapsedMs = clockNow() - startedAt;
  return deepFreeze({
    payload,
    telemetry: {
      elapsedMs,
      deterministicWorkCompleted: true,
      deadlineMs: input.budget.deadlineMs,
      deadlineExceeded: elapsedMs > input.budget.deadlineMs,
    },
  });
}

/**
 * Test-only exact-state entry for small strategic fixtures.
 *
 * Production code must call recommendFromTimeline(), whose event history and
 * HiddenWorld hashes are replayed and checked. Omitting activeEvents here uses
 * the explicitly warned effects-only actor chronology path.
 */
export function analyzeScenarioSetForTesting(
  input: ScenarioAnalysisRequest,
): BaselineRecommendation {
  return analyzeScenarioSet(input, clockNow());
}

function scenarioFromWorld(
  world: HiddenWorld,
  expectedHistoryHash: string,
): SearchScenario {
  if (world.historyHash !== expectedHistoryHash) {
    throw new SearchError(
      "STALE_WORLD",
      "Hard-belief world belongs to a different public history.",
      {
        expectedHistoryHash,
        worldHistoryHash: world.historyHash,
        witnessId: world.witnessId,
      },
    );
  }
  return {
    witnessId: world.witnessId,
    currentHands: cloneExactHands(world.currentHands),
  };
}

export function prepareTimelineRecommendation(
  request: TimelineRecommendationRequest,
): PreparedTimelineRecommendation {
  if (request.signal?.aborted === true) {
    throw new SearchError("CANCELLED", "Search was cancelled.");
  }
  const replay = replayTimeline(request.timeline);
  if (
    replay.state.status !== "active" ||
    replay.state.turn !== "user" ||
    replay.state.pendingAction !== null
  ) {
    throw new SearchError(
      "NOT_USER_TURN",
      "Recommendations require an active, non-chance user turn.",
    );
  }
  const budget = solverBudget(
    request.budgetId ?? "balanced",
    request.budgetOverrides,
  );
  const seeds = normalizeSolverSeeds(request.seeds);
  const belief = buildHardBelief(request.timeline, {
    seed: seeds.belief,
    maxExactWorlds: budget.worldSamples,
    maxExactProjectionOperations: Math.max(1, budget.worldSamples * 52),
    maxExactEstimatedBytes: Math.max(1, budget.worldSamples * 1_536),
    sampleCount: budget.worldSamples,
    forceSampling: false,
  });
  if (
    belief.evidence.historyHash !== replay.semanticHash ||
    stableHash(belief.evidence.finalState) !== stableHash(replay.state)
  ) {
    throw new SearchError(
      "STALE_WORLD",
      "Hard belief does not match the replayed production timeline.",
    );
  }
  const activeEvents = activeTimelineEvents(request.timeline);
  return {
    hardBelief: belief,
    analysisRequest: {
      publicState: belief.evidence.finalState,
      historyHash: replay.semanticHash,
      stateVersion: request.timeline.cursor,
      activeEvents,
      scenarios: belief.worlds.map((world) =>
        scenarioFromWorld(world, replay.semanticHash),
      ),
      belief: {
        method: belief.method,
        totalInitialDealWorlds: belief.diagnostics.totalInitialDealWorlds,
        worldSetChecksum: belief.diagnostics.worldSetChecksum,
        uniqueWitnesses: belief.diagnostics.uniqueWitnesses,
      },
      budget,
      ...(request.policies === undefined ? {} : { policies: request.policies }),
      seeds,
      shouldCancel: () => request.signal?.aborted === true,
    },
  };
}

export function recommendFromTimeline(
  request: TimelineRecommendationRequest,
): BaselineRecommendation {
  const startedAt = clockNow();
  return analyzeScenarioSet(
    prepareTimelineRecommendation(request).analysisRequest,
    startedAt,
  );
}
