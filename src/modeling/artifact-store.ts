import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  parseSelectedBehaviorModelArtifact,
  serializeSelectedBehaviorModelArtifact,
  type SelectedBehaviorModelArtifact,
} from "./behavior-fit";
import {
  parsePhase8ProductionModelArtifact,
  serializePhase8ProductionModelArtifact,
  type Phase8ProductionModelArtifact,
} from "./production-model";

/**
 * Writes a single immutable artifact file. The exclusive-create flag is the
 * write-once boundary: an existing path is never truncated or replaced.
 */
export async function writeSelectedBehaviorModelArtifact(
  path: string,
  artifact: SelectedBehaviorModelArtifact,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeSelectedBehaviorModelArtifact(artifact), {
    encoding: "utf8",
    flag: "wx",
  });
}

export async function readSelectedBehaviorModelArtifact(
  path: string,
): Promise<SelectedBehaviorModelArtifact> {
  return parseSelectedBehaviorModelArtifact(await readFile(path, "utf8"));
}

export async function writePhase8ProductionModelArtifact(
  path: string,
  artifact: Phase8ProductionModelArtifact,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializePhase8ProductionModelArtifact(artifact), {
    encoding: "utf8",
    flag: "wx",
  });
}

export async function readPhase8ProductionModelArtifact(
  path: string,
): Promise<Phase8ProductionModelArtifact> {
  return parsePhase8ProductionModelArtifact(await readFile(path, "utf8"));
}
