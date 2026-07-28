import { createHash } from "node:crypto";

import { z } from "zod";

import { stableStringify } from "../events/stable-hash";
import { EVALUATION_PROTOCOL_ID } from "./protocol";
import {
  PHASE8_SELECTION_ATTESTATION_VERSION,
  createPhase8SelectionAttestation,
  freezePhase8FinalManifestFromSelection,
  phase8SelectionAttestationSchema,
  verifyPhase8SelectionArtifact,
  verifyPhase8FinalManifestAuthority,
  type FrozenPhase8FinalManifestAuthority,
  type Phase8SelectionAttestation,
  type Phase8WriteOnceArtifact,
} from "./phase8-final-manifest";
import { phase8Sha256 } from "./phase8-manifest";

export {
  PHASE8_SELECTION_ATTESTATION_VERSION,
  createPhase8SelectionAttestation,
  freezePhase8FinalManifestFromSelection,
  phase8SelectionAttestationSchema,
  verifyPhase8SelectionArtifact,
};
export type { Phase8SelectionAttestation, Phase8WriteOnceArtifact };

export const PHASE8_FINAL_ATTESTATION_VERSION =
  "phase8-final-attestation-v1" as const;

const identifierSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const finalModeSchema = z.enum([
  "one-arm-reference-confirmation",
  "paired-selected-vs-reference",
]);

const finalAttestationBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal(EVALUATION_PROTOCOL_ID),
    attestationVersion: z.literal(PHASE8_FINAL_ATTESTATION_VERSION),
    attestationId: identifierSchema,
    writeMode: z.literal("create-exclusive"),
    createdAt: z.iso.datetime(),
    manifestId: identifierSchema,
    manifestSha256: sha256Schema,
    qualificationManifestId: identifierSchema,
    qualificationManifestSha256: sha256Schema,
    selectionAttestationId: identifierSchema,
    selectionAttestationSha256: sha256Schema,
    finalArtifactSha256: sha256Schema,
    finalSummarySha256: sha256Schema,
    referenceConfigId: identifierSchema,
    selectedConfigId: identifierSchema,
    selectionIsReference: z.boolean(),
    finalMode: finalModeSchema,
    finalConfigIds: z.array(identifierSchema).min(1).max(2),
    finalIntegrityGate: z.literal(true),
    completeMatrixGate: z.literal(true),
    zeroFailureGate: z.literal(true),
    zeroCapGate: z.literal(true),
    zeroCancellationGate: z.literal(true),
    seedReplayGate: z.literal(true),
    selectedConfirmationGate: z.literal(true),
  })
  .strict();

export type Phase8FinalAttestation = z.infer<typeof finalAttestationBaseSchema>;

function expectedFinalAttestationId(
  value: Omit<Phase8FinalAttestation, "attestationId">,
): string {
  return `phase8-final-${phase8Sha256({
    ...value,
    attestationId: undefined,
  }).slice(0, 24)}`;
}

function addFinalSemanticIssues(
  value: Phase8FinalAttestation,
  context: z.RefinementCtx,
): void {
  if (value.attestationId !== expectedFinalAttestationId(value)) {
    context.addIssue({
      code: "custom",
      path: ["attestationId"],
      message: "Final attestation ID does not match its payload.",
    });
  }
  if (new Set(value.finalConfigIds).size !== value.finalConfigIds.length) {
    context.addIssue({
      code: "custom",
      path: ["finalConfigIds"],
      message: "Final configuration IDs must be unique.",
    });
  }
  if (value.selectionIsReference) {
    if (
      value.selectedConfigId !== value.referenceConfigId ||
      value.finalMode !== "one-arm-reference-confirmation" ||
      stableStringify(value.finalConfigIds) !==
        stableStringify([value.referenceConfigId])
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectionIsReference"],
        message:
          "Reference-selected final attestation must contain one reference arm.",
      });
    }
  } else {
    const expected = [value.referenceConfigId, value.selectedConfigId].sort();
    if (
      value.selectedConfigId === value.referenceConfigId ||
      value.finalMode !== "paired-selected-vs-reference" ||
      stableStringify([...value.finalConfigIds].sort()) !==
        stableStringify(expected)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectionIsReference"],
        message:
          "Candidate-selected final attestation must contain the paired final arms.",
      });
    }
  }
}

export const phase8FinalAttestationSchema =
  finalAttestationBaseSchema.superRefine(addFinalSemanticIssues);

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function assertExclusiveTarget(existingTarget: unknown): void {
  if (existingTarget !== null) {
    throw new Error(
      "Refusing to overwrite an existing Phase 8 attestation target.",
    );
  }
}

function checksummedArtifact<T>(
  fileName: string,
  record: T,
): Phase8WriteOnceArtifact<T> {
  const payload = `${stableStringify(record)}\n`;
  const payloadSha256 = createHash("sha256")
    .update(payload, "utf8")
    .digest("hex");
  return deepFreeze({
    fileName,
    record,
    payload,
    payloadSha256,
    checksumLine: `${payloadSha256}  ${fileName}\n`,
  });
}

export type Phase8FinalEvidenceGates = {
  readonly finalIntegrityGate: boolean;
  readonly completeMatrixGate: boolean;
  readonly zeroFailureGate: boolean;
  readonly zeroCapGate: boolean;
  readonly zeroCancellationGate: boolean;
  readonly seedReplayGate: boolean;
  readonly selectedConfirmationGate: boolean;
};

export function createPhase8FinalAttestation(input: {
  readonly existingTarget: unknown;
  readonly authority: FrozenPhase8FinalManifestAuthority;
  readonly selectionArtifact: Phase8WriteOnceArtifact<Phase8SelectionAttestation>;
  readonly createdAt: string;
  readonly finalArtifactSha256: string;
  readonly finalSummarySha256: string;
  readonly gates: Phase8FinalEvidenceGates;
}): Phase8WriteOnceArtifact<Phase8FinalAttestation> {
  assertExclusiveTarget(input.existingTarget);
  verifyPhase8FinalManifestAuthority(input.authority);
  const selection = verifyPhase8SelectionArtifact(input.selectionArtifact);
  if (
    selection.attestationId !==
      input.authority.manifest.selection.selectionAttestationId ||
    input.selectionArtifact.payloadSha256 !==
      input.authority.manifest.selection.selectionAttestationSha256 ||
    selection.manifestSha256 !==
      input.authority.manifest.qualificationManifestSha256
  ) {
    throw new Error(
      "Selection attestation is not the one bound by the final authority.",
    );
  }
  if (Object.values(input.gates).some((gate) => !gate)) {
    throw new Error("Final attestation requires every final gate to pass.");
  }
  const projection: Omit<Phase8FinalAttestation, "attestationId"> = {
    schemaVersion: 1,
    protocolId: EVALUATION_PROTOCOL_ID,
    attestationVersion: PHASE8_FINAL_ATTESTATION_VERSION,
    writeMode: "create-exclusive",
    createdAt: input.createdAt,
    manifestId: input.authority.manifest.manifestId,
    manifestSha256: input.authority.manifestSha256,
    qualificationManifestId: input.authority.manifest.qualificationManifestId,
    qualificationManifestSha256:
      input.authority.manifest.qualificationManifestSha256,
    selectionAttestationId: selection.attestationId,
    selectionAttestationSha256: input.selectionArtifact.payloadSha256,
    finalArtifactSha256: input.finalArtifactSha256,
    finalSummarySha256: input.finalSummarySha256,
    referenceConfigId: selection.referenceConfigId,
    selectedConfigId: selection.selectedConfigId,
    selectionIsReference: selection.selectionIsReference,
    finalMode: selection.finalMode,
    finalConfigIds: selection.finalConfigIds,
    finalIntegrityGate: true,
    completeMatrixGate: true,
    zeroFailureGate: true,
    zeroCapGate: true,
    zeroCancellationGate: true,
    seedReplayGate: true,
    selectedConfirmationGate: true,
  };
  const record = phase8FinalAttestationSchema.parse({
    ...projection,
    attestationId: expectedFinalAttestationId(projection),
  });
  return checksummedArtifact("final-attestation.json", record);
}

export function verifyPhase8FinalArtifact(
  artifact: Phase8WriteOnceArtifact<Phase8FinalAttestation>,
): Phase8FinalAttestation {
  const record = phase8FinalAttestationSchema.parse(artifact.record);
  const payload = `${stableStringify(record)}\n`;
  const payloadSha256 = createHash("sha256")
    .update(payload, "utf8")
    .digest("hex");
  if (
    artifact.fileName !== "final-attestation.json" ||
    artifact.payload !== payload ||
    artifact.payloadSha256 !== payloadSha256 ||
    artifact.checksumLine !== `${payloadSha256}  final-attestation.json\n`
  ) {
    throw new Error("Final attestation checksum envelope is invalid.");
  }
  return record;
}

export function rehydratePhase8FinalArtifact(input: {
  readonly payload: string;
  readonly checksumLine: string;
}): Phase8WriteOnceArtifact<Phase8FinalAttestation> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.payload) as unknown;
  } catch (error) {
    throw new Error("Phase 8 final attestation is not valid JSON.", {
      cause: error,
    });
  }
  const record = phase8FinalAttestationSchema.parse(parsed);
  if (input.payload !== `${stableStringify(record)}\n`) {
    throw new Error(
      "Phase 8 final attestation is not byte-identical canonical JSON.",
    );
  }
  const payloadSha256 = createHash("sha256")
    .update(input.payload, "utf8")
    .digest("hex");
  const artifact = deepFreeze({
    fileName: "final-attestation.json" as const,
    record,
    payload: input.payload,
    payloadSha256,
    checksumLine: input.checksumLine,
  });
  verifyPhase8FinalArtifact(artifact);
  return artifact;
}
