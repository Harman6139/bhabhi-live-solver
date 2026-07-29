import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { latencySummarySchema, type LatencySummary } from "../../src/benchmark";
import { latencyEnvironmentSchema } from "../../src/benchmark/latency-artifacts";
import {
  readPhase8TerminalStatisticalReport,
  type Phase8TerminalStatisticalReport,
} from "../../src/evaluation/phase8-terminal-report";
import { stableStringify } from "../../src/events/stable-hash";
import { verifyProductionReleaseBundle } from "../../src/production";

type Options = Readonly<{
  qualificationTerminalReport: string;
  qualificationLatencyRun: string;
  finalTerminalReport: string;
  finalLatencyRun: string;
  releaseBundle: string;
  selectedLatencyRun: string;
  repository: string;
  actionsRunId: string;
  sourceRef: string;
  sourceCommit: string;
  qualificationSourceRunId: string;
}>;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = argument(name);
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function options(): Options {
  return {
    qualificationTerminalReport: required("--qualification-terminal-report"),
    qualificationLatencyRun: required("--qualification-latency-run"),
    finalTerminalReport: required("--final-terminal-report"),
    finalLatencyRun: required("--final-latency-run"),
    releaseBundle: required("--release-bundle"),
    selectedLatencyRun: required("--selected-latency-run"),
    repository: required("--repository"),
    actionsRunId: required("--actions-run-id"),
    sourceRef: required("--source-ref"),
    sourceCommit: required("--source-commit"),
    qualificationSourceRunId: required("--qualification-source-run-id"),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}

async function readTerminalReport(
  path: string,
): Promise<Phase8TerminalStatisticalReport> {
  return readPhase8TerminalStatisticalReport(resolve(path));
}

async function readLatencyRun(path: string): Promise<
  Readonly<{
    summary: LatencySummary;
    environment: ReturnType<typeof latencyEnvironmentSchema.parse>;
  }>
> {
  const directory = resolve(path);
  return {
    summary: latencySummarySchema.parse(
      await readJson(join(directory, "summary.json")),
    ),
    environment: latencyEnvironmentSchema.parse(
      await readJson(join(directory, "environment.json")),
    ),
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function milliseconds(value: number | null): string {
  return value === null ? "unavailable" : `${value.toFixed(1)} ms`;
}

function bucketRows(label: string, summary: LatencySummary): readonly string[] {
  return summary.buckets.map(
    (bucket) =>
      `| ${label} | ${bucket.temperature} | ${bucket.mode} | ${bucket.successful.toString()} | ${milliseconds(bucket.wall?.p50 ?? null)} | ${milliseconds(bucket.wall?.p95 ?? null)} | ${milliseconds(bucket.wall?.p99 ?? null)} |`,
  );
}

function terminalSummary(
  label: string,
  report: Phase8TerminalStatisticalReport,
): string {
  const configuration = report.configurations[0];
  if (configuration === undefined) {
    throw new Error(`${label} terminal report has no configuration.`);
  }
  return [
    `- ${label}: ${configuration.completedGames.toLocaleString("en-US")} complete games,`,
    `${configuration.userBhabhiGames.toLocaleString("en-US")} user-Bhabhi outcomes`,
    `(${percent(configuration.terminalBhabhiRate)}), zero failures/caps/cancellations,`,
    `mode \`${report.mode}\`, evidence gate \`${report.evidenceGate.toString()}\`,`,
    `report SHA-256 \`${report.reportSha256}\`.`,
  ].join(" ");
}

function latencyGateSummary(label: string, summary: LatencySummary): string {
  return [
    `- ${label}: ${summary.successfulMeasuredRequests.toLocaleString("en-US")}/`,
    `${summary.expectedMeasuredRequests.toLocaleString("en-US")} measured requests successful,`,
    `entry p95 ${milliseconds(summary.deterministicEntry?.p95 ?? null)},`,
    `${summary.longTasks.countOver50Ms.toString()} observed main-thread tasks over 50 ms,`,
    `${summary.races.obsoletePublications.toString()} obsolete publications across`,
    `${summary.races.attempted.toLocaleString("en-US")} cancellation races,`,
    `evidence gate \`${summary.gate.evidenceGatePass.toString()}\`,`,
    `digest \`${summary.reproductionDigest}\`.`,
  ].join(" ");
}

function replaceOnce(
  value: string,
  search: string | RegExp,
  replacement: string,
  label: string,
): string {
  const updated = value.replace(search, replacement);
  if (updated === value) {
    throw new Error(`Could not update ${label}.`);
  }
  return updated;
}

async function main(): Promise<void> {
  const input = options();
  const [
    qualificationTerminal,
    qualificationLatency,
    finalTerminal,
    finalLatency,
    selectedLatency,
    releasePayload,
  ] = await Promise.all([
    readTerminalReport(input.qualificationTerminalReport),
    readLatencyRun(input.qualificationLatencyRun),
    readTerminalReport(input.finalTerminalReport),
    readLatencyRun(input.finalLatencyRun),
    readLatencyRun(input.selectedLatencyRun),
    readFile(resolve(input.releaseBundle), "utf8"),
  ]);
  const releaseVerification = await verifyProductionReleaseBundle(
    JSON.parse(releasePayload) as unknown,
  );
  if (
    !qualificationTerminal.evidenceGate ||
    !qualificationLatency.summary.gate.evidenceGatePass ||
    !finalTerminal.evidenceGate ||
    !finalLatency.summary.gate.evidenceGatePass ||
    !selectedLatency.summary.gate.evidenceGatePass ||
    releaseVerification.binding.bundleMode !== "release-selected"
  ) {
    throw new Error(
      "Release documentation requires passing verified evidence.",
    );
  }
  const runUrl = `https://github.com/${input.repository}/actions/runs/${input.actionsRunId}`;
  const releaseSha256 = sha256(releasePayload);
  const selectedEnvironment = selectedLatency.environment;
  const qualificationConfiguration = qualificationTerminal.configurations[0];
  const finalConfiguration = finalTerminal.configurations[0];
  if (
    qualificationConfiguration === undefined ||
    finalConfiguration === undefined
  ) {
    throw new Error("Terminal reports omitted the selected configuration.");
  }
  const latencyRows = [
    ...bucketRows("Qualification", qualificationLatency.summary),
    ...bucketRows("Final", finalLatency.summary),
    ...bucketRows("Selected release", selectedLatency.summary),
  ].join("\n");

  const finalReport = `# Final Report

This is the documentation-complete report for the local-first three-player
Bhabhi / Getaway live solver. It is generated only from verified immutable
artifacts. The release documentation commit is fast-forwarded to \`master\`
only after the Phase 9 job in [Actions run ${input.actionsRunId}](${runUrl})
passes.

## 1. What was built

A complete local-first manual tracker and decision assistant: typed cards and
household-rule profiles, event-sourced replay and arbitrary correction, exact
card conservation, correlated hidden-hand construction, separate uncertain
opponent-model infrastructure, terminal-risk search over every legal user
action, complete-game simulation, reproducible evaluation, causal
explanations, diagnostics, IndexedDB persistence, archive import/export, and a
dedicated browser worker with cancellation and stale-result rejection.

The shipped route is the measured hard-only Balanced reference. It minimizes
estimated terminal Bhabhi probability under the public history and active rule
profile; immediate pickup, hand size, and power remain diagnostics rather than
the objective.

## 2. Default rules and supported variants

The default is the documented Pagat-style clockwise three-player profile:
A-spades opens, following suit is compulsory, the opening trick completes and
goes to waste, the first later off-suit thulla ends its trick, and the highest
lead-suit player picks up. The typed \`RuleConfig\` also covers anticlockwise
play, opening off-suit restrictions, disabled/next/adjacent/configured
take-hand behavior, zero-cards-with-power escape or draw/take behavior, and the
implemented heads-up profiles. Unsupported household semantics remain listed
in the rules ledger.

## 3. Architecture and key decisions

Strict TypeScript domain, replay, inference, search, simulator, worker, and UI
layers enforce a truth firewall: production analysis cannot import simulator
truth. Hidden worlds preserve opponent-card correlations and all public hard
constraints. React/Vite provide the browser product; analysis executes in a
dedicated worker whose request, result, source, protocol, model, configuration,
selection, and final-attestation bindings are verified before publication.

ADRs 0001 through 0011 record the architecture, rule variants, correlated
inference, seeded simulation, terminal search, behavioral eligibility,
confirmatory design, release binding, reference-only selection, evaluation
worker route, public-history tie handling, and durable shard protocol.

## 4. Validation commands and results

Frozen source \`${input.sourceRef}\` resolves to
\`${input.sourceCommit}\`. Before qualification opened, the source-validation
authority ran and checksummed the 12 frozen command classes: format, lint,
typecheck, complete unit/regression, property, integration, truth-firewall,
simulator, solver, calibration, production build, and browser E2E. All passed.

Qualification terminal evidence was computed in 39 independently checksummed
shards and then deterministically merged only after rejecting duplicate,
missing, unexpected, differently bound, or failed coordinates. Final terminal
evidence used the same 39-shard protocol on untouched final seeds. Browser
qualification, final-manifest, and exact selected-release routes each ran the
full preregistered schedule.

The final Phase 9 job runs format, lint, typecheck, complete regression,
selected production build, truth-firewall, product E2E/accessibility, selected
latency/cancellation verification, and a fresh clean-directory README install,
typecheck, test, and E2E dry run. This documentation commit is published only
if that job succeeds; the authoritative result and logs are in
[Actions run ${input.actionsRunId}](${runUrl}).

## 5. Benchmark and calibration results

${terminalSummary("Qualification", qualificationTerminal)}

${terminalSummary("Untouched final", finalTerminal)}

The registry is genuinely reference-only, so these are one-arm confirmations:
there is no synthetic self-contrast, comparative confidence interval, or
"beats itself" claim. Behavioral calibration, behavioral-versus-hard
qualification, and exact-component ablations are recorded as not applicable
for the shipped registry. Development calibration remains research evidence
and did not authorize behavioral weighting in production.

## 6. Latency results and hardware

${latencyGateSummary("Qualification", qualificationLatency.summary)}

${latencyGateSummary("Final-manifest route", finalLatency.summary)}

${latencyGateSummary("Exact selected-release route", selectedLatency.summary)}

| Route | Temperature | Mode | Successful samples | Wall p50 | Wall p95 | Wall p99 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
${latencyRows}

Selected-route hardware: ${selectedEnvironment.cpuModel.trim()},
${selectedEnvironment.logicalCpus.toString()} logical CPUs,
${(selectedEnvironment.totalMemoryBytes / 2 ** 30).toFixed(1)} GiB RAM,
${selectedEnvironment.platform} ${selectedEnvironment.release}, Node
${selectedEnvironment.nodeVersion}, Chromium
${selectedEnvironment.browserVersion}, ${selectedEnvironment.powerMode}.
Dedicated-worker CPU and memory attribution are unavailable through browser
Performance APIs and remain null with the recorded platform reasons; they are
not estimated.

## 7. Enabled and rejected experimental components

Enabled: direct Phase 5 hard-only Balanced terminal-risk search, correlated
hard inference, public-history/seed-bound exact-risk tie ordering, worker
cancellation, and the verified \`${releaseVerification.binding.bundleMode}\`
release binding.

Disabled: behavioral weighting and exact-endgame production dispatch. Both
remain implemented and tested research components, but neither had a genuine
eligible browser route in the frozen first-release registry. Keeping the
simple reference is the preregistered outcome, not a sophistication claim.

## 8. Known limitations and next work

The product is a manual assistant for exactly three starting players. Community
rule sources conflict, so users must select a supported profile matching their
household. Probabilities are conditional on the implemented hard-world sampler
and continuation policies; they do not quantify unknown model
misspecification. The selected first release is approximate except where the
UI explicitly labels a tractable result Exact. A future preregistered release
could add a genuinely browser-executable advanced route and clean comparative
holdout.

## 9. Runnable artifacts and reproducibility data

- Scientific source: \`${input.sourceRef}\` / \`${input.sourceCommit}\`
- Qualification raw source run: [${input.qualificationSourceRunId}](https://github.com/${input.repository}/actions/runs/${input.qualificationSourceRunId})
- Complete release DAG: [${input.actionsRunId}](${runUrl})
- Qualification terminal: \`${qualificationTerminal.runId}\`
- Qualification latency: \`${qualificationLatency.summary.runId}\`
- Final terminal: \`${finalTerminal.runId}\`
- Final latency: \`${finalLatency.summary.runId}\`
- Selected release: \`${process.env.RELEASE_ID ?? "phase9-reference-release-20260729-d2"}\`
- Selected latency: \`${selectedLatency.summary.runId}\`
- Release bundle SHA-256: \`${releaseSha256}\`
- Release source binding: \`${releaseVerification.binding.sourceHash}\`
- Protocol binding: \`${releaseVerification.binding.protocolHash}\`
- Selected configuration: \`${releaseVerification.binding.selectedConfigId}\`
- Downloadable artifact: \`phase8-recovery-selected-release-${input.actionsRunId}-1\`
- Phase 9 attestation artifact:
  \`phase9-recovery-release-validation-${input.actionsRunId}-1\`

Every run directory contains canonical manifests, raw streams, checksums,
environment records, commands, and semantic/reproduction digests. No failed or
superseded observation was mixed into the release evidence.
`;

  const readme = `# Getaway Live Solver

A local-first, three-player Bhabhi / Getaway tracker and decision aid. It
records the public game, preserves card-accounting and truth-firewall
invariants, maintains correlated hidden-hand uncertainty, and evaluates every
legal user action by estimated terminal Bhabhi risk in a dedicated worker.

No game data or analysis is sent to a server.

## Requirements

- Node.js 22.12 or newer
- npm 10 or newer
- Chromium installed by Playwright for browser tests

## Download the selected release evidence

The source is commit \`${input.sourceCommit}\`. The external selected bundle is
kept outside the scientific source snapshot and can be downloaded from the
successful [release Actions run](${runUrl}):

\`\`\`powershell
gh run download ${input.actionsRunId} --repo ${input.repository} --name "phase8-recovery-selected-release-${input.actionsRunId}-1" --dir artifacts
\`\`\`

Locate \`production-release-bundle.json\` under
\`artifacts/${process.env.RELEASE_ID ?? "phase9-reference-release-20260729-d2"}/\`,
then build the exact selected application:

\`\`\`powershell
npm ci
npx playwright install chromium
$env:BHABHI_RELEASE_BUNDLE_PATH = (Resolve-Path "artifacts/${process.env.RELEASE_ID ?? "phase9-reference-release-20260729-d2"}/production-release-bundle.json")
$env:BHABHI_RELEASE_EXPECT_MODE = "release-selected"
npm run build
npm run preview
\`\`\`

An ordinary source build still supports setup, tracking, corrections,
persistence, import, and export, but deliberately refuses production
recommendations until a verified \`release-selected\` bundle is injected.

## Play

1. Select the rule profile and enter your exact starting hand.
2. Record each public play, pickup, waste draw, player draw, or take-hand event.
3. On each user turn choose Instant, Balanced, Deep, or Offline analysis.
4. Read the recommendation, ranked legal alternatives, terminal-risk estimate,
   uncertainty label, causal explanation, and public-only diagnostics.
5. Use Correct, Undo, or Redo at any time; obsolete analysis is cancelled and
   can never overwrite the corrected state.
6. Export the canonical archive for a portable local backup.

## Test

\`\`\`powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:property
npm run test:integration
npm run test:truth-firewall
npm run test:simulator
npm run test:solver
npm run test:calibration
npm run test:e2e
\`\`\`

\`npm run release:verify\` runs the formatting, lint, type, complete regression,
production-build, and browser E2E suite. The create-exclusive Phase 9
attestation additionally replays these checks from a fresh clean worktree and
verifies the selected-route latency/cancellation evidence.

## Reproduce the principal evidence

The first release follows ADR 0009's preregistered reference-only path and ADR
0011's independently durable shard protocol. Exact commands, sample counts,
hashes, latency distributions, hardware, selected/rejected components, and
artifact IDs are in [docs/final-report.md](docs/final-report.md).

The complete dependency-safe run is
[GitHub Actions ${input.actionsRunId}](${runUrl}). It reuses 39 verified
qualification shards, opens final only after qualification passes, runs 39
untouched-final shards alongside final browser latency, creates the selected
bundle, measures that exact route, and executes Phase 9 release validation.

Do not edit executable source, preregistration, tests, scripts, or lockfiles
after qualification opens. Generated evidence is create-exclusive; use a new
authority and run ID for a genuine scientific rerun.

## Architecture and limitations

Strict TypeScript separates rules/replay, hard inference, behavior research,
terminal search, simulator truth, production release verification, worker
protocol, and React UI. Production code is guarded by a transitive truth
firewall. The selected route is hard-only Balanced; behavioral weighting and
exact-endgame dispatch remain disabled because they were not eligible in this
frozen browser-executable registry. Unsupported household variants require an
explicit typed profile.
`;

  let progress = await readFile(resolve("docs/progress.md"), "utf8");
  progress = replaceOnce(
    progress,
    /^Last updated:.*$/mu,
    "Last updated: 2026-07-29 (America/New_York)",
    "progress date",
  );
  progress = replaceOnce(
    progress,
    /## Active phase\r?\n\r?\n[^\r\n]*/u,
    "## Active phase\n\nPhase 9 — documentation-complete release validation. The generated documentation commit is published only after the exact selected-release regression passes.",
    "active phase",
  );
  progress = replaceOnce(
    progress,
    "- [ ] Phase 8: clean preregistered evaluation and stored evidence complete",
    "- [x] Phase 8: clean preregistered evaluation and stored evidence complete",
    "Phase 8 checkbox",
  );
  progress = replaceOnce(
    progress,
    "- [ ] Phase 9: final regression, product hardening, and release criteria pass",
    "- [x] Phase 9: final regression, product hardening, and release criteria pass",
    "Phase 9 checkbox",
  );
  progress += `

## Release completion (generated from immutable evidence)

- Scientific source: \`${input.sourceRef}\` / \`${input.sourceCommit}\`.
- Qualification source run: ${input.qualificationSourceRunId}; all 39 terminal
  shards passed and were independently retained.
- Qualification terminal: ${qualificationConfiguration.completedGames.toLocaleString("en-US")}
  complete games, ${qualificationConfiguration.userBhabhiGames.toLocaleString("en-US")}
  user-Bhabhi outcomes, evidence gate passed.
- Qualification latency: ${qualificationLatency.summary.successfulMeasuredRequests.toLocaleString("en-US")}
  successful measured requests, zero benchmark failures, zero obsolete
  publications, evidence gate passed.
- Final terminal: ${finalConfiguration.completedGames.toLocaleString("en-US")}
  complete games, ${finalConfiguration.userBhabhiGames.toLocaleString("en-US")}
  user-Bhabhi outcomes, evidence gate passed.
- Final and selected-release latency gates passed on the recorded GitHub-hosted
  Windows runners.
- Selected release bundle SHA-256: \`${releaseSha256}\`.
- Complete release and Phase 9 validation:
  [Actions ${input.actionsRunId}](${runUrl}).
- Publication safety: this documentation commit reaches \`master\` only after
  the create-exclusive Phase 9 validation artifact passes, so the checked
  Phase 8/9 boxes cannot be published on a failed release.
`;

  await Promise.all([
    writeFile(resolve("docs/final-report.md"), finalReport, "utf8"),
    writeFile(resolve("README.md"), readme, "utf8"),
    writeFile(resolve("docs/progress.md"), progress, "utf8"),
  ]);
  process.stdout.write(
    `${stableStringify({
      finalReportSha256: sha256(finalReport),
      readmeSha256: sha256(readme),
      progressSha256: sha256(progress),
      releaseBundleSha256: releaseSha256,
      actionsRunId: input.actionsRunId,
    })}\n`,
  );
}

await main();
