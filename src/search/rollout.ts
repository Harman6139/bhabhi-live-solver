import {
  getBaselinePolicy,
  type BaselinePolicyId,
  type PolicyObservation,
} from "../agents/policies";
import { createActorObservation } from "../agents/observation";
import { sortCards } from "../domain/cards";
import { SEATS, type OpponentSeat, type Seat } from "../domain/seats";
import type {
  CardPlayedEvent,
  GameEvent,
  HandTakenEvent,
  PlayerCardDrawnEvent,
  WasteCardDrawnEvent,
} from "../events/game-events";
import { stableHash } from "../events/stable-hash";
import type { PublicInformationState } from "../public/public-state";
import { createSeededRng } from "../random/keyed-rng";
import {
  applyExactHandEvent,
  assertExactHandStateInvariant,
  type ExactHandEvent,
  type ExactHandState,
} from "../rules/exact-hand-transition";
import { actionEvent, actionKey, legalUserActions } from "./actions";
import type {
  RolloutOutcome,
  SolverBudget,
  SolverSeedSet,
  TerminalOutcome,
  UserAction,
} from "./types";
import { SearchError } from "./types";

type RolloutPolicyIds = Readonly<{
  userContinuation: BaselinePolicyId;
  p2: BaselinePolicyId;
  p3: BaselinePolicyId;
}>;

export type TerminalRolloutInput = {
  readonly publicState: PublicInformationState;
  readonly exactHands: ExactHandState["hands"];
  readonly activeEvents?: readonly GameEvent[];
  readonly action: UserAction;
  readonly scenarioOccurrence: number;
  readonly replicate: number;
  readonly seeds: SolverSeedSet;
  readonly policies: RolloutPolicyIds;
  readonly budget: SolverBudget;
  readonly shouldCancel?: () => boolean;
};

type MutableRolloutState = {
  exact: ExactHandState;
  events: GameEvent[] | null;
  readonly generatedEvents: ExactHandEvent[];
  readonly policyDecisions: RolloutOutcome["policyDecisions"][number][];
  readonly decisionOrdinals: Record<Seat, number>;
  chanceOrdinal: number;
  simulatedEventCount: number;
  userHeadsUpOpponent: OpponentSeat | null;
};

type RootDiagnostics = {
  resolved: boolean;
  pickup: boolean;
  pickupCount: number;
  power: boolean;
};

const STOCHASTIC_POLICY_IDS = new Set<BaselinePolicyId>([
  "random",
  "noisy-mixture",
]);
const DETERMINISTIC_POLICY_RNG = createSeededRng(
  "deterministic-policy-unused-rng-v1",
);

function existingDecisionOrdinals(
  state: PublicInformationState,
  events?: readonly GameEvent[],
): Record<Seat, number> {
  const ordinals: Record<Seat, number> = { user: 0, p2: 0, p3: 0 };
  if (events !== undefined) {
    for (const event of events) {
      if (event.type === "card-played") {
        ordinals[event.seat] += 1;
      } else if (event.type === "hand-taken") {
        ordinals[event.actor] += 1;
      }
    }
    return ordinals;
  }
  for (const effect of state.effects) {
    if (effect.type === "card-played") {
      ordinals[effect.seat] += 1;
    } else if (effect.type === "hand-taken") {
      ordinals[effect.actor] += 1;
    }
  }
  return ordinals;
}

function existingChanceOrdinal(events?: readonly GameEvent[]): number {
  if (events === undefined) {
    return 0;
  }
  return events.filter(
    (event) =>
      event.type === "waste-card-drawn" || event.type === "player-card-drawn",
  ).length;
}

function headsUpOpponent(state: PublicInformationState): OpponentSeat | null {
  if (state.activeSeats.length !== 2 || !state.activeSeats.includes("user")) {
    return null;
  }
  const opponent = state.activeSeats.find((seat) => seat !== "user");
  return opponent === "p2" || opponent === "p3" ? opponent : null;
}

function assertNotCancelled(input: TerminalRolloutInput): void {
  if (input.shouldCancel?.() === true) {
    throw new SearchError("CANCELLED", "Terminal rollout was cancelled.");
  }
}

function createMutableState(input: TerminalRolloutInput): MutableRolloutState {
  const exact: ExactHandState = {
    publicState: structuredClone(input.publicState),
    hands: structuredClone(input.exactHands),
  };
  assertExactHandStateInvariant(exact);
  return {
    exact,
    events:
      input.activeEvents === undefined
        ? null
        : input.activeEvents.map((event) => structuredClone(event)),
    generatedEvents: [],
    policyDecisions: [],
    decisionOrdinals: existingDecisionOrdinals(
      input.publicState,
      input.activeEvents,
    ),
    chanceOrdinal: existingChanceOrdinal(input.activeEvents),
    simulatedEventCount: 0,
    userHeadsUpOpponent: headsUpOpponent(input.publicState),
  };
}

function applyEvent(
  state: MutableRolloutState,
  event: ExactHandEvent,
  input: TerminalRolloutInput,
  root: RootDiagnostics,
): void {
  assertNotCancelled(input);
  if (state.simulatedEventCount >= input.budget.maxEventsPerRollout) {
    throw new SearchError(
      "ROLLOUT_EVENT_CAP",
      `Terminal rollout exceeded the ${input.budget.maxEventsPerRollout.toString()}-event cap.`,
      {
        scenarioOccurrence: input.scenarioOccurrence,
        replicate: input.replicate,
        action: input.action,
        appliedEventCount: state.exact.publicState.appliedEventCount,
      },
    );
  }
  const priorEffectCount = state.exact.publicState.effects.length;
  const eventIndex = state.exact.publicState.appliedEventCount;
  state.exact = applyExactHandEvent(
    state.exact,
    event,
    eventIndex,
    "trusted-input",
  );
  state.events?.push(structuredClone(event));
  state.generatedEvents.push(structuredClone(event));
  state.simulatedEventCount += 1;

  if (!root.resolved) {
    const newEffects = state.exact.publicState.effects.slice(priorEffectCount);
    const pickup = newEffects.find(
      (effect) => effect.type === "trick-picked-up",
    );
    const wasted = newEffects.some((effect) => effect.type === "trick-wasted");
    if (pickup?.type === "trick-picked-up") {
      root.resolved = true;
      root.pickup = pickup.picker === "user";
      root.pickupCount = pickup.picker === "user" ? pickup.cards.length : 0;
      root.power = state.exact.publicState.power === "user";
    } else if (wasted || state.exact.publicState.status === "complete") {
      root.resolved = true;
      root.power = state.exact.publicState.power === "user";
    }
  }

  state.userHeadsUpOpponent ??= headsUpOpponent(state.exact.publicState);
}

function chanceEvent(
  state: MutableRolloutState,
  input: TerminalRolloutInput,
): WasteCardDrawnEvent | PlayerCardDrawnEvent {
  const pending = state.exact.publicState.pendingAction;
  if (pending === null) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      "Chance selection requires a pending rule action.",
    );
  }
  const eligible =
    pending.kind === "waste-draw"
      ? sortCards(state.exact.publicState.waste)
      : sortCards(state.exact.hands[pending.source]);
  if (eligible.length === 0) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      `Pending ${pending.kind} has no eligible card.`,
      {
        pending,
        scenarioOccurrence: input.scenarioOccurrence,
        replicate: input.replicate,
      },
    );
  }
  const source = pending.kind === "waste-draw" ? "waste" : pending.source;
  const rng = createSeededRng(input.seeds.chance).fork(
    "terminal-root-rollout",
    "scenario",
    input.scenarioOccurrence,
    "replicate",
    input.replicate,
    "chance",
    state.chanceOrdinal,
    pending.kind,
    pending.player,
    source,
  );
  const card = rng.pick(eligible);
  state.chanceOrdinal += 1;
  if (pending.kind === "waste-draw") {
    return {
      type: "waste-card-drawn",
      schemaVersion: 1,
      seat: pending.player,
      card,
    };
  }
  return {
    type: "player-card-drawn",
    schemaVersion: 1,
    seat: pending.player,
    source: pending.source,
    card,
  };
}

function policyIdFor(policies: RolloutPolicyIds, seat: Seat): BaselinePolicyId {
  if (seat === "user") {
    return policies.userContinuation;
  }
  return policies[seat];
}

function policyEvent(
  state: MutableRolloutState,
  input: TerminalRolloutInput,
): CardPlayedEvent | HandTakenEvent {
  const seat = state.exact.publicState.turn;
  if (seat === null) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      "An active rollout state has no actor.",
    );
  }
  const decisionOrdinal = state.decisionOrdinals[seat];
  const observation: PolicyObservation = createActorObservation(
    {
      publicState: state.exact.publicState,
      exactHands: state.exact.hands,
    },
    seat,
    decisionOrdinal,
    state.events ?? undefined,
  );
  const policy = getBaselinePolicy(policyIdFor(input.policies, seat));
  const stochastic = STOCHASTIC_POLICY_IDS.has(policy.id);
  const decisionRng = stochastic
    ? createSeededRng(input.seeds.rollout).fork(
        "terminal-root-rollout",
        "replicate",
        input.replicate,
        "policy",
        seat,
        "decision",
        decisionOrdinal,
      )
    : DETERMINISTIC_POLICY_RNG;
  const target =
    policy.chooseTakeTarget === undefined
      ? null
      : policy.chooseTakeTarget(
          observation,
          stochastic
            ? decisionRng.fork("take-target")
            : DETERMINISTIC_POLICY_RNG,
        );
  state.decisionOrdinals[seat] += 1;
  if (target !== null) {
    if (!(observation.legalTakeTargets ?? []).includes(target)) {
      throw new SearchError(
        "ILLEGAL_POLICY_ACTION",
        `${policy.id} chose illegal take target ${target}.`,
        { seat, decisionOrdinal, policyId: policy.id },
      );
    }
    state.policyDecisions.push({
      seat,
      decisionOrdinal,
      policyId: policy.id,
      actionKey: `take:${target}`,
      rngStreamId: decisionRng.streamId,
    });
    return {
      type: "hand-taken",
      schemaVersion: 1,
      actor: seat,
      target,
      revealedCards:
        seat === "user" || target === "user"
          ? [...state.exact.hands[target]]
          : [],
    };
  }
  const choice = policy.chooseCard(
    observation,
    stochastic ? decisionRng.fork("card") : DETERMINISTIC_POLICY_RNG,
  );
  if (!observation.legalCards.includes(choice.card)) {
    throw new SearchError(
      "ILLEGAL_POLICY_ACTION",
      `${policy.id} chose illegal card ${choice.card}.`,
      {
        seat,
        decisionOrdinal,
        policyId: policy.id,
        legalCards: observation.legalCards,
      },
    );
  }
  state.policyDecisions.push({
    seat,
    decisionOrdinal,
    policyId: policy.id,
    actionKey: `play:${choice.card}`,
    rngStreamId: decisionRng.streamId,
  });
  return {
    type: "card-played",
    schemaVersion: 1,
    seat,
    card: choice.card,
  };
}

function firstOpponentEscape(
  state: PublicInformationState,
): "p2" | "p3" | "tie" | null {
  for (const group of state.escapeGroups) {
    const p2 = group.seats.includes("p2");
    const p3 = group.seats.includes("p3");
    if (p2 && p3) {
      return "tie";
    }
    if (p2) {
      return "p2";
    }
    if (p3) {
      return "p3";
    }
  }
  return null;
}

function userFinish(
  state: PublicInformationState,
): TerminalOutcome["userFinish"] {
  if (state.bhabhi === "user") {
    return "bhabhi";
  }
  const groupIndex = state.escapeGroups.findIndex((group) =>
    group.seats.includes("user"),
  );
  if (groupIndex === -1) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      "A safe user is absent from the terminal escape groups.",
    );
  }
  const group = state.escapeGroups[groupIndex];
  if (group === undefined || group.seats.length > 1) {
    return "tied-safe";
  }
  const priorOpponentEscapes = state.escapeGroups
    .slice(0, groupIndex)
    .flatMap((candidate) => candidate.seats)
    .filter((seat) => seat !== "user").length;
  return priorOpponentEscapes === 0 ? "first" : "second";
}

function terminalReason(
  state: PublicInformationState,
): TerminalOutcome["terminalReason"] {
  const completion = [...state.effects]
    .reverse()
    .find((effect) => effect.type === "game-completed");
  if (completion?.type !== "game-completed") {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      "A completed rollout has no game-completed rule effect.",
    );
  }
  return completion.reason;
}

function terminalOutcome(
  state: PublicInformationState,
  userHeadsUpOpponent: OpponentSeat | null,
): TerminalOutcome {
  const bhabhi = state.bhabhi;
  if (state.status !== "complete" || bhabhi === null) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      "Terminal rollout ended without a Bhabhi.",
    );
  }
  return {
    bhabhi,
    loss: Object.fromEntries(
      SEATS.map((seat) => [seat, seat === bhabhi ? 1 : 0] as const),
    ) as Record<Seat, 0 | 1>,
    escapeGroups: structuredClone(state.escapeGroups),
    firstOpponentEscape: firstOpponentEscape(state),
    userHeadsUpOpponent,
    terminalReason: terminalReason(state),
    userFinish: userFinish(state),
  };
}

function rolloutIsActive(state: MutableRolloutState): boolean {
  return state.exact.publicState.status === "active";
}

function nextRolloutEvent(
  state: MutableRolloutState,
  input: TerminalRolloutInput,
): ExactHandEvent {
  return state.exact.publicState.pendingAction === null
    ? policyEvent(state, input)
    : chanceEvent(state, input);
}

export function runTerminalRollout(
  input: TerminalRolloutInput,
): RolloutOutcome {
  assertNotCancelled(input);
  if (
    !Number.isSafeInteger(input.scenarioOccurrence) ||
    input.scenarioOccurrence < 0 ||
    !Number.isSafeInteger(input.replicate) ||
    input.replicate < 0
  ) {
    throw new SearchError(
      "INVALID_REQUEST",
      "Scenario occurrence and replicate must be non-negative safe integers.",
    );
  }
  const state = createMutableState(input);
  if (
    input.activeEvents !== undefined &&
    input.activeEvents.length !== state.exact.publicState.appliedEventCount
  ) {
    throw new SearchError(
      "STALE_WORLD",
      "Rollout event ledger length does not match the public state.",
      {
        eventLedgerLength: input.activeEvents.length,
        appliedEventCount: state.exact.publicState.appliedEventCount,
      },
    );
  }
  if (
    state.exact.publicState.status !== "active" ||
    state.exact.publicState.turn !== "user" ||
    state.exact.publicState.pendingAction !== null
  ) {
    throw new SearchError(
      "NOT_USER_TURN",
      "Root rollout requires an active, non-chance user turn.",
    );
  }
  const legalRootActions = legalUserActions(state.exact.publicState);
  if (
    !legalRootActions.some(
      (candidate) => actionKey(candidate) === actionKey(input.action),
    )
  ) {
    throw new SearchError(
      "INVALID_REQUEST",
      `${actionKey(input.action)} is not a legal user root action.`,
      {
        action: input.action,
        legalActionKeys: legalRootActions.map(actionKey),
      },
    );
  }

  const root: RootDiagnostics = {
    resolved: input.action.kind === "take-hand",
    pickup: false,
    pickupCount: 0,
    power:
      input.action.kind === "take-hand" &&
      state.exact.publicState.power === "user",
  };
  const rootEvent = actionEvent(input.action, state.exact.hands);
  state.decisionOrdinals.user += 1;
  applyEvent(state, rootEvent, input, root);
  if (input.action.kind === "take-hand") {
    root.power = state.exact.publicState.power === "user";
  }

  while (rolloutIsActive(state)) {
    applyEvent(state, nextRolloutEvent(state, input), input, root);
  }
  if (!root.resolved) {
    throw new SearchError(
      "INVARIANT_VIOLATION",
      "Terminal rollout did not resolve root-trick diagnostics.",
    );
  }
  assertExactHandStateInvariant(state.exact);
  const terminal = terminalOutcome(
    state.exact.publicState,
    state.userHeadsUpOpponent,
  );
  const deterministicHash = stableHash({
    schemaVersion: 1,
    scenarioOccurrence: input.scenarioOccurrence,
    replicate: input.replicate,
    action: input.action,
    terminal,
    rootPickup: root.pickup,
    rootPickupCount: root.pickupCount,
    rootPower: root.power,
    eventCount: state.simulatedEventCount,
    chanceCount:
      state.chanceOrdinal - existingChanceOrdinal(input.activeEvents),
    terminalState: state.exact.publicState,
    generatedEvents: state.generatedEvents,
    policyDecisions: state.policyDecisions,
  });
  return {
    scenarioOccurrence: input.scenarioOccurrence,
    replicate: input.replicate,
    actionKey: actionKey(input.action),
    terminal,
    rootPickup: root.pickup,
    rootPickupCount: root.pickupCount,
    rootPower: root.power,
    eventCount: state.simulatedEventCount,
    chanceCount:
      state.chanceOrdinal - existingChanceOrdinal(input.activeEvents),
    policyDecisions: state.policyDecisions,
    deterministicHash,
  };
}
