import { z } from "zod";

import { stableStringify } from "../events/stable-hash";
import {
  parsePhase8HardOnlyModel,
  serializePhase8HardOnlyModel,
} from "../modeling/hard-only-model";
import {
  parsePhase8ProductionModelArtifact,
  phase8ProductionModelConfig,
  serializePhase8ProductionModelArtifact,
  type Phase8ProductionModelArtifact,
  type Phase8ProductionModelConfig,
} from "../modeling/production-model";
import {
  parsePhase8PracticalBehaviorModelArtifact,
  phase8PracticalBehaviorModelConfig,
  serializePhase8PracticalBehaviorModelArtifact,
  type Phase8PracticalBehaviorModelArtifact,
} from "../modeling/practical-behavior-model";
import { BEHAVIOR_WEIGHTED_APPROXIMATE_ALGORITHM_VERSION } from "../search/behavior-weighted-approximate";
import { PUBLIC_HISTORY_ROOT_TIE_BREAK_VERSION } from "../search/root-tie-break";
import { SEARCH_ALGORITHM_VERSION } from "../search/types";
import {
  PRODUCTION_ROLE_COMPONENTS,
  PRODUCTION_ROLE_FALLBACKS,
  PRODUCTION_ROUTING_CONTRACTS,
  isBehaviorProductionRole,
  isExactProductionRole,
  productionRoleIdSchema,
  type ProductionRoleId,
} from "./roles";

export const PRODUCTION_RELEASE_BUNDLE_VERSION =
  "production-execution-bundle-v2" as const;
export const EMPTY_UTF8_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

const MAX_RELEASE_ARTIFACT_BYTES = 16 * 1024 * 1024;
const identifierSchema = z.string().trim().min(1).max(512);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const stableHashSchema = z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u);
const artifactBytesSchema = z.string().min(1).max(MAX_RELEASE_ARTIFACT_BYTES);

const artifactEnvelopeSchema = z
  .object({
    bytes: artifactBytesSchema,
    sha256: sha256Schema,
  })
  .strict();
export type ProductionArtifactEnvelope = z.infer<typeof artifactEnvelopeSchema>;

const releaseUnavailableSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseVersion: z.literal(PRODUCTION_RELEASE_BUNDLE_VERSION),
    mode: z.literal("unselected"),
    reason: z.enum([
      "phase8-selection-unavailable",
      "phase8-final-attestation-unavailable",
      "production-release-not-compiled",
    ]),
  })
  .strict();

const commonExecutableBundleFields = {
  schemaVersion: z.literal(1),
  releaseVersion: z.literal(PRODUCTION_RELEASE_BUNDLE_VERSION),
  sourceHash: sha256Schema,
  protocolHash: sha256Schema,
  manifest: artifactEnvelopeSchema,
  descriptor: artifactEnvelopeSchema,
  productionModel: artifactEnvelopeSchema,
} as const;

const evaluationOnlySchema = z
  .object({
    ...commonExecutableBundleFields,
    mode: z.literal("evaluation-only"),
    scope: z.enum(["qualification", "final"]),
  })
  .strict();

const releaseSelectedSchema = z
  .object({
    ...commonExecutableBundleFields,
    mode: z.literal("release-selected"),
    selectionAttestation: artifactEnvelopeSchema,
    finalAttestation: artifactEnvelopeSchema,
  })
  .strict();

export const productionReleaseBundleSchema = z.discriminatedUnion("mode", [
  releaseUnavailableSchema,
  evaluationOnlySchema,
  releaseSelectedSchema,
]);

export type ProductionReleaseBundle = z.infer<
  typeof productionReleaseBundleSchema
>;
export type EvaluationProductionBundle = z.infer<typeof evaluationOnlySchema>;
export type SelectedProductionReleaseBundle = z.infer<
  typeof releaseSelectedSchema
>;
type ExecutableProductionBundle =
  EvaluationProductionBundle | SelectedProductionReleaseBundle;

export const UNSELECTED_PRODUCTION_RELEASE_BUNDLE: ProductionReleaseBundle =
  Object.freeze({
    schemaVersion: 1,
    releaseVersion: PRODUCTION_RELEASE_BUNDLE_VERSION,
    mode: "unselected",
    reason: "production-release-not-compiled",
  });

const descriptorImplementationSchema = z
  .object({
    terminalRunnerVersion: z.literal("phase8-terminal-matrix-runner-v1"),
    hardOnlySearchAlgorithmVersion: z.literal(SEARCH_ALGORITHM_VERSION),
    behaviorWeightedSearchAlgorithmVersion: z
      .literal(BEHAVIOR_WEIGHTED_APPROXIMATE_ALGORITHM_VERSION)
      .nullable(),
    rootTieBreakVersion: z.literal(PUBLIC_HISTORY_ROOT_TIE_BREAK_VERSION),
    routingContract: z.enum([
      "direct-phase5-hard-only",
      "exact-hard-then-byte-identical-r",
      "behavior-weighted-refuse-on-failure",
      "behavior-exact-then-byte-identical-b",
    ]),
    phase5ReferenceConfigHash: stableHashSchema,
    continuationPolicyHash: stableHashSchema,
    exactConfigHash: stableHashSchema.nullable(),
    fallbackConfigId: productionRoleIdSchema.nullable(),
    behaviorFailurePolicy: z.enum(["refuse", "not-applicable"]),
    productionModelSha256: sha256Schema.nullable(),
    modelSelectionContractHash: stableHashSchema.nullable(),
    separateOpponentPriors: z.boolean(),
    behaviorWorldCount: z.number().int().positive().nullable(),
    robustChoice: z.boolean().nullable(),
  })
  .strict();

const productionDescriptorSchema = z
  .object({
    configId: productionRoleIdSchema,
    label: identifierSchema,
    role: z.enum(["reference", "candidate"]),
    budgetId: z.literal("balanced"),
    components: z
      .object({
        exactEndgame: z.boolean(),
        behaviorWeighting: z.boolean(),
      })
      .strict(),
    implementation: descriptorImplementationSchema,
    configSha256: sha256Schema,
  })
  .strict();

export type ProductionConfigurationDescriptor = z.infer<
  typeof productionDescriptorSchema
>;

const selectionAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("eval-v1"),
    attestationVersion: z.literal("phase8-selection-attestation-v1"),
    attestationId: identifierSchema,
    writeMode: z.literal("create-exclusive"),
    createdAt: z.iso.datetime(),
    manifestId: identifierSchema,
    manifestSha256: sha256Schema,
    qualificationArtifactSha256: sha256Schema,
    qualificationSummarySha256: sha256Schema,
    selectionDecisionSha256: sha256Schema,
    referenceConfigId: productionRoleIdSchema,
    selectedConfigId: productionRoleIdSchema,
    selectionIsReference: z.boolean(),
    selectionMode: z.enum([
      "measured-improvement",
      "lowest-terminal-estimate",
      "practical-tie",
      "reference-fallback",
    ]),
    eligibleConfigIds: z.array(productionRoleIdSchema).min(1).max(4),
    orderedFallbackConfigIds: z.array(productionRoleIdSchema).max(3),
    finalMode: z.enum([
      "one-arm-reference-confirmation",
      "paired-selected-vs-reference",
    ]),
    finalConfigIds: z.array(productionRoleIdSchema).min(1).max(2),
    qualificationIntegrityGate: z.literal(true),
    eligibilityGate: z.literal(true),
    splitFirewallGate: z.literal(true),
  })
  .strict();

const finalAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("eval-v1"),
    attestationVersion: z.literal("phase8-final-attestation-v1"),
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
    referenceConfigId: productionRoleIdSchema,
    selectedConfigId: productionRoleIdSchema,
    selectionIsReference: z.boolean(),
    finalMode: z.enum([
      "one-arm-reference-confirmation",
      "paired-selected-vs-reference",
    ]),
    finalConfigIds: z.array(productionRoleIdSchema).min(1).max(2),
    finalIntegrityGate: z.literal(true),
    completeMatrixGate: z.literal(true),
    zeroFailureGate: z.literal(true),
    zeroCapGate: z.literal(true),
    zeroCancellationGate: z.literal(true),
    seedReplayGate: z.literal(true),
    selectedConfirmationGate: z.literal(true),
  })
  .strict();

type SelectionAttestation = z.infer<typeof selectionAttestationSchema>;
type FinalAttestation = z.infer<typeof finalAttestationSchema>;

const manifestHashesViewSchema = z
  .object({
    sourceSha256: sha256Schema,
    configSha256: sha256Schema,
    modelSha256: sha256Schema,
  })
  .loose();

const qualificationManifestViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("eval-v1"),
    manifestVersion: z.literal("phase8-evaluation-manifest-v1"),
    manifestId: identifierSchema,
    status: z.literal("frozen"),
    configurations: z.array(productionDescriptorSchema).min(1).max(4),
    hashes: manifestHashesViewSchema,
  })
  .loose();

const finalManifestSelectionViewSchema = z
  .object({
    qualificationManifestId: identifierSchema,
    qualificationManifestSha256: sha256Schema,
    selectionAttestationId: identifierSchema,
    selectionAttestationSha256: sha256Schema,
    referenceConfigId: productionRoleIdSchema,
    selectedConfigId: productionRoleIdSchema,
    selectionIsReference: z.boolean(),
    finalMode: z.enum([
      "one-arm-reference-confirmation",
      "paired-selected-vs-reference",
    ]),
    finalConfigIds: z.array(productionRoleIdSchema).min(1).max(2),
  })
  .loose();

const finalManifestViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("eval-v1"),
    manifestVersion: z.literal("phase8-final-evaluation-manifest-v1"),
    manifestId: identifierSchema,
    status: z.literal("frozen"),
    qualificationManifestId: identifierSchema,
    qualificationManifestSha256: sha256Schema,
    configurations: z.array(productionDescriptorSchema).min(1).max(2),
    selection: finalManifestSelectionViewSchema,
    hashes: manifestHashesViewSchema,
  })
  .loose();

type QualificationManifestView = z.infer<
  typeof qualificationManifestViewSchema
>;
type FinalManifestView = z.infer<typeof finalManifestViewSchema>;

export type ProductionBundleMode = "evaluation-only" | "release-selected";
export type ProductionManifestScope = "qualification" | "final";

export type ProductionAnalysisBinding = Readonly<{
  bundleMode: ProductionBundleMode;
  manifestScope: ProductionManifestScope;
  manifestHash: string;
  sourceHash: string;
  solverConfigHash: string;
  modelHash: string;
  protocolHash: string;
  selectedConfigId: ProductionRoleId;
  selectionAttestationHash: string | null;
  finalAttestationHash: string | null;
}>;

export type VerifiedProductionRelease = Readonly<{
  bundle: ExecutableProductionBundle;
  descriptor: ProductionConfigurationDescriptor;
  manifest: QualificationManifestView | FinalManifestView;
  manifestScope: ProductionManifestScope;
  selectionAttestation: SelectionAttestation | null;
  finalAttestation: FinalAttestation | null;
  modelArtifact: ExecutableBehaviorModelArtifact | null;
  modelConfig: Phase8ProductionModelConfig | null;
  binding: ProductionAnalysisBinding;
}>;

export type ExecutableBehaviorModelArtifact =
  Phase8ProductionModelArtifact | Phase8PracticalBehaviorModelArtifact;

export type ProductionReleaseErrorCode =
  | "RELEASE_UNAVAILABLE"
  | "EVALUATION_BUNDLE_FORBIDDEN"
  | "INVALID_RELEASE"
  | "UNSUPPORTED_SELECTED_CONFIGURATION";

export class ProductionReleaseError extends Error {
  readonly code: ProductionReleaseErrorCode;

  constructor(code: ProductionReleaseErrorCode, message: string) {
    super(message);
    this.name = "ProductionReleaseError";
    this.code = code;
  }
}

function invalidRelease(message: string, cause?: unknown): never {
  throw new ProductionReleaseError(
    "INVALID_RELEASE",
    cause instanceof Error ? `${message}: ${cause.message}` : message,
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export async function sha256Utf8(value: string): Promise<string> {
  const cryptoValue = Reflect.get(globalThis, "crypto") as Crypto | undefined;
  const subtle = cryptoValue?.subtle;
  if (subtle === undefined) {
    invalidRelease("Web Crypto SHA-256 is unavailable in this runtime.");
  }
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseCanonicalRaw(
  envelope: ProductionArtifactEnvelope,
  label: string,
): unknown {
  if (byteLength(envelope.bytes) > MAX_RELEASE_ARTIFACT_BYTES) {
    invalidRelease(`${label} exceeds the release artifact byte cap.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(envelope.bytes) as unknown;
  } catch (cause) {
    invalidRelease(`${label} is not valid JSON`, cause);
  }
  const canonical = stableStringify(raw);
  if (envelope.bytes !== canonical && envelope.bytes !== `${canonical}\n`) {
    invalidRelease(
      `${label} bytes are neither canonical JSON nor canonical JSON plus one newline.`,
    );
  }
  return raw;
}

function parseCanonicalJson<T>(
  envelope: ProductionArtifactEnvelope,
  schema: z.ZodType<T>,
  label: string,
): T {
  try {
    return schema.parse(parseCanonicalRaw(envelope, label));
  } catch (cause) {
    invalidRelease(`${label} schema is invalid`, cause);
  }
}

async function verifyEnvelopeHash(
  envelope: ProductionArtifactEnvelope,
  label: string,
): Promise<void> {
  const actual = await sha256Utf8(envelope.bytes);
  if (actual !== envelope.sha256) {
    invalidRelease(`${label} SHA-256 does not match its exact bytes.`);
  }
}

async function expectedAttestationId(
  prefix: "phase8-selection" | "phase8-final",
  value: SelectionAttestation | FinalAttestation,
): Promise<string> {
  const projection = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "attestationId"),
  );
  return `${prefix}-${(await sha256Utf8(stableStringify(projection))).slice(0, 24)}`;
}

function sortedEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    stableStringify([...left].sort()) === stableStringify([...right].sort())
  );
}

function verifySelectionSemantics(value: SelectionAttestation): void {
  if (
    value.referenceConfigId !== "p8-r-hard-balanced-v1" ||
    new Set(value.eligibleConfigIds).size !== value.eligibleConfigIds.length ||
    !value.eligibleConfigIds.includes(value.referenceConfigId) ||
    !value.eligibleConfigIds.includes(value.selectedConfigId) ||
    new Set(value.orderedFallbackConfigIds).size !==
      value.orderedFallbackConfigIds.length ||
    value.orderedFallbackConfigIds.includes(value.selectedConfigId) ||
    value.orderedFallbackConfigIds.some(
      (id) => !value.eligibleConfigIds.includes(id),
    )
  ) {
    invalidRelease("Selection attestation has an invalid eligibility set.");
  }
  if (value.selectionIsReference) {
    if (
      value.selectedConfigId !== value.referenceConfigId ||
      value.selectionMode !== "reference-fallback" ||
      value.finalMode !== "one-arm-reference-confirmation" ||
      !sortedEqual(value.finalConfigIds, [value.referenceConfigId]) ||
      value.orderedFallbackConfigIds.length !== 0
    ) {
      invalidRelease("Reference selection attestation is inconsistent.");
    }
  } else if (
    value.selectedConfigId === value.referenceConfigId ||
    value.selectionMode === "reference-fallback" ||
    value.finalMode !== "paired-selected-vs-reference" ||
    !sortedEqual(value.finalConfigIds, [
      value.referenceConfigId,
      value.selectedConfigId,
    ]) ||
    value.orderedFallbackConfigIds.at(-1) !== value.referenceConfigId
  ) {
    invalidRelease("Candidate selection attestation is inconsistent.");
  }
}

function verifyFinalSemantics(
  finalValue: FinalAttestation,
  selection: SelectionAttestation,
  selectionSha256: string,
): void {
  if (
    finalValue.selectionAttestationId !== selection.attestationId ||
    finalValue.selectionAttestationSha256 !== selectionSha256 ||
    finalValue.qualificationManifestSha256 !== selection.manifestSha256 ||
    finalValue.referenceConfigId !== selection.referenceConfigId ||
    finalValue.selectedConfigId !== selection.selectedConfigId ||
    finalValue.selectionIsReference !== selection.selectionIsReference ||
    finalValue.finalMode !== selection.finalMode ||
    !sortedEqual(finalValue.finalConfigIds, selection.finalConfigIds)
  ) {
    invalidRelease(
      "Final attestation does not bind the supplied selection attestation.",
    );
  }
}

async function verifyDescriptor(
  descriptor: ProductionConfigurationDescriptor,
  modelSha256: string,
  modelConfig: Phase8ProductionModelConfig | null,
  modelArtifact: ExecutableBehaviorModelArtifact | null,
): Promise<void> {
  const projection = Object.fromEntries(
    Object.entries(descriptor).filter(([key]) => key !== "configSha256"),
  );
  if (
    descriptor.configSha256 !== (await sha256Utf8(stableStringify(projection)))
  ) {
    invalidRelease("Configuration descriptor checksum is invalid.");
  }
  const role = descriptor.configId;
  const components = PRODUCTION_ROLE_COMPONENTS[role];
  const expectedRole =
    role === "p8-r-hard-balanced-v1" ? "reference" : "candidate";
  const implementation = descriptor.implementation;
  if (
    descriptor.role !== expectedRole ||
    stableStringify(descriptor.components) !== stableStringify(components) ||
    implementation.routingContract !== PRODUCTION_ROUTING_CONTRACTS[role] ||
    implementation.fallbackConfigId !== PRODUCTION_ROLE_FALLBACKS[role] ||
    isExactProductionRole(role) !== (implementation.exactConfigHash !== null)
  ) {
    invalidRelease(
      "Configuration descriptor does not implement its frozen selected role.",
    );
  }
  if (isBehaviorProductionRole(role)) {
    if (modelArtifact === null || modelConfig === null) {
      invalidRelease("Behavior descriptor has no fitted production model.");
    }
    if (
      implementation.behaviorFailurePolicy !== "refuse" ||
      implementation.productionModelSha256 !== modelSha256 ||
      implementation.modelSelectionContractHash !==
        modelArtifact.payload.modelSelectionContractHash ||
      !implementation.separateOpponentPriors ||
      implementation.behaviorWorldCount !== modelConfig.worldCount ||
      implementation.robustChoice !== modelConfig.robustChoice
    ) {
      invalidRelease(
        "Behavior descriptor does not bind the supplied production model.",
      );
    }
    if (modelConfig.robustChoice) {
      throw new ProductionReleaseError(
        "UNSUPPORTED_SELECTED_CONFIGURATION",
        "Selected robust-choice is enabled but has no executable production route.",
      );
    }
  } else if (
    implementation.behaviorFailurePolicy !== "not-applicable" ||
    implementation.productionModelSha256 !== null ||
    implementation.modelSelectionContractHash !== null ||
    implementation.separateOpponentPriors ||
    implementation.behaviorWorldCount !== null ||
    implementation.robustChoice !== null
  ) {
    invalidRelease(
      "Non-behavior descriptor contains behavior-only implementation fields.",
    );
  }
}

async function verifyManifestRegistry(input: {
  readonly manifest: QualificationManifestView | FinalManifestView;
  readonly descriptor: ProductionConfigurationDescriptor;
  readonly bundle: ExecutableProductionBundle;
}): Promise<void> {
  if (
    input.manifest.hashes.sourceSha256 !== input.bundle.sourceHash ||
    input.manifest.hashes.modelSha256 !== input.bundle.productionModel.sha256 ||
    input.manifest.hashes.configSha256 !==
      (await sha256Utf8(stableStringify(input.manifest.configurations)))
  ) {
    invalidRelease(
      "Manifest source, model, or configuration-registry hash is inconsistent.",
    );
  }
  const bound = input.manifest.configurations.find(
    (candidate) => candidate.configId === input.descriptor.configId,
  );
  if (
    bound === undefined ||
    stableStringify(bound) !== stableStringify(input.descriptor)
  ) {
    invalidRelease(
      "Exact configuration descriptor bytes are not represented by the manifest registry.",
    );
  }
}

function verifyFinalManifestSelection(manifest: FinalManifestView): void {
  const selection = manifest.selection;
  const ids = manifest.configurations.map((descriptor) => descriptor.configId);
  if (
    manifest.qualificationManifestId !== selection.qualificationManifestId ||
    manifest.qualificationManifestSha256 !==
      selection.qualificationManifestSha256 ||
    stableStringify(ids) !== stableStringify(selection.finalConfigIds)
  ) {
    invalidRelease("Final manifest selection registry is inconsistent.");
  }
  if (selection.selectionIsReference) {
    if (
      selection.selectedConfigId !== selection.referenceConfigId ||
      selection.finalMode !== "one-arm-reference-confirmation" ||
      !sortedEqual(selection.finalConfigIds, [selection.referenceConfigId])
    ) {
      invalidRelease("Reference-selected final manifest is inconsistent.");
    }
  } else if (
    selection.selectedConfigId === selection.referenceConfigId ||
    selection.finalMode !== "paired-selected-vs-reference" ||
    !sortedEqual(selection.finalConfigIds, [
      selection.referenceConfigId,
      selection.selectedConfigId,
    ])
  ) {
    invalidRelease("Candidate-selected final manifest is inconsistent.");
  }
}

function parseExecutionModel(
  bundle: ExecutableProductionBundle,
  descriptor: ProductionConfigurationDescriptor,
): {
  readonly artifact: ExecutableBehaviorModelArtifact | null;
  readonly config: Phase8ProductionModelConfig | null;
} {
  if (!isBehaviorProductionRole(descriptor.configId)) {
    try {
      const marker = parsePhase8HardOnlyModel(bundle.productionModel.bytes);
      if (
        serializePhase8HardOnlyModel(marker) !== bundle.productionModel.bytes ||
        marker.sourceSha256 !== bundle.sourceHash
      ) {
        invalidRelease(
          "Hard-only model-not-applicable bytes do not bind this source.",
        );
      }
    } catch (cause) {
      invalidRelease(
        "Hard-only model-not-applicable verification failed",
        cause,
      );
    }
    return { artifact: null, config: null };
  }
  let artifact: ExecutableBehaviorModelArtifact;
  let config: Phase8ProductionModelConfig;
  try {
    artifact = parsePhase8ProductionModelArtifact(bundle.productionModel.bytes);
    if (
      serializePhase8ProductionModelArtifact(artifact) !==
      bundle.productionModel.bytes
    ) {
      invalidRelease("Production model bytes are not canonical.");
    }
    config = phase8ProductionModelConfig(artifact);
  } catch (sealedCause) {
    if (bundle.mode !== "evaluation-only") {
      invalidRelease("Production model verification failed", sealedCause);
    }
    try {
      const practical = parsePhase8PracticalBehaviorModelArtifact(
        bundle.productionModel.bytes,
      );
      if (
        serializePhase8PracticalBehaviorModelArtifact(practical) !==
        bundle.productionModel.bytes
      ) {
        invalidRelease("Practical behavior model bytes are not canonical.");
      }
      artifact = practical;
      config = phase8PracticalBehaviorModelConfig(practical);
    } catch (practicalCause) {
      invalidRelease(
        "Evaluation behavior model verification failed",
        new AggregateError([sealedCause, practicalCause]),
      );
    }
  }
  if (artifact.payload.behavior.payload.sourceHash !== bundle.sourceHash) {
    invalidRelease(
      "Production model and execution bundle bind different source snapshots.",
    );
  }
  return {
    artifact,
    config,
  };
}

async function executableCore(bundle: ExecutableProductionBundle): Promise<{
  readonly descriptor: ProductionConfigurationDescriptor;
  readonly modelArtifact: ExecutableBehaviorModelArtifact | null;
  readonly modelConfig: Phase8ProductionModelConfig | null;
}> {
  await Promise.all([
    verifyEnvelopeHash(bundle.manifest, "Evaluation manifest"),
    verifyEnvelopeHash(bundle.descriptor, "Configuration descriptor"),
    verifyEnvelopeHash(bundle.productionModel, "Production model"),
  ]);
  const descriptor = parseCanonicalJson(
    bundle.descriptor,
    productionDescriptorSchema,
    "Configuration descriptor",
  );
  const model = parseExecutionModel(bundle, descriptor);
  await verifyDescriptor(
    descriptor,
    bundle.productionModel.sha256,
    model.config,
    model.artifact,
  );
  return {
    descriptor,
    modelArtifact: model.artifact,
    modelConfig: model.config,
  };
}

function verifiedResult(input: {
  readonly bundle: ExecutableProductionBundle;
  readonly descriptor: ProductionConfigurationDescriptor;
  readonly manifest: QualificationManifestView | FinalManifestView;
  readonly manifestScope: ProductionManifestScope;
  readonly selectionAttestation: SelectionAttestation | null;
  readonly finalAttestation: FinalAttestation | null;
  readonly modelArtifact: ExecutableBehaviorModelArtifact | null;
  readonly modelConfig: Phase8ProductionModelConfig | null;
}): VerifiedProductionRelease {
  const selectionHash =
    input.bundle.mode === "release-selected"
      ? input.bundle.selectionAttestation.sha256
      : null;
  const finalHash =
    input.bundle.mode === "release-selected"
      ? input.bundle.finalAttestation.sha256
      : null;
  return Object.freeze({
    ...input,
    binding: Object.freeze({
      bundleMode: input.bundle.mode,
      manifestScope: input.manifestScope,
      manifestHash: input.bundle.manifest.sha256,
      sourceHash: input.bundle.sourceHash,
      solverConfigHash: input.descriptor.configSha256,
      modelHash: input.bundle.productionModel.sha256,
      protocolHash: input.bundle.protocolHash,
      selectedConfigId: input.descriptor.configId,
      selectionAttestationHash: selectionHash,
      finalAttestationHash: finalHash,
    }),
  });
}

async function verifyEvaluationBundle(
  bundle: EvaluationProductionBundle,
): Promise<VerifiedProductionRelease> {
  const core = await executableCore(bundle);
  if (bundle.scope === "qualification") {
    const manifest = qualificationManifestViewSchema.parse(
      parseCanonicalRaw(bundle.manifest, "Qualification manifest"),
    );
    await verifyManifestRegistry({
      manifest,
      descriptor: core.descriptor,
      bundle,
    });
    return verifiedResult({
      bundle,
      descriptor: core.descriptor,
      manifest,
      manifestScope: "qualification",
      selectionAttestation: null,
      finalAttestation: null,
      modelArtifact: core.modelArtifact,
      modelConfig: core.modelConfig,
    });
  }
  const manifest = finalManifestViewSchema.parse(
    parseCanonicalRaw(bundle.manifest, "Final manifest"),
  );
  verifyFinalManifestSelection(manifest);
  await verifyManifestRegistry({
    manifest,
    descriptor: core.descriptor,
    bundle,
  });
  return verifiedResult({
    bundle,
    descriptor: core.descriptor,
    manifest,
    manifestScope: "final",
    selectionAttestation: null,
    finalAttestation: null,
    modelArtifact: core.modelArtifact,
    modelConfig: core.modelConfig,
  });
}

async function verifySelectedBundle(
  bundle: SelectedProductionReleaseBundle,
): Promise<VerifiedProductionRelease> {
  const core = await executableCore(bundle);
  await Promise.all([
    verifyEnvelopeHash(bundle.selectionAttestation, "Selection attestation"),
    verifyEnvelopeHash(bundle.finalAttestation, "Final attestation"),
  ]);
  const manifest = finalManifestViewSchema.parse(
    parseCanonicalRaw(bundle.manifest, "Final manifest"),
  );
  const selection = parseCanonicalJson(
    bundle.selectionAttestation,
    selectionAttestationSchema,
    "Selection attestation",
  );
  const finalValue = parseCanonicalJson(
    bundle.finalAttestation,
    finalAttestationSchema,
    "Final attestation",
  );
  verifyFinalManifestSelection(manifest);
  await verifyManifestRegistry({
    manifest,
    descriptor: core.descriptor,
    bundle,
  });
  if (
    selection.attestationId !==
      (await expectedAttestationId("phase8-selection", selection)) ||
    finalValue.attestationId !==
      (await expectedAttestationId("phase8-final", finalValue))
  ) {
    invalidRelease("Selection or final attestation ID is invalid.");
  }
  verifySelectionSemantics(selection);
  verifyFinalSemantics(
    finalValue,
    selection,
    bundle.selectionAttestation.sha256,
  );
  if (
    finalValue.manifestId !== manifest.manifestId ||
    finalValue.manifestSha256 !== bundle.manifest.sha256 ||
    finalValue.qualificationManifestId !== manifest.qualificationManifestId ||
    finalValue.qualificationManifestSha256 !==
      manifest.qualificationManifestSha256 ||
    manifest.selection.selectionAttestationId !== selection.attestationId ||
    manifest.selection.selectionAttestationSha256 !==
      bundle.selectionAttestation.sha256 ||
    selection.manifestId !== manifest.qualificationManifestId ||
    selection.manifestSha256 !== manifest.qualificationManifestSha256 ||
    core.descriptor.configId !== selection.selectedConfigId ||
    core.descriptor.configId !== finalValue.selectedConfigId ||
    core.descriptor.configId !== manifest.selection.selectedConfigId ||
    !sortedEqual(finalValue.finalConfigIds, manifest.selection.finalConfigIds)
  ) {
    invalidRelease(
      "Selected release does not cross-link its final manifest, selection, final attestation, and descriptor.",
    );
  }
  return verifiedResult({
    bundle,
    descriptor: core.descriptor,
    manifest,
    manifestScope: "final",
    selectionAttestation: selection,
    finalAttestation: finalValue,
    modelArtifact: core.modelArtifact,
    modelConfig: core.modelConfig,
  });
}

export type VerifyProductionReleaseOptions = Readonly<{
  allowEvaluationOnly?: boolean;
}>;

/**
 * Browser-safe verification boundary. Evaluation bundles require an explicit
 * opt-in; the default used by the live app accepts only release-selected.
 */
export async function verifyProductionReleaseBundle(
  value: unknown,
  options: VerifyProductionReleaseOptions = {},
): Promise<VerifiedProductionRelease> {
  let bundle: ProductionReleaseBundle;
  try {
    bundle = productionReleaseBundleSchema.parse(value);
  } catch (cause) {
    invalidRelease("Production execution bundle schema is invalid", cause);
  }
  if (bundle.mode === "unselected") {
    throw new ProductionReleaseError(
      "RELEASE_UNAVAILABLE",
      `No selected Phase 8 production release is compiled (${bundle.reason}).`,
    );
  }
  if (bundle.mode === "evaluation-only") {
    if (options.allowEvaluationOnly !== true) {
      throw new ProductionReleaseError(
        "EVALUATION_BUNDLE_FORBIDDEN",
        "The live production verifier refuses evaluation-only bundles.",
      );
    }
    return verifyEvaluationBundle(bundle);
  }
  return verifySelectedBundle(bundle);
}
