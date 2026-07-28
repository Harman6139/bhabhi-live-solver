import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createPhase8TerminalConfigurationDescriptor,
  parsePhase8TerminalProductionModel,
  PHASE8_TERMINAL_BEHAVIOR_EXACT_ID,
  PHASE8_TERMINAL_BEHAVIOR_ID,
  PHASE8_TERMINAL_EXACT_ID,
  PHASE8_TERMINAL_REFERENCE_ID,
  preflightPhase8TerminalConfigurations,
} from "../../src/evaluation/phase8-terminal-policy";
import {
  phase8TerminalDescriptors,
  phase8TerminalProductionFixture,
} from "./phase8-terminal-fixtures";

const ALL_CONFIGURATIONS = [
  PHASE8_TERMINAL_REFERENCE_ID,
  PHASE8_TERMINAL_EXACT_ID,
  PHASE8_TERMINAL_BEHAVIOR_ID,
  PHASE8_TERMINAL_BEHAVIOR_EXACT_ID,
] as const;

describe("Phase 8 terminal executable policy contract", () => {
  it("binds every role to exact canonical production-model bytes", () => {
    const model = phase8TerminalProductionFixture();
    const runtime = parsePhase8TerminalProductionModel(model.serialized);
    const configurations = phase8TerminalDescriptors(model, ALL_CONFIGURATIONS);
    const preflight = preflightPhase8TerminalConfigurations({
      configurations,
      manifestModelSha256: model.sha256,
      serializedProductionModel: model.serialized,
    });

    expect(runtime.sha256).toBe(
      createHash("sha256").update(model.serialized, "utf8").digest("hex"),
    );
    expect(preflight.eligible).toBe(true);
    expect(preflight.entries).toHaveLength(4);
    expect(preflight.entries.every((entry) => entry.eligible)).toBe(true);
    expect(
      configurations.find(
        (configuration) =>
          configuration.configId === PHASE8_TERMINAL_BEHAVIOR_ID,
      )?.implementation,
    ).toMatchObject({
      productionModelSha256: model.sha256,
      separateOpponentPriors: true,
      behaviorWorldCount: 16,
      robustChoice: false,
      behaviorFailurePolicy: "refuse",
    });
    expect(() =>
      parsePhase8TerminalProductionModel(model.serialized.trimEnd()),
    ).toThrow(/canonical serialized/u);
  });

  it("refuses before seed use when model bytes or executable options drift", () => {
    const model = phase8TerminalProductionFixture();
    const configurations = phase8TerminalDescriptors(model, ALL_CONFIGURATIONS);
    const wrongHash = preflightPhase8TerminalConfigurations({
      configurations,
      manifestModelSha256: "0".repeat(64),
      serializedProductionModel: model.serialized,
    });

    expect(wrongHash.eligible).toBe(false);
    expect(
      wrongHash.entries.every((entry) =>
        entry.reasons.some((reason) =>
          reason.includes("does not match manifest"),
        ),
      ),
    ).toBe(true);

    const robustModel = phase8TerminalProductionFixture(true);
    const robustConfigurations = phase8TerminalDescriptors(robustModel, [
      PHASE8_TERMINAL_REFERENCE_ID,
      PHASE8_TERMINAL_BEHAVIOR_ID,
    ]);
    const robustPreflight = preflightPhase8TerminalConfigurations({
      configurations: robustConfigurations,
      manifestModelSha256: robustModel.sha256,
      serializedProductionModel: robustModel.serialized,
    });
    expect(robustPreflight.eligible).toBe(false);
    expect(
      robustPreflight.entries.find(
        (entry) => entry.configId === PHASE8_TERMINAL_BEHAVIOR_ID,
      )?.reasons,
    ).toContainEqual(expect.stringContaining("robust-choice"));
  });

  it("requires exactly one reference arm and rejects duplicate routing labels", () => {
    const model = phase8TerminalProductionFixture();
    const reference = createPhase8TerminalConfigurationDescriptor({
      configId: PHASE8_TERMINAL_REFERENCE_ID,
    });
    const preflight = preflightPhase8TerminalConfigurations({
      configurations: [reference, reference],
      manifestModelSha256: model.sha256,
      serializedProductionModel: model.serialized,
    });

    expect(preflight.eligible).toBe(false);
    expect(preflight.entries.flatMap((entry) => entry.reasons)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exactly one R arm"),
        expect.stringContaining("Duplicate configuration ID"),
      ]),
    );
  });
});
