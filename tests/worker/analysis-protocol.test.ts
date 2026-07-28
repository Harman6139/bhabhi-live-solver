import { describe, expect, it } from "vitest";

import {
  MAX_ANALYSIS_ARCHIVE_BYTES,
  analysisWorkerRequestSchema,
  createAnalysisWorkerRequest,
  processAnalysisWorkerRequest,
} from "../../src/worker";
import { temporalTimeline } from "../inference/test-fixtures";

describe("analysis worker protocol", () => {
  it("rejects oversized or structurally invalid envelopes before analysis", () => {
    expect(() =>
      analysisWorkerRequestSchema.parse({
        schemaVersion: 1,
        protocolVersion: "analysis-worker-protocol-v1",
        type: "analyze",
        requestId: "request",
        requestOrdinal: 0,
        sessionEpoch: 0,
        stateVersion: 1,
        historyHash: "history",
        publicStateHash: "state",
        budgetId: "instant",
        timelineArchive: "x".repeat(MAX_ANALYSIS_ARCHIVE_BYTES + 1),
        seeds: {},
        binding: {
          sourceHash: "source",
          solverConfigHash: "config",
          modelHash: "model",
          protocolHash: "protocol",
        },
      }),
    ).toThrow();
  });

  it("returns a typed failure rather than throwing on an invalid request", async () => {
    await expect(
      processAnalysisWorkerRequest({ type: "analyze" }),
    ).resolves.toMatchObject({
      type: "failure",
      code: "INVALID_ENVELOPE",
      searchCode: null,
    });
  });

  it("refuses analysis until a verified release bundle is injected", async () => {
    const request = createAnalysisWorkerRequest({
      timeline: temporalTimeline(3),
      requestOrdinal: 7,
      sessionEpoch: 2,
      budgetId: "instant",
      binding: {
        bundleMode: "evaluation-only",
        manifestScope: "qualification",
        manifestHash: "e".repeat(64),
        sourceHash: "a".repeat(64),
        solverConfigHash: "b".repeat(64),
        modelHash: "c".repeat(64),
        protocolHash: "d".repeat(64),
        selectedConfigId: "p8-r-hard-balanced-v1",
        selectionAttestationHash: null,
        finalAttestationHash: null,
      },
    });
    const response = await processAnalysisWorkerRequest(request);

    expect(response).toMatchObject({
      type: "failure",
      code: "RELEASE_UNAVAILABLE",
      requestId: request.requestId,
      requestOrdinal: 7,
      sessionEpoch: 2,
      stateVersion: request.stateVersion,
      historyHash: request.historyHash,
      publicStateHash: request.publicStateHash,
    });
  });
});
