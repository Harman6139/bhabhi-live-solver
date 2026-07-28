import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureSourceSnapshot,
  SOURCE_SNAPSHOT_EXCLUDED_FILES,
} from "../../src/evaluation/artifacts";

const temporaryDirectories: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bhabhi-source-snapshot-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "initial readme\n", "utf8");
  await writeFile(
    join(root, "docs", "final-report.md"),
    "initial report\n",
    "utf8",
  );
  await writeFile(
    join(root, "docs", "progress.md"),
    "initial progress\n",
    "utf8",
  );
  await writeFile(join(root, "src", "implementation.ts"), "export {};\n");
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("scientific source snapshot", () => {
  it("excludes only result-bearing documentation from the scientific hash", async () => {
    expect(SOURCE_SNAPSHOT_EXCLUDED_FILES).toEqual([
      "README.md",
      "docs/final-report.md",
      "docs/progress.md",
    ]);
    const root = await fixtureRoot();
    const before = await captureSourceSnapshot(root);

    await writeFile(join(root, "README.md"), "measured commands\n", "utf8");
    await writeFile(
      join(root, "docs", "final-report.md"),
      "measured results\n",
      "utf8",
    );
    await writeFile(
      join(root, "docs", "progress.md"),
      "final gate results\n",
      "utf8",
    );
    const afterReporting = await captureSourceSnapshot(root);
    expect(afterReporting.sourceSnapshotSha256).toBe(
      before.sourceSnapshotSha256,
    );
    expect(afterReporting.sourceFileCount).toBe(before.sourceFileCount);

    await writeFile(
      join(root, "src", "implementation.ts"),
      "export const changed = true;\n",
      "utf8",
    );
    const afterImplementation = await captureSourceSnapshot(root);
    expect(afterImplementation.sourceSnapshotSha256).not.toBe(
      before.sourceSnapshotSha256,
    );
    expect(afterImplementation.sourceFileCount).toBe(before.sourceFileCount);
  });
});
