import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CANONICAL_RULES } from "../../src/domain/rule-config";
import { stableHash } from "../../src/events/stable-hash";
import {
  buildPhase7ComparisonArtifactRun,
  phase7ComparisonClusterId,
  phase7ComparisonPairId,
  phase7ComparisonScientificDigest,
  validatePhase7ComparisonArtifactRun,
  verifyPhase7ComparisonArtifacts,
  verifyPhase7ComparisonReproduction,
  writePhase7ComparisonArtifacts,
  type Phase7ComparisonArtifactRun,
} from "../../src/evaluation/phase7-comparison-artifacts";
import {
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
} from "../../src/evaluation/phase7-comparison-schema";
import {
  PHASE7_CANDIDATE_CONFIG_ID,
  PHASE7_REFERENCE_CONFIG_ID,
  phase7ComparisonConfigurationHash,
} from "../../src/evaluation/phase7-search-policy";
import { runBatch, type BatchRunResult } from "../../src/evaluation/batch";
import {
  createPhase4SmokePlan,
  deriveDealSeed,
  deriveStreamSeed,
  type BatchPlan,
} from "../../src/evaluation/protocol";

const CREATED_AT = "2026-07-28T12:00:00.000Z";
const RUN_ID = "phase7-comparison-fixture";
const COMMAND = "tsx scripts/run-phase7-comparison.ts --fixture";
const SOURCE_SNAPSHOT = {
  sourceSnapshotSha256: "a".repeat(64),
  sourceFileCount: 1,
  gitCommit: null,
  gitStatusSha256: "b".repeat(64),
  gitDirty: true,
} as const;
const CONFIGURATIONS = [
  {
    role: "reference",
    configId: PHASE7_REFERENCE_CONFIG_ID,
    configHash: phase7ComparisonConfigurationHash("reference"),
    method: "frozen-phase5-balanced-hard-only",
    executionPath: "direct-phase5-recommend-from-timeline-v1",
    budgetId: "balanced",
    beliefMode: "hard-only",
    continuationPolicies: {
      user: "documented-basic",
      p2: "documented-basic",
      p3: "documented-basic",
    },
    exactScreen: null,
    exactEnabled: false,
    behaviorWeightingEnabled: false,
  },
  {
    role: "candidate",
    configId: PHASE7_CANDIDATE_CONFIG_ID,
    configHash: phase7ComparisonConfigurationHash("candidate"),
    method: "exact-information-state-then-frozen-phase5-fallback",
    executionPath: "research-exact-then-phase5-fallback-v1",
    budgetId: "balanced",
    beliefMode: "hard-only",
    continuationPolicies: {
      user: "documented-basic",
      p2: "documented-basic",
      p3: "documented-basic",
    },
    exactScreen: {
      executionMode: "research-only",
      maxActiveCards: 7,
      maxJointHypotheses: 196,
      maxInformationStates: 128,
      maxBranches: 512,
      approximateHypothesisSamples: 196,
      deadlineMs: 1_000,
    },
    exactEnabled: true,
    behaviorWeightingEnabled: false,
  },
] as const satisfies readonly Phase7ComparisonConfiguration[];

const temporaryRoots: string[] = [];
let phase4: BatchRunResult;

beforeAll(() => {
  const plan: BatchPlan = {
    ...createPhase4SmokePlan("phase7-source-fixture", 1),
    userPolicyIds: ["always-low", "always-high"],
  };
  phase4 = runBatch(plan);
  expect(phase4.failures).toEqual([]);
  expect(phase4.games).toHaveLength(102);
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function configRole(userPolicyId: string): "reference" | "candidate" {
  return userPolicyId === "always-low" ? "reference" : "candidate";
}

function configId(role: "reference" | "candidate"): string {
  return role === "reference"
    ? PHASE7_REFERENCE_CONFIG_ID
    : PHASE7_CANDIDATE_CONFIG_ID;
}

function coordinate(game: BatchRunResult["games"][number]) {
  const role = configRole(game.userPolicyId);
  const pairId = phase7ComparisonPairId({
    split: "dev",
    styleCellId: game.styleCellId,
    baseIndex: game.baseIndex,
    rotation: game.rotation,
  });
  const mappedConfigId = configId(role);
  return {
    schemaVersion: 2 as const,
    protocolId: "eval-v1" as const,
    runId: RUN_ID,
    split: "dev" as const,
    evidenceClass: "phase7-development-screen" as const,
    pairId,
    clusterId: phase7ComparisonClusterId("dev", game.baseIndex),
    configRole: role,
    configId: mappedConfigId,
    styleCellId: game.styleCellId,
    baseIndex: game.baseIndex,
    rotation: game.rotation,
    replicate: 0 as const,
    gameId: stableHash({
      schemaVersion: 1,
      protocol: "phase7-paired-comparison-v1",
      pairId,
      configId: mappedConfigId,
      rules: CANONICAL_RULES,
    }),
  };
}

function seedIds(game: BatchRunResult["games"][number]) {
  const simulatorCommon = {
    split: "dev" as const,
    cell: game.styleCellId,
    baseIndex: game.baseIndex,
    rotation: game.rotation,
    replicate: 0,
  };
  const solverCommon = {
    ...simulatorCommon,
    cell: "phase7-public-solver-inputs-v1",
  };
  const rollout = deriveStreamSeed({
    ...solverCommon,
    stream: "rollout",
  });
  return {
    deal: deriveDealSeed("dev", game.baseIndex),
    userPolicy: rollout,
    p2Policy: deriveStreamSeed({
      ...simulatorCommon,
      stream: "p2-policy",
    }),
    p3Policy: deriveStreamSeed({
      ...simulatorCommon,
      stream: "p3-policy",
    }),
    environmentChance: deriveStreamSeed({
      ...simulatorCommon,
      stream: "chance",
    }),
    belief: deriveStreamSeed({ ...solverCommon, stream: "belief" }),
    search: deriveStreamSeed({ ...solverCommon, stream: "search" }),
    rollout,
    solverChance: deriveStreamSeed({
      ...solverCommon,
      stream: "chance",
    }),
    bootstrap: deriveStreamSeed({
      ...solverCommon,
      stream: "bootstrap",
    }),
  };
}

function mappedGames(): readonly Phase7ComparisonGameRecord[] {
  return phase4.games.map((game) => {
    const mappedCoordinate = coordinate(game);
    const deterministicGameDigest = stableHash({
      gameId: mappedCoordinate.gameId,
      events: game.events,
      bhabhi: game.bhabhi,
      escapeOrder: game.escapeOrder,
      terminalPublicStateHash: game.terminalPublicStateHash,
      deterministicOutcomeHash: game.deterministicOutcomeHash,
    });
    return phase7ComparisonGameRecordSchema.parse({
      ...mappedCoordinate,
      recordType: "phase7-comparison-game",
      completionStatus: "complete",
      opponentPolicies: {
        p2: game.p2PolicyId,
        p3: game.p3PolicyId,
      },
      bhabhi: game.bhabhi,
      userBhabhi: game.bhabhi === "user",
      userFinishingPosition:
        game.bhabhi === "user"
          ? 3
          : Math.min(2, Math.max(1, game.escapeOrder.indexOf("user") + 1)),
      escapeOrder: game.escapeOrder,
      terminalReason: game.terminalReason,
      terminalHandCounts: game.terminalHandCounts,
      eventCount: game.eventCount,
      publicHistoryHash: game.publicHistoryHash,
      terminalPublicStateHash: game.terminalPublicStateHash,
      deterministicOutcomeHash: game.deterministicOutcomeHash,
      deterministicGameDigest,
      events: game.events,
      seedIds: seedIds(game),
      gameWallTimeMs: game.wallTimeMs,
    });
  });
}

function mappedTruths(
  games: readonly Phase7ComparisonGameRecord[],
): readonly Phase7ComparisonTruthRecord[] {
  void games;
  return phase4.truths.map((truth) => {
    const sourceGame = phase4.games.find(
      (candidate) => candidate.gameId === truth.gameId,
    );
    if (sourceGame === undefined) {
      throw new Error(`Missing source game ${truth.gameId}.`);
    }
    return phase7ComparisonTruthRecordSchema.parse({
      ...coordinate(sourceGame),
      recordType: "phase7-comparison-truth-eval-only",
      initialHands: truth.initialHands,
      finalHands: truth.finalHands,
      truthHash: truth.truthHash,
    });
  });
}

function mappedDecisions(): readonly Phase7ComparisonDecisionRecord[] {
  const gamesById = new Map(phase4.games.map((game) => [game.gameId, game]));
  return phase4.decisions
    .filter((decision) => decision.actor === "user")
    .map((decision) => {
      const game = gamesById.get(decision.gameId);
      if (game === undefined) {
        throw new Error(`Missing decision game ${decision.gameId}.`);
      }
      const role = configRole(game.userPolicyId);
      const mappedCoordinate = coordinate(game);
      const mappedSeeds = seedIds(game);
      const exactUse =
        role === "candidate" && decision.actorDecisionOrdinal === 0;
      const exactRefusal = role === "candidate" && !exactUse;
      const selectedAction = {
        actionKind: decision.actionKind,
        selectedCard: decision.selectedCard,
        selectedTakeTarget: decision.selectedTakeTarget,
      };
      return phase7ComparisonDecisionRecordSchema.parse({
        ...mappedCoordinate,
        recordType: "phase7-comparison-decision",
        decisionId: `${mappedCoordinate.gameId}/${decision.eventIndex.toString()}`,
        decisionOrdinal: decision.actorDecisionOrdinal,
        eventIndex: decision.eventIndex,
        publicHistoryHash: decision.publicHistoryHash,
        publicStateHash: decision.publicStateHash,
        observationHash: decision.observationHash,
        ...selectedAction,
        selectedActionHash: stableHash(selectedAction),
        dispatchOutcome: exactUse ? "exact" : "fallback",
        quality: exactUse ? "Exact" : "Approximate",
        exactOutcome:
          role === "reference"
            ? "not-attempted"
            : exactUse
              ? "used"
              : "refused",
        exactRefusalCode: exactRefusal ? "ACTIVE_CARD_LIMIT" : null,
        exactRefusalDetail: exactRefusal
          ? {
              code: "ACTIVE_CARD_LIMIT",
              message: "Fixture typed structural refusal.",
              boundaryHash: stableHash({
                gameId: mappedCoordinate.gameId,
                decisionOrdinal: decision.actorDecisionOrdinal,
              }),
            }
          : null,
        fallbackParity: exactRefusal ? "passed" : "not-checked",
        dispatchHash: stableHash({
          gameId: mappedCoordinate.gameId,
          decisionOrdinal: decision.actorDecisionOrdinal,
          outcome: exactUse ? "exact" : "fallback",
        }),
        analysisInputHash: stableHash({
          configId: mappedCoordinate.configId,
          historyHash: decision.publicHistoryHash,
          publicStateHash: decision.publicStateHash,
          observationHash: decision.observationHash,
          beliefSeed: mappedSeeds.belief,
          searchSeed: mappedSeeds.search,
          rolloutSeed: mappedSeeds.rollout,
          chanceSeed: mappedSeeds.solverChance,
          bootstrapSeed: mappedSeeds.bootstrap,
        }),
        analysisOutputHash: stableHash({
          selectedAction,
          quality: exactUse ? "Exact" : "Approximate",
        }),
        exactAlgorithmId: role === "candidate" ? "exact-fixture-v1" : null,
        exactConfigHash:
          role === "candidate" ? "fnv1a64:exact-config-fixture" : null,
        hypothesisSetHash:
          role === "candidate" ? "fnv1a64:hypothesis-fixture" : null,
        exactResultHash:
          role === "candidate"
            ? stableHash({
                exactUse,
                decisionId: `${mappedCoordinate.gameId}/${decision.eventIndex.toString()}`,
              })
            : null,
        exactDiagnosticsHash:
          role === "candidate"
            ? stableHash({
                diagnostics: true,
                decisionId: `${mappedCoordinate.gameId}/${decision.eventIndex.toString()}`,
              })
            : null,
        exactActionValuesHash:
          role === "candidate"
            ? stableHash({
                actionValues: exactUse ? [decision.selectedCard] : [],
              })
            : null,
        positionalDiagnosticsHash: exactUse
          ? stableHash({ position: decision.actorDecisionOrdinal })
          : null,
        fallbackConfigHash: exactUse ? null : "fnv1a64:phase5-fallback-config",
        fallbackResultHash: exactUse
          ? null
          : stableHash({
              fallback: true,
              decisionId: `${mappedCoordinate.gameId}/${decision.eventIndex.toString()}`,
            }),
        beliefSeedId: mappedSeeds.belief,
        searchSeedId: mappedSeeds.search,
      });
    });
}

function mappedLatencies(
  decisions: readonly Phase7ComparisonDecisionRecord[],
): readonly Phase7ComparisonLatencyRecord[] {
  return decisions.map((decision) =>
    phase7ComparisonLatencyRecordSchema.parse({
      schemaVersion: decision.schemaVersion,
      protocolId: decision.protocolId,
      runId: decision.runId,
      split: decision.split,
      evidenceClass: decision.evidenceClass,
      pairId: decision.pairId,
      clusterId: decision.clusterId,
      configRole: decision.configRole,
      configId: decision.configId,
      styleCellId: decision.styleCellId,
      baseIndex: decision.baseIndex,
      rotation: decision.rotation,
      replicate: decision.replicate,
      gameId: decision.gameId,
      recordType: "phase7-comparison-latency",
      decisionId: decision.decisionId,
      decisionOrdinal: decision.decisionOrdinal,
      eventIndex: decision.eventIndex,
      totalMs: decision.configRole === "candidate" ? 7 : 3,
      exactMs: decision.exactOutcome === "not-attempted" ? null : 4,
      fallbackMs: decision.dispatchOutcome === "fallback" ? 3 : null,
    }),
  );
}

async function artifactFixture(
  runId = RUN_ID,
  mutate?: (input: {
    games: Phase7ComparisonGameRecord[];
    truths: Phase7ComparisonTruthRecord[];
    failures: Phase7ComparisonFailureRecord[];
    decisions: Phase7ComparisonDecisionRecord[];
    latencies: Phase7ComparisonLatencyRecord[];
  }) => void,
): Promise<{
  readonly root: string;
  readonly run: Phase7ComparisonArtifactRun;
}> {
  const root = await mkdtemp(join(tmpdir(), "bhabhi-phase7-comparison-"));
  temporaryRoots.push(root);
  const protocolPlanPath = join(root, "evaluation-plan.md");
  await writeFile(protocolPlanPath, "# Frozen Phase 7 test plan\n", "utf8");
  const games = [...mappedGames()];
  const truths = [...mappedTruths(games)];
  const failures: Phase7ComparisonFailureRecord[] = [];
  const decisions = [...mappedDecisions()];
  const latencies = [...mappedLatencies(decisions)];
  mutate?.({ games, truths, failures, decisions, latencies });
  const remapRunId = <T extends { readonly runId: string }>(record: T): T => ({
    ...record,
    runId,
  });
  return {
    root,
    run: await buildPhase7ComparisonArtifactRun({
      projectRoot: root,
      protocolPlanPath,
      runId,
      runKind: "smoke",
      split: "dev",
      ruleProfileId: "canonical-v1",
      rules: CANONICAL_RULES,
      configurations: CONFIGURATIONS,
      baseIndexStart: 0,
      baseCount: 1,
      eventCap: 4_096,
      verifyFallbackParity: true,
      bootstrapSeedId: deriveStreamSeed({
        split: "dev",
        stream: "bootstrap",
        cell: "phase7-paired-macro",
        baseIndex: 0,
        rotation: 0,
        replicate: 0,
      }),
      command: COMMAND,
      games: games.map(remapRunId),
      truths: truths.map(remapRunId),
      failures: failures.map(remapRunId),
      decisions: decisions.map(remapRunId),
      latencies: latencies.map(remapRunId),
      createdAt: CREATED_AT,
      sourceSnapshot: SOURCE_SNAPSHOT,
    }),
  };
}

function decisionWithOutcome(
  run: Phase7ComparisonArtifactRun,
  outcome: Phase7ComparisonDecisionRecord["exactOutcome"],
  occurrence = 0,
): Phase7ComparisonDecisionRecord {
  const decision = run.decisions.filter(
    (candidate) => candidate.exactOutcome === outcome,
  )[occurrence];
  if (decision === undefined) {
    throw new Error(
      `Fixture has no ${outcome} exact decision at occurrence ${occurrence.toString()}.`,
    );
  }
  return decision;
}

function withDecisionPatch(
  run: Phase7ComparisonArtifactRun,
  decisionId: string,
  patch: Partial<Phase7ComparisonDecisionRecord>,
): Phase7ComparisonArtifactRun {
  return {
    ...run,
    decisions: run.decisions.map((decision) =>
      decision.decisionId === decisionId
        ? {
            ...decision,
            ...patch,
          }
        : decision,
    ),
  };
}

describe("Phase 7 paired-comparison artifact store", () => {
  it("accepts only complete not-attempted, refused, and used exact-audit shapes", async () => {
    const { run } = await artifactFixture(
      "phase7-comparison-exact-audit-fixture",
    );
    const notAttempted = decisionWithOutcome(run, "not-attempted");
    const refused = decisionWithOutcome(run, "refused");
    const secondRefused = decisionWithOutcome(run, "refused", 1);
    const used = decisionWithOutcome(run, "used");
    const secondUsed = decisionWithOutcome(run, "used", 1);

    expect(notAttempted).toMatchObject({
      dispatchOutcome: "fallback",
      quality: "Approximate",
      exactRefusalCode: null,
      exactRefusalDetail: null,
      exactAlgorithmId: null,
      exactConfigHash: null,
      hypothesisSetHash: null,
      exactResultHash: null,
      exactDiagnosticsHash: null,
      exactActionValuesHash: null,
      positionalDiagnosticsHash: null,
    });
    expect([
      notAttempted.fallbackConfigHash,
      notAttempted.fallbackResultHash,
    ]).not.toContain(null);
    expect(refused).toMatchObject({
      dispatchOutcome: "fallback",
      quality: "Approximate",
      exactRefusalCode: "ACTIVE_CARD_LIMIT",
      exactRefusalDetail: {
        code: "ACTIVE_CARD_LIMIT",
      },
      positionalDiagnosticsHash: null,
    });
    expect(typeof refused.exactRefusalDetail?.message).toBe("string");
    expect(typeof refused.exactRefusalDetail?.boundaryHash).toBe("string");
    expect([
      refused.exactAlgorithmId,
      refused.exactConfigHash,
      refused.hypothesisSetHash,
      refused.exactResultHash,
      refused.exactDiagnosticsHash,
      refused.exactActionValuesHash,
      refused.fallbackConfigHash,
      refused.fallbackResultHash,
    ]).not.toContain(null);
    expect(used).toMatchObject({
      dispatchOutcome: "exact",
      quality: "Exact",
      exactRefusalCode: null,
      exactRefusalDetail: null,
      fallbackConfigHash: null,
      fallbackResultHash: null,
    });
    expect([
      used.exactAlgorithmId,
      used.exactConfigHash,
      used.hypothesisSetHash,
      used.exactResultHash,
      used.exactDiagnosticsHash,
      used.exactActionValuesHash,
      used.positionalDiagnosticsHash,
    ]).not.toContain(null);

    const malformedCases: readonly {
      readonly decision: Phase7ComparisonDecisionRecord;
      readonly patch: Partial<Phase7ComparisonDecisionRecord>;
    }[] = [
      {
        decision: notAttempted,
        patch: { exactResultHash: "fnv1a64:unexpected-exact-result" },
      },
      {
        decision: refused,
        patch: { hypothesisSetHash: null },
      },
      {
        decision: secondRefused,
        patch: { exactActionValuesHash: null },
      },
      {
        decision: used,
        patch: { positionalDiagnosticsHash: null },
      },
      {
        decision: secondUsed,
        patch: { fallbackConfigHash: "fnv1a64:unexpected-fallback-config" },
      },
    ];

    const malformedRun = malformedCases.reduce(
      (current, malformed) =>
        withDecisionPatch(
          current,
          malformed.decision.decisionId,
          malformed.patch,
        ),
      run,
    );
    const issues = validatePhase7ComparisonArtifactRun(malformedRun);
    for (const malformed of malformedCases) {
      expect(issues).toContain(
        `${malformed.decision.decisionId} has a partial or internally inconsistent exact audit.`,
      );
    }
  }, 20_000);

  it("derives the full 17x3 paired macro, exact audit gates, and a timing-free digest", async () => {
    const { run } = await artifactFixture();

    expect(run.summary).toMatchObject({
      evidenceEligible: false,
      runKind: "smoke",
      expectedPairs: 51,
      expectedGames: 102,
      attemptedGames: 102,
      completedGames: 102,
      failedGames: 0,
      silentExclusionCount: 0,
      protocolSampleSizeGate: true,
      frozenConfigurationGate: true,
      canonicalRulesGate: true,
      seedDerivationGate: true,
      pairedInitialDealGate: true,
      decisionAuditCoverageGate: true,
      fullMatrixGate: true,
      identicalScenarioSeedCoverageGate: true,
      pairingCompleteGate: true,
      zeroFailureGate: true,
      atLeastOneExactUseGate: true,
      zeroDeadlineRefusalGate: true,
      everyCandidateFallbackTypedGate: true,
      noPartialExactGate: true,
      truthReplayGate: true,
      pairedMacro: {
        resamples: 20_000,
        clusterCount: 1,
        outcomesPerConfigPerCluster: 51,
      },
    });
    expect(
      run.summary.configAggregates.find(
        (aggregate) => aggregate.role === "candidate",
      ),
    ).toMatchObject({
      exactUseCount: 51,
      silentFallbackCount: 0,
      fallbackParityFailureCount: 0,
    });

    const timingChangedGames = run.games.map((game) => ({
      ...game,
      gameWallTimeMs: game.gameWallTimeMs + 10_000,
    }));
    expect(
      phase7ComparisonScientificDigest({
        configurations: run.manifest.configurations,
        games: timingChangedGames,
        truths: run.truths,
        failures: run.failures,
        decisions: run.decisions,
      }),
    ).toBe(run.summary.scientificDigest);
  }, 20_000);

  it("rejects frozen-config drift, forged seeds, and omitted user-action audits", async () => {
    const { run } = await artifactFixture(
      "phase7-comparison-adversarial-fixture",
    );
    const omitted = run.decisions[0];
    const firstGame = run.games[0];
    if (omitted === undefined || firstGame === undefined) {
      throw new Error("Adversarial fixture is unexpectedly empty.");
    }
    const issues = validatePhase7ComparisonArtifactRun({
      ...run,
      manifest: {
        ...run.manifest,
        runKind: "development-primary",
        configurations: run.manifest.configurations.map(
          (configuration, index) =>
            index === 0
              ? {
                  ...configuration,
                  configHash: "fnv1a64:forged-reference-config",
                }
              : configuration,
        ),
      },
      games: run.games.map((game, index) =>
        index === 0
          ? {
              ...game,
              seedIds: {
                ...game.seedIds,
                solverChance: "forged-solver-chance",
              },
            }
          : game,
      ),
      decisions: run.decisions.filter(
        (decision) => decision.decisionId !== omitted.decisionId,
      ),
      latencies: run.latencies.filter(
        (latency) => latency.decisionId !== omitted.decisionId,
      ),
    });

    expect(issues).toContain(
      "Manifest configurations differ from the full frozen Phase 7 descriptors.",
    );
    expect(issues).toContain(
      "Manifest run kind does not match the preregistered sample profile.",
    );
    expect(issues).toContain(
      "One or more scenario seeds do not match the frozen public/private derivation.",
    );
    expect(issues).toContain(
      "Completed games do not have exactly one action-matching audit per user decision.",
    );
  }, 20_000);

  it("writes once under eval-v1/split/run-id and independently verifies every stream", async () => {
    const { root, run } = await artifactFixture(
      "phase7-comparison-write-fixture",
    );
    const artifactRoot = join(root, "artifacts", "evaluation");
    const written = await writePhase7ComparisonArtifacts(run, artifactRoot);

    expect(written.runDirectory).toBe(
      join(artifactRoot, "eval-v1", "dev", "phase7-comparison-write-fixture"),
    );
    await expect(
      writePhase7ComparisonArtifacts(run, artifactRoot),
    ).rejects.toThrow(/already exists/iu);

    const verification = await verifyPhase7ComparisonArtifacts(
      written.runDirectory,
    );
    expect(verification).toMatchObject({
      valid: true,
      gamesReplayed: 102,
      truthsReplayed: 102,
      decisionsValidated: run.decisions.length,
      latencyRecordsValidated: run.latencies.length,
      recordedFailures: 0,
      failures: [],
      scientificDigest: run.summary.scientificDigest,
      zeroFailureGate: true,
    });
  }, 20_000);

  it("never lets one valid smoke artifact self-certify a development rerun", async () => {
    const { root, run } = await artifactFixture(
      "phase7-comparison-no-self-certification",
    );
    const written = await writePhase7ComparisonArtifacts(
      run,
      join(root, "artifacts", "evaluation"),
    );
    const reproduction = await verifyPhase7ComparisonReproduction({
      smokeDirectory: written.runDirectory,
      primaryDirectory: written.runDirectory,
      reproductionDirectory: written.runDirectory,
    });

    expect(reproduction.valid).toBe(false);
    expect(reproduction.attestation).toBeNull();
    expect(reproduction.failures).toContain(
      "Smoke, primary, and reproduction directories must be distinct.",
    );
    expect(reproduction.failures).toContain(
      "Artifact run kinds must be smoke, development-primary, and development-reproduction in order.",
    );
  }, 60_000);

  it("retains an explicit failed coordinate in the denominator without manufacturing an interval", async () => {
    const { run } = await artifactFixture(
      "phase7-comparison-failure-fixture",
      ({ games, truths, failures, decisions, latencies }) => {
        const failedIndex = games.findIndex(
          (game) => game.configRole === "candidate",
        );
        const failed = games[failedIndex];
        if (failed === undefined) {
          throw new Error("Fixture has no candidate game.");
        }
        games.splice(failedIndex, 1);
        const truthIndex = truths.findIndex(
          (truth) => truth.gameId === failed.gameId,
        );
        truths.splice(truthIndex, 1);
        for (let index = decisions.length - 1; index >= 0; index -= 1) {
          if (decisions[index]?.gameId === failed.gameId) {
            decisions.splice(index, 1);
          }
        }
        for (let index = latencies.length - 1; index >= 0; index -= 1) {
          if (latencies[index]?.gameId === failed.gameId) {
            latencies.splice(index, 1);
          }
        }
        failures.push(
          phase7ComparisonFailureRecordSchema.parse({
            schemaVersion: failed.schemaVersion,
            protocolId: failed.protocolId,
            runId: failed.runId,
            split: failed.split,
            evidenceClass: failed.evidenceClass,
            pairId: failed.pairId,
            clusterId: failed.clusterId,
            configRole: failed.configRole,
            configId: failed.configId,
            styleCellId: failed.styleCellId,
            baseIndex: failed.baseIndex,
            rotation: failed.rotation,
            replicate: failed.replicate,
            gameId: failed.gameId,
            recordType: "phase7-comparison-failure",
            completionStatus: "turn-cap",
            failureId: `${failed.gameId}/turn-cap`,
            kind: "turn-cap",
            stage: "simulate-complete-game",
            error: {
              name: "SimulationRunError",
              code: "EVENT_CAP",
              message: "Fixture retained turn cap.",
            },
            lastGoodEventIndex: -1,
            deterministicFailureHash: stableHash({
              gameId: failed.gameId,
              kind: "turn-cap",
            }),
            seedIds: failed.seedIds,
          }),
        );
      },
    );

    expect(validatePhase7ComparisonArtifactRun(run)).toEqual([]);
    expect(run.summary).toMatchObject({
      attemptedGames: 102,
      completedGames: 101,
      failedGames: 1,
      turnCapGames: 1,
      silentExclusionCount: 0,
      zeroSilentExclusionGate: true,
      fullMatrixGate: true,
      identicalScenarioSeedCoverageGate: true,
      zeroFailureGate: false,
      zeroTurnCapGate: false,
      pairingCompleteGate: false,
      truthReplayGate: true,
      pairedMacro: null,
    });
  }, 20_000);
});
