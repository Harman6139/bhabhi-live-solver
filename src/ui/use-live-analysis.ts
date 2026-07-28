import { useCallback, useEffect, useRef, useState } from "react";

import type { GameTimeline } from "../events/timeline";
import {
  loadEmbeddedLiveProductionBinding,
  type ProductionAnalysis,
  type ProductionAnalysisBinding,
} from "../production";
import type { SolverBudgetId } from "../search";
import {
  AnalysisWorkerClient,
  createAnalysisWorkerRequest,
  createBrowserAnalysisWorker,
  type AnalysisCancellationReason,
  type AnalysisWorkerFactory,
} from "../worker";
import type { AnalysisIncident } from "./DiagnosticsPanel";

export type LiveAnalysisStatus =
  | "loading-release"
  | "idle"
  | "analyzing"
  | "ready"
  | "unavailable"
  | "failure";

export type LiveAnalysisState = Readonly<{
  status: LiveAnalysisStatus;
  analysis: ProductionAnalysis | null;
  refining: boolean;
  message: string | null;
  lastIncident: AnalysisIncident | null;
}>;

type LiveAnalysisDependencies = Readonly<{
  loadBinding?: () => Promise<ProductionAnalysisBinding>;
  workerFactory?: AnalysisWorkerFactory;
}>;

function incident(
  kind: AnalysisIncident["kind"],
  message: string,
): AnalysisIncident {
  return {
    kind,
    message,
    at: new Date().toISOString(),
  };
}

/**
 * Runs an immediate first pass and then the selected budget. Every public-state
 * change invalidates and terminates the preceding worker before another result
 * can publish.
 */
export function useLiveAnalysis(input: {
  readonly timeline: GameTimeline;
  readonly sessionEpoch: number;
  readonly enabled: boolean;
  readonly selectedBudget: SolverBudgetId;
  readonly dependencies?: LiveAnalysisDependencies;
}): LiveAnalysisState & {
  readonly invalidate: (
    reason?: Extract<AnalysisCancellationReason, "state-invalidated">,
  ) => void;
} {
  const [binding, setBinding] = useState<ProductionAnalysisBinding | null>(
    null,
  );
  const [state, setState] = useState<LiveAnalysisState>({
    status: "loading-release",
    analysis: null,
    refining: false,
    message: null,
    lastIncident: null,
  });
  const clientRef = useRef<AnalysisWorkerClient | null>(null);
  const generationRef = useRef(0);
  const requestOrdinalRef = useRef(0);
  const bindingLoader =
    input.dependencies?.loadBinding ?? loadEmbeddedLiveProductionBinding;
  const workerFactory =
    input.dependencies?.workerFactory ?? createBrowserAnalysisWorker;

  useEffect(() => {
    const client = new AnalysisWorkerClient(workerFactory);
    clientRef.current = client;
    let active = true;
    void bindingLoader()
      .then((loaded) => {
        if (active) {
          setBinding(loaded);
          setState((current) => ({
            ...current,
            status: "idle",
            message: null,
          }));
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setBinding(null);
          setState({
            status: "unavailable",
            analysis: null,
            refining: false,
            message:
              error instanceof Error
                ? error.message
                : "The selected production release is unavailable.",
            lastIncident: incident(
              "failure",
              "Production release verification failed.",
            ),
          });
        }
      });
    return () => {
      active = false;
      generationRef.current += 1;
      client.dispose();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
    };
  }, [bindingLoader, workerFactory]);

  const invalidate = useCallback(
    (
      reason: Extract<
        AnalysisCancellationReason,
        "state-invalidated"
      > = "state-invalidated",
    ): void => {
      generationRef.current += 1;
      clientRef.current?.invalidate(reason);
      setState((current) => ({
        status: binding === null ? current.status : "idle",
        analysis: null,
        refining: false,
        message: null,
        lastIncident:
          current.analysis === null && current.status === "idle"
            ? current.lastIncident
            : incident("cancellation", "Public state changed."),
      }));
    },
    [binding],
  );

  useEffect(() => {
    const client = clientRef.current;
    if (binding === null || client === null) {
      return;
    }
    generationRef.current += 1;
    const generation = generationRef.current;
    client.invalidate();
    if (!input.enabled) {
      queueMicrotask(() => {
        if (generationRef.current === generation) {
          setState((current) => ({
            status: "idle",
            analysis: null,
            refining: false,
            message: null,
            lastIncident: current.lastIncident,
          }));
        }
      });
      return;
    }

    const run = async (): Promise<void> => {
      setState((current) => ({
        status: "analyzing",
        analysis: null,
        refining: input.selectedBudget !== "instant",
        message: "Computing an Instant recommendation…",
        lastIncident: current.lastIncident,
      }));
      const budgets: readonly SolverBudgetId[] =
        input.selectedBudget === "instant"
          ? ["instant"]
          : ["instant", input.selectedBudget];
      let published: ProductionAnalysis | null = null;
      for (let index = 0; index < budgets.length; index += 1) {
        const budgetId = budgets[index];
        if (budgetId === undefined || generationRef.current !== generation) {
          return;
        }
        requestOrdinalRef.current += 1;
        const request = createAnalysisWorkerRequest({
          timeline: input.timeline,
          requestOrdinal: requestOrdinalRef.current,
          sessionEpoch: input.sessionEpoch,
          budgetId,
          binding,
        });
        const outcome = await client.analyze(request);
        if (generationRef.current !== generation) {
          return;
        }
        if (outcome.status === "cancelled") {
          return;
        }
        if (outcome.status === "failure") {
          setState({
            status: "failure",
            analysis: published,
            refining: false,
            message: outcome.response.message,
            lastIncident: incident("failure", outcome.response.message),
          });
          return;
        }
        published = outcome.response.result;
        const refining = index + 1 < budgets.length;
        setState((current) => ({
          status: "ready",
          analysis: published,
          refining,
          message: refining
            ? `Instant ready; refining with ${input.selectedBudget}…`
            : null,
          lastIncident: current.lastIncident,
        }));
      }
    };
    void run().catch((error: unknown) => {
      if (generationRef.current === generation) {
        const message =
          error instanceof Error
            ? error.message
            : "Live analysis failed unexpectedly.";
        setState({
          status: "failure",
          analysis: null,
          refining: false,
          message,
          lastIncident: incident("failure", message),
        });
      }
    });
    return () => {
      generationRef.current += 1;
      client.invalidate();
    };
  }, [
    binding,
    input.enabled,
    input.selectedBudget,
    input.sessionEpoch,
    input.timeline,
  ]);

  return { ...state, invalidate };
}
