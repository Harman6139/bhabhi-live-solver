import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { FITTABLE_STYLE_CELL_IDS } from "../src/calibration/protocol";
import type { SourceSnapshot } from "../src/evaluation/artifacts";
import { phase8Sha256 } from "../src/evaluation/phase8-manifest";
import { stableStringify } from "../src/events/stable-hash";
import {
  readSelectedBehaviorModelArtifact,
  writePhase8ProductionModelArtifact,
} from "../src/modeling/artifact-store";
import {
  serializeSelectedBehaviorModelArtifact,
  type SelectedBehaviorModelArtifact,
} from "../src/modeling/behavior-fit";
import {
  createPhase8ProductionModelArtifact,
  createPhase8SupportRegularizerTuneSelection,
} from "../src/modeling/production-model";
import { writePhase8SupportTuneArtifact } from "../src/modeling/support-tune-artifact";
import {
  phase8SupportTuneEvidenceSha256,
  scorePhase8SupportTuneCandidates,
  verifyPhase8SupportTuneGameRecord,
  verifyPhase8SupportTuneObservationRecord,
  verifyPhase8SupportTunePlan,
  type Phase8SupportTuneGameRecord,
  type Phase8SupportTuneObservationRecord,
  type Phase8SupportTunePlan,
  type Phase8SupportTuneRunResult,
} from "../src/modeling/support-tune";

type Options = Readonly<{
  inputRoot: string;
  behaviorModel: string;
  supportOutput: string;
  modelOutput: string;
}>;

type SupportTuneShard = Readonly<{
  schemaVersion: 1;
  artifactKind: "phase8-support-tune-shard-v1";
  source: SourceSnapshot;
  plan: Phase8SupportTunePlan;
  selectedBehaviorModelSha256: string;
  selectedBehaviorPayloadChecksum: string;
  shard: Readonly<{
    styleCellId: string;
    baseIndexStart: number;
    baseCount: number;
    rotations: readonly [0, 1, 2];
  }>;
  games: readonly Phase8SupportTuneGameRecord[];
  observations: readonly Phase8SupportTuneObservationRecord[];
  runFailureCount: number;
  artifactSha256: string;
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

function parseArguments(argv: readonly string[]): Options {
  let inputRoot: string | null = null;
  let behaviorModel: string | null = null;
  let supportOutput: string | null = null;
  let modelOutput: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--input-root":
        inputRoot = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--behavior-model":
        behaviorModel = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--support-output":
        supportOutput = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--model-output":
        modelOutput = valueAfter(argv, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument ${argument ?? "<missing>"}.`);
    }
  }
  if (
    inputRoot === null ||
    behaviorModel === null ||
    supportOutput === null ||
    modelOutput === null
  ) {
    throw new Error(
      "Usage: tsx scripts/merge-phase8-support-tune-shards.ts --input-root <download-root> --behavior-model <selected-model.json> --support-output <new-directory> --model-output <new-file>",
    );
  }
  return { inputRoot, behaviorModel, supportOutput, modelOutput };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function same(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

async function readShard(directory: string): Promise<SupportTuneShard> {
  const payload = await readFile(resolve(directory, "shard.json"), "utf8");
  const checksum = await readFile(
    resolve(directory, "checksums.sha256"),
    "utf8",
  );
  if (checksum !== `${sha256(payload)}  shard.json\n`) {
    throw new Error(`Shard checksum failed in ${directory}.`);
  }
  const value = JSON.parse(payload) as SupportTuneShard;
  const { artifactSha256, ...projection } = value;
  if (
    payload !== `${stableStringify(value)}\n` ||
    artifactSha256 !== phase8Sha256(projection)
  ) {
    throw new Error(`Shard envelope failed in ${directory}.`);
  }
  verifyPhase8SupportTunePlan(value.plan);
  for (const game of value.games) {
    verifyPhase8SupportTuneGameRecord(game);
  }
  for (const observation of value.observations) {
    verifyPhase8SupportTuneObservationRecord(observation);
  }
  if (
    value.shard.baseCount !== 32 ||
    (value.shard.baseIndexStart !== 0 &&
      value.shard.baseIndexStart !== 32) ||
    !FITTABLE_STYLE_CELL_IDS.includes(value.shard.styleCellId) ||
    !same(value.shard.rotations, [0, 1, 2]) ||
    value.games.length !== value.shard.baseCount * 3
  ) {
    throw new Error(`Shard coordinate failed in ${directory}.`);
  }
  return value;
}

function behaviorModelSha256(model: SelectedBehaviorModelArtifact): string {
  return sha256(serializeSelectedBehaviorModelArtifact(model));
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const root = resolve(options.inputRoot);
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name))
    .sort(compareText);
  if (directories.length !== 30) {
    throw new Error(
      `Expected exactly 30 support-tune shard directories, found ${directories.length.toString()}.`,
    );
  }
  const shards = await Promise.all(
    directories.map(async (directory) => readShard(directory)),
  );
  const first = shards[0];
  if (first === undefined) {
    throw new Error("No support-tune shards were supplied.");
  }
  const expectedCoordinates = new Set(
    FITTABLE_STYLE_CELL_IDS.flatMap((styleCellId) =>
      [0, 32].map((baseIndexStart) => `${styleCellId}/${baseIndexStart}`),
    ),
  );
  const seenCoordinates = new Set<string>();
  for (const shard of shards) {
    const coordinate = `${shard.shard.styleCellId}/${shard.shard.baseIndexStart.toString()}`;
    if (
      !expectedCoordinates.has(coordinate) ||
      seenCoordinates.has(coordinate) ||
      !same(shard.plan, first.plan) ||
      !same(shard.source, first.source) ||
      shard.selectedBehaviorModelSha256 !==
        first.selectedBehaviorModelSha256 ||
      shard.selectedBehaviorPayloadChecksum !==
        first.selectedBehaviorPayloadChecksum
    ) {
      throw new Error(`Duplicate or incompatible support shard ${coordinate}.`);
    }
    seenCoordinates.add(coordinate);
  }
  if (
    seenCoordinates.size !== expectedCoordinates.size ||
    [...expectedCoordinates].some(
      (coordinate) => !seenCoordinates.has(coordinate),
    )
  ) {
    throw new Error("Support-tune shard set has missing coordinates.");
  }

  const behaviorModel = await readSelectedBehaviorModelArtifact(
    resolve(options.behaviorModel),
  );
  if (
    behaviorModelSha256(behaviorModel) !==
      first.selectedBehaviorModelSha256 ||
    behaviorModel.payloadChecksum !==
      first.selectedBehaviorPayloadChecksum ||
    behaviorModel.payload.sourceHash !== first.plan.sourceSha256
  ) {
    throw new Error("Selected behavior model does not match the shard set.");
  }
  const styleOrder = new Map(
    FITTABLE_STYLE_CELL_IDS.map((styleCellId, index) => [
      styleCellId,
      index,
    ]),
  );
  const games = shards
    .flatMap((shard) => [...shard.games])
    .sort(
      (left, right) =>
        (styleOrder.get(left.styleCellId) ?? Number.MAX_SAFE_INTEGER) -
          (styleOrder.get(right.styleCellId) ?? Number.MAX_SAFE_INTEGER) ||
        left.baseIndex - right.baseIndex ||
        left.rotation - right.rotation,
    );
  const observations = shards
    .flatMap((shard) => [...shard.observations])
    .sort(
      (left, right) =>
        compareText(left.gameId, right.gameId) ||
        compareText(left.stateId, right.stateId) ||
        compareText(left.queryId, right.queryId) ||
        compareText(left.arm, right.arm),
    );
  if (
    new Set(games.map((game) => game.gameId)).size !== games.length ||
    new Set(observations.map((observation) => observation.observationId))
      .size !== observations.length
  ) {
    throw new Error("Merged support-tune evidence contains duplicate IDs.");
  }
  const runFailureCount = shards.reduce(
    (total, shard) => total + shard.runFailureCount,
    0,
  );
  const scored = scorePhase8SupportTuneCandidates({
    plan: first.plan,
    games,
    observations,
    runFailureCount,
  });
  if (!scored.integrity.passed) {
    throw new Error(
      `Merged support-tune integrity failed: ${stableStringify(scored.integrity)}`,
    );
  }
  const evidenceSha256 = phase8SupportTuneEvidenceSha256({
    plan: first.plan,
    behaviorModel,
    games,
    observations,
  });
  const selection = createPhase8SupportRegularizerTuneSelection({
    sourceSha256: first.plan.sourceSha256,
    tuneArtifactSha256: evidenceSha256,
    tuneDatasetHash: first.plan.behaviorTuneDatasetHash,
    scorerSha256: first.plan.scorerSha256,
    queryPlanSha256: first.plan.queryPlanSha256,
    candidates: scored.evaluations.map((evaluation) => evaluation.score),
  });
  const run: Phase8SupportTuneRunResult = Object.freeze({
    plan: first.plan,
    behaviorModel,
    games: Object.freeze(games),
    observations: Object.freeze(observations),
    candidateEvaluations: scored.evaluations,
    integrity: scored.integrity,
    evidenceSha256,
    selection,
    provisionalSelectedPseudocount:
      selection.selectedPseudocountPerFeasibleLabel,
  });
  const supportManifest = await writePhase8SupportTuneArtifact(
    resolve(options.supportOutput),
    run,
  );
  const productionModel = createPhase8ProductionModelArtifact({
    behavior: behaviorModel,
    supportRegularizerSelection: selection,
  });
  await writePhase8ProductionModelArtifact(
    resolve(options.modelOutput),
    productionModel,
  );
  console.log(
    JSON.stringify({
      supportOutput: resolve(options.supportOutput),
      modelOutput: resolve(options.modelOutput),
      shardCount: shards.length,
      games: games.length,
      observations: observations.length,
      selectedPseudocount:
        selection.selectedPseudocountPerFeasibleLabel,
      selectedBehaviorCandidateId:
        behaviorModel.payload.selectedCandidateId,
      selectedBehaviorParameters: behaviorModel.payload.parameters,
      supportArtifactSha256: supportManifest.artifactSha256,
      productionModelPayloadChecksum: productionModel.payloadChecksum,
    }),
  );
}

await main();
