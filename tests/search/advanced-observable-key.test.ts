import { describe, expect, it } from "vitest";

import { createActorObservation } from "../../src/agents/observation";
import { SUITS, suitOf, type Card } from "../../src/domain/cards";
import {
  activeTimelineEvents,
  replayTimeline,
} from "../../src/events/timeline";
import { buildBehaviorBelief } from "../../src/inference/behavior-belief";
import { buildHardBelief } from "../../src/inference/belief";
import { AdvancedSearchContractError } from "../../src/search/advanced-types";
import {
  createUserObservablePolicyMemory,
  createUserObservableStateKey,
} from "../../src/search/observable-key";
import { temporalTimeline } from "../inference/test-fixtures";

function observableFixture() {
  const timeline = temporalTimeline(3);
  const replay = replayTimeline(timeline);
  const hardBelief = buildHardBelief(timeline, {
    seed: "advanced-observable-key",
    forceSampling: true,
    sampleCount: 2,
    maxExactWorlds: 1,
    maxExactProjectionOperations: 1,
    maxExactEstimatedBytes: 1,
  });
  const behaviorBelief = buildBehaviorBelief(timeline, hardBelief);
  const world = hardBelief.worlds[0];
  if (world === undefined) {
    throw new Error("Observable-key fixture has no world.");
  }
  const observation = createActorObservation(
    {
      publicState: replay.state,
      exactHands: world.currentHands,
    },
    "user",
    behaviorBelief.decisionOrdinals.user,
    activeTimelineEvents(timeline),
  );
  const policyMemory = createUserObservablePolicyMemory({
    observation,
    decisionOrdinals: behaviorBelief.decisionOrdinals,
  });
  return {
    publicState: replay.state,
    policyMemory,
    hardBelief,
  };
}

describe("user-observable information-state key", () => {
  it("is deterministic, frozen, and invariant to set-like card ordering", () => {
    const { publicState, policyMemory } = observableFixture();
    const reordered = structuredClone(publicState);
    reordered.userHand.reverse();
    reordered.unresolvedCards.reverse();
    reordered.knownOpponentCards.p2.reverse();
    reordered.knownOpponentCards.p3.reverse();
    reordered.waste.reverse();

    const first = createUserObservableStateKey({
      publicState,
      policyMemory,
    });
    const second = createUserObservableStateKey({
      publicState: reordered,
      policyMemory: structuredClone(policyMemory),
    });

    expect(first).toEqual(second);
    expect(first.key).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("ignores hidden-world identity and runtime truth-shaped extras", () => {
    const { publicState, policyMemory, hardBelief } = observableFixture();
    const firstWorld = hardBelief.worlds[0];
    const secondWorld = hardBelief.worlds[1];
    if (firstWorld === undefined || secondWorld === undefined) {
      throw new Error("Hidden-world metamorphic fixture is incomplete.");
    }
    const stateA = Object.assign(structuredClone(publicState), {
      witnessId: firstWorld.witnessId,
      hiddenOpponentHands: firstWorld.currentHands,
    });
    const stateB = Object.assign(structuredClone(publicState), {
      witnessId: secondWorld.witnessId,
      hiddenOpponentHands: secondWorld.currentHands,
    });

    const keyA = createUserObservableStateKey({
      publicState: stateA,
      policyMemory,
    });
    const keyB = createUserObservableStateKey({
      publicState: stateB,
      policyMemory,
    });

    expect(keyA).toEqual(keyB);
  });

  it("retains legitimate user-known ownership and policy suit memory", () => {
    const { publicState, policyMemory } = observableFixture();
    const base = createUserObservableStateKey({
      publicState,
      policyMemory,
    });

    const ownershipChanged = structuredClone(publicState);
    const newlyKnown = ownershipChanged.unresolvedCards.shift();
    if (newlyKnown === undefined) {
      throw new Error("Ownership fixture has no unresolved card.");
    }
    ownershipChanged.knownOpponentCards.p2.push(newlyKnown);
    const ownershipKey = createUserObservableStateKey({
      publicState: ownershipChanged,
      policyMemory,
    });
    expect(ownershipKey.publicProjectionHash).not.toBe(
      base.publicProjectionHash,
    );
    expect(ownershipKey.key).not.toBe(base.key);

    const candidateSuit = SUITS.find(
      (suit) =>
        !publicState.knownOpponentCards.p2.some(
          (card) => suitOf(card) === suit,
        ),
    );
    if (candidateSuit === undefined) {
      throw new Error("Suit-memory fixture has no candidate suit.");
    }
    const changedStatus =
      policyMemory.currentSuitStatus.p2[candidateSuit] === "known-void"
        ? "unknown"
        : "known-void";
    const memoryChanged = {
      ...structuredClone(policyMemory),
      currentSuitStatus: {
        ...structuredClone(policyMemory.currentSuitStatus),
        p2: {
          ...structuredClone(policyMemory.currentSuitStatus.p2),
          [candidateSuit]: changedStatus,
        },
      },
    };
    const memoryKey = createUserObservableStateKey({
      publicState,
      policyMemory: memoryChanged,
    });
    expect(memoryKey.policyMemoryHash).not.toBe(base.policyMemoryHash);
    expect(memoryKey.key).not.toBe(base.key);
  });

  it("rejects stale decision memory and user-hand suit contradictions", () => {
    const { publicState, policyMemory } = observableFixture();
    const stale = {
      ...structuredClone(policyMemory),
      decisionOrdinals: {
        ...structuredClone(policyMemory.decisionOrdinals),
        user: policyMemory.decisionOrdinals.user + 1,
      },
    };
    expect(() =>
      createUserObservableStateKey({
        publicState,
        policyMemory: stale,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_OBSERVABLE_STATE",
      } satisfies Partial<AdvancedSearchContractError>),
    );

    const heldSuit = SUITS.find((suit) =>
      publicState.userHand.some((card: Card) => suitOf(card) === suit),
    );
    if (heldSuit === undefined) {
      throw new Error("User fixture unexpectedly has no held suit.");
    }
    const contradictory = {
      ...structuredClone(policyMemory),
      currentSuitStatus: {
        ...structuredClone(policyMemory.currentSuitStatus),
        user: {
          ...structuredClone(policyMemory.currentSuitStatus.user),
          [heldSuit]: "known-void" as const,
        },
      },
    };
    expect(() =>
      createUserObservableStateKey({
        publicState,
        policyMemory: contradictory,
      }),
    ).toThrow(/does not match the user's exact public hand/u);
  });

  it("does not hash irrelevant raw-effect detail once policy memory is fixed", () => {
    const { publicState, policyMemory } = observableFixture();
    const expandedEffects = structuredClone(publicState);
    expandedEffects.effects.push({
      type: "power-changed",
      eventIndex: publicState.appliedEventCount - 1,
      power: publicState.power ?? "user",
    });

    expect(
      createUserObservableStateKey({
        publicState: expandedEffects,
        policyMemory,
      }),
    ).toEqual(
      createUserObservableStateKey({
        publicState,
        policyMemory,
      }),
    );
  });
});
