import { describe, expect, it } from "vitest";

import { CANONICAL_RULES } from "../../src/domain/rule-config";
import { stableHash } from "../../src/events/stable-hash";
import {
  parseProductionAnalysis,
  productionAnalysisHash,
  type ProductionAnalysis,
} from "../../src/production";
import {
  ANALYSIS_WORKER_PROTOCOL_VERSION,
  AnalysisWorkerClient,
  type AnalysisWorkerLike,
  type AnalysisWorkerRequest,
} from "../../src/worker";

const SOURCE_SHA256 = "a".repeat(64);
const CONFIG_SHA256 = "b".repeat(64);
const MODEL_SHA256 = "c".repeat(64);
const PROTOCOL_SHA256 = "d".repeat(64);
const MANIFEST_SHA256 = "e".repeat(64);
const binding = {
  bundleMode: "evaluation-only",
  manifestScope: "qualification",
  manifestHash: MANIFEST_SHA256,
  sourceHash: SOURCE_SHA256,
  solverConfigHash: CONFIG_SHA256,
  modelHash: MODEL_SHA256,
  protocolHash: PROTOCOL_SHA256,
  selectedConfigId: "p8-r-hard-balanced-v1",
  selectionAttestationHash: null,
  finalAttestationHash: null,
} as const;

function request(ordinal: number): AnalysisWorkerRequest {
  return {
    schemaVersion: 2,
    protocolVersion: ANALYSIS_WORKER_PROTOCOL_VERSION,
    type: "analyze",
    requestId: stableHash({ kind: "request", ordinal }),
    requestOrdinal: ordinal,
    sessionEpoch: 3,
    stateVersion: ordinal + 1,
    historyHash: stableHash({ kind: "history", ordinal }),
    publicStateHash: stableHash({ kind: "state", ordinal }),
    budgetId: "instant",
    timelineArchive: "{}",
    seeds: {},
    binding,
  };
}

function analysisFor(value: AnalysisWorkerRequest): ProductionAnalysis {
  const content: Omit<ProductionAnalysis, "analysisHash"> = {
    schemaVersion: 1,
    analysisVersion: "production-analysis-v1",
    identity: {
      stateVersion: value.stateVersion,
      historyHash: value.historyHash,
      publicStateHash: value.publicStateHash,
      underlyingAnalysisId: stableHash({
        kind: "underlying-analysis",
        ordinal: value.requestOrdinal,
      }),
    },
    release: {
      bundleMode: "evaluation-only",
      manifestScope: "qualification",
      manifestHash: MANIFEST_SHA256,
      selectedConfigId: "p8-r-hard-balanced-v1",
      routingContract: "direct-phase5-hard-only",
      sourceHash: value.binding.sourceHash,
      solverConfigHash: value.binding.solverConfigHash,
      modelHash: value.binding.modelHash,
      protocolHash: value.binding.protocolHash,
      selectionAttestationHash: null,
      finalAttestationHash: null,
    },
    route: {
      selectedMethod: "hard-only-approximate",
      quality: "Approximate",
      fallback: {
        used: false,
        targetConfigId: null,
        reasonCode: null,
        requestHash: null,
      },
    },
    budgetId: value.budgetId,
    legalActions: [{ kind: "play-card", card: "2C" }],
    recommendedAction: { kind: "play-card", card: "2C" },
    recommendedActionKey: "play:2C",
    approximateTieActionKeys: [],
    candidates: [
      {
        action: { kind: "play-card", card: "2C" },
        actionKey: "play:2C",
        userBhabhiRisk: 0.5,
        safeProbability: 0.5,
        interval: null,
        approximateTie: false,
        immediatePickupProbability: null,
        expectedImmediatePickupCount: null,
        immediatePowerProbability: null,
        userFinishProbabilities: {
          status: "unavailable",
          reason: "test-fixture",
        },
        firstOpponentEscape: {
          status: "unavailable",
          reason: "test-fixture",
        },
        rootResolutions: {
          status: "unavailable",
          reason: "test-fixture",
        },
      },
    ],
    explanation: {
      status: "unavailable",
      comparatorActionKey: null,
      terminalRiskDifference: null,
      primaryMechanism: null,
      reason: "single-action-test-fixture",
    },
    diagnostics: {
      hardConstraints: {
        evidenceHash: stableHash({ kind: "evidence" }),
        rules: CANONICAL_RULES,
        knownOpponentCards: { p2: [], p3: [] },
        voidObservations: [],
        support: {
          forcedP2: 0,
          forcedP3: 0,
          flexible: 1,
          totalWorldCount: "1",
        },
      },
      belief: {
        method: "hard-direct-uniform-sample",
        worldOccurrences: 1,
        distinctWitnesses: 1,
        effectiveSampleSize: { status: "available", value: 1 },
        entropy: { status: "available", value: 0 },
      },
      behavior: {
        enabled: false,
        configHash: null,
        resultHash: null,
        p2Posterior: [],
        p3Posterior: [],
        likelihoodContributionDefinition:
          "natural-log-observed-predictive-probability",
        likelihoodContributions: {
          status: "unavailable",
          reason: "behavior-disabled",
        },
      },
      sensitivity: {
        status: "unavailable",
        fragile: null,
        reason: "not-computed",
        maximumSwitchRegret: null,
      },
      exact: {
        outcome: "not-attempted",
        configHash: null,
        resultHash: null,
        refusalCode: null,
        refusalDetail: null,
        informationStates: null,
        branches: null,
      },
      work: {
        terminalRollouts: 1,
        weightedHypotheses: 1,
      },
    },
    reproducibility: {
      beliefSeedId: "fixture-belief",
      searchSeedId: "fixture-search",
      rolloutSeedId: "fixture-rollout",
      chanceSeedId: "fixture-chance",
      bootstrapSeedId: "fixture-bootstrap",
    },
    telemetry: {
      elapsedMs: 0,
      deadlineMs: 1,
      deadlineExceeded: false,
    },
    warnings: [],
  };
  return parseProductionAnalysis({
    ...content,
    analysisHash: productionAnalysisHash(content),
  });
}

function successResponse(value: AnalysisWorkerRequest) {
  return {
    schemaVersion: 2 as const,
    protocolVersion: ANALYSIS_WORKER_PROTOCOL_VERSION,
    type: "success" as const,
    requestId: value.requestId,
    requestOrdinal: value.requestOrdinal,
    sessionEpoch: value.sessionEpoch,
    stateVersion: value.stateVersion,
    historyHash: value.historyHash,
    publicStateHash: value.publicStateHash,
    binding: value.binding,
    result: analysisFor(value),
  };
}

class FakeWorker implements AnalysisWorkerLike {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: { readonly message?: string }) => void) | null = null;
  readonly posted: AnalysisWorkerRequest[] = [];
  terminated = false;
  savedMessageHandler: ((event: { readonly data: unknown }) => void) | null =
    null;

  postMessage(value: AnalysisWorkerRequest): void {
    this.posted.push(value);
    this.savedMessageHandler = this.onmessage;
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(value: unknown): void {
    this.onmessage?.({ data: value });
  }

  respondEvenIfTerminated(value: unknown): void {
    this.savedMessageHandler?.({ data: value });
  }
}

describe("AnalysisWorkerClient", () => {
  it("terminates and settles the old request before publishing a successor", async () => {
    const workers: FakeWorker[] = [];
    const client = new AnalysisWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const firstRequest = request(1);
    const secondRequest = request(2);
    const first = client.analyze(firstRequest);
    const second = client.analyze(secondRequest);

    await expect(first).resolves.toEqual({
      status: "cancelled",
      requestId: firstRequest.requestId,
      reason: "superseded",
    });
    expect(workers[0]?.terminated).toBe(true);
    workers[0]?.respondEvenIfTerminated(successResponse(firstRequest));
    workers[1]?.respond(successResponse(secondRequest));
    await expect(second).resolves.toMatchObject({
      status: "success",
      response: {
        requestId: secondRequest.requestId,
        stateVersion: secondRequest.stateVersion,
      },
    });
  });

  it("rejects a response whose state identity differs", async () => {
    const worker = new FakeWorker();
    const client = new AnalysisWorkerClient(() => worker);
    const activeRequest = request(4);
    const result = client.analyze(activeRequest);
    worker.respond({
      ...successResponse(activeRequest),
      historyHash: stableHash({ kind: "other-history" }),
    });

    await expect(result).resolves.toMatchObject({
      status: "failure",
      response: {
        code: "INVALID_ENVELOPE",
      },
    });
  });

  it("makes 1,000 queued stale publications observationally inert", async () => {
    const workers: FakeWorker[] = [];
    const client = new AnalysisWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const outcomes: Promise<unknown>[] = [];
    for (let ordinal = 0; ordinal < 1_001; ordinal += 1) {
      outcomes.push(client.analyze(request(ordinal)));
    }

    for (let ordinal = 0; ordinal < 1_000; ordinal += 1) {
      const worker = workers[ordinal];
      if (worker !== undefined) {
        worker.respondEvenIfTerminated(successResponse(request(ordinal)));
      }
    }
    workers[1_000]?.respond(successResponse(request(1_000)));
    const resolved = await Promise.all(outcomes);

    expect(
      resolved.filter(
        (outcome) =>
          typeof outcome === "object" &&
          outcome !== null &&
          "status" in outcome &&
          outcome.status === "success",
      ),
    ).toHaveLength(1);
    expect(workers.slice(0, 1_000).every((worker) => worker.terminated)).toBe(
      true,
    );
  });

  it("settles invalidation and disposal with typed reasons", async () => {
    const workers: FakeWorker[] = [];
    const client = new AnalysisWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const first = client.analyze(request(9));
    client.invalidate();
    await expect(first).resolves.toMatchObject({
      status: "cancelled",
      reason: "state-invalidated",
    });

    const second = client.analyze(request(10));
    client.dispose();
    await expect(second).resolves.toMatchObject({
      status: "cancelled",
      reason: "disposed",
    });
    expect(() => client.analyze(request(11))).toThrow(/disposed/u);
  });
});
