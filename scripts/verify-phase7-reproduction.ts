import { resolve } from "node:path";

import {
  verifyPhase7ComparisonReproduction,
  verifyPhase7ComparisonReproductionAttestation,
  writePhase7ComparisonReproductionAttestation,
} from "../src/evaluation/phase7-comparison-artifacts";

type CliOptions = {
  readonly smokeDirectory: string;
  readonly primaryDirectory: string;
  readonly reproductionDirectory: string;
  readonly attestationDirectory: string | null;
  readonly writeAttestationRoot: string | null;
};

function valueAfter(
  argv: readonly string[],
  index: number,
  name: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return resolve(value);
}

function parseArguments(argv: readonly string[]): CliOptions {
  let smokeDirectory: string | null = null;
  let primaryDirectory: string | null = null;
  let reproductionDirectory: string | null = null;
  let attestationDirectory: string | null = null;
  let writeAttestationRoot: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--smoke":
        smokeDirectory = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--primary":
        primaryDirectory = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--reproduction":
        reproductionDirectory = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--attestation":
        attestationDirectory = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--write-attestation-root":
        writeAttestationRoot = valueAfter(argv, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument ?? "<missing>"}`);
    }
  }
  if (
    smokeDirectory === null ||
    primaryDirectory === null ||
    reproductionDirectory === null
  ) {
    throw new Error(
      "Supply --smoke, --primary, and --reproduction artifact directories.",
    );
  }
  if (attestationDirectory !== null && writeAttestationRoot !== null) {
    throw new Error(
      "Choose either --attestation or --write-attestation-root, not both.",
    );
  }
  return {
    smokeDirectory,
    primaryDirectory,
    reproductionDirectory,
    attestationDirectory,
    writeAttestationRoot,
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.writeAttestationRoot !== null) {
    const written = await writePhase7ComparisonReproductionAttestation({
      smokeDirectory: options.smokeDirectory,
      primaryDirectory: options.primaryDirectory,
      reproductionDirectory: options.reproductionDirectory,
      artifactRoot: options.writeAttestationRoot,
    });
    const verification = await verifyPhase7ComparisonReproductionAttestation({
      smokeDirectory: options.smokeDirectory,
      primaryDirectory: options.primaryDirectory,
      reproductionDirectory: options.reproductionDirectory,
      attestationDirectory: written.attestationDirectory,
    });
    process.stdout.write(
      `${JSON.stringify({ written, verification }, null, 2)}\n`,
    );
    if (!verification.valid) {
      process.exitCode = 1;
    }
    return;
  }
  if (options.attestationDirectory !== null) {
    const verification = await verifyPhase7ComparisonReproductionAttestation({
      smokeDirectory: options.smokeDirectory,
      primaryDirectory: options.primaryDirectory,
      reproductionDirectory: options.reproductionDirectory,
      attestationDirectory: options.attestationDirectory,
    });
    process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
    if (!verification.valid) {
      process.exitCode = 1;
    }
    return;
  }
  const verification = await verifyPhase7ComparisonReproduction(options);
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  if (!verification.valid) {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
