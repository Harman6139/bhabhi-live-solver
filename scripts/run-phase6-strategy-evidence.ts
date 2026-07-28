import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";

import { stableStringify } from "../src/events/stable-hash";
import {
  createPhase6StrategyEvidenceBundle,
  phase6RequiredStrategyTestPaths,
} from "../src/strategy/phase6-evidence";
import {
  createPhase7StrategyEvidenceBundle,
  PHASE7_STRATEGY_PROTOCOL_ID,
  phase7RequiredStrategyTestPaths,
} from "../src/strategy/phase7-evidence";
import { strategyRegistryChecksum } from "../src/strategy/artifacts";
import {
  summarizeStrategyEvidence,
  verifyStrategyEvidence,
  type StrategyCommandRecord,
} from "../src/strategy/evidence";
import {
  rawStrategyTestResultChecksum,
  verifyStrategyEvidenceRun,
  writeImmutableStrategyEvidenceRun,
  type RawStrategyTestResult,
  type StrategyEvidenceProtocolDescriptor,
} from "./strategy-evidence-artifact-store";
import { createPhase7StrategyRecords } from "./phase7-strategy-records";

const SOURCE_FIXED_FILES = [
  "GOAL.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "docs/strategy-taxonomy.md",
  "scripts/run-phase6-strategy-evidence.ts",
  "scripts/verify-phase6-strategy-evidence.ts",
  "scripts/strategy-evidence-artifact-store.ts",
  "scripts/phase7-strategy-records.ts",
] as const;

const SOURCE_DIRECTORIES = [
  "src/agents",
  "src/domain",
  "src/evaluation",
  "src/events",
  "src/inference",
  "src/persistence",
  "src/public",
  "src/random",
  "src/rules",
  "src/search",
  "src/simulator",
  "src/strategy",
  "src/ui",
  "tests/support",
] as const;

type CliOptions = {
  readonly phase7: boolean;
  readonly verifyOnly: boolean;
  readonly runId: string | null;
  readonly outputRoot: string;
  readonly evidenceClass:
    "development" | "train" | "tune" | "qualification" | "final";
};

function parseArguments(argv: readonly string[]): CliOptions {
  let phase7 = false;
  let verifyOnly = false;
  let runId: string | null = null;
  let outputRoot = "artifacts/strategy/phase6";
  let evidenceClass: CliOptions["evidenceClass"] = "development";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--verify-only":
        verifyOnly = true;
        break;
      case "--phase7":
        phase7 = true;
        break;
      case "--run-id":
        runId = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--output-root":
        outputRoot = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--evidence-class": {
        const value = argv[index + 1];
        if (
          value !== "development" &&
          value !== "train" &&
          value !== "tune" &&
          value !== "qualification" &&
          value !== "final"
        ) {
          throw new Error(`Invalid evidence class: ${value ?? "<missing>"}`);
        }
        evidenceClass = value;
        index += 1;
        break;
      }
      default:
        if (
          argument !== undefined &&
          !argument.startsWith("-") &&
          runId === null
        ) {
          runId = argument;
          break;
        }
        throw new Error(`Unknown argument: ${argument ?? "<missing>"}`);
    }
  }
  if (verifyOnly && runId !== null) {
    throw new Error("--verify-only and --run-id are mutually exclusive.");
  }
  if (!verifyOnly && runId === null) {
    throw new Error("Use --verify-only or supply --run-id.");
  }
  if (outputRoot.trim().length === 0) {
    throw new Error("--output-root must not be empty.");
  }
  if (phase7 && outputRoot === "artifacts/strategy/phase6") {
    outputRoot = "artifacts/strategy/phase7";
  }
  return { phase7, verifyOnly, runId, outputRoot, evidenceClass };
}

async function filesBelow(
  root: string,
  relativeDirectory: string,
): Promise<string[]> {
  const result: string[] = [];
  const directory = resolve(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(
        ...(await filesBelow(root, relative(root, path).replaceAll("\\", "/"))),
      );
    } else if (entry.isFile() && !entry.name.endsWith(".log")) {
      result.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  return result;
}

async function sourceRevision(
  root: string,
  testPaths: readonly string[],
): Promise<string> {
  const paths = new Set<string>([...SOURCE_FIXED_FILES, ...testPaths]);
  for (const directory of SOURCE_DIRECTORIES) {
    for (const path of await filesBelow(root, directory)) {
      paths.add(path);
    }
  }
  const hash = createHash("sha256");
  for (const path of [...paths].sort((left, right) =>
    left.localeCompare(right),
  )) {
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(await readFile(resolve(root, path)));
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function environmentChecksum(root: string): Promise<string> {
  const lockfile = await readFile(resolve(root, "package-lock.json"));
  return `sha256:${createHash("sha256")
    .update(
      stableStringify({
        schemaVersion: 1,
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
      }),
      "utf8",
    )
    .digest("hex")}`;
}

async function assertTestPathsExist(
  root: string,
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) {
    const metadata = await stat(resolve(root, path));
    if (!metadata.isFile()) {
      throw new Error(`Required strategy evidence path is not a file: ${path}`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const root = process.cwd();
  const testPaths = options.phase7
    ? phase7RequiredStrategyTestPaths()
    : phase6RequiredStrategyTestPaths();
  await assertTestPathsExist(root, testPaths);

  const vitestPath = fileURLToPath(
    new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
  );
  const commandArgv = [
    process.execPath,
    relative(root, vitestPath).replaceAll("\\", "/"),
    "run",
    ...testPaths,
    "--reporter=json",
  ];
  const revisionBefore = await sourceRevision(root, testPaths);
  const result = spawnSync(process.execPath, commandArgv.slice(1), {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const exitCode = result.status ?? 1;
  const rawTestResult: RawStrategyTestResult = {
    schemaVersion: 1,
    commandId: options.phase7
      ? "command/phase7-required-strategy-tests"
      : "command/phase6-required-strategy-tests",
    argv: commandArgv,
    exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  const revisionAfter = await sourceRevision(root, testPaths);
  if (revisionAfter !== revisionBefore) {
    throw new Error(
      "The source tree changed while the strategy evidence command ran; rerun against a stable snapshot.",
    );
  }

  const command: StrategyCommandRecord = {
    commandId: rawTestResult.commandId,
    argv: rawTestResult.argv,
    workingDirectory: ".",
    sourceRevision: revisionBefore,
    environmentChecksum: await environmentChecksum(root),
    exitCode,
  };
  const records = options.phase7
    ? createPhase7StrategyRecords(command)
    : undefined;
  const bundle = options.phase7
    ? createPhase7StrategyEvidenceBundle({
        command,
        resultChecksum: rawStrategyTestResultChecksum(rawTestResult),
        ...records,
      })
    : createPhase6StrategyEvidenceBundle({
        command,
        resultChecksum: rawStrategyTestResultChecksum(rawTestResult),
      });
  const verificationMode = options.phase7 ? "final" : "phase6";
  const verification = verifyStrategyEvidence(bundle, {
    mode: verificationMode,
  });
  if (!verification.ok) {
    process.stderr.write(rawTestResult.stderr);
    process.stdout.write(rawTestResult.stdout);
    throw new Error(
      verification.issues
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("\n"),
    );
  }

  if (options.verifyOnly) {
    process.stdout.write(
      `${JSON.stringify(
        {
          gate: options.phase7
            ? "phase7-strategy-evidence"
            : "phase6-strategy-evidence",
          testPathCount: testPaths.length,
          rawResultChecksum: rawStrategyTestResultChecksum(rawTestResult),
          sourceRevision: revisionBefore,
          summary: summarizeStrategyEvidence(bundle, {
            mode: verificationMode,
          }),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (options.runId === null) {
    throw new Error("A run ID is required when writing evidence.");
  }

  const protocol: StrategyEvidenceProtocolDescriptor | undefined =
    options.phase7
      ? {
          protocolId: PHASE7_STRATEGY_PROTOCOL_ID,
          registryChecksum: strategyRegistryChecksum(),
          verificationMode: "final",
        }
      : undefined;
  const artifactPath = await writeImmutableStrategyEvidenceRun({
    outputRoot: resolve(root, options.outputRoot),
    runId: options.runId,
    evidenceClass: options.evidenceClass,
    sourceRevision: revisionBefore,
    bundle,
    rawTestResult,
    ...(protocol === undefined ? {} : { protocol }),
  });
  const artifactVerification = await verifyStrategyEvidenceRun(artifactPath, {
    mode: options.phase7
      ? "final"
      : options.evidenceClass === "final"
        ? "final"
        : "phase6",
    ...(protocol === undefined ? {} : { protocol }),
  });
  if (!artifactVerification.ok) {
    throw new Error(
      `Written artifact failed verification:\n${artifactVerification.issues.join(
        "\n",
      )}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        gate: options.phase7
          ? "phase7-strategy-evidence"
          : "phase6-strategy-evidence",
        artifactPath,
        rawResultChecksum: rawStrategyTestResultChecksum(rawTestResult),
        sourceRevision: revisionBefore,
        summary: artifactVerification.summary,
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
