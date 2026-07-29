import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { FITTABLE_STYLE_CELL_IDS } from "../src/calibration/protocol";
import { captureSourceSnapshot } from "../src/evaluation/artifacts";
import {
  createPhase8ConfigurationDescriptor,
  freezePhase8Manifest,
  openPhase8Split,
  phase8Sha256,
} from "../src/evaluation/phase8-manifest";
import { stableStringify } from "../src/events/stable-hash";
import { readSelectedBehaviorModelArtifact } from "../src/modeling/artifact-store";
import { serializeSelectedBehaviorModelArtifact } from "../src/modeling/behavior-fit";
import {
  createPhase8SupportTunePlan,
  runPhase8SupportTune,
} from "../src/modeling/support-tune";

type Options = Readonly<{
  behaviorModel: string;
  output: string;
  runId: string;
  styleCellId: string;
  baseIndexStart: number;
  baseCount: number;
}>;

function valueAfter(
  argv: readonly string[],
  index: number,
  name: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function integer(value: string, name: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum.toString()}.`);
  }
  return parsed;
}

function parseArguments(argv: readonly string[]): Options {
  let behaviorModel: string | null = null;
  let output: string | null = null;
  let runId: string | null = null;
  let styleCellId: string | null = null;
  let baseIndexStart: number | null = null;
  let baseCount: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--behavior-model":
        behaviorModel = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--output":
        output = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--run-id":
        runId = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--style-cell":
        styleCellId = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--base-index-start":
        baseIndexStart = integer(
          valueAfter(argv, index, argument),
          argument,
          0,
        );
        index += 1;
        break;
      case "--base-count":
        baseCount = integer(
          valueAfter(argv, index, argument),
          argument,
          1,
        );
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument ${argument ?? "<missing>"}.`);
    }
  }
  if (
    behaviorModel === null ||
    output === null ||
    runId === null ||
    styleCellId === null ||
    baseIndexStart === null ||
    baseCount === null
  ) {
    throw new Error(
      "Usage: tsx scripts/run-phase8-support-tune-shard.ts --behavior-model <selected-model.json> --output <new-directory> --run-id <id> --style-cell <id> --base-index-start <n> --base-count <n>",
    );
  }
  if (
    !FITTABLE_STYLE_CELL_IDS.includes(styleCellId) ||
    baseIndexStart + baseCount > 64
  ) {
    throw new Error("Support-tune shard is outside the 64×15 tune schedule.");
  }
  return {
    behaviorModel,
    output,
    runId,
    styleCellId,
    baseIndexStart,
    baseCount,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const source = await captureSourceSnapshot(resolve("."));
  const behaviorModel = await readSelectedBehaviorModelArtifact(
    resolve(options.behaviorModel),
  );
  const serializedBehaviorModel =
    serializeSelectedBehaviorModelArtifact(behaviorModel);
  if (
    source.gitDirty ||
    source.gitCommit === null ||
    source.sourceSnapshotSha256 !== behaviorModel.payload.sourceHash
  ) {
    throw new Error(
      "Support tuning must run from the same clean source snapshot that generated the selected behavior model.",
    );
  }

  const authority = freezePhase8Manifest({
    manifestId: `phase8-b-be-support-tune-${behaviorModel.payloadChecksum.slice(-16)}`,
    createdAt: "2026-07-29T00:00:00.000Z",
    sourceSha256: source.sourceSnapshotSha256,
    sourceFileCount: source.sourceFileCount,
    modelSha256: sha256(serializedBehaviorModel),
    scorerSha256: phase8Sha256({ purpose: "b-be-support-tune-scorer" }),
    reportSha256: phase8Sha256({ purpose: "b-be-support-tune-report" }),
    preregistrationSha256: phase8Sha256({
      purpose: "b-be-practical-training-contract",
    }),
    configurations: [
      createPhase8ConfigurationDescriptor({
        configId: "p8-r-hard-balanced-v1",
        label: "Hard-only reference",
        role: "reference",
        budgetId: "balanced",
        components: {
          exactEndgame: false,
          behaviorWeighting: false,
        },
        implementation: { executionPath: "phase8-terminal-reference" },
      }),
      createPhase8ConfigurationDescriptor({
        configId: "p8-b-behavior-balanced-v1",
        label: "Behavior-weighted candidate",
        role: "candidate",
        budgetId: "balanced",
        components: {
          exactEndgame: false,
          behaviorWeighting: true,
        },
        implementation: { executionPath: "phase8-terminal-behavior" },
      }),
    ],
    splits: {
      train: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      tune: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      qualification: { baseIndexStart: 0, eventCap: 4_096 },
    },
    qualificationSampleSize: {
      verifiedDevelopmentVarianceArtifactSha256: phase8Sha256({
        purpose: "practical-qualification-sizing-placeholder",
      }),
      maxPairedClusterStandardDeviation: 0,
    },
  });
  const opening = openPhase8Split(authority, {
    split: "tune",
    proof: {
      kind: "development",
      disclosureAuthoritySha256: phase8Sha256({
        purpose: "b-be-support-tune-disclosure",
      }),
    },
  });
  const plan = createPhase8SupportTunePlan({
    tuneAuthority: authority,
    opening,
    behaviorModel,
    source,
    runId: options.runId,
    mode: "evidence",
  });
  const startedAt = performance.now();
  const run = runPhase8SupportTune({
    tuneAuthority: authority,
    opening,
    plan,
    behaviorModel,
    scheduleSlice: {
      styleCellId: options.styleCellId,
      baseIndexStart: options.baseIndexStart,
      baseCount: options.baseCount,
    },
  });
  if (
    run.games.length !== options.baseCount * 3 ||
    run.selection !== null
  ) {
    throw new Error("Partial support-tune run has an invalid envelope.");
  }
  const projection = {
    schemaVersion: 1 as const,
    artifactKind: "phase8-support-tune-shard-v1" as const,
    source,
    plan,
    selectedBehaviorModelSha256: sha256(serializedBehaviorModel),
    selectedBehaviorPayloadChecksum: behaviorModel.payloadChecksum,
    shard: {
      styleCellId: options.styleCellId,
      baseIndexStart: options.baseIndexStart,
      baseCount: options.baseCount,
      rotations: [0, 1, 2] as const,
    },
    games: run.games,
    observations: run.observations,
    runFailureCount: run.integrity.runFailureCount,
  };
  const artifact = {
    ...projection,
    artifactSha256: phase8Sha256(projection),
  };
  const payload = `${stableStringify(artifact)}\n`;
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { recursive: false });
  await writeFile(resolve(output, "shard.json"), payload, {
    encoding: "utf8",
    flag: "wx",
  });
  await writeFile(
    resolve(output, "checksums.sha256"),
    `${sha256(payload)}  shard.json\n`,
    { encoding: "utf8", flag: "wx" },
  );
  console.log(
    JSON.stringify({
      output,
      styleCellId: options.styleCellId,
      baseIndexStart: options.baseIndexStart,
      baseCount: options.baseCount,
      games: run.games.length,
      observations: run.observations.length,
      runFailureCount: run.integrity.runFailureCount,
      artifactSha256: artifact.artifactSha256,
      elapsedMs: performance.now() - startedAt,
    }),
  );
}

await main();
