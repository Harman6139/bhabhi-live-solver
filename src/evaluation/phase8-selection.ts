import {
  PHASE8_MAX_CONFIGURATIONS,
  phase8Sha256,
  verifyPhase8ManifestAuthority,
  type FrozenPhase8ManifestAuthority,
  type Phase8ConfigurationDescriptor,
} from "./phase8-manifest";
import {
  PHASE8_PRACTICAL_TIE_MARGIN,
  type Phase8TerminalGateResult,
} from "./phase8-statistics";

export type Phase8CommonEligibilityGates = {
  readonly correctnessGate: boolean;
  readonly conservationGate: boolean;
  readonly replayGate: boolean;
  readonly truthFirewallGate: boolean;
  readonly fixedSeedReproducibilityGate: boolean;
  readonly completeMatrixGate: boolean;
  readonly zeroFailureGate: boolean;
  readonly zeroCapGate: boolean;
  readonly zeroCancellationGate: boolean;
  readonly terminalNoninferiorityGate: boolean;
  readonly styleSafetyGate: boolean;
  readonly robustnessGate: boolean;
  readonly latencyBudgetGate: boolean;
  readonly stalePublicationGate: boolean;
  readonly memoryBudgetGate: boolean;
};

export type Phase8ComponentEligibilityGates = {
  readonly exactIncrementalImprovementGate: boolean | null;
  readonly behaviorCalibrationGate: boolean | null;
  readonly behaviorZeroSupportGate: boolean | null;
  readonly behaviorHardKnownPreservationGate: boolean | null;
  readonly behaviorSeparatePosteriorRobustnessGate: boolean | null;
};

export type Phase8ConfigurationEvidence = {
  readonly configId: string;
  readonly terminalBhabhiRate: number;
  readonly terminalGate: Phase8TerminalGateResult | null;
  readonly latencyP95Ms: number;
  readonly calibrationRobustnessRank: number;
  readonly commonGates: Phase8CommonEligibilityGates;
  readonly componentGates: Phase8ComponentEligibilityGates;
};

export type Phase8EligibilityAssessment = {
  readonly configId: string;
  readonly eligible: boolean;
  readonly failedGates: readonly string[];
};

export type Phase8FinalEvaluationRule =
  | {
      readonly mode: "one-arm-reference-confirmation";
      readonly configurationIds: readonly [string];
      readonly selectionIsReference: true;
    }
  | {
      readonly mode: "paired-selected-vs-reference";
      readonly configurationIds: readonly [string, string];
      readonly selectionIsReference: false;
    };

const PHASE8_SELECTION_DECISION_AUTHORITY = Symbol(
  "phase8-selection-decision-authority",
);

export type Phase8SelectionDecision = {
  readonly schemaVersion: 1;
  readonly decisionVersion: "phase8-production-selection-v1";
  readonly manifestId: string;
  readonly manifestSha256: string;
  readonly referenceConfigId: string;
  readonly selectedConfigId: string;
  readonly selectionIsReference: boolean;
  readonly selectionMode:
    | "measured-improvement"
    | "lowest-terminal-estimate"
    | "practical-tie"
    | "reference-fallback";
  readonly eligibleConfigIds: readonly string[];
  readonly orderedFallbackConfigIds: readonly string[];
  readonly eligibility: readonly Phase8EligibilityAssessment[];
  readonly practicalTieMargin: typeof PHASE8_PRACTICAL_TIE_MARGIN;
  readonly tieBreakOrder: readonly [
    "terminal-bhabhi-rate",
    "calibration-robustness-rank-within-practical-tie",
    "latency-p95",
    "enabled-component-count",
    "config-id",
  ];
  readonly finalRule: Phase8FinalEvaluationRule;
  readonly decisionSha256: string;
  readonly [PHASE8_SELECTION_DECISION_AUTHORITY]: true;
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

function finiteProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a finite probability.`);
  }
}

function finiteNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and nonnegative.`);
  }
}

function descriptorById(
  authority: FrozenPhase8ManifestAuthority,
): ReadonlyMap<string, Phase8ConfigurationDescriptor> {
  return new Map(
    authority.manifest.configurations.map((descriptor) => [
      descriptor.configId,
      descriptor,
    ]),
  );
}

function assessEligibility(
  descriptor: Phase8ConfigurationDescriptor,
  evidence: Phase8ConfigurationEvidence,
): Phase8EligibilityAssessment {
  const failedGates: string[] = [];
  for (const [gate, passed] of Object.entries(evidence.commonGates)) {
    if (!passed) {
      failedGates.push(gate);
    }
  }
  if (descriptor.role === "candidate" && evidence.terminalGate === null) {
    failedGates.push("terminalGatePresent");
  }
  if (
    descriptor.role === "candidate" &&
    evidence.terminalGate?.noninferiorityGate !==
      evidence.commonGates.terminalNoninferiorityGate
  ) {
    failedGates.push("terminalGateConsistency");
  }
  if (descriptor.role === "reference" && evidence.terminalGate !== null) {
    failedGates.push("referenceHasNoCandidateContrast");
  }
  if (descriptor.components.exactEndgame) {
    if (evidence.componentGates.exactIncrementalImprovementGate !== true) {
      failedGates.push("exactIncrementalImprovementGate");
    }
  } else if (evidence.componentGates.exactIncrementalImprovementGate !== null) {
    failedGates.push("exactComponentGateMustBeNull");
  }
  if (descriptor.components.behaviorWeighting) {
    if (evidence.componentGates.behaviorCalibrationGate !== true) {
      failedGates.push("behaviorCalibrationGate");
    }
    if (evidence.componentGates.behaviorZeroSupportGate !== true) {
      failedGates.push("behaviorZeroSupportGate");
    }
    if (evidence.componentGates.behaviorHardKnownPreservationGate !== true) {
      failedGates.push("behaviorHardKnownPreservationGate");
    }
    if (
      evidence.componentGates.behaviorSeparatePosteriorRobustnessGate !== true
    ) {
      failedGates.push("behaviorSeparatePosteriorRobustnessGate");
    }
  } else if (
    evidence.componentGates.behaviorCalibrationGate !== null ||
    evidence.componentGates.behaviorZeroSupportGate !== null ||
    evidence.componentGates.behaviorHardKnownPreservationGate !== null ||
    evidence.componentGates.behaviorSeparatePosteriorRobustnessGate !== null
  ) {
    failedGates.push("behaviorComponentGatesMustBeNull");
  }
  return {
    configId: evidence.configId,
    eligible: failedGates.length === 0,
    failedGates: [...new Set(failedGates)].sort(),
  };
}

function enabledComponentCount(
  descriptor: Phase8ConfigurationDescriptor,
): number {
  return (
    Number(descriptor.components.exactEndgame) +
    Number(descriptor.components.behaviorWeighting)
  );
}

function practicalTiePair(
  left: Phase8ConfigurationEvidence,
  right: Phase8ConfigurationEvidence,
  descriptors: ReadonlyMap<string, Phase8ConfigurationDescriptor>,
): boolean {
  if (
    Math.abs(left.terminalBhabhiRate - right.terminalBhabhiRate) >
    PHASE8_PRACTICAL_TIE_MARGIN
  ) {
    return false;
  }
  const leftDescriptor = descriptors.get(left.configId);
  const rightDescriptor = descriptors.get(right.configId);
  if (leftDescriptor === undefined || rightDescriptor === undefined) {
    throw new Error("Tie comparison references an unknown configuration.");
  }
  if (leftDescriptor.role === "reference") {
    return right.terminalGate?.practicalTieGate === true;
  }
  if (rightDescriptor.role === "reference") {
    return left.terminalGate?.practicalTieGate === true;
  }
  return (
    left.terminalGate?.practicalTieGate === true &&
    right.terminalGate?.practicalTieGate === true
  );
}

function compareTieBreakers(
  left: Phase8ConfigurationEvidence,
  right: Phase8ConfigurationEvidence,
  descriptors: ReadonlyMap<string, Phase8ConfigurationDescriptor>,
): number {
  if (left.calibrationRobustnessRank !== right.calibrationRobustnessRank) {
    return left.calibrationRobustnessRank - right.calibrationRobustnessRank;
  }
  if (left.latencyP95Ms !== right.latencyP95Ms) {
    return left.latencyP95Ms - right.latencyP95Ms;
  }
  const leftDescriptor = descriptors.get(left.configId);
  const rightDescriptor = descriptors.get(right.configId);
  if (leftDescriptor === undefined || rightDescriptor === undefined) {
    throw new Error("Tie-break references an unknown configuration.");
  }
  const componentDifference =
    enabledComponentCount(leftDescriptor) -
    enabledComponentCount(rightDescriptor);
  if (componentDifference !== 0) {
    return componentDifference;
  }
  return left.configId.localeCompare(right.configId);
}

function orderEligibleEvidence(
  values: readonly Phase8ConfigurationEvidence[],
  descriptors: ReadonlyMap<string, Phase8ConfigurationDescriptor>,
): readonly Phase8ConfigurationEvidence[] {
  const remaining = [...values];
  const ordered: Phase8ConfigurationEvidence[] = [];
  while (remaining.length > 0) {
    const pointWinner = [...remaining].sort(
      (left, right) =>
        left.terminalBhabhiRate - right.terminalBhabhiRate ||
        left.configId.localeCompare(right.configId),
    )[0];
    if (pointWinner === undefined) {
      throw new Error(
        "Point-estimate selection pool unexpectedly became empty.",
      );
    }
    const tiePool = remaining.filter(
      (candidate) =>
        candidate.configId === pointWinner.configId ||
        practicalTiePair(candidate, pointWinner, descriptors),
    );
    const tieWinner = [...tiePool].sort((left, right) =>
      compareTieBreakers(left, right, descriptors),
    )[0];
    if (tieWinner === undefined) {
      throw new Error(
        "Practical-tie selection pool unexpectedly became empty.",
      );
    }
    ordered.push(tieWinner);
    const selectedIndex = remaining.findIndex(
      (candidate) => candidate.configId === tieWinner.configId,
    );
    remaining.splice(selectedIndex, 1);
  }
  return ordered;
}

export function phase8FinalEvaluationRule(input: {
  readonly referenceConfigId: string;
  readonly selectedConfigId: string;
}): Phase8FinalEvaluationRule {
  if (
    input.referenceConfigId.trim().length === 0 ||
    input.selectedConfigId.trim().length === 0
  ) {
    throw new Error("Final-rule configuration IDs must be nonempty.");
  }
  if (input.referenceConfigId === input.selectedConfigId) {
    return {
      mode: "one-arm-reference-confirmation",
      configurationIds: [input.referenceConfigId],
      selectionIsReference: true,
    };
  }
  return {
    mode: "paired-selected-vs-reference",
    configurationIds: [input.referenceConfigId, input.selectedConfigId],
    selectionIsReference: false,
  };
}

export function selectPhase8ProductionConfiguration(
  authority: FrozenPhase8ManifestAuthority,
  evidenceValues: readonly Phase8ConfigurationEvidence[],
): Phase8SelectionDecision {
  verifyPhase8ManifestAuthority(authority);
  if (
    evidenceValues.length !== authority.manifest.configurations.length ||
    evidenceValues.length > PHASE8_MAX_CONFIGURATIONS
  ) {
    throw new Error(
      "Selection evidence must cover every frozen configuration exactly once.",
    );
  }
  const descriptors = descriptorById(authority);
  const evidenceById = new Map<string, Phase8ConfigurationEvidence>();
  for (const evidence of evidenceValues) {
    if (
      evidence.configId.trim().length === 0 ||
      evidenceById.has(evidence.configId) ||
      !descriptors.has(evidence.configId)
    ) {
      throw new Error(
        "Selection evidence contains a duplicate or unknown configuration.",
      );
    }
    finiteProbability(
      evidence.terminalBhabhiRate,
      `${evidence.configId} terminal Bhabhi rate`,
    );
    finiteNonnegative(
      evidence.latencyP95Ms,
      `${evidence.configId} p95 latency`,
    );
    if (
      !Number.isSafeInteger(evidence.calibrationRobustnessRank) ||
      evidence.calibrationRobustnessRank < 0
    ) {
      throw new RangeError(
        `${evidence.configId} calibration/robustness rank must be a nonnegative safe integer.`,
      );
    }
    evidenceById.set(evidence.configId, evidence);
  }
  const referenceDescriptor = authority.manifest.configurations.find(
    (descriptor) => descriptor.role === "reference",
  );
  if (referenceDescriptor === undefined) {
    throw new Error("Frozen registry has no reference configuration.");
  }

  const eligibility = authority.manifest.configurations.map((descriptor) => {
    const evidence = evidenceById.get(descriptor.configId);
    if (evidence === undefined) {
      throw new Error(`Missing selection evidence for ${descriptor.configId}.`);
    }
    return assessEligibility(descriptor, evidence);
  });
  const eligibilityById = new Map(
    eligibility.map((assessment) => [assessment.configId, assessment.eligible]),
  );
  if (eligibilityById.get(referenceDescriptor.configId) !== true) {
    throw new Error(
      "Frozen reference is ineligible; there is no authorized production fallback.",
    );
  }
  const eligibleEvidence = [...evidenceById.values()].filter(
    (evidence) => eligibilityById.get(evidence.configId) === true,
  );
  const orderedEligible = orderEligibleEvidence(eligibleEvidence, descriptors);
  const selected = orderedEligible[0];
  if (selected === undefined) {
    throw new Error("No eligible production configuration remains.");
  }
  const referenceEvidence = evidenceById.get(referenceDescriptor.configId);
  if (referenceEvidence === undefined) {
    throw new Error("Reference evidence disappeared during selection.");
  }
  const selectedDescriptor = descriptors.get(selected.configId);
  if (selectedDescriptor === undefined) {
    throw new Error("Selected descriptor disappeared during selection.");
  }
  const selectionMode: Phase8SelectionDecision["selectionMode"] =
    selectedDescriptor.role === "reference"
      ? "reference-fallback"
      : practicalTiePair(selected, referenceEvidence, descriptors)
        ? "practical-tie"
        : selected.terminalGate?.improvementGate === true
          ? "measured-improvement"
          : "lowest-terminal-estimate";

  const orderedFallbackConfigIds =
    selectedDescriptor.role === "reference"
      ? []
      : [
          ...orderedEligible
            .filter(
              (evidence) =>
                evidence.configId !== selected.configId &&
                evidence.configId !== referenceDescriptor.configId,
            )
            .map((evidence) => evidence.configId),
          referenceDescriptor.configId,
        ];

  const finalRule = phase8FinalEvaluationRule({
    referenceConfigId: referenceDescriptor.configId,
    selectedConfigId: selected.configId,
  });
  const projection = {
    schemaVersion: 1 as const,
    decisionVersion: "phase8-production-selection-v1" as const,
    manifestId: authority.manifest.manifestId,
    manifestSha256: authority.manifestSha256,
    referenceConfigId: referenceDescriptor.configId,
    selectedConfigId: selected.configId,
    selectionIsReference: selected.configId === referenceDescriptor.configId,
    selectionMode,
    eligibleConfigIds: eligibility
      .filter((assessment) => assessment.eligible)
      .map((assessment) => assessment.configId)
      .sort(),
    orderedFallbackConfigIds,
    eligibility,
    practicalTieMargin: PHASE8_PRACTICAL_TIE_MARGIN,
    tieBreakOrder: [
      "terminal-bhabhi-rate",
      "calibration-robustness-rank-within-practical-tie",
      "latency-p95",
      "enabled-component-count",
      "config-id",
    ] as const,
    finalRule,
  };
  return deepFreeze({
    ...projection,
    decisionSha256: phase8Sha256(projection),
    [PHASE8_SELECTION_DECISION_AUTHORITY]: true as const,
  });
}

export function verifyPhase8SelectionDecisionAuthority(value: unknown): true {
  if (
    value === null ||
    typeof value !== "object" ||
    Reflect.get(value, PHASE8_SELECTION_DECISION_AUTHORITY) !== true ||
    !Object.isFrozen(value)
  ) {
    throw new Error(
      "A genuine frozen Phase 8 selection decision authority is required.",
    );
  }
  const decision = value as Phase8SelectionDecision;
  const { decisionSha256, ...projection } = decision;
  if (decisionSha256 !== phase8Sha256(projection)) {
    throw new Error(
      "A genuine frozen Phase 8 selection decision authority is required.",
    );
  }
  return true;
}
