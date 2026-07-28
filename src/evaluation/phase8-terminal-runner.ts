import { createHash } from "node:crypto";

import type { RuleConfig } from "../domain/rule-config";
import { CANONICAL_RULES } from "../domain/rule-config";
import { stableHash, stableStringify } from "../events/stable-hash";
import { RuleViolation } from "../rules/rule-error";
import {
  createSeededDeal,
  simulateCompleteGame,
  SimulationRunError,
  type SimulationGameResult,
} from "../simulator/game";
import type { ScenarioSolverSeedSet } from "../simulator/evaluation-user-policy";
import { getBaselinePolicy } from "../simulator/policies";
import {
  deriveDealSeed,
  deriveStreamSeed,
  STYLE_CELLS,
  type StyleCell,
} from "./protocol";
import {
  deriveOpenedPhase8FinalSeed,
  verifyPhase8FinalManifestAuthority,
  type FrozenPhase8FinalManifestAuthority,
  type Phase8FinalSplitOpening,
} from "./phase8-final-manifest";
import {
  deriveOpenedPhase8Seed,
  phase8Sha256,
  verifyPhase8ManifestAuthority,
  type FrozenPhase8ManifestAuthority,
  type Phase8ConfigurationDescriptor,
  type Phase8ConfigurationRoleId,
  type Phase8HashBundle,
  type Phase8SplitOpening,
} from "./phase8-manifest";
import {
  PHASE8_TERMINAL_CONTINUATION_POLICY_HASH,
  PHASE8_TERMINAL_EXACT_CONFIG_HASH,
  PHASE8_TERMINAL_PHASE5_REFERENCE_CONFIG_HASH,
  PHASE8_TERMINAL_ROUTING_CONTRACTS,
  Phase8TerminalAnalysisError,
  createPhase8TerminalSearchPolicy,
  phase8TerminalRoleComponents,
  phase8TerminalRoleFallback,
  preflightPhase8TerminalConfigurations,
  type Phase8TerminalDecisionAudit,
  type Phase8TerminalPreflight,
  type Phase8TerminalRuntimeModel,
} from "./phase8-terminal-policy";
import {
  PHASE8_TERMINAL_DEV_EVIDENCE_CLASS,
  PHASE8_TERMINAL_EVIDENCE_CLASS,
  PHASE8_TERMINAL_RUNNER_VERSION,
  PHASE8_TERMINAL_SCHEMA_VERSION,
  phase8TerminalComponentAuditSchema,
  phase8TerminalDecisionRecordSchema,
  phase8TerminalFailureRecordSchema,
  phase8TerminalGameRecordSchema,
  phase8TerminalLatencyRecordSchema,
  phase8TerminalSeedRecordSchema,
  phase8TerminalSummaryInputSchema,
  phase8TerminalTruthRecordSchema,
  type Phase8TerminalAuthorityKind,
  type Phase8TerminalComponentAudit,
  type Phase8TerminalCoordinate,
  type Phase8TerminalDecisionRecord,
  type Phase8TerminalFailureRecord,
  type Phase8TerminalGameRecord,
  type Phase8TerminalLatencyRecord,
  type Phase8TerminalSeedRecord,
  type Phase8TerminalSummaryInput,
  type Phase8TerminalTruthRecord,
} from "./phase8-terminal-schema";

export type Phase8TerminalQualificationAuthority = Readonly<{
  kind: "qualification";
  authority: FrozenPhase8ManifestAuthority;
  opening: Phase8SplitOpening;
}>;

export type Phase8TerminalFinalAuthority = Readonly<{
  kind: "final";
  authority: FrozenPhase8FinalManifestAuthority;
  opening: Phase8FinalSplitOpening;
}>;

export type Phase8TerminalDevelopmentAuthority = Readonly<{
  kind: "development-pilot";
  authorityId: string;
  authoritySha256: string;
  disclosureAuthoritySha256: string;
}>;

export type Phase8TerminalSeedAuthority =
  | Phase8TerminalQualificationAuthority
  | Phase8TerminalFinalAuthority
  | Phase8TerminalDevelopmentAuthority;

export type Phase8TerminalPlan = Readonly<{
  schemaVersion: 1;
  protocolId: "eval-v1";
  runnerVersion: typeof PHASE8_TERMINAL_RUNNER_VERSION;
  runId: string;
  authorityKind: Phase8TerminalAuthorityKind;
  authorityManifestVersion: string;
  manifestId: string;
  manifestSha256: string;
  splitOpeningSha256: string;
  split: "dev" | "qualification" | "final";
  evidenceClass:
    | typeof PHASE8_TERMINAL_DEV_EVIDENCE_CLASS
    | typeof PHASE8_TERMINAL_EVIDENCE_CLASS;
  evidenceEligible: boolean;
  configurations: readonly Phase8ConfigurationDescriptor[];
  styleCells: readonly StyleCell[];
  baseIndexStart: 0;
  baseCount: number;
  rotations: readonly [0, 1, 2];
  replicate: 0;
  eventCap: number;
  rules: RuleConfig;
  hashes: Phase8HashBundle;
  seedAuthority: Phase8TerminalSeedAuthority;
  expectedScenarios: number;
  expectedGames: number;
}>;

export type Phase8TerminalScenarioSeeds = Readonly<{
  record: Readonly<{
    deal: string;
    userPolicy: string;
    p2Policy: string;
    p3Policy: string;
    environmentChance: string;
    belief: string;
    search: string;
    rollout: string;
    solverChance: string;
    bootstrap: string;
  }>;
  simulator: Readonly<{
    deal: string;
    userPolicy: string;
    p2Policy: string;
    p3Policy: string;
    chance: string;
  }>;
  solver: ScenarioSolverSeedSet;
}>;

export type Phase8TerminalScenarioResult = Readonly<{
  game: Phase8TerminalGameRecord | null;
  truth: Phase8TerminalTruthRecord | null;
  failure: Phase8TerminalFailureRecord | null;
  decisions: readonly Phase8TerminalDecisionRecord[];
  latencies: readonly Phase8TerminalLatencyRecord[];
  summaryInput: Phase8TerminalSummaryInput;
}>;

export type Phase8TerminalScenarioInput = Readonly<{
  plan: Phase8TerminalPlan;
  descriptor: Phase8ConfigurationDescriptor;
  model: Phase8TerminalRuntimeModel | null;
  styleCell: StyleCell;
  baseIndex: number;
  rotation: 0 | 1 | 2;
  deal: ReturnType<typeof createSeededDeal>;
  seeds: Phase8TerminalScenarioSeeds;
}>;

export type Phase8TerminalRunSink = {
  writeComponentAudit(record: Phase8TerminalComponentAudit): Promise<void>;
  writeSeed(record: Phase8TerminalSeedRecord): Promise<void>;
  writeScenario(result: Phase8TerminalScenarioResult): Promise<void>;
};

export type Phase8TerminalProgress = Readonly<{
  attemptedGames: number;
  expectedGames: number;
  completedGames: number;
  failedGames: number;
  current: Readonly<{
    configId: Phase8ConfigurationRoleId;
    styleCellId: string;
    baseIndex: number;
    rotation: 0 | 1 | 2;
  }>;
}>;

export type Phase8TerminalRunResult = Readonly<{
  started: boolean;
  preflight: Phase8TerminalPreflight;
  attemptedGames: number;
  completedGames: number;
  failedGames: number;
  expectedGames: number;
}>;

export type InMemoryPhase8TerminalSink = Phase8TerminalRunSink &
  Readonly<{
    componentAudits: Phase8TerminalComponentAudit[];
    seeds: Phase8TerminalSeedRecord[];
    games: Phase8TerminalGameRecord[];
    truths: Phase8TerminalTruthRecord[];
    failures: Phase8TerminalFailureRecord[];
    decisions: Phase8TerminalDecisionRecord[];
    latencies: Phase8TerminalLatencyRecord[];
    summaryInputs: Phase8TerminalSummaryInput[];
  }>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function requireRunId(value: string): void {
  if (value.trim().length === 0) {
    throw new RangeError("Phase 8 terminal runId must not be empty.");
  }
}

function requireBaseCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 512) {
    throw new RangeError(
      "Phase 8 terminal baseCount must be an integer from 1 through 512.",
    );
  }
}

function requireEventCap(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      "Phase 8 terminal eventCap must be a positive safe integer.",
    );
  }
}

function canonicalStyleCells(ids: readonly string[]): readonly StyleCell[] {
  const result = ids.map((id) => {
    const cell = STYLE_CELLS.find((candidate) => candidate.id === id);
    if (cell === undefined) {
      throw new Error(`Unknown Phase 8 style cell ${id}.`);
    }
    return cell;
  });
  if (
    result.length !== STYLE_CELLS.length ||
    stableStringify(result.map((cell) => cell.id)) !==
      stableStringify(STYLE_CELLS.map((cell) => cell.id))
  ) {
    throw new Error(
      "Phase 8 terminal matrices require the ordered complete 17-cell suite.",
    );
  }
  return Object.freeze(result);
}

function expectedCounts(input: {
  readonly configurations: readonly Phase8ConfigurationDescriptor[];
  readonly styleCells: readonly StyleCell[];
  readonly baseCount: number;
}): { readonly scenarios: number; readonly games: number } {
  const scenarios = input.styleCells.length * input.baseCount * 3;
  return {
    scenarios,
    games: scenarios * input.configurations.length,
  };
}

export function createPhase8TerminalAuthorityPlan(input: {
  readonly runId: string;
  readonly seedAuthority:
    Phase8TerminalQualificationAuthority | Phase8TerminalFinalAuthority;
}): Phase8TerminalPlan {
  requireRunId(input.runId);
  if (input.seedAuthority.kind === "qualification") {
    verifyPhase8ManifestAuthority(input.seedAuthority.authority);
    const { authority, opening } = input.seedAuthority;
    if (
      opening.split !== "qualification" ||
      opening.manifestId !== authority.manifest.manifestId ||
      opening.manifestSha256 !== authority.manifestSha256
    ) {
      throw new Error(
        "Terminal qualification plan requires the matching qualification opening.",
      );
    }
    const splitPlan = authority.manifest.splits.qualification;
    const styleCells = canonicalStyleCells(splitPlan.styleCellIds);
    const counts = expectedCounts({
      configurations: authority.manifest.configurations,
      styleCells,
      baseCount: splitPlan.baseCount,
    });
    return Object.freeze({
      schemaVersion: 1,
      protocolId: "eval-v1",
      runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
      runId: input.runId,
      authorityKind: "qualification",
      authorityManifestVersion: authority.manifest.manifestVersion,
      manifestId: authority.manifest.manifestId,
      manifestSha256: authority.manifestSha256,
      splitOpeningSha256: opening.openingSha256,
      split: "qualification",
      evidenceClass: PHASE8_TERMINAL_EVIDENCE_CLASS,
      evidenceEligible: true,
      configurations: authority.manifest.configurations,
      styleCells,
      baseIndexStart: 0,
      baseCount: splitPlan.baseCount,
      rotations: [0, 1, 2] as const,
      replicate: 0,
      eventCap: splitPlan.eventCap,
      rules: authority.manifest.rules,
      hashes: authority.manifest.hashes,
      seedAuthority: input.seedAuthority,
      expectedScenarios: counts.scenarios,
      expectedGames: counts.games,
    });
  }

  verifyPhase8FinalManifestAuthority(input.seedAuthority.authority);
  const { authority, opening } = input.seedAuthority;
  if (
    opening.manifestId !== authority.manifest.manifestId ||
    opening.manifestSha256 !== authority.manifestSha256
  ) {
    throw new Error("Terminal final plan requires the matching final opening.");
  }
  const splitPlan = authority.manifest.split;
  const styleCells = canonicalStyleCells(splitPlan.styleCellIds);
  const counts = expectedCounts({
    configurations: authority.manifest.configurations,
    styleCells,
    baseCount: splitPlan.baseCount,
  });
  return Object.freeze({
    schemaVersion: 1,
    protocolId: "eval-v1",
    runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    runId: input.runId,
    authorityKind: "final",
    authorityManifestVersion: authority.manifest.manifestVersion,
    manifestId: authority.manifest.manifestId,
    manifestSha256: authority.manifestSha256,
    splitOpeningSha256: opening.openingSha256,
    split: "final",
    evidenceClass: PHASE8_TERMINAL_EVIDENCE_CLASS,
    evidenceEligible: true,
    configurations: authority.manifest.configurations,
    styleCells,
    baseIndexStart: 0,
    baseCount: splitPlan.baseCount,
    rotations: [0, 1, 2] as const,
    replicate: 0,
    eventCap: splitPlan.eventCap,
    rules: authority.manifest.rules,
    hashes: authority.manifest.hashes,
    seedAuthority: input.seedAuthority,
    expectedScenarios: counts.scenarios,
    expectedGames: counts.games,
  });
}

export function createPhase8TerminalDevelopmentPlan(input: {
  readonly runId: string;
  readonly baseCount: number;
  readonly eventCap?: number;
  readonly configurations: readonly Phase8ConfigurationDescriptor[];
  readonly hashes: Phase8HashBundle;
  readonly disclosureAuthoritySha256: string;
}): Phase8TerminalPlan {
  requireRunId(input.runId);
  requireBaseCount(input.baseCount);
  const eventCap = input.eventCap ?? 4_096;
  requireEventCap(eventCap);
  requireSha256(
    input.disclosureAuthoritySha256,
    "Development disclosure authority",
  );
  if (input.configurations.length < 1 || input.configurations.length > 4) {
    throw new Error(
      "Development terminal pilot requires one through four frozen roles.",
    );
  }
  const styleCells = canonicalStyleCells(STYLE_CELLS.map((cell) => cell.id));
  const authorityProjection = {
    schemaVersion: 1,
    protocolId: "eval-v1",
    authorityKind: "development-pilot",
    seedNamespace: "dev",
    runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    runId: input.runId,
    baseCount: input.baseCount,
    eventCap,
    configurationIds: input.configurations.map(
      (configuration) => configuration.configId,
    ),
    configurationRegistrySha256: phase8Sha256(input.configurations),
    hashes: input.hashes,
    disclosureAuthoritySha256: input.disclosureAuthoritySha256,
  } as const;
  const authoritySha256 = phase8Sha256(authorityProjection);
  const authorityId = `phase8-terminal-dev-${authoritySha256.slice(0, 24)}`;
  const seedAuthority: Phase8TerminalDevelopmentAuthority = Object.freeze({
    kind: "development-pilot",
    authorityId,
    authoritySha256,
    disclosureAuthoritySha256: input.disclosureAuthoritySha256,
  });
  const counts = expectedCounts({
    configurations: input.configurations,
    styleCells,
    baseCount: input.baseCount,
  });
  return Object.freeze({
    schemaVersion: 1,
    protocolId: "eval-v1",
    runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    runId: input.runId,
    authorityKind: "development-pilot",
    authorityManifestVersion: "phase8-terminal-development-authority-v1",
    manifestId: authorityId,
    manifestSha256: authoritySha256,
    splitOpeningSha256: input.disclosureAuthoritySha256,
    split: "dev",
    evidenceClass: PHASE8_TERMINAL_DEV_EVIDENCE_CLASS,
    evidenceEligible: false,
    configurations: Object.freeze([...input.configurations]),
    styleCells,
    baseIndexStart: 0,
    baseCount: input.baseCount,
    rotations: [0, 1, 2] as const,
    replicate: 0,
    eventCap,
    rules: structuredClone(CANONICAL_RULES),
    hashes: input.hashes,
    seedAuthority,
    expectedScenarios: counts.scenarios,
    expectedGames: counts.games,
  });
}

function phase8DevelopmentSeed(input: {
  readonly stream:
    | "deal"
    | "user-policy"
    | "p2-policy"
    | "p3-policy"
    | "chance"
    | "belief"
    | "search"
    | "rollout"
    | "solver-chance"
    | "bootstrap";
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
}): string {
  if (input.stream === "deal") {
    return deriveDealSeed("dev", input.baseIndex);
  }
  if (
    input.stream === "p2-policy" ||
    input.stream === "p3-policy" ||
    input.stream === "chance"
  ) {
    return deriveStreamSeed({
      split: "dev",
      stream: input.stream,
      cell: input.styleCellId,
      baseIndex: input.baseIndex,
      rotation: input.rotation,
      replicate: 0,
    });
  }
  return createHash("sha256")
    .update(
      [
        "bhabhi/eval-v1",
        "dev",
        input.stream,
        "phase8-terminal-public",
        input.baseIndex.toString(),
        input.rotation.toString(),
        "0",
      ].join("|"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

function authoritySeed(
  plan: Phase8TerminalPlan,
  input: {
    readonly stream:
      | "deal"
      | "user-policy"
      | "p2-policy"
      | "p3-policy"
      | "chance"
      | "belief"
      | "search"
      | "rollout"
      | "solver-chance"
      | "bootstrap";
    readonly styleCellId: string;
    readonly baseIndex: number;
    readonly rotation: 0 | 1 | 2;
  },
): string {
  if (plan.seedAuthority.kind === "development-pilot") {
    return phase8DevelopmentSeed(input);
  }
  const coordinate = {
    stream: input.stream,
    styleCellId: input.styleCellId,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
    replicate: 0 as const,
  };
  return plan.seedAuthority.kind === "qualification"
    ? deriveOpenedPhase8Seed(
        plan.seedAuthority.authority,
        plan.seedAuthority.opening,
        coordinate,
      )
    : deriveOpenedPhase8FinalSeed(
        plan.seedAuthority.authority,
        plan.seedAuthority.opening,
        coordinate,
      );
}

export function derivePhase8TerminalScenarioSeeds(
  plan: Phase8TerminalPlan,
  input: {
    readonly styleCellId: string;
    readonly baseIndex: number;
    readonly rotation: 0 | 1 | 2;
  },
): Phase8TerminalScenarioSeeds {
  if (!plan.styleCells.some((cell) => cell.id === input.styleCellId)) {
    throw new Error("Terminal seed coordinate names a style outside the plan.");
  }
  if (
    !Number.isSafeInteger(input.baseIndex) ||
    input.baseIndex < 0 ||
    input.baseIndex >= plan.baseCount
  ) {
    throw new Error("Terminal seed coordinate is outside the plan.");
  }
  const seed = (
    stream: Parameters<typeof authoritySeed>[1]["stream"],
  ): string =>
    authoritySeed(plan, {
      ...input,
      stream,
    });
  const record = Object.freeze({
    deal: seed("deal"),
    userPolicy: seed("user-policy"),
    p2Policy: seed("p2-policy"),
    p3Policy: seed("p3-policy"),
    environmentChance: seed("chance"),
    belief: seed("belief"),
    search: seed("search"),
    rollout: seed("rollout"),
    solverChance: seed("solver-chance"),
    bootstrap: seed("bootstrap"),
  });
  return Object.freeze({
    record,
    simulator: Object.freeze({
      deal: record.deal,
      userPolicy: record.userPolicy,
      p2Policy: record.p2Policy,
      p3Policy: record.p3Policy,
      chance: record.environmentChance,
    }),
    solver: Object.freeze({
      belief: record.belief,
      search: record.search,
      rollout: record.rollout,
      chance: record.solverChance,
      bootstrap: record.bootstrap,
    }),
  });
}

function pairingKey(input: {
  readonly styleCellId: string;
  readonly rotation: 0 | 1 | 2;
}): string {
  return `${input.styleCellId}/${input.rotation.toString()}/0`;
}

function clusterId(split: Phase8TerminalPlan["split"], baseIndex: number) {
  return `${split}/${baseIndex.toString()}`;
}

function scenarioId(input: {
  readonly plan: Phase8TerminalPlan;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
}): string {
  return stableHash({
    schemaVersion: 1,
    protocolId: "eval-v1",
    runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    manifestSha256: input.plan.manifestSha256,
    split: input.plan.split,
    styleCellId: input.styleCellId,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
    replicate: 0,
  });
}

function coordinate(input: {
  readonly plan: Phase8TerminalPlan;
  readonly descriptor: Phase8ConfigurationDescriptor;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
}): Phase8TerminalCoordinate {
  const scenario = scenarioId(input);
  return {
    schemaVersion: PHASE8_TERMINAL_SCHEMA_VERSION,
    protocolId: "eval-v1",
    runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    evidenceClass: input.plan.evidenceClass,
    runId: input.plan.runId,
    authorityKind: input.plan.authorityKind,
    manifestId: input.plan.manifestId,
    manifestSha256: input.plan.manifestSha256,
    split: input.plan.split,
    configId: input.descriptor.configId,
    styleCellId: input.styleCellId,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
    replicate: 0,
    clusterId: clusterId(input.plan.split, input.baseIndex),
    pairingKey: pairingKey(input),
    scenarioId: scenario,
    gameId: stableHash({
      schemaVersion: 1,
      scenarioId: scenario,
      configId: input.descriptor.configId,
      configSha256: input.descriptor.configSha256,
    }),
  };
}

function seedRecord(input: {
  readonly plan: Phase8TerminalPlan;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly seeds: Phase8TerminalScenarioSeeds;
}): Phase8TerminalSeedRecord {
  const projection = {
    schemaVersion: PHASE8_TERMINAL_SCHEMA_VERSION,
    recordType: "phase8-terminal-seeds" as const,
    protocolId: "eval-v1" as const,
    runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    evidenceClass: input.plan.evidenceClass,
    runId: input.plan.runId,
    authorityKind: input.plan.authorityKind,
    manifestId: input.plan.manifestId,
    manifestSha256: input.plan.manifestSha256,
    split: input.plan.split,
    styleCellId: input.styleCellId,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
    replicate: 0 as const,
    clusterId: clusterId(input.plan.split, input.baseIndex),
    pairingKey: pairingKey(input),
    scenarioId: scenarioId(input),
    seedIds: input.seeds.record,
  };
  return phase8TerminalSeedRecordSchema.parse({
    ...projection,
    seedRecordSha256: phase8Sha256(projection),
  });
}

function terminalReason(result: SimulationGameResult): string {
  const terminal = [...result.finalState.effects]
    .reverse()
    .find((effect) => effect.type === "game-completed");
  if (terminal?.type !== "game-completed") {
    throw new Error("Completed Phase 8 game has no terminal effect.");
  }
  return terminal.reason;
}

function deterministicDecisionProjection(record: unknown): unknown {
  return record;
}

function decisionRecords(input: {
  readonly coordinate: Phase8TerminalCoordinate;
  readonly descriptor: Phase8ConfigurationDescriptor;
  readonly audits: readonly Phase8TerminalDecisionAudit[];
}): {
  readonly decisions: readonly Phase8TerminalDecisionRecord[];
  readonly latencies: readonly Phase8TerminalLatencyRecord[];
} {
  const components = phase8TerminalRoleComponents(input.descriptor.configId);
  const decisions: Phase8TerminalDecisionRecord[] = [];
  const latencies: Phase8TerminalLatencyRecord[] = [];
  for (const audit of input.audits) {
    const decisionId = `${input.coordinate.gameId}/${audit.eventIndex.toString()}`;
    const projection = {
      ...input.coordinate,
      components,
      configSha256: input.descriptor.configSha256,
      recordType: "phase8-terminal-decision" as const,
      decisionId,
      decisionOrdinal: audit.decisionOrdinal,
      eventIndex: audit.eventIndex,
      stateVersion: audit.stateVersion,
      publicHistoryHash: audit.publicHistoryHash,
      publicStateHash: audit.publicStateHash,
      observationHash: audit.observationHash,
      legalActions: audit.legalActions,
      legalActionKeys: audit.legalActionKeys,
      selectedAction: audit.selectedAction,
      selectedActionKey: audit.selectedActionKey,
      method: audit.method,
      quality: audit.quality,
      budgetId: "balanced" as const,
      candidates: audit.candidates,
      exact: audit.exact,
      behavior: audit.behavior,
      fallback: audit.fallback,
      work: audit.work,
      cancellationStatus: "not-cancelled" as const,
      warnings: audit.warnings,
      analysisInputHash: audit.analysisInputHash,
      analysisOutputHash: audit.analysisOutputHash,
    };
    decisions.push(
      phase8TerminalDecisionRecordSchema.parse({
        ...projection,
        deterministicDecisionHash: phase8Sha256(
          deterministicDecisionProjection(projection),
        ),
      }),
    );
    latencies.push(
      phase8TerminalLatencyRecordSchema.parse({
        ...input.coordinate,
        recordType: "phase8-terminal-latency",
        decisionId,
        decisionOrdinal: audit.decisionOrdinal,
        eventIndex: audit.eventIndex,
        method: audit.method,
        totalMs: audit.totalMs,
        exactAttemptMs: audit.exactAttemptMs,
        behaviorAttemptMs: audit.behaviorAttemptMs,
        fallbackMs: audit.fallbackMs,
        deadlineMs: audit.deadlineMs,
        deadlineExceeded: audit.deadlineExceeded,
      }),
    );
  }
  return { decisions, latencies };
}

function successfulRecords(input: {
  readonly coordinate: Phase8TerminalCoordinate;
  readonly descriptor: Phase8ConfigurationDescriptor;
  readonly result: SimulationGameResult;
  readonly solverDecisionCount: number;
  readonly gameWallTimeMs: number;
}): {
  readonly game: Phase8TerminalGameRecord;
  readonly truth: Phase8TerminalTruthRecord;
} {
  const userPosition = input.result.escapeOrder.indexOf("user") + 1;
  if (userPosition !== 1 && userPosition !== 2 && userPosition !== 3) {
    throw new Error("Completed Phase 8 game omitted the user's finish.");
  }
  const components = phase8TerminalRoleComponents(input.descriptor.configId);
  const deterministicGameProjection = {
    gameId: input.coordinate.gameId,
    events: input.result.events,
    bhabhi: input.result.bhabhi,
    escapeOrder: input.result.escapeOrder,
    terminalPublicStateHash: input.result.terminalPublicStateHash,
    deterministicOutcomeHash: input.result.outcomeHash,
  };
  const game = phase8TerminalGameRecordSchema.parse({
    ...input.coordinate,
    components,
    configSha256: input.descriptor.configSha256,
    recordType: "phase8-terminal-game",
    completionStatus: "complete",
    opponentPolicies: {
      p2: input.result.policies.p2,
      p3: input.result.policies.p3,
    },
    bhabhi: input.result.bhabhi,
    userBhabhi: input.result.bhabhi === "user",
    userFinishingPosition: userPosition,
    escapeOrder: input.result.escapeOrder,
    terminalReason: terminalReason(input.result),
    terminalHandCounts: input.result.finalState.handCounts,
    eventCount: input.result.eventCount,
    decisionCount: input.result.decisionCount,
    solverDecisionCount: input.solverDecisionCount,
    publicHistoryHash: input.result.semanticHistoryHash,
    terminalPublicStateHash: input.result.terminalPublicStateHash,
    deterministicOutcomeHash: input.result.outcomeHash,
    deterministicGameHash: phase8Sha256(deterministicGameProjection),
    events: input.result.events,
    gameWallTimeMs: input.gameWallTimeMs,
  });
  const truthProjection = {
    ...input.coordinate,
    recordType: "phase8-terminal-truth-eval-only" as const,
    initialHands: input.result.deal,
    finalHands: input.result.finalHands,
    terminalTruthHash: input.result.terminalTruthHash,
  };
  const truth = phase8TerminalTruthRecordSchema.parse({
    ...truthProjection,
    truthRecordSha256: phase8Sha256(truthProjection),
  });
  return { game, truth };
}

function classifyFailure(error: unknown): {
  readonly completionStatus:
    "failed" | "turn-cap" | "analysis-cap" | "cancelled";
  readonly kind:
    | "invariant"
    | "illegal-policy-action"
    | "exception"
    | "turn-cap"
    | "analysis-cap"
    | "cancellation";
  readonly stage:
    | "configuration-routing"
    | "search-analysis"
    | "complete-game-simulation"
    | "artifact-recording";
  readonly code: string | null;
} {
  if (error instanceof Phase8TerminalAnalysisError) {
    return {
      completionStatus: error.completionStatus,
      kind:
        error.completionStatus === "cancelled"
          ? "cancellation"
          : error.completionStatus === "analysis-cap"
            ? "analysis-cap"
            : error.code === "ILLEGAL_POLICY_ACTION"
              ? "illegal-policy-action"
              : "exception",
      stage: error.stage,
      code: error.code,
    };
  }
  if (error instanceof SimulationRunError) {
    if (error.code === "EVENT_CAP") {
      return {
        completionStatus: "turn-cap",
        kind: "turn-cap",
        stage: "complete-game-simulation",
        code: error.code,
      };
    }
    return {
      completionStatus: "failed",
      kind:
        error.code === "INVALID_POLICY_CHOICE"
          ? "illegal-policy-action"
          : "exception",
      stage: "complete-game-simulation",
      code: error.code,
    };
  }
  if (error instanceof RuleViolation && error.code === "INVARIANT_VIOLATION") {
    return {
      completionStatus: "failed",
      kind: "invariant",
      stage: "complete-game-simulation",
      code: error.code,
    };
  }
  const code =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : null;
  return code === "CANCELLED"
    ? {
        completionStatus: "cancelled",
        kind: "cancellation",
        stage: "search-analysis",
        code,
      }
    : {
        completionStatus: "failed",
        kind: "exception",
        stage: "complete-game-simulation",
        code,
      };
}

function failureRecord(input: {
  readonly coordinate: Phase8TerminalCoordinate;
  readonly descriptor: Phase8ConfigurationDescriptor;
  readonly audits: readonly Phase8TerminalDecisionAudit[];
  readonly error: unknown;
}): Phase8TerminalFailureRecord {
  const classification = classifyFailure(input.error);
  const errorName =
    input.error instanceof Error ? input.error.name : "UnknownError";
  const message =
    input.error instanceof Error
      ? input.error.message
      : "Unknown non-Error terminal-runner failure.";
  const simulationEventCount =
    input.error instanceof SimulationRunError ? input.error.eventCount : null;
  const lastGoodEventIndex =
    simulationEventCount === null
      ? input.audits.reduce(
          (maximum, audit) => Math.max(maximum, audit.eventIndex),
          -1,
        )
      : simulationEventCount - 1;
  const failureProjection = {
    gameId: input.coordinate.gameId,
    completionStatus: classification.completionStatus,
    kind: classification.kind,
    stage: classification.stage,
    code: classification.code,
    errorName,
    message,
    lastGoodEventIndex,
    retainedDecisionCount: input.audits.length,
  };
  const failureHash = phase8Sha256(failureProjection);
  return phase8TerminalFailureRecordSchema.parse({
    ...input.coordinate,
    components: phase8TerminalRoleComponents(input.descriptor.configId),
    configSha256: input.descriptor.configSha256,
    recordType: "phase8-terminal-failure",
    completionStatus: classification.completionStatus,
    failureId: `${input.coordinate.gameId}/${failureHash}`,
    kind: classification.kind,
    stage: classification.stage,
    code: classification.code,
    errorName,
    message,
    lastGoodEventIndex,
    retainedDecisionCount: input.audits.length,
    failureHash,
  });
}

function summaryInput(input: {
  readonly plan: Phase8TerminalPlan;
  readonly coordinate: Phase8TerminalCoordinate;
  readonly game: Phase8TerminalGameRecord | null;
  readonly failure: Phase8TerminalFailureRecord | null;
  readonly decisions: readonly Phase8TerminalDecisionRecord[];
}): Phase8TerminalSummaryInput {
  const exactUses = input.decisions.filter(
    (decision) => decision.exact.outcome === "used",
  ).length;
  const exactRefusals = input.decisions.filter(
    (decision) => decision.exact.outcome === "refused",
  ).length;
  const behaviorUses = input.decisions.filter(
    (decision) => decision.behavior.outcome === "used",
  ).length;
  const behaviorRefusals = input.decisions.filter(
    (decision) => decision.behavior.outcome === "refused",
  ).length;
  const projection = {
    schemaVersion: PHASE8_TERMINAL_SCHEMA_VERSION,
    recordType: "phase8-terminal-summary-input" as const,
    protocolId: "eval-v1" as const,
    runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    runId: input.plan.runId,
    split: input.plan.split,
    configId: input.coordinate.configId,
    styleCellId: input.coordinate.styleCellId,
    baseIndex: input.coordinate.baseIndex,
    rotation: input.coordinate.rotation,
    replicate: 0 as const,
    clusterId: input.coordinate.clusterId,
    pairingKey: input.coordinate.pairingKey,
    gameId: input.coordinate.gameId,
    status:
      input.game === null
        ? (input.failure?.completionStatus ?? "failed")
        : ("complete" as const),
    userBhabhi:
      input.game === null ? null : input.game.userBhabhi ? (1 as const) : 0,
    userFinishingPosition: input.game?.userFinishingPosition ?? null,
    eventCount:
      input.game?.eventCount ??
      Math.max(0, (input.failure?.lastGoodEventIndex ?? -1) + 1),
    decisionCount: input.game?.decisionCount ?? input.decisions.length,
    solverDecisionCount:
      input.game?.solverDecisionCount ?? input.decisions.length,
    exactUses,
    exactRefusals,
    behaviorUses,
    behaviorRefusals,
    terminalOutcomeHash: input.game?.deterministicOutcomeHash ?? null,
  };
  return phase8TerminalSummaryInputSchema.parse({
    ...projection,
    deterministicInputSha256: phase8Sha256(projection),
  });
}

export function runPhase8TerminalScenario(
  input: Phase8TerminalScenarioInput,
): Phase8TerminalScenarioResult {
  const coordinateValue = coordinate({
    plan: input.plan,
    descriptor: input.descriptor,
    styleCellId: input.styleCell.id,
    baseIndex: input.baseIndex,
    rotation: input.rotation,
  });
  let retainedAudits: readonly Phase8TerminalDecisionAudit[] = [];
  const startedAt = globalThis.performance.now();
  try {
    const policy = createPhase8TerminalSearchPolicy({
      descriptor: input.descriptor,
      model: input.model,
      solverSeeds: input.seeds.solver,
    });
    retainedAudits = policy.decisions;
    const result = simulateCompleteGame({
      gameId: coordinateValue.gameId,
      rules: input.plan.rules,
      rotation: input.rotation,
      deal: input.deal,
      seeds: {
        deal: input.seeds.simulator.deal,
        policy: {
          user: input.seeds.simulator.userPolicy,
          p2: input.seeds.simulator.p2Policy,
          p3: input.seeds.simulator.p3Policy,
        },
        chance: input.seeds.simulator.chance,
      },
      policies: {
        user: getBaselinePolicy("documented-basic"),
        p2: getBaselinePolicy(input.styleCell.p2),
        p3: getBaselinePolicy(input.styleCell.p3),
      },
      evaluationUserTimelinePolicy: policy.policyConfig,
      maxEvents: input.plan.eventCap,
    });
    const gameWallTimeMs = globalThis.performance.now() - startedAt;
    const records = successfulRecords({
      coordinate: coordinateValue,
      descriptor: input.descriptor,
      result,
      solverDecisionCount: policy.decisions.length,
      gameWallTimeMs,
    });
    const auditRecords = decisionRecords({
      coordinate: coordinateValue,
      descriptor: input.descriptor,
      audits: retainedAudits,
    });
    return Object.freeze({
      game: records.game,
      truth: records.truth,
      failure: null,
      decisions: auditRecords.decisions,
      latencies: auditRecords.latencies,
      summaryInput: summaryInput({
        plan: input.plan,
        coordinate: coordinateValue,
        game: records.game,
        failure: null,
        decisions: auditRecords.decisions,
      }),
    });
  } catch (error) {
    const auditRecords = decisionRecords({
      coordinate: coordinateValue,
      descriptor: input.descriptor,
      audits: retainedAudits,
    });
    const failure = failureRecord({
      coordinate: coordinateValue,
      descriptor: input.descriptor,
      audits: retainedAudits,
      error,
    });
    return Object.freeze({
      game: null,
      truth: null,
      failure,
      decisions: auditRecords.decisions,
      latencies: auditRecords.latencies,
      summaryInput: summaryInput({
        plan: input.plan,
        coordinate: coordinateValue,
        game: null,
        failure,
        decisions: auditRecords.decisions,
      }),
    });
  }
}

function componentAudit(input: {
  readonly plan: Phase8TerminalPlan;
  readonly preflightEntry: Phase8TerminalPreflight["entries"][number];
  readonly model: Phase8TerminalRuntimeModel | null;
}): Phase8TerminalComponentAudit {
  const descriptor = input.preflightEntry.descriptor;
  const components = phase8TerminalRoleComponents(descriptor.configId);
  const projection = {
    schemaVersion: PHASE8_TERMINAL_SCHEMA_VERSION,
    recordType: "phase8-terminal-component-audit" as const,
    protocolId: "eval-v1" as const,
    runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    runId: input.plan.runId,
    authorityKind: input.plan.authorityKind,
    manifestId: input.plan.manifestId,
    manifestSha256: input.plan.manifestSha256,
    split: input.plan.split,
    configId: descriptor.configId,
    configSha256: descriptor.configSha256,
    components,
    routingContract: PHASE8_TERMINAL_ROUTING_CONTRACTS[descriptor.configId],
    fallbackConfigId: phase8TerminalRoleFallback(descriptor.configId),
    exactConfigHash: components.exactEndgame
      ? PHASE8_TERMINAL_EXACT_CONFIG_HASH
      : null,
    phase5ReferenceConfigHash: PHASE8_TERMINAL_PHASE5_REFERENCE_CONFIG_HASH,
    continuationPolicyHash: PHASE8_TERMINAL_CONTINUATION_POLICY_HASH,
    productionModelSha256: components.behaviorWeighting
      ? (input.model?.sha256 ?? null)
      : null,
    modelSelectionContractHash: components.behaviorWeighting
      ? (input.model?.artifact.payload.modelSelectionContractHash ?? null)
      : null,
    separateOpponentPriors: components.behaviorWeighting,
    behaviorFailurePolicy: components.behaviorWeighting
      ? ("refuse" as const)
      : ("not-applicable" as const),
    preflightStatus: input.preflightEntry.eligible
      ? ("eligible" as const)
      : ("ineligible" as const),
    preflightReasons: input.preflightEntry.reasons,
  };
  return phase8TerminalComponentAuditSchema.parse({
    ...projection,
    auditSha256: phase8Sha256(projection),
  });
}

export async function runPhase8TerminalMatrix(input: {
  readonly plan: Phase8TerminalPlan;
  readonly serializedProductionModel: string;
  readonly sink: Phase8TerminalRunSink;
  readonly onProgress?: (progress: Phase8TerminalProgress) => void;
  readonly concurrency?: number;
  readonly scenarioExecutor?: (
    scenario: Phase8TerminalScenarioInput,
  ) => Promise<Phase8TerminalScenarioResult>;
}): Promise<Phase8TerminalRunResult> {
  const preflight = preflightPhase8TerminalConfigurations({
    configurations: input.plan.configurations,
    manifestModelSha256: input.plan.hashes.modelSha256,
    serializedProductionModel: input.serializedProductionModel,
  });
  for (const entry of preflight.entries) {
    await input.sink.writeComponentAudit(
      componentAudit({
        plan: input.plan,
        preflightEntry: entry,
        model: preflight.productionModel,
      }),
    );
  }
  if (!preflight.eligible) {
    return Object.freeze({
      started: false,
      preflight,
      attemptedGames: 0,
      completedGames: 0,
      failedGames: 0,
      expectedGames: input.plan.expectedGames,
    });
  }

  let attemptedGames = 0;
  let completedGames = 0;
  let failedGames = 0;
  const concurrency = input.concurrency ?? 1;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32
  ) {
    throw new RangeError(
      "Terminal matrix concurrency must be from 1 through 32.",
    );
  }
  const scenarios: Phase8TerminalScenarioInput[] = [];
  for (
    let baseIndex = input.plan.baseIndexStart;
    baseIndex < input.plan.baseCount;
    baseIndex += 1
  ) {
    for (const styleCell of input.plan.styleCells) {
      for (const rotation of input.plan.rotations) {
        // No seed is derived before the complete executable preflight passes.
        const seeds = derivePhase8TerminalScenarioSeeds(input.plan, {
          styleCellId: styleCell.id,
          baseIndex,
          rotation,
        });
        await input.sink.writeSeed(
          seedRecord({
            plan: input.plan,
            styleCellId: styleCell.id,
            baseIndex,
            rotation,
            seeds,
          }),
        );
        const deal = createSeededDeal(seeds.simulator.deal, rotation);
        for (const descriptor of input.plan.configurations) {
          scenarios.push({
            plan: input.plan,
            descriptor,
            model: preflight.productionModel,
            styleCell,
            baseIndex,
            rotation,
            deal,
            seeds,
          });
        }
      }
    }
  }
  const execute =
    input.scenarioExecutor ??
    ((
      scenario: Phase8TerminalScenarioInput,
    ): Promise<Phase8TerminalScenarioResult> =>
      Promise.resolve(runPhase8TerminalScenario(scenario)));
  for (let offset = 0; offset < scenarios.length; offset += concurrency) {
    const batch = scenarios.slice(offset, offset + concurrency);
    const results = await Promise.all(
      batch.map((scenario) => execute(scenario)),
    );
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const scenario = batch[index];
      if (result === undefined || scenario === undefined) {
        throw new Error(
          "Terminal scenario executor omitted an ordered result.",
        );
      }
      attemptedGames += 1;
      if (result.game === null) {
        failedGames += 1;
      } else {
        completedGames += 1;
      }
      await input.sink.writeScenario(result);
      input.onProgress?.({
        attemptedGames,
        expectedGames: input.plan.expectedGames,
        completedGames,
        failedGames,
        current: {
          configId: scenario.descriptor.configId,
          styleCellId: scenario.styleCell.id,
          baseIndex: scenario.baseIndex,
          rotation: scenario.rotation,
        },
      });
    }
  }
  if (attemptedGames !== input.plan.expectedGames) {
    throw new Error(
      "Phase 8 terminal runner attempted a cardinality different from its frozen plan.",
    );
  }
  return Object.freeze({
    started: true,
    preflight,
    attemptedGames,
    completedGames,
    failedGames,
    expectedGames: input.plan.expectedGames,
  });
}

export function createInMemoryPhase8TerminalSink(): InMemoryPhase8TerminalSink {
  const componentAudits: Phase8TerminalComponentAudit[] = [];
  const seeds: Phase8TerminalSeedRecord[] = [];
  const games: Phase8TerminalGameRecord[] = [];
  const truths: Phase8TerminalTruthRecord[] = [];
  const failures: Phase8TerminalFailureRecord[] = [];
  const decisions: Phase8TerminalDecisionRecord[] = [];
  const latencies: Phase8TerminalLatencyRecord[] = [];
  const summaryInputs: Phase8TerminalSummaryInput[] = [];
  return {
    componentAudits,
    seeds,
    games,
    truths,
    failures,
    decisions,
    latencies,
    summaryInputs,
    writeComponentAudit: (record): Promise<void> => {
      componentAudits.push(record);
      return Promise.resolve();
    },
    writeSeed: (record): Promise<void> => {
      seeds.push(record);
      return Promise.resolve();
    },
    writeScenario: (result): Promise<void> => {
      if (result.game !== null) {
        games.push(result.game);
      }
      if (result.truth !== null) {
        truths.push(result.truth);
      }
      if (result.failure !== null) {
        failures.push(result.failure);
      }
      decisions.push(...result.decisions);
      latencies.push(...result.latencies);
      summaryInputs.push(result.summaryInput);
      return Promise.resolve();
    },
  };
}

export function phase8TerminalPlanScientificHash(
  plan: Phase8TerminalPlan,
): string {
  return sha256(
    stableStringify({
      schemaVersion: plan.schemaVersion,
      protocolId: plan.protocolId,
      runnerVersion: plan.runnerVersion,
      authorityKind: plan.authorityKind,
      authorityManifestVersion: plan.authorityManifestVersion,
      manifestId: plan.manifestId,
      manifestSha256: plan.manifestSha256,
      splitOpeningSha256: plan.splitOpeningSha256,
      split: plan.split,
      evidenceClass: plan.evidenceClass,
      evidenceEligible: plan.evidenceEligible,
      configurations: plan.configurations,
      styleCells: plan.styleCells,
      baseIndexStart: plan.baseIndexStart,
      baseCount: plan.baseCount,
      rotations: plan.rotations,
      replicate: plan.replicate,
      eventCap: plan.eventCap,
      rules: plan.rules,
      hashes: plan.hashes,
      expectedScenarios: plan.expectedScenarios,
      expectedGames: plan.expectedGames,
    }),
  );
}
