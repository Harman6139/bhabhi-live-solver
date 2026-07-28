import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIRECTORY, "../..");
const ADVANCED_SOURCE_FILES = [
  "src/search/advanced-types.ts",
  "src/search/advanced-config.ts",
  "src/search/weighted-hypotheses.ts",
  "src/search/policy-kernel.ts",
  "src/search/observable-key.ts",
  "src/search/exact-hypotheses.ts",
  "src/search/exact-endgame.ts",
  "src/search/model-sensitivity.ts",
  "src/search/exact-model-sensitivity.ts",
  "src/search/research-dispatch.ts",
] as const;

describe("advanced-search truth firewall", () => {
  it("has no simulator imports, dynamic imports, require calls, or truth APIs", () => {
    for (const relativePath of ADVANCED_SOURCE_FILES) {
      const source = fs.readFileSync(
        path.join(PROJECT_ROOT, relativePath),
        "utf8",
      );
      expect(source, relativePath).not.toMatch(
        /\bfrom\s+["'][^"']*simulator(?:\/|["'])/u,
      );
      expect(source, relativePath).not.toMatch(/\bimport\s*\(\s*[^)]/u);
      expect(source, relativePath).not.toMatch(/\brequire\s*\(/u);
      expect(source, relativePath).not.toMatch(
        /\b(?:createSimulatorTruth|revealTruth|omniscientState)\b/u,
      );
    }
  });

  it("keeps the foundation disconnected from the Phase 5 production entry", () => {
    const searchIndex = fs.readFileSync(
      path.join(PROJECT_ROOT, "src/search/index.ts"),
      "utf8",
    );
    for (const moduleName of [
      "advanced-types",
      "advanced-config",
      "weighted-hypotheses",
      "policy-kernel",
      "observable-key",
      "exact-hypotheses",
      "exact-endgame",
      "model-sensitivity",
      "exact-model-sensitivity",
      "research-dispatch",
    ]) {
      expect(searchIndex).not.toContain(moduleName);
    }
  });
});
