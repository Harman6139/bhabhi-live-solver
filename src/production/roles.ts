import { z } from "zod";

export const PRODUCTION_ROLE_IDS = [
  "p8-r-hard-balanced-v1",
  "p8-e-exact-hard-fallback-v1",
  "p8-b-behavior-balanced-v1",
  "p8-be-behavior-exact-fallback-v1",
] as const;

export type ProductionRoleId = (typeof PRODUCTION_ROLE_IDS)[number];

export const productionRoleIdSchema = z.enum(PRODUCTION_ROLE_IDS);

export const PRODUCTION_ROUTING_CONTRACTS = {
  "p8-r-hard-balanced-v1": "direct-phase5-hard-only",
  "p8-e-exact-hard-fallback-v1": "exact-hard-then-byte-identical-r",
  "p8-b-behavior-balanced-v1": "behavior-weighted-refuse-on-failure",
  "p8-be-behavior-exact-fallback-v1": "behavior-exact-then-byte-identical-b",
} as const satisfies Readonly<Record<ProductionRoleId, string>>;

export type ProductionRoutingContract =
  (typeof PRODUCTION_ROUTING_CONTRACTS)[ProductionRoleId];

export const productionRoutingContractSchema = z.enum(
  Object.values(PRODUCTION_ROUTING_CONTRACTS) as [
    ProductionRoutingContract,
    ...ProductionRoutingContract[],
  ],
);

export const PRODUCTION_ROLE_COMPONENTS = {
  "p8-r-hard-balanced-v1": {
    exactEndgame: false,
    behaviorWeighting: false,
  },
  "p8-e-exact-hard-fallback-v1": {
    exactEndgame: true,
    behaviorWeighting: false,
  },
  "p8-b-behavior-balanced-v1": {
    exactEndgame: false,
    behaviorWeighting: true,
  },
  "p8-be-behavior-exact-fallback-v1": {
    exactEndgame: true,
    behaviorWeighting: true,
  },
} as const satisfies Readonly<
  Record<
    ProductionRoleId,
    Readonly<{ exactEndgame: boolean; behaviorWeighting: boolean }>
  >
>;

export const PRODUCTION_ROLE_FALLBACKS = {
  "p8-r-hard-balanced-v1": null,
  "p8-e-exact-hard-fallback-v1": "p8-r-hard-balanced-v1",
  "p8-b-behavior-balanced-v1": null,
  "p8-be-behavior-exact-fallback-v1": "p8-b-behavior-balanced-v1",
} as const satisfies Readonly<
  Record<ProductionRoleId, ProductionRoleId | null>
>;

export function isBehaviorProductionRole(role: ProductionRoleId): boolean {
  return PRODUCTION_ROLE_COMPONENTS[role].behaviorWeighting;
}

export function isExactProductionRole(role: ProductionRoleId): boolean {
  return PRODUCTION_ROLE_COMPONENTS[role].exactEndgame;
}
