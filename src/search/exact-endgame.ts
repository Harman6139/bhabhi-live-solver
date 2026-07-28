import { createActorObservation } from "../agents/observation";
import { getBaselinePolicy, type PolicyObservation } from "../agents/policies";
import { sortCards } from "../domain/cards";
import { SEATS, type OpponentSeat, type Seat } from "../domain/seats";
import type {
  CardPlayedEvent,
  GameEvent,
  HandTakenEvent,
  PlayerCardDrawnEvent,
  WasteCardDrawnEvent,
} from "../events/game-events";
import { stableHash, stableStringify } from "../events/stable-hash";
import { semanticHistoryHash } from "../events/timeline";
import { behaviorBeliefConfigurationHash } from "../inference/behavior-belief";
import {
  DEFAULT_BEHAVIOR_MODEL_CONFIG,
  validateBehaviorModelConfig,
  type BehaviorAction,
  type BehaviorModelConfig,
} from "../inference/behavior-models";
import type { PublicInformationState } from "../public/public-state";
import { createSeededRng } from "../random/keyed-rng";
import {
  applyExactHandEvent,
  assertExactHandStateInvariant,
  legalExactHandCards,
  type ExactHandEvent,
  type ExactHandState,
} from "../rules/exact-hand-transition";
import { legalTakeTargets } from "../rules/legal-actions";
import { assertPublicStateInvariant } from "../rules/state-invariant";
import {
  actionEvent,
  actionKey,
  compareUserActions,
  legalUserActions,
} from "./actions";
import {
  advancedSearchConfigurationHash,
  validateAdvancedSearchConfig,
} from "./advanced-config";
import {
  AdvancedSearchContractError,
  EXACT_ENDGAME_ALGORITHM_VERSION,
  type AdvancedSearchConfig,
  type AdvancedSearchConfigInput,
  type ExactEndgameActionValue,
  type ExactEndgameDiagnostics,
  type ExactEndgamePositionalDiagnostics,
  type ExactEndgameResult,
  type ExactFirstOpponentEscapeProbabilities,
  type ExactIneligibilityCode,
  type ExactInformationHypothesis,
  type ExactInformationHypothesisSet,
  type ExactOpponentPolicyMode,
  type ExactTerminalProbabilities,
  type ExactUserHeadsUpOpponentProbabilities,
} from "./advanced-types";
import { createExactInformationHypothesisSet } from "./exact-hypotheses";
import {
  createUserObservablePolicyMemory,
  createUserObservableStateKey,
} from "./observable-key";
import { evaluateActorSafePolicy } from "./policy-kernel";
import type { UserAction } from "./types";

const NUMERIC_TOLERANCE = 1e-12;
const NORMALIZATION_TOLERANCE = 1e-10;

export type ExactEndgameSearchInput = {
  readonly publicState: PublicInformationState;
  readonly historyHash: string;
  readonly hypothesisSet: ExactInformationHypothesisSet;
  readonly activeEvents?: readonly GameEvent[];
  readonly config?: AdvancedSearchConfigInput | AdvancedSearchConfig;
  readonly behaviorConfig?: BehaviorModelConfig;
  readonly opponentPolicyMode?: ExactOpponentPolicyMode;
  readonly shouldCancel?: () => boolean;
};

type ConcreteState = {
  readonly hypothesisId: string;
  readonly occurrenceIndex: number;
  readonly witnessId: string;
  readonly p2ModelId: ExactInformationHypothesis["p2ModelId"];
  readonly p3ModelId: ExactInformationHypothesis["p3ModelId"];
  readonly mass: number;
  readonly exact: ExactHandState;
  readonly events: readonly GameEvent[] | undefined;
  readonly userHeadsUpOpponent: OpponentSeat | null;
};

type InformationState = {
  readonly hypotheses: readonly ConcreteState[];
};

type NodeValue = {
  readonly bhabhiProbabilities: ExactTerminalProbabilities;
  readonly firstOpponentEscapeProbabilities: ExactFirstOpponentEscapeProbabilities;
  readonly userHeadsUpOpponentProbabilities: ExactUserHeadsUpOpponentProbabilities;
  readonly pendingTrickResolution: ImmediateResolutionDiagnostics | null;
  readonly actionValues: readonly ExactEndgameActionValue[] | null;
};

type ImmediateResolutionDiagnostics = Pick<
  ExactEndgamePositionalDiagnostics,
  | "immediatePickupProbability"
  | "expectedImmediatePickupCount"
  | "immediatePowerProbability"
>;

type TransitionedConcrete = {
  readonly hypothesis: ConcreteState;
  readonly resolvedTrick: ImmediateResolutionDiagnostics | null;
};

type WeightedBranch = {
  readonly probability: number;
  readonly state: InformationState;
  readonly resolvedTrick: ImmediateResolutionDiagnostics | null;
};

type AggregatedBranchValue = {
  readonly bhabhiProbabilities: ExactTerminalProbabilities;
  readonly firstOpponentEscapeProbabilities: ExactFirstOpponentEscapeProbabilities;
  readonly userHeadsUpOpponentProbabilities: ExactUserHeadsUpOpponentProbabilities;
  readonly firstResolution: ImmediateResolutionDiagnostics | null;
};

type MutableDiagnostics = {
  activeCardCount: number;
  initialHypotheses: number;
  informationStates: number;
  branches: number;
  terminalStates: number;
  memoHits: number;
  userNodes: number;
  opponentNodes: number;
  chanceNodes: number;
  maximumDepth: number;
  cycleChecks: number;
  cycleProbeStates: number;
  cycleProbeBranches: number;
};

class ExactSearchAbort extends Error {
  readonly code: ExactIneligibilityCode;

  constructor(code: ExactIneligibilityCode, message: string) {
    super(message);
    this.name = "ExactSearchAbort";
    this.code = code;
  }
}

type SearchContext = {
  readonly config: AdvancedSearchConfig;
  readonly behaviorConfig: BehaviorModelConfig;
  readonly opponentPolicyMode: ExactOpponentPolicyMode;
  readonly startedAt: number;
  readonly shouldCancel: (() => boolean) | undefined;
  readonly diagnostics: MutableDiagnostics;
  readonly memo: Map<string, NodeValue>;
  readonly visitingBeliefs: Set<string>;
  readonly visitingPhysicalStates: Set<string>;
};

const DETERMINISTIC_POLICY_RNG = createSeededRng(
  "deterministic-policy-unused-rng-v1",
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

function invalidRequest(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): never {
  throw new AdvancedSearchContractError(
    "INVALID_BELIEF",
    message,
    details,
    cause === undefined ? undefined : { cause },
  );
}

function staleRequest(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new AdvancedSearchContractError("STALE_BELIEF", message, details);
}

function compensatedSum(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const corrected = value - compensation;
    const next = sum + corrected;
    compensation = next - sum - corrected;
    sum = next;
  }
  return sum;
}

function exactDiagnostics(
  diagnostics: MutableDiagnostics,
): ExactEndgameDiagnostics {
  return {
    activeCardCount: diagnostics.activeCardCount,
    initialHypotheses: diagnostics.initialHypotheses,
    informationStates: diagnostics.informationStates,
    branches: diagnostics.branches,
    terminalStates: diagnostics.terminalStates,
    memoHits: diagnostics.memoHits,
    userNodes: diagnostics.userNodes,
    opponentNodes: diagnostics.opponentNodes,
    chanceNodes: diagnostics.chanceNodes,
    maximumDepth: diagnostics.maximumDepth,
    cycleChecks: diagnostics.cycleChecks,
    cycleProbeStates: diagnostics.cycleProbeStates,
    cycleProbeBranches: diagnostics.cycleProbeBranches,
  };
}

function decisionOrdinals(
  state: PublicInformationState,
): Readonly<Record<Seat, number>> {
  const counts: Record<Seat, number> = { user: 0, p2: 0, p3: 0 };
  for (const effect of state.effects) {
    if (effect.type === "card-played") {
      counts[effect.seat] += 1;
    } else if (effect.type === "hand-taken") {
      counts[effect.actor] += 1;
    }
  }
  return counts;
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

function actorObservation(
  concrete: ConcreteState,
  seat: Seat,
): PolicyObservation {
  return createActorObservation(
    {
      publicState: concrete.exact.publicState,
      exactHands: concrete.exact.hands,
    },
    seat,
    decisionOrdinals(concrete.exact.publicState)[seat],
    concrete.events,
  );
}

function userObservableKey(concrete: ConcreteState): string {
  const observation = actorObservation(concrete, "user");
  const policyMemory = createUserObservablePolicyMemory({
    observation,
    decisionOrdinals: decisionOrdinals(concrete.exact.publicState),
  });
  return stableHash({
    userObservableStateKey: createUserObservableStateKey({
      publicState: concrete.exact.publicState,
      policyMemory,
    }).key,
    userHeadsUpOpponent: concrete.userHeadsUpOpponent,
  });
}

function assertOneInformationState(state: InformationState): string {
  const first = state.hypotheses[0];
  if (first === undefined) {
    invalidRequest("An exact information state has no hypotheses.");
  }
  const key = userObservableKey(first);
  for (const hypothesis of state.hypotheses.slice(1)) {
    const candidate = userObservableKey(hypothesis);
    if (candidate !== key) {
      invalidRequest(
        "One exact information state contains distinguishable user observations.",
        {
          expectedObservableKey: key,
          actualObservableKey: candidate,
          hypothesisId: hypothesis.hypothesisId,
        },
      );
    }
  }
  const totalMass = compensatedSum(
    state.hypotheses.map((hypothesis) => hypothesis.mass),
  );
  if (Math.abs(totalMass - 1) > NORMALIZATION_TOLERANCE) {
    invalidRequest("Conditional information-state mass must sum to one.", {
      totalMass,
    });
  }
  return key;
}

function sortedPublicStateProjection(state: PublicInformationState): unknown {
  return {
    schemaVersion: state.schemaVersion,
    rules: state.rules,
    startingCounts: state.startingCounts,
    phase: state.phase,
    status: state.status,
    handCounts: state.handCounts,
    userHand: sortCards(state.userHand),
    knownOpponentCards: {
      p2: sortCards(state.knownOpponentCards.p2),
      p3: sortCards(state.knownOpponentCards.p3),
    },
    unresolvedCards: sortCards(state.unresolvedCards),
    trick:
      state.trick === null
        ? null
        : {
            kind: state.trick.kind,
            leader: state.trick.leader,
            leadSuit: state.trick.leadSuit,
            participants: [...state.trick.participants],
            startedHeadsUp: state.trick.startedHeadsUp,
            forcedLeadCard: state.trick.forcedLeadCard,
            shootoutForcedLead: state.trick.shootoutForcedLead,
            plays: state.trick.plays.map((play) => ({
              seat: play.seat,
              card: play.card,
              offSuit: play.offSuit,
            })),
          },
    waste: sortCards(state.waste),
    pendingAction:
      state.pendingAction === null
        ? null
        : {
            ...state.pendingAction,
            excludedTrick: sortCards(state.pendingAction.excludedTrick),
          },
    power: state.power,
    turn: state.turn,
    activeSeats: [...state.activeSeats],
    escapeGroups: state.escapeGroups.map((group) => ({
      seats: [...group.seats],
      reason: group.reason,
    })),
    bhabhi: state.bhabhi,
  };
}

function modelRelevantMemory(
  concrete: ConcreteState,
  seat: OpponentSeat,
): unknown {
  const observation = actorObservation(concrete, seat);
  const modelId = seat === "p2" ? concrete.p2ModelId : concrete.p3ModelId;
  if (modelId === "early-high-shedder") {
    const priorPlays = observation.publicPlays.filter(
      (play) => play.seat === seat,
    ).length;
    const earlyThreshold = Math.ceil(observation.startingCounts[seat] / 2);
    return {
      earlyHighShedderPhase: priorPlays < earlyThreshold ? "early" : "late",
    };
  }
  if (modelId === "documented-basic") {
    return {
      currentSuitStatus: observation.currentSuitStatus,
      lastPickup: observation.lastPickup,
    };
  }
  return null;
}

function latentStructuralDescription(concrete: ConcreteState): unknown {
  return {
    p2ModelId: concrete.p2ModelId,
    p3ModelId: concrete.p3ModelId,
    userHeadsUpOpponent: concrete.userHeadsUpOpponent,
    hands: Object.fromEntries(
      SEATS.map((seat) => [seat, sortCards(concrete.exact.hands[seat])]),
    ),
    p2Memory: modelRelevantMemory(concrete, "p2"),
    p3Memory: modelRelevantMemory(concrete, "p3"),
  };
}

function canonicalLatentMasses(
  state: InformationState,
): readonly { readonly latentKey: string; readonly mass: number }[] {
  const byLatent = new Map<string, number>();
  for (const hypothesis of state.hypotheses) {
    const latentKey = stableHash(latentStructuralDescription(hypothesis));
    byLatent.set(latentKey, (byLatent.get(latentKey) ?? 0) + hypothesis.mass);
  }
  return [...byLatent.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([latentKey, mass]) => ({ latentKey, mass }));
}

function stateKeys(
  state: InformationState,
  observableKey: string,
): { readonly belief: string; readonly physical: string } {
  const representative = state.hypotheses[0];
  if (representative === undefined) {
    invalidRequest("Cannot key an empty information state.");
  }
  const publicProjection = sortedPublicStateProjection(
    representative.exact.publicState,
  );
  const latentMasses = canonicalLatentMasses(state);
  return {
    belief: stableHash({
      schemaVersion: 1,
      algorithmVersion: EXACT_ENDGAME_ALGORITHM_VERSION,
      observableKey,
      publicProjection,
      latentMasses,
    }),
    physical: stableHash({
      schemaVersion: 1,
      algorithmVersion: EXACT_ENDGAME_ALGORITHM_VERSION,
      publicProjection,
      latentKeys: latentMasses.map((entry) => entry.latentKey),
    }),
  };
}

function checkInterrupts(context: SearchContext): void {
  if (context.shouldCancel?.() === true) {
    throw new ExactSearchAbort(
      "CANCELLED",
      "Exact information-state search was cancelled.",
    );
  }
  if (performance.now() - context.startedAt > context.config.deadlineMs) {
    throw new ExactSearchAbort(
      "DEADLINE",
      "Exact information-state search exhausted its frozen deadline.",
    );
  }
}

function incrementBranch(context: SearchContext): void {
  checkInterrupts(context);
  context.diagnostics.branches += 1;
  if (context.diagnostics.branches > context.config.exact.maxBranches) {
    throw new ExactSearchAbort(
      "BRANCH_LIMIT",
      "Exact information-state search exceeded its branch limit.",
    );
  }
}

function cloneTerminalVector(
  vector: ExactTerminalProbabilities,
): Record<Seat, number> {
  return {
    user: vector.user,
    p2: vector.p2,
    p3: vector.p3,
  };
}

function zeroTerminalVector(): Record<Seat, number> {
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

function zeroImmediateResolution(): ImmediateResolutionDiagnostics {
  return {
    immediatePickupProbability: 0,
    expectedImmediatePickupCount: 0,
    immediatePowerProbability: 0,
  };
}

function addScaledTerminalVector(
  destination: Record<Seat, number>,
  vector: ExactTerminalProbabilities,
  weight: number,
): void {
  for (const seat of SEATS) {
    destination[seat] += weight * vector[seat];
  }
}

function addScaledFirstOpponentEscapeVector(
  destination: Record<"p2" | "p3" | "tie" | "none", number>,
  vector: ExactFirstOpponentEscapeProbabilities,
  weight: number,
): void {
  for (const key of ["p2", "p3", "tie", "none"] as const) {
    destination[key] += weight * vector[key];
  }
}

function addScaledUserHeadsUpOpponentVector(
  destination: Record<"p2" | "p3" | "none", number>,
  vector: ExactUserHeadsUpOpponentProbabilities,
  weight: number,
): void {
  for (const key of ["p2", "p3", "none"] as const) {
    destination[key] += weight * vector[key];
  }
}

function addScaledImmediateResolution(
  destination: {
    immediatePickupProbability: number;
    expectedImmediatePickupCount: number;
    immediatePowerProbability: number;
  },
  value: ImmediateResolutionDiagnostics,
  weight: number,
): void {
  destination.immediatePickupProbability +=
    weight * value.immediatePickupProbability;
  destination.expectedImmediatePickupCount +=
    weight * value.expectedImmediatePickupCount;
  destination.immediatePowerProbability +=
    weight * value.immediatePowerProbability;
}

function normalizedTerminalVector(
  vector: Readonly<Record<Seat, number>>,
): ExactTerminalProbabilities {
  const total = compensatedSum(SEATS.map((seat) => vector[seat]));
  if (
    !Number.isFinite(total) ||
    Math.abs(total - 1) > NORMALIZATION_TOLERANCE ||
    SEATS.some(
      (seat) =>
        !Number.isFinite(vector[seat]) ||
        vector[seat] < -NUMERIC_TOLERANCE ||
        vector[seat] > 1 + NUMERIC_TOLERANCE,
    )
  ) {
    invalidRequest("Exact terminal probability mass is invalid.", {
      vector,
      total,
    });
  }
  return deepFreeze(
    Object.fromEntries(
      SEATS.map((seat) => [
        seat,
        Math.min(1, Math.max(0, vector[seat] / total)),
      ]),
    ) as Record<Seat, number>,
  );
}

function normalizedFirstOpponentEscapeVector(
  vector: Readonly<Record<"p2" | "p3" | "tie" | "none", number>>,
): ExactFirstOpponentEscapeProbabilities {
  const keys = ["p2", "p3", "tie", "none"] as const;
  const total = compensatedSum(keys.map((key) => vector[key]));
  if (
    !Number.isFinite(total) ||
    Math.abs(total - 1) > NORMALIZATION_TOLERANCE ||
    keys.some(
      (key) =>
        !Number.isFinite(vector[key]) ||
        vector[key] < -NUMERIC_TOLERANCE ||
        vector[key] > 1 + NUMERIC_TOLERANCE,
    )
  ) {
    invalidRequest("Exact first-opponent-escape probability mass is invalid.", {
      vector,
      total,
    });
  }
  return deepFreeze(
    Object.fromEntries(
      keys.map((key) => [key, Math.min(1, Math.max(0, vector[key] / total))]),
    ) as Record<(typeof keys)[number], number>,
  );
}

function normalizedUserHeadsUpOpponentVector(
  vector: Readonly<Record<"p2" | "p3" | "none", number>>,
): ExactUserHeadsUpOpponentProbabilities {
  const keys = ["p2", "p3", "none"] as const;
  const total = compensatedSum(keys.map((key) => vector[key]));
  if (
    !Number.isFinite(total) ||
    Math.abs(total - 1) > NORMALIZATION_TOLERANCE ||
    keys.some(
      (key) =>
        !Number.isFinite(vector[key]) ||
        vector[key] < -NUMERIC_TOLERANCE ||
        vector[key] > 1 + NUMERIC_TOLERANCE,
    )
  ) {
    invalidRequest("Exact heads-up-opponent probability mass is invalid.", {
      vector,
      total,
    });
  }
  return deepFreeze(
    Object.fromEntries(
      keys.map((key) => [key, Math.min(1, Math.max(0, vector[key] / total))]),
    ) as Record<(typeof keys)[number], number>,
  );
}

function validatedImmediateResolution(
  value: ImmediateResolutionDiagnostics,
): ImmediateResolutionDiagnostics {
  if (
    !Number.isFinite(value.immediatePickupProbability) ||
    value.immediatePickupProbability < -NUMERIC_TOLERANCE ||
    value.immediatePickupProbability > 1 + NUMERIC_TOLERANCE ||
    !Number.isFinite(value.expectedImmediatePickupCount) ||
    value.expectedImmediatePickupCount < -NUMERIC_TOLERANCE ||
    !Number.isFinite(value.immediatePowerProbability) ||
    value.immediatePowerProbability < -NUMERIC_TOLERANCE ||
    value.immediatePowerProbability > 1 + NUMERIC_TOLERANCE
  ) {
    invalidRequest("Exact immediate positional diagnostics are invalid.", {
      value,
    });
  }
  return deepFreeze({
    immediatePickupProbability: Math.min(
      1,
      Math.max(0, value.immediatePickupProbability),
    ),
    expectedImmediatePickupCount: Math.max(
      0,
      value.expectedImmediatePickupCount,
    ),
    immediatePowerProbability: Math.min(
      1,
      Math.max(0, value.immediatePowerProbability),
    ),
  });
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

function terminalValue(state: InformationState): NodeValue {
  const vector = zeroTerminalVector();
  const firstEscapeVector = zeroFirstOpponentEscapeVector();
  const headsUpVector = zeroUserHeadsUpOpponentVector();
  let expectedBhabhi: Seat | null = null;
  for (const hypothesis of state.hypotheses) {
    const publicState = hypothesis.exact.publicState;
    if (publicState.status !== "complete" || publicState.bhabhi === null) {
      invalidRequest("A terminal exact node contains an active hypothesis.", {
        hypothesisId: hypothesis.hypothesisId,
      });
    }
    expectedBhabhi ??= publicState.bhabhi;
    if (publicState.bhabhi !== expectedBhabhi) {
      invalidRequest(
        "Indistinguishable terminal hypotheses disagree on public Bhabhi identity.",
        {
          expectedBhabhi,
          actualBhabhi: publicState.bhabhi,
          hypothesisId: hypothesis.hypothesisId,
        },
      );
    }
    vector[publicState.bhabhi] += hypothesis.mass;
    firstEscapeVector[firstOpponentEscape(publicState)] += hypothesis.mass;
    headsUpVector[hypothesis.userHeadsUpOpponent ?? "none"] += hypothesis.mass;
  }
  return {
    bhabhiProbabilities: normalizedTerminalVector(vector),
    firstOpponentEscapeProbabilities:
      normalizedFirstOpponentEscapeVector(firstEscapeVector),
    userHeadsUpOpponentProbabilities:
      normalizedUserHeadsUpOpponentVector(headsUpVector),
    pendingTrickResolution: null,
    actionValues: null,
  };
}

function nextEvents(
  concrete: ConcreteState,
  event: ExactHandEvent,
): readonly GameEvent[] | undefined {
  return concrete.events === undefined
    ? undefined
    : [...concrete.events, structuredClone(event)];
}

function transitionConcrete(
  concrete: ConcreteState,
  event: ExactHandEvent,
  mass: number,
  context: SearchContext,
): TransitionedConcrete {
  incrementBranch(context);
  const priorEffectCount = concrete.exact.publicState.effects.length;
  const nextExact = applyExactHandEvent(
    concrete.exact,
    event,
    concrete.exact.publicState.appliedEventCount,
    "full",
  );
  return {
    hypothesis: {
      hypothesisId: concrete.hypothesisId,
      occurrenceIndex: concrete.occurrenceIndex,
      witnessId: concrete.witnessId,
      p2ModelId: concrete.p2ModelId,
      p3ModelId: concrete.p3ModelId,
      mass,
      exact: nextExact,
      events: nextEvents(concrete, event),
      userHeadsUpOpponent:
        concrete.userHeadsUpOpponent ??
        currentUserHeadsUpOpponent(nextExact.publicState),
    },
    resolvedTrick: immediateResolutionFromTransition(
      nextExact.publicState,
      priorEffectCount,
    ),
  };
}

function immediateResolutionFromTransition(
  state: PublicInformationState,
  priorEffectCount: number,
): ImmediateResolutionDiagnostics | null {
  const effects = state.effects.slice(priorEffectCount);
  const pickup = effects.find((effect) => effect.type === "trick-picked-up");
  if (pickup?.type === "trick-picked-up") {
    return validatedImmediateResolution({
      immediatePickupProbability: pickup.picker === "user" ? 1 : 0,
      expectedImmediatePickupCount:
        pickup.picker === "user" ? pickup.cards.length : 0,
      immediatePowerProbability: state.power === "user" ? 1 : 0,
    });
  }
  if (
    effects.some((effect) => effect.type === "trick-wasted") ||
    state.status === "complete"
  ) {
    return validatedImmediateResolution({
      immediatePickupProbability: 0,
      expectedImmediatePickupCount: 0,
      immediatePowerProbability: state.power === "user" ? 1 : 0,
    });
  }
  return null;
}

function normalizeBranch(
  children: readonly TransitionedConcrete[],
): WeightedBranch {
  const probability = compensatedSum(
    children.map((child) => child.hypothesis.mass),
  );
  if (!Number.isFinite(probability) || probability <= 0) {
    invalidRequest("An exact observation branch has invalid mass.", {
      probability,
    });
  }
  const resolutions = children.map((child) => child.resolvedTrick);
  const resolvedCount = resolutions.filter(
    (resolution) => resolution !== null,
  ).length;
  if (resolvedCount !== 0 && resolvedCount !== children.length) {
    invalidRequest(
      "Indistinguishable exact transitions disagree on root-trick resolution.",
    );
  }
  const resolvedTrick =
    resolvedCount === 0
      ? null
      : (() => {
          const aggregate = zeroImmediateResolution();
          for (const child of children) {
            if (child.resolvedTrick === null) {
              invalidRequest(
                "A resolved exact observation branch lost its positional outcome.",
              );
            }
            addScaledImmediateResolution(
              aggregate,
              child.resolvedTrick,
              child.hypothesis.mass / probability,
            );
          }
          return validatedImmediateResolution(aggregate);
        })();
  return {
    probability,
    state: {
      hypotheses: children.map((child) => ({
        ...child.hypothesis,
        mass: child.hypothesis.mass / probability,
      })),
    },
    resolvedTrick,
  };
}

function groupBranches(
  children: readonly TransitionedConcrete[],
): readonly WeightedBranch[] {
  const byObservation = new Map<string, TransitionedConcrete[]>();
  for (const child of children) {
    const key = userObservableKey(child.hypothesis);
    const bucket = byObservation.get(key) ?? [];
    bucket.push(child);
    byObservation.set(key, bucket);
  }
  const branches = [...byObservation.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, hypotheses]) => normalizeBranch(hypotheses));
  const total = compensatedSum(branches.map((branch) => branch.probability));
  if (Math.abs(total - 1) > NORMALIZATION_TOLERANCE) {
    invalidRequest("Exact observation branches do not conserve mass.", {
      total,
    });
  }
  return branches;
}

function aggregateBranches(
  branches: readonly WeightedBranch[],
  context: SearchContext,
  depth: number,
): AggregatedBranchValue {
  const vector = zeroTerminalVector();
  const firstEscapeVector = zeroFirstOpponentEscapeVector();
  const headsUpVector = zeroUserHeadsUpOpponentVector();
  const firstResolution = zeroImmediateResolution();
  let resolvedBranchCount = 0;
  for (const branch of branches) {
    const child = solveNode(branch.state, context, depth + 1);
    addScaledTerminalVector(
      vector,
      child.bhabhiProbabilities,
      branch.probability,
    );
    addScaledFirstOpponentEscapeVector(
      firstEscapeVector,
      child.firstOpponentEscapeProbabilities,
      branch.probability,
    );
    addScaledUserHeadsUpOpponentVector(
      headsUpVector,
      child.userHeadsUpOpponentProbabilities,
      branch.probability,
    );
    const resolution = branch.resolvedTrick ?? child.pendingTrickResolution;
    if (resolution !== null) {
      resolvedBranchCount += 1;
      addScaledImmediateResolution(
        firstResolution,
        resolution,
        branch.probability,
      );
    }
  }
  if (resolvedBranchCount !== 0 && resolvedBranchCount !== branches.length) {
    invalidRequest(
      "Exact branches disagree on whether the current trick resolved.",
      {
        resolvedBranchCount,
        branchCount: branches.length,
      },
    );
  }
  return {
    bhabhiProbabilities: normalizedTerminalVector(vector),
    firstOpponentEscapeProbabilities:
      normalizedFirstOpponentEscapeVector(firstEscapeVector),
    userHeadsUpOpponentProbabilities:
      normalizedUserHeadsUpOpponentVector(headsUpVector),
    firstResolution:
      resolvedBranchCount === 0
        ? null
        : validatedImmediateResolution(firstResolution),
  };
}

function userActionBranches(
  state: InformationState,
  action: UserAction,
  context: SearchContext,
): readonly WeightedBranch[] {
  const children = state.hypotheses.map((hypothesis) => {
    const event = actionEvent(action, hypothesis.exact.hands);
    const child = transitionConcrete(
      hypothesis,
      event,
      hypothesis.mass,
      context,
    );
    if (action.kind !== "take-hand") {
      return child;
    }
    return {
      ...child,
      resolvedTrick: validatedImmediateResolution({
        immediatePickupProbability: 0,
        expectedImmediatePickupCount: 0,
        immediatePowerProbability:
          child.hypothesis.exact.publicState.power === "user" ? 1 : 0,
      }),
    };
  });
  return groupBranches(children);
}

function behaviorEvent(
  action: BehaviorAction,
  seat: OpponentSeat,
  exact: ExactHandState,
): CardPlayedEvent | HandTakenEvent {
  if (action.kind === "play-card") {
    return {
      type: "card-played",
      schemaVersion: 1,
      seat,
      card: action.card,
    };
  }
  return {
    type: "hand-taken",
    schemaVersion: 1,
    actor: seat,
    target: action.target,
    revealedCards:
      action.target === "user" ? [...exact.hands[action.target]] : [],
  };
}

function assertActorKernelInput(
  concrete: ConcreteState,
  observation: PolicyObservation,
  seat: OpponentSeat,
): void {
  const exactCards = sortCards(concrete.exact.hands[seat]);
  const exactLegalCards = sortCards(legalExactHandCards(concrete.exact, seat));
  const exactTakeTargets = legalTakeTargets(
    concrete.exact.publicState,
    seat,
  ).sort();
  if (
    observation.seat !== seat ||
    stableStringify(sortCards(observation.ownHand)) !==
      stableStringify(exactCards) ||
    stableStringify(sortCards(observation.legalCards)) !==
      stableStringify(exactLegalCards) ||
    stableStringify([...(observation.legalTakeTargets ?? [])].sort()) !==
      stableStringify(exactTakeTargets)
  ) {
    invalidRequest(
      "Actor-safe policy observation does not match its concrete hypothesis.",
      {
        hypothesisId: concrete.hypothesisId,
        seat,
      },
    );
  }
}

function opponentBranches(
  state: InformationState,
  seat: OpponentSeat,
  context: SearchContext,
): readonly WeightedBranch[] {
  const children: TransitionedConcrete[] = [];
  for (const hypothesis of state.hypotheses) {
    const observation = actorObservation(hypothesis, seat);
    assertActorKernelInput(hypothesis, observation, seat);
    const modelId = seat === "p2" ? hypothesis.p2ModelId : hypothesis.p3ModelId;
    for (const entry of opponentActionProbabilities(
      observation,
      modelId,
      context,
    )) {
      children.push(
        transitionConcrete(
          hypothesis,
          behaviorEvent(entry.action, seat, hypothesis.exact),
          hypothesis.mass * entry.probability,
          context,
        ),
      );
    }
  }
  return groupBranches(children);
}

function opponentActionProbabilities(
  observation: PolicyObservation,
  modelId: ExactInformationHypothesis["p2ModelId"],
  context: SearchContext,
): readonly {
  readonly action: BehaviorAction;
  readonly probability: number;
}[] {
  if (context.opponentPolicyMode === "behavior-distribution") {
    return evaluateActorSafePolicy({
      observation,
      modelId,
      config: context.behaviorConfig,
    }).probabilities;
  }
  if (modelId === "random") {
    throw new ExactSearchAbort(
      "UNSUPPORTED_POLICY_MEMORY",
      "Deterministic-baseline exact search cannot use the stochastic random policy.",
    );
  }
  const policy = getBaselinePolicy(modelId);
  const target =
    policy.chooseTakeTarget?.(observation, DETERMINISTIC_POLICY_RNG) ?? null;
  if (target !== null) {
    if (!(observation.legalTakeTargets ?? []).includes(target)) {
      invalidRequest(
        "A deterministic baseline policy selected an illegal take target.",
        {
          seat: observation.seat,
          modelId,
          target,
        },
      );
    }
    return [{ action: { kind: "take-hand", target }, probability: 1 }];
  }
  const choice = policy.chooseCard(observation, DETERMINISTIC_POLICY_RNG);
  if (!observation.legalCards.includes(choice.card)) {
    invalidRequest(
      "A deterministic baseline policy selected an illegal card.",
      {
        seat: observation.seat,
        modelId,
        card: choice.card,
      },
    );
  }
  return [
    {
      action: { kind: "play-card", card: choice.card },
      probability: 1,
    },
  ];
}

function chanceEvents(
  concrete: ConcreteState,
): readonly WasteCardDrawnEvent[] | readonly PlayerCardDrawnEvent[] {
  const pending = concrete.exact.publicState.pendingAction;
  if (pending === null) {
    invalidRequest("Chance expansion requires a pending rule action.");
  }
  if (pending.kind === "waste-draw") {
    const eligible = sortCards(concrete.exact.publicState.waste);
    if (eligible.length === 0) {
      invalidRequest("A waste-draw node has no eligible card.", {
        hypothesisId: concrete.hypothesisId,
      });
    }
    return eligible.map((card) => ({
      type: "waste-card-drawn" as const,
      schemaVersion: 1 as const,
      seat: pending.player,
      card,
    }));
  }
  const eligible = sortCards(concrete.exact.hands[pending.source]);
  if (eligible.length === 0) {
    invalidRequest("A player-draw node has no eligible source card.", {
      hypothesisId: concrete.hypothesisId,
      source: pending.source,
    });
  }
  return eligible.map((card) => ({
    type: "player-card-drawn" as const,
    schemaVersion: 1 as const,
    seat: pending.player,
    source: pending.source,
    card,
  }));
}

function chanceBranches(
  state: InformationState,
  context: SearchContext,
): readonly WeightedBranch[] {
  const children: TransitionedConcrete[] = [];
  for (const hypothesis of state.hypotheses) {
    const events = chanceEvents(hypothesis);
    const probability = 1 / events.length;
    for (const event of events) {
      children.push(
        transitionConcrete(
          hypothesis,
          event,
          hypothesis.mass * probability,
          context,
        ),
      );
    }
  }
  return groupBranches(children);
}

function physicalConcreteKey(concrete: ConcreteState): string {
  return stableHash({
    schemaVersion: 1,
    algorithmVersion: EXACT_ENDGAME_ALGORITHM_VERSION,
    publicProjection: sortedPublicStateProjection(concrete.exact.publicState),
    latent: latentStructuralDescription(concrete),
  });
}

function cycleProbeEvents(
  concrete: ConcreteState,
  context: SearchContext,
): readonly ExactHandEvent[] {
  const state = concrete.exact.publicState;
  if (state.status === "complete") {
    return [];
  }
  if (state.pendingAction !== null) {
    return chanceEvents(concrete);
  }
  if (state.turn === "user") {
    return legalUserActions(state).map((action) =>
      actionEvent(action, concrete.exact.hands),
    );
  }
  if (state.turn === "p2" || state.turn === "p3") {
    const observation = actorObservation(concrete, state.turn);
    assertActorKernelInput(concrete, observation, state.turn);
    const modelId =
      state.turn === "p2" ? concrete.p2ModelId : concrete.p3ModelId;
    return opponentActionProbabilities(observation, modelId, context).map(
      (entry) =>
        behaviorEvent(entry.action, state.turn as OpponentSeat, concrete.exact),
    );
  }
  invalidRequest("Cycle probe reached an active state without an actor.", {
    turn: state.turn,
  });
}

function cycleProbeTransition(
  concrete: ConcreteState,
  event: ExactHandEvent,
): ConcreteState {
  const exact = applyExactHandEvent(
    concrete.exact,
    event,
    concrete.exact.publicState.appliedEventCount,
    "full",
  );
  return {
    ...concrete,
    exact,
    events: nextEvents(concrete, event),
    userHeadsUpOpponent:
      concrete.userHeadsUpOpponent ??
      currentUserHeadsUpOpponent(exact.publicState),
  };
}

type CycleProbeResult = "cycle" | "clear" | "budget";

function depthLimitedCycleProbe(input: {
  readonly concrete: ConcreteState;
  readonly context: SearchContext;
  readonly remainingDepth: number;
  readonly path: Set<string>;
  readonly exploredDepth: Map<string, number>;
  readonly stateBudget: number;
}): CycleProbeResult {
  checkInterrupts(input.context);
  const key = physicalConcreteKey(input.concrete);
  if (input.path.has(key)) {
    return "cycle";
  }
  if (input.remainingDepth === 0) {
    return "clear";
  }
  const priorDepth = input.exploredDepth.get(key) ?? -1;
  if (priorDepth >= input.remainingDepth) {
    return "clear";
  }
  input.exploredDepth.set(key, input.remainingDepth);
  input.context.diagnostics.cycleProbeStates += 1;
  if (input.context.diagnostics.cycleProbeStates > input.stateBudget) {
    return "budget";
  }
  input.path.add(key);
  try {
    for (const event of cycleProbeEvents(input.concrete, input.context)) {
      input.context.diagnostics.cycleProbeBranches += 1;
      if (
        input.context.diagnostics.cycleProbeBranches >
        input.context.config.exact.maxBranches
      ) {
        return "budget";
      }
      const outcome = depthLimitedCycleProbe({
        ...input,
        concrete: cycleProbeTransition(input.concrete, event),
        remainingDepth: input.remainingDepth - 1,
      });
      if (outcome !== "clear") {
        return outcome;
      }
    }
    return "clear";
  } finally {
    input.path.delete(key);
  }
}

/**
 * A bounded iterative-deepening probe finds short semantic pickup/redeal
 * cycles before a large stochastic branch can consume the exact DP budget.
 * A negative probe is not treated as proof of acyclicity; solveNode retains
 * the authoritative ancestor-cycle check.
 */
function hasReachableShortCycle(
  state: InformationState,
  context: SearchContext,
): boolean {
  if (context.diagnostics.activeCardCount < 8) {
    return false;
  }
  const maximumProbeDepth = Math.min(
    32,
    Math.max(12, context.diagnostics.activeCardCount * 2),
  );
  const stateBudget = Math.min(
    20_000,
    context.config.exact.maxInformationStates,
  );
  for (const concrete of state.hypotheses) {
    for (let depth = 1; depth <= maximumProbeDepth; depth += 1) {
      const outcome = depthLimitedCycleProbe({
        concrete,
        context,
        remainingDepth: depth,
        path: new Set(),
        exploredDepth: new Map(),
        stateBudget,
      });
      if (outcome === "cycle") {
        return true;
      }
      if (outcome === "budget") {
        return false;
      }
    }
  }
  return false;
}

function solveUserNode(
  state: InformationState,
  context: SearchContext,
  depth: number,
): NodeValue {
  const representative = state.hypotheses[0];
  if (representative === undefined) {
    invalidRequest("A user node has no representative hypothesis.");
  }
  const actions = legalUserActions(representative.exact.publicState);
  if (actions.length === 0) {
    invalidRequest("An active exact user node has no legal action.");
  }
  for (const hypothesis of state.hypotheses.slice(1)) {
    const candidateKeys = legalUserActions(hypothesis.exact.publicState).map(
      actionKey,
    );
    if (
      stableStringify(candidateKeys) !== stableStringify(actions.map(actionKey))
    ) {
      invalidRequest(
        "Indistinguishable exact hypotheses expose different user legal actions.",
        {
          hypothesisId: hypothesis.hypothesisId,
          expected: actions.map(actionKey),
          actual: candidateKeys,
        },
      );
    }
  }
  const values = actions.map((action): ExactEndgameActionValue => {
    const aggregate = aggregateBranches(
      userActionBranches(state, action, context),
      context,
      depth,
    );
    if (aggregate.firstResolution === null) {
      invalidRequest(
        "An exact user action did not resolve its immediate positional diagnostics.",
        { actionKey: actionKey(action) },
      );
    }
    const positionalDiagnostics: ExactEndgamePositionalDiagnostics = {
      ...aggregate.firstResolution,
      firstOpponentEscapeProbabilities:
        aggregate.firstOpponentEscapeProbabilities,
      userHeadsUpOpponentProbabilities:
        aggregate.userHeadsUpOpponentProbabilities,
    };
    return {
      action,
      actionKey: actionKey(action),
      userBhabhiRisk: aggregate.bhabhiProbabilities.user,
      bhabhiProbabilities: aggregate.bhabhiProbabilities,
      positionalDiagnostics,
    };
  });
  values.sort(
    (left, right) =>
      left.userBhabhiRisk - right.userBhabhiRisk ||
      compareUserActions(left.action, right.action),
  );
  const best = values[0];
  if (best === undefined) {
    invalidRequest("Exact user backup produced no action value.");
  }
  return {
    bhabhiProbabilities: cloneTerminalVector(best.bhabhiProbabilities),
    firstOpponentEscapeProbabilities:
      best.positionalDiagnostics.firstOpponentEscapeProbabilities,
    userHeadsUpOpponentProbabilities:
      best.positionalDiagnostics.userHeadsUpOpponentProbabilities,
    pendingTrickResolution: !awaitingTrickResolution(
      representative.exact.publicState,
    )
      ? null
      : validatedImmediateResolution({
          immediatePickupProbability:
            best.positionalDiagnostics.immediatePickupProbability,
          expectedImmediatePickupCount:
            best.positionalDiagnostics.expectedImmediatePickupCount,
          immediatePowerProbability:
            best.positionalDiagnostics.immediatePowerProbability,
        }),
    actionValues: values,
  };
}

function solveNode(
  state: InformationState,
  context: SearchContext,
  depth: number,
): NodeValue {
  checkInterrupts(context);
  context.diagnostics.maximumDepth = Math.max(
    context.diagnostics.maximumDepth,
    depth,
  );
  if (state.hypotheses.length > context.config.exact.maxJointHypotheses) {
    throw new ExactSearchAbort(
      "JOINT_HYPOTHESIS_LIMIT",
      "A conditional exact node exceeded the joint-hypothesis limit.",
    );
  }
  const observableKey = assertOneInformationState(state);
  const keys = stateKeys(state, observableKey);
  const memoized = context.memo.get(keys.belief);
  if (memoized !== undefined) {
    context.diagnostics.memoHits += 1;
    return memoized;
  }
  context.diagnostics.cycleChecks += 1;
  if (
    context.visitingBeliefs.has(keys.belief) ||
    context.visitingPhysicalStates.has(keys.physical)
  ) {
    throw new ExactSearchAbort(
      "CYCLIC_INFORMATION_GRAPH",
      "The exact backend detected a revisitable information-state class; the acyclic solver declined it.",
    );
  }
  context.diagnostics.informationStates += 1;
  if (
    context.diagnostics.informationStates >
    context.config.exact.maxInformationStates
  ) {
    throw new ExactSearchAbort(
      "INFORMATION_STATE_LIMIT",
      "Exact information-state search exceeded its state limit.",
    );
  }
  context.visitingBeliefs.add(keys.belief);
  context.visitingPhysicalStates.add(keys.physical);
  try {
    const representative = state.hypotheses[0];
    if (representative === undefined) {
      invalidRequest("An exact node has no representative hypothesis.");
    }
    const publicState = representative.exact.publicState;
    let result: NodeValue;
    if (publicState.status === "complete") {
      context.diagnostics.terminalStates += 1;
      result = terminalValue(state);
    } else if (publicState.pendingAction !== null) {
      context.diagnostics.chanceNodes += 1;
      const aggregate = aggregateBranches(
        chanceBranches(state, context),
        context,
        depth,
      );
      if (
        awaitingTrickResolution(publicState) &&
        aggregate.firstResolution === null
      ) {
        invalidRequest(
          "An exact chance continuation lost the active trick's positional resolution.",
        );
      }
      result = {
        bhabhiProbabilities: aggregate.bhabhiProbabilities,
        firstOpponentEscapeProbabilities:
          aggregate.firstOpponentEscapeProbabilities,
        userHeadsUpOpponentProbabilities:
          aggregate.userHeadsUpOpponentProbabilities,
        pendingTrickResolution: awaitingTrickResolution(publicState)
          ? aggregate.firstResolution
          : null,
        actionValues: null,
      };
    } else if (publicState.turn === "user") {
      context.diagnostics.userNodes += 1;
      result = solveUserNode(state, context, depth);
    } else if (publicState.turn === "p2" || publicState.turn === "p3") {
      context.diagnostics.opponentNodes += 1;
      const aggregate = aggregateBranches(
        opponentBranches(state, publicState.turn, context),
        context,
        depth,
      );
      if (
        awaitingTrickResolution(publicState) &&
        aggregate.firstResolution === null
      ) {
        invalidRequest(
          "An exact opponent continuation lost the active trick's positional resolution.",
          {
            turn: publicState.turn,
            trick: publicState.trick,
            handCounts: publicState.handCounts,
            activeSeats: publicState.activeSeats,
            pendingAction: publicState.pendingAction,
          },
        );
      }
      result = {
        bhabhiProbabilities: aggregate.bhabhiProbabilities,
        firstOpponentEscapeProbabilities:
          aggregate.firstOpponentEscapeProbabilities,
        userHeadsUpOpponentProbabilities:
          aggregate.userHeadsUpOpponentProbabilities,
        pendingTrickResolution: awaitingTrickResolution(publicState)
          ? aggregate.firstResolution
          : null,
        actionValues: null,
      };
    } else {
      invalidRequest("An active exact node has no valid actor.", {
        status: publicState.status,
        turn: publicState.turn,
      });
    }
    context.memo.set(keys.belief, result);
    return result;
  } finally {
    context.visitingBeliefs.delete(keys.belief);
    context.visitingPhysicalStates.delete(keys.physical);
  }
}

function activeCardCount(state: PublicInformationState): number {
  return (
    SEATS.reduce((sum, seat) => sum + state.handCounts[seat], 0) +
    (state.trick?.plays.length ?? 0) +
    (state.pendingAction?.excludedTrick.length ?? 0)
  );
}

function validatedHypothesisSet(
  input: ExactInformationHypothesisSet,
): ExactInformationHypothesisSet {
  const rebuilt = createExactInformationHypothesisSet({
    historyHash: input.historyHash,
    sourceKind: input.sourceKind,
    sourceChecksum: input.sourceChecksum,
    supportKind: input.supportKind,
    supportWorldCount: input.supportWorldCount,
    behaviorConfigHash: input.behaviorConfigHash,
    hypotheses: input.hypotheses.map((hypothesis) => ({
      hypothesisId: hypothesis.hypothesisId,
      occurrenceIndex: hypothesis.occurrenceIndex,
      witnessId: hypothesis.witnessId,
      p2ModelId: hypothesis.p2ModelId,
      p3ModelId: hypothesis.p3ModelId,
      mass: hypothesis.mass,
      currentHands: hypothesis.currentHands,
    })),
  });
  if (
    rebuilt.checksum !== input.checksum ||
    rebuilt.totalHypotheses !== input.totalHypotheses ||
    rebuilt.distinctWitnesses !== input.distinctWitnesses ||
    Math.abs(input.totalMass - 1) > NORMALIZATION_TOLERANCE
  ) {
    invalidRequest("Exact hypothesis-set envelope or checksum is stale.", {
      expectedChecksum: input.checksum,
      actualChecksum: rebuilt.checksum,
      expectedTotalHypotheses: input.totalHypotheses,
      actualTotalHypotheses: rebuilt.totalHypotheses,
    });
  }
  return rebuilt;
}

function initialInformationState(
  input: ExactEndgameSearchInput,
  set: ExactInformationHypothesisSet,
): InformationState {
  try {
    assertPublicStateInvariant(input.publicState);
  } catch (cause) {
    invalidRequest(
      "Exact endgame received an invalid public state.",
      {},
      cause,
    );
  }
  const events =
    input.activeEvents === undefined
      ? undefined
      : input.activeEvents.map((event) => structuredClone(event));
  const hypotheses = set.hypotheses.map((hypothesis): ConcreteState => {
    const exact: ExactHandState = {
      publicState: structuredClone(input.publicState),
      hands: Object.fromEntries(
        SEATS.map((seat) => [seat, [...hypothesis.currentHands[seat]]]),
      ) as ExactHandState["hands"],
    };
    try {
      assertExactHandStateInvariant(exact);
    } catch (cause) {
      invalidRequest(
        "An exact hypothesis is inconsistent with the public state.",
        {
          hypothesisId: hypothesis.hypothesisId,
          witnessId: hypothesis.witnessId,
        },
        cause,
      );
    }
    return {
      hypothesisId: hypothesis.hypothesisId,
      occurrenceIndex: hypothesis.occurrenceIndex,
      witnessId: hypothesis.witnessId,
      p2ModelId: hypothesis.p2ModelId,
      p3ModelId: hypothesis.p3ModelId,
      mass: hypothesis.mass,
      exact,
      events,
      userHeadsUpOpponent: currentUserHeadsUpOpponent(exact.publicState),
    };
  });
  return { hypotheses };
}

function resultEnvelope(input: {
  readonly request: ExactEndgameSearchInput;
  readonly set: ExactInformationHypothesisSet;
  readonly publicStateHash: string;
  readonly configHash: string;
  readonly behaviorConfigHash: string;
  readonly diagnostics: MutableDiagnostics;
  readonly warnings: readonly string[];
}) {
  return {
    schemaVersion: 1 as const,
    algorithmVersion: EXACT_ENDGAME_ALGORITHM_VERSION,
    method: "exact-behavioral-information-state-dp" as const,
    executionMode: "research-only" as const,
    historyHash: input.request.historyHash,
    publicStateHash: input.publicStateHash,
    hypothesisSetChecksum: input.set.checksum,
    configHash: input.configHash,
    behaviorConfigHash: input.behaviorConfigHash,
    assumptions: {
      userPolicy: "optimal-shared-observable-information-state" as const,
      opponentPolicy:
        input.request.opponentPolicyMode === "deterministic-baseline"
          ? ("separate-deterministic-baseline-models" as const)
          : ("separate-static-behavior-models" as const),
      chance: "uniform-over-eligible-cards" as const,
      cycleHandling: "detect-and-decline" as const,
      numericTolerance: NUMERIC_TOLERANCE,
    },
    diagnostics: exactDiagnostics(input.diagnostics),
    warnings: [...input.warnings],
  };
}

function solvedResult(input: {
  readonly envelope: ReturnType<typeof resultEnvelope>;
  readonly value: NodeValue;
}): ExactEndgameResult {
  const actionValues = input.value.actionValues;
  const best = actionValues?.[0];
  if (actionValues === null || best === undefined) {
    invalidRequest("Exact root did not produce user action values.");
  }
  const tiedBestActionKeys = actionValues
    .filter(
      (candidate) =>
        candidate.userBhabhiRisk <= best.userBhabhiRisk + NUMERIC_TOLERANCE,
    )
    .map((candidate) => candidate.actionKey)
    .sort();
  const content = {
    ...input.envelope,
    quality: "Exact" as const,
    eligibility: { eligible: true as const },
    recommendedAction: best.action,
    recommendedActionKey: best.actionKey,
    tiedBestActionKeys,
    userBhabhiRisk: best.userBhabhiRisk,
    bhabhiProbabilities: best.bhabhiProbabilities,
    positionalDiagnostics: best.positionalDiagnostics,
    actionValues,
  };
  return deepFreeze({
    ...content,
    resultHash: stableHash(content),
  });
}

function ineligibleResult(input: {
  readonly envelope: ReturnType<typeof resultEnvelope>;
  readonly code: ExactIneligibilityCode;
  readonly detail: string;
}): ExactEndgameResult {
  const content = {
    ...input.envelope,
    quality: "Unavailable" as const,
    eligibility: {
      eligible: false as const,
      code: input.code,
      detail: input.detail,
    },
    recommendedAction: null,
    recommendedActionKey: null,
    tiedBestActionKeys: [] as const,
    userBhabhiRisk: null,
    bhabhiProbabilities: null,
    positionalDiagnostics: null,
    actionValues: [] as const,
  };
  return deepFreeze({
    ...content,
    resultHash: stableHash(content),
  });
}

/**
 * Exhaustive Bayesian best response for bounded, acyclic endgames.
 *
 * The user selects one action for every shared observable information state.
 * Opponents use separate fixed behavior models from their own private
 * observations, and chance enumerates every eligible card. Cyclic classes are
 * detected and declined rather than truncated or mislabeled Exact.
 */
export function solveExactEndgame(
  request: ExactEndgameSearchInput,
): ExactEndgameResult {
  const config = validateAdvancedSearchConfig(request.config ?? {});
  const behaviorConfig =
    request.behaviorConfig ?? DEFAULT_BEHAVIOR_MODEL_CONFIG;
  try {
    validateBehaviorModelConfig(behaviorConfig);
  } catch (cause) {
    throw new AdvancedSearchContractError(
      "INVALID_CONFIG",
      "Exact endgame received invalid behavior-model configuration.",
      {},
      { cause },
    );
  }
  const behaviorConfigHash = behaviorBeliefConfigurationHash(behaviorConfig);
  const rawOpponentPolicyMode: unknown =
    request.opponentPolicyMode ?? "behavior-distribution";
  if (
    rawOpponentPolicyMode !== "behavior-distribution" &&
    rawOpponentPolicyMode !== "deterministic-baseline"
  ) {
    throw new AdvancedSearchContractError(
      "INVALID_CONFIG",
      "Exact endgame received an unknown opponent-policy mode.",
      { opponentPolicyMode: rawOpponentPolicyMode },
    );
  }
  const opponentPolicyMode: ExactOpponentPolicyMode = rawOpponentPolicyMode;
  const set = validatedHypothesisSet(request.hypothesisSet);
  if (
    request.historyHash.trim().length === 0 ||
    request.historyHash !== set.historyHash
  ) {
    staleRequest("Exact request and hypothesis set use different histories.", {
      requestHistoryHash: request.historyHash,
      setHistoryHash: set.historyHash,
    });
  }
  if (behaviorConfigHash !== set.behaviorConfigHash) {
    staleRequest(
      "Exact request behavior configuration does not match its hypotheses.",
      {
        requestBehaviorConfigHash: behaviorConfigHash,
        setBehaviorConfigHash: set.behaviorConfigHash,
      },
    );
  }
  if (request.activeEvents !== undefined) {
    if (
      request.activeEvents.length !== request.publicState.appliedEventCount ||
      semanticHistoryHash(request.activeEvents) !== request.historyHash
    ) {
      staleRequest(
        "Exact request event history does not match its public state and history hash.",
        {
          eventCount: request.activeEvents.length,
          appliedEventCount: request.publicState.appliedEventCount,
          expectedHistoryHash: request.historyHash,
          actualHistoryHash: semanticHistoryHash(request.activeEvents),
        },
      );
    }
  }
  const initial = initialInformationState(request, set);
  const rootObservableKey = assertOneInformationState(initial);
  const representative = initial.hypotheses[0];
  if (representative === undefined) {
    invalidRequest("Exact root has no hypothesis.");
  }
  const rootState = representative.exact.publicState;
  if (
    rootState.status !== "active" ||
    rootState.turn !== "user" ||
    rootState.pendingAction !== null
  ) {
    invalidRequest(
      "Exact recommendations require an active non-chance user turn.",
      {
        status: rootState.status,
        turn: rootState.turn,
        pendingAction: rootState.pendingAction,
      },
    );
  }
  const diagnostics: MutableDiagnostics = {
    activeCardCount: activeCardCount(rootState),
    initialHypotheses: initial.hypotheses.length,
    informationStates: 0,
    branches: 0,
    terminalStates: 0,
    memoHits: 0,
    userNodes: 0,
    opponentNodes: 0,
    chanceNodes: 0,
    maximumDepth: 0,
    cycleChecks: 0,
    cycleProbeStates: 0,
    cycleProbeBranches: 0,
  };
  const warnings = [
    "Research-only exact backend; this result is not a production-eligibility decision.",
    opponentPolicyMode === "deterministic-baseline"
      ? "Exact means exhaustive only under the displayed rules, complete support, separate deterministic baseline opponent policies, uniform rule chance, and the shared-observation optimal user policy."
      : "Exact means exhaustive only under the displayed rules, complete support, separate static opponent behavior models, uniform rule chance, and the shared-observation optimal user policy.",
    ...(request.activeEvents === undefined
      ? [
          "Synthetic/effects-only history path: actor memory is derived from rule effects because no complete event ledger was supplied.",
        ]
      : []),
  ];
  const configHash = stableHash({
    advancedConfigHash: advancedSearchConfigurationHash(config),
    opponentPolicyMode,
  });
  const envelopeInput = {
    request,
    set,
    publicStateHash: stableHash({
      rootObservableKey,
      publicProjection: sortedPublicStateProjection(rootState),
    }),
    configHash,
    behaviorConfigHash,
    diagnostics,
    warnings,
  };

  const preflight = (): ExactSearchAbort | null => {
    if (set.supportKind !== "exhaustive") {
      return new ExactSearchAbort(
        "INCOMPLETE_ENUMERATION",
        "Exact search requires exhaustive hard-belief support; sampled support is approximate.",
      );
    }
    if (
      opponentPolicyMode === "deterministic-baseline" &&
      set.hypotheses.some(
        (hypothesis) =>
          hypothesis.p2ModelId === "random" ||
          hypothesis.p3ModelId === "random",
      )
    ) {
      return new ExactSearchAbort(
        "UNSUPPORTED_POLICY_MEMORY",
        "Deterministic-baseline exact search requires deterministic P2/P3 model IDs.",
      );
    }
    if (diagnostics.activeCardCount > config.exact.maxActiveCards) {
      return new ExactSearchAbort(
        "ACTIVE_CARD_LIMIT",
        "The exact root exceeds the active-card limit.",
      );
    }
    if (diagnostics.initialHypotheses > config.exact.maxJointHypotheses) {
      return new ExactSearchAbort(
        "JOINT_HYPOTHESIS_LIMIT",
        "The exact root exceeds the joint-hypothesis limit.",
      );
    }
    if (request.shouldCancel?.() === true) {
      return new ExactSearchAbort(
        "CANCELLED",
        "Exact information-state search was cancelled before expansion.",
      );
    }
    return null;
  };
  const preflightFailure = preflight();
  if (preflightFailure !== null) {
    return ineligibleResult({
      envelope: resultEnvelope(envelopeInput),
      code: preflightFailure.code,
      detail: preflightFailure.message,
    });
  }

  const context: SearchContext = {
    config,
    behaviorConfig,
    opponentPolicyMode,
    startedAt: performance.now(),
    shouldCancel: request.shouldCancel,
    diagnostics,
    memo: new Map(),
    visitingBeliefs: new Set(),
    visitingPhysicalStates: new Set(),
  };
  try {
    if (hasReachableShortCycle(initial, context)) {
      throw new ExactSearchAbort(
        "CYCLIC_INFORMATION_GRAPH",
        "The exact backend detected a revisitable semantic pickup/redeal state; the acyclic solver declined it.",
      );
    }
    const value = solveNode(initial, context, 0);
    return solvedResult({
      envelope: resultEnvelope(envelopeInput),
      value,
    });
  } catch (cause) {
    if (cause instanceof ExactSearchAbort) {
      return ineligibleResult({
        envelope: resultEnvelope(envelopeInput),
        code: cause.code,
        detail: cause.message,
      });
    }
    throw cause;
  }
}
