import { describe, expect, it } from "vitest";

import {
  createStrategyActionValuesArtifact,
  createStrategyCommandArtifact,
  createStrategyCounterexamplesArtifact,
  createStrategyFailuresArtifact,
  createStrategyManifestArtifact,
  createStrategyStatesArtifact,
  createStrategySummaryArtifact,
  strategyArtifactPayloadChecksum,
  strategyRegistryChecksum,
  verifyStrategyArtifactChecksum,
} from "../../src/strategy/artifacts";
import type {
  PairedActionValueRecord,
  StrategyCommandRecord,
  StrategyEvidenceSummary,
  StrategyFailureRecord,
  StrategyStateRecord,
} from "../../src/strategy/evidence";
import { MOTIF_IDS, MOTIF_REGISTRY } from "../../src/strategy/registry";

const RUN = {
  schemaVersion: 1,
  runId: "strategy-foundation-fixture",
  evidenceClass: "development",
} as const;

const COMMAND_A: StrategyCommandRecord = {
  commandId: "command/a",
  argv: ["npm", "run", "test:strategy"],
  workingDirectory: ".",
  sourceRevision: "revision",
  environmentChecksum: "environment",
  exitCode: 0,
};

const COMMAND_B: StrategyCommandRecord = {
  ...COMMAND_A,
  commandId: "command/b",
  argv: ["npm", "run", "typecheck"],
};

function state(stateId: string): StrategyStateRecord {
  return {
    stateId,
    motifId: "M01",
    provenance: {
      kind: "synthetic-transition",
      fixtureId: `fixture/${stateId}`,
      stateHash: `hash/${stateId}`,
      transitionSystemVersion: "transition-v1",
      constructionDigest: `construction/${stateId}`,
    },
    rulesChecksum: "rules",
    solverConfigChecksum: "solver",
    seedIds: ["seed"],
    commandId: COMMAND_A.commandId,
  };
}

function actionValue(actionValueId: string): PairedActionValueRecord {
  return {
    actionValueId,
    motifId: "M01",
    stateId: "state/a",
    pairId: `pair/${actionValueId}`,
    pairedSeedId: "seed",
    commandId: COMMAND_A.commandId,
    confirmation: "tune",
    finding: "positive-witness",
    left: {
      actionKey: "left",
      terminalBhabhiRisk: 0.2,
      terminalRollouts: 10,
      outcomeChecksum: "left-outcomes",
    },
    right: {
      actionKey: "right",
      terminalBhabhiRisk: 0.3,
      terminalRollouts: 10,
      outcomeChecksum: "right-outcomes",
    },
    deltaLeftMinusRight: -0.1,
    preferredActionKey: "left",
  };
}

function failure(failureId: string): StrategyFailureRecord {
  return {
    failureId,
    motifId: "M01",
    commandId: COMMAND_A.commandId,
    stage: "search",
    code: "FIXTURE_FAILURE",
    message: "A replayable failure fixture.",
    stateId: "state/a",
    recoverable: true,
  };
}

function summaryFixture(): StrategyEvidenceSummary {
  return {
    schemaVersion: 1,
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
    motifs: MOTIF_REGISTRY.map((entry) => ({
      motifId: entry.id,
      classification: entry.classification,
      disposition:
        entry.classification === "required-correctness"
          ? ("retained-required" as const)
          : ("deferred-phase7" as const),
      evidenceCount: entry.classification === "required-correctness" ? 1 : 0,
      actionValueCount: 0,
      boundaryCount: 0,
      failureCount: 0,
    })),
    productionFeatures: [],
  };
}

describe("strategy artifact payloads and checksums", () => {
  it("canonicalizes state, action-value, counterexample, failure, and command records", () => {
    const statesLeft = createStrategyStatesArtifact({
      ...RUN,
      records: [state("state/b"), state("state/a")],
    });
    const statesRight = createStrategyStatesArtifact({
      ...RUN,
      records: [state("state/a"), state("state/b")],
    });
    expect(statesLeft).toEqual(statesRight);

    const valuesLeft = createStrategyActionValuesArtifact({
      ...RUN,
      records: [actionValue("value/b"), actionValue("value/a")],
    });
    const valuesRight = createStrategyActionValuesArtifact({
      ...RUN,
      records: [actionValue("value/a"), actionValue("value/b")],
    });
    expect(valuesLeft).toEqual(valuesRight);

    const boundariesLeft = createStrategyCounterexamplesArtifact({
      ...RUN,
      records: [
        {
          boundaryRecordId: "boundary/b",
          motifId: "M01",
          commandId: COMMAND_A.commandId,
          finding: "boundary",
          scope: "finite-search",
          description: "Second boundary.",
          stateIds: [],
          actionValueIds: [],
        },
        {
          boundaryRecordId: "boundary/a",
          motifId: "M01",
          commandId: COMMAND_A.commandId,
          finding: "counterexample",
          scope: "single-state",
          description: "First boundary.",
          stateIds: [],
          actionValueIds: [],
        },
      ],
    });
    const boundariesRight = createStrategyCounterexamplesArtifact({
      ...RUN,
      records: [...boundariesLeft.payload.records].reverse(),
    });
    expect(boundariesLeft).toEqual(boundariesRight);

    const failuresLeft = createStrategyFailuresArtifact({
      ...RUN,
      records: [failure("failure/b"), failure("failure/a")],
    });
    const failuresRight = createStrategyFailuresArtifact({
      ...RUN,
      records: [failure("failure/a"), failure("failure/b")],
    });
    expect(failuresLeft).toEqual(failuresRight);

    const commandsLeft = createStrategyCommandArtifact({
      ...RUN,
      records: [COMMAND_B, COMMAND_A],
    });
    const commandsRight = createStrategyCommandArtifact({
      ...RUN,
      records: [COMMAND_A, COMMAND_B],
    });
    expect(commandsLeft).toEqual(commandsRight);

    for (const artifact of [
      statesLeft,
      valuesLeft,
      boundariesLeft,
      failuresLeft,
      commandsLeft,
    ]) {
      expect(verifyStrategyArtifactChecksum(artifact)).toBe(true);
    }
  });

  it("creates deterministic summary and manifest artifacts that bind all declared payloads", () => {
    const summary = createStrategySummaryArtifact({
      ...RUN,
      evidenceBundleChecksum: "bundle-checksum",
      summary: summaryFixture(),
    });
    const checksums = {
      states: "states-checksum",
      actionValues: "values-checksum",
      counterexamples: "counterexamples-checksum",
      failures: "failures-checksum",
      summary: summary.payloadChecksum,
      command: "command-checksum",
    };
    const left = createStrategyManifestArtifact({
      ...RUN,
      protocolId: "strategy-evidence-v1",
      sourceRevision: "revision",
      registryChecksum: strategyRegistryChecksum(),
      evidenceBundleChecksum: "bundle-checksum",
      declaredMotifIds: [...MOTIF_IDS].reverse(),
      artifactChecksums: checksums,
    });
    const right = createStrategyManifestArtifact({
      ...RUN,
      protocolId: "strategy-evidence-v1",
      sourceRevision: "revision",
      registryChecksum: strategyRegistryChecksum(),
      evidenceBundleChecksum: "bundle-checksum",
      declaredMotifIds: [...MOTIF_IDS],
      artifactChecksums: checksums,
    });
    expect(left).toEqual(right);
    expect(left.payload.declaredMotifIds).toEqual(MOTIF_IDS);
    expect(verifyStrategyArtifactChecksum(summary)).toBe(true);
    expect(verifyStrategyArtifactChecksum(left)).toBe(true);
  });

  it("detects payload tampering and produces stable direct checksums", () => {
    const artifact = createStrategyStatesArtifact({
      ...RUN,
      records: [state("state/a")],
    });
    const tampered = structuredClone(artifact);
    const first = tampered.payload.records[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new Error("No state artifact fixture.");
    }
    first.rulesChecksum = "tampered";
    expect(verifyStrategyArtifactChecksum(tampered)).toBe(false);

    expect(strategyArtifactPayloadChecksum("states", artifact.payload)).toBe(
      artifact.payloadChecksum,
    );
    expect(strategyRegistryChecksum()).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
  });
});
