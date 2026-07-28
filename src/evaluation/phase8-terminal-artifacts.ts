import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { once } from "node:events";

import { ACE_OF_SPADES } from "../domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../domain/rule-config";
import { SEATS } from "../domain/seats";
import type { GameEvent } from "../events/game-events";
import { stableHash, stableStringify } from "../events/stable-hash";
import { replayEvents, semanticHistoryHash } from "../events/timeline";
import { parsePhase8HardOnlyModel } from "../modeling/hard-only-model";
import { createPolicyObservation } from "../simulator/game";
import {
  applyTruthCardPlay,
  applyTruthHandTaken,
  applyTruthPlayerDraw,
  applyTruthWasteDraw,
  assertSimulationTruthInvariant,
  createSimulationTruth,
  type SimulationTruth,
} from "../simulator/truth";
import {
  phase8Sha256,
  type Phase8ConfigurationDescriptor,
  type Phase8ConfigurationRoleId,
  type Phase8Json,
} from "./phase8-manifest";
import {
  PHASE8_TERMINAL_BEHAVIOR_EXACT_ID,
  PHASE8_TERMINAL_BEHAVIOR_ID,
  PHASE8_TERMINAL_EXACT_ID,
  PHASE8_TERMINAL_REFERENCE_ID,
  PHASE8_TERMINAL_ROUTING_CONTRACTS,
  parsePhase8TerminalProductionModel,
  phase8TerminalRoleComponents,
  phase8TerminalRoleFallback,
} from "./phase8-terminal-policy";
import { STYLE_CELLS } from "./protocol";
import {
  phase8TerminalPlanScientificHash,
  type Phase8TerminalPlan,
  type Phase8TerminalRunResult,
  type Phase8TerminalRunSink,
  type Phase8TerminalScenarioResult,
} from "./phase8-terminal-runner";
import {
  PHASE8_TERMINAL_RUNNER_VERSION,
  PHASE8_TERMINAL_SCHEMA_VERSION,
  phase8TerminalComponentAuditSchema,
  phase8TerminalDecisionRecordSchema,
  phase8TerminalFailureRecordSchema,
  phase8TerminalGameRecordSchema,
  phase8TerminalLatencyRecordSchema,
  phase8TerminalRunManifestSchema,
  phase8TerminalSeedRecordSchema,
  phase8TerminalSummaryInputSchema,
  phase8TerminalSummarySchema,
  phase8TerminalTruthRecordSchema,
  type Phase8TerminalComponentAudit,
  type Phase8TerminalDecisionRecord,
  type Phase8TerminalGameRecord,
  type Phase8TerminalRunManifest,
  type Phase8TerminalSeedRecord,
  type Phase8TerminalSummary,
  type Phase8TerminalSummaryInput,
  type Phase8TerminalTruthRecord,
} from "./phase8-terminal-schema";

export const PHASE8_TERMINAL_RAW_FILES = Object.freeze([
  "seeds.ndjson",
  "games.ndjson",
  "decisions.ndjson",
  "truth.eval-only.ndjson",
  "latency.ndjson",
  "failures.ndjson",
  "components.ndjson",
  "summary-inputs.ndjson",
] as const);

export const PHASE8_TERMINAL_PAYLOAD_FILES = Object.freeze([
  "authority.json",
  "opening.json",
  "production-model.json",
  "manifest.json",
  "environment.json",
  ...PHASE8_TERMINAL_RAW_FILES,
  "summary.json",
  "summary.md",
  "command.txt",
] as const);

export const PHASE8_TERMINAL_ALL_FILES = Object.freeze([
  ...PHASE8_TERMINAL_PAYLOAD_FILES,
  "checksums.sha256",
] as const);

type RawFileName = (typeof PHASE8_TERMINAL_RAW_FILES)[number];

export type Phase8TerminalArtifactVerification = Readonly<{
  ok: boolean;
  runDirectory: string;
  failures: readonly string[];
  summary: Phase8TerminalSummary | null;
  manifest: Phase8TerminalRunManifest | null;
}>;

export type Phase8TerminalArtifactSession = Readonly<{
  stageDirectory: string;
  runDirectory: string;
  sink: Phase8TerminalRunSink;
  finalize(
    result: Phase8TerminalRunResult,
  ): Promise<Phase8TerminalArtifactVerification>;
}>;

type InspectionContract = Readonly<{
  runId: string;
  authorityKind: Phase8TerminalRunManifest["authorityKind"];
  manifestId: string;
  manifestSha256: string;
  split: Phase8TerminalRunManifest["split"];
  evidenceClass: Phase8TerminalRunManifest["evidenceClass"];
  evidenceEligible: boolean;
  configurations: readonly Phase8ConfigurationDescriptor[];
  styleCellIds: readonly string[];
  baseIndexStart: 0;
  baseCount: number;
  rotations: readonly [0, 1, 2];
  replicate: 0;
  expectedScenarios: number;
  expectedGames: number;
  rules: RuleConfig;
  planScientificSha256: string;
  seedPolicyId: string;
  productionModelSha256: string;
}>;

type RawInspection = Readonly<{
  failures: readonly string[];
  summary: Phase8TerminalSummary;
}>;

type ZodLike<T> = Readonly<{
  parse(value: unknown): T;
}>;

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifyProductionModelBytes(
  serialized: string,
  expectedSha256: string,
  configurations: readonly Phase8ConfigurationDescriptor[],
): void {
  if (sha256Bytes(serialized) !== expectedSha256) {
    throw new Error("Production-model byte hash does not match manifest.");
  }
  if (
    configurations.some(
      (configuration) => configuration.components.behaviorWeighting,
    )
  ) {
    parsePhase8TerminalProductionModel(serialized);
  } else {
    try {
      parsePhase8HardOnlyModel(serialized);
    } catch {
      parsePhase8TerminalProductionModel(serialized);
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${stableStringify(value)}\n`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
}

function safeRunDirectory(
  rootDirectory: string,
  runId: string,
): {
  readonly root: string;
  readonly final: string;
  readonly stage: string;
} {
  if (
    runId.trim().length === 0 ||
    basename(runId) !== runId ||
    runId === "." ||
    runId === ".."
  ) {
    throw new Error("Artifact runId must be one safe path segment.");
  }
  const root = resolve(rootDirectory);
  const final = resolve(root, runId);
  const stage = resolve(root, `.incomplete-${runId}`);
  if (dirname(final) !== root || dirname(stage) !== root) {
    throw new Error("Artifact target escaped its explicit root.");
  }
  return { root, final, stage };
}

async function writeStreamLine(
  stream: WriteStream,
  value: unknown,
): Promise<void> {
  if (!stream.write(canonicalJson(value), "utf8")) {
    await once(stream, "drain");
  }
}

async function closeStream(stream: WriteStream): Promise<void> {
  stream.end();
  await finished(stream);
}

async function* parseNdjson<T>(
  path: string,
  schema: ZodLike<T>,
): AsyncGenerator<T> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim().length === 0) {
      throw new Error(
        `${basename(path)} contains an empty line at ${lineNumber.toString()}.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (cause) {
      throw new Error(
        `${basename(path)} line ${lineNumber.toString()} is not JSON.`,
        { cause },
      );
    }
    try {
      yield schema.parse(parsed);
    } catch (cause) {
      throw new Error(
        `${basename(path)} line ${lineNumber.toString()} failed schema validation.`,
        { cause },
      );
    }
  }
}

class AsyncCursor<T> {
  readonly iterator: AsyncIterator<T>;
  private buffered: IteratorResult<T> | null = null;

  constructor(iterable: AsyncIterable<T>) {
    this.iterator = iterable[Symbol.asyncIterator]();
  }

  async peek(): Promise<T | null> {
    this.buffered ??= await this.iterator.next();
    return this.buffered.done ? null : this.buffered.value;
  }

  async take(): Promise<T | null> {
    const value = await this.peek();
    this.buffered = null;
    return value;
  }
}

function sameCoordinate(
  left: {
    readonly runId: string;
    readonly split: string;
    readonly configId: string;
    readonly styleCellId: string;
    readonly baseIndex: number;
    readonly rotation: number;
    readonly replicate: number;
    readonly gameId: string;
  },
  right: {
    readonly runId: string;
    readonly split: string;
    readonly configId: string;
    readonly styleCellId: string;
    readonly baseIndex: number;
    readonly rotation: number;
    readonly replicate: number;
    readonly gameId: string;
  },
): boolean {
  return (
    left.runId === right.runId &&
    left.split === right.split &&
    left.configId === right.configId &&
    left.styleCellId === right.styleCellId &&
    left.baseIndex === right.baseIndex &&
    left.rotation === right.rotation &&
    left.replicate === right.replicate &&
    left.gameId === right.gameId
  );
}

function matrixCoordinate(value: {
  readonly configId: string;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: number;
  readonly replicate: number;
}): string {
  return [
    value.configId,
    value.styleCellId,
    value.baseIndex.toString(),
    value.rotation.toString(),
    value.replicate.toString(),
  ].join("/");
}

function expectedScenarioId(
  contract: InspectionContract,
  value: {
    readonly styleCellId: string;
    readonly baseIndex: number;
    readonly rotation: number;
    readonly replicate: number;
  },
): string {
  return stableHash({
    schemaVersion: 1,
    protocolId: "eval-v1",
    runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    manifestSha256: contract.manifestSha256,
    split: contract.split,
    styleCellId: value.styleCellId,
    baseIndex: value.baseIndex,
    rotation: value.rotation,
    replicate: value.replicate,
  });
}

function validateExpectedCoordinate(
  value: {
    readonly configId: Phase8ConfigurationRoleId;
    readonly styleCellId: string;
    readonly baseIndex: number;
    readonly rotation: number;
    readonly replicate: number;
    readonly clusterId: string;
    readonly pairingKey: string;
    readonly scenarioId?: string;
    readonly gameId: string;
    readonly configSha256?: string;
  },
  contract: InspectionContract,
  label: string,
  failures: string[],
): void {
  const descriptor = contract.configurations.find(
    (candidate) => candidate.configId === value.configId,
  );
  const scenario = expectedScenarioId(contract, value);
  const expectedGameId =
    descriptor === undefined
      ? null
      : stableHash({
          schemaVersion: 1,
          scenarioId: scenario,
          configId: descriptor.configId,
          configSha256: descriptor.configSha256,
        });
  if (
    descriptor === undefined ||
    !contract.styleCellIds.includes(value.styleCellId) ||
    value.baseIndex < contract.baseIndexStart ||
    value.baseIndex >= contract.baseIndexStart + contract.baseCount ||
    !contract.rotations.includes(value.rotation as 0 | 1 | 2) ||
    value.replicate !== contract.replicate ||
    value.clusterId !== `${contract.split}/${value.baseIndex.toString()}` ||
    value.pairingKey !==
      `${value.styleCellId}/${value.rotation.toString()}/0` ||
    (value.scenarioId !== undefined && value.scenarioId !== scenario) ||
    value.gameId !== expectedGameId ||
    (value.configSha256 !== undefined &&
      value.configSha256 !== descriptor.configSha256)
  ) {
    failures.push(`${label} has a noncanonical matrix identity.`);
  }
}

function quantile(
  values: readonly number[],
  probability: number,
): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(probability * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

function sampleStandardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sumSquares = values.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  );
  return Math.sqrt(sumSquares / (values.length - 1));
}

function applyTruthEvent(
  simulation: SimulationTruth,
  event: Exclude<GameEvent, { readonly type: "game-created" }>,
  eventIndex: number,
): SimulationTruth {
  switch (event.type) {
    case "card-played":
      return applyTruthCardPlay(simulation, event, eventIndex);
    case "waste-card-drawn":
      return applyTruthWasteDraw(simulation, event, eventIndex);
    case "player-card-drawn":
      return applyTruthPlayerDraw(simulation, event, eventIndex);
    case "hand-taken":
      return applyTruthHandTaken(simulation, event, eventIndex);
  }
}

type ExpectedUserDecision = Readonly<{
  eventIndex: number;
  decisionOrdinal: number;
  publicHistoryHash: string;
  publicStateHash: string;
  observationHash: string;
  legalActionKeys: readonly string[];
  selectedActionKey: string;
}>;

function actionKeyForEvent(event: GameEvent): string | null {
  if (event.type === "card-played" && event.seat === "user") {
    return `play:${event.card}`;
  }
  if (event.type === "hand-taken" && event.actor === "user") {
    return `take:${event.target}`;
  }
  return null;
}

function expectedUserDecisions(input: {
  readonly rules: RuleConfig;
  readonly game: Phase8TerminalGameRecord;
  readonly truth: Phase8TerminalTruthRecord;
}): readonly ExpectedUserDecision[] {
  const setup = input.game.events[0];
  if (setup?.type !== "game-created") {
    throw new Error(`${input.game.gameId} has no game-created setup.`);
  }
  const aceSpadesHolder = SEATS.find((seat) =>
    input.truth.initialHands[seat].includes(ACE_OF_SPADES),
  );
  if (
    stableStringify(setup.rules) !== stableStringify(input.rules) ||
    stableStringify(setup.userHand) !==
      stableStringify(input.truth.initialHands.user) ||
    stableStringify(setup.startingCounts) !==
      stableStringify({
        user: input.truth.initialHands.user.length,
        p2: input.truth.initialHands.p2.length,
        p3: input.truth.initialHands.p3.length,
      }) ||
    setup.aceSpadesHolder !== aceSpadesHolder
  ) {
    throw new Error(`${input.game.gameId} setup/truth binding failed.`);
  }

  let simulation = createSimulationTruth(input.truth.initialHands, input.rules);
  const expected: ExpectedUserDecision[] = [];
  let userDecisionOrdinal = 0;
  for (
    let eventIndex = 1;
    eventIndex < input.game.events.length;
    eventIndex += 1
  ) {
    const event = input.game.events[eventIndex];
    if (event === undefined || event.type === "game-created") {
      throw new Error(
        `${input.game.gameId} has invalid event ${eventIndex.toString()}.`,
      );
    }
    const selectedActionKey = actionKeyForEvent(event);
    if (selectedActionKey !== null) {
      const observation = createPolicyObservation(
        simulation,
        "user",
        userDecisionOrdinal,
        input.game.events.slice(0, eventIndex),
      );
      expected.push({
        eventIndex,
        decisionOrdinal: userDecisionOrdinal,
        publicHistoryHash: semanticHistoryHash(
          input.game.events.slice(0, eventIndex),
        ),
        publicStateHash: stableHash(simulation.publicState),
        observationHash: stableHash(observation),
        legalActionKeys: [
          ...observation.legalCards.map((card) => `play:${card}`),
          ...(observation.legalTakeTargets ?? []).map(
            (target) => `take:${target}`,
          ),
        ],
        selectedActionKey,
      });
      userDecisionOrdinal += 1;
    }
    simulation = applyTruthEvent(simulation, event, eventIndex);
  }
  assertSimulationTruthInvariant(simulation);
  if (
    stableStringify(simulation.hands) !==
      stableStringify(input.truth.finalHands) ||
    stableHash({
      hands: simulation.hands,
      publicState: simulation.publicState,
    }) !== input.truth.terminalTruthHash
  ) {
    throw new Error(`${input.game.gameId} terminal truth replay failed.`);
  }
  const publicReplay = replayEvents(input.game.events);
  if (
    publicReplay.semanticHash !== input.game.publicHistoryHash ||
    stableHash(publicReplay.state) !== input.game.terminalPublicStateHash ||
    stableStringify(publicReplay.state) !==
      stableStringify(simulation.publicState) ||
    publicReplay.state.bhabhi !== input.game.bhabhi ||
    stableStringify(publicReplay.state.handCounts) !==
      stableStringify(input.game.terminalHandCounts)
  ) {
    throw new Error(`${input.game.gameId} public replay failed.`);
  }
  const deterministicGameProjection = {
    gameId: input.game.gameId,
    events: input.game.events,
    bhabhi: input.game.bhabhi,
    escapeOrder: input.game.escapeOrder,
    terminalPublicStateHash: input.game.terminalPublicStateHash,
    deterministicOutcomeHash: input.game.deterministicOutcomeHash,
  };
  if (
    input.game.deterministicGameHash !==
    phase8Sha256(deterministicGameProjection)
  ) {
    throw new Error(`${input.game.gameId} deterministic game hash failed.`);
  }
  const { truthRecordSha256, ...truthProjection } = input.truth;
  if (truthRecordSha256 !== phase8Sha256(truthProjection)) {
    throw new Error(`${input.game.gameId} truth sidecar hash failed.`);
  }
  return expected;
}

function validateDecisionRouting(
  decision: Phase8TerminalDecisionRecord,
  contract: InspectionContract,
  failures: string[],
): void {
  const expectedComponents = phase8TerminalRoleComponents(decision.configId);
  if (
    stableStringify(decision.components) !== stableStringify(expectedComponents)
  ) {
    failures.push(`${decision.decisionId} component flags drifted.`);
  }
  const selectedCount = decision.legalActionKeys.filter(
    (key) => key === decision.selectedActionKey,
  ).length;
  const actionKey = (action: Phase8TerminalDecisionRecord["selectedAction"]) =>
    action.kind === "play-card"
      ? `play:${action.card}`
      : `take:${action.target}`;
  if (
    selectedCount !== 1 ||
    actionKey(decision.selectedAction) !== decision.selectedActionKey ||
    stableStringify(decision.legalActions.map(actionKey)) !==
      stableStringify(decision.legalActionKeys) ||
    new Set(decision.legalActionKeys).size !==
      decision.legalActionKeys.length ||
    new Set(decision.candidates.map((candidate) => candidate.actionKey))
      .size !== decision.legalActionKeys.length ||
    decision.candidates.some(
      (candidate) => !decision.legalActionKeys.includes(candidate.actionKey),
    )
  ) {
    failures.push(`${decision.decisionId} legal/candidate coverage failed.`);
  }
  const fallbackShapeValid = decision.fallback.used
    ? decision.fallback.targetConfigId !== null &&
      decision.fallback.reasonCode !== null &&
      decision.fallback.byteIdenticalRequestHash !== null
    : decision.fallback.targetConfigId === null &&
      decision.fallback.reasonCode === null &&
      decision.fallback.byteIdenticalRequestHash === null;
  if (!fallbackShapeValid) {
    failures.push(`${decision.decisionId} fallback audit is incomplete.`);
  }
  const routeFailure = (message: string): void => {
    failures.push(`${decision.decisionId} ${message}`);
  };
  switch (decision.configId) {
    case PHASE8_TERMINAL_REFERENCE_ID:
      if (
        decision.method !== "phase5-hard-only" ||
        decision.quality !== "Approximate" ||
        decision.exact.outcome !== "not-attempted" ||
        decision.behavior.outcome !== "not-attempted" ||
        decision.fallback.used ||
        decision.fallback.targetConfigId !== null ||
        decision.fallback.reasonCode !== null ||
        decision.fallback.byteIdenticalRequestHash !== null
      ) {
        routeFailure("did not execute the direct R route.");
      }
      break;
    case PHASE8_TERMINAL_EXACT_ID:
      if (
        decision.method !== "exact-hard" ||
        decision.behavior.outcome !== "not-attempted" ||
        decision.exact.outcome === "not-attempted" ||
        (decision.exact.outcome === "used" &&
          (decision.quality !== "Exact" || decision.fallback.used)) ||
        (decision.exact.outcome === "refused" &&
          (!decision.fallback.used ||
            decision.fallback.targetConfigId !== PHASE8_TERMINAL_REFERENCE_ID ||
            decision.fallback.reasonCode === null ||
            decision.fallback.byteIdenticalRequestHash === null ||
            decision.quality !== "Approximate"))
      ) {
        routeFailure("did not execute exact-hard then R.");
      }
      break;
    case PHASE8_TERMINAL_BEHAVIOR_ID:
      if (
        decision.method !== "behavior-weighted" ||
        decision.quality !== "Approximate" ||
        decision.exact.outcome !== "not-attempted" ||
        decision.behavior.outcome !== "used" ||
        decision.behavior.modelSha256 !== contract.productionModelSha256 ||
        decision.fallback.used
      ) {
        routeFailure("did not execute behavior-weighted with refusal.");
      }
      break;
    case PHASE8_TERMINAL_BEHAVIOR_EXACT_ID:
      if (
        decision.method !== "exact-behavior" ||
        decision.behavior.outcome !== "used" ||
        decision.behavior.modelSha256 !== contract.productionModelSha256 ||
        decision.exact.outcome === "not-attempted" ||
        (decision.exact.outcome === "used" &&
          (decision.quality !== "Exact" || decision.fallback.used)) ||
        (decision.exact.outcome === "refused" &&
          (!decision.fallback.used ||
            decision.fallback.targetConfigId !== PHASE8_TERMINAL_BEHAVIOR_ID ||
            decision.fallback.reasonCode === null ||
            decision.fallback.byteIdenticalRequestHash === null ||
            decision.quality !== "Approximate"))
      ) {
        routeFailure("did not execute behavior-exact then B.");
      }
      break;
  }
  const { deterministicDecisionHash, ...projection } = decision;
  if (deterministicDecisionHash !== phase8Sha256(projection)) {
    failures.push(`${decision.decisionId} deterministic hash failed.`);
  }
}

function validateExpectedDecision(
  decision: Phase8TerminalDecisionRecord,
  expected: ExpectedUserDecision,
  failures: string[],
): void {
  if (
    decision.eventIndex !== expected.eventIndex ||
    decision.stateVersion !== expected.eventIndex ||
    decision.decisionOrdinal !== expected.decisionOrdinal ||
    decision.publicHistoryHash !== expected.publicHistoryHash ||
    decision.publicStateHash !== expected.publicStateHash ||
    decision.observationHash !== expected.observationHash ||
    stableStringify(decision.legalActionKeys) !==
      stableStringify(expected.legalActionKeys) ||
    decision.selectedActionKey !== expected.selectedActionKey
  ) {
    failures.push(`${decision.decisionId} public decision replay failed.`);
  }
}

function expectedSeed(input: {
  readonly contract: InspectionContract;
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
  if (input.contract.split === "dev") {
    if (input.stream === "deal") {
      return createHash("sha256")
        .update(`bhabhi/eval-v1|dev|deal|${input.baseIndex.toString()}`, "utf8")
        .digest("hex")
        .slice(0, 32);
    }
    if (
      input.stream === "p2-policy" ||
      input.stream === "p3-policy" ||
      input.stream === "chance"
    ) {
      return createHash("sha256")
        .update(
          [
            "bhabhi/eval-v1",
            "dev",
            input.stream,
            input.styleCellId,
            input.baseIndex.toString(),
            input.rotation.toString(),
            "0",
          ].join("|"),
          "utf8",
        )
        .digest("hex")
        .slice(0, 32);
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
  const material =
    input.stream === "deal"
      ? [input.baseIndex.toString()]
      : input.stream === "user-policy" ||
          input.stream === "belief" ||
          input.stream === "search" ||
          input.stream === "rollout" ||
          input.stream === "solver-chance" ||
          input.stream === "bootstrap"
        ? [input.baseIndex.toString(), input.rotation.toString(), "0"]
        : [
            input.styleCellId,
            input.baseIndex.toString(),
            input.rotation.toString(),
            "0",
          ];
  return createHash("sha256")
    .update(
      ["bhabhi/eval-v1", input.contract.split, input.stream, ...material].join(
        "|",
      ),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

function expectedSeedIds(input: {
  readonly contract: InspectionContract;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
}): Phase8TerminalSeedRecord["seedIds"] {
  const seed = (stream: Parameters<typeof expectedSeed>[0]["stream"]): string =>
    expectedSeed({ ...input, stream });
  return {
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
  };
}

function validateCommonIdentity(
  value: {
    readonly runId: string;
    readonly manifestId?: string;
    readonly manifestSha256?: string;
    readonly split: string;
  },
  contract: InspectionContract,
  label: string,
  failures: string[],
): void {
  if (
    value.runId !== contract.runId ||
    value.split !== contract.split ||
    (value.manifestId !== undefined &&
      value.manifestId !== contract.manifestId) ||
    (value.manifestSha256 !== undefined &&
      value.manifestSha256 !== contract.manifestSha256)
  ) {
    failures.push(`${label} is bound to a different run authority.`);
  }
}

function matrixValidation(
  contract: InspectionContract,
  values: readonly Phase8TerminalSummaryInput[],
): Phase8TerminalSummary["matrix"] {
  const configurationIds = contract.configurations.map(
    (configuration) => configuration.configId,
  );
  const expected = new Set<string>();
  for (const configId of configurationIds) {
    for (const styleCellId of contract.styleCellIds) {
      for (let baseIndex = 0; baseIndex < contract.baseCount; baseIndex += 1) {
        for (const rotation of contract.rotations) {
          expected.add(
            matrixCoordinate({
              configId,
              styleCellId,
              baseIndex,
              rotation,
              replicate: 0,
            }),
          );
        }
      }
    }
  }
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unexpected: string[] = [];
  let unexpectedCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;
  let turnCapCount = 0;
  let analysisCapCount = 0;
  let cancellationCount = 0;
  for (const value of values) {
    const key = matrixCoordinate(value);
    if (!expected.has(key)) {
      unexpectedCount += 1;
      if (unexpected.length < 100) {
        unexpected.push(key);
      }
    } else if (seen.has(key)) {
      duplicateCount += 1;
      duplicates.add(key);
    } else {
      seen.add(key);
    }
    if (value.status === "failed") {
      failedCount += 1;
    } else if (value.status === "turn-cap") {
      turnCapCount += 1;
    } else if (value.status === "analysis-cap") {
      analysisCapCount += 1;
    } else if (value.status === "cancelled") {
      cancellationCount += 1;
    }
  }
  const missing = [...expected].filter((key) => !seen.has(key));
  const completeMatrixGate =
    missing.length === 0 &&
    unexpectedCount === 0 &&
    duplicateCount === 0 &&
    seen.size === expected.size;
  const zeroFailureGate = failedCount === 0;
  const zeroCapGate = turnCapCount === 0 && analysisCapCount === 0;
  const zeroCancellationGate = cancellationCount === 0;
  return {
    expectedOutcomes: expected.size,
    observedOutcomes: values.length,
    uniqueExpectedCoordinatesObserved: seen.size,
    missingCount: missing.length,
    unexpectedCount,
    duplicateCount,
    failedCount,
    turnCapCount,
    analysisCapCount,
    cancellationCount,
    missingCoordinates: missing.slice(0, 100),
    unexpectedCoordinates: unexpected,
    duplicateCoordinates: [...duplicates].slice(0, 100),
    diagnosticsTruncated:
      missing.length > 100 || unexpectedCount > 100 || duplicates.size > 100,
    completeMatrixGate,
    zeroFailureGate,
    zeroCapGate,
    zeroCancellationGate,
    evidenceGate:
      completeMatrixGate &&
      zeroFailureGate &&
      zeroCapGate &&
      zeroCancellationGate,
  };
}

function terminalAggregates(input: {
  readonly contract: InspectionContract;
  readonly summaryInputs: readonly Phase8TerminalSummaryInput[];
  readonly latencies: ReadonlyMap<Phase8ConfigurationRoleId, readonly number[]>;
}): Pick<
  Phase8TerminalSummary,
  | "configAggregates"
  | "cellAggregates"
  | "pairedClusterStandardDeviations"
  | "maxPairedClusterStandardDeviation"
> {
  const complete = input.summaryInputs.filter(
    (value) => value.status === "complete",
  );
  const configAggregates = input.contract.configurations.map(
    (configuration) => {
      const values = complete.filter(
        (value) => value.configId === configuration.configId,
      );
      const userBhabhiGames = values.reduce(
        (sum, value) => sum + (value.userBhabhi ?? 0),
        0,
      );
      const latencies = input.latencies.get(configuration.configId) ?? [];
      return {
        configId: configuration.configId,
        completedGames: values.length,
        userBhabhiGames,
        userBhabhiRate:
          values.length === 0 ? null : userBhabhiGames / values.length,
        finishingPositionCounts: {
          first: values.filter((value) => value.userFinishingPosition === 1)
            .length,
          second: values.filter((value) => value.userFinishingPosition === 2)
            .length,
          third: values.filter((value) => value.userFinishingPosition === 3)
            .length,
        },
        exactUses: values.reduce((sum, value) => sum + value.exactUses, 0),
        exactRefusals: values.reduce(
          (sum, value) => sum + value.exactRefusals,
          0,
        ),
        behaviorUses: values.reduce(
          (sum, value) => sum + value.behaviorUses,
          0,
        ),
        behaviorRefusals: values.reduce(
          (sum, value) => sum + value.behaviorRefusals,
          0,
        ),
        decisionCount: values.reduce(
          (sum, value) => sum + value.solverDecisionCount,
          0,
        ),
        latencyP50Ms: quantile(latencies, 0.5),
        latencyP95Ms: quantile(latencies, 0.95),
        latencyP99Ms: quantile(latencies, 0.99),
      };
    },
  );
  const cellAggregates = input.contract.configurations.flatMap(
    (configuration) =>
      input.contract.styleCellIds.map((styleCellId) => {
        const values = complete.filter(
          (value) =>
            value.configId === configuration.configId &&
            value.styleCellId === styleCellId,
        );
        const userBhabhiGames = values.reduce(
          (sum, value) => sum + (value.userBhabhi ?? 0),
          0,
        );
        return {
          configId: configuration.configId,
          styleCellId,
          completedGames: values.length,
          userBhabhiGames,
          userBhabhiRate:
            values.length === 0 ? null : userBhabhiGames / values.length,
        };
      }),
  );

  const clusterMeans = new Map<string, number>();
  for (const configuration of input.contract.configurations) {
    for (
      let baseIndex = input.contract.baseIndexStart;
      baseIndex < input.contract.baseCount;
      baseIndex += 1
    ) {
      const values = complete.filter(
        (value) =>
          value.configId === configuration.configId &&
          value.baseIndex === baseIndex,
      );
      const expectedPerCluster =
        input.contract.styleCellIds.length * input.contract.rotations.length;
      if (
        values.length === expectedPerCluster &&
        values.every((value) => value.userBhabhi !== null)
      ) {
        clusterMeans.set(
          `${configuration.configId}/${baseIndex.toString()}`,
          values.reduce((sum, value) => sum + (value.userBhabhi ?? 0), 0) /
            expectedPerCluster,
        );
      }
    }
  }
  const referenceConfigId = PHASE8_TERMINAL_REFERENCE_ID;
  const pairedClusterStandardDeviations = input.contract.configurations
    .filter((configuration) => configuration.configId !== referenceConfigId)
    .map((configuration) => {
      const differences: number[] = [];
      for (
        let baseIndex = input.contract.baseIndexStart;
        baseIndex < input.contract.baseCount;
        baseIndex += 1
      ) {
        const reference = clusterMeans.get(
          `${referenceConfigId}/${baseIndex.toString()}`,
        );
        const candidate = clusterMeans.get(
          `${configuration.configId}/${baseIndex.toString()}`,
        );
        if (reference !== undefined && candidate !== undefined) {
          differences.push(candidate - reference);
        }
      }
      return {
        candidateConfigId: configuration.configId,
        referenceConfigId,
        standardDeviation: sampleStandardDeviation(differences),
      };
    });
  const finiteStandardDeviations = pairedClusterStandardDeviations
    .map((value) => value.standardDeviation)
    .filter((value): value is number => value !== null);
  return {
    configAggregates,
    cellAggregates,
    pairedClusterStandardDeviations,
    maxPairedClusterStandardDeviation:
      finiteStandardDeviations.length === 0
        ? null
        : Math.max(...finiteStandardDeviations),
  };
}

function componentGate(input: {
  readonly contract: InspectionContract;
  readonly records: readonly Phase8TerminalComponentAudit[];
  readonly failures: string[];
}): boolean {
  if (input.records.length !== input.contract.configurations.length) {
    input.failures.push(
      "Component-audit count does not match configuration count.",
    );
    return false;
  }
  let pass = true;
  const seen = new Set<Phase8ConfigurationRoleId>();
  for (const configuration of input.contract.configurations) {
    const matches = input.records.filter(
      (candidate) => candidate.configId === configuration.configId,
    );
    const record = matches[0];
    if (record === undefined) {
      input.failures.push(
        `Missing component audit for ${configuration.configId}.`,
      );
      pass = false;
      continue;
    }
    if (matches.length !== 1 || seen.has(record.configId)) {
      input.failures.push(
        `Component audit for ${configuration.configId} is duplicated.`,
      );
      pass = false;
    }
    seen.add(record.configId);
    const { auditSha256, ...projection } = record;
    const expectedComponents = phase8TerminalRoleComponents(
      configuration.configId,
    );
    const expectedModelSha256 = expectedComponents.behaviorWeighting
      ? input.contract.productionModelSha256
      : null;
    const eligibilityShapeValid =
      (record.preflightStatus === "eligible" &&
        record.preflightReasons.length === 0) ||
      (record.preflightStatus === "ineligible" &&
        record.preflightReasons.length > 0);
    if (
      record.configSha256 !== configuration.configSha256 ||
      stableStringify(record.components) !==
        stableStringify(expectedComponents) ||
      record.routingContract !==
        PHASE8_TERMINAL_ROUTING_CONTRACTS[configuration.configId] ||
      record.fallbackConfigId !==
        phase8TerminalRoleFallback(configuration.configId) ||
      record.exactConfigHash !== configuration.implementation.exactConfigHash ||
      record.phase5ReferenceConfigHash !==
        configuration.implementation.phase5ReferenceConfigHash ||
      record.continuationPolicyHash !==
        configuration.implementation.continuationPolicyHash ||
      record.productionModelSha256 !== expectedModelSha256 ||
      record.modelSelectionContractHash !==
        configuration.implementation.modelSelectionContractHash ||
      record.separateOpponentPriors !==
        configuration.implementation.separateOpponentPriors ||
      record.behaviorFailurePolicy !==
        configuration.implementation.behaviorFailurePolicy ||
      !eligibilityShapeValid ||
      auditSha256 !== phase8Sha256(projection)
    ) {
      input.failures.push(
        `Component audit for ${configuration.configId} is inconsistent with its executable contract.`,
      );
      pass = false;
    } else if (record.preflightStatus === "ineligible") {
      pass = false;
    }
  }
  return pass;
}

async function inspectRawDirectory(
  directory: string,
  contract: InspectionContract,
): Promise<RawInspection> {
  const failures: string[] = [];
  const componentRecords: Phase8TerminalComponentAudit[] = [];
  for await (const record of parseNdjson(
    join(directory, "components.ndjson"),
    phase8TerminalComponentAuditSchema,
  )) {
    validateCommonIdentity(record, contract, record.configId, failures);
    componentRecords.push(record);
  }
  const componentRoutingGate = componentGate({
    contract,
    records: componentRecords,
    failures,
  });

  let recordedSeedScenarios = 0;
  let seedCoverageGate = true;
  const seedDigest = createHash("sha256");
  const expectedSeedCoordinates = new Set<string>();
  for (const styleCellId of contract.styleCellIds) {
    for (
      let baseIndex = contract.baseIndexStart;
      baseIndex < contract.baseIndexStart + contract.baseCount;
      baseIndex += 1
    ) {
      for (const rotation of contract.rotations) {
        expectedSeedCoordinates.add(
          `${styleCellId}/${baseIndex.toString()}/${rotation.toString()}/0`,
        );
      }
    }
  }
  const seenSeedCoordinates = new Set<string>();
  for await (const record of parseNdjson(
    join(directory, "seeds.ndjson"),
    phase8TerminalSeedRecordSchema,
  )) {
    recordedSeedScenarios += 1;
    validateCommonIdentity(
      record,
      contract,
      `seed ${record.scenarioId}`,
      failures,
    );
    const seedCoordinate = `${record.styleCellId}/${record.baseIndex.toString()}/${record.rotation.toString()}/${record.replicate.toString()}`;
    const expectedScenario = expectedScenarioId(contract, record);
    if (
      !expectedSeedCoordinates.has(seedCoordinate) ||
      seenSeedCoordinates.has(seedCoordinate) ||
      record.clusterId !== `${contract.split}/${record.baseIndex.toString()}` ||
      record.pairingKey !==
        `${record.styleCellId}/${record.rotation.toString()}/0` ||
      record.scenarioId !== expectedScenario
    ) {
      failures.push(
        `Seed record ${record.scenarioId} has a duplicate or noncanonical coordinate.`,
      );
      seedCoverageGate = false;
    }
    seenSeedCoordinates.add(seedCoordinate);
    const { seedRecordSha256, ...projection } = record;
    const expectedIds = expectedSeedIds({
      contract,
      styleCellId: record.styleCellId,
      baseIndex: record.baseIndex,
      rotation: record.rotation,
    });
    if (
      seedRecordSha256 !== phase8Sha256(projection) ||
      stableStringify(record.seedIds) !== stableStringify(expectedIds)
    ) {
      failures.push(`Seed record ${record.scenarioId} failed derivation.`);
      seedCoverageGate = false;
    }
    seedDigest.update(`${seedRecordSha256}\n`, "utf8");
  }
  const missingSeedCoordinates = [...expectedSeedCoordinates].filter(
    (coordinate) => !seenSeedCoordinates.has(coordinate),
  );
  if (
    recordedSeedScenarios !== contract.expectedScenarios ||
    missingSeedCoordinates.length !== 0
  ) {
    if (
      componentRoutingGate ||
      recordedSeedScenarios !== 0 ||
      missingSeedCoordinates.length !== expectedSeedCoordinates.size
    ) {
      failures.push(
        `Recorded ${recordedSeedScenarios.toString()} seed scenarios; expected ${contract.expectedScenarios.toString()} with ${missingSeedCoordinates.length.toString()} missing coordinates.`,
      );
    }
    seedCoverageGate = false;
  }

  const gameCursor = new AsyncCursor(
    parseNdjson(
      join(directory, "games.ndjson"),
      phase8TerminalGameRecordSchema,
    ),
  );
  const truthCursor = new AsyncCursor(
    parseNdjson(
      join(directory, "truth.eval-only.ndjson"),
      phase8TerminalTruthRecordSchema,
    ),
  );
  const failureCursor = new AsyncCursor(
    parseNdjson(
      join(directory, "failures.ndjson"),
      phase8TerminalFailureRecordSchema,
    ),
  );
  const decisionCursor = new AsyncCursor(
    parseNdjson(
      join(directory, "decisions.ndjson"),
      phase8TerminalDecisionRecordSchema,
    ),
  );
  const latencyCursor = new AsyncCursor(
    parseNdjson(
      join(directory, "latency.ndjson"),
      phase8TerminalLatencyRecordSchema,
    ),
  );
  const summaryInputs: Phase8TerminalSummaryInput[] = [];
  const latencyByConfig = new Map<Phase8ConfigurationRoleId, number[]>();
  const gameDigest = createHash("sha256");
  const truthDigest = createHash("sha256");
  const failureDigest = createHash("sha256");
  const decisionDigest = createHash("sha256");
  const summaryInputDigest = createHash("sha256");
  let publicReplayGate = true;
  let truthReplayGate = true;
  let decisionCoverageGate = true;
  let completeRecordCount = 0;
  let failureRecordCount = 0;

  for await (const summaryValue of parseNdjson(
    join(directory, "summary-inputs.ndjson"),
    phase8TerminalSummaryInputSchema,
  )) {
    validateCommonIdentity(
      summaryValue,
      contract,
      `summary input ${summaryValue.gameId}`,
      failures,
    );
    validateExpectedCoordinate(
      summaryValue,
      contract,
      `summary input ${summaryValue.gameId}`,
      failures,
    );
    const { deterministicInputSha256, ...summaryProjection } = summaryValue;
    if (deterministicInputSha256 !== phase8Sha256(summaryProjection)) {
      failures.push(
        `Summary input ${summaryValue.gameId} failed its deterministic hash.`,
      );
    }
    summaryInputDigest.update(`${deterministicInputSha256}\n`, "utf8");
    summaryInputs.push(summaryValue);

    let expectedDecisions: readonly ExpectedUserDecision[] = [];
    let retainedFailureDecisionCount: number | null = null;
    if (summaryValue.status === "complete") {
      completeRecordCount += 1;
      const game = await gameCursor.take();
      const truth = await truthCursor.take();
      if (
        game === null ||
        truth === null ||
        !sameCoordinate(summaryValue, game) ||
        !sameCoordinate(game, truth)
      ) {
        failures.push(
          `${summaryValue.gameId} has missing or misordered game/truth records.`,
        );
        publicReplayGate = false;
        truthReplayGate = false;
      } else {
        validateCommonIdentity(game, contract, game.gameId, failures);
        validateCommonIdentity(truth, contract, truth.gameId, failures);
        validateExpectedCoordinate(game, contract, game.gameId, failures);
        validateExpectedCoordinate(
          truth,
          contract,
          `${truth.gameId} truth`,
          failures,
        );
        try {
          expectedDecisions = expectedUserDecisions({
            rules: contract.rules,
            game,
            truth,
          });
        } catch (cause) {
          failures.push(
            `${game.gameId} replay failed: ${
              cause instanceof Error ? cause.message : "unknown error"
            }`,
          );
          publicReplayGate = false;
          truthReplayGate = false;
        }
        if (
          game.solverDecisionCount !== summaryValue.solverDecisionCount ||
          game.userBhabhi !== (summaryValue.userBhabhi === 1) ||
          game.userFinishingPosition !== summaryValue.userFinishingPosition ||
          game.deterministicOutcomeHash !== summaryValue.terminalOutcomeHash
        ) {
          failures.push(`${game.gameId} summary/game binding failed.`);
        }
        gameDigest.update(`${game.deterministicGameHash}\n`, "utf8");
        truthDigest.update(`${truth.truthRecordSha256}\n`, "utf8");
      }
    } else {
      failureRecordCount += 1;
      const failure = await failureCursor.take();
      if (
        failure === null ||
        !sameCoordinate(summaryValue, failure) ||
        failure.completionStatus !== summaryValue.status
      ) {
        failures.push(
          `${summaryValue.gameId} has a missing or misordered failure record.`,
        );
      } else {
        retainedFailureDecisionCount = failure.retainedDecisionCount;
        validateCommonIdentity(failure, contract, failure.failureId, failures);
        validateExpectedCoordinate(
          failure,
          contract,
          failure.failureId,
          failures,
        );
        const failureProjection = {
          gameId: failure.gameId,
          completionStatus: failure.completionStatus,
          kind: failure.kind,
          stage: failure.stage,
          code: failure.code,
          errorName: failure.errorName,
          message: failure.message,
          lastGoodEventIndex: failure.lastGoodEventIndex,
          retainedDecisionCount: failure.retainedDecisionCount,
        };
        if (failure.failureHash !== phase8Sha256(failureProjection)) {
          failures.push(`${failure.failureId} hash failed.`);
        }
        failureDigest.update(`${failure.failureHash}\n`, "utf8");
      }
    }

    const gameDecisions: Phase8TerminalDecisionRecord[] = [];
    while ((await decisionCursor.peek())?.gameId === summaryValue.gameId) {
      const decision = await decisionCursor.take();
      if (decision === null) {
        break;
      }
      gameDecisions.push(decision);
      validateCommonIdentity(decision, contract, decision.decisionId, failures);
      validateExpectedCoordinate(
        decision,
        contract,
        decision.decisionId,
        failures,
      );
      validateDecisionRouting(decision, contract, failures);
      decisionDigest.update(`${decision.deterministicDecisionHash}\n`, "utf8");
      const latency = await latencyCursor.take();
      if (
        latency === null ||
        latency.decisionId !== decision.decisionId ||
        !sameCoordinate(decision, latency)
      ) {
        failures.push(
          `${decision.decisionId} has no matching ordered latency record.`,
        );
        decisionCoverageGate = false;
      } else {
        validateCommonIdentity(latency, contract, latency.decisionId, failures);
        validateExpectedCoordinate(
          latency,
          contract,
          `${latency.decisionId} latency`,
          failures,
        );
        const values = latencyByConfig.get(decision.configId) ?? [];
        values.push(latency.totalMs);
        latencyByConfig.set(decision.configId, values);
      }
    }
    const replayDecisionCountMismatch =
      summaryValue.status === "complete" &&
      expectedDecisions.length !== gameDecisions.length;
    const failureDecisionCountMismatch =
      summaryValue.status !== "complete" &&
      retainedFailureDecisionCount !== gameDecisions.length;
    if (
      gameDecisions.length !== summaryValue.solverDecisionCount ||
      replayDecisionCountMismatch ||
      failureDecisionCountMismatch
    ) {
      failures.push(`${summaryValue.gameId} decision count/coverage failed.`);
      decisionCoverageGate = false;
    } else if (summaryValue.status === "complete") {
      for (let index = 0; index < gameDecisions.length; index += 1) {
        const decision = gameDecisions[index];
        const expected = expectedDecisions[index];
        if (decision !== undefined && expected !== undefined) {
          validateExpectedDecision(decision, expected, failures);
        }
      }
    }
  }

  for (const [label, cursor] of [
    ["games", gameCursor],
    ["truths", truthCursor],
    ["failures", failureCursor],
    ["decisions", decisionCursor],
    ["latencies", latencyCursor],
  ] as const) {
    if ((await cursor.peek()) !== null) {
      failures.push(`${label} stream contains unreferenced trailing records.`);
      if (label === "decisions" || label === "latencies") {
        decisionCoverageGate = false;
      }
    }
  }

  const matrix = matrixValidation(contract, summaryInputs);
  const zeroSilentExclusionGate =
    summaryInputs.length === contract.expectedGames &&
    completeRecordCount + failureRecordCount === contract.expectedGames;
  if (
    !zeroSilentExclusionGate &&
    (componentRoutingGate ||
      summaryInputs.length !== 0 ||
      completeRecordCount !== 0 ||
      failureRecordCount !== 0)
  ) {
    failures.push(
      "Game/failure records do not account for every expected matrix coordinate.",
    );
  }
  const aggregates = terminalAggregates({
    contract,
    summaryInputs,
    latencies: latencyByConfig,
  });
  const technicalGate =
    failures.length === 0 &&
    componentRoutingGate &&
    seedCoverageGate &&
    decisionCoverageGate &&
    publicReplayGate &&
    truthReplayGate &&
    zeroSilentExclusionGate &&
    matrix.evidenceGate;
  const scientificDigest = sha256Bytes(
    stableStringify({
      schemaVersion: 1,
      runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
      planScientificSha256: contract.planScientificSha256,
      seedsSha256: seedDigest.digest("hex"),
      gamesSha256: gameDigest.digest("hex"),
      truthsSha256: truthDigest.digest("hex"),
      failuresSha256: failureDigest.digest("hex"),
      decisionsSha256: decisionDigest.digest("hex"),
      summaryInputsSha256: summaryInputDigest.digest("hex"),
      componentAudits: componentRecords.map((record) => record.auditSha256),
    }),
  );
  const summary = phase8TerminalSummarySchema.parse({
    schemaVersion: PHASE8_TERMINAL_SCHEMA_VERSION,
    protocolId: "eval-v1",
    runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    evidenceClass: contract.evidenceClass,
    runId: contract.runId,
    authorityKind: contract.authorityKind,
    manifestId: contract.manifestId,
    manifestSha256: contract.manifestSha256,
    split: contract.split,
    configurationIds: contract.configurations.map(
      (configuration) => configuration.configId,
    ),
    expectedScenarios: contract.expectedScenarios,
    expectedGames: contract.expectedGames,
    recordedSeedScenarios,
    matrix,
    ...aggregates,
    componentRoutingGate,
    seedCoverageGate,
    decisionCoverageGate,
    publicReplayGate,
    truthReplayGate,
    zeroSilentExclusionGate,
    deterministicSummaryGate: true,
    preflightEligibleForQualification: technicalGate,
    evidenceGate: contract.evidenceEligible && technicalGate,
    scientificDigest,
  });
  return { failures, summary };
}

export function renderPhase8TerminalSummaryMarkdown(
  summary: Phase8TerminalSummary,
): string {
  const configs = summary.configAggregates
    .map(
      (value) =>
        `| \`${value.configId}\` | ${value.completedGames.toString()} | ${
          value.userBhabhiRate === null
            ? "n/a"
            : value.userBhabhiRate.toFixed(6)
        } | ${value.exactUses.toString()} | ${value.exactRefusals.toString()} | ${value.behaviorUses.toString()} | ${
          value.latencyP95Ms === null ? "n/a" : value.latencyP95Ms.toFixed(3)
        } |`,
    )
    .join("\n");
  const variance = summary.pairedClusterStandardDeviations
    .map(
      (value) =>
        `- \`${value.candidateConfigId}\` minus \`${value.referenceConfigId}\`: ${
          value.standardDeviation === null
            ? "not estimable"
            : value.standardDeviation.toFixed(8)
        }`,
    )
    .join("\n");
  return [
    "# Phase 8 terminal matrix",
    "",
    `- Run: \`${summary.runId}\``,
    `- Split: \`${summary.split}\``,
    `- Evidence eligible split: ${summary.split !== "dev" ? "yes" : "no"}`,
    `- Attempted matrix records: ${summary.matrix.observedOutcomes.toString()} / ${summary.expectedGames.toString()}`,
    `- Recorded failures/caps/cancellations: ${(
      summary.matrix.failedCount +
      summary.matrix.turnCapCount +
      summary.matrix.analysisCapCount +
      summary.matrix.cancellationCount
    ).toString()}`,
    `- Technical qualification preflight: ${summary.preflightEligibleForQualification ? "PASS" : "FAIL"}`,
    `- Confirmatory evidence gate: ${summary.evidenceGate ? "PASS" : "NOT PASSED"}`,
    `- Scientific digest: \`${summary.scientificDigest}\``,
    "",
    "| Configuration | Complete games | User Bhabhi rate | Exact uses | Exact refusals | Behavior uses | Decision p95 ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    configs,
    "",
    "## Paired base-cluster sizing inputs",
    "",
    variance.length === 0 ? "- No candidate contrast." : variance,
    "",
  ].join("\n");
}

function contractFromPlan(plan: Phase8TerminalPlan): InspectionContract {
  return {
    runId: plan.runId,
    authorityKind: plan.authorityKind,
    manifestId: plan.manifestId,
    manifestSha256: plan.manifestSha256,
    split: plan.split,
    evidenceClass: plan.evidenceClass,
    evidenceEligible: plan.evidenceEligible,
    configurations: plan.configurations,
    styleCellIds: plan.styleCells.map((cell) => cell.id),
    baseIndexStart: 0,
    baseCount: plan.baseCount,
    rotations: plan.rotations,
    replicate: 0,
    expectedScenarios: plan.expectedScenarios,
    expectedGames: plan.expectedGames,
    rules: plan.rules,
    planScientificSha256: phase8TerminalPlanScientificHash(plan),
    seedPolicyId:
      plan.split === "dev"
        ? "phase8-terminal-development-seeds-v1"
        : plan.seedAuthority.kind === "qualification"
          ? plan.seedAuthority.authority.manifest.seedPolicyId
          : plan.seedAuthority.kind === "final"
            ? plan.seedAuthority.authority.manifest.seedPolicyId
            : "phase8-terminal-development-seeds-v1",
    productionModelSha256: plan.hashes.modelSha256,
  };
}

function contractFromManifest(
  manifest: Phase8TerminalRunManifest,
): InspectionContract {
  return {
    runId: manifest.runId,
    authorityKind: manifest.authorityKind,
    manifestId: manifest.authorityManifestId,
    manifestSha256: manifest.authorityManifestSha256,
    split: manifest.split,
    evidenceClass: manifest.evidenceClass,
    evidenceEligible: manifest.evidenceEligible,
    configurations: manifest.configurations,
    styleCellIds: manifest.styleCellIds,
    baseIndexStart: manifest.baseIndexStart,
    baseCount: manifest.baseCount,
    rotations: manifest.rotations,
    replicate: manifest.replicate,
    expectedScenarios: manifest.expectedScenarios,
    expectedGames: manifest.expectedGames,
    rules: manifest.rules,
    planScientificSha256: manifest.planScientificSha256,
    seedPolicyId: manifest.seedPolicyId,
    productionModelSha256: manifest.productionModelSha256,
  };
}

function serializableAuthority(plan: Phase8TerminalPlan): unknown {
  if (plan.seedAuthority.kind === "qualification") {
    return plan.seedAuthority.authority.manifest;
  }
  if (plan.seedAuthority.kind === "final") {
    return plan.seedAuthority.authority.manifest;
  }
  return plan.seedAuthority;
}

function serializableOpening(plan: Phase8TerminalPlan): unknown {
  if (plan.seedAuthority.kind === "qualification") {
    return {
      schemaVersion: plan.seedAuthority.opening.schemaVersion,
      protocolId: plan.seedAuthority.opening.protocolId,
      manifestId: plan.seedAuthority.opening.manifestId,
      manifestSha256: plan.seedAuthority.opening.manifestSha256,
      split: plan.seedAuthority.opening.split,
      splitPlanSha256: plan.seedAuthority.opening.splitPlanSha256,
      seedDisclosureAuthorized:
        plan.seedAuthority.opening.seedDisclosureAuthorized,
      authorizationKind: plan.seedAuthority.opening.authorizationKind,
      authorizationSha256: plan.seedAuthority.opening.authorizationSha256,
      openingSha256: plan.seedAuthority.opening.openingSha256,
    };
  }
  if (plan.seedAuthority.kind === "final") {
    return {
      schemaVersion: plan.seedAuthority.opening.schemaVersion,
      protocolId: plan.seedAuthority.opening.protocolId,
      manifestId: plan.seedAuthority.opening.manifestId,
      manifestSha256: plan.seedAuthority.opening.manifestSha256,
      split: plan.seedAuthority.opening.split,
      splitPlanSha256: plan.seedAuthority.opening.splitPlanSha256,
      seedDisclosureAuthorized:
        plan.seedAuthority.opening.seedDisclosureAuthorized,
      authorizationKind: plan.seedAuthority.opening.authorizationKind,
      authorizationSha256: plan.seedAuthority.opening.authorizationSha256,
      openingSha256: plan.seedAuthority.opening.openingSha256,
    };
  }
  return {
    schemaVersion: 1,
    protocolId: "eval-v1",
    split: "dev",
    evidenceEligible: false,
    disclosureAuthoritySha256: plan.seedAuthority.disclosureAuthoritySha256,
    openingSha256: plan.splitOpeningSha256,
  };
}

async function rawHashes(
  directory: string,
): Promise<Phase8TerminalRunManifest["rawStreamsSha256"]> {
  return {
    seedsSha256: await sha256File(join(directory, "seeds.ndjson")),
    gamesSha256: await sha256File(join(directory, "games.ndjson")),
    decisionsSha256: await sha256File(join(directory, "decisions.ndjson")),
    truthsSha256: await sha256File(join(directory, "truth.eval-only.ndjson")),
    latenciesSha256: await sha256File(join(directory, "latency.ndjson")),
    failuresSha256: await sha256File(join(directory, "failures.ndjson")),
    componentsSha256: await sha256File(join(directory, "components.ndjson")),
    summaryInputsSha256: await sha256File(
      join(directory, "summary-inputs.ndjson"),
    ),
  };
}

function runManifest(input: {
  readonly plan: Phase8TerminalPlan;
  readonly createdAt: string;
  readonly command: string;
  readonly rawStreamsSha256: Phase8TerminalRunManifest["rawStreamsSha256"];
}): Phase8TerminalRunManifest {
  const contract = contractFromPlan(input.plan);
  return phase8TerminalRunManifestSchema.parse({
    schemaVersion: PHASE8_TERMINAL_SCHEMA_VERSION,
    protocolId: "eval-v1",
    runnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
    evidenceClass: input.plan.evidenceClass,
    runId: input.plan.runId,
    authorityKind: input.plan.authorityKind,
    authorityManifestVersion: input.plan.authorityManifestVersion,
    authorityManifestId: input.plan.manifestId,
    authorityManifestSha256: input.plan.manifestSha256,
    splitOpeningSha256: input.plan.splitOpeningSha256,
    split: input.plan.split,
    evidenceEligible: input.plan.evidenceEligible,
    createdAt: input.createdAt,
    configurationIds: input.plan.configurations.map(
      (configuration) => configuration.configId,
    ),
    configurations: input.plan.configurations,
    styleCellIds: contract.styleCellIds,
    baseIndexStart: 0,
    baseCount: input.plan.baseCount,
    rotations: input.plan.rotations,
    replicate: 0,
    eventCap: input.plan.eventCap,
    expectedScenarios: input.plan.expectedScenarios,
    expectedGames: input.plan.expectedGames,
    rules: input.plan.rules,
    seedPolicyId: contract.seedPolicyId,
    planScientificSha256: contract.planScientificSha256,
    productionModelSha256: input.plan.hashes.modelSha256,
    sourceSha256: input.plan.hashes.sourceSha256,
    rulesSha256: input.plan.hashes.rulesSha256,
    configRegistrySha256: input.plan.hashes.configSha256,
    scorerSha256: input.plan.hashes.scorerSha256,
    reportSha256: input.plan.hashes.reportSha256,
    preregistrationSha256: input.plan.hashes.preregistrationSha256,
    rawStreamsSha256: input.rawStreamsSha256,
    nondeterministicFields: [
      "manifest.createdAt",
      "environment",
      "games[*].gameWallTimeMs",
      "latencies",
    ],
    recordOrder: "baseIndex-styleCell-rotation-config-userDecision",
    command: input.command,
  });
}

export async function createPhase8TerminalArtifactSession(input: {
  readonly rootDirectory: string;
  readonly plan: Phase8TerminalPlan;
  readonly serializedProductionModel: string;
  readonly environment: Phase8Json;
  readonly command: string;
  readonly createdAt: string;
}): Promise<Phase8TerminalArtifactSession> {
  verifyProductionModelBytes(
    input.serializedProductionModel,
    input.plan.hashes.modelSha256,
    input.plan.configurations,
  );
  const targets = safeRunDirectory(input.rootDirectory, input.plan.runId);
  await mkdir(targets.root, { recursive: true });
  if ((await pathExists(targets.final)) || (await pathExists(targets.stage))) {
    throw new Error(
      "Refusing to overwrite an existing terminal artifact or incomplete stage.",
    );
  }
  await mkdir(targets.stage, { recursive: false });
  await writeExclusive(
    join(targets.stage, "authority.json"),
    canonicalJson(serializableAuthority(input.plan)),
  );
  await writeExclusive(
    join(targets.stage, "opening.json"),
    canonicalJson(serializableOpening(input.plan)),
  );
  await writeExclusive(
    join(targets.stage, "production-model.json"),
    input.serializedProductionModel,
  );
  await writeExclusive(
    join(targets.stage, "environment.json"),
    canonicalJson(input.environment),
  );
  await writeExclusive(
    join(targets.stage, "command.txt"),
    input.command.endsWith("\n") ? input.command : `${input.command}\n`,
  );

  const streams = Object.fromEntries(
    PHASE8_TERMINAL_RAW_FILES.map((fileName) => [
      fileName,
      createWriteStream(join(targets.stage, fileName), {
        encoding: "utf8",
        flags: "wx",
      }),
    ]),
  ) as Record<RawFileName, WriteStream>;
  let finalized = false;
  const sink: Phase8TerminalRunSink = {
    writeComponentAudit: (record) =>
      writeStreamLine(streams["components.ndjson"], record),
    writeSeed: (record) => writeStreamLine(streams["seeds.ndjson"], record),
    writeScenario: async (
      result: Phase8TerminalScenarioResult,
    ): Promise<void> => {
      if (result.game !== null) {
        await writeStreamLine(streams["games.ndjson"], result.game);
      }
      if (result.truth !== null) {
        await writeStreamLine(streams["truth.eval-only.ndjson"], result.truth);
      }
      if (result.failure !== null) {
        await writeStreamLine(streams["failures.ndjson"], result.failure);
      }
      for (const decision of result.decisions) {
        await writeStreamLine(streams["decisions.ndjson"], decision);
      }
      for (const latency of result.latencies) {
        await writeStreamLine(streams["latency.ndjson"], latency);
      }
      await writeStreamLine(
        streams["summary-inputs.ndjson"],
        result.summaryInput,
      );
    },
  };

  return Object.freeze({
    stageDirectory: targets.stage,
    runDirectory: targets.final,
    sink,
    finalize: async (
      result: Phase8TerminalRunResult,
    ): Promise<Phase8TerminalArtifactVerification> => {
      if (finalized) {
        throw new Error("Terminal artifact session was already finalized.");
      }
      finalized = true;
      for (const fileName of PHASE8_TERMINAL_RAW_FILES) {
        await closeStream(streams[fileName]);
      }
      const streamsSha256 = await rawHashes(targets.stage);
      const manifest = runManifest({
        plan: input.plan,
        createdAt: input.createdAt,
        command: input.command,
        rawStreamsSha256: streamsSha256,
      });
      await writeExclusive(
        join(targets.stage, "manifest.json"),
        canonicalJson(manifest),
      );
      const inspection = await inspectRawDirectory(
        targets.stage,
        contractFromManifest(manifest),
      );
      const completedGames = inspection.summary.configAggregates.reduce(
        (sum, aggregate) => sum + aggregate.completedGames,
        0,
      );
      if (
        result.expectedGames !== input.plan.expectedGames ||
        result.attemptedGames !== inspection.summary.matrix.observedOutcomes ||
        result.completedGames !== completedGames ||
        result.failedGames !==
          inspection.summary.matrix.observedOutcomes - completedGames ||
        result.started !== inspection.summary.componentRoutingGate
      ) {
        throw new Error(
          "Terminal runner result does not agree with its recorded streams.",
        );
      }
      await writeExclusive(
        join(targets.stage, "summary.json"),
        canonicalJson(inspection.summary),
      );
      await writeExclusive(
        join(targets.stage, "summary.md"),
        renderPhase8TerminalSummaryMarkdown(inspection.summary),
      );
      const checksumLines: string[] = [];
      for (const fileName of [...PHASE8_TERMINAL_PAYLOAD_FILES].sort()) {
        checksumLines.push(
          `${await sha256File(join(targets.stage, fileName))}  ${fileName}`,
        );
      }
      await writeExclusive(
        join(targets.stage, "checksums.sha256"),
        `${checksumLines.join("\n")}\n`,
      );
      if (await pathExists(targets.final)) {
        throw new Error(
          "Refusing to publish over an existing terminal artifact.",
        );
      }
      await rename(targets.stage, targets.final);
      return verifyPhase8TerminalArtifacts(targets.final);
    },
  });
}

function rawHashMatches(
  manifest: Phase8TerminalRunManifest,
  actual: Phase8TerminalRunManifest["rawStreamsSha256"],
): boolean {
  return stableStringify(manifest.rawStreamsSha256) === stableStringify(actual);
}

function expectedPlanHashFromManifest(
  manifest: Phase8TerminalRunManifest,
): string {
  return sha256Bytes(
    stableStringify({
      schemaVersion: 1,
      protocolId: "eval-v1",
      runnerVersion: manifest.runnerVersion,
      authorityKind: manifest.authorityKind,
      authorityManifestVersion: manifest.authorityManifestVersion,
      manifestId: manifest.authorityManifestId,
      manifestSha256: manifest.authorityManifestSha256,
      splitOpeningSha256: manifest.splitOpeningSha256,
      split: manifest.split,
      evidenceClass: manifest.evidenceClass,
      evidenceEligible: manifest.evidenceEligible,
      configurations: manifest.configurations,
      styleCells: manifest.styleCellIds.map((id) => {
        const cell = STYLE_CELL_BY_ID.get(id);
        return cell ?? { id, p2: "unknown", p3: "unknown" };
      }),
      baseIndexStart: manifest.baseIndexStart,
      baseCount: manifest.baseCount,
      rotations: manifest.rotations,
      replicate: manifest.replicate,
      eventCap: manifest.eventCap,
      rules: manifest.rules,
      hashes: {
        sourceSha256: manifest.sourceSha256,
        rulesSha256: manifest.rulesSha256,
        configSha256: manifest.configRegistrySha256,
        modelSha256: manifest.productionModelSha256,
        scorerSha256: manifest.scorerSha256,
        reportSha256: manifest.reportSha256,
        preregistrationSha256: manifest.preregistrationSha256,
      },
      expectedScenarios: manifest.expectedScenarios,
      expectedGames: manifest.expectedGames,
    }),
  );
}

const STYLE_CELL_BY_ID = new Map(STYLE_CELLS.map((cell) => [cell.id, cell]));

export async function verifyPhase8TerminalArtifacts(
  runDirectoryValue: string,
): Promise<Phase8TerminalArtifactVerification> {
  const runDirectory = resolve(runDirectoryValue);
  const failures: string[] = [];
  let manifest: Phase8TerminalRunManifest | null = null;
  let summary: Phase8TerminalSummary | null = null;
  try {
    const files = (await readdir(runDirectory)).sort();
    const expectedFiles = [...PHASE8_TERMINAL_ALL_FILES].sort();
    if (stableStringify(files) !== stableStringify(expectedFiles)) {
      failures.push("Artifact file set is incomplete or contains extras.");
    }
    const checksumLines = (
      await readFile(join(runDirectory, "checksums.sha256"), "utf8")
    )
      .trimEnd()
      .split(/\r?\n/u);
    const checksums = new Map<string, string>();
    for (const line of checksumLines) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) {
        failures.push(`Malformed checksum line ${JSON.stringify(line)}.`);
      } else if (checksums.has(match[2])) {
        failures.push(`Duplicate checksum entry ${match[2]}.`);
      } else {
        checksums.set(match[2], match[1]);
      }
    }
    for (const fileName of PHASE8_TERMINAL_PAYLOAD_FILES) {
      const actual = await sha256File(join(runDirectory, fileName));
      if (checksums.get(fileName) !== actual) {
        failures.push(`${fileName} checksum mismatch.`);
      }
    }
    if (checksums.size !== PHASE8_TERMINAL_PAYLOAD_FILES.length) {
      failures.push("Checksum manifest has an unexpected entry count.");
    }
    manifest = phase8TerminalRunManifestSchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "manifest.json"), "utf8"),
      ) as unknown,
    );
    const expectedConfigurationIds = manifest.configurations.map(
      (configuration) => configuration.configId,
    );
    const expectedStyleCellIds = STYLE_CELLS.map((cell) => cell.id);
    const expectedScenarios =
      expectedStyleCellIds.length * manifest.baseCount * 3;
    const authorityShapeValid =
      (manifest.split === "dev" &&
        manifest.authorityKind === "development-pilot" &&
        !manifest.evidenceEligible &&
        manifest.evidenceClass === "phase8-terminal-development-pilot") ||
      (manifest.split === "qualification" &&
        manifest.authorityKind === "qualification" &&
        manifest.evidenceEligible &&
        manifest.evidenceClass === "phase8-confirmatory-terminal") ||
      (manifest.split === "final" &&
        manifest.authorityKind === "final" &&
        manifest.evidenceEligible &&
        manifest.evidenceClass === "phase8-confirmatory-terminal");
    if (
      stableStringify(manifest.configurationIds) !==
        stableStringify(expectedConfigurationIds) ||
      stableStringify(manifest.styleCellIds) !==
        stableStringify(expectedStyleCellIds) ||
      manifest.expectedScenarios !== expectedScenarios ||
      manifest.expectedGames !==
        expectedScenarios * manifest.configurations.length ||
      !authorityShapeValid
    ) {
      failures.push(
        "Manifest matrix cardinality, ordering, or authority semantics failed.",
      );
    }
    if (
      stableStringify(manifest.rules) !== stableStringify(CANONICAL_RULES) ||
      manifest.rulesSha256 !== phase8Sha256(manifest.rules)
    ) {
      failures.push("Manifest canonical rules binding failed.");
    }
    if (
      manifest.configRegistrySha256 !== phase8Sha256(manifest.configurations)
    ) {
      failures.push("Manifest configuration registry binding failed.");
    }
    const productionModelBytes = await readFile(
      join(runDirectory, "production-model.json"),
      "utf8",
    );
    try {
      verifyProductionModelBytes(
        productionModelBytes,
        manifest.productionModelSha256,
        manifest.configurations,
      );
    } catch (cause) {
      failures.push(
        `Production-model canonical verification failed: ${
          cause instanceof Error ? cause.message : "unknown error"
        }`,
      );
    }
    const actualRawHashes = await rawHashes(runDirectory);
    if (!rawHashMatches(manifest, actualRawHashes)) {
      failures.push("Manifest raw-stream hashes do not match files.");
    }
    if (
      manifest.planScientificSha256 !== expectedPlanHashFromManifest(manifest)
    ) {
      failures.push("Manifest plan scientific hash failed.");
    }
    const inspection = await inspectRawDirectory(
      runDirectory,
      contractFromManifest(manifest),
    );
    failures.push(...inspection.failures);
    summary = phase8TerminalSummarySchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "summary.json"), "utf8"),
      ) as unknown,
    );
    if (stableStringify(summary) !== stableStringify(inspection.summary)) {
      failures.push("summary.json does not regenerate from raw records.");
    }
    const markdown = await readFile(join(runDirectory, "summary.md"), "utf8");
    if (markdown !== renderPhase8TerminalSummaryMarkdown(summary)) {
      failures.push("summary.md does not regenerate from summary.json.");
    }
    const command = await readFile(join(runDirectory, "command.txt"), "utf8");
    if (command.trimEnd() !== manifest.command) {
      failures.push("command.txt does not match manifest command.");
    }
  } catch (cause) {
    failures.push(
      cause instanceof Error ? cause.message : "Unknown verification error.",
    );
  }
  return Object.freeze({
    ok: failures.length === 0,
    runDirectory,
    failures: Object.freeze(failures),
    summary,
    manifest,
  });
}
