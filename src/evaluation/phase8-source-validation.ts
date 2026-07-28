import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

import { stableStringify } from "../events/stable-hash";
import { captureSourceSnapshot, type SourceSnapshot } from "./artifacts";
import {
  phase8Sha256,
  verifyPhase8ManifestAuthority,
  type FrozenPhase8ManifestAuthority,
} from "./phase8-manifest";
import { EVALUATION_PROTOCOL_ID } from "./protocol";

export const PHASE8_SOURCE_VALIDATION_VERSION =
  "phase8-source-validation-v1" as const;

export const PHASE8_SOURCE_VALIDATION_COMMANDS = Object.freeze([
  Object.freeze({
    commandClass: "format",
    command: "npm run format:check",
    npmArgs: Object.freeze(["run", "format:check"]),
  }),
  Object.freeze({
    commandClass: "lint",
    command: "npm run lint",
    npmArgs: Object.freeze(["run", "lint"]),
  }),
  Object.freeze({
    commandClass: "typecheck",
    command: "npm run typecheck",
    npmArgs: Object.freeze(["run", "typecheck"]),
  }),
  Object.freeze({
    commandClass: "unit",
    command: "npm run test",
    npmArgs: Object.freeze(["run", "test"]),
  }),
  Object.freeze({
    commandClass: "property",
    command: "npm run test:property",
    npmArgs: Object.freeze(["run", "test:property"]),
  }),
  Object.freeze({
    commandClass: "integration",
    command: "npm run test:integration",
    npmArgs: Object.freeze(["run", "test:integration"]),
  }),
  Object.freeze({
    commandClass: "truth-firewall",
    command: "npm run test:truth-firewall",
    npmArgs: Object.freeze(["run", "test:truth-firewall"]),
  }),
  Object.freeze({
    commandClass: "simulator",
    command: "npm run test:simulator",
    npmArgs: Object.freeze(["run", "test:simulator"]),
  }),
  Object.freeze({
    commandClass: "solver",
    command: "npm run test:solver",
    npmArgs: Object.freeze(["run", "test:solver"]),
  }),
  Object.freeze({
    commandClass: "calibration",
    command: "npm run test:calibration",
    npmArgs: Object.freeze(["run", "test:calibration"]),
  }),
  Object.freeze({
    commandClass: "production-build",
    command: "npm run build",
    npmArgs: Object.freeze(["run", "build"]),
  }),
  Object.freeze({
    commandClass: "browser-e2e",
    command: "npm run test:e2e",
    npmArgs: Object.freeze(["run", "test:e2e"]),
  }),
] as const);

export type Phase8SourceValidationCommandClass =
  (typeof PHASE8_SOURCE_VALIDATION_COMMANDS)[number]["commandClass"];

const commandClasses = PHASE8_SOURCE_VALIDATION_COMMANDS.map(
  (entry) => entry.commandClass,
) as [
  Phase8SourceValidationCommandClass,
  ...Phase8SourceValidationCommandClass[],
];
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const sourceSnapshotSchema = z
  .object({
    sourceSnapshotSha256: sha256Schema,
    sourceFileCount: z.int().positive(),
    gitCommit: gitCommitSchema,
    gitStatusSha256: sha256Schema,
    gitDirty: z.literal(false),
  })
  .strict();
const commandResultSchema = z
  .object({
    ordinal: z.int().min(1).max(PHASE8_SOURCE_VALIDATION_COMMANDS.length),
    commandClass: z.enum(commandClasses),
    command: z.string().min(1),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    exitCode: z.literal(0),
    signal: z.null(),
    logPath: z.string().regex(/^logs\/[0-9]{2}-[a-z-]+\.log$/u),
    logSha256: sha256Schema,
    logByteCount: z.int().nonnegative(),
  })
  .strict();

const sourceValidationBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal(EVALUATION_PROTOCOL_ID),
    validationVersion: z.literal(PHASE8_SOURCE_VALIDATION_VERSION),
    validationId: z.string().trim().min(1),
    writeMode: z.literal("create-exclusive"),
    createdAt: z.iso.datetime(),
    manifestId: z.string().trim().min(1),
    manifestSha256: sha256Schema,
    sourceSha256: sha256Schema,
    sourceFileCount: z.int().positive(),
    modelSha256: sha256Schema,
    configRegistrySha256: sha256Schema,
    scorerSha256: sha256Schema,
    reportSha256: sha256Schema,
    preregistrationSha256: sha256Schema,
    sourceBefore: sourceSnapshotSchema,
    sourceAfter: sourceSnapshotSchema,
    commandSuiteSha256: sha256Schema,
    commands: z
      .array(commandResultSchema)
      .length(PHASE8_SOURCE_VALIDATION_COMMANDS.length),
    cleanCommittedSourceGate: z.literal(true),
    stableSourceGate: z.literal(true),
    completeCommandSuiteGate: z.literal(true),
    zeroExitGate: z.literal(true),
    validationSha256: sha256Schema,
  })
  .strict();

export type Phase8SourceValidation = z.infer<typeof sourceValidationBaseSchema>;

function expectedCommandPath(
  ordinal: number,
  commandClass: Phase8SourceValidationCommandClass,
): string {
  return `logs/${ordinal.toString().padStart(2, "0")}-${commandClass}.log`;
}

function sourceSnapshotProjection(
  snapshot: SourceSnapshot,
): z.infer<typeof sourceSnapshotSchema> {
  if (snapshot.gitCommit === null) {
    throw new Error(
      "Phase 8 source validation requires a committed Git source identity.",
    );
  }
  return sourceSnapshotSchema.parse(snapshot);
}

function validationProjection(
  value: Omit<Phase8SourceValidation, "validationSha256">,
): unknown {
  return value;
}

function addSourceValidationIssues(
  value: Phase8SourceValidation,
  context: z.RefinementCtx,
): void {
  if (
    value.validationSha256 !==
    phase8Sha256(
      validationProjection(
        Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "validationSha256"),
        ) as Omit<Phase8SourceValidation, "validationSha256">,
      ),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["validationSha256"],
      message: "Source-validation SHA-256 does not match its payload.",
    });
  }
  if (
    stableStringify(value.sourceBefore) !==
      stableStringify(value.sourceAfter) ||
    value.sourceAfter.sourceSnapshotSha256 !== value.sourceSha256 ||
    value.sourceAfter.sourceFileCount !== value.sourceFileCount
  ) {
    context.addIssue({
      code: "custom",
      path: ["sourceAfter"],
      message:
        "Source must stay clean, committed, and byte-identical throughout validation.",
    });
  }
  const expectedCommandSuiteSha256 = phase8Sha256(
    PHASE8_SOURCE_VALIDATION_COMMANDS.map((entry, index) => ({
      ordinal: index + 1,
      commandClass: entry.commandClass,
      command: entry.command,
    })),
  );
  if (value.commandSuiteSha256 !== expectedCommandSuiteSha256) {
    context.addIssue({
      code: "custom",
      path: ["commandSuiteSha256"],
      message: "Source-validation command suite drifted.",
    });
  }
  value.commands.forEach((result, index) => {
    const expected = PHASE8_SOURCE_VALIDATION_COMMANDS[index];
    if (
      expected === undefined ||
      result.ordinal !== index + 1 ||
      result.commandClass !== expected.commandClass ||
      result.command !== expected.command ||
      result.logPath !== expectedCommandPath(index + 1, expected.commandClass)
    ) {
      context.addIssue({
        code: "custom",
        path: ["commands", index],
        message:
          "Source-validation command order, command, class, or log path drifted.",
      });
    }
  });
}

export const phase8SourceValidationSchema =
  sourceValidationBaseSchema.superRefine(addSourceValidationIssues);

export type Phase8SourceValidationCommandResult = Readonly<{
  ordinal: number;
  commandClass: Phase8SourceValidationCommandClass;
  command: string;
  startedAt: string;
  completedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  logPath: string;
  log: Uint8Array;
}>;

export type Phase8SourceValidationVerification = Readonly<{
  valid: boolean;
  runDirectory: string;
  failures: readonly string[];
  record: Phase8SourceValidation | null;
  payloadSha256: string | null;
}>;

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function safeTarget(
  parentDirectory: string,
  validationId: string,
): Readonly<{ parent: string; target: string; stage: string }> {
  if (
    validationId.trim().length === 0 ||
    basename(validationId) !== validationId ||
    validationId === "." ||
    validationId === ".."
  ) {
    throw new Error("Source-validation ID must be one safe path segment.");
  }
  const parent = resolve(parentDirectory);
  const target = resolve(parent, validationId);
  const stage = resolve(
    parent,
    `.incomplete-${validationId}-${process.pid.toString()}`,
  );
  if (dirname(target) !== parent || dirname(stage) !== parent) {
    throw new Error("Source-validation target escaped its explicit parent.");
  }
  return { parent, target, stage };
}

function canonicalJson(value: unknown): string {
  return `${stableStringify(value)}\n`;
}

function checksumText(checksums: Readonly<Record<string, string>>): string {
  return `${Object.entries(checksums)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, digest]) => `${digest}  ${path}`)
    .join("\n")}\n`;
}

function expectedFiles(record: Phase8SourceValidation): readonly string[] {
  return [
    "attestation.json",
    ...record.commands.map((command) => command.logPath),
    "checksums.sha256",
  ].sort();
}

async function recursiveFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        output.push(path.slice(directory.length + 1).replaceAll("\\", "/"));
      }
    }
  }
  await visit(directory);
  return output.sort();
}

function parseChecksums(
  text: string,
  failures: string[],
): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }
    const match = /^([0-9a-f]{64}) {2}([a-z0-9./-]+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      failures.push(`Malformed source-validation checksum line: ${line}`);
      continue;
    }
    if (checksums.has(match[2])) {
      failures.push(`Duplicate source-validation checksum for ${match[2]}.`);
      continue;
    }
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

function authorityBinding(authority: FrozenPhase8ManifestAuthority): Readonly<{
  manifestId: string;
  manifestSha256: string;
  sourceSha256: string;
  sourceFileCount: number;
  modelSha256: string;
  configRegistrySha256: string;
  scorerSha256: string;
  reportSha256: string;
  preregistrationSha256: string;
}> {
  verifyPhase8ManifestAuthority(authority);
  return {
    manifestId: authority.manifest.manifestId,
    manifestSha256: authority.manifestSha256,
    sourceSha256: authority.manifest.hashes.sourceSha256,
    sourceFileCount: authority.manifest.sourceFileCount,
    modelSha256: authority.manifest.hashes.modelSha256,
    configRegistrySha256: authority.manifest.hashes.configSha256,
    scorerSha256: authority.manifest.hashes.scorerSha256,
    reportSha256: authority.manifest.hashes.reportSha256,
    preregistrationSha256: authority.manifest.hashes.preregistrationSha256,
  };
}

export function createPhase8SourceValidationRecord(input: {
  readonly validationId: string;
  readonly createdAt: string;
  readonly authority: FrozenPhase8ManifestAuthority;
  readonly sourceBefore: SourceSnapshot;
  readonly sourceAfter: SourceSnapshot;
  readonly commandResults: readonly Phase8SourceValidationCommandResult[];
}): Phase8SourceValidation {
  const binding = authorityBinding(input.authority);
  const sourceBefore = sourceSnapshotProjection(input.sourceBefore);
  const sourceAfter = sourceSnapshotProjection(input.sourceAfter);
  if (
    sourceBefore.sourceSnapshotSha256 !== binding.sourceSha256 ||
    sourceBefore.sourceFileCount !== binding.sourceFileCount ||
    stableStringify(sourceBefore) !== stableStringify(sourceAfter)
  ) {
    throw new Error(
      "Source-validation snapshots must be clean, stable, and match the frozen authority.",
    );
  }
  if (
    input.commandResults.length !== PHASE8_SOURCE_VALIDATION_COMMANDS.length
  ) {
    throw new Error(
      "Source validation requires the complete frozen command suite.",
    );
  }
  const commands = input.commandResults.map((result, index) => {
    const expected = PHASE8_SOURCE_VALIDATION_COMMANDS[index];
    if (
      expected === undefined ||
      result.ordinal !== index + 1 ||
      result.commandClass !== expected.commandClass ||
      result.command !== expected.command ||
      result.logPath !==
        expectedCommandPath(index + 1, expected.commandClass) ||
      result.exitCode !== 0 ||
      result.signal !== null
    ) {
      throw new Error(
        `Source-validation command ${(index + 1).toString()} did not execute the frozen passing contract.`,
      );
    }
    return {
      ordinal: result.ordinal,
      commandClass: result.commandClass,
      command: result.command,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      exitCode: 0 as const,
      signal: null,
      logPath: result.logPath,
      logSha256: sha256Bytes(result.log),
      logByteCount: result.log.byteLength,
    };
  });
  const projection: Omit<Phase8SourceValidation, "validationSha256"> = {
    schemaVersion: 1,
    protocolId: EVALUATION_PROTOCOL_ID,
    validationVersion: PHASE8_SOURCE_VALIDATION_VERSION,
    validationId: input.validationId,
    writeMode: "create-exclusive",
    createdAt: input.createdAt,
    ...binding,
    sourceBefore,
    sourceAfter,
    commandSuiteSha256: phase8Sha256(
      PHASE8_SOURCE_VALIDATION_COMMANDS.map((entry, index) => ({
        ordinal: index + 1,
        commandClass: entry.commandClass,
        command: entry.command,
      })),
    ),
    commands,
    cleanCommittedSourceGate: true,
    stableSourceGate: true,
    completeCommandSuiteGate: true,
    zeroExitGate: true,
  };
  return phase8SourceValidationSchema.parse({
    ...projection,
    validationSha256: phase8Sha256(validationProjection(projection)),
  });
}

export async function writePhase8SourceValidationArtifact(input: {
  readonly parentDirectory: string;
  readonly validationId: string;
  readonly createdAt: string;
  readonly authority: FrozenPhase8ManifestAuthority;
  readonly sourceBefore: SourceSnapshot;
  readonly sourceAfter: SourceSnapshot;
  readonly commandResults: readonly Phase8SourceValidationCommandResult[];
}): Promise<
  Readonly<{
    runDirectory: string;
    record: Phase8SourceValidation;
    payloadSha256: string;
  }>
> {
  const paths = safeTarget(input.parentDirectory, input.validationId);
  if ((await pathExists(paths.target)) || (await pathExists(paths.stage))) {
    throw new Error(
      `Refusing to overwrite source-validation artifact ${paths.target}.`,
    );
  }
  const record = createPhase8SourceValidationRecord(input);
  await mkdir(join(paths.stage, "logs"), { recursive: true });
  try {
    const checksums: Record<string, string> = {};
    const attestationPayload = canonicalJson(record);
    await writeFile(join(paths.stage, "attestation.json"), attestationPayload, {
      encoding: "utf8",
      flag: "wx",
    });
    checksums["attestation.json"] = sha256Bytes(attestationPayload);
    for (const result of input.commandResults) {
      await writeFile(join(paths.stage, result.logPath), result.log, {
        flag: "wx",
      });
      checksums[result.logPath] = sha256Bytes(result.log);
    }
    await writeFile(
      join(paths.stage, "checksums.sha256"),
      checksumText(checksums),
      { encoding: "utf8", flag: "wx" },
    );
    await mkdir(paths.parent, { recursive: true });
    await rename(paths.stage, paths.target);
    return Object.freeze({
      runDirectory: paths.target,
      record,
      payloadSha256: checksums["attestation.json"] ?? "",
    });
  } catch (error) {
    await rm(paths.stage, { recursive: true, force: true });
    throw error;
  }
}

async function runNpmCommand(input: {
  readonly projectRoot: string;
  readonly ordinal: number;
  readonly commandClass: Phase8SourceValidationCommandClass;
  readonly command: string;
  readonly npmArgs: readonly string[];
}): Promise<Phase8SourceValidationCommandResult> {
  const startedAt = new Date().toISOString();
  const chunks: Buffer[] = [];
  const npmCli = process.env.npm_execpath;
  const executable = npmCli === undefined ? "npm" : process.execPath;
  const args =
    npmCli === undefined ? [...input.npmArgs] : [npmCli, ...input.npmArgs];
  const outcome = await new Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: input.projectRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", rejectPromise);
    child.on("close", (exitCode, signal) => {
      resolvePromise({ exitCode, signal });
    });
  });
  return Object.freeze({
    ordinal: input.ordinal,
    commandClass: input.commandClass,
    command: input.command,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    logPath: expectedCommandPath(input.ordinal, input.commandClass),
    log: Buffer.concat(chunks),
  });
}

export async function runPhase8SourceValidation(input: {
  readonly projectRoot: string;
  readonly parentDirectory: string;
  readonly validationId: string;
  readonly authority: FrozenPhase8ManifestAuthority;
  readonly onCommandStart?: (
    commandClass: Phase8SourceValidationCommandClass,
    ordinal: number,
  ) => void;
}): Promise<
  Readonly<{
    runDirectory: string;
    record: Phase8SourceValidation;
    payloadSha256: string;
  }>
> {
  const sourceBefore = await captureSourceSnapshot(input.projectRoot);
  const results: Phase8SourceValidationCommandResult[] = [];
  for (
    let index = 0;
    index < PHASE8_SOURCE_VALIDATION_COMMANDS.length;
    index += 1
  ) {
    const command = PHASE8_SOURCE_VALIDATION_COMMANDS[index];
    if (command === undefined) {
      throw new Error("Frozen source-validation command disappeared.");
    }
    input.onCommandStart?.(command.commandClass, index + 1);
    const result = await runNpmCommand({
      projectRoot: input.projectRoot,
      ordinal: index + 1,
      commandClass: command.commandClass,
      command: command.command,
      npmArgs: command.npmArgs,
    });
    results.push(result);
    if (result.exitCode !== 0 || result.signal !== null) {
      throw new Error(
        `${command.command} failed; no passing source-validation attestation was created.`,
      );
    }
  }
  const sourceAfter = await captureSourceSnapshot(input.projectRoot);
  return writePhase8SourceValidationArtifact({
    parentDirectory: input.parentDirectory,
    validationId: input.validationId,
    createdAt: new Date().toISOString(),
    authority: input.authority,
    sourceBefore,
    sourceAfter,
    commandResults: results,
  });
}

export async function verifyPhase8SourceValidationArtifact(input: {
  readonly runDirectory: string;
  readonly authority: FrozenPhase8ManifestAuthority;
  readonly projectRoot?: string;
}): Promise<Phase8SourceValidationVerification> {
  const failures: string[] = [];
  let record: Phase8SourceValidation | null = null;
  let payloadSha256: string | null = null;
  try {
    const attestationPayload = await readFile(
      join(input.runDirectory, "attestation.json"),
      "utf8",
    );
    record = phase8SourceValidationSchema.parse(
      JSON.parse(attestationPayload) as unknown,
    );
    if (attestationPayload !== canonicalJson(record)) {
      failures.push(
        "Source-validation attestation is not canonical byte-identical JSON.",
      );
    }
    payloadSha256 = sha256Bytes(attestationPayload);
  } catch (error) {
    failures.push(
      `Unable to parse source-validation attestation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (record !== null) {
    const binding = authorityBinding(input.authority);
    for (const [key, expected] of Object.entries(binding)) {
      if (record[key as keyof typeof record] !== expected) {
        failures.push(
          `Source-validation authority binding ${key} does not match.`,
        );
      }
    }
    try {
      const files = await recursiveFiles(input.runDirectory);
      if (stableStringify(files) !== stableStringify(expectedFiles(record))) {
        failures.push("Source-validation artifact file set is not exact.");
      }
      const checksums = parseChecksums(
        await readFile(join(input.runDirectory, "checksums.sha256"), "utf8"),
        failures,
      );
      for (const file of files.filter(
        (candidate) => candidate !== "checksums.sha256",
      )) {
        const bytes = await readFile(join(input.runDirectory, file));
        if (checksums.get(file) !== sha256Bytes(bytes)) {
          failures.push(`Source-validation checksum mismatch for ${file}.`);
        }
      }
      if (checksums.size !== files.length - 1) {
        failures.push(
          "Source-validation checksum count does not match the payload set.",
        );
      }
      for (const command of record.commands) {
        const bytes = await readFile(join(input.runDirectory, command.logPath));
        if (
          bytes.byteLength !== command.logByteCount ||
          sha256Bytes(bytes) !== command.logSha256
        ) {
          failures.push(
            `Source-validation command log mismatch for ${command.commandClass}.`,
          );
        }
      }
    } catch (error) {
      failures.push(
        `Unable to verify source-validation payloads: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (input.projectRoot !== undefined) {
      try {
        const current = sourceSnapshotProjection(
          await captureSourceSnapshot(input.projectRoot),
        );
        if (stableStringify(current) !== stableStringify(record.sourceAfter)) {
          failures.push(
            "Current clean source does not match the validated source snapshot.",
          );
        }
      } catch (error) {
        failures.push(
          `Unable to reproduce current source snapshot: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  return Object.freeze({
    valid: failures.length === 0,
    runDirectory: input.runDirectory,
    failures: Object.freeze(failures),
    record,
    payloadSha256,
  });
}
