import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

function productionReleaseBundleJson(): string {
  const configuredPath = process.env.BHABHI_RELEASE_BUNDLE_PATH;
  if (configuredPath === undefined || configuredPath.trim().length === 0) {
    return "";
  }
  const path = resolve(projectRoot, configuredPath);
  const payload = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch (cause) {
    throw new Error(`Release bundle is not JSON: ${path}`, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || !("mode" in parsed)) {
    throw new Error(`Release bundle has no mode: ${path}`);
  }
  const expectedMode = process.env.BHABHI_RELEASE_EXPECT_MODE;
  const actualMode = (parsed as { readonly mode?: unknown }).mode;
  if (expectedMode !== undefined && expectedMode !== actualMode) {
    throw new Error(
      `Release bundle mode ${String(actualMode)} does not match required mode ${expectedMode}.`,
    );
  }
  return payload;
}

export default defineConfig({
  plugins: [react()],
  define: {
    __BHABHI_PRODUCTION_RELEASE_BUNDLE_JSON__: JSON.stringify(
      productionReleaseBundleJson(),
    ),
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        app: resolve(projectRoot, "index.html"),
        latency: resolve(projectRoot, "latency.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/main.tsx"],
    },
  },
});
