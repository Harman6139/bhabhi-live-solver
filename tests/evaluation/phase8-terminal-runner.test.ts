import { createHash } from "node:crypto";
import { once } from "node:events";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import {
  createPhase8HardOnlyModel,
  serializePhase8HardOnlyModel,
} from "../../src/modeling/hard-only-model";
import {
  parsePhase8TerminalProductionModel,
  preflightPhase8TerminalConfigurations,
  PHASE8_TERMINAL_BEHAVIOR_ID,
  PHASE8_TERMINAL_REFERENCE_ID,
} from "../../src/evaluation/phase8-terminal-policy";
import {
  createInMemoryPhase8TerminalSink,
  createPhase8TerminalDevelopmentPlan,
  derivePhase8TerminalScenarioSeeds,
  runPhase8TerminalMatrix,
  runPhase8TerminalScenario,
} from "../../src/evaluation/phase8-terminal-runner";
import { createSeededDeal } from "../../src/simulator/game";
import {
  phase8TerminalDescriptors,
  phase8TerminalHashBundle,
  phase8TerminalProductionFixture,
} from "./phase8-terminal-fixtures";

function developmentPlan(input: {
  readonly robustChoice?: boolean;
  readonly configIds?: readonly (
    typeof PHASE8_TERMINAL_REFERENCE_ID | typeof PHASE8_TERMINAL_BEHAVIOR_ID
  )[];
  readonly baseCount?: number;
}) {
  const model = phase8TerminalProductionFixture(input.robustChoice ?? false);
  const configurations = phase8TerminalDescriptors(
    model,
    input.configIds ?? [PHASE8_TERMINAL_REFERENCE_ID],
  );
  return {
    model,
    configurations,
    plan: createPhase8TerminalDevelopmentPlan({
      runId: "phase8-terminal-dev-test",
      baseCount: input.baseCount ?? 1,
      configurations,
      hashes: phase8TerminalHashBundle({
        modelSha256: model.sha256,
        configurations,
      }),
      disclosureAuthoritySha256: "2".repeat(64),
    }),
  };
}

describe("Phase 8 terminal development and seed protocol", () => {
  it("keeps public solver chance style-neutral and environment chance style-dependent", () => {
    const { plan } = developmentPlan({});
    const first = derivePhase8TerminalScenarioSeeds(plan, {
      styleCellId: "c01_random__random",
      baseIndex: 0,
      rotation: 1,
    });
    const second = derivePhase8TerminalScenarioSeeds(plan, {
      styleCellId: "c02_always-high__always-high",
      baseIndex: 0,
      rotation: 1,
    });

    expect(plan).toMatchObject({
      authorityKind: "development-pilot",
      split: "dev",
      evidenceClass: "phase8-terminal-development-pilot",
      evidenceEligible: false,
      expectedScenarios: 51,
      expectedGames: 51,
    });
    expect(first.record.deal).toBe(second.record.deal);
    expect(first.record.userPolicy).toBe(second.record.userPolicy);
    expect(first.record.belief).toBe(second.record.belief);
    expect(first.record.search).toBe(second.record.search);
    expect(first.record.rollout).toBe(second.record.rollout);
    expect(first.record.solverChance).toBe(second.record.solverChance);
    expect(first.record.bootstrap).toBe(second.record.bootstrap);
    expect(first.record.environmentChance).not.toBe(
      second.record.environmentChance,
    );
    expect(first.solver.chance).toBe(first.record.solverChance);
    expect(first.simulator.chance).toBe(first.record.environmentChance);
  });

  it("caps configurable pilot sizing at 512 bases", () => {
    expect(developmentPlan({ baseCount: 512 }).plan.baseCount).toBe(512);
    expect(() => developmentPlan({ baseCount: 513 })).toThrow(/1 through 512/u);
  });

  it("records executable preflight refusal without deriving any seed", async () => {
    const { model, plan } = developmentPlan({
      robustChoice: true,
      configIds: [PHASE8_TERMINAL_REFERENCE_ID, PHASE8_TERMINAL_BEHAVIOR_ID],
    });
    const sink = createInMemoryPhase8TerminalSink();
    const result = await runPhase8TerminalMatrix({
      plan,
      serializedProductionModel: model.serialized,
      sink,
    });

    expect(result.started).toBe(false);
    expect(result.preflight.eligible).toBe(false);
    expect(result.attemptedGames).toBe(0);
    expect(sink.componentAudits).toHaveLength(2);
    expect(sink.seeds).toHaveLength(0);
    expect(sink.summaryInputs).toHaveLength(0);
  });

  it("routes a complete development game through the real hard-only reference", () => {
    const { model, configurations, plan } = developmentPlan({});
    const descriptor = configurations[0];
    const styleCell = plan.styleCells[0];
    if (descriptor === undefined || styleCell === undefined) {
      throw new Error("Terminal fixture omitted its first matrix cell.");
    }
    const seeds = derivePhase8TerminalScenarioSeeds(plan, {
      styleCellId: styleCell.id,
      baseIndex: 0,
      rotation: 0,
    });
    const result = runPhase8TerminalScenario({
      plan,
      descriptor,
      model: parsePhase8TerminalProductionModel(model.serialized),
      styleCell,
      baseIndex: 0,
      rotation: 0,
      deal: createSeededDeal(seeds.simulator.deal, 0),
      seeds,
    });

    expect(result.failure).toBeNull();
    expect(result.game?.completionStatus).toBe("complete");
    expect(result.truth?.recordType).toBe("phase8-terminal-truth-eval-only");
    expect(result.summaryInput.status).toBe("complete");
    expect(result.decisions.length).toBeGreaterThan(0);
    expect(
      result.decisions.every(
        (decision) =>
          decision.method === "phase5-hard-only" &&
          decision.exact.outcome === "not-attempted" &&
          decision.behavior.outcome === "not-attempted",
      ),
    ).toBe(true);
  }, 30_000);

  it("runs the reference with an explicit model-not-applicable artifact", () => {
    const serialized = serializePhase8HardOnlyModel(
      createPhase8HardOnlyModel("a".repeat(64)),
    );
    const configurations = phase8TerminalDescriptors(
      phase8TerminalProductionFixture(),
      [PHASE8_TERMINAL_REFERENCE_ID],
    );
    const preflight = preflightPhase8TerminalConfigurations({
      configurations,
      manifestModelSha256: createHash("sha256")
        .update(serialized, "utf8")
        .digest("hex"),
      serializedProductionModel: serialized,
    });

    expect(preflight).toMatchObject({
      eligible: true,
      productionModel: null,
      entries: [{ configId: PHASE8_TERMINAL_REFERENCE_ID, eligible: true }],
    });
  });

  it("executes a terminal scenario in the production worker-thread pool entry", async () => {
    const { model, configurations, plan } = developmentPlan({});
    const descriptor = configurations[0];
    const styleCell = plan.styleCells[0];
    if (descriptor === undefined || styleCell === undefined) {
      throw new Error("Terminal worker fixture omitted its first matrix cell.");
    }
    const seeds = derivePhase8TerminalScenarioSeeds(plan, {
      styleCellId: styleCell.id,
      baseIndex: 0,
      rotation: 0,
    });
    const worker = new Worker(
      new URL(
        "../../scripts/phase8-terminal-worker-bootstrap.mjs",
        import.meta.url,
      ),
    );
    try {
      worker.postMessage({
        id: 1,
        scenario: {
          plan,
          descriptor,
          model: parsePhase8TerminalProductionModel(model.serialized),
          styleCell,
          baseIndex: 0,
          rotation: 0,
          deal: createSeededDeal(seeds.simulator.deal, 0),
          seeds,
        },
      });
      const [message] = (await once(worker, "message")) as [
        {
          readonly ok: boolean;
          readonly result?: {
            readonly game: { readonly completionStatus: string };
          };
          readonly error?: unknown;
        },
      ];
      expect(message.error).toBeUndefined();
      expect(message).toMatchObject({
        ok: true,
        result: { game: { completionStatus: "complete" } },
      });
    } finally {
      await worker.terminate();
    }
  }, 30_000);
});
