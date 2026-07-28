import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  captureDirectorySnapshot,
  latencyRunManifestSchema,
  verifyLatencyArtifacts,
} from "../src/benchmark/node";
import { latencySummarySchema } from "../src/benchmark";
import { stableStringify } from "../src/events/stable-hash";
import { verifyProductionReleaseBundle } from "../src/production";

type CommandEvidence = Readonly<{
  name: string;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  stdoutFile: string;
  stdoutSha256: string;
  stdoutBytes: number;
  stderrFile: string;
  stderrSha256: string;
  stderrBytes: number;
}>;

type Options = Readonly<{
  releaseBundlePath: string;
  latencyRun: string;
  distPath: string;
  outputParent: string;
  attestationId: string;
}>;

const PROJECT_ROOT = resolve(".");
const NPM_CLI = process.env.npm_execpath;
const NPM = NPM_CLI === undefined ? "npm" : process.execPath;

function npmArgs(args: readonly string[]): readonly string[] {
  return NPM_CLI === undefined ? args : [NPM_CLI, ...args];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = argument(name);
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function options(): Options {
  const attestationId =
    argument("--attestation-id") ??
    "phase9-reference-release-validation-20260728-a";
  if (
    attestationId.trim().length === 0 ||
    basename(attestationId) !== attestationId
  ) {
    throw new Error("--attestation-id must be one safe path segment.");
  }
  return {
    releaseBundlePath: resolve(required("--release-bundle")),
    latencyRun: resolve(required("--latency-run")),
    distPath: resolve(argument("--dist") ?? "dist"),
    outputParent: resolve(
      argument("--output-parent") ?? "artifacts/release/validation",
    ),
    attestationId,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(input: {
  readonly name: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly logDirectory: string;
  readonly environment?: Readonly<Record<string, string>>;
}): Promise<CommandEvidence> {
  const startedAt = new Date().toISOString();
  const command = [input.executable, ...input.args]
    .map((part) => JSON.stringify(part))
    .join(" ");
  const result = await new Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>((resolveProcess, reject) => {
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      env: { ...process.env, ...input.environment },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveProcess({ exitCode: code ?? -1, stdout, stderr });
    });
  });
  const finishedAt = new Date().toISOString();
  const stdoutFile = `${input.name}.stdout.log`;
  const stderrFile = `${input.name}.stderr.log`;
  await writeFile(join(input.logDirectory, stdoutFile), result.stdout, "utf8");
  await writeFile(join(input.logDirectory, stderrFile), result.stderr, "utf8");
  const evidence: CommandEvidence = {
    name: input.name,
    command,
    cwd: input.cwd,
    startedAt,
    finishedAt,
    exitCode: result.exitCode,
    stdoutFile,
    stdoutSha256: sha256(result.stdout),
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrFile,
    stderrSha256: sha256(result.stderr),
    stderrBytes: Buffer.byteLength(result.stderr),
  };
  if (result.exitCode !== 0) {
    throw new Error(`${input.name} failed with exit code ${result.exitCode}.`);
  }
  return evidence;
}

async function gitText(args: readonly string[]): Promise<string> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn("git", [...args], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolveProcess(stdout.trim());
      } else {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
      }
    });
  });
}

async function documentEvidence(path: string): Promise<
  Readonly<{
    path: string;
    bytes: number;
    sha256: string;
  }>
> {
  const bytes = await readFile(path);
  return {
    path: relative(PROJECT_ROOT, path).replaceAll("\\", "/"),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

async function main(): Promise<void> {
  const input = options();
  const target = join(input.outputParent, input.attestationId);
  const stage = join(
    input.outputParent,
    `.incomplete-${input.attestationId}-${process.pid.toString()}`,
  );
  if (
    dirname(target) !== input.outputParent ||
    dirname(stage) !== input.outputParent ||
    (await exists(target)) ||
    (await exists(stage))
  ) {
    throw new Error(`Refusing unsafe or existing output ${target}.`);
  }

  const releasePayload = await readFile(input.releaseBundlePath, "utf8");
  const release = await verifyProductionReleaseBundle(
    JSON.parse(releasePayload) as unknown,
  );
  if (release.binding.bundleMode !== "release-selected") {
    throw new Error("Phase 9 validation requires a release-selected bundle.");
  }
  const gitStatus = await gitText([
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (gitStatus.length > 0) {
    throw new Error(
      `Phase 9 release validation requires a clean worktree:\n${gitStatus}`,
    );
  }

  await mkdir(stage, { recursive: true });
  const commands: CommandEvidence[] = [];
  const releaseEnvironment = {
    BHABHI_RELEASE_BUNDLE_PATH: input.releaseBundlePath,
    BHABHI_RELEASE_EXPECT_MODE: "release-selected",
  };
  const run = async (
    name: string,
    executable: string,
    args: readonly string[],
    cwd = PROJECT_ROOT,
    environment: Readonly<Record<string, string>> = releaseEnvironment,
  ): Promise<void> => {
    commands.push(
      await runCommand({
        name,
        executable,
        args,
        cwd,
        logDirectory: stage,
        environment,
      }),
    );
  };

  const readmePath = join(PROJECT_ROOT, "README.md");
  const finalReportPath = join(PROJECT_ROOT, "docs", "final-report.md");
  const progressPath = join(PROJECT_ROOT, "docs", "progress.md");
  const documentationText = [
    await readFile(readmePath, "utf8"),
    await readFile(finalReportPath, "utf8"),
  ].join("\n");
  if (/\[(?:pending|todo|tbd)\]/iu.test(documentationText)) {
    throw new Error(
      "Final documentation still contains a pending placeholder.",
    );
  }

  const cleanWorktree = join(
    PROJECT_ROOT,
    "work",
    `phase9-readme-dry-run-${process.pid.toString()}`,
  );
  if (
    !cleanWorktree.startsWith(`${join(PROJECT_ROOT, "work")}\\`) ||
    (await exists(cleanWorktree))
  ) {
    throw new Error(`Unsafe or existing clean-worktree path ${cleanWorktree}.`);
  }

  let worktreeAdded = false;
  try {
    await run("format", NPM, npmArgs(["run", "format:check"]));
    await run("lint", NPM, npmArgs(["run", "lint"]));
    await run("typecheck", NPM, npmArgs(["run", "typecheck"]));
    await run("unit-regression", NPM, npmArgs(["test"]));
    await run("selected-production-build", NPM, npmArgs(["run", "build"]));
    await run(
      "debug-truth-firewall",
      NPM,
      npmArgs(["run", "test:truth-firewall"]),
    );
    await run(
      "product-e2e-accessibility",
      NPM,
      npmArgs(["exec", "--", "playwright", "test"]),
    );

    const build = await captureDirectorySnapshot(input.distPath);
    const latency = await verifyLatencyArtifacts(input.latencyRun);
    const latencyManifest = latencyRunManifestSchema.parse(
      JSON.parse(
        await readFile(join(input.latencyRun, "manifest.json"), "utf8"),
      ) as unknown,
    );
    const latencySummaryPayload = await readFile(
      join(input.latencyRun, "summary.json"),
      "utf8",
    );
    const latencySummary = latencySummarySchema.parse(
      JSON.parse(latencySummaryPayload) as unknown,
    );
    if (
      !latency.valid ||
      !latencySummary.gate.evidenceGatePass ||
      latencyManifest.binding.bundleMode !== "release-selected" ||
      stableStringify(latencyManifest.binding) !==
        stableStringify(release.binding) ||
      latencyManifest.productionBuild.distSha256 !== build.sha256 ||
      latencySummary.races.expected < 1_000 ||
      latencySummary.races.attempted !== latencySummary.races.expected ||
      latencySummary.races.obsoletePublications !== 0
    ) {
      throw new Error(
        `Selected release latency/cancellation evidence failed: ${latency.failures.join("; ")}`,
      );
    }

    await run(
      "readme-worktree-add",
      "git",
      ["worktree", "add", "--detach", cleanWorktree, "HEAD"],
      PROJECT_ROOT,
      {},
    );
    worktreeAdded = true;
    await run("readme-install", NPM, npmArgs(["ci"]), cleanWorktree, {});
    await run(
      "readme-typecheck",
      NPM,
      npmArgs(["run", "typecheck"]),
      cleanWorktree,
      releaseEnvironment,
    );
    await run(
      "readme-test",
      NPM,
      npmArgs(["test"]),
      cleanWorktree,
      releaseEnvironment,
    );
    await run(
      "readme-play-e2e",
      NPM,
      npmArgs(["run", "test:e2e"]),
      cleanWorktree,
      releaseEnvironment,
    );

    const docs = await Promise.all([
      documentEvidence(readmePath),
      documentEvidence(finalReportPath),
      documentEvidence(progressPath),
    ]);
    const attestationWithoutDigest = {
      schemaVersion: 1,
      attestationVersion: "phase9-release-validation-attestation-v1",
      attestationId: input.attestationId,
      writeMode: "create-exclusive",
      createdAt: new Date().toISOString(),
      gitCommit: await gitText(["rev-parse", "HEAD"]),
      gitWorktreeClean: true,
      releaseBundlePath: input.releaseBundlePath,
      releaseBundleSha256: sha256(releasePayload),
      releaseBinding: release.binding,
      productionBuild: build,
      latency: {
        runDirectory: input.latencyRun,
        valid: latency.valid,
        reproductionDigest: latency.reproductionDigest,
        summarySha256: sha256(latencySummaryPayload),
        evidenceGatePass: latencySummary.gate.evidenceGatePass,
        races: latencySummary.races,
      },
      commands,
      documentation: docs,
      cleanDirectory: {
        gitCommit: await gitText(["rev-parse", "HEAD"]),
        install: "npm ci",
        typecheck: "npm run typecheck",
        test: "npm test",
        playAndE2e: "npm run test:e2e",
        passed: true,
      },
      gates: {
        exactSelectedBuild: true,
        releaseBinding: true,
        routeLatency: true,
        cancellationRaces: true,
        productE2e: true,
        accessibilitySmoke: true,
        readmeCleanDirectory: true,
        documentationBytes: true,
        debugTruthFirewall: true,
        finalRegression: true,
        releaseGate: true,
      },
    };
    const validationDigest = sha256(stableStringify(attestationWithoutDigest));
    const attestationPayload = `${stableStringify({
      ...attestationWithoutDigest,
      validationDigest,
    })}\n`;
    await writeFile(
      join(stage, "release-validation-attestation.json"),
      attestationPayload,
      { encoding: "utf8", flag: "wx" },
    );

    const logFiles = commands.flatMap((command) => [
      [command.stdoutFile, command.stdoutSha256] as const,
      [command.stderrFile, command.stderrSha256] as const,
    ]);
    const checksums = [
      [
        "release-validation-attestation.json",
        sha256(attestationPayload),
      ] as const,
      ...logFiles,
    ]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, digest]) => `${digest}  ${file}`)
      .join("\n");
    await writeFile(join(stage, "checksums.sha256"), `${checksums}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(stage, target);
    process.stdout.write(
      `${JSON.stringify({
        runDirectory: target,
        validationDigest,
        releaseGate: true,
        commandCount: commands.length,
      })}\n`,
    );
  } finally {
    if (worktreeAdded) {
      await new Promise<void>((resolveCleanup) => {
        const cleanup = spawn(
          "git",
          ["worktree", "remove", "--force", cleanWorktree],
          {
            cwd: PROJECT_ROOT,
            windowsHide: true,
            stdio: "ignore",
          },
        );
        cleanup.once("close", () => resolveCleanup());
        cleanup.once("error", () => resolveCleanup());
      });
    }
    if (await exists(cleanWorktree)) {
      await rm(cleanWorktree, { recursive: true, force: true });
    }
    if (await exists(stage)) {
      await rm(stage, { recursive: true, force: true });
    }
  }
}

await main();
