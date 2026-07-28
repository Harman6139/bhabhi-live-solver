import { CANONICAL_RULES, type RuleConfig } from "../src/domain/rule-config";
import { stableHash } from "../src/events/stable-hash";
import { behaviorBeliefConfigurationHash } from "../src/inference/behavior-belief";
import {
  DEFAULT_BEHAVIOR_MODEL_CONFIG,
  type BehaviorModelId,
} from "../src/inference/behavior-models";
import type { ExactHands } from "../src/rules/exact-hand-transition";
import { assertPublicStateInvariant } from "../src/rules/state-invariant";
import type {
  CounterexampleBoundaryRecord,
  PairedActionValueRecord,
  StrategyCommandRecord,
  StrategyFailureRecord,
  StrategyStateRecord,
} from "../src/strategy/evidence";
import { analyzeExactModelSensitivity } from "../src/search/exact-model-sensitivity";
import {
  solveExactEndgame,
  type ExactEndgameSearchInput,
} from "../src/search/exact-endgame";
import { createExactInformationHypothesisSet } from "../src/search/exact-hypotheses";
import { makeExactPublicState } from "../tests/support/state-builders";

const RULES: RuleConfig = {
  ...CANONICAL_RULES,
  zeroCardsWithPower: {
    mode: "immediate-escape",
    drawFromTarget: "next-active",
    configuredTarget: null,
  },
  twoPlayer: "normal",
};

const EXACT_CONFIG = {
  exact: {
    maxActiveCards: 12,
    maxJointHypotheses: 8,
    maxInformationStates: 10_000,
    maxBranches: 100_000,
  },
  deadlineMs: 60_000,
} as const;

export type Phase7StrategyRecords = {
  readonly states: readonly StrategyStateRecord[];
  readonly actionValues: readonly PairedActionValueRecord[];
  readonly boundaries: readonly CounterexampleBoundaryRecord[];
  readonly failures: readonly StrategyFailureRecord[];
};

function exactAction(
  result: ReturnType<typeof solveExactEndgame> & { readonly quality: "Exact" },
  actionKey: string,
) {
  const value = result.actionValues.find(
    (candidate) => candidate.actionKey === actionKey,
  );
  if (value === undefined) {
    throw new Error(`Missing exact evidence action ${actionKey}.`);
  }
  return value;
}

function pairedRecord(input: {
  readonly actionValueId: string;
  readonly motifId: "M39" | "M40";
  readonly stateId: string;
  readonly pairId: string;
  readonly commandId: string;
  readonly left: {
    readonly actionKey: string;
    readonly risk: number;
    readonly checksum: string;
  };
  readonly right: {
    readonly actionKey: string;
    readonly risk: number;
    readonly checksum: string;
  };
}): PairedActionValueRecord {
  return {
    actionValueId: input.actionValueId,
    motifId: input.motifId,
    stateId: input.stateId,
    pairId: input.pairId,
    pairedSeedId: "analytic-exhaustive-no-rng",
    commandId: input.commandId,
    confirmation: "exhaustive",
    finding: "positive-witness",
    left: {
      actionKey: input.left.actionKey,
      terminalBhabhiRisk: input.left.risk,
      terminalRollouts: 1,
      outcomeChecksum: input.left.checksum,
    },
    right: {
      actionKey: input.right.actionKey,
      terminalBhabhiRisk: input.right.risk,
      terminalRollouts: 1,
      outcomeChecksum: input.right.checksum,
    },
    deltaLeftMinusRight: input.left.risk - input.right.risk,
    preferredActionKey:
      input.left.risk < input.right.risk
        ? input.left.actionKey
        : input.right.actionKey,
  };
}

function m39InformationState(command: StrategyCommandRecord) {
  const worldA: ExactHands = {
    user: ["4H", "AS"],
    p2: ["JH", "2H"],
    p3: ["3S", "KS"],
  };
  const worldB: ExactHands = {
    user: ["4H", "AS"],
    p2: ["JH", "3S"],
    p3: ["2H", "KS"],
  };
  const publicState = makeExactPublicState({
    hands: worldA,
    power: "user",
    rules: RULES,
  });
  publicState.knownOpponentCards = { p2: [], p3: [] };
  publicState.unresolvedCards = ["2H", "JH", "3S", "KS"];
  assertPublicStateInvariant(publicState);
  const historyHash = stableHash({
    fixture: "phase7-evidence/shared-information-state",
    publicState,
  });
  const hypothesisSet = createExactInformationHypothesisSet({
    historyHash,
    sourceKind: "explicit-research",
    sourceChecksum: stableHash({ worldA, worldB }),
    supportKind: "exhaustive",
    supportWorldCount: "2",
    behaviorConfigHash: behaviorBeliefConfigurationHash(
      DEFAULT_BEHAVIOR_MODEL_CONFIG,
    ),
    hypotheses: [
      {
        hypothesisId: "world-a",
        occurrenceIndex: 0,
        witnessId: "world-a",
        p2ModelId: "always-high",
        p3ModelId: "always-high",
        mass: 0.5,
        currentHands: worldA,
      },
      {
        hypothesisId: "world-b",
        occurrenceIndex: 1,
        witnessId: "world-b",
        p2ModelId: "always-high",
        p3ModelId: "always-high",
        mass: 0.5,
        currentHands: worldB,
      },
    ],
  });
  const request: ExactEndgameSearchInput = {
    publicState,
    historyHash,
    hypothesisSet,
    behaviorConfig: DEFAULT_BEHAVIOR_MODEL_CONFIG,
    config: EXACT_CONFIG,
  };
  const result = solveExactEndgame(request);
  if (result.quality !== "Exact") {
    throw new Error(
      `M39 information-state evidence became ineligible: ${result.eligibility.code}`,
    );
  }
  const ace = exactAction(result, "play:AS");
  const heart = exactAction(result, "play:4H");
  const stateId = "state/M39/shared-information-state";
  return {
    state: {
      stateId,
      motifId: "M39" as const,
      provenance: {
        kind: "synthetic-transition" as const,
        fixtureId: "shared-information-state",
        stateHash: stableHash(publicState),
        transitionSystemVersion: result.algorithmVersion,
        constructionDigest: hypothesisSet.checksum,
      },
      rulesChecksum: stableHash(RULES),
      solverConfigChecksum: result.configHash,
      seedIds: ["analytic-exhaustive-no-rng"],
      commandId: command.commandId,
    },
    actionValue: pairedRecord({
      actionValueId: "action-value/M39/shared-action",
      motifId: "M39",
      stateId,
      pairId: "pair/M39/AS-vs-4H",
      commandId: command.commandId,
      left: {
        actionKey: ace.actionKey,
        risk: ace.userBhabhiRisk,
        checksum: stableHash(ace),
      },
      right: {
        actionKey: heart.actionKey,
        risk: heart.userBhabhiRisk,
        checksum: stableHash(heart),
      },
    }),
    result,
  };
}

function m39CycleBoundary(command: StrategyCommandRecord) {
  const hands: ExactHands = {
    user: ["6H", "JC", "TH"],
    p2: ["QS", "QC", "6D"],
    p3: ["QD", "8D", "KS"],
  };
  const publicState = makeExactPublicState({
    hands,
    power: "user",
    rules: RULES,
  });
  const historyHash = stableHash({
    fixture: "phase7-evidence/semantic-pickup-cycle",
    publicState,
  });
  const hypothesisSet = createExactInformationHypothesisSet({
    historyHash,
    sourceKind: "explicit-research",
    sourceChecksum: stableHash(hands),
    supportKind: "exhaustive",
    supportWorldCount: "1",
    behaviorConfigHash: behaviorBeliefConfigurationHash(
      DEFAULT_BEHAVIOR_MODEL_CONFIG,
    ),
    hypotheses: [
      {
        hypothesisId: "cycle",
        occurrenceIndex: 0,
        witnessId: "cycle",
        p2ModelId: "always-high",
        p3ModelId: "always-high",
        mass: 1,
        currentHands: hands,
      },
    ],
  });
  const result = solveExactEndgame({
    publicState,
    historyHash,
    hypothesisSet,
    behaviorConfig: DEFAULT_BEHAVIOR_MODEL_CONFIG,
    config: EXACT_CONFIG,
  });
  if (
    result.quality !== "Unavailable" ||
    result.eligibility.code !== "CYCLIC_INFORMATION_GRAPH"
  ) {
    throw new Error("M39 cycle evidence no longer returns its typed refusal.");
  }
  const stateId = "state/M39/semantic-pickup-cycle";
  const state: StrategyStateRecord = {
    stateId,
    motifId: "M39",
    provenance: {
      kind: "synthetic-transition",
      fixtureId: "semantic-pickup-cycle",
      stateHash: stableHash(publicState),
      transitionSystemVersion: result.algorithmVersion,
      constructionDigest: hypothesisSet.checksum,
    },
    rulesChecksum: stableHash(RULES),
    solverConfigChecksum: result.configHash,
    seedIds: ["analytic-exhaustive-no-rng"],
    commandId: command.commandId,
  };
  const boundary: CounterexampleBoundaryRecord = {
    boundaryRecordId: "boundary/M39/cyclic-information-graph",
    motifId: "M39",
    commandId: command.commandId,
    finding: "boundary",
    scope: "single-state",
    description:
      "A revisitable pickup graph is detected and declined with CYCLIC_INFORMATION_GRAPH; no partial tree is labelled Exact.",
    stateIds: [stateId],
    actionValueIds: [],
  };
  const failure: StrategyFailureRecord = {
    failureId: "failure/M39/cyclic-information-graph",
    motifId: "M39",
    commandId: command.commandId,
    stage: "search",
    code: result.eligibility.code,
    message: result.eligibility.detail,
    stateId,
    recoverable: true,
  };
  return { state, boundary, failure };
}

function modelCells(weight: (p2ModelId: BehaviorModelId) => number) {
  const modelIds = ["always-high", "always-low"] as const;
  return modelIds.flatMap((p2ModelId) =>
    modelIds.map((p3ModelId) => ({
      p2ModelId,
      p3ModelId,
      mass: weight(p2ModelId),
    })),
  );
}

function m40Report(input: {
  readonly id: string;
  readonly hands: ExactHands;
  readonly weight: (p2ModelId: BehaviorModelId) => number;
}) {
  const publicState = makeExactPublicState({
    hands: input.hands,
    power: "user",
    rules: RULES,
  });
  const historyHash = stableHash({
    fixture: `phase7-evidence/${input.id}`,
    publicState,
  });
  const cells = modelCells(input.weight);
  const hypothesisSet = createExactInformationHypothesisSet({
    historyHash,
    sourceKind: "explicit-research",
    sourceChecksum: stableHash({ fixture: input.id, cells }),
    supportKind: "exhaustive",
    supportWorldCount: "1",
    behaviorConfigHash: behaviorBeliefConfigurationHash(
      DEFAULT_BEHAVIOR_MODEL_CONFIG,
    ),
    hypotheses: cells.map((cell, index) => ({
      hypothesisId: `${cell.p2ModelId}/${cell.p3ModelId}`,
      occurrenceIndex: index,
      witnessId: input.id,
      p2ModelId: cell.p2ModelId,
      p3ModelId: cell.p3ModelId,
      mass: cell.mass,
      currentHands: input.hands,
    })),
  });
  const result = analyzeExactModelSensitivity({
    publicState,
    historyHash,
    hypothesisSet,
    behaviorConfig: DEFAULT_BEHAVIOR_MODEL_CONFIG,
    config: EXACT_CONFIG,
  });
  if (result.quality !== "Exact") {
    throw new Error(
      `${input.id} sensitivity evidence became ineligible: ${result.eligibility.code}`,
    );
  }
  return { publicState, hypothesisSet, result };
}

function m40Sensitivity(command: StrategyCommandRecord) {
  const fragile = m40Report({
    id: "exact-model-fragile",
    hands: {
      user: ["TS", "6C"],
      p2: ["AS", "8S"],
      p3: ["4D", "5S"],
    },
    weight: (p2ModelId) => (p2ModelId === "always-high" ? 0.375 : 0.125),
  });
  const stable = m40Report({
    id: "exact-model-stable",
    hands: {
      user: ["2C", "3C"],
      p2: ["4C"],
      p3: ["5C"],
    },
    weight: () => 0.25,
  });
  if (
    !fragile.result.diagnostic.fragility.warning ||
    stable.result.diagnostic.fragility.warning
  ) {
    throw new Error("M40 stable/fragile labels no longer match evidence.");
  }
  const fragileStateId = "state/M40/fragile-model-grid";
  const stableStateId = "state/M40/stable-model-grid";
  const states: StrategyStateRecord[] = [
    {
      stateId: fragileStateId,
      motifId: "M40",
      provenance: {
        kind: "synthetic-transition",
        fixtureId: "exact-model-fragile",
        stateHash: stableHash(fragile.publicState),
        transitionSystemVersion: fragile.result.algorithmVersion,
        constructionDigest: fragile.hypothesisSet.checksum,
      },
      rulesChecksum: stableHash(RULES),
      solverConfigChecksum: fragile.result.baseResult.configHash,
      seedIds: ["analytic-exhaustive-no-rng"],
      commandId: command.commandId,
    },
    {
      stateId: stableStateId,
      motifId: "M40",
      provenance: {
        kind: "synthetic-transition",
        fixtureId: "exact-model-stable",
        stateHash: stableHash(stable.publicState),
        transitionSystemVersion: stable.result.algorithmVersion,
        constructionDigest: stable.hypothesisSet.checksum,
      },
      rulesChecksum: stableHash(RULES),
      solverConfigChecksum: stable.result.baseResult.configHash,
      seedIds: ["analytic-exhaustive-no-rng"],
      commandId: command.commandId,
    },
  ];
  const spade = exactAction(fragile.result.baseResult, "play:TS");
  const club = exactAction(fragile.result.baseResult, "play:6C");
  const actionValue = pairedRecord({
    actionValueId: "action-value/M40/posterior-grid",
    motifId: "M40",
    stateId: fragileStateId,
    pairId: "pair/M40/TS-vs-6C",
    commandId: command.commandId,
    left: {
      actionKey: spade.actionKey,
      risk: spade.userBhabhiRisk,
      checksum: stableHash(spade),
    },
    right: {
      actionKey: club.actionKey,
      risk: club.userBhabhiRisk,
      checksum: stableHash(club),
    },
  });
  const boundary: CounterexampleBoundaryRecord = {
    boundaryRecordId: "boundary/M40/stable-versus-fragile",
    motifId: "M40",
    commandId: command.commandId,
    finding: "boundary",
    scope: "finite-search",
    description: `The stable grid emits no warning; the fragile grid switches on posterior mass ${fragile.result.diagnostic.fragility.switchPosteriorMass.toString()} with maximum regret ${fragile.result.diagnostic.fragility.maximumSwitchRegret.toString()}.`,
    stateIds: [stableStateId, fragileStateId],
    actionValueIds: [actionValue.actionValueId],
  };
  return { states, actionValue, boundary };
}

export function createPhase7StrategyRecords(
  command: StrategyCommandRecord,
): Phase7StrategyRecords {
  const m39 = m39InformationState(command);
  const cycle = m39CycleBoundary(command);
  const m40 = m40Sensitivity(command);
  return {
    states: [m39.state, cycle.state, ...m40.states].sort((left, right) =>
      left.stateId.localeCompare(right.stateId),
    ),
    actionValues: [m39.actionValue, m40.actionValue].sort((left, right) =>
      left.actionValueId.localeCompare(right.actionValueId),
    ),
    boundaries: [cycle.boundary, m40.boundary].sort((left, right) =>
      left.boundaryRecordId.localeCompare(right.boundaryRecordId),
    ),
    failures: [cycle.failure].sort((left, right) =>
      left.failureId.localeCompare(right.failureId),
    ),
  };
}
