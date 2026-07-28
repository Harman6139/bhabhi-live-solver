import { afterEach, describe, expect, it, vi } from "vitest";

import { createBrowserLatencyAnalysisWorker } from "../../src/benchmark/latency-browser";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser latency worker route", () => {
  it("uses the isolated evaluation worker instead of the live production worker", () => {
    const constructions: {
      readonly url: string;
      readonly options: WorkerOptions | undefined;
    }[] = [];
    class WorkerStub {
      constructor(url: URL | string, options?: WorkerOptions) {
        constructions.push({ url: String(url), options });
      }
    }
    vi.stubGlobal("Worker", WorkerStub);

    createBrowserLatencyAnalysisWorker();

    expect(constructions).toHaveLength(1);
    expect(constructions[0]?.url).toContain("evaluation-solver.worker.ts");
    expect(constructions[0]?.options).toEqual({
      type: "module",
      name: "bhabhi-analysis-evaluation",
    });
  });
});
