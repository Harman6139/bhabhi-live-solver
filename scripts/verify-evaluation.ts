import { resolve } from "node:path";

import { verifyEvaluationArtifacts } from "../src/evaluation/artifacts";

const runIndex = process.argv.indexOf("--run");
const positionalPath = process.argv
  .slice(2)
  .find((argument) => !argument.startsWith("-"));
const runPath = runIndex === -1 ? positionalPath : process.argv[runIndex + 1];
if (runPath === undefined) {
  throw new Error("Usage: npm run eval:verify -- --run <artifact-directory>");
}
const verification = await verifyEvaluationArtifacts(resolve(runPath));
process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
if (!verification.valid) {
  process.exitCode = 1;
}
