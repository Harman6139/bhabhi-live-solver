import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { strategyRegistryChecksum } from "../../src/strategy/artifacts";
import {
  createPhase7StrategyEvidenceBundle,
  PHASE7_STRATEGY_PROTOCOL_ID,
  phase7RequiredStrategyTestPaths,
} from "../../src/strategy/phase7-evidence";
import {
  summarizeStrategyEvidence,
  verifyStrategyEvidence,
  type StrategyCommandRecord,
} from "../../src/strategy/evidence";
import { MOTIF_REGISTRY } from "../../src/strategy/registry";
import { createPhase7StrategyRecords } from "../../scripts/phase7-strategy-records";
import {
  rawStrategyTestResultChecksum,
  verifyStrategyEvidenceRun,
  writeImmutableStrategyEvidenceRun,
  type RawStrategyTestResult,
  type StrategyEvidenceProtocolDescriptor,
} from "../../scripts/strategy-evidence-artifact-store";

function phase7Fixture(includeExactRecords = false) {
  const testPaths = phase7RequiredStrategyTestPaths();
  const rawResult: RawStrategyTestResult = {
    schemaVersion: 1,
    commandId: "command/phase7-required-strategy-tests",
    argv: ["node", "vitest", "run", ...testPaths],
    exitCode: 0,
    signal: null,
    stdout: "all focused Phase 7 strategy tests passed\n",
    stderr: "",
  };
  const command: StrategyCommandRecord = {
    commandId: rawResult.commandId,
    argv: rawResult.argv,
    workingDirectory: ".",
    sourceRevision: "sha256:phase7-fixture-source",
    environmentChecksum: "sha256:phase7-fixture-environment",
    exitCode: 0,
  };
  const exactRecords = includeExactRecords
    ? createPhase7StrategyRecords(command)
    : {};
  const bundle = createPhase7StrategyEvidenceBundle({
    command,
    resultChecksum: rawStrategyTestResultChecksum(rawResult),
    ...exactRecords,
  });
  const protocol: StrategyEvidenceProtocolDescriptor = {
    protocolId: PHASE7_STRATEGY_PROTOCOL_ID,
    registryChecksum: strategyRegistryChecksum(),
    verificationMode: "final",
  };
  return { bundle, command, protocol, rawResult, testPaths };
}

describe("Phase 7 strategy evidence closure", () => {
  it("closes every required motif while retaining no experimental claim", () => {
    const fixture = phase7Fixture();
    expect(verifyStrategyEvidence(fixture.bundle, { mode: "final" })).toEqual({
      ok: true,
      issues: [],
    });
    expect(
      summarizeStrategyEvidence(fixture.bundle, { mode: "final" }),
    ).toMatchObject({
      registryEntryCount: 48,
      classificationCounts: {
        requiredCorrectness: 28,
        reported: 1,
        hypothesis: 19,
      },
      dispositionCounts: {
        retainedRequired: 28,
        retainedExperimental: 0,
        rejected: 0,
        inconclusive: 0,
        deferredPhase7: 20,
      },
      requiredDirectPassingCount: 28,
      enabledProductionFeatureCount: 0,
    });
    expect(fixture.bundle.eligibility).toEqual([]);
    expect(fixture.bundle.productionDecisions).toEqual([]);

    for (const motifId of ["M39", "M40"] as const) {
      const entry = MOTIF_REGISTRY.find(
        (candidate) => candidate.id === motifId,
      );
      const disposition = fixture.bundle.dispositions.find(
        (candidate) => candidate.motifId === motifId,
      );
      expect(entry?.currentCoverage).toBe("direct");
      expect(disposition?.disposition).toBe("retained-required");
      expect(disposition?.evidenceIds.length).toBe(
        entry?.existingExecutableEvidencePaths.length,
      );
    }
  });

  it("writes and verifies an immutable Phase 7 protocol artifact", async () => {
    const fixture = phase7Fixture(true);
    const stateIds = fixture.bundle.states.map((state) => state.stateId);
    expect(stateIds).toEqual(
      [...stateIds].sort((left, right) => left.localeCompare(right)),
    );
    expect(stateIds).toEqual([
      "state/M39/semantic-pickup-cycle",
      "state/M39/shared-information-state",
      "state/M40/fragile-model-grid",
      "state/M40/stable-model-grid",
    ]);
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "bhabhi-phase7-strategy-"),
    );
    try {
      const runDirectory = await writeImmutableStrategyEvidenceRun({
        outputRoot: temporaryRoot,
        runId: "phase7-strategy-fixture",
        evidenceClass: "development",
        sourceRevision: fixture.command.sourceRevision,
        bundle: fixture.bundle,
        rawTestResult: fixture.rawResult,
        protocol: fixture.protocol,
      });
      const verification = await verifyStrategyEvidenceRun(runDirectory, {
        mode: "final",
        protocol: fixture.protocol,
      });
      expect(verification.ok, verification.issues.join("\n")).toBe(true);
      expect(verification.summary).toMatchObject({
        requiredDirectPassingCount: 28,
        enabledProductionFeatureCount: 0,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
