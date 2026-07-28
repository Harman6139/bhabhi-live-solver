import { resolve } from "node:path";

import { verifyCalibrationArtifacts } from "../src/calibration/artifacts";

const runDirectory = process.argv[2];
if (runDirectory === undefined) {
  throw new Error(
    "Usage: npm run eval:calibration:verify -- <calibration-run-directory>",
  );
}

const verification = await verifyCalibrationArtifacts(resolve(runDirectory));
process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
if (!verification.valid) {
  process.exitCode = 1;
}
