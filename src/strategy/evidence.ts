import { z } from "zod";

import {
  MOTIF_IDS,
  MOTIF_REGISTRY,
  motifById,
  type MotifId,
  type MotifClassification,
} from "./registry";

const nonEmptyStringSchema = z.string().trim().min(1);
const checksumSchema = z.string().trim().min(1);
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
const probabilitySchema = z.number().min(0).max(1);
const testPathSchema = z.string().regex(/^tests\/.+\.test\.[cm]?[jt]sx?$/u);
const uniqueNonEmptyStringsSchema = z
  .array(nonEmptyStringSchema)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: "values must be unique",
      });
    }
  });

export const replayableHistoryProvenanceSchema = z
  .object({
    kind: z.literal("replayable-history"),
    timelineArtifactChecksum: checksumSchema,
    semanticHistoryHash: checksumSchema,
    activeEventCount: positiveIntegerSchema,
    stateVersion: nonnegativeIntegerSchema,
  })
  .strict();

export const syntheticTransitionProvenanceSchema = z
  .object({
    kind: z.literal("synthetic-transition"),
    fixtureId: nonEmptyStringSchema,
    stateHash: checksumSchema,
    transitionSystemVersion: nonEmptyStringSchema,
    constructionDigest: checksumSchema,
  })
  .strict();

export const stateProvenanceSchema = z.discriminatedUnion("kind", [
  replayableHistoryProvenanceSchema,
  syntheticTransitionProvenanceSchema,
]);
export type StateProvenance = z.infer<typeof stateProvenanceSchema>;

export const strategyCommandRecordSchema = z
  .object({
    commandId: nonEmptyStringSchema,
    argv: z.array(nonEmptyStringSchema).min(1),
    workingDirectory: nonEmptyStringSchema,
    sourceRevision: nonEmptyStringSchema,
    environmentChecksum: checksumSchema,
    exitCode: z.number().int(),
  })
  .strict();
export type StrategyCommandRecord = z.infer<typeof strategyCommandRecordSchema>;

export const strategyStateRecordSchema = z
  .object({
    stateId: nonEmptyStringSchema,
    motifId: z.enum(MOTIF_IDS),
    provenance: stateProvenanceSchema,
    rulesChecksum: checksumSchema,
    solverConfigChecksum: checksumSchema,
    seedIds: uniqueNonEmptyStringsSchema,
    commandId: nonEmptyStringSchema,
  })
  .strict();
export type StrategyStateRecord = z.infer<typeof strategyStateRecordSchema>;

export const actionValueSchema = z
  .object({
    actionKey: nonEmptyStringSchema,
    terminalBhabhiRisk: probabilitySchema,
    terminalRollouts: positiveIntegerSchema,
    outcomeChecksum: checksumSchema,
  })
  .strict();
export type ActionValue = z.infer<typeof actionValueSchema>;

export const pairedActionValueRecordSchema = z
  .object({
    actionValueId: nonEmptyStringSchema,
    motifId: z.enum(MOTIF_IDS),
    stateId: nonEmptyStringSchema,
    pairId: nonEmptyStringSchema,
    pairedSeedId: nonEmptyStringSchema,
    commandId: nonEmptyStringSchema,
    confirmation: z.enum(["development", "train", "tune", "exhaustive"]),
    finding: z.enum([
      "positive-witness",
      "counterexample-witness",
      "finite-no-witness",
      "inconclusive",
    ]),
    left: actionValueSchema,
    right: actionValueSchema,
    deltaLeftMinusRight: z.number(),
    preferredActionKey: nonEmptyStringSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.left.actionKey === record.right.actionKey) {
      context.addIssue({
        code: "custom",
        path: ["right", "actionKey"],
        message: "paired actions must be distinct",
      });
    }
    const expectedDelta =
      record.left.terminalBhabhiRisk - record.right.terminalBhabhiRisk;
    if (Math.abs(expectedDelta - record.deltaLeftMinusRight) > 1e-12) {
      context.addIssue({
        code: "custom",
        path: ["deltaLeftMinusRight"],
        message: "delta must equal left risk minus right risk",
      });
    }

    const isWitness =
      record.finding === "positive-witness" ||
      record.finding === "counterexample-witness";
    if (isWitness) {
      if (record.left.terminalBhabhiRisk === record.right.terminalBhabhiRisk) {
        context.addIssue({
          code: "custom",
          path: ["finding"],
          message: "a witness requires unequal paired terminal risks",
        });
      }
      const expectedPreferred =
        record.left.terminalBhabhiRisk < record.right.terminalBhabhiRisk
          ? record.left.actionKey
          : record.right.actionKey;
      if (record.preferredActionKey !== expectedPreferred) {
        context.addIssue({
          code: "custom",
          path: ["preferredActionKey"],
          message: "preferred action must be the lower-risk paired action",
        });
      }
    } else if (record.preferredActionKey !== null) {
      context.addIssue({
        code: "custom",
        path: ["preferredActionKey"],
        message: "non-witness findings must not claim a preferred action",
      });
    }
  });
export type PairedActionValueRecord = z.infer<
  typeof pairedActionValueRecordSchema
>;

export const counterexampleBoundaryRecordSchema = z
  .object({
    boundaryRecordId: nonEmptyStringSchema,
    motifId: z.enum(MOTIF_IDS),
    commandId: nonEmptyStringSchema,
    finding: z.enum(["counterexample", "boundary", "finite-no-witness"]),
    scope: z.enum(["single-state", "finite-search", "exhaustive"]),
    description: nonEmptyStringSchema,
    stateIds: uniqueNonEmptyStringsSchema,
    actionValueIds: uniqueNonEmptyStringsSchema,
  })
  .strict();
export type CounterexampleBoundaryRecord = z.infer<
  typeof counterexampleBoundaryRecordSchema
>;

export const strategyFailureRecordSchema = z
  .object({
    failureId: nonEmptyStringSchema,
    motifId: z.enum(MOTIF_IDS).nullable(),
    commandId: nonEmptyStringSchema,
    stage: z.enum([
      "state-generation",
      "simulation",
      "inference",
      "search",
      "verification",
      "artifact-validation",
    ]),
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
    stateId: nonEmptyStringSchema.nullable(),
    recoverable: z.boolean(),
  })
  .strict();
export type StrategyFailureRecord = z.infer<typeof strategyFailureRecordSchema>;

export const executableEvidenceRecordSchema = z
  .object({
    evidenceId: nonEmptyStringSchema,
    motifId: z.enum(MOTIF_IDS),
    kind: z.enum(["direct-correctness", "experimental", "prerequisite"]),
    status: z.enum(["passed", "failed"]),
    testPath: testPathSchema,
    commandId: nonEmptyStringSchema,
    resultChecksum: checksumSchema,
  })
  .strict();
export type ExecutableEvidenceRecord = z.infer<
  typeof executableEvidenceRecordSchema
>;

const dispositionReferences = {
  rationale: nonEmptyStringSchema,
  evidenceIds: uniqueNonEmptyStringsSchema,
  actionValueIds: uniqueNonEmptyStringsSchema,
  boundaryRecordIds: uniqueNonEmptyStringsSchema,
  failureIds: uniqueNonEmptyStringsSchema,
};

export const motifDispositionSchema = z.discriminatedUnion("disposition", [
  z
    .object({
      motifId: z.enum(MOTIF_IDS),
      disposition: z.literal("retained-required"),
      ...dispositionReferences,
    })
    .strict(),
  z
    .object({
      motifId: z.enum(MOTIF_IDS),
      disposition: z.literal("retained-experimental"),
      ...dispositionReferences,
    })
    .strict(),
  z
    .object({
      motifId: z.enum(MOTIF_IDS),
      disposition: z.literal("rejected"),
      ...dispositionReferences,
    })
    .strict(),
  z
    .object({
      motifId: z.enum(MOTIF_IDS),
      disposition: z.literal("inconclusive"),
      ...dispositionReferences,
    })
    .strict(),
  z
    .object({
      motifId: z.enum(MOTIF_IDS),
      disposition: z.literal("deferred-phase7"),
      phase7Dependency: nonEmptyStringSchema,
      ...dispositionReferences,
    })
    .strict(),
]);
export type MotifDisposition = z.infer<typeof motifDispositionSchema>;
export type MotifDispositionKind = MotifDisposition["disposition"];

export const productionEligibilityRecordSchema = z
  .object({
    eligibilityRecordId: nonEmptyStringSchema,
    featureId: nonEmptyStringSchema,
    status: z.enum(["eligible", "ineligible"]),
    evaluationSplit: z.literal("qualification"),
    manifestChecksum: checksumSchema,
    productionConfigChecksum: checksumSchema,
    commandId: nonEmptyStringSchema,
    criteria: z
      .object({
        correctness: z.boolean(),
        reproducibility: z.boolean(),
        liveLatency: z.boolean(),
        terminalNoninferiority: z.boolean(),
        robustness: z.boolean(),
        evidenceSpecificImprovement: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ProductionEligibilityRecord = z.infer<
  typeof productionEligibilityRecordSchema
>;

export const productionFeatureDecisionSchema = z
  .object({
    featureId: nonEmptyStringSchema,
    motifIds: z.array(z.enum(MOTIF_IDS)).min(1),
    decision: z.enum(["enabled", "disabled", "not-evaluated"]),
    eligibilityRecordId: nonEmptyStringSchema.nullable(),
    rationale: nonEmptyStringSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (new Set(record.motifIds).size !== record.motifIds.length) {
      context.addIssue({
        code: "custom",
        path: ["motifIds"],
        message: "motif IDs must be unique",
      });
    }
    if (
      record.decision === "not-evaluated" &&
      record.eligibilityRecordId !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["eligibilityRecordId"],
        message: "not-evaluated features cannot cite eligibility",
      });
    }
  });
export type ProductionFeatureDecision = z.infer<
  typeof productionFeatureDecisionSchema
>;

export const strategyEvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    commands: z.array(strategyCommandRecordSchema),
    states: z.array(strategyStateRecordSchema),
    actionValues: z.array(pairedActionValueRecordSchema),
    boundaries: z.array(counterexampleBoundaryRecordSchema),
    failures: z.array(strategyFailureRecordSchema),
    evidence: z.array(executableEvidenceRecordSchema),
    dispositions: z.array(motifDispositionSchema),
    eligibility: z.array(productionEligibilityRecordSchema),
    productionDecisions: z.array(productionFeatureDecisionSchema),
  })
  .strict();
export type StrategyEvidenceBundle = z.infer<
  typeof strategyEvidenceBundleSchema
>;

export type StrategyEvidenceIssue = {
  readonly code: string;
  readonly message: string;
  readonly motifId?: MotifId;
};

export type StrategyEvidenceVerification = {
  readonly ok: boolean;
  readonly issues: readonly StrategyEvidenceIssue[];
};

export const strategyEvidenceVerificationModeSchema = z.enum([
  "phase6",
  "final",
]);
export type StrategyEvidenceVerificationMode = z.infer<
  typeof strategyEvidenceVerificationModeSchema
>;
export type StrategyEvidenceVerificationOptions = Readonly<{
  mode?: StrategyEvidenceVerificationMode;
  allowedRequiredDeferrals?: readonly MotifId[];
}>;

export const PHASE6_REQUIRED_STRATEGY_DEFERRALS = ["M39", "M40"] as const;

export class StrategyEvidenceError extends Error {
  readonly issues: readonly StrategyEvidenceIssue[];

  constructor(issues: readonly StrategyEvidenceIssue[]) {
    super(
      `Invalid strategy evidence:\n${issues
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "StrategyEvidenceError";
    this.issues = [...issues];
  }
}

function addIssue(
  issues: StrategyEvidenceIssue[],
  code: string,
  message: string,
  motifId?: MotifId,
): void {
  issues.push({
    code,
    message,
    ...(motifId === undefined ? {} : { motifId }),
  });
}

function indexUnique<T>(
  records: readonly T[],
  idOf: (record: T) => string,
  label: string,
  issues: StrategyEvidenceIssue[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const record of records) {
    const id = idOf(record);
    if (result.has(id)) {
      addIssue(issues, "duplicate-record-id", `duplicate ${label} ID ${id}`);
    } else {
      result.set(id, record);
    }
  }
  return result;
}

function referencedForMotif<T extends { readonly motifId: MotifId }>(
  ids: readonly string[],
  records: ReadonlyMap<string, T>,
  motifId: MotifId,
  label: string,
  issues: StrategyEvidenceIssue[],
): T[] {
  const result: T[] = [];
  for (const id of ids) {
    const record = records.get(id);
    if (record === undefined) {
      addIssue(
        issues,
        "missing-reference",
        `${motifId} references missing ${label} ${id}`,
        motifId,
      );
    } else if (record.motifId !== motifId) {
      addIssue(
        issues,
        "cross-motif-reference",
        `${motifId} references ${label} ${id} owned by ${record.motifId}`,
        motifId,
      );
    } else {
      result.push(record);
    }
  }
  return result;
}

function allEligibilityCriteriaPass(
  record: ProductionEligibilityRecord,
): boolean {
  return Object.values(record.criteria).every((value) => value);
}

function validateCommandReferences(
  bundle: StrategyEvidenceBundle,
  commands: ReadonlyMap<string, StrategyCommandRecord>,
  issues: StrategyEvidenceIssue[],
): void {
  const references = [
    ...bundle.states.map((record) => ({
      owner: `state ${record.stateId}`,
      commandId: record.commandId,
    })),
    ...bundle.actionValues.map((record) => ({
      owner: `action value ${record.actionValueId}`,
      commandId: record.commandId,
    })),
    ...bundle.boundaries.map((record) => ({
      owner: `boundary ${record.boundaryRecordId}`,
      commandId: record.commandId,
    })),
    ...bundle.failures.map((record) => ({
      owner: `failure ${record.failureId}`,
      commandId: record.commandId,
    })),
    ...bundle.evidence.map((record) => ({
      owner: `evidence ${record.evidenceId}`,
      commandId: record.commandId,
    })),
    ...bundle.eligibility.map((record) => ({
      owner: `eligibility ${record.eligibilityRecordId}`,
      commandId: record.commandId,
    })),
  ];
  for (const reference of references) {
    if (!commands.has(reference.commandId)) {
      addIssue(
        issues,
        "missing-command",
        `${reference.owner} references missing command ${reference.commandId}`,
      );
    }
  }
}

function verifyParsedBundle(
  bundle: StrategyEvidenceBundle,
  mode: StrategyEvidenceVerificationMode,
  allowedRequiredDeferrals: ReadonlySet<MotifId>,
): StrategyEvidenceIssue[] {
  const issues: StrategyEvidenceIssue[] = [];
  const commands = indexUnique(
    bundle.commands,
    (record) => record.commandId,
    "command",
    issues,
  );
  const states = indexUnique(
    bundle.states,
    (record) => record.stateId,
    "state",
    issues,
  );
  const actionValues = indexUnique(
    bundle.actionValues,
    (record) => record.actionValueId,
    "action-value",
    issues,
  );
  const boundaries = indexUnique(
    bundle.boundaries,
    (record) => record.boundaryRecordId,
    "boundary",
    issues,
  );
  const failures = indexUnique(
    bundle.failures,
    (record) => record.failureId,
    "failure",
    issues,
  );
  const evidence = indexUnique(
    bundle.evidence,
    (record) => record.evidenceId,
    "evidence",
    issues,
  );
  const eligibility = indexUnique(
    bundle.eligibility,
    (record) => record.eligibilityRecordId,
    "eligibility",
    issues,
  );
  const productionDecisions = indexUnique(
    bundle.productionDecisions,
    (record) => record.featureId,
    "production-feature",
    issues,
  );
  void productionDecisions;

  validateCommandReferences(bundle, commands, issues);

  for (const record of bundle.actionValues) {
    const state = states.get(record.stateId);
    if (state === undefined) {
      addIssue(
        issues,
        "missing-state",
        `${record.actionValueId} references missing state ${record.stateId}`,
        record.motifId,
      );
    } else if (state.motifId !== record.motifId) {
      addIssue(
        issues,
        "cross-motif-state",
        `${record.actionValueId} uses ${state.motifId} state ${state.stateId}`,
        record.motifId,
      );
    }
  }

  for (const record of bundle.boundaries) {
    referencedForMotif(
      record.actionValueIds,
      actionValues,
      record.motifId,
      "action value",
      issues,
    );
    for (const stateId of record.stateIds) {
      const state = states.get(stateId);
      if (state === undefined) {
        addIssue(
          issues,
          "missing-state",
          `${record.boundaryRecordId} references missing state ${stateId}`,
          record.motifId,
        );
      } else if (state.motifId !== record.motifId) {
        addIssue(
          issues,
          "cross-motif-state",
          `${record.boundaryRecordId} uses ${state.motifId} state ${stateId}`,
          record.motifId,
        );
      }
    }
  }

  const dispositionsByMotif = new Map<MotifId, MotifDisposition>();
  for (const disposition of bundle.dispositions) {
    if (dispositionsByMotif.has(disposition.motifId)) {
      addIssue(
        issues,
        "duplicate-disposition",
        `${disposition.motifId} has more than one disposition`,
        disposition.motifId,
      );
    } else {
      dispositionsByMotif.set(disposition.motifId, disposition);
    }
  }
  for (const motifId of MOTIF_IDS) {
    if (!dispositionsByMotif.has(motifId)) {
      addIssue(
        issues,
        "missing-disposition",
        `${motifId} has no disposition`,
        motifId,
      );
    }
  }
  if (bundle.dispositions.length !== MOTIF_IDS.length) {
    addIssue(
      issues,
      "disposition-count",
      `expected ${MOTIF_IDS.length.toString()} dispositions, received ${bundle.dispositions.length.toString()}`,
    );
  }

  for (const motifId of MOTIF_IDS) {
    const registryEntry = motifById(motifId);
    const disposition = dispositionsByMotif.get(motifId);
    if (disposition === undefined) {
      continue;
    }
    const motifEvidence = referencedForMotif(
      disposition.evidenceIds,
      evidence,
      motifId,
      "evidence",
      issues,
    );
    const motifActionValues = referencedForMotif(
      disposition.actionValueIds,
      actionValues,
      motifId,
      "action value",
      issues,
    );
    const motifBoundaries = referencedForMotif(
      disposition.boundaryRecordIds,
      boundaries,
      motifId,
      "boundary",
      issues,
    );
    const motifFailures = referencedForMotif(
      disposition.failureIds,
      failures as ReadonlyMap<
        string,
        StrategyFailureRecord & { readonly motifId: MotifId }
      >,
      motifId,
      "failure",
      issues,
    );
    void motifFailures;

    const passingDirect = motifEvidence.some((record) => {
      const command = commands.get(record.commandId);
      return (
        record.kind === "direct-correctness" &&
        record.status === "passed" &&
        command?.exitCode === 0
      );
    });

    if (registryEntry.classification === "required-correctness") {
      if (
        disposition.disposition !== "retained-required" &&
        disposition.disposition !== "deferred-phase7"
      ) {
        addIssue(
          issues,
          "required-not-retained",
          `${motifId} is required correctness and must be retained-required or explicitly deferred to Phase 7`,
          motifId,
        );
      }
      if (disposition.disposition === "retained-required" && !passingDirect) {
        addIssue(
          issues,
          "required-without-direct-pass",
          `${motifId} lacks referenced direct passing executable evidence`,
          motifId,
        );
      }
      if (disposition.disposition === "deferred-phase7" && mode === "final") {
        addIssue(
          issues,
          "required-deferred-at-final",
          `${motifId} is required correctness and cannot remain deferred in final verification`,
          motifId,
        );
      }
      if (
        disposition.disposition === "deferred-phase7" &&
        mode === "phase6" &&
        !allowedRequiredDeferrals.has(motifId)
      ) {
        addIssue(
          issues,
          "unapproved-required-deferral",
          `${motifId} is not an approved required-correctness Phase 7 deferral`,
          motifId,
        );
      }
    }

    switch (disposition.disposition) {
      case "retained-required":
        if (registryEntry.classification !== "required-correctness") {
          addIssue(
            issues,
            "invalid-required-retention",
            `${motifId} is ${registryEntry.classification}, not required correctness`,
            motifId,
          );
        }
        if (!passingDirect) {
          addIssue(
            issues,
            "retained-without-evidence",
            `${motifId} retained-required has no direct passing evidence`,
            motifId,
          );
        }
        break;
      case "retained-experimental": {
        if (registryEntry.classification === "required-correctness") {
          addIssue(
            issues,
            "required-as-experimental",
            `${motifId} required correctness cannot be relabeled experimental`,
            motifId,
          );
        }
        const passingExperiment = motifEvidence.some((record) => {
          const command = commands.get(record.commandId);
          return (
            record.kind === "experimental" &&
            record.status === "passed" &&
            command?.exitCode === 0
          );
        });
        const confirmedPositive = motifActionValues.some(
          (record) =>
            record.finding === "positive-witness" &&
            (record.confirmation === "tune" ||
              record.confirmation === "exhaustive") &&
            commands.get(record.commandId)?.exitCode === 0,
        );
        const hasBoundary = motifBoundaries.some(
          (record) =>
            record.finding === "boundary" ||
            record.finding === "counterexample",
        );
        if (!passingExperiment || !confirmedPositive || !hasBoundary) {
          addIssue(
            issues,
            "retained-experimental-insufficient",
            `${motifId} needs passed experimental evidence, a tune/exhaustive positive witness, and a boundary/counterexample`,
            motifId,
          );
        }
        break;
      }
      case "rejected": {
        const actualCounterexample =
          motifActionValues.some(
            (record) => record.finding === "counterexample-witness",
          ) ||
          motifBoundaries.some((record) => record.finding === "counterexample");
        if (!actualCounterexample) {
          addIssue(
            issues,
            "finite-no-witness-is-not-false",
            `${motifId} cannot be rejected without an actual counterexample witness`,
            motifId,
          );
        }
        break;
      }
      case "inconclusive":
        if (
          motifEvidence.length === 0 &&
          motifActionValues.length === 0 &&
          motifBoundaries.length === 0 &&
          disposition.failureIds.length === 0
        ) {
          addIssue(
            issues,
            "unsupported-inconclusive",
            `${motifId} inconclusive needs a finite search, evidence, or failure record`,
            motifId,
          );
        }
        break;
      case "deferred-phase7":
        if (!/\bphase\s*7\b/iu.test(disposition.phase7Dependency)) {
          addIssue(
            issues,
            "implicit-phase7-dependency",
            `${motifId} must name Phase 7 explicitly in its dependency`,
            motifId,
          );
        }
        break;
    }
  }

  for (const decision of bundle.productionDecisions) {
    const record =
      decision.eligibilityRecordId === null
        ? undefined
        : eligibility.get(decision.eligibilityRecordId);
    if (decision.eligibilityRecordId !== null && record === undefined) {
      addIssue(
        issues,
        "missing-eligibility",
        `${decision.featureId} references missing eligibility ${decision.eligibilityRecordId}`,
      );
    }
    if (record !== undefined && record.featureId !== decision.featureId) {
      addIssue(
        issues,
        "eligibility-feature-mismatch",
        `${record.eligibilityRecordId} belongs to ${record.featureId}, not ${decision.featureId}`,
      );
    }
    if (decision.decision === "enabled") {
      if (
        record === undefined ||
        record.status !== "eligible" ||
        !allEligibilityCriteriaPass(record) ||
        commands.get(record.commandId)?.exitCode !== 0
      ) {
        addIssue(
          issues,
          "enabled-without-eligibility",
          `${decision.featureId} cannot be enabled without a separate passing eligibility record`,
        );
      }
      for (const motifId of decision.motifIds) {
        const disposition = dispositionsByMotif.get(motifId);
        if (
          disposition?.disposition !== "retained-required" &&
          disposition?.disposition !== "retained-experimental"
        ) {
          addIssue(
            issues,
            "enabled-with-unretained-motif",
            `${decision.featureId} depends on unretained ${motifId}`,
            motifId,
          );
        }
      }
    }
  }

  return issues;
}

export function parseStrategyEvidenceBundle(
  value: unknown,
): StrategyEvidenceBundle {
  const parsed = strategyEvidenceBundleSchema.safeParse(value);
  if (!parsed.success) {
    throw new StrategyEvidenceError(
      parsed.error.issues.map((issue) => ({
        code: "schema",
        message: `${issue.path.join(".") || "bundle"}: ${issue.message}`,
      })),
    );
  }
  return parsed.data;
}

export function verifyStrategyEvidence(
  value: unknown,
  options: StrategyEvidenceVerificationOptions = {},
): StrategyEvidenceVerification {
  let bundle: StrategyEvidenceBundle;
  try {
    bundle = parseStrategyEvidenceBundle(value);
  } catch (error) {
    if (error instanceof StrategyEvidenceError) {
      return { ok: false, issues: error.issues };
    }
    throw error;
  }
  const mode = strategyEvidenceVerificationModeSchema.parse(
    options.mode ?? "phase6",
  );
  const allowedRequiredDeferrals = new Set<MotifId>(
    options.allowedRequiredDeferrals ?? PHASE6_REQUIRED_STRATEGY_DEFERRALS,
  );
  const issues = verifyParsedBundle(bundle, mode, allowedRequiredDeferrals);
  return { ok: issues.length === 0, issues };
}

export function verifyFinalStrategyEvidence(
  value: unknown,
): StrategyEvidenceVerification {
  return verifyStrategyEvidence(value, { mode: "final" });
}

const dispositionCountSchema = z
  .object({
    retainedRequired: nonnegativeIntegerSchema,
    retainedExperimental: nonnegativeIntegerSchema,
    rejected: nonnegativeIntegerSchema,
    inconclusive: nonnegativeIntegerSchema,
    deferredPhase7: nonnegativeIntegerSchema,
  })
  .strict();

const classificationCountSchema = z
  .object({
    requiredCorrectness: nonnegativeIntegerSchema,
    reported: nonnegativeIntegerSchema,
    hypothesis: nonnegativeIntegerSchema,
  })
  .strict();

export const strategyEvidenceSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    registryEntryCount: z.literal(48),
    classificationCounts: classificationCountSchema,
    dispositionCounts: dispositionCountSchema,
    requiredDirectPassingCount: nonnegativeIntegerSchema,
    enabledProductionFeatureCount: nonnegativeIntegerSchema,
    motifs: z.array(
      z
        .object({
          motifId: z.enum(MOTIF_IDS),
          classification: z.enum([
            "required-correctness",
            "reported",
            "hypothesis",
          ]),
          disposition: z.enum([
            "retained-required",
            "retained-experimental",
            "rejected",
            "inconclusive",
            "deferred-phase7",
          ]),
          evidenceCount: nonnegativeIntegerSchema,
          actionValueCount: nonnegativeIntegerSchema,
          boundaryCount: nonnegativeIntegerSchema,
          failureCount: nonnegativeIntegerSchema,
        })
        .strict(),
    ),
    productionFeatures: z.array(
      z
        .object({
          featureId: nonEmptyStringSchema,
          decision: z.enum(["enabled", "disabled", "not-evaluated"]),
          eligibilityRecordId: nonEmptyStringSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type StrategyEvidenceSummary = z.infer<
  typeof strategyEvidenceSummarySchema
>;

function classificationCounts(): Readonly<Record<MotifClassification, number>> {
  const result: Record<MotifClassification, number> = {
    "required-correctness": 0,
    reported: 0,
    hypothesis: 0,
  };
  for (const entry of MOTIF_REGISTRY) {
    result[entry.classification] += 1;
  }
  return result;
}

export function summarizeStrategyEvidence(
  value: unknown,
  options: StrategyEvidenceVerificationOptions = {},
): StrategyEvidenceSummary {
  const bundle = parseStrategyEvidenceBundle(value);
  const mode = strategyEvidenceVerificationModeSchema.parse(
    options.mode ?? "phase6",
  );
  const issues = verifyParsedBundle(
    bundle,
    mode,
    new Set(
      options.allowedRequiredDeferrals ??
        (mode === "phase6" ? PHASE6_REQUIRED_STRATEGY_DEFERRALS : []),
    ),
  );
  if (issues.length > 0) {
    throw new StrategyEvidenceError(issues);
  }

  const classifications = classificationCounts();
  const dispositions = [...bundle.dispositions].sort((left, right) =>
    left.motifId.localeCompare(right.motifId),
  );
  const counts = {
    retainedRequired: 0,
    retainedExperimental: 0,
    rejected: 0,
    inconclusive: 0,
    deferredPhase7: 0,
  };
  for (const disposition of dispositions) {
    switch (disposition.disposition) {
      case "retained-required":
        counts.retainedRequired += 1;
        break;
      case "retained-experimental":
        counts.retainedExperimental += 1;
        break;
      case "rejected":
        counts.rejected += 1;
        break;
      case "inconclusive":
        counts.inconclusive += 1;
        break;
      case "deferred-phase7":
        counts.deferredPhase7 += 1;
        break;
    }
  }

  const summary: StrategyEvidenceSummary = {
    schemaVersion: 1,
    registryEntryCount: 48,
    classificationCounts: {
      requiredCorrectness: classifications["required-correctness"],
      reported: classifications.reported,
      hypothesis: classifications.hypothesis,
    },
    dispositionCounts: counts,
    requiredDirectPassingCount: dispositions.filter(
      (disposition) => disposition.disposition === "retained-required",
    ).length,
    enabledProductionFeatureCount: bundle.productionDecisions.filter(
      (decision) => decision.decision === "enabled",
    ).length,
    motifs: dispositions.map((disposition) => ({
      motifId: disposition.motifId,
      classification: motifById(disposition.motifId).classification,
      disposition: disposition.disposition,
      evidenceCount: disposition.evidenceIds.length,
      actionValueCount: disposition.actionValueIds.length,
      boundaryCount: disposition.boundaryRecordIds.length,
      failureCount: disposition.failureIds.length,
    })),
    productionFeatures: [...bundle.productionDecisions]
      .sort((left, right) => left.featureId.localeCompare(right.featureId))
      .map((decision) => ({
        featureId: decision.featureId,
        decision: decision.decision,
        eligibilityRecordId: decision.eligibilityRecordId,
      })),
  };
  return strategyEvidenceSummarySchema.parse(summary);
}
