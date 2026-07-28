import { parentPort } from "node:worker_threads";

import {
  runPhase8TerminalScenario,
  type Phase8TerminalScenarioInput,
} from "../src/evaluation/phase8-terminal-runner";

type Request = Readonly<{
  id: number;
  scenario: Phase8TerminalScenarioInput;
}>;

const port = parentPort;
if (port === null) {
  throw new Error("Phase 8 terminal worker requires a parent port.");
}

port.on("message", (request: Request) => {
  try {
    port.postMessage({
      id: request.id,
      ok: true,
      result: runPhase8TerminalScenario(request.scenario),
    });
  } catch (error) {
    port.postMessage({
      id: request.id,
      ok: false,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: "Error", message: String(error) },
    });
  }
});
