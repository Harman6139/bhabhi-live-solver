import {
  exportGameArchive,
  importGameArchive,
  replayTimeline,
  type GameTimeline,
} from "../events/timeline";
import { stableHash, stableStringify } from "../events/stable-hash";
import type { ProductionAnalysis } from "../production/analysis-result";
import type { AnalysisIncident } from "./DiagnosticsPanel";

export const PUBLIC_DEBUG_SNAPSHOT_VERSION =
  "public-debug-snapshot-v1" as const;

const FORBIDDEN_DEBUG_KEYS = new Set([
  "HiddenWorld",
  "hiddenWorld",
  "currentHands",
  "initialHands",
  "truth",
]);

export type PublicDebugSnapshot = Readonly<{
  schemaVersion: 1;
  snapshotVersion: typeof PUBLIC_DEBUG_SNAPSHOT_VERSION;
  createdAt: string;
  appVersion: "getaway-live-solver/0.1.0";
  publicArchive: string;
  identity: Readonly<{
    stateVersion: number;
    historyHash: string;
    publicStateHash: string;
    underlyingAnalysisId: string;
    analysisHash: string;
  }>;
  release: ProductionAnalysis["release"];
  rules: ProductionAnalysis["diagnostics"]["hardConstraints"]["rules"];
  knownCards: Readonly<{
    user: readonly string[];
    p2: readonly string[];
    p3: readonly string[];
  }>;
  knownVoids: ProductionAnalysis["diagnostics"]["hardConstraints"]["voidObservations"];
  estimatedVoids: Readonly<{
    status: "unavailable";
    reason: string;
  }>;
  support: ProductionAnalysis["diagnostics"]["hardConstraints"]["support"];
  belief: ProductionAnalysis["diagnostics"]["belief"];
  behavior: ProductionAnalysis["diagnostics"]["behavior"];
  sensitivity: ProductionAnalysis["diagnostics"]["sensitivity"];
  exact: ProductionAnalysis["diagnostics"]["exact"];
  search: Readonly<{
    route: ProductionAnalysis["route"];
    budgetId: ProductionAnalysis["budgetId"];
    work: ProductionAnalysis["diagnostics"]["work"];
    telemetry: ProductionAnalysis["telemetry"];
    reproducibility: ProductionAnalysis["reproducibility"];
    candidates: ProductionAnalysis["candidates"];
    warnings: ProductionAnalysis["warnings"];
    lastIncident: AnalysisIncident | null;
  }>;
  checksum: string;
}>;

type SnapshotProjection = Omit<PublicDebugSnapshot, "checksum">;

function snapshotChecksum(value: SnapshotProjection): string {
  return stableHash({
    schemaVersion: 1,
    snapshotVersion: PUBLIC_DEBUG_SNAPSHOT_VERSION,
    payload: value,
  });
}

function assertNoForbiddenKeys(
  value: unknown,
  path: readonly string[] = [],
): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoForbiddenKeys(entry, [...path, index.toString()]),
    );
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_DEBUG_KEYS.has(key)) {
      throw new TypeError(
        `Debug snapshot contains forbidden key ${[...path, key].join(".")}.`,
      );
    }
    assertNoForbiddenKeys(child, [...path, key]);
  }
}

export function createPublicDebugSnapshot(input: {
  readonly timeline: GameTimeline;
  readonly analysis: ProductionAnalysis;
  readonly lastIncident: AnalysisIncident | null;
  readonly createdAt?: string;
}): PublicDebugSnapshot {
  const replay = replayTimeline(input.timeline);
  if (
    input.analysis.identity.stateVersion !== input.timeline.cursor ||
    input.analysis.identity.historyHash !== replay.semanticHash
  ) {
    throw new Error(
      "Cannot export diagnostics for an analysis bound to another public history.",
    );
  }
  const projection: SnapshotProjection = {
    schemaVersion: 1,
    snapshotVersion: PUBLIC_DEBUG_SNAPSHOT_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    appVersion: "getaway-live-solver/0.1.0",
    publicArchive: exportGameArchive(input.timeline),
    identity: {
      ...input.analysis.identity,
      analysisHash: input.analysis.analysisHash,
    },
    release: input.analysis.release,
    rules: input.analysis.diagnostics.hardConstraints.rules,
    knownCards: {
      user: [...replay.state.userHand],
      p2: [...input.analysis.diagnostics.hardConstraints.knownOpponentCards.p2],
      p3: [...input.analysis.diagnostics.hardConstraints.knownOpponentCards.p3],
    },
    knownVoids: [
      ...input.analysis.diagnostics.hardConstraints.voidObservations,
    ],
    estimatedVoids: {
      status: "unavailable",
      reason:
        "ProductionAnalysis exposes hard chronological voids but no calibrated per-suit posterior void estimate.",
    },
    support: input.analysis.diagnostics.hardConstraints.support,
    belief: input.analysis.diagnostics.belief,
    behavior: input.analysis.diagnostics.behavior,
    sensitivity: input.analysis.diagnostics.sensitivity,
    exact: input.analysis.diagnostics.exact,
    search: {
      route: input.analysis.route,
      budgetId: input.analysis.budgetId,
      work: input.analysis.diagnostics.work,
      telemetry: input.analysis.telemetry,
      reproducibility: input.analysis.reproducibility,
      candidates: input.analysis.candidates,
      warnings: input.analysis.warnings,
      lastIncident: input.lastIncident,
    },
  };
  assertNoForbiddenKeys(projection);
  return Object.freeze({
    ...structuredClone(projection),
    checksum: snapshotChecksum(projection),
  });
}

export function serializePublicDebugSnapshot(
  snapshot: PublicDebugSnapshot,
): string {
  return `${stableStringify(parsePublicDebugSnapshot(snapshot))}\n`;
}

export function parsePublicDebugSnapshot(value: unknown): PublicDebugSnapshot {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as Partial<PublicDebugSnapshot>).schemaVersion !== 1 ||
    (value as Partial<PublicDebugSnapshot>).snapshotVersion !==
      PUBLIC_DEBUG_SNAPSHOT_VERSION ||
    typeof (value as Partial<PublicDebugSnapshot>).createdAt !== "string" ||
    typeof (value as Partial<PublicDebugSnapshot>).publicArchive !== "string" ||
    typeof (value as Partial<PublicDebugSnapshot>).checksum !== "string"
  ) {
    throw new TypeError(
      "Public debug snapshot is malformed or uses an unsupported version.",
    );
  }
  const snapshot = structuredClone(value) as PublicDebugSnapshot;
  assertNoForbiddenKeys(snapshot);
  const { checksum, ...projection } = snapshot;
  if (checksum !== snapshotChecksum(projection)) {
    throw new TypeError("Public debug snapshot checksum is invalid.");
  }
  if (!Number.isFinite(Date.parse(snapshot.createdAt))) {
    throw new TypeError("Public debug snapshot timestamp is invalid.");
  }
  const timeline = importGameArchive(snapshot.publicArchive);
  const replay = replayTimeline(timeline);
  if (
    exportGameArchive(timeline) !== snapshot.publicArchive ||
    timeline.cursor !== snapshot.identity.stateVersion ||
    replay.semanticHash !== snapshot.identity.historyHash
  ) {
    throw new TypeError(
      "Public debug snapshot archive does not match its analysis identity.",
    );
  }
  return Object.freeze(snapshot);
}

export function parseSerializedPublicDebugSnapshot(
  serialized: string,
): PublicDebugSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (cause) {
    throw new TypeError("Public debug snapshot is not valid JSON.", {
      cause,
    });
  }
  const snapshot = parsePublicDebugSnapshot(value);
  if (`${stableStringify(snapshot)}\n` !== serialized) {
    throw new TypeError(
      "Public debug snapshot is not canonical JSON plus one newline.",
    );
  }
  return snapshot;
}
