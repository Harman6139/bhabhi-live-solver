import { describe, expect, it } from "vitest";

import {
  activeTimelineEvents,
  replayTimeline,
} from "../../src/events/timeline";
import { buildHardBelief } from "../../src/inference/belief";
import {
  analyzeScenarioSetForTesting,
  recommendFromTimeline,
  SearchError,
  solverBudget,
} from "../../src/search";
import { temporalTimeline } from "../inference/test-fixtures";

describe("production recommendation boundary", () => {
  it("evaluates every legal action to terminal utility reproducibly", () => {
    const timeline = temporalTimeline(3);
    const first = recommendFromTimeline({
      timeline,
      budgetId: "instant",
    });
    const second = recommendFromTimeline({
      timeline,
      budgetId: "instant",
    });

    expect(first.payload).toEqual(second.payload);
    expect(first.payload.quality).toBe("Approximate");
    expect(first.payload.method).toBe("hard-belief-terminal-root-rollout");
    expect(first.payload.legalActions).toHaveLength(17);
    expect(first.payload.candidates).toHaveLength(17);
    expect(first.payload.rollout).toMatchObject({
      completed: 17,
      perAction: 1,
      scenarios: 1,
      replicatesPerScenario: 1,
      failures: 0,
      eventCapHits: 0,
    });
    expect(
      first.payload.candidates.every(
        (candidate) =>
          candidate.terminalRollouts === 1 &&
          candidate.scenarioClusters === 1 &&
          candidate.interval.method === "cluster-wilson-score",
      ),
    ).toBe(true);
    expect(first.payload.legalActions).toContainEqual(
      first.payload.recommendedAction,
    );
    expect(first.payload.belief.method).toBe("direct-uniform-sample");
    expect(first.telemetry.deterministicWorkCompleted).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.payload.candidates[0])).toBe(true);
  });

  it("rejects non-user turns and pre-cancelled work without a partial result", () => {
    expect(() =>
      recommendFromTimeline({
        timeline: temporalTimeline(1),
        budgetId: "instant",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "NOT_USER_TURN",
      } satisfies Partial<SearchError>),
    );

    const controller = new AbortController();
    controller.abort();
    expect(() =>
      recommendFromTimeline({
        timeline: temporalTimeline(3),
        budgetId: "instant",
        signal: controller.signal,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "CANCELLED",
      } satisfies Partial<SearchError>),
    );
  });

  it("refuses a stale or truncated event ledger before ranking scenarios", () => {
    const timeline = temporalTimeline(3);
    const replay = replayTimeline(timeline);
    const belief = buildHardBelief(timeline, {
      seed: "production-boundary-test",
      forceSampling: true,
      sampleCount: 1,
      maxExactWorlds: 1,
      maxExactProjectionOperations: 1,
      maxExactEstimatedBytes: 1,
    });
    const truncated = activeTimelineEvents(timeline).slice(0, -1);

    expect(() =>
      analyzeScenarioSetForTesting({
        publicState: replay.state,
        historyHash: replay.semanticHash,
        stateVersion: timeline.cursor,
        activeEvents: truncated,
        scenarios: belief.worlds.map((world) => ({
          witnessId: world.witnessId,
          currentHands: world.currentHands,
        })),
        belief: {
          method: belief.method,
          totalInitialDealWorlds: belief.diagnostics.totalInitialDealWorlds,
          worldSetChecksum: belief.diagnostics.worldSetChecksum,
          uniqueWitnesses: belief.diagnostics.uniqueWitnesses,
        },
        budget: solverBudget("instant"),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "STALE_WORLD",
      } satisfies Partial<SearchError>),
    );
  });
});
