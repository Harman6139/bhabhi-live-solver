import type { Card } from "../domain/cards";
import type { Seat } from "../domain/seats";
import type { GameEvent } from "../events/game-events";
import type { GameTimeline } from "../events/timeline";
import type { PolicyObservation } from "../agents/policies";

/**
 * Scenario-level solver streams supplied by an evaluation protocol.
 *
 * Simulation deal and opponent-policy seeds are intentionally absent. The
 * user policy receives only the streams a production timeline solver may use.
 */
export type ScenarioSolverSeedSet = {
  readonly belief: string;
  readonly search: string;
  readonly rollout: string;
  readonly chance: string;
  readonly bootstrap: string;
};

export type EvaluationUserTimelinePolicyAction =
  | {
      readonly kind: "play-card";
      readonly card: Card;
      readonly rationale: string;
    }
  | {
      readonly kind: "take-hand";
      readonly target: Seat;
      readonly rationale: string;
    };

/**
 * The complete invocation boundary for an evaluation-only user policy.
 *
 * No concrete deal, opponent hand, SimulationTruth, or mutable simulator
 * object is reachable from this value. The simulator builds a detached,
 * deeply frozen copy for every user decision.
 */
export type EvaluationUserTimelinePolicyInput = {
  readonly timeline: GameTimeline;
  readonly observation: PolicyObservation;
  readonly solverSeeds: ScenarioSolverSeedSet;
};

export type EvaluationUserTimelinePolicy = {
  readonly id: string;
  readonly version: 1;
  chooseAction(
    input: EvaluationUserTimelinePolicyInput,
  ): EvaluationUserTimelinePolicyAction;
};

/**
 * A zero-argument per-game factory lets an evaluation runner retain its own
 * decision audits without giving the policy any simulator context.
 */
export type EvaluationUserTimelinePolicyConfig = {
  readonly solverSeeds: ScenarioSolverSeedSet;
  readonly createPolicy: () => EvaluationUserTimelinePolicy;
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Project the simulator event prefix onto facts available to the live user.
 *
 * A draw between opponents is private at the draw event. The reducer makes
 * that card the recipient's forced lead, so it becomes public on the
 * immediately following card-played event before another player can act. An
 * unresolved private draw is rejected rather than copied to the callback.
 */
export function projectActiveSimulationTimelineForUser(
  events: readonly GameEvent[],
): GameTimeline {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (
      event?.type === "player-card-drawn" &&
      event.seat !== "user" &&
      event.source !== "user"
    ) {
      const publicReveal = events[index + 1];
      if (
        publicReveal?.type !== "card-played" ||
        publicReveal.seat !== event.seat ||
        publicReveal.card !== event.card
      ) {
        throw new Error(
          "Evaluation user timeline withheld an unresolved private opponent draw.",
        );
      }
    }
    if (
      event?.type === "hand-taken" &&
      event.actor !== "user" &&
      event.target !== "user" &&
      event.revealedCards.length > 0
    ) {
      throw new Error(
        "Evaluation user timeline withheld a private opponent hand reveal.",
      );
    }
  }
  return deepFreeze(
    structuredClone({
      schemaVersion: 1,
      events,
      cursor: events.length,
      orphanedEvents: [],
    }),
  );
}

export function createEvaluationUserTimelinePolicyInput(
  input: EvaluationUserTimelinePolicyInput,
): EvaluationUserTimelinePolicyInput {
  if (
    input.timeline.cursor !== input.timeline.events.length ||
    input.timeline.orphanedEvents.length !== 0
  ) {
    throw new Error(
      "Evaluation user policies require a fully active timeline with no redo or orphan tail.",
    );
  }
  if (
    input.observation.seat !== "user" ||
    input.observation.status !== "active" ||
    input.observation.turn !== "user"
  ) {
    throw new Error(
      "Evaluation user policies may be invoked only for an active user turn.",
    );
  }
  return deepFreeze(structuredClone(input));
}
