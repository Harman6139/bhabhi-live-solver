import {
  ACE_OF_SPADES,
  FULL_DECK,
  sortCards,
  type Card,
} from "../domain/cards";
import { CANONICAL_RULES, type RuleConfig } from "../domain/rule-config";
import { SEATS, type Seat } from "../domain/seats";
import type {
  CardPlayedEvent,
  GameCreatedEvent,
  GameEvent,
  HandTakenEvent,
  PlayerCardDrawnEvent,
  WasteCardDrawnEvent,
} from "../events/game-events";
import { stableHash } from "../events/stable-hash";
import { semanticHistoryHash } from "../events/timeline";
import type { PublicInformationState } from "../public/public-state";
import { createActorObservation } from "../agents/observation";
import {
  type PolicyChoice,
  type PolicyObservation,
  type SimulatorPolicy,
} from "./policies";
import {
  createEvaluationUserTimelinePolicyInput,
  projectActiveSimulationTimelineForUser,
  type EvaluationUserTimelinePolicy,
  type EvaluationUserTimelinePolicyConfig,
  type ScenarioSolverSeedSet,
} from "./evaluation-user-policy";
import { createSeededRng, type SeedInput } from "./rng";
import {
  applyTruthCardPlay,
  applyTruthHandTaken,
  applyTruthPlayerDraw,
  applyTruthWasteDraw,
  assertSimulationTruthInvariant,
  createSimulationTruth,
  type SimulationTruth,
} from "./truth";

export const SIMULATOR_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MAX_GAME_EVENTS = 4_096;

export type DealRotation = 0 | 1 | 2;
export type ConcreteDeal = Readonly<Record<Seat, readonly Card[]>>;

export type SimulationSeedSet = {
  readonly deal: SeedInput;
  readonly policy: Readonly<Record<Seat, SeedInput>>;
  readonly chance: SeedInput;
};

export type SimulationGameConfig = {
  readonly gameId: string;
  readonly rules?: RuleConfig;
  readonly rotation?: DealRotation;
  readonly deal?: ConcreteDeal;
  readonly seeds: SimulationSeedSet;
  readonly policies: Readonly<Record<Seat, SimulatorPolicy>>;
  readonly evaluationUserTimelinePolicy?: EvaluationUserTimelinePolicyConfig;
  readonly maxEvents?: number;
};

export type SimulationDecision = {
  readonly schemaVersion: typeof SIMULATOR_SCHEMA_VERSION;
  readonly eventIndex: number;
  readonly decisionOrdinal: number;
  readonly seat: Seat;
  readonly policyId: string;
  readonly actionKind: "play-card" | "take-hand";
  readonly legalCards: readonly Card[];
  readonly legalTakeTargets: readonly Seat[];
  readonly chosenCard: Card | null;
  readonly chosenTakeTarget: Seat | null;
  readonly rationale: string;
  readonly observationHash: string;
  readonly publicStateHashBefore: string;
  readonly rngStreamId: string;
};

export type SimulationChance = {
  readonly schemaVersion: typeof SIMULATOR_SCHEMA_VERSION;
  readonly eventIndex: number;
  readonly chanceOrdinal: number;
  readonly kind: "waste-draw" | "player-draw";
  readonly player: Seat;
  readonly source: "waste" | Seat;
  readonly eligibleCards: readonly Card[];
  readonly chosenCard: Card;
  readonly publicStateHashBefore: string;
  readonly rngStreamId: string;
};

export type SimulationGameResult = {
  readonly schemaVersion: typeof SIMULATOR_SCHEMA_VERSION;
  readonly gameId: string;
  readonly status: "complete";
  readonly policies: Readonly<Record<Seat, string>>;
  readonly rules: RuleConfig;
  readonly rotation: DealRotation;
  readonly deal: ConcreteDeal;
  readonly setup: GameCreatedEvent;
  readonly events: readonly GameEvent[];
  readonly decisions: readonly SimulationDecision[];
  readonly chanceEvents: readonly SimulationChance[];
  readonly finalState: PublicInformationState;
  readonly finalHands: ConcreteDeal;
  readonly bhabhi: Seat;
  readonly escapeOrder: readonly Seat[];
  readonly eventCount: number;
  readonly decisionCount: number;
  readonly semanticHistoryHash: string;
  readonly terminalPublicStateHash: string;
  readonly terminalTruthHash: string;
  readonly outcomeHash: string;
};

export class SimulationRunError extends Error {
  readonly code:
    "EVENT_CAP" | "INVALID_POLICY_CHOICE" | "NO_CHANCE_CARD" | "NO_TURN";
  readonly gameId: string;
  readonly eventCount: number;

  constructor(
    code: SimulationRunError["code"],
    gameId: string,
    eventCount: number,
    message: string,
  ) {
    super(message);
    this.name = "SimulationRunError";
    this.code = code;
    this.gameId = gameId;
    this.eventCount = eventCount;
  }
}

function normalizeRotation(rotation: number | undefined): DealRotation {
  const value = rotation ?? 0;
  if (value !== 0 && value !== 1 && value !== 2) {
    throw new RangeError("Deal rotation must be 0, 1, or 2.");
  }
  return value;
}

/**
 * Deal one uniformly shuffled 52-card permutation into fixed buckets of
 * 18/17/17, then rotate whole buckets among roles. The 18-card bucket moves
 * user -> p2 -> p3 as rotation advances.
 */
export function createSeededDeal(
  seed: SeedInput,
  rotationValue: DealRotation = 0,
): ConcreteDeal {
  const rotation = normalizeRotation(rotationValue);
  const permutation = createSeededRng(seed)
    .fork("eval-v1", "deal")
    .shuffle(FULL_DECK);
  const buckets = [
    permutation.slice(0, 18),
    permutation.slice(18, 35),
    permutation.slice(35, 52),
  ] as const;
  const deal: Record<Seat, readonly Card[]> = {
    user: [],
    p2: [],
    p3: [],
  };
  for (const [seatIndex, seat] of SEATS.entries()) {
    const bucketIndex = (seatIndex - rotation + SEATS.length) % SEATS.length;
    const bucket = buckets[bucketIndex];
    if (bucket === undefined) {
      throw new Error("Seeded deal bucket is missing.");
    }
    deal[seat] = sortCards(bucket);
  }
  return freezeClone(deal);
}

function gameCreatedEvent(
  deal: ConcreteDeal,
  rules: RuleConfig,
): GameCreatedEvent {
  const aceSpadesHolder = SEATS.find((seat) =>
    deal[seat].includes(ACE_OF_SPADES),
  );
  if (aceSpadesHolder === undefined) {
    throw new Error("A concrete simulator deal has no Ace of Spades holder.");
  }
  return {
    type: "game-created",
    schemaVersion: 1,
    rules: structuredClone(rules),
    userHand: [...deal.user],
    startingCounts: {
      user: deal.user.length,
      p2: deal.p2.length,
      p3: deal.p3.length,
    },
    aceSpadesHolder,
  };
}

export function createPolicyObservation(
  truth: SimulationTruth,
  seat: Seat,
  decisionOrdinal: number,
  events?: readonly GameEvent[],
): PolicyObservation {
  return createActorObservation(
    { publicState: truth.publicState, exactHands: truth.hands },
    seat,
    decisionOrdinal,
    events,
  );
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

type PreparedEvaluationUserTimelinePolicy = {
  readonly policy: EvaluationUserTimelinePolicy;
  readonly solverSeeds: ScenarioSolverSeedSet;
};

function prepareEvaluationUserTimelinePolicy(
  config: EvaluationUserTimelinePolicyConfig | undefined,
): PreparedEvaluationUserTimelinePolicy | null {
  if (config === undefined) {
    return null;
  }
  const solverSeeds = freezeClone(config.solverSeeds);
  for (const [stream, seed] of Object.entries(solverSeeds)) {
    if (typeof seed !== "string" || seed.length === 0) {
      throw new TypeError(
        `Evaluation solver seed ${stream} must be a non-empty string.`,
      );
    }
  }
  const policy = config.createPolicy();
  if (
    typeof policy !== "object" ||
    typeof policy.id !== "string" ||
    policy.id.length === 0 ||
    typeof policy.chooseAction !== "function"
  ) {
    throw new TypeError(
      "Evaluation user timeline policy factories must return a non-empty id and chooseAction().",
    );
  }
  return { policy, solverSeeds };
}

function evaluationPolicyInvocationId(
  prepared: PreparedEvaluationUserTimelinePolicy,
  eventIndex: number,
  decisionOrdinal: number,
): string {
  return stableHash({
    kind: "evaluation-user-timeline-policy",
    policyId: prepared.policy.id,
    eventIndex,
    decisionOrdinal,
    solverSeeds: prepared.solverSeeds,
  });
}

function validatePolicyChoice(
  choice: PolicyChoice,
  legalCards: readonly Card[],
  config: SimulationGameConfig,
  events: readonly GameEvent[],
): void {
  if (!legalCards.includes(choice.card)) {
    throw new SimulationRunError(
      "INVALID_POLICY_CHOICE",
      config.gameId,
      events.length,
      `Policy chose illegal card ${choice.card}; legal set is ${legalCards.join(", ")}.`,
    );
  }
}

function validateTakeChoice(
  target: Seat,
  observation: PolicyObservation,
  config: SimulationGameConfig,
  events: readonly GameEvent[],
): void {
  if (!(observation.legalTakeTargets ?? []).includes(target)) {
    throw new SimulationRunError(
      "INVALID_POLICY_CHOICE",
      config.gameId,
      events.length,
      `Policy chose illegal take target ${target}.`,
    );
  }
}

function chooseChanceEvent(
  truth: SimulationTruth,
  config: SimulationGameConfig,
  chanceOrdinal: number,
  eventIndex: number,
): {
  readonly event: WasteCardDrawnEvent | PlayerCardDrawnEvent;
  readonly record: SimulationChance;
} {
  const pending = truth.publicState.pendingAction;
  if (pending === null) {
    throw new Error("Chance selection requires a pending action.");
  }
  const eligible =
    pending.kind === "waste-draw"
      ? [...truth.publicState.waste]
      : [...truth.hands[pending.source]];
  if (eligible.length === 0) {
    throw new SimulationRunError(
      "NO_CHANCE_CARD",
      config.gameId,
      eventIndex,
      `Pending ${pending.kind} has no eligible card.`,
    );
  }
  const rng = createSeededRng(config.seeds.chance).fork(
    "chance",
    "event",
    chanceOrdinal,
    pending.kind,
    pending.player,
  );
  const ordered = sortCards(eligible);
  const card = rng.pick(ordered);
  const common = {
    schemaVersion: 1 as const,
    eventIndex,
    chanceOrdinal,
    kind: pending.kind,
    player: pending.player,
    eligibleCards: ordered,
    chosenCard: card,
    publicStateHashBefore: stableHash(truth.publicState),
    rngStreamId: rng.streamId,
  };
  if (pending.kind === "waste-draw") {
    return {
      event: {
        type: "waste-card-drawn",
        schemaVersion: 1,
        seat: pending.player,
        card,
      },
      record: {
        ...common,
        source: "waste",
      },
    };
  }
  return {
    event: {
      type: "player-card-drawn",
      schemaVersion: 1,
      seat: pending.player,
      source: pending.source,
      card,
    },
    record: {
      ...common,
      source: pending.source,
    },
  };
}

function applySimulationEvent(
  truth: SimulationTruth,
  event: Exclude<GameEvent, GameCreatedEvent>,
  eventIndex: number,
): SimulationTruth {
  switch (event.type) {
    case "card-played":
      return applyTruthCardPlay(truth, event, eventIndex);
    case "waste-card-drawn":
      return applyTruthWasteDraw(truth, event, eventIndex);
    case "player-card-drawn":
      return applyTruthPlayerDraw(truth, event, eventIndex);
    case "hand-taken":
      return applyTruthHandTaken(truth, event, eventIndex);
  }
}

function escapeOrder(state: PublicInformationState): Seat[] {
  const escaped = state.escapeGroups.flatMap((group) => group.seats);
  return state.bhabhi === null ? escaped : [...escaped, state.bhabhi];
}

export function simulateCompleteGame(
  config: SimulationGameConfig,
): SimulationGameResult {
  const rotation = normalizeRotation(config.rotation);
  const maxEvents = config.maxEvents ?? DEFAULT_MAX_GAME_EVENTS;
  if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) {
    throw new RangeError("maxEvents must be a positive safe integer.");
  }
  const evaluationUserPolicy = prepareEvaluationUserTimelinePolicy(
    config.evaluationUserTimelinePolicy,
  );
  const rules = structuredClone(config.rules ?? CANONICAL_RULES);
  const deal = freezeClone(
    config.deal ?? createSeededDeal(config.seeds.deal, rotation),
  );
  const setup = gameCreatedEvent(deal, rules);
  let truth = createSimulationTruth(deal, rules);
  const events: GameEvent[] = [setup];
  const decisions: SimulationDecision[] = [];
  const chanceEvents: SimulationChance[] = [];
  const decisionOrdinals: Record<Seat, number> = {
    user: 0,
    p2: 0,
    p3: 0,
  };
  let chanceOrdinal = 0;

  while (truth.publicState.status === "active") {
    if (events.length >= maxEvents) {
      throw new SimulationRunError(
        "EVENT_CAP",
        config.gameId,
        events.length,
        `Game exceeded the ${maxEvents.toString()}-event safety cap.`,
      );
    }
    const eventIndex = events.length;
    if (truth.publicState.pendingAction !== null) {
      const selected = chooseChanceEvent(
        truth,
        config,
        chanceOrdinal,
        eventIndex,
      );
      truth = applySimulationEvent(truth, selected.event, eventIndex);
      events.push(selected.event);
      chanceEvents.push(selected.record);
      chanceOrdinal += 1;
      continue;
    }

    const seat = truth.publicState.turn;
    if (seat === null) {
      throw new SimulationRunError(
        "NO_TURN",
        config.gameId,
        events.length,
        "An active simulation state has no actor.",
      );
    }
    const decisionOrdinal = decisionOrdinals[seat];
    const observation = createPolicyObservation(
      truth,
      seat,
      decisionOrdinal,
      events,
    );
    if (seat === "user" && evaluationUserPolicy !== null) {
      const input = createEvaluationUserTimelinePolicyInput({
        timeline: projectActiveSimulationTimelineForUser(events),
        observation,
        solverSeeds: evaluationUserPolicy.solverSeeds,
      });
      const action = evaluationUserPolicy.policy.chooseAction(input);
      const invocationId = evaluationPolicyInvocationId(
        evaluationUserPolicy,
        eventIndex,
        decisionOrdinal,
      );
      if (action.kind === "take-hand") {
        validateTakeChoice(action.target, observation, config, events);
        const event: HandTakenEvent = {
          type: "hand-taken",
          schemaVersion: 1,
          actor: "user",
          target: action.target,
          revealedCards: [...truth.hands[action.target]],
        };
        decisions.push({
          schemaVersion: 1,
          eventIndex,
          decisionOrdinal,
          seat,
          policyId: evaluationUserPolicy.policy.id,
          actionKind: "take-hand",
          legalCards: [...observation.legalCards],
          legalTakeTargets: [...(observation.legalTakeTargets ?? [])],
          chosenCard: null,
          chosenTakeTarget: action.target,
          rationale: action.rationale,
          observationHash: stableHash(observation),
          publicStateHashBefore: stableHash(truth.publicState),
          rngStreamId: invocationId,
        });
        truth = applySimulationEvent(truth, event, eventIndex);
        events.push(event);
        decisionOrdinals.user += 1;
        continue;
      }
      validatePolicyChoice(action, observation.legalCards, config, events);
      const event: CardPlayedEvent = {
        type: "card-played",
        schemaVersion: 1,
        seat: "user",
        card: action.card,
      };
      decisions.push({
        schemaVersion: 1,
        eventIndex,
        decisionOrdinal,
        seat,
        policyId: evaluationUserPolicy.policy.id,
        actionKind: "play-card",
        legalCards: [...observation.legalCards],
        legalTakeTargets: [...(observation.legalTakeTargets ?? [])],
        chosenCard: action.card,
        chosenTakeTarget: null,
        rationale: action.rationale,
        observationHash: stableHash(observation),
        publicStateHashBefore: stableHash(truth.publicState),
        rngStreamId: invocationId,
      });
      truth = applySimulationEvent(truth, event, eventIndex);
      events.push(event);
      decisionOrdinals.user += 1;
      continue;
    }
    const policy = config.policies[seat];
    const decisionRng = createSeededRng(config.seeds.policy[seat]).fork(
      "policy",
      seat,
      "decision",
      decisionOrdinal,
    );
    const takeRng = decisionRng.fork("take-target");
    const takeTarget = policy.chooseTakeTarget?.(observation, takeRng) ?? null;
    if (takeTarget !== null) {
      validateTakeChoice(takeTarget, observation, config, events);
      const event: HandTakenEvent = {
        type: "hand-taken",
        schemaVersion: 1,
        actor: seat,
        target: takeTarget,
        revealedCards:
          seat === "user" || takeTarget === "user"
            ? [...truth.hands[takeTarget]]
            : [],
      };
      decisions.push({
        schemaVersion: 1,
        eventIndex,
        decisionOrdinal,
        seat,
        policyId: policy.id,
        actionKind: "take-hand",
        legalCards: [...observation.legalCards],
        legalTakeTargets: [...(observation.legalTakeTargets ?? [])],
        chosenCard: null,
        chosenTakeTarget: takeTarget,
        rationale: "policy-selected-take-hand",
        observationHash: stableHash(observation),
        publicStateHashBefore: stableHash(truth.publicState),
        rngStreamId: takeRng.streamId,
      });
      truth = applySimulationEvent(truth, event, eventIndex);
      events.push(event);
      decisionOrdinals[seat] += 1;
      continue;
    }
    const rng = decisionRng.fork("card");
    const choice = policy.chooseCard(observation, rng);
    validatePolicyChoice(choice, observation.legalCards, config, events);
    const event: CardPlayedEvent = {
      type: "card-played",
      schemaVersion: 1,
      seat,
      card: choice.card,
    };
    decisions.push({
      schemaVersion: 1,
      eventIndex,
      decisionOrdinal,
      seat,
      policyId: policy.id,
      actionKind: "play-card",
      legalCards: [...observation.legalCards],
      legalTakeTargets: [...(observation.legalTakeTargets ?? [])],
      chosenCard: choice.card,
      chosenTakeTarget: null,
      rationale: choice.rationale,
      observationHash: stableHash(observation),
      publicStateHashBefore: stableHash(truth.publicState),
      rngStreamId: rng.streamId,
    });
    truth = applySimulationEvent(truth, event, eventIndex);
    events.push(event);
    decisionOrdinals[seat] += 1;
  }

  assertSimulationTruthInvariant(truth);
  const bhabhi = truth.publicState.bhabhi;
  if (bhabhi === null) {
    throw new Error("A completed simulator game has no Bhabhi.");
  }
  const historyHash = semanticHistoryHash(events);
  const terminalPublicStateHash = stableHash(truth.publicState);
  const terminalTruthHash = stableHash({
    hands: truth.hands,
    publicState: truth.publicState,
  });
  const orderedEscapes = escapeOrder(truth.publicState);
  const outcomeHash = stableHash({
    bhabhi,
    escapeOrder: orderedEscapes,
    historyHash,
    terminalPublicStateHash,
  });
  return freezeClone({
    schemaVersion: 1,
    gameId: config.gameId,
    status: "complete",
    policies: Object.fromEntries(
      SEATS.map((seat) => [
        seat,
        seat === "user" && evaluationUserPolicy !== null
          ? evaluationUserPolicy.policy.id
          : config.policies[seat].id,
      ]),
    ) as Record<Seat, string>,
    rules,
    rotation,
    deal,
    setup,
    events,
    decisions,
    chanceEvents,
    finalState: truth.publicState,
    finalHands: truth.hands,
    bhabhi,
    escapeOrder: orderedEscapes,
    eventCount: events.length,
    decisionCount: decisions.length,
    semanticHistoryHash: historyHash,
    terminalPublicStateHash,
    terminalTruthHash,
    outcomeHash,
  });
}
