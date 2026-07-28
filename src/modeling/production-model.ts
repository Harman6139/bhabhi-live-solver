import { z } from "zod";

import { stableHash, stableStringify } from "../events/stable-hash";
import {
  FEASIBLE_SUPPORT_REGULARIZER_VERSION,
  type FeasibleSupportRegularizerConfig,
} from "../calibration/support-regularization";
import type { BehaviorBeliefConfigInput } from "../inference/behavior-belief";
import {
  behaviorBeliefConfigFromSelectedArtifact,
  selectedBehaviorModelArtifactSchema,
  verifySelectedBehaviorModelArtifact,
  type SelectedBehaviorModelArtifact,
} from "./behavior-fit";
import {
  PHASE8_MODEL_SELECTION_CONTRACT_HASH,
  PHASE8_SUPPORT_REGULARIZER_GRID,
} from "./selection-contract";

export const PHASE8_PRODUCTION_MODEL_VERSION =
  "phase8-production-model-v1" as const;
export const PHASE8_PRODUCTION_MODEL_ARTIFACT_KIND =
  "phase8-production-model" as const;
export const PHASE8_SUPPORT_SELECTION_VERSION =
  "phase8-support-regularizer-tune-selection-v1" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const stableHashSchema = z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u);

const supportCandidateSchema = z
  .object({
    pseudocountPerFeasibleLabel: z.number().positive(),
    configHash: stableHashSchema,
    completeClusters: z.number().int().positive(),
    unresolvedSoftObservations: z.number().int().positive(),
    equalFamilyUnresolvedSoftBrier: z.number().nonnegative(),
    rawZeroFeasibleTruthCount: z.number().int().nonnegative(),
    hardKnownViolationCount: z.number().int().nonnegative(),
    failureCount: z.number().int().nonnegative(),
  })
  .strict();

export type Phase8SupportRegularizerCandidateScore = z.infer<
  typeof supportCandidateSchema
>;

const supportSelectionPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    selectionVersion: z.literal(PHASE8_SUPPORT_SELECTION_VERSION),
    split: z.literal("tune"),
    selectionMetric: z.literal(
      "equal-family-unresolved-soft-hidden-state-brier",
    ),
    tieBreak: z.literal("smallest-pseudocount-within-1e-12"),
    sourceSha256: sha256Schema,
    tuneArtifactSha256: sha256Schema,
    tuneDatasetHash: stableHashSchema,
    scorerSha256: sha256Schema,
    queryPlanSha256: sha256Schema,
    modelSelectionContractHash: stableHashSchema,
    candidates: z
      .array(supportCandidateSchema)
      .length(PHASE8_SUPPORT_REGULARIZER_GRID.length),
    selectedPseudocountPerFeasibleLabel: z.number().positive(),
    selectedConfigHash: stableHashSchema,
    selectedScore: z.number().nonnegative(),
    selectionSha256: stableHashSchema,
  })
  .strict();

export type Phase8SupportRegularizerTuneSelection = z.infer<
  typeof supportSelectionPayloadSchema
>;

const productionModelPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    modelVersion: z.literal(PHASE8_PRODUCTION_MODEL_VERSION),
    modelSelectionContractHash: stableHashSchema,
    behavior: selectedBehaviorModelArtifactSchema,
    supportRegularizerSelection: supportSelectionPayloadSchema,
    supportRegularizerVersion: z.literal(FEASIBLE_SUPPORT_REGULARIZER_VERSION),
    supportRegularizer: z
      .object({
        pseudocountPerFeasibleLabel: z.number().positive(),
      })
      .strict(),
  })
  .strict();

export type Phase8ProductionModelPayload = z.infer<
  typeof productionModelPayloadSchema
>;

export const phase8ProductionModelArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal(PHASE8_PRODUCTION_MODEL_ARTIFACT_KIND),
    payload: productionModelPayloadSchema,
    payloadChecksum: stableHashSchema,
  })
  .strict();

export type Phase8ProductionModelArtifact = z.infer<
  typeof phase8ProductionModelArtifactSchema
>;

function regularizerConfigHash(
  config: FeasibleSupportRegularizerConfig,
): string {
  return stableHash({
    schemaVersion: 1,
    algorithmVersion: FEASIBLE_SUPPORT_REGULARIZER_VERSION,
    config,
  });
}

function canonicalCandidateOrder(
  candidates: readonly Phase8SupportRegularizerCandidateScore[],
): Phase8SupportRegularizerCandidateScore[] {
  return [...candidates].sort(
    (left, right) =>
      left.pseudocountPerFeasibleLabel - right.pseudocountPerFeasibleLabel,
  );
}

function compareCandidateScores(
  left: Phase8SupportRegularizerCandidateScore,
  right: Phase8SupportRegularizerCandidateScore,
): number {
  const scoreDifference =
    left.equalFamilyUnresolvedSoftBrier - right.equalFamilyUnresolvedSoftBrier;
  return Math.abs(scoreDifference) <= 1e-12
    ? left.pseudocountPerFeasibleLabel - right.pseudocountPerFeasibleLabel
    : scoreDifference;
}

function validateSupportCandidates(
  values: readonly unknown[],
): readonly Phase8SupportRegularizerCandidateScore[] {
  const candidates = canonicalCandidateOrder(
    values.map((value) => supportCandidateSchema.parse(value)),
  );
  const expected = [...PHASE8_SUPPORT_REGULARIZER_GRID].sort(
    (left, right) =>
      left.pseudocountPerFeasibleLabel - right.pseudocountPerFeasibleLabel,
  );
  if (
    candidates.length !== expected.length ||
    candidates.some((candidate, index) => {
      const config = expected[index];
      return (
        config === undefined ||
        candidate.pseudocountPerFeasibleLabel !==
          config.pseudocountPerFeasibleLabel ||
        candidate.configHash !== regularizerConfigHash(config)
      );
    })
  ) {
    throw new Error(
      "Support tune selection must score the complete frozen regularizer grid.",
    );
  }
  for (const candidate of candidates) {
    if (
      candidate.rawZeroFeasibleTruthCount !== 0 ||
      candidate.hardKnownViolationCount !== 0 ||
      candidate.failureCount !== 0
    ) {
      throw new Error(
        "A selected support-regularizer grid must have zero support, hard-known, and execution failures.",
      );
    }
  }
  const clusterCounts = new Set(
    candidates.map((candidate) => candidate.completeClusters),
  );
  const observationCounts = new Set(
    candidates.map((candidate) => candidate.unresolvedSoftObservations),
  );
  if (clusterCounts.size !== 1 || observationCounts.size !== 1) {
    throw new Error(
      "Every regularizer candidate must score the identical paired tune corpus.",
    );
  }
  return Object.freeze(candidates);
}

function supportSelectionProjection(
  value: Omit<Phase8SupportRegularizerTuneSelection, "selectionSha256">,
): Omit<Phase8SupportRegularizerTuneSelection, "selectionSha256"> {
  return value;
}

export function createPhase8SupportRegularizerTuneSelection(input: {
  readonly sourceSha256: string;
  readonly tuneArtifactSha256: string;
  readonly tuneDatasetHash: string;
  readonly scorerSha256: string;
  readonly queryPlanSha256: string;
  readonly candidates: readonly Phase8SupportRegularizerCandidateScore[];
}): Phase8SupportRegularizerTuneSelection {
  const candidates = [...validateSupportCandidates(input.candidates)];
  const selected = [...candidates].sort(compareCandidateScores)[0];
  if (selected === undefined) {
    throw new Error("Support tune selection produced no candidate.");
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    selectionVersion: PHASE8_SUPPORT_SELECTION_VERSION,
    split: "tune" as const,
    selectionMetric: "equal-family-unresolved-soft-hidden-state-brier" as const,
    tieBreak: "smallest-pseudocount-within-1e-12" as const,
    sourceSha256: input.sourceSha256,
    tuneArtifactSha256: input.tuneArtifactSha256,
    tuneDatasetHash: input.tuneDatasetHash,
    scorerSha256: input.scorerSha256,
    queryPlanSha256: input.queryPlanSha256,
    modelSelectionContractHash: PHASE8_MODEL_SELECTION_CONTRACT_HASH,
    candidates,
    selectedPseudocountPerFeasibleLabel: selected.pseudocountPerFeasibleLabel,
    selectedConfigHash: selected.configHash,
    selectedScore: selected.equalFamilyUnresolvedSoftBrier,
  };
  const parsed = supportSelectionPayloadSchema.parse({
    ...withoutHash,
    selectionSha256: stableHash(supportSelectionProjection(withoutHash)),
  });
  return Object.freeze(parsed);
}

export function verifyPhase8SupportRegularizerTuneSelection(
  value: unknown,
): Phase8SupportRegularizerTuneSelection {
  const selection = supportSelectionPayloadSchema.parse(value);
  const { selectionSha256, ...projection } = selection;
  if (
    selectionSha256 !== stableHash(supportSelectionProjection(projection)) ||
    selection.modelSelectionContractHash !==
      PHASE8_MODEL_SELECTION_CONTRACT_HASH
  ) {
    throw new Error("Support regularizer tune selection checksum is invalid.");
  }
  const candidates = validateSupportCandidates(selection.candidates);
  const selected = [...candidates].sort(compareCandidateScores)[0];
  if (
    selected === undefined ||
    selection.selectedPseudocountPerFeasibleLabel !==
      selected.pseudocountPerFeasibleLabel ||
    selection.selectedConfigHash !== selected.configHash ||
    selection.selectedScore !== selected.equalFamilyUnresolvedSoftBrier
  ) {
    throw new Error(
      "Support regularizer tune selection is not the deterministic winner.",
    );
  }
  return Object.freeze(selection);
}

function productionPayloadChecksum(
  payload: Phase8ProductionModelPayload,
): string {
  return stableHash({
    schemaVersion: 1,
    artifactKind: PHASE8_PRODUCTION_MODEL_ARTIFACT_KIND,
    payload,
  });
}

export function createPhase8ProductionModelArtifact(input: {
  readonly behavior: SelectedBehaviorModelArtifact;
  readonly supportRegularizerSelection: Phase8SupportRegularizerTuneSelection;
}): Phase8ProductionModelArtifact {
  const behaviorVerification = verifySelectedBehaviorModelArtifact(
    input.behavior,
  );
  if (!behaviorVerification.ok || behaviorVerification.artifact === null) {
    throw new Error(
      `Production model received invalid behavior selection: ${behaviorVerification.issues.join("; ")}`,
    );
  }
  const behavior = behaviorVerification.artifact;
  const supportRegularizerSelection =
    verifyPhase8SupportRegularizerTuneSelection(
      input.supportRegularizerSelection,
    );
  if (
    behavior.payload.sourceHash !== supportRegularizerSelection.sourceSha256
  ) {
    throw new Error(
      "Behavior and support selections must bind the same source snapshot.",
    );
  }
  const supportRegularizer = {
    pseudocountPerFeasibleLabel:
      supportRegularizerSelection.selectedPseudocountPerFeasibleLabel,
  };
  if (
    regularizerConfigHash(supportRegularizer) !==
    supportRegularizerSelection.selectedConfigHash
  ) {
    throw new Error("Selected support regularizer hash is inconsistent.");
  }
  const payload = productionModelPayloadSchema.parse({
    schemaVersion: 1,
    modelVersion: PHASE8_PRODUCTION_MODEL_VERSION,
    modelSelectionContractHash: PHASE8_MODEL_SELECTION_CONTRACT_HASH,
    behavior,
    supportRegularizerSelection,
    supportRegularizerVersion: FEASIBLE_SUPPORT_REGULARIZER_VERSION,
    supportRegularizer,
  });
  return Object.freeze({
    schemaVersion: 1,
    artifactKind: PHASE8_PRODUCTION_MODEL_ARTIFACT_KIND,
    payload,
    payloadChecksum: productionPayloadChecksum(payload),
  });
}

export function verifyPhase8ProductionModelArtifact(
  value: unknown,
): Phase8ProductionModelArtifact {
  const artifact = phase8ProductionModelArtifactSchema.parse(value);
  if (
    artifact.payload.modelSelectionContractHash !==
      PHASE8_MODEL_SELECTION_CONTRACT_HASH ||
    artifact.payloadChecksum !== productionPayloadChecksum(artifact.payload)
  ) {
    throw new Error("Phase 8 production-model checksum is invalid.");
  }
  const behavior = verifySelectedBehaviorModelArtifact(
    artifact.payload.behavior,
  );
  if (!behavior.ok || behavior.artifact === null) {
    throw new Error(
      `Phase 8 production model embeds invalid behavior selection: ${behavior.issues.join("; ")}`,
    );
  }
  const support = verifyPhase8SupportRegularizerTuneSelection(
    artifact.payload.supportRegularizerSelection,
  );
  if (
    support.sourceSha256 !== behavior.artifact.payload.sourceHash ||
    artifact.payload.supportRegularizer.pseudocountPerFeasibleLabel !==
      support.selectedPseudocountPerFeasibleLabel ||
    regularizerConfigHash(artifact.payload.supportRegularizer) !==
      support.selectedConfigHash
  ) {
    throw new Error("Phase 8 production-model selections are inconsistent.");
  }
  return Object.freeze(artifact);
}

export function serializePhase8ProductionModelArtifact(
  artifact: Phase8ProductionModelArtifact,
): string {
  return `${stableStringify(verifyPhase8ProductionModelArtifact(artifact))}\n`;
}

export function parsePhase8ProductionModelArtifact(
  serialized: string,
): Phase8ProductionModelArtifact {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (cause) {
    throw new Error("Phase 8 production-model artifact is not valid JSON.", {
      cause,
    });
  }
  return verifyPhase8ProductionModelArtifact(value);
}

export type Phase8ProductionModelConfig = Readonly<{
  behavior: BehaviorBeliefConfigInput;
  supportRegularizer: FeasibleSupportRegularizerConfig;
  worldCount: number;
  robustChoice: boolean;
}>;

export function phase8ProductionModelConfig(
  artifactValue: unknown,
): Phase8ProductionModelConfig {
  const artifact = verifyPhase8ProductionModelArtifact(artifactValue);
  return Object.freeze({
    behavior: behaviorBeliefConfigFromSelectedArtifact(
      artifact.payload.behavior,
    ),
    supportRegularizer: Object.freeze({
      pseudocountPerFeasibleLabel:
        artifact.payload.supportRegularizer.pseudocountPerFeasibleLabel,
    }),
    worldCount: artifact.payload.behavior.payload.parameters.worldCount,
    robustChoice: artifact.payload.behavior.payload.parameters.robustChoice,
  });
}
