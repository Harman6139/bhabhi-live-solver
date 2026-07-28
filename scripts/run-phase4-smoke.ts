import { resolve } from "node:path";

import { writeEvaluationArtifacts } from "../src/evaluation/artifacts";
import { runBatch } from "../src/evaluation/batch";
import { createPhase4SmokePlan } from "../src/evaluation/protocol";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const runId =
  argument("--run-id") ??
  `phase4-smoke-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
const baseCount = Number(argument("--base-count") ?? "4");
if (!Number.isSafeInteger(baseCount) || baseCount <= 0) {
  throw new RangeError("--base-count must be a positive safe integer.");
}
const artifactRoot = resolve(
  argument("--artifact-root") ?? "artifacts/evaluation",
);
const protocolPlanPath = resolve("docs/evaluation-plan.md");
const plan = createPhase4SmokePlan(runId, baseCount);

process.stdout.write(
  `running ${plan.userPolicyIds.length.toString()} policies x ${plan.styleCellIds.length.toString()} cells x ${baseCount.toString()} deals x 3 rotations\n`,
);
const result = runBatch(plan);
const command = `npm run eval:phase4 -- --run-id ${runId} --base-count ${baseCount.toString()}`;
const written = await writeEvaluationArtifacts(result, {
  artifactRoot,
  protocolPlanPath,
  command,
});
process.stdout.write(
  `${JSON.stringify(
    {
      runDirectory: written.runDirectory,
      completed: result.summary.completedGames,
      failures: result.summary.failedGames,
      zeroFailureGate: result.summary.zeroFailureGate,
      reproductionDigest: result.summary.reproductionDigest,
    },
    null,
    2,
  )}\n`,
);
if (!result.summary.zeroFailureGate) {
  process.exitCode = 1;
}
