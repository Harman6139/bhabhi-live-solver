import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  phase8LatencyManifestSchema,
  type Phase8LatencyManifest,
} from "../src/benchmark/latency-artifacts";
import { stableStringify } from "../src/events/stable-hash";
import {
  PRODUCTION_RELEASE_BUNDLE_VERSION,
  verifyProductionReleaseBundle,
  type EvaluationProductionBundle,
  type ProductionArtifactEnvelope,
} from "../src/production/release-contract";
import { productionRoleIdSchema } from "../src/production/roles";

function required(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function envelope(bytes: string): ProductionArtifactEnvelope {
  return {
    bytes,
    sha256: createHash("sha256").update(bytes, "utf8").digest("hex"),
  };
}

function manifestFromAuthority(value: unknown): Phase8LatencyManifest {
  if (value === null || typeof value !== "object") {
    throw new Error("Authority artifact is not an object.");
  }
  return phase8LatencyManifestSchema.parse(Reflect.get(value, "manifest"));
}

async function main(): Promise<void> {
  const authorityPath = resolve(required("--authority"));
  const modelPath = resolve(required("--model"));
  const outputPath = resolve(required("--output"));
  const configId = productionRoleIdSchema.parse(required("--config-id"));
  const authority = JSON.parse(
    await readFile(authorityPath, "utf8"),
  ) as unknown;
  const manifest = manifestFromAuthority(authority);
  const descriptor = manifest.configurations.find(
    (candidate) => candidate.configId === configId,
  );
  if (descriptor === undefined) {
    throw new Error(`${configId} is not in the supplied authority.`);
  }
  const scope =
    manifest.manifestVersion === "phase8-final-evaluation-manifest-v1"
      ? "final"
      : "qualification";
  const bundle: EvaluationProductionBundle = {
    schemaVersion: 1,
    releaseVersion: PRODUCTION_RELEASE_BUNDLE_VERSION,
    mode: "evaluation-only",
    scope,
    sourceHash: manifest.hashes.sourceSha256,
    protocolHash: manifest.hashes.preregistrationSha256,
    manifest: envelope(stableStringify(manifest)),
    descriptor: envelope(stableStringify(descriptor)),
    productionModel: envelope(await readFile(modelPath, "utf8")),
  };
  const verified = await verifyProductionReleaseBundle(bundle, {
    allowEvaluationOnly: true,
  });
  await writeFile(outputPath, `${stableStringify(bundle)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({
      outputPath,
      scope,
      configId,
      manifestSha256: verified.binding.manifestHash,
      modelSha256: verified.binding.modelHash,
      binding: verified.binding,
    })}\n`,
  );
}

await main();
