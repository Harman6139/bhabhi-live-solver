import { installBrowserLatencyHarness } from "./latency-browser";
import { PHASE8_LATENCY_BENCHMARK_VERSION } from "./latency-contract";

const status = document.querySelector<HTMLElement>("#latency-status");

try {
  installBrowserLatencyHarness();
  if (status !== null) {
    status.dataset.ready = "true";
    status.textContent = `${PHASE8_LATENCY_BENCHMARK_VERSION} ready`;
  }
} catch (error) {
  if (status !== null) {
    status.dataset.ready = "false";
    status.textContent = error instanceof Error ? error.message : String(error);
  }
  throw error;
}
