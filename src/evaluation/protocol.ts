import { createHash } from "node:crypto";

import { CANONICAL_RULES, type RuleConfig } from "../domain/rule-config";
import type { Seat } from "../domain/seats";
import { stableHash, stableStringify } from "../events/stable-hash";
import type { BaselinePolicyId } from "../simulator/policies";

export const EVALUATION_PROTOCOL_ID = "eval-v1" as const;
export const EVALUATION_SPLITS = [
  "dev",
  "train",
  "tune",
  "qualification",
  "final",
] as const;
export type EvaluationSplit = (typeof EVALUATION_SPLITS)[number];

export const SEED_STREAMS = [
  "p2-policy",
  "p3-policy",
  "chance",
  "belief",
  "search",
  "rollout",
  "bootstrap",
] as const;
export type EvaluationSeedStream = (typeof SEED_STREAMS)[number];

export type StyleCell = {
  readonly id: string;
  readonly p2: BaselinePolicyId;
  readonly p3: BaselinePolicyId;
};

export const STYLE_CELLS: readonly StyleCell[] = Object.freeze([
  { id: "c01_random__random", p2: "random", p3: "random" },
  {
    id: "c02_always-high__always-high",
    p2: "always-high",
    p3: "always-high",
  },
  {
    id: "c03_always-low__always-low",
    p2: "always-low",
    p3: "always-low",
  },
  {
    id: "c04_shortest-suit__shortest-suit",
    p2: "shortest-suit",
    p3: "shortest-suit",
  },
  {
    id: "c05_early-high-shedder__early-high-shedder",
    p2: "early-high-shedder",
    p3: "early-high-shedder",
  },
  {
    id: "c06_power-avoider__power-avoider",
    p2: "power-avoider",
    p3: "power-avoider",
  },
  {
    id: "c07_documented-basic__documented-basic",
    p2: "documented-basic",
    p3: "documented-basic",
  },
  {
    id: "c08_always-high__always-low",
    p2: "always-high",
    p3: "always-low",
  },
  {
    id: "c09_always-low__always-high",
    p2: "always-low",
    p3: "always-high",
  },
  {
    id: "c10_shortest-suit__early-high-shedder",
    p2: "shortest-suit",
    p3: "early-high-shedder",
  },
  {
    id: "c11_early-high-shedder__shortest-suit",
    p2: "early-high-shedder",
    p3: "shortest-suit",
  },
  {
    id: "c12_power-avoider__documented-basic",
    p2: "power-avoider",
    p3: "documented-basic",
  },
  {
    id: "c13_documented-basic__power-avoider",
    p2: "documented-basic",
    p3: "power-avoider",
  },
  {
    id: "c14_random__documented-basic",
    p2: "random",
    p3: "documented-basic",
  },
  {
    id: "c15_documented-basic__random",
    p2: "documented-basic",
    p3: "random",
  },
  {
    id: "c16_noisy-mixture__phase-switch",
    p2: "noisy-mixture",
    p3: "phase-switch",
  },
  {
    id: "c17_phase-switch__noisy-mixture",
    p2: "phase-switch",
    p3: "noisy-mixture",
  },
]);

export const REQUIRED_BASELINE_USER_POLICIES = [
  "random",
  "always-high",
  "always-low",
  "shortest-suit",
  "early-high-shedder",
  "power-avoider",
  "documented-basic",
] as const satisfies readonly BaselinePolicyId[];

export type BatchPlan = {
  readonly schemaVersion: 1;
  readonly protocolId: typeof EVALUATION_PROTOCOL_ID;
  readonly runId: string;
  readonly split: EvaluationSplit;
  readonly evidenceClass: string;
  readonly evidenceEligible: boolean;
  readonly ruleProfileId: string;
  readonly rules: RuleConfig;
  readonly userPolicyIds: readonly BaselinePolicyId[];
  readonly styleCellIds: readonly string[];
  readonly baseIndexStart: number;
  readonly baseCount: number;
  readonly rotations: readonly (0 | 1 | 2)[];
  readonly replicates: readonly number[];
  readonly eventCap: number;
};

export type GameSpec = {
  readonly schemaVersion: 1;
  readonly protocolId: typeof EVALUATION_PROTOCOL_ID;
  readonly runId: string;
  readonly split: EvaluationSplit;
  readonly evidenceClass: string;
  readonly configId: string;
  readonly userPolicyId: BaselinePolicyId;
  readonly ruleProfileId: string;
  readonly rules: RuleConfig;
  readonly styleCellId: string;
  readonly opponentPolicies: Readonly<
    Pick<Record<Seat, BaselinePolicyId>, "p2" | "p3">
  >;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly replicate: number;
  readonly clusterId: string;
  readonly scenarioId: string;
  readonly gameId: string;
  readonly eventCap: number;
  readonly seeds: {
    readonly deal: string;
    readonly userPolicy: string;
    readonly p2Policy: string;
    readonly p3Policy: string;
    readonly chance: string;
    readonly belief: string;
    readonly search: string;
    readonly bootstrap: string;
  };
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function deriveDealSeed(
  split: EvaluationSplit,
  baseIndex: number,
): string {
  return sha256Hex(
    `bhabhi/${EVALUATION_PROTOCOL_ID}|${split}|deal|${baseIndex.toString()}`,
  ).slice(0, 32);
}

export function deriveStreamSeed(input: {
  readonly split: EvaluationSplit;
  readonly stream: EvaluationSeedStream;
  readonly cell: string;
  readonly baseIndex: number;
  readonly rotation: 0 | 1 | 2;
  readonly replicate: number;
}): string {
  return sha256Hex(
    [
      `bhabhi/${EVALUATION_PROTOCOL_ID}`,
      input.split,
      input.stream,
      input.cell,
      input.baseIndex.toString(),
      input.rotation.toString(),
      input.replicate.toString(),
    ].join("|"),
  ).slice(0, 32);
}

export function canonicalRuleProfileId(rules: RuleConfig): string {
  return rules === CANONICAL_RULES ||
    stableStringify(rules) === stableStringify(CANONICAL_RULES)
    ? "canonical-v1"
    : stableHash({ kind: "rule-profile", rules });
}

export function createPhase4SmokePlan(runId: string, baseCount = 4): BatchPlan {
  return {
    schemaVersion: 1,
    protocolId: EVALUATION_PROTOCOL_ID,
    runId,
    split: "dev",
    evidenceClass: "phase4-smoke",
    evidenceEligible: false,
    ruleProfileId: "canonical-v1",
    rules: structuredClone(CANONICAL_RULES),
    userPolicyIds: [...REQUIRED_BASELINE_USER_POLICIES],
    styleCellIds: STYLE_CELLS.map((cell) => cell.id),
    baseIndexStart: 0,
    baseCount,
    rotations: [0, 1, 2],
    replicates: [0],
    eventCap: 4_096,
  };
}

function requireStyleCell(id: string): StyleCell {
  const cell = STYLE_CELLS.find((candidate) => candidate.id === id);
  if (cell === undefined) {
    throw new Error(`Unknown opponent style cell ${id}.`);
  }
  return cell;
}

export function expectedGameCount(plan: BatchPlan): number {
  return (
    plan.userPolicyIds.length *
    plan.styleCellIds.length *
    plan.baseCount *
    plan.rotations.length *
    plan.replicates.length
  );
}

export function expandBatchPlan(plan: BatchPlan): readonly GameSpec[] {
  if (plan.baseCount <= 0 || !Number.isSafeInteger(plan.baseCount)) {
    throw new RangeError("Batch baseCount must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(plan.eventCap) || plan.eventCap <= 0) {
    throw new RangeError("Batch eventCap must be a positive safe integer.");
  }
  const specs: GameSpec[] = [];
  for (const userPolicyId of plan.userPolicyIds) {
    const configId = `baseline-${userPolicyId}-v1`;
    for (const styleCellId of plan.styleCellIds) {
      const cell = requireStyleCell(styleCellId);
      for (
        let baseIndex = plan.baseIndexStart;
        baseIndex < plan.baseIndexStart + plan.baseCount;
        baseIndex += 1
      ) {
        for (const rotation of plan.rotations) {
          for (const replicate of plan.replicates) {
            const scenarioId = [
              plan.split,
              cell.id,
              baseIndex.toString(),
              rotation.toString(),
              replicate.toString(),
              plan.ruleProfileId,
            ].join("/");
            const seedInput = {
              split: plan.split,
              cell: cell.id,
              baseIndex,
              rotation,
              replicate,
            } as const;
            specs.push({
              schemaVersion: 1,
              protocolId: EVALUATION_PROTOCOL_ID,
              runId: plan.runId,
              split: plan.split,
              evidenceClass: plan.evidenceClass,
              configId,
              userPolicyId,
              ruleProfileId: plan.ruleProfileId,
              rules: structuredClone(plan.rules),
              styleCellId: cell.id,
              opponentPolicies: {
                p2: cell.p2,
                p3: cell.p3,
              },
              baseIndex,
              rotation,
              replicate,
              clusterId: `${plan.split}/${baseIndex.toString()}`,
              scenarioId,
              gameId: sha256Hex(`${scenarioId}|${configId}`),
              eventCap: plan.eventCap,
              seeds: {
                deal: deriveDealSeed(plan.split, baseIndex),
                userPolicy: deriveStreamSeed({
                  ...seedInput,
                  stream: "rollout",
                }),
                p2Policy: deriveStreamSeed({
                  ...seedInput,
                  stream: "p2-policy",
                }),
                p3Policy: deriveStreamSeed({
                  ...seedInput,
                  stream: "p3-policy",
                }),
                chance: deriveStreamSeed({
                  ...seedInput,
                  stream: "chance",
                }),
                belief: deriveStreamSeed({
                  ...seedInput,
                  stream: "belief",
                }),
                search: deriveStreamSeed({
                  ...seedInput,
                  stream: "search",
                }),
                bootstrap: deriveStreamSeed({
                  ...seedInput,
                  stream: "bootstrap",
                }),
              },
            });
          }
        }
      }
    }
  }
  if (specs.length !== expectedGameCount(plan)) {
    throw new Error("Expanded batch cardinality does not match its plan.");
  }
  const identities = new Set(specs.map((spec) => spec.gameId));
  if (identities.size !== specs.length) {
    throw new Error("Expanded batch contains duplicate game IDs.");
  }
  return Object.freeze(specs);
}
