import { z } from "zod";

import { stableStringify } from "../events/stable-hash";

export const PHASE8_HARD_ONLY_MODEL_VERSION =
  "phase8-hard-only-model-not-applicable-v1" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const phase8HardOnlyModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("phase8-production-model-not-applicable"),
    artifactVersion: z.literal(PHASE8_HARD_ONLY_MODEL_VERSION),
    sourceSha256: sha256Schema,
    reason: z.literal("qualification-registry-has-no-behavior-role"),
  })
  .strict();

export type Phase8HardOnlyModel = z.infer<typeof phase8HardOnlyModelSchema>;

export function createPhase8HardOnlyModel(
  sourceSha256: string,
): Phase8HardOnlyModel {
  return Object.freeze(
    phase8HardOnlyModelSchema.parse({
      schemaVersion: 1,
      artifactKind: "phase8-production-model-not-applicable",
      artifactVersion: PHASE8_HARD_ONLY_MODEL_VERSION,
      sourceSha256,
      reason: "qualification-registry-has-no-behavior-role",
    }),
  );
}

export function serializePhase8HardOnlyModel(
  value: Phase8HardOnlyModel,
): string {
  return stableStringify(phase8HardOnlyModelSchema.parse(value));
}

export function parsePhase8HardOnlyModel(
  serialized: string,
): Phase8HardOnlyModel {
  const parsed = phase8HardOnlyModelSchema.parse(
    JSON.parse(serialized) as unknown,
  );
  if (serialized !== stableStringify(parsed)) {
    throw new Error(
      "Hard-only model-not-applicable bytes are not canonical JSON.",
    );
  }
  return Object.freeze(parsed);
}
