import { resolve } from "node:path";

import { verifyLatencyArtifacts } from "../src/benchmark/node";
import { stableStringify } from "../src/events/stable-hash";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const rawRun = argument("--run") ?? process.argv[2];
  if (rawRun === undefined || rawRun.trim().length === 0) {
    throw new Error(
      "Usage: tsx scripts/verify-phase8-latency.ts --run <artifact-directory>",
    );
  }
  const verification = await verifyLatencyArtifacts(resolve(rawRun));
  console.log(stableStringify(verification));
  if (!verification.valid) {
    process.exitCode = 1;
  }
}

await main();
