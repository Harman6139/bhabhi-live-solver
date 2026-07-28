import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createActorObservation } from "../../src/agents/observation";
import {
  getBaselinePolicy,
  type BaselinePolicyId,
} from "../../src/agents/policies";
import { FULL_DECK, sortCards, type Card } from "../../src/domain/cards";
import { CANONICAL_RULES } from "../../src/domain/rule-config";
import { SEATS, type OpponentSeat, type Seat } from "../../src/domain/seats";
import type { GameCreatedEvent, GameEvent } from "../../src/events/game-events";
import { stableHash, stableStringify } from "../../src/events/stable-hash";
import { replayTimeline, type GameTimeline } from "../../src/events/timeline";
import {
  buildBehaviorBelief,
  predictCurrentOpponentAction,
  type BehaviorBelief,
} from "../../src/inference/behavior-belief";
import {
  allBehaviorModelDistributions,
  enumerateBehaviorActions,
} from "../../src/inference/behavior-models";
import {
  buildHardBelief,
  buildHardBeliefFromEvidence,
} from "../../src/inference/belief";
import { compileHardEvidence } from "../../src/inference/hard-evidence";
import {
  assertHiddenWorldInvariant,
  currentHandsKey,
} from "../../src/inference/hidden-world";
import type { HardBelief, HiddenWorld } from "../../src/inference/types";
import { createSeededRng } from "../../src/random/keyed-rng";
import {
  applyExactHandEvent,
  createExactHandState,
  type ExactHandState,
} from "../../src/rules/exact-hand-transition";

type GeneratedFixture = {
  readonly timeline: GameTimeline;
  readonly deal: Readonly<Record<Seat, readonly Card[]>>;
  readonly finalExactState: ExactHandState;
};

const FIXED_DECK_ORDER = [...FULL_DECK.slice(1), FULL_DECK[0]].filter(
  (card): card is Card => card !== undefined,
);

const FIXED_DEAL: Readonly<Record<Seat, readonly Card[]>> = Object.freeze({
  user: Object.freeze(
    FIXED_DECK_ORDER.filter((_card, index) => index % SEATS.length === 0),
  ),
  p2: Object.freeze(
    FIXED_DECK_ORDER.filter((_card, index) => index % SEATS.length === 1),
  ),
  p3: Object.freeze(
    FIXED_DECK_ORDER.filter((_card, index) => index % SEATS.length === 2),
  ),
});

function setupForDeal(
  deal: Readonly<Record<Seat, readonly Card[]>>,
): GameCreatedEvent {
  const aceSpadesHolder = SEATS.find((seat) => deal[seat].includes("AS"));
  if (aceSpadesHolder === undefined) {
    throw new Error("Behavior fixture deal has no Ace of Spades holder.");
  }
  return {
    type: "game-created",
    schemaVersion: 1,
    rules: structuredClone(CANONICAL_RULES),
    userHand: [...deal.user],
    startingCounts: {
      user: deal.user.length,
      p2: deal.p2.length,
      p3: deal.p3.length,
    },
    aceSpadesHolder,
  };
}

function nextChanceEvent(
  state: ExactHandState,
): Exclude<GameEvent, GameCreatedEvent> {
  const pending = state.publicState.pendingAction;
  if (pending?.kind === "waste-draw") {
    const card = state.publicState.waste[0];
    if (card === undefined) {
      throw new Error("Waste-draw fixture has no eligible prior waste.");
    }
    return {
      type: "waste-card-drawn",
      schemaVersion: 1,
      seat: pending.player,
      card,
    };
  }
  if (pending?.kind === "player-draw") {
    const card = state.hands[pending.source][0];
    if (card === undefined) {
      throw new Error("Player-draw fixture source has no exact card.");
    }
    return {
      type: "player-card-drawn",
      schemaVersion: 1,
      seat: pending.player,
      source: pending.source,
      card,
    };
  }
  throw new Error("A chance event was requested without a pending draw.");
}

function generatePolicyFixture(
  p2PolicyId: BaselinePolicyId,
  p3PolicyId: BaselinePolicyId,
  minimumDiscretionaryPerOpponent = 6,
): GeneratedFixture {
  const setup = setupForDeal(FIXED_DEAL);
  const events: GameEvent[] = [setup];
  let state = createExactHandState(FIXED_DEAL, CANONICAL_RULES);
  const decisionOrdinals: Record<Seat, number> = {
    user: 0,
    p2: 0,
    p3: 0,
  };
  const discretionary: Record<OpponentSeat, number> = { p2: 0, p3: 0 };
  const policyIds: Record<Seat, BaselinePolicyId> = {
    user: "documented-basic",
    p2: p2PolicyId,
    p3: p3PolicyId,
  };

  for (let guard = 0; guard < 240; guard += 1) {
    if (
      discretionary.p2 >= minimumDiscretionaryPerOpponent &&
      discretionary.p3 >= minimumDiscretionaryPerOpponent
    ) {
      break;
    }
    if (state.publicState.status !== "active") {
      throw new Error("Behavior fixture completed before enough decisions.");
    }

    let event: Exclude<GameEvent, GameCreatedEvent>;
    if (state.publicState.pendingAction !== null) {
      event = nextChanceEvent(state);
    } else {
      const seat = state.publicState.turn;
      if (seat === null) {
        throw new Error("Active behavior fixture has no current actor.");
      }
      const observation = createActorObservation(
        {
          publicState: state.publicState,
          exactHands: state.hands,
        },
        seat,
        decisionOrdinals[seat],
        events,
      );
      if (
        (seat === "p2" || seat === "p3") &&
        enumerateBehaviorActions(observation).length > 1
      ) {
        discretionary[seat] += 1;
      }
      const choice = getBaselinePolicy(policyIds[seat]).chooseCard(
        observation,
        createSeededRng("behavior-integration-fixture").fork(
          seat,
          decisionOrdinals[seat],
        ),
      );
      event = {
        type: "card-played",
        schemaVersion: 1,
        seat,
        card: choice.card,
      };
      decisionOrdinals[seat] += 1;
    }
    state = applyExactHandEvent(state, event, events.length, "full");
    events.push(event);
  }

  if (
    discretionary.p2 < minimumDiscretionaryPerOpponent ||
    discretionary.p3 < minimumDiscretionaryPerOpponent
  ) {
    throw new Error("Behavior fixture guard exhausted.");
  }
  return {
    timeline: {
      schemaVersion: 1,
      events,
      cursor: events.length,
      orphanedEvents: [],
    },
    deal: FIXED_DEAL,
    finalExactState: state,
  };
}

function forcedOpeningFixture(): GeneratedFixture {
  const setup = setupForDeal(FIXED_DEAL);
  let state = createExactHandState(FIXED_DEAL, CANONICAL_RULES);
  const holder = setup.aceSpadesHolder;
  const forcedPlay = {
    type: "card-played",
    schemaVersion: 1,
    seat: holder,
    card: "AS",
  } as const;
  state = applyExactHandEvent(state, forcedPlay, 1, "full");
  return {
    timeline: {
      schemaVersion: 1,
      events: [setup, forcedPlay],
      cursor: 2,
      orphanedEvents: [],
    },
    deal: FIXED_DEAL,
    finalExactState: state,
  };
}

function concreteHardBelief(fixture: GeneratedFixture): HardBelief {
  const evidence = compileHardEvidence(fixture.timeline);
  const initialP2 = sortCards(fixture.deal.p2);
  const world: HiddenWorld = {
    schemaVersion: 1,
    historyHash: evidence.historyHash,
    witnessId: stableHash({
      schemaVersion: 1,
      historyHash: evidence.historyHash,
      initialP2,
    }),
    initialHands: {
      p2: initialP2,
      p3: sortCards(fixture.deal.p3),
    },
    currentHands: {
      user: sortCards(fixture.finalExactState.hands.user),
      p2: sortCards(fixture.finalExactState.hands.p2),
      p3: sortCards(fixture.finalExactState.hands.p3),
    },
    multiplicity: "1",
  };
  assertHiddenWorldInvariant(world, evidence);
  const base = buildHardBeliefFromEvidence(evidence, {
    seed: "concrete-behavior-fixture",
    sampleCount: 1,
    forceSampling: true,
  });
  return {
    ...base,
    worlds: [world],
    diagnostics: {
      ...base.diagnostics,
      generatedWorlds: 1,
      uniqueWitnesses: 1,
      distinctCurrentHands: 1,
      duplicateSamples: 0,
      worldSetChecksum: stableHash({
        schemaVersion: 1,
        orderedWitnessIds: [world.witnessId],
      }),
    },
  };
}

function withWorlds(
  base: HardBelief,
  worlds: readonly HiddenWorld[],
): HardBelief {
  const uniqueWitnesses = new Set(worlds.map((world) => world.witnessId)).size;
  return {
    ...base,
    worlds,
    diagnostics: {
      ...base.diagnostics,
      generatedWorlds: worlds.length,
      uniqueWitnesses,
      distinctCurrentHands: new Set(worlds.map(currentHandsKey)).size,
      duplicateSamples: worlds.length - uniqueWitnesses,
      worldSetChecksum: stableHash({
        schemaVersion: 1,
        orderedWitnessIds: worlds.map((world) => world.witnessId),
      }),
    },
  };
}

function modelProbability(
  belief: BehaviorBelief,
  seat: OpponentSeat,
  modelId: string,
): number {
  const match = belief.opponentPosteriors[seat].find(
    (entry) => entry.modelId === modelId,
  );
  if (match === undefined) {
    throw new Error(`Missing ${modelId} posterior for ${seat}.`);
  }
  return match.probability;
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (value === null || typeof value !== "object") {
    return keys;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

describe("production behavioral belief replay", () => {
  it("leaves every model and world factor neutral on a forced replayed decision", () => {
    const fixture = forcedOpeningFixture();
    const hardBelief = concreteHardBelief(fixture);
    const belief = buildBehaviorBelief(fixture.timeline, hardBelief, {
      lapseProbability: 0.2,
      likelihoodPower: 1,
      maximumBayesFactor: 4,
    });
    const trace = belief.decisionTraces[0];
    expect(trace?.forced).toBe(true);
    expect(trace?.minimumModelLikelihood).toBe(1);
    expect(trace?.maximumModelLikelihood).toBe(1);
    expect(trace?.maximumTemperedBayesFactor).toBe(1);
    expect(trace?.actingPosteriorAfter).toEqual(trace?.actingPosteriorBefore);
    expect(belief.worldOccurrences[0]?.weight).toBe(1);
  });

  it("learns separate low/high opponent styles gradually from actor-safe chronological decisions", () => {
    const fixture = generatePolicyFixture("always-high", "always-low");
    const hardBelief = concreteHardBelief(fixture);
    const tempered = buildBehaviorBelief(fixture.timeline, hardBelief, {
      lapseProbability: 0.12,
      likelihoodPower: 0.1,
    });
    const untempered = buildBehaviorBelief(fixture.timeline, hardBelief, {
      lapseProbability: 0.12,
      likelihoodPower: 1,
    });

    expect(modelProbability(tempered, "p2", "always-high")).toBeGreaterThan(
      modelProbability(tempered, "p2", "always-low"),
    );
    expect(modelProbability(tempered, "p3", "always-low")).toBeGreaterThan(
      modelProbability(tempered, "p3", "always-high"),
    );
    expect(modelProbability(untempered, "p2", "always-high")).toBeGreaterThan(
      modelProbability(tempered, "p2", "always-high"),
    );

    const p2Discretionary = tempered.decisionTraces.filter(
      (trace) => trace.seat === "p2" && !trace.forced,
    );
    expect(p2Discretionary.length).toBeGreaterThanOrEqual(6);
    const highSequence = p2Discretionary.map(
      (trace) =>
        trace.actingPosteriorAfter.find(
          (entry) => entry.modelId === "always-high",
        )?.probability ?? 0,
    );
    expect(highSequence.at(-1)).toBeGreaterThan(highSequence[0] ?? 0);
    expect(highSequence.at(-1)).toBeLessThan(1);
    expect(
      tempered.decisionTraces.every(
        (trace) => trace.nonActingConditionalMaximumDelta === 0,
      ),
    ).toBe(true);
  });

  it("retains positive noisy support, normalized weights, diagnostics, and deep immutability", () => {
    const fixture = generatePolicyFixture("always-high", "always-low", 4);
    const hardBelief = concreteHardBelief(fixture);
    const belief = buildBehaviorBelief(fixture.timeline, hardBelief, {
      lapseProbability: 0.05,
      likelihoodPower: 0.7,
    });

    expect(belief.worldOccurrences).toHaveLength(1);
    expect(belief.worldOccurrences[0]?.weight).toBe(1);
    expect(belief.diagnostics.hardSupportPreserved).toBe(true);
    expect(belief.diagnostics.zeroWeightOccurrences).toBe(0);
    expect(belief.diagnostics.effectiveSampleSize).toBe(1);
    expect(belief.diagnostics.normalizedEntropy).toBe(1);
    expect(
      Object.values(belief.opponentPosteriors)
        .flat()
        .every((entry) => entry.probability > 0),
    ).toBe(true);
    expect(
      belief.decisionTraces.every(
        (trace) =>
          trace.minimumModelLikelihood > 0 &&
          trace.observedPredictiveProbability > 0 &&
          trace.maximumTemperedBayesFactor <=
            belief.config.maximumBayesFactor + Number.EPSILON * 64,
      ),
    ).toBe(true);
    expect(belief.diagnostics.configuredMaximumBayesFactor).toBe(4);
    expect(
      belief.diagnostics.maximumObservedTemperedBayesFactor,
    ).toBeLessThanOrEqual(4 + Number.EPSILON * 64);
    expect(belief.diagnostics.totalWorldDecisionEvaluations).toBe(
      belief.decisionTraces.length,
    );
    expect(Object.isFrozen(belief)).toBe(true);
    expect(Object.isFrozen(belief.worldOccurrences)).toBe(true);
    expect(
      Object.isFrozen(
        belief.worldOccurrences[0]?.conditionalModelProbabilities.p2,
      ),
    ).toBe(true);
  });

  it("preserves duplicate hard occurrences and their correlated conditional factors", () => {
    const fixture = generatePolicyFixture("always-high", "always-low", 2);
    const sampled = buildHardBelief(fixture.timeline, {
      seed: "behavior-duplicate-worlds",
      sampleCount: 16,
      forceSampling: true,
    });
    const first = sampled.worlds[0];
    const second = sampled.worlds.find(
      (world) => world.witnessId !== first?.witnessId,
    );
    if (first === undefined || second === undefined) {
      throw new Error("Duplicate test requires two distinct sampled worlds.");
    }
    const paired = withWorlds(sampled, [first, second]);
    const duplicated = withWorlds(sampled, [first, first, second, second]);
    const pairedBelief = buildBehaviorBelief(fixture.timeline, paired);
    const belief = buildBehaviorBelief(fixture.timeline, duplicated);

    expect(belief.worldOccurrences).toHaveLength(4);
    expect(belief.diagnostics.uniqueWitnesses).toBe(2);
    expect(belief.diagnostics.duplicateOccurrences).toBe(2);
    expect(belief.worldOccurrences[0]?.witnessId).toBe(
      belief.worldOccurrences[1]?.witnessId,
    );
    expect(belief.worldOccurrences[2]?.witnessId).toBe(
      belief.worldOccurrences[3]?.witnessId,
    );
    expect(belief.worldOccurrences[0]?.weight).toBeCloseTo(
      belief.worldOccurrences[1]?.weight ?? 0,
      14,
    );
    expect(belief.worldOccurrences[0]?.conditionalModelProbabilities).toEqual(
      belief.worldOccurrences[1]?.conditionalModelProbabilities,
    );
    expect(
      belief.worldOccurrences.reduce(
        (sum, occurrence) => sum + occurrence.weight,
        0,
      ),
    ).toBeCloseTo(1, 14);
    expect(
      belief.worldOccurrences.every((occurrence) => occurrence.weight > 0),
    ).toBe(true);
    for (const seat of ["p2", "p3"] as const) {
      for (const model of pairedBelief.opponentPosteriors[seat]) {
        expect(modelProbability(belief, seat, model.modelId)).toBeCloseTo(
          model.probability,
          14,
        );
      }
    }
    for (const [pairedIndex, duplicatedIndices] of [
      [0, [0, 1]],
      [1, [2, 3]],
    ] as const) {
      const pairedWeight =
        pairedBelief.worldOccurrences[pairedIndex]?.weight ?? 0;
      const duplicatedWeight = duplicatedIndices.reduce<number>(
        (sum, index) => sum + (belief.worldOccurrences[index]?.weight ?? 0),
        0,
      );
      expect(duplicatedWeight).toBeCloseTo(pairedWeight, 14);
    }
  });

  it("rebuilds deterministically after history changes and rejects stale hard support", () => {
    const fixture = generatePolicyFixture("always-high", "always-low", 3);
    const hardBelief = concreteHardBelief(fixture);
    const first = buildBehaviorBelief(fixture.timeline, hardBelief);
    const second = buildBehaviorBelief(fixture.timeline, hardBelief);
    expect(stableStringify(second)).toBe(stableStringify(first));

    const earlier: GameTimeline = {
      ...fixture.timeline,
      cursor: fixture.timeline.cursor - 1,
    };
    const earlierHard = buildHardBelief(earlier, {
      seed: "behavior-history-rebuild",
      sampleCount: 8,
      forceSampling: true,
    });
    const rebuilt = buildBehaviorBelief(earlier, earlierHard);
    expect(rebuilt.historyHash).not.toBe(first.historyHash);
    expect(() => buildBehaviorBelief(fixture.timeline, earlierHard)).toThrow(
      /stale|different active timeline/u,
    );
  });

  it("predicts the current opponent action from world and conditional-model mixtures", () => {
    const fixture = generatePolicyFixture("always-high", "always-low", 2);
    let opponentCursor = 1;
    for (
      let cursor = 1;
      cursor <= fixture.timeline.events.length;
      cursor += 1
    ) {
      const candidate: GameTimeline = {
        ...fixture.timeline,
        cursor,
      };
      const state = replayTimeline(candidate).state;
      if (
        (state.turn === "p2" || state.turn === "p3") &&
        state.pendingAction === null
      ) {
        opponentCursor = cursor;
        break;
      }
    }
    const timeline: GameTimeline = {
      ...fixture.timeline,
      cursor: opponentCursor,
    };
    const hardBelief = buildHardBelief(timeline, {
      seed: "behavior-current-prediction",
      sampleCount: 12,
      forceSampling: true,
    });
    const belief = buildBehaviorBelief(timeline, hardBelief);
    const prediction = predictCurrentOpponentAction(
      belief,
      hardBelief,
      timeline,
    );

    expect(prediction).not.toBeNull();
    expect(prediction?.historyHash).toBe(belief.historyHash);
    expect(
      prediction?.actionDistribution.reduce(
        (sum, entry) => sum + entry.probability,
        0,
      ),
    ).toBeCloseTo(1, 14);
    expect(
      prediction?.actionDistribution.every((entry) => entry.probability > 0),
    ).toBe(true);
    expect(Object.isFrozen(prediction?.actionDistribution)).toBe(true);
  });

  it("keeps production replay actor-safe and free of hidden-truth dependencies", () => {
    const modelSource = readFileSync(
      new URL("../../src/inference/behavior-models.ts", import.meta.url),
      "utf8",
    );
    const beliefSource = readFileSync(
      new URL("../../src/inference/behavior-belief.ts", import.meta.url),
      "utf8",
    );
    expect(`${modelSource}\n${beliefSource}`).not.toMatch(
      /(?:\/simulator\/|SimulationTruth|createSimulationTruth)/u,
    );

    const swappedUserCard = FIXED_DEAL.user[0];
    const swappedP2Card = FIXED_DEAL.p2[0];
    if (swappedUserCard === undefined || swappedP2Card === undefined) {
      throw new Error("Privacy metamorphism requires two swappable cards.");
    }
    const alternateDeal: Readonly<Record<Seat, readonly Card[]>> = {
      user: FIXED_DEAL.user.map((card) =>
        card === swappedUserCard ? swappedP2Card : card,
      ),
      p2: FIXED_DEAL.p2.map((card) =>
        card === swappedP2Card ? swappedUserCard : card,
      ),
      p3: [...FIXED_DEAL.p3],
    };
    const originalState = createExactHandState(FIXED_DEAL, CANONICAL_RULES);
    const alternateState = createExactHandState(alternateDeal, CANONICAL_RULES);
    const originalObservation = createActorObservation(
      {
        publicState: originalState.publicState,
        exactHands: originalState.hands,
      },
      "p3",
      0,
      [setupForDeal(FIXED_DEAL)],
    );
    const alternateObservation = createActorObservation(
      {
        publicState: alternateState.publicState,
        exactHands: alternateState.hands,
      },
      "p3",
      0,
      [setupForDeal(alternateDeal)],
    );
    expect(stableStringify(alternateObservation)).toBe(
      stableStringify(originalObservation),
    );
    expect(
      stableStringify(allBehaviorModelDistributions(alternateObservation)),
    ).toBe(stableStringify(allBehaviorModelDistributions(originalObservation)));

    const fixture = generatePolicyFixture("always-high", "always-low", 2);
    const belief = buildBehaviorBelief(
      fixture.timeline,
      concreteHardBelief(fixture),
    );
    const keys = collectKeys(belief);
    for (const forbidden of [
      "ownHand",
      "exactHands",
      "initialHands",
      "currentHands",
      "unresolvedCards",
      "knownOpponentCards",
      "truth",
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });
});
