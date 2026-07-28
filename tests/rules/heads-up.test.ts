import { describe, expect, it } from "vitest";

import {
  CANONICAL_RULES,
  type RuleConfig,
  type TwoPlayerMode,
} from "../../src/domain/rule-config";
import type { WasteCardDrawnEvent } from "../../src/events/game-events";
import { applyGameEvent } from "../../src/rules/reducer";
import { makeExactPublicState, playEvent } from "../support/state-builders";

function headsUpRules(twoPlayer: TwoPlayerMode): RuleConfig {
  return {
    ...CANONICAL_RULES,
    twoPlayer,
  };
}

function headsUpState(
  user: Parameters<typeof makeExactPublicState>[0]["hands"]["user"],
  p2: Parameters<typeof makeExactPublicState>[0]["hands"]["p2"],
  twoPlayer: TwoPlayerMode = "pagat-shootout",
) {
  return makeExactPublicState({
    hands: { user, p2, p3: [] },
    activeSeats: ["user", "p2"],
    power: "user",
    rules: headsUpRules(twoPlayer),
  });
}

function completionReason(
  state: ReturnType<typeof headsUpState>,
): string | undefined {
  const effect = state.effects.findLast(
    (candidate) => candidate.type === "game-completed",
  );
  return effect?.type === "game-completed" ? effect.reason : undefined;
}

describe("Pagat-style heads-up shootout", () => {
  it("lets a last-card leader escape when the response is higher", () => {
    let state = headsUpState(["4D"], ["JD", "2C"]);
    state = applyGameEvent(state, playEvent("user", "4D"));
    state = applyGameEvent(state, playEvent("p2", "JD"));

    expect(state.status).toBe("complete");
    expect(state.bhabhi).toBe("p2");
    expect(completionReason(state)).toBe("pagat-higher-response");
  });

  it("requires a prior-waste draw after a lower response with cards remaining", () => {
    let state = headsUpState(["QD"], ["JD", "2C"]);
    state = applyGameEvent(state, playEvent("user", "QD"));
    state = applyGameEvent(state, playEvent("p2", "JD"));

    expect(state.status).toBe("active");
    expect(state.pendingAction).toEqual({
      kind: "waste-draw",
      player: "user",
      excludedTrick: ["QD", "JD"],
      reason: "pagat-shootout",
    });
  });

  it("makes the leader Bhabhi when a lower response is also the responder last card", () => {
    let state = headsUpState(["QD"], ["JD", "2C"]);
    state = applyGameEvent(state, playEvent("user", "QD"));
    state = applyGameEvent(state, playEvent("p2", "JD"));

    const draw: WasteCardDrawnEvent = {
      type: "waste-card-drawn",
      schemaVersion: 1,
      seat: "user",
      card: "3C",
    };
    state = applyGameEvent(state, draw);
    state = applyGameEvent(state, playEvent("user", "3C"));
    state = applyGameEvent(state, playEvent("p2", "2C"));

    expect(state.status).toBe("complete");
    expect(state.bhabhi).toBe("user");
    expect(completionReason(state)).toBe("pagat-lower-last-response");
  });

  it("makes an empty last-card leader Bhabhi on an off-suit response", () => {
    let state = headsUpState(["QD"], ["2C", "4C"]);
    state = applyGameEvent(state, playEvent("user", "QD"));
    state = applyGameEvent(state, playEvent("p2", "2C"));

    expect(state.status).toBe("complete");
    expect(state.bhabhi).toBe("user");
    expect(completionReason(state)).toBe("pagat-off-suit-response");
    expect(state.handCounts.p2).toBe(1);
  });
});

describe("alternative heads-up profiles", () => {
  it("uses ordinary immediate-escape semantics in normal mode", () => {
    const rules: RuleConfig = {
      ...headsUpRules("normal"),
      zeroCardsWithPower: {
        mode: "immediate-escape",
        drawFromTarget: "next-active",
        configuredTarget: null,
      },
    };
    let state = makeExactPublicState({
      hands: { user: ["QD"], p2: ["JD", "2C"], p3: [] },
      activeSeats: ["user", "p2"],
      power: "user",
      rules,
    });
    state = applyGameEvent(state, playEvent("user", "QD"));
    state = applyGameEvent(state, playEvent("p2", "JD"));

    expect(state.status).toBe("complete");
    expect(state.bhabhi).toBe("p2");
    expect(completionReason(state)).toBe("last-active");
  });

  it("supports the separately named simplified thulla shortcut", () => {
    let state = headsUpState(
      ["QD", "5H"],
      ["2C", "4C"],
      "simplified-thulla-wins",
    );
    state = applyGameEvent(state, playEvent("user", "QD"));
    state = applyGameEvent(state, playEvent("p2", "2C"));

    expect(state.status).toBe("complete");
    expect(state.bhabhi).toBe("user");
    expect(completionReason(state)).toBe("simplified-thulla");
  });
});
