import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { readSelectedBehaviorModelArtifact } from "../src/modeling/artifact-store";
import { verifyBehaviorDatasetArtifacts } from "../src/modeling/dataset-artifact";
import { behaviorBeliefConfigFromSelectedArtifact } from "../src/modeling/behavior-fit";

async function main(): Promise<void> {
  const pathValue = process.argv[2];
  if (pathValue === undefined || process.argv.length !== 3) {
    throw new Error(
      "Usage: npm run model:phase8:verify -- <dataset-directory|selected-model.json>",
    );
  }
  const path = resolve(pathValue);
  const metadata = await stat(path);
  if (metadata.isDirectory()) {
    const verification = await verifyBehaviorDatasetArtifacts(path);
    console.log(
      JSON.stringify({
        kind: "behavior-dataset",
        path,
        valid: verification.valid,
        failures: verification.failures,
        manifestSha256: verification.manifest?.manifestSha256 ?? null,
        observations: verification.dataset?.observations.length ?? null,
      }),
    );
    if (!verification.valid) {
      process.exitCode = 1;
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error("Verification target is not a regular file or directory.");
  }
  const artifact = await readSelectedBehaviorModelArtifact(path);
  const inferenceConfig = behaviorBeliefConfigFromSelectedArtifact(artifact);
  console.log(
    JSON.stringify({
      kind: "selected-behavior-model",
      path,
      valid: true,
      payloadChecksum: artifact.payloadChecksum,
      selectedCandidateId: artifact.payload.selectedCandidateId,
      parameters: artifact.payload.parameters,
      separateOpponentPriors: inferenceConfig.opponentModelPriors !== undefined,
    }),
  );
}

await main();
