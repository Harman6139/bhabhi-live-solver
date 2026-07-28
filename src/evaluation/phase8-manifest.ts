import { createHash } from "node:crypto";

import { z } from "zod";

import { FITTABLE_STYLE_CELL_IDS } from "../calibration/protocol";
import {
  CANONICAL_RULES,
  ruleConfigSchema,
  type RuleConfig,
} from "../domain/rule-config";
import { stableStringify } from "../events/stable-hash";
import { RNG_ALGORITHM } from "../random/keyed-rng";
import {
  EVALUATION_PROTOCOL_ID,
  STYLE_CELLS,
  type EvaluationSplit,
} from "./protocol";
import {
  PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA,
  PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_CONTRACT,
  PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_VERSION,
  computePhase8TerminalSampleSize,
  type Phase8TerminalSampleSize,
} from "./phase8-sample-size";

export const PHASE8_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PHASE8_MANIFEST_VERSION = "phase8-evaluation-manifest-v1" as const;
export const PHASE8_MANIFEST_AUTHORITY_ARTIFACT_VERSION =
  "phase8-manifest-authority-artifact-v1" as const;
export const PHASE8_SPLIT_OPENING_ARTIFACT_VERSION =
  "phase8-split-opening-artifact-v1" as const;
export const PHASE8_MAX_CONFIGURATIONS = 4 as const;
export const PHASE8_CONFIGURATION_ROLE_IDS = [
  "p8-r-hard-balanced-v1",
  "p8-e-exact-hard-fallback-v1",
  "p8-b-behavior-balanced-v1",
  "p8-be-behavior-exact-fallback-v1",
] as const;
export type Phase8ConfigurationRoleId =
  (typeof PHASE8_CONFIGURATION_ROLE_IDS)[number];
export const PHASE8_BOOTSTRAP_RESAMPLES = 20_000 as const;
export const PHASE8_STYLE_CELL_COUNT = 17 as const;
export const PHASE8_ROTATIONS = [0, 1, 2] as const;
export const PHASE8_SPLITS = ["train", "tune", "qualification"] as const;
export const PHASE8_PLAN_SPLITS = [...PHASE8_SPLITS, "final"] as const;
export const PHASE8_CONFIRMATORY_SPLITS = ["qualification", "final"] as const;
export const PHASE8_SEED_STREAMS = [
  "deal",
  "user-policy",
  "p2-policy",
  "p3-policy",
  "chance",
  "solver-chance",
  "belief",
  "search",
  "rollout",
  "bootstrap",
] as const;

export type Phase8Split = (typeof PHASE8_SPLITS)[number];
export type Phase8PlanSplit = (typeof PHASE8_PLAN_SPLITS)[number];
export type Phase8ConfirmatorySplit =
  (typeof PHASE8_CONFIRMATORY_SPLITS)[number];
export type Phase8SeedStream = (typeof PHASE8_SEED_STREAMS)[number];
export type Phase8Json =
  | null
  | boolean
  | number
  | string
  | readonly Phase8Json[]
  | { readonly [key: string]: Phase8Json };

const identifierSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const positiveIntegerSchema = z.int().positive();
const nonnegativeIntegerSchema = z.int().nonnegative();
const phase8JsonSchema: z.ZodType<Phase8Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(phase8JsonSchema),
    z.record(z.string(), phase8JsonSchema),
  ]),
);

const configurationComponentsSchema = z
  .object({
    exactEndgame: z.boolean(),
    behaviorWeighting: z.boolean(),
  })
  .strict();

type Phase8ConfigurationRoleContract = Readonly<{
  role: "reference" | "candidate";
  budgetId: "balanced";
  components: Readonly<{
    exactEndgame: boolean;
    behaviorWeighting: boolean;
  }>;
}>;

const PHASE8_CONFIGURATION_ROLE_CONTRACTS: Readonly<
  Record<Phase8ConfigurationRoleId, Phase8ConfigurationRoleContract>
> = Object.freeze({
  "p8-r-hard-balanced-v1": Object.freeze({
    role: "reference",
    budgetId: "balanced",
    components: Object.freeze({
      exactEndgame: false,
      behaviorWeighting: false,
    }),
  }),
  "p8-e-exact-hard-fallback-v1": Object.freeze({
    role: "candidate",
    budgetId: "balanced",
    components: Object.freeze({
      exactEndgame: true,
      behaviorWeighting: false,
    }),
  }),
  "p8-b-behavior-balanced-v1": Object.freeze({
    role: "candidate",
    budgetId: "balanced",
    components: Object.freeze({
      exactEndgame: false,
      behaviorWeighting: true,
    }),
  }),
  "p8-be-behavior-exact-fallback-v1": Object.freeze({
    role: "candidate",
    budgetId: "balanced",
    components: Object.freeze({
      exactEndgame: true,
      behaviorWeighting: true,
    }),
  }),
});

const configurationDescriptorBaseSchema = z
  .object({
    configId: z.enum(PHASE8_CONFIGURATION_ROLE_IDS),
    label: identifierSchema,
    role: z.enum(["reference", "candidate"]),
    budgetId: z.enum(["instant", "balanced", "deep", "offline"]),
    components: configurationComponentsSchema,
    implementation: z.record(z.string(), phase8JsonSchema),
    configSha256: sha256Schema,
  })
  .strict();

export type Phase8ConfigurationDescriptor = z.infer<
  typeof configurationDescriptorBaseSchema
>;

function configurationProjection(
  value: Omit<Phase8ConfigurationDescriptor, "configSha256">,
): unknown {
  return {
    configId: value.configId,
    label: value.label,
    role: value.role,
    budgetId: value.budgetId,
    components: value.components,
    implementation: value.implementation,
  };
}

export function phase8Sha256(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value), "utf8")
    .digest("hex");
}

export function phase8ConfigurationSha256(
  value: Omit<Phase8ConfigurationDescriptor, "configSha256">,
): string {
  return phase8Sha256(configurationProjection(value));
}

export const phase8ConfigurationDescriptorSchema =
  configurationDescriptorBaseSchema.superRefine((value, context) => {
    const roleContract = PHASE8_CONFIGURATION_ROLE_CONTRACTS[value.configId];
    if (
      value.role !== roleContract.role ||
      value.budgetId !== roleContract.budgetId ||
      stableStringify(value.components) !==
        stableStringify(roleContract.components)
    ) {
      context.addIssue({
        code: "custom",
        path: ["configId"],
        message:
          "Configuration does not match its frozen ADR 0007 role, budget, and component matrix.",
      });
    }
    const expected = phase8ConfigurationSha256(value);
    if (value.configSha256 !== expected) {
      context.addIssue({
        code: "custom",
        path: ["configSha256"],
        message: "Configuration hash does not match its canonical descriptor.",
      });
    }
  });

export function createPhase8ConfigurationDescriptor(
  value: Omit<Phase8ConfigurationDescriptor, "configSha256">,
): Phase8ConfigurationDescriptor {
  return phase8ConfigurationDescriptorSchema.parse({
    ...value,
    configSha256: phase8ConfigurationSha256(value),
  });
}

const styleCellSchema = z
  .object({
    id: identifierSchema,
    p2: identifierSchema,
    p3: identifierSchema,
  })
  .strict();

export const phase8SplitPlanSchema = z
  .object({
    split: z.enum(PHASE8_PLAN_SPLITS),
    baseIndexStart: nonnegativeIntegerSchema,
    baseCount: positiveIntegerSchema.max(512),
    rotations: z.tuple([z.literal(0), z.literal(1), z.literal(2)]),
    replicates: z.tuple([z.literal(0)]),
    styleCellIds: z
      .array(identifierSchema)
      .min(FITTABLE_STYLE_CELL_IDS.length)
      .max(PHASE8_STYLE_CELL_COUNT),
    eventCap: positiveIntegerSchema,
  })
  .strict();
export type Phase8SplitPlan = z.infer<typeof phase8SplitPlanSchema>;

export const phase8HashBundleSchema = z
  .object({
    sourceSha256: sha256Schema,
    rulesSha256: sha256Schema,
    configSha256: sha256Schema,
    modelSha256: sha256Schema,
    scorerSha256: sha256Schema,
    reportSha256: sha256Schema,
    preregistrationSha256: sha256Schema,
  })
  .strict();
export type Phase8HashBundle = z.infer<typeof phase8HashBundleSchema>;

const qualificationSampleSizeBaseSchema = z
  .object({
    formulaVersion: z.literal(PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_VERSION),
    formula: z.literal(PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA),
    formulaSha256: sha256Schema,
    verifiedDevelopmentVarianceArtifactSha256: sha256Schema,
    maxPairedClusterStandardDeviation: z.number().min(0),
    rawBaseCount: z.number().min(0),
    blockRoundedBaseCount: z.int().nonnegative(),
    baseCount: z.int().min(64).max(512),
    minimumApplied: z.boolean(),
    maximumApplied: z.boolean(),
  })
  .strict();
export type Phase8QualificationSampleSizeBinding = z.infer<
  typeof qualificationSampleSizeBaseSchema
>;

const selectionPolicySchema = z
  .object({
    primaryMetric: z.literal("user-bhabhi-rate-candidate-minus-reference"),
    terminalNoninferiorityMargin: z.literal(0.005),
    terminalImprovementThreshold: z.literal(0),
    practicalTieMargin: z.literal(0.0025),
    catastrophicStylePointThreshold: z.literal(0.05),
    catastrophicStyleLowerThreshold: z.literal(0.02),
    confidenceLevel: z.literal(0.95),
    bootstrapResamples: z.literal(PHASE8_BOOTSTRAP_RESAMPLES),
    multiplicityMethod: z.literal(
      "crossed-paired-cluster-bootstrap-max-statistic",
    ),
    clusterDefinition: z.literal(
      "baseIndex-keeps-all-17-style-cells-and-3-rotations",
    ),
    finalReferenceRule: z.literal(
      "reference-selection-requires-one-arm-final-confirmation",
    ),
    finalBeatsRule: z.literal(
      "untouched-final-two-sided-upper-strictly-below-zero",
    ),
  })
  .strict();

const manifestBaseSchema = z
  .object({
    schemaVersion: z.literal(PHASE8_MANIFEST_SCHEMA_VERSION),
    protocolId: z.literal(EVALUATION_PROTOCOL_ID),
    manifestVersion: z.literal(PHASE8_MANIFEST_VERSION),
    manifestId: identifierSchema,
    status: z.literal("frozen"),
    createdAt: z.iso.datetime(),
    sourceFileCount: positiveIntegerSchema,
    ruleProfileId: z.literal("canonical-v1"),
    rules: ruleConfigSchema,
    styleCells: z.array(styleCellSchema).length(PHASE8_STYLE_CELL_COUNT),
    configurations: z
      .array(phase8ConfigurationDescriptorSchema)
      .min(1)
      .max(PHASE8_MAX_CONFIGURATIONS),
    splits: z
      .object({
        train: phase8SplitPlanSchema,
        tune: phase8SplitPlanSchema,
        qualification: phase8SplitPlanSchema,
      })
      .strict(),
    qualificationSampleSize: qualificationSampleSizeBaseSchema,
    hashes: phase8HashBundleSchema,
    rngAlgorithm: z.literal(RNG_ALGORITHM),
    seedPolicyId: z.literal("phase8-sealed-split-disclosure-sha256-v1"),
    selectionPolicy: selectionPolicySchema,
  })
  .strict();

export type Phase8Manifest = z.infer<typeof manifestBaseSchema>;

function canonicalStyleCells(): Phase8Manifest["styleCells"] {
  return STYLE_CELLS.map((cell) => ({
    id: cell.id,
    p2: cell.p2,
    p3: cell.p3,
  }));
}

function canonicalStyleCellIds(): string[] {
  return STYLE_CELLS.map((cell) => cell.id);
}

function fittableStyleCellIds(): string[] {
  return [...FITTABLE_STYLE_CELL_IDS];
}

function canonicalConfigurations(
  configurations: readonly Phase8ConfigurationDescriptor[],
): Phase8ConfigurationDescriptor[] {
  const roleOrder = new Map(
    PHASE8_CONFIGURATION_ROLE_IDS.map((configId, index) => [configId, index]),
  );
  return [...configurations].sort(
    (left, right) =>
      (roleOrder.get(left.configId) ?? Number.POSITIVE_INFINITY) -
      (roleOrder.get(right.configId) ?? Number.POSITIVE_INFINITY),
  );
}

function phase8TerminalSampleSizeFormulaSha256(): string {
  return phase8Sha256(PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_CONTRACT);
}

function qualificationSampleSizeBinding(
  verifiedDevelopmentVarianceArtifactSha256: string,
  value: Phase8TerminalSampleSize,
): Phase8QualificationSampleSizeBinding {
  return {
    formulaVersion: PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA_VERSION,
    formula: PHASE8_TERMINAL_SAMPLE_SIZE_FORMULA,
    formulaSha256: phase8TerminalSampleSizeFormulaSha256(),
    verifiedDevelopmentVarianceArtifactSha256,
    ...value,
  };
}

function addManifestContractIssues(
  value: Phase8Manifest,
  context: z.RefinementCtx,
): void {
  if (stableStringify(value.rules) !== stableStringify(CANONICAL_RULES)) {
    context.addIssue({
      code: "custom",
      path: ["rules"],
      message: "Phase 8 confirmatory evaluation requires canonical rules.",
    });
  }
  const expectedCells = canonicalStyleCells();
  if (stableStringify(value.styleCells) !== stableStringify(expectedCells)) {
    context.addIssue({
      code: "custom",
      path: ["styleCells"],
      message: "Phase 8 requires the frozen ordered 17-cell style suite.",
    });
  }
  const configIds = value.configurations.map(
    (configuration) => configuration.configId,
  );
  if (new Set(configIds).size !== configIds.length) {
    context.addIssue({
      code: "custom",
      path: ["configurations"],
      message: "Phase 8 configuration IDs must be unique.",
    });
  }
  const referenceCount = value.configurations.filter(
    (configuration) => configuration.role === "reference",
  ).length;
  if (referenceCount !== 1) {
    context.addIssue({
      code: "custom",
      path: ["configurations"],
      message: "Phase 8 requires exactly one reference configuration.",
    });
  }
  if (value.configurations[0]?.configId !== PHASE8_CONFIGURATION_ROLE_IDS[0]) {
    context.addIssue({
      code: "custom",
      path: ["configurations"],
      message:
        "Phase 8 requires the frozen p8-r-hard-balanced-v1 reference role.",
    });
  }
  if (
    stableStringify(value.configurations) !==
    stableStringify(canonicalConfigurations(value.configurations))
  ) {
    context.addIssue({
      code: "custom",
      path: ["configurations"],
      message:
        "Phase 8 configurations must use canonical reference-first ID order.",
    });
  }
  const allCellIds = canonicalStyleCellIds();
  const fitCellIds = fittableStyleCellIds();
  for (const split of PHASE8_SPLITS) {
    const plan = value.splits[split];
    if (plan.split !== split) {
      context.addIssue({
        code: "custom",
        path: ["splits", split, "split"],
        message: `Split plan key ${split} does not match its split value.`,
      });
    }
    const expectedCellIds = split === "qualification" ? allCellIds : fitCellIds;
    if (
      stableStringify(plan.styleCellIds) !== stableStringify(expectedCellIds)
    ) {
      context.addIssue({
        code: "custom",
        path: ["splits", split, "styleCellIds"],
        message:
          split === "qualification"
            ? "Qualification must use the frozen 17-cell suite."
            : `${split} must use the 15 fittable cells and exclude c16/c17.`,
      });
    }
    if (plan.baseIndexStart !== 0) {
      context.addIssue({
        code: "custom",
        path: ["splits", split, "baseIndexStart"],
        message:
          "Each namespaced Phase 8 split must begin at baseIndexStart 0.",
      });
    }
    if (
      split === "qualification" &&
      (plan.baseCount < 64 || plan.baseCount % 16 !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["splits", split, "baseCount"],
        message:
          "Confirmatory Phase 8 base counts must be 64..512 in blocks of 16.",
      });
    }
  }
  const expectedQualificationSampleSize = qualificationSampleSizeBinding(
    value.qualificationSampleSize.verifiedDevelopmentVarianceArtifactSha256,
    computePhase8TerminalSampleSize(
      value.qualificationSampleSize.maxPairedClusterStandardDeviation,
    ),
  );
  if (
    stableStringify(value.qualificationSampleSize) !==
      stableStringify(expectedQualificationSampleSize) ||
    value.splits.qualification.baseCount !==
      value.qualificationSampleSize.baseCount
  ) {
    context.addIssue({
      code: "custom",
      path: ["qualificationSampleSize"],
      message:
        "Qualification N must derive from the verified development variance and frozen sizing formula.",
    });
  }
  const expectedRulesHash = phase8Sha256(value.rules);
  if (value.hashes.rulesSha256 !== expectedRulesHash) {
    context.addIssue({
      code: "custom",
      path: ["hashes", "rulesSha256"],
      message: "Rules hash does not match the frozen rules.",
    });
  }
  const expectedConfigHash = phase8Sha256(value.configurations);
  if (value.hashes.configSha256 !== expectedConfigHash) {
    context.addIssue({
      code: "custom",
      path: ["hashes", "configSha256"],
      message: "Configuration-registry hash does not match its descriptors.",
    });
  }
}

export const phase8ManifestSchema = manifestBaseSchema.superRefine(
  addManifestContractIssues,
);

const manifestAuthorityArtifactRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactVersion: z.literal(PHASE8_MANIFEST_AUTHORITY_ARTIFACT_VERSION),
    manifestSha256: sha256Schema,
    manifest: phase8ManifestSchema,
  })
  .strict();
type Phase8ManifestAuthorityArtifactRecord = z.infer<
  typeof manifestAuthorityArtifactRecordSchema
>;

export type Phase8ManifestAuthorityArtifact = Readonly<{
  fileName: string;
  payload: string;
  payloadSha256: string;
  checksumLine: string;
}>;

export type Phase8ManifestDraft = {
  readonly manifestId: string;
  readonly createdAt: string;
  readonly sourceSha256: string;
  readonly sourceFileCount: number;
  readonly modelSha256: string;
  readonly scorerSha256: string;
  readonly reportSha256: string;
  readonly preregistrationSha256: string;
  readonly configurations: readonly Phase8ConfigurationDescriptor[];
  readonly splits: Readonly<{
    readonly train: {
      readonly baseIndexStart: number;
      readonly baseCount: number;
      readonly eventCap: number;
    };
    readonly tune: {
      readonly baseIndexStart: number;
      readonly baseCount: number;
      readonly eventCap: number;
    };
    readonly qualification: {
      readonly baseIndexStart: number;
      readonly eventCap: number;
    };
  }>;
  readonly qualificationSampleSize: {
    readonly verifiedDevelopmentVarianceArtifactSha256: string;
    readonly maxPairedClusterStandardDeviation: number;
  };
};

const FROZEN_MANIFEST_AUTHORITY = Symbol("phase8-frozen-manifest-authority");
const SPLIT_OPENING_AUTHORITY = Symbol("phase8-split-opening-authority");

export type FrozenPhase8ManifestAuthority = Readonly<{
  manifest: Phase8Manifest;
  manifestSha256: string;
  [FROZEN_MANIFEST_AUTHORITY]: true;
}>;

export type Phase8SplitOpening = Readonly<{
  schemaVersion: 1;
  protocolId: typeof EVALUATION_PROTOCOL_ID;
  manifestId: string;
  manifestSha256: string;
  split: Phase8Split;
  splitPlanSha256: string;
  seedDisclosureAuthorized: true;
  authorizationKind: "development" | "qualification";
  authorizationSha256: string;
  openingSha256: string;
  [SPLIT_OPENING_AUTHORITY]: true;
}>;

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

function splitPlan(
  split: Phase8Split,
  input: {
    readonly baseIndexStart: number;
    readonly baseCount: number;
    readonly eventCap: number;
  },
): Phase8SplitPlan {
  return {
    split,
    baseIndexStart: input.baseIndexStart,
    baseCount: input.baseCount,
    rotations: [...PHASE8_ROTATIONS],
    replicates: [0],
    styleCellIds:
      split === "qualification"
        ? canonicalStyleCellIds()
        : fittableStyleCellIds(),
    eventCap: input.eventCap,
  };
}

export function freezePhase8Manifest(
  draft: Phase8ManifestDraft,
): FrozenPhase8ManifestAuthority {
  const configurations = canonicalConfigurations(
    draft.configurations.map((configuration) =>
      phase8ConfigurationDescriptorSchema.parse(configuration),
    ),
  );
  const rules: RuleConfig = structuredClone(CANONICAL_RULES);
  const qualificationSampleSize = qualificationSampleSizeBinding(
    draft.qualificationSampleSize.verifiedDevelopmentVarianceArtifactSha256,
    computePhase8TerminalSampleSize(
      draft.qualificationSampleSize.maxPairedClusterStandardDeviation,
    ),
  );
  const manifest = phase8ManifestSchema.parse({
    schemaVersion: PHASE8_MANIFEST_SCHEMA_VERSION,
    protocolId: EVALUATION_PROTOCOL_ID,
    manifestVersion: PHASE8_MANIFEST_VERSION,
    manifestId: draft.manifestId,
    status: "frozen",
    createdAt: draft.createdAt,
    sourceFileCount: draft.sourceFileCount,
    ruleProfileId: "canonical-v1",
    rules,
    styleCells: canonicalStyleCells(),
    configurations,
    splits: {
      train: splitPlan("train", draft.splits.train),
      tune: splitPlan("tune", draft.splits.tune),
      qualification: splitPlan("qualification", {
        ...draft.splits.qualification,
        baseCount: qualificationSampleSize.baseCount,
      }),
    },
    qualificationSampleSize,
    hashes: {
      sourceSha256: draft.sourceSha256,
      rulesSha256: phase8Sha256(rules),
      configSha256: phase8Sha256(configurations),
      modelSha256: draft.modelSha256,
      scorerSha256: draft.scorerSha256,
      reportSha256: draft.reportSha256,
      preregistrationSha256: draft.preregistrationSha256,
    },
    rngAlgorithm: RNG_ALGORITHM,
    seedPolicyId: "phase8-sealed-split-disclosure-sha256-v1",
    selectionPolicy: {
      primaryMetric: "user-bhabhi-rate-candidate-minus-reference",
      terminalNoninferiorityMargin: 0.005,
      terminalImprovementThreshold: 0,
      practicalTieMargin: 0.0025,
      catastrophicStylePointThreshold: 0.05,
      catastrophicStyleLowerThreshold: 0.02,
      confidenceLevel: 0.95,
      bootstrapResamples: PHASE8_BOOTSTRAP_RESAMPLES,
      multiplicityMethod: "crossed-paired-cluster-bootstrap-max-statistic",
      clusterDefinition: "baseIndex-keeps-all-17-style-cells-and-3-rotations",
      finalReferenceRule:
        "reference-selection-requires-one-arm-final-confirmation",
      finalBeatsRule: "untouched-final-two-sided-upper-strictly-below-zero",
    },
  });
  const frozenManifest = deepFreeze(manifest);
  return deepFreeze({
    manifest: frozenManifest,
    manifestSha256: phase8Sha256(frozenManifest),
    [FROZEN_MANIFEST_AUTHORITY]: true as const,
  });
}

function assertFrozenAuthority(authority: FrozenPhase8ManifestAuthority): void {
  if (
    !hasTrueBrand(authority, FROZEN_MANIFEST_AUTHORITY) ||
    !Object.isFrozen(authority) ||
    !Object.isFrozen(authority.manifest)
  ) {
    throw new Error("A genuine frozen Phase 8 manifest authority is required.");
  }
  phase8ManifestSchema.parse(authority.manifest);
  if (authority.manifestSha256 !== phase8Sha256(authority.manifest)) {
    throw new Error("Frozen Phase 8 manifest integrity check failed.");
  }
}

function parseJsonPayload(payload: string, label: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function manifestAuthorityArtifactRecord(
  authority: FrozenPhase8ManifestAuthority,
): Phase8ManifestAuthorityArtifactRecord {
  assertFrozenAuthority(authority);
  return {
    schemaVersion: 1,
    artifactVersion: PHASE8_MANIFEST_AUTHORITY_ARTIFACT_VERSION,
    manifestSha256: authority.manifestSha256,
    manifest: authority.manifest,
  };
}

export function serializePhase8ManifestAuthority(
  authority: FrozenPhase8ManifestAuthority,
): string {
  return `${stableStringify(manifestAuthorityArtifactRecord(authority))}\n`;
}

export function parseAndRehydratePhase8ManifestAuthority(
  payload: string,
): FrozenPhase8ManifestAuthority {
  const record = manifestAuthorityArtifactRecordSchema.parse(
    parseJsonPayload(payload, "Phase 8 manifest authority artifact"),
  );
  if (payload !== `${stableStringify(record)}\n`) {
    throw new Error(
      "Phase 8 manifest authority artifact is not byte-identical canonical JSON.",
    );
  }
  const manifest = record.manifest;
  const rebuilt = freezePhase8Manifest({
    manifestId: manifest.manifestId,
    createdAt: manifest.createdAt,
    sourceSha256: manifest.hashes.sourceSha256,
    sourceFileCount: manifest.sourceFileCount,
    modelSha256: manifest.hashes.modelSha256,
    scorerSha256: manifest.hashes.scorerSha256,
    reportSha256: manifest.hashes.reportSha256,
    preregistrationSha256: manifest.hashes.preregistrationSha256,
    configurations: manifest.configurations,
    splits: {
      train: {
        baseIndexStart: manifest.splits.train.baseIndexStart,
        baseCount: manifest.splits.train.baseCount,
        eventCap: manifest.splits.train.eventCap,
      },
      tune: {
        baseIndexStart: manifest.splits.tune.baseIndexStart,
        baseCount: manifest.splits.tune.baseCount,
        eventCap: manifest.splits.tune.eventCap,
      },
      qualification: {
        baseIndexStart: manifest.splits.qualification.baseIndexStart,
        eventCap: manifest.splits.qualification.eventCap,
      },
    },
    qualificationSampleSize: {
      verifiedDevelopmentVarianceArtifactSha256:
        manifest.qualificationSampleSize
          .verifiedDevelopmentVarianceArtifactSha256,
      maxPairedClusterStandardDeviation:
        manifest.qualificationSampleSize.maxPairedClusterStandardDeviation,
    },
  });
  if (
    stableStringify(rebuilt.manifest) !== stableStringify(manifest) ||
    rebuilt.manifestSha256 !== record.manifestSha256
  ) {
    throw new Error(
      "Phase 8 manifest artifact does not reproduce the sole frozen constructor.",
    );
  }
  return rebuilt;
}

export function createPhase8ManifestAuthorityArtifact(input: {
  readonly existingTarget: unknown;
  readonly authority: FrozenPhase8ManifestAuthority;
}): Phase8ManifestAuthorityArtifact {
  if (input.existingTarget !== null) {
    throw new Error(
      "Refusing to overwrite an existing Phase 8 manifest authority artifact.",
    );
  }
  const payload = serializePhase8ManifestAuthority(input.authority);
  const payloadSha256 = createHash("sha256")
    .update(payload, "utf8")
    .digest("hex");
  return deepFreeze({
    fileName: "phase8-manifest-authority.json" as const,
    payload,
    payloadSha256,
    checksumLine: `${payloadSha256}  phase8-manifest-authority.json\n`,
  });
}

export function rehydratePhase8ManifestAuthorityArtifact(
  artifact: Phase8ManifestAuthorityArtifact,
): FrozenPhase8ManifestAuthority {
  const payloadSha256 = createHash("sha256")
    .update(artifact.payload, "utf8")
    .digest("hex");
  if (
    artifact.fileName !== "phase8-manifest-authority.json" ||
    artifact.payloadSha256 !== payloadSha256 ||
    artifact.checksumLine !==
      `${payloadSha256}  phase8-manifest-authority.json\n`
  ) {
    throw new Error("Phase 8 manifest authority checksum envelope is invalid.");
  }
  return parseAndRehydratePhase8ManifestAuthority(artifact.payload);
}

export function verifyPhase8ManifestAuthority(
  authority: FrozenPhase8ManifestAuthority,
): true {
  assertFrozenAuthority(authority);
  return true;
}

export type Phase8SplitOpenProof =
  | {
      readonly kind: "development";
      readonly disclosureAuthoritySha256: string;
    }
  | {
      readonly kind: "qualification";
      readonly preregistrationSha256: string;
      readonly trainClosureSha256: string;
      readonly tuneClosureSha256: string;
      readonly sourceValidationArtifactSha256: string;
    };

const phase8SplitOpenProofSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("development"),
      disclosureAuthoritySha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("qualification"),
      preregistrationSha256: sha256Schema,
      trainClosureSha256: sha256Schema,
      tuneClosureSha256: sha256Schema,
      sourceValidationArtifactSha256: sha256Schema,
    })
    .strict(),
]);

const splitOpeningRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactVersion: z.literal(PHASE8_SPLIT_OPENING_ARTIFACT_VERSION),
    manifestSha256: sha256Schema,
    proof: phase8SplitOpenProofSchema,
    opening: z
      .object({
        schemaVersion: z.literal(1),
        protocolId: z.literal(EVALUATION_PROTOCOL_ID),
        manifestId: identifierSchema,
        manifestSha256: sha256Schema,
        split: z.enum(PHASE8_SPLITS),
        splitPlanSha256: sha256Schema,
        seedDisclosureAuthorized: z.literal(true),
        authorizationKind: z.enum(["development", "qualification"]),
        authorizationSha256: sha256Schema,
        openingSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

function requireSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function validateSplitOpenProof(
  authority: FrozenPhase8ManifestAuthority,
  split: Phase8Split,
  proof: Phase8SplitOpenProof,
): void {
  if (split === "train" || split === "tune") {
    if (proof.kind !== "development") {
      throw new Error(`${split} requires a development disclosure proof.`);
    }
    requireSha256(
      proof.disclosureAuthoritySha256,
      "Development disclosure authority",
    );
    return;
  }
  if (proof.kind !== "qualification") {
    throw new Error(
      "Qualification seeds require the frozen train/tune closure proof.",
    );
  }
  if (
    proof.preregistrationSha256 !==
    authority.manifest.hashes.preregistrationSha256
  ) {
    throw new Error(
      "Qualification proof does not bind the frozen preregistration.",
    );
  }
  requireSha256(proof.trainClosureSha256, "Train closure");
  requireSha256(proof.tuneClosureSha256, "Tune closure");
  requireSha256(
    proof.sourceValidationArtifactSha256,
    "Source-validation artifact",
  );
  if (
    new Set([
      proof.trainClosureSha256,
      proof.tuneClosureSha256,
      proof.sourceValidationArtifactSha256,
    ]).size !== 3
  ) {
    throw new Error(
      "Train, tune, and source-validation proofs must bind distinct artifacts.",
    );
  }
}

export function openPhase8Split(
  authority: FrozenPhase8ManifestAuthority,
  input: {
    readonly split: Phase8Split;
    readonly proof: Phase8SplitOpenProof;
  },
): Phase8SplitOpening {
  assertFrozenAuthority(authority);
  if (!PHASE8_SPLITS.includes(input.split)) {
    throw new Error(
      "Qualification authority cannot open final; freeze a distinct final manifest after selection.",
    );
  }
  validateSplitOpenProof(authority, input.split, input.proof);
  const splitPlanValue = authority.manifest.splits[input.split];
  const splitPlanSha256 = phase8Sha256(splitPlanValue);
  const authorizationSha256 = phase8Sha256(input.proof);
  const projection = {
    schemaVersion: 1,
    protocolId: EVALUATION_PROTOCOL_ID,
    manifestId: authority.manifest.manifestId,
    manifestSha256: authority.manifestSha256,
    split: input.split,
    splitPlanSha256,
    seedDisclosureAuthorized: true,
    authorizationKind: input.proof.kind,
    authorizationSha256,
  } as const;
  return deepFreeze({
    ...projection,
    openingSha256: phase8Sha256(projection),
    [SPLIT_OPENING_AUTHORITY]: true as const,
  });
}

export function serializePhase8SplitOpening(
  authority: FrozenPhase8ManifestAuthority,
  opening: Phase8SplitOpening,
  proof: Phase8SplitOpenProof,
): string {
  assertSplitOpening(authority, opening);
  const parsedProof = phase8SplitOpenProofSchema.parse(proof);
  const rebuilt = openPhase8Split(authority, {
    split: opening.split,
    proof: parsedProof,
  });
  if (stableStringify(rebuilt) !== stableStringify(opening)) {
    throw new Error(
      "Phase 8 split opening does not match its disclosure proof.",
    );
  }
  const record = splitOpeningRecordSchema.parse({
    schemaVersion: 1,
    artifactVersion: PHASE8_SPLIT_OPENING_ARTIFACT_VERSION,
    manifestSha256: authority.manifestSha256,
    proof: parsedProof,
    opening,
  });
  return `${stableStringify(record)}\n`;
}

export function parseAndRehydratePhase8SplitOpening(
  authority: FrozenPhase8ManifestAuthority,
  payload: string,
): Phase8SplitOpening {
  assertFrozenAuthority(authority);
  const record = splitOpeningRecordSchema.parse(
    parseJsonPayload(payload, "Phase 8 split-opening artifact"),
  );
  if (
    payload !== `${stableStringify(record)}\n` ||
    record.manifestSha256 !== authority.manifestSha256
  ) {
    throw new Error(
      "Phase 8 split-opening artifact is noncanonical or bound to another manifest.",
    );
  }
  const opening = openPhase8Split(authority, {
    split: record.opening.split,
    proof: record.proof,
  });
  if (stableStringify(opening) !== stableStringify(record.opening)) {
    throw new Error(
      "Phase 8 split-opening artifact does not reproduce its authorized opening.",
    );
  }
  return opening;
}

function assertSplitOpening(
  authority: FrozenPhase8ManifestAuthority,
  opening: Phase8SplitOpening,
): void {
  assertFrozenAuthority(authority);
  if (
    !hasTrueBrand(opening, SPLIT_OPENING_AUTHORITY) ||
    !Object.isFrozen(opening) ||
    opening.manifestSha256 !== authority.manifestSha256 ||
    opening.manifestId !== authority.manifest.manifestId ||
    opening.splitPlanSha256 !==
      phase8Sha256(authority.manifest.splits[opening.split])
  ) {
    throw new Error("Invalid or stale Phase 8 split-opening authority.");
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
    throw new Error("Phase 8 split-opening checksum mismatch.");
  }
}

export type Phase8SeedCoordinate = {
  readonly stream: Phase8SeedStream;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly replicate: 0;
};

export function deriveOpenedPhase8Seed(
  authority: FrozenPhase8ManifestAuthority,
  opening: Phase8SplitOpening,
  coordinate: Phase8SeedCoordinate,
): string {
  assertSplitOpening(authority, opening);
  const plan = authority.manifest.splits[opening.split];
  if (!PHASE8_SEED_STREAMS.includes(coordinate.stream)) {
    throw new Error(`Unknown Phase 8 seed stream ${coordinate.stream}.`);
  }
  if (!plan.styleCellIds.includes(coordinate.styleCellId)) {
    throw new Error(
      `Style cell ${coordinate.styleCellId} is outside the opened split.`,
    );
  }
  if (!plan.rotations.includes(coordinate.rotation)) {
    throw new Error("Rotation is outside the opened split.");
  }
  if (!plan.replicates.includes(coordinate.replicate)) {
    throw new Error("Replicate is outside the opened split.");
  }
  if (
    !Number.isSafeInteger(coordinate.baseIndex) ||
    coordinate.baseIndex < plan.baseIndexStart ||
    coordinate.baseIndex >= plan.baseIndexStart + plan.baseCount
  ) {
    throw new Error("Base index is outside the opened split.");
  }
  const coordinateMaterial =
    coordinate.stream === "deal"
      ? [coordinate.baseIndex.toString()]
      : coordinate.stream === "belief" ||
          coordinate.stream === "search" ||
          coordinate.stream === "rollout" ||
          coordinate.stream === "user-policy" ||
          coordinate.stream === "bootstrap" ||
          coordinate.stream === "solver-chance"
        ? [
            coordinate.baseIndex.toString(),
            coordinate.rotation.toString(),
            coordinate.replicate.toString(),
          ]
        : [
            coordinate.styleCellId,
            coordinate.baseIndex.toString(),
            coordinate.rotation.toString(),
            coordinate.replicate.toString(),
          ];
  return createHash("sha256")
    .update(
      [
        `bhabhi/${EVALUATION_PROTOCOL_ID}`,
        opening.split,
        coordinate.stream,
        ...coordinateMaterial,
      ].join("|"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

export function isPhase8ConfirmatorySplit(
  split: EvaluationSplit,
): split is Phase8ConfirmatorySplit {
  return split === "qualification" || split === "final";
}
