import { resolve } from "node:path";

import { strategyRegistryChecksum } from "../src/strategy/artifacts";
import { PHASE7_STRATEGY_PROTOCOL_ID } from "../src/strategy/phase7-evidence";
import {
  verifyStrategyEvidenceRun,
  type StrategyEvidenceProtocolDescriptor,
} from "./strategy-evidence-artifact-store";

function parseArguments(argv: readonly string[]): {
  readonly run: string;
  readonly final: boolean;
  readonly phase7: boolean;
} {
  let run: string | null = null;
  let final = false;
  let phase7 = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--run":
        run = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--final":
        final = true;
        break;
      case "--phase7":
        phase7 = true;
        break;
      default:
        if (
          argument !== undefined &&
          !argument.startsWith("-") &&
          run === null
        ) {
          run = argument;
          break;
        }
        throw new Error(`Unknown argument: ${argument ?? "<missing>"}`);
    }
  }
  if (run === null || run.trim().length === 0) {
    throw new Error("--run is required.");
  }
  return { run, final, phase7 };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const protocol: StrategyEvidenceProtocolDescriptor | undefined =
    options.phase7
      ? {
          protocolId: PHASE7_STRATEGY_PROTOCOL_ID,
          registryChecksum: strategyRegistryChecksum(),
          verificationMode: "final",
        }
      : undefined;
  const mode = options.phase7 || options.final ? "final" : "phase6";
  const verification = await verifyStrategyEvidenceRun(resolve(options.run), {
    mode,
    ...(protocol === undefined ? {} : { protocol }),
  });
  if (!verification.ok) {
    throw new Error(verification.issues.join("\n"));
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        verified: true,
        mode,
        run: resolve(options.run),
        summary: verification.summary,
      },
      null,
      2,
    )}\n`,
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
