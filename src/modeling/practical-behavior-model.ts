import { z } from "zod";

import { FEASIBLE_SUPPORT_REGULARIZER_VERSION } from "../calibration/support-regularization";
import { stableHash, stableStringify } from "../events/stable-hash";
import type { Phase8ProductionModelConfig } from "./production-model";
import {
  behaviorBeliefConfigFromSelectedArtifact,
  selectedBehaviorModelArtifactSchema,
  verifySelectedBehaviorModelArtifact,
  type SelectedBehaviorModelArtifact,
} from "./behavior-fit";
import { PHASE8_MODEL_SELECTION_CONTRACT_HASH } from "./selection-contract";

export const PHASE8_PRACTICAL_BEHAVIOR_MODEL_VERSION =
  "phase8-practical-unsealed-behavior-model-v1" as const;
export const PHASE8_PRACTICAL_SUPPORT_PSEUDOCOUNT = 1 as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const stableHashSchema = z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u);

const practicalBehaviorModelPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    modelVersion: z.literal(PHASE8_PRACTICAL_BEHAVIOR_MODEL_VERSION),
    sourceSha256: sha256Schema,
    modelSelectionContractHash: stableHashSchema,
    behavior: selectedBehaviorModelArtifactSchema,
    supportRegularizerVersion: z.literal(FEASIBLE_SUPPORT_REGULARIZER_VERSION),
    supportRegularizer: z
      .object({
        pseudocountPerFeasibleLabel: z.literal(
          PHASE8_PRACTICAL_SUPPORT_PSEUDOCOUNT,
        ),
        basis: z.literal("conservative-fixed-not-empirically-tuned"),
      })
      .strict(),
    caveats: z
      .object({
        status: z.literal("unsealed-practical"),
        purpose: z.literal("local-play-only"),
        qualificationStatus: z.literal("not-qualified"),
        releaseSelectedEligible: z.literal(false),
        claim: z.literal("no-support-tune-or-performance-claim"),
      })
      .strict(),
  })
  .strict();

export type Phase8PracticalBehaviorModelPayload = z.infer<
  typeof practicalBehaviorModelPayloadSchema
>;

export const phase8PracticalBehaviorModelArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("phase8-practical-unsealed-behavior-model"),
    payload: practicalBehaviorModelPayloadSchema,
    payloadChecksum: stableHashSchema,
  })
  .strict();

export type Phase8PracticalBehaviorModelArtifact = z.infer<
  typeof phase8PracticalBehaviorModelArtifactSchema
>;

function payloadChecksum(payload: Phase8PracticalBehaviorModelPayload): string {
  return stableHash({
    schemaVersion: 1,
    artifactKind: "phase8-practical-unsealed-behavior-model",
    payload,
  });
}

export function createPhase8PracticalBehaviorModelArtifact(
  behaviorValue: SelectedBehaviorModelArtifact,
): Phase8PracticalBehaviorModelArtifact {
  const verification = verifySelectedBehaviorModelArtifact(behaviorValue);
  if (!verification.ok || verification.artifact === null) {
    throw new Error(
      `Practical behavior model received an invalid selected behavior artifact: ${verification.issues.join("; ")}`,
    );
  }
  const behavior = verification.artifact;
  const payload = practicalBehaviorModelPayloadSchema.parse({
    schemaVersion: 1,
    modelVersion: PHASE8_PRACTICAL_BEHAVIOR_MODEL_VERSION,
    sourceSha256: behavior.payload.sourceHash,
    modelSelectionContractHash: PHASE8_MODEL_SELECTION_CONTRACT_HASH,
    behavior,
    supportRegularizerVersion: FEASIBLE_SUPPORT_REGULARIZER_VERSION,
    supportRegularizer: {
      pseudocountPerFeasibleLabel: PHASE8_PRACTICAL_SUPPORT_PSEUDOCOUNT,
      basis: "conservative-fixed-not-empirically-tuned",
    },
    caveats: {
      status: "unsealed-practical",
      purpose: "local-play-only",
      qualificationStatus: "not-qualified",
      releaseSelectedEligible: false,
      claim: "no-support-tune-or-performance-claim",
    },
  });
  return Object.freeze({
    schemaVersion: 1,
    artifactKind: "phase8-practical-unsealed-behavior-model" as const,
    payload,
    payloadChecksum: payloadChecksum(payload),
  });
}

export function verifyPhase8PracticalBehaviorModelArtifact(
  value: unknown,
): Phase8PracticalBehaviorModelArtifact {
  const artifact = phase8PracticalBehaviorModelArtifactSchema.parse(value);
  const behavior = verifySelectedBehaviorModelArtifact(
    artifact.payload.behavior,
  );
  if (!behavior.ok || behavior.artifact === null) {
    throw new Error(
      `Practical behavior model embeds an invalid selected behavior artifact: ${behavior.issues.join("; ")}`,
    );
  }
  if (
    artifact.payloadChecksum !== payloadChecksum(artifact.payload) ||
    artifact.payload.sourceSha256 !== behavior.artifact.payload.sourceHash ||
    artifact.payload.modelSelectionContractHash !==
      PHASE8_MODEL_SELECTION_CONTRACT_HASH
  ) {
    throw new Error(
      "Practical behavior model source, contract, or payload checksum is invalid.",
    );
  }
  return Object.freeze(artifact);
}

export function serializePhase8PracticalBehaviorModelArtifact(
  value: Phase8PracticalBehaviorModelArtifact,
): string {
  return `${stableStringify(
    verifyPhase8PracticalBehaviorModelArtifact(value),
  )}\n`;
}

export function parsePhase8PracticalBehaviorModelArtifact(
  serialized: string,
): Phase8PracticalBehaviorModelArtifact {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (cause) {
    throw new Error("Practical behavior model artifact is not valid JSON.", {
      cause,
    });
  }
  const artifact = verifyPhase8PracticalBehaviorModelArtifact(value);
  if (serializePhase8PracticalBehaviorModelArtifact(artifact) !== serialized) {
    throw new Error(
      "Practical behavior model bytes are not the canonical serialization.",
    );
  }
  return artifact;
}

export function phase8PracticalBehaviorModelConfig(
  value: unknown,
): Phase8ProductionModelConfig {
  const artifact = verifyPhase8PracticalBehaviorModelArtifact(value);
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
