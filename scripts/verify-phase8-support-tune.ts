import { resolve } from "node:path";

import { verifyPhase8SupportTuneArtifact } from "../src/modeling/support-tune-artifact";

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (directory === undefined || process.argv.length !== 3) {
    throw new Error(
      "Usage: npx tsx scripts/verify-phase8-support-tune.ts <artifact-directory>",
    );
  }
  const verification = await verifyPhase8SupportTuneArtifact(
    resolve(directory),
  );
  console.log(
    JSON.stringify({
      directory: verification.directory,
      valid: verification.valid,
      failures: verification.failures,
      artifactSha256: verification.manifest?.artifactSha256 ?? null,
      evidenceEligible: verification.run?.plan.evidenceEligible ?? null,
      completeStyleBaseClusters:
        verification.run?.integrity.completeStyleBaseClusters ?? null,
      selectedPseudocount:
        verification.run?.selection?.selectedPseudocountPerFeasibleLabel ??
        verification.run?.provisionalSelectedPseudocount ??
        null,
    }),
  );
  if (!verification.valid) {
    process.exitCode = 1;
  }
}

await main();
