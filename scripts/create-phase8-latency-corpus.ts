import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  phase8LatencyManifestSchema,
  type Phase8LatencyManifest,
} from "../src/benchmark/latency-artifacts";
import { createReferenceReleaseLatencyCorpus } from "../src/benchmark/release-corpus";
import { phase8Sha256 } from "../src/evaluation/phase8-manifest";
import { stableStringify } from "../src/events/stable-hash";

function required(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function extractManifest(value: unknown): Phase8LatencyManifest {
  if (value === null || typeof value !== "object") {
    throw new Error("Authority artifact is not an object.");
  }
  return phase8LatencyManifestSchema.parse(Reflect.get(value, "manifest"));
}

async function main(): Promise<void> {
  const authorityPath = resolve(required("--authority"));
  const outputPath = resolve(required("--output"));
  const corpusId = required("--corpus-id");
  const manifest = extractManifest(
    JSON.parse(await readFile(authorityPath, "utf8")) as unknown,
  );
  const split =
    manifest.manifestVersion === "phase8-final-evaluation-manifest-v1"
      ? "final"
      : "qualification";
  const corpus = createReferenceReleaseLatencyCorpus({
    corpusId,
    createdAt: new Date().toISOString(),
    split,
    manifestId: manifest.manifestId,
    manifestSha256: phase8Sha256(manifest),
    protocolSha256: manifest.hashes.preregistrationSha256,
  });
  await writeFile(outputPath, `${stableStringify(corpus)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({
      outputPath,
      corpusId: corpus.corpusId,
      corpusSha256: corpus.corpusSha256,
      split: corpus.split,
      entries: corpus.entries.length,
    })}\n`,
  );
}

await main();
