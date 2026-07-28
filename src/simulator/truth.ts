import type { Card } from "../domain/cards";
import type { RuleConfig } from "../domain/rule-config";
import type { Seat } from "../domain/seats";
import type {
  CardPlayedEvent,
  HandTakenEvent,
  PlayerCardDrawnEvent,
  WasteCardDrawnEvent,
} from "../events/game-events";
import type { PublicInformationState } from "../public/public-state";
import {
  applyExactHandCardPlay,
  applyExactHandPlayerDraw,
  applyExactHandTake,
  applyExactHandWasteDraw,
  assertExactHandStateInvariant,
  createExactHandState,
  legalExactHandCards,
  type ExactHandState,
} from "../rules/exact-hand-transition";

export type SimulationTruth = {
  readonly namespace: "simulator-truth";
  publicState: PublicInformationState;
  hands: Record<Seat, Card[]>;
};

function asExactHandState(truth: SimulationTruth): ExactHandState {
  return {
    publicState: truth.publicState,
    hands: truth.hands,
  };
}

function fromExactHandState(state: ExactHandState): SimulationTruth {
  return {
    namespace: "simulator-truth",
    publicState: state.publicState,
    hands: state.hands,
  };
}

export function createSimulationTruth(
  handsValue: Readonly<Record<Seat, readonly Card[]>>,
  rules: RuleConfig,
): SimulationTruth {
  return fromExactHandState(createExactHandState(handsValue, rules));
}

export function legalTruthCards(
  truth: SimulationTruth,
  seat: Seat = truth.publicState.turn ?? "user",
): Card[] {
  return legalExactHandCards(asExactHandState(truth), seat);
}

export function applyTruthCardPlay(
  inputTruth: SimulationTruth,
  event: CardPlayedEvent,
  eventIndex = inputTruth.publicState.appliedEventCount,
): SimulationTruth {
  return fromExactHandState(
    applyExactHandCardPlay(asExactHandState(inputTruth), event, eventIndex),
  );
}

export function applyTruthWasteDraw(
  inputTruth: SimulationTruth,
  event: WasteCardDrawnEvent,
  eventIndex = inputTruth.publicState.appliedEventCount,
): SimulationTruth {
  return fromExactHandState(
    applyExactHandWasteDraw(asExactHandState(inputTruth), event, eventIndex),
  );
}

export function applyTruthPlayerDraw(
  inputTruth: SimulationTruth,
  event: PlayerCardDrawnEvent,
  eventIndex = inputTruth.publicState.appliedEventCount,
): SimulationTruth {
  return fromExactHandState(
    applyExactHandPlayerDraw(asExactHandState(inputTruth), event, eventIndex),
  );
}

export function applyTruthHandTaken(
  inputTruth: SimulationTruth,
  event: HandTakenEvent,
  eventIndex = inputTruth.publicState.appliedEventCount,
): SimulationTruth {
  return fromExactHandState(
    applyExactHandTake(asExactHandState(inputTruth), event, eventIndex),
  );
}

export function assertSimulationTruthInvariant(truth: SimulationTruth): void {
  assertExactHandStateInvariant(asExactHandState(truth));
}
