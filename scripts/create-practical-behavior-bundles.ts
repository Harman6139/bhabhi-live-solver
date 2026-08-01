import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BEHAVIOR_WEIGHTED_APPROXIMATE_ALGORITHM_VERSION } from "../src/search/behavior-weighted-approximate";
import { PUBLIC_HISTORY_ROOT_TIE_BREAK_VERSION } from "../src/search/root-tie-break";
import { SEARCH_ALGORITHM_VERSION } from "../src/search/types";
import {
  createPhase8ConfigurationDescriptor,
  freezePhase8Manifest,
  phase8Sha256,
  type Phase8ConfigurationDescriptor,
} from "../src/evaluation/phase8-manifest";
import {
  createPhase8TerminalConfigurationDescriptor,
  phase8TerminalRoleComponents,
  PHASE8_TERMINAL_BEHAVIOR_EXACT_ID,
  PHASE8_TERMINAL_BEHAVIOR_ID,
  PHASE8_TERMINAL_CONTINUATION_POLICY_HASH,
  PHASE8_TERMINAL_EXACT_CONFIG_HASH,
  PHASE8_TERMINAL_PHASE5_REFERENCE_CONFIG_HASH,
  PHASE8_TERMINAL_REFERENCE_ID,
  PHASE8_TERMINAL_ROUTING_CONTRACTS,
} from "../src/evaluation/phase8-terminal-policy";
import { PHASE8_TERMINAL_RUNNER_VERSION } from "../src/evaluation/phase8-terminal-schema";
import { stableStringify } from "../src/events/stable-hash";
import { readSelectedBehaviorModelArtifact } from "../src/modeling/artifact-store";
import {
  createPhase8PracticalBehaviorModelArtifact,
  phase8PracticalBehaviorModelConfig,
  serializePhase8PracticalBehaviorModelArtifact,
} from "../src/modeling/practical-behavior-model";
import {
  PRODUCTION_RELEASE_BUNDLE_VERSION,
  verifyProductionReleaseBundle,
  type EvaluationProductionBundle,
  type ProductionArtifactEnvelope,
} from "../src/production/release-contract";

const PRACTICAL_CONFIG_IDS = [
  PHASE8_TERMINAL_BEHAVIOR_ID,
  PHASE8_TERMINAL_BEHAVIOR_EXACT_ID,
] as const;

function valueAfter(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function envelope(bytes: string): ProductionArtifactEnvelope {
  return { bytes, sha256: sha256(bytes) };
}

function practicalDescriptor(input: {
  readonly configId: (typeof PRACTICAL_CONFIG_IDS)[number];
  readonly modelSha256: string;
  readonly modelSelectionContractHash: string;
  readonly worldCount: number;
  readonly robustChoice: boolean;
}): Phase8ConfigurationDescriptor {
  return createPhase8ConfigurationDescriptor({
    configId: input.configId,
    label:
      input.configId === PHASE8_TERMINAL_BEHAVIOR_ID
        ? "Practical unsealed behavior-weighted Balanced"
        : "Practical unsealed behavior exact with behavior fallback",
    role: "candidate",
    budgetId: "balanced",
    components: phase8TerminalRoleComponents(input.configId),
    implementation: {
      terminalRunnerVersion: PHASE8_TERMINAL_RUNNER_VERSION,
      hardOnlySearchAlgorithmVersion: SEARCH_ALGORITHM_VERSION,
      behaviorWeightedSearchAlgorithmVersion:
        BEHAVIOR_WEIGHTED_APPROXIMATE_ALGORITHM_VERSION,
      rootTieBreakVersion: PUBLIC_HISTORY_ROOT_TIE_BREAK_VERSION,
      routingContract: PHASE8_TERMINAL_ROUTING_CONTRACTS[input.configId],
      phase5ReferenceConfigHash: PHASE8_TERMINAL_PHASE5_REFERENCE_CONFIG_HASH,
      continuationPolicyHash: PHASE8_TERMINAL_CONTINUATION_POLICY_HASH,
      exactConfigHash:
        input.configId === PHASE8_TERMINAL_BEHAVIOR_EXACT_ID
          ? PHASE8_TERMINAL_EXACT_CONFIG_HASH
          : null,
      fallbackConfigId:
        input.configId === PHASE8_TERMINAL_BEHAVIOR_EXACT_ID
          ? PHASE8_TERMINAL_BEHAVIOR_ID
          : null,
      behaviorFailurePolicy: "refuse",
      productionModelSha256: input.modelSha256,
      modelSelectionContractHash: input.modelSelectionContractHash,
      separateOpponentPriors: true,
      behaviorWorldCount: input.worldCount,
      robustChoice: input.robustChoice,
    },
  });
}

async function main(): Promise<void> {
  const projectRoot = resolve(".");
  const behaviorPath = resolve(
    valueAfter("--behavior") ??
      resolve(
        projectRoot,
        "..",
        "actions-b-be-30485863938",
        "selected-behavior-model.json",
      ),
  );
  const output = resolve(
    valueAfter("--output") ??
      resolve(projectRoot, "work", "practical-behavior"),
  );
  const behavior = await readSelectedBehaviorModelArtifact(behaviorPath);
  const practical = createPhase8PracticalBehaviorModelArtifact(behavior);
  const modelBytes = serializePhase8PracticalBehaviorModelArtifact(practical);
  const modelEnvelope = envelope(modelBytes);
  const config = phase8PracticalBehaviorModelConfig(practical);
  const descriptors = PRACTICAL_CONFIG_IDS.map((configId) =>
    practicalDescriptor({
      configId,
      modelSha256: modelEnvelope.sha256,
      modelSelectionContractHash: practical.payload.modelSelectionContractHash,
      worldCount: config.worldCount,
      robustChoice: config.robustChoice,
    }),
  );
  const authority = freezePhase8Manifest({
    manifestId: `practical-unsealed-behavior-${practical.payloadChecksum.slice(-16)}`,
    createdAt: new Date().toISOString(),
    sourceSha256: practical.payload.sourceSha256,
    sourceFileCount: 1,
    modelSha256: modelEnvelope.sha256,
    scorerSha256: phase8Sha256({
      purpose: "practical-unsealed-no-performance-score",
    }),
    reportSha256: phase8Sha256({
      purpose: "practical-unsealed-local-play-only",
    }),
    preregistrationSha256: phase8Sha256({
      purpose: "practical-unsealed-not-a-qualification-claim",
    }),
    configurations: [
      createPhase8TerminalConfigurationDescriptor({
        configId: PHASE8_TERMINAL_REFERENCE_ID,
      }),
      ...descriptors,
    ],
    splits: {
      train: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      tune: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      qualification: { baseIndexStart: 0, eventCap: 4_096 },
    },
    qualificationSampleSize: {
      verifiedDevelopmentVarianceArtifactSha256: phase8Sha256({
        purpose: "practical-unsealed-no-qualification-size-claim",
      }),
      maxPairedClusterStandardDeviation: 0,
    },
  });
  const manifestEnvelope = envelope(stableStringify(authority.manifest));
  const bundles = Object.fromEntries(
    descriptors.map((descriptor) => {
      const bundle: EvaluationProductionBundle = {
        schemaVersion: 1,
        releaseVersion: PRODUCTION_RELEASE_BUNDLE_VERSION,
        mode: "evaluation-only",
        scope: "qualification",
        sourceHash: practical.payload.sourceSha256,
        protocolHash: authority.manifest.hashes.preregistrationSha256,
        manifest: manifestEnvelope,
        descriptor: envelope(stableStringify(descriptor)),
        productionModel: modelEnvelope,
      };
      return [descriptor.configId, bundle] as const;
    }),
  ) as Record<
    (typeof PRACTICAL_CONFIG_IDS)[number],
    EvaluationProductionBundle
  >;
  for (const configId of PRACTICAL_CONFIG_IDS) {
    await verifyProductionReleaseBundle(bundles[configId], {
      allowEvaluationOnly: true,
    });
  }

  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, "practical-unsealed-behavior-model.json"),
    modelBytes,
    "utf8",
  );
  await writeFile(
    resolve(output, "manifest.json"),
    `${stableStringify(authority.manifest)}\n`,
    "utf8",
  );
  await Promise.all(
    PRACTICAL_CONFIG_IDS.map((configId) =>
      writeFile(
        resolve(
          output,
          configId === PHASE8_TERMINAL_BEHAVIOR_ID
            ? "b-evaluation-bundle.json"
            : "be-evaluation-bundle.json",
        ),
        `${stableStringify(bundles[configId])}\n`,
        "utf8",
      ),
    ),
  );
  await writeFile(
    resolve(output, "bundle-index.json"),
    `${stableStringify({
      schemaVersion: 1,
      status: "unsealed-practical",
      releaseSelectedEligible: false,
      supportRegularizer: practical.payload.supportRegularizer,
      behaviorSourceSha256: practical.payload.sourceSha256,
      selectedBehaviorPayloadChecksum: behavior.payloadChecksum,
      modelSha256: modelEnvelope.sha256,
      bundles: {
        [PHASE8_TERMINAL_BEHAVIOR_ID]: "b-evaluation-bundle.json",
        [PHASE8_TERMINAL_BEHAVIOR_EXACT_ID]: "be-evaluation-bundle.json",
      },
    })}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({
      output,
      behaviorPath,
      status: "unsealed-practical",
      releaseSelectedEligible: false,
      supportPseudocount: 1,
      modelSha256: modelEnvelope.sha256,
      configIds: PRACTICAL_CONFIG_IDS,
    })}\n`,
  );
}

await main();
