import { stableHash } from "../events/stable-hash";
import { compareUserActions } from "./actions";
import type { UserAction } from "./types";

export const PUBLIC_HISTORY_ROOT_TIE_BREAK_VERSION =
  "public-history-root-tie-break-v1" as const;

export type RootRiskCandidate = Readonly<{
  action: UserAction;
  actionKey: string;
  risk: number;
}>;

export type RootTieBreakContext = Readonly<{
  historyHash: string;
  publicStateHash: string;
  searchSeedId: string;
}>;

export function rootTieBreakKey(
  context: RootTieBreakContext,
  candidateActionKey: string,
): string {
  return stableHash({
    schemaVersion: 1,
    tieBreakVersion: PUBLIC_HISTORY_ROOT_TIE_BREAK_VERSION,
    historyHash: context.historyHash,
    publicStateHash: context.publicStateHash,
    searchSeedId: context.searchSeedId,
    candidateActionKey,
  });
}

/**
 * Preserve the computed risk ordering exactly. Only bit-identical risk ties
 * use a public-history-keyed deterministic order. The canonical action order
 * is retained solely as the collision fallback.
 */
export function compareRootRiskCandidates(
  context: RootTieBreakContext,
  left: RootRiskCandidate,
  right: RootRiskCandidate,
): number {
  const riskDifference = left.risk - right.risk;
  if (riskDifference !== 0) {
    return riskDifference;
  }
  const tieDifference = rootTieBreakKey(context, left.actionKey).localeCompare(
    rootTieBreakKey(context, right.actionKey),
  );
  return tieDifference || compareUserActions(left.action, right.action);
}
