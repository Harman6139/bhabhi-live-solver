import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { StrategyCommandRecord } from "../../src/strategy/evidence";
import {
  createPhase6StrategyEvidenceBundle,
  phase6RequiredStrategyTestPaths,
} from "../../src/strategy/phase6-evidence";
import {
  rawStrategyTestResultChecksum,
  verifyStrategyEvidenceRun,
  writeImmutableStrategyEvidenceRun,
  type RawStrategyTestResult,
} from "../../scripts/strategy-evidence-artifact-store";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bhabhi-strategy-evidence-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function fixture() {
  const argv = [
    process.execPath,
    "node_modules/vitest/vitest.mjs",
    "run",
    ...phase6RequiredStrategyTestPaths(),
    "--reporter=json",
  ];
  const rawTestResult: RawStrategyTestResult = {
    schemaVersion: 1,
    commandId: "command/phase6-required-strategy-tests",
    argv,
    exitCode: 0,
    signal: null,
    stdout: '{"success":true}',
    stderr: "",
  };
  const command: StrategyCommandRecord = {
    commandId: rawTestResult.commandId,
    argv,
    workingDirectory: ".",
    sourceRevision: "sha256:source-fixture",
    environmentChecksum: "sha256:environment-fixture",
    exitCode: 0,
  };
  return {
    rawTestResult,
    bundle: createPhase6StrategyEvidenceBundle({
      command,
      resultChecksum: rawStrategyTestResultChecksum(rawTestResult),
    }),
  };
}

describe("immutable Phase 6 strategy evidence artifacts", () => {
  it("writes once, verifies every link, and keeps Phase 7 deferrals out of final mode", async () => {
    const root = await temporaryRoot();
    const input = fixture();
    const run = await writeImmutableStrategyEvidenceRun({
      outputRoot: root,
      runId: "phase6-fixture",
      evidenceClass: "development",
      sourceRevision: "sha256:source-fixture",
      ...input,
    });

    const phase6 = await verifyStrategyEvidenceRun(run, { mode: "phase6" });
    expect(phase6).toMatchObject({
      ok: true,
      issues: [],
      summary: {
        dispositionCounts: {
          retainedRequired: 26,
          deferredPhase7: 22,
        },
        requiredDirectPassingCount: 26,
        enabledProductionFeatureCount: 0,
      },
    });

    const final = await verifyStrategyEvidenceRun(run, { mode: "final" });
    expect(final.ok).toBe(false);
    expect(final.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("M39"),
        expect.stringContaining("M40"),
      ]),
    );

    await expect(
      writeImmutableStrategyEvidenceRun({
        outputRoot: root,
        runId: "phase6-fixture",
        evidenceClass: "development",
        sourceRevision: "sha256:source-fixture",
        ...input,
      }),
    ).rejects.toThrow(/already exists/u);
  });

  it("detects byte-level and payload-level tampering", async () => {
    const root = await temporaryRoot();
    const input = fixture();
    const run = await writeImmutableStrategyEvidenceRun({
      outputRoot: root,
      runId: "tamper-fixture",
      evidenceClass: "development",
      sourceRevision: "sha256:source-fixture",
      ...input,
    });
    const summaryPath = join(run, "summary.json");
    const summary = await readFile(summaryPath, "utf8");
    await writeFile(
      summaryPath,
      summary.replace(
        '"requiredDirectPassingCount": 26',
        '"requiredDirectPassingCount": 25',
      ),
      "utf8",
    );

    const verification = await verifyStrategyEvidenceRun(run);
    expect(verification.ok).toBe(false);
    expect(verification.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SHA-256"),
        expect.stringContaining("payload checksum"),
      ]),
    );
  });
});
