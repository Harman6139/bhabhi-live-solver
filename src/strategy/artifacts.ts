import { z } from "zod";

import { stableHash } from "../events/stable-hash";
import {
  counterexampleBoundaryRecordSchema,
  pairedActionValueRecordSchema,
  strategyCommandRecordSchema,
  strategyEvidenceSummarySchema,
  strategyFailureRecordSchema,
  strategyStateRecordSchema,
  type CounterexampleBoundaryRecord,
  type PairedActionValueRecord,
  type StrategyCommandRecord,
  type StrategyEvidenceSummary,
  type StrategyFailureRecord,
  type StrategyStateRecord,
} from "./evidence";
import { MOTIF_IDS, MOTIF_REGISTRY } from "./registry";

export const STRATEGY_ARTIFACT_KINDS = [
  "manifest",
  "states",
  "action-values",
  "counterexamples",
  "failures",
  "summary",
  "command",
] as const;
export type StrategyArtifactKind = (typeof STRATEGY_ARTIFACT_KINDS)[number];

const nonEmptyStringSchema = z.string().trim().min(1);
const checksumSchema = z.string().trim().min(1);
const evidenceClassSchema = z.enum([
  "development",
  "train",
  "tune",
  "qualification",
  "final",
]);

const runIdentityShape = {
  schemaVersion: z.literal(1),
  runId: nonEmptyStringSchema,
  evidenceClass: evidenceClassSchema,
};

export const strategyManifestPayloadSchema = z
  .object({
    ...runIdentityShape,
    protocolId: nonEmptyStringSchema,
    sourceRevision: nonEmptyStringSchema,
    registryChecksum: checksumSchema,
    evidenceBundleChecksum: checksumSchema,
    declaredMotifIds: z.array(z.enum(MOTIF_IDS)).length(MOTIF_IDS.length),
    artifactChecksums: z
      .object({
        states: checksumSchema,
        actionValues: checksumSchema,
        counterexamples: checksumSchema,
        failures: checksumSchema,
        summary: checksumSchema,
        command: checksumSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      new Set(payload.declaredMotifIds).size !== MOTIF_IDS.length ||
      MOTIF_IDS.some((id) => !payload.declaredMotifIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["declaredMotifIds"],
        message: "manifest must declare M01-M48 exactly once",
      });
    }
  });
export type StrategyManifestPayload = z.infer<
  typeof strategyManifestPayloadSchema
>;

export const strategyStatesPayloadSchema = z
  .object({
    ...runIdentityShape,
    records: z.array(strategyStateRecordSchema),
  })
  .strict();
export type StrategyStatesPayload = z.infer<typeof strategyStatesPayloadSchema>;

export const strategyActionValuesPayloadSchema = z
  .object({
    ...runIdentityShape,
    records: z.array(pairedActionValueRecordSchema),
  })
  .strict();
export type StrategyActionValuesPayload = z.infer<
  typeof strategyActionValuesPayloadSchema
>;

export const strategyCounterexamplesPayloadSchema = z
  .object({
    ...runIdentityShape,
    records: z.array(counterexampleBoundaryRecordSchema),
  })
  .strict();
export type StrategyCounterexamplesPayload = z.infer<
  typeof strategyCounterexamplesPayloadSchema
>;

export const strategyFailuresPayloadSchema = z
  .object({
    ...runIdentityShape,
    records: z.array(strategyFailureRecordSchema),
  })
  .strict();
export type StrategyFailuresPayload = z.infer<
  typeof strategyFailuresPayloadSchema
>;

export const strategySummaryPayloadSchema = z
  .object({
    ...runIdentityShape,
    evidenceBundleChecksum: checksumSchema,
    summary: strategyEvidenceSummarySchema,
  })
  .strict();
export type StrategySummaryPayload = z.infer<
  typeof strategySummaryPayloadSchema
>;

export const strategyCommandPayloadSchema = z
  .object({
    ...runIdentityShape,
    records: z.array(strategyCommandRecordSchema),
  })
  .strict();
export type StrategyCommandPayload = z.infer<
  typeof strategyCommandPayloadSchema
>;

export type ChecksummedStrategyArtifact<
  Kind extends StrategyArtifactKind,
  Payload,
> = {
  readonly schemaVersion: 1;
  readonly artifactKind: Kind;
  readonly payload: Payload;
  readonly payloadChecksum: string;
};

export type StrategyManifestArtifact = ChecksummedStrategyArtifact<
  "manifest",
  StrategyManifestPayload
>;
export type StrategyStatesArtifact = ChecksummedStrategyArtifact<
  "states",
  StrategyStatesPayload
>;
export type StrategyActionValuesArtifact = ChecksummedStrategyArtifact<
  "action-values",
  StrategyActionValuesPayload
>;
export type StrategyCounterexamplesArtifact = ChecksummedStrategyArtifact<
  "counterexamples",
  StrategyCounterexamplesPayload
>;
export type StrategyFailuresArtifact = ChecksummedStrategyArtifact<
  "failures",
  StrategyFailuresPayload
>;
export type StrategySummaryArtifact = ChecksummedStrategyArtifact<
  "summary",
  StrategySummaryPayload
>;
export type StrategyCommandArtifact = ChecksummedStrategyArtifact<
  "command",
  StrategyCommandPayload
>;
export type StrategyArtifact =
  | StrategyManifestArtifact
  | StrategyStatesArtifact
  | StrategyActionValuesArtifact
  | StrategyCounterexamplesArtifact
  | StrategyFailuresArtifact
  | StrategySummaryArtifact
  | StrategyCommandArtifact;

const artifactEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.enum(STRATEGY_ARTIFACT_KINDS),
    payload: z.unknown(),
    payloadChecksum: checksumSchema,
  })
  .strict();

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function canonicalStates(
  records: readonly StrategyStateRecord[],
): StrategyStateRecord[] {
  return [...records].sort((left, right) =>
    compareText(left.stateId, right.stateId),
  );
}

function canonicalActionValues(
  records: readonly PairedActionValueRecord[],
): PairedActionValueRecord[] {
  return [...records].sort((left, right) =>
    compareText(left.actionValueId, right.actionValueId),
  );
}

function canonicalCounterexamples(
  records: readonly CounterexampleBoundaryRecord[],
): CounterexampleBoundaryRecord[] {
  return [...records].sort((left, right) =>
    compareText(left.boundaryRecordId, right.boundaryRecordId),
  );
}

function canonicalFailures(
  records: readonly StrategyFailureRecord[],
): StrategyFailureRecord[] {
  return [...records].sort((left, right) =>
    compareText(left.failureId, right.failureId),
  );
}

function canonicalCommands(
  records: readonly StrategyCommandRecord[],
): StrategyCommandRecord[] {
  return [...records].sort((left, right) =>
    compareText(left.commandId, right.commandId),
  );
}

export function strategyRegistryChecksum(): string {
  return stableHash({
    schemaVersion: 1,
    registry: MOTIF_REGISTRY,
  });
}

export function strategyArtifactPayloadChecksum(
  artifactKind: StrategyArtifactKind,
  payload: unknown,
): string {
  return stableHash({
    schemaVersion: 1,
    artifactKind,
    payload,
  });
}

function wrapArtifact<Kind extends StrategyArtifactKind, Payload>(
  artifactKind: Kind,
  payload: Payload,
): ChecksummedStrategyArtifact<Kind, Payload> {
  return {
    schemaVersion: 1,
    artifactKind,
    payload,
    payloadChecksum: strategyArtifactPayloadChecksum(artifactKind, payload),
  };
}

export function createStrategyManifestArtifact(
  value: StrategyManifestPayload,
): StrategyManifestArtifact {
  const payload = strategyManifestPayloadSchema.parse({
    ...value,
    declaredMotifIds: [...value.declaredMotifIds].sort(compareText),
  });
  return wrapArtifact("manifest", payload);
}

export function createStrategyStatesArtifact(
  value: StrategyStatesPayload,
): StrategyStatesArtifact {
  const parsed = strategyStatesPayloadSchema.parse(value);
  const payload = strategyStatesPayloadSchema.parse({
    ...parsed,
    records: canonicalStates(parsed.records),
  });
  return wrapArtifact("states", payload);
}

export function createStrategyActionValuesArtifact(
  value: StrategyActionValuesPayload,
): StrategyActionValuesArtifact {
  const parsed = strategyActionValuesPayloadSchema.parse(value);
  const payload = strategyActionValuesPayloadSchema.parse({
    ...parsed,
    records: canonicalActionValues(parsed.records),
  });
  return wrapArtifact("action-values", payload);
}

export function createStrategyCounterexamplesArtifact(
  value: StrategyCounterexamplesPayload,
): StrategyCounterexamplesArtifact {
  const parsed = strategyCounterexamplesPayloadSchema.parse(value);
  const payload = strategyCounterexamplesPayloadSchema.parse({
    ...parsed,
    records: canonicalCounterexamples(parsed.records),
  });
  return wrapArtifact("counterexamples", payload);
}

export function createStrategyFailuresArtifact(
  value: StrategyFailuresPayload,
): StrategyFailuresArtifact {
  const parsed = strategyFailuresPayloadSchema.parse(value);
  const payload = strategyFailuresPayloadSchema.parse({
    ...parsed,
    records: canonicalFailures(parsed.records),
  });
  return wrapArtifact("failures", payload);
}

export function createStrategySummaryArtifact(value: {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly evidenceClass: z.infer<typeof evidenceClassSchema>;
  readonly evidenceBundleChecksum: string;
  readonly summary: StrategyEvidenceSummary;
}): StrategySummaryArtifact {
  const payload = strategySummaryPayloadSchema.parse(value);
  return wrapArtifact("summary", payload);
}

export function createStrategyCommandArtifact(
  value: StrategyCommandPayload,
): StrategyCommandArtifact {
  const parsed = strategyCommandPayloadSchema.parse(value);
  const payload = strategyCommandPayloadSchema.parse({
    ...parsed,
    records: canonicalCommands(parsed.records),
  });
  return wrapArtifact("command", payload);
}

export function verifyStrategyArtifactChecksum(
  value: unknown,
): value is StrategyArtifact {
  const envelope = artifactEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return false;
  }
  return (
    envelope.data.payloadChecksum ===
    strategyArtifactPayloadChecksum(
      envelope.data.artifactKind,
      envelope.data.payload,
    )
  );
}
