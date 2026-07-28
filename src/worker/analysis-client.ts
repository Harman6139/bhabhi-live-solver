import {
  parseAnalysisWorkerResponse,
  type AnalysisWorkerFailure,
  type AnalysisWorkerRequest,
  type AnalysisWorkerResponse,
  type AnalysisWorkerSuccess,
} from "./analysis-protocol";
import { stableStringify } from "../events/stable-hash";

export type AnalysisCancellationReason =
  "superseded" | "state-invalidated" | "disposed";

export type AnalysisClientOutcome =
  | {
      readonly status: "success";
      readonly response: AnalysisWorkerSuccess;
    }
  | {
      readonly status: "failure";
      readonly response: AnalysisWorkerFailure;
    }
  | {
      readonly status: "cancelled";
      readonly requestId: string;
      readonly reason: AnalysisCancellationReason;
    };

export type WorkerMessageEvent = {
  readonly data: unknown;
};

export type WorkerErrorEvent = {
  readonly message?: string;
};

export type AnalysisWorkerLike = {
  onmessage: ((event: WorkerMessageEvent) => void) | null;
  onerror: ((event: WorkerErrorEvent) => void) | null;
  postMessage(value: AnalysisWorkerRequest): void;
  terminate(): void;
};

export type AnalysisWorkerFactory = () => AnalysisWorkerLike;

type ActiveRequest = {
  readonly generation: number;
  readonly request: AnalysisWorkerRequest;
  readonly worker: AnalysisWorkerLike;
  readonly resolve: (outcome: AnalysisClientOutcome) => void;
  settled: boolean;
};

function sameBinding(
  left: AnalysisWorkerRequest["binding"],
  right: AnalysisWorkerResponse["binding"],
): boolean {
  return stableStringify(left) === stableStringify(right);
}

function responseMatchesRequest(
  request: AnalysisWorkerRequest,
  response: AnalysisWorkerResponse,
): boolean {
  return (
    response.requestId === request.requestId &&
    response.requestOrdinal === request.requestOrdinal &&
    response.sessionEpoch === request.sessionEpoch &&
    response.stateVersion === request.stateVersion &&
    response.historyHash === request.historyHash &&
    response.publicStateHash === request.publicStateHash &&
    sameBinding(request.binding, response.binding)
  );
}

function protocolFailure(
  request: AnalysisWorkerRequest,
  message: string,
): AnalysisWorkerFailure {
  return {
    schemaVersion: 2,
    protocolVersion: request.protocolVersion,
    type: "failure",
    requestId: request.requestId,
    requestOrdinal: request.requestOrdinal,
    sessionEpoch: request.sessionEpoch,
    stateVersion: request.stateVersion,
    historyHash: request.historyHash,
    publicStateHash: request.publicStateHash,
    binding: request.binding,
    code: "INVALID_ENVELOPE",
    message,
    searchCode: null,
  };
}

/**
 * Owns exactly one worker/request. Starting or invalidating an analysis settles
 * and terminates the previous worker before creating another. Identity checks
 * then make even a queued late message observationally inert.
 */
export class AnalysisWorkerClient {
  readonly #factory: AnalysisWorkerFactory;
  #generation = 0;
  #active: ActiveRequest | null = null;
  #disposed = false;

  constructor(factory: AnalysisWorkerFactory) {
    this.#factory = factory;
  }

  analyze(request: AnalysisWorkerRequest): Promise<AnalysisClientOutcome> {
    if (this.#disposed) {
      throw new Error("AnalysisWorkerClient has been disposed.");
    }
    this.#cancelActive("superseded");
    this.#generation += 1;
    const generation = this.#generation;
    const worker = this.#factory();

    return new Promise<AnalysisClientOutcome>((resolve) => {
      const active: ActiveRequest = {
        generation,
        request,
        worker,
        resolve,
        settled: false,
      };
      this.#active = active;

      worker.onmessage = (event) => {
        if (
          this.#active !== active ||
          active.generation !== this.#generation ||
          active.settled
        ) {
          return;
        }
        let response: AnalysisWorkerResponse;
        try {
          response = parseAnalysisWorkerResponse(event.data);
        } catch (error) {
          this.#settle(active, {
            status: "failure",
            response: protocolFailure(
              request,
              error instanceof Error
                ? `Invalid worker response: ${error.message}`
                : "Invalid worker response.",
            ),
          });
          return;
        }
        if (!responseMatchesRequest(request, response)) {
          this.#settle(active, {
            status: "failure",
            response: protocolFailure(
              request,
              "Worker response identity does not match the active request.",
            ),
          });
          return;
        }
        this.#settle(
          active,
          response.type === "success"
            ? { status: "success", response }
            : { status: "failure", response },
        );
      };
      worker.onerror = (event) => {
        if (this.#active !== active || active.settled) {
          return;
        }
        this.#settle(active, {
          status: "failure",
          response: protocolFailure(
            request,
            event.message === undefined
              ? "The analysis worker failed."
              : `The analysis worker failed: ${event.message}`,
          ),
        });
      };

      try {
        worker.postMessage(request);
      } catch (error) {
        this.#settle(active, {
          status: "failure",
          response: protocolFailure(
            request,
            error instanceof Error
              ? `Unable to post analysis request: ${error.message}`
              : "Unable to post analysis request.",
          ),
        });
      }
    });
  }

  invalidate(
    reason: Extract<
      AnalysisCancellationReason,
      "state-invalidated"
    > = "state-invalidated",
  ): void {
    this.#cancelActive(reason);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#cancelActive("disposed");
  }

  #settle(active: ActiveRequest, outcome: AnalysisClientOutcome): void {
    if (active.settled) {
      return;
    }
    active.settled = true;
    active.worker.onmessage = null;
    active.worker.onerror = null;
    active.worker.terminate();
    if (this.#active === active) {
      this.#active = null;
    }
    active.resolve(outcome);
  }

  #cancelActive(reason: AnalysisCancellationReason): void {
    const active = this.#active;
    if (active === null || active.settled) {
      return;
    }
    this.#settle(active, {
      status: "cancelled",
      requestId: active.request.requestId,
      reason,
    });
  }
}

export function createBrowserAnalysisWorker(): AnalysisWorkerLike {
  return new Worker(new URL("./solver.worker.ts", import.meta.url), {
    type: "module",
    name: "bhabhi-analysis",
  }) as unknown as AnalysisWorkerLike;
}

/**
 * Phase 8 harness entry only. The live UI must use
 * createBrowserAnalysisWorker(), whose worker refuses evaluation-only bundles.
 */
export function createBrowserEvaluationAnalysisWorker(): AnalysisWorkerLike {
  return new Worker(new URL("./evaluation-solver.worker.ts", import.meta.url), {
    type: "module",
    name: "bhabhi-analysis-evaluation",
  }) as unknown as AnalysisWorkerLike;
}
