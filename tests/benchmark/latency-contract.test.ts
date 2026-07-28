import { describe, expect, it } from "vitest";

import {
  LATENCY_RELEASE_MINIMUMS,
  accountStaleRace,
  createLatencySummary,
  latencyScheduleSchema,
  nearestRankPercentile,
  releaseLatencySchedule,
  summarizeDistribution,
} from "../../src/benchmark";
import { stableStringify } from "../../src/events/stable-hash";
import {
  FIXTURE_RUN_ID,
  fixtureCorpus,
  fixturePhase8Manifest,
  fixtureRecords,
  fixtureSchedule,
} from "./fixtures";

describe("Phase 8 latency math and schedule contract", () => {
  it("uses deterministic nearest-rank p50/p95/p99 statistics", () => {
    const values = Array.from({ length: 100 }, (_, index) => 100 - index);

    expect(nearestRankPercentile(values, 0.5)).toBe(50);
    expect(nearestRankPercentile(values, 0.95)).toBe(95);
    expect(nearestRankPercentile(values, 0.99)).toBe(99);
    expect(summarizeDistribution(values)).toMatchObject({
      samples: 100,
      min: 1,
      mean: 50.5,
      p50: 50,
      p95: 95,
      p99: 99,
      max: 100,
    });
    expect(() => nearestRankPercentile([], 0.95)).toThrow(/empty/u);
    expect(() => nearestRankPercentile([1], 0)).toThrow(/\(0, 1\]/u);
  });

  it("enforces release minima only when evidence eligibility is claimed", () => {
    expect(() =>
      latencyScheduleSchema.parse({
        ...fixtureSchedule(),
        evidenceEligible: true,
      }),
    ).toThrow(/Evidence-eligible latency/u);

    const release = releaseLatencySchedule();
    expect(release.warm.instant).toBe(LATENCY_RELEASE_MINIMUMS.warmPerLiveMode);
    expect(release.cold.deep).toBe(LATENCY_RELEASE_MINIMUMS.coldPerLiveMode);
    expect(release.offline).toBe(LATENCY_RELEASE_MINIMUMS.offline);
    expect(release.races).toBe(LATENCY_RELEASE_MINIMUMS.races);
  });
});

describe("Phase 8 stale-publication accounting", () => {
  it("publishes only the current identity and reports obsolete responses separately", () => {
    expect(
      accountStaleRace({
        oldStatus: "success",
        oldRequestId: "old",
        currentStatus: "success",
        currentRequestId: "current",
        currentResponseRequestId: "current",
      }),
    ).toEqual({
      publishedRequestId: "current",
      obsoleteResponseObserved: true,
      obsoletePublicationCount: 0,
      oldCancellationCount: 0,
      currentPublicationCount: 1,
    });
  });

  it("counts cancellation and rejects a mismatched current response", () => {
    expect(
      accountStaleRace({
        oldStatus: "cancelled",
        oldRequestId: "old",
        currentStatus: "success",
        currentRequestId: "current",
        currentResponseRequestId: "wrong",
      }),
    ).toEqual({
      publishedRequestId: null,
      obsoleteResponseObserved: false,
      obsoletePublicationCount: 0,
      oldCancellationCount: 1,
      currentPublicationCount: 0,
    });
  });
});

describe("Phase 8 deterministic latency summary", () => {
  it("regenerates byte-identically and changes when raw timing changes", () => {
    const manifest = fixturePhase8Manifest();
    const corpus = fixtureCorpus(manifest);
    const schedule = fixtureSchedule();
    const binding = {
      runId: FIXTURE_RUN_ID,
      phase8ManifestId: manifest.manifestId,
      phase8ManifestSha256: corpus.phase8ManifestSha256,
      corpusId: corpus.corpusId,
      corpusSha256: corpus.corpusSha256,
      configId: "p8-r-hard-balanced-v1",
      schedule,
    };
    const records = fixtureRecords();

    const first = createLatencySummary({
      binding,
      records,
      failures: [],
    });
    const second = createLatencySummary({
      binding,
      records: structuredClone(records),
      failures: [],
    });

    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(first.gate.operationalPass).toBe(true);
    expect(first.gate.releaseMinimumsPass).toBe(false);
    expect(first.gate.evidenceGatePass).toBe(false);
    expect(first.memory.workerMemoryBytes).toBeNull();
    expect(first.memory.workerMemoryUnavailableReasons).not.toHaveLength(0);

    const changed = records.map((record) =>
      record.recordType === "request-latency" &&
      record.phase === "measured" &&
      record.mode === "instant" &&
      record.temperature === "warm"
        ? { ...record, wallElapsedMs: record.wallElapsedMs + 1 }
        : record,
    );
    const changedSummary = createLatencySummary({
      binding,
      records: changed,
      failures: [],
    });
    expect(changedSummary.reproductionDigest).not.toBe(
      first.reproductionDigest,
    );
  });
});
