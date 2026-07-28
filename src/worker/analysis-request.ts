import {
  exportGameArchive,
  replayTimeline,
  type GameTimeline,
} from "../events/timeline";
import { stableHash } from "../events/stable-hash";
import type { SolverBudgetId, SolverSeedSet } from "../search";
import {
  ANALYSIS_WORKER_PROTOCOL_VERSION,
  analysisBindingSchema,
  analysisWorkerRequestSchema,
  type AnalysisBinding,
  type AnalysisWorkerRequest,
} from "./analysis-protocol";

export function createAnalysisWorkerRequest(input: {
  readonly timeline: GameTimeline;
  readonly requestOrdinal: number;
  readonly sessionEpoch: number;
  readonly budgetId: SolverBudgetId;
  readonly seeds?: Partial<SolverSeedSet>;
  readonly binding: AnalysisBinding;
}): AnalysisWorkerRequest {
  const replay = replayTimeline(input.timeline);
  const publicStateHash = stableHash(replay.state);
  const binding = analysisBindingSchema.parse(input.binding);
  const requestId = stableHash({
    schemaVersion: 1,
    protocolVersion: ANALYSIS_WORKER_PROTOCOL_VERSION,
    requestOrdinal: input.requestOrdinal,
    sessionEpoch: input.sessionEpoch,
    stateVersion: input.timeline.cursor,
    historyHash: replay.semanticHash,
    publicStateHash,
    budgetId: input.budgetId,
    seeds: input.seeds ?? {},
    binding,
  });

  return analysisWorkerRequestSchema.parse({
    schemaVersion: 2,
    protocolVersion: ANALYSIS_WORKER_PROTOCOL_VERSION,
    type: "analyze",
    requestId,
    requestOrdinal: input.requestOrdinal,
    sessionEpoch: input.sessionEpoch,
    stateVersion: input.timeline.cursor,
    historyHash: replay.semanticHash,
    publicStateHash,
    budgetId: input.budgetId,
    timelineArchive: exportGameArchive(input.timeline),
    seeds: input.seeds ?? {},
    binding,
  });
}
