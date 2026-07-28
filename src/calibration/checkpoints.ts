import type { OpponentSeat } from "../domain/seats";
import type {
  CardPlayedEvent,
  GameEvent,
  HandTakenEvent,
} from "../events/game-events";
import { replayEvents } from "../events/timeline";
import { applyGameEvent } from "../rules/reducer";
import type { Phase6CalibrationCheckpointClass } from "./protocol";

export const PHASE6_PUBLIC_EVENT_ORDINALS = [12, 24, 36] as const;
export type Phase6PublicEventOrdinal =
  (typeof PHASE6_PUBLIC_EVENT_ORDINALS)[number];

export const PHASE6_OPPONENT_DECISION_ORDINALS = [2, 5, 8] as const;
export type Phase6OpponentDecisionOrdinal =
  (typeof PHASE6_OPPONENT_DECISION_ORDINALS)[number];

export type CalibrationCheckpointClass = Phase6CalibrationCheckpointClass;

export type CalibrationCheckpointReason =
  | "initial"
  | "post-opening"
  | `fixed-public-event-${Phase6PublicEventOrdinal}`
  | "post-normal-thulla"
  | "post-visible-pickup"
  | `pre-opponent-choice-${OpponentSeat}-${Phase6OpponentDecisionOrdinal}`;

export type OpponentDecisionEvent =
  | (CardPlayedEvent & { readonly seat: OpponentSeat })
  | (HandTakenEvent & { readonly actor: OpponentSeat });

type CalibrationCheckpointBase = {
  /**
   * Number of public events in the checkpoint prefix. This is also the
   * zero-based index of actualNextEvent at a pre-action checkpoint.
   */
  readonly eventIndex: number;
  readonly id: string;
  /**
   * Canonically ordered protocol classes. Multiple schedule reasons that
   * name the same prefix state are retained instead of duplicating the state.
   * Concrete ordinals and actors remain encoded in the deterministic ID.
   */
  readonly checkpointClass: readonly CalibrationCheckpointClass[];
};

export type PostEventCalibrationCheckpoint = CalibrationCheckpointBase & {
  readonly timing: "post-event";
  readonly actualNextEvent: null;
};

export type PreActionCalibrationCheckpoint = CalibrationCheckpointBase & {
  readonly timing: "pre-action";
  readonly actualNextEvent: OpponentDecisionEvent;
};

export type CalibrationCheckpoint =
  PostEventCalibrationCheckpoint | PreActionCalibrationCheckpoint;

type MutableCheckpoint = {
  readonly eventIndex: number;
  readonly reasons: Set<CalibrationCheckpointReason>;
  actualNextEvent: OpponentDecisionEvent | null;
};

const REASON_ORDER = new Map<CalibrationCheckpointReason, number>([
  ["initial", 0],
  ["post-opening", 1],
  ["fixed-public-event-12", 2],
  ["fixed-public-event-24", 3],
  ["fixed-public-event-36", 4],
  ["post-normal-thulla", 5],
  ["post-visible-pickup", 6],
]);
const CHECKPOINT_CLASS_ORDER = new Map<
  Phase6CalibrationCheckpointClass,
  number
>([
  ["initial", 0],
  ["post-opening", 1],
  ["fixed-public-event", 2],
  ["post-thulla", 3],
  ["post-visible-pickup", 4],
  ["pre-opponent-choice", 5],
]);
const SELECTED_DECISION_ORDINALS = new Set<number>(
  PHASE6_OPPONENT_DECISION_ORDINALS,
);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function opponentDecision(event: GameEvent): {
  readonly seat: OpponentSeat;
  readonly event: OpponentDecisionEvent;
} | null {
  if (
    event.type === "card-played" &&
    (event.seat === "p2" || event.seat === "p3")
  ) {
    return {
      seat: event.seat,
      event: { ...event, seat: event.seat },
    };
  }
  if (
    event.type === "hand-taken" &&
    (event.actor === "p2" || event.actor === "p3")
  ) {
    return {
      seat: event.actor,
      event: { ...event, actor: event.actor },
    };
  }
  return null;
}

function decisionReason(
  seat: OpponentSeat,
  ordinal: Phase6OpponentDecisionOrdinal,
): CalibrationCheckpointReason {
  return `pre-opponent-choice-${seat}-${ordinal}`;
}

function fixedEventReason(
  ordinal: Phase6PublicEventOrdinal,
): CalibrationCheckpointReason {
  return `fixed-public-event-${ordinal}`;
}

function isSelectedDecisionOrdinal(
  value: number,
): value is Phase6OpponentDecisionOrdinal {
  return SELECTED_DECISION_ORDINALS.has(value);
}

function reasonOrder(value: CalibrationCheckpointReason): string {
  const fixedOrder = REASON_ORDER.get(value);
  return fixedOrder === undefined
    ? `7/${value}`
    : `${fixedOrder.toString().padStart(2, "0")}/${value}`;
}

function canonicalReasons(
  values: ReadonlySet<CalibrationCheckpointReason>,
): readonly CalibrationCheckpointReason[] {
  return [...values].sort((left, right) =>
    reasonOrder(left).localeCompare(reasonOrder(right)),
  );
}

function checkpointClassForReason(
  reason: CalibrationCheckpointReason,
): Phase6CalibrationCheckpointClass {
  if (reason === "initial" || reason === "post-opening") {
    return reason;
  }
  if (reason.startsWith("fixed-public-event-")) {
    return "fixed-public-event";
  }
  if (reason === "post-normal-thulla") {
    return "post-thulla";
  }
  if (reason === "post-visible-pickup") {
    return "post-visible-pickup";
  }
  return "pre-opponent-choice";
}

function canonicalClasses(
  reasons: readonly CalibrationCheckpointReason[],
): readonly CalibrationCheckpointClass[] {
  return [...new Set(reasons.map(checkpointClassForReason))].sort(
    (left, right) =>
      (CHECKPOINT_CLASS_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (CHECKPOINT_CLASS_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

function addReason(
  checkpoints: Map<number, MutableCheckpoint>,
  eventIndex: number,
  reason: CalibrationCheckpointReason,
): MutableCheckpoint {
  const existing = checkpoints.get(eventIndex);
  if (existing !== undefined) {
    existing.reasons.add(reason);
    return existing;
  }
  const created: MutableCheckpoint = {
    eventIndex,
    reasons: new Set([reason]),
    actualNextEvent: null,
  };
  checkpoints.set(eventIndex, created);
  return created;
}

function addPreAction(
  checkpoints: Map<number, MutableCheckpoint>,
  eventIndex: number,
  reason: CalibrationCheckpointReason,
  actualNextEvent: OpponentDecisionEvent,
): void {
  const checkpoint = addReason(checkpoints, eventIndex, reason);
  if (
    checkpoint.actualNextEvent !== null &&
    checkpoint.actualNextEvent !== actualNextEvent
  ) {
    throw new Error(
      `Two opponent actions unexpectedly share checkpoint ${eventIndex.toString()}.`,
    );
  }
  checkpoint.actualNextEvent = actualNextEvent;
}

function asCheckpoint(value: MutableCheckpoint): CalibrationCheckpoint {
  const reasons = canonicalReasons(value.reasons);
  const checkpointClass = canonicalClasses(reasons);
  if (value.actualNextEvent === null) {
    const timing = "post-event" as const;
    const id = [
      "phase6-checkpoint",
      value.eventIndex.toString(),
      timing,
      reasons.join("+"),
    ].join("/");
    return deepFreeze({
      eventIndex: value.eventIndex,
      timing,
      id,
      checkpointClass,
      actualNextEvent: null,
    });
  }
  const timing = "pre-action" as const;
  const id = [
    "phase6-checkpoint",
    value.eventIndex.toString(),
    timing,
    reasons.join("+"),
  ].join("/");
  return deepFreeze({
    eventIndex: value.eventIndex,
    timing,
    id,
    checkpointClass,
    actualNextEvent: structuredClone(value.actualNextEvent),
  });
}

/**
 * Selects the frozen Phase 6 calibration schedule from a public event ledger.
 *
 * No simulator decision log is required. Opponent decision ordinals are
 * reconstructed independently for P2 and P3 from public card-played and
 * hand-taken events.
 */
export function selectPhase6CalibrationCheckpoints(
  events: readonly GameEvent[],
): readonly CalibrationCheckpoint[] {
  // Validate the complete supplied ledger before emitting any partial plan.
  replayEvents(events);

  const checkpoints = new Map<number, MutableCheckpoint>();
  addReason(checkpoints, 1, "initial");
  for (const ordinal of PHASE6_PUBLIC_EVENT_ORDINALS) {
    if (ordinal <= events.length) {
      addReason(checkpoints, ordinal, fixedEventReason(ordinal));
    }
  }

  const initialReplay = replayEvents(events.slice(0, 1));
  let publicState = initialReplay.state;
  let foundPostOpening = publicState.phase === "normal";
  let foundNormalThulla = false;
  let foundVisiblePickup = false;
  const decisionOrdinals: Record<OpponentSeat, number> = { p2: 0, p3: 0 };

  for (
    let actualEventIndex = 1;
    actualEventIndex < events.length;
    actualEventIndex += 1
  ) {
    const event = events[actualEventIndex];
    if (event === undefined || event.type === "game-created") {
      throw new Error(
        `Calibration history has an invalid event at ${actualEventIndex.toString()}.`,
      );
    }

    const decision = opponentDecision(event);
    if (decision !== null) {
      const ordinal = decisionOrdinals[decision.seat];
      if (isSelectedDecisionOrdinal(ordinal)) {
        addPreAction(
          checkpoints,
          actualEventIndex,
          decisionReason(decision.seat, ordinal),
          decision.event,
        );
      }
      decisionOrdinals[decision.seat] = ordinal + 1;
    }

    const priorState = publicState;
    publicState = applyGameEvent(priorState, event, actualEventIndex);
    const prefixEventCount = actualEventIndex + 1;
    const newEffects = publicState.effects.slice(priorState.effects.length);

    if (
      !foundPostOpening &&
      priorState.phase === "opening" &&
      publicState.phase === "normal"
    ) {
      addReason(checkpoints, prefixEventCount, "post-opening");
      foundPostOpening = true;
    }
    if (
      !foundNormalThulla &&
      priorState.trick?.kind === "normal" &&
      newEffects.some((effect) => effect.type === "thulla")
    ) {
      addReason(checkpoints, prefixEventCount, "post-normal-thulla");
      foundNormalThulla = true;
    }
    if (
      !foundVisiblePickup &&
      newEffects.some((effect) => effect.type === "trick-picked-up")
    ) {
      addReason(checkpoints, prefixEventCount, "post-visible-pickup");
      foundVisiblePickup = true;
    }
  }

  return deepFreeze(
    [...checkpoints.values()]
      .sort((left, right) => left.eventIndex - right.eventIndex)
      .map(asCheckpoint),
  );
}
