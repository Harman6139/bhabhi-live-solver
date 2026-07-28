import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod";

import { stableStringify } from "../events/stable-hash";
import {
  PHASE8_TERMINAL_BEHAVIOR_EXACT_ID,
  PHASE8_TERMINAL_BEHAVIOR_ID,
  PHASE8_TERMINAL_EXACT_ID,
  PHASE8_TERMINAL_REFERENCE_ID,
} from "./phase8-terminal-policy";
import {
  phase8TerminalSeedRecordSchema,
  phase8TerminalSummaryInputSchema,
} from "./phase8-terminal-schema";
import { verifyPhase8TerminalArtifacts } from "./phase8-terminal-artifacts";
import {
  crossedPairedClusterBootstrap,
  evaluatePhase8StyleCatastrophe,
  evaluatePhase8TerminalGate,
  validatePhase8CompleteMatrix,
  type Phase8MatrixOutcome,
  type Phase8PairedBootstrapResult,
  type Phase8StyleCatastropheGate,
} from "./phase8-statistics";
import {
  PHASE8_BOOTSTRAP_RESAMPLES,
  phase8Sha256,
  type Phase8SplitPlan,
} from "./phase8-manifest";

export const PHASE8_TERMINAL_REPORT_VERSION =
  "phase8-terminal-statistical-report-v1" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const probabilitySchema = z.number().min(0).max(1);
const terminalGateSchema = z
  .object({
    estimate: z.number(),
    oneSidedUpper: z.number(),
    twoSidedLower: z.number(),
    twoSidedUpper: z.number(),
    noninferiorityMargin: z.literal(0.005),
    practicalTieMargin: z.literal(0.0025),
    noninferiorityGate: z.boolean(),
    improvementGate: z.boolean(),
    finalBeatsGate: z.boolean(),
    practicalTieGate: z.boolean(),
  })
  .strict();
const styleGateSchema = z
  .object({
    styleCellId: z.string().min(1),
    estimate: z.number(),
    oneSidedLower: z.number(),
    pointThreshold: z.literal(0.05),
    lowerThreshold: z.literal(0.02),
    catastrophic: z.boolean(),
    styleSafetyGate: z.boolean(),
  })
  .strict();
const configurationReportSchema = z
  .object({
    configId: z.string().min(1),
    completedGames: z.int().positive(),
    userBhabhiGames: z.int().nonnegative(),
    terminalBhabhiRate: probabilitySchema,
    terminalGate: terminalGateSchema.nullable(),
    styleGates: z.array(styleGateSchema),
    styleSafetyGate: z.boolean(),
    exactIncrementalComparatorConfigId: z.string().min(1).nullable(),
    exactIncrementalGate: z.boolean().nullable(),
    exactIncrementalContrast: terminalGateSchema.nullable(),
  })
  .strict();

export const phase8TerminalStatisticalReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolId: z.literal("eval-v1"),
    reportVersion: z.literal(PHASE8_TERMINAL_REPORT_VERSION),
    runId: z.string().min(1),
    split: z.enum(["qualification", "final"]),
    mode: z.enum(["paired", "reference-one-arm"]),
    manifestId: z.string().min(1),
    manifestSha256: sha256Schema,
    sourceSha256: sha256Schema,
    productionModelSha256: sha256Schema,
    configurationRegistrySha256: sha256Schema,
    terminalArtifactScientificDigest: sha256Schema,
    referenceConfigId: z.literal(PHASE8_TERMINAL_REFERENCE_ID),
    configurationIds: z.array(z.string().min(1)).min(1).max(4),
    metricIds: z.array(z.string().min(1)).min(1),
    contrastIds: z.array(z.string().min(1)),
    bootstrapSeedMaterialSha256: sha256Schema.nullable(),
    bootstrap: z.unknown().nullable(),
    configurations: z.array(configurationReportSchema).min(1).max(4),
    regeneratedMatrix: z
      .object({
        expectedOutcomes: z.int().positive(),
        observedOutcomes: z.int().nonnegative(),
        completeMatrixGate: z.boolean(),
        zeroFailureGate: z.boolean(),
        zeroCapGate: z.boolean(),
        zeroCancellationGate: z.boolean(),
        evidenceGate: z.boolean(),
      })
      .strict(),
    terminalArtifactGate: z.boolean(),
    deterministicRegenerationGate: z.literal(true),
    oneArmNoSyntheticContrastGate: z.boolean(),
    evidenceGate: z.boolean(),
    reportSha256: sha256Schema,
  })
  .strict();

export type Phase8TerminalConfigurationReport = z.infer<
  typeof configurationReportSchema
>;
export type Phase8TerminalStatisticalReport = Omit<
  z.infer<typeof phase8TerminalStatisticalReportSchema>,
  "bootstrap"
> & {
  readonly bootstrap: Phase8PairedBootstrapResult | null;
};

type ContrastDefinition = Readonly<{
  contrastId: string;
  candidateConfigId: string;
  referenceConfigId: string;
}>;

type ClusterMetrics = Readonly<Record<string, number>>;

async function readNdjson<T>(
  path: string,
  parse: (value: unknown) => T,
): Promise<readonly T[]> {
  const output: T[] = [];
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.length === 0) {
      throw new Error(
        `${path} contains a blank NDJSON line at ${lineNumber.toString()}.`,
      );
    }
    output.push(parse(JSON.parse(line) as unknown));
  }
  return output;
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("Terminal report cannot average an empty outcome set.");
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function coordinateKey(input: {
  readonly configId: string;
  readonly styleCellId: string;
  readonly baseIndex: number;
  readonly rotation: number;
}): string {
  return [
    input.configId,
    input.styleCellId,
    input.baseIndex.toString(),
    input.rotation.toString(),
  ].join("/");
}

function contrastId(
  candidateConfigId: string,
  referenceConfigId: string,
): string {
  return `${candidateConfigId}--minus--${referenceConfigId}`;
}

function contrastDefinitions(
  split: "qualification" | "final",
  configurationIds: readonly string[],
): readonly ContrastDefinition[] {
  const reference = PHASE8_TERMINAL_REFERENCE_ID;
  if (!configurationIds.includes(reference)) {
    throw new Error("Terminal report has no frozen reference arm.");
  }
  const values: ContrastDefinition[] = configurationIds
    .filter((configId) => configId !== reference)
    .map((candidateConfigId) => ({
      contrastId: contrastId(candidateConfigId, reference),
      candidateConfigId,
      referenceConfigId: reference,
    }));
  if (
    split === "qualification" &&
    configurationIds.includes(PHASE8_TERMINAL_BEHAVIOR_ID) &&
    configurationIds.includes(PHASE8_TERMINAL_BEHAVIOR_EXACT_ID)
  ) {
    values.push({
      contrastId: contrastId(
        PHASE8_TERMINAL_BEHAVIOR_EXACT_ID,
        PHASE8_TERMINAL_BEHAVIOR_ID,
      ),
      candidateConfigId: PHASE8_TERMINAL_BEHAVIOR_EXACT_ID,
      referenceConfigId: PHASE8_TERMINAL_BEHAVIOR_ID,
    });
  }
  return values.sort((left, right) =>
    left.contrastId.localeCompare(right.contrastId),
  );
}

function metricsForConfigBase(input: {
  readonly configId: string;
  readonly baseIndex: number;
  readonly styleCellIds: readonly string[];
  readonly outcomes: ReadonlyMap<string, 0 | 1>;
}): ClusterMetrics {
  const all: number[] = [];
  const metrics: Record<string, number> = {};
  for (const styleCellId of input.styleCellIds) {
    const style: number[] = [];
    for (const rotation of [0, 1, 2] as const) {
      const value = input.outcomes.get(
        coordinateKey({
          configId: input.configId,
          styleCellId,
          baseIndex: input.baseIndex,
          rotation,
        }),
      );
      if (value === undefined) {
        throw new Error(
          `Terminal report is missing ${input.configId}/${styleCellId}/${input.baseIndex.toString()}/${rotation.toString()}.`,
        );
      }
      style.push(value);
      all.push(value);
    }
    metrics[`style:${styleCellId}`] = average(style);
  }
  metrics["terminal-macro"] = average(all);
  return Object.freeze(metrics);
}

function contrastFor(
  bootstrap: Phase8PairedBootstrapResult,
  definition: ContrastDefinition,
  metricId: string,
) {
  const value = bootstrap.contrasts.find(
    (candidate) =>
      candidate.candidateConfigId === definition.contrastId &&
      candidate.metricId === metricId,
  );
  if (value === undefined) {
    throw new Error(
      `Terminal bootstrap omitted ${definition.contrastId}/${metricId}.`,
    );
  }
  return value;
}

function reportProjection(value: unknown): unknown {
  return value;
}

function validateStoredBootstrap(
  value: unknown,
): Phase8PairedBootstrapResult | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "object" ||
    Reflect.get(value, "method") !==
      "crossed-paired-cluster-bootstrap-max-statistic-v1" ||
    Reflect.get(value, "resamples") !== PHASE8_BOOTSTRAP_RESAMPLES
  ) {
    throw new Error("Terminal report bootstrap envelope is invalid.");
  }
  return value as Phase8PairedBootstrapResult;
}

export async function createPhase8TerminalStatisticalReport(
  runDirectory: string,
): Promise<Phase8TerminalStatisticalReport> {
  const verification = await verifyPhase8TerminalArtifacts(runDirectory);
  if (
    !verification.ok ||
    verification.manifest === null ||
    verification.summary === null
  ) {
    throw new Error(
      `Verified terminal artifact required: ${verification.failures.join("; ")}`,
    );
  }
  const manifest = verification.manifest;
  const summary = verification.summary;
  if (manifest.split !== "qualification" && manifest.split !== "final") {
    throw new Error(
      "Terminal statistical reports accept only qualification or final artifacts.",
    );
  }
  const split: "qualification" | "final" = manifest.split;
  const inputs = await readNdjson(
    join(runDirectory, "summary-inputs.ndjson"),
    (value) => phase8TerminalSummaryInputSchema.parse(value),
  );
  const seeds = await readNdjson(join(runDirectory, "seeds.ndjson"), (value) =>
    phase8TerminalSeedRecordSchema.parse(value),
  );
  const plan: Phase8SplitPlan = {
    split,
    baseIndexStart: manifest.baseIndexStart,
    baseCount: manifest.baseCount,
    rotations: manifest.rotations,
    replicates: [manifest.replicate],
    styleCellIds: manifest.styleCellIds,
    eventCap: manifest.eventCap,
  };
  const matrix = validatePhase8CompleteMatrix({
    plan,
    configurationIds: manifest.configurationIds,
    outcomes: inputs.map((record): Phase8MatrixOutcome => ({
      split,
      configId: record.configId,
      styleCellId: record.styleCellId,
      baseIndex: record.baseIndex,
      rotation: record.rotation,
      replicate: record.replicate,
      status: record.status,
    })),
  });
  if (
    stableStringify(matrix) !== stableStringify(summary.matrix) ||
    !matrix.evidenceGate
  ) {
    throw new Error(
      "Terminal report matrix does not reproduce the verified artifact summary.",
    );
  }
  const outcomes = new Map<string, 0 | 1>();
  for (const record of inputs) {
    if (record.status !== "complete" || record.userBhabhi === null) {
      throw new Error(
        "A confirmatory terminal report cannot contain an incomplete outcome.",
      );
    }
    const key = coordinateKey(record);
    if (outcomes.has(key)) {
      throw new Error(`Duplicate terminal outcome ${key}.`);
    }
    outcomes.set(key, record.userBhabhi);
  }

  const definitions = contrastDefinitions(split, manifest.configurationIds);
  const mode = definitions.length === 0 ? "reference-one-arm" : "paired";
  if (
    (mode === "reference-one-arm" &&
      stableStringify(manifest.configurationIds) !==
        stableStringify([PHASE8_TERMINAL_REFERENCE_ID])) ||
    (mode === "paired" && manifest.configurationIds.length < 2)
  ) {
    throw new Error("Terminal report arm mode is inconsistent.");
  }
  const metricIds = [
    "terminal-macro",
    ...manifest.styleCellIds.map((styleCellId) => `style:${styleCellId}`),
  ];
  const metricsByConfigBase = new Map<string, ClusterMetrics>();
  for (const configId of manifest.configurationIds) {
    for (
      let baseIndex = manifest.baseIndexStart;
      baseIndex < manifest.baseIndexStart + manifest.baseCount;
      baseIndex += 1
    ) {
      metricsByConfigBase.set(
        `${configId}/${baseIndex.toString()}`,
        metricsForConfigBase({
          configId,
          baseIndex,
          styleCellIds: manifest.styleCellIds,
          outcomes,
        }),
      );
    }
  }

  const uniqueBootstrapSeeds = [
    ...new Set(seeds.map((record) => record.seedIds.bootstrap)),
  ].sort();
  const bootstrapSeedMaterialSha256 =
    mode === "paired"
      ? phase8Sha256({
          kind: "phase8-terminal-report-bootstrap-seed-v1",
          manifestSha256: manifest.authorityManifestSha256,
          split,
          openedBootstrapSeedIds: uniqueBootstrapSeeds,
        })
      : null;
  let bootstrap: Phase8PairedBootstrapResult | null = null;
  if (mode === "paired" && bootstrapSeedMaterialSha256 !== null) {
    const observations: {
      clusterId: string;
      pairingKey: string;
      configId: string;
      metrics: Readonly<Record<string, number>>;
    }[] = [];
    for (
      let baseIndex = manifest.baseIndexStart;
      baseIndex < manifest.baseIndexStart + manifest.baseCount;
      baseIndex += 1
    ) {
      observations.push({
        clusterId: `${split}/${baseIndex.toString()}`,
        pairingKey: "all-17-style-cells-and-3-rotations",
        configId: "contrast-zero",
        metrics: Object.fromEntries(metricIds.map((metricId) => [metricId, 0])),
      });
      for (const definition of definitions) {
        const candidate = metricsByConfigBase.get(
          `${definition.candidateConfigId}/${baseIndex.toString()}`,
        );
        const reference = metricsByConfigBase.get(
          `${definition.referenceConfigId}/${baseIndex.toString()}`,
        );
        if (candidate === undefined || reference === undefined) {
          throw new Error(
            `Terminal contrast ${definition.contrastId} lacks a frozen arm.`,
          );
        }
        observations.push({
          clusterId: `${split}/${baseIndex.toString()}`,
          pairingKey: "all-17-style-cells-and-3-rotations",
          configId: definition.contrastId,
          metrics: Object.fromEntries(
            metricIds.map((metricId) => [
              metricId,
              (candidate[metricId] ?? Number.NaN) -
                (reference[metricId] ?? Number.NaN),
            ]),
          ),
        });
      }
    }
    bootstrap = crossedPairedClusterBootstrap({
      observations,
      referenceConfigId: "contrast-zero",
      candidateConfigIds: definitions.map(
        (definition) => definition.contrastId,
      ),
      metricIds,
      seed: bootstrapSeedMaterialSha256,
      resamples: PHASE8_BOOTSTRAP_RESAMPLES,
    });
  }

  const configurationReports: Phase8TerminalConfigurationReport[] =
    manifest.configurationIds.map((configId) => {
      const values = inputs
        .filter((record) => record.configId === configId)
        .map((record) => record.userBhabhi);
      if (values.some((value) => value === null)) {
        throw new Error(`${configId} has a missing terminal outcome.`);
      }
      const numeric = values as (0 | 1)[];
      const referenceDefinition = definitions.find(
        (definition) =>
          definition.candidateConfigId === configId &&
          definition.referenceConfigId === PHASE8_TERMINAL_REFERENCE_ID,
      );
      const terminalGate =
        bootstrap === null || referenceDefinition === undefined
          ? null
          : evaluatePhase8TerminalGate(
              contrastFor(bootstrap, referenceDefinition, "terminal-macro"),
            );
      const styleGates: (Phase8StyleCatastropheGate & {
        styleCellId: string;
      })[] =
        bootstrap === null || referenceDefinition === undefined
          ? []
          : manifest.styleCellIds.map((styleCellId) => ({
              styleCellId,
              ...evaluatePhase8StyleCatastrophe(
                contrastFor(
                  bootstrap,
                  referenceDefinition,
                  `style:${styleCellId}`,
                ),
              ),
            }));
      const exactComparator =
        configId === PHASE8_TERMINAL_EXACT_ID
          ? PHASE8_TERMINAL_REFERENCE_ID
          : configId === PHASE8_TERMINAL_BEHAVIOR_EXACT_ID
            ? PHASE8_TERMINAL_BEHAVIOR_ID
            : null;
      const exactDefinition =
        exactComparator === null
          ? undefined
          : definitions.find(
              (definition) =>
                definition.candidateConfigId === configId &&
                definition.referenceConfigId === exactComparator,
            );
      const exactIncrementalContrast =
        bootstrap === null || exactDefinition === undefined
          ? null
          : evaluatePhase8TerminalGate(
              contrastFor(bootstrap, exactDefinition, "terminal-macro"),
            );
      return {
        configId,
        completedGames: numeric.length,
        userBhabhiGames: numeric.reduce<number>(
          (total, value) => total + value,
          0,
        ),
        terminalBhabhiRate: average(numeric),
        terminalGate,
        styleGates,
        styleSafetyGate: styleGates.every((gate) => gate.styleSafetyGate),
        exactIncrementalComparatorConfigId: exactComparator,
        exactIncrementalGate:
          exactComparator === null
            ? null
            : (exactIncrementalContrast?.improvementGate ?? false),
        exactIncrementalContrast,
      };
    });

  const primaryConfigurationReport = configurationReports[0];
  const oneArmNoSyntheticContrastGate =
    mode !== "reference-one-arm" ||
    (bootstrap === null &&
      definitions.length === 0 &&
      primaryConfigurationReport !== undefined &&
      primaryConfigurationReport.terminalGate === null &&
      primaryConfigurationReport.styleGates.length === 0);

  const withoutHash: Omit<Phase8TerminalStatisticalReport, "reportSha256"> = {
    schemaVersion: 1,
    protocolId: "eval-v1",
    reportVersion: PHASE8_TERMINAL_REPORT_VERSION,
    runId: manifest.runId,
    split,
    mode,
    manifestId: manifest.authorityManifestId,
    manifestSha256: manifest.authorityManifestSha256,
    sourceSha256: manifest.sourceSha256,
    productionModelSha256: manifest.productionModelSha256,
    configurationRegistrySha256: manifest.configRegistrySha256,
    terminalArtifactScientificDigest: summary.scientificDigest,
    referenceConfigId: PHASE8_TERMINAL_REFERENCE_ID,
    configurationIds: manifest.configurationIds,
    metricIds,
    contrastIds: definitions.map((definition) => definition.contrastId),
    bootstrapSeedMaterialSha256,
    bootstrap,
    configurations: configurationReports,
    regeneratedMatrix: {
      expectedOutcomes: matrix.expectedOutcomes,
      observedOutcomes: matrix.observedOutcomes,
      completeMatrixGate: matrix.completeMatrixGate,
      zeroFailureGate: matrix.zeroFailureGate,
      zeroCapGate: matrix.zeroCapGate,
      zeroCancellationGate: matrix.zeroCancellationGate,
      evidenceGate: matrix.evidenceGate,
    },
    terminalArtifactGate: summary.evidenceGate,
    deterministicRegenerationGate: true,
    oneArmNoSyntheticContrastGate,
    evidenceGate:
      summary.evidenceGate &&
      (mode !== "reference-one-arm" ||
        (bootstrap === null && definitions.length === 0)),
  };
  const parsed = phase8TerminalStatisticalReportSchema.parse({
    ...withoutHash,
    reportSha256: phase8Sha256(reportProjection(withoutHash)),
  });
  return Object.freeze({
    ...parsed,
    bootstrap: validateStoredBootstrap(parsed.bootstrap),
  });
}

export function verifyPhase8TerminalStatisticalReport(
  value: unknown,
): Phase8TerminalStatisticalReport {
  const parsed = phase8TerminalStatisticalReportSchema.parse(value);
  const { reportSha256, ...projection } = parsed;
  if (reportSha256 !== phase8Sha256(reportProjection(projection))) {
    throw new Error("Terminal statistical report checksum is invalid.");
  }
  const bootstrap = validateStoredBootstrap(parsed.bootstrap);
  if (
    (parsed.mode === "reference-one-arm" &&
      (bootstrap !== null ||
        parsed.contrastIds.length !== 0 ||
        !parsed.oneArmNoSyntheticContrastGate)) ||
    (parsed.mode === "paired" &&
      (bootstrap === null ||
        bootstrap.resamples !== PHASE8_BOOTSTRAP_RESAMPLES))
  ) {
    throw new Error("Terminal statistical report arm/bootstrap mode drifted.");
  }
  return Object.freeze({ ...parsed, bootstrap });
}

export async function writePhase8TerminalStatisticalReport(input: {
  readonly runDirectory: string;
  readonly outputPath: string;
}): Promise<Phase8TerminalStatisticalReport> {
  const report = await createPhase8TerminalStatisticalReport(
    input.runDirectory,
  );
  const { writeFile } = await import("node:fs/promises");
  await writeFile(input.outputPath, `${stableStringify(report)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return report;
}

export async function readPhase8TerminalStatisticalReport(
  path: string,
): Promise<Phase8TerminalStatisticalReport> {
  const payload = await readFile(path, "utf8");
  const report = verifyPhase8TerminalStatisticalReport(
    JSON.parse(payload) as unknown,
  );
  if (payload !== `${stableStringify(report)}\n`) {
    throw new Error("Terminal statistical report is not canonical JSON.");
  }
  return report;
}
