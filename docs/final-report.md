# Final Report

This is the documentation-complete report for the local-first three-player
Bhabhi / Getaway live solver. It is generated only from verified immutable
artifacts. The release documentation commit is fast-forwarded to `master`
only after the Phase 9 job in [Actions run 30480677017](https://github.com/Harman6139/bhabhi-live-solver/actions/runs/30480677017)
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
lead-suit player picks up. The typed `RuleConfig` also covers anticlockwise
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

Frozen source `phase8-source-b82e68a` resolves to
`b82e68a56b914197328dbef0a8e519207e8f47b7`. Before qualification opened, the source-validation
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
[Actions run 30480677017](https://github.com/Harman6139/bhabhi-live-solver/actions/runs/30480677017).

## 5. Benchmark and calibration results

- Qualification: 3,264 complete games, 445 user-Bhabhi outcomes (13.63%), zero failures/caps/cancellations, mode `reference-one-arm`, evidence gate `true`, report SHA-256 `b3d3c7abfff423988e535f4e08b98f4ecfae68cd6b914174e518bb0ee6a9c86d`.

- Untouched final: 3,264 complete games, 446 user-Bhabhi outcomes (13.66%), zero failures/caps/cancellations, mode `reference-one-arm`, evidence gate `true`, report SHA-256 `6ed7038a93febf5656ecfa3258a2c8909ccceaf5a059c77cf5cbdef80f61d09d`.

The registry is genuinely reference-only, so these are one-arm confirmations:
there is no synthetic self-contrast, comparative confidence interval, or
"beats itself" claim. Behavioral calibration, behavioral-versus-hard
qualification, and exact-component ablations are recorded as not applicable
for the shipped registry. Development calibration remains research evidence
and did not authorize behavioral weighting in production.

## 6. Latency results and hardware

- Qualification: 3,400/ 3,400 measured requests successful, entry p95 1.2 ms, 0 observed main-thread tasks over 50 ms, 0 obsolete publications across 1,000 cancellation races, evidence gate `true`, digest `fnv1a64:363a44b376ae3877`.

- Final-manifest route: 3,400/ 3,400 measured requests successful, entry p95 1.3 ms, 0 observed main-thread tasks over 50 ms, 0 obsolete publications across 1,000 cancellation races, evidence gate `true`, digest `fnv1a64:32f1b02b01ebeec4`.

- Exact selected-release route: 3,400/ 3,400 measured requests successful, entry p95 1.0 ms, 0 observed main-thread tasks over 50 ms, 0 obsolete publications across 1,000 cancellation races, evidence gate `true`, digest `fnv1a64:30be373f4fa1e208`.

| Route            | Temperature | Mode     | Successful samples |   Wall p50 |   Wall p95 |   Wall p99 |
| ---------------- | ----------- | -------- | -----------------: | ---------: | ---------: | ---------: |
| Qualification    | warm        | instant  |               1000 |   182.8 ms |   227.9 ms |   270.9 ms |
| Qualification    | warm        | balanced |               1000 |   473.8 ms |   593.3 ms |   669.5 ms |
| Qualification    | warm        | deep     |               1000 |  2868.2 ms |  3275.1 ms |  3610.0 ms |
| Qualification    | cold        | instant  |                100 |   191.8 ms |   235.1 ms |   242.0 ms |
| Qualification    | cold        | balanced |                100 |   476.4 ms |   555.2 ms |   570.1 ms |
| Qualification    | cold        | deep     |                100 |  2875.3 ms |  3138.0 ms |  3246.9 ms |
| Qualification    | warm        | offline  |                100 | 21060.0 ms | 21977.1 ms | 22300.3 ms |
| Final            | warm        | instant  |               1000 |   194.6 ms |   259.0 ms |   295.4 ms |
| Final            | warm        | balanced |               1000 |   495.8 ms |   599.4 ms |   665.8 ms |
| Final            | warm        | deep     |               1000 |  2907.9 ms |  3295.3 ms |  3682.9 ms |
| Final            | cold        | instant  |                100 |   195.3 ms |   243.4 ms |   297.7 ms |
| Final            | cold        | balanced |                100 |   486.3 ms |   580.7 ms |   606.6 ms |
| Final            | cold        | deep     |                100 |  2899.5 ms |  3088.3 ms |  3182.1 ms |
| Final            | warm        | offline  |                100 | 21328.0 ms | 22163.4 ms | 22475.3 ms |
| Selected release | warm        | instant  |               1000 |   131.5 ms |   159.6 ms |   175.1 ms |
| Selected release | warm        | balanced |               1000 |   345.2 ms |   405.3 ms |   432.6 ms |
| Selected release | warm        | deep     |               1000 |  2089.5 ms |  2374.4 ms |  2555.8 ms |
| Selected release | cold        | instant  |                100 |   147.5 ms |   194.4 ms |   223.4 ms |
| Selected release | cold        | balanced |                100 |   341.5 ms |   402.9 ms |   426.6 ms |
| Selected release | cold        | deep     |                100 |  1934.4 ms |  2090.8 ms |  2173.4 ms |
| Selected release | warm        | offline  |                100 | 14444.6 ms | 15364.7 ms | 15599.7 ms |

Selected-route hardware: Intel(R) Xeon(R) 6973P-C,
4 logical CPUs,
16.0 GiB RAM,
win32 10.0.26100, Node
v22.13.0, Chromium
151.0.7922.34, GitHub Actions Windows hosted runner.
Dedicated-worker CPU and memory attribution are unavailable through browser
Performance APIs and remain null with the recorded platform reasons; they are
not estimated.

## 7. Enabled and rejected experimental components

Enabled: direct Phase 5 hard-only Balanced terminal-risk search, correlated
hard inference, public-history/seed-bound exact-risk tie ordering, worker
cancellation, and the verified `release-selected`
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

- Scientific source: `phase8-source-b82e68a` / `b82e68a56b914197328dbef0a8e519207e8f47b7`
- Qualification raw source run: [30422123375](https://github.com/Harman6139/bhabhi-live-solver/actions/runs/30422123375)
- Complete release DAG: [30480677017](https://github.com/Harman6139/bhabhi-live-solver/actions/runs/30480677017)
- Qualification terminal: `phase8-reference-qualification-terminal-20260729-d-sharded`
- Qualification latency: `phase8-reference-qualification-latency-20260729-d2-actions`
- Final terminal: `phase8-reference-final-terminal-20260729-d2-sharded`
- Final latency: `phase8-reference-final-latency-20260729-d2-actions`
- Selected release: `phase9-reference-release-20260729-d2`
- Selected latency: `phase9-reference-selected-latency-20260729-d2-actions`
- Release bundle SHA-256: `1acc6726cf38867ed393eb86a52a9a10208b4ae50f2ddeaa2b6d01d21f5b0de9`
- Release source binding: `0e8dfe629c4a2580d3de65ee8d8150afa2ba90f48a8d2ee95b4368c5841602ef`
- Protocol binding: `371ad4a6abef5ceb97c404cd5f4fc848f567db180d79351753eb6234cc250693`
- Selected configuration: `p8-r-hard-balanced-v1`
- Downloadable artifact: `phase8-recovery-selected-release-30480677017-1`
- Phase 9 attestation artifact:
  `phase9-recovery-release-validation-30480677017-1`

Every run directory contains canonical manifests, raw streams, checksums,
environment records, commands, and semantic/reproduction digests. No failed or
superseded observation was mixed into the release evidence.
