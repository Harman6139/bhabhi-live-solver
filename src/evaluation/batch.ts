import { SEATS } from "../domain/seats";
import { stableHash } from "../events/stable-hash";
import { semanticHistoryHash } from "../events/timeline";
import { RuleViolation } from "../rules/rule-error";
import {
  createSeededDeal,
  simulateCompleteGame,
  SimulationRunError,
} from "../simulator/game";
import { getBaselinePolicy } from "../simulator/policies";
import {
  decisionArtifactRecordSchema,
  evaluationSummarySchema,
  failureArtifactRecordSchema,
  gameArtifactRecordSchema,
  seedArtifactRecordSchema,
  truthArtifactRecordSchema,
  type DecisionArtifactRecord,
  type EvaluationSummary,
  type FailureArtifactRecord,
  type GameArtifactRecord,
  type SeedArtifactRecord,
  type TruthArtifactRecord,
} from "./artifact-schema";
import {
  expandBatchPlan,
  expectedGameCount,
  type BatchPlan,
  type GameSpec,
} from "./protocol";

export type BatchRunResult = {
  readonly plan: BatchPlan;
  readonly seeds: readonly SeedArtifactRecord[];
  readonly games: readonly GameArtifactRecord[];
  readonly decisions: readonly DecisionArtifactRecord[];
  readonly truths: readonly TruthArtifactRecord[];
  readonly failures: readonly FailureArtifactRecord[];
  readonly summary: EvaluationSummary;
};

function envelope(spec: GameSpec) {
  return {
    schemaVersion: 1 as const,
    protocolId: "eval-v1" as const,
    runId: spec.runId,
    split: spec.split,
    evidenceClass: spec.evidenceClass,
    configId: spec.configId,
    ruleProfileId: spec.ruleProfileId,
    styleCellId: spec.styleCellId,
    baseIndex: spec.baseIndex,
    rotation: spec.rotation,
    replicate: spec.replicate,
    clusterId: spec.clusterId,
    scenarioId: spec.scenarioId,
    gameId: spec.gameId,
  };
}

function seedRecord(spec: GameSpec): SeedArtifactRecord {
  return seedArtifactRecordSchema.parse({
    ...envelope(spec),
    recordType: "seed",
    seeds: spec.seeds,
    rngAlgorithm: "splitmix64-counter-v1",
  });
}

function successfulRecords(
  spec: GameSpec,
  wallTimeMs: number,
  result: ReturnType<typeof simulateCompleteGame>,
): {
  readonly game: GameArtifactRecord;
  readonly decisions: readonly DecisionArtifactRecord[];
  readonly truth: TruthArtifactRecord;
} {
  const terminalEffect = [...result.finalState.effects]
    .reverse()
    .find((effect) => effect.type === "game-completed");
  const eighteenCardHolder = SEATS.find(
    (seat) => result.setup.startingCounts[seat] === 18,
  );
  if (terminalEffect?.type !== "game-completed") {
    throw new Error("Completed simulation has no game-completed effect.");
  }
  if (eighteenCardHolder === undefined) {
    throw new Error("Completed simulation has no 18-card holder.");
  }
  const pickupCount = result.finalState.effects.filter(
    (effect) => effect.type === "trick-picked-up",
  ).length;
  const deterministicGameDigest = stableHash({
    gameId: spec.gameId,
    events: result.events,
    bhabhi: result.bhabhi,
    escapeOrder: result.escapeOrder,
    terminalPublicStateHash: result.terminalPublicStateHash,
    deterministicOutcomeHash: result.outcomeHash,
  });
  const game = gameArtifactRecordSchema.parse({
    ...envelope(spec),
    recordType: "game",
    completionStatus: "complete",
    userPolicyId: spec.userPolicyId,
    p2PolicyId: spec.opponentPolicies.p2,
    p3PolicyId: spec.opponentPolicies.p3,
    rules: spec.rules,
    events: result.events,
    bhabhi: result.bhabhi,
    escapeOrder: result.escapeOrder,
    escapeGroups: result.finalState.escapeGroups,
    terminalReason: terminalEffect.reason,
    terminalHandCounts: result.finalState.handCounts,
    aceSpadesHolder: result.setup.aceSpadesHolder,
    eighteenCardHolder,
    eventCount: result.eventCount,
    decisionCount: result.decisionCount,
    pickupCount,
    chanceCount: result.chanceEvents.length,
    invariantCheckCount: result.eventCount,
    publicHistoryHash: result.semanticHistoryHash,
    terminalPublicStateHash: result.terminalPublicStateHash,
    deterministicOutcomeHash: result.outcomeHash,
    deterministicGameDigest,
    wallTimeMs,
  });
  const decisions = result.decisions.map((decision) =>
    decisionArtifactRecordSchema.parse({
      ...envelope(spec),
      recordType: "decision",
      decisionId: `${spec.gameId}/${decision.eventIndex.toString()}`,
      eventIndex: decision.eventIndex,
      stateVersion: decision.eventIndex,
      actorDecisionOrdinal: decision.decisionOrdinal,
      actor: decision.seat,
      policyId: decision.policyId,
      policyVersion: 1,
      publicHistoryHash: semanticHistoryHash(
        result.events.slice(0, decision.eventIndex),
      ),
      publicStateHash: decision.publicStateHashBefore,
      observationHash: decision.observationHash,
      actionKind: decision.actionKind,
      selectedCard: decision.chosenCard,
      selectedTakeTarget: decision.chosenTakeTarget,
      userLegalCards: decision.seat === "user" ? decision.legalCards : null,
      rationale: decision.rationale,
      rngInvocationId: decision.rngStreamId,
      method: "baseline-policy",
      completionStatus: "complete",
    }),
  );
  const truth = truthArtifactRecordSchema.parse({
    ...envelope(spec),
    recordType: "truth-eval-only",
    initialHands: result.deal,
    finalHands: result.finalHands,
    truthHash: result.terminalTruthHash,
    opponentDecisionAudit: result.decisions.flatMap((decision) =>
      decision.seat === "user"
        ? []
        : [
            {
              eventIndex: decision.eventIndex,
              actor: decision.seat,
              actionKind: decision.actionKind,
              legalCards: decision.legalCards,
              chosenCard: decision.chosenCard,
              chosenTakeTarget: decision.chosenTakeTarget,
            },
          ],
    ),
    chanceAudit: result.chanceEvents.map((chance) => ({
      eventIndex: chance.eventIndex,
      kind: chance.kind,
      eligibleCards: chance.eligibleCards,
      chosenCard: chance.chosenCard,
    })),
  });
  return { game, decisions, truth };
}

function failureKind(error: unknown): {
  readonly kind: FailureArtifactRecord["kind"];
  readonly status: FailureArtifactRecord["completionStatus"];
  readonly code: string | null;
} {
  if (error instanceof SimulationRunError) {
    if (error.code === "EVENT_CAP") {
      return { kind: "turn-cap", status: "turn-cap", code: error.code };
    }
    if (error.code === "INVALID_POLICY_CHOICE") {
      return {
        kind: "illegal-policy-action",
        status: "failed",
        code: error.code,
      };
    }
    return { kind: "exception", status: "failed", code: error.code };
  }
  if (error instanceof RuleViolation && error.code === "INVARIANT_VIOLATION") {
    return { kind: "invariant", status: "failed", code: error.code };
  }
  return {
    kind: "exception",
    status: "failed",
    code:
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null,
  };
}

function failedRecord(spec: GameSpec, error: unknown): FailureArtifactRecord {
  const classified = failureKind(error);
  const name = error instanceof Error ? error.name : "UnknownError";
  const message =
    error instanceof Error ? error.message : "Unknown non-Error failure.";
  const lastGoodEventIndex =
    error instanceof SimulationRunError ? error.eventCount - 1 : -1;
  const deterministicFailureHash = stableHash({
    gameId: spec.gameId,
    kind: classified.kind,
    code: classified.code,
    message,
    lastGoodEventIndex,
  });
  return failureArtifactRecordSchema.parse({
    ...envelope(spec),
    recordType: "failure",
    completionStatus: classified.status,
    failureId: `${spec.gameId}/${deterministicFailureHash}`,
    kind: classified.kind,
    stage: "simulate-complete-game",
    error: {
      name,
      code: classified.code,
      message,
    },
    lastGoodEventIndex,
    replayCommand: `npm run eval:replay -- --game ${spec.gameId}`,
    deterministicFailureHash,
  });
}

function aggregate(
  games: readonly GameArtifactRecord[],
  keys: readonly string[],
  keyForGame: (game: GameArtifactRecord) => string,
): EvaluationSummary["byUserPolicy"] {
  return keys.map((key) => {
    const selected = games.filter((game) => keyForGame(game) === key);
    const userBhabhiCount = selected.filter(
      (game) => game.bhabhi === "user",
    ).length;
    return {
      key,
      games: selected.length,
      userBhabhiCount,
      userBhabhiRate:
        selected.length === 0 ? 0 : userBhabhiCount / selected.length,
    };
  });
}

export function summarizeBatch(
  plan: BatchPlan,
  games: readonly GameArtifactRecord[],
  decisions: readonly DecisionArtifactRecord[],
  failures: readonly FailureArtifactRecord[],
): EvaluationSummary {
  const reproductionDigest = stableHash({
    games: games.map((game) => ({
      gameId: game.gameId,
      digest: game.deterministicGameDigest,
    })),
    decisions: decisions.map((decision) => ({
      decisionId: decision.decisionId,
      selectedCard: decision.selectedCard,
      observationHash: decision.observationHash,
      publicStateHash: decision.publicStateHash,
      rngInvocationId: decision.rngInvocationId,
    })),
    failures: failures.map((failure) => ({
      gameId: failure.gameId,
      digest: failure.deterministicFailureHash,
    })),
  });
  const invariantFailures = failures.filter(
    (failure) => failure.kind === "invariant",
  ).length;
  const turnCapGames = failures.filter(
    (failure) => failure.completionStatus === "turn-cap",
  ).length;
  return evaluationSummarySchema.parse({
    schemaVersion: 1,
    protocolId: "eval-v1",
    runId: plan.runId,
    split: plan.split,
    evidenceClass: plan.evidenceClass,
    evidenceEligible: plan.evidenceEligible,
    expectedGames: expectedGameCount(plan),
    attemptedGames: games.length + failures.length,
    completedGames: games.length,
    failedGames: failures.length,
    turnCapGames,
    invariantFailures,
    zeroFailureGate:
      failures.length === 0 && games.length === expectedGameCount(plan),
    byUserPolicy: aggregate(
      games,
      plan.userPolicyIds.map((id) => id),
      (game) => game.userPolicyId,
    ),
    byStyleCell: aggregate(
      games,
      plan.styleCellIds,
      (game) => game.styleCellId,
    ),
    byRotation: aggregate(
      games,
      plan.rotations.map((rotation) => rotation.toString()),
      (game) => game.rotation.toString(),
    ),
    reproductionDigest,
  });
}

export function runBatch(plan: BatchPlan): BatchRunResult {
  const specs = expandBatchPlan(plan);
  const seeds: SeedArtifactRecord[] = [];
  const games: GameArtifactRecord[] = [];
  const decisions: DecisionArtifactRecord[] = [];
  const truths: TruthArtifactRecord[] = [];
  const failures: FailureArtifactRecord[] = [];

  for (const spec of specs) {
    seeds.push(seedRecord(spec));
    const started = performance.now();
    try {
      const deal = createSeededDeal(spec.seeds.deal, spec.rotation);
      const result = simulateCompleteGame({
        gameId: spec.gameId,
        rules: spec.rules,
        rotation: spec.rotation,
        deal,
        seeds: {
          deal: spec.seeds.deal,
          policy: {
            user: spec.seeds.userPolicy,
            p2: spec.seeds.p2Policy,
            p3: spec.seeds.p3Policy,
          },
          chance: spec.seeds.chance,
        },
        policies: {
          user: getBaselinePolicy(spec.userPolicyId),
          p2: getBaselinePolicy(spec.opponentPolicies.p2),
          p3: getBaselinePolicy(spec.opponentPolicies.p3),
        },
        maxEvents: spec.eventCap,
      });
      const records = successfulRecords(
        spec,
        performance.now() - started,
        result,
      );
      games.push(records.game);
      decisions.push(...records.decisions);
      truths.push(records.truth);
    } catch (error) {
      failures.push(failedRecord(spec, error));
    }
  }
  const summary = summarizeBatch(plan, games, decisions, failures);
  return Object.freeze({
    plan: structuredClone(plan),
    seeds: Object.freeze(seeds),
    games: Object.freeze(games),
    decisions: Object.freeze(decisions),
    truths: Object.freeze(truths),
    failures: Object.freeze(failures),
    summary,
  });
}
