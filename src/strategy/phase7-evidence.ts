import { stableHash } from "../events/stable-hash";
import {
  parseStrategyEvidenceBundle,
  type CounterexampleBoundaryRecord,
  type ExecutableEvidenceRecord,
  type MotifDisposition,
  type PairedActionValueRecord,
  type StrategyCommandRecord,
  type StrategyEvidenceBundle,
  type StrategyFailureRecord,
  type StrategyStateRecord,
} from "./evidence";
import { MOTIF_REGISTRY, type MotifRegistryEntry } from "./registry";

export const PHASE7_STRATEGY_PROTOCOL_ID =
  "phase7-strategy-correctness-v1" as const;

function evidenceId(motifId: string, pathIndex: number): string {
  return `evidence/${motifId}/${pathIndex.toString().padStart(2, "0")}`;
}

function directEvidenceFor(
  entry: MotifRegistryEntry,
  command: StrategyCommandRecord,
  resultChecksum: string,
): ExecutableEvidenceRecord[] {
  return entry.existingExecutableEvidencePaths.map((testPath, pathIndex) => ({
    evidenceId: evidenceId(entry.id, pathIndex),
    motifId: entry.id,
    kind: "direct-correctness",
    status: command.exitCode === 0 ? "passed" : "failed",
    testPath,
    commandId: command.commandId,
    resultChecksum,
  }));
}

export function phase7RequiredStrategyTestPaths(): readonly string[] {
  return [
    ...new Set(
      MOTIF_REGISTRY.filter(
        (entry) =>
          entry.classification === "required-correctness" &&
          entry.currentCoverage === "direct",
      ).flatMap((entry) => entry.existingExecutableEvidencePaths),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function createPhase7StrategyEvidenceBundle(input: {
  readonly command: StrategyCommandRecord;
  readonly resultChecksum: string;
  readonly states?: readonly StrategyStateRecord[];
  readonly actionValues?: readonly PairedActionValueRecord[];
  readonly boundaries?: readonly CounterexampleBoundaryRecord[];
  readonly failures?: readonly StrategyFailureRecord[];
}): StrategyEvidenceBundle {
  const states = [...(input.states ?? [])];
  const actionValues = [...(input.actionValues ?? [])];
  const boundaries = [...(input.boundaries ?? [])];
  const failures = [...(input.failures ?? [])];
  const evidence: ExecutableEvidenceRecord[] = [];
  const dispositions: MotifDisposition[] = [];

  for (const entry of MOTIF_REGISTRY) {
    const motifActionValueIds = actionValues
      .filter((record) => record.motifId === entry.id)
      .map((record) => record.actionValueId);
    const motifBoundaryIds = boundaries
      .filter((record) => record.motifId === entry.id)
      .map((record) => record.boundaryRecordId);
    const motifFailureIds = failures
      .filter((record) => record.motifId === entry.id)
      .map((record) => record.failureId);

    if (entry.classification === "required-correctness") {
      if (entry.currentCoverage !== "direct") {
        throw new Error(
          `${entry.id} is required correctness without direct Phase 7 coverage.`,
        );
      }
      const motifEvidence = directEvidenceFor(
        entry,
        input.command,
        input.resultChecksum,
      );
      evidence.push(...motifEvidence);
      dispositions.push({
        motifId: entry.id,
        disposition: "retained-required",
        rationale:
          "Required rule, inference, search, exact-endgame, or sensitivity behavior has focused passing executable evidence.",
        evidenceIds: motifEvidence.map((record) => record.evidenceId),
        actionValueIds: motifActionValueIds,
        boundaryRecordIds: motifBoundaryIds,
        failureIds: motifFailureIds,
      });
      continue;
    }

    dispositions.push({
      motifId: entry.id,
      disposition: "deferred-phase7",
      phase7Dependency: `Phase 7 deliberately leaves ${entry.proposedExperimentId} unretained; a future preregistered experiment must provide replayable paired terminal outcomes and the documented boundary before retention.`,
      rationale:
        "This nonrequired reported or hypothesis motif has no retained experiment claim and remains production-off.",
      evidenceIds: [],
      actionValueIds: motifActionValueIds,
      boundaryRecordIds: motifBoundaryIds,
      failureIds: motifFailureIds,
    });
  }

  return parseStrategyEvidenceBundle({
    schemaVersion: 1,
    commands: [input.command],
    states,
    actionValues,
    boundaries,
    failures,
    evidence,
    dispositions,
    eligibility: [],
    productionDecisions: [],
  });
}

export function phase7StrategyEvidenceBundleChecksum(
  bundle: StrategyEvidenceBundle,
): string {
  return stableHash({
    schemaVersion: 1,
    bundle,
  });
}
