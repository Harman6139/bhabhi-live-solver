import { stableHash } from "../events/stable-hash";
import {
  PHASE6_REQUIRED_STRATEGY_DEFERRALS,
  parseStrategyEvidenceBundle,
  type ExecutableEvidenceRecord,
  type MotifDisposition,
  type StrategyCommandRecord,
  type StrategyEvidenceBundle,
} from "./evidence";
import {
  MOTIF_REGISTRY,
  type MotifId,
  type MotifRegistryEntry,
} from "./registry";

export const PHASE6_STRATEGY_PROTOCOL_ID =
  "phase6-strategy-correctness-v1" as const;
export const PHASE6_STRATEGY_REGISTRY_CHECKSUM =
  "fnv1a64:768f5100e4e4f209" as const;

export const PHASE6_REQUIRED_DEFERRED_MOTIF_IDS =
  PHASE6_REQUIRED_STRATEGY_DEFERRALS;

const REQUIRED_PHASE7_DEPENDENCIES: Readonly<
  Record<(typeof PHASE6_REQUIRED_DEFERRED_MOTIF_IDS)[number], string>
> = {
  M39: "Phase 7 must implement memoized exact endgame solving and pass exact-enumeration threshold agreement against the sampled path.",
  M40: "Phase 7 must implement opponent-model action sensitivity analysis and pass stable-versus-fragile recommendation label tests.",
};

function isApprovedRequiredDeferral(
  motifId: MotifId,
): motifId is (typeof PHASE6_REQUIRED_DEFERRED_MOTIF_IDS)[number] {
  return PHASE6_REQUIRED_DEFERRED_MOTIF_IDS.some(
    (candidate) => candidate === motifId,
  );
}

function evidenceId(motifId: MotifId, pathIndex: number): string {
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

function deferredDisposition(entry: MotifRegistryEntry): MotifDisposition {
  if (entry.classification === "required-correctness") {
    if (!isApprovedRequiredDeferral(entry.id)) {
      throw new Error(
        `${entry.id} is required correctness without direct coverage and is not an approved Phase 6 deferral.`,
      );
    }
    return {
      motifId: entry.id,
      disposition: "deferred-phase7",
      phase7Dependency: REQUIRED_PHASE7_DEPENDENCIES[entry.id],
      rationale:
        "The Phase 6 gate records the implemented prerequisite without claiming the Phase 7 capability.",
      evidenceIds: [],
      actionValueIds: [],
      boundaryRecordIds: [],
      failureIds: [],
    };
  }

  return {
    motifId: entry.id,
    disposition: "deferred-phase7",
    phase7Dependency: `Phase 7 must execute the preregistered ${entry.proposedExperimentId} experiment with replayable fixtures, raw paired terminal outcomes, and the documented boundary before retention is considered.`,
    rationale:
      "No strategy experiment run is present, so implementation or prerequisite coverage is not an outcome claim.",
    evidenceIds: [],
    actionValueIds: [],
    boundaryRecordIds: [],
    failureIds: [],
  };
}

export function phase6RequiredStrategyTestPaths(): readonly string[] {
  return [
    ...new Set(
      MOTIF_REGISTRY.filter(
        (entry) =>
          entry.classification === "required-correctness" &&
          entry.currentCoverage === "direct" &&
          !isApprovedRequiredDeferral(entry.id),
      ).flatMap((entry) => entry.existingExecutableEvidencePaths),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function createPhase6StrategyEvidenceBundle(input: {
  readonly command: StrategyCommandRecord;
  readonly resultChecksum: string;
}): StrategyEvidenceBundle {
  const evidence: ExecutableEvidenceRecord[] = [];
  const dispositions: MotifDisposition[] = [];

  for (const entry of MOTIF_REGISTRY) {
    if (
      entry.classification === "required-correctness" &&
      isApprovedRequiredDeferral(entry.id)
    ) {
      dispositions.push(deferredDisposition(entry));
    } else if (
      entry.classification === "required-correctness" &&
      entry.currentCoverage === "direct"
    ) {
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
          "Required rule, inference, or search behavior has focused passing executable evidence.",
        evidenceIds: motifEvidence.map((record) => record.evidenceId),
        actionValueIds: [],
        boundaryRecordIds: [],
        failureIds: [],
      });
    } else {
      dispositions.push(deferredDisposition(entry));
    }
  }

  return parseStrategyEvidenceBundle({
    schemaVersion: 1,
    commands: [input.command],
    states: [],
    actionValues: [],
    boundaries: [],
    failures: [],
    evidence,
    dispositions,
    eligibility: [],
    productionDecisions: [],
  });
}

export function strategyEvidenceBundleChecksum(
  bundle: StrategyEvidenceBundle,
): string {
  return stableHash({
    schemaVersion: 1,
    bundle,
  });
}
