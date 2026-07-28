import { CANONICAL_RULES } from "../domain/rule-config";
import { stableHash } from "../events/stable-hash";
import { RuleViolation } from "../rules/rule-error";
import {
  createSeededDeal,
  simulateCompleteGame,
  SimulationRunError,
  type SimulationGameResult,
} from "../simulator/game";
import type { ScenarioSolverSeedSet } from "../simulator/evaluation-user-policy";
import { getBaselinePolicy } from "../simulator/policies";
import {
  PHASE7_CANDIDATE_CONFIG_ID,
  PHASE7_REFERENCE_CONFIG_ID,
  createPhase7SearchPolicyFactory,
  phase7ComparisonConfigurationHash,
  type Phase7ComparisonRole,
  type Phase7SearchDecisionAudit,
} from "./phase7-search-policy";
import {
  phase7ComparisonClusterId,
  phase7ComparisonPairId,
} from "./phase7-comparison-artifacts";
import {
  PHASE7_COMPARISON_ARTIFACT_SCHEMA_VERSION,
  PHASE7_COMPARISON_EVIDENCE_CLASS,
  phase7ComparisonConfigurationSchema,
  phase7ComparisonDecisionRecordSchema,
  phase7ComparisonFailureRecordSchema,
  phase7ComparisonGameRecordSchema,
  phase7ComparisonLatencyRecordSchema,
  phase7ComparisonTruthRecordSchema,
  type Phase7ComparisonConfiguration,
  type Phase7ComparisonDecisionRecord,
  type Phase7ComparisonFailureRecord,
  type Phase7ComparisonGameRecord,
  type Phase7ComparisonLatencyRecord,
  type Phase7ComparisonTruthRecord,
} from "./phase7-comparison-schema";
import {
  STYLE_CELLS,
  deriveDealSeed,
  deriveStreamSeed,
  type EvaluationSplit,
  type StyleCell,
} from "./protocol";

export type Phase7ComparisonPlan = {
  readonly schemaVersion: 1;
  readonly protocolId: "eval-v1";
  readonly runId: string;
  readonly split: "dev";
  readonly baseIndexStart: number;
  readonly baseCount: number;
  readonly rotations: readonly [0, 1, 2];
  readonly replicate: 0;
  readonly eventCap: number;
  readonly verifyFallbackParity: boolean;
  readonly configurations: readonly [
    Phase7ComparisonConfiguration,
    Phase7ComparisonConfiguration,
  ];
  readonly bootstrapSeedId: string;
};

export type Phase7ComparisonRawRun = {
  readonly plan: Phase7ComparisonPlan;
  readonly games: readonly Phase7ComparisonGameRecord[];
  readonly truths: readonly Phase7ComparisonTruthRecord[];
  readonly failures: readonly Phase7ComparisonFailureRecord[];
  readonly decisions: readonly Phase7ComparisonDecisionRecord[];
  readonly latencies: readonly Phase7ComparisonLatencyRecord[];
};

export type Phase7ComparisonProgress = {
  readonly attemptedGames: number;
  readonly expectedGames: number;
  readonly completedGames: number;
  readonly failedGames: number;
  readonly exactUses: number;
  readonly exactRefusals: number;
  readonly current: {
    readonly role: Phase7ComparisonRole;
    readonly styleCellId: string;
    readonly baseIndex: number;
    readonly rotation: 0 | 1 | 2;
  };
};

type Coordinate = {
  readonly schemaVersion: typeof PHASE7_COMPARISON_ARTIFACT_SCHEMA_VERSION;
  readonly protocolId: "eval-v1";
  readonly runId: string;
  readonly split: EvaluationSplit;
  readonly evidenceClass: typeof PHASE7_COMPARISON_EVIDENCE_CLASS;
  readonly pairId: string;
  readonly clusterId: string;
  readonly configRole: Phase7ComparisonRole;
  readonly configId: string;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly replicate: 0;
  readonly gameId: string;
};

type ComparisonSeedIds = {
  readonly deal: string;
  readonly userPolicy: string;
  readonly p2Policy: string;
  readonly p3Policy: string;
  readonly environmentChance: string;
  readonly belief: string;
  readonly search: string;
  readonly rollout: string;
  readonly solverChance: string;
  readonly bootstrap: string;
};

export type Phase7ComparisonScenarioSeeds = {
  /**
   * Seed identifiers retained in the game/failure record. The chance stream
   * here belongs to the simulator, not to the solver.
   */
  readonly record: ComparisonSeedIds;
  /**
   * Private environment streams. Opponent and chance randomness may vary by
   * hidden style cell, but this object is never passed to the user policy.
   */
  readonly simulator: {
    readonly deal: string;
    readonly userPolicy: string;
    readonly p2Policy: string;
    readonly p3Policy: string;
    readonly chance: string;
  };
  /**
   * The only randomness visible at the evaluation user-policy boundary.
   * These streams deliberately exclude the hidden style-cell coordinate.
   */
  readonly solver: ScenarioSolverSeedSet;
};

const CONFIGURATION_ROLES = ["reference", "candidate"] as const;
const PHASE7_SOLVER_SEED_CELL = "phase7-public-solver-inputs-v1";

export type Phase7ComparisonScenarioResult = {
  readonly game: Phase7ComparisonGameRecord | null;
  readonly truth: Phase7ComparisonTruthRecord | null;
  readonly failure: Phase7ComparisonFailureRecord | null;
  readonly decisions: readonly Phase7ComparisonDecisionRecord[];
  readonly latencies: readonly Phase7ComparisonLatencyRecord[];
};

function comparisonConfiguration(
  role: Phase7ComparisonRole,
): Phase7ComparisonConfiguration {
  return phase7ComparisonConfigurationSchema.parse({
    role,
    configId:
      role === "reference"
        ? PHASE7_REFERENCE_CONFIG_ID
        : PHASE7_CANDIDATE_CONFIG_ID,
    configHash: phase7ComparisonConfigurationHash(role),
    method:
      role === "reference"
        ? "frozen-phase5-balanced-hard-only"
        : "exact-information-state-then-frozen-phase5-fallback",
    executionPath:
      role === "reference"
        ? "direct-phase5-recommend-from-timeline-v1"
        : "research-exact-then-phase5-fallback-v1",
    budgetId: "balanced",
    beliefMode: "hard-only",
    continuationPolicies: {
      user: "documented-basic",
      p2: "documented-basic",
      p3: "documented-basic",
    },
    exactScreen:
      role === "candidate"
        ? {
            executionMode: "research-only",
            maxActiveCards: 7,
            maxJointHypotheses: 196,
            maxInformationStates: 128,
            maxBranches: 512,
            approximateHypothesisSamples: 196,
            deadlineMs: 1_000,
          }
        : null,
    exactEnabled: role === "candidate",
    behaviorWeightingEnabled: false,
  });
}

export function createPhase7ComparisonPlan(input: {
  readonly runId: string;
  readonly baseIndexStart?: number;
  readonly baseCount: number;
  readonly eventCap?: number;
  readonly verifyFallbackParity?: boolean;
}): Phase7ComparisonPlan {
  const baseIndexStart = input.baseIndexStart ?? 0;
  const eventCap = input.eventCap ?? 4_096;
  if (
    !Number.isSafeInteger(baseIndexStart) ||
    baseIndexStart < 0 ||
    !Number.isSafeInteger(input.baseCount) ||
    input.baseCount <= 0
  ) {
    throw new RangeError(
      "Phase 7 comparison base indices/count must be nonnegative/positive safe integers.",
    );
  }
  if (!Number.isSafeInteger(eventCap) || eventCap <= 0) {
    throw new RangeError(
      "Phase 7 comparison eventCap must be a positive safe integer.",
    );
  }
  if (input.runId.trim().length === 0) {
    throw new RangeError("Phase 7 comparison runId must not be empty.");
  }
  const split = "dev" as const;
  return Object.freeze({
    schemaVersion: 1,
    protocolId: "eval-v1",
    runId: input.runId,
    split,
    baseIndexStart,
    baseCount: input.baseCount,
    rotations: [0, 1, 2] as const,
    replicate: 0,
    eventCap,
    verifyFallbackParity: input.verifyFallbackParity ?? true,
    configurations: [
      comparisonConfiguration("reference"),
      comparisonConfiguration("candidate"),
    ] as const,
    bootstrapSeedId: deriveStreamSeed({
      split,
      stream: "bootstrap",
      cell: "phase7-paired-macro",
      baseIndex: baseIndexStart,
      rotation: 0,
      replicate: 0,
    }),
  });
}

export function expectedPhase7ComparisonGames(
  plan: Phase7ComparisonPlan,
): number {
  return (
    plan.configurations.length *
    STYLE_CELLS.length *
    plan.baseCount *
    plan.rotations.length
  );
}

export function derivePhase7ComparisonScenarioSeeds(input: {
  readonly split: EvaluationSplit;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
}): Phase7ComparisonScenarioSeeds {
  const simulatorCommon = {
    split: input.split,
    cell: input.styleCellId,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
    replicate: 0,
  } as const;
  const solverCommon = {
    split: input.split,
    cell: PHASE7_SOLVER_SEED_CELL,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
    replicate: 0,
  } as const;
  const solver = Object.freeze({
    belief: deriveStreamSeed({ ...solverCommon, stream: "belief" }),
    search: deriveStreamSeed({ ...solverCommon, stream: "search" }),
    rollout: deriveStreamSeed({ ...solverCommon, stream: "rollout" }),
    chance: deriveStreamSeed({ ...solverCommon, stream: "chance" }),
    bootstrap: deriveStreamSeed({ ...solverCommon, stream: "bootstrap" }),
  });
  const simulator = Object.freeze({
    deal: deriveDealSeed(input.split, input.baseIndex),
    userPolicy: solver.rollout,
    p2Policy: deriveStreamSeed({
      ...simulatorCommon,
      stream: "p2-policy",
    }),
    p3Policy: deriveStreamSeed({
      ...simulatorCommon,
      stream: "p3-policy",
    }),
    chance: deriveStreamSeed({ ...simulatorCommon, stream: "chance" }),
  });
  return Object.freeze({
    record: Object.freeze({
      deal: simulator.deal,
      userPolicy: simulator.userPolicy,
      p2Policy: simulator.p2Policy,
      p3Policy: simulator.p3Policy,
      environmentChance: simulator.chance,
      belief: solver.belief,
      search: solver.search,
      rollout: solver.rollout,
      solverChance: solver.chance,
      bootstrap: solver.bootstrap,
    }),
    simulator,
    solver,
  });
}

function coordinate(input: {
  readonly plan: Phase7ComparisonPlan;
  readonly role: Phase7ComparisonRole;
  readonly styleCell: StyleCell;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
}): Coordinate {
  const configId =
    input.role === "reference"
      ? PHASE7_REFERENCE_CONFIG_ID
      : PHASE7_CANDIDATE_CONFIG_ID;
  const pairId = phase7ComparisonPairId({
    split: input.plan.split,
    styleCellId: input.styleCell.id,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
  });
  return Object.freeze({
    schemaVersion: PHASE7_COMPARISON_ARTIFACT_SCHEMA_VERSION,
    protocolId: "eval-v1",
    runId: input.plan.runId,
    split: input.plan.split,
    evidenceClass: PHASE7_COMPARISON_EVIDENCE_CLASS,
    pairId,
    clusterId: phase7ComparisonClusterId(input.plan.split, input.baseIndex),
    configRole: input.role,
    configId,
    styleCellId: input.styleCell.id,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
    replicate: 0,
    gameId: stableHash({
      schemaVersion: 1,
      protocol: "phase7-paired-comparison-v1",
      pairId,
      configId,
      rules: CANONICAL_RULES,
    }),
  });
}

function terminalReason(result: SimulationGameResult): string {
  const terminal = [...result.finalState.effects]
    .reverse()
    .find((effect) => effect.type === "game-completed");
  if (terminal?.type !== "game-completed") {
    throw new Error("A completed comparison game has no terminal effect.");
  }
  return terminal.reason;
}

function successfulRecords(
  coordinateValue: Coordinate,
  seeds: ComparisonSeedIds,
  styleCell: StyleCell,
  result: SimulationGameResult,
  gameWallTimeMs: number,
): {
  readonly game: Phase7ComparisonGameRecord;
  readonly truth: Phase7ComparisonTruthRecord;
} {
  const userPosition = result.escapeOrder.indexOf("user") + 1;
  if (userPosition !== 1 && userPosition !== 2 && userPosition !== 3) {
    throw new Error("Completed comparison game omitted the user finish.");
  }
  const deterministicGameDigest = stableHash({
    gameId: coordinateValue.gameId,
    events: result.events,
    bhabhi: result.bhabhi,
    escapeOrder: result.escapeOrder,
    terminalPublicStateHash: result.terminalPublicStateHash,
    deterministicOutcomeHash: result.outcomeHash,
  });
  const game = phase7ComparisonGameRecordSchema.parse({
    ...coordinateValue,
    recordType: "phase7-comparison-game",
    completionStatus: "complete",
    opponentPolicies: {
      p2: styleCell.p2,
      p3: styleCell.p3,
    },
    bhabhi: result.bhabhi,
    userBhabhi: result.bhabhi === "user",
    userFinishingPosition: userPosition,
    escapeOrder: result.escapeOrder,
    terminalReason: terminalReason(result),
    terminalHandCounts: result.finalState.handCounts,
    eventCount: result.eventCount,
    publicHistoryHash: result.semanticHistoryHash,
    terminalPublicStateHash: result.terminalPublicStateHash,
    deterministicOutcomeHash: result.outcomeHash,
    deterministicGameDigest,
    events: result.events,
    seedIds: seeds,
    gameWallTimeMs,
  });
  const truth = phase7ComparisonTruthRecordSchema.parse({
    ...coordinateValue,
    recordType: "phase7-comparison-truth-eval-only",
    initialHands: result.deal,
    finalHands: result.finalHands,
    truthHash: result.terminalTruthHash,
  });
  return { game, truth };
}

function refusalDetail(
  audit: Phase7SearchDecisionAudit,
): Phase7ComparisonDecisionRecord["exactRefusalDetail"] {
  if (
    audit.exactOutcome !== "refused" ||
    audit.exactRefusalCode === null ||
    audit.exactRefusalDetail === null
  ) {
    return null;
  }
  return {
    code: audit.exactRefusalCode,
    message: audit.exactRefusalDetail,
    boundaryHash: stableHash({
      code: audit.exactRefusalCode,
      message: audit.exactRefusalDetail,
      exactResultHash: audit.exactResultHash,
    }),
  };
}

function decisionRecords(
  coordinateValue: Coordinate,
  seeds: Phase7ComparisonScenarioSeeds,
  audits: readonly Phase7SearchDecisionAudit[],
): {
  readonly decisions: readonly Phase7ComparisonDecisionRecord[];
  readonly latencies: readonly Phase7ComparisonLatencyRecord[];
} {
  const decisions: Phase7ComparisonDecisionRecord[] = [];
  const latencies: Phase7ComparisonLatencyRecord[] = [];
  for (const audit of audits) {
    const decisionId = `${coordinateValue.gameId}/${audit.eventIndex.toString()}`;
    const selectedCard =
      audit.selectedAction.kind === "play-card"
        ? audit.selectedAction.card
        : null;
    const selectedTakeTarget =
      audit.selectedAction.kind === "take-hand"
        ? audit.selectedAction.target
        : null;
    const exactRefusalDetail = refusalDetail(audit);
    const fallbackResultHash =
      audit.approximateAnalysisId === null ||
      audit.approximateOutcomeChecksum === null
        ? null
        : stableHash({
            analysisId: audit.approximateAnalysisId,
            outcomeChecksum: audit.approximateOutcomeChecksum,
          });
    const common = {
      ...coordinateValue,
      decisionId,
      decisionOrdinal: audit.decisionOrdinal,
      eventIndex: audit.eventIndex,
    };
    decisions.push(
      phase7ComparisonDecisionRecordSchema.parse({
        ...common,
        recordType: "phase7-comparison-decision",
        publicHistoryHash: audit.historyHash,
        publicStateHash: audit.publicStateHash,
        observationHash: audit.observationHash,
        actionKind: audit.selectedAction.kind,
        selectedCard,
        selectedTakeTarget,
        selectedActionHash: stableHash({
          actionKind: audit.selectedAction.kind,
          selectedCard,
          selectedTakeTarget,
        }),
        dispatchOutcome: audit.selectedMethod,
        quality: audit.selectedMethod === "exact" ? "Exact" : "Approximate",
        exactOutcome: audit.exactOutcome,
        exactRefusalCode: audit.exactRefusalCode,
        exactRefusalDetail,
        fallbackParity: audit.fallbackParity,
        dispatchHash: audit.dispatchResultHash,
        analysisInputHash: stableHash({
          configId: coordinateValue.configId,
          historyHash: audit.historyHash,
          publicStateHash: audit.publicStateHash,
          observationHash: audit.observationHash,
          beliefSeed: seeds.solver.belief,
          searchSeed: seeds.solver.search,
          rolloutSeed: seeds.solver.rollout,
          chanceSeed: seeds.solver.chance,
          bootstrapSeed: seeds.solver.bootstrap,
        }),
        analysisOutputHash: audit.auditHash,
        exactAlgorithmId: audit.exactAlgorithmId,
        exactConfigHash: audit.exactConfigHash,
        hypothesisSetHash: audit.exactHypothesisSetChecksum,
        exactResultHash: audit.exactResultHash,
        exactDiagnosticsHash: audit.exactDiagnosticsHash,
        exactActionValuesHash: audit.exactActionValuesHash,
        positionalDiagnosticsHash: audit.exactPositionalDiagnosticsHash,
        fallbackConfigHash: audit.approximateConfigHash,
        fallbackResultHash,
        beliefSeedId: seeds.solver.belief,
        searchSeedId: seeds.solver.search,
      }),
    );
    latencies.push(
      phase7ComparisonLatencyRecordSchema.parse({
        ...common,
        recordType: "phase7-comparison-latency",
        totalMs: audit.totalMs,
        exactMs: audit.exactMs,
        fallbackMs: audit.fallbackMs,
      }),
    );
  }
  return { decisions, latencies };
}

function classifyFailure(error: unknown): {
  readonly completionStatus: "failed" | "turn-cap" | "cancelled";
  readonly kind:
    | "invariant"
    | "illegal-policy-action"
    | "exception"
    | "turn-cap"
    | "cancellation";
  readonly code: string | null;
} {
  if (error instanceof SimulationRunError) {
    if (error.code === "EVENT_CAP") {
      return {
        completionStatus: "turn-cap",
        kind: "turn-cap",
        code: error.code,
      };
    }
    if (error.code === "INVALID_POLICY_CHOICE") {
      return {
        completionStatus: "failed",
        kind: "illegal-policy-action",
        code: error.code,
      };
    }
    return {
      completionStatus: "failed",
      kind: "exception",
      code: error.code,
    };
  }
  if (error instanceof RuleViolation && error.code === "INVARIANT_VIOLATION") {
    return {
      completionStatus: "failed",
      kind: "invariant",
      code: error.code,
    };
  }
  const code =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : null;
  return code === "CANCELLED"
    ? {
        completionStatus: "cancelled",
        kind: "cancellation",
        code,
      }
    : {
        completionStatus: "failed",
        kind: "exception",
        code,
      };
}

function failureRecord(
  coordinateValue: Coordinate,
  seeds: ComparisonSeedIds,
  audits: readonly Phase7SearchDecisionAudit[],
  error: unknown,
): Phase7ComparisonFailureRecord {
  const classification = classifyFailure(error);
  const name = error instanceof Error ? error.name : "UnknownError";
  const message =
    error instanceof Error ? error.message : "Unknown non-Error failure.";
  const maxAuditEventIndex = audits.reduce(
    (maximum, audit) => Math.max(maximum, audit.eventIndex),
    -1,
  );
  const lastGoodEventIndex =
    error instanceof SimulationRunError
      ? error.eventCount - 1
      : maxAuditEventIndex;
  const deterministicFailureHash = stableHash({
    gameId: coordinateValue.gameId,
    completionStatus: classification.completionStatus,
    kind: classification.kind,
    code: classification.code,
    name,
    message,
    lastGoodEventIndex,
  });
  return phase7ComparisonFailureRecordSchema.parse({
    ...coordinateValue,
    recordType: "phase7-comparison-failure",
    completionStatus: classification.completionStatus,
    failureId: `${coordinateValue.gameId}/${deterministicFailureHash}`,
    kind: classification.kind,
    stage: "simulate-search-complete-game",
    error: {
      name,
      code: classification.code,
      message,
    },
    lastGoodEventIndex,
    deterministicFailureHash,
    seedIds: seeds,
  });
}

export function runPhase7ComparisonScenario(input: {
  readonly plan: Phase7ComparisonPlan;
  readonly role: Phase7ComparisonRole;
  readonly styleCell: StyleCell;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
}): Phase7ComparisonScenarioResult {
  const coordinateValue = coordinate(input);
  const seeds = derivePhase7ComparisonScenarioSeeds({
    split: input.plan.split,
    styleCellId: input.styleCell.id,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
  });
  const searchPolicy = createPhase7SearchPolicyFactory({
    role: input.role,
    solverSeeds: seeds.solver,
    verifyFallbackParity: input.plan.verifyFallbackParity,
  });
  const startedAt = globalThis.performance.now();
  try {
    const result = simulateCompleteGame({
      gameId: coordinateValue.gameId,
      rules: CANONICAL_RULES,
      rotation: input.rotation,
      deal: createSeededDeal(seeds.simulator.deal, input.rotation),
      seeds: {
        deal: seeds.simulator.deal,
        policy: {
          user: seeds.simulator.userPolicy,
          p2: seeds.simulator.p2Policy,
          p3: seeds.simulator.p3Policy,
        },
        chance: seeds.simulator.chance,
      },
      policies: {
        user: getBaselinePolicy("documented-basic"),
        p2: getBaselinePolicy(input.styleCell.p2),
        p3: getBaselinePolicy(input.styleCell.p3),
      },
      evaluationUserTimelinePolicy: searchPolicy.policyConfig,
      maxEvents: input.plan.eventCap,
    });
    const completed = successfulRecords(
      coordinateValue,
      seeds.record,
      input.styleCell,
      result,
      globalThis.performance.now() - startedAt,
    );
    const auditRecords = decisionRecords(
      coordinateValue,
      seeds,
      searchPolicy.decisions,
    );
    return {
      ...completed,
      failure: null,
      ...auditRecords,
    };
  } catch (error) {
    const auditRecords = decisionRecords(
      coordinateValue,
      seeds,
      searchPolicy.decisions,
    );
    return {
      game: null,
      truth: null,
      failure: failureRecord(
        coordinateValue,
        seeds.record,
        searchPolicy.decisions,
        error,
      ),
      ...auditRecords,
    };
  }
}

export function runPhase7Comparison(input: {
  readonly plan: Phase7ComparisonPlan;
  readonly onProgress?: (progress: Phase7ComparisonProgress) => void;
}): Phase7ComparisonRawRun {
  const games: Phase7ComparisonGameRecord[] = [];
  const truths: Phase7ComparisonTruthRecord[] = [];
  const failures: Phase7ComparisonFailureRecord[] = [];
  const decisions: Phase7ComparisonDecisionRecord[] = [];
  const latencies: Phase7ComparisonLatencyRecord[] = [];
  const expectedGames = expectedPhase7ComparisonGames(input.plan);

  for (
    let baseIndex = input.plan.baseIndexStart;
    baseIndex < input.plan.baseIndexStart + input.plan.baseCount;
    baseIndex += 1
  ) {
    for (const styleCell of STYLE_CELLS) {
      for (const rotation of input.plan.rotations) {
        for (const role of CONFIGURATION_ROLES) {
          const result = runPhase7ComparisonScenario({
            plan: input.plan,
            role,
            styleCell,
            baseIndex,
            rotation,
          });
          if (result.game !== null && result.truth !== null) {
            games.push(result.game);
            truths.push(result.truth);
          }
          if (result.failure !== null) {
            failures.push(result.failure);
          }
          decisions.push(...result.decisions);
          latencies.push(...result.latencies);
          input.onProgress?.({
            attemptedGames: games.length + failures.length,
            expectedGames,
            completedGames: games.length,
            failedGames: failures.length,
            exactUses: decisions.filter(
              (decision) => decision.exactOutcome === "used",
            ).length,
            exactRefusals: decisions.filter(
              (decision) => decision.exactOutcome === "refused",
            ).length,
            current: {
              role,
              styleCellId: styleCell.id,
              baseIndex,
              rotation,
            },
          });
        }
      }
    }
  }
  if (games.length + failures.length !== expectedGames) {
    throw new Error("Phase 7 runner silently omitted a scheduled game.");
  }
  return Object.freeze({
    plan: input.plan,
    games: Object.freeze(games),
    truths: Object.freeze(truths),
    failures: Object.freeze(failures),
    decisions: Object.freeze(decisions),
    latencies: Object.freeze(latencies),
  });
}
