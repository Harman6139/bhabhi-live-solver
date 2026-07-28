import { isCard, rankValue, suitOf, type Card } from "../domain/cards";
import type { OpponentSeat } from "../domain/seats";
import {
  jointOwnershipProbability,
  ownershipProbability,
  suitLengthDistribution,
} from "../inference/queries";
import type { ExactProbability, HardEvidence } from "../inference/types";
import type { PublicInformationState } from "../public/public-state";
import { legalTakeTargets } from "../rules/legal-actions";
import type { CalibrationPredictionRecord } from "./artifact-schema";
import { parseCalibrationQueryKey } from "./query-key";

type CalibrationTarget = CalibrationPredictionRecord["target"];

export type CalibrationFeasibleSupport = {
  readonly labels: readonly string[];
  readonly hardKnown: boolean;
};

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function fail(message: string): never {
  throw new Error(`Calibration hard-support derivation failed: ${message}`);
}

function positive(probability: ExactProbability): boolean {
  return BigInt(probability.numerator) > 0n;
}

function lessThanOne(probability: ExactProbability): boolean {
  return BigInt(probability.numerator) < BigInt(probability.denominator);
}

function currentOpponentCards(state: PublicInformationState): readonly Card[] {
  return [
    ...new Set([
      ...state.knownOpponentCards.p2,
      ...state.knownOpponentCards.p3,
      ...state.unresolvedCards,
    ]),
  ];
}

function otherOpponent(seat: OpponentSeat): OpponentSeat {
  return seat === "p2" ? "p3" : "p2";
}

function noSeatCardProbability(
  evidence: HardEvidence,
  seat: OpponentSeat,
  cards: readonly Card[],
): ExactProbability {
  const other = otherOpponent(seat);
  return jointOwnershipProbability(
    evidence,
    cards.map((card) => ({ seat: other, card })),
  );
}

function booleanLabels(
  falseFeasible: boolean,
  trueFeasible: boolean,
): readonly string[] {
  const labels = [
    ...(falseFeasible ? ["false"] : []),
    ...(trueFeasible ? ["true"] : []),
  ];
  if (labels.length === 0) {
    fail("a Boolean target has no feasible outcome.");
  }
  return labels;
}

function exactQueryLabels(
  target: Extract<CalibrationTarget, { readonly kind: "query" }>,
  state: PublicInformationState,
  evidence: HardEvidence,
): readonly string[] {
  const query = parseCalibrationQueryKey(target.queryKey);
  switch (query.family) {
    case "card-owner":
      return (["p2", "p3"] as const).filter((seat) =>
        positive(ownershipProbability(evidence, seat, query.card)),
      );
    case "current-void": {
      const distribution = suitLengthDistribution(
        evidence,
        query.seat,
        query.suit,
      );
      const voidProbability = distribution.probabilities.find(
        (entry) => entry.length === 0,
      );
      const trueFeasible =
        voidProbability !== undefined && positive(voidProbability);
      const falseFeasible =
        voidProbability === undefined || lessThanOne(voidProbability);
      return booleanLabels(falseFeasible, trueFeasible);
    }
    case "suit-length":
      return suitLengthDistribution(evidence, query.seat, query.suit)
        .probabilities.filter(positive)
        .map((entry) => entry.length.toString())
        .sort(compareText);
    case "can-overtake": {
      const highCards = currentOpponentCards(state).filter(
        (card) =>
          suitOf(card) === query.suit && rankValue(card) > query.rankToBeat,
      );
      const falseProbability = noSeatCardProbability(
        evidence,
        query.seat,
        highCards,
      );
      return booleanLabels(
        positive(falseProbability),
        lessThanOne(falseProbability),
      );
    }
    case "joint":
    case "conditional": {
      const suitCards = currentOpponentCards(state).filter(
        (card) => suitOf(card) === query.suit,
      );
      const voidCondition = jointOwnershipProbability(
        evidence,
        suitCards.map((card) => ({
          seat: query.overtakeSeat,
          card,
        })),
      );
      if (!positive(voidCondition)) {
        if (query.family === "joint") {
          return ["false"];
        }
        fail("a conditional target has zero hard conditioning support.");
      }
      const hasOvertakeCard = suitCards.some(
        (card) => rankValue(card) > query.rankToBeat,
      );
      if (query.family === "conditional") {
        return [hasOvertakeCard ? "true" : "false"];
      }
      const trueFeasible = hasOvertakeCard && positive(voidCondition);
      const falseFeasible = !hasOvertakeCard || lessThanOne(voidCondition);
      return booleanLabels(falseFeasible, trueFeasible);
    }
  }
}

function actionCard(actionKey: string): Card | null {
  if (!actionKey.startsWith("play:")) {
    return null;
  }
  const value = actionKey.slice("play:".length);
  return isCard(value) ? value : null;
}

function exactPlayFeasible(
  card: Card,
  seat: OpponentSeat,
  state: PublicInformationState,
  evidence: HardEvidence,
): boolean {
  const trick = state.trick;
  if (
    state.status !== "active" ||
    state.pendingAction !== null ||
    state.turn !== seat ||
    trick === null
  ) {
    return false;
  }
  if (trick.plays.length === 0) {
    if (trick.forcedLeadCard !== null) {
      return trick.forcedLeadCard === card;
    }
    return positive(ownershipProbability(evidence, seat, card));
  }
  if (trick.leadSuit === null) {
    return false;
  }
  if (suitOf(card) === trick.leadSuit) {
    return positive(ownershipProbability(evidence, seat, card));
  }

  const leadSuitCards = currentOpponentCards(state).filter(
    (candidate) => suitOf(candidate) === trick.leadSuit,
  );
  const claims = [
    { seat, card },
    ...leadSuitCards.map((candidate) => ({
      seat: otherOpponent(seat),
      card: candidate,
    })),
  ];
  return positive(jointOwnershipProbability(evidence, claims));
}

function exactActionLabels(
  target: Extract<CalibrationTarget, { readonly kind: "opponent-action" }>,
  state: PublicInformationState,
  evidence: HardEvidence,
): readonly string[] {
  const feasible = target.legalActionKeys.filter((actionKey) => {
    const card = actionCard(actionKey);
    if (card !== null) {
      return exactPlayFeasible(card, target.actor, state, evidence);
    }
    if (!actionKey.startsWith("take:")) {
      fail(`action key "${actionKey}" is malformed.`);
    }
    const targetSeat = actionKey.slice("take:".length);
    return legalTakeTargets(state, target.actor).some(
      (seat) => seat === targetSeat,
    );
  });
  if (feasible.length === 0) {
    fail("an opponent-action target has no feasible legal action.");
  }
  return feasible.sort(compareText);
}

export function deriveCalibrationFeasibleSupport(input: {
  readonly target: Exclude<
    CalibrationTarget,
    { readonly kind: "terminal-risk" }
  >;
  readonly state: PublicInformationState;
  readonly evidence: HardEvidence;
}): CalibrationFeasibleSupport {
  const labels =
    input.target.kind === "query"
      ? exactQueryLabels(input.target, input.state, input.evidence)
      : exactActionLabels(input.target, input.state, input.evidence);
  const declared =
    input.target.kind === "query"
      ? input.target.labels
      : input.target.legalActionKeys;
  const declaredSet = new Set(declared);
  if (labels.some((label) => !declaredSet.has(label))) {
    fail("derived hard support is absent from the declared target labels.");
  }
  return Object.freeze({
    labels: Object.freeze([...labels].sort(compareText)),
    hardKnown: labels.length === 1,
  });
}
