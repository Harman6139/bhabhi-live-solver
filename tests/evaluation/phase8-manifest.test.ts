import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FITTABLE_STYLE_CELL_IDS } from "../../src/calibration/protocol";
import {
  PHASE8_BOOTSTRAP_RESAMPLES,
  PHASE8_CONFIGURATION_ROLE_IDS,
  PHASE8_MAX_CONFIGURATIONS,
  createPhase8ManifestAuthorityArtifact,
  createPhase8ConfigurationDescriptor,
  deriveOpenedPhase8Seed,
  freezePhase8Manifest,
  openPhase8Split,
  parseAndRehydratePhase8SplitOpening,
  phase8ManifestSchema,
  phase8Sha256,
  rehydratePhase8ManifestAuthorityArtifact,
  serializePhase8SplitOpening,
  verifyPhase8ManifestAuthority,
  type Phase8ConfigurationDescriptor,
  type Phase8ConfigurationRoleId,
  type Phase8SplitOpening,
} from "../../src/evaluation/phase8-manifest";
import { STYLE_CELLS } from "../../src/evaluation/protocol";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected fixture value to be defined.");
  }
  return value;
}

function protocolSeed(preimage: string): string {
  return createHash("sha256")
    .update(preimage, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function configuration(
  configId: Phase8ConfigurationRoleId,
): Phase8ConfigurationDescriptor {
  const role = configId === "p8-r-hard-balanced-v1" ? "reference" : "candidate";
  const components = {
    exactEndgame:
      configId === "p8-e-exact-hard-fallback-v1" ||
      configId === "p8-be-behavior-exact-fallback-v1",
    behaviorWeighting:
      configId === "p8-b-behavior-balanced-v1" ||
      configId === "p8-be-behavior-exact-fallback-v1",
  };
  return createPhase8ConfigurationDescriptor({
    configId,
    label: `Configuration ${configId}`,
    role,
    budgetId: "balanced",
    components,
    implementation: {
      executionPath: `${configId}-path-v1`,
      samples: 64,
    },
  });
}

function authority(
  configurations: readonly Phase8ConfigurationDescriptor[] = [
    configuration("p8-r-hard-balanced-v1"),
    configuration("p8-e-exact-hard-fallback-v1"),
  ],
) {
  return freezePhase8Manifest({
    manifestId: "phase8-qualification-manifest-test",
    createdAt: "2026-07-28T12:00:00.000Z",
    sourceSha256: SHA_A,
    sourceFileCount: 42,
    modelSha256: SHA_B,
    scorerSha256: SHA_C,
    reportSha256: SHA_D,
    preregistrationSha256: SHA_E,
    configurations,
    splits: {
      train: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      tune: { baseIndexStart: 0, baseCount: 64, eventCap: 4_096 },
      qualification: {
        baseIndexStart: 0,
        eventCap: 4_096,
      },
    },
    qualificationSampleSize: {
      verifiedDevelopmentVarianceArtifactSha256: SHA_F,
      maxPairedClusterStandardDeviation: 0,
    },
  });
}

describe("Phase 8 frozen qualification authority", () => {
  it("pins split-specific cells, registry, hashes, and confirmatory policy", () => {
    const frozen = authority();

    expect(verifyPhase8ManifestAuthority(frozen)).toBe(true);
    expect(frozen.manifest.sourceFileCount).toBe(42);
    expect(frozen.manifest.styleCells).toEqual(STYLE_CELLS);
    expect(frozen.manifest.splits.train.styleCellIds).toEqual(
      FITTABLE_STYLE_CELL_IDS,
    );
    expect(frozen.manifest.splits.tune.styleCellIds).toEqual(
      FITTABLE_STYLE_CELL_IDS,
    );
    expect(frozen.manifest.splits.qualification.styleCellIds).toEqual(
      STYLE_CELLS.map((cell) => cell.id),
    );
    expect(frozen.manifest.splits).not.toHaveProperty("final");
    expect(
      frozen.manifest.configurations.map((value) => value.configId),
    ).toEqual(["p8-r-hard-balanced-v1", "p8-e-exact-hard-fallback-v1"]);
    expect(frozen.manifest.hashes).toMatchObject({
      sourceSha256: SHA_A,
      modelSha256: SHA_B,
      scorerSha256: SHA_C,
      reportSha256: SHA_D,
      preregistrationSha256: SHA_E,
    });
    expect(frozen.manifest.hashes.configSha256).toBe(
      phase8Sha256(frozen.manifest.configurations),
    );
    expect(frozen.manifest.selectionPolicy).toMatchObject({
      bootstrapResamples: PHASE8_BOOTSTRAP_RESAMPLES,
      terminalNoninferiorityMargin: 0.005,
      practicalTieMargin: 0.0025,
      catastrophicStylePointThreshold: 0.05,
      catastrophicStyleLowerThreshold: 0.02,
    });
    expect(frozen.manifest.qualificationSampleSize).toMatchObject({
      verifiedDevelopmentVarianceArtifactSha256: SHA_F,
      formulaVersion: "phase8-terminal-sample-size-v1",
      rawBaseCount: 0,
      blockRoundedBaseCount: 0,
      baseCount: 64,
      minimumApplied: true,
      maximumApplied: false,
    });
    expect(frozen.manifest.qualificationSampleSize.formulaSha256).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(Object.isFrozen(frozen.manifest.configurations[0])).toBe(true);
    expect(() => {
      defined(frozen.manifest.configurations[0]).label = "mutated";
    }).toThrow(TypeError);

    const artifact = createPhase8ManifestAuthorityArtifact({
      existingTarget: null,
      authority: frozen,
    });
    const rehydrated = rehydratePhase8ManifestAuthorityArtifact(artifact);
    expect(verifyPhase8ManifestAuthority(rehydrated)).toBe(true);
    expect(rehydrated.manifest).toEqual(frozen.manifest);
    expect(rehydrated.manifestSha256).toBe(frozen.manifestSha256);
    expect(() =>
      rehydratePhase8ManifestAuthorityArtifact({
        ...artifact,
        payload: `${artifact.payload} `,
      }),
    ).toThrow(/checksum envelope/u);
    expect(() =>
      createPhase8ManifestAuthorityArtifact({
        existingTarget: artifact.payload,
        authority: frozen,
      }),
    ).toThrow(/overwrite/u);
  });

  it("rejects mutation, nonzero split starts, undersizing, and over-four registries", () => {
    const frozen = authority();
    const mutated = structuredClone(frozen.manifest);
    defined(mutated.configurations[0]).label = "drifted";
    expect(() => phase8ManifestSchema.parse(mutated)).toThrow(
      /Configuration hash/u,
    );

    const badStart = structuredClone(frozen.manifest);
    badStart.splits.tune.baseIndexStart = 64;
    expect(() => phase8ManifestSchema.parse(badStart)).toThrow(
      /baseIndexStart 0/u,
    );

    const unprovenSize = structuredClone(frozen.manifest);
    unprovenSize.splits.qualification.baseCount = 80;
    expect(() => phase8ManifestSchema.parse(unprovenSize)).toThrow(
      /verified development variance/u,
    );

    const driftedFormula = structuredClone(frozen.manifest);
    driftedFormula.qualificationSampleSize.formulaSha256 = SHA_A;
    expect(() => phase8ManifestSchema.parse(driftedFormula)).toThrow(
      /verified development variance/u,
    );

    const tooMany = [
      ...PHASE8_CONFIGURATION_ROLE_IDS.map((configId) =>
        configuration(configId),
      ),
      configuration("p8-e-exact-hard-fallback-v1"),
    ];
    expect(() => authority(tooMany)).toThrow();
    expect(PHASE8_MAX_CONFIGURATIONS).toBe(4);

    expect(() =>
      createPhase8ConfigurationDescriptor({
        configId: "p8-e-exact-hard-fallback-v1",
        label: "Invalid exact role",
        role: "candidate",
        budgetId: "balanced",
        components: {
          exactEndgame: false,
          behaviorWeighting: false,
        },
        implementation: { executionPath: "invalid" },
      }),
    ).toThrow(/ADR 0007 role/u);
  });
});

describe("Phase 8 split-opening seed firewall", () => {
  it("requires a frozen qualification proof and keeps solver seeds style-neutral", () => {
    const frozen = authority();
    const coordinate = {
      stream: "search",
      styleCellId: defined(STYLE_CELLS[0]).id,
      baseIndex: 0,
      rotation: 0,
      replicate: 0,
    } as const;

    expect(() =>
      deriveOpenedPhase8Seed(frozen, {} as Phase8SplitOpening, coordinate),
    ).toThrow(/split-opening/u);
    expect(() =>
      openPhase8Split(frozen, {
        split: "qualification",
        proof: {
          kind: "development",
          disclosureAuthoritySha256: SHA_F,
        },
      }),
    ).toThrow(/Qualification seeds/u);

    const opening = openPhase8Split(frozen, {
      split: "qualification",
      proof: {
        kind: "qualification",
        preregistrationSha256: SHA_E,
        trainClosureSha256: SHA_A,
        tuneClosureSha256: SHA_B,
        sourceValidationArtifactSha256: SHA_C,
      },
    });
    const searchSeed = deriveOpenedPhase8Seed(frozen, opening, coordinate);
    expect(searchSeed).toBe(
      protocolSeed("bhabhi/eval-v1|qualification|search|0|0|0"),
    );
    expect(searchSeed).toBe(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        styleCellId: defined(STYLE_CELLS[1]).id,
      }),
    );
    expect(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "solver-chance",
      }),
    ).toBe(protocolSeed("bhabhi/eval-v1|qualification|solver-chance|0|0|0"));
    expect(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "solver-chance",
      }),
    ).toBe(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "solver-chance",
        styleCellId: defined(STYLE_CELLS[1]).id,
      }),
    );
    expect(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "bootstrap",
      }),
    ).toBe(protocolSeed("bhabhi/eval-v1|qualification|bootstrap|0|0|0"));
    expect(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "bootstrap",
      }),
    ).toBe(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "bootstrap",
        styleCellId: defined(STYLE_CELLS[1]).id,
      }),
    );
    expect(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "chance",
      }),
    ).not.toBe(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "chance",
        styleCellId: defined(STYLE_CELLS[1]).id,
      }),
    );
    expect(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "p2-policy",
      }),
    ).toBe(
      protocolSeed(
        `bhabhi/eval-v1|qualification|p2-policy|${coordinate.styleCellId}|0|0|0`,
      ),
    );
    expect(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "p2-policy",
      }),
    ).not.toBe(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "p2-policy",
        styleCellId: defined(STYLE_CELLS[1]).id,
      }),
    );
    expect(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "deal",
      }),
    ).toBe(protocolSeed("bhabhi/eval-v1|qualification|deal|0"));
    expect(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "deal",
      }),
    ).toBe(
      deriveOpenedPhase8Seed(frozen, opening, {
        ...coordinate,
        stream: "deal",
        styleCellId: defined(STYLE_CELLS[1]).id,
        rotation: 2,
      }),
    );

    const openingPayload = serializePhase8SplitOpening(frozen, opening, {
      kind: "qualification",
      preregistrationSha256: SHA_E,
      trainClosureSha256: SHA_A,
      tuneClosureSha256: SHA_B,
      sourceValidationArtifactSha256: SHA_C,
    });
    const rehydratedOpening = parseAndRehydratePhase8SplitOpening(
      frozen,
      openingPayload,
    );
    expect(deriveOpenedPhase8Seed(frozen, rehydratedOpening, coordinate)).toBe(
      searchSeed,
    );
    expect(() =>
      parseAndRehydratePhase8SplitOpening(frozen, ` ${openingPayload}`),
    ).toThrow(/noncanonical/u);
  });

  it("cannot open final from qualification authority", () => {
    const qualification = authority();
    expect(() =>
      openPhase8Split(qualification, {
        split: "final",
        proof: {
          kind: "development",
          disclosureAuthoritySha256: SHA_F,
        },
      } as never),
    ).toThrow(/distinct final manifest/u);
  });
});
