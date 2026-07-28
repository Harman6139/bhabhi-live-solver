import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureEnvironment,
  verifyEvaluationArtifacts,
  writeEvaluationArtifacts,
} from "../../src/evaluation/artifacts";
import {
  decisionArtifactRecordSchema,
  environmentArtifactSchema,
  evaluationManifestSchema,
  evaluationSummarySchema,
  failureArtifactRecordSchema,
  gameArtifactRecordSchema,
  seedArtifactRecordSchema,
  truthArtifactRecordSchema,
} from "../../src/evaluation/artifact-schema";
import { runBatch, type BatchRunResult } from "../../src/evaluation/batch";
import {
  createPhase4SmokePlan,
  type BatchPlan,
} from "../../src/evaluation/protocol";

const REQUIRED_ARTIFACT_FILES = [
  "calibration-predictions.ndjson",
  "checksums.sha256",
  "command.txt",
  "decisions.ndjson",
  "environment.json",
  "failures.ndjson",
  "games.ndjson",
  "latency.ndjson",
  "logs/run.log",
  "manifest.json",
  "seeds.ndjson",
  "summary.json",
  "summary.md",
  "truth.eval-only.ndjson",
] as const;

const FIXED_CREATED_AT = "2026-07-27T22:00:00.000Z";
const COMMAND = "npm run eval:phase4 -- --run phase4-artifact-test";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

function tinyPlan(runId: string): BatchPlan {
  return {
    ...createPhase4SmokePlan(runId, 1),
    userPolicyIds: ["always-low"],
    styleCellIds: ["c01_random__random"],
    rotations: [0],
    replicates: [0],
  };
}

function parseNdjson(text: string): unknown[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function recursiveRelativeFiles(
  root: string,
  prefix = "",
): Promise<string[]> {
  const directory = join(root, prefix);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath =
      prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await recursiveRelativeFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function parseChecksums(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    expect(match, `malformed checksum line: ${line}`).not.toBeNull();
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1]);
    }
  }
  return checksums;
}

async function makeArtifactRun(runId: string): Promise<{
  readonly root: string;
  readonly protocolPlanPath: string;
  readonly result: BatchRunResult;
  readonly runDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bhabhi-artifact-test-"));
  temporaryRoots.push(root);
  const protocolPlanPath = join(root, "evaluation-plan.md");
  await writeFile(
    protocolPlanPath,
    "# Frozen test protocol\n\nPhase 4 artifact fixture.\n",
    "utf8",
  );
  const result = runBatch(tinyPlan(runId));
  expect(result.failures).toEqual([]);
  expect(result.games).toHaveLength(1);
  const written = await writeEvaluationArtifacts(result, {
    artifactRoot: join(root, "artifacts"),
    protocolPlanPath,
    command: COMMAND,
    createdAt: FIXED_CREATED_AT,
    environment: captureEnvironment(
      FIXED_CREATED_AT,
      "test-fixture-power-mode",
    ),
  });
  return {
    root,
    protocolPlanPath,
    result,
    runDirectory: written.runDirectory,
  };
}

describe("evaluation artifact writer and verifier", () => {
  it("writes the complete schema-valid artifact contract with independently valid checksums", async () => {
    const fixture = await makeArtifactRun("phase4-artifact-contract");
    const files = await recursiveRelativeFiles(fixture.runDirectory);

    expect(files).toEqual([...REQUIRED_ARTIFACT_FILES]);

    const manifest = evaluationManifestSchema.parse(
      JSON.parse(
        await readFile(join(fixture.runDirectory, "manifest.json"), "utf8"),
      ) as unknown,
    );
    const environment = environmentArtifactSchema.parse(
      JSON.parse(
        await readFile(join(fixture.runDirectory, "environment.json"), "utf8"),
      ) as unknown,
    );
    const summary = evaluationSummarySchema.parse(
      JSON.parse(
        await readFile(join(fixture.runDirectory, "summary.json"), "utf8"),
      ) as unknown,
    );
    const seeds = seedArtifactRecordSchema
      .array()
      .parse(
        parseNdjson(
          await readFile(join(fixture.runDirectory, "seeds.ndjson"), "utf8"),
        ),
      );
    const games = gameArtifactRecordSchema
      .array()
      .parse(
        parseNdjson(
          await readFile(join(fixture.runDirectory, "games.ndjson"), "utf8"),
        ),
      );
    const decisions = decisionArtifactRecordSchema
      .array()
      .parse(
        parseNdjson(
          await readFile(
            join(fixture.runDirectory, "decisions.ndjson"),
            "utf8",
          ),
        ),
      );
    const truths = truthArtifactRecordSchema
      .array()
      .parse(
        parseNdjson(
          await readFile(
            join(fixture.runDirectory, "truth.eval-only.ndjson"),
            "utf8",
          ),
        ),
      );
    const failures = failureArtifactRecordSchema
      .array()
      .parse(
        parseNdjson(
          await readFile(join(fixture.runDirectory, "failures.ndjson"), "utf8"),
        ),
      );

    expect(manifest).toMatchObject({
      runId: "phase4-artifact-contract",
      expectedGames: 1,
      evidenceEligible: false,
      createdAt: FIXED_CREATED_AT,
      command: COMMAND,
    });
    expect(environment).toMatchObject({
      capturedAt: FIXED_CREATED_AT,
      powerMode: "test-fixture-power-mode",
      workerCount: 1,
    });
    expect(summary).toEqual(fixture.result.summary);
    expect(seeds).toEqual(fixture.result.seeds);
    expect(games).toEqual(fixture.result.games);
    expect(decisions).toEqual(fixture.result.decisions);
    expect(decisions.length).toBeGreaterThan(0);
    expect(truths).toEqual(fixture.result.truths);
    expect(failures).toEqual([]);
    expect(
      await readFile(
        join(fixture.runDirectory, "calibration-predictions.ndjson"),
        "utf8",
      ),
    ).toBe("");
    expect(
      await readFile(join(fixture.runDirectory, "latency.ndjson"), "utf8"),
    ).toBe("");

    const checksumManifest = parseChecksums(
      await readFile(join(fixture.runDirectory, "checksums.sha256"), "utf8"),
    );
    expect([...checksumManifest.keys()].sort()).toEqual(
      REQUIRED_ARTIFACT_FILES.filter((file) => file !== "checksums.sha256"),
    );
    for (const [relativePath, expectedDigest] of checksumManifest) {
      const bytes = await readFile(join(fixture.runDirectory, relativePath));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        expectedDigest,
      );
    }
  });

  it("replays public history and eval-only truth and regenerates the summary", async () => {
    const fixture = await makeArtifactRun("phase4-artifact-replay");

    const verification = await verifyEvaluationArtifacts(fixture.runDirectory);

    expect(verification).toEqual({
      valid: true,
      runDirectory: fixture.runDirectory,
      checkedFiles: REQUIRED_ARTIFACT_FILES.length - 1,
      gamesReplayed: 1,
      decisionsValidated: fixture.result.decisions.length,
      failures: [],
      reproductionDigest: fixture.result.summary.reproductionDigest,
    });
  });

  it("refuses to overwrite an existing run directory without changing it", async () => {
    const fixture = await makeArtifactRun("phase4-artifact-immutable");
    const checksumsPath = join(fixture.runDirectory, "checksums.sha256");
    const beforeChecksums = await readFile(checksumsPath, "utf8");
    const beforeFiles = await recursiveRelativeFiles(fixture.runDirectory);

    await expect(
      writeEvaluationArtifacts(fixture.result, {
        artifactRoot: join(fixture.root, "artifacts"),
        protocolPlanPath: fixture.protocolPlanPath,
        command: "a different command must not replace the run",
        createdAt: "2026-07-27T23:00:00.000Z",
      }),
    ).rejects.toThrow(/artifact run directory already exists/iu);

    expect(await recursiveRelativeFiles(fixture.runDirectory)).toEqual(
      beforeFiles,
    );
    expect(await readFile(checksumsPath, "utf8")).toBe(beforeChecksums);
    expect(
      await readFile(join(fixture.runDirectory, "command.txt"), "utf8"),
    ).toBe(`${COMMAND}\n`);
  });

  it("detects a checksummed artifact tamper and a summary disagreement", async () => {
    const fixture = await makeArtifactRun("phase4-artifact-tamper");
    const summaryPath = join(fixture.runDirectory, "summary.json");
    const tamperedSummary = JSON.parse(
      await readFile(summaryPath, "utf8"),
    ) as Record<string, unknown>;
    tamperedSummary.completedGames = 0;
    await writeFile(
      summaryPath,
      `${JSON.stringify(tamperedSummary)}\n`,
      "utf8",
    );
    await appendFile(
      join(fixture.runDirectory, "logs", "run.log"),
      "tampered=true\n",
      "utf8",
    );

    const verification = await verifyEvaluationArtifacts(fixture.runDirectory);

    expect(verification.valid).toBe(false);
    expect(verification.gamesReplayed).toBe(1);
    expect(verification.failures).toEqual(
      expect.arrayContaining([
        "Checksum mismatch for logs/run.log.",
        "Checksum mismatch for summary.json.",
        "summary.json does not match regeneration from raw records.",
      ]),
    );
  });
});
