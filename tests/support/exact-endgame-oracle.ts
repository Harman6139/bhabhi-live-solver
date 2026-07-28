import { createActorObservation } from "../../src/agents/observation";
import { sortCards } from "../../src/domain/cards";
import { SEATS, type OpponentSeat, type Seat } from "../../src/domain/seats";
import type {
  CardPlayedEvent,
  GameEvent,
  HandTakenEvent,
  PlayerCardDrawnEvent,
  WasteCardDrawnEvent,
} from "../../src/events/game-events";
import { stableHash } from "../../src/events/stable-hash";
import {
  behaviorModelDistribution,
  type BehaviorAction,
  type BehaviorModelConfig,
  type BehaviorModelId,
} from "../../src/inference/behavior-models";
import type { PublicInformationState } from "../../src/public/public-state";
import {
  applyExactHandEvent,
  type ExactHandEvent,
  type ExactHandState,
} from "../../src/rules/exact-hand-transition";
import {
  legalCardsForExactHand,
  legalTakeTargets,
} from "../../src/rules/legal-actions";
import type { UserAction } from "../../src/search/types";

const TOLERANCE = 1e-12;

export type OracleHypothesis = {
  readonly id: string;
  readonly mass: number;
  readonly p2ModelId: BehaviorModelId;
  readonly p3ModelId: BehaviorModelId;
  readonly hands: ExactHandState["hands"];
};

export type BruteForceOracleInput = {
  readonly publicState: PublicInformationState;
  readonly hypotheses: readonly OracleHypothesis[];
  readonly behaviorConfig: BehaviorModelConfig;
  readonly activeEvents?: readonly GameEvent[];
  readonly maximumDepth?: number;
};

export type BruteForceOracleResult = {
  readonly actionValues: readonly {
    readonly action: UserAction;
    readonly actionKey: string;
    readonly userBhabhiRisk: number;
    readonly bhabhiProbabilities: Readonly<Record<Seat, number>>;
    readonly positionalDiagnostics: OraclePositionalDiagnostics;
  }[];
  readonly recommendedActionKey: string;
  readonly tiedBestActionKeys: readonly string[];
};

export type OraclePositionalDiagnostics = {
  readonly immediatePickupProbability: number;
  readonly expectedImmediatePickupCount: number;
  readonly immediatePowerProbability: number;
  readonly firstOpponentEscapeProbabilities: Readonly<
    Record<"p2" | "p3" | "tie" | "none", number>
  >;
  readonly userHeadsUpOpponentProbabilities: Readonly<
    Record<"p2" | "p3" | "none", number>
  >;
};

type OracleImmediateResolution = Pick<
  OraclePositionalDiagnostics,
  | "immediatePickupProbability"
  | "expectedImmediatePickupCount"
  | "immediatePowerProbability"
>;

type OracleConcrete = {
  readonly id: string;
  readonly mass: number;
  readonly p2ModelId: BehaviorModelId;
  readonly p3ModelId: BehaviorModelId;
  readonly exact: ExactHandState;
  readonly events: readonly GameEvent[] | undefined;
  readonly userHeadsUpOpponent: OpponentSeat | null;
};

type OracleState = {
  readonly hypotheses: readonly OracleConcrete[];
};

type OracleTransition = {
  readonly hypothesis: OracleConcrete;
  readonly resolvedTrick: OracleImmediateResolution | null;
};

type OracleBranch = {
  readonly probability: number;
  readonly state: OracleState;
  readonly resolvedTrick: OracleImmediateResolution | null;
};

type OracleNodeValue = {
  readonly bhabhiProbabilities: Readonly<Record<Seat, number>>;
  readonly firstOpponentEscapeProbabilities: Readonly<
    Record<"p2" | "p3" | "tie" | "none", number>
  >;
  readonly userHeadsUpOpponentProbabilities: Readonly<
    Record<"p2" | "p3" | "none", number>
  >;
  readonly pendingTrickResolution: OracleImmediateResolution | null;
};

type OracleBranchValue = {
  readonly bhabhiProbabilities: Readonly<Record<Seat, number>>;
  readonly firstOpponentEscapeProbabilities: Readonly<
    Record<"p2" | "p3" | "tie" | "none", number>
  >;
  readonly userHeadsUpOpponentProbabilities: Readonly<
    Record<"p2" | "p3" | "none", number>
  >;
  readonly firstResolution: OracleImmediateResolution | null;
};

function decisionOrdinal(state: PublicInformationState, seat: Seat): number {
  return state.effects.filter(
    (effect) =>
      (effect.type === "card-played" && effect.seat === seat) ||
      (effect.type === "hand-taken" && effect.actor === seat),
  ).length;
}

function currentUserHeadsUpOpponent(
  state: PublicInformationState,
): OpponentSeat | null {
  if (state.activeSeats.length !== 2 || !state.activeSeats.includes("user")) {
    return null;
  }
  const opponent = state.activeSeats.find((seat) => seat !== "user");
  return opponent === "p2" || opponent === "p3" ? opponent : null;
}

function awaitingTrickResolution(state: PublicInformationState): boolean {
  return (
    state.trick !== null ||
    (state.pendingAction !== null &&
      state.pendingAction.excludedTrick.length > 0)
  );
}

function actionKey(action: UserAction): string {
  return action.kind === "play-card"
    ? `play:${action.card}`
    : `take:${action.target}`;
}

function userActions(state: OracleConcrete): UserAction[] {
  const cards = sortCards(
    legalCardsForExactHand(
      state.exact.publicState,
      "user",
      state.exact.hands.user,
    ),
  ).map((card): UserAction => ({ kind: "play-card", card }));
  const takes = legalTakeTargets(state.exact.publicState, "user")
    .filter((target): target is OpponentSeat => target !== "user")
    .map((target): UserAction => ({ kind: "take-hand", target }));
  return [...cards, ...takes].sort((left, right) =>
    actionKey(left).localeCompare(actionKey(right)),
  );
}

function userEvent(
  action: UserAction,
  state: OracleConcrete,
): CardPlayedEvent | HandTakenEvent {
  return action.kind === "play-card"
    ? {
        type: "card-played",
        schemaVersion: 1,
        seat: "user",
        card: action.card,
      }
    : {
        type: "hand-taken",
        schemaVersion: 1,
        actor: "user",
        target: action.target,
        revealedCards: [...state.exact.hands[action.target]],
      };
}

function opponentEvent(
  action: BehaviorAction,
  seat: OpponentSeat,
  state: OracleConcrete,
): CardPlayedEvent | HandTakenEvent {
  return action.kind === "play-card"
    ? {
        type: "card-played",
        schemaVersion: 1,
        seat,
        card: action.card,
      }
    : {
        type: "hand-taken",
        schemaVersion: 1,
        actor: seat,
        target: action.target,
        revealedCards:
          action.target === "user" ? [...state.exact.hands[action.target]] : [],
      };
}

function chanceEvents(
  state: OracleConcrete,
): readonly (WasteCardDrawnEvent | PlayerCardDrawnEvent)[] {
  const pending = state.exact.publicState.pendingAction;
  if (pending === null) {
    throw new Error("Oracle chance expansion has no pending action.");
  }
  if (pending.kind === "waste-draw") {
    return sortCards(state.exact.publicState.waste).map((card) => ({
      type: "waste-card-drawn" as const,
      schemaVersion: 1 as const,
      seat: pending.player,
      card,
    }));
  }
  return sortCards(state.exact.hands[pending.source]).map((card) => ({
    type: "player-card-drawn" as const,
    schemaVersion: 1 as const,
    seat: pending.player,
    source: pending.source,
    card,
  }));
}

function transition(
  state: OracleConcrete,
  event: ExactHandEvent,
  mass: number,
): OracleTransition {
  const priorEffectCount = state.exact.publicState.effects.length;
  const exact = applyExactHandEvent(
    state.exact,
    event,
    state.exact.publicState.appliedEventCount,
    "full",
  );
  return {
    hypothesis: {
      ...state,
      mass,
      exact,
      events:
        state.events === undefined
          ? undefined
          : [...state.events, structuredClone(event)],
      userHeadsUpOpponent:
        state.userHeadsUpOpponent ??
        currentUserHeadsUpOpponent(exact.publicState),
    },
    resolvedTrick: immediateResolution(exact.publicState, priorEffectCount),
  };
}

function immediateResolution(
  state: PublicInformationState,
  priorEffectCount: number,
): OracleImmediateResolution | null {
  const effects = state.effects.slice(priorEffectCount);
  const pickup = effects.find((effect) => effect.type === "trick-picked-up");
  if (pickup?.type === "trick-picked-up") {
    return {
      immediatePickupProbability: pickup.picker === "user" ? 1 : 0,
      expectedImmediatePickupCount:
        pickup.picker === "user" ? pickup.cards.length : 0,
      immediatePowerProbability: state.power === "user" ? 1 : 0,
    };
  }
  if (
    effects.some((effect) => effect.type === "trick-wasted") ||
    state.status === "complete"
  ) {
    return {
      immediatePickupProbability: 0,
      expectedImmediatePickupCount: 0,
      immediatePowerProbability: state.power === "user" ? 1 : 0,
    };
  }
  return null;
}

function userTransition(
  state: OracleConcrete,
  action: UserAction,
  mass: number,
): OracleTransition {
  const child = transition(state, userEvent(action, state), mass);
  if (action.kind !== "take-hand") {
    return child;
  }
  return {
    ...child,
    resolvedTrick: {
      immediatePickupProbability: 0,
      expectedImmediatePickupCount: 0,
      immediatePowerProbability:
        child.hypothesis.exact.publicState.power === "user" ? 1 : 0,
    },
  };
}

/**
 * Deliberately independent oracle grouping: it hashes the complete public
 * reducer state, not the production exact solver's observable-key helper.
 * Public state contains no concrete hidden allocation.
 */
function publicObservationKey(state: OracleConcrete): string {
  return stableHash({
    publicState: state.exact.publicState,
    userHeadsUpOpponent: state.userHeadsUpOpponent,
  });
}

function grouped(
  children: readonly OracleTransition[],
): readonly OracleBranch[] {
  const buckets = new Map<string, OracleTransition[]>();
  for (const child of children) {
    const key = publicObservationKey(child.hypothesis);
    const bucket = buckets.get(key) ?? [];
    bucket.push(child);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, childrenInBucket]) => {
      const probability = childrenInBucket.reduce(
        (sum, child) => sum + child.hypothesis.mass,
        0,
      );
      const resolutions = childrenInBucket.map((child) => child.resolvedTrick);
      const resolvedCount = resolutions.filter(
        (resolution) => resolution !== null,
      ).length;
      if (resolvedCount !== 0 && resolvedCount !== childrenInBucket.length) {
        throw new Error(
          "Oracle observation branch mixed resolved and unresolved tricks.",
        );
      }
      const resolvedTrick =
        resolvedCount === 0
          ? null
          : childrenInBucket.reduce((aggregate, child) => {
              if (child.resolvedTrick === null) {
                throw new Error(
                  "Oracle resolved branch lost its positional outcome.",
                );
              }
              const weight = child.hypothesis.mass / probability;
              aggregate.immediatePickupProbability +=
                weight * child.resolvedTrick.immediatePickupProbability;
              aggregate.expectedImmediatePickupCount +=
                weight * child.resolvedTrick.expectedImmediatePickupCount;
              aggregate.immediatePowerProbability +=
                weight * child.resolvedTrick.immediatePowerProbability;
              return aggregate;
            }, zeroImmediateResolution());
      return {
        probability,
        state: {
          hypotheses: childrenInBucket.map((child) => ({
            ...child.hypothesis,
            mass: child.hypothesis.mass / probability,
          })),
        },
        resolvedTrick,
      };
    });
}

function zeroVector(): Record<Seat, number> {
  return { user: 0, p2: 0, p3: 0 };
}

function zeroFirstOpponentEscapeVector(): Record<
  "p2" | "p3" | "tie" | "none",
  number
> {
  return { p2: 0, p3: 0, tie: 0, none: 0 };
}

function zeroUserHeadsUpOpponentVector(): Record<"p2" | "p3" | "none", number> {
  return { p2: 0, p3: 0, none: 0 };
}

function zeroImmediateResolution(): {
  immediatePickupProbability: number;
  expectedImmediatePickupCount: number;
  immediatePowerProbability: number;
} {
  return {
    immediatePickupProbability: 0,
    expectedImmediatePickupCount: 0,
    immediatePowerProbability: 0,
  };
}

function firstOpponentEscape(
  state: PublicInformationState,
): "p2" | "p3" | "tie" | "none" {
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
  return "none";
}

function branchValue(
  branches: readonly OracleBranch[],
  behaviorConfig: BehaviorModelConfig,
  maximumDepth: number,
  depth: number,
): OracleBranchValue {
  const bhabhiProbabilities = zeroVector();
  const firstOpponentEscapeProbabilities = zeroFirstOpponentEscapeVector();
  const userHeadsUpOpponentProbabilities = zeroUserHeadsUpOpponentVector();
  const firstResolution = zeroImmediateResolution();
  let resolvedBranchCount = 0;
  for (const branch of branches) {
    const value = solveState(
      branch.state,
      behaviorConfig,
      maximumDepth,
      depth + 1,
    );
    for (const seat of SEATS) {
      bhabhiProbabilities[seat] +=
        branch.probability * value.bhabhiProbabilities[seat];
    }
    for (const key of ["p2", "p3", "tie", "none"] as const) {
      firstOpponentEscapeProbabilities[key] +=
        branch.probability * value.firstOpponentEscapeProbabilities[key];
    }
    for (const key of ["p2", "p3", "none"] as const) {
      userHeadsUpOpponentProbabilities[key] +=
        branch.probability * value.userHeadsUpOpponentProbabilities[key];
    }
    const resolution = branch.resolvedTrick ?? value.pendingTrickResolution;
    if (resolution !== null) {
      resolvedBranchCount += 1;
      firstResolution.immediatePickupProbability +=
        branch.probability * resolution.immediatePickupProbability;
      firstResolution.expectedImmediatePickupCount +=
        branch.probability * resolution.expectedImmediatePickupCount;
      firstResolution.immediatePowerProbability +=
        branch.probability * resolution.immediatePowerProbability;
    }
  }
  if (resolvedBranchCount !== 0 && resolvedBranchCount !== branches.length) {
    throw new Error("Oracle branches disagree on current-trick resolution.");
  }
  return {
    bhabhiProbabilities,
    firstOpponentEscapeProbabilities,
    userHeadsUpOpponentProbabilities,
    firstResolution: resolvedBranchCount === 0 ? null : firstResolution,
  };
}

function solveState(
  state: OracleState,
  behaviorConfig: BehaviorModelConfig,
  maximumDepth: number,
  depth: number,
): OracleNodeValue {
  if (depth > maximumDepth) {
    throw new Error("Brute-force oracle exceeded its acyclic depth bound.");
  }
  const representative = state.hypotheses[0];
  if (representative === undefined) {
    throw new Error("Brute-force oracle received empty support.");
  }
  const publicKey = publicObservationKey(representative);
  if (
    state.hypotheses.some(
      (hypothesis) => publicObservationKey(hypothesis) !== publicKey,
    )
  ) {
    throw new Error("Brute-force oracle mixed distinguishable observations.");
  }
  const publicState = representative.exact.publicState;
  if (publicState.status === "complete") {
    const bhabhiProbabilities = zeroVector();
    const firstOpponentEscapeProbabilities = zeroFirstOpponentEscapeVector();
    const userHeadsUpOpponentProbabilities = zeroUserHeadsUpOpponentVector();
    for (const hypothesis of state.hypotheses) {
      const bhabhi = hypothesis.exact.publicState.bhabhi;
      if (bhabhi === null) {
        throw new Error("Oracle terminal hypothesis has no Bhabhi.");
      }
      bhabhiProbabilities[bhabhi] += hypothesis.mass;
      firstOpponentEscapeProbabilities[
        firstOpponentEscape(hypothesis.exact.publicState)
      ] += hypothesis.mass;
      userHeadsUpOpponentProbabilities[
        hypothesis.userHeadsUpOpponent ?? "none"
      ] += hypothesis.mass;
    }
    return {
      bhabhiProbabilities,
      firstOpponentEscapeProbabilities,
      userHeadsUpOpponentProbabilities,
      pendingTrickResolution: null,
    };
  }
  if (publicState.pendingAction !== null) {
    const children = state.hypotheses.flatMap((hypothesis) => {
      const events = chanceEvents(hypothesis);
      if (events.length === 0) {
        throw new Error("Oracle chance node has no eligible event.");
      }
      return events.map((event) =>
        transition(hypothesis, event, hypothesis.mass / events.length),
      );
    });
    const value = branchValue(
      grouped(children),
      behaviorConfig,
      maximumDepth,
      depth,
    );
    if (
      awaitingTrickResolution(publicState) &&
      value.firstResolution === null
    ) {
      throw new Error("Oracle chance continuation lost its trick resolution.");
    }
    return {
      bhabhiProbabilities: value.bhabhiProbabilities,
      firstOpponentEscapeProbabilities: value.firstOpponentEscapeProbabilities,
      userHeadsUpOpponentProbabilities: value.userHeadsUpOpponentProbabilities,
      pendingTrickResolution: awaitingTrickResolution(publicState)
        ? value.firstResolution
        : null,
    };
  }
  if (publicState.turn === "user") {
    const actions = userActions(representative);
    const values = actions.map((action) => {
      const children = state.hypotheses.map((hypothesis) =>
        userTransition(hypothesis, action, hypothesis.mass),
      );
      return branchValue(
        grouped(children),
        behaviorConfig,
        maximumDepth,
        depth,
      );
    });
    const minimum = Math.min(
      ...values.map((value) => value.bhabhiProbabilities.user),
    );
    const selectedIndex = values.findIndex(
      (value) => value.bhabhiProbabilities.user <= minimum + TOLERANCE,
    );
    const selected = values[selectedIndex];
    if (selected === undefined) {
      throw new Error("Oracle user node produced no selected value.");
    }
    if (selected.firstResolution === null) {
      throw new Error(
        "Oracle user action lost its immediate positional resolution.",
      );
    }
    return {
      bhabhiProbabilities: selected.bhabhiProbabilities,
      firstOpponentEscapeProbabilities:
        selected.firstOpponentEscapeProbabilities,
      userHeadsUpOpponentProbabilities:
        selected.userHeadsUpOpponentProbabilities,
      pendingTrickResolution: awaitingTrickResolution(publicState)
        ? selected.firstResolution
        : null,
    };
  }
  if (publicState.turn !== "p2" && publicState.turn !== "p3") {
    throw new Error("Oracle active state has no actor.");
  }
  const seat = publicState.turn;
  const children = state.hypotheses.flatMap((hypothesis) => {
    const observation = createActorObservation(
      {
        publicState: hypothesis.exact.publicState,
        exactHands: hypothesis.exact.hands,
      },
      seat,
      decisionOrdinal(hypothesis.exact.publicState, seat),
      hypothesis.events,
    );
    const modelId = seat === "p2" ? hypothesis.p2ModelId : hypothesis.p3ModelId;
    return behaviorModelDistribution(
      modelId,
      observation,
      behaviorConfig,
    ).probabilities.map((entry) =>
      transition(
        hypothesis,
        opponentEvent(entry.action, seat, hypothesis),
        hypothesis.mass * entry.probability,
      ),
    );
  });
  const value = branchValue(
    grouped(children),
    behaviorConfig,
    maximumDepth,
    depth,
  );
  if (awaitingTrickResolution(publicState) && value.firstResolution === null) {
    throw new Error("Oracle opponent continuation lost its trick resolution.");
  }
  return {
    bhabhiProbabilities: value.bhabhiProbabilities,
    firstOpponentEscapeProbabilities: value.firstOpponentEscapeProbabilities,
    userHeadsUpOpponentProbabilities: value.userHeadsUpOpponentProbabilities,
    pendingTrickResolution: awaitingTrickResolution(publicState)
      ? value.firstResolution
      : null,
  };
}

export function bruteForceExactEndgameOracle(
  input: BruteForceOracleInput,
): BruteForceOracleResult {
  const totalMass = input.hypotheses.reduce(
    (sum, hypothesis) => sum + hypothesis.mass,
    0,
  );
  if (Math.abs(totalMass - 1) > TOLERANCE) {
    throw new Error("Oracle root mass must sum to one.");
  }
  const state: OracleState = {
    hypotheses: input.hypotheses.map((hypothesis) => ({
      id: hypothesis.id,
      mass: hypothesis.mass,
      p2ModelId: hypothesis.p2ModelId,
      p3ModelId: hypothesis.p3ModelId,
      exact: {
        publicState: structuredClone(input.publicState),
        hands: structuredClone(hypothesis.hands),
      },
      events:
        input.activeEvents === undefined
          ? undefined
          : structuredClone(input.activeEvents),
      userHeadsUpOpponent: currentUserHeadsUpOpponent(input.publicState),
    })),
  };
  const representative = state.hypotheses[0];
  if (
    representative === undefined ||
    representative.exact.publicState.status !== "active" ||
    representative.exact.publicState.turn !== "user" ||
    representative.exact.publicState.pendingAction !== null
  ) {
    throw new Error("Oracle root must be an active non-chance user turn.");
  }
  const actionValues = userActions(representative).map((action) => {
    const children = state.hypotheses.map((hypothesis) =>
      userTransition(hypothesis, action, hypothesis.mass),
    );
    const value = branchValue(
      grouped(children),
      input.behaviorConfig,
      input.maximumDepth ?? 128,
      0,
    );
    if (value.firstResolution === null) {
      throw new Error(
        "Oracle root action lost its immediate positional resolution.",
      );
    }
    return {
      action,
      actionKey: actionKey(action),
      userBhabhiRisk: value.bhabhiProbabilities.user,
      bhabhiProbabilities: value.bhabhiProbabilities,
      positionalDiagnostics: {
        ...value.firstResolution,
        firstOpponentEscapeProbabilities:
          value.firstOpponentEscapeProbabilities,
        userHeadsUpOpponentProbabilities:
          value.userHeadsUpOpponentProbabilities,
      },
    };
  });
  actionValues.sort(
    (left, right) =>
      left.userBhabhiRisk - right.userBhabhiRisk ||
      left.actionKey.localeCompare(right.actionKey),
  );
  const best = actionValues[0];
  if (best === undefined) {
    throw new Error("Oracle root produced no action value.");
  }
  return {
    actionValues,
    recommendedActionKey: best.actionKey,
    tiedBestActionKeys: actionValues
      .filter(
        (candidate) =>
          candidate.userBhabhiRisk <= best.userBhabhiRisk + TOLERANCE,
      )
      .map((candidate) => candidate.actionKey)
      .sort(),
  };
}
