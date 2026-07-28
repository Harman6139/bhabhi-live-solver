import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPhase8TerminalArtifactSession,
  verifyPhase8TerminalArtifacts,
} from "../../src/evaluation/phase8-terminal-artifacts";
import {
  PHASE8_TERMINAL_BEHAVIOR_ID,
  PHASE8_TERMINAL_REFERENCE_ID,
} from "../../src/evaluation/phase8-terminal-policy";
import {
  createPhase8TerminalDevelopmentPlan,
  runPhase8TerminalMatrix,
} from "../../src/evaluation/phase8-terminal-runner";
import {
  phase8TerminalDescriptors,
  phase8TerminalHashBundle,
  phase8TerminalProductionFixture,
} from "./phase8-terminal-fixtures";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Phase 8 terminal immutable artifacts", () => {
  it("publishes and verifies an evidence-ineligible preflight refusal once", async () => {
    const root = await mkdtemp(join(tmpdir(), "bhabhi-phase8-terminal-"));
    temporaryRoots.push(root);
    const model = phase8TerminalProductionFixture(true);
    const configurations = phase8TerminalDescriptors(model, [
      PHASE8_TERMINAL_REFERENCE_ID,
      PHASE8_TERMINAL_BEHAVIOR_ID,
    ]);
    const plan = createPhase8TerminalDevelopmentPlan({
      runId: "terminal-preflight-refusal",
      baseCount: 1,
      configurations,
      hashes: phase8TerminalHashBundle({
        modelSha256: model.sha256,
        configurations,
      }),
      disclosureAuthoritySha256: "3".repeat(64),
    });
    const session = await createPhase8TerminalArtifactSession({
      rootDirectory: root,
      plan,
      serializedProductionModel: model.serialized,
      environment: {
        node: process.version,
        fixture: "terminal-preflight-refusal",
      },
      command: "phase8-terminal-test --dev --base-count 1",
      createdAt: "2026-07-28T12:00:00.000Z",
    });
    const result = await runPhase8TerminalMatrix({
      plan,
      serializedProductionModel: model.serialized,
      sink: session.sink,
    });
    const verification = await session.finalize(result);

    expect(result.started).toBe(false);
    expect(verification.ok).toBe(true);
    expect(verification.failures).toEqual([]);
    expect(verification.summary).toMatchObject({
      evidenceClass: "phase8-terminal-development-pilot",
      split: "dev",
      componentRoutingGate: false,
      seedCoverageGate: false,
      zeroSilentExclusionGate: false,
      preflightEligibleForQualification: false,
      evidenceGate: false,
    });
    await expect(
      createPhase8TerminalArtifactSession({
        rootDirectory: root,
        plan,
        serializedProductionModel: model.serialized,
        environment: { fixture: "duplicate" },
        command: "duplicate",
        createdAt: "2026-07-28T12:00:01.000Z",
      }),
    ).rejects.toThrow(/Refusing to overwrite/u);

    await appendFile(
      join(session.runDirectory, "summary.md"),
      "tampered\n",
      "utf8",
    );
    const tampered = await verifyPhase8TerminalArtifacts(session.runDirectory);
    expect(tampered.ok).toBe(false);
    expect(tampered.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("summary.md checksum mismatch"),
        expect.stringContaining("summary.md does not regenerate"),
      ]),
    );
  });
});
