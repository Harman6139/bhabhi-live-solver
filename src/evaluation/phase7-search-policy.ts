import { stableHash, stableStringify } from "../events/stable-hash";
import {
  type EvaluationUserTimelinePolicy,
  type EvaluationUserTimelinePolicyAction,
  type EvaluationUserTimelinePolicyConfig,
  type EvaluationUserTimelinePolicyInput,
  type ScenarioSolverSeedSet,
} from "../simulator/evaluation-user-policy";
import {
  recommendResearchFromTimeline,
  type ResearchSearchDispatchResult,
} from "../search/research-dispatch";
import { recommendFromTimeline } from "../search/solver";
import type {
  BaselineRecommendation,
  SolverPolicyConfig,
  UserAction,
} from "../search/types";
import type {
  AdvancedSearchConfig,
  ExactEndgameDiagnostics,
  ExactIneligibilityCode,
} from "../search/advanced-types";

export const PHASE7_REFERENCE_CONFIG_ID =
  "phase5-balanced-hard-only-reference-v1" as const;
export const PHASE7_CANDIDATE_CONFIG_ID =
  "phase7-exact-then-phase5-fallback-v1" as const;

export const PHASE7_EXACT_SCREEN_CONFIG: AdvancedSearchConfig = Object.freeze({
  schemaVersion: 1,
  executionMode: "research-only",
  exact: Object.freeze({
    maxActiveCards: 7,
    maxJointHypotheses: 196,
    maxInformationStates: 128,
    maxBranches: 512,
  }),
  approximateHypothesisSamples: 196,
  deadlineMs: 1_000,
});

export const PHASE7_FROZEN_CONTINUATION_POLICIES: SolverPolicyConfig =
  Object.freeze({
    userContinuation: "documented-basic",
    p2: "documented-basic",
    p3: "documented-basic",
  });

export type Phase7ComparisonRole = "reference" | "candidate";

export type Phase7SearchDecisionAudit = {
  readonly schemaVersion: 1;
  readonly role: Phase7ComparisonRole;
  readonly configId:
    typeof PHASE7_REFERENCE_CONFIG_ID | typeof PHASE7_CANDIDATE_CONFIG_ID;
  readonly decisionOrdinal: number;
  readonly eventIndex: number;
  readonly historyHash: string;
  readonly publicStateHash: string;
  readonly observationHash: string;
  readonly selectedMethod: "exact" | "fallback";
  readonly selectedAction: UserAction;
  readonly selectedActionKey: string;
  readonly dispatchResultHash: string;
  readonly exactOutcome: "not-attempted" | "used" | "refused";
  readonly exactAlgorithmId: string | null;
  readonly exactResultHash: string | null;
  readonly exactHypothesisSetChecksum: string | null;
  readonly exactConfigHash: string | null;
  readonly exactDiagnosticsHash: string | null;
  readonly exactActionValuesHash: string | null;
  readonly exactPositionalDiagnosticsHash: string | null;
  readonly exactRefusalCode: ExactIneligibilityCode | null;
  readonly exactRefusalDetail: string | null;
  readonly exactDiagnostics: ExactEndgameDiagnostics | null;
  readonly approximateAnalysisId: string | null;
  readonly approximateConfigHash: string | null;
  readonly approximateOutcomeChecksum: string | null;
  readonly fallbackParity: "not-checked" | "passed" | "failed";
  readonly totalMs: number;
  readonly exactMs: number | null;
  readonly fallbackMs: number | null;
  readonly auditHash: string;
};

export type Phase7SearchPolicyFactoryResult = {
  readonly policyConfig: EvaluationUserTimelinePolicyConfig;
  readonly decisions: readonly Phase7SearchDecisionAudit[];
};

function configIdForRole(
  role: Phase7ComparisonRole,
): typeof PHASE7_REFERENCE_CONFIG_ID | typeof PHASE7_CANDIDATE_CONFIG_ID {
  return role === "reference"
    ? PHASE7_REFERENCE_CONFIG_ID
    : PHASE7_CANDIDATE_CONFIG_ID;
}

function actionKey(action: UserAction): string {
  return action.kind === "play-card"
    ? `play:${action.card}`
    : `take:${action.target}`;
}

function selectedAction(result: ResearchSearchDispatchResult): UserAction {
  return result.quality === "Exact"
    ? result.recommendation.recommendedAction
    : result.recommendation.payload.recommendedAction;
}

function policyAction(
  action: UserAction,
  rationale: string,
): EvaluationUserTimelinePolicyAction {
  return action.kind === "play-card"
    ? {
        kind: "play-card",
        card: action.card,
        rationale,
      }
    : {
        kind: "take-hand",
        target: action.target,
        rationale,
      };
}

function assertActionVisibleAndLegal(
  action: UserAction,
  input: EvaluationUserTimelinePolicyInput,
): void {
  if (action.kind === "play-card") {
    if (!input.observation.legalCards.includes(action.card)) {
      throw new Error(
        `Phase 7 search selected illegal public action ${actionKey(action)}.`,
      );
    }
    return;
  }
  if (!(input.observation.legalTakeTargets ?? []).includes(action.target)) {
    throw new Error(
      `Phase 7 search selected illegal public action ${actionKey(action)}.`,
    );
  }
}

function exactAudit(
  result: ResearchSearchDispatchResult,
): Pick<
  Phase7SearchDecisionAudit,
  | "exactOutcome"
  | "exactAlgorithmId"
  | "exactResultHash"
  | "exactHypothesisSetChecksum"
  | "exactConfigHash"
  | "exactDiagnosticsHash"
  | "exactActionValuesHash"
  | "exactPositionalDiagnosticsHash"
  | "exactRefusalCode"
  | "exactRefusalDetail"
  | "exactDiagnostics"
> {
  if (result.exactAttempt === null) {
    return {
      exactOutcome: "not-attempted",
      exactAlgorithmId: null,
      exactResultHash: null,
      exactHypothesisSetChecksum: null,
      exactConfigHash: null,
      exactDiagnosticsHash: null,
      exactActionValuesHash: null,
      exactPositionalDiagnosticsHash: null,
      exactRefusalCode: null,
      exactRefusalDetail: null,
      exactDiagnostics: null,
    };
  }
  if (result.exactAttempt.quality === "Exact") {
    return {
      exactOutcome: "used",
      exactAlgorithmId: result.exactAttempt.algorithmVersion,
      exactResultHash: result.exactAttempt.resultHash,
      exactHypothesisSetChecksum: result.exactAttempt.hypothesisSetChecksum,
      exactConfigHash: result.exactAttempt.configHash,
      exactDiagnosticsHash: stableHash(result.exactAttempt.diagnostics),
      exactActionValuesHash: stableHash(result.exactAttempt.actionValues),
      exactPositionalDiagnosticsHash: stableHash(
        result.exactAttempt.positionalDiagnostics,
      ),
      exactRefusalCode: null,
      exactRefusalDetail: null,
      exactDiagnostics: result.exactAttempt.diagnostics,
    };
  }
  return {
    exactOutcome: "refused",
    exactAlgorithmId: result.exactAttempt.algorithmVersion,
    exactResultHash: result.exactAttempt.resultHash,
    exactHypothesisSetChecksum: result.exactAttempt.hypothesisSetChecksum,
    exactConfigHash: result.exactAttempt.configHash,
    exactDiagnosticsHash: stableHash(result.exactAttempt.diagnostics),
    exactActionValuesHash: stableHash(result.exactAttempt.actionValues),
    exactPositionalDiagnosticsHash: null,
    exactRefusalCode: result.exactAttempt.eligibility.code,
    exactRefusalDetail: result.exactAttempt.eligibility.detail,
    exactDiagnostics: result.exactAttempt.diagnostics,
  };
}

function approximateAudit(
  result: ResearchSearchDispatchResult,
): Pick<
  Phase7SearchDecisionAudit,
  | "approximateAnalysisId"
  | "approximateConfigHash"
  | "approximateOutcomeChecksum"
> {
  if (result.approximateFallback === null) {
    return {
      approximateAnalysisId: null,
      approximateConfigHash: null,
      approximateOutcomeChecksum: null,
    };
  }
  return {
    approximateAnalysisId: result.approximateFallback.payload.analysisId,
    approximateConfigHash: result.approximateFallback.payload.configHash,
    approximateOutcomeChecksum:
      result.approximateFallback.payload.rollout.outcomeChecksum,
  };
}

function verifyFallbackParity(
  input: EvaluationUserTimelinePolicyInput,
  result: ResearchSearchDispatchResult,
): "not-checked" | "passed" | "failed" {
  if (result.approximateFallback === null) {
    return "not-checked";
  }
  const direct = recommendFromTimeline({
    timeline: input.timeline,
    budgetId: "balanced",
    policies: PHASE7_FROZEN_CONTINUATION_POLICIES,
    seeds: input.solverSeeds,
  });
  return stableStringify(direct.payload) ===
    stableStringify(result.approximateFallback.payload)
    ? "passed"
    : "failed";
}

function decisionAudit(
  input: EvaluationUserTimelinePolicyInput,
  result: ResearchSearchDispatchResult,
  action: UserAction,
  elapsedMs: number,
  fallbackParity: "not-checked" | "passed" | "failed",
): Phase7SearchDecisionAudit {
  const exact = exactAudit(result);
  const approximate = approximateAudit(result);
  const content = {
    schemaVersion: 1 as const,
    role: "candidate" as const,
    configId: PHASE7_CANDIDATE_CONFIG_ID,
    decisionOrdinal: input.observation.decisionOrdinal,
    eventIndex: input.timeline.cursor,
    historyHash: result.historyHash,
    publicStateHash: result.publicStateHash,
    observationHash: stableHash(input.observation),
    selectedMethod:
      result.selectedMethod === "exact-endgame"
        ? ("exact" as const)
        : ("fallback" as const),
    selectedAction: action,
    selectedActionKey: actionKey(action),
    dispatchResultHash: result.resultHash,
    ...exact,
    ...approximate,
    fallbackParity,
    totalMs: elapsedMs,
    exactMs: result.telemetry.exactAttemptElapsedMs,
    fallbackMs: result.telemetry.approximateFallbackElapsedMs,
  };
  return Object.freeze({
    ...content,
    auditHash: stableHash({
      ...content,
      totalMs: null,
      exactMs: null,
      fallbackMs: null,
    }),
  });
}

function referenceDecisionAudit(
  input: EvaluationUserTimelinePolicyInput,
  recommendation: BaselineRecommendation,
  action: UserAction,
  elapsedMs: number,
): Phase7SearchDecisionAudit {
  const dispatchResultHash = stableHash({
    schemaVersion: 1,
    executionPath: "direct-phase5-recommend-from-timeline-v1",
    configId: PHASE7_REFERENCE_CONFIG_ID,
    payload: recommendation.payload,
  });
  const content = {
    schemaVersion: 1 as const,
    role: "reference" as const,
    configId: PHASE7_REFERENCE_CONFIG_ID,
    decisionOrdinal: input.observation.decisionOrdinal,
    eventIndex: input.timeline.cursor,
    historyHash: recommendation.payload.historyHash,
    publicStateHash: recommendation.payload.publicStateHash,
    observationHash: stableHash(input.observation),
    selectedMethod: "fallback" as const,
    selectedAction: action,
    selectedActionKey: actionKey(action),
    dispatchResultHash,
    exactOutcome: "not-attempted" as const,
    exactAlgorithmId: null,
    exactResultHash: null,
    exactHypothesisSetChecksum: null,
    exactConfigHash: null,
    exactDiagnosticsHash: null,
    exactActionValuesHash: null,
    exactPositionalDiagnosticsHash: null,
    exactRefusalCode: null,
    exactRefusalDetail: null,
    exactDiagnostics: null,
    approximateAnalysisId: recommendation.payload.analysisId,
    approximateConfigHash: recommendation.payload.configHash,
    approximateOutcomeChecksum: recommendation.payload.rollout.outcomeChecksum,
    fallbackParity: "not-checked" as const,
    totalMs: elapsedMs,
    exactMs: null,
    fallbackMs: recommendation.telemetry.elapsedMs,
  };
  return Object.freeze({
    ...content,
    auditHash: stableHash({
      ...content,
      totalMs: null,
      exactMs: null,
      fallbackMs: null,
    }),
  });
}

/**
 * Build a per-game search policy and an out-of-band audit sink.
 *
 * The policy is invoked only through the simulator's actor-safe timeline hook.
 * Opponent style labels, the concrete deal, and simulator truth are absent from
 * this function and from every decision input.
 */
export function createPhase7SearchPolicyFactory(input: {
  readonly role: Phase7ComparisonRole;
  readonly solverSeeds: ScenarioSolverSeedSet;
  readonly verifyFallbackParity: boolean;
}): Phase7SearchPolicyFactoryResult {
  const decisions: Phase7SearchDecisionAudit[] = [];
  const configId = configIdForRole(input.role);
  const policyConfig: EvaluationUserTimelinePolicyConfig = {
    solverSeeds: { ...input.solverSeeds },
    createPolicy: (): EvaluationUserTimelinePolicy => ({
      id: configId,
      version: 1,
      chooseAction: (
        policyInput: EvaluationUserTimelinePolicyInput,
      ): EvaluationUserTimelinePolicyAction => {
        if (input.role === "reference") {
          const startedAt = globalThis.performance.now();
          const recommendation = recommendFromTimeline({
            timeline: policyInput.timeline,
            budgetId: "balanced",
            policies: PHASE7_FROZEN_CONTINUATION_POLICIES,
            seeds: policyInput.solverSeeds,
          });
          const elapsedMs = globalThis.performance.now() - startedAt;
          const action = recommendation.payload.recommendedAction;
          assertActionVisibleAndLegal(action, policyInput);
          const audit = referenceDecisionAudit(
            policyInput,
            recommendation,
            action,
            elapsedMs,
          );
          decisions.push(audit);
          return policyAction(
            action,
            `${configId}:phase5-direct:${audit.dispatchResultHash}`,
          );
        }

        const startedAt = globalThis.performance.now();
        const result = recommendResearchFromTimeline({
          timeline: policyInput.timeline,
          budgetId: "balanced",
          policies: PHASE7_FROZEN_CONTINUATION_POLICIES,
          seeds: policyInput.solverSeeds,
          exactMode: "try",
          beliefMode: {
            kind: "hard-only",
            p2ModelId: "documented-basic",
            p3ModelId: "documented-basic",
          },
          advancedConfig: PHASE7_EXACT_SCREEN_CONFIG,
        });
        const elapsedMs = globalThis.performance.now() - startedAt;
        const action = selectedAction(result);
        assertActionVisibleAndLegal(action, policyInput);
        const parity = input.verifyFallbackParity
          ? verifyFallbackParity(policyInput, result)
          : "not-checked";
        const audit = decisionAudit(
          policyInput,
          result,
          action,
          elapsedMs,
          parity,
        );
        decisions.push(audit);
        return policyAction(
          action,
          `${configId}:${result.selectedMethod}:${result.resultHash}`,
        );
      },
    }),
  };
  return {
    policyConfig,
    decisions,
  };
}

export function phase7ComparisonConfigurationHash(
  role: Phase7ComparisonRole,
): string {
  return stableHash({
    schemaVersion: 1,
    role,
    configId: configIdForRole(role),
    budgetId: "balanced",
    policies: PHASE7_FROZEN_CONTINUATION_POLICIES,
    beliefMode: "hard-only",
    behaviorWeightingEnabled: false,
    executionPath:
      role === "reference"
        ? "direct-phase5-recommend-from-timeline-v1"
        : "research-exact-then-phase5-fallback-v1",
    exactEndgameEnabled: role === "candidate",
    ...(role === "candidate"
      ? { advancedConfig: PHASE7_EXACT_SCREEN_CONFIG }
      : {}),
  });
}
