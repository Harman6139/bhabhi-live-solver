import { describe, expect, it } from "vitest";

import { parsePhase8ProductionModelArtifact } from "../../src/modeling/production-model";
import {
  createPhase8PracticalBehaviorModelArtifact,
  parsePhase8PracticalBehaviorModelArtifact,
  phase8PracticalBehaviorModelConfig,
  serializePhase8PracticalBehaviorModelArtifact,
  verifyPhase8PracticalBehaviorModelArtifact,
} from "../../src/modeling/practical-behavior-model";
import { phase8TerminalProductionFixture } from "../evaluation/phase8-terminal-fixtures";

function fixture() {
  const sealed = parsePhase8ProductionModelArtifact(
    phase8TerminalProductionFixture().serialized,
  );
  return createPhase8PracticalBehaviorModelArtifact(sealed.payload.behavior);
}

describe("practical unsealed behavior model", () => {
  it("round-trips a verified selected behavior model without claiming tune evidence", () => {
    const artifact = fixture();
    const serialized = serializePhase8PracticalBehaviorModelArtifact(artifact);
    const parsed = parsePhase8PracticalBehaviorModelArtifact(serialized);
    const config = phase8PracticalBehaviorModelConfig(parsed);

    expect(parsed).toEqual(artifact);
    expect(parsed.payload.caveats).toEqual({
      status: "unsealed-practical",
      purpose: "local-play-only",
      qualificationStatus: "not-qualified",
      releaseSelectedEligible: false,
      claim: "no-support-tune-or-performance-claim",
    });
    expect(config.supportRegularizer.pseudocountPerFeasibleLabel).toBe(1);
    expect(config.worldCount).toBe(
      parsed.payload.behavior.payload.parameters.worldCount,
    );
  });

  it("rejects mutation and noncanonical bytes", () => {
    const artifact = fixture();
    const mutated = structuredClone(artifact);
    Reflect.set(mutated.payload.caveats, "releaseSelectedEligible", true);
    expect(() => verifyPhase8PracticalBehaviorModelArtifact(mutated)).toThrow();
    expect(() =>
      parsePhase8PracticalBehaviorModelArtifact(
        serializePhase8PracticalBehaviorModelArtifact(artifact).trimEnd(),
      ),
    ).toThrow(/canonical/u);
  });
});
