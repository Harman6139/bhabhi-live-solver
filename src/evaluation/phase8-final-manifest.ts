import { createHash } from "node:crypto";

import { z } from "zod";

import {
  CANONICAL_RULES,
  ruleConfigSchema,
  type RuleConfig,
} from "../domain/rule-config";
import { stableStringify } from "../events/stable-hash";
import { RNG_ALGORITHM } from "../random/keyed-rng";
import { EVALUATION_PROTOCOL_ID, STYLE_CELLS } from "./protocol";
import {
  PHASE8_MANIFEST_SCHEMA_VERSION,
  PHASE8_MAX_CONFIGURATIONS,
  PHASE8_ROTATIONS,
  PHASE8_SEED_STREAMS,
  PHASE8_STYLE_CELL_COUNT,
  phase8ConfigurationDescriptorSchema,
  phase8HashBundleSchema,
  phase8Sha256,
  phase8SplitPlanSchema,
  verifyPhase8ManifestAuthority,
  type FrozenPhase8ManifestAuthority,
  type Phase8ConfigurationDescriptor,
  type Phase8HashBundle,
  type Phase8SeedCoordinate,
  type Phase8SplitPlan,
} from "./phase8-manifest";
import {
  verifyPhase8SelectionDecisionAuthority,
  type Phase8SelectionDecision,
} from "./phase8-selection";
import {
  PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA,
  PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_CONTRACT,
  PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_VERSION,
  computePhase8TerminalSampleSize,
  type Phase8TerminalSampleSize,
} from "./phase8-sample-size";

export const PHASE8_FINAL_MANIFEST_VERSION =
  "phase8-final-evaluation-manifest-v1" as const;
export const PHASE8_FINAL_MANIFEST_AUTHORITY_ARTIFACT_VERSION =
  "phase8-final-manifest-authority-artifact-v1" as const;
export const PHASE8_FINAL_SPLIT_OPENING_ARTIFACT_VERSION =
  "phase8-final-split-opening-artifact-v1" as const;
export const PHASE8_SELECTION_ATTESTATION_VERSION =
  "phase8-selection-attestation-v1" as const;

const identifierSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonnegativeFiniteSchema = z.number().min(0);
const selectionModeSchema = z.enum([
  "measured-improvement",
  "lowest-terminal-estimate",
  "practical-tie",
  "reference-fallback",
]);
const finalModeSchema = z.enum([
  "one-arm-reference-confirmation",
  "paired-selected-vs-reference",
]);

const selectionAttestationBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal(EVALUATION_PROTOCOL_ID),
    attestationVersion: z.literal(PHASE8_SELECTION_ATTESTATION_VERSION),
    attestationId: identifierSchema,
    writeMode: z.literal("create-exclusive"),
    createdAt: z.iso.datetime(),
    manifestId: identifierSchema,
    manifestSha256: sha256Schema,
    qualificationArtifactSha256: sha256Schema,
    qualificationSummarySha256: sha256Schema,
    selectionDecisionSha256: sha256Schema,
    referenceConfigId: identifierSchema,
    selectedConfigId: identifierSchema,
    selectionIsReference: z.boolean(),
    selectionMode: selectionModeSchema,
    eligibleConfigIds: z
      .array(identifierSchema)
      .min(1)
      .max(PHASE8_MAX_CONFIGURATIONS),
    orderedFallbackConfigIds: z
      .array(identifierSchema)
      .max(PHASE8_MAX_CONFIGURATIONS - 1),
    finalMode: finalModeSchema,
    finalConfigIds: z.array(identifierSchema).min(1).max(2),
    qualificationIntegrityGate: z.literal(true),
    eligibilityGate: z.literal(true),
    splitFirewallGate: z.literal(true),
  })
  .strict();

export type Phase8SelectionAttestation = z.infer<
  typeof selectionAttestationBaseSchema
>;

export type Phase8WriteOnceArtifact<T> = Readonly<{
  fileName: string;
  record: T;
  payload: string;
  payloadSha256: string;
  checksumLine: string;
}>;

function expectedSelectionAttestationId(
  value: Omit<Phase8SelectionAttestation, "attestationId">,
): string {
  return `phase8-selection-${phase8Sha256({
    ...value,
    attestationId: undefined,
  }).slice(0, 24)}`;
}

function addSelectionAttestationIssues(
  value: Phase8SelectionAttestation,
  context: z.RefinementCtx,
): void {
  if (value.attestationId !== expectedSelectionAttestationId(value)) {
    context.addIssue({
      code: "custom",
      path: ["attestationId"],
      message: "Selection attestation ID does not match its payload.",
    });
  }
  if (
    !value.eligibleConfigIds.includes(value.referenceConfigId) ||
    !value.eligibleConfigIds.includes(value.selectedConfigId) ||
    new Set(value.eligibleConfigIds).size !== value.eligibleConfigIds.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["eligibleConfigIds"],
      message:
        "Eligible configuration IDs must be unique and include reference and selection.",
    });
  }
  if (new Set(value.finalConfigIds).size !== value.finalConfigIds.length) {
    context.addIssue({
      code: "custom",
      path: ["finalConfigIds"],
      message: "Final configuration IDs must be unique.",
    });
  }
  if (
    new Set(value.orderedFallbackConfigIds).size !==
      value.orderedFallbackConfigIds.length ||
    value.orderedFallbackConfigIds.includes(value.selectedConfigId) ||
    value.orderedFallbackConfigIds.some(
      (configId) => !value.eligibleConfigIds.includes(configId),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["orderedFallbackConfigIds"],
      message:
        "Fallback IDs must be unique, eligible, and exclude the selection.",
    });
  }
  if (value.selectionIsReference) {
    if (
      value.selectedConfigId !== value.referenceConfigId ||
      value.selectionMode !== "reference-fallback" ||
      value.finalMode !== "one-arm-reference-confirmation" ||
      stableStringify(value.finalConfigIds) !==
        stableStringify([value.referenceConfigId]) ||
      value.orderedFallbackConfigIds.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectionIsReference"],
        message:
          "Reference selection must bind a one-arm reference confirmation.",
      });
    }
    return;
  }
  if (
    value.selectedConfigId === value.referenceConfigId ||
    value.selectionMode === "reference-fallback" ||
    value.finalMode !== "paired-selected-vs-reference" ||
    stableStringify(value.finalConfigIds) !==
      stableStringify([value.referenceConfigId, value.selectedConfigId]) ||
    value.orderedFallbackConfigIds.at(-1) !== value.referenceConfigId
  ) {
    context.addIssue({
      code: "custom",
      path: ["selectionIsReference"],
      message:
        "Non-reference selection must bind a paired selected-vs-reference final.",
    });
  }
}

export const phase8SelectionAttestationSchema =
  selectionAttestationBaseSchema.superRefine(addSelectionAttestationIssues);

const styleCellSchema = z
  .object({
    id: identifierSchema,
    p2: identifierSchema,
    p3: identifierSchema,
  })
  .strict();

const finalSelectionBindingBaseSchema = z
  .object({
    qualificationManifestId: identifierSchema,
    qualificationManifestSha256: sha256Schema,
    selectionAttestationId: identifierSchema,
    selectionAttestationSha256: sha256Schema,
    selectionDecisionSha256: sha256Schema,
    qualificationArtifactSha256: sha256Schema,
    qualificationSummarySha256: sha256Schema,
    referenceConfigId: identifierSchema,
    selectedConfigId: identifierSchema,
    selectionIsReference: z.boolean(),
    selectionMode: z.enum([
      "measured-improvement",
      "lowest-terminal-estimate",
      "practical-tie",
      "reference-fallback",
    ]),
    eligibleConfigIds: z
      .array(identifierSchema)
      .min(1)
      .max(PHASE8_MAX_CONFIGURATIONS),
    orderedFallbackConfigIds: z
      .array(identifierSchema)
      .max(PHASE8_MAX_CONFIGURATIONS - 1),
    finalMode: z.enum([
      "one-arm-reference-confirmation",
      "paired-selected-vs-reference",
    ]),
    finalConfigIds: z.array(identifierSchema).min(1).max(2),
  })
  .strict();

export type Phase8FinalSelectionBinding = z.infer<
  typeof finalSelectionBindingBaseSchema
>;

function addSelectionBindingIssues(
  value: Phase8FinalSelectionBinding,
  context: z.RefinementCtx,
): void {
  if (
    new Set(value.eligibleConfigIds).size !== value.eligibleConfigIds.length ||
    !value.eligibleConfigIds.includes(value.referenceConfigId) ||
    !value.eligibleConfigIds.includes(value.selectedConfigId)
  ) {
    context.addIssue({
      code: "custom",
      path: ["eligibleConfigIds"],
      message:
        "Eligible IDs must be unique and include reference and selection.",
    });
  }
  if (
    new Set(value.orderedFallbackConfigIds).size !==
      value.orderedFallbackConfigIds.length ||
    value.orderedFallbackConfigIds.includes(value.selectedConfigId)
  ) {
    context.addIssue({
      code: "custom",
      path: ["orderedFallbackConfigIds"],
      message: "Fallback IDs must be unique and must not repeat the selection.",
    });
  }
  if (value.selectionIsReference) {
    if (
      value.selectedConfigId !== value.referenceConfigId ||
      value.selectionMode !== "reference-fallback" ||
      value.finalMode !== "one-arm-reference-confirmation" ||
      stableStringify(value.finalConfigIds) !==
        stableStringify([value.referenceConfigId]) ||
      value.orderedFallbackConfigIds.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectionIsReference"],
        message:
          "Reference selection requires a one-arm final and no advanced fallback.",
      });
    }
    return;
  }
  const expectedFinalIds = [value.referenceConfigId, value.selectedConfigId];
  if (
    value.selectedConfigId === value.referenceConfigId ||
    value.selectionMode === "reference-fallback" ||
    value.finalMode !== "paired-selected-vs-reference" ||
    stableStringify(value.finalConfigIds) !==
      stableStringify(expectedFinalIds) ||
    value.orderedFallbackConfigIds.at(-1) !== value.referenceConfigId
  ) {
    context.addIssue({
      code: "custom",
      path: ["selectionIsReference"],
      message:
        "Candidate selection requires selected-vs-reference final arms and reference-last fallback.",
    });
  }
}

export const phase8FinalSelectionBindingSchema =
  finalSelectionBindingBaseSchema.superRefine(addSelectionBindingIssues);

const sampleSizeSchema = z
  .object({
    formulaVersion: z.literal(PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_VERSION),
    formula: z.literal(PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA),
    formulaSha256: sha256Schema,
    qualificationVarianceArtifactSha256: sha256Schema,
    maxPairedClusterStandardDeviation: nonnegativeFiniteSchema,
    rawBaseCount: nonnegativeFiniteSchema,
    blockRoundedBaseCount: z.int().nonnegative(),
    baseCount: z.int().min(64).max(512),
    minimumApplied: z.boolean(),
    maximumApplied: z.boolean(),
  })
  .strict();

type Phase8FinalSampleSizeBinding = z.infer<typeof sampleSizeSchema>;

const finalManifestBaseSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_MANIFEST_SCHEMA_VERSION),
    protocolId: z.literal(EVALUATION_PROTOCOL_ID),
    manifestVersion: z.literal(PHASE8_FINAL_MANIFEST_VERSION),
    manifestId: identifierSchema,
    status: z.literal("frozen"),
    createdAt: z.iso.datetime(),
    qualificationManifestId: identifierSchema,
    qualificationManifestSha256: sha256Schema,
    sourceFileCount: z.int().positive(),
    ruleProfileId: z.literal("canonical-v1"),
    rules: ruleConfigSchema,
    styleCells: z.array(styleCellSchema).length(PHASE8_STYLE_CELL_COUNT),
    configurations: z.array(phase8ConfigurationDescriptorSchema).min(1).max(2),
    selection: phase8FinalSelectionBindingSchema,
    split: phase8SplitPlanSchema,
    sampleSize: sampleSizeSchema,
    hashes: phase8HashBundleSchema,
    rngAlgorithm: z.literal(RNG_ALGORITHM),
    seedPolicyId: z.literal(
      "phase8-sealed-final-selection-disclosure-sha256-v1",
    ),
    reportPolicy: z.literal(
      "unchanged-qualification-report-code-and-fresh-final-seeds",
    ),
  })
  .strict();

export type Phase8FinalManifest = z.infer<typeof finalManifestBaseSchema>;

function canonicalStyleCells(): Phase8FinalManifest["styleCells"] {
  return STYLE_CELLS.map((cell) => ({
    id: cell.id,
    p2: cell.p2,
    p3: cell.p3,
  }));
}

function sampleSizeBinding(
  qualificationVarianceArtifactSha256: string,
  value: Phase8TerminalSampleSize,
): Phase8FinalSampleSizeBinding {
  return {
    formulaVersion: PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_VERSION,
    formula: PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA,
    formulaSha256: phase8Sha256(PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_CONTRACT),
    qualificationVarianceArtifactSha256,
    ...value,
  };
}

function addFinalManifestIssues(
  value: Phase8FinalManifest,
  context: z.RefinementCtx,
): void {
  if (
    value.qualificationManifestId !== value.selection.qualificationManifestId ||
    value.qualificationManifestSha256 !==
      value.selection.qualificationManifestSha256
  ) {
    context.addIssue({
      code: "custom",
      path: ["selection"],
      message:
        "Final selection is bound to a different qualification manifest.",
    });
  }
  if (
    stableStringify(value.rules) !== stableStringify(CANONICAL_RULES) ||
    value.hashes.rulesSha256 !== phase8Sha256(value.rules)
  ) {
    context.addIssue({
      code: "custom",
      path: ["rules"],
      message: "Final manifest canonical rules or their hash drifted.",
    });
  }
  if (
    stableStringify(value.styleCells) !== stableStringify(canonicalStyleCells())
  ) {
    context.addIssue({
      code: "custom",
      path: ["styleCells"],
      message: "Final manifest must retain all 17 canonical style cells.",
    });
  }
  if (
    stableStringify(value.configurations.map((config) => config.configId)) !==
    stableStringify(value.selection.finalConfigIds)
  ) {
    context.addIssue({
      code: "custom",
      path: ["configurations"],
      message: "Final registry must exactly match the selected final arms.",
    });
  }
  if (value.hashes.configSha256 !== phase8Sha256(value.configurations)) {
    context.addIssue({
      code: "custom",
      path: ["hashes", "configSha256"],
      message: "Final configuration hash does not match its registry.",
    });
  }
  if (
    value.split.split !== "final" ||
    value.split.baseIndexStart !== 0 ||
    value.split.baseCount !== value.sampleSize.baseCount ||
    stableStringify(value.split.styleCellIds) !==
      stableStringify(STYLE_CELLS.map((cell) => cell.id))
  ) {
    context.addIssue({
      code: "custom",
      path: ["split"],
      message:
        "Final split must start at zero, use the computed N, and retain all 17 cells.",
    });
  }
  const expectedSampleSize = computePhase8TerminalSampleSize(
    value.sampleSize.maxPairedClusterStandardDeviation,
  );
  const expectedBinding = sampleSizeBinding(
    value.sampleSize.qualificationVarianceArtifactSha256,
    expectedSampleSize,
  );
  if (stableStringify(value.sampleSize) !== stableStringify(expectedBinding)) {
    context.addIssue({
      code: "custom",
      path: ["sampleSize"],
      message:
        "Final N does not match the frozen qualification-variance sizing formula.",
    });
  }
}

export const phase8FinalManifestSchema = finalManifestBaseSchema.superRefine(
  addFinalManifestIssues,
);

const finalManifestAuthorityArtifactRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactVersion: z.literal(
      PHASE8_FINAL_MANIFEST_AUTHORITY_ARTIFACT_VERSION,
    ),
    manifestSha256: sha256Schema,
    manifest: phase8FinalManifestSchema,
  })
  .strict();

export type Phase8FinalManifestAuthorityArtifact = Readonly<{
  fileName: string;
  payload: string;
  payloadSha256: string;
  checksumLine: string;
}>;

const finalSplitOpeningRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactVersion: z.literal(PHASE8_FINAL_SPLIT_OPENING_ARTIFACT_VERSION),
    manifestSha256: sha256Schema,
    opening: z
      .object({
        schemaVersion: z.literal(1),
        protocolId: z.literal(EVALUATION_PROTOCOL_ID),
        manifestId: identifierSchema,
        manifestSha256: sha256Schema,
        split: z.literal("final"),
        splitPlanSha256: sha256Schema,
        seedDisclosureAuthorized: z.literal(true),
        authorizationKind: z.literal("final-selection-attestation"),
        authorizationSha256: sha256Schema,
        openingSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

const FINAL_MANIFEST_AUTHORITY = Symbol("phase8-final-manifest-authority");
const FINAL_SPLIT_OPENING_AUTHORITY = Symbol(
  "phase8-final-split-opening-authority",
);

export type FrozenPhase8FinalManifestAuthority = Readonly<{
  manifest: Phase8FinalManifest;
  manifestSha256: string;
  [FINAL_MANIFEST_AUTHORITY]: true;
}>;

export type Phase8FinalSplitOpening = Readonly<{
  schemaVersion: 1;
  protocolId: typeof EVALUATION_PROTOCOL_ID;
  manifestId: string;
  manifestSha256: string;
  split: "final";
  splitPlanSha256: string;
  seedDisclosureAuthorized: true;
  authorizationKind: "final-selection-attestation";
  authorizationSha256: string;
  openingSha256: string;
  [FINAL_SPLIT_OPENING_AUTHORITY]: true;
}>;

type Phase8FinalManifestBindingDraft = {
  readonly manifestId: string;
  readonly createdAt: string;
  readonly selection: Phase8FinalSelectionBinding;
  readonly qualificationVarianceArtifactSha256: string;
  readonly maxPairedClusterStandardDeviation: number;
  readonly eventCap: number;
};

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function hasTrueBrand(value: unknown, brand: symbol): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Reflect.get(value, brand) === true;
}

function assertExclusiveSelectionTarget(existingTarget: unknown): void {
  if (existingTarget !== null) {
    throw new Error(
      "Refusing to overwrite an existing Phase 8 attestation target.",
    );
  }
}

function verifySelectionDecision(
  authority: FrozenPhase8ManifestAuthority,
  decision: Phase8SelectionDecision,
): void {
  verifyPhase8SelectionDecisionAuthority(decision);
  const { decisionSha256, ...projection } = decision;
  if (
    decision.manifestId !== authority.manifest.manifestId ||
    decision.manifestSha256 !== authority.manifestSha256 ||
    decisionSha256 !== phase8Sha256(projection)
  ) {
    throw new Error(
      "Selection decision is not bound to the frozen Phase 8 manifest.",
    );
  }
  const reference = authority.manifest.configurations.find(
    (configuration) => configuration.role === "reference",
  );
  if (
    reference === undefined ||
    decision.referenceConfigId !== reference.configId ||
    !authority.manifest.configurations.some(
      (configuration) => configuration.configId === decision.selectedConfigId,
    )
  ) {
    throw new Error(
      "Selection decision references a configuration outside the manifest.",
    );
  }
}

export function createPhase8SelectionAttestation(input: {
  readonly existingTarget: unknown;
  readonly authority: FrozenPhase8ManifestAuthority;
  readonly decision: Phase8SelectionDecision;
  readonly createdAt: string;
  readonly qualificationArtifactSha256: string;
  readonly qualificationSummarySha256: string;
  readonly qualificationIntegrityGate: boolean;
  readonly eligibilityGate: boolean;
  readonly splitFirewallGate: boolean;
}): Phase8WriteOnceArtifact<Phase8SelectionAttestation> {
  assertExclusiveSelectionTarget(input.existingTarget);
  verifyPhase8ManifestAuthority(input.authority);
  verifySelectionDecision(input.authority, input.decision);
  if (
    !input.qualificationIntegrityGate ||
    !input.eligibilityGate ||
    !input.splitFirewallGate
  ) {
    throw new Error(
      "Selection attestation requires every qualification gate to pass.",
    );
  }
  const projection: Omit<Phase8SelectionAttestation, "attestationId"> = {
    schemaVersion: 1,
    protocolId: EVALUATION_PROTOCOL_ID,
    attestationVersion: PHASE8_SELECTION_ATTESTATION_VERSION,
    writeMode: "create-exclusive",
    createdAt: input.createdAt,
    manifestId: input.authority.manifest.manifestId,
    manifestSha256: input.authority.manifestSha256,
    qualificationArtifactSha256: input.qualificationArtifactSha256,
    qualificationSummarySha256: input.qualificationSummarySha256,
    selectionDecisionSha256: input.decision.decisionSha256,
    referenceConfigId: input.decision.referenceConfigId,
    selectedConfigId: input.decision.selectedConfigId,
    selectionIsReference: input.decision.selectionIsReference,
    selectionMode: input.decision.selectionMode,
    eligibleConfigIds: [...input.decision.eligibleConfigIds],
    orderedFallbackConfigIds: [...input.decision.orderedFallbackConfigIds],
    finalMode: input.decision.finalRule.mode,
    finalConfigIds: [...input.decision.finalRule.configurationIds],
    qualificationIntegrityGate: true,
    eligibilityGate: true,
    splitFirewallGate: true,
  };
  const record = phase8SelectionAttestationSchema.parse({
    ...projection,
    attestationId: expectedSelectionAttestationId(projection),
  });
  const fileName = "selection-attestation.json";
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

export function verifyPhase8SelectionArtifact(
  artifact: Phase8WriteOnceArtifact<Phase8SelectionAttestation>,
): Phase8SelectionAttestation {
  const record = phase8SelectionAttestationSchema.parse(artifact.record);
  const payload = `${stableStringify(record)}\n`;
  const payloadSha256 = createHash("sha256")
    .update(payload, "utf8")
    .digest("hex");
  if (
    artifact.fileName !== "selection-attestation.json" ||
    artifact.payload !== payload ||
    artifact.payloadSha256 !== payloadSha256 ||
    artifact.checksumLine !== `${payloadSha256}  selection-attestation.json\n`
  ) {
    throw new Error("Selection attestation checksum envelope is invalid.");
  }
  return record;
}

export function rehydratePhase8SelectionArtifact(input: {
  readonly payload: string;
  readonly checksumLine: string;
}): Phase8WriteOnceArtifact<Phase8SelectionAttestation> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.payload) as unknown;
  } catch (error) {
    throw new Error("Phase 8 selection attestation is not valid JSON.", {
      cause: error,
    });
  }
  const record = phase8SelectionAttestationSchema.parse(parsed);
  if (input.payload !== `${stableStringify(record)}\n`) {
    throw new Error(
      "Phase 8 selection attestation is not byte-identical canonical JSON.",
    );
  }
  const payloadSha256 = createHash("sha256")
    .update(input.payload, "utf8")
    .digest("hex");
  const artifact = deepFreeze({
    fileName: "selection-attestation.json" as const,
    record,
    payload: input.payload,
    payloadSha256,
    checksumLine: input.checksumLine,
  });
  verifyPhase8SelectionArtifact(artifact);
  return artifact;
}

function configurationForId(
  authority: FrozenPhase8ManifestAuthority,
  configId: string,
): Phase8ConfigurationDescriptor {
  const configuration = authority.manifest.configurations.find(
    (candidate) => candidate.configId === configId,
  );
  if (configuration === undefined) {
    throw new Error(
      `Final selection references unknown configuration ${configId}.`,
    );
  }
  return phase8ConfigurationDescriptorSchema.parse(configuration);
}

function freezePhase8FinalManifestFromBinding(
  qualificationAuthority: FrozenPhase8ManifestAuthority,
  draft: Phase8FinalManifestBindingDraft,
): FrozenPhase8FinalManifestAuthority {
  verifyPhase8ManifestAuthority(qualificationAuthority);
  const selection = phase8FinalSelectionBindingSchema.parse(draft.selection);
  if (
    selection.qualificationManifestId !==
      qualificationAuthority.manifest.manifestId ||
    selection.qualificationManifestSha256 !==
      qualificationAuthority.manifestSha256
  ) {
    throw new Error(
      "Cannot derive a final authority from a different qualification manifest.",
    );
  }
  const reference = qualificationAuthority.manifest.configurations.find(
    (configuration) => configuration.role === "reference",
  );
  if (
    reference === undefined ||
    selection.referenceConfigId !== reference.configId
  ) {
    throw new Error("Final selection does not bind the frozen reference.");
  }
  const configurations = selection.finalConfigIds.map((configId) =>
    configurationForId(qualificationAuthority, configId),
  );
  const rules: RuleConfig = structuredClone(CANONICAL_RULES);
  const computedSampleSize = computePhase8TerminalSampleSize(
    draft.maxPairedClusterStandardDeviation,
  );
  const hashes: Phase8HashBundle = {
    ...qualificationAuthority.manifest.hashes,
    configSha256: phase8Sha256(configurations),
  };
  const manifest = phase8FinalManifestSchema.parse({
    schemaVersion: PHASE8_MANIFEST_SCHEMA_VERSION,
    protocolId: EVALUATION_PROTOCOL_ID,
    manifestVersion: PHASE8_FINAL_MANIFEST_VERSION,
    manifestId: draft.manifestId,
    status: "frozen",
    createdAt: draft.createdAt,
    qualificationManifestId: qualificationAuthority.manifest.manifestId,
    qualificationManifestSha256: qualificationAuthority.manifestSha256,
    sourceFileCount: qualificationAuthority.manifest.sourceFileCount,
    ruleProfileId: "canonical-v1",
    rules,
    styleCells: canonicalStyleCells(),
    configurations,
    selection,
    split: {
      split: "final",
      baseIndexStart: 0,
      baseCount: computedSampleSize.baseCount,
      rotations: [...PHASE8_ROTATIONS],
      replicates: [0],
      styleCellIds: STYLE_CELLS.map((cell) => cell.id),
      eventCap: draft.eventCap,
    } satisfies Phase8SplitPlan,
    sampleSize: sampleSizeBinding(
      draft.qualificationVarianceArtifactSha256,
      computedSampleSize,
    ),
    hashes,
    rngAlgorithm: RNG_ALGORITHM,
    seedPolicyId: "phase8-sealed-final-selection-disclosure-sha256-v1",
    reportPolicy: "unchanged-qualification-report-code-and-fresh-final-seeds",
  });
  const frozenManifest = deepFreeze(manifest);
  return deepFreeze({
    manifest: frozenManifest,
    manifestSha256: phase8Sha256(frozenManifest),
    [FINAL_MANIFEST_AUTHORITY]: true as const,
  });
}

export function freezePhase8FinalManifestFromSelection(input: {
  readonly qualificationAuthority: FrozenPhase8ManifestAuthority;
  readonly selectionArtifact: Phase8WriteOnceArtifact<Phase8SelectionAttestation>;
  readonly manifestId: string;
  readonly createdAt: string;
  readonly qualificationVarianceArtifactSha256: string;
  readonly maxPairedClusterStandardDeviation: number;
  readonly eventCap: number;
}): FrozenPhase8FinalManifestAuthority {
  verifyPhase8ManifestAuthority(input.qualificationAuthority);
  const selection = verifyPhase8SelectionArtifact(input.selectionArtifact);
  if (
    selection.manifestId !== input.qualificationAuthority.manifest.manifestId ||
    selection.manifestSha256 !== input.qualificationAuthority.manifestSha256
  ) {
    throw new Error(
      "Selection attestation is bound to a different qualification authority.",
    );
  }
  return freezePhase8FinalManifestFromBinding(input.qualificationAuthority, {
    manifestId: input.manifestId,
    createdAt: input.createdAt,
    selection: {
      qualificationManifestId: selection.manifestId,
      qualificationManifestSha256: selection.manifestSha256,
      selectionAttestationId: selection.attestationId,
      selectionAttestationSha256: input.selectionArtifact.payloadSha256,
      selectionDecisionSha256: selection.selectionDecisionSha256,
      qualificationArtifactSha256: selection.qualificationArtifactSha256,
      qualificationSummarySha256: selection.qualificationSummarySha256,
      referenceConfigId: selection.referenceConfigId,
      selectedConfigId: selection.selectedConfigId,
      selectionIsReference: selection.selectionIsReference,
      selectionMode: selection.selectionMode,
      eligibleConfigIds: selection.eligibleConfigIds,
      orderedFallbackConfigIds: selection.orderedFallbackConfigIds,
      finalMode: selection.finalMode,
      finalConfigIds: selection.finalConfigIds,
    },
    qualificationVarianceArtifactSha256:
      input.qualificationVarianceArtifactSha256,
    maxPairedClusterStandardDeviation: input.maxPairedClusterStandardDeviation,
    eventCap: input.eventCap,
  });
}

function finalManifestAuthorityRecord(
  authority: FrozenPhase8FinalManifestAuthority,
): z.infer<typeof finalManifestAuthorityArtifactRecordSchema> {
  assertFinalAuthority(authority);
  return {
    schemaVersion: 1,
    artifactVersion: PHASE8_FINAL_MANIFEST_AUTHORITY_ARTIFACT_VERSION,
    manifestSha256: authority.manifestSha256,
    manifest: authority.manifest,
  };
}

export function serializePhase8FinalManifestAuthority(
  authority: FrozenPhase8FinalManifestAuthority,
): string {
  return `${stableStringify(finalManifestAuthorityRecord(authority))}\n`;
}

export function parseAndRehydratePhase8FinalManifestAuthority(input: {
  readonly payload: string;
  readonly qualificationAuthority: FrozenPhase8ManifestAuthority;
  readonly selectionArtifact: Phase8WriteOnceArtifact<Phase8SelectionAttestation>;
}): FrozenPhase8FinalManifestAuthority {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.payload) as unknown;
  } catch (error) {
    throw new Error(
      "Phase 8 final manifest authority artifact is not valid JSON.",
      { cause: error },
    );
  }
  const record = finalManifestAuthorityArtifactRecordSchema.parse(parsed);
  if (input.payload !== `${stableStringify(record)}\n`) {
    throw new Error(
      "Phase 8 final manifest authority artifact is not byte-identical canonical JSON.",
    );
  }
  const rebuilt = freezePhase8FinalManifestFromSelection({
    qualificationAuthority: input.qualificationAuthority,
    selectionArtifact: input.selectionArtifact,
    manifestId: record.manifest.manifestId,
    createdAt: record.manifest.createdAt,
    qualificationVarianceArtifactSha256:
      record.manifest.sampleSize.qualificationVarianceArtifactSha256,
    maxPairedClusterStandardDeviation:
      record.manifest.sampleSize.maxPairedClusterStandardDeviation,
    eventCap: record.manifest.split.eventCap,
  });
  if (
    stableStringify(rebuilt.manifest) !== stableStringify(record.manifest) ||
    rebuilt.manifestSha256 !== record.manifestSha256
  ) {
    throw new Error(
      "Phase 8 final manifest artifact does not reproduce the attested constructor.",
    );
  }
  return rebuilt;
}

export function createPhase8FinalManifestAuthorityArtifact(input: {
  readonly existingTarget: unknown;
  readonly authority: FrozenPhase8FinalManifestAuthority;
}): Phase8FinalManifestAuthorityArtifact {
  if (input.existingTarget !== null) {
    throw new Error(
      "Refusing to overwrite an existing Phase 8 final manifest authority artifact.",
    );
  }
  const payload = serializePhase8FinalManifestAuthority(input.authority);
  const payloadSha256 = createHash("sha256")
    .update(payload, "utf8")
    .digest("hex");
  return deepFreeze({
    fileName: "phase8-final-manifest-authority.json" as const,
    payload,
    payloadSha256,
    checksumLine: `${payloadSha256}  phase8-final-manifest-authority.json\n`,
  });
}

export function rehydratePhase8FinalManifestAuthorityArtifact(input: {
  readonly artifact: Phase8FinalManifestAuthorityArtifact;
  readonly qualificationAuthority: FrozenPhase8ManifestAuthority;
  readonly selectionArtifact: Phase8WriteOnceArtifact<Phase8SelectionAttestation>;
}): FrozenPhase8FinalManifestAuthority {
  const payloadSha256 = createHash("sha256")
    .update(input.artifact.payload, "utf8")
    .digest("hex");
  if (
    input.artifact.fileName !== "phase8-final-manifest-authority.json" ||
    input.artifact.payloadSha256 !== payloadSha256 ||
    input.artifact.checksumLine !==
      `${payloadSha256}  phase8-final-manifest-authority.json\n`
  ) {
    throw new Error(
      "Phase 8 final manifest authority checksum envelope is invalid.",
    );
  }
  return parseAndRehydratePhase8FinalManifestAuthority({
    payload: input.artifact.payload,
    qualificationAuthority: input.qualificationAuthority,
    selectionArtifact: input.selectionArtifact,
  });
}

function assertFinalAuthority(
  authority: FrozenPhase8FinalManifestAuthority,
): void {
  if (
    !hasTrueBrand(authority, FINAL_MANIFEST_AUTHORITY) ||
    !Object.isFrozen(authority) ||
    !Object.isFrozen(authority.manifest)
  ) {
    throw new Error("A genuine frozen Phase 8 final authority is required.");
  }
  phase8FinalManifestSchema.parse(authority.manifest);
  if (authority.manifestSha256 !== phase8Sha256(authority.manifest)) {
    throw new Error("Frozen Phase 8 final manifest integrity check failed.");
  }
}

export function verifyPhase8FinalManifestAuthority(
  authority: FrozenPhase8FinalManifestAuthority,
): true {
  assertFinalAuthority(authority);
  return true;
}

export function openPhase8FinalSplit(
  authority: FrozenPhase8FinalManifestAuthority,
): Phase8FinalSplitOpening {
  assertFinalAuthority(authority);
  const projection = {
    schemaVersion: 1,
    protocolId: EVALUATION_PROTOCOL_ID,
    manifestId: authority.manifest.manifestId,
    manifestSha256: authority.manifestSha256,
    split: "final",
    splitPlanSha256: phase8Sha256(authority.manifest.split),
    seedDisclosureAuthorized: true,
    authorizationKind: "final-selection-attestation",
    authorizationSha256:
      authority.manifest.selection.selectionAttestationSha256,
  } as const;
  return deepFreeze({
    ...projection,
    openingSha256: phase8Sha256(projection),
    [FINAL_SPLIT_OPENING_AUTHORITY]: true as const,
  });
}

export function serializePhase8FinalSplitOpening(
  authority: FrozenPhase8FinalManifestAuthority,
  opening: Phase8FinalSplitOpening,
): string {
  assertFinalOpening(authority, opening);
  const rebuilt = openPhase8FinalSplit(authority);
  if (stableStringify(rebuilt) !== stableStringify(opening)) {
    throw new Error(
      "Phase 8 final split opening does not reproduce its final authority.",
    );
  }
  const record = finalSplitOpeningRecordSchema.parse({
    schemaVersion: 1,
    artifactVersion: PHASE8_FINAL_SPLIT_OPENING_ARTIFACT_VERSION,
    manifestSha256: authority.manifestSha256,
    opening,
  });
  return `${stableStringify(record)}\n`;
}

export function parseAndRehydratePhase8FinalSplitOpening(
  authority: FrozenPhase8FinalManifestAuthority,
  payload: string,
): Phase8FinalSplitOpening {
  assertFinalAuthority(authority);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch (error) {
    throw new Error("Phase 8 final split-opening artifact is not valid JSON.", {
      cause: error,
    });
  }
  const record = finalSplitOpeningRecordSchema.parse(parsed);
  if (
    payload !== `${stableStringify(record)}\n` ||
    record.manifestSha256 !== authority.manifestSha256
  ) {
    throw new Error(
      "Phase 8 final split-opening artifact is noncanonical or bound to another manifest.",
    );
  }
  const opening = openPhase8FinalSplit(authority);
  if (stableStringify(opening) !== stableStringify(record.opening)) {
    throw new Error(
      "Phase 8 final split-opening artifact does not reproduce its authority.",
    );
  }
  return opening;
}

function assertFinalOpening(
  authority: FrozenPhase8FinalManifestAuthority,
  opening: Phase8FinalSplitOpening,
): void {
  assertFinalAuthority(authority);
  if (
    !hasTrueBrand(opening, FINAL_SPLIT_OPENING_AUTHORITY) ||
    !Object.isFrozen(opening) ||
    opening.manifestId !== authority.manifest.manifestId ||
    opening.manifestSha256 !== authority.manifestSha256 ||
    opening.splitPlanSha256 !== phase8Sha256(authority.manifest.split) ||
    opening.authorizationSha256 !==
      authority.manifest.selection.selectionAttestationSha256
  ) {
    throw new Error("Invalid or stale Phase 8 final split opening.");
  }
  const projection = {
    schemaVersion: opening.schemaVersion,
    protocolId: opening.protocolId,
    manifestId: opening.manifestId,
    manifestSha256: opening.manifestSha256,
    split: opening.split,
    splitPlanSha256: opening.splitPlanSha256,
    seedDisclosureAuthorized: opening.seedDisclosureAuthorized,
    authorizationKind: opening.authorizationKind,
    authorizationSha256: opening.authorizationSha256,
  };
  if (opening.openingSha256 !== phase8Sha256(projection)) {
    throw new Error("Phase 8 final split-opening checksum mismatch.");
  }
}

function coordinateMaterial(coordinate: Phase8SeedCoordinate): string[] {
  if (coordinate.stream === "deal") {
    return [coordinate.baseIndex.toString()];
  }
  if (
    coordinate.stream === "belief" ||
    coordinate.stream === "search" ||
    coordinate.stream === "rollout" ||
    coordinate.stream === "user-policy" ||
    coordinate.stream === "bootstrap" ||
    coordinate.stream === "solver-chance"
  ) {
    return [
      coordinate.baseIndex.toString(),
      coordinate.rotation.toString(),
      coordinate.replicate.toString(),
    ];
  }
  return [
    coordinate.styleCellId,
    coordinate.baseIndex.toString(),
    coordinate.rotation.toString(),
    coordinate.replicate.toString(),
  ];
}

export function deriveOpenedPhase8FinalSeed(
  authority: FrozenPhase8FinalManifestAuthority,
  opening: Phase8FinalSplitOpening,
  coordinate: Phase8SeedCoordinate,
): string {
  assertFinalOpening(authority, opening);
  const plan = authority.manifest.split;
  if (!PHASE8_SEED_STREAMS.includes(coordinate.stream)) {
    throw new Error(`Unknown Phase 8 final seed stream ${coordinate.stream}.`);
  }
  if (
    !plan.styleCellIds.includes(coordinate.styleCellId) ||
    !plan.rotations.includes(coordinate.rotation) ||
    !plan.replicates.includes(coordinate.replicate) ||
    !Number.isSafeInteger(coordinate.baseIndex) ||
    coordinate.baseIndex < plan.baseIndexStart ||
    coordinate.baseIndex >= plan.baseIndexStart + plan.baseCount
  ) {
    throw new Error("Seed coordinate is outside the frozen final split.");
  }
  return createHash("sha256")
    .update(
      [
        `bhabhi/${EVALUATION_PROTOCOL_ID}`,
        "final",
        coordinate.stream,
        ...coordinateMaterial(coordinate),
      ].join("|"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}
